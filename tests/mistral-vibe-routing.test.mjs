import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
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

test('native provider ID cannot be newly claimed by an API preset and legacy saved API identity is retained',async t=>{
  assert.throws(()=>normalizeProvider({id:'mistral-vibe',preset:'mistral'}),/reserved/);
  const legacy=normalizeProvider({id:'legacy-fixture',type:'compatible',name:'Legacy API',baseUrl:'http://127.0.0.1:1234/v1',requiresApiKey:false,models:['legacy-model']});
  legacy.id='mistral-vibe';
  const {runtime,vibe}=await fixture(t,{beforeInit:dir=>writeFile(path.join(dir,'providers.json'),JSON.stringify({version:1,defaultModel:'mistral-vibe::legacy-model',providers:[legacy]}))});
  assert.equal(runtime.status().providers[0].name,'Legacy API');
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
  assert.equal(vibe.calls.length,0);
});


test('retired Mistral account cannot be selected or resumed even with an installed adapter',async t=>{
  const {runtime,vibe,codexCalls}=await fixture(t);
  const id='mistral-vibe::actual-cli-alias';
  assert.equal(runtime.status().subscriptionProviders.some(p=>p.id==='mistral-vibe'),false);
  assert.equal(runtime.resolveModel(id).code,'SUBSCRIPTION_PROVIDER_RETIRED');
  await assert.rejects(runtime.runAgent({model:id,prompt:'hello'}),/retired/);
  await assert.rejects(runtime.runAgent({threadId:'vibe_old',prompt:'hello'}),/retired/);
  const choices=chatOptionChoices(runtime.status(),{model:id});
  assert.equal(choices.models.find(m=>m.id===id).disabled,true);
  assert.deepEqual(vibe.calls,[]);
  assert.deepEqual(codexCalls,[]);
});
test('historical Vibe model is readable after retirement without changing its saved JSON',async t=>{
  const {runtime,dataDir}=await fixture(t);
  const id='vibe_12345678-1234-1234-1234-123456789abc';
  const dir=path.join(dataDir,'mistral-vibe','threads',id);
  await mkdir(dir,{recursive:true});
  const saved=JSON.stringify({version:1,id,model:'mistral-vibe::old',nativeSessionId:'old-session'});
  await writeFile(path.join(dir,'thread.json'),saved);
  assert.equal(await runtime.savedThreadModel(id),'mistral-vibe::old');
  assert.equal(await readFile(path.join(dir,'thread.json'),'utf8'),saved);
});
