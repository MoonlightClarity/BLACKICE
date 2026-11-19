const operations=new Set(['plan','focus','observe','block','planningChoice','read']);
const number=value=>Number.isSafeInteger(value)?value:undefined;
const callId=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(value)?value:undefined;
/** Redacted lifecycle only. Issued text is kept transiently for exact delivery matching, never emitted. */
export function createDirectoryTelemetry({level,emit}){
 let sequence=0;const pending=new Map(),detailed=level==='on'||level==='maximal',maximal=level==='maximal';
 const send=value=>{if(detailed){try{emit({...value,sequence:++sequence});}catch{}}};
 return{
  bound(state){if(maximal&&state)send({type:'directory.snapshot',phase:'bound',snapshotRevision:state.revision,actionRevision:state.actionRevision});},
  mutation(args,boundActionRevision,{error,state}={}){if(!detailed||args.action==='read')return;const submitted=number(args.revision);send({type:'directory.mutation',phase:error?'rejected':'applied',operation:operations.has(args.action)?args.action:'unknown',revisionPresent:Object.hasOwn(args,'revision'),revisionType:args.revision===null?'null':Array.isArray(args.revision)?'array':typeof args.revision,...(submitted===undefined?{}:{submittedRevision:submitted}),boundActionRevision,...(number(error?.comparisonRevision)===undefined?{}:{comparisonRevision:error.comparisonRevision}),...(number(error?.comparisonActionRevision)===undefined?{}:{comparisonActionRevision:error.comparisonActionRevision}),...(state?{resultRevision:state.revision,resultActionRevision:state.actionRevision}:{}),code:error&&typeof error.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(error.code)?error.code:null,reason:error?(error.code==='DIRECTORY_CHANGED'?'action-snapshot-changed':'mutation-rejected'):'host-snapshot-binding'});},
  issued(call,state,text){if(!maximal)return;const id=callId(call.callId);const receipt={type:'directory.snapshot',phase:'issued',snapshotRevision:state.revision,actionRevision:state.actionRevision,...(id?{callId:id}:{})};send(receipt);if(id){pending.set(id,{text,receipt});if(pending.size>8)pending.delete(pending.keys().next().value);}},
  delivered({call,result}={}){if(!maximal||call?.name!=='relay_directory_action'||call.namespace)return;const id=callId(call.callId),saved=pending.get(id);if(!saved||result?.success===false||!result?.contentItems?.some(item=>item.type==='inputText'&&item.text===saved.text))return;pending.delete(id);send({...saved.receipt,phase:'delivered'});},
 };
}
