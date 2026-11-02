import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  buildElevatedWorkbenchLauncher,runElevatedWorkbenchPowerShell,
  WORKBENCH_HOST_FOCUS_POLICY
} from '../lib/workbench-elevated.mjs';
import {WindowsWorkbench} from '../lib/windows-workbench.mjs';

test('interactive RunAs launcher and elevated shell refuse to run without creating any process',async()=>{
  assert.match(WORKBENCH_HOST_FOCUS_POLICY,/Run BLACKICE normally/i);
  assert.match(WORKBENCH_HOST_FOCUS_POLICY,/hidden Workbench administrator helper/i);
  assert.throws(()=>buildElevatedWorkbenchLauncher({script:"Get-VM"}),{
    code:'WORKBENCH_HOST_FOCUS_PROTECTED',status:503
  });
  let attempted=0;
  await assert.rejects(runElevatedWorkbenchPowerShell('Get-VM',30000,{
    executeCommand:async()=>{attempted++}
  }),{code:'WORKBENCH_HOST_FOCUS_PROTECTED',status:503});
  assert.equal(attempted,0);
});

test('status probes route through hidden administrator helper rather than an elevated Electron process',async()=>{
  const source=await readFile(new URL('../lib/windows-workbench.mjs',import.meta.url),'utf8');
  const elevation=await readFile(new URL('../lib/workbench-elevated.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/runElevatedWorkbenchPowerShell|this\.elevatedCommand|Start-Process.*RunAs/i);
  assert.doesNotMatch(elevation,/Start-Process.*RunAs|child_process|execFile|spawn\(/i);
  assert.match(source,/runHiddenWorkbenchPowerShell/);
  const helper=await readFile(new URL('../lib/workbench-elevated-command.mjs',import.meta.url),'utf8');
  assert.match(helper,/windowsHide:true/);
  assert.match(helper,/'-WindowStyle','Hidden'/);
  assert.match(source,/vmQueryAuthorized===true&&h\.vmQueryViaElevation!==true/);
  assert.match(source,/host\.vmQueryViaElevation=false/);
});

test('stale privileges and old elevation-only probes cannot provision, stop or restart VM',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-focus-guard-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  let commands=0;
  const baseline=()=>({windows:true,edition:'Windows 11 Pro',hostName:'HOST',
    hyperVFeatureEnabled:true,hyperVModuleInstalled:true,vmServiceRunning:true,
    vmQueryAuthorized:false,vmQueryViaElevation:false,vmExists:true,vmState:'Running',
    shareExists:false,sharePath:'',totalMemoryMiB:32612,logicalProcessors:12,
    freeMemoryMiB:16000,freeDiskGiB:300});
  let report=baseline();
  const wb=new WindowsWorkbench({dataDir:root,sharedRoot:path.join(root,'workspace'),
    probe:async()=>({...report}),mediaInspector:async()=>({kind:'windows-iso',size:7000000000,
      path:'C:\\Fixture\\Windows.iso'}),
    command:async()=>{commands++;throw Error('No host VM command permitted without verified background authority')}});
  await wb.configure({expectedRevision:1,mediaPath:'C:\\Fixture\\Windows.iso'});
  let status=await wb.status({fresh:true});
  assert.equal(status.capability.canManageVM,false);
  assert.equal(status.canStart,false);
  assert.equal(status.canStop,false);
  assert.equal(status.canProvision,false);
  await assert.rejects(wb.stop(),{code:'WORKBENCH_STOP_UNAVAILABLE'});
  await assert.rejects(wb.start(),{code:'WORKBENCH_START_UNAVAILABLE'});
  await assert.rejects(wb.provision(),{code:'WORKBENCH_PROVISION_UNAVAILABLE'});
  assert.equal(commands,0);
  report={...baseline(),vmQueryAuthorized:true,vmQueryViaElevation:true,vmExists:false,vmState:'NotInstalled'};
  status=await wb.status({fresh:true});
  assert.equal(status.capability.canManageVM,false);
  assert.equal(status.canProvision,false);
  await assert.rejects(wb.provision(),{code:'WORKBENCH_PROVISION_UNAVAILABLE'});
  assert.equal(commands,0);
});

test('pre-authorized background Hyper-V token still supports persistent guest operations',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-focus-background-authorized-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const iso='C:\\Fixtures\\Windows.iso';
  let exists=false,vmState='NotInstalled',commands=0;
  const probe=async()=>({windows:true,edition:'Windows 11 Pro',hostName:'HOST',
    hyperVFeatureEnabled:true,hyperVModuleInstalled:true,vmServiceRunning:true,
    vmQueryAuthorized:true,vmQueryViaElevation:false,vmQueryError:'',
    vmExists:exists,vmState,vmProcessorCount:0,vmAssignedMemoryMiB:0,
    shareExists:false,sharePath:'',totalMemoryMiB:32612,logicalProcessors:12,
    freeMemoryMiB:16000,freeDiskGiB:300});
  const wb=new WindowsWorkbench({dataDir:root,sharedRoot:path.join(root,'workspace'),probe,
    mediaInspector:async()=>({kind:'windows-iso',path:iso,size:7237533696}),
    command:async script=>{
      commands++;
      if(script.includes('New-VM')){exists=true;vmState='Off'}
      else if(script.includes('Start-VM'))vmState='Running';
      else if(script.includes('Stop-VM'))vmState='Off';
      return 'BACKGROUND_OK';
    }});
  await wb.configure({expectedRevision:1,mediaPath:iso});
  assert.equal((await wb.status({fresh:true})).canProvision,true);
  await wb.provision();
  assert.equal((await wb.status({fresh:true})).canStart,true);
  await wb.start();
  assert.equal((await wb.status({fresh:true})).canStop,true);
  await wb.stop();
  assert.equal(vmState,'Off');
  assert.equal(commands,3);
});
