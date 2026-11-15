import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';
const overflow=()=>Object.assign(new Error('provider context capacity exceeded'),{code:'CONTEXT_OVERFLOW'});
const done=()=>({output:JSON.stringify({status:'complete',nextAction:'none',finding:'Fixture export verified',candidate_answer:'Export ready',uncertainty:''})});
const tool={type:'function',name:'fixture_export',description:'Fixture only',inputSchema:{type:'object',properties:{action:{type:'string'}}}};
async function fixture(t,runtime,dispatchTool,signal){const cwd=await mkdtemp(path.join(os.tmpdir(),'directory-recover-'));t.after(()=>rm(cwd,{recursive:true,force:true}));const runner=new ShadowdancerDirectory({cwd,conversationId:'fixture',runId:'run',model:'fixture',runtime,baseTools:[tool],dispatchTool,actionDirectory:true,signal,getAuthoritativeContext:async()=> 'User constraint: retain source records.'});await runner.open();return runner;}
test('completed and uncertain outcomes survive typed exhaustion before phase completion',async t=>{
 let runner,calls=0,dispatches=0,firstSession;
 const runtime={runAgent:async options=>{
   if(++calls===1){firstSession=options.directoryTurnId;await options.onToolCall({name:'fixture_export',callId:'first',arguments:{action:'export'}});await options.onToolCall({name:'fixture_export',callId:'second',arguments:{action:'unknown'}});throw overflow();}
   assert.notEqual(options.directoryTurnId,firstSession);assert.match(options.prompt,/retain source records/);
   const rows=await runner.actionJournal.events();const outcomes=rows.filter(r=>r.event.kind==='outcome');
   assert.equal(outcomes.length,2);assert.equal(outcomes[0].event.result.success===false||outcomes[1].event.result.success===false,true);
   const index=await options.onToolCall({name:'relay_directory_action',callId:'index',arguments:{action:'read'}});assert.equal(index.success,true);
   return done();
 }};
 runner=await fixture(t,runtime,async call=>{dispatches++;assert.ok((await runner.actionJournal.events()).some(r=>r.event.kind==='attempt'&&r.event.callId===call.callId));return call.arguments.action==='unknown'?{success:false,code:'LOST_REPLY'}:{success:true,contentItems:[{type:'inputText',text:'Independent fixture receipt export-1'}]};});
 await runner.infer('work','modules/1',{objective:'Export a document and inspect another result',doneWhen:'Verified export'});
 assert.equal(calls,2);assert.equal(dispatches,2);
});
test('repeated exhaustion without new outcomes terminates and never dispatches',async t=>{
 let calls=0;const runner=await fixture(t,{runAgent:async()=>{calls++;throw overflow();}},async()=>assert.fail('No dispatch expected'));
 await assert.rejects(runner.infer('work','modules/1',{objective:'Inspect sources',doneWhen:'Verified'}),{code:'DIRECTORY_RECOVERY_STALLED'});assert.equal(calls,2);
});
test('cancellation prevents fresh session admission after exhaustion',async t=>{
 const controller=new AbortController();let calls=0;
 const runner=await fixture(t,{runAgent:async()=>{calls++;controller.abort();throw overflow();}},async()=>{},controller.signal);
 await assert.rejects(runner.infer('work','modules/1',{objective:'Inspect sources'}),{name:'AbortError'});assert.equal(calls,1);
});
test('untyped provider failures are not silently retried as context exhaustion',async t=>{
 let calls=0;const runner=await fixture(t,{runAgent:async()=>{calls++;throw Object.assign(new Error('generic failure'),{code:'CODEX_TURN_FAILED'});}},async()=>{});
 await assert.rejects(runner.infer('work','modules/1',{objective:'Inspect sources'}),{code:'CODEX_TURN_FAILED'});assert.equal(calls,1);
});
test('overflow waits for admitted delayed tool outcome before opening replacement session',async t=>{
 let calls=0,finished=false,release;const gate=new Promise(resolve=>{release=resolve;});
 const runner=await fixture(t,{runAgent:async options=>{
   if(++calls===1){void options.onToolCall({name:'fixture_export',callId:'delayed',arguments:{action:'export'}});setTimeout(release,25);throw overflow();}
   assert.equal(finished,true);return done();
 }},async()=>{await gate;finished=true;return {success:true};});
 await runner.infer('work','modules/1',{objective:'Export report'});assert.equal(calls,2);
});
