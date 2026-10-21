import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { writeRemoteJson } from './remote-access-auth.mjs';

export const CHATGPT_OAUTH_CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
export const CHATGPT_OAUTH_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
export const CHATGPT_OAUTH_SCOPES = Object.freeze(['read', 'files:read', 'files:write', 'commands:run', 'browser:read', 'browser:write', 'planning:write']);
const PREFIX = '/chatgpt/oauth/';
const RESOURCE_PATH = '/mcp/chatgpt';
const PRM_PATH = '/.well-known/oauth-protected-resource/mcp/chatgpt';
const AS_PATH = '/.well-known/oauth-authorization-server';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^blackice_code_[A-Za-z0-9_-]{43}$/;
const ACCESS = /^blackice_at_[A-Za-z0-9_-]{43}$/;
const REFRESH = /^blackice_rt_[A-Za-z0-9_-]{43}$/;
const MINUTE = 60000, ACCESS_TTL = 15 * MINUTE, GRANT_TTL = 30 * 86400000, CODE_TTL = 90 * 1000;
const MAX_GRANTS = 20, MAX_REQUESTS = 16, MAX_ROTATIONS = 4096, MAX_STATE_BYTES = 8 * 1024 * 1024;
const REFRESH_RETRY_TTL = MINUTE, MAX_REFRESH_RETRIES = 256, MAX_RETRY_BYTES = 1024 * 1024;
const protectedBackends = new Set(['dpapi', 'windows-dpapi', 'keychain', 'macos-keychain', 'gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6', 'secret_service', 'portal_secret']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const digest = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => HASH.test(a || '') && HASH.test(b || '') && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const iso = value => new Date(value).toISOString();
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fail = (message, code = 'CHATGPT_OAUTH_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const oauthFail = (error, description, status = 400) => Object.assign(fail(description, `OAUTH_${error.toUpperCase()}`, status), { oauthError: error });
const scopes = (value, { requested = null } = {}) => {
  const list = value === undefined ? ['read'] : typeof value === 'string' ? value.split(' ') : value;
  if (!Array.isArray(list) || !list.length || list.length > CHATGPT_OAUTH_SCOPES.length || new Set(list).size !== list.length || !list.includes('read') || list.some(scope => !CHATGPT_OAUTH_SCOPES.includes(scope)) || requested && list.some(scope => !requested.includes(scope))) throw oauthFail('invalid_scope', 'Use requested BLACKICE permissions, including read.');
  return CHATGPT_OAUTH_SCOPES.filter(scope => list.includes(scope));
};
const safeGrant = grant => ({ id: grant.id, clientId: grant.clientId, label: grant.label, kind: 'chatgpt', scopes: [...grant.scopes], createdAt: grant.createdAt, expiresAt: grant.expiresAt, lastUsedAt: grant.lastUsedAt });
const json = (res, status, value, headers = {}) => {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(value));
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const consentScript = `const status=document.getElementById('oauth-status');const id=document.body.dataset.request;async function poll(){try{const response=await fetch('/chatgpt/oauth/pending/'+encodeURIComponent(id),{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});const value=await response.json();if(!response.ok){status.textContent=value.error_description||'This authorization window is unavailable. Return to ChatGPT and connect again.';return;}if(value.redirect){location.replace(value.redirect);return;}status.textContent='Waiting for approval in BLACKICE on your computer…';setTimeout(poll,1000);}catch{status.textContent='Connection interrupted. Retrying…';setTimeout(poll,2000);}}poll();`;
const consentCSS = 'html{color-scheme:light dark;font:16px system-ui,sans-serif}body{margin:0;padding:3rem 1.5rem}main{max-width:38rem;margin:auto}h1{font-size:1.8rem}code{display:inline-block;font-size:1.8rem;letter-spacing:.16em;padding:.6rem;border:1px solid currentColor;border-radius:.4rem}p{line-height:1.6}small{opacity:.8}';

/** An owner-approved public OAuth client. No mailbox, account password or model provider is involved. */
export class ChatGPTOAuth extends EventEmitter {
  constructor({ dataDir, origin = null, now = Date.now, fetcher = globalThis.fetch, onRevoked = () => {}, onChange = () => {}, encryptSecret, decryptSecret, storageBackend, isEncryptionAvailable } = {}) {
    super();
    if (typeof dataDir !== 'string' || !dataDir) throw Error('A BLACKICE profile directory is required.');
    Object.assign(this, { now, fetcher, onRevoked, onChange, encryptSecret, decryptSecret, storageBackend, isEncryptionAvailable });
    this.file = path.join(dataDir, 'chatgpt-oauth.json');
    this.retryFile = path.join(dataDir, 'chatgpt-oauth-refresh-cache.json');
    this.refreshRetries = new Map(); this.retryCacheError = null;
    this.origin = null; this.grants = []; this.requests = new Map(); this.codes = new Map(); this.revoked = new Set();
    this.tail = Promise.resolve(); this.epoch = 0; this.closed = false; this.healthy = true; this.error = null; this.initialized = false; this.blocked = false;
    this.clientCache = null; this.clientFetch = null; this.rates = new Map();
    if (origin !== null) this.setOrigin(origin);
  }
  async init() {
    if (this.initialized) return this;
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) throw Error('Invalid credential file.');
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!onlyKeys(value, ['schema', 'grants']) || value.schema !== 1 || !Array.isArray(value.grants) || value.grants.length > MAX_GRANTS) throw Error('Invalid credential store.');
      const ids = new Set(), hashes = new Set();
      for (const grant of value.grants) {
        if (!onlyKeys(grant, ['id', 'clientId', 'label', 'resource', 'scopes', 'createdAt', 'expiresAt', 'lastUsedAt', 'accessTokens', 'refresh']) || !UUID.test(grant.id || '') || ids.has(grant.id) || grant.clientId !== CHATGPT_OAUTH_CLIENT_ID || grant.label !== 'ChatGPT' || !this.validResource(grant.resource) || ![grant.createdAt, grant.expiresAt, grant.lastUsedAt].every(time) || Date.parse(grant.expiresAt) <= Date.parse(grant.createdAt) || !Array.isArray(grant.accessTokens) || grant.accessTokens.length > 4) throw Error('Invalid grant.');
        if (!Array.isArray(grant.scopes)) throw Error('Invalid stored permissions.');
        scopes(grant.scopes); ids.add(grant.id);
        if (!onlyKeys(grant.refresh, ['hash', 'expiresAt', 'usedHashes']) || !HASH.test(grant.refresh.hash || '') || grant.refresh.expiresAt !== grant.expiresAt || !Array.isArray(grant.refresh.usedHashes) || grant.refresh.usedHashes.length > MAX_ROTATIONS) throw Error('Invalid refresh record.');
        for (const hash of [grant.refresh.hash, ...grant.refresh.usedHashes]) { if (!HASH.test(hash || '') || hashes.has(hash)) throw Error('Conflicting credential.'); hashes.add(hash); }
        for (const token of grant.accessTokens) {
          if (!onlyKeys(token, ['hash', 'expiresAt']) || !HASH.test(token.hash || '') || hashes.has(token.hash) || !time(token.expiresAt) || Date.parse(token.expiresAt) > Date.parse(grant.expiresAt)) throw Error('Invalid access record.');
          hashes.add(token.hash);
        }
      }
      this.grants = value.grants.filter(grant => Date.parse(grant.expiresAt) > this.now());
      if (this.origin && this.grants.some(grant => grant.resource !== this.origin + RESOURCE_PATH)) await this.revokeAll();
    } catch (error) { if (error.code !== 'ENOENT') this.unavailable(); }
    this.initialized = true;
    if (this.healthy) await this.restoreRefreshRetries();
    return this;
  }
  initialize() { return this.init(); }
  validResource(resource) {
    try { const url = new URL(resource); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === RESOURCE_PATH && resource === url.origin + RESOURCE_PATH; } catch { return false; }
  }
  setOrigin(origin) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw Error('Use the exact owned HTTPS origin.');
    const changed = this.origin !== null && this.origin !== origin || this.grants.some(grant => grant.resource !== origin + RESOURCE_PATH);
    this.origin = origin;
    if (changed) void this.revokeAll().catch(() => {});
  }
  matches(pathname) { return [AS_PATH, PRM_PATH, '/.well-known/oauth-protected-resource'].includes(pathname) || pathname.startsWith(PREFIX); }
  current() { if (!this.initialized || this.closed || !this.healthy || !this.origin || this.blocked) throw oauthFail('temporarily_unavailable', this.error || 'BLACKICE authorization is unavailable.', 503); }
  unchanged(epoch) { this.current(); if (epoch !== this.epoch) throw oauthFail('access_denied', 'Authorization changed. Connect again.', 409); }
  unavailable() {
    this.healthy = false; this.error = 'ChatGPT authorization records could not be read or saved. Existing records were preserved; restore or repair the file and restart BLACKICE.';
    this.requests.clear(); this.codes.clear(); this.revocationNotice(this.grants.map(grant => grant.id));
  }
  notify() { try { this.emit('updated'); this.onChange(); } catch {} }
  revocationNotice(ids) {
    for (const id of ids) this.revoked.add(id);
    for (const [hash, receipt] of this.refreshRetries) if (ids.includes(receipt.grantId)) this.refreshRetries.delete(hash);
    if (ids.length) { try { this.emit('revoked', [...ids]); const result = this.onRevoked([...ids]); result?.catch?.(() => {}); } catch {} }
    this.notify();
  }
  enqueue(operation) {
    const next = this.tail.catch(() => {}).then(() => { if (this.closed) throw fail('BLACKICE authorization is closing.', 'CHATGPT_OAUTH_CLOSED', 503); return operation(); });
    this.tail = next; return next;
  }
  async persist(grants) {
    if (!this.healthy) throw oauthFail('temporarily_unavailable', this.error, 503);
    try {
      const stat = await fs.lstat(this.file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw Error('Invalid credential target.');
      if (Buffer.byteLength(JSON.stringify({ schema: 1, grants })) > MAX_STATE_BYTES) throw Error('Credential store exceeds its bound.');
      await writeRemoteJson(this.file, { schema: 1, grants }); this.grants = grants;
    } catch { this.unavailable(); throw oauthFail('temporarily_unavailable', this.error, 503); }
  }
  prune() {
    const now = this.now();
    for (const [hash, code] of this.codes) if (code.expiresAt <= now) this.codes.delete(hash);
    for (const [hash, receipt] of this.refreshRetries) if (receipt.expiresAt <= now || this.revoked.has(receipt.grantId) || !this.grants.some(grant => grant.id === receipt.grantId && Date.parse(grant.expiresAt) > now)) this.refreshRetries.delete(hash);
  }
  protectedRefreshRetries() {
    try {
      const backend = typeof this.storageBackend === 'function' ? this.storageBackend() : this.storageBackend;
      return protectedBackends.has(backend) && (typeof this.isEncryptionAvailable === 'function' ? this.isEncryptionAvailable() === true : this.isEncryptionAvailable !== false) && typeof this.encryptSecret === 'function' && typeof this.decryptSecret === 'function';
    } catch { return false; }
  }
  validRefreshReceipt(receipt) {
    const tokens = receipt?.tokens;
    return onlyKeys(receipt, ['grantId', 'consumedHash', 'requestHash', 'replacementHash', 'accessHash', 'createdAt', 'expiresAt', 'accessExpiresAt', 'tokens']) && UUID.test(receipt.grantId || '')
      && [receipt.consumedHash, receipt.requestHash, receipt.replacementHash, receipt.accessHash].every(value => HASH.test(value || ''))
      && [receipt.createdAt, receipt.expiresAt, receipt.accessExpiresAt].every(Number.isFinite) && receipt.expiresAt > receipt.createdAt && receipt.expiresAt <= receipt.createdAt + REFRESH_RETRY_TTL && receipt.accessExpiresAt >= receipt.expiresAt
      && onlyKeys(tokens, ['access_token', 'token_type', 'expires_in', 'refresh_token', 'scope']) && ACCESS.test(tokens.access_token || '') && REFRESH.test(tokens.refresh_token || '') && tokens.token_type === 'Bearer'
      && Number.isInteger(tokens.expires_in) && tokens.expires_in >= 1 && tokens.expires_in <= ACCESS_TTL / 1000 && typeof tokens.scope === 'string'
      && equal(digest(tokens.access_token), receipt.accessHash) && equal(digest(tokens.refresh_token), receipt.replacementHash);
  }
  async restoreRefreshRetries() {
    if (!this.protectedRefreshRetries()) return;
    try {
      const stat = await fs.lstat(this.retryFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RETRY_BYTES) throw Error('Invalid refresh retry envelope.');
      const envelope = JSON.parse(await fs.readFile(this.retryFile, 'utf8'));
      if (!onlyKeys(envelope, ['schema', 'encoding', 'sealed']) || envelope.schema !== 1 || !['string', 'base64'].includes(envelope.encoding) || typeof envelope.sealed !== 'string' || !envelope.sealed) throw Error('Invalid refresh retry envelope.');
      const opened = await this.decryptSecret(envelope.encoding === 'base64' ? Buffer.from(envelope.sealed, 'base64') : envelope.sealed), plaintext = Buffer.isBuffer(opened) ? opened.toString('utf8') : opened;
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > MAX_RETRY_BYTES) throw Error('Invalid refresh retry payload.');
      const value = JSON.parse(plaintext);
      if (!onlyKeys(value, ['schema', 'receipts']) || value.schema !== 1 || !Array.isArray(value.receipts) || value.receipts.length > MAX_REFRESH_RETRIES || value.receipts.some(receipt => !this.validRefreshReceipt(receipt))) throw Error('Invalid refresh retry records.');
      const restored = new Map();
      for (const receipt of value.receipts) {
        const grant = this.grants.find(item => item.id === receipt.grantId);
        // A sidecar is written before the grant transaction. A crash before
        // that commit must never make its uncommitted replacement usable.
        if (!grant || receipt.expiresAt <= this.now() || Date.parse(grant.expiresAt) <= this.now() || !grant.refresh.usedHashes.includes(receipt.consumedHash) || ![grant.refresh.hash, ...grant.refresh.usedHashes].includes(receipt.replacementHash)) continue;
        if (restored.has(receipt.consumedHash)) throw Error('Duplicate refresh retry record.');
        restored.set(receipt.consumedHash, receipt);
      }
      this.refreshRetries = restored;
    } catch (error) {
      if (error.code !== 'ENOENT') this.retryCacheError = 'Protected refresh retry recovery is unavailable. Existing grants remain unchanged.';
      // The optional retry sidecar must not disable valid normal tokens.
    }
  }
  async saveRefreshRetry(receipt) {
    const next = new Map(this.refreshRetries); next.set(receipt.consumedHash, receipt);
    // The existing 120/minute endpoint limit bounds one minute of receipts
    // below this capacity, including requests straddling a rate window.
    if (next.size > MAX_REFRESH_RETRIES) throw oauthFail('temporarily_unavailable', 'Refresh retry storage is busy. Retry the same request shortly.', 503);
    if (!this.protectedRefreshRetries()) return next;
    try {
      const plaintext = JSON.stringify({ schema: 1, receipts: [...next.values()] }), encrypted = await this.encryptSecret(plaintext), sealed = Buffer.isBuffer(encrypted) ? encrypted.toString('base64') : encrypted;
      if (typeof sealed !== 'string' || !sealed || sealed.includes(plaintext) || sealed.includes(receipt.tokens.access_token) || sealed.includes(receipt.tokens.refresh_token) || Buffer.byteLength(sealed) > MAX_RETRY_BYTES - 2048 || Buffer.isBuffer(encrypted) && encrypted.equals(Buffer.from(plaintext))) throw Error('Refresh retry encryption failed.');
      const stat = await fs.lstat(this.retryFile).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw Error('Invalid refresh retry target.');
      await writeRemoteJson(this.retryFile, { schema: 1, encoding: Buffer.isBuffer(encrypted) ? 'base64' : 'string', sealed });
      this.retryCacheError = null; return next;
    } catch { throw oauthFail('temporarily_unavailable', 'The protected refresh response could not be saved. The current token remains valid; retry the same request.', 503); }
  }
  retryRefresh(grant, hash, requestHash) {
    const receipt = this.refreshRetries.get(hash);
    if (!receipt || receipt.grantId !== grant.id || receipt.expiresAt <= this.now()) return null;
    if (!equal(receipt.requestHash, requestHash)) throw oauthFail('invalid_request', 'A refresh retry must use the original resource and scope. The current connection was preserved.');
    const access = grant.accessTokens.find(token => equal(token.hash, receipt.accessHash) && Date.parse(token.expiresAt) > this.now());
    if (!equal(receipt.replacementHash, grant.refresh.hash) || !access || receipt.tokens.scope !== grant.scopes.join(' ')) throw oauthFail('invalid_grant', 'This recent refresh was superseded. Use the most recently returned credentials; the current connection was preserved.');
    return { ...receipt.tokens, expires_in: Math.max(1, Math.floor((Math.min(receipt.accessExpiresAt, Date.parse(access.expiresAt)) - this.now()) / 1000)) };
  }
  pending() {
    this.prune();
    return [...this.requests.values()].filter(request => request.status === 'pending').map(request => ({ id: request.id, displayCode: request.displayCode, clientLabel: 'ChatGPT', clientId: request.clientId, scopes: [...request.scopes], createdAt: iso(request.createdAt), expiresAt: null }));
  }
  status() {
    return { healthy: this.healthy, error: this.error, ready: Boolean(this.initialized && this.origin && this.healthy && !this.closed && !this.blocked), grants: this.grants.filter(grant => this.getClient(grant.id)).map(safeGrant), requests: this.pending(), supportedScopes: [...CHATGPT_OAUTH_SCOPES], defaultScopes: ['read'], clientMetadataUrl: CHATGPT_OAUTH_CLIENT_ID, legacyClientsSupported: false, refreshRetry: { graceSeconds: REFRESH_RETRY_TTL / 1000, persistence: this.protectedRefreshRetries() ? 'protected' : 'memory', recoveryError: this.retryCacheError } };
  }
  getClient(id) {
    if (!this.initialized || this.closed || !this.healthy || this.blocked || !this.origin || this.revoked.has(id)) return null;
    const grant = this.grants.find(item => item.id === id && item.resource === this.origin + RESOURCE_PATH && Date.parse(item.expiresAt) > this.now());
    return grant ? safeGrant(grant) : null;
  }
  isAuthorized(client, { requiredScopes = ['read'] } = {}) { const current = this.getClient(client?.id); return Boolean(current && requiredScopes.every(scope => current.scopes.includes(scope))); }
  approve(id, { scopes: selected } = {}) {
    return this.enqueue(() => {
      this.current(); const request = this.requests.get(id);
      if (!request || request.status !== 'pending' || request.epoch !== this.epoch) throw fail('This connection request is unavailable or was already reviewed.', 'CHATGPT_OAUTH_REQUEST_EXPIRED', 409);
      request.approvedScopes = scopes(selected, { requested: request.scopes }); request.status = 'approved'; this.notify();
      return this.status();
    });
  }
  reject(id) {
    return this.enqueue(async () => {
      const request = this.requests.get(id);
      if (!request || !['pending', 'approved'].includes(request.status)) throw fail('The connection request was not found.', 'CHATGPT_OAUTH_REQUEST_NOT_FOUND', 404);
      const grantId = request.grantId || request.codeHash && this.codes.get(request.codeHash)?.grantId;
      request.status = 'denied'; if (request.codeHash) this.codes.delete(request.codeHash); request.redirect = null;
      if (grantId) { this.revocationNotice([grantId]); await this.persist(this.grants.filter(grant => grant.id !== grantId)); }
      this.notify(); return this.status();
    });
  }
  revoke(id) {
    if (!UUID.test(id || '') || !this.grants.some(grant => grant.id === id)) return Promise.reject(fail('The ChatGPT connection was not found.', 'CHATGPT_OAUTH_GRANT_NOT_FOUND', 404));
    this.revocationNotice([id]);
    return this.enqueue(async () => { await this.persist(this.grants.filter(grant => grant.id !== id)); return this.status(); });
  }
  revokeAll() {
    this.epoch++; this.blocked = true; this.requests.clear(); this.codes.clear(); this.revocationNotice(this.grants.map(grant => grant.id));
    return this.enqueue(async () => { await this.persist([]); this.blocked = false; this.notify(); return this.status(); });
  }
  async authenticateRequest(req) {
    await this.tail.catch(() => {});
    const header = req.headers?.authorization;
    const count = (req.rawHeaders || []).filter((value, index) => index % 2 === 0 && String(value).toLowerCase() === 'authorization').length;
    if (count > 1 || typeof header !== 'string' || !/^Bearer blackice_at_[A-Za-z0-9_-]{43}$/i.test(header)) return null;
    const token = header.slice(7); if (!ACCESS.test(token)) return null;
    const hash = digest(token), now = this.now();
    const grant = this.grants.find(item => this.getClient(item.id) && item.accessTokens.some(access => Date.parse(access.expiresAt) > now && equal(access.hash, hash)));
    if (!grant) return null;
    grant.lastUsedAt = iso(now); return safeGrant(grant);
  }
  challenge(required = ['read'], error = 'invalid_token') {
    const selected = scopes([...new Set(['read', ...required])]);
    const code = error === 'insufficient_scope' ? error : 'invalid_token';
    const description = code === 'insufficient_scope' ? 'Reconnect BLACKICE and approve the requested permissions to continue.' : 'Connect or reconnect BLACKICE to continue.';
    return `Bearer resource_metadata="${this.origin}${PRM_PATH}", error="${code}", error_description="${description}", scope="${selected.join(' ')}"`;
  }
  rate(key, maximum) {
    const now = this.now(); let value = this.rates.get(key);
    if (!value || now - value.at >= MINUTE) { value = { at: now, count: 0 }; this.rates.set(key, value); }
    if (++value.count > maximum) throw oauthFail('temporarily_unavailable', 'Too many authorization requests. Try again shortly.', 429);
  }
  async clientMetadata() {
    if (this.clientCache && this.clientCache.until > this.now()) return this.clientCache.value;
    if (this.clientFetch) return this.clientFetch;
    this.clientFetch = (async () => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000); timer.unref?.();
      try {
        const response = await this.fetcher(CHATGPT_OAUTH_CLIENT_ID, { method: 'GET', redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json' }, signal: controller.signal });
        if (!response.ok || response.url && response.url !== CHATGPT_OAUTH_CLIENT_ID || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw Error('Unverified client metadata.');
        if (Number(response.headers.get('content-length') || 0) > 32768) throw Error('Oversized metadata.');
        const reader = response.body?.getReader(); if (!reader) throw Error('Missing metadata body.');
        const chunks = []; let size = 0;
        while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 32768) { await reader.cancel(); throw Error('Oversized metadata.'); } chunks.push(Buffer.from(value)); }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        // Current ChatGPT CIMD advertises both none and private_key_jwt. Its singular
        // field is a legacy preference, not a restriction when the plural list exists.
        const methods = Object.hasOwn(value || {}, 'token_endpoint_auth_methods_supported') ? value.token_endpoint_auth_methods_supported : [value?.token_endpoint_auth_method];
        if (!object(value) || value.client_id !== CHATGPT_OAUTH_CLIENT_ID || !Array.isArray(value.redirect_uris) || !value.redirect_uris.includes(CHATGPT_OAUTH_REDIRECT) || value.redirect_uris.length > 20 || new Set(value.redirect_uris).size !== value.redirect_uris.length || value.redirect_uris.some(uri => typeof uri !== 'string' || uri.length > 4096) || !Array.isArray(methods) || !methods.length || methods.length > 16 || new Set(methods).size !== methods.length || methods.some(method => typeof method !== 'string' || !/^[a-z_]{1,80}$/.test(method)) || !methods.includes('none') || value.token_endpoint_auth_method !== undefined && (typeof value.token_endpoint_auth_method !== 'string' || !/^[a-z_]{1,80}$/.test(value.token_endpoint_auth_method)) || value.response_types && (!Array.isArray(value.response_types) || !value.response_types.includes('code')) || value.grant_types && (!Array.isArray(value.grant_types) || !value.grant_types.includes('authorization_code'))) throw Error('Unverified client metadata.');
        this.clientCache = { value: { clientId: CHATGPT_OAUTH_CLIENT_ID, redirectUri: CHATGPT_OAUTH_REDIRECT }, until: this.now() + 5 * MINUTE };
        return this.clientCache.value;
      } catch { throw oauthFail('invalid_client', 'The fixed ChatGPT client metadata could not be verified. Try connecting again.', 400); }
      finally { clearTimeout(timer); this.clientFetch = null; }
    })();
    return this.clientFetch;
  }
  params(search) {
    const params = search instanceof URLSearchParams ? search : new URLSearchParams(search);
    const result = Object.create(null);
    for (const [key, value] of params) { if (Object.hasOwn(result, key) || key.length > 80 || value.length > 4096) throw oauthFail('invalid_request', 'Use one bounded value for each OAuth parameter.'); result[key] = value; }
    return result;
  }
  async form(req) {
    if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')) throw oauthFail('invalid_request', 'Send an application/x-www-form-urlencoded request.', 415);
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 16384) throw oauthFail('invalid_request', 'The OAuth form exceeds 16 KiB.', 413); chunks.push(Buffer.from(chunk)); }
    return this.params(Buffer.concat(chunks).toString('utf8'));
  }
  cookieName(id) { return `__Secure-blackice-oauth-${id}`; }
  browserOwns(req, request) {
    const header = req.headers?.cookie; if (typeof header !== 'string' || header.length > 16384) return false;
    const name = this.cookieName(request.id), values = header.split(';').map(item => item.trim()).filter(item => item.startsWith(name + '='));
    return values.length === 1 && SECRET.test(values[0].slice(name.length + 1)) && equal(digest(values[0].slice(name.length + 1)), request.browserHash);
  }
  expiredBrowserCookies(req, retiredId = null) {
    const names = new Set();
    if (UUID.test(retiredId || '') && !this.requests.has(retiredId)) names.add(this.cookieName(retiredId));
    const header = req.headers?.cookie;
    if (typeof header === 'string' && header.length <= 16384) for (const part of header.split(';')) {
      const match = part.trim().match(/^(__Secure-blackice-oauth-([a-f0-9-]{36}))=/);
      if (match && UUID.test(match[2]) && !this.requests.has(match[2])) names.add(match[1]);
    }
    return [...names].map(name => name + '=; Path=' + PREFIX + '; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
  }
  callback(request, values) {
    const url = new URL(request.redirectUri);
    for (const [key, value] of Object.entries({ ...values, state: request.state, iss: this.origin })) url.searchParams.set(key, value);
    return url.href;
  }
  async authorize(req, params, epoch) {
    this.rate('authorize', 30);
    if (params.client_id !== CHATGPT_OAUTH_CLIENT_ID || params.redirect_uri !== CHATGPT_OAUTH_REDIRECT) throw oauthFail('invalid_client', 'Use the supported ChatGPT client and its exact redirect URI.');
    await this.clientMetadata(); this.unchanged(epoch);
    const base = { clientId: params.client_id, redirectUri: params.redirect_uri, state: params.state || '' };
    try {
      if (params.response_type !== 'code' || params.response_mode && params.response_mode !== 'query') throw oauthFail('unsupported_response_type', 'Use an authorization code response.');
      if (typeof params.state !== 'string' || !params.state.length || params.state.length > 2048 || /[\x00-\x1f\x7f]/.test(params.state)) throw oauthFail('invalid_request', 'A bounded OAuth state is required.');
      if (params.code_challenge_method !== 'S256' || !SECRET.test(params.code_challenge || '')) throw oauthFail('invalid_request', 'PKCE S256 is required.');
      if (params.resource !== this.origin + RESOURCE_PATH) throw oauthFail('invalid_target', 'Use this BLACKICE MCP resource.');
      if (params.prompt === 'none') throw oauthFail('interaction_required', 'Approval in BLACKICE is required.');
      const requested = scopes(params.scope); this.prune();
      const identity = digest(JSON.stringify({ ...base, challenge: params.code_challenge, scopes: requested, resource: params.resource }));
      // A completed request's code is single-use; a browser reload must not replay it.
      const existing = [...this.requests.values()].find(request => request.identity === identity && !request.grantId && request.status !== 'denied' && (!request.redirect || this.codes.has(request.codeHash)) && this.browserOwns(req, request));
      if (existing) return { request: existing };
      // Pending owner decisions have no deadline. Reclaim reviewed records only
      // when the fixed bound needs room; keep undecided requests and live codes.
      let retiredId = null;
      if (this.requests.size >= MAX_REQUESTS) {
        const reviewed = [...this.requests.values()];
        const retired = reviewed.find(request => request.status === 'denied' || request.grantId || request.codeHash && !this.codes.has(request.codeHash))
          || reviewed.find(request => request.status === 'approved' && !request.redirect);
        if (retired) { this.requests.delete(retired.id); retiredId = retired.id; }
      }
      if (this.requests.size >= MAX_REQUESTS || this.grants.filter(grant => Date.parse(grant.expiresAt) > this.now()).length >= MAX_GRANTS) throw oauthFail('temporarily_unavailable', 'Review pending requests or revoke an old ChatGPT connection in BLACKICE before adding another.', 429);
      const secret = randomBytes(32).toString('base64url'), now = this.now(), id = randomUUID();
      const request = { ...base, id, identity, epoch, challenge: params.code_challenge, resource: params.resource, scopes: requested, browserHash: digest(secret), displayCode: randomBytes(4).toString('hex').toUpperCase(), createdAt: now, expiresAt: null, status: 'pending', redirect: null };
      this.requests.set(id, request); this.notify();
      return { request, expiredCookies: this.expiredBrowserCookies(req, retiredId), cookie: `${this.cookieName(id)}=${secret}; Path=${PREFIX}; Secure; HttpOnly; SameSite=Strict` };
    } catch (error) { if (error.oauthError) return { redirect: this.callback(base, { error: error.oauthError, error_description: error.message }) }; throw error; }
  }
  poll(req, id, epoch) {
    return this.enqueue(() => {
      this.unchanged(epoch); const request = this.requests.get(id);
      if (!request || !this.browserOwns(req, request)) throw oauthFail('access_denied', 'This authorization window is unavailable. Connect again from ChatGPT.', 403);
      if (request.epoch !== this.epoch) throw oauthFail('access_denied', 'Authorization changed. Connect again.', 409);
      if (request.status === 'denied') return { redirect: this.callback(request, { error: 'access_denied', error_description: 'The BLACKICE owner declined this connection.' }) };
      if (request.status !== 'approved') return { status: 'pending', expiresAt: null };
      if (request.redirect && (!this.codes.has(request.codeHash) || this.codes.get(request.codeHash).expiresAt <= this.now())) return { redirect: this.callback(request, { error: 'access_denied', error_description: 'The authorization code expired. Connect again.' }) };
      if (!request.redirect) {
        const code = `blackice_code_${randomBytes(32).toString('base64url')}`, hash = digest(code);
        request.codeHash = hash;
        this.codes.set(hash, { requestId: request.id, clientId: request.clientId, redirectUri: request.redirectUri, resource: request.resource, challenge: request.challenge, scopes: [...request.approvedScopes], expiresAt: this.now() + CODE_TTL, epoch, grantId: null });
        request.redirect = this.callback(request, { code });
      }
      return { redirect: request.redirect };
    });
  }
  async token(params, epoch) {
    this.rate('token', 120);
    if (params.client_id !== CHATGPT_OAUTH_CLIENT_ID || params.client_secret !== undefined || params.client_assertion !== undefined) throw oauthFail('invalid_client', 'Use the supported public ChatGPT client without a secret.');
    return this.enqueue(async () => {
      this.unchanged(epoch); this.prune();
      if (params.grant_type === 'authorization_code') {
        if (params.resource !== this.origin + RESOURCE_PATH) throw oauthFail('invalid_target', 'Use this BLACKICE MCP resource.');
        if (!CODE.test(params.code || '') || !/^[A-Za-z0-9._~-]{43,128}$/.test(params.code_verifier || '')) throw oauthFail('invalid_grant', 'The authorization code or verifier is invalid.');
        const code = this.codes.get(digest(params.code));
        const challenge = createHash('sha256').update(params.code_verifier).digest('base64url');
        if (!code || code.epoch !== epoch || code.expiresAt <= this.now() || code.clientId !== params.client_id || code.redirectUri !== params.redirect_uri || code.resource !== params.resource || !equal(digest(code.challenge), digest(challenge))) throw oauthFail('invalid_grant', 'The authorization code or verifier is invalid.');
        if (code.grantId) { this.revocationNotice([code.grantId]); await this.persist(this.grants.filter(grant => grant.id !== code.grantId)); throw oauthFail('invalid_grant', 'This authorization code was already used. Connect again.'); }
        if (this.grants.filter(grant => Date.parse(grant.expiresAt) > this.now()).length >= MAX_GRANTS) throw oauthFail('temporarily_unavailable', 'Revoke an old connection before adding another.', 429);
        const now = this.now(), grant = { id: randomUUID(), clientId: params.client_id, label: 'ChatGPT', resource: code.resource, scopes: [...code.scopes], createdAt: iso(now), expiresAt: iso(now + GRANT_TTL), lastUsedAt: iso(now), accessTokens: [], refresh: null };
        const tokens = this.mint(grant, []); await this.persist([...this.grants.filter(item => Date.parse(item.expiresAt) > now), grant]); code.grantId = grant.id;
        const request = this.requests.get(code.requestId); if (request) request.grantId = grant.id;
        this.unchanged(epoch); this.notify(); return tokens;
      }
      if (params.grant_type === 'refresh_token') {
        if (!REFRESH.test(params.refresh_token || '')) throw oauthFail('invalid_grant', 'The refresh token is invalid.');
        const hash = digest(params.refresh_token), original = this.grants.find(grant => equal(grant.refresh.hash, hash) || grant.refresh.usedHashes.some(value => equal(value, hash)));
        if (!original || !this.getClient(original.id) || original.clientId !== params.client_id) throw oauthFail('invalid_grant', 'The refresh token is invalid or expired.');
        if (params.resource !== undefined && params.resource !== original.resource) throw oauthFail('invalid_target', 'Use the originally authorized BLACKICE MCP resource.');
        const requestHash = digest(JSON.stringify({ resource: original.resource, scope: params.scope === undefined ? null : scopes(params.scope) }));
        if (!equal(original.refresh.hash, hash)) {
          const retry = this.retryRefresh(original, hash, requestHash); if (retry) return retry;
          this.revocationNotice([original.id]); await this.persist(this.grants.filter(grant => grant.id !== original.id)); throw oauthFail('invalid_grant', 'Refresh token replay revoked this connection. Connect again.');
        }
        if (original.refresh.usedHashes.length >= MAX_ROTATIONS) { this.revocationNotice([original.id]); await this.persist(this.grants.filter(grant => grant.id !== original.id)); throw oauthFail('invalid_grant', 'This connection reached its renewal limit. Connect again.'); }
        const grant = structuredClone(original); if (params.scope !== undefined) grant.scopes = scopes(params.scope, { requested: grant.scopes });
        const tokens = this.mint(grant, [...grant.refresh.usedHashes, grant.refresh.hash]), createdAt = this.now(), accessExpiresAt = Date.parse(grant.accessTokens.at(-1).expiresAt);
        const receipt = { grantId: grant.id, consumedHash: hash, requestHash, replacementHash: grant.refresh.hash, accessHash: digest(tokens.access_token), createdAt, expiresAt: Math.min(createdAt + REFRESH_RETRY_TTL, accessExpiresAt), accessExpiresAt, tokens };
        const retries = await this.saveRefreshRetry(receipt);
        this.unchanged(epoch); if (!this.getClient(original.id)) throw oauthFail('invalid_grant', 'This connection was revoked. Connect again.');
        await this.persist(this.grants.map(item => item.id === grant.id ? grant : item)); this.unchanged(epoch);
        if (!this.getClient(grant.id)) throw oauthFail('invalid_grant', 'This connection was revoked. Connect again.');
        this.refreshRetries = retries;
        this.notify(); return tokens;
      }
      throw oauthFail('unsupported_grant_type', 'Use authorization_code or refresh_token.');
    });
  }
  mint(grant, usedHashes) {
    const access = `blackice_at_${randomBytes(32).toString('base64url')}`, refresh = `blackice_rt_${randomBytes(32).toString('base64url')}`;
    const now = this.now(), expiresAt = Math.min(now + ACCESS_TTL, Date.parse(grant.expiresAt));
    grant.accessTokens = [...grant.accessTokens.filter(item => Date.parse(item.expiresAt) > now).slice(-3), { hash: digest(access), expiresAt: iso(expiresAt) }];
    grant.refresh = { hash: digest(refresh), expiresAt: grant.expiresAt, usedHashes }; grant.lastUsedAt = iso(now);
    return { access_token: access, token_type: 'Bearer', expires_in: Math.max(1, Math.floor((expiresAt - now) / 1000)), refresh_token: refresh, scope: grant.scopes.join(' ') };
  }
  async revokeToken(params) {
    this.rate('revoke', 120);
    if (params.client_id !== CHATGPT_OAUTH_CLIENT_ID) throw oauthFail('invalid_client', 'Use the supported ChatGPT client.');
    if (typeof params.token !== 'string' || params.token.length > 200) throw oauthFail('invalid_request', 'Provide the token to revoke.');
    const hash = digest(params.token);
    const grant = this.grants.find(item => item.clientId === params.client_id && (equal(item.refresh.hash, hash) || item.refresh.usedHashes.some(value => equal(value, hash)) || item.accessTokens.some(value => equal(value.hash, hash))));
    if (grant) await this.revoke(grant.id);
    return {};
  }
  metadata(pathname) {
    if (pathname !== AS_PATH) return { resource: this.origin + RESOURCE_PATH, authorization_servers: [this.origin], bearer_methods_supported: ['header'], scopes_supported: [...CHATGPT_OAUTH_SCOPES] };
    return { issuer: this.origin, authorization_endpoint: this.origin + PREFIX + 'authorize', token_endpoint: this.origin + PREFIX + 'token', revocation_endpoint: this.origin + PREFIX + 'revoke', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: [...CHATGPT_OAUTH_SCOPES], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true };
  }
  async handle(req, res, { enabled = false } = {}) {
    try {
      if (!this.origin) throw oauthFail('temporarily_unavailable', 'The owned HTTPS route is unavailable.', 503);
      const url = new URL(req.url, this.origin), epoch = this.epoch;
      if (url.origin !== this.origin || url.hash) throw oauthFail('invalid_request', 'Use the exact owned HTTPS origin.');
      if ([AS_PATH, PRM_PATH, '/.well-known/oauth-protected-resource'].includes(url.pathname)) {
        if (req.method !== 'GET' || url.search) return json(res, 405, { error: 'invalid_request' }, { Allow: 'GET' });
        return json(res, 200, this.metadata(url.pathname));
      }
      if (url.pathname === PREFIX + 'consent.js' || url.pathname === PREFIX + 'consent.css') {
        if (req.method !== 'GET' || url.search) return json(res, 405, { error: 'invalid_request' }, { Allow: 'GET' });
        res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); return res.end(url.pathname.endsWith('.js') ? consentScript : consentCSS);
      }
      if (!enabled) throw oauthFail('access_denied', 'The ChatGPT connector is disabled in BLACKICE.', 503);
      this.current();
      if (url.pathname === PREFIX + 'authorize') {
        if (req.method !== 'GET') return json(res, 405, { error: 'invalid_request' }, { Allow: 'GET' });
        const result = await this.authorize(req, this.params(url.searchParams), epoch);
        if (result.redirect) { res.writeHead(302, { Location: result.redirect, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); return res.end(); }
        const request = result.request;
        const cookies = result.cookie ? [result.cookie, ...(result.expiredCookies || [])] : [];
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', ...(cookies.length ? { 'Set-Cookie': cookies.length === 1 ? cookies[0] : cookies } : {}) });
        return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect ChatGPT to BLACKICE</title><link rel="stylesheet" href="${PREFIX}consent.css"><script src="${PREFIX}consent.js" defer></script></head><body data-request="${request.id}"><main><h1>Approve in BLACKICE</h1><p>Open BLACKICE on your computer, then Settings → ChatGPT connector. Match this request code before choosing permissions:</p><code>${escape(request.displayCode)}</code><p>Client: ChatGPT</p><p>Requested permissions: ${escape(request.scopes.join(', '))}</p><p id="oauth-status" role="status">Waiting for approval in BLACKICE on your computer…</p><small>This window returns to ChatGPT automatically after your decision. No account password is requested.</small></main></body></html>`);
      }
      const match = url.pathname.match(/^\/chatgpt\/oauth\/pending\/([a-f0-9-]{36})$/);
      if (match) {
        if (req.method !== 'GET' || url.search) return json(res, 405, { error: 'invalid_request' }, { Allow: 'GET' });
        if (req.headers.origin && req.headers.origin !== this.origin) throw oauthFail('access_denied', 'Use the authorization window that created this request.', 403);
        const value = await this.poll(req, match[1], epoch);
        const expiredCookies = this.expiredBrowserCookies(req);
        return json(res, 200, value, expiredCookies.length ? { 'Set-Cookie': expiredCookies } : {});
      }
      if ([PREFIX + 'token', PREFIX + 'revoke'].includes(url.pathname)) {
        if (req.method !== 'POST' || url.search) return json(res, 405, { error: 'invalid_request' }, { Allow: 'POST' });
        if (req.headers.authorization !== undefined) throw oauthFail('invalid_client', 'This public client does not use HTTP client authentication.');
        const params = await this.form(req); this.unchanged(epoch);
        return json(res, 200, url.pathname.endsWith('/token') ? await this.token(params, epoch) : await this.revokeToken(params));
      }
      return json(res, 404, { error: 'invalid_request', error_description: 'OAuth endpoint not found.' });
    } catch (error) { return json(res, error.status || 500, { error: error.oauthError || 'server_error', error_description: error.oauthError ? error.message : 'BLACKICE authorization could not complete the request.' }, error.status === 429 ? { 'Retry-After': '60' } : {}); }
  }
  async close() {
    if (this.closed) return;
    // Shutdown denies authentication immediately, but is not a durable revocation.
    // The application closes its executor separately; do not schedule new ledger
    // cancellation work after that executor has already finished closing.
    this.epoch++; this.closed = true; this.requests.clear(); this.codes.clear(); this.refreshRetries.clear(); this.notify(); await this.tail.catch(() => {});
  }
}
