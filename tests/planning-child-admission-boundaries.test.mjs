import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime} from '../lib/planning-browser-runtime.mjs';
import {profile,cases,child,answer,judgment} from './fixture-child-admission.mjs';
import {responseCycleTemplate} from '../public/response-cycle-model.mjs';
import {childAdmissionSnapshot,childAdmissionReview,childAdmissionSchema,parseChildAdmission,assertChildAdmission} from '../lib/planning-child-admission.mjs';
import {projectPlanningBrowserExecution} from '../lib/planning-browser-http.mjs';
function snapshotFor(row=cases[0]){
  const source={id:'fixture-source',kind:'source',title:'Retained synthetic inputs',text:'Stipulated receipt: delivered. Fictional capacities: four and six.'};
  const input={module:{kind:'inference'},template:responseCycleTemplate('inference'),sources:[source]};
  const body=answer(input);body.subproblems=[child(input,row)];
  const request={id:'fixture',objective:'Complete the delegated synthetic task.',nodes:[{id:'inference',kind:'inference',prompt:'Analyze the retained inputs.',revision:1}],
    sources:[source],responses:[{id:'response-one',nodeId:'inference',kind:'inference',revision:1,nodeRevision:1,...body}],attempts:[],edges:[]};
  return {request,snapshot:childAdmissionSnapshot(request,'inference'),body,input};
}

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('current module cancellation has exact request activity and preserves its earlier accepted response',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'planning-child-boundaries-')),store=await new PlanningBrowserStore({dataDir:dir}).init(),started=deferred();
  let calls=0;
  const runner=new PlanningBrowserRuntime({store,defaultCwd:dir,getSettings:()=>({maxSubagents:2}),runtime:{runAgent:async options=>{
    calls++;started.resolve();await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(Error('Synthetic cancellation.'),{code:'ABORT_ERR'})),{once:true}));
  }}});
  t.after(async()=>{await runner.close();await store.close();await rm(dir,{recursive:true,force:true});});
  let request=await store.create({id:'current',conversationId:'current-chat',title:'Current module',objective:'Analyze retained evidence.'});
  request=await store.addNode(request.id,{id:'inference',kind:'inference',title:'Current inference'});
  const input={module:{kind:'inference'},template:responseCycleTemplate('inference'),sources:[{id:'request:'+request.id}]};
  request=await store.recordHumanResponse(request.id,'inference',answer(input),{expectedNodeRevision:1});
  const before=structuredClone(request.responses),claim=await runner.start({requestId:request.id,nodeId:'inference',expectedNodeRevision:request.nodes[0].revision,...profile,clientRequestId:'explicit-module'});
  await started.promise;
  const status=runner.status(),active=projectPlanningBrowserExecution(await store.get(request.id),status);
  assert.equal(status.activeCount,1);assert.equal(status.attempts[0].requestId,request.id);assert.equal(active.execution.running,1);
  const unrelated=projectPlanningBrowserExecution({id:'unrelated',nodes:[],attempts:[],summary:{running:0}},status);
  assert.equal(unrelated.execution.running,0);assert.equal(unrelated.execution.state,'idle');
  await runner.cancelRequest({requestId:request.id,nodeId:'inference',attemptId:claim.attempt.id,clientRequestId:'cancel-current'});
  await runner.wait(request.id,claim.attempt.id);
  const saved=await store.get(request.id);assert.equal(saved.attempts[0].status,'cancelled');
  assert.equal(runner.status().activeCount,0);assert.deepEqual(saved.responses,before);assert.equal(calls,1);
});

test('changed parent scope, captured source or response invalidates a saved judgment projection',()=>{
  for(const change of ['scope','source','response']){
    const {request,snapshot}=snapshotFor(cases[5]),value=parseChildAdmission(JSON.stringify(judgment(snapshot)),snapshot);
    request.attempts=[{id:'review',purpose:'child_admission',status:'completed',childAdmission:{snapshot,judgment:value}}];
    assert.doesNotThrow(()=>assertChildAdmission(request,'inference'));
    if(change==='scope')request.nodes[0].prompt='A materially different question.';
    if(change==='source')request.sources[0].text='Stipulated capacities are now ten and twenty.';
    if(change==='response')request.responses[0].values.interpretation='The newer response changes the finding.';
    assert.throws(()=>assertChildAdmission(request,'inference'),{code:'PLANNING_CHILD_ADMISSION_REQUIRED'},change);
    assert.equal(childAdmissionReview(request,childAdmissionSnapshot(request,'inference')),null);
  }
});

test('manual unbound children remain outside automatic admission snapshots',()=>{
  const {request,snapshot}=snapshotFor(cases[5]),before=structuredClone(snapshot);
  request.cycles=[{id:'manual-child',parentStageId:'inference',title:'Manual bounded question'}];
  assert.deepEqual(childAdmissionSnapshot(request,'inference'),before);
  const bound={...request.cycles[0],id:'saved-bound-child',key:'historical-obligation',required:true,request:{...snapshot.requests[0],key:'historical-obligation'}};
  request.cycles.push(bound);
  assert.equal(childAdmissionSnapshot(request,'inference').requests.length,2,'A saved required obligation cannot disappear from archive projections.');
});

test('invalid duplicate judgments, invented paths and source identities cannot become admission',()=>{
  const {snapshot}=snapshotFor(cases[5]),value=judgment(snapshot);
  assert.throws(()=>parseChildAdmission(JSON.stringify(value).replace('"classification":"captured_analysis"','"classification":"requires_effect","classification":"captured_analysis"'),snapshot),/duplicate JSON/);
  const wrong=structuredClone(value);wrong.findings[0].paths=['response.invented'];
  assert.throws(()=>parseChildAdmission(JSON.stringify(wrong),snapshot),/paths/);
  for(const sourceIds of [['unobserved-source'],[snapshot.sources[0].id,snapshot.sources[0].id]]){
    const forged=structuredClone(value);forged.findings[0].sourceIds=sourceIds;
    assert.throws(()=>parseChildAdmission(JSON.stringify(forged),snapshot),/sources/);
  }
});

test('a zero-child refinement schema retains its original captured inputs and outcome obligation',()=>{
  const {snapshot}=snapshotFor(),replacement={...snapshot,requests:[],retainedObligations:{requests:snapshot.requests}};
  const schema=childAdmissionSchema(replacement);
  assert.ok(replacement.sources.length>0);assert.equal(schema.properties.findings.maxItems,0);
  assert.equal(schema.properties.findings.items.properties.key.enum,undefined);
  assert.equal(parseChildAdmission(JSON.stringify(judgment(replacement,{retained:'not_preserved'})),replacement).admitted,false);
  assert.equal(parseChildAdmission(JSON.stringify(judgment(replacement,{retained:'preserved'})),replacement).admitted,true);
});

test('review paths name only own JSON data fields, never prototypes or array implementation properties',()=>{
  const {snapshot}=snapshotFor();
  for(const path of ['response.constructor','response.subproblems[0].toString','response.subproblems.length','response.subproblems[999]','response.values[0]']){
    const output=judgment(snapshot,{classification:'requires_effect'});output.findings[0].paths=[path];
    assert.throws(()=>parseChildAdmission(JSON.stringify(output),snapshot),{code:'PLANNING_CHILD_ADMISSION_INVALID'},path);
    const retained={...snapshot,retainedObligations:{requests:snapshot.requests}},replacement=judgment(retained);replacement.retainedOutcome.paths=[path];
    assert.throws(()=>parseChildAdmission(JSON.stringify(replacement),retained),{code:'PLANNING_CHILD_ADMISSION_INVALID'},path);
  }
  const valid=judgment(snapshot,{classification:'requires_effect'});valid.findings[0].paths=['response.subproblems[0].acceptanceCriteria[0].accuracy.evidenceNeeded'];
  assert.doesNotThrow(()=>parseChildAdmission(JSON.stringify(valid),snapshot));
});
