import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ProviderRuntime } from '../lib/providers.mjs';
import { ProviderStore } from '../lib/provider-store.mjs';
import { providerPreviewHTTP } from '../lib/provider-setup-http.mjs';
import { createProviderSettings } from '../public/next/workspaces/settings-providers.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';

const pause = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(read) {
  for (let i = 0; i < 300; i++) { if (await read()) return; await pause(); }
  throw Error('Provider setup integration did not settle.');
}

class NoNativeGeneration extends EventEmitter {
  status() { return { connected: false, authenticated: false, models: [] }; }
  async start() { throw Error('Provider setup must not start a native model.'); }
  async runAgent() { throw Error('Provider setup must not generate a response.'); }
  async close() {}
}

test('provider setup discovers through the real HTTP transport, saves once, and survives a cold store reload', { timeout: 15000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-provider-add-integration-'));
  const syntheticKey = 'synthetic-integration-key', syntheticHeader = 'synthetic-integration-header';
  const requests = [], calls = [], vaultKey = randomBytes(32);
  const encryptSecret = plain => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', vaultKey, iv);
    return Buffer.concat([iv, cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  };
  const decryptSecret = encrypted => {
    const data = Buffer.from(encrypted), decipher = createDecipheriv('aes-256-gcm', vaultKey, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString();
  };
  const upstream = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, extraHeader: req.headers['x-fixture-key'] });
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'GET' || req.url !== '/v1/models') {
      res.writeHead(405); res.end(JSON.stringify({ error: { message: 'Only model discovery is available in this fixture.' } })); return;
    }
    if (req.headers.authorization !== `Bearer ${syntheticKey}` || req.headers['x-fixture-key'] !== syntheticHeader) {
      res.writeHead(401); res.end(JSON.stringify({ error: { message: 'Invalid fixture credentials.' } })); return;
    }
    res.end(JSON.stringify({ data: [{ id: 'current-model', name: 'Current model', context_length: 131072,
      top_provider: { max_completion_tokens: 16384 }, supported_parameters: ['tools'],
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } }] }));
  });
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  let panel, runtime;
  t.after(async () => {
    panel?.destroy();
    await runtime?.close();
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true });
  });
  runtime = await new ProviderRuntime({ codex: new NoNativeGeneration(), dataDir, encryptSecret, decryptSecret,
    modelLimitResolver: { async enrich(_config, models) { return models; } },
    fetchImpl: async (url, options) => { assert.equal(new URL(url).origin, origin, 'This integration never contacts a public service.'); return fetch(url, options); },
  }).init();
  await runtime.store.save({ id: 'existing', name: 'Existing connection', preset: 'compatible', type: 'compatible', baseUrl: `${origin}/existing`, models: [{ id: 'existing-model' }] });
  await runtime.setDefaultModel('existing::existing-model');
  const before = await readFile(runtime.store.file, 'utf8'), previousProviders = structuredClone(runtime.store.list());
  const dom = planningDOM(t), prototype = Object.getPrototypeOf(dom.mount), type = Object.getOwnPropertyDescriptor(prototype, 'type');
  Object.defineProperty(prototype, 'type', { get: type.get, set(value) { this.setAttribute('type', value); } });
  prototype.replaceChildren = function (...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.rawText = ''; this.markup = ''; this.append(...children); };
  const storage = { getItem() { throw Error('Credentials must not use browser storage.'); }, setItem() { throw Error('Credentials must not use browser storage.'); } };
  window.localStorage = storage; window.sessionStorage = storage;
  let changed = 0;
  const api = async (route, method = 'GET', body, options = {}) => {
    calls.push({ route, method });
    if (route === '/api/providers' && method === 'GET') return runtime.listProviders();
    if (route === '/api/providers/preview' && method === 'POST') {
      const response = await providerPreviewHTTP({ runtime, method, value: body, signal: options.signal });
      assert.equal(response.status, 200); assert.equal(response.body.modelAccessVerified, false);
      return response.body;
    }
    if (route === '/api/providers' && method === 'POST') return runtime.saveProvider(body);
    const models = /^\/api\/providers\/([^/]+)\/models$/.exec(route);
    if (models && method === 'POST') return runtime.discoverModels(decodeURIComponent(models[1]), { ...body, signal: options.signal });
    throw Error(`Unexpected setup integration API: ${method} ${route}`);
  };
  panel = createProviderSettings({ mount: dom.mount, api, getRuntimeSettings: () => ({ hiddenModelProviders: [] }), onChanged: () => { changed++; } });
  panel.enter(); await until(() => dom.$('[data-provider-id="existing"]'));
  await dom.click('#next-provider-new'); await dom.input('#next-provider-id', 'added'); await dom.input('#next-provider-name', 'New live connection');
  await dom.input('#next-provider-base-url', `${origin}/v1`); await dom.input('#next-provider-key', syntheticKey); await dom.input('#next-provider-headers', `X-Fixture-Key: ${syntheticHeader}`);
  await dom.click('#next-provider-test'); await until(() => dom.$('[data-provider-model-id="current-model"]'));
  assert.equal(await readFile(runtime.store.file, 'utf8'), before, 'Discovering a draft leaves the persisted store byte-for-byte unchanged.');
  assert.deepEqual(runtime.store.list(), previousProviders); assert.equal(changed, 0);
  assert.equal(calls.filter(call => call.route === '/api/providers' && call.method === 'POST').length, 0);
  assert.equal(dom.$('#next-provider-key').value, syntheticKey);
  const checkbox = dom.$('[data-provider-model-id="current-model"]'); checkbox.checked = true; await checkbox.dispatch('change');
  await dom.click('#next-provider-save'); await until(() => runtime.store.list().some(provider => provider.id === 'added' && provider.models.some(model => model.id === 'current-model')) && !dom.$('#next-provider-new').disabled);
  assert.equal(calls.filter(call => call.route === '/api/providers' && call.method === 'POST').length, 1);
  assert.equal(runtime.store.defaultModel, 'existing::existing-model'); assert.equal(runtime.store.key('added'), syntheticKey);
  assert.deepEqual(runtime.store.extraHeaders('added'), { 'X-Fixture-Key': syntheticHeader });
  assert.equal(dom.$('#next-provider-key').value, ''); assert.ok(requests.length >= 1);
  assert.ok(requests.every(request => request.method === 'GET' && request.url === '/v1/models'), 'Setup never generates a completion or tests a model.');
  const restored = new ProviderStore({ dataDir, encryptSecret, decryptSecret }); await restored.init();
  assert.equal(restored.defaultModel, 'existing::existing-model'); assert.equal(restored.key('added'), syntheticKey);
  assert.deepEqual(restored.extraHeaders('added'), { 'X-Fixture-Key': syntheticHeader });
  const selected = restored.get('added').models; assert.equal(selected.length, 1); assert.equal(selected[0].id, 'current-model');
  assert.equal(selected[0].supportsTools, true); assert.equal(selected[0].contextWindowTokens, 131072); assert.equal(selected[0].maxOutputTokens, 16384);
  assert.ok(selected[0].inputModalities.includes('image'));
  const persisted = await readFile(restored.file, 'utf8'); assert.equal(persisted.includes(syntheticKey), false); assert.equal(persisted.includes(syntheticHeader), false);
});
