import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderRuntime, ProviderStore } from '../lib/providers.mjs';
import { createProviderModelSelection } from '../public/connection-models.mjs';
import { chatOptionChoices, validateChatOptions } from '../public/next/chat/options-model.mjs';

// Fictional IDs exercise the documented /v1/models schema, not account access.
// https://docs.mistral.ai/api/endpoint/models
const cards = [
  { id: 'fixture-chat-vision', name: 'Fixture vision chat', max_context_length: 131072, capabilities: { completion_chat: true, function_calling: true, vision: true }, aliases: ['fixture-vision-latest'] },
  { id: 'fixture-chat-text', name: 'Fixture text chat', max_context_length: 32768, capabilities: { completion_chat: true, function_calling: false, vision: false } },
  ...['embedding', 'ocr', 'audio'].map(task => ({ id: 'fixture-' + task, max_context_length: 8192, capabilities: { completion_chat: false, function_calling: false, vision: task === 'ocr' } })),
  { id: 'fixture-unknown', max_context_length: 8192 },
  { id: 'fixture-archived', archived: true, max_context_length: 8192, capabilities: { completion_chat: true, function_calling: true, vision: false } },
];
const limits = { enrich: async (_config, models) => models };
const encryptSecret = value => Buffer.from(value).reverse();
const decryptSecret = value => Buffer.from(value).reverse().toString();
async function fixture(t, { baseUrl = 'https://api.mistral.ai/v1', catalog = cards, preset = 'mistral' } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-mistral-catalog-'));
  const requests = [], codex = new EventEmitter();
  codex.status = () => ({ connected: true, authenticated: true, defaultModel: 'native-fixture', models: [{ id: 'native-fixture', displayName: 'Native fixture', supportedReasoningEfforts: [] }] });
  codex.close = async () => {};
  // Every request is intercepted here. No external network or real credential is used.
  const fetchImpl = async (url, options) => {
    const target = new URL(url), body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url: target.href, method: options.method || 'GET', body });
    assert.equal(target.origin, new URL(baseUrl).origin);
    if (target.pathname === '/v1/models') return Response.json({ object: 'list', data: catalog });
    assert.equal(target.pathname, '/v1/chat/completions');
    return Response.json({ id: 'fixture-completion', choices: [{ message: { role: 'assistant', content: 'Fixture accepted' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } });
  };
  const runtime = await new ProviderRuntime({ codex, dataDir, fetchImpl, modelLimitResolver: limits, encryptSecret, decryptSecret }).init();
  t.after(async () => { await runtime.close(); assert.match(path.basename(dataDir), /^blackice-mistral-catalog-/); await rm(dataDir, { recursive: true, force: true }); });
  await runtime.setDefaultModel('native-fixture');
  await runtime.saveProvider({ id: 'mistral_fixture', name: 'Fixture API', type: 'compatible', preset, baseUrl, models: [], apiKey: 'fixture-key-not-a-real-secret', enabled: true }, { preserveDefault: true });
  return { runtime, requests, dataDir };
}

test('official Mistral catalog offers confirmed chat cards with tool, vision and context metadata before filtering and pagination', async t => {
  const { runtime, requests } = await fixture(t);
  const result = await runtime.discoverModels('mistral_fixture');
  assert.deepEqual(result.models.map(model => model.id).sort(), ['fixture-chat-text', 'fixture-chat-vision']);
  assert.equal(result.total, 2); assert.equal(result.totalModels, 2);
  const vision = result.models.find(model => model.id === 'fixture-chat-vision');
  assert.equal(vision.supportsTools, true);
  assert.equal(vision.displayName, 'Fixture vision chat');
  assert.deepEqual(vision.inputModalities, ['text', 'image']);
  assert.equal(vision.contextWindowTokens, 131072);
  assert.equal(vision.contextWindowSource, 'provider-reported');
  assert.deepEqual(vision.contextWindowEvidence, { label: 'Fixture API model catalog', modelId: vision.id, url: 'https://api.mistral.ai/v1/models', endpointSpecific: true });
  assert.equal(vision.maxOutputTokens, null, 'Context is not an output limit.');
  assert.equal(vision.maxOutputTokensSource, 'unknown');
  assert.deepEqual(vision.aliases, ['fixture-vision-latest']);
  const text = result.models.find(model => model.id === 'fixture-chat-text');
  assert.equal(text.supportsTools, false);
  assert.deepEqual(text.inputModalities, ['text']);
  assert.equal(text.contextWindowTokens, 32768);
  for (const options of [{ toolsOnly: true }, { visionOnly: true }, { minContextTokens: 65536 }]) {
    const filtered = await runtime.discoverModels('mistral_fixture', options);
    assert.deepEqual(filtered.models.map(model => model.id), [vision.id]);
    assert.equal(filtered.total, 1); assert.equal(filtered.totalModels, 2);
  }
  const first = await runtime.discoverModels('mistral_fixture', { limit: 1 });
  const second = await runtime.discoverModels('mistral_fixture', { offset: 1, limit: 1 });
  assert.equal(first.hasMore, true); assert.equal(second.hasMore, false);
  assert.deepEqual(new Set([...first.models, ...second.models].map(model => model.id)), new Set(result.models.map(model => model.id)));
  assert.equal(requests.length, 1, 'Filtering and paging reuse the same reported catalog.');
});

test('Mistral catalog selection survives UI save, store reload and exact compatible runtime routing without changing the default', async t => {
  const { runtime, dataDir, requests } = await fixture(t);
  const catalog = await runtime.discoverModels('mistral_fixture');
  const selection = createProviderModelSelection();
  selection.setPage(catalog.models);
  for (const model of catalog.models) selection.toggle(model.id, true);
  const savedModels = selection.forSave();
  await runtime.saveProvider({ id: 'mistral_fixture', models: savedModels }, { preserveDefault: true });
  const status = runtime.status(), id = 'mistral_fixture::fixture-chat-vision';
  assert.equal(status.defaultModelSelection, 'native-fixture');
  assert.deepEqual(status.models.filter(model => model.providerId === 'mistral_fixture').map(model => model.id).sort(), catalog.models.map(model => 'mistral_fixture::' + model.id).sort());
  assert.equal(chatOptionChoices(status, { model: id }).models.find(model => model.id === id).disabled, false);
  assert.equal(validateChatOptions(status, { model: id }).model, id);
  const restored = new ProviderStore({ dataDir, encryptSecret, decryptSecret });
  await restored.init();
  assert.equal(restored.defaultModel, 'native-fixture');
  for (const original of catalog.models) {
    const model = restored.get('mistral_fixture').models.find(item => item.id === original.id);
    for (const key of ['supportsTools', 'inputModalities', 'contextWindowTokens', 'contextWindowSource', 'contextWindowEvidence']) assert.deepEqual(model[key], original[key], key);
  }
  const response = await runtime.runAgent({ cwd: dataDir, model: id, prompt: 'Return the fixture response.', responseOnly: true });
  assert.equal(response.output, 'Fixture accepted');
  const sent = requests.find(request => request.method === 'POST');
  assert.equal(sent.url, 'https://api.mistral.ai/v1/chat/completions');
  assert.equal(sent.body.model, 'fixture-chat-vision');
  assert.equal(runtime.status().defaultModelSelection, 'native-fixture');
});

test('generic and OpenRouter-compatible schemas retain existing IDs and metadata without Mistral capability requirements', async t => {
  const catalog = [
    { id: 'vendor/standard', name: 'Standard', context_length: 64000, max_context_length: 99999, supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
    { id: 'vendor/legacy', capabilities: ['tools'] },
    { id: 'vendor/unknown' },
    { id: 'vendor/explicit-not-chat', capabilities: { completion_chat: false } },
    { id: 'vendor/boolean-tools', capabilities: { completion_chat: true, function_calling: false, vision: true }, architecture: { input_modalities: ['text'] }, max_context_length: -1 },
  ];
  const { runtime } = await fixture(t, { baseUrl: 'https://openrouter.ai/v1', preset: 'openrouter', catalog });
  const result = await runtime.discoverModels('mistral_fixture');
  assert.deepEqual(result.models.map(model => model.id).sort(), ['vendor/boolean-tools', 'vendor/legacy', 'vendor/standard', 'vendor/unknown']);
  const standard = result.models.find(model => model.id === 'vendor/standard');
  assert.equal(standard.contextWindowTokens, 64000);
  assert.equal(standard.supportsTools, true);
  assert.deepEqual(standard.inputModalities, ['text', 'image']);
  assert.deepEqual(standard.outputModalities, ['text']);
  assert.equal(result.models.find(model => model.id === 'vendor/legacy').supportsTools, true);
  assert.equal(result.models.find(model => model.id === 'vendor/unknown').supportsTools, undefined);
  const explicit = result.models.find(model => model.id === 'vendor/boolean-tools');
  assert.equal(explicit.supportsTools, false);
  assert.deepEqual(explicit.inputModalities, ['text'], 'Existing architecture metadata takes precedence over fallback flags.');
  assert.equal(explicit.contextWindowTokens, null);
});
