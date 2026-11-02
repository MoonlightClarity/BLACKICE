/**
 * Explicit, serialized guest-input ownership. Screenshots remain inspectable
 * regardless of owner. Taking control pauses agent input after any already
 * dispatched guest operation finishes; ceding returns input to the agent.
 * No host mouse/keyboard or desktop focus APIs are used.
 */
import {randomUUID} from 'node:crypto';
const blocked=(message,code='WORKBENCH_CONSOLE_CONTROL_CONFLICT')=>
  Object.assign(new Error(message),{code,status:409});

export class WorkbenchConsoleControl {
  constructor({beforeOwnerChange=null}={}){
    if(beforeOwnerChange!==null&&typeof beforeOwnerChange!=='function')throw blocked('Guest ownership hook must be a function.');
    this.owner='agent';this.token=null;this.revision=0;
    this.tail=Promise.resolve();this.beforeOwnerChange=beforeOwnerChange;this.disableUnconfirmed=false;
  }
  status(){return {owner:this.owner,revision:this.revision,...(this.owner==='none'?{blocked:true,...(this.disableUnconfirmed?{inputDisableUnconfirmed:true}:{})}:{})}}
  // Same-process native UI only. Call within serialize(), then pass the token
  // through the existing run/cede fences. Never expose this via status or HTTP.
  localUserReceipt(expectedRevision){
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision!==this.revision||
      this.owner!=='user'||typeof this.token!=='string'||!this.token)
      throw blocked('The native Workbench user-control receipt is no longer current.');
    return {...this.status(),controlToken:this.token};
  }
  serialize(fn){
    const work=this.tail.then(fn);
    this.tail=work.catch(()=>{});
    return work;
  }
  assert(token,revision=this.revision){
    if(revision!==this.revision)throw blocked('Guest control changed before the operation was dispatched.');
    if(this.owner==='none')throw blocked('Guest input is disabled because its ownership could not be synchronized. Reconnect the viewer or take control again.','WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE');
    if(this.owner==='user'){
      if(typeof token!=='string'||token!==this.token)
        throw blocked('The user has taken guest control. Agent input is paused until they cede it.','WORKBENCH_CONTROL_HELD_BY_USER');
    }else if(token!==undefined&&token!==null){
      throw blocked('The user no longer holds guest control. Take control again before sending input.');
    }
  }
  async failClosed(cause,hooks=[this.beforeOwnerChange]){
    this.owner='none';this.token=null;++this.revision;this.disableUnconfirmed=false;
    for(const hook of new Set(hooks.filter(Boolean))){
      try{await hook({owner:'none',revision:this.revision,reason:'transition_failed'});}
      catch{this.disableUnconfirmed=true;}
    }
    const error=blocked('Guest input ownership could not be synchronized. Input is disabled; reconnect the viewer or take control again.','WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE');
    error.cause=cause;if(this.disableUnconfirmed)error.inputDisableUnconfirmed=true;
    throw error;
  }
  setTransitionHook(hook){
    if(hook!==null&&typeof hook!=='function')throw blocked('Guest ownership hook must be a function or null.');
    return this.serialize(async()=>{
      const previous=this.beforeOwnerChange;
      try{
        // Disable an old native input path before replacing or detaching it.
        if(previous&&previous!==hook)await previous({owner:'none',revision:this.revision,reason:'detach'});
        this.beforeOwnerChange=hook;
        if(hook)await hook({owner:this.owner,revision:this.revision,reason:'synchronize'});
        return this.status();
      }catch(error){this.beforeOwnerChange=hook||previous;return this.failClosed(error,[previous,hook]);}
    });
  }
  async transfer(owner,token,revision){
    const hook=this.beforeOwnerChange;
    try{
      // The same queue already fences guest-agent and Hyper-V operations. A
      // native renderer must acknowledge this change before the new receipt.
      if(hook)await hook({owner,revision,reason:'transfer'});
    }catch(error){return this.failClosed(error,[hook]);}
    // A known acknowledgement can be superseded while it is awaited. Keep the
    // newer queued transfer valid; intervening guest operations have stale
    // revisions and cannot dispatch before that newer transition settles.
    if(this.revision!==revision)throw blocked('A newer guest-control transfer superseded this request.');
    this.owner=owner;this.token=token;this.disableUnconfirmed=false;
    return {...this.status(),...(owner==='user'?{controlToken:token}:{})};
  }
  take(){
    const revision=++this.revision,token=randomUUID();
    return this.serialize(()=>{
      if(this.revision!==revision)throw blocked('A newer guest-control transfer superseded this request.');
      return this.transfer('user',token,revision);
    });
  }
  // Trusted coordinator: keep the lock order ownership -> Plan/store. A Plan
  // guard calls commit exactly once after checking its current evidence. The
  // commit never reenters this queue, and a newer human Take invalidates it.
  takeGuarded(expectedRevision,guard){
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||typeof guard!=='function')throw blocked('A guarded return requires its exact agent revision and host guard.');
    return this.serialize(async()=>{
      this.assert(undefined,expectedRevision);
      let committed=false,active=true,transferWork;
      const commit=()=>{
        if(!active||committed)throw blocked('This guarded handoff is no longer available.');
        this.assert(undefined,expectedRevision);
        committed=true;
        const revision=++this.revision,token=randomUUID();
        return transferWork=this.transfer('user',token,revision);
      };
      try{
        const result=await guard(commit);
        if(!committed)throw blocked('The host guard did not authorize this handoff.');
        return result;
      }finally{
        active=false;
        // Even an erroneous guard that forgets to await commit cannot release
        // ownership serialization before native release is acknowledged.
        if(transferWork)await transferWork;
      }
    });
  }
  cede(controlToken){
    if(this.owner!=='user'||typeof controlToken!=='string'||controlToken!==this.token)
      throw blocked('Only the current user-control holder can cede the guest.');
    const revision=++this.revision;
    return this.serialize(()=>{
      if(this.revision!==revision||controlToken!==this.token)
        throw blocked('A newer guest-control transfer superseded this request.');
      return this.transfer('agent',null,revision);
    });
  }
  // Internal run coordinator only: authenticate an explicit per-run VM-control
  // grant BEFORE calling. Never expose as a generic HTTP/renderer/model tool.
  // Call outside serialize(); cede owns the existing queue and release fence.
  handoffToAgent(expectedRevision){
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision!==this.revision)
      throw blocked('Guest control changed before the authorized run handoff.');
    this.assert(this.owner==='user'?this.token:undefined,expectedRevision);
    if(this.owner!=='user')throw blocked('An authorized handoff requires current user ownership.');
    return this.cede(this.token);
  }
  run(fn,controlToken){
    const revision=this.revision;
    return this.serialize(async()=>{
      this.assert(controlToken,revision);
      return fn(()=>this.assert(controlToken,revision));
    });
  }
}
