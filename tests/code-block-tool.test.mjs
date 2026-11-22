import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { CODE_BLOCK_TOOL, parseCodeBlockCall, createCodeBlockToolHandler } from '../lib/code-block-tool.mjs';
import { createWorkspaceToolHandler, processRun } from '../lib/workspace-tools.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const fence = String.fromCharCode(96).repeat(3);
const call = arguments_ => ({ name: 'relay_code', callId: 'code-call-1', arguments: arguments_ });
const save = (code, extra = {}) => call({ action: 'save', language: 'javascript', path: 'sample.cjs', code, ...extra });
const check = (extra = {}) => call({ action: 'check', language: 'javascript', path: 'sample.cjs', check: 'syntax', ...extra });
const body = receipt => JSON.parse(receipt.contentItems[0].text);
const receipt = (value, success = true, extra = {}) => ({ success, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }], ...extra });
async function fixture(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'relay-code-tool-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const workspace = createWorkspaceToolHandler({ cwd });
  return { cwd, workspace };
}
function syntaxChecker(cwd) {
  const checker = async (call, context) => {
    assert.equal(call.name, 'relay_code');
    assert.equal(call.arguments.check, 'syntax');
    const ran = await processRun(process.execPath, ['--check', path.resolve(cwd, call.arguments.path)], { cwd, signal: context.signal, timeoutMs: 5000 });
    return receipt(ran, ran.exitCode === 0 && !ran.timedOut);
  };
  checker.describeOperation = (call, context) => ({ operationKey: 'syntax:' + call.arguments.path, testContext: context });
  return checker;
}

test('tool has explicit save/check schemas and rejects unknown fields before backend dispatch', async () => {
  assert.equal(CODE_BLOCK_TOOL.name, 'relay_code');
  assert.equal(CODE_BLOCK_TOOL.inputSchema.additionalProperties, false);
  assert.equal(CODE_BLOCK_TOOL.inputSchema.oneOf.length, 2);
  let calls = 0;
  const handler = createCodeBlockToolHandler({ workspaceHandler: async () => { calls++; } });
  for (const value of [
    save('x', { check: 'public' }), check({ code: 'x' }), check({ command: 'arbitrary' }),
    save('x', { cwd: 'elsewhere' }), save('x', { expectedHash: 'bad' }),
    save('x', { path: 'bad\0path' }), save('x', { language: 'js;run' })
  ]) assert.equal((await handler(value)).success, false);
  assert.equal(calls, 0);
});

test('raw save preserves exact UTF-8/CRLF source, verifies bytes and never executes it', async t => {
  const { cwd, workspace } = await fixture(t);
  const code = 'const label = "\u{1F600} e\u0301 \u{1F469}\u200D\u{1F4BB} \u{1F468}\u200D\u{1F469}\u200D\u{1F467}";\r\nrequire("node:fs").writeFileSync("executed", "bad");\r\n';
  const handler = createCodeBlockToolHandler({ workspaceHandler: workspace, guardedWrites: true });
  const result = await handler(save(code));
  assert.equal(result.success, true);
  const value = body(result);
  assert.equal(value.saved, true);
  assert.equal(value.sourceSha256, hash(code));
  assert.equal(value.sourceBytes, Buffer.byteLength(code));
  assert.equal(value.readback.verified, true);
  assert.equal(value.readback.sha256, hash(code));
  assert.deepEqual(value.checks, { performed: false });
  const bytes = await readFile(path.join(cwd, 'sample.cjs'));
  assert.deepEqual(bytes, Buffer.from(code, 'utf8'));
  assert.equal(bytes.toString('utf8'), code);
  const savedCall = save(code);
  const descriptor = await handler.describeOperation(savedCall);
  const normalized = await handler.normalizeOperationResult(result, { call: savedCall, descriptor });
  assert.equal(normalized.effectState, 'confirmed');
  assert.ok(normalized.evidence.some(item => item.sourceVersion === hash(bytes) && item.validation.adapter === 'relay_workspace' && item.validation.action === 'write'));
  await assert.rejects(stat(path.join(cwd, 'executed')), { code: 'ENOENT' });
});

test('single explicit fenced submission preserves body bytes and language aliases', async t => {
  const { cwd, workspace } = await fixture(t);
  const code = 'module.exports = "\u{1F600} e\u0301 \u{1F469}\u200D\u{1F4BB}";\r\n';
  const handler = createCodeBlockToolHandler({ workspaceHandler: workspace });
  const result = await handler(save(fence + 'js\r\n' + code + fence + '\r\n', { format: 'fenced' }));
  assert.equal(result.success, true);
  assert.equal(body(result).language, 'javascript');
  assert.equal(await readFile(path.join(cwd, 'sample.cjs'), 'utf8'), code);
  assert.equal(parseCodeBlockCall(save('~~~javascript\nx\n~~~', { format: 'fenced' })).code, 'x\n');
});

test('fence parser rejects prose, multiple blocks, mismatched languages and missing closure without effects', async () => {
  let calls = 0;
  const handler = createCodeBlockToolHandler({ workspaceHandler: async () => { calls++; } });
  const invalid = [
    'Explanation\n' + fence + 'js\nx\n' + fence,
    fence + 'js\nx\n' + fence + '\nExplanation',
    fence + 'js\nx\n' + fence + '\n' + fence + 'js\ny\n' + fence,
    fence + 'python\nx\n' + fence,
    fence + 'js\nx\n',
    fence + 'js\nx\n' + fence + 'python\n'
  ];
  for (const code of invalid) assert.equal((await handler(save(code, { format: 'fenced' }))).success, false);
  assert.equal(calls, 0);
});

test('raw source is never searched for an embedded code fence', () => {
  const code = 'explanation\n' + fence + 'js\nx\n' + fence;
  assert.equal(parseCodeBlockCall(save(code)).code, code);
});

test('unpaired UTF-16 surrogates in raw and fenced source are rejected before any UTF-8 write', async () => {
  let calls = 0;
  const handler = createCodeBlockToolHandler({ workspaceHandler: async () => { calls++; } });
  for (const malformed of ['\uD800', '\uDC00', '\uD800x', 'x\uDC00', '\uDC00\uD800']) {
    for (const format of ['raw', 'fenced']) {
      const source = 'const value = "' + malformed + '";\n';
      const submitted = format === 'fenced' ? fence + 'js\n' + source + fence : source;
      const result = await handler(save(submitted, { format }));
      assert.equal(result.success, false);
      assert.equal(result.code, 'CODE_BLOCK_UNICODE');
      assert.equal(body(result).actionDispatched, false);
    }
  }
  assert.equal(calls, 0);
});

test('source size and NUL failures occur before dispatch', async () => {
  let calls = 0;
  const handler = createCodeBlockToolHandler({ workspaceHandler: async () => { calls++; } });
  for (const code of ['\0', '✓'.repeat(350000)])
    assert.equal((await handler(save(code))).code, 'CODE_BLOCK_SOURCE');
  assert.equal(calls, 0);
});

test('guarded saves reject unsupported backends and stale real files without fallback', async t => {
  const { cwd, workspace } = await fixture(t);
  await writeFile(path.join(cwd, 'sample.cjs'), 'current');
  const unsupported = createCodeBlockToolHandler({ workspaceHandler: workspace });
  assert.equal((await unsupported(save('new', { expectedHash: hash('current') }))).code, 'CODE_GUARDED_WRITE_UNAVAILABLE');
  const supported = createCodeBlockToolHandler({ workspaceHandler: workspace, guardedWrites: true });
  const staleCall = save('new', { expectedHash: hash('stale') });
  const stale = await supported(staleCall);
  assert.equal(stale.success, false);
  assert.equal(body(stale).code, 'WORKSPACE_WRITE_CONFLICT');
  const descriptor = await supported.describeOperation(staleCall);
  const normalized = await supported.normalizeOperationResult(stale, { call: staleCall, descriptor });
  assert.equal(normalized.effectState, 'absent');
  assert.equal(normalized.actionDispatched, false);
  assert.deepEqual(normalized.evidence, []);
  assert.equal(await readFile(path.join(cwd, 'sample.cjs'), 'utf8'), 'current');
  assert.equal((await supported(save('new', { expectedHash: hash('current') }))).success, true);
});

test('managed-path protection is retained through the code tool', async t => {
  const { cwd } = await fixture(t);
  const target = path.join(cwd, 'sample.cjs');
  await writeFile(target, 'owner source');
  const workspace = createWorkspaceToolHandler({ cwd, protectedPaths: [target] });
  const handler = createCodeBlockToolHandler({ workspaceHandler: workspace, guardedWrites: true });
  const result = await handler(save('bad', { expectedHash: hash('owner source') }));
  assert.equal(result.success, false);
  assert.equal(body(result).code, 'WORKSPACE_PROTECTED_PATH');
  assert.equal(await readFile(target, 'utf8'), 'owner source');
});

test('failed readback retains a confirmed save receipt', async t => {
  const { cwd, workspace } = await fixture(t);
  const scoped = async (call, context) => call.arguments.action === 'read'
    ? receipt({ code: 'READ_BLOCKED', error: 'Read unavailable', actionDispatched: false }, false)
    : workspace(call, context);
  const handler = createCodeBlockToolHandler({ workspaceHandler: scoped });
  const result = await handler(save('saved despite failed readback\n'));
  assert.equal(result.success, false);
  const value = body(result);
  assert.equal(value.code, 'CODE_READBACK_FAILED');
  assert.equal(value.saved, true);
  assert.equal(value.actionDispatched, true);
  assert.equal(value.saveReceipt.atomic, true);
  assert.equal(body(value.readbackReceipt).code, 'READ_BLOCKED');
  assert.equal(await readFile(path.join(cwd, 'sample.cjs'), 'utf8'), 'saved despite failed readback\n');
});

test('changed saved bytes fail verification while retaining actual save/readback evidence', async t => {
  const { cwd, workspace } = await fixture(t);
  const scoped = async (call, context) => {
    if (call.arguments.action === 'read') await writeFile(path.join(cwd, 'sample.cjs'), 'external change\n');
    return workspace(call, context);
  };
  const result = await createCodeBlockToolHandler({ workspaceHandler: scoped })(save('submitted\n'));
  assert.equal(result.success, false);
  assert.equal(body(result).code, 'CODE_READBACK_MISMATCH');
  assert.equal(body(result).saved, true);
  assert.equal(body(result).readback.identity.sha256, hash('external change\n'));
});

test('readback without complete hash and byte count cannot pass verification', async () => {
  const workspace = async call => call.arguments.action === 'write'
    ? receipt({ path: 'sample.cjs', bytesWritten: 1 })
    : receipt({ path: 'sample.cjs', size: 1, content: '1: x' });
  const result = await createCodeBlockToolHandler({ workspaceHandler: workspace })(save('x'));
  assert.equal(result.success, false);
  assert.equal(body(result).saved, true);
  assert.equal(body(result).code, 'CODE_READBACK_UNVERIFIED');
});

test('real syntax checking reports passing and failing exit statuses without executing the source', async t => {
  const { cwd, workspace } = await fixture(t);
  const handler = createCodeBlockToolHandler({ workspaceHandler: workspace, syntaxCheck: syntaxChecker(cwd) });
  await handler(save('require("node:fs").writeFileSync("executed", "bad");\n'));
  const good = await handler(check());
  assert.equal(good.success, true);
  assert.equal(body(good).check.passed, true);
  assert.equal(body(good).check.receipt.exitCode, 0);
  await assert.rejects(stat(path.join(cwd, 'executed')), { code: 'ENOENT' });
  await handler(save('const = ;\n'));
  const bad = await handler(check());
  assert.equal(bad.success, false);
  assert.equal(body(bad).check.passed, false);
  assert.notEqual(body(bad).check.receipt.exitCode, 0);
  assert.match(body(bad).check.receipt.stderr, /SyntaxError/);
});

test('public checker receives only the normalized native call and its actual command receipt is retained', async t => {
  const { cwd, workspace } = await fixture(t);
  await writeFile(path.join(cwd, 'test-public.cjs'), 'const value = require("./sample.cjs"); if (value !== 42) { console.error("expected 42"); process.exitCode = 1; } else console.log("public pass");\n');
  const publicCheck = async (call, context) => {
    assert.equal(call.name, 'relay_code');
    assert.equal(call.callId, 'code-call-1');
    assert.equal(call.arguments.check, 'public');
    assert.equal(context.codeSource.sha256, hash(await readFile(path.join(cwd, 'sample.cjs'))));
    const ran = await processRun(process.execPath, ['test-public.cjs'], { cwd, signal: context.signal, timeoutMs: 5000 });
    return receipt({ ...ran, command: 'node test-public.cjs' }, ran.exitCode === 0);
  };
  const publicRun = call => ({ ...call, name: 'relay_workspace', arguments: { action: 'run', command: 'node test-public.cjs' } });
  publicCheck.describeOperation = (call, context) => workspace.describeOperation(publicRun(call), context);
  publicCheck.normalizeOperationResult = (result, context) => {
    assert.equal(context.call.name, 'relay_code');
    assert.equal(context.call.arguments.check, 'public');
    return workspace.normalizeOperationResult(result, { ...context, call: publicRun(context.call) });
  };
  const handler = createCodeBlockToolHandler({ workspaceHandler: workspace, publicCheck });
  await handler(save('module.exports = 41;\n'));
  const failed = await handler(check({ check: 'public' }));
  assert.equal(failed.success, false);
  assert.equal(body(failed).check.receipt.exitCode, 1);
  assert.match(body(failed).check.receipt.stderr, /expected 42/);
  await handler(save('module.exports = 42;\n'));
  const passed = await handler(check({ check: 'public' }));
  assert.equal(passed.success, true);
  assert.equal(body(passed).check.receipt.command, 'node test-public.cjs');
  assert.match(body(passed).check.receipt.stdout, /public pass/);
  const checkCall = check({ check: 'public' });
  const descriptor = await handler.describeOperation(checkCall);
  const normalized = await handler.normalizeOperationResult(passed, { call: checkCall, descriptor });
  assert.equal(normalized.effectState, 'confirmed');
  assert.ok(normalized.evidence.some(item => item.validation.adapter === 'relay_workspace' && item.validation.action === 'run' && item.validation.workspaceCommandOutput === true));
  const rejected = await handler.normalizeOperationResult(failed, { call: checkCall, descriptor });
  assert.equal(rejected.effectState, 'unknown');
  assert.deepEqual(rejected.evidence, []);
});

test('unavailable checker does not read or execute and stale check hashes prevent execution', async t => {
  let calls = 0;
  const unavailable = createCodeBlockToolHandler({ workspaceHandler: async () => { calls++; } });
  assert.equal((await unavailable(check())).code, 'CODE_CHECK_UNAVAILABLE');
  assert.equal(calls, 0);
  const { cwd, workspace } = await fixture(t);
  await writeFile(path.join(cwd, 'sample.cjs'), 'current');
  const handler = createCodeBlockToolHandler({ workspaceHandler: workspace, syntaxCheck: async () => { calls++; } });
  assert.equal((await handler(check({ expectedHash: hash('stale') }))).code, 'CODE_CHECK_SOURCE_CONFLICT');
  assert.equal(calls, 0);
});

test('a source changed by checking cannot be represented as a passing check', async t => {
  const { cwd, workspace } = await fixture(t);
  await writeFile(path.join(cwd, 'sample.cjs'), 'before');
  const handler = createCodeBlockToolHandler({ workspaceHandler: workspace, syntaxCheck: async () => {
    await writeFile(path.join(cwd, 'sample.cjs'), 'after');
    return receipt({ exitCode: 0, stdout: 'claimed pass', stderr: '', timedOut: false });
  } });
  const result = await handler(check());
  assert.equal(result.success, false);
  assert.equal(result.code, 'CODE_CHECK_SOURCE_CHANGED');
  assert.equal(body(result).check.receipt.exitCode, 0);
  assert.equal(body(result).source.unchanged, false);
});

test('timeout and malformed success receipts never become passing checks', async t => {
  const { cwd, workspace } = await fixture(t);
  await writeFile(path.join(cwd, 'sample.cjs'), 'source');
  const timeout = createCodeBlockToolHandler({ workspaceHandler: workspace, syntaxCheck: async () => receipt({ exitCode: null, timedOut: true, stdout: 'partial', stderr: '' }, false) });
  const timed = await timeout(check());
  assert.equal(timed.success, false);
  assert.equal(body(timed).check.receipt.timedOut, true);
  assert.equal(body(timed).check.receipt.stdout, 'partial');
  const malformed = createCodeBlockToolHandler({ workspaceHandler: workspace, syntaxCheck: async () => receipt({ stdout: 'looks good' }) });
  const result = await malformed(check());
  assert.equal(result.success, false);
  assert.equal(result.code, 'CODE_CHECK_RECEIPT_INVALID');
  assert.equal(body(result).actionDispatched, true);
  assert.equal(body(body(result).checkReceipt).stdout, 'looks good');
});

test('pre-dispatch cancellation is effect-free and cancellation after save retains the save', async t => {
  let calls = 0;
  const cancelled = new AbortController(); cancelled.abort();
  const unused = createCodeBlockToolHandler({ workspaceHandler: async () => { calls++; } });
  const first = await unused(save('x'), { signal: cancelled.signal });
  assert.equal(first.code, 'ABORT_ERR');
  assert.equal(body(first).actionDispatched, false);
  assert.equal(calls, 0);
  const { cwd, workspace } = await fixture(t);
  const controller = new AbortController();
  const scoped = async (call, context) => {
    const result = await workspace(call, context);
    if (call.arguments.action === 'write') controller.abort();
    return result;
  };
  const result = await createCodeBlockToolHandler({ workspaceHandler: scoped })(save('retained\n'), { signal: controller.signal });
  assert.equal(result.success, false);
  assert.equal(body(result).saved, true);
  assert.equal(body(result).actionDispatched, true);
  assert.equal(await readFile(path.join(cwd, 'sample.cjs'), 'utf8'), 'retained\n');
});

test('operation descriptors and normalizers preserve the selected backend admission path', async () => {
  const context = { marker: true };
  let mapped, callbackCall;
  const workspace = Object.assign(async () => { throw Error('not dispatched'); }, {
    describeOperation: (call, received) => { mapped = call; assert.equal(received, context); return { operationKey: 'save-key' }; },
    normalizeOperationResult: (result, received) => ({ normalized: result, received })
  });
  const checker = Object.assign(async () => { throw Error('not dispatched'); }, {
    describeOperation: (call, received) => { callbackCall = call; assert.equal(received, context); return { operationKey: 'check-key' }; },
    normalizeOperationResult: (result, received) => ({ checkerNormalized: result, received })
  });
  const handler = createCodeBlockToolHandler({ workspaceHandler: workspace, syntaxCheck: checker, guardedWrites: true });
  const expectedHash = hash('old');
  assert.deepEqual(await handler.describeOperation(save(fence + 'js\ncode\n' + fence, { format: 'fenced', expectedHash }), context), { operationKey: 'save-key' });
  assert.equal(mapped.name, 'relay_workspace');
  assert.equal(mapped.callId, 'code-call-1');
  assert.deepEqual(mapped.arguments, { action: 'write', path: 'sample.cjs', text: 'code\n', expectedHash });
  assert.deepEqual(await handler.describeOperation(check(), context), { operationKey: 'check-key' });
  assert.equal(callbackCall.name, 'relay_code');
  assert.equal(callbackCall.arguments.language, 'javascript');
  assert.equal(handler.operationAdapter, 'relay_code');
  assert.deepEqual(handler.normalizeOperationResult('receipt', context), { normalized: 'receipt', received: context });
  const saveContext = { ...context, call: save(fence + 'js\ncode\n' + fence, { format: 'fenced', expectedHash }) };
  const normalizedSave = handler.normalizeOperationResult('save-receipt', saveContext);
  assert.equal(normalizedSave.received.marker, true);
  assert.deepEqual(normalizedSave.received.call, mapped);
  const checkContext = { ...context, call: check({ language: 'js' }) };
  const normalizedCheck = handler.normalizeOperationResult('check-receipt', checkContext);
  assert.equal(normalizedCheck.checkerNormalized, 'check-receipt');
  assert.equal(normalizedCheck.received.marker, true);
  assert.equal(normalizedCheck.received.call.name, 'relay_code');
  assert.equal(normalizedCheck.received.call.arguments.language, 'javascript');
  assert.equal(checkContext.call.arguments.language, 'js');
  const missing = createCodeBlockToolHandler({ workspaceHandler: workspace, syntaxCheck: async () => receipt({ exitCode: 0 }) });
  await assert.rejects(missing.describeOperation(check()), { code: 'CODE_OPERATION_UNAVAILABLE' });
  assert.deepEqual(missing.normalizeOperationResult('unconfirmed', checkContext), { normalized: 'unconfirmed', received: checkContext });
});

test('save dispatch receives admission context once; readback cannot repeat effect admission', async t => {
  const { workspace } = await fixture(t);
  let admissions = 0;
  const handler = createCodeBlockToolHandler({ workspaceHandler: workspace });
  const result = await handler(save('module.exports = 1;\n'), { onOperationDispatch: () => { admissions++; } });
  assert.equal(result.success, true);
  assert.equal(admissions, 1);
});

test('invalid backend save receipt retains uncertainty rather than claiming no write', async () => {
  const handler = createCodeBlockToolHandler({ workspaceHandler: async () => ({ malformed: true }) });
  const result = await handler(save('x'));
  assert.equal(result.success, false);
  assert.equal(body(result).saved, 'unconfirmed');
  assert.equal(body(result).actionDispatched, true);
});
