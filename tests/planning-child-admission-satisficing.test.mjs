import {ResponseCycleService} from '../lib/response-cycle.mjs';
import {responseCycleTemplate} from '../public/response-cycle-model.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {childAdmissionPrompt,planningStageContract,assertChildAdmission,childAdmissionSnapshot,parseChildAdmission} from '../lib/planning-child-admission.mjs';
import {child,answer,judgment} from './fixture-child-admission.mjs';

// These fixtures specify intended decisions and parse historical judgments with
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

function snapshotFor(row){
  const source={id:'fixture-source',kind:'source',title:'Retained decision inputs',text:row.source||row.evidence};
  const input={module:{kind:'inference'},template:responseCycleTemplate('inference'),sources:[source]};
  const body=answer(input),proposal=child(input,[row.key,row.objective,row.description,row.evidence]);
  Object.assign(proposal.acceptanceCriteria[0].accuracy,{decisionThreshold:row.threshold||'',unknownPolicy:row.unknownPolicy||'assumption',stopWhen:row.threshold||row.evidence});
  body.subproblems=[proposal];
  const request={id:'fixture',objective:row.objective,nodes:[{id:'inference',kind:'inference',prompt:row.objective,revision:1}],sources:[source],
    responses:[{id:'response-one',nodeId:'inference',kind:'inference',revision:1,nodeRevision:1,...body}],attempts:[],edges:[]};
  return {request,snapshot:childAdmissionSnapshot(request,'inference')};
}

test('saved uncertain-analysis judgments preserve inherited assumption policy without launching work',()=>{
  for(const row of analyses){
    const {request,snapshot}=snapshotFor(row),before=structuredClone(request),value=parseChildAdmission(JSON.stringify(judgment(snapshot)),snapshot);
    assert.equal(value.admitted,true,row.key);
    assert.equal(snapshot.requests[0].acceptanceCriteria[0].accuracy.unknownPolicy,'assumption');
    assert.equal(snapshot.requests[0].acceptanceCriteria[0].accuracy.decisionThreshold,row.threshold);
    assert.deepEqual(request,before);
    const contract=planningStageContract({node:request.nodes[0],sources:request.sources});
    assert.equal(contract.reasoning.allowed.includes('satisficing'),true);
    assert.deepEqual(contract.capabilities,{actionTools:false,newObservations:false});
  }
});

test('an unsupported consequential confirmation is not converted into an allowed assumption',()=>{
  const row={key:'inspection',objective:'Confirm the unobserved equipment inspection passed.',description:'State that the current safety inspection passed, using an actual inspection result.',evidence:'A fresh authoritative inspection result, not an estimate.',unknownPolicy:'block'};
  const {snapshot}=snapshotFor(row),before=structuredClone(snapshot),value=parseChildAdmission(JSON.stringify(judgment(snapshot,{classification:'requires_observation'})),snapshot);
  assert.equal(value.admitted,false);
  assert.equal(snapshot.requests[0].acceptanceCriteria[0].accuracy.unknownPolicy,'block');
  assert.deepEqual(snapshot,before);
});

test('changing a saved analytical objective cannot reuse its old admission or renew automatic refinement',async()=>{
  let calls=0;
  const service=Object.create(ResponseCycleService.prototype);
  Object.defineProperty(service,'runner',{get(){calls++;throw Error('Retired refinement must not reach the provider.');}});
  const {request,snapshot}=snapshotFor(analyses[0]);
  request.attempts=[{id:'saved-review',purpose:'child_admission',status:'completed',childAdmission:{snapshot,judgment:parseChildAdmission(JSON.stringify(judgment(snapshot)),snapshot)}}];
  assert.doesNotThrow(()=>assertChildAdmission(request,'inference'));
  request.responses[0].subproblems[0].objective='A changed objective under the same key.';
  assert.throws(()=>assertChildAdmission(request,'inference'),{code:'PLANNING_CHILD_ADMISSION_REQUIRED'});
  const before=structuredClone(request),budget={used:2,max:20};
  await assert.rejects(service.runStage(request.id,'saved-cycle','inference',{budget,runKey:'resume'}),{code:'PLANNING_CYCLE_RETIRED',status:410});
  await assert.rejects(service.ensureChildAdmission(request,'inference',{budget}),{code:'PLANNING_CYCLE_RETIRED',status:410});
  assert.equal(calls,0);assert.equal(budget.used,2);assert.deepEqual(request,before);
});
