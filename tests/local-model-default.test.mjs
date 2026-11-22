import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ProviderStore} from '../lib/provider-store.mjs';
import {ProviderRuntime} from '../lib/providers.mjs';
import {localModelHTTP} from '../lib/local-model-http.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';
import {chatOptionChoices, validateChatOptions} from '../public/next/chat/options-model.mjs';
import {createGroupedModelPicker} from '../public/next/core/model-picker.mjs';
import {createLocalModelSettings} from '../public/next/workspaces/settings-local-models.mjs';

const providerId='local_llamacpp',a=providerId+'::model-a',b=providerId+'::model-b',luna='gpt-6-luna';
const localConfig=(extra={})=>({id:providerId,preset:'llamacpp',name:'Local llama.cpp',type:'compatible',baseUrl:'http://127.0.0.1:8080/v1',models:['model-a','model-b'],...extra});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const until=async read=>{for(let i=0;i<100;i++){if(read())return;await settle();}throw Error('Local default fixture did not settle.');};
const reject=(operation,code,status)=>assert.rejects(async()=>await operation(),{code,status});
async function storeFixture(t,{automatic=false,cleanup=true}={}){
  const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-local-default-'));
  if(cleanup)t.after(async()=>{assert.match(path.basename(dataDir),/^blackice-local-default-/);await rm(dataDir,{recursive:true,force:true});});
  const store=new ProviderStore({dataDir});await store.init();await store.save(localConfig());
  if(automatic)await store.pinAutomaticDefault(luna);else await store.setDefaultModel(luna);
  return{dataDir,store};
}
const defaults=store=>({defaultModel:store.defaultModel,automaticDefaultModel:store.automaticDefaultModel});

test('legacy preference reads null; local selection and explicit clear persist without changing either global default',async t=>{
  for(const automatic of [false,true])await t.test(automatic?'automatic Luna':'explicit Luna',async t=>{
    const {store,dataDir}=await storeFixture(t,{automatic}),raw=JSON.parse(await readFile(store.file,'utf8'));delete raw.localDefaultModel;
    await writeFile(store.file,JSON.stringify(raw));const restored=new ProviderStore({dataDir});await restored.init();const before=defaults(restored);
    assert.deepEqual(restored.localDefaultModelStatus(),{model:null,eligible:false,reason:null});
    await restored.setLocalDefaultModel(a,{expectedLocalDefaultModel:null});assert.deepEqual(defaults(restored),before);
    const reloaded=new ProviderStore({dataDir});await reloaded.init();assert.deepEqual(reloaded.localDefaultModelStatus(),{model:a,eligible:true,reason:null});assert.deepEqual(defaults(reloaded),before);
    await reloaded.setLocalDefaultModel(null,{expectedLocalDefaultModel:a});
    const cleared=new ProviderStore({dataDir});await cleared.init();assert.equal(cleared.localDefaultModel,null);assert.deepEqual(defaults(cleared),before);
  });
});
test('local preference requires a concrete route and an explicit valid expected value',async t=>{
  const {store}=await storeFixture(t),before=await readFile(store.file,'utf8');
  for(const value of ['local','default','codex',luna,undefined,{},'bad provider::x'])
    await reject(()=>store.setLocalDefaultModel(value,{expectedLocalDefaultModel:null}),'LOCAL_DEFAULT_ARGUMENTS',400);
  for(const options of [undefined,{},null,{expectedLocalDefaultModel:undefined},{expectedLocalDefaultModel:'default'}])
    await reject(()=>store.setLocalDefaultModel(a,options),'LOCAL_DEFAULT_ARGUMENTS',400);
  assert.equal(await readFile(store.file,'utf8'),before);assert.equal(store.localDefaultModel,null);
});
test('serialized local CAS permits one winner and can recover after a conflict',async t=>{
  const {store}=await storeFixture(t),before=defaults(store);
  const results=await Promise.allSettled([store.setLocalDefaultModel(a,{expectedLocalDefaultModel:null}),store.setLocalDefaultModel(b,{expectedLocalDefaultModel:null})]);
  assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.equal(results[1].reason.code,'LOCAL_DEFAULT_CONFLICT');assert.equal(results[1].reason.status,409);
  assert.equal(store.localDefaultModel,a);assert.equal(JSON.parse(await readFile(store.file,'utf8')).localDefaultModel,a);
  await store.setLocalDefaultModel(b,{expectedLocalDefaultModel:a});assert.equal(store.localDefaultModel,b);assert.deepEqual(defaults(store),before);
});
test('target eligibility is checked after earlier queued provider changes',async t=>{
  const {store}=await storeFixture(t);
  const results=await Promise.allSettled([store.save({id:providerId,enabled:false}),store.setLocalDefaultModel(a,{expectedLocalDefaultModel:null})]);
  assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.equal(results[1].reason.code,'LOCAL_DEFAULT_DISABLED');assert.equal(store.localDefaultModel,null);
});
test('only exact managed routes qualify, including a registered suffixed provider ID',async t=>{
  const {store}=await storeFixture(t);
  await reject(()=>store.setLocalDefaultModel(providerId+'::missing',{expectedLocalDefaultModel:null}),'LOCAL_DEFAULT_NOT_REGISTERED',404);
  const invalid=[
    localConfig({id:'other_port',baseUrl:'http://127.0.0.1:9090/v1'}),
    localConfig({id:'other_host',baseUrl:'http://localhost:8080/v1'}),
    localConfig({id:'remote_model',baseUrl:'https://example.invalid/v1'}),
    localConfig({id:'custom_preset',preset:'compatible'}),
    localConfig({id:'custom_path',endpoints:{chatCompletions:'/custom/chat'}}),
    localConfig({id:'other_protocol',preset:'openai',type:'openai'}),
  ];
  for(const provider of invalid){await store.save(provider);await reject(()=>store.setLocalDefaultModel(provider.id+'::model-a',{expectedLocalDefaultModel:null}),'LOCAL_DEFAULT_UNSUPPORTED',400);}
  await store.save(localConfig({id:'local_llamacpp_2'}));await store.setLocalDefaultModel('local_llamacpp_2::model-a',{expectedLocalDefaultModel:null});
  assert.equal(store.localDefaultModelStatus().eligible,true);assert.equal(defaults(store).defaultModel,luna);
});
test('removed, disabled and reconfigured targets retain an explicit unavailable preference',async t=>{
  const {store,dataDir}=await storeFixture(t);await store.setLocalDefaultModel(a,{expectedLocalDefaultModel:null});
  await store.save({id:providerId,enabled:false});assert.equal(store.localDefaultModelStatus().model,a);assert.equal(store.localDefaultModelStatus().eligible,false);assert.match(store.localDefaultModelStatus().reason,/disabled/);
  await store.save({id:providerId,enabled:true,baseUrl:'http://127.0.0.1:9090/v1'});assert.equal(store.localDefaultModelStatus().eligible,false);
  await store.save({id:providerId,baseUrl:'http://127.0.0.1:8080/v1',models:['model-b']});
  const reloaded=new ProviderStore({dataDir});await reloaded.init();assert.equal(reloaded.localDefaultModel,a);assert.equal(reloaded.localDefaultModelStatus().eligible,false);assert.match(reloaded.localDefaultModelStatus().reason,/no longer registered/);
  assert.equal(reloaded.defaultModel,luna);await reloaded.setLocalDefaultModel(null,{expectedLocalDefaultModel:a});assert.equal(reloaded.localDefaultModel,null);
});
test('persistence failure leaves the prior local preference, file and global choices intact',async t=>{
  const {store}=await storeFixture(t);await store.setLocalDefaultModel(a,{expectedLocalDefaultModel:null});
  const previous=await readFile(store.file,'utf8'),global=defaults(store),persist=store.persist.bind(store);
  store.persist=async()=>{throw Error('fixture disk failure');};
  await assert.rejects(store.setLocalDefaultModel(b,{expectedLocalDefaultModel:a}),/fixture disk failure/);
  assert.equal(store.localDefaultModel,a);assert.deepEqual(defaults(store),global);assert.equal(await readFile(store.file,'utf8'),previous);
  store.persist=persist;await store.setLocalDefaultModel(b,{expectedLocalDefaultModel:a});assert.equal(store.localDefaultModel,b);
});

class FakeCodex extends EventEmitter {
  status(){return{connected:true,authenticated:true,defaultModel:luna,models:[{id:luna,model:luna,displayName:'Luna',supportedReasoningEfforts:[]}],activeTurns:0};}
  async start(){assert.fail('Changing a local preference must not start Codex');}
  async runAgent(){assert.fail('Changing a local preference must not start a model');}
  async close(){}
}
test('runtime and local HTTP expose registration honestly without model, discovery or default-provider work',async t=>{
  const {dataDir}=await storeFixture(t),runtime=await new ProviderRuntime({dataDir,codex:new FakeCodex(),fetchImpl:async()=>assert.fail('No network discovery expected')}).init();t.after(()=>runtime.close());
  const global=runtime.defaultModelStatus(),before=runtime.resolveModel('default'),events=[];runtime.on('status',state=>events.push(state));
  const manager={list:async()=>({engines:[{id:'llamacpp',available:false,models:[]}]}),load:()=>assert.fail('No load'),configureLlama:()=>assert.fail('No launch settings')};
  const endpoint={manager,runtime,pathname:'/api/local-models/default',method:'POST',value:{model:a,expectedLocalDefaultModel:null}};
  assert.equal((await localModelHTTP({...endpoint,remote:true})).status,403);assert.equal(runtime.localDefaultModelStatus().model,null);
  assert.equal((await localModelHTTP({...endpoint,value:{...endpoint.value,force:true}})).status,400);
  const result=await localModelHTTP(endpoint);assert.equal(result.status,200);assert.deepEqual(result.body.localDefaultModelStatus,{model:a,eligible:true,reason:null});
  assert.deepEqual(runtime.defaultModelStatus(),global);assert.deepEqual(runtime.resolveModel('default'),before);assert.equal(events.at(-1).localDefaultModelStatus.model,a);
  const catalog=await localModelHTTP({manager,runtime,pathname:'/api/local-models',method:'GET'});
  assert.equal(catalog.body.engines[0].available,false);assert.equal(catalog.body.localDefaultModelStatus.eligible,true,'Eligibility does not claim a loaded runtime or existing weights');
  assert.deepEqual(catalog.body.localDefaultChoices.map(item=>item.id),[a,b]);
  assert.equal((await localModelHTTP(endpoint)).status,409);assert.equal(runtime.localDefaultModelStatus().model,a);
});
test('served local-default route enforces its local session, validates CAS and publishes status',async t=>{
  const {store,dataDir}=await storeFixture(t,{cleanup:false}),{createHarnessServer}=await import('../server.mjs');
  class Runtime extends EventEmitter {
    listProviders(){return store.list();}
    localDefaultModelStatus(){return store.localDefaultModelStatus();}
    localDefaultModelChoices(){return store.localDefaultModelChoices();}
    async setLocalDefaultModel(value,options){await store.setLocalDefaultModel(value,options);return this.localDefaultModelStatus();}
    status(){return{connected:true,defaultModel:luna,localDefaultModelStatus:this.localDefaultModelStatus(),providers:this.listProviders(),models:[]};}
    async runAgent(){assert.fail('No agent expected');}async start(){return this.status();}async close(){}
  }
  const manager={init:async()=>{},close:async()=>{},list:async()=>({engines:[]}),load:()=>assert.fail('No local load')};
  let app;t.after(async()=>{await app?.close();await rm(dataDir,{recursive:true,force:true});});
  app=await createHarnessServer({runtime:new Runtime(),localModels:manager,dataDir,defaultCwd:dataDir,port:0});
  const base=await app.listen(),home=await fetch(base),origin=new URL(base).origin,cookie=home.headers.get('set-cookie').split(';')[0];await home.text();
  const send=(extra={},body={model:a,expectedLocalDefaultModel:null})=>fetch(origin+'/api/local-models/default',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
  const remote=await send({'x-blackice-remote':'1'});assert.equal(remote.status,403);await remote.text();assert.equal(store.localDefaultModel,null);
  const success=await send(),saved=await success.json();assert.equal(success.status,200,JSON.stringify(saved));assert.equal(saved.localDefaultModelStatus.model,a);
  const conflict=await send();assert.equal(conflict.status,409);await conflict.text();assert.equal(store.defaultModel,luna);
  const status=await fetch(origin+'/api/status',{headers:{Cookie:cookie}});assert.equal((await status.json()).localDefaultModelStatus.model,a);
});

const pickerStatus=()=>({defaultModel:luna,defaultModelSelection:luna,defaultModelAvailable:true,localDefaultModelStatus:{model:a,eligible:true,reason:null},runtimeSettings:{hiddenModelProviders:[]},
  providers:[{...localConfig(),models:[{id:'model-a'},{id:'model-b'}]}],models:[{id:luna,model:luna,providerId:'codex',displayName:'Luna',available:true,supportedReasoningEfforts:[]},
    ...[a,b].map(id=>({id,model:id,providerId,providerType:'compatible',displayName:id.split('::')[1],available:true,supportsTools:false,inputModalities:['text'],supportedReasoningEfforts:[]}))]});
function pickerFixture(t,{status=pickerStatus(),selected=luna,onBeforeSelect,onOpenAvailability,onRemoveModel}={}){
  const dom=planningDOM(t),select=dom.element('select');select.id='local-default-picker';dom.mount.append(select);const changes=[];
  select.dispatchEvent=event=>{void select.dispatch(event.type,{target:select},true);return true;};select.addEventListener('change',()=>changes.push(select.value));
  const picker=createGroupedModelPicker({select,onBeforeSelect,onOpenAvailability,onRemoveModel});t.after(()=>picker.destroy());
  function update(next=status){status=next;const current=select.value||selected,choices=chatOptionChoices(status,{model:current}).models;select.replaceChildren();for(const choice of choices){const option=dom.element('option');option.setAttribute('value',choice.id);option.textContent=choice.label;option.disabled=choice.disabled;select.append(option);}select.value=current;picker.update({models:choices,status,selected:current});}
  select.value=selected;update();
  const panel=()=>dom.document.querySelector('#local-default-picker-picker');
  return{...dom,select,picker,changes,update,panel,rows:()=>panel().querySelectorAll('[data-model-value]'),async open(){await dom.$('.next-model-picker-trigger').dispatch('click',{},true);}};
}
test('Local is one concrete choice and still uses activation and removal callbacks with original capabilities',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;}),activated=[],removed=[];
  const f=pickerFixture(t,{onBeforeSelect:async model=>{activated.push(model);await gate;},onRemoveModel:async target=>removed.push(target)});await f.open();
  const local=f.rows().find(row=>row.dataset.modelValue===a);assert.ok(local);assert.match(local.textContent,/Local · model-a/);assert.equal(f.rows().filter(row=>row.dataset.modelValue===a).length,1);
  assert.equal(f.rows().some(row=>row.dataset.modelValue==='local'),false);await local.dispatch('click',{},true);
  assert.equal(f.select.value,luna);assert.equal(activated[0].id,a);assert.equal(activated[0].supportsTools,false);assert.deepEqual(activated[0].inputModalities,['text']);
  release();await until(()=>f.select.value===a);assert.deepEqual(f.changes,[a]);await f.open();
  await f.panel().querySelector('[data-model-remove="'+a+'"]').dispatch('click',{},true);assert.deepEqual(removed,[{providerId,model:'model-a'}]);
  assert.throws(()=>validateChatOptions(pickerStatus(),{model:a,serviceTier:'fast'}),/Fast|tier|available/);
});
test('hidden or missing-file Local choices cannot bypass ordinary visibility and availability',async t=>{
  await t.test('hidden provider',async t=>{
    const state=pickerStatus();state.runtimeSettings.hiddenModelProviders=[providerId];const hidden=pickerFixture(t,{status:state,selected:a});await hidden.open();
    assert.equal(hidden.rows().some(row=>row.dataset.modelValue===a),false);assert.equal(hidden.select.value,a);assert.deepEqual(hidden.changes,[]);
  });
  await t.test('missing file',async t=>{
    let activation=0;const missing=pickerFixture(t,{onBeforeSelect:async()=>{activation++;},onOpenAvailability:async()=>({[a]:'Saved GGUF is missing'})});await missing.open();
    await until(()=>missing.rows().find(row=>row.dataset.modelValue===a)?.disabled===true);await missing.rows().find(row=>row.dataset.modelValue===a).dispatch('click',{},true);
    assert.equal(missing.select.value,luna);assert.equal(activation,0);
  });
});
test('changing the local preference never reroutes a selected current or historical model',async t=>{
  const state=pickerStatus(),f=pickerFixture(t,{status:state,selected:a});
  const changed={...state,localDefaultModelStatus:{model:b,eligible:true,reason:null}};f.update(changed);await f.open();
  assert.equal(f.select.value,a);assert.deepEqual(f.changes,[]);assert.equal(chatOptionChoices(changed,{model:a}).selected.model,a);
  assert.equal(validateChatOptions(changed,{model:a}).model,a);assert.equal(changed.defaultModel,luna);
  const removed={...changed,models:changed.models.filter(model=>model.id!==a),providers:[{...state.providers[0],models:['model-b'].map(id=>({id}))}]};
  f.update(removed);assert.equal(f.select.value,a);assert.deepEqual(f.changes,[]);assert.equal(chatOptionChoices(removed,{model:a}).models.find(model=>model.id===a).disabled,true);
});

async function settingsFixture(t){
  const {store}=await storeFixture(t),dom=planningDOM(t),calls=[],state={changed:0,missing:false};
  const runtime={localDefaultModelStatus:()=>store.localDefaultModelStatus(),localDefaultModelChoices:()=>store.localDefaultModelChoices(),setLocalDefaultModel:async(value,options)=>{await store.setLocalDefaultModel(value,options);return store.localDefaultModelStatus();}};
  const manager={list:async()=>({engines:[{id:'ollama',available:true,models:[{id:'unrelated-engine',loaded:false}]},{id:'llamacpp',available:false,models:[{id:'model-b',loaded:false},...(state.missing?[]:[{id:'model-a',loaded:false}])]}]}),load:()=>assert.fail('No model load'),configureLlama:()=>assert.fail('No launch configuration')};
  const api=async(route,method='GET',value)=>{calls.push({route,method,value});const result=await localModelHTTP({manager,runtime,pathname:route,method,value});if(!result)throw Error('Unexpected '+route);if(result.status>=400)throw Object.assign(new Error(result.body.error),{status:result.status,code:result.body.code});return result.body;};
  const panel=createLocalModelSettings({mount:dom.mount,api,onChanged:()=>{state.changed++;},storage:{getItem:()=>null,setItem:()=>assert.fail('Local default must not change the runtime panel preference')}});t.after(()=>panel.destroy());
  return{...dom,store,state,calls,panel,writes:()=>calls.filter(call=>call.method==='POST'),async enter(){panel.enter();await until(()=>!dom.$('#next-local-default-choice').disabled);}};
}
test('settings save and clear only the local preference with exact CAS and no load',async t=>{
  const f=await settingsFixture(t);await f.enter();assert.equal(f.calls.length,1);assert.deepEqual(f.writes(),[]);assert.equal(f.$('#next-local-engine').value,'ollama');
  const choice=f.$('#next-local-default-choice');choice.value=b;await choice.dispatch('change');await f.$('#next-local-default-set').dispatch('click');
  assert.equal(f.store.localDefaultModel,b);assert.equal(f.store.defaultModel,luna);assert.equal(f.$('#next-local-engine').value,'ollama');assert.equal(f.state.changed,1);
  assert.deepEqual(f.writes(),[{route:'/api/local-models/default',method:'POST',value:{model:b,expectedLocalDefaultModel:null}}]);
  await f.$('#next-local-default-clear').dispatch('click');assert.equal(f.store.localDefaultModel,null);assert.equal(f.store.defaultModel,luna);assert.deepEqual(f.writes().at(-1).value,{model:null,expectedLocalDefaultModel:b});
});
test('settings surface a CAS conflict and refresh without silently retrying another selection',async t=>{
  const f=await settingsFixture(t);await f.enter();const choice=f.$('#next-local-default-choice');choice.value=b;await choice.dispatch('change');
  await f.store.setLocalDefaultModel(a,{expectedLocalDefaultModel:null});await f.$('#next-local-default-set').dispatch('click');
  assert.equal(f.store.localDefaultModel,a);assert.equal(f.writes().length,1);assert.equal(f.writes()[0].value.expectedLocalDefaultModel,null);assert.match(f.$('#next-local-feedback').textContent,/changed|Refresh/);
  assert.match(f.$('#next-local-default-status').textContent,/model-a/);assert.equal(f.$('#next-local-default-choice').value,b);
});
test('settings retain a missing or removed local default honestly and allow explicit clearing',async t=>{
  const f=await settingsFixture(t);await f.store.setLocalDefaultModel(a,{expectedLocalDefaultModel:null});f.state.missing=true;await f.enter();
  assert.match(f.$('#next-local-default-status').textContent,/not in the local catalog/);assert.equal(f.$('#next-local-default-set').disabled,true);assert.equal(f.$('#next-local-default-clear').disabled,false);assert.deepEqual(f.writes(),[]);
  await f.store.save({id:providerId,models:['model-b']});await f.$('#next-local-refresh').dispatch('click');await until(()=>f.$('#next-local-default-status').textContent.includes('no longer registered'));
  await f.$('#next-local-default-clear').dispatch('click');assert.equal(f.store.localDefaultModel,null);assert.equal(f.store.defaultModel,luna);
});
