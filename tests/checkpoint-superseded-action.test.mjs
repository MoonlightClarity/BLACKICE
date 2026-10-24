import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStateStore, createTaskToolHandler } from '../lib/task-state.mjs';

const savedAction = 'Repair the tracking record from the existing send receipt, then recheck Sent by exact Message-ID. Do not send another copy.';
const actor = state => ({ expectedRevision: state.revision, runId: 'first-run', nodeId: 'agent' });
async function fixture(t, branching = true) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-superseded-action-')), cwd = path.join(directory, 'workspace'); await mkdir(cwd);
  const stores = [], open = async () => { const store = await new TaskStateStore({ dataDir: directory }).init(); stores.push(store); return store; }, store = await open();
  let state = await store.ensure({ taskId: 'continuity-task', runId: 'first-run', nodeId: 'agent', cwd, goal: 'Finish and reconcile the one actual application.' });
  state = await store.setPlan(state.taskId, { ...(branching ? { plan: { layout: 'sequence', detail: 'balanced' } } : {}), steps: [{ id: 'finish', title: 'Finish and report', status: 'active', doneWhen: 'Actual result and remaining repair are recorded.' }] }, actor(state));
  t.after(async () => { for (const item of stores) await item.close(); assert.match(path.basename(directory), /^blackice-superseded-action-/); await rm(directory, { recursive: true, force: true }); });
  return { store, state, open };
}

test('finishing the plan preserves detailed recovery action as superseded context across reload and cancellation', async t => {
  const f = await fixture(t); let state = await f.store.checkpoint(f.state.taskId, { nextSteps: [], nextAction: savedAction, decisions: ['Preserve the existing external result.'] }, actor(f.state));
  const previous = structuredClone(state.checkpoint), checkpointRevision = state.revision;
  state = await f.store.editPlan(state.taskId, { operations: [{ type: 'update', stepId: 'finish', patch: { status: 'done', evidence: 'The report was written; the checkpoint names the remaining repair.' } }] }, actor(state));
  assert.equal(state.checkpoint.nextAction, undefined);
  assert.deepEqual(state.checkpoint.supersededNextAction, { text: savedAction, reason: 'plan-focus-changed', previousStepId: 'finish', currentStepId: null });
  assert.deepEqual((await f.store.history(state.taskId)).find(item => item.revision === checkpointRevision).checkpoint, previous, 'The original checkpoint revision is immutable.');
  await f.store.close(); const restored = await f.open(); state = await restored.get(state.taskId); assert.equal(state.checkpoint.supersededNextAction.text, savedAction);
  state = await restored.interrupt(state.taskId, { runId: 'first-run', nodeId: 'runtime', status: 'cancelled', reason: 'Stopped after evidence.' }); assert.equal(state.checkpoint.nextAction, undefined); assert.equal(state.checkpoint.supersededNextAction.text, savedAction);
  const context = await restored.getContext(state.taskId); assert.ok(context.includes(savedAction)); assert.match(context, /superseded.*re-evaluate/i); assert.ok(!context.includes('Next action: ' + savedAction));
  const handler = createTaskToolHandler({ store: restored, taskId: state.taskId, runId: 'later-turn', nodeId: 'agent' }), result = await handler({ name: 'relay_task', arguments: { action: 'read' } });
  assert.equal(result.success, true); const read = JSON.parse(result.contentItems[0].text); assert.equal(read.checkpoint.supersededNextAction.text, savedAction); assert.equal(read.checkpoint.nextAction, undefined);
  for (const maxChars of [512, 1500, 12000]) assert.ok((await restored.getContext(state.taskId, { maxChars })).length <= maxChars);
});

test('legacy focus changes preserve one historical action and explicit human checkpoint replacement clears it', async t => {
  const f = await fixture(t, false); let state = await f.store.checkpoint(f.state.taskId, { nextAction: savedAction }, actor(f.state));
  state = await f.store.setStep(state.taskId, 'finish', { status: 'done', evidence: 'Finished the synthetic result.' }, actor(state)); assert.equal(state.checkpoint.nextAction, undefined); assert.equal(state.checkpoint.supersededNextAction.text, savedAction);
  state = await f.store.checkpoint(state.taskId, { nextAction: 'Read the revised human instruction before deciding what remains.' }, { ...actor(state), source: 'human', actor: { type: 'human-client', id: 'checkpoint-human', name: 'Fixture human' } });
  assert.equal(state.checkpoint.supersededNextAction, undefined); assert.equal(state.checkpoint.nextAction, 'Read the revised human instruction before deciding what remains.');
  state = await f.store.setStep(state.taskId, 'finish', { status: 'active' }, actor(state)); assert.equal(state.checkpoint.nextAction, undefined); assert.equal(state.checkpoint.supersededNextAction.text, 'Read the revised human instruction before deciding what remains.');
  assert.ok(!JSON.stringify(state.checkpoint).includes(savedAction), 'Only the newly superseded action is retained.');
  state = await f.store.checkpoint(state.taskId, { decisions: ['The human replaced the checkpoint and chose no next action.'] }, { ...actor(state), source: 'human' }); assert.equal(state.checkpoint.nextAction, undefined); assert.equal(state.checkpoint.supersededNextAction, undefined);
});

test('uncertain external effects remain the current reconciliation priority over historical send text', async t => {
  const f = await fixture(t); let state = await f.store.externalAction(f.state.taskId, { operation: 'prepare', receiptId: 'send-once', destination: 'mailto:fixture@example.invalid', content: 'One synthetic application.' }, actor(f.state));
  state = await f.store.externalAction(state.taskId, { operation: 'attempt', receiptId: 'send-once' }, actor(state));
  state = await f.store.checkpoint(state.taskId, { nextAction: 'Send the prepared application.', nextSteps: [] }, actor(state));
  state = await f.store.setStep(state.taskId, 'finish', { status: 'done', evidence: 'The final reporting action is complete.' }, actor(state));
  const context = await f.store.getContext(state.taskId); assert.match(context, /Next action: Reconcile external receipts send-once/); assert.match(context, /Do not replay external effects solely from this superseded action/); assert.ok(!context.includes('Next action: Send the prepared application.'));
  assert.equal(state.externalActions[0].attempts, 1); assert.equal(state.externalActions[0].status, 'uncertain');
  const restored = await f.open(); assert.equal((await restored.get(state.taskId)).externalActions[0].status, 'uncertain'); assert.ok((await restored.getContext(state.taskId)).includes('Send the prepared application.'));
});

test('the previous action stays bounded to one accepted action rather than accumulating focus history', async t => {
  const f = await fixture(t); let state = await f.store.checkpoint(f.state.taskId, { nextAction: 'x'.repeat(1000) }, actor(f.state));
  state = await f.store.setStep(state.taskId, 'finish', { status: 'done', evidence: 'The synthetic finish is checked.' }, actor(state));
  assert.equal(state.checkpoint.supersededNextAction.text.length, 1000);
  state = await f.store.setStep(state.taskId, 'finish', { status: 'active' }, actor(state));
  state = await f.store.setStep(state.taskId, 'finish', { status: 'done', evidence: 'The revised finish is checked.' }, actor(state));
  assert.equal(state.checkpoint.supersededNextAction.text.length, 1000); assert.equal(Array.isArray(state.checkpoint.supersededNextAction), false);
  const restored = await f.open(); assert.deepEqual((await restored.get(state.taskId)).checkpoint.supersededNextAction, state.checkpoint.supersededNextAction);
});
