import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkbenchConsoleControl} from '../lib/workbench-console-control.mjs';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('internal authorized handoff returns no token and ordinary USER input fencing stays unchanged',async()=>{
  const control=new WorkbenchConsoleControl(),user=await control.take();
  await assert.rejects(control.run(async()=>assert.fail('Ordinary agent input cannot take USER control.')),{code:'WORKBENCH_CONTROL_HELD_BY_USER'});
  const receipt=await control.handoffToAgent(user.revision);
  assert.deepEqual(receipt,{owner:'agent',revision:user.revision+1});assert.equal(Object.hasOwn(receipt,'controlToken'),false);
  assert.equal(Object.hasOwn(control.status(),'controlToken'),false);
  await assert.rejects(control.run(async()=>{},user.controlToken),{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});
  assert.equal(await control.run(async()=> 'authorized agent input'),'authorized agent input');
  const restored=await control.take();assert.equal(restored.owner,'user');assert.notEqual(restored.controlToken,user.controlToken);
  await assert.rejects(control.run(async()=>{}),{code:'WORKBENCH_CONTROL_HELD_BY_USER'});
});

test('missing/stale handoff revisions and AGENT/NONE owners cannot be bypassed or mutate ownership',async()=>{
  const control=new WorkbenchConsoleControl();
  assert.throws(()=>control.handoffToAgent(0),{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});assert.deepEqual(control.status(),{owner:'agent',revision:0});
  const user=await control.take(),before=control.status();
  for(const revision of [undefined,null,'1',-1,1.5,user.revision-1,user.revision+1]){
    assert.throws(()=>control.handoffToAgent(revision),{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});assert.deepEqual(control.status(),before);
  }
  await assert.rejects(control.setTransitionHook(async()=>{throw Error('Native synchronization unavailable');}),{code:'WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE'});
  const failed=control.status();assert.equal(failed.owner,'none');
  assert.throws(()=>control.handoffToAgent(failed.revision),{code:'WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE'});assert.deepEqual(control.status(),failed);
  await assert.rejects(control.run(async()=>{}),{code:'WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE'});
});

test('handoff queues behind dispatched USER work and grants AGENT only after native release acknowledgement',async()=>{
  const control=new WorkbenchConsoleControl(),active=deferred(),native=deferred(),events=[];let nativeOwner='agent';
  await control.setTransitionHook(async event=>{events.push('native:'+event.owner);if(event.owner==='agent'&&event.reason==='transfer')await native.promise;nativeOwner=event.owner;});
  const user=await control.take();
  const inFlight=control.run(async()=>{events.push('user:start');await active.promise;events.push('user:done');},user.controlToken);await tick();
  const staleUser=control.run(async()=>assert.fail('Queued old USER input must not dispatch.'),user.controlToken);
  const staleRejected=assert.rejects(staleUser,{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});
  let granted=false;const handoff=control.handoffToAgent(user.revision).then(receipt=>{granted=true;return receipt;});
  let agentRan=false;const agent=control.run(async()=>{agentRan=true;assert.equal(nativeOwner,'agent');return 'agent';});
  await tick();assert.equal(events.at(-1),'user:start');assert.equal(granted,false);assert.equal(agentRan,false);
  active.resolve();await inFlight;await staleRejected;await tick();
  assert.equal(events.at(-1),'native:agent');assert.equal(control.status().owner,'user');assert.equal(granted,false);assert.equal(agentRan,false);
  native.resolve();assert.equal((await handoff).owner,'agent');assert.equal(await agent,'agent');
});

test('a newer USER takeover supersedes a pending handoff and rejects intervening stale agent input',async()=>{
  const control=new WorkbenchConsoleControl(),gate=deferred();let nativeOwner='agent';
  await control.setTransitionHook(async event=>{if(event.owner==='agent'&&event.reason==='transfer')await gate.promise;nativeOwner=event.owner;});
  const user=await control.take(),handoff=control.handoffToAgent(user.revision);await tick();
  const handoffRejected=assert.rejects(handoff,{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});
  const queued=control.run(async()=>assert.fail('Superseded run input must not dispatch.'));
  const queuedRejected=assert.rejects(queued,{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});
  const newer=control.take();gate.resolve();await handoffRejected;await queuedRejected;
  const restored=await newer;assert.equal(restored.owner,'user');assert.equal(nativeOwner,'user');
  assert.equal(await control.run(async()=> 'new USER',restored.controlToken),'new USER');
});

test('uncertain native handoff fails closed and waits for disable before allowing either input path',async()=>{
  const control=new WorkbenchConsoleControl(),disable=deferred();let fail=false,nativeOwner='agent';
  await control.setTransitionHook(async event=>{if(event.owner==='agent'&&event.reason==='transfer'&&fail){nativeOwner='agent';throw Error('Native release receipt lost');}
    if(event.owner==='none')await disable.promise;nativeOwner=event.owner;});
  const user=await control.take();fail=true;let rejected=false;
  const handoff=control.handoffToAgent(user.revision).catch(error=>{rejected=true;throw error;});
  const handoffRejected=assert.rejects(handoff,{code:'WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE'});await tick();
  assert.equal(control.status().owner,'none');assert.equal(rejected,false);
  const agent=assert.rejects(control.run(async()=>assert.fail('Agent must stay blocked.')),{code:'WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE'});
  const oldUser=assert.rejects(control.run(async()=>assert.fail('Old user must stay blocked.'),user.controlToken),{code:'WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE'});
  disable.resolve();await handoffRejected;await agent;await oldUser;assert.equal(nativeOwner,'none');assert.equal(control.status().blocked,true);
});
