import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {WindowsWorkbench} from '../lib/windows-workbench.mjs';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(options={}){
  const calls=[],agent={online:true,paired:true,agentId:'expected-agent',guestSessionId:2,capabilities:['display_info','display_resize']};
  const vm=new WindowsWorkbench({dataDir:path.resolve('fixture-native-desktop'),sharedRoot:path.resolve('fixture-native-desktop-workspace'),
    probe:()=>assert.fail('Native display actions must not launch a full Hyper-V inventory probe.'),
    guestBridgeFactory:({sharedRoot})=>({workspace:path.resolve(sharedRoot),
      agentStatus:async()=>{calls.push('agent');if(options.agentStatus)await options.agentStatus();return {...agent};},
      request:async(kind,args,requestOptions)=>{calls.push({kind,args,options:requestOptions});return {status:'completed',agentId:agent.agentId,guestSessionId:agent.guestSessionId,result:{confirmed:true}};}})});
  const adapter={frame:async()=>assert.fail('Native proof uses current surface metadata, not a screenshot.'),input:async()=>assert.fail('Display actions do not inject guest input.'),
    surface:async()=>{calls.push('surface');if(options.surface)await options.surface();return options.dimensions||{width:1024,height:768};}};
  await vm.setGuestNativeConsoleAdapter(adapter);
  return {vm,agent,calls,adapter,expectedAgent:{agentId:agent.agentId,guestSessionId:agent.guestSessionId}};
}
test('native display action checks fresh paired agent and native surface without Hyper-V probe, forwarding exact identity and deadline',async()=>{
  const f=await fixture(),claim=await f.vm.takeGuestConsoleControl();
  await f.vm.guestNativeDesktopAction({kind:'display_resize',args:{width:1280,height:800,guestSessionId:2},controlToken:claim.controlToken,expectedAgent:f.expectedAgent});
  assert.deepEqual(f.calls,['surface','agent',{kind:'display_resize',args:{width:1280,height:800,guestSessionId:2},options:{timeoutMs:6000,expectedAgent:f.expectedAgent}}]);
  assert.deepEqual(f.vm.consoleControl.status(),{owner:'user',revision:claim.revision});
});
test('USER requires current token; NONE and missing native proof reject before guest requests',async()=>{
  const f=await fixture(),claim=await f.vm.takeGuestConsoleControl();
  const request={kind:'display_info',args:{guestSessionId:2},expectedAgent:f.expectedAgent};
  await assert.rejects(f.vm.guestNativeDesktopAction(request),{code:'WORKBENCH_CONTROL_HELD_BY_USER'});
  await assert.rejects(f.vm.guestNativeDesktopAction({...request,controlToken:'stale'}),{code:'WORKBENCH_CONTROL_HELD_BY_USER'});
  assert.equal(f.calls.length,0);
  await f.vm.setGuestNativeConsoleAdapter(null);
  await assert.rejects(f.vm.guestNativeDesktopAction({...request,controlToken:claim.controlToken}),{code:'WORKBENCH_NATIVE_UNAVAILABLE'});
  await f.vm.consoleControl.failClosed(Error('fixture'),[]).catch(()=>{});
  await assert.rejects(f.vm.guestNativeDesktopAction(request),{code:'WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE'});
  assert.equal(f.calls.length,0);
});
test('only display kinds and exact current paired agent/capability can dispatch; explicit AGENT inspection remains possible',async()=>{
  for(const kind of ['clipboard_read','launch','click']){
    const f=await fixture();assert.throws(()=>f.vm.guestNativeDesktopAction({kind,args:{},expectedAgent:f.expectedAgent}),{code:'WORKBENCH_NATIVE_DISPLAY_ACTION'});assert.equal(f.calls.length,0);
  }
  for(const mismatch of [{agentId:'replacement',guestSessionId:2},{agentId:'expected-agent',guestSessionId:3},undefined]){
    const f=await fixture();await assert.rejects(f.vm.guestNativeDesktopAction({kind:'display_info',args:{guestSessionId:2},expectedAgent:mismatch}),{code:'WORKBENCH_GUEST_NOT_PAIRED'});
    assert.equal(f.calls.some(value=>typeof value==='object'),false);
  }
  const f=await fixture();f.agent.online=false;
  await assert.rejects(f.vm.guestNativeDesktopAction({kind:'display_info',args:{guestSessionId:2},expectedAgent:f.expectedAgent}),{code:'WORKBENCH_GUEST_NOT_PAIRED'});
  f.agent.online=true;f.agent.capabilities=[];
  await assert.rejects(f.vm.guestNativeDesktopAction({kind:'display_info',args:{guestSessionId:2},expectedAgent:f.expectedAgent}),{code:'WORKBENCH_GUEST_NOT_PAIRED'});
  f.agent.capabilities=['display_info'];
  assert.equal((await f.vm.guestNativeDesktopAction({kind:'display_info',args:{guestSessionId:2},expectedAgent:f.expectedAgent})).status,'completed');
});
test('a newer Take during native proof prevents stale display dispatch before the next ownership receipt',async()=>{
  const gate=deferred(),f=await fixture({surface:()=>gate.promise});
  const pending=f.vm.guestNativeDesktopAction({kind:'display_info',args:{guestSessionId:2},expectedAgent:f.expectedAgent});await tick();
  const taking=f.vm.takeGuestConsoleControl();gate.resolve();
  await assert.rejects(pending,{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});
  const claim=await taking;assert.equal(claim.owner,'user');assert.deepEqual(f.calls,['surface']);
});
test('invalid native bounds and retired adapters cannot become guest display proof',async()=>{
  const bad=await fixture({dimensions:{width:4097,height:768}});
  await assert.rejects(bad.vm.guestNativeDesktopAction({kind:'display_info',args:{guestSessionId:2},expectedAgent:bad.expectedAgent}),{code:'WORKBENCH_NATIVE_FRAME_INVALID'});
  const gate=deferred(),f=await fixture({surface:()=>gate.promise});
  const pending=f.vm.guestNativeDesktopAction({kind:'display_info',args:{guestSessionId:2},expectedAgent:f.expectedAgent});await tick();
  f.vm.nativeConsoleAdapter=null;gate.resolve();
  await assert.rejects(pending,{code:'WORKBENCH_NATIVE_UNAVAILABLE'});assert.deepEqual(f.calls,['surface']);
});
