import test from 'node:test';
import assert from 'node:assert/strict';
import {directlyObservedTestStatus,exactStatusReport,contradictedTestPassClaim,missingRequestedTestNumbers} from '../lib/outcome-direct-status.mjs';

const makeReceipt=(id='verified-1',patch={})=>({id,callId:id,source:'admitted-tool-delivery',
  tool:'relay_workspace',action:'run',success:false,
  arguments:{action:'run',command:'node --test'},
  result:{success:false,code:'WORKSPACE_COMMAND_EXIT_NONZERO',contentItems:[{
    type:'inputText',text:JSON.stringify({exitCode:1,stdout:'TAP version 13\n# tests 2\n# pass 1\n# fail 1\n',
      stderr:'',truncated:false,timedOut:false})}]},...patch});
const snapshot=(records=[makeReceipt()],request='State whether the tests passed based only on the recorded test receipt.')=>({
  request,scope:{kind:'ordinary-chat',pendingEffects:[]},evidence:{records}});
test('exact failed TAP receipt yields grounded status, not an inferred completed user task',()=>{
  const s=snapshot();
  assert.deepEqual(directlyObservedTestStatus(s),{receiptId:'verified-1',command:'node --test',exitCode:1,total:2,passed:1,failed:1});
  const report=exactStatusReport(s);
  assert.match(report.output,/exited with code 1/);
  assert.match(report.output,/2 tests: 1 passed and 1 failed/);
  assert.match(report.output,/Not all/);
  assert.equal(report.receiptId,'verified-1');
});
test('false affirmative status is a source contradiction even when the reviewer confidently cites the tool',()=>{
  const s=snapshot();
  for(const falsehood of ['The two source checks passed.', 'All tests passed.', 'exit code 0','0 tests failed',
    'The two source checks passed, but one test failed.']){
    assert.equal(contradictedTestPassClaim(s,falsehood)?.receiptId,'verified-1',falsehood);
  }
  for(const truthful of ['The two checks did not pass.', 'The tests failed: exit code 1.',
    'The earlier candidate incorrectly claimed that all checks passed.', 'One test passed and one failed.'])
    assert.equal(contradictedTestPassClaim(s,truthful),null,truthful);
});
test('no false host proof with missing, unsettled, ambiguous, forged or non-TAP evidence',()=>{
  const first=snapshot();
  for(const s of [
    snapshot([makeReceipt(),makeReceipt('verified-2')]),
    snapshot([makeReceipt('verified-1',{callId:'not-the-id'})]),
    snapshot([makeReceipt('verified-1',{source:'model-claim'})]),
    snapshot([makeReceipt('verified-1',{result:{contentItems:[{type:'inputText',text:'{"exitCode":1}'}]}})]),
    {...first,scope:{kind:'ordinary-chat',pendingEffects:[{callId:'unknown-effect'}]}}
  ]){
    assert.equal(directlyObservedTestStatus(s),null);
    assert.equal(exactStatusReport(s),null);
    assert.equal(contradictedTestPassClaim(s,'All checks passed.'),null);
  }
});
test('wrong numeric pass count is rejected even when the report correctly says the command failed',()=>{
  const s=snapshot();
  assert.equal(contradictedTestPassClaim(s,'The test run failed; 2 passed and 1 failed.')?.receiptId,'verified-1');
  assert.equal(contradictedTestPassClaim(s,'One test passed and one failed.'),null);
  assert.equal(contradictedTestPassClaim(s,'The candidate incorrectly claimed 2 passed; the receipt shows 1 passed and 1 failed.'),null);
});
test('an error label is not a requested numeric exit code, and count omissions are not complete results',()=>{
  const s=snapshot(undefined,'Explain the contradiction. Report the exact exit code and pass/fail counts.');
  assert.equal(missingRequestedTestNumbers(s,'Evidence shows test failure WORKSPACE_COMMAND_EXIT_NONZERO; 2 passed, 1 failed.')?.receiptId,'verified-1');
  assert.equal(missingRequestedTestNumbers(s,'Exit code 1, but no counts available.')?.receiptId,'verified-1');
  assert.equal(missingRequestedTestNumbers(s,'Exit code 1. The test summary reported 1 passed and 1 failed.'),null);
});
test('ordinary Chat reports a single exact machine status without asking the model to reinterpret it',async()=>{
  const {createChatOutcomeReviewer}=await import('../lib/chat-outcome-review.mjs');
  let modelCalls=0;
  const events=[];
  const reviewer=createChatOutcomeReviewer({runtime:{runAgent:async()=>{modelCalls++;throw Error('No model needed for direct status report');}},
    cwd:process.cwd(),model:'local_llamacpp::MiniCPM-V-4.7-1B-heretic-Q4_K_S',
    authority:{developerInstructions:'Use source evidence, do not misreport tests.'},
    onUpdate:event=>events.push(event)});
  const evidence=snapshot().evidence;
  const result=await reviewer.assess({input:'State whether the tests passed based only on the returned TAP receipt.',
    candidate:{output:'All tests passed.'},pendingEffects:[],evidenceFingerprint:'exact-1',
    evidence:{...evidence,total:1,bytes:1024,omitted:0}});
  assert.equal(modelCalls,0);
  assert.equal(result.decision,'respond');
  assert.deepEqual(result.evidenceRefs,['verified-1']);
  assert.match(result.replacementOutput,/code 1/);
  assert.match(result.replacementOutput,/1 passed and 1 failed/);
  assert.equal(result.verified,false);
  assert.equal(events.at(-1).status,'host-direct-status');
});

test('ordinary-chat execution gate publishes the host-grounded correction, not the false model draft',async()=>{
  const {createChatOutcomeReviewer}=await import('../lib/chat-outcome-review.mjs');
  const {createChatExecutionReview}=await import('../lib/chat-execution-review.mjs');
  let reviewModelCalls=0;
  const input='State whether the tests passed based only on the returned test receipt.';
  const reviewer=createChatOutcomeReviewer({model:'local_llamacpp::MiniCPM-V-4.7-1B-heretic-Q4_K_S',
    cwd:process.cwd(),runtime:{runAgent:async()=>{reviewModelCalls++;throw Error('Direct status must not require a model.');}},
    authority:{developerInstructions:'Report only returned evidence.'}});
  const gate=createChatExecutionReview({input,assessOutcome:args=>reviewer.assess(args)});
  const call={name:'relay_workspace',callId:'call-1',arguments:{action:'run',command:'node --test'}};
  const result=makeReceipt('call-1');
  gate.started(call);
  gate.delivered({call,result:result.result});
  const candidate={output:'All tests passed.',remainingSteps:12};
  const first=await gate.beforeFinal(candidate);
  assert.equal(first?.continue,true);
  const final=await gate.beforeFinal(candidate);
  assert.equal(final,null);
  assert.match(gate.replacementOutput(),/1 passed and 1 failed/);
  assert.match(gate.replacementOutput(),/code 1/);
  assert.equal(reviewModelCalls,0);
});

test('the host does not substitute a status report for a coding or other operational request',()=>{
  assert.equal(exactStatusReport(snapshot(undefined,'Fix the implementation and report whether the tests passed.')),null);
  assert.equal(exactStatusReport(snapshot(undefined,'Read the logs, then state whether the tests passed.')),null);
  assert.equal(exactStatusReport(snapshot(undefined,'Explain why the tests failed and state whether the checks passed.')),null);
  const passed=makeReceipt('verified-1',{success:true,result:{success:true,contentItems:[{
    type:'inputText',text:JSON.stringify({exitCode:0,stdout:'TAP version 13\n# tests 2\n# pass 2\n# fail 0\n'})}]}});
  assert.match(exactStatusReport(snapshot([passed])).output,/reported checks passed/);
  assert.equal(contradictedTestPassClaim(snapshot([passed]),'All tests passed.'),null);
});
