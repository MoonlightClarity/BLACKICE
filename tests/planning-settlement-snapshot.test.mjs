import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {ResponseCycleService} from '../lib/response-cycle.mjs';

async function fixture(t,{status='failed',cycleState='executing'}={}){
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-planning-settlement-'));
  const store=await new PlanningBrowserStore({dataDir:dir}).init();
  let providerCalls=0,run;
  const updates=[];
  const runner={start:async()=>{providerCalls++;throw Error('Settlement must not start analytical or operational work.');}};
  const service=new ResponseCycleService({store,runner,onUpdated:()=>{if(run)updates.push(structuredClone(run.responseCycle));}});
  t.after(async()=>{await service.close();await store.close();await rm(dir,{recursive:true,force:true});});
  const initial=await store.create({conversationId:'settlement-fixture',title:'Preserve recorded operational work',objective:'Report the recorded fixture result without repeating its action.',cwd:dir});
  const created=await service.createCycle(initial.id,{title:'Recorded workflow result',purpose:'Evaluate the existing fixture output and preserve its limitations.',planningExecutionMode:'automatic',expectedRequestRevision:initial.revision,clientRequestId:'settlement-fixture-cycle'});
  const cycle=created.cycles[0],plan=created.nodes.find(node=>node.id===cycle.stageNodeIds.plan);
  const planRef={requestId:created.id,cycleId:cycle.id,nodeId:plan.id,nodeRevision:plan.revision,responseId:plan.response?.id||null};
  const output='The fixture worker completed its recorded action; the final analytical review remains incomplete.';
  run={id:'settlement-fixture-run',status,error:status==='failed'?'The recorded workflow exceeds the bounded evaluation context. Its original records are preserved.':'The fixture was stopped during final review.',errorCode:status==='failed'?'RESPONSE_CYCLE_CONTEXT_LIMIT':'FIXTURE_CANCELLED',output,
    nodes:{worker:{status:'completed',output,threadId:'fixture-thread',turnId:'fixture-turn'}},
    events:[{type:'agent.event',runId:'settlement-fixture-run',nodeId:'worker',at:'2026-10-31T00:00:00.000Z',data:{type:'tool.result',callId:'fixture-call',success:true,message:'Observed fixture receipt retained.'}}],
    responseCycle:{requestId:created.id,cycleId:cycle.id,state:cycleState,planRef,partial:true},
    viability:{requestId:created.id,planRef}};
  await service.writer.configureResponseCycle(created.id,{cyclePatch:{id:cycle.id,state:cycleState,linkedRunId:run.id,planRef,execution:{required:true,state:'running',runId:run.id}}});
  return{store,service,run,requestId:created.id,cycleId:cycle.id,updates,get providerCalls(){return providerCalls;}};
}

test('failed finalization synchronizes the saved-run cycle state while retaining completed work and its original failure',async t=>{
  const f=await fixture(t),before=structuredClone(f.run);
  await f.service.settleRun(f.run,{state:'failed',error:f.run.error});
  const saved=await f.store.get(f.requestId),cycle=saved.cycles.find(item=>item.id===f.cycleId);
  assert.equal(cycle.state,'failed');
  assert.equal(cycle.execution.state,'failed');
  assert.deepEqual(cycle.failure,{code:before.errorCode,message:before.error});
  assert.deepEqual(f.run,{...before,responseCycle:{...before.responseCycle,state:'failed'}});
  assert.equal(f.updates.at(-1).state,'failed','the update observer sees the committed terminal binding');
  assert.equal(f.providerCalls,0);
  assert.equal(saved.attempts.length,0,'settlement does not claim or run an analytical review');
});

test('cancelled finalization synchronizes the cycle snapshot without replacing partial output or replaying a completed action',async t=>{
  const f=await fixture(t,{status:'cancelled',cycleState:'evaluating'}),before=structuredClone(f.run);
  await f.service.settleRun(f.run,{state:'cancelled',error:f.run.error});
  const saved=await f.store.get(f.requestId),cycle=saved.cycles.find(item=>item.id===f.cycleId);
  assert.equal(cycle.state,'cancelled');
  assert.equal(cycle.execution.state,'cancelled');
  assert.deepEqual(cycle.failure,{code:before.errorCode,message:before.error});
  assert.deepEqual(f.run,{...before,responseCycle:{...before.responseCycle,state:'cancelled'}});
  assert.equal(f.updates.at(-1).state,'cancelled');
  assert.equal(f.providerCalls,0);
  assert.equal(saved.attempts.length,0);
});

test('a failed settlement write leaves both the run snapshot and durable cycle unchanged',async t=>{
  const f=await fixture(t),beforeRun=structuredClone(f.run),beforeRequest=await f.store.get(f.requestId),updates=f.updates.length;
  const storageError=Object.assign(Error('Fixture durable graph write failed.'),{code:'FIXTURE_GRAPH_WRITE_FAILED'});
  const writer=f.service.writer;
  f.service.writer={...writer,configureResponseCycle:async()=>{throw storageError;}};
  await assert.rejects(f.service.settleRun(f.run,{state:'failed',error:f.run.error}),error=>error===storageError);
  assert.deepEqual(f.run,beforeRun,'a failed persistence attempt must not publish a terminal cycle state');
  assert.deepEqual(await f.store.get(f.requestId),beforeRequest);
  assert.equal(f.updates.length,updates);
  assert.equal(f.providerCalls,0);
  f.service.writer=writer;
});
