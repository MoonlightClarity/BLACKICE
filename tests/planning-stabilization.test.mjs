import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {TaskStateStore} from '../lib/task-state.mjs';
import {recordFixturePlan,finishFixturePlan} from './fixture-task-plan.mjs';
import {ConversationArchive} from '../lib/conversations.mjs';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime,validatePlanningModuleResponse,planningModuleOutputSchema} from '../lib/planning-browser-runtime.mjs';
import {TaskViability} from '../lib/task-viability.mjs';
import {ResponseCycleService} from '../lib/response-cycle.mjs';
import {RESPONSE_CYCLE_STAGES,evaluateResponseCycleStage,parseResponseCycleResponse,responseCycleResponseSchema,responseCycleTemplate} from '../public/response-cycle-model.mjs';
import {tokenUsageMeasurement} from '../public/token-usage.mjs';
import {planningCycleStageContext,projectPlanningRequest} from '../public/planning-browser-model.mjs';

const planUsage=tokenUsageMeasurement({inputTokens:7,outputTokens:4,totalTokens:11});
const operationalUsage=tokenUsageMeasurement({inputTokens:13,outputTokens:4,totalTokens:17});
const failedUsage=tokenUsageMeasurement({inputTokens:5,outputTokens:2,totalTokens:7});
const workflow=(resultValue=17)=>({id:'stabilization-fixture',name:'Stabilization fixture',nodes:[
 {id:'input',type:'input'},{id:'agent',type:'agent',name:'Worker',model:'fixture::free',effort:'low',prompt:'Return the supplied result of '+resultValue+'.'},{id:'output',type:'output'}
],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{planningMode:'on'}});
function response(input,resultValue=17){
 const stage=RESPONSE_CYCLE_STAGES.find(stage=>stage.kind===input.module.kind);
 const sourceId=(stage.order>=4?input.sources.find(source=>source.id.startsWith('cycle:execution:')):null)?.id||input.sources.find(source=>source.id==='viability:task')?.id||input.sources[0].id;
 const body={values:Object.fromEntries(input.template.fields.map(field=>[field.id,field.label+': the supplied bounded evidence supports this assessment.'])),grounding:input.template.fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId})),openQuestions:[],challengeResponses:[]};
 if(stage.id==='feasibility')return {...body,requirements:[]};
 Object.assign(body,{checks:stage.checks.map(check=>({id:check.id,assessment:check.when==='effects'?'not_applicable':'supported',sourceIds:check.grounding==='required'&&check.when!=='effects'?[sourceId]:[],note:'The supplied evidence supports this assessment.'})),subproblems:[],childResults:(input.cycle?.children||[]).filter(child=>['completed','failed','cancelled'].includes(child.state)).map(child=>({key:child.key,sourceId:child.sourceId,summary:'The child returned a bounded analytical finding.',usedFor:'Carry its findings and pending workflow requirements into the parent plan.'}))});
 const criteria=stage.id==='plan'&&input.cycle?.requiredAcceptanceCriteria?.length?input.cycle.requiredAcceptanceCriteria:input.cycle?.acceptanceCriteria?.length?input.cycle.acceptanceCriteria:[{id:'answer',label:'Requested answer',description:'Report the supplied result of '+resultValue+'.',verification:'response'}];
 if(stage.id==='inference')body.inferences=[{id:'finding',claim:'The requested result is bounded by the supplied premises.',basis:'inferred',sourceIds:[sourceId],limitation:'No external facts are inferred.'}];
 if(stage.id==='plan')Object.assign(body,{acceptanceCriteria:criteria,steps:[{id:'answer-step',label:'Obtain and check the result',description:'Obtain the operational result and compare it with the requested value.',dependsOn:[],criterionIds:criteria.map(item=>item.id),sourceIds:[sourceId]}]});
 if(stage.id==='think')body.criterionResults=criteria.map(item=>({criterionId:item.id,assessment:'satisfied',sourceIds:[sourceId],receiptIds:[],rationale:'The recorded result is '+resultValue+'.'}));
 if(stage.id==='respond'){body.values.answer='The result is '+resultValue+'.';body.coverage=criteria.map(item=>({criterionId:item.id,disposition:'addressed',sourceIds:[sourceId],responseExcerpt:body.values.answer,limitation:''}));}
 return body;
}
async function fixture(t,{unresolvedInference=false,failRespond=false,recoveringSource=false,executionGuardrails=false,resultValue=17,transformResponse,operation}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'blackice-stabilization-'));
 const calls=[];let operationalCalls=0,respondFailed=false,sourceUnavailable=recoveringSource;
 const settings={defaultModel:'fixture::free',defaultEffort:'low',runTimeoutMs:null,executionGuardrails};
 const runtime={
  status:()=>({connected:true,authenticated:true,defaultModel:settings.defaultModel,models:[{id:'fixture::free',model:'fixture::free',defaultReasoningEffort:'low'}]}),
  resolveModel:model=>({available:true,providerId:'fixture',model:model==='default'?settings.defaultModel.split('::')[1]:model.split('::')[1]||model}),
  runAgent:async options=>{
   if(!options.responseOnly){operationalCalls++;options.onEvent?.({type:'thread',threadId:'provider_fixture_'+operationalCalls,model:options.model,providerId:'fixture'});const output=operation?await operation(options,{dir,operationalCalls}):'Observed result: '+resultValue+'.';options.onEvent?.({type:'usage',usage:operationalUsage});return {output,usage:operationalUsage,threadId:'provider_fixture_'+operationalCalls};}
   const input=JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n')+2));calls.push(input.module.kind);
   if(input.module.kind==='respond'&&failRespond&&!respondFailed){respondFailed=true;options.onEvent?.({type:'usage',usage:failedUsage});throw Object.assign(Error('Fixture final response was rate limited.'),{code:'PROVIDER_RATE_LIMIT'});}
       const body=response(input,resultValue);
    if(transformResponse)await transformResponse(body,{input,options,calls:[...calls]});
   if(unresolvedInference&&input.module.kind==='inference'){const check=body.checks.find(item=>item.id==='uncertainties_bounded');check.assessment='unresolved';check.note='The operational result is not yet collected; the plan can obtain it.';}
   return {output:JSON.stringify(body),usage:planUsage,threadId:'fixture-planning-thread',turnId:'planning-'+calls.length};
  }
 };
  const tasks=executionGuardrails?await new TaskStateStore({dataDir:dir}).init():null;
  const store=await new PlanningBrowserStore({dataDir:dir}).init(),engine=await new HarnessEngine({runtime,tasks,dataDir:dir,defaultCwd:dir}).init();
 engine.runtimeSettings={get:()=>settings};
 const archive=await new ConversationArchive({dataDir:dir,engine}).init();
 const runner=new PlanningBrowserRuntime({store,runtime,defaultCwd:dir,getSettings:()=>settings});
 const taskViability=new TaskViability({store,runner,engine,conversations:archive,identity:{read:async()=>sourceUnavailable?{content:'Older fixture record.',warning:'The current fixture record is unavailable.'}:{content:'The supplied bounded task has no missing personal facts.'}},getSettings:()=>settings});
 const service=new ResponseCycleService({store,runner,taskViability,engine,conversations:archive,getSettings:()=>settings});engine.responseCycle=service;
 t.after(async()=>{await engine.close();await archive.close();await runner.close();await service.close();await taskViability.close();await store.close();await tasks?.close();await rm(dir,{recursive:true,force:true});});
 const execute=async(overrides={})=>{const accepted=engine.startRun({workflow:workflow(resultValue),input:'Report the supplied result of '+resultValue+'.',requestId:'stabilization-test',...overrides});await engine.executions.get(accepted.id);await archive.chain;return engine.getRun(accepted.id);};
 return{dir,engine,archive,store,service,settings,calls,execute,get operationalCalls(){return operationalCalls;},recoverSource:()=>{sourceUnavailable=false;}};
}
test('unresolved preparatory findings progress to a plan and available work while retaining their uncertainty',async t=>{
 const f=await fixture(t,{unresolvedInference:true}),run=await f.execute();
 assert.equal(run.status,'completed');assert.equal(run.settled,true);assert.equal(f.operationalCalls,1);
 assert.deepEqual(f.calls,['viability','inference','plan','think','respond']);
 const request=await f.store.get(run.responseCycle.requestId),cycle=request.cycles[0],inference=request.nodes.find(node=>node.id===cycle.stageNodeIds.inference);
 assert.equal(inference.response.checks.find(check=>check.id==='uncertainties_bounded').assessment,'unresolved');
 assert.equal(inference.readiness.cycle.analysisReady,true);assert.equal(inference.readiness.cycle.dispatchReady,false);
 assert.equal(run.planningAttempts.length,5);assert.equal(run.planningUsage.totalTokens,55);assert.equal(run.operationalUsage.totalTokens,17);
 assert.equal(run.usage.totalTokens,72);assert.equal(run.usage.samples,6);
 const archived=JSON.parse(await readFile(path.join(f.dir,'conversations',run.id+'.json'),'utf8'));
 assert.equal(archived.usage.totalTokens,72);assert.equal(archived.planningAttempts.length,5);
});
test('source-recovery hold is a settled blocked run, preserves no-execution evidence, and accepts an ordinary follow-up',async t=>{
 const f=await fixture(t,{recoveringSource:true}),run=await f.execute();
 assert.equal(run.status,'blocked');assert.equal(run.settled,true);assert.equal(run.viability.awaitingInput,true);
 assert.equal(run.responseCycle.state,'needs_evidence');assert.equal(f.operationalCalls,0);assert.deepEqual(f.calls,[]);
 assert.doesNotMatch(run.output,/operational results are recorded/i);
 const request=await f.store.get(run.responseCycle.requestId);
 assert.equal(request.sources.some(source=>source.id.startsWith('cycle:execution:')),false);
 assert.equal((await f.archive.get(run.id)).status,'blocked');
 f.recoverSource();
 const next=f.engine.continueRun(run.id,{nodeId:'agent',message:'The source is available now; continue the original task.',requestId:'recovered-source'});
 await f.engine.executions.get(next.id);
 const finished=f.engine.getRun(next.id);assert.equal(finished.status,'completed');assert.equal(f.operationalCalls,1);
});
test('failed final response remains failed; a public cycle retry republishes the original archived run exactly once',async t=>{
 const f=await fixture(t,{failRespond:true}),run=await f.execute();
 assert.equal(run.status,'failed');assert.equal(run.errorCode,'PROVIDER_RATE_LIMIT');assert.equal(f.operationalCalls,1);
 assert.equal(run.planningUsage.totalTokens,51);assert.equal(run.usage.totalTokens,68);
 let request=await f.store.get(run.responseCycle.requestId),cycle=request.cycles.find(cycle=>cycle.id===run.responseCycle.cycleId);
 assert.equal(cycle.state,'failed');assert.equal(cycle.execution.state,'completed','the completed operation is not relabeled failed');
 const payload={expectedRequestRevision:request.revision,expectedCycleRevision:request.nodes.find(node=>node.id===cycle.id).revision,clientRequestId:'retry-only-final'};
 await f.archive.chain;f.engine.runs.delete(run.id); // Exercise restoration from the actual archive.
 request=await f.service.runCycle(request.id,cycle.id,payload);cycle=request.cycles.find(item=>item.id===cycle.id);
 assert.equal(cycle.state,'completed');assert.equal(cycle.failure,null);assert.doesNotMatch(cycle.summary,/rate limited|failed/i);assert.equal(f.operationalCalls,1);
 assert.deepEqual(f.calls,['viability','inference','plan','think','respond','respond']);
 const published=f.engine.getRun(run.id);assert.equal(published.status,'completed');assert.equal(published.output,'The result is 17.');
 assert.equal(published.error,undefined);assert.equal(published.errorCode,undefined);assert.equal(published.responseCycle.partial,false);
 assert.equal(published.planningUsage.totalTokens,62);assert.equal(published.usage.totalTokens,79);assert.equal(published.usage.samples,7);
 assert.equal(published.events.filter(event=>event.data?.responseId===published.responseCycle.responseId&&event.data?.responseCycleFinal).length,1);
 const archived=JSON.parse(await readFile(path.join(f.dir,'conversations',run.id+'.json'),'utf8'));
 assert.equal(archived.status,'completed');assert.equal(archived.output,published.output);assert.equal(archived.usage.totalTokens,79);
 await f.service.runCycle(request.id,cycle.id,payload);
 const replay=f.engine.getRun(run.id);
 assert.equal(f.operationalCalls,1);assert.equal(f.calls.length,6);assert.equal(replay.usage.totalTokens,79);
 assert.equal(replay.events.filter(event=>event.data?.responseId===published.responseCycle.responseId&&event.data?.responseCycleFinal).length,1);
});
test('strict dispatch retains the unresolved preparatory dependency while still saving the proposed plan',async t=>{
 const f=await fixture(t,{unresolvedInference:true,executionGuardrails:true}),run=await f.execute();
 assert.equal(run.status,'blocked');assert.equal(f.operationalCalls,0);assert.deepEqual(f.calls,['viability','inference','plan']);
 assert.equal(run.planningUsage.totalTokens,33);
 const request=await f.store.get(run.responseCycle.requestId),plan=request.nodes.find(node=>node.kind==='plan');
 assert.equal(plan.readiness.cycle.analysisReady,true);assert.equal(plan.readiness.cycle.dispatchReady,false);
});

test('a public Plan-only rerun preserves the paused conversation and performs no operational work',async t=>{
 const f=await fixture(t),run=await f.execute({planningExecutionMode:'plan_only'});
 assert.equal(run.status,'completed');assert.equal(run.responseCycle.state,'paused_after_plan');assert.equal(f.operationalCalls,0);
 const request=await f.store.get(run.responseCycle.requestId),cycle=request.cycles[0],output=run.output;
 const updated=await f.service.runCycle(request.id,cycle.id,{expectedRequestRevision:request.revision,expectedCycleRevision:request.nodes.find(node=>node.id===cycle.id).revision,clientRequestId:'review-plan-again'});
 assert.equal(updated.cycles[0].state,'paused_after_plan');assert.equal(f.engine.getRun(run.id).status,'completed');
 assert.equal(f.engine.getRun(run.id).output,output);assert.equal(f.operationalCalls,0);assert.equal(f.calls.length,3);
});
test('an explicit model switch during a held request uses its new request and saved model profile',async t=>{
 const f=await fixture(t,{recoveringSource:true}),run=await f.execute();f.recoverSource();
 const next=f.engine.continueRun(run.id,{nodeId:'agent',message:'Continue with the selected free model.',model:'fixture::chosen',requestId:'switch-held-model'});
 await f.engine.executions.get(next.id);
 const finished=f.engine.getRun(next.id);assert.equal(finished.status,'completed',finished.error);
 assert.equal(finished.taskId,run.taskId);assert.equal(finished.workflow.nodes.find(node=>node.id==='agent').model,'fixture::chosen');
 assert.notEqual(finished.responseCycle.requestId,run.responseCycle.requestId);
 const request=await f.store.get(finished.responseCycle.requestId);
 assert.equal(request.cycles[0].executionProfile.model,'fixture::chosen');assert.equal(f.operationalCalls,1);
});
test('model evidence ignores symbolic aliases and unknown history cannot silently use the current default',async t=>{
 const f=await fixture(t),run=await f.execute(),saved=f.engine.runs.get(run.id),node=saved.workflow.nodes.find(node=>node.id==='agent');
 node.model='default';saved.nodes.agent.resolvedModel='default';
 const observed={type:'agent.event',nodeId:'agent',data:{type:'thread',model:'fixture::original'}};
 saved.events=[observed,{type:'agent.event',nodeId:'agent',data:{type:'thread',model:'default'}}];
 assert.equal(f.engine.recordedModel(saved,node),'fixture::original');
 saved.nodes.agent.resolvedModel='fixture::resolved';assert.equal(f.engine.recordedModel(saved,node),'fixture::resolved');
 saved.nodes.agent.resolvedModel='default';saved.events=[];
 f.settings.defaultModel='fixture::changed';
 assert.throws(()=>f.engine.continueRun(run.id,{nodeId:'agent',message:'Continue.',requestId:'unknown-history'}),{code:'CHAT_MODEL_HISTORY_UNKNOWN'});
 saved.status='failed';assert.throws(()=>f.engine.retryRun(run.id),{code:'CHAT_MODEL_HISTORY_UNKNOWN'});
 const selected=f.engine.continueRun(run.id,{nodeId:'agent',message:'Continue with the chosen free model.',model:'fixture::chosen',planningMode:'off',requestId:'explicit-history-choice'});
 await f.engine.executions.get(selected.id);
 assert.equal(f.engine.getRun(selected.id).workflow.nodes.find(node=>node.id==='agent').model,'fixture::chosen');
 assert.equal(saved.nodes.agent.resolvedModel,'default','historical evidence remains unchanged');
});


test('a correct 190 answer repairs mismatched coverage with the same model and no repeated operation',async t=>{
 let repaired=0;
 const f=await fixture(t,{resultValue:190,transformResponse:(body,{input,options})=>{
  if(input.module.kind!=='respond')return;
  assert.equal(options.responseOnly,true);assert.deepEqual(options.dynamicTools,[]);assert.equal(options.model,'fixture::free');
  if(!input.formatRepair)body.coverage[0].responseExcerpt='total_units 190 = 105+75+10';
  else{repaired++;assert.match(JSON.stringify(input.formatRepair),/response\.coverage\[0\]\.responseExcerpt/);assert.match(JSON.stringify(input.formatRepair),/verbatim/);}
 }}),run=await f.execute();
 assert.equal(run.status,'completed',run.error);assert.equal(run.output,'The result is 190.');assert.equal(repaired,1);assert.equal(f.operationalCalls,1);
 assert.deepEqual(f.calls,['viability','inference','plan','think','respond','respond']);
 const request=await f.store.get(run.responseCycle.requestId),attempts=request.attempts.filter(a=>a.node.kind==='respond');
 assert.equal(attempts.length,2);assert.equal(attempts[0].status,'failed');assert.equal(attempts[0].validation.code,'PLANNING_RESPONSE_FORMAT');assert.equal(attempts[1].status,'completed');
 assert.equal(run.planningAttempts.length,6);assert.equal(run.planningUsage.totalTokens,66);assert.equal(run.usage.totalTokens,83);
 const archived=JSON.parse(await readFile(path.join(f.dir,'conversations',run.id+'.json'),'utf8'));
 assert.equal(archived.output,run.output);assert.equal(archived.status,'completed');assert.equal(archived.usage.totalTokens,83);
});
test('coverage format repair remains bounded and preserves operational work when both responses are malformed',async t=>{
 const f=await fixture(t,{resultValue:190,transformResponse:(body,{input,options})=>{
  if(input.module.kind==='respond'){assert.deepEqual(options.dynamicTools,[]);body.coverage[0].responseExcerpt='This quotation does not occur in the delivered answer.';}
 }}),run=await f.execute();
 assert.equal(run.status,'failed');assert.equal(run.errorCode,'PLANNING_RESPONSE_FORMAT');assert.equal(f.operationalCalls,1);
 assert.equal(f.calls.filter(kind=>kind==='respond').length,2);assert.equal(run.planningUsage.totalTokens,66);assert.equal(run.usage.totalTokens,83);
 const request=await f.store.get(run.responseCycle.requestId);assert.equal(request.cycles[0].execution.state,'completed');
});
test('a retry that needs current evidence replaces the old failure in the original run and archive',async t=>{
 const f=await fixture(t,{failRespond:true,transformResponse:(body,{input})=>{if(input.module.kind==='respond')body.coverage[0].criterionId='unassessed';}}),run=await f.execute();
 assert.equal(run.status,'failed');assert.equal(run.errorCode,'PROVIDER_RATE_LIMIT');
 let request=await f.store.get(run.responseCycle.requestId),cycle=request.cycles[0];
 request=await f.service.runCycle(request.id,cycle.id,{expectedRequestRevision:request.revision,expectedCycleRevision:request.nodes.find(node=>node.id===cycle.id).revision,clientRequestId:'retry-into-current-evidence-check'});
 cycle=request.cycles[0];assert.equal(cycle.state,'needs_evidence');assert.equal(cycle.failure,null);assert.match(cycle.summary,/current assessed plan criterion/);
 const published=f.engine.getRun(run.id);assert.equal(published.status,'blocked');assert.equal(published.error,undefined);assert.equal(published.errorCode,undefined);
 assert.equal(published.responseCycle.error,undefined);assert.equal(published.responseCycle.responseCycle,undefined);assert.match(published.output,/current assessed plan criterion/);assert.doesNotMatch(published.output,/rate limited/);
 assert.equal(f.operationalCalls,1);assert.equal(f.calls.filter(kind=>kind==='respond').length,2);assert.equal(published.usage.totalTokens,79);
 assert.equal(published.events.filter(event=>event.data?.responseCycleFinal).length,run.events.filter(event=>event.data?.responseCycleFinal).length,'a blocked retry does not publish another final-answer event');
 const archived=JSON.parse(await readFile(path.join(f.dir,'conversations',run.id+'.json'),'utf8'));
 assert.equal(archived.status,'blocked');assert.equal(archived.output,published.output);assert.equal(archived.responseCycle.error,undefined);assert.equal(archived.usage.totalTokens,79);
});


// Replay a sanitized minimal body from the free-model inventory Feasibility response.
// It retains the unknown facts and source-coverage omission pattern, with fixture IDs and paths.
const recordedFeasibility = JSON.parse(await readFile(new URL('./fixtures/feasibility-source-coverage-20261031.json', import.meta.url), 'utf8'));
const recordedRequestId = recordedFeasibility.grounding.find(item => item.field === 'objective').sourceId;
const recordedContextId = recordedFeasibility.requirements[0].checkedSourceIds.find(id => id.startsWith('cycle:context:'));
const recordedDirectory = 'C:\\fixture\\inventory';
function feasibilitySources() {
  return [
    { id: recordedRequestId, kind: 'request_objective', text: recordedFeasibility.values.objective },
    { id: 'viability:task', kind: 'user_input', text: recordedFeasibility.values.objective },
    { id: 'viability:workflow', kind: 'source', text: JSON.stringify(workflow(76)) },
    { id: 'viability:continuity', kind: 'source', text: 'A different earlier fixture path returned total 190. Its rows do not establish the current CSV contents.' },
    { id: 'viability:profile', kind: 'source', text: 'No personal facts are required for this inventory fixture.' },
    { id: recordedContextId, kind: 'source', text: 'An operational worker can use local file tools after preparation. No current file observation is recorded.' }
  ];
}
function bindRecordedFeasibility(input, directory) {
  const ids = [input.sources.find(item => item.id.startsWith('request:'))?.id, input.sources.find(item => item.id.startsWith('cycle:context:'))?.id];
  assert.ok(ids.every(Boolean), 'the fixture captures the actual request and cycle context');
  return JSON.parse(JSON.stringify(recordedFeasibility)
    .replaceAll(recordedRequestId, ids[0]).replaceAll(recordedContextId, ids[1])
    .replaceAll(JSON.stringify(recordedDirectory).slice(1, -1), JSON.stringify(directory).slice(1, -1)));
}

test('recorded source-coverage omissions permit analysis without inventing checked sources or resolved facts', () => {
  const sources = feasibilitySources(), saved = { ...structuredClone(recordedFeasibility), sources };
  const before = structuredClone(saved);
  const result = evaluateResponseCycleStage('feasibility', saved, { sources, workflowNodeIds: ['agent'] });
  assert.equal(result.analysisReady, true);
  assert.equal(result.dispatchReady, false);
  assert.equal(result.state, 'needs_evidence');
  assert.equal(result.viability.state, 'needs_evidence');
  assert.equal(result.viability.issues.length, 2);
  assert.equal(result.viability.sourceCoverage.length, 2);
  assert.equal(result.unresolvedChecks.length, 2);
  assert.deepEqual(result.viability.sourceCoverage[0].missingSourceIds, ['viability:profile']);
  assert.equal(saved.requirements.every(item => item.resolution === 'unknown' && item.value === 'unobserved'), true);
  assert.deepEqual(saved, before, 'evaluation must not fill checkedSourceIds or rewrite the response');
  assert.doesNotThrow(() => validatePlanningModuleResponse({ node: { kind: 'viability' }, sources, workflowNodeIds: ['agent'] }, JSON.stringify(recordedFeasibility)),
    'a valid unresolved assessment is not a malformed-output repair request');
});

test('preparatory source-coverage handling still rejects unavailable, stale, invalid and unsupported evidence', () => {
  const sources = feasibilitySources();
  const check = (mutate, context = {}) => {
    const saved = { ...structuredClone(recordedFeasibility), sources: structuredClone(sources) };
    mutate(saved);
    const result = evaluateResponseCycleStage('feasibility', saved, { sources, workflowNodeIds: ['agent'], ...context });
    assert.equal(result.analysisReady, false);
    assert.equal(result.dispatchReady, false);
    return result;
  };
  check(saved => saved.requirements[0].checkedSourceIds.push('unavailable-source'));
  check(saved => saved.requirements[0].dependentNodeIds.push('outside-workflow'));
  check(saved => { saved.requirements[0].resolution = 'inference'; saved.requirements[0].value = 'An invented current total'; });
  check(saved => { saved.grounding = saved.grounding.filter(item => item.field !== 'objective'); });
  assert.equal(check(saved => { saved.sources[4].text = 'A different historical profile snapshot'; }).state, 'stale');
  assert.equal(check(() => {}, { sources: sources.filter(item => item.id !== 'viability:profile') }).state, 'stale');
  check(() => {}, { recoveryIssue: { message: 'The host could not read an attached source.' } });
});

test('automatic Chat carries the recorded unknowns into local read-write-reread work and checks its final answer', async t => {
  const operations = [];
  const f = await fixture(t, {
    resultValue: 76,
    operation: async (_options, { dir }) => {
      const input = await readFile(path.join(dir, 'input.csv'), 'utf8'); operations.push('read');
      const rows = input.trim().split(/\r?\n/).slice(1).map(line => {
        const [sku, opening, received, shipped] = line.split(',');
        return { sku, closing_units: Number(opening) + Number(received) - Number(shipped) };
      });
      const calculated = { rows, total_units: rows.reduce((sum, row) => sum + row.closing_units, 0) };
      await writeFile(path.join(dir, 'closing-units.json'), JSON.stringify(calculated)); operations.push('write');
      const reread = JSON.parse(await readFile(path.join(dir, 'closing-units.json'), 'utf8')); operations.push('reread');
      assert.deepEqual(reread, calculated);
      return JSON.stringify({ verified: true, ...reread });
    },
    transformResponse: (body, { input }) => {
      assert.equal(input.formatRepair, undefined, 'an unknown operational observation does not consume format-repair turns');
      if (input.module.kind === 'viability') Object.assign(body, bindRecordedFeasibility(input, f.dir));
    }
  });
  await writeFile(path.join(f.dir, 'input.csv'), 'sku,opening_units,received_units,shipped_units\nD,45,12,8\nE,20,3,11\nF,5,14,4\n');
  const run = await f.execute({ input: recordedFeasibility.values.objective.replaceAll(recordedDirectory, f.dir) });
  assert.equal(run.status, 'completed', run.error || run.output);
  assert.equal(run.output, 'The result is 76.');
  assert.deepEqual(operations, ['read', 'write', 'reread']);
  assert.equal(f.operationalCalls, 1);
  assert.deepEqual(f.calls, ['viability', 'inference', 'plan', 'think', 'respond']);
  assert.equal(run.planningUsage.samples, 5);
  assert.equal(run.usage.totalTokens, 72);
  const artifact = JSON.parse(await readFile(path.join(f.dir, 'closing-units.json'), 'utf8'));
  assert.deepEqual(artifact, { rows: [{ sku: 'D', closing_units: 49 }, { sku: 'E', closing_units: 12 }, { sku: 'F', closing_units: 15 }], total_units: 76 });
  const request = await f.store.get(run.responseCycle.requestId), cycle = request.cycles[0];
  const feasibility = request.nodes.find(node => node.id === cycle.stageNodeIds.feasibility);
  const final = request.nodes.find(node => node.id === cycle.stageNodeIds.respond);
  assert.equal(feasibility.readiness.cycle.analysisReady, true);
  assert.equal(feasibility.readiness.cycle.dispatchReady, false);
  assert.equal(feasibility.response.requirements.every(item => item.resolution === 'unknown' && item.value === 'unobserved'), true);
  assert.equal(feasibility.response.requirements[0].checkedSourceIds.includes('viability:profile'), false);
  assert.equal(final.readiness.cycle.analysisReady, true);
  assert.equal(final.readiness.cycle.outcome, 'satisfied');
  const plan = request.nodes.find(node => node.id === cycle.stageNodeIds.plan);
  const think = request.nodes.find(node => node.id === cycle.stageNodeIds.think);
  const finalContext = { sources: final.response.sources, workflowNodeIds: ['agent'],
    acceptanceCriteria: plan.response.acceptanceCriteria, criterionResults: think.response.criterionResults,
    execution: { required: true, state: 'pending' },
    prerequisites: [{ stageId: 'think', nodeId: think.id, responseId: think.response.id,
      responseRevision: think.response.revision, analysisReady: true, dispatchReady: false }] };
  const beforeExecution = evaluateResponseCycleStage('respond', final.response, finalContext);
  assert.equal(beforeExecution.state, 'awaiting_execution');
  assert.equal(beforeExecution.analysisReady, false, 'preparatory readiness cannot stand in for operational evidence');
  assert.equal(beforeExecution.dispatchReady, false);
  const unsupported = evaluateResponseCycleStage('respond', final.response, { ...finalContext,
    execution: { required: true, state: 'completed' },
    criterionResults: think.response.criterionResults.map(item => ({ ...item, assessment: 'uncertain' })) });
  assert.equal(unsupported.analysisReady, false);
  assert.match(unsupported.issues.join(' '), /unresolved criterion cannot be reported as achieved/);

  assert.equal((await f.archive.get(run.id)).output, run.output);
});

test('strict dispatch still holds recorded source-coverage omissions after saving a usable plan', async t => {
  const f = await fixture(t, { resultValue: 76, executionGuardrails: true, transformResponse: (body, { input }) => {
    if (input.module.kind === 'viability') Object.assign(body, bindRecordedFeasibility(input, f.dir));
  } });
  const run = await f.execute();
  assert.equal(run.status, 'blocked');
  assert.equal(f.operationalCalls, 0);
  assert.deepEqual(f.calls, ['viability', 'inference', 'plan']);
  const request = await f.store.get(run.responseCycle.requestId), cycle = request.cycles[0];
  const plan = request.nodes.find(node => node.id === cycle.stageNodeIds.plan);
  assert.equal(plan.readiness.cycle.analysisReady, true);
  assert.equal(plan.readiness.cycle.dispatchReady, false);
  assert.equal(request.nodes.find(node => node.id === cycle.stageNodeIds.feasibility).readiness.viability.issues.length, 2);
});


const workflowDiscovery = JSON.parse(await readFile(new URL('./fixtures/planning-workflow-discovery-20261031.json', import.meta.url), 'utf8'));
function workflowRequest(input, target = 'workflow') {
  const work = structuredClone(workflowDiscovery.request);
  const current = input.sources.find(item => item.id.startsWith('request:')).id;
  const feasibility = input.cycle?.prerequisites?.find(item => item.stageId === 'feasibility')?.sourceId || input.sources.find(item => item.kind === 'response')?.id;
  const context = input.sources.find(item => item.id.startsWith('cycle:context:')).id;
  work.sourceIds = work.sourceIds.map(id => id.startsWith('request:') ? current : id.startsWith('response:') ? feasibility : context);
  if (target !== undefined) work.executionTarget = target;
  return work;
}
function pendingWorkflowAnswer(body, input) {
  if (input.module.kind === 'think') for (const item of body.criterionResults) {
    item.assessment = 'uncertain'; item.rationale = 'The owning workflow must obtain the actual file observations.';
  }
  if (input.module.kind === 'respond') {
    const limitation = 'The owning workflow must read, write and verify the local inventory before this operational criterion can be satisfied.';
    body.values.answer = limitation;
    for (const item of body.coverage) Object.assign(item, { disposition: 'unresolved', responseExcerpt: limitation, limitation });
  }
}
async function inventoryOperation(options, { dir }) {
  await recordFixturePlan(options, { title: 'Read, calculate and verify the synthetic inventory', doneWhen: 'The saved JSON matches the rows observed through the actual workspace gateway.' });
  const workspace = async args => {
    const receipt = await options.onToolCall({ name: 'relay_workspace', arguments: args });
    assert.equal(receipt.success, true, receipt.contentItems?.[0]?.text);
    return JSON.parse(receipt.contentItems.find(item => item.type === 'inputText').text);
  };
  const unnumber = content => content.split(/\r?\n/).map(line => line.replace(/^\d+: /, '')).join('\n');
  const observed = await workspace({ action: 'read', path: path.join(dir, 'input.csv') });
  const rows = unnumber(observed.content).trim().split(/\r?\n/).slice(1).map(line => {
    const [sku, opening, received, shipped] = line.split(',');
    return { sku, closing_units: Number(opening) + Number(received) - Number(shipped) };
  });
  const calculated = { rows, total_units: rows.reduce((sum, row) => sum + row.closing_units, 0) };
  await workspace({ action: 'write', path: path.join(dir, 'closing-units.json'), text: JSON.stringify(calculated) });
  const reread = await workspace({ action: 'read', path: path.join(dir, 'closing-units.json') });
  const actual = JSON.parse(unnumber(reread.content));
  assert.deepEqual(actual, calculated);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'closing-units.json'), 'utf8')), actual);
  await finishFixturePlan(options, { summary: 'The workspace gateway read the inventory, wrote the calculated JSON and reread the saved result. Its observed total is '+actual.total_units+' and the saved rows equal the computed rows; no requested operation remains.' });
  return JSON.stringify({ verified: true, ...actual });
}
const writeInventory = dir => writeFile(path.join(dir, 'input.csv'), 'sku,opening_units,received_units,shipped_units\nD,45,12,8\nE,20,3,11\nF,5,14,4\n');

test('new provider routing is explicit and bounded while legacy bodies and public schemas stay unchanged', () => {
  const sources = [...feasibilitySources(), { id: 'response:feasibility-fixture', kind: 'response', text: 'The recorded feasibility finding is unresolved.' }], input = { module: { kind: 'inference' }, template: responseCycleTemplate('inference'), sources, cycle: {} };
  const body = response(input); body.subproblems = [workflowRequest(input)];
  delete body.subproblems[0].executionTarget;
  const original = structuredClone(body.subproblems[0]);
  const before = JSON.stringify(responseCycleResponseSchema('inference'));
  const parsed = parseResponseCycleResponse(body, 'inference');
  assert.deepEqual(parsed.subproblems[0], original, 'historical absent target must remain absent');
  const attempt = { node: { kind: 'inference' }, template: input.template, sources, workflowNodeIds: ['agent'], cycleContext: {} };
  const schema = planningModuleOutputSchema(attempt);
  assert.deepEqual(schema.properties.subproblems.items.properties.executionTarget.enum, ['analysis', 'workflow']);
  assert.ok(schema.properties.subproblems.items.required.includes('executionTarget'));
  assert.equal(JSON.stringify(responseCycleResponseSchema('inference')), before, 'attempt schema must not mutate frozen public catalogs');
  assert.throws(() => validatePlanningModuleResponse(attempt, JSON.stringify(body)), error => error.code === 'PLANNING_RESPONSE_FORMAT' && error.issues[0].path.endsWith('.executionTarget'));
  body.subproblems[0].executionTarget = 'workflow';
  assert.doesNotThrow(() => validatePlanningModuleResponse(attempt, JSON.stringify(body)));
  const legacy = { ...original };
  const bound = { cycles: [{ parentStageId: 'inference', key: legacy.key, request: legacy }] };
  const method = ResponseCycleService.prototype.assertSubproblemBindings;
  assert.doesNotThrow(() => method.call({}, bound, { id: 'inference', response: { subproblems: [{ ...legacy, executionTarget: 'analysis' }] } }));
  assert.throws(() => method.call({}, bound, { id: 'inference', response: body }), { code: 'RESPONSE_CYCLE_RECURSION' });
  attempt.cycleContext.children = [{ key: legacy.key, request: legacy }];
  assert.throws(() => validatePlanningModuleResponse(attempt, JSON.stringify(body)), { code: 'PLANNING_RESPONSE_FORMAT' });
});

test('recorded operational child pattern repairs its missing target once and reaches tools through the parent Plan', async t => {
  let repairs = 0;
  const f = await fixture(t, { resultValue: 76, operation: inventoryOperation, executionGuardrails: true, transformResponse: (body, { input }) => {
    if (input.module.kind === 'inference') {
      body.subproblems = [workflowRequest(input)];
      if (!input.formatRepair) delete body.subproblems[0].executionTarget;
      else { repairs++; assert.match(JSON.stringify(input.formatRepair), /executionTarget/); }
    }
  } });
  await writeInventory(f.dir);
  const run = await f.execute();
  assert.equal(run.status, 'completed', run.error || run.output);
  assert.equal(run.output, 'The result is 76.');
  assert.equal(repairs, 1);
  assert.equal(f.operationalCalls, 1);
  const request = await f.store.get(run.responseCycle.requestId), cycle = request.cycles[0];
  assert.equal(request.cycles.length, 1, 'workflow work must not create an analytical child');
  assert.equal(request.attempts.length, 6);
  assert.equal(request.attempts.filter(item => item.status === 'failed').length, 1);
  assert.equal(run.planningUsage.samples, 6); assert.equal(run.usage.totalTokens, 83);
  const inference = request.nodes.find(node => node.id === cycle.stageNodeIds.inference), plan = request.nodes.find(node => node.id === cycle.stageNodeIds.plan);
  assert.equal(inference.response.subproblems[0].executionTarget, 'workflow');
  assert.deepEqual(inference.readiness.cycle.unresolvedChildren, []);
  assert.deepEqual(plan.response.acceptanceCriteria, inference.response.subproblems[0].acceptanceCriteria);
  assert.ok(plan.response.steps.some(step => step.criterionIds.includes('ac-1')));
  assert.equal((await f.archive.get(run.id)).output, run.output);
  assert.equal(JSON.parse(await readFile(path.join(f.dir, 'closing-units.json'), 'utf8')).total_units, 76);
});

test('a useful analytical child can hand operational criteria to its owner without claiming they are achieved', async t => {
  const f = await fixture(t, { resultValue: 76, operation: inventoryOperation, executionGuardrails: true, transformResponse: (body, { input }) => {
    const child = input.cycle?.recursion?.depth > 0;
    if (input.module.kind === 'inference') {
      const work = workflowRequest(input, child ? 'workflow' : 'analysis');
      if (!child) { work.key = 'analytical-review'; work.title = 'Assess the bounded inventory approach'; work.objective = 'Assess the proposed inventory calculation and identify the remaining operational observations.'; }
      body.subproblems = [work];
    }
    if (child) pendingWorkflowAnswer(body, input);
  } });
  await writeInventory(f.dir);
  const run = await f.execute();
  assert.equal(run.status, 'completed', run.error || run.output); assert.equal(f.operationalCalls, 1);
  const request = await f.store.get(run.responseCycle.requestId), root = request.cycles.find(item => !item.parentCycleId), child = request.cycles.find(item => item.parentCycleId === root.id);
  assert.equal(request.cycles.length, 2, 'a child discovering workflow work must not create another analyst');
  const final = request.nodes.find(node => node.id === child.stageNodeIds.respond), plan = request.nodes.find(node => node.id === root.stageNodeIds.plan);
  assert.equal(child.state, 'completed', 'the analytical response is complete');
  assert.equal(final.readiness.cycle.outcome, 'unresolved');
  assert.equal(final.readiness.cycle.dispatchReady, false);
  assert.equal(final.response.coverage[0].disposition, 'unresolved');
  assert.equal(final.readiness.cycle.workflowHandoff.ownerCycleId, root.id);
  assert.deepEqual(final.readiness.cycle.workflowHandoff.criteria, plan.response.acceptanceCriteria);
  const context = planningCycleStageContext(request, root.stageNodeIds.plan);
  assert.equal(context.workflowRequests[0].origin.cycleId, child.id);
  assert.equal(context.workflowRequests[0].origin.responseId, request.nodes.find(node => node.id === child.stageNodeIds.inference).response.id);
  assert.deepEqual(context.requiredAcceptanceCriteria, plan.response.acceptanceCriteria);
  assert.equal(plan.readiness.cycle.dispatchReady, true, 'strict dispatch can perform pending work assigned to this exact owner');
  assert.equal(request.nodes.find(node => node.id === root.stageNodeIds.respond).readiness.cycle.outcome, 'satisfied');
});

test('workflow work without an operational owner remains an actionable analytical limitation', async t => {
  const f = await fixture(t, { transformResponse: (body, { input }) => {
    if (input.module.kind === 'inference') body.subproblems = [workflowRequest(input)];
    pendingWorkflowAnswer(body, input);
  } });
  let request = await f.store.create({ conversationId: 'no-owner', title: 'Inventory analysis', objective: 'Describe the local inventory work and its missing observations.', cwd: f.dir });
  request = await f.service.createCycle(request.id, { title: 'Inventory analysis', purpose: request.objective, planningExecutionMode: 'automatic', expectedRequestRevision: request.revision, clientRequestId: 'no-owner-cycle' });
  const cycle = request.cycles[0];
  request = await f.service.runCycle(request.id, cycle.id, { expectedRequestRevision: request.revision, expectedCycleRevision: request.nodes.find(node => node.id === cycle.id).revision, clientRequestId: 'no-owner-run' });
  const final = request.nodes.find(node => node.id === cycle.stageNodeIds.respond), plan = request.nodes.find(node => node.id === cycle.stageNodeIds.plan);
  assert.equal(request.cycles.length, 1); assert.equal(f.operationalCalls, 0);
  assert.equal(final.readiness.cycle.analysisReady, true);
  assert.equal(final.readiness.cycle.outcome, 'unresolved');
  assert.equal(final.readiness.cycle.dispatchReady, false);
  assert.equal(final.readiness.cycle.workflowHandoff, undefined);
  assert.match(final.response.values.answer, /must read, write and verify/);
  assert.deepEqual(plan.response.acceptanceCriteria.map(item => item.id), ['ac-1']);
  const context = planningCycleStageContext(request, final.id);
  const unsupported = structuredClone(final.response);
  unsupported.coverage[0].disposition = 'addressed'; unsupported.coverage[0].limitation = '';
  context.criterionResults = context.criterionResults.map(item => ({ ...item, assessment: 'satisfied' }));
  const result = evaluateResponseCycleStage('respond', unsupported, { ...context, sources: unsupported.sources });
  assert.equal(result.analysisReady, false);
  assert.match(result.issues.join(' '), /observed operational evidence/);
});

test('owned nested cancellation settles unfinished descendants and preserves completed and unrelated cycles', { timeout: 20000 }, async t => {
  let signalEntered; const entered = new Promise(resolve => { signalEntered = resolve; });
  let requestId;
  const analysis = (key, objective, input) => ({ key, title: objective, objective, reason: 'A bounded analytical fixture.', required: true, executionTarget: 'analysis', sourceIds: [input.sources[0].id], acceptanceCriteria: [{ id: 'answer', label: 'Bounded analytical result', description: 'Return the supplied bounded finding.', verification: 'response' }] });
  const f = await fixture(t, { transformResponse: async (body, { input, options }) => {
    if (input.module.kind !== 'inference') return;
    requestId = input.requestId;
    if (input.cycle.recursion.depth === 0) body.subproblems = [analysis('finished-branch', 'Complete the small analytical branch.', input), analysis('unfinished-branch', 'Refine the remaining analytical branch.', input)];
    else if (input.cycle.objective === 'Refine the remaining analytical branch.') body.subproblems = [analysis('deep-branch', 'Wait in the deepest analytical branch.', input)];
    else if (input.cycle.objective === 'Wait in the deepest analytical branch.') {
      signalEntered();
      await new Promise((resolve, reject) => {
        const cancel = () => reject(options.signal.reason || Object.assign(Error('Stopped'), { name: 'AbortError' }));
        if (options.signal.aborted) cancel(); else options.signal.addEventListener('abort', cancel, { once: true });
      });
    }
  } });
  const accepted = f.engine.startRun({ workflow: workflow(), input: 'Cancel the bounded nested fixture after its deepest analyst starts.', requestId: 'nested-cancel-test' });
  const execution = f.engine.executions.get(accepted.id);
  await entered;
  let request = await f.store.get(requestId), root = request.cycles.find(item => !item.parentCycleId);
  const completed = request.cycles.find(item => item.key === 'finished-branch');
  assert.equal(completed.state, 'completed');
  const completedResponse = request.nodes.find(node => node.id === completed.stageNodeIds.respond).response.id;
  request = await f.service.createCurrent(requestId, { title: 'Unrelated analysis', purpose: 'An independent bounded analysis.', clientRequestId: 'unrelated-analysis' }, { internal: true });
  const unrelatedId = request.cycleAction.cycleId;
  f.engine.cancelRun(accepted.id); await execution;
  const run = f.engine.getRun(accepted.id);
  assert.equal(run.status, 'cancelled'); assert.equal(run.settled, true); assert.equal(f.operationalCalls, 0);
  request = await f.store.get(requestId);
  assert.equal(request.attempts.some(item => ['queued', 'running'].includes(item.status)), false);
  const owned = request.responseCycle.cycles.filter(item => item.id === root.id || item.parentCycleId);
  assert.equal(owned.find(item => item.id === completed.id).state, 'completed');
  assert.equal(request.nodes.find(node => node.id === completed.stageNodeIds.respond).response.id, completedResponse);
  assert.equal(owned.filter(item => item.id !== completed.id).every(item => item.state === 'cancelled'), true);
  assert.equal(request.responseCycle.cycles.find(item => item.id === unrelatedId).state, 'pending');
  const legacy = structuredClone(request);
  const oldLabel = legacy.responseCycle.cycles.find(item => item.key === 'deep-branch'); oldLabel.state = 'running';
  assert.equal(projectPlanningRequest(legacy).cycles.find(item => item.id === oldLabel.id).state, 'cancelled');
  assert.equal(oldLabel.state, 'running', 'read projection must not rewrite historical metadata');
});


const usageGate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return{promise,release};};
async function waitForUsage(check){
  const deadline=Date.now()+7000;
  while(Date.now()<deadline){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.fail('The held usage fixture did not reach its expected state.');
}
test('live run totals include Feasibility, failed format output and its repair before final settlement', {timeout:20000}, async t=>{
  const inference=usageGate(),repair=usageGate(),publish=usageGate(),entered={};let workspaceCalls=0;
  const f=await fixture(t,{resultValue:76,executionGuardrails:true,operation:async(options,context)=>{
    const gateway=options.onToolCall;options.onToolCall=(call,scope)=>{if(call.name==='relay_workspace')workspaceCalls++;return gateway(call,scope);};
    return inventoryOperation(options,context);
  },transformResponse:async(body,{input})=>{
    if(input.module.kind==='inference'){entered.inference=true;await inference.promise;}
    if(input.module.kind==='respond'){
      if(!input.formatRepair)body.coverage[0].responseExcerpt='A quotation absent from the final answer.';
      else{entered.repair=true;await repair.promise;}
    }
  }});
  await writeInventory(f.dir);
  const finish=f.service.finishRun.bind(f.service);
  f.service.finishRun=async(...args)=>{const result=await finish(...args);entered.publish=true;await publish.promise;return result;};
  const notifications=[];f.engine.on('event',event=>{if(event.type==='run.updated')notifications.push(event);});
  const accepted=f.engine.startRun({workflow:workflow(76),input:'Calculate and verify the supplied inventory.',requestId:'live-planning-usage'});
  const execution=f.engine.executions.get(accepted.id);
  try{
    await waitForUsage(()=>entered.inference);
    let live=await waitForUsage(()=>{const run=f.engine.getRun(accepted.id);return run.planningAttempts?.length===1&&run;});
    assert.equal(live.settled,false);assert.equal(live.responseCycle,undefined,'Feasibility is counted before the operational binding is exposed');
    assert.equal(live.planningUsage.totalTokens,11);assert.equal(live.usage.totalTokens,11);assert.equal(f.operationalCalls,0);
    assert.ok(notifications.some(event=>event.runId===accepted.id&&event.data.settled===false&&event.data.planningUsage.totalTokens===11),'the live SSE event includes the new total');
    inference.release();
    await waitForUsage(()=>entered.repair);
    live=await waitForUsage(()=>{const run=f.engine.getRun(accepted.id);return run.planningAttempts?.length===5&&run;});
    assert.equal(live.settled,false);assert.equal(live.planningUsage.totalTokens,55);assert.equal(live.operationalUsage.totalTokens,17);assert.equal(live.usage.totalTokens,72);
    const request=await f.store.get(live.responseCycle.requestId),failed=request.attempts.find(item=>item.repairAttemptId);
    assert.equal(failed.status,'failed');assert.ok(live.planningAttempts.some(item=>item.attemptId===failed.id),'the failed original is counted while its repair is held');
    repair.release();
    await waitForUsage(()=>entered.publish);
    live=await waitForUsage(()=>{const run=f.engine.getRun(accepted.id);return run.planningAttempts?.length===6&&run;});
    assert.equal(live.settled,false);assert.equal(live.planningUsage.totalTokens,66);assert.equal(live.usage.totalTokens,83);
    const savedIds=live.planningAttempts.map(item=>item.attemptId);
    const event={data:{requestId:live.responseCycle.requestId,workerStatus:'completed'}};
    f.service.runner.emit('updated',event);f.service.runner.emit('updated',event);
    await Promise.allSettled([...f.service.usageUpdates.values()]);
    assert.deepEqual(f.engine.getRun(accepted.id).planningAttempts.map(item=>item.attemptId),savedIds,'duplicate notifications do not add measurements');
    publish.release();await execution;await f.archive.chain;
    const final=f.engine.getRun(accepted.id);
    assert.equal(final.status,'completed');assert.equal(final.settled,true);assert.equal(final.output,'The result is 76.');
    assert.equal(final.planningUsage.totalTokens,66);assert.equal(final.usage.totalTokens,83);assert.deepEqual(final.planningAttempts.map(item=>item.attemptId),savedIds,'final capture is idempotent');
    assert.deepEqual(f.calls,['viability','inference','plan','think','respond','respond']);assert.equal(f.operationalCalls,1);assert.equal(workspaceCalls,3,'only the intended read/write/read operations ran');
    assert.equal((await f.archive.get(final.id)).usage.totalTokens,83);
    const published=notifications.length;f.service.runner.emit('updated',event);await Promise.allSettled([...f.service.usageUpdates.values()]);
    assert.equal(notifications.length,published,'late accounting does not republish a settled historical run');
    const listeners=f.service.runner.listenerCount('updated');await f.service.close();
    assert.equal(f.service.runner.listenerCount('updated'),listeners-1);assert.equal(f.service.usageUpdates.size,0);
    f.service.runner.emit('updated',event);assert.equal(f.service.usageUpdates.size,0,'close removes the accounting subscription');
  }finally{inference.release();repair.release();publish.release();await execution;}
});
test('planning usage follows the bound owner and excludes separate linked descendants and old attempts',async()=>{
  const run={id:'owner-run',planningAttempts:[]},service={runBindings:new Map([['owner-run',{requestId:'usage-request',cycleId:'root',excludedAttemptIds:['old']} ]])};
  const cycles=[
    {id:'root',linkedRunId:'owner-run',stageNodeIds:{inference:'root-node'}},
    {id:'owned',parentCycleId:'root',stageNodeIds:{inference:'owned-node'}},
    {id:'foreign',parentCycleId:'root',linkedRunId:'other-run',stageNodeIds:{inference:'foreign-node'}},
    {id:'foreign-child',parentCycleId:'foreign',stageNodeIds:{inference:'foreign-child-node'}}
  ];
  const measured=(id,nodeId,total,status='completed')=>({id,nodeId,status,metadata:{usage:tokenUsageMeasurement({totalTokens:total})}});
  const request={id:'usage-request',cycles,nodes:cycles.map(cycle=>({id:cycle.stageNodeIds.inference,cycleId:cycle.id})),attempts:[
    measured('old','root-node',100),measured('root-current','root-node',11),measured('owned-current','owned-node',7),
    measured('owned-failed','owned-node',3,'failed'),measured('foreign-current','foreign-node',200),measured('foreign-child-current','foreign-child-node',300),
    measured('still-running','owned-node',50,'running')
  ]};
  await ResponseCycleService.prototype.captureRunUsage.call(service,run,{request});
  assert.deepEqual(run.planningAttempts.map(item=>item.attemptId),['root-current','owned-current','owned-failed']);assert.equal(run.planningUsage.totalTokens,21);
  await ResponseCycleService.prototype.captureRunUsage.call(service,run,{request});assert.equal(run.planningUsage.totalTokens,21);assert.equal(run.planningAttempts.length,3);
});
test('live usage refresh rechecks bindings after reads and isolates accounting failures from run failure',async()=>{
  const runner=new EventEmitter();runner.start=()=>{throw Error('No provider call belongs to accounting.');};
  let gate=usageGate(),readStarted=false,notifyCalls=0;
  const run={id:'live-run',settled:false,error:'Original stage failure',status:'running',planningAttempts:[]};
  const engine={runs:new Map([[run.id,run]]),snapshot:structuredClone,notify:()=>{notifyCalls++;}};
  const store={runtimeWriter:()=>({}),get:async()=>{readStarted=true;return gate.promise;}};
  const service=new ResponseCycleService({store,runner,engine});
  const request={id:'request-one',cycles:[{id:'cycle-one',linkedRunId:run.id,stageNodeIds:{inference:'stage-one'}}],nodes:[{id:'stage-one',cycleId:'cycle-one'}],attempts:[{id:'attempt-one',nodeId:'stage-one',status:'completed',metadata:{usage:planUsage}}]};
  service.runBindings.set(run.id,{requestId:request.id,cycleId:'cycle-one',excludedAttemptIds:[]});
  try{
    runner.emit('updated',{data:{requestId:request.id,workerStatus:'completed'}});await waitForUsage(()=>readStarted);
    service.runBindings.set(run.id,{requestId:'request-two',cycleId:'cycle-two',excludedAttemptIds:[]});gate.release(request);await Promise.allSettled([...service.usageUpdates.values()]);
    assert.deepEqual(run.planningAttempts,[]);assert.equal(notifyCalls,0,'changed bindings never inherit the old request total');
    gate=usageGate();readStarted=false;service.runBindings.set(run.id,{requestId:request.id,cycleId:'cycle-one',excludedAttemptIds:[]});
    runner.emit('updated',{data:{requestId:request.id,workerStatus:'completed'}});await waitForUsage(()=>readStarted);run.settled=true;gate.release(request);await Promise.allSettled([...service.usageUpdates.values()]);
    assert.deepEqual(run.planningAttempts,[]);assert.equal(notifyCalls,0,'a run settling during a read is not republished');
    run.settled=false;store.get=async()=>{throw Object.assign(Error('Fixture accounting read failed'),{code:'FIXTURE_USAGE_READ'});};
    runner.emit('updated',{data:{requestId:request.id,workerStatus:'failed'}});await Promise.allSettled([...service.usageUpdates.values()]);
    assert.equal(run.error,'Original stage failure');assert.equal(run.planningUsageError.code,'FIXTURE_USAGE_READ');
    store.get=async()=>request;runner.emit('updated',{data:{requestId:request.id,workerStatus:'completed'}});await Promise.allSettled([...service.usageUpdates.values()]);
    assert.equal(run.planningUsage.totalTokens,11);assert.equal(run.planningUsageError,undefined);assert.equal(notifyCalls,1);
  }finally{gate.release(request);await service.close();}
  assert.equal(runner.listenerCount('updated'),0);assert.equal(service.usageUpdates.size,0);
});
