import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promises as fs } from 'node:fs';
import { archiveOversizedRuns } from '../lib/run-history-archive.mjs';
import { streamCompactRunHistory, compactOversizedRunsOnDisk } from '../lib/run-history-stream.mjs';

const mk = async t => {
  const dir=await fs.mkdtemp(path.join(tmpdir(),'blackice-history-stream-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  return dir;
};
function legacy(){
  const bigState={taskId:'task-foo',revision:17,plan:{origin:'agent'},steps:[{id:'first',evidence:'a'.repeat(65000)}]};
  const events=[
    {type:'agent.event',runId:'a',nodeId:'agent',data:{type:'task.state',state:bigState}},
    {type:'agent.event',runId:'a',nodeId:'agent',data:{type:'item',stage:'completed',item:{type:'dynamicToolCall',id:'call-1',tool:'relay_browser',arguments:{action:'snapshot',query:'some "quoted" value'},success:true,contentItems:[{type:'inputText',text:'z'.repeat(60000)}]}}},
    {type:'agent.event',runId:'a',nodeId:'agent',data:{type:'message',text:'An accurate user-facing receipt stays available'}},
    {type:'agent.event',runId:'a',nodeId:'agent',data:{type:'task.state',state:{...bigState,revision:18}}}
  ];
  return [
    {id:'a',taskId:'task-foo',status:'failed',events,taskState:bigState,metadata:{site:'Waypoint and résumé 🦊',trailing:'visible "quote" with slash \\'}},
    {id:'b',status:'completed',events:[{type:'agent.event',runId:'b',nodeId:'agent',data:{type:'message',text:'Final "ok"'}}],nodes:{agent:{status:'completed'}},input:'Recheck \u{1f642}'}
  ];
}
test('byte streaming across nearly every UTF-8 and quote boundary reduces repeated Planning state while retaining all non-event fields',async t=>{
  const dir=await mk(t),file=path.join(dir,'runs.json');
  const original=legacy();
  await fs.writeFile(file,JSON.stringify(original,null,2));
  const archive=await archiveOversizedRuns(dir,{thresholdBytes:100});
  const res=await compactOversizedRunsOnDisk(dir,{archive,thresholdBytes:100,highWaterMark:7});
  const compact=JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(res.runs,2);
  assert.equal(res.eventCollections,2);
  assert.equal(compact.length,2);
  assert.deepEqual(compact[0].taskState,original[0].taskState);
  assert.deepEqual(compact[0].metadata,original[0].metadata);
  assert.equal(compact[1].input,original[1].input);
  assert.deepEqual(compact[1].events[0],original[1].events[0]);
  assert.equal(compact[0].events[0].data.state.revision,17);
  assert.equal(compact[0].events[0].data.state.steps,undefined);
  assert.equal(compact[0].events[1].data.item.success,true);
  assert.equal(compact[0].events[2].data.text,'An accurate user-facing receipt stays available');
  assert.ok(res.compactedBytes<res.originalBytes*0.35,JSON.stringify(res));
  const old=JSON.parse(await fs.readFile(path.join(dir,archive.relativePath),'utf8'));
  assert.deepEqual(old,original);
});

test('byte stream recognizes empty event collections without changing later source fields',async t=>{
  const dir=await mk(t),file=path.join(dir,'runs.json');
  const original=[{id:'one',events:[],nodes:{agent:{message:'start'}}},{id:'two',events:[],notes:'unicode 🧠 and escaped " text'}];
  await fs.writeFile(file,JSON.stringify(original));
  const r=await archiveOversizedRuns(dir,{thresholdBytes:10});
  await compactOversizedRunsOnDisk(dir,{archive:r,thresholdBytes:10,highWaterMark:3});
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),original);
});

test('invalid nested input fails without replacing or deleting the saved source or original archive',async t=>{
  const dir=await mk(t),file=path.join(dir,'runs.json');
  const text='[{"id":"one","events":[{"type":"agent.event","data":{"type":"task.state","state":{}}}]';
  await fs.writeFile(file,text);
  const archive=await archiveOversizedRuns(dir,{thresholdBytes:10});
  await assert.rejects(compactOversizedRunsOnDisk(dir,{archive,thresholdBytes:10,highWaterMark:4}),{code:'RUN_MIGRATION_INVALID'});
  assert.equal(await fs.readFile(file,'utf8'),text);
  assert.equal(await fs.readFile(path.join(dir,archive.relativePath),'utf8'),text);
});

test('migration refuses to modify source unless a matching immutable original archive exists',async t=>{
  const dir=await mk(t),file=path.join(dir,'runs.json');
  const raw=JSON.stringify(legacy());await fs.writeFile(file,raw);
  await assert.rejects(compactOversizedRunsOnDisk(dir,{archive:null,thresholdBytes:10}),{code:'RUN_MIGRATION_INVALID'});
  assert.equal(await fs.readFile(file,'utf8'),raw);
});

test('streamed compaction preserves the last valid event and respects per-run budget',async t=>{
  const dir=await mk(t),file=path.join(dir,'runs.json');
  const big=Array.from({length:2500},(_,i)=>({type:'agent.event',data:{type:'task.state',state:{taskId:'a',revision:i+1,steps:[{evidence:'x'.repeat(10000)}]}}}));
  big.push({type:'agent.event',data:{type:'message',text:'last verified answer'}});
  await fs.writeFile(file,JSON.stringify([{id:'large',events:big,taskState:{revision:2500}}]));
  const archive=await archiveOversizedRuns(dir,{thresholdBytes:10});
  const r=await compactOversizedRunsOnDisk(dir,{archive,thresholdBytes:10,highWaterMark:16384});
  const compact=JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(compact[0].events.at(-1).data.text,'last verified answer');
  assert.ok(compact[0].events.length<=2501);
  assert.equal(compact[0].taskState.revision,2500);
  assert.ok(r.compactedBytes<r.originalBytes/12,JSON.stringify(r));
});
