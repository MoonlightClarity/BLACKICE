import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime} from '../lib/planning-browser-runtime.mjs';
import {TaskViability} from '../lib/task-viability.mjs';
import {ResponseCycleService} from '../lib/response-cycle.mjs';
import {RESPONSE_CYCLE_STAGES} from '../public/response-cycle-model.mjs';

const failureCode='PLANNING_RESPONSE_PROFILE_UNSUPPORTED';
const failureMessage='The native runtime did not apply the unified_exec restriction. No module turn was started.';
const workflow=()=>({id:'admission-fixture',name:'Planning admission fixture',nodes:[
  {id:'input',type:'input'},
  {id:'agent',type:'agent',name:'Operational worker',model:'fixture-model',effort:'low',prompt:'Complete the requested task.'},
  {id:'output',type:'output'},
],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{planningMode:'on'}});

function checkedResponse(input){
  const stage=RESPONSE_CYCLE_STAGES.find(item=>item.kind===input.module.kind);
  const sourceId=input.sources.find(source=>source.id==='viability:task')?.id||input.sources[0].id;
  const body={values:Object.fromEntries(input.template.fields.map(field=>[field.id,field.label+': supported fixture finding.'])),grounding:input.template.fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId})),openQuestions:[],challengeResponses:[]};
  if(stage.id==='feasibility')return {...body,requirements:[]};
  Object.assign(body,{checks:stage.checks.map(check=>({id:check.id,assessment:check.when==='effects'?'not_applicable':'supported',sourceIds:check.grounding==='required'&&check.when!=='effects'?[sourceId]:[],note:'The captured fixture evidence supports this check.'})),subproblems:[],childResults:[]});
  if(stage.id==='inference')body.inferences=[{id:'finding',claim:'The bounded task can be answered.',basis:'inferred',sourceIds:[sourceId],limitation:'Synthetic fixture evidence.'}];
  return body;
}

async function fixture(t,{failingStage='viability',recoveringSource=false}={}){
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-planning-admission-'));
  const settings={defaultModel:'fixture-model',defaultEffort:'low',runTimeoutMs:null,executionGuardrails:false};
  const calls=[];let operationalCalls=0,finishCalls=0;
  const runtime={status:()=>({connected:true,authenticated:true,defaultModel:'fixture-model',models:[{id:'fixture-model',model:'fixture-model',defaultReasoningEffort:'low'}]}),runAgent:async options=>{
    if(!options.responseOnly){operationalCalls++;throw Error('Operational work must not start after the analytical failure.');}
    const input=JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n')+2));calls.push(input.module.kind);
    if(input.module.kind===failingStage)throw Object.assign(Error(failureMessage),{code:failureCode});
    return {output:JSON.stringify(checkedResponse(input)),threadId:'fixture-thread',turnId:'fixture-turn-'+calls.length};
  }};
  const store=await new PlanningBrowserStore({dataDir:dir}).init();
  const engine=await new HarnessEngine({runtime,dataDir:dir,defaultCwd:dir}).init();
  engine.runtimeSettings={get:()=>settings};
  const runner=new PlanningBrowserRuntime({store,runtime,defaultCwd:dir,getSettings:()=>settings});
  const taskViability=new TaskViability({store,runner,engine,identity:{read:async()=>recoveringSource?{content:'Earlier fixture facts.',warning:'Current fixture facts could not be read.'}:{content:'Recorded fixture facts.'}},getSettings:()=>settings});
  const service=new ResponseCycleService({store,runner,taskViability,engine,getSettings:()=>settings});
  const finish=service.finishRun.bind(service);service.finishRun=(...args)=>{finishCalls++;return finish(...args);};
  engine.responseCycle=service;
  t.after(async()=>{await engine.close();await runner.close();await service.close();await taskViability.close();await store.close();await rm(dir,{recursive:true,force:true});});
  const run=()=>({id:'bounded-fixture',taskId:'bounded-fixture',input:'Complete the supplied bounded task.',cwd:dir,workflow:workflow(),attachmentIds:[],planningMode:'on',planningExecutionMode:'automatic'});
  return {dir,store,engine,runner,service,run,calls,get operationalCalls(){return operationalCalls;},get finishCalls(){return finishCalls;}};
}

for(const failingStage of ['viability','plan'])test(`failed ${failingStage} admission preserves infrastructure error instead of asking for user input`,async t=>{
  const f=await fixture(t,{failingStage});
  const result=await f.service.forRun(f.run());
  assert.equal(result.state,'failed');
  assert.equal(result.awaitingInput,false,'a runtime failure is not a missing user fact');
  assert.deepEqual(result.error,{code:failureCode,message:failureMessage});
  const request=await f.store.get(result.requestId),cycle=request.cycles.find(item=>item.id===result.cycleId);
  assert.equal(cycle.state,'failed');
  assert.deepEqual(cycle.failure,{code:failureCode,message:failureMessage});
  assert.equal(cycle.pendingIntent,null);
  assert.equal(request.sources.some(source=>source.id.startsWith('cycle:execution:')),false);
  assert.equal(f.operationalCalls,0);
});

test('engine fails a refused planning admission without claiming operational completion',async t=>{
  const f=await fixture(t);
  const accepted=f.engine.startRun({workflow:workflow(),input:'Complete the supplied bounded task.',requestId:'planning-admission-failure-fixture'});
  await f.engine.executions.get(accepted.id);
  const run=f.engine.getRun(accepted.id);
  assert.equal(run.settled,true);
  assert.equal(run.status,'failed');
  assert.equal(run.errorCode,failureCode);
  assert.equal(run.error,failureMessage);
  assert.equal(run.viability.awaitingInput,false);
  assert.equal(run.responseCycle.state,'failed');
  assert.equal(f.operationalCalls,0);
  assert.equal(f.finishCalls,0,'a failed admission must not reach post-execution evaluation');
  assert.equal(run.nodes.agent.startedAt,undefined);
  assert.doesNotMatch(run.output||'',/operational results are recorded/i);
  const request=await f.store.get(run.viability.requestId);
  assert.equal(request.sources.some(source=>source.id.startsWith('cycle:execution:')),false);
  assert.equal(request.cycles[0].execution.state,'failed');
});

test('unavailable evidence remains a source-recovery hold rather than an infrastructure failure',async t=>{
  const f=await fixture(t,{recoveringSource:true});
  const result=await f.service.forRun(f.run());
  assert.equal(result.state,'needs_evidence');
  assert.equal(result.awaitingInput,true);
  assert.equal(result.error,undefined);
  assert.deepEqual(f.calls,[]);
  assert.equal(f.operationalCalls,0);
});
