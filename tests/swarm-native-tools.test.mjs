import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SwarmBoardStore } from '../lib/swarm-board.mjs';
import { createNativeSwarmTools, nativeSwarmActorId, NATIVE_SWARM_TOOL_NAMES } from '../lib/swarm-native-tools.mjs';

let n = 0;
const human = { kind:'human', id:'local-session', label:'Local user' };
const payload = result => JSON.parse(result.contentItems.find(v => v.type === 'inputText').text);
const invoke = (adapter, name, args) => adapter.handle({ name, arguments:args });
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'swarm-native-'));
  const board = await new SwarmBoardStore({dataDir}).init();
  t.after(async () => { await board.close(); await rm(dataDir,{recursive:true,force:true}); });
  const factory = createNativeSwarmTools({board});
  const coordinator = await factory({taskId:'saved_task',runId:'run_one',nodeId:'coordinator',isWorker:false});
  const worker = await factory({taskId:'saved_task',runId:'run_one',nodeId:'child_worker',isWorker:true});
  const other = await factory({taskId:'saved_task',runId:'run_one',nodeId:'unbound_worker',isWorker:true});
  const call = (adapter, name, args = {}) => invoke(adapter,name,{requestId:'native_request_'+(++n),...args});
  const write = (adapter, action, value, extra = {}) => call(adapter,'relay_swarm_write',
    {mutationId:'native_mutation_'+(++n),action,value,...extra}).then(payload);
  const apply = (action, value, extra = {}) => board.apply({mutationId:'human_mutation_'+(++n),action,value,...extra},human);
  const setup = async () => {
    await write(coordinator,'create_project',{id:'native_project',name:'Native delivery fixture',
      objective:'Prove host-bound native tool callbacks, not external actions.'});
    await write(coordinator,'register_worker',{id:'assigned_worker',label:'Bound worker',
      scope:'Only the exact owned item',kind:'agent',actorId:worker.identity.id},{
      projectId:'native_project',expectedProjectRevision:board.snapshot('native_project').revision});
    await write(coordinator,'propose_item',{id:'assigned_item',title:'Owned native assignment',
      scope:'Read and acknowledge this bounded fixture only.',
      requirements:'Native callback response and explicit acknowledgment',
      ownerId:'assigned_worker',dependsOn:[],verificationTarget:'unit'},{
      projectId:'native_project',expectedProjectRevision:board.snapshot('native_project').revision});
  };
  return {board,dataDir,factory,coordinator,worker,other,call,write,apply,setup};
}
test('native adapter is host-task/node bound and offers exact read/write/receive/ack contracts',async t=>{
  const f=await fixture(t);
  assert.deepEqual(f.coordinator.tools.map(v=>v.name),NATIVE_SWARM_TOOL_NAMES);
  assert.ok(f.coordinator.tools.every(v=>v.type==='function' && v.inputSchema.additionalProperties===false));
  assert.equal(f.coordinator.identity.id,nativeSwarmActorId({taskId:'saved_task',nodeId:'coordinator'}));
  assert.notEqual(f.coordinator.identity.id,f.worker.identity.id);
  const sameRunRetry=await f.factory({taskId:'saved_task',runId:'run_one',nodeId:'child_worker',isWorker:true});
  assert.equal(sameRunRetry.identity.id,f.worker.identity.id,'same exact worker run preserves native identity');
  const changedRun=await f.factory({taskId:'saved_task',runId:'run_two',nodeId:'child_worker',isWorker:true});
  assert.notEqual(changedRun.identity.id,f.worker.identity.id,
    'new short-lived delegate cannot inherit previous worker identity or receipts');
  const continuedCoordinator=await f.factory({taskId:'saved_task',runId:'run_two',nodeId:'coordinator',isWorker:false});
  assert.equal(continuedCoordinator.identity.id,f.coordinator.identity.id,
    'saved coordinator retains identity across same-task Chat continuation');
  const unrelated=await f.factory({taskId:'other_task',runId:'run_one',nodeId:'child_worker',isWorker:true});
  assert.notEqual(unrelated.identity.id,f.worker.identity.id);
  const initial=payload(await f.call(f.worker,'relay_swarm_read'));
  assert.deepEqual(initial.projects,[]);
  assert.equal(initial.self.role,'scoped-worker');
  assert.equal(initial.self.hostBound,true);
  await f.setup();
  const own=payload(await f.call(f.worker,'relay_swarm_read',{projectId:'native_project'}));
  assert.equal(own.projects.length,1);
  assert.equal(own.projects[0].items[0].phase,'proposed');
  await assert.rejects(f.call(f.worker,'relay_swarm_receive',{
    projectId:'native_project',itemId:'assigned_item',expectedRequirementRevision:1
  }),error=>error.code==='SWARM_NATIVE_NOT_QUEUED');
  await f.write(f.coordinator,'transition',{phase:'queued'},{
    projectId:'native_project',itemId:'assigned_item',expectedItemRevision:1});
  const before=f.board.snapshot().eventCount;
  const offer=payload(await f.call(f.worker,'relay_swarm_receive',{
    projectId:'native_project',itemId:'assigned_item',expectedRequirementRevision:1}));
  assert.equal(offer.duplicate,false);
  assert.match(offer.delivery.id,/^delivery_[a-f0-9]{32}$/);
  assert.match(offer.delivery.ackToken,/^[a-f0-9]{48}$/);
  assert.equal(offer.delivery.state,'response_prepared');
  assert.equal(offer.delivery.authority,'host-prepared-response-only');
  assert.equal(f.board.snapshot().eventCount,before+1);
  const stored=f.board.snapshot('native_project');
  assert.equal(stored.items[0].phase,'queued','preparing a delivery is not a lifecycle delivery claim');
  assert.equal(stored.items[0].nativeHandoff.state,'response_prepared');
  assert.equal(stored.nativeDeliveries.length,1);
  assert.ok(!JSON.stringify(stored).includes(offer.delivery.ackToken),'acknowledgment token never leaks through public board');
  assert.equal(stored.nativeDeliveries[0].workExecuted,false);
  const ackArgs={projectId:'native_project',itemId:'assigned_item',
    expectedRequirementRevision:1,deliveryId:offer.delivery.id,ackToken:offer.delivery.ackToken};
  const acknowledged=payload(await f.call(f.worker,'relay_swarm_ack',ackArgs));
  assert.equal(acknowledged.duplicate,false);
  assert.equal(acknowledged.delivery.state,'acknowledged');
  assert.equal(acknowledged.delivery.authority,'native-engine-observed-acknowledgment');
  assert.equal(f.board.snapshot('native_project').items[0].phase,'queued',
    'host acknowledgment is not application delivery or work completion');
  const count=f.board.snapshot().eventCount;
  await assert.rejects(f.call(changedRun,'relay_swarm_read',{projectId:'native_project'}),
    error=>error.code==='SWARM_NATIVE_SCOPE');
  await assert.rejects(f.call(changedRun,'relay_swarm_ack',ackArgs),
    error=>error.code==='SWARM_NATIVE_SCOPE');
  const repeat=payload(await f.call(sameRunRetry,'relay_swarm_ack',ackArgs));
  assert.equal(repeat.duplicate,true,'same exact worker retries idempotently');
  assert.equal(f.board.snapshot().eventCount,count);
  const repeatedOffer=payload(await f.call(sameRunRetry,'relay_swarm_receive',{
    projectId:'native_project',itemId:'assigned_item',expectedRequirementRevision:1}));
  assert.equal(repeatedOffer.duplicate,true);
  assert.equal(repeatedOffer.delivery.id,offer.delivery.id,'continuation must not produce duplicate assignment dispatch');
  assert.equal(f.board.snapshot().eventCount,count);
  const reopened=await new SwarmBoardStore({dataDir:f.dataDir}).init();
  t.after(()=>reopened.close());
  assert.equal(reopened.snapshot('native_project').nativeDeliveries[0].state,'acknowledged');
  assert.equal(reopened.snapshot('native_project').nativeDeliveries[0].id,offer.delivery.id);
});

test('native worker cannot claim another scope, mutate shared coordinator state or forge actor metadata',async t=>{
  const f=await fixture(t);
  await f.setup();
  const foreign=await f.apply('create_project',{id:'foreign_project',name:'Foreign',objective:'Must stay hidden'});
  const unbound=payload(await f.call(f.other,'relay_swarm_read'));
  assert.deepEqual(unbound.projects,[]);
  await assert.rejects(f.call(f.other,'relay_swarm_read',{projectId:'native_project'}),
    error=>error.code==='SWARM_NATIVE_SCOPE');
  await assert.rejects(f.call(f.worker,'relay_swarm_read',{projectId:'foreign_project'}),
    error=>error.code==='SWARM_NATIVE_SCOPE');
  await assert.rejects(f.write(f.worker,'edit_project',{name:'No'},{
    projectId:'native_project',expectedProjectRevision:f.board.snapshot('native_project').revision}),
    error=>error.code==='SWARM_NATIVE_SCOPE');
  await assert.rejects(f.write(f.worker,'record_source',{id:'faked_source',text:'No'},{
    projectId:'native_project',expectedProjectRevision:f.board.snapshot('native_project').revision}),
    error=>error.code==='SWARM_NATIVE_SCOPE');
  await assert.rejects(f.write(f.worker,'transition',{phase:'queued'},{
    projectId:'native_project',itemId:'assigned_item',expectedItemRevision:1}),
    error=>error.code==='SWARM_NATIVE_SCOPE');
  await assert.rejects(f.write(f.worker,'create_project',{id:'worker_project',name:'No',objective:'No'}),
    error=>error.code==='SWARM_NATIVE_SCOPE');
  await assert.rejects(f.call(f.worker,'relay_swarm_write',{
    mutationId:'forge_actor_1',action:'request_ready',projectId:'native_project',
    itemId:'assigned_item',expectedItemRevision:1,value:{note:'Claim by human'},
    actor:{kind:'human',id:'local-session',label:'Local user'}}),
    error=>error.code==='SWARM_NATIVE_ARGUMENTS');
  assert.equal(f.board.snapshot().projects.length,2);
  assert.equal(f.board.snapshot('native_project').items[0].phase,'proposed');
  assert.equal(foreign.project.coordinator.kind,'human');
});

test('native worker cancellation and read-only deny dispatch before durable mutation; changed requirements invalidate acknowledgments',async t=>{
  const f=await fixture(t);await f.setup();
  await f.write(f.coordinator,'transition',{phase:'queued'},{
    projectId:'native_project',itemId:'assigned_item',expectedItemRevision:1});
  const count=f.board.snapshot().eventCount;
  const controller=new AbortController();controller.abort();
  const stopped=await f.factory({taskId:'saved_task',runId:'cancelled_run',
    nodeId:'child_worker',isWorker:true,signal:controller.signal});
  await assert.rejects(f.call(stopped,'relay_swarm_receive',{
    projectId:'native_project',itemId:'assigned_item',expectedRequirementRevision:1}),
    error=>error.code==='SWARM_NATIVE_CANCELLED');
  assert.equal(f.board.snapshot().eventCount,count);
  const readonly=await f.factory({taskId:'saved_task',runId:'readonly_run',
    nodeId:'child_worker',isWorker:true,canWrite:false});
  assert.deepEqual(readonly.tools.map(v=>v.name),['relay_swarm_read']);
  await assert.rejects(f.call(readonly,'relay_swarm_receive',{
    projectId:'native_project',itemId:'assigned_item',expectedRequirementRevision:1}),
    error=>error.code==='SWARM_NATIVE_UNAVAILABLE');
  assert.equal(f.board.snapshot().eventCount,count);
  const receipt=payload(await f.call(f.worker,'relay_swarm_receive',{
    projectId:'native_project',itemId:'assigned_item',expectedRequirementRevision:1})).delivery;
  const version=f.board.snapshot('native_project').items[0].revision;
  await f.write(f.coordinator,'edit_item',{requirements:'A changed exact obligation.'},{
    projectId:'native_project',itemId:'assigned_item',expectedItemRevision:version});
  await assert.rejects(f.call(f.worker,'relay_swarm_ack',{
    projectId:'native_project',itemId:'assigned_item',expectedRequirementRevision:1,
    deliveryId:receipt.id,ackToken:receipt.ackToken}),
    error=>error.code==='SWARM_REVISION_CONFLICT'||error.code==='SWARM_NATIVE_STALE');
  assert.equal(f.board.snapshot('native_project').items[0].nativeHandoff.applicable,false);
  assert.equal(f.board.snapshot('native_project').nativeDeliveries[0].state,'response_prepared');
  assert.equal(f.board.snapshot('native_project').nativeDeliveries[0].workExecuted,false);
});

test('native cancellation while serialized behind another writer cannot save a prepared response',async t=>{
  const f=await fixture(t);await f.setup();
  await f.write(f.coordinator,'transition',{phase:'queued'},{
    projectId:'native_project',itemId:'assigned_item',expectedItemRevision:1});
  const before=f.board.snapshot().eventCount;
  const controller=new AbortController();
  const bound=await f.factory({taskId:'saved_task',runId:'run_one',nodeId:'child_worker',
    isWorker:true,signal:controller.signal});
  // Hold the actual serialized ledger queue; cancellation happens after tool
  // admission but before the scheduled mutation acquires its write turn.
  let release;
  f.board.tail=new Promise(resolve=>{release=resolve;});
  const attempted=f.call(bound,'relay_swarm_receive',{
    projectId:'native_project',itemId:'assigned_item',expectedRequirementRevision:1});
  controller.abort();
  release();
  await assert.rejects(attempted,error=>error.code==='SWARM_NATIVE_CANCELLED');
  await f.board.tail;
  assert.equal(f.board.snapshot().eventCount,before);
  assert.deepEqual(f.board.snapshot('native_project').nativeDeliveries,[]);
});
