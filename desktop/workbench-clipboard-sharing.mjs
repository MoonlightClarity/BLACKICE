const problem=(code='WORKBENCH_CLIPBOARD_PAUSED')=>Object.assign(Error('Workbench clipboard sharing is paused.'),{code});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const identity=value=>value?.workbenchWindowHwnd&&value?.childHwnd?
  `${value.helperPid??''}:${value.workbenchWindowHwnd}:${value.childHwnd}`:null;

/** Main-process only. The token comes from an explicit trusted UI Take receipt;
 * this controller never reads a private token, takes control or opens a VM.
 * observe coalesces concurrent status ticks into one bounded transfer stream. */
export class WorkbenchClipboardSharing {
  constructor({workbench,transfer,getNativeStatus,setNativeClipboard,finishNativePaste,hostClipboardState,onStatus=()=>{},
    clock=Date.now,pollMs=500,copyGraceMs=2000}={}){
    if(!workbench?.consoleControl||typeof transfer!=='function'||typeof transfer.state!=='function'||
      [getNativeStatus,setNativeClipboard,finishNativePaste,hostClipboardState,onStatus,clock].some(fn=>typeof fn!=='function'))
      throw TypeError('Clipboard sharing requires scoped Workbench adapters.');
    Object.assign(this,{workbench,transfer,getNativeStatus,setNativeClipboard,finishNativePaste,hostClipboardState,onStatus,clock,pollMs,copyGraceMs});
    this.enabled=false;this.closed=false;this.token=undefined;this.revision=null;this.generation=0;this.latest=null;
    this.running=null;this.nativeSettings=Promise.resolve();this.dirty=false;this.active=false;this.reason='disabled';this.lastTransfer=null;this.reset();
  }
  reset(){this.nativeIdentity=null;this.nativeEnabledIdentity=null;this.hostFingerprint=undefined;this.guestSequence=undefined;
    this.copyRevision=0;this.copyIntent=null;this.firstFocus=true;this.nextPollAt=0;this.finishedPastes=new Set();}
  status(){return {enabled:this.enabled,active:this.active,reason:this.reason,closed:this.closed,
    ...(this.lastTransfer?{lastTransfer:{...this.lastTransfer}}:{})};}
  publish(){try{this.onStatus(this.status())}catch{}return this.status();}
  changeNative(enabled,generation=this.generation){
    const operation=this.nativeSettings.catch(()=>{}).then(()=>{
      if(enabled&&(generation!==this.generation||!this.enabled||this.closed))return;
      return this.setNativeClipboard(enabled);
    });
    this.nativeSettings=operation.catch(()=>{});return operation;
  }
  async configure(request={}){
    if(this.closed)throw problem('WORKBENCH_CLIPBOARD_CLOSED');
    if(!object(request)||Object.keys(request).some(key=>!['enabled','controlToken'].includes(key))||typeof request.enabled!=='boolean')
      throw problem('WORKBENCH_CLIPBOARD_ARGUMENTS');
    const control=this.workbench.consoleControl.status();
    if(request.controlToken!==undefined||request.enabled&&control.owner==='user')
      this.workbench.consoleControl.assert(request.controlToken,control.revision);
    ++this.generation;this.enabled=request.enabled;this.token=request.enabled?request.controlToken:undefined;
    this.revision=request.enabled&&control.owner==='user'?control.revision:null;
    this.active=false;this.reason=request.enabled?'waiting-for-user-window':'disabled';this.reset();
    if(!request.enabled){try{await this.changeNative(false)}catch{this.reason='native-disable-unconfirmed'}}
    else if(this.latest)void this.observe(this.latest);
    return this.publish();
  }
  observe(nativeStatus){
    if(this.closed)return Promise.resolve(this.status());
    this.latest=nativeStatus;this.dirty=true;
    if(!this.running){
      this.running=(async()=>{
        while(this.dirty&&!this.closed){this.dirty=false;try{await this.step(this.latest)}catch(error){
          this.active=false;this.reason=/^WORKBENCH_[A-Z0-9_]+$/.test(error?.code||'')?error.code:'clipboard-unavailable';this.publish();
        }}return this.status();
      })().finally(()=>{this.running=null});
    }
    return this.running;
  }
  base(value){
    if(!this.enabled||this.closed||this.revision===null)return false;
    const control=this.workbench.consoleControl.status();
    if(control.owner!=='user'||control.revision!==this.revision)return false;
    try{this.workbench.consoleControl.assert(this.token,this.revision)}catch{return false}
    return value?.accepted===true&&value.detached===true&&value.connected===true&&value.displayReady===true&&
      value.uncertain!==true&&value.inputOwner==='user'&&Boolean(identity(value));
  }
  host(){
    let value;try{value=this.hostClipboardState()}catch{throw problem('WORKBENCH_CLIPBOARD_HOST')}
    if(!object(value)||typeof value.hasText!=='boolean'||typeof value.fingerprint!=='string'||!value.fingerprint.length||value.fingerprint.length>256)
      throw problem('WORKBENCH_CLIPBOARD_HOST');
    return value;
  }
  async guard(context){
    if(context.generation!==this.generation)throw problem();
    const value=await this.getNativeStatus();
    if(context.generation!==this.generation||!this.base(value)||identity(value)!==context.identity)throw problem();
    if(context.paste){
      if(value.windowForeground!==true||value.clipboard?.pendingPaste!==context.paste.id||value.clipboard?.pasteEpoch!==context.paste.epoch)
        throw problem('WORKBENCH_CLIPBOARD_PASTE_STALE');
    }else if(context.copy){
      const age=value.clipboard?.copyAgeMs;
      if(value.clipboard?.copyRevision!==context.copy.revision||!Number.isFinite(age)||age<0||age>this.copyGraceMs)
        throw problem('WORKBENCH_CLIPBOARD_COPY_STALE');
    }else if(!context.metadata&&value.windowForeground!==true)throw problem();
    if(!context.paste&&!context.metadata&&value.clipboard?.pendingPaste>0)throw problem('WORKBENCH_CLIPBOARD_PASTE_PENDING');
    if(context.hostFingerprint!==undefined&&this.host().fingerprint!==context.hostFingerprint)
      throw problem('WORKBENCH_CLIPBOARD_CHANGED');
    return true;
  }
  context(extra={}){return {generation:this.generation,identity:this.nativeIdentity,...extra};}
  async step(value){
    if(!this.base(value)){
      this.active=false;this.reason=this.enabled?'waiting-for-user-window':'disabled';
      if(this.nativeEnabledIdentity){this.nativeEnabledIdentity=null;try{await this.changeNative(false)}catch{this.reason='native-disable-unconfirmed'}}
      this.publish();return;
    }
    const id=identity(value);
    if(this.nativeIdentity!==id){this.reset();this.nativeIdentity=id;}
    let primedState;
    if(this.nativeEnabledIdentity!==id||value.clipboard?.enabled!==true){
      const generation=this.generation;
      // Capture the guest sequence before interception can report the first
      // Ctrl+C. Metadata reads need no foreground or host clipboard access.
      const primeContext=this.context({metadata:true});
      primedState=await this.transfer.state({controlToken:this.token},{guard:()=>this.guard(primeContext)});
      this.guestSequence=primedState.sequence;
      const beforeEnable=await this.getNativeStatus();
      if(generation!==this.generation||!this.base(beforeEnable)||identity(beforeEnable)!==this.nativeIdentity)throw problem();
      this.copyRevision=beforeEnable.clipboard?.copyRevision??0;
      if(beforeEnable.windowForeground===true)this.hostFingerprint=this.host().fingerprint;
      await this.changeNative(true,generation);
      const current=await this.getNativeStatus();
      if(generation!==this.generation||!this.base(current)||identity(current)!==this.nativeIdentity){
        await this.changeNative(false);throw problem();
      }
      value=current;
      this.nativeEnabledIdentity=id;
    }
    const clip=value.clipboard??{};
    if(integer(clip.copyRevision)&&clip.copyRevision!==this.copyRevision){
      this.copyRevision=clip.copyRevision;
      this.copyIntent=clip.copyRevision>0&&Number.isFinite(clip.copyAgeMs)&&clip.copyAgeMs>=0&&clip.copyAgeMs<=this.copyGraceMs?
        {revision:clip.copyRevision,sequence:this.guestSequence,hostFingerprint:this.hostFingerprint}:null;
      this.nextPollAt=0;
    }
    const paste=integer(clip.pendingPaste)&&clip.pendingPaste>0&&integer(clip.pasteEpoch)?{id:clip.pendingPaste,epoch:clip.pasteEpoch}:null;
    if(paste&&value.windowForeground===true){
      const key=`${id}:${paste.epoch}:${paste.id}`;
      if(!this.finishedPastes.has(key)){
        this.finishedPastes.add(key);if(this.finishedPastes.size>32)this.finishedPastes.delete(this.finishedPastes.values().next().value);
        const context=this.context({paste});let permit=false;
        try{
          await this.guard(context);
          const host=this.host();context.hostFingerprint=host.fingerprint;
          if(host.hasText){
            const result=await this.transfer({direction:'toGuest',controlToken:this.token},{guard:()=>this.guard(context)});
            this.guestSequence=result.guestSequence;this.hostFingerprint=this.host().fingerprint;
            this.lastTransfer={direction:'toGuest',characters:result.characters};
          }
          await this.guard(context);permit=true;
        }catch(error){this.reason=/^WORKBENCH_[A-Z0-9_]+$/.test(error?.code||'')?error.code:'clipboard-unavailable'}
        try{await this.finishNativePaste({pasteId:paste.id,epoch:paste.epoch,paste:permit})}catch{permit=false;this.reason='WORKBENCH_CLIPBOARD_PASTE_STALE'}
        if(context.generation!==this.generation||!this.enabled||this.closed)return;
        this.active=permit;if(permit)this.reason='sharing';this.publish();return;
      }
      return;
    }
    const copy=this.copyIntent;
    const copyValid=copy&&clip.copyRevision===copy.revision&&Number.isFinite(clip.copyAgeMs)&&clip.copyAgeMs>=0&&clip.copyAgeMs<=this.copyGraceMs;
    if(copy&&!copyValid)this.copyIntent=null;
    if(value.windowForeground!==true&&!copyValid){this.active=false;this.reason='waiting-for-user-window';this.publish();return;}
    if(this.clock()<this.nextPollAt)return;
    this.nextPollAt=this.clock()+this.pollMs;
    const host=this.host();
    if(copyValid&&copy.hostFingerprint===undefined){
      if(value.windowForeground!==true){this.copyIntent=null;throw problem('WORKBENCH_CLIPBOARD_CHANGED');}
      copy.hostFingerprint=host.fingerprint;
    }
    if(copyValid&&copy.hostFingerprint!==undefined&&host.fingerprint!==copy.hostFingerprint){this.copyIntent=null;throw problem('WORKBENCH_CLIPBOARD_CHANGED');}
    const context=this.context(copyValid?{copy,hostFingerprint:copy.hostFingerprint}:{});
    const state=!copyValid&&primedState?primedState:await this.transfer.state({controlToken:this.token},{guard:()=>this.guard(context)});
    if(copyValid){
      if(copy.sequence===undefined){copy.sequence=state.sequence;this.reason='waiting-for-new-copy';this.publish();return;}
      if(state.sequence===copy.sequence){this.reason='waiting-for-new-copy';this.publish();return;}
      if(!state.hasText){this.guestSequence=state.sequence;this.copyIntent=null;this.reason='clipboard-has-no-text';this.publish();return;}
      this.copyIntent=null;this.guestSequence=state.sequence;
      const result=await this.transfer({direction:'fromGuest',controlToken:this.token},{guard:()=>this.guard(context)});
      this.guestSequence=result.guestSequence;this.hostFingerprint=this.host().fingerprint;this.firstFocus=false;
      this.lastTransfer={direction:'fromGuest',characters:result.characters};this.active=true;this.reason='sharing';this.publish();return;
    }
    const hostChanged=this.firstFocus||this.hostFingerprint!==host.fingerprint,guestChanged=this.guestSequence!==undefined&&this.guestSequence!==state.sequence;
    this.firstFocus=false;
    this.hostFingerprint=host.fingerprint;this.guestSequence=state.sequence;
    if(hostChanged&&host.hasText){
      const result=await this.transfer({direction:'toGuest',controlToken:this.token},{guard:()=>this.guard(context)});
      this.guestSequence=result.guestSequence;this.lastTransfer={direction:'toGuest',characters:result.characters};
    }else if(!hostChanged&&guestChanged&&state.hasText){
      const result=await this.transfer({direction:'fromGuest',controlToken:this.token},{guard:()=>this.guard({...context,hostFingerprint:host.fingerprint})});
      this.guestSequence=result.guestSequence;this.hostFingerprint=this.host().fingerprint;
      this.lastTransfer={direction:'fromGuest',characters:result.characters};
    }
    this.active=true;this.reason='sharing';this.publish();
  }
  async close(){
    if(this.closed)return this.status();
    ++this.generation;this.closed=true;this.enabled=false;this.token=undefined;this.active=false;this.reason='closed';
    try{await this.changeNative(false)}catch{this.reason='native-disable-unconfirmed'}
    return this.publish();
  }
}
