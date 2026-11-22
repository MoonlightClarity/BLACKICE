import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createCodeCheckAdapters } from '../lib/code-check-adapters.mjs';
import { createCodeBlockToolHandler } from '../lib/code-block-tool.mjs';
import { createWorkspaceToolHandler, processRun } from '../lib/workspace-tools.mjs';
import { createBenchmarkWorkspaceToolHandler } from '../lib/benchmark-workspace.mjs';
import { BENCHMARK_AGENT_TOOLS_PROFILE, normalizeBenchmarkProfile } from '../lib/benchmark-profile.mjs';
import { benchmarkFixture, validSource } from './helpers/minicpm-benchmark-fixture.mjs';

const read = result => JSON.parse(result.contentItems.find(item => item.type === 'inputText').text);
const identity = file => { const b = fs.readFileSync(file); return { sha256: createHash('sha256').update(b).digest('hex'), bytes: b.length }; };
const call = (file, language = 'javascript', check = 'syntax', extra = {}) =>
  ({ name: 'relay_code', callId: 'code-check-test', arguments: { action: 'check', language, path: file, check, ...extra } });
function observed(real) {
  const calls = [], described = [], normalized = [];
  const handler = async (value, context) => { calls.push(value); return real(value, context); };
  handler.describeOperation = (value, context) => { described.push(value); return real.describeOperation(value, context); };
  handler.normalizeOperationResult = (result, context) => { normalized.push(context); return real.normalizeOperationResult(result, context); };
  return { handler, calls, described, normalized };
}
function ordinary(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'blackice-code-check-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const seen = observed(createWorkspaceToolHandler({ cwd }));
  const adapters = createCodeCheckAdapters({ workspaceHandler: seen.handler, cwd });
  const tool = createCodeBlockToolHandler({ workspaceHandler: seen.handler, ...adapters, guardedWrites: true });
  return { cwd, ...seen, ...adapters, tool };
}
function benchmark(t, fixtureOptions, handlerOptions = {}) {
  const f = benchmarkFixture(t, fixtureOptions);
  const profile = normalizeBenchmarkProfile({ ...f.request, profile: BENCHMARK_AGENT_TOOLS_PROFILE }, { cwd: f.workspace });
  const seen = observed(createBenchmarkWorkspaceToolHandler({ profile, ...handlerOptions }));
  const adapters = createCodeCheckAdapters({ workspaceHandler: seen.handler, benchmark: true, cwd: f.workspace });
  return { ...f, profile, ...seen, ...adapters,
    tool: createCodeBlockToolHandler({ workspaceHandler: seen.handler, ...adapters, guardedWrites: true }) };
}
function save(cwd, name, text) {
  const file = path.join(cwd, name); fs.writeFileSync(file, text, 'utf8'); return file;
}
const runs = f => f.calls.filter(c => c.arguments.action === 'run');

test('ordinary JavaScript checks real syntax without executing the candidate', { timeout: 20000 }, async t => {
  const f = ordinary(t), marker = path.join(f.cwd, 'must-not-exist');
  const valid = save(f.cwd, 'valid.cjs', "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ",'executed');throw new Error('CANDIDATE_CODE_NEVER_IN_COMMAND');\n");
  const good = await f.tool(call(valid, 'js', 'syntax', { expectedHash: identity(valid).sha256 })), goodBody = read(good);
  assert.equal(good.success, true, JSON.stringify(goodBody));
  assert.equal(goodBody.check.passed, true); assert.equal(goodBody.exitCode, 0);
  assert.equal(goodBody.source.unchanged, true); assert.equal(goodBody.sourceAtomic, false);
  assert.deepEqual(goodBody.checkedSource, identity(valid)); assert.equal(fs.existsSync(marker), false);
  const invalid = save(f.cwd, 'invalid.cjs', 'function broken( {\n');
  const bad = await f.tool(call(invalid)), badBody = read(bad);
  assert.equal(bad.success, false); assert.equal(badBody.check.performed, true); assert.equal(badBody.check.passed, false);
  assert.notEqual(badBody.exitCode, 0); assert.match(badBody.stderr, /SyntaxError/);
  assert.equal(badBody.nativeResult.success, false);
  assert(runs(f).every(c => !c.arguments.command.includes('CANDIDATE_CODE_NEVER_IN_COMMAND')));
});

test('ordinary JSON checks parse data and never evaluate invalid source text', { timeout: 20000 }, async t => {
  const f = ordinary(t), marker = path.join(f.cwd, 'json-must-not-exist');
  const expression = "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ",'executed')";
  const valid = save(f.cwd, 'valid.json', JSON.stringify({ payload: expression, unicode: '\u00e9\u{1f600}' }));
  const good = await f.tool(call(valid, 'json')), goodBody = read(good);
  assert.equal(good.success, true, JSON.stringify(goodBody)); assert.equal(goodBody.check.passed, true);
  const invalid = save(f.cwd, 'invalid.json', expression);
  const bad = await f.tool(call(invalid, 'json')), badBody = read(bad);
  assert.equal(bad.success, false); assert.notEqual(badBody.exitCode, 0); assert.match(badBody.stderr, /SyntaxError/);
  assert.equal(fs.existsSync(marker), false);
  assert(runs(f).every(c => !c.arguments.command.includes(expression)));
});

test('Unicode quotes and shell metacharacters remain inert path data in real checks', { timeout: 20000 }, async t => {
  const f = ordinary(t);
  const stem = process.platform === 'win32'
    ? "O'Brien \u00fc\u{1f600}; $(New-Item -Name PWNED -ItemType File) & [x]"
    : "O'Brien \u00fc\u{1f600}; $(touch PWNED) & [x]";
  for (const [language, extension, text] of [['javascript', '.cjs', 'const value = 1;\n'], ['json', '.json', '{"value":1}']]) {
    const file = save(f.cwd, stem + extension, text), result = await f.tool(call(file, language)), value = read(result);
    assert.equal(result.success, true, JSON.stringify(value)); assert.equal(value.exitCode, 0); assert.equal(value.stdout, '');
    assert.equal(value.source.unchanged, true);
  }
  assert.equal(fs.existsSync(path.join(f.cwd, 'PWNED')), false);
  assert.equal(runs(f).length, 2);
});

test('description execution and normalization map the same admitted workspace operation', { timeout: 20000 }, async t => {
  const f = ordinary(t), file = save(f.cwd, 'descriptor.cjs', 'module.exports = 1;\n'), request = call(file);
  const descriptor = await f.syntaxCheck.describeOperation(request);
  let dispatch;
  const result = await f.syntaxCheck(request, { codeSource: identity(file), operationDescriptor: descriptor,
    onOperationDispatch: value => { dispatch = value; } });
  assert.equal(result.success, true, JSON.stringify(read(result)));
  assert.equal(dispatch.operationKey, descriptor.operationKey);
  assert.equal(f.described[0].name, 'relay_workspace'); assert.equal(f.described[0].callId, request.callId);
  assert.deepEqual(f.described[0].arguments, runs(f)[0].arguments);
  f.tool.normalizeOperationResult(result, { call: request });
  assert.equal(f.normalized.at(-1).call.name, 'relay_workspace');
  assert.deepEqual(f.normalized.at(-1).call.arguments, runs(f)[0].arguments);
});

test('unsupported checks and arbitrary command fields are rejected without dispatch', async t => {
  const f = ordinary(t), b = benchmark(t), file = save(f.cwd, 'source.cjs', 'module.exports = 1;\n');
  for (const [adapter, request] of [
    [f.syntaxCheck, call(file, 'python')], [f.syntaxCheck, call(file, 'typescript')],
    [f.publicCheck, call(file, 'javascript', 'public')],
    [b.syntaxCheck, call('src/index.cjs')], [b.publicCheck, call('src/index.cjs', 'json', 'public')],
  ]) {
    const result = await adapter(request), value = read(result);
    assert.equal(result.success, false); assert.equal(result.code, 'CODE_CHECK_UNAVAILABLE');
    assert.equal(value.performed, false); assert.equal(value.actionDispatched, false);
    await assert.rejects(adapter.describeOperation(request), { code: 'CODE_CHECK_UNAVAILABLE' });
  }
  for (const extra of [{ command: 'whoami' }, { cwd: f.cwd }, { code: 'dangerous()' }]) {
    const result = await f.syntaxCheck(call(file, 'javascript', 'syntax', extra), { codeSource: identity(file) });
    assert.equal(result.success, false); assert.equal(read(result).performed, false);
  }
  assert.equal(f.calls.length, 0); assert.equal(b.calls.length, 0);
  assert.throws(() => createCodeCheckAdapters({}), TypeError);
  assert.throws(() => createCodeCheckAdapters({ workspaceHandler: f.handler, cwd: 'relative' }), TypeError);
});

test('missing or conflicting pre-read identity never launches a check', async t => {
  const f = ordinary(t), file = save(f.cwd, 'identity.cjs', 'module.exports = 1;\n');
  const missing = await f.syntaxCheck(call(file));
  assert.equal(missing.success, false); assert.equal(missing.code, 'CODE_CHECK_SOURCE_UNVERIFIED');
  const conflict = await f.syntaxCheck(call(file, 'javascript', 'syntax', { expectedHash: '0'.repeat(64) }), { codeSource: identity(file) });
  assert.equal(conflict.success, false); assert.equal(conflict.code, 'CODE_CHECK_SOURCE_CONFLICT');
  assert.equal(read(conflict).performed, false); assert.equal(f.calls.length, 0);
});

test('benchmark public checking invokes only the fixed scoped public runner', { timeout: 20000 }, async t => {
  const f = benchmark(t), request = call('src/index.cjs', 'javascript', 'public');
  const result = await f.tool(request), value = read(result);
  assert.equal(result.success, true, JSON.stringify(value)); assert.equal(value.check.passed, true);
  assert.equal(value.exitCode, 0); assert.equal(value.sourceSnapshotVerified, true);
  assert.deepEqual(runs(f).map(c => c.arguments), [{ action: 'run', command: 'node test-public.cjs' }]);
  const report = JSON.parse(value.stdout);
  assert.equal(report.executedCases, 2); assert.equal(report.passedCases, 2);
  const descriptor = await f.publicCheck.describeOperation(request);
  assert.equal(typeof descriptor.operationKey, 'string');
  f.tool.normalizeOperationResult(result, { call: request });
  assert.deepEqual(f.normalized.at(-1).call.arguments, { action: 'run', command: 'node test-public.cjs' });
});

test('a real failed public result retains its native exit and grader receipt', { timeout: 20000 }, async t => {
  const f = benchmark(t);
  const write = await f.handler({ name: 'relay_workspace', arguments: {
    action: 'write', path: 'src/index.cjs', text: "module.exports = { directorySmoke: () => 'incorrect' };\n",
  } });
  assert.equal(write.success, true);
  const result = await f.tool(call('src/index.cjs', 'javascript', 'public')), value = read(result);
  assert.equal(result.success, false); assert.equal(value.check.performed, true); assert.equal(value.check.passed, false);
  assert.equal(value.exitCode, 2); assert.equal(value.nativeResult.success, false);
  assert.equal(JSON.parse(value.stdout).semanticPass, false); assert.equal(value.source.unchanged, true);
});

test('an actual public-run timeout stays failed after the owned process settles', { timeout: 10000 }, async t => {
  const f = benchmark(t, { publicRunner: 'while (true) {}\n' }, {
    runProcess: (executable, args, options) => processRun(executable, args, { ...options, timeoutMs: 100 }),
  });
  const result = await f.publicCheck(call('src/index.cjs', 'javascript', 'public'), {
    codeSource: identity(path.join(f.workspace, 'src/index.cjs')),
  });
  const value = read(result);
  assert.equal(result.success, false); assert.equal(value.timedOut, true); assert.equal(value.performed, true);
  assert.equal(value.nativeResult.success, false); assert.equal(read(value.nativeResult).timedOut, true);
  assert(value.durationMs < 5000);
});

test('actual cancellation retains the native cancellation without inventing an exit code', { timeout: 10000 }, async t => {
  const control = new AbortController(); let timer;
  t.after(() => clearTimeout(timer));
  const f = benchmark(t, { publicRunner: 'while (true) {}\n' }, {
    runProcess: (executable, args, options) => {
      timer = setTimeout(() => control.abort(), 150);
      return processRun(executable, args, options);
    },
  });
  const result = await f.publicCheck(call('src/index.cjs', 'javascript', 'public'), {
    signal: control.signal, codeSource: identity(path.join(f.workspace, 'src/index.cjs')),
  });
  const value = read(result);
  assert.equal(result.success, false); assert.equal(value.cancelled, true); assert.notEqual(value.exitCode, 0);
  assert.equal(value.nativeResult.success, false); assert.equal(read(value.nativeResult).code, 'ABORT_ERR');
  assert.equal(control.signal.aborted, true);
});

test('a real workspace admission failure preserves its no-dispatch receipt', async t => {
  const f = ordinary(t), file = save(f.cwd, 'gone.cjs', 'module.exports = 1;\n'), source = identity(file);
  fs.rmSync(f.cwd, { recursive: true, force: true });
  const result = await f.syntaxCheck(call(file), { codeSource: source }), value = read(result);
  assert.equal(result.success, false); assert.equal(value.performed, false);
  assert.equal(value.actionDispatched, false); assert.equal(value.nativeResult.success, false);
  assert.equal(read(value.nativeResult).code, 'ENOENT'); assert.notEqual(value.exitCode, 0);
});

test('malformed or signalled native results cannot become successful checks', async t => {
  const f = ordinary(t), file = save(f.cwd, 'receipt.cjs', validSource), source = identity(file);
  const native = [
    { success: true, contentItems: [{ type: 'inputText', text: '{"stdout":"no terminal status"}' }] },
    { success: true, contentItems: [{ type: 'inputText', text: 'not JSON' }] },
    { success: true, contentItems: [{ type: 'inputText', text: '{"exitCode":0,"signal":"SIGTERM","timedOut":false}' }] },
    { success: false, contentItems: [{ type: 'inputText', text: '{"exitCode":7,"stderr":"real failure","timedOut":false}' }] },
  ];
  for (const [index, original] of native.entries()) {
    const adapters = createCodeCheckAdapters({ workspaceHandler: async () => original, cwd: f.cwd });
    const result = await adapters.syntaxCheck(call(file), { codeSource: source }), value = read(result);
    assert.equal(result.success, false); assert.deepEqual(value.nativeResult, original);
    if (index < 2) assert.equal(value.performed, 'unconfirmed');
  }
});
