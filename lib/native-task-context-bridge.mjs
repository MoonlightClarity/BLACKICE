import {randomUUID} from 'node:crypto';
const fail=(message,code='NATIVE_TASK_CONTEXT_INVALID')=>Object.assign(new Error(message),{code,status:409,actionDispatched:false});
const denial=error=>({success:false,contentItems:[{type:'inputText',text:JSON.stringify({code:error.code,message:error.message,actionDispatched:false})}]});
const text=(value,name)=>{if(typeof value!=='string'||!value||value.length>256)throw fail('Invalid '+name);return value;};
/** Only an authenticated explicit attachment supplies the principal. Never infer it from native task IDs. */
export class NativeTaskContextBridge {
 constructor({runtime,tasks,planSource=null,isActive=()=>false,reauthorize=async()=>{},canEnforceProtectedDispatch=()=>false}={}){
  if(!runtime?.outcomes||!tasks?.get)throw fail('Native context bridge requires host task and outcome stores.');
  this.planSource=planSource;this.canEnforceProtectedDispatch=canEnforceProtectedDispatch;this.runtime=runtime;this.tasks=tasks;this.isActive=isActive;this.reauthorize=reauthorize;this.locks=new Map();
 }
 serial(id,fn){const pending=(this.locks.get(id)||Promise.resolve()).catch(()=>{}).then(fn);this.locks.set(id,pending);return pending.finally(()=>{if(this.locks.get(id)===pending)this.locks.delete(id);});}
 async attach({nativeTaskId,expectedNativeRevision,taskContext,client,signal}){
  text(nativeTaskId,'native task');text(taskContext,'task context');
  if(await this.canEnforceProtectedDispatch({nativeTaskId})!==true)throw fail('The selected provider cannot verify that all effects pass through the host dispatcher. Native protected context is unavailable.','NATIVE_TASK_PROVIDER_BOUNDARY');
  if(!client?.id||!Number.isSafeInteger(expectedNativeRevision))throw fail('Use the authenticated client and exact saved native task revision.');
  return this.serial(nativeTaskId,async()=>{
   const save=async()=>{
    signal?.throwIfAborted();await this.reauthorize(client,['planning:write']);
    const state=await this.tasks.get(nativeTaskId,{signal});
    if(!state.contract||state.taskSchemaVersion!==14)throw fail('Attach only a saved canonical contract task.','NATIVE_TASK_CONTRACT_REQUIRED');
    if(state.taskId!==nativeTaskId||state.revision!==expectedNativeRevision)throw fail('The native task changed. Read its exact saved revision before attaching.','NATIVE_TASK_REVISION_CHANGED');
    if(this.isActive(nativeTaskId))throw fail('Wait until the native task is fully idle before changing its explicit context attachment.','NATIVE_TASK_ACTIVE');
    if(this.planSource){
     const context=await this.runtime.outcomes.readContext({ownerId:client.id,taskContext});
     const snapshot=await this.planSource.snapshotForNativeState({ownerId:client.id,taskId:context.taskId,state});
     if(snapshot)await this.runtime.outcomes.syncPlanSnapshot({ownerId:client.id,taskId:context.taskId,...snapshot});
    }
    return this.runtime.outcomes.attachNativeTask({ownerId:client.id,taskContext,nativeTaskId,nativeRevision:expectedNativeRevision,client});
   };
   return this.tasks.enqueue?this.tasks.enqueue(nativeTaskId,save):save();
  });
 }
 async read({nativeTaskId,client,signal}){
  await this.reauthorize(client,['planning:write']);signal?.throwIfAborted();
  const saved=await this.tasks.get(nativeTaskId,{signal}),attachment=await this.runtime.outcomes.readNativeAttachment({nativeTaskId});
  if(attachment&&attachment.ownerId!==client?.id)throw fail('This native attachment belongs to another authenticated owner.','NATIVE_TASK_CONTEXT_OWNER');
  return {nativeTaskId,nativeRevision:saved.revision,attached:Boolean(attachment),...(attachment?{generation:attachment.generation,taskContext:attachment.taskContext,taskId:attachment.taskId}:{})};
 }
 async detach({nativeTaskId,expectedNativeRevision,expectedGeneration,client,signal}){
  text(nativeTaskId,'native task');if(!client?.id)throw fail('Authenticated owner required.');
  return this.serial(nativeTaskId,async()=>{
   const save=async()=>{
    await this.reauthorize(client,['planning:write']);signal?.throwIfAborted();
    const saved=await this.tasks.get(nativeTaskId,{signal});
    if(saved.revision!==expectedNativeRevision)throw fail('Read the exact saved native task revision before detaching.','NATIVE_TASK_REVISION_CHANGED');
    if(this.isActive(nativeTaskId))throw fail('Wait until the native task is fully idle before detaching.','NATIVE_TASK_ACTIVE');
    const result=await this.runtime.outcomes.detachNativeTask({ownerId:client.id,nativeTaskId,expectedGeneration});
    return {nativeTaskId,generation:result.generation,detached:true,outcomeEvidencePreserved:true};
   };
   return this.tasks.enqueue?this.tasks.enqueue(nativeTaskId,save):save();
  });
 }
 async open({nativeTaskId,runId,nodeId,signal}){
  return this.serial(nativeTaskId,async()=>{
   const attachment=await this.runtime.outcomes.readNativeAttachment({nativeTaskId});
   if(!attachment)return null;
   if(await this.canEnforceProtectedDispatch({nativeTaskId,runId})!==true)throw fail('The provider no longer guarantees host-only dispatch. No protected native run may start.','NATIVE_TASK_PROVIDER_BOUNDARY');
   const initial=await this.tasks.get(nativeTaskId,{signal});
   const linkedSource=this.planSource?await this.runtime.outcomes.readPlanSource({ownerId:attachment.ownerId,taskId:attachment.taskId}):null;
   if(linkedSource&&linkedSource.taskId!==nativeTaskId)throw fail('The attached canonical source differs from this native task.','DIRECT_PLAN_SOURCE_MISMATCH');
   if(!linkedSource&&initial.revision!==attachment.nativeRevision)throw fail('The native task changed after attachment. Read its current revision and explicitly reattach before starting.','NATIVE_TASK_REVISION_CHANGED');
   const material=JSON.stringify(initial.contract);
   const validate=async(scopes=['planning:write'])=>{
    signal?.throwIfAborted();
    if(await this.canEnforceProtectedDispatch({nativeTaskId,runId})!==true)throw fail('The provider lost its verified host-only dispatch boundary.','NATIVE_TASK_PROVIDER_BOUNDARY');
    const latest=await this.runtime.outcomes.readNativeAttachment({nativeTaskId});
    if(!latest||latest.generation!==attachment.generation||latest.ownerId!==attachment.ownerId||latest.taskContext!==attachment.taskContext)throw fail('The native task context attachment changed. No operation was dispatched.','NATIVE_TASK_CONTEXT_CHANGED');
    const currentPlan=await this.tasks.get(nativeTaskId,{signal});
    if(linkedSource)await this.runtime.syncCanonicalPlan({ownerId:attachment.ownerId,taskId:attachment.taskId,signal});
    if(!linkedSource&&JSON.stringify(currentPlan.contract)!==material)throw fail('The attached native material plan changed. Stop and explicitly reattach its reviewed revision.','NATIVE_TASK_PLAN_CHANGED');
    await this.reauthorize(attachment.client,scopes);
    return this.runtime.outcomes.readContext({ownerId:attachment.ownerId,taskContext:attachment.taskContext}).then(value=>{
      if(!value.valid)throw fail('The attached task context is revoked or stale.','NATIVE_TASK_CONTEXT_STALE');return value;
    });
   };
   await validate();
   const planSource=this.planSource;
   const runtime=this.runtime,ownerId=attachment.ownerId,client=attachment.client,taskContext=attachment.taskContext;
   const session={
    async gate(call,{controlTools=[]}={}){
     try{await validate();if(!call.namespace&&(['relay_browser','relay_workspace',...controlTools].includes(call.name)))return null;
      throw fail('This explicitly protected native task has no trusted adapter for '+call.name+'. Use a supported scoped observation or report the limitation.','NATIVE_TASK_ADAPTER_UNSUPPORTED');
     }catch(error){return denial(error);}
    },
    wrap(adapterId,rawHandler){
     if(!rawHandler)return rawHandler;
     const wrapped=async(call,outer={})=>{
      await validate(['planning:write',adapterId==='relay_browser'?'browser:read':'files:read']);
      const handler=async(innerCall,inner={})=>{
       if(outer.operationDescriptor&&inner.operationDescriptor&&outer.operationDescriptor.operationKey!==inner.operationDescriptor.operationKey)throw fail('Native and shared operation descriptors disagree.','OPERATION_DESCRIPTOR_CHANGED');
       return rawHandler(innerCall,{...outer,...inner,onOperationDispatch:async actual=>{
        await validate(['planning:write',adapterId==='relay_browser'?(actual.effect==='observe'?'browser:read':'browser:write'):'files:read']);
        if(outer.canonicalAdmission&&outer.onOperationDispatch){
         await outer.onOperationDispatch(actual,{onAdmission:async({state})=>{
          const canonicalSnapshot=planSource?await planSource.snapshotForNativeState({ownerId,taskId:attachment.taskId,state}):null;
          if(inner.onOperationDispatch)await inner.onOperationDispatch(actual,canonicalSnapshot?{canonicalSnapshot}:{});
         }});
        }else{
         if(outer.onOperationDispatch)await outer.onOperationDispatch(actual);
         if(inner.onOperationDispatch)await inner.onOperationDispatch(actual);
        }
       }});
      };
      handler.describeOperation=(call,context)=>rawHandler.describeOperation(call,context);
      handler.normalizeOperationResult=(result,context)=>rawHandler.normalizeOperationResult(result,context);
      const observationHandler=async(readCall,inner={})=>rawHandler(readCall,{...inner,onOperationDispatch:async actual=>{
       await validate(['planning:write','browser:read']);
       if(inner.onOperationDispatch)await inner.onOperationDispatch(actual);
      }});
      observationHandler.describeOperation=(call,context)=>rawHandler.describeOperation(call,context);
      observationHandler.normalizeOperationResult=(result,context)=>rawHandler.normalizeOperationResult(result,context);
      const common={ownerId,client,taskContext,operationId:outer.operationId||'native:'+runId+':'+nodeId+':'+randomUUID(),handler,call,signal:outer.signal||signal};
      return adapterId==='relay_browser'?runtime.execute({...common,observationHandler,nativeAttachment:{nativeTaskId,generation:attachment.generation}}):runtime.executeScoped({...common,adapterId});
     };
     wrapped.describeOperation=(call,context)=>rawHandler.describeOperation(call,context);
     wrapped.normalizeOperationResult=(result,context)=>rawHandler.normalizeOperationResult(result,context);
     return wrapped;
    },
    async measurement(){await validate();return runtime.measure({ownerId,taskId:attachment.taskId});},
    async assertReady(){const result=await this.measurement();if(!result.satisfied)throw fail('The explicitly attached task outcome remains unverified. Preserve uncertain effects and report the blocker; do not replay.','NATIVE_TASK_CONTEXT_INCOMPLETE');return result;},
   };
   let prior=null;
   session.beforeFinal=async()=>{
    const result=await session.measurement();if(result.satisfied)return null;
    const fingerprint=JSON.stringify(result);
    if(prior===fingerprint)return session.assertReady();
    prior=fingerprint;
    return {continue:true,prompt:'The attached task contract is not yet satisfied. Successful tool calls and prior outcomes do not establish a new outcome. Reconcile supported destination evidence without repeating uncertain effects, or report the exact blocker. Current measurement: '+JSON.stringify(result)};
   };
   return session;
  });
 }
}
export function createNativeTaskContextTool({getBridge}={}){
 const str={type:'string',minLength:1,maxLength:256};
 return {definition:{name:'blackice_native_task_context',description:'Explicitly attach or detach an authenticated task context for one exact saved idle native task. Read returns the current attachment generation. Detach changes execution mode only, preserves every outcome and UNKNOWN claim, and never starts a model or task. Native tasks never inherit another conversation grant implicitly.',scope:'planning:write',requiredScopes:['planning:write'],mutating:true,inputSchema:{type:'object',additionalProperties:false,properties:{requestId:{...str,maxLength:120},action:{enum:['attach','read','detach']},nativeTaskId:str,expectedNativeRevision:{type:'integer',minimum:1},expectedGeneration:{type:'integer',minimum:1},taskContext:str},required:['requestId','action','nativeTaskId'],oneOf:[{properties:{action:{const:'attach'}},required:['expectedNativeRevision','taskContext']},{properties:{action:{const:'read'}}},{properties:{action:{const:'detach'}},required:['expectedNativeRevision','expectedGeneration']}]}},
 async execute(args,{client,signal}={}){
  const bridge=getBridge?.();if(!bridge)throw fail('Native task bridge unavailable.');
  const allowed={attach:['requestId','action','nativeTaskId','expectedNativeRevision','taskContext'],read:['requestId','action','nativeTaskId'],detach:['requestId','action','nativeTaskId','expectedNativeRevision','expectedGeneration']}[args.action];
  if(!allowed||Object.keys(args).some(k=>!allowed.includes(k)))throw fail('Use only fields for this native attachment action.');
  const result=await bridge[args.action]({...args,client,signal});return {success:true,contentItems:[{type:'inputText',text:JSON.stringify(result)}]};
 }};
}
