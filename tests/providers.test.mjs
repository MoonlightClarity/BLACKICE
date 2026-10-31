import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderRuntime, ProviderStore } from '../lib/providers.mjs';
import { BLACKICE_HARNESS_INSTRUCTIONS } from '../lib/harness-identity.mjs';

// Supplementary capacity lookup is covered by provider-model-fallback tests.
// Keep ordinary /models onboarding while isolating these generation/continuity fixtures.
const protocolModelLimitResolver = { enrich: async (_config, models) => models };

class FakeCodex extends EventEmitter {
  constructor(ready = true) { super(); this.ready = ready; this.calls = []; }
  status() { return { connected: this.ready, authenticated: this.ready, defaultModel: 'codex-model', models: [{ id: 'codex-model', model: 'codex-model', displayName: 'Codex test', supportedReasoningEfforts: [] }], activeTurns: 0, lastError: this.ready ? null : 'Codex offline' }; }
  async start() { if (!this.ready) throw new Error('Codex offline'); return this.status(); }
  async runAgent(options) { this.calls.push(options); return { output: 'Codex result', threadId: 'codex-thread', turnId: 'codex-turn' }; }
  async steerAgent(threadId, text) { return { accepted: true, threadId, text }; }
  async close() {}
}
const tool = { type: 'function', name: 'relay_observe', description: 'Observe a workspace fact.', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false } };
const sse = (response, events) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`); response.end(); };
const json = (response, data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function harness(t, handler, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'relay-providers-test-'));
  const { catalog = false, ...runtimeOptions } = options;
  const requests = [], catalogRequests = [], server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : null, record = { method: request.method, url: request.url, headers: request.headers, body };
      if (request.method === 'GET' && new URL(request.url, 'http://fixture').pathname.endsWith('/models')) {
        catalogRequests.push(record);
        // Model onboarding uses a real catalog GET without advancing a generation fixture's response sequence.
        if (!(typeof catalog === 'function' ? catalog(record) : catalog)) return json(response, { data: [] });
      }
      requests.push(record); await handler?.(record, response, requests.length);
    }
    catch (cause) { json(response, { error: { message: cause.message } }, 500); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const codex = runtimeOptions.codex || new FakeCodex();
  const runtime = await new ProviderRuntime({ modelLimitResolver: protocolModelLimitResolver, codex, dataDir, ...runtimeOptions }).init();
  t.after(async () => { await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.match(path.basename(dataDir), /^relay-providers-test-/); await rm(dataDir, { recursive: true, force: true }); });
  return { runtime, codex, dataDir, baseUrl, requests, catalogRequests, cwd: dataDir };
}
async function nativeCatalogHarness(t, codex = new FakeCodex()) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'relay-native-catalog-test-'));
  const runtime = await new ProviderRuntime({ modelLimitResolver: protocolModelLimitResolver, codex, dataDir }).init();
  t.after(async () => { await runtime.close(); assert.match(path.basename(dataDir), /^relay-native-catalog-test-/); await rm(dataDir, { recursive: true, force: true }); });
  return { runtime, codex, dataDir, cwd: dataDir };
}

test('custom Codex IDs join every native selection surface without claiming catalog access or changing defaults', async t => {
  const { runtime, codex, cwd, dataDir } = await nativeCatalogHarness(t), id = 'Vendor/Explicit.Model:preview', initial = runtime.status().defaultModelSelection;
  const nativeStatus = codex.status.bind(codex); let access = {};
  codex.status = () => ({ ...nativeStatus(), modelAccess: access });
  const catalog = await runtime.addCodexModel(id);
  assert.deepEqual(catalog.customModels, [id]); assert.equal(catalog.models.at(-1).source, 'custom'); assert.equal(catalog.models.at(-1).access.state, 'unverified');
  assert.equal(runtime.status().models.at(-1).model, id); assert.equal(runtime.status().defaultModelSelection, initial);
  await runtime.setDefaultModel(id); assert.equal(runtime.status().defaultModelAvailable, true, 'readiness permits a request while access remains unverified');
  await runtime.runAgent({ cwd, prompt: 'Use the explicit native ID.', model: 'default' }); assert.equal(codex.calls.at(-1).model, id);
  await runtime.runAgent({ cwd, prompt: 'Use the workflow model.', model: id }); assert.equal(codex.calls.at(-1).model, id);
  access = { [id]: { state: 'accepted', checkedAt: '2026-01-01T00:00:00.000Z', scope: 'current-connection' } };
  assert.equal(runtime.codexModelCatalog().models.at(-1).access.state, 'accepted');
  access = { [id]: { state: 'failed', outcome: 'failed' } }; assert.equal(runtime.resolveModel(id).available, true, 'last failure does not invent a permanent access ban');
  const restored = await new ProviderRuntime({ modelLimitResolver: protocolModelLimitResolver, codex, dataDir }).init(); t.after(() => restored.close());
  assert.equal(restored.status().defaultModelSelection, id); assert.equal(restored.status().defaultModelAvailable, true); assert.deepEqual(restored.status().customCodexModels, [id]);
  await runtime.removeCodexModel(id); assert.equal(runtime.status().defaultModelSelection, id); assert.equal(runtime.status().defaultModelAvailable, false); assert.equal(runtime.status().models.some(model => model.id === id), false);
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Do not substitute a fallback.', model: 'default' }), { code: 'PROVIDER_UNAVAILABLE' });
});

test('custom Codex registrations deduplicate advertised aliases and remain saved when the catalog changes', async t => {
  const { runtime, codex } = await nativeCatalogHarness(t), nativeStatus = codex.status.bind(codex); let listed = true;
  codex.status = () => ({ ...nativeStatus(), models: listed ? [{ id: 'picker-id', model: 'wire-id', hidden: true }] : [] });
  await runtime.addCodexModel('wire-id'); await runtime.addCodexModel('picker-id');
  assert.equal(runtime.codexModelCatalog().models.length, 1); assert.equal(runtime.codexModelCatalog().models[0].source, 'advertised');
  assert.deepEqual(runtime.codexModelCatalog().customModels, ['wire-id', 'picker-id']);
  await runtime.setDefaultModel('wire-id'); listed = false;
  assert.equal(runtime.status().defaultModelSelection, 'wire-id'); assert.equal(runtime.status().defaultModelAvailable, true);
  assert.deepEqual(runtime.status().models.map(model => model.id), ['wire-id', 'picker-id']);
  codex.ready = false; assert.equal(runtime.status().defaultModelAvailable, false); assert.match(runtime.status().defaultModelError, /Codex offline/);
});

test('Codex remains the default and receives unchanged options and events', async t => {
  const { runtime, codex, cwd } = await harness(t);
  const received = []; runtime.on('event', event => received.push(event));
  const result = await runtime.runAgent({ cwd, prompt: 'Use Codex.', model: 'codex-model', developerInstructions: BLACKICE_HARNESS_INSTRUCTIONS });
  assert.equal(result.output, 'Codex result'); assert.equal(codex.calls.length, 1);
  assert.equal(codex.calls[0].developerInstructions, BLACKICE_HARNESS_INSTRUCTIONS);
  codex.emit('event', { type: 'delta', delta: 'forwarded' });
  assert.deepEqual(received, [{ type: 'delta', delta: 'forwarded' }]);
  assert.equal(runtime.resolveModel('default').providerId, 'codex');
});

test('provider configuration survives restart, keys use the injected vault, and every public view is redacted', async t => {
  const secret = 'test-key-do-not-persist-123456789';
  const vault = { encryptSecret: value => Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`), decryptSecret: value => Buffer.from(String(value).slice(7), 'base64').toString() };
  const { runtime, dataDir, baseUrl } = await harness(t, null, vault);
  const saved = await runtime.saveProvider({ id: 'cloud', type: 'openai', name: 'Cloud', baseUrl, apiKey: secret, models: ['model-a'] });
  assert.equal(saved.hasApiKey, true); assert.equal(saved.secretStorage, 'encrypted');
  assert.ok(!JSON.stringify(runtime.status()).includes(secret));
  const disk = await readFile(path.join(dataDir, 'providers.json'), 'utf8'); assert.ok(!disk.includes(secret)); assert.ok(!disk.includes('apiKey'));
  const restored = await new ProviderStore({ dataDir, ...vault }); await restored.init();
  assert.equal(restored.key('cloud'), secret); assert.equal(restored.list()[0].hasApiKey, true);
  await runtime.saveProvider({ id: 'cloud', name: 'Renamed' }); assert.equal(runtime.store.key('cloud'), secret);
  await runtime.saveProvider({ id: 'cloud', apiKey: '' }); assert.equal(runtime.listProviders()[0].hasApiKey, false);
  assert.equal(runtime.store.redact(`Old key ${secret}`), 'Old key [redacted]');
});

test('plain-server keys remain session-only and a configured local model is the offline Codex fallback', async t => {
  const { runtime, dataDir, baseUrl } = await harness(t, null, { codex: new FakeCodex(false) });
  await runtime.saveProvider({ id: 'local', type: 'compatible', baseUrl, models: ['local-model:latest'] });
  await runtime.saveProvider({ id: 'remote', type: 'openai', baseUrl, apiKey: 'session-only-secret', models: ['remote-model'] });
  assert.equal(runtime.status().defaultModel, 'local::local-model:latest'); assert.equal(runtime.resolveModel().available, false, 'automatic admission waits until its initial choice is durable');
  assert.equal(runtime.status().secretStorage, 'session'); assert.equal(runtime.listProviders()[1].secretStorage, 'session');
  assert.ok(!(await readFile(path.join(dataDir, 'providers.json'), 'utf8')).includes('session-only-secret'));
  const restored = await new ProviderStore({ dataDir }); await restored.init(); assert.equal(restored.key('remote'), '');
  assert.equal((await runtime.start()).connected, true);
  assert.equal(runtime.resolveModel().available, true);
});

test('an explicit API default is durable, drives real requests, and never silently falls back after disable or removal', async t => {
  const vault = { encryptSecret: value => Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`), decryptSecret: value => Buffer.from(String(value).slice(7), 'base64').toString() };
  const { runtime, baseUrl, cwd, dataDir, codex, requests } = await harness(t, (request, response) => json(response, { choices: [{ message: { role: 'assistant', content: 'Saved API default.' }, finish_reason: 'stop' }] }), vault);
  await runtime.saveProvider({ id: 'chosen', type: 'compatible', baseUrl, models: ['chosen-model'] });
  const saved = await runtime.setDefaultModel('chosen::chosen-model'); assert.equal(saved.defaultModelSelection, 'chosen::chosen-model'); assert.equal(saved.defaultModelAvailable, true);
  assert.equal((await runtime.runAgent({ cwd, prompt: 'Use my default.' })).output, 'Saved API default.'); assert.equal(requests[0].body.model, 'chosen-model'); assert.equal(codex.calls.length, 0);
  const restored = await new ProviderRuntime({ modelLimitResolver: protocolModelLimitResolver, codex: new FakeCodex(), dataDir, ...vault }).init(); t.after(() => restored.close());
  assert.equal(restored.status().defaultModel, 'chosen::chosen-model'); assert.equal(restored.resolveModel('default').providerId, 'chosen');
  await restored.saveProvider({ id: 'chosen', enabled: false });
  assert.equal(restored.status().defaultModelSelection, 'chosen::chosen-model'); assert.equal(restored.status().defaultModelAvailable, false); assert.match(restored.status().defaultModelError, /disabled/);
  await assert.rejects(restored.runAgent({ cwd, prompt: 'Do not choose another provider.' }), { code: 'PROVIDER_UNAVAILABLE' }); assert.equal(requests.length, 1);
  await restored.removeProvider('chosen'); assert.equal(restored.status().defaultModelSelection, 'chosen::chosen-model'); assert.equal(restored.resolveModel().available, false);
  assert.match(restored.status().defaultModelError, /no longer configured/);
  await restored.setDefaultModel('codex'); assert.equal(restored.status().defaultModelSource, 'explicit'); assert.equal(restored.resolveModel().providerId, 'codex');
  await restored.setDefaultModel(null); assert.equal(restored.status().defaultModelSource, 'automatic');
});

test('native defaults forward the selected Codex model and unavailable explicit Codex never falls back to an API', async t => {
  const { runtime, codex, baseUrl, cwd } = await harness(t);
  const status = codex.status.bind(codex); codex.status = () => ({ ...status(), models: [...status().models, { id: 'second-codex', model: 'second-codex' }] });
  await runtime.saveProvider({ id: 'local', type: 'compatible', baseUrl, models: ['local-model'] });
  await runtime.setDefaultModel('second-codex'); await runtime.runAgent({ cwd, prompt: 'Use selected native model.', model: 'default' });
  assert.equal(codex.calls[0].model, 'second-codex');
  await runtime.setDefaultModel('codex'); codex.ready = false;
  assert.equal(runtime.resolveModel().providerId, 'codex'); assert.equal(runtime.status().defaultModelAvailable, false);
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Keep my native choice.' }), { code: 'PROVIDER_UNAVAILABLE' }); assert.equal(codex.calls.length, 1);
  await runtime.setDefaultModel('default'); assert.equal(runtime.resolveModel().providerId, 'local');
});

test('native defaults accept distinct catalog IDs and routing model names without rewriting the saved choice', async t => {
  const { runtime, codex, cwd, dataDir } = await nativeCatalogHarness(t);
  const status = codex.status.bind(codex);
  let listed = true, authenticated = true;
  codex.status = () => ({ ...status(), authenticated: codex.ready && authenticated, models: [...status().models, ...(listed ? [{ id: 'catalog-secondary', model: 'wire-secondary' }] : [])] });
  for (const selected of ['catalog-secondary', 'wire-secondary']) {
    const saved = await runtime.setDefaultModel(selected);
    assert.equal(saved.defaultModelSelection, selected);
    assert.equal(saved.defaultModel, selected);
    assert.equal(saved.defaultModelAvailable, true);
    assert.equal(runtime.resolveModel('default').available, true);
    assert.equal(runtime.resolveModel(selected).model, selected);
    await runtime.runAgent({ cwd, prompt: 'Use precisely my selected native model.', model: 'default' });
    assert.equal(codex.calls.at(-1).model, selected, 'selection validation must not replace the routing identifier');
    assert.equal(JSON.parse(await readFile(path.join(dataDir, 'providers.json'), 'utf8')).defaultModel, selected);
  }
  const restored = await new ProviderRuntime({ modelLimitResolver: protocolModelLimitResolver, codex, dataDir }).init(); t.after(() => restored.close());
  assert.equal(restored.status().defaultModelSelection, 'wire-secondary');
  assert.equal(restored.status().defaultModelAvailable, true, 'an existing canonical default remains available after restart');
  listed = false;
  assert.equal(restored.status().defaultModelAvailable, false);
  assert.match(restored.status().defaultModelError, /no longer listed/);
  codex.ready = false;
  assert.match(restored.status().defaultModelError, /Codex offline/);
  codex.ready = true; authenticated = false;
  assert.match(restored.status().defaultModelError, /Sign in/);
  assert.equal(restored.status().defaultModelSelection, 'wire-secondary', 'readiness changes do not replace the saved default');
});

test('a saved Codex default stays unavailable when no native default is reported while explicit hidden choices remain usable', async t => {
  const { runtime, codex, cwd, dataDir } = await nativeCatalogHarness(t), nativeStatus = codex.status.bind(codex);
  let defaultModel = null;
  codex.status = () => ({ ...nativeStatus(), defaultModel, models: [{ id: 'hidden-alias', model: 'hidden-wire', hidden: true, available: true }] });
  assert.equal(runtime.automaticCandidate(), null, 'a hidden catalog row is not an automatic default');
  await runtime.setDefaultModel('codex');
  assert.equal(runtime.status().defaultModelSelection, 'codex'); assert.equal(runtime.status().defaultModel, null); assert.equal(runtime.status().defaultModelAvailable, false);
  assert.match(runtime.status().defaultModelError, /did not report a default model.*Choose a specific listed Codex model/);
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Do not choose an implicit hidden model.', model: 'default' }), { code: 'PROVIDER_UNAVAILABLE' });
  assert.equal(codex.calls.length, 0);
  for (const selected of ['hidden-alias', 'hidden-wire']) {
    await runtime.setDefaultModel(selected); assert.equal(runtime.status().defaultModelAvailable, true);
    await runtime.runAgent({ cwd, prompt: 'Use the explicitly selected hidden model.', model: 'default' }); assert.equal(codex.calls.at(-1).model, selected);
  }
  await runtime.setDefaultModel('codex');
  const restored = await new ProviderRuntime({ modelLimitResolver: protocolModelLimitResolver, codex, dataDir }).init(); t.after(() => restored.close());
  assert.equal(restored.status().defaultModelSelection, 'codex'); assert.equal(restored.status().defaultModelAvailable, false);
  codex.ready = false; assert.match(restored.status().defaultModelError, /Codex offline/); codex.ready = true;
  defaultModel = 'hidden-wire';
  assert.equal(restored.status().defaultModelAvailable, true, 'an explicitly reported upstream default is respected');
  assert.equal(restored.status().defaultModelSelection, 'codex', 'catalog changes never replace the saved preference');
});

test('explicit Codex reconnect requests a fresh catalog while ordinary startup and API defaults remain independent', async t => {
  const codex = new FakeCodex(), status = codex.status.bind(codex), starts = [];
  let refreshed = false, refreshFailure = false;
  codex.status = () => ({ ...status(), models: [...status().models, ...(refreshed ? [{ id: 'new-native', model: 'new-native' }] : [])] });
  codex.start = async options => {
    starts.push(options);
    if (options?.refresh) {
      if (refreshFailure) throw Object.assign(new Error('Catalog refresh is temporarily unavailable.'), { code: 'CODEX_TIMEOUT' });
      refreshed = true;
    }
    return codex.status();
  };
  const { runtime } = await nativeCatalogHarness(t, codex);
  await runtime.setDefaultModel('codex-model');
  await runtime.start();
  assert.deepEqual(starts, [undefined]);
  assert.equal(runtime.status().codex.models.length, 1);
  const updated = await runtime.start({ connectCodex: true });
  assert.deepEqual(starts, [undefined, { refresh: true }]);
  assert.equal(updated.codex.models.length, 2);
  assert.equal(updated.defaultModelSelection, 'codex-model');
  await runtime.saveProvider({ id: 'independent', type: 'compatible', baseUrl: 'http://127.0.0.1:1/v1', models: ['api-model'] });
  await runtime.setDefaultModel('independent::api-model');
  await runtime.start();
  assert.equal(starts.length, 2, 'ordinary API startup does not contact Codex');
  refreshFailure = true;
  await assert.rejects(runtime.start({ connectCodex: true }), { code: 'CODEX_TIMEOUT' });
  assert.deepEqual(starts.at(-1), { refresh: true });
  assert.equal(runtime.status().defaultModelSelection, 'independent::api-model');
  assert.equal(runtime.status().defaultModelAvailable, true);
  assert.equal(runtime.status().codex.models.length, 2, 'a failed refresh keeps the last successful native catalog');
});

test('new defaults must be listed or saved and a removed saved model remains visibly unavailable', async t => {
  const { runtime, baseUrl } = await harness(t); await runtime.saveProvider({ id: 'local', type: 'compatible', baseUrl, models: ['saved-model'] });
  for (const value of ['unknown-native', 'missing::model', 'local::unknown']) await assert.rejects(runtime.setDefaultModel(value), { code: 'INVALID_DEFAULT_MODEL' });
  for (const value of ['', undefined, 'bad model', 'local::a::b']) await assert.rejects(runtime.setDefaultModel(value));
  assert.equal(runtime.status().defaultModelSelection, null);
  await runtime.setDefaultModel('local::saved-model'); await runtime.saveProvider({ id: 'local', models: [] });
  assert.equal(runtime.status().defaultModelSelection, 'local::saved-model'); assert.equal(runtime.status().defaultModelAvailable, false); assert.match(runtime.status().defaultModelError, /no longer/);
});

test('an explicit API default starts and runs without starting or waiting for Codex', async t => {
  const codex = new FakeCodex(false); let nativeStarts = 0;
  codex.start = async () => { nativeStarts++; throw new Error('Native runtime deliberately unavailable.'); };
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response) => json(response, { choices: [{ message: { role: 'assistant', content: 'Independent API generation.' }, finish_reason: 'stop' }] }), { codex });
  await runtime.saveProvider({ id: 'independent', type: 'compatible', baseUrl, models: ['model'] });
  await runtime.setDefaultModel('independent::model');
  const started = await runtime.start();
  assert.equal(started.defaultModel, 'independent::model'); assert.equal(started.defaultModelAvailable, true); assert.equal(started.codex.connected, false); assert.equal(nativeStarts, 0);
  assert.equal((await runtime.runAgent({ cwd, prompt: 'Use the API default.', model: 'default' })).output, 'Independent API generation.');
  assert.equal(nativeStarts, 0); assert.equal(codex.calls.length, 0); assert.equal(requests.length, 1);
  await assert.rejects(runtime.start({ connectCodex: true }),/Native runtime deliberately unavailable/);
  assert.equal(nativeStarts, 1, 'explicit reconnect surfaces its own failure'); assert.equal(runtime.status().defaultModel, 'independent::model');
});

test('native disconnection during an API turn neither aborts it nor changes its chosen provider', async t => {
  const arrived = deferred(), release = deferred();
  const { runtime, codex, baseUrl, cwd, requests } = await harness(t, async (request, response) => { arrived.resolve(); await release.promise; json(response, { choices: [{ message: { role: 'assistant', content: 'API turn survived native disconnection.' }, finish_reason: 'stop' }] }); });
  await runtime.saveProvider({ id: 'independent', type: 'compatible', baseUrl, models: ['model'] }); await runtime.setDefaultModel('independent::model');
  const turn = runtime.runAgent({ cwd, prompt: 'Finish on this API.', model: 'default' });
  await arrived.promise;
  try {
    codex.ready = false; codex.emit('status', codex.status());
    assert.equal(runtime.status().connected, true); assert.equal(runtime.status().defaultModel, 'independent::model'); assert.equal(runtime.active.size, 1);
  } finally { release.resolve(); }
  assert.equal((await turn).output, 'API turn survived native disconnection.');
  assert.equal(codex.calls.length, 0); assert.equal(requests.length, 1);
});

test('initial automatic selection waits for native startup and stays pinned when native readiness changes', async t => {
  const codex = new FakeCodex(false), entered = deferred(), release = deferred(); let nativeStarts = 0;
  codex.start = async () => { nativeStarts++; entered.resolve(); await release.promise; codex.ready = true; return codex.status(); };
  const { runtime, baseUrl, dataDir } = await harness(t, null, { codex });
  await runtime.saveProvider({ id: 'local', type: 'compatible', baseUrl, models: ['local-model'] });
  assert.equal(runtime.store.automaticDefaultModel, null);
  const started = runtime.start(); await entered.promise;
  runtime.status(); runtime.resolveModel('default');
  assert.equal(runtime.store.automaticDefaultModel, null, 'status reads cannot persist a premature API fallback');
  assert.equal(runtime.resolveModel().available, false, 'default admission cannot pin a provisional fallback before native startup settles');
  assert.equal(runtime.resolveModel('local::local-model').available, true, 'explicit per-chat choices remain usable during initial selection');
  await runtime.saveProvider({ id: 'local', name: 'Edited while native starts' });
  assert.equal(runtime.store.automaticDefaultModel, null, 'editing a saved connection does not bypass an in-flight initial startup');
  release.resolve(); await started;
  assert.equal(nativeStarts, 1); assert.equal(runtime.status().automaticDefaultModel, 'codex-model'); assert.equal(runtime.status().defaultModelSource, 'automatic'); assert.equal(runtime.status().defaultModelSelection, null);
  codex.ready = false;
  assert.equal(runtime.resolveModel().providerId, 'codex'); assert.equal(runtime.resolveModel().available, false);
  const restored = await new ProviderRuntime({ modelLimitResolver: protocolModelLimitResolver, codex: new FakeCodex(false), dataDir }).init(); t.after(() => restored.close());
  assert.equal(restored.status().automaticDefaultModel, 'codex-model'); assert.equal(restored.status().defaultModelAvailable, false);
  await assert.rejects(restored.start(), /Codex offline/);
  assert.equal(restored.resolveModel().providerId, 'codex', 'a saved automatic selection never silently falls back');
});

test('a provider added after an unsuccessful initial setup can become the durable automatic default', async t => {
  const { runtime, baseUrl } = await harness(t, null, { codex: new FakeCodex(false) });
  await assert.rejects(runtime.start(), /Codex offline/);
  await runtime.saveProvider({ id: 'first-local', type: 'compatible', baseUrl, models: ['model'] });
  assert.equal(runtime.store.automaticDefaultModel, 'first-local::model'); assert.equal(runtime.status().defaultModelAvailable, true);
  await runtime.saveProvider({ id: 'another', type: 'compatible', baseUrl, models: ['new-model'] });
  assert.equal(runtime.store.automaticDefaultModel, 'first-local::model');
});

test('initial Automatic selection skips a disabled first connection in favor of a configured usable provider', async t => {
  const { runtime, baseUrl } = await harness(t, null, { codex: new FakeCodex(false) });
  await runtime.saveProvider({ id: 'disabled-first', type: 'compatible', baseUrl, models: ['disabled-model'], enabled: false });
  await runtime.saveProvider({ id: 'enabled-second', type: 'compatible', baseUrl, models: ['enabled-model'] });
  assert.equal(runtime.listProviders()[0].configured, false);
  await runtime.start();
  assert.equal(runtime.status().automaticDefaultModel, 'enabled-second::enabled-model'); assert.equal(runtime.status().defaultModelAvailable, true);
  assert.equal(runtime.resolveModel().providerId, 'enabled-second');
});

test('an initial API fallback persists across native recovery, restart and provider unavailability', async t => {
  const codex = new FakeCodex(false);
  const { runtime, baseUrl, dataDir, cwd } = await harness(t, (request, response) => json(response, { choices: [{ message: { role: 'assistant', content: 'Pinned API result.' }, finish_reason: 'stop' }] }), { codex });
  await runtime.saveProvider({ id: 'first', type: 'compatible', baseUrl, models: ['first-model'] });
  await runtime.saveProvider({ id: 'second', type: 'compatible', baseUrl, models: ['second-model'] });
  await runtime.start(); assert.equal(runtime.status().automaticDefaultModel, 'first::first-model');
  codex.ready = true;
  assert.equal(runtime.resolveModel().providerId, 'first'); assert.equal(runtime.status().defaultModelSource, 'automatic');
  const restoredCodex = new FakeCodex(); let starts = 0; restoredCodex.start = async () => { starts++; return restoredCodex.status(); };
  const restored = await new ProviderRuntime({ modelLimitResolver: protocolModelLimitResolver, codex: restoredCodex, dataDir }).init(); t.after(() => restored.close());
  await restored.start(); assert.equal(starts, 0); assert.equal(restored.resolveModel().providerId, 'first');
  await restored.saveProvider({ id: 'first', enabled: false });
  assert.equal(restored.status().defaultModel, 'first::first-model'); assert.equal(restored.status().defaultModelAvailable, false);
  await assert.rejects(restored.runAgent({ cwd, prompt: 'Do not silently send this elsewhere.' }), { code: 'PROVIDER_UNAVAILABLE' });
  await restored.removeProvider('first');
  assert.equal(restored.resolveModel().providerId, 'first'); assert.equal(restored.resolveModel().available, false);
  await restored.setDefaultModel(null);
  await restored.start();
  assert.equal(restored.status().automaticDefaultModel, 'codex-model', 'choosing Automatic again explicitly requests a fresh initial selection');
});

test('concurrent default admissions share one durable automatic selection and pass its concrete model to native turns', async t => {
  const codex = new FakeCodex(false), entered = deferred(), release = deferred(); let nativeStarts = 0;
  codex.start = async () => { nativeStarts++; entered.resolve(); await release.promise; codex.ready = true; return codex.status(); };
  const { runtime, cwd, dataDir } = await harness(t, null, { codex });
  const first = runtime.runAgent({ cwd, prompt: 'First automatic chat.', model: 'default' });
  const second = runtime.runAgent({ cwd, prompt: 'Second automatic chat.', model: 'default' });
  await entered.promise; assert.equal(nativeStarts, 1); release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(codex.calls.map(call => call.model), ['codex-model', 'codex-model']);
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'providers.json'), 'utf8')).automaticDefaultModel, 'codex-model');
});

test('a user default chosen during initial native startup wins over automatic selection', async t => {
  const codex = new FakeCodex(false), entered = deferred(), release = deferred();
  codex.start = async () => { entered.resolve(); await release.promise; codex.ready = true; return codex.status(); };
  const { runtime, baseUrl } = await harness(t, null, { codex });
  await runtime.saveProvider({ id: 'chosen', type: 'compatible', baseUrl, models: ['model'] });
  const started = runtime.start(); await entered.promise;
  await runtime.setDefaultModel('chosen::model'); release.resolve(); await started;
  assert.equal(runtime.status().defaultModel, 'chosen::model'); assert.equal(runtime.store.automaticDefaultModel, null); assert.equal(runtime.status().defaultModelSource, 'explicit');
});

test('OpenRouter discovery is separate from key verification and actual chat completion uses Bearer authentication', async t => {
  const secret = 'fixture-openrouter-private-key';
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response) => {
    if (request.url.endsWith('/key')) return json(response, { data: { is_free_tier: false, label: secret, is_management_key: false } });
    if (request.url.endsWith('/models')) return json(response, { data: [{ id: 'vendor/agent-model', name: 'Agent model', context_length: 900000, top_provider: { max_completion_tokens: 32000 }, supported_parameters: ['tools', 'tool_choice'], architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } }] });
    return json(response, { choices: [{ message: { role: 'assistant', content: 'OpenRouter adapter worked.' }, finish_reason: 'stop' }] });
  }, { catalog: true });
  let provider = await runtime.saveProvider({ id: 'router', preset: 'openrouter', baseUrl, models: [] });
  assert.equal(provider.type, 'compatible'); assert.equal(provider.requiresApiKey, true); assert.equal(provider.configured, false);
  const catalog = await runtime.discoverModels('router'); assert.equal(catalog.models[0].supportsTools, true); assert.equal(catalog.models[0].contextWindowTokens, 900000); assert.equal(catalog.models[0].maxOutputTokens, 32000);
  await assert.rejects(runtime.testProvider('router'), { code: 'PROVIDER_KEY_REQUIRED' }); assert.equal(requests.length, 1, 'a public catalog is not an authentication check');
  provider = await runtime.saveProvider({ id: 'router', apiKey: secret, models: catalog.models }); assert.equal(provider.configured, true);
  const checked = await runtime.testProvider('router'); assert.equal(checked.credentialVerified, true); assert.equal(checked.modelAccessVerified, false); assert.equal(checked.verification, 'credentials-and-catalog');
  assert.deepEqual(requests.slice(1).map(request => request.url), ['/v1/key', '/v1/models']); assert.ok(requests.slice(1).every(request => request.headers.authorization === `Bearer ${secret}`));
  assert.ok(!JSON.stringify(checked).includes(secret)); assert.ok(!JSON.stringify(runtime.status()).includes(secret));
  await runtime.setDefaultModel('router::vendor/agent-model');
  assert.equal((await runtime.runAgent({ cwd, prompt: 'Run through OpenRouter.' })).output, 'OpenRouter adapter worked.');
  assert.equal(requests.at(-1).url, '/v1/chat/completions'); assert.equal(requests.at(-1).headers.authorization, `Bearer ${secret}`); assert.equal(requests.at(-1).body.model, 'vendor/agent-model');
  assert.equal(requests.at(-1).headers['http-referer'], 'http://localhost:4317');
  assert.equal(requests.at(-1).headers['x-openrouter-title'], 'BLACKICE');
  assert.equal(requests.at(-1).headers['x-openrouter-categories'], 'personal-agent');
  assert.equal(requests.at(-1).headers['x-openrouter-app-visibility'], 'hidden');
});

test('Inkling harness-only denial is classified as a model restriction rather than bad OpenRouter credentials', async t => {
  const secret='fixture-router-key-not-for-output';
  const { runtime, baseUrl, cwd, requests }=await harness(t,(request,response)=>{
    if (request.body?.model === 'thinkingmachines/inkling:free') {
      return json(response,{error:{message:'thinkingmachines/inkling:free is only available on agentic harnesses. Try plugging it into a coding agent or productivity app listed on https://openrouter.ai/apps'}},403);
    }
    return json(response,{choices:[{message:{role:'assistant',content:'OpenRouter sibling works.'},finish_reason:'stop'}]});
  });
  await runtime.saveProvider({id:'router',preset:'openrouter',baseUrl,apiKey:secret,models:['thinkingmachines/inkling:free','vendor/other']});
  await assert.rejects(runtime.runAgent({cwd,model:'router::thinkingmachines/inkling:free',prompt:'Harmless access check.'}),
    cause => cause.code==='PROVIDER_HARNESS_RESTRICTED' && /restricted to eligible agentic harnesses/.test(cause.message) && /not an API-key failure/.test(cause.message) && !/Check this connection.*account permissions/.test(cause.message) && !cause.message.includes(secret));
  const provider=runtime.listProviders().find(item=>item.id==='router');
  assert.equal(provider.lastFailure,undefined);
  assert.equal(provider.modelChecks['thinkingmachines/inkling:free'].lastFailure.code,'PROVIDER_HARNESS_RESTRICTED');
  assert.equal(provider.modelChecks['thinkingmachines/inkling:free'].lastFailure.scope,'model');
  const result=await runtime.runAgent({cwd,model:'router::vendor/other',prompt:'Respond with a short answer.'});
  assert.equal(result.output,'OpenRouter sibling works.');
  assert.equal(requests.length,2);
  assert.equal(requests[1].headers['x-openrouter-title'],'BLACKICE');
});

test('OpenRouter rejects invalid, expired and management keys without exposing private key details', async t => {
  let keyData = { is_free_tier: false, is_management_key: true };
  const secret = 'fixture-private-rejected-router-key';
  const { runtime, baseUrl, requests } = await harness(t, (request, response) => keyData.error ? json(response, keyData, 401) : json(response, { data: keyData }));
  await runtime.saveProvider({ id: 'router', preset: 'openrouter', baseUrl, apiKey: secret, models: ['vendor/model'] });
  await assert.rejects(runtime.testProvider('router'), { code: 'PROVIDER_KEY_REQUIRED' });
  keyData = { is_free_tier: false, expires_at: '2000-01-01T00:00:00Z' }; await assert.rejects(runtime.testProvider('router'), { code: 'PROVIDER_KEY_REQUIRED' });
  keyData = { error: { message: `Rejected ${secret}` } }; await assert.rejects(runtime.testProvider('router'), cause => !cause.message.includes(secret));
  assert.ok(requests.every(request => request.url.endsWith('/key'))); assert.ok(!JSON.stringify(runtime.status()).includes(secret));
});

test('large provider catalogs are searched and paged without selecting or silently discarding models after 200', async t => {
  const models = Array.from({ length: 605 }, (_, index) => ({ id: `vendor/model-${index}`, name: `Model ${index}`, supported_parameters: index % 2 ? ['tools'] : ['max_tokens'] }));
  const { runtime, baseUrl, requests } = await harness(t, (request, response) => json(response, { data: models }), { catalog: true });
  await runtime.saveProvider({ id: 'catalog', type: 'compatible', baseUrl, models: ['pinned-model'] });
  const first = await runtime.discoverModels('catalog'); assert.equal(first.models.length, 200); assert.equal(first.totalModels, 605); assert.equal(first.hasMore, true); assert.equal(first.truncated, true);
  const tail = await runtime.discoverModels('catalog', { offset: 600, limit: 100 }); assert.equal(tail.models.length, 5); assert.equal(tail.models.at(-1).id, 'vendor/model-604');
  const found = await runtime.discoverModels('catalog', { query: 'model-603', toolsOnly: true }); assert.equal(found.models[0].id, 'vendor/model-603');
  assert.equal((await runtime.discoverModels('catalog', { query: 'model-604', toolsOnly: true })).total, 0);
  assert.equal(requests.length, 1, 'searches use the bounded server catalog, not repeated network requests');
  assert.deepEqual(runtime.listProviders()[0].models.map(model => model.id), ['pinned-model']);
  await assert.rejects(runtime.discoverModels('catalog', { limit: 201 }), { code: 'INVALID_MODEL_SEARCH' });
  await assert.rejects(runtime.discoverModels('catalog', { query: 'x'.repeat(257) }), { code: 'INVALID_MODEL_SEARCH' });
});

for (const type of ['openai', 'anthropic', 'compatible']) test(`${type}: custom gateways preserve query parameters and write-only authentication headers`, async t => {
  const secret = 'gateway-only-private-token';
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response) => {
    if (request.url.includes('/models?')) return json(response, { data: [{ id: 'gateway-model' }] });
    const output = type === 'openai' ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Gateway result.' }] }] }
      : type === 'anthropic' ? { content: [{ type: 'text', text: 'Gateway result.' }], stop_reason: 'end_turn' }
        : { choices: [{ message: { role: 'assistant', content: 'Gateway result.' }, finish_reason: 'stop' }] };
    json(response, output);
  }, { catalog: true });
  const saved = await runtime.saveProvider({ id: 'gateway', preset: 'compatible', type, baseUrl: `${baseUrl}/tenant/?api-version=2026-01-01&region=west%2F`, headers: { authorization: `Bearer ${secret}`, 'X-Tenant': 'team-fixture', 'api-key': secret }, models: ['gateway-model'] });
  assert.equal(saved.configured, true); assert.equal(saved.requiresApiKey, false); assert.equal(saved.hasApiKey, false); assert.deepEqual(saved.headerNames.sort(), ['X-Tenant', 'api-key', 'authorization'].sort()); assert.equal(saved.hasHeaders, true); assert.ok(!JSON.stringify(saved).includes(secret));
  await runtime.testProvider('gateway'); const result = await runtime.runAgent({ cwd, prompt: 'Use the configured gateway.', model: 'gateway::gateway-model' }); assert.equal(result.output, 'Gateway result.');
  const suffix = type === 'openai' ? 'responses' : type === 'anthropic' ? 'messages' : 'chat/completions';
  assert.deepEqual(requests.map(request => request.url), [`/v1/tenant/models?api-version=2026-01-01&region=west%2F`, `/v1/tenant/models?api-version=2026-01-01&region=west%2F`, `/v1/tenant/${suffix}?api-version=2026-01-01&region=west%2F`]);
  assert.ok(requests.every(request => request.headers.authorization === `Bearer ${secret}` && request.headers['api-key'] === secret && request.headers['x-tenant'] === 'team-fixture'));
  assert.equal(runtime.store.redact(`Echo ${secret}`), 'Echo [redacted]'); assert.ok(!JSON.stringify(runtime.status()).includes(secret));
});

test('custom authentication headers override generated credentials case-insensitively without duplicating Authorization', async t => {
  const { runtime, baseUrl, requests } = await harness(t, (request, response) => json(response, { data: [] }), { catalog: true });
  await runtime.saveProvider({ id: 'override', preset: 'compatible', type: 'openai', baseUrl, apiKey: 'unused-standard-key-fixture', headers: { authorization: 'Bearer actual-gateway-key-fixture' } });
  await runtime.discoverModels('override'); assert.equal(requests[0].headers.authorization, 'Bearer actual-gateway-key-fixture');
});

for (const type of ['openai', 'anthropic', 'compatible']) {
  test(`${type}: real HTTP streaming, dynamic tools with screenshots, usage and durable follow-up`, async t => {
    const { runtime, dataDir, baseUrl, requests, cwd } = await harness(t, (request, response, step) => {
      const result = step === 1 ? 'Observed the workspace.' : step === 2 ? 'Verified result.' : 'Follow-up complete.';
      if (type === 'openai') {
        if (step === 1) sse(response, [{ type: 'response.output_item.done', item: { type: 'function_call', id: 'item-tool', call_id: 'call-a', name: 'relay_observe', arguments: '{"target":"workspace"}' } }, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 }, output: [{ type: 'function_call', id: 'item-tool', call_id: 'call-a', name: 'relay_observe', arguments: '{"target":"workspace"}' }] } }]);
        else sse(response, [{ type: 'response.output_text.delta', delta: result }, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 }, output: [{ type: 'message', id: `msg-${step}`, role: 'assistant', content: [{ type: 'output_text', text: result }] }] } }]);
      } else if (type === 'anthropic') {
        if (step === 1) sse(response, [{ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-a', name: 'relay_observe', input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"target":"workspace"}' } }, { type: 'message_delta', usage: { output_tokens: 3 }, delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }]);
        else sse(response, [{ type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: result } }, { type: 'message_delta', usage: { output_tokens: 4 }, delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]);
      } else {
        if (step === 1) sse(response, [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-a', function: { name: 'relay_observe', arguments: '{"target":' } }] } }] }, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"workspace"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }]);
        else sse(response, [{ choices: [{ index: 0, delta: { content: result } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } }]);
      }
    });
    await runtime.saveProvider({ id: 'test', type, baseUrl, apiKey: 'private-test-api-key', models: ['real-model'], maxSteps: 4 });
    const events = [], calls = [];
    const result = await runtime.runAgent({ cwd, prompt: 'Observe then report.', model: 'test::real-model', effort: 'max', dynamicTools: [tool], onEvent: event => events.push(event), onToolCall: async (call, context) => { calls.push(call); assert.equal(context.signal.aborted, false); return { success: true, contentItems: [{ type: 'inputText', text: 'The workspace exists.' }, { type: 'inputImage', imageUrl: 'data:image/png;base64,ZmFrZQ==' }] }; } });
    assert.equal(result.output, 'Verified result.'); assert.equal(result.usage.totalTokens, 37); assert.equal(calls.length, 1); assert.deepEqual(calls[0].arguments, { target: 'workspace' });
    assert.ok(events.some(event => event.type === 'delta' && event.delta === 'Verified result.'));
    assert.ok(events.some(event => event.type === 'thread' && event.effort === 'max')); assert.equal(result.effort, 'max');
    assert.ok(!JSON.stringify(events).includes('ZmFrZQ=='), 'screenshot bytes must not enter the run trace');
    assert.equal(requests[0].headers[type === 'anthropic' ? 'x-api-key' : 'authorization'], type === 'anthropic' ? 'private-test-api-key' : 'Bearer private-test-api-key');
    const requestText = JSON.stringify(requests[1].body); assert.ok(requestText.includes('ZmFrZQ==')); assert.ok(requestText.includes('call-a'));
    const restored = await new ProviderRuntime({ modelLimitResolver: protocolModelLimitResolver, codex: new FakeCodex(), dataDir }).init();
    await restored.saveProvider({ id: 'test', apiKey: 'private-test-api-key' });
    const followup = await restored.runAgent({ cwd, prompt: 'Continue with the previous observation.', model: 'test::real-model', threadId: result.threadId });
    assert.equal(followup.threadId, result.threadId); assert.equal(followup.output, 'Follow-up complete.'); assert.equal(followup.usage.totalTokens, 24); assert.equal(followup.usage.total.totalTokens, 61);
    assert.equal(followup.effort, 'max');
    for (const request of requests) assert.equal(type === 'openai' ? request.body.reasoning?.effort : type === 'anthropic' ? request.body.output_config?.effort : request.body.reasoning_effort, 'max', 'tool steps and restored threads must retain the selected effort');
    assert.ok(JSON.stringify(requests[2].body).includes('Observe then report.')); assert.ok(JSON.stringify(requests[2].body).includes('Verified result.'));
    const files = await readdir(path.join(dataDir, 'provider-threads')); assert.equal(files.length, 1);
    await restored.close();
  });
}

for (const type of ['openai', 'anthropic', 'compatible']) test(`${type}: returned tool failures retain their code for diagnostics and revision recovery`, async t => {
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response, step) => {
    if (type === 'openai') return json(response, { status: 'completed', output: step === 1
      ? [{ type: 'function_call', call_id: 'conflict', name: 'relay_task', arguments: JSON.stringify({ action: 'plan', expectedRevision: 1, steps: [] }) }]
      : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The update was rejected; read the latest state.' }] }] });
    if (type === 'anthropic') return json(response, { content: step === 1
      ? [{ type: 'tool_use', id: 'conflict', name: 'relay_task', input: { action: 'plan', expectedRevision: 1, steps: [] } }]
      : [{ type: 'text', text: 'The update was rejected; read the latest state.' }], stop_reason: step === 1 ? 'tool_use' : 'end_turn' });
    return json(response, { choices: [{ message: step === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'conflict', type: 'function', function: { name: 'relay_task', arguments: JSON.stringify({ action: 'plan', expectedRevision: 1, steps: [] }) } }] }
      : { role: 'assistant', content: 'The update was rejected; read the latest state.' }, finish_reason: step === 1 ? 'tool_calls' : 'stop' }] });
  });
  await runtime.saveProvider({ id: 'conflict', type, baseUrl, apiKey: 'conflict-fixture-only', models: ['model'] });
  const events = [];
  await runtime.runAgent({ cwd, prompt: 'Try the revision-guarded update.', model: 'conflict::model', dynamicTools: [{ ...tool, name: 'relay_task' }], onEvent: event => events.push(event), onToolCall: async () => ({ success: false, code: 'TASK_STATE_CONFLICT', status: 409, currentRevision: 2, contentItems: [{ type: 'inputText', text: 'Read the latest state (revision 2) before updating it.' }] }) });
  const receipt = events.find(event => event.type === 'tool.result');
  assert.equal(receipt.success, false); assert.equal(receipt.code, 'TASK_STATE_CONFLICT'); assert.ok(receipt.recoveryKey);
  assert.match(receipt.message, /revision 2/); assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1].body), /revision 2/);
});

test('cancellation aborts an in-flight HTTP request promptly and returns an AbortError', async t => {
  const arrived = deferred();
  const { runtime, baseUrl, cwd } = await harness(t, () => arrived.resolve());
  await runtime.saveProvider({ id: 'slow', type: 'compatible', baseUrl, models: ['slow-model'] });
  const controller = new AbortController(); const pending = runtime.runAgent({ cwd, prompt: 'Wait.', model: 'slow::slow-model', signal: controller.signal });
  await arrived.promise; controller.abort();
  await assert.rejects(pending, cause => cause.code === 'ABORT_ERR' && cause.name === 'AbortError');
  assert.equal(runtime.active.size, 0);
});

test('timeouts and tool-step limits stop the loop without claiming completion', async t => {
  const { runtime, baseUrl, cwd } = await harness(t, (request, response) => json(response, { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-repeat', type: 'function', function: { name: 'relay_observe', arguments: '{"target":"again"}' } }] }, finish_reason: 'tool_calls' }], usage: { total_tokens: 2 } }));
  await runtime.saveProvider({ id: 'loop', type: 'compatible', baseUrl, models: ['loop'], maxSteps: 2 });
  let calls = 0;
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Loop.', model: 'loop::loop', dynamicTools: [tool], onToolCall: async () => { calls++; return { success: true, contentItems: [{ type: 'inputText', text: 'Done.' }] }; } }), cause => cause.code === 'PROVIDER_STEP_LIMIT');
  assert.equal(calls, 2);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Already cancelled.', model: 'loop::loop', signal: controller.signal }), cause => cause.code === 'ABORT_ERR');
});

test('new API connections run past the former 24-step default while an explicit budget still stops work', async t => {
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response, index) => json(response, index <= 27 ? { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `step-${index}`, type: 'function', function: { name: 'relay_observe', arguments: '{"target":"again"}' } }] }, finish_reason: 'tool_calls' }] } : { choices: [{ message: { role: 'assistant', content: 'Finished the actual sequence.' }, finish_reason: 'stop' }] }));
  const saved = await runtime.saveProvider({ id: 'unlimited', type: 'compatible', baseUrl, models: ['model'] });
  assert.equal(saved.maxSteps, null); let calls = 0;
  const result = await runtime.runAgent({ cwd, prompt: 'Complete a longer sequence.', model: 'unlimited::model', dynamicTools: [tool], onToolCall: async () => { calls++; return { success: true, contentItems: [{ type: 'inputText', text: 'Confirmed.' }] }; } });
  assert.equal(result.output, 'Finished the actual sequence.'); assert.equal(calls, 27); assert.equal(requests.length, 28);
});

test('a failed per-tool checkpoint stops the next side effect and saves only confirmed results on recovery', async t => {
  const calls = [1, 2].map(index => ({ id: `checkpoint-${index}`, type: 'function', function: { name: 'relay_observe', arguments: JSON.stringify({ target: `effect-${index}` }) } }));
  const { runtime, baseUrl, cwd } = await harness(t, (_request, response) => json(response, { choices: [{ message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }] }));
  await runtime.saveProvider({ id: 'checkpoint', type: 'compatible', baseUrl, models: ['model'] });
  const persist = runtime.persistThread.bind(runtime); let failed = false, handled = 0, threadId;
  runtime.persistThread = async record => { if (!failed && record.pendingToolResults?.length === 1) { failed = true; throw Error('Fixture checkpoint write failed.'); } return persist(record); };
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Checkpoint failure fixture.', model: 'checkpoint::model', dynamicTools: [tool], onEvent: event => { if (event.type === 'thread') threadId = event.threadId; }, onToolCall: async () => { handled++; return { success: true, contentItems: [{ type: 'inputText', text: 'First side effect confirmed.' }] }; } }), /checkpoint write failed/);
  assert.equal(failed, true); assert.equal(handled, 1, 'a missing checkpoint must prevent starting the next side effect');
  const saved = await runtime.readThread(threadId), results = saved.messages.filter(item => item.role === 'tool');
  assert.equal(results.length, 2); assert.match(results[0].content, /First side effect confirmed/); assert.match(results[1].content, /interrupted before its result/);
  assert.equal(saved.pendingToolCalls, undefined); assert.equal(saved.pendingToolResults, undefined);
});

for (const type of ['openai', 'anthropic', 'compatible']) {
  test(`${type}: a real process crash preserves each confirmed tool result without replaying its side effect`, async t => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'relay-batch-crash-')), script = path.join(dataDir, 'crash-agent.mjs'), effect = path.join(dataDir, 'effect.txt');
    const calls = [1, 2].map(index => ({ id: `call-${index}`, name: 'relay_observe', arguments: { target: `side-effect-${index}` } }));
    const batch = type === 'openai' ? { status: 'completed', output: calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) })) } : type === 'anthropic' ? { content: calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })), stop_reason: 'tool_use' } : { choices: [{ message: { role: 'assistant', content: null, tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }, finish_reason: 'tool_calls' }] };
    await writeFile(script, `import {ProviderRuntime} from ${JSON.stringify(new URL('../lib/providers.mjs', import.meta.url).href)};import{writeFile}from'node:fs/promises';import{EventEmitter}from'node:events';const codex=new EventEmitter();codex.status=()=>({connected:false,authenticated:false,models:[]});codex.close=async()=>{};const runtime=await new ProviderRuntime({modelLimitResolver:{enrich:async(_config,models)=>models},codex,dataDir:${JSON.stringify(dataDir)},fetchImpl:async(_url,options)=>new Response(options.method==='GET'?JSON.stringify({data:[]}):${JSON.stringify(JSON.stringify(batch))},{headers:{'content-type':'application/json'}})}).init();await runtime.saveProvider({id:'crash',type:${JSON.stringify(type)},baseUrl:'http://127.0.0.1:1/v1',apiKey:'crash-fixture-key',models:['model']});await runtime.runAgent({cwd:${JSON.stringify(dataDir)},prompt:'Crash fixture only.',model:'crash::model',dynamicTools:[${JSON.stringify(tool)}],onToolCall:async call=>{if(call.arguments.target==='side-effect-1'){await writeFile(${JSON.stringify(effect)},'1');return{success:true,contentItems:[{type:'inputText',text:'First side effect confirmed.'}]};}process.stdout.write('SECOND_TOOL_PENDING\\n');await new Promise(()=>{});}});`);
    const child = spawn(process.execPath, [script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise(resolve => child.once('exit', resolve)); let stderr = '', killed = false;
    child.stderr.on('data', chunk => { stderr += chunk; });
    t.after(async () => { if (!killed) child.kill('SIGKILL'); await exited; assert.match(path.basename(dataDir), /^relay-batch-crash-/); await rm(dataDir, { recursive: true, force: true }); });
    await new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(Error(`Crash fixture did not reach its second tool. ${stderr}`)), 15000);
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('SECOND_TOOL_PENDING')) { clearTimeout(timer); resolve(); } });
      child.once('error', cause => { clearTimeout(timer); reject(cause); });
      child.once('exit', code => { clearTimeout(timer); if (!output.includes('SECOND_TOOL_PENDING')) reject(Error(`Crash fixture exited early (${code}). ${stderr}`)); });
    });
    child.kill('SIGKILL'); killed = true; await exited;
    const files = await readdir(path.join(dataDir, 'provider-threads')); assert.equal(files.length, 1);
    const saved = JSON.parse(await readFile(path.join(dataDir, 'provider-threads', files[0]), 'utf8'));
    assert.equal(await readFile(effect, 'utf8'), '1'); assert.equal(saved.pendingToolCalls.length, 2);
    assert.equal(saved.pendingToolResults.length, 1); assert.equal(saved.pendingToolResults[0].call.id, 'call-1'); assert.equal(saved.pendingToolResults[0].result.success, true);
    let request, replayed = 0;
    const codex = new FakeCodex(false), final = type === 'openai' ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Recovered.' }] }] } : type === 'anthropic' ? { content: [{ type: 'text', text: 'Recovered.' }], stop_reason: 'end_turn' } : { choices: [{ message: { role: 'assistant', content: 'Recovered.' }, finish_reason: 'stop' }] };
    const restored = await new ProviderRuntime({ modelLimitResolver: protocolModelLimitResolver, codex, dataDir, fetchImpl: async (_url, options) => { if (options.method === 'GET') return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } }); request = JSON.parse(options.body); return new Response(JSON.stringify(final), { headers: { 'content-type': 'application/json' } }); } }).init();
    t.after(() => restored.close()); await restored.saveProvider({ id: 'crash', apiKey: 'crash-fixture-key' });
    const result = await restored.runAgent({ cwd: dataDir, prompt: 'Resume from confirmed receipts.', model: 'crash::model', threadId: saved.id, dynamicTools: [tool], onToolCall: async () => { replayed++; throw Error('A saved tool must not be replayed.'); } });
    assert.equal(result.output, 'Recovered.'); assert.equal(replayed, 0); assert.equal(await readFile(effect, 'utf8'), '1');
    const results = type === 'openai' ? request.input.filter(item => item.type === 'function_call_output') : type === 'anthropic' ? request.messages.flatMap(item => Array.isArray(item.content) ? item.content.filter(block => block.type === 'tool_result') : []) : request.messages.filter(item => item.role === 'tool');
    assert.equal(results.length, 2); assert.match(JSON.stringify(results[0]), /First side effect confirmed/); assert.doesNotMatch(JSON.stringify(results[0]), /before this tool result was confirmed/); assert.match(JSON.stringify(results[1]), /before this tool result was confirmed/);
    const committed = await restored.readThread(saved.id); assert.equal(committed.pendingToolCalls, undefined); assert.equal(committed.pendingToolResults, undefined);
  });
}

test('unknown tool names are returned as tool failures and cannot invoke handlers', async t => {
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response, index) => json(response, index === 1 ? { content: [{ type: 'tool_use', id: 'unknown', name: 'not_attached', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } } : { content: [{ type: 'text', text: 'Recovered.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  await runtime.saveProvider({ id: 'tools', type: 'anthropic', baseUrl, apiKey: 'local-key-unknown-tool', models: ['model'] });
  let invoked = false;const events=[];
  const result = await runtime.runAgent({ cwd, prompt: 'Use attached tools.', model: 'tools::model', dynamicTools: [tool], onEvent:event=>events.push(event), onToolCall: async () => { invoked = true; } });
  assert.equal(result.output, 'Recovered.'); assert.equal(invoked, false);
  assert.equal(requests[1].body.messages[2].content[0].is_error, true);
  assert.equal(events.find(event=>event.type==='tool.result').success,false);assert.match(events.find(event=>event.type==='tool.result').message,/not attached|Unknown tool/i);
});

test('provider discovery and errors never reveal API keys, and discovery uses the selected endpoint', async t => {
  const secret = 'test-secret-echo-1234567890';
  const { runtime, baseUrl, requests } = await harness(t, (request, response, index) => index === 1 ? json(response, { data: [{ id: 'model-a' }, { id: 'model-b', name: 'Model B' }] }) : json(response, { error: { message: `Rejected ${secret} and Bearer leaked-token` } }, 401), { catalog: true });
  await runtime.saveProvider({ id: 'discover', type: 'openai', baseUrl, apiKey: secret, models: [] });
  const result = await runtime.testProvider('discover'); assert.equal(result.ok, true); assert.equal(result.models.length, 2); assert.equal(requests[0].url, '/v1/models');
  await assert.rejects(runtime.testProvider('discover'), cause => !cause.message.includes(secret) && !cause.message.includes('leaked-token'));
  assert.ok(!JSON.stringify(runtime.status()).includes(secret)); assert.ok(!JSON.stringify(runtime.status()).includes('leaked-token'));
});

test('live directions are queued into the same persisted conversation at the next model boundary', async t => {
  const arrived = deferred(); let firstResponse;
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response, index) => {
    if (index === 1) { firstResponse = response; arrived.resolve(); }
    else json(response, { choices: [{ message: { role: 'assistant', content: 'Direction incorporated.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } });
  });
  await runtime.saveProvider({ id: 'steer', type: 'compatible', baseUrl, models: ['model'] });
  let threadId;
  const pending = runtime.runAgent({ cwd, prompt: 'Start.', model: 'steer::model', onEvent: event => { threadId ||= event.threadId; } });
  await arrived.promise; const receipt = await runtime.steerAgent(threadId, 'Focus on verification.'); assert.equal(receipt.queued, true);
  json(firstResponse, { choices: [{ message: { role: 'assistant', content: 'Initial response.' }, finish_reason: 'stop' }], usage: { total_tokens: 1 } });
  assert.equal((await pending).output, 'Direction incorporated.');
  assert.equal(requests[1].body.messages.at(-1).content, 'Focus on verification.');
  await assert.rejects(runtime.steerAgent(threadId, 'Too late.'), cause => cause.code === 'TURN_NOT_ACTIVE');
});

test('configuration rejects credential-bearing URLs and plaintext encryption adapters', async t => {
  const { runtime, baseUrl } = await harness(t, null, { encryptSecret: key => key, decryptSecret: key => key });
  await assert.rejects(runtime.saveProvider({ id: 'bad', type: 'openai', baseUrl: 'https://user:secret@example.com/v1', models: ['model'] }), /no credentials/);
  await assert.rejects(runtime.saveProvider({ id: 'bad', type: 'openai', baseUrl, apiKey: 'example-secret-for-adapter', models: ['model'] }), /plaintext/);
  assert.equal(runtime.listProviders().length, 0);
});

test('a provider time limit aborts stalled transport without a completion event', async t => {
  const { runtime, baseUrl, cwd } = await harness(t, () => {});
  await runtime.saveProvider({ id: 'timeout', type: 'compatible', baseUrl, models: ['model'] });
  const events = [];
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Wait for the provider.', model: 'timeout::model', timeoutMs: 30, onEvent: event => events.push(event) }), cause => cause.code === 'PROVIDER_TIMEOUT');
  assert.ok(!events.some(event => event.type === 'turn' && event.status === 'completed'));
  assert.equal(runtime.active.size, 0);
});

for (const type of ['openai', 'anthropic', 'compatible']) test(`${type}: completion markers finish the reply even when the SSE socket remains open`, async t => {
  const disconnected = deferred();
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response) => {
    response.on('close', () => disconnected.resolve(true));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const events = type === 'openai'
      ? [{ type: 'response.output_text.delta', delta: 'Confirmed reply.' }, { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Confirmed reply.' }] }], usage: { input_tokens: 3, output_tokens: 2 } } }]
      : type === 'anthropic'
        ? [{ type: 'message_start', message: { usage: { input_tokens: 3 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Confirmed reply.' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }]
        : [{ choices: [{ index: 0, delta: { content: 'Confirmed reply.' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }];
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    if (type === 'compatible') response.write('data: [DONE]\n\n');
    // A gateway may keep its event stream alive after protocol completion.
  });
  await runtime.saveProvider({ id: 'terminal', type, baseUrl, apiKey: 'private-terminal-stream-fixture', models: ['model'] });
  const events = [];
  const result = await runtime.runAgent({ cwd, prompt: 'Finish when the protocol completes.', model: 'terminal::model', timeoutMs: 300, onEvent: event => events.push(event) });
  assert.equal(result.output, 'Confirmed reply.'); assert.equal(result.usage.totalTokens, 5); assert.equal(requests.length, 1);
  assert.ok(events.some(event => event.type === 'turn' && event.status === 'completed'));
  assert.equal(await Promise.race([disconnected.promise, new Promise(resolve => setTimeout(() => resolve(false), 300))]), true, 'the completed request must release its own HTTP stream');
});

for (const type of ['openai', 'anthropic', 'compatible']) test(`${type}: cancelling an abort-ignoring SSE transport closes only its reader and preserves parallel work`, async t => {
  const partial = deferred(), slowClosed = deferred(), healthyArrived = deferred(), controller = new AbortController(); let healthyResponse;
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response) => {
    if (request.body.model === 'healthy') { healthyResponse = response; healthyArrived.resolve(); return; }
    response.on('close', () => slowClosed.resolve(true));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const events = type === 'openai' ? [{ type: 'response.output_text.delta', delta: 'Partial reply kept.' }]
      : type === 'anthropic' ? [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial reply kept.' } }]
        : [{ choices: [{ index: 0, delta: { content: 'Partial reply kept.' } }] }];
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  }, { fetchImpl: (url, { signal, ...options }) => fetch(url, options) });
  await runtime.saveProvider({ id: 'cancelstream', type, baseUrl, apiKey: 'private-stream-cancellation-fixture', models: ['slow', 'healthy'] });
  const events = [];
  const stopped = runtime.runAgent({ cwd, prompt: 'Read until stopped.', model: 'cancelstream::slow', signal: controller.signal, onEvent: event => { events.push(event); if (event.type === 'delta') partial.resolve(); } });
  stopped.catch(() => {}); await partial.promise;
  const healthy = runtime.runAgent({ cwd, prompt: 'Continue independently.', model: 'cancelstream::healthy' });
  healthy.catch(() => {}); await healthyArrived.promise;
  controller.abort(); await assert.rejects(stopped, { code: 'ABORT_ERR', name: 'AbortError' });
  assert.equal(await Promise.race([slowClosed.promise, new Promise(resolve => setTimeout(() => resolve(false), 300))]), true, 'Stop must release the body even when fetch ignores abort');
  assert.equal(runtime.active.size, 1); assert.equal([...runtime.active.values()][0].record.model, 'healthy');
  assert.ok(events.some(event => event.type === 'delta' && event.delta === 'Partial reply kept.')); assert.ok(!events.some(event => event.type === 'turn' && event.status === 'completed'));
  json(healthyResponse, type === 'openai'
    ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Parallel reply finished.' }] }] }
    : type === 'anthropic' ? { content: [{ type: 'text', text: 'Parallel reply finished.' }], stop_reason: 'end_turn' }
      : { choices: [{ message: { content: 'Parallel reply finished.' }, finish_reason: 'stop' }] });
  assert.equal((await healthy).output, 'Parallel reply finished.'); assert.equal(requests.length, 2); assert.equal(runtime.active.size, 0);
  assert.equal(runtime.listProviders()[0].lastFailure, null, 'a user cancellation is not a provider health failure');
});

test('cancellation during a batched stream stops subsequent buffered events and never executes returned tools', async t => {
  const controller = new AbortController(); let tools = 0;
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write([
      { choices: [{ index: 0, delta: { content: 'First partial.' } }] },
      { choices: [{ index: 0, delta: { content: 'Must not arrive after Stop.' } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'after-stop', function: { name: 'relay_observe', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
  });
  await runtime.saveProvider({ id: 'batchstop', type: 'compatible', baseUrl, models: ['model'] });
  const events = [];
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Stop on the first partial.', model: 'batchstop::model', signal: controller.signal, dynamicTools: [tool], onToolCall: async () => { tools++; return { success: true, contentItems: [] }; }, onEvent: event => { events.push(event); if (event.type === 'delta' && event.delta === 'First partial.') controller.abort(); } }), { code: 'ABORT_ERR' });
  assert.deepEqual(events.filter(event => event.type === 'delta').map(event => event.delta), ['First partial.']);
  assert.equal(tools, 0); assert.equal(requests.length, 1); assert.equal(runtime.active.size, 0);
});

test('cancellation inside a dynamic tool leaves paired results that can be resumed safely', async t => {
  const started = deferred(), controller = new AbortController();
  const { runtime, baseUrl, cwd, dataDir, requests } = await harness(t, (request, response, index) => json(response, index === 1 ? { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'interrupted-call', type: 'function', function: { name: 'relay_observe', arguments: '{"target":"workspace"}' } }] }, finish_reason: 'tool_calls' }], usage: { total_tokens: 2 } } : { choices: [{ message: { role: 'assistant', content: 'Resumed safely.' }, finish_reason: 'stop' }], usage: { total_tokens: 2 } }));
  await runtime.saveProvider({ id: 'canceltool', type: 'compatible', baseUrl, models: ['model'] });
  let threadId;
  const pending = runtime.runAgent({ cwd, prompt: 'Observe.', model: 'canceltool::model', signal: controller.signal, dynamicTools: [tool], onEvent: event => { threadId ||= event.threadId; }, onToolCall: async (call, context) => { started.resolve(); await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true })); throw Object.assign(new Error('Observation interrupted before confirmation.'), { code: 'ABORT_ERR', name: 'AbortError' }); } });
  await started.promise; controller.abort(); await assert.rejects(pending, cause => cause.code === 'ABORT_ERR');
  const record = JSON.parse(await readFile(path.join(dataDir, 'provider-threads', `${threadId}.json`), 'utf8'));
  assert.equal(record.messages.at(-1).role, 'tool'); assert.match(record.messages.at(-1).content, /interrupted/); assert.equal(record.pendingToolCalls, undefined);
  const resumed = await runtime.runAgent({ cwd, prompt: 'Inspect the current state before continuing.', model: 'canceltool::model', threadId });
  assert.equal(resumed.output, 'Resumed safely.'); assert.equal(requests[1].body.messages.filter(message => message.tool_call_id === 'interrupted-call').length, 1);
});

for (const type of ['openai', 'anthropic', 'compatible']) {
  test(`${type}: an unfinished JSON reply cannot complete a turn or execute tools`, async t => {
    const payload = type === 'openai'
      ? { status: 'in_progress', output: [{ type: 'function_call', call_id: 'unfinished', name: 'relay_observe', arguments: '{"target":"workspace"}' }] }
      : type === 'anthropic'
        ? { content: [{ type: 'tool_use', id: 'unfinished', name: 'relay_observe', input: { target: 'workspace' } }], stop_reason: null }
        : { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'unfinished', type: 'function', function: { name: 'relay_observe', arguments: '{"target":"workspace"}' } }] }, finish_reason: null }] };
    const { runtime, baseUrl, cwd } = await harness(t, (request, response) => json(response, payload), { maxSteps: 1 });
    await runtime.saveProvider({ id: 'unfinished', type, baseUrl, apiKey: 'private-unfinished-key', models: ['model'] });
    const events = []; let calls = 0;
    await assert.rejects(runtime.runAgent({ cwd, prompt: 'Observe.', model: 'unfinished::model', dynamicTools: [tool], onEvent: event => events.push(event), onToolCall: async () => { calls++; return { success: true, contentItems: [{ type: 'inputText', text: 'Fixture result.' }] }; } }), { code: 'PROVIDER_PROTOCOL' });
    assert.equal(calls, 0); assert.ok(!events.some(event => event.type === 'turn' && event.status === 'completed'));
  });

  test(`${type}: an HTTP 200 error envelope is a failure and its key is redacted`, async t => {
    const secret = 'private-json-envelope-key';
    const { runtime, baseUrl, cwd } = await harness(t, (request, response) => json(response, { error: { message: `Provider rejected ${secret}` } }));
    await runtime.saveProvider({ id: 'envelope', type, baseUrl, apiKey: secret, models: ['model'] });
    const events = [];
    await assert.rejects(runtime.runAgent({ cwd, prompt: 'Respond.', model: 'envelope::model', onEvent: event => events.push(event) }), cause => cause.code === 'PROVIDER_ERROR' && !cause.message.includes(secret));
    assert.ok(!events.some(event => event.type === 'turn' && event.status === 'completed'));
  });

  test(`${type}: a truncated stream is an error even after readable text was received`, async t => {
    const { runtime, baseUrl, cwd } = await harness(t, (request, response) => sse(response, type === 'openai' ? [{ type: 'response.output_text.delta', delta: 'Partial text.' }] : type === 'anthropic' ? [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial text.' } }] : [{ choices: [{ index: 0, delta: { content: 'Partial text.' } }] }]));
    await runtime.saveProvider({ id: 'partial', type, baseUrl, apiKey: 'private-partial-stream-key', models: ['model'] });
    const events = [];
    await assert.rejects(runtime.runAgent({ cwd, prompt: 'Respond.', model: 'partial::model', onEvent: event => events.push(event) }), cause => cause.code === 'PROVIDER_PROTOCOL');
    assert.ok(events.some(event => event.type === 'delta' && event.delta === 'Partial text.'));
    assert.ok(!events.some(event => event.type === 'turn' && event.status === 'completed'));
  });
}

test('active provider edits are rejected and a pending edit cannot mix a new key with the old endpoint', async t => {
  const encryptionStarted = deferred(), releaseEncryption = deferred(), toolStarted = deferred(), releaseTool = deferred();
  t.after(() => { releaseEncryption.resolve(); releaseTool.resolve(); });
  const oldKey = 'old-private-provider-key', newKey = 'new-private-provider-key';
  const vault = { encryptSecret: async value => { if (value === newKey) { encryptionStarted.resolve(); await releaseEncryption.promise; } return Buffer.from(`sealed:${value}`); }, decryptSecret: value => String(value).slice(7) };
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response, index) => json(response, index === 1 ? { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'observe', type: 'function', function: { name: 'relay_observe', arguments: '{"target":"workspace"}' } }] }, finish_reason: 'tool_calls' }] } : { choices: [{ message: { role: 'assistant', content: 'Completed on the original connection.' }, finish_reason: 'stop' }] }), vault);
  await runtime.saveProvider({ id: 'editing', type: 'compatible', baseUrl, apiKey: oldKey, models: ['model'] });
  const before = structuredClone(runtime.store.get('editing'));
  // The delayed edit must recheck activity after encryption and before commit.
  const editing = runtime.saveProvider({ id: 'editing', baseUrl: `${baseUrl}/new-endpoint`, apiKey: newKey });
  let pending;
  try {
    await encryptionStarted.promise;
    pending = runtime.runAgent({ cwd, prompt: 'Observe.', model: 'editing::model', dynamicTools: [tool], onToolCall: async () => { toolStarted.resolve(); await releaseTool.promise; return { success: true, contentItems: [{ type: 'inputText', text: 'Observed.' }] }; } });
    await toolStarted.promise;
    await assert.rejects(runtime.saveProvider({ id: 'editing', name: 'Cannot edit during work' }), cause => cause.code === 'PROVIDER_BUSY');
    releaseEncryption.resolve();
    await assert.rejects(editing, { code: 'PROVIDER_BUSY' });
    assert.deepEqual(runtime.store.get('editing'), before, 'a rejected delayed edit must preserve the saved connection');
    assert.equal(runtime.store.key('editing'), oldKey);
  } finally {
    releaseEncryption.resolve(); releaseTool.resolve();
  }
  assert.equal((await pending).output, 'Completed on the original connection.');
  assert.deepEqual(requests.map(request => request.url), ['/v1/chat/completions', '/v1/chat/completions']);
  assert.deepEqual(requests.map(request => request.headers.authorization), [`Bearer ${oldKey}`, `Bearer ${oldKey}`]);
  await runtime.saveProvider({ id: 'editing', baseUrl: `${baseUrl}/new-endpoint`, apiKey: newKey });
  assert.equal(runtime.store.key('editing'), newKey, 'an explicit retry may update the idle provider');
  assert.equal(runtime.store.get('editing').baseUrl, `${baseUrl}/new-endpoint`);
});

test('a saved conversation rejects a provider protocol change before sending its transcript', async t => {
  const { runtime, baseUrl, cwd, requests, dataDir } = await harness(t, (request, response) => json(response, { choices: [{ message: { role: 'assistant', content: 'Saved conversation.' }, finish_reason: 'stop' }], usage: { total_tokens: 2 } }));
  await runtime.saveProvider({ id: 'protocol', type: 'compatible', baseUrl, models: ['model'] });
  const result = await runtime.runAgent({ cwd, prompt: 'Create a conversation.', model: 'protocol::model' });
  const record = JSON.parse(await readFile(path.join(dataDir, 'provider-threads', `${result.threadId}.json`), 'utf8'));
  assert.equal(record.providerType, 'compatible');
  await runtime.saveProvider({ id: 'protocol', type: 'anthropic', apiKey: 'new-protocol-private-key' });
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Continue.', threadId: result.threadId, model: 'protocol::model' }), cause => cause.code === 'THREAD_MISMATCH');
  assert.equal(requests.length, 1, 'incompatible transcript must not be sent to the provider');
});

test('a native conversation never silently ignores an explicitly selected API provider', async t => {
  const { runtime, codex, baseUrl, cwd } = await harness(t);
  await runtime.saveProvider({ id: 'api', type: 'compatible', baseUrl, models: ['model'] });
  await runtime.setDefaultModel('api::model');
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Use the API.', threadId: 'native-thread', model: 'api::model' }), { code: 'THREAD_MISMATCH' });
  assert.equal(codex.calls.length, 0);
  await runtime.runAgent({ cwd, prompt: 'Continue the saved native chat.', threadId: 'native-thread' });
  assert.equal(codex.calls.length, 1, 'a changed app default must not migrate an existing native chat');
  assert.equal(codex.calls[0].threadId, 'native-thread');
});

test('saved API conversations bind the endpoint across edits, removal and restart', async t => {
  const { runtime, codex, baseUrl, cwd, requests, dataDir } = await harness(t, (request, response) => json(response, { choices: [{ message: { role: 'assistant', content: 'Confirmed original endpoint.' }, finish_reason: 'stop' }] }));
  await runtime.saveProvider({ id: 'endpoint', type: 'compatible', baseUrl, models: ['model'] });
  const first = await runtime.runAgent({ cwd, prompt: 'Private conversation at the chosen endpoint.', model: 'endpoint::model' });
  const recordFile = path.join(dataDir, 'provider-threads', `${first.threadId}.json`), savedRecord = await readFile(recordFile, 'utf8');
  assert.equal(JSON.parse(savedRecord).providerBaseUrl, baseUrl);
  await runtime.saveProvider({ id: 'endpoint', baseUrl: `${baseUrl}/another-gateway` });
  const continuation = { cwd, prompt: 'Continue.', threadId: first.threadId, model: 'endpoint::model' };
  await assert.rejects(runtime.runAgent(continuation), { code: 'THREAD_MISMATCH' });
  await assert.rejects(runtime.compactThread(first.threadId), { code: 'THREAD_MISMATCH' });
  assert.equal(await readFile(recordFile, 'utf8'), savedRecord, 'rejected continuation must not edit the original history');
  const restored = await new ProviderRuntime({ modelLimitResolver: protocolModelLimitResolver, codex, dataDir }).init(); t.after(() => restored.close());
  await assert.rejects(restored.runAgent(continuation), { code: 'THREAD_MISMATCH' });
  await restored.removeProvider('endpoint');
  await restored.saveProvider({ id: 'endpoint', type: 'compatible', baseUrl: `${baseUrl}/replacement`, models: ['model'] });
  await assert.rejects(restored.runAgent(continuation), { code: 'THREAD_MISMATCH' });
  assert.equal(requests.length, 1, 'no old transcript may reach the replacement endpoint');
  const newChat = await restored.runAgent({ cwd, prompt: 'New conversation on the chosen replacement.', model: 'endpoint::model' });
  assert.notEqual(newChat.threadId, first.threadId); assert.equal(requests.length, 2); assert.equal(requests[1].url, '/v1/replacement/chat/completions');
  await restored.saveProvider({ id: 'endpoint', baseUrl });
  const continued = await restored.runAgent(continuation);
  assert.equal(continued.threadId, first.threadId); assert.equal(requests.length, 3);
});

for (const fixture of [
  { status: 401, code: 'PROVIDER_AUTH', detail: { message: 'Invalid authentication.' }, action: /API key or authentication headers/ },
  { status: 403, code: 'PROVIDER_ACCESS', detail: { message: 'Model access denied.' }, action: /can use the selected model/ },
  { status: 402, code: 'PROVIDER_QUOTA', detail: { message: 'Payment required.' }, action: /billing or credit balance/ },
  { status: 429, code: 'PROVIDER_QUOTA', detail: { code: 'insufficient_quota', message: 'Account limit exceeded.' }, action: /billing or credit balance/ },
  { status: 429, code: 'PROVIDER_RATE_LIMIT', detail: { message: 'Too many requests.' }, action: /Wait 12 seconds/ },
  { status: 400, code: 'CONTEXT_OVERFLOW', detail: { code: 'context_length_exceeded', message: 'Maximum context length is 8192 tokens.' }, action: /Compact this conversation/ },
  { status: 404, code: 'PROVIDER_ENDPOINT', detail: { message: 'Not found.' }, action: /API address, API protocol, and model ID/ },
  { status: 503, code: 'PROVIDER_SERVICE', detail: { message: 'Temporarily unavailable.' }, action: /Try again later/ },
]) test(`provider failures identify ${fixture.code} with an action and never retry automatically (HTTP ${fixture.status})`, async t => {
  const secret = 'private-error-classification-fixture';
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response) => {
    response.setHeader('Retry-After', '12');
    json(response, { error: { ...fixture.detail, message: `${fixture.detail.message} ${secret}` } }, fixture.status);
  });
  await runtime.saveProvider({ id: 'failure', type: 'compatible', baseUrl, apiKey: secret, models: ['model'] });
  await runtime.setDefaultModel('failure::model');
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Try once.' }), cause => cause.code === fixture.code && fixture.action.test(cause.message) && !cause.message.includes(secret));
  assert.equal(requests.length, 1);
  const provider = runtime.listProviders()[0], modelFailure = provider.modelChecks.model.lastFailure;
  if (['PROVIDER_ACCESS', 'CONTEXT_OVERFLOW'].includes(fixture.code)) {
    assert.equal(provider.lastFailure, undefined); assert.equal(provider.lastGenerationOk, undefined);
    assert.equal(modelFailure.code, fixture.code); assert.equal(modelFailure.scope, fixture.code === 'PROVIDER_ACCESS' ? 'model' : 'request');
  } else { assert.equal(provider.lastFailure.code, fixture.code); assert.equal(provider.lastFailure.scope, 'connection'); assert.equal(provider.lastGenerationOk, false); assert.equal(modelFailure, null); }
  assert.equal(provider.modelChecks.model.lastGenerationOk, false);
  assert.equal(provider.configured, true); assert.equal(runtime.status().defaultModelSelection, 'failure::model');
  assert.equal(runtime.status().defaultModelAvailable, true, 'transport failure must not discard the saved model or credentials');
  assert.ok(!JSON.stringify(runtime.status()).includes(secret));
});

test('a failed generation keeps completed tool work, and explicit continuation clears its last failure without replay', async t => {
  let toolCalls = 0;
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response, index) => {
    if (index === 1) return json(response, { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'completed-mutation', type: 'function', function: { name: 'relay_observe', arguments: '{"target":"workspace"}' } }] }, finish_reason: 'tool_calls' }] });
    if (index === 2) return json(response, { error: { message: 'Too many requests.' } }, 429);
    return json(response, { choices: [{ message: { role: 'assistant', content: 'Continued after checking saved activity.' }, finish_reason: 'stop' }] });
  });
  await runtime.saveProvider({ id: 'continuation', type: 'compatible', baseUrl, models: ['model'] });
  let threadId;
  const options = { cwd, model: 'continuation::model', dynamicTools: [tool], onToolCall: async () => { toolCalls++; return { success: true, contentItems: [{ type: 'inputText', text: 'The action completed.' }] }; } };
  await assert.rejects(runtime.runAgent({ ...options, prompt: 'Perform an action.', onEvent: event => { threadId ||= event.threadId; } }), { code: 'PROVIDER_RATE_LIMIT' });
  assert.equal(requests.length, 2); assert.equal(toolCalls, 1); assert.equal(runtime.listProviders()[0].lastFailure.code, 'PROVIDER_RATE_LIMIT');
  const result = await runtime.runAgent({ ...options, threadId, prompt: 'Continue from the confirmed activity.' });
  assert.equal(result.output, 'Continued after checking saved activity.'); assert.equal(requests.length, 3); assert.equal(toolCalls, 1);
  assert.equal(requests[2].body.messages.filter(message => message.tool_call_id === 'completed-mutation').length, 1);
  assert.equal(runtime.listProviders()[0].lastFailure, null); assert.equal(runtime.listProviders()[0].lastGenerationOk, true);
});

for (const fixture of [
  { status: 403, detail: { message: 'This model is not enabled for your key.' }, code: 'PROVIDER_MODEL', scope: 'model' },
  { status: 403, detail: { code: 'permission_error', message: 'Model access denied.' }, code: 'PROVIDER_ACCESS', scope: 'model' },
  { status: 404, detail: { code: 'model_not_found', message: 'The requested model does not exist.' }, code: 'PROVIDER_MODEL', scope: 'model' },
  { status: 404, detail: { message: 'No endpoints found for this model.' }, code: 'PROVIDER_MODEL', scope: 'model' },
  { status: 429, detail: { code: 'model_rate_limit', message: 'Rate limit for the selected model.' }, code: 'PROVIDER_RATE_LIMIT', scope: 'model' },
  { status: 400, detail: { code: 'context_length_exceeded', message: 'Maximum context length is 8192 tokens.' }, code: 'CONTEXT_OVERFLOW', scope: 'request' },
]) test(`a ${fixture.code} rejection is isolated from a healthy sibling and the pinned default (${fixture.detail.message})`, async t => {
  let recovered = false;
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response) => {
    if (request.url.endsWith('/models')) return json(response, { data: [{ id: 'restricted' }, { id: 'healthy' }] });
    if (request.body.model === 'restricted' && !recovered) return json(response, { error: fixture.detail }, fixture.status);
    json(response, { choices: [{ message: { content: `Reply from ${request.body.model}.` }, finish_reason: 'stop' }] });
  }, { catalog: true });
  await runtime.saveProvider({ id: 'shared', type: 'compatible', baseUrl, models: ['restricted', 'healthy'] });
  await runtime.setDefaultModel('shared::healthy');
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Use the restricted model.', model: 'shared::restricted' }), { code: fixture.code });
  let provider = runtime.listProviders()[0];
  assert.equal(provider.lastFailure, undefined); assert.equal(provider.lastGenerationOk, undefined);
  assert.equal(provider.modelChecks.restricted.lastFailure.scope, fixture.scope);
  assert.equal(provider.modelChecks.restricted.lastFailure.modelId, 'restricted');
  assert.equal(provider.modelChecks.healthy, undefined);
  assert.equal(runtime.status().defaultModel, 'shared::healthy'); assert.equal(runtime.status().defaultModelAvailable, true);
  await runtime.testProvider('shared');
  assert.equal(runtime.listProviders()[0].modelChecks.restricted.lastFailure.code, fixture.code, 'catalog access does not prove this model can generate');
  assert.equal((await runtime.runAgent({ cwd, prompt: 'Use the saved default.' })).output, 'Reply from healthy.');
  provider = runtime.listProviders()[0]; assert.equal(provider.lastFailure, null); assert.equal(provider.lastGenerationOk, true);
  assert.equal(provider.modelChecks.restricted.lastFailure.code, fixture.code, 'a sibling response must not erase the restricted model’s diagnostic');
  assert.equal(provider.modelChecks.healthy.lastFailure, null);
  recovered = true;
  assert.equal((await runtime.runAgent({ cwd, prompt: 'Explicitly retry after the model became available.', model: 'shared::restricted' })).output, 'Reply from restricted.');
  assert.equal(runtime.listProviders()[0].modelChecks.restricted.lastFailure, null);
  assert.equal(requests.length, 5, 'there is one onboarding catalog lookup, one catalog test, and one request for each explicit generation attempt');
});

test('a late model rejection cannot overwrite a parallel sibling’s successful connection evidence', async t => {
  const arrived = deferred(); let restrictedResponse;
  const { runtime, baseUrl, cwd } = await harness(t, (request, response) => {
    if (request.body.model === 'restricted') { restrictedResponse = response; arrived.resolve(); return; }
    json(response, { choices: [{ message: { content: 'Healthy sibling completed.' }, finish_reason: 'stop' }] });
  });
  await runtime.saveProvider({ id: 'parallel', type: 'compatible', baseUrl, models: ['restricted', 'healthy'] });
  const restricted = runtime.runAgent({ cwd, prompt: 'Try the restricted model.', model: 'parallel::restricted' });
  await arrived.promise;
  await runtime.runAgent({ cwd, prompt: 'Work independently.', model: 'parallel::healthy' });
  json(restrictedResponse, { error: { message: 'Model access denied.' } }, 403);
  await assert.rejects(restricted, { code: 'PROVIDER_ACCESS' });
  const provider = runtime.listProviders()[0];
  assert.equal(provider.lastGenerationOk, true); assert.equal(provider.lastFailure, null);
  assert.equal(provider.modelChecks.healthy.lastGenerationOk, true); assert.equal(provider.modelChecks.restricted.lastFailure.scope, 'model');
});

test('account failures remain connection-wide until a confirmed generation recovers, without stale per-model auth errors', async t => {
  let failed = true;
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response) => {
    if (failed) return json(response, { error: { code: 'invalid_api_key', message: 'Invalid API key.' } }, 401);
    json(response, { choices: [{ message: { content: 'The shared account is working.' }, finish_reason: 'stop' }] });
  });
  await runtime.saveProvider({ id: 'account', type: 'compatible', baseUrl, models: ['first', 'second'] });
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Try once.', model: 'account::first' }), { code: 'PROVIDER_AUTH' });
  assert.equal(runtime.listProviders()[0].lastFailure.scope, 'connection');
  failed = false;
  await runtime.runAgent({ cwd, prompt: 'Try another model after account recovery.', model: 'account::second' });
  const provider = runtime.listProviders()[0]; assert.equal(provider.lastFailure, null); assert.equal(provider.lastGenerationOk, true);
  assert.equal(provider.modelChecks.first.lastFailure, null, 'a recovered shared auth failure must not linger as a false model-specific error');
  assert.equal(requests.length, 2);
});

for (const type of ['openai', 'compatible']) test(`${type}: ultra is forwarded exactly, inherited on continuation, and explicitly reset to the model default`, async t => {
  const payload = type === 'openai' ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Exact effort received.' }] }] } : { choices: [{ message: { content: 'Exact effort received.' }, finish_reason: 'stop' }] };
  const { runtime, baseUrl, cwd, dataDir, requests } = await harness(t, (request, response) => json(response, payload));
  await runtime.saveProvider({ id: 'effort', type, baseUrl, apiKey: 'private-effort-fixture', models: ['model'] });
  const first = await runtime.runAgent({ cwd, model: 'effort::model', prompt: 'Use ultra.', effort: 'ultra' });
  assert.equal(first.effort, 'ultra');
  await runtime.runAgent({ cwd, threadId: first.threadId, prompt: 'Continue with the same reasoning effort.' });
  const reset = await runtime.runAgent({ cwd, threadId: first.threadId, prompt: 'Use the model default.', effort: 'default' });
  assert.equal(reset.effort, 'default');
  await runtime.runAgent({ cwd, threadId: first.threadId, prompt: 'Keep the model default.' });
  const field = body => type === 'openai' ? body.reasoning?.effort : body.reasoning_effort;
  assert.deepEqual(requests.map(request => field(request.body)), ['ultra', 'ultra', undefined, undefined]);
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'provider-threads', `${first.threadId}.json`), 'utf8')).effort, null);
  assert.equal(requests.length, 4, 'effort changes never restart or replay a task implicitly');
});

test('unsupported Messages effort rejects before HTTP, history creation, or thread events', async t => {
  const { runtime, baseUrl, cwd, dataDir, requests } = await harness(t);
  await runtime.saveProvider({ id: 'messages', type: 'anthropic', baseUrl, apiKey: 'private-messages-effort-fixture', models: ['model'] });
  const events = [];
  for (const effort of ['ultra', 'minimal', 'none']) await assert.rejects(runtime.runAgent({ cwd, prompt: 'Do not downgrade my selection.', model: 'messages::model', effort, onEvent: event => events.push(event) }), cause => cause.code === 'UNSUPPORTED_REASONING_EFFORT' && cause.message.includes(effort));
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Do not send malformed effort.', model: 'messages::model', effort: 'unknown' }), { code: 'INVALID_REASONING_EFFORT' });
  assert.equal(requests.length, 0); assert.deepEqual(events, []);
  assert.ok(!(await readdir(dataDir)).includes('provider-threads'));
  assert.equal(runtime.listProviders()[0].lastFailure, undefined, 'a local option rejection must not mark a healthy connection as broken');
});

for (const type of ['openai', 'anthropic', 'compatible']) test(`${type}: compaction uses the thread’s exact saved reasoning effort`, async t => {
  const answer = (text, call = false) => type === 'openai'
    ? { status: 'completed', output: call ? [{ type: 'function_call', call_id: 'effort-tool', name: 'relay_observe', arguments: '{}' }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] }
    : type === 'anthropic'
      ? { content: call ? [{ type: 'tool_use', id: 'effort-tool', name: 'relay_observe', input: {} }] : [{ type: 'text', text }], stop_reason: call ? 'tool_use' : 'end_turn' }
      : { choices: [{ message: call ? { content: null, tool_calls: [{ id: 'effort-tool', type: 'function', function: { name: 'relay_observe', arguments: '{}' } }] } : { content: text }, finish_reason: call ? 'tool_calls' : 'stop' }] };
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response, count) => json(response, answer(count === 3 ? 'Objective kept. Continue from the confirmed observation.' : 'Observation complete.', count === 1)));
  await runtime.saveProvider({ id: 'compacteffort', type, baseUrl, apiKey: 'private-compaction-effort-fixture', models: ['model'] });
  const first = await runtime.runAgent({ cwd, model: 'compacteffort::model', prompt: 'Observe ALPHA and retain the evidence.', effort: type === 'anthropic' ? 'max' : 'ultra', context: { keepRecentTokens: 256, autoCompact: false }, dynamicTools: [tool], onToolCall: async () => ({ success: true, contentItems: [{ type: 'inputText', text: 'Verified ALPHA. '.repeat(400) }] }) });
  const compacted = await runtime.compactThread(first.threadId);
  assert.equal(compacted.compacted, true); assert.equal(requests.length, 3);
  assert.match(JSON.stringify(requests[2].body), /Create a concise continuity checkpoint/);
  assert.equal(type === 'openai' ? requests[2].body.reasoning?.effort : type === 'anthropic' ? requests[2].body.output_config?.effort : requests[2].body.reasoning_effort, type === 'anthropic' ? 'max' : 'ultra');
  assert.equal(requests[2].body.tools, undefined, 'summarizing saved history must not repeat the original tool action');
});

for (const type of ['openai', 'anthropic', 'compatible']) test(`${type}: a streamed model rejection preserves received text and leaves sibling models healthy`, async t => {
  const secret = 'private-partial-model-error-fixture', detail = { code: 'model_not_found', message: `This model is unavailable. ${secret}` };
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response) => sse(response, type === 'openai'
    ? [{ type: 'response.output_text.delta', delta: 'Received before interruption.' }, { type: 'response.failed', response: { error: detail } }]
    : type === 'anthropic'
      ? [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Received before interruption.' } }, { type: 'error', error: detail }]
      : [{ choices: [{ index: 0, delta: { content: 'Received before interruption.' } }] }, { error: detail }]));
  await runtime.saveProvider({ id: 'partialmodel', type, baseUrl, apiKey: secret, models: ['restricted', 'healthy'] });
  await runtime.setDefaultModel('partialmodel::healthy');
  const events = [];
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Try only once.', model: 'partialmodel::restricted', onEvent: event => events.push(event) }), { code: 'PROVIDER_MODEL', failureScope: 'model' });
  assert.equal(requests.length, 1); assert.ok(events.some(event => event.type === 'delta' && event.delta === 'Received before interruption.'));
  assert.ok(!events.some(event => event.type === 'turn' && event.status === 'completed'));
  const provider = runtime.listProviders()[0]; assert.equal(provider.lastFailure, undefined); assert.equal(provider.modelChecks.restricted.lastFailure.scope, 'model');
  assert.equal(runtime.status().defaultModelAvailable, true); assert.ok(!JSON.stringify(runtime.status()).includes(secret));
});

for (const type of ['openai', 'compatible']) test(`${type}: an API rejection of ultra stays explicit and never downgrades or replays the request`, async t => {
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response) => json(response, { error: { code: 'unsupported_value', message: 'This model does not support ultra reasoning effort.' } }, 400));
  await runtime.saveProvider({ id: 'stricteffort', type, baseUrl, apiKey: 'private-strict-effort-fixture', models: ['model', 'sibling'] });
  let threadId;
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Use precisely ultra.', model: 'stricteffort::model', effort: 'ultra', onEvent: event => { threadId ||= event.threadId; } }), cause => cause.code === 'PROVIDER_HTTP' && /ultra reasoning effort/.test(cause.message));
  assert.equal(requests.length, 1);
  assert.equal(type === 'openai' ? requests[0].body.reasoning.effort : requests[0].body.reasoning_effort, 'ultra');
  assert.equal((await runtime.readThread(threadId)).effort, 'ultra');
  assert.equal(runtime.listProviders()[0].lastFailure, undefined);
  assert.equal(runtime.listProviders()[0].modelChecks.model.lastFailure.scope, 'request');
});

test('connection errors explain reachability and invalid JSON without echoing transport internals', async t => {
  let malformed = false;
  const { runtime, baseUrl, cwd } = await harness(t, (request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('<html>gateway login</html>'); }, { fetchImpl: (...args) => malformed ? fetch(...args) : Promise.reject(new TypeError('fetch failed with private-transport-details')) });
  await runtime.saveProvider({ id: 'transport', type: 'compatible', baseUrl, models: ['model'] });
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Connect.', model: 'transport::model' }), cause => cause.code === 'PROVIDER_NETWORK' && /local server is running/.test(cause.message) && !cause.message.includes('private-transport-details'));
  malformed = true;
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Read.', model: 'transport::model' }), cause => cause.code === 'PROVIDER_PROTOCOL' && /invalid JSON/.test(cause.message) && !cause.message.includes('<html>'));
});

test('a real connection loss after streaming text reports interruption without confirming completion or retrying', async t => {
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Received partial text.' } }] })}\n\n`);
    setTimeout(() => response.destroy(), 25);
  });
  await runtime.saveProvider({ id: 'disconnect', type: 'compatible', baseUrl, models: ['model'] });
  const events = [];
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Stream a reply.', model: 'disconnect::model', onEvent: event => events.push(event) }), cause => cause.code === 'PROVIDER_NETWORK' && /interrupted before its response finished/.test(cause.message));
  assert.equal(requests.length, 1); assert.ok(events.some(event => event.type === 'delta' && event.delta === 'Received partial text.'));
  assert.ok(!events.some(event => event.type === 'turn' && event.status === 'completed')); assert.equal(runtime.listProviders()[0].lastFailure.code, 'PROVIDER_NETWORK');
});

for (const type of ['openai', 'anthropic', 'compatible']) test(`${type}: structured stream failures use the same actionable authentication classification`, async t => {
  const detail = { type: 'authentication_error', message: 'Invalid API credentials.' };
  const { runtime, baseUrl, cwd } = await harness(t, (request, response) => sse(response, [type === 'openai' ? { type: 'response.failed', response: { error: detail } } : { type: 'error', error: detail }]));
  await runtime.saveProvider({ id: 'streamauth', type, baseUrl, apiKey: 'private-stream-auth-fixture', models: ['model'] });
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Respond.', model: 'streamauth::model' }), { code: 'PROVIDER_AUTH' });
  assert.equal(runtime.listProviders()[0].lastFailure.code, 'PROVIDER_AUTH');
});

for (const outcome of ['success', 'failure', 'removed']) test(`an old connection test cannot restore stale ${outcome} status after an edit`, async t => {
  const arrived = deferred(); let pending, testingCatalog = false;
  const { runtime, baseUrl, requests, catalogRequests } = await harness(t, (request, response) => { pending = response; arrived.resolve(); }, { catalog: () => testingCatalog });
  await runtime.saveProvider({ id: 'stale', type: 'compatible', baseUrl, apiKey: 'old-check-key-fixture', models: ['model'] });
  testingCatalog = true; const testing = runtime.testProvider('stale'); await arrived.promise; testingCatalog = false;
  if (outcome === 'removed') await runtime.removeProvider('stale');
  else await runtime.saveProvider({ id: 'stale', apiKey: 'new-check-key-fixture' });
  const currentCatalog = runtime.modelCatalogs.get('stale');
  json(pending, outcome === 'failure' ? { error: { message: 'Invalid old credentials.' } } : { data: ['model'] }, outcome === 'failure' ? 401 : 200);
  await assert.rejects(testing, cause => ['PROVIDER_CHANGED', 'PROVIDER_AUTH'].includes(cause.code));
  assert.equal(requests.length, 1); assert.equal(catalogRequests.length, outcome === 'removed' ? 2 : 3); assert.equal(runtime.checks.has('stale'), false); assert.equal(runtime.modelCatalogs.get('stale'), currentCatalog, 'the old test cannot replace the current onboarding catalog');
  if (outcome !== 'removed') assert.equal(runtime.listProviders()[0].testedAt, undefined);
});

test('an older test of the same connection cannot overwrite a newer failure', async t => {
  const arrived = [deferred(), deferred()], responses = []; let testingCatalog = false;
  const { runtime, baseUrl } = await harness(t, (request, response, index) => { responses[index - 1] = response; arrived[index - 1].resolve(); }, { catalog: () => testingCatalog });
  await runtime.saveProvider({ id: 'ordering', type: 'compatible', baseUrl, models: ['model'] });
  testingCatalog = true;
  const older = runtime.testProvider('ordering'); await arrived[0].promise;
  const newer = runtime.testProvider('ordering'); await arrived[1].promise;
  json(responses[1], { error: { message: 'Invalid new test credentials.' } }, 401);
  await assert.rejects(newer, { code: 'PROVIDER_AUTH' });
  json(responses[0], { data: ['model'] }); await older;
  assert.equal(runtime.listProviders()[0].ok, false); assert.equal(runtime.listProviders()[0].errorCode, 'PROVIDER_AUTH');
});

for (const type of ['openai', 'anthropic', 'compatible']) test(`${type}: generation respects a saved model output limit without raising a smaller user limit`, async t => {
  const payload = type === 'openai' ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Within limit.' }] }] } : type === 'anthropic' ? { content: [{ type: 'text', text: 'Within limit.' }], stop_reason: 'end_turn' } : { choices: [{ message: { content: 'Within limit.' }, finish_reason: 'stop' }] };
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response) => json(response, payload));
  await runtime.saveProvider({ id: 'limited', type, baseUrl, apiKey: 'private-output-limit-fixture', maxTokens: 8192, models: [{ id: 'model', maxOutputTokens: 1024 }] });
  await runtime.runAgent({ cwd, prompt: 'Use the model limit.', model: 'limited::model', context: { outputReserveTokens: 4096 } });
  assert.equal(requests[0].body[type === 'openai' ? 'max_output_tokens' : 'max_tokens'], 1024);
  await runtime.saveProvider({ id: 'limited', maxTokens: 128 });
  await runtime.runAgent({ cwd, prompt: 'Use my smaller limit.', model: 'limited::model' });
  assert.equal(requests[1].body[type === 'openai' ? 'max_output_tokens' : 'max_tokens'], 128);
});

test('Codex missing after an API connection reports its own installation failure and never disables OpenRouter',async t=>{
 const codex=new FakeCodex(false);
 const{runtime,baseUrl}=await harness(t,null,{codex});
 await runtime.saveProvider({id:'cloud',name:'OpenRouter',type:'compatible',baseUrl,models:['vendor/model']});
 await runtime.setDefaultModel('cloud::vendor/model');
 const initial=await runtime.start();
 assert.equal(initial.defaultModel,'cloud::vendor/model');
 assert.equal(initial.defaultModelAvailable,true);
 assert.equal(initial.codex.connected,false);
 await assert.rejects(runtime.start({connectCodex:true}),/Codex offline/);
 const after=runtime.status();
 assert.equal(after.defaultModel,'cloud::vendor/model','failed native reconnect does not change API default');
 assert.equal(after.defaultModelAvailable,true);
 assert.equal(after.codex.authenticated,false);
 assert.equal(runtime.resolveModel('codex').available,false);
 await runtime.setDefaultModel('codex');
 const selected=runtime.defaultModelStatus();
 assert.equal(selected.defaultModelAvailable,false);
 assert.match(selected.defaultModelError,/Codex offline/);
 assert.doesNotMatch(selected.defaultModelError,/no longer listed/);
});

for (const type of ['openai', 'anthropic', 'compatible']) test(`${type}: BLACKICE identity and changed planning policy reach the actual provider wire on continuation`, async t => {
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response) => {
    if (type === 'openai') return json(response, { id: 'identity-response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Identity fixture completed.' }] }] });
    if (type === 'anthropic') return json(response, { id: 'identity-message', role: 'assistant', type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Identity fixture completed.' }] });
    return json(response, { choices: [{ message: { role: 'assistant', content: 'Identity fixture completed.' }, finish_reason: 'stop' }] });
  });
  await runtime.saveProvider({ id: 'identity', type, baseUrl, apiKey: 'fixture-identity-key', models: ['fixture-model'] });
  const instruction = policy => `${BLACKICE_HARNESS_INSTRUCTIONS}\n\n${policy}`;
  const firstPolicy = instruction('PLANNING MODE: on. Use the task plan tool before answering.');
  const first = await runtime.runAgent({ cwd, model: 'identity::fixture-model', prompt: 'Use the fixture.', developerInstructions: firstPolicy, dynamicTools: [tool] });
  const secondPolicy = instruction('PLANNING MODE: off. Automatic planning is disabled.');
  await runtime.runAgent({ cwd, model: 'identity::fixture-model', threadId: first.threadId, prompt: 'Continue the fixture.', developerInstructions: secondPolicy, dynamicTools: [tool] });
  const wireInstructions = body => type === 'openai' ? body.instructions : type === 'anthropic' ? body.system : body.messages.find(message => message.role === 'system')?.content;
  assert.equal(requests.length, 2);
  assert.equal(wireInstructions(requests[0].body), firstPolicy);
  assert.equal(wireInstructions(requests[1].body), secondPolicy);
  assert.ok(requests.every(request => request.body.tools.length === 1), 'identity and planning policy accompany the real tool catalog');
  assert.equal(requests[1].body.model, 'fixture-model');
  assert.doesNotMatch(wireInstructions(requests[1].body), /Use the task plan tool before answering/);
});


test('automatic default selection publishes its pending durable save and clears it at completion', async t => {
  const { runtime, codex } = await nativeCatalogHarness(t), saving = deferred(), entered = deferred(), phases = [], pin = runtime.store.pinAutomaticDefault.bind(runtime.store);
  runtime.store.pinAutomaticDefault = async value => { entered.resolve(); await saving.promise; return pin(value); };
  runtime.on('status', status => phases.push(status.defaultModelInitializing));
  const pending = runtime.start(); await entered.promise;
  assert.equal(runtime.status().defaultModelInitializing, true); assert.equal(runtime.resolveModel('default').available, false);
  assert.equal(runtime.status().defaultModelSelection, null); assert.equal(codex.calls.length, 0);
  saving.resolve(); const status = await pending;
  assert.equal(status.defaultModelInitializing, false); assert.equal(status.defaultModel, 'codex-model'); assert.equal(status.defaultModelAvailable, true);
  assert.equal(phases.includes(true), true); assert.equal(phases.at(-1), false); assert.equal(codex.calls.length, 0);
});

test('saved API defaults start independently while unused Codex reports a pending handshake', async t => {
  const codex = new FakeCodex(false); let starts = 0; const nativeStatus = codex.status.bind(codex);
  codex.status = () => ({ ...nativeStatus(), connection: { phase: 'initializing' } });
  codex.start = async () => { starts++; throw Error('The unused native runtime must not start.'); };
  const { runtime } = await nativeCatalogHarness(t, codex);
  await runtime.saveProvider({ id: 'selected-api', type: 'compatible', baseUrl: 'http://127.0.0.1:1/v1', models: ['kept-model'] });
  await runtime.setDefaultModel('selected-api::kept-model');
  const before = runtime.status().defaultModelSelection, status = await runtime.start();
  assert.equal(starts, 0); assert.equal(status.defaultModelInitializing, false); assert.equal(status.defaultModelAvailable, true);
  assert.equal(status.defaultModelSelection, before); assert.equal(status.defaultModel, 'selected-api::kept-model'); assert.equal(codex.calls.length, 0);
});

for (const fixture of [
  { status: 400, code: 'PROVIDER_HTTP', scope: 'request' },
  { status: 429, code: 'PROVIDER_RATE_LIMIT', scope: 'connection' },
  { status: 502, code: 'PROVIDER_SERVICE', scope: 'connection' },
]) test(`generic provider failures retain HTTP ${fixture.status} in the error and saved diagnostic`, async t => {
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response) => json(response, { error: { message: 'Provider returned error' } }, fixture.status));
  await runtime.saveProvider({ id: 'generic', type: 'compatible', baseUrl, models: ['model'] });
  await assert.rejects(runtime.runAgent({ cwd, model: 'generic::model', prompt: 'Try the exact model once.' }), cause => cause.code === fixture.code && cause.httpStatus === fixture.status && cause.message.includes(`HTTP ${fixture.status}`));
  const provider = runtime.listProviders()[0], receipt = fixture.scope === 'connection' ? provider.lastFailure : provider.modelChecks.model.lastFailure;
  assert.equal(receipt.httpStatus, fixture.status); assert.equal(receipt.scope, fixture.scope);
  const attempts = fixture.status === 502 ? 2 : 1;
  assert.equal(requests.length, attempts, 'only a transient HTTP rejection receives one retry');
  assert.ok(requests.every(request => request.body.model === 'model'), 'diagnostics preserve the selected model');
  if (attempts === 2) assert.deepEqual(requests[1].body, requests[0].body, 'the retry preserves the exact provider request');
});

test('a parsed OpenRouter upstream service rejection stays with its model and never exposes raw payloads', async t => {
  const secret = 'fixture-upstream-private-key', payload = 'private submitted transcript must never appear in diagnostics';
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response) => {
    if (request.body.model === 'restricted:free') return json(response, { error: { message: 'Provider returned error', metadata: { provider_name: 'AtlasCloud', raw: JSON.stringify({ error: { code: 'upstream_unavailable', type: 'server_error', status: 503, message: `${payload} ${secret}`, request: request.body }, request: request.body }) } } }, 502);
    return json(response, { choices: [{ message: { role: 'assistant', content: 'Healthy sibling reply.' }, finish_reason: 'stop' }] });
  });
  await runtime.saveProvider({ id: 'router-diagnostic', preset: 'openrouter', baseUrl, apiKey: secret, models: ['restricted:free', 'healthy:free'] });
  await assert.rejects(runtime.runAgent({ cwd, model: 'router-diagnostic::restricted:free', prompt: payload }), cause => cause.code === 'PROVIDER_SERVICE' && cause.httpStatus === 502 && cause.upstreamStatus === 503 && cause.upstreamCode === 'upstream_unavailable' && /HTTP 502/.test(cause.message) && !cause.message.includes(payload) && !cause.message.includes(secret));
  const provider = runtime.listProviders()[0], receipt = provider.modelChecks['restricted:free'].lastFailure;
  assert.equal(provider.lastFailure, undefined); assert.equal(receipt.scope, 'model'); assert.equal(receipt.httpStatus, 502); assert.equal(receipt.upstreamStatus, 503); assert.equal(receipt.upstreamProvider, 'AtlasCloud');
  assert.equal((await runtime.runAgent({ cwd, model: 'router-diagnostic::healthy:free', prompt: 'Use the sibling explicitly.' })).output, 'Healthy sibling reply.');
  assert.equal(runtime.listProviders()[0].modelChecks['restricted:free'].lastFailure.code, 'PROVIDER_SERVICE');
  assert.ok(!JSON.stringify(runtime.status()).includes(payload)); assert.ok(!JSON.stringify(runtime.status()).includes(secret));
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(request => request.body.model), ['restricted:free', 'restricted:free', 'healthy:free']);
  assert.deepEqual(requests[1].body, requests[0].body, 'recovery repeats the rejected request before the explicit sibling run');
});

test('large OpenRouter error envelopes retain allowlisted upstream diagnostics without exposing private contents', async t => {
  const secret = 'fixture-large-upstream-private-key', payload = 'private upstream transcript marker', privateMessage = `${payload} ${secret} `.repeat(160);
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response) => {
    const envelope = { error: { message: 'Provider returned error', metadata: { provider_name: 'AtlasCloud', raw: JSON.stringify({ error: { code: 'invalid_tool_arguments', type: 'invalid_request_error', param: 'messages[2].tool_calls[0].function.arguments', status: 400, message: privateMessage, request: request.body } }) } } };
    assert.ok(JSON.stringify(envelope).length > 2000, 'the complete error envelope must exceed the former read limit');
    assert.ok(envelope.error.metadata.raw.length <= 20_000, 'upstream metadata stays within its existing parsing limit');
    return json(response, envelope, 400);
  });
  await runtime.saveProvider({ id: 'large-upstream', preset: 'openrouter', baseUrl, apiKey: secret, models: ['exact:free'] });
  await assert.rejects(runtime.runAgent({ cwd, model: 'large-upstream::exact:free', prompt: payload }), cause => {
    assert.equal(cause.code, 'PROVIDER_HTTP'); assert.equal(cause.httpStatus, 400); assert.equal(cause.upstreamStatus, 400);
    assert.equal(cause.upstreamCode, 'invalid_tool_arguments'); assert.equal(cause.upstreamType, 'invalid_request_error');
    assert.equal(cause.upstreamParam, 'messages[2].tool_calls[0].function.arguments'); assert.equal(cause.upstreamProvider, 'AtlasCloud');
    assert.ok(!cause.message.includes(payload)); assert.ok(!cause.message.includes(secret)); assert.ok(!JSON.stringify(cause).includes(payload)); return true;
  });
  const receipt = runtime.listProviders()[0].modelChecks['exact:free'].lastFailure;
  assert.equal(receipt.httpStatus, 400); assert.equal(receipt.upstreamStatus, 400); assert.equal(receipt.upstreamCode, 'invalid_tool_arguments');
  assert.equal(receipt.upstreamType, 'invalid_request_error'); assert.equal(receipt.upstreamParam, 'messages[2].tool_calls[0].function.arguments'); assert.equal(receipt.upstreamProvider, 'AtlasCloud');
  assert.ok(!JSON.stringify(runtime.status()).includes(payload)); assert.ok(!JSON.stringify(runtime.status()).includes(secret)); assert.equal(requests.length, 1);
});

for (const format of ['json', 'sse']) for (const fixture of [
  { name: 'malformed JSON', arguments: '{"target":"workspace"' },
  { name: 'nonobject JSON', arguments: '["workspace"]' },
  { name: 'empty arguments', arguments: '' },
]) test(`compatible ${format}: ${fixture.name} recovers without executing it or poisoning mixed and restored tool history`, async t => {
  const calls = [
    { id: 'reused-call-id', type: 'function', function: { name: 'relay_observe', arguments: fixture.arguments } },
    { id: 'valid-sibling', type: 'function', function: { name: 'relay_observe', arguments: '{"target":"sibling"}' } },
  ];
  const send = (response, message, finishReason) => format === 'json'
    ? json(response, { choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finishReason }] })
    : sse(response, [{ choices: [{ index: 0, delta: { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } : {}) } }] }, { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }]);
  const effects = [];
  const { runtime, baseUrl, cwd, requests, dataDir } = await harness(t, (request, response, index) => {
    if (index === 1) return send(response, { content: 'Preserve the assistant context.', tool_calls: calls }, 'tool_calls');
    const messages = request.body.messages, firstAssistant = messages.find(message => message.role === 'assistant');
    assert.equal(firstAssistant.content, 'Preserve the assistant context.');
    assert.deepEqual(firstAssistant.tool_calls.map(call => call.id), ['valid-sibling']);
    assert.deepEqual(JSON.parse(firstAssistant.tool_calls[0].function.arguments), { target: 'sibling' });
    const firstAssistantIndex = messages.indexOf(firstAssistant);
    assert.equal(messages[firstAssistantIndex + 1].role, 'tool'); assert.equal(messages[firstAssistantIndex + 1].tool_call_id, 'valid-sibling');
    const diagnostic = messages[firstAssistantIndex + 2];
    assert.equal(diagnostic.role, 'user'); assert.match(diagnostic.content, /BLACKICE TOOL-CALL HISTORY/);
    assert.match(diagnostic.content, /reused-call-id/); assert.match(diagnostic.content, /recordedResults/); assert.ok(diagnostic.content.length <= 8192);
    if (index === 2) {
      assert.equal(messages.filter(message => message.role === 'tool' && message.tool_call_id === 'reused-call-id').length, 0);
      return send(response, { content: null, tool_calls: [{ id: 'reused-call-id', type: 'function', function: { name: 'relay_observe', arguments: '{"target":"corrected"}' } }] }, 'tool_calls');
    }
    const corrected = messages.find(message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === 'reused-call-id'));
    assert.deepEqual(JSON.parse(corrected.tool_calls[0].function.arguments), { target: 'corrected' }, 'later valid calls with the same ID must remain paired');
    assert.equal(messages[messages.indexOf(corrected) + 1].tool_call_id, 'reused-call-id');
    return send(response, { content: index === 3 ? 'Recovered.' : 'Continued.' }, 'stop');
  });
  await runtime.saveProvider({ id: 'malformed', preset: 'openrouter', baseUrl, apiKey: 'fixture-recovery-key', models: ['exact:free'] });
  const result = await runtime.runAgent({ cwd, model: 'malformed::exact:free', prompt: 'Recover a rejected synthetic tool call.', dynamicTools: [tool], onToolCall: async call => { effects.push(call.arguments.target); return { success: true, contentItems: [{ type: 'inputText', text: `Observed ${call.arguments.target}.` }] }; } });
  assert.equal(result.output, 'Recovered.'); assert.deepEqual(effects, ['sibling', 'corrected']); assert.equal(requests.length, 3);
  const threadPath = path.join(dataDir, 'provider-threads', `${result.threadId}.json`), saved = JSON.parse(await readFile(threadPath, 'utf8'));
  assert.equal(saved.messages.find(message => message.role === 'assistant').tool_calls[0].function.arguments, fixture.arguments);
  assert.equal(saved.transcript.find(message => message.role === 'assistant').tool_calls[0].function.arguments, fixture.arguments);
  assert.equal(saved.messages.filter(message => message.role === 'tool' && message.tool_call_id === 'reused-call-id').length, 2, 'durable history retains rejected and corrected receipts');
  const restored = await new ProviderRuntime({ modelLimitResolver: protocolModelLimitResolver, codex: new FakeCodex(), dataDir }).init(); t.after(() => restored.close());
  await restored.saveProvider({ id: 'malformed', apiKey: 'fixture-recovery-key' });
  const continued = await restored.runAgent({ cwd, model: 'malformed::exact:free', threadId: result.threadId, prompt: 'Continue using the saved observations.', dynamicTools: [tool], onToolCall: async () => { throw new Error('Confirmed work must not be repeated.'); } });
  assert.equal(continued.output, 'Continued.'); assert.equal(requests.length, 4); assert.deepEqual(effects, ['sibling', 'corrected']);
  const resaved = JSON.parse(await readFile(threadPath, 'utf8'));
  assert.deepEqual(resaved.messages.slice(0, saved.messages.length), saved.messages); assert.deepEqual(resaved.transcript.slice(0, saved.transcript.length), saved.transcript);
});

test('compatible duplicate IDs pair only the rejected occurrence with its own result in either sibling order', async t => {
  const call = (id, args) => ({ id, type: 'function', function: { name: 'relay_observe', arguments: args } });
  const calls = [call('invalid-first', 'null'), call('invalid-first', '{"target":"first-valid"}'), call('invalid-second', '{"target":"second-valid"}'), call('invalid-second', '[]')];
  const effects = [];
  const { runtime, baseUrl, cwd } = await harness(t, (request, response, index) => {
    if (index === 1) return json(response, { choices: [{ message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }] });
    const assistant = request.body.messages.find(message => message.role === 'assistant'), results = request.body.messages.filter(message => message.role === 'tool');
    assert.deepEqual(assistant.tool_calls.map(item => JSON.parse(item.function.arguments).target), ['first-valid', 'second-valid']);
    assert.deepEqual(results.map(item => [item.tool_call_id, item.content]), [['invalid-first', 'Observed first-valid.'], ['invalid-second', 'Observed second-valid.']]);
    const diagnostic = request.body.messages.find(message => message.content?.includes('BLACKICE TOOL-CALL HISTORY'));
    assert.match(diagnostic.content, /Tool arguments must be a JSON object/); assert.ok(!diagnostic.content.includes('Observed first-valid')); assert.ok(!diagnostic.content.includes('Observed second-valid'));
    return json(response, { choices: [{ message: { role: 'assistant', content: 'Both valid siblings preserved.' }, finish_reason: 'stop' }] });
  });
  await runtime.saveProvider({ id: 'duplicate-ids', type: 'compatible', baseUrl, models: ['model'] });
  const result = await runtime.runAgent({ cwd, model: 'duplicate-ids::model', prompt: 'Recover malformed duplicate-ID siblings.', dynamicTools: [tool], onToolCall: async call => { effects.push(call.arguments.target); return { success: true, contentItems: [{ type: 'inputText', text: `Observed ${call.arguments.target}.` }] }; } });
  assert.equal(result.output, 'Both valid siblings preserved.'); assert.deepEqual(effects, ['first-valid', 'second-valid']);
});

test('compatible all-invalid batches become bounded historical diagnostics without orphaned tool results', async t => {
  const calls = Array.from({ length: 80 }, (_, index) => ({ id: `rejected-${index}`, type: 'function', function: { name: 'relay_observe', arguments: 'null' } }));
  let effects = 0;
  const { runtime, baseUrl, cwd, requests } = await harness(t, (request, response, index) => {
    if (index === 1) return json(response, { choices: [{ message: { role: 'assistant', content: '\n\n\n', tool_calls: calls }, finish_reason: 'tool_calls' }] });
    assert.equal(request.body.messages.some(message => message.role === 'tool'), false);
    assert.equal(request.body.messages.some(message => message.role === 'assistant'), false);
    const diagnostic = request.body.messages.find(message => message.content?.includes('BLACKICE TOOL-CALL HISTORY'));
    assert.match(diagnostic.content, /rejected-0/); assert.match(diagnostic.content, /Additional rejected calls/); assert.ok(diagnostic.content.length <= 8192);
    return json(response, { choices: [{ message: { role: 'assistant', content: 'Recovered the rejected batch.' }, finish_reason: 'stop' }] });
  });
  await runtime.saveProvider({ id: 'rejected-batch', type: 'compatible', baseUrl, models: ['model'] });
  const result = await runtime.runAgent({ cwd, model: 'rejected-batch::model', prompt: 'Recover invalid synthetic tool requests.', dynamicTools: [tool], onToolCall: async () => { effects++; return { success: true, contentItems: [] }; } });
  assert.equal(result.output, 'Recovered the rejected batch.'); assert.equal(effects, 0); assert.equal(requests.length, 2);
});

test('unstructured OpenRouter raw errors and unknown metadata are not copied into diagnostics', async t => {
  const payload = 'private unstructured provider request contents';
  const { runtime, baseUrl, cwd } = await harness(t, (request, response) => json(response, { error: { message: 'Provider returned error', metadata: { raw: payload, request: request.body, api_key: 'unrecognized-private-key' } } }, 400));
  await runtime.saveProvider({ id: 'raw-error', preset: 'openrouter', baseUrl, apiKey: 'fixture-key', models: ['exact:free'] });
  await assert.rejects(runtime.runAgent({ cwd, model: 'raw-error::exact:free', prompt: payload }), cause => cause.httpStatus === 400 && cause.upstreamCode === undefined && /HTTP 400/.test(cause.message) && !cause.message.includes(payload));
  const receipt = runtime.listProviders()[0].modelChecks['exact:free'].lastFailure;
  assert.equal(receipt.upstreamCode, undefined); assert.ok(!JSON.stringify(receipt).includes(payload)); assert.ok(!JSON.stringify(receipt).includes('unrecognized-private-key'));
});

test('known credentials echoed in valid upstream identifier fields are redacted before errors and durable diagnostics', async t => {
  const secret = 'fixture-secret-valid-as-identifier';
  const { runtime, baseUrl, cwd } = await harness(t, (request, response) => json(response, { error: { message: 'Provider returned error', metadata: { provider_name: secret, raw: JSON.stringify({ error: { code: secret, type: secret, param: secret } }) } } }, 400));
  await runtime.saveProvider({ id: 'redacted-identifiers', preset: 'openrouter', baseUrl, apiKey: secret, models: ['exact:free'] });
  await assert.rejects(runtime.runAgent({ cwd, model: 'redacted-identifiers::exact:free', prompt: 'Check redacted diagnostics.' }), cause => {
    assert.equal(cause.upstreamCode, '[redacted]'); assert.equal(cause.upstreamType, '[redacted]'); assert.equal(cause.upstreamParam, '[redacted]'); assert.equal(cause.upstreamProvider, '[redacted]');
    assert.ok(!cause.message.includes(secret)); assert.ok(!JSON.stringify(cause).includes(secret)); return cause.httpStatus === 400;
  });
  const receipt = runtime.listProviders()[0].modelChecks['exact:free'].lastFailure;
  assert.equal(receipt.upstreamCode, '[redacted]'); assert.equal(receipt.upstreamProvider, '[redacted]'); assert.ok(!JSON.stringify(runtime.status()).includes(secret));
});
