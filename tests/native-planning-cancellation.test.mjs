import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime} from '../lib/planning-browser-runtime.mjs';
import {createDirectPlanningExecutionTools} from '../lib/direct-planning-execution-tools.mjs';
import {createNativePlanningTools} from '../lib/native-planning-tools.mjs';
const payload=value=>JSON.parse(value.contentItems[0].text);
async function fixture(t){
 const dataDir=await mkdtemp(path.join(tmpdir(),'native-cancellation-')),cwd=path.join(dataDir,'work');await mkdir(cwd);
 let store=await new PlanningBrowserStore({dataDir}).init();const runners=[],stores=[store];let calls=0;
 const runtime={runAgent:options=>new Promise((_resolve,reject)=>{calls++;options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('Cancelled fixture'),{code:'ABORT_ERR'})),{once:true});})};
 const makeRunner=()=>{const runner=new PlanningBrowserRuntime({store,runtime,defaultCwd:cwd,getSettings:()=>({maxSubagents:1})});runners.push(runner);return runner;};
 let runner=makeRunner();
 const native=()=>createNativePlanningTools({store,extraTools:createDirectPlanningExecutionTools({store,runner,executionContext:(_args,{nativeContext})=>({clientRequestId:nativeContext.clientRequestId})})})({taskId:'conversation',runId:'saved-run',nodeId:'coordinator'});
 await store.create({id:'graph',conversationId:'conversation',title:'Cancel test',objective:'Inspect cancellation receipt',cwd});
 await store.addNode('graph',{id:'module',kind:'frame',title:'Fixture response'},{actor:'user'});
 t.after(async()=>{for(const runner of runners)await runner.close();for(const store of stores)await store.close();await rm(dataDir,{recursive:true,force:true});});
 return {get store(){return store;},get runner(){return runner;},get calls(){return calls;},native,
  async recreate(){await runner.close();await store.close();store=await new PlanningBrowserStore({dataDir}).init();stores.push(store);runner=makeRunner();},
  async start(){return runner.start({requestId:'graph',nodeId:'module',expectedNodeRevision:1,clientRequestId:'start-fixture'});}};
}
test('native cancellation retry recovers exact saved outcome after runtime and store recreation',async t=>{
 const f=await fixture(t),started=await f.start(),adapter=await f.native();
 const args={requestId:'cancel-once',action:'cancel',graphRequestId:'graph',nodeId:'module',attemptId:started.attempt.id,reason:'Stop this test.'};
 const call=arguments_=>({name:'relay_planning_module',arguments:arguments_});
 const first=payload(await adapter.handle(call(args)));
 assert.equal(first.cancellationAttempt.status,'cancelled');assert.equal(first.cancellationRequested,true);
 const count=f.calls,revision=(await f.store.get('graph')).revision;
 const again=payload(await adapter.handle(call(args)));assert.deepEqual(again.cancellationAttempt,first.cancellationAttempt);
 assert.equal((await f.store.get('graph')).revision,revision);
 await f.recreate();const restored=await f.native();
 const replay=payload(await restored.handle(call(args)));assert.deepEqual(replay.cancellationAttempt,first.cancellationAttempt);assert.equal(f.calls,count);
 await assert.rejects(restored.handle(call({...args,reason:'Different reason.'})),{code:'PLANNING_IDEMPOTENCY_CONFLICT'});
 await assert.rejects(restored.handle(call({...args,requestId:'unrelated-cancellation'})),{code:'PLANNING_BROWSER_ATTEMPT_SETTLED'});
});
test('durable cancellation intent does not invent settlement for an orphaned worker',async t=>{
 const f=await fixture(t),claim=await f.store.runtimeWriter().beginAttempt('graph','module',{expectedNodeRevision:1,ownerId:'owner',clientRequestId:'orphan-start'});
 const adapter=await f.native(),call={name:'relay_planning_module',arguments:{requestId:'orphan-cancel',action:'cancel',graphRequestId:'graph',nodeId:'module',attemptId:claim.attempt.id}};
 await assert.rejects(adapter.handle(call),{code:'PLANNING_ATTEMPT_NOT_OWNED'});
 await assert.rejects(adapter.handle(call),{code:'PLANNING_ATTEMPT_NOT_OWNED'});
 assert.equal((await f.store.get('graph')).attempts[0].status,'running');assert.equal(f.calls,0);
 // A real terminal result wins any cancellation race and is returned as-is.
 await f.store.runtimeWriter().fail('graph',claim.attempt.id,{message:'The actual worker failed.'});
 const recovered=payload(await adapter.handle(call));assert.equal(recovered.cancellationAttempt.status,'failed');
});
