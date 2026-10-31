import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime,planningModuleOutputSchema,planningModulePrompt,planningFormatDiagnostic,validatePlanningModuleResponse} from '../lib/planning-browser-runtime.mjs';
import {ResponseCycleService} from '../lib/response-cycle.mjs';
import {parseModuleResponse,planningModuleTemplate,planningResponseBody,projectPlanningRequest} from '../public/planning-browser-model.mjs';
import {parseResponseCycleResponse,evaluateResponseCycleStage,RESPONSE_CYCLE_STAGES} from '../public/response-cycle-model.mjs';
import {planningReadableFindingIssues,validatePlanningReadableFindings} from '../public/task-viability-model.mjs';

const actual=JSON.parse(await readFile(new URL('./fixtures/planning-reference-only-inference.json',import.meta.url),'utf8'));
const hash=text=>createHash('sha256').update(text).digest('hex');
const clone=value=>structuredClone(value),inputOf=options=>JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n')+2));
const fact='Alpha takes 20–30 minutes; Beta takes 40–50. Alpha is faster by a plausible 10–30 minutes.';
function readable(input){
  const kind=input.module.kind,sourceId=input.sources.find(source=>source.kind==='user_request')?.id||input.sources[0].id;
  const stage=RESPONSE_CYCLE_STAGES.find(stage=>stage.kind===kind),body={values:Object.fromEntries(input.template.fields.map(field=>[field.id,field.id==='unknowns'||field.id==='unresolvedDependencies'?'None material under the supplied estimates.':fact])),grounding:input.template.fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId})),openQuestions:[],challengeResponses:[],checks:stage.checks.map(check=>({id:check.id,assessment:'supported',sourceIds:[sourceId],note:fact})),subproblems:[],childResults:[]};
  if(kind==='inference')body.inferences=[{id:'range-comparison',claim:fact,basis:'inferred',sourceIds:[sourceId],limitation:'These are ranges from the supplied estimates, not exact measured durations.'}];
  if(kind==='plan')Object.assign(body,{acceptanceCriteria:[{id:'faster-range',label:'Compare the supplied ranges',description:fact,verification:'response',accuracy:{mode:'bounded_estimate',tolerance:'Use the supplied duration ranges, without a point estimate.',decisionThreshold:'Alpha is faster throughout the supplied ranges.',evidenceNeeded:'The two supplied ranges.',consequence:'Reversing the comparison would give the wrong recommendation.',unknownPolicy:'range',stopWhen:'The supplied ranges establish the recommendation and plausible savings.'}}],steps:[{id:'explain',label:'Explain the range comparison',description:'Recommend Alpha and state the 10–30 minute plausible saving.',dependsOn:[],criterionIds:['faster-range'],sourceIds:[sourceId]}]});
  return body;
}
async function fixture(t,handler){
  const dir=await mkdtemp(path.join(os.tmpdir(),'planning-readable-')),store=await new PlanningBrowserStore({dataDir:dir}).init(),calls=[];
  const runtime={runAgent:async options=>{const input=inputOf(options);calls.push({options,input});return {output:JSON.stringify(await handler(input,calls.length,options)),threadId:'fixture-'+calls.length,model:options.model};}};
  const runner=new PlanningBrowserRuntime({store,runtime,defaultCwd:dir,getSettings:()=>({maxSubagents:2})});
  t.after(async()=>{await runner.close();await store.close();await rm(dir,{recursive:true,force:true});});
  return {dir,store,runner,calls};
}

test('the actual accepted source-only Inference is rejected with captured context and remains structurally inspectable',()=>{
  const body=planningResponseBody(actual.response),sources=actual.attempt.sources;
  assert.doesNotThrow(()=>parseModuleResponse(body,'inference'));
  assert.throws(()=>parseModuleResponse(body,'inference',{sources}),{code:'PLANNING_RESPONSE_READABILITY'});
  assert.throws(()=>parseResponseCycleResponse(body,'inference',{sources}),{code:'PLANNING_RESPONSE_READABILITY'});
  assert.throws(()=>validatePlanningModuleResponse(actual.attempt,JSON.stringify(body)),{code:'PLANNING_RESPONSE_READABILITY'});
  const evaluated=evaluateResponseCycleStage('inference',actual.response,{...actual.attempt.cycleContext,sources,nodeRevision:actual.response.nodeRevision});
  assert.equal(evaluated.state,'needs_evidence');assert.equal(evaluated.analysisReady,false);assert.equal(evaluated.dispatchReady,false);
  const issues=planningReadableFindingIssues(body,sources);assert.equal(issues.length,8);assert.ok(issues.some(issue=>issue.path==='checks[0].note'));
  const diagnostic=planningFormatDiagnostic(actual.attempt,JSON.stringify(body),Object.assign(Error('Readable finding required.'),{code:'PLANNING_RESPONSE_READABILITY',issues}));assert.deepEqual(diagnostic.issues,issues);
  assert.match(planningModulePrompt(actual.attempt),/Explanatory values fields and check notes/);
  assert.match(planningModuleOutputSchema(actual.attempt).properties.checks.items.properties.note.description,/readable finding/);
});

test('the actual failed Plan snapshots no longer constrain prose or local criterion IDs to evidence IDs',()=>{
  for(const saved of actual.planAttempts){
    const attempt={...actual.attempt,...saved,node:{kind:'plan'},template:planningModuleTemplate('plan')},schema=planningModuleOutputSchema(attempt);
    assert.equal(schema.properties.values.properties.approach.enum,undefined);
    assert.equal(schema.properties.acceptanceCriteria.items.properties.id.enum,undefined);
    assert.equal(schema.properties.steps.items.properties.id.enum,undefined);
    const diagnostic=planningFormatDiagnostic(attempt,attempt.partialOutput,Error(attempt.validation.message));
    assert.equal(diagnostic.issues.some(issue=>/values\.|acceptanceCriteria\[\d+\]\.(id|label|description)/.test(issue.path)&&/declared values|identifiers/.test(issue.message)),false);
    assert.throws(()=>parseModuleResponse(attempt.partialOutput,'plan'),{code:'RESPONSE_CYCLE_INVALID'});
  }
});

test('only captured-reference-only explanations are rejected; useful terse findings and exact requested data remain valid',()=>{
  const sources=[{id:'response:alpha'},{id:'source:beta'},{id:'source:with.[punctuation]'}];
  for(const value of ['response:alpha','`response:alpha`','[response:alpha], source:beta','1. response:alpha\n2. source:beta','response:alpha and source:beta','source:with.[punctuation]'])assert.equal(planningReadableFindingIssues({values:{interpretation:value}},sources).length,1,value);
  for(const value of ['None material under the supplied premises.','Alpha is faster.','The evidence is response:alpha.','response:alpha supports the range.','response:alpha_suffix','response:unknown'])assert.doesNotThrow(()=>validatePlanningReadableFindings({values:{interpretation:value}},sources),value);
  assert.doesNotThrow(()=>validatePlanningReadableFindings({values:{answer:'response:alpha',observedResult:'source:beta',claim:'response:alpha'},requirements:[{value:'source:beta'}]},sources));
  const checkOnly={values:{interpretation:'None material.'},checks:[{note:'source:beta'}]};assert.throws(()=>validatePlanningReadableFindings(checkOnly,sources),error=>error.code==='PLANNING_RESPONSE_READABILITY'&&error.issues[0].path==='checks[0].note');
});

test('typed explanations reject source-only text while exact identifier findings remain usable',()=>{
  const sources=[{id:'source:beta'}];
  const locations={checks:['note'],challengeResponses:['note'],requirements:['rationale'],inferences:['limitation'],acceptanceCriteria:['description'],steps:['description'],criterionResults:['rationale'],childResults:['usedFor'],coverage:['limitation'],subproblems:['objective','reason']};
  for(const [collection,fields]of Object.entries(locations))for(const field of fields){
    const body={[collection]:[{[field]:'`source:beta`'}]},expectedPath=collection+'[0].'+field;
    assert.throws(()=>validatePlanningReadableFindings(body,sources),error=>error.code==='PLANNING_RESPONSE_READABILITY'&&error.issues[0].path===expectedPath,expectedPath);
    body[collection][0][field]='The supplied range is sufficient for this comparison.';
    assert.doesNotThrow(()=>validatePlanningReadableFindings(body,sources),expectedPath);
  }
  assert.throws(()=>validatePlanningReadableFindings({subproblems:[{acceptanceCriteria:[{description:'source:beta'}]}]},sources),error=>error.issues[0].path==='subproblems[0].acceptanceCriteria[0].description');
  assert.doesNotThrow(()=>validatePlanningReadableFindings({values:{answer:'source:beta',observedResult:'source:beta',claim:'source:beta'},requirements:[{value:'source:beta'}],inferences:[{claim:'source:beta'}],childResults:[{summary:'source:beta',sourceId:'source:beta'}],coverage:[{responseExcerpt:'source:beta'}]},sources));
});

test('source-only Plan descriptions cannot be saved by a human or accepted from the response worker',async t=>{
  const f=await fixture(t,()=>{throw Error('Validation must not start provider work.');});
  let request=await f.store.create({conversationId:'plan-description-fixture',title:'Range comparison',objective:fact});
  request=await f.store.addNode(request.id,{id:'plan',kind:'plan',title:'Plan the range comparison',prompt:fact});
  const sources=[{id:'request:'+request.id,kind:'user_request'}],input={module:{kind:'plan'},template:planningModuleTemplate('plan'),sources};
  for(const collection of ['acceptanceCriteria','steps']){
    const body=readable(input);body[collection][0].description=sources[0].id;
    assert.throws(()=>validatePlanningModuleResponse({node:{kind:'plan'},sources},JSON.stringify(body)),{code:'PLANNING_RESPONSE_READABILITY'});
    await assert.rejects(()=>f.store.recordHumanResponse(request.id,'plan',body,{expectedNodeRevision:1}),{code:'PLANNING_RESPONSE_READABILITY'});
    const saved=await f.store.get(request.id);assert.equal(saved.responses.length,0);assert.equal(saved.nodes[0].revision,1);
  }
  const body=readable(input);assert.doesNotThrow(()=>validatePlanningModuleResponse({node:{kind:'plan'},sources},JSON.stringify(body)));
  const saved=await f.store.recordHumanResponse(request.id,'plan',body,{expectedNodeRevision:1});assert.equal(saved.responses.length,1);assert.equal(f.calls.length,0);
});

test('every durable response writer rejects source-only explanatory fields without recording success',async t=>{
  for(const actor of ['human','external','supervisor','runtime'])await t.test(actor,async t=>{
    const f=await fixture(t,()=>{throw Error('Writer tests must not start provider work.');});
    let request=await f.store.create({conversationId:'writer-fixture',title:'Range comparison',objective:fact});request=await f.store.addNode(request.id,{id:'inference',kind:'inference',title:'Interpret the ranges',prompt:fact});
    const sourceId='request:'+request.id,body=readable({module:{kind:'inference'},template:planningModuleTemplate('inference'),sources:[{id:sourceId,kind:'user_request'}]});body.values.interpretation=sourceId;
    let action,settle;
    if(actor==='human')action=()=>f.store.recordHumanResponse(request.id,'inference',body,{expectedNodeRevision:1});
    if(actor==='external')action=()=>f.store.externalWriter().recordResponse(request.id,'inference',body,{expectedNodeRevision:1,actor:{type:'external-agent',id:'fixture-connection'},receipt:{jobId:'fixture-job',connectionId:'fixture-connection',requestId:'fixture-request',tool:'fixture-tool'}});
    if(actor==='supervisor')action=()=>f.store.runtimeWriter().recordSupervisedResponse(request.id,'inference',body,{expectedNodeRevision:1,actor:{type:'agent',id:'fixture-supervisor'}});
    if(actor==='runtime'){
      const writer=f.store.runtimeWriter(),claim=await writer.beginAttempt(request.id,'inference',{expectedNodeRevision:1,ownerId:'fixture-worker'});
      action=()=>writer.recordResponse(request.id,claim.attempt.id,{output:JSON.stringify(body),metadata:{runId:'fixture-run',executionNodeId:'inference'}});
      settle=()=>writer.cancel(request.id,claim.attempt.id,{message:'Synthetic writer fixture complete.'});
    }
    await assert.rejects(action(),{code:'PLANNING_RESPONSE_READABILITY'});const saved=await f.store.get(request.id);assert.equal(saved.responses.length,0);assert.equal(saved.nodes[0].revision,1);assert.equal(f.calls.length,0);await settle?.();
  });
});

test('a source-only finding can receive exactly the existing format repair with unchanged capture and original failure retained',async t=>{
  const f=await fixture(t,(input,index)=>{const body=readable(input);if(index===1)body.values.interpretation=input.sources[0].id;return body;});
  let request=await f.store.create({conversationId:'repair-fixture',title:'Range comparison',objective:fact});request=await f.store.addNode(request.id,{id:'inference',kind:'inference',title:'Interpret the ranges',prompt:fact});
  const claim=await f.runner.start({requestId:request.id,nodeId:'inference',expectedNodeRevision:1,clientRequestId:'readability-repair',model:'fixture::fast'}),result=await f.runner.wait(request.id,claim.attempt.id),saved=await f.store.get(request.id);
  assert.equal(f.calls.length,2);assert.equal(result.attempt.status,'completed');assert.equal(saved.attempts[0].validation.code,'PLANNING_RESPONSE_READABILITY');assert.equal(saved.attempts[1].repairOf,saved.attempts[0].id);assert.deepEqual(saved.attempts[1].sources,saved.attempts[0].sources);assert.match(saved.attempts[0].partialOutput,new RegExp(request.id));assert.equal(saved.responses.length,1);
});

test('the saved historical failure stays readable and an explicit rerun keeps valid Feasibility while replacing only Inference and Plan',async t=>{
  const f=await fixture(t,input=>readable(input)),source=actual.attempt.sources.find(source=>source.kind==='user_request'),contextSource=actual.attempt.sources.find(source=>source.id.startsWith('cycle:context:')),priorSource=actual.attempt.sources.find(source=>source.kind==='response'),cycleId=actual.attempt.cycleContext.cycleId;
  let request=await f.store.create({id:actual.attempt.requestId,conversationId:'historical-fixture',title:actual.attempt.cycleContext.title,objective:source.text,cwd:f.dir});
  const stages=Object.fromEntries(RESPONSE_CYCLE_STAGES.map(stage=>[stage.id,cycleId+'-'+stage.id])),cycle={id:cycleId,title:actual.attempt.cycleContext.title,objective:actual.attempt.cycleContext.objective,stageNodeIds:stages,parentCycleId:null,parentStageId:null,depth:0,planningExecutionMode:'plan_only',state:'failed',acceptanceCriteria:[],sourceIds:null,executionProfile:actual.attempt.cycleExecutionProfile,execution:{required:false,state:'not_required'}};
  await f.store.runtimeWriter().configureResponseCycle(request.id,{createCycle:cycle,rootPatch:{rootCycleId:cycleId}});
  const raw=JSON.parse(await readFile(f.store.file(request.id),'utf8')),body=JSON.parse(priorSource.text),beforeId=priorSource.responseId;
  raw.provenance=clone(source.provenance);raw.sources=[clone(contextSource)];
  raw.responses=[{id:beforeId,nodeId:stages.feasibility,kind:'viability',revision:1,nodeRevision:1,...body,inputs:[],sources:[clone(source),clone(contextSource)],provenance:{kind:'human',author:'synthetic historical fixture',at:'2026-10-30T00:00:00Z',contentHash:hash(JSON.stringify(body))},verifiedAction:false},clone(actual.response)];
  raw.attempts=[clone(actual.attempt)];raw.nodes.find(node=>node.id===stages.inference).revision=actual.response.nodeRevision;
  raw.edges=actual.attempt.inputs.map(input=>({id:input.edgeId,kind:'consumes',from:stages.inference,to:input.nodeId,sourceResponseId:input.responseId,sourceResponseRevision:input.responseRevision,freshness:'latest'}));
  await writeFile(f.store.file(request.id),JSON.stringify(raw));
  request=await f.store.get(request.id);const before=request.nodes.find(node=>node.id===stages.feasibility),bad=request.nodes.find(node=>node.id===stages.inference);
  assert.equal(before.readiness.cycle.analysisReady,true);assert.equal(bad.readiness.state,'needs_evidence');assert.equal(bad.readiness.cycle.analysisReady,false);assert.deepEqual(bad.response.values,actual.response.values);
  const service=new ResponseCycleService({store:f.store,runner:f.runner});t.after(()=>service.close());
  const done=await service.runCycle(request.id,cycleId,{expectedRequestRevision:request.revision,expectedCycleRevision:request.nodes.find(node=>node.id===cycleId).revision,clientRequestId:'explicit-fix-historical'});
  assert.deepEqual(f.calls.map(call=>call.input.module.kind),['inference','plan']);assert.equal(done.cycles[0].state,'paused_after_plan');assert.equal(done.nodes.find(node=>node.id===stages.feasibility).response.id,beforeId);
  assert.ok(done.responses.some(response=>response.id===actual.response.id));assert.notEqual(done.nodes.find(node=>node.id===stages.inference).response.id,actual.response.id);assert.equal(done.nodes.find(node=>node.id===stages.plan).response.acceptanceCriteria[0].accuracy.mode,'bounded_estimate');
});
