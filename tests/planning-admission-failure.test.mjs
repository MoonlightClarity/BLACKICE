import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime} from '../lib/planning-browser-runtime.mjs';
import {ResponseCycleService} from '../lib/response-cycle.mjs';

const failureCode='PLANNING_RESPONSE_PROFILE_UNSUPPORTED';
const failureMessage='The native runtime did not apply the unified_exec restriction. No module turn was started.';
test('retired planning admission rejects before reading infrastructure or starting any provider',async()=>{
 const service=Object.create(ResponseCycleService.prototype);let touches=0;
 for(const key of ['store','runner','engine','taskViability'])Object.defineProperty(service,key,{get(){touches++;throw Error('No retired infrastructure access');}});
 for(const planningMode of ['on','off'])await assert.rejects(()=>service.forRun({id:'old',planningMode}),{code:'PLANNING_CYCLE_RETIRED',status:410});
 assert.equal(touches,0);
});
test('current explicit module admission preserves provider infrastructure failure without asking a user fact',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'current-module-admission-'));
 const store=await new PlanningBrowserStore({dataDir}).init();let calls=0;
 const runtime={runAgent:async options=>{calls++;assert.equal(options.responseOnly,true);assert.deepEqual(options.dynamicTools,[]);throw Object.assign(Error(failureMessage),{code:failureCode});}};
 const runner=new PlanningBrowserRuntime({store,runtime,defaultCwd:dataDir,getSettings:()=>({maxSubagents:1})});
 t.after(async()=>{await runner.close();await store.close();await rm(dataDir,{recursive:true,force:true});});
 await store.create({id:'current',conversationId:'current',title:'Current module',objective:'Inspect supplied evidence.',cwd:dataDir});
 await store.addNode('current',{id:'frame',kind:'frame',title:'Frame the evidence'});
 const admitted=await runner.start({requestId:'current',nodeId:'frame',expectedNodeRevision:1,clientRequestId:'first',automatic:false});
 await Promise.all(runner.activePromises());
 const saved=await store.get('current'),attempt=saved.attempts.find(item=>item.id===admitted.attempt.id);
 assert.equal(attempt.status,'failed');assert.match(attempt.message,/unified_exec restriction/);
 assert.equal(saved.responses.length,0);assert.equal(saved.viability,undefined);assert.equal(calls,1);
});
test('ordinary Engine failures retain their actual error and never consult retired planning admission or finalization',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'ordinary-admission-error-'));let calls=0,plannerCalls=0;
 class Runtime extends EventEmitter{
  status(){return {connected:true,authenticated:true,defaultModel:'fixture-model'};}
  async close(){}
  async runAgent(options){calls++;assert.notEqual(options.responseOnly,true);throw Object.assign(Error('Synthetic operational failure'),{code:'FIXTURE_OPERATION_FAILED'});}
 }
 const engine=await new HarnessEngine({runtime:new Runtime(),dataDir,defaultCwd:dataDir}).init();
 engine.responseCycle={forRun(){plannerCalls++;throw Error('Retired gate called');},finishRun(){plannerCalls++;throw Error('Retired finalization called');}};
 t.after(async()=>{await engine.close();await rm(dataDir,{recursive:true,force:true});});
 const workflow={id:'ordinary',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'fixture-model',prompt:'Perform the authorized work.'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{planningMode:'on'}};
 const admitted=engine.startRun({workflow,input:'Inspect actual evidence.'});await engine.executions.get(admitted.id);
 const saved=engine.getRun(admitted.id);
 assert.equal(saved.status,'failed');assert.equal(saved.errorCode,'FIXTURE_OPERATION_FAILED');assert.equal(saved.error,'Synthetic operational failure');
 assert.equal(saved.settled,true);assert.equal(calls,1);assert.equal(plannerCalls,0);assert.equal(saved.viability,undefined);
 assert.doesNotMatch(saved.output||'',/operational results are recorded/i);
});
