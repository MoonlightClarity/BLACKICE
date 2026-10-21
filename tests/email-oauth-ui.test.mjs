import test from 'node:test';
import assert from 'node:assert/strict';
import { emailOAuthCopy, initEmailOAuthUI } from '../public/email-oauth-ui.mjs';
import { initEmailUI } from '../public/email-ui.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const clientId = 'blackice-fixture.apps.googleusercontent.com';
const initial = () => ({ revision: 1, configured: false, enabled: false, localManagement: true, storage: { healthy: true }, config: { connection: 'external', enabled: false, executable: '', configPath: '', account: '' }, setupHints: { executable: '/fixture/himalaya' }, cli: { checked: false }, account: { observed: false }, drafts: [], capabilities: { send: false },
  oauth: { available: true, configured: false, connected: false, state: 'not_configured', revision: 0, provider: 'gmail', config: { provider: 'gmail', clientId: '', loginHint: '', clientSecretConfigured: false }, authorization: { pending: false, expiresAt: null }, identity: null, scopes: ['https://www.googleapis.com/auth/gmail.readonly'], lastError: null },
});
const registered = ({ pending = false, connected = false } = {}) => {
  const value = initial();
  value.oauth = { ...value.oauth, configured: true, connected, revision: 4, state: pending ? 'authorizing' : connected ? 'connected' : 'authorization_required', config: { ...value.oauth.config, clientId, clientSecretConfigured: true }, authorization: { pending, expiresAt: pending ? '2026-10-20T02:00:00Z' : null } };
  return value;
};
function clock() {
  let next = 0; const timers = new Map();
  return { timers, setTimer(fn, ms) { const id = ++next; timers.set(id, { fn, ms }); return id; }, clearTimer(id) { timers.delete(id); }, async fire() { const timer = timers.entries().next().value; assert.ok(timer, 'A pending poll is scheduled.'); timers.delete(timer[0]); await timer[1].fn(); await turn(); } };
}
function fixture(t, { value = initial(), withEmail = false } = {}) {
  let ui, hook, saved = structuredClone(value), displayed = structuredClone(value), parentBusy = false;
  const timers = clock(), calls = [], receipts = [], adoptions = [], changes = [];
  const previousTimers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  t.after(() => { withEmail ? ui?.cancel() : ui?.destroy(); globalThis.setTimeout = previousTimers.setTimeout; globalThis.clearTimeout = previousTimers.clearTimeout; });
  const dom = planningDOM(t, { normalizeMarkup: true });
  const normal = async (url, request = {}) => {
    if (url === '/api/email') return structuredClone(saved);
    if (url === '/api/email/oauth/config') {
      if (request.body.expectedRevision !== saved.oauth.revision) throw Object.assign(Error('Email sign-in settings changed. Reload before saving.'), { code: 'EMAIL_OAUTH_REVISION_CONFLICT', status: 409 });
      const config = request.body.config, same = config.provider === saved.oauth.provider && config.clientId === saved.oauth.config.clientId;
      saved.oauth = { ...saved.oauth, configured: Boolean(config.clientId), connected: false, state: 'authorization_required', revision: saved.oauth.revision + 1, provider: config.provider, config: { provider: config.provider, clientId: config.clientId, loginHint: config.loginHint, clientSecretConfigured: Boolean(config.clientSecret || same && saved.oauth.config.clientSecretConfigured) }, authorization: { pending: false }, identity: null };
      return structuredClone(saved.oauth);
    }
    if (url === '/api/email/config') {
      assert.equal(request.body.expectedRevision, saved.revision, 'Mail engine settings use a saved revision.');
      saved.revision++; saved.config = { ...saved.config, ...request.body.config, ...(request.body.config.connection === 'oauth' ? { configPath: '/fixture/managed-oauth.toml', account: 'blackice' } : {}) };
      saved.configured = true; saved.enabled = saved.config.enabled; saved.cli = { checked: false }; saved.account = { observed: false };
      return structuredClone(saved);
    }
    if (url === '/api/email/check') { saved.cli = { checked: true, version: '2.2.1' }; return structuredClone(saved); }
    if (url === '/api/email/oauth/begin') {
      if (request.body.expectedRevision !== saved.oauth.revision) throw Object.assign(Error('Email sign-in settings changed. Reload before connecting.'), { code: 'EMAIL_OAUTH_REVISION_CONFLICT', status: 409 });
      saved.oauth.authorization = { pending: true, expiresAt: '2026-10-20T02:00:00Z' }; saved.oauth.state = 'authorizing';
      return structuredClone(saved.oauth);
    }
    if (url === '/api/email/oauth/cancel') { saved.oauth.authorization = { pending: false }; saved.oauth.state = saved.oauth.connected ? 'connected' : 'authorization_required'; return structuredClone(saved.oauth); }
    if (url === '/api/email/oauth/disconnect') { saved.oauth.connected = false; saved.oauth.authorization = { pending: false }; saved.oauth.identity = null; saved.oauth.revision++; return structuredClone(saved.oauth); }
    if (url === '/api/email/drafts') { const draft = { id: `draft-${saved.drafts.length + 1}`, ...request.body, sent: false }; saved.drafts.push(draft); saved.revision++; return { draft }; }
    throw Error(`Unexpected fixture route ${url}`);
  };
  const api = async (url, request = {}) => {
    calls.push({ url, method: request.method || 'GET', body: structuredClone(request.body), signal: request.signal });
    return hook ? hook(url, request, () => normal(url, request)) : normal(url, request);
  };
  if (withEmail) {
    globalThis.setTimeout = timers.setTimer; globalThis.clearTimeout = timers.clearTimer;
    dom.mount.id = 'modal-root';
    ui = initEmailUI({ api, showModal(_name, markup) { dom.mount.innerHTML = `<section class="modal">${markup}</section>`; }, closeModal() { ui.cancel(); dom.mount.innerHTML = ''; }, onChanged: () => { changes.push(true); } });
  } else {
    ui = initEmailOAuthUI({ mount: dom.mount, api, getSnapshot: () => displayed, adoptSnapshot(value) { displayed = value; adoptions.push(value); ui.adopt(value); }, outerBusy: () => parentBusy, onBusy(value) { parentBusy = value; ui?.sync(); }, showReceipt: (...args) => receipts.push(args), onChanged: () => { changes.push(true); }, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  }
  return { dom, ui, api, calls, timers, receipts, adoptions, changes, get saved() { return saved; }, get displayed() { return displayed; }, hook(value) { hook = value; }, async open() { if (withEmail) await ui.open(); }, adopt(value) { displayed = structuredClone(value); ui.adopt(displayed); }, setBusy(value) { parentBusy = value; ui.sync(); }, async submit() { await dom.$('#email-oauth-form').dispatch('submit'); }, async importFile(value, options = {}) { const field = dom.$('#email-oauth-import'); field.files = [{ size: options.size ?? value.length, text: options.text || (async () => value) }]; field.value = 'C:\\fakepath\\client.json'; await field.dispatch('change'); } };
}

test('registration typing stays local; explicit sign-in saves the registration and engine before asking the server to begin PKCE', async t => {
  const f = fixture(t);
  await f.dom.input('#email-oauth-client-id', clientId); await f.dom.input('#email-oauth-client-secret', 'fixture-desktop-secret'); await f.dom.input('#email-oauth-login-hint', 'hint@example.test');
  assert.equal(f.calls.length, 0); assert.equal(f.dom.$('#email-oauth-connect').disabled, false);
  await f.submit();
  assert.deepEqual(f.calls.map(call => [call.method, call.url]), [['PUT', '/api/email/oauth/config'], ['GET', '/api/email'], ['PUT', '/api/email/config'], ['POST', '/api/email/check'], ['POST', '/api/email/oauth/begin'], ['GET', '/api/email']]);
  assert.deepEqual(f.calls[0].body, { config: { provider: 'gmail', clientId, clientSecret: 'fixture-desktop-secret', loginHint: 'hint@example.test' }, expectedRevision: 0 });
  assert.deepEqual(f.calls[2].body, { expectedRevision: 1, config: { connection: 'oauth', enabled: true, executable: '/fixture/himalaya' } });
  assert.deepEqual(f.calls[4].body, { expectedRevision: 1 });
  assert.ok(f.calls.every(call => call.signal instanceof AbortSignal && !call.signal.aborted));
  assert.equal(f.dom.$('#email-oauth-client-secret').value, ''); assert.equal(f.dom.$('#email-oauth-connect').disabled, true); assert.equal(f.dom.$('#email-oauth-cancel').hidden, false);
  assert.equal(f.saved.account.observed, false, 'A CLI check and pending consent are not mailbox evidence.');
  assert.equal(JSON.stringify(f.saved).includes('fixture-desktop-secret'), false); assert.equal(JSON.stringify(f.receipts).includes('fixture-desktop-secret'), false);
});

test('status adoption preserves focused registration edits, caret, engine input and disclosure identity', async t => {
  const f = fixture(t, { value: registered() });
  const field = await f.dom.input('#email-oauth-client-id', 'my-unsaved.apps.googleusercontent.com'), disclosure = f.dom.$('#email-oauth-registration');
  field.focus(); field.setSelectionRange(3, 11, 'backward'); disclosure.open = true;
  await f.dom.input('#email-oauth-executable', '/my/local/himalaya');
  f.adopt({ ...f.saved, revision: f.saved.revision + 1, drafts: [{ id: 'someone-elses-draft' }] });
  assert.equal(f.dom.$('#email-oauth-client-id'), field); assert.equal(f.dom.document.activeElement, field); assert.equal(field.value, 'my-unsaved.apps.googleusercontent.com');
  assert.deepEqual([field.selectionStart, field.selectionEnd, field.selectionDirection], [3, 11, 'backward']); assert.equal(f.dom.$('#email-oauth-registration'), disclosure); assert.equal(disclosure.open, true);
  assert.equal(f.dom.$('#email-oauth-executable').value, '/my/local/himalaya'); assert.equal(f.dom.$('#email-oauth-stale').hidden, true);
});

test('a concurrent registration save preserves local fields, exposes reload and does not replay its rejected write', async t => {
  const f = fixture(t, { value: registered() });
  await f.dom.input('#email-oauth-client-id', 'local-edit.apps.googleusercontent.com'); await f.dom.input('#email-oauth-client-secret', 'new-local-secret'); await f.dom.input('#email-oauth-executable', '/unsaved/engine');
  f.saved.oauth.revision++; f.saved.oauth.config.clientId = 'other-editor.apps.googleusercontent.com';
  await f.dom.click('#email-oauth-save');
  assert.equal(f.dom.$('#email-oauth-client-id').value, 'local-edit.apps.googleusercontent.com'); assert.equal(f.dom.$('#email-oauth-client-secret').value, ''); assert.equal(f.dom.$('#email-oauth-stale').hidden, false);
  await f.submit(); assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
  await f.dom.click('#email-oauth-reload');
  assert.equal(f.dom.$('#email-oauth-client-id').value, 'other-editor.apps.googleusercontent.com'); assert.equal(f.dom.$('#email-oauth-executable').value, '/unsaved/engine'); assert.equal(f.dom.$('#email-oauth-stale').hidden, true);
});

test('the real OAuth HTTP conflict reaches the registration form and requires a deliberate reload', { timeout: 15000 }, async t => {
  const [{ EventEmitter }, fs, { default: path }, { tmpdir }, { randomUUID }, { createHarnessServer }, { EmailOAuthManager }, { AgentEmailStore }, { createApiClient }] = await Promise.all([
    import('node:events'), import('node:fs/promises'), import('node:path'), import('node:os'), import('node:crypto'), import('../server.mjs'), import('../lib/email-oauth.mjs'), import('../lib/agent-email.mjs'), import('../public/api-client.mjs'),
  ]);
  const root = await fs.mkdtemp(path.join(tmpdir(), 'blackice-oauth-http-form-')), dataDir = path.join(root, 'data'), secrets = new Map();
  let app, providerCalls = 0, cliCalls = 0;
  t.after(async () => { await app?.close(); await fs.rm(root, { recursive: true, force: true }); assert.equal(providerCalls, 0); assert.equal(cliCalls, 0); });
  class Runtime extends EventEmitter {
    status() { return { connected: false, authenticated: false, models: [] }; }
    async start() { return this.status(); }
    async close() {}
    async runAgent() { throw Error('Registration must not start a model.'); }
  }
  class Desktop extends EventEmitter { status() { return { available: false, enabled: false }; } async setEnabled() { return this.status(); } }
  const oauth = await new EmailOAuthManager({ dataDir,
    encryptSecret(value) { const id = randomUUID(); secrets.set(id, value); return id; },
    decryptSecret(id) { assert.ok(secrets.has(id)); return secrets.get(id); },
    openExternal() { providerCalls++; throw Error('Registration must not open provider consent.'); },
    fetchImpl() { providerCalls++; throw Error('Registration must not call a mail provider.'); },
  }).init();
  const email = await new AgentEmailStore({ dataDir, oauth, runner: async () => { cliCalls++; throw Error('Registration must not launch Himalaya.'); } }).init();
  app = await createHarnessServer({ port: 0, dataDir, defaultCwd: path.join(root, 'workspace'), runtime: new Runtime(), desktop: new Desktop(), email, emailOAuth: oauth, emailExecutableHint: process.execPath, autoAttachDesktop: false });
  await app.learning.updateSettings({ mode: 'manual' });
  const url = await app.listen(), page = await fetch(url), cookie = page.headers.get('set-cookie').split(';')[0]; await page.text();
  const realApi = createApiClient({ fetcher: (route, options) => { const headers = new Headers(options.headers); headers.set('Cookie', cookie); return fetch(url + route, { ...options, headers }); } });
  const original = await realApi('/api/email'), f = fixture(t, { value: original });
  f.hook((route, options) => realApi(route, options));
  await f.dom.input('#email-oauth-client-id', 'local-http-edit.apps.googleusercontent.com');
  await f.dom.input('#email-oauth-client-secret', 'local-http-fixture-secret');
  await f.dom.input('#email-oauth-executable', '/unsaved/mail-engine');
  const saved = await realApi('/api/email/oauth/config', { method: 'PUT', body: { expectedRevision: original.oauth.revision, config: { provider: 'gmail', clientId: 'other-http-editor.apps.googleusercontent.com', clientSecret: 'other-http-fixture-secret' } } });
  await assert.rejects(realApi('/api/email/oauth/begin', { method: 'POST', body: { expectedRevision: original.oauth.revision } }), { status: 409, code: 'EMAIL_OAUTH_REVISION_CONFLICT' });
  await f.dom.click('#email-oauth-save');
  assert.equal(f.dom.$('#email-oauth-stale').hidden, false);
  assert.equal(f.dom.$('#email-oauth-reload').hidden, false); assert.equal(f.dom.$('#email-oauth-reload').disabled, false);
  assert.equal(f.dom.$('#email-oauth-client-id').value, 'local-http-edit.apps.googleusercontent.com');
  assert.equal(f.dom.$('#email-oauth-client-secret').value, ''); assert.equal(f.dom.$('#email-oauth-executable').value, '/unsaved/mail-engine');
  assert.equal(f.dom.$('#email-oauth-connect').disabled, true); assert.equal(f.dom.$('#email-oauth-save').disabled, true);
  await f.submit();
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1, 'The rejected registration is never replayed.');
  assert.equal((await realApi('/api/email')).oauth.revision, saved.revision);
  await f.dom.click('#email-oauth-reload');
  assert.equal(f.dom.$('#email-oauth-stale').hidden, true); assert.equal(f.dom.$('#email-oauth-client-id').value, saved.config.clientId);
  assert.equal(f.dom.$('#email-oauth-executable').value, '/unsaved/mail-engine');
  await assert.rejects(realApi('/api/email/oauth/config', { method: 'PUT', body: { expectedRevision: saved.revision, config: { unsupported: true } } }), error => error.status === 400 && error.code === undefined, 'Other internal error codes remain private.');
});

test('a secret rotation with identical public fields cannot silently rebase an unsaved registration', async t => {
  const f = fixture(t, { value: registered() }); await f.dom.input('#email-oauth-login-hint', 'edited@example.test');
  f.saved.oauth.revision++; f.adopt(f.saved);
  assert.equal(f.dom.$('#email-oauth-login-hint').value, 'edited@example.test'); assert.equal(f.dom.$('#email-oauth-stale').hidden, false); assert.equal(f.dom.$('#email-oauth-save').disabled, true);
});

test('a changed registration after the sign-in click is not silently used for authorization', async t => {
  const f = fixture(t, { value: registered() });
  f.hook((url, request, normal) => { if (url === '/api/email') { f.saved.oauth.revision++; f.saved.oauth.config.clientId = 'concurrent.apps.googleusercontent.com'; } return normal(); });
  await f.submit();
  assert.equal(f.calls.some(call => call.url === '/api/email/config' || call.url.endsWith('/begin')), false);
  assert.equal(f.dom.$('#email-oauth-stale').hidden, false); assert.match(f.receipts.at(-1)[0], /changed/i);
});

test('a failed CLI check never begins provider authorization and clears the submitted secret', async t => {
  const f = fixture(t); await f.dom.input('#email-oauth-client-id', clientId); await f.dom.input('#email-oauth-client-secret', 'short-lived-secret');
  f.hook((url, request, normal) => { if (url === '/api/email/check') throw Object.assign(Error('The configured executable has an unsupported interface.'), { code: 'EMAIL_CLI_UNSUPPORTED' }); return normal(); });
  await f.submit();
  assert.equal(f.calls.some(call => call.url.endsWith('/begin')), false); assert.equal(f.dom.$('#email-oauth-client-secret').value, ''); assert.equal(f.dom.$('#email-oauth-connect').disabled, false); assert.match(f.receipts.at(-1)[0], /unsupported/);
});

test('closing during a registration write clears credentials and ignores a late successful response', async t => {
  const f = fixture(t), response = deferred(); await f.dom.input('#email-oauth-client-id', clientId); const secret = await f.dom.input('#email-oauth-client-secret', 'clear-before-response');
  f.hook((url, request, normal) => url.endsWith('/oauth/config') ? response.promise : normal());
  const saving = f.dom.click('#email-oauth-save'); await turn();
  assert.equal(secret.value, '', 'The secret is cleared when submitted, before the response.');
  f.ui.destroy(); f.dom.mount.innerHTML = ''; response.resolve(registered().oauth); await saving;
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.receipts.length, 0); assert.equal(f.changes.length, 0);
});

test('closing during the final cancel reload prevents late receipts, callbacks and timers', async t => {
  const f = fixture(t, { value: registered({ pending: true }) }), response = deferred();
  f.hook((url, request, normal) => url === '/api/email' ? response.promise : normal());
  const cancelling = f.dom.click('#email-oauth-cancel'); await turn(); f.ui.destroy(); f.dom.mount.innerHTML = '';
  response.resolve(registered()); await cancelling;
  assert.equal(f.receipts.length, 0); assert.equal(f.changes.length, 0); assert.equal(f.timers.timers.size, 0); assert.ok(f.calls.every(call => call.signal.aborted));
});

test('a stale pending poll cannot undo a completed cancellation or resurrect polling', async t => {
  const f = fixture(t, { value: registered({ pending: true }) }), response = deferred(), old = structuredClone(f.saved); let reads = 0;
  f.hook((url, request, normal) => url === '/api/email' && ++reads === 1 ? response.promise : normal());
  const polling = f.timers.fire(); await turn(); await f.dom.click('#email-oauth-cancel');
  response.resolve(old); await polling;
  assert.equal(f.dom.$('#email-oauth-cancel').hidden, true); assert.equal(f.dom.$('#email-oauth-connect').disabled, false); assert.equal(f.timers.timers.size, 0);
  assert.equal(f.changes.length, 1); assert.equal(f.receipts.length, 1); assert.match(f.receipts[0][0], /cancelled/);
});

test('polling pauses while hidden or an outer operation owns the form, and stops after completion', async t => {
  const f = fixture(t, { value: registered({ pending: true }) });
  await f.dom.visibility('hidden'); await f.timers.fire(); assert.equal(f.calls.length, 0);
  await f.dom.visibility('visible'); f.setBusy(true); await f.timers.fire(); assert.equal(f.calls.length, 0); f.setBusy(false);
  f.saved.oauth.authorization.pending = false; f.saved.oauth.connected = true; f.saved.oauth.revision++; f.saved.oauth.identity = { email: 'verified@example.test', verifiedAt: '2026-10-20T00:00:00Z' };
  await f.timers.fire(); assert.equal(f.calls.length, 1); assert.equal(f.timers.timers.size, 0); assert.equal(f.changes.length, 1); assert.match(f.dom.$('#email-oauth-note').textContent, /verified@example\.test/);
});

test('remote and unavailable sessions cannot submit registration or authorization mutations through handlers', async t => {
  const value = registered({ pending: true, connected: true }); value.localManagement = false;
  const f = fixture(t, { value });
  assert.equal(f.dom.$('#email-oauth-remote').hidden, false); assert.ok(f.dom.mount.querySelectorAll('button,input,select').every(field => field.disabled));
  await f.dom.click('#email-oauth-save'); await f.dom.click('#email-oauth-cancel'); await f.dom.click('#email-oauth-disconnect'); await f.submit();
  assert.equal(f.calls.length, 0);
  value.localManagement = true; value.oauth.available = false; value.oauth.state = 'unavailable'; f.adopt(value); await f.dom.click('#email-oauth-cancel'); await f.submit(); assert.equal(f.calls.length, 0);
});

test('a denied repeat sign-in is not reported as completed just because the prior connection remains saved', async t => {
  const f = fixture(t, { value: registered({ pending: true, connected: true }) });
  f.saved.oauth.authorization.pending = false; f.saved.oauth.lastError = { code: 'EMAIL_OAUTH_DENIED', message: 'The provider did not authorize email access.' };
  await f.timers.fire();
  assert.equal(f.dom.$('#email-oauth-title').textContent, 'Sign-in needs attention'); assert.match(f.receipts.at(-1)[0], /did not authorize/); assert.equal(f.receipts.at(-1)[1], true); assert.equal(f.receipts.some(([message]) => /sign-in completed/i.test(message)), false);
});

test('Microsoft selection removes Google-only credentials and transmits only public-client registration fields', async t => {
  const f = fixture(t, { value: registered() }); await f.dom.input('#email-oauth-client-secret', 'google-only-secret');
  f.dom.$('#email-oauth-provider').value = 'microsoft'; await f.dom.$('#email-oauth-provider').dispatch('change');
  assert.equal(f.dom.$('#email-oauth-client-secret').value, ''); assert.equal(f.dom.$('#email-oauth-client-secret').hidden, true); assert.equal(f.dom.$('#email-oauth-import').hidden, true); assert.equal(f.dom.$('#email-oauth-testing-note').hidden, true);
  await f.dom.input('#email-oauth-client-id', 'fd435896-4c50-4ff6-98c7-63b9d99be8a1'); await f.dom.click('#email-oauth-save');
  assert.deepEqual(Object.keys(f.calls[0].body.config).sort(), ['clientId', 'loginHint', 'provider']); assert.equal(f.calls[0].body.config.provider, 'microsoft'); assert.match(f.dom.$('#email-oauth-guide').getAttribute('href'), /^https:\/\/learn\.microsoft\.com\//);
});

test('Google Desktop file import fills local fields without uploading, saving or starting consent', async t => {
  const f = fixture(t); await f.dom.input('#email-oauth-login-hint', 'my-hint@example.test');
  await f.importFile(JSON.stringify({ installed: { client_id: clientId, client_secret: 'imported-desktop-secret', project_id: 'own-project', redirect_uris: ['http://localhost'] } }));
  assert.equal(f.dom.$('#email-oauth-client-id').value, clientId); assert.equal(f.dom.$('#email-oauth-client-secret').value, 'imported-desktop-secret'); assert.equal(f.dom.$('#email-oauth-login-hint').value, 'my-hint@example.test');
  assert.equal(f.dom.$('#email-oauth-import').value, ''); assert.equal(f.calls.length, 0); assert.equal(f.dom.$('#email-oauth-save').disabled, false); assert.equal(f.dom.$('#email-oauth-client-secret').type, 'password');
  assert.equal(JSON.stringify(f.receipts).includes('imported-desktop-secret'), false);
  const secret = f.dom.$('#email-oauth-client-secret'); f.ui.destroy(); assert.equal(secret.value, '');
});

test('file import rejects web registrations, saved tokens, invalid JSON and large files without changing typed fields', async t => {
  const f = fixture(t); await f.dom.input('#email-oauth-client-id', 'keep-this.apps.googleusercontent.com'); await f.dom.input('#email-oauth-client-secret', 'keep-local-secret');
  for (const source of ['not-json', JSON.stringify({ web: { client_id: clientId, client_secret: 'web-secret' } }), JSON.stringify({ access_token: 'a-secret-token', refresh_token: 'a-refresh-token' }), JSON.stringify({ installed: { client_id: clientId, client_secret: 'desktop-secret', access_token: 'extra-token' } })]) {
    await f.importFile(source); assert.equal(f.dom.$('#email-oauth-client-id').value, 'keep-this.apps.googleusercontent.com'); assert.equal(f.dom.$('#email-oauth-client-secret').value, 'keep-local-secret'); assert.equal(f.receipts.at(-1)[1], true);
  }
  let read = false; await f.importFile('', { size: 32769, text: async () => { read = true; return ''; } });
  assert.equal(read, false); assert.equal(f.calls.length, 0); assert.equal(JSON.stringify(f.receipts).includes('a-secret-token'), false);
});

test('a late imported file cannot overwrite newer typing or repopulate a closed form', async t => {
  const f = fixture(t), first = deferred(), source = JSON.stringify({ installed: { client_id: clientId, client_secret: 'late-import-secret' } });
  const importing = f.importFile(source, { text: () => first.promise }); await turn(); await f.dom.input('#email-oauth-client-id', 'newer-typing.apps.googleusercontent.com'); first.resolve(source); await importing;
  assert.equal(f.dom.$('#email-oauth-client-id').value, 'newer-typing.apps.googleusercontent.com'); assert.equal(f.dom.$('#email-oauth-client-secret').value, '');
  const second = deferred(), secret = f.dom.$('#email-oauth-client-secret'), closingImport = f.importFile(source, { text: () => second.promise }); await turn(); f.ui.destroy(); f.dom.mount.innerHTML = ''; second.resolve(source); await closingImport;
  assert.equal(secret.value, ''); assert.equal(f.calls.length, 0); assert.equal(f.receipts.length, 0);
});

test('the connected account is named only from the provider-verified identity, never from the optional hint', () => {
  const value = registered({ connected: true }).oauth; value.config.loginHint = 'unverified-hint@example.test';
  assert.equal(emailOAuthCopy(value).note.includes('unverified-hint'), false);
  value.identity = { email: 'actual-account@example.test', verifiedAt: '2026-10-20T00:00:00Z' };
  assert.match(emailOAuthCopy(value).note, /actual-account@example\.test/); assert.equal(emailOAuthCopy(value).note.includes('unverified-hint'), false);
});

test('saving advanced setup keeps a separately typed OAuth registration and local compose text intact', async t => {
  const f = fixture(t, { withEmail: true, value: registered() }); await f.open();
  const registration = await f.dom.input('#email-oauth-client-id', 'unsaved-registration.apps.googleusercontent.com');
  await f.dom.input('#email-oauth-client-secret', 'unsaved-form-secret'); await f.dom.input('#email-subject', 'Local subject'); const body = await f.dom.input('#email-body', 'Keep this local message.');
  await f.dom.input('#email-executable', '/another/himalaya'); await f.dom.input('#email-config-path', '/my/mail.toml'); await f.dom.input('#email-account', 'existing-account'); f.dom.$('#email-enabled').checked = true;
  await f.dom.$('#email-config-form').dispatch('submit');
  assert.equal(f.dom.$('#email-oauth-client-id'), registration); assert.equal(registration.value, 'unsaved-registration.apps.googleusercontent.com'); assert.equal(f.dom.$('#email-oauth-client-secret').value, 'unsaved-form-secret');
  assert.equal(f.dom.$('#email-body'), body); assert.equal(body.value, 'Keep this local message.'); assert.equal(f.dom.$('#email-subject').value, 'Local subject'); assert.equal(f.dom.$('#email-oauth-save').disabled, false);
});

test('completed-consent polling preserves unsaved advanced setup and focused local compose fields in the full Email module', async t => {
  const f = fixture(t, { withEmail: true, value: registered({ pending: true }) }); await f.open();
  await f.dom.input('#email-account', 'unsaved-existing-account'); const body = await f.dom.input('#email-body', 'Draft preserved through consent.'); body.focus(); body.setSelectionRange(2, 14, 'backward');
  f.saved.oauth.connected = true; f.saved.oauth.authorization.pending = false; f.saved.oauth.revision++; f.saved.oauth.identity = { email: 'verified@example.test', verifiedAt: '2026-10-20T00:00:00Z' };
  await f.timers.fire();
  assert.equal(f.dom.$('#email-account').value, 'unsaved-existing-account'); assert.equal(f.dom.$('#email-body'), body); assert.equal(f.dom.document.activeElement, body); assert.equal(body.value, 'Draft preserved through consent.'); assert.deepEqual([body.selectionStart, body.selectionEnd, body.selectionDirection], [2, 14, 'backward']);
  assert.equal(f.dom.$('#email-draft-save').disabled, false); assert.equal(f.dom.$('#email-check').disabled, true); assert.equal(f.changes.length, 1); assert.equal(f.timers.timers.size, 0);
});

test('an old poll cannot replace a newer explicit saved-status read in the full Email module', async t => {
  const f = fixture(t, { withEmail: true, value: registered({ pending: true }) }); await f.open(); const old = structuredClone(f.saved), response = deferred(); let reads = 0;
  f.hook((url, request, normal) => url === '/api/email' && ++reads === 1 ? response.promise : normal());
  const poll = f.timers.fire(); await turn(); f.saved.oauth.authorization.pending = false; f.saved.oauth.connected = true;
  await f.dom.click('#email-refresh'); response.resolve(old); await poll;
  assert.equal(f.dom.$('#email-oauth-cancel').hidden, true); assert.match(f.dom.$('#email-oauth-title').textContent, /Signed in with Google/); assert.equal(f.timers.timers.size, 0);
});

test('closing and reopening Email isolates a late OAuth callback from the new view and keeps the compose draft', async t => {
  const f = fixture(t, { withEmail: true, value: registered({ pending: true }) }); await f.open(); await f.dom.input('#email-body', 'A draft across reopening.'); const response = deferred(); let reads = 0;
  f.hook((url, request, normal) => url === '/api/email' && ++reads === 1 ? response.promise : normal());
  const cancelling = f.dom.click('#email-oauth-cancel'); await turn(); f.ui.cancel(); await f.open();
  const body = f.dom.$('#email-body'), receipt = f.dom.$('#email-receipt').textContent; response.resolve(structuredClone(f.saved)); await cancelling;
  assert.equal(body.value, 'A draft across reopening.'); assert.equal(f.dom.$('#email-body'), body); assert.equal(f.dom.$('#email-receipt').textContent, receipt); assert.equal(f.changes.length, 0); assert.equal(f.dom.$('#email-draft-save').disabled, false);
});
