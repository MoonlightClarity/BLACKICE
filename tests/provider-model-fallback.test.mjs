import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProviderRuntime } from '../lib/providers.mjs';
import { ProviderStore } from '../lib/provider-store.mjs';

const at = '2026-10-30T19:00:00.000Z';
const provider = { id: 'fixture', type: 'compatible', baseUrl: 'https://synthetic-models.example/v1' };
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const capacity = model => ({ ...model, contextWindowTokens: 131072, contextWindowSource: 'model-reference', contextWindowObservedAt: at,
  contextWindowEvidence: { label: 'Exact publisher metadata', modelId: model.id, url: 'https://publisher.example/models', endpointSpecific: false },
  modelLimitLookup: { status: 'partial', checkedAt: at, sources: [{ id: 'publisher', label: 'Exact publisher metadata', status: 'found' }] } });
class Native extends EventEmitter {
  status() { return { connected: true, authenticated: true, defaultModel: 'native', models: [{ id: 'native', model: 'native' }] }; }
  async close() {}
  async start() { return this.status(); }
  async runAgent() { throw Error('Metadata lookup must not start inference.'); }
}
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'provider-model-fallback-')), requests = [], lookups = [];
  const runtime = await new ProviderRuntime({ codex: new Native(), dataDir: dir,
    fetchImpl: async (url, request) => { requests.push({ url, method: request.method }); assert.equal(request.method, 'GET'); return response({ data: [{ id: 'saved' }, { id: 'other' }] }); },
    modelLimitResolver: { enrich: async (config, models, options) => { lookups.push({ config, options }); return models.map(capacity); } }, ...options }).init();
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  return { runtime, dir, requests, lookups };
}

test('adding a model saves fallback capacity with exact evidence and reloads its provenance', async t => {
  const f = await fixture(t);
  const result = await f.runtime.saveProvider({ ...provider, models: ['saved'] }, { preserveDefault: true });
  assert.equal(result.models[0].contextWindowTokens, 131072);
  assert.equal(result.models[0].contextWindowSource, 'model-reference');
  assert.equal(result.models[0].contextWindowObservedAt, at);
  assert.equal(result.models[0].contextWindowEvidence.modelId, 'saved');
  assert.equal(f.lookups[0].options.rawModels.length, 2);
  const reloaded = new ProviderStore({ dataDir: f.dir }); await reloaded.init();
  assert.equal(reloaded.public(reloaded.get('fixture')).models[0].contextWindowSource, 'model-reference');
  assert.equal(reloaded.get('fixture').models[0].contextWindowEvidence.url, 'https://publisher.example/models');
  assert.equal(f.requests.length, 1);
});

test('an unavailable model-list endpoint still resolves a manually added exact model ID', async t => {
  const f = await fixture(t, { fetchImpl: async () => new Response('not found', { status: 404 }) });
  const result = await f.runtime.saveProvider({ ...provider, models: ['saved'] }, { preserveDefault: true });
  assert.equal(result.modelLimitDiscovery.status, 'unavailable', 'catalog availability remains truthful');
  assert.equal(result.models[0].contextWindowTokens, 131072);
  assert.equal(result.models[0].contextWindowSource, 'model-reference');
  const refreshed = await f.runtime.discoverModels('fixture', { refresh: true });
  assert.equal(refreshed.catalogAvailable, false);
  assert.deepEqual(refreshed.models, []);
  assert.equal(refreshed.selectedModels[0].contextWindowTokens, 131072);
  await assert.rejects(f.runtime.testProvider('fixture'), /not found|catalog|HTTP 404/i, 'metadata fallback is not proof the endpoint is working');
});

test('refresh returns every saved model independently of the current catalog search page', async t => {
  const f = await fixture(t);
  await f.runtime.store.save({ ...provider, models: ['saved', { id: 'other', contextWindowTokens: 64000, maxOutputTokens: 4000 }] });
  const result = await f.runtime.discoverModels('fixture', { query: 'no-match', offset: 0, limit: 1, refresh: true });
  assert.equal(result.models.length, 0);
  assert.equal(result.selectedModels.length, 2);
  assert.equal(result.selectedModels.find(model => model.id === 'saved').contextWindowTokens, 131072);
  assert.equal(result.selectedModels.find(model => model.id === 'other').contextWindowTokens, 64000);
  assert.equal(result.selectedModels.find(model => model.id === 'other').contextWindowSource, 'user-configured');
  assert.equal(f.runtime.status().models.find(model => model.id === 'fixture::saved').contextWindowSource, 'model-reference');
});

test('startup refresh enriches existing selections without rewriting provider configuration or defaults', async t => {
  const f = await fixture(t);
  await f.runtime.store.save({ ...provider, models: ['saved'] });
  await f.runtime.store.setDefaultModel('fixture::saved');
  const before = await readFile(path.join(f.dir, 'providers.json'), 'utf8');
  await f.runtime.start();
  if (f.runtime.modelLimitWarmup) await f.runtime.modelLimitWarmup;
  assert.equal(f.runtime.status().models.find(model => model.id === 'fixture::saved').contextWindowTokens, 131072);
  assert.equal(f.runtime.status().defaultModel, 'fixture::saved');
  assert.equal(await readFile(path.join(f.dir, 'providers.json'), 'utf8'), before);
  const config = f.runtime.store.get('fixture');
  const context = f.runtime.contextFor({ config, record: { model: 'saved', messages: [], contextOptions: {}, compactions: [] }, tools: [] });
  assert.equal(context.windowSource, 'model-reference');
  assert.equal(context.effectiveWindowTokens, 131072);
});

test('catalog browsing returns all advertised models across pages without requiring a typed model ID', async t => {
  const models = Array.from({ length: 250 }, (_, index) => ({ id: `model-${String(index).padStart(3, '0')}` }));
  const f = await fixture(t, { fetchImpl: async () => response({ data: models }) });
  await f.runtime.store.save({ ...provider, models: ['model-001'] });
  const first = await f.runtime.discoverModels('fixture', { limit: 200 });
  const second = await f.runtime.discoverModels('fixture', { offset: 200, limit: 200 });
  assert.equal(first.totalModels, 250); assert.equal(first.hasMore, true); assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.models, ...second.models].map(model => model.id)).size, 250);
  assert.deepEqual(first.selectedModels.map(model => model.id), ['model-001']);
});

test('credential edits force a fresh metadata lookup instead of reusing credential-dependent cache entries', async t => {
  const f = await fixture(t);
  await f.runtime.saveProvider({ ...provider, apiKey: 'fixture-key-one', models: ['saved'] }, { preserveDefault: true });
  const oldCalls = f.lookups.length;
  await f.runtime.saveProvider({ id: 'fixture', apiKey: 'fixture-key-two' }, { preserveDefault: true });
  assert.ok(f.lookups.length > oldCalls);
  assert.equal(f.lookups.at(-1).options.refresh, true);
});

test('cancelling metadata enrichment prevents a pending model save', async t => {
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { modelLimitResolver: { enrich: async (_config, _models, { signal }) => {
    entered(); await new Promise((resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  } } });
  const controller = new AbortController();
  const pending = f.runtime.saveProvider({ ...provider, models: ['saved'] }, { signal: controller.signal, preserveDefault: true });
  await ready; controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.runtime.store.get('fixture'), undefined);
});

test('native runtime capacity and extra metadata candidates survive the provider facade without becoming advertised access', async t => {
  const f = await fixture(t);
  const result = f.runtime.codexModelCatalog({ connected: true, authenticated: true, models: [
    { id: 'native', model: 'native', hidden: true, contextWindowTokens: 272000, contextWindowSource: 'runtime-reported', contextWindowObservedAt: at,
      contextWindowEvidence: { label: 'Codex runtime metadata', modelId: 'native', endpointSpecific: true }, maxContextWindowTokens: 872000 }
  ], modelMetadataCandidates: [{ id: 'unadvertised', model: 'unadvertised', source: 'runtime-candidate', access: { state: 'unverified' }, contextWindowTokens: 128000, contextWindowSource: 'runtime-reported' }] });
  assert.equal(result.models[0].contextWindowSource, 'runtime-reported');
  assert.equal(result.models[0].maxContextWindowTokens, 872000);
  assert.equal(result.models[0].hidden, true);
  assert.equal(result.models.some(model => model.id === 'unadvertised'), false);
  assert.equal(result.candidates.find(model => model.id === 'unadvertised').access.state, 'unverified');
});

test('explicit refresh revisits an old saved reference even when the ID is absent from the model-list endpoint', async t => {
  const observed = [];
  const f = await fixture(t, { fetchImpl: async () => response({ data: [] }), modelLimitResolver: { enrich: async (_config, models) => {
    observed.push(...models); return models.map(model => model.contextWindowTokens ? model : capacity(model));
  } } });
  const old = { ...capacity({ id: 'saved' }), contextWindowTokens: 32768 };
  await f.runtime.store.save({ ...provider, models: [old] }, { trustedModels: [old] });
  const result = await f.runtime.discoverModels('fixture', { refresh: true });
  assert.equal(observed[0].contextWindowTokens, undefined);
  assert.equal(result.selectedModels[0].contextWindowTokens, 131072);
  assert.equal(result.selectedModels[0].contextWindowSource, 'model-reference');
  assert.equal(f.runtime.store.get('fixture').models[0].contextWindowTokens, 32768, 'metadata refresh alone does not edit saved configuration');
});

test('supplementary provider metadata uses the saved authenticated route, prefix and API-version query without inference', async t => {
  const calls = [];
  const f = await fixture(t, { modelLimitResolver: undefined, fetchImpl: async (url, request) => {
    calls.push({ url, ...request }); assert.equal(request.method, 'GET');
    const target = new URL(url);
    assert.equal(target.search, '?api-version=2026-10-30');
    assert.equal(request.headers['x-api-key'], 'fixture-only-key');
    assert.equal(request.headers['X-Tenant'], 'fixture-tenant');
    if (target.pathname === '/tenant/v1/models') return response({ data: [{ id: 'exact-2026' }] });
    assert.equal(target.pathname, '/tenant/v1/models/exact-2026');
    return response({ id: 'exact-2026', max_input_tokens: 200000, max_tokens: 16000 });
  } });
  const saved = await f.runtime.saveProvider({ id: 'fixture', type: 'anthropic', baseUrl: 'https://metadata-gateway.example/tenant/v1?api-version=2026-10-30',
    apiKey: 'fixture-only-key', headers: { 'X-Tenant': 'fixture-tenant' }, models: ['exact-2026'] }, { preserveDefault: true });
  assert.equal(calls.length, 2);
  assert.equal(saved.models[0].contextWindowTokens, 200000);
  assert.equal(saved.models[0].maxOutputTokens, 16000);
  assert.equal(saved.models[0].contextWindowSource, 'provider-reported');
  assert.equal(saved.models[0].contextWindowEvidence.url, 'https://metadata-gateway.example/tenant/v1/models/exact-2026?api-version=2026-10-30');
});
