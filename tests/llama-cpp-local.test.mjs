import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalModelManager, registerLocalModel } from '../lib/local-model-manager.mjs';
import { localModelHTTP } from '../lib/local-model-http.mjs';
import { normalizeProvider } from '../lib/provider-store.mjs';
import { getProviderPreset, providerRequiresApiKey } from '../public/provider-catalog.mjs';

const reply = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

function routerFixture({ loadConfirmed = true, validCatalog = true } = {}) {
  const calls = [], state = { loaded: false };
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url), route = parsed.pathname;
    if (parsed.port !== '8080') throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    calls.push({ route, body, method: options.method || 'GET' });
    if (route === '/models' && options.method !== 'POST') return reply(validCatalog ? {
      data: [
        { id: 'my-model.gguf', status: { value: state.loaded ? 'loaded' : 'unloaded' }, size: 1234 },
        { id: 'repo/model:Q4_K_M', status: { value: 'sleeping' } },
        { id: 'bad::name', status: { value: 'loaded' } },
      ],
    } : { data: 'invalid' });
    if (route === '/models/load') {
      if (loadConfirmed) state.loaded = true;
      return reply({ success: loadConfirmed });
    }
    if (route === '/models/unload') { state.loaded = false; return reply({ success: true }); }
    throw new Error('Unexpected llama.cpp route ' + route);
  };
  return { fetchImpl, calls, state };
}

test('llama.cpp v1 router: lists GGUF models, verifies load/unload and preserves precision', async () => {
  const fixture = routerFixture(), manager = new LocalModelManager({ fetchImpl: fixture.fetchImpl });
  const snapshot = await manager.list(), llama = snapshot.engines.find(item => item.id === 'llamacpp');
  assert.equal(snapshot.engines.length, 3);
  assert.equal(llama.available, true);
  assert.equal(llama.mode, 'router');
  assert.deepEqual(llama.models.map(item => item.id), ['my-model.gguf', 'repo/model:Q4_K_M']);
  assert.equal(llama.models[0].loaded, false);
  assert.equal(llama.models[1].loaded, true);
  await assert.rejects(manager.load({ engine: 'llamacpp', model: 'my-model.gguf', contextLength: 8192 }),
    /--ctx-size or a --models-preset/);
  assert.equal(fixture.calls.some(call => call.route === '/models/load'), false);
  const loaded = await manager.load({ engine: 'llamacpp', model: 'my-model.gguf' });
  assert.deepEqual(loaded, { engine: 'llamacpp', model: 'my-model.gguf', loaded: true, mode: 'router' });
  assert.deepEqual(fixture.calls.find(call => call.route === '/models/load').body, { model: 'my-model.gguf' });
  assert.equal((await manager.llamaCatalog()).models[0].loaded, true);
  await manager.unload({ engine: 'llamacpp', model: 'my-model.gguf' });
  assert.deepEqual(fixture.calls.find(call => call.route === '/models/unload').body, { model: 'my-model.gguf' });
  assert.equal(fixture.state.loaded, false);
});

test('llama.cpp single-model server: registers active model but cannot pretend to unload it', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const route = new URL(url).pathname;
    calls.push({ route, body: options.body });
    if (route === '/models') return reply({ error: 'Not found' }, 404);
    if (route === '/v1/models') return reply({ data: [{ id: 'single-f16.gguf' }] });
    throw Error('Unexpected request: ' + route);
  };
  const manager = new LocalModelManager({ fetchImpl });
  const catalog = await manager.llamaCatalog();
  assert.equal(catalog.mode, 'single');
  assert.deepEqual(catalog.models.map(item => [item.id, item.loaded, item.manageable]), [['single-f16.gguf', true, false]]);
  assert.equal((await manager.load({ engine: 'llamacpp', model: 'single-f16.gguf' })).loaded, true);
  await assert.rejects(manager.unload({ engine: 'llamacpp', model: 'single-f16.gguf' }), /Stop or restart llama-server/);
  await assert.rejects(manager.load({ engine: 'llamacpp', model: 'nonexistent' }), /not found/);
  assert.equal(calls.some(call => call.route === '/models/unload' || call.route === '/models/load'), false);
});

test('llama.cpp errors do not register unconfirmed models or non-router responses as successful', async () => {
  const fixture = routerFixture({ loadConfirmed: false }), manager = new LocalModelManager({ fetchImpl: fixture.fetchImpl });
  await assert.rejects(manager.load({ engine: 'llamacpp', model: 'my-model.gguf' }), /did not confirm/);
  await assert.rejects(manager.load({ engine: 'llamacpp', model: 'missing.gguf' }), /not found/);
  assert.equal(fixture.calls.filter(call => call.route === '/models/load').length, 1);
  const invalid = new LocalModelManager({ fetchImpl: routerFixture({ validCatalog: false }).fetchImpl });
  const catalog = await invalid.llamaCatalog();
  assert.equal(catalog.available, false);
  assert.match(catalog.error, /unexpected model catalog/);
});

test('llama.cpp provider uses OpenAI-compatible transport with no API key and preserves current default', async () => {
  assert.equal(getProviderPreset('llamacpp').baseUrl, 'http://127.0.0.1:8080/v1');
  assert.equal(providerRequiresApiKey({ type: 'compatible', preset: 'llamacpp' }), false);
  const saved = [];
  const runtime = { listProviders: () => [], saveProvider: async (value, options) => {
    saved.push({ value: normalizeProvider(value), options });
  } };
  const registered = await registerLocalModel(runtime, 'llamacpp', 'my-model.gguf');
  assert.deepEqual(registered, { providerId: 'local_llamacpp', selection: 'local_llamacpp::my-model.gguf' });
  assert.equal(saved[0].value.preset, 'llamacpp');
  assert.equal(saved[0].value.baseUrl, 'http://127.0.0.1:8080/v1');
  assert.equal(saved[0].options.preserveDefault, true);
});

test('local HTTP loads llama.cpp router models and blocks remote requests', async () => {
  const fixture = routerFixture(), manager = new LocalModelManager({ fetchImpl: fixture.fetchImpl });
  const calls = [], runtime = { listProviders: () => [], saveProvider: async (value, opts) => calls.push({ value, opts }) };
  const blocked = await localModelHTTP({ manager, runtime, remote: true,
    pathname: '/api/local-models/load', method: 'POST', value: { engine: 'llamacpp', model: 'my-model.gguf' } });
  assert.equal(blocked.status, 403);
  assert.equal(fixture.calls.length, 0);
  const loaded = await localModelHTTP({ manager, runtime,
    pathname: '/api/local-models/load', method: 'POST', value: { engine: 'llamacpp', model: 'my-model.gguf' } });
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.selection, 'local_llamacpp::my-model.gguf');
  assert.equal(calls.length, 1);
  const unloaded = await localModelHTTP({ manager, runtime,
    pathname: '/api/local-models/unload', method: 'POST', value: { engine: 'llamacpp', model: 'my-model.gguf' } });
  assert.equal(unloaded.status, 200);
  assert.equal(fixture.state.loaded, false);
});

test('llama.cpp OpenAI-style error bodies remain actionable instead of becoming blank errors', async () => {
  const fetchImpl = async (url, options = {}) => new URL(url).pathname === '/models/load'
    ? reply({ error: { message: 'Insufficient free memory for this model' } }, 400)
    : reply({ data: [{ id: 'oversized.gguf', status: { value: 'unloaded' } }] });
  const manager = new LocalModelManager({ fetchImpl });
  await assert.rejects(manager.load({ engine: 'llamacpp', model: 'oversized.gguf' }), error =>
    error.code === 'LOCAL_ENGINE_REQUEST_FAILED' && error.status === 400 && /Insufficient free memory/.test(error.message));
});
