import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { BuiltinInferenceManager } from '../lib/native-inference/backends.mjs';
import os from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';

class FakeRuntime extends EventEmitter {
  status() { return { connected: true, authenticated: true, defaultModel: 'fixture-model', activeTurns: 0 }; }
  async start() { return this.status(); }
  async runAgent() { return { output: '', threadId: 'native-http-test' }; }
  async close() {}
}
const id = 'native_' + 'b'.repeat(32);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function fixture(t, manager) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blackice-native-http-'));
  const app = await createHarnessServer({
    runtime: new FakeRuntime(), nativeInference: manager, remoteAccess: false,
    port: 0, dataDir: path.join(directory, 'data'), defaultCwd: path.join(directory, 'workspace'),
  });
  const base = new URL(await app.listen());
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = (route, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      hostname: base.hostname, port: base.port, path: route, method,
      headers: {
        ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, res => {
      const parts = [];
      res.on('data', chunk => parts.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        resolve({ status: res.statusCode, data, text, headers: res.headers });
      });
      res.on('error', reject);
    });
    req.setTimeout(route === '/api/native-inference/generate' ? 120000 : 8000,
      () => req.destroy(new Error('Native HTTP test timed out.')));
    req.once('error', reject);
    req.end(payload);
  });
  const home = await request('/');
  assert.equal(home.status, 200);
  const cookie = home.headers['set-cookie']?.[0]?.split(';')[0];
  assert.ok(cookie, 'Local BLACKICE cookie must be present.');
  return { app, request, auth: { Cookie: cookie } };
}

test('real BLACKICE HTTP server hosts native model load, generate, cancel, unload and UI assets', async t => {
  const calls = [];
  const manager = {
    async status() { calls.push('status'); return { engines: [{ id: 'blackice', available: true }], sessions: [] }; },
    async load(value) { calls.push(['load', value]); return { id, backend: value.backend, modelPath: value.modelPath }; },
    async generate(value) { calls.push(['generate', value.prompt, !!value.signal]); return { backend: 'blackice', completed: true, text: ' Answer', tokenIds: [21806] }; },
    cancel(value) { calls.push(['cancel', value]); return { id: value, cancellationRequested: false }; },
    async unload(value) { calls.push(['unload', value]); return { id: value, unloaded: true }; },
    async close() { calls.push('close'); },
  };
  const f = await fixture(t, manager);
  assert.equal((await f.request('/api/native-inference/status')).status, 401);
  const status = await f.request('/api/native-inference/status', { headers: f.auth });
  assert.equal(status.status, 200);
  assert.deepEqual(status.data.engines.map(value => value.id), ['blackice']);
  const asset = await f.request('/next/workspaces/settings-native-models.mjs', { headers: f.auth });
  assert.equal(asset.status, 200);
  assert.match(asset.headers['content-type'], /javascript/);
  assert.match(asset.text, /BLACKICE native inference/);
  const modelPath = path.resolve('qwen3-fp16');
  const loaded = await f.request('/api/native-inference/load', {
    method: 'POST', headers: f.auth, body: { backend: 'blackice', modelPath, maxContext: 64 },
  });
  assert.equal(loaded.status, 200);
  assert.equal(loaded.data.id, id);
  const generated = await f.request('/api/native-inference/generate', {
    method: 'POST', headers: f.auth, body: { id, prompt: 'Hello', maxTokens: 1 },
  });
  assert.equal(generated.status, 200);
  assert.deepEqual(generated.data.tokenIds, [21806]);
  const cancelled = await f.request('/api/native-inference/cancel', { method: 'POST', headers: f.auth, body: { id } });
  assert.equal(cancelled.status, 200);
  const unloaded = await f.request('/api/native-inference/unload', { method: 'POST', headers: f.auth, body: { id } });
  assert.equal(unloaded.status, 200);
  assert.deepEqual(calls.slice(0, 5).map(item => Array.isArray(item) ? item[0] : item),
    ['status', 'load', 'generate', 'cancel', 'unload']);
  await f.app.close();
  assert.ok(calls.includes('close'), 'BLACKICE shutdown must close native workers.');
});

test('server can cancel native generation while another HTTP request is pending', async t => {
  const pending = deferred(), started = deferred();
  const manager = {
    async status() { return { engines: [], sessions: [{ id, backend: 'blackice', status: 'running' }] }; },
    async generate({ signal }) { started.resolve(); return Promise.race([
      pending.promise,
      new Promise((_, reject) => signal?.addEventListener('abort',
        () => reject(Object.assign(new Error('Client disconnected.'), { code: 'ABORT_ERR' })), { once: true })),
    ]); },
    cancel(target) { pending.reject(Object.assign(new Error('Cancelled.'), { code: 'ABORT_ERR' })); return { id: target, cancellationRequested: true }; },
    async close() {},
  };
  const f = await fixture(t, manager);
  const running = f.request('/api/native-inference/generate', {
    method: 'POST', headers: f.auth, body: { id, prompt: 'Hi', maxTokens: 1 },
  });
  await started.promise;
  const cancelled = await f.request('/api/native-inference/cancel', {
    method: 'POST', headers: f.auth, body: { id },
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.cancellationRequested, true);
  const interrupted = await running;
  assert.equal(interrupted.status, 499);
  assert.equal(interrupted.data.code, 'ABORT_ERR');
});

const realModelDirectory = process.env.BLACKICE_QWEN3_ABLITERATED_FP16_DIR;
test('actual abliterated Qwen3 FP16 runs one token end-to-end over BLACKICE local HTTP',
  { skip: !realModelDirectory || !existsSync(path.join(realModelDirectory, 'model.safetensors')) },
  async t => {
    const manager = new BuiltinInferenceManager();
    const f = await fixture(t, manager);
    const loaded = await f.request('/api/native-inference/load', {
      method: 'POST', headers: f.auth,
      body: { backend: 'blackice', modelPath: realModelDirectory, maxContext: 64 },
    });
    assert.equal(loaded.status, 200);
    assert.deepEqual(loaded.data.sourcePrecision, ['F16']);
    const result = await f.request('/api/native-inference/generate', {
      method: 'POST', headers: f.auth,
      body: { id: loaded.data.id, prompt: 'Hello', maxTokens: 1 },
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.backend, 'blackice');
    assert.deepEqual(result.data.tokenIds, [21806]);
    assert.equal(result.data.text, ' Answer');
    assert.equal(result.data.completed, true);
    const unloaded = await f.request('/api/native-inference/unload', {
      method: 'POST', headers: f.auth, body: { id: loaded.data.id },
    });
    assert.equal(unloaded.status, 200);
    assert.equal(unloaded.data.unloaded, true);
  });
