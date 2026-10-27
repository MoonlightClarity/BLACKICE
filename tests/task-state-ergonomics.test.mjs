import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskStateStore, TASK_TOOL, createTaskToolHandler } from '../lib/task-state.mjs';

const payload = result => JSON.parse(result.contentItems.find(item => item.type === 'inputText').text);
const action = () => ({ id: 'inspect', title: 'Inspect the requested result', kind: 'action', status: 'pending', doneWhen: 'The requested result has been inspected.' });
const plan = expectedRevision => ({ action: 'plan', expectedRevision, plan: { layout: 'sequence' }, steps: [action()] });

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-task-ergonomics-')), cwd = path.join(directory, 'workspace');
  await mkdir(cwd);
  const store = await new TaskStateStore({ dataDir: directory }).init(), events = [];
  t.after(async () => {
    await store.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.match(path.basename(directory), /^blackice-task-ergonomics-/);
    await rm(directory, { recursive: true, force: true });
  });
  const state = await store.ensure({ taskId: 'task-one', runId: 'run-one', nodeId: 'agent', cwd, goal: 'Inspect the requested result.', defaultPlan: true });
  const handler = createTaskToolHandler({ store, taskId: state.taskId, runId: 'run-one', nodeId: 'agent', onEvent: event => events.push(event), ...options });
  return { store, state, events, call: args => handler({ name: 'relay_task', arguments: args }) };
}

test('current task writes distinguish omitted and malformed revisions from stale revisions without publishing changes', async t => {
  const f = await fixture(t), before = await readFile(f.store.file(f.state.taskId), 'utf8');
  const missing = plan(); delete missing.expectedRevision;
  const omitted = await f.call(missing);
  assert.equal(omitted.success, false); assert.equal(omitted.code, 'TASK_STATE_REVISION_REQUIRED'); assert.equal(omitted.status, 400);
  assert.equal(payload(omitted).code, omitted.code); assert.equal(payload(omitted).status, 400);
  assert.match(payload(omitted).error, /top-level expectedRevision/); assert.match(payload(omitted).error, /read/);
  assert.doesNotMatch(payload(omitted).error, /revision changed/i);
  for (const revision of [null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = await f.call(plan(revision));
    assert.equal(invalid.success, false); assert.equal(invalid.code, 'TASK_STATE_REVISION_INVALID'); assert.equal(invalid.status, 400);
    assert.match(payload(invalid).error, /positive integer/);
  }
  const missingEdit = await f.call({ action: 'edit', operations: [{ type: 'add', step: action() }] });
  assert.equal(missingEdit.code, 'TASK_STATE_REVISION_REQUIRED');
  assert.equal(await readFile(f.store.file(f.state.taskId), 'utf8'), before);
  assert.equal(f.events.length, 0); assert.equal((await f.store.history(f.state.taskId)).length, 1);

  const saved = await f.call(plan(f.state.revision)); assert.equal(saved.success, true);
  const committed = await readFile(f.store.file(f.state.taskId), 'utf8');
  const stale = await f.call({ ...plan(f.state.revision), steps: [{ ...action(), title: 'Must not overwrite newer work' }] });
  assert.equal(stale.success, false); assert.equal(stale.code, 'TASK_STATE_CONFLICT'); assert.equal(stale.status, 409);
  assert.equal(stale.currentRevision, payload(saved).revision);
  assert.deepEqual(payload(stale), { error: `Task revision changed. Read the latest state (revision ${payload(saved).revision}) before updating it.`, code: 'TASK_STATE_CONFLICT', status: 409, currentRevision: payload(saved).revision });
  assert.equal(await readFile(f.store.file(f.state.taskId), 'utf8'), committed);
  assert.equal(f.events.length, 1);
});

test('misplaced plan.steps is rejected with the correct field location and never adopted', async t => {
  const f = await fixture(t), before = await readFile(f.store.file(f.state.taskId), 'utf8');
  for (const topLevel of [undefined, [action()]]) {
    const result = await f.call({ action: 'plan', expectedRevision: f.state.revision, plan: { layout: 'sequence', steps: [action()] }, ...(topLevel ? { steps: topLevel } : {}) });
    assert.equal(result.success, false); assert.equal(result.code, 'TASK_PLAN_SHAPE_INVALID'); assert.equal(result.status, 400);
    assert.match(payload(result).error, /top level alongside action, expectedRevision and plan/);
    assert.match(payload(result).error, /move plan.steps to steps/);
    assert.equal(await readFile(f.store.file(f.state.taskId), 'utf8'), before);
  }
  assert.equal((await f.store.get(f.state.taskId)).plan.origin, 'runtime');
  assert.deepEqual((await f.store.get(f.state.taskId)).steps, []); assert.equal(f.events.length, 0);
  const corrected = await f.call(plan(f.state.revision)); assert.equal(corrected.success, true);
  assert.equal(payload(corrected).revision, f.state.revision + 1);
});

test('the live describe read and plan examples execute against the actual current handler', async t => {
  const f = await fixture(t, { planningMode: 'maximal' });
  const described = await f.call({ action: 'describe' }); assert.equal(described.success, true);
  const description = payload(described);
  assert.deepEqual(description.read.example, { action: 'read' });
  assert.deepEqual(description.plan.inputSchema.required, ['action', 'expectedRevision', 'steps']);
  assert.equal(description.plan.inputSchema.properties.plan.properties.steps, undefined);
  assert.equal(description.plan.example.plan.steps, undefined);
  assert.ok(Array.isArray(description.plan.example.steps)); assert.equal(description.plan.example.plan.detail, 'balanced');
  assert.match(description.plan.note, /latest read/); assert.match(description.plan.note, /Every action needs doneWhen/);
  assert.match(TASK_TOOL.inputSchema.properties.expectedRevision.description, /Required on every write/);
  assert.match(TASK_TOOL.inputSchema.properties.plan.description, /never plan.steps/);
  assert.match(TASK_TOOL.inputSchema.properties.steps.description, /top-level/);
  assert.equal(f.events.length, 0); assert.equal((await f.store.get(f.state.taskId)).revision, f.state.revision);
  const read = await f.call(description.read.example); assert.equal(read.success, true);
  const example = structuredClone(description.plan.example); example.expectedRevision = payload(read).revision;
  const planned = await f.call(example); assert.equal(planned.success, true, planned.contentItems[0].text);
  const saved = payload(planned);
  assert.deepEqual(saved.plan.authoredBy, { runId: 'run-one', nodeId: 'agent' });
  assert.equal(saved.steps[0].status, 'pending'); assert.equal(saved.progress.done, 0); assert.equal(saved.progress.complete, false);
  const prematureDone = await f.call({ action: 'step', expectedRevision: saved.revision, stepId: saved.steps[0].id, status: 'done' });
  assert.equal(prematureDone.success, false); assert.match(payload(prematureDone).error, /evidence/);
  assert.equal((await f.store.get(f.state.taskId)).revision, saved.revision);
});

test('the described scoped plan remains executable with a maximum-length assignment ID', async t => {
  const scopeStepId = 'scope-' + 'x'.repeat(114), f = await fixture(t, { scopeStepId, worker: true });
  await f.store.setPlan(f.state.taskId, { steps: [{ id: scopeStepId, title: 'Assigned work', kind: 'sequence' }, { ...action(), parentId: scopeStepId }] }, { expectedRevision: f.state.revision, schemaVersion: 6, runId: 'run-one', nodeId: 'coordinator' });
  const description = payload(await f.call({ action: 'describe' })), example = description.plan.example;
  assert.equal(description.scopeStepId, scopeStepId); assert.ok(example.steps[0].id.length <= 120);
  example.expectedRevision = payload(await f.call(description.read.example)).revision;
  const result = await f.call(example); assert.equal(result.success, true, result.contentItems[0].text);
  const state = payload(result);
  assert.ok(state.steps.some(step => step.id === scopeStepId));
  assert.equal(state.steps.find(step => step.id === example.steps[0].id).parentId, scopeStepId);
  assert.equal(state.progress.done, 0);
});
