import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createHarnessServer } from '../server.mjs';

class Runtime extends EventEmitter {
  status() { return { connected: false, authenticated: false, models: [] }; }
  async start() { return this.status(); } async close() {}
  async runAgent() { assert.fail('Credential management cannot start a provider'); }
}
class Desktop extends EventEmitter { status() { return { available: false, enabled: false }; } async setEnabled() { return this.status(); } }
const local = '/api/browser-credentials';
async function fixture(t, { encrypted = true, isEncryptionAvailable = () => true, openDestination } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-credentials-http-')), key = randomBytes(32), handoffs = [], revealed = [];
  const credentialStorage = encrypted ? {
    storageBackend: 'dpapi', // Injected AES test double; this is not native DPAPI evidence.
    isEncryptionAvailable,
    encryptSecret(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptSecret(value) { const raw = Buffer.from(value), decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12)); decipher.setAuthTag(raw.subarray(12, 28)); return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'); },
  } : {};
  const app = await createHarnessServer({ port: 0, dataDir: path.join(directory, 'data'), defaultCwd: path.join(directory, 'workspace'), runtime: new Runtime(), desktop: new Desktop(), autoAttachDesktop: false, remoteAccess: false, credentialStorage,
    protectCredentialTemporaryDirectory: async () => ({ protected: true }),
    browserCredentialDestinations: { async status() { return [{ id: 'chrome', name: 'Chrome fixture', available: true }]; }, async open(id, options) { assert.equal(options.source, 'user'); handoffs.push(id); return openDestination ? openDestination(id, options) : { requested: true, importCompleted: false }; }, async close() {} },
    revealCredentialImportFile: async filePath => { revealed.push(filePath); },
  });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  await app.learning.updateSettings({ mode: 'manual' });
  const url = await app.listen(), initial = await fetch(url), cookie = initial.headers.get('set-cookie').split(';')[0]; await initial.text();
  const request = (route = local, { method = 'GET', body, headers = {} } = {}) => fetch(url + route, { method, headers: { Cookie: cookie, ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const post = (route, body) => request(local + route, { method: 'POST', body });
  return { app, directory, url, request, post, handoffs, revealed };
}

async function credentialJob(f, name, args) {
  // Exercise the production direct executor with its existing local owner.
  const client = { id: 'local-browser-tools', kind: 'local-browser', label: 'Credential fixture', scopes: ['read', 'browser:read', 'browser:write'] };
  const admitted = await f.app.directExecution.call(name, args, client);
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = await f.app.directExecution.getJob(admitted.jobId, client);
    if (job.settled) return job;
    assert.notEqual(job.status, 'awaiting_input');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('The credential action did not settle.');
}

test('password-manager routes require local session, reject remote/cross-origin access and URL parameters', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.url + local)).status, 401);
  for (const headers of [{ 'x-blackice-remote': '1' }, { Origin: 'https://example.invalid' }]) assert.equal((await f.request(local, { headers })).status, 403);
  assert.equal((await f.request(local + '?password=ignored')).status, 400);
  for (const body of [null, [], { source: 'user' }, { expectedRevision: 0, password: 'fixture', executable: 'bad' }]) assert.equal((await f.post('/save', body)).status, 400);
  assert.equal((await (await f.request()).json()).vault.entries.length, 0);
  assert.equal(f.handoffs.length, 0);
});

test('local save is encrypted, secret-free in responses, revision guarded and idempotent after a lost response', async t => {
  const f = await fixture(t), password = 'HTTP-only-fixture-Secret-9342';
  const input = { origin: 'https://example.test', username: 'owned@example.test', password, expectedRevision: 0, requestId: 'local-save.1' };
  const response = await f.post('/save', input); assert.equal(response.status, 200); const saved = await response.json();
  assert.ok(saved.credentialId); assert.doesNotMatch(JSON.stringify(saved), new RegExp(password));
  const retry = await (await f.post('/save', input)).json(); assert.equal(retry.credentialId, saved.credentialId); assert.equal(retry.existing, true);
  const state = await (await f.request()).json(); assert.equal(state.vault.entries.length, 1); assert.equal(state.vault.revision, 1); assert.ok(!JSON.stringify(state).includes(password));
  assert.ok(!(await readFile(f.app.browserCredentials.store.file, 'utf8')).includes(password));
  const stale = await f.post('/save', { ...input, requestId: 'other-save', username: 'other' }); assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'CREDENTIAL_REVISION_CONFLICT');
  assert.equal(f.handoffs.length, 0);
});

test('selected browser copy creates one temporary native handoff and user confirmation removes its file', async t => {
  const f = await fixture(t);
  const saved = await (await f.post('/save', { origin: 'https://example.test', username: 'owned', password: 'import-only-fixture-ABC123', expectedRevision: 0, requestId: 'save-import' })).json();
  let state = await (await f.request()).json();
  const queuedResponse = await f.post('/mirror/queue', { credentials: [{ credentialId: saved.credentialId, revision: saved.revision }], destination: 'chrome', requestId: 'queue-import', expectedRevision: state.mirror.revision }); assert.equal(queuedResponse.status, 200);
  state = await (await f.request()).json(); const ids = state.mirror.entries.map(entry => entry.id);
  const input = { ids, requestId: 'begin-import', expectedRevision: state.mirror.revision };
  const begunResponse = await f.post('/mirror/begin', input); assert.equal(begunResponse.status, 200); const begun = await begunResponse.json();
  assert.equal(begun.state, 'awaiting_browser_import'); assert.equal(f.handoffs.length, 1); assert.ok(!JSON.stringify(begun).includes('import-only-fixture'));
  assert.equal((await (await f.post('/mirror/begin', input)).json()).batchId, begun.batchId); assert.equal(f.handoffs.length, 1);
  state = await (await f.request()).json();
  const confirmation = await f.post('/mirror/confirm', { batchId: begun.batchId, expectedRevision: state.mirror.revision }); assert.equal(confirmation.status, 200);
  state = await (await f.request()).json(); assert.equal(state.mirror.batches[0].state, 'confirmed_by_user'); assert.notEqual(state.mirror.batches[0].state, 'verified');
  await assert.rejects(readFile(f.app.browserCredentialMirror.paths(begun.batchId).filePath), { code: 'ENOENT' });
});

test('missing protected storage preserves the public catalog and credential actions report unavailable', async t => {
  const f = await fixture(t, { encrypted: false }), healthy = await fixture(t), state = await (await f.request()).json();
  assert.equal(state.vault.available, false); assert.equal((await f.request('/api/status')).status, 200);
  const catalog = healthy.app.chatGPTConnector.tools(), fingerprint = healthy.app.chatGPTConnector.catalogStatus();
  assert.deepEqual(catalog.filter(tool => tool.name.startsWith('blackice_credentials_')).map(tool => tool.name), ['blackice_credentials_list', 'blackice_credentials_generate', 'blackice_credentials_fill']);
  assert.deepEqual(f.app.chatGPTConnector.tools(), catalog);
  assert.deepEqual(f.app.chatGPTConnector.catalogStatus(), fingerprint);
  assert.equal(f.app.chatGPTConnector.instructions(), healthy.app.chatGPTConnector.instructions());
  const origin = 'https://example.test';
  for (const [action, extra] of [['list', {}], ['generate', { username: 'owned' }], ['fill', { credentialId: 'credential_fixture', revision: 1, browser: 'relay', tabId: 'fixture', expectedUrl: origin + '/login', expectedDocumentId: 'fixture:1', passwordRef: 'password-ref' }]]) {
    const job = await credentialJob(f, 'blackice_credentials_' + action, { origin, requestId: 'unavailable_' + action, ...extra });
    assert.equal(job.status, 'failed'); assert.equal(job.interaction, null); assert.equal(job.result.success, false);
    assert.equal(JSON.parse(job.result.text.text).code, 'BROWSER_CREDENTIAL_UNAVAILABLE');
  }
  assert.deepEqual(f.app.chatGPTConnector.tools(), catalog);
  assert.deepEqual(f.app.chatGPTConnector.catalogStatus(), fingerprint);
  const result = await f.post('/save', { origin: 'https://example.test', username: 'owned', password: 'fixture', expectedRevision: 0, requestId: 'unavailable' });
  assert.equal(result.status, 503); assert.equal(f.handoffs.length, 0);
});

test('credential storage can recover after startup without changing the public catalog', async t => {
  let available = false;
  const f = await fixture(t, { isEncryptionAvailable: () => available }), catalog = f.app.chatGPTConnector.tools(), fingerprint = f.app.chatGPTConnector.catalogStatus();
  assert.equal((await (await f.request()).json()).vault.available, false);
  assert.equal(catalog.filter(tool => tool.name.startsWith('blackice_credentials_')).length, 3);
  const before = await credentialJob(f, 'blackice_credentials_list', { origin: 'https://example.test', requestId: 'before_recovery' });
  assert.equal(before.status, 'failed'); assert.equal(JSON.parse(before.result.text.text).code, 'BROWSER_CREDENTIAL_UNAVAILABLE');
  available = true;
  assert.equal((await (await f.request()).json()).vault.available, true);
  const recovered = await credentialJob(f, 'blackice_credentials_list', { origin: 'https://example.test', requestId: 'after_recovery' });
  assert.equal(recovered.status, 'succeeded'); assert.deepEqual(JSON.parse(recovered.result.text.text).credentials, []);
  assert.deepEqual(f.app.chatGPTConnector.tools(), catalog); assert.deepEqual(f.app.chatGPTConnector.catalogStatus(), fingerprint);
  available = false;
  const unavailable = await credentialJob(f, 'blackice_credentials_list', { origin: 'https://example.test', requestId: 'unavailable_again' });
  assert.equal(unavailable.status, 'failed'); assert.equal(JSON.parse(unavailable.result.text.text).code, 'BROWSER_CREDENTIAL_UNAVAILABLE');
  assert.deepEqual(f.app.chatGPTConnector.tools(), catalog); assert.deepEqual(f.app.chatGPTConnector.catalogStatus(), fingerprint);
  assert.equal(f.handoffs.length, 0);
});

for (const interruptedBy of ['cancellation', 'maintenance']) test(`a late browser-open receipt after ${interruptedBy} cannot reveal a deleted import file`, async t => {
  let entered, release;
  const opening = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { openDestination: async () => { entered(); await held; return { requested: true, importCompleted: false }; } });
  t.after(() => release());
  const saved = await f.app.browserCredentials.save({ origin: 'https://example.test', username: 'owned', password: 'late-open-fixture-secret', requestId: 'save-late-open' }, { source: 'user', expectedRevision: 0 });
  const state = await f.app.browserCredentialMirror.status();
  const queued = await f.app.browserCredentialMirror.queue({ credentials: [{ credentialId: saved.credentialId, revision: saved.revision }], destination: 'chrome', requestId: 'queue-late-open' }, { source: 'user', expectedRevision: state.revision });
  const controller = new AbortController();
  const pending = f.app.browserCredentialMirror.beginImport({ ids: queued.entries.map(entry => entry.id), requestId: 'begin-late-open' }, { source: 'user', expectedRevision: queued.revision, signal: controller.signal }).then(() => ({ succeeded: true }), () => ({ succeeded: false }));
  await opening;
  if (interruptedBy === 'cancellation') controller.abort(); else await f.app.beginMaintenance();
  release();
  assert.equal((await pending).succeeded, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.handoffs.length, 1); assert.deepEqual(f.revealed, []);
  f.app.endMaintenance();
  const after = await f.app.browserCredentialMirror.status();
  assert.equal(after.batches.length, 1);
  await assert.rejects(readFile(f.app.browserCredentialMirror.paths(after.batches[0].batchId).filePath), { code: 'ENOENT' });
});

test('maintenance prevents a credential mutation and both static manager assets are served', async t => {
  const f = await fixture(t);
  for (const asset of ['/browser-credentials-ui.mjs', '/browser-credentials.css']) { const response = await f.request(asset); assert.equal(response.status, 200); await response.text(); }
  await f.app.beginMaintenance();
  const response = await f.post('/save', { origin: 'https://example.test', username: 'owned', password: 'fixture', expectedRevision: 0, requestId: 'maintenance' });
  assert.equal(response.status, 503); f.app.endMaintenance();
  assert.equal((await (await f.request()).json()).vault.entries.length, 0);
});
