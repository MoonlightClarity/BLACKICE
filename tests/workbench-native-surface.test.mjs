import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkbenchNativeSurface} from '../desktop/workbench-native-surface.mjs';
import {WorkbenchConsoleControl} from '../lib/workbench-console-control.mjs';

const bounds={x:0,y:0,width:800,height:600};
const build={accepted:true,helperSha256:'a'.repeat(64),runtimeManifestSha256:'b'.repeat(64)};
const identity={version:1,readyForBoundedProbe:true,vmName:'Fixture VM',vmState:'Running',host:'127.0.0.1',port:2179,
  listenerOwnedByVmms:true,vmId:'11111111-2222-4333-8444-555555555555',certificateSha256:'c'.repeat(64),
  certificates:[{sha256:'c'.repeat(64),source:'local-vmms-service-certificate-store',notAfter:'2099-01-01T00:00:00Z'}]};
const ready={connected:true,displayReady:true,certificateVerified:true,selectedProtocol:2,decodedFrames:3,
  surface:{width:1024,height:768},perMonitorV2:true,inputOwner:'agent'};
const frame=()=>{const bytes=Buffer.alloc(54+1024*768*4);bytes.write('BM');bytes.writeUInt32LE(40,14);bytes.writeInt32LE(1024,18);
  bytes.writeInt32LE(-768,22);bytes.writeUInt16LE(32,28);return {bytes,width:1024,height:768,sequence:3}};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(options={}){
  const instances=[],events=[];
  class Host{
    constructor(options){instances.push(this);this.options=options;this.prepared=false;this.last={displayReady:false};this.closed=false;}
    async prepare(){events.push('prepare');if(options.prepare)await options.prepare();this.prepared=true;return {prepared:true,perMonitorV2:true,windowCloseRevision:0}}
    async connect(value){events.push('connect');this.identity=value;if(options.connect)await options.connect();this.last={...ready,...(options.detachedWindow?{detached:true,windowCloseRevision:options.closedDuringConnect?1:0,windowVisible:false}:{} )};return this.last}
    async status(){return {...this.last}}
    async position(){events.push('bounds');return {...this.last}}
    async inputOwner(owner){events.push('owner:'+owner);if(options.owner)await options.owner(owner);this.last={...this.last,inputOwner:owner};return {...this.last}}
    async visible(visible){events.push('visible:'+visible);if(options.visible)await options.visible(visible);this.last={...this.last,visible,...(options.detachedWindow?{windowVisible:visible}:{})};return {...this.last}}
    async agentInput(input){events.push('input');return input}
    async wakeDisplay(owner){events.push('wake:'+owner);if(options.wake)await options.wake();return {...this.last,wake:{requested:true,queued:true,desktopAwakeConfirmed:false}}}
    async capture(){events.push('capture');if(options.capture)return options.capture();return frame()}
    cleanupReceipt(){return this.cleanup;}
    async close(){events.push('close');this.closed=true;this.last={displayReady:false};this.cleanup=options.cleanup??{confirmed:true,exited:true,started:true,forced:false,exitCode:0,signal:null};return {closed:true,cleanup:this.cleanup}}
  }
  const consoleControl=new WorkbenchConsoleControl();
  const workbench={config:{vmName:'Fixture VM'},consoleControl,
    setGuestConsoleOwnershipHook:hook=>consoleControl.setTransitionHook(hook),
    setGuestNativeConsoleAdapter:adapter=>consoleControl.serialize(()=>{workbench.adapter=adapter})};
  const facade=new WorkbenchNativeSurface({platform:'win32',getWorkbench:()=>workbench,resolveRuntime:options.resolveRuntime??(async()=>({...build})),
    preflight:options.preflight??(async()=>structuredClone(identity)),Host,...options});
  await facade.bindWorkbench();return {facade,instances,events,workbench};
}
test('failed connection status survives cleanup and only an explicit later attachment starts a fresh helper',async()=>{
  let attempts=0;const f=await fixture({getWindow:()=>({isDestroyed:()=>false}),connect:async()=>{if(++attempts===1)throw Object.assign(Error('Connection ended.'),{code:'CONNECT_FAILED',nativeAcknowledged:true,nativeDiagnostics:{coreError:131077,decodedFrames:0,password:'private'}});}});
  await assert.rejects(f.facade.perform({action:'attach',bounds}),error=>{assert.equal(error.nativeConnectionAttempt.code,'CONNECT_FAILED');assert.equal(error.nativeConnectionAttempt.cleanup.confirmed,true);assert.equal(error.nativeConnectionAttempt.explicitRetryAllowed,true);assert.equal(JSON.stringify(error.nativeConnectionAttempt).includes('private'),false);return true;});
  const status=await f.facade.viewerAvailability();assert.equal(status.lastConnectionAttempt.code,'CONNECT_FAILED');assert.equal(status.lastConnectionAttempt.retryLimitEnforced,false);assert.equal(status.openAvailable,true);assert.equal(status.displayReady,false);assert.equal(f.instances.length,1);
  await f.facade.viewerAvailability();assert.equal(f.instances.length,1,'Status never reconnects.');
  await f.facade.perform({action:'attach',bounds});assert.equal(f.instances.length,2);assert.equal((await f.facade.viewerAvailability()).lastConnectionAttempt.status,'connected');
});
test('unconfirmed helper retirement blocks replacements until an actual late exit is observed',async()=>{
  const cleanup={confirmed:false,exited:false,started:true,forced:true,exitCode:null,signal:null};let attempts=0;
  const f=await fixture({getWindow:()=>({isDestroyed:()=>false}),cleanup,connect:async()=>{if(++attempts===1)throw Object.assign(Error('Connection ended.'),{code:'CONNECT_FAILED',nativeAcknowledged:true});}});
  await assert.rejects(f.facade.perform({action:'attach',bounds}),{code:'CONNECT_FAILED'});
  const status=await f.facade.viewerAvailability();assert.equal(status.openAvailable,false);assert.equal(status.uncertain,true);assert.equal(status.lastConnectionAttempt.cleanup.confirmed,false);assert.equal(status.lastConnectionAttempt.explicitRetryAllowed,false);
  await assert.rejects(f.facade.perform({action:'attach',bounds}),{code:'WORKBENCH_NATIVE_UNCERTAIN'});await assert.rejects(f.facade.close(),{code:'WORKBENCH_NATIVE_UNCERTAIN'});assert.equal(f.instances.length,1);
  Object.assign(cleanup,{confirmed:true,exited:true,exitCode:7});
  const retired=await f.facade.viewerAvailability();assert.equal(retired.lastConnectionAttempt.cleanup.confirmed,true);assert.equal(retired.openAvailable,true);assert.equal(retired.lastConnectionAttempt.explicitRetryAllowed,true);assert.equal(f.instances.length,1);
  await f.facade.perform({action:'attach',bounds});assert.equal(f.instances.length,2);
});
test('verified native attachment preserves server ownership and deliberate native API uses the same owner fence',async()=>{
  const scaleFactor=()=>1.25,contentScaleFactor=()=>0.5;
  const f=await fixture({scaleFactor,contentScaleFactor});assert.equal((await f.facade.capability()).available,true);
  const result=await f.facade.perform({action:'attach',bounds});assert.equal(result.displayReady,true);assert.equal(result.localPreview,true);
  assert.equal(f.workbench.consoleControl.status().owner,'agent');
  assert.equal(f.instances[0].options.scaleFactor,scaleFactor);assert.equal(f.instances[0].options.contentScaleFactor,contentScaleFactor);
  assert.deepEqual(f.events,['prepare','connect','owner:agent','visible:true']);
  const user=await f.workbench.consoleControl.take();assert.equal(f.instances[0].last.inputOwner,'user');
  await assert.rejects(f.workbench.consoleControl.run(check=>f.workbench.adapter.input({kind:'key',scanCode:30,flags:0},check)),{code:'WORKBENCH_CONTROL_HELD_BY_USER'});
  await assert.rejects(f.facade.perform({action:'input',enabled:false}),{code:'WORKBENCH_NATIVE_OWNER_SERVER'});
  await f.workbench.consoleControl.cede(user.controlToken);
  assert.deepEqual(await f.workbench.consoleControl.run(check=>f.workbench.adapter.input({kind:'key',scanCode:30,flags:0},check)),{kind:'key',scanCode:30,flags:0});
  await f.facade.transitionOwner({owner:'none'});assert.equal(f.instances[0].closed,true);assert.equal(f.facade.native,null);
});
test('pending acceptance and untrusted VM identities cannot launch a helper',async()=>{
  const pending=await fixture({resolveRuntime:async()=>({...build,accepted:false})});
  assert.equal((await pending.facade.capability()).available,false);
  await assert.rejects(pending.facade.perform({action:'attach',bounds}),{code:'WORKBENCH_NATIVE_ACCEPTANCE_PENDING'});
  assert.equal(pending.instances.length,0);
  for(const changed of [{vmName:'Other VM'},{listenerOwnedByVmms:false},{certificateSha256:'d'.repeat(64)},{vmState:'Off'}]){
    const f=await fixture({preflight:async()=>({...identity,...changed})});
    await assert.rejects(f.facade.perform({action:'attach',bounds}),{code:'WORKBENCH_NATIVE_PREFLIGHT'});assert.equal(f.instances.length,0);
  }
});
test('ownership transition waits native acknowledgement and a failure closes before owner:none receipt',async()=>{
  let pending=null,wrong=false;
  const f=await fixture({owner:async owner=>{if(pending)await pending.promise;if(wrong)throw Error('release failed')}});
  await f.facade.perform({action:'attach',bounds});pending=deferred();
  const taking=f.workbench.consoleControl.take();await tick();assert.equal(f.workbench.consoleControl.status().owner,'agent');
  pending.resolve();const receipt=await taking;assert.equal(receipt.owner,'user');
  pending=null;wrong=true;await assert.rejects(f.workbench.consoleControl.cede(receipt.controlToken),{code:'WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE'});
  assert.equal(f.workbench.consoleControl.status().owner,'none');assert.equal(f.instances[0].closed,true);assert.equal(f.facade.native,null);
});
test('close or hide during build/preflight verification prevents later helper creation',async()=>{
  for(const stage of ['resolve','preflight'])for(const action of ['close','hide','destroy']){
    const wait=deferred(),entered=deferred();
    const f=await fixture(stage==='resolve'?{resolveRuntime:async()=>{entered.resolve();await wait.promise;return build}}:
      {preflight:async()=>{entered.resolve();await wait.promise;return identity}});
    const attaching=f.facade.perform({action:'attach',bounds});const rejected=assert.rejects(attaching,{code:'WORKBENCH_NATIVE_CANCELLED'});
    await entered.promise;await f.facade[action]();wait.resolve();await rejected;
    assert.equal(f.instances.length,0,stage+' '+action);
    if(action==='destroy'){await assert.rejects(f.facade.perform({action:'attach',bounds}),{code:'WORKBENCH_NATIVE_CANCELLED'});assert.equal((await f.facade.capability()).available,false)}
  }
});
test('hide or close during native preparation/connect retires the helper without a late visible child',async()=>{
  for(const stage of ['prepare','connect'])for(const action of ['close','hide']){
    const wait=deferred(),entered=deferred();const f=await fixture({[stage]:async()=>{entered.resolve();await wait.promise}});
    const attaching=f.facade.perform({action:'attach',bounds}),rejected=assert.rejects(attaching,{code:'WORKBENCH_NATIVE_CANCELLED'});
    await entered.promise;await f.facade[action]();wait.resolve();await rejected;
    assert.equal(f.instances[0].closed,true);assert.equal(f.facade.native,null);assert.equal(f.events.includes('visible:true'),false);
  }
});
test('hide cancels in-flight show and an explicit later attachment reuses a ready hidden session',async()=>{
  let wait=null,entered=null;const f=await fixture({visible:async visible=>{if(visible&&wait){entered.resolve();await wait.promise}}});
  await f.facade.perform({action:'attach',bounds});await f.facade.hide();
  assert.equal(f.instances.length,1);assert.equal(f.instances[0].last.visible,false);
  wait=deferred();entered=deferred();const showing=f.facade.perform({action:'visible',visible:true});const rejected=assert.rejects(showing,{code:'WORKBENCH_NATIVE_CANCELLED'});
  await entered.promise;const hiding=f.facade.hide();wait.resolve();await Promise.all([hiding,rejected]);
  // Real Host serializes the two native visibility receipts in send order.
  assert.equal(f.events.at(-1),'visible:false');
  wait=null;const result=await f.facade.perform({action:'attach',bounds});assert.equal(result.displayReady,true);assert.equal(result.shown,true);assert.equal(f.instances.length,1);
  await f.facade.close();
});
test('explicit native frame preserves dimensions and refuses a retired session during capture',async()=>{
  const f=await fixture();await f.facade.perform({action:'attach',bounds});
  const result=await f.workbench.adapter.frame();assert.equal(result.contentType,'image/bmp');
  assert.equal(result.width,1024);assert.equal(result.height,768);assert.equal(result.sequence,3);assert.equal(result.bytes.length,54+1024*768*4);
  await f.facade.close();
  const wait=deferred(),entered=deferred(),g=await fixture({capture:async()=>{entered.resolve();await wait.promise;return frame()}});
  await g.facade.perform({action:'attach',bounds});
  const capturing=g.workbench.adapter.frame(),rejected=assert.rejects(capturing,{code:'WORKBENCH_NATIVE_NOT_ATTACHED'});
  await entered.promise;await g.facade.close();wait.resolve();await rejected;
  await assert.rejects(g.workbench.adapter.frame(),{code:'WORKBENCH_NATIVE_NOT_ATTACHED'});
});

test('capture age and helper health attach only to the exact captured sequence and timestamp',async()=>{
  const h={available:true,sequence:3,dark:true,classification:'dark',sampledPixels:256,blackFraction:1,distinctColors:1,frameAgeMs:99,meaning:'decoded-display-sample-not-vm-power-state'};
  for(const mode of ['matched','sequence','timestamp','dimensions','health-sequence','cached','uncertain']){
    let f;f=await fixture({capture:async()=>{
      const current=f.instances[0].last;
      if(mode==='sequence')current.surface={...current.surface,sequence:4};
      if(mode==='timestamp')current.surface={...current.surface,frameAtMonotonicMs:101};
      if(mode==='dimensions')current.surface={...current.surface,width:800};
      if(mode==='health-sequence')current.frameHealth={...h,sequence:4};
      if(mode==='cached')current.cached=true;
      if(mode==='uncertain')current.uncertain=true;
      return {...frame(),frameAtMonotonicMs:100};
    }});await f.facade.perform({action:'attach',bounds});
    f.instances[0].last={...f.instances[0].last,surface:{width:1024,height:768,sequence:3,frameAtMonotonicMs:100},frameHealth:h};
    const result=await f.workbench.adapter.frame();assert.equal(result.sequence,3);assert.equal(result.nativeHealth!==undefined,mode==='matched',mode);
    if(mode==='matched')assert.deepEqual(result.nativeHealth,h);await f.facade.close();
  }
});
test('explicit display wake uses current server ownership and its revision fence without Take or Cede',async()=>{
  const f=await fixture();await f.facade.perform({action:'attach',bounds});
  const wake=owner=>f.workbench.consoleControl.run(check=>f.workbench.adapter.wake({owner},check),owner==='user'?f.workbench.consoleControl.token:undefined);
  assert.equal((await wake('agent')).wake.queued,true);assert.equal(f.workbench.consoleControl.status().owner,'agent');
  const receipt=await f.workbench.consoleControl.take();assert.equal((await wake('user')).inputOwner,'user');
  assert.equal(f.workbench.consoleControl.status().revision,receipt.revision);
  await assert.rejects(f.workbench.consoleControl.run(check=>f.workbench.adapter.wake({owner:'agent'},check)),{code:'WORKBENCH_CONTROL_HELD_BY_USER'});
  await f.facade.close();
});
test('detached surface reopens the same session and keeps hidden capture/input available with unchanged ownership',async()=>{
  const f=await fixture({detachedWindow:true});const attached=await f.facade.perform({action:'attach'});
  assert.equal(attached.detached,true);assert.equal(attached.shown,true);assert.equal(f.instances[0].options.detachedWindow,true);
  f.instances[0].last={...f.instances[0].last,visible:false,windowVisible:false,windowCloseRevision:1};
  const hidden=await f.facade.status();assert.equal(hidden.displayReady,true);assert.equal(hidden.shown,false);
  assert.equal((await f.workbench.adapter.frame()).width,1024);
  await f.workbench.consoleControl.run(check=>f.workbench.adapter.input({kind:'mouse',x:4,y:5,flags:0x800},check));
  const reopened=await f.facade.perform({action:'attach'});assert.equal(reopened.shown,true);assert.equal(f.instances.length,1);
  assert.equal(f.workbench.consoleControl.status().owner,'agent');await f.facade.close();
});
test('a detached window closed by the user while connection was pending stays hidden when it completes',async()=>{
  const f=await fixture({detachedWindow:true,closedDuringConnect:true});
  const attached=await f.facade.perform({action:'attach'});assert.equal(attached.displayReady,true);assert.equal(attached.shown,false);
  assert.equal(f.events.includes('visible:true'),false);assert.equal(f.instances[0].closed,false);
  assert.equal((await f.workbench.adapter.frame()).width,1024);await f.facade.close();
});

test('explicit Open retires a verified disconnected session and reconnects without changing its user owner',async()=>{
  let discoveries=0;
  const f=await fixture({detachedWindow:true,preflight:async()=>{discoveries++;return identity}});
  await f.facade.perform({action:'attach'});const user=await f.workbench.consoleControl.take(),old=f.instances[0];
  old.last={...old.last,connected:false,displayReady:false,uncertain:false};
  const inspected=await f.facade.status();assert.equal(inspected.connected,false);assert.equal(f.instances.length,1);
  const reopened=await f.facade.perform({action:'attach'});
  assert.equal(old.closed,true);assert.equal(f.instances.length,2);assert.equal(discoveries,2);
  assert.equal(reopened.displayReady,true);assert.equal(reopened.inputOwner,'user');
  assert.deepEqual(f.workbench.consoleControl.status(),{owner:'user',revision:user.revision});
  assert.ok(f.events.indexOf('close')<f.events.lastIndexOf('prepare'));await f.facade.close();
});

test('explicit Open never retries an uncertain, missing-certainty, or failed session inspection',async()=>{
  for(const state of [
    {connected:false,displayReady:false,uncertain:true},
    {connected:false,displayReady:false},
    {connected:true,displayReady:false,uncertain:false},
    null,
  ]){
    const f=await fixture({detachedWindow:true});await f.facade.perform({action:'attach'});const old=f.instances[0];
    if(state)old.last={...ready,...state};else old.status=async()=>{throw Error('inspection timed out')};
    await assert.rejects(f.facade.perform({action:'attach'}),state?{code:'WORKBENCH_NATIVE_UNCERTAIN'}:/inspection timed out/);
    assert.equal(f.instances.length,1);assert.equal(old.closed,false);assert.equal(f.events.filter(e=>e==='connect').length,1);
    await f.facade.close();
  }
});

test('an isolated hidden lifecycle probe never shows initial or reused detached sessions',async()=>{
  const f=await fixture({detachedWindow:true,allowUnacceptedProbe:true,showOnAttach:false});
  const first=await f.facade.perform({action:'attach'});assert.equal(first.displayReady,true);assert.equal(first.shown,false);
  const reused=await f.facade.perform({action:'attach'});assert.equal(reused.shown,false);
  assert.equal(f.instances.length,1);assert.equal(f.events.includes('visible:true'),false);await f.facade.close();
});

test('product constructors cannot suppress normal explicit Open with the isolated probe option',async()=>{
  const f=await fixture({detachedWindow:true,showOnAttach:false});
  assert.equal((await f.facade.perform({action:'attach'})).shown,true);assert.equal(f.events.includes('visible:true'),true);
  await f.facade.close();
});
const controls={available:true,enabled:true,busy:true,message:'Agent control',clipboardEnabled:false,fitEnabled:false,powerState:'running',eventSequence:0};
const toolbarEvent=(sequence=1,extra={})=>({event:'nativeControl',sequence,action:'start',windowHwnd:'456',inputOwner:'agent',...extra});
async function toolbarFixture(options={}){
  const f=await fixture({detachedWindow:true,resolveRuntime:async()=>({...build,detachedControls:true}),...options});await f.facade.perform({action:'attach'});
  const native=f.instances[0];native.worker={pid:77};native.last={...native.last,prepared:true,workbenchWindowHwnd:'456',uncertain:false,controls:{...controls}};
  native.configureControls=async value=>{f.events.push('controls');native.last={...native.last,controls:{available:true,eventSequence:0,...value}};return {...native.last}};
  f.emit=event=>native.options.onControl(event);f.native=native;return f;
}
test('legacy accepted preview builds do not advertise or activate detached toolbar controls',async()=>{
  const f=await fixture({detachedWindow:true});
  assert.equal((await f.facade.capability()).available,true);assert.equal((await f.facade.capability()).detachedControls,false);
  const attached=await f.facade.perform({action:'attach'});assert.equal(attached.capability.detachedControls,false);
  await assert.rejects(f.facade.configureControls({enabled:true,busy:false,message:'',clipboardEnabled:false,fitEnabled:false,powerState:'running'}),
    {code:'WORKBENCH_NATIVE_CONTROLS'});await f.facade.close();
});
test('native toolbar controls are an internal capability and remain usable when disconnected with certain ownership',async()=>{
  const handled=[];const f=await toolbarFixture({onControl:async(event,context)=>{context.assertCurrent();handled.push(event.action)}});
  assert.equal((await f.facade.capability()).detachedControls,true);
  f.native.last={...f.native.last,connected:false,displayReady:false};
  const settings={enabled:true,busy:true,message:'VM off',clipboardEnabled:false,fitEnabled:false,powerState:'off'};
  const configured=await f.facade.configureControls(settings);assert.equal(configured.capability.detachedControls,true);
  assert.equal(configured.controls.powerState,'off');assert.equal(configured.displayReady,false);
  assert.equal(await f.emit(toolbarEvent()),undefined);assert.deepEqual(handled,['start']);
  await assert.rejects(f.facade.perform({action:'controls',...settings}),{code:'WORKBENCH_NATIVE_ARGUMENTS'});
  await f.facade.close();
});
test('native toolbar events require the active accepted worker, exact root and fresh matching server owner',async()=>{
  const changes=[
    f=>{f.native.last.workbenchWindowHwnd='999'},f=>{f.native.last.inputOwner='user'},
    f=>{f.native.last.cached=true},f=>{f.native.last.uncertain=true},f=>{f.facade.build={...build,accepted:false}},
    f=>{f.native.last.controls.enabled=false},f=>{f.native.prepared=false},f=>{f.native.worker=null},
  ];
  for(const change of changes){let count=0;const f=await toolbarFixture({onControl:()=>{count++}});change(f);
    await assert.rejects(f.emit(toolbarEvent()),{code:'WORKBENCH_NATIVE_CONTROL_STALE'});assert.equal(count,0);await f.facade.close();}
  const f=await toolbarFixture({onControl:()=>assert.fail('Malformed event must not run')});
  assert.equal(await f.emit(toolbarEvent(1,{extra:true})),false);
  assert.equal(await f.emit(toolbarEvent(1,{action:'clipboard'})),false);await f.facade.close();
});
test('toolbar callback queue cannot reenter ownership queue and legitimate Take permits instance-only post acknowledgement',async()=>{
  let f,received=0;
  f=await toolbarFixture({onControl:async(event,{assertCurrent,assertInstance})=>{
    assertCurrent();received++;const user=await f.workbench.consoleControl.take();assertInstance();
    assert.throws(assertCurrent,{code:'WORKBENCH_NATIVE_CONTROL_STALE'});return user;
  }});
  const user=await f.emit(toolbarEvent(1,{action:'take'}));assert.equal(user.owner,'user');assert.equal(received,1);
  assert.equal(await f.emit(toolbarEvent(1,{action:'take'})),false);assert.equal(received,1);
  await f.facade.close();
});
test('queued toolbar events and in-flight status are invalidated by close, replacement or ownership changes',async()=>{
  for(const mode of ['close','worker','owner']){
    const held=deferred(),entered=deferred();let count=0;const f=await toolbarFixture({onControl:()=>{count++}});
    f.native.status=async()=>{entered.resolve();await held.promise;return {...f.native.last}};
    const event=f.emit(toolbarEvent()),rejected=assert.rejects(event,{code:'WORKBENCH_NATIVE_CONTROL_STALE'});await entered.promise;
    if(mode==='close')await f.facade.close();if(mode==='worker')f.native.worker={pid:88};if(mode==='owner')await f.workbench.consoleControl.take();
    held.resolve();await rejected;assert.equal(count,0);await f.facade.close();
  }
  const held=deferred(),entered=deferred(),actions=[];const f=await toolbarFixture({onControl:async event=>{
    actions.push(event.action);if(event.sequence===1){entered.resolve();await held.promise;}
  }});
  const first=f.emit(toolbarEvent(1,{action:'openBlackice'}));await entered.promise;
  const second=f.emit(toolbarEvent(2,{action:'wake'}));await tick();assert.deepEqual(actions,['openBlackice']);
  held.resolve();await Promise.all([first,second]);assert.deepEqual(actions,['openBlackice','wake']);await f.facade.close();
});
