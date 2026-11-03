import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TaskStateStore, TASK_LIMITS, createTaskToolHandler } from '../lib/task-state.mjs';
import { TASK_PLAN_LIMITS } from '../lib/task-plan.mjs';
import { readArchivedTaskRevisions } from '../lib/task-state-history-archive.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const owner = revision => ({ expectedRevision: revision, runId: 'fixture-run', nodeId: 'agent' });
async function fixture(t, maxRevisions = 30) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-task-continuity-'));
  const cwd = path.join(dataDir, 'work'); await mkdir(cwd);
  const store = await new TaskStateStore({ dataDir, maxRevisions }).init();
  t.after(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const state = await store.ensure({ taskId: 'fixture', runId: 'fixture-run', nodeId: 'agent', cwd, goal: 'Preserve the job application status and plan history.' });
  return { store, dataDir, state };
}
const largePlan = (count, evidenceLength) => ({
  plan: { layout: 'parallel' },
  steps: Array.from({ length: count }, (_, i) => ({
    id: 'step_' + i,
    parentId: null,
    title: 'Preserved check ' + i,
    kind: 'action',
    status: 'done',
    dependsOn: [],
    doneWhen: 'Record the independent source result for ' + i + '.',
    note: 'This task step records earlier completed evidence without replaying browser effects. '.repeat(4),
    evidence: 'verified historical observation ' + i + ': ' + 'E'.repeat(evidenceLength),
    operation: { kind: 'reasoning', target: 'Compare original sources for already completed step ' + i + '.' },
  })),
});
test('a task with more than 224k characters of saved agent plan remains editable and reloadable', async t => {
  const { store, dataDir } = await fixture(t, 3);
  assert.ok(TASK_LIMITS.agentStateChars > 224000);
  assert.ok(TASK_PLAN_LIMITS.stateChars > 256000);
  const plan = largePlan(155, 1000);
  assert.ok(JSON.stringify(plan).length > 224000);
  let state = await store.setPlan('fixture', plan, owner(1));
  assert.equal(state.revision, 2);
  assert.equal(state.steps.length, 155);
  for (let i = 0; i < 4; i++)
    state = await store.checkpoint('fixture', { goal: 'Follow up without repeating completed submission.', decisions: ['Check status ' + i] }, owner(state.revision));
  const recent = await store.history('fixture');
  assert.equal(recent.length, 3);
  const full = await store.history('fixture', { includeArchived: true });
  assert.deepEqual(full.map(row => row.revision), [1, 2, 3, 4, 5, 6]);
  assert.equal(full[1].steps.length, 155);
  assert.equal(full[1].steps[42].evidence, plan.steps[42].evidence);
  const other = await new TaskStateStore({ dataDir }).init();
  t.after(() => other.close());
  assert.deepEqual(await other.get('fixture'), state);
  assert.deepEqual((await other.history('fixture', { includeArchived: true })).map(row => row.revision), [1, 2, 3, 4, 5, 6]);
  const archived = await readdir(path.join(dataDir, 'task-state-archives', 'fixture'));
  assert.equal(archived.filter(n => n.endsWith('.json.gz')).length, 3);
});

test('growing task revisions spill to verified immutable archives before hitting 10 MiB', async t => {
  const { store, dataDir } = await fixture(t);
  const plan = largePlan(185, 1250);
  let state = await store.setPlan('fixture', plan, owner(1));
  assert.ok(JSON.stringify(state).length > 320000);
  for (let i = 0; i < 34; i++)
    state = await store.checkpoint('fixture', { goal: 'Verified controls remain unchanged.', decisions: ['Follow-up ' + i] }, owner(state.revision));
  const raw = await readFile(store.file('fixture'));
  assert.ok(raw.length <= 10 * 1024 * 1024, 'primary remains bounded');
  const recent = await store.history('fixture');
  assert.ok(recent.length < 30, 'byte pressure prunes old revisions before size overflow');
  const all = await store.history('fixture', { includeArchived: true });
  assert.equal(all.length, 36, 'no revision is lost through retention trimming');
  assert.deepEqual(all.map(x => x.revision), Array.from({ length: 36 }, (_, i) => i + 1));
  assert.equal(all[1].steps[120].evidence, plan.steps[120].evidence);
  const archived = await readArchivedTaskRevisions(dataDir, 'fixture');
  assert.ok(archived.length > 0);
  const file = path.join(dataDir, 'task-state-archives', 'fixture', (await readdir(path.join(dataDir, 'task-state-archives', 'fixture')))[0]);
  const firstPacked = await readFile(file);
  const sameArchive = archived[0];
  assert.equal(hash(Buffer.from(JSON.stringify(sameArchive))), path.basename(file).match(/-([a-f0-9]{64})\.json\.gz$/)?.[1]);
  const stateAfter = await store.get('fixture');
  assert.equal(stateAfter.revision, 36);
  assert.equal(firstPacked.length, (await readFile(file)).length, 'archived content not rewritten');
});

test('repeated stale planning reads after invalid writes terminate instead of looping forever', async t => {
  const { store } = await fixture(t);
  const handler = createTaskToolHandler({ store, taskId: 'fixture', runId: 'fixture-run',
    nodeId: 'agent', task: 'Check the existing job application.', schemaVersion: 12,
    planningMode: 'on', executionGuardrails: true });
  const call = args => handler({ name: 'relay_task', arguments: args });
  for (let i = 0; i < 2; i++) {
    const rejected = await call({ action: 'edit', expectedRevision: 1,
      operations: [{ type: 'update', stepId: 'missing', reason: 'unsupported edit field' }] });
    assert.equal(rejected.success, false);
    assert.ok(['INVALID_PLAN_EDIT', 'INVALID_TASK_PLAN'].includes(rejected.code), rejected.code);
  }
  const latest = await store.get('fixture');
  let stopped = false;
  for (let i = 0; i < 20; i++) {
    try {
      const view = await call({ action: i % 5 === 0 ? 'describe' : 'read' });
      assert.equal(view.success, true);
    } catch (error) {
      assert.equal(error.code, 'TASK_PLAN_CALL_LOOP');
      stopped = true;
      break;
    }
  }
  assert.equal(stopped, true, 'the repeating agent is not allowed to keep consuming model tokens');
  assert.equal((await store.get('fixture')).revision, latest.revision);
});
