const fail=(message,code='WORKBENCH_RESOLUTION_UNAVAILABLE')=>Object.assign(Error(message),{code});
const size=value=>value&&Number.isSafeInteger(value.width)&&Number.isSafeInteger(value.height)&&
  value.width>=640&&value.height>=480&&value.width<=4096&&value.height<=4096;
export function selectWorkbenchGuestMode(modes,viewport){
  if(!size(viewport)||!Array.isArray(modes)||modes.length>512)throw fail('Guest resolution inventory or viewport is invalid.');
  const candidates=modes.filter(mode=>size(mode)&&mode.bpp===32&&mode.width<=viewport.width&&mode.height<=viewport.height);
  candidates.sort((a,b)=>b.width*b.height-a.width*a.height||
    Math.abs(a.width/a.height-viewport.width/viewport.height)-Math.abs(b.width/b.height-viewport.width/viewport.height)||b.width-a.width);
  return candidates.length?{width:candidates[0].width,height:candidates[0].height}:null;
}
const identity=status=>status?.workbenchWindowHwnd;
function validNative(status){return status?.connected===true&&status.displayReady===true&&status.windowVisible===true&&
  status.windowMinimized!==true&&typeof identity(status)==='string'&&/^\d+$/.test(identity(status))&&
  size(status.viewport)&&Number.isSafeInteger(status.viewport.revision)&&status.viewport.revision>=0;}
const key=status=>`${identity(status)}:${status.viewport.revision}:${status.viewport.width}x${status.viewport.height}`;

/** User-owned, latest-only guest-mode fitting. No Take/Cede, wake or VM power.
 * Native geometry is trusted main-process data; no renderer-chosen VM/device. */
export class WorkbenchGuestResolution{
  constructor({workbench,getNativeStatus,onStatus=()=>{},clock=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,
    pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),debounceMs=400,minIntervalMs=1000,confirmTimeoutMs=3000}={}){
    if(!workbench?.consoleControl||typeof workbench.status!=='function'||
      ![workbench.guestNativeDesktopAction,workbench.guestAction].some(value=>typeof value==='function')||typeof getNativeStatus!=='function')throw fail('Guest resolution dependencies are unavailable.');
    Object.assign(this,{workbench,getNativeStatus,onStatus,clock,setTimer,clearTimer,pause,debounceMs,minIntervalMs,confirmTimeoutMs});
    this.enabled=false;this.controlToken=null;this.controlRevision=null;this.generation=0;this.timer=null;this.desired=null;
    this.running=false;this.lastDispatchAt=-Infinity;this.attempted=null;this.inventory=null;this.closed=false;this.receipt={enabled:false,state:'disabled'};
  }
  status(){return {...this.receipt};}
  publish(value){this.receipt={enabled:this.enabled,...value};try{this.onStatus(this.status())}catch{}return this.status();}
  cancelTimer(){if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;}
  configure({enabled,controlToken}={}){
    if(typeof enabled!=='boolean'||this.closed)throw fail('Choose whether automatic guest resolution is enabled.');
    if(enabled){
      if(this.workbench.consoleControl.status().owner!=='user')throw fail('Automatic resolution requires the current user control receipt.','WORKBENCH_CONTROL_HELD_BY_USER');
      this.workbench.consoleControl.assert(controlToken);
    }
    this.cancelTimer();++this.generation;this.enabled=enabled;this.controlToken=enabled?controlToken:null;
    this.controlRevision=enabled?this.workbench.consoleControl.status().revision:null;
    this.desired=null;this.attempted=null;this.inventory=null;
    return this.publish({state:enabled?'waiting':'disabled'});
  }
  assertCurrent(generation){
    if(this.closed||!this.enabled||this.generation!==generation)throw fail('Guest resize was cancelled.','WORKBENCH_RESOLUTION_CANCELLED');
    this.workbench.consoleControl.assert(this.controlToken,this.controlRevision);
    if(this.workbench.consoleControl.status().owner!=='user')throw fail('Automatic resolution requires user ownership.');
  }
  observe(status){
    if(this.closed||!this.enabled)return this.status();
    try{this.assertCurrent(this.generation)}catch{this.cancelTimer();this.desired=null;return this.publish({state:'paused',reason:'Guest control changed.'});}
    if(!validNative(status)){this.cancelTimer();this.desired=null;return this.publish({state:'waiting',reason:'Waiting for a visible, restored native viewport.'});}
    const next={key:key(status),hwnd:identity(status),revision:status.viewport.revision,width:status.viewport.width,height:status.viewport.height};
    if(this.desired?.key===next.key||this.attempted===next.key)return this.status();
    this.desired=next;this.schedule();return this.status();
  }
  schedule(){
    this.cancelTimer();if(this.running||!this.desired||!this.enabled||this.closed)return;
    const delay=Math.max(this.debounceMs,this.minIntervalMs-(this.clock()-this.lastDispatchAt));
    this.timer=this.setTimer(()=>{this.timer=null;return this.run();},delay);this.timer?.unref?.();
  }
  async checkNative(target,generation){
    this.assertCurrent(generation);const status=await this.getNativeStatus();this.assertCurrent(generation);
    if(!validNative(status)||key(status)!==target.key||this.desired?.key!==target.key)throw fail('A newer native viewport superseded this resize.','WORKBENCH_RESOLUTION_SUPERSEDED');
    return status;
  }
  async action(kind,args,target,generation){
    await this.checkNative(target,generation);
    const execute=typeof this.workbench.guestNativeDesktopAction==='function'?
      this.workbench.guestNativeDesktopAction:this.workbench.guestAction;
    const response=await execute.call(this.workbench,{kind,args,controlToken:this.controlToken,expectedAgent:target.agent});
    this.assertCurrent(generation);
    if(response?.status!=='completed'||response.agentId!==target.agent.agentId||response.guestSessionId!==target.agent.guestSessionId)
      throw fail('The same paired guest agent did not confirm this request; no retry was sent.','WORKBENCH_RESOLUTION_UNCONFIRMED');
    return response.result;
  }
  async run(){
    if(this.running||!this.desired||!this.enabled||this.closed)return;
    const target=this.desired,generation=this.generation;this.running=true;this.attempted=target.key;
    try{
      await this.checkNative(target,generation);
      const state=await this.workbench.status();this.assertCurrent(generation);const agent=state?.guest?.agent;
      if(!state.guest?.running||agent?.paired!==true||!Number.isSafeInteger(agent.guestSessionId)||agent.guestSessionId<=0||
        typeof agent.agentId!=='string'||!agent.agentId||
        !['display_info','display_resize'].every(capability=>agent.capabilities?.includes(capability)))throw fail('This paired guest has not advertised resolution support.');
      target.agent={agentId:agent.agentId,guestSessionId:agent.guestSessionId};
      const agentKey=`${agent.agentId}:${agent.guestSessionId}`;
      if(this.inventory?.agentKey!==agentKey){
        const info=await this.action('display_info',{guestSessionId:agent.guestSessionId},target,generation);
        if(info?.supported!==true||info.remoteSession!==false||!size(info.current)||info.current.bpp!==32||!Array.isArray(info.modes)||
          !info.modes.length||info.modes.length>512||info.modes.some(mode=>!size(mode)||mode.bpp!==32))throw fail('Guest display inventory does not support bounded local-console resizing.');
        this.inventory={...info,agentKey};
      }
      const selected=selectWorkbenchGuestMode(this.inventory.modes,target);
      if(!selected)throw fail('No supported guest mode fits this viewport.');
      const native=await this.checkNative(target,generation);
      if(native.surface?.width===selected.width&&native.surface?.height===selected.height){this.publish({state:'applied',requested:{width:target.width,height:target.height},actual:selected,changed:false});return;}
      this.publish({state:'applying',requested:{width:target.width,height:target.height},selected});
      this.lastDispatchAt=this.clock();
      const result=await this.action('display_resize',{...selected,guestSessionId:agent.guestSessionId},target,generation);
      if(result?.confirmed!==true||result.actual?.width!==selected.width||result.actual?.height!==selected.height||result.actual?.bpp!==32)throw fail('The guest did not confirm the selected physical resolution.','WORKBENCH_RESOLUTION_UNCONFIRMED');
      const deadline=this.clock()+this.confirmTimeoutMs;let confirmed;
      do{
        confirmed=await this.checkNative(target,generation);
        if(confirmed.surface?.width===selected.width&&confirmed.surface?.height===selected.height)break;
        if(this.clock()>=deadline)throw fail('The native surface has not confirmed the new guest mode. The scaled view remains available.','WORKBENCH_RESOLUTION_UNCONFIRMED');
        await this.pause(100);
      }while(true);
      this.inventory.current={...this.inventory.current,...selected};
      this.publish({state:'applied',requested:{width:target.width,height:target.height},actual:selected,changed:result.changed===true});
    }catch(error){
      if(generation===this.generation&&!this.closed)this.publish({state:error.code==='WORKBENCH_RESOLUTION_SUPERSEDED'?'waiting':'scaled',reason:String(error.message||error).slice(0,240),code:error.code||'WORKBENCH_RESOLUTION_UNAVAILABLE'});
    }finally{this.running=false;if(this.desired&&this.desired.key!==target.key)this.schedule();}
  }
  close(){this.cancelTimer();this.closed=true;this.enabled=false;this.controlToken=null;this.desired=null;++this.generation;return this.publish({state:'closed'});}
}
