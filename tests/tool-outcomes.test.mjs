import test from 'node:test';
import assert from 'node:assert/strict';
import {toolResultEvent,nativeToolResultEvent} from '../lib/tool-outcomes.mjs';
import {modelToolCapability,reduceToolOutcome,renderToolIssues} from '../public/tool-outcomes-model.mjs';
import {reduceRunEvent} from '../public/run-state-model.mjs';
test('returned command and structured failures produce explicit bounded redacted receipts',()=>{
 for(const detail of [{success:false,error:'secret failed'},{ok:false,message:'secret failed'},{exitCode:7,stderr:'secret failed'},{isError:true,message:'secret failed'}]){
  const event=toolResultEvent({name:'relay_workspace',callId:'call',arguments:'{"action":"exec"}'},{success:true,contentItems:[{type:'inputText',text:JSON.stringify(detail)}]},value=>value.replaceAll('secret','[redacted]'));
  assert.equal(event.success,false);assert.equal(event.status,'failed');assert.equal(event.callId,'call');assert.ok(!event.message.includes('secret'));assert.ok(event.message.length<=1200);
 }
 assert.equal(toolResultEvent({name:'relay_workspace'},{success:true}).success,true);
 assert.equal(toolResultEvent({name:'missing'},{success:false}).message,'The tool did not complete.');
});
test('live failure receipts survive trace trimming through node summaries and show recovery without hiding failures',()=>{
 let run={id:'run',nodes:{agent:{}},events:[]};const failure={type:'tool.result',tool:'relay_connections',action:'call',integration:'publish',operationKey:'publish-fixture',callId:'one',operationKey:'fixture-operation',success:false,status:'failed',message:'<script>Unavailable</script>'};
 const event=data=>({type:'agent.event',runId:'run',nodeId:'agent',data});run=reduceRunEvent(run,event(failure));run=reduceRunEvent(run,event(failure));assert.equal(run.nodes.agent.toolSummary.failed,1);
 for(let i=0;i<3100;i++)run=reduceRunEvent(run,event({type:'delta',delta:''}));assert.equal(run.nodes.agent.toolSummary.failed,1);assert.match(renderToolIssues(run),/1 tool issue/);assert.ok(!renderToolIssues(run).includes('<script>'));assert.match(renderToolIssues(run),/&lt;script&gt;/);
 run=reduceRunEvent(run,event({...failure,callId:'two',success:true,status:'completed'}));assert.match(renderToolIssues(run),/Tool errors recovered/);assert.match(renderToolIssues(run),/1 failed call/);
});
test('known tool-less models are disclosed while unknown capability is not falsely disabled',()=>{
 const status={defaultModel:'text',models:[{id:'text',displayName:'Text model',supportsTools:false},{id:'capable',supportsTools:true},{id:'unknown'}]};
 assert.match(modelToolCapability(status).message,/cannot browse, edit files or publish posts/);assert.equal(modelToolCapability(status,'unknown').available,true);assert.equal(modelToolCapability(status,'capable').verified,true);
 assert.match(renderToolIssues({nodes:{a:{toolCapability:modelToolCapability(status)}}}),/Tools unavailable/);
 assert.match(renderToolIssues({nodes:{a:{capabilityIssues:[{message:'Neo could not start.'}]}}}),/Neo could not start/);
});
test('verified browser readiness clears only its old availability warning and retains failed action receipts',()=>{
 const run={id:'r',nodes:{a:{capabilityIssues:[{tool:'BrowserOS Neo',available:false,message:'Disconnected'},{tool:'Other tool',available:false,message:'Missing'}],toolSummary:{failed:1,completed:0,issues:[{tool:'relay_connections',message:'Publish failed',resolved:false}]}}},events:[]};
 const next=reduceRunEvent(run,{type:'agent.event',runId:'r',nodeId:'a',data:{type:'capability',tool:'BrowserOS Neo',available:true}});
 assert.deepEqual(next.nodes.a.capabilityIssues.map(issue=>issue.tool),['Other tool']);assert.equal(next.nodes.a.toolSummary.failed,1);assert.equal(next.nodes.a.toolSummary.issues[0].resolved,false);
});
test('failure totals remain auditable when bounded detail history fills',()=>{
 let state;for(let i=0;i<80;i++)state=reduceToolOutcome(state,{type:'tool.result',tool:'relay_browser',callId:String(i),action:'open',success:false,status:'failed',message:'Unavailable'});
 assert.equal(state.failed,80);assert.equal(state.issues.length,50);assert.match(renderToolIssues({nodes:{a:{toolSummary:state}}}),/80 failed calls/);
});

test('recovering the retained recent failures cannot hide older unresolved operations after detail history is trimmed',()=>{
 let state;const call=index=>({name:'relay_workspace',arguments:{action:'read',path:`older-failure-${index}.txt`}});
 for(let index=0;index<80;index++)state=reduceToolOutcome(state,toolResultEvent({...call(index),callId:`failure-${index}`},{success:false,message:'File read failed.'}));
 assert.equal(state.failed,80);assert.equal(state.issues.length,50);assert.equal(state.omittedUnresolved,30);
 state=JSON.parse(JSON.stringify(state));
 for(let index=30;index<80;index++)state=reduceToolOutcome(state,toolResultEvent({...call(index),callId:`recovery-${index}`},{success:true}));
 assert.equal(state.issues.filter(issue=>!issue.resolved).length,0);assert.equal(state.omittedUnresolved,30);assert.equal(state.failed,80);assert.equal(state.completed,50);
 const html=renderToolIssues({nodes:{agent:{toolSummary:state}}});assert.doesNotMatch(html,/Tool errors recovered/);assert.match(html,/30 tool issues/);assert.match(html,/(?:older|earlier) failed calls.*no retained resolution receipt/i);
});
test('native command exits, rejected edits and failed MCP calls cannot disappear behind an assistant answer',()=>{
 assert.equal(nativeToolResultEvent({type:'agentMessage'}),null);
 assert.match(nativeToolResultEvent({id:'cmd',type:'commandExecution',status:'completed',exitCode:2}).message,/code 2/);
 assert.equal(nativeToolResultEvent({id:'edit',type:'fileChange',status:'declined'}).success,false);
 assert.equal(nativeToolResultEvent({id:'mcp',type:'mcpToolCall',status:'completed',server:'Neo',tool:'run',error:{message:'Disconnected'}}).message,'Disconnected');
});

test('unrelated MCP servers and different run code cannot falsely mark the failed operation recovered',()=>{
 const args={action:'call',connectionId:'browseros-neo',name:'run',arguments:{code:'return "PRIVATE_CODE_MARKER";',timeout:15000}};
 const failure=toolResultEvent({name:'relay_connections',callId:'original',arguments:args},{success:false,message:'The operation was not completed.'});
 const otherServer=toolResultEvent({name:'relay_connections',callId:'other-server',arguments:{...args,connectionId:'unrelated-server'}},{success:true});
 const otherCode=toolResultEvent({name:'relay_connections',callId:'other-code',arguments:{...args,arguments:{...args.arguments,code:'return "different task";'}}},{success:true});
 assert.ok(failure.operationKey);assert.notEqual(failure.operationKey,otherServer.operationKey);assert.notEqual(failure.operationKey,otherCode.operationKey);
 let summary=reduceToolOutcome(undefined,failure);summary=reduceToolOutcome(summary,otherServer);summary=reduceToolOutcome(summary,otherCode);
 assert.equal(summary.issues[0].resolved,false);assert.equal(summary.failed,1);assert.equal(summary.completed,2);
 assert.match(renderToolIssues({nodes:{a:{toolSummary:summary}}}),/1 tool issue/);
 assert.doesNotMatch(JSON.stringify(failure),/PRIVATE_CODE_MARKER/);
 const sameOperation=toolResultEvent({name:'relay_connections',callId:'same-operation',arguments:JSON.stringify({name:'run',arguments:{timeout:15000,code:'return "PRIVATE_CODE_MARKER";'},connectionId:'browseros-neo',action:'call'})},{success:true});
 assert.equal(sameOperation.operationKey,failure.operationKey,'canonical argument order preserves operation identity');
 summary=reduceToolOutcome(summary,sameOperation);assert.equal(summary.issues[0].resolved,true);assert.equal(summary.failed,1);
});

test('native commands and file edits recover only the exact operation without storing their arguments',()=>{
 for(const [first,second] of [
  [{id:'first',type:'commandExecution',status:'completed',exitCode:2,command:'private-command-one'},{id:'second',type:'commandExecution',status:'completed',exitCode:0,command:'private-command-two'}],
  [{id:'first',type:'fileChange',status:'failed',changes:[{path:'private-one.txt',kind:'update',diff:'-old\n+new'}]},{id:'second',type:'fileChange',status:'completed',changes:[{path:'private-two.txt',kind:'update',diff:'-old\n+new'}]}],
 ]){
  const failure=nativeToolResultEvent(first),unrelated=nativeToolResultEvent(second);
  assert.ok(failure.operationKey);assert.notEqual(failure.operationKey,unrelated.operationKey);
  let summary=reduceToolOutcome(reduceToolOutcome(undefined,failure),unrelated);assert.equal(summary.issues[0].resolved,false);
  const matching=nativeToolResultEvent({...first,id:'retry',status:'completed',exitCode:0});
  assert.equal(matching.operationKey,failure.operationKey);summary=reduceToolOutcome(summary,matching);assert.equal(summary.issues[0].resolved,true);
  assert.doesNotMatch(JSON.stringify(failure),/private-command|private-one|old\\n/);
 }
});

test('legacy receipts without operation identity remain visibly unresolved after a generic tool success',()=>{
 const failure={type:'tool.result',tool:'relay_connections',action:'call',integration:'run',callId:'legacy-failed',success:false,status:'failed',message:'Unverified legacy action'};
 const state=reduceToolOutcome(reduceToolOutcome(undefined,failure),{...failure,callId:'later-success',success:true,status:'completed'});
 assert.equal(state.issues[0].resolved,false);assert.match(renderToolIssues({nodes:{a:{toolSummary:state}}}),/1 tool issue/);
});

test('a task revision retry recovers only the same mutation while preserving exact operation receipts',()=>{
 for(const mutation of [
  {action:'edit',operations:[{op:'update',stepId:'capture',changes:{status:'done',evidence:['PRIVATE_EVIDENCE_MARKER']}}]},
  {action:'artifact',path:'runs/check-one/report.md',title:'Verified research'},
 ]){
  const args={...mutation,expectedRevision:8},before=structuredClone(args);
  const failed=toolResultEvent({name:'relay_task',callId:'stale',arguments:args},{success:false,code:'TASK_STATE_CONFLICT',message:'Read the latest task revision.'});
  const retry=toolResultEvent({name:'relay_task',callId:'retried',arguments:JSON.stringify({...mutation,expectedRevision:10})},{success:true});
  assert.deepEqual(args,before,'receipt construction must not remove the caller revision');
  assert.notEqual(failed.operationKey,retry.operationKey,'the original exact operation identities remain distinct');
  assert.equal(failed.recoveryKey,retry.recoveryKey);
  assert.match(failed.recoveryKey,/^[a-f0-9]{64}$/);
  let summary=reduceToolOutcome(undefined,failed);
  summary=JSON.parse(JSON.stringify(summary));
  summary=reduceToolOutcome(summary,retry);
  assert.equal(summary.issues[0].resolved,true);
  assert.equal(summary.failed,1);assert.equal(summary.completed,1);
  assert.match(renderToolIssues({nodes:{agent:{toolSummary:summary}}}),/Tool errors recovered/);
  assert.match(renderToolIssues({nodes:{agent:{toolSummary:summary}}}),/1 failed call/);
  assert.doesNotMatch(JSON.stringify(failed),/PRIVATE_EVIDENCE_MARKER|runs\/check-one/);
 }
});

test('task conflict recovery retains target, action and payload identity',()=>{
 const mutation={action:'edit',expectedRevision:4,operations:[{op:'update',stepId:'capture',changes:{note:'Checked source',expectedRevision:20}}]};
 const failed=toolResultEvent({name:'relay_task',callId:'stale',arguments:mutation},{success:false,contentItems:[{type:'inputText',text:JSON.stringify({error:{code:'TASK_STATE_CONFLICT',message:'Reread the task.'}})}]});
 let summary=reduceToolOutcome(undefined,failed);
 const otherMutations=[
  {...mutation,expectedRevision:5,operations:[{op:'update',stepId:'publish',changes:mutation.operations[0].changes}]},
  {...mutation,expectedRevision:5,operations:[{op:'update',stepId:'capture',changes:{note:'Different evidence',expectedRevision:20}}]},
  {...mutation,expectedRevision:5,operations:[{op:'update',stepId:'capture',changes:{note:'Checked source',expectedRevision:21}}]},
  {action:'artifact',expectedRevision:5,path:'capture'},
 ];
 for(const [index,args] of otherMutations.entries()){
  const success=toolResultEvent({name:'relay_task',callId:`other-${index}`,arguments:args},{success:true});
  assert.notEqual(success.recoveryKey,failed.recoveryKey);
  summary=reduceToolOutcome(summary,success);
  assert.equal(summary.issues[0].resolved,false);
 }
 const exact=toolResultEvent({name:'relay_task',callId:'matching',arguments:{...mutation,expectedRevision:6}},{success:true});
 summary=reduceToolOutcome(summary,exact);assert.equal(summary.issues[0].resolved,true);
});

test('revision-insensitive recovery is restricted to validated task conflict writes',()=>{
 const args={action:'artifact',path:'report.md',expectedRevision:1};
 for(const code of ['TASK_PLAN_READ_ONLY','TOOL_FAILED','TASK_ARTIFACT_CHANGED']){
  const failed=toolResultEvent({name:'relay_task',callId:code,arguments:args},{success:false,code,message:'The action failed.'});
  assert.equal(failed.recoveryKey,undefined);
  const later=toolResultEvent({name:'relay_task',callId:code+'-later',arguments:{...args,expectedRevision:2}},{success:true});
  assert.equal(reduceToolOutcome(reduceToolOutcome(undefined,failed),later).issues[0].resolved,false);
 }
 for(const [tool,argumentsValue] of [
  ['relay_workspace',args],['relay_connections',args],
  ['relay_task',{...args,expectedRevision:undefined}],['relay_task',{...args,expectedRevision:-1}],
  ['relay_task',{...args,expectedRevision:'1'}],['relay_task',{action:'read',expectedRevision:1}],
  ['relay_task',{action:'save_method',expectedRevision:1,methodName:'Snapshot-specific method'}],
 ])assert.equal(toolResultEvent({name:tool,arguments:argumentsValue},{success:false,code:'TASK_STATE_CONFLICT'}).recoveryKey,undefined);
 const legacy={type:'tool.result',tool:'relay_task',action:'artifact',operationKey:'old-exact-key',success:false,status:'failed',code:'TASK_STATE_CONFLICT'};
 const current=toolResultEvent({name:'relay_task',arguments:{...args,expectedRevision:2}},{success:true});
 assert.equal(reduceToolOutcome(reduceToolOutcome(undefined,legacy),current).issues[0].resolved,false,'old receipts cannot acquire an unverified recovery identity');
});
