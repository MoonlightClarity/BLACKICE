import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime} from '../lib/planning-browser-runtime.mjs';
import {TaskViability} from '../lib/task-viability.mjs';
import {ResponseCycleService} from '../lib/response-cycle.mjs';
import {RESPONSE_CYCLE_STAGES} from '../public/response-cycle-model.mjs';

const marker='river-survey-47';
const provisionalQuestion='Which project marker should I use?';
const criterion={id:'project-summary',label:'Project summary',description:'Summarize the actual saved project record.',verification:'response'};
const workflow=()=>({id:'recovery-fixture',name:'Evidence recovery fixture',nodes:[
  {id:'input',type:'input'},
  {id:'agent',type:'agent',name:'Operational worker',model:'fixture-model',effort:'low',prompt:'Complete the requested task using available evidence.'},
  {id:'output',type:'output'},
],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{planningMode:'on'}});

function analyticalResponse(input){
  const stage=RESPONSE_CYCLE_STAGES.find(item=>item.kind===input.module.kind),sourceId=input.sources.find(source=>source.id==='viability:task')?.id||input.sources[0].id;
  const body={values:Object.fromEntries(input.template.fields.map(field=>[field.id,field.label+': bounded finding from the captured fixture records.'])),grounding:input.template.fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId})),openQuestions:[],challengeResponses:[]};
  if(stage.id==='feasibility')return {...body,requirements:[{
    id:'project-marker',label:'Project marker',importance:'essential',basis:'task',consequence:'Identify the requested project in the summary.',resolution:'unknown',value:'',sourceIds:[],checkedSourceIds:input.sources.filter(source=>source.kind!=='response').map(source=>source.id),rationale:'The initial supplied snapshot does not contain the project record.',inferable:false,omissionAllowed:false,question:provisionalQuestion,dependentNodeIds:['agent'],accuracy:null,
  }]};
  Object.assign(body,{checks:stage.checks.map(check=>({id:check.id,assessment:check.when==='effects'?'not_applicable':'supported',sourceIds:check.grounding==='required'&&check.when!=='effects'?[sourceId]:[],note:'The captured fixture records support this bounded assessment.'})),subproblems:[],childResults:[]});
  if(stage.id==='inference')body.inferences=[{id:'record-gap',claim:'The project record is absent from the supplied snapshot.',basis:'inferred',sourceIds:[sourceId],limitation:'This does not establish that the record is unavailable to operational tools.'}];
  if(stage.id==='plan')Object.assign(body,{acceptanceCriteria:[criterion],steps:[{id:'recover-and-summarize',label:'Inspect the saved record and summarize it',description:'Read the available workspace record and use its actual contents in the summary.',dependsOn:[],criterionIds:[criterion.id],sourceIds:[sourceId]}]});
  const observed=input.sources.find(source=>source.id.startsWith('cycle:execution:')&&source.text.includes(marker));
  const actualSourceId=observed?.id||sourceId;
  if(stage.id==='think')body.criterionResults=[{criterionId:criterion.id,assessment:observed?'satisfied':'uncertain',sourceIds:[actualSourceId],receiptIds:[],rationale:observed?'The operational result contains the project marker read from the saved file.':'No inspected project record has been recorded.'}];
  if(stage.id==='respond'){
    body.values.answer=observed?'The saved project is '+marker+'.':'The project record was not inspected.';
    body.coverage=[{criterionId:criterion.id,disposition:observed?'addressed':'unresolved',sourceIds:[actualSourceId],responseExcerpt:body.values.answer,limitation:observed?'':body.values.answer}];
  }
  return body;
}

async function fixture(t,{executionGuardrails=false,mode='automatic',sourceWarning=false,technicalFailure=false}={}){
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-evidence-recovery-'));
  await writeFile(path.join(dir,'project.txt'),'Project marker: '+marker+'\nStudy the river survey records.\n');
  const settings={defaultModel:'fixture-model',defaultEffort:'low',runTimeoutMs:null,executionGuardrails};
  const calls=[],operations=[];
  const runtime={status:()=>({connected:true,authenticated:true,defaultModel:'fixture-model',models:[{id:'fixture-model',model:'fixture-model',defaultReasoningEffort:'low'}]}),runAgent:async options=>{
    if(options.responseOnly){
      const input=JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n')+2));calls.push(input);
      if(technicalFailure)throw Object.assign(Error('Fixture analytical runtime is unavailable.'),{code:'PLANNING_RESPONSE_PROFILE_UNSUPPORTED'});
      return {output:JSON.stringify(analyticalResponse(input)),threadId:'analysis-fixture',turnId:'analysis-'+calls.length};
    }
    assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_workspace'));
    const receipt=await options.onToolCall({name:'relay_workspace',arguments:{action:'read',path:'project.txt'}});
    assert.equal(receipt.success,true);
    const text=receipt.contentItems.filter(item=>item.type==='inputText').map(item=>item.text).join('\n');
    assert.match(text,new RegExp(marker));
    operations.push({prompt:options.prompt,receipt});
    return {output:'The actual workspace record identifies project '+marker+'.',threadId:'operational-fixture',turnId:'operational-1'};
  }};
  const store=await new PlanningBrowserStore({dataDir:dir}).init(),engine=await new HarnessEngine({runtime,dataDir:dir,defaultCwd:dir}).init();engine.runtimeSettings={get:()=>settings};
  const runner=new PlanningBrowserRuntime({store,runtime,defaultCwd:dir,getSettings:()=>settings});
  const taskViability=new TaskViability({store,runner,engine,identity:{read:async()=>sourceWarning?{content:'Earlier profile.',warning:'The current profile could not be read.'}:{content:'Project records are saved in the configured workspace.'}},getSettings:()=>settings});
  const service=new ResponseCycleService({store,runner,taskViability,engine,getSettings:()=>settings});engine.responseCycle=service;
  t.after(async()=>{await engine.close();await runner.close();await service.close();await taskViability.close();await store.close();await rm(dir,{recursive:true,force:true});});
  const run=()=>({id:'recovery-fixture',taskId:'recovery-fixture',input:'Prepare the saved project summary.',cwd:dir,workflow:workflow(),attachmentIds:[],planningMode:'on',planningExecutionMode:mode,runtimeSettings:settings});
  return {dir,settings,store,engine,service,taskViability,calls,operations,run};
}

test('advisory planning admits evidence recovery while retaining unknown findings',async t=>{
  const f=await fixture(t),result=await f.service.forRun(f.run());
  assert.deepEqual(result.blockedNodeIds,[]);
  assert.equal(result.awaitingInput,false);
  assert.equal(result.advisory,true);
  const request=await f.store.get(result.requestId),viability=request.nodes.find(node=>node.id==='viability');
  assert.equal(viability.response.requirements[0].resolution,'unknown','admission does not fabricate a recovered value');
  assert.equal(viability.readiness.viability.state,'awaiting_input','the initial analytical finding remains recorded');
  assert.equal(request.viability.pendingIntent,null);
  assert.equal(request.cycles[0].state,'executing');
});

test('ordinary automatic run actually reads available evidence and does not reappend its provisional question',async t=>{
  const f=await fixture(t),accepted=f.engine.startRun({workflow:workflow(),input:'Prepare the saved project summary.',requestId:'evidence-recovery-fixture'});
  await f.engine.executions.get(accepted.id);
  const run=f.engine.getRun(accepted.id);
  assert.equal(run.status,'completed',run.error);
  assert.equal(f.operations.length,1,'the discovery-capable worker must run');
  assert.equal(run.nodes.agent.status,'completed');
  assert.equal(run.nodes.agent.viabilityHeld,undefined);
  assert.equal(run.viability.awaitingInput,false);
  assert.equal(run.viability.advisory,true);
  assert.match(run.output,new RegExp(marker));
  assert.doesNotMatch(run.output,/Which project marker should I use/);
  const think=f.calls.find(call=>call.module.kind==='think');
  assert.ok(think.sources.some(source=>source.id.startsWith('cycle:execution:')&&source.text.includes(marker)));
  const request=await f.store.get(run.viability.requestId);
  assert.equal(request.nodes.find(node=>node.id==='viability').response.requirements[0].resolution,'unknown');
  assert.equal(request.cycles[0].execution.state,'completed');
});

test('explicit plan only retains its pause with advisory execution settings',async t=>{
  const f=await fixture(t,{mode:'plan_only'}),result=await f.service.forRun(f.run());
  assert.equal(result.pausedAfterPlan,true);
  assert.equal(result.state,'paused_after_plan');
  assert.deepEqual(result.blockedNodeIds,['agent']);
  assert.equal(f.operations.length,0);
  assert.equal(result.advisory,undefined);
});

test('enforced readiness retains a genuine unresolved fact hold',async t=>{
  const f=await fixture(t,{executionGuardrails:true}),result=await f.service.forRun(f.run());
  assert.equal(result.awaitingInput,true);
  assert.deepEqual(result.blockedNodeIds,['agent']);
  assert.equal(result.advisory,undefined);
  assert.equal(result.question,provisionalQuestion+'\nThis enables identify the requested project in the summary.');
  assert.equal(f.operations.length,0);
});

test('explicit source read errors and technical failures are not converted into advisory permission',async t=>{
  const source=await fixture(t,{sourceWarning:true}),held=await source.service.forRun(source.run());
  assert.equal(held.state,'needs_evidence');
  assert.equal(held.awaitingInput,true);
  assert.deepEqual(held.blockedNodeIds,['agent']);
  assert.equal(held.advisory,undefined);
  assert.equal(source.calls.length,0);
  const runtime=await fixture(t,{technicalFailure:true}),failed=await runtime.service.forRun(runtime.run());
  assert.equal(failed.state,'failed');
  assert.equal(failed.error.code,'PLANNING_RESPONSE_PROFILE_UNSUPPORTED');
  assert.equal(failed.advisory,undefined);
  assert.equal(runtime.operations.length,0);
});
