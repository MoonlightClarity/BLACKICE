import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {WorkbenchConsoleControl} from '../lib/workbench-console-control.mjs';
import {WindowsWorkbench} from '../lib/windows-workbench.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve};};
const tick=()=>new Promise(done=>setImmediate(done));

test('Take/Cede receipts wait for native acknowledgement inside the guest-input fence',async()=>{
  const control=new WorkbenchConsoleControl(),takeGate=deferred(),cedeGate=deferred(),events=[];
  let native='agent';
  await control.setTransitionHook(async event=>{
    events.push(event.owner+':'+event.reason);
    if(event.reason==='transfer')await (event.owner==='user'?takeGate:cedeGate).promise;
    native=event.owner;
  });
  const take=control.take();await tick();
  assert.equal(control.status().owner,'agent','The next owner is not committed before native acknowledgement.');
  let agentRan=false;
  const queued=control.run(async()=>{agentRan=true;});
  takeGate.resolve();const receipt=await take;
  assert.equal(native,'user');assert.equal(receipt.owner,'user');
  await assert.rejects(queued,{code:'WORKBENCH_CONTROL_HELD_BY_USER'});assert.equal(agentRan,false);
  const cede=control.cede(receipt.controlToken);await tick();
  assert.equal(control.status().owner,'user');
  const agent=control.run(async()=>{assert.equal(native,'agent');return 'agent dispatch';});
  cedeGate.resolve();assert.equal((await cede).owner,'agent');assert.equal(await agent,'agent dispatch');
  assert.deepEqual(events,['agent:synchronize','user:transfer','agent:transfer']);
});

test('native transfer waits for an already-dispatched guest operation to finish',async()=>{
  const control=new WorkbenchConsoleControl(),gate=deferred(),events=[];
  await control.setTransitionHook(async event=>{events.push('native:'+event.owner);});
  const active=control.run(async()=>{events.push('guest:start');await gate.promise;events.push('guest:finished');});
  await tick();const take=control.take();await tick();
  assert.deepEqual(events,['native:agent','guest:start']);
  gate.resolve();await active;await take;
  assert.deepEqual(events,['native:agent','guest:start','guest:finished','native:user']);
});

test('a newer Take supersedes an acknowledged transfer without granting intervening stale input',async()=>{
  const control=new WorkbenchConsoleControl(),gate=deferred();let native='agent',transfers=0;
  await control.setTransitionHook(async event=>{
    if(event.reason==='transfer'&&++transfers===1)await gate.promise;
    native=event.owner;
  });
  const first=control.take();await tick();
  const stale=control.run(async()=>assert.fail('Stale agent input must not dispatch.'));
  const newer=control.take();gate.resolve();
  await assert.rejects(first,{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});
  await assert.rejects(stale,{code:'WORKBENCH_CONSOLE_CONTROL_CONFLICT'});
  const receipt=await newer;
  assert.equal(receipt.owner,'user');assert.equal(native,'user');assert.equal(control.status().owner,'user');
  assert.equal(await control.run(async()=> 'new user input',receipt.controlToken),'new user input');
});

test('uncertain native transfer disables both server input paths and awaits native disable before rejecting',async()=>{
  const control=new WorkbenchConsoleControl(),disabled=deferred();let native='agent',fail=true;
  await control.setTransitionHook(async event=>{
    if(event.owner==='user'){native='user';if(fail)throw Error('native receipt lost');}
    if(event.owner==='none'){await disabled.promise;native='none';}
  });
  let rejected=false;
  const take=control.take().catch(error=>{rejected=true;throw error;});
  await tick();assert.equal(control.status().owner,'none');assert.equal(rejected,false);
  const agent=control.run(async()=>assert.fail('Agent input must stay disabled.'));
  const user=control.run(async()=>assert.fail('User guest input must stay disabled.'),'old-token');
  disabled.resolve();await assert.rejects(take,{code:'WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE'});
  assert.equal(native,'none');assert.equal(control.status().blocked,true);
  await assert.rejects(agent,{code:'WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE'});
  await assert.rejects(user,{code:'WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE'});
  fail=false;const recovered=await control.take();assert.equal(recovered.owner,'user');assert.equal(native,'user');
  assert.equal(control.status().blocked,undefined);
});

test('a failed native disable remains explicit and never grants the agent or old user token',async()=>{
  const control=new WorkbenchConsoleControl();let fail=false;
  await control.setTransitionHook(async event=>{if(fail)throw Error('native channel unavailable');});
  const receipt=await control.take();fail=true;
  await assert.rejects(control.cede(receipt.controlToken),error=>error.code==='WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE'&&error.inputDisableUnconfirmed===true);
  assert.deepEqual(control.status(),{owner:'none',revision:3,blocked:true,inputDisableUnconfirmed:true});
  await assert.rejects(control.run(async()=>{},receipt.controlToken),{code:'WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE'});
  await assert.rejects(control.run(async()=>{}),{code:'WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE'});
});

test('hook replacement/detach disables the previous native path before synchronizing its replacement',async()=>{
  const control=new WorkbenchConsoleControl(),events=[];
  await control.setTransitionHook(async event=>events.push('first:'+event.owner+':'+event.reason));
  const receipt=await control.take();
  await control.setTransitionHook(async event=>events.push('second:'+event.owner+':'+event.reason));
  assert.deepEqual(events,['first:agent:synchronize','first:user:transfer','first:none:detach','second:user:synchronize']);
  await control.setTransitionHook(null);
  assert.equal(events.at(-1),'second:none:detach');
  assert.equal(await control.run(async()=> 'user still owns other guest input',receipt.controlToken),'user still owns other guest input');
});

test('WindowsWorkbench exposes the same serialized ownership hook without launching a helper',async()=>{
  const workbench=new WindowsWorkbench({dataDir:path.resolve('fixture-workbench-owner'),consoleController:{}}),events=[];
  await workbench.setGuestConsoleOwnershipHook(async event=>events.push({owner:event.owner,before:workbench.consoleControl.status().owner}));
  const receipt=await workbench.takeGuestConsoleControl();await workbench.cedeGuestConsoleControl(receipt.controlToken);
  assert.deepEqual(events,[{owner:'agent',before:'agent'},{owner:'user',before:'agent'},{owner:'agent',before:'user'}]);
});
