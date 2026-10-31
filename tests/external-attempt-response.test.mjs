import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStateStore, createTaskToolHandler } from '../lib/task-state.mjs';

const parsed = result => JSON.parse(result.contentItems[0].text);
const prepare = { receiptId: 'one-send', operation: 'prepare', destination: 'https://example.invalid/compose', content: 'The exact authorized content.' };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'blackice-attempt-response-')), stores = [], events = [];
  const open = async () => { const store = await new TaskStateStore({ dataDir: root }).init(); stores.push(store); return store; };
  const store = await open(); await store.ensure({ taskId: 'send-task', runId: 'send-run', nodeId: 'agent', cwd: root, goal: 'Perform the authorized external action once and verify its result.' });
  t.after(async () => { await Promise.all(stores.map(item => item.close())); assert.match(path.basename(root), /^blackice-attempt-response-/); await fs.rm(root, { recursive: true, force: true }); });
  const handlerFor = source => createTaskToolHandler({ store: source, taskId: 'send-task', runId: 'send-run', nodeId: 'agent', onEvent: event => events.push(event) });
  const call = (handler, args) => handler({ name: 'relay_task', arguments: args });
  const external = async (handler, value, source = store) => call(handler, { action: 'external', expectedRevision: (await source.get('send-task')).revision, external: value });
  return { store, open, events, handlerFor, call, external };
}

test('a fresh successful attempt explains the expected pre-action uncertainty without persisting or replaying dispatch guidance', async t => {
  const f = await fixture(t), handler = f.handlerFor(f.store);
  const prepared = parsed(await f.external(handler, prepare)); assert.equal(prepared.externalActionResult, undefined);
  const response = await f.external(handler, { receiptId: prepare.receiptId, operation: 'attempt' }); assert.equal(response.success, true);
  const fresh = parsed(response), hint = fresh.externalActionResult;
  assert.equal(hint.receiptId, prepare.receiptId); assert.equal(hint.operation, 'attempt'); assert.equal(hint.preActionRecordSaved, true);
  assert.match(hint.note, /uncertain status is expected before the external action/); assert.match(hint.note, /Now perform this one already-authorized external action once/); assert.match(hint.note, /adds no authorization/);
  assert.equal(fresh.externalActions[0].status, 'uncertain'); assert.equal(fresh.externalActions[0].attempts, 1);
  const persisted = await f.store.get('send-task'), { externalActionResult, ...reportedState } = fresh;
  assert.deepEqual(reportedState, persisted, 'Only response guidance is added; the durable state is not modified.');
  assert.equal(f.events.at(-1).state.externalActionResult, undefined, 'Task-state events must not broadcast a reusable dispatch hint.');
  assert.doesNotMatch(await fs.readFile(f.store.file('send-task'), 'utf8'), /externalActionResult|preActionRecordSaved|Now perform/);
  const ordinaryRead = parsed(await f.call(handler, { action: 'read' })); assert.equal(ordinaryRead.externalActionResult, undefined);
  const restored = await f.open(), restoredHandler = f.handlerFor(restored);
  assert.deepEqual(await restored.get('send-task'), persisted);
  const recoveredRead = parsed(await f.call(restoredHandler, { action: 'read' })); assert.equal(recoveredRead.externalActionResult, undefined); assert.equal(recoveredRead.externalActions[0].status, 'uncertain');
  assert.match(await restored.getContext('send-task', { executionGuardrails: true }), /Inspect the destination before any retry/);
  const duplicate = await f.external(restoredHandler, { receiptId: prepare.receiptId, operation: 'attempt' }, restored);
  assert.equal(duplicate.success, false); assert.equal(duplicate.code, 'EXTERNAL_ACTION_RECONCILE'); assert.equal(parsed(duplicate).externalActionResult, undefined);
  assert.equal((await restored.get('send-task')).externalActions[0].attempts, 1);
  const confirmed = parsed(await f.external(restoredHandler, { receiptId: prepare.receiptId, operation: 'confirm', url: 'https://example.invalid/result/one', evidence: 'Observed the exact authorized content at the resulting destination.' }, restored));
  assert.equal(confirmed.externalActionResult, undefined); assert.equal(confirmed.externalActions[0].status, 'confirmed'); assert.equal(confirmed.externalActions[0].attempts, 1); assert.equal(confirmed.externalActions[0].url, 'https://example.invalid/result/one');
});

test('ordinary reconciliation does not carry a dispatch hint; a newly accepted post-reconciliation attempt retains the existing attempt count', async t => {
  const f = await fixture(t), handler = f.handlerFor(f.store);
  await f.external(handler, prepare); await f.external(handler, { receiptId: prepare.receiptId, operation: 'attempt' });
  const absent = parsed(await f.external(handler, { receiptId: prepare.receiptId, operation: 'reconcile_absent', evidence: 'Fresh destination inspection found no matching external result.' }));
  assert.equal(absent.externalActionResult, undefined); assert.equal(absent.externalActions[0].status, 'prepared'); assert.equal(absent.externalActions[0].attempts, 1);
  const next = parsed(await f.external(handler, { receiptId: prepare.receiptId, operation: 'attempt' }));
  assert.equal(next.externalActionResult.preActionRecordSaved, true); assert.equal(next.externalActions[0].status, 'uncertain'); assert.equal(next.externalActions[0].attempts, 2);
  assert.equal((await f.store.get('send-task')).externalActionResult, undefined);
});
