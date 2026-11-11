import {createHash} from 'node:crypto';
import {normalizePlanContract} from '../public/planning-contract-model.mjs';
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const fail=(message,code='DIRECT_PLAN_SOURCE_INVALID')=>Object.assign(new Error(message),{code,status:409,actionDispatched:false});
export function canonicalPlanSnapshot(state){
 if(!state||state.taskSchemaVersion!==14||!state.contract)throw fail('Select a saved canonical version 14 task plan.');
 const normalized=normalizePlanContract(state.contract,{allowEpoch:true}),{planEpoch,...contract}=normalized;
 return {contract,source:{kind:'task-state-v14',taskId:state.taskId,revision:state.revision,planEpoch:planEpoch||1,contractDigest:hash(contract)}};
}
/** Host-only bridge. Source snapshots are read under TaskStore's existing process/file lock. */
export class CanonicalTaskPlanSource{
 constructor({tasks,runtime,reauthorize=async()=>{}}={}){
  if(!tasks?.enqueue||!tasks?.get||!runtime?.outcomes)throw fail('Canonical source requires the host task and outcome stores.');
  this.tasks=tasks;this.runtime=runtime;this.reauthorize=reauthorize;
 }
 async projectState(state,{client,signal}={}){
  if(!client?.id || !client.scopes?.includes('read'))throw fail('Use an authenticated projection reader.','DIRECT_AUTH_REQUIRED');
  await this.reauthorize(client,['read']);signal?.throwIfAborted();
  if(state?.taskSchemaVersion!==14 || !state.contract)return state;
  const ownerId=client.id,taskId='canonical:'+hash([ownerId,state.taskId]);
  const projection=await this.runtime.outcomes.readPlanProjection({ownerId,taskId,sourceTaskId:state.taskId});
  if(!projection)return state;
  await this.reauthorize(client,['read']);signal?.throwIfAborted();
  const current=canonicalPlanSnapshot(state).source,saved=projection.source;
  const stale=saved.revision!==current.revision||saved.planEpoch!==current.planEpoch||saved.contractDigest!==current.contractDigest;
  return {...state,directExecution:{...projection,provenance:'host-direct-outcome-store',
   authority:'evidence-projection-only',canonicalCompletionUnchanged:true,
   sourceStatus:stale?'stale':'current',currentSource:current,
   notice:'Host observations and dispatch receipts are separate from canonical completion. UNKNOWN effects remain unresolved; historical evidence is not proof of current execution success.'}};
 }
 // Host-local readers only. A persisted explicit attachment supplies the OAuth principal.
 // External readers must use projectState with their own verified OAuth identity.
 async projectAttachedState(state,{signal}={}){
  if(!state?.taskId || state.taskSchemaVersion!==14)return state;
  const attachment=await this.runtime.outcomes.readNativeAttachment({nativeTaskId:state.taskId});
  if(!attachment || attachment.client?.id!==attachment.ownerId ||
     attachment.taskId!=='canonical:'+hash([attachment.ownerId,state.taskId]))return state;
  const projected=await this.projectState(state,{client:attachment.client,signal});
  const current=await this.runtime.outcomes.readNativeAttachment({nativeTaskId:state.taskId});
  if(!current || current.generation!==attachment.generation || current.ownerId!==attachment.ownerId ||
     current.taskContext!==attachment.taskContext)return state;
  return projected;
 }
 async bindPlan({ownerId,sourceTaskId,expectedSourceRevision},{client,signal}={}){
  if(!client?.id||client.id!==ownerId)throw fail('Use the authenticated source owner.','DIRECT_AUTH_REQUIRED');
  if(typeof sourceTaskId!=='string'||!Number.isSafeInteger(expectedSourceRevision))throw fail('Select the exact saved canonical source revision.');
  await this.reauthorize(client,['planning:write']);signal?.throwIfAborted();
  return this.tasks.enqueue(sourceTaskId,async()=>{
   const state=await this.tasks.get(sourceTaskId,{signal});
   if(state.revision!==expectedSourceRevision)throw fail('The source plan changed. Read its current revision.','DIRECT_PLAN_SOURCE_STALE');
   const snapshot=canonicalPlanSnapshot(state),taskId='canonical:'+hash([ownerId,sourceTaskId]);
   return this.runtime.outcomes.syncPlanSnapshot({ownerId,taskId,...snapshot});
  },signal);
 }
 async withPlanSnapshot({ownerId,taskId,signal},callback){
  const source=await this.runtime.outcomes.readPlanSource({ownerId,taskId});
  if(!source)return callback(null);
  return this.tasks.enqueue(source.taskId,async()=>{
   signal?.throwIfAborted();
   const snapshot=canonicalPlanSnapshot(await this.tasks.get(source.taskId,{signal}));
   return callback(snapshot);
  },signal);
 }
 async snapshotForNativeState({ownerId,taskId,state}){
  const source=await this.runtime.outcomes.readPlanSource({ownerId,taskId});
  if(!source)return null;
  if(source.taskId!==state.taskId)throw fail('The native task is not the linked canonical source.','DIRECT_PLAN_SOURCE_MISMATCH');
  return canonicalPlanSnapshot(state);
 }
}
