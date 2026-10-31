import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PlanningAwareness, planningRelevance, createPlanningWorkerGuard, wrapPlanningToolHandler } from '../lib/planning-awareness.mjs';
import { TaskStateStore, createTaskToolHandler } from '../lib/task-state.mjs';
import { readPlanningAwareness, updatePlanningPresence } from '../lib/planning-workspace.mjs';

const action = (id, parentId = null) => ({ id, title: id, parentId, kind: 'action', status: 'pending', dependsOn: [], doneWhen: `${id} has an observed result.` });
const group = (id, parentId = null, kind = 'parallel') => ({ id, title: id, parentId, kind, status: 'pending', dependsOn: [] });
const human = { type: 'human-client', id: 'paired-human', name: 'Paired browser' };
const tool = (name, args) => ({ name, arguments: args });
const decoded = receipt => JSON.parse(receipt.contentItems.find(item => item.type === 'inputText').text);
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-planning-awareness-')), cwd = path.join(directory, 'work'); await mkdir(cwd);
  const store = await new TaskStateStore({ dataDir: directory }).init();
  const initial = await store.ensure({ taskId: 'task-one', runId: 'run-one', cwd, goal: 'Implement separate results.', defaultPlan: true });
  await store.setPlan(initial.taskId, { plan: { layout: 'parallel' }, steps: [group('left'), action('left-work', 'left'), group('right'), action('right-work', 'right')] }, { expectedRevision: initial.revision, runId: 'run-one', nodeId: 'coordinator', schemaVersion: 6 });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, cwd, directory, taskId: initial.taskId, get: () => store.get(initial.taskId),
    async edit(operations) { const state = await store.get(initial.taskId); return store.editPlan(initial.taskId, { operations }, { expectedRevision: state.revision, source: 'human', actor: human }); },
    async guard(nodeId = 'left-worker', scopeStepId = 'left') {
      // This suite explicitly tests guarded correction delivery, not advisory defaults.
      const guard = await createPlanningWorkerGuard({ store, taskId: initial.taskId, runId: 'run-one', nodeId, label: nodeId, scopeStepId, executionGuardrails: true });
      const handler = createTaskToolHandler({ store, taskId: initial.taskId, runId: 'run-one', nodeId, scopeStepId, worker: Boolean(scopeStepId), executionGuardrails: true });
      return { guard, async task(args) { const call = tool('relay_task', args), denied = await guard.before(call); return denied || guard.after(call, await handler(call)); } };
    }
  };
}

test('presence stores only verified identity and a bounded advisory lease without changing plan bytes', async t => {
  const f = await fixture(t), state = await f.get(), before = await readFile(f.store.file(f.taskId)); let clock = Date.now();
  f.store.awareness = new PlanningAwareness({ clock: () => clock });
  const first = f.store.awareness.setPresence(state, { editorId: 'editing-one', stepId: 'left-work' }, human);
  assert.equal(first.revision, state.revision); assert.equal(first.presence[0].label, 'Paired browser');
  assert.equal(Date.parse(first.presence[0].expiresAt), clock + 20000);
  assert.deepEqual(await readFile(f.store.file(f.taskId)), before);
  assert.throws(() => f.store.awareness.setPresence(state, { editorId: 'editing-one', stepId: 'left-work', text: 'unsaved secret' }, human), /drafts and identity/);
  assert.throws(() => f.store.awareness.setPresence(state, { editorId: 'editing-one', stepId: 'missing' }, human), /unavailable/);
  assert.throws(() => f.store.awareness.setPresence(state, { editorId: 'editing-one', stepId: 'left-work' }, { type: 'external-agent', id: 'machine' }), /verified human/);
  clock += 20001; assert.deepEqual(f.store.awareness.snapshot(state).presence, []);
});

test('one authenticated editor cannot release another identity or a newer editor lease', async t => {
  const f = await fixture(t), state = await f.get(), registry = f.store.awareness;
  registry.setPresence(state, { editorId: 'old-selection', stepId: 'left-work' }, human);
  registry.setPresence(state, { editorId: 'new-selection', stepId: 'right-work' }, human);
  registry.clearPresence(state, { editorId: 'old-selection' }, { type: 'human-client', id: 'other-person' });
  assert.equal(registry.snapshot(state).presence.length, 2);
  registry.clearPresence(state, { editorId: 'old-selection' }, human);
  assert.deepEqual(registry.snapshot(state).presence.map(item => item.editorId), ['new-selection']);
});

test('read receipts begin unread; presence alone does not suspend a worker', async t => {
  const f = await fixture(t), worker = await f.guard(), state = await f.get();
  assert.equal(f.store.awareness.snapshot(state).workers[0].state, 'unread');
  f.store.awareness.setPresence(state, { editorId: 'editor', stepId: 'left-work' }, human);
  assert.equal(await worker.guard.before(tool('relay_workspace', { action: 'write' })), null);
  const read = await worker.task({ action: 'read' }); assert.equal(read.success, true);
  const contents = decoded(read), receipt = contents.planningAwareness.worker;
  assert.equal(receipt.lastReadRevision, state.revision); assert.equal(receipt.state, 'current');
  assert.equal(contents.planningAwareness.presence[0].stepId, 'left-work');
  assert.equal(contents.planningAwareness.totalRelevantEditors, 1);
});

test('a saved human correction blocks the affected attached action until its real task read', async t => {
  const f = await fixture(t), worker = await f.guard(); await worker.task({ action: 'read' });
  const saved = await f.edit([{ type: 'update', stepId: 'left-work', patch: { note: 'Use the corrected input and verify its checksum.' } }]);
  let actualWrites = 0;
  const dispatch = async () => { const denied = await worker.guard.before(tool('relay_workspace', { action: 'write' })); if (!denied) actualWrites++; return denied; };
  const denied = await dispatch(); assert.equal(denied.code, 'TASK_PLAN_REVIEW_REQUIRED'); assert.equal(actualWrites, 0);
  assert.equal(decoded(denied).revision, saved.revision);
  assert.equal((await worker.task({ action: 'step', expectedRevision: saved.revision, stepId: 'left-work', status: 'active' })).code, 'TASK_PLAN_REVIEW_REQUIRED');
  assert.equal(f.store.awareness.snapshot(saved).workers[0].state, 'needs-review');
  const read = await worker.task({ action: 'read' }); assert.equal(read.success, true); assert.match(decoded(read).steps.find(step => step.id === 'left-work').note, /corrected input/);
  assert.equal(await dispatch(), null); assert.equal(actualWrites, 1);
  assert.equal(f.store.awareness.snapshot(saved).workers[0].lastReadRevision, saved.revision);
});

test('unrelated parallel edits do not require another worker to reread or wait', async t => {
  const f = await fixture(t), left = await f.guard(), right = await f.guard('right-worker', 'right');
  await left.task({ action: 'read' }); await right.task({ action: 'read' });
  const saved = await f.edit([{ type: 'update', stepId: 'right-work', patch: { doneWhen: 'The corrected right-side acceptance check succeeds.' } }]);
  assert.equal(await left.guard.before(tool('relay_browser', { action: 'navigate' })), null);
  assert.equal((await right.guard.before(tool('relay_browser', { action: 'navigate' }))).code, 'TASK_PLAN_REVIEW_REQUIRED');
  const leftReceipt = f.store.awareness.snapshot(saved).workers.find(worker => worker.nodeId === 'left-worker');
  assert.equal(leftReceipt.state, 'current'); assert.ok(leftReceipt.lastReadRevision < saved.revision); assert.equal(leftReceipt.pendingRevision, null);
});

test('a newly saved prerequisite remains a runtime barrier after the worker reads it', async t => {
  const f = await fixture(t), worker = await f.guard(); await worker.task({ action: 'read' });
  await f.edit([{ type: 'dependencies', stepId: 'left', dependsOn: ['right'] }]);
  assert.equal((await worker.guard.before(tool('relay_workspace', { action: 'write' }))).code, 'TASK_PLAN_REVIEW_REQUIRED');
  await worker.task({ action: 'read' });
  const waiting = await worker.guard.before(tool('relay_workspace', { action: 'write' }));
  assert.equal(waiting.code, 'TASK_PLAN_NOT_READY'); assert.ok(decoded(waiting).dependencies.some(item => item.id === 'right'));
  await f.edit([{ type: 'update', stepId: 'right-work', patch: { status: 'done', evidence: 'The independent prerequisite result was checked in this unbound fixture.' } }]);
  await worker.task({ action: 'read' });
  assert.equal(await worker.guard.before(tool('relay_workspace', { action: 'write' })), null);
});

test('an in-flight tool keeps its actual receipt when a human saves, with a notice before the next action', async t => {
  const f = await fixture(t), worker = await f.guard(); await worker.task({ action: 'read' });
  let started, settle; const entered = new Promise(resolve => { started = resolve; }), held = new Promise(resolve => { settle = resolve; });
  const dispatch = wrapPlanningToolHandler(worker.guard, async call => {
    const denied = await worker.guard.before(call); if (denied) return denied;
    started(); await held; return { success: true, contentItems: [{ type: 'inputText', text: 'Actual completed operation receipt.' }] };
  });
  const inFlight = dispatch(tool('relay_workspace', { action: 'run' })); await entered;
  const saved = await f.edit([{ type: 'update', stepId: 'left-work', patch: { note: 'A saved correction while the previous action was already underway.' } }]);
  settle(); const completed = await inFlight;
  assert.equal(completed.success, true); assert.equal(completed.contentItems[0].text, 'Actual completed operation receipt.');
  assert.equal(JSON.parse(completed.contentItems[1].text).pendingRevision, saved.revision);
  assert.equal((await worker.guard.before(tool('relay_workspace', { action: 'write' }))).code, 'TASK_PLAN_REVIEW_REQUIRED');
});

test('saving while a read is in transit keeps the newer correction pending', async t => {
  const f = await fixture(t), worker = await f.guard(), stale = await f.get();
  const newer = await f.edit([{ type: 'update', stepId: 'left-work', patch: { note: 'A correction saved after the read began.' } }]);
  worker.guard.after(tool('relay_task', { action: 'read' }), { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(stale) }] });
  assert.equal(f.store.awareness.snapshot(newer).workers[0].lastReadRevision, stale.revision);
  assert.equal((await worker.guard.before(tool('relay_files', { action: 'write' }))).code, 'TASK_PLAN_REVIEW_REQUIRED');
});

test('own successful narrow plan writes retain their returned context without fabricating a read', async t => {
  const f = await fixture(t), worker = await f.guard(), first = decoded(await worker.task({ action: 'read' }));
  const written = await worker.task({ action: 'step', expectedRevision: first.revision, stepId: 'left-work', status: 'active', note: 'I am now implementing the assigned result.' });
  assert.equal(written.success, true, written.contentItems[0].text);
  assert.equal(await worker.guard.before(tool('relay_workspace', { action: 'write' })), null);
  const current = f.store.awareness.snapshot(await f.get()).workers[0]; assert.equal(current.lastReadRevision, first.revision); assert.equal(current.state, 'current');
});

test('readiness context includes transitive prerequisites and enclosing branch conditions', () => {
  const state = { taskId: 'task', goal: 'Work', revision: 3, planVersion: 1, plan: { layout: 'parallel', detail: 'balanced' }, artifacts: [], steps: [group('a'), action('a-work', 'a'), { ...group('b'), dependsOn: ['a'] }, action('b-work', 'b'), { ...group('c'), dependsOn: ['b'] }, action('c-work', 'c'), group('unrelated'), action('other', 'unrelated')] };
  const original = planningRelevance(state, 'c');
  assert.ok(original.stepIds.includes('a-work')); assert.ok(original.stepIds.includes('b-work')); assert.ok(!original.stepIds.includes('other'));
  const relevant = structuredClone(state); relevant.steps.find(step => step.id === 'a-work').note = 'Corrected prerequisite';
  assert.notEqual(planningRelevance(relevant, 'c').signature, original.signature);
  const unrelated = structuredClone(state); unrelated.steps.find(step => step.id === 'other').note = 'Independent correction';
  assert.equal(planningRelevance(unrelated, 'c').signature, original.signature);
});

test('completion and restart never invent a worker read receipt or runtime completion', async t => {
  const f = await fixture(t), worker = await f.guard(); await worker.task({ action: 'read' });
  const before = await f.get(); worker.guard.finish('cancelled');
  const finished = f.store.awareness.snapshot(before).workers[0]; assert.equal(finished.state, 'finished'); assert.equal(finished.status, 'cancelled');
  assert.equal((await worker.guard.before(tool('relay_workspace', { action: 'read' }))).code, 'TASK_PLAN_WORKER_FINISHED');
  assert.deepEqual(await f.get(), before);
  const reopened = await new TaskStateStore({ dataDir: f.directory }).init(); t.after(() => reopened.close());
  assert.deepEqual(reopened.awareness.snapshot(await reopened.get(f.taskId)).workers, []);
});

test('workspace awareness routes share chat visibility and use authenticated actor values', async t => {
  const f = await fixture(t); let bucket = 'active';
  const context = { tasks: f.store, conversations: { list: () => [{ id: 'run-one', taskId: f.taskId, title: 'Example', state: bucket }] }, engine: { listRuns: () => [] } };
  const first = await updatePlanningPresence(context, f.taskId, { editorId: 'editor', stepId: 'left-work' }, { actor: human });
  assert.equal(first.presence[0].actor.id, human.id);
  assert.equal((await readPlanningAwareness(context, f.taskId)).presence.length, 1);
  bucket = 'deleted';
  await assert.rejects(updatePlanningPresence(context, f.taskId, { editorId: 'second', stepId: 'left-work' }, { actor: human }), /Restore/);
  const released = await updatePlanningPresence(context, f.taskId, { editorId: 'editor' }, { actor: human, release: true }); assert.equal(released.presence.length, 0);
  await assert.rejects(readPlanningAwareness(context, 'unrelated-task'), /not attached/);
});
