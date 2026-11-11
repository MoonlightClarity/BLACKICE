import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime} from '../lib/planning-browser-runtime.mjs';
import {ResponseCycleService} from '../lib/response-cycle.mjs';
import {PlanningDiagnostics,diagnosticLimits,diagnosticHash} from '../lib/planning-diagnostics.mjs';
import {handlePlanningDiagnosticsHttp} from '../lib/planning-diagnostics-api.mjs';
import {responseCycleStage,parseResponseCycleResponse,workflowChildHandoffReady} from '../public/response-cycle-model.mjs';
import {fixtureUserAgency} from './fixture-user-agency.mjs';
import {judgment} from './fixture-child-admission.mjs';

const profile={model:'fixture-explicit',effort:'none',serviceTier:'default'};
const limits={maxProviderTurns:12,maxCycles:1,maxDepth:0,maxPassesPerStage:2};
const captured=options=>JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n')+2));
const contract=()=>({contractVersion:2,goal:'Explain the captured synthetic records.',criteria:[{id:'answer',kind:'judgment',description:'A supported explanation of the synthetic record.',resourceKey:'workspace:fixture',targetCount:1}],workItems:[{id:'explain',title:'Explain the record',objective:'Assess the captured record and state its limits.',owner:'agent',resourceKeys:['workspace:fixture'],effects:['observe'],dependsOn:[],criterionIds:['answer']}],instructions:[]});
function response(input){
  const stage=responseCycleStage(input.module.kind,{pipelineVersion:2}),sourceId=input.sources.find(source=>source.id==='viability:task')?.id||input.sources[0].id;
  const body={userAgency:fixtureUserAgency(),values:Object.fromEntries(input.template.fields.map(field=>[field.id,field.label+': a bounded synthetic finding based on the captured record.'])),grounding:input.template.fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId})),openQuestions:[],challengeResponses:[]};
  if(stage.id==='feasibility')return {...body,requirements:[]};
  Object.assign(body,{checks:stage.checks.map(check=>({id:check.id,assessment:check.when==='effects'?'not_applicable':'supported',sourceIds:check.grounding==='required'&&check.when!=='effects'?[sourceId]:[],note:'The captured synthetic source supports this bounded assessment.'})),subproblems:[],childResults:[]});
  if(stage.id==='inference')body.inferences=[{id:'finding',claim:'The supplied record supports a bounded explanation.',basis:'inferred',sourceIds:[sourceId],limitation:'Synthetic historical evidence only.'}];
  if(stage.id==='plan')body.contract=contract();
  return body;
}
async function fixture(t,{amend,provider,attachments=false}={}){
  const dir=await mkdtemp(path.join(os.tmpdir(),'planning-diagnostic-')),store=await new PlanningBrowserStore({dataDir:dir}).init(),calls=[],settings={defaultModel:'do-not-inherit',defaultEffort:'high',defaultContext:16384,runTimeoutMs:5000,maxSubagents:2};
  const runtime={runAgent:async options=>{const input=captured(options);calls.push({input,options});if(provider)return provider(options,input,calls);if(input.reviewType==='planning_child_admission')return {output:JSON.stringify(judgment(input.snapshot)),threadId:'fixture-review'};const body=response(input);return {output:JSON.stringify(amend?await amend(body,input,calls)||body:body),threadId:'fixture-thread',turnId:'fixture-turn-'+calls.length};}};
  const runner=new PlanningBrowserRuntime({store,runtime,getSettings:()=>settings,defaultCwd:dir});
  const engine=new Proxy({}, {get:(_target,key)=>{throw Error('Unexpected Engine access: '+String(key));}});
  const cycles=new ResponseCycleService({store,runner,engine,getSettings:()=>settings});
  const original=await store.create({id:'native-source',conversationId:'native-run',title:'Synthetic native goal',objective:'Explain the supplied synthetic record.',cwd:dir},{actor:{type:'human',id:'fixture-user'}});
  let request=await cycles.createCycle(original.id,{title:'Synthetic native cycle',purpose:original.objective,planningExecutionMode:'plan_only',expectedRequestRevision:original.revision,clientRequestId:'native-cycle'});
  const cycleId=request.cycles[0].id;
  const workflow={id:'fixture-workflow',nodes:[{id:'agent',type:'agent',model:profile.model,effort:profile.effort}],edges:[],settings:{planningMode:'on'}};
  const authoring={taskSchemaVersion:14,contractVersion:2,workspaceResourceKey:'workspace:fixture',initialOwner:'coordinator',currentContract:null,workflow:{coordinatorNodeId:null,agents:[{id:'agent',label:'Fixture agent'}]},...(attachments?{attachmentScope:{tool:'relay_files',effect:'observe',resourceKey:'attachment-set:fixture',files:[{id:'attached-record',name:'Synthetic record',sha256:'a'.repeat(64),resourceKey:'attachment:'+'a'.repeat(64)}]}}:{})};
  request=await store.runtimeWriter().configureResponseCycle(original.id,{cyclePatch:{id:cycleId,linkedRunId:'native-run',execution:{required:true,state:'failed',runId:'native-run'},executionProfile:profile},rootPatch:{linkedRunId:'native-run'},sources:[{id:'cycle:execution-contract:'+cycleId,kind:'source',title:'Host canonical authoring capture',text:JSON.stringify(authoring)}]});
  request=await store.runtimeWriter().configureViability(original.id,{viability:{scope:'request',scopeId:'native-run',nodeId:request.cycles[0].stageNodeIds.feasibility,fingerprint:'a'.repeat(64),workflowNodeIds:['agent']},sources:[{id:'viability:task',kind:'user_input',title:'Original synthetic task',text:'Explain the supplied synthetic record.'},{id:'viability:profile',kind:'source',title:'Synthetic supplied record',text:'The measured fixture value is 7. No external observation is implied.'}]});
  const run={id:'native-run',input:original.objective,cwd:dir,workflow,attachmentIds:attachments?['attached-record']:[],planningContractVersion:14,responseCycle:{requestId:request.id,cycleId,planRef:{requestId:request.id,cycleId,nodeId:request.cycles[0].stageNodeIds.plan,nodeRevision:1,responseId:null}}};
  let runReads=0;
  const service=new PlanningDiagnostics({store,cycles,runner,getSettings:()=>settings,readRun:async id=>{assert.equal(id,run.id);runReads++;return structuredClone(run);}});
  t.after(async()=>{await service.close();await runner.close();await cycles.close();await store.close();await rm(dir,{recursive:true,force:true});});
  const capture=extra=>service.capture({sourceRequestId:request.id,sourceCycleId:cycleId,expectedSourceRevision:request.revision,clientRequestId:'capture-fixture',limits,profile,...extra});
  return {dir,store,runner,cycles,service,request,run,capture,calls,settings,get runReads(){return runReads;}};
}
const controls=(request,id='run-fixture')=>({expectedRevision:request.revision,captureHash:request.diagnostic.captureHash,clientRequestId:id});

test('capture is immutable, exact, historical, unlinked and inert',async t=>{
  const f=await fixture(t,{attachments:true}),before=await readFile(f.store.file(f.request.id),'utf8'),run=JSON.stringify(f.run),d=await f.capture();
  assert.equal(f.calls.length,0);assert.equal(d.responses.length,0);assert.equal(d.attempts.length,0);assert.equal(d.conversationId,d.id);
  assert.equal(d.cycles[0].linkedRunId,undefined);assert.equal(d.cycles[0].execution.required,false);assert.equal(d.viability.pendingIntent,undefined);
  assert.equal(d.diagnostic.physicalRequestCeiling,null);assert.equal(d.diagnostic.budgetUnit,'logical_model_invocations');
  for(const mapping of d.diagnostic.capture.sourceMapping){const a=f.request.sources.find(s=>s.id===mapping.sourceId),b=d.sources.find(s=>s.id===mapping.diagnosticSourceId);assert.equal(a.text,b.text);assert.deepEqual(a.provenance,b.provenance);assert.equal(mapping.sourceHash,mapping.diagnosticSourceHash);}
  assert.equal(await readFile(f.store.file(f.request.id),'utf8'),before);assert.equal(JSON.stringify(f.run),run);
  const replay=await f.capture();assert.equal(replay.id,d.id);assert.equal(replay.revision,d.revision);
  await assert.rejects(f.store.addSource(d.id,{title:'Change',text:'Changed evidence'}),{code:'PLANNING_DIAGNOSTIC_IMMUTABLE'});
  const node=d.nodes.find(n=>n.kind==='inference');
  await assert.rejects(f.runner.start({requestId:d.id,nodeId:node.id,expectedNodeRevision:node.revision,clientRequestId:'ordinary',diagnosticCapability:{}}),{code:'PLANNING_DIAGNOSTIC_ADMISSION'});
  assert.equal(f.calls.length,0);
});

test('same real stage pipeline validates canonical authoring without execution ownership or publication',async t=>{
  const f=await fixture(t),before=await readFile(f.store.file(f.request.id),'utf8'),d=await f.capture();f.settings.defaultModel='changed-default';f.settings.defaultContext=999999;f.settings.runTimeoutMs=1;
  const reserveTimes=[],save=f.store._save.bind(f.store);f.store._save=async(...args)=>{const start=performance.now();try{return await save(...args);}finally{if(args[2]==='diagnosticReserve')reserveTimes.push(performance.now()-start);}};
  const result=await f.service.run(d.id,controls(d));assert.equal(result.diagnostic.state,'completed',result.diagnostic.reason);
  assert.equal(reserveTimes.length,3);t.diagnostic('Durable reservation overhead (synthetic Windows run, ms): '+JSON.stringify(reserveTimes.map(value=>Math.round(value*100)/100)));
  assert.deepEqual(f.calls.map(call=>call.input.module.kind),['inference','viability','plan']);
  assert.equal(result.diagnostic.reservations.length,3);
  for(const {input,options}of f.calls){assert.equal(options.model,profile.model);assert.equal(options.context,16384);assert.equal(options.timeoutMs,5000);assert.equal(input.cycle.workflowOwner,null);assert.equal(options.responseOnly,true);assert.deepEqual(options.dynamicTools,[]);assert.equal(options.sandbox,'read-only');}
  const plan=result.nodes.find(node=>node.kind==='plan');assert.equal(plan.response.contract.contractVersion,2);assert.equal(plan.readiness.cycle.analysisReady,true);assert.equal(plan.readiness.cycle.dispatchReady,false);
  assert.deepEqual(plan.response.inputs.map(input=>input.nodeId).sort(),result.nodes.filter(node=>['inference','viability'].includes(node.kind)).map(node=>node.id).sort());
  assert.equal(await readFile(f.store.file(f.request.id),'utf8'),before);assert.equal(f.runReads,1);
  assert.equal((await f.service.run(d.id,controls(d))).diagnostic.state,'completed');assert.equal(f.calls.length,3);
});

test('shared lifetime cap includes format repair and does not claim completion when exhausted',async t=>{
  const f=await fixture(t,{provider:async(options,input,calls)=>({output:calls.length===1?'{':JSON.stringify(response(input)),threadId:'fixture',turnId:'t'+calls.length})});
  const d=await f.capture({limits:{...limits,maxProviderTurns:2}}),result=await f.service.run(d.id,controls(d));
  assert.equal(result.diagnostic.state,'limited');assert.equal(f.calls.length,2);assert.equal(result.diagnostic.reservations.length,2);assert.equal(result.attempts.length,2);assert.ok(result.attempts[0].repairAttemptId);
  await assert.rejects(f.service.run(d.id,controls(result,'new-id')),{code:'PLANNING_DIAGNOSTIC_SETTLED'});assert.equal(f.calls.length,2);
});

test('reservations are durable, serialized, nonrefundable and never authorize replay',async t=>{
  const f=await fixture(t),d=await f.capture({limits:{...limits,maxProviderTurns:1}}),writer=f.store.runtimeWriter(),claim=await writer.beginDiagnostic(d.id,controls(d));
  const node=claim.request.nodes.find(item=>item.kind==='inference'),attempt=await writer.beginAttempt(d.id,node.id,{expectedNodeRevision:node.revision,ownerId:'fixture-owner',model:profile.model,effort:profile.effort,serviceTier:profile.serviceTier,diagnosticCapability:claim.capability});
  const value={kind:'module',key:'attempt:'+attempt.attempt.id,nodeId:node.id,attemptId:attempt.attempt.id,capability:claim.capability};
  const reservations=await Promise.all([writer.reserveProviderTurn(d.id,value),writer.reserveProviderTurn(d.id,value)]);assert.equal(reservations.filter(r=>r.created).length,1);assert.deepEqual(reservations.map(r=>r.ordinal),[1,1]);
  await assert.rejects(writer.reserveProviderTurn(d.id,{...value,key:'different'}),{code:'PLANNING_DIAGNOSTIC_ADMISSION'});
  const other=await new PlanningBrowserStore({dataDir:f.dir}).init();t.after(()=>other.close());
  await assert.rejects(other.runtimeWriter().reserveProviderTurn(d.id,value),{code:'PLANNING_DIAGNOSTIC_ADMISSION'});
  assert.equal((await other.runtimeWriter().readDiagnostic(d.id)).diagnostic.state,'running','a second store cannot steal a live host operation');
  const crashed=JSON.parse(await readFile(f.store.file(d.id),'utf8'));crashed.diagnostic.run.ownerPid=2147483647;await writeFile(f.store.file(d.id),JSON.stringify(crashed));
  const recovered=await other.runtimeWriter().readDiagnostic(d.id);assert.equal(recovered.diagnostic.state,'interrupted');assert.equal(recovered.diagnostic.reservations.length,1);assert.equal(recovered.attempts[0].status,'failed');assert.equal(f.calls.length,0);
});

test('cancel aborts owned response-only work and retains its consumed reservation',async t=>{
  let started;const ready=new Promise(resolve=>started=resolve);
  const f=await fixture(t,{provider:async(options)=>{started();await new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});}});
  const d=await f.capture(),running=f.service.run(d.id,controls(d));await ready;
  const node=(await f.store.get(d.id)).nodes.find(item=>item.kind==='plan');
  await assert.rejects(f.runner.start({requestId:d.id,nodeId:node.id,expectedNodeRevision:node.revision,clientRequestId:'guess',diagnosticCapability:{}}),{code:'PLANNING_DIAGNOSTIC_ADMISSION'});
  const cancelled=await f.service.cancel(d.id);await running;assert.equal(cancelled.diagnostic.state,'cancelled');assert.equal(cancelled.diagnostic.reservations.length,1);assert.equal(f.calls.length,1);assert.equal(f.runner.status().activeCount,0);
});

test('all ordinary cycle execution and adoption entrances reject diagnostics',async t=>{
  const f=await fixture(t),d=await f.capture(),cycle=d.cycles[0],value={expectedRequestRevision:d.revision,expectedCycleRevision:1,clientRequestId:'denied'};
  await assert.rejects(f.cycles.createCycle(d.id,{...value,title:'Other',purpose:'Other',planningExecutionMode:'plan_only'}),{code:'PLANNING_DIAGNOSTIC_NO_EXECUTION'});
  await assert.rejects(f.cycles.runCycle(d.id,cycle.id,{...value,planningExecutionMode:'plan_only'}),{code:'PLANNING_DIAGNOSTIC_NO_EXECUTION'});
  await assert.rejects(f.cycles.continueCycle(d.id,cycle.id,value),{code:'PLANNING_DIAGNOSTIC_NO_EXECUTION'});
  await assert.rejects(f.cycles.answerQuestion(d.id,{clientRequestId:'answer'}),{code:'PLANNING_DIAGNOSTIC_NO_EXECUTION'});
  await assert.rejects(f.cycles.publishLinkedRun(d,cycle.id),{code:'PLANNING_DIAGNOSTIC_NO_EXECUTION'});
  await assert.rejects(f.cycles.getExecutionPlan({responseCycle:{requestId:d.id,planRef:{cycleId:cycle.id}}}),{code:'PLANNING_DIAGNOSTIC_NO_EXECUTION'});
  assert.equal(f.calls.length,0);
});

test('manifest tampering and missing native canonical bindings fail closed',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.capture({expectedSourceRevision:1}),{code:'PLANNING_DIAGNOSTIC_CONFLICT'});
  const d=await f.capture(),file=f.store.file(d.id),raw=JSON.parse(await readFile(file,'utf8'));raw.sources[0].text+=' altered';await writeFile(file,JSON.stringify(raw));
  await assert.rejects(f.service.read(d.id),{code:'PLANNING_BROWSER_DAMAGED'});
});

test('explicit diagnostic limits cannot imply a physical request guarantee',()=>{
  assert.throws(()=>diagnosticLimits(undefined));assert.throws(()=>diagnosticLimits({...limits,maxProviderTurns:160}));assert.throws(()=>diagnosticLimits({...limits,maxPhysicalRequests:12}));
  assert.deepEqual(diagnosticLimits(limits),limits);
});

test('developer HTTP capture/run/read/cancel route rejects undeclared execution knobs',async t=>{
  const f=await fixture(t),responses=[],json=(_res,status,body)=>responses.push({status,body});
  const value={sourceRequestId:f.request.id,sourceCycleId:f.request.cycles[0].id,expectedSourceRevision:f.request.revision,clientRequestId:'http-capture',limits,profile};
  assert.equal(await handlePlanningDiagnosticsHttp({req:{method:'POST'},res:{},pathname:'/api/planning-diagnostics/capture',service:f.service,body:async()=>value,json,fileMutations:new Set()}),true);
  const d=responses[0].body;assert.equal(responses[0].status,201);assert.equal(f.calls.length,0);
  await assert.rejects(handlePlanningDiagnosticsHttp({req:{method:'POST'},res:{},pathname:'/api/planning-diagnostics/'+d.id+'/run',service:f.service,body:async()=>({...controls(d),linkedRunId:'native-run'}),json}),{code:'PLANNING_DIAGNOSTIC_ARGUMENT'});
  await handlePlanningDiagnosticsHttp({req:{method:'POST'},res:{},pathname:'/api/planning-diagnostics/'+d.id+'/cancel',service:f.service,body:async()=>({}),json});
  assert.equal(responses.at(-1).body.diagnostic.state,'cancelled');assert.equal(f.calls.length,0);
});

test('required analytical children stop at the declared diagnostic scope without being dropped',async t=>{
  const f=await fixture(t,{amend:(body,input)=>{if(input.module.kind==='inference')body.subproblems=[{key:'bounded-check',title:'Check the captured premise',objective:'Evaluate one premise from the synthetic source.',reason:'The answer depends on this premise.',required:true,executionTarget:'analysis',sourceIds:['viability:profile'],acceptanceCriteria:[{id:'premise',label:'Premise assessment',description:'State whether the supplied premise supports the explanation.',verification:'response'}]}];return body;}}),d=await f.capture(),result=await f.service.run(d.id,controls(d));
  assert.equal(result.diagnostic.state,'limited');assert.match(result.diagnostic.reason,/recursive work limit/);assert.equal(result.cycles.length,1);assert.equal(f.calls.length,2);assert.deepEqual(result.diagnostic.reservations.map(row=>row.kind),['module','child_admission']);
  const inference=result.nodes.find(node=>node.kind==='inference');assert.equal(inference.response.subproblems[0].required,true);assert.equal(inference.readiness.cycle.state,'budget_exceeded');assert.equal(result.nodes.find(node=>node.kind==='plan').response,null);
});

test('lifetime stage passes cannot reset through direct module admission',async t=>{
  const f=await fixture(t),d=await f.capture(),writer=f.store.runtimeWriter(),claim=await writer.beginDiagnostic(d.id,controls(d)),node=claim.request.nodes.find(item=>item.kind==='inference');
  const options={expectedNodeRevision:node.revision,ownerId:'pass-owner',...profile,diagnosticCapability:claim.capability};
  for(let pass=0;pass<2;pass++){const attempt=await writer.beginAttempt(d.id,node.id,{...options,clientRequestId:'pass-'+pass});await writer.fail(d.id,attempt.attempt.id,{message:'Synthetic failed generation.'});}
  await assert.rejects(writer.beginAttempt(d.id,node.id,{...options,clientRequestId:'pass-3'}),{code:'PLANNING_DIAGNOSTIC_BUDGET'});
  assert.equal((await f.store.get(d.id)).attempts.length,2);assert.equal(f.calls.length,0);
  await writer.finishDiagnostic(d.id,{state:'cancelled',capability:claim.capability,reason:'Synthetic admission-only test settled.'});
});

test('diagnostic Plan validation matches native canonical authoring and never accepts a forged binding',async t=>{
  const f=await fixture(t),d=await f.capture();await f.service.run(d.id,controls(d));const input=f.calls.find(call=>call.input.module.kind==='plan').input,body=response(input);
  const options={sources:input.sources,pipelineVersion:2,cycleContext:input.cycle};
  const diagnostic=parseResponseCycleResponse(body,'plan',options),native=parseResponseCycleResponse(body,'plan',{...options,cycleContext:{...input.cycle,diagnostic:undefined,diagnosticAuthoring:undefined,workflowOwner:{cycleId:'native',runId:'native-run'}}});
  assert.deepEqual(diagnostic,native);
  await assert.rejects(f.capture({clientRequestId:'alias',profile:{...profile,model:'codex'}}),/Pin an explicit/);
  assert.throws(()=>parseResponseCycleResponse(body,'plan',{...options,cycleContext:{...input.cycle,diagnosticAuthoring:{...input.cycle.diagnosticAuthoring,sourceHash:'0'.repeat(64)}}}),/binding is missing or changed/);
});

test('real server routes diagnostics through the existing session and same-origin guards',async t=>{
  const {createHarnessServer}=await import('../server.mjs'),{EventEmitter}=await import('node:events');
  const dir=await mkdtemp(path.join(os.tmpdir(),'diagnostic-http-'));let invocations=0;
  class FakeRuntime extends EventEmitter {status(){return {connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',model:'fixture'}],activeTurns:0};}async start(){return this.status();}async runAgent(){invocations++;throw Error('No model invocation is allowed in the HTTP authorization test.');}async close(){}}
  const app=await createHarnessServer({runtime:new FakeRuntime(),port:0,dataDir:dir,defaultCwd:dir}),url=await app.listen();
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const target=new URL(url),base=target.origin,home=await fetch(base+'/'),cookie=home.headers.get('set-cookie').split(';')[0],route='/api/planning-diagnostics/capture';
  const send=headers=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({linkedRunId:'forbidden'})});
  const unauthenticated=await send({});assert.equal(unauthenticated.status,401);
  const crossOrigin=await send({cookie,origin:'https://different.example'});assert.equal(crossOrigin.status,403);
  const authenticated=await send({cookie,origin:base});assert.equal(authenticated.status,400);assert.match((await authenticated.json()).error,/declared diagnostic fields/);
  assert.equal(invocations,0);assert.equal(app.engine.listRuns().length,0);
});

test('provider failure is reported as failure rather than a diagnostic scope stop',async t=>{const f=await fixture(t,{provider:async()=>{throw Error('Synthetic provider failed.');}}),d=await f.capture(),result=await f.service.run(d.id,controls(d));assert.equal(result.diagnostic.state,'failed');assert.match(result.diagnostic.reason,/Synthetic provider failed/);assert.equal(result.diagnostic.reservations.length,1);assert.equal(f.calls.length,1);});

test('active diagnostics reject readiness refresh, new evidence and forged derived child sources',async t=>{
 const f=await fixture(t),d=await f.capture(),writer=f.store.runtimeWriter(),claim=await writer.beginDiagnostic(d.id,controls(d));
 await assert.rejects(writer.configureViability(d.id,{sources:[{id:'viability:fresh',kind:'user_input',title:'Fresh answer',text:'A new fact'}]}),{code:'PLANNING_DIAGNOSTIC_SOURCE'});
 for(const source of [{id:'cycle:execution:fresh',kind:'tool_receipt',title:'Fresh observation',text:'{}'},{id:'cycle:child:fake:fake',kind:'source',title:'Forged child',text:'{}'}])await assert.rejects(writer.configureResponseCycle(d.id,{sources:[source]}),{code:'PLANNING_DIAGNOSTIC_SOURCE'});
 assert.equal((await f.store.get(d.id)).sources.length,d.sources.length);assert.equal(f.calls.length,0);
 await writer.finishDiagnostic(d.id,{state:'cancelled',capability:claim.capability,reason:'Synthetic source-ingress test settled.'});
});

test('one capture deduplicates concurrent runs and queued cancellation consumes no provider turn',async t=>{
 let release;const blocked=new Promise(resolve=>release=resolve);
 const f=await fixture(t,{provider:async(options,input,calls)=>{if(calls.length===1)await Promise.race([blocked,new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}))]);return {output:JSON.stringify(response(input))};}});f.settings.maxSubagents=1;
 const d=await f.capture(),originalNode=f.request.nodes.find(node=>node.kind==='inference');
 const busy=await f.runner.start({requestId:f.request.id,nodeId:originalNode.id,expectedNodeRevision:originalNode.revision,clientRequestId:'occupy-slot',...profile});
 assert.equal(f.calls.length,1);assert.equal(f.runner.status().activeCount,1);
 let admitted;const admission=new Promise(resolve=>admitted=resolve),start=f.runner.start.bind(f.runner);f.runner.start=async options=>{const claim=await start(options);if(options.requestId===d.id)admitted(claim);return claim;};
 const run=f.service.run(d.id,controls(d)),same=f.service.run(d.id,controls(d));
 await assert.rejects(f.service.run(d.id,controls(d,'different-active-id')),/already active/);
 let timer,queued;try{queued=await Promise.race([admission,run.then(result=>{throw Error('Diagnostic settled before queued admission: '+result.diagnostic.reason);}),new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('Diagnostic queued admission exceeded its 4s fixture ceiling.')),4000);})]);}finally{clearTimeout(timer);}
 assert.equal(queued.attempt.workerStatus,'queued');assert.equal((await f.store.get(d.id)).attempts.length,1);assert.equal(f.runner.status().attempts.find(attempt=>attempt.requestId===d.id).status,'queued');
 const cancelled=await f.service.cancel(d.id);assert.equal(cancelled.diagnostic.state,'cancelled');assert.equal(cancelled.diagnostic.reservations.length,0);
 assert.equal((await run).diagnostic.state,'cancelled');assert.equal((await same).diagnostic.state,'cancelled');assert.equal(f.calls.length,1);
 release();await f.runner.wait(f.request.id,busy.attempt.id);
});

const proposedChild=()=>({key:'requested-work',title:'Check the requested record',objective:'Inspect the supplied record and retain the requested task outcome.',reason:'The requested outcome depends on this finding.',required:true,executionTarget:'analysis',sourceIds:['viability:profile'],acceptanceCriteria:[{id:'answer',label:'Requested finding',description:'A supported explanation of the synthetic record.',verification:'response'}]});

test('semantic review, refinement and format repair consume one shared durable diagnostic ceiling',async t=>{
 const f=await fixture(t,{provider:async(options,input,calls)=>{
   if(input.reviewType==='planning_child_admission')return {output:JSON.stringify(judgment(input.snapshot,{classification:'requires_effect',retained:'preserved'}))};
   if(calls.length===3)return {output:'{'};
   const body=response(input);if(input.module.kind==='inference')body.subproblems=[{...proposedChild(),...(calls.length>=4?{executionTarget:'workflow'}:{})}];return {output:JSON.stringify(body)};
 }}),d=await f.capture({limits:{...limits,maxProviderTurns:4}}),result=await f.service.run(d.id,controls(d));
 assert.equal(result.diagnostic.state,'limited',result.diagnostic.reason);assert.equal(f.calls.length,4);assert.equal(result.diagnostic.reservations.length,4);
 assert.deepEqual(result.diagnostic.reservations.map(row=>row.kind),['module','child_admission','module','module']);
 const refinement=result.attempts.find(attempt=>attempt.semanticRefinement&&!attempt.repairOf),repair=result.attempts.find(attempt=>attempt.repairOf);
 assert.ok(refinement);assert.ok(repair);assert.equal(repair.repairOf,refinement.id);assert.deepEqual(repair.semanticRefinement,refinement.semanticRefinement);
 assert.equal(result.cycles.length,1);assert.equal(result.nodes.find(node=>node.kind==='viability').response,null);
 await assert.rejects(f.service.run(d.id,controls(result,'renew-cap')),{code:'PLANNING_DIAGNOSTIC_SETTLED'});assert.equal(f.calls.length,4);
});

test('cancelling a diagnostic reviewer preserves both charged calls and accepted module history',async t=>{
 let started;const ready=new Promise(resolve=>started=resolve);
 const f=await fixture(t,{provider:async(options,input)=>{
   if(input.reviewType==='planning_child_admission'){started();await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}
   const body=response(input);body.subproblems=[proposedChild()];return {output:JSON.stringify(body)};
 }}),d=await f.capture(),running=f.service.run(d.id,controls(d));await ready;
 const before=await f.store.get(d.id),accepted=before.responses[0].id,cancelled=await f.service.cancel(d.id);await running;
 assert.equal(cancelled.diagnostic.state,'cancelled');assert.equal(cancelled.responses[0].id,accepted);assert.equal(cancelled.diagnostic.reservations.length,2);
 assert.equal(cancelled.attempts.find(attempt=>attempt.purpose==='child_admission').status,'cancelled');assert.equal(cancelled.cycles.length,1);assert.equal(f.calls.length,2);
});

test('guessed diagnostic identities cannot admit a reviewer or automatic child',async t=>{
 const f=await fixture(t),d=await f.capture(),writer=f.store.runtimeWriter(),node=d.nodes.find(item=>item.kind==='inference');
 await assert.rejects(writer.beginChildAdmission(d.id,node.id,{ownerId:'guessed',binding:'0'.repeat(64),...profile,diagnosticCapability:{}}),{code:'PLANNING_DIAGNOSTIC_ADMISSION'});
 await assert.rejects(f.cycles.createCurrent(d.id,{title:'Guessed child',purpose:'A smaller question',clientRequestId:'guessed',parentNodeId:node.id},{internal:true,diagnosticCapability:{}}),{code:'PLANNING_DIAGNOSTIC_ADMISSION'});
 assert.equal((await f.store.get(d.id)).attempts.length,0);assert.equal(f.calls.length,0);
});

for(const failChild of [false,true])test(failChild?'a valid root Plan cannot hide a required diagnostic child failure':'allowed analytical recursion uses only captured sources and exact derived child findings',async t=>{
 const f=await fixture(t,{provider:async(options,input)=>{
   if(input.reviewType==='planning_child_admission')return {output:JSON.stringify(judgment(input.snapshot))};
   if(failChild&&input.cycle.recursion.depth>0)throw Error('Synthetic required child failure.');
   const body=response(input),sourceId=input.sources[0].id,criteria=input.cycle.requiredAcceptanceCriteria?.length?input.cycle.requiredAcceptanceCriteria:input.cycle.acceptanceCriteria?.length?input.cycle.acceptanceCriteria:proposedChild().acceptanceCriteria;
   if(input.module.kind==='inference'&&input.cycle.recursion.depth===0)body.subproblems=[proposedChild()];
   if(body.childResults)body.childResults=(input.cycle.children||[]).filter(child=>['completed','failed','cancelled'].includes(child.state)).map(child=>({key:child.key,sourceId:child.sourceId,summary:'A bounded finding from the captured record.',usedFor:'Resolve the requested premise.'}));
   if(input.module.kind==='plan'&&!input.sources.some(source=>source.id.startsWith('cycle:execution-contract:'))){delete body.contract;body.acceptanceCriteria=criteria;body.steps=[{id:'explain',label:'Explain the premise',description:'Assess only the captured premise.',dependsOn:[],criterionIds:criteria.map(item=>item.id),sourceIds:[sourceId]}];}
   if(input.module.kind==='think')body.criterionResults=criteria.map(item=>({criterionId:item.id,assessment:'satisfied',sourceIds:[sourceId],receiptIds:[],rationale:'The captured synthetic record supports this finding.'}));
   if(input.module.kind==='respond')body.coverage=criteria.map(item=>({criterionId:item.id,disposition:'addressed',sourceIds:[sourceId],responseExcerpt:body.values.answer,limitation:''}));
   return {output:JSON.stringify(body)};
 }}),d=await f.capture({limits:{...limits,maxCycles:2,maxDepth:1}});const result=await f.service.run(d.id,controls(d));
 if(failChild){assert.equal(result.diagnostic.state,'failed');assert.match(result.diagnostic.reason,/Synthetic required child failure/);assert.ok(result.nodes.find(node=>node.id===result.cycles[0].stageNodeIds.plan).response?.contract);return;}
 assert.equal(result.diagnostic.state,'completed',JSON.stringify({reason:result.diagnostic.reason,cycles:result.cycles.map(c=>({state:c.state,summary:c.summary})),attempts:result.attempts.map(a=>({status:a.status,message:a.message}))}));
 assert.equal(result.cycles.length,2);assert.equal(result.cycles.find(c=>c.parentCycleId).state,'completed',JSON.stringify({child:result.cycles.find(c=>c.parentCycleId),attempts:result.attempts.map(a=>({nodeId:a.nodeId,status:a.status,message:a.message}))}));
 assert.ok(result.cycles.every(c=>c.planningExecutionMode==='plan_only'&&c.execution.required===false&&!c.linkedRunId));
 assert.ok(result.sources.some(source=>source.id.startsWith('cycle:child:')));assert.equal(result.diagnostic.reservations.length,f.calls.length);assert.ok(f.calls.length<=12);
});

test('an unlinked analytical child cannot accidentally satisfy workflow handoff ownership',()=>{const criterion={id:'answer'},child={state:'completed',analysisReady:true,workflowHandoff:null};assert.equal(workflowChildHandoffReady(child,{}),false);assert.equal(workflowChildHandoffReady({...child,workflowHandoff:{criteria:[criterion]}},{}),false);assert.equal(workflowChildHandoffReady({...child,workflowHandoff:{ownerCycleId:'owner',criteria:[criterion]}},{workflowOwner:{cycleId:'owner'},requiredAcceptanceCriteria:[criterion]}),true);});
