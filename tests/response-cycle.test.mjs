import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime} from '../lib/planning-browser-runtime.mjs';
import {ResponseCycleService,executionProjection} from '../lib/response-cycle.mjs';
import {responseCycleTemplate,responseCycleStage,responseCycleResponseSchema,parseResponseCycleResponse} from '../public/response-cycle-model.mjs';
import {fixtureUserAgency} from './fixture-user-agency.mjs';

const retired={code:'PLANNING_CYCLE_RETIRED',status:410};

async function archiveFixture(t){
  const dir=await mkdtemp(path.join(os.tmpdir(),'response-cycle-archive-'));
  const store=await new PlanningBrowserStore({dataDir:dir}).init();let providerCalls=0,resumeCalls=0;
  const runner=new PlanningBrowserRuntime({store,runtime:{runAgent:async()=>{providerCalls++;throw Error('An archive cannot dispatch a provider.');}},defaultCwd:dir});
  const engine={resumePlannedRun:()=>{resumeCalls++;},resumeViabilityRun:()=>{resumeCalls++;}};
  const service=new ResponseCycleService({store,runner,engine});
  t.after(async()=>{await service.close();await runner.close();await store.close();await rm(dir,{recursive:true,force:true});});
  await store.create({id:'archive',conversationId:'archived-conversation',title:'Saved cycle',objective:'Keep the exact prior outcome.',cwd:dir});
  await store.addNode('archive',{id:'saved-stage',kind:'inference',title:'Saved inference'});
  await store.addSource('archive',{title:'Recorded outcome',text:'The prior operation has an unknown outcome. Do not repeat it.'});
  const writer=store.runtimeWriter(),started=await writer.beginAttempt('archive','saved-stage',{ownerId:'saved-owner',expectedNodeRevision:1,clientRequestId:'prior-attempt'});
  await writer.fail('archive',started.attempt.id,{message:'Original incomplete result.',partialOutput:'Saved partial finding.',validation:{code:'SAVED_FORMAT_FAILURE',message:'Original structured output was incomplete.',issues:[]}});
  const raw=JSON.parse(await readFile(store.file('archive'),'utf8'));
  raw.responseCycle={version:1,rootCycleId:'saved-cycle',cycles:[],actionReceipts:[{id:'saved-action',runId:'saved-run',outcome:'unknown'}]};
  store._validate(raw);await writeFile(store.file('archive'),JSON.stringify(raw));
  return{dir,store,runner,service,started,calls:()=>({providerCalls,resumeCalls})};
}

test('new cycle preparation, adoption, continuation and review entry points retire before dispatch',async t=>{
  const f=await archiveFixture(t),before=await readFile(f.store.file('archive'),'utf8');
  const value={expectedRequestRevision:1,expectedCycleRevision:1,expectedPlanRevision:1,expectedPlanResponseId:'saved-plan',clientRequestId:'stale-call',planningExecutionMode:'automatic'};
  const methods=[
    ['createCycle',['archive',{...value,title:'Replacement',purpose:'Replace the old cycle.'}]],
    ['createCurrent',['archive',value]],
    ['runCycle',['archive','saved-cycle',value]],
    ['drive',['archive','saved-cycle',{through:'respond'}]],
    ['runStage',['archive','saved-cycle','inference',{}]],
    ['ensureChildAdmission',[{},'inference']],
    ['editPlan',['archive','saved-cycle',{...value,plan:{values:{}}}]],
    ['continueCycle',['archive','saved-cycle',value]],
    ['answerQuestion',['archive',{nodeId:'saved-stage',answer:'New answer'}]],
    ['forRun',[{id:'saved-run',planningMode:'on',planningExecutionMode:'automatic'}]]
  ];
  for(const [method,args]of methods)await t.test(method,async()=>{await assert.rejects(async()=>f.service[method](...args),retired);assert.equal(await readFile(f.store.file('archive'),'utf8'),before);});
  assert.deepEqual(f.calls(),{providerCalls:0,resumeCalls:0});assert.equal(f.runner.status().activeCount,0);
});

test('archived attempts, captured evidence and uncertain action receipts survive rejected retries and reopen',async t=>{
  const f=await archiveFixture(t),before=await readFile(f.store.file('archive'),'utf8');
  const saved=await f.store.get('archive');
  assert.equal(saved.attempts[0].partialOutput,'Saved partial finding.');
  assert.equal(saved.attempts[0].validation.code,'SAVED_FORMAT_FAILURE');
  assert.equal(saved.responseCycle.actionReceipts[0].outcome,'unknown');
  for(let i=0;i<2;i++){
    await assert.rejects(f.runner.start({requestId:'archive',nodeId:'saved-stage',expectedNodeRevision:1,clientRequestId:'fresh-'+i}),retired);
    await assert.rejects(f.store.updateNode('archive','saved-stage',{title:'Unlock archive'},{expectedNodeRevision:1}),retired);
  }
  const reopened=await new PlanningBrowserStore({dataDir:f.dir}).init();
  try{const after=await reopened.get('archive');assert.deepEqual(after,saved);assert.equal(after.sources.find(source=>source.title==='Recorded outcome').text,'The prior operation has an unknown outcome. Do not repeat it.');}
  finally{await reopened.close();}
  assert.equal(await readFile(f.store.file('archive'),'utf8'),before);assert.deepEqual(f.calls(),{providerCalls:0,resumeCalls:0});
});

test('retired Plan-only intent cannot be hidden by automatic arguments or a cancelled signal',async t=>{
  const f=await archiveFixture(t),controller=new AbortController();controller.abort();
  for(const mode of ['automatic','plan_only'])for(const signal of [undefined,controller.signal]){
    const run={id:'old-run',planningMode:'on',planningExecutionMode:'automatic',workflow:{settings:{planningExecutionMode:mode}}};
    const before=structuredClone(run);
    await assert.rejects(f.service.forRun(run,{signal}),retired);
    await assert.rejects(async()=>f.service.runCycle('archive','saved-cycle',{planningExecutionMode:'automatic'},{signal}),retired);
    assert.deepEqual(run,before);
  }
  assert.deepEqual(f.calls(),{providerCalls:0,resumeCalls:0});
});

test('delivery context stays within the existing bounded execution projection and identifies truncation',()=>{
  const candidate='A'.repeat(80000),original='User request '.repeat(3000);
  const result=executionProjection({id:'delivery-bound',input:original},'cycle-bound',[
    {nodeId:'one',title:'One',status:'completed',output:'One result.'},
    {nodeId:'two',title:'Two',status:'completed',output:'Two result.'}
  ],{output:candidate});
  assert.equal(result.limited,false);
  const body=JSON.parse(result.records[0].text),delivery=body.projection.userDelivery;
  assert.equal(delivery.candidateAnswer.length,candidate.length);assert.equal(delivery.candidateAnswer.truncated,true);
  assert.equal(delivery.objective.length,original.length);assert.equal(delivery.objective.truncated,true);
  assert.deepEqual(delivery.candidateSourceNodeIds,['one','two']);
  assert.ok(result.records.reduce((sum,item)=>sum+item.text.length,0)<=body.projection.maxContextChars);
});

test('execution excerpts reserve exact proof space while retaining every receipt identity and explicit omissions',()=>{
  const run={id:'budget-fixture',input:'Requested fixture outcome'},outputs=[{nodeId:'agent',title:'Worker',status:'completed',output:'Observed fixture outcome.',toolReceipts:bulkyReceipts()}];
  const original=executionProjection(run,'cycle',outputs),reservedContextChars=32000;
  assert.equal(original.limited,false);assert.ok(original.records.reduce((sum,source)=>sum+source.text.length,0)+reservedContextChars>240000,'Fixture must reproduce the combined-budget failure.');
  const reduced=executionProjection(run,'cycle',outputs,{reservedContextChars});
  assert.equal(reduced.limited,false);assert.ok(reduced.records.reduce((sum,source)=>sum+source.text.length,0)+reservedContextChars<=240000);
  assert.deepEqual(recordIdentities(reduced.records),recordIdentities(original.records),'Hashes, statuses, provenance tables and observation references stay exact.');
  const before=projectionBodies(original.records),after=projectionBodies(reduced.records),header=after.find(body=>body.projection).projection;
  assert.equal(header.reservedContextChars,reservedContextChars);assert.equal(header.projectionBudgetChars,208000);
  assert.ok(header.projectedTextChars<before.find(body=>body.projection).projection.projectedTextChars);
  const texts=after.flatMap(body=>body.texts||[]);assert.ok(texts.some(text=>text.truncated&&text.ranges.reduce((sum,range)=>sum+range.text.length,0)<text.length));
  assert.deepEqual(texts.map(text=>[text.id,text.length]),before.flatMap(body=>body.texts||[]).map(text=>[text.id,text.length]));
  assert.throws(()=>executionProjection(run,'cycle',outputs,{reservedContextChars:-1}),{code:'RESPONSE_CYCLE_CONTEXT_BUDGET'});
  assert.equal(executionProjection(run,'cycle',outputs,{reservedContextChars:240000}).limited,true,'Essential metadata still fails closed when no room exists.');
});
const bulkyReceipts=()=>Array.from({length:300},(_,index)=>({nodeId:'agent',at:'2026-11-02T00:00:00.000Z',data:{
  type:'tool.result',callId:'call-'+index,tool:'relay_workbench',action:'guest_job',success:true,status:'completed',
  stdout:'Observation '+index+' '+('fixture-result-'+index+' ').repeat(700)}}));
const projectionBodies=records=>records.filter(source=>source.id.includes(':projection:')).map(source=>JSON.parse(source.text));
const recordIdentities=records=>projectionBodies(records).flatMap(body=>body.calls||[]);

const archivedHostCriterion=JSON.parse(await readFile(new URL('./fixtures/planning-host-control-accuracy.json',import.meta.url),'utf8'));
for(const accuracy of [null,archivedHostCriterion.accuracy])test('archived Plan parser retains '+(accuracy?'valid accuracy metadata':'nullable accuracy')+' without treating criteria as effect receipts',()=>{
  const row={...structuredClone(archivedHostCriterion),accuracy:structuredClone(accuracy)};
  const template=responseCycleTemplate('plan',{pipelineVersion:2}),stage=responseCycleStage('plan',{pipelineVersion:2}),sourceId='saved-evidence';
  const body={
    userAgency:fixtureUserAgency(),
    values:Object.fromEntries(template.fields.map(field=>[field.id,'Preserve the bounded historical finding and its explicit limitations.'])),
    grounding:template.fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId})),
    openQuestions:[],challengeResponses:[],subproblems:[],childResults:[],
    checks:stage.checks.map(check=>({id:check.id,assessment:'supported',sourceIds:check.grounding==='required'?[sourceId]:[],note:'The saved plan records its intended checks, not completed effects.'})),
    acceptanceCriteria:[{id:'installed',label:'Installation observed',description:'Observe the installed version in the configured guest.',verification:'effect',accuracy:null},row],
    steps:[{id:'verify',label:'Verify the recorded outcome',description:'Compare saved observation with the declared criteria.',dependsOn:[],criterionIds:['installed',row.id],sourceIds:[sourceId]}]
  };
  const schema=responseCycleResponseSchema('plan',{pipelineVersion:2}),required=schema.properties.acceptanceCriteria.items.required;
  for(const item of body.acceptanceCriteria)assert.deepEqual(Object.keys(item).sort(),[...required].sort());
  const parsed=parseResponseCycleResponse(JSON.stringify(body),'plan',{pipelineVersion:2});
  const expected=structuredClone(row);if(accuracy===null)delete expected.accuracy;
  assert.deepEqual(parsed.acceptanceCriteria.find(item=>item.id===row.id),expected);
  assert.deepEqual(body.acceptanceCriteria.at(-1).accuracy,accuracy,'Parsing must not rewrite the saved input or invent accuracy metadata.');
  if(accuracy)assert.deepEqual(parsed.acceptanceCriteria.find(item=>item.id===row.id),archivedHostCriterion);
  assert.equal(parsed.effectReceipts,undefined,'A parsed criterion cannot invent an observed effect receipt.');
});
