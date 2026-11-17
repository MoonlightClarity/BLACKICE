import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createLlamaCppLaunchSettings} from '../public/next/workspaces/llama-launch-settings.mjs';
import {DEFAULT_LLAMA_CPP_SETTINGS} from '../lib/llama-cpp-launch-config.mjs';
import {localModelHTTP} from '../lib/local-model-http.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
function fixture(t,{hook,pickFiles}={}){
 const dom=planningDOM(t),calls=[];
 let snapshot={revision:2,settings:{...structuredClone(DEFAULT_LLAMA_CPP_SETTINGS),modelPaths:{existing:'C:\\Models\\existing.gguf'}},recommended:structuredClone(DEFAULT_LLAMA_CPP_SETTINGS),process:{},runtime:{available:true,source:'bundled',version:'v1.0.0',backend:'CPU',message:'CPU fallback'}};
 const api=async(route,method='GET',body)=>{const c={route,method,body};calls.push(c);const result=hook?.(c);if(result!==undefined)return result;
  if(route.endsWith('/config')){if(method==='POST')snapshot={...snapshot,revision:snapshot.revision+1,settings:body.settings};return structuredClone(snapshot);}
  return {model:body.model,selection:'local_llamacpp::'+body.model};
 };
 let changed=0;
 const panel=createLlamaCppLaunchSettings({mount:dom.mount,api,pickFiles,onChanged:()=>{changed++;}});
 t.after(()=>panel.destroy());
 return {...dom,panel,calls,get changed(){return changed;},async enter(){panel.enter();await tick();},writes:()=>calls.filter(c=>c.method==='POST')};
}
test('included runtime, CPU fallback, and simple file flow are visible; technical fields collapsed',async t=>{
 const f=fixture(t,{pickFiles:async()=>({filePaths:['C:\\Models\\research.gguf']})});await f.enter();
 assert.match(f.$('#next-llama-runtime-status').textContent,/Included.*CPU.*fallback/);
 assert.equal(f.$('#next-llama-launch-settings').open,false);assert.equal(f.writes().length,0);
 await f.click('#next-llama-model-browse');
 assert.equal(f.$('#next-llama-model-name').value,'research');
 assert.equal(f.writes().length,0);
 await f.click('#next-llama-model-start');
 assert.equal(f.writes().length,2);
 assert.deepEqual(f.writes()[0].body.settings.modelPaths,{existing:'C:\\Models\\existing.gguf',research:'C:\\Models\\research.gguf'});
 assert.equal(f.writes()[0].body.settings.executablePath,'');
 assert.deepEqual(f.writes()[1].body,{engine:'llamacpp',model:'research'});
 assert.equal(f.changed,1);assert.match(f.$('#next-llama-default-feedback').textContent,/Ready in/);
});
test('picker cancellation, wrong file type, and late picker are nonmutating',async t=>{
 let selected=[];const f=fixture(t,{pickFiles:async()=>selected});await f.enter();
 await f.click('#next-llama-model-browse');assert.equal(f.$('#next-llama-model-file').value,'');
 selected=['C:\\Models\\wrong.txt'];await f.click('#next-llama-model-browse');assert.match(f.$('#next-llama-default-feedback').textContent,/one GGUF/);assert.equal(f.writes().length,0);
});
test('duplicate clicks are singleflight and navigation after save prevents a new load',async t=>{
 const g=gate();const f=fixture(t,{hook:c=>c.method==='POST'&&c.route.endsWith('/config')?g.promise:undefined});await f.enter();
 await f.input('#next-llama-model-file','C:\\Models\\new.gguf');
 const pending=f.click('#next-llama-model-start');await tick();await f.click('#next-llama-model-start');
 assert.equal(f.writes().length,1);f.panel.leave();
 g.resolve({revision:3,settings:DEFAULT_LLAMA_CPP_SETTINGS});await pending;
 assert.equal(f.writes().length,1);assert.equal(f.changed,0);
});
test('save conflict never loads; load failure is retryable and preserves saved model',async t=>{
 let fail='save';const f=fixture(t,{hook:c=>c.method==='POST'&&(fail==='save'||c.route.endsWith('/load'))?Promise.reject(Error(fail==='save'?'changed elsewhere':'not enough memory')):undefined});await f.enter();
 await f.input('#next-llama-model-file','C:\\Models\\new.gguf');await f.click('#next-llama-model-start');
 assert.equal(f.writes().length,1);assert.match(f.$('#next-llama-default-feedback').textContent,/changed elsewhere/);
 fail='load';await f.click('#next-llama-model-start');
 assert.match(f.$('#next-llama-default-feedback').textContent,/saved; loading failed.*not enough memory/);
 assert.equal(f.$('#next-llama-model-start').disabled,false);
});
test('duplicate alias cannot overwrite another file and reset retains model mappings',async t=>{
 const f=fixture(t);await f.enter();await f.input('#next-llama-model-file','C:\\Models\\other.gguf');await f.input('#next-llama-model-name','existing');
 await f.click('#next-llama-model-start');assert.equal(f.writes().length,0);assert.match(f.$('#next-llama-default-feedback').textContent,/already points/);
 await f.click('#next-llama-default-reset');await f.click('#next-llama-default-save');
 assert.deepEqual(f.writes()[0].body.settings.modelPaths,{existing:'C:\\Models\\existing.gguf'});
});
test('runtime status is exposed on config GET and POST; remote never probes runtime',async()=>{
 let probes=0;const manager={llamaConfig:()=>({revision:0}),llamaProcessStatus:()=>({}),llamaPreview:()=>null,llamaRuntimeStatus:async()=>{probes++;return {source:'bundled',backend:'CPU'};},configureLlama:async()=>({revision:1})};
 const base={manager,pathname:'/api/local-models/config',method:'GET'};
 assert.equal((await localModelHTTP({...base,remote:true})).status,403);assert.equal(probes,0);
 assert.equal((await localModelHTTP(base)).body.runtime.backend,'CPU');
 assert.equal((await localModelHTTP({...base,method:'POST',value:{expectedRevision:0,settings:{}}})).body.runtime.source,'bundled');assert.equal(probes,2);
});

test('late picker after leaving never changes model selection',async t=>{
 const g=gate(),f=fixture(t,{pickFiles:()=>g.promise});await f.enter();
 const pending=f.click('#next-llama-model-browse');await tick();f.panel.leave();g.resolve(['C:\\Models\\late.gguf']);await pending;
 assert.equal(f.$('#next-llama-model-file').value,'');assert.equal(f.writes().length,0);
});
test('unavailable/custom runtime status is honest and advanced settings remain editable',async t=>{
 const f=fixture(t,{hook:c=>c.method==='GET'?{revision:1,settings:DEFAULT_LLAMA_CPP_SETTINGS,recommended:DEFAULT_LLAMA_CPP_SETTINGS,runtime:{available:false,source:'unavailable',message:'This platform has no bundled runtime.'}}:undefined});
 await f.enter();assert.match(f.$('#next-llama-runtime-status').textContent,/Runtime unavailable.*no bundled/);
 assert.equal(f.$('#next-llama-default-save').disabled,false);
});

test('conflict Refresh advances revision without losing draft or concurrent model mappings',async t=>{
 let revision=2, settings={...structuredClone(DEFAULT_LLAMA_CPP_SETTINGS),modelPaths:{existing:'C:\\Models\\existing.gguf'}};
 const f=fixture(t,{hook:c=>{
  if(c.route.endsWith('/config')){
   if(c.method==='POST'){if(c.body.expectedRevision!==revision)throw Object.assign(Error('changed elsewhere. Refresh before saving.'),{status:409});settings=c.body.settings;revision++;}
   return {revision,settings:structuredClone(settings),recommended:DEFAULT_LLAMA_CPP_SETTINGS,process:{}};
  }
 }});
 await f.enter();await f.input('#next-llama-default-ctxSize','8192');await f.input('#next-llama-model-file','C:\\Models\\new.gguf');
 revision=3;settings.modelPaths.concurrent='C:\\Models\\concurrent.gguf';
 await f.click('#next-llama-model-start');assert.match(f.$('#next-llama-default-feedback').textContent,/Refresh/);
 assert.equal(f.calls.filter(c=>c.route.endsWith('/load')).length,0);
 await f.click('#next-llama-config-refresh');await tick();
 assert.equal(f.$('#next-llama-default-ctxSize').value,'8192');
 assert.equal(f.$('#next-llama-model-file').value,'C:\\Models\\new.gguf');
 assert.match(f.$('#next-llama-paths').value,/concurrent/);
 await f.click('#next-llama-model-start');
 assert.equal(f.writes().at(-2).body.expectedRevision,3);
 assert.equal(f.writes().at(-2).body.settings.ctxSize,8192);
 assert.equal(f.writes().at(-2).body.settings.modelPaths.concurrent,'C:\\Models\\concurrent.gguf');
 assert.equal(f.calls.filter(c=>c.route.endsWith('/load')).length,1);
});
test('second model save preserves A, loads B, and displays pending restart during safe apply',async t=>{
 let settings={...structuredClone(DEFAULT_LLAMA_CPP_SETTINGS),modelPaths:{}},revision=0,loads=[],owned=false;
 const g=gate();
 const f=fixture(t,{hook:c=>{
  if(c.route.endsWith('/config')){
   if(c.method==='POST'){settings=c.body.settings;revision++;}
   return {revision,settings:structuredClone(settings),recommended:DEFAULT_LLAMA_CPP_SETTINGS,process:{owned,pendingRestart:owned&&loads.length<revision}};
  }
  if(c.route.endsWith('/load')){
   loads.push(c.body.model);owned=true;
   return c.body.model==='B'?g.promise:{model:'A'};
  }
 }});
 await f.enter();await f.input('#next-llama-model-file','C:\\Models\\A.gguf');await f.click('#next-llama-model-start');
 await f.input('#next-llama-model-file','C:\\Models\\B.gguf');await f.input('#next-llama-model-name','B');
 const pending=f.click('#next-llama-model-start');await tick();
 assert.match(f.$('#next-llama-default-feedback').textContent,/idle/);
 assert.deepEqual(settings.modelPaths,{A:'C:\\Models\\A.gguf',B:'C:\\Models\\B.gguf'});
 g.resolve({model:'B'});await pending;assert.deepEqual(loads,['A','B']);assert.match(f.$('#next-llama-default-feedback').textContent,/Loaded B/);
});

test('busy owned router reports saved but deferred and permits retry after active work finishes',async t=>{
 let busy=true;
 const f=fixture(t,{hook:c=>c.route.endsWith('/load')&&busy?Promise.reject(Object.assign(Error('busy'),{code:'LOCAL_LLAMA_RESTART_BUSY',status:409})):undefined});
 await f.enter();await f.input('#next-llama-model-file','C:\\Models\\B.gguf');await f.click('#next-llama-model-start');
 assert.match(f.$('#next-llama-default-feedback').textContent,/saved.*not interrupted.*again/);
 assert.doesNotMatch(f.$('#next-llama-default-feedback').textContent,/loading failed/);
 busy=false;await f.click('#next-llama-model-start');assert.match(f.$('#next-llama-default-feedback').textContent,/Loaded B/);
});
test('edits typed while config refresh is in flight are retained',async t=>{
 const g=gate();let reads=0;
 const f=fixture(t,{hook:c=>c.route.endsWith('/config')&&c.method==='GET'&&++reads===2?g.promise:undefined});await f.enter();
 const pending=f.panel.refresh();await tick();await f.input('#next-llama-default-ctxSize','16384');
 g.resolve({revision:8,settings:DEFAULT_LLAMA_CPP_SETTINGS,recommended:DEFAULT_LLAMA_CPP_SETTINGS});await pending;
 assert.equal(f.$('#next-llama-default-ctxSize').value,'16384');
 await f.click('#next-llama-default-save');assert.equal(f.writes()[0].body.expectedRevision,8);
});

test('model onboarding separates included engine from external model download without side effects',async t=>{
 const f=fixture(t);await f.enter();
 assert.match(f.mount.textContent,/Models are not included with BLACKICE/);
 assert.match(f.$('#next-llama-model-guide').textContent,/Get a model.*permanent folder.*chat model selector/s);
 assert.equal(f.$('#next-llama-model-browse').textContent,'Choose model file');
 const link=f.$('#next-llama-model-catalog');
 assert.equal(link.getAttribute('href'),'https://huggingface.co/ggml-org/collections');
 assert.equal(link.getAttribute('rel'),'noopener noreferrer');
 assert.match(f.mount.textContent,/does not download model files automatically/);
 assert.equal(f.writes().length,0);
});
