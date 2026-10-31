import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeProviderEndpoints, providerEndpointURL, providerInferenceURL } from '../lib/provider-endpoints.mjs';
import { ProviderStore } from '../lib/provider-store.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';
import { createDirectProviderSetupTools } from '../lib/provider-setup-tools.mjs';
import { validDirectArguments } from '../lib/direct-execution-api.mjs';

const endpointConfig = { models: '/models', chatCompletions: '/special/chat' };
class Native extends EventEmitter {
  status() { return { connected: false, authenticated: false, models: [], defaultModel: 'fixture-native' }; }
  async close() {}
  async runAgent() { throw Error('Synthetic endpoint tests must not start native providers.'); }
}
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'blackice-endpoint-fixture-')), calls = [];
  const runtime = new ProviderRuntime({ codex: new Native(), dataDir: dir, fetchImpl: async (url, options) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    const result = options.method === 'GET'
      ? [{ name: new URL(url).pathname === '/changed-models' ? 'changed-model' : 'fixture-model', description: 'A synthetic named model', tools: true }]
      : { id: 'synthetic-completion', model: 'fixture-model', choices: [{ index: 0, message: { role: 'assistant', content: 'SYNTHETIC_CUSTOM_ROUTE_OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } };
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  await runtime.store.init();
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  // Endpoint tests declare synthetic capacities; catalog lookup starts explicitly
  // in the tests below rather than during the unrelated fixture save.
  const config = { id: 'customapi', preset: 'compatible', type: 'compatible', name: 'Synthetic custom API', baseUrl: 'https://api.example/v1', models: [{ id: 'fixture-model', supportsTools: true, contextWindowTokens: 65536, maxOutputTokens: 8192 }], endpoints: endpointConfig };
  await runtime.saveProvider(config, { preserveDefault: true });
  return { dir, calls, runtime, config };
}

test('custom routes are bounded same-origin root-relative paths with explicit reset semantics', () => {
  assert.deepEqual(normalizeProviderEndpoints(undefined), {});
  assert.deepEqual(normalizeProviderEndpoints(endpointConfig), endpointConfig);
  for (const endpoints of [null, [], { unknown: '/path' }, { models: '' }, { models: 'https://other.example/models' }, { models: '//other.example/models' }, { models: '/\\other.example' }, { models: '/models?key=secret' }, { models: '/models#part' }, { models: '/a/../models' }, { models: '/a/%2e%2e/models' }, { models: '/%2fother.example' }, { models: '/a%0ab' }, { models: '/bad%escape' }, { models: '/two words' }]) assert.throws(() => normalizeProviderEndpoints(endpoints), { code: 'INVALID_PROVIDER_ENDPOINT' });
});

test('standard route prefixes and base queries remain unchanged; custom routes replace only the pathname', () => {
  const config = { type: 'compatible', baseUrl: 'https://api.example/v1?version=1' };
  assert.equal(providerEndpointURL(config, 'models').href, 'https://api.example/v1/models?version=1');
  assert.equal(providerInferenceURL(config), 'https://api.example/v1/chat/completions?version=1');
  assert.equal(providerInferenceURL({ ...config, endpoints: endpointConfig }), 'https://api.example/special/chat?version=1');
  assert.equal(providerEndpointURL({ ...config, endpoints: endpointConfig }, 'models').href, 'https://api.example/models?version=1');
  assert.equal(providerEndpointURL({ ...config, endpoints: endpointConfig }, 'responses').href, 'https://api.example/v1/responses?version=1');
});

test('provider settings persist, expose, preserve and explicitly clear endpoint overrides', async t => {
  const f = await fixture(t), store = f.runtime.store;
  assert.deepEqual(store.list()[0].endpoints, endpointConfig);
  const restored = new ProviderStore({ dataDir: f.dir }); await restored.init(); assert.deepEqual(restored.list()[0].endpoints, endpointConfig);
  const renamed = await store.save({ id: 'customapi', name: 'Renamed custom API' }); assert.deepEqual(renamed.endpoints, endpointConfig);
  const replaced = await store.save({ id: 'customapi', endpoints: { models: '/changed-models' } }); assert.deepEqual(replaced.endpoints, { models: '/changed-models' });
  const cleared = await store.save({ id: 'customapi', endpoints: {} }); assert.equal(cleared.endpoints, undefined);
  await assert.rejects(store.save({ id: 'another', type: 'openai', baseUrl: 'https://api.example/v1', endpoints: { chatCompletions: '/custom' } }), { code: 'INVALID_PROVIDER_ENDPOINT' });
});

test('actual catalog request uses custom path and accepts named top-level array models without credentials', async t => {
  const f = await fixture(t), catalog = await f.runtime.discoverModels('customapi');
  assert.equal(f.calls[0].url, 'https://api.example/models'); assert.equal(f.calls[0].options.method, 'GET');
  assert.equal(Object.keys(f.calls[0].options.headers).some(key => key.toLowerCase() === 'authorization'), false);
  assert.equal(catalog.models[0].id, 'fixture-model'); assert.equal(catalog.models[0].displayName, 'A synthetic named model'); assert.equal(catalog.models[0].supportsTools, true);
});

test('actual compatible runtime posts to custom endpoint and pins the saved conversation to that inference route', async t => {
  const f = await fixture(t), result = await f.runtime.runAgent({ model: 'customapi::fixture-model', cwd: f.dir, prompt: 'Return the synthetic fixture marker.', effort: 'default' });
  assert.equal(result.output, 'SYNTHETIC_CUSTOM_ROUTE_OK'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, 'https://api.example/special/chat');
  assert.equal(f.calls[0].body.model, 'fixture-model'); assert.equal(f.calls[0].options.method, 'POST');
  assert.equal(Object.keys(f.calls[0].options.headers).some(key => key.toLowerCase() === 'authorization'), false);
  const record = await f.runtime.readThread(result.threadId); assert.equal(record.providerEndpoint, 'https://api.example/special/chat');
  await f.runtime.saveProvider({ id: 'customapi', endpoints: { ...endpointConfig, chatCompletions: '/changed-chat' } }, { preserveDefault: true });
  await assert.rejects(f.runtime.runAgent({ threadId: result.threadId, model: 'customapi::fixture-model', cwd: f.dir, prompt: 'Continue.' }), { code: 'THREAD_MISMATCH' });
  await assert.rejects(f.runtime.compactThread(result.threadId, {}), { code: 'THREAD_MISMATCH' });
  assert.equal(f.calls.length, 1, 'a changed route cannot receive the earlier conversation implicitly');
});

test('changing only the model catalog endpoint invalidates cached discovery', async t => {
  const f = await fixture(t); await f.runtime.discoverModels('customapi'); await f.runtime.discoverModels('customapi'); assert.equal(f.calls.length, 1);
  await f.runtime.saveProvider({ id: 'customapi', endpoints: { ...endpointConfig, models: '/changed-models' } }, { preserveDefault: true });
  const changed = await f.runtime.discoverModels('customapi'); assert.equal(f.calls.length, 2); assert.equal(f.calls[1].url, 'https://api.example/changed-models'); assert.equal(changed.models[0].id, 'changed-model');
});

test('legacy standard-route conversations remain compatible and catalog-only changes do not alter inference identity', async t => {
  const f = await fixture(t); await f.runtime.saveProvider({ id: 'customapi', endpoints: {} }, { preserveDefault: true });
  const first = await f.runtime.runAgent({ model: 'customapi::fixture-model', cwd: f.dir, prompt: 'Return a fixture result.' });
  assert.equal(f.calls[0].url, 'https://api.example/v1/chat/completions');
  const legacy = await f.runtime.readThread(first.threadId); delete legacy.providerEndpoint; await f.runtime.persistThread(legacy);
  await f.runtime.saveProvider({ id: 'customapi', endpoints: { models: '/changed-models' } }, { preserveDefault: true });
  const next = await f.runtime.runAgent({ threadId: first.threadId, model: 'customapi::fixture-model', cwd: f.dir, prompt: 'Continue the fixture.' });
  assert.equal(next.output, 'SYNTHETIC_CUSTOM_ROUTE_OK'); assert.equal(f.calls[1].url, f.calls[0].url);
});

test('direct provider configuration exposes the same endpoint map and rejects undeclared endpoint fields', async t => {
  const f = await fixture(t), tools = createDirectProviderSetupTools({ runtime: f.runtime, browser: {}, reauthorize: async () => {} });
  const configure = tools.find(tool => tool.definition.name === 'blackice_provider_configure'), payload = { requestId: 'synthetic-endpoint-save', action: 'save', provider: { id: 'customapi', endpoints: { models: '/changed-models' } }, expectedUpdatedAt: f.runtime.store.get('customapi').updatedAt };
  assert.equal(validDirectArguments(payload, configure.definition.inputSchema), true);
  assert.equal(validDirectArguments({ ...payload, provider: { ...payload.provider, endpoints: { secret: '/bad' } } }, configure.definition.inputSchema), false);
  const saved = JSON.parse((await configure.execute(payload, { client: { id: 'fixture-client' } })).contentItems[0].text);
  assert.deepEqual(saved.provider.endpoints, { models: '/changed-models' }); assert.equal(saved.defaultChanged, false); assert.equal(f.runtime.store.defaultModel, null);
});


test('catalog labels prefer a dedicated name and reserve description for name-as-ID entries', async t => {
  const f = await fixture(t);
  f.runtime.fetchImpl = async () => new Response(JSON.stringify({data:[
    {id:'vendor/short-id',name:'Vendor · Short model name',description:'A long provider marketing paragraph that must not become the model selector label.'},
    {name:'name-is-the-id',description:'Named-array model label'},
    {id:'vendor/explicit-label',name:'Short name',display_name:'Explicit display label',description:'Detailed prose'}
  ]}),{status:200,headers:{'Content-Type':'application/json'}});
  const result=await f.runtime.discoverModels('customapi');
  assert.deepEqual(result.models.map(model=>[model.id,model.displayName]),[
    ['vendor/explicit-label','Explicit display label'],
    ['name-is-the-id','Named-array model label'],
    ['vendor/short-id','Vendor · Short model name']
  ]);
});
