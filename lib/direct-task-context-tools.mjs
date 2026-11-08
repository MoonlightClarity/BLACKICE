const string=maxLength=>({type:'string',minLength:1,maxLength});
const id=string(240),handle={...string(100),pattern:'^taskctx_[a-f0-9-]{36}$'},generation={type:'integer',minimum:1};
const requestId={...string(120),pattern:'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$'};
const action=(name,fields,required)=>({type:'object',properties:{requestId,action:{const:name},...fields},required:['requestId','action',...required],additionalProperties:false});
const allowed={issue:['taskId','expectedRevision','workItemId','criterionId','adapters','bindingId'],read:['taskContext'],revoke:['taskContext','expectedGeneration']};
const methods={issue:'issueContext',read:'readContext',revoke:'revokeContext'};
export function createDirectTaskContextTools({runtime,onChange=()=>{}}={}){
 if(!runtime||Object.values(methods).some(m=>typeof runtime[m]!=='function'))throw new Error('Host-owned context runtime required.');
 return [{definition:{name:'blackice_task_context',description:'Issue, inspect or revoke an explicit owner-scoped task context. Pass taskContext explicitly on protected adapter calls; it never grants permission or merges account identities. Unsupported opaque effects are blocked in protected mode. Revocation never clears uncertain prior effects.',scope:'planning:write',requiredScopes:['planning:write'],mutating:true,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
 inputSchema:{type:'object',required:['requestId','action'],oneOf:[
 action('issue',{taskId:id,expectedRevision:generation,workItemId:id,criterionId:id,bindingId:id,adapters:{type:'array',items:{enum:['relay_browser','relay_workspace']},minItems:1,maxItems:2,uniqueItems:true}},['taskId','expectedRevision','workItemId','criterionId','adapters']),
 action('read',{taskContext:handle},['taskContext']),
 action('revoke',{taskContext:handle,expectedGeneration:generation},['taskContext','expectedGeneration'])
 ]}},
 async execute(args,{client,jobId,signal}={}){
  if(!client?.id||!jobId)throw Object.assign(new Error('Authenticated durable job required.'),{code:'DIRECT_AUTH_REQUIRED',status:401});
  signal?.throwIfAborted();const fields=allowed[args.action];
  if(!fields||Object.keys(args).some(k=>!['requestId','action',...fields].includes(k)))throw new Error('Unsupported task context action or fields.');
  const input={...Object.fromEntries(fields.filter(k=>Object.hasOwn(args,k)).map(k=>[k,args[k]])),ownerId:client.id};
  const result=await runtime[methods[args.action]](input,{signal,client,jobId,requestId:args.requestId});
  try{await onChange({type:'direct.task.context',operation:args.action});}catch{}
  return {success:true,contentItems:[{type:'inputText',text:JSON.stringify({operation:args.action,result})}]};
 }}];
}
