import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePlanningBrowserHttp } from '../lib/planning-browser-http.mjs';
import { createDirectResponseCycleTools } from '../lib/direct-response-cycle-tools.mjs';
import { createControlToolHandler, CONTROL_TOOL } from '../lib/control-tools.mjs';
import {createHash} from 'node:crypto';

const reference={expectedRequestRevision:4,expectedCycleRevision:3,expectedPlanRevision:2,expectedPlanResponseId:'plan-response',clientRequestId:'fixture-cycle-action'};
function serviceFixture(){const calls=[],service=Object.fromEntries(['createCycle','runCycle','editPlan','continueCycle','answerQuestion'].map(method=>[method,async(...args)=>{calls.push({method,args});return{id:'request-a',revision:5,cycles:[{id:'cycle-a',title:'Explain the fixture response',state:'paused_after_plan'}],nodes:[]};}]));return{calls,service};}

import {ResponseCycleService} from '../lib/response-cycle.mjs';

test('cycle HTTP mutation routes return 410 without calling services while archive reads remain available',async()=>{
  const {calls,service}=serviceFixture(),mutations=new Set(),results=[];
  const saved={id:'request-a',nodes:[],responseCycle:{rootCycleId:'cycle-a',cycles:[],actionReceipts:[{id:'saved',outcome:'unknown'}]}};
  const invoke=async(pathname,method,value)=>handlePlanningBrowserHttp({req:{method},res:{},pathname,responseCycle:service,store:{get:async()=>structuredClone(saved)},body:async()=>value,json:(_res,status,body)=>results.push({status,body}),fileMutations:mutations});
  await invoke('/api/planning-browser/requests/request-a','GET');assert.equal(results.at(-1).status,200);
  const original=structuredClone(saved);
  for(const [suffix,value]of [
    ['/cycles',{title:'New cycle',purpose:'New work.',planningExecutionMode:'plan_only'}],
    ['/cycles/cycle-a/run',{...reference,planningExecutionMode:'automatic',model:'fixture'}],
    ['/cycles/cycle-a/plan',{...reference,plan:{values:{}}}],
    ['/cycles/cycle-a/continue',reference],
    ['/viability/answer',{nodeId:'old-check',requirementId:'address',answer:'Synthetic fact',expectedNodeRevision:2,expectedResponseId:'old-response',clientRequestId:'answer'}]
  ]){
    await invoke('/api/planning-browser/requests/request-a'+suffix,'POST',value);
    assert.equal(results.at(-1).status,410,suffix);assert.equal(results.at(-1).body.code,'PLANNING_CYCLE_RETIRED',suffix);
  }
  assert.equal(calls.length,0);assert.equal(mutations.size,0);assert.deepEqual(saved,original);
  await invoke('/api/planning-browser/requests/request-a','GET');assert.equal(results.at(-1).status,200);
});

test('stale direct adapter retains authentication and scope checks but actual retired service cannot dispatch',async()=>{
  let dependencies=0,updates=0;
  const service=Object.create(ResponseCycleService.prototype);
  for(const key of ['store','writer','runner','engine'])Object.defineProperty(service,key,{get(){dependencies++;throw Error('No retired dispatch.');}});
  const [tool]=createDirectResponseCycleTools({service,onChange:()=>updates++});
  assert.deepEqual(tool.definition.requiredScopes,['commands:run','planning:write']);
  const args={requestId:'direct-action',graphRequestId:'request-a',cycleId:'cycle-a',expectedRequestRevision:4,expectedCycleRevision:3,...reference};
  await assert.rejects(tool.execute({...args,action:'run'}),{code:'DIRECT_AUTH_REQUIRED'});
  for(const action of ['create','run','edit_plan','continue','answer']){
    await assert.rejects(tool.execute({...args,action},{client:{id:'fixture-grant'},jobId:'saved-job'}),{code:'PLANNING_CYCLE_RETIRED',status:410});
  }
  const controller=new AbortController();controller.abort();
  await assert.rejects(tool.execute({...args,action:'run'},{client:{id:'fixture-grant'},jobId:'cancelled-job',signal:controller.signal}),error=>error.name==='AbortError');
  assert.equal(dependencies,0);assert.equal(updates,0);
});

test('supervising models cannot use stale cycle actions even with their saved control schema',async()=>{
  const {calls,service}=serviceFixture();
  for(const definition of [CONTROL_TOOL]){
    const handler=createControlToolHandler({engine:{responseCycle:service},run:{id:'supervisor-run'},nodeId:'supervisor',toolDefinition:definition});
    for(const action of ['planning_cycle_create','planning_cycle_run','planning_cycle_edit_plan','planning_cycle_continue','planning_cycle_answer']){
      const result=await handler({name:'relay_control',arguments:{action,graphRequestId:'request-a',cycleId:'cycle-a',cycle:{...reference,planningExecutionMode:'plan_only'}}});
      assert.equal(result.success,false);assert.match(result.contentItems[0].text,/current relay_control schema/i);
    }
  }
  assert.equal(calls.length,0);
  assert.ok(!CONTROL_TOOL.inputSchema.properties.action.enum.some(action=>action.startsWith('planning_cycle_')));
});
