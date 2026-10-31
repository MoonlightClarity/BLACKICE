import { responseCycleResponseSchema } from '../public/response-cycle-model.mjs';

const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const id={type:'string',minLength:1,maxLength:120,pattern:'^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$'};
const revision={type:'integer',minimum:1};
const text={type:'string',minLength:1,maxLength:12000};
const requestId={type:'string',minLength:1,maxLength:120,pattern:'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$',description:'Stable direct action ID. Identical retries recover the same durable job and cycle action.'};
const common={requestId,graphRequestId:id,expectedRequestRevision:revision};
const planRef={cycleId:id,expectedCycleRevision:revision,expectedPlanRevision:revision,expectedPlanResponseId:id};
const executionMode={type:'string',enum:['automatic','plan_only']};
const executionProfile={model:{type:'string',minLength:1,maxLength:500,description:'Explicit configured model ID for this cycle only. Omit to bind the current default on its first run.'},effort:{type:'string',enum:['default','none','minimal','low','medium','high','xhigh','max','ultra']},serviceTier:{type:'string',enum:['default','fast']}};
const action=(name,fields,required)=>object({...common,action:{const:name},...fields},['requestId','action','graphRequestId','expectedRequestRevision',...required]);
const schema={type:'object',required:['requestId','action'],oneOf:[
  action('create',{parentNodeId:id,title:{...text,maxLength:240},purpose:text,planningExecutionMode:executionMode,expectedParentRevision:revision},['title','purpose']),
  action('run',{cycleId:id,expectedCycleRevision:revision,planningExecutionMode:executionMode,...executionProfile},['cycleId','expectedCycleRevision']),
  action('edit_plan',{...planRef,plan:responseCycleResponseSchema('plan')},['cycleId','expectedCycleRevision','expectedPlanRevision','expectedPlanResponseId','plan']),
  action('continue',planRef,['cycleId','expectedCycleRevision','expectedPlanRevision','expectedPlanResponseId']),
  object({requestId,action:{const:'answer'},graphRequestId:id,nodeId:id,requirementId:id,answer:text,expectedNodeRevision:revision,expectedResponseId:id},['requestId','action','graphRequestId','nodeId','requirementId','answer','expectedNodeRevision','expectedResponseId'])
]};
const fail=(message,code,status=400)=>Object.assign(new Error(message),{code,status});

/** Explicit provider actions are separate from the inert graph read/write tools. */
export function createDirectResponseCycleTools({service,onChange=()=>{}}={}){
  if(!service)return[];
  return [{
    definition:{name:'blackice_planning_cycle',description:'Create, run to an editable Plan, edit, answer a factual gap, or explicitly continue the same recursive Feasibility → Inference → Plan → Think → Respond cycle used in BLACKICE. create and edit_plan only save public graph data. run is a deliberate configured-model action; plan_only stops before operational work. continue uses the exact current plan/request/cycle revisions and can resume the original authorized conversation. Read current metadata with blackice_planning_graph_read first. answer records a factual answer and may resume only the original automatic intent; Plan only stays paused. Neither reading nor editing starts work. Stable requestId retries recover the same receipt.',scope:'commands:run',requiredScopes:['commands:run','planning:write'],inputSchema:schema,mutating:true,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
    async execute(args,{client,jobId,signal}={}){
      if(!client?.id||!jobId)throw fail('An authenticated durable direct job is required.','DIRECT_AUTH_REQUIRED',401);
      signal?.throwIfAborted();
      const {action,requestId:directRequestId,graphRequestId,cycleId,...fields}=args;
      const value={...fields,clientRequestId:jobId},options={signal,actor:{type:'external-agent',id:client.id},receipt:{jobId,connectionId:client.id,requestId:directRequestId,tool:'blackice_planning_cycle'}};
      let saved;
      if(action==='create')saved=await service.createCycle(graphRequestId,value,options);
      else if(action==='run')saved=await service.runCycle(graphRequestId,cycleId,value,options);
      else if(action==='edit_plan')saved=await service.editPlan(graphRequestId,cycleId,value,options);
      else if(action==='continue')saved=await service.continueCycle(graphRequestId,cycleId,value,options);
      else if(action==='answer')saved=await service.answerQuestion(graphRequestId,value,options);
      else throw fail('Choose a declared response-cycle action.','DIRECT_PLANNING_CYCLE_INVALID');
      try{await onChange({type:'planning.browser.updated',data:{requestId:saved.id,conversationId:saved.conversationId,revision:saved.revision},at:new Date().toISOString()});}catch{}
      return{success:true,contentItems:[{type:'inputText',text:JSON.stringify({operation:action,request:saved,executionRequested:['run','continue','answer'].includes(action)})}]};
    }
  }];
}
