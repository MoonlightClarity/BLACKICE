import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const vault = { encryptSecret: value => Buffer.from('sealed:' + Buffer.from(value).toString('base64')), decryptSecret: value => Buffer.from(String(value).slice(7), 'base64').toString() };
class Codex extends EventEmitter {
  status() { return { connected: true, authenticated: true, models: [], defaultModel: 'native', activeTurns: 0 }; }
  async close() {}
  async runAgent() { assert.fail('Connection preview must never generate or start a model.'); }
}
async function fixture(t, handler = () => json({ data: [] }), options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-provider-preview-')), requests = [];
  const runtime = await new ProviderRuntime({
    codex: new Codex(), dataDir, ...vault, ...options,
    fetchImpl: async (url, options) => { const request = { url: String(url), ...options }; requests.push(request); assert.equal(options.method, 'GET', 'Only catalog/credential metadata GETs are allowed.'); return handler(request, requests.length); },
    modelLimitResolver: { enrich: async () => assert.fail('Preview must not modify shared enrichment caches or request unrelated metadata.') },
  }).init();
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { runtime, store: runtime.store, dataDir, requests };
}
const local = { id: 'draft', type: 'compatible', preset: 'compatible', name: 'Draft API', baseUrl: 'http://127.0.0.1:11434/v1', models: [] };
const preview = (runtime, connection = local, query = {}) => runtime.previewProvider({ connection, ...query });

test('an unsaved preview filters the complete live catalog before paging and never persists or caches a credential', async t => {
  const rows = [
    { id: 'alpha', supports_tools: true, context_length: 8192, pricing: { prompt: '0', completion: '0' } },
    { id: 'beta', supports_tools: true, context_length: 16384, pricing: { prompt: '0', completion: '0' } },
    { id: 'gamma', supports_tools: true, context_length: 32768, pricing: { prompt: '0', completion: '0' } },
    { id: 'paid', supports_tools: true, context_length: 8192, pricing: { prompt: '0.1', completion: '0.2' } },
    { id: 'no-tools', supports_tools: false, context_length: 8192, pricing: { prompt: '0', completion: '0' } },
  ];
  const { runtime, store, requests, dataDir } = await fixture(t, () => json({ data: rows }));
  await store.setDefaultModel('native');
  const before = await readFile(store.file, 'utf8'), files = await readdir(dataDir), events = [];
  runtime.on('status', value => events.push(value));
  const result = await preview(runtime, { ...local, apiKey: 'draft-secret-preview-only', headers: { 'X-Tenant': 'draft-private-header' }, models: ['manual-id'] }, { toolsOnly: true, freeOnly: true, minContextTokens: 4096, offset: 1, limit: 1 });
  assert.deepEqual(result.models.map(model => model.id), ['beta']);
  assert.equal(result.total, 3); assert.equal(result.totalModels, 5); assert.equal(result.returned, 1); assert.equal(result.hasMore, true);
  assert.equal(result.groups.reduce((count, group) => count + group.total, 0), 3);
  assert.deepEqual(result.selectedModels.map(model => model.id), ['manual-id']);
  assert.equal(result.credentialVerified, false); assert.equal(result.modelAccessVerified, false); assert.equal(result.verification, 'catalog-only');
  assert.equal(result.catalogAvailable, true); assert.equal(result.sourceUrl, local.baseUrl + '/models'); assert.equal(result.method, 'GET');
  assert.ok(Number.isFinite(Date.parse(result.checkedAt))); assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
  assert.equal(requests[0].headers.Authorization, 'Bearer draft-secret-preview-only');
  assert.equal(requests[0].headers['X-Tenant'], 'draft-private-header');
  assert.equal(await readFile(store.file, 'utf8'), before); assert.deepEqual(await readdir(dataDir), files);
  assert.equal(store.get('draft'), undefined); assert.equal(store.keys.size, 0); assert.equal(store.headers.size, 0);
  assert.equal(store.redactionKeys.has('draft-secret-preview-only'), false);
  assert.equal(store.defaultModel, 'native'); assert.equal(store.automaticDefaultModel, null);
  assert.equal(runtime.modelCatalogs.size, 0); assert.equal(runtime.checks.size, 0); assert.deepEqual(events, []);
});

test('protected catalog acceptance is credential evidence only for the documented endpoint', async t => {
  const { runtime, requests } = await fixture(t, () => json({ data: [{ id: 'model-current' }] }));
  const result = await preview(runtime, { id: 'cloud', preset: 'openai', apiKey: 'protected-key-fixture' });
  assert.equal(result.credentialVerified, true); assert.equal(result.verification, 'credentials-and-catalog'); assert.equal(result.modelAccessVerified, false);
  assert.equal(result.models[0].contextWindowTokens, null); assert.equal(result.models[0].maxOutputTokens, null);
  assert.equal(requests[0].url, 'https://api.openai.com/v1/models');
  const custom = await preview(runtime, { id: 'cloud', preset: 'openai', apiKey: 'protected-key-fixture', endpoints: { models: '/public/models' } });
  assert.equal(custom.credentialVerified, false); assert.equal(custom.verification, 'catalog-only');
  assert.equal(requests[1].url, 'https://api.openai.com/public/models');
  const gateway = await preview(runtime, { id: 'cloud', preset: 'openai', apiKey: 'protected-key-fixture', baseUrl: 'https://gateway.example/v1' });
  assert.equal(gateway.credentialVerified, false, 'A preset label cannot attest to authentication on another server.');
});

test('public catalogs never attest to API credentials, and sparse metadata stays unknown', async t => {
  const { runtime, requests } = await fixture(t, () => json({ data: [{ id: 'vendor/model' }] }));
  const result = await preview(runtime, { id: 'hf', preset: 'huggingface', apiKey: 'unverified-hf-key' });
  assert.equal(result.credentialVerified, false); assert.equal(result.models[0].supportsTools, undefined);
  assert.equal(result.models[0].contextWindowTokens, null); assert.match(result.warnings.join(' '), /does not verify/);
  assert.equal(requests.length, 1);
});

test('OpenRouter verifies the provided key before reading its public model list', async t => {
  const { runtime, requests } = await fixture(t, request => new URL(request.url).pathname.endsWith('/key') ? json({ data: { is_free_tier: false } }) : json({ data: [{ id: 'vendor/model' }] }));
  const result = await preview(runtime, { id: 'router', preset: 'openrouter', apiKey: 'router-fixture-key' });
  assert.deepEqual(requests.map(request => new URL(request.url).pathname), ['/api/v1/key', '/api/v1/models']);
  assert.ok(requests.every(request => request.headers.Authorization === 'Bearer router-fixture-key'));
  assert.equal(result.credentialVerified, true); assert.equal(result.modelAccessVerified, false);
});

test('OpenRouter rejected or management credentials cannot be rescued by a public catalog', async t => {
  for (const response of [{ data: { is_free_tier: false, is_management_key: true } }, { data: { is_free_tier: false, disabled: true } }, { data: { is_free_tier: false, expires_at: '2000-01-01T00:00:00.000Z' } }]) {
    const { runtime, requests } = await fixture(t, () => json(response));
    await assert.rejects(preview(runtime, { id: 'router', preset: 'openrouter', apiKey: 'router-invalid-key' }), { code: 'PROVIDER_KEY_REQUIRED' });
    assert.equal(requests.length, 1); assert.ok(requests[0].url.endsWith('/key'));
  }
});

test('preview borrows saved credentials and endpoint routes only with the current saved revision', async t => {
  const { runtime, store, requests } = await fixture(t, () => json({ data: [{ id: 'advertised' }] }));
  const saved = await store.save({ ...local, apiKey: 'saved-preview-key', headers: { 'X-API-Key': 'saved-preview-header' }, endpoints: { models: '/catalog', chatCompletions: '/generate' }, models: ['saved-selection'] });
  const before = await readFile(store.file, 'utf8'), cached = { marker: true }; runtime.modelCatalogs.set(saved.id, cached); runtime.checks.set(saved.id, { ok: false });
  const result = await preview(runtime, { id: saved.id, expectedUpdatedAt: saved.updatedAt, name: 'Unsaved name' });
  assert.equal(requests[0].url, 'http://127.0.0.1:11434/catalog');
  assert.equal(requests[0].headers.Authorization, 'Bearer saved-preview-key'); assert.equal(requests[0].headers['X-API-Key'], 'saved-preview-header');
  assert.deepEqual(result.selectedModels.map(model => model.id), ['saved-selection']);
  assert.equal(await readFile(store.file, 'utf8'), before); assert.equal(store.get(saved.id).name, local.name);
  assert.equal(runtime.modelCatalogs.get(saved.id), cached); assert.deepEqual(runtime.checks.get(saved.id), { ok: false });
  await assert.rejects(preview(runtime, { id: saved.id }), { code: 'INVALID_PROVIDER_REVISION' });
  await assert.rejects(preview(runtime, { id: saved.id, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' }), { code: 'PROVIDER_CHANGED', status: 409 });
  await assert.rejects(preview(runtime, { id: saved.id, expectedUpdatedAt: null }), { code: 'PROVIDER_CHANGED' });
  assert.equal(requests.length, 1);
});

test('a changed origin or protocol cannot inherit any saved key or custom headers', async t => {
  const { runtime, store, requests } = await fixture(t, () => json({ data: [] }));
  const saved = await store.save({ ...local, apiKey: 'saved-original-key', headers: { 'X-Tenant': 'saved-private-tenant' } });
  const changed = { id: saved.id, expectedUpdatedAt: saved.updatedAt, baseUrl: 'https://other.example/v1' };
  await assert.rejects(preview(runtime, changed), { code: 'PROVIDER_CREDENTIAL_TARGET_CHANGED' });
  await assert.rejects(preview(runtime, { ...changed, apiKey: 'explicit-new-key' }), { code: 'PROVIDER_CREDENTIAL_TARGET_CHANGED' });
  await assert.rejects(preview(runtime, { id: saved.id, expectedUpdatedAt: saved.updatedAt, type: 'anthropic' }), { code: 'INVALID_PROVIDER' });
  await assert.rejects(runtime.saveProvider(changed), { code: 'PROVIDER_CREDENTIAL_TARGET_CHANGED' });
  assert.equal(requests.length, 0);
  await preview(runtime, { ...changed, apiKey: 'explicit-new-key', headers: {} });
  assert.equal(requests[0].headers.Authorization, 'Bearer explicit-new-key'); assert.equal(requests[0].headers['X-Tenant'], undefined);
  await preview(runtime, { ...changed, apiKey: '', headers: {} });
  assert.equal(requests[1].headers.Authorization, undefined);
  assert.equal(store.key(saved.id), 'saved-original-key');
});

test('a replacement key and cleared headers are used in preview without changing the saved credentials', async t => {
  const { runtime, store, requests } = await fixture(t, () => json({ data: [] }));
  const saved = await store.save({ ...local, apiKey: 'saved-original-key', headers: { Authorization: 'Bearer old-header-key' } });
  await preview(runtime, { id: saved.id, expectedUpdatedAt: saved.updatedAt, apiKey: 'replacement-preview-key', headers: {} });
  assert.equal(requests[0].headers.Authorization, 'Bearer replacement-preview-key');
  assert.equal(store.key(saved.id), 'saved-original-key'); assert.equal(store.extraHeaders(saved.id).Authorization, 'Bearer old-header-key');
  assert.equal(store.redactionKeys.has('replacement-preview-key'), false);
  await preview(runtime, { id: saved.id, expectedUpdatedAt: saved.updatedAt, apiKey: '', headers: {} });
  assert.equal(requests[1].headers.Authorization, undefined);
});

test('failed live discovery never substitutes saved rows and redacts submitted secrets without retaining them', async t => {
  const key = 'draft-secret-error-fixture', header = 'draft-header-error-fixture';
  const { runtime, store } = await fixture(t, () => json({ error: { message: 'Invalid API key ' + key + ' and ' + header } }, 401));
  const saved = await store.save({ ...local, models: ['saved-selection'] }), before = await readFile(store.file, 'utf8');
  await assert.rejects(preview(runtime, { id: saved.id, expectedUpdatedAt: saved.updatedAt, apiKey: key, headers: { 'X-API-Key': header } }), cause => {
    assert.equal(cause.code, 'PROVIDER_AUTH'); assert.equal(cause.httpStatus, 401);
    assert.equal(cause.message.includes(key), false); assert.equal(cause.message.includes(header), false); return true;
  });
  assert.equal(await readFile(store.file, 'utf8'), before); assert.equal(store.redactionKeys.has(key), false); assert.equal(runtime.modelCatalogs.size, 0);
});

test('catalog pagination stays on the configured origin and keeps full-list filtering', async t => {
  const { runtime, requests } = await fixture(t, (_request, index) => index === 1 ? json({ data: [{ id: 'no-tools', supports_tools: false }], next_url: '?page=2' }) : json({ data: [{ id: 'tool-model', supports_tools: true }] }));
  const result = await preview(runtime, local, { toolsOnly: true, limit: 1 });
  assert.deepEqual(result.models.map(model => model.id), ['tool-model']); assert.equal(result.totalModels, 2); assert.equal(requests.length, 2);
  const other = await fixture(t, () => json({ data: [], next_url: 'https://unexpected.example/models' }));
  await assert.rejects(preview(other.runtime, { ...local, apiKey: 'pagination-key' }), { code: 'PROVIDER_CATALOG_PAGINATION' });
  assert.equal(other.requests.length, 1);
});

test('Pollinations uses its rich current catalog, canonical IDs, aliases and explicit chat capabilities', async t => {
  const entries = [
    { id: 'alias-must-not-win', name: 'vendor/current', aliases: ['friendly'], category: 'text', capabilities: ['tool_calling'], input_modalities: ['text', 'image'], output_modalities: ['text'], supported_endpoints: ['/v1/chat/completions', '/v1/responses'], context_length: 32768, pricing: { currency: 'pollen', promptTextTokens: '0.0001' } },
    { name: 'vendor/response-only', category: 'text', capabilities: ['tool_calling'], supported_endpoints: ['/v1/responses'] },
    { name: 'vendor/retired', category: 'text', lifecycle: 'retired', supported_endpoints: ['/v1/chat/completions'] },
    { name: 'vendor/old-but-callable', category: 'text', lifecycle: 'deprecated', supported_endpoints: ['/v1/chat/completions'] },
  ];
  const { runtime, requests } = await fixture(t, () => json(entries));
  const result = await preview(runtime, { id: 'pollen', preset: 'pollinations', apiKey: 'sk_synthetic_pollen' });
  assert.equal(requests[0].url, 'https://gen.pollinations.ai/text/models');
  assert.deepEqual(result.models.map(model => model.id).sort(), ['vendor/current', 'vendor/old-but-callable']);
  const current = result.models.find(model => model.id === 'vendor/current');
  assert.deepEqual(current.aliases, ['friendly']); assert.equal(current.supportsTools, true); assert.deepEqual(current.inputModalities, ['text', 'image']);
  assert.equal(current.contextWindowTokens, 32768); assert.equal(current.maxOutputTokens, null);
  assert.equal(current.pricing?.prompt, undefined, 'Pollen pricing must not masquerade as standard dollar token pricing.');
  assert.equal(result.credentialVerified, false);
});

test('Mistral chat filters, nested capability flags and Claude lifecycle metadata retain accurate candidates', async t => {
  const mistral = await fixture(t, () => json({ data: [
    { id: 'chat', capabilities: { completion_chat: true, function_calling: true } },
    { id: 'embedding', capabilities: { completion_chat: false } },
    { id: 'retired-chat', capabilities: { completion_chat: true }, archived: true },
    { id: 'deprecated-chat', capabilities: { completion_chat: true }, deprecated: 4_000_000_000 },
  ] }));
  const result = await preview(mistral.runtime, { id: 'mistral', preset: 'mistral', apiKey: 'mistral-fixture-key' });
  assert.deepEqual(result.models.map(model => model.id).sort(), ['chat', 'deprecated-chat']); assert.equal(result.credentialVerified, true);
  const claude = await fixture(t, () => json({ data: [
    { id: 'claude-current', capabilities: { tool_use: { supported: true }, image_input: { supported: true } }, lifecycle: { status: 'active' } },
    { id: 'claude-retired', lifecycle: { status: 'retired' } },
  ] }));
  const models = await preview(claude.runtime, { id: 'claude', preset: 'anthropic', apiKey: 'anthropic-fixture-key' });
  assert.deepEqual(models.models.map(model => model.id), ['claude-current']); assert.equal(models.models[0].supportsTools, true); assert.deepEqual(models.models[0].inputModalities, ['text', 'image']);
  assert.equal(claude.requests[0].headers['x-api-key'], 'anthropic-fixture-key'); assert.equal(claude.requests[0].headers['anthropic-version'], '2023-06-01');
});

test('the anonymous Kilo preset keeps its live zero-price restriction even when the request omits the filter', async t => {
  const { runtime } = await fixture(t, () => json({ data: [
    { id: 'vendor/free:free', pricing: { prompt: '0', completion: '0' } },
    { id: 'vendor/paid', pricing: { prompt: '0.1', completion: '0.2' } },
  ] }));
  const result = await preview(runtime, { id: 'free', preset: 'kilo_free' }, { freeOnly: false });
  assert.deepEqual(result.models.map(model => model.id), ['vendor/free:free']); assert.equal(result.filters.freeOnly, true); assert.equal(result.credentialVerified, false);
});

test('malformed drafts and query options fail before any provider request', async t => {
  const { runtime, requests } = await fixture(t);
  for (const value of [null, [], {}, { connection: [] }, { connection: local, unsupported: true }]) await assert.rejects(runtime.previewProvider(value), { code: 'INVALID_PROVIDER_PREVIEW' });
  for (const query of [{ offset: -1 }, { limit: 201 }, { query: 'x'.repeat(257) }, { toolsOnly: 'true' }, { sort: 'random' }, { minContextTokens: -1 }, { refresh: 'yes' }]) await assert.rejects(preview(runtime, local, query), { code: 'INVALID_MODEL_SEARCH' });
  await assert.rejects(preview(runtime, { id: 'missing-key', preset: 'openai' }), { code: 'PROVIDER_KEY_REQUIRED' });
  assert.equal(requests.length, 0);
});

test('a draft result is rejected when the saved connection changes while discovery is in flight', async t => {
  const started = deferred(), release = deferred();
  const { runtime, store } = await fixture(t, async () => { started.resolve(); await release.promise; return json({ data: [{ id: 'late' }] }); });
  const saved = await store.save(local);
  const pending = preview(runtime, { id: saved.id, expectedUpdatedAt: saved.updatedAt }), rejected = assert.rejects(pending, { code: 'PROVIDER_CHANGED', status: 409 });
  await started.promise; await store.save({ id: saved.id, name: 'Changed meanwhile' }); release.resolve(); await rejected;
  assert.equal(runtime.modelCatalogs.size, 0); assert.equal(runtime.checks.size, 0);
});

test('timeouts and caller cancellation settle preview without leaving controllers or cached results', async t => {
  const pendingResponse = request => new Promise((_resolve, reject) => {
    const abort = () => reject(request.signal.reason);
    request.signal.addEventListener('abort', abort, { once: true }); if (request.signal.aborted) abort();
  });
  const timeout = await fixture(t, pendingResponse, { requestTimeoutMs: 20 });
  await assert.rejects(preview(timeout.runtime), { code: 'PROVIDER_TIMEOUT' });
  assert.equal(timeout.runtime.discoveryControllers.size, 0); assert.equal(timeout.runtime.modelCatalogs.size, 0);
  const controller = new AbortController(), started = deferred();
  const cancelled = await fixture(t, request => { started.resolve(); return pendingResponse(request); });
  const running = cancelled.runtime.previewProvider({ connection: local }, { signal: controller.signal });
  const rejected = assert.rejects(running, { name: 'AbortError' });
  await started.promise; controller.abort(new DOMException('Fixture cancelled.', 'AbortError')); await rejected;
  assert.equal(cancelled.runtime.discoveryControllers.size, 0); assert.equal(cancelled.runtime.checks.size, 0);
});

test('saving preview-reported limits rechecks them while preserving explicit manual limits', async t => {
  const { runtime, store, requests } = await fixture(t, (_request, index) => json({ data: [{ id: 'current-model', context_length: index === 1 ? 8192 : 16384, max_output_tokens: index === 1 ? 1024 : 2048 }] }));
  const connection = { ...local, apiKey: 'preview-save-key' };
  const result = await preview(runtime, connection);
  assert.equal(result.models[0].contextWindowSource, 'provider-reported');
  runtime.modelLimitResolver = { enrich: async (_config, models) => models };
  const saved = await runtime.saveProvider({ ...connection, models: [{ ...result.models[0], contextWindowTokens: 12000, contextWindowSource: 'user-configured' }] });
  assert.equal(requests.length, 2, 'A report from an unsaved preview must be verified at save time.');
  assert.equal(saved.models[0].contextWindowTokens, 12000); assert.equal(saved.models[0].contextWindowSource, 'user-configured');
  assert.equal(saved.models[0].maxOutputTokens, 2048); assert.equal(saved.models[0].maxOutputTokensSource, 'provider-reported');
  assert.equal(store.defaultModel, null); assert.equal(store.automaticDefaultModel, null);
});

test('save-time metadata fallback cannot reuse cleared credentials on a changed origin', async t => {
  const { runtime, store, requests } = await fixture(t, () => json({ data: [] }));
  const saved = await store.save({ id: 'cloud', type: 'openai', preset: 'openai', baseUrl: 'https://original.example/v1', apiKey: 'original-private-key', headers: { 'X-Tenant': 'original-private-header' }, models: ['selected-model'] });
  runtime.modelLimitResolver = {
    enrich: async (_config, models, { request, signal }) => { await request('/metadata/models', null, signal); return models; },
  };
  const result = await runtime.saveProvider({ id: saved.id, expectedUpdatedAt: saved.updatedAt, baseUrl: 'https://replacement.example/v1', apiKey: '', headers: {} });
  assert.equal(requests.length, 1); assert.equal(requests[0].url, 'https://replacement.example/metadata/models');
  assert.equal(requests[0].headers.Authorization, undefined); assert.equal(requests[0].headers['X-Tenant'], undefined);
  assert.equal(result.hasApiKey, false); assert.equal(result.hasHeaders, false); assert.equal(store.key(saved.id), '');
});
