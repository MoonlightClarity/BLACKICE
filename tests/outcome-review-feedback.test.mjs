import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatExecutionReview} from '../lib/chat-execution-review.mjs';
import {outcomeReviewFeedbackMode} from '../lib/outcome-review-feedback.mjs';
import {createChatOutcomeReviewer} from '../lib/chat-outcome-review.mjs';

const input='Save the requested result and verify its contents.';
const candidate={output:'The requested result is saved and verified.'};
const assessment={decision:'respond',summary:'Readback matches requested value.',remaining:[],nextAction:'',evidenceRefs:['read-1'],blockers:[],
 verificationMethod:{methods:['direct-result'],reason:'Single bounded result.',triggers:['before-final-report']},
 workerEvidenceBindings:[{evidenceId:'read-1',receiptId:'receipt-1',actionId:'verify'}]};
function addRead(review,callId='read-1',text='Observed requested value.'){
 const call={callId,name:'relay_workspace',arguments:{action:'read',path:'result.txt'}};
 review.started(call);review.delivered({call,result:{success:true,contentItems:[{type:'inputText',text}]}});
}
function fixture(assess,extra={}){
 let calls=0;const decisions=[];
 const review=createChatExecutionReview({input,feedbackMode:'gate-and-steer',onDecision:d=>decisions.push(d),
  assessOutcome:async request=>{calls++;return assess(request,calls);},...extra});
 addRead(review);
 return{review,decisions,calls:()=>calls};
}
function feedback(next){
 assert.equal(next.continue,true);
 const [prefix,request]=next.prompt.split('\n\nCURRENT USER REQUEST (unchanged JSON string):\n');
 assert.equal(JSON.parse(request),input);
 assert.match(prefix,/INDEPENDENT OUTCOME REVIEW FEEDBACK/);
 return JSON.parse(prefix.slice(prefix.lastIndexOf('\n\n')+2));
}
test('gate-plus-steering exposes an accepted assessment and reuses only the exact already-reviewed report',async()=>{
 const f=fixture(()=>assessment);
 assert.equal(f.review.beforeFinal(candidate).continue,true);
 const value=feedback(await f.review.beforeFinal(candidate));
 assert.equal(value.decision,'respond');assert.equal(value.authority,'none');assert.equal(value.verified,false);
 assert.equal(value.admittedEvidence[0].directoryReceiptId,'receipt-1');
 assert.deepEqual(value.verificationMethod,assessment.verificationMethod);
 assert.equal(f.calls(),1);
 assert.equal(await f.review.beforeFinal(candidate),null);
 assert.equal(f.calls(),1,'unchanged candidate and exact evidence do not need a duplicate assessment');
 assert.equal(f.decisions.at(-1).reason,'task-outcome-supported');
});
test('a changed report must pass the independent gate again, without another automatic feedback loop',async()=>{
 const f=fixture((request,n)=>{
  if(n===1)return assessment;
  assert.equal(request.candidate.output,'The requested result was saved and uploaded.');
  return {...assessment,decision:'continue',summary:'No upload was requested or observed.',remaining:['Correct unsupported report'],nextAction:'Report only the actual saved result.'};
 });
 f.review.beforeFinal(candidate);feedback(await f.review.beforeFinal(candidate));
 const next=feedback(await f.review.beforeFinal({output:'The requested result was saved and uploaded.'}));
 assert.equal(next.decision,'continue');assert.match(next.summary,/No upload/);assert.equal(f.calls(),2);
});
test('materially new evidence invalidates an approved report',async()=>{
 const f=fixture(()=>assessment);
 f.review.beforeFinal(candidate);feedback(await f.review.beforeFinal(candidate));
 addRead(f.review,'read-2','Different saved value.');
 assert.equal(f.review.beforeFinal(candidate).continue,true);
 feedback(await f.review.beforeFinal(candidate));
 assert.equal(f.calls(),2);
});
test('another delivered receipt invalidates the exact-evidence approval even when its content fingerprint repeats',async()=>{
 const f=fixture(()=>assessment);
 f.review.beforeFinal(candidate);feedback(await f.review.beforeFinal(candidate));
 addRead(f.review,'read-2','Observed requested value.');
 assert.equal(await f.review.beforeFinal(candidate),null);
 assert.equal(f.calls(),2,'same canonical progress does not imply same exact admitted receipt set');
});
test('an unavailable reviewer exposes diagnostics but never releases unreviewed output',async()=>{
 const f=fixture(()=>({decision:'unreviewed',reason:'MODULAR_REVIEW_EVIDENCE',reviewValidation:{invalidReferences:['invented'],uninspectedReferences:['evidence-0001']}}));
 f.review.beforeFinal(candidate);
 const value=feedback(await f.review.beforeFinal(candidate));
 assert.equal(value.decision,'unreviewed');assert.deepEqual(value.reviewValidation.invalidReferences,['invented']);
 await assert.rejects(f.review.beforeFinal(candidate),{code:'CHAT_OUTCOME_UNREVIEWED'});
});
test('a corrected report is visible and exact acceptance does not reuse the rejected original',async()=>{
 const corrected='Saved the requested result. No upload was performed.';
 const f=fixture(()=>({...assessment,replacementOutput:corrected}));
 f.review.beforeFinal(candidate);
 assert.equal(feedback(await f.review.beforeFinal(candidate)).reviewedCorrectedReport,corrected);
 assert.equal(await f.review.beforeFinal({output:corrected}),null);assert.equal(f.calls(),1);
 const g=fixture(()=>({...assessment,replacementOutput:corrected}));
 g.review.beforeFinal(candidate);feedback(await g.review.beforeFinal(candidate));
 assert.equal(await g.review.beforeFinal(candidate),null);assert.equal(g.calls(),2);
 assert.equal(g.review.replacementOutput(),corrected);
});
test('gate stays active at provider budget boundary, and cancellation supersedes feedback',async()=>{
 const f=fixture(()=>assessment);
 assert.equal(await f.review.beforeFinal({...candidate,remainingSteps:0}),null);assert.equal(f.calls(),1);
 const g=fixture(()=>({decision:'unreviewed',reason:'MODULAR_REVIEW_EVIDENCE'}));
 await assert.rejects(g.review.beforeFinal({...candidate,remainingSteps:0}),{code:'CHAT_OUTCOME_UNREVIEWED'});
 const h=fixture(()=>assessment);
 h.review.beforeFinal(candidate);feedback(await h.review.beforeFinal(candidate));
 assert.equal(await h.review.beforeFinal({...candidate,signal:AbortSignal.abort(new Error('Stopped'))}),null);
 assert.equal(h.calls(),1);
});
test('gate-only preserves existing behavior and no feedback mode disables verification',async()=>{
 assert.throws(()=>outcomeReviewFeedbackMode('off'),{code:'OUTCOME_REVIEW_FEEDBACK_INVALID'});
 const f=fixture(()=>assessment,{feedbackMode:'gate-only'});
 f.review.beforeFinal(candidate);assert.equal(await f.review.beforeFinal(candidate),null);assert.equal(f.calls(),1);
});

test('a changed Directory revision invalidates an otherwise identical accepted report',async()=>{
 let revision=2,actionRevision=1;
 const f=fixture(()=>assessment,{getReviewScope:()=>({taskId:'task',revision,actionRevision})});
 f.review.beforeFinal(candidate);feedback(await f.review.beforeFinal(candidate));
 revision++;actionRevision++;
 feedback(await f.review.beforeFinal(candidate));assert.equal(f.calls(),2);
 assert.equal(await f.review.beforeFinal(candidate),null);
});
test('a concurrent outline change while the reviewer is active requires reassessment',async()=>{
 let revision=2,actionRevision=1;
 const f=fixture((_request,n)=>{if(n===1){revision++;actionRevision++;}return assessment;},{getReviewScope:()=>({taskId:'task',revision,actionRevision})});
 f.review.beforeFinal(candidate);
 feedback(await f.review.beforeFinal(candidate));assert.equal(f.calls(),2);
 assert.equal(await f.review.beforeFinal(candidate),null);
});
