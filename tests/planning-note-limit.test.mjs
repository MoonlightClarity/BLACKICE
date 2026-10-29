import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskStateStore, TASK_SCHEMA_VERSION, TASK_WORKER_TOOL, taskToolForVersion, taskWorkerToolForVersion, createTaskToolHandler } from '../lib/task-state.mjs';

const parsed = response => JSON.parse(response.contentItems[0].text);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fixture(t, schemaVersion) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'blackice-note-limit-'));
  const store = await new TaskStateStore({ dataDir: root }).init();
  t.after(async () => { await store.close(); assert.match(path.basename(root), /^blackice-note-limit-/); await fs.rm(root, { recursive: true, force: true }); });
  const state = await store.ensure({ taskId: 'note-task', runId: 'note-run', nodeId: 'agent', cwd: root, goal: 'Complete and check the current work.', defaultPlan: true });
  const handler = createTaskToolHandler({ store, taskId: state.taskId, runId: 'note-run', nodeId: 'agent', schemaVersion });
  return { store, state, call: args => handler({ name: 'relay_task', arguments: args }) };
}

test('v7 through v9 advertise the same note limit while cached v6 remains unchanged', async t => {
  assert.equal(TASK_SCHEMA_VERSION, 9);
  for (const tool of [7, 8, 9].flatMap(version => [taskToolForVersion(version), taskWorkerToolForVersion(version)])) {
    const f = tool.inputSchema.properties;
    for (const note of [f.note, f.steps.items.properties.note, f.operations.items.properties.step.properties.note, f.operations.items.properties.patch.properties.note.anyOf[0]]) assert.equal(note.maxLength, 700);
    assert.deepEqual(f.operations.items.properties.patch.properties.note.anyOf[1], { type: 'null' });
  }
  assert.equal(taskWorkerToolForVersion(9), TASK_WORKER_TOOL);
  assert.equal(taskWorkerToolForVersion(8).inputSchema.properties.operation, undefined);
  assert.equal(digest(taskWorkerToolForVersion(6)), 'e27a50b314a227b671c7a82303054e60ab3a3668cbb96e29d88d561633d4173c');
  assert.equal(taskWorkerToolForVersion(6).inputSchema.properties.note.maxLength, undefined);
  for (const version of [6, 7, 8, 9]) {
    const f = await fixture(t, version), description = parsed(await f.call({ action: 'describe' }));
    assert.equal(description.schemaVersion, version);
    assert.equal(description.plan.inputSchema.properties.steps.items.properties.note.maxLength, version >= 7 ? 700 : undefined);
    assert.equal(description.operations.items.properties.patch.properties.note.anyOf[0].maxLength, version >= 7 ? 700 : undefined);
  }
});

for (const version of [6, 7, 8, 9]) test(`v${version} rejects the observed 714-character note atomically and accepts a concise repair at the unchanged 700-character boundary`, async t => {
  const f = await fixture(t, version), ids = ['finish_supported_answers', 'pre_submit_review', 'submit_mariner_once'];
  const saved = await f.call({ action: 'plan', expectedRevision: f.state.revision, steps: ids.map(id => ({ id, title: id, kind: 'action', status: 'pending', note: 'n'.repeat(700), doneWhen: 'The actual result is checked.' })) });
  assert.equal(saved.success, true);
  let state = parsed(saved); const bytes = await fs.readFile(f.store.file(state.taskId));
  // Preserve the failing live batch's field/length shape without private text.
  const operations = [
    { type: 'update', stepId: ids[0], patch: { note: 'n'.repeat(714), doneWhen: 'The supported result is checked.', evidence: 'e'.repeat(727) } },
    { type: 'update', stepId: ids[1], patch: { note: 'n'.repeat(541), doneWhen: 'The final review is checked.' } },
    { type: 'update', stepId: ids[2], patch: { note: 'n'.repeat(434), doneWhen: 'The destination result is observed.' } }
  ];
  const rejected = await f.call({ action: 'edit', expectedRevision: state.revision, operations });
  assert.equal(rejected.success, false); assert.equal(rejected.code, 'INVALID_TASK_PLAN'); assert.match(parsed(rejected).error, /Step note.*at most 700/);
  assert.deepEqual(await fs.readFile(f.store.file(state.taskId)), bytes, 'A later rejected field must not publish any part of the batch.');
  operations[0].patch.note = 'n'.repeat(700);
  const repaired = await f.call({ action: 'edit', expectedRevision: state.revision, operations }); assert.equal(repaired.success, true);
  state = parsed(repaired); assert.equal(state.steps[0].note.length, 700); assert.equal(state.steps[0].evidence.length, 727);
  const tooLongStep = await f.call({ action: 'step', expectedRevision: state.revision, stepId: ids[0], note: 'n'.repeat(701) });
  assert.equal(tooLongStep.success, false); assert.equal((await f.store.get(state.taskId)).revision, state.revision);
  const validStep = await f.call({ action: 'step', expectedRevision: state.revision, stepId: ids[0], note: 'n'.repeat(700) }); assert.equal(validStep.success, true);
  state = parsed(validStep);
  const cleared = await f.call({ action: 'edit', expectedRevision: state.revision, operations: [{ type: 'update', stepId: ids[0], patch: { note: null } }] });
  assert.equal(cleared.success, true); assert.equal(parsed(cleared).steps[0].note, undefined);
});
