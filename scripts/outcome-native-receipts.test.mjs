import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { installNativeRequestRecorder } from './outcome-native-receipts.mjs';

test('records actual request arguments and IDs without replacing promises or receivers', async () => {
  const lines = [], calls = [], promises = [];
  const codex = {
    _request(...args) {
      calls.push({ receiver: this, args });
      const value = args[0] === 'turn/start' ? { turn: { id: 'turn-one' } } : { thread: { id: 'thread-one', ephemeral: true } };
      const promise = Promise.resolve(value);
      promises.push(promise);
      return promise;
    },
  };
  const original = codex._request;
  const recorder = installNativeRequestRecorder(codex, { file: '/receipts/baseline.jsonl', append: async (file, line) => lines.push({ file, value: JSON.parse(line) }) });
  const params = { cwd: '/cases/on/example', model: 'test-model', developerInstructions: 'Exact developer instructions.\nSecond line.' };
  const thread = codex._request('thread/start', params, 42);
  assert.equal(thread, promises[0]);
  assert.equal(calls[0].receiver, codex);
  assert.deepEqual(calls[0].args, ['thread/start', params, 42]);
  assert.equal(calls[0].args[1], params);
  await thread;
  const input = [{ type: 'text', text: 'Exact task text.' }];
  const turnParams = { threadId: 'thread-one', input };
  const turn = codex._request('turn/start', turnParams);
  assert.equal(turn, promises[1]);
  assert.equal(calls[1].args[1], turnParams);
  assert.equal(calls[1].args[1].input, input);
  await turn;
  await recorder.flush();
  const records = recorder.forCwd(params.cwd);
  assert.equal(records.length, 2);
  assert.equal(records[0].request.developerInstructions.text, params.developerInstructions);
  assert.equal(records[0].request.developerInstructions.sha256, createHash('sha256').update(params.developerInstructions).digest('hex'));
  assert.equal(records[0].response.threadId, 'thread-one');
  assert.equal(records[0].response.ephemeral, true);
  assert.equal(records[1].request.inputTexts[0].text, input[0].text);
  assert.equal(records[1].response.turnId, 'turn-one');
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map(line => line.value.event), ['requested', 'settled', 'requested', 'settled']);
  assert.ok(lines.every(line => line.file === '/receipts/baseline.jsonl'));
  assert.deepEqual(recorder.forCwd('/cases/another'), []);
  recorder.restore();
  assert.equal(codex._request, original);
});

test('records request rejection while preserving the original promise and error', async () => {
  const error = Object.assign(new Error('Native request rejected'), { code: 'NATIVE_FAILURE' });
  const promise = Promise.reject(error);
  const codex = { _request: () => promise };
  const recorder = installNativeRequestRecorder(codex, { file: '/receipts/errors.jsonl', append: async () => {} });
  const returned = codex._request('thread/resume', { cwd: '/cases/failure', threadId: 'existing-thread', developerInstructions: 'Current instructions.' });
  assert.equal(returned, promise);
  await assert.rejects(returned, caught => caught === error);
  await recorder.flush();
  const [record] = recorder.forCwd('/cases/failure');
  assert.equal(record.status, 'rejected');
  assert.equal(record.error.message, error.message);
  assert.equal(record.error.code, error.code);
  recorder.restore();
});

test('receipt write failure invalidates observation without changing runtime success', async () => {
  const value = { thread: { id: 'still-succeeded' } }, promise = Promise.resolve(value);
  const codex = { _request: () => promise };
  const recorder = installNativeRequestRecorder(codex, { file: '/receipts/unwritable.jsonl', append: async () => { throw Error('Receipt disk unavailable'); } });
  const returned = codex._request('thread/start', { cwd: '/cases/write-failure', developerInstructions: 'Unchanged.' });
  assert.equal(returned, promise);
  assert.equal(await returned, value);
  await assert.rejects(recorder.flush(), /Receipt disk unavailable/);
  assert.equal(recorder.forCwd('/cases/write-failure')[0].status, 'fulfilled');
  recorder.restore();
});

test('preserves synchronous throws, ignores other methods, and restores an inherited method', async () => {
  const error = new Error('Synchronous failure'), lines = [];
  const original = function (method) { if (method === 'thread/start') throw error; return 'passthrough'; };
  const codex = Object.create({ _request: original });
  const recorder = installNativeRequestRecorder(codex, { file: '/receipts/sync.jsonl', append: async (_, line) => lines.push(JSON.parse(line)) });
  assert.equal(codex._request('initialize', { secret: 'not recorded' }), 'passthrough');
  assert.throws(() => codex._request('thread/start', { cwd: '/cases/sync' }), caught => caught === error);
  await recorder.flush();
  assert.equal(lines.length, 2);
  assert.equal(recorder.forCwd('/cases/sync')[0].status, 'threw');
  recorder.restore();
  assert.equal(Object.hasOwn(codex, '_request'), false);
  assert.equal(codex._request, original);
});
