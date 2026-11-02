import {createHash} from 'node:crypto';
import {verificationScriptHash} from '../../lib/workbench-effect-verification.mjs';
const sha=text=>createHash('sha256').update(text).digest('hex');
const ref={requestId:'request-a',cycleId:'cycle-a',nodeId:'plan-a',nodeRevision:4,responseId:'response-a'};
export function observationRun(values=[{uninstallEntries:[],executableHits:[],pathCommands:[],appx:[]}],options={}){
  const run={id:'run-a',taskId:'task-a',input:'Install the missing utility after establishing the baseline.',status:'completed',settled:true,createdAt:'2026-11-02T08:00:00.000Z',planningMode:'on',runtimeSettings:{executionGuardrails:false},workflow:{id:'workflow-a',name:'Fixture',nodes:[{id:'agent',type:'agent'}]},nodes:{agent:{status:'completed',taskSchemaVersion:12,output:'A captured result.'}},responseCycle:{planRef:structuredClone(ref),planning:{stages:[{stage:'plan',responseId:ref.responseId,nodeRevision:4,structuredResponseValid:true,durableResponseRecorded:true,checkedAt:'2026-11-02T08:01:00.000Z'}]}},events:[]};
  if(options.id)run.id=options.id;if(options.taskId)run.taskId=options.taskId;
  if(options.planRef){run.responseCycle.planRef=structuredClone(options.planRef);Object.assign(run.responseCycle.planning.stages[0],{responseId:options.planRef.responseId,nodeRevision:options.planRef.nodeRevision});}
  if(options.planCompletedAt)run.responseCycle.planning.stages[0].checkedAt=options.planCompletedAt;
  for(const [index,value]of values.entries()){
    const requestId='observed-'+index,script="$ErrorActionPreference='Stop'\n# Actual captured observation 日本語\nGet-Item -LiteralPath 'C:\\Fixture' | ConvertTo-Json -Compress",jobId=sha(run.taskId+'\n'+requestId).slice(0,32),at=new Date(Date.parse(run.responseCycle.planning.stages[0].checkedAt)+60000+index*10000).toISOString(),finishedAt=new Date(Date.parse(at)+1000).toISOString(),pollAt=new Date(Date.parse(at)+2000).toISOString();
    const result={jobId,status:'completed',exitCode:0,stdout:JSON.stringify(value)+'\r\n',stderr:'',stdoutTruncated:false,stderrTruncated:false,outputDrained:true,outputComplete:true,childrenStopped:true,finishedAt,guestName:'fixture-guest',guestSessionId:2,scriptSha256:verificationScriptHash(script)};
    const add=(action,callId,args,result,stamp)=>{const common={runId:run.id,nodeId:'agent',at:stamp},identity={threadId:'thread-a',turnId:'turn-a'};run.events.push({...common,data:{type:'tool.result',tool:'relay_workbench',action,callId,success:true,status:'completed',...identity}},
      {...common,data:{type:'item',stage:'completed',...identity,item:{type:'dynamicToolCall',tool:'relay_workbench',id:callId,status:'completed',success:true,arguments:{action,...args},contentItems:[{type:'inputText',text:JSON.stringify(result)}]}}});};
    add('run_guest_script','launch-'+index,{requestId,script},{jobId,status:'running',launchConfirmed:true},at);add('guest_job','poll-'+index,{jobId},result,pollAt);
  }
  return run;
}
