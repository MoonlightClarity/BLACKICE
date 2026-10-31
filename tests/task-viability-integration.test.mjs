import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';
import { OperationsStore } from '../lib/operations.mjs';
import { TaskInbox } from '../lib/inbox.mjs';
import { PlanningBrowserStore } from '../lib/planning-browser.mjs';
import { PlanningBrowserRuntime } from '../lib/planning-browser-runtime.mjs';
import { TaskViability } from '../lib/task-viability.mjs';
import { ResponseCycleService } from '../lib/response-cycle.mjs';
import { RESPONSE_CYCLE_STAGES } from '../public/response-cycle-model.mjs';

const workflow=(planningMode='on',branched=false)=>({id:'viability-flow',name:'Readiness fixture',nodes:[{id:'input',type:'input'},
  {id:'dependent',type:'agent',name:'Form worker',prompt:'DEPENDENT_MARKER: complete the form with the mandatory address.',model:'fixture-model',effort:'high'},
  ...(branched?[{id:'independent',type:'agent',name:'Independent work',prompt:'INDEPENDENT_MARKER: summarize public requirements.',model:'fixture-model'},{id:'downstream',type:'agent',name:'Dependent follow-through',prompt:'DOWNSTREAM_MARKER: use the completed form.',model:'fixture-model'}]:[]),{id:'output',type:'output'}],
  edges:branched?[{source:'input',target:'dependent'},{source:'input',target:'independent'},{source:'dependent',target:'downstream'},{source:'downstream',target:'output'},{source:'independent',target:'output'}]:[{source:'input',target:'dependent'},{source:'dependent',target:'output'}],settings:{maxParallel:2,planningMode}});
const until=async(check,label)=>{const end=Date.now()+7000;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Fixture timed out: '+label);};
const requirement=(sources,answered)=>({id:'address',label:'Residential address',importance:'essential',basis:'task',consequence:'Filling the required address field.',resolution:answered?'observed':'unknown',value:answered?.text||'',sourceIds:answered?[answered.id]:[],checkedSourceIds:sources.map(source=>source.id),rationale:answered?'The exact factual answer is captured.':'The supplied task and saved user facts contain no residential address.',inferable:false,omissionAllowed:false,question:answered?'':'What residential address should the required form use?',dependentNodeIds:['dependent']});
const readinessNode=request=>request.nodes.find(item=>item.id==='viability');
const answer=request=>({requirementId:'address',answer:'123 Fixture Road',expectedNodeRevision:readinessNode(request).revision,expectedResponseId:readinessNode(request).response.id,clientRequestId:'fixture-factual-answer'});
class Runtime extends EventEmitter{
  constructor(){super();this.calls=[];this.needsAddress=false;}
  status(){return{connected:true,authenticated:true,defaultModel:'fixture-model'};}
  async runAgent(options){
    this.calls.push(options);
    if(options.responseOnly){
      const captured=JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n')+2));const found=captured.sources.find(source=>source.id.startsWith('viability:answer:'));
      const output={values:Object.fromEntries(captured.template.fields.map(field=>[field.id,field.label+': public fixture findings.'])),grounding:captured.template.fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId:'viability:task'})),requirements:this.needsAddress?[requirement(captured.sources,found)]:[],openQuestions:[],challengeResponses:[]};
      return{output:JSON.stringify(output),threadId:'fixture-check-thread',turnId:'fixture-turn-'+this.calls.length};
    }
    return{output:options.prompt.includes('INDEPENDENT_MARKER')?'Independent public requirements summarized.':'Requested dependent work completed.',threadId:'fixture-agent-thread-'+this.calls.length};
  }
  async close(){}
}
async function fixture(t){
  const directory=await mkdtemp(path.join(os.tmpdir(),'viability-integration-')),cwd=path.join(directory,'workspace');await mkdir(cwd);
  const runtime=new Runtime(),engine=await new HarnessEngine({runtime,dataDir:directory,defaultCwd:cwd}).init();
  const store=await new PlanningBrowserStore({dataDir:directory}).init(),runner=new PlanningBrowserRuntime({store,runtime,defaultCwd:cwd,getSettings:()=>({defaultModel:'fixture-model',maxSubagents:2})});
  let profile='The recorded user facts contain a name.';
  const service=new TaskViability({store,runner,engine,identity:{read:async()=>({content:profile})}});engine.taskViability=service;
  const inbox=await new TaskInbox({dataDir:directory,engine}).init(),operations=await new OperationsStore({dataDir:directory,engine,inbox,taskViability:service}).init();engine.operations=operations;operations.kick=()=>{};
  t.after(async()=>{await operations.close();await inbox.close();await engine.close();await runner.close();await service.close();await store.close();await rm(directory,{recursive:true,force:true});});
  const definition={name:'Fixture schedule',input:'Complete the form with its required residential address.',cwd,workflow:workflow('off'),enabled:false,trigger:{type:'manual'}};
  const finish=id=>until(()=>{const run=engine.getRun(id);return run.settled&&run;},'run settles');
  return{directory,cwd,runtime,engine,store,runner,service,inbox,operations,definition,finish,setProfile:value=>{profile=value;},checks:()=>runtime.calls.filter(call=>call.responseOnly),agents:()=>runtime.calls.filter(call=>!call.responseOnly)};
}

test('engine holds dependent descendants, completes independent work and resumes the same conversation once',async t=>{
  const f=await fixture(t);f.runtime.needsAddress=true;
  const first=f.engine.startRun({workflow:workflow('on',true),input:{task:'Complete the required form and summarize public requirements.',cwd:f.cwd}}),waiting=await f.finish(first.id);
  assert.equal(waiting.status,'blocked');assert.equal(waiting.nodes.dependent.viabilityHeld,true);assert.equal(waiting.nodes.downstream.viabilityHeld,true);assert.equal(waiting.nodes.independent.status,'completed');assert.match(waiting.output,/Independent public requirements/);assert.match(waiting.output,/What residential address/);assert.equal(f.agents().length,1);
  const request=await f.store.get(waiting.viability.requestId),payload=answer(request),result=await f.service.answer(request.id,payload),resumed=await f.finish(result.viabilityAction.resumedRunId);
  assert.equal(resumed.taskId,waiting.taskId||waiting.id);assert.equal(resumed.parentRunId,waiting.id);assert.equal(resumed.nodes.independent.reused,true);assert.equal(resumed.nodes.dependent.status,'completed');assert.equal(resumed.nodes.downstream.status,'completed');assert.equal(f.checks().length,2);assert.equal(f.agents().length,3);
  const replay=await f.service.answer(request.id,payload);assert.equal(replay.viabilityAction.resumedRunId,resumed.id);assert.equal(f.agents().length,3);
});

test('engine Planning Off has no response check and viability continuation idempotency includes changed choices',async t=>{
  const f=await fixture(t);const off=f.engine.startRun({workflow:workflow('off'),input:{task:'Fixture ordinary task.',cwd:f.cwd}});await f.finish(off.id);assert.equal(f.checks().length,0);assert.equal(f.agents().length,1);
  f.runtime.needsAddress=true;const started=f.engine.startRun({workflow:workflow('on'),input:{task:'Complete the required form.',cwd:f.cwd}}),waiting=await f.finish(started.id);
  const payload={message:'The address is 123 Fixture Road.',requestId:'fixture-followup',planningMode:'off'},accepted=f.engine.continueRun(waiting.id,payload);
  assert.equal(f.engine.continueRun(waiting.id,payload).id,accepted.id);
  assert.throws(()=>f.engine.continueRun(waiting.id,{...payload,model:'different-model'}),error=>error.status===409);
  await f.finish(accepted.id);
});

test('disabled drafts save, direct enable requires a check, and checked manual drafts run without enabling',async t=>{
  const f=await fixture(t),draft=await f.operations.create(f.definition);
  await assert.rejects(f.operations.update(draft.id,{enabled:true}),{code:'TASK_VIABILITY_REQUIRED'});assert.equal(f.operations.getDeployment(draft.id).enabled,false);
  const checked=await f.service.checkDeployment(f.operations,draft.id);assert.equal(readinessNode(checked).readiness.state,'ready');assert.equal(f.operations.getDeployment(draft.id).enabled,false);assert.equal(f.operations.getDeployment(draft.id).viabilityRef.requestId,checked.id);
  const job=await f.operations.trigger(draft.id,{idempotencyKey:'manual-fixture'});await f.operations.poll();const running=await until(()=>f.operations.getJob(job.id).attempts.at(-1)?.runId,'scheduled fake run admitted');await f.finish(running);await f.operations.poll();assert.equal(f.operations.getJob(job.id).status,'completed');assert.equal(f.agents().length,1);assert.equal(f.checks().length,1);assert.equal(f.operations.getDeployment(draft.id).enabled,false);
});

test('enabled intent remains disabled until its exact factual answer and never enables a changed draft',async t=>{
  const f=await fixture(t);f.runtime.needsAddress=true;
  const blocked=await f.service.saveDeployment(f.operations,{...f.definition,enabled:true});assert.equal(blocked.enabled,false);assert.equal(blocked.readiness.state,'awaiting_input');assert.match(blocked.readiness.question,/residential address/);
  const request=await f.store.get(blocked.readiness.requestId),payload=answer(request),enabled=await f.service.answer(request.id,payload,{operations:f.operations});
  assert.equal(enabled.viabilityAction.deployment.enabled,true);assert.equal(f.operations.getDeployment(blocked.id).enabled,true);assert.equal(f.agents().length,0);
  const revision=f.operations.getDeployment(blocked.id).revision;await f.service.answer(request.id,payload,{operations:f.operations});assert.equal(f.operations.getDeployment(blocked.id).revision,revision);
  const other=await f.service.saveDeployment(f.operations,{...f.definition,name:'Changed draft fixture',enabled:true}),otherRequest=await f.store.get(other.readiness.requestId);await f.operations.update(other.id,{name:'Edited after question'});
  await assert.rejects(f.service.answer(otherRequest.id,answer(otherRequest),{operations:f.operations}),{code:'TASK_VIABILITY_STALE'});assert.equal(f.operations.getDeployment(other.id).enabled,false);
});

test('queued jobs revalidate changed evidence, remove unstarted inbox work, and never start an agent',async t=>{
  const f=await fixture(t),draft=await f.operations.create(f.definition);await f.service.checkDeployment(f.operations,draft.id);
  const job=await f.operations.trigger(draft.id,{idempotencyKey:'queued-fixture'});f.setProfile('Current facts were changed before this job started.');await f.operations.poll();
  assert.equal(f.operations.getJob(job.id).status,'interrupted');assert.equal(f.operations.getDeployment(draft.id).enabled,false);assert.equal(f.agents().length,0);
  await f.operations.poll();assert.equal(f.operations.getJob(job.id).status,'interrupted');assert.equal(f.agents().length,0);
  const replay=await f.operations.trigger(draft.id,{idempotencyKey:'queued-fixture'});assert.equal(replay.id,job.id);assert.equal(f.checks().length,1);
});

test('managed engine admission validates sources even when the workflow uses Planning Off',async t=>{
  const f=await fixture(t),draft=await f.operations.create(f.definition);await f.service.checkDeployment(f.operations,draft.id);const job=await f.operations.trigger(draft.id,{idempotencyKey:'engine-admission-fixture'});
  const original=f.inbox.runNow.bind(f.inbox);f.inbox.runNow=async(...args)=>{f.setProfile('Changed after dispatch guard but before engine work.');return original(...args);};
  await f.operations.poll();const id=await until(()=>f.operations.getJob(job.id).attempts.at(-1)?.runId,'run receipt');const stopped=await f.finish(id);assert.equal(stopped.status,'failed');assert.equal(f.agents().length,0);assert.equal(f.checks().length,1);
});

test('a schedule cannot borrow another identical schedule readiness response',async t=>{
  const f=await fixture(t),first=await f.operations.create(f.definition),second=await f.operations.create(f.definition);await f.service.checkDeployment(f.operations,first.id);const saved=f.operations.getDeployment(first.id);
  await assert.rejects(f.operations.update(second.id,{enabled:true,viabilityRef:saved.viabilityRef}),{code:'TASK_VIABILITY_STALE'});assert.equal(f.operations.getDeployment(second.id).enabled,false);
});

test('Plan only pauses before operations; exact Continue retains the conversation and final response hook',async t=>{
  const f=await fixture(t),planRef={requestId:'fixture-cycle-request',nodeId:'fixture-plan',nodeRevision:7,responseId:'fixture-plan-response'},calls=[];
  f.engine.responseCycle={
    async forRun(run){calls.push(['prepare',run.id]);if(run.planningExecutionMode==='plan_only')return{requestId:planRef.requestId,cycleId:'fixture-cycle',state:'plan_ready',pausedAfterPlan:true,planRef,blockedNodeIds:[],context:'Typed fixture plan.',output:'Plan ready for editing.'};assert.deepEqual(run.responseCycle.continuationPlanRef,planRef);return{requestId:planRef.requestId,cycleId:'fixture-cycle',state:'ready',blockedNodeIds:[],context:'Use the exact edited Plan: fixture-plan revision 7.'};},
    async finishRun(run,options){calls.push(['finish',run.id]);assert.equal(options.outputs.length,1);assert.equal(options.outputs[0].nodeId,'dependent');assert.ok(Array.isArray(options.outputs[0].toolReceipts));assert.equal(options.outputs[0].effectVerified,undefined);return{output:'Reviewed final response from Respond.',responseCycle:{state:'completed'}};}
  };
  const first=f.engine.startRun({requestId:'fixture-plan-only-start',workflow:workflow('on'),input:{task:'Plan a fixture task before carrying it out.',cwd:f.cwd,planningExecutionMode:'plan_only'}}),paused=await f.finish(first.id);
  assert.equal(paused.responseCycle.state,'paused_after_plan');assert.deepEqual(paused.responseCycle.planRef,planRef);assert.equal(paused.planningExecutionMode,'plan_only');assert.equal(paused.output,'Plan ready for editing.');assert.equal(f.agents().length,0);assert.equal(calls.filter(call=>call[0]==='finish').length,0);
  assert.throws(()=>f.engine.continueRun(paused.id,{message:'Continue.',nodeId:'dependent'}),{code:'PLANNING_CONTINUATION_REQUIRED'});
  assert.throws(()=>f.engine.resumePlannedRun(paused.id,{requestId:'wrong-plan',planRef:{...planRef,requestId:'another-request'}}),{code:'PLANNING_CONTINUATION_INVALID'});
  const resumed=f.engine.resumePlannedRun(paused.id,{requestId:'fixture-plan-continue',planRef});assert.equal(f.engine.resumePlannedRun(paused.id,{requestId:'fixture-plan-continue',planRef}).id,resumed.id);const done=await f.finish(resumed.id);
  assert.equal(done.taskId,paused.taskId);assert.equal(done.parentRunId,paused.id);assert.equal(done.planningExecutionMode,'automatic');assert.equal(done.output,'Reviewed final response from Respond.');assert.equal(done.responseCycle.state,'completed');assert.equal(f.agents().length,1);assert.match(f.agents()[0].prompt,/exact edited Plan/);assert.equal(calls.filter(call=>call[0]==='finish').length,1);
});

test('Plan only is explicit in request identity and never overrides Planning Off',async t=>{
  const f=await fixture(t);f.engine.responseCycle={forRun:async()=>({requestId:'fixture-request',state:'plan_ready',pausedAfterPlan:true,planRef:{requestId:'fixture-request',nodeId:'plan',nodeRevision:1,responseId:'response'},blockedNodeIds:[],output:'Plan ready.'})};
  assert.throws(()=>f.engine.startRun({workflow:workflow('off'),input:{task:'Fixture',cwd:f.cwd,planningExecutionMode:'plan_only'}}),{code:'PLANNING_EXECUTION_MODE_INVALID'});
  await assert.rejects(f.operations.create({...f.definition,planningExecutionMode:'plan_only'}),{code:'PLANNING_EXECUTION_MODE_INVALID'});
  const value={requestId:'execution-mode-id',workflow:workflow('on'),input:{task:'Fixture plan',cwd:f.cwd,planningExecutionMode:'plan_only'}},first=f.engine.startRun(value);await f.finish(first.id);
  assert.equal(f.engine.startRun(value).id,first.id);assert.throws(()=>f.engine.startRun({...value,input:{...value.input,planningExecutionMode:'automatic'}}),error=>error.status===409);assert.equal(f.agents().length,0);
});

test('scheduled Plan only jobs preserve their mode and stop without operational work',async t=>{
  const f=await fixture(t);f.engine.responseCycle={async forRun(run){const fresh=await f.service.forRun(run);assert.equal(fresh.managed,true);return{...fresh,skipped:false,pausedAfterPlan:true,planRef:{requestId:fresh.requestId,nodeId:'fixture-plan',nodeRevision:1,responseId:'fixture-plan-response'},output:'Scheduled plan prepared for explicit continuation.'};}};
  const saved=await f.service.saveDeployment(f.operations,{...f.definition,workflow:workflow('on'),planningExecutionMode:'plan_only',enabled:true});assert.equal(saved.enabled,true);assert.equal(saved.planningExecutionMode,'plan_only');assert.equal(saved.workflow.settings.planningExecutionMode,'plan_only');
  const job=await f.operations.trigger(saved.id,{idempotencyKey:'plan-only-schedule'});await f.operations.poll();const runId=await until(()=>f.operations.getJob(job.id).attempts.at(-1)?.runId,'plan-only run');const run=await f.finish(runId);assert.equal(run.planningExecutionMode,'plan_only');assert.equal(run.responseCycle.state,'paused_after_plan');assert.equal(f.agents().length,0);assert.equal(f.checks().length,1);
});

test('concurrent managed jobs have independent cycles and isolated final execution evidence',async t=>{
  const f=await fixture(t),captured=[],criterion={id:'answer',label:'Requested result',description:'Provide the requested fixture result.',verification:'response'};
  let releaseA,blockedA=false;const gate=new Promise(resolve=>{releaseA=resolve;});
  f.runtime.runAgent=async options=>{
    f.runtime.calls.push(options);
    if(!options.responseOnly){const sentinel=options.prompt.includes('RUN_A_SENTINEL')?'RUN_A_SENTINEL':'RUN_B_SENTINEL';return{output:'Actual result '+sentinel,threadId:'fixture-operation-'+sentinel};}
    const input=JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n')+2)),stage=RESPONSE_CYCLE_STAGES.find(stage=>stage.kind===input.module.kind),sourceId=input.sources.find(source=>source.id==='viability:task')?.id||input.sources[0].id;
    captured.push(input);
    if(stage.id==='inference'&&input.sources.some(source=>source.id==='viability:task'&&source.text.includes('RUN_A_SENTINEL'))){blockedA=true;await gate;}
    const body={values:Object.fromEntries(input.template.fields.map(field=>[field.id,field.label+': a checked public fixture result.'])),grounding:input.template.fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId})),openQuestions:[],challengeResponses:[]};
    if(stage.id==='feasibility')body.requirements=[];
    else{
      Object.assign(body,{checks:stage.checks.map(check=>({id:check.id,assessment:check.when==='effects'?'not_applicable':'supported',sourceIds:check.grounding==='required'&&check.when!=='effects'?[sourceId]:[],note:'Bounded synthetic evidence supports this check.'})),subproblems:[],childResults:[]});
      const criteria=input.cycle?.requiredAcceptanceCriteria?.length?input.cycle.requiredAcceptanceCriteria:input.cycle?.acceptanceCriteria?.length?input.cycle.acceptanceCriteria:[criterion];
      if(stage.id==='inference')body.inferences=[{id:'finding',claim:'Use this run’s supplied task data.',basis:'inferred',sourceIds:[sourceId],limitation:'Synthetic test evidence.'}];
      if(stage.id==='plan')Object.assign(body,{acceptanceCriteria:criteria,steps:[{id:'execute',label:'Produce the fixture result',description:'Use only this run’s supplied task data.',dependsOn:[],criterionIds:criteria.map(item=>item.id),sourceIds:[sourceId]}]});
      if(stage.id==='think')body.criterionResults=criteria.map(item=>({criterionId:item.id,assessment:'satisfied',sourceIds:[sourceId],receiptIds:[],rationale:'The recorded synthetic execution addresses this criterion.'}));
      if(stage.id==='respond'){body.values.answer='The recorded fixture result is available.';body.coverage=criteria.map(item=>({criterionId:item.id,disposition:'addressed',sourceIds:[sourceId],responseExcerpt:body.values.answer,limitation:''}));}
    }
    return{output:JSON.stringify(body),threadId:'fixture-cycle-thread',turnId:'fixture-cycle-turn-'+captured.length};
  };
  const service=new ResponseCycleService({store:f.store,runner:f.runner,taskViability:f.service,engine:f.engine,getSettings:()=>({defaultModel:'fixture-model',maxSubagents:2})});f.engine.responseCycle=service;t.after(()=>service.close());
  const controls=request=>{const cycle=request.cycles[0],plan=request.nodes.find(node=>node.id===cycle.stageNodeIds.plan);return{cycle,body:{expectedRequestRevision:request.revision,expectedCycleRevision:request.nodes.find(node=>node.id===cycle.id).revision,expectedPlanRevision:plan.revision,expectedPlanResponseId:plan.response.id,clientRequestId:'continue-'+request.id}};};
  try{
    const saved=await f.service.saveDeployment(f.operations,{...f.definition,workflow:workflow('on'),planningExecutionMode:'plan_only',enabled:true});
    const jobA=await f.operations.trigger(saved.id,{idempotencyKey:'managed-a',payload:{sentinel:'RUN_A_SENTINEL'}}),jobB=await f.operations.trigger(saved.id,{idempotencyKey:'managed-b',payload:{sentinel:'RUN_B_SENTINEL'}});
    await f.operations.poll();await until(()=>blockedA,'job A is deliberately deferred');await f.operations.poll();
    const runA=f.operations.getJob(jobA.id).attempts.at(-1).runId,runB=f.operations.getJob(jobB.id).attempts.at(-1).runId,pausedB=await f.finish(runB);
    assert.equal(pausedB.responseCycle.state,'paused_after_plan');assert.equal(f.engine.getRun(runA).settled,false);
    const b=controls(await f.store.get(pausedB.responseCycle.requestId)),continuedB=await service.continueCycle(pausedB.responseCycle.requestId,b.cycle.id,b.body);await f.finish(continuedB.cycleAction.resumedRunId);
    releaseA();const pausedA=await f.finish(runA);assert.equal(pausedA.responseCycle.state,'paused_after_plan');assert.notEqual(pausedA.responseCycle.requestId,pausedB.responseCycle.requestId);assert.notEqual(pausedA.responseCycle.cycleId,pausedB.responseCycle.cycleId);
    const a=controls(await f.store.get(pausedA.responseCycle.requestId)),continuedA=await service.continueCycle(pausedA.responseCycle.requestId,a.cycle.id,a.body);await f.finish(continuedA.cycleAction.resumedRunId);
    const thinks=captured.filter(input=>input.module.kind==='think');assert.equal(thinks.length,2);
    for(const input of thinks){const own=input.sources.find(source=>source.id==='viability:task').text.includes('RUN_A_SENTINEL')?'RUN_A_SENTINEL':'RUN_B_SENTINEL',other=own==='RUN_A_SENTINEL'?'RUN_B_SENTINEL':'RUN_A_SENTINEL',actual=input.sources.filter(source=>source.id.startsWith('cycle:execution:')).map(source=>source.text).join('\n');assert.match(actual,new RegExp(own));assert.doesNotMatch(actual,new RegExp(other));}
  }finally{releaseA();}
});


test('failed and cancelled planning admissions settle lifecycle without replacing the original failure',async t=>{
  const f=await fixture(t),settlements=[];
  f.engine.responseCycle={async forRun(){throw Object.assign(new Error('Original readiness failure.'),{code:'FIXTURE_READINESS_FAILED'});},async settleRun(run,value){settlements.push({runId:run.id,...value});throw new Error('Secondary settlement write failed.');}};
  const failed=await f.finish(f.engine.startRun({workflow:workflow('on'),input:{task:'Fail before operational work.',cwd:f.cwd}}).id);
  assert.equal(failed.status,'failed');assert.equal(failed.error,'Original readiness failure.');assert.equal(failed.errorCode,'FIXTURE_READINESS_FAILED');assert.equal(failed.responseCycleSettlementError.message,'Secondary settlement write failed.');assert.equal(settlements[0].state,'failed');assert.equal(f.agents().length,0);
  let entered=false;f.engine.responseCycle={async forRun(_run,{signal}){entered=true;await new Promise((resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});},async settleRun(run,value){settlements.push({runId:run.id,...value});}};
  const started=f.engine.startRun({workflow:workflow('on'),input:{task:'Cancel while checking readiness.',cwd:f.cwd}});await until(()=>entered,'cancelled readiness admission');f.engine.cancelRun(started.id);const cancelled=await f.finish(started.id);assert.equal(cancelled.status,'cancelled');assert.equal(settlements.at(-1).state,'cancelled');assert.equal(settlements.at(-1).runId,cancelled.id);assert.equal(f.checks().length,0);assert.equal(f.agents().length,0);
});
