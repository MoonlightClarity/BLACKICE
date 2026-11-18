import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fileSystem } from 'node:fs';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UserWorkflowStore } from '../lib/user-workflows.mjs';
import { USER_WORKFLOW_TOOL, createUserWorkflowToolHandler } from '../lib/user-workflow-tools.mjs';
const human = { source: 'human' };
const definition = (patch = {}) => ({ name: 'Find suitable jobs', description: 'Explicit search procedure',
  instructions: 'Use the chosen job boards and employer careers pages. Verify each listing.', status: 'approved', expectedRevision: 0, ...patch });
const update = (row, patch = {}) => definition({ id: row.id, name: row.name, description: row.description,
  instructions: row.instructions, status: row.status, expectedRevision: row.revision, ...patch });
const body = result => JSON.parse(result.contentItems[0].text);
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-user-workflows-'));
  const store = await new UserWorkflowStore({ dataDir }).init();
  t.after(async () => { await store.close(); assert.match(path.basename(dataDir), /^blackice-user-workflows-/); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, store };
}
test('empty store never generates definitions or imports memories; human revision survives restart exactly', async t => {
  const { dataDir, store } = await fixture(t);
  await writeFile(path.join(dataDir, 'memories.json'), JSON.stringify({ text: 'Automatically learn this procedure.' }));
  assert.deepEqual(await store.list(), []);
  assert.deepEqual((await readdir(dataDir)).sort(), ['memories.json']);
  const row = await store.save(definition(), human);
  assert.equal(row.revision, 1); assert.equal(row.approvedRevision, 1);
  assert.equal(row.instructions, definition().instructions);
  row.instructions = 'Attempt to mutate returned object';
  assert.equal((await store.read(row.id)).instructions, definition().instructions);
  const reopened = await new UserWorkflowStore({ dataDir }).init();
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.read(row.id), await store.read(row.id));
  assert.ok(!(await readdir(dataDir)).some(name => name.endsWith('.lock') || name.endsWith('.tmp')));
});
test('save requires explicit human provenance, approval choice, exact revision and bounded known fields', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.save(definition()), { code: 'USER_WORKFLOW_HUMAN_REQUIRED' });
  await assert.rejects(store.save(definition(), { source: 'model' }), { code: 'USER_WORKFLOW_HUMAN_REQUIRED' });
  for (const value of [
    definition({ status: undefined }), definition({ expectedRevision: undefined }), definition({ expectedRevision: -1 }),
    definition({ instructions: '' }), definition({ instructions: 'x'.repeat(16001) }),
    definition({ instructions: '😀'.repeat(4001) }), definition({ name: 'x'.repeat(121) }),
    definition({ description: 'x'.repeat(1001) }), definition({ source: 'human' }), definition({ schedule: '* * * * *' }),
    definition({ id: '../escape' }), definition({ instructions: 'null\0byte' }), [],
  ]) await assert.rejects(store.save(value, human), { code: 'USER_WORKFLOW_INVALID' });
  assert.deepEqual(await store.list(), []);
});
test('updates revoke approval unless exact replacement is explicitly approved; execute is pinned and read-only', async t => {
  const { store } = await fixture(t);
  const first = await store.save(definition(), human);
  const before = await readFile(store.file, 'utf8');
  const chosen = await store.execute(first.id, { expectedRevision: first.revision });
  assert.deepEqual(chosen.workflow, first); assert.equal(chosen.disposition, 'apply-in-current-task');
  assert.equal(chosen.executionStarted, false);
  assert.match(chosen.guidance, /does not authorize additional actions/);
  assert.equal(await readFile(store.file, 'utf8'), before);
  const draft = await store.save(update(first, { instructions: 'Different exact procedure', status: 'draft' }), human);
  assert.equal(draft.revision, 2); assert.equal(draft.approvedRevision, null);
  await assert.rejects(store.execute(first.id, { expectedRevision: 1 }), { code: 'USER_WORKFLOW_CONFLICT' });
  await assert.rejects(store.execute(draft.id, { expectedRevision: 2 }), { code: 'USER_WORKFLOW_NOT_APPROVED' });
  await assert.rejects(store.execute(draft.id), { code: 'USER_WORKFLOW_INVALID' });
  const approved = await store.save(update(draft, { status: 'approved' }), human);
  assert.equal(approved.approvedRevision, 3);
  assert.deepEqual((await store.execute(approved.id, { expectedRevision: 3 })).workflow, approved);
});
test('serialized concurrent saves cannot overwrite a newer revision and other instances read fresh disk state', async t => {
  const { store, dataDir } = await fixture(t);
  const row = await store.save(definition(), human);
  const results = await Promise.allSettled([store.save(update(row, { name: 'First edit' }), human), store.save(update(row, { name: 'Second edit' }), human)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.find(x => x.status === 'rejected').reason.code, 'USER_WORKFLOW_CONFLICT');
  const second = await new UserWorkflowStore({ dataDir }).init(); t.after(() => second.close());
  assert.equal((await second.read(row.id)).name, 'First edit');
  await assert.rejects(second.save(update(row), human), { code: 'USER_WORKFLOW_CONFLICT' });
  const fresh = await second.read(row.id);
  const edited = await second.save(update(fresh, { name: 'Other window' }), human);
  assert.deepEqual(await store.read(row.id), edited);
  await writeFile(store.lockFile, 'Another writer owns this lock.');
  await assert.rejects(store.save(update(edited), human), { code: 'USER_WORKFLOW_CONFLICT' });
  assert.equal(await readFile(store.lockFile, 'utf8'), 'Another writer owns this lock.');
  await rm(store.lockFile);
});
test('atomic save failure preserves previous definition and releases only its own temporary files', async t => {
  const { store } = await fixture(t);
  const row = await store.save(definition(), human);
  const before = await readFile(store.file, 'utf8');
  const originalRename = fileSystem.rename;
  const rename = t.mock.method(fileSystem, 'rename', async (from, to) => {
    if(to === store.file) throw new Error('Synthetic atomic rename failure');
    return originalRename(from, to);
  });
  await assert.rejects(store.save(update(row), human), /Synthetic atomic rename failure/);
  assert.equal(await readFile(store.file, 'utf8'), before);
  assert.ok(!(await readdir(store.dataDir)).some(name => name.endsWith('.lock') || name.endsWith('.tmp')));
  rename.mock.restore();
  assert.equal((await store.save(update(row), human)).revision, 2);
});
test('invalid persisted approval/revision and malformed files fail closed without rewriting content', async t => {
  const { store } = await fixture(t);
  const row = await store.save(definition(), human);
  for (const text of ['{bad', JSON.stringify({ version: 1, workflows: [{ ...row, approvedRevision: 0 }] }), JSON.stringify({ version: 1, workflows: [row, row] })]) {
    await writeFile(store.file, text);
    await assert.rejects(store.read(row.id), { code: 'USER_WORKFLOW_LOAD_FAILED' });
    assert.equal(await readFile(store.file, 'utf8'), text);
  }
});
test('human removal checks revision and model handler denies all mutation or caller-supplied approval', async t => {
  const { store } = await fixture(t);
  const approved = await store.save(definition(), human);
  const draft = await store.save(definition({ name: 'Unapproved private draft', status: 'draft' }), human);
  const handler = createUserWorkflowToolHandler({ workflows: store, runId: 'current-task' });
  const invoke = args => handler({ name: USER_WORKFLOW_TOOL.name, arguments: args });
  const listed = await invoke({ action: 'list' });
  assert.deepEqual(body(listed).workflows.map(row => row.id), [approved.id]);
  assert.equal(body(listed).workflows[0].instructions, undefined);
  assert.deepEqual(body(await invoke({ action: 'read', id: approved.id })).workflow, approved);
  assert.equal((await invoke({ action: 'read', id: draft.id })).code, 'USER_WORKFLOW_NOT_APPROVED');
  const before = await readFile(store.file, 'utf8');
  for (const action of ['save', 'write', 'approve', 'delete', 'remove', 'generate']) {
    assert.equal((await invoke({ action, id: approved.id })).code, 'USER_WORKFLOW_ACTION_DENIED');
  }
  assert.equal((await invoke({ action: 'execute', id: approved.id, expectedRevision: 1, source: 'human', status: 'approved' })).code, 'USER_WORKFLOW_ACTION_DENIED');
  assert.equal((await invoke({ action: 'execute', id: approved.id })).success, false);
  const executed = await invoke({ action: 'execute', id: approved.id, expectedRevision: 1 });
  assert.equal(executed.success, true); assert.equal(body(executed).runId, 'current-task');
  assert.deepEqual(body(executed).workflow, approved); assert.equal(body(executed).executionStarted, false);
  assert.equal(await readFile(store.file, 'utf8'), before);
  assert.deepEqual(USER_WORKFLOW_TOOL.inputSchema.properties.action.enum, ['list', 'read', 'execute']);
  assert.equal(await handler({ name: 'other', arguments: {} }), null);
  await assert.rejects(store.remove(approved.id, { expectedRevision: 1, source: 'model' }), { code: 'USER_WORKFLOW_HUMAN_REQUIRED' });
  await assert.rejects(store.remove(approved.id, { expectedRevision: 2, ...human }), { code: 'USER_WORKFLOW_CONFLICT' });
  assert.equal((await store.remove(approved.id, { expectedRevision: 1, ...human })).removed, true);
  await assert.rejects(store.read(approved.id), { code: 'USER_WORKFLOW_NOT_FOUND' });
});
test('bounded catalog rejects overflow without partial write and closed store rejects mutations', async t => {
  const { store } = await fixture(t);
  const first = await store.save(definition(), human);
  const document = JSON.parse(await readFile(store.file, 'utf8'));
  document.workflows = Array.from({ length: 100 }, (_, i) => ({ ...first, id: 'fixture-' + i }));
  await writeFile(store.file, JSON.stringify(document));
  await assert.rejects(store.save(definition(), human), /limit is 100/);
  assert.equal((await store.list()).length, 100);
  await store.close();
  await assert.rejects(store.save(definition(), human), { code: 'USER_WORKFLOW_CLOSED' });
});

test('catalog summaries bound description while read and execution preserve the exact definition', async t => {
  const { store } = await fixture(t);
  const description = 'Detailed user-authored guidance. '.repeat(30);
  const row = await store.save(definition({ description }), human);
  const summaries = await store.list();
  assert.equal(summaries[0].description, description.slice(0, 240));
  assert.equal(summaries[0].instructions, undefined);
  assert.equal((await store.read(row.id)).description, description);
  assert.equal((await store.execute(row.id, { expectedRevision: row.revision })).workflow.description, description);
  const handler = createUserWorkflowToolHandler({ workflows: store });
  const listed = body(await handler({ name: USER_WORKFLOW_TOOL.name, arguments: { action: 'list' } }));
  assert.equal(listed.workflows[0].description.length, 240);
});
