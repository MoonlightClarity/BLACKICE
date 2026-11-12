import {createHash} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime,validatePlanningModuleResponse} from '../lib/planning-browser-runtime.mjs';
import {ResponseCycleService} from '../lib/response-cycle.mjs';
import {childAdmissionSnapshot,childAdmissionReview,childAdmissionNeeded,parseChildAdmission,assertChildAdmission,childAdmissionRefinementCount} from '../lib/planning-child-admission.mjs';
import {planningInvocationEvidence} from '../lib/planning-invocation.mjs';
import {responseCycleTemplate} from '../public/response-cycle-model.mjs';
import {profile,cases,child,answer,judgment} from './fixture-child-admission.mjs';

const retired={code:'PLANNING_CYCLE_RETIRED',status:410};
function snapshotFor(row=cases[0]){
  const source={id:'fixture-source',kind:'source',title:'Retained synthetic inputs',text:'Stipulated receipt: delivered. Fictional capacities: four and six.'};
  const input={module:{kind:'inference'},template:responseCycleTemplate('inference'),sources:[source]};
  const body=answer(input);body.subproblems=[child(input,row)];
  const request={id:'fixture',objective:'Complete the delegated synthetic task.',nodes:[{id:'inference',kind:'inference',prompt:'Analyze the retained inputs.',revision:1}],
    sources:[source],responses:[{id:'response-one',nodeId:'inference',kind:'inference',revision:1,nodeRevision:1,...body}],attempts:[],edges:[]};
  return {request,snapshot:childAdmissionSnapshot(request,'inference'),body,input};
}

async function fixture(t,{toolEvent=false}={}){
  const dir=await mkdtemp(path.join(os.tmpdir(),'planning-child-current-')),store=await new PlanningBrowserStore({dataDir:dir}).init(),calls=[];
  const runner=new PlanningBrowserRuntime({store,defaultCwd:dir,getSettings:()=>({maxSubagents:2}),runtime:{runAgent:async options=>{
    const input=JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n')+2));calls.push({input,options});if(toolEvent)options.onEvent({type:'tool_call',name:'not_allowed'});
    const body=answer(input);body.subproblems=[child(input)];
    return {output:JSON.stringify(body),threadId:'current-module',turnId:'one'};
  }}});
  const service=new ResponseCycleService({store,runner});
  t.after(async()=>{await runner.close();await service.close();await store.close();await rm(dir,{recursive:true,force:true});});
  let request=await store.create({id:'current',conversationId:'current-conversation',title:'Synthetic task',objective:'Inspect the retained synthetic record.',cwd:dir});
  request=await store.addNode(request.id,{id:'inference',kind:'inference',title:'Bounded analysis',prompt:request.objective});
  return {dir,store,runner,service,calls,request};
}

test('the source contract reproduces schema-valid semantic mismatches without keyword rejection',()=>{
  for(const row of cases){
    const {input,body}=snapshotFor(row),attempt={node:input.module,pipelineVersion:2,template:input.template,sources:input.sources,cycleContext:{objective:'Complete the delegated synthetic task.',children:[]}};
    body.values.subproblemMap='Direct work is sufficient; no analytical child is needed.';
    assert.doesNotThrow(()=>validatePlanningModuleResponse(attempt,JSON.stringify(body)),row[0]);
  }
});

test('current single-module execution remains one response-only call without a semantic gate or automatic child',async t=>{
  const f=await fixture(t),claim=await f.runner.start({requestId:f.request.id,nodeId:'inference',expectedNodeRevision:1,...profile,clientRequestId:'manual-response'});
  const result=await f.runner.wait(f.request.id,claim.attempt.id);
  assert.equal(result.attempt.status,'completed');assert.equal(f.calls.length,1);
  assert.equal(result.request.cycles.length,0);assert.equal(result.request.nodes.length,1);assert.equal(result.request.responses.length,1);
  assert.equal(result.request.attempts.some(item=>item.purpose==='child_admission'),false);
  assert.equal(f.calls[0].options.responseOnly,true);assert.deepEqual(f.calls[0].options.dynamicTools,[]);
  assert.equal(result.request.responses[0].verifiedAction,false);
  assert.throws(()=>assertChildAdmission(result.request,'inference'),{code:'PLANNING_CHILD_ADMISSION_REQUIRED'});
});

test('retired automatic stage, review, refinement and child creation never dispatch or mutate a current graph',async t=>{
  const f=await fixture(t),before=await readFile(f.store.file(f.request.id),'utf8'),budget={used:0,max:20,maxPasses:3};
  for(const row of cases){
    const {body}=snapshotFor(row);
    for(const operation of [
      ()=>f.service.createCycle(f.request.id,{title:row[1],purpose:row[2],expectedRequestRevision:f.request.revision}),
      ()=>f.service.createCurrent(f.request.id,{parentNodeId:'inference',title:row[1],purpose:row[2]},{internal:true,subproblemRequest:body.subproblems[0]}),
      ()=>f.service.runStage(f.request.id,'retired-cycle','inference',{budget,runKey:row[0]}),
      ()=>f.service.ensureChildAdmission(f.request,'inference',{budget})
    ])await assert.rejects(async()=>operation(),retired,row[0]);
  }
  assert.equal(budget.used,0);assert.equal(f.calls.length,0);assert.equal(f.runner.status().activeCount,0);
  assert.equal(await readFile(f.store.file(f.request.id),'utf8'),before);
});

test('saved source-bound judgments distinguish analysis, observation and effects without granting execution authority',()=>{
  for(const row of cases){
    const {request,snapshot,body}=snapshotFor(row),parsed=parseChildAdmission(JSON.stringify(judgment(snapshot,{classification:row[4]})),snapshot);
    assert.equal(parsed.admitted,row[4]==='captured_analysis',row[0]);assert.equal(parsed.kind,'model_judgment');
    const review={id:'saved-review',nodeId:'inference',purpose:'child_admission',status:'completed',childAdmission:{snapshot,judgment:parsed}};
    request.attempts.push(review);
    assert.equal(childAdmissionReview(request,snapshot),review);assert.equal(childAdmissionNeeded(snapshot),true);
    if(parsed.admitted){
      assert.equal(assertChildAdmission(request,'inference',body.subproblems[0]),review);
      assert.throws(()=>assertChildAdmission(request,'inference',{...body.subproblems[0],objective:'A different task.'}),{code:'PLANNING_CHILD_ADMISSION_BINDING'});
    }else assert.throws(()=>assertChildAdmission(request,'inference'),{code:'PLANNING_CHILD_ADMISSION_REQUIRED'});
  }
});

test('empty, renamed and moved replacements retain their separate original-obligation judgments',()=>{
  for(const variant of ['empty','renamed','moved']){
    const {snapshot}=snapshotFor(),replacement=structuredClone(snapshot);
    replacement.retainedObligations={reviewAttemptId:'original-review',responseId:snapshot.responseId,requests:structuredClone(snapshot.requests)};
    if(variant==='empty'){replacement.requests=[];replacement.response.subproblems=[];}
    if(variant==='renamed'){replacement.requests[0].key='different-key';replacement.response.subproblems[0].key='different-key';}
    if(variant==='moved'){replacement.requests=[];replacement.response.subproblems[0].executionTarget='workflow';replacement.response.values.delegatedWork='The original service request remains with its operational owner.';}
    const value=judgment(replacement,{classification:'requires_effect',retained:variant==='moved'?'preserved':'not_preserved'});
    const before=structuredClone(replacement),parsed=parseChildAdmission(JSON.stringify(value),replacement);
    assert.equal(parsed.admitted,variant==='moved');assert.deepEqual(replacement,before);
    assert.equal(replacement.retainedObligations.requests[0].key,'service');
  }
});

test('malformed saved judgments fail closed without rewriting accepted responses',()=>{
  const {snapshot}=snapshotFor(),before=structuredClone(snapshot);
  for(const output of ['{','{}',JSON.stringify({...judgment(snapshot),extra:true}),JSON.stringify({...judgment(snapshot),findings:[]})])
    assert.throws(()=>parseChildAdmission(output,snapshot),{code:'PLANNING_CHILD_ADMISSION_INVALID'});
  assert.deepEqual(snapshot,before);
});

test('historical review receipts remain judgments rather than module responses or verified effects',()=>{
  const {request,snapshot}=snapshotFor();
  const review={id:'saved-review',nodeId:'inference',purpose:'child_admission',status:'completed',model:profile.model,
    childAdmission:{snapshot,judgment:parseChildAdmission(JSON.stringify(judgment(snapshot)),snapshot)},metadata:{usage:{totalTokens:120}}};
  request.attempts.push(review);
  const receipt=planningInvocationEvidence(request,review.id);
  assert.equal(receipt.scope,'planning-child-admission');assert.equal(receipt.durableResponseRecorded,false);assert.equal(receipt.effectsVerified,false);
  assert.equal(request.responses.length,1);assert.equal(childAdmissionReview(request,snapshot).id,review.id);
});

test('historical refinement lineage counts one generation regardless of format repair or settlement',()=>{
  for(const status of ['failed','cancelled','completed']){
    const {request,snapshot}=snapshotFor(),review={id:'review',childAdmission:{snapshot}};
    const semanticRefinement={rootResponseId:snapshot.responseId,reviewAttemptId:'review'};
    request.attempts=[{id:'refinement',status,semanticRefinement},{id:'repair',status,repairOf:'refinement',semanticRefinement}];
    assert.equal(childAdmissionRefinementCount(request,review),1);
  }
});

test('archived accepted child findings remain readable but cannot be revised, reviewed, repaired or resumed',async t=>{
  const f=await fixture(t),claim=await f.runner.start({requestId:f.request.id,nodeId:'inference',expectedNodeRevision:1,...profile,clientRequestId:'saved-response'});
  const accepted=await f.runner.wait(f.request.id,claim.attempt.id),raw=JSON.parse(await readFile(f.store.file(f.request.id),'utf8'));
  raw.responseCycle={version:1,rootCycleId:'historical-root',cycles:[]};f.store._validate(raw);
  await writeFile(f.store.file(f.request.id),JSON.stringify(raw));
  const before=await readFile(f.store.file(f.request.id),'utf8'),archived=await f.store.get(f.request.id);
  assert.deepEqual(archived.responses,accepted.request.responses);
  for(const operation of [
    ()=>f.runner.start({requestId:f.request.id,nodeId:'inference',expectedNodeRevision:1,...profile,clientRequestId:'fresh'}),
    ()=>f.runner.reviewChildren({requestId:f.request.id,nodeId:'inference',expectedNodeRevision:1,...profile,clientRequestId:'review'}),
    ()=>f.store.updateNode(f.request.id,'inference',{prompt:'Changed scope'},{expectedNodeRevision:1}),
    ()=>f.store.runtimeWriter().beginRepairAttempt(f.request.id,claim.attempt.id),
    ()=>f.service.runStage(f.request.id,'historical-root','inference',{budget:{used:0,max:20}})
  ])await assert.rejects(async()=>operation(),retired);
  assert.equal(f.calls.length,1);assert.equal(await readFile(f.store.file(f.request.id),'utf8'),before);
  const reopened=await new PlanningBrowserStore({dataDir:f.dir}).init();
  try{assert.deepEqual((await reopened.get(f.request.id)).responses,archived.responses);}finally{await reopened.close();}
});

test('current response-only tool violations fail closed without semantic retry, format repair or response acceptance',async t=>{
  const f=await fixture(t,{toolEvent:true}),claim=await f.runner.start({requestId:f.request.id,nodeId:'inference',expectedNodeRevision:1,...profile,clientRequestId:'invalid-tool-event'});
  const result=await f.runner.wait(f.request.id,claim.attempt.id),saved=await f.store.get(f.request.id);
  assert.equal(result.attempt.status,'failed');assert.match(result.attempt.message,/response-only provider emitted an operational tool event/);
  assert.equal(f.calls.length,1);assert.equal(saved.responses.length,0);assert.equal(saved.attempts.length,1);
  assert.equal(saved.attempts.some(attempt=>attempt.repairOf||attempt.semanticRefinement||attempt.purpose==='child_admission'),false);
  const writer=f.store.runtimeWriter();
  await assert.rejects(writer.beginRepairAttempt(saved.id,claim.attempt.id),{code:'PLANNING_REPAIR_INELIGIBLE'});
  await assert.rejects(writer.settleChildAdmission(saved.id,claim.attempt.id,{status:'completed',output:'{}'}),{code:'PLANNING_ATTEMPT_PURPOSE'});
  assert.equal(f.calls.length,1);
});

test('saved review purpose, exact receipts and tamper rejection survive archive reload without new execution',async t=>{
  const f=await fixture(t),claim=await f.runner.start({requestId:f.request.id,nodeId:'inference',expectedNodeRevision:1,...profile,clientRequestId:'historical-module'});
  await f.runner.wait(f.request.id,claim.attempt.id);
  const file=f.store.file(f.request.id),raw=JSON.parse(await readFile(file,'utf8')),snapshot=childAdmissionSnapshot(raw,'inference'),output=JSON.stringify(judgment(snapshot,{classification:'requires_effect'}));
  const review={id:'historical-review',requestId:raw.id,nodeId:'inference',nodeRevision:raw.nodes[0].revision,ownerId:'historical-owner',purpose:'child_admission',status:'completed',
    startedAt:raw.updatedAt,finishedAt:raw.updatedAt,node:structuredClone(raw.nodes[0]),inputs:[],sources:structuredClone(snapshot.sources),...profile,
    childAdmission:{snapshot,judgment:parseChildAdmission(output,snapshot)},output,outputHash:createHash('sha256').update(output).digest('hex'),metadata:{usage:{totalTokens:120}}};
  raw.attempts.push(review);raw.responseCycle={version:1,rootCycleId:'saved-cycle',cycles:[]};
  f.store._validate(raw);await writeFile(file,JSON.stringify(raw));
  const before=await readFile(file,'utf8'),reopened=await new PlanningBrowserStore({dataDir:f.dir}).init();
  try{
    const saved=await reopened.get(raw.id),writer=reopened.runtimeWriter();
    assert.equal(childAdmissionReview(saved,childAdmissionSnapshot(saved,'inference')).id,review.id);
    assert.equal(planningInvocationEvidence(saved,review.id).effectsVerified,false);
    await assert.rejects(writer.recordResponse(raw.id,review.id,{output:JSON.stringify(answer(f.calls[0].input)),metadata:{runId:'wrong-purpose',executionNodeId:'inference'}}),{code:'PLANNING_ATTEMPT_PURPOSE'});
    const replay=await writer.settleChildAdmission(raw.id,review.id,{status:'completed',output});
    assert.equal(replay.attempts.find(attempt=>attempt.id===review.id).status,'completed');
    assert.equal(await readFile(file,'utf8'),before);
    const tampered=JSON.parse(before);tampered.attempts.find(attempt=>attempt.id===review.id).childAdmission.judgment.admitted=true;
    await writeFile(file,JSON.stringify(tampered));await assert.rejects(reopened.get(raw.id),/data is invalid/);
  }finally{await reopened.close();}
  assert.equal(f.calls.length,1);
});
