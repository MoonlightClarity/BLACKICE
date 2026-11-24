import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {observeGoalToolOutcome, repeatedUnproductiveOperations, assessGoalProgress, detectNoProgressDispatchLoop, detectUnknownEffectReplay, inFlightEffectSignature} from '../lib/goal-recovery-policy.mjs';
import {ConversationGoals, GOAL_TOOL} from '../lib/conversation-goals.mjs';
import {createProviderExecutionContract} from '../lib/provider-execution-contract.mjs';

const call = (name, args) => ({name, arguments: args});

test('an uncertain external effect exposes its exact receipt identity without replaying or assuming an outcome', () => {
  const navigation = call('relay_browser', {action:'navigate',tabId:'owned-tab',url:'https://example.test/portal'});
  const signature = inFlightEffectSignature(navigation);
  const pending = {id:'receipt-identified',signature,at:'2026-11-24T10:30:00.000Z',kind:'uncertain_external_effect',
    code:'BROWSER_NAVIGATION_FAILED',resolutions:[{outcome:'unknown'}]};
  const refusal=detectUnknownEffectReplay([pending],navigation);
  assert.equal(refusal.code,'GOAL_EFFECT_UNRESOLVED');
  assert.equal(refusal.actionDispatched,false);
  assert.deepEqual(refusal.reconcileIdentity,{receiptId:'receipt-identified',signature,
    observedAt:pending.at,expectedResolutionCount:1});
  assert.match(refusal.guidance,/relay_goal effects/);
  assert.match(refusal.guidance,/expectedResolutionCount/);
  assert.equal(detectUnknownEffectReplay([pending],call('relay_browser',{action:'read',tabId:'owned-tab'})),null);
  assert.equal(detectUnknownEffectReplay([pending],call('relay_browser',{action:'navigate',tabId:'owned-tab',url:'https://example.test/other'})),null);
  const legacy={...pending,at:undefined};
  const caution=detectUnknownEffectReplay([legacy],navigation);
  assert.equal(caution.code,'GOAL_EFFECT_UNRESOLVED');
  assert.equal(caution.reconcileIdentity,undefined,'A missing saved identity must not be fabricated.');
});

const result = (success, code = null, data = null) => ({
  success, ...(code ? {code} : {}), contentItems: data == null ? [] : [{type:'inputText',text:JSON.stringify(data)}],
});

test('equivalent browser fill spellings share one effect identity across failure and retry',()=>{
  const valueOnly=call('relay_browser',{action:'fill',browser:'relay',tabId:'owned-tab',ref:'field-3',value:'Evidence grounded answer'});
  const canonical=call('relay_browser',{action:'fill',browser:'relay',tabId:'owned-tab',ref:'field-3',text:'Evidence grounded answer'});
  const incompatible=call('relay_browser',{action:'fill',browser:'relay',tabId:'owned-tab',ref:'field-3',text:'different',value:'Evidence grounded answer'});
  const selected=call('relay_browser',{action:'select',browser:'relay',tabId:'owned-tab',ref:'field-3',value:'Evidence grounded answer'});
  assert.equal(inFlightEffectSignature(valueOnly),inFlightEffectSignature(canonical),
    'An argument alias must never defeat in-flight or unknown-effect replay protection.');
  assert.notEqual(inFlightEffectSignature(incompatible),inFlightEffectSignature(canonical));
  assert.notEqual(inFlightEffectSignature(selected),inFlightEffectSignature(canonical));
  const failed=observeGoalToolOutcome(valueOnly,{success:false,code:'BROWSER_ACTION_FAILED'});
  assert.equal(failed.kind,'uncertain_external_effect');
  const pending={...failed,id:'persisted-unresolved',at:'2026-11-24T10:30:00.000Z'};
  const refusal=detectUnknownEffectReplay([pending],canonical);
  assert.equal(refusal.code,'GOAL_EFFECT_UNRESOLVED');
  assert.equal(refusal.reconcileIdentity.receiptId,pending.id);
});

test('legacy persisted value-only fill receipts remain blocked after semantic normalization upgrade',()=>{
  const oldArgs={action:'fill',browser:'relay',tabId:'owned-tab',ref:'field',value:'Supported answer'};
  const oldCall=call('relay_browser',oldArgs);
  const sorted=Object.fromEntries(Object.entries(oldArgs).sort(([a],[b])=>a.localeCompare(b)));
  const legacySignature=createHash('sha256').update(JSON.stringify([oldCall.name,sorted])).digest('hex');
  const canonical=call('relay_browser',{action:'fill',browser:'relay',tabId:'owned-tab',ref:'field',text:'Supported answer'});
  assert.notEqual(legacySignature,inFlightEffectSignature(oldCall),
    'This case must exercise an actual pre-upgrade signature, not the new canonical signature.');
  const record={id:'legacy-saved-row',signature:legacySignature,at:'2026-11-24T09:00:00.000Z',
    kind:'uncertain_external_effect',code:'BROWSER_ACTION_FAILED'};
  for(const candidate of [canonical,oldCall]){
    const block=detectUnknownEffectReplay([record],candidate);
    assert.equal(block?.code,'GOAL_EFFECT_UNRESOLVED','An unknown historical write must not be replayed via either spelling.');
    assert.equal(block.reconcileIdentity.signature,legacySignature,'Reconciliation must use the original saved receipt identity.');
  }
  assert.equal(detectUnknownEffectReplay([{...record,resolution:{outcome:'occurred'}}],canonical).code,'GOAL_EFFECT_RECORDED_OCCURRED');
  assert.equal(detectUnknownEffectReplay([{...record,resolution:{outcome:'not_occurred'}}],canonical),null);
  assert.equal(detectUnknownEffectReplay([record],call('relay_browser',{...canonical.arguments,text:'Other answer'})),null);
  assert.equal(detectUnknownEffectReplay([record],call('relay_browser',{...oldArgs,action:'select'})),null);
});

test('recorded occurred effects prevent replay without suggesting another reconciliation',()=>{
  const target=call('relay_browser',{action:'click',tabId:'owned-page',ref:'submit'});
  const row={id:'known-row',at:'2026-11-24T10:30:00.000Z',signature:inFlightEffectSignature(target),
    kind:'uncertain_external_effect',code:'BROWSER_ACTION_FAILED'};
  const occurred=detectUnknownEffectReplay([{...row,resolution:{outcome:'occurred',evidence:'Destination receipt observed.'}}],target);
  assert.equal(occurred.code,'GOAL_EFFECT_RECORDED_OCCURRED');
  assert.equal(occurred.actionDispatched,false);
  assert.match(occurred.guidance,/do not replay/i);
  assert.doesNotMatch(occurred.guidance,/use relay_goal reconcile/i);
  assert.equal(detectUnknownEffectReplay([{...row,resolution:{outcome:'not_occurred',evidence:'Destination checked.'}}],target),null);
  assert.equal(detectUnknownEffectReplay([row],target).code,'GOAL_EFFECT_UNRESOLVED');
});

test('the fixed covered-target receipt distinguishes unissued pointer input from preparation effects', () => {
  for (const action of ['click', 'hover']) {
    const operation = call('relay_browser', {action, tabId:'form', ref:'continue'});
    const response = result(false, 'BROWSER_TARGET_COVERED', {code:'BROWSER_TARGET_COVERED', inputDispatched:false});
    const row = observeGoalToolOutcome(operation, response);
    assert.equal(row.kind, 'recoverable_no_input');
    assert.equal(row.inputDispatched, false);
    assert.equal(row.actionDispatched, null);
    assert.match(row.guidance, /Preparation may already have scrolled/);
    assert.match(row.guidance, /fresh snapshot/);
    assert.equal(detectUnknownEffectReplay([row], operation), null);
    assert.equal(observeGoalToolOutcome(operation, {...response, success:true}).kind, 'tool_executed_unverified');
  }
});

test('the fixed embedded-frame receipt preserves unissued pointer input with frame-specific recovery', () => {
  const code = 'BROWSER_FRAME_IDENTITY_AMBIGUOUS';
  for (const action of ['click', 'hover']) {
    const operation = call('relay_browser', {action, tabId:'form', ref:'continue'});
    const response = result(false, code, {code, inputDispatched:false});
    const row = observeGoalToolOutcome(operation, response);
    assert.equal(row.kind, 'recoverable_no_input');
    assert.equal(row.inputDispatched, false); assert.equal(row.actionDispatched, null);
    assert.match(row.guidance, /Preparation may already have scrolled/);
    assert.match(row.guidance, /fresh snapshot/); assert.match(row.guidance, /frame identity/);
    assert.doesNotMatch(row.guidance, /covering control/);
    assert.equal(detectUnknownEffectReplay([row], operation), null);
    assert.equal(observeGoalToolOutcome(operation, {...response, success:true}).kind, 'tool_executed_unverified');
  }
});

test('missing, contradictory and unrelated no-input claims preserve UNKNOWN replay protection', () => {
  for (const code of ['BROWSER_TARGET_COVERED', 'BROWSER_FRAME_IDENTITY_AMBIGUOUS']) {
    const guarded = data => result(false, code, {code, inputDispatched:false, ...data});
    const cases = [
      ['missing flag', 'relay_browser', 'click', result(false, code, {code})],
      ['input sent', 'relay_browser', 'click', guarded({inputDispatched:true})],
      ['nonboolean flag', 'relay_browser', 'click', guarded({inputDispatched:'false'})],
      ['top-level flag alone', 'relay_browser', 'click', {...result(false, code, {code}), inputDispatched:false}],
      ['top-level input contradicts receipt', 'relay_browser', 'click', {...guarded(), inputDispatched:true}],
      ['receipt input contradicts top-level', 'relay_browser', 'click', {...guarded({inputDispatched:true}), inputDispatched:false}],
      ['action dispatched', 'relay_browser', 'click', guarded({actionDispatched:true})],
      ['action flags disagree', 'relay_browser', 'click', {...guarded({actionDispatched:true}), actionDispatched:false}],
      ['input sent contradicts no action', 'relay_browser', 'click', guarded({inputDispatched:true, actionDispatched:false})],
      ['missing top-level code', 'relay_browser', 'click', result(false, null, {code, inputDispatched:false})],
      ['conflicting trusted codes', 'relay_browser', 'click', guarded({code:code === 'BROWSER_TARGET_COVERED' ? 'BROWSER_FRAME_IDENTITY_AMBIGUOUS' : 'BROWSER_TARGET_COVERED'})],
      ['missing receipt code', 'relay_browser', 'click', result(false, code, {inputDispatched:false})],
      ['codes disagree', 'relay_browser', 'click', guarded({code:'BROWSER_ELEMENT_ACTION_FAILED'})],
      ['generic renderer failure', 'relay_browser', 'click', result(false, 'BROWSER_ELEMENT_ACTION_FAILED', {code:'BROWSER_ELEMENT_ACTION_FAILED', inputDispatched:false})],
      ['unrelated browser action', 'relay_browser', 'fill', guarded()],
      ['unrelated tool', 'other_tool', 'click', guarded()],
    ];
    for (const [label, tool, action, response] of cases) {
      const operation = call(tool, {action, tabId:'form', ref:'continue'});
      const row = observeGoalToolOutcome(operation, response);
      assert.equal(row.kind, 'uncertain_external_effect', label);
      assert.equal(detectUnknownEffectReplay([row], operation)?.code, 'GOAL_EFFECT_UNRESOLVED', label);
      if (label.includes('contradicts') || label === 'action flags disagree') {
        assert.equal(row.actionDispatched, null, label + ' must not become no-dispatch evidence.');
      }
    }
  }
});

test('new no-input evidence never clears a previously persisted UNKNOWN operation', async () => {
  const operation = call('relay_browser', {action:'click', tabId:'form', ref:'continue'});
  const old = {...observeGoalToolOutcome(operation, result(false, 'BROWSER_ELEMENT_ACTION_FAILED')),
    id:'old-unknown', runId:'previous-turn', at:'2026-01-01T00:00:00.000Z'};
  const current = observeGoalToolOutcome(operation, result(false, 'BROWSER_TARGET_COVERED',
    {code:'BROWSER_TARGET_COVERED', inputDispatched:false}));
  assert.equal(current.kind, 'recoverable_no_input');
  assert.equal(detectUnknownEffectReplay([old, current], operation).code, 'GOAL_EFFECT_UNRESOLVED');
  const conversations = {states:{root:{goalUnresolvedEffects:[structuredClone(old)]}}};
  const manager = new ConversationGoals({engine:{runs:new Map()}, conversations, autoStart:false});
  const run = {id:'turn', taskId:'root', goal:{id:'goal'}, goalEvidence:[current]};
  let reached = 0;
  const wrapped = manager.wrapTools(run, 'agent', async () => {reached++; return result(true);});
  assert.equal((await wrapped(operation)).code, 'GOAL_EFFECT_UNRESOLVED');
  assert.equal(reached, 0);
  assert.deepEqual(conversations.states.root.goalUnresolvedEffects, [old]);
});

test('frame-identity no-input evidence never clears a historical ambiguous UNKNOWN operation', async () => {
  const operation = call('relay_browser', {action:'click', tabId:'form', ref:'continue'});
  const old = {...observeGoalToolOutcome(operation, result(false, 'BROWSER_ACTION_FAILED')),
    id:'old-unknown', runId:'previous-turn', at:'2026-01-01T00:00:00.000Z'};
  const current = observeGoalToolOutcome(operation, result(false, 'BROWSER_FRAME_IDENTITY_AMBIGUOUS',
    {code:'BROWSER_FRAME_IDENTITY_AMBIGUOUS', inputDispatched:false}));
  assert.equal(current.kind, 'recoverable_no_input');
  assert.equal(detectUnknownEffectReplay([old, current], operation).code, 'GOAL_EFFECT_UNRESOLVED');
  const conversations = {states:{root:{goalUnresolvedEffects:[structuredClone(old)]}}};
  const manager = new ConversationGoals({engine:{runs:new Map()}, conversations, autoStart:false});
  const run = {id:'turn', taskId:'root', goal:{id:'goal'}, goalEvidence:[current]};
  let reached = 0;
  const wrapped = manager.wrapTools(run, 'agent', async () => {reached++; return result(true);});
  assert.equal((await wrapped(operation)).code, 'GOAL_EFFECT_UNRESOLVED');
  assert.equal(reached, 0);
  assert.deepEqual(conversations.states.root.goalUnresolvedEffects, [old]);
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

test('a browser wait timeout is observation failure and cannot erase or replay a preceding unknown click', () => {
  const click=call('relay_browser',{action:'click',tabId:'t',ref:'submit'});
  const unknown=observeGoalToolOutcome(click,result(false,'TIMEOUT'));
  const wait=call('relay_browser',{action:'wait',tabId:'t',text:'Thank you'});
  const timeout=observeGoalToolOutcome(wait,result(false,'BROWSER_ACTION_FAILED'));
  assert.equal(timeout.kind,'recoverable_read_friction');
  assert.equal(timeout.actionDispatched,null);
  assert.equal(inFlightEffectSignature(wait),null);
  assert.equal(detectUnknownEffectReplay([unknown],wait),null);
  assert.equal(detectUnknownEffectReplay([unknown,timeout],click).code,'GOAL_EFFECT_UNRESOLVED');
  assert.equal(unknown.kind,'uncertain_external_effect');
  assert.equal(observeGoalToolOutcome(wait,result(true)).kind,'observation');
  assert.equal(observeGoalToolOutcome(call('other_tool',{action:'wait'}),result(false,'TIMEOUT')).kind,'uncertain_external_effect');
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
for (const scenario of ['old snapshot', 'intervening read', 'first snapshot', 'same binding', 'missing binding']) test('form document recovery: ' + scenario, async () => {
  const manager=new ConversationGoals({engine:{runs:new Map()},conversations:{states:{fixture:{}}},autoStart:false});
  manager.raw=()=>({lastToolEvidence:[]});
  const run={taskId:'fixture',goal:{id:'goal'},goalEvidence:[]};
  const url='https://example.test/form';
  const form = (generation, args = {}) => call('relay_browser',{action:'fill',tabId:'form',expectedUrl:url,expectedDocumentId:'form:'+generation,text:'inert',ref:'field-a',...args});
  const snapshot = call('relay_browser',{action:'snapshot',tabId:'form'});
  let generation=1, adapterCalls=0, stale=true;
  const guarded=manager.wrapTools(run,'agent',async ({arguments:args}) => {
    if(['snapshot','read'].includes(args.action)) return result(true,null,{tabId:'form',url,documentId:'form:'+generation,frames:[{elements:[{ref:'field-a'},{ref:'field-b'}]}]});
    adapterCalls++;
    if(stale) return {...result(false,'BROWSER_INPUT_DOCUMENT_CHANGED'),actionDispatched:false};
    return result(true,null,{receipt:{filled:true}});
  });
  if(scenario!=='first snapshot') await guarded(snapshot);
  if(scenario!=='same binding') generation=2;
  for(let i=0;i<3;i++) assert.equal((await guarded(form(1,{requestId:'attempt-'+i,...(scenario==='missing binding'&&{expectedDocumentId:undefined})}))).code,'BROWSER_INPUT_DOCUMENT_CHANGED');
  if(scenario==='intervening read') await guarded(call('relay_browser',{action:'read',tabId:'form'}));
  assert.equal((await guarded(form(2))).code,'GOAL_REPLAN_REQUIRED','unobserved caller claim cannot reset the refusal');
  await new Promise(resolve=>setTimeout(resolve,5));
  await guarded(snapshot);
  assert.equal((await guarded(form(1))).code,'GOAL_REPLAN_REQUIRED','obsolete generation still blocked');
  assert.equal((await guarded(form(2,{ref:'guessed-field'}))).code,'GOAL_REPLAN_REQUIRED','unobserved ref still blocked');
  stale=false;
  const allowed = scenario!=='same binding' && scenario!=='missing binding';
  const fresh = await guarded(form(generation,{ref:'field-b'}));
  assert.equal(fresh.success,allowed,'only a positively replaced failed binding reaches the adapter');
  if(!allowed) assert.equal(fresh.code,'GOAL_REPLAN_REQUIRED');
  assert.equal(adapterCalls,allowed?4:3);
});

test('pre-pointer capture diagnostic retains uncertain effect replay protection', () => {
  const code='BROWSER_CAPTURE_TIMEOUT';
  const click=call('relay_browser',{action:'click',tabId:'form',ref:'submit'});
  const diagnostic = result(false,code,{code,pointerStage:'pre-pointer-capture'});
  const before=observeGoalToolOutcome(click,diagnostic);
  assert.equal(before.actionDispatched,null);
  assert.equal(before.inputDispatched,undefined);
  assert.match(before.guidance,/before pointer dispatch/);
  assert.match(before.guidance,/whole operation remains UNKNOWN/);
  for (const response of [diagnostic,result(false,code,{code}),result(false,'TRANSPORT_LOST')]) {
    const observation=observeGoalToolOutcome(click,response);
    assert.equal(observation.kind,'uncertain_external_effect');
    assert.equal(detectUnknownEffectReplay([observation],click)?.code,'GOAL_EFFECT_UNRESOLVED');
  }
  assert.doesNotMatch(observeGoalToolOutcome({...click,namespace:'third_party'},diagnostic).guidance,/before pointer dispatch/);
});

test('model effects view supplies exact reconcile identity without suggesting any outcome', async () => {
  const manager=Object.create(ConversationGoals.prototype);
  const at='2026-11-23T03:18:00Z', signature='a'.repeat(64);
  const originals=[
    {id:'one',signature,at,resolutions:[{outcome:'unknown'}],resolution:{outcome:'unknown'}},
    {signature,at},
    {id:'old',signature,at,resolution:{outcome:'occurred'}},
    {id:'incomplete',signature}
  ];
  manager.effectReceipts=async()=>originals;
  const run={taskId:'fixture'};
  const projected=await manager.handle(run,'agent',call('relay_goal',{action:'effects'}));
  assert.equal(projected.success,true);
  const {receipts,guidance}=JSON.parse(projected.contentItems[0].text);
  assert.match(guidance,/copy its reconcileIdentity fields/);
  assert.match(guidance,/does not prove an outcome/);
  assert.deepEqual(receipts[0].reconcileIdentity,{receiptId:'one',signature,observedAt:at,expectedResolutionCount:1});
  assert.deepEqual(receipts[1].reconcileIdentity,{receiptId:null,signature,observedAt:at,expectedResolutionCount:0});
  assert.equal(receipts[2].reconcileIdentity,undefined);
  assert.equal(receipts[3].reconcileIdentity,undefined);
  assert.equal(originals[0].reconcileIdentity,undefined);
});

test('the Goal effect projection preserves the .75 Goal tool catalog fingerprint', () => {
  const {catalogHash}=createProviderExecutionContract({dynamicTools:[GOAL_TOOL],planningContractVersion:1});
  assert.equal(catalogHash,'22d3ee1da8210555bf0c2f946626d2a02badac6a87a40b4d270703cbeb57418f');
});

test('native select pre-input refusal does not create an unknown external effect', () => {
  const operation = call('relay_browser', {action:'select', tabId:'form', ref:'control', value:'yes'});
  const code = 'BROWSER_ELEMENT_ACTION_FAILED';
  const receipt = result(false, code, {code, inputDispatched:false});
  const row = observeGoalToolOutcome(operation, receipt);
  assert.equal(row.kind, 'recoverable_no_input');
  assert.equal(row.inputDispatched, false);
  assert.equal(row.actionDispatched, null);
  assert.equal(detectUnknownEffectReplay([row], operation), null);
  assert.match(row.guidance, /native select/);
  for (const response of [result(false, code, {code}), result(false, code, {code,inputDispatched:true}), {...receipt,inputDispatched:true}, result(false,code,{code,inputDispatched:false,actionDispatched:true}), result(false,'BROWSER_ACTION_FAILED',{code,inputDispatched:false})]) {
    assert.equal(observeGoalToolOutcome(operation,response).kind,'uncertain_external_effect');
  }
  assert.equal(observeGoalToolOutcome(call('relay_browser',{action:'click',tabId:'form',ref:'control'}),receipt).kind,'uncertain_external_effect');
});
