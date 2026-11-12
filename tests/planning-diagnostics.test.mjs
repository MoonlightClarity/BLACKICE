import {fixtureUserAgency} from './fixture-user-agency.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime} from '../lib/planning-browser-runtime.mjs';
import {ResponseCycleService} from '../lib/response-cycle.mjs';
import {PlanningDiagnostics,PlanningDiagnosticStore,diagnosticLimits,diagnosticHash} from '../lib/planning-diagnostics.mjs';
import {handlePlanningDiagnosticsHttp} from '../lib/planning-diagnostics-api.mjs';
import {planningModuleTemplate} from '../public/planning-browser-model.mjs';
import {responseCycleStage,parseResponseCycleResponse,workflowChildHandoffReady} from '../public/response-cycle-model.mjs';

const profile={model:'fixture-explicit',effort:'none',serviceTier:'default'};
const limits={maxProviderTurns:12,maxCycles:1,maxDepth:0,maxPassesPerStage:2};
const retired={code:'PLANNING_CYCLE_RETIRED',status:410};

async function fixture(t,{state='failed',reservation=state!=='captured'}={}){
  const dir=await mkdtemp(path.join(os.tmpdir(),'planning-diagnostic-archive-')),store=await new PlanningBrowserStore({dataDir:dir}).init(),calls=[];
  const runner=new PlanningBrowserRuntime({store,defaultCwd:dir,getSettings:()=>({maxSubagents:2}),runtime:{runAgent:async options=>{calls.push(options);throw Error('Archived diagnostics must never call a provider.');}}});
  const cycles=new ResponseCycleService({store,runner}),service=new PlanningDiagnostics({store,cycles,runner,readRun:async()=>{throw Error('Archived diagnostics must not rediscover a native run.');}});
  t.after(async()=>{await service.close();await runner.close();await cycles.close();await store.close();await rm(dir,{recursive:true,force:true});});
  let request=await store.create({id:'diagnostic-archive',conversationId:'diagnostic-archive',title:'Historical diagnostic',objective:'Explain the captured synthetic records.',cwd:dir});
  request=await store.addNode(request.id,{id:'frame',kind:'frame',title:'Captured question'});
  request=await store.addSource(request.id,{title:'Historical attachment record',text:'The measured fixture value is 7. No fresh observation is implied.'});
  const fields=planningModuleTemplate('frame').fields;
  const body={values:Object.fromEntries(fields.map(field=>[field.id,'A bounded historical finding from the retained record.'])),
    grounding:fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId:'request:'+request.id})),openQuestions:[],challengeResponses:[]};
  request=await store.recordHumanResponse(request.id,'frame',body,{expectedNodeRevision:1});
  const claim=await store.runtimeWriter().beginAttempt(request.id,'frame',{expectedNodeRevision:request.nodes[0].revision,ownerId:'historical-owner',...profile,clientRequestId:'historical-attempt'});
  await store.runtimeWriter().fail(request.id,claim.attempt.id,{message:'Saved malformed response.',partialOutput:'{',validation:{code:'FIXTURE_INVALID',message:'Saved malformed response.',issues:[]}});
  // Seed a historical on-disk record, never invoke the retired capture/drive path.
  const raw=JSON.parse(await readFile(store.file(request.id),'utf8'));
  if(state==='captured'){raw.responses=[];raw.attempts=[];}
  raw.responseCycle={version:1,rootCycleId:'historical-cycle',limits,cycles:[]};
  const capture={version:1,sourceRequestId:'native-archive',sourceCycleId:'native-cycle',sourceRequestRevision:4,
    objective:raw.objective,cwd:raw.cwd,limits,profile,nodeDefinitions:raw.nodes.map(({id,parentId,kind,title,prompt})=>({id,parentId,kind,title,prompt})),
    sourceRecords:structuredClone(raw.sources),sourceMapping:raw.sources.map(source=>({sourceId:source.id,diagnosticSourceId:source.id,sourceHash:diagnosticHash(source),diagnosticSourceHash:diagnosticHash(source)})),
    scope:'native_canonical_authoring_snapshot',physicalRequestCeiling:null};
  raw.diagnostic={version:1,capture,captureHash:diagnosticHash(capture),state,budgetUnit:'logical_model_invocations',physicalRequestCeiling:null,
    reservations:reservation?[{key:'attempt:'+claim.attempt.id,kind:'module',nodeId:'frame',attemptId:claim.attempt.id,ordinal:1,reservedAt:raw.updatedAt,consumption:'reserved_may_have_dispatched'}]:[]};
  if(state==='running')raw.diagnostic.run={id:'historical-run',clientRequestId:'historical-start',ownerPid:process.pid,startedAt:raw.updatedAt};
  store._validate(raw);await writeFile(store.file(request.id),JSON.stringify(raw));
  return {dir,store,runner,cycles,service,calls,raw,attemptId:claim.attempt.id,id:request.id};
}

test('retired capture and diagnostic execution reject before provider, native run lookup or file mutation',async t=>{
  const f=await fixture(t),before=await readFile(f.store.file(f.id),'utf8'),writer=f.store.runtimeWriter();
  for(const operation of [
    ()=>f.service.capture({sourceRequestId:f.id,sourceCycleId:'historical-cycle',expectedSourceRevision:f.raw.revision,clientRequestId:'new-capture',limits,profile}),
    ()=>f.service.run(f.id,{expectedRevision:f.raw.revision,captureHash:f.raw.diagnostic.captureHash,clientRequestId:'new-run'}),
    ()=>writer.captureDiagnostic({sourceRequestId:f.id,sourceCycleId:'historical-cycle'}),
    ()=>writer.beginDiagnostic(f.id,{expectedRevision:f.raw.revision,captureHash:f.raw.diagnostic.captureHash,clientRequestId:'old-start'}),
    ()=>f.cycles.runCycle(f.id,'historical-cycle',{}),
    ()=>f.cycles.continueCycle(f.id,'historical-cycle',{}),
    ()=>f.cycles.editPlan(f.id,'historical-cycle',{})
  ])await assert.rejects(async()=>operation(),retired);
  assert.equal(f.calls.length,0);assert.equal(f.runner.status().activeCount,0);
  assert.equal(await readFile(f.store.file(f.id),'utf8'),before);
});

test('historical diagnostic findings, exact sources and consumed reservations remain readable across reopen',async t=>{
  for(const state of ['captured','completed','limited','failed','cancelled','interrupted','running'])await t.test(state,async t=>{
    const f=await fixture(t,{state}),before=await readFile(f.store.file(f.id),'utf8'),saved=await f.service.read(f.id);
    assert.equal(saved.diagnostic.state,state);assert.deepEqual(saved.responses,f.raw.responses);
    assert.deepEqual(saved.diagnostic.reservations,f.raw.diagnostic.reservations);assert.equal(saved.diagnostic.reservations.length,state==='captured'?0:1);
    assert.deepEqual(saved.sources.filter(source=>f.raw.sources.some(old=>old.id===source.id)),f.raw.sources);
    assert.equal(saved.diagnostic.physicalRequestCeiling,null);assert.equal(saved.diagnostic.budgetUnit,'logical_model_invocations');
    const reopened=await new PlanningBrowserStore({dataDir:f.dir}).init();
    try{assert.deepEqual((await reopened.runtimeWriter().readDiagnostic(f.id)).diagnostic,saved.diagnostic);}finally{await reopened.close();}
    assert.equal(await readFile(f.store.file(f.id),'utf8'),before);assert.equal(f.calls.length,0);
  });
});

test('archived diagnostics reject ordinary edits, review, direct module admission and format repair without consuming calls',async t=>{
  const f=await fixture(t),before=await readFile(f.store.file(f.id),'utf8'),writer=f.store.runtimeWriter();
  for(const operation of [
    ()=>f.store.addSource(f.id,{title:'Fresh evidence',text:'New unobserved evidence'}),
    ()=>f.store.updateNode(f.id,'frame',{prompt:'Changed capture'},{expectedNodeRevision:1}),
    ()=>f.store.recordHumanResponse(f.id,'frame',{},{expectedNodeRevision:1}),
    ()=>writer.beginAttempt(f.id,'frame',{expectedNodeRevision:1,ownerId:'guessed-owner',...profile,diagnosticCapability:{}}),
    ()=>writer.beginChildAdmission(f.id,'frame',{ownerId:'guessed-owner',...profile,diagnosticCapability:{}}),
    ()=>writer.beginRepairAttempt(f.id,f.attemptId),
    ()=>f.runner.start({requestId:f.id,nodeId:'frame',expectedNodeRevision:1,...profile,clientRequestId:'ordinary',diagnosticCapability:{}})
  ])await assert.rejects(async()=>operation(),retired);
  await assert.rejects(writer.reserveProviderTurn(f.id,{kind:'module',key:'attempt:'+f.attemptId,nodeId:'frame',attemptId:f.attemptId,capability:{}}),{code:'PLANNING_DIAGNOSTIC_ADMISSION'});
  assert.equal(f.calls.length,0);assert.equal(await readFile(f.store.file(f.id),'utf8'),before);
});

test('archive integrity validation rejects changed captures, sources, definitions, profiles and reservations',async t=>{
  const f=await fixture(t),validator=new PlanningDiagnosticStore(f.store);
  for(const mutate of [
    raw=>raw.diagnostic.capture.objective='Changed without rehashing',
    raw=>raw.sources[0].text='A rewritten source',
    raw=>raw.nodes[0].title='A rewritten module',
    raw=>raw.attempts[0].model='a-different-model',
    raw=>raw.diagnostic.reservations.push({...raw.diagnostic.reservations[0],ordinal:2}),
    raw=>raw.responseCycle.linkedRunId='executable-run'
  ]){
    const changed=structuredClone(f.raw);mutate(changed);
    assert.throws(()=>validator.validate(changed));
  }
  assert.equal(diagnosticHash({a:1,b:{c:2,d:3}}),diagnosticHash({b:{d:3,c:2},a:1}));
  assert.equal(f.calls.length,0);
});

test('historical diagnostic settlement preserves consumed reservations and never replays uncertain work',async t=>{
  const f=await fixture(t,{state:'running'}),raw=structuredClone(f.raw);
  raw.diagnostic.run.ownerPid=2147483647;raw.attempts[0].status='running';delete raw.attempts[0].finishedAt;
  await writeFile(f.store.file(f.id),JSON.stringify(raw));
  const recovered=await f.service.read(f.id);
  assert.equal(recovered.diagnostic.state,'interrupted');assert.equal(recovered.attempts[0].status,'failed');
  assert.deepEqual(recovered.diagnostic.reservations,raw.diagnostic.reservations);
  assert.match(recovered.diagnostic.reason,/no work was replayed/);assert.equal(f.calls.length,0);
  const before=await readFile(f.store.file(f.id),'utf8');
  await f.service.cancel(f.id);await f.service.read(f.id);
  assert.equal(await readFile(f.store.file(f.id),'utf8'),before);
});

test('explicit diagnostic limits cannot imply a physical request guarantee',()=>{
  assert.throws(()=>diagnosticLimits(undefined));assert.throws(()=>diagnosticLimits({...limits,maxProviderTurns:160}));assert.throws(()=>diagnosticLimits({...limits,maxPhysicalRequests:12}));
  assert.deepEqual(diagnosticLimits(limits),limits);
});

test('developer HTTP retains read/cancel but retires capture/run before parsing execution arguments',async t=>{
  const f=await fixture(t,{state:'captured',reservation:false}),responses=[],json=(_res,status,body)=>responses.push({status,body});
  let bodyReads=0;
  for(const route of ['/api/planning-diagnostics/capture','/api/planning-diagnostics/'+f.id+'/run']){
    await assert.rejects(handlePlanningDiagnosticsHttp({req:{method:'POST'},res:{},pathname:route,service:f.service,body:async()=>{bodyReads++;return {linkedRunId:'forbidden'};},json}),retired);
  }
  assert.equal(bodyReads,0);assert.equal(responses.length,0);
  await handlePlanningDiagnosticsHttp({req:{method:'GET'},res:{},pathname:'/api/planning-diagnostics/'+f.id,service:f.service,json});
  assert.equal(responses[0].status,200);assert.equal(responses[0].body.diagnostic.state,'captured');
  const mutations=new Set();
  await assert.rejects(handlePlanningDiagnosticsHttp({req:{method:'POST'},res:{},pathname:'/api/planning-diagnostics/'+f.id+'/cancel',service:f.service,body:async()=>({run:true}),json}),{code:'PLANNING_DIAGNOSTIC_ARGUMENT'});
  await handlePlanningDiagnosticsHttp({req:{method:'POST'},res:{},pathname:'/api/planning-diagnostics/'+f.id+'/cancel',service:f.service,body:async()=>({}),json,fileMutations:mutations});
  assert.equal(responses.at(-1).body.diagnostic.state,'cancelled');assert.equal(responses.at(-1).body.diagnostic.reservations.length,0);
  assert.equal(mutations.size,0);assert.equal(f.calls.length,0);
});

test('real server routes diagnostics through the existing session and same-origin guards',async t=>{
  const {createHarnessServer}=await import('../server.mjs'),{EventEmitter}=await import('node:events');
  const dir=await mkdtemp(path.join(os.tmpdir(),'diagnostic-http-'));let invocations=0;
  class FakeRuntime extends EventEmitter {status(){return {connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',model:'fixture'}],activeTurns:0};}async start(){return this.status();}async runAgent(){invocations++;throw Error('No model invocation is allowed in the HTTP authorization test.');}async close(){}}
  const app=await createHarnessServer({runtime:new FakeRuntime(),port:0,dataDir:dir,defaultCwd:dir}),url=await app.listen();
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const base=new URL(url).origin,home=await fetch(base+'/'),cookie=home.headers.get('set-cookie').split(';')[0];
  const send=(route,headers)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({linkedRunId:'forbidden'})});
  for(const route of ['/api/planning-diagnostics/capture','/api/planning-diagnostics/archive/run']){
    assert.equal((await send(route,{})).status,401);
    assert.equal((await send(route,{cookie,origin:'https://different.example'})).status,403);
    const authenticated=await send(route,{cookie,origin:base});
    assert.equal(authenticated.status,410);assert.equal((await authenticated.json()).code,'PLANNING_CYCLE_RETIRED');
  }
  assert.equal(invocations,0);assert.equal(app.engine.listRuns().length,0);
});

test('an unlinked analytical child cannot accidentally satisfy workflow handoff ownership',()=>{
  const criterion={id:'answer'},child={state:'completed',analysisReady:true,workflowHandoff:null};
  assert.equal(workflowChildHandoffReady(child,{}),false);
  assert.equal(workflowChildHandoffReady({...child,workflowHandoff:{criteria:[criterion]}},{}),false);
  assert.equal(workflowChildHandoffReady({...child,workflowHandoff:{ownerCycleId:'owner',criteria:[criterion]}},{workflowOwner:{cycleId:'owner'},requiredAcceptanceCriteria:[criterion]}),true);
});

test('historical diagnostic Plan parsing preserves native authoring semantics and exact source binding',()=>{
  const source={id:'cycle:execution-contract:captured',kind:'source',contentHash:'a'.repeat(64),text:JSON.stringify({
    taskSchemaVersion:14,contractVersion:2,currentContract:null,workflow:{coordinatorNodeId:null,agents:[{id:'agent',label:'Fixture agent'}]}
  })},sources=[source],stage=responseCycleStage('plan',{pipelineVersion:2}),template=planningModuleTemplate('plan',{pipelineVersion:2});
  const body={userAgency:fixtureUserAgency(),values:Object.fromEntries(template.fields.map(field=>[field.id,'A bounded explanation of the retained synthetic record.'])),
    grounding:template.fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId:source.id})),openQuestions:[],challengeResponses:[],
    checks:stage.checks.map(check=>({id:check.id,assessment:check.when==='effects'?'not_applicable':'supported',sourceIds:check.grounding==='required'&&check.when!=='effects'?[source.id]:[],note:'The captured source supports this bounded assessment.'})),subproblems:[],childResults:[],
    contract:{contractVersion:2,goal:'Explain the captured synthetic record.',criteria:[{id:'answer',kind:'judgment',description:'A supported explanation of the synthetic record.',resourceKey:'workspace:fixture',targetCount:1}],
      workItems:[{id:'explain',title:'Explain the record',objective:'Assess the captured record and state its limits.',owner:'agent',resourceKeys:['workspace:fixture'],effects:['observe'],dependsOn:[],criterionIds:['answer']}],instructions:[]}};
  const diagnosticAuthoring={version:1,sourceId:source.id,sourceHash:source.contentHash},options={sources,pipelineVersion:2,cycleContext:{diagnostic:true,diagnosticAuthoring}};
  const diagnostic=parseResponseCycleResponse(body,'plan',options),native=parseResponseCycleResponse(body,'plan',{sources,pipelineVersion:2,cycleContext:{workflowOwner:{cycleId:'native',runId:'native-run'}}});
  assert.deepEqual(diagnostic,native);
  const before=structuredClone(body);
  for(const binding of [undefined,{...diagnosticAuthoring,version:2},{...diagnosticAuthoring,sourceId:'other'},{...diagnosticAuthoring,sourceHash:'0'.repeat(64)}])
    assert.throws(()=>parseResponseCycleResponse(body,'plan',{...options,cycleContext:{diagnostic:true,diagnosticAuthoring:binding}}),/binding is missing or changed/);
  assert.deepEqual(body,before);
});
