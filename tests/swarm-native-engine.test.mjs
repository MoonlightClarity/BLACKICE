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
             // Assignment must already be host-bound by a coordinator relay_swarm_launch.
       // No local fixture-side register/assign/queue writes substitute for launch.
const now=body(await call(options,'relay_swarm_read',{projectId:'delegated_swarm'}));
             const assigned=now.projects[0];
       const bound=assigned.workers.find(w=>w.actorId===identity.id);
       assert.ok(bound,'real host launch registered this exact worker');
       assert.equal(assigned.items[0].ownerId,bound.id);
       assert.equal(assigned.items[0].phase,'queued');
       assert.equal(assigned.nativeLaunches[0].state,'provider_attempted');
      const offered=body(await call(options,'relay_swarm_receive',{
        projectId:'delegated_swarm',itemId:'delegated_item',expectedRequirementRevision:now.projects[0].items[0].requirementRevision}));
      assert.equal(offered.delivery.state,'response_prepared');
      const done=body(await call(options,'relay_swarm_ack',{
        projectId:'delegated_swarm',itemId:'delegated_item',expectedRequirementRevision:now.projects[0].items[0].requirementRevision,
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
         // Real coordinator operation: propose unassigned work, then ask the real
     // existing subagent admission scheduler to bind and launch a selected child.
     await written(options,'propose_item',{id:'delegated_item',title:'Delegated item',
       scope:'Host-scoped child work',requirements:'Prepare and acknowledge one synthetic receipt',
       ownerId:null,dependsOn:[],verificationTarget:'unit'},
       {projectId:'delegated_swarm',expectedProjectRevision:f.board.snapshot('delegated_swarm').revision});
     assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_swarm_launch'));
     const result=await options.onToolCall({name:'relay_swarm_launch',arguments:{
       requestId:'swarm_launch_real_'+(++serial),projectId:'delegated_swarm',
       itemId:'delegated_item',expectedItemRevision:1,expectedRequirementRevision:1,
       assignedTaskId:'swarm_work',
       tasks:[{id:'swarm_work',prompt:'A real bound Swarm worker: read, receive and acknowledge the exact assigned item.'},
         {id:'independent_audit',prompt:'Independently inspect the absence of external side effects and report without Swarm writes.'}]}});
     assert.equal(result.success,true,JSON.stringify(result));
     const launched=body(result);
     assert.equal(launched.admitted,true);
     assert.equal(launched.launch.state,'settled');
     assert.equal(launched.launch.result.status,'completed');
    return {output:'Delegation observed.',threadId:'native-swarm-delegate'};
  });
  await f.run();
  assert.equal(workerRun,true);
  assert.notEqual(workerIdentity,null);
  const saved=f.board.snapshot('delegated_swarm');
     assert.equal(saved.items[0].nativeHandoff.id,workerDelivery);
   assert.equal(saved.nativeLaunches.length,1);
   assert.equal(saved.nativeLaunches[0].workerActorId,workerIdentity);
   assert.equal(saved.nativeLaunches[0].state,'settled');
   assert.equal(saved.nativeLaunches[0].result.status,'completed');
   assert.equal(saved.nativeLaunches[0].result.workOutcomeVerified,false);
  assert.equal(saved.items[0].nativeHandoff.state,'acknowledged');
  assert.equal(saved.items[0].phase,'delivered');
  assert.equal(saved.items[0].nativeHandoff.workExecuted,false);
  assert.equal(saved.items[0].completionCurrent,false);
  // A repeated launch request after a real engine worker completed must
  // return the durable receipt without calling the provider a second time.
  const prior=saved.nativeLaunches[0];
  let relaunchCalls=0;
  const adapter=await f.nativeSwarmTools({
    taskId:prior.taskId,runId:prior.runId,nodeId:prior.parentNodeId,isWorker:false,
    launchDelegates:async()=>{relaunchCalls++;throw Error('Forbidden replay');}
  });
  const originalTasks=[
    {id:'swarm_work',prompt:'A real bound Swarm worker: read, receive and acknowledge the exact assigned item.'},
    {id:'independent_audit',prompt:'Independently inspect the absence of external side effects and report without Swarm writes.'}
  ];
  const original={
    requestId:prior.requestId,projectId:'delegated_swarm',itemId:'delegated_item',
    expectedItemRevision:1,expectedRequirementRevision:1,assignedTaskId:'swarm_work',
    tasks:originalTasks
  };
  const retry=body(await adapter.handle({name:'relay_swarm_launch',arguments:original}));
  assert.equal(retry.duplicate,true);
  assert.equal(retry.noReplay,true);
  assert.equal(retry.modelStarted,false);
  assert.equal(relaunchCalls,0);
  await assert.rejects(adapter.handle({name:'relay_swarm_launch',
    arguments:{...original,tasks:[{...originalTasks[0],prompt:'Mutated request.'},originalTasks[1]]}}),
    error=>error.code==='SWARM_LAUNCH_CONFLICT');
  assert.equal(relaunchCalls,0);
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

test('real engine preserves the original single-worker admission gate and refuses stale binding before provider launch',async t=>{
  let f,actualChildren=0;
  f=await fixture(t,async options=>{
    if (options.prompt.startsWith('You are a short-lived BLACKICE subagent.')) {
      actualChildren++;
      return {output:'A child unexpectedly launched.'};
    }
    await written(options,'create_project',{id:'gate_swarm',name:'Admissible worker fixture',
      objective:'Rejected launch must have no worker registration or model launch.'});
    await written(options,'propose_item',{id:'gate_item',title:'Bounded work',
      scope:'Only this native fixture',requirements:'Exact revision, not a guessed assignment.',
      ownerId:null,dependsOn:[],verificationTarget:'unit'},{
      projectId:'gate_swarm',expectedProjectRevision:f.board.snapshot('gate_swarm').revision});
    const baseline=f.board.snapshot().eventCount;
    const single=await call(options,'relay_swarm_launch',{
      projectId:'gate_swarm',itemId:'gate_item',expectedItemRevision:1,
      expectedRequirementRevision:1,assignedTaskId:'single_worker',
      tasks:[{id:'single_worker',prompt:'Perform the one bounded work item.'}]
    });
    assert.equal(single.success,false,'existing DAG/speed gate must reject a single worker');
    const rejection=body(single);
    assert.equal(rejection.admitted,false);
    assert.equal(rejection.delegation.code,'SUBAGENT_SINGLE_WORK_ITEM');
    assert.equal(rejection.delegation.providerCalls,0);
    assert.equal(actualChildren,0);
    assert.equal(f.board.snapshot().eventCount,baseline);
    assert.equal(f.board.snapshot('gate_swarm').workers.length,0);
    assert.equal(f.board.snapshot('gate_swarm').items[0].ownerId,null);
    // The item changes while the coordinator has a stale launch revision.
    await written(options,'edit_item',{requirements:'New exact requirement r2.'},{
      projectId:'gate_swarm',itemId:'gate_item',expectedItemRevision:1});
    const afterEdit=f.board.snapshot().eventCount;
    const stale=await call(options,'relay_swarm_launch',{
      projectId:'gate_swarm',itemId:'gate_item',expectedItemRevision:1,
      expectedRequirementRevision:1,assignedTaskId:'wanted',
      tasks:[
        {id:'wanted',prompt:'Do only the revised work after admission.'},
        {id:'audit',prompt:'Independently examine the exact source revision before claims.'}
      ]
    });
    assert.equal(stale.success,false);
    const refused=body(stale);
    assert.equal(refused.admitted,false);
    assert.match(refused.delegation.error,/revision changed|refresh before editing/i);
    assert.equal(actualChildren,0,'two admitted tasks were not dispatched after stale binding failed');
    assert.equal(f.board.snapshot().eventCount,afterEdit);
    const state=f.board.snapshot('gate_swarm');
    assert.equal(state.nativeLaunches?.length||0,0);
    assert.equal(state.workers.length,0);
    assert.equal(state.items[0].phase,'proposed');
    assert.equal(state.items[0].ownerId,null);
    return {output:'Admission and source-CAS fences held.',threadId:'swarm-admission-fixture'};
  });
  await f.run();
  assert.equal(actualChildren,0);
});

test('a real admitted but failed native worker records failed runtime outcome without replay or invented acceptance',async t=>{
  let f,attempts=0;
  f=await fixture(t,async options=>{
    if (options.prompt.startsWith('You are a short-lived BLACKICE subagent.')) {
      if (options.prompt.includes('Independently inspect the failure receipt'))
        return {output:'Independent audit observed a worker failure.'};
      attempts++;
      throw Error('Synthetic provider failure after a real worker invocation.');
    }
    await written(options,'create_project',{id:'failed_launch_project',name:'Failed launch',
      objective:'Keep the actual launch result separate from acknowledged delivery or completion.'});
    await written(options,'propose_item',{id:'failed_launch_item',title:'Unfinished assigned work',
      scope:'Local synthetic failed worker only',requirements:'Do not claim completed without result.',
      ownerId:null,dependsOn:[],verificationTarget:'unit'},{
      projectId:'failed_launch_project',
      expectedProjectRevision:f.board.snapshot('failed_launch_project').revision});
    const payload={
      projectId:'failed_launch_project',itemId:'failed_launch_item',
      expectedItemRevision:1,expectedRequirementRevision:1,assignedTaskId:'failing_worker',
      tasks:[
        {id:'failing_worker',prompt:'Perform bounded local assigned work and report actual result.'},
        {id:'independent_failure_audit',prompt:'Independently inspect the failure receipt only.'}
      ]
    };
    const failed=await call(options,'relay_swarm_launch',payload);
    assert.equal(failed.success,false,'other successful jobs cannot conceal the assigned worker failure');
    const observed=body(failed);
    assert.equal(observed.admitted,true);
    assert.equal(observed.launch.state,'settled');
    assert.equal(observed.launch.result.status,'failed');
    assert.equal(observed.launch.result.workOutcomeVerified,false);
    assert.equal(attempts,1);
    const saved=f.board.snapshot('failed_launch_project');
    assert.equal(saved.items[0].phase,'queued');
    assert.equal(saved.nativeDeliveries.length,0,'failure alone cannot manufacture acknowledgment');
    assert.equal(saved.items[0].completionCurrent,false);
    const oldCount=f.board.snapshot().eventCount;
    const retry=await call(options,'relay_swarm_launch',{
      ...payload,
      expectedItemRevision:f.board.snapshot('failed_launch_project').items[0].revision,
      expectedRequirementRevision:f.board.snapshot('failed_launch_project').items[0].requirementRevision,
      tasks:[
        {id:'failing_retry',prompt:'A second attempt should be rejected before provider launch.'},
        {id:'audit_retry',prompt:'Independently inspect the failure receipt again.'}
      ],assignedTaskId:'failing_retry'
    });
    assert.equal(retry.success,false);
    assert.equal(body(retry).admitted,false);
    assert.match(body(retry).delegation.error,/earlier launch exists|reconcile/i);
    assert.equal(attempts,1,'new request IDs cannot silently relaunch a failed item');
    assert.equal(f.board.snapshot().eventCount,oldCount);
    return {output:'Failed provider attempt preserved without replay.',threadId:'swarm-failed-worker'};
  });
  await f.run();
  assert.equal(attempts,1);
});

test('an actual native provider launch with uncertain result persistence never auto-replays',async t=>{
  let f,workerInvocations=0,admittedArgs=null;
  f=await fixture(t,async options=>{
    if (options.prompt.startsWith('You are a short-lived BLACKICE subagent.')) {
      if (options.prompt.includes('Verify the independent assignment metadata'))
        return {output:'Independent assignment metadata checked.'};
      workerInvocations++;
      return {output:'Provider returned, but durable terminal-result persistence will fail.'};
    }
    await written(options,'create_project',{id:'uncertain_swarm',name:'Uncertain runtime',
      objective:'Do not replay a child launch when result persistence is unknown.'});
    await written(options,'propose_item',{id:'uncertain_item',title:'Uncertain assignment',
      scope:'Only bounded local fixture',requirements:'Preserve the uncertain provider effect.',
      ownerId:null,dependsOn:[],verificationTarget:'unit'},{
      projectId:'uncertain_swarm',expectedProjectRevision:f.board.snapshot('uncertain_swarm').revision});
    // Simulate a post-provider persistence fault; never fake runtime success.
    f.nativeSwarmTools.recordLaunchResult=async()=>{
      throw Error('Synthetic durable worker outcome write unavailable.');
    };
    admittedArgs={
      requestId:'uncertain_launch_same_request',projectId:'uncertain_swarm',
      itemId:'uncertain_item',expectedItemRevision:1,expectedRequirementRevision:1,
      assignedTaskId:'uncertain_worker',tasks:[
        {id:'uncertain_worker',prompt:'Fenced model launch: inspect exact assigned work.'},
        {id:'independent_check',prompt:'Verify the independent assignment metadata.'}
      ]
    };
    const result=await options.onToolCall({name:'relay_swarm_launch',arguments:admittedArgs});
    assert.equal(result.success,false,'no terminal persisted result means launch is uncertain');
    const observed=body(result);
    assert.equal(observed.admitted,true);
    assert.equal(observed.launch.state,'provider_attempted');
    assert.equal(observed.launch.result,null);
    assert.equal(observed.noReplay,true);
    assert.equal(workerInvocations,1);
    assert.equal(f.board.snapshot('uncertain_swarm').items[0].phase,'queued');
    return {output:'Uncertain worker outcome preserved.',threadId:'uncertain-swarm'};
  });
  await f.run();
  const before=f.board.snapshot('uncertain_swarm');
  const prior=before.nativeLaunches[0];
  assert.equal(prior.providerDispatchAttemptedAt!==null,true);
  assert.equal(prior.result,null);
  let replayed=0;
  const adapter=await f.nativeSwarmTools({
    taskId:prior.taskId,runId:prior.runId,nodeId:prior.parentNodeId,isWorker:false,
    launchDelegates:async()=>{replayed++;throw Error('Unexpected duplicate external effect');}
  });
  const retry=body(await adapter.handle({name:'relay_swarm_launch',arguments:admittedArgs}));
  assert.equal(retry.duplicate,true);
  assert.equal(retry.noReplay,true);
  assert.equal(retry.modelStarted,false);
  assert.equal(replayed,0);
  assert.equal(workerInvocations,1);
  assert.equal(f.board.snapshot('uncertain_swarm').nativeLaunches.length,1);
});
