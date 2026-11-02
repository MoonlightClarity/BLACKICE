import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkbenchNativeControls} from '../desktop/workbench-native-controls.mjs';
import {WorkbenchConsoleControl} from '../lib/workbench-console-control.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(options={}){
  const control=new WorkbenchConsoleControl(),calls=[],configs=[],features=[];
  let prefs={clipboardEnabled:true,resolutionEnabled:true},time=1000;
  const native={workbenchWindowHwnd:'101',childHwnd:'102',connected:true,inputOwner:'agent',controls:{available:true}};
  control.setTransitionHook(async({owner})=>{native.inputOwner=owner});
  const workbench={consoleControl:control,lastProbe:{vmState:'Running'},
    takeGuestConsoleControl:()=>{calls.push('take');return control.take()},cedeGuestConsoleControl:token=>{calls.push('cede');return control.cede(token)},
    guestNativeConsoleWake:token=>control.run(()=>{calls.push('wake');return {wake:{queued:true}}},token),
    stop:async()=>{calls.push('stop');if(options.stop) return options.stop();workbench.lastProbe.vmState='Off';return {guest:{state:'Off',running:false}}},
    start:async()=>{calls.push('start');workbench.lastProbe.vmState='Running';return {guest:{state:'Running',running:true}}},
    status:async value=>{calls.push('status');assert.deepEqual(value,{fresh:true});return options.status?options.status():{guest:{state:'Off',running:false}}}};
  const controller=new WorkbenchNativeControls({getWorkbench:()=>workbench,getNativeStatus:async()=>({...native}),
    configureNativeControls:async value=>{configs.push({...value});Object.assign(native.controls,value)},getPreferences:()=>({...prefs}),
    setPreferences:value=>{prefs={...value}},applyFeatures:async receipt=>{features.push({receipt,prefs:{...prefs}})},
    openBlackice:async()=>calls.push('open'),afterStart:async()=>{calls.push('attach');native.workbenchWindowHwnd='201'},clock:()=>time});
  let sequence=0;
  const perform=(action,extra={})=>{
    const before=control.status(),root=native.workbenchWindowHwnd;
    const assertInstance=()=>assert.equal(native.workbenchWindowHwnd,root,'stale native root');
    return controller.perform({event:'nativeControl',sequence:++sequence,action,windowHwnd:root,inputOwner:before.owner,...extra},
      {assertInstance,assertCurrent:()=>{assertInstance();assert.deepEqual(control.status(),before,'stale owner revision')}});
  };
  return {controller,control,workbench,native,calls,configs,features,perform,get prefs(){return prefs},advance:ms=>time+=ms};
}
test('native Take and Cede use authoritative receipts without exposing tokens or synthetic extra Take',async()=>{
  const f=fixture();const result=await f.perform('take');assert.equal(result.completed,true);assert.equal('controlToken' in result,false);
  assert.equal(f.control.owner,'user');assert.equal(f.features[0].receipt.owner,'user');
  await f.perform('cede');assert.deepEqual(f.calls,['take','cede']);assert.equal(f.control.owner,'agent');assert.equal(f.features.at(-1).receipt.owner,'agent');
  assert.deepEqual(f.prefs,{clipboardEnabled:true,resolutionEnabled:true});assert.equal(f.configs.at(-1).clipboardEnabled,true);
});
test('native Cede can release a user receipt originally created by the HTTP UI without private token peeking',async()=>{
  const f=fixture();await f.control.take();await f.perform('cede');assert.deepEqual(f.calls,['cede']);assert.equal(f.control.owner,'agent');
});
test('Wake preserves the current owner/revision and Open BLACKICE is only explicit native intent',async()=>{
  const f=fixture();await f.control.take();const before=f.control.status();await f.perform('wake');assert.deepEqual(f.control.status(),before);
  assert.deepEqual(f.calls,['wake']);await f.perform('openBlackice');assert.deepEqual(f.calls,['wake','open']);
});
test('graceful Shutdown has no force fallback and Start reconnects only after Running',async()=>{
  const f=fixture();await f.perform('shutdown');assert.deepEqual(f.calls,['stop']);assert.equal(f.configs.at(-1).powerState,'off');
  await f.perform('start');assert.deepEqual(f.calls,['stop','start','attach']);
  const failed=fixture({stop:async()=>{throw Error('stop failed')}});await assert.rejects(failed.perform('shutdown'));
  assert.deepEqual(failed.calls,['stop']);assert.equal(failed.configs.at(-1).busy,false);
});
test('native sharing preferences persist through Cede while active features are paused',async()=>{
  const f=fixture();await f.perform('take');await f.perform('clipboard',{enabled:false});
  assert.deepEqual(f.prefs,{clipboardEnabled:false,resolutionEnabled:true});await f.perform('cede');await f.perform('take');
  assert.deepEqual(f.features.at(-1).prefs,{clipboardEnabled:false,resolutionEnabled:true});
  assert.equal(f.configs.at(-1).clipboardEnabled,false);assert.equal(f.configs.at(-1).fitEnabled,true);
});
test('agent-owned controls cannot enable user-only sharing and replayed native events never execute twice',async()=>{
  const f=fixture();await assert.rejects(f.perform('fit',{enabled:true}));assert.equal(f.control.owner,'agent');assert.deepEqual(f.calls,[]);
  const event={event:'nativeControl',sequence:77,action:'openBlackice',windowHwnd:'101',inputOwner:'agent'},context={assertCurrent:()=>{},assertInstance:()=>{}};
  await f.controller.perform(event,context);await assert.rejects(f.controller.perform(event,context));assert.deepEqual(f.calls,['open']);
});
test('refresh clears stale helper busy flags even if the desired configuration did not change',async()=>{
  const f=fixture();await f.controller.refresh(f.native);const count=f.configs.length;
  f.native.controls.busy=true;await f.controller.refresh(f.native);assert.equal(f.configs.length,count+1);assert.equal(f.native.controls.busy,false);
});
test('disconnected power status is refreshed without blocking the UI or repeatedly probing while in flight',async()=>{
  let resolve;const held=new Promise(r=>resolve=r),f=fixture({status:()=>held});f.native.connected=false;
  await f.controller.refresh(f.native);await f.controller.refresh(f.native);await tick();assert.equal(f.calls.filter(c=>c==='status').length,1);
  resolve({guest:{state:'Off',running:false}});await f.controller.powerFlight;await tick();assert.equal(f.configs.at(-1).powerState,'off');
  f.advance(1000);await f.controller.refresh(f.native);assert.equal(f.calls.filter(c=>c==='status').length,1);
});

test('native checkbox waits for durable preference save before configuring active features',async()=>{
  const f=fixture();await f.control.take();let resolve;
  const saved=new Promise(r=>resolve=r),original=f.controller.setPreferences;
  f.controller.setPreferences=async value=>{await saved;original(value)};
  const changing=f.perform('clipboard',{enabled:false});await tick();assert.equal(f.features.length,0);
  resolve();await changing;assert.equal(f.features.length,1);assert.equal(f.features[0].prefs.clipboardEnabled,false);
});

test('failed preference save preserves the prior checkbox choice and never applies the new active setting',async()=>{
  const f=fixture();await f.control.take();f.controller.setPreferences=async()=>{throw Error('disk unavailable')};
  await assert.rejects(f.perform('clipboard',{enabled:false}));assert.equal(f.features.length,0);
  assert.equal(f.prefs.clipboardEnabled,true);assert.equal(f.configs.at(-1).clipboardEnabled,true);assert.equal(f.configs.at(-1).busy,false);
});
