import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {inspectWorkbenchMedia,windowsWorkbenchProvisioningScript,
  WORKBENCH_INSTALL_MEDIA_MIN_BYTES} from '../lib/workbench-provisioning.mjs';
import {WindowsWorkbench,workbenchResourcePlan} from '../lib/windows-workbench.mjs';

const validPath='C:\\Users\\user\\Downloads\\Win11_25H2_x64.iso';
const describe={isFile:()=>true,size:5*1024*1024*1024};
const disk={windows:true,edition:'Windows 11 Pro',logicalProcessors:12,totalMemoryMiB:32768,
  freeMemoryMiB:18000,freeDiskGiB:160,hyperVFeatureEnabled:true,hyperVModuleInstalled:true,vmQueryAuthorized:true,
  vmServiceRunning:true,vmExists:false,vmState:'NotInstalled',hostName:'HOST',shareExists:false};
const inspect=async p=>({path:p,kind:'windows-iso',valid:true,size:describe.size,checked:true});

test('genuine Windows installation media is verified without mounting or copying it',async()=>{
  let sawOffset=null,closed=false;
  const result=await inspectWorkbenchMedia(validPath,{stat:async()=>describe,
    open:async()=>({read:async(bytes,offset,len,position)=>{
      assert.equal(len,5);sawOffset=position;bytes.write('CD001',0,'ascii');return {bytesRead:5};
    },close:async()=>{closed=true}})});
  assert.equal(sawOffset,0x8001);
  assert.equal(closed,true);
  assert.equal(result.kind,'windows-iso');
  assert.equal(result.size,describe.size);
  await assert.rejects(inspectWorkbenchMedia('C:\\Windows\\winre.wim'),{code:'WORKBENCH_MEDIA_PATH'});
  await assert.rejects(inspectWorkbenchMedia(validPath,{stat:async()=>({isFile:()=>true,size:WORKBENCH_INSTALL_MEDIA_MIN_BYTES-1})}),{code:'WORKBENCH_MEDIA_MISSING'});
  await assert.rejects(inspectWorkbenchMedia(validPath,{stat:async()=>describe,
    open:async()=>({read:async()=>({bytesRead:0}),close:async()=>{}})}),{code:'WORKBENCH_MEDIA_SIGNATURE'});
});

test('provisioning produces a bounded generation 2, Win11-compatible TPM/Secure Boot Windows guest and never reboots',()=>{
  const resources=workbenchResourcePlan(disk);
  const src=windowsWorkbenchProvisioningScript({isoPath:validPath,
    vmRoot:'C:\\Users\\user\\AppData\\Roaming\\Relay\\data\\workbench-vm',resources});
  for(const term of ['New-VM','-Generation 2','-NewVHDSizeBytes 160GB','-DynamicMemoryEnabled $true',
    'Set-VMKeyProtector','-NewLocalKeyProtector','Enable-VMTPM','-SecureBootTemplate MicrosoftWindows',
    'Add-VMDvdDrive','Set-VMFirmware','-FirstBootDevice','-AutomaticStopAction ShutDown'])
    assert.ok(src.includes(term),term);
  for(const term of ['Restart-Computer','Stop-Computer','-TurnOff','Remove-VM','Remove-Item','Start-VM','New-VMSwitch'])
    assert.ok(!src.includes(term),term);
  assert.ok(!src.includes(validPath),'The input media path is encoded, not interpolated into PowerShell text.');
  const injected="C:\\Users\\o'hare\\Downloads\\Win11.iso";
  const safe=windowsWorkbenchProvisioningScript({isoPath:injected,vmRoot:'C:\\safe\\guest',resources});
  assert.ok(!safe.includes("o'hare"),'User-selected paths never become raw PowerShell code.');
});

test('host Workbench refuses provisioning until bootable media, Hyper-V and disk resources really exist',async t=>{
  const dir=await fs.mkdtemp(path.join(tmpdir(),'wb-provision-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let host={...disk,hyperVModuleInstalled:false,vmServiceRunning:false};
  let calls=0;
  const wb=new WindowsWorkbench({dataDir:dir,sharedRoot:path.join(dir,'workspace'),
    probe:async()=>host,mediaInspector:inspect,
    command:async script=>{calls++;host={...disk,vmExists:true,vmState:'Off'};assert.match(script,/New-VM/);return 'WORKBENCH_VM_PROVISIONED_NOT_BOOTED';}});
  let state=await wb.status();
  assert.equal(state.canProvision,false);
  await assert.rejects(wb.provision(),{code:'WORKBENCH_PROVISION_UNAVAILABLE'});
  state=await wb.configure({expectedRevision:state.config.revision,mediaPath:validPath});
  assert.equal(state.media.valid,true);
  assert.equal(state.canProvision,false);
  host={...disk};wb.lastProbe=null;
  state=await wb.status({fresh:true});
  assert.equal(state.canProvision,true);
  assert.equal(state.canRunNativeApps,false);
  const result=await wb.provision();
  assert.equal(calls,1);
  assert.equal(result.guest.exists,true);
  assert.equal(result.guest.running,false);
  assert.equal(result.canRunNativeApps,false);
  await assert.rejects(wb.provision(),{code:'WORKBENCH_PROVISION_UNAVAILABLE'});
  const readBack=new WindowsWorkbench({dataDir:dir,sharedRoot:path.join(dir,'workspace'),
    probe:async()=>host,mediaInspector:inspect});
  assert.equal((await readBack.status()).config.mediaPath,validPath);
});
test('restart-needed feature state blocks provisioning, yet reports restart rather than falsely claiming disabled',async t=>{
  const dir=await fs.mkdtemp(path.join(tmpdir(),'wb-reboot-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const wb=new WindowsWorkbench({dataDir:dir,probe:async()=>({...disk,vmServiceRunning:false}),
    mediaInspector:inspect});
  const state=await wb.status();
  assert.equal(state.capability.hyperVFeatureEnabled,true);
  assert.equal(state.capability.windowsRestartNeeded,true);
  assert.ok(state.blockers.some(x=>/Restart Windows/.test(x)));
  assert.equal(state.canProvision,false);
});
