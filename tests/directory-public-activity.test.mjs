import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runPreparedDirectoryAgent} from '../lib/shadowdancer-engine.mjs';
import {CodexRuntime} from '../lib/codex.mjs';
import {planningActivityForEvent,mergePlanningActivity,projectPlanningActivity} from '../public/next/chat/planning-timeline.mjs';

async function fixture(t,{throws=false,failure=false}={}){
 const cwd=await mkdtemp(path.join(os.tmpdir(),'directory-activity-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const events=[],progress=[];let dispatched=0,observedDuringDispatch=false;
 const runtime={status:()=>({models:[]}),runAgent:async options=>{
  const phase=JSON.parse(options.prompt.split('CURRENT_DIRECTORY:\n').at(-1));
  if(phase.label==='work'){
   const nativeState={turnId:'native-turn',messages:new Map(),onBeforeFinal:async()=>null,finalMessageEvents:[]};
   const native={threads:new Map([['native-thread',nativeState]]),_emitRun:(_state,event)=>options.onEvent({...event,threadId:'PRIVATE'})};
   CodexRuntime.prototype._notification.call(native,'item/completed',{threadId:'native-thread',turnId:'native-turn',item:{id:'native-comment',type:'agentMessage',phase:'commentary',text:'Checking the local fixture.'}});
   // Mistral's rejected final and API adapter's incomplete/continued output
   // carry commentary labels without verified native commentary provenance.
   options.onEvent({type:'message',phase:'commentary',itemId:'vibe-final',text:'{"status":"incomplete","candidate_answer":"PRIVATE CONTINUED LEAF"}'});
   options.onEvent({type:'message',phase:'commentary',incomplete:true,text:'{"status":"PRIVATE INCOMPLETE LEAF'});
   options.onEvent({type:'message',phase:'commentary',text:'PRIVATE API TOOL-TURN TEXT'});
   options.onEvent({type:'item',stage:'completed',item:{type:'agentMessage',phase:'commentary',text:'PRIVATE UNVERIFIED ITEM'}});
   options.onEvent({type:'message',phase:'commentary',publicCommentarySource:'codex-native-phase',incomplete:true,text:'PRIVATE INCOMPLETE MARKED'});
   options.onEvent({type:'delta',text:'PRIVATE DELTA'});
   options.onEvent({type:'message',text:'PRIVATE JSON'});
   options.onEvent({type:'item',stage:'completed',item:{type:'reasoning',text:'PRIVATE REASONING'}});
   options.onEvent({type:'message',phase:'final_answer',text:'PRIVATE LEAF FINAL'});
   await options.onToolCall({callId:'fixture-1',name:'relay_workspace',arguments:{action:'read',path:'SECRET ARGUMENT'}});
  }
  const value=phase.label==='decompose'?{atomic:true}:phase.label==='integration'?{answer:'Fixture answer.',used_refs:phase.payload.required_refs}:
    {status:'complete',nextAction:'',finding:'Fixture result.',candidate_answer:'Fixture answer.',uncertainty:''};
  return {output:JSON.stringify(value)};
 }};
 const operation=runPreparedDirectoryAgent({runtime,options:{cwd,sandbox:'danger-full-access',dynamicTools:[{name:'relay_workspace',description:'fixture',inputSchema:{type:'object'}}],
  onEvent:e=>events.push(e),onToolCall:async()=>{dispatched++;observedDuringDispatch=progress.some(e=>e.event==='action-started')&&!progress.some(e=>e.event==='action-returned');
   if(throws)throw Error('Fixture transport lost');return {success:!failure,contentItems:[{type:'inputText',text:'SECRET RECEIPT'}]};}},
  input:'/directory Check local fixture.',conversationId:'activity',runId:'run',model:'fixture',onProgress:e=>progress.push(e),getAcceptedDirections:()=>({currentUserRequest:{text:'Check local fixture.'}})});
 if(throws)await assert.rejects(operation,/Fixture transport lost/);else await operation;
 return {events,progress,dispatched,observedDuringDispatch};
}
test('Directory exposes explicit completed commentary, not private leaf answers or reasoning',async t=>{
 const f=await fixture(t);const messages=f.events.filter(e=>e.type==='message');
 assert.deepEqual(messages.filter(e=>e.phase==='commentary').map(e=>e.text),['Checking the local fixture.']);
 assert.ok(messages.some(e=>e.phase==='final_answer'&&e.text==='Fixture answer.'));
 assert.ok(!JSON.stringify(messages).includes('PRIVATE'));assert.equal(f.dispatched,1);
});
test('host action activity is emitted while dispatch remains pending and contains no payload',async t=>{
 const f=await fixture(t);assert.equal(f.observedDuringDispatch,true);
 const actions=f.progress.filter(e=>e.event.startsWith('action-'));assert.deepEqual(actions.map(e=>e.event),['action-started','action-returned']);
 assert.equal(actions[1].receiptStatus,'success');assert.ok(!JSON.stringify(actions).includes('SECRET'));
});
test('failed tool result is distinct from transport uncertainty and neither is retried',async t=>{
 const failed=await fixture(t,{failure:true});assert.equal(failed.progress.find(e=>e.event==='action-returned').receiptStatus,'failure');assert.equal(failed.dispatched,1);
 const uncertain=await fixture(t,{throws:true});assert.equal(uncertain.dispatched,1);assert.ok(uncertain.progress.some(e=>e.event==='action-uncertain'));assert.ok(!uncertain.progress.some(e=>e.event==='action-returned'));
});
test('public timeline persists bounded source-labelled activity without arguments or task-success claims',()=>{
 const event={nodeId:'agent',at:'2026-11-16T00:00:00Z',data:{type:'shadowdancer.step',callId:'phase:call',tool:'relay_workspace',action:'read',event:'action-returned',receiptStatus:'success',arguments:'SECRET'}};
 const rows=planningActivityForEvent('run',event);assert.match(rows[0].text,/task completion is not yet verified/);assert.equal(rows[0].source,'directory-action');
 assert.ok(!JSON.stringify(rows).includes('SECRET'));assert.equal(mergePlanningActivity(rows,rows).length,1);
 assert.equal(projectPlanningActivity({id:'run',planningActivity:rows,events:[]}).length,1);
 const many=Array.from({length:300},(_,n)=>({...rows[0],id:'directory:run:'+n}));assert.equal(mergePlanningActivity([],many).length,160);
});
