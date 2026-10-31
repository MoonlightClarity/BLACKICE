import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePlanningBrowserHttp } from '../lib/planning-browser-http.mjs';
import { createDirectResponseCycleTools } from '../lib/direct-response-cycle-tools.mjs';
import { createControlToolHandler, CONTROL_TOOL, PRE_PROFILE_CONTROL_TOOL, PRE_PROFILE_CONTROL_INSTRUCTIONS, PRE_ACCURACY_CONTROL_TOOL, PRE_ACCURACY_CONTROL_INSTRUCTIONS, CONTROL_SCHEMA_VERSION } from '../lib/control-tools.mjs';
import {createHash} from 'node:crypto';

const reference={expectedRequestRevision:4,expectedCycleRevision:3,expectedPlanRevision:2,expectedPlanResponseId:'plan-response',clientRequestId:'fixture-cycle-action'};
function serviceFixture(){const calls=[],service=Object.fromEntries(['createCycle','runCycle','editPlan','continueCycle','answerQuestion'].map(method=>[method,async(...args)=>{calls.push({method,args});return{id:'request-a',revision:5,cycles:[{id:'cycle-a',title:'Explain the fixture response',state:'paused_after_plan'}],nodes:[]};}]));return{calls,service};}

test('cycle HTTP actions preserve exact revision payloads and inert reads cannot continue',async()=>{
  const {calls,service}=serviceFixture(),mutations=new Set(),results=[];
  const invoke=async(pathname,method,value)=>handlePlanningBrowserHttp({req:{method},res:{},pathname,responseCycle:service,store:{get:async()=>({id:'request-a',nodes:[]})},body:async()=>value,json:(_res,status,body)=>results.push({status,body}),fileMutations:mutations});
  await invoke('/api/planning-browser/requests/request-a','GET');assert.equal(calls.length,0);
  await invoke('/api/planning-browser/requests/request-a/cycles','POST',{title:'Explain fixture',purpose:'Produce a checked explanation.',planningExecutionMode:'plan_only',expectedRequestRevision:4,clientRequestId:'create-cycle'});
  const run={expectedRequestRevision:4,expectedCycleRevision:3,planningExecutionMode:'plan_only',model:'fixture-api::fast',effort:'default',serviceTier:'default',clientRequestId:'run-cycle'};
  await invoke('/api/planning-browser/requests/request-a/cycles/cycle-a/run','POST',run);
  await invoke('/api/planning-browser/requests/request-a/cycles/cycle-a/plan','POST',{...reference,plan:{values:{}}});
  await invoke('/api/planning-browser/requests/request-a/cycles/cycle-a/continue','POST',reference);
  assert.deepEqual(calls.map(call=>call.method),['createCycle','runCycle','editPlan','continueCycle']);assert.deepEqual(calls[3].args.slice(0,3),['request-a','cycle-a',reference]);assert.equal(mutations.size,0);
  assert.deepEqual(calls[1].args[2],run);
  await invoke('/api/planning-browser/requests/request-a/cycles/cycle-a/continue','POST',{...reference,model:'fixture-api::other'});assert.equal(calls.length,4);assert.equal(results.at(-1).status,400);
  await invoke('/api/planning-browser/requests/request-a/cycles/cycle-a/continue','POST',{...reference,ready:true});assert.equal(calls.length,4);assert.equal(results.at(-1).status,400);
  const factual={nodeId:'child-feasibility',requirementId:'address',answer:'123 Fixture Road',expectedNodeRevision:2,expectedResponseId:'child-response',clientRequestId:'nested-answer'};
  await invoke('/api/planning-browser/requests/request-a/viability/answer','POST',factual);assert.equal(calls.at(-1).method,'answerQuestion');assert.deepEqual(calls.at(-1).args[1],factual);
});

test('direct cycle actions require explicit execution scopes and preserve durable idempotency identity',async()=>{
  const {calls,service}=serviceFixture(),[tool]=createDirectResponseCycleTools({service});assert.deepEqual(tool.definition.requiredScopes,['commands:run','planning:write']);assert.equal(tool.definition.name,'blackice_planning_cycle');
  const args={action:'continue',requestId:'direct-action',graphRequestId:'request-a',cycleId:'cycle-a',expectedRequestRevision:4,expectedCycleRevision:3,expectedPlanRevision:2,expectedPlanResponseId:'plan-response'};
  await assert.rejects(tool.execute(args),{code:'DIRECT_AUTH_REQUIRED'});assert.equal(calls.length,0);
  const result=await tool.execute(args,{client:{id:'fixture-grant'},jobId:'direct_fixture_job'});assert.equal(result.success,true);assert.equal(calls[0].method,'continueCycle');assert.equal(calls[0].args[2].clientRequestId,'direct_fixture_job');assert.equal(calls[0].args[2].expectedPlanRevision,2);assert.equal(calls[0].args[3].actor.type,'external-agent');
  const controller=new AbortController();controller.abort();await assert.rejects(tool.execute({...args,action:'run'},{client:{id:'fixture-grant'},jobId:'cancelled_job',signal:controller.signal}),error=>error.name==='AbortError');assert.equal(calls.length,1);
  await tool.execute({action:'answer',requestId:'direct-answer',graphRequestId:'request-a',nodeId:'child-feasibility',requirementId:'address',answer:'123 Fixture Road',expectedNodeRevision:2,expectedResponseId:'child-response'},{client:{id:'fixture-grant'},jobId:'direct_factual_answer'});assert.equal(calls.at(-1).method,'answerQuestion');assert.equal(calls.at(-1).args[1].nodeId,'child-feasibility');assert.equal(calls.at(-1).args[1].clientRequestId,'direct_factual_answer');assert.equal(calls.at(-1).args[2].receipt.jobId,'direct_factual_answer');
  const profile={model:'fixture-api::small-fast',effort:'default',serviceTier:'default'};
  await tool.execute({action:'run',requestId:'direct-profile',graphRequestId:'request-a',cycleId:'cycle-a',expectedRequestRevision:4,expectedCycleRevision:3,...profile},{client:{id:'fixture-grant'},jobId:'direct_profile_job'});
  assert.equal(calls.at(-1).method,'runCycle');for(const key of Object.keys(profile))assert.equal(calls.at(-1).args[2][key],profile[key]);
  const runSchema=tool.definition.inputSchema.oneOf.find(schema=>schema.properties.action.const==='run');assert.ok(runSchema.properties.model);assert.deepEqual(runSchema.properties.serviceTier.enum,['default','fast']);
});

test('supervising model uses the same explicit Plan only and Continue service contract',async()=>{
  const {calls,service}=serviceFixture(),engine={responseCycle:service};
  const handler=createControlToolHandler({engine,run:{id:'supervisor-run'},nodeId:'supervisor',validateWorkflow:value=>value,validatePresentation:value=>value});
  const result=await handler({name:'relay_control',arguments:{action:'planning_cycle_run',graphRequestId:'request-a',cycleId:'cycle-a',cycle:{expectedRequestRevision:4,expectedCycleRevision:3,planningExecutionMode:'plan_only',model:'fixture-api::fast',effort:'minimal',serviceTier:'default',clientRequestId:'supervised-plan'}}});
  assert.equal(result.success,true);assert.equal(calls[0].method,'runCycle');assert.equal(calls[0].args[2].planningExecutionMode,'plan_only');assert.equal(calls[0].args[3].actor.type,'agent');
  assert.equal(calls[0].args[2].model,'fixture-api::fast');assert.equal(calls[0].args[2].effort,'minimal');assert.equal(calls[0].args[2].serviceTier,'default');
  assert.ok(CONTROL_TOOL.inputSchema.properties.action.enum.includes('planning_cycle_continue'));assert.equal(CONTROL_TOOL.inputSchema.properties.cycle.properties.plan.additionalProperties,false);
  const factual={expectedRequestRevision:4,nodeId:'child-feasibility',requirementId:'address',answer:'123 Fixture Road',expectedNodeRevision:2,expectedResponseId:'child-response',clientRequestId:'supervised-answer'};
  const answer=await handler({name:'relay_control',arguments:{action:'planning_cycle_answer',graphRequestId:'request-a',cycle:factual}});assert.equal(answer.success,true);assert.equal(calls.at(-1).method,'answerQuestion');assert.deepEqual(calls.at(-1).args[1],factual);assert.equal(calls.at(-1).args[2].actor.type,'agent');
});

test('v5 control bytes stay frozen and cannot silently accept the new cycle-profile fields',async()=>{
  const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
  assert.equal(CONTROL_SCHEMA_VERSION,9);assert.equal(digest(PRE_PROFILE_CONTROL_TOOL),'2952769b26c22c9f6da3f83e71877f9bd77aa984159cb45ab3a33b4a6743001f');assert.equal(digest(PRE_PROFILE_CONTROL_INSTRUCTIONS),'99a51bd67f845fda17d7d498781554db4159b17f271556dedbadba06fdb37336');
  const {calls,service}=serviceFixture(),handler=createControlToolHandler({engine:{responseCycle:service},run:{id:'saved-v5'},nodeId:'supervisor',toolDefinition:PRE_PROFILE_CONTROL_TOOL});
  const denied=await handler({name:'relay_control',arguments:{action:'planning_cycle_run',graphRequestId:'request-a',cycleId:'cycle-a',cycle:{expectedRequestRevision:4,expectedCycleRevision:3,clientRequestId:'legacy-profile',model:'fixture-api::fast'}}});
  assert.equal(denied.success,false);assert.match(denied.contentItems[0].text,/saved control schema/);assert.equal(calls.length,0);
});


test('v6 control bytes remain exact while v7 exposes accuracy only in the current Plan contract',async()=>{
  const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
  assert.equal(digest(PRE_ACCURACY_CONTROL_TOOL),'a4cbdedee08e48d79eace164e2ff8fd82dce403b1d681a3c10d76ad4db659284');
  assert.equal(digest(PRE_ACCURACY_CONTROL_INSTRUCTIONS),'d34e9220c2dacd8f929710f1ab270bbc786aa79d951563af803b6ad93bf356d6');
  assert.equal(PRE_ACCURACY_CONTROL_TOOL.inputSchema.properties.cycle.properties.plan.properties.acceptanceCriteria.items.properties.accuracy,undefined);
  assert.ok(CONTROL_TOOL.inputSchema.properties.cycle.properties.plan.properties.acceptanceCriteria.items.properties.accuracy);
  const {calls,service}=serviceFixture(),handler=createControlToolHandler({engine:{responseCycle:service},run:{id:'saved-v6'},nodeId:'supervisor',toolDefinition:PRE_ACCURACY_CONTROL_TOOL});
  const denied=await handler({name:'relay_control',arguments:{action:'planning_cycle_edit_plan',graphRequestId:'request-a',cycleId:'cycle-a',cycle:{expectedRequestRevision:4,expectedCycleRevision:3,clientRequestId:'legacy-accuracy',plan:{acceptanceCriteria:[{id:'fixture',accuracy:null}]}}}});
  assert.equal(denied.success,false);assert.match(denied.contentItems[0].text,/saved control schema/);assert.equal(calls.length,0);
});
