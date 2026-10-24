import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { EmailOAuthManager } from '../lib/email-oauth.mjs';
import { AgentEmailStore, runEmailCli } from '../lib/agent-email.mjs';

const CLIENT = '123456-blackice-fixture.apps.googleusercontent.com';
const SECRET = 'fixture-client-secret-never-public';
const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const helper = fileURLToPath(new URL('../scripts/email-oauth-token.mjs', import.meta.url));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const waitUntil = async predicate => {
  const deadline = Date.now() + 2500;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Fixture condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
function encryption() {
  const key = randomBytes(32);
  return {
    encryptSecret(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64'); },
    decryptSecret(value) { const data = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'); },
  };
}
async function setup(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-email-oauth-'));
  const vault = encryption(), opened = [], tokenCalls = [], profileCalls = [], state = { tokenGate: null, tokenError: null, tokenResponse: null, profileError: false, profileResponse: null };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/token') {
        let body = ''; for await (const chunk of req) body += chunk;
        const fields = new URLSearchParams(body); tokenCalls.push(fields);
        if (state.tokenGate) await state.tokenGate.promise;
        if (state.tokenError) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(state.tokenError)); return; }
        const value = state.tokenResponse || { access_token: `fixture-access-${tokenCalls.length}`, refresh_token: `fixture-refresh-${tokenCalls.length}`, token_type: 'Bearer', expires_in: 3600, scope: fields.get('scope') || READ_SCOPE };
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
      } else if (req.url === '/profile') {
        profileCalls.push({ authorization: req.headers.authorization });
        res.writeHead(state.profileError ? 403 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state.profileResponse || (state.profileError ? { error: 'fixture-access-1 must never be reflected' } : { emailAddress: 'authorized@example.test' })));
      } else { res.writeHead(404); res.end(); }
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetchImpl = (url, init) => {
    const actual = new URL(url);
    if (url === 'https://oauth2.googleapis.com/token' || url === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') return fetch(`${origin}/token`, init);
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile' || url === 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName') return fetch(`${origin}/profile`, init);
    throw new Error(`Unexpected fixture endpoint: ${actual.origin}${actual.pathname}`);
  };
  const managerOptions = { dataDir: directory, ...vault, fetchImpl, openExternal: async url => { opened.push(new URL(url)); }, ...options };
  const manager = await new EmailOAuthManager(managerOptions).init();
  const managers = [manager];
  t.after(async () => { state.tokenGate?.resolve(); await Promise.allSettled(managers.map(item => item.close())); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  return { manager, directory, vault, opened, tokenCalls, profileCalls, state, managerOptions, managers };
}
async function configure(manager, options = {}) { return manager.configure({ provider: 'gmail', clientId: CLIENT, clientSecret: SECRET, ...options }, { expectedRevision: manager.status().revision }); }
function callbackURL(opened, extra = {}) {
  const authorization = opened.at(-1), url = new URL(authorization.searchParams.get('redirect_uri'));
  url.searchParams.set('state', authorization.searchParams.get('state')); url.searchParams.set('code', 'fixture-authorization-code');
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return url;
}
async function authorize(fixture) {
  await fixture.manager.begin();
  const response = await fetch(callbackURL(fixture.opened));
  await response.text(); return response;
}

test('managed email fails closed without encrypted desktop storage and preserves unreadable credentials', async t => {
  const fixture = await setup(t, { encryptSecret: undefined, decryptSecret: undefined });
  assert.equal(fixture.manager.status().available, false);
  await assert.rejects(configure(fixture.manager), { code: 'EMAIL_OAUTH_STORAGE_UNAVAILABLE' });
  assert.deepEqual(await fs.readdir(path.join(fixture.directory, 'agent-email')), []);
  const healthy = await setup(t); await configure(healthy.manager);
  const original = await fs.readFile(healthy.manager.filename);
  await healthy.manager.close();
  const unreadable = await new EmailOAuthManager({ dataDir: healthy.directory, ...encryption() }).init(); healthy.managers.push(unreadable);
  assert.equal(unreadable.status().state, 'unavailable');
  assert.equal(unreadable.status().lastError.code, 'EMAIL_OAUTH_STORAGE');
  await assert.rejects(unreadable.disconnect(), { code: 'EMAIL_OAUTH_STORAGE' });
  assert.deepEqual(await fs.readFile(unreadable.filename), original);
});

test('registration uses fixed providers, rejects stale configuration and never exposes secrets', async t => {
  const { manager, directory, opened, tokenCalls } = await setup(t);
  await configure(manager);
  assert.equal(manager.status().configured, true); assert.equal(manager.status().connected, false);
  assert.equal(manager.status().config.clientSecretConfigured, true);
  assert.equal(opened.length, 0); assert.equal(tokenCalls.length, 0);
  await assert.rejects(manager.configure({ authorizationUrl: 'https://example.test' }), { code: 'EMAIL_OAUTH_INVALID' });
  await assert.rejects(manager.configure({ clientId: CLIENT }, { expectedRevision: 0 }), { code: 'EMAIL_OAUTH_REVISION_CONFLICT' });
  await assert.rejects(manager.configure({ provider: 'microsoft', clientId: 'not-a-client' }), { code: 'EMAIL_OAUTH_INVALID' });
  const file = await fs.readFile(path.join(directory, 'agent-email', 'oauth.json'), 'utf8');
  assert.doesNotMatch(file, new RegExp(SECRET)); assert.doesNotMatch(JSON.stringify(manager.status()), new RegExp(SECRET));
});

test('actual loopback callback requests mailbox and sending scope while preserving an existing read grant with verified identity', async t => {
  const fixture = await setup(t), { manager, opened, tokenCalls, profileCalls } = fixture;
  await configure(manager, { loginHint: 'suggested@example.test' });
  await manager.begin(); const auth = opened.at(-1);
  assert.equal(auth.origin + auth.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send');
  assert.equal(auth.searchParams.get('access_type'), 'offline');
  assert.doesNotMatch(auth.toString(), new RegExp(SECRET));
  const invalid = await fetch(callbackURL(opened, { state: 'wrong' })); await invalid.text();
  assert.equal(invalid.status, 400); assert.equal(tokenCalls.length, 0); assert.equal(manager.status().authorization.pending, true);
  const unicode = 'é'.repeat(auth.searchParams.get('state').length);
  const invalidUnicode = await fetch(callbackURL(opened, { state: unicode })); await invalidUnicode.text();
  assert.equal(invalidUnicode.status, 400); assert.equal(tokenCalls.length, 0);
  const valid = callbackURL(opened), response = await fetch(valid); const html = await response.text();
  assert.equal(response.status, 200); assert.equal(tokenCalls.length, 1); assert.equal(profileCalls.length, 1);
  assert.equal(createHash('sha256').update(tokenCalls[0].get('code_verifier')).digest('base64url'), auth.searchParams.get('code_challenge'));
  assert.equal(tokenCalls[0].get('redirect_uri'), auth.searchParams.get('redirect_uri'));
  assert.equal(manager.status().identity.email, 'authorized@example.test', 'verified provider account replaces any inference from loginHint');
  assert.equal(manager.status().connected, true); assert.equal(manager.status().authorization.pending, false);
  assert.doesNotMatch(html, /fixture-access|fixture-refresh|fixture-client-secret/);
  await fetch(valid).then(async repeat => { assert.equal(repeat.status, 410); await repeat.text(); }).catch(() => {});
  assert.equal(tokenCalls.length, 1);
});

test('tokens remain encrypted or in child-only environment, and headless restart refreshes once with rotation', async t => {
  const fixture = await setup(t); await configure(fixture.manager); assert.equal((await authorize(fixture)).status, 200);
  const context = await fixture.manager.commandContext();
  assert.equal(context.environment.BLACKICE_EMAIL_ACCESS_TOKEN, 'fixture-access-1');
  assert.equal(context.environment.ELECTRON_RUN_AS_NODE, '1'); assert.equal(context.environment.NODE_OPTIONS, undefined);
  assert.equal(process.env.BLACKICE_EMAIL_ACCESS_TOKEN, undefined);
  const config = await fs.readFile(context.configPath, 'utf8');
  assert.match(config, /gmail\.auth\.token\.command/); assert.ok(config.includes(JSON.stringify(process.execPath))); assert.ok(config.includes(JSON.stringify(helper)));
  for (const filename of await fs.readdir(path.dirname(context.configPath))) assert.doesNotMatch(await fs.readFile(path.join(path.dirname(context.configPath), filename), 'utf8'), /fixture-access|fixture-refresh|fixture-client-secret/);
  const status = JSON.stringify(fixture.manager.status()); assert.doesNotMatch(status, /fixture-access|fixture-refresh|fixture-client-secret/);
  await fixture.manager.close();
  const resumed = await new EmailOAuthManager(fixture.managerOptions).init(); fixture.managers.push(resumed);
  assert.equal(resumed.status().connected, true); assert.equal(resumed.status().identity.email, 'authorized@example.test');
  const tokens = await Promise.all(Array.from({ length: 12 }, () => resumed.getAccessToken()));
  assert.ok(tokens.every(token => token === 'fixture-access-2')); assert.equal(fixture.tokenCalls.length, 2); assert.equal(fixture.opened.length, 1);
  assert.equal(fixture.tokenCalls[1].get('refresh_token'), 'fixture-refresh-1');
  await resumed.close();
  const third = await new EmailOAuthManager(fixture.managerOptions).init(); fixture.managers.push(third);
  assert.equal(await third.getAccessToken(), 'fixture-access-3');
  assert.equal(fixture.tokenCalls[2].get('refresh_token'), 'fixture-refresh-2');
});

test('a rejected refresh clears the grant and reports reconnect without opening a browser', async t => {
  const fixture = await setup(t); await configure(fixture.manager); await authorize(fixture);
  fixture.manager.secrets.tokens.expiresAt = 0;
  fixture.state.tokenError = { error: 'invalid_grant', error_description: 'fixture-refresh-1 PRIVATE must never be reflected' };
  await assert.rejects(fixture.manager.getAccessToken(), { code: 'EMAIL_OAUTH_AUTH_REQUIRED' });
  assert.equal(fixture.manager.status().connected, false); assert.equal(fixture.manager.status().state, 'error');
  assert.equal(fixture.opened.length, 1); assert.doesNotMatch(JSON.stringify(fixture.manager.status()), /PRIVATE|fixture-refresh/);
  await fixture.manager.close();
  const resumed = await new EmailOAuthManager(fixture.managerOptions).init(); fixture.managers.push(resumed);
  assert.equal(resumed.status().connected, false); await assert.rejects(resumed.getAccessToken(), { code: 'EMAIL_OAUTH_AUTH_REQUIRED' });
});

test('a rejected refresh fails closed if encrypted storage cannot clear the revoked grant', async t => {
  const fixture = await setup(t); await configure(fixture.manager); await authorize(fixture);
  fixture.manager.secrets.tokens.expiresAt = 0;
  fixture.state.tokenError = { error: 'invalid_grant', error_description: 'fixture-refresh-1 must never be reflected' };
  fixture.manager.encryptSecret = () => { throw new Error('fixture-refresh-1 private encryption failure'); };
  await assert.rejects(fixture.manager.getAccessToken(), { code: 'EMAIL_OAUTH_STORAGE' });
  assert.equal(fixture.manager.status().connected, false); assert.equal(fixture.manager.status().available, false);
  assert.equal(fixture.manager.status().state, 'unavailable'); assert.equal(fixture.manager.secrets.tokens, null);
  assert.doesNotMatch(JSON.stringify(fixture.manager.status()), /fixture-refresh|private encryption/);
  await assert.rejects(fixture.manager.getAccessToken(), { code: 'EMAIL_OAUTH_STORAGE' });
});

test('provider errors, missing offline access, missing mail permission and invalid identity remain safe failures', async t => {
  for (const scenario of ['provider-error', 'offline', 'scope', 'identity']) {
    const fixture = await setup(t); await configure(fixture.manager);
    if (scenario === 'provider-error') fixture.state.tokenError = { error: 'invalid_client', error_description: SECRET };
    if (scenario === 'offline') fixture.state.tokenResponse = { access_token: 'fixture-access-1', token_type: 'Bearer', expires_in: 3600, scope: READ_SCOPE };
    if (scenario === 'scope') fixture.state.tokenResponse = { access_token: 'fixture-access-1', refresh_token: 'fixture-refresh-1', token_type: 'Bearer', expires_in: 3600, scope: 'https://www.googleapis.com/auth/calendar.readonly' };
    if (scenario === 'identity') fixture.state.profileError = true;
    assert.equal((await authorize(fixture)).status, 400, scenario);
    assert.equal(fixture.manager.status().connected, false, scenario);
    assert.doesNotMatch(JSON.stringify(fixture.manager.status()), /fixture-access|fixture-refresh|fixture-client-secret|PRIVATE/);
    if (scenario !== 'identity') assert.equal(fixture.profileCalls.length, 0);
  }
});

test('cancel during token exchange drains the callback without accepting a late token', async t => {
  const fixture = await setup(t); await configure(fixture.manager);
  const original = await fs.readFile(fixture.manager.filename);
  fixture.state.tokenGate = deferred(); await fixture.manager.begin();
  const completion = fetch(callbackURL(fixture.opened)).then(async res => { await res.text(); return res.status; }).catch(() => 0);
  await waitUntil(() => fixture.tokenCalls.length === 1);
  const cancellation = fixture.manager.cancel(); fixture.state.tokenGate.resolve(); await cancellation; await completion;
  assert.equal(fixture.manager.status().connected, false); assert.equal(fixture.manager.status().authorization.pending, false);
  assert.deepEqual(await fs.readFile(fixture.manager.filename), original);
  assert.equal(fixture.profileCalls.length, 0);
});

test('cancel during encrypted persistence does not leave a newly committed grant on disk', async t => {
  const fixture = await setup(t); await configure(fixture.manager);
  const original = await fs.readFile(fixture.manager.filename), gate = deferred(); let saving = false;
  fixture.manager.encryptSecret = async value => { if (JSON.parse(value).tokens) { saving = true; await gate.promise; } return fixture.vault.encryptSecret(value); };
  await fixture.manager.begin(); const completion = fetch(callbackURL(fixture.opened)).then(async res => { await res.text(); return res.status; }).catch(() => 0);
  await waitUntil(() => saving); const cancellation = fixture.manager.cancel(); gate.resolve(); await cancellation; await completion;
  assert.equal(fixture.manager.status().connected, false); assert.equal(fixture.manager.status().authorization.pending, false);
  assert.deepEqual(await fs.readFile(fixture.manager.filename), original);
  await fixture.manager.close();
  const resumed = await new EmailOAuthManager(fixture.managerOptions).init(); fixture.managers.push(resumed);
  assert.equal(resumed.status().connected, false);
});

test('cancel waits for a racing disk rename and restores the exact earlier encrypted record', async t => {
  const fixture = await setup(t); await configure(fixture.manager);
  const original = await fs.readFile(fixture.manager.filename), gate = deferred(), rename = fs.rename;
  let renamed = false, cancellationSettled = false;
  fs.rename = async (from, to) => {
    await rename(from, to);
    if (!renamed && to === fixture.manager.filename) { renamed = true; await gate.promise; }
  };
  t.after(() => { gate.resolve(); fs.rename = rename; });
  await fixture.manager.begin();
  const completion = fetch(callbackURL(fixture.opened)).then(async res => { await res.text(); return res.status; }).catch(() => 0);
  try {
    await waitUntil(() => renamed);
    assert.notDeepEqual(await fs.readFile(fixture.manager.filename), original, 'The new encrypted record actually reached disk before cancellation.');
    const cancellation = fixture.manager.cancel().then(value => { cancellationSettled = true; return value; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(cancellationSettled, false);
    gate.resolve(); await cancellation; await completion;
    assert.equal(fixture.manager.status().connected, false); assert.equal(fixture.manager.status().authorization.pending, false);
    assert.deepEqual(await fs.readFile(fixture.manager.filename), original);
  } finally { gate.resolve(); fs.rename = rename; }
});

test('changing registration during callback invalidates the old flow and its token', async t => {
  const fixture = await setup(t); await configure(fixture.manager);
  fixture.state.tokenGate = deferred(); await fixture.manager.begin();
  const completion = fetch(callbackURL(fixture.opened)).then(async res => { await res.text(); }).catch(() => {});
  await waitUntil(() => fixture.tokenCalls.length === 1);
  await fixture.manager.configure({ clientId: 'another-owned-fixture.apps.googleusercontent.com' });
  fixture.state.tokenGate.resolve(); await completion; await fixture.manager.drain();
  assert.equal(fixture.manager.status().connected, false); assert.equal(fixture.manager.status().config.clientSecretConfigured, false);
  assert.equal(fixture.manager.status().config.clientId, 'another-owned-fixture.apps.googleusercontent.com');
});

test('cancel and close also retire a queued sign-in before a browser or listener opens', async t => {
  for (const action of ['cancel', 'close']) {
    const fixture = await setup(t); await configure(fixture.manager);
    const begin = fixture.manager.begin(); const finish = fixture.manager[action]();
    await assert.rejects(begin, error => error.code === 'ABORT_ERR' || error.code === 'EMAIL_OAUTH_CLOSED');
    await finish; assert.equal(fixture.opened.length, 0); assert.equal(fixture.manager.status().authorization.pending, false);
  }
});

test('expired or denied consent cannot become an active grant', async t => {
  const expired = await setup(t, { flowTimeoutMs: 40 }); await configure(expired.manager); await expired.manager.begin();
  await waitUntil(() => !expired.manager.status().authorization.pending);
  assert.equal(expired.manager.status().lastError.code, 'EMAIL_OAUTH_EXPIRED'); assert.equal(expired.manager.status().connected, false);
  const denied = await setup(t); await configure(denied.manager); await denied.manager.begin();
  const url = callbackURL(denied.opened); url.searchParams.delete('code'); url.searchParams.set('error', 'access_denied'); url.searchParams.set('error_description', SECRET);
  const response = await fetch(url); const html = await response.text();
  assert.equal(response.status, 400); assert.equal(denied.tokenCalls.length, 0); assert.doesNotMatch(html + JSON.stringify(denied.manager.status()), new RegExp(SECRET));
});

test('Microsoft requests mailbox and sending access while retaining actual capabilities of a legacy grant', async t => {
  const fixture = await setup(t);
  await fixture.manager.configure({ provider: 'microsoft', clientId: '12345678-1234-1234-1234-123456789abc' });
  await assert.rejects(fixture.manager.configure({ clientSecret: SECRET }), { code: 'EMAIL_OAUTH_INVALID' });
  fixture.state.tokenResponse = { access_token: 'fixture-microsoft-access', refresh_token: 'fixture-microsoft-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'Mail.Read User.Read offline_access' };
  fixture.state.profileResponse = { mail: 'outlook@example.test' };
  assert.equal((await authorize(fixture)).status, 200);
  assert.equal(fixture.opened[0].origin, 'https://login.microsoftonline.com');
  assert.match(fixture.opened[0].searchParams.get('scope'), /Mail.ReadWrite/);
  assert.match(fixture.opened[0].searchParams.get('scope'), /Mail.Send/);
  assert.deepEqual(fixture.manager.status().capabilities, {read:true,send:false});
  assert.equal(new URL(fixture.opened[0].searchParams.get('redirect_uri')).hostname, 'localhost');
  assert.equal(new URL(fixture.opened[0].searchParams.get('redirect_uri')).pathname, '/');
  assert.equal(fixture.tokenCalls[0].has('client_secret'), false);
  assert.equal(fixture.manager.status().identity.email, 'outlook@example.test');
  const context = await fixture.manager.commandContext(); assert.match(await fs.readFile(context.configPath, 'utf8'), /msgraph\.auth\.token\.command/);
});

test('full mail grants support sending and legitimate broader grants survive encrypted reload without narrowing', async t => {
  for (const scope of ['https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send openid email', 'https://mail.google.com/']) {
    const fixture=await setup(t);await configure(fixture.manager);
    fixture.state.tokenResponse={access_token:'fixture-access-full',refresh_token:'fixture-refresh-full',token_type:'Bearer',expires_in:3600,scope};
    assert.equal((await authorize(fixture)).status,200);
    assert.deepEqual(fixture.manager.status().capabilities,{read:true,send:true});
    await fixture.manager.close();
    const reopened=await new EmailOAuthManager(fixture.managerOptions).init();fixture.managers.push(reopened);
    assert.equal(reopened.status().connected,true);assert.deepEqual(reopened.status().capabilities,{read:true,send:true});
    assert.deepEqual(reopened.status().grantedScopes,scope.split(' '));
  }
});

test('legacy Microsoft refresh keeps the actual grant scope instead of implicitly requesting a broader grant', async t => {
  const fixture=await setup(t);await fixture.manager.configure({provider:'microsoft',clientId:'12345678-1234-1234-1234-123456789abc'});
  fixture.state.tokenResponse={access_token:'fixture-old-read',refresh_token:'fixture-refresh-read',token_type:'Bearer',expires_in:1,scope:'Mail.Read User.Read offline_access'};
  fixture.state.profileResponse={mail:'fixture@example.test'};
  assert.equal((await authorize(fixture)).status,200);
  await fixture.manager.getAccessToken();
  assert.equal(fixture.tokenCalls.at(-1).get('scope'),'Mail.Read User.Read offline_access');
  assert.deepEqual(fixture.manager.status().capabilities,{read:true,send:false});
});

test('managed adapter retains external configuration compatibility and never returns an OAuth token to tools', async t => {
  const fixture = await setup(t); await configure(fixture.manager); await authorize(fixture);
  const calls = [], runner = async input => {
    calls.push(input);
    if (input.args.includes('--version')) return { stdout: 'himalaya 2.2.1 +gmail +msgraph' };
    if (input.args.includes('--help')) return { stdout: 'profile --json --page-size --page --mailbox --account --raw --seen Read, leaving its flags alone otherwise' };
    if (input.args.includes('envelope')) return { stdout: JSON.stringify({ queued: 0, envelopes: [{ id: 'fixture-message', subject: 'Fixture subject' }] }) };
    return { stdout: JSON.stringify({ message: 'From: fixture@example.test\nSubject: Fixture\n\nFixture body.' }) };
  };
  const store = await new AgentEmailStore({ dataDir: fixture.directory, oauth: fixture.manager, runner }).init(); t.after(() => store.close());
  await store.configure({ connection: 'oauth', enabled: true, executable: process.execPath }); await store.check();
  const result = await store.list(); assert.equal(result.messages.length, 1); assert.equal(store.status().account.observed, true);
  const read = await store.read({ id: 'fixture-message' }); assert.equal(read.preview, true); assert.equal(calls.at(-1).args.includes('--seen'), false);
  assert.equal(calls.at(-1).environment.BLACKICE_EMAIL_ACCESS_TOKEN, 'fixture-access-1');
  assert.doesNotMatch(JSON.stringify({ snapshot: store.snapshot(), result, read, args: calls.map(item => item.args) }), /fixture-access|fixture-refresh|fixture-client-secret/);
  assert.equal(store.snapshot().config.configPath, fixture.manager.configPath); assert.equal(store.snapshot().config.account, 'blackice');
  const external = path.join(fixture.directory, 'existing-user-config.toml'); await fs.writeFile(external, '# retained external setup\n');
  await store.configure({ connection: 'external', configPath: external, account: 'existing' }); await store.check(); await store.list();
  assert.equal(calls.at(-1).environment, undefined); assert.equal(await fs.readFile(external, 'utf8'), '# retained external setup\n');
});

test('disconnect retires account evidence, removes local tokens and aborts an active managed mailbox operation', async t => {
  const fixture = await setup(t); await configure(fixture.manager); await authorize(fixture);
  const started = deferred(), runner = async input => {
    if (input.args.includes('--version')) return { stdout: 'himalaya 2.2.1 +gmail' };
    if (input.args.includes('--help')) return { stdout: 'profile --json --page-size --page --mailbox --account --raw --seen Read, leaving its flags alone otherwise' };
    started.resolve(); return new Promise((resolve, reject) => { input.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'ABORT_ERR' })), { once: true }); });
  };
  const store = await new AgentEmailStore({ dataDir: fixture.directory, oauth: fixture.manager, runner }).init(); t.after(() => store.close());
  await store.configure({ connection: 'oauth', enabled: true, executable: process.execPath }); await store.check();
  const listing = assert.rejects(store.list(), { code: 'ABORT_ERR' });
  await started.promise; await fixture.manager.disconnect(); await listing;
  assert.equal(store.status().capabilities.read, false); assert.equal(store.status().account.observed, false);
  assert.equal(fixture.manager.status().configured, true); assert.equal(fixture.manager.status().connected, false);
});

test('token helper executes through the runtime using a child-only token and rejects a missing token', async () => {
  const token = 'fixture-short-lived-helper-token';
  const result = await runEmailCli({ executable: process.execPath, args: [helper], environment: { BLACKICE_EMAIL_ACCESS_TOKEN: token, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: undefined } });
  assert.equal(result.stdout, token); assert.equal(process.env.BLACKICE_EMAIL_ACCESS_TOKEN, undefined);
  await assert.rejects(runEmailCli({ executable: process.execPath, args: [helper], environment: { BLACKICE_EMAIL_ACCESS_TOKEN: undefined, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: undefined } }), { code: 'EMAIL_CLIENT_FAILED' });
});
