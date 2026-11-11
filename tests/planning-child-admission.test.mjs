import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime,validatePlanningModuleResponse} from '../lib/planning-browser-runtime.mjs';
import {ResponseCycleService} from '../lib/response-cycle.mjs';
import {childAdmissionSnapshot,childAdmissionReview,childAdmissionNeeded,childAdmissionPrompt,childAdmissionSchema,parseChildAdmission,assertChildAdmission} from '../lib/planning-child-admission.mjs';
import {planningCycleEvidence,planningInvocationEvidence} from '../lib/planning-invocation.mjs';
import {responseCycleStage,responseCycleTemplate} from '../public/response-cycle-model.mjs';
import {fixtureUserAgency} from './fixture-user-agency.mjs';

import {profile,cases,child,answer,judgment,fixture,single,budget} from './fixture-child-admission.mjs';

test('the source contract reproduces schema-valid semantic mismatches without keyword rejection',()=>{
  const source={id:'fixture-source',kind:'source',text:'Stipulated receipt: delivered. Fictional capacities: four and six.'},template=responseCycleTemplate('inference'),input={module:{kind:'inference'},template,sources:[source]},attempt={node:input.module,pipelineVersion:2,template,sources:[source],cycleContext:{objective:'Complete the delegated synthetic task.',children:[]}};
  for(const row of cases){const body=answer(input);body.subproblems=[child(input,row)];body.values.subproblemMap='Direct work is sufficient; no analytical child is needed.';assert.doesNotThrow(()=>validatePlanningModuleResponse(attempt,JSON.stringify(body)),row[0]);}
});

test('single-module execution remains one call and creates no semantic gate or child',async t=>{
  const f=await fixture(t,input=>{const body=answer(input);body.subproblems=[child(input)];return body;}),result=await single(f);
  assert.equal(result.attempt.status,'completed');assert.equal(f.calls.length,1);assert.equal(result.request.cycles.length,1);assert.equal(result.request.responses.length,1);assert.equal(result.request.attempts.some(item=>item.purpose==='child_admission'),false);
  assert.throws(()=>assertChildAdmission(result.request,result.attempt.nodeId),{code:'PLANNING_CHILD_ADMISSION_REQUIRED'});
});

test('operational and missing-observation children are not automatically spawned; refinement is separate',async t=>{
  for(const row of cases.filter(item=>item[4]!=='captured_analysis'))await t.test(row[0],async t=>{
    let ordinary=0;
    const f=await fixture(t,input=>{
      if(input.reviewType)return judgment(input.snapshot,{classification:row[4]});
      const body=answer(input);ordinary++;body.subproblems=[child(input,row)];
      if(input.semanticRefinement){assert.equal(input.formatRepair,undefined);body.subproblems[0].executionTarget='workflow';body.values.delegatedWork='The operational owner retains the exact operation: '+row[1];}
      return body;
    });
    const b=budget(),result=await f.service.runStage(f.request.id,f.cycle.id,'inference',{budget:b,runKey:'automatic'});
    assert.equal(result.cycles.length,1);assert.equal(ordinary,2);assert.equal(f.calls.length,4);assert.equal(b.used,4);
    assert.equal(result.responses.length,2);assert.equal(result.responses[0].subproblems[0].executionTarget,'analysis');assert.equal(result.responses[1].subproblems[0].executionTarget,'workflow');
    assert.deepEqual(result.responses[0].subproblems[0].acceptanceCriteria,result.responses[1].subproblems[0].acceptanceCriteria);
    const reviews=result.attempts.filter(item=>item.purpose==='child_admission');assert.equal(reviews.length,2);assert.equal(reviews[0].childAdmission.judgment.admitted,false);assert.equal(reviews[1].childAdmission.judgment.admitted,true);
    assert.equal(result.attempts.filter(item=>item.semanticRefinement).length,1);assert.equal(result.attempts.some(item=>item.formatRepair),false);
    assert.equal(reviews.every(item=>!item.responseId),true);
  });
});

test('empty replacement, renamed action and moved obligation get separate preservation judgments',async t=>{
  for(const variant of ['empty','renamed','moved'])await t.test(variant,async t=>{
    const f=await fixture(t,input=>{
      if(input.reviewType)return judgment(input.snapshot,{classification:'requires_effect',retained:variant==='moved'?'preserved':'not_preserved'});
      const body=answer(input);body.subproblems=[child(input)];
      if(input.semanticRefinement){
        if(variant==='empty')body.subproblems=[];
        if(variant==='renamed')body.subproblems[0].key='different-key';
        if(variant==='moved'){body.subproblems[0].executionTarget='workflow';body.values.delegatedWork='The original service request must still be submitted by the operational owner.';}
      }
      return body;
    });
    const run=f.service.runStage(f.request.id,f.cycle.id,'inference',{budget:budget(),runKey:'automatic'});
    if(variant==='moved')await run;else await assert.rejects(run,{code:'PLANNING_CHILD_ADMISSION_REJECTED'});
    const saved=await f.store.get(f.request.id),reviews=saved.attempts.filter(item=>item.purpose==='child_admission');
    assert.equal(f.calls.length,4);assert.equal(saved.cycles.length,1);assert.equal(reviews.length,2);assert.equal(reviews[1].childAdmission.snapshot.retainedObligations.requests[0].key,'service');
    if(variant==='empty')assert.equal(reviews[1].childAdmission.snapshot.requests.length,0);
  });
});

test('analysis about receipts and stipulated arithmetic can be admitted and exact child creation is fenced',async t=>{
  for(const row of cases.filter(item=>item[4]==='captured_analysis'))await t.test(row[0],async t=>{
    const f=await fixture(t,input=>{if(input.reviewType)return judgment(input.snapshot);const body=answer(input);body.subproblems=[child(input,row)];return body;}),initial=await single(f);
    const b={used:1,max:20,maxPasses:3},admission=await f.service.ensureChildAdmission(initial.request,initial.attempt.nodeId,{budget:b});
    assert.equal(admission.admitted,true);assert.equal(f.calls.length,2);assert.equal(b.used,2);
    const request=admission.request,node=request.nodes.find(item=>item.id===initial.attempt.nodeId),proposal=node.response.subproblems[0];
    assert.doesNotThrow(()=>assertChildAdmission(request,node.id,proposal));
    assert.throws(()=>assertChildAdmission(request,node.id,{...proposal,objective:'A different task.'}),{code:'PLANNING_CHILD_ADMISSION_BINDING'});
    const created=await f.service.createCurrent(request.id,{parentNodeId:node.id,title:proposal.title,purpose:proposal.objective,clientRequestId:'admitted-child'},{internal:true,acceptanceCriteria:proposal.acceptanceCriteria,sourceIds:proposal.sourceIds,key:proposal.key,required:true,subproblemRequest:proposal});
    assert.equal(created.cycles.length,2);assert.doesNotThrow(()=>assertChildAdmission(created,node.id,proposal));
    const again=await f.service.ensureChildAdmission(created,node.id,{budget:b});assert.equal(again.admitted,true);assert.equal(f.calls.length,2,'Stable bound source inputs reuse the recorded judgment.');
  });
});

test('malformed review, provider failure and exhausted budget have no hidden retry or response rewrite',async t=>{
  for(const defect of ['malformed','provider','budget'])await t.test(defect,async t=>{
    const f=await fixture(t,input=>{if(input.reviewType){if(defect==='provider')throw Error('Synthetic provider unavailable.');return '{}';}const body=answer(input);body.subproblems=[child(input)];return body;}),initial=await single(f),before=structuredClone(initial.request.responses[0]);
    await assert.rejects(f.service.ensureChildAdmission(initial.request,initial.attempt.nodeId,{budget:{used:1,max:defect==='budget'?1:20,maxPasses:3}}));
    const saved=await f.store.get(f.request.id);assert.deepEqual(saved.responses[0],before);assert.equal(saved.cycles.length,1);assert.equal(saved.responses.length,1);assert.equal(f.calls.length,defect==='budget'?1:2);
    assert.equal(saved.nodes.find(item=>item.id===initial.attempt.nodeId).readiness.state,'waiting_children');
  });
});

test('review purpose cannot masquerade as a module response or format repair and survives reload',async t=>{
  const f=await fixture(t,input=>{if(input.reviewType)return judgment(input.snapshot,{classification:'requires_effect'});const body=answer(input);body.subproblems=[child(input)];return body;}),initial=await single(f),result=await f.service.ensureChildAdmission(initial.request,initial.attempt.nodeId,{budget:{used:1,max:20}}),writer=f.store.runtimeWriter(),review=result.review;
  await assert.rejects(writer.recordResponse(f.request.id,review.id,{output:JSON.stringify(answer(f.calls[0].input)),metadata:{runId:'wrong-purpose',executionNodeId:review.nodeId}}),{code:'PLANNING_ATTEMPT_PURPOSE'});
  await assert.rejects(writer.beginRepairAttempt(f.request.id,review.id),{code:'PLANNING_REPAIR_INELIGIBLE'});
  await assert.rejects(writer.settleChildAdmission(f.request.id,initial.attempt.id,{status:'completed',output:'{}'}),{code:'PLANNING_ATTEMPT_PURPOSE'});
  const reloaded=await new PlanningBrowserStore({dataDir:f.dir}).init();t.after(()=>reloaded.close());const saved=await reloaded.get(f.request.id);
  assert.equal(saved.responses.length,1);assert.equal(saved.attempts.length,2);assert.equal(childAdmissionReview(saved,childAdmissionSnapshot(saved,review.nodeId)).id,review.id);
  const liveReceipt=f.runner.status().invocations.find(item=>item.attemptId===review.id);assert.equal(liveReceipt.scope,'planning-child-admission');assert.equal(liveReceipt.providerResponse,'completed');assert.equal(saved.attempts.find(item=>item.id===review.id).metadata.usage.totalTokens,120);
  const receipt=planningInvocationEvidence(saved,review.id);assert.equal(receipt.scope,'planning-child-admission');assert.equal(receipt.durableResponseRecorded,false);assert.equal(receipt.effectsVerified,false);
  assert.equal(planningCycleEvidence(saved,saved.cycles[0]).stages[0].attemptId,initial.attempt.id);
});

test('semantic refinement lineage survives format repair and automatic resumes cannot renew its budget',async t=>{
  const f=await fixture(t,input=>{
    if(input.reviewType)return judgment(input.snapshot,{classification:'requires_effect',retained:'not_preserved'});
    const body=answer(input);
    if(!input.semanticRefinement&&!input.formatRepair)body.subproblems=[child(input)];
    if(input.semanticRefinement&&!input.formatRepair)body.values.subproblemMap=17;
    return body;
  });
  await assert.rejects(f.service.runStage(f.request.id,f.cycle.id,'inference',{budget:budget(),runKey:'first'}),{code:'PLANNING_CHILD_ADMISSION_REJECTED'});
  const saved=await f.store.get(f.request.id),reviews=saved.attempts.filter(item=>item.purpose==='child_admission'),repair=saved.attempts.find(item=>item.repairOf),refinement=saved.attempts.find(item=>item.semanticRefinement&&!item.repairOf);
  assert.equal(f.calls.length,5);assert.equal(reviews.length,2);assert.equal(repair.status,'completed');
  assert.deepEqual(repair.semanticRefinement,refinement.semanticRefinement);
  assert.equal(reviews[1].childAdmission.snapshot.requests.length,0);
  assert.equal(reviews[1].childAdmission.snapshot.retainedObligations.reviewAttemptId,reviews[0].id);
  assert.equal(reviews[1].childAdmission.snapshot.retainedObligations.requests[0].key,'service');
  await assert.rejects(f.service.runStage(f.request.id,f.cycle.id,'inference',{budget:budget(),runKey:'resume'}),{code:'PLANNING_CHILD_ADMISSION_REJECTED'});
  const node=saved.nodes.find(item=>item.id===f.cycle.stageNodeIds.inference);
  await assert.rejects(f.runner.start({requestId:saved.id,nodeId:node.id,expectedNodeRevision:node.revision,...profile,clientRequestId:'another-refinement',semanticRefinement:reviews[1].id}),{code:'PLANNING_CHILD_ADMISSION_REJECTED'});
  assert.equal(f.calls.length,5,'No new provider calls after the one durable refinement.');
  const reloaded=await new PlanningBrowserStore({dataDir:f.dir}).init();t.after(()=>reloaded.close());
  const reloadedService=new ResponseCycleService({store:reloaded,runner:f.runner});t.after(()=>reloadedService.close());
  await assert.rejects(reloadedService.runStage(saved.id,f.cycle.id,'inference',{budget:budget(),runKey:'restart'}),{code:'PLANNING_CHILD_ADMISSION_REJECTED'});
  assert.equal(f.calls.length,5);
});

test('failed or cancelled refinement cannot gain a new allowance from automatic scope refresh',async t=>{
  for(const outcome of ['failed','cancelled'])await t.test(outcome,async t=>{
    const controller=new AbortController();
    const f=await fixture(t,input=>{
      if(input.reviewType)return judgment(input.snapshot,{classification:'requires_effect'});
      if(input.semanticRefinement){if(outcome==='cancelled')controller.abort();throw Error('Synthetic refinement did not complete.');}
      const body=answer(input);body.subproblems=[child(input)];return body;
    });
    await assert.rejects(f.service.runStage(f.request.id,f.cycle.id,'inference',{budget:budget(),runKey:'initial',signal:controller.signal}));
    let saved=await f.store.get(f.request.id),refinement=saved.attempts.find(item=>item.semanticRefinement);
    await f.runner.wait(saved.id,refinement.id);saved=await f.store.get(saved.id);refinement=saved.attempts.find(item=>item.id===refinement.id);
    assert.equal(refinement.status,outcome);assert.equal(f.calls.length,3);
    const node=saved.nodes.find(item=>item.id===f.cycle.stageNodeIds.inference);
    await f.store.updateNode(saved.id,node.id,{prompt:'A changed scope still retaining the same delegated operation.'},{expectedNodeRevision:node.revision});
    await assert.rejects(f.service.runStage(saved.id,f.cycle.id,'inference',{budget:budget(),runKey:'scope-refresh'}),{code:'PLANNING_CHILD_ADMISSION_REJECTED'});
    saved=await f.store.get(saved.id);assert.equal(saved.responses.length,1);assert.equal(saved.attempts.filter(item=>item.semanticRefinement&&!item.repairOf).length,1);assert.equal(saved.attempts.filter(item=>item.purpose==='child_admission').length,2);assert.equal(f.calls.length,4,'Only the changed-scope review is new, never another refinement.');
  });
});
