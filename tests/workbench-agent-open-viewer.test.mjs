import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {WindowsWorkbench} from '../lib/windows-workbench.mjs';
import {WorkbenchNativeSurface} from '../desktop/workbench-native-surface.mjs';
import {createWorkbenchAgentToolHandler,workbenchAgentToolForAuthorization} from '../lib/workbench-agent-tools.mjs';

const build={accepted:true,helperSha256:'a'.repeat(64),runtimeManifestSha256:'b'.repeat(64)};
const identity={version:1,readyForBoundedProbe:true,vmName:'Fixture VM',vmState:'Running',host:'127.0.0.1',port:2179,listenerOwnedByVmms:true,
  vmId:'11111111-2222-4333-8444-555555555555',certificateSha256:'c'.repeat(64),
  certificates:[{sha256:'c'.repeat(64),source:'local-vmms-service-certificate-store',notAfter:'2099-01-01T00:00:00Z'}]};
const ready={connected:true,displayReady:true,certificateVerified:true,selectedProtocol:2,decodedFrames:3,surface:{width:800,height:600},
  perMonitorV2:true,inputOwner:'agent',detached:true,windowVisible:false,windowCloseRevision:0,uncertain:false};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const value=result=>JSON.parse(result.contentItems[0].text);
async function fixture(t,options={}){
  const events=[],instances=[];
  const window={isDestroyed:()=>options.anchorDestroyed===true};
  const workbench=new WindowsWorkbench({dataDir:path.resolve('fixture-agent-open-viewer'),probe:async()=>assert.fail('No live host inventory.'),consoleController:{frame:()=>assert.fail('No legacy capture.')}});
  workbench.config={vmName:'Fixture VM'};
  // Status in this isolated viewer fixture must not probe the actual Hyper-V host.
  workbench.status=async()=>({vmName:'Fixture VM',guest:{running:true,agent:{paired:true}},consoleControl:workbench.consoleControl.status(),blockers:[]});
  const paired={state:{vmName:'Fixture VM',capability:{}},agent:{guestName:'GUEST',guestSessionId:2}};
  let contextReads=0;
  const jobs={context:async()=>{contextReads++;if(options.offline)throw Error('SMB unavailable');return paired;}};
  class Host{
    constructor(){instances.push(this);this.last={prepared:false,connected:false,displayReady:false,uncertain:false};}
    async prepare(bounds,anchor){assert.equal(bounds,undefined);assert.equal(anchor,window);events.push('prepare');await options.prepare?.();this.prepared=true;this.last={...this.last,prepared:true,perMonitorV2:true,windowCloseRevision:0};return this.last;}
    async connect(args){events.push('connect');assert.deepEqual({vmId:args.vmId,certificateSha256:args.certificateSha256},{vmId:identity.vmId,certificateSha256:identity.certificateSha256});assert.ok(args.timeoutMs>=1000&&args.timeoutMs<=10000);await options.connect?.();this.last={...ready,windowCloseRevision:options.closeDuringConnect?1:0};return this.last;}
    async status(){return {...this.last};}
    async position(bounds){assert.equal(bounds,undefined);events.push('position');return this.last;}
    async inputOwner(owner){events.push('owner:'+owner);this.last={...this.last,inputOwner:owner};return this.last;}
    async visible(shown,guard){events.push('visible:'+shown);assert.equal(guard.expectedWindowCloseRevision,this.last.windowCloseRevision);this.last={...this.last,windowVisible:shown};return this.last;}
    async close(){events.push('close');this.closed=true;this.last={connected:false,displayReady:false,cleanup:{confirmed:true,exited:true,started:true,forced:false,exitCode:0,signal:null}};return this.last;}
  }
  const surface=new WorkbenchNativeSurface({platform:'win32',detachedWindow:true,allowUnacceptedProbe:options.allowUnacceptedProbe===true,getWorkbench:()=>workbench,getWindow:()=>window,Host,
    resolveRuntime:async()=>{events.push('resolve');await options.resolve?.();return {...build,...options.build};},
    preflight:async()=>{events.push('preflight');await options.preflight?.();return {...identity,...options.identity};}});
  await surface.bindWorkbench();
  const handler=createWorkbenchAgentToolHandler({workbench,scope:'open-viewer-test',jobs});
  const call=(args={action:'open_viewer'},context={},callId)=>handler({name:'relay_workbench',arguments:args,...(callId?{callId}:{})},context);
  t.after(async()=>{await handler.close();await surface.destroy();});
  return {workbench,surface,handler,call,events,instances,contextReads:()=>contextReads};
}

test('only an attached desktop opener advertises open_viewer; status observes a closed viewer without launching',async t=>{
  assert.equal(workbenchAgentToolForAuthorization(null).inputSchema.properties.action.enum.includes('open_viewer'),false);
  const f=await fixture(t);
  assert.equal(workbenchAgentToolForAuthorization(null,f.workbench).inputSchema.properties.action.enum.includes('open_viewer'),true);
  const result=await f.call({action:'status'}),status=value(result);
  assert.equal(result.success,true);assert.deepEqual(status.viewer,{backendAttached:true,openAvailable:true,attached:false,connected:false,displayReady:false,windowVisible:false,uncertain:false,code:'WORKBENCH_NATIVE_NOT_ATTACHED',availabilityMeaning:'new-attempt-availability-not-connection-readiness'});
  assert.ok(status.capabilities.includes('open_viewer'));assert.equal(f.instances.length,0);
  await f.workbench.setGuestNativeConsoleAdapter(null);
  assert.equal(workbenchAgentToolForAuthorization(null,f.workbench).inputSchema.properties.action.enum.includes('open_viewer'),false);
  assert.equal((await f.call()).code,'WORKBENCH_NATIVE_UNAVAILABLE');
});

test('agent explicitly opens only the pinned configured running VM with no SMB, power or ownership prerequisite mutation',async t=>{
  const f=await fixture(t,{offline:true}),before=f.workbench.consoleControl.status();
  const result=await f.call(),receipt=value(result);
  assert.equal(result.success,true);assert.equal(receipt.viewer.opened,true);assert.equal(receipt.viewer.displayReady,true);assert.equal(receipt.viewer.accepted,true);
  assert.deepEqual(f.workbench.consoleControl.status(),before);assert.equal(f.contextReads(),0);
  assert.deepEqual(f.events,['resolve','preflight','prepare','connect','owner:agent','visible:true']);
  assert.equal((await f.workbench.guestNativeConsoleStatus()).attached,true);
  await f.call();assert.equal(f.instances.length,1,'Explicit subsequent show reuses the existing session.');
});

test('USER, NONE, cancellation and model-selected paths/VM/bounds are rejected before native work',async t=>{
  const f=await fixture(t);const user=await f.workbench.consoleControl.take();
  assert.equal((await f.call()).code,'WORKBENCH_CONTROL_HELD_BY_USER');await f.workbench.consoleControl.cede(user.controlToken);
  f.workbench.consoleControl.owner='none';assert.equal((await f.call()).code,'WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE');f.workbench.consoleControl.owner='agent';
  const controller=new AbortController();controller.abort();assert.equal((await f.call(undefined,{signal:controller.signal})).code,'ABORT_ERR');
  for(const extra of [{vmId:identity.vmId},{bounds:{x:0,y:0,width:1,height:1}},{path:'x'},{timeoutMs:30000},{controlToken:'token'}])assert.equal((await f.call({action:'open_viewer',...extra})).success,false);
  assert.deepEqual(f.events,[]);assert.equal(f.instances.length,0);
});

test('Take during runtime discovery, native preparation or connection fences every later dispatch and show',async t=>{
  for(const stage of ['resolve','preflight','prepare','connect']){
    const entered=deferred(),wait=deferred(),f=await fixture(t,{[stage]:async()=>{entered.resolve();await wait.promise;}});
    const opening=f.call();await entered.promise;const taking=f.workbench.consoleControl.take();wait.resolve();
    const result=await opening;assert.equal(result.code,'WORKBENCH_CONSOLE_CONTROL_CONFLICT',stage);assert.equal((await taking).owner,'user');
    assert.equal(f.events.includes('visible:true'),false,stage);assert.equal(f.surface.native,null,stage);
    if(['resolve','preflight'].includes(stage))assert.equal(f.instances.length,0,stage);
    else assert.equal(f.instances[0].closed,true,stage);
  }
});

test('close/hide epoch and actual native close during connect cannot be undone by an agent opening continuation',async t=>{
  for(const action of ['close','hide']){
    const entered=deferred(),wait=deferred(),f=await fixture(t,{connect:async()=>{entered.resolve();await wait.promise;}});
    const pending=f.call();await entered.promise;await f.surface[action]();wait.resolve();
    assert.equal((await pending).code,'WORKBENCH_NATIVE_CANCELLED');assert.equal(f.events.includes('visible:true'),false);
  }
  const f=await fixture(t,{closeDuringConnect:true}),result=await f.call();
  assert.equal(result.success,true);assert.equal(value(result).viewer.opened,false);assert.equal(value(result).viewer.closedDuringOpen,true);
  assert.equal(value(result).viewer.connected,true);assert.equal(f.events.includes('visible:true'),false);
});

test('uncertain dispatch is not retried, including duplicate native call IDs, and a ready UI attach cannot deadlock the agent opener',async t=>{
  const uncertain=Object.assign(Error('Native delivery is uncertain; inspect before retrying.'),{code:'WORKBENCH_NATIVE_UNCERTAIN'});
  const f=await fixture(t,{connect:async()=>{throw uncertain;}});
  assert.equal((await f.call(undefined,{},'native-open-1')).code,'WORKBENCH_NATIVE_UNCERTAIN');
  assert.equal((await f.call(undefined,{},'native-open-1')).code,'WORKBENCH_NATIVE_UNCERTAIN');
  assert.equal(f.events.filter(x=>x==='connect').length,1);
  const entered=deferred(),wait=deferred(),g=await fixture(t,{resolve:async()=>{entered.resolve();await wait.promise;}});
  const ui=g.surface.perform({action:'attach'});await entered.promise;const agent=g.call();wait.resolve();
  const completed=await Promise.race([Promise.all([ui,agent]),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Ownership/surface queue deadlock')),1000);timer.unref();})]);
  assert.equal(completed[1].success,true);assert.equal(g.instances.length,1);
});

test('pending acceptance and mismatched/nonrunning VM identity stop opening before helper creation',async t=>{
  for(const options of [{build:{accepted:false}},{build:{accepted:false},allowUnacceptedProbe:true},{anchorDestroyed:true},{identity:{vmName:'Other VM'}},{identity:{vmState:'Off'}},{identity:{certificateSha256:'d'.repeat(64)}},{identity:{listenerOwnedByVmms:false}}]){
    const f=await fixture(t,options);assert.equal((await f.call()).success,false);assert.equal(f.instances.length,0);
  }
});

test('successful duplicate call receipt never reopens a subsequently user-hidden window',async t=>{
  const f=await fixture(t);assert.equal((await f.call(undefined,{},'open-then-close')).success,true);
  const host=f.instances[0];host.last={...host.last,windowVisible:false,windowCloseRevision:1};
  const count=f.events.length;assert.equal((await f.call(undefined,{},'open-then-close')).success,true);
  assert.equal(f.events.length,count);assert.equal(host.last.windowVisible,false);
});

test('opening is bounded to 30 seconds and a timed-out preflight cannot later spawn or show',async t=>{
  const entered=deferred(),wait=deferred(),f=await fixture(t,{preflight:async()=>{entered.resolve();await wait.promise;}});
  t.mock.timers.enable({apis:['setTimeout']});
  const opening=f.call();await entered.promise;
  assert.equal((await f.workbench.guestNativeConsoleStatus()).code,'WORKBENCH_NATIVE_OPEN_PENDING');
  assert.equal((await f.call()).code,'WORKBENCH_NATIVE_OPEN_PENDING');
  t.mock.timers.tick(30000);
  assert.equal((await opening).code,'WORKBENCH_NATIVE_UNCERTAIN');
  const status=await f.workbench.guestNativeConsoleStatus();assert.equal(status.uncertain,true);assert.equal(status.openAvailable,false);
  assert.equal((await f.call()).code,'WORKBENCH_NATIVE_UNCERTAIN');
  wait.resolve();await f.surface.tail;assert.equal(f.instances.length,0);assert.equal(f.events.includes('visible:true'),false);
  t.mock.timers.reset();
});

test('the Windows adapter rejects malformed readiness and replacement while an opener is pending',async t=>{
  for(const changed of [{accepted:false},{detached:false},{uncertain:true},{connected:false},{displayReady:false},{opened:false,windowVisible:true}]){
    const f=await fixture(t);f.workbench.nativeConsoleAdapter.open=async()=>({accepted:true,detached:true,uncertain:false,connected:true,displayReady:true,opened:true,windowVisible:true,...changed});
    assert.equal((await f.call()).code,'WORKBENCH_NATIVE_UNCERTAIN');assert.equal(f.instances.length,0);
  }
  const f=await fixture(t),entered=deferred(),wait=deferred();
  f.workbench.nativeConsoleAdapter.open=async check=>{entered.resolve();await wait.promise;check();return {};};
  const opening=f.call();await entered.promise;await f.workbench.setGuestNativeConsoleAdapter(null);wait.resolve();
  assert.equal((await opening).code,'WORKBENCH_NATIVE_UNAVAILABLE');assert.equal(f.instances.length,0);
});
