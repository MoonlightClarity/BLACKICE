import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStateStore, createTaskToolHandler, TASK_SCHEMA_VERSION, TASK_TOOL_V5, taskToolForVersion } from '../lib/task-state.mjs';
import { executionReadiness } from '../lib/planning-runtime.mjs';
import { createSwarmWorkflow } from '../public/swarm-model.mjs';

const action = (id, extra = {}) => ({ id, title: `Produce ${id}`, kind: 'action', parentId: null, status: 'pending', doneWhen: `The ${id} result is checked against the request.`, ...extra });
const agent = revision => ({ expectedRevision: revision, runId: 'run-a', nodeId: 'coordinator', schemaVersion: TASK_SCHEMA_VERSION, executionGuardrails: true });
const human = revision => ({ expectedRevision: revision, source: 'human', executionGuardrails: true });
const edit = (store, state, operations, options = human(state.revision)) => store.editPlan(state.taskId, { operations }, options);
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-planning-edit-')), cwd = path.join(directory, 'work'); await mkdir(cwd);
  const store = await new TaskStateStore({ dataDir: directory }).init(), stores = [store];
  const state = await store.ensure({ taskId: 'saved-task', runId: 'run-a', cwd, goal: 'Finish the actual requested work.', defaultPlan: true });
  t.after(async () => { await Promise.all(stores.map(store => store.close())); await rm(directory, { recursive: true, force: true }); });
  return { directory, cwd, store, stores, state };
}
const sharedWorkflow = () => ({ planning: { shared: true, coordinatorNodeId: 'coordinator' }, nodes: [
  { id: 'input', type: 'input' }, { id: 'left', type: 'agent', name: 'Left owner', prompt: 'Inspect the first input.' }, { id: 'right', type: 'agent', name: 'Right owner', prompt: 'Check the left result.' }, { id: 'coordinator', type: 'agent', name: 'Coordinator', prompt: 'Integrate the checked output.' }, { id: 'output', type: 'output' }
], edges: [{ source: 'input', target: 'left' }, { source: 'left', target: 'right' }, { source: 'right', target: 'coordinator' }, { source: 'coordinator', target: 'output' }] });

test('human edits turn an existing empty scaffold into the same atomic actionable plan and preserve history', async t => {
  const { store, state } = await fixture(t);
  const saved = await edit(store, state, [
    { type: 'metadata', patch: { goal: 'Repair the current result and check it.', layout: 'parallel' } },
    { type: 'add', step: { id: 'route', title: 'Choose the repair', kind: 'choice', parentId: null } },
    { type: 'add', step: action('repair', { parentId: 'route', condition: 'The original implementation can be repaired.' }) },
    { type: 'add', step: action('replace', { parentId: 'route', condition: 'The existing implementation cannot meet the request.' }) },
    { type: 'add', step: action('check', { dependsOn: ['route'] }) },
    { type: 'choose', stepId: 'route', selectedChildId: 'repair' }
  ]);
  assert.equal(saved.revision, state.revision + 1); assert.equal(saved.provenance.source, 'human'); assert.equal(saved.plan.origin, 'human');
  assert.equal(saved.goal, 'Repair the current result and check it.'); assert.deepEqual(saved.availableWork.ready, ['repair']);
  assert.equal(saved.availableWork.byId.replace.state, 'unselected'); assert.equal(saved.steps.find(step => step.id === 'replace').status, 'pending');
  assert.equal(saved.availableWork.byId.check.state, 'waiting'); assert.equal(saved.execution, undefined);
  const original = (await store.history(state.taskId))[0]; assert.deepEqual(original.steps, []); assert.equal(original.goal, state.goal);
  const before = await readFile(store.file(state.taskId));
  await assert.rejects(edit(store, saved, [{ type: 'update', stepId: 'repair', patch: { title: 'Changed' } }, { type: 'add', step: { id: 'invalid', title: 'No observable criterion' } }]), /doneWhen/);
  assert.deepEqual(await readFile(store.file(state.taskId)), before, 'a rejected later operation publishes none of the earlier edits');
});

test('reordering and dependency edits recompute readiness and reject cycles or dangling prerequisites atomically', async t => {
  const { store, state } = await fixture(t);
  let saved = await store.setPlan(state.taskId, { steps: [action('a'), action('b'), action('c')] }, agent(state.revision));
  saved = await edit(store, saved, [{ type: 'move', stepId: 'c', parentId: null, beforeId: 'a' }]);
  assert.deepEqual(saved.steps.map(step => step.id), ['c', 'a', 'b']); assert.deepEqual(saved.availableWork.ready, ['c']);
  await assert.rejects(edit(store, saved, [{ type: 'dependencies', stepId: 'c', dependsOn: ['b'] }]), /cycle/);
  saved = await edit(store, saved, [{ type: 'metadata', patch: { layout: 'parallel' } }, { type: 'dependencies', stepId: 'c', dependsOn: ['a'] }]);
  assert.deepEqual(saved.availableWork.ready, ['a', 'b']); assert.equal(saved.availableWork.byId.c.prerequisites[0].id, 'a');
  await assert.rejects(edit(store, saved, [{ type: 'remove', stepId: 'a' }]), /dependency/);
  saved = await edit(store, saved, [{ type: 'dependencies', stepId: 'c', dependsOn: [] }, { type: 'remove', stepId: 'a' }]);
  assert.deepEqual(saved.steps.map(step => step.id), ['c', 'b']); assert.deepEqual(saved.availableWork.ready, ['c', 'b']);
});

test('two actual stores enforce CAS between a human draft and concurrent worker progress', async t => {
  const { store, stores, state, directory } = await fixture(t), other = await new TaskStateStore({ dataDir: directory }).init(); stores.push(other);
  const initial = await store.setPlan(state.taskId, { plan: { layout: 'parallel' }, steps: [action('a'), action('b')] }, agent(state.revision));
  const attempts = await Promise.allSettled([
    edit(store, initial, [{ type: 'update', stepId: 'b', patch: { title: 'Human wording retained' } }]),
    other.setStep(state.taskId, 'a', { status: 'done', evidence: 'The actual fixture result was checked.' }, agent(initial.revision))
  ]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  const rejected = attempts.find(item => item.status === 'rejected').reason; assert.equal(rejected.code, 'TASK_STATE_CONFLICT'); assert.equal(rejected.currentRevision, initial.revision + 1);
  let latest = await other.get(state.taskId);
  latest = attempts[0].status === 'rejected' ? await edit(store, latest, [{ type: 'update', stepId: 'b', patch: { title: 'Human wording retained' } }]) : await other.setStep(state.taskId, 'a', { status: 'done', evidence: 'The actual fixture result was checked.' }, agent(latest.revision));
  assert.equal(latest.steps.find(step => step.id === 'b').title, 'Human wording retained'); assert.equal(latest.steps.find(step => step.id === 'a').evidence, 'The actual fixture result was checked.');
});

test('changed criteria cannot reuse stale completion evidence, and plan edits retain uncertain external receipts', async t => {
  const { store, state } = await fixture(t);
  let saved = await store.setPlan(state.taskId, { steps: [action('a', { status: 'done', evidence: 'The original actual criterion passed.' })] }, agent(state.revision));
  await assert.rejects(edit(store, saved, [{ type: 'update', stepId: 'a', patch: { doneWhen: 'The expanded requirement passes.' } }]), /actual evidence/);
  saved = await edit(store, saved, [{ type: 'update', stepId: 'a', patch: { status: 'pending', doneWhen: 'The expanded requirement passes.', note: null } }]);
  assert.equal(saved.steps[0].evidence, undefined);
  saved = await store.externalAction(state.taskId, { receiptId: 'one-send', operation: 'prepare', destination: 'https://example.test/account', content: 'Previously authorized exact content.' }, agent(saved.revision));
  saved = await store.externalAction(state.taskId, { receiptId: 'one-send', operation: 'attempt' }, agent(saved.revision));
  const receipts = structuredClone(saved.externalActions);
  saved = await edit(store, saved, [{ type: 'metadata', patch: { goal: 'Continue while preserving the uncertain send.' } }]);
  assert.deepEqual(saved.externalActions, receipts); assert.equal(saved.externalActions[0].status, 'uncertain');
  await assert.rejects(edit(store, saved, [{ type: 'metadata', patch: { execution: { status: 'completed' } } }]), /metadata/);
});

test('a worker edits only its saved assignment; human reports cannot complete its runtime or unlock real dependencies', async t => {
  const { store, state } = await fixture(t);
  let saved = await store.bindWorkflow(state.taskId, sharedWorkflow(), { runId: 'run-a' });
  saved = await store.recordExecution(state.taskId, 'left', { status: 'running' }, { runId: 'run-a' });
  const handler = createTaskToolHandler({ store, taskId: state.taskId, runId: 'run-a', nodeId: 'left', scopeStepId: 'agent-left', worker: true });
  const call = args => handler({ name: 'relay_task', arguments: args });
  for (const args of [
    { action: 'edit', expectedRevision: saved.revision, operations: [{ type: 'update', stepId: 'agent-right-work', patch: { title: 'Stolen work' } }] },
    { action: 'edit', expectedRevision: saved.revision, operations: [{ type: 'metadata', patch: { goal: 'Stolen goal' } }] },
    { action: 'external', expectedRevision: saved.revision, external: { operation: 'attempt', receiptId: 'send' } },
    { action: 'checkpoint', expectedRevision: saved.revision, goal: 'Stolen checkpoint' }
  ]) { const result = await call(args); assert.equal(result.success, false); assert.equal(result.code, 'TASK_PLAN_OWNERSHIP'); }
  const updated = await call({ action: 'edit', expectedRevision: saved.revision, operations: [{ type: 'update', stepId: 'agent-left-work', patch: { note: 'Checked my own input.' } }] });
  assert.equal(updated.success, true, updated.contentItems[0].text); saved = await store.get(state.taskId);
  assert.equal(saved.steps.find(step => step.id === 'agent-left-work').note, 'Checked my own input.');
  saved = await edit(store, saved, [{ type: 'update', stepId: 'agent-left-work', patch: { status: 'done', evidence: 'A human recorded a result; the worker is still running.' } }]);
  assert.equal(saved.execution.nodes.left.status, 'running'); assert.equal(executionReadiness(saved, 'right').ready, false);
  assert.equal(saved.availableWork.byId['agent-right-work'].prerequisites[0].executionStatus, 'running');
  await assert.rejects(store.recordExecution(state.taskId, 'right', { status: 'running' }, { runId: 'run-a' }), { code: 'TASK_PLAN_NOT_READY' });
  await assert.rejects(edit(store, saved, [{ type: 'update', stepId: 'agent-right-work', patch: { status: 'active' } }]), { code: 'TASK_PLAN_PREREQUISITE' });
  saved = await store.recordExecution(state.taskId, 'left', { status: 'completed' }, { runId: 'run-a' });
  assert.equal(executionReadiness(saved, 'right').ready, true); assert.equal(saved.availableWork.byId['agent-right-work'].owner.nodeId, 'right');
  await assert.rejects(edit(store, saved, [{ type: 'remove', stepId: 'agent-left' }]), { code: 'TASK_PLAN_EXECUTION_BOUND' });
});

test('runtime completion is a separate receipt and does not mark unreported actions done', async t => {
  const { store, state } = await fixture(t);
  await store.bindWorkflow(state.taskId, sharedWorkflow(), { runId: 'run-a' });
  const saved = await store.recordExecution(state.taskId, 'left', { status: 'completed' }, { runId: 'run-a' });
  assert.equal(saved.steps.find(step => step.id === 'agent-left-work').status, 'pending'); assert.equal(saved.progress.done, 0);
  assert.equal(saved.execution.nodes.left.status, 'completed'); assert.equal(executionReadiness(saved, 'right').ready, true);
});

test('plan catalog filters before pagination, refreshes edited entries and reports damaged plans without hiding usable ones', async t => {
  const { store, state, cwd } = await fixture(t);
  await store.ensure({ taskId: 'archived-task', cwd, goal: 'An archived planning document', defaultPlan: true });
  await store.ensure({ taskId: 'another-task', cwd, goal: 'Another document', defaultPlan: true });
  await writeFile(store.file('damaged-task'), '{broken');
  let catalog = await store.listPlans({ taskIds: [state.taskId, 'archived-task'], limit: 1 });
  assert.equal(catalog.total, 2); assert.equal(catalog.plans.length, 1); assert.equal(catalog.nextOffset, 1); assert.equal(catalog.healthy, true);
  const next = await store.listPlans({ taskIds: [state.taskId, 'archived-task'], limit: 1, offset: 1 }); assert.notEqual(catalog.plans[0].taskId, next.plans[0].taskId);
  const changed = await edit(store, state, [{ type: 'metadata', patch: { goal: 'Find the edited objective.' } }]);
  catalog = await store.listPlans({ query: 'edited objective' }); assert.equal(catalog.total, 1); assert.equal(catalog.plans[0].revision, changed.revision); assert.equal(catalog.plans[0].goal, changed.goal);
  assert.equal(catalog.healthy, false); assert.equal(catalog.errors[0].taskId, 'damaged-task');
  catalog = await store.listPlans({ query: 'edited objective', taskIds: [state.taskId, 'archived-task'], queryTaskIds: ['archived-task', 'another-task'], limit: 1 });
  assert.equal(catalog.total, 2, 'renamed-title matches are unioned with objective matches before pagination');
  assert.equal(catalog.hasMore, true); assert.ok(!catalog.plans.some(plan => plan.taskId === 'another-task'), 'a title match cannot bypass visibility');
  const distant = await store.listPlans({ taskIds: [state.taskId], offset: 1000000 });
  assert.equal(distant.total, 1); assert.deepEqual(distant.plans, []); assert.equal(distant.hasMore, false);
  await assert.rejects(store.listPlans({ queryTaskIds: ['../outside'] }), /identifier/);
});

test('verified outside-agent provenance stays distinct from engine actors and edits require the current revision', async t => {
  const { store, state } = await fixture(t), actor = { type: 'external-agent', id: 'client-7', name: 'Outside reviewer' };
  const saved = await edit(store, state, [{ type: 'add', step: action('external-work') }], { expectedRevision: state.revision, source: 'agent', actor });
  assert.deepEqual(saved.provenance.actor, actor); assert.equal(saved.provenance.source, 'agent'); assert.equal(saved.provenance.runId, undefined); assert.equal(saved.plan.authoredBy, undefined);
  await assert.rejects(edit(store, saved, [{ type: 'update', stepId: 'external-work', patch: { title: 'Missing revision' } }], { source: 'agent', actor }), { code: 'TASK_STATE_CONFLICT', currentRevision: saved.revision });
  assert.equal(taskToolForVersion(5, { executionGuardrails: true }), TASK_TOOL_V5); assert.equal(taskToolForVersion(5).inputSchema.properties.action.enum.includes('edit'), false); assert.equal(taskToolForVersion(6).inputSchema.properties.action.enum.includes('edit'), true);
});

test('a 48-worker shared swarm persists every real prerequisite without a dependency clamp or oversized initial state', async t => {
  const { store, state } = await fixture(t), workflow = createSwarmWorkflow({ members: 48 });
  let saved = await store.bindWorkflow(state.taskId, workflow, { runId: 'run-a' });
  assert.equal(saved.steps.length, 98); assert.equal(saved.steps.find(step => step.id === 'agent-coordinator').dependsOn.length, 48);
  assert.equal(saved.availableWork.ready.length, 48); assert.equal(executionReadiness(saved, 'coordinator').ready, false);
  assert.equal(taskToolForVersion(5).inputSchema.properties.steps.items.properties.dependsOn.maxItems, 40);
  assert.equal(taskToolForVersion(6).inputSchema.properties.steps.items.properties.dependsOn.maxItems, 199);
  for (let index = 1; index <= 47; index++) await store.recordExecution(state.taskId, `specialist-${index}`, { status: 'completed' }, { runId: 'run-a' });
  saved = await store.get(state.taskId); assert.equal(executionReadiness(saved, 'coordinator').ready, false, 'every actual prerequisite matters');
  saved = await store.recordExecution(state.taskId, 'specialist-48', { status: 'completed' }, { runId: 'run-a' });
  assert.equal(executionReadiness(saved, 'coordinator').ready, true); assert.equal(saved.progress.done, 0, 'runtime receipts invent no reported evidence');
  saved = await edit(store, saved, [{ type: 'update', stepId: 'agent-specialist-1-work', patch: { note: 'A concise human clarification within the existing saved plan.' } }]);
  assert.equal(saved.steps.find(step => step.id === 'agent-specialist-1-work').note, 'A concise human clarification within the existing saved plan.');
  const stored = JSON.parse(await readFile(store.file(state.taskId), 'utf8')).history.at(-1);
  assert.ok(JSON.stringify(stored).length < 56000); assert.equal(stored.availableWork, undefined);
});
