import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkbenchConsoleControl} from '../lib/workbench-console-control.mjs';
import {WindowsWorkbench} from '../lib/windows-workbench.mjs';

test('guest inspection never changes ownership, user take pauses agent input, cede restores agent',async()=>{
  const control=new WorkbenchConsoleControl();
  assert.deepEqual(control.status(),{owner:'agent',revision:0});
  assert.equal(await control.run(async()=> 'agent input'),'agent input');
  const receipt=await control.take();
  assert.equal(receipt.owner,'user');
  assert.match(receipt.controlToken,/^[a-f0-9-]{36}$/);
  assert.deepEqual(control.status(),{owner:'user',revision:1});
  assert.equal(Object.hasOwn(control.status(),'controlToken'),false);
  await assert.rejects(control.run(async()=> 'agent input'),{code:'WORKBENCH_CONTROL_HELD_BY_USER'});
  assert.equal(await control.run(async()=> 'user input',receipt.controlToken),'user input');
  assert.throws(()=>control.cede('00000000-0000-4000-8000-000000000001'),{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});
  const yielded=await control.cede(receipt.controlToken);
  assert.equal(yielded.owner,'agent');
  await assert.rejects(control.run(async()=> 'stale user',receipt.controlToken),{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});
  assert.equal(await control.run(async()=> 'agent again'),'agent again');
});

test('user takeover cancels queued agent commands and waits for already-running input',async()=>{
  const control=new WorkbenchConsoleControl();
  let resolve;
  const gate=new Promise(done=>{resolve=done});
  let started=false,dispatched=false,transferred=false;
  const active=control.run(async assertCurrent=>{
    started=true;await gate;
    assertCurrent();dispatched=true;return 'agent';
  });
  await Promise.resolve();
  assert.equal(started,true);
  const take=control.take().then(value=>{transferred=true;return value});
  const next=control.run(async()=>{assert.fail('New agent input must not run after take request')});
  assert.equal(transferred,false);
  resolve();
  await assert.rejects(active,{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});
  const ownership=await take;
  assert.equal(ownership.owner,'user');
  assert.equal(dispatched,false);
  await assert.rejects(next,{code:'WORKBENCH_CONTROL_HELD_BY_USER'});
});

test('a newer user takeover revokes old guest-control receipts',async()=>{
  const control=new WorkbenchConsoleControl();
  const a=await control.take(),b=await control.take();
  assert.notEqual(a.controlToken,b.controlToken);
  assert.equal(control.status().owner,'user');
  assert.throws(()=>control.cede(a.controlToken),{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});
  await assert.rejects(control.run(async()=>{},a.controlToken),{code:'WORKBENCH_CONTROL_HELD_BY_USER'});
  assert.equal((await control.cede(b.controlToken)).owner,'agent');
});

test('private native UI receipt is read-only and requires the exact current user revision',async()=>{
  const control=new WorkbenchConsoleControl();
  assert.throws(()=>control.localUserReceipt(0),{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});
  const taken=await control.take(),before=control.status();
  const receipt=await control.serialize(()=>control.localUserReceipt(taken.revision));
  assert.deepEqual(receipt,taken);assert.deepEqual(control.status(),before);
  assert.equal(Object.hasOwn(control.status(),'controlToken'),false);
  for(const revision of [undefined,null,-1,1.5,'1',taken.revision-1,taken.revision+1])
    assert.throws(()=>control.localUserReceipt(revision),{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});
  assert.equal(await control.run(async()=> 'native user',receipt.controlToken),'native user');
  await control.cede(receipt.controlToken);
  assert.throws(()=>control.localUserReceipt(control.status().revision),{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});
});

test('private receipt cannot revive stale takeover or failed ownership synchronization',async()=>{
  const control=new WorkbenchConsoleControl(),old=await control.take();
  const current=await control.take();
  assert.throws(()=>control.localUserReceipt(old.revision),{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});
  assert.deepEqual(control.localUserReceipt(current.revision),current);
  await assert.rejects(control.setTransitionHook(async()=>{throw Error('Native acknowledgement failed');}),{code:'WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE'});
  assert.equal(control.status().owner,'none');
  assert.throws(()=>control.localUserReceipt(control.status().revision),{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});
});

test('Workbench keeps visual inspection available while user controls VM input',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-guest-ownership-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const calls=[];
  const vm=new WindowsWorkbench({
    dataDir:dir,sharedRoot:path.join(dir,'workspace'),
    probe:async()=>({
      windows:true,edition:'Windows 11 Pro',hostName:'HOST',
      hyperVFeatureEnabled:true,hyperVModuleInstalled:true,vmServiceRunning:true,
      vmQueryAuthorized:true,vmQueryViaElevation:false,processElevated:true,
      vmExists:true,vmState:'Running',vmProcessorCount:10,vmAssignedMemoryMiB:4096,
      logicalProcessors:16,totalMemoryMiB:32768,freeMemoryMiB:16000,freeDiskGiB:150
    }),
    consoleController:{
      frame:async()=>{calls.push('frame');return{bytes:Buffer.from([255,216,255,217]),contentType:'image/jpeg'}},
      key:async value=>{calls.push('key:'+value);return {guest:'BLACKICE-Workbench',delivered:true}},
      type:async value=>{calls.push('type:'+value);return {guest:'BLACKICE-Workbench',typed:true}},
      click:async(x,y,button)=>{calls.push('click:'+x+':'+y+':'+button);return {guest:'BLACKICE-Workbench',clicked:true}}
    },
    guestBridgeFactory:({sharedRoot})=>({
      workspace:path.resolve(sharedRoot),agentStatus:async()=>({
        online:false,paired:false,sharedReadWriteVerified:false,displayReady:false,capabilities:[]
      })
    })
  });
  assert.equal((await vm.status()).consoleControl.owner,'agent');
  const claim=await vm.takeGuestConsoleControl();
  assert.equal((await vm.status()).consoleControl.owner,'user');
  assert.equal((await vm.guestConsoleFrame()).contentType,'image/jpeg');
  await assert.rejects(vm.guestConsoleKey('ENTER'),{code:'WORKBENCH_CONTROL_HELD_BY_USER'});
  await assert.rejects(vm.guestAction({kind:'type',args:{text:'agent'}}),{code:'WORKBENCH_CONTROL_HELD_BY_USER'});
  assert.equal((await vm.guestConsoleKey('ENTER',claim.controlToken)).delivered,true);
  assert.equal((await vm.guestConsoleType('user',claim.controlToken)).typed,true);
  assert.equal((await vm.guestConsoleClick(200,150,1,claim.controlToken)).clicked,true);
  assert.deepEqual(calls,['frame','key:ENTER','type:user','click:200:150:1']);
  assert.equal((await vm.cedeGuestConsoleControl(claim.controlToken)).owner,'agent');
  assert.equal((await vm.guestConsoleKey('TAB')).delivered,true);
});

test('Workbench frontend keeps native controls in their own window and uses only launcher/setup markup',async()=>{
  const ui=await readFile(new URL('../public/next/workspaces/workbench.mjs',import.meta.url),'utf8');
  const css=await readFile(new URL('../public/next/workbench.css',import.meta.url),'utf8');
  const guide=await readFile(new URL('../public/next/workspaces/workbench-guide.mjs',import.meta.url),'utf8');
  for(const id of ['wb-open-window','wb-start','wb-vm-settings','wb-provision','wb-add-folder','wb-pair','wb-apps-scan','wb-apps-rebatch','wb-apps-retry'])assert.ok(ui.includes('id="'+id+'"'),id);
  assert.match(ui,/next-panel next-workbench/);assert.match(ui,/Controls are in Workbench/);
  assert.doesNotMatch(ui,/wb-inspector|wb-console|wb-compatibility|desktop\/stream|console\/control|workbenchFeatures|requestFullscreen|onGuestKeyboard|onGuestPaste/);
  assert.doesNotMatch(css,/wb-inspector|fullscreen|position:fixed|wb-vm-workspace|wb-sharing-controls/);
  assert.match(guide,/This BLACKICE tab stays a launcher and setup page/);assert.doesNotMatch(guide,/VM desktop fills Workbench|Exit full screen/);
  assert.doesNotMatch(ui,/SetForegroundWindow|SendInput|VMConnect\.exe/);
});
