import test from 'node:test';
import assert from 'node:assert/strict';
import {childAdmissionPrompt,planningStageContract,assertChildAdmission} from '../lib/planning-child-admission.mjs';
import {child,answer,judgment,fixture,single,budget} from './fixture-child-admission.mjs';

// These fixtures specify intended decisions and exercise host enforcement with
// mocked judgments. They are not measurements of model classification accuracy.
const analyses=[
  {key:'estimate',objective:'Estimate a practical completion window from the sparse supplied samples.',description:'Return an approximate window with a declared variability assumption, not a guaranteed date.',evidence:'Three retained durations and an explicitly declared variability assumption.',source:'Three comparable fictional runs took two, three and five days. No guarantee or current measurement is supplied.',threshold:'A rough window is sufficient to choose a reversible next step.'},
  {key:'hypothesis',objective:'Choose a useful working hypothesis for the reported symptom.',description:'Rank plausible explanations with stated assumptions and uncertainty, without claiming a new inspection occurred.',evidence:'The retained symptom report and declared diagnostic assumptions.',source:'The fictional device intermittently resets after a load increase. No current inspection is available.',threshold:'Choose a reasonable first hypothesis; certainty is not required.'},
  {key:'satisficing',objective:'Recommend a good-enough option from the supplied partial tradeoffs.',description:'Choose an option meeting the stated minimum benefit under declared assumptions, without proving global optimality.',evidence:'The partial option comparison and stated threshold.',source:'Option A has estimated benefit seven and cost two; B has estimated benefit nine and cost seven. Minimum useful benefit is six. Estimates may be imperfect.',threshold:'Stop when an option is reasonably expected to meet the minimum benefit within the cost constraint.'},
  {key:'information-value',objective:'Estimate whether another check is worth its cost and delay before a reversible choice.',description:'Compare the expected benefit of information with its cost using declared probabilities; recommend proceeding or checking, but do not perform the check.',evidence:'Supplied hypothetical check costs and explicitly declared decision probabilities.',source:'A hypothetical extra check costs two effort units and delays the decision. A reversible option is currently preferred. Its value of further information is uncertain.',threshold:'Do not investigate when the plausible decision benefit is lower than the check cost and delay.'},
];

test('stage and reviewer contracts permit bounded inference and satisficing without requiring complete proof',()=>{
  const criterion={id:'choice',label:'Useful choice',description:'Recommend a useful option under stated assumptions.',verification:'response',accuracy:{mode:'qualitative',tolerance:'',decisionThreshold:'Good enough for a reversible decision.',evidenceNeeded:'Available partial comparison.',consequence:'A small reversible planning cost.',unknownPolicy:'assumption',stopWhen:'An adequately supported practical choice is available.'}};
  const contract=planningStageContract({node:{kind:'inference'},cycleContext:{acceptanceCriteria:[criterion]},sources:[]});
  assert.deepEqual(contract.inheritedCriteria,[criterion]);
  assert.deepEqual(contract.reasoning.allowed,['bounded_inference','estimates','declared_assumptions','satisficing','value_of_information']);
  const prompt=childAdmissionPrompt({requests:[],sources:[]});
  assert.match(prompt,/not complete evidence or proof/);
  assert.match(prompt,/Do not demand every unknown be resolved/);
  assert.match(prompt,/Preserve explicit uncertainty policy/);
  assert.match(prompt,/not uncertainty in an estimate/);
  assert.match(prompt,/guess must not be presented as a verified consequential fact/);
});

test('legitimate uncertain analysis remains admissible under inherited assumption policy',async t=>{
  for(const row of analyses)await t.test(row.key,async t=>{
    const f=await fixture(t,input=>{
      if(input.reviewType)return judgment(input.snapshot);
      const body=answer(input),proposal=child(input,[row.key,row.objective,row.description,row.evidence]);
      proposal.sourceIds=['cycle:context:'+f.cycle.id];
      Object.assign(proposal.acceptanceCriteria[0].accuracy,{decisionThreshold:row.threshold,unknownPolicy:'assumption',stopWhen:row.threshold});
      body.subproblems=[proposal];return body;
    });
    f.request=await f.store.runtimeWriter().configureResponseCycle(f.request.id,{sources:[{id:'cycle:context:'+f.cycle.id,kind:'source',title:'Partial fictional decision inputs',text:row.source}]});
    const initial=await single(f),before=structuredClone(initial.request.responses[0]),b={used:1,max:20};
    const review=await f.service.ensureChildAdmission(initial.request,initial.attempt.nodeId,{budget:b});
    assert.equal(review.admitted,true);assert.equal(f.calls.length,2);assert.equal(b.used,2);
    assert.deepEqual(review.request.responses[0],before);
    assert.equal(review.review.childAdmission.snapshot.requests[0].acceptanceCriteria[0].accuracy.unknownPolicy,'assumption');
    assert.doesNotThrow(()=>assertChildAdmission(review.request,initial.attempt.nodeId,before.subproblems[0]));
    assert.equal(f.calls[0].input.stageContract.reasoning.allowed.includes('satisficing'),true);
  });
});

test('an unsupported consequential confirmation is not converted into an allowed assumption',async t=>{
  const f=await fixture(t,input=>{
    if(input.reviewType)return judgment(input.snapshot,{classification:'requires_observation'});
    const body=answer(input),proposal=child(input,['inspection','Confirm the unobserved equipment inspection passed.','State that the current safety inspection passed, using an actual inspection result.','A fresh authoritative inspection result, not an estimate.']);
    Object.assign(proposal.acceptanceCriteria[0].accuracy,{mode:'exact',unknownPolicy:'block',tolerance:'No unsupported confirmation.',stopWhen:'The actual required inspection result is available.'});
    body.subproblems=[proposal];return body;
  }),initial=await single(f),before=structuredClone(initial.request.responses[0]);
  const review=await f.service.ensureChildAdmission(initial.request,initial.attempt.nodeId,{budget:{used:1,max:20}});
  assert.equal(review.admitted,false);assert.equal(f.calls.length,2);assert.deepEqual(review.request.responses[0],before);
  assert.equal(review.review.childAdmission.snapshot.requests[0].acceptanceCriteria[0].accuracy.unknownPolicy,'block');
  assert.throws(()=>assertChildAdmission(review.request,initial.attempt.nodeId),{code:'PLANNING_CHILD_ADMISSION_REQUIRED'});
});

test('a semantic refinement cannot become an accepted changed-binding response and reset its allowance',async t=>{
  const f=await fixture(t,input=>{
    if(input.reviewType)return judgment(input.snapshot,{classification:'requires_effect'});
    const body=answer(input),proposal=child(input);
    if(input.semanticRefinement||input.formatRepair)proposal.objective='A changed objective under the same bound key.';
    body.subproblems=[proposal];return body;
  }),initial=await single(f),node=initial.request.nodes.find(item=>item.id===initial.attempt.nodeId),proposal=node.response.subproblems[0];
  await f.service.createCurrent(initial.request.id,{parentNodeId:node.id,expectedParentRevision:node.revision,expectedRequestRevision:initial.request.revision,title:proposal.title,purpose:proposal.objective,planningExecutionMode:'plan_only',clientRequestId:'historical-bound-child'},
    {internal:false,key:proposal.key,required:true,acceptanceCriteria:proposal.acceptanceCriteria,sourceIds:proposal.sourceIds,subproblemRequest:proposal});
  await assert.rejects(f.service.runStage(initial.request.id,f.cycle.id,'inference',{budget:budget(),runKey:'rejected-binding-change'}),{code:'PLANNING_CHILD_ADMISSION_REJECTED'});
  let saved=await f.store.get(initial.request.id),attempts=saved.attempts.filter(item=>item.semanticRefinement),calls=f.calls.length;
  assert.equal(saved.responses.length,1);assert.equal(attempts.length,2);assert.equal(attempts.every(item=>item.status==='failed'),true);
  assert.deepEqual(attempts[1].semanticRefinement,attempts[0].semanticRefinement);assert.equal(attempts[1].repairOf,attempts[0].id);
  await assert.rejects(f.service.runStage(saved.id,f.cycle.id,'inference',{budget:budget(),runKey:'binding-change-resume'}),{code:'PLANNING_CHILD_ADMISSION_REJECTED'});
  saved=await f.store.get(saved.id);assert.equal(saved.responses.length,1);assert.equal(f.calls.length,calls);
});
