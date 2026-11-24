import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createChatOutcomeReviewer,ordinaryOutcomePrompt} from '../lib/chat-outcome-review.mjs';
import {modularOutcomeRequiredSchema,decodeOrdinaryVerdictWire} from '../lib/modular-completion.mjs';
import {strictProviderSchema} from '../lib/provider-output-schema.mjs';

const model='local_llamacpp::MiniCPM-V-4.7-1B-heretic-Q4_K_S';
const corrected='The recorded source checks did not all pass: exit code 1; one passed and one failed.';
const snapshot={request:'Report the actual test outcome.',scope:{kind:'ordinary-chat'},
  evidence:{records:[{id:'receipt-1',callId:'receipt-1',source:'admitted-tool-delivery',tool:'relay_workspace',
    action:'run',success:false,arguments:{action:'run',command:'node --test'},result:{success:false,contentItems:[{type:'inputText',
      text:JSON.stringify({exitCode:1,stdout:'TAP version 13\n# tests 2\n# pass 1\n# fail 1'})}]}}]}};
const request={input:snapshot.request,candidate:{output:'All tests passed: exit code 0.'},
  evidenceFingerprint:'failed-test-receipt-1',pendingEffects:[],evidence:{...snapshot.evidence,
    total:1,omitted:0}};
const revise=()=>({assessment:{decision:'revise_response',
  summary:'Candidate misreports the returned test result.',
  evidenceRefs:['evidence-0001'],nextAction:'Correct the report to show exit code 1, one pass and one failure.'}});
const respond=(summary=corrected)=>({assessment:{decision:'respond',summary,evidenceRefs:['evidence-0001'],
  supportBasis:'observed-results'}});
async function fixture(t,answer){
  const cwd=await mkdtemp(path.join(os.tmpdir(),'minicpm-report-synthesis-guard-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  let count=0;
  const phases=[];
  const runtime={status:()=>({models:[{id:model,contextWindowTokens:262144,maxOutputTokens:1800}]}),
    async runAgent(opts){
      const schema=opts.outputSchema;
      const view=JSON.parse(opts.prompt.split('\nREVIEW DATA (JSON):\n').at(-1));
      assert.equal(view.sourceGroundedTestStatus.exitCode,1);
      assert.equal(view.sourceGroundedTestStatus.tests,2);
      assert.equal(view.sourceGroundedTestStatus.passed,1);
      assert.equal(view.sourceGroundedTestStatus.failed,1);
      assert.equal(view.sourceGroundedTestStatus.citationRef,'evidence-0001');
      assert.equal(strictProviderSchema(schema),true);
      const phase=opts.prompt.includes('READ-ONLY REPORT SYNTHESIS')?'synthesis':
        phases.length>0?'reassessment':'initial';
      phases.push(phase);
      const branches=schema.properties.assessment.anyOf.map(row=>row.properties.decision.const);
      if(phase==='synthesis')assert.deepEqual(branches,['respond'],
        'A report drafting phase should not expose another inconclusive verdict.');
      else assert.deepEqual(branches,['respond','continue','revise_response','blocked'],
        'Initial and independent final assessments must retain their actual choices.');
      assert.equal(opts.responseOnly,true);
      assert.equal(opts.hostOnlyTools,true);
      assert.equal(opts.onToolCall,undefined);
      assert.equal(opts.dynamicTools,undefined);
      count++;
      return{output:JSON.stringify(answer(phase,count,opts))};
    }};
  const reviewer=createChatOutcomeReviewer({runtime,cwd,model,
    authority:{developerInstructions:'Use returned test evidence only; report false claims as false.'},
    auditRoot:path.join(cwd,'audit')});
  return {reviewer,phases,get count(){return count;}};
}

test('report synthesis has a single draft branch but corrected output must survive independent reassessment',async t=>{
  const f=await fixture(t,phase=>phase==='initial'?revise():respond());
  const result=await f.reviewer.assess(request);
  assert.equal(result.decision,'respond');
  assert.equal(result.replacementOutput,corrected);
  assert.deepEqual(result.evidenceRefs,['receipt-1']);
  assert.deepEqual(f.phases,['initial','synthesis','reassessment']);
});

test('ambiguous receipts do not generate a projected machine-status fact',()=>{
  const many={...snapshot,evidence:{records:[...snapshot.evidence.records,{...snapshot.evidence.records[0],id:'receipt-2',callId:'receipt-2'}]}};
  const prompt=ordinaryOutcomePrompt(many,request.candidate);
  const view=JSON.parse(prompt.split('\nREVIEW DATA (JSON):\n').at(-1));
  assert.equal(view.sourceGroundedTestStatus,undefined);
});

test('synthesis-only grammar still rejects a model that attempts another review verdict',()=>{
  const schema=modularOutcomeRequiredSchema(snapshot,{reportSynthesisOnly:true});
  assert.equal(strictProviderSchema(schema),true);
  assert.deepEqual(schema.properties.assessment.anyOf.map(row=>row.properties.decision.const),['respond']);
  assert.throws(()=>decodeOrdinaryVerdictWire(revise(),schema),{code:'MODULAR_REVIEW_WIRE_INVALID'});
  assert.equal(decodeOrdinaryVerdictWire(respond(),schema).decision,'respond');
});

test('a false corrected draft with no narrow source-only fallback must remain unreviewed',async t=>{
  const f=await fixture(t,phase=>phase==='initial'?revise():phase==='synthesis'
    ?respond('The tests all passed despite the recorded exit code 1.'):revise());
  const result=await f.reviewer.assess(request);
  assert.equal(result.decision,'unreviewed');
  assert.equal(result.reason,'CHAT_OUTCOME_EVIDENCE_CONTRADICTION');
  assert.deepEqual(f.phases,['initial','synthesis']);
});

test('an exact status-only request obtains the returned failure facts without a model verdict',async t=>{
  const f=await fixture(t,()=>assert.fail('The direct status route must not invoke an unnecessary model.'));
  const result=await f.reviewer.assess({...request,
    input:'State whether the two source checks passed based only on their returned test receipt.'});
  assert.equal(result.decision,'respond');
  assert.match(result.replacementOutput,/exited with code 1/);
  assert.match(result.replacementOutput,/1 passed and 1 failed/);
  assert.doesNotMatch(result.replacementOutput,/two source checks passed/i);
  assert.deepEqual(f.phases,[]);
});

test('an operational repair cannot be accepted based on contradictory machine status',async t=>{
  const f=await fixture(t,()=>respond('The report is supported.'));
  const result=await f.reviewer.assess({...request,
    input:'Repair the implementation and state whether the tests passed.'});
  assert.equal(result.decision,'unreviewed');
  assert.equal(result.reason,'CHAT_OUTCOME_EVIDENCE_CONTRADICTION');
  assert.deepEqual(f.phases,['initial']);
});

test('an explanatory MiniCPM draft with wrong counts or no exact exit code is rejected, not certified',async t=>{
  const f=await fixture(t,phase=>phase==='initial'?revise():phase==='synthesis'
    ?respond('The command failed with WORKSPACE_COMMAND_EXIT_NONZERO; 2 passed and 1 failed.'):
     respond('The report is supported.'));
  const input='Explain the discrepancy and report the exact exit code and pass/fail counts.';
  const result=await f.reviewer.assess({...request,input});
  assert.equal(result.decision,'unreviewed');
  assert.equal(result.reason,'CHAT_OUTCOME_EVIDENCE_CONTRADICTION');
  assert.deepEqual(f.phases,['initial','synthesis']);
});

test('an optimistic independent assessment with invented counts cannot certify a candidate',async t=>{
  const f=await fixture(t,()=>respond('Evidence shows 2 passed and 1 failed, so the report is correct.'));
  const input='Explain the test failure and report the exact exit code and pass/fail counts.';
  const result=await f.reviewer.assess({...request,input,
    candidate:{output:'The command exited with code 1; one test passed and one failed.'}});
  assert.equal(result.decision,'unreviewed');
  assert.equal(result.reason,'CHAT_OUTCOME_EVIDENCE_CONTRADICTION');
  assert.deepEqual(f.phases,['initial']);
});

test('a substantive continue assessment never launches constrained report synthesis',async t=>{
  const f=await fixture(t,()=>({assessment:{decision:'continue',
    summary:'The result remains pending.',evidenceRefs:['evidence-0001'],
    remaining:['A required task operation is not completed.'],nextAction:'Read the pending job result.',
    blockers:[]}}));
  const result=await f.reviewer.assess(request);
  assert.equal(result.decision,'continue');
  assert.deepEqual(f.phases,['initial']);
});
