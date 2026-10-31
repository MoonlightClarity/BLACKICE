import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderStore, normalizeProvider } from '../lib/provider-store.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';
import { modelLimitMetadata, modelLimitReport } from '../lib/provider-model-metadata.mjs';
import { contextSnapshot } from '../lib/context.mjs';
import { CodexRuntime } from '../lib/codex.mjs';
import { createDirectProviderSetupTools } from '../lib/provider-setup-tools.mjs';
import { validDirectArguments } from '../lib/direct-execution-api.mjs';

const advertisedAt = '2026-10-30T18:00:00.000Z';
const reported = { id: 'known', contextWindowTokens: 65536, contextWindowSource: 'provider-reported', contextWindowObservedAt: advertisedAt,
  maxOutputTokens: 8192, maxOutputTokensSource: 'provider-reported', maxOutputObservedAt: advertisedAt };
class Native extends EventEmitter {
  status() { return { connected: true, authenticated: true, defaultModel: 'native-known', models: [
    { id: 'native-known', model: 'native-known', contextWindowTokens: 256000, maxOutputTokens: 32000 },
    { id: 'native-unknown', model: 'native-unknown' }
  ] }; }
  async close() {}
  async runAgent() { throw Error('Model addition must never start inference.'); }
}
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const config = { id: 'fixture', type: 'compatible', baseUrl: 'https://synthetic-models.example/v1' };
async function fixture(t, handler = () => response({ data: [] }), options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'model-limit-report-')), requests = [];
  const runtime = await new ProviderRuntime({ codex: new Native(), dataDir: dir, ...options, fetchImpl: async (url, options) => {
    requests.push({ url, method: options.method, body: options.body });
    assert.equal(options.method, 'GET', 'onboarding reads the catalog without inference');
    return handler(url, options);
  } }).init();
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, runtime, requests };
}

test('both limits are explicitly unknown without confusing a working budget or provider output setting with capacity', () => {
  const unknown = modelLimitReport({ id: 'unknown', maxTokens: 4096, contextStatus: { effectiveWindowTokens: 128000 } });
  assert.equal(unknown.contextWindowTokens, null); assert.equal(unknown.contextWindowSource, 'unknown');
  assert.equal(unknown.maxOutputTokens, null); assert.equal(unknown.maxOutputTokensSource, 'unknown');
  const budget = contextSnapshot({ maxOutputTokens: 4096 });
  assert.equal(budget.modelWindowTokens, null); assert.equal(budget.effectiveWindowTokens, 128000); assert.equal(budget.windowSource, 'working-budget');
});

test('positive reported capacities retain their values outside old arbitrary metadata bounds', () => {
  for (const contextWindowTokens of [1024, 8000000]) {
    const limits = modelLimitMetadata({ context_length: contextWindowTokens, top_provider: { max_completion_tokens: 9000000 } }, { reported: true, reportedAt: advertisedAt });
    assert.equal(limits.contextWindowTokens, contextWindowTokens); assert.equal(limits.maxOutputTokens, 9000000);
    assert.equal(limits.contextWindowSource, 'provider-reported'); assert.equal(limits.maxOutputTokensSource, 'provider-reported');
    const saved = normalizeProvider({ ...config, models: [{ id: 'capacity', ...limits }] }, {}, { reported: true, reportedAt: advertisedAt });
    assert.equal(saved.models[0].contextWindowTokens, contextWindowTokens);
    const budget = contextSnapshot({ modelWindowTokens: contextWindowTokens, modelWindowSource: 'provider-reported', maxOutputTokens: 128 });
    assert.equal(budget.effectiveWindowTokens, contextWindowTokens);
  }
});

test('unverified caller source labels cannot turn manual capacities into provider reports', () => {
  const saved = normalizeProvider({ ...config, models: [reported] });
  assert.equal(saved.models[0].contextWindowSource, 'user-configured'); assert.equal(saved.models[0].maxOutputTokensSource, 'user-configured');
  assert.equal(saved.models[0].contextWindowObservedAt, undefined); assert.equal(saved.models[0].maxOutputObservedAt, undefined);
});

test('direct setup schema accepts positive or explicitly unknown capacities while provenance remains server-owned', async t => {
  const f = await fixture(t), tools = createDirectProviderSetupTools({ runtime: f.runtime, browser: {}, reauthorize: async () => {} });
  const configure = tools.find(tool => tool.definition.name === 'blackice_provider_configure'), schema = configure.definition.inputSchema;
  const payload = { requestId: 'limits-schema', action: 'save', provider: { ...config, models: [{ id: 'known', contextWindowTokens: 1, maxOutputTokens: Number.MAX_SAFE_INTEGER }] }, expectedUpdatedAt: null };
  assert.equal(validDirectArguments(payload, schema), true);
  assert.equal(validDirectArguments({ ...payload, provider: { ...config, models: [{ id: 'known', contextWindowTokens: null, maxOutputTokens: null }] } }, schema), true);
  assert.equal(validDirectArguments({ ...payload, provider: { ...config, models: [{ id: 'known', contextWindowTokens: 0 }] } }, schema), false);
  assert.equal(validDirectArguments({ ...payload, provider: { ...config, models: [{ id: 'known', contextWindowTokens: 4096, contextWindowSource: 'provider-reported' }] } }, schema), false);
  const result = JSON.parse((await configure.execute(payload, { client: { id: 'fixture-client' } })).contentItems[0].text);
  assert.equal(result.provider.models[0].contextWindowSource, 'user-configured'); assert.equal(result.provider.models[0].maxOutputTokensSource, 'user-configured');
  assert.equal(result.defaultChanged, false); assert.equal(result.modelStarted, false); assert.equal(f.requests.length, 0);
});

test('limits and provenance survive save, string/name edits and reload; explicit null clears them', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'saved-model-limits-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ProviderStore({ dataDir: dir });
  const first = await store.save({ ...config, models: [reported] }, { trustedModels: [reported] });
  const edited = await store.save({ id: config.id, models: [{ id: 'known', displayName: 'Readable label' }] }, { expectedUpdatedAt: first.updatedAt });
  assert.equal(edited.models[0].contextWindowTokens, 65536); assert.equal(edited.models[0].maxOutputTokens, 8192);
  assert.equal(edited.models[0].contextWindowSource, 'provider-reported'); assert.equal(edited.models[0].maxOutputTokensSource, 'provider-reported');
  const restored = new ProviderStore({ dataDir: dir }); await restored.init();
  assert.deepEqual(restored.public(restored.get(config.id)).models, edited.models);
  const manual = await restored.save({ id: config.id, models: [{ id: 'known', contextWindowTokens: 32000 }] });
  assert.equal(manual.models[0].contextWindowSource, 'user-configured'); assert.equal(manual.models[0].contextWindowObservedAt, undefined);
  assert.equal(manual.models[0].maxOutputTokensSource, 'provider-reported');
  const cleared = await restored.save({ id: config.id, models: [{ id: 'known', contextWindowTokens: null, maxOutputTokens: null }] });
  assert.equal(cleared.models[0].contextWindowTokens, null); assert.equal(cleared.models[0].contextWindowSource, 'unknown');
  assert.equal(cleared.models[0].maxOutputTokens, null); assert.equal(cleared.models[0].maxOutputTokensSource, 'unknown');
});

test('new manually named models get one catalog lookup, retain both reported limits, and do not select a default', async t => {
  const f = await fixture(t, () => response({ data: [{ id: 'known', context_length: 65536, top_provider: { max_completion_tokens: 8192 } }] }));
  const saved = await f.runtime.saveProvider({ ...config, models: ['known'], maxTokens: 4096 }, { preserveDefault: true });
  assert.equal(f.requests.length, 1); assert.equal(saved.models[0].contextWindowTokens, 65536); assert.equal(saved.models[0].maxOutputTokens, 8192);
  assert.equal(saved.models[0].contextWindowSource, 'provider-reported'); assert.equal(saved.models[0].maxOutputTokensSource, 'provider-reported');
  assert.equal(saved.maxTokens, 4096); assert.equal(saved.modelLimitDiscovery.status, 'reported'); assert.equal(f.runtime.store.defaultModel, null);
  const stored = JSON.parse(await readFile(path.join(f.dir, 'providers.json'), 'utf8')).providers[0];
  assert.equal(stored.models[0].contextWindowTokens, 65536); assert.equal(stored.models[0].maxOutputTokensSource, 'provider-reported');
  const edited = await f.runtime.saveProvider({ id: config.id, models: [{ id: 'known', displayName: 'Renamed' }] }, { expectedUpdatedAt: saved.updatedAt, preserveDefault: true });
  assert.equal(f.requests.length, 1); assert.equal(edited.models[0].contextWindowTokens, 65536);
});

test('fresh catalog reuse supplies newly added model metadata without another request', async t => {
  const f = await fixture(t, () => response({ data: [{ id: 'first', context_length: 32768 }, { id: 'second', context_length: 65536, max_output_tokens: 4096 }] }));
  const first = await f.runtime.saveProvider({ ...config, models: ['first'] }, { preserveDefault: true });
  assert.equal(first.models[0].maxOutputTokens, null);
  const second = await f.runtime.saveProvider({ id: config.id, models: ['first', 'second'] }, { expectedUpdatedAt: first.updatedAt, preserveDefault: true });
  assert.equal(f.requests.length, 1); assert.equal(second.models[1].contextWindowTokens, 65536); assert.equal(second.models[1].maxOutputTokens, 4096);
  assert.equal(second.modelLimitDiscovery.status, 'cached');
});

test('model IDs are normalized before a newly added model receives matching catalog capacities', async t => {
  const f = await fixture(t, () => response({ data: [{ id: 'known', context_length: 65536, max_output_tokens: 8192 }] }));
  const saved = await f.runtime.saveProvider({ ...config, models: [' known '] }, { preserveDefault: true });
  assert.equal(saved.models[0].id, 'known'); assert.equal(saved.models[0].contextWindowTokens, 65536);
  assert.equal(saved.models[0].maxOutputTokens, 8192); assert.equal(f.requests.length, 1);
});

test('changed provider identity never reuses old reported limits, including full model objects echoed by the UI', async t => {
  for (const echo of [false, true]) await t.test(`echo=${echo}`, async t => {
    const f = await fixture(t, url => response({ data: [{ id: 'known', context_length: url.includes('replacement') ? 32768 : 65536, max_output_tokens: url.includes('replacement') ? 2048 : 8192 }] }));
    const original = await f.runtime.saveProvider({ ...config, models: ['known'] }, { preserveDefault: true });
    const saved = await f.runtime.saveProvider({ id: config.id, baseUrl: 'https://replacement.example/v1', ...(echo ? { models: original.models } : {}) }, { preserveDefault: true });
    assert.equal(f.requests.length, 2); assert.equal(saved.models[0].contextWindowTokens, 32768); assert.equal(saved.models[0].maxOutputTokens, 2048);
    assert.equal(saved.models[0].contextWindowSource, 'provider-reported'); assert.equal(saved.models[0].maxOutputTokensSource, 'provider-reported');
  });
  const original = normalizeProvider({ ...config, models: [reported] }, {}, { reported: true, reportedAt: advertisedAt });
  for (const change of [{ type: 'openai' }, { endpoints: { chatCompletions: '/chat' } }]) {
    const changed = normalizeProvider({ id: config.id, ...change, models: original.models }, original);
    assert.equal(changed.models[0].contextWindowTokens, undefined); assert.equal(changed.models[0].maxOutputTokens, undefined);
  }
});

test('a changed endpoint with an unavailable catalog becomes unknown while manual capacity overrides remain manual', async t => {
  const f = await fixture(t, () => { throw Error('Synthetic unavailable catalog.'); });
  const original = await f.runtime.store.save({ ...config, models: [reported] }, { trustedModels: [reported] });
  const saved = await f.runtime.saveProvider({ id: config.id, baseUrl: 'https://replacement.example/v1', models: original.models }, { preserveDefault: true });
  assert.equal(saved.models[0].contextWindowTokens, null); assert.equal(saved.models[0].maxOutputTokens, null);
  assert.equal(saved.models[0].contextWindowObservedAt, undefined); assert.equal(saved.models[0].maxOutputObservedAt, undefined);
  const manual = await f.runtime.saveProvider({ id: config.id, models: [{ id: 'known', contextWindowTokens: 32768, maxOutputTokens: 4096 }] }, { preserveDefault: true });
  const moved = await f.runtime.saveProvider({ id: config.id, baseUrl: 'https://third.example/v1', models: manual.models }, { preserveDefault: true });
  assert.equal(moved.models[0].contextWindowTokens, 32768); assert.equal(moved.models[0].contextWindowSource, 'user-configured');
  assert.equal(moved.models[0].maxOutputTokens, 4096); assert.equal(f.requests.length, 1);
});

test('save preconditions reject incompatible credential reuse, missing encryption, and cancellation before any lookup', async t => {
  const f = await fixture(t);
  await f.runtime.store.save({ ...config, type: 'openai', apiKey: 'existing-fixture-only-key', models: [] });
  await assert.rejects(f.runtime.saveProvider({ id: config.id, type: 'compatible', baseUrl: 'https://replacement.example/v1', models: ['new'] }), { code: 'INVALID_PROVIDER' });
  await assert.rejects(f.runtime.saveProvider({ id: 'new', type: 'openai', apiKey: 'new-fixture-only-key', models: ['new'] }, { requireEncrypted: true }), { code: 'PROVIDER_SECRET_STORAGE_UNAVAILABLE' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.runtime.saveProvider({ ...config, models: ['new'] }, { signal: controller.signal }), { code: 'ABORT_ERR' });
  assert.equal(f.requests.length, 0); assert.equal(f.runtime.store.get(config.id).type, 'openai'); assert.equal(f.runtime.store.get('new'), undefined);
});

test('an unavailable or incomplete catalog still saves explicit unknowns, with no invented capacity or inference', async t => {
  for (const fail of [false, true]) await t.test(String(fail), async t => {
    const f = await fixture(t, () => { if (fail) throw Error('Synthetic unreachable catalog.'); return response({ data: ['unknown'] }); });
    const saved = await f.runtime.saveProvider({ ...config, models: ['unknown'], maxTokens: 4096 }, { preserveDefault: true });
    assert.equal(f.requests.length, 1); assert.equal(saved.models[0].contextWindowTokens, null); assert.equal(saved.models[0].maxOutputTokens, null);
    assert.equal(saved.modelLimitDiscovery.status, fail ? 'unavailable' : 'reported');
    assert.equal(f.runtime.status().models.find(model => model.id === 'fixture::unknown').contextWindowSource, 'unknown');
  });
});

test('a timed out capacity lookup still completes the save with unknown limits and unchanged defaults', async t => {
  const f = await fixture(t, () => new Promise(() => {}), { requestTimeoutMs: 10 });
  const saved = await f.runtime.saveProvider({ ...config, models: ['unknown'] }, { preserveDefault: true });
  assert.equal(saved.modelLimitDiscovery.status, 'unavailable'); assert.equal(saved.modelLimitDiscovery.code, 'PROVIDER_TIMEOUT');
  assert.equal(saved.models[0].contextWindowTokens, null); assert.equal(saved.models[0].maxOutputTokens, null);
  assert.equal(f.requests.length, 1); assert.equal(f.runtime.store.defaultModel, null); assert.equal(f.runtime.store.automaticDefaultModel, null);
});

test('a configuration edited during onboarding lookup is never overwritten by its stale save', async t => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, async () => { entered(); await new Promise(resolve => { release = resolve; }); return response({ data: [{ id: 'known', context_length: 65536 }] }); });
  const baseline = await f.runtime.store.save({ ...config, models: [] });
  const pending = f.runtime.saveProvider({ id: config.id, models: ['known'] }, { expectedUpdatedAt: baseline.updatedAt, preserveDefault: true });
  await ready;
  const changed = await f.runtime.store.save({ id: config.id, name: 'Concurrent edit' });
  release(); await assert.rejects(pending, { code: 'PROVIDER_CHANGED' });
  assert.equal(f.runtime.store.get(config.id).updatedAt, changed.updatedAt); assert.deepEqual(f.runtime.store.get(config.id).models, []);
});

test('native and custom model additions always return a capacity report', async t => {
  const f = await fixture(t);
  let catalog = f.runtime.codexModelCatalog();
  const known = catalog.models.find(model => model.id === 'native-known');
  assert.equal(known.contextWindowTokens, 256000); assert.equal(known.contextWindowSource, 'provider-reported');
  assert.equal(known.maxOutputTokens, 32000); assert.equal(known.maxOutputTokensSource, 'provider-reported');
  assert.equal(catalog.models.find(model => model.id === 'native-unknown').contextWindowTokens, null);
  catalog = await f.runtime.addCodexModel('native-custom');
  const custom = catalog.models.find(model => model.id === 'native-custom');
  assert.equal(custom.contextWindowTokens, null); assert.equal(custom.maxOutputTokens, null); assert.equal(f.requests.length, 0);
});

test('native catalog normalization retains advertised context and output capacities', async () => {
  const native = new CodexRuntime(); native.child = {};
  native._request = async method => method === 'account/read' ? { requiresOpenaiAuth: false } : { data: [
    { id: 'small', model: 'small', context_window: 2048, max_output_tokens: 512 },
    { id: 'unknown', model: 'unknown', maxOutputTokens: 'not-a-capacity' },
    { id: 'alias', model: 'alias', context_length: 4096, max_completion_tokens: 256 }
  ] };
  const status = await native._refreshCatalog();
  assert.equal(status.models[0].contextWindowTokens, 2048); assert.equal(status.models[0].contextWindowSource, 'provider-reported');
  assert.equal(status.models[0].maxOutputTokens, 512); assert.equal(status.models[0].maxOutputTokensSource, 'provider-reported');
  assert.equal(status.models[1].maxOutputTokens, undefined);
  assert.equal(status.models[2].contextWindowTokens, 4096); assert.equal(status.models[2].maxOutputTokens, 256); native.child = null;
});

test('output truncation reports saved capacity separately from configured budget without suggesting an impossible limit increase', async t => {
  for (const capacity of [null, 1500]) await t.test(String(capacity), async t => {
    const f = await fixture(t); const requests = [];
    f.runtime.fetchImpl = async (_url, options) => {
      requests.push(options); return response({ choices: [{ message: { role: 'assistant', content: 'Partial response.' }, finish_reason: 'length' }] });
    };
    await f.runtime.store.save({ ...config, maxTokens: 8192, models: [{ id: 'limited', ...(capacity ? { maxOutputTokens: capacity } : {}) }] });
    await assert.rejects(f.runtime.runAgent({ cwd: f.dir, model: 'fixture::limited', prompt: 'Fixture response.' }), cause => {
      assert.equal(cause.code, 'PROVIDER_TRUNCATED'); assert.match(cause.message, /Configured output budget: 8,192 tokens/);
      assert.match(cause.message, capacity ? /maximum output: 1,500 tokens \(user-configured\)/ : /capacity: unknown; the provider did not report it/);
      assert.match(cause.message, /smaller response or choose a model/); assert.doesNotMatch(cause.message, /Increase/); return true;
    });
    assert.equal(requests.length, 1, 'truncation never retries or switches models');
    assert.equal(JSON.parse(requests[0].body).max_tokens, capacity || 8192);
  });
});
