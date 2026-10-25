import test from 'node:test';
import assert from 'node:assert/strict';
import {createProviderSettings} from '../public/next/workspaces/settings-providers.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function until(read){for(let i=0;i<100;i++){if(read())return;await settle();}throw Error('Provider settings did not settle.');}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const provider=(id='gateway',extra={})=>({id,name:'Saved gateway',preset:'compatible',type:'compatible',baseUrl:'https://gateway.example/v1',enabled:true,maxTokens:8192,maxSteps:null,
  configured:true,requiresApiKey:false,hasApiKey:true,hasHeaders:true,headerNames:['X-Gateway-Key'],secretStorage:'encrypted',updatedAt:'2026-10-25T10:00:00Z',
  models:[{id:'saved-model',displayName:'Saved model',contextWindowTokens:128000,contextWindowSource:'provider-reported',supportsTools:true,maxOutputTokens:16000,inputModalities:['text'],outputModalities:['text']}],...extra});
async function fixture(t,{providers=[provider(),provider('second',{name:'Second gateway'})],hook}={}){
  const dom=planningDOM(t),prototype=Object.getPrototypeOf(dom.mount),type=Object.getOwnPropertyDescriptor(prototype,'type');
  Object.defineProperty(prototype,'type',{get:type.get,set(value){this.setAttribute('type',value);}});
  prototype.replaceChildren=function(...children){for(const child of this.children)child.parentElement=null;this.children=[];this.rawText='';this.markup='';this.append(...children);};
  const storage={getItem(){throw Error('Credentials must not use browser storage');},setItem(){throw Error('Credentials must not use browser storage');}};
  window.localStorage=storage;window.sessionStorage=storage;
  const calls=[],notices=[],state={providers:structuredClone(providers),customModels:[],codex:{connected:true,authenticated:true,models:[{id:'native-model',model:'native-model',displayName:'Native model',source:'advertised',access:{state:'unverified'}}],customModels:[],modelCheck:null,modelCheckBlocked:false}},subscribers=new Set();let changed=0;
  const api=async(route,method='GET',body,options)=>{
    const call={route,method,body:structuredClone(body),options};calls.push(call);
    if(hook){const result=await hook(call,state);if(result!==undefined)return result;}
    if(route==='/api/providers'&&method==='GET')return structuredClone(state.providers);
    if(route==='/api/providers'&&method==='POST'){
      const previous=state.providers.find(item=>item.id===body.id),{apiKey,headers,...value}=body;
      const saved={...previous,...value,hasApiKey:apiKey===undefined?previous?.hasApiKey||false:Boolean(apiKey),hasHeaders:headers===undefined?previous?.hasHeaders||false:Object.keys(headers).length>0,
        headerNames:headers===undefined?previous?.headerNames||[]:Object.keys(headers),requiresApiKey:body.preset==='openrouter'||body.type!=='compatible',configured:body.enabled,updatedAt:'2026-10-25T11:00:00Z'};
      state.providers=state.providers.filter(item=>item.id!==saved.id);state.providers.push(saved);return structuredClone(saved);
    }
    if(/^\/api\/providers\/[^/]+$/.test(route)&&method==='DELETE'){state.providers=state.providers.filter(item=>item.id!==route.split('/').at(-1));return {removed:true};}
    if(route.endsWith('/models')&&route.startsWith('/api/providers/'))return {models:[{id:'catalog-model',displayName:'Catalog model',contextWindowTokens:256000,contextWindowSource:'provider-reported',supportsTools:false}],offset:body.offset,total:1,hasMore:false};
    if(route.endsWith('/test'))return {ok:true,credentialVerified:true,modelAccessVerified:false};
    if(route==='/api/codex/models'){
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
  const panel=createProviderSettings({mount:dom.mount,api,events:{subscribe(handler){subscribers.add(handler);return()=>subscribers.delete(handler);}},notify:value=>notices.push(value),onChanged:()=>{changed++;}});
  t.after(()=>panel.destroy());panel.enter();await until(()=>dom.$('[data-provider-id]')||state.providers.length===0&&!dom.$('#next-provider-refresh').disabled);
  return {...dom,panel,calls,state,notices,subscribers,get changed(){return changed;},writes:()=>calls.filter(call=>call.method!=='GET'),
    async open(id='gateway'){await dom.click(`[data-provider-id="${id}"]`);},
    async idle(){await until(()=>!dom.$('#next-provider-new').disabled);},
    emit(type='runtime.status'){for(const handler of subscribers)handler({type});}};
}

test('provider list is bounded, searchable and distinguishes configured from enabled; entry reads never save',async t=>{
  const providers=Array.from({length:85},(_,i)=>provider('api_'+i,{name:'Gateway '+i,...(i===0?{enabled:false,configured:false}:i===1?{configured:false}:{} )}));
  const f=await fixture(t,{providers});assert.equal(f.$('#next-provider-list').querySelectorAll('button').length,40);
  assert.match(f.$('[data-provider-id="api_0"]').textContent,/Disabled/);assert.match(f.$('[data-provider-id="api_1"]').textContent,/Enabled · needs credentials/);
  assert.match(f.$('[data-provider-id="api_2"]').textContent,/Enabled · configured/);
  await f.click('#next-provider-more');assert.equal(f.$('#next-provider-list').querySelectorAll('button').length,80);
  await f.input('#next-provider-filter','Gateway 84');assert.equal(f.$('#next-provider-list').querySelectorAll('button').length,1);
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

test('catalog is explicit and paged, selected IDs and metadata survive page/search changes',async t=>{
  const f=await fixture(t,{hook:call=>{if(call.route.endsWith('/models')&&call.route.startsWith('/api/providers/'))return {models:[{id:call.body.query?'searched-model':call.body.offset?'next-model':'first-model',displayName:'Discovered',contextWindowTokens:256000,contextWindowSource:'provider-reported',supportsTools:true}],offset:call.body.offset,total:161,hasMore:call.body.offset===0};}});await f.open();
  await f.input('#next-provider-catalog-search','');assert.equal(f.writes().length,0);
  await f.click('#next-provider-catalog-load');await until(()=>!f.$('#next-provider-catalog-load').disabled);
  let box=f.$('[data-provider-model-id="first-model"]');box.checked=true;await box.dispatch('change');
  await f.click('#next-provider-catalog-next');await until(()=>f.$('[data-provider-model-id="next-model"]'));
  await f.input('#next-provider-catalog-search','searched');assert.equal(f.calls.filter(call=>call.route.endsWith('/models')).length,2);
  await f.click('#next-provider-catalog-load');await until(()=>f.$('[data-provider-model-id="searched-model"]'));
  assert.equal(f.$('[data-provider-model-id="first-model"]').checked,true);assert.equal(f.$('[data-provider-model-id="saved-model"]').checked,true);
  await f.click('#next-provider-save');await f.idle();const saved=f.calls.find(call=>call.route==='/api/providers'&&call.method==='POST').body.models;
  assert.equal(saved.length,2);assert.equal(saved.find(item=>item.id==='first-model').contextWindowSource,'provider-reported');
  assert.deepEqual(f.calls.filter(call=>call.route.startsWith('/api/providers/')&&call.route.endsWith('/models')).map(call=>call.body),[{query:'',offset:0,limit:80},{query:'',offset:80,limit:80},{query:'searched',offset:0,limit:80}]);
});

test('late catalog results cannot alter another connection or a newer search; unsaved settings never trigger implicit save',async t=>{
  const catalog=deferred();const f=await fixture(t,{hook:call=>{if(call.route==='/api/providers/gateway/models')return catalog.promise;}});await f.open();
  await f.click('#next-provider-catalog-load');await f.open('second');catalog.resolve({models:[{id:'wrong-provider-model'}],total:1,offset:0});await settle();await settle();
  assert.equal(f.$('[data-provider-model-id="wrong-provider-model"]'),null);await f.input('#next-provider-key','draft-only');
  assert.equal(f.$('#next-provider-catalog-load').disabled,true);await f.click('#next-provider-catalog-load');assert.equal(f.calls.filter(call=>call.route==='/api/providers/second/models').length,0);
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
  await f.click('[data-codex-remove="exact-native-id"]');await f.idle();assert.deepEqual(f.state.customModels,[]);assert.equal(f.changed,3);
});

test('uncertain Codex checks require a status read and hidden late status reads are discarded',async t=>{
  let fail=true,hold=false;const read=deferred();const f=await fixture(t,{hook:call=>{if(call.route==='/api/codex/models/check'&&fail){fail=false;throw Error('Request timed out');}if(call.route==='/api/codex/models'&&call.method==='GET'&&hold)return read.promise;}});
  await f.click('#next-provider-codex-read');await until(()=>!f.$('#next-provider-codex-read').disabled);await f.input('#next-provider-codex-id','native-model');
  await f.click('#next-provider-codex-check');await f.idle();assert.equal(f.$('#next-provider-codex-check').disabled,true);
  await f.click('#next-provider-codex-check');assert.equal(f.calls.filter(call=>call.route==='/api/codex/models/check').length,1);
  hold=true;await f.click('#next-provider-codex-read');f.panel.leave();read.resolve({...f.state.codex,models:[{id:'hidden-late-model'}]});await settle();f.panel.enter();await settle();
  assert.equal(f.$('#next-provider-codex-list').textContent.includes('hidden-late-model'),false);
  hold=false;await f.click('#next-provider-codex-read');await until(()=>!f.$('#next-provider-codex-read').disabled);assert.equal(f.$('#next-provider-codex-check').disabled,false);
});
