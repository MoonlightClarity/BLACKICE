import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  WorkbenchHeadlessBroker,validateWorkbenchBrokerCommand,
  readWorkbenchBrokerReceipt,workbenchBrokerPipePath
} from '../lib/workbench-headless-broker.mjs';
import {WindowsWorkbench} from '../lib/windows-workbench.mjs';

const fixture=async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-headless-guest-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return root;
};

test('headless pipe transport validates exact bounded commands, no arbitrary PowerShell or host input',()=>{
  assert.equal(workbenchBrokerPipePath('BLACKICE-Workbench-v1'),'\\\\.\\pipe\\BLACKICE-Workbench-v1');
  assert.deepEqual(validateWorkbenchBrokerCommand('key',{key:'ENTER'}),{key:'ENTER'});
  assert.throws(()=>validateWorkbenchBrokerCommand('exec',{command:'whoami'}),{code:'WORKBENCH_BROKER_ARGUMENTS'});
  assert.throws(()=>validateWorkbenchBrokerCommand('key',{key:'HOST_ALT_TAB'}),{code:'WORKBENCH_BROKER_ARGUMENTS'});
  assert.deepEqual(validateWorkbenchBrokerCommand('type',{text:'Windows guest only'}),{text:'Windows guest only'});
  assert.throws(()=>validateWorkbenchBrokerCommand('type',{text:'line1\nline2'}),{code:'WORKBENCH_BROKER_ARGUMENTS'});
  assert.throws(()=>validateWorkbenchBrokerCommand('type',{text:'x'.repeat(201)}),{code:'WORKBENCH_BROKER_ARGUMENTS'});
  assert.deepEqual(validateWorkbenchBrokerCommand('click',{x:799,y:599,button:1}),{x:799,y:599,button:1});
  assert.throws(()=>validateWorkbenchBrokerCommand('click',{x:800,y:2,button:1}),{code:'WORKBENCH_BROKER_ARGUMENTS'});
  assert.throws(()=>validateWorkbenchBrokerCommand('click',{x:15,y:20,button:0}),{code:'WORKBENCH_BROKER_ARGUMENTS'});
  assert.throws(()=>validateWorkbenchBrokerCommand('start',{minimumMiB:4096,startupMiB:4096,maximumMiB:4096,cpuCount:1000}),{code:'WORKBENCH_BROKER_ARGUMENTS'});
  assert.throws(()=>new WorkbenchHeadlessBroker({pipeName:'untrusted-pipe'}),{code:'WORKBENCH_BROKER_ARGUMENTS'});
  const source=readFile(new URL('../lib/workbench-headless-broker.mjs',import.meta.url),'utf8');
  const script=readFile(new URL('../scripts/workbench-headless-broker.ps1',import.meta.url),'utf8');
  return Promise.all([source,script]).then(([client,server])=>{
    assert.doesNotMatch(client,/(?:import.*|require\().*child_process|Start-Process\s+-Verb|SetForegroundWindow|SendInput/);
    assert.match(server,/S-1-5-18/);
    assert.match(server,/DiagnosticOnly/);
    assert.match(server,/function Send-GuestText/);
    assert.match(server,/Msvm_Keyboard/);
    assert.match(server,/\.TypeText\(\$text\)/);
    assert.match(server,/function Send-GuestClick/);
    assert.match(server,/Msvm_SyntheticMouse/);
    assert.match(server,/\.SetAbsolutePosition\(\$actualX,\$actualY\)/);
    assert.match(server,/\.ClickButton\(\[uint32\]\$button\)/);
    assert.match(server,/\[System\.IO\.Pipes\.PipeOptions\]::Asynchronous/);
    assert.match(server,/\$lineTask\.Wait\(3000\)/);
    assert.doesNotMatch(server,/Start-Process -Verb RunAs|SetForegroundWindow|mouse_event|[Rr]estart-Computer/);
  });
});

test('broker rejects mismatched receipts, failed commands and missing Session 0 privileges',async()=>{
  const id='a6a9e4b2-92b1-4f74-bb71-d7347d2a1000';
  assert.throws(()=>readWorkbenchBrokerReceipt(JSON.stringify({v:1,id:'wrong',ok:true,result:{}}),id,{action:'status'}),{code:'WORKBENCH_BROKER_PROTOCOL'});
  assert.throws(()=>readWorkbenchBrokerReceipt(JSON.stringify({v:1,id,ok:false,code:'WORKBENCH_BROKER_REJECTED',message:'Not authorized'}),id,{action:'stop'}),{code:'WORKBENCH_BROKER_REJECTED'});
  const broker=new WorkbenchHeadlessBroker({connect:()=>{throw Error('Unexpected pipe call in unit fixture')}});
  broker.call=async()=>({broker:'BLACKICE-Workbench',vmExists:true,vmState:'Running',identity:'DESKTOP\\ordinary',sessionIsolated:false,vmQueryAuthorized:true});
  const status=await broker.status();
  assert.equal(status.available,false);
  assert.equal(status.code,'WORKBENCH_BROKER_UNAUTHORIZED');
  // Windows may localize the displayed SYSTEM account name. Its well-known
  // SID is invariant, and a status receipt must require that SID.
  broker.call=async()=>({broker:'BLACKICE-Workbench',vmExists:true,vmState:'Running',
    identity:'LOKALISIERTE-AUTORITÄT\\SYSTEM',identitySid:'S-1-5-18',
    sessionIsolated:true,vmQueryAuthorized:true});
  const localized=await broker.status();
  assert.equal(localized.available,true);
  assert.equal(localized.identitySid,'S-1-5-18');
  broker.call=async()=>({...localized,identitySid:'S-1-5-21-1000'});
  assert.equal((await broker.status()).available,false);
});

test('elevated BLACKICE uses its direct background token for persistent guest lifecycle',async t=>{
  const root=await fixture(t);
  const iso='C:\\Fixture\\Windows.iso';
  let exists=false,vmState='NotInstalled',commands=0;
  const received=[];
  const wb=new WindowsWorkbench({
    dataDir:root,sharedRoot:path.join(root,'workspace'),
    probe:async()=>({
      windows:true,edition:'Windows 11 Pro',hostName:'HOST',
      hyperVFeatureEnabled:true,hyperVModuleInstalled:true,vmServiceRunning:true,
      processElevated:true,vmQueryAuthorized:true,vmQueryViaElevation:false,
      vmExists:exists,vmState,vmProcessorCount:exists?10:0,
      vmAssignedMemoryMiB:vmState==='Running'?4096:0,
      logicalProcessors:12,totalMemoryMiB:32768,freeMemoryMiB:19000,
      freeDiskGiB:200,shareExists:false,sharePath:''
    }),
    mediaInspector:async()=>({path:iso,kind:'windows-iso',size:7237533696}),
    command:async script=>{
      commands++;received.push(script);
      if(script.includes('New-VM')){assert.equal(exists,false);exists=true;vmState='Off'}
      else if(script.includes('Start-VM')){assert.equal(vmState,'Off');vmState='Running'}
      else if(script.includes('Stop-VM')){assert.equal(vmState,'Running');vmState='Off'}
    }
  });
  await wb.configure({expectedRevision:1,mediaPath:iso});
  let s=await wb.status({fresh:true});
  assert.equal(s.capability.vmManagementViaBroker,false);
  assert.equal(s.capability.processElevated,true);
  assert.equal(s.canProvision,true);
  await wb.provision();
  s=await wb.status({fresh:true});
  assert.equal(s.guest.exists,true);
  assert.equal(s.canStart,true);
  await wb.start();
  s=await wb.status({fresh:true});
  assert.equal(s.guest.running,true);
  assert.equal(s.canReadGuestConsole,true);
  await wb.stop();
  assert.equal(vmState,'Off');
  assert.equal(commands,3);
  assert.ok(received[0].includes('New-VM'));
  assert.ok(received[1].includes('Start-VM'));
  assert.ok(received[2].includes('Stop-VM'));
});

test('unavailable headless broker leaves VM inventory unknown and blocks guest input without changing host',async t=>{
  const root=await fixture(t);
  let mutation=0;
  const wb=new WindowsWorkbench({
    dataDir:root,sharedRoot:path.join(root,'workspace'),
    probe:async()=>({windows:true,hyperVFeatureEnabled:true,
      hyperVModuleInstalled:true,vmServiceRunning:true,vmQueryAuthorized:false,
      vmState:'Unknown',vmExists:false,
      logicalProcessors:12,totalMemoryMiB:32768,freeMemoryMiB:16000,freeDiskGiB:200}),
    broker:{status:async()=>({available:false,reason:'No Session 0 task exists.'}),
      frame:async()=>{mutation++},key:async()=>{mutation++}},
    command:async()=>{mutation++}
  });
  const s=await wb.status({fresh:true});
  assert.equal(s.capability.headlessBrokerReady,false);
  assert.equal(s.guest.state,'Unknown');
  assert.equal(s.canStart,false);
  assert.equal(s.canReadGuestConsole,false);
  await assert.rejects(wb.guestConsoleKey('ENTER'),{code:'WORKBENCH_CONSOLE_UNAVAILABLE'});
  await assert.rejects(wb.guestConsoleFrame(),{code:'WORKBENCH_CONSOLE_UNAVAILABLE'});
  assert.equal(mutation,0);
});
