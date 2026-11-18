import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskStateStore, createTaskToolHandler } from '../lib/task-state.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const prepared = { receiptId: 'application-email', operation: 'prepare', destination: 'Hiring+Research@EXAMPLE.invalid', content: 'To: Hiring+Research@example.invalid\nSubject: Synthetic application\n\nExact checked application content.', attachmentSha256: 'a'.repeat(64) };
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-email-destination-')), stores = [];
  const open = async () => { const store = await new TaskStateStore({ dataDir: directory }).init(); stores.push(store); return store; };
  const store = await open(); await store.ensure({ taskId: 'email-task', runId: 'email-run', nodeId: 'agent', cwd: directory, goal: 'Record one synthetic email application and verify its result.' });
  t.after(async () => { await Promise.all(stores.map(value => value.close())); assert.match(path.basename(directory), /^blackice-email-destination-/); await fs.rm(directory, { recursive: true, force: true }); });
  const action = async (value, selected = store) => selected.externalAction('email-task', value, { expectedRevision: (await selected.get('email-task')).revision, runId: 'email-run', nodeId: 'agent' });
  return { directory, store, open, action };
}

test('single bare email and explicit encoded mailto share canonical receipt identity', async t => {
  const f = await fixture(t); let state = await f.action(prepared), receipt = state.externalActions[0];
  assert.equal(receipt.destination, 'mailto:Hiring%2BResearch@example.invalid');
  const fingerprint = hash({ destination: receipt.destination, content: prepared.content, attachmentSha256: prepared.attachmentSha256 });
  assert.equal(receipt.fingerprint, fingerprint);
  for (const destination of ['mailto:Hiring+Research@example.invalid', 'MAILTO:%48iring%2BResearch@EXAMPLE.INVALID', 'mailto:Hiring%2BResearch@example.invalid']) {
    state = await f.action({ ...prepared, destination }); assert.equal(state.externalActions.length, 1); assert.equal(state.externalActions[0].fingerprint, fingerprint);
  }
  const special = await f.action({ ...prepared, receiptId: 'special', destination: "O'Neil&Research@EXAMPLE.invalid" });
  assert.equal(special.externalActions.find(value => value.id === 'special').destination, "mailto:O'Neil%26Research@example.invalid");
});

test('canonical aliases cannot bypass content destination attachment or cross-ID duplicate protection', async t => {
  const f = await fixture(t); await f.action(prepared);
  for (const change of [{ receiptId: 'second-email', destination: 'mailto:Hiring%2BResearch@example.invalid' }, { destination: 'other@example.invalid' }, { content: prepared.content + ' changed' }, { attachmentSha256: 'b'.repeat(64) }]) await assert.rejects(f.action({ ...prepared, ...change }), { code: 'EXTERNAL_ACTION_CONFLICT' });
  const state = await f.action({ ...prepared, receiptId: 'different-local-case', destination: 'hiring+Research@example.invalid' });
  assert.equal(state.externalActions.length, 2); assert.notEqual(state.externalActions[0].fingerprint, state.externalActions[1].fingerprint, 'Mailbox local-part case must not be silently rewritten.');
});

test('HTTP canonicalization and fingerprint object identity remain exactly unchanged', async t => {
  const f = await fixture(t);
  for (const [index, destination] of ['HTTPS://EXAMPLE.invalid:443/path?q=Case#fragment', 'http://example.invalid:80/', ' https://example.invalid/account/ '].entries()) {
    const input = { ...prepared, receiptId: 'web-' + index, destination }, state = await f.action(input), receipt = state.externalActions.find(value => value.id === input.receiptId);
    const expectedDestination = new URL(destination.trim()).href;
    assert.equal(receipt.destination, expectedDestination); assert.equal(receipt.fingerprint, hash({ destination: expectedDestination, content: input.content, attachmentSha256: input.attachmentSha256 }));
  }
  const before = (await f.store.get('email-task')).externalActions;
  await f.action(prepared); const restored = await f.open();
  assert.deepEqual((await restored.get('email-task')).externalActions.slice(0, before.length), before, 'Adding email support must not migrate or rewrite saved web receipts.');
});

test('mail destination header query control fragment and multiple-recipient injections do not write state', async t => {
  const f = await fixture(t), revision = (await f.store.get('email-task')).revision;
  const invalid = ['', 'not a destination', 'file:///secret', 'javascript:alert(1)', 'https://user:password@example.invalid/', 'mailto:', 'mailto://user@example.invalid', 'mailto:user@example.invalid?subject=Injected', 'mailto:user@example.invalid#fragment', 'mailto:user@example.invalid%3Fsubject%3DInjected', 'mailto:user@example.invalid%0d%0aBcc:other@example.invalid', 'mailto:user%0a@example.invalid', 'mailto:user%09@example.invalid', 'mailto:user%00@example.invalid', 'mailto:user%7f@example.invalid', 'mailto:user%ZZ@example.invalid', 'mailto:user@example.invalid,other@example.invalid', 'user@example.invalid;other@example.invalid', 'User <user@example.invalid>', 'user name@example.invalid', 'user\n@example.invalid', 'user@example.invalid\r\n', 'mailto:user@@example.invalid', '.user@example.invalid', 'user..name@example.invalid', 'user.@example.invalid', 'user@-example.invalid', 'user@example-.invalid', 'user@example..invalid', 'user@' + 'x'.repeat(64) + '.invalid', 'x'.repeat(65) + '@example.invalid'];
  invalid.push('mailto:user@example.invalid%0A', 'mailto:user@example.invalid%0D', 'mailto:user@example.invalid%20');
  for (const destination of invalid) await assert.rejects(f.action({ ...prepared, destination }), { code: 'INVALID_TASK_STATE' }, `Rejected destination: ${JSON.stringify(destination)}`);
  assert.equal((await f.store.get('email-task')).revision, revision); assert.equal((await f.store.get('email-task')).externalActions, undefined);
});

test('email attempts survive restart and backup recovery without changing identity or granting a duplicate send', async t => {
  const f = await fixture(t), state = await f.action(prepared), fingerprint = state.externalActions[0].fingerprint;
  await f.action({ receiptId: prepared.receiptId, operation: 'attempt' }); const restored = await f.open();
  assert.equal((await restored.get('email-task')).externalActions[0].fingerprint, fingerprint);
  await assert.rejects(f.action({ receiptId: prepared.receiptId, operation: 'attempt' }, restored), { code: 'EXTERNAL_ACTION_RECONCILE' });
  await assert.rejects(f.action({ receiptId: prepared.receiptId, operation: 'confirm', url: 'mailto:Hiring%2BResearch@example.invalid', evidence: 'A compose address is not sent-message proof.' }, restored), { code: 'INVALID_TASK_STATE' });
  await fs.writeFile(restored.file('email-task'), '{simulate lost newer attempt receipt');
  let recovered = await restored.get('email-task'); assert.equal(recovered.externalActions[0].status, 'uncertain'); assert.equal(recovered.externalActions[0].fingerprint, fingerprint);
  await f.action({ ...prepared, destination: 'mailto:Hiring%2BResearch@example.invalid' }, restored);
  await assert.rejects(f.action({ receiptId: prepared.receiptId, operation: 'attempt' }, restored), { code: 'EXTERNAL_ACTION_RECONCILE' });
  recovered = await f.action({ receiptId: prepared.receiptId, operation: 'confirm', url: 'https://mail.example.invalid/sent/one', evidence: 'Observed the checked synthetic message and attachment in the destination Sent view.' }, restored);
  assert.equal(recovered.externalActions[0].status, 'confirmed'); assert.equal(recovered.externalActions[0].fingerprint, fingerprint); assert.equal(recovered.externalActions[0].destination, 'mailto:Hiring%2BResearch@example.invalid');
});

test('current task descriptions do not expose retired external receipt actions', async t => {
  const f = await fixture(t);
  for (const worker of [false, true]) {
    const handler = createTaskToolHandler({ store: f.store, taskId: 'email-task', runId: 'email-run', nodeId: 'agent', worker });
    const result = await handler({ name: 'relay_task', arguments: { action: 'describe' } });
    assert.equal(result.success, true);
    const described = JSON.parse(result.contentItems[0].text);
    assert.equal(described.externalDestinations, undefined);
    assert.ok(!described.schema.properties.action.enum.includes('external'));
  }
});
