import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { normalizeProvider } from '../lib/provider-store.mjs';
import { chatOptionChoices, validateChatOptions } from '../public/next/chat/options-model.mjs';

class FakeVibe extends EventEmitter {
  constructor() {
    super(); this.calls=[]; this.saved=new Map();
    this.info={installed:true,connected:true,authenticated:true,available:true,cliVersion:'fixture',defaultModel:'actual-cli-alias',models:[{id:'actual-cli-alias',displayName:'Actual CLI model',supportsTools:true}],activeTurns:0,loginState:'idle'};
  }
  async init(){return this;}
  status(){return structuredClone(this.info);}
  async refresh(options){this.calls.push({kind:'refresh',options});this.emit('status');return this.status();}
  async beginLogin(){this.calls.push({kind:'login'});return {state:'waiting',url:'https://console.mistral.ai/fixture-sign-in'};}
  ownsThreadId(id){return typeof id==='string'&&id.startsWith('vibe_');}
  async savedThreadModel(id){return this.saved.get(id);}
  async runAgent(options){this.calls.push({kind:'run',options});const threadId=options.threadId||'vibe_fixture';const model='mistral-vibe::'+options.model;this.saved.set(threadId,model);options.onEvent?.({type:'thread',threadId,model,providerId:'mistral-vibe'});return {threadId,turnId:'vibe_turn',model,text:'fixture reply'};}
  async steerAgent(threadId,text){this.calls.push({kind:'steer',threadId,text});return {accepted:true,threadId};}
  async compactThread(threadId){this.calls.push({kind:'compact',threadId});return {compacted:false,threadId,reason:'Native session manages its context.'};}
  async close(){this.calls.push({kind:'close'});}
}
async function fixture(t,{vibe=new FakeVibe(),beforeInit}={}){
  const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-vibe-routing-'));
  const codexCalls=[];
  const codex={status:()=>({connected:true,authenticated:true,defaultModel:'native-original',models:[{id:'native-original',displayName:'Original Codex'}],activeTurns:0}),async start(){codexCalls.push('start');},async runAgent(){codexCalls.push('run');assert.fail('A Vibe request must never reach Codex.');},async close(){codexCalls.push('close');}};
  if(beforeInit)await beforeInit(dataDir);
  const runtime=await new ProviderRuntime({codex,mistralVibe:vibe,dataDir,fetchImpl:async()=>{assert.fail('Native Vibe must not call an API preset.');},modelLimitResolver:{enrich:async(_config,models)=>models}}).init();
  t.after(async()=>{await runtime.close().catch(()=>{});await rm(dataDir,{recursive:true,force:true});});
  return {runtime,vibe,codex,codexCalls,dataDir};
}

test('Vibe appears separately from optional APIs with only CLI-reported exact model choices',async t=>{
  const {runtime,vibe}=await fixture(t);
  await runtime.store.setDefaultModel('native-original');
  const status=runtime.status(),id='mistral-vibe::actual-cli-alias';
  assert.equal(status.defaultModel,'native-original');
  assert.equal(status.providers.length,0);
  assert.deepEqual(status.subscriptionProviders.map(p=>p.id),['mistral-vibe']);
  assert.equal(status.models.filter(m=>m.providerId==='mistral-vibe').length,1);
  const model=status.models.find(m=>m.id===id);
  assert.equal(model.providerName,'Mistral Vibe Code');assert.equal(model.providerType,'subscription-cli');assert.equal(model.available,true);
  assert.equal(model.displayName,'Actual CLI model');
  assert.equal(chatOptionChoices(status,{model:id}).selected.model,id);
  assert.doesNotThrow(()=>validateChatOptions(status,{model:id,effort:'default'}));
  await runtime.refreshMistralVibe({cwd:process.cwd()});
  assert.equal(runtime.store.defaultModel,'native-original');
  assert.equal(vibe.calls.filter(c=>c.kind==='refresh').length,1);
});

test('explicit Vibe selection reaches the native adapter with exact alias and preserves qualified attribution',async t=>{
  const {runtime,vibe,codexCalls}=await fixture(t);const events=[];
  const result=await runtime.runAgent({model:'mistral-vibe::actual-cli-alias',cwd:process.cwd(),prompt:'fixture',onEvent:e=>events.push(e)});
  assert.equal(vibe.calls.find(c=>c.kind==='run').options.model,'actual-cli-alias');
  assert.equal(result.model,'mistral-vibe::actual-cli-alias');
  assert.equal(events[0].model,result.model);
  assert.equal(await runtime.savedThreadModel(result.threadId),result.model);
  assert.deepEqual(codexCalls,[]);
});

test('saved Vibe threads retain their provider and model after the app default changes',async t=>{
  const {runtime,vibe,codexCalls}=await fixture(t);
  vibe.saved.set('vibe_saved','mistral-vibe::actual-cli-alias');
  await runtime.setDefaultModel('native-original');
  const result=await runtime.runAgent({threadId:'vibe_saved',model:'default',cwd:process.cwd(),prompt:'continue'});
  assert.equal(result.model,'mistral-vibe::actual-cli-alias');
  assert.equal(vibe.calls.find(c=>c.kind==='run').options.threadId,'vibe_saved');
  await assert.rejects(runtime.runAgent({threadId:'vibe_saved',model:'native-original',cwd:process.cwd(),prompt:'wrong provider'}),{code:'THREAD_MISMATCH'});
  await assert.rejects(runtime.runAgent({threadId:'vibe_saved',model:'mistral-vibe::guessed-model',cwd:process.cwd(),prompt:'wrong model'}),{code:'THREAD_MISMATCH'});
  await assert.rejects(runtime.runAgent({threadId:'vibe_missing',cwd:process.cwd(),prompt:'missing saved mapping'}),{code:'THREAD_MISMATCH'});
  assert.deepEqual(codexCalls,[]);
});

test('missing authentication and removed catalog models remain actionable and never fall back to another provider',async t=>{
  const {runtime,vibe,codexCalls}=await fixture(t);
  assert.equal(runtime.resolveModel('mistral-vibe::invented-model').available,false);
  await assert.rejects(runtime.setDefaultModel('mistral-vibe::invented-model'),{code:'INVALID_DEFAULT_MODEL'});
  vibe.info.authenticated=false;vibe.info.available=false;vibe.info.lastError='Sign in to Mistral Vibe Code.';
  assert.equal(runtime.status().models.find(m=>m.providerId==='mistral-vibe').available,false);
  await assert.rejects(runtime.runAgent({model:'mistral-vibe::actual-cli-alias',cwd:process.cwd(),prompt:'fixture'}),/Sign in/);
  assert.equal(vibe.calls.some(c=>c.kind==='run'),false);assert.deepEqual(codexCalls,[]);
});

test('Vibe steering, compaction, startup, and shutdown stay on the native Vibe runtime',async t=>{
  const {runtime,vibe,codexCalls}=await fixture(t);
  await runtime.setDefaultModel('mistral-vibe::actual-cli-alias');
  await runtime.start();
  await runtime.steerAgent('vibe_active','next direction');
  await runtime.compactThread('vibe_saved',{});
  assert.equal(vibe.calls.filter(c=>c.kind==='refresh').length,1);
  assert.equal(vibe.calls.filter(c=>c.kind==='steer').length,1);
  assert.equal(vibe.calls.filter(c=>c.kind==='compact').length,1);
  assert.deepEqual(codexCalls,[]);
  await runtime.close();
  assert.equal(vibe.calls.filter(c=>c.kind==='close').length,1);
});

test('native provider ID cannot be newly claimed by an API preset and legacy saved API identity is retained',async t=>{
  assert.throws(()=>normalizeProvider({id:'mistral-vibe',preset:'mistral'}),/reserved/);
  const legacy=normalizeProvider({id:'legacy-fixture',type:'compatible',name:'Legacy API',baseUrl:'http://127.0.0.1:1234/v1',requiresApiKey:false,models:['legacy-model']});
  legacy.id='mistral-vibe';
  const {runtime,vibe}=await fixture(t,{beforeInit:dir=>writeFile(path.join(dir,'providers.json'),JSON.stringify({version:1,defaultModel:'mistral-vibe::legacy-model',providers:[legacy]}))});
  assert.equal(runtime.status().providers[0].name,'Legacy API');
  assert.equal(runtime.mistralVibeStatus().available,false);
  assert.deepEqual(runtime.mistralVibeStatus().models,[]);
  assert.equal(runtime.resolveModel('mistral-vibe::legacy-model').available,true);
  const requests=[];
  runtime.fetchImpl=async(url,options)=>{
    requests.push({url:String(url),method:options?.method||'GET'});
    return new Response(JSON.stringify({data:[{id:'legacy-model',context_length:32768},{id:'legacy-new-model'}]}),{status:200,headers:{'content-type':'application/json'}});
  };
  const catalog=await runtime.discoverModels('mistral-vibe',{refresh:true});
  assert.deepEqual(catalog.models.map(model=>model.id),['legacy-model','legacy-new-model']);
  assert.equal(catalog.models.find(model=>model.id==='legacy-model').contextWindowTokens,32768);
  assert.deepEqual(requests,[{url:'http://127.0.0.1:1234/v1/models',method:'GET'}]);
  assert.equal(runtime.store.defaultModel,'mistral-vibe::legacy-model');
  assert.deepEqual(runtime.store.get('mistral-vibe').models.map(model=>model.id),['legacy-model']);
  assert.equal(runtime.resolveModel('mistral-vibe::legacy-model').available,true);
  await assert.rejects(runtime.refreshMistralVibe(),{code:'NATIVE_PROVIDER_ID_CONFLICT'});
  assert.equal(vibe.calls.length,0);
});

test('a synchronous Codex shutdown failure still waits for and closes Vibe',async t=>{
  const {runtime,vibe,codex}=await fixture(t);
  let complete;let closed=false;
  codex.close=()=>{throw Error('fixture shutdown failure');};
  vibe.close=()=>new Promise(resolve=>{complete=()=>{closed=true;resolve();};});
  const closing=runtime.close();let settled=false;closing.catch(()=>{settled=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof complete,'function');assert.equal(settled,false);
  complete();await assert.rejects(closing,/fixture shutdown failure/);assert.equal(closed,true);
});
