import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlanContract } from '../public/planning-contract-model.mjs';
import { projectContractTaskState, contractDeliveryPage, createContractDeliveryTracker, CONTRACT_REPLY_BYTES } from '../lib/planning-contract-delivery.mjs';

const contract = (count = 1, size = 20) => ({ ...normalizePlanContract({ contractVersion: 2, goal: 'Inspect the actual supplied files.', criteria: [{ id: 'observed', kind: 'observation', description: 'The actual files were observed.' }],
  workItems: Array.from({ length: count }, (_, i) => ({ id: 'item_' + i, title: 'Inspect item ' + i, objective: 'x'.repeat(size), owner: 'coordinator', resourceKeys: ['workspace:/actual'], effects: ['observe'], dependsOn: [], criterionIds: ['observed'] })), instructions: [] }), planEpoch: 1 });
const state = value => ({ taskId: 'delivery-task', revision: 2, taskSchemaVersion: 14, steps: [], contract: value, goal: value.goal, contractRuntime: { version: 1, journalSeq: 8, planEpoch: 1, operations: [], evidence: [], criteria: [], outcomes: [], workItems: [], focuses: [], findings: [], unresolved: [] } });
const receipt = value => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });

test('the common complete projection preserves the exact accepted intent under the native budget', () => {
  const saved = state(contract()), projected = projectContractTaskState(saved), seen = [];
  assert.equal(projected.contractDelivery.kind, 'complete');
  assert.deepEqual(projected.contract, saved.contract);
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) <= CONTRACT_REPLY_BYTES);
  const deliver = createContractDeliveryTracker(saved.taskId, snapshot => seen.push(snapshot));
  assert.equal(seen.length, 0);
  deliver(receipt(projected));
  assert.equal(seen.length, 1); assert.deepEqual(seen[0].contract, saved.contract);
});

test('a provider-shortened complete payload cannot acknowledge the omitted intent', () => {
  const saved = state(contract(6, 500)), full = projectContractTaskState(saved), seen = [], deliver = createContractDeliveryTracker(saved.taskId, snapshot => seen.push(snapshot));
  const short = structuredClone(full); short.contract.workItems.pop();
  deliver(receipt(short)); assert.equal(seen.length, 0);
  const omitted = structuredClone(full); delete omitted.contract;
  deliver(receipt(omitted)); assert.equal(seen.length, 0);
  deliver(receipt(full)); assert.equal(seen.length, 1);
});

test('large exact contracts are read through pinned pages; repeated partial ranges do not complete coverage', () => {
  const saved = state(contract(60, 900)), manifest = projectContractTaskState(saved), seen = [], deliver = createContractDeliveryTracker(saved.taskId, snapshot => seen.push(snapshot));
  assert.equal(manifest.contractDelivery.kind, 'manifest');
  assert.equal(manifest.contract, undefined);
  deliver(receipt(manifest)); assert.equal(seen.length, 0);
  let args = manifest.contractDelivery.nextRead; const pages = [];
  while (args) { const page = contractDeliveryPage(saved, args); pages.push(page); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= CONTRACT_REPLY_BYTES); args = page.nextRead; }
  for (let i = 0; i < 4; i++) deliver(receipt(pages[0]));
  assert.equal(seen.length, 0);
  for (const page of pages.slice(1).reverse()) deliver(receipt(page));
  assert.equal(seen.length, 1); assert.deepEqual(seen[0].contract, saved.contract);
});

test('changed revision or hash cannot mix into an existing material read', () => {
  const saved = state(contract(40, 800)), args = projectContractTaskState(saved).contractDelivery.nextRead;
  assert.throws(() => contractDeliveryPage({ ...saved, revision: 3 }, args), { code: 'TASK_STATE_CONFLICT' });
  assert.throws(() => contractDeliveryPage(saved, { ...args, viewHash: '0'.repeat(64) }), { code: 'TASK_STATE_CONFLICT' });
});

test('a missing or corrupt contract page remains unread', () => {
  const saved = state(contract(60, 900)), seen = [], deliver = createContractDeliveryTracker(saved.taskId, snapshot => seen.push(snapshot));
  let args = projectContractTaskState(saved).contractDelivery.nextRead, index = 0;
  while (args) { const page = contractDeliveryPage(saved, args); args = page.nextRead; if (index++ !== 1) deliver(receipt(page)); }
  assert.equal(seen.length, 0);
  const first = contractDeliveryPage(saved, projectContractTaskState(saved).contractDelivery.nextRead);
  first.text = first.text.slice(0, -1) + '!'; deliver(receipt(first)); assert.equal(seen.length, 0);
});

test('UTF-8-heavy canonical pages honor the byte budget and retain exact content', () => {
  const value = contract(40, 500); value.workItems.forEach(item => { item.objective = '界'.repeat(500); });
  const saved = state(value), seen = [], deliver = createContractDeliveryTracker(saved.taskId, snapshot => seen.push(snapshot));
  let args = projectContractTaskState(saved).contractDelivery.nextRead;
  while (args) { const page = contractDeliveryPage(saved, args); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= CONTRACT_REPLY_BYTES); deliver(receipt(page)); args = page.nextRead; }
  assert.deepEqual(seen[0].contract, saved.contract);
});
