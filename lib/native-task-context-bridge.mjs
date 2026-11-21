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
 // Historical attachments are retained for inspection, not rehydrated as
 // execution authority, tool filters, receipt prerequisites or final blockers.
 // The engine's ordinary handlers retain native observations and call replay.
 async open(){return null;}
}
export function createNativeTaskContextTool({getBridge}={}){
 const str={type:'string',minLength:1,maxLength:256};
 return {definition:{name:'blackice_native_task_context',description:"Read or change the saved taskContext attachment on one idle native task. read requires nativeTaskId and returns nativeRevision, attachment state and generation. attach also requires expectedNativeRevision and taskContext; detach requires expectedNativeRevision and expectedGeneration. The host reports NATIVE_TASK_PROVIDER_BOUNDARY if this provider cannot support attachment. Changes leave earlier outcome records intact and do not start a model.",scope:'planning:write',requiredScopes:['planning:write'],mutating:true,inputSchema:{type:'object',additionalProperties:false,properties:{requestId:{...str,maxLength:120},action:{enum:['attach','read','detach']},nativeTaskId:str,expectedNativeRevision:{type:'integer',minimum:1},expectedGeneration:{type:'integer',minimum:1},taskContext:str},required:['requestId','action','nativeTaskId'],oneOf:[{properties:{action:{const:'attach'}},required:['expectedNativeRevision','taskContext']},{properties:{action:{const:'read'}}},{properties:{action:{const:'detach'}},required:['expectedNativeRevision','expectedGeneration']}]}},
 async execute(args,{client,signal}={}){
  const bridge=getBridge?.();if(!bridge)throw fail('Native task bridge unavailable.');
  const allowed={attach:['requestId','action','nativeTaskId','expectedNativeRevision','taskContext'],read:['requestId','action','nativeTaskId'],detach:['requestId','action','nativeTaskId','expectedNativeRevision','expectedGeneration']}[args.action];
  if(!allowed||Object.keys(args).some(k=>!allowed.includes(k)))throw fail('Use only fields for this native attachment action.');
  const result=await bridge[args.action]({...args,client,signal});return {success:true,contentItems:[{type:'inputText',text:JSON.stringify(result)}]};
 }};
}
