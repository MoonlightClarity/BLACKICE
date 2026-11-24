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
    if (route === '/props') return reply({role: 'router'});
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
    if (route === '/props') return reply({default_generation_settings: {n_ctx: 8192}, is_sleeping: false});
    if (route === '/models') return reply({ data: [{ id: 'single-f16.gguf', meta: {n_ctx:8192} }] });
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
  const fetchImpl = async (url, options = {}) => new URL(url).pathname === '/props' ? reply({role: 'router'}) : new URL(url).pathname === '/models/load'
    ? reply({ error: { message: 'Insufficient free memory for this model' } }, 400)
    : reply({ data: [{ id: 'oversized.gguf', status: { value: 'unloaded' } }] });
  const manager = new LocalModelManager({ fetchImpl });
  await assert.rejects(manager.load({ engine: 'llamacpp', model: 'oversized.gguf' }), error =>
    error.code === 'LOCAL_ENGINE_REQUEST_FAILED' && error.status === 400 && /Insufficient free memory/.test(error.message));
});

test('sleeping router process is reusable without a duplicate load and remains unloadable', async () => {
  const fixture = routerFixture();
  const manager = new LocalModelManager({fetchImpl: fixture.fetchImpl});
  const row = (await manager.llamaCatalog()).models.find(item => item.status === 'sleeping');
  assert.equal(row.manageable, true);
  await manager.load({engine: 'llamacpp', model: row.id});
  assert.equal(fixture.calls.some(call => call.route === '/models/load'), false);
});
test('accepted llama.cpp load polls through unloaded and loading, then returns only on loaded', async () => {
  const {loadLlamaCpp}=await import('../lib/llama-cpp-local.mjs');
  const states=['unloaded','unloaded','loading','loaded'];
  let clock=0,posts=0;
  const request=async (_engine,route)=>{
    if(route==='/props')return {role:'router'};
    if(route==='/models')return {data:[{id:'test',status:{value:states.shift()}}]};
    assert.equal(route,'/models/load');posts++;return {success:true};
  };
  const result=await loadLlamaCpp(request,{model:'test'},{now:()=>clock,wait:async ms=>{clock+=ms;}});
  assert.equal(result.loaded,true);
  assert.equal(clock,500);
  assert.equal(posts,1);
});
test('a model already loading is not dispatched again and an unresolved load times out visibly', async () => {
  const {loadLlamaCpp}=await import('../lib/llama-cpp-local.mjs');
  let clock=0;
  const request=async (_engine,route)=>{
    if(route==='/props')return {role:'router'};
    assert.equal(route,'/models');
    return {data:[{id:'test',status:{value:'loading'}}]};
  };
  await assert.rejects(loadLlamaCpp(request,{model:'test'},{confirmationTimeoutMs:500,now:()=>clock,wait:async ms=>{clock+=ms;}}),
    {code:'LOCAL_MODEL_LOAD_UNCONFIRMED',status:504});
  assert.equal(clock,500);
});

function routerLoadSequence(states, otherModels = []) {
  const calls = []; let reads = 0, clock = 0;
  const request = async (engine, route, options) => {
    assert.equal(engine, 'llamacpp');
    calls.push({route, options});
    if (route === '/props') return {role: 'router'};
    if (route === '/models') return {data: [
      {id: 'test', status: states[Math.min(reads++, states.length - 1)]}, ...otherModels,
    ]};
    assert.equal(route, '/models/load', 'load confirmation must not perform inference');
    assert.deepEqual(options, {body: {model: 'test'}, timeoutMs: 300000});
    return {success: true};
  };
  return {request, calls, get elapsed() { return clock; },
    options: {confirmationTimeoutMs: 1000, now: () => clock, wait: async ms => { clock += ms; }}};
}

test('router catalog preserves valid child failure metadata without coercing malformed values', async () => {
  const {llamaCppCatalog} = await import('../lib/llama-cpp-local.mjs');
  const statuses = [
    {value: 'unloaded', failed: true, exit_code: 1},
    {value: 'unloaded', failed: false, exit_code: 0},
    {value: 'unloaded', failed: 'true', exit_code: '1'},
    {value: 'unloaded', failed: 1, exit_code: 1.5},
    {value: 'unloaded', failed: null, exit_code: Number.MAX_SAFE_INTEGER + 1},
    {value: 'unloaded', failed: undefined, exit_code: NaN},
    Object.assign([], {value: 'unloaded', failed: true, exit_code: 1}),
    'unloaded',
  ];
  const result = await llamaCppCatalog(async (_engine, route) => route === '/props'
    ? {role: 'router'} : {data: statuses.map((status, i) => ({id: 'model-' + i, status}))});
  assert.equal(result.models[0].failed, true);
  assert.equal(result.models[0].exitCode, 1);
  assert.equal(result.models[0].loaded, false);
  assert.equal(result.models[1].failed, false);
  assert.equal(result.models[1].exitCode, 0);
  for (const row of result.models.slice(2)) {
    assert.equal(Object.hasOwn(row, 'failed'), false);
    assert.equal(Object.hasOwn(row, 'exitCode'), false);
  }
});

for (const [name, terminal, exitCode] of [
  ['observed unloaded child exit', {value: 'unloaded', failed: true, exit_code: 1}, 1],
  ['explicit failure without exit metadata', {value: 'unloaded', failed: true}, undefined],
  ['nonzero exit without failure flag', {value: 'unloaded', exit_code: -9}, -9],
  ['legacy error status', {value: 'error'}, undefined],
  ['legacy failed status', 'failed', undefined],
]) test(name + ' rejects promptly after one accepted load', async () => {
  const {loadLlamaCpp} = await import('../lib/llama-cpp-local.mjs');
  const f = routerLoadSequence([{value: 'unloaded'}, terminal]);
  await assert.rejects(loadLlamaCpp(f.request, {model: 'test'}, f.options), error => {
    assert.equal(error.code, 'LOCAL_MODEL_LOAD_FAILED');
    assert.equal(error.status, 502);
    assert.match(error.message, /selected model failed to load/);
    if (exitCode === undefined) assert.doesNotMatch(error.message, /exit code/i);
    else assert.ok(error.message.includes('Child exit code: ' + exitCode + '.'));
    assert.ok(error.message.length < 200);
    return true;
  });
  assert.equal(f.elapsed, 0, 'a reported child failure must not wait for the readiness timeout');
  assert.equal(f.calls.filter(call => call.route === '/models/load').length, 1);
});

test('an explicit retry replaces historical failure and ignores stale metadata during new loading', async () => {
  const {loadLlamaCpp} = await import('../lib/llama-cpp-local.mjs');
  const failed = {failed: true, exit_code: 1};
  const f = routerLoadSequence([
    {value: 'unloaded', ...failed}, {value: 'loading', ...failed}, {value: 'loaded', ...failed},
  ]);
  assert.equal((await loadLlamaCpp(f.request, {model: 'test'}, f.options)).loaded, true);
  assert.equal(f.calls.filter(call => call.route === '/models/load').length, 1);
  assert.equal(f.elapsed, 250);
});

test('a retried child that fails before the first poll is reported even with the same exit code', async () => {
  const {loadLlamaCpp} = await import('../lib/llama-cpp-local.mjs');
  // The pinned router changes mapping to LOADING before replying success; a fast
  // new failure can therefore reproduce the prior status before the first poll.
  const failed = {value: 'unloaded', failed: true, exit_code: 1};
  const f = routerLoadSequence([failed, failed]);
  await assert.rejects(loadLlamaCpp(f.request, {model: 'test'}, f.options),
    {code: 'LOCAL_MODEL_LOAD_FAILED', status: 502});
  assert.equal(f.calls.filter(call => call.route === '/models/load').length, 1);
  assert.equal(f.elapsed, 0);
});

for (const value of ['loaded', 'sleeping']) test(value + ' ignores historical exit metadata without another load', async () => {
  const {loadLlamaCpp} = await import('../lib/llama-cpp-local.mjs');
  const f = routerLoadSequence([{value, failed: true, exit_code: 1}]);
  assert.equal((await loadLlamaCpp(f.request, {model: 'test'}, f.options)).loaded, true);
  assert.equal(f.calls.filter(call => call.route === '/models/load').length, 0);
});

test('an already loading model with stale exit metadata receives no duplicate load', async () => {
  const {loadLlamaCpp} = await import('../lib/llama-cpp-local.mjs');
  const f = routerLoadSequence([
    {value: 'loading', failed: true, exit_code: 1}, {value: 'sleeping', failed: true, exit_code: 1},
  ]);
  assert.equal((await loadLlamaCpp(f.request, {model: 'test'}, f.options)).loaded, true);
  assert.equal(f.calls.filter(call => call.route === '/models/load').length, 0);
});

test('unloaded exit zero and malformed failure fields still allow asynchronous loading', async () => {
  const {loadLlamaCpp} = await import('../lib/llama-cpp-local.mjs');
  const f = routerLoadSequence([
    {value: 'unloaded'}, {value: 'unloaded', failed: false, exit_code: 0},
    {value: 'unloaded', failed: 'true', exit_code: '1'}, {value: 'loaded'},
  ]);
  assert.equal((await loadLlamaCpp(f.request, {model: 'test'}, f.options)).loaded, true);
  assert.equal(f.elapsed, 500);
  assert.equal(f.calls.filter(call => call.route === '/models/load').length, 1);
});

test('a different catalog model failure cannot poison the selected load', async () => {
  const {loadLlamaCpp} = await import('../lib/llama-cpp-local.mjs');
  const f = routerLoadSequence([{value: 'unloaded'}, {value: 'loading'}, {value: 'loaded'}],
    [{id: 'different-model', status: {value: 'unloaded', failed: true, exit_code: 1}}]);
  assert.equal((await loadLlamaCpp(f.request, {model: 'test'}, f.options)).loaded, true);
  assert.equal(f.elapsed, 250);
});

test('actual child failure propagates through manager and HTTP, releases shared leases and never registers a provider', async () => {
  let posts = 0, active = 0, released = 0, registered = 0;
  const routes = [], supervisor = {
    async acquire() {
      active++; let done = false;
      return {owned: true, release() { assert.equal(done, false); done = true; active--; released++; }};
    },
  };
  const fetchImpl = async (url, options = {}) => {
    const route = new URL(url).pathname; routes.push(route);
    if (route === '/props') return reply({role: 'router'});
    if (route === '/models') return reply({data: [
      {id: 'test', status: posts ? {value: 'unloaded', failed: true, exit_code: 1} : {value: 'unloaded'}},
    ]});
    assert.equal(route, '/models/load', 'failure must not reach discovery or inference');
    assert.deepEqual(JSON.parse(options.body), {model: 'test'});
    posts++; return reply({success: true});
  };
  const manager = new LocalModelManager({fetchImpl, llamaSupervisor: supervisor});
  const results = await Promise.allSettled([manager.acquireLlama('test'), manager.acquireLlama('test')]);
  assert.equal(posts, 1, 'concurrent callers share the same failed load');
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.code, 'LOCAL_MODEL_LOAD_FAILED');
    assert.match(result.reason.message, /Child exit code: 1/);
  }
  assert.equal(active, 0); assert.equal(released, 2);
  const runtime = {listProviders: () => [], saveProvider: async () => { registered++; }};
  const response = await localModelHTTP({manager, runtime, pathname: '/api/local-models/load',
    method: 'POST', value: {engine: 'llamacpp', model: 'test'}});
  assert.equal(response.status, 502);
  assert.equal(response.body.code, 'LOCAL_MODEL_LOAD_FAILED');
  assert.match(response.body.error, /Child exit code: 1/);
  assert.equal(posts, 2, 'the separate explicit HTTP retry is admitted once');
  assert.equal(active, 0); assert.equal(released, 3); assert.equal(registered, 0);
  assert.equal(routes.every(route => ['/props', '/models', '/models/load'].includes(route)), true);
});


test('loading HTTP responses during confirmation only retry catalog reads',async()=>{
 const {loadLlamaCpp}=await import('../lib/llama-cpp-local.mjs');let loads=0,reads=0,clock=0;
 const request=async (_engine,route)=>{
  if(route==='/props')return{role:'router'};
  if(route==='/models/load'){loads++;return {success:true};}
  assert.equal(route,'/models');reads++;
  if(reads===2||reads===3)throw Object.assign(Error('Loading model'),{code:'LOCAL_LLAMA_LOADING',status:503});
  return{data:[{id:'fixture',status:{value:reads===1?'unloaded':'loaded'}}]};
 };
 assert.equal((await loadLlamaCpp(request,{model:'fixture'},{now:()=>clock,wait:async ms=>{clock+=ms},confirmationTimeoutMs:1000})).loaded,true);
 assert.equal(loads,1);assert.equal(reads,4);assert.equal(clock,500);
});
