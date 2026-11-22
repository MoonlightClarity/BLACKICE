import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {ProviderStore, normalizeProvider} from '../lib/provider-store.mjs';
import {ProviderRuntime} from '../lib/providers.mjs';
import {LlamaCppSettingsStore} from '../lib/llama-cpp-settings.mjs';
import {prepareLocalModelProfileAssets} from '../lib/local-model-profile-assets.mjs';
import {registerLocalModel} from '../lib/local-model-manager.mjs';
import {localModelHTTP} from '../lib/local-model-http.mjs';
import {createMiniCPMLocalProfileSetup, MINICPM_LOCAL_ASSET_MANIFEST, MINICPM_LOCAL_MODEL_ID, QUALIFIED_MINICPM_LOCAL_PROFILE} from '../lib/minicpm-local-profile.mjs';
import {createLocalModelSettings} from '../public/next/workspaces/settings-local-models.mjs';
import {createSubscriptionModelSettings} from '../public/next/workspaces/settings-subscriptions.mjs';
import {createGroupedModelPicker} from '../public/next/core/model-picker.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';

const originalFetch = globalThis.fetch;
let loopbackOrigin = null, forbiddenRequests = 0;
globalThis.fetch = (url, options) => {
  if (loopbackOrigin && new URL(url).origin === loopbackOrigin) return originalFetch(url, options);
  forbiddenRequests++; throw Error('External network forbidden in local-profile fixture gate');
};
after(() => { globalThis.fetch = originalFetch; assert.equal(forbiddenRequests, 0); });
const MODEL = Buffer.from('GGUF\0fixture-model: \ud83d\ude80 e\u0301\0', 'utf8'), PROJECTOR = Buffer.from([71, 71, 85, 70, 0, 255, 64, 3]);
const sha = value => createHash('sha256').update(value).digest('hex');
const fixtureManifest = () => ({profileId:'minicpm-fixture', version:'fixture-v1', assets:[
  {id:'model', fileName:'model.gguf', url:'https://fixture.invalid/pinned/model.gguf', sizeBytes:MODEL.length, sha256:sha(MODEL)},
  {id:'projector', fileName:'projector.gguf', url:'https://fixture.invalid/pinned/projector.gguf', sizeBytes:PROJECTOR.length, sha256:sha(PROJECTOR)},
]});
const fixtureRecipe = () => ({version:'fixture-reviewed-v1', settings:{reasoning:'off', temperature:0.8}});
const exists = filename => fs.lstat(filename).then(() => true, cause => cause.code === 'ENOENT' ? false : Promise.reject(cause));
const settle = () => new Promise(resolve => setImmediate(resolve));
const until = async predicate => { for (let index = 0; index < 200; index++) { if (predicate()) return; await settle(); } throw Error('Fixture did not settle'); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const local = extra => ({id:'local_llamacpp', name:'Local llama.cpp', preset:'llamacpp', type:'compatible', baseUrl:'http://127.0.0.1:8080/v1', models:[MINICPM_LOCAL_MODEL_ID], ...extra});
const globals = store => ({defaultModel:store.defaultModel, automaticDefaultModel:store.automaticDefaultModel});

async function fixture(t, {qualified = true, cleanup = true} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-lcp1-')), dataDir = path.join(directory, 'data');
  const store = new ProviderStore({dataDir}); await store.init(); await store.setDefaultModel('gpt-6-luna');
  const settings = await new LlamaCppSettingsStore({dataDir}).init();
  const calls = {prepare:[], transfers:[], configure:[], register:[], initialize:[], model:0}, setups = [];
  const forbidden = () => { calls.model++; assert.fail('No model load or activation is permitted'); };
  const manager = {
    init:async () => {}, close:async () => {}, llamaConfig:() => settings.snapshot(),
    configureLlama:async value => { calls.configure.push(structuredClone(value)); return settings.update(value); },
    list:async () => ({engines:[{id:'ollama', available:true, models:[{id:'unrelated', loaded:false}]}, {id:'llamacpp', available:false, models:[]}]}),
    load:forbidden, activateLlama:forbidden, acquireLlama:forbidden,
  };
  class Runtime extends EventEmitter {
    listProviders() { return store.list(); }
    localDefaultModelStatus() { return store.localDefaultModelStatus(); }
    localDefaultModelChoices() { return store.localDefaultModelChoices(); }
    localDefaultModelPreference() { return store.localDefaultModelPreference(); }
    async setLocalDefaultModel(model, options) { await store.setLocalDefaultModel(model, options); return this.localDefaultModelStatus(); }
    async initializeLocalDefaultModel(model, options) { calls.initialize.push({model, options}); await store.initializeLocalDefaultModel(model, options); return this.localDefaultModelPreference(); }
    async saveProvider(input, options) { calls.register.push({input:structuredClone(input), options:structuredClone(options)}); assert.equal(options.preserveDefault, true); return store.save(input, options); }
    status() { return {connected:true, defaultModel:'gpt-6-luna', localDefaultModelStatus:this.localDefaultModelStatus(), providers:this.listProviders(), models:[]}; }
    async start() { return this.status(); } async close() {} async runAgent() { forbidden(); }
  }
  const runtime = new Runtime(), manifest = fixtureManifest();
  const fetchFixture = async (url, options) => {
    assert.equal(options.redirect, 'manual'); calls.transfers.push(url);
    return new Response(url.endsWith('/model.gguf') ? MODEL : PROJECTOR);
  };
  const prepare = async options => { calls.prepare.push(structuredClone({...options, signal:undefined})); return prepareLocalModelProfileAssets({...options, fetchImpl:fetchFixture}); };
  const create = options => {
    const setup = createMiniCPMLocalProfileSetup({manager, runtime, dataDir, qualifiedProfile:qualified ? fixtureRecipe() : null,
      assetManifest:manifest, prepareAssets:prepare, ...options}); setups.push(setup); return setup;
  };
  const setup = create(); await setup.init();
  const request = (intentId = randomUUID()) => {
    const status = setup.status(); return {intentId, profileId:manifest.profileId, expectedRevision:status.expectedRevision,
      expectedLocalDefaultModel:status.expectedLocalDefaultModel, expectedLocalDefaultInitialized:status.expectedLocalDefaultInitialized};
  };
  const configure = async patch => { const snapshot = settings.snapshot(); return settings.update({expectedRevision:snapshot.revision, settings:{...snapshot.settings, ...patch}}); };
  const writeExternal = async ({model = true, projector = true, renamed = true} = {}) => {
    const result = {};
    for (const [id, present, bytes] of [['model', model, MODEL], ['projector', projector, PROJECTOR]]) if (present) {
      const folder = path.join(directory, id === 'model' ? 'external-weights' : 'external-projectors'); await fs.mkdir(folder, {recursive:true});
      result[id] = path.join(folder, renamed ? 'renamed-' + id + '.gguf' : id + '.gguf'); await fs.writeFile(result[id], bytes);
    }
    return result;
  };
  const dispose = async () => { for (const current of setups) await current.close(); await fs.rm(directory, {recursive:true, force:true}); };
  if (cleanup) t.after(dispose);
  return {directory, dataDir, store, settings, manager, runtime, setup, create, request, configure, writeExternal, calls, manifest, prepare, fetchFixture, dispose};
}
async function rejected(operation, code) {
  let cause; try { await operation; } catch (value) { cause = value; }
  assert.ok(cause, 'operation must reject'); if (code) assert.equal(cause.code, code); return cause;
}

test('production manifest pins the original two assets and no runtime recipe is selected', () => {
  assert.equal(QUALIFIED_MINICPM_LOCAL_PROFILE, null);
  const pinned = MINICPM_LOCAL_ASSET_MANIFEST;
  assert.equal(Object.isFrozen(pinned), true); assert.equal(Object.isFrozen(pinned.assets), true);
  assert.equal(pinned.version, 'c353e931b31f4bb6217b84ff99f0d1b6da93d97d');
  assert.deepEqual(pinned.assets.map(item => [item.fileName, item.sizeBytes, item.sha256]), [
    ['MiniCPM-V-4.7-1B-heretic-Q4_K_S.gguf', 647960224, '0c91d961f2eb27e8b32bbcdbae45bcdc06002e55022c6ee66ba3bf4ce347116a'],
    ['MiniCPM-V-4.7-1B-heretic-mmproj-F16.gguf', 1108763232, '9e1672166a455f579b4a441590d93f13342a08ecc159719c8eb7a1eac101317f'],
  ]);
  for (const item of pinned.assets) assert.equal(item.url, 'https://huggingface.co/saidutta69/MiniCPM-V-4.7-1B-heretic/resolve/' + pinned.version + '/' + item.fileName);
  assert.equal(pinned.assets.reduce((sum, item) => sum + item.sizeBytes, 0), 1756723456);
});

test('unavailable recipe rejects before any asset, receipt-directory, settings or provider effect', async t => {
  const f = await fixture(t, {qualified:false}), before = await fs.readFile(f.store.file, 'utf8');
  assert.equal(f.setup.summary().available, false); assert.equal(f.setup.summary().offerSetup, false);
  await rejected(f.setup.setup(f.request()), 'LOCAL_PROFILE_UNAVAILABLE');
  assert.equal(f.calls.prepare.length + f.calls.configure.length + f.calls.register.length + f.calls.initialize.length + f.calls.model, 0);
  assert.equal(await exists(path.join(f.dataDir, 'local-model-profile-setups')), false);
  assert.equal(await exists(f.settings.defaultModelsDirectory), false); assert.equal(await exists(f.settings.file), false);
  assert.equal(await fs.readFile(f.store.file, 'utf8'), before);
});

test('marker migration distinguishes absent Local preference from deliberate or ambiguous prior choices', async t => {
  const cases = [
    ['absent', {}, false], ['legacy null', {localDefaultModel:null}, true],
    ['explicit false', {localDefaultModel:null, localDefaultInitialized:false}, false],
    ['clear', {localDefaultModel:null, localDefaultInitialized:true}, true],
    ['concrete choice', {localDefaultModel:'local_llamacpp::existing'}, true],
    ['concrete false marker', {localDefaultModel:'local_llamacpp::existing', localDefaultInitialized:false}, true],
  ];
  for (const [name, extra, initialized] of cases) await t.test(name, async t => {
    const f = await fixture(t);
    await fs.writeFile(f.store.file, JSON.stringify({version:1, providers:[], defaultModel:'gpt-6-luna', ...extra}));
    const store = new ProviderStore({dataDir:f.dataDir}); await store.init(); assert.equal(store.localDefaultModelPreference().initialized, initialized);
    assert.equal(store.defaultModel, 'gpt-6-luna');
  });
});

test('explicit null-to-null clear persists and prevents automatic initialization; failed persistence publishes no marker', async t => {
  const f = await fixture(t); await f.store.save(local());
  const before = await fs.readFile(f.store.file, 'utf8'), persist = f.store.persist.bind(f.store);
  f.store.persist = async () => { throw Error('fixture disk failure'); };
  await assert.rejects(f.store.setLocalDefaultModel(null, {expectedLocalDefaultModel:null}), /fixture disk failure/);
  assert.equal(f.store.localDefaultInitialized, false); assert.equal(await fs.readFile(f.store.file, 'utf8'), before);
  f.store.persist = persist;
  await f.store.setLocalDefaultModel(null, {expectedLocalDefaultModel:null});
  const restored = new ProviderStore({dataDir:f.dataDir}); await restored.init(); assert.equal(restored.localDefaultInitialized, true);
  await rejected(restored.initializeLocalDefaultModel('local_llamacpp::' + MINICPM_LOCAL_MODEL_ID,
    {expectedLocalDefaultModel:null, expectedLocalDefaultInitialized:false}), 'LOCAL_DEFAULT_CONFLICT');
  assert.equal(restored.localDefaultModel, null); assert.equal(restored.defaultModel, 'gpt-6-luna');
});

test('fresh setup verifies tiny pinned assets, persists native settings and Local preference without loading', async t => {
  const f = await fixture(t), before = globals(f.store), original = f.settings.snapshot().settings;
  const receipt = await f.setup.setup(f.request());
  assert.equal(receipt.status, 'complete'); assert.equal(f.calls.transfers.length, 2);
  assert.equal(receipt.settings.profileApplied, true); assert.equal(receipt.settings.overrideDisposition, 'initialized');
  const saved = f.settings.snapshot(), override = saved.settings.modelOverrides[MINICPM_LOCAL_MODEL_ID];
  assert.deepEqual(override, {...fixtureRecipe().settings, mmprojPath:path.join(f.settings.defaultModelsDirectory, 'projector.gguf')});
  assert.equal(saved.settings.ctxSize, original.ctxSize); assert.equal(saved.settings.gpuLayers, original.gpuLayers);
  assert.equal(Object.hasOwn(saved.settings, 'threads'), false); assert.equal(f.calls.model, 0);
  assert.equal(receipt.registration.selection, 'local_llamacpp::' + MINICPM_LOCAL_MODEL_ID);
  assert.equal(receipt.localDefault.status, 'initialized'); assert.equal(f.store.localDefaultModel, receipt.registration.selection);
  assert.deepEqual(globals(f.store), before); assert.equal(f.store.get('local_llamacpp').outputTokenPolicy, 'provider-default');
  const reloaded = new ProviderStore({dataDir:f.dataDir}); await reloaded.init(); assert.equal(reloaded.localDefaultInitialized, true);
  assert.equal(reloaded.localDefaultModel, receipt.registration.selection);
});

test('configured renamed GGUF and projector in different external directories are reused without transfer or repointing', async t => {
  const f = await fixture(t), external = await f.writeExternal();
  const explicit = {mmprojPath:external.projector, mmprojOffload:false, temperature:0.22};
  await f.configure({modelPaths:{[MINICPM_LOCAL_MODEL_ID]:external.model}, modelOverrides:{[MINICPM_LOCAL_MODEL_ID]:explicit}});
  const before = f.settings.snapshot(), source = await fs.readFile(f.settings.file, 'utf8');
  const receipt = await f.setup.setup(f.request());
  assert.equal(receipt.status, 'complete'); assert.equal(f.calls.prepare.length, 0); assert.equal(f.calls.transfers.length, 0);
  assert.equal(f.calls.configure.length, 0); assert.equal(receipt.settings.status, 'unchanged');
  assert.deepEqual(receipt.assets.map(item => [item.id, item.path, item.source]), [['model', external.model, 'configured'], ['projector', external.projector, 'configured']]);
  assert.deepEqual(f.settings.snapshot(), before); assert.equal(await fs.readFile(f.settings.file, 'utf8'), source);
  assert.equal(await exists(f.settings.defaultModelsDirectory), false); assert.equal(receipt.settings.profileApplied, false);
  assert.match(receipt.limitations.join(' '), /preserved/); assert.equal(f.calls.model, 0);
});

test('only the unconfigured asset is downloaded when the configured model is already verified', async t => {
  const f = await fixture(t), external = await f.writeExternal({projector:false});
  await f.configure({modelPaths:{[MINICPM_LOCAL_MODEL_ID]:external.model}});
  const receipt = await f.setup.setup(f.request());
  assert.deepEqual(f.calls.transfers, [f.manifest.assets[1].url]); assert.deepEqual(f.calls.prepare[0].manifest.assets.map(item => item.id), ['projector']);
  assert.equal(f.settings.snapshot().settings.modelPaths[MINICPM_LOCAL_MODEL_ID], external.model);
  assert.equal(receipt.assets.find(item => item.id === 'model').source, 'configured');
  assert.equal(receipt.assets.find(item => item.id === 'projector').source, 'managed');
});

test('wrong or missing configured assets stop setup before any download or configuration', async t => {
  for (const kind of ['wrong model', 'missing projector']) await t.test(kind, async t => {
    const f = await fixture(t), external = await f.writeExternal();
    if (kind === 'wrong model') await fs.writeFile(external.model, Buffer.alloc(MODEL.length, 5));
    else await fs.unlink(external.projector);
    await f.configure({modelPaths:{[MINICPM_LOCAL_MODEL_ID]:external.model}, modelOverrides:{[MINICPM_LOCAL_MODEL_ID]:{mmprojPath:external.projector}}});
    const before = f.settings.snapshot(), cause = await rejected(f.setup.setup(f.request()));
    assert.equal(cause.receipt.stage, 'verify-configured'); assert.equal(cause.receipt.failedVerification.status, 'failed');
    assert.equal(f.calls.prepare.length + f.calls.configure.length + f.calls.register.length, 0);
    assert.deepEqual(f.settings.snapshot(), before); assert.equal(f.store.localDefaultModel, null);
    assert.equal(await exists(f.settings.defaultModelsDirectory), false);
  });
});

test('explicit empty and nonempty overrides are preserved and their limits are reported', async t => {
  for (const explicit of [{}, {reasoning:'on', topP:0.7}]) await t.test(JSON.stringify(explicit), async t => {
    const f = await fixture(t); await f.configure({modelOverrides:{[MINICPM_LOCAL_MODEL_ID]:explicit}});
    const receipt = await f.setup.setup(f.request());
    assert.deepEqual(f.settings.snapshot().settings.modelOverrides[MINICPM_LOCAL_MODEL_ID], explicit);
    assert.equal(receipt.settings.profileApplied, false); assert.equal(receipt.settings.projectorConfigured, false);
    assert.match(receipt.limitations.join(' '), /does not configure/); assert.equal(f.calls.model, 0);
  });
});

test('a deliberate clear or existing Local choice stays unchanged during setup', async t => {
  for (const selected of [null, 'other_local::existing']) await t.test(String(selected), async t => {
    const f = await fixture(t); await f.store.save(local({id:'other_local', models:['existing'], outputTokenPolicy:'configured-limit'}));
    await f.store.setLocalDefaultModel(selected, {expectedLocalDefaultModel:null});
    const before = globals(f.store), receipt = await f.setup.setup(f.request());
    assert.equal(receipt.localDefault.status, 'preserved'); assert.equal(f.calls.initialize.length, 0);
    assert.equal(f.store.localDefaultModel, selected); assert.equal(f.store.localDefaultInitialized, true); assert.deepEqual(globals(f.store), before);
    assert.equal(f.store.get('other_local').outputTokenPolicy, 'configured-limit');
  });
});

test('new suffixed providers keep native output defaults; existing provider metadata and policies are preserved', async t => {
  const f = await fixture(t); await f.store.save({id:'local_llamacpp', name:'Existing cloud route', preset:'compatible', type:'compatible', baseUrl:'https://cloud.invalid/v1', models:['cloud-model']});
  const cloud = structuredClone(f.store.get('local_llamacpp')), before = globals(f.store);
  const receipt = await f.setup.setup(f.request());
  assert.equal(receipt.registration.providerId, 'local_llamacpp_2'); assert.equal(f.store.get('local_llamacpp_2').outputTokenPolicy, 'provider-default');
  assert.deepEqual(f.store.get('local_llamacpp'), cloud); assert.deepEqual(globals(f.store), before);
});

test('provider-default output admits generated local suffixes while preserving the managed transport boundary', () => {
  for (const id of ['local_llamacpp', 'local_llamacpp_2', 'local_llamacpp_10', 'local_llamacpp_999'])
    assert.equal(normalizeProvider(local({id, outputTokenPolicy:'provider-default'})).outputTokenPolicy, 'provider-default');
  for (const extra of [{id:'other_local'}, {id:'local_llamacpp_1'}, {id:'local_llamacpp_02'}, {id:'local_llamacpp_x'},
    {baseUrl:'https://remote.invalid/v1'}, {preset:'compatible'}, {endpoints:{chatCompletions:'/custom/chat'}}])
    assert.throws(() => normalizeProvider(local({id:'local_llamacpp_2', outputTokenPolicy:'provider-default', ...extra})), {code:'INVALID_OUTPUT_TOKEN_POLICY'});
});

test('disabled and endpoint-overridden managed routes are not enabled or modified by setup', async t => {
  for (const extra of [{enabled:false}, {endpoints:{chatCompletions:'/custom/chat'}}]) await t.test(JSON.stringify(extra), async t => {
    const f = await fixture(t); await f.store.save(local(extra)); const before = structuredClone(f.store.get('local_llamacpp'));
    await rejected(f.setup.setup(f.request()), 'LOCAL_MODEL_REGISTRATION_CONFLICT');
    assert.deepEqual(f.store.get('local_llamacpp'), before); assert.equal(f.calls.prepare.length + f.calls.register.length + f.calls.configure.length, 0);
  });
});

test('guarded registration cannot overwrite a provider changed while its save is queued', async t => {
  const f = await fixture(t); await f.store.save(local({models:['earlier']}));
  const saved = f.runtime.saveProvider.bind(f.runtime);
  f.runtime.saveProvider = async (input, options) => {
    await f.store.save({id:input.id, enabled:false}); return saved(input, options);
  };
  await rejected(registerLocalModel(f.runtime, 'llamacpp', MINICPM_LOCAL_MODEL_ID, {guarded:true}), 'PROVIDER_CHANGED');
  assert.equal(f.store.get('local_llamacpp').enabled, false); assert.deepEqual(f.store.get('local_llamacpp').models.map(item => item.id), ['earlier']);
});

test('settings changes and explicit clears during transfer win over stale setup expectations', async t => {
  for (const kind of ['settings', 'clear']) await t.test(kind, async t => {
    const f = await fixture(t), gate = deferred(), entered = deferred();
    const setup = f.create({prepareAssets:async options => { entered.resolve(); await gate.promise; return f.prepare(options); }});
    const request = f.request(), pending = setup.setup(request); await Promise.race([entered.promise, pending]);
    if (kind === 'settings') await f.configure({threads:3}); else await f.store.setLocalDefaultModel(null, {expectedLocalDefaultModel:null});
    gate.resolve(); const cause = await rejected(pending, kind === 'settings' ? 'LOCAL_LLAMA_SETTINGS_REVISION' : 'LOCAL_DEFAULT_CONFLICT');
    assert.equal(cause.receipt.assets.length, 2); assert.equal(cause.receipt.settings, null);
    assert.equal(f.calls.configure.length + f.calls.register.length, 0); assert.equal(f.store.localDefaultModel, null);
    if (kind === 'clear') assert.equal(f.store.localDefaultInitialized, true); else assert.equal(f.settings.snapshot().settings.threads, 3);
  });
});

test('same in-flight intent joins once, conflicting intent is busy, and saved completion replays after restart', async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred();
  const setup = f.create({prepareAssets:async options => { entered.resolve(); await gate.promise; return f.prepare(options); }}), request = f.request();
  const first = setup.setup(request); await Promise.race([entered.promise, first]); const joined = setup.setup(structuredClone(request)); assert.equal(joined, first);
  await rejected(setup.setup({...request, intentId:randomUUID()}), 'LOCAL_PROFILE_BUSY'); gate.resolve();
  const receipt = await first; assert.equal(receipt.status, 'complete'); assert.equal(f.calls.prepare.length, 1);
  const before = structuredClone(f.calls), restarted = f.create(); await restarted.init();
  const recovered = await restarted.setup(request); assert.equal(recovered.intentId, receipt.intentId); assert.equal(recovered.status, 'complete');
  assert.deepEqual(f.calls, before); await rejected(restarted.setup({...request, expectedRevision:request.expectedRevision + 1}), 'LOCAL_PROFILE_INTENT_CONFLICT');
});

test('interrupted durable intent is reported without startup resume or a duplicate setup', async t => {
  const f = await fixture(t), request = f.request(), receipt = await f.setup.setup(request);
  const filename = path.join(f.dataDir, 'local-model-profile-setups', request.intentId + '.json');
  await fs.writeFile(filename, JSON.stringify({...receipt, status:'running', stage:'settings'}));
  const before = structuredClone(f.calls), restarted = f.create(); await restarted.init();
  assert.equal(restarted.status().receipt.status, 'interrupted'); assert.equal(restarted.status().receipt.outcomeUncertain, true);
  const cause = await rejected(restarted.setup(request), 'LOCAL_PROFILE_INTERRUPTED'); assert.equal(cause.receipt.outcomeUncertain, true);
  assert.deepEqual(f.calls, before);
});

test('failed settings stage preserves verified files, replays its failure, then reuses files for a fresh intent', async t => {
  const f = await fixture(t), configure = f.manager.configureLlama.bind(f.manager), request = f.request();
  f.manager.configureLlama = async () => { throw Object.assign(Error('Fixture settings write failed'), {code:'LOCAL_PROFILE_FIXTURE', status:500}); };
  const cause = await rejected(f.setup.setup(request), 'LOCAL_PROFILE_FIXTURE'); assert.equal(cause.receipt.assets.length, 2);
  assert.equal(cause.receipt.settings, null); assert.equal(cause.receipt.registration, null); assert.equal(f.store.localDefaultModel, null);
  const count = f.calls.transfers.length; await rejected(f.setup.setup(request), 'LOCAL_PROFILE_FIXTURE'); assert.equal(f.calls.transfers.length, count);
  f.manager.configureLlama = configure;
  const retry = await f.setup.setup(f.request()); assert.equal(retry.status, 'complete'); assert.equal(f.calls.transfers.length, count);
  assert.equal(retry.assetPreparation.assets.every(item => item.status === 'reused'), true);
});

test('registration and final preference conflicts retain the actual earlier durable stages', async t => {
  for (const kind of ['registration', 'preference']) await t.test(kind, async t => {
    const f = await fixture(t), request = f.request();
    if (kind === 'registration') f.runtime.saveProvider = async () => { throw Object.assign(Error('Fixture registration failed'), {code:'LOCAL_PROFILE_FIXTURE', status:500}); };
    else { const initialize = f.runtime.initializeLocalDefaultModel.bind(f.runtime); f.runtime.initializeLocalDefaultModel = async (...args) => { await f.store.setLocalDefaultModel(null, {expectedLocalDefaultModel:null}); return initialize(...args); }; }
    const cause = await rejected(f.setup.setup(request));
    assert.equal(cause.receipt.settings.status, 'saved'); assert.equal(f.settings.snapshot().revision, 1);
    assert.equal(cause.receipt.localDefault, null); assert.equal(f.store.localDefaultModel, null);
    if (kind === 'registration') assert.equal(cause.receipt.registration, null);
    else { assert.equal(cause.code, 'LOCAL_DEFAULT_CONFLICT'); assert.equal(cause.receipt.registration.status, 'saved'); assert.equal(f.store.localDefaultInitialized, true); }
    const restarted = f.create(); await restarted.init(); assert.equal(restarted.status().receipt.status, 'failed');
  });
});

test('cancellation after one published asset records it without applying any settings', async t => {
  const f = await fixture(t), controller = new AbortController();
  const setup = f.create({prepareAssets:options => prepareLocalModelProfileAssets({...options, fetchImpl:async url => {
    if (url.endsWith('/model.gguf')) return new Response(MODEL); controller.abort(); throw Error('fixture abort');
  }})});
  const cause = await rejected(setup.setup(f.request(), {signal:controller.signal}), 'LOCAL_PROFILE_CANCELLED');
  assert.equal(cause.receipt.assetPreparation.assets[0].status, 'published'); assert.equal(cause.receipt.assetPreparation.assets[1].status, 'cancelled');
  assert.equal(cause.receipt.settings, null); assert.equal(f.calls.configure.length + f.calls.register.length, 0);
  assert.deepEqual(await fs.readFile(path.join(f.settings.defaultModelsDirectory, 'model.gguf')), MODEL);
});

test('local profile HTTP rejects remote and arbitrary configuration fields, retaining partial error receipts', async t => {
  const f = await fixture(t), base = {manager:f.manager, runtime:f.runtime, profileSetup:f.setup, pathname:'/api/local-models/profile', method:'POST'};
  assert.equal((await localModelHTTP({...base, remote:true, value:f.request()})).status, 403);
  for (const extra of [{url:'https://untrusted.invalid/model'}, {settings:{}}, {assetManifest:{}}, {action:'prepare-assets'}, {modelsDirectory:f.directory}])
    assert.equal((await localModelHTTP({...base, value:{...f.request(), ...extra}})).status, 400);
  assert.equal(f.calls.prepare.length, 0);
  const result = await localModelHTTP({...base, value:f.request()}); assert.equal(result.status, 200); assert.equal(result.body.receipt.status, 'complete');
  const status = await localModelHTTP({...base, method:'GET'}); assert.equal(status.body.receipt.intentId, result.body.receipt.intentId);
  const stale = await localModelHTTP({...base, value:{...f.request(), expectedRevision:0}}); assert.equal(stale.status, 409); assert.equal(stale.body.receipt.stage, 'admission');
  assert.equal(f.calls.model, 0); assert.equal(f.store.defaultModel, 'gpt-6-luna');
});

test('ProviderRuntime exposes initialization through its existing tracked configuration path', async t => {
  const f = await fixture(t); await f.store.save(local());
  class Codex extends EventEmitter { status() { return {connected:true, authenticated:true, defaultModel:'gpt-6-luna', models:[], activeTurns:0}; } async close() {} }
  const runtime = await new ProviderRuntime({dataDir:f.dataDir, codex:new Codex(), fetchImpl:async () => assert.fail('No provider network expected')}).init();
  t.after(() => runtime.close()); const before = runtime.defaultModelStatus(), events = []; runtime.on('status', value => events.push(value));
  await runtime.initializeLocalDefaultModel('local_llamacpp::' + MINICPM_LOCAL_MODEL_ID, {expectedLocalDefaultModel:null, expectedLocalDefaultInitialized:false});
  assert.equal(runtime.localDefaultModelPreference().initialized, true); assert.deepEqual(runtime.defaultModelStatus(), before);
  assert.equal(events.at(-1).localDefaultModelStatus.model, 'local_llamacpp::' + MINICPM_LOCAL_MODEL_ID);
});

test('served profile route uses authenticated local-session admission and the injected fixture coordinator', async t => {
  const f = await fixture(t, {cleanup:false}), {createHarnessServer} = await import('../server.mjs'); let app;
  const closed = [], closeProfile = f.setup.close.bind(f.setup);
  f.setup.close = async () => { closed.push('profile'); await closeProfile(); };
  f.runtime.close = async () => { closed.push('runtime'); };
  t.after(async () => { loopbackOrigin = null; await app?.close(); await f.dispose(); });
  app = await createHarnessServer({runtime:f.runtime, localModels:f.manager, localModelProfile:f.setup, dataDir:f.dataDir, defaultCwd:f.directory, port:0});
  const base = await app.listen(); loopbackOrigin = new URL(base).origin;
  const home = await fetch(base), cookie = home.headers.get('set-cookie').split(';')[0]; await home.text();
  const send = (body, extra = {}) => fetch(loopbackOrigin + '/api/local-models/profile', {method:'POST', headers:{Cookie:cookie, Origin:loopbackOrigin, 'Content-Type':'application/json', ...extra}, body:JSON.stringify(body)});
  const remote = await send(f.request(), {'x-blackice-remote':'1'}); assert.equal(remote.status, 403); await remote.text(); assert.equal(f.calls.prepare.length, 0);
  const response = await send(f.request()), result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.receipt.status, 'complete');
  const status = await fetch(loopbackOrigin + '/api/status', {headers:{Cookie:cookie}}), value = await status.json();
  assert.equal(value.localModelProfile.offerSetup, false); assert.equal(value.defaultModel, 'gpt-6-luna'); assert.equal(f.calls.model, 0);
  await app.close(); assert.deepEqual(closed, ['profile', 'runtime']);
});

async function uiFixture(t, options = {}) {
  const f = await fixture(t, options), dom = planningDOM(t), requests = [], state = {changed:0};
  const api = async (route, method = 'GET', value) => {
    requests.push({route, method, value});
    if (options.loseProfileResponse && route === '/api/local-models/profile' && method === 'POST') {
      options.profileReceipt = {intentId:value.intentId, status:'running', assets:[{id:'model', status:'verified'}]};
      throw Error('Fixture setup response was lost');
    }
    const result = await localModelHTTP({manager:f.manager, runtime:f.runtime, profileSetup:f.setup, pathname:route, method, value});
    if (!result) throw Error('Unexpected fixture route: ' + route);
    if (result.status >= 400) throw Object.assign(new Error(result.body.error), result.body, {status:result.status});
    if (options.profileReceipt && route === '/api/local-models') result.body.localModelProfile.receipt = structuredClone(options.profileReceipt);
    return result.body;
  };
  const panel = createLocalModelSettings({mount:dom.mount, api, storage:{getItem:() => null, setItem:() => {}}, onChanged:() => { state.changed++; }});
  t.after(() => panel.destroy()); panel.enter(); await until(() => requests.some(item => item.route === '/api/local-models')); await settle();
  return {...f, ...dom, api, panel, requests, state};
}

test('Local settings expose one complete action with honest size and no prepare-only or speculative labels', async t => {
  const f = await uiFixture(t);
  assert.equal(f.$('#next-local-profile').hidden, false); assert.equal(f.$('#next-local-profile-setup').textContent, 'Set up MiniCPM for Local');
  assert.match(f.$('#next-local-profile-help').textContent, new RegExp(String(MODEL.length + PROJECTOR.length) + ' bytes'));
  assert.doesNotMatch(f.$('#next-local-profile').textContent, /qualif|prepare.assets/i);
  assert.equal(f.requests.filter(item => item.method === 'POST').length, 0);
  await f.click('#next-local-profile-setup');
  const writes = f.requests.filter(item => item.method === 'POST'); assert.equal(writes.length, 1); assert.equal(writes[0].route, '/api/local-models/profile');
  assert.deepEqual(Object.keys(writes[0].value).sort(), ['expectedLocalDefaultInitialized', 'expectedLocalDefaultModel', 'expectedRevision', 'intentId', 'profileId']);
  assert.match(f.$('#next-local-profile-status').textContent, /MiniCPM is the Local default/); assert.equal(f.calls.model, 0); assert.equal(f.state.changed, 1);
});

test('unavailable profile adds no unfinished product workflow', async t => {
  const f = await uiFixture(t, {qualified:false}); assert.equal(f.$('#next-local-profile').hidden, true);
  await f.click('#next-local-profile-setup'); assert.equal(f.requests.filter(item => item.method === 'POST').length, 0);
  assert.doesNotMatch(f.$('#next-local-profile').textContent, /qualif/i);
});

test('Local settings retain interrupted-stage uncertainty beside confirmed partial effects', async t => {
  const f = await uiFixture(t, {profileReceipt:{intentId:'fixture-interrupted', status:'interrupted', outcomeUncertain:true,
    assets:[{id:'model', status:'verified'}]}});
  const text = f.$('#next-local-profile-status').textContent;
  assert.match(text, /interrupted/); assert.match(text, /last stage may have completed/); assert.match(text, /One model asset is verified/);
  assert.equal(f.requests.filter(item => item.method === 'POST').length, 0);
});

test('an uncertain setup response preserves retry guidance and retries the same saved intent', async t => {
  const f = await uiFixture(t, {loseProfileResponse:true});
  await f.click('#next-local-profile-setup');
  assert.match(f.$('#next-local-profile-status').textContent, /still running/);
  assert.match(f.$('#next-local-profile-status').textContent, /Retry this setup to check the same saved intent/);
  await f.click('#next-local-profile-setup');
  const posts = f.requests.filter(item => item.method === 'POST'); assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].value, posts[1].value); assert.equal(f.calls.model, 0);
});

test('Local setup is a navigation action, never a selectable model or a current-chat mutation', async t => {
  const dom = planningDOM(t), select = dom.element('select'), option = dom.element('option'); select.id = 'profile-picker'; option.setAttribute('value', 'gpt-6-luna'); option.textContent = 'Luna'; select.append(option); select.value = 'gpt-6-luna'; dom.mount.append(select);
  const navigations = [], activations = [], changes = []; select.addEventListener('change', () => changes.push(select.value));
  const picker = createGroupedModelPicker({select, onSetupProvider:id => navigations.push(id), onBeforeSelect:value => activations.push(value)}); t.after(() => picker.destroy());
  const state = {providers:[], subscriptionProviders:[], models:[], runtimeSettings:{hiddenModelProviders:[]}, localModelProfile:{available:true, offerSetup:true, providerId:'local_llamacpp'}};
  const update = value => picker.update({models:[{id:'gpt-6-luna', label:'Luna', available:true}], status:value, selected:'gpt-6-luna'}); update(state);
  await dom.$('.next-model-picker-trigger').dispatch('click', {}, true);
  let row = dom.document.querySelector('[data-model-setup-provider="local"]'); assert.ok(row); assert.equal(row.hasAttribute('data-model-value'), false);
  await row.dispatch('click', {}, true); assert.deepEqual(navigations, ['local']); assert.deepEqual(activations, []); assert.deepEqual(changes, []); assert.equal(select.value, 'gpt-6-luna');
  update({...state, runtimeSettings:{hiddenModelProviders:['local_llamacpp']}}); await dom.$('.next-model-picker-trigger').dispatch('click', {}, true);
  assert.equal(dom.document.querySelector('[data-model-setup-provider="local"]'), null);
  update({...state, localModelProfile:{...state.localModelProfile, available:false}}); assert.equal(dom.document.querySelector('[data-model-setup-provider="local"]'), null);
});

test('existing settings navigation focuses Local while preserving account and API drafts', async t => {
  const dom = planningDOM(t), requests = [];
  const panel = createSubscriptionModelSettings({mount:dom.mount, api:async (route, method = 'GET') => {
    requests.push({route, method});
    if (route === '/api/status') return {codex:{connected:true, authenticated:true}, models:[], subscriptionProviders:[]};
    if (route === '/api/local-models') return {engines:[{id:'ollama', available:true, models:[{id:'existing'}]}], localModelProfile:{available:false}};
    throw Error('Unexpected fixture route: ' + route);
  }}, ({mount}) => { const input = dom.element('input'); input.id = 'preserved-api-draft'; input.value = 'keep this draft'; mount.append(input); return {enter() {}, leave() {}, destroy() {}}; });
  t.after(() => panel.destroy()); panel.enter(); await settle(); panel.focusProvider('local'); await settle();
  assert.equal(dom.$('#next-models-panel-local').hidden, false); assert.equal(dom.$('#next-models-panel-accounts').hidden, true);
  assert.equal(dom.$('#preserved-api-draft').value, 'keep this draft'); assert.equal(requests.some(item => item.method !== 'GET'), false);
});
