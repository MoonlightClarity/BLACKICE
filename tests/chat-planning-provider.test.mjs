import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatPlanningProviderInvoker } from '../lib/chat-planning-provider.mjs';
import { CHAT_PLANNING_MODULES, createChatPlanningPass } from '../lib/chat-planning-pass.mjs';

const scope={taskId:'t1',runId:'r1',nodeId:'n1'};
const [module]=CHAT_PLANNING_MODULES;
const snapshot={taskId:'t1',revision:3,actions:[],receipts:[]};
const output={status:'proposed',focus:'scan',reason:'Inspect the first failing route',sourceRefs:[],actions:[{id:'scan',objective:'Inspect a route',dependsOn:[]}]};
const make=(runAgent,assertAdmission=()=>{})=>createChatPlanningProviderInvoker({ runtime:{runAgent},...scope,cwd:'test-workspace',model:'api1::model1',effort:'low',assertAdmission });
test('selected model gets one bounded isolated response-only phase with no tools',async()=>{
  let options;
  const invoke=make(value=>{options=value;return {output:JSON.stringify(output)};});
  assert.deepEqual(await invoke({module,...scope,snapshot}),{transport:'completed',output});
  assert.equal(options.model,'api1::model1');
  assert.equal(options.effort,'low');
  assert.equal(options.hostOnlyTools,true);
  assert.equal(options.responseOnly,true);
  assert.equal(options.codexHistory,'relay');
  assert.equal(options.sandbox,'read-only');
  assert.deepEqual(options.dynamicTools,[]);
  assert.ok(!('threadId' in options) && !('onEvent' in options) && !('continuity' in options));
  await assert.rejects(invoke({module,...scope,snapshot}),{code:'PLANNING_PROVIDER_LIMIT'});
});
test('wrong scope and expired admission never call the provider',async()=>{
  let calls=0;
  const invoke=make(()=>{calls++;},()=>{throw Object.assign(Error('expired'),{code:'GOAL_DEADLINE_REACHED'});});
  await assert.rejects(invoke({module,...scope,runId:'old',snapshot}),{code:'PLANNING_SCOPE_CHANGED'});
  await assert.rejects(invoke({module,...scope,snapshot}),{code:'GOAL_DEADLINE_REACHED'});
  assert.equal(calls,0);
});
test('a tool attempt aborts even if transport catches its error and returns valid JSON',async()=>{
  const invoke=make(options=>{
    assert.throws(()=>options.onToolCall({name:'relay_browser'}),{code:'PLANNING_PROVIDER_TOOL_DENIED'});
    assert.equal(options.signal.aborted,true);
    return {output:JSON.stringify(output)};
  });
  await assert.rejects(invoke({module,...scope,snapshot}),{code:'PLANNING_PROVIDER_TOOL_DENIED'});
});
test('a successful plain-text final records a failed phase, never CAS or execution',async()=>{
  const events=[];
  const invoke=make(()=>({output:'I finished planning.'}));
  const pass=createChatPlanningPass({mode:'on',...scope,read:()=>snapshot,invoke,
    commit:()=>assert.fail('no validated artifact'),assertAdmission:()=>{},emit:event=>events.push(event)});
  assert.equal((await pass.run(module.id)).status,'failed');
  assert.deepEqual(events.map(row=>row.phase),['started','failed']);
});
