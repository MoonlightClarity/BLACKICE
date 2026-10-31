import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChatOptions, validateChatOptions } from '../public/next/chat/options-model.mjs';
import { submitChat } from '../public/next/chat/send.mjs';
import { projectFamily } from '../public/next/chat/reader-model.mjs';
import { createChatFrame } from '../public/next/chat/render.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';

test('Plan only is explicit, defaults remain automatic, and an Off combination is not silently changed', () => {
  assert.equal(normalizeChatOptions().planningExecutionMode, 'automatic');
  assert.deepEqual(normalizeChatOptions({ planningMode: 'off', planningExecutionMode: 'plan_only' }), { model: 'default', effort: 'default', serviceTier: 'default', planningMode: 'off', planningExecutionMode: 'plan_only' });
  assert.throws(() => validateChatOptions({}, { planningMode: 'off', planningExecutionMode: 'plan_only' }), /Planning On/);
});

test('Plan only reaches a new run, its persisted workflow, and an ordinary continuation without resuming a plan', async () => {
  const calls = [], api = async (path, method, body) => { calls.push({ path, method, body }); return path === '/api/workflows' ? body : { id: 'recorded-run', status: 'running' }; };
  await submitChat({ api, runs: [], task: 'Plan the report', cwd: 'C:\\fixture', planningExecutionMode: 'plan_only' });
  assert.equal(calls[0].body.settings.planningExecutionMode, 'plan_only');
  assert.equal(calls[1].body.input.planningExecutionMode, 'plan_only');
  const prior = { id: 'previous', status: 'completed', settled: true, workflow: { nodes: [{ id: 'agent', type: 'agent' }] }, nodes: { agent: { status: 'completed', threadId: 'saved-thread' } } };
  await submitChat({ api, runs: [prior], task: 'Revise the report plan', planningExecutionMode: 'plan_only' });
  assert.equal(calls.at(-1).body.planningExecutionMode, 'plan_only');
  assert.equal(calls.some(call => call.path.includes('/cycles/')), false);
  const count = calls.length;
  await assert.rejects(submitChat({ api, runs: [], task: 'Invalid mode', cwd: 'C:\\fixture', planningMode: 'off', planningExecutionMode: 'plan_only' }), /Planning On/);
  assert.equal(calls.length, count);
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
  assert.deepEqual(view.executionMode.children.map(option => [option.value, option.textContent]), [['automatic', 'Automatic'], ['plan_only', 'Plan only']]);
  assert.equal(view.cycleNotice.hidden, true);
  assert.equal(view.openPlan.textContent, 'Open plan in Planning');
});
