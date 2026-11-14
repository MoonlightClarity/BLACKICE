import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {observeGoalToolOutcome, repeatedUnproductiveOperations, assessGoalProgress, detectNoProgressDispatchLoop, detectUnknownEffectReplay} from '../lib/goal-recovery-policy.mjs';
import {ConversationGoals} from '../lib/conversation-goals.mjs';

const call = (name, args) => ({name, arguments: args});
const result = (success, code = null, data = null) => ({
  success, ...(code ? {code} : {}), contentItems: data == null ? [] : [{type:'inputText',text:JSON.stringify(data)}],
});

test('a stale tool ref with no dispatch is recoverable friction with an observed next probe', () => {
  const row = observeGoalToolOutcome(call('relay_browser',{action:'click',tabId:'t',ref:'old'}), result(false,'BROWSER_REF_STALE',{
    actionDispatched:false,recovery:{nextCall:{action:'snapshot',tabId:'t'}}}));
  assert.equal(row.kind,'recoverable_no_dispatch');
  assert.equal(row.actionDispatched,false);
  assert.match(row.guidance,/snapshot/);
});

test('an ambiguous external action must be reconciled, never silently retried', () => {
  const row = observeGoalToolOutcome(call('relay_browser',{action:'submit',tabId:'t',ref:'button'}), result(false,'TIMEOUT'));
  assert.equal(row.kind,'uncertain_external_effect');
  assert.equal(row.actionDispatched,null);
  assert.match(row.guidance,/Do NOT replay/);
});

test('a tool success and self-declared milestone are not verified progress', () => {
  const row = observeGoalToolOutcome(call('relay_browser',{action:'click',tabId:'t',ref:'button'}), result(true,null,{ok:true}));
  assert.equal(row.kind,'tool_executed_unverified');
  const verdict = assessGoalProgress({milestones:[]},{goalEvidence:[row],
    goalProgress:{milestone:'Employer accepted application',evidence:'The tool clicked the button.'}});
  assert.equal(verdict.progress,false);
  assert.equal(verdict.progressKind,'unverified');
  assert.equal(verdict.observedMilestone,null);
});

test('a new host-observed intermediate state can advance a goal without claiming final success', () => {
  const report = {observedMilestone:'host-field-hash',milestone:'completed form field',evidence:'Read back exact new value'};
  const verdict = assessGoalProgress({milestones:[]},{goalEvidence:[{tool:'relay_browser',kind:'tool_executed_unverified'}],goalProgress:report});
  assert.equal(verdict.progress,true);
  assert.equal(verdict.progressKind,'host_observed_intermediate');
  assert.equal(assessGoalProgress({milestones:['host-field-hash']},{goalEvidence:[{}],goalProgress:report}).progress,false);
});

test('unchanged failed operations are recognized; different targets and authorizations are distinct', () => {
  const old = observeGoalToolOutcome(call('relay_browser',{action:'click',tabId:'T',ref:'B',requestId:'a'}),result(false,'TIMEOUT'));
  const repeated = observeGoalToolOutcome(call('relay_browser',{action:'click',tabId:'T',ref:'B',requestId:'b'}),result(false,'TIMEOUT'));
  const different = observeGoalToolOutcome(call('relay_browser',{action:'click',tabId:'T',ref:'C',requestId:'c'}),result(false,'TIMEOUT'));
  assert.equal(old.signature,repeated.signature);
  assert.notEqual(old.signature,different.signature);
  assert.equal(repeatedUnproductiveOperations([old],[repeated]).length,1);
  assert.equal(repeatedUnproductiveOperations([old],[different]).length,0);
  assert.equal(assessGoalProgress({lastToolEvidence:[old],previousNextAction:'Retry same click'},
    {goalEvidence:[repeated],goalProgress:{nextAction:'Retry same click',milestone:'new claim',evidence:'not independently checked'}}).repeatedNextAction,true);
});

test('hard denial of a read path is a candidate blocker, not a conclusion that the objective is impossible', () => {
  const row = observeGoalToolOutcome(call('relay_workspace',{action:'read',path:'restricted'}),result(false,'AUTH_REQUIRED'));
  assert.equal(row.kind,'candidate_blocker');
  assert.match(row.guidance,/alternate tool/);
});

test('three host-rejected clicks on the same page halt further clicks, but allow read-only inspection and a distinct branch', async () => {
  const same = i => call('relay_browser',{action:'click',tabId:'form',expectedUrl:'https://example.test/form',ref:'button-'+i,requestId:'r'+i});
  const denied = Array.from({length:3},(_,i) => ({...observeGoalToolOutcome(same(i),
    result(false,'CONTROL_UNINSPECTED',{actionDispatched:false,error:'Observed input required'})),at:new Date().toISOString()}));
  assert.match(denied[0].guidance,/HOST refused/);
  assert.match(denied[0].guidance,/not reinterpret a host error as a website CAPTCHA/);
  const blocked = detectNoProgressDispatchLoop(denied,same(4));
  assert.equal(blocked.code,'GOAL_REPLAN_REQUIRED');
  assert.equal(detectNoProgressDispatchLoop(denied,call('relay_browser',{action:'snapshot',tabId:'form'})),null);
  assert.equal(detectNoProgressDispatchLoop(denied,call('relay_browser',{action:'click',tabId:'different',ref:'button-4'})),null);
  assert.equal(detectNoProgressDispatchLoop(denied,same(4),{after:Date.now()+10}),null);
  const manager=Object.create(ConversationGoals.prototype);
  manager.raw=()=>({lastToolEvidence:denied});
  const run={taskId:'test',goal:{id:'goal'},goalEvidence:[]};
  let called=0;
  const guarded=manager.wrapTools(run,'agent',async() => {called++;return result(true,null,{ok:true});});
  const rejected=await guarded(same(4));
  assert.equal(rejected.code,'GOAL_REPLAN_REQUIRED');
  assert.equal(called,0,'rejected attempt must not reach the effectful tool');
  const inspection=await guarded(call('relay_browser',{action:'snapshot',tabId:'form'}));
  assert.equal(inspection.success,true);
  assert.equal(called,1,'read-only inspection remains available');
});

test('an unknown side effect blocks identical redispatch but does not dedupe distinct actions', () => {
  const send = id => call('relay_browser',{action:'submit',tabId:'form',ref:id,requestId:'request-'+id});
  const unknown=observeGoalToolOutcome(send('first'),result(false,'TRANSPORT_LOST'));
  assert.equal(unknown.kind,'uncertain_external_effect');
  assert.equal(detectUnknownEffectReplay([unknown],send('first')).code,'GOAL_EFFECT_UNRESOLVED');
  assert.equal(detectUnknownEffectReplay([unknown],send('second')),null);
  assert.equal(detectUnknownEffectReplay([unknown],call('relay_browser',{action:'read',tabId:'form'})),null);
});

test('in-flight identical effect is refused while distinct and sequential effects remain available', async () => {
  let release; const pending=new Promise(resolve=>release=resolve), dispatched=[];
  const manager=new ConversationGoals({engine:{runs:new Map()},conversations:{states:{root:{}}},autoStart:false});
  const run={id:'turn',taskId:'root',goal:{id:'goal'},goalEvidence:[]};
  const wrapped=manager.wrapTools(run,'agent',async c=>{dispatched.push(c.arguments.ref);if(c.arguments.ref==='one'&&dispatched.length===1)await pending;return result(true);});
  const first=call('relay_browser',{action:'click',tabId:'form',ref:'one'});
  const ongoing=wrapped(first);
  assert.equal((await wrapped(first)).code,'GOAL_EFFECT_IN_FLIGHT');
  assert.equal((await wrapped(call('relay_browser',{action:'click',tabId:'form',ref:'two'}))).success,true);
  run.status='cancelled';run.settled=false;
  assert.equal((await wrapped(first)).code,'GOAL_EFFECT_IN_FLIGHT');
  release();await ongoing;
  assert.equal((await wrapped(first)).success,true);
  assert.deepEqual(dispatched,['one','two','one']);
});

test('a thrown cancelled effect remains uncertain and persistence failure keeps the in-memory block', async () => {
  const conversations={states:{root:{}},async changeState(){throw Error('disk failed');}};
  const manager=new ConversationGoals({engine:{runs:new Map()},conversations,autoStart:false});
  const run={id:'turn',taskId:'root',goal:{id:'goal'},goalEvidence:[],status:'cancelled',settled:false};
  let dispatches=0;const wrapped=manager.wrapTools(run,'agent',async()=>{dispatches++;throw Object.assign(Error('Cancelled after possible dispatch'),{name:'AbortError'});});
  const effect=call('relay_browser',{action:'click',tabId:'form',ref:'one'});
  await assert.rejects(wrapped(effect),/disk failed/);
  assert.equal((await wrapped(effect)).code,'GOAL_EFFECT_UNRESOLVED');assert.equal(dispatches,1);
});

test('local action changes actual state and independent readback, without equating tool transport with proof', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'blackice-real-effect-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'record.json');
  const expected={id:'controlled-local-action',value:37,checked:true};
  await writeFile(file,JSON.stringify(expected));
  const writeReceipt=observeGoalToolOutcome(call('relay_workspace',{action:'write',path:file}),result(true,null,{bytes:57}));
  assert.equal(writeReceipt.kind,'tool_executed_unverified');
  const observed=JSON.parse(await readFile(file,'utf8')); // Independent filesystem read, not write receipt.
  assert.deepEqual(observed,expected);
  const readReceipt=observeGoalToolOutcome(call('relay_workspace',{action:'read',path:file}),result(true,null,observed));
  assert.equal(readReceipt.kind,'observation');
  assert.equal(observed.checked,true);
});
