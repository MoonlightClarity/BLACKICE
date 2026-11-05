import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ProviderRuntime} from '../lib/providers.mjs';
import {normalizeProvider} from '../lib/provider-store.mjs';
import {getProviderPreset,providerRequiresApiKey} from '../public/provider-catalog.mjs';
import {providerCredentialsReady,readyDisabledProvider,enableProviderForModel} from '../public/provider-availability.mjs';
import {connectionDefaultModels} from '../public/connection-models.mjs';
import {chatOptionChoices,validateChatOptions} from '../public/next/chat/options-model.mjs';

async function fixture(t){
  const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-provider-activation-'));let requests=0;
  const codex={status:()=>({connected:false,authenticated:false,models:[],activeTurns:0}),async close(){},async runAgent(){assert.fail('Enabling must not start Codex.');}};
  const runtime=await new ProviderRuntime({codex,dataDir,modelLimitResolver:{enrich:async(_config,models)=>models},fetchImpl:async()=>{requests++;throw Error('Activation must not contact an API.');}}).init();
  t.after(async()=>{await runtime.close();await rm(dataDir,{recursive:true,force:true});});
  return{runtime,requests:()=>requests};
}

test('explicit API activation restores exact saved models with Codex offline and preserves credentials and defaults',async t=>{
  const {runtime,requests}=await fixture(t);
  const saved=await runtime.store.save({id:'optional_router',preset:'openrouter',apiKey:'fixture-only-secret',enabled:false,models:[{id:'vendor/exact:free',displayName:'Saved model'}]});
  await runtime.store.setDefaultModel('native-pinned-model');
  runtime.automaticInitializationAttempted=true;
  runtime.ensureAutomaticDefault=async()=>{assert.fail('An enable action must not initialize or replace the default.');};
  const before=runtime.status(),id='optional_router::vendor/exact:free';
  assert.equal(before.providers.find(provider=>provider.id===saved.id).credentialsReady,true);assert.equal(before.providers.find(provider=>provider.id===saved.id).configured,false);
  assert.equal(before.models.find(model=>model.id===id).available,false);
  assert.ok(readyDisabledProvider(before,id));
  assert.ok(connectionDefaultModels(before).some(model=>model.value===id&&model.disabled));
  assert.equal(chatOptionChoices(before,{model:id}).selected.model,id);
  const enabled=await runtime.enableProvider(saved.id,{expectedUpdatedAt:saved.updatedAt});
  assert.equal(enabled.enabled,true);assert.equal(enabled.configured,true);
  assert.equal(runtime.store.key(saved.id),'fixture-only-secret');
  assert.equal(runtime.store.defaultModel,'native-pinned-model');
  const after=runtime.status();assert.equal(after.models.find(model=>model.id===id).available,true);
  assert.equal(runtime.resolveModel(id).model,'vendor/exact:free');assert.equal(runtime.resolveModel(id).available,true);
  assert.doesNotThrow(()=>validateChatOptions(after,{model:id,effort:'default'}));assert.equal(requests(),0);
  await assert.rejects(runtime.enableProvider(saved.id,{expectedUpdatedAt:saved.updatedAt}),{code:'PROVIDER_CHANGED'});
  assert.equal(runtime.store.defaultModel,'native-pinned-model');assert.equal(requests(),0);
});

test('API setup remains optional for keyless providers while missing credentials have an actionable reason',async t=>{
  const {runtime,requests}=await fixture(t);
  const missing=await runtime.store.save({id:'missing_mistral',preset:'mistral',enabled:false,models:['mistral-small-latest']});
  const before=await readFile(runtime.store.file,'utf8'),state=runtime.status(),id='missing_mistral::mistral-small-latest';
  assert.equal(state.providers.find(provider=>provider.id===missing.id).credentialsReady,false);assert.equal(readyDisabledProvider(state,id),null);
  assert.throws(()=>validateChatOptions(state,{model:id}),/credentials.*Settings/);
  await assert.rejects(runtime.enableProvider(missing.id,{expectedUpdatedAt:missing.updatedAt}),{code:'PROVIDER_CREDENTIALS_REQUIRED'});
  assert.equal(await readFile(runtime.store.file,'utf8'),before);
  for(const preset of ['ollama','compatible']){
    const provider=await runtime.store.save({id:'keyless_'+preset,preset,baseUrl:'http://127.0.0.1:1234/v1',enabled:false,models:['local-exact']});
    assert.equal(provider.hasApiKey,false);assert.equal(provider.credentialsReady,true);
    await runtime.enableProvider(provider.id,{expectedUpdatedAt:provider.updatedAt});
    assert.equal(runtime.resolveModel(provider.id+'::local-exact').available,true);
  }
  assert.equal(runtime.store.defaultModel,null);assert.equal(requests(),0);
});

test('Mistral is a configurable compatible preset without a bundled key or inferred model selection',()=>{
  const preset=getProviderPreset('mistral'),provider=normalizeProvider({id:'mistral_fixture',preset:'mistral'});
  assert.equal(preset.baseUrl,'https://api.mistral.ai/v1');assert.equal(provider.type,'compatible');
  assert.equal(providerRequiresApiKey(provider),true);assert.deepEqual(provider.models,[]);
  assert.equal(Object.hasOwn(preset,'apiKey'),false);assert.equal(Object.hasOwn(preset,'models'),false);
});

test('credential readiness distinguishes authorization headers from arbitrary saved headers',()=>{
  assert.equal(providerCredentialsReady({requiresApiKey:true,hasHeaders:true,headerNames:['X-Project']}),false);
  assert.equal(providerCredentialsReady({requiresApiKey:true,headerNames:['Authorization']}),true);
  assert.equal(providerCredentialsReady({requiresApiKey:false}),true);
  assert.equal(providerCredentialsReady({credentialsReady:false,hasApiKey:true}),false,'Current server readiness overrides stale legacy hints.');
});

test('model activation sends only an optimistic enable request and requires fresh availability for that exact model',async()=>{
  const provider={id:'optional_router',enabled:false,credentialsReady:true,updatedAt:'2026-10-01T00:00:00.000Z',models:[{id:'vendor/exact:free'}]};
  const id=provider.id+'::vendor/exact:free',status={providers:[provider],models:[{id,available:false}]},before=structuredClone(status),calls=[];
  assert.equal(readyDisabledProvider(status,'optional_router::not-saved'),null);assert.equal(readyDisabledProvider(status,'codex-model'),null);
  const fresh={providers:[{...provider,enabled:true}],models:[{id,available:true}],defaultModel:'native-pinned'};
  const api=async(route,method='GET',body)=>{calls.push({route,method,body});return route==='/api/status'?fresh:fresh.providers[0];};
  assert.equal(await enableProviderForModel(api,status,id),fresh);
  assert.deepEqual(calls,[{route:'/api/providers/optional_router/enable',method:'POST',body:{expectedUpdatedAt:provider.updatedAt}},{route:'/api/status',method:'GET',body:undefined}]);
  assert.deepEqual(status,before);
  await assert.rejects(enableProviderForModel(async route=>route==='/api/status'?{models:[]}:fresh.providers[0],status,id),/still unavailable/);
  await assert.rejects(enableProviderForModel(api,status,'optional_router::not-saved'),/Refresh.*set up/);
  assert.equal(calls.length,2,'Missing models must not issue any write.');
});
