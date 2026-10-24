import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskStateStore, createTaskToolHandler } from '../lib/task-state.mjs';

const prepared = { receiptId: 'email-application', operation: 'prepare', destination: 'hiring@example.invalid', content: 'Exact synthetic application content.', attachmentSha256: 'a'.repeat(64) };
const confirmation = { receiptId: prepared.receiptId, operation: 'confirm', url: 'mid:6298724c-3aaa-4271-93eb-497f37f9f477@blackice.local', evidence: 'Transport accepted the exact synthetic message; a matching Sent message was observed with this Message-ID and checked attachment.' };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-email-confirmation-')), stores = [];
  const open = async () => { const store = await new TaskStateStore({ dataDir: directory }).init(); stores.push(store); return store; };
  const store = await open(); await store.ensure({ taskId: 'email-task', runId: 'email-run', nodeId: 'agent', cwd: directory, goal: 'Send one synthetic message and preserve its outcome.' });
  t.after(async () => {
    await Promise.all(stores.map(value => value.close()));
    const resolved = path.resolve(directory); assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(tmpdir()).toLowerCase()); assert.ok(path.basename(resolved).startsWith('blackice-email-confirmation-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const options = async (source = store) => ({ expectedRevision: (await source.get('email-task')).revision, runId: 'email-run', nodeId: 'agent' });
  const action = async (value, source = store) => source.externalAction('email-task', value, await options(source));
  return { directory, store, open, options, action };
}

test('observed email Message-ID confirms the existing uncertain receipt durably without a web permalink', async t => {
  const f = await fixture(t), initial = await f.action(prepared), fingerprint = initial.externalActions[0].fingerprint;
  await f.action({ receiptId: prepared.receiptId, operation: 'attempt' });
  const restored = await f.open(), state = await f.action(confirmation, restored), receipt = state.externalActions[0];
  assert.equal(receipt.status, 'confirmed'); assert.equal(receipt.attempts, 1); assert.equal(receipt.fingerprint, fingerprint);
  assert.equal(receipt.url, confirmation.url); assert.equal(receipt.referenceKind, 'email-message'); assert.equal(receipt.emailMessageId, '<6298724c-3aaa-4271-93eb-497f37f9f477@blackice.local>');
  assert.equal(receipt.verification, 'agent-reported-external-evidence'); assert.equal(receipt.evidence, confirmation.evidence);
  assert.equal(receipt.recipientAcknowledged, undefined); assert.equal(receipt.transportAccepted, undefined, 'A generic agent report must not invent machine transport evidence.');
  const reloaded = await f.open(); assert.deepEqual((await reloaded.get('email-task')).externalActions, state.externalActions);
  const context = await reloaded.getContext('email-task'); assert.match(context, /Confirmed external action/); assert.match(context, /Do not send it again/); assert.doesNotMatch(context, /Uncertain external attempt/);
  await assert.rejects(f.action({ receiptId: prepared.receiptId, operation: 'attempt' }, reloaded), { code: 'EXTERNAL_ACTION_RECONCILE' });
  await assert.rejects(f.action({ receiptId: prepared.receiptId, operation: 'reconcile_absent', evidence: 'Try another send.' }, reloaded), { code: 'EXTERNAL_ACTION_RECONCILE' });
  await assert.rejects(f.action({ ...prepared, receiptId: 'duplicate' }, reloaded), { code: 'EXTERNAL_ACTION_CONFLICT' });
  const repeated = await f.action({ ...confirmation, url: 'MID:%36298724c-3aaa-4271-93eb-497f37f9f477%40blackice.local' }, reloaded);
  assert.equal(repeated.externalActions[0].url, confirmation.url); assert.equal(repeated.externalActions[0].confirmedAt, receipt.confirmedAt); assert.equal(repeated.externalActions[0].attempts, 1);
});

test('mid parsing canonicalizes URI escapes while preserving Message-ID case and encoded identity punctuation', async t => {
  const f = await fixture(t);
  for (const [index, input, canonical, messageId] of [
    [0, 'MID:%43ase%2Bresearch%40Example.INVALID', 'mid:Case%2Bresearch@Example.INVALID', '<Case+research@Example.INVALID>'],
    [1, 'mid:part%2Fone%3Ftwo%23three@example.invalid', 'mid:part%2Fone%3Ftwo%23three@example.invalid', '<part/one?two#three@example.invalid>'],
    [2, 'mid:id@%5B127.0.0.1%5D', 'mid:id@%5B127.0.0.1%5D', '<id@[127.0.0.1]>'],
  ]) {
    const receiptId = 'canonical-' + index; await f.action({ ...prepared, receiptId, content: prepared.content + index });
    const state = await f.action({ ...confirmation, receiptId, url: input }), receipt = state.externalActions.find(item => item.id === receiptId);
    assert.equal(receipt.url, canonical); assert.equal(receipt.emailMessageId, messageId); assert.equal(receipt.referenceKind, 'email-message');
  }
});

test('email confirmation uses the existing nonempty agent evidence standard without a keyword or approval gate', async t => {
  const f = await fixture(t); await f.action(prepared);
  const state = await f.action({ ...confirmation, evidence: 'Observed the result in the configured sending transport.' });
  assert.equal(state.externalActions[0].status, 'confirmed'); assert.equal(state.externalActions[0].attempts, 0);
  const before = await f.store.get('email-task');
  await assert.rejects(f.action({ ...confirmation, evidence: '' }), { code: 'INVALID_TASK_STATE' });
  assert.deepEqual(await f.store.get('email-task'), before);
});

test('malformed mid references reject controls, query, fragments, authority, paths and multiple IDs without writes', async t => {
  const f = await fixture(t); await f.action(prepared); await f.action({ receiptId: prepared.receiptId, operation: 'attempt' });
  const before = await f.store.get('email-task');
  for (const url of [
    'mid:', 'mid:no-at', 'mid:@example.invalid', 'mid:id@', 'mid:id@@example.invalid', 'mid:id@example.invalid,other@example.invalid',
    'mid:id@example.invalid;other@example.invalid', 'mid://id@example.invalid', 'mid:id@example.invalid/part@example.invalid',
    'mid:id@example.invalid?query=bad', 'mid:id@example.invalid#fragment', 'mid:<id@example.invalid>', 'mid:%3Cid@example.invalid%3E',
    'mid:id@example.invalid\r\n', 'mid:id%0D%0A@example.invalid', 'mid:id%00@example.invalid', 'mid:id%7F@example.invalid',
    'mid:id%09@example.invalid', 'mid:id%20space@example.invalid', 'mid:id%ZZ@example.invalid', 'mid:id%F0@example.invalid',
    ' mid:id@example.invalid', 'mid:id@example.invalid ', 'mid:.id@example.invalid', 'mid:id..other@example.invalid',
    'mid:id.@example.invalid', 'mid:id@example..invalid', 'mid:id@<example.invalid>',
    'mailto:hiring@example.invalid', 'file:///private', 'cid:id@example.invalid',
    'mid:' + 'a'.repeat(2048) + '@example.invalid', 'mid:' + '+'.repeat(700) + '@example.invalid',
  ]) await assert.rejects(f.action({ ...confirmation, url }), { code: 'INVALID_TASK_STATE' }, JSON.stringify(url));
  assert.deepEqual(await f.store.get('email-task'), before);
});

test('mid confirmation is scoped to mailto receipts and cannot replace an established different result', async t => {
  const f = await fixture(t); await f.action({ ...prepared, destination: 'https://example.invalid/apply' });
  const before = await f.store.get('email-task');
  await assert.rejects(f.action(confirmation), error => error.code === 'INVALID_TASK_STATE' && /only valid for a prepared mailto/.test(error.message));
  assert.deepEqual(await f.store.get('email-task'), before);
  await f.action({ ...prepared, receiptId: 'email-result' }); await f.action({ ...confirmation, receiptId: 'email-result' });
  await assert.rejects(f.action({ ...confirmation, receiptId: 'email-result', url: 'mid:different@example.invalid' }), { code: 'EXTERNAL_ACTION_CONFLICT' });
  await assert.rejects(f.action({ ...confirmation, receiptId: 'email-result', url: 'https://mail.example.invalid/different' }), { code: 'EXTERNAL_ACTION_CONFLICT' });
});

test('HTTP result shape, normalization and prepared fingerprint remain unchanged', async t => {
  const f = await fixture(t), input = { ...prepared, destination: 'HTTPS://EXAMPLE.invalid:443/apply?q=Case#part' };
  const initial = await f.action(input), preparedReceipt = initial.externalActions[0];
  assert.equal(preparedReceipt.fingerprint, hash({ destination: new URL(input.destination).href, content: input.content, attachmentSha256: input.attachmentSha256 }));
  const state = await f.action({ ...confirmation, url: ' HTTPS://EXAMPLE.invalid:443/result?q=Case#part ' }), receipt = state.externalActions[0];
  assert.equal(receipt.url, 'https://example.invalid/result?q=Case#part'); assert.equal(receipt.fingerprint, preparedReceipt.fingerprint);
  assert.equal(receipt.referenceKind, undefined); assert.equal(receipt.emailMessageId, undefined); assert.equal(receipt.verification, preparedReceipt.verification);
});

test('backup-recovered email receipts reconcile by observed mid without granting replay', async t => {
  const f = await fixture(t); await f.action(prepared); await f.action({ receiptId: prepared.receiptId, operation: 'attempt' });
  await fs.writeFile(f.store.file('email-task'), '{simulate lost newest receipt');
  const recovered = await f.open(), saved = await recovered.get('email-task'); assert.equal(saved.externalRecovery.required, true); assert.equal(saved.externalActions[0].status, 'uncertain');
  const state = await f.action(confirmation, recovered); assert.equal(state.externalActions[0].status, 'confirmed'); assert.ok(state.externalActions[0].recoveryReconciledAt);
  await assert.rejects(f.action({ receiptId: prepared.receiptId, operation: 'attempt' }, recovered), { code: 'EXTERNAL_ACTION_RECONCILE' });
});

test('dynamic describe gives observed mid evidence guidance while worker receipt ownership stays unchanged', async t => {
  const f = await fixture(t), describe = async extra => {
    const handler = createTaskToolHandler({ store: f.store, taskId: 'email-task', runId: 'email-run', nodeId: 'agent', schemaVersion: 7, ...extra });
    const result = await handler({ name: 'relay_task', arguments: { action: 'describe' } }); assert.equal(result.success, true); return JSON.parse(result.contentItems[0].text);
  };
  const explanation = (await describe()).externalDestinations.confirmation;
  assert.match(explanation, /HTTP\(S\)/); assert.match(explanation, /prepared mailto.*mid:.*observed RFC Message-ID/); assert.match(explanation, /transport acceptance.*Sent message/);
  assert.match(explanation, /neither a prepared message nor the mailto compose address proves sending/); assert.match(explanation, /agent-reported.*not independent machine verification.*acknowledgment/);
  assert.equal((await describe({ worker: true, scopeStepId: 'worker-scope' })).externalDestinations, undefined);
});

test('the existing task-tool external.url string records the email reference without changing its catalog', async t => {
  const f = await fixture(t); await f.action(prepared); await f.action({ receiptId: prepared.receiptId, operation: 'attempt' });
  const handler = createTaskToolHandler({ store: f.store, taskId: 'email-task', runId: 'email-run', nodeId: 'agent', schemaVersion: 7 });
  const result = await handler({ name: 'relay_task', arguments: { action: 'external', expectedRevision: (await f.store.get('email-task')).revision, external: confirmation } });
  assert.equal(result.success, true);
  const state = JSON.parse(result.contentItems[0].text), receipt = state.externalActions[0];
  assert.equal(receipt.url, confirmation.url); assert.equal(receipt.referenceKind, 'email-message'); assert.equal(receipt.status, 'confirmed');
  assert.deepEqual((await f.store.get('email-task')).externalActions, state.externalActions);
});
