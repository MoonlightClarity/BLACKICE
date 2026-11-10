import test from 'node:test';
import {fixtureUserAgency,fixtureDeferredUserAgency,fixtureAskingUserAgency} from './fixture-user-agency.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime} from '../lib/planning-browser-runtime.mjs';
import {TaskViability} from '../lib/task-viability.mjs';
import {ResponseCycleService,executionProjection,recordedExecutionOutputs,HOST_CONTROL_CRITERION} from '../lib/response-cycle.mjs';
import {createGoalCompletionController} from '../lib/planning-completion.mjs';
import {RESPONSE_CYCLE_STAGES,responseCycleStage,LEGACY_RESPONSE_CYCLE_STAGES,parseResponseCycleResponse,responseCycleResponseSchema} from '../public/response-cycle-model.mjs';
import {planningResponseBody} from '../public/planning-browser-model.mjs';
import {verificationScriptHash} from '../lib/workbench-effect-verification.mjs';
import {observationRun} from './fixtures/planning-guest-observation.mjs';

const criterion={id:'answer',label:'Requested answer',description:'Provide a supported answer to the bounded question.',verification:'response'};
const actualHostControlCriterion=JSON.parse(await readFile(new URL('./fixtures/planning-host-control-accuracy.json',import.meta.url),'utf8'));
const workflow=()=>({id:'fixture',name:'Fixture workflow',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',name:'Fixture worker',model:'fixture-fast',effort:'low',prompt:'Complete the task.'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{planningMode:'on'}});
const captured=options=>JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n')+2));
function response(input){
  const stage=responseCycleStage(input.module.kind,{pipelineVersion:input.cycle?.pipelineVersion}),sourceId=input.sources.find(source=>source.id==='viability:task')?.id||input.sources[0].id;
  const body={userAgency:fixtureUserAgency(),values:Object.fromEntries(input.template.fields.map(field=>[field.id,field.label+': a bounded public finding from the fixture evidence.'])),grounding:input.template.fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId})),openQuestions:[],challengeResponses:[]};
  if(stage.id==='feasibility')return {...body,requirements:[]};
  Object.assign(body,{checks:stage.checks.map(check=>({id:check.id,assessment:check.when==='effects'?'not_applicable':'supported',sourceIds:check.grounding==='required'&&check.when!=='effects'?[sourceId]:[],note:'Fixture observation supports this bounded check.'})),subproblems:[],childResults:(input.cycle?.children||[]).filter(child=>['completed','failed','cancelled'].includes(child.state)).map(child=>({key:child.key,sourceId:child.sourceId,summary:'The child supplied a bounded result.',usedFor:'Resolve the named subproblem.'}))});
  if(stage.id==='inference')body.inferences=[{id:'finding',claim:'The captured question has a bounded answer.',basis:'inferred',sourceIds:[sourceId],limitation:'This is a synthetic fixture.'}];
  const criteria=input.cycle?.requiredAcceptanceCriteria?.length?input.cycle.requiredAcceptanceCriteria:input.cycle?.acceptanceCriteria?.length?input.cycle.acceptanceCriteria:[criterion];
  if(stage.id==='plan')Object.assign(body,{acceptanceCriteria:criteria,steps:[{id:'answer-step',label:'Develop and check the answer',description:'Use the supplied evidence to answer and verify the question.',dependsOn:[],criterionIds:criteria.map(item=>item.id),sourceIds:[sourceId]}]});
  if(stage.id==='think')body.criterionResults=criteria.map(item=>({criterionId:item.id,assessment:'satisfied',sourceIds:[sourceId],receiptIds:[],rationale:'The synthetic result addresses the defined criterion.'}));
  if(stage.id==='respond'){body.values.answer='The bounded answer is supported by the recorded fixture results.';body.coverage=criteria.map(item=>({criterionId:item.id,disposition:'addressed',sourceIds:[sourceId],responseExcerpt:body.values.answer,limitation:''}));}
  return body;
}
function fixtureProhibitedSourceAgency(requirement){
  const checkpoint=fixtureDeferredUserAgency(requirement.value);
  checkpoint.decisions[0].input.hardConstraints=[{id:'prohibited-source',kind:'user_constraint',rule:requirement.rationale,source:requirement.sourceIds.join(', '),observedViolation:requirement.value,blockedOptionIds:['proceed']}];
  return checkpoint;
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
  const prepare=async(mode='automatic',extra={})=>{const value=Object.assign(run(mode),extra),result=await service.forRun(value);value.viability=result;value.responseCycle={...result.responseCycle,requestId:result.requestId,cycleId:result.cycleId,planRef:result.planRef,state:result.pausedAfterPlan?'paused_after_plan':result.state};return {run:value,result,request:await store.get(result.requestId)};};
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
  assert.equal(result.skipped,false);assert.equal(result.awaitingInput,undefined);assert.deepEqual(f.calls.map(call=>call.input.module.kind),['inference','viability','plan']);
  const cycle=request.cycles[0],plan=request.nodes.find(node=>node.id===cycle.stageNodeIds.plan);assert.equal(plan.response.steps[0].label,'Develop and check the answer');
  assert.deepEqual(request.nodes.filter(node=>node.parentId===cycle.id).map(node=>node.kind),['inference','viability','plan','think','respond'],'Reusing the canonical readiness node preserves actual chronological outline and XML order.');
  assert.equal(result.responseCycle.planning.planAdopted,true);
  const planCall=result.responseCycle.planning.stages.find(item=>item.stage==='plan');
  assert.equal(planCall.status,'succeeded');assert.equal(planCall.responseId,plan.response.id);assert.equal(planCall.effectsVerified,false);
  assert.equal(result.responseCycle.planning.taskSuccessVerified,false,'A valid adopted Plan is phase evidence, never proof the user task completed.');
  assert.equal(plan.readiness.cycle.analysisReady,true);assert.equal(plan.readiness.cycle.dispatchReady,true);assert.match(request.title,/Explain the supplied/);
  const final=await f.service.finishRun(run,{outputs:[{nodeId:'agent',title:'Fixture worker',status:'completed',output:'Observed fixture result.',toolReceipts:[]}]});
  assert.equal(final.state,'completed');assert.match(final.output,/bounded answer/);assert.deepEqual(f.calls.map(call=>call.input.module.kind),['inference','viability','plan','think','respond']);
  const saved=await f.store.get(request.id),stages=saved.cycles[0].stageNodeIds;
  assert.ok(saved.nodes.find(node=>node.id===stages.think).response.criterionResults.length);assert.ok(saved.nodes.find(node=>node.id===stages.respond).response.coverage.length);
  assert.equal(saved.nodes.find(node=>node.id===stages.plan).readiness.cycle.analysisReady,true,'later execution does not invalidate preparation');
  assert.ok(f.calls[3].input.sources.some(source=>source.id.startsWith('cycle:execution:')));assert.equal(f.calls[2].input.sources.some(source=>source.id.startsWith('cycle:execution:')),false);
});

test('an unmatched saved analysis-effect ownership issue is reported without requesting user facts',async t=>{
  const f=await fixture(t),drive=f.service.drive.bind(f.service);
  f.service.drive=async(...args)=>{
    const current=await drive(...args),cycle=current.cycles.find(item=>item.id===args[1]);
    if(args[2]?.through==='plan'){
      const plan=current.nodes.find(node=>node.id===cycle.stageNodeIds.plan);
      assert.equal(plan.readiness.cycle.analysisReady,true);
      plan.readiness.cycle.dispatchReady=false;
      plan.readiness.cycle.analysisEffectOwnershipIssues=[{childKey:'legacy-analysis',criterionIds:['fixture-effect']}];
    }
    return current;
  };
  const {result,request}=await f.prepare();
  assert.equal(result.state,'failed');
  assert.equal(result.awaitingInput,false);
  assert.equal(result.question,'');
  assert.equal(result.error.code,'RESPONSE_CYCLE_ANALYSIS_EFFECT_OWNERSHIP');
  const cycle=request.cycles.find(item=>item.id===result.cycleId);
  assert.equal(cycle.failure.code,result.error.code);
  assert.equal(cycle.pendingIntent,null);
  assert.ok(request.nodes.find(node=>node.id===cycle.stageNodeIds.plan).response);
});

test('actual Infer-to-Feasibility response citation passes once and carries source-bound intent into the adopted Plan',async t=>{
  const f=await fixture(t,{amend:(body,input)=>{
    if(input.module.kind==='viability'){
      const upstream=input.cycle.prerequisites.find(item=>item.stageId==='inference'),source=input.sources.find(item=>item.id===upstream.sourceId);assert.ok(source);assert.equal(source.provenance.kind,'runtime');
      body.requirements=[{id:'browser_observations',label:'Current browser evidence',importance:'essential',basis:'task',consequence:'Complete the delegated current verification.',resolution:'repairable',value:'The interpreted outcome requires a compact current observation; existing work should be preserved.',sourceIds:['viability:task',source.id],checkedSourceIds:input.sources.filter(item=>item.kind!=='response').map(item=>item.id),rationale:'The operational owner performs the supported corrected read and inspects the result under existing authority.',inferable:false,omissionAllowed:false,question:'',dependentNodeIds:['agent']}];
    }
    return body;
  }}),{result,request}=await f.prepare();
  assert.deepEqual(f.calls.map(call=>call.input.module.kind),['inference','viability','plan'],'No provider retry is needed for a legitimate upstream intent reference.');assert.equal(result.responseCycle.planning.planAdopted,true);
  const cycle=request.cycles[0],feasibility=request.nodes.find(node=>node.id===cycle.stageNodeIds.feasibility);assert.equal(feasibility.readiness.cycle.analysisReady,true);assert.equal(feasibility.readiness.viability.repairableGaps.length,1);assert.equal(feasibility.readiness.viability.blockingFacts.length,0);
});

test('Forced automatic Planning delegates unknown saved-record checks to the operational owner without treating them as answered',async t=>{
  const requirement=(input,resolution)=>({
    id:'saved_rules',label:'Saved eligibility rules and browser availability',importance:'essential',basis:'user',
    consequence:'Read saved records and check actual capabilities before dependent external work.',
    resolution,value:'The analytical preflight has not read the saved records; the operational owner can perform that check.',
    sourceIds:['viability:task'],checkedSourceIds:input.sources.filter(source=>source.kind!=='response').map(source=>source.id),
    rationale:'The owning workflow can use the attached record and capability tools to investigate before dependent work.',
    inferable:false,omissionAllowed:false,
    question:resolution==='unknown'?'What are the saved search criteria and accessible resources?':'',
    dependentNodeIds:['agent']
  });
  const f=await fixture(t,{amend:(body,input)=>{
    if(input.module.kind==='viability')body.requirements=[requirement(input,'unknown')];
    return body;
  }});
  const {result,request}=await f.prepare('automatic',{planningEnforcement:'forced',runtimeSettings:{planningGuardrails:true,executionGuardrails:false}});
  const cycle=request.cycles[0],readiness=request.nodes.find(node=>node.id===cycle.stageNodeIds.feasibility).readiness.viability;
  assert.equal(readiness.state,'awaiting_input','the unknown is not invented or silently marked resolved');
  assert.equal(readiness.blockingFacts.length,1);
  assert.equal(result.state,'executing','the owner is allowed to perform the missing checks');
  assert.equal(result.ownerChecksDeferred,true);
  assert.equal(result.awaitingInput,false);
  assert.equal(result.question,'');
  assert.deepEqual(result.blockedNodeIds,[]);
  assert.equal(result.responseCycle.state,'executing');

  const blocked=await fixture(t,{amend:(body,input)=>{
    if(input.module.kind==='viability'){body.requirements=[{...requirement(input,'blocked'),stopKind:'user_prohibited',value:'The user explicitly prohibited access to the saved records.',rationale:'The required saved-record access is expressly prohibited by the current user instruction; the owning workflow must not perform it.'}];body.userAgency=fixtureProhibitedSourceAgency(body.requirements[0]);}
    return body;
  }});
  const held=await blocked.prepare('automatic',{input:'Explain the supplied bounded problem using the saved records. Do not access the saved records: I explicitly prohibit that access.',planningEnforcement:'forced',runtimeSettings:{planningGuardrails:true,executionGuardrails:false}});
  assert.equal(held.result.state,'blocked','an explicitly prohibited operation is not waved away');
  assert.notEqual(held.result.ownerChecksDeferred,true);
});

test('automatic Planning delegates owner checks and holds only justified user questions',async t=>{
  const prepareCase=async (makeRequirement,input='Check the requested sources and complete the delegated work.',managed=true)=>{
    const f=await fixture(t,{amend:(body,captured)=>{
      if(captured.module.kind==='viability'){body.requirements=[makeRequirement(captured)];if(body.requirements[0].resolution==='blocked'&&body.requirements[0].stopKind)body.userAgency=fixtureProhibitedSourceAgency(body.requirements[0]);else if(body.requirements[0].id==='required_address')body.userAgency=fixtureAskingUserAgency(body.requirements[0].question);}
      return body;
    }});
    // Deployment admission is covered separately; this isolates the response-cycle
    // decision while retaining managed provenance on the run under preparation.
    const ordinaryPreflight=f.taskViability.forRun.bind(f.taskViability);
    f.taskViability.forRun=(run,options)=>ordinaryPreflight({...run,metadata:undefined},options);
    return f.prepare('automatic',{input,...(managed?{metadata:{managedBy:'operations',inboxId:'managed-fixture'}}:{}),runtimeSettings:{planningGuardrails:true}});
  };
  const unknown=(captured,question='')=>({
    id:'operational_access',label:'Operational workflow access',importance:'essential',basis:'task',
    consequence:'Check required files and action channels before dependent work.',resolution:'unknown',value:'',sourceIds:[],
    checkedSourceIds:captured.sources.filter(source=>source.kind!=='response').map(source=>source.id),
    rationale:'The analytical preflight cannot probe runtime tools; the owning workflow can check each channel.',
    inferable:false,omissionAllowed:false,question,dependentNodeIds:['agent']
  });
  const delegated=await prepareCase(captured=>unknown(captured,'Can you tell me which ordinary tool to use?'));
  assert.equal(delegated.request.nodes.find(node=>node.kind==='viability').readiness.viability.state,'awaiting_input','the unknown remains recorded');
  assert.equal(delegated.request.nodes.find(node=>node.kind==='viability').response.requirements[0].question,'');
  assert.equal(delegated.result.state,'executing');
  assert.equal(delegated.result.ownerChecksDeferred,true);
  assert.equal(delegated.result.awaitingInput,false);
  assert.equal(delegated.result.question,'');
  assert.deepEqual(delegated.result.blockedNodeIds,[]);

  for (const managed of [true,false]) {
    const missingFact=await prepareCase(captured=>({...unknown(captured,'What residential address should the required form use?'),id:'required_address',label:'Required residential address',basis:'user'}),undefined,managed);
    assert.equal(missingFact.result.state,'awaiting_input');
    assert.notEqual(missingFact.result.ownerChecksDeferred,true);
    assert.match(missingFact.result.question,/residential address/);
  }

  const denied=await prepareCase(captured=>({...unknown(captured),id:'prohibited_source',resolution:'blocked',value:'The user expressly prohibited this source.',sourceIds:['viability:task'],stopKind:'user_prohibited',rationale:'The current request explicitly prohibits this source.'}),'Explain the supplied evidence. Do not access the saved source.');
  assert.equal(denied.result.state,'blocked','an explicit denial still holds the managed run');
  assert.notEqual(denied.result.ownerChecksDeferred,true);
});

test('Forced automatic Planning starts owner source checks when preflight citations are incomplete',async t=>{
  const f=await fixture(t,{amend:(body,input)=>{
    if(input.module.kind==='viability')body.requirements=[{
      id:'owner_check',label:'Saved records and browser availability',
      importance:'essential',basis:'task',
      consequence:'Inspect saved records and the permitted browser before dependent work.',
      resolution:'unknown',value:'The analytical preflight did not inspect all owner-accessible records.',
      sourceIds:['viability:task'],checkedSourceIds:['viability:task'],
      rationale:'The operational owner has an actionable inspection path and should check actual records and capabilities without asking the user to repeat them.',
      inferable:false,omissionAllowed:false,question:'What saved records and browser capabilities are available?',
      dependentNodeIds:['agent']
    }];
    return body;
  }});
  const {result,request}=await f.prepare('automatic',{planningEnforcement:'forced',runtimeSettings:{planningGuardrails:true,executionGuardrails:false}});
  const cycle=request.cycles[0],readiness=request.nodes.find(node=>node.id===cycle.stageNodeIds.feasibility).readiness.viability;
  assert.equal(readiness.state,'needs_evidence','uninspected source coverage remains visibly unresolved');
  assert.equal(readiness.analysisReady,true,'the only missing work is an operational source check');
  assert.ok(readiness.sourceCoverage.length>0);
  assert.equal(readiness.blockingFacts[0].resolution,'unknown');
  assert.equal(result.state,'executing','a model-recoverable source read cannot become a human question');
  assert.equal(result.ownerChecksDeferred,true);
  assert.equal(result.awaitingInput,false);
  assert.deepEqual(result.blockedNodeIds,[]);
});

test('new preparation forks an executed legacy root without rewriting its plan, attempts, execution or proof bindings',async t=>{
  const f=await fixture(t),old=f.run('automatic','historical-run');
  let request=await f.taskViability.ensure({scope:'request',scopeId:old.id,conversationId:old.taskId,definition:{input:old.input,cwd:old.cwd,workflow:old.workflow,attachmentIds:[]},linkedRunId:old.id});
  const stageNodeIds=Object.fromEntries(LEGACY_RESPONSE_CYCLE_STAGES.map(stage=>[stage.id,stage.id==='feasibility'?'viability':'legacy-'+stage.id]));
  const legacy={id:'legacy-cycle',pipelineVersion:1,title:'Historical cycle',objective:request.objective,parentCycleId:null,parentStageId:null,stageNodeIds,depth:0,planningExecutionMode:'automatic',state:'pending',key:'historical',acceptanceCriteria:[],sourceIds:null,execution:{required:false,state:'not_required'},createdAt:'2026-10-30T10:00:00Z'};
  request=await f.store.runtimeWriter().configureResponseCycle(request.id,{createCycle:legacy,rootPatch:{rootCycleId:legacy.id}});
  request=await f.service.drive(request.id,legacy.id,{through:'respond',runKey:'historical-analysis'});
  const plan=request.nodes.find(node=>node.id===stageNodeIds.plan),planRef={requestId:request.id,cycleId:legacy.id,nodeId:plan.id,nodeRevision:plan.revision,responseId:plan.response.id};
  request=await f.store.runtimeWriter().configureResponseCycle(request.id,{cyclePatch:{id:legacy.id,linkedRunId:old.id,planRef,execution:{required:true,state:'completed',runId:old.id},effectReceipts:[]}});
  const before=structuredClone(request.responseCycle.cycles.find(item=>item.id===legacy.id)),historicalResponses=structuredClone(request.responses),historicalAttempts=structuredClone(request.attempts),calls=f.calls.length;
  const next=f.run('automatic','new-intent-run');next.input='Continue the bounded task and handle the ordinary work yourself.';next.viability={requestId:request.id,baseInput:old.input};next.responseCycle={requestId:request.id,cycleId:legacy.id,planRef};
  const result=await f.service.forRun(next),saved=await f.store.get(request.id),retained=saved.responseCycle.cycles.find(item=>item.id===legacy.id),active=saved.cycles.find(item=>item.id===result.cycleId);
  assert.notEqual(active.id,legacy.id);assert.equal(active.pipelineVersion,2);assert.equal(saved.viability.nodeId,active.stageNodeIds.feasibility);assert.deepEqual(retained,before);
  assert.deepEqual(saved.responses.filter(item=>historicalResponses.some(prior=>prior.id===item.id)),historicalResponses);assert.deepEqual(saved.attempts.filter(item=>historicalAttempts.some(prior=>prior.id===item.id)),historicalAttempts);
  assert.deepEqual(f.calls.slice(calls).map(call=>call.input.module.kind),['inference','viability','plan']);assert.equal(f.admitted.size,0,'Analytical migration never admits or repeats an operational effect.');
});

test('safe legacy upgrade removes only generated obsolete stage inputs and preserves previous analytical attempts as stale history',async t=>{
  const f=await fixture(t),{request:created}=await standalone(f),cycle=created.cycles[0];
  // A genuinely historical v1 graph is created through the trusted fixture
  // writer, rather than relabeling v2 model output as an old response.
  const base=await f.store.create({conversationId:'legacy-unexecuted',title:'Historical draft',objective:'Explain a bounded synthetic marker.',cwd:f.dir});
  const stageNodeIds=Object.fromEntries(LEGACY_RESPONSE_CYCLE_STAGES.map(stage=>[stage.id,'legacy-draft-'+stage.id]));
  let request=await f.store.runtimeWriter().configureResponseCycle(base.id,{createCycle:{id:'legacy-draft',pipelineVersion:1,title:'Legacy draft',objective:base.objective,stageNodeIds,depth:0,planningExecutionMode:'plan_only',state:'pending',key:'legacy-draft',acceptanceCriteria:[],execution:{required:false,state:'not_required'}}});
  request=await f.service.drive(request.id,'legacy-draft',{through:'plan',runKey:'legacy-preparation'});const priorIds=request.responses.map(item=>item.id),count=f.calls.length;
  assert.ok(request.edges.some(edge=>edge.from===stageNodeIds.inference&&edge.to===stageNodeIds.feasibility));
  request=await f.service.runCycle(request.id,'legacy-draft',runControls(request,'legacy-draft','upgrade-to-intent-first'));
  assert.equal(request.cycles.find(item=>item.id==='legacy-draft').pipelineVersion,2);assert.ok(priorIds.every(id=>request.responses.some(item=>item.id===id)));assert.ok(request.edges.some(edge=>edge.from===stageNodeIds.feasibility&&edge.to===stageNodeIds.inference));assert.equal(request.edges.some(edge=>edge.from===stageNodeIds.inference&&edge.to===stageNodeIds.feasibility),false);
  assert.deepEqual(f.calls.slice(count).map(call=>call.input.module.kind),['inference','viability','plan']);assert.equal(request.cycles.find(item=>item.id==='legacy-draft').pipelineMigration.removedDependencies.length>0,true);assert.ok(cycle.id);
});

test('final delivery receives the original human request and direct operational question when intent remains unresolved',async t=>{
  const candidate='Message received. Was “tets” a test, or did you want me to do something specific?';
  const question='Was “tets” a test, or did you want me to do something specific?';
  const f=await fixture(t,{amend:(body,input)=>{
    if(input.module.kind==='think'){body.criterionResults=body.criterionResults.map(item=>({...item,assessment:'uncertain',rationale:'The user has not yet clarified the intended task.'}));body.userAgency=fixtureAskingUserAgency(question);}
    if(input.module.kind==='respond'){
      const source=input.sources.find(item=>item.id.startsWith('cycle:execution:')&&JSON.parse(item.text).projection?.userDelivery);
      assert.ok(source,'The final response must have an explicit human delivery context, not only worker audit records.');
      const delivery=JSON.parse(source.text).projection.userDelivery;
      assert.equal(delivery.recipient,'original-user');
      assert.equal(delivery.objective.ranges.map(item=>item.text).join(''),'tets');
      assert.equal(delivery.candidateAnswer.ranges.map(item=>item.text).join(''),candidate);
      assert.deepEqual(delivery.candidateSourceNodeIds,['agent']);
      body.values.answer=candidate;body.userAgency=fixtureAskingUserAgency(question);
      body.coverage=body.coverage.map(item=>({...item,disposition:'unresolved',sourceIds:[source.id],responseExcerpt:question,limitation:question}));
    }
    return body;
  }}),{run}=await f.prepare();
  run.viability.baseInput='tets';run.input='tets\nInternal planning context which is not the user request.';
  const result=await f.service.finishRun(run,{output:'[BLACKICE agent]\n'+candidate,outputs:[{nodeId:'agent',title:'BLACKICE agent',status:'completed',output:candidate}]});
  assert.equal(result.output,candidate);assert.equal(result.outcome,'unresolved');
  const finalCall=f.calls.find(call=>call.input.module.kind==='respond');
  assert.match(finalCall.options.prompt,/published verbatim as the assistant reply to the original human user/);
  assert.match(finalCall.options.prompt,/ask the necessary question directly/);
  assert.equal(f.calls.length,5,'A final clarification uses the existing cycle without another operational run.');
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

test('a genuine tool blocker reaches the user without satisfying unobserved effect criteria',async t=>{
  const candidate='The required guest control tool is unavailable. No guest changes were attempted; Firefox installation remains unverified.';
  const effectCriterion={id:'firefox',label:'Firefox installed',description:'Observe Firefox installed in the configured guest.',verification:'effect'};
  const f=await fixture(t,{amend:(body,input)=>{
    if(input.module.kind==='plan'){
      body.acceptanceCriteria=[effectCriterion];body.steps[0].criterionIds=['firefox'];
    }
    if(['think','respond'].includes(input.module.kind)){
      const source=input.sources.find(item=>item.id.startsWith('cycle:execution:')&&JSON.parse(item.text).projection?.userDelivery);
      assert.ok(source);assert.equal(JSON.parse(source.text).projection.userDelivery.candidateAnswerIsUnverified,true);
      const check=body.checks.find(item=>item.id.startsWith('effects_'));
      Object.assign(check,{assessment:'supported',sourceIds:[source.id],note:'The captured worker result identifies the missing tool and explicitly records that no guest operation was attempted.'});
      if(input.module.kind==='think')body.criterionResults=[{criterionId:'firefox',assessment:'uncertain',sourceIds:[source.id],receiptIds:[],rationale:'There is no observation or trusted receipt of an installed browser.'}];
      else {body.values.answer=candidate;body.coverage=[{criterionId:'firefox',disposition:'unresolved',sourceIds:[source.id],responseExcerpt:'No guest changes were attempted',limitation:'Firefox installation remains unverified.'}];}
    }
    return body;
  }}),{run,result}=await f.prepare();
  const final=await f.service.finishRun(run,{outputs:[{nodeId:'agent',title:'Guest worker',status:'completed',output:candidate,toolReceipts:[{data:{type:'tool.result',tool:'relay_connections',success:true,output:'{"connections":[]}'}}]}]});
  assert.equal(final.output,candidate);assert.equal(final.outcome,'unresolved');
  const saved=await f.store.get(result.requestId),cycle=saved.cycles[0];
  assert.deepEqual(cycle.effectReceipts,[]);
  assert.equal(saved.nodes.find(node=>node.id===cycle.stageNodeIds.think).response.criterionResults[0].assessment,'uncertain');
  assert.deepEqual(f.calls.map(call=>call.input.module.kind),['inference','viability','plan','think','respond']);
  for(const call of f.calls.filter(call=>['think','respond'].includes(call.input.module.kind)))assert.match(call.options.prompt,/Missing requested effects alone do not make the reporting check unresolved/);
});

const verificationRecord=context=>{
  const script='$version = (Get-Item "C:\\Program Files\\Mozilla Firefox\\firefox.exe" -ErrorAction Stop).VersionInfo.ProductVersion; @{ observations = @{ version = $version } } | ConvertTo-Json -Compress';
  return {jobId:'a'.repeat(32),requestId:'verify-install-1',planRef:context.planRef,script,scriptSha256:verificationScriptHash(script),stdout:'{"observations":{"version":"128.0"}}',
    criterionIds:['installed'],assertions:[{criterionId:'installed',path:'observations.version',operator:'equals',expected:'128.0'}],guestName:'paired-guest',guestSessionId:2,agentId:'b'.repeat(32),ownerRevision:3,status:'completed',exitCode:0,childrenStopped:true,finishedAt:'2026-11-02T02:40:00.000Z'};
};
const bindVerification=(run,record)=>{run.workbenchVerifications={...run.workbenchVerifications,[record.jobId]:{...Object.fromEntries(['jobId','requestId','planRef','script','scriptSha256','criterionIds','assertions','agentId','guestName','guestSessionId','ownerRevision'].map(key=>[key,structuredClone(record[key])])),version:1,status:'declared',timeoutMs:30000,declaredAt:'2026-11-02T02:39:50.000Z'}};};
const effectPlan=body=>{body.acceptanceCriteria=[{id:'installed',label:'Installation observed',description:'Observe the installed version in the configured guest.',verification:'effect'}];body.steps[0].criterionIds=['installed'];};
const bulkyReceipts=()=>Array.from({length:300},(_,index)=>({nodeId:'agent',at:'2026-11-02T00:00:00.000Z',data:{
  type:'tool.result',callId:'call-'+index,tool:'relay_workbench',action:'guest_job',success:true,status:'completed',
  stdout:'Observation '+index+' '+('fixture-result-'+index+' ').repeat(700)}}));
const projectionBodies=records=>records.filter(source=>source.id.includes(':projection:')).map(source=>JSON.parse(source.text));
const recordIdentities=records=>projectionBodies(records).flatMap(body=>body.calls||[]);

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

async function budgetFixture(t,{partial=false}={}){
  let proofText;
  const f=await fixture(t,{amend:(body,input)=>{
    if(input.module.kind==='plan'){effectPlan(body);if(partial)body.acceptanceCriteria[0].description+=' Also establish the missing functional observation.';}
    if(['think','respond'].includes(input.module.kind)){
      const receipt=input.cycle.effectReceipts[0],source=input.sources.find(item=>item.id===receipt.sourceId);
      assert.equal(source.text,proofText,'The final reviewers must receive every proof byte, not an excerpt.');
      Object.assign(body.checks.find(item=>item.id.startsWith('effects_')),{assessment:'supported',sourceIds:[source.id]});
      if(input.module.kind==='think')body.criterionResults=[{criterionId:'installed',assessment:partial?'uncertain':'satisfied',sourceIds:[source.id],receiptIds:[receipt.id],rationale:partial?'The installed version is observed but the separate functional observation is missing.':'The exact independent verification observed the installed version.'}];
      else {
        const limitation=partial?'The separate functional observation remains unverified.':'';
        body.values.answer='The recorded guest verification observed installed version 128.0.'+(limitation?' '+limitation:'');
        body.coverage=[{criterionId:'installed',disposition:partial?'partial':'addressed',sourceIds:[source.id],responseExcerpt:body.values.answer,limitation}];
      }
    }return body;
  }}),{run,result}=await f.prepare(),context=await f.service.getVerificationContext(run),record=verificationRecord(context);
  record.script+='\n# '+('fixture'.repeat(2000));record.scriptSha256=verificationScriptHash(record.script);
  record.stdout=JSON.stringify({observations:{version:'128.0'},additionalCapturedOutput:'x'.repeat(12000)});
  bindVerification(run,record);const verification=await f.service.recordVerifiedEffects(run,record),saved=await f.store.get(result.requestId);
  const source=saved.sources.find(item=>item.id===verification.sourceId);proofText=source.text;
  run.events=bulkyReceipts();run.nodes={agent:{status:'completed',output:'Version verification completed.'}};
  return {...f,run,result,verification,proof:structuredClone(source),outputs:recordedExecutionOutputs(run)};
}

test('normal final review budgets projection and immutable proofs together before Think and Respond',async t=>{
  const f=await budgetFixture(t),old=executionProjection(f.run,f.result.cycleId,f.outputs);
  assert.equal(old.limited,false);assert.ok(old.records.reduce((sum,source)=>sum+source.text.length,0)+f.proof.text.length>240000);
  const final=await f.service.finishRun(f.run,{outputs:f.outputs});assert.equal(final.outcome,'satisfied');
  assert.deepEqual(f.calls.map(call=>call.input.module.kind),['inference','viability','plan','think','respond']);
  const saved=await f.store.get(f.result.requestId),sources=saved.sources.filter(source=>source.id.startsWith('cycle:execution:'+f.result.cycleId+':'));
  assert.ok(sources.reduce((sum,source)=>sum+source.text.length,0)<=240000);assert.deepEqual(saved.sources.find(source=>source.id===f.proof.id),f.proof);
  assert.deepEqual(saved.cycles[0].effectReceipts,f.verification.receipts);
});

test('supported final-only rerun re-budgets the same settled execution and preserves adopted plan and all proof bindings',async t=>{
  const f=await budgetFixture(t,{partial:true}),cycleId=f.result.cycleId,old=executionProjection(f.run,cycleId,f.outputs),prefix='cycle:execution:'+cycleId+':projection:';
  let request=await f.service.writer.configureResponseCycle(f.result.requestId,{replaceSourcePrefix:prefix,sources:old.records,
    cyclePatch:{id:cycleId,state:'needs_evidence',execution:{required:true,state:'completed',runId:f.run.id}}});
  const planRef=structuredClone(f.run.responseCycle.planRef),calls=f.calls.length;
  f.run.status='blocked';f.run.settled=true;let published;
  f.engine.persist=async()=>{};f.engine.publishResponseCycle=(id,details)=>{assert.equal(id,f.run.id);published=details;return {...f.run,responseCycle:details};};
  const changedEvents=f.run.events;f.run.events=[];
  await assert.rejects(f.service.refreshSettledExecutionProjection(request,cycleId),{code:'RESPONSE_CYCLE_EXECUTION_CONFLICT'});
  assert.equal(f.calls.length,calls);assert.deepEqual((await f.store.get(request.id)).sources.find(source=>source.id===f.proof.id),f.proof);
  f.run.events=changedEvents;
  const payload=runControls(request,cycleId,'review-completed-execution');
  request=await f.service.runCycle(request.id,cycleId,payload);
  assert.equal(request.cycles[0].state,'completed');assert.deepEqual(f.calls.map(call=>call.input.module.kind),['inference','viability','plan','think','respond']);
  assert.deepEqual(f.run.responseCycle.planRef,planRef);assert.deepEqual(published.planRef,planRef);assert.equal(published.outcome,'unresolved');
  assert.equal(published.planning.planAdopted,true);assert.equal(published.planning.stages.length,5);
  for(const phase of published.planning.stages){assert.equal(phase.status,'succeeded');assert.equal(phase.durableResponseRecorded,true);assert.ok(phase.responseId);}
  assert.equal(published.planning.taskSuccessVerified,false,'Successful validated phase calls never promote the partial task outcome.');
  assert.deepEqual(request.cycles[0].effectReceipts,f.verification.receipts);assert.deepEqual(request.sources.find(source=>source.id===f.proof.id),f.proof);
  assert.deepEqual(recordIdentities(request.sources),recordIdentities(old.records));
  assert.ok(request.sources.filter(source=>source.id.startsWith('cycle:execution:'+cycleId+':')).reduce((sum,source)=>sum+source.text.length,0)<=240000);
  const publication=structuredClone(published);
  await f.service.runCycle(request.id,cycleId,payload);
  assert.equal(f.calls.length,5,'Replaying final publication refreshes proof metadata without another model call or operational run.');
  assert.deepEqual(published,publication);
});

test('new retained pixels rerun only final review with exact image delivery through format repair, preserving Plan and effects',async t=>{
  let repaired=false;
  const f=await fixture(t,{amend:(body,input,calls)=>{
    if(input.module.kind==='plan'){effectPlan(body);body.acceptanceCriteria.push({id:'visual-review',label:'Inspect captured pixels',description:'Assess the actual retained image content.',verification:'evidence'});body.steps[0].criterionIds.push('visual-review');}
    if(['think','respond'].includes(input.module.kind)){
      const receipt=input.cycle.effectReceipts[0],sourceId=receipt.sourceId,media=input.sources.find(item=>item.id.endsWith(':visual-evidence')),delivered=Boolean(calls.at(-1).options.inputImages?.length);
      Object.assign(body.checks.find(item=>item.id.startsWith('effects_')),{assessment:'supported',sourceIds:[sourceId]});
      if(input.module.kind==='think'){
        if(delivered&&!repaired){repaired=true;return {values:{bad:'Malformed fixture output after images were genuinely supplied.'}};}
        body.criterionResults=[{criterionId:'installed',assessment:'satisfied',sourceIds:[sourceId],receiptIds:[receipt.id],rationale:'The current immutable guest verification supplies the installed version.'},{criterionId:'visual-review',assessment:delivered?'satisfied':'uncertain',sourceIds:[media?.id||sourceId],receiptIds:[],rationale:delivered?'The supplied actual pixels establish the bounded fixture visual result.':'No image pixels were supplied to this historical text-only fixture review.'}];
      }else {body.values.answer=delivered?'Installed version and the actual retained image were reviewed.':'Installed version observed; visual result remains uncertain because no pixels were supplied.';body.coverage=[{criterionId:'installed',disposition:'addressed',sourceIds:[sourceId],responseExcerpt:body.values.answer,limitation:''},{criterionId:'visual-review',disposition:delivered?'addressed':'partial',sourceIds:[media?.id||sourceId],responseExcerpt:body.values.answer,limitation:delivered?'':'visual result remains uncertain because no pixels were supplied.'}];}
    }
    return body;
  }}),{run,result}=await f.prepare(),context=await f.service.getVerificationContext(run),record=verificationRecord(context);bindVerification(run,record);const verified=await f.service.recordVerifiedEffects(run,record);
  const {retainWorkbenchCapture,inspectWorkbenchPng}=await import('../lib/workbench-capture.mjs'),{workbenchFramePng}=await import('../lib/workbench-agent-tools.mjs');
  const bmp=Buffer.alloc(70);bmp.write('BM');bmp.writeUInt32LE(70,2);bmp.writeUInt32LE(54,10);bmp.writeUInt32LE(40,14);bmp.writeInt32LE(2,18);bmp.writeInt32LE(-2,22);bmp.writeUInt16LE(1,26);bmp.writeUInt16LE(32,28);bmp.fill(180,54);
  const bytes=workbenchFramePng({bytes:bmp,width:2,height:2,sequence:7}),artifact=await retainWorkbenchCapture({workspace:f.dir,scope:run.taskId,bytes,info:inspectWorkbenchPng(bytes)}),metadata={basis:'native-decoded-surface',sequence:7,pngSha256:artifact.sha256,pngBytes:bytes.length,width:2,height:2,artifact};
  run.events=[{runId:run.id,nodeId:'agent',at:'2026-11-02T07:30:10.719Z',data:{type:'tool.result',tool:'relay_workbench',action:'capture',status:'completed',success:true,callId:'current-capture'}},{runId:run.id,nodeId:'agent',at:'2026-11-02T07:30:10.728Z',data:{type:'item',stage:'completed',item:{type:'dynamicToolCall',tool:'relay_workbench',id:'current-capture',arguments:{action:'capture',retain:true},status:'completed',success:true,contentItems:[{type:'inputText',text:JSON.stringify(metadata)}]}}}];
  f.engine.workbench={config:{folders:[{id:'workspace',readWrite:true,hostPath:f.dir}]}};
  run.nodes={agent:{status:'completed',output:'The current verification observed installed version 128.0.'}};
  const normal=f.service.reviewMediaSource;f.service.reviewMediaSource=async()=>null;
  const outputs=recordedExecutionOutputs(run),first=await f.service.finishRun(run,{outputs});assert.equal(first.outcome,'partial',JSON.stringify(first));assert.equal(f.calls.length,5);
  f.service.reviewMediaSource=normal;run.status='completed';run.settled=true;
  let published;f.engine.persist=async()=>{};f.engine.publishResponseCycle=(_id,details)=>{published=details;return run;};
  const before=await f.store.get(result.requestId),planRef=structuredClone(run.responseCycle.planRef),prep=before.attempts.filter(item=>['inference','viability','plan'].includes(item.node.kind)).map(item=>({id:item.id,responseId:item.responseId,outputHash:item.outputHash})),proof=before.sources.find(item=>item.id===verified.sourceId),events=structuredClone(run.events);
  const payload=runControls(before,result.cycleId,'image-final-only-review'),updated=await f.service.runCycle(before.id,result.cycleId,payload);
  assert.equal(updated.cycles[0].state,'completed');assert.equal(published.outcome,'satisfied');assert.deepEqual(run.responseCycle.planRef,planRef);assert.deepEqual(updated.cycles[0].effectReceipts,verified.receipts);assert.deepEqual(updated.sources.find(item=>item.id===verified.sourceId),proof);assert.deepEqual(run.events,events,'No guest operation or historical receipt is replayed or rewritten.');
  assert.deepEqual(updated.attempts.filter(item=>['inference','viability','plan'].includes(item.node.kind)).map(item=>({id:item.id,responseId:item.responseId,outputHash:item.outputHash})),prep);
  const visualCalls=f.calls.slice(5);assert.deepEqual(visualCalls.map(item=>item.input.module.kind),['think','think','respond']);
  for(const call of visualCalls){assert.deepEqual(Buffer.from(call.options.inputImages[0].imageUrl.split(',')[1],'base64'),bytes);assert.deepEqual(call.options.dynamicTools,[]);assert.equal(call.options.responseOnly,true);}
  const delivered=updated.attempts.filter(item=>item.metadata?.imageDelivery);assert.equal(delivered.length,3);for(const attempt of delivered){assert.equal(attempt.metadata.imageDelivery.count,1);assert.equal(attempt.metadata.imageDelivery.images[0].sha256,artifact.sha256);assert.equal(JSON.stringify(attempt).includes('data:image'),false);}
  assert.equal(JSON.stringify(updated).includes('base64,'),false);const count=f.calls.length;await f.service.runCycle(updated.id,result.cycleId,payload);assert.equal(f.calls.length,count,'An identical review request uses the saved response rather than another provider turn.');
});

for(const explicitAtomic of [false,true])test('new complete guest evidence refreshes only final review and '+(explicitAtomic?'preserves an explicit atomic-record criterion':'keeps optional outline methods separate from outcome criteria'),async t=>{
  const f=await fixture(t,{amend:(body,input)=>{
    if(input.module.kind==='plan'){
      effectPlan(body);body.acceptanceCriteria.push({id:'baseline',label:'Actual baseline',description:'Establish keyed absence before selecting the utility.',verification:'evidence'},
        {id:'records',label:'Precise records',description:'Reconcile actual attempts, jobs, receipts and handback.'+(explicitAtomic?' Each action must have a separate saved leaf.':''),verification:'evidence'});body.steps[0].criterionIds.push('baseline','records');
    }
    if(['think','respond'].includes(input.module.kind)){
      const receipt=input.cycle.effectReceipts[0],proof=input.sources.find(item=>item.id===receipt.sourceId),context=input.sources.find(item=>item.id.endsWith(':review-context')),observation=input.sources.find(item=>item.id.includes(':observation:'));
      const policy=context?JSON.parse(context.text).executionPolicy:null,baseline=observation?JSON.parse(observation.text).observations:null;
      const baselineKnown=baseline&&['uninstallEntries','executableHits','pathCommands','appx'].every(key=>Array.isArray(baseline[key])&&baseline[key].length===0);
      const exactRecords=input.cycle.acceptanceCriteria.find(item=>item.id==='records'),atomicRequired=exactRecords.description.includes('Each action must have a separate saved leaf.');
      const records=policy?.savedOutlinePolicy==='optional-auditable-outline'?(atomicRequired?'unsatisfied':'satisfied'):'uncertain';
      Object.assign(body.checks.find(item=>item.id.startsWith('effects_')),{assessment:'supported',sourceIds:[proof.id]});
      if(input.module.kind==='think')body.criterionResults=[{criterionId:'installed',assessment:'satisfied',sourceIds:[proof.id],receiptIds:[receipt.id],rationale:'The immutable criterion verification establishes the installed fixture version.'},
        {criterionId:'baseline',assessment:baselineKnown?'satisfied':'uncertain',sourceIds:[observation?.id||proof.id],receiptIds:[],rationale:baselineKnown?'The complete captured guest JSON contains all four exact empty keyed inventory arrays.':'The retained text excerpts omit the keyed baseline findings.'},
        {criterionId:'records',assessment:records,sourceIds:[context?.id||proof.id],receiptIds:[],rationale:records==='satisfied'?'Actual saved records meet the adopted criterion; host policy makes additional microstep rituals optional.':records==='unsatisfied'?'The explicit separate-leaf record criterion remains unmet even though automatic leaf guards are off.':'The exact admitted outline policy was not delivered.'}];
      else{
        const findings=input.cycle.criterionResults,limitation=findings.some(item=>item.assessment!=='satisfied')?'An adopted criterion remains unresolved.':'';
        body.values.answer='The saved installed result, baseline and records were reviewed.'+(limitation?' '+limitation:'');
        body.coverage=findings.map(item=>({criterionId:item.criterionId,disposition:item.assessment==='satisfied'?'addressed':'partial',sourceIds:item.sourceIds,responseExcerpt:body.values.answer,limitation:item.assessment==='satisfied'?'':limitation}));
      }
    }
    return body;
  }}),{run,result}=await f.prepare('automatic',{runtimeSettings:{executionGuardrails:false}}),context=await f.service.getVerificationContext(run),record=verificationRecord(context);
  bindVerification(run,record);const verified=await f.service.recordVerifiedEffects(run,record),observed=observationRun(undefined,{id:run.id,taskId:run.taskId,planRef:run.responseCycle.planRef,planCompletedAt:run.responseCycle.planning.stages.find(item=>item.stage==='plan').checkedAt});
  run.events=observed.events;run.nodes=observed.nodes;run.nodes.agent.output='Installed utility and complete baseline were observed.';
  const outputs=recordedExecutionOutputs(run),old=executionProjection(run,result.cycleId,outputs),proof=(await f.store.get(result.requestId)).sources.find(item=>item.id===verified.sourceId);
  const staleObservationId='cycle:execution:'+result.cycleId+':observation:old-selection';
  await f.service.writer.configureResponseCycle(result.requestId,{sources:[...old.records,{id:staleObservationId,kind:'tool_receipt',title:'An obsolete bounded selection',text:JSON.stringify({observations:{unavailable:true}})}],cyclePatch:{id:result.cycleId,state:'evaluating',execution:{required:true,state:'completed',runId:run.id}}});
  await f.service.drive(result.requestId,result.cycleId,{through:'respond',runKey:'historical-excerpt-review'});
  let before=await f.store.get(result.requestId);assert.equal(before.nodes.find(node=>node.kind==='think').response.criterionResults.find(item=>item.criterionId==='baseline').assessment,'uncertain');
  const prep=before.attempts.filter(a=>['inference','viability','plan'].includes(a.node.kind)).map(a=>({id:a.id,responseId:a.responseId,outputHash:a.outputHash})),planRef=structuredClone(run.responseCycle.planRef),events=structuredClone(run.events),effects=structuredClone(before.cycles[0].effectReceipts);
  run.status='completed';run.settled=true;let published;f.engine.persist=async()=>{};f.engine.publishResponseCycle=(_id,value)=>{published=value;return run;};
  const value=runControls(before,result.cycleId,'complete-observation-final-review'),after=await f.service.runCycle(before.id,result.cycleId,value);
  assert.deepEqual(f.calls.map(call=>call.input.module.kind),['inference','viability','plan','think','respond','think','respond']);
  assert.deepEqual(after.attempts.filter(a=>['inference','viability','plan'].includes(a.node.kind)).map(a=>({id:a.id,responseId:a.responseId,outputHash:a.outputHash})),prep);assert.deepEqual(run.responseCycle.planRef,planRef);assert.deepEqual(run.events,events);assert.deepEqual(after.cycles[0].effectReceipts,effects);assert.deepEqual(after.sources.find(item=>item.id===proof.id),proof);
  assert.equal(published.outcome,explicitAtomic?'partial':'satisfied');
  assert.equal(after.sources.some(source=>source.id===staleObservationId),false,'The current manifest cannot leave an older selected observation visible.');
  const finalThink=after.nodes.find(node=>node.kind==='think');assert.equal(finalThink.response.criterionResults.find(item=>item.criterionId==='baseline').assessment,'satisfied');assert.equal(finalThink.response.criterionResults.find(item=>item.criterionId==='records').assessment,explicitAtomic?'unsatisfied':'satisfied');
  assert.ok(f.calls.at(-2).input.template.fields.find(item=>item.id==='criteriaAssessment').instruction.includes('exact adopted criterion'));assert.ok(after.sources.filter(item=>item.id.startsWith('cycle:execution:')).reduce((n,item)=>n+item.text.length,0)<=240000);
  const count=f.calls.length;await f.service.runCycle(after.id,result.cycleId,value);assert.equal(f.calls.length,count,'The same final-only request never starts another analytical or operational turn.');
});

test('configured workspace changing during image read prevents the analytical provider turn',{timeout:10000},async t=>{
  const f=await fixture(t),{run}=await f.prepare(),{promises:files}=await import('node:fs'),{retainWorkbenchCapture,inspectWorkbenchPng}=await import('../lib/workbench-capture.mjs'),{workbenchFramePng}=await import('../lib/workbench-agent-tools.mjs');
  const bmp=Buffer.alloc(70);bmp.write('BM');bmp.writeUInt32LE(70,2);bmp.writeUInt32LE(54,10);bmp.writeUInt32LE(40,14);bmp.writeInt32LE(2,18);bmp.writeInt32LE(-2,22);bmp.writeUInt16LE(1,26);bmp.writeUInt16LE(32,28);bmp.fill(180,54);
  const bytes=workbenchFramePng({bytes:bmp,width:2,height:2,sequence:7}),artifact=await retainWorkbenchCapture({workspace:f.dir,scope:run.taskId,bytes,info:inspectWorkbenchPng(bytes)}),metadata={basis:'native-decoded-surface',sequence:7,pngSha256:artifact.sha256,pngBytes:bytes.length,width:2,height:2,artifact};
  run.nodes={agent:{status:'completed',output:'A bounded fixture result.'}};run.events=[{runId:run.id,nodeId:'agent',at:'2026-11-02T07:30:10.719Z',data:{type:'tool.result',tool:'relay_workbench',action:'capture',status:'completed',success:true,callId:'current-capture'}},{runId:run.id,nodeId:'agent',at:'2026-11-02T07:30:10.728Z',data:{type:'item',stage:'completed',item:{type:'dynamicToolCall',tool:'relay_workbench',id:'current-capture',arguments:{action:'capture',retain:true},status:'completed',success:true,contentItems:[{type:'inputText',text:JSON.stringify(metadata)}]}}}];
  f.engine.workbench={config:{folders:[{id:'workspace',readWrite:true,hostPath:f.dir}]}};
  let enter,release,opens=0;const entered=new Promise(resolve=>{enter=resolve}),held=new Promise(resolve=>{release=resolve}),original=files.open;
  files.open=async(...args)=>{const handle=await original(...args);if(path.resolve(String(args[0]))===path.resolve(artifact.hostPath)&&++opens===2){enter();await held;}return handle;};
  t.after(()=>{files.open=original;release();});
  try{
    const finishing=f.service.finishRun(run,{outputs:recordedExecutionOutputs(run)});await entered;f.engine.workbench.config.folders[0].hostPath=path.join(f.dir,'changed-workspace');release();
    const result=await finishing;assert.equal(result.state,'failed');assert.equal(result.error.code,'PLANNING_MEDIA_BINDING');assert.equal(f.calls.length,3,'The old image must never reach a provider after its accepted workspace changes.');assert.deepEqual(await readFile(artifact.hostPath),bytes);
  }finally{files.open=original;release();}
});

test('trusted criterion verification is durable, idempotent and survives final execution projection',async t=>{
  const f=await fixture(t,{amend:(body,input)=>{
    if(input.module.kind==='plan')effectPlan(body);
    if(['think','respond'].includes(input.module.kind)){
      const receipt=input.cycle.effectReceipts[0];assert.ok(receipt,'The stage must receive its current host receipt.');
      const source=input.sources.find(item=>item.id===receipt.sourceId);assert.ok(source);
      const proof=JSON.parse(source.text);assert.equal(proof.runId,'fixture-run');assert.equal(proof.assertions[0].actual,'128.0');
      Object.assign(body.checks.find(item=>item.id.startsWith('effects_')),{assessment:'supported',sourceIds:[source.id]});
      if(input.module.kind==='think')body.criterionResults=[{criterionId:'installed',assessment:'satisfied',sourceIds:[source.id],receiptIds:[receipt.id],rationale:'The separate bound verification observed the exact installed version.'}];
      else {body.values.answer='The recorded guest verification observed installed version 128.0.';body.coverage=[{criterionId:'installed',disposition:'addressed',sourceIds:[source.id],responseExcerpt:body.values.answer,limitation:''}];}
    }
    return body;
  }}),{run,result}=await f.prepare(),context=await f.service.getVerificationContext(run),record=verificationRecord(context);
  assert.deepEqual(context.criterionIds,['installed']);
  await assert.rejects(f.service.recordVerifiedEffects(run,record),{code:'WORKBENCH_EFFECT_VERIFICATION_INVALID'});
  bindVerification(run,record);
  const first=await f.service.recordVerifiedEffects(run,record),saved=await f.store.get(result.requestId),revision=saved.revision;
  assert.equal(first.receipts.length,1);assert.equal(saved.cycles[0].effectReceipts[0].runId,run.id);
  assert.equal(saved.nodes.find(node=>node.id===context.planRef.nodeId).readiness.cycle.analysisReady,true);
  assert.deepEqual((await f.service.getVerificationContext(run)).planRef,context.planRef);
  assert.deepEqual(await f.service.recordVerifiedEffects(run,record),first);
  assert.equal((await f.store.get(result.requestId)).revision,revision,'A retry reuses the immutable receipt without another write.');
  const changed=structuredClone(record);changed.stdout='{"observations":{"version":"128.0"},"different":true}';
  await assert.rejects(f.service.recordVerifiedEffects(run,changed),{code:'RESPONSE_CYCLE_IDEMPOTENCY_CONFLICT'});
  const final=await f.service.finishRun(run,{outputs:[{nodeId:'agent',title:'Guest worker',status:'completed',output:'Version verification completed.'}]});
  assert.equal(final.outcome,'satisfied');assert.match(final.output,/version 128.0/);
  const finished=await f.store.get(result.requestId);assert.deepEqual(finished.cycles[0].effectReceipts,first.receipts);
  assert.equal(finished.sources.filter(item=>item.id===first.sourceId).length,1);
});

test('verification rejects stale adopted plans and withdraws a receipt if its ownership fence changes during persistence',async t=>{
  const f=await fixture(t,{amend:(body,input)=>{if(input.module.kind==='plan')effectPlan(body);return body;}}),{run,result}=await f.prepare();
  const context=await f.service.getVerificationContext(run),record=verificationRecord(context),changed=structuredClone(record);changed.planRef.nodeRevision++;
  bindVerification(run,record);
  await assert.rejects(f.service.recordVerifiedEffects(run,changed),{code:'WORKBENCH_EFFECT_VERIFICATION_INVALID'});
  let current=true;const writer=f.service.writer;
  f.service.writer={...writer,configureResponseCycle:async(...args)=>{const saved=await writer.configureResponseCycle(...args);current=false;return saved;}};
  await assert.rejects(f.service.recordVerifiedEffects(run,record,{assertCurrent:()=>{if(!current)throw Object.assign(Error('Control changed'),{code:'WORKBENCH_CONTROL_BLOCKED'});}}),{code:'WORKBENCH_CONTROL_BLOCKED'});
  const saved=await f.store.get(result.requestId);assert.deepEqual(saved.cycles[0].effectReceipts,[]);
  assert.ok(saved.sources.some(source=>source.id.includes(':verification:')),'Actual captured evidence remains recorded without a verified outcome.');
  run.responseCycle.planRef={...run.responseCycle.planRef,nodeRevision:run.responseCycle.planRef.nodeRevision+1};
  await assert.rejects(f.service.getVerificationContext(run),{code:'RESPONSE_CYCLE_PLAN_CONFLICT'});
});

test('handoff readiness accepts only exact current run, Plan, source and immutable verification binding',async t=>{
  const f=await fixture(t,{amend:(body,input)=>{if(input.module.kind==='plan')effectPlan(body);return body;}}),{run,result}=await f.prepare(),context=await f.service.getVerificationContext(run),record=verificationRecord(context);
  f.engine.workbench={consoleControl:{status:()=>({owner:'agent',revision:0})}};
  const args={reason:'completed',planRef:context.planRef};
  run.taskState={steps:[{status:'done',evidence:'Historical settings result'}]};assert.equal((await f.service.getHandoffReadiness(run,args)).ready,false);
  bindVerification(run,record);await f.service.recordVerifiedEffects(run,record);
  const request=await f.store.get(result.requestId);assert.equal(f.service.handoffReadiness(run,args,request).ready,true);
  for(const mutate of [
    value=>value.cycles[0].effectReceipts[0].runId='old-run',
    value=>value.cycles[0].effectReceipts[0].planRef.nodeRevision++,
    value=>value.cycles[0].effectReceipts[0].effectVerified=false,
    value=>value.cycles[0].effectReceipts[0].criterionIds=['other'],
    value=>value.cycles[0].effectReceipts[0].proofSha256='0'.repeat(64),
    value=>value.sources.find(item=>item.id===value.cycles[0].effectReceipts[0].sourceId).text+=' ',
  ]){const changed=structuredClone(request);mutate(changed);assert.equal(f.service.handoffReadiness(run,args,changed).ready,false);}
  const binding=run.workbenchVerifications;run.workbenchVerifications={};assert.equal(f.service.handoffReadiness(run,args,request).ready,false);run.workbenchVerifications=binding;
  await assert.rejects(f.service.getHandoffReadiness(run,{...args,planRef:{...context.planRef,nodeRevision:99}}),{code:'RESPONSE_CYCLE_PLAN_CONFLICT'});
  const falseBlocker={reason:'blocked',planRef:context.planRef,evidence:{verified:true,resolved:false,callId:'capture-failed',code:'WORKBENCH_NATIVE_UNAVAILABLE',ownerRevision:0}};
  const noProof=structuredClone(request);noProof.cycles[0].effectReceipts=[];assert.equal(f.service.handoffReadiness(run,falseBlocker,noProof).ready,false,'A closed viewer remains repairable; a failed call alone is not an irreducible blocker.');
  const actualBlocker={...falseBlocker,evidence:{...falseBlocker.evidence,code:'WORKBENCH_AGENT_UNAVAILABLE',prerequisite:'guest_identity_changed'}};assert.equal(f.service.handoffReadiness(run,actualBlocker,noProof).ready,true);
  actualBlocker.evidence.resolved=true;assert.equal(f.service.handoffReadiness(run,actualBlocker,noProof).ready,false,'An already repaired failure cannot authorize incomplete handback.');
});

test('human Take and actual cancellation permit truthful incomplete exit without reclaiming control',async t=>{
  const f=await fixture(t,{amend:(body,input)=>{if(input.module.kind==='plan')effectPlan(body);return body;}}),{run}=await f.prepare();
  run.workbenchAuthorization={consumed:true,agentRevision:3};f.engine.workbench={consoleControl:{status:()=>({owner:'user',revision:4})}};
  const status=await f.service.getHandoffReadiness(run,{reason:'final'});assert.equal(status.ready,true);assert.equal(status.exitAllowed,true);assert.deepEqual(status.pendingCriterionIds,['installed']);
  const controller=new AbortController();controller.abort();assert.equal((await f.service.getHandoffReadiness(run,{reason:'cancelled',planRef:run.responseCycle.planRef,signal:controller.signal})).exitAllowed,true);
  assert.equal((await f.service.getHandoffReadiness(run,{reason:'cancelled',planRef:run.responseCycle.planRef,signal:new AbortController().signal})).ready,false,'A model label does not create an actual cancellation.');
});

test('a read-only task with an unused VM grant does not acquire control to manufacture restoration proof',async t=>{
  const f=await fixture(t),{run}=await f.prepare('automatic',{workbenchAuthorization:{scope:'configured-vm',control:'agent',source:'explicit-user-task'}});
  f.engine.workbench={consoleControl:{status:()=>({owner:'user',revision:9})}};
  const status=await f.service.getHandoffReadiness(run,{reason:'final'});assert.equal(status.ready,true);assert.equal(status.controlRestorationPending,false);assert.equal(run.workbenchAuthorization.consumed,undefined);assert.deepEqual(status.pendingCriterionIds,[]);
});

test('omitting the reserved Plan criterion cannot disable the host restoration obligation',async t=>{
  const f=await fixture(t,{amend:(body,input)=>{if(input.module.kind==='plan')effectPlan(body);return body;}}),{run,request}=await f.prepare('automatic',{workbenchAuthorization:{scope:'configured-vm',control:'agent',source:'explicit-user-task'}});
  assert.deepEqual(request.nodes.find(item=>item.id===run.responseCycle.planRef.nodeId).response.acceptanceCriteria.map(item=>item.id),['installed'],'The host does not rewrite or manufacture a model Plan response.');
  let owner={owner:'agent',revision:0};f.engine.workbench={consoleControl:{status:()=>owner}};Object.assign(run.workbenchAuthorization,{consumed:true,agentRevision:0});
  const context=await f.service.getVerificationContext(run);assert.deepEqual(context.criterionIds,['installed',HOST_CONTROL_CRITERION.id]);
  const record=verificationRecord(context);bindVerification(run,record);await f.service.recordVerifiedEffects(run,record);
  assert.deepEqual((await f.service.getHandoffReadiness(run,{reason:'completed',planRef:context.planRef})).pendingCriterionIds,[HOST_CONTROL_CRITERION.id]);
  const deferredControlVerification={criterionIds:[HOST_CONTROL_CRITERION.id],assertions:['owner','authorizedReturn','featuresRestored'].map(key=>({criterionId:HOST_CONTROL_CRITERION.id,path:'control.'+key,operator:'equals',expected:key==='owner'?'user':true}))};
  assert.equal((await f.service.getHandoffReadiness(run,{reason:'completed',planRef:context.planRef,deferredControlVerification})).ready,true,'Future control proof waits until actual transfer, using only the host-owned obligation.');
  owner={owner:'user',revision:1};Object.assign(run.workbenchAuthorization,{returned:true,userRevision:1,featuresRestored:false,handoff:{reason:'completed'}});
  assert.equal((await f.service.getHandoffReadiness(run,{reason:'final'})).ready,false,'Returned ownership without restored features or actual proof cannot pass.');
  run.workbenchAuthorization.featuresRestored=true;assert.equal((await f.service.getHandoffReadiness(run,{reason:'final'})).ready,false,'A completed label and metadata alone do not replace the actual host receipt.');
  await f.service.recordVerifiedControlEffects(run,{verificationId:'d'.repeat(32),requestId:'host-omitted-obligation',planRef:context.planRef,criterionIds:[HOST_CONTROL_CRITERION.id],assertions:deferredControlVerification.assertions,control:{...owner,authorizedReturn:true,featuresRestored:true},observedAt:new Date().toISOString()});
  assert.equal((await f.service.getHandoffReadiness(run,{reason:'final'})).ready,true);
});

for(const accuracy of [null,actualHostControlCriterion.accuracy])test('output-schema Plan criteria preserve the host role with '+(accuracy?'valid accuracy metadata':'nullable accuracy'),async t=>{
  let emitted;
  const row={...structuredClone(actualHostControlCriterion),accuracy:structuredClone(accuracy)};
  const f=await fixture(t,{amend:(body,input)=>{if(input.module.kind==='plan'){
    effectPlan(body);body.acceptanceCriteria[0].accuracy=null;body.acceptanceCriteria.push(row);body.steps[0].criterionIds.push(row.id);
    const schema=responseCycleResponseSchema('plan',{pipelineVersion:input.cycle.pipelineVersion}),required=schema.properties.acceptanceCriteria.items.required;
    for(const item of body.acceptanceCriteria)assert.deepEqual(Object.keys(item).sort(),[...required].sort(),'Match the full native output-schema shape, including its required nullable accuracy.');
    emitted=JSON.stringify(body);parseResponseCycleResponse(emitted,'plan',{pipelineVersion:input.cycle.pipelineVersion});return JSON.parse(emitted);
  }return body;}}),{run,request}=await f.prepare('automatic',{workbenchAuthorization:{scope:'configured-vm',control:'agent',source:'explicit-user-task'}});
  const parsed=parseResponseCycleResponse(emitted,'plan',{pipelineVersion:2}),saved=request.nodes.find(item=>item.id===run.responseCycle.planRef.nodeId).response.acceptanceCriteria.find(item=>item.id===row.id);
  assert.deepEqual(saved,parsed.acceptanceCriteria.find(item=>item.id===row.id));if(accuracy)assert.deepEqual(saved,actualHostControlCriterion,'Use the exact valid reserved criterion row emitted by actual Firefox12.');
  const context=await f.service.getVerificationContext(run);assert.deepEqual(context.criterionIds,['installed',HOST_CONTROL_CRITERION.id]);
  const deferredControlVerification={criterionIds:[row.id],assertions:['owner','authorizedReturn','featuresRestored'].map(key=>({criterionId:row.id,path:'control.'+key,operator:'equals',expected:key==='owner'?'user':true}))};
  const readiness=await f.service.getHandoffReadiness(run,{reason:'completed',planRef:context.planRef,deferredControlVerification});
  assert.deepEqual(readiness.eligibleDeferredControlCriteria,[HOST_CONTROL_CRITERION]);assert.deepEqual(readiness.deferredCriterionIds,[row.id]);assert.deepEqual(readiness.pendingCriterionIds,['installed']);assert.equal(readiness.ready,false,'Recognizing accuracy never supplies missing guest proof.');
  for(const mutate of [item=>item.label+=' changed',item=>item.description+=' guest substitute',item=>item.verification='evidence',item=>item.accuracy={mode:'exact'},item=>item.accuracy={...actualHostControlCriterion.accuracy,unknownPolicy:'invented'},item=>item.otherRole=true]){
    const changed=structuredClone(request),target=changed.nodes.find(item=>item.id===context.planRef.nodeId).response.acceptanceCriteria.find(item=>item.id===row.id);mutate(target);
    assert.throws(()=>f.service.verificationContext(run,changed),{code:'WORKBENCH_HOST_CONTROL_CONTRACT_CONFLICT'});
  }
  const changedId=structuredClone(request),target=changedId.nodes.find(item=>item.id===context.planRef.nodeId).response.acceptanceCriteria.find(item=>item.id===row.id);target.id='actor-selected-control';
  const wrong={criterionIds:[target.id],assertions:deferredControlVerification.assertions.map(item=>({...item,criterionId:target.id}))};
  assert.throws(()=>f.service.handoffReadiness(run,{reason:'completed',planRef:context.planRef,deferredControlVerification:wrong},changedId),{code:'WORKBENCH_HANDOFF_DECLARATION_INVALID'},'A renamed criterion never acquires the reserved role.');
});

test('only durable job dispatch or changed terminal state adds bounded goal progress',async t=>{
  const f=await fixture(t,{amend:(body,input)=>{if(input.module.kind==='plan')effectPlan(body);return body;}}),{run}=await f.prepare(),context=await f.service.getVerificationContext(run);
  const readiness=()=>f.service.getHandoffReadiness(run,{reason:'final'}),first=await readiness();
  run.events=[{data:{type:'tool.result',tool:'relay_workbench',action:'status',status:'completed'}},{data:{type:'tool.result',tool:'relay_workbench',action:'capture',status:'completed'}}];assert.equal((await readiness()).progressKey,first.progressKey,'Unrelated surface/status success never counts as effect progress.');
  const record=verificationRecord(context);bindVerification(run,record);const declared=await readiness();assert.notEqual(declared.progressKey,first.progressKey);assert.equal(declared.ready,false);
  run.events.push({data:{type:'tool.result',tool:'relay_workbench',action:'guest_job',jobId:record.jobId,status:'running'}});const running=await readiness();assert.notEqual(running.progressKey,declared.progressKey);
  run.events.push({data:{type:'tool.result',tool:'relay_workbench',action:'guest_job',jobId:record.jobId,status:'running'}});assert.equal((await readiness()).progressKey,running.progressKey,'Repeated identical polls cannot extend the bounded loop indefinitely.');
  run.events.push({data:{type:'tool.result',tool:'relay_workbench',action:'guest_job',jobId:record.jobId,status:'completed'}});assert.notEqual((await readiness()).progressKey,running.progressKey);assert.equal((await readiness()).ready,false,'A terminal job remains distinct from verified goal effects.');
});

test('the handback decision holds the actual graph write queue through its guarded dispatch',async t=>{
  const f=await fixture(t,{amend:(body,input)=>{if(input.module.kind==='plan')effectPlan(body);return body;}}),{run,result}=await f.prepare(),context=await f.service.getVerificationContext(run),record=verificationRecord(context);bindVerification(run,record);await f.service.recordVerifiedEffects(run,record);
  let enter,release,committed=false;const entered=new Promise(resolve=>{enter=resolve}),held=new Promise(resolve=>{release=resolve});
  const deciding=f.service.withHandoffReadiness(run,{reason:'completed',planRef:context.planRef},async status=>{assert.equal(status.ready,true);enter();await held;assert.equal(committed,false);return status;});
  await entered;
  const edit=f.store.runtimeWriter().configureResponseCycle(result.requestId,{sources:[{id:'cycle:human-edit-during-handoff:'+result.cycleId,kind:'source',title:'Concurrent human evidence',text:'New evidence arrived.'}]}).then(value=>{committed=true;return value;});
  await new Promise(resolve=>setTimeout(resolve,15));assert.equal(committed,false,'Raw graph writes cannot commit between the checked Plan and the guarded ownership dispatch.');release();
  assert.equal((await deciding).ready,true);await edit;assert.equal(committed,true);
});

test('complete verification evidence exceeding its saved-source limit is rejected without truncation or receipts',async t=>{
  const f=await fixture(t,{amend:(body,input)=>{if(input.module.kind==='plan')effectPlan(body);return body;}}),{run,result}=await f.prepare(),context=await f.service.getVerificationContext(run),record=verificationRecord(context);
  record.script='# '+'x'.repeat(23900);record.scriptSha256=verificationScriptHash(record.script);
  record.stdout=JSON.stringify({observations:{version:'128.0'},additionalCapturedOutput:'x'.repeat(20000)});
  bindVerification(run,record);
  await assert.rejects(f.service.recordVerifiedEffects(run,record),{code:'WORKBENCH_EFFECT_EVIDENCE_LIMIT'});
  const saved=await f.store.get(result.requestId);assert.equal(saved.cycles[0].effectReceipts?.length||0,0);
  assert.equal(saved.sources.some(source=>source.id.includes(':verification:')),false);
});

test('human-control effect proof uses actual host ownership and restored features, without a guest job',async t=>{
  const f=await fixture(t,{amend:(body,input)=>{
    if(input.module.kind==='plan'){body.acceptanceCriteria=[{id:'handback',label:'Human control restored',description:'Return the configured VM to human ownership with its enabled sharing features restored.',verification:'effect'}];body.steps[0].criterionIds=['handback'];}
    if(['think','respond'].includes(input.module.kind)){
      const receipt=input.cycle.effectReceipts[0],source=input.sources.find(item=>item.id===receipt.sourceId),proof=JSON.parse(source.text);
      assert.equal(proof.kind,'host-control-state');assert.equal(proof.control.owner,'user');assert.equal(proof.script,undefined);
      Object.assign(body.checks.find(item=>item.id.startsWith('effects_')),{assessment:'supported',sourceIds:[source.id]});
      if(input.module.kind==='think')body.criterionResults=[{criterionId:'handback',assessment:'satisfied',sourceIds:[source.id],receiptIds:[receipt.id],rationale:'The host observed exact current human ownership and feature restoration.'}];
      else {body.values.answer='Your VM control and enabled sharing features are restored.';body.coverage=[{criterionId:'handback',disposition:'addressed',sourceIds:[source.id],responseExcerpt:body.values.answer,limitation:''}];}
    }return body;
  }}),{run,result}=await f.prepare(),context=await f.service.getVerificationContext(run);
  let owner={owner:'user',revision:4};f.engine.workbench={consoleControl:{status:()=>owner}};
  run.workbenchAuthorization={returned:true,userRevision:4,featuresRestored:true};
  const control={owner:'user',revision:4,authorizedReturn:true,featuresRestored:true},record={verificationId:'c'.repeat(32),requestId:'verify-handback-1',planRef:context.planRef,criterionIds:['handback'],control,observedAt:'2026-11-02T02:40:00.000Z',assertions:[{criterionId:'handback',path:'control.owner',operator:'equals',expected:'user'},{criterionId:'handback',path:'control.featuresRestored',operator:'equals',expected:true}]};
  const first=await f.service.recordVerifiedControlEffects(run,record);
  assert.equal(first.receipts.length,1);assert.equal(first.receipts[0].jobId,undefined);
  owner={owner:'agent',revision:5};
  await assert.rejects(f.service.recordVerifiedControlEffects(run,record),{code:'WORKBENCH_EFFECT_VERIFICATION_INVALID'});
  owner={owner:'user',revision:4};run.workbenchAuthorization.featuresRestored=false;
  await assert.rejects(f.service.recordVerifiedControlEffects(run,record),{code:'WORKBENCH_EFFECT_VERIFICATION_INVALID'});
  run.workbenchAuthorization.featuresRestored=true;
  const final=await f.service.finishRun(run,{outputs:[{nodeId:'agent',title:'Worker',status:'completed',output:'Control returned.'}]});
  assert.equal(final.outcome,'satisfied');assert.match(final.output,/control.*restored/);
  assert.equal((await f.store.get(result.requestId)).cycles[0].effectReceipts[0].verificationId,record.verificationId);
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

for(const required of [false,true])test((required?'required':'optional')+' pending child preserves authoritative parent readiness on the final refinement pass',async t=>{
  const subproblem={executionTarget:'analysis',key:'pending-review',title:'Review a bounded detail',objective:'Check one optional supporting premise.',reason:'A bounded review may improve the answer.',required,sourceIds:[],acceptanceCriteria:[criterion]};
  const f=await fixture(t,{amend:(body,input)=>{
    if(input.module.kind==='inference')body.subproblems=[subproblem];
    return body;
  }}),{request,cycle}=await standalone(f);
  const created=await f.service.createCurrent(request.id,{parentNodeId:cycle.stageNodeIds.inference,title:subproblem.title,purpose:subproblem.objective,planningExecutionMode:'automatic',clientRequestId:'pending-child-fixture'},
    {internal:true,key:subproblem.key,required,acceptanceCriteria:subproblem.acceptanceCriteria,sourceIds:subproblem.sourceIds,subproblemRequest:subproblem});
  const child=created.cycles.find(item=>item.parentCycleId===cycle.id);let childDrives=0;
  f.service.drive=async(requestId,cycleId)=>{
    assert.equal(cycleId,child.id);childDrives++;
    return f.store.runtimeWriter().configureResponseCycle(requestId,{cyclePatch:{id:cycleId,state:'needs_evidence',summary:'The bounded child still needs captured evidence.'}});
  };
  const result=await f.service.runStage(request.id,cycle.id,'inference',{budget:{used:0,max:10,maxPasses:1},runKey:'final-pass-fixture'});
  const parent=result.nodes.find(item=>item.id===cycle.stageNodeIds.inference),pending=result.cycles.find(item=>item.id===child.id);
  assert.equal(parent.readiness.cycle.analysisReady,!required);
  assert.equal(parent.readiness.cycle.dispatchReady,!required);
  assert.equal(pending.state,'needs_evidence');
  assert.equal(f.calls.length,1,'Only the synthetic parent response runs; pending children are not promoted to success.');
  assert.ok(childDrives>0);
  assert.equal(f.admitted.size,0);
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
  const childCalls=f.calls.filter(call=>call.input.cycle?.cycleId===child.id);assert.deepEqual(childCalls.map(call=>call.input.module.kind),['inference','viability','plan','think','respond']);assert.ok(childCalls[0].input.sources.some(source=>source.id==='viability:task'));assert.equal(childCalls[0].input.sources.some(source=>source.id==='viability:profile'),false);
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
      if(!supplied)body.userAgency=fixtureAskingUserAgency(body.requirements[0].question);
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
      if(!answer)body.userAgency=fixtureAskingUserAgency(body.requirements[0].question);
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
  assert.deepEqual(f.calls.map(call=>call.input.module.kind),['inference','viability','plan']);assert.equal(f.identityReads,0);assert.equal(result.viability,undefined);
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
    const next=active.nodes.find(node=>node.id===cycle.stageNodeIds.feasibility);
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

test('first-class VM fake job flows through actual engine callbacks and durable guest/host effect receipts',async t=>{
  const {promises:files}=await import('node:fs');
  const {WorkbenchConsoleControl}=await import('../lib/workbench-console-control.mjs');
  const {WorkbenchAgentJobs,createWorkbenchAgentToolHandler}=await import('../lib/workbench-agent-tools.mjs');
  const {HarnessEngine}=await import('../lib/engine.mjs');
  const f=await fixture(t,{amend:(body,input)=>{if(input.module.kind==='plan'){effectPlan(body);body.acceptanceCriteria.push(structuredClone(actualHostControlCriterion));body.steps[0].criterionIds.push(HOST_CONTROL_CRITERION.id);}return body;}}),{run,result}=await f.prepare('automatic',{workbenchAuthorization:{scope:'configured-vm',control:'agent',source:'explicit-user-task'}});
  const workspace=path.join(f.dir,'vm-workspace');await files.mkdir(workspace);await files.mkdir(path.join(workspace,'.blackice-workbench'));
  const agentId='b'.repeat(32),agent={online:true,paired:true,sharedReadWriteVerified:true,guestName:'paired-guest',guestSessionId:2,agentId,heartbeatAt:new Date(Date.now()-3200).toISOString(),expectedGuestRoot:'W:\\',capabilities:['launch','capture']};let persisted=0,launches=0;
  const bridge={workspace,agentStatus:async()=>agent,request:async(kind,args)=>{
    if(kind==='windows')return {status:'completed',agentId,guestSessionId:2,result:[{title:'Existing Firefox review window'}]};
    launches++;assert.equal(kind,'launch');const jobId=path.win32.basename(path.win32.dirname(args.arguments.at(-1)));
    assert.equal(run.workbenchVerifications[jobId].status,'declared','Host binding must be persisted before dispatch.');assert.ok(persisted>0);
    return {status:'completed',agentId,guestSessionId:2,result:{processId:1234}};
  }};
  const workbench={consoleControl:new WorkbenchConsoleControl(),bridge:()=>bridge,status:async()=>({backend:'hyper-v',vmName:'BLACKICE-Workbench',guest:{running:true},canRunNativeApps:true,capability:{hostName:'fixture-host'},config:{folders:[{id:'workspace',hostPath:workspace,readWrite:true,guestMountVerified:true,hostSharePrepared:true}]}}),onAgentControlRestored:async()=>{}};
  agent.capabilities.push('windows');
  const pixels=Buffer.alloc(70);pixels.write('BM');pixels.writeUInt32LE(70,2);pixels.writeUInt32LE(54,10);pixels.writeUInt32LE(40,14);pixels.writeInt32LE(2,18);pixels.writeInt32LE(-2,22);pixels.writeUInt16LE(1,26);pixels.writeUInt16LE(32,28);pixels.fill(180,54);
  workbench.guestNativeConsoleFrame=async()=>({bytes:pixels,width:2,height:2,sequence:7});
  workbench.nativeConsoleAdapter={open:async()=>{},surface:async()=>({width:2,height:2}),input:async(_input,check)=>{check();return {accepted:true};}};
  workbench.guestNativeConsoleOpen=async check=>{check();return {windowVisible:true};};
  workbench.guestNativeConsoleWake=()=>workbench.consoleControl.run(async check=>{check();return {requested:true};});
  f.engine.workbench=workbench;
  const callbacks=HarnessEngine.prototype.workbenchVerificationCallbacks.call({responseCycle:f.service,persist:async()=>{persisted++;}},run);
  run.workbenchAuthorization={scope:'configured-vm',control:'agent',source:'explicit-user-task'};
  const jobs=new WorkbenchAgentJobs({workbench,hostName:()=> 'fixture-host',leaseKeeperFactory:()=>({ready:Promise.resolve(),error:null,stop:async()=>{}})}),handler=createWorkbenchAgentToolHandler({workbench,scope:run.id,jobs,getAuthorization:()=>run.workbenchAuthorization,persistAuthorization:async()=>{persisted++;},...callbacks});
  const call=(action,args={})=>handler({name:'relay_workbench',arguments:{action,...args}}),data=r=>JSON.parse(r.contentItems[0].text);
  const status=data(await call('status'));assert.deepEqual(status.verification.criterionIds,['installed',HOST_CONTROL_CRITERION.id]);
  const sequence=['status'];const recordFile=path.join(workspace,'verification-record.json');await files.writeFile(recordFile,JSON.stringify({oldSettings:'done'}));await files.readFile(recordFile);sequence.push('record.read');
  const claimed=await call('claim_agent_control',{expectedRevision:0});assert.equal(claimed.success,true);assert.equal(data(claimed).authorizedHandoff,false);
  sequence.push('claim_agent_control');
  for(const action of ['open_viewer','capture','windows','wake_display','capture']){const observed=await call(action);assert.equal(observed.success,true,observed.contentItems[0].text);sequence.push(action);}
  const premature=await call('return_user_control',{expectedRevision:0});sequence.push('return_user_control');assert.equal(premature.success,false,'The actual Firefox11 ninth operation must no longer return USER before any guest verification.');assert.deepEqual(workbench.consoleControl.status(),{owner:'agent',revision:0});
  const stillAgent=await call('status');sequence.push('status');assert.equal(stillAgent.success,true);
  const tooEarly=await call('verify_control_state',{requestId:'premature-control',planRef:status.verification.planRef,assertions:[{criterionId:HOST_CONTROL_CRITERION.id,path:'control.owner',operator:'equals',expected:'user'}]});sequence.push('verify_control_state');assert.equal(tooEarly.success,false);
  await files.writeFile(recordFile,JSON.stringify({oldSettings:'done',capture:'current'}));sequence.push('record.patch');await files.readFile(recordFile);sequence.push('record.read');
  assert.equal(sequence.length,13);assert.equal(launches,0,'All previous successful surface/record operations produced no guest criterion proof.');
  run.taskState={steps:[{id:'old-settings',status:'done',evidence:'A previous run completed different settings.'}]};
  const workerHandler=createWorkbenchAgentToolHandler({workbench,scope:run.id,jobs,controlCoordinator:false,getAuthorization:()=>run.workbenchAuthorization,...callbacks});await workerHandler.close();await workerHandler.safeReturn('stalled');assert.equal(workbench.consoleControl.status().owner,'agent','A delegated handler close or local exhaustion cannot return shared coordinator control.');
  const goal=createGoalCompletionController({getReadiness:args=>f.service.getHandoffReadiness(run,args),safeReturn:reason=>handler.safeReturn(reason)});
  const continuation=await goal.beforeFinal();assert.equal(continuation.continue,true,'Guardrails Off and old done steps cannot suppress same-session outcome continuation.');
  const wrongDeferred={criterionIds:['installed'],assertions:['owner','authorizedReturn','featuresRestored'].map(key=>({criterionId:'installed',path:'control.'+key,operator:'equals',expected:key==='owner'?'user':true}))};
  const dishonest=await call('return_user_control',{expectedRevision:0,handoff:{reason:'completed',planRef:status.verification.planRef,deferredControlVerification:wrongDeferred}});assert.equal(dishonest.success,false);assert.equal(workbench.consoleControl.status().owner,'agent','Guest outcome IDs cannot be deferred using control assertions.');
  const declaration={requestId:'verify-synthetic-job',planRef:status.verification.planRef,criterionIds:['installed'],assertions:[{criterionId:'installed',path:'observations.version',operator:'equals',expected:'128.0'}],script:'$version = (Get-Item "C:\\Program Files\\Mozilla Firefox\\firefox.exe" -ErrorAction Stop).VersionInfo.ProductVersion; @{ observations = @{ version = $version } } | ConvertTo-Json -Compress',timeoutMs:4000};
  assert.ok(f.calls.find(item=>item.input.module.kind==='plan').input.sources.some(item=>item.id.startsWith('cycle:handoff-contract:')&&JSON.parse(item.text).criterion.id===HOST_CONTROL_CRITERION.id),'The host-owned criterion exists before actual Plan generation.');
  const started=await call('verify_guest_script',declaration);assert.equal(started.success,true);const job=data(started);assert.equal(job.verification.status,'pending');assert.equal(launches,1);
  const folder=path.join(workspace,'.blackice-workbench','agent-jobs',job.jobId),meta=JSON.parse(await files.readFile(path.join(folder,'job.json'),'utf8'));
  assert.ok(Number.isInteger(meta.hostToGuestOffsetMs)&&meta.hostToGuestOffsetMs>=3200&&meta.hostToGuestOffsetMs<5000,'The actual supervisor job metadata carries the measured host-to-guest clock offset.');
  await files.writeFile(path.join(folder,'result.json'),JSON.stringify({version:1,jobId:job.jobId,scopeHash:meta.scopeHash,scriptSha256:meta.scriptSha256,agentId,guestSessionId:2,status:'completed',exitCode:0,stdout:'{"observations":{"version":"128.0"}}',stderr:'',childrenStopped:true,finishedAt:new Date().toISOString()}));
  await jobs.active.work;
  const verified=await call('guest_job',{jobId:job.jobId});assert.equal(verified.success,true,verified.contentItems[0].text);assert.equal(data(verified).verification.receipts[0].criterionIds[0],'installed');
  const reservedGuest=verificationRecord(status.verification);reservedGuest.criterionIds=[HOST_CONTROL_CRITERION.id];reservedGuest.assertions[0].criterionId=HOST_CONTROL_CRITERION.id;bindVerification(run,reservedGuest);await assert.rejects(f.service.recordVerifiedEffects(run,reservedGuest),{code:'WORKBENCH_EFFECT_VERIFICATION_INVALID'});
  let saved=await f.store.get(result.requestId);assert.equal(saved.cycles[0].effectReceipts.length,1);const source=saved.sources.find(x=>x.id===data(verified).verification.sourceId),proof=JSON.parse(source.text);assert.equal(proof.script,declaration.script);assert.equal(proof.stdout,'{"observations":{"version":"128.0"}}');assert.equal(proof.declaration.bindingSha256.length,64);
  const deferred={criterionIds:[HOST_CONTROL_CRITERION.id],assertions:['owner','authorizedReturn','featuresRestored'].map(key=>({criterionId:HOST_CONTROL_CRITERION.id,path:'control.'+key,operator:'equals',expected:key==='owner'?'user':true}))};
  const restored=await call('return_user_control',{expectedRevision:0,handoff:{reason:'completed',planRef:declaration.planRef,deferredControlVerification:deferred}});assert.equal(restored.success,true,restored.contentItems[0].text);assert.equal(run.workbenchAuthorization.featuresRestored,true);assert.equal(JSON.stringify(restored).includes('controlToken'),false);
  const controlProof=await call('verify_control_state',{requestId:'verify-human-handback',planRef:declaration.planRef,assertions:deferred.assertions});
  assert.equal(controlProof.success,true,controlProof.contentItems[0].text);saved=await f.store.get(result.requestId);assert.equal(saved.cycles[0].effectReceipts.length,2);assert.equal(JSON.parse(saved.sources.find(x=>x.id===data(controlProof).verification.sourceId).text).kind,'host-control-state');
  assert.equal(await goal.beforeFinal(),null);assert.equal((await goal.assertReady()).ready,true,'Real current guest verification followed by actual host restoration satisfies the mechanical gate.');
  const fakeBrowser=await call('verify_control_state',{requestId:'control-cannot-prove-browser',planRef:declaration.planRef,assertions:[{criterionId:'installed',path:'control.owner',operator:'equals',expected:'user'}]});assert.equal(fakeBrowser.success,false,'Control assertions cannot manufacture guest outcome receipts.');
  const controlRevision=saved.revision;await new Promise(resolve=>setTimeout(resolve,15));
  const controlReplay=await call('verify_control_state',{requestId:'verify-human-handback',planRef:declaration.planRef,criterionIds:deferred.criterionIds,assertions:deferred.assertions});
  assert.equal(controlReplay.success,true,controlReplay.contentItems[0].text);assert.deepEqual(data(controlReplay).verification,data(controlProof).verification);assert.equal((await f.store.get(result.requestId)).revision,controlRevision,'An unchanged host-state replay preserves the immutable original observation and store revision.');
  const historical=await call('guest_job',{jobId:job.jobId});assert.equal(historical.success,true);assert.equal(data(historical).verification.status,'not_revalidated');assert.equal((await f.store.get(result.requestId)).cycles[0].effectReceipts.length,2,'Read-only inspection under USER issues no new effect proof.');
  await handler.close();assert.equal(launches,1,'No VM process is actually launched by this fake bridge test.');
});


test('protected preparation and final review preserve host-only dispatch through every response stage',async t=>{
 const f=await fixture(t);f.runtime.supportsHostOnlyToolDispatch=({model})=>model==='fixture::safe';f.settings.defaultModel='fixture::safe';
 const run=f.run();run.workflow.nodes.find(n=>n.type==='agent').model='fixture::safe';
 assert.equal(f.service.supportsHostOnlyToolDispatch(),true);
 const result=await f.service.forRun(run,{hostOnlyTools:true});
 run.viability=result;run.responseCycle={...result.responseCycle,requestId:result.requestId,cycleId:result.cycleId,planRef:result.planRef};
 const final=await f.service.finishRun(run,{hostOnlyTools:true,outputs:[{nodeId:'agent',title:'Fixture',status:'completed',output:'Observed fixture result.',toolReceipts:[]}]});
 assert.equal(final.state,'completed');assert.deepEqual(f.calls.map(c=>c.input.module.kind),['inference','viability','plan','think','respond']);
 for(const c of f.calls){assert.equal(c.options.hostOnlyTools,true);assert.equal(c.options.model,'fixture::safe');assert.deepEqual(c.options.dynamicTools,[]);}
});
test('protected readiness rejects an unsupported saved helper route without starting a provider',async t=>{
 const f=await fixture(t);f.runtime.supportsHostOnlyToolDispatch=()=>false;
 await assert.rejects(f.service.forRun(f.run(),{hostOnlyTools:true}),{code:'HOST_ONLY_TRANSPORT_UNSUPPORTED'});assert.equal(f.calls.length,0);
});

test('protected recursive stages and child aggregation retain host-only transport',async t=>{
  const f=await fixture(t,{amend:(body,input)=>{
    if(input.module.kind==='inference'&&input.cycle?.objective==='Explain the supplied bounded problem.'){
      body.subproblems=[{executionTarget:'analysis',key:'check-assumption',title:'Check the pivotal assumption',objective:'Determine whether the supplied premise supports the intended interpretation.',reason:'The interpretation depends on this premise.',required:true,sourceIds:[input.sources.find(source=>source.id==='viability:task').id],acceptanceCriteria:[criterion]}];
    }
    return body;
  }});f.runtime.supportsHostOnlyToolDispatch=({model})=>model==='fixture::safe';f.settings.defaultModel='fixture::safe';const run=f.run('plan_only');run.workflow.nodes.find(n=>n.type==='agent').model='fixture::safe';const result=await f.service.forRun(run,{hostOnlyTools:true}),request=await f.store.get(result.requestId);for(const call of f.calls)assert.equal(call.options.hostOnlyTools,true);
  assert.equal(result.pausedAfterPlan,true);assert.equal(request.cycles.length,2);const child=request.cycles.find(item=>item.parentCycleId);
  assert.equal(child.state,'completed');assert.equal(f.calls.length,9);const parent=request.nodes.find(node=>node.id===child.parentStageId);assert.equal(parent.response.childResults[0].key,'check-assumption');
  const childCalls=f.calls.filter(call=>call.input.cycle?.cycleId===child.id);assert.deepEqual(childCalls.map(call=>call.input.module.kind),['inference','viability','plan','think','respond']);assert.ok(childCalls[0].input.sources.some(source=>source.id==='viability:task'));assert.equal(childCalls[0].input.sources.some(source=>source.id==='viability:profile'),false);
});
