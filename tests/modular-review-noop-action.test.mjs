import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessRecordedOutcome,decodeOrdinaryVerdictWire,modularOutcomeRequiredSchema
} from '../lib/modular-completion.mjs';

const snapshot={request:'Report actual results from the completed check.',policy:{},
  scope:{kind:'ordinary-chat'},evidence:{records:[{id:'check-001',callId:'check-001',
    source:'admitted-tool-delivery',tool:'relay_workspace',action:'run',success:true,
    result:{contentItems:[{type:'inputText',text:'{"exitCode":0,"pass":2,"fail":0}'}]}}]}};
const candidate={output:'The check passed.'};
const schema=modularOutcomeRequiredSchema(snapshot);
const revise=nextAction=>({assessment:{decision:'revise_response',
  summary:'The admitted check supports the current report.',evidenceRefs:['evidence-0001'],nextAction}});
const flat=(decision,nextAction)=>({decision,summary:'The current check supports the reported result.',
  remaining:decision==='continue'?['One necessary follow-up']:[],
  nextAction,evidenceRefs:['evidence-0001'],blockers:[]});

test('closed local reviewer rejects non-actions instead of treating them as a report rewrite',()=>{
  for(const filler of ['no','No.','nothing','none','n/a','not needed','no action',
    'no further action','no correction needed','no changes required','already complete']){
    assert.throws(()=>decodeOrdinaryVerdictWire(revise(filler),schema),
      {code:'MODULAR_REVIEW_WIRE_INVALID'},filler);
  }
  const valid=decodeOrdinaryVerdictWire(revise('Correct the displayed test count from 3 to 2.'),schema);
  assert.equal(valid.decision,'revise_response');
  assert.equal(valid.nextAction,'Correct the displayed test count from 3 to 2.');
  assert.equal(decodeOrdinaryVerdictWire(revise('No longer show the obsolete check; report the current result.'),schema).decision,'revise_response');
});

test('invalid flat non-actions require review-only correction and cannot create a completion claim',async()=>{
  const updates=[];let calls=0;
  const result=await assessRecordedOutcome({snapshot,candidate,onUpdate:value=>updates.push(value),
    review:async()=>{
      calls++;
      return flat('revise_response','no');
    }});
  assert.equal(calls,3);
  assert.equal(result.record.decision,'unreviewed');
  assert.equal(result.record.reason,'MODULAR_REVIEW_INVALID');
  assert.ok(updates.some(row=>row.status==='rejected-format'));
});

test('a flat continue verdict cannot use no-op as an operational next action',async()=>{
  let calls=0;
  const result=await assessRecordedOutcome({snapshot,candidate,
    review:async()=>{calls++;return flat('continue','no action');}});
  assert.equal(calls,3);
  assert.equal(result.record.decision,'unreviewed');
  assert.equal(result.record.reason,'MODULAR_REVIEW_INVALID');
});

test('a scoped prerequisite check must not be a no-op',async()=>{
  let calls=0;
  const decisionSnapshot={...snapshot,scope:{...snapshot.scope,
    decisionBoundary:{action:'authorize-next-step',intent:'verify prerequisite'}}};
  const result=await assessRecordedOutcome({snapshot:decisionSnapshot,candidate,
    review:async()=>{calls++;return {verdict:'needs-check',summary:'Further proof needed.',
      prerequisiteGaps:['Confirm a prerequisite'],nextCheck:'no',evidenceRefs:['evidence-0001'],blockers:[]};}});
  assert.equal(calls,3);
  assert.equal(result.record.decision,'unreviewed');
  assert.equal(result.record.reason,'MODULAR_REVIEW_INVALID');
});
