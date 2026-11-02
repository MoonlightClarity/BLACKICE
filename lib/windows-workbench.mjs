import {promises as fs} from 'node:fs';
import {runHiddenWorkbenchPowerShell} from './workbench-elevated-command.mjs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {inspectWorkbenchMedia,windowsWorkbenchProvisioningScript,WORKBENCH_VHDX_GIB} from './workbench-provisioning.mjs';
import {discoverWorkbenchMedia,workbenchMediaSearchFolders} from './workbench-media-discovery.mjs';
import {WORKBENCH_HOST_FOCUS_POLICY} from './workbench-elevated.mjs';
import {WorkbenchDirectConsole} from './workbench-direct-console.mjs';
import {WorkbenchConsoleControl} from './workbench-console-control.mjs';
import {WorkbenchGuestBridge} from './workbench-guest-bridge.mjs';
import {WorkbenchAppSync} from './workbench-app-sync.mjs';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import {nativeConnectionAttempt,nativeAttemptAvailabilityMeaning} from './workbench-native-diagnostics.mjs';

export const WORKBENCH_VM_NAME='BLACKICE-Workbench';
export const WORKBENCH_SHARE_NAME='BLACKICE-Workspace';
const fail=(message,code='WORKBENCH_INVALID',status=409)=>Object.assign(new Error(message),{code,status});
const clone=x=>structuredClone(x);
const nativeUnavailable=()=>fail('The verified native guest console is not attached.','WORKBENCH_NATIVE_UNAVAILABLE',503);
function nativeSurface(value){
  if(!value||![value.width,value.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=4096))
    throw fail('Native guest surface dimensions are invalid.','WORKBENCH_NATIVE_FRAME_INVALID',502);
  return {width:value.width,height:value.height};
}
export function validateGuestNativeConsoleInput(value,surface){
  const mouse=value?.kind==='mouse',allowed=mouse?['kind','x','y','flags']:['kind','scanCode','flags'];
  if(!value||typeof value!=='object'||Array.isArray(value)||!['mouse','key'].includes(value.kind)||
    Object.keys(value).length!==allowed.length||Object.keys(value).some(key=>!allowed.includes(key))||
    !Number.isSafeInteger(value.flags)||value.flags<0||value.flags>65535)
    throw fail('Native guest input requires bounded mouse or keyboard fields only.','WORKBENCH_NATIVE_INPUT_INVALID',400);
  if(mouse){
    const limit=surface?nativeSurface(surface):{width:4096,height:4096};
    if(!Number.isSafeInteger(value.x)||!Number.isSafeInteger(value.y)||value.x<0||value.y<0||value.x>=limit.width||value.y>=limit.height)
      throw fail('Native pointer coordinates are outside the decoded guest surface.','WORKBENCH_NATIVE_INPUT_INVALID',400);
    return {kind:'mouse',x:value.x,y:value.y,flags:value.flags};
  }
  if(!Number.isSafeInteger(value.scanCode)||value.scanCode<1||value.scanCode>255||![0,0x100,0x8000,0x8100].includes(value.flags))
    throw fail('Native keyboard input requires a scan code and supported key flags.','WORKBENCH_NATIVE_INPUT_INVALID',400);
  return {kind:'key',scanCode:value.scanCode,flags:value.flags};
}
function nativeFrame(value){
  const surface=nativeSurface(value),bytes=value.bytes;
  if(value.contentType!=='image/bmp'||!Buffer.isBuffer(bytes)||bytes.length<54||bytes.length>4096*4096*4+54||
    bytes.toString('ascii',0,2)!=='BM'||bytes.readUInt32LE(2)!==bytes.length||bytes.readUInt32LE(10)!==54||
    bytes.readUInt32LE(14)!==40||bytes.readInt32LE(18)!==surface.width||Math.abs(bytes.readInt32LE(22))!==surface.height||
    bytes.readUInt16LE(26)!==1||bytes.readUInt16LE(28)!==32||bytes.readUInt32LE(30)!==0||
    bytes.length!==54+surface.width*surface.height*4||!Number.isSafeInteger(value.sequence)||value.sequence<1)
    throw fail('Native guest capture does not match its BMP surface receipt.','WORKBENCH_NATIVE_FRAME_INVALID',502);
  return {...value,...surface,contentType:'image/bmp'};
}
const defaults=(dataDir,sharedRoot)=>({version:1,revision:1,vmName:WORKBENCH_VM_NAME,mediaPath:'',folders:[
 {id:'workspace',hostPath:path.resolve(sharedRoot||path.join(dataDir,'workspace')),shareName:WORKBENCH_SHARE_NAME,readWrite:true}
]});
const PROBE_SCRIPT=[
"$ErrorActionPreference='Stop'",
"$ProgressPreference='SilentlyContinue'",
"$c=Get-CimInstance Win32_ComputerSystem",
"$o=Get-CimInstance Win32_OperatingSystem",
"$disk=Get-CimInstance Win32_LogicalDisk -Filter (\"DeviceID='\"+$env:SystemDrive+\"'\") -ErrorAction SilentlyContinue",
"$module=Get-Module -ListAvailable Hyper-V | Select-Object -First 1",
"$svc=Get-Service -Name vmms -ErrorAction SilentlyContinue",
"$feature=Get-CimInstance Win32_OptionalFeature -Filter \"Name='Microsoft-Hyper-V'\" -ErrorAction SilentlyContinue",
"$pendingRestart=(Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending')",
"$processElevated=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
"$vm=$null",
"$vmQueryAuthorized=$false",
"$vmQueryError=''",
"if($module -and $svc){try{Import-Module Hyper-V -ErrorAction Stop; Get-VM -ErrorAction Stop|Out-Null; $vmQueryAuthorized=$true; $vm=Get-VM -Name 'BLACKICE-Workbench' -ErrorAction SilentlyContinue}catch{$vmQueryError=$_.Exception.Message}}",
"$share=Get-SmbShare -Name 'BLACKICE-Workspace' -ErrorAction SilentlyContinue",
"[ordered]@{",
"windows=($null -ne $o -and [string]$o.Caption -match 'Windows')",
"edition=[string]$o.Caption",
"logicalProcessors=[int]$c.NumberOfLogicalProcessors",
"totalMemoryMiB=[int][math]::Floor([double]$o.TotalVisibleMemorySize/1024)",
"freeDiskGiB=$(if($disk){[int][math]::Floor([double]$disk.FreeSpace/1GB)}else{0})",
"freeMemoryMiB=[int][math]::Floor([double]$o.FreePhysicalMemory/1024)",
"hostName=[string]$c.Name",
"hypervisorPresent=[bool]$c.HypervisorPresent",
"hyperVFeatureEnabled=[bool]($feature -and $feature.InstallState -eq 1)",
"featureRestartPending=[bool]$pendingRestart",
"hyperVModuleInstalled=[bool]($null -ne $module)",
"vmServiceRunning=[bool]($svc -and $svc.Status -eq 'Running')",
"vmQueryAuthorized=[bool]$vmQueryAuthorized",
"processElevated=[bool]$processElevated",
"vmQueryError=[string]$vmQueryError",
"vmExists=[bool]($null -ne $vm)",
"vmState=$(if($vm){[string]$vm.State}elseif($vmQueryAuthorized){'NotInstalled'}else{'Unknown'})",
"vmProcessorCount=$(if($vm){[int]$vm.ProcessorCount}else{0})",
"vmAssignedMemoryMiB=$(if($vm){[int][math]::Floor([double]$vm.MemoryAssigned/1MB)}else{0})",
"shareExists=[bool]($null -ne $share)",
"sharePath=$(if($share){[string]$share.Path}else{''})",
"}|ConvertTo-Json -Compress -Depth 4"
].join('\n');
async function powershell(script,timeout=25000){
  // The Electron host remains asInvoker to allow Chromium renderers.
  // A hidden, one-shot elevated PowerShell owns Hyper-V operations on the
  // tested Never notify Windows setup. No task-time window or host input.
  return runHiddenWorkbenchPowerShell(script,{timeoutMs:timeout});
}
export async function probeWindowsWorkbench(){
  try{
    // Only the hidden Workbench helper runs elevated; the Electron browser
    // itself remains unelevated. Other UAC modes fail without attempting UAC.
    const host=JSON.parse((await powershell(PROBE_SCRIPT)).trim());
    host.vmQueryViaElevation=false;
    if(host.windows&&host.hyperVModuleInstalled&&host.vmServiceRunning&&host.vmQueryAuthorized!==true){
      // Status polling MUST NOT perform interactive elevation, even as a
      // fallback. Keep VM inventory unknown instead of disturbing the host.
      host.vmQueryError=(host.vmQueryError||'Hyper-V inventory unavailable')+
        ' — '+WORKBENCH_HOST_FOCUS_POLICY;
    }
    return host;
  }catch(error){throw fail('Workbench host capability check failed: '+String(error.message).slice(0,250),'WORKBENCH_PROBE_FAILED',503)}
}
/**
 * One resource policy, no user profiles or tuning UI. Hyper-V itself
 * grows/shrinks RAM in response to guest demand within host-safe bounds.
 * Virtual processors are provisioned once per off->on transition; Windows
 * schedules their actual CPU usage dynamically while the VM runs.
 */
export function workbenchResourcePlan(host){
  const total=Math.max(0,Number(host?.totalMemoryMiB)||0);
  const free=Math.max(0,Number(host?.freeMemoryMiB)||0);
  const cores=Math.max(0,Number(host?.logicalProcessors)||0);
  if(!total||!cores||total<8192||cores<4)
    return {mode:'adaptive',available:false,reason:'Windows 11 guest needs a host with at least 8 GiB RAM and four logical processors.'};
  // Always leave capacity for the real user's active Windows desktop.
  const hostReserveMiB=Math.max(4096,Math.ceil(total*.2/512)*512);
  const minimumMiB=4096,startupMiB=4096;
  const maximumMiB=Math.floor((total-hostReserveMiB)/512)*512;
  const cpuCount=Math.min(16,cores-2);
  const available=maximumMiB>=startupMiB&&free>=startupMiB+2048;
  return {mode:'adaptive',available,minimumMiB,startupMiB,maximumMiB,
    cpuCount,dynamicMemory:true,
    ...(available?{}:{reason:'Not enough currently free host memory for the guest startup and host reserve.'})};
}
export class WindowsWorkbench{
  constructor({dataDir,sharedRoot,probe=probeWindowsWorkbench,command=powershell,consoleController=new WorkbenchDirectConsole(),mediaInspector=inspectWorkbenchMedia,guestBridgeFactory=options=>new WorkbenchGuestBridge(options),appSyncFactory=options=>new WorkbenchAppSync(options)}={}){
    if(typeof dataDir!=='string'||!path.isAbsolute(dataDir))throw fail('Workbench data folder missing.','WORKBENCH_DATA_DIR',500);
    this.dataDir=dataDir;this.file=path.join(dataDir,'windows-workbench.json');
    this.probe=probe;this.command=command;this.consoleController=consoleController;this.mediaInspector=mediaInspector;this.guestBridgeFactory=guestBridgeFactory;
    this.appSyncFactory=appSyncFactory;this.appSync=null;
    this.consoleControl=new WorkbenchConsoleControl();this.nativeConsoleAdapter=null;
    this.guestBridge=null;this.config=defaults(dataDir,sharedRoot);
    this.ready=null;this.queue=Promise.resolve();this.lastProbe=null;this.probedAt=0;
    this.hostBaseline=null;this.hostProbeFlight=null;
  }
  validate(value){
    if(!value||value.version!==1||!Number.isSafeInteger(value.revision)||value.revision<1||
      value.vmName!==WORKBENCH_VM_NAME||!Array.isArray(value.folders)||
      !value.folders.length||value.folders.length>12 || (value.mediaPath!==undefined &&
      (typeof value.mediaPath!=='string' || value.mediaPath.length>3500 || value.mediaPath && !path.win32.isAbsolute(value.mediaPath))))
      throw fail('Invalid saved Workbench configuration.','WORKBENCH_CONFIG_INVALID',400);
    const ids=new Set(),names=new Set();
    for(const f of value.folders){
      if(!f||!/^[a-z][a-z0-9_-]{0,39}$/.test(f.id)||!path.win32.isAbsolute(f.hostPath||'')||
        f.hostPath.length>3500||f.hostPath.includes('\0')||!/^[A-Za-z][A-Za-z0-9_-]{2,55}$/.test(f.shareName||'')||
        typeof f.readWrite!=='boolean'||ids.has(f.id)||names.has(f.shareName.toLowerCase()))
        throw fail('Invalid Workbench shared folder.','WORKBENCH_SHARE_INVALID',400);
      ids.add(f.id);names.add(f.shareName.toLowerCase());
    }
    if(value.folders[0].id!=='workspace'||value.folders[0].shareName!==WORKBENCH_SHARE_NAME||
      value.folders[0].readWrite!==true)throw fail('Primary host workspace must be read/write.','WORKBENCH_SHARE_INVALID',400);
  }
  bridge(){
    const folder=this.config.folders[0].hostPath;
    if(!this.guestBridge||this.guestBridge.workspace!==path.resolve(folder))
      this.guestBridge=this.guestBridgeFactory({sharedRoot:folder});
    return this.guestBridge;
  }
  appSyncService(){
    const folder=this.config.folders[0].hostPath;
    if(!this.appSync||this.appSync.workspace!==path.resolve(folder))
      this.appSync=this.appSyncFactory({sharedRoot:folder});
    return this.appSync;
  }
  async init(){return this.ready||=(async()=>{
    await fs.mkdir(this.dataDir,{recursive:true});
    await fs.mkdir(this.config.folders[0].hostPath,{recursive:true});
    try{const value=JSON.parse(await fs.readFile(this.file,'utf8'));this.validate(value);
      const {profile:_noLongerUsed,...saved}=value;this.config={...this.config,...saved}}
    catch(error){if(error.code!=='ENOENT')throw fail('Saved Workbench settings are unreadable. Original bytes preserved.','WORKBENCH_CONFIG_DAMAGED',500)}
    return this;
  })();}
  async probeNow(fresh=false){
    if(!fresh&&this.lastProbe&&Date.now()-this.probedAt<8000)return clone(this.lastProbe);
    try{
      // Cache a denied helper probe instead of relaunching background
      // elevation on every routine status refresh. A normal app restart
      // rechecks the tested helper authority.
      let p;
      if(this.hostBaseline&&this.hostBaseline.vmQueryAuthorized!==true){
        p=clone(this.hostBaseline);
        if(process.platform==='win32'){
          p.freeMemoryMiB=Math.floor(os.freemem()/1048576);
          p.totalMemoryMiB=Math.floor(os.totalmem()/1048576);
          try{
            const disk=await fs.statfs(this.dataDir);
            if(disk.bsize>0&&disk.bavail>=0)
              p.freeDiskGiB=Math.floor(disk.bsize*disk.bavail/1073741824);
          }catch{/* Preserve the last verified filesystem capacity. */}
        }
      }else{
        if(!this.hostProbeFlight)
          this.hostProbeFlight=Promise.resolve().then(()=>this.probe())
            .finally(()=>{this.hostProbeFlight=null});
        p=await this.hostProbeFlight;
        if(!p||typeof p!=='object')throw Error('Empty host probe');
        this.hostBaseline=clone(p);
      }
      // The Electron window remains asInvoker. Hyper-V is controlled by a
      // hidden administrator helper, never by a SYSTEM scheduled task.
      p.vmQueryViaBroker=false;
      p.headlessBrokerReady=false;
      p.headlessBrokerReason='The separate SYSTEM broker is retired. Guest input uses the administrator-approved BLACKICE process.';
      this.lastProbe=p;this.probedAt=Date.now();
      return clone(p);
    }catch(error){return {windows:process.platform==='win32',vmState:'Unknown',probeError:String(error.message||error).slice(0,400)}}
  }
  async status({fresh=false}={}){
    await this.init();const h=await this.probeNow(fresh),resources=workbenchResourcePlan(h);
    const hv=!!(h.windows&&h.hyperVModuleInstalled&&h.vmServiceRunning);
    // Never consider an interactive-elevation result valid for host-background management.
    const vmInventoryReady=hv&&h.vmQueryAuthorized===true&&h.vmQueryViaElevation!==true;
    const vmExists=vmInventoryReady&&h.vmExists===true,running=vmExists&&h.vmState==='Running',folders=[];
    let guestAgent={online:false,paired:false,sharedReadWriteVerified:false,displayReady:false};
    try{guestAgent=await this.bridge().agentStatus()}catch(error){guestAgent={...guestAgent,probeError:String(error.message).slice(0,250)}}
    const mediaPath=this.config.mediaPath||'';
    let media={path:mediaPath,valid:false,error:'Select an existing official Windows 11 ISO for this guest.'};
    if(mediaPath)try{media={...await this.mediaInspector(mediaPath),valid:true}}
    catch(error){media={path:mediaPath,valid:false,error:error.message}}
    for(const f of this.config.folders){
      let exists=false;try{exists=(await fs.stat(f.hostPath)).isDirectory()}catch{}
      const prepared=f.id==='workspace'&&h.shareExists===true&&
        path.win32.normalize(h.sharePath||'').toLowerCase()===path.win32.normalize(f.hostPath).toLowerCase();
      folders.push({...f,hostExists:exists,hostSharePrepared:prepared,
        guestMountVerified:Boolean(prepared&&f.id==='workspace'&&running&&guestAgent.sharedReadWriteVerified),
        expectedGuestUNC:'\\\\'+(h.hostName||'BLACKICE-HOST')+'\\'+f.shareName});
    }
    const blockers=[];
    if(!h.windows)blockers.push('Windows host not available');
    if(h.hyperVFeatureEnabled && !h.vmServiceRunning)blockers.push('Restart Windows to finish enabling Hyper-V (no restart will be initiated automatically)');
    else if(!h.hyperVModuleInstalled)blockers.push('Hyper-V management feature not installed');
    if(!h.vmServiceRunning && !h.hyperVFeatureEnabled)blockers.push('Hyper-V service not available');
    if(hv&&!vmInventoryReady)blockers.push('Workbench could not verify its hidden administrator helper. BLACKICE stays unelevated for the Browser tab; tested Windows setting is UAC Never notify. The VM remains Unknown until Get-VM succeeds.');
    if(vmInventoryReady&&!vmExists)blockers.push('Dedicated Windows guest not provisioned');
    if(!vmExists&&!media.valid)blockers.push(media.error);
    if(!vmExists&&h.freeDiskGiB!=null&&h.freeDiskGiB<50)blockers.push('At least 50 GiB free host disk space is needed before provisioning a Windows guest');
    if(!folders.every(f=>f.hostSharePrepared))blockers.push('Host SMB share not configured');
    if(!folders.every(f=>f.guestMountVerified))blockers.push('Guest shared-folder read/write mount not verified');
    if(running&&!guestAgent.paired)blockers.push('Guest display and control agent not yet paired');
    if(running&&guestAgent.paired&&!guestAgent.displayReady)blockers.push('Guest display capture has not been verified');
    return {backend:'hyper-v',vmName:WORKBENCH_VM_NAME,
      capability:{windows:!!h.windows,edition:h.edition||'',hostName:h.hostName||null,hypervisorPresent:!!h.hypervisorPresent,
        hyperVModuleInstalled:!!h.hyperVModuleInstalled,vmServiceRunning:!!h.vmServiceRunning,
        canManageVM:vmInventoryReady,vmManagementViaElevation:!!h.vmQueryViaElevation,vmManagementViaBroker:false,
        processElevated:h.processElevated===true,consoleBackend:h.processElevated===true?'elevated-process':null,
        headlessBrokerReady:!!h.headlessBrokerReady,headlessBrokerReason:h.headlessBrokerReason||null,vmQueryError:h.vmQueryError||null,
        hyperVFeatureEnabled:!!h.hyperVFeatureEnabled,windowsRestartNeeded:!!(h.hyperVFeatureEnabled&&!h.vmServiceRunning),
        logicalProcessors:h.logicalProcessors||null,totalMemoryMiB:h.totalMemoryMiB||null,freeMemoryMiB:h.freeMemoryMiB||null,freeDiskGiB:h.freeDiskGiB??null,
        ...(h.probeError?{probeError:h.probeError}:{})},
      guest:{exists:vmExists,state:h.vmState||'Unknown',running,memoryAssignedMiB:h.vmAssignedMemoryMiB||null,
        processorCount:h.vmProcessorCount||null,displayReady:running&&guestAgent.displayReady,
        agentReady:running&&guestAgent.paired,agent:guestAgent},
      resources,media,storage:{virtualDiskGiB:WORKBENCH_VHDX_GIB},config:{...clone(this.config),folders},
      consoleControl:this.consoleControl.status(),
      workspaceReady:running&&folders.every(f=>f.guestMountVerified),
      canRunNativeApps:running&&folders[0].guestMountVerified&&guestAgent.paired&&
        guestAgent.capabilities.includes('launch')&&guestAgent.capabilities.includes('capture'),
      canPrepareAgent:Boolean(h.hostName&&folders[0].hostExists),
      canPair:running&&folders[0].hostSharePrepared&&guestAgent.online,
      canProvision:vmInventoryReady&&!vmExists&&resources.available&&media.valid&&h.freeDiskGiB>=50,
      canStart:vmInventoryReady&&vmExists&&h.vmState==='Off'&&resources.available,canStop:running,
      canReadGuestConsole:running&&h.processElevated===true,
      canSendGuestConsoleKeys:running&&h.processElevated===true,
      canTypeGuestConsoleText:running&&h.processElevated===true,
      canClickGuestConsole:running&&h.processElevated===true,blockers};
  }
  async prepareGuestAgent(){
    const state=await this.status({fresh:true});
    if(!state.canPrepareAgent)throw fail('Host workspace is not available for guest bootstrap.','WORKBENCH_BOOTSTRAP_UNAVAILABLE');
    const base=new URL('../scripts/',import.meta.url);
    const [agentScript,setupScript,appBatchScript,videoScript,nativeVideoInstallScript,nativeVideoBinary,rdpPreflightScript,guestDisplayScript]=await Promise.all([
      fs.readFile(fileURLToPath(new URL('workbench-guest-agent.ps1',base)),'utf8'),
      fs.readFile(fileURLToPath(new URL('workbench-guest-setup.ps1',base)),'utf8'),
      fs.readFile(fileURLToPath(new URL('workbench-guest-app-batch.ps1',base)),'utf8'),
      fs.readFile(fileURLToPath(new URL('workbench-desktop-stream.ps1',base)),'utf8'),
      fs.readFile(fileURLToPath(new URL('install-workbench-guest-video.ps1',base)),'utf8'),
      fs.readFile(fileURLToPath(new URL('../resources/guest/workbench-guest-video.exe',base))),
      fs.readFile(fileURLToPath(new URL('workbench-rdp-preflight.ps1',base)),'utf8'),
      fs.readFile(fileURLToPath(new URL('workbench-guest-display.ps1',base)),'utf8')
    ]);
    return this.bridge().prepare({hostName:state.capability.hostName,agentScript,setupScript,appBatchScript,videoScript,nativeVideoInstallScript,nativeVideoBinary,rdpPreflightScript,guestDisplayScript});
  }
  async pairGuest(){
    const state=await this.status({fresh:true});
    if(!state.canPair)throw fail('Start an installed, interactive Windows guest and mount its shared folder before pairing.','WORKBENCH_PAIR_UNAVAILABLE');
    return this.bridge().pair({timeoutMs:12000});
  }
  async guestAction({kind,args,controlToken,expectedAgent}={}){
    const operation=async assertCurrent=>{
      // Reuse the bounded host inventory cache; status still reads the guest
      // heartbeat/pairing now, and the bridge rechecks pairing before dispatch.
      const state=await this.status();
      assertCurrent();
      if(!state.canRunNativeApps)throw fail('No verified Windows guest desktop agent or bidirectional mount is ready.','WORKBENCH_GUEST_UNAVAILABLE');
      return this.bridge().request(kind,args??{},{timeoutMs:12000,...(expectedAgent?{expectedAgent}:{})});
    };
    // Capture and window inspection never take input ownership.
    if(['capture','windows'].includes(kind))return operation(()=>{});
    return this.consoleControl.run(operation,controlToken);
  }
  async guestResult(requestId){return this.bridge().readResult(requestId)}
  guestNativeDesktopAction({kind,args,controlToken,expectedAgent}={}){
    if(!['display_info','display_resize'].includes(kind))throw fail('Choose a supported native display operation.','WORKBENCH_NATIVE_DISPLAY_ACTION',400);
    return this.consoleControl.run(async assertCurrent=>{
      const adapter=this.nativeConsoleAdapter,bridge=this.bridge();
      if(!adapter||typeof adapter.surface!=='function')throw nativeUnavailable();
      nativeSurface(await adapter.surface());assertCurrent();
      if(this.nativeConsoleAdapter!==adapter)throw nativeUnavailable();
      const agent=await bridge.agentStatus();assertCurrent();
      if(!agent.paired||!agent.online||!agent.capabilities?.includes(kind)||!expectedAgent||
        agent.agentId!==expectedAgent.agentId||agent.guestSessionId!==expectedAgent.guestSessionId)
        throw fail('The paired native display agent changed.','WORKBENCH_GUEST_NOT_PAIRED');
      if(this.nativeConsoleAdapter!==adapter||this.bridge()!==bridge)throw nativeUnavailable();
      return bridge.request(kind,args??{},{timeoutMs:6000,expectedAgent});
    },controlToken);
  }
  async guestFrame(requestId){return this.bridge().frame(requestId)}
  // Inspection never requires taking guest control; input is exclusive.
  async guestConsoleFrame(){
    const state=await this.status({fresh:true});
    if(!state.canReadGuestConsole)throw fail('A verified running guest and hidden administrator helper are required. No host window is launched.','WORKBENCH_CONSOLE_UNAVAILABLE',503);
    return this.consoleController.frame();
  }
  takeGuestConsoleControl(){return this.consoleControl.take()}
  cedeGuestConsoleControl(token){return this.consoleControl.cede(token)}
  // The desktop adapter supplies a bounded native acknowledgement. owner:none
  // must disable/close that native input path; the callback must not reenter
  // consoleControl.run(), whose ownership queue is deliberately held here.
  setGuestConsoleOwnershipHook(hook){return this.consoleControl.setTransitionHook(hook)}
  setGuestNativeConsoleAdapter(adapter){
    if(adapter!==null&&(!adapter||typeof adapter.frame!=='function'||typeof adapter.input!=='function'||
      adapter.surface!==undefined&&typeof adapter.surface!=='function'||
      adapter.wake!==undefined&&typeof adapter.wake!=='function'||
      adapter.open!==undefined&&typeof adapter.open!=='function'||
      adapter.availability!==undefined&&typeof adapter.availability!=='function'))throw fail('Native console adapter requires frame and input handlers.','WORKBENCH_NATIVE_ADAPTER_INVALID',400);
    return this.consoleControl.serialize(()=>{this.nativeConsoleAdapter=adapter;return {available:adapter!==null};});
  }
  async guestNativeConsoleFrame(){
    const adapter=this.nativeConsoleAdapter;if(!adapter)throw nativeUnavailable();
    const frame=nativeFrame(await adapter.frame());
    if(this.nativeConsoleAdapter!==adapter)throw nativeUnavailable();
    return frame;
  }
  async guestNativeConsoleStatus(){
    const adapter=this.nativeConsoleAdapter;
    const unavailable={backendAttached:false,openAvailable:false,attached:false,connected:false,displayReady:false,windowVisible:false,uncertain:false,code:'WORKBENCH_NATIVE_UNAVAILABLE'};
    if(!adapter||typeof adapter.open!=='function'||typeof adapter.availability!=='function')return unavailable;
    const value=await adapter.availability();
    if(this.nativeConsoleAdapter!==adapter)throw nativeUnavailable();
    const keys=['backendAttached','openAvailable','attached','connected','displayReady','windowVisible','uncertain'];
    if(!value||keys.some(key=>typeof value[key]!=='boolean')||!/^WORKBENCH_[A-Z0-9_]+$/.test(value.code||''))throw nativeUnavailable();
    const lastConnectionAttempt=nativeConnectionAttempt(value.lastConnectionAttempt);
    return {...Object.fromEntries([...keys.map(key=>[key,value[key]]),['code',value.code]]),
      ...(value.availabilityMeaning===nativeAttemptAvailabilityMeaning?{availabilityMeaning:nativeAttemptAvailabilityMeaning}:{}),
      ...(lastConnectionAttempt?{lastConnectionAttempt}:{})};
  }
  async guestNativeConsoleOpen(assertCaller=()=>{}){
    if(typeof assertCaller!=='function')throw nativeUnavailable();
    const adapter=this.nativeConsoleAdapter,revision=this.consoleControl.status().revision;
    const check=()=>{this.consoleControl.assert(undefined,revision);assertCaller();if(this.nativeConsoleAdapter!==adapter)throw nativeUnavailable();};
    check();if(!adapter||typeof adapter.open!=='function')throw nativeUnavailable();
    // The trusted surface acquires surface.serialize -> console.serialize.
    // Nesting consoleControl.run here would deadlock a pending UI attachment.
    let result;
    try{result=await adapter.open(check);check();}
    catch(error){const attempt=nativeConnectionAttempt(error.nativeConnectionAttempt);if(attempt)error.nativeConnectionAttempt=attempt;else delete error.nativeConnectionAttempt;throw error;}
    if(!result||result.accepted!==true||result.detached!==true||result.uncertain!==false||result.connected!==true||result.displayReady!==true||
      typeof result.opened!=='boolean'||typeof result.windowVisible!=='boolean'||result.opened!==result.windowVisible)
      throw fail('The native viewer did not confirm a verified connection. Inspect status before retrying.','WORKBENCH_NATIVE_UNCERTAIN');
    const lastConnectionAttempt=nativeConnectionAttempt(result.lastConnectionAttempt);
    const {lastConnectionAttempt:ignoredAttempt,...receipt}=result;
    return {...receipt,...(lastConnectionAttempt?{lastConnectionAttempt}:{}),consoleControl:this.consoleControl.status()};
  }
  guestNativeConsoleWake(controlToken,assertCaller=()=>{}){
    if(typeof assertCaller!=='function')throw fail('A native wake caller fence must be a function.','WORKBENCH_NATIVE_WAKE_REJECTED');
    return this.consoleControl.run(async assertCurrent=>{
      const adapter=this.nativeConsoleAdapter;if(!adapter||typeof adapter.wake!=='function')throw nativeUnavailable();
      const owner=this.consoleControl.status().owner;
      const assertAttached=()=>{assertCurrent();assertCaller();if(this.nativeConsoleAdapter!==adapter)throw nativeUnavailable();};
      // Explicit wake uses the current owner's receipt. It must never Take or
      // Cede control, and its adapter must check this fence before dispatch.
      assertAttached();
      const result=await adapter.wake({owner},assertAttached);
      assertAttached();
      return {...result,consoleControl:this.consoleControl.status()};
    },controlToken);
  }
  guestNativeConsoleInput(input,controlToken){
    // Agent-only path. Physical user input belongs to the native child; even a
    // valid user receipt must not authorize this separate input endpoint.
    const value=validateGuestNativeConsoleInput(input);
    return this.consoleControl.run(async assertCurrent=>{
      if(controlToken!==undefined)throw fail('Native agent input does not accept user-control tokens.','WORKBENCH_NATIVE_AGENT_ONLY',409);
      const adapter=this.nativeConsoleAdapter;if(!adapter)throw nativeUnavailable();
      const surface=adapter.surface?nativeSurface(await adapter.surface()):nativeFrame(await adapter.frame());
      assertCurrent();if(this.nativeConsoleAdapter!==adapter)throw nativeUnavailable();
      const bounded=validateGuestNativeConsoleInput(value,surface);
      // Adapters must call assertCurrent again immediately before dispatch
      // after their own asynchronous checks, without reentering this queue.
      return adapter.input(bounded,assertCurrent);
    });
  }
  guestConsoleKey(key,controlToken){
    return this.consoleControl.run(async assertCurrent=>{
      const state=await this.status();
      assertCurrent();
      if(!state.canSendGuestConsoleKeys)throw fail('A verified running guest and hidden administrator helper are required. Host input is never used.','WORKBENCH_CONSOLE_UNAVAILABLE',503);
      return this.consoleController.key(key);
    },controlToken);
  }
  guestConsoleType(text,controlToken){
    return this.consoleControl.run(async assertCurrent=>{
      const state=await this.status();
      assertCurrent();
      if(!state.canTypeGuestConsoleText)throw fail('A verified running guest and hidden administrator helper are required. Host input is never used.','WORKBENCH_CONSOLE_UNAVAILABLE',503);
      return this.consoleController.type(text);
    },controlToken);
  }
  guestConsoleClick(x,y,button=1,controlToken){
    return this.consoleControl.run(async assertCurrent=>{
      const state=await this.status();
      assertCurrent();
      if(!state.canClickGuestConsole)throw fail('A verified running guest and hidden administrator helper are required. The host pointer never moves.','WORKBENCH_CONSOLE_UNAVAILABLE',503);
      return this.consoleController.click(x,y,button);
    },controlToken);
  }
  async findInstallationMedia(){
    await this.init();
    return discoverWorkbenchMedia({directories:workbenchMediaSearchFolders({dataDir:this.dataDir})});
  }
  async launchMicrosoftMediaCreator(){
    // The Microsoft wizard is an interactive HOST program. Even a genuine
    // signed wizard would steal host desktop focus, so Workbench must never
    // launch it. People can explicitly open Microsoft's website themselves.
    throw fail(WORKBENCH_HOST_FOCUS_POLICY,'WORKBENCH_HOST_FOCUS_PROTECTED',503);
  }
  async installedAppSyncStatus(){await this.init();return this.appSyncService().list()}
  async refreshInstalledApps(){await this.init();return this.appSyncService().exportHost()}
  async discoverInstalledAppAlternatives({snapshotId,refresh=false}={}){
    await this.init();return this.appSyncService().discover({snapshotId,refresh});
  }
  async installedAppRecovery(snapshotId){
    await this.init();const receipt=await this.appSyncService().snapshot(snapshotId);
    return this.appSyncService().recovery(snapshotId,receipt.sha256)||{};
  }
  async installedAppSyncRun(runId){await this.init();return this.appSyncService().run(runId)}
  async startInstalledAppBatch({snapshotId}={}){
    const state=await this.status({fresh:true});
    if(!state.canRunNativeApps||!state.guest.agent?.capabilities?.includes('batch_install'))
      throw fail('The paired Windows guest cannot yet perform a verified repeatable app batch.','WORKBENCH_APP_SYNC_GUEST_UNAVAILABLE');
    const sync=this.appSyncService();
    const record=await sync.reserve({snapshotId});
    let dispatch;
    try{
      dispatch=await this.bridge().request('batch_install',{runId:record.runId,
        snapshotId:record.snapshotId,manifestSha256:record.manifestSha256},{timeoutMs:12000});
    }catch(error){
      await sync.markDispatch(record.runId,{status:'failed',message:String(error.message).slice(0,300)});
      throw error;
    }
    return sync.markDispatch(record.runId,dispatch);
  }
  async rebatchInstalledApps(){
    const state=await this.status({fresh:true});
    if(!state.canRunNativeApps||!state.guest.agent?.capabilities?.includes('batch_install'))
      throw fail('Install and pair the guest before syncing its Windows applications.','WORKBENCH_APP_SYNC_GUEST_UNAVAILABLE');
    // Re-scan every time, including if a previous batch completed months ago.
    // The persistent guest, its installed applications and settings are reused.
    const manifest=await this.refreshInstalledApps();
    const discovery=await this.discoverInstalledAppAlternatives({snapshotId:manifest.snapshotId});
    const run=await this.startInstalledAppBatch({snapshotId:manifest.snapshotId});
    return {run,discovery:{resolved:discovery.added?.length||0,counts:discovery.counts||{},
      status:discovery.status},inventory:{snapshotId:manifest.snapshotId,packageCount:manifest.packageCount,
      unmatchedCount:manifest.unmatchedCount||0,unmatchedHostApps:manifest.unmatchedHostApps||[],
      createdAt:manifest.createdAt,warning:manifest.warning||null}};
  }
  async configure({expectedRevision,folders,mediaPath}={}){
    await this.init();
    const pending=this.queue.catch(()=>{}).then(async()=>{
      if(expectedRevision!==this.config.revision)throw fail('Workbench settings changed. Reload current revision.','WORKBENCH_CONFIG_CONFLICT');
      const next={...clone(this.config),revision:this.config.revision+1};
      if(mediaPath!==undefined)next.mediaPath=mediaPath;
      if(folders!==undefined)next.folders=folders.map(f=>({...f}));
      this.validate(next);
      for(const f of next.folders)if(!(await fs.stat(f.hostPath).catch(()=>null))?.isDirectory())
        throw fail('Shared host folder does not exist: '+f.hostPath,'WORKBENCH_SHARE_MISSING',400);
      const tmp=this.file+'.'+randomUUID()+'.tmp';
      try{await fs.writeFile(tmp,JSON.stringify(next,null,2),{flag:'wx'});await fs.rename(tmp,this.file)}
      finally{await fs.rm(tmp,{force:true}).catch(()=>{})}
      this.config=next;return this.status();
    });this.queue=pending;return pending;
  }
  async provision(){
    const state=await this.status({fresh:true});
    if(!state.canProvision)throw fail('Workbench Windows guest cannot be created yet: '+state.blockers.join('; '),'WORKBENCH_PROVISION_UNAVAILABLE');
    const vmRoot=path.join(this.dataDir,'workbench-vm');
    const disk=path.join(vmRoot,'Workbench-Windows.vhdx');
    if(await fs.stat(disk).catch(()=>null))throw fail('An existing Workbench VHDX is preserved. Inspect it before provisioning.','WORKBENCH_DISK_ALREADY_EXISTS');
    if(state.capability.vmManagementViaBroker){
      const r=state.resources;
      await this.broker.provision({isoPath:state.media.path,vmRoot,minimumMiB:r.minimumMiB,
        startupMiB:r.startupMiB,maximumMiB:r.maximumMiB,cpuCount:r.cpuCount});
    }else{
      const script=windowsWorkbenchProvisioningScript({isoPath:state.media.path,vmRoot,resources:state.resources});
      if(state.capability.vmManagementViaElevation)throw fail(WORKBENCH_HOST_FOCUS_POLICY,'WORKBENCH_HOST_FOCUS_PROTECTED',503);
      await this.command(script,120000);
    }
    this.lastProbe=null;
    return this.status({fresh:true});
  }
  async start(){
    const state=await this.status({fresh:true});
    if(!state.canStart)throw fail('Workbench cannot start: '+state.blockers.join('; '),'WORKBENCH_START_UNAVAILABLE');
    const r=state.resources;
    if(state.capability.vmManagementViaBroker){
      await this.broker.start({minimumMiB:r.minimumMiB,startupMiB:r.startupMiB,
        maximumMiB:r.maximumMiB,cpuCount:r.cpuCount});
      this.lastProbe=null;return this.status({fresh:true});
    }
    const script=[
      "$ErrorActionPreference='Stop'",
      "Import-Module Hyper-V -ErrorAction Stop",
      "if((Get-VM -Name 'BLACKICE-Workbench' -ErrorAction Stop).State -ne 'Off'){throw 'VM is not powered off.'}",
      "Set-VMMemory -VMName 'BLACKICE-Workbench' -DynamicMemoryEnabled $true -MinimumBytes "+r.minimumMiB+"MB -StartupBytes "+r.startupMiB+"MB -MaximumBytes "+r.maximumMiB+"MB -ErrorAction Stop",
      "Set-VMProcessor -VMName 'BLACKICE-Workbench' -Count "+r.cpuCount+" -ErrorAction Stop",
      "Start-VM -Name 'BLACKICE-Workbench' -ErrorAction Stop | Out-Null"
    ].join('\n');
    if(state.capability.vmManagementViaElevation)throw fail(WORKBENCH_HOST_FOCUS_POLICY,'WORKBENCH_HOST_FOCUS_PROTECTED',503);
    await this.command(script,30000);this.lastProbe=null;return this.status({fresh:true});
  }
  async stop(){
    const state=await this.status({fresh:true});
    if(!state.canStop)throw fail('Workbench guest is not running.','WORKBENCH_STOP_UNAVAILABLE');
    if(state.capability.vmManagementViaBroker){
      await this.broker.stop();this.lastProbe=null;return this.status({fresh:true});
    }
    if(state.capability.vmManagementViaElevation)throw fail(WORKBENCH_HOST_FOCUS_POLICY,'WORKBENCH_HOST_FOCUS_PROTECTED',503);
    await this.command("$ErrorActionPreference='Stop'\nImport-Module Hyper-V -ErrorAction Stop\nStop-VM -Name 'BLACKICE-Workbench' -Confirm:$false -ErrorAction Stop",30000);
    this.lastProbe=null;return this.status({fresh:true});
  }
}
