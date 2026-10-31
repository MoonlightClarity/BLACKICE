import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { ProviderStore } from '../lib/provider-store.mjs';
import { providerModelMetadata } from '../lib/provider-model-metadata.mjs';
import { modelIsFree, browseModels } from '../public/model-browser.mjs';

class Native extends EventEmitter {
  status() { return { connected: true, authenticated: true, models: [{ id: 'native', model: 'native' }], defaultModel: 'native' }; }
  async close() {}
  async runAgent() { throw Error('Catalog browsing must not run inference.'); }
}
const response = (body, headers = {}) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', ...headers } });
const complete = (id, context = 32768, pricing) => ({ id, context_length: context, max_output_tokens: 4096, ...(pricing ? { pricing } : {}) });
async function fixture(t, fetchImpl, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'provider-multi-endpoint-')), requests = [];
  const runtime = await new ProviderRuntime({ codex: new Native(), dataDir, modelLimitResolver: { enrich: async (_config, models) => models },
    fetchImpl: async (url, init) => { requests.push({ url, init }); assert.equal(init.method, 'GET'); return fetchImpl(url, init, requests.length); }, ...options }).init();
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { runtime, requests, dataDir };
}
const config = (id = 'fixture', extra = {}) => ({ id, name: id, type: 'compatible', baseUrl: 'https://catalog.example/v1', models: [], ...extra });

test('Anthropic pagination fetches every upstream page before search/sort, preserves auth/query/path and caches the complete catalog', async t => {
  const f = await fixture(t, (url, init) => {
    const parsed = new URL(url); assert.equal(parsed.origin, 'https://anthropic.example'); assert.equal(parsed.pathname, '/tenant/catalog');
    assert.equal(parsed.searchParams.get('api-version'), '2026-10'); assert.equal(init.headers['x-api-key'], 'fixture-key'); assert.equal(init.headers['X-Catalog-Account'], 'fixture-account');
    const cursor = parsed.searchParams.get('after_id');
    return response(cursor === null ? { data: [complete('alpha', 10000)], has_more: true, last_id: 'opaque first' }
      : cursor === 'opaque first' ? { data: [complete('beta', 20000)], has_more: true, last_id: 'opaque second' }
      : { data: [complete('gamma', 40000)], has_more: false, last_id: 'gamma' });
  });
  await f.runtime.saveProvider(config('fixture', { type: 'anthropic', baseUrl: 'https://anthropic.example/v1?api-version=2026-10', endpoints: { models: '/tenant/catalog' }, apiKey: 'fixture-key', headers: { 'X-Catalog-Account': 'fixture-account' } }));
  const before = await readFile(path.join(f.dataDir, 'providers.json'), 'utf8');
  const first = await f.runtime.discoverModels('fixture', { query: 'gamma', sort: 'context-desc', limit: 1 });
  assert.deepEqual(first.models.map(x => x.id), ['gamma']); assert.equal(first.totalModels, 3); assert.equal(first.total, 1); assert.equal(first.hasMore, false);
  const later = await f.runtime.discoverModels('fixture', { sort: 'context-desc', offset: 1, limit: 1 });
  assert.deepEqual(later.models.map(x => x.id), ['beta']); assert.equal(f.requests.length, 3);
  assert.equal(await readFile(path.join(f.dataDir, 'providers.json'), 'utf8'), before);
});

test('compatible catalogs follow cursor and page-token envelopes without guessing model IDs', async t => {
  for (const [field, parameter, nested] of [['next_cursor', 'cursor', false], ['nextCursor', 'cursor', true], ['next_page_token', 'page_token', false], ['nextPageToken', 'pageToken', false]]) {
    await t.test(field, async t => {
      const f = await fixture(t, url => {
        const next = new URL(url).searchParams.get(parameter); assert.ok(next === null || next === 'opaque +/? value');
        return response({ data: [complete(next ? 'last' : 'first')], ...(nested ? { pagination: { [field]: next ? null : 'opaque +/? value' } } : { [field]: next ? null : 'opaque +/? value' }) });
      });
      await f.runtime.saveProvider(config()); const result = await f.runtime.discoverModels('fixture');
      assert.equal(result.totalModels, 2); assert.deepEqual(result.models.map(x => x.id), ['first', 'last']); assert.equal(f.requests.length, 2);
    });
  }
});

test('advertised same-origin Link pages retain configured query and headers, while duplicate model IDs are deduplicated', async t => {
  const f = await fixture(t, (url, init, count) => {
    const parsed = new URL(url); assert.equal(parsed.searchParams.get('api-version'), 'v3'); assert.equal(init.headers.Authorization, 'Bearer fixture-key');
    return count === 1 ? response({ data: [complete('same')] }, { Link: '</other/catalog?cursor=next>; rel="next"' }) : response({ data: [complete('same'), complete('second')] });
  });
  await f.runtime.saveProvider(config('fixture', { baseUrl: 'https://catalog.example/v1?api-version=v3', apiKey: 'fixture-key' }));
  const result = await f.runtime.discoverModels('fixture'); assert.equal(result.totalModels, 2); assert.equal(f.requests.length, 2); assert.equal(new URL(f.requests[1].url).pathname, '/other/catalog');
});

test('cross-origin pages, repeated pages and unsupported continuation fail without publishing a partial catalog', async t => {
  const cases = [
    ['cross origin', { links: { next: 'https://elsewhere.example/models' } }],
    ['repeat', { links: { next: 'https://catalog.example/v1/models' } }],
    ['missing cursor', { has_more: true }],
    ['nested missing cursor', { pagination: { has_more: true } }],
    ['unsupported next', { next: 2 }],
  ];
  for (const [name, continuation] of cases) await t.test(name, async t => {
    const f = await fixture(t, () => response({ data: [complete('first')], ...continuation })); await f.runtime.saveProvider(config());
    await assert.rejects(f.runtime.discoverModels('fixture'), { code: 'PROVIDER_CATALOG_PAGINATION' }); assert.equal(f.requests.length, 1); assert.equal(f.runtime.modelCatalogs.has('fixture'), false);
  });
});

test('the page and row bounds report incomplete discovery instead of presenting the prefix as a full catalog', async t => {
  const f = await fixture(t, (_url, _init, count) => response({ data: [complete('model-' + count)], next_cursor: String(count) }));
  await f.runtime.saveProvider(config()); await assert.rejects(f.runtime.discoverModels('fixture'), /exceeds 100 pages/); assert.equal(f.requests.length, 100); assert.equal(f.runtime.modelCatalogs.has('fixture'), false);
  const large = await fixture(t, () => response({ data: Array.from({ length: 10001 }, (_, i) => ({ id: 'model-' + i })) })); await large.runtime.saveProvider(config());
  await assert.rejects(large.runtime.discoverModels('fixture'), /exceeds 10,000 entries/); assert.equal(large.runtime.modelCatalogs.has('fixture'), false);
});

test('cancellation and timeout stop upstream pagination and retain no partial cache', async t => {
  const controller = new AbortController();
  const cancelled = await fixture(t, () => { controller.abort(new Error('Stop catalog lookup')); return response({ data: [complete('first')], next_cursor: 'more' }); });
  await cancelled.runtime.saveProvider(config()); await assert.rejects(cancelled.runtime.discoverModels('fixture', { signal: controller.signal }), /Stop catalog lookup/); assert.equal(cancelled.requests.length, 1); assert.equal(cancelled.runtime.modelCatalogs.has('fixture'), false);
  const timed = await fixture(t, (_url, init, count) => count === 1 ? response({ data: [complete('first')], next_cursor: 'more' }) : new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })), { requestTimeoutMs: 25 });
  await timed.runtime.saveProvider(config()); await assert.rejects(timed.runtime.discoverModels('fixture'), { code: 'PROVIDER_TIMEOUT' }); assert.equal(timed.requests.length, 2); assert.equal(timed.runtime.modelCatalogs.has('fixture'), false);
});

test('free filters accept provider-reported zero prices without a :free suffix and explicit free flags, excluding unknown and conflicting charges', () => {
  const raw = [
    { id: 'plain-zero', pricing: { input: 0, output: 0 } },
    { id: 'token-zero', pricing: { input_tokens: '0.0', output_tokens: '0e0' } },
    { id: 'explicit', is_free: true },
    { id: 'paid', pricing: { prompt: '0', completion: '0.1' } },
    { id: 'unknown:free' },
    { id: 'missing-output', pricing: { input: 0 } },
    { id: 'charged-request', pricing: { prompt: 0, completion: 0, request: 1 } },
    { id: 'contradiction', is_free: true, pricing: { prompt: '1', completion: '1' } },
    { id: 'explicit-paid', is_free: false, pricing: { prompt: '0', completion: '0' } },
  ];
  const models = raw.map(item => ({ id: item.id, ...providerModelMetadata(item, { reported: true }) }));
  assert.deepEqual(browseModels(models, { freeOnly: true }).map(x => x.id), ['explicit', 'plain-zero', 'token-zero']);
  assert.equal(modelIsFree({ id: 'manual', ...providerModelMetadata({ is_free: true }) }), false);
  assert.equal(modelIsFree({ id: 'manual-zero', ...providerModelMetadata({ pricing: { input: 0, output: 0 } }) }), false);
});

test('public Hugging Face and DeepInfra catalogs work without keys and keep generation unconfigured', async t => {
  const f = await fixture(t, url => new URL(url).hostname === 'router.huggingface.co' ? response({ data: [{ id: 'org/shared', architecture: { input_modalities: ['text', 'image'] }, providers: [
    { provider: 'first', status: 'live', context_length: 65536, pricing: { input: 0.1, output: 0.2 }, is_free: false, supports_tools: true },
    { provider: 'second', status: 'live', context_length: 512000, pricing: { input: 0.3, output: 0.4 }, is_free: false, supports_tools: true },
    { provider: 'unknown', status: 'live' },
    { provider: 'offline', status: 'error', context_length: 1000 },
  ] }] }) : response({ data: [{ id: 'org/shared', metadata: { context_length: 131072, max_tokens: 131072, pricing: { input_tokens: 0, output_tokens: 0 }, tags: ['chat'] } }] }));
  const hf = await f.runtime.saveProvider(config('hf_public', { preset: 'huggingface', baseUrl: 'https://router.huggingface.co/v1' }));
  const deep = await f.runtime.saveProvider(config('deep_public', { preset: 'deepinfra', baseUrl: 'https://api.deepinfra.com/v1/openai' }));
  assert.equal(hf.configured, false); assert.equal(deep.configured, false);
  const hfCatalog = await f.runtime.discoverModels('hf_public'), deepCatalog = await f.runtime.discoverModels('deep_public');
  const hm = hfCatalog.models[0], dm = deepCatalog.models[0];
  assert.equal(hm.contextWindowTokens, 65536); assert.equal(hm.contextWindowSource, 'model-reference'); assert.equal(hm.contextWindowEvidence.endpointSpecific, false);
  assert.match(hm.contextWindowEvidence.label, /minimum of 2 reported routes; 1 route limits unknown; routing unconfirmed/);
  assert.equal(hm.supportsTools, undefined); assert.equal(modelIsFree(hm), false); assert.equal(hm.maxOutputTokens, null);
  assert.equal(dm.contextWindowTokens, 131072); assert.equal(dm.contextWindowSource, 'provider-reported'); assert.equal(dm.maxOutputTokens, null); assert.equal(modelIsFree(dm), true);
  assert.equal(f.runtime.listProviders().find(x => x.id === 'hf_public').configured, false); assert.equal(f.runtime.listProviders().find(x => x.id === 'deep_public').configured, false);
  assert.ok(f.requests.every(x => !x.init.headers.Authorization && !x.init.headers['x-api-key']));
  await f.runtime.discoverModels('hf_public', { query: 'shared' }); await f.runtime.discoverModels('deep_public', { freeOnly: true }); assert.equal(f.requests.length, 2);
});

test('DeepInfra vision/vlm tags identify image input without treating image generation, embeddings or text as vision', async t => {
  const f = await fixture(t, () => response({ data: [
    { id: 'known-vision', metadata: { context_length: 131072, tags: ['chat', 'vision'] } },
    { id: 'known-vlm', architecture: { input_modalities: ['text'] }, metadata: { tags: ['vlm'] } },
    { id: 'image-generation', architecture: { output_modalities: ['image'] }, metadata: { tags: ['image-gen'] } },
    { id: 'embedding', metadata: { tags: ['embed'] } },
    { id: 'text-only', metadata: { tags: ['chat', 'reasoning'] } },
  ] }));
  await f.runtime.saveProvider(config('deep_public', { preset: 'deepinfra', baseUrl: 'https://api.deepinfra.com/v1/openai' }));
  const result = await f.runtime.discoverModels('deep_public', { visionOnly: true });
  assert.equal(result.totalModels, 5); assert.deepEqual(result.models.map(model => model.id), ['known-vision', 'known-vlm']);
  assert.deepEqual(result.models.find(model => model.id === 'known-vlm').inputModalities, ['text', 'image']);
  assert.ok(result.models.every(model => model.supportsTools === undefined));
});

test('Hugging Face routing does not claim mixed free/tool support, but accepts universally explicit reported support', async t => {
  const f = await fixture(t, () => response({ data: [
    { id: 'all-free', providers: [{ status: 'live', is_free: true, supports_tools: true }, { status: 'live', pricing: { input: 0, output: 0 }, supports_tools: true }] },
    { id: 'mixed', providers: [{ status: 'live', is_free: true, supports_tools: true }, { status: 'live', is_free: false, supports_tools: false }] },
    { id: 'unknown-route', providers: [{ status: 'live', is_free: true, supports_tools: true }, { status: 'live' }] },
  ] }));
  await f.runtime.saveProvider(config('hf_public', { preset: 'huggingface', baseUrl: 'https://router.huggingface.co/v1' }));
  const result = await f.runtime.discoverModels('hf_public', { freeOnly: true, toolsOnly: true }); assert.deepEqual(result.models.map(x => x.id), ['all-free']);
});

test('saved-model revisions reject stale edits and deleted/recreated providers without overwriting external models or credentials', async t => {
  const f = await fixture(t, () => { throw Error('Known manual limits require no catalog request.'); });
  const first = await f.runtime.saveProvider(config('fixture', { apiKey: 'fixture-key', models: [{ id: 'first', contextWindowTokens: 32768, maxOutputTokens: 4096 }], expectedUpdatedAt: null }));
  const external = await f.runtime.saveProvider({ id: 'fixture', models: [{ id: 'external', contextWindowTokens: 65536, maxOutputTokens: 4096 }], expectedUpdatedAt: first.updatedAt });
  await assert.rejects(f.runtime.saveProvider({ ...first, name: 'Stale edit', expectedUpdatedAt: first.updatedAt }), { code: 'PROVIDER_CHANGED', status: 409 });
  assert.deepEqual(f.runtime.listProviders()[0].models.map(x => x.id), ['external']); assert.equal(f.runtime.store.key('fixture'), 'fixture-key');
  const accepted = await f.runtime.saveProvider({ id: 'fixture', name: 'Fresh edit', expectedUpdatedAt: external.updatedAt }); assert.equal(accepted.name, 'Fresh edit');
  await f.runtime.removeProvider('fixture');
  await assert.rejects(f.runtime.saveProvider({ ...accepted, expectedUpdatedAt: accepted.updatedAt }), { code: 'PROVIDER_CHANGED', status: 409 });
  const reloaded = new ProviderStore({ dataDir: f.dataDir }); await reloaded.init(); assert.equal(reloaded.list().length, 0); assert.equal(f.requests.length, 0);
});

test('invalid revisions fail before any request and concurrent same-revision saves cannot both succeed', async t => {
  const f = await fixture(t, () => { throw Error('This test must not fetch a catalog.'); });
  await assert.rejects(f.runtime.saveProvider(config('fixture', { expectedUpdatedAt: 123 })), { code: 'INVALID_PROVIDER_REVISION', status: 400 });
  const original = await f.runtime.saveProvider(config('fixture', { expectedUpdatedAt: null }));
  const results = await Promise.allSettled([f.runtime.saveProvider({ id: 'fixture', name: 'One', expectedUpdatedAt: original.updatedAt }), f.runtime.saveProvider({ id: 'fixture', name: 'Two', expectedUpdatedAt: original.updatedAt })]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); assert.equal(results.find(x => x.status === 'rejected').reason.code, 'PROVIDER_CHANGED');
  assert.equal(f.requests.length, 0);
});
