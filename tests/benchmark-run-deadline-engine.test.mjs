import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {HarnessEngine} from '../lib/engine.mjs';
import {createBenchmarkDeadline} from '../lib/benchmark-run-deadline.mjs';
import {benchmarkFixture,fixtureWorkflow} from './helpers/minicpm-benchmark-fixture.mjs';

const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const requestFor=(f,wallMs=1000,requestId='deadline-fixture')=>({
 requestId,workflow:structuredClone(fixtureWorkflow),
 input:{task:'Exercise the host deadline without an external model.',cwd:f.workspace,
  directoryActions:'on',chatPlanning:'off',pastChats:'off',
  benchmark:structuredClone(f.request),benchmarkBudget:{wallMs}}
});
async function setup(t){
 const cleanups=[],f=benchmarkFixture({after:fn=>cleanups.push(fn)});
 const runtime=new EventEmitter();
 runtime.status=()=>({connected:true,authenticated:true,models:[{id:'fixture-model',supportsTools:true}]});
 runtime.runAgent=async()=>{throw Error('An external provider must never run in this host fixture.');};
 const engine=await new HarnessEngine({runtime,dataDir:path.join(f.root,'engine'),defaultCwd:f.workspace}).init();
 const original={persist:engine.persist,cancelRun:engine.cancelRun,schedulePersist:engine.schedulePersist};
 const release=[];let mocked=false,executions=0;
 // Explicit persistence calls still run. Unrelated coalescing is outside this timer contract.
 engine.schedulePersist=()=>{};
 engine.execute=async run=>{executions++;run.finishedAt=new Date().toISOString();engine.updateRun(run,'completed');};
 t.after(async()=>{
  for(const fn of release)fn();
  engine.cancelRun=original.cancelRun;engine.persist=original.persist;engine.schedulePersist=original.schedulePersist;
  if(mocked)t.mock.timers.reset();
  await engine.close();for(const fn of cleanups)await fn();
 });
 return {...f,engine,original,release,get executions(){return executions;},
  clock(){t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-11-21T00:00:00.000Z')});mocked=true;},
  holdExecution(){const started=defer();engine.execute=async(run,controller)=>{
    executions++;engine.updateRun(run,'running');started.resolve(controller);
    if(controller.signal.aborted)return;
    await new Promise(resolve=>controller.signal.addEventListener('abort',resolve,{once:true}));
   };return started.promise;}
 };
}

test('host requires an explicit selected benchmark budget and rejects a budget outside that scope',async t=>{
 const f=await setup(t),missing=requestFor(f);delete missing.input.benchmarkBudget;
 assert.throws(()=>f.engine.startRun(missing),{code:'BENCHMARK_BUDGET_REQUIRED'});
 for(const wallMs of [0,999,3600001,1.5,'1000']){
  assert.throws(()=>f.engine.startRun(requestFor(f,wallMs)),{code:'BENCHMARK_BUDGET_INVALID'});
 }
 const ordinary=requestFor(f);delete ordinary.input.benchmark;
 assert.throws(()=>f.engine.startRun(ordinary),error=>/^BENCHMARK_/.test(error.code));
 assert.equal(f.engine.runs.size,0);assert.equal(f.executions,0);
});

test('host request replay binds the wall budget and does not create or extend another run',async t=>{
 const f=await setup(t);f.clock();const request=requestFor(f);
 const first=f.engine.startRun(request),again=f.engine.startRun(structuredClone(request));
 assert.equal(again.id,first.id);assert.equal(f.engine.runs.size,1);
 const deadline=structuredClone(f.engine.runs.get(first.id).benchmarkDeadline);
 const changed=structuredClone(request);changed.input.benchmarkBudget.wallMs=2000;
 assert.throws(()=>f.engine.startRun(changed),{code:'RUN_REQUEST_CONFLICT'});
 await f.engine.executions.get(first.id);
 const replay=f.engine.startRun(structuredClone(request));
 assert.equal(replay.id,first.id);assert.deepEqual(replay.benchmarkDeadline,deadline);assert.equal(f.executions,1);
 let cancellations=0;f.engine.cancelRun=()=>{cancellations++;throw Error('A settled run must not be cancelled.');};
 t.mock.timers.tick(5000);await flush();
 assert.equal(cancellations,0);assert.equal(f.engine.runs.get(first.id).status,'completed');
});

test('host deadline cancels while admission persistence and receipt reporting remain unresolved',async t=>{
 const f=await setup(t);f.clock();const blocked=defer(),entered=defer();f.release.push(blocked.resolve);
 f.engine.persist=()=>{entered.resolve();return blocked.promise;};
 const initial=f.engine.startRun(requestFor(f));await entered.promise;
 const run=f.engine.runs.get(initial.id),controller=f.engine.controllers.get(initial.id),execution=f.engine.executions.get(initial.id);
 const deadline=structuredClone(run.benchmarkDeadline);
 t.mock.timers.tick(1000);
 assert.equal(controller.signal.aborted,true);assert.equal(run.status,'cancelled');
 assert.equal(run.settled,false);assert.equal(f.executions,0);
 assert.ok(run.benchmarkDeadlineEnforcement);assert.deepEqual(run.benchmarkDeadline,deadline);
 blocked.resolve();await execution;
 assert.equal(run.settled,true);assert.equal(f.executions,0);
});

test('expired admission is checked before provider execution even before a delayed timer callback',async t=>{
 const f=await setup(t);f.clock();const blocked=defer(),entered=defer();f.release.push(blocked.resolve);
 f.engine.persist=()=>{entered.resolve();return blocked.promise;};
 const initial=f.engine.startRun(requestFor(f));await entered.promise;
 const run=f.engine.runs.get(initial.id),execution=f.engine.executions.get(initial.id);
 t.mock.timers.setTime(Date.parse(run.createdAt)+3000);
 blocked.resolve();await execution;
 assert.equal(run.status,'cancelled');assert.equal(run.settled,true);assert.equal(f.executions,0);
 assert.equal(run.benchmarkDeadlineEnforcement.latenessMs,2000);
});

test('failed cancellation still aborts the owned controller and leaves a terminal error',async t=>{
 const f=await setup(t);f.clock();const started=f.holdExecution();
 const initial=f.engine.startRun(requestFor(f)),controller=await started;
 const run=f.engine.runs.get(initial.id),execution=f.engine.executions.get(initial.id);
 f.engine.cancelRun=()=>{throw Object.assign(Error('injected cancellation failure'),{code:'CANCEL_BROKEN'});};
 t.mock.timers.tick(1000);
 assert.equal(controller.signal.aborted,true);
 await execution;assert.equal(run.settled,true);assert.equal(run.status,'failed');
 assert.match(JSON.stringify(run.benchmarkDeadlineEnforcement),/CANCEL_BROKEN/);
});

for(const mutation of ['coherent-extension','deleted-selection']){
 test('captured admission cannot be bypassed by '+mutation,async t=>{
  const f=await setup(t);f.clock();const started=f.holdExecution();
  const initial=f.engine.startRun(requestFor(f)),controller=await started;
  const run=f.engine.runs.get(initial.id),execution=f.engine.executions.get(initial.id);
  const originalDeadline=run.benchmarkDeadline.deadlineAt;
  if(mutation==='coherent-extension'){run.benchmarkBudget.wallMs=60000;run.benchmarkDeadline=createBenchmarkDeadline(run);}
  else delete run.benchmark;
  t.mock.timers.tick(1000);
  assert.equal(controller.signal.aborted,true);await execution;
  assert.equal(run.settled,true);assert.ok(['failed','cancelled'].includes(run.status));
  assert.equal(run.benchmarkDeadlineEnforcement.deadlineAt,originalDeadline);
  assert.match(JSON.stringify(run.benchmarkDeadlineEnforcement),/BENCHMARK_DEADLINE_/);
 });
}

test('a replacement object at the same run ID is never cancelled as the captured owner',async t=>{
 const f=await setup(t);f.clock();const started=f.holdExecution();
 const initial=f.engine.startRun(requestFor(f)),controller=await started;
 const run=f.engine.runs.get(initial.id),execution=f.engine.executions.get(initial.id);
 const foreign={...structuredClone(run),input:'Different owner object'};
 f.engine.runs.set(initial.id,foreign);f.release.push(()=>f.engine.runs.set(initial.id,run));
 let cancellations=0;f.engine.cancelRun=()=>{cancellations++;throw Error('Foreign cancellation attempted.');};
 t.mock.timers.tick(1000);
 assert.equal(controller.signal.aborted,true);assert.equal(cancellations,0);
 assert.equal(foreign.status,'running');assert.equal(foreign.settled,false);
 await execution;assert.equal(run.settled,true);assert.ok(['failed','cancelled'].includes(run.status));
 assert.match(JSON.stringify(run.benchmarkDeadlineEnforcement),/BENCHMARK_DEADLINE_/);
});

test('deadline reporting failure remains explicit after cancellation and cannot delay the abort',async t=>{
 const f=await setup(t);f.clock();const started=f.holdExecution();
 const initial=f.engine.startRun(requestFor(f)),controller=await started;
 const run=f.engine.runs.get(initial.id),execution=f.engine.executions.get(initial.id);
 f.engine.persist=async()=>{throw Object.assign(Error('injected report failure'),{code:'REPORT_BROKEN'});};
 t.mock.timers.tick(1000);assert.equal(controller.signal.aborted,true);
 await execution;await flush();
 assert.equal(run.status,'cancelled');assert.equal(run.settled,true);
 assert.match(JSON.stringify(run.benchmarkDeadlineEnforcement),/REPORT_BROKEN/);
});

test('ordinary runs do not acquire benchmark deadline state or cancellation behavior',async t=>{
 const f=await setup(t);f.clock();const request=requestFor(f);
 delete request.input.benchmark;delete request.input.benchmarkBudget;
 const initial=f.engine.startRun(request);await f.engine.executions.get(initial.id);
 const run=f.engine.runs.get(initial.id);
 assert.equal(run.benchmarkDeadline,undefined);assert.equal(run.benchmarkDeadlineEnforcement,undefined);
 t.mock.timers.tick(5000);await flush();assert.equal(run.status,'completed');assert.equal(f.executions,1);
});

test('identity mutation cannot overwrite the first stop receipt or leak captured execution handles',async t=>{
 const f=await setup(t);f.clock();const blocked=defer(),entered=defer();f.release.push(blocked.resolve);
 f.engine.persist=()=>{entered.resolve();return blocked.promise;};
 const initial=f.engine.startRun(requestFor(f));await entered.promise;
 const run=f.engine.runs.get(initial.id),controller=f.engine.controllers.get(initial.id),execution=f.engine.executions.get(initial.id);
 f.release.push(()=>{run.id=initial.id;});
 run.id='mutated-owner-id';
 let cancellations=0;f.engine.cancelRun=()=>{cancellations++;throw Error('A foreign ID must not be cancelled.');};
 t.mock.timers.tick(1000);
 const first=run.benchmarkDeadlineEnforcement,requestedAt=first.requestedAt;
 assert.equal(controller.signal.aborted,true);assert.equal(cancellations,0);
 assert.equal(first.cancelError.code,'BENCHMARK_DEADLINE_OWNER_CHANGED');
 t.mock.timers.tick(100);
 blocked.resolve();await execution;
 assert.equal(run.benchmarkDeadlineEnforcement,first);assert.equal(first.requestedAt,requestedAt);
 assert.equal(first.stage,'timer');assert.equal(first.settledStatus,'failed');assert.ok(first.settledAt);
 assert.equal(f.engine.controllers.has(initial.id),false);assert.equal(f.engine.executions.has(initial.id),false);
});
