import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';

class Runtime extends EventEmitter {
  constructor() { super(); this.calls = []; }
  status() { return { connected: false, authenticated: false, activeTurns: 0, models: [], defaultModel: 'unchanged-native' }; }
  async start() { return this.status(); }
  async close() {}
  async saveProvider() { assert.fail('A preview route cannot save a connection.'); }
  async setDefaultModel() { assert.fail('A preview route cannot change defaults.'); }
  async runAgent() { assert.fail('A preview route cannot generate.'); }
  async previewProvider(value, options) {
    this.calls.push({ value, signal: options.signal });
    if (this.failure) throw this.failure;
    return { providerId: value.connection.id, models: [], selectedModels: [], total: 0, totalModels: 0, returned: 0, offset: 0, hasMore: false, catalogAvailable: true, credentialVerified: false, modelAccessVerified: false, verification: 'catalog-only', groups: [] };
  }
}
class Capture extends Writable {
  constructor() { super(); this.headers = {}; this.parts = []; this.statusCode = 200; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  writeHead(status, headers = {}) { this.statusCode = status; for (const [name, value] of Object.entries(headers)) this.setHeader(name, value); this.headersSent = true; }
  _write(part, _encoding, done) { this.parts.push(Buffer.from(part)); done(); }
}
async function fixture(t, { real = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-preview-http-')), injected = new Runtime();
  const desktop = new EventEmitter(); desktop.status = () => ({ available: false, enabled: false }); desktop.setEnabled = async () => desktop.status();
  const app = await createHarnessServer({
    port: 0, ...(real ? {} : { runtime: injected }), mistralVibe: false, desktop,
    dataDir: path.join(directory, 'data'), defaultCwd: path.join(directory, 'workspace'),
    remoteAccess: false, autoAttachDesktop: false, emailExecutableHint: null,
  });
  t.after(async () => { app.endRestart(); app.endMaintenance(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  // Deliberately use the real request handler without listen(): no Codex startup.
  const handler = app.server.listeners('request')[0]; let cookie;
  const request = async (url, { body, headers = {}, authenticated = true, method = body === undefined ? 'GET' : 'POST' } = {}) => {
    const raw = body === undefined ? undefined : JSON.stringify(body), req = Readable.from(raw === undefined ? [] : [Buffer.from(raw)]);
    req.url = url; req.method = method; req.headers = { host: '127.0.0.1:0', ...(authenticated && cookie ? { cookie } : {}), ...(raw === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) }), ...headers };
    const res = new Capture(); await handler(req, res); const text = Buffer.concat(res.parts).toString();
    return { status: res.statusCode, data: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : text, headers: res.headers };
  };
  const home = await request('/'); cookie = home.headers['set-cookie'].split(';')[0];
  return { app, runtime: app.runtime, request };
}
const body = { connection: { id: 'unsaved', preset: 'compatible', type: 'compatible', baseUrl: 'https://fixture.example/v1', apiKey: 'synthetic-route-key' }, query: 'model', limit: 20 };

test('preview uses the existing owner-session and origin checks, passing the complete draft without saving', async t => {
  const { runtime, request } = await fixture(t), url = '/api/providers/preview';
  assert.equal((await request(url, { body, authenticated: false })).status, 401);
  assert.equal((await request(url, { body, headers: { origin: 'https://untrusted.example' } })).status, 403);
  assert.deepEqual(runtime.calls, []);
  const result = await request(url, { body });
  assert.equal(result.status, 200); assert.equal(result.data.providerId, 'unsaved'); assert.equal(result.data.credentialVerified, false);
  assert.equal(runtime.calls.length, 1); assert.deepEqual(runtime.calls[0].value, body); assert.ok(runtime.calls[0].signal instanceof AbortSignal);
  assert.equal(runtime.status().defaultModel, 'unchanged-native'); assert.equal(JSON.stringify(result.data).includes('synthetic-route-key'), false);
});

test('preview is an explicit POST route and preserves structured runtime failure status', async t => {
  const { runtime, request } = await fixture(t), url = '/api/providers/preview';
  for (const method of ['GET', 'DELETE']) assert.equal((await request(url, { method, ...(method === 'DELETE' ? { body: {} } : {}) })).status, 405);
  assert.equal(runtime.calls.length, 0);
  runtime.failure = Object.assign(new Error('The saved connection changed.'), { code: 'PROVIDER_CHANGED', status: 409 });
  const result = await request(url, { body });
  assert.equal(result.status, 409); assert.deepEqual(result.data, { error: 'The saved connection changed.', code: 'PROVIDER_CHANGED' });
});

test('the normal createHarnessServer runtime exposes live draft preview without a fixture runtime override', async t => {
  const { app, runtime, request } = await fixture(t, { real: true });
  assert.ok(runtime instanceof ProviderRuntime); assert.equal(typeof runtime.previewProvider, 'function');
  const requests = [];
  runtime.fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options }); assert.equal(options.method, 'GET');
    return new Response(JSON.stringify({ data: [{ id: 'model-current', supports_tools: true, context_length: 16384 }] }), { headers: { 'content-type': 'application/json' } });
  };
  runtime.codex.start = async () => assert.fail('Preview must not start Codex.');
  runtime.codex.runAgent = async () => assert.fail('Preview must not start generation.');
  await runtime.store.setDefaultModel('native-untouched');
  const before = await readFile(runtime.store.file, 'utf8');
  const result = await request('/api/providers/preview', { body });
  assert.equal(result.status, 200); assert.deepEqual(result.data.models.map(model => model.id), ['model-current']);
  assert.equal(result.data.models[0].contextWindowSource, 'provider-reported'); assert.equal(result.data.modelAccessVerified, false);
  assert.equal(requests.length, 1); assert.equal(requests[0].url, 'https://fixture.example/v1/models'); assert.equal(requests[0].options.headers.Authorization, 'Bearer synthetic-route-key');
  assert.equal(await readFile(runtime.store.file, 'utf8'), before); assert.equal(runtime.store.get('unsaved'), undefined);
  assert.equal(runtime.store.defaultModel, 'native-untouched'); assert.equal(app.server.listening, false);
});
