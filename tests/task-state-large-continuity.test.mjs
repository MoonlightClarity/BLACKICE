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

test('current invalid edits preserve state and explicit call budgets stop repeated reads', async t => {
  const { store } = await fixture(t);
  const handler = createTaskToolHandler({ store, taskId: 'fixture', runId: 'fixture-run', nodeId: 'agent', schemaVersion: 14, maxCalls: 4 });
  const call = args => handler({ name: 'relay_task', arguments: args });
  const before = await store.get('fixture');
  for(let i=0;i<2;i++) {
    const rejected = await call({action:'edit', expectedRevision:before.revision, operations:[{type:'update',stepId:'missing'}]});
    assert.equal(rejected.success,false);
    assert.equal(rejected.code,'TASK_CONTRACT_INVALID');
  }
  for(let i=0;i<2;i++) assert.equal((await call({action:'read'})).success,true);
  await assert.rejects(call({action:'read'}),{code:'TASK_CALL_LIMIT'});
  assert.deepEqual(await store.get('fixture'),before);
  const unbounded=createTaskToolHandler({store,taskId:'fixture',runId:'fixture-run',nodeId:'agent',schemaVersion:14});
  for(let i=0;i<20;i++) assert.equal((await unbounded({name:'relay_task',arguments:{action:'read'}})).success,true);
  assert.deepEqual(await store.get('fixture'),before,'ordinary reads have no invented fixed loop limit or mutation');
});
