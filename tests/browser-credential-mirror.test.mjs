import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { BrowserCredentialVault } from '../lib/browser-credentials.mjs';
import { BrowserCredentialMirror } from '../lib/browser-credential-mirror.mjs';

const cryptography = key => ({ storageBackend: 'dpapi', isEncryptionAvailable: () => true,
  encryptSecret: value => { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv), bytes = Buffer.concat([c.update(value), c.final()]); return Buffer.concat([iv, c.getAuthTag(), bytes]); },
  decryptSecret: value => { const b = Buffer.from(value), d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString(); },
});
const context = expectedRevision => ({ source: 'user', expectedRevision });
async function waitForExportRemoval(filename, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  // Poll only the filesystem: calling status() would reconcile the queue and
  // could hide a missing autonomous expiry timer.
  for (;;) {
    try { await fs.stat(filename); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    assert.ok(Date.now() < deadline, 'The autonomous export expiry did not remove its plaintext file.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), 'blackice-credential-mirror-')), security = cryptography(randomBytes(32)), callbacks = [], mirrors = [];
  const vault = await new BrowserCredentialVault({ dataDir, ...security }).init();
  // Synthetic credentials and an explicit ACL test double keep lifecycle tests
  // portable. The separate native fixture verifies the actual Windows ACL.
  const open = async overrides => { const mirror = await new BrowserCredentialMirror({ dataDir, vault, ...security, protectTemporaryDirectory: async directory => { assert.deepEqual((await fs.readdir(directory)).sort(), ['owner.json']); return { protected: true, fixtureOnly: true }; }, beginImport: async value => { callbacks.push({ ...value, csv: await fs.readFile(value.filePath, 'utf8') }); return { requested: true, importCompleted: false }; }, ...options, ...overrides }).init(); mirrors.push(mirror); return mirror; };
  const mirror = await open();
  t.after(async () => { await Promise.allSettled(mirrors.map(value => value.close())); await vault.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  let number = 0;
  const save = async (extra = {}) => { const state = await vault.status(), index = ++number; return vault.save({ origin: `https://site${index}.test`, username: `person${index}`, password: `Fixture-password-${index},"line"\nnext`, requestId: `save-${index}`, ...extra }, context(state.revision)); };
  const queue = async (credentials, extra = {}) => { const status = await mirror.status(); return mirror.queue({ credentials: credentials.map(({ credentialId, revision }) => ({ credentialId, revision })), destination: 'chrome', requestId: `queue-${++number}`, ...extra }, context(status.revision)); };
  const begin = async (queued, extra = {}) => mirror.beginImport({ ids: queued.entries.map(entry => entry.id), requestId: `begin-${++number}`, ...extra }, context((await mirror.status()).revision));
  return { dataDir, security, vault, mirror, open, save, queue, begin, callbacks };
}

test('automatic copy is off by default; enabling it queues exact revisions durably without plaintext or native callbacks', async t => {
  const c = await fixture(t), first = await c.save(); let status = await c.mirror.status();
  assert.equal(status.settings.enabled, false); assert.deepEqual(status.entries, []); assert.deepEqual(c.callbacks, []);
  await c.mirror.configure({ enabled: true, destination: 'firefox' }, context(status.revision)); status = await c.mirror.status();
  assert.equal(status.entries.length, 1); assert.equal(status.entries[0].credentialId, first.credentialId); assert.equal(status.entries[0].state, 'pending'); assert.equal(status.entries[0].destination, 'firefox');
  assert.deepEqual(c.callbacks, []); await assert.rejects(fs.stat(c.mirror.exportRoot), { code: 'ENOENT' });
  const reopened = await c.open(); assert.equal((await reopened.status()).entries.length, 1);
  await c.vault.save({ credentialId: first.credentialId, revision: 1, origin: first.origin, username: first.username, password: 'Different-fixture-password', requestId: 'update' }, context(1));
  status = await c.mirror.status(); assert.deepEqual(status.entries.map(entry => [entry.credentialRevision, entry.state]), [[1, 'failed'], [2, 'pending']]);
  const bytes = await fs.readFile(c.mirror.store.file, 'utf8'); assert.ok(!bytes.includes(first.credentialId)); assert.ok(!bytes.includes('Different-fixture-password'));
});

test('local queue operations enforce CAS, exact revisions, known destinations and stable request IDs', async t => {
  const c = await fixture(t), first = await c.save(), input = { credentials: [{ credentialId: first.credentialId, revision: 1 }], destination: 'chrome', requestId: 'copy:stable' };
  await assert.rejects(c.mirror.queue(input, { expectedRevision: 0 }), { code: 'CREDENTIAL_LOCAL_ONLY' });
  const queued = await c.mirror.queue(input, context(0)); assert.equal(queued.entries[0].state, 'pending');
  assert.equal((await c.mirror.queue(input, context(0))).existing, true);
  await assert.rejects(c.mirror.queue({ ...input, destination: 'firefox' }, context(1)), { code: 'CREDENTIAL_MIRROR_REQUEST_CONFLICT' });
  await assert.rejects(c.mirror.queue({ ...input, requestId: 'stale' }, context(0)), { code: 'CREDENTIAL_MIRROR_REVISION_CONFLICT' });
  await assert.rejects(c.mirror.queue({ ...input, destination: 'arbitrary', requestId: 'invalid' }, context(1)), { code: 'CREDENTIAL_INVALID' });
  await assert.rejects(c.mirror.queue({ ...input, credentials: [{ credentialId: first.credentialId, revision: 2 }], requestId: 'badversion' }, context(1)), { code: 'CREDENTIAL_REVISION_CONFLICT' });
  assert.deepEqual(c.callbacks, []);
});

test('explicit handoff exports only selected credentials, preserves CSV escaping, and never labels an opened browser as imported', async t => {
  const c = await fixture(t), selected = await c.save(), excluded = await c.save(), queued = await c.queue([selected]), batch = await c.begin(queued);
  assert.equal(batch.state, 'awaiting_browser_import'); assert.equal(batch.count, 1); assert.equal(c.callbacks.length, 1);
  const handoff = c.callbacks[0]; assert.equal(handoff.destination, 'chrome'); assert.equal(handoff.batchId, batch.batchId); assert.match(handoff.csv, /^name,url,username,password\r\n/);
  assert.ok(handoff.csv.includes('"Fixture-password-1,""line""\nnext"')); assert.ok(!handoff.csv.includes(excluded.origin)); assert.ok(!handoff.csv.includes(excluded.username));
  assert.ok(!JSON.stringify(batch).includes(handoff.filePath)); assert.ok(!JSON.stringify(await c.mirror.status()).includes('Fixture-password'));
  assert.ok(!(await fs.readFile(c.mirror.store.file, 'utf8')).includes('Fixture-password'));
  if (process.platform !== 'win32') { assert.equal((await fs.stat(path.dirname(handoff.filePath))).mode & 0o077, 0); assert.equal((await fs.stat(handoff.filePath)).mode & 0o077, 0); }
  const confirmed = await c.mirror.confirm({ batchId: batch.batchId }, context(batch.revision)); assert.equal(confirmed.state, 'confirmed_by_user'); await assert.rejects(fs.stat(handoff.filePath), { code: 'ENOENT' });
  assert.equal((await c.mirror.status()).entries.find(entry => entry.credentialId === selected.credentialId).state, 'confirmed_by_user');
});

test('lost handoff responses and terminal retries never reopen the browser or reconstruct the CSV', async t => {
  const c = await fixture(t), selected = await c.save(), queued = await c.queue([selected]), input = { ids: queued.entries.map(entry => entry.id), requestId: 'handoff.same' };
  const batch = await c.mirror.beginImport(input, context(queued.revision));
  const retry = await c.mirror.beginImport(input, context(0)); assert.equal(retry.batchId, batch.batchId); assert.equal(retry.existing, true); assert.equal(c.callbacks.length, 1);
  await assert.rejects(c.mirror.beginImport({ ...input, ids: ['copy_other'] }, context(batch.revision)), { code: 'CREDENTIAL_MIRROR_REQUEST_CONFLICT' });
  const cancelled = await c.mirror.cancel({ batchId: batch.batchId }, context(batch.revision)); assert.equal(cancelled.state, 'cancelled');
  const terminal = await c.mirror.beginImport(input, context(0)); assert.equal(terminal.state, 'cancelled'); assert.equal(terminal.existing, true); assert.equal(c.callbacks.length, 1); await assert.rejects(fs.stat(c.callbacks[0].filePath), { code: 'ENOENT' });
  const newQueue = await c.queue([selected]); assert.notEqual(newQueue.entries[0].id, queued.entries[0].id); assert.equal(newQueue.entries[0].state, 'pending');
});

test('expired handoffs clean plaintext without another user action and cannot be confirmed afterward', async t => {
  // Allow real Windows filesystem work to finish under the concurrent suite
  // before exercising expiry. Production retains its five-minute deadline.
  const c = await fixture(t, { exportLifetimeMs: 2000 }), selected = await c.save(), batch = await c.begin(await c.queue([selected])), filename = c.callbacks[0].filePath;
  await waitForExportRemoval(filename);
  await assert.rejects(fs.stat(filename), { code: 'ENOENT' }); const status = await c.mirror.status(); assert.equal(status.batches[0].state, 'failed'); assert.equal(status.batches[0].error.code, 'CREDENTIAL_IMPORT_EXPIRED');
  await assert.rejects(c.mirror.confirm({ batchId: batch.batchId }, context(status.revision)), { code: 'CREDENTIAL_MIRROR_REVISION_CONFLICT' });
});

test('plaintext expiry still runs when the vault locks or protected encryption becomes unavailable for both stores', async t => {
  for (const unavailable of ['vault', 'both']) {
    const c = await fixture(t, { exportLifetimeMs: 2000 }), selected = await c.save(); await c.begin(await c.queue([selected])); const filename = c.callbacks[0].filePath;
    c.vault.store.isEncryptionAvailable = () => false;
    if (unavailable === 'both') c.mirror.store.isEncryptionAvailable = () => false;
    await waitForExportRemoval(filename);
    await assert.rejects(fs.stat(filename), { code: 'ENOENT' }); const locked = await c.mirror.status(); assert.equal(locked.available, false);
    c.vault.store.isEncryptionAvailable = () => true; c.mirror.store.isEncryptionAvailable = () => true;
    const restored = await c.mirror.status(); assert.equal(restored.batches[0].state, 'failed'); assert.equal(c.callbacks.length, 1);
  }
});

test('multiple export deadlines remain scheduled while all protected metadata is locked', async t => {
  const c = await fixture(t, { exportLifetimeMs: 2000 }); await c.begin(await c.queue([await c.save()]));
  c.mirror.exportLifetimeMs = 6000; await c.begin(await c.queue([await c.save()]));
  c.vault.store.isEncryptionAvailable = () => false; c.mirror.store.isEncryptionAvailable = () => false;
  await waitForExportRemoval(c.callbacks[0].filePath); assert.ok((await fs.stat(c.callbacks[1].filePath)).isFile());
  await waitForExportRemoval(c.callbacks[1].filePath); assert.equal(c.callbacks.length, 2);
});

test('failed or timed-out native callbacks remove plaintext and keep a durable generic failure, without leaking callback errors', async t => {
  for (const mode of ['throw', 'timeout']) {
    let filename; const c = await fixture(t, { handoffTimeoutMs: 40, beginImport: async value => { filename = value.filePath; assert.ok((await fs.readFile(filename, 'utf8')).includes('Fixture-password')); if (mode === 'throw') throw new Error('Fixture-password-private-native-error'); await new Promise(() => {}); } });
    const selected = await c.save(), queued = await c.queue([selected]); await assert.rejects(c.begin(queued), error => error.code === 'CREDENTIAL_IMPORT_HANDOFF_FAILED' && !error.message.includes('Fixture-password'));
    await assert.rejects(fs.stat(filename), { code: 'ENOENT' }); const status = await c.mirror.status(); assert.equal(status.batches[0].state, 'failed'); assert.ok(!JSON.stringify(status).includes('Fixture-password'));
  }
});

test('restart cleans interrupted exports without replay; a second live instance does not remove the first instance handoff', async t => {
  const c = await fixture(t), selected = await c.save(), batch = await c.begin(await c.queue([selected])), filename = c.callbacks[0].filePath;
  const second = await c.open(); assert.equal((await second.status()).batches[0].state, 'awaiting_browser_import'); assert.ok((await fs.stat(filename)).isFile());
  await second.close(); assert.ok((await fs.stat(filename)).isFile()); await c.mirror.close(); await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
  const restarted = await c.open(); assert.equal((await restarted.status()).batches.find(value => value.batchId === batch.batchId).state, 'failed'); assert.equal(c.callbacks.length, 1);
});

test('restart removes a dead-process plaintext export before attempting to unlock protected metadata', async t => {
  const c = await fixture(t); await c.begin(await c.queue([await c.save()])); const filename = c.callbacks[0].filePath, markerPath = path.join(path.dirname(filename), 'owner.json');
  const child = spawn(process.execPath, ['--eval', ''], { stdio: 'ignore' }), deadPid = child.pid; await once(child, 'exit');
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')); marker.pid = deadPid; marker.instanceId = randomUUID(); await fs.writeFile(markerPath, JSON.stringify(marker));
  const restarted = await c.open({ isEncryptionAvailable: () => false }); assert.equal((await restarted.status()).available, false);
  await assert.rejects(fs.stat(filename), { code: 'ENOENT' }); assert.equal(c.callbacks.length, 1);
});

test('Windows export requires a successful private-directory ACL before plaintext exists', async t => {
  const blocked = await fixture(t, { platform: 'win32', protectTemporaryDirectory: undefined }), selected = await blocked.save(), queued = await blocked.queue([selected]);
  assert.equal((await blocked.mirror.status()).capabilities.beginImport, false); await assert.rejects(blocked.begin(queued), { code: 'CREDENTIAL_MIRROR_UNAVAILABLE' }); await assert.rejects(fs.stat(blocked.mirror.exportRoot), { code: 'ENOENT' });
  let protectedDirectory;
  const permitted = await fixture(t, { platform: 'win32', protectTemporaryDirectory: async directory => { protectedDirectory = directory; assert.deepEqual((await fs.readdir(directory)).sort(), ['owner.json']); return { protected: true }; } });
  await permitted.begin(await permitted.queue([await permitted.save()])); assert.equal(path.dirname(permitted.callbacks[0].filePath), protectedDirectory);
  const rejected = await fixture(t, { platform: 'win32', protectTemporaryDirectory: async directory => { assert.deepEqual((await fs.readdir(directory)).sort(), ['owner.json']); return { protected: false }; } });
  await assert.rejects(rejected.begin(await rejected.queue([await rejected.save()])), { code: 'CREDENTIAL_EXPORT_PROTECTION' }); assert.deepEqual(rejected.callbacks, []); assert.deepEqual(await fs.readdir(rejected.mirror.exportRoot), []);
});

test('credential updates invalidate outstanding exports and deletion never imports an old selection', async t => {
  const c = await fixture(t), selected = await c.save(), queued = await c.queue([selected]);
  await c.vault.delete({ credentialId: selected.credentialId, revision: 1, requestId: 'delete' }, context(1));
  await assert.rejects(c.mirror.beginImport({ ids: queued.entries.map(entry => entry.id), requestId: 'stale-import' }, context(queued.revision)), { code: 'CREDENTIAL_REVISION_CONFLICT' }); assert.equal(c.callbacks.length, 0);
  const other = await c.save(), batch = await c.begin(await c.queue([other])), filename = c.callbacks[0].filePath;
  await c.vault.save({ origin: other.origin, username: other.username, credentialId: other.credentialId, revision: 1, password: 'updated-private-secret', requestId: 'update' }, context(3));
  const status = await c.mirror.status(); assert.equal(status.batches.find(value => value.batchId === batch.batchId).state, 'failed'); await assert.rejects(fs.stat(filename), { code: 'ENOENT' }); assert.equal(c.callbacks.length, 1);
});

test('corrupt encrypted queue stays unavailable without blocking vault use or replacing the damaged file', async t => {
  const c = await fixture(t); await c.queue([await c.save()]); await fs.writeFile(c.mirror.store.file, '{broken'); const status = await c.mirror.status();
  assert.equal(status.available, false); assert.equal(status.healthy, false); assert.equal(status.capabilities.beginImport, false); assert.equal(await fs.readFile(c.mirror.store.file, 'utf8'), '{broken'); assert.equal((await c.vault.status()).healthy, true);
  const reopened = await c.open(); assert.equal((await reopened.status()).healthy, false);
});
