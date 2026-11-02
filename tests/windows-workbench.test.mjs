import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WindowsWorkbench,workbenchResourcePlan,WORKBENCH_VM_NAME} from '../lib/windows-workbench.mjs';

const host=overrides=>({windows:true,edition:'Microsoft Windows 11 Pro',logicalProcessors:12,
  totalMemoryMiB:32768,freeMemoryMiB:17000,hostName:'TESTHOST',hypervisorPresent:true,vmQueryAuthorized:true,
  hyperVModuleInstalled:false,vmServiceRunning:false,vmExists:false,vmState:'NotInstalled',
  shareExists:false,sharePath:'',...overrides});
const fixture=async(t,{probe}={})=>{
  const dir=await fs.mkdtemp(path.join(tmpdir(),'blackice-workbench-'));
  t.after(()=>fs.rm(dir,{force:true,recursive:true}));
  return {dir,workbench:new WindowsWorkbench({dataDir:dir,probe:probe||(()=>host())})};
};
test('adaptive resources require no profile, leave host capacity, and let Hyper-V manage guest RAM on demand',()=>{
  const full=workbenchResourcePlan(host());
  assert.equal(full.mode,'adaptive');
  assert.equal(full.available,true);
  assert.equal(full.minimumMiB,4096);
  assert.equal(full.startupMiB,4096);
  assert.equal(full.dynamicMemory,true);
  assert.equal(full.maximumMiB,26112);
  assert.equal(full.cpuCount,10);
  assert.ok(full.maximumMiB>8192,'An arbitrary profile must not cap a capable host to 8 GiB.');
  const smaller=workbenchResourcePlan(host({totalMemoryMiB:16384,freeMemoryMiB:12000,logicalProcessors:8}));
  assert.ok(smaller.maximumMiB<full.maximumMiB);
  assert.ok(smaller.cpuCount<full.cpuCount);
  assert.equal(workbenchResourcePlan(host({freeMemoryMiB:2000})).available,false);
  assert.equal(workbenchResourcePlan(host({totalMemoryMiB:4096})).available,false);
  assert.equal(workbenchResourcePlan({}).available,false);
});
test('without a provisioned Hyper-V guest, Workbench is readable but cannot launch native apps or steal foreground',async t=>{
  const {workbench,dir}=await fixture(t),s=await workbench.status();
  assert.equal(s.backend,'hyper-v');
  assert.equal(s.vmName,WORKBENCH_VM_NAME);
  assert.equal(s.guest.exists,false);assert.equal(s.guest.displayReady,false);
  assert.equal(s.workspaceReady,false);assert.equal(s.canStart,false);assert.equal(s.canRunNativeApps,false);
  assert.equal(s.config.folders[0].readWrite,true);
  assert.ok(s.config.folders[0].hostExists);
  assert.equal(s.config.folders[0].guestMountVerified,false);
  await assert.rejects(workbench.start(),{code:'WORKBENCH_START_UNAVAILABLE'});
  await assert.rejects(workbench.stop(),{code:'WORKBENCH_STOP_UNAVAILABLE'});
  assert.equal((await fs.readdir(dir)).includes('windows-workbench.json'),false);
});
test('user-selected existing host folders remain readable and writable from host; guest shares require separate proof',async t=>{
  const {workbench,dir}=await fixture(t);
  const extra=path.join(dir,'project-share');await fs.mkdir(extra);
  let status=await workbench.status();
  const newFolders=[...status.config.folders.map(({id,hostPath,shareName,readWrite})=>({id,hostPath,shareName,readWrite})),
    {id:'project',hostPath:extra,shareName:'BLACKICE-Project',readWrite:true}];
  status=await workbench.configure({expectedRevision:status.config.revision,folders:newFolders});
  assert.equal(status.config.revision,2);
  assert.equal(status.config.folders.length,2);
  assert.equal(status.config.folders[1].hostPath,extra);
  assert.equal(status.config.folders[1].hostSharePrepared,false);
  assert.equal(status.config.folders[1].guestMountVerified,false);
  assert.ok(status.config.folders[1].expectedGuestUNC.endsWith('\\BLACKICE-Project'));
  assert.equal(Object.hasOwn(status.config,'profile'),false);
  await assert.rejects(workbench.configure({expectedRevision:1}),{code:'WORKBENCH_CONFIG_CONFLICT'});
  const reopened=new WindowsWorkbench({dataDir:dir,probe:()=>host()});
  const again=await reopened.status();
  assert.equal(Object.hasOwn(again.config,'profile'),false);
  assert.equal(again.config.folders[1].hostPath,extra);
  const bad=again.config.folders.map(x=>({id:x.id,hostPath:x.hostPath,shareName:x.shareName,readWrite:x.readWrite}));
  bad[1].shareName='BLACKICE-Workspace';
  await assert.rejects(reopened.configure({expectedRevision:2,folders:bad}),{code:'WORKBENCH_SHARE_INVALID'});
  assert.equal((await reopened.status()).config.revision,2);
});
test('Workbench primary bidirectional folder is the actual BLACKICE working directory, not an invented data silo',async t=>{
  const {dir}=await fixture(t);
  const sharedRoot=path.join(dir,'real-agent-workspace');
  await fs.mkdir(sharedRoot);
  const workbench=new WindowsWorkbench({dataDir:path.join(dir,'data'),sharedRoot,probe:()=>host()});
  const s=await workbench.status();
  assert.equal(s.config.folders[0].hostPath,sharedRoot);
  assert.equal(s.config.folders[0].readWrite,true);
  assert.equal(s.config.folders[0].hostExists,true);
  assert.equal(s.config.folders[0].guestMountVerified,false);
});

test('host cannot report a usable guest until both the verified SMB path and interactive guest handshake agree',async t=>{
  const {dir}=await fixture(t);
  const shared=path.join(dir,'actual-workspace');
  await fs.mkdir(shared,{recursive:true});
  let shareValid=false;
  const agent={online:true,paired:true,sharedReadWriteVerified:true,
    displayReady:true,capabilities:['probe','capture','launch','click'],lastFrameId:'a'.repeat(32)};
  const probe=()=>host({vmExists:true,vmState:'Running',hyperVModuleInstalled:true,
    hyperVFeatureEnabled:true,vmServiceRunning:true,shareExists:shareValid,
    sharePath:shared,hostName:'TESTHOST'});
  const wb=new WindowsWorkbench({dataDir:path.join(dir,'guest-config'),sharedRoot:shared,probe,
    guestBridgeFactory:({sharedRoot})=>({workspace:path.resolve(sharedRoot),agentStatus:async()=>agent})});
  let s=await wb.status();
  assert.equal(s.canRunNativeApps,false);
  assert.equal(s.workspaceReady,false);
  assert.equal(s.config.folders[0].guestMountVerified,false);
  shareValid=true;wb.lastProbe=null;
  s=await wb.status({fresh:true});
  assert.equal(s.canRunNativeApps,true);
  assert.equal(s.workspaceReady,true);
  assert.equal(s.config.folders[0].guestMountVerified,true);
  assert.equal(s.guest.displayReady,true);
  assert.equal(s.guest.agentReady,true);
});

test('Workbench re-batching always reexports the host inventory and creates a fresh guest batch without resetting the VM',async t=>{
  const {dir}=await fixture(t),shared=path.join(dir,'workspace');
  await fs.mkdir(shared);
  const agent={online:true,paired:true,sharedReadWriteVerified:true,displayReady:true,
    capabilities:['probe','capture','launch','batch_install'],lastFrameId:'f'.repeat(32)};
  const calls=[];
  const wb=new WindowsWorkbench({
    dataDir:path.join(dir,'config'),sharedRoot:shared,
    probe:async()=>host({windows:true,hostName:'TESTHOST',hyperVModuleInstalled:true,
      hyperVFeatureEnabled:true,vmServiceRunning:true,vmExists:true,vmState:'Running',
      shareExists:true,sharePath:shared}),
    guestBridgeFactory:options=>({
      workspace:path.resolve(options.sharedRoot),
      agentStatus:async()=>agent,
      request:async(kind,args)=>{
        calls.push({kind,args});
        return {status:'completed',result:{scheduled:true,workerPid:100}};
      }
    }),
    appSyncFactory:options=>{
      const stub={workspace:path.resolve(options.sharedRoot),exportNumber:0,
        exportHost:async()=>({snapshotId:String(++stub.exportNumber).padStart(32,'0'),
          packageCount:2,sha256:'a'.repeat(64),createdAt:new Date().toISOString()}),
        discover:async()=>({status:'completed',added:[],counts:{}}),
        reserve:async({snapshotId})=>({
          version:1,runId:String(calls.length+1).padStart(32,'0'),
          snapshotId,manifestSha256:'a'.repeat(64),totalPackages:2,status:'requested'}),
        markDispatch:async(id,dispatch)=>({runId:id,status:dispatch.result?.scheduled?'queued':'dispatch_uncertain'})
      };
      return stub;
    }
  });
  const first=await wb.rebatchInstalledApps();
  const second=await wb.rebatchInstalledApps();
  assert.equal(first.run.status,'queued');
  assert.equal(second.run.status,'queued');
  assert.notEqual(first.inventory.snapshotId,second.inventory.snapshotId);
  assert.deepEqual(calls.map(x=>x.kind),['batch_install','batch_install']);
  assert.notEqual(calls[0].args.snapshotId,calls[1].args.snapshotId);
  assert.equal((await wb.status()).canRunNativeApps,true);
});
test('Workbench refuses app re-batching without an observed paired guest and never exports host software in that state',async t=>{
  const {dir}=await fixture(t);
  let attempted=0;
  const wb=new WindowsWorkbench({dataDir:dir,sharedRoot:path.join(dir,'workspace'),
    probe:async()=>host(),appSyncFactory:options=>({
      workspace:path.resolve(options.sharedRoot),
      exportHost:async()=>{attempted++}
    })});
  await assert.rejects(wb.rebatchInstalledApps(),{code:'WORKBENCH_APP_SYNC_GUEST_UNAVAILABLE'});
  assert.equal(attempted,0);
});

test('when Hyper-V inventory permissions fail, Workbench refuses to infer that a VM is absent',async t=>{
  const {dir}=await fixture(t);
  const wb=new WindowsWorkbench({dataDir:dir,probe:async()=>host({
    hyperVFeatureEnabled:true,hyperVModuleInstalled:true,vmServiceRunning:true,
    vmQueryAuthorized:false,vmQueryError:'Access denied to Get-VM',
    vmExists:false,vmState:'Unknown',freeDiskGiB:200
  })});
  const s=await wb.status();
  assert.equal(s.capability.canManageVM,false);
  assert.equal(s.guest.state,'Unknown');
  assert.equal(s.canProvision,false);
  assert.equal(s.canStart,false);
  assert.ok(s.blockers.some(b=>b.includes('hidden administrator helper')));
});

test('dedicated Hyper-V guest can be started headlessly with bounded dynamic memory; running is not agent-ready',async t=>{
  let observed=host({hyperVModuleInstalled:true,vmServiceRunning:true,vmExists:true,vmState:'Off'});
  const scripts=[];
  const {dir}=await fixture(t);
  const workbench=new WindowsWorkbench({dataDir:dir,probe:()=>observed,
    command:async script=>{scripts.push(script);observed=host({hyperVModuleInstalled:true,vmServiceRunning:true,vmExists:true,
      vmState:scripts.length===1?'Running':'Off',vmProcessorCount:4,vmAssignedMemoryMiB:scripts.length===1?4096:0});return ''}});
  const off=await workbench.status();
  assert.equal(off.canStart,true);assert.equal(off.canStop,false);
  const started=await workbench.start();
  assert.equal(started.guest.running,true);assert.equal(started.workspaceReady,false);
  assert.equal(started.canRunNativeApps,false);
  assert.match(scripts[0],/Set-VMMemory.*-DynamicMemoryEnabled \$true/);
  assert.match(scripts[0],/Set-VMProcessor.*-Count 10/);
  assert.match(scripts[0],/Start-VM -Name 'BLACKICE-Workbench'/);
  assert.doesNotMatch(scripts[0],/vmconnect|VirtualMachineConnect|Show-Window/);
  const stopped=await workbench.stop();
  assert.equal(stopped.guest.running,false);
  assert.match(scripts[1],/Stop-VM -Name 'BLACKICE-Workbench' -Confirm:\$false -ErrorAction Stop(?:\r?\n|$)/);
  assert.doesNotMatch(scripts[1],/-(?:Shutdown|Force|TurnOff|Save)\b/i,'Plain Stop-VM requests a graceful guest shutdown without forced power loss or save.');
});
