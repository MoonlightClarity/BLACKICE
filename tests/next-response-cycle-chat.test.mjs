import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChatOptions, validateChatOptions } from '../public/next/chat/options-model.mjs';
import { submitChat } from '../public/next/chat/send.mjs';
import { projectFamily } from '../public/next/chat/reader-model.mjs';
import { createChatFrame } from '../public/next/chat/render.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';

test('old plan_only settings always become Automatic and never block Off', () => {
  assert.equal(normalizeChatOptions().planningExecutionMode,'automatic');
  const selected=normalizeChatOptions({planningMode:'off',planningExecutionMode:'plan_only'});
  assert.equal(selected.planningMode,'off');
  assert.equal(selected.planningExecutionMode,'automatic');
  assert.equal(validateChatOptions({},selected).planningExecutionMode,'automatic');
});
test('an explicit retired Plan-only request is rejected before any Chat API call, including continuations',async()=>{
  const calls=[],api=async(path,method,body)=>{calls.push({path,method,body});return{id:'should-not-be-admitted'};};
  await assert.rejects(submitChat({api,runs:[],task:'Do not execute yet',cwd:'C:/fixture',planningExecutionMode:'plan_only'}),{code:'PLANNING_EXECUTION_MODE_RETIRED'});
  assert.equal(calls.length,0);
  const prior={id:'prior',status:'completed',settled:true,workflow:{nodes:[{id:'agent',type:'agent'}]},nodes:{agent:{status:'completed',threadId:'saved'}}};
  await assert.rejects(submitChat({api,runs:[prior],task:'Continue only the plan',planningExecutionMode:'plan_only'}),{code:'PLANNING_EXECUTION_MODE_RETIRED'});
  assert.equal(calls.length,0);
  const result=await submitChat({api,runs:[],task:'Execute explicitly',cwd:'C:/fixture',planningExecutionMode:'automatic'});
  assert.equal(result.mode,'started');
  assert.equal(calls.length,2);
  assert.equal(calls.at(-1).body.input.planningExecutionMode,'automatic');
});
test('Chat projection retains exact paused plan navigation without transferring cycle histories or starting work', () => {
  const run = { id: 'run', input: 'Plan a report', status: 'completed', settled: true, workflow: { nodes: [] }, nodes: {}, events: [], planningExecutionMode: 'plan_only',
    responseCycle: { state: 'paused_after_plan', requestId: 'opaque-request', cycleId: 'opaque-cycle', title: 'Prepare the report', summary: 'Plan saved for inspection.',
      planRef: { requestId: 'opaque-request', nodeId: 'opaque-plan', nodeRevision: 4, responseId: 'opaque-response' }, privateTrace: 'PRIVATE'.repeat(10000) } };
  const shown = projectFamily({ runs: [run] }).runs[0];
  assert.equal(shown.responseCycle.state, 'paused_after_plan');
  assert.deepEqual(shown.responseCycle.planRef, run.responseCycle.planRef);
  assert.equal(shown.planningExecutionMode, 'plan_only');
  assert.doesNotMatch(JSON.stringify(shown), /PRIVATE/);
  assert.equal(run.responseCycle.privateTrace.length, 70000);
});

test('Chat offers explicit execution modes and keeps paused-plan navigation hidden until a saved pause is present', t => {
  const dom = planningDOM(t), view = createChatFrame(dom.mount);
  assert.equal(view.executionMode.value, 'automatic');
  assert.equal(view.executionMode.tagName,'INPUT');
  assert.equal(view.executionMode.getAttribute('type'),'hidden');
  assert.doesNotMatch(view.shell.innerHTML,/Plan only<\/option>/);
  assert.equal(view.cycleNotice.hidden, true);
  assert.equal(view.openPlan.textContent, 'Open plan in Planning');
});
