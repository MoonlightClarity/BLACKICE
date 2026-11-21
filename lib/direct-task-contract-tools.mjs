import { PLAN_CONTRACT_SCHEMA } from '../public/planning-contract-model.mjs';
import { directTaskContractInterpretation } from './direct-task-guidance.mjs';
const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const string=maxLength=>({type:'string',minLength:1,maxLength});
const id=string(240),requestId={...string(120),pattern:'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$'};
const action=(name,fields={},required=[])=>object({requestId,action:{const:name},taskId:id,...fields},['requestId','action','taskId',...required]);
const schema={type:'object',required:['requestId','action'],oneOf:[
 object({requestId,action:{const:'bind_plan'},sourceTaskId:id,expectedSourceRevision:{type:'integer',minimum:1}},['requestId','action','sourceTaskId','expectedSourceRevision']),
 action('create',{contract:PLAN_CONTRACT_SCHEMA},['contract']),
 action('read'),action('measure'),
 action('authorize_repeat',{bindingId:id,userInstructionRef:string(1000),userInstructionQuote:string(8000),reason:string(2000),acknowledgeUncertainty:{type:'boolean'},uncertaintyStatement:string(4000),tabId:id},['bindingId','userInstructionRef','userInstructionQuote','reason']),
 action('update',{contract:PLAN_CONTRACT_SCHEMA,expectedRevision:{type:'integer',minimum:1}},['contract','expectedRevision']),
 action('bind',{tabId:id,workItemId:id,criterionId:id,identityFields:{type:'array',items:string(256),minItems:1,maxItems:20,uniqueItems:true},ref:string(500),expectedUrl:string(4096),expectedDocumentId:string(240)},['tabId','workItemId','criterionId','identityFields','ref','expectedUrl','expectedDocumentId']),
 action('reconcile',{tabId:id,bindingId:id,phase:{enum:['baseline','outcome']}},['tabId','bindingId','phase'])
]};
const allowed={
 bind_plan:['sourceTaskId','expectedSourceRevision'],
 authorize_repeat:['taskId','bindingId','userInstructionRef','userInstructionQuote','reason','acknowledgeUncertainty','uncertaintyStatement','tabId'],
 create:['taskId','contract'],read:['taskId'],measure:['taskId'],update:['taskId','contract','expectedRevision'],
 bind:['taskId','tabId','workItemId','criterionId','identityFields','ref','expectedUrl','expectedDocumentId'],
 reconcile:['taskId','tabId','bindingId','phase']
};
const fail=(message,code='DIRECT_TASK_CONTRACT_INVALID',status=400)=>Object.assign(new Error(message),{code,status});
export function createDirectTaskContractTools({runtime,bindPlan=null,onChange=()=>{}}={}){
 if(!runtime || Object.keys(allowed).filter(method=>method!=='bind_plan').some(method=>typeof runtime[method==='authorize_repeat'?'authorizeRepeat':method]!=='function'))throw fail('Use the host-owned task contract runtime.','DIRECT_TASK_CONTRACT_CONFIGURATION',503);
 return [{
  definition:{name:'blackice_task_contract',description:"Save a task contract and track observed outcomes.\n- bind_plan links a saved plan using sourceTaskId and expectedSourceRevision; create saves a supplied contract; read returns it; update requires expectedRevision.\n- bind records one observed submit control using tabId, ref, expectedUrl and expectedDocumentId. identityFields identify the subject and target, such as applicant and job. Binding does not click.\n- reconcile reads destination evidence for bindingId: phase baseline checks earlier results; phase outcome checks this attempt. An UNKNOWN result means the effect is unresolved; inspect the destination or saved receipts to resolve it.\n- measure returns distinct outcomes confirmed in the recorded history. Missing history does not establish that no earlier outcome exists.\n- authorize_repeat records repeat intent from the user's request with userInstructionRef, userInstructionQuote and reason. For an UNKNOWN result, also describe the uncertainty and its acknowledgement in the supplied fields. This records the agent's interpretation, not a new user approval.",scope:'planning:write',requiredScopes:['planning:write','browser:read'],inputSchema:schema,mutating:true,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
  async execute(args,{client,jobId,signal}={}){
   if(!client?.id || !jobId)throw fail('Authenticated durable job required.','DIRECT_AUTH_REQUIRED',401);
   signal?.throwIfAborted();
   const fields=allowed[args.action];if(!fields)throw fail('Choose a declared task contract action.');
   const permitted=new Set(['requestId','action',...fields]);if(Object.keys(args).some(k=>!permitted.has(k)))throw fail('Unsupported task contract fields.');
   const input={...Object.fromEntries(fields.filter(k=>Object.hasOwn(args,k)).map(k=>[k,args[k]])),ownerId:client.id};
   if(args.action==='bind_plan'&&!bindPlan)throw fail('Canonical plan source is unavailable.','DIRECT_PLAN_SOURCE_UNAVAILABLE',503);
   const value=args.action==='bind_plan'?await bindPlan(input,{signal,client,jobId,requestId:args.requestId}):await runtime[args.action==='authorize_repeat'?'authorizeRepeat':args.action](input,{signal,client,jobId,requestId:args.requestId});
   try{await onChange({type:'direct.task.contract.updated',data:{taskId:args.taskId||value.taskId,operation:args.action},at:new Date().toISOString()});}catch{}
   const interpretation=directTaskContractInterpretation(value);
   return {success:true,contentItems:[{type:'inputText',text:JSON.stringify({operation:args.action,taskId:args.taskId||value.taskId,result:value,...(interpretation?{contractInterpretation:interpretation}:{})})}]};
  }
 }];
}
