import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskActionDirectory } from '../lib/task-action-directory.mjs';

test('a bounded provider Directory view preserves all action identities and unknown receipts while paging out old detail', t => {
  const taskId = 'fixture-task';
  const actions = Array.from({ length: 24 }, (_, index) => ({
    id: 'action' + index, objective: 'Inspect exact source ' + index,
    state: index === 22 ? 'active' : index === 23 ? 'pending' : 'observed',
    dependsOn: index === 23 ? ['action22'] : [], authority: 'agent',
    notes: Array.from({ length: 5 }, (_, note) => ({ authority: 'agent', claim: 'Details ' + note + ' ' + 'x'.repeat(260), receipts: ['receipt-' + (index + 1)] })),
    ...(index < 22 ? { observation: { authority: 'agent', claim: 'Observed source ' + index, receipts: ['receipt-' + (index + 1)] } } : {}),
  }));
  actions[0].doneChecks=[{id:'all_sources',check:'Were all sources inspected?',requestQuote:'Inspect all twenty-four sources'}];
  actions[0].observation.qualification={count:2};
  const receipts = Array.from({ length: 240 }, (_, index) => ({
    id: 'receipt-' + (index + 1), taskId, runId: 'run-a', nodeId: 'agent-a',
    actionId: 'action' + (index % 24), tool: 'relay_workspace',
    state: index === 40 ? 'unknown' : 'returned', success: index === 40 ? undefined : true,
    at: '2026-11-22T22:00:00.000Z', returnedAt: '2026-11-22T22:01:00.000Z',
  }));
  const directory = new TaskActionDirectory({
    taskId, objective: 'Inspect all twenty-four sources without losing evidence.',
    snapshot: { version: 1, taskId, objective: 'Inspect all twenty-four sources without losing evidence.',
      revision: 8, actionRevision: 7, focus: 'action22', actions, receipts, nextReceipt: 241 },
  });
  const complete = directory.read();
  const view = directory.promptView();
  assert.equal(view.actions.length, 24);
  assert.deepEqual(view.actions.map(row => row.id), complete.actions.map(row => row.id));
  assert.equal(view.actions[0].notes, undefined, 'Old completed details are not repeated in the starting prompt.');
  assert.equal(view.actions[0].requestChecks[0].requestQuote, 'Inspect all twenty-four sources', 'Explicit user requirements remain visible.');
  assert.equal(view.actions[0].observation.verifiedQualifyingCount, 2);
  assert.equal(view.actions[22].notes.length, 2, 'Current action retains recent notes.');
  assert.equal(view.actions[22].deferredNoteCount, 3);
  assert(view.receipts.some(receipt => receipt.id === 'receipt-41' && receipt.state === 'unknown'), 'Unresolved effect is never omitted.');
  assert.equal(view.receipts.length, 9);
  assert.equal(view.deferredReceiptCount, 231);
  assert.equal(complete.receipts.length, 240, 'The complete task ledger remains intact.');
  assert(JSON.stringify(view).length < JSON.stringify(complete).length * 0.65, 'The provider view is substantially smaller.');
  assert.match(view.retrieval, /relay_directory_action read/);
  const fullBytes=Buffer.byteLength(JSON.stringify(complete)), viewBytes=Buffer.byteLength(JSON.stringify(view));
  t.diagnostic('Fixture Directory startup view: '+fullBytes+' -> '+viewBytes+' UTF-8 bytes ('+((1-viewBytes/fullBytes)*100).toFixed(1)+'% reduction).');
});
