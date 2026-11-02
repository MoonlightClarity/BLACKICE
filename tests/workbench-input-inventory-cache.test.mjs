import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WindowsWorkbench} from '../lib/windows-workbench.mjs';

async function fixture(t,overrides={}){
  const root=await mkdtemp(path.join(tmpdir(),'blackice-input-cache-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const workspace=path.join(root,'workspace'),calls={probes:0,agentReads:0,guest:0,console:0,power:0};
  const host={windows:true,edition:'Windows 11 Pro',hostName:'HOST',hyperVFeatureEnabled:true,
    hyperVModuleInstalled:true,vmServiceRunning:true,vmQueryAuthorized:true,processElevated:true,
    vmExists:true,vmState:'Running',shareExists:true,sharePath:workspace,logicalProcessors:16,
    totalMemoryMiB:32768,freeMemoryMiB:16000,freeDiskGiB:150,...overrides};
  const agent={online:true,paired:true,sharedReadWriteVerified:true,displayReady:true,
    capabilities:['capture','click','type','launch'],guestSessionId:2};
  const vm=new WindowsWorkbench({dataDir:path.join(root,'data'),sharedRoot:workspace,
    probe:async()=>{calls.probes++;return {...host};},
    command:async()=>{calls.power++;host.vmState='Off';},
    guestBridgeFactory:({sharedRoot})=>({workspace:path.resolve(sharedRoot),
      agentStatus:async()=>{calls.agentReads++;return {...agent};},
      request:async()=>{calls.guest++;return {status:'completed'};}}),
    consoleController:Object.fromEntries(['key','type','click'].map(kind=>[kind,async()=>{calls.console++;return {delivered:true};}]))});
  return {vm,host,agent,calls};
}

test('repeated guest and console input reuse the eight-second inventory while checking guest state and owner each time',async t=>{
  const {vm,agent,calls}=await fixture(t);
  await vm.status();const claim=await vm.takeGuestConsoleControl();
  await vm.guestAction({kind:'click',args:{x:10,y:10},controlToken:claim.controlToken});
  await vm.guestConsoleKey('ENTER',claim.controlToken);
  await vm.guestConsoleType('fixture',claim.controlToken);
  await vm.guestConsoleClick(10,10,1,claim.controlToken);
  assert.deepEqual(calls,{probes:1,agentReads:5,guest:1,console:3,power:0});
  agent.paired=false;agent.sharedReadWriteVerified=false;
  await assert.rejects(vm.guestAction({kind:'type',args:{text:'fixture'},controlToken:claim.controlToken}),{code:'WORKBENCH_GUEST_UNAVAILABLE'});
  assert.equal(calls.probes,1);assert.equal(calls.agentReads,6);assert.equal(calls.guest,1);
  await assert.rejects(vm.guestConsoleKey('ENTER'),{code:'WORKBENCH_CONTROL_HELD_BY_USER'});
  assert.equal(calls.agentReads,6,'Rejected owners cannot enter a status or input operation.');
  assert.deepEqual(vm.consoleControl.status(),{owner:'user',revision:claim.revision});
});

test('expired, cold or unavailable host inventory cannot authorize input',async t=>{
  const {vm,host,calls}=await fixture(t);
  await vm.status();host.vmState='Off';vm.probedAt=Date.now()-8001;
  await assert.rejects(vm.guestConsoleKey('ENTER'),{code:'WORKBENCH_CONSOLE_UNAVAILABLE'});
  await assert.rejects(vm.guestAction({kind:'click',args:{x:10,y:10}}),{code:'WORKBENCH_GUEST_UNAVAILABLE'});
  assert.equal(calls.probes,2);assert.equal(calls.console,0);assert.equal(calls.guest,0);
  for(const state of [{vmState:'Off'},{vmQueryAuthorized:false},{processElevated:false}]){
    const cold=await fixture(t,state);
    await assert.rejects(cold.vm.guestConsoleKey('ENTER'),{code:'WORKBENCH_CONSOLE_UNAVAILABLE'});
    assert.equal(cold.calls.probes,1);assert.equal(cold.calls.console,0);
  }
});

test('explicit VM shutdown bypasses the input inventory cache and invalidates it after the power command',async t=>{
  const {vm,calls}=await fixture(t);await vm.status();assert.equal(calls.probes,1);
  const stopped=await vm.stop();
  assert.equal(calls.probes,3,'Shutdown freshly probes before and after its command.');
  assert.equal(calls.power,1);assert.equal(stopped.guest.running,false);
  await assert.rejects(vm.guestConsoleKey('ENTER'),{code:'WORKBENCH_CONSOLE_UNAVAILABLE'});
  assert.equal(calls.console,0);
});
