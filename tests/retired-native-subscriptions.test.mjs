import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProviderRuntime} from '../lib/providers.mjs';
import {connectionDefaultModels} from '../public/connection-models.mjs';

const oldIds=['antigravity','qwen_code'];
const fixture=async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-retired-native-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return dir;
};
function codexMock(){
  const codex=new EventEmitter();
  let launched=0;
  codex.status=()=>({
    connected:true,authenticated:true,defaultModel:'gpt-6.1-sol',
    models:[{id:'gpt-6.1-sol',model:'gpt-6.1-sol',displayName:'GPT-6.1 Sol'}]
  });
  codex.start=async()=>{};
  codex.close=async()=>{};
  codex.runAgent=async()=>{launched++;return {output:'Codex only'}};
  return {codex,launchCount:()=>launched};
}
test('Codex is the only active native subscription; old provider choices disappear',async t=>{
  const dir=await fixture(t),{codex}=codexMock();
  const runtime=await new ProviderRuntime({codex,dataDir:dir}).init();
  await runtime.setDefaultModel('codex');
  const state=runtime.status();
  assert.equal(state.subscriptionFocus,false);
  assert.deepEqual(state.subscriptionProviders,[]);
  assert.equal(state.defaultModelSelection,'codex');
  assert.equal(state.codex.connected,true);
  assert.equal(state.codex.authenticated,true);
  for(const model of state.models||[])assert.ok(!oldIds.includes(model.providerId));
  const choices=connectionDefaultModels(state);
  assert.ok(choices.some(x=>x.value==='codex'));
  assert.ok(choices.some(x=>x.value==='gpt-6.1-sol'));
  assert.ok(!choices.some(x=>oldIds.some(id=>x.value?.startsWith(id+'::'))));
  await runtime.close();
});

test('a saved default from a retired subscription migrates new chats to Codex without changing thread history',async t=>{
  const dir=await fixture(t),{codex}=codexMock();
  const earlier='qwen_code::qwen3-coder-plus';
  await writeFile(path.join(dir,'providers.json'),JSON.stringify({
    version:1,providers:[],defaultModel:earlier,automaticDefaultModel:null,customCodexModels:[]
  }));
  const runtime=await new ProviderRuntime({codex,dataDir:dir}).init();
  assert.equal(runtime.store.defaultModel,'codex');
  assert.deepEqual(runtime.retiredNativeDefaultMigration,{from:earlier,to:'codex'});
  assert.equal(JSON.parse(await readFile(path.join(dir,'providers.json'),'utf8')).defaultModel,'codex');
  assert.equal(runtime.status().defaultModelSelection,'codex');
  await runtime.close();
});

test('retired native models cannot be set as default or launched even by an explicit caller',async t=>{
  const dir=await fixture(t),{codex,launchCount}=codexMock();
  const runtime=await new ProviderRuntime({codex,dataDir:dir}).init();
  for(const id of oldIds){
    const selection=id+'::'+(id==='antigravity'?'gemini-3.8-flash-high':'qwen3-coder-plus');
    const resolved=runtime.resolveModel(selection);
    assert.equal(resolved.available,false);
    assert.equal(resolved.providerId,id);
    assert.match(resolved.error,/retired/i);
    assert.equal(resolved.code,'SUBSCRIPTION_PROVIDER_RETIRED');
    await assert.rejects(runtime.setDefaultModel(selection),{code:'SUBSCRIPTION_PROVIDER_RETIRED'});
    await assert.rejects(runtime.runAgent({model:selection,cwd:dir,prompt:'Do not run'}),{code:'PROVIDER_UNAVAILABLE'});
  }
  assert.equal(launchCount(),0);
  await runtime.close();
});

test('retired provider chat history retains exact provider/model and is never silently resumed under Codex',async t=>{
  const dir=await fixture(t),{codex,launchCount}=codexMock();
  const runtime=await new ProviderRuntime({codex,dataDir:dir}).init();
  const id='provider_'+randomUUID();
  const record={version:1,id,providerId:'antigravity',providerType:'subscription-cli',
    model:'gemini-3.8-flash-low',cwd:dir,cliSessionId:'original-native-session',
    messages:[{role:'user',content:'Original question'},{role:'assistant',content:'Original answer'}],
    createdAt:'2026-10-31T16:00:00.000Z'};
  await runtime.persistThread(record);
  assert.equal(await runtime.savedThreadModel(id),'antigravity::gemini-3.8-flash-low');
  await assert.rejects(runtime.runAgent({threadId:id,cwd:dir,prompt:'Continue'}),{code:'PROVIDER_UNAVAILABLE'});
  const preserved=await runtime.readThread(id);
  assert.equal(preserved.providerId,'antigravity');
  assert.equal(preserved.model,'gemini-3.8-flash-low');
  assert.equal(preserved.cliSessionId,'original-native-session');
  assert.deepEqual(preserved.messages,record.messages);
  assert.equal(launchCount(),0);
  await runtime.close();
});

test('retired model is a disabled historical selection, not a new-model menu choice',()=>{
  const retired='antigravity::gemini-3.8-flash-high';
  const options=connectionDefaultModels({
    defaultModelSelection:retired,
    subscriptionFocus:false,
    codex:{connected:true,authenticated:true},
    models:[{id:'gpt-6.1-sol',displayName:'GPT-6.1 Sol',available:true},
      {id:retired,displayName:'Previous provider',available:true}]
  });
  const old=options.find(o=>o.value===retired);
  assert.equal(old.disabled,true);
  assert.match(old.label,/unavailable/i);
  assert.ok(options.some(o=>o.value==='gpt-6.1-sol'));
});

test('the app no longer instantiates native subscription CLI code or exposes model-discovery endpoints',async()=>{
  const server=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
  const runtime=await readFile(new URL('../lib/providers.mjs',import.meta.url),'utf8');
  const settings=await readFile(new URL('../public/next/workspaces/settings-subscriptions.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(server,/new SubscriptionCliRuntime|import\s*\{\s*SubscriptionCliRuntime/);
  assert.match(server,/\/api\/subscriptions\/models/);
  assert.match(server,/410,\{error:/);
  assert.doesNotMatch(runtime,/\.subscriptionCli|runSubscriptionAgent|SUBSCRIPTION_CLI_MODELS/);
  assert.match(runtime,/RETIRED_NATIVE_PROVIDERS/);
  assert.doesNotMatch(settings,/\/api\/subscriptions\/models/);
  assert.match(settings,/Codex subscription/);
});
