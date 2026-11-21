import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeBenchmarkProfile, assertBenchmarkExecutionOptions, assertBenchmarkIntegrity, benchmarkHash, benchmarkContractHash, benchmarkSourceSnapshot,
} from '../lib/benchmark-profile.mjs';
import {
  BENCHMARK_WORKSPACE_TOOL, createBenchmarkWorkspaceToolHandler, benchmarkChildEnvironment,
} from '../lib/benchmark-workspace.mjs';
import { processRun } from '../lib/workspace-tools.mjs';
import { benchmarkFixture, fixtureWorkflow, validSource, toolJSON, workspaceCall, readHashes } from './helpers/minicpm-benchmark-fixture.mjs';

const setup = (t, options, handlerOptions = {}) => {
  const fixture = benchmarkFixture(t, options);
  const profile = normalizeBenchmarkProfile(fixture.request, { cwd: fixture.workspace });
  const handler = createBenchmarkWorkspaceToolHandler({ profile, ...handlerOptions });
  return { ...fixture, profile, handler, call: args => handler(workspaceCall(args)) };
};
const denied = result => { assert.equal(result.success, false); assert.equal(result.actionDispatched, false); assert.equal(toolJSON(result).actionDispatched, false); };

test('profile admission pins the actual public scaffold and freezes its contract', t => {
  const fixture = benchmarkFixture(t), profile = normalizeBenchmarkProfile(fixture.request, { cwd: fixture.workspace });
  assert.equal(profile.caseId, 'D0'); assert.equal(profile.workspace, fixture.workspace);
  assert(Object.isFrozen(profile)); assert(Object.isFrozen(profile.immutableFiles)); assert(Object.isFrozen(profile.limits));
  assert.equal(normalizeBenchmarkProfile(undefined, { cwd: fixture.workspace }), undefined);
  assert.equal(BENCHMARK_WORKSPACE_TOOL.name, 'relay_workspace');
  assert.equal(BENCHMARK_WORKSPACE_TOOL.inputSchema.properties.cwd, undefined);
  assert.equal(assertBenchmarkIntegrity(profile).files.length, 1);
});

test('malformed profile, receipt hash, wrong root and modified initial source reject admission', t => {
  const f = benchmarkFixture(t);
  for (const input of [null, {}, { ...f.request, ignored: true }, { ...f.request, profile: 'other' },
    { ...f.request, scaffoldReceiptSha256: '0'.repeat(64) }, { ...f.request, scaffoldReceiptPath: '../receipt.json' }])
    assert.throws(() => normalizeBenchmarkProfile(input, { cwd: f.workspace }));
  assert.throws(() => normalizeBenchmarkProfile(f.request, { cwd: f.root }), { code: 'BENCHMARK_WORKSPACE_MISMATCH' });
  fs.writeFileSync(path.join(f.workspace, 'src/index.cjs'), validSource + '// changed\n');
  assert.throws(() => normalizeBenchmarkProfile(f.request, { cwd: f.workspace }), { code: 'BENCHMARK_INITIAL_SOURCE_CHANGED' });
});

test('fresh single-agent mode is explicit and continuation cannot drop its boundary', () => {
  const good = { workflow: fixtureWorkflow, directoryActions: 'on', chatPlanning: 'off', pastChats: 'off' };
  assertBenchmarkExecutionOptions(good);
  assert.throws(() => assertBenchmarkExecutionOptions({ ...good, continuation: true }), { code: 'BENCHMARK_RESUME_UNSUPPORTED' });
  for (const changed of [{ directoryActions: 'off' }, { chatPlanning: 'on' }, { pastChats: 'on' }, { attachmentIds: ['x'] }, { goal: {} },
    { workflow: { ...fixtureWorkflow, nodes: [...fixtureWorkflow.nodes, { id: 'b', type: 'agent' }] } }])
    assert.throws(() => assertBenchmarkExecutionOptions({ ...good, ...changed }), { code: 'BENCHMARK_RUN_SHAPE' });
});

test('scoped reads list only task files; write, readback and exact patch preserve scaffolds', async t => {
  const f = setup(t), before = readHashes(f);
  const method = toolJSON(await f.call({ action: 'read', path: 'METHOD.md' }));
  assert.equal(method.sha256, f.receipt.method.sha256); assert.equal(method.truncated, false);
  assert.equal(method.endLine, method.totalLines); assert.equal(method.nextStartLine, null);
  assert.equal(method.size, Buffer.byteLength(f.files['METHOD.md']));
  assert.equal(method.content.split('\n').map(line => line.replace(/^\d+: /, '')).join('\n'), f.files['METHOD.md']);
  const listing = toolJSON(await f.call({ action: 'list', depth: 3 }));
  assert(!JSON.stringify(listing).includes('outside.cjs')); assert.equal(listing.discovery, undefined);
  const saved = await f.call({ action: 'write', path: 'src/helpers/prefix.cjs', text: "module.exports = value => 'ok:' + value;\n" });
  assert.equal(saved.success, true); assert.equal(toolJSON(saved).readbackVerified, true);
  const source = "module.exports = { directorySmoke: require('./helpers/prefix.cjs') };\n";
  assert.equal((await f.call({ action: 'write', path: 'src/index.cjs', text: source, expectedHash: benchmarkHash(validSource) })).success, true);
  const read = toolJSON(await f.call({ action: 'read', path: 'src/index.cjs' }));
  assert.equal(read.sha256, benchmarkHash(source));
  assert.equal((await f.call({ action: 'patch', path: 'src/index.cjs', oldText: 'module.exports', newText: 'module.exports', expectedHash: read.sha256 })).success, true);
  assert.deepEqual(readHashes(f), before);
});

test('parent, absolute, drive, UNC, device, ADS and reserved paths are denied without effects', async t => {
  const f = setup(t), before = readHashes(f), sourceBefore = fs.readFileSync(path.join(f.workspace, 'src/index.cjs'));
  const paths = ['../outside.cjs', '../../outside.cjs', f.canary, '/outside.cjs', 'C:outside.cjs', 'C:/outside.cjs',
    '\\\\server\\share\\outside.cjs', '\\\\?\\C:\\outside.cjs', 'src/index.cjs:secret', 'src/CON.cjs', 'src/LPT1.cjs',
    'src/../outside.cjs', 'src\\index.cjs', 'src//index.cjs', 'src/./index.cjs', 'src/name./index.cjs', 'src/\0.cjs', '../other-attempt/src/index.cjs'];
  for (const file of paths) for (const action of ['read', 'write'])
    denied(await f.call({ action, path: file, ...(action === 'write' ? { text: 'must-not-write' } : {}) }));
  assert.deepEqual(readHashes(f), before); assert.deepEqual(fs.readFileSync(path.join(f.workspace, 'src/index.cjs')), sourceBefore);
  assert.equal(fs.readFileSync(f.canary, 'utf8'), 'outside-private-canary\n');
});

test('all scaffold writes and patches are refused and their bytes remain unchanged', async t => {
  const f = setup(t), before = readHashes(f);
  for (const file of Object.keys(f.files)) {
    denied(await f.call({ action: 'write', path: file, text: 'tamper' }));
    denied(await f.call({ action: 'patch', path: file, oldText: 'x', newText: 'tamper' }));
  }
  assert.deepEqual(readHashes(f), before);
});

test('actual directory symlink or Windows junction is rejected before a read or write', async t => {
  const f = setup(t), outside = path.join(f.root, 'other-attempt'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.cjs'), 'other-attempt-private\n');
  fs.symlinkSync(outside, path.join(f.workspace, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  denied(await f.call({ action: 'read', path: 'src/linked/secret.cjs' }));
  denied(await f.call({ action: 'write', path: 'src/linked/secret.cjs', text: 'tamper' }));
  assert.equal(fs.readFileSync(path.join(outside, 'secret.cjs'), 'utf8'), 'other-attempt-private\n');
});

test('actual hard links cannot expose or mutate another attempt', async t => {
  const f = setup(t); fs.linkSync(f.canary, path.join(f.workspace, 'src', 'linked.cjs'));
  denied(await f.call({ action: 'read', path: 'src/linked.cjs' }));
  denied(await f.call({ action: 'write', path: 'src/linked.cjs', text: 'tamper' }));
  assert.equal(fs.readFileSync(f.canary, 'utf8'), 'outside-private-canary\n');
});

test('scaffold and controller receipt drift fail visibly before dispatch', async t => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.workspace, 'METHOD.md'), 'changed\n');
  const drift = await f.call({ action: 'read', path: 'TASK.md' }); denied(drift); assert.equal(drift.code, 'BENCHMARK_SCAFFOLD_CHANGED');
  fs.writeFileSync(path.join(f.workspace, 'METHOD.md'), f.files['METHOD.md']);
  fs.appendFileSync(f.receiptPath, ' ');
  const receipt = await f.call({ action: 'run', command: 'node test-public.cjs' }); denied(receipt); assert.equal(receipt.code, 'BENCHMARK_RECEIPT_CHANGED');
});

test('invalid commands, cwd, executable overrides and unavailable tools launch no process', async t => {
  let starts = 0; const f = setup(t, undefined, { runProcess: async () => { starts++; throw Error('Must not launch'); } });
  const commands = ['node test-public.cjs; echo changed', 'node test-public.cjs\nwhoami', ' node test-public.cjs',
    'node --require injected.cjs test-public.cjs', 'node test-public.cjs && echo changed', 'powershell node test-public.cjs'];
  for (const command of commands) denied(await f.call({ action: 'run', command }));
  for (const extra of [{ cwd: f.root }, { executable: process.execPath }, { path: 'src/index.cjs' }, { env: {} }, { timeoutMs: 10001 }])
    denied(await f.call({ action: 'run', command: 'node test-public.cjs', ...extra }));
  denied(await f.handler({ name: 'relay_find_files', arguments: { action: 'read', path: f.canary } }));
  denied(await f.handler({ name: 'relay_workspace', namespace: 'external', arguments: { action: 'run', command: 'node test-public.cjs' } }));
  assert.equal(starts, 0);
});

test('fixed public command executes the saved modules through the existing restricted worker', { timeout: 20000 }, async t => {
  const f = setup(t), before = readHashes(f);
  const result = await f.call({ action: 'run', command: 'node test-public.cjs', timeoutMs: 10000 }), value = toolJSON(result);
  assert.equal(result.success, true, JSON.stringify(value));
  assert.equal(value.shell, 'none'); assert.equal(value.command, 'node test-public.cjs'); assert.equal(value.cwd, f.workspace);
  assert.equal(value.exitCode, 0); assert.equal(value.timedOut, false); assert.equal(value.truncated, false);
  const report = JSON.parse(value.stdout);
  assert.equal(report.semanticPass, true); assert.equal(report.caseCount, 2); assert.equal(report.executedCases, 2); assert.equal(report.passedCases, 2);
  assert(report.child.args.includes('--permission')); assert(report.child.args.includes('--no-addons'));
  assert.deepEqual(readHashes(f), before);
});

test('candidate builtin imports fail inside the worker and reveal no outside file', { timeout: 20000 }, async t => {
  const f = setup(t);
  const text = "module.exports = { directorySmoke: value => require('node:fs').readFileSync(" + JSON.stringify(f.canary) + ", 'utf8') };\n";
  assert.equal((await f.call({ action: 'write', path: 'src/index.cjs', text })).success, true);
  const result = await f.call({ action: 'run', command: 'node test-public.cjs' }), value = toolJSON(result), report = JSON.parse(value.stdout);
  assert.equal(result.success, false); assert.equal(value.actionDispatched, true); assert.equal(value.exitCode, 2);
  assert.equal(report.semanticPass, false); assert.equal(report.executedCases, 2);
  assert(!value.stdout.includes('outside-private-canary'));
  assert.equal(fs.readFileSync(f.canary, 'utf8'), 'outside-private-canary\n');
});

test('command timeout kills and settles the owned process before returning', { timeout: 10000 }, async t => {
  const f = setup(t, { publicRunner: 'while (true) {}\n' });
  const result = await f.call({ action: 'run', command: 'node test-public.cjs', timeoutMs: 100 }), value = toolJSON(result);
  assert.equal(result.success, false); assert.equal(value.actionDispatched, true); assert.equal(value.timedOut, true);
  assert.equal(value.reportValid, false); assert(value.durationMs < 5000);
});

test('cancellation reaches owned-process settlement and never becomes successful verification', { timeout: 10000 }, async t => {
  const control = new AbortController(), f = setup(t, { publicRunner: 'while (true) {}\n' }, { signal: control.signal });
  const timer = setTimeout(() => control.abort(), 150);
  t.after(() => clearTimeout(timer));
  const result = await f.call({ action: 'run', command: 'node test-public.cjs' });
  assert.equal(result.success, false); assert.equal(result.code, 'ABORT_ERR'); assert.equal(result.actionDispatched, true);
});

test('explicit child environment omits inherited secrets while ordinary runner inheritance remains', { timeout: 10000 }, async t => {
  const f = benchmarkFixture(t), key = 'BLACKICE_BENCHMARK_TEST_SECRET', prior = process.env[key]; process.env[key] = 'fixture-present';
  t.after(() => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; });
  const args = ['-e', 'process.stdout.write(process.env.BLACKICE_BENCHMARK_TEST_SECRET || "missing")'];
  const scoped = await processRun(process.execPath, args, { cwd: f.workspace, childEnv: benchmarkChildEnvironment() });
  const ordinary = await processRun(process.execPath, args, { cwd: f.workspace });
  assert.equal(scoped.exitCode, 0); assert.equal(scoped.stdout, 'missing');
  assert.equal(ordinary.exitCode, 0); assert.equal(ordinary.stdout, 'fixture-present');
  assert.deepEqual(Object.keys(benchmarkChildEnvironment()).filter(key => !['SystemRoot', 'WINDIR'].includes(key)), []);
});

test('source hash conflict, ambiguous patch and source-size overflow preserve current saved bytes', async t => {
  const f = setup(t), before = fs.readFileSync(path.join(f.workspace, 'src/index.cjs'));
  denied(await f.call({ action: 'write', path: 'src/index.cjs', text: 'tamper', expectedHash: '0'.repeat(64) }));
  denied(await f.call({ action: 'patch', path: 'src/index.cjs', oldText: 'absent span', newText: 'tamper' }));
  denied(await f.call({ action: 'write', path: 'src/huge.cjs', text: 'x'.repeat(200001) }));
  assert.deepEqual(fs.readFileSync(path.join(f.workspace, 'src/index.cjs')), before);
});

test('post-admission scaffold change is rechecked before any implementation write', async t => {
  const f = setup(t), before = fs.readFileSync(path.join(f.workspace, 'src/index.cjs'));
  const result = await f.handler(workspaceCall({ action: 'write', path: 'src/index.cjs', text: 'tamper' }),
    { onOperationDispatch: async () => fs.writeFileSync(path.join(f.workspace, 'METHOD.md'), 'changed during admission\n') });
  denied(result); assert.equal(result.code, 'BENCHMARK_SCAFFOLD_CHANGED');
  assert.deepEqual(fs.readFileSync(path.join(f.workspace, 'src/index.cjs')), before);
});

test('contract digest is canonical and saved-source snapshot matches actual grader ordering', { timeout: 20000 }, async t => {
  const f = setup(t);
  const reversed = Object.fromEntries(Object.entries(f.profile).reverse());
  reversed.immutableFiles = Object.fromEntries(Object.entries(f.profile.immutableFiles).reverse());
  assert.equal(benchmarkContractHash(reversed), f.profile.contractSha256);
  for (const name of ['z.cjs', 'A.cjs', '_a.cjs', 'nested/B.cjs', 'nested/a.cjs'])
    assert.equal((await f.call({ action: 'write', path: 'src/' + name, text: 'module.exports = {};\n' })).success, true);
  const snapshot = benchmarkSourceSnapshot(f.profile);
  assert.deepEqual(snapshot.modules.map(file => file.path), ['A.cjs', '_a.cjs', 'index.cjs', 'nested/B.cjs', 'nested/a.cjs', 'z.cjs']);
  const result = await f.call({ action: 'run', command: 'node test-public.cjs' }), value = toolJSON(result);
  assert.equal(result.success, true, JSON.stringify(value));
  assert.equal(value.sourceSnapshotVerified, true);
  assert.equal(value.sourceSnapshotBeforeSha256, snapshot.sha256);
  assert.equal(value.sourceSnapshotAfterSha256, snapshot.sha256);
  assert.equal(JSON.parse(value.stdout).sourceSnapshotSha256, snapshot.sha256);
});

test('source drift during a completed command preserves its receipt and fails verification', async t => {
  let f;
  f = setup(t, {}, { runProcess: async () => {
    const snapshot = benchmarkSourceSnapshot(f.profile);
    fs.writeFileSync(path.join(f.workspace, 'src/index.cjs'), validSource + '// changed during check\n');
    return { stdout: JSON.stringify({ schema: 'blackice.minicpm.public-smoke.v1', taskId: 'D0', caseCount: 2,
      executedCases: 2, passedCases: 2, semanticPass: true, sourceSnapshotSha256: snapshot.sha256 }),
      stderr: '', exitCode: 0, signal: null, timedOut: false, truncated: false, durationMs: 1 };
  } });
  const result = await f.call({ action: 'run', command: 'node test-public.cjs' }), value = toolJSON(result);
  assert.equal(result.success, false); assert.equal(value.actionDispatched, true);
  assert.equal(value.exitCode, 0); assert.equal(value.reportValid, true);
  assert.equal(value.code, 'BENCHMARK_SOURCE_CHANGED'); assert.equal(value.sourceSnapshotVerified, false);
  assert.notEqual(value.sourceSnapshotBeforeSha256, value.sourceSnapshotAfterSha256);
  assert.equal(JSON.parse(value.stdout).sourceSnapshotSha256, value.sourceSnapshotBeforeSha256);
});

test('a signal or forged tested-source hash cannot become a successful public check', async t => {
  let f, mode = 'signal';
  f = setup(t, {}, { runProcess: async () => ({
    stdout: JSON.stringify({ schema: 'blackice.minicpm.public-smoke.v1', taskId: 'D0', caseCount: 2,
      executedCases: 2, passedCases: 2, semanticPass: true,
      sourceSnapshotSha256: mode === 'hash' ? '0'.repeat(64) : benchmarkSourceSnapshot(f.profile).sha256 }),
    stderr: '', exitCode: 0, signal: mode === 'signal' ? 'SIGTERM' : null, timedOut: false, truncated: false, durationMs: 1,
  }) });
  const signalled = await f.call({ action: 'run', command: 'node test-public.cjs' });
  assert.equal(signalled.success, false); assert.equal(toolJSON(signalled).signal, 'SIGTERM');
  assert.equal(toolJSON(signalled).actionDispatched, true);
  mode = 'hash';
  const mismatched = await f.call({ action: 'run', command: 'node test-public.cjs' });
  assert.equal(mismatched.success, false); assert.equal(toolJSON(mismatched).code, 'BENCHMARK_SOURCE_CHANGED');
  assert.equal(toolJSON(mismatched).actionDispatched, true);
});

test('fresh admission rejects undeclared helpers even when the declared entry hash still matches', t => {
  for (const helper of ['helper.cjs', 'nested/helper.cjs']) {
    const f = benchmarkFixture(t), target = path.join(f.workspace, 'src', helper);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'module.exports = "preexisting";\n');
    assert.equal(benchmarkHash(fs.readFileSync(path.join(f.workspace, 'src/index.cjs'))), f.receipt.initialSource['src/index.cjs']);
    assert.throws(() => normalizeBenchmarkProfile(f.request, { cwd: f.workspace }), { code: 'BENCHMARK_INITIAL_SOURCE_CHANGED' });
    assert.equal(benchmarkHash(fs.readFileSync(f.receiptPath)), f.request.scaffoldReceiptSha256);
  }
});

test('overlapping patch spans are ambiguous and cannot change saved source', async t => {
  const f = setup(t), text = "module.exports = { directorySmoke: () => 'aaa' };\n";
  assert.equal((await f.call({ action: 'write', path: 'src/index.cjs', text })).success, true);
  const result = await f.call({ action: 'patch', path: 'src/index.cjs', oldText: 'aa', newText: 'changed' });
  denied(result); assert.equal(result.code, 'BENCHMARK_PATCH_MATCH');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'src/index.cjs'), 'utf8'), text);
});
