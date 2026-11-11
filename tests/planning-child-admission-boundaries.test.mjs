import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {profile,cases,child,answer,judgment,fixture,single,budget} from './fixture-child-admission.mjs';
import {childAdmissionSnapshot,childAdmissionReview,childAdmissionSchema,parseChildAdmission,assertChildAdmission} from '../lib/planning-child-admission.mjs';
import {projectPlanningBrowserExecution} from '../lib/planning-browser-http.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('running review has exact request activity and cancellation settles without changing its accepted response',async t=>{
  const started=deferred(),controller=new AbortController();
  const f=await fixture(t,async(input,_index,options)=>{
    if(input.reviewType){started.resolve();await new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(Object.assign(Error('Synthetic cancellation.'),{code:'ABORT_ERR'})),{once:true});});}
    const body=answer(input);body.subproblems=[child(input)];return body;
  }),initial=await single(f),before=structuredClone(initial.request.responses[0]);
  const pending=f.service.ensureChildAdmission(initial.request,initial.attempt.nodeId,{budget:{used:1,max:20},signal:controller.signal});
  const rejected=assert.rejects(pending);await started.promise;
  const status=f.runner.status(),saved=await f.store.get(f.request.id),active=projectPlanningBrowserExecution(saved,status);
  assert.equal(status.activeCount,1);assert.equal(status.attempts[0].purpose,'child_admission');assert.equal(status.attempts[0].requestId,f.request.id);assert.equal(active.execution.running,1);
  const unrelated=projectPlanningBrowserExecution({id:'unrelated',nodes:[],attempts:[],summary:{running:0}},status);assert.equal(unrelated.execution.running,0);assert.equal(unrelated.execution.state,'idle');
  controller.abort();await rejected;
  const settled=await f.store.get(f.request.id),review=settled.attempts.find(item=>item.purpose==='child_admission');
  assert.equal(review.status,'cancelled');assert.equal(f.runner.status().activeCount,0);assert.deepEqual(settled.responses[0],before);assert.equal(f.calls.length,2);
});

test('review tool event fails closed without any format or semantic retry',async t=>{
  const f=await fixture(t,(input,_index,options)=>{if(input.reviewType){options.onEvent({type:'tool_call',name:'not_allowed'});return judgment(input.snapshot);}const body=answer(input);body.subproblems=[child(input)];return body;}),initial=await single(f);
  await assert.rejects(f.service.ensureChildAdmission(initial.request,initial.attempt.nodeId,{budget:{used:1,max:20}}),{code:'PLANNING_RESPONSE_ONLY_VIOLATION'});
  const saved=await f.store.get(f.request.id),review=saved.attempts.at(-1);assert.equal(review.status,'failed');assert.equal(saved.responses.length,1);assert.equal(saved.cycles.length,1);assert.equal(f.calls.length,2);
});

test('changed parent scope, captured source or response invalidates a saved admission before automatic create or resume',async t=>{
  for(const change of ['scope','source','response'])await t.test(change,async t=>{
    const f=await fixture(t,input=>{if(input.reviewType)return judgment(input.snapshot);const body=answer(input),proposal=child(input,cases[5]);proposal.sourceIds=['cycle:context:'+f.cycle.id];body.subproblems=[proposal];return body;});
    f.request=await f.store.runtimeWriter().configureResponseCycle(f.request.id,{sources:[{id:'cycle:context:'+f.cycle.id,kind:'source',title:'Retained inputs',text:'Stipulated capacities are four and six.'}]});
    const initial=await single(f),admission=await f.service.ensureChildAdmission(initial.request,initial.attempt.nodeId,{budget:{used:1,max:20}}),node=admission.request.nodes.find(item=>item.id===initial.attempt.nodeId),proposal=node.response.subproblems[0];
    let changed;
    if(change==='scope')changed=await f.store.updateNode(f.request.id,node.id,{prompt:'A materially changed parent question.'},{expectedNodeRevision:node.revision});
    if(change==='source')changed=await f.store.runtimeWriter().configureResponseCycle(f.request.id,{sources:[{id:'cycle:context:'+f.cycle.id,kind:'source',title:'Retained inputs',text:'Stipulated capacities are now ten and twenty.'}]});
    if(change==='response'){
      const claim=await f.runner.start({requestId:f.request.id,nodeId:node.id,expectedNodeRevision:node.revision,...profile,clientRequestId:'replacement-response'});changed=(await f.runner.wait(f.request.id,claim.attempt.id)).request;
    }
    assert.throws(()=>assertChildAdmission(changed,node.id,proposal),{code:'PLANNING_CHILD_ADMISSION_REQUIRED'});
    await assert.rejects(f.service.createCurrent(f.request.id,{parentNodeId:node.id,title:proposal.title,purpose:proposal.objective,clientRequestId:'stale-create'},{internal:true,acceptanceCriteria:proposal.acceptanceCriteria,sourceIds:proposal.sourceIds,key:proposal.key,required:true,subproblemRequest:proposal}),{code:'PLANNING_CHILD_ADMISSION_REQUIRED'});
    assert.equal((await f.store.get(f.request.id)).cycles.length,1);
  });
});

test('manual child creation is inert and cannot be silently adopted as automatic recursive work',async t=>{
  const f=await fixture(t,input=>answer(input)),node=f.request.nodes.find(item=>item.id===f.cycle.stageNodeIds.inference);
  const created=await f.service.createCycle(f.request.id,{parentNodeId:node.id,expectedParentRevision:node.revision,expectedRequestRevision:f.request.revision,title:'Manual bounded question',purpose:'Compare the two stipulated quantities.',planningExecutionMode:'plan_only',clientRequestId:'manual-child'});
  const childCycle=created.cycles.find(item=>item.parentStageId===node.id);assert.ok(childCycle);assert.equal(childCycle.request,undefined);assert.equal(f.calls.length,0);
  const saved=await f.service.runStage(f.request.id,f.cycle.id,'inference',{budget:budget(),runKey:'automatic-root'});
  assert.equal(f.calls.length,1);assert.equal(saved.attempts.some(item=>item.nodeId===childCycle.stageNodeIds.inference),false);
  const childNode=saved.nodes.find(item=>item.id===childCycle.stageNodeIds.inference),claim=await f.runner.start({requestId:saved.id,nodeId:childNode.id,expectedNodeRevision:childNode.revision,...profile,clientRequestId:'explicit-manual-child-response'});
  const explicit=await f.runner.wait(saved.id,claim.attempt.id);assert.equal(explicit.attempt.status,'completed');assert.equal(f.calls.length,2,'An explicit single-module run retains user control without automatic child review.');
});

test('invalid duplicate judgment, invented path and saved judgment tampering cannot become admission',async t=>{
  const f=await fixture(t,input=>{if(input.reviewType)return judgment(input.snapshot);const body=answer(input);body.subproblems=[child(input,cases[5])];return body;}),initial=await single(f),result=await f.service.ensureChildAdmission(initial.request,initial.attempt.nodeId,{budget:{used:1,max:20}}),snapshot=result.review.childAdmission.snapshot,value=judgment(snapshot);
  assert.throws(()=>parseChildAdmission(JSON.stringify(value).replace('"classification":"captured_analysis"','"classification":"requires_effect","classification":"captured_analysis"'),snapshot),/duplicate JSON/);
  const wrong=structuredClone(value);wrong.findings[0].paths=['response.invented'];assert.throws(()=>parseChildAdmission(JSON.stringify(wrong),snapshot),/paths/);
  const file=f.store.file(f.request.id),raw=JSON.parse(await readFile(file,'utf8')),saved=raw.attempts.find(item=>item.id===result.review.id);saved.childAdmission.judgment.admitted=false;await writeFile(file,JSON.stringify(raw));
  await assert.rejects(f.store.get(f.request.id),/data is invalid/);
});

test('a zero-child refinement schema remains valid and retains original captured inputs',async t=>{
  const f=await fixture(t,input=>{if(input.reviewType)return judgment(input.snapshot,{classification:'requires_effect',retained:'not_preserved'});const body=answer(input);if(!input.semanticRefinement)body.subproblems=[child(input)];return body;});
  await assert.rejects(f.service.runStage(f.request.id,f.cycle.id,'inference',{budget:budget(),runKey:'empty-refinement'}),{code:'PLANNING_CHILD_ADMISSION_REJECTED'});
  const saved=await f.store.get(f.request.id),snapshot=saved.attempts.filter(item=>item.purpose==='child_admission').at(-1).childAdmission.snapshot,schema=childAdmissionSchema(snapshot);
  assert.equal(snapshot.requests.length,0);assert.ok(snapshot.sources.length>0);assert.ok(snapshot.retainedObligations);assert.equal(schema.properties.findings.maxItems,0);assert.equal(schema.properties.findings.items.properties.key.enum,undefined);
});

test('review paths name only own JSON data fields, never prototypes or array implementation properties',async t=>{
  const f=await fixture(t,input=>{const body=answer(input);body.subproblems=[child(input)];return body;}),initial=await single(f),snapshot=childAdmissionSnapshot(initial.request,initial.attempt.nodeId);
  for(const path of ['response.constructor','response.subproblems[0].toString','response.subproblems.length','response.subproblems[999]','response.values[0]']){
    const output=judgment(snapshot,{classification:'requires_effect'});output.findings[0].paths=[path];
    assert.throws(()=>parseChildAdmission(JSON.stringify(output),snapshot),{code:'PLANNING_CHILD_ADMISSION_INVALID'},path);
    const retained={...snapshot,retainedObligations:{requests:snapshot.requests}},replacement=judgment(retained);replacement.retainedOutcome.paths=[path];
    assert.throws(()=>parseChildAdmission(JSON.stringify(replacement),retained),{code:'PLANNING_CHILD_ADMISSION_INVALID'},path);
  }
  const valid=judgment(snapshot,{classification:'requires_effect'});valid.findings[0].paths=['response.subproblems[0].acceptanceCriteria[0].accuracy.evidenceNeeded'];assert.doesNotThrow(()=>parseChildAdmission(JSON.stringify(valid),snapshot));
});
