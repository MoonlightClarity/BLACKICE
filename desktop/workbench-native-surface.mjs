import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkbenchFreeRDPHost,validateNativeControlEvent,validateNativeControls} from './workbench-freerdp-host.mjs';
import {runHiddenWorkbenchPowerShell} from '../lib/workbench-elevated-command.mjs';
import {nativeConnectionAttempt,nativeCleanupReceipt,nativeAttemptAvailabilityMeaning} from '../lib/workbench-native-diagnostics.mjs';

const fail=(message,code='WORKBENCH_NATIVE_UNAVAILABLE')=>Object.assign(Error(message),{code});
const sha=/^[a-f0-9]{64}$/;
const guid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const defaultResolve=options=>import('./workbench-native-runtime.mjs').then(module=>module.resolveWorkbenchNativeRuntime(options));

/** One accepted local preview surface. Renderer IPC cannot choose binaries, VM
 * identities, certificate exceptions, input owners, or raw guest input. */
export class WorkbenchNativeSurface {
  constructor({appDirectory,resourcesDirectory,isPackaged=false,env=process.env,
    getWorkbench=()=>null,getWindow=()=>null,scaleFactor=()=>1,contentScaleFactor=()=>1,detachedWindow=false,
    resolveRuntime=defaultResolve,Host=WorkbenchFreeRDPHost,runPowerShell=runHiddenWorkbenchPowerShell,
    preflight,allowUnacceptedProbe=false,showOnAttach=true,temporaryRoot=tmpdir(),capabilityCacheMs=30000,platform=process.platform,onControl=()=>{}}={}){
    if(typeof onControl!=='function')throw fail('A native control callback is required.','WORKBENCH_NATIVE_ARGUMENTS');
    Object.assign(this,{appDirectory,resourcesDirectory,isPackaged,env,getWorkbench,getWindow,scaleFactor,contentScaleFactor,detachedWindow:detachedWindow===true,
      resolveRuntime,Host,runPowerShell,preflight,allowUnacceptedProbe,temporaryRoot,capabilityCacheMs,platform,onControl});
    this.native=null;this.build=null;this.last=null;this.tail=Promise.resolve();this.capabilityAt=0;this.lastCapability=null;
    this.bindingsReady=false;this.generation=0;this.destroyed=false;this.retiring=Promise.resolve();
    this.controlTail=Promise.resolve();this.controlSequences=new WeakMap();this.lastConnectionAttempt=null;this.unretired=null;
    this.showOnAttach=allowUnacceptedProbe===true&&showOnAttach===false?false:true;
  }
  serialize(operation){const work=this.tail.catch(()=>{}).then(operation);this.tail=work.catch(()=>{});return work;}
  resolve(){return this.resolveRuntime({appDirectory:this.appDirectory,resourcesDirectory:this.resourcesDirectory,isPackaged:this.isPackaged,env:this.env});}
  async bindWorkbench(){
    const workbench=this.getWorkbench();
    if(typeof workbench?.setGuestConsoleOwnershipHook!=='function'||typeof workbench?.setGuestNativeConsoleAdapter!=='function')return {bound:false};
    await workbench.setGuestConsoleOwnershipHook(event=>this.transitionOwner(event));
    await workbench.setGuestNativeConsoleAdapter({frame:()=>this.frame(),surface:()=>this.surface(),input:(input,assertCurrent)=>this.nativeInput(input,assertCurrent),wake:(value,assertCurrent)=>this.wakeDisplay(value,assertCurrent),
      ...(this.detachedWindow?{open:assertCurrent=>this.openViewer(assertCurrent),availability:()=>this.viewerAvailability()}:{} )});
    this.bindingsReady=true;this.lastCapability=null;return {bound:true};
  }
  async capability({fresh=false}={}){
    if(this.destroyed||this.platform!=='win32'||!this.bindingsReady)return {available:false,accepted:false,localPreview:true,fullAcceptance:false,code:'WORKBENCH_NATIVE_INTEGRATION_UNAVAILABLE'};
    if(!fresh&&this.lastCapability&&Date.now()-this.capabilityAt<this.capabilityCacheMs)return {...this.lastCapability};
    let result;
    try{
      const build=await this.resolve();
      result={available:build.accepted===true,accepted:build.accepted===true,localPreview:true,fullAcceptance:false,
        renderer:this.detachedWindow?'freerdp-detached':'freerdp-child',detachedWindow:this.detachedWindow,
        detachedControls:this.detachedWindow&&build.accepted===true&&build.detachedControls===true,timingBasis:build.timingBasis||null,
        acceptanceChecks:build.acceptanceChecks,code:build.accepted?'WORKBENCH_NATIVE_PREVIEW_READY':'WORKBENCH_NATIVE_ACCEPTANCE_PENDING'};
    }catch(error){result={available:false,accepted:false,localPreview:true,fullAcceptance:false,
      code:/^WORKBENCH_[A-Z0-9_]+$/.test(error.code||'')?error.code:'WORKBENCH_NATIVE_UNAVAILABLE'};}
    this.lastCapability=result;this.capabilityAt=Date.now();return {...result};
  }
  async discover({timeoutMs=30000}={}){
    const workbench=this.getWorkbench();
    let value;
    if(this.preflight)value=await this.preflight();
    else{
      const vmName=workbench?.config?.vmName;
      if(typeof vmName!=='string'||!vmName||vmName.length>200)throw fail('The Workbench VM identity is unavailable.','WORKBENCH_NATIVE_PREFLIGHT');
      const script=await fs.readFile(path.join(this.appDirectory,'scripts/workbench-native-host-preflight.ps1'),'utf8');
      if(script.length>60000)throw fail('The native console preflight could not be verified.');
      const output=await this.runPowerShell(`& {\n${script}\n} -VmName '${vmName.replaceAll("'","''")}'`,{timeoutMs});
      if(typeof output!=='string'||output.length>65536)throw fail('The native console discovery response exceeded its limit.');
      try{value=JSON.parse(output.trim())}catch{throw fail('Windows returned no verified native console identity.');}
    }
    if(value?.version!==1||value.readyForBoundedProbe!==true||value.vmState!=='Running'||
      value.host!=='127.0.0.1'||value.port!==2179||value.listenerOwnedByVmms!==true||
      !guid.test(value.vmId||'')||!sha.test(value.certificateSha256||'')||
      !Array.isArray(value.certificates)||!value.certificates.some(c=>c.sha256===value.certificateSha256&&
        c.source==='local-vmms-service-certificate-store'&&Date.parse(c.notAfter)>Date.now())||
      !workbench?.config?.vmName||value.vmName!==workbench.config.vmName)
      throw fail('Windows could not verify the running VM and its local console certificate.','WORKBENCH_NATIVE_PREFLIGHT');
    return {vmId:value.vmId,certificateSha256:value.certificateSha256};
  }
  assertGeneration(generation){
    if(this.destroyed||generation!==this.generation)throw fail('The native viewer request was cancelled.','WORKBENCH_NATIVE_CANCELLED');
  }
  refreshRetirement(){
    if(!this.unretired)return;
    const cleanup=nativeCleanupReceipt(this.unretired.cleanupReceipt?.());
    if(cleanup?.confirmed){
      this.unretired=null;
      if(this.lastConnectionAttempt)this.lastConnectionAttempt=nativeConnectionAttempt({...this.lastConnectionAttempt,cleanup,
        uncertain:this.retiredDeliveryUncertain===true,status:this.lastConnectionAttempt.status==='connected'?'connected':this.retiredDeliveryUncertain?'uncertain':'failed'});
    }
  }
  async retire(native){
    let result;try{result=await native.close();}catch{}
    const cleanup=nativeCleanupReceipt(native.cleanupReceipt?.()||result?.cleanup)||{confirmed:false,exited:false,started:true,forced:false,exitCode:null,signal:null};
    if(this.native===native){this.native=null;this.build=null;}
    if(cleanup.confirmed&&this.lastConnectionAttempt)this.lastConnectionAttempt=nativeConnectionAttempt({...this.lastConnectionAttempt,cleanup});
    if(!cleanup.confirmed){this.unretired=native;this.lastConnectionAttempt=nativeConnectionAttempt({...(this.lastConnectionAttempt||{code:'WORKBENCH_NATIVE_CLEANUP_UNCERTAIN',acknowledged:false,at:new Date().toISOString()}),status:'uncertain',uncertain:true,cleanup});}
    return cleanup;
  }
  async attach(bounds,window,timeoutMs=10000,generation=this.generation,{assertCaller=()=>{},deadline=null,requireAccepted=false}={}){
    const workbench=this.getWorkbench();
    const check=()=>{this.assertGeneration(generation);assertCaller();if(deadline!==null&&Date.now()>=deadline)throw fail('The native viewer opening deadline expired.','WORKBENCH_NATIVE_OPEN_TIMEOUT');};
    check();this.refreshRetirement();
    if(this.unretired||this.lastConnectionAttempt?.uncertain)throw Object.assign(fail('The previous native connection has uncertain delivery or cleanup. No replacement was started.','WORKBENCH_NATIVE_UNCERTAIN'),{nativeConnectionAttempt:this.lastConnectionAttempt});
    if(!this.bindingsReady||!workbench?.consoleControl?.serialize)throw fail('Workbench input ownership is not ready.');
    return workbench.consoleControl.serialize(async()=>{
      check();
      const owner=workbench.consoleControl.status().owner;
      if(!['agent','user'].includes(owner))throw fail('VM input ownership is unavailable.','WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE');
      const build=await this.resolve();
      check();
      if(!build.accepted&&(!this.allowUnacceptedProbe||requireAccepted))throw fail('The native display preview has not completed its local checks.','WORKBENCH_NATIVE_ACCEPTANCE_PENDING');
      if(this.native&&(this.build?.helperSha256!==build.helperSha256||this.build?.runtimeManifestSha256!==build.runtimeManifestSha256))
        throw fail('Close the current native viewer before using a different verified build.','WORKBENCH_NATIVE_BUILD_CHANGED');
      if(this.native){
        const native=this.native,result=await native.status();check();
        if(!result.displayReady||result.uncertain){
          // Only an explicit Open can retire a positively disconnected session.
          // Unknown delivery or a timed-out operation must remain fail closed.
          if(result.connected!==false||result.uncertain!==false)
            throw fail('Close the disconnected native viewer before reconnecting.','WORKBENCH_NATIVE_UNCERTAIN');
          const cleanup=await this.retire(native);check();
          if(!cleanup.confirmed)throw fail('The previous native helper has not confirmed exit.','WORKBENCH_NATIVE_UNCERTAIN');
        }else{
          await native.position(bounds,window);check();
          await native.inputOwner(owner);check();
          const shown=this.showOnAttach?await native.visible(true,this.detachedWindow?{expectedWindowCloseRevision:result.windowCloseRevision}:{}):await native.status();
          check();return this.receipt({...result,...shown});
        }
      }
      const identity=await this.discover({timeoutMs:deadline===null?30000:Math.max(1,deadline-Date.now()-6000)});
      check();
      await this.retiring;check();
      let native;
      native=new this.Host({...build,env:this.env,scaleFactor:this.scaleFactor,contentScaleFactor:this.contentScaleFactor,detachedWindow:this.detachedWindow,
        onControl:event=>this.nativeControl(event,native)});
      this.native=native;this.build=build;
      try{
        const prepared=await native.prepare(bounds,window);
        check();
        if(prepared.perMonitorV2!==true)throw fail('The native viewport could not verify its display scaling.','WORKBENCH_NATIVE_DPI');
        const connectTimeout=deadline===null?timeoutMs:Math.min(timeoutMs,deadline-Date.now()-5000);
        if(connectTimeout<1000)throw fail('The native viewer opening deadline expired.','WORKBENCH_NATIVE_OPEN_TIMEOUT');
        const connected=await native.connect({...identity,timeoutMs:connectTimeout});
        check();
        if(!connected.displayReady)throw fail('The native console has not decoded a guest frame.','WORKBENCH_NATIVE_NO_FRAME');
        // This acknowledges the existing server owner. It never takes or cedes
        // control and is fenced with every server ownership transition.
        await native.inputOwner(workbench.consoleControl.status().owner);
        check();
        // Closing the independent window during a pending connection hides it;
        // completion must not reopen it against that explicit user action.
        const shown=!this.showOnAttach||this.detachedWindow&&connected.windowCloseRevision>prepared.windowCloseRevision?connected:
          await native.visible(true,this.detachedWindow?{expectedWindowCloseRevision:prepared.windowCloseRevision}:{});
        check();this.lastConnectionAttempt=nativeConnectionAttempt({status:'connected',code:'WORKBENCH_NATIVE_CONNECTED',acknowledged:true,uncertain:false,diagnostics:connected,at:new Date().toISOString()});
        return this.receipt({...connected,...shown});
      }catch(error){
        const deliveryUncertain=error.code==='WORKBENCH_NATIVE_UNCERTAIN'||native.uncertain===true&&error.nativeAcknowledged!==true;
        const cleanup=await this.retire(native);this.retiredDeliveryUncertain=deliveryUncertain;
        const uncertain=this.retiredDeliveryUncertain||!cleanup.confirmed;
        this.lastConnectionAttempt=nativeConnectionAttempt({status:uncertain?'uncertain':'failed',code:/^[A-Z0-9_]{1,80}$/.test(error.code||'')?error.code:'WORKBENCH_NATIVE_FAILED',
          acknowledged:error.nativeAcknowledged===true,uncertain,diagnostics:error.nativeDiagnostics,cleanup,at:new Date().toISOString()});
        error.nativeConnectionAttempt=this.lastConnectionAttempt;throw error;
      }
    });
  }
  async viewerAvailability(){
    this.refreshRetirement();
    const capability=await this.capability(),status=await this.status();
    const window=this.getWindow(),desktopAnchor=Boolean(window&&typeof window.isDestroyed==='function'&&!window.isDestroyed());
    const configuredVM=typeof this.getWorkbench()?.config?.vmName==='string'&&Boolean(this.getWorkbench().config.vmName);
    const uncertain=status.uncertain===true||status.cached===true||this.pendingOpen?.expired===true||Boolean(this.unretired)||this.lastConnectionAttempt?.uncertain===true;
    return {backendAttached:!this.destroyed&&this.bindingsReady&&this.detachedWindow,
      openAvailable:capability.available===true&&desktopAnchor&&configuredVM&&!uncertain&&!this.pendingOpen,
      attached:Boolean(this.native),connected:status.connected===true,displayReady:status.displayReady===true,
      windowVisible:status.windowVisible===true,uncertain,availabilityMeaning:nativeAttemptAvailabilityMeaning,
      ...(this.lastConnectionAttempt?{lastConnectionAttempt:nativeConnectionAttempt(this.lastConnectionAttempt)}:{}),
      prerequisites:{acceptedRuntime:capability.available===true,desktopAnchor,configuredVM,requiresRunningVM:true},
      code:uncertain?'WORKBENCH_NATIVE_UNCERTAIN':this.pendingOpen?'WORKBENCH_NATIVE_OPEN_PENDING':!capability.available?capability.code:!desktopAnchor?'WORKBENCH_NATIVE_ANCHOR_UNAVAILABLE':!configuredVM?'WORKBENCH_NATIVE_PREFLIGHT':status.displayReady?'WORKBENCH_NATIVE_READY':'WORKBENCH_NATIVE_NOT_ATTACHED'};
  }
  // Acquire the surface queue BEFORE the ownership queue, matching renderer
  // attach. WindowsWorkbench must not hold consoleControl.run around this call.
  openViewer(assertCaller){
    if(typeof assertCaller!=='function'||!this.detachedWindow)throw fail('Agent opening requires the configured detached desktop adapter.','WORKBENCH_NATIVE_UNAVAILABLE');
    if(this.pendingOpen)throw fail('The previous viewer opening has not settled. Inspect status before retrying.',this.pendingOpen.expired?'WORKBENCH_NATIVE_UNCERTAIN':'WORKBENCH_NATIVE_OPEN_PENDING');
    const generation=this.generation,deadline=Date.now()+30000;
    this.assertGeneration(generation);assertCaller();
    const window=this.getWindow();
    if(!window||typeof window.isDestroyed!=='function'||window.isDestroyed())throw fail('The trusted BLACKICE launcher window is unavailable.','WORKBENCH_NATIVE_ANCHOR_UNAVAILABLE');
    const state={expired:false},check=()=>{if(state.expired)throw fail('Viewer opening timed out. Its pending operation must settle before another opening.','WORKBENCH_NATIVE_UNCERTAIN');assertCaller();};
    this.pendingOpen=state;
    const operation=this.serialize(async()=>{
      this.assertGeneration(generation);check();
      const result=await this.attach(undefined,window,10000,generation,{assertCaller:check,deadline,requireAccepted:true});
      return {opened:result.windowVisible===true,connected:result.connected===true,displayReady:result.displayReady===true,
        windowVisible:result.windowVisible===true,closedDuringOpen:result.windowVisible!==true,
        uncertain:result.uncertain===true,accepted:result.accepted===true,detached:true,
        ...(Number.isSafeInteger(result.windowCloseRevision)?{windowCloseRevision:result.windowCloseRevision}:{}),
        ...(this.lastConnectionAttempt?{lastConnectionAttempt:nativeConnectionAttempt(this.lastConnectionAttempt)}:{}),
        meaning:result.windowVisible===true?'Configured native viewer opened without changing VM power or control.':'The native session connected, but the window remained closed by the user.'};
    });
    let timer;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{state.expired=true;reject(fail('Viewer opening timed out. Delivery may be uncertain; inspect status before retrying.','WORKBENCH_NATIVE_UNCERTAIN'));},30000);});
    // Do not release the internal queues on timeout. Their existing operation
    // must acknowledge/retire; the expired fence prevents any late show/spawn.
    operation.finally(()=>{if(this.pendingOpen===state)this.pendingOpen=null;}).catch(()=>{});
    return Promise.race([operation,timeout]).finally(()=>clearTimeout(timer));
  }
  receipt(result){
    const displayReady=result.connected===true&&result.certificateVerified===true&&result.selectedProtocol===2&&
      Number.isSafeInteger(result.decodedFrames)&&result.decodedFrames>0&&result.uncertain!==true&&
      [result.surface?.width,result.surface?.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=4096);
    this.last={...result,helperPid:this.native?.worker?.pid,displayReady,shown:this.detachedWindow?result.windowVisible===true:result.visible===true,detached:this.detachedWindow,localPreview:true,fullAcceptance:false,
      accepted:this.build?.accepted===true,isolatedProbe:this.allowUnacceptedProbe,
      capability:{...result.capability,detachedControls:this.detachedWindow&&this.build?.accepted===true&&this.build?.detachedControls===true}};
    return this.last;
  }
  /** Invoked inside the server ownership queue, before committing its receipt.
   * Never reenter that queue from this callback. */
  async transitionOwner({owner}={}){
    if(owner==='none')return this.close();
    if(!['agent','user'].includes(owner))throw fail('Unsupported guest input owner.');
    const native=this.native;if(!native)return {owner,nativeAttached:false};
    const result=await native.inputOwner(owner);
    if(result.inputOwner!==owner)throw fail('The native input owner was not acknowledged.','WORKBENCH_NATIVE_OWNERSHIP');
    this.receipt(result);return {owner,nativeAttached:true};
  }
  async perform(request,window=this.getWindow()){
    const fields={capability:['action'],attach:['action','bounds','timeoutMs'],bounds:['action','bounds'],
      visible:['action','visible'],input:['action','enabled'],status:['action'],close:['action']};
    if(!request||typeof request!=='object'||Array.isArray(request)||!fields[request.action]||
      Object.keys(request).some(key=>!fields[request.action].includes(key)))throw fail('Unsupported native console request.','WORKBENCH_NATIVE_ARGUMENTS');
    if(request.action==='capability')return this.capability();
    // Invalidate immediately, rather than waiting behind an attach that may be
    // verifying a build or connecting. Ownership hooks also call close directly.
    if(request.action==='close')return this.close();
    if(request.action==='visible'&&request.visible===false)return this.hide();
    const generation=this.generation;this.assertGeneration(generation);
    return this.serialize(async()=>{
      this.assertGeneration(generation);
      if(request.action==='attach')return this.attach(request.bounds,window,request.timeoutMs,generation);
      if(request.action==='status')return this.status();
      if(!this.native)throw fail('The native console is not attached.','WORKBENCH_NATIVE_NOT_ATTACHED');
      if(request.action==='bounds'){
        const result=await this.native.position(request.bounds,window);this.assertGeneration(generation);return this.receipt(result);
      }
      if(request.action==='visible'){
        if(typeof request.visible!=='boolean')throw fail('Choose native console visibility.','WORKBENCH_NATIVE_ARGUMENTS');
        const result=await this.native.visible(request.visible);this.assertGeneration(generation);return this.receipt(result);
      }
      if(request.action==='input'){
        // Compatibility read only: renderer IPC cannot alter native ownership.
        const owner=this.getWorkbench()?.consoleControl?.status().owner;
        if(typeof request.enabled!=='boolean'||!['agent','user'].includes(owner)||request.enabled!==(owner==='user'))
          throw fail('Use Workbench Take control or Cede control to change VM ownership.','WORKBENCH_NATIVE_OWNER_SERVER');
        const result=await this.native.status();
        if(result.inputOwner!==owner)throw fail('Native input ownership differs from its server receipt.','WORKBENCH_NATIVE_OWNERSHIP');
        return this.receipt(result);
      }
    });
  }
  async status(){
    this.refreshRetirement();
    const native=this.native,result=native?await native.status():null;
    if(native&&this.native===native&&(result.uncertain===true||result.cached===true))this.lastConnectionAttempt=nativeConnectionAttempt({status:'uncertain',code:'WORKBENCH_NATIVE_UNCERTAIN',acknowledged:false,uncertain:true,cleanup:native.cleanupReceipt?.()||result.cleanup,at:new Date().toISOString()});
    const value=result&&this.native===native?this.receipt(result):{connected:false,displayReady:false,viewerClosed:true,localPreview:true,...(this.unretired?{uncertain:true}:{})};
    return {...value,...(this.lastConnectionAttempt?{lastConnectionAttempt:nativeConnectionAttempt(this.lastConnectionAttempt)}:{})};
  }
  async hide(){
    ++this.generation;
    const native=this.native;
    if(!native)return {shown:false};
    // A partially prepared/connecting helper cannot safely accept visibility
    // commands yet. Retire it; its cancelled attach cannot later show a child.
    if(!native.prepared||!native.last?.displayReady)return this.close();
    const result=await native.visible(false);return this.native===native?this.receipt(result):{shown:false};
  }
  async close(){
    ++this.generation;
    const native=this.native||this.unretired;this.native=null;this.build=null;
    if(native){
      const previous=this.retiring,closing=this.retire(native);
      this.retiring=Promise.all([previous.catch(()=>{}),closing]).then(()=>{});
    }
    await this.retiring;
    this.refreshRetirement();
    if(this.unretired)throw Object.assign(fail('Native helper exit is not confirmed.','WORKBENCH_NATIVE_UNCERTAIN'),{nativeConnectionAttempt:this.lastConnectionAttempt});
    this.last={connected:false,displayReady:false,viewerClosed:true,closed:true,localPreview:true};return this.last;
  }
  destroy(){this.destroyed=true;return this.close();}
  async surface(){
    const native=this.native;
    if(!native)throw fail('The native console is not attached.','WORKBENCH_NATIVE_NOT_ATTACHED');
    const result=await native.status();
    if(this.native!==native||!result.displayReady||result.uncertain||
      ![result.surface?.width,result.surface?.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=4096))
      throw fail('The native console has no verified decoded frame.','WORKBENCH_NATIVE_NO_FRAME');
    return {...result.surface};
  }
  async frame(){
    const native=this.native;await this.surface();
    if(this.native!==native)throw fail('The native console changed before capture.','WORKBENCH_NATIVE_NOT_ATTACHED');
    const folder=await fs.mkdtemp(path.join(this.temporaryRoot,'blackice-native-frame-')),file=path.join(folder,'frame.bmp');
    try{
      if(this.native!==native)throw fail('The native console changed before capture.','WORKBENCH_NATIVE_NOT_ATTACHED');
      const result=await native.capture(file),bytes=result.bytes;
      if(this.native!==native)throw fail('The native console changed during capture.','WORKBENCH_NATIVE_NOT_ATTACHED');
      if(!Buffer.isBuffer(bytes)||bytes.length<54||bytes.readUInt32LE(14)!==40||bytes.readInt32LE(18)!==result.width||
        Math.abs(bytes.readInt32LE(22))!==result.height||bytes.readUInt16LE(28)!==32)
        throw fail('The native surface dimensions did not match its capture.','WORKBENCH_NATIVE_CAPTURE');
      // Health and age describe this image only when the helper still reports
      // its exact sequence, dimensions and timestamp after capture readback.
      let current;try{current=await native.status();}catch{}
      if(this.native!==native)throw fail('The native console changed during capture health inspection.','WORKBENCH_NATIVE_NOT_ATTACHED');
      const sameFrame=current?.cached!==true&&current?.uncertain!==true&&Number.isSafeInteger(result.frameAtMonotonicMs)&&current?.surface?.sequence===result.sequence&&
        current.surface.width===result.width&&current.surface.height===result.height&&current.surface.frameAtMonotonicMs===result.frameAtMonotonicMs&&current.frameHealth?.sequence===result.sequence;
      return {...result,path:undefined,bytes,contentType:'image/bmp',source:'native-decoded-surface',...(sameFrame?{nativeHealth:structuredClone(current.frameHealth)}:{})};
    }finally{await fs.unlink(file).catch(()=>{});await fs.rmdir(folder).catch(()=>{});}
  }
  /** Explicit agent-native API callback. WindowsWorkbench already holds its
   * consoleControl.run fence and supplies the current-revision assertion. */
  async nativeInput(input,assertCurrent){
    if(typeof assertCurrent!=='function'||this.getWorkbench()?.consoleControl?.status().owner!=='agent')
      throw fail('The agent does not own the native console.','WORKBENCH_CONTROL_HELD_BY_USER');
    if(!this.native)throw fail('The native console is not attached.','WORKBENCH_NATIVE_NOT_ATTACHED');
    assertCurrent();return this.native.agentInput(input);
  }
  async configureClipboard(enabled){
    const native=this.native;if(!native){if(enabled===false)return {clipboard:{enabled:false},viewerClosed:true};throw fail('Open Workbench before sharing its clipboard.','WORKBENCH_NATIVE_NOT_ATTACHED');}
    const result=await native.configureClipboard(enabled);
    if(this.native!==native)throw fail('The native clipboard session changed.','WORKBENCH_NATIVE_NOT_ATTACHED');
    return this.receipt(result);
  }
  async configureControls(value){
    const settings=validateNativeControls(value),native=this.native;
    if(!native||!this.detachedWindow||this.build?.accepted!==true||this.build?.detachedControls!==true||native.closed||native.uncertain||!native.prepared)
      throw fail('The accepted native controls are unavailable.','WORKBENCH_NATIVE_CONTROLS');
    const result=await native.configureControls(settings);
    if(this.native!==native||this.destroyed)throw fail('The native control session changed.','WORKBENCH_NATIVE_CONTROLS');
    return this.receipt(result);
  }
  nativeControl(value,native){
    let event;try{event=validateNativeControlEvent(value)}catch{return Promise.resolve(false)}
    if(!native||this.native!==native||event.sequence<=(this.controlSequences.get(native)||0))return Promise.resolve(false);
    this.controlSequences.set(native,event.sequence);
    const generation=this.generation,worker=native.worker,workbench=this.getWorkbench(),control=workbench?.consoleControl?.status();
    const assertInstance=()=>{
      if(this.destroyed||generation!==this.generation||this.native!==native||this.getWorkbench()!==workbench||
        this.build?.accepted!==true||this.build?.detachedControls!==true||!this.detachedWindow||!worker||native.worker!==worker||native.closed||native.uncertain||
        !native.prepared||native.last?.workbenchWindowHwnd!==event.windowHwnd)
        throw fail('The native control intent is stale.','WORKBENCH_NATIVE_CONTROL_STALE');
    };
    const assertCurrent=()=>{
      assertInstance();const current=workbench?.consoleControl?.status();
      if(!['agent','user'].includes(control?.owner)||current?.owner!==control.owner||current.revision!==control.revision||event.inputOwner!==current.owner)
        throw fail('The native control owner changed.','WORKBENCH_NATIVE_CONTROL_STALE');
    };
    // This queue is deliberately independent of Surface operations and the
    // server ownership queue. A handler can safely Take/Cede using that queue.
    const operation=this.controlTail.catch(()=>{}).then(async()=>{
      assertCurrent();const current=await native.status();assertCurrent();
      if(current.cached===true||current.uncertain!==false||current.detached!==true||current.workbenchWindowHwnd!==event.windowHwnd||
        current.inputOwner!==control.owner||current.controls?.available!==true||current.controls.enabled!==true)
        throw fail('The native control session could not be verified.','WORKBENCH_NATIVE_CONTROL_STALE');
      assertCurrent();return this.onControl(event,{assertCurrent,assertInstance});
    });
    this.controlTail=operation.catch(()=>{});return operation;
  }
  async completeClipboardPaste(value){
    const native=this.native;if(!native)throw fail('The native clipboard session closed.','WORKBENCH_NATIVE_NOT_ATTACHED');
    const result=await native.completeClipboardPaste(value);
    if(this.native!==native)throw fail('The native clipboard session changed.','WORKBENCH_NATIVE_NOT_ATTACHED');
    return this.receipt(result);
  }
  async wakeDisplay({owner}={},assertCurrent){
    const native=this.native;
    if(typeof assertCurrent!=='function'||!['agent','user'].includes(owner)||this.getWorkbench()?.consoleControl?.status().owner!==owner)
      throw fail('Display wake requires the current Workbench input owner.','WORKBENCH_NATIVE_WAKE_REJECTED');
    if(!native)throw fail('The native console is not attached.','WORKBENCH_NATIVE_NOT_ATTACHED');
    assertCurrent();const current=await native.status();assertCurrent();
    if(this.native!==native||!current.displayReady||current.uncertain||current.inputOwner!==owner)
      throw fail('The native console changed before display wake.','WORKBENCH_NATIVE_WAKE_REJECTED');
    assertCurrent();const result=await native.wakeDisplay(owner);assertCurrent();
    if(this.native!==native||this.getWorkbench()?.consoleControl?.status().owner!==owner)
      throw fail('The native console changed during display wake.','WORKBENCH_NATIVE_WAKE_REJECTED');
    return this.receipt(result);
  }
}
