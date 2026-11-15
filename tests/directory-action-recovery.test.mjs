import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';
const overflow=()=>Object.assign(new Error('provider context capacity exceeded'),{code:'CONTEXT_OVERFLOW'});
const done=()=>({output:JSON.stringify({status:'complete',nextAction:'none',finding:'Fixture export verified',candidate_answer:'Export ready',uncertainty:''})});
const tool={type:'function',name:'fixture_export',description:'Fixture only',inputSchema:{type:'object',properties:{action:{type:'string'}}}};

test('overflow replacement consumes the shared admission budget and preserves the completed receipt',async t=>{
 let calls=0,effects=0;
 const runner=await fixture(t,{runAgent:async options=>{calls++;await options.onToolCall({name:'fixture_export',callId:'once',arguments:{}});throw overflow();}},async()=>{effects++;return {success:true};});
 runner.limits.maxCalls=1;
 await assert.rejects(runner.infer('work','modules/budget',{objective:'Export once'}),{code:'DIRECTORY_CALL_BUDGET'});
 assert.equal(calls,1);assert.equal(effects,1);assert.equal(runner.stats.calls,1);assert.equal(runner.stats.resets,1);assert.equal(runner.stats.sessionsFailed,1);
 assert.equal((await runner.actionJournal.events()).filter(r=>r.event.kind==='outcome').length,1);
});
test('failed and successful replacement sessions are both accounted',async t=>{
 let calls=0;
 const runner=await fixture(t,{runAgent:async()=>{if(++calls===1)throw overflow();return done();}},async()=>{});
 await runner.infer('work','modules/accounting',{objective:'Recover'});
 assert.equal(runner.stats.calls,2);assert.equal(runner.stats.resets,2);assert.equal(runner.stats.sessionsFailed,1);assert.equal(runner.stats.sessionsSucceeded,1);
});
test('concurrent phases cannot exceed a shared one-session budget',async t=>{
 let calls=0;
 const runner=await fixture(t,{runAgent:async()=>{calls++;return done();}},async()=>{});runner.limits.maxCalls=1;
 const results=await Promise.allSettled(['a','b'].map(id=>runner.infer('work','modules/'+id,{objective:id})));
 assert.equal(calls,1);assert.equal(runner.stats.calls,1);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.find(r=>r.status==='rejected').reason.code,'DIRECTORY_CALL_BUDGET');
});
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
test('a settled old session cannot admit a late tool into its replacement namespace',async t=>{
 let previous,calls=0,dispatches=0;
 const runner=await fixture(t,{runAgent:async options=>{
   if(++calls===1){previous=options;throw overflow();}
   await assert.rejects(previous.onToolCall({name:'fixture_export',callId:'late',arguments:{action:'export'}}),{code:'DIRECTORY_SESSION_CLOSED',actionDispatched:false});
   return done();
 }},async()=>{dispatches++;return {success:true};});
 await runner.infer('work','modules/1',{objective:'Export report'});assert.equal(dispatches,0);
});
test('an expired host deadline prevents replacement without replay',async t=>{
 let calls=0,runner;
 runner=await fixture(t,{runAgent:async()=>{calls++;runner.deadlineAt=Date.now()-1;throw overflow();}},async()=>assert.fail('No effect expected'));
 await assert.rejects(runner.infer('work','modules/1',{objective:'Export report'}),{code:'DIRECTORY_DEADLINE'});assert.equal(calls,1);
});
test('legacy context stays exact and attributed while new action state can link to it',async t=>{
 const runner=await fixture(t,{runAgent:async()=>done()},async()=>{});
 runner.evidenceContext=JSON.stringify({userCorrection:'Keep the source appendix',priorClaim:'Export may be incomplete'});
 await runner.importEvidence();const row=(await runner.actionJournal.events()).find(r=>r.event.kind==='legacy-context');
 assert.equal(row.event.authority,'attributed-prior-context');
 const original=JSON.parse((await runner.actionJournal.inspect({id:row.id,source:true})).text);
 assert.equal(original.content,runner.evidenceContext);
 await runner.actionJournal.note('migration-note',{actionId:'export',state:'Inspect original receipt before repeating',evidence:[row.id]});
 assert.equal((await runner.actionJournal.read({actionId:'export'})).total,1);
});

test('successive phases preserve immutable source snapshots in the same module',async t=>{
 const runner=await fixture(t,{runAgent:async()=>done()},async()=>({success:true}));
 await runner.infer('work','modules/1',{objective:'First obligation'});
 await runner.infer('work','modules/1',{objective:'Corrected obligation'});
 const rows=(await runner.actionJournal.events()).filter(r=>r.event.kind==='phase-authority');
 assert.equal(rows.length,2);assert.notEqual(rows[0].event.source.file,rows[1].event.source.file);
 for(const row of rows){const source=JSON.parse((await runner.actionJournal.inspect({id:row.id,source:true})).text);assert.equal(source.payload.objective,row.event.objective);}
});

test('failed journal admission proves only this invocation unsent and retains prior unknown effects',async t=>{
 let runner,dispatches=0;
 const call={name:'fixture_export',callId:'same',arguments:{action:'unknown'}};
 const runtime={runAgent:async options=>{
  await options.onToolCall(call);
  await assert.rejects(options.onToolCall(call),{code:'DIRECTORY_ATTEMPT_EXISTS',actionDispatched:false});
  assert.equal((await runner.actionJournal.events()).filter(r=>r.event.kind==='outcome'&&r.event.result.success===false).length,1);
  assert.equal((await runner.actionJournal.read()).metadataCounts.unknownOutcomes,1);
  return done();
 }};
 runner=await fixture(t,runtime,async()=>{dispatches++;return {success:false,code:'LOST_REPLY'};});
 await runner.infer('work','modules/1',{objective:'Reconcile an uncertain export'});assert.equal(dispatches,1);
});

test('concurrent work phases associate receipts only with their explicitly selected action',async t=>{
 let ready=0,release;const gate=new Promise(resolve=>release=resolve);
 const runtime={runAgent:async options=>{
  const id=options.prompt.includes('phase-left')?'left':'right';
  const selected=await options.onToolCall({name:'relay_directory_action',callId:'focus',arguments:{action:'record',actionId:id,objective:'Check '+id,state:'Verification pending',focus:true}});
  assert.equal(selected.success,true);if(++ready===2)release();await gate;
  await options.onToolCall({name:'fixture_export',callId:'shared-provider-id',arguments:{target:id}});
  return done();
 }};
 const runner=await fixture(t,runtime,async call=>call.arguments.target==='left'?{success:true}:{success:false,code:'LOST_REPLY'});
 await Promise.all([runner.infer('work','modules/1',{objective:'phase-left'}),runner.infer('work','modules/2',{objective:'phase-right'})]);
 for(const id of ['left','right']){
  const state=await runner.actionJournal.read({actionId:id});assert.equal(state.total,3);
  const attempt=(await runner.actionJournal.events()).find(r=>r.event.kind==='attempt'&&r.event.actionId===id);
  assert.equal(attempt.event.call.arguments.target,id);assert.equal(attempt.event.associationAuthority,'agent-selected');
 }
 const index=await runner.actionJournal.read();assert.equal(index.metadataCounts.unknownOutcomes,1);
 const heads=index.events.filter(r=>r.event.kind==='action-state');assert.ok(heads.every(r=>r.event.hostEvidence.attempts===1));
});

test('action selection survives typed rollover without claiming completion or replaying prior effects',async t=>{
 let sessions=0,runner;
 const runtime={runAgent:async options=>{
  if(++sessions===1){await options.onToolCall({name:'relay_directory_action',callId:'focus',arguments:{action:'record',actionId:'report',state:'Exported appendix still needs verification',focus:true}});
   await options.onToolCall({name:'fixture_export',callId:'export',arguments:{action:'export'}});throw overflow();}
  assert.match(options.prompt,/"focusedActionId":"report"/);
  await options.onToolCall({name:'fixture_export',callId:'read',arguments:{action:'read'}});return done();
 }};
 let exports=0;runner=await fixture(t,runtime,async call=>{if(call.arguments.action==='export')exports++;return {success:true};});
 await runner.infer('work','modules/1',{objective:'Export report and verify appendix'});
 const rows=await runner.actionJournal.events();assert.equal(exports,1);
 assert.ok(rows.filter(r=>r.event.kind==='attempt').every(r=>r.event.actionId==='report'));
 const index=await runner.actionJournal.read();const head=index.events.find(r=>r.event.kind==='action-state');
 assert.equal(head.event.hostEvidence.outcomes,2);assert.match(head.event.preview.state,/still needs verification/);
 assert.equal(index.events.filter(r=>r.event.kind==='outcome').length,0,'Grouped successful tool receipts remain in action history, not loose working entries');
 assert.equal((await runner.actionJournal.read({actionId:'report'})).total,5);
});

test('a fresh runner preserves associated history but does not silently select an earlier action',async t=>{
 const first=await fixture(t,{runAgent:async options=>{
  await options.onToolCall({name:'relay_directory_action',callId:'focus',arguments:{action:'record',actionId:'prior',focus:true,state:'Receipt retained'}});
  await options.onToolCall({name:'fixture_export',callId:'read',arguments:{action:'read'}});return done();
 }},async()=>({success:true}));
 await first.infer('work','modules/1',{objective:'Inspect first source'});
 const second=new ShadowdancerDirectory({cwd:first.cwd,conversationId:'fixture',runId:'successor',model:'fixture',actionDirectory:true,baseTools:[tool],dispatchTool:async()=>({success:true}),runtime:{runAgent:async options=>{
  await options.onToolCall({name:'fixture_export',callId:'read',arguments:{action:'read'}});return done();
 }}});
 await second.open();await second.infer('work','modules/1',{objective:'Inspect a different source'});
 const attempts=(await second.actionJournal.events()).filter(r=>r.event.kind==='attempt');assert.equal(attempts.length,2);
 assert.equal(attempts.filter(r=>r.event.actionId==='prior').length,1);
 assert.equal(attempts.filter(r=>r.event.actionId===undefined).length,1);
 assert.equal((await second.actionJournal.read({actionId:'prior'})).total,3);
});
