import { EventEmitter } from 'node:events';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';

const PROVIDERS = Object.freeze({
  gmail: Object.freeze({
    name: 'Google', authorization: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'], backend: 'gmail', profile: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
  }),
  microsoft: Object.freeze({
    name: 'Microsoft', authorization: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/User.Read', 'offline_access'], backend: 'msgraph',
    profile: 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName',
  }),
});
const DEFAULT_CONFIG = Object.freeze({ provider: 'gmail', clientId: '', loginHint: '' });
const MAX_STORE = 256 * 1024;
const MAX_RESPONSE = 128 * 1024;
const TOKEN_ENV = 'BLACKICE_EMAIL_ACCESS_TOKEN';
export const MANAGED_EMAIL_ACCOUNT = 'blackice';
const helperPath = fileURLToPath(new URL('../scripts/email-oauth-token.mjs', import.meta.url));
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const fail = (message, code = 'EMAIL_OAUTH_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const safeError = error => error?.code?.startsWith('EMAIL_OAUTH_') || error?.code === 'ABORT_ERR'
  ? error : fail('The email sign-in request could not finish. Try again from Settings.', 'EMAIL_OAUTH_FAILED', 502);
const tokenText = value => typeof value === 'string' && value.length > 0 && value.length <= 65536 && /^[\x21-\x7e]+$/.test(value);
const checkSignal = signal => { if (signal?.aborted) throw fail('Email authorization request cancelled.', 'ABORT_ERR', 409); };
const text = (value, label, maximum = 1000) => {
  if (typeof value !== 'string' || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) throw fail(`${label} must be text on one line, at most ${maximum} characters.`);
  return value.trim();
};
function configInput(value, previous = DEFAULT_CONFIG) {
  if (!plain(value) || Object.keys(value).some(key => !['provider', 'clientId', 'clientSecret', 'loginHint'].includes(key))) throw fail('Use provider, clientId, optional clientSecret and loginHint for email sign-in.');
  const config = { ...previous };
  if (value.provider !== undefined) config.provider = value.provider;
  if (!Object.hasOwn(PROVIDERS, config.provider)) throw fail('Choose Gmail or Microsoft for managed email sign-in.');
  if (value.clientId !== undefined) config.clientId = text(value.clientId, 'OAuth client ID', 400);
  if (config.clientId && (config.provider === 'gmail'
    ? !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(config.clientId)
    : !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(config.clientId))) throw fail('Enter the client ID from your own provider application registration.');
  if (value.loginHint !== undefined) config.loginHint = text(value.loginHint, 'Account hint', 254);
  if (config.loginHint && !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(config.loginHint)) throw fail('Use an email address for the optional account hint.');
  return config;
}
function scoped(provider, values) {
  const list = typeof values === 'string' ? values.split(/\s+/).filter(Boolean) : values;
  if (!Array.isArray(list) || list.length > 20 || list.some(item => typeof item !== 'string')) throw fail('The provider returned an invalid permission response.', 'EMAIL_OAUTH_PROTOCOL', 502);
  const canonical = list.map(item => provider === 'microsoft' ? item.replace(/^https:\/\/graph\.microsoft\.com\//, '') : item);
  const allowed = provider === 'gmail' ? new Set(PROVIDERS.gmail.scopes) : new Set(['Mail.Read', 'User.Read', 'offline_access', 'openid', 'profile', 'email']);
  if (!canonical.includes(provider === 'gmail' ? PROVIDERS.gmail.scopes[0] : 'Mail.Read') || canonical.some(item => !allowed.has(item))) throw fail('The provider did not grant the requested read-only mail permissions. Use a separate BLACKICE application registration and reconnect.', 'EMAIL_OAUTH_SCOPE', 409);
  return [...new Set(list)];
}
function secretInput(value, provider) {
  if (!plain(value) || Object.keys(value).some(key => !['clientSecret', 'tokens'].includes(key))) throw fail('Saved email credentials are invalid.', 'EMAIL_OAUTH_STORAGE', 503);
  if (typeof value.clientSecret !== 'string' || value.clientSecret.length > 4000 || /[\x00-\x1f\x7f]/.test(value.clientSecret)) throw fail('Saved email credentials are invalid.', 'EMAIL_OAUTH_STORAGE', 503);
  let tokens = null;
  if (value.tokens !== null && value.tokens !== undefined) {
    const saved = value.tokens;
    if (!plain(saved) || !tokenText(saved.refreshToken) || typeof saved.authorizedAt !== 'string' || !Number.isFinite(Date.parse(saved.authorizedAt))) throw fail('Saved email credentials are invalid.', 'EMAIL_OAUTH_STORAGE', 503);
    if (!plain(saved.identity) || typeof saved.identity.email !== 'string' || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(saved.identity.email) || saved.identity.email.length > 254 || !Number.isFinite(Date.parse(saved.identity.verifiedAt))) throw fail('Saved email account identity is invalid.', 'EMAIL_OAUTH_STORAGE', 503);
    tokens = { refreshToken: saved.refreshToken, accessToken: '', expiresAt: 0, scope: scoped(provider, saved.scope), authorizedAt: saved.authorizedAt, identity: clone(saved.identity) };
  }
  return { clientSecret: value.clientSecret, tokens };
}
async function atomicWrite(filename, value, shouldCommit) {
  const temporary = path.join(path.dirname(filename), `.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(value, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    if (shouldCommit && !shouldCommit()) throw fail('Email sign-in changed before it could be saved.', 'EMAIL_OAUTH_CHANGED', 409);
    await fs.rename(temporary, filename);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    if (error?.code === 'EMAIL_OAUTH_CHANGED') throw error;
    throw fail('Email sign-in changes could not be saved. Existing credentials were preserved.', 'EMAIL_OAUTH_STORAGE', 503);
  }
}
function awaitWithSignal(promise, signal) {
  checkSignal(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(fail('Email authorization request cancelled.', 'ABORT_ERR', 409)); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}
async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw fail('The mail provider returned an empty response.', 'EMAIL_OAUTH_PROTOCOL', 502);
  const parts = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > MAX_RESPONSE) throw fail('The mail provider response exceeded its limit.', 'EMAIL_OAUTH_PROTOCOL', 502);
      parts.push(value);
    }
    const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!plain(value)) throw new Error('object required');
    return value;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error?.code === 'EMAIL_OAUTH_PROTOCOL' ? error : fail('The mail provider returned an invalid response.', 'EMAIL_OAUTH_PROTOCOL', 502);
  } finally { reader.releaseLock(); }
}
function callbackResponse(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>BLACKICE email</title><style>body{background:#101722;color:#edf3fa;font:16px system-ui;margin:10vh auto;padding:24px;max-width:540px;line-height:1.6}h1{font-size:23px}</style><h1>BLACKICE email</h1><p>${message}</p><p>You can close this tab and return to BLACKICE.</p></html>`);
}

/** Local managed authorization. Neither the UI nor mail tools receive tokens. */
export class EmailOAuthManager extends EventEmitter {
  constructor({ dataDir, encryptSecret, decryptSecret, openExternal, tokenRuntimeExecutable = process.execPath,
    fetchImpl = globalThis.fetch, flowTimeoutMs = 8 * 60 * 1000, requestTimeoutMs = 25000 } = {}) {
    super();
    if (!dataDir) throw fail('An email data directory is required.');
    if (typeof tokenRuntimeExecutable !== 'string' || !path.isAbsolute(tokenRuntimeExecutable)) throw fail('The email token runtime must have an absolute executable path.');
    this.directory = path.join(path.resolve(dataDir), 'agent-email');
    this.filename = path.join(this.directory, 'oauth.json');
    this.configPath = path.join(this.directory, 'managed-oauth.toml');
    this.account = MANAGED_EMAIL_ACCOUNT;
    this.encryptSecret = encryptSecret; this.decryptSecret = decryptSecret; this.openExternal = openExternal;
    this.tokenRuntimeExecutable = tokenRuntimeExecutable; this.fetch = fetchImpl;
    this.flowTimeoutMs = flowTimeoutMs; this.requestTimeoutMs = requestTimeoutMs;
    this.config = { ...DEFAULT_CONFIG }; this.secrets = { clientSecret: '', tokens: null };
    this.savedBytes = null;
    this.revision = 0; this.generation = 0; this.flowEpoch = 0; this.flow = null; this.lastError = null; this.storageError = null;
    this.writeChain = Promise.resolve(); this.refreshPromise = null; this.requests = new Set(); this.closed = false;
    this.callbackOperations = new Set();
  }
  async init() {
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const stat = await fs.stat(this.filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!stat) return this;
      if (!stat.isFile() || stat.size > MAX_STORE || !this.secureStorageAvailable()) throw new Error('saved storage unavailable');
      const bytes = await fs.readFile(this.filename, 'utf8'), value = JSON.parse(bytes);
      if (value?.schema !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.sealed !== 'string' || !value.sealed || value.sealed.length > MAX_STORE) throw new Error('saved schema invalid');
      const config = configInput(value.config);
      const secret = secretInput(JSON.parse(await this.decryptSecret(value.sealed)), config.provider);
      this.config = config; this.secrets = secret; this.revision = value.revision; this.savedBytes = bytes;
    } catch {
      this.storageError = { code: 'EMAIL_OAUTH_STORAGE', message: 'Saved email sign-in could not be unlocked. Its file has been preserved. Open the same desktop profile to reconnect or restore it.', at: now() };
    }
    return this;
  }
  secureStorageAvailable() { return typeof this.encryptSecret === 'function' && typeof this.decryptSecret === 'function'; }
  assertAvailable() {
    if (this.closed) throw fail('Email sign-in is closed.', 'EMAIL_OAUTH_CLOSED', 503);
    if (this.storageError) throw fail(this.storageError.message, 'EMAIL_OAUTH_STORAGE', 503);
    if (!this.secureStorageAvailable()) throw fail('Managed email sign-in requires BLACKICE desktop encrypted storage. External Himalaya configurations remain available.', 'EMAIL_OAUTH_STORAGE_UNAVAILABLE', 409);
  }
  status() {
    const available = !this.closed && !this.storageError && this.secureStorageAvailable();
    const configured = available && !!this.config.clientId;
    const connected = configured && !!this.secrets.tokens;
    return { available, configured, connected, state: !available ? 'unavailable' : this.flow ? 'authorizing' : this.lastError ? 'error' : connected ? 'connected' : configured ? 'authorization_required' : 'not_configured',
      revision: this.storageError ? null : this.revision, provider: this.config.provider,
      config: { ...clone(this.config), clientSecretConfigured: !!this.secrets.clientSecret },
      authorization: { pending: !!this.flow, expiresAt: this.flow ? new Date(this.flow.expiresAt).toISOString() : null },
      scopes: [...PROVIDERS[this.config.provider].scopes], grantedScopes: this.secrets.tokens ? [...this.secrets.tokens.scope] : [],
      authorizedAt: this.secrets.tokens?.authorizedAt || null,
      identity: this.secrets.tokens?.identity ? clone(this.secrets.tokens.identity) : null,
      lastError: this.storageError || this.lastError ? clone(this.storageError || this.lastError) : null,
      note: 'Sign in using your own provider application registration. Mail access is read-only; drafts stay local. A saved grant is distinct from a successful mailbox read.',
    };
  }
  changed() { this.emit('updated', this.status()); }
  mutate(fn) {
    const pending = this.writeChain.catch(() => {}).then(() => { this.assertAvailable(); return fn(); });
    this.writeChain = pending.catch(() => {}); return pending;
  }
  async persist(config, secrets, revision, shouldCommit) {
    // Access tokens only live in memory; a headless restart obtains a fresh one.
    const saved = { clientSecret: secrets.clientSecret, tokens: secrets.tokens ? {
      refreshToken: secrets.tokens.refreshToken, scope: [...secrets.tokens.scope], authorizedAt: secrets.tokens.authorizedAt, identity: clone(secrets.tokens.identity),
    } : null };
    let sealed;
    try { sealed = await this.encryptSecret(JSON.stringify(saved)); }
    catch { throw fail('Email sign-in could not be encrypted. Nothing was saved.', 'EMAIL_OAUTH_STORAGE', 503); }
    if (typeof sealed !== 'string' || !sealed || sealed.length > MAX_STORE) throw fail('Email encryption returned an invalid result. Nothing was saved.', 'EMAIL_OAUTH_STORAGE', 503);
    if (shouldCommit && !shouldCommit()) throw fail('Email sign-in changed before it could be saved.', 'EMAIL_OAUTH_CHANGED', 409);
    const bytes = JSON.stringify({ schema: 1, revision, config, sealed }, null, 2), previous = this.savedBytes;
    await atomicWrite(this.filename, bytes, shouldCommit);
    // Cancellation can arrive while rename is in progress. Restore the exact
    // previous encrypted bytes before a cancellation receipt is returned.
    if (shouldCommit && !shouldCommit()) {
      try { if (previous === null) await fs.unlink(this.filename); else await atomicWrite(this.filename, previous); }
      catch {
        this.storageError = { code: 'EMAIL_OAUTH_STORAGE', message: 'A cancelled email sign-in could not be restored on disk. Managed email is unavailable until its saved state is repaired.', at: now() };
        throw fail(this.storageError.message, this.storageError.code, 503);
      }
      throw fail('Email sign-in was cancelled while it was being saved.', 'EMAIL_OAUTH_CHANGED', 409);
    }
    this.savedBytes = bytes;
    this.config = config; this.secrets = secrets; this.revision = revision;
  }
  invalidate() {
    this.generation += 1;
    this.stopFlow();
    for (const controller of this.requests) controller.abort();
    this.emit('invalidated', { generation: this.generation });
  }
  configure(input, { expectedRevision } = {}) {
    return this.mutate(async () => {
      if (expectedRevision !== undefined && expectedRevision !== this.revision) throw fail('Email sign-in settings changed. Reload before saving.', 'EMAIL_OAUTH_REVISION_CONFLICT', 409);
      const config = configInput(input, this.config);
      const sameClient = config.provider === this.config.provider && config.clientId === this.config.clientId;
      const clientSecret = input.clientSecret === undefined ? sameClient ? this.secrets.clientSecret : '' : text(input.clientSecret, 'OAuth client secret', 4000);
      if (config.provider === 'microsoft' && clientSecret) throw fail('Microsoft desktop sign-in uses a public client without a client secret.');
      if (JSON.stringify(config) === JSON.stringify(this.config) && clientSecret === this.secrets.clientSecret) return this.status();
      this.invalidate();
      await this.persist(config, { clientSecret, tokens: null }, this.revision + 1);
      this.lastError = null; this.changed(); return this.status();
    });
  }
  async ensureManagedConfig() {
    this.assertAvailable();
    const provider = PROVIDERS[this.config.provider];
    const command = JSON.stringify([this.tokenRuntimeExecutable, helperPath]);
    const body = `# Managed by BLACKICE. Contains no access or refresh token.\n[accounts.${MANAGED_EMAIL_ACCOUNT}]\ndefault = true\n${provider.backend}.auth.token.command = ${command}\n`;
    const current = await fs.readFile(this.configPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw fail('The managed email configuration is unavailable.', 'EMAIL_OAUTH_STORAGE', 503); });
    if (current !== body) await atomicWrite(this.configPath, body);
    return { configPath: this.configPath, account: MANAGED_EMAIL_ACCOUNT };
  }
  async begin({ expectedRevision } = {}) {
    const requestedEpoch = this.flowEpoch;
    return this.mutate(async () => {
      if (requestedEpoch !== this.flowEpoch) throw fail('Email sign-in was cancelled before it opened.', 'ABORT_ERR', 409);
      if (expectedRevision !== undefined && expectedRevision !== this.revision) throw fail('Email sign-in settings changed. Reload before connecting.', 'EMAIL_OAUTH_REVISION_CONFLICT', 409);
      if (!this.config.clientId) throw fail('Add your own provider OAuth client ID before signing in.', 'EMAIL_OAUTH_NOT_CONFIGURED', 409);
      if (typeof this.openExternal !== 'function') throw fail('Open BLACKICE desktop to start email sign-in in your system browser.', 'EMAIL_OAUTH_BROWSER_UNAVAILABLE', 409);
      this.stopFlow(); this.lastError = null;
      const config = clone(this.config), provider = PROVIDERS[config.provider], generation = this.generation, flowEpoch = this.flowEpoch;
      const flow = { state: randomBytes(32).toString('base64url'), verifier: randomBytes(48).toString('base64url'),
        expiresAt: Date.now() + this.flowTimeoutMs, controller: new AbortController(), generation, config,
        clientSecret: this.secrets.clientSecret, server: null, timer: null, consumed: false, path: config.provider === 'microsoft' ? '/' : '/oauth/callback' };
      const server = http.createServer((req, res) => {
        const operation = this.acceptCallback(flow, req, res).catch(() => { if (!res.headersSent) callbackResponse(res, 500, 'Email sign-in could not finish. Check Settings in BLACKICE.'); else res.end(); });
        this.callbackOperations.add(operation); void operation.finally(() => this.callbackOperations.delete(operation));
      });
      server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000;
      flow.server = server;
      try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
        if (this.closed || generation !== this.generation || flowEpoch !== this.flowEpoch) throw fail('Email sign-in was cancelled before it opened.', 'ABORT_ERR', 409);
        server.on('error', () => { if (this.flow === flow) { this.lastError = { code: 'EMAIL_OAUTH_CALLBACK', message: 'The email sign-in callback stopped. Try connecting again.', at: now() }; this.stopFlow(); this.changed(); } });
        const port = server.address().port;
        flow.redirectUri = `http://${config.provider === 'microsoft' ? 'localhost' : '127.0.0.1'}:${port}${flow.path}`;
        flow.host = new URL(flow.redirectUri).host;
        const authorization = new URL(provider.authorization);
        for (const [key, value] of Object.entries({ client_id: config.clientId, redirect_uri: flow.redirectUri, response_type: 'code', scope: provider.scopes.join(' '),
          state: flow.state, code_challenge: createHash('sha256').update(flow.verifier).digest('base64url'), code_challenge_method: 'S256',
          ...(config.provider === 'gmail' ? { access_type: 'offline', prompt: 'consent select_account' } : { prompt: 'select_account' }),
          ...(config.loginHint ? { login_hint: config.loginHint } : {}) })) authorization.searchParams.set(key, value);
        this.flow = flow;
        flow.timer = setTimeout(() => { if (this.flow === flow) { this.lastError = { code: 'EMAIL_OAUTH_EXPIRED', message: 'Email sign-in expired. Start it again from Settings.', at: now() }; this.stopFlow(); this.changed(); } }, this.flowTimeoutMs);
        flow.timer.unref?.();
        await this.openExternal(authorization.toString());
        if (this.flow === flow) this.changed();
        return this.status();
      } catch (error) {
        if (this.flow === flow) this.stopFlow(); else { try { server.close(); } catch {} }
        if (error?.code === 'ABORT_ERR') throw error;
        this.lastError = { code: 'EMAIL_OAUTH_BROWSER', message: 'The sign-in browser could not open. Try again from BLACKICE desktop.', at: now() };
        this.changed(); throw fail(this.lastError.message, this.lastError.code, 503);
      }
    });
  }
  stopFlow() {
    this.flowEpoch += 1;
    const flow = this.flow; if (!flow) return;
    this.flow = null; clearTimeout(flow.timer); flow.controller.abort();
    try { flow.server.close(); flow.server.closeIdleConnections?.(); } catch {}
  }
  async cancel() { this.stopFlow(); await Promise.allSettled([...this.callbackOperations, this.writeChain]); this.lastError = null; this.changed(); return this.status(); }
  async drain() { await this.cancel(); await Promise.allSettled([this.refreshPromise, this.writeChain]); }
  async acceptCallback(flow, req, res) {
    if (this.flow !== flow || flow.consumed || Date.now() >= flow.expiresAt) return callbackResponse(res, 410, 'This sign-in request has expired or has already been used.');
    if (req.method !== 'GET' || req.headers.host !== flow.host || !['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(req.socket.remoteAddress)) return callbackResponse(res, 400, 'This sign-in response was not accepted.');
    let url; try { url = new URL(req.url, flow.redirectUri); } catch { return callbackResponse(res, 400, 'This sign-in response was not accepted.'); }
    const states = url.searchParams.getAll('state'), codes = url.searchParams.getAll('code'), errors = url.searchParams.getAll('error');
    if (url.origin !== new URL(flow.redirectUri).origin || url.pathname !== flow.path || states.length !== 1 || Buffer.byteLength(states[0]) !== Buffer.byteLength(flow.state) || !timingSafeEqual(Buffer.from(states[0]), Buffer.from(flow.state)) || codes.length > 1 || errors.length > 1 || (codes.length && errors.length)) return callbackResponse(res, 400, 'This sign-in response did not match the request.');
    if (errors.length) {
      this.lastError = { code: 'EMAIL_OAUTH_DENIED', message: 'The provider did not authorize email access. You can reconnect from Settings.', at: now() };
      callbackResponse(res, 400, 'Email access was not authorized.'); this.stopFlow(); this.changed(); return;
    }
    if (codes.length !== 1 || !tokenText(codes[0])) return callbackResponse(res, 400, 'The provider did not return a valid authorization code.');
    flow.consumed = true;
    try {
      const response = await this.tokenRequest(flow.config, flow.clientSecret, { grant_type: 'authorization_code', code: codes[0], redirect_uri: flow.redirectUri, code_verifier: flow.verifier }, flow.controller.signal);
      const tokens = this.parseTokens(response, flow.config.provider, null);
      tokens.identity = await this.accountIdentity(flow.config, tokens.accessToken, flow.controller.signal);
      await this.mutate(async () => {
        if (this.flow !== flow || flow.generation !== this.generation || flow.controller.signal.aborted) throw fail('Email sign-in changed before completion.', 'EMAIL_OAUTH_CHANGED', 409);
        await this.persist(clone(flow.config), { clientSecret: flow.clientSecret, tokens }, this.revision + 1,
          () => this.flow === flow && flow.generation === this.generation && !flow.controller.signal.aborted && !this.closed);
        this.generation += 1; this.emit('invalidated', { generation: this.generation }); this.lastError = null;
      });
      callbackResponse(res, 200, 'Email sign-in is saved. Return to BLACKICE to check mailbox access.');
      this.stopFlow(); this.changed();
    } catch (error) {
      if (this.flow === flow) { const safe = safeError(error); this.lastError = { code: safe.code, message: safe.message, at: now() }; }
      callbackResponse(res, 400, 'Email sign-in could not finish. Check Settings in BLACKICE.');
      if (this.flow === flow) { this.stopFlow(); this.changed(); }
    }
  }
  async tokenRequest(config, clientSecret, fields, signal) {
    checkSignal(signal);
    const controller = new AbortController(); this.requests.add(controller);
    const active = AbortSignal.any([controller.signal, AbortSignal.timeout(this.requestTimeoutMs), ...(signal ? [signal] : [])]);
    try {
      const body = new URLSearchParams({ ...fields, client_id: config.clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) });
      const response = await this.fetch(PROVIDERS[config.provider].token, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, signal: active });
      const value = await boundedJson(response);
      checkSignal(active);
      if (!response.ok || value.error) {
        if (['invalid_grant', 'interaction_required', 'consent_required'].includes(value.error)) throw fail('The saved email authorization is no longer valid. Reconnect in Settings.', 'EMAIL_OAUTH_AUTH_REQUIRED', 409);
        if (['invalid_client', 'unauthorized_client'].includes(value.error)) throw fail('The provider rejected the application registration. Check its client ID, desktop redirect and optional Google client secret.', 'EMAIL_OAUTH_CLIENT', 409);
        if (value.error === 'invalid_scope') throw fail('The provider rejected the read-only mail permission. Check the application registration.', 'EMAIL_OAUTH_SCOPE', 409);
        if (value.error === 'access_denied') throw fail('The provider did not authorize email access. Check the account or organization policy.', 'EMAIL_OAUTH_DENIED', 409);
        throw fail('The mail provider could not complete authorization. Try again later.', 'EMAIL_OAUTH_PROVIDER', 502);
      }
      return value;
    } catch (error) {
      if (signal?.aborted || controller.signal.aborted) throw fail('Email authorization request cancelled.', 'ABORT_ERR', 409);
      if (active.aborted) throw fail('The mail provider authorization request timed out.', 'EMAIL_OAUTH_TIMEOUT', 504);
      throw safeError(error);
    } finally { this.requests.delete(controller); }
  }
  async accountIdentity(config, accessToken, signal) {
    const controller = new AbortController(); this.requests.add(controller);
    const active = AbortSignal.any([controller.signal, AbortSignal.timeout(this.requestTimeoutMs), ...(signal ? [signal] : [])]);
    try {
      const response = await this.fetch(PROVIDERS[config.provider].profile, { method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }, signal: active });
      const value = await boundedJson(response); checkSignal(active);
      const email = config.provider === 'gmail' ? value.emailAddress : value.mail || value.userPrincipalName;
      if (!response.ok || typeof email !== 'string' || email.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email) || /[\x00-\x1f\x7f]/.test(email)) throw fail('Email sign-in could not verify the account profile. Check that the provider API and read permissions are enabled for your application.', 'EMAIL_OAUTH_IDENTITY', 409);
      return { email, verifiedAt: now() };
    } catch (error) {
      if (signal?.aborted || controller.signal.aborted) throw fail('Email authorization request cancelled.', 'ABORT_ERR', 409);
      if (active.aborted) throw fail('The account profile request timed out.', 'EMAIL_OAUTH_TIMEOUT', 504);
      throw safeError(error);
    } finally { this.requests.delete(controller); }
  }
  parseTokens(response, provider, previous) {
    if (!tokenText(response.access_token) || String(response.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(Number(response.expires_in)) || Number(response.expires_in) < 1 || Number(response.expires_in) > 366 * 86400) throw fail('The provider returned an invalid token response.', 'EMAIL_OAUTH_PROTOCOL', 502);
    const refreshToken = response.refresh_token === undefined ? previous?.refreshToken : response.refresh_token;
    if (!tokenText(refreshToken)) throw fail('The provider did not grant background access. Reconnect and allow offline access for this application.', 'EMAIL_OAUTH_REFRESH_REQUIRED', 409);
    const scope = scoped(provider, response.scope ?? previous?.scope ?? PROVIDERS[provider].scopes);
    return { accessToken: response.access_token, refreshToken, expiresAt: Date.now() + Number(response.expires_in) * 1000, scope, authorizedAt: previous?.authorizedAt || now(), identity: previous?.identity ? clone(previous.identity) : null };
  }
  async getAccessToken({ signal } = {}) {
    this.assertAvailable(); checkSignal(signal);
    if (!this.config.clientId) throw fail('Configure your own provider application before email sign-in.', 'EMAIL_OAUTH_NOT_CONFIGURED', 409);
    if (!this.secrets.tokens) throw fail('Sign in to email from Settings before reading a mailbox.', 'EMAIL_OAUTH_AUTH_REQUIRED', 409);
    if (this.secrets.tokens.accessToken && this.secrets.tokens.expiresAt > Date.now() + 60000) return this.secrets.tokens.accessToken;
    if (!this.refreshPromise) {
      const generation = this.generation, config = clone(this.config), secrets = clone(this.secrets);
      const refresh = async () => {
        try {
          const response = await this.tokenRequest(config, secrets.clientSecret, { grant_type: 'refresh_token', refresh_token: secrets.tokens.refreshToken, ...(config.provider === 'microsoft' ? { scope: PROVIDERS.microsoft.scopes.join(' ') } : {}) });
          const tokens = this.parseTokens(response, config.provider, secrets.tokens);
          await this.mutate(async () => {
            if (generation !== this.generation) throw fail('Email authorization changed during refresh.', 'EMAIL_OAUTH_CHANGED', 409);
            await this.persist(config, { clientSecret: secrets.clientSecret, tokens }, this.revision);
            this.lastError = null; this.changed();
          });
          return tokens.accessToken;
        } catch (error) {
          const safe = safeError(error);
          if (generation === this.generation && !this.closed) {
            let errorGeneration = generation;
            if (safe.code === 'EMAIL_OAUTH_AUTH_REQUIRED') {
              try {
                await this.mutate(async () => {
                  if (generation !== this.generation) return;
                  await this.persist(clone(this.config), { clientSecret: this.secrets.clientSecret, tokens: null }, this.revision + 1);
                  this.generation += 1; this.emit('invalidated', { generation: this.generation });
                  errorGeneration = this.generation;
                });
              } catch {
                if (generation !== this.generation || this.closed) throw safe;
                // A revoked grant must not remain "connected" because clearing
                // its disk record failed. Preserve that file for recovery while
                // making the current runtime fail closed and retiring evidence.
                this.secrets = { clientSecret: this.secrets.clientSecret, tokens: null };
                this.storageError = { code: 'EMAIL_OAUTH_STORAGE', message: 'The expired email authorization could not be removed from encrypted storage. Managed email is unavailable until its saved state is repaired.', at: now() };
                this.invalidate(); this.changed();
                throw fail(this.storageError.message, this.storageError.code, 503);
              }
            }
            if (errorGeneration === this.generation && !this.closed) { this.lastError = { code: safe.code, message: safe.message, at: now() }; this.changed(); }
          }
          throw safe;
        }
      };
      this.refreshPromise = refresh().finally(() => { this.refreshPromise = null; });
    }
    return awaitWithSignal(this.refreshPromise, signal);
  }
  async commandContext({ signal } = {}) {
    const generation = this.generation;
    await this.ensureManagedConfig();
    const token = await this.getAccessToken({ signal });
    checkSignal(signal);
    if (generation !== this.generation) throw fail('Email authorization changed before the mailbox request.', 'EMAIL_OAUTH_CHANGED', 409);
    // Electron's supported run-as-node mode uses the same installed executable.
    // These variables belong only to this bounded child; no global env mutation.
    return { configPath: this.configPath, account: this.account, generation,
      environment: { [TOKEN_ENV]: token, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: undefined } };
  }
  disconnect() {
    return this.mutate(async () => {
      this.invalidate();
      await this.persist(clone(this.config), { clientSecret: this.secrets.clientSecret, tokens: null }, this.revision + 1);
      this.lastError = null; this.changed(); return this.status();
    });
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.invalidate();
    await Promise.allSettled([this.writeChain, this.refreshPromise, ...this.callbackOperations]);
    this.secrets = { clientSecret: '', tokens: null };
  }
}
