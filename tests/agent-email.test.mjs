import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentEmailStore, runEmailCli } from '../lib/agent-email.mjs';
import { EMAIL_TOOL, createEmailToolHandler } from '../lib/email-tools.mjs';

const fixture = fileURLToPath(new URL('./fixtures/email-cli.mjs', import.meta.url));
const fixtureRunner = (mode = 'ok', calls = []) => async input => {
  calls.push({ executable: input.executable, cwd: input.cwd, args: [...input.args] });
  return runEmailCli({ ...input, executable: process.execPath, args: [fixture, mode, ...input.args] });
};
async function setup(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-email-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'fixture.toml');
  await fs.writeFile(configPath, '# no credentials, no account transport\n');
  const calls = [];
  const store = await new AgentEmailStore({ dataDir: directory, runner: options.runner || fixtureRunner(options.mode || 'ok', calls) }).init();
  t.after(() => store.close());
  return { directory, configPath, calls, store, config: { enabled: true, executable: process.execPath, configPath, account: 'fixture' } };
}

test('email init, settings and status do not launch a process or claim an account works', async t => {
  const { store, calls, config } = await setup(t);
  assert.equal(store.status().state, 'not_configured');
  assert.deepEqual(store.status().storage, { healthy: true, readOnly: false, recoveryRequired: false, error: null });
  await store.configure(config, { expectedRevision: 0 });
  assert.equal(calls.length, 0);
  assert.equal(store.status().state, 'configured');
  assert.equal(store.status().ready, false);
  assert.equal(store.status().account.observed, false);
  assert.equal(store.status().capabilities.send, false);
  await assert.rejects(store.list(), { code: 'EMAIL_CLI_UNCHECKED' });
  await assert.rejects(store.configure({ enabled: false }, { expectedRevision: 0 }), { code: 'EMAIL_REVISION_CONFLICT' });
  await store.writeChain; // A handled request conflict must not poison maintenance's drain.
});

test('unreadable saved email state is preserved and cannot be overwritten or mistaken for a fresh account', async t => {
  const { store, calls, config, directory } = await setup(t);
  await store.configure(config);
  const input = { requestId: 'preserved-draft', to: ['fixture@example.test'], subject: 'Keep this draft', body: 'An existing local draft remains on disk.' };
  const draft = await store.draft(input), stateFile = store.filename;
  const original = await fs.readFile(stateFile), eml = await fs.readFile(draft.path);
  await store.close();
  const damaged = Buffer.from('{"schema":1,"private-fixture-marker":"do not echo",');
  await fs.writeFile(stateFile, damaged);
  const names = await fs.readdir(path.dirname(stateFile));
  const unavailable = await new AgentEmailStore({ dataDir: directory, runner: fixtureRunner('ok', calls) }).init();
  t.after(() => unavailable.close());
  const snapshot = unavailable.snapshot();
  assert.equal(snapshot.state, 'unavailable'); assert.equal(snapshot.storage.healthy, false); assert.equal(snapshot.storage.recoveryRequired, true); assert.equal(snapshot.storage.readOnly, true);
  assert.equal(snapshot.config, null); assert.equal(snapshot.revision, null); assert.equal(snapshot.localDrafts, null);
  assert.equal(snapshot.configured, false); assert.equal(snapshot.enabled, false); assert.equal(snapshot.ready, false);
  assert.equal(snapshot.cli.checked, false); assert.equal(snapshot.account.observed, false);
  assert.ok(Object.values(snapshot.capabilities).every(value => value === false));
  assert.equal(snapshot.lastError.code, 'EMAIL_STORAGE'); assert.doesNotMatch(JSON.stringify(snapshot), /private-fixture-marker|do not echo/);
  assert.throws(() => unavailable.listDrafts(), { code: 'EMAIL_STORAGE', status: 503 });
  assert.throws(() => unavailable.getDraft(draft.id), { code: 'EMAIL_STORAGE', status: 503 });
  for (const operation of [
    () => unavailable.configure({ enabled: false }, { expectedRevision: 0 }),
    () => unavailable.draft({ ...input, requestId: 'cannot-replace-draft' }),
    () => unavailable.check(), () => unavailable.list(), () => unavailable.read({ id: 'fixture-message' }),
    () => unavailable.execute(['--version']), () => unavailable.save({ schema: 1, revision: 0, config: {}, drafts: [] }),
  ]) await assert.rejects(operation, { code: 'EMAIL_STORAGE', status: 503 });
  const handler = createEmailToolHandler({ store: unavailable });
  const statusResult = await handler({ name: EMAIL_TOOL.name, arguments: { action: 'status' } });
  assert.equal(statusResult.success, true); assert.equal(JSON.parse(statusResult.contentItems[0].text).storage.healthy, false);
  const draftsResult = await handler({ name: EMAIL_TOOL.name, arguments: { action: 'drafts' } });
  assert.equal(draftsResult.success, false); assert.equal(JSON.parse(draftsResult.contentItems[0].text).code, 'EMAIL_STORAGE');
  await unavailable.writeChain; await unavailable.close();
  assert.equal(calls.length, 0, 'storage failure cannot trigger a client process or account check');
  assert.deepEqual(await fs.readFile(stateFile), damaged); assert.deepEqual(await fs.readFile(draft.path), eml);
  assert.deepEqual(await fs.readdir(path.dirname(stateFile)), names, 'no reset, renamed backup, or replacement draft was written');
  await fs.writeFile(stateFile, original);
  const recovered = await new AgentEmailStore({ dataDir: directory, runner: fixtureRunner('ok', calls) }).init();
  t.after(() => recovered.close());
  assert.equal(recovered.status().storage.healthy, true); assert.equal(recovered.snapshot().config.account, config.account);
  assert.equal(recovered.getDraft(draft.id).body, input.body); assert.equal(recovered.status().cli.checked, false);
  assert.equal(calls.length, 0, 'restoring local state still does not verify or contact an account');
});

test('invalid saved schemas and inaccessible email storage paths are isolated without replacing them', async t => {
  for (const kind of ['schema', 'state-directory', 'parent-file']) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-email-unavailable-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const emailDirectory = path.join(directory, 'agent-email'), filename = path.join(emailDirectory, 'state.json');
    if (kind === 'parent-file') await fs.writeFile(emailDirectory, 'preserve a conflicting file');
    else {
      await fs.mkdir(emailDirectory);
      if (kind === 'state-directory') await fs.mkdir(filename);
      else await fs.writeFile(filename, JSON.stringify({ schema: 99, revision: 0, config: {}, drafts: [] }));
    }
    const store = await new AgentEmailStore({ dataDir: directory, runner: async () => assert.fail('Unavailable storage cannot launch a CLI.') }).init();
    t.after(() => store.close());
    assert.equal(store.status().storage.healthy, false, kind);
    await assert.rejects(() => store.configure({ enabled: false }), { code: 'EMAIL_STORAGE' });
    if (kind === 'parent-file') assert.equal(await fs.readFile(emailDirectory, 'utf8'), 'preserve a conflicting file');
    else if (kind === 'state-directory') assert.equal((await fs.stat(filename)).isDirectory(), true);
    else assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).schema, 99);
  }
});

test('a CLI check is limited to local version/help, with no account arguments', async t => {
  const { store, calls, config } = await setup(t);
  await store.configure(config);
  const snapshot = await store.check();
  assert.deepEqual(calls.map(call => call.args), [['--version'], ['envelope', 'list', '--help'], ['message', 'read', '--help'], ['envelope', 'search', '--help'], ['mailbox', 'list', '--help']]);
  assert.equal(snapshot.state, 'cli_checked');
  assert.equal(snapshot.cli.version, '2.2.1');
  assert.equal(snapshot.account.observed, false);
  assert.equal(snapshot.ready, false);
});

test('unsupported CLI versions and missing preview commands fail closed', async t => {
  for (const mode of ['unsupported', 'no-preview']) {
    const { store, config } = await setup(t, { mode });
    await store.configure(config);
    await assert.rejects(store.check(), { code: 'EMAIL_CLI_UNSUPPORTED' });
    assert.equal(store.status().cli.checked, false);
    assert.equal(store.status().capabilities.read, false);
  }
});

test('list/search preserve exact argument boundaries and read uses non-marking preview', async t => {
  const { store, config, configPath } = await setup(t);
  await store.configure(config);
  await store.check();
  const query = 'subject "literal $(echo never) ; & \\ value"';
  const result = await store.list({ folder: '-strange folder', query, limit: 1, page: 2 });
  assert.equal(result.messages[0].receivedQuery, query);
  assert.equal(result.messages[0].receivedCwd, path.dirname(configPath));
  assert.ok(result.messages[0].receivedArgs.includes('--config=./fixture.toml'));
  assert.ok(!result.messages[0].receivedArgs.includes(`--config=${configPath}`));
  assert.ok(result.messages[0].receivedArgs.includes('--mailbox=-strange folder'));
  assert.equal(result.messages[0].receivedArgs.at(-2), '--');
  assert.equal(result.mayHaveMore, true);
  assert.equal(result.queued, 0);
  assert.equal(result.indexingPending, false);
  assert.equal(result.messages[0].from[0].email, 'fixture@example.invalid');
  assert.equal(store.status().account.operation, 'search');
  const message = await store.read({ id: '42', folder: '-strange folder' });
  assert.equal(message.preview, true);
  assert.match(message.message, /harmless fixture body/);
  assert.equal(store.status().state, 'account_observed');
  const opaque = await store.read({ id: 'opaque:AAMkAG-node_42=', folder: '-strange folder' });
  assert.equal(opaque.id, 'opaque:AAMkAG-node_42=');
  await assert.rejects(store.read({ id: 'bad\nidentifier' }), { code: 'EMAIL_INVALID' });
});

test('invalid JSON never becomes successful account evidence', async t => {
  const { store, config } = await setup(t, { mode: 'bad-json' });
  await store.configure(config);
  await store.check();
  await assert.rejects(store.list(), { code: 'EMAIL_PROTOCOL' });
  assert.equal(store.status().account.observed, false);
});

test('the v2 envelope object preserves queued indexing work and rejects v1 bare arrays', async t => {
  const indexing = await setup(t, { mode: 'indexing' });
  await indexing.store.configure(indexing.config); await indexing.store.check();
  const result = await indexing.store.list();
  assert.equal(result.queued, 3);
  assert.equal(result.indexingPending, true);
  const legacy = await setup(t, { mode: 'legacy-array' });
  await legacy.store.configure(legacy.config); await legacy.store.check();
  await assert.rejects(legacy.store.list(), { code: 'EMAIL_PROTOCOL' });
  assert.equal(legacy.store.status().account.observed, false);
});

test('raw reads require the observed v2 message object and reject a bare string', async t => {
  const { store, config } = await setup(t, { mode: 'legacy-read-string' });
  await store.configure(config); await store.check();
  await assert.rejects(store.read({ id: 'fixture.message.id' }), { code: 'EMAIL_PROTOCOL' });
  assert.equal(store.status().account.observed, false);
});

test('drafts persist as local MIME artifacts and retry IDs deduplicate without running a client', async t => {
  const { store, calls, directory } = await setup(t);
  const input = { requestId: 'draft-one', to: ['iris@example.invalid'], subject: 'Résumé ✓', body: 'Line one\nLine two — still unsent.' };
  const [first, duplicate] = await Promise.all([store.draft(input), store.draft(input)]);
  assert.equal(first.id, duplicate.id);
  assert.equal(duplicate.duplicate, true);
  assert.equal(first.sent, false);
  assert.equal(calls.length, 0);
  const bytes = await fs.readFile(first.path, 'utf8');
  assert.match(bytes, /X-Unsent: 1\r\n/);
  assert.match(bytes, /Subject: =\?UTF-8\?B\?/);
  const decodedBody = Buffer.from(bytes.split('\r\n\r\n')[1].replace(/\s/g, ''), 'base64').toString('utf8');
  assert.equal(decodedBody, input.body);
  await assert.rejects(store.draft({ ...input, body: 'different' }), { code: 'EMAIL_DRAFT_CONFLICT' });
  const reloaded = await new AgentEmailStore({ dataDir: directory, runner: fixtureRunner() }).init();
  t.after(() => reloaded.close());
  assert.equal(reloaded.getDraft(first.id).body, input.body);
  assert.equal(reloaded.snapshot().drafts.length, 1);
  assert.equal(reloaded.status().cli.checked, false);
  assert.equal(reloaded.status().account.observed, false);
});

test('draft headers reject CRLF injection and unsupported actions cannot send', async t => {
  const { store, calls } = await setup(t);
  assert.throws(() => store.draft({ to: ['alice@example.invalid\r\nBcc:other@example.invalid'], body: 'x' }), { code: 'EMAIL_INVALID' });
  assert.throws(() => store.draft({ to: ['alice@example.invalid'], subject: 'Hi\nBcc:other@example.invalid' }), { code: 'EMAIL_INVALID' });
  const handler = createEmailToolHandler({ store, schemaVersion: 1 });
  const response = await handler({ name: EMAIL_TOOL.name, arguments: { action: 'send', to: ['alice@example.invalid'], body: 'x' } });
  assert.equal(response.success, false);
  assert.equal(calls.length, 0);
});

test('real subprocess timeout and cancellation are bounded and stderr is never exposed', async () => {
  const start = Date.now();
  await assert.rejects(runEmailCli({ executable: process.execPath, args: [fixture, 'hang'], timeoutMs: 80 }), { code: 'EMAIL_TIMEOUT' });
  assert.ok(Date.now() - start < 2000);
  const controller = new AbortController();
  const result = runEmailCli({ executable: process.execPath, args: [fixture, 'hang'], timeoutMs: 5000, signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { code: 'ABORT_ERR' });
  await assert.rejects(runEmailCli({ executable: process.execPath, args: [fixture, 'oversized'], maxOutputBytes: 100, timeoutMs: 5000 }), { code: 'EMAIL_OUTPUT_LIMIT' });
  await assert.rejects(runEmailCli({ executable: process.execPath, args: [fixture, 'failed'] }), error => error.code === 'EMAIL_CLIENT_FAILED' && !error.message.includes('PRIVATE') && !error.message.includes('token='));
});

test('reconfiguration retires CLI evidence and does not run account commands', async t => {
  const { store, calls, config } = await setup(t);
  await store.configure(config); await store.check();
  const before = calls.length;
  await store.configure({ account: 'different-account' });
  assert.equal(calls.length, before);
  assert.equal(store.status().cli.checked, false);
  assert.equal(store.status().account.observed, false);
  await assert.rejects(store.list(), { code: 'EMAIL_CLI_UNCHECKED' });
});
