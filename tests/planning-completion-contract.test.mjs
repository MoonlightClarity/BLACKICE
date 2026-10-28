import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskStateStore, createTaskToolHandler, TASK_TOOL, TASK_TOOL_V7 } from '../lib/task-state.mjs';

const payload = receipt => JSON.parse(receipt.contentItems[0].text);

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-completion-contract-'));
  const cwd = path.join(directory, 'work');
  await mkdir(cwd);
  const store = await new TaskStateStore({ dataDir: directory }).init();
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const taskId = 'completion-contract';
  await store.ensure({ taskId, runId: 'run-one', cwd, goal: 'Correct one exact phrase.', defaultPlan: true });
  const handler = createTaskToolHandler({ store, taskId, runId: 'run-one', nodeId: 'agent', planningMode: 'on' });
  const call = args => handler({ name: 'relay_task', arguments: args });
  const initial = payload(await call({ action: 'read' }));
  return { store, taskId, call, initial };
}

test('a rejected finding in result preserves the saved contract and permits a corrected completion at the same revision', async t => {
  const f = await fixture(t);
  const prospective = {
    id: 'correct_notice', kind: 'action', status: 'pending', title: 'Correct the requested phrase in notice.txt',
    result: 'The requested phrase is corrected with every other byte and file preserved.',
    note: 'Read the original bytes, replace the single specified ASCII phrase, and compare the result with that exact substitution.',
    doneWhen: 'Read-back bytes equal the original bytes with only the requested substitution and the directory entries are unchanged.'
  };
  const planned = await f.call({ action: 'plan', expectedRevision: f.initial.revision, plan: { layout: 'sequence' }, steps: [prospective] });
  assert.equal(planned.success, true);
  const saved = payload(planned), before = await readFile(f.store.file(f.taskId));
  // These observations reproduce the successful native case-03 work record.
  const evidence = 'Replaced the single phrase at byte offset 19. Read-back comparison matched exactly; length stayed 73 bytes and the same three directory entries remain.';
  const rejected = await f.call({ action: 'step', expectedRevision: saved.revision, stepId: prospective.id, status: 'done', result: 'notice.txt was corrected in place; the directory contents remained unchanged.', evidence });
  assert.equal(rejected.success, false);
  assert.equal(rejected.code, 'TASK_PLAN_PROSPECTIVE_REQUIRED');
  assert.match(payload(rejected).error, /result/);
  assert.match(payload(rejected).error, /evidence/);
  assert.deepEqual(await readFile(f.store.file(f.taskId)), before, 'A rejected completion changes neither saved bytes nor revision.');

  const completed = await f.call({ action: 'step', expectedRevision: saved.revision, stepId: prospective.id, status: 'done', evidence });
  assert.equal(completed.success, true, 'Correcting the payload requires no intervening plan edit or repeated operation.');
  const state = payload(completed);
  assert.equal(state.revision, saved.revision + 1);
  assert.equal(state.steps[0].status, 'done');
  assert.equal(state.steps[0].evidence, evidence);
  for (const field of ['result', 'note', 'doneWhen']) assert.equal(state.steps[0][field], prospective[field]);
});

test('live describe supplies an executable completion example without changing the planned output', async t => {
  const f = await fixture(t);
  const described = payload(await f.call({ action: 'describe' }));
  const planned = await f.call({ ...described.plan.example, expectedRevision: f.initial.revision });
  assert.equal(planned.success, true);
  const saved = payload(planned);
  assert.equal(described.step.example.result, undefined);
  assert.equal(described.step.example.note, undefined);
  assert.equal(described.step.example.doneWhen, undefined);
  const completed = await f.call({ ...described.step.example, expectedRevision: saved.revision });
  assert.equal(completed.success, true);
  assert.equal(payload(completed).steps[0].result, saved.steps[0].result);
  assert.match(described.step.note, /without repeating/);
  assert.match(TASK_TOOL.inputSchema.properties.result.description, /Step completion/);
  assert.match(TASK_TOOL.inputSchema.properties.evidence.description, /actual observed finding/);
  assert.equal(TASK_TOOL_V7.inputSchema.properties.result.description, 'The concrete result this action should produce.');
});
