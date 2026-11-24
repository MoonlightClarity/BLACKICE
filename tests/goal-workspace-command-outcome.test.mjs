import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createWorkspaceToolHandler} from '../lib/workspace-tools.mjs';
import {attachWorkspaceCommandOutcome,readWorkspaceCommandOutcome} from '../lib/workspace-command-outcome.mjs';
import {observeGoalToolOutcome,detectUnknownEffectReplay,inFlightEffectSignature} from '../lib/goal-recovery-policy.mjs';
import {ConversationGoals} from '../lib/conversation-goals.mjs';
import {toolResultEvent} from '../lib/tool-outcomes.mjs';
const call=(command,extra={})=>({name:'relay_workspace',callId:'fixture-command-1',arguments:{action:'run',command},...extra});
const sample=(operation,patch={})=>{
 const ran={cwd:'C:\\fixture',exitCode:1,signal:null,timedOut:false,stdout:'test failed',stderr:'expected 1',truncated:false,...patch};
 return attachWorkspaceCommandOutcome(operation,{success:ran.exitCode===0&&ran.signal===null&&!ran.timedOut,
   contentItems:[{type:'inputText',text:JSON.stringify(ran)}]},ran);
};
test('a native normal exit distinguishes the settled invocation from unassessed effects',()=>{
 const op=call('node --test fixture.test.mjs'),result=sample(op),meta=readWorkspaceCommandOutcome(op,result);
 assert.equal(result.success,false);
 assert.equal(result.code,'WORKSPACE_COMMAND_EXIT_NONZERO');
 assert.equal(meta.status,'exited');assert.equal(meta.exitCode,1);assert.equal(meta.effectOutcome,'not-assessed');
 const observed=observeGoalToolOutcome(op,result);
 assert.equal(observed.kind,'settled_command_failure');assert.equal(observed.success,false);
 assert.equal(observed.actionDispatched,null);assert.equal(observed.commandExecution.effectOutcome,'not-assessed');
 assert.equal(detectUnknownEffectReplay([observed],op),null);
 assert.match(observed.guidance,/check possible consequential effects/i);
 assert.ok(inFlightEffectSignature(op));
 const event=toolResultEvent(op,result);
 assert.equal(event.success,false);assert.equal(event.code,'WORKSPACE_COMMAND_EXIT_NONZERO');assert.deepEqual(event.commandExecution,meta);
});
test('legacy, mismatched, namespaced, malformed and interrupted commands retain unresolved-effect behavior',()=>{
 const op=call('node --test fixture.test.mjs'),result=sample(op);
 const {commandExecution,...legacy}=result;
 const mutate=(r,patch)=>({...r,commandExecution:{...r.commandExecution,...patch}});
 const cases=[
  [op,legacy],
  [call('other command'),result],
  [{...op,callId:'different'},result],
  [{...op,namespace:'foreign'},result],
  [op,mutate(result,{effectOutcome:'absent'})],
  [op,mutate(result,{exitCode:2})],
  [op,mutate(result,{source:'model'})],
  [op,{...result,contentItems:[{type:'inputText',text:'{"exitCode":1}'}]}],
  [op,sample(op,{timedOut:true})],
  [op,sample(op,{exitCode:null,signal:'SIGTERM'})],
  [op,sample(op,{exitCode:null})],
 ];
 for(const [operation,response] of cases){
   const observed=observeGoalToolOutcome(operation,response);
   assert.equal(observed.kind,'uncertain_external_effect');
   assert.equal(detectUnknownEffectReplay([observed],operation)?.code,'GOAL_EFFECT_UNRESOLVED');
 }
 const old=observeGoalToolOutcome(op,legacy),current=observeGoalToolOutcome(op,result);
 assert.equal(detectUnknownEffectReplay([old,current],op)?.code,'GOAL_EFFECT_UNRESOLVED','later terminal receipt does not clear older genuine uncertainty');
});
test('real failing local Node test can be rerun through the Goal wrapper after an actual source repair',async t=>{
 const cwd=await mkdtemp(path.join(tmpdir(),'blackice-goal-command-outcome-'));
 t.after(()=>rm(cwd,{recursive:true,force:true}));
 const file=path.join(cwd,'fixture.test.mjs');
 const program=n=>"import test from 'node:test';import assert from 'node:assert/strict';test('fixture',()=>assert.equal("+n+",2));\n";
 await writeFile(file,program(1));
 const handler=createWorkspaceToolHandler({cwd});
 const conversations={states:{root:{}},async changeState(id,patch){this.states[id]={...this.states[id],...patch};}};
 const manager=new ConversationGoals({engine:{runs:new Map()},conversations,autoStart:false});
 const run={id:'turn',taskId:'root',goal:{id:'fixture-goal'},goalEvidence:[],status:'running',settled:false};
 const quoted=process.platform==='win32'?"& '"+process.execPath.replaceAll("'","''")+"'":"'"+process.execPath.replaceAll("'","'\\''")+"'";
 const operation=call(quoted+' --test fixture.test.mjs');
 const wrapped=manager.wrapTools(run,'agent',handler);
 const failed=await wrapped(operation);
 assert.equal(failed.success,false);
 assert.equal(readWorkspaceCommandOutcome(operation,failed)?.exitCode,1);
 assert.equal(run.goalEvidence.at(-1).kind,'settled_command_failure');
 assert.equal(conversations.states.root.goalUnresolvedEffects?.length??0,0);
 await writeFile(file,program(2));
 const next={...operation,callId:'fixture-command-2'};
 const passed=await wrapped(next);
 assert.equal(passed.success,true);
 assert.equal(readWorkspaceCommandOutcome(next,passed)?.exitCode,0);
 assert.equal(run.goalEvidence.at(-1).kind,'tool_executed_unverified');
 assert.equal(conversations.states.root.goalUnresolvedEffects?.length??0,0);
});
