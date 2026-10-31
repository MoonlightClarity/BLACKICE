import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime,planningModuleOutputSchema,planningModulePrompt,planningFormatDiagnostic,validatePlanningModuleResponse,PLANNING_MAX_FORMAT_REPAIRS} from '../lib/planning-browser-runtime.mjs';
import {ResponseCycleService} from '../lib/response-cycle.mjs';
import {parseModuleResponse} from '../public/planning-browser-model.mjs';
import {RESPONSE_CYCLE_STAGES} from '../public/response-cycle-model.mjs';

const actual=JSON.parse(await readFile(new URL('./fixtures/planning-invalid-feasibility.json',import.meta.url),'utf8'));
const inputOf=options=>JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n')+2));
const profile={model:'fixture-free::small-fast',effort:'default',serviceTier:'default'};
const criterion={id:'room-choice',label:'Qualifying room',description:'Identify South from the supplied fictional capacities and show the two-seat difference.',verification:'response',accuracy:{mode:'exact',tolerance:'',decisionThreshold:'At least five seats.',evidenceNeeded:'The capacities supplied in the fictional task.',consequence:'Choosing fewer than five seats would fail the task.',unknownPolicy:'block',stopWhen:'The supplied capacities determine the qualifying room and difference.'}};
function correct(input){
  const sourceId=input.sources.find(source=>source.kind==='user_request')?.id||input.sources[0].id;
  const body={values:Object.fromEntries(input.template.fields.map(field=>[field.id,field.id==='objective'?'Choose the fictional room that seats five from the supplied capacities.':'The supplied fictional facts support South with 6 seats; North has 4, a difference of 2.'])),grounding:input.template.fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId})),openQuestions:[],challengeResponses:[]};
  if(input.module.kind==='viability')return {...body,requirements:[{id:'capacity',label:'Room capacity',importance:'essential',basis:'task',consequence:'The selected room must seat five.',resolution:'observed',value:'North has 4 seats; South has 6 seats.',sourceIds:[sourceId],checkedSourceIds:input.sources.filter(source=>source.kind!=='response').map(source=>source.id),rationale:'These exact fictional capacities were supplied in the request.',inferable:false,omissionAllowed:false,question:'',dependentNodeIds:[],accuracy:criterion.accuracy}]};
  const stage=RESPONSE_CYCLE_STAGES.find(stage=>stage.kind===input.module.kind);
  Object.assign(body,{checks:stage.checks.map(check=>({id:check.id,assessment:check.when==='effects'?'not_applicable':'supported',sourceIds:check.grounding==='required'&&check.when!=='effects'?[sourceId]:[],note:'The supplied scenario supports this bounded analytical check.'})),subproblems:[],childResults:[]});
  if(input.module.kind==='inference')body.inferences=[{id:'qualifying-room',claim:'Only South can seat five; 6 minus 4 is 2.',basis:'inferred',sourceIds:[sourceId],limitation:'This conclusion is scoped to the supplied fictional premises.'}];
  if(input.module.kind==='plan')Object.assign(body,{acceptanceCriteria:[criterion],steps:[{id:'respond',label:'Explain the room choice',description:'Name South, state both capacities, and explain the exact difference using the supplied premises.',dependsOn:[],criterionIds:['room-choice'],sourceIds:[sourceId]}]});
  return body;
}
function malformed(input,{requirements=true}={}){
  const value=JSON.parse(actual.partialOutput.replace(/^```json\s*/,'').replace(/\s*```$/,''));
  const source=input.sources[0].id;value.grounding=value.grounding.map(link=>({...link,sourceId:source}));
  value.requirements=requirements?value.requirements.map(item=>({...item,sourceId:source})):[];
  return '```json\n'+JSON.stringify(value)+'\n```';
}
async function fixture(t,handler){
  const dir=await mkdtemp(path.join(os.tmpdir(),'planning-format-repair-')),store=await new PlanningBrowserStore({dataDir:dir}).init(),calls=[];
  let f;const runtime={runAgent:async options=>{const input=inputOf(options);calls.push({input,options});options.onEvent({type:'capabilities',profile:'planning-response',native:false,attachedTools:0,structuredOutput:'provider-json-schema',structuredOutputTransport:'response_format',hostValidationRequired:true});const result=await handler({options,input,index:calls.length,f});return typeof result==='string'?{output:result,threadId:'fixture-thread-'+calls.length,turnId:'fixture-turn-'+calls.length,model:profile.model,provider:'fixture-free',usage:{inputTokens:10,outputTokens:5,totalTokens:15}}:result;}};
  const runner=new PlanningBrowserRuntime({store,runtime,defaultCwd:dir,getSettings:()=>({defaultModel:'unused-global',defaultEffort:'high',maxSubagents:3})});
  const request=await store.create({conversationId:'repair-fixture',title:'Fictional room capacity',objective:actual.sources[0].text,cwd:dir});
  f={dir,store,runtime,runner,calls,request};
  t.after(async()=>{await runner.close();await store.close();await rm(dir,{recursive:true,force:true});});
  return f;
}
async function addModule(f){const request=await f.store.addNode(f.request.id,{kind:'viability',title:'Check the supplied fictional capacities',prompt:f.request.objective});const node=request.nodes.at(-1);return{request,node,options:{requestId:request.id,nodeId:node.id,expectedNodeRevision:node.revision,clientRequestId:'one-explicit-check',...profile}};}

test('the actual failed LFM shape stays invalid while prompt/schema explicitly declare requirements and empty references',()=>{
  assert.throws(()=>parseModuleResponse(actual.partialOutput,'viability'),{code:'TASK_VIABILITY_INVALID'});
  const schema=planningModuleOutputSchema(actual),prompt=planningModulePrompt(actual);
  assert.equal(schema.properties.challengeResponses.maxItems,0);assert.equal(schema.properties.requirements.items.properties.dependentNodeIds.maxItems,0);
  assert.ok(schema.properties.requirements.items.required.includes('checkedSourceIds'));assert.ok(schema.properties.requirements.items.required.includes('accuracy'));
  assert.ok(prompt.includes(JSON.stringify(schema)));assert.match(prompt,/No decision-changing unknown/);assert.match(prompt,/fictional|stipulated/);assert.match(prompt,/stopWhen/);assert.match(prompt,/never use fieldId or sourceId/);
  const diagnostic=planningFormatDiagnostic(actual,actual.partialOutput,Object.assign(Error('Use the declared readiness requirement fields.'),{code:'TASK_VIABILITY_INVALID'}));
  assert.ok(diagnostic.issues.some(issue=>issue.path.includes('requirements[0]')&&issue.message.includes('Missing fields')));assert.ok(diagnostic.issues.some(issue=>issue.path.includes('challengeResponses')&&issue.message.includes('must be empty')));
  const bad=JSON.parse(actual.partialOutput.replace(/^```json\s*/,'').replace(/\s*```$/,''));bad.requirements=[];
  assert.throws(()=>validatePlanningModuleResponse(actual,JSON.stringify(bad)),{code:'PLANNING_RESPONSE_REFERENCE'});
});

test('one format repair has separate durable receipts, identical captured inputs and profile, and restart-safe replay',async t=>{
  const f=await fixture(t,({input,index})=>index===1?malformed(input):JSON.stringify(correct(input))),{node,options}=await addModule(f),budget={used:0,max:4};
  const admitted=await f.runner.start({...options,providerBudget:budget}),finished=await f.runner.wait(options.requestId,admitted.attempt.id);
  assert.equal(f.calls.length,2);assert.equal(budget.used,2);assert.equal(finished.attempt.status,'completed');assert.equal(finished.attemptChain.length,2);
  const saved=await f.store.get(options.requestId),[failed,repaired]=saved.attempts;
  assert.equal(failed.status,'failed');assert.equal(failed.validation.code,'TASK_VIABILITY_INVALID');assert.equal(failed.repairAttemptId,repaired.id);assert.equal(repaired.repairOf,failed.id);assert.equal(repaired.repairIndex,1);assert.equal(repaired.status,'completed');
  for(const key of ['node','template','sources','inputs','challenges','workflowNodeIds'])assert.deepEqual(repaired[key],failed[key]);
  assert.notEqual(failed.metadata.runId,repaired.metadata.runId);assert.notEqual(failed.metadata.threadId,repaired.metadata.threadId);assert.equal(failed.metadata.capabilities.structuredOutputTransport,'response_format');assert.equal(repaired.metadata.capabilities.hostValidationRequired,true);
  assert.equal(repaired.formatRepair.previousOutput,failed.partialOutput);assert.deepEqual(f.calls[1].input.sources,f.calls[0].input.sources);assert.equal(f.calls[1].input.formatRepair.diagnostic.code,'TASK_VIABILITY_INVALID');
  for(const {options:call}of f.calls){for(const [key,value]of Object.entries(profile))assert.equal(call[key],value);assert.equal(call.responseOnly,true);assert.deepEqual(call.dynamicTools,[]);assert.equal(call.sandbox,'read-only');assert.equal(call.threadId,undefined);}
  assert.equal(saved.nodes.find(item=>item.id===node.id).readiness.viability.state,'ready');
  await f.runner.close();const restored=new PlanningBrowserRuntime({store:f.store,runtime:{runAgent:()=>{throw Error('A saved repair must not call a provider again.');}},defaultCwd:f.dir});t.after(()=>restored.close());
  const replay=await restored.start(options),result=await restored.wait(options.requestId,replay.attempt.id);assert.equal(result.attempt.id,repaired.id);assert.equal(result.attempt.status,'completed');assert.equal(f.calls.length,2);
});

test('invalid references are never sanitized and one unsuccessful repair is the hard limit',async t=>{
  const f=await fixture(t,({input})=>malformed(input,{requirements:false})),{options}=await addModule(f),budget={used:0,max:10};
  const admitted=await f.runner.start({...options,providerBudget:budget}),finished=await f.runner.wait(options.requestId,admitted.attempt.id),saved=await f.store.get(options.requestId);
  assert.equal(PLANNING_MAX_FORMAT_REPAIRS,1);assert.equal(f.calls.length,2);assert.equal(budget.used,2);assert.equal(finished.attempt.status,'failed');assert.equal(saved.responses.length,0);assert.equal(saved.attempts.length,2);
  for(const attempt of saved.attempts){assert.equal(attempt.validation.code,'PLANNING_RESPONSE_REFERENCE');assert.match(attempt.partialOutput,/capacity-verification/);}assert.equal(saved.attempts[1].repairAttemptId,undefined);
  await f.runner.wait(options.requestId,admitted.attempt.id);assert.equal(f.calls.length,2);
});

test('provider errors, empty output and swallowed tool callbacks never authorize a repair',async t=>{
  for(const kind of ['network','quota','provider-json-error','empty','caught-tool-call'])await t.test(kind,async t=>{
    const f=await fixture(t,({options,input})=>{
      if(kind==='caught-tool-call'){try{options.onToolCall({name:'unavailable_tool'});}catch{}return malformed(input);}
      if(kind==='empty')return '';
      throw Object.assign(Error('Synthetic '+kind+' failure'),{code:kind==='network'?'ECONNRESET':kind==='quota'?'PROVIDER_QUOTA':'PLANNING_RESPONSE_PARSE'});
    }),{options}=await addModule(f);
    const admitted=await f.runner.start(options),finished=await f.runner.wait(options.requestId,admitted.attempt.id),saved=await f.store.get(options.requestId);
    assert.equal(f.calls.length,1);assert.equal(saved.attempts.length,1);assert.equal(saved.attempts[0].validation,undefined);assert.equal(finished.attempt.status,'failed');assert.equal(saved.responses.length,0);
    if(kind==='caught-tool-call')assert.match(saved.attempts[0].message,/no operational tools/);
  });
});

test('source or declaration changes after the first result stop repair before another provider call',async t=>{
  for(const kind of ['source','declaration'])await t.test(kind,async t=>{
    const f=await fixture(t,async({input,f})=>{if(kind==='source')await f.store.addSource(f.request.id,{title:'A new fact',text:'This source arrived after capture.'});else{const current=await f.store.get(f.request.id),node=current.nodes[0];await f.store.updateNode(f.request.id,node.id,{prompt:'A changed task declaration.'},{expectedNodeRevision:node.revision});}return malformed(input);}),{options}=await addModule(f);
    const admitted=await f.runner.start(options),finished=await f.runner.wait(options.requestId,admitted.attempt.id),saved=await f.store.get(options.requestId);
    assert.equal(f.calls.length,1);assert.equal(saved.attempts.length,1);assert.equal(finished.attempt.status,'failed');assert.equal(saved.responses.length,0);assert.equal(saved.attempts[0].repairAttemptId,undefined);
  });
});

test('origin cancellation before repair and cancellation by the repair attempt ID stop subsequent acceptance',async t=>{
  await t.test('origin signal',async t=>{
    const controller=new AbortController(),f=await fixture(t,({input})=>{controller.abort();return malformed(input);}),{options}=await addModule(f);
    const admitted=await f.runner.start({...options,signal:controller.signal});await f.runner.wait(options.requestId,admitted.attempt.id);
    const saved=await f.store.get(options.requestId);assert.equal(f.calls.length,1);assert.equal(saved.attempts.length,1);assert.equal(saved.attempts[0].status,'cancelled');assert.equal(saved.responses.length,0);
  });
  await t.test('repair attempt ID',async t=>{
    let started;const began=new Promise(resolve=>{started=resolve;});
    const f=await fixture(t,async({options,input,index})=>{if(index===1)return malformed(input);started();await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));return JSON.stringify(correct(input));}),{options}=await addModule(f);
    const admitted=await f.runner.start(options);await began;const current=await f.store.get(options.requestId),repair=current.attempts[1];await f.runner.cancel(repair.id);const finished=await f.runner.wait(options.requestId,admitted.attempt.id);
    assert.equal(f.calls.length,2);assert.equal(finished.attempt.status,'cancelled');assert.equal((await f.store.get(options.requestId)).responses.length,0);
  });
});

test('repair reserves the remaining provider budget and completed stages cannot hide its cost',async t=>{
  await t.test('no remaining turn',async t=>{
    const f=await fixture(t,({input})=>malformed(input)),{options}=await addModule(f),budget={used:0,max:1};const admitted=await f.runner.start({...options,providerBudget:budget});await f.runner.wait(options.requestId,admitted.attempt.id);
    assert.equal(f.calls.length,1);assert.equal(budget.used,1);assert.equal((await f.store.get(options.requestId)).attempts.length,1);
  });
  await t.test('cycle admission counts original and repair',async t=>{
    const f=await fixture(t,({input,index})=>index===1?malformed(input):JSON.stringify(correct(input))),service=new ResponseCycleService({store:f.store,runner:f.runner});t.after(()=>service.close());
    let request=await service.createCycle(f.request.id,{title:'Plan the fictional room answer',purpose:f.request.objective,planningExecutionMode:'plan_only',expectedRequestRevision:f.request.revision,clientRequestId:'bounded-cycle'}),cycle=request.cycles[0];
    request=await f.store.runtimeWriter().configureResponseCycle(request.id,{rootPatch:{limits:{...request.responseCycle.limits,maxProviderTurns:3}}});
    const value={expectedRequestRevision:request.revision,expectedCycleRevision:request.nodes.find(node=>node.id===cycle.id).revision,clientRequestId:'run-bounded-cycle',...profile};
    await assert.rejects(service.runCycle(request.id,cycle.id,value),{code:'RESPONSE_CYCLE_BUDGET'});const saved=await f.store.get(request.id);
    assert.equal(f.calls.length,3);assert.equal(saved.attempts.length,3);assert.equal(service.budget(saved).used,3);assert.equal(saved.cycles[0].state,'failed');assert.equal(saved.nodes.find(node=>node.id===cycle.stageNodeIds.plan).response,null);
  });
});


test('repair compares material cycle context and its pinned profile even when the stage revision is unchanged',async t=>{
  for(const kind of ['criteria','profile'])await t.test(kind,async t=>{
    const f=await fixture(t,()=>{throw Error('Store-only capture test must not call a provider.');}),writer=f.store.runtimeWriter();
    const service=new ResponseCycleService({store:f.store,runner:f.runner});t.after(()=>service.close());
    let request=await service.createCycle(f.request.id,{title:'Captured room criteria',purpose:f.request.objective,planningExecutionMode:'plan_only',expectedRequestRevision:f.request.revision,clientRequestId:'capture-cycle'}),cycle=request.cycles[0];
    const nodeId=cycle.stageNodeIds.feasibility,started=await writer.beginAttempt(request.id,nodeId,{ownerId:'fixture-worker',expectedNodeRevision:1,...profile});
    await writer.fail(request.id,started.attempt.id,{message:'Synthetic shape failure.',partialOutput:'{}',validation:{code:'TASK_VIABILITY_INVALID',message:'Missing structured fields.',issues:[]}});
    request=await writer.configureResponseCycle(request.id,{cyclePatch:{id:cycle.id,...(kind==='criteria'?{acceptanceCriteria:[criterion]}:{executionProfile:profile})}});
    assert.equal(request.nodes.find(node=>node.id===nodeId).revision,started.attempt.nodeRevision);
    await assert.rejects(writer.beginRepairAttempt(request.id,started.attempt.id),{code:'PLANNING_REPAIR_STALE'});
    assert.equal((await f.store.get(request.id)).attempts.length,1);assert.equal(f.calls.length,0);
  });
});

test('unchanged knowledge captured by an unrelated module does not stale the target repair',async t=>{
  const f=await fixture(t,()=>{throw Error('Store-only capture test must not call a provider.');}),writer=f.store.runtimeWriter();
  f.store.knowledge={get:async id=>({id,revision:1,kind:'memory',title:'Other branch fact',content:'Only another branch uses this.',cwd:null,provenance:{kind:'human'}})};
  await f.store.addNode(f.request.id,{id:'target',kind:'viability',title:'Target',prompt:'Use the task.'});
  await f.store.addNode(f.request.id,{id:'other',kind:'viability',title:'Other',prompt:'Use its own knowledge.'});
  await f.store.link(f.request.id,{id:'other-knowledge',kind:'knowledge',from:'other',to:'fact'},{expectedNodeRevision:1});
  const started=await writer.beginAttempt(f.request.id,'target',{ownerId:'fixture-worker',expectedNodeRevision:1});
  await writer.fail(f.request.id,started.attempt.id,{message:'Synthetic shape failure.',partialOutput:'{}',validation:{code:'TASK_VIABILITY_INVALID',message:'Missing structured fields.',issues:[]}});
  const repaired=await writer.beginRepairAttempt(f.request.id,started.attempt.id);
  assert.equal(repaired.created,true);assert.deepEqual(repaired.attempt.sources,started.attempt.sources);assert.equal(repaired.attempt.sources.some(source=>source.id.startsWith('knowledge:')),false);assert.equal(f.calls.length,0);
  await writer.cancel(f.request.id,repaired.attempt.id,{message:'Store-only fixture complete.'});
});

test('concurrent manual stages share the atomic durable cycle attempt cap',async t=>{
  const f=await fixture(t,({input})=>JSON.stringify(correct(input))),service=new ResponseCycleService({store:f.store,runner:f.runner});t.after(()=>service.close());
  let request=await service.createCycle(f.request.id,{title:'Concurrent manual stages',purpose:f.request.objective,planningExecutionMode:'plan_only',expectedRequestRevision:f.request.revision,clientRequestId:'manual-cycle'}),cycle=request.cycles[0];
  request=await f.store.runtimeWriter().configureResponseCycle(request.id,{rootPatch:{limits:{...request.responseCycle.limits,maxProviderTurns:1}}});
  const results=await Promise.allSettled(['feasibility','inference'].map(stage=>f.runner.start({requestId:request.id,nodeId:cycle.stageNodeIds[stage],expectedNodeRevision:1,clientRequestId:'manual-'+stage,...profile})));
  const accepted=results.filter(result=>result.status==='fulfilled'),rejected=results.filter(result=>result.status==='rejected');
  assert.equal(accepted.length,1);assert.equal(rejected.length,1);assert.equal(rejected[0].reason.code,'RESPONSE_CYCLE_BUDGET');
  await f.runner.wait(request.id,accepted[0].value.attempt.id);
  assert.equal(f.calls.length,1);assert.equal((await f.store.get(request.id)).attempts.length,1);
});
