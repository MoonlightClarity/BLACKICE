import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { frontendDevtoolsTool } from '../lib/frontend-devtools-tool.mjs';
import { DIRECT_JOB_LIMITS } from '../lib/direct-execution-jobs.mjs';

const receiptOf = result => JSON.parse(result.contentItems.find(item => item.type === 'inputText').text);

test('frontend tool requires its native adapter and exposes existing command authority', () => {
  for (const frontend of [undefined, {}, { execute: true }]) {
    assert.throws(() => frontendDevtoolsTool({ frontend }), TypeError);
  }
  const tool = frontendDevtoolsTool({ frontend: { execute() {} } });
  assert.equal(tool.definition.name, 'blackice_frontend');
  assert.equal(tool.definition.scope, 'commands:run');
  assert.deepEqual(tool.definition.requiredScopes, ['commands:run']);
  assert.equal(tool.timeoutMs, null);
  assert.deepEqual(tool.definition.inputSchema.required, ['requestId', 'action']);
  assert.equal(tool.definition.inputSchema.properties.method.type, 'string');
  assert.equal(tool.definition.inputSchema.properties.params.additionalProperties, true);
  assert.deepEqual(tool.definition.inputSchema.properties.target.enum, ['frontend', 'main']);
});

test('raw CDP methods, parameters, subtarget session and cancellation signal reach the same adapter unchanged', async () => {
  const signal = new AbortController().signal;
  const args = {
    requestId: 'native-raw-command', action: 'cdp', target: 'frontend', method: 'Target.sendMessageToTarget',
    params: { sessionId: 'nested-target', message: '{"id":17,"method":"HeapProfiler.collectGarbage"}', arbitrary: { arrays: [1, false, null] } },
    sessionId: 'outer-target', eventLimit: 10000, eventByteLimit: 16000000,
  };
  const receipt = { target: 'frontend', processId: 1234, method: args.method, result: { accepted: true, arbitrary: { response: [1, 2] } } };
  let calls = 0;
  const tool = frontendDevtoolsTool({ frontend: { async execute(received, options) {
    calls++; assert.equal(received, args); assert.equal(options.signal, signal); return receipt;
  } } });
  const result = await tool.execute(args, { signal });
  assert.equal(calls, 1); assert.equal(result.success, true);
  assert.deepEqual(receiptOf(result), receipt);
  assert.deepEqual(result.contentItems.map(item => item.type), ['inputText']);
});

test('evaluate forwards expressions and native protocol options without rewriting them', async () => {
  const args = { requestId: 'native-eval', action: 'evaluate', target: 'main',
    expression: 'globalThis.developerProbe = { changed: true }; globalThis.developerProbe',
    params: { awaitPromise: false, returnByValue: false, includeCommandLineAPI: true, throwOnSideEffect: false, timeout: 0, objectGroup: 'developer-owned' } };
  const receipt = { target: 'main', processId: 4321, method: 'Runtime.evaluate', result: { result: { type: 'object', objectId: 'retained-remote-object' } } };
  const tool = frontendDevtoolsTool({ frontend: { execute: async received => { assert.equal(received, args); return receipt; } } });
  assert.deepEqual(receiptOf(await tool.execute(args)), receipt);
});

test('JavaScript exceptions remain complete receipts and are reported as unsuccessful', async () => {
  const exceptionDetails = { text: 'Uncaught', lineNumber: 3, columnNumber: 7,
    exception: { type: 'object', subtype: 'error', description: 'Error: native probe\n    at probe (fixture:4:8)' },
    stackTrace: { callFrames: [{ functionName: 'probe', url: 'fixture', lineNumber: 3, columnNumber: 7 }] } };
  for (const receipt of [
    { target: 'frontend', exceptionDetails },
    { target: 'main', method: 'Runtime.evaluate', result: { result: exceptionDetails.exception, exceptionDetails } },
  ]) {
    const tool = frontendDevtoolsTool({ frontend: { execute: async () => receipt } });
    const result = await tool.execute({ requestId: 'native-exception', action: 'evaluate', expression: 'throw Error("native probe")' });
    assert.equal(result.success, false); assert.deepEqual(receiptOf(result), receipt);
  }
});

test('an intentionally returned Error object is not confused with a thrown JavaScript exception', async () => {
  const receipt = { result: { result: { type: 'object', subtype: 'error', description: 'Error: returned value' } } };
  const tool = frontendDevtoolsTool({ frontend: { execute: async () => receipt } });
  const result = await tool.execute({ requestId: 'native-returned-error', action: 'evaluate', expression: 'new Error("returned value")' });
  assert.equal(result.success, true); assert.deepEqual(receiptOf(result), receipt);
});

test('protocol failures preserve error name, code and data without manufacturing a successful result', async () => {
  const error = Object.assign(new Error("'Fixture.unknownMethod' wasn't found"), {
    name: 'ProtocolError', code: -32601, data: { method: 'Fixture.unknownMethod', detail: ['native', 17] },
  });
  const tool = frontendDevtoolsTool({ frontend: { execute: async () => { throw error; } } });
  for (const target of [undefined, 'main']) {
    const result = await tool.execute({ requestId: 'native-protocol-error', action: 'cdp', method: 'Fixture.unknownMethod', ...(target ? { target } : {}) });
    assert.equal(result.success, false);
    assert.deepEqual(receiptOf(result), { action: 'cdp', target: target || 'frontend', error: {
      name: 'ProtocolError', message: error.message, code: -32601, data: error.data,
    } });
  }
});

test('adapter cancellation stays a failure and the original signal is forwarded', async () => {
  const controller = new AbortController(); controller.abort();
  const tool = frontendDevtoolsTool({ frontend: { execute: async (_args, { signal }) => {
    assert.equal(signal, controller.signal);
    throw Object.assign(new Error('Command cancelled before dispatch.'), { name: 'AbortError', code: 'ABORT_ERR', commandDispatched: false, executionMayContinue: false, method: 'Profiler.start' });
  } } });
  const result = await tool.execute({ requestId: 'native-cancelled', action: 'cdp', method: 'Profiler.start' }, { signal: controller.signal });
  assert.equal(result.success, false); assert.equal(receiptOf(result).error.name, 'AbortError');
  assert.equal(receiptOf(result).error.code, 'ABORT_ERR');
  assert.equal(receiptOf(result).error.commandDispatched, false);
  assert.equal(receiptOf(result).error.executionMayContinue, false);
  assert.equal(receiptOf(result).error.method, 'Profiler.start');
});

test('screenshots become inputImage content while text retains metadata and excludes image bytes', async () => {
  const imageUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const receipt = Object.freeze({ target: 'frontend', processId: 1234, processRole: 'renderer', mimeType: 'image/png', width: 640, height: 480, imageUrl });
  const tool = frontendDevtoolsTool({ frontend: { execute: async () => receipt } });
  const result = await tool.execute({ requestId: 'native-screen', action: 'screenshot', rect: { x: 0, y: 0, width: 640, height: 480 } });
  assert.equal(result.success, true);
  assert.deepEqual(receiptOf(result), { target: 'frontend', processId: 1234, processRole: 'renderer', mimeType: 'image/png', width: 640, height: 480 });
  assert.deepEqual(result.contentItems[1], { type: 'inputImage', imageUrl });
  assert.equal(result.contentItems.length, 2); assert.equal(receipt.imageUrl, imageUrl);
});

test('oversized complete results are preserved atomically and failed evaluations retain their unsuccessful status', async t => {
  const artifactDirectory = await mkdtemp(path.join(tmpdir(), 'blackice-frontend-large-tool-'));
  t.after(() => rm(artifactDirectory, { recursive: true, force: true }));
  const native = { target: 'main', method: 'Runtime.evaluate', result: { exceptionDetails: {
    text: 'Uncaught', exception: { description: 'x'.repeat(DIRECT_JOB_LIMITS.resultBytes + 10) },
  } } };
  let calls = 0;
  const tool = frontendDevtoolsTool({ artifactDirectory, frontend: { execute: async () => { calls++; return native; } } });
  const args = { requestId: 'large-exception', action: 'evaluate', target: 'main', expression: 'fixture()' };
  const result = await tool.execute(args), receipt = receiptOf(result);
  assert.equal(calls, 1); assert.equal(result.success, false); assert.equal(receipt.success, false);
  assert.equal(receipt.inline, false); assert.equal(receipt.artifact.complete, true);
  assert.equal(receipt.method, 'Runtime.evaluate'); assert.equal(receipt.target, 'main');
  const expected = JSON.stringify({ success: false, contentItems: [{ type: 'inputText', text: JSON.stringify(native) }] });
  const bytes = await readFile(receipt.artifact.path);
  assert.equal(bytes.toString(), expected);
  assert.equal(receipt.artifact.bytes, bytes.length);
  assert.equal(receipt.artifact.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < DIRECT_JOB_LIMITS.resultBytes);
  assert.equal((await tool.execute(args)).contentItems[0].text, result.contentItems[0].text);
  assert.deepEqual(await readdir(artifactDirectory), [path.basename(receipt.artifact.path)]);
});
