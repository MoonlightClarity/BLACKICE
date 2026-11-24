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


function cue(next){
 assert.equal(next.continue,true);
 const [prefix,request]=next.prompt.split('\n\nCURRENT USER REQUEST (unchanged JSON string):\n');
 assert.equal(JSON.parse(request),input);
 assert.doesNotMatch(prefix,/Readback matches requested value|REVIEWER_MISTAKE|Correct the report now/);
 const id=prefix.match(/"feedbackId":"([a-f0-9]{64})"/)?.[1];
 assert.ok(id,'neutral continuation supplies an exact feedback retrieval ID');
 return id;
}
function feedbackCall(id,callId='review-read-1'){
 return {callId,name:'relay_outcome_feedback',arguments:{action:'read',feedbackId:id}};
}
test('tool feedback uses a neutral continuation and binds exact delivery without operational progress',async()=>{
 const events=[],f=fixture(()=>assessment,{feedbackTransport:'tool-result',onFeedback:e=>events.push(e)});
 f.review.beforeFinal(candidate);
 const id=cue(await f.review.beforeFinal(candidate)),call=feedbackCall(id),before=f.review.evidenceSnapshot();
 const result=f.review.readOutcomeFeedback(call);
 assert.equal(result.success,true);
 const data=JSON.parse(result.contentItems[0].text);
 assert.equal(data.source,'independent-outcome-review');
 assert.equal(data.automated,true);assert.equal(data.authority,'none');assert.equal(data.verified,false);
 assert.equal(data.summary,assessment.summary);
 assert.equal(data.admittedEvidence[0].directoryReceiptId,'receipt-1');
 assert.equal(data.feedbackId,id);
 assert.equal(data.reviewedCandidateSha256.length,64);
 assert.deepEqual(events.map(e=>e.status),['available','returned']);
 // A nonmatching delivery must not count.
 f.review.delivered({call,result:{contentItems:[{type:'inputText',text:'not the returned assessment'}]}});
 assert.equal(events.length,2);
 f.review.delivered({call,result:{contentItems:result.contentItems},delivery:'accepted-provider-request'});
 assert.equal(events.at(-1).status,'delivered');assert.equal(events.at(-1).delivery,'accepted-provider-request');
 f.review.delivered({call,result});
 assert.equal(events.length,3);
 assert.deepEqual(f.review.evidenceSnapshot(),before);
 assert.equal(await f.review.beforeFinal(candidate),null);
 assert.equal(f.calls(),1);
});
test('omitted feedback ID resolves only the current assessment and preserves delivery binding',async()=>{
 const events=[],f=fixture(()=>assessment,{feedbackTransport:'tool-result',onFeedback:e=>events.push(e)});
 const call={callId:'implicit-current',name:'relay_outcome_feedback',arguments:{action:'read'}};
 assert.equal(f.review.readOutcomeFeedback(call).code,'OUTCOME_FEEDBACK_UNAVAILABLE');
 f.review.beforeFinal(candidate);const id=cue(await f.review.beforeFinal(candidate));
 const before=f.review.evidenceSnapshot(),result=f.review.readOutcomeFeedback(call);
 assert.equal(result.success,true);assert.equal(JSON.parse(result.contentItems[0].text).feedbackId,id);
 f.review.delivered({call,result,delivery:'accepted-provider-request'});
 assert.deepEqual(events.map(e=>e.status),['available','returned','delivered']);
 assert.deepEqual(f.review.evidenceSnapshot(),before);
 addRead(f.review,'changed-input','Changed source');
 assert.equal(f.review.readOutcomeFeedback(call).code,'OUTCOME_FEEDBACK_STALE');
});
test('both explicit modes receive a mistaken review through the tool and re-assess the original report',async()=>{
 for(const feedbackMode of ['gate-only','gate-and-steer']){
  const f=fixture((req,n)=>n===1?{...assessment,decision:'continue',summary:'REVIEWER_MISTAKE',remaining:['Correct the report now'],nextAction:'Correct the report now'}:assessment,{feedbackMode,feedbackTransport:'tool-result'});
  f.review.beforeFinal(candidate);
  const id=cue(await f.review.beforeFinal(candidate)),call=feedbackCall(id);
  const result=f.review.readOutcomeFeedback(call);
  assert.equal(result.success,true);
  const data=JSON.parse(result.contentItems[0].text);
  assert.equal(data.summary,'REVIEWER_MISTAKE');assert.equal(data.automated,true);
  assert.equal(Boolean(data.verificationMethod),feedbackMode==='gate-and-steer');
  f.review.delivered({call,result});
  const next=await f.review.beforeFinal(candidate);
  if(feedbackMode==='gate-and-steer'){
   const c=feedbackCall(cue(next),'read-accepted-review');
   const r=f.review.readOutcomeFeedback(c);assert.equal(r.success,true);
   assert.equal(JSON.parse(r.contentItems[0].text).decision,'respond');
   f.review.delivered({call:c,result:r});
   assert.equal(await f.review.beforeFinal(candidate),null);
  }else assert.equal(next,null);
  assert.equal(f.calls(),2);assert.equal(f.review.evidenceSnapshot().evidence.records.length,1);
 }
});
test('feedback retrieval is scoped to the exact current assessment, evidence and outline',async()=>{
 let revision=1,admitted=true;
 const f=fixture(()=>assessment,{feedbackTransport:'tool-result',getReviewScope:()=>({taskId:'task',revision}),canContinue:()=>admitted});
 f.review.beforeFinal(candidate);const id=cue(await f.review.beforeFinal(candidate));
 assert.equal(f.review.readOutcomeFeedback(feedbackCall('a'.repeat(64))).code,'OUTCOME_FEEDBACK_UNAVAILABLE');
 assert.equal(f.review.readOutcomeFeedback({...feedbackCall(id),namespace:'other'}).code,'OUTCOME_FEEDBACK_ARGUMENTS');
 assert.equal(f.review.readOutcomeFeedback({...feedbackCall(id),arguments:{action:'read',feedbackId:id,extra:true}}).code,'OUTCOME_FEEDBACK_ARGUMENTS');
 revision++;
 assert.equal(f.review.readOutcomeFeedback(feedbackCall(id)).code,'OUTCOME_FEEDBACK_STALE');
 revision--;
 addRead(f.review,'new-evidence','Changed source');
 assert.equal(f.review.readOutcomeFeedback(feedbackCall(id)).code,'OUTCOME_FEEDBACK_STALE');
 admitted=false;
 assert.equal(f.review.readOutcomeFeedback(feedbackCall(id)).code,'OUTCOME_FEEDBACK_STALE');
});
test('tool result access does not approve a changed report or weaken unavailable review failure',async()=>{
 const f=fixture((req,n)=>n===1?assessment:{...assessment,decision:'continue',summary:'REVIEWER_MISTAKE',nextAction:'Correct the report now'},{feedbackTransport:'tool-result'});
 f.review.beforeFinal(candidate);
 const id=cue(await f.review.beforeFinal(candidate)),call=feedbackCall(id),result=f.review.readOutcomeFeedback(call);f.review.delivered({call,result});
 cue(await f.review.beforeFinal({output:'The result was uploaded.'}));assert.equal(f.calls(),2);
 const g=fixture(()=>({decision:'unreviewed',reason:'MODULAR_REVIEW_EVIDENCE'}),{feedbackTransport:'tool-result'});
 g.review.beforeFinal(candidate);const c=feedbackCall(cue(await g.review.beforeFinal(candidate))),r=g.review.readOutcomeFeedback(c);
 assert.equal(JSON.parse(r.contentItems[0].text).decision,'unreviewed');g.review.delivered({call:c,result:r});
 await assert.rejects(g.review.beforeFinal(candidate),{code:'CHAT_OUTCOME_UNREVIEWED'});
});


test('host feedback handoff is a scoped read-only receipt, not a new user instruction or evidence',async()=>{
 const events=[],f=fixture(()=>({...assessment,decision:'continue',remaining:['Read the requested source'],nextAction:'Read the exact source.'}),{feedbackTransport:'tool-result',onFeedback:e=>events.push(e)});
 const direct={...candidate,hostFeedbackDelivery:true};
 f.review.beforeFinal(direct);
 const next=await f.review.beforeFinal(direct);
 assert.match(next.hostFeedback.feedbackId,/^[a-f0-9]{64}$/);
 assert.doesNotMatch(next.prompt,/Read the exact source|Call relay_outcome_feedback/);
 const before=f.review.evidenceSnapshot(),call=feedbackCall(next.hostFeedback.feedbackId,'host-owned-read');
 const result=f.review.readOutcomeFeedback(call,{hostInitiated:true});
 assert.equal(result.success,true);assert.equal(result.actionDispatched,false);
 assert.equal(JSON.parse(result.contentItems[0].text).nextAction,'Read the exact source.');
 f.review.delivered({call,result,delivery:'accepted-provider-request'});
 assert.equal(events.at(-1).origin,'host-initiated-read');
 assert.deepEqual(f.review.evidenceSnapshot(),before);
 addRead(f.review,'new-receipt','New source evidence.');
 assert.equal(f.review.readOutcomeFeedback(call,{hostInitiated:true}).code,'OUTCOME_FEEDBACK_STALE');
});
