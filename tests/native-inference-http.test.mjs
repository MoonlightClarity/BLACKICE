import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeInferenceHTTP } from '../lib/native-inference/http.mjs';
import { BuiltinInferenceManager } from '../lib/native-inference/backends.mjs';

const id = 'native_' + 'a'.repeat(32);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const managerFixture = () => {
  const calls = [];
  const manager = {
    async status() { calls.push(['status']); return { engines: [{ id: 'blackice', available: true }], sessions: [] }; },
    async load(args) { calls.push(['load', args]); return { id, backend: args.backend, modelPath: args.modelPath }; },
    async generate(args) {
      calls.push(['generate', { ...args, signal: !!args.signal }]);
      return { backend: 'blackice', text: ' Answer', tokenIds: [21806], completed: true };
    },
    cancel(value) { calls.push(['cancel', value]); return { id: value, cancellationRequested: true }; },
    async unload(value) { calls.push(['unload', value]); return { id: value, unloaded: true }; },
  };
  return { manager, calls };
};
const call = (manager, pathname, value, options = {}) =>
  nativeInferenceHTTP({ manager, pathname, method: pathname.endsWith('/status') ? 'GET' : 'POST', value, ...options });

test('native inference lifecycle routes call the explicitly selected backend only', async () => {
  const { manager, calls } = managerFixture();
  const status = await call(manager, '/api/native-inference/status');
  assert.equal(status.status, 200);
  const loaded = await call(manager, '/api/native-inference/load', {
    backend: 'blackice', modelPath: path.resolve('qwen-fp16'), maxContext: 64, cpuKernel: 'simd',
  });
  assert.equal(loaded.body.backend, 'blackice');
  assert.equal(calls[1][1].cpuKernel, 'simd');
  assert.equal(loaded.body.id, id);
  const result = await call(manager, '/api/native-inference/generate',
    { id, prompt: 'Hello', maxTokens: 1, enableThinking: false });
  assert.equal(result.status, 200);
  assert.equal(result.body.text, ' Answer');
  assert.equal(calls[2][1].signal, false);
  assert.equal(calls[2][1].maxTokens, 1);
  assert.equal((await call(manager, '/api/native-inference/cancel', { id })).body.cancellationRequested, true);
  assert.equal((await call(manager, '/api/native-inference/unload', { id })).body.unloaded, true);
  assert.deepEqual(calls.map(item => item[0]), ['status', 'load', 'generate', 'cancel', 'unload']);
});

test('local inference rejects remote requests before any file or process work', async () => {
  const { manager, calls } = managerFixture();
  for (const pathname of ['/api/native-inference/status', '/api/native-inference/load',
    '/api/native-inference/generate', '/api/native-inference/unload', '/api/native-inference/cancel']) {
    const result = await call(manager, pathname, { id }, { remote: true });
    assert.equal(result.status, 403);
  }
  assert.equal(calls.length, 0);
});

test('native inference validates shapes, IDs and generation budget before execution', async () => {
  const { manager, calls } = managerFixture();
  const base = '/api/native-inference/generate';
  for (const payload of [
    { id, prompt: 'a', messages: [{ role: 'user', content: 'b' }] },
    { id, prompt: '' },
    { id, tokenIds: [1, 2.5] },
    { id, tokenIds: [] },
    { id: 'fake', prompt: 'hello' },
    { id, prompt: 'hello', maxTokens: 0 },
    { id, prompt: 'hello', maxTokens: 65 },
    { id, prompt: 'hello', maxTokens: '2' },
    { id, prompt: 'hello', enableThinking: 'false' },
    { id, prompt: 'hello', unexpected: 123 },
  ]) {
    const result = await call(manager, base, payload);
    assert.equal(result.status, 400, JSON.stringify(payload));
  }
  assert.equal((await call(manager, '/api/native-inference/load',
    { backend: 'ollama', modelPath: 'C:\\Models\\qwen' })).status, 400);
  assert.equal((await call(manager, '/api/native-inference/load',
    { backend: 'blackice', modelPath: '' })).status, 400);
  assert.equal((await call(manager, '/api/native-inference/load',
    { backend: 'blackice', modelPath: path.resolve('qwen'), cpuKernel: 'q4' })).status, 400);
  assert.equal((await call(manager, '/api/native-inference/load',
    { backend: 'llama.cpp', modelPath: path.resolve('model.gguf'), cpuKernel: 'simd' })).status, 400);
  assert.equal(calls.length, 0);
});

test('native inference returns structured busy, missing and unavailable errors', async () => {
  const { manager } = managerFixture();
  manager.generate = async () => { throw Object.assign(new Error('Already generating.'), { code: 'NATIVE_SESSION_BUSY' }); };
  assert.deepEqual(await call(manager, '/api/native-inference/generate', { id, prompt: 'Hi' }),
    { status: 409, body: { error: 'Already generating.', code: 'NATIVE_SESSION_BUSY' } });
  manager.generate = async () => { throw Object.assign(new Error('No saved session.'), { code: 'NATIVE_SESSION_NOT_FOUND' }); };
  assert.equal((await call(manager, '/api/native-inference/generate', { id, prompt: 'Hi' })).status, 404);
  manager.load = async () => { throw Object.assign(new Error('No bundled executable.'), { code: 'NATIVE_ENGINE_NOT_BUNDLED' }); };
  assert.equal((await call(manager, '/api/native-inference/load', { backend: 'llama.cpp', modelPath: 'C:\\Models\\qwen.gguf' })).status, 503);
});

test('external cancellation signal is forwarded without substituting another engine', async () => {
  const { manager, calls } = managerFixture();
  const controller = new AbortController();
  await call(manager, '/api/native-inference/generate',
    { id, prompt: 'Hello' }, { signal: controller.signal });
  assert.equal(calls[0][1].signal, true);
});

test('native model manager cancels worker generation and closes without leaking sessions', async () => {
  const pending = deferred();
  const seen = [];
  const manager = new BuiltinInferenceManager({
    llamaCpp: { available: async () => false },
    workerFactory: () => ({
      async load() { return { sourcePrecision: ['F16'], maxContext: 64 }; },
      generate({ signal }) {
        seen.push('generate');
        signal.addEventListener('abort', () => {
          seen.push('abort');
          pending.reject(Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' }));
        }, { once: true });
        return pending.promise;
      },
      cancel() { seen.push('cancel'); },
      async unload() { seen.push('unload'); },
    }),
  });
  const loaded = await manager.load({ backend: 'blackice', modelPath: path.resolve('qwen') });
  const run = manager.generate({ id: loaded.id, prompt: 'Hi' });
  await Promise.resolve();
  assert.equal((await manager.status()).sessions[0].status, 'running');
  assert.equal(manager.cancel(loaded.id).cancellationRequested, true);
  await assert.rejects(run, e => e.code === 'ABORT_ERR');
  assert.equal((await manager.status()).sessions[0].status, 'loaded');
  assert.equal((await manager.unload(loaded.id)).unloaded, true);
  assert.deepEqual(seen, ['generate', 'abort', 'cancel', 'unload']);
});

test('shutdown cancels in-progress native inference before disposing workers', async () => {
  const pending = deferred();
  const seen = [];
  const manager = new BuiltinInferenceManager({
    llamaCpp: { available: async () => false },
    workerFactory: () => ({
      async load() { return {}; },
      generate({ signal }) {
        signal.addEventListener('abort', () => pending.reject(Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' })), { once: true });
        return pending.promise;
      },
      cancel() { seen.push('cancel'); },
      async unload() { seen.push('unload'); },
    }),
  });
  const { id: sessionId } = await manager.load({ backend: 'blackice', modelPath: path.resolve('qwen') });
  const request = manager.generate({ id: sessionId, prompt: 'Hi' }).catch(e => e.code);
  await Promise.resolve();
  await manager.close();
  assert.equal(await request, 'ABORT_ERR');
  assert.deepEqual(seen, ['cancel', 'unload']);
  assert.equal((await manager.status()).sessions.length, 0);
});

test('server wires native lifecycle and closes native inference during shutdown', async () => {
  const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(server, /nativeInferenceHTTP/);
  assert.match(server, /nativeInference\.close\(\)/);
  assert.ok(server.includes('load|generate|cancel|unload'), 'native lifecycle routes must be registered');
});
