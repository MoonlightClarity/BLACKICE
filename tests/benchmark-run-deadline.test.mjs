import test from 'node:test';
import assert from 'node:assert/strict';
import { BENCHMARK_DEADLINE_SCHEMA, normalizeBenchmarkBudget, createBenchmarkDeadline, inspectBenchmarkDeadline } from '../lib/benchmark-run-deadline.mjs';
const CREATED='2026-11-21T11:42:02.059Z';
const at=ms=>new Date(Date.parse(CREATED)+ms).toISOString();
function fixture(extra={}) {
  const run={id:'owned-run',taskId:'owned-run',metadata:{clientRequestId:'owned-request'},createdAt:CREATED,
    benchmark:{profile:'minicpm-code-v1'},benchmarkBudget:{wallMs:300000},status:'running',settled:false,...extra};
  run.benchmarkDeadline=createBenchmarkDeadline(run);return run;
}
test('benchmark budget is explicit, bounded and has no ignored fields',()=>{
  assert.equal(normalizeBenchmarkBudget(undefined),null);
  assert.throws(()=>normalizeBenchmarkBudget(undefined,{required:true}),{code:'BENCHMARK_BUDGET_REQUIRED'});
  assert.deepEqual(normalizeBenchmarkBudget({wallMs:300000},{required:true}),{wallMs:300000});
  for(const value of [null,[],300000,{}, {wallMs:'300000'},{wallMs:999},{wallMs:3600001},{wallMs:1.5},{wallMs:Infinity},{wallMs:300000,timeoutMs:1000}]) {
    assert.throws(()=>normalizeBenchmarkBudget(value),{code:'BENCHMARK_BUDGET_INVALID'});
  }
});
test('absolute deadline binds actual admission identity and survives JSON persistence',()=>{
  const run=fixture();
  assert.deepEqual(run.benchmarkDeadline,{schema:BENCHMARK_DEADLINE_SCHEMA,runId:run.id,taskId:run.taskId,requestId:'owned-request',createdAt:CREATED,wallMs:300000,deadlineAt:at(300000)});
  assert.equal(inspectBenchmarkDeadline(JSON.parse(JSON.stringify(run)),at(299999)).action,'wait');
  assert.equal(inspectBenchmarkDeadline(run,at(299999)).remainingMs,1);
});
test('exact expiry and overdue admission synchronously require cancellation',()=>{
  for(const status of ['queued','running','waiting']){
    const run=fixture({status});
    assert.equal(inspectBenchmarkDeadline(run,at(300000)).action,'cancel');
    const late=inspectBenchmarkDeadline(run,at(324617));
    assert.equal(late.action,'cancel');assert.equal(late.remainingMs,0);assert.equal(late.latenessMs,24617);
  }
});
test('terminal result and actual settlement remain distinct from cancellation',()=>{
  for(const status of ['completed','failed','cancelled','blocked']){
    const run=fixture({status,settled:false});
    assert.equal(inspectBenchmarkDeadline(run,at(100)).action,'terminal');
    run.settled=true;
    assert.equal(inspectBenchmarkDeadline(run,at(400000)).action,'settled');
  }
});
test('identity or budget changes cannot reset or extend an existing deadline',()=>{
  const changes=[
    r=>r.id='foreign',r=>r.taskId='foreign',r=>r.metadata.clientRequestId='different',
    r=>r.createdAt=at(1),r=>r.benchmarkBudget.wallMs=300001,
    r=>r.benchmarkDeadline.deadlineAt=at(300001),r=>r.benchmarkDeadline.wallMs=300001,
    r=>r.benchmarkDeadline.requestId='different',r=>r.benchmarkDeadline.extra='ignored',
    r=>delete r.benchmarkDeadline,
  ];
  for(const change of changes){
    const run=fixture();change(run);
    assert.throws(()=>inspectBenchmarkDeadline(run,at(100)),{code:'BENCHMARK_DEADLINE_IDENTITY'});
  }
});
test('invalid clock or unsupported run state is explicit',()=>{
  const run=fixture();
  for(const now of ['yesterday','2026-11-21T11:42:02Z',at(-1)]){
    assert.throws(()=>inspectBenchmarkDeadline(run,now),{code:'BENCHMARK_DEADLINE_CLOCK'});
  }
  assert.throws(()=>inspectBenchmarkDeadline(fixture({status:'unknown'}),at(1)),{code:'BENCHMARK_DEADLINE_STATE'});
  assert.throws(()=>inspectBenchmarkDeadline(fixture({settled:true}),at(1)),{code:'BENCHMARK_DEADLINE_STATE'});
});
test('nonbenchmark and nonfresh task identities cannot gain a deadline',()=>{
  assert.throws(()=>fixture({benchmark:null}),{code:'BENCHMARK_DEADLINE_SCOPE'});
  assert.throws(()=>fixture({taskId:'other-task'}),{code:'BENCHMARK_DEADLINE_IDENTITY'});
  assert.throws(()=>fixture({createdAt:'not-a-time'}),{code:'BENCHMARK_DEADLINE_CLOCK'});
});
test('same admitted request computes the same deadline without observing receipt state',()=>{
  const run=fixture(),snapshot=structuredClone(run);
  run.unrelatedReceiptPagination={pending:true,pagesRead:0,pagesTotal:1000};
  assert.deepEqual(createBenchmarkDeadline(run),snapshot.benchmarkDeadline);
  assert.equal(inspectBenchmarkDeadline(run,at(300000)).action,'cancel');
  assert.equal(run.status,'running');
  assert.deepEqual(run.benchmarkDeadline,snapshot.benchmarkDeadline);
});

test('host requests without a client ID retain an explicit null deadline identity',()=>{
  const run=fixture({metadata:{}});assert.equal(run.benchmarkDeadline.requestId,null);
  assert.equal(inspectBenchmarkDeadline(run,at(1)).action,'wait');
  run.metadata.clientRequestId='later-id';
  assert.throws(()=>inspectBenchmarkDeadline(run,at(1)),{code:'BENCHMARK_DEADLINE_IDENTITY'});
});
