import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeReviewConcerns,compactConcernHistory,REVIEW_EXPECTATION_INSTRUCTIONS} from '../lib/review-concern-provenance.mjs';
import {createModularCompletionController,modularOutcomeSchema,modularReviewPrompt} from '../lib/modular-completion.mjs';
const snapshot=()=>({request:{text:'Every supplied image must have positive dimensions.'},directions:[],scope:{},
 evidence:{records:[{id:'probe',fullResultSha256:'source-v1',excerpt:'negative width rejected as expected'}]}});
const concern=()=>({key:'negative-width',taskClause:'Every supplied image must have positive dimensions.',basis:'explicit',
 inputs:'image width -1',expected:'reject invalid width',observed:'TypeError rejected width',
 classification:'expected-rejection',evidenceRefs:['evidence-0001'],sourceIdentity:'source-v1',
 status:'resolved',priorConcernKey:'',reopenReason:''});
const options={resolveRef:r=>r==='evidence-0001'?'probe':r,admittedRefs:['probe']};

test('expected image rejection and universal validation remain interpretations, not existence requirements or failures',()=>{
 const s=snapshot(),row=normalizeReviewConcerns([concern()],s,options)[0];
 assert.equal(row.classification,'expected-rejection');assert.equal(row.status,'resolved');
 assert.equal(row.clauseFoundInRequest,true);assert.equal(row.verified,false);assert.equal(row.authority,'none');
 const invented=normalizeReviewConcerns([{...concern(),taskClause:'At least one image must exist',basis:'inferred',expected:'reject []',evidenceRefs:['invented']}],s,options)[0];
 assert.equal(invented.clauseFoundInRequest,false);assert.equal(invented.basis,'inferred');
 assert.equal(invented.unadmittedReferenceCount,1);assert.deepEqual(invented.evidenceRefs,[]);
 assert.match(REVIEW_EXPECTATION_INSTRUCTIONS,/does not imply a nonempty collection/);
 assert.match(REVIEW_EXPECTATION_INSTRUCTIONS,/malformed probe\/invocation failure/);
});

test('prior resolved concern retains exact evidence identity; changes are not automatic proof of a bug',()=>{
 const s=snapshot(),first=normalizeReviewConcerns([concern()],s,options)[0];
 const next={...concern(),status:'proposed',priorConcernKey:first.key};
 assert.equal(normalizeReviewConcerns([next],s,{...options,previous:[first]})[0].priorResolution.sameEvidenceSnapshot,true);
 const changed=snapshot();changed.evidence.records[0].fullResultSha256='source-v2';
 const row=normalizeReviewConcerns([next],changed,{...options,previous:[first]})[0];
 assert.equal(row.priorResolution.sameEvidenceSnapshot,false);assert.equal(row.verified,false);
 const malformed=normalizeReviewConcerns([{...concern(),classification:'probe-error',observed:'shell quote syntax failed'}],s,options)[0];
 assert.equal(malformed.classification,'probe-error');
 const long=normalizeReviewConcerns([{...concern(),expected:'x'.repeat(5000)}],s,options)[0];
 assert.equal(long.expected.length,400);assert.equal(long.omittedCharacters,4600);
 const history=compactConcernHistory(Array.from({length:20},()=>long));
 assert.equal(history.length,4);assert.ok(JSON.stringify(history).length<7000);
});

test('optional provenance travels to next existing review without adding calls or blocking ordinary completion',async()=>{
 const seen=[],updates=[],s=snapshot();let calls=0;
 const c=createModularCompletionController({policy:{version:2,modules:{verification:true}},getSnapshot:()=>s,onUpdate:r=>updates.push(r),
 review:async({snapshot:current})=>{
  seen.push(current);calls++;
  if(calls===1)return {decision:'continue',summary:'Image rejection is correct; finish requested report',remaining:['report'],nextAction:'Report result',evidenceRefs:['evidence-0001'],blockers:[],concerns:[concern()]};
  return {decision:'respond',summary:'Done',remaining:[],nextAction:'',evidenceRefs:['evidence-0001'],blockers:[]};
 }});
 assert.equal((await c.beforeFinal({output:'first'})).continue,true);
 assert.equal(await c.beforeFinal({output:'second'}),null);assert.equal(calls,2);
 assert.equal(seen[1].priorReviewConcerns[0].classification,'expected-rejection');
 assert.equal(seen[1].priorReviewConcerns[0].verified,false);
 assert.equal(seen[1].priorReviewConcerns[0].assessmentSequence,1);
 assert.equal(seen[1].priorReviewConcernsPolicy.exhaustive,false);
 assert.equal(seen[1].priorReviewConcernsPolicy.absenceDoesNotEstablishNoPriorResolution,true);
 assert.equal((await c.assertReady()).ready,true);
 assert.equal(updates.find(x=>x.concerns)?.concerns[0].evidenceRefs[0],'probe');
 const schema=modularOutcomeSchema(s);assert.ok(schema.properties.concerns);assert.ok(!schema.required.includes('concerns'));
 assert.match(modularReviewPrompt(seen[1],{output:'second'}),/prior-model-interpretation-not-authority/);
});
