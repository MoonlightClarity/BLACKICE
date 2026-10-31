import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime} from '../lib/planning-browser-runtime.mjs';
import {TaskViability} from '../lib/task-viability.mjs';
import {ResponseCycleService} from '../lib/response-cycle.mjs';
import {RESPONSE_CYCLE_STAGES} from '../public/response-cycle-model.mjs';
import {planningResponseBody} from '../public/planning-browser-model.mjs';

const criterion={id:'answer',label:'Requested answer',description:'Provide a supported answer to the bounded question.',verification:'response'};
const workflow=()=>({id:'fixture',name:'Fixture workflow',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',name:'Fixture worker',model:'fixture-fast',effort:'low',prompt:'Complete the task.'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{planningMode:'on'}});
const captured=options=>JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n')+2));
function response(input){
  const stage=RESPONSE_CYCLE_STAGES.find(stage=>stage.kind===input.module.kind),sourceId=input.sources.find(source=>source.id==='viability:task')?.id||input.sources[0].id;
  const body={values:Object.fromEntries(input.template.fields.map(field=>[field.id,field.label+': a bounded public finding from the fixture evidence.'])),grounding:input.template.fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId})),openQuestions:[],challengeResponses:[]};
  if(stage.id==='feasibility')return {...body,requirements:[]};
  Object.assign(body,{checks:stage.checks.map(check=>({id:check.id,assessment:check.when==='effects'?'not_applicable':'supported',sourceIds:check.grounding==='required'&&check.when!=='effects'?[sourceId]:[],note:'Fixture observation supports this bounded check.'})),subproblems:[],childResults:(input.cycle?.children||[]).filter(child=>['completed','failed','cancelled'].includes(child.state)).map(child=>({key:child.key,sourceId:child.sourceId,summary:'The child supplied a bounded result.',usedFor:'Resolve the named subproblem.'}))});
  if(stage.id==='inference')body.inferences=[{id:'finding',claim:'The captured question has a bounded answer.',basis:'inferred',sourceIds:[sourceId],limitation:'This is a synthetic fixture.'}];
  const criteria=input.cycle?.requiredAcceptanceCriteria?.length?input.cycle.requiredAcceptanceCriteria:input.cycle?.acceptanceCriteria?.length?input.cycle.acceptanceCriteria:[criterion];
  if(stage.id==='plan')Object.assign(body,{acceptanceCriteria:criteria,steps:[{id:'answer-step',label:'Develop and check the answer',description:'Use the supplied evidence to answer and verify the question.',dependsOn:[],criterionIds:criteria.map(item=>item.id),sourceIds:[sourceId]}]});
  if(stage.id==='think')body.criterionResults=criteria.map(item=>({criterionId:item.id,assessment:'satisfied',sourceIds:[sourceId],receiptIds:[],rationale:'The synthetic result addresses the defined criterion.'}));
  if(stage.id==='respond'){body.values.answer='The bounded answer is supported by the recorded fixture results.';body.coverage=criteria.map(item=>({criterionId:item.id,disposition:'addressed',sourceIds:[sourceId],responseExcerpt:body.values.answer,limitation:''}));}
  return body;
}
async function fixture(t,{amend}={}){
  const dir=await mkdtemp(path.join(os.tmpdir(),'response-cycle-')),store=await new PlanningBrowserStore({dataDir:dir}).init(),calls=[],runs=new Map(),admitted=new Map();let uncertain=false,profile='Recorded fixture facts.',identityReads=0;
  const engine={getRun:id=>{if(!runs.has(id))throw Error('missing');return runs.get(id);},clientRequestRunId:id=>admitted.get(id)?.id||null,resumePlannedRun:(id,value)=>{if(!admitted.has(value.requestId))admitted.set(value.requestId,{id:'resumed-'+admitted.size,from:id,planRef:value.planRef});if(uncertain){uncertain=false;throw Error('uncertain fixture delivery');}return admitted.get(value.requestId);},resumeViabilityRun:()=>{throw Error('Plan-only answer must not auto-resume');}};
  const settings={defaultModel:'fixture-fast',defaultEffort:'low',maxSubagents:2};
  const runtime={runAgent:async options=>{const input=captured(options);calls.push({input,options});let body=response(input);if(amend)body=await amend(body,input,calls)||body;return{output:JSON.stringify(body),threadId:'fixture-thread',turnId:'fixture-turn-'+calls.length};}};
  const runner=new PlanningBrowserRuntime({store,runtime,defaultCwd:dir,getSettings:()=>settings}),taskViability=new TaskViability({store,runner,engine,identity:{read:async()=>{identityReads++;return {content:profile};}},getSettings:()=>settings});
  const service=new ResponseCycleService({store,runner,taskViability,engine,getSettings:()=>settings});
  t.after(async()=>{await runner.close();await service.close();await taskViability.close();await store.close();await rm(dir,{recursive:true,force:true});});
  const run=(mode='automatic',id='fixture-run')=>{const value={id,taskId:'fixture-conversation',input:'Explain the supplied bounded problem.',cwd:dir,workflow:workflow(),attachmentIds:[],planningMode:'on',planningExecutionMode:mode};runs.set(id,value);return value;};
  const prepare=async(mode='automatic')=>{const value=run(mode),result=await service.forRun(value);value.viability=result;value.responseCycle={requestId:result.requestId,cycleId:result.cycleId,planRef:result.planRef,state:result.pausedAfterPlan?'paused_after_plan':result.state};return {run:value,result,request:await store.get(result.requestId)};};
  return{dir,store,runner,runtime,settings,service,taskViability,calls,run,prepare,engine,admitted,get identityReads(){return identityReads;},setUncertain:()=>{uncertain=true;},setProfile:value=>{profile=value;}};
}
const controls=(request,cycleId,clientRequestId)=>{const cycle=request.cycles.find(item=>item.id===cycleId),plan=request.nodes.find(node=>node.id===cycle.stageNodeIds.plan);return{expectedRequestRevision:request.revision,expectedCycleRevision:request.nodes.find(node=>node.id===cycleId).revision,expectedPlanRevision:plan.revision,expectedPlanResponseId:plan.response?.id,clientRequestId};};
const runControls=(request,cycleId,clientRequestId)=>({expectedRequestRevision:request.revision,expectedCycleRevision:request.nodes.find(node=>node.id===cycleId).revision,clientRequestId});
async function standalone(f,purpose='Explain a bounded synthetic marker.'){
  const request=await f.store.create({conversationId:'standalone-fixture',title:'Synthetic planning request',objective:purpose,cwd:f.dir});
  const created=await f.service.createCycle(request.id,{title:'Synthetic response cycle',purpose,planningExecutionMode:'plan_only',expectedRequestRevision:request.revision,clientRequestId:'standalone-cycle'});
  return {request:created,cycle:created.cycles[0]};
}

test('real graph runs all five stages across actual execution boundary with typed data intact',async t=>{
  const f=await fixture(t),{run,result,request}=await f.prepare();
  assert.equal(result.skipped,false);assert.equal(result.awaitingInput,undefined);assert.deepEqual(f.calls.map(call=>call.input.module.kind),['viability','inference','plan']);
  const cycle=request.cycles[0],plan=request.nodes.find(node=>node.id===cycle.stageNodeIds.plan);assert.equal(plan.response.steps[0].label,'Develop and check the answer');
  assert.equal(plan.readiness.cycle.analysisReady,true);assert.equal(plan.readiness.cycle.dispatchReady,true);assert.match(request.title,/Explain the supplied/);
  const final=await f.service.finishRun(run,{outputs:[{nodeId:'agent',title:'Fixture worker',status:'completed',output:'Observed fixture result.',toolReceipts:[]}]});
  assert.equal(final.state,'completed');assert.match(final.output,/bounded answer/);assert.deepEqual(f.calls.map(call=>call.input.module.kind),['viability','inference','plan','think','respond']);
  const saved=await f.store.get(request.id),stages=saved.cycles[0].stageNodeIds;
  assert.ok(saved.nodes.find(node=>node.id===stages.think).response.criterionResults.length);assert.ok(saved.nodes.find(node=>node.id===stages.respond).response.coverage.length);
  assert.equal(saved.nodes.find(node=>node.id===stages.plan).readiness.cycle.analysisReady,true,'later execution does not invalidate preparation');
  assert.ok(f.calls[3].input.sources.some(source=>source.id.startsWith('cycle:execution:')));assert.equal(f.calls[2].input.sources.some(source=>source.id.startsWith('cycle:execution:')),false);
});

test('Plan only pauses after three stages; editing is inert and exact continuation recovers uncertain admission',async t=>{
  const f=await fixture(t),{run,result,request}=await f.prepare('plan_only'),cycle=request.cycles[0];
  assert.equal(result.pausedAfterPlan,true);assert.equal(cycle.state,'paused_after_plan');assert.equal(f.calls.length,3);assert.equal(request.viability.pendingIntent,null);
  const plan=request.nodes.find(node=>node.id===cycle.stageNodeIds.plan),body=planningResponseBody(plan.response);body.steps[0].description='Use the edited approach and verify the requested answer.';
  const edited=await f.service.editPlan(request.id,cycle.id,{...controls(request,cycle.id,'edit-plan'),plan:body});
  assert.equal(f.calls.length,3);assert.equal(f.admitted.size,0);assert.equal(edited.cycles[0].state,'paused_after_plan');
  const payload=controls(edited,cycle.id,'continue-plan');f.setUncertain();await assert.rejects(f.service.continueCycle(request.id,cycle.id,payload),/uncertain fixture delivery/);
  const continued=await f.service.continueCycle(request.id,cycle.id,payload);assert.equal(f.admitted.size,1);assert.equal(continued.cycleAction.resumedRunId,'resumed-0');
  const replay=await f.service.continueCycle(request.id,cycle.id,payload);assert.equal(replay.cycleAction.resumedRunId,'resumed-0');assert.equal(f.calls.length,3);assert.equal(f.admitted.values().next().value.planRef.nodeRevision,edited.cycles[0].planRevision);
});

test('changed evidence rejects exact-plan continuation before operational admission',async t=>{
  const f=await fixture(t),{request}=await f.prepare('plan_only'),cycle=request.cycles[0],payload=controls(request,cycle.id,'continue-stale');f.setProfile('The profile changed after the plan was checked.');
  await assert.rejects(f.service.continueCycle(request.id,cycle.id,payload),{code:'RESPONSE_CYCLE_PLAN_CONFLICT'});assert.equal(f.admitted.size,0);assert.equal(f.calls.length,3);
});

test('recursive child gets bounded parent evidence, runs the five stages, and is explicitly aggregated',async t=>{
  const f=await fixture(t,{amend:(body,input)=>{
    if(input.module.kind==='inference'&&input.cycle?.objective==='Explain the supplied bounded problem.'){
      body.subproblems=[{executionTarget:'analysis',key:'check-assumption',title:'Check the pivotal assumption',objective:'Determine whether the supplied premise supports the intended interpretation.',reason:'The interpretation depends on this premise.',required:true,sourceIds:[input.sources.find(source=>source.id==='viability:task').id],acceptanceCriteria:[criterion]}];
    }
    return body;
  }}),{request,result}=await f.prepare('plan_only');
  assert.equal(result.pausedAfterPlan,true);assert.equal(request.cycles.length,2);const child=request.cycles.find(item=>item.parentCycleId);
  assert.equal(child.state,'completed');assert.equal(f.calls.length,9);const parent=request.nodes.find(node=>node.id===child.parentStageId);assert.equal(parent.response.childResults[0].key,'check-assumption');
  const childCalls=f.calls.filter(call=>call.input.cycle?.cycleId===child.id);assert.deepEqual(childCalls.map(call=>call.input.module.kind),['viability','inference','plan','think','respond']);assert.ok(childCalls[0].input.sources.some(source=>source.id==='viability:task'));assert.equal(childCalls[0].input.sources.some(source=>source.id==='viability:profile'),false);
});

test('Plan changes during execution preserve outputs and report a stale result without final response calls',async t=>{
  const f=await fixture(t),{run,request}=await f.prepare(),cycle=request.cycles[0],node=request.nodes.find(item=>item.id===cycle.stageNodeIds.plan);
  await f.store.updateNode(request.id,node.id,{prompt:'A changed operational approach.'},{expectedNodeRevision:node.revision,actor:'fixture'});
  const final=await f.service.finishRun(run,{outputs:[{nodeId:'agent',title:'Worker',status:'completed',output:'Recorded actual output.'}]});assert.equal(final.state,'stale');assert.match(final.output,/Recorded actual output/);assert.match(final.output,/earlier plan/);assert.equal(f.calls.length,3);
});

test('Planning Off creates no graph and cancellation admits no response work',async t=>{
  const f=await fixture(t),run=f.run();run.planningMode='off';assert.equal((await f.service.forRun(run)).skipped,true);assert.equal((await f.store.list()).requests.length,0);
  const controller=new AbortController();controller.abort();run.planningMode='on';await assert.rejects(f.service.forRun(run,{signal:controller.signal}),error=>error.name==='AbortError');assert.equal(f.calls.length,0);
});

test('supervising models edit the same paused typed plan with accurate authorship and no execution',async t=>{
  const f=await fixture(t),{request}=await f.prepare('plan_only'),cycle=request.cycles[0];
  let current=request;
  for(const [actor,receipt,kind]of [
    [{type:'agent',id:'actual-run:actual-node'},null,'supervising_model'],
    [{type:'external-agent',id:'actual-connection'},{jobId:'actual-job',connectionId:'actual-connection',requestId:'actual-action',tool:'blackice_planning_cycle'},'external_agent']
  ]){
    const plan=current.nodes.find(node=>node.id===cycle.stageNodeIds.plan),body=planningResponseBody(plan.response);body.steps[0].description='A refined plan from '+kind;
    current=await f.service.editPlan(current.id,cycle.id,{...controls(current,cycle.id,'edit-'+kind),plan:body},{actor,...(receipt?{receipt}:{})});
    const saved=current.nodes.find(node=>node.id===plan.id);assert.equal(saved.response.provenance.kind,kind);if(receipt)assert.equal(saved.response.provenance.receipt.jobId,receipt.jobId);
  }
  assert.equal(f.calls.length,3);assert.equal(f.admitted.size,0);assert.equal(current.cycles[0].state,'paused_after_plan');
});

test('useful child answer cannot erase an essential unknown before continuation',async t=>{
  const f=await fixture(t,{amend:(body,input)=>{
    if(input.module.kind==='inference'&&input.cycle?.objective==='Explain the supplied bounded problem.')body.subproblems=[{executionTarget:'analysis',key:'unknown-fact',title:'Evaluate an essential fact',objective:'Check the required residential address for the proposed action.',reason:'The later action depends on this fact.',required:true,sourceIds:[input.sources.find(source=>source.id==='viability:task').id],acceptanceCriteria:[criterion]}];
    if(input.module.kind==='viability'&&input.cycle?.objective==='Check the required residential address for the proposed action.'){
      const supplied=input.sources.find(source=>source.id.startsWith('viability:answer:cycle-'));
      body.requirements=[{id:'address',label:'Residential address',importance:'essential',basis:'task',consequence:'Complete the required address field.',resolution:supplied?'observed':'unknown',value:supplied?.text||'',sourceIds:supplied?[supplied.id]:[],checkedSourceIds:input.sources.filter(source=>source.kind!=='response').map(source=>source.id),rationale:supplied?'The user supplied the requested fact.':'The captured records do not supply the required fact.',inferable:false,omissionAllowed:false,question:supplied?'':'Which residential address should be used?',dependentNodeIds:['agent']}];
    }
    return body;
  }}),{request,result}=await f.prepare('plan_only'),cycle=request.cycles[0],child=request.cycles.find(item=>item.parentCycleId);
  assert.equal(result.pausedAfterPlan,true);assert.equal(child.state,'completed');const childAnswer=request.nodes.find(node=>node.id===child.stageNodeIds.respond);
  assert.equal(childAnswer.readiness.cycle.analysisReady,true);assert.equal(childAnswer.readiness.cycle.dispatchReady,false);
  const plan=request.nodes.find(node=>node.id===cycle.stageNodeIds.plan);assert.equal(plan.readiness.cycle.analysisReady,true);assert.equal(plan.readiness.cycle.dispatchReady,false);
  await assert.rejects(f.service.continueCycle(request.id,cycle.id,controls(request,cycle.id,'hold-essential-child')),{code:'RESPONSE_CYCLE_FACTS_REQUIRED'});assert.equal(f.admitted.size,0);
  const fresh=await f.store.get(request.id),question=fresh.nodes.find(node=>node.id===child.stageNodeIds.feasibility),count=f.calls.length;
  const answer={nodeId:question.id,requirementId:'address',answer:'29 Example Lane',expectedNodeRevision:question.revision,expectedResponseId:question.response.id,clientRequestId:'nested-answer'};
  const answered=await f.service.answerQuestion(request.id,answer);assert.equal(answered.nodes.find(node=>node.id===question.id).readiness.viability.state,'ready');assert.equal(f.calls.length,count+1);assert.equal(f.admitted.size,0);assert.equal(answered.nodes.find(node=>node.id===plan.id).response.id,plan.response.id,'answering preserves the edited plan boundary');
  assert.equal(answered.cycles[0].planningExecutionMode,'plan_only');const replay=await f.service.answerQuestion(request.id,answer);assert.equal(f.calls.length,count+1);assert.equal(replay.cycleAction.state,answered.cycleAction.state);
});

test('source recovery prevents every stage provider from starting',async t=>{
  const f=await fixture(t);f.taskViability.identity={read:async()=>({content:'Incomplete old record.',warning:'The current record cannot be read.'})};
  const {result,request}=await f.prepare();assert.equal(result.state,'needs_evidence');assert.match(result.question,/record|facts/i);assert.equal(f.calls.length,0);assert.equal(request.cycles[0].state,'needs_evidence');
});

test('failed and cancelled work settles graph status without a final provider turn',async t=>{
  const f=await fixture(t),{run,request}=await f.prepare();
  await f.service.settleRun(run,{state:'failed',error:Object.assign(Error('Observed workflow failure.'),{code:'FIXTURE_FAILED'})});
  let saved=await f.store.get(request.id);assert.equal(saved.cycles[0].state,'failed');assert.equal(saved.cycles[0].execution.state,'failed');assert.match(saved.cycles[0].summary,/Observed workflow failure/);assert.equal(f.calls.length,3);
  await f.service.settleRun(run,{state:'cancelled'});saved=await f.store.get(request.id);assert.equal(saved.cycles[0].state,'cancelled');assert.equal(f.calls.length,3);
});

test('automatic nested answer refreshes the existing child before its parent and resumes one intent',async t=>{
  const f=await fixture(t,{amend:(body,input)=>{
    if(input.module.kind==='inference'&&input.cycle?.objective==='Explain the supplied bounded problem.')body.subproblems=[{executionTarget:'analysis',key:'required-fact',title:'Resolve the required fact',objective:'Resolve the required location for this bounded task.',reason:'Later work depends on the location.',required:true,sourceIds:[input.sources.find(source=>source.id==='viability:task').id],acceptanceCriteria:[criterion]}];
    if(input.module.kind==='viability'&&input.cycle?.objective==='Resolve the required location for this bounded task.'){
      const answer=input.sources.find(source=>source.id.startsWith('viability:answer:cycle-'));
      body.requirements=[{id:'location',label:'Required location',importance:'essential',basis:'task',consequence:'Complete the location-specific step.',resolution:answer?'observed':'unknown',value:answer?.text||'',sourceIds:answer?[answer.id]:[],checkedSourceIds:input.sources.filter(source=>source.kind!=='response').map(source=>source.id),rationale:answer?'The user supplied the required location.':'The sources have no required location.',inferable:false,omissionAllowed:false,question:answer?'':'Which location should this use?',dependentNodeIds:['agent']}];
    }return body;
  }}),{request,result}=await f.prepare('automatic');assert.equal(result.state,'waiting_children');assert.equal(result.awaitingInput,true);
  f.engine.resumeViabilityRun=(id,value)=>{if(!f.admitted.has(value.requestId))f.admitted.set(value.requestId,{id:'resumed-'+f.admitted.size,from:id});return f.admitted.get(value.requestId);};
  const child=request.cycles.find(cycle=>cycle.parentCycleId),node=request.nodes.find(node=>node.id===child.stageNodeIds.feasibility),value={nodeId:node.id,requirementId:'location',answer:'The user-specified location',expectedNodeRevision:node.revision,expectedResponseId:node.response.id,clientRequestId:'nested-automatic-answer'};
  const answered=await f.service.answerQuestion(request.id,value);assert.equal(answered.cycleAction.resumedRunId,'resumed-0');assert.equal(f.admitted.size,1);
  const again=await f.service.answerQuestion(request.id,value);assert.equal(again.cycleAction.resumedRunId,'resumed-0');assert.equal(f.admitted.size,1);
});

test('standalone Plan only pins the explicitly chosen profile before admission without importing user facts',async t=>{
  const selected={model:'fixture-api::small-fast',effort:'default',serviceTier:'default'};let f;
  f=await fixture(t,{amend:async(body,input)=>{const saved=await f.store.get(input.requestId);assert.deepEqual(saved.cycles.find(cycle=>cycle.id===input.cycle.cycleId).executionProfile,selected);return body;}});
  const {request,cycle}=await standalone(f),defaults=structuredClone(f.settings),value={...runControls(request,cycle.id,'explicit-small-model'),...selected};
  const result=await f.service.runCycle(request.id,cycle.id,value);
  assert.equal(result.cycles[0].state,'paused_after_plan');assert.deepEqual(result.cycles[0].executionProfile,selected);assert.deepEqual(result.cycleAction.executionProfile,selected);
  assert.deepEqual(f.calls.map(call=>call.input.module.kind),['viability','inference','plan']);assert.equal(f.identityReads,0);assert.equal(result.viability,undefined);
  for(const {input,options}of f.calls){for(const key of Object.keys(selected))assert.equal(options[key],selected[key]);assert.equal(options.responseOnly,true);assert.deepEqual(options.dynamicTools,[]);assert.equal(input.sources.some(source=>source.id==='viability:profile'),false);}
  assert.deepEqual(f.settings,defaults);const replay=await f.service.runCycle(request.id,cycle.id,value);assert.equal(replay.revision,result.revision);assert.equal(f.calls.length,3);
  await assert.rejects(f.service.runCycle(request.id,cycle.id,{...value,model:'fixture-api::other'}),{code:'RESPONSE_CYCLE_IDEMPOTENCY_CONFLICT'});
});

test('omitted defaults resolve once to a concrete saved profile and Continue preserves it after default changes',async t=>{
  const f=await fixture(t);f.settings.defaultModel='default';let currentModel='fast-a',resolutions=0;
  f.runtime.resolveModel=value=>{assert.equal(value,'default');resolutions++;return{providerId:'fixture-api',model:currentModel,available:true};};
  f.runtime.start=()=>{throw Error('Profile resolution must not connect or start another runtime.');};
  const {request,cycle}=await standalone(f),result=await f.service.runCycle(request.id,cycle.id,runControls(request,cycle.id,'bind-current-default'));
  assert.deepEqual(result.cycles[0].executionProfile,{model:'fixture-api::fast-a',effort:'low',serviceTier:'default'});assert.equal(resolutions,1);
  currentModel='other-b';f.settings.defaultEffort='high';f.settings.defaultServiceTier='fast';
  const continued=await f.service.continueCycle(request.id,cycle.id,controls(result,cycle.id,'continue-pinned-profile'));
  assert.equal(continued.cycles[0].state,'completed');assert.equal(f.calls.length,5);assert.equal(resolutions,1);
  assert.ok(f.calls.every(call=>call.options.model==='fixture-api::fast-a'&&call.options.effort==='low'&&call.options.serviceTier==='default'));assert.equal(f.identityReads,0);
});

test('recursive standalone children inherit the exact chosen profile while independent cycles can choose another',async t=>{
  const f=await fixture(t,{amend:(body,input)=>{if(input.module.kind==='inference'&&input.cycle.depth!==1&&input.cycle.objective==='Explain a bounded synthetic marker.')body.subproblems=[{executionTarget:'analysis',key:'bounded-premise',title:'Check the bounded premise',objective:'Check only the synthetic premise needed for this answer.',reason:'The bounded answer depends on this premise.',required:true,sourceIds:[input.sources.find(source=>source.kind!=='response').id],acceptanceCriteria:[criterion]}];return body;}});
  const selected={model:'fixture-api::small-fast',effort:'minimal',serviceTier:'default'},{request,cycle}=await standalone(f),result=await f.service.runCycle(request.id,cycle.id,{...runControls(request,cycle.id,'recursive-profile'),...selected});
  assert.equal(result.cycles.length,2);assert.equal(result.cycles.find(item=>item.parentCycleId).state,'completed');assert.equal(f.calls.length,9);
  for(const item of result.cycles)assert.deepEqual(item.executionProfile,selected);assert.ok(f.calls.every(call=>call.options.model===selected.model&&call.options.effort===selected.effort));
  const next=await f.service.createCycle(request.id,{title:'A separate analysis',purpose:'Analyze a separate synthetic question.',planningExecutionMode:'plan_only',expectedRequestRevision:result.revision,clientRequestId:'independent-profile'}),other=next.cycles.find(item=>item.id===next.cycleAction.cycleId);
  const different=await f.service.runCycle(request.id,other.id,{...runControls(next,other.id,'run-independent-profile'),model:'fixture-api::another-model',effort:'default',serviceTier:'default'});
  assert.equal(different.cycles.find(item=>item.id===other.id).executionProfile.model,'fixture-api::another-model');assert.equal(different.cycles.find(item=>item.id===cycle.id).executionProfile.model,selected.model);
});

test('active profile changes reject, uncertain retries share work, and stage reruns keep the binding and stale-plan gate',async t=>{
  let started,release;const began=new Promise(resolve=>{started=resolve;}),held=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const f=await fixture(t,{amend:async(body,_input,calls)=>{if(calls.length===1){started();await held;}return body;}}),{request,cycle}=await standalone(f),selected={model:'fixture-api::small-fast',effort:'low',serviceTier:'default'},value={...runControls(request,cycle.id,'active-profile'),...selected};
  const first=f.service.runCycle(request.id,cycle.id,value),replay=f.service.runCycle(request.id,cycle.id,value);assert.equal(first,replay);await began;
  const active=await f.store.get(request.id);assert.deepEqual(active.cycles[0].executionProfile,selected);
  try{
    await assert.rejects(f.service.runCycle(request.id,cycle.id,{...runControls(active,cycle.id,'different-active-profile'),model:'fixture-api::other'}),{code:'RESPONSE_CYCLE_BUSY'});
    const next=active.nodes.find(node=>node.id===cycle.stageNodeIds.inference);
    await assert.rejects(f.runner.start({requestId:request.id,nodeId:next.id,expectedNodeRevision:next.revision,clientRequestId:'ad-hoc-active-stage'}),{code:'RESPONSE_CYCLE_BUSY'});
  }finally{release();}
  let saved=await first;await replay;assert.equal(f.calls.length,3);
  await assert.rejects(f.service.runCycle(request.id,cycle.id,{...runControls(saved,cycle.id,'change-bound-profile'),model:'fixture-api::other'}),{code:'RESPONSE_CYCLE_PROFILE_LOCKED'});
  let node=saved.nodes.find(item=>item.id===cycle.stageNodeIds.feasibility);
  await assert.rejects(f.runner.start({requestId:request.id,nodeId:node.id,expectedNodeRevision:node.revision,model:'fixture-api::other',clientRequestId:'wrong-stage-profile'}),{code:'RESPONSE_CYCLE_PROFILE_LOCKED'});
  f.settings.defaultModel='different-global-default';f.settings.defaultEffort='high';
  const claim=await f.runner.start({requestId:request.id,nodeId:node.id,expectedNodeRevision:node.revision,clientRequestId:'bound-stage-rerun'});await f.runner.wait(request.id,claim.attempt.id);assert.equal(f.calls.length,4);assert.equal(f.calls.at(-1).options.model,selected.model);assert.equal(f.calls.at(-1).options.effort,selected.effort);
  saved=await f.store.get(request.id);await assert.rejects(f.service.continueCycle(request.id,cycle.id,controls(saved,cycle.id,'reject-stale-reviewed-plan')),{code:'RESPONSE_CYCLE_PLAN_CONFLICT'});assert.equal(f.calls.length,4);
});

test('invalid cycle profiles reject before durable binding or provider admission',async t=>{
  const f=await fixture(t),{request,cycle}=await standalone(f);
  for(const extra of [{model:''},{effort:'invented-effort'},{serviceTier:'priority'},{model:'fixture-api::small-fast',serviceTier:'fast'}])await assert.rejects(f.service.runCycle(request.id,cycle.id,{...runControls(request,cycle.id,'invalid-'+JSON.stringify(extra)),...extra}));
  const saved=await f.store.get(request.id);assert.equal(saved.revision,request.revision);assert.equal(saved.cycles[0].executionProfile,undefined);assert.equal(f.calls.length,0);
});
