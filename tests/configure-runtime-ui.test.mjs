import test from 'node:test';
import assert from 'node:assert/strict';
import { initConfigureUI,renderConfigureView,runTimeSettingsFromDraft } from '../public/configure-ui.mjs';

const settings=()=>({codexHistory:'relay',runTimeoutMs:null,providerIdleTimeoutMs:300000});
const snapshot=()=>({status:{runtimeSettings:settings()},workflow:null,workflows:[]});
class Mount{
  constructor(){this.markup='';this.writes=0;this.focuses=[];this.handlers=new Map();this.classList={add(){},remove(){}};}
  get innerHTML(){return this.markup;}set innerHTML(value){this.markup=value;this.writes++;}
  addEventListener(type,handler){this.handlers.set(type,handler);}removeEventListener(type){this.handlers.delete(type);}
  contains(target){return target?.attached!==false;}querySelector(selector){return{focus:options=>this.focuses.push({selector,options}),setSelectionRange(){}};}
  event(type,target){return this.handlers.get(type)?.({target,preventDefault(){}});}
  click(action){return this.event('click',{dataset:{configure:action},closest(){return this;}});}
}
const toggle=(mount,open=true,attached=true)=>mount.event('toggle',{dataset:{configureSection:'preferences'},open,attached});
const choice=(mount,key,field,value)=>mount.event(field==='amount'?'input':'change',{dataset:{configureRuntime:field,configureRuntimeKey:key},value});
const submit=mount=>mount.event('submit',{id:'configure-runtime-editor'});

test('time settings accept exact milliseconds and large user durations without an artificial time ceiling',()=>{
  assert.deepEqual(runTimeSettingsFromDraft('unlimited','','minutes'),{runTimeoutMs:null});
  for(const [amount,unit,expected]of [['0.001','seconds',1],['1.5','minutes',90000],['0.00001','days',864],['35','days',3024000000],['9007199254740.991','seconds',Number.MAX_SAFE_INTEGER]])assert.deepEqual(runTimeSettingsFromDraft('limit',amount,unit),{runTimeoutMs:expected});
  for(const [amount,unit]of [['','minutes'],['-1','minutes'],['1e3','seconds'],['NaN','hours'],['1','weeks'],['0','seconds'],['0.0001','seconds'],['9007199254740.992','seconds']])assert.throws(()=>runTimeSettingsFromDraft('limit',amount,unit));
});

test('oversized pasted digits are rejected before arbitrary-precision arithmetic while insignificant zeros stay exact',()=>{
  const oversized='1'.repeat(100000);
  assert.throws(()=>runTimeSettingsFromDraft('limit',oversized,'seconds'),/largest exact number/);
  assert.throws(()=>runTimeSettingsFromDraft('limit',`0.${oversized}`,'seconds'),/largest exact number/);
  assert.deepEqual(runTimeSettingsFromDraft('limit',`${'0'.repeat(100000)}1.${'0'.repeat(100000)}`,'seconds'),{runTimeoutMs:1000});
  assert.throws(()=>runTimeSettingsFromDraft('limit','1','toString'),/positive duration/);
});

test('run limits remain in the clearly labeled collapsed section and accurately describe per-agent and API activity semantics',()=>{
  const html=renderConfigureView(snapshot());assert.match(html,/data-configure-section="preferences"><summary>Advanced preferences<span>Time limits &amp; history/);assert.match(html,/Agent time limit/);assert.match(html,/Maximum time for each agent response, with any provider/);assert.match(html,/API inactivity timeout/);assert.match(html,/Streamed heartbeats count as activity/);assert.match(html,/Active work keeps its saved limits/);assert.match(html,/value="5"/);assert.doesNotMatch(html,/data-configure-runtime[^>]*\smax=/);
  const oneMillisecond=snapshot();oneMillisecond.status.runtimeSettings.runTimeoutMs=1;assert.match(renderConfigureView(oneMillisecond),/value="0.001"/);
  const missing=renderConfigureView(snapshot(),{},{runtime:false,history:false});assert.doesNotMatch(missing,/Run limits|API inactivity/);
});

test('optional time settings load on demand and save only changed duration fields, preserving Codex history',async()=>{
  const mount=new Mount(),calls=[],saved=[];let stored=settings();
  const ui=initConfigureUI({mount,getSnapshot:snapshot,api:async(url,method,body)=>{calls.push({url,method,body});if(method)stored={...stored,...body};return stored;},onRuntimeSettings:value=>saved.push(value)});
  assert.equal(calls.length,0);await toggle(mount);assert.equal(calls.length,1);
  await choice(mount,'runTimeoutMs','mode','limit');await choice(mount,'runTimeoutMs','amount','3');await choice(mount,'runTimeoutMs','unit','days');await submit(mount);
  assert.deepEqual(calls.at(-1),{url:'/api/runtime/settings',method:'POST',body:{runTimeoutMs:259200000}});assert.equal(saved[0].codexHistory,'relay');assert.equal(saved[0].providerIdleTimeoutMs,300000);assert.match(mount.innerHTML,/Saved for the next response/);
  await choice(mount,'providerIdleTimeoutMs','mode','unlimited');await submit(mount);assert.deepEqual(calls.at(-1).body,{providerIdleTimeoutMs:null});assert.equal(stored.runTimeoutMs,259200000);
  await choice(mount,'runTimeoutMs','mode','unlimited');await choice(mount,'providerIdleTimeoutMs','mode','limit');await choice(mount,'providerIdleTimeoutMs','amount','0.001');await choice(mount,'providerIdleTimeoutMs','unit','seconds');await submit(mount);assert.deepEqual(calls.at(-1).body,{runTimeoutMs:null,providerIdleTimeoutMs:1});ui.destroy();
});

test('unsaved limits survive polling, close/reopen, workflow navigation and rejected saves',async()=>{
  const mount=new Mount(),current=snapshot(),calls=[];let fail=true;
  const ui=initConfigureUI({mount,getSnapshot:()=>current,api:async(url,method,body)=>{calls.push({url,method,body});if(method&&fail)throw new Error('Could not save <limits>.');return{...settings(),...body};}});
  await toggle(mount);await choice(mount,'runTimeoutMs','mode','limit');await choice(mount,'runTimeoutMs','amount','7');const before=mount.writes;current.status.version='Background change';ui.update();assert.equal(mount.writes,before);
  await toggle(mount,false);await toggle(mount,true);assert.equal(calls.length,1,'reopening must not discard an unsaved draft');await ui.showRunLimits();assert.equal(calls.length,1);
  ui.showWorkflows();ui.showBasics();await submit(mount);assert.match(mount.innerHTML,/Could not save &lt;limits&gt;/);assert.match(mount.innerHTML,/value="7"/);assert.doesNotMatch(mount.innerHTML,/Saved for the next response/);assert.doesNotMatch(mount.innerHTML,/data-configure="runtime-reload"/);
  fail=false;await submit(mount);assert.equal(calls.at(-1).body.runTimeoutMs,420000);ui.destroy();
});

test('loading and saving limits are exclusive and delayed replies cannot revive a destroyed view',async()=>{
  const mount=new Mount(),calls=[],saved=[];let read,write;
  const ui=initConfigureUI({mount,getSnapshot:snapshot,api:(url,method,body)=>{calls.push({url,method,body});return new Promise(resolve=>{if(method)write=resolve;else read=resolve;});},onRuntimeSettings:value=>saved.push(value)});
  const loading=toggle(mount);await toggle(mount);await choice(mount,'runTimeoutMs','mode','limit');await submit(mount);assert.equal(calls.length,1);read(settings());await loading;
  await choice(mount,'runTimeoutMs','mode','limit');await choice(mount,'runTimeoutMs','amount','2');const saving=submit(mount);await submit(mount);await choice(mount,'runTimeoutMs','amount','99');assert.equal(calls.length,2);assert.deepEqual(calls.at(-1).body,{runTimeoutMs:120000});ui.destroy();write({...settings(),runTimeoutMs:120000});await saving;assert.equal(mount.innerHTML,'');assert.deepEqual(saved,[]);
});

test('invalid API settings fail visibly and a real reload can recover without assuming unlimited',async()=>{
  const mount=new Mount();let response={...settings(),runTimeoutMs:'unlimited'};
  const ui=initConfigureUI({mount,getSnapshot:snapshot,api:async()=>response});await toggle(mount);assert.match(mount.innerHTML,/invalid run limits/);assert.match(mount.innerHTML,/Reload settings/);
  response={...settings(),runTimeoutMs:1,providerIdleTimeoutMs:null};await mount.click('runtime-reload');assert.doesNotMatch(mount.innerHTML,/invalid run limits/);assert.match(mount.innerHTML,/value="0.001"/);ui.destroy();
});

test('history and duration drafts remain independent across full runtime responses',async()=>{
  const mount=new Mount(),calls=[];let stored=settings();
  const ui=initConfigureUI({mount,getSnapshot:snapshot,api:async(url,method,body)=>{calls.push({url,method,body});if(method)stored={...stored,...body};return stored;}});
  await toggle(mount);await choice(mount,'runTimeoutMs','mode','limit');await choice(mount,'runTimeoutMs','amount','11');await mount.event('toggle',{dataset:{configureSection:'history'},open:true});await mount.event('change',{dataset:{configureHistory:'codexHistory'},value:'codex'});await mount.event('submit',{id:'configure-history-editor'});
  assert.deepEqual(calls.at(-1).body,{codexHistory:'codex'});assert.match(mount.innerHTML,/value="11"/);await submit(mount);assert.deepEqual(calls.at(-1).body,{runTimeoutMs:660000});assert.match(mount.innerHTML,/option value="codex" selected/);ui.destroy();
});

test('direct Run limits route opens Advanced without a late response stealing focus or a detached toggle reloading it',async()=>{
  const mount=new Mount();let read,calls=0;const ui=initConfigureUI({mount,getSnapshot:snapshot,api:()=>{calls++;return new Promise(resolve=>{read=resolve;});}});
  const opening=ui.showRunLimits();assert.match(mount.innerHTML,/data-configure-section="preferences" open/);assert.equal(mount.focuses.at(-1).selector,'#configure-run-limits');const focused=mount.focuses.length;
  await toggle(mount,false,false);await toggle(mount);assert.equal(calls,1);ui.showWorkflows();read(settings());await opening;assert.equal(mount.focuses.length,focused,'a delayed GET must not focus a different screen');assert.doesNotMatch(mount.innerHTML,/Run limits/);ui.destroy();
});

test('focused limits retain DOM ownership during status refreshes before the first keystroke',async t=>{
  const previous={present:Object.hasOwn(globalThis,'document'),value:globalThis.document};t.after(()=>{if(previous.present)globalThis.document=previous.value;else delete globalThis.document;});
  const mount=new Mount(),current=snapshot(),ui=initConfigureUI({mount,getSnapshot:()=>current,api:async()=>settings()});await toggle(mount);
  const active={attached:true,closest:selector=>selector.includes('#configure-runtime-editor')?{}:null};globalThis.document={activeElement:active};const before=mount.writes;current.status.version='2.16';ui.update();assert.equal(mount.writes,before);assert.strictEqual(globalThis.document.activeElement,active);globalThis.document.activeElement=null;ui.update();assert.equal(mount.writes,before+1);ui.destroy();
});
