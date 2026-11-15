import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { HarnessEngine } from '../lib/engine.mjs';
import { SwarmBoardStore } from '../lib/swarm-board.mjs';
import { createNativeSwarmTools, NATIVE_SWARM_TOOL_NAMES } from '../lib/swarm-native-tools.mjs';
import { fixtureOutcomeReview, finishFixtureCandidate } from './fixture-modular-provider.mjs';

let serial = 0;
const body = result => JSON.parse(result.contentItems.find(part => part.type === 'inputText').text);
const graph = () => ({ id:'native-swarm-engine-graph',name:'Native Swarm engine verification',
  nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'fixture-model',
    prompt:'Coordinate one local Swarm assignment using attached native tools.'},{id:'output',type:'output'}],
  edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],
  settings:{planningMode:'off'} });
const call = (options,name,args={}) => options.onToolCall({
  name, arguments:{requestId:'engine_native_'+(++serial),...args}
});
const written = (options,action,value,extra={}) => call(options,'relay_swarm_write',{
  mutationId:'engine_mutation_'+(++serial),action,value,...extra
}).then(receipt => {
  assert.equal(receipt.success,true,JSON.stringify(receipt));
  return body(receipt);
});

async function fixture(t,execute) {
  const dir=await mkdtemp(path.join(tmpdir(),'swarm-native-engine-'));
  const cwd=path.join(dir,'workspace');await mkdir(cwd);
  const board=await new SwarmBoardStore({dataDir:dir}).init();
  const nativeSwarmTools=createNativeSwarmTools({board});
  class FixtureRuntime extends EventEmitter {
    status(){return {connected:true,authenticated:true,defaultModel:'fixture-model'};}
    async runAgent(options) {
      const review=fixtureOutcomeReview(options);
      if (review) return review;
      return finishFixtureCandidate(options,await execute(options));
    }
    async close(){}
  }
  const engine=await new HarnessEngine({runtime:new FixtureRuntime(),
    dataDir:dir,defaultCwd:cwd,nativeSwarmTools}).init();
  engine.runtimeSettings={get:()=>({executionGuardrails:false,subagentsEnabled:true,maxSubagents:2})};
  t.after(async()=>{await engine.close();await board.close();await rm(dir,{recursive:true,force:true});});
  return {engine,board,nativeSwarmTools,async run(workflow=graph()){
    const running=engine.startRun({workflow,input:'Coordinate the native Swarm fixture only.',
      planningMode:'off'});
    await engine.executions.get(running.id);
    const done=engine.getRun(running.id);
    assert.equal(done.status,'completed',JSON.stringify(done));
    return done;
  }};
}

test('real HarnessEngine provider tool registration, native dispatch and acknowledgment run through host callback',async t=>{
  let f, observed={};
  f=await fixture(t,async options=>{
    const names=options.dynamicTools.map(tool=>tool.name);
    assert.ok(NATIVE_SWARM_TOOL_NAMES.every(name=>names.includes(name)),'actual runtime tool catalog contains all native Swarm operations');
    const schema=options.dynamicTools.find(tool=>tool.name==='relay_swarm_write')?.inputSchema;
    assert.ok(schema?.oneOf?.length>=12,'runtime supplies discoverable native write contract');
    const self=body(await call(options,'relay_swarm_read')).self;
    assert.equal(self.kind,'native');assert.equal(self.role,'coordinator');assert.equal(self.hostBound,true);
    observed.nativeId=self.id;
    await written(options,'create_project',{id:'engine_swarm',name:'Engine native project',
      objective:'Real host callback, no outside network or model.'});
    await written(options,'register_worker',{id:'self_worker',label:'Same host node',
      scope:'One owned fixture',kind:'agent',actorId:self.id},{
      projectId:'engine_swarm',expectedProjectRevision:f.board.snapshot('engine_swarm').revision});
    await written(options,'propose_item',{id:'engine_item',title:'Exact native assignment',
      scope:'Simulated provider callback only',requirements:'Produce distinct prepared/ack receipts',
      ownerId:'self_worker',dependsOn:[],verificationTarget:'unit'},{
      projectId:'engine_swarm',expectedProjectRevision:f.board.snapshot('engine_swarm').revision});
    await written(options,'transition',{phase:'queued'},{
      projectId:'engine_swarm',itemId:'engine_item',expectedItemRevision:1});
    const offered=body(await call(options,'relay_swarm_receive',{
      projectId:'engine_swarm',itemId:'engine_item',expectedRequirementRevision:1}));
    assert.equal(offered.delivery.state,'response_prepared');
    assert.equal(f.board.snapshot('engine_swarm').items[0].phase,'queued');
    const ack=body(await call(options,'relay_swarm_ack',{
      projectId:'engine_swarm',itemId:'engine_item',expectedRequirementRevision:1,
      deliveryId:offered.delivery.id,ackToken:offered.delivery.ackToken}));
    assert.equal(ack.delivery.state,'acknowledged');
    assert.equal(ack.delivery.workExecuted,false);
    observed.deliveryId=offered.delivery.id;
    return {output:'Engine-native callback exercised with bounded local fixtures.',threadId:'native-swarm-engine'};
  });
  const run=await f.run();
  const project=f.board.snapshot('engine_swarm');
  assert.equal(project.coordinator.id,observed.nativeId);
  assert.equal(project.nativeDeliveries.length,1);
  assert.equal(project.nativeDeliveries[0].id,observed.deliveryId);
  assert.equal(project.nativeDeliveries[0].state,'acknowledged');
  assert.equal(project.items[0].phase,'queued','runtime callback did not manufacture work delivery');
  assert.equal(project.items[0].completionCurrent,false);
  assert.equal(run.nodes.agent.toolNames.includes('relay_swarm_ack'),true);
  const restored=f.engine.nativeHistoryDescription(run,
    run.workflow.nodes.find(item=>item.id==='agent'),run.nodes.agent,'fixture');
  assert.ok(restored.dynamicTools.some(tool=>tool.name==='relay_swarm_ack'),
    'native historical tool contracts can be reconstructed for the original saved run');
});

test('real delegated subagent tool gateway dispatch is bound to its own node, not parent',async t=>{
  let f,workerRun=false,workerIdentity=null,workerDelivery=null,coordinatorNative=null;
  f=await fixture(t,async options=>{
    if(options.prompt.startsWith('You are a short-lived BLACKICE subagent.')){
      if(options.prompt.includes('Independently inspect the absence of external side effects'))
        return {output:'Independent bounded audit complete; no Swarm write.'};
      workerRun=true;
      assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_swarm_read'),'worker tool is actually attached');
      assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_swarm_receive'));
      const identity=body(await call(options,'relay_swarm_read')).self;
      assert.equal(identity.role,'scoped-worker');
      workerIdentity=identity.id;
      assert.notEqual(identity.id,coordinatorNative,'worker is not parent coordinator');
      const human={kind:'human',id:'local-session',label:'Local user'};
      await f.board.apply({mutationId:'bind_subagent_'+(++serial),action:'register_worker',
        projectId:'delegated_swarm',expectedProjectRevision:f.board.snapshot('delegated_swarm').revision,
        value:{id:'subworker',label:'Bound subagent',scope:'Only delegated work item',
          kind:'agent',actorId:identity.id}},human);
      await f.board.apply({mutationId:'assign_subagent_'+(++serial),action:'propose_item',
        projectId:'delegated_swarm',expectedProjectRevision:f.board.snapshot('delegated_swarm').revision,
        value:{id:'delegated_item',title:'Delegated item',scope:'Host-scoped child work',
          requirements:'Prepare and acknowledge one synthetic receipt',ownerId:'subworker',
          dependsOn:[],verificationTarget:'unit'}},human);
      await f.board.apply({mutationId:'queue_subagent_'+(++serial),action:'transition',
        projectId:'delegated_swarm',itemId:'delegated_item',expectedItemRevision:1,
        value:{phase:'queued'}},human);
      const now=body(await call(options,'relay_swarm_read',{projectId:'delegated_swarm'}));
      assert.equal(now.projects[0].items[0].ownerId,'subworker');
      const offered=body(await call(options,'relay_swarm_receive',{
        projectId:'delegated_swarm',itemId:'delegated_item',expectedRequirementRevision:1}));
      assert.equal(offered.delivery.state,'response_prepared');
      const done=body(await call(options,'relay_swarm_ack',{
        projectId:'delegated_swarm',itemId:'delegated_item',expectedRequirementRevision:1,
        deliveryId:offered.delivery.id,ackToken:offered.delivery.ackToken}));
      assert.equal(done.delivery.state,'acknowledged');
      const reported=await written(options,'transition',{
        phase:'delivered',reference:'native-subagent-model-reported-only'},{
        projectId:'delegated_swarm',itemId:'delegated_item',
        expectedItemRevision:f.board.snapshot('delegated_swarm').items[0].revision});
      assert.equal(reported.project.items[0].phase,'delivered');
      workerDelivery=offered.delivery.id;
      return {output:'Delegated native worker callback acknowledged synthetic assignment.'};
    }
    const self=body(await call(options,'relay_swarm_read')).self;
    coordinatorNative=self.id;
    await written(options,'create_project',{id:'delegated_swarm',name:'Delegated fixture',
      objective:'Verify host worker integration without external provider.'});
    const result=await options.onToolCall({name:'relay_delegate',arguments:{
      tasks:[{id:'swarm_work',prompt:'Use the attached relay_swarm tools to acknowledge the assigned native fixture.'},
        {id:'independent_audit',prompt:'Independently inspect the absence of external side effects and report without Swarm writes.'}]}});
    assert.equal(result.success,true,JSON.stringify(result));
    return {output:'Delegation observed.',threadId:'native-swarm-delegate'};
  });
  await f.run();
  assert.equal(workerRun,true);
  assert.notEqual(workerIdentity,null);
  const saved=f.board.snapshot('delegated_swarm');
  assert.equal(saved.items[0].nativeHandoff.id,workerDelivery);
  assert.equal(saved.items[0].nativeHandoff.state,'acknowledged');
  assert.equal(saved.items[0].phase,'delivered');
  assert.equal(saved.items[0].nativeHandoff.workExecuted,false);
  assert.equal(saved.items[0].completionCurrent,false);
});

test('saved native engine tool catalog is not silently expanded after provider becomes available',async t=>{
  let f,turns=0;
  f=await fixture(t,async options=>{
    turns++;
    assert.ok(!options.dynamicTools.some(tool=>tool.name.startsWith('relay_swarm_')));
    if (turns===2) {
      const rejected=await options.onToolCall({name:'relay_swarm_read',
        arguments:{requestId:'unattached_native_swarm'}});
      assert.equal(rejected.success,false);
      assert.equal(rejected.code,'SWARM_NATIVE_UNAVAILABLE');
    }
    return {output:'Catalog inspected.',threadId:'swarm-old-provider'};
  });
  f.engine.nativeSwarmTools=null;
  const first=await f.run();
  f.engine.nativeSwarmTools=f.nativeSwarmTools;
  const second=f.engine.continueRun(first.id,{nodeId:'agent',message:'Continue with the original native tool catalog.'});
  await f.engine.executions.get(second.id);
  assert.equal(f.engine.getRun(second.id).status,'completed');
  assert.equal(turns,2);
});

test('native engine read-only dispatch exposes only scoped observation; denied writes leave ledger unchanged',async t=>{
  let f,saw=false;
  f=await fixture(t,async options=>{
    assert.equal(options.sandbox,'read-only');
    assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_swarm_read'));
    assert.ok(!options.dynamicTools.some(tool=>tool.name==='relay_swarm_write'));
    assert.ok(!options.dynamicTools.some(tool=>tool.name==='relay_swarm_receive'));
    const before=f.board.snapshot().eventCount;
    const result=await options.onToolCall({name:'relay_swarm_write',arguments:{
      requestId:'illegal_readonly',mutationId:'illegal_readonly_mut',action:'create_project',
      value:{id:'not_created',name:'No',objective:'Read-only denial'} }});
    assert.equal(result.success,false);
    assert.ok(['SWARM_NATIVE_UNAVAILABLE','TASK_PLAN_READ_ONLY'].includes(result.code));
    assert.equal(f.board.snapshot().eventCount,before);
    saw=true;
    return {output:'Read-only boundary checked.'};
  });
  const execute=f.engine.execute.bind(f.engine);
  f.engine.execute=(run,controller)=>{
    run.workflow.nodes.find(node=>node.id==='agent').sandbox='read-only';
    return execute(run,controller);
  };
  await f.run();
  assert.equal(saw,true);
});
