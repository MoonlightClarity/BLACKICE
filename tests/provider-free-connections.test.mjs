import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { ProviderStore, normalizeProvider } from '../lib/provider-store.mjs';
import { normalizeCatalogModelMetadata, providerModelMetadata } from '../lib/provider-model-metadata.mjs';
import { providerEndpointURL } from '../lib/provider-endpoints.mjs';
import { createDirectProviderSetupTools } from '../lib/provider-setup-tools.mjs';
import { validDirectArguments } from '../lib/direct-execution-api.mjs';
import { getProviderPreset, providerRequiresApiKey } from '../public/provider-catalog.mjs';
import { createProviderModelSelection } from '../public/connection-models.mjs';
import { browseModels, modelIsFree } from '../public/model-browser.mjs';

const kiloURL = 'https://ai-gateway.kilo.ai/api/v1/models';
const classicURL = 'https://text.pollinations.ai/models';
const kiloModels = [
  { id: 'vendor/zero:free', name: 'Zero', context_length: 131072, top_provider: { max_completion_tokens: 16384 }, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
  { id: 'vendor/paid', name: 'Paid', pricing: { prompt: '1', completion: '1' }, supported_parameters: ['tools'] },
  { id: 'vendor/unknown:free', name: 'Unverified price', supported_parameters: ['tools'] },
];
const classicModels = [{ name: 'openai-fast', description: 'GPT-OSS 20B Reasoning LLM (OVH)', tier: 'anonymous', tools: true, aliases: ['openai', 'gpt-oss-20b'], input_modalities: ['text'], output_modalities: ['text'] }];
class Native extends EventEmitter {
  status() { return { connected: false, authenticated: false, models: [] }; }
  async start() { throw Error('Provider setup must not start native models.'); }
  async runAgent() { throw Error('Provider setup must not run a model.'); }
  async close() {}
}
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'provider-free-')), requests = [], controls = { fail: false };
  const runtime = await new ProviderRuntime({
    codex: new Native(), dataDir,
    modelLimitResolver: { async enrich(_config, models) { return models; } },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), method: options.method, headers: Object.fromEntries(new Headers(options.headers)) });
      assert.equal(options.method, 'GET', 'Catalog checks never generate or start models');
      assert.equal(new Headers(options.headers).has('authorization'), false, 'Anonymous presets send no placeholder key');
      if (controls.fail) return new Response(JSON.stringify({ error: { message: 'Catalog temporarily unavailable' } }), { status: 503 });
      if (String(url) === kiloURL) return Response.json({ data: kiloModels });
      if (String(url) === classicURL) return Response.json(classicModels);
      throw Error('Unexpected endpoint: ' + url);
    },
  }).init();
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, runtime, requests, controls, disk: async () => JSON.parse(await readFile(path.join(dataDir, 'providers.json'), 'utf8')) };
}

test('anonymous presets have durable explicit endpoint defaults and require no key', async t => {
  const f = await fixture(t);
  const original = await f.runtime.saveProvider({ id: 'custom', preset: 'compatible', type: 'compatible', baseUrl: 'https://custom.example/v1', name: 'Existing custom', models: [{ id: 'existing', contextWindowTokens: 8192, maxOutputTokens: 1024 }] });
  await f.runtime.setDefaultModel('custom::existing');
  const originalDisk = (await f.disk()).providers.find(entry => entry.id === 'custom');
  const kilo = await f.runtime.saveProvider({ id: 'kilo_new', preset: 'kilo_free', models: [] });
  const classic = await f.runtime.saveProvider({ id: 'classic_new', preset: 'pollinations_classic', models: [], apiKey: '' });
  for (const saved of [kilo, classic]) {
    assert.equal(saved.configured, true); assert.equal(saved.requiresApiKey, false); assert.equal(saved.hasApiKey, false);
    assert.equal(saved.secretStorage, 'none'); assert.equal(providerRequiresApiKey(saved), false);
  }
  assert.equal(kilo.baseUrl, 'https://ai-gateway.kilo.ai/api/v1');
  assert.deepEqual(classic.endpoints, { models: '/models', chatCompletions: '/openai' });
  assert.equal(providerEndpointURL(classic, 'chat/completions').href, 'https://text.pollinations.ai/openai');
  assert.equal(f.requests.length, 0);
  const restored = new ProviderStore({ dataDir: f.dataDir }); await restored.init();
  assert.equal(restored.defaultModel, 'custom::existing');
  assert.equal(restored.get('custom').updatedAt, original.updatedAt);
  assert.equal(restored.public(restored.get('kilo_new')).configured, true);
  assert.deepEqual(restored.get('classic_new').endpoints, classic.endpoints);
  assert.deepEqual((await f.disk()).providers.find(entry => entry.id === 'custom'), originalDisk);
});

test('free preset catalog scopes exclude paid/unknown pricing and preserve unavailable selected IDs', async t => {
  const f = await fixture(t);
  const selected = await f.runtime.saveProvider({ id: 'free_catalog', preset: 'kilo_free', models: [{ id: 'removed:free', contextWindowTokens: 8192, maxOutputTokens: 1024 }] });
  const result = await f.runtime.discoverModels(selected.id, { refresh: true, freeOnly: false });
  assert.equal(result.filters.freeOnly, true);
  assert.deepEqual(result.models.map(model => model.id), ['vendor/zero:free']);
  assert.deepEqual(result.selectedModels.map(model => model.id), ['removed:free']);
  assert.deepEqual(f.runtime.store.get(selected.id).models.map(model => model.id), ['removed:free']);
  assert.equal(f.runtime.store.get(selected.id).updatedAt, selected.updatedAt);
  assert.equal((await f.disk()).providers.find(provider => provider.id === selected.id).models[0].id, 'removed:free');
});

test('custom connections keep their own complete catalogs even on a host with a free preset', async t => {
  const f = await fixture(t);
  await f.runtime.saveProvider({ id: 'custom_kilo', preset: 'compatible', type: 'compatible', baseUrl: 'https://ai-gateway.kilo.ai/api/v1', models: [] });
  const result = await f.runtime.discoverModels('custom_kilo');
  assert.equal(result.filters.freeOnly, false);
  assert.deepEqual(new Set(result.models.map(model => model.id)), new Set(kiloModels.map(model => model.id)));
});

test('Classic array catalog carries free access, aliases and modalities through model selection, save and cold reload', async t => {
  const f = await fixture(t);
  await f.runtime.saveProvider({ id: 'classic', preset: 'pollinations_classic', models: [] });
  const result = await f.runtime.discoverModels('classic', { query: 'gpt-oss-20b', toolsOnly: true });
  assert.equal(result.models.length, 1); const model = result.models[0];
  assert.equal(model.id, 'openai-fast'); assert.equal(modelIsFree(model), true); assert.equal(model.freeSource, 'provider-reported');
  assert.equal(model.supportsTools, true); assert.deepEqual(model.inputModalities, ['text']); assert.deepEqual(model.outputModalities, ['text']);
  assert.deepEqual(model.aliases, ['openai', 'gpt-oss-20b']);
  const selection = createProviderModelSelection(); selection.setPage(result.models); selection.toggle(model.id, true);
  const saved = await f.runtime.saveProvider({ id: 'classic', models: selection.forSave() });
  assert.equal(modelIsFree(saved.models[0]), true);
  const reloaded = new ProviderStore({ dataDir: f.dataDir }); await reloaded.init();
  const restored = reloaded.public(reloaded.get('classic')).models[0];
  assert.equal(modelIsFree(restored), true); assert.deepEqual(restored.aliases, model.aliases); assert.equal(restored.id, 'openai-fast');
  const selectedAgain = createProviderModelSelection([restored]); selectedAgain.setPage([]);
  assert.equal(modelIsFree(selectedAgain.forSave()[0]), true, 'Catalog pagination cannot discard saved free-access metadata');
});

test('anonymous tier does not label other services or contradictory prices free', () => {
  for (const baseUrl of ['https://gen.pollinations.ai/v1', 'https://other.example', 'https://text.pollinations.ai.evil.example', 'https://text.pollinations.ai:8443']) {
    const { model } = normalizeCatalogModelMetadata(classicModels[0], { baseUrl });
    assert.equal(providerModelMetadata(model, { reported: true }).isFree, undefined);
  }
  const { model } = normalizeCatalogModelMetadata({ ...classicModels[0], pricing: { prompt: '0.01', completion: '0' } }, { baseUrl: 'https://text.pollinations.ai' });
  assert.equal(modelIsFree(providerModelMetadata(model, { reported: true })), false);
  assert.equal(modelIsFree(providerModelMetadata({ ...model, is_free: false }, { reported: true })), false);
});

test('catalog failure leaves selected models and saved provider identity intact', async t => {
  const f = await fixture(t);
  const saved = await f.runtime.saveProvider({ id: 'keep_selected', preset: 'kilo_free', models: [{ id: 'still-selected:free', contextWindowTokens: 8192, maxOutputTokens: 1024 }] });
  const disk = await f.disk(); f.controls.fail = true;
  const result = await f.runtime.discoverModels(saved.id, { refresh: true });
  assert.equal(result.catalogAvailable, false);
  assert.deepEqual(result.selectedModels.map(model => model.id), ['still-selected:free']);
  assert.deepEqual(await f.disk(), disk);
  assert.equal(f.runtime.store.get(saved.id).updatedAt, saved.updatedAt);
});

test('new presets are accepted by direct setup schema and saved without credential import or default changes', async t => {
  const f = await fixture(t);
  const tools = createDirectProviderSetupTools({ runtime: f.runtime, browser: {}, reauthorize: async () => {} });
  const configure = tools.find(tool => tool.definition.name === 'blackice_provider_configure');
  for (const preset of ['kilo_free', 'pollinations_classic']) {
    const args = { requestId: 'new-' + preset, action: 'save', provider: { id: 'direct_' + preset, preset, models: [] }, expectedUpdatedAt: null };
    assert.equal(validDirectArguments(args, configure.definition.inputSchema), true);
    const receipt = JSON.parse((await configure.execute(args, { client: { id: 'fixture' } })).contentItems[0].text);
    assert.equal(receipt.provider.configured, true); assert.equal(receipt.modelStarted, false); assert.equal(receipt.defaultChanged, false);
  }
});

test('explicit custom endpoint settings still override a new preset and omitted edits preserve them', () => {
  const custom = normalizeProvider({ id: 'own_paths', preset: 'pollinations_classic', endpoints: { models: '/my-models', chatCompletions: '/my-chat' } });
  assert.deepEqual(normalizeProvider({ id: custom.id, name: 'Changed label' }, custom).endpoints, custom.endpoints);
  assert.deepEqual(normalizeProvider({ id: custom.id, endpoints: {} }, custom).endpoints, undefined);
  assert.equal(getProviderPreset('openrouter').requiresApiKey, true);
});
