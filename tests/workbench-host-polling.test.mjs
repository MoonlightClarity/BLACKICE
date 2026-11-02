import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {WindowsWorkbench} from '../lib/windows-workbench.mjs';

test('denied Hyper-V token is cached; Workbench never retries elevation or a retired broker',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-no-focus-status-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  let hostProbes=0,commands=0,guestActions=0;
  const initial={
    windows:true,edition:'Windows 11 Pro',hostName:'HOST',
    hyperVFeatureEnabled:true,hyperVModuleInstalled:true,vmServiceRunning:true,
    vmQueryAuthorized:false,vmQueryError:'Access denied',processElevated:false,
    vmExists:false,vmState:'Unknown',logicalProcessors:12,totalMemoryMiB:32768,
    freeMemoryMiB:18000,freeDiskGiB:200
  };
  const workbench=new WindowsWorkbench({
    dataDir:root,sharedRoot:path.join(root,'workspace'),
    probe:async()=>{hostProbes++;return {...initial}},
    consoleController:{
      frame:async()=>{guestActions++},key:async()=>{guestActions++},
      type:async()=>{guestActions++},click:async()=>{guestActions++}
    },
    command:async()=>{commands++;throw Error('Status must not execute a host command')}
  });
  for(let i=0;i<15;i++){
    const status=await workbench.status();
    assert.equal(status.capability.canManageVM,false);
    assert.equal(status.capability.processElevated,false);
    assert.equal(status.guest.state,'Unknown');
    assert.equal(status.canReadGuestConsole,false);
    workbench.probedAt=0;
  }
  assert.equal(hostProbes,1);
  await workbench.status({fresh:true});
  assert.equal(hostProbes,1);
  assert.equal(commands,0);
  assert.equal(guestActions,0);
  await assert.rejects(workbench.guestConsoleFrame(),{code:'WORKBENCH_CONSOLE_UNAVAILABLE'});
  assert.equal(guestActions,0);
});

test('concurrent status checks coalesce one initial host probe without task or shell calls',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-no-focus-coalesce-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  let hostProbes=0,commands=0;
  const workbench=new WindowsWorkbench({
    dataDir:root,sharedRoot:path.join(root,'workspace'),
    probe:async()=>{
      hostProbes++;
      await new Promise(resolve=>setTimeout(resolve,18));
      return {windows:true,hyperVFeatureEnabled:true,hyperVModuleInstalled:true,
        vmServiceRunning:true,vmQueryAuthorized:false,processElevated:false,
        vmExists:false,vmState:'Unknown',logicalProcessors:10,
        totalMemoryMiB:16384,freeMemoryMiB:8000,freeDiskGiB:120};
    },
    command:async()=>{commands++;throw Error('Background status must not execute VM mutations')}
  });
  const results=await Promise.all(Array.from({length:9},()=>workbench.status()));
  assert.equal(hostProbes,1);
  assert.equal(commands,0);
  assert.ok(results.every(x=>!x.canStart&&!x.capability.canManageVM&&!x.canReadGuestConsole));
});

test('verified hidden administrator helper enables running guest console without a SYSTEM pipe',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-admin-ready-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const calls=[];
  const workbench=new WindowsWorkbench({
    dataDir:root,sharedRoot:path.join(root,'workspace'),
    probe:async()=>({
      windows:true,edition:'Windows 11 Pro',hostName:'HOST',
      hyperVFeatureEnabled:true,hyperVModuleInstalled:true,vmServiceRunning:true,
      processElevated:true,vmQueryAuthorized:true,vmQueryViaElevation:false,
      vmExists:true,vmState:'Running',vmProcessorCount:8,vmAssignedMemoryMiB:4096,
      logicalProcessors:12,totalMemoryMiB:32768,freeMemoryMiB:18000,freeDiskGiB:200,
      shareExists:false,sharePath:''
    }),
    consoleController:{
      frame:async()=>{calls.push('frame');return {bytes:Buffer.from([255,216,255,217]),contentType:'image/jpeg',width:800,height:600}},
      key:async key=>{calls.push('key:'+key);return {delivered:true}},
      type:async text=>{calls.push('type:'+text);return {typed:true}},
      click:async(x,y,button)=>{calls.push('click:'+x+':'+y+':'+button);return {clicked:true}}
    },
    command:async()=>{throw Error('Guest console must not invoke host VM lifecycle command')}
  });
  const state=await workbench.status();
  assert.equal(state.capability.processElevated,true);
  assert.equal(state.capability.vmManagementViaBroker,false);
  assert.equal(state.canReadGuestConsole,true);
  await workbench.guestConsoleFrame();
  await workbench.guestConsoleKey('ENTER');
  await workbench.guestConsoleType('Windows guest');
  await workbench.guestConsoleClick(799,599,1);
  assert.deepEqual(calls,['frame','key:ENTER','type:Windows guest','click:799:599:1']);
});
