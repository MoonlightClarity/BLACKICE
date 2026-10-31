import test from 'node:test';
import assert from 'node:assert/strict';
import {createProviderSettings} from '../public/next/workspaces/settings-providers.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function until(read){for(let i=0;i<100;i++){if(read())return;await settle();}throw Error('Provider settings did not settle.');}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const provider=(id='gateway',extra={})=>({id,name:'Saved gateway',preset:'compatible',type:'compatible',baseUrl:'https://gateway.example/v1',enabled:true,maxTokens:8192,maxSteps:null,
  configured:true,requiresApiKey:false,hasApiKey:true,hasHeaders:true,headerNames:['X-Gateway-Key'],secretStorage:'encrypted',updatedAt:'2026-10-25T10:00:00Z',
  models:[{id:'saved-model',displayName:'Saved model',contextWindowTokens:128000,contextWindowSource:'provider-reported',supportsTools:true,maxOutputTokens:16000,maxOutputTokensSource:'provider-reported',contextWindowObservedAt:'2026-10-25T09:00:00Z',maxOutputObservedAt:'2026-10-25T09:00:00Z',inputModalities:['text'],outputModalities:['text']}],...extra});
async function fixture(t,{providers=[provider(),provider('second',{name:'Second gateway'})],runtimeSettings={hiddenModelProviders:[]},hook}={}){
  const dom=planningDOM(t),prototype=Object.getPrototypeOf(dom.mount),type=Object.getOwnPropertyDescriptor(prototype,'type');
  Object.defineProperty(prototype,'type',{get:type.get,set(value){this.setAttribute('type',value);}});
  prototype.replaceChildren=function(...children){for(const child of this.children)child.parentElement=null;this.children=[];this.rawText='';this.markup='';this.append(...children);};
  const storage={getItem(){throw Error('Credentials must not use browser storage');},setItem(){throw Error('Credentials must not use browser storage');}};
  window.localStorage=storage;window.sessionStorage=storage;
  const calls=[],notices=[],state={providers:structuredClone(providers),runtimeSettings:structuredClone(runtimeSettings),customModels:[],codex:{connected:true,authenticated:true,models:[{id:'native-model',model:'native-model',displayName:'Native model',source:'advertised',access:{state:'unverified'}}],customModels:[],modelCheck:null,modelCheckBlocked:false}},subscribers=new Set();let changed=0;
  const api=async(route,method='GET',body,options)=>{
    const call={route,method,body:structuredClone(body),options};calls.push(call);
    if(hook){const result=await hook(call,state);if(result!==undefined)return result;}
    if(route==='/api/runtime/settings'&&method==='GET')return structuredClone(state.runtimeSettings);
    if(route==='/api/runtime/settings'&&method==='POST'){state.runtimeSettings={...state.runtimeSettings,...body};return structuredClone(state.runtimeSettings);}
    if(route==='/api/providers'&&method==='GET')return structuredClone(state.providers);
    if(route==='/api/providers'&&method==='POST'){
      const previous=state.providers.find(item=>item.id===body.id),{apiKey,headers,expectedUpdatedAt,...value}=body;
      if(Object.hasOwn(body,'expectedUpdatedAt')&&(previous?.updatedAt??null)!==expectedUpdatedAt)throw Object.assign(Error('Provider changed before saving.'),{code:'PROVIDER_CHANGED',status:409});
      const saved={...previous,...value,hasApiKey:apiKey===undefined?previous?.hasApiKey||false:Boolean(apiKey),hasHeaders:headers===undefined?previous?.hasHeaders||false:Object.keys(headers).length>0,
        headerNames:headers===undefined?previous?.headerNames||[]:Object.keys(headers),requiresApiKey:body.preset==='openrouter'||body.type!=='compatible',configured:body.enabled,updatedAt:'2026-10-25T11:00:00Z'};
      state.providers=state.providers.filter(item=>item.id!==saved.id);state.providers.push(saved);return structuredClone(saved);
    }
    if(/^\/api\/providers\/[^/]+$/.test(route)&&method==='DELETE'){state.providers=state.providers.filter(item=>item.id!==route.split('/').at(-1));return {removed:true};}
    if(route.endsWith('/models')&&route.startsWith('/api/providers/'))return {models:[{id:'catalog-model',displayName:'Catalog model',contextWindowTokens:256000,contextWindowSource:'provider-reported',supportsTools:false}],offset:body.offset,total:1,hasMore:false};
    if(route.endsWith('/test'))return {ok:true,credentialVerified:true,modelAccessVerified:false};
    if(route==='/api/codex/models'||route==='/api/codex/models?refresh=true'){
      if(method==='POST')state.customModels.push(body.model);
      if(method==='DELETE')state.customModels=state.customModels.filter(id=>id!==body.model);
      state.codex.customModels=[...state.customModels];state.codex.models=state.codex.models.filter(item=>item.source!=='custom');
      state.codex.models.push(...state.customModels.map(id=>({id,model:id,source:'custom',displayName:id,access:{state:'unverified'}})));return structuredClone(state.codex);
    }
    if(route==='/api/codex/models/check'){
      state.codex.modelCheck={model:body.model,status:'accepted',scope:'current-connection',checkedAt:'2026-10-25T12:00:00Z'};
      return {...structuredClone(state.codex),result:structuredClone(state.codex.modelCheck)};
    }
    throw Error('Unexpected provider API '+method+' '+route);
  };
  const panel=createProviderSettings({mount:dom.mount,api,events:{subscribe(handler){subscribers.add(handler);return()=>subscribers.delete(handler);}},notify:value=>notices.push(value),onChanged:()=>{changed++;},getRuntimeSettings:()=>state.runtimeSettings,onRuntimeSettings:value=>{state.runtimeSettings=structuredClone(value);}});
  t.after(()=>panel.destroy());panel.enter();await until(()=>dom.$('[data-provider-id]')||state.providers.length===0&&!dom.$('#next-provider-refresh').disabled);
  return {...dom,panel,calls,state,notices,subscribers,get changed(){return changed;},writes:()=>calls.filter(call=>call.method!=='GET'&&!/^\/api\/providers\/[^/]+\/models$/.test(call.route)),
    async open(id='gateway'){await dom.click(`[data-provider-id="${id}"]`);await settle();},
    async idle(){await until(()=>!dom.$('#next-provider-new').disabled);},
    emit(type='runtime.status',data){for(const handler of subscribers)handler({type,...(data?{data}:{} )});}};
}

test('provider list is bounded, searchable and distinguishes configured from enabled; entry reads never save',async t=>{
  const providers=Array.from({length:85},(_,i)=>provider('api_'+i,{name:'Gateway '+i,...(i===0?{enabled:false,configured:false}:i===1?{configured:false}:{} )}));
  const f=await fixture(t,{providers});assert.equal(f.$('#next-provider-list').querySelectorAll('[data-provider-id]').length,40);
  assert.match(f.$('[data-provider-id="api_0"]').textContent,/Disabled/);assert.match(f.$('[data-provider-id="api_1"]').textContent,/Enabled · needs credentials/);
  assert.match(f.$('[data-provider-id="api_2"]').textContent,/Enabled · configured/);
  await f.click('#next-provider-more');assert.equal(f.$('#next-provider-list').querySelectorAll('[data-provider-id]').length,80);
  await f.input('#next-provider-filter','Gateway 84');assert.equal(f.$('#next-provider-list').querySelectorAll('[data-provider-id]').length,1);
  await f.open('api_84');assert.equal(f.$('#next-provider-name').value,'Gateway 84');assert.equal(f.writes().length,0);
  const submit=await f.$('#next-provider-form').dispatch('submit');assert.equal(submit.defaultPrevented,true);
  const key=await f.$('#next-provider-name').dispatch('keydown',{key:'Enter'},true);assert.equal(key.defaultPrevented,true);assert.equal(f.writes().length,0);
});

test('drafts and unsaved credentials survive selection, events, refresh and leaving Settings without storage',async t=>{
  const f=await fixture(t);await f.open();const input=f.$('#next-provider-name');
  await f.input('#next-provider-name','My draft');await f.input('#next-provider-key','unsaved-private-key');await f.input('#next-provider-headers','X-Secret: unsaved-private-header');
  f.emit();await settle();assert.equal(f.writes().length,0);assert.equal(f.$('#next-provider-name'),input);
  await f.open('second');await f.open();assert.equal(f.$('#next-provider-name').value,'My draft');
  assert.equal(f.subscribers.size,1);f.panel.leave();assert.equal(f.subscribers.size,0);const count=f.calls.length;f.emit();await settle();assert.equal(f.calls.length,count,'Hidden events do not read APIs.');
  f.panel.enter();assert.equal(f.subscribers.size,1);f.panel.enter();assert.equal(f.subscribers.size,1);await until(()=>!f.$('#next-provider-refresh').disabled);
  assert.equal(f.$('#next-provider-key').value,'unsaved-private-key');assert.equal(f.$('#next-provider-headers').value,'X-Secret: unsaved-private-header');
  f.state.providers[0].name='External saved name';await f.click('#next-provider-refresh');await until(()=>!f.$('#next-provider-refresh').disabled);
  assert.equal(f.$('#next-provider-name').value,'My draft');assert.equal(f.$('#next-provider-stale').hidden,false);
  await f.click('#next-provider-discard');assert.equal(f.$('#next-provider-name').value,'External saved name');assert.equal(f.$('#next-provider-key').value,'');
});

test('Save preserves blank credentials and all selected model metadata; clear operations are explicit',async t=>{
  const f=await fixture(t);await f.open();await f.input('#next-provider-name','Renamed');await f.click('#next-provider-save');await f.idle();
  let value=f.writes()[0].body;assert.equal(Object.hasOwn(value,'apiKey'),false);assert.equal(Object.hasOwn(value,'headers'),false);
  assert.deepEqual(value.models,provider().models);assert.equal(value.maxSteps,null);assert.equal(f.changed,1);
  f.$('#next-provider-clear-key').checked=true;await f.$('#next-provider-clear-key').dispatch('change');f.$('#next-provider-clear-headers').checked=true;await f.$('#next-provider-clear-headers').dispatch('change');
  await f.click('#next-provider-save');await f.idle();value=f.writes()[1].body;assert.equal(value.apiKey,'');assert.deepEqual(value.headers,{});
  assert.equal(f.$('#next-provider-clear-key').checked,false);assert.equal(f.$('#next-provider-clear-headers').checked,false);assert.equal(f.state.providers.find(item=>item.id==='gateway').hasHeaders,false);
});

test('new preset/protocol/manual-model/limits edits save once and retain provider-reported capacity',async t=>{
  const f=await fixture(t);await f.click('#next-provider-new');f.$('#next-provider-preset').value='ollama';await f.$('#next-provider-preset').dispatch('change');
  assert.equal(f.$('#next-provider-base-url').value,'http://127.0.0.1:11434/v1');assert.equal(f.$('#next-provider-name').value,'Ollama');
  await f.input('#next-provider-id','local_api');await f.input('#next-provider-manual-model','local-model');await f.click('#next-provider-add-model');
  await f.input('#next-provider-max-tokens','4096');await f.input('#next-provider-max-steps','17');await f.click('#next-provider-save');await f.idle();
  const value=f.writes()[0].body;assert.equal(value.id,'local_api');assert.equal(value.type,'compatible');assert.equal(value.maxSteps,17);assert.equal(value.maxTokens,4096);assert.deepEqual(value.models,[{id:'local-model',displayName:'local-model'}]);
  assert.equal(f.$('#next-provider-id').disabled,true);assert.equal(f.$('#next-provider-catalog-load').disabled,false);
});

test('failed Save preserves private form values, redacts echoed secrets and makes no automatic retry',async t=>{
  const f=await fixture(t,{hook:call=>{if(call.route==='/api/providers'&&call.method==='POST')throw Error('Rejected private-test-key and private-header-value');}});await f.open();
  await f.input('#next-provider-key','private-test-key');await f.input('#next-provider-headers','X-Secret: private-header-value');await f.click('#next-provider-save');await f.idle();
  assert.equal(f.writes().length,1);assert.equal(f.$('#next-provider-key').value,'private-test-key');assert.equal(f.$('#next-provider-headers').value,'X-Secret: private-header-value');
  assert.equal(f.$('#next-provider-error').textContent.includes('private-test-key'),false);assert.equal(f.$('#next-provider-error').textContent.includes('private-header-value'),false);
  assert.match(f.$('#next-provider-error').textContent,/\[redacted\]/);f.panel.leave();f.panel.enter();await settle();assert.equal(f.writes().length,1);assert.match(f.$('#next-provider-error').textContent,/\[redacted\]/);
});

test('save serialization survives navigation and stale pre-save list results cannot overwrite saved state',async t=>{
  const save=deferred(),read=deferred();let holdRead=false;
  const f=await fixture(t,{hook:(call)=>{if(call.route==='/api/providers'&&call.method==='POST')return save.promise;if(call.route==='/api/providers'&&call.method==='GET'&&holdRead)return read.promise;}});
  await f.open();await f.input('#next-provider-name','Saved late');holdRead=true;await f.click('#next-provider-refresh');
  await f.click('#next-provider-save');await f.click('#next-provider-save');f.panel.leave();f.panel.enter();await f.click('#next-provider-delete');
  assert.equal(f.writes().length,1);save.resolve(provider('gateway',{name:'Saved late',updatedAt:'2026-10-25T13:00:00Z'}));await f.idle();
  read.resolve([provider('gateway',{name:'Stale response'})]);await settle();await settle();assert.equal(f.$('#next-provider-name').value,'Saved late');
  assert.match(f.$('[data-provider-id="gateway"]').textContent,/Saved late/);assert.equal(f.changed,1);
});

test('catalog opens automatically and is paged, selected IDs and metadata survive page/search changes',async t=>{
  const f=await fixture(t,{hook:call=>{if(call.route.endsWith('/models')&&call.route.startsWith('/api/providers/'))return {models:[{id:call.body.query?'searched-model':call.body.offset?'next-model':'first-model',displayName:'Discovered',contextWindowTokens:256000,contextWindowSource:'provider-reported',supportsTools:true}],offset:call.body.offset,total:161,hasMore:call.body.offset===0};}});await f.open();
  assert.equal(f.writes().length,0);await until(()=>!f.$('#next-provider-catalog-load').disabled);
  let box=f.$('[data-provider-model-id="first-model"]');box.checked=true;await box.dispatch('change');
  await f.click('#next-provider-catalog-next');await until(()=>f.$('[data-provider-model-id="next-model"]'));
  await f.input('#next-provider-catalog-search','searched');assert.equal(f.calls.filter(call=>call.route.endsWith('/models')).length,2);
  await f.click('#next-provider-catalog-load');await until(()=>f.$('[data-provider-model-id="searched-model"]'));
  assert.equal(f.$('[data-provider-model-id="first-model"]').checked,true);assert.equal(f.$('[data-provider-model-id="saved-model"]').checked,true);
  await f.click('#next-provider-save');await f.idle();const saved=f.calls.find(call=>call.route==='/api/providers'&&call.method==='POST').body.models;
  assert.equal(saved.length,2);assert.equal(saved.find(item=>item.id==='first-model').contextWindowSource,'provider-reported');
  const defaults={sort:'name',freeOnly:false,toolsOnly:false,visionOnly:false,minContextTokens:0};
  assert.deepEqual(f.calls.filter(call=>call.route.startsWith('/api/providers/')&&call.route.endsWith('/models')).map(call=>call.body),[{...defaults,query:'',offset:0,limit:80},{...defaults,query:'',offset:80,limit:80},{...defaults,query:'searched',offset:0,limit:80}]);
});

test('late catalog results cannot alter another connection or a newer search; unsaved settings never trigger implicit save',async t=>{
  const catalog=deferred();const f=await fixture(t,{hook:call=>{if(call.route==='/api/providers/gateway/models')return catalog.promise;}});await f.open();
  await f.click('#next-provider-catalog-load');await f.open('second');catalog.resolve({models:[{id:'wrong-provider-model'}],total:1,offset:0});await settle();await settle();
  assert.equal(f.$('[data-provider-model-id="wrong-provider-model"]'),null);await f.input('#next-provider-key','draft-only');
  assert.equal(f.$('#next-provider-catalog-load').disabled,true);await f.click('#next-provider-catalog-load');assert.equal(f.calls.filter(call=>call.route==='/api/providers/second/models').length,1,'Only the automatic read on opening the saved connection occurred.');
  assert.equal(f.calls.filter(call=>call.route==='/api/providers'&&call.method==='POST').length,0);
});

test('late catalog pages are discarded after a query or connection edit, and visible catalog pages are capped',async t=>{
  const oldPage=deferred();let hold=true;
  const f=await fixture(t,{hook:call=>{if(call.route==='/api/providers/gateway/models')return hold?oldPage.promise:{models:Array.from({length:500},(_,i)=>({id:'bounded_'+i})),total:500,offset:0,hasMore:true};}});await f.open();
  await f.click('#next-provider-catalog-load');await f.input('#next-provider-catalog-search','new search');
  oldPage.resolve({models:[{id:'old-query-model'}],total:1,offset:0});await settle();await settle();assert.equal(f.$('[data-provider-model-id="old-query-model"]'),null);
  assert.doesNotMatch(f.$('#next-provider-receipt').textContent,/Loading/);hold=false;await f.click('#next-provider-catalog-load');await until(()=>!f.$('#next-provider-catalog-load').disabled);
  assert.equal(f.$('#next-provider-catalog').querySelectorAll('input').length,80);assert.equal(f.$('#next-provider-models').querySelectorAll('input').length,1);
});

test('invalid limits, conflicting secret replacement/clear and malformed headers retain the draft without writing',async t=>{
  const f=await fixture(t);await f.open();await f.input('#next-provider-max-steps','1.5');await f.click('#next-provider-save');assert.equal(f.writes().length,0);assert.match(f.$('#next-provider-error').textContent,/positive whole number/);
  await f.input('#next-provider-max-steps','');await f.input('#next-provider-key','new-key');f.$('#next-provider-clear-key').checked=true;await f.$('#next-provider-clear-key').dispatch('change');
  await f.click('#next-provider-save');assert.equal(f.writes().length,0);assert.match(f.$('#next-provider-error').textContent,/not both/);
  f.$('#next-provider-clear-key').checked=false;await f.$('#next-provider-clear-key').dispatch('change');await f.input('#next-provider-headers','Invalid header line');await f.click('#next-provider-save');
  assert.equal(f.writes().length,0);assert.equal(f.$('#next-provider-key').value,'new-key');assert.match(f.$('#next-provider-error').textContent,/Header line 1/);
});

test('Test uses saved settings once and distinguishes credentials from untested model access',async t=>{
  const f=await fixture(t);await f.open();await f.click('#next-provider-test');await f.idle();assert.equal(f.writes().length,1);
  assert.equal(f.writes()[0].route,'/api/providers/gateway/test');assert.match(f.$('#next-provider-receipt').textContent,/API key verified/);assert.match(f.$('#next-provider-receipt').textContent,/Model access was not tested/);
  await f.input('#next-provider-name','Unsaved name');assert.equal(f.$('#next-provider-test').disabled,true);await f.click('#next-provider-test');assert.equal(f.writes().length,1);
});

test('catalog-only Test never claims an API key or a model was verified; removal is explicit',async t=>{
  const f=await fixture(t,{hook:call=>{if(call.route.endsWith('/test'))return {ok:true,credentialVerified:false,modelAccessVerified:false};}});await f.open();await f.click('#next-provider-test');await f.idle();
  assert.match(f.$('#next-provider-receipt').textContent,/API key and model access were not verified/);await f.click('#next-provider-delete');await f.idle();
  assert.equal(f.state.providers.length,1);assert.equal(f.$('[data-provider-id="gateway"]'),null);assert.equal(f.$('#next-provider-form').hidden,true);assert.equal(f.changed,1);
});

test('Codex IDs and checks are explicit, bounded, serialized and report one observed request',async t=>{
  const f=await fixture(t);assert.equal(f.calls.some(call=>call.route.startsWith('/api/codex/')),false);
  await f.click('#next-provider-codex-read');await until(()=>!f.$('#next-provider-codex-read').disabled);
  await f.input('#next-provider-codex-id','exact-native-id');await f.$('#next-provider-codex-id').dispatch('keydown',{key:'Enter'});assert.equal(f.writes().length,0);
  await f.click('#next-provider-codex-add');await f.idle();assert.equal(f.$('#next-provider-codex-id').value,'');assert.deepEqual(f.state.customModels,['exact-native-id']);
  await f.input('#next-provider-codex-id','exact-native-id');await f.click('#next-provider-codex-check');await f.idle();assert.match(f.$('#next-provider-codex-status').textContent,/Request completed/);assert.match(f.$('#next-provider-codex-status').textContent,/Future requests can have a different result/);
  const check=f.calls.find(call=>call.route==='/api/codex/models/check');assert.deepEqual(check.body,{model:'exact-native-id'});assert.equal(check.options.deadlineMs,50000);
  await f.click('[data-codex-remove="exact-native-id"]');await f.idle();assert.deepEqual(f.state.customModels,[]);assert.equal(f.changed,4,'Refreshing native limits also refreshes the shared model choices.');
});

test('native refresh explicitly requests fresh metadata, keeps the prior result on failure and never checks a model',async t=>{
  let fail=false;const f=await fixture(t,{hook:(call,state)=>{
    if(call.route==='/api/codex/models?refresh=true'&&call.method==='GET'){
      if(fail)throw Error('Native metadata refresh failed');
      return {...structuredClone(state.codex),modelCatalog:{refreshedAt:'2026-10-30T16:00:00Z'},models:[
        ...state.codex.models,{id:'newly-advertised-hidden',model:'newly-advertised-hidden',source:'advertised',hidden:true,
          contextWindowTokens:196000,contextWindowSource:'runtime-reported'}]};
    }
  }});
  assert.equal(f.calls.some(call=>call.route.startsWith('/api/codex/')),false,'Entering Settings never forces native refresh.');
  await f.click('#next-provider-codex-read');await until(()=>!f.$('#next-provider-codex-read').disabled);
  const calls=()=>f.calls.filter(call=>call.route.startsWith('/api/codex/'));
  assert.equal(calls().length,1);assert.equal(calls()[0].route,'/api/codex/models?refresh=true');assert.equal(calls()[0].method,'GET');
  assert.equal(calls()[0].body,undefined);assert.ok(calls()[0].options.signal);
  const list=f.$('#next-provider-codex-list');assert.match(list.textContent,/newly-advertised-hidden/);assert.match(list.textContent,/Hidden by Codex/);assert.match(list.textContent,/196,000/);
  fail=true;await f.click('#next-provider-codex-read');await until(()=>!f.$('#next-provider-codex-read').disabled);
  assert.match(list.textContent,/newly-advertised-hidden/);assert.match(f.$('#next-provider-codex-error').textContent,/Native metadata refresh failed/);
  assert.match(f.$('#next-provider-codex-status').textContent,/Previous results are kept.*retry/);
  await settle();await settle();assert.equal(calls().length,2,'A failed refresh has no automatic retry.');assert.equal(f.changed,1);
  assert.equal(f.writes().length,0,'A metadata refresh never saves settings, adds a model ID, or tests model access.');
});

test('uncertain Codex checks require a status read and hidden late status reads are discarded',async t=>{
  let fail=true,hold=false;const read=deferred();const f=await fixture(t,{hook:call=>{if(call.route==='/api/codex/models/check'&&fail){fail=false;throw Error('Request timed out');}if(call.route==='/api/codex/models?refresh=true'&&call.method==='GET'&&hold)return read.promise;}});
  await f.click('#next-provider-codex-read');await until(()=>!f.$('#next-provider-codex-read').disabled);await f.input('#next-provider-codex-id','native-model');
  await f.click('#next-provider-codex-check');await f.idle();assert.equal(f.$('#next-provider-codex-check').disabled,true);
  await f.click('#next-provider-codex-check');assert.equal(f.calls.filter(call=>call.route==='/api/codex/models/check').length,1);
  hold=true;await f.click('#next-provider-codex-read');f.panel.leave();read.resolve({...f.state.codex,models:[{id:'hidden-late-model'}]});await settle();f.panel.enter();await settle();
  assert.equal(f.$('#next-provider-codex-list').textContent.includes('hidden-late-model'),false);
  hold=false;await f.click('#next-provider-codex-read');await until(()=>!f.$('#next-provider-codex-read').disabled);assert.equal(f.$('#next-provider-codex-check').disabled,false);
});

test('custom endpoint paths are visible, preserved on save, editable, and explicitly cleared without testing a model',async t=>{
  const endpoints={models:'/catalog',chatCompletions:'/generate'};
  const f=await fixture(t,{providers:[provider('gateway',{endpoints}),provider('second')]});await f.open();
  assert.match(f.$('[data-provider-id="gateway"]').textContent,/Models: \/catalog.*Chat Completions: \/generate/);
  assert.equal(f.$('#next-provider-models-path').value,'/catalog');assert.equal(f.$('#next-provider-chat-path').value,'/generate');assert.equal(f.writes().length,0);
  await f.input('#next-provider-name','Custom endpoint connection');await f.click('#next-provider-save');await f.idle();
  assert.deepEqual(f.writes()[0].body.endpoints,endpoints);assert.equal(Object.hasOwn(f.writes()[0].body,'apiKey'),false);
  await f.input('#next-provider-models-path','/inventory');assert.equal(f.$('#next-provider-catalog-load').disabled,true);
  await f.open('second');await f.open();assert.equal(f.$('#next-provider-models-path').value,'/inventory');
  await f.input('#next-provider-chat-path','');await f.click('#next-provider-save');await f.idle();assert.deepEqual(f.writes()[1].body.endpoints,{models:'/inventory'});
  await f.input('#next-provider-models-path','');await f.click('#next-provider-save');await f.idle();assert.deepEqual(f.writes()[2].body.endpoints,{});
  assert.doesNotMatch(f.$('[data-provider-id="gateway"]').textContent,/Models:|Chat Completions:/);
  assert.ok(f.writes().every(call=>call.route==='/api/providers'),'Editing paths never invokes model checks or connection tests.');
});

test('endpoint paths reject a different origin and chat overrides are unavailable for other protocols',async t=>{
  const f=await fixture(t,{providers:[provider('gateway',{endpoints:{models:'/catalog',chatCompletions:'/generate'}})]});await f.open();
  for(const invalid of ['https://other.example/generate','//other.example/generate','/generate?key=secret','/generate#part','/bad path','/bad\\path']){
    await f.input('#next-provider-chat-path',invalid);await f.click('#next-provider-save');assert.equal(f.writes().length,0);assert.match(f.$('#next-provider-error').textContent,/Endpoint paths/);
  }
  await f.input('#next-provider-chat-path','/generate');f.$('#next-provider-protocol').value='openai';await f.$('#next-provider-protocol').dispatch('change');
  assert.equal(f.$('#next-provider-chat-path').disabled,true);assert.equal(f.$('#next-provider-models-path').disabled,false);
  await f.click('#next-provider-save');await f.idle();assert.deepEqual(f.writes()[0].body.endpoints,{models:'/catalog'});
  f.$('#next-provider-preset').value='openrouter';await f.$('#next-provider-preset').dispatch('change');assert.equal(f.$('#next-provider-models-path').value,'');assert.equal(f.$('#next-provider-chat-path').value,'');
  assert.equal(f.writes().length,1);
});


test('every saved and newly entered model displays distinct context and output limits without a guessed capacity',async t=>{
  const f=await fixture(t);await f.open();
  const saved=f.$('#next-provider-models').textContent;
  assert.match(saved,/Context window: 128,000 tokens · Provider reported/);
  assert.match(saved,/Max output: 16,000 tokens · Provider reported/);
  assert.match(f.$('#next-provider-max-tokens').parentElement.textContent,/Configured output budget/);
  await f.input('#next-provider-manual-model','manual-unknown');await f.click('#next-provider-add-model');
  const row=f.$('[data-provider-model-id="manual-unknown"]').parentElement;
  assert.match(row.textContent,/Context window: Unknown · lookup not run/);
  assert.match(row.textContent,/Max output: Unknown · lookup not run/);
  assert.doesNotMatch(row.textContent,/128,000|8,192/);
  assert.equal(f.writes().length,0,'Adding a model draft does not test a model or save implicitly.');
});

test('catalog selection and saved edits retain both limit values, provenance and observation dates',async t=>{
  const model={id:'reported-limits',displayName:'Reported limits',contextWindowTokens:262144,contextWindowSource:'provider-reported',contextWindowObservedAt:'2026-10-30T12:00:00Z',maxOutputTokens:32768,maxOutputTokensSource:'provider-reported',maxOutputObservedAt:'2026-10-30T12:00:00Z'};
  const f=await fixture(t,{hook:call=>{if(call.route==='/api/providers/gateway/models')return {models:[model],total:1,offset:0,hasMore:false};}});
  await f.open();await f.click('#next-provider-catalog-load');await until(()=>!f.$('#next-provider-catalog-load').disabled);
  const input=f.$('[data-provider-model-id="reported-limits"]');assert.match(input.parentElement.textContent,/Context window: 262,144 tokens · Provider reported/);assert.match(input.parentElement.textContent,/Max output: 32,768 tokens · Provider reported/);
  input.checked=true;await input.dispatch('change');await f.click('#next-provider-save');await f.idle();
  let saved=f.writes().find(call=>call.route==='/api/providers'&&call.method==='POST').body.models.find(item=>item.id===model.id);assert.deepEqual(saved,model);
  await f.input('#next-provider-name','Renamed after discovery');await f.click('#next-provider-save');await f.idle();
  saved=f.writes().filter(call=>call.route==='/api/providers'&&call.method==='POST').at(-1).body.models.find(item=>item.id===model.id);assert.deepEqual(saved,model);
});

test('a newly saved native model immediately reports unknown context and output without starting an inference',async t=>{
  const f=await fixture(t);await f.input('#next-provider-codex-id','custom-native');await f.click('#next-provider-codex-add');await f.idle();
  assert.match(f.$('#next-provider-codex-status').textContent,/Model ID saved\. Context window: Unknown · lookup not run · Max output: Unknown · lookup not run/);
  const row=f.$('#next-provider-codex-list').textContent;assert.match(row,/custom-native/);assert.match(row,/Context window: Unknown · lookup not run/);assert.match(row,/Max output: Unknown · lookup not run/);
  assert.equal(f.calls.filter(call=>call.route==='/api/codex/models/check').length,0);
  assert.equal(f.writes().length,1);
});
test('Manage models reopens a saved endpoint, adds a selection and preserves the existing key and models',async t=>{
  const discovered={id:'openai/additional',displayName:'Additional model',contextWindowTokens:256000,contextWindowSource:'provider-reported',supportsTools:true};
  const f=await fixture(t,{hook:call=>{if(call.route==='/api/providers/gateway/models')return {models:[discovered],total:1,offset:0,hasMore:false};}});
  assert.equal(f.calls.some(call=>call.route.endsWith('/models')),false);
  await f.click('[data-provider-manage="gateway"]');await until(()=>f.$('[data-provider-model-id="openai/additional"]'));
  assert.equal(f.$('#next-provider-catalog-panel').open,true);assert.equal(f.$('#next-provider-connection-details').open,false);
  assert.equal(f.$('#next-provider-key').value,'');assert.equal(f.$('#next-provider-base-url').value,provider().baseUrl);
  const call=f.calls.find(call=>call.route==='/api/providers/gateway/models');assert.equal(call.method,'POST');assert.equal(Object.hasOwn(call.body,'apiKey'),false);assert.equal(Object.hasOwn(call.body,'baseUrl'),false);
  await f.click('#next-provider-catalog-expand');const box=f.$('[data-provider-model-id="openai/additional"]');box.checked=true;await box.dispatch('change');
  await f.click('#next-provider-save');await f.idle();
  const saved=f.calls.find(call=>call.route==='/api/providers'&&call.method==='POST').body;
  assert.equal(Object.hasOwn(saved,'apiKey'),false);assert.equal(Object.hasOwn(saved,'headers'),false);assert.equal(saved.baseUrl,provider().baseUrl);
  assert.deepEqual(saved.models.find(model=>model.id==='saved-model'),provider().models[0]);assert.deepEqual(saved.models.find(model=>model.id===discovered.id),discovered);
  assert.equal(f.state.providers.find(item=>item.id==='gateway').hasApiKey,true);
});

test('model groups start collapsed and retain explicit expansion across selection and provider navigation',async t=>{
  const f=await fixture(t,{hook:call=>{if(call.route==='/api/providers/gateway/models')return {models:[{id:'openai/first',contextWindowTokens:128000},{id:'anthropic/second',contextWindowTokens:200000}],total:2,offset:0,hasMore:false};}});
  await f.click('[data-provider-manage="gateway"]');await until(()=>f.$('#next-provider-catalog').querySelectorAll('details').length===2);
  assert.ok(f.$('#next-provider-models').querySelectorAll('details').every(group=>group.open===false));
  assert.ok(f.$('#next-provider-catalog').querySelectorAll('details').every(group=>group.open===false));
  assert.match(f.$('#next-provider-catalog').textContent,/openai/i);assert.match(f.$('#next-provider-catalog').textContent,/anthropic/i);
  await f.click('#next-provider-catalog-expand');assert.ok(f.$('#next-provider-catalog').querySelectorAll('details').every(group=>group.open));
  const box=f.$('[data-provider-model-id="openai/first"]');box.checked=true;await box.dispatch('change');
  assert.ok(f.$('#next-provider-catalog').querySelectorAll('details').every(group=>group.open));
  await f.open('second');await f.open('gateway');assert.ok(f.$('#next-provider-catalog').querySelectorAll('details').every(group=>group.open));
  await f.click('#next-provider-catalog-collapse');assert.ok(f.$('#next-provider-catalog').querySelectorAll('details').every(group=>!group.open));
});

test('catalog search, context sorting and capability filters are sent before server pagination',async t=>{
  const f=await fixture(t,{hook:call=>{if(call.route==='/api/providers/gateway/models')return {models:[{id:'provider/matched',contextWindowTokens:1000000}],total:161,offset:call.body.offset,hasMore:call.body.offset===0};}});await f.open();
  await f.input('#next-provider-catalog-search','long context');f.$('#next-provider-catalog-sort').value='context-desc';await f.$('#next-provider-catalog-sort').dispatch('change');
  await f.input('#next-provider-catalog-min-context','128000');
  for(const id of ['free','tools','vision']){f.$('#next-provider-catalog-'+id).checked=true;await f.$('#next-provider-catalog-'+id).dispatch('change');}
  assert.equal(f.calls.filter(call=>call.route==='/api/providers/gateway/models').length,1,'Only the unfiltered opening read ran before explicit search.');
  await f.click('#next-provider-catalog-load');await until(()=>!f.$('#next-provider-catalog-load').disabled);
  await f.click('#next-provider-catalog-next');await until(()=>!f.$('#next-provider-catalog-load').disabled);
  const expected={query:'long context',sort:'context-desc',freeOnly:true,toolsOnly:true,visionOnly:true,minContextTokens:128000,limit:80};
  assert.deepEqual(f.calls.filter(call=>call.route==='/api/providers/gateway/models').slice(1).map(call=>call.body),[{...expected,offset:0},{...expected,offset:80}]);
  assert.match(f.$('#next-provider-catalog-page').textContent,/of 161 matching models.*whole catalog filtered/);
  await f.click('#next-provider-catalog-clear');assert.equal(f.$('#next-provider-catalog-search').value,'');assert.equal(f.$('#next-provider-catalog-free').checked,false);
  assert.equal(f.$('#next-provider-catalog-sort').value,'name');assert.equal(f.$('#next-provider-catalog-min-context').value,'');
  await f.input('#next-provider-catalog-min-context','-1');await f.click('#next-provider-catalog-load');assert.match(f.$('#next-provider-error').textContent,/nonnegative whole number/);
  assert.equal(f.calls.filter(call=>call.route==='/api/providers/gateway/models').length,3);
});

test('hide and restore preserve connection execution state and merge the freshest hidden-provider preferences',async t=>{
  const f=await fixture(t);const original=structuredClone(f.state.providers);
  f.state.runtimeSettings.hiddenModelProviders=['external-provider'];
  await f.click('[data-provider-hide="gateway"]');await f.idle();
  assert.deepEqual(f.calls.filter(call=>call.route==='/api/runtime/settings').map(call=>[call.method,call.body]),[['GET',undefined],['POST',{hiddenModelProviders:['external-provider','gateway']}]]);
  assert.equal(f.$('[data-provider-id="gateway"]'),null);assert.equal(f.$('#next-provider-hidden').hidden,false);assert.equal(f.$('#next-provider-hidden').open,false);assert.ok(f.$('[data-provider-restore="gateway"]'));
  assert.deepEqual(f.state.providers,original);assert.equal(f.calls.filter(call=>call.route==='/api/providers'&&call.method==='POST').length,0);
  await f.click('[data-provider-restore="gateway"]');await f.idle();assert.ok(f.$('[data-provider-id="gateway"]'));assert.deepEqual(f.state.runtimeSettings.hiddenModelProviders,['external-provider']);assert.deepEqual(f.state.providers,original);
  await f.click('#next-provider-codex-hide');await f.idle();assert.equal(f.$('#next-provider-codex').hidden,true);assert.ok(f.$('[data-provider-restore="codex"]'));
  await f.click('[data-provider-restore="codex"]');await f.idle();assert.equal(f.$('#next-provider-codex').hidden,false);assert.deepEqual(f.state.providers,original);
});

test('fresh settings updates expose hidden providers for restore, and failed hiding never changes visibility optimistically',async t=>{
  const f=await fixture(t,{hook:call=>{if(call.route==='/api/runtime/settings'&&call.method==='POST')throw Error('Preference save failed');}});
  f.panel.updateRuntimeSettings({hiddenModelProviders:['second','codex']});assert.equal(f.$('[data-provider-id="second"]'),null);assert.ok(f.$('[data-provider-restore="second"]'));assert.equal(f.$('#next-provider-codex').hidden,true);
  f.panel.updateRuntimeSettings({hiddenModelProviders:[]});await f.click('[data-provider-hide="gateway"]');await f.idle();
  assert.ok(f.$('[data-provider-id="gateway"]'));assert.equal(f.$('[data-provider-restore="gateway"]'),null);assert.match(f.$('#next-provider-info').textContent,/Preference save failed/);
});

test('opening a saved provider always browses its full catalog and reopening clears old filters without dropping selections',async t=>{
  const first=provider().models[0],additional={id:'additional',displayName:'Additional model',contextWindowTokens:400000,contextWindowSource:'provider-reported'};
  const f=await fixture(t,{hook:call=>{if(call.route==='/api/providers/gateway/models')return {models:call.body.query?[additional]:[first,additional],offset:0,total:call.body.query?1:2,hasMore:false};}});
  await f.open();await until(()=>!f.$('#next-provider-catalog-load').disabled);
  let reads=f.calls.filter(call=>call.route==='/api/providers/gateway/models');assert.equal(reads.length,1);assert.equal(reads[0].body.query,'');assert.equal(reads[0].body.offset,0);
  assert.equal(f.$('#next-provider-catalog-panel').open,true);assert.equal(f.$('#next-provider-catalog').querySelector('[data-provider-model-id="saved-model"]').checked,true);
  const box=f.$('#next-provider-catalog').querySelector('[data-provider-model-id="additional"]');box.checked=true;await box.dispatch('change');await f.click('#next-provider-save');await f.idle();
  assert.deepEqual(f.writes()[0].body.models.map(model=>model.id),['saved-model','additional']);assert.equal(Object.hasOwn(f.writes()[0].body,'apiKey'),false);
  await f.input('#next-provider-catalog-search','additional');await f.input('#next-provider-catalog-min-context','128000');
  for(const id of ['free','tools','vision']){f.$('#next-provider-catalog-'+id).checked=true;await f.$('#next-provider-catalog-'+id).dispatch('change');}
  await f.click('#next-provider-catalog-load');await until(()=>!f.$('#next-provider-catalog-load').disabled);
  await f.open();await until(()=>!f.$('#next-provider-catalog-load').disabled);reads=f.calls.filter(call=>call.route==='/api/providers/gateway/models');
  assert.deepEqual(reads.at(-1).body,{query:'',sort:'name',freeOnly:false,toolsOnly:false,visionOnly:false,minContextTokens:0,offset:0,limit:80});
  for(const id of ['saved-model','additional'])assert.equal(f.$('#next-provider-catalog').querySelector(`[data-provider-model-id="${id}"]`).checked,true);
  assert.equal(f.$('#next-provider-catalog-search').value,'');assert.equal(f.$('#next-provider-catalog-min-context').value,'');
  const before=reads.length;await f.click('[data-provider-manage="gateway"]');await until(()=>!f.$('#next-provider-catalog-load').disabled);assert.equal(f.calls.filter(call=>call.route==='/api/providers/gateway/models').length,before+1,'Manage starts one unfiltered browse, without a duplicate read.');
  assert.equal(f.writes().length,1,'Browsing and reopening never save provider configuration.');
});

test('explicit metadata refresh enriches selected models outside the current catalog filter and exposes safe source links',async t=>{
  const reported={id:'saved-model',displayName:'Saved model',contextWindowTokens:400000,contextWindowSource:'model-reference',contextWindowObservedAt:'2026-10-30T12:00:00Z',contextWindowEvidence:{label:'Official catalog',modelId:'underlying-model',url:'https://models.example/model',endpointSpecific:false},
    maxOutputTokens:32000,maxOutputTokensSource:'model-reference',maxOutputObservedAt:'2026-10-30T12:00:00Z',maxOutputEvidence:{label:'Official catalog',modelId:'underlying-model',url:'https://models.example/model',endpointSpecific:false},modelLimitLookup:{status:'resolved',checkedAt:'2026-10-30T12:00:00Z',sources:[]}};
  let fail=false;const f=await fixture(t,{providers:[provider('gateway',{models:[{id:'saved-model',displayName:'Saved model'}]})],hook:call=>{if(call.route==='/api/providers/gateway/models'){
    if(call.body.refresh&&fail)throw Error('Lookup temporarily unavailable');return {models:[{id:'visible-page-model'}],selectedModels:call.body.refresh?[reported,{id:'not-selected',contextWindowTokens:100}]:[],offset:0,total:1,hasMore:false};
  }}});await f.open();await f.input('#next-provider-catalog-search','visible');await f.click('#next-provider-limits-refresh');await until(()=>!f.$('#next-provider-limits-refresh').disabled);
  const call=f.calls.filter(item=>item.route==='/api/providers/gateway/models').at(-1);assert.equal(call.body.refresh,true);assert.equal(call.body.query,'visible');assert.equal(Object.hasOwn(call.body,'apiKey'),false);
  const selected=f.$('#next-provider-models');assert.match(selected.textContent,/400,000 tokens · Model reference · Official catalog · Endpoint unconfirmed/);assert.match(selected.textContent,/Observed 2026-10-30 12:00:00 UTC/);
  const link=selected.querySelector('a');assert.equal(link.getAttribute('href'),'https://models.example/model');assert.equal(link.getAttribute('rel'),'noopener noreferrer');assert.equal(link.closest('label'),null);
  assert.match(link.textContent,/underlying-model/);assert.equal(selected.querySelectorAll('input').length,1);assert.equal(f.$('[data-provider-model-id="saved-model"]').checked,true);assert.equal(f.writes().length,0);
  fail=true;await f.click('#next-provider-limits-refresh');await until(()=>!f.$('#next-provider-limits-refresh').disabled);
  assert.equal(f.$('#next-provider-limits-refresh').textContent,'Retry model limits');assert.match(f.$('#next-provider-receipt').textContent,/selected models and edits are kept.*Retry model limits/);
  assert.match(f.$('#next-provider-models').textContent,/400,000/);const count=f.calls.length;await settle();await settle();assert.equal(f.calls.length,count,'No automatic retry occurs.');
});

test('lookup outcomes remain visible and manual context overrides survive a forced refresh',async t=>{
  const manual={id:'saved-model',displayName:'Saved model',contextWindowTokens:90000,contextWindowSource:'user-configured'};
  const partial={id:'saved-model',contextWindowTokens:400000,contextWindowSource:'model-reference',contextWindowEvidence:{label:'Catalog',url:'javascript:alert(1)',endpointSpecific:false},maxOutputTokens:null,modelLimitLookup:{status:'partial',checkedAt:'2026-10-30T12:00:00Z',sources:[{id:'runtime',label:'Runtime metadata',status:'unavailable'}]}};
  const f=await fixture(t,{providers:[provider('gateway',{models:[manual]})],hook:call=>{if(call.route==='/api/providers/gateway/models')return {models:[],selectedModels:[partial],offset:0,total:0,hasMore:false};}});
  await f.open();await f.click('#next-provider-limits-refresh');await until(()=>!f.$('#next-provider-limits-refresh').disabled);
  const models=f.$('#next-provider-models');assert.match(models.textContent,/90,000 tokens · User configured/);assert.match(models.textContent,/Max output: Unknown · not found after lookup/);assert.match(models.textContent,/Runtime metadata: unavailable/);assert.equal(models.querySelector('a'),null);
  assert.equal(f.$('#next-provider-limits-refresh').textContent,'Retry model limits');await f.input('#next-provider-name','Keep manual');await f.click('#next-provider-save');await f.idle();
  const saved=f.writes()[0].body.models[0];assert.equal(saved.contextWindowTokens,90000);assert.equal(saved.contextWindowSource,'user-configured');assert.equal(saved.contextWindowEvidence,undefined);
});

test('native read displays hidden advertised models and distinct documented and runtime candidates without claiming access',async t=>{
  const f=await fixture(t);f.state.codex.models.push({id:'native-hidden',model:'native-hidden',source:'advertised',hidden:true,contextWindowTokens:196000,contextWindowSource:'runtime-reported',runtimeDefaultContextWindowTokens:196000,maxContextWindowTokens:1000000});
  f.state.codex.candidates=[{id:'native-hidden',source:'documented'},{id:'documented-only',source:'documented'},{id:'runtime-only',source:'runtime-candidate',access:{state:'unverified'}}];
  await f.click('#next-provider-codex-read');await until(()=>!f.$('#next-provider-codex-read').disabled);
  const list=f.$('#next-provider-codex-list');assert.equal(list.querySelectorAll('li').length,4);assert.match(list.textContent,/Hidden by Codex/);assert.match(list.textContent,/Runtime default context: 196,000/);assert.match(list.textContent,/Maximum supported context: 1,000,000/);
  assert.match(list.textContent,/Documented candidate · not advertised by this catalog/);assert.match(list.textContent,/Runtime metadata candidate · not advertised by this catalog/);
  assert.equal(list.querySelectorAll('input').length,0);assert.equal(list.querySelectorAll('button').length,0);assert.equal(f.calls.some(call=>call.route==='/api/codex/models/check'),false);assert.equal(f.writes().length,0);
  await f.input('#next-provider-codex-filter','hidden');assert.equal(list.querySelectorAll('li').length,1);assert.match(list.textContent,/native-hidden/);
});

test('selected metadata can resolve while the full provider catalog is unavailable without a false catalog-success message',async t=>{
  const f=await fixture(t,{providers:[provider('gateway',{models:[{id:'saved-model',displayName:'Saved model'}]})],hook:call=>{if(call.route==='/api/providers/gateway/models')return {
    models:[],selectedModels:[{id:'saved-model',contextWindowTokens:200000,contextWindowSource:'model-reference',contextWindowEvidence:{label:'Official model documentation',endpointSpecific:false}}],
    catalogAvailable:false,catalogError:{message:'Models endpoint timed out.'},offset:0,total:0,hasMore:false};}});
  await f.open();await until(()=>!f.$('#next-provider-limits-refresh').disabled);
  assert.match(f.$('#next-provider-models').textContent,/200,000 tokens · Model reference · Official model documentation · Endpoint unconfirmed/);
  assert.match(f.$('#next-provider-catalog').textContent,/Provider catalog unavailable/);assert.match(f.$('#next-provider-catalog-page').textContent,/Full provider catalog unavailable/);
  assert.match(f.$('#next-provider-receipt').textContent,/Lookup results for selected models/);assert.match(f.$('#next-provider-error').textContent,/Models endpoint timed out/);
  assert.doesNotMatch(f.$('#next-provider-receipt').textContent,/Catalog loaded|Model limits refreshed/);assert.equal(f.$('#next-provider-limits-refresh').textContent,'Retry model limits');
  assert.equal(f.writes().length,0);assert.equal(f.$('[data-provider-model-id="saved-model"]').checked,true);
});

test('provider snapshots update a clean open editor in both directions without extra reads or implicit saves',async t=>{
  const f=await fixture(t);await f.open();const fields=f.$('#next-provider-name'),beforeReads=f.calls.filter(call=>call.route==='/api/providers'&&call.method==='GET').length;
  const external=provider('gateway',{name:'Changed through API',updatedAt:'2026-10-25T10:30:00Z',models:[{id:'external-model',contextWindowTokens:196000,contextWindowSource:'provider-reported'}]});
  f.state.providers[0]=external;f.emit('runtime.status',{providers:structuredClone(f.state.providers)});await settle();
  assert.equal(f.$('#next-provider-name'),fields);assert.equal(fields.value,'Changed through API');assert.equal(f.$('[data-provider-model-id="saved-model"]'),null);
  assert.equal(f.$('[data-provider-model-id="external-model"]').checked,true);assert.match(f.$('#next-provider-models').textContent,/196,000/);
  assert.equal(f.$('#next-provider-stale').hidden,true);assert.equal(f.calls.filter(call=>call.route==='/api/providers'&&call.method==='GET').length,beforeReads);assert.equal(f.writes().length,0);
  for(let i=0;i<5;i++)f.emit('runtime.status',{providers:structuredClone(f.state.providers)});await settle();assert.equal(f.calls.filter(call=>call.route==='/api/providers'&&call.method==='GET').length,beforeReads,'Unrelated status events do not create refresh loops.');
  await f.input('#next-provider-name','Changed through UI');await f.click('#next-provider-save');await f.idle();
  assert.equal(f.writes()[0].body.expectedUpdatedAt,external.updatedAt);assert.equal(f.state.providers.find(item=>item.id==='gateway').name,'Changed through UI');assert.equal(f.changed,1);
  const snapshot=structuredClone(f.state.providers);snapshot.find(item=>item.id==='gateway').models=[];snapshot.find(item=>item.id==='gateway').updatedAt='2026-10-25T12:00:00Z';f.state.providers=snapshot;
  f.emit('runtime.status',{providers:snapshot});await settle();assert.equal(f.$('#next-provider-models').querySelectorAll('input').length,0);assert.match(f.$('#next-provider-model-count').textContent,/0 \/ 200/);
  assert.equal(f.writes().length,1,'Reverse-direction removals never write the old selection back.');
});

test('external changes preserve dirty drafts and credentials while preventing a stale save until explicit reload',async t=>{
  const f=await fixture(t);await f.open();await f.input('#next-provider-name','Local draft');await f.input('#next-provider-key','private-unsaved-key');
  let box=f.$('[data-provider-model-id="catalog-model"]');box.checked=true;await box.dispatch('change');
  f.state.providers[0]=provider('gateway',{name:'External revision',updatedAt:'2026-10-25T12:00:00Z',models:[{id:'external-only'}]});
  f.emit('runtime.status',{providers:structuredClone(f.state.providers)});await settle();
  assert.equal(f.$('#next-provider-name').value,'Local draft');assert.equal(f.$('#next-provider-key').value,'private-unsaved-key');assert.equal(f.$('[data-provider-model-id="catalog-model"]').checked,true);
  assert.equal(f.$('#next-provider-stale').hidden,false);assert.match(f.$('#next-provider-stale').textContent,/Reload saved settings before saving/);assert.equal(f.$('#next-provider-save').disabled,true);
  await f.click('#next-provider-save');assert.equal(f.writes().length,0);assert.deepEqual(f.state.providers[0].models,[{id:'external-only'}]);
  await f.click('#next-provider-discard');await until(()=>f.$('#next-provider-name').value==='External revision');
  assert.equal(f.$('#next-provider-key').value,'');assert.equal(f.$('[data-provider-model-id="saved-model"]'),null);assert.equal(f.$('[data-provider-model-id="external-only"]').checked,true);assert.equal(f.$('#next-provider-stale').hidden,true);
  assert.equal(f.writes().length,0,'Reload is read-only.');
});

test('a save conflict detected by the API retains edits, reads current state and never retries automatically',async t=>{
  const f=await fixture(t);await f.open();await f.input('#next-provider-name','Local conflict');
  f.state.providers[0]=provider('gateway',{name:'New backend value',updatedAt:'2026-10-25T12:00:00Z'});
  await f.click('#next-provider-save');await f.idle();await until(()=>!f.$('#next-provider-refresh').disabled);
  assert.equal(f.writes().length,1);assert.equal(f.writes()[0].body.expectedUpdatedAt,provider().updatedAt);assert.equal(f.$('#next-provider-name').value,'Local conflict');
  assert.equal(f.$('#next-provider-save').disabled,true);assert.match(f.$('#next-provider-error').textContent,/changed elsewhere.*draft is kept/);
  await f.click('#next-provider-save');await settle();assert.equal(f.writes().length,1);assert.equal(f.state.providers[0].name,'New backend value');
  await f.click('#next-provider-discard');await until(()=>f.$('#next-provider-name').value==='New backend value');await f.input('#next-provider-name','After reload');
  await f.click('#next-provider-save');await f.idle();assert.equal(f.writes()[1].body.expectedUpdatedAt,'2026-10-25T12:00:00Z');assert.equal(f.state.providers.find(item=>item.id==='gateway').name,'After reload');
});

test('metadata-only snapshots enrich existing selections without treating user edits as stale or cancelling the catalog',async t=>{
  const pending=deferred();let held=false;
  const f=await fixture(t,{hook:call=>{if(held&&call.route==='/api/providers/gateway/models')return pending.promise;}});await f.open();
  const box=f.$('[data-provider-model-id="catalog-model"]');box.checked=true;await box.dispatch('change');await f.input('#next-provider-capacities','saved-model = 90000');
  held=true;await f.click('#next-provider-catalog-load');const request=f.calls.filter(call=>call.route==='/api/providers/gateway/models').at(-1);
  const latest=structuredClone(f.state.providers);latest[0].models[0].maxOutputTokens=32000;latest[0].models[0].maxOutputObservedAt='2026-10-25T10:30:00Z';
  f.state.providers=latest;f.emit('runtime.status',{providers:latest});await settle();
  assert.equal(request.options.signal.aborted,false);assert.equal(f.$('#next-provider-stale').hidden,true);assert.equal(f.$('#next-provider-capacities').value,'saved-model = 90000');assert.equal(f.$('[data-provider-model-id="catalog-model"]').checked,true);
  assert.match(f.$('#next-provider-models').textContent,/32,000/);pending.resolve({models:[{id:'new-page'}],offset:0,total:1,hasMore:false});await until(()=>f.$('[data-provider-model-id="new-page"]'));
  await f.click('#next-provider-save');await f.idle();const saved=f.writes()[0].body.models;
  assert.equal(saved.find(model=>model.id==='saved-model').contextWindowTokens,90000);assert.equal(saved.find(model=>model.id==='saved-model').maxOutputTokens,32000);assert.ok(saved.find(model=>model.id==='catalog-model'));
});

test('removed connections close clean editors and preserve dirty drafts without recreating the deleted connection',async t=>{
  const f=await fixture(t);await f.open();f.state.providers=f.state.providers.filter(item=>item.id!=='gateway');f.emit('runtime.status',{providers:f.state.providers});await settle();
  assert.equal(f.$('#next-provider-form').hidden,true);assert.equal(f.$('[data-provider-id="gateway"]'),null);
  await f.open('second');await f.input('#next-provider-name','Keep this draft');f.state.providers=[];f.emit('runtime.status',{providers:[]});await settle();
  assert.equal(f.$('#next-provider-form').hidden,false);assert.equal(f.$('#next-provider-name').value,'Keep this draft');assert.match(f.$('#next-provider-stale').textContent,/removed elsewhere/);assert.equal(f.$('#next-provider-save').disabled,true);
  await f.click('#next-provider-save');assert.equal(f.writes().length,0);await f.click('#next-provider-discard');await until(()=>f.$('#next-provider-form').hidden);assert.equal(f.state.providers.length,0);
});

test('typing searches automatically across three endpoints and ignores delayed results from a previous provider',async t=>{
  const slow=deferred(),providers=[provider('first'),provider('second'),provider('third')];
  const f=await fixture(t,{providers,hook:call=>{if(!call.route.startsWith('/api/providers/')||!call.route.endsWith('/models'))return;
    const id=call.route.split('/')[3];if(id==='first'&&call.body.query==='slow')return slow.promise;
    return {models:[{id:call.body.query?id+'/'+call.body.query:'shared-model',contextWindowTokens:id==='first'?100000:id==='second'?200000:300000,contextWindowSource:'provider-reported'}],offset:0,total:1,hasMore:false};}});
  await f.open('first');let box=f.$('[data-provider-model-id="shared-model"]');box.checked=true;await box.dispatch('change');
  await f.input('#next-provider-catalog-search','s');await f.input('#next-provider-catalog-search','sl');await f.input('#next-provider-catalog-search','slow');
  assert.ok(f.$('[data-provider-model-id="shared-model"]'),'Previous results remain visible while typing.');assert.match(f.$('#next-provider-catalog-page').textContent,/Updating results/);
  await new Promise(resolve=>setTimeout(resolve,220));await until(()=>f.calls.some(call=>call.body?.query==='slow'));
  assert.deepEqual(f.calls.filter(call=>call.route==='/api/providers/first/models').map(call=>call.body.query),['','slow']);
  const delayed=f.calls.find(call=>call.body?.query==='slow');await f.open('second');assert.equal(delayed.options.signal.aborted,true);assert.equal(f.$('[data-provider-model-id="shared-model"]').checked,false,'The same raw model ID has a separate selection for each endpoint.');assert.match(f.$('#next-provider-catalog').textContent,/200,000/);
  await f.input('#next-provider-catalog-search','second-match');await f.open('third');await f.input('#next-provider-catalog-search','third-match');
  slow.resolve({models:[{id:'wrong-endpoint'}],offset:0,total:1,hasMore:false});await new Promise(resolve=>setTimeout(resolve,220));await until(()=>f.$('[data-provider-model-id="third/third-match"]'));
  assert.equal(f.$('[data-provider-model-id="wrong-endpoint"]'),null);assert.equal(f.calls.some(call=>call.route==='/api/providers/second/models'&&call.body.query==='second-match'),false,'Switching cancels pending typed searches.');
  await f.open('first');assert.equal(f.$('[data-provider-model-id="shared-model"]').checked,true);assert.match(f.$('#next-provider-models').textContent,/100,000/);assert.equal(f.$('#next-provider-catalog-search').value,'');assert.equal(f.writes().length,0);
});

test('sort and capability filters search immediately while preserving visible results until replacement',async t=>{
  const pending=deferred();let hold=false;
  const f=await fixture(t,{hook:call=>{if(hold&&call.route==='/api/providers/gateway/models')return pending.promise;}});await f.open();hold=true;
  f.$('#next-provider-catalog-sort').value='context-desc';await f.$('#next-provider-catalog-sort').dispatch('change');
  f.$('#next-provider-catalog-tools').checked=true;await f.$('#next-provider-catalog-tools').dispatch('change');
  await new Promise(resolve=>setTimeout(resolve,10));const call=f.calls.filter(call=>call.route==='/api/providers/gateway/models').at(-1);
  assert.equal(call.body.sort,'context-desc');assert.equal(call.body.toolsOnly,true);assert.ok(f.$('[data-provider-model-id="catalog-model"]'));assert.match(f.$('#next-provider-catalog-page').textContent,/Updating results/);
  pending.resolve({models:[{id:'tool-model'}],offset:0,total:1,hasMore:false});await until(()=>f.$('[data-provider-model-id="tool-model"]'));
  assert.equal(f.$('[data-provider-model-id="catalog-model"]'),null);assert.match(f.$('#next-provider-catalog-page').textContent,/1–1 of 1/);assert.equal(f.writes().length,0);
});

test('disabled connections without credentials can browse and select public catalogs without implying generation access',async t=>{
  const f=await fixture(t,{providers:[provider('public_catalog',{name:'Public catalog',enabled:false,configured:false,hasApiKey:false,requiresApiKey:true})]});await f.open('public_catalog');
  assert.match(f.$('[data-provider-id="public_catalog"]').textContent,/Disabled/);assert.equal(f.$('#next-provider-catalog-load').disabled,false);
  const box=f.$('[data-provider-model-id="catalog-model"]');box.checked=true;await box.dispatch('change');await f.click('#next-provider-save');await f.idle();
  assert.equal(f.writes()[0].body.enabled,false);assert.equal(f.writes()[0].body.expectedUpdatedAt,provider().updatedAt);assert.equal(Object.hasOwn(f.writes()[0].body,'apiKey'),false);
  assert.match(f.$('#next-provider-receipt').textContent,/when this connection is configured and enabled/);assert.equal(f.calls.some(call=>call.route.endsWith('/test')||call.route.endsWith('/check')),false);
  await f.input('#next-provider-catalog-search','cancel on leave');f.panel.leave();const count=f.calls.length;await new Promise(resolve=>setTimeout(resolve,220));assert.equal(f.calls.length,count);
});


test('anonymous free presets save endpoints and blank credentials before opening a scoped model catalog', async t => {
  const freeModel={id:'openai-fast',displayName:'Free model',supportsTools:true,isFree:true,freeSource:'provider-reported',aliases:['gpt-oss-20b'],inputModalities:['text'],outputModalities:['text']};
  const f=await fixture(t,{hook:async(call)=>call.route.endsWith('/models')&&call.route.startsWith('/api/providers/')?{models:[freeModel],offset:0,total:1,hasMore:false}:undefined});
  const before=structuredClone(f.state.providers);
  await f.click('#next-provider-new');
  f.$('#next-provider-preset').value='pollinations_classic';await f.$('#next-provider-preset').dispatch('change');
  assert.equal(f.$('#next-provider-base-url').value,'https://text.pollinations.ai');
  assert.equal(f.$('#next-provider-models-path').value,'/models');assert.equal(f.$('#next-provider-chat-path').value,'/openai');
  assert.match(f.$('#next-provider-key-note').textContent,/No API key is required/);
  assert.equal(f.$('#next-provider-catalog-free').checked,true);assert.equal(f.$('#next-provider-catalog-free').disabled,true);
  await f.input('#next-provider-id','free_classic_test');await f.click('#next-provider-save');await f.idle();
  await until(()=>f.$('#next-provider-catalog').querySelector('[data-provider-model-id="openai-fast"]'));
  const savedCall=f.calls.find(call=>call.route==='/api/providers'&&call.method==='POST');
  assert.equal(Object.hasOwn(savedCall.body,'apiKey'),false);assert.equal(savedCall.body.preset,'pollinations_classic');
  assert.deepEqual(savedCall.body.endpoints,{models:'/models',chatCompletions:'/openai'});
  assert.deepEqual(f.state.providers.filter(item=>item.id!=='free_classic_test'),before);
  assert.equal(f.calls.find(call=>call.route==='/api/providers/free_classic_test/models').body.freeOnly,true);
  const toggle=f.$('#next-provider-catalog').querySelector('[data-provider-model-id="openai-fast"]');toggle.checked=true;await toggle.dispatch('change');
  await f.click('#next-provider-save');await f.idle();
  let saved=f.state.providers.find(item=>item.id==='free_classic_test');
  assert.equal(saved.models.length,1);assert.equal(saved.models[0].isFree,true);assert.equal(saved.models[0].freeSource,'provider-reported');assert.deepEqual(saved.models[0].aliases,['gpt-oss-20b']);
  await f.open('gateway');await f.open('free_classic_test');await until(()=>!f.$('#next-provider-catalog-load').disabled);
  assert.equal(f.$('#next-provider-catalog-free').checked,true);
  await f.click('#next-provider-catalog-clear');await until(()=>f.calls.filter(call=>call.route==='/api/providers/free_classic_test/models').length>=3);
  assert.equal(f.calls.filter(call=>call.route==='/api/providers/free_classic_test/models').at(-1).body.freeOnly,true);
  assert.equal(f.state.providers.find(item=>item.id==='free_classic_test').models[0].id,'openai-fast');
});

test('Kilo preset scopes its catalog while existing custom connection filters and models stay independent', async t => {
  const f=await fixture(t);await f.click('#next-provider-new');
  f.$('#next-provider-preset').value='kilo_free';await f.$('#next-provider-preset').dispatch('change');
  assert.equal(f.$('#next-provider-base-url').value,'https://ai-gateway.kilo.ai/api/v1');assert.equal(f.$('#next-provider-chat-path').value,'');
  await f.input('#next-provider-id','free_kilo_test');await f.click('#next-provider-save');await f.idle();
  await until(()=>f.calls.some(call=>call.route==='/api/providers/free_kilo_test/models'));
  assert.equal(f.calls.find(call=>call.route==='/api/providers/free_kilo_test/models').body.freeOnly,true);
  await f.open('gateway');await until(()=>!f.$('#next-provider-catalog-load').disabled);
  assert.equal(f.$('#next-provider-catalog-free').checked,false);assert.equal(f.$('#next-provider-catalog-free').disabled,false);
  assert.deepEqual(f.state.providers.find(item=>item.id==='gateway').models,provider().models);
});
