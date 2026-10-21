import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserWorkspace, BROWSER_ACTIONS } from '../lib/browser.mjs';
import { BROWSER_CREDENTIAL_TOOL, createBrowserCredentialToolHandler, createDirectBrowserCredentialTools } from '../lib/browser-credential-tools.mjs';
import { DirectExecutionAPI } from '../lib/direct-execution-api.mjs';

const origin = 'https://login.example.test', password = 'OwnedFixtureOnly-S3cr3t!';
const entry = { credentialId: 'credential_fixture', revision: 1, origin, username: 'owned@example.test', label: 'Owned login', source: 'generated' };
const target = { browser: 'relay', tabId: 'ordinary', credentialId: entry.credentialId, revision: 1, origin, expectedUrl: origin + '/signup', expectedDocumentId: 'ordinary:1', passwordRef: 'password-ref' };
const receipt = result => JSON.parse(result.contentItems[0].text);
const held = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function vaultFixture() {
  const requests = new Map(), generated = [], opened = [];
  return { generated, opened, async status() { return { available: true, healthy: true }; }, async list({ origin: requested }) { return requested === origin ? [{ ...entry, password }] : []; },
    async generate(args, options) { await options.beforeCommit?.({ signal: options.signal }); const key = options.ownerId + '/' + args.requestId, digest = JSON.stringify(args), previous = requests.get(key); if (previous && previous.digest !== digest) throw Error('request conflict'); if (!previous) { generated.push({ args, ownerId: options.ownerId }); requests.set(key, { digest, value: { ...entry, origin: args.origin, username: args.username, password } }); } return { ...requests.get(key).value, vaultRevision: 1, existing: Boolean(previous) }; },
    async withSecret(request, callback, { signal } = {}) { assert.deepEqual(request, { credentialId: entry.credentialId, revision: 1, origin }); if (signal?.aborted) throw Error('cancelled'); opened.push(request); return callback({ ...entry, password }); },
  };
}
function browserFixture(t, { prepare, perform, url = target.expectedUrl, purpose } = {}) {
  const commits = [], status = { available: true, contained: true, tabs: [{ tabId: 'ordinary', browser: 'relay', url, ...(purpose ? { purpose } : {}) }], activeTab: 'ordinary' };
  const driver = { status: () => status, perform: perform || (async () => ({ tabId: 'ordinary' })), async prepareCredentialFill(args, options) { if (prepare) return prepare(args, options); return async secret => { commits.push({ args, secret }); return { filled: true, password }; }; } };
  const browser = new BrowserWorkspace({ driver }); t.after(() => browser.close()); return { browser, status, commits, driver };
}

test('credential generation returns durable opaque metadata and stable retry identity, never password text', async () => {
  const vault = vaultFixture(), events = [], handler = createBrowserCredentialToolHandler({ vault, ownerId: 'task:trusted-node', onEvent: event => events.push(event) });
  const args = { action: 'generate', origin, username: entry.username, requestId: 'owned_signup' };
  const first = await handler({ name: BROWSER_CREDENTIAL_TOOL.name, arguments: args });
  const again = await handler({ name: BROWSER_CREDENTIAL_TOOL.name, arguments: JSON.stringify(args) });
  assert.equal(first.success, true); assert.equal(receipt(first).saved, true); assert.equal(receipt(first).passwordReturned, false);
  assert.equal(receipt(again).existing, true); assert.equal(vault.generated.length, 1); assert.match(vault.generated[0].ownerId, /^tool_[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify([first, again, events]), new RegExp(password));
  const conflict = await handler({ name: BROWSER_CREDENTIAL_TOOL.name, arguments: { ...args, username: 'another' } });
  assert.equal(conflict.success, false); assert.equal(vault.generated.length, 1);
});

test('lookup is limited to an exact HTTPS origin and strips undeclared secret fields', async () => {
  const handler = createBrowserCredentialToolHandler({ vault: vaultFixture(), ownerId: 'trusted' });
  const result = await handler({ name: BROWSER_CREDENTIAL_TOOL.name, arguments: { action: 'list', origin } });
  assert.deepEqual(receipt(result).credentials, [entry]); assert.doesNotMatch(JSON.stringify(result), new RegExp(password));
  for (const args of [{ action: 'list' }, { action: 'list', origin: 'http://login.example.test' }, { action: 'list', origin: origin + '/' }, { action: 'list', origin, ownerId: 'forged' }, { action: 'generate', origin, requestId: 'x', password }, { action: 'generate', origin, requestId: 'x', length: 15 }]) assert.equal((await handler({ name: BROWSER_CREDENTIAL_TOOL.name, arguments: args })).success, false);
});

test('metadata is withheld if a direct grant is revoked while the vault read waits', async () => {
  const gate = held(), entered = held(), base = vaultFixture(); let authorized = true;
  const vault = { ...base, async list(args) { entered.resolve(); await gate.promise; return base.list(args); } };
  const handler = createBrowserCredentialToolHandler({ vault, ownerId: 'trusted', beforeDispatch: () => { if (!authorized) throw Error('Grant revoked'); } });
  const pending = handler({ name: BROWSER_CREDENTIAL_TOOL.name, arguments: { action: 'list', origin } });
  await entered.promise; authorized = false; gate.resolve(); const result = await pending;
  assert.equal(result.success, false); assert.doesNotMatch(JSON.stringify(result), /credential_fixture|owned@example/);
});

test('the credential method is host-only and validates every handle before opening the vault', async t => {
  const vault = vaultFixture(), { browser, commits } = browserFixture(t);
  assert.equal(BROWSER_ACTIONS.includes('fillCredential'), false);
  for (const extra of [{ password }, { source: 'user' }, { origin: 'https://other.example.test' }, { expectedUrl: origin + '.attacker.test/' }, { revision: 0 }, { confirmationRef: target.passwordRef }, { browser: 'firefox' }]) await assert.rejects(browser.fillCredential({ ...target, ...extra }, { vault }));
  await assert.rejects(browser.fillCredential(target, { vault, source: 'user' }));
  assert.equal(vault.opened.length, 0); assert.equal(commits.length, 0);
  const result = await browser.fillCredential(target, { vault });
  assert.equal(result.filled, true); assert.equal(result.submissionRequested, false); assert.equal(commits.length, 1); assert.equal(commits[0].secret.password, password);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(password)); assert.equal(result.frames, undefined);
});

test('reserved human ChatGPT tabs and failed field preflight never decrypt a credential', async t => {
  const vault = vaultFixture(), reserved = browserFixture(t, { purpose: 'chat-mode' });
  await assert.rejects(reserved.browser.fillCredential(target, { vault }), { code: 'BROWSER_HUMAN_CHAT_RESERVED' });
  const hidden = browserFixture(t, { prepare: async () => { throw Error('Hidden password: ' + password); } });
  await assert.rejects(hidden.browser.fillCredential(target, { vault }), error => error.code === 'BROWSER_CREDENTIAL_TARGET_CHANGED' && !error.message.includes(password));
  assert.equal(vault.opened.length, 0);
});

test('queued credential fill rechecks the grant and exact target before decrypting', async t => {
  const gate = held(), entered = held(), vault = vaultFixture(); let authorized = true;
  const f = browserFixture(t, { perform: async () => { entered.resolve(); await gate.promise; return { tabId: 'ordinary' }; } });
  const first = f.browser.perform({ action: 'snapshot', browser: 'relay', tabId: 'ordinary' }); await entered.promise;
  const filling = f.browser.fillCredential(target, { vault, beforeDispatch: () => { if (!authorized) throw Error('Revoked scope'); } });
  authorized = false; gate.resolve(); await first; await assert.rejects(filling, /Revoked scope/);
  assert.equal(vault.opened.length, 0); assert.equal(f.commits.length, 0);
  f.status.tabs[0].url = origin + '/changed'; await assert.rejects(f.browser.fillCredential(target, { vault }), { code: 'BROWSER_CREDENTIAL_TARGET_CHANGED' });
  assert.equal(vault.opened.length, 0);
});

test('authorization is checked again after waiting for the vault and page errors cannot echo secrets', async t => {
  const gate = held(), entered = held(), base = vaultFixture(); let authorized = true;
  const vault = { ...base, async withSecret(args, callback, options) { entered.resolve(); await gate.promise; return base.withSecret(args, callback, options); } };
  const f = browserFixture(t);
  const filling = f.browser.fillCredential(target, { vault, beforeDispatch: () => { if (!authorized) throw Error('Scope narrowed'); } });
  await entered.promise; authorized = false; gate.resolve(); await assert.rejects(filling, /Scope narrowed/); assert.equal(f.commits.length, 0);
  const broken = browserFixture(t, { prepare: async () => async () => { throw Error('Page leaked ' + password); } });
  const handler = createBrowserCredentialToolHandler({ vault: base, browser: broken.browser, ownerId: 'trusted' });
  const result = await handler({ name: BROWSER_CREDENTIAL_TOOL.name, arguments: { action: 'fill', ...target } });
  assert.equal(result.success, false); assert.doesNotMatch(JSON.stringify(result), new RegExp(password));
});

test('direct credential adapters execute under granted scopes with durable safe arguments and fresh authorization', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-credential-direct-')); await mkdir(path.join(directory, 'work'));
  const vault = vaultFixture(), { browser } = browserFixture(t), authorization = [], client = { id: 'grant_owned', label: 'Owned caller', scopes: ['read', 'browser:read', 'browser:write'] };
  let api;
  const tools = createDirectBrowserCredentialTools({ vault, browser, reauthorize: async (who, { scopes, signal }) => { authorization.push(scopes); await api.require(who, scopes); assert.equal(signal?.aborted, false); } });
  api = await new DirectExecutionAPI({ dataDir: directory, allowedRoot: path.join(directory, 'work'), browser, additionalTools: tools }).init();
  t.after(async () => { await api.close(); await rm(directory, { recursive: true, force: true }); });
  const args = { origin, username: entry.username, requestId: 'direct_signup' };
  const pending = await api.call('blackice_credentials_generate', args, client);
  assert.notEqual(pending.status, 'awaiting_input'); assert.equal(pending.interaction, null);
  const deadline = Date.now() + 5000; let job;
  do { job = await api.getJob(pending.jobId, client); if (job.settled) break; await new Promise(resolve => setTimeout(resolve, 5)); } while (Date.now() < deadline);
  assert.equal(job.status, 'succeeded'); assert.equal(vault.generated.length, 1);
  assert.ok(authorization.length >= 3); assert.ok(authorization.every(scopes => scopes.join() === 'browser:write'));
  assert.doesNotMatch(JSON.stringify(job), new RegExp(password));
  const same = await api.call('blackice_credentials_generate', args, client); assert.equal(same.jobId, pending.jobId); assert.equal(same.existing, true);
  const ledger = await readFile(api.jobs.file(pending.jobId), 'utf8'); assert.ok(!ledger.includes(password));
  assert.equal(tools.find(tool => tool.definition.name.endsWith('_list')).definition.scope, 'browser:read');
  await assert.rejects(api.call('blackice_credentials_fill', { requestId: 'denied_fill', ...target }, { ...client, scopes: ['read', 'browser:read'] }), { code: 'DIRECT_SCOPE_REQUIRED', scope: 'browser:write' });
});
