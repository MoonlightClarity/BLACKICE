import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createSettingsWorkspace} from '../public/next/workspaces/settings.mjs';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
const until=async read=>{for(let i=0;i<100;i++){if(read())return;await settle();}throw Error('Settings did not settle.');};
const deferred=()=>{let resolve;return {promise:new Promise(done=>{resolve=done;}),resolve:value=>resolve(value)};};
const status=()=>({connected:true,authenticated:true,defaultModelSelection:'fixture::model',models:[
  {id:'fixture::model',displayName:'Fixture',available:true},{id:'native-model',displayName:'Native',available:true}],execution:{activeCount:0}});
async function fixture(t,override){
  const dom=planningDOM(t),calls=[],info=status();
  const runtime={defaultEffort:'medium',defaultServiceTier:'default',providerIdleTimeoutMs:300000,runTimeoutMs:null,subagentsEnabled:false,maxSubagents:3};
  const api=async(route,method='GET',body)=>{
    calls.push({route,method,body});const custom=override?.({route,method,body,runtime,info});
    if(custom!==undefined)return custom;
    if(route==='/api/status')return structuredClone(info);
    if(route==='/api/runtime/settings')return method==='GET'?structuredClone(runtime):{...runtime,...body};
    if(route==='/api/models/default')return {...info,defaultModelSelection:body.model};
    throw Error('Unexpected settings request '+route);
  };
  const workspace=createSettingsWorkspace({mount:dom.mount,api,getStatus:()=>info,events:{subscribe:()=>()=>{}}});
  t.after(()=>workspace.destroy());workspace.enter();await until(()=>dom.$('#next-runtime-idle').value==='5');
  return {...dom,workspace,calls,info,runtime};
}

test('default choices include Automatic/Codex and retain option identity and an unsaved choice through status paints',async t=>{
  const f=await fixture(t),selector=f.$('#next-settings-model');
  assert.deepEqual(selector.children.map(item=>item.value),['default','codex','fixture::model','native-model']);
  assert.equal(selector.value,'fixture::model');
  const option=selector.children.find(item=>item.value==='native-model');selector.value='native-model';await selector.dispatch('change');selector.focus();
  for(let i=0;i<50;i++)f.workspace.updateStatus({...f.info,execution:{activeCount:i}});
  assert.equal(selector.value,'native-model');assert.equal(selector.children.find(item=>item.value==='native-model'),option);
  assert.equal(f.document.activeElement,selector);
  await f.click('#next-settings-save-model');await until(()=>f.$('#next-settings-model-feedback').textContent==='Saved.');
  assert.deepEqual(f.calls.filter(item=>item.route==='/api/models/default').map(item=>item.body),[{model:'native-model'}]);
  assert.equal(f.calls.some(item=>/\/identity|\/providers|\/connections/.test(item.route)),false,'General never fetches inactive panels.');
});

test('unsaved General preferences survive refresh and workspace navigation',async t=>{
  const f=await fixture(t);await f.input('#next-runtime-idle','12');
  f.runtime.providerIdleTimeoutMs=120000;f.workspace.leave();f.workspace.enter();await settle();await settle();
  assert.equal(f.$('#next-runtime-idle').value,'12');
  await f.click('#next-settings-refresh');await settle();
  assert.equal(f.$('#next-runtime-idle').value,'12');
  assert.equal(f.calls.filter(item=>item.method!=='GET').length,0);
});

test('queued independent saves capture intent, prevent duplicate writes and retain newer edits after a delayed receipt',async t=>{
  const gate=deferred();let held=false;
  const f=await fixture(t,({route,method,body,runtime})=>{
    if(route==='/api/runtime/settings'&&method==='POST'){held=true;return gate.promise.then(()=>({...runtime,...body}));}
  });
  await f.input('#next-runtime-idle','10');await f.$('#next-runtime-settings-form').dispatch('submit');
  await f.$('#next-runtime-settings-form').dispatch('submit');await until(()=>held);
  f.$('#next-settings-model').value='native-model';await f.$('#next-settings-model').dispatch('change');
  await f.click('#next-settings-save-model');await f.click('#next-settings-save-model');
  await f.input('#next-runtime-idle','11');gate.resolve();
  await until(()=>f.$('#next-settings-model-feedback').textContent==='Saved.');
  const writes=f.calls.filter(item=>item.method==='POST');assert.equal(writes.length,2);
  assert.equal(writes[0].body.providerIdleTimeoutMs,600000);assert.equal(writes[1].body.model,'native-model');
  assert.equal(Object.hasOwn(writes[0].body,'subagentsEnabled'),false);
  assert.equal(Object.hasOwn(writes[0].body,'maxSubagents'),false);
  assert.equal(f.$('#next-runtime-subagents'),null);assert.equal(f.$('#next-runtime-max-subagents'),null);
  assert.equal(f.$('#next-runtime-idle').value,'11');
});

test('Enter within a General field does not implicitly submit a settings mutation',async t=>{
  const f=await fixture(t),event=await f.$('#next-runtime-idle').dispatch('keydown',{key:'Enter'},true);
  assert.equal(event.defaultPrevented,true);assert.equal(f.calls.filter(item=>item.method!=='GET').length,0);
});

test('a pre-save refresh cannot repaint stale model and runtime values after a successful save',async t=>{
  const gate=deferred();let held=false,capture=false;
  const f=await fixture(t,({route,method,runtime})=>{
    if(capture&&route==='/api/runtime/settings'&&method==='GET'){
      const snapshot=structuredClone(runtime);held=true;return gate.promise.then(()=>snapshot);
    }
  });
  capture=true;await f.click('#next-settings-refresh');await until(()=>held);
  await f.input('#next-runtime-idle','13');await f.$('#next-runtime-settings-form').dispatch('submit');
  await until(()=>f.$('#next-runtime-feedback').textContent==='Saved.');
  const choice=f.$('#next-settings-model');choice.value='native-model';await choice.dispatch('change');
  await f.click('#next-settings-save-model');await until(()=>f.$('#next-settings-model-feedback').textContent==='Saved.');
  gate.resolve();await settle();await settle();
  assert.equal(f.$('#next-runtime-idle').value,'13');assert.equal(choice.value,'native-model');
});

test('a newer runtime event wins over an older HTTP model status while preference reads still finish',async t=>{
  const gate=deferred();let capture=false,held=false;
  const f=await fixture(t,({route,info})=>{
    if(capture&&route==='/api/status'){const snapshot=structuredClone(info);held=true;return gate.promise.then(()=>snapshot);}
  });
  capture=true;await f.click('#next-settings-refresh');await until(()=>held);
  f.workspace.updateStatus({...f.info,defaultModelSelection:'codex'});gate.resolve();await settle();await settle();
  assert.equal(f.$('#next-settings-model').value,'codex');assert.equal(f.$('#next-runtime-idle').value,'5');
});

test('the app factory null status cannot revoke General’s own initial model discovery',async t=>{
  const dom=planningDOM(t),gate=deferred();
  const workspace=createSettingsWorkspace({mount:dom.mount,getStatus:()=>null,
    api:async route=>route==='/api/status'?gate.promise:{},events:{subscribe:()=>()=>{}}});
  t.after(()=>workspace.destroy());workspace.enter();
  for(const value of [null,undefined,[],false])workspace.updateStatus(value);
  gate.resolve(status());await until(()=>dom.$('#next-settings-model').value==='fixture::model');
  assert.deepEqual(dom.$('#next-settings-model').children.map(option=>option.value),['default','codex','fixture::model','native-model']);
});

test('retired Mistral account setup is absent and opening its old destination preserves the draft',async t=>{
  const f=await fixture(t);
  const selector=f.$('#next-settings-model');
  selector.value='native-model';await selector.dispatch('change');
  await f.input('#next-runtime-idle','13');
  await f.workspace.openModelProvider('mistral-vibe');
  await f.$('.next-model-picker-trigger').dispatch('click',{},true);
  assert.equal(f.document.querySelector('[data-model-setup-provider="mistral-vibe"]'),null);
  assert.equal(f.$('#next-settings-section-general').getAttribute('aria-selected'),'true');
  assert.equal(selector.value,'native-model');assert.equal(f.$('#next-runtime-idle').value,'13');
  assert.equal(f.calls.some(call=>call.route.includes('/subscriptions/mistral-vibe')),false);
});

test('settings never expose or read the deprecated execution cap',async t=>{
  const f=await fixture(t);
  for(const id of ['next-execution-limit','next-execution-form','next-execution-legacy','next-execution-remove'])assert.equal(f.$('#'+id),null);
  f.workspace.leave();f.workspace.enter();await settle();await f.click('#next-settings-refresh');await settle();
  assert.equal(f.calls.some(x=>x.route==='/api/execution/settings'),false);
  assert.equal(f.calls.some(x=>x.method==='POST'),false);
});
