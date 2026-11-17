import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { HarnessEngine } from '../lib/engine.mjs';
import { SwarmBoardStore } from '../lib/swarm-board.mjs';
import { TaskStateStore } from '../lib/task-state.mjs';
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
    const selected=observed.delegation?.results?.find(row=>row.id==='uncertain_worker');
    assert.ok(selected,'the real scheduler retains the affected child runtime receipt');
    assert.match(selected.planningError||'',/Synthetic durable worker outcome write unavailable/,
      'the failed persistence is reported, not hidden as verified durable completion');
    assert.equal(workerInvocations,1);
    assert.equal(f.board.snapshot('uncertain_swarm').items[0].phase,'queued');
    return {output:'Uncertain worker outcome preserved.',threadId:'uncertain-swarm'};
  });
  // Test actual owned resource cleanup, not just the durable Swarm state.
  // Install the real TaskStateStore awareness and observe its finish entry
  // point; the contained-browser release handler is an isolated host fixture.
  const taskStore=await new TaskStateStore({dataDir:f.engine.dataDir}).init();
  f.engine.tasks=taskStore;
  t.after(()=>taskStore.close());
  const browserReleases=[], awarenessFinishes=[];
  f.engine.browser={
    status:()=>({contained:false,tabs:[]}),
    releaseOwner:async(owner,options)=>{
      browserReleases.push({owner,options});
      return {released:[owner.nodeId]};
    }
  };
  const originalFinish=taskStore.awareness.finish.bind(taskStore.awareness);
  taskStore.awareness.finish=(id,status)=>{
    awarenessFinishes.push({id,status});
    return originalFinish(id,status);
  };
  await f.run();
  const before=f.board.snapshot('uncertain_swarm');
  const prior=before.nativeLaunches[0];
  const ownedBrowserReleases=browserReleases.filter(row=>row.owner.nodeId===prior.workerNodeId);
  assert.equal(ownedBrowserReleases.length,1,
    'the actual child browser owner is released even when its Swarm result write fails');
  assert.equal(ownedBrowserReleases[0].options.status,'failed',
    'uncertain durability cannot be mislabeled as completed browser cleanup');
  assert.equal(ownedBrowserReleases[0].options.retainForContinuation,true,
    'uncertain worker resources remain recoverable rather than discarded as successful');
  const workerAwareness=awarenessFinishes.filter(row=>row.id===prior.runId+':'+prior.workerNodeId);
  assert.deepEqual(workerAwareness.map(row=>row.status),['failed'],
    'the real TaskStateStore worker-awareness lifecycle finishes despite persistence failure');
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

test('real Swarm launch records durable authorization but Goal cutoff after async dispatch prevents model call and cleans worker',async t=>{
  const cutoff=100, clock={now:99};
  let f, selectedCalls=0, audits=0, admissionChecks=0, fences=0, launchArgs;
  f=await fixture(t,async options=>{
    if (options.prompt.startsWith('You are a short-lived BLACKICE subagent.')) {
      if (options.prompt.includes('Independently inspect the admission receipt')) {
        audits++;return {output:'Independent synthetic audit.'};
      }
      selectedCalls++;
      return {output:'INVALID: this model must never run after the Goal cutoff.'};
    }
    await written(options,'create_project',{id:'deadline_swarm',name:'Deadline dispatch boundary',
      objective:'Durable provider authorization is not proof a provider was actually called.'});
    await written(options,'propose_item',{id:'deadline_item',title:'Exact bounded worker',
      scope:'No work after the absolute Goal deadline.',
      requirements:'Only execute while current source and Goal admission permit.',
      ownerId:null,dependsOn:[],verificationTarget:'unit'},{
      projectId:'deadline_swarm',expectedProjectRevision:f.board.snapshot('deadline_swarm').revision
    });
    const originalMark=f.nativeSwarmTools.markLaunchAttempt;
    f.nativeSwarmTools.markLaunchAttempt=async args=>{
      fences++;
      const durable=await originalMark(args);
      const snapshot=f.board.snapshot('deadline_swarm');
      assert.equal(snapshot.nativeLaunches.length,1);
      assert.equal(snapshot.nativeLaunches[0].state,'provider_attempted',
        'real Swarm board persisted the pre-model authorization fence');
      assert.equal(snapshot.nativeLaunches[0].result,null);
      // Cross the cutoff AFTER the real durable fence await has settled.
      // No deadline timer or explicit cancellation helper runs.
      await Promise.resolve();
      clock.now=cutoff;
      return durable;
    };
    launchArgs={
      requestId:'goal_boundary_after_durable_swarm_fence',projectId:'deadline_swarm',
      itemId:'deadline_item',expectedItemRevision:1,expectedRequirementRevision:1,
      assignedTaskId:'deadline_worker',tasks:[
        {id:'deadline_worker',prompt:'Only execute an exact admitted native assignment.'},
        {id:'independent_clock_audit',prompt:'Independently inspect the admission receipt; no external effects.'}
      ]
    };
    const response=await options.onToolCall({name:'relay_swarm_launch',arguments:launchArgs});
    assert.equal(response.success,false);
    const report=body(response);
    assert.equal(report.admitted,true);
    assert.equal(report.launch.state,'settled');
    assert.equal(report.launch.dispatchAdmission,'durable-authorized-only');
    assert.equal(report.launch.result.status,'failed');
    assert.equal(report.launch.result.hostRunAgentCallAttempted,false,
      'host refused runtime.runAgent even though a durable authorization was recorded');
    assert.equal(report.launch.result.externalProviderInvocationVerified,false);
    assert.match(report.launch.result.error,/absolute Goal deadline passed before provider admission/);
    assert.ok(report.launch.providerDispatchAttemptedAt);
    assert.equal(selectedCalls,0,'selected native model was never called');
    assert.equal(report.launch.result.workOutcomeVerified,false);
    return {output:'Goal deadline recheck prevented selected native provider work.',
      threadId:'deadline-authorization-only'};
  });
  // Exercise the engine's real beforeModel callback using a deterministic Goal
  // wall-clock admission stub. The separate goal-deadline-review2 regression
  // exercises ConversationGoals.assertProviderAdmission itself.
  f.engine.goals={
    prepareRun(){},async admitRun(){},
    assertProviderAdmission(_run,{signal}={}){
      admissionChecks++;
      if(signal?.aborted)throw Object.assign(Error('Parent cancelled.'),{name:'AbortError',code:'ABORT_ERR'});
      if(clock.now>=cutoff)throw Object.assign(
        Error('The absolute Goal deadline passed before provider admission.'),
        {code:'GOAL_DEADLINE_EXPIRED',actionDispatched:false});
    },
    forRun:()=>null,instructions:()=>'',wrapTools:(_run,_node,handler)=>handler,
    retainsResources:()=>false,async close(){}
  };
  const tasks=await new TaskStateStore({dataDir:f.engine.dataDir}).init();
  f.engine.tasks=tasks;
  t.after(()=>tasks.close());
  const releases=[],finishes=[];
  f.engine.browser={
    status:()=>({contained:false,tabs:[]}),
    releaseOwner:async(owner,options)=>{releases.push({owner,options});return {released:[owner.nodeId]};}
  };
  const originalFinish=tasks.awareness.finish.bind(tasks.awareness);
  tasks.awareness.finish=(id,status)=>{finishes.push({id,status});return originalFinish(id,status);};
  const started=f.engine.startRun({workflow:graph(),
    input:'Run only the isolated Goal cutoff Swarm provider fence fixture.',planningMode:'off'});
  await f.engine.executions.get(started.id);
  const state=f.board.snapshot('deadline_swarm');
  const launch=state.nativeLaunches[0];
  assert.ok(launch);
  assert.equal(state.items[0].phase,'queued');
  assert.equal(state.items[0].completionCurrent,false);
  assert.equal(launch.state,'settled');
  assert.equal(launch.result.status,'failed');
  assert.equal(launch.result.hostRunAgentCallAttempted,false);
  assert.equal(fences,1);
  assert.equal(selectedCalls,0);
  assert.ok(admissionChecks>=3,'Goal gate ran before the job and again after the awaited dispatch fence');
  assert.equal(releases.filter(row=>row.owner.nodeId===launch.workerNodeId).length,1,
    'browser lifecycle cleanup was performed despite post-fence Goal rejection');
  assert.equal(releases.find(row=>row.owner.nodeId===launch.workerNodeId).options.status,'failed');
  assert.deepEqual(finishes.filter(row=>row.id===launch.runId+':'+launch.workerNodeId)
    .map(row=>row.status),['failed'],'real awareness lifecycle ended with failed status');
  let replays=0;
  const reopened=await f.nativeSwarmTools({
    taskId:launch.taskId,runId:launch.runId,nodeId:launch.parentNodeId,isWorker:false,
    launchDelegates:async()=>{replays++;throw Error('Duplicate provider call forbidden');}
  });
  const deduped=body(await reopened.handle({name:'relay_swarm_launch',arguments:launchArgs}));
  assert.equal(deduped.duplicate,true);
  assert.equal(deduped.noReplay,true);
  assert.equal(deduped.modelStarted,false);
  assert.equal(replays,0);
  assert.equal(selectedCalls,0);
});

for (const mutation of ['requirements', 'reassign', 'phase']) {
  test('real engine refuses ' + mutation + ' after reservation while final provider dispatch is delayed', async t => {
    let f, selectedProviderCalls=0, markCalls=0, enterDispatch, releaseDispatch;
    const atDispatch=new Promise(resolve=>{enterDispatch=resolve;});
    const dispatchHold=new Promise(resolve=>{releaseDispatch=resolve;});
    t.after(()=>releaseDispatch());
    const human={kind:'human',id:'local-session',label:'Local user'};
    f=await fixture(t,async options=>{
      if (options.prompt.startsWith('You are a short-lived BLACKICE subagent.')) {
        if (options.prompt.includes('Independently inspect host admission receipts'))
          return {output:'Independent synthetic audit completed.'};
        selectedProviderCalls++;
        return {output:'This stale worker must never be invoked.'};
      }
      await written(options,'create_project',{id:'post_reserve_project',name:'Post-reservation mutation',
        objective:'A current source/owner/phase change must prevent the selected worker launch.'});
      await written(options,'propose_item',{id:'post_reserve_item',title:'Precise pending work',
        scope:'One bounded synthetic assignment',requirements:'Original requirement r1.',
        ownerId:null,dependsOn:[],verificationTarget:'unit'},{
        projectId:'post_reserve_project',
        expectedProjectRevision:f.board.snapshot('post_reserve_project').revision});
      const originalMark=f.nativeSwarmTools.markLaunchAttempt;
      f.nativeSwarmTools.markLaunchAttempt=async args=>{
        markCalls++;
        enterDispatch(args);
        await dispatchHold;
        return originalMark(args);
      };
      const launchArgs={
        requestId:'post_reserve_launch_'+mutation,projectId:'post_reserve_project',
        itemId:'post_reserve_item',expectedItemRevision:1,expectedRequirementRevision:1,
        assignedTaskId:'selected_worker',tasks:[
          {id:'selected_worker',prompt:'Execute only the exact currently assigned work.'},
          {id:'independent_audit',prompt:'Independently inspect host admission receipts without Swarm writes.'}
        ]
      };
      const pending=options.onToolCall({name:'relay_swarm_launch',arguments:launchArgs});
      let timer;
      try {
        await Promise.race([atDispatch,new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(Error('The real scheduler did not reach the final dispatch fence.')),5000);
        })]);
      } finally { clearTimeout(timer); }
      const reserved=f.board.snapshot('post_reserve_project');
      assert.equal(reserved.nativeLaunches.length,1,'binding occurred at admission before the held provider dispatch');
      const launch=reserved.nativeLaunches[0], item=reserved.items[0];
      assert.equal(launch.state,'reserved');
      assert.equal(launch.providerDispatchAttemptedAt,null);
      assert.equal(item.ownerId,launch.workerId);
      assert.equal(item.phase,'queued');
      assert.equal(markCalls,1);
      assert.equal(selectedProviderCalls,0,'the designated provider has not been called');
      const change=async (action,value,extra={})=>f.board.apply({
        mutationId:'post_reserve_human_'+mutation+'_'+(++serial),action,value,
        projectId:'post_reserve_project',...extra
      },human);
      if (mutation==='requirements') {
        await change('edit_item',{requirements:'Human revised the exact work obligations to r2.'},{
          itemId:'post_reserve_item',expectedItemRevision:item.revision});
      } else if (mutation==='reassign') {
        await change('register_worker',{id:'replacement_worker',label:'Different worker',
          scope:'Different role, cannot inherit prior native identity',kind:'agent',
          actorId:'native_replacement'},{
          expectedProjectRevision:f.board.snapshot('post_reserve_project').revision});
        await change('edit_item',{ownerId:'replacement_worker'},{
          itemId:'post_reserve_item',expectedItemRevision:item.revision});
      } else {
        await change('transition',{phase:'delivered',reference:'human-reported-phase-only'},{
          itemId:'post_reserve_item',expectedItemRevision:item.revision});
      }
      const changed=f.board.snapshot('post_reserve_project');
      assert.notEqual(changed.items[0].revision,item.revision);
      assert.equal(changed.nativeLaunches[0].state,'reserved');
      assert.equal(selectedProviderCalls,0);
      releaseDispatch();
      const reply=await pending;
      assert.equal(reply.success,false,'stale dispatch cannot report launch success');
      const observed=body(reply);
      assert.equal(observed.admitted,true,'original DAG admission was genuine');
      assert.equal(observed.launch.state,'settled');
      assert.equal(observed.launch.result.status,'failed');
      assert.match(observed.launch.result.error,/reserved native assignment changed/i);
      assert.equal(observed.launch.providerDispatchAttemptedAt,null,
        'the last dispatch fence rejected the stale assignment BEFORE provider invocation');
      assert.equal(observed.launch.result.workOutcomeVerified,false);
      assert.equal(selectedProviderCalls,0);
      assert.equal(f.board.snapshot('post_reserve_project').items[0].completionCurrent,false);
      return {output:'Post-reservation '+mutation+' stopped the selected provider.',threadId:'stale-boundary-'+mutation};
    });
    await f.run();
    assert.equal(markCalls,1);
    assert.equal(selectedProviderCalls,0);
  });
}
