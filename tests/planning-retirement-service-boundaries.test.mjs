import {EventEmitter} from 'node:events';
import {HarnessEngine} from '../lib/engine.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ResponseCycleService} from '../lib/response-cycle.mjs';
import {TaskViability} from '../lib/task-viability.mjs';
import {PlanningDiagnostics,PlanningDiagnosticStore} from '../lib/planning-diagnostics.mjs';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime} from '../lib/planning-browser-runtime.mjs';
import {createNativePlanningTools} from '../lib/native-planning-tools.mjs';
import {createDirectPlanningExecutionTools} from '../lib/direct-planning-execution-tools.mjs';
import {planningModuleTemplate} from '../public/planning-browser-model.mjs';

test('all old orchestration and diagnostic service entry points retire before touching dependencies',async()=>{
 let touches=0;
 const cases=[
  [ResponseCycleService,[
   ['createCycle',['archive',{}]],['createCurrent',['archive',{}]],['runCycle',['archive','cycle',{}]],['drive',['archive','cycle']],['runStage',['archive','cycle','inference']],['ensureChildAdmission',[{},'stage']],['answerQuestion',['archive',{}]],['continueCycle',['archive','cycle',{}]],['editPlan',['archive','cycle',{}]],['forRun',[{}]]
  ]],
  [TaskViability,[['ensure',[{}]],['assess',['archive']],['assessCurrent',['archive']],['forRun',[{}]],['checkDeployment',[{},'schedule']],['saveDeployment',[{},{}]],['answer',['archive',{}]],['answerCurrent',['archive',{}]],['refreshSources',[{},{}]],['prepareDeploymentInference',[{},{},{}]],['assertDeployment',[{}]],['withDeployment',[{},()=>{}]]]],
  [PlanningDiagnostics,[['capture',[{}]],['run',['archive',{}]]]],
  [PlanningDiagnosticStore,[['capture',[{}]],['begin',['archive',{}]]]]
 ];
 for(const [Type,methods]of cases){
  // Construct only the actual method receiver. Getters detect an unexpected
  // dependency read before the retired entry point returns.
  const service=Object.create(Type.prototype);
  for(const key of ['store','writer','runner','engine','active','cycleRuns','queues','getSettings','readRun','taskViability'])Object.defineProperty(service,key,{get(){touches++;throw Error('Retired operation touched '+key);}});
  for(const [method,args]of methods)await assert.rejects(async()=>service[method](...args),{code:'PLANNING_CYCLE_RETIRED',status:410},Type.name+'.'+method);
 }
 assert.equal(touches,0);
});
test('native coordinator uses actual shared module adapter and preserves read-only/cross-conversation boundaries',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'native-current-module-')),store=await new PlanningBrowserStore({dataDir}).init();let calls=0;
 const fields=planningModuleTemplate('frame').fields,output=JSON.stringify({values:Object.fromEntries(fields.map(field=>[field.id,'Synthetic supported '+field.label])),grounding:fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId:'request:current'})),openQuestions:[],challengeResponses:[]});
 const runtime={async runAgent(options){calls++;assert.equal(options.responseOnly,true);assert.deepEqual(options.dynamicTools,[]);return {output,threadId:'native-fixture',turnId:'one'};}};
 const runner=new PlanningBrowserRuntime({store,runtime,defaultCwd:dataDir,getSettings:()=>({maxSubagents:2,subagentsEnabled:false})});
 t.after(async()=>{await runner.close();await store.close();await rm(dataDir,{recursive:true,force:true});});
 const provider=createNativePlanningTools({store,getExecutionSnapshot:()=>runner.status(),extraTools:createDirectPlanningExecutionTools({store,runner,executionContext:(_args,{nativeContext})=>({clientRequestId:nativeContext.clientRequestId})})});
 const attached=await provider({taskId:'current-chat',runId:'native-run',nodeId:'coordinator'});let serial=0;
 const call=async(name,args)=>JSON.parse((await attached.handle({name,arguments:{requestId:'native-test-'+(++serial),graphRequestId:'current',...args}})).contentItems[0].text);
 await call('relay_planning_write',{action:'create_request',title:'Current graph',objective:'Inspect synthetic evidence.'});
 await call('relay_planning_write',{action:'add_module',nodeId:'group',kind:'cycle',title:'Current group'});
 await call('relay_planning_write',{action:'add_module',nodeId:'frame',kind:'frame',title:'Current frame',parentId:'group',expectedParentRevision:1});
 const before=await call('relay_planning_read',{action:'get',nodeId:'frame'});
 const admitted=await call('relay_planning_module',{action:'run',nodeId:'frame',expectedNodeRevision:before.node.revision});
 assert.equal(admitted.executionRequested,true);assert.equal(admitted.externalActionExecuted,false);
 await Promise.all(runner.activePromises());
 const after=await call('relay_planning_read',{action:'get',nodeId:'frame'});
 assert.equal(after.attempts.items.at(-1).status,'completed');assert.equal(after.node.response.provenance.kind,'runtime');assert.equal(after.node.response.verifiedAction,false);assert.equal(calls,1);
 const reader=await provider({taskId:'current-chat',runId:'reader-run',nodeId:'reader',canWrite:false});
 assert.deepEqual(reader.tools.map(tool=>tool.name),['relay_planning_read']);
 await assert.rejects(()=>reader.handle({name:'relay_planning_module',arguments:{action:'run',graphRequestId:'current',nodeId:'frame',expectedNodeRevision:after.node.revision,requestId:'forbidden'}}),{code:'NATIVE_PLANNING_SCOPE'});
 const other=await provider({taskId:'other-chat',runId:'other-run',nodeId:'coordinator'});
 await assert.rejects(()=>other.handle({name:'relay_planning_read',arguments:{action:'get',graphRequestId:'current',requestId:'other-read'}}),{code:'NATIVE_PLANNING_SCOPE'});
 assert.equal(calls,1);
});

test('actual Engine coordinator creates a graph, runs a response-only module and reads its saved outcome through native dispatch',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'engine-current-module-')),store=await new PlanningBrowserStore({dataDir}).init();
 let runner,engine,coordinatorCalls=0,moduleCalls=0,observedResponse,sequence=0;
 const fields=planningModuleTemplate('frame').fields;
 const moduleOutput=JSON.stringify({values:Object.fromEntries(fields.map(field=>[field.id,'Synthetic supported '+field.label])),grounding:fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId:'request:engine-current'})),openQuestions:[],challengeResponses:[]});
 class Runtime extends EventEmitter {
  status(){return {connected:true,authenticated:true,defaultModel:'engine-module-fixture'};}
  async close(){}
  async runAgent(options){
   if(options.responseOnly){
    moduleCalls++;assert.deepEqual(options.dynamicTools,[]);return {output:moduleOutput,threadId:'module-fixture',turnId:'one'};
   }
   coordinatorCalls++;
   const native=options.dynamicTools.filter(tool=>tool.name.startsWith('relay_planning_'));
   assert.deepEqual(native.map(tool=>tool.name).sort(),['relay_planning_module','relay_planning_read','relay_planning_write']);
   for(const tool of native){assert.equal(tool.type,'function');assert.ok(tool.inputSchema.properties.action);assert.ok(tool.inputSchema.oneOf.length);}
   const moduleSchema=native.find(tool=>tool.name==='relay_planning_module').inputSchema;
   assert.deepEqual(moduleSchema,provider.catalog.find(tool=>tool.name==='relay_planning_module').inputSchema);
   const send=async(name,args)=>{
    const result=await options.onToolCall({name,arguments:{requestId:'engine-module-'+(++sequence),graphRequestId:'engine-current',...args}});
    assert.equal(result.success,true,JSON.stringify(result));
    return JSON.parse(result.contentItems.find(item=>item.type==='inputText').text);
   };
   await send('relay_planning_write',{action:'create_request',title:'Engine current graph',objective:'Analyze synthetic evidence without external actions.'});
   await send('relay_planning_write',{action:'add_module',nodeId:'group',kind:'cycle',title:'Modular group'});
   await send('relay_planning_write',{action:'add_module',nodeId:'frame',kind:'frame',title:'Frame',parentId:'group',expectedParentRevision:1});
   const before=await send('relay_planning_read',{action:'get',nodeId:'frame'});
   const claim=await send('relay_planning_module',{action:'run',nodeId:'frame',expectedNodeRevision:before.node.revision});
   assert.equal(claim.executionRequested,true);assert.equal(claim.externalActionExecuted,false);
   await Promise.all(runner.activePromises());
   const after=await send('relay_planning_read',{action:'get',nodeId:'frame'});
   assert.equal(after.attempts.items.at(-1).status,'completed');assert.equal(after.node.response.provenance.kind,'runtime');assert.equal(after.node.response.verifiedAction,false);
   observedResponse=after.node.response.id;
   return {output:'Observed the saved analytical module result.',threadId:'coordinator-fixture'};
  }
 }
 const runtime=new Runtime();
 runner=new PlanningBrowserRuntime({store,runtime,defaultCwd:dataDir,getSettings:()=>({maxSubagents:2,subagentsEnabled:false})});
 const provider=createNativePlanningTools({store,getExecutionSnapshot:()=>runner.status(),extraTools:createDirectPlanningExecutionTools({store,runner,executionContext:(_args,{nativeContext})=>({clientRequestId:nativeContext.clientRequestId})})});
 engine=await new HarnessEngine({runtime,dataDir,defaultCwd:dataDir,nativePlanningTools:provider}).init();
 engine.runtimeSettings={get:()=>({executionGuardrails:false,subagentsEnabled:true,maxSubagents:2})};
 t.after(async()=>{await engine.close();await runner.close();await store.close();await rm(dataDir,{recursive:true,force:true});});
 const workflow={id:'engine-module-roundtrip',name:'Current native module',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'engine-module-fixture',prompt:'Use the shared graph for a bounded synthetic analysis.'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{planningMode:'off'}};
 const admitted=engine.startRun({workflow,input:'Analyze the synthetic graph.',planningMode:'off'});await engine.executions.get(admitted.id);
 const finished=engine.getRun(admitted.id);assert.equal(finished.status,'completed',JSON.stringify(finished));
 assert.equal(coordinatorCalls,1);assert.equal(moduleCalls,1);assert.ok(observedResponse);
 const saved=await store.get('engine-current');assert.equal(saved.conversationId,finished.taskId||finished.id);assert.equal(saved.responses[0].id,observedResponse);assert.equal(saved.responses[0].verifiedAction,false);
});
