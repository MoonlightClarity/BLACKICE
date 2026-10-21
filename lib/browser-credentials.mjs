import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const BROWSER_CREDENTIAL_PROFILE = 'persist:relay-agent-browser-v2';
export const BROWSER_CREDENTIAL_LIMITS = Object.freeze({ entries: 2000, requests: 10000, bytes: 16 * 1024 * 1024, importBytes: 1024 * 1024, importRows: 1000, password: 1024 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
export const credentialError = (message, code = 'CREDENTIAL_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
export const credentialCheck = signal => { if (signal?.aborted) throw credentialError('Credential operation cancelled.', 'ABORT_ERR', 409); };
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const now = () => new Date().toISOString();
const identifier = (value, label = 'identifier') => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw credentialError(`Use a valid ${label}.`); return value; };
export const credentialRequestId = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) throw credentialError('Use a bounded request identifier.'); return value; };
const line = (value, maximum, optional = false) => { if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value) || !optional && !value.trim()) throw credentialError('Use bounded single-line credential metadata.'); return value.trim(); };
const secret = value => { if (typeof value !== 'string' || !value.length || value.length > BROWSER_CREDENTIAL_LIMITS.password || value.includes('\0')) throw credentialError('Use a nonempty password within the supported size limit.'); return value; };
export function credentialOrigin(value, { allowPath = false } = {}) {
  let url; try { if (typeof value !== 'string' || value.length > 2048 || value !== value.trim()) throw Error(); url = new URL(value); } catch { throw credentialError('Use an exact HTTPS website origin.'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || !allowPath && (url.pathname !== '/' || url.search || url.hash)) throw credentialError('Use an exact HTTPS website origin without a path, credentials, query, or fragment.');
  return url.origin;
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const credentialDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const protectedBackends = new Set(['dpapi', 'windows-dpapi', 'keychain', 'macos-keychain', 'gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6', 'secret_service', 'portal_secret']);
const dead = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

/** Internal shared storage. Plaintext exists only while an owned operation runs. */
export class CredentialEncryptedStore {
  constructor({ dataDir, profileId = BROWSER_CREDENTIAL_PROFILE, name, encryptSecret, decryptSecret, storageBackend, isEncryptionAvailable, isClosing = () => false, io = fs, lockTimeoutMs = 2500, empty, validate } = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof profileId !== 'string' || !profileId || profileId.length > 160 || !['vault', 'mirror'].includes(name)) throw credentialError('Use an absolute credential folder and a known profile.');
    this.profileId = profileId; this.namespace = name; this.profileKey = credentialDigest(profileId).slice(0, 24);
    this.directory = path.join(dataDir, 'browser-credentials', this.profileKey); this.file = path.join(this.directory, `${name}.json`);
    Object.assign(this, { encryptSecret, decryptSecret, storageBackend, isEncryptionAvailable, isClosing, io, lockTimeoutMs, empty, validate });
    this.tail = Promise.resolve(); this.ready = null; this.closed = false; this.seen = false; this.lastError = null;
  }
  security() {
    try {
      const backend = typeof this.storageBackend === 'function' ? this.storageBackend() : this.storageBackend;
      const available = typeof this.isEncryptionAvailable === 'function' ? this.isEncryptionAvailable() === true : this.isEncryptionAvailable !== false;
      return { available: available && protectedBackends.has(backend) && typeof this.encryptSecret === 'function' && typeof this.decryptSecret === 'function', backend: protectedBackends.has(backend) ? backend : null };
    } catch { return { available: false, backend: null }; }
  }
  assertAvailable(signal) {
    credentialCheck(signal);
    if (this.closed || this.isClosing()) throw credentialError('The credential manager is closing.', 'CREDENTIAL_CLOSED', 503);
    if (!this.security().available) throw credentialError('Protected operating-system credential storage is unavailable. Nothing was saved or filled.', 'CREDENTIAL_STORAGE_UNAVAILABLE', 503);
  }
  async init() {
    if (!this.ready) this.ready = (async () => {
      await this.io.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const info = await this.io.lstat(this.directory), real = await this.io.realpath(this.directory);
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(real, this.directory)) throw credentialError('The credential storage folder is not an ordinary owned directory.', 'CREDENTIAL_STORAGE', 503);
      return this;
    })();
    return this.ready;
  }
  async read(signal) {
    this.assertAvailable(signal); await this.init();
    try {
      let bytes;
      try {
        const info = await this.io.lstat(this.file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > BROWSER_CREDENTIAL_LIMITS.bytes) throw Error();
        bytes = await this.io.readFile(this.file, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT' && !this.seen) {
          try { await this.io.lstat(`${this.file}.bak`); } catch (backup) { if (backup.code === 'ENOENT') { this.lastError = null; return this.empty(); } }
        }
        throw error;
      }
      const envelope = JSON.parse(bytes);
      if (!keys(envelope, ['schema', 'profileId', 'namespace', 'revision', 'encoding', 'sealed']) || envelope.schema !== 1 || envelope.profileId !== this.profileId || envelope.namespace !== this.namespace || !['string', 'base64'].includes(envelope.encoding) || typeof envelope.sealed !== 'string' || !envelope.sealed) throw Error();
      const decoded = await this.decryptSecret(envelope.encoding === 'base64' ? Buffer.from(envelope.sealed, 'base64') : envelope.sealed);
      const plaintext = Buffer.isBuffer(decoded) ? decoded.toString('utf8') : decoded;
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > BROWSER_CREDENTIAL_LIMITS.bytes) throw Error();
      const state = JSON.parse(plaintext);
      if (state.profileId !== this.profileId || state.namespace !== this.namespace || state.revision !== envelope.revision) throw Error();
      this.validate(state); this.assertAvailable(signal); this.seen = true; this.lastError = null; return state;
    } catch (error) {
      if (['ABORT_ERR', 'CREDENTIAL_CLOSED', 'CREDENTIAL_STORAGE_UNAVAILABLE'].includes(error.code)) throw error;
      this.lastError = { code: 'CREDENTIAL_STORAGE', message: 'Saved credentials could not be unlocked or read. Existing files were preserved.' };
      throw credentialError(this.lastError.message, this.lastError.code, 503);
    }
  }
  async atomic(file, bytes, signal, ownership) {
    const temporary = `${file}.${randomUUID()}.tmp`; let handle;
    try {
      handle = await this.io.open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      this.assertAvailable(signal); await ownership(); await this.io.rename(temporary, file);
    } finally { await handle?.close().catch(() => {}); await this.io.rm(temporary, { force: true }).catch(() => {}); }
  }
  async write(state, signal, ownership) {
    this.assertAvailable(signal); this.validate(state);
    const plaintext = JSON.stringify(state);
    if (Buffer.byteLength(plaintext) > BROWSER_CREDENTIAL_LIMITS.bytes / 2) throw credentialError('The encrypted credential store reached its size limit.', 'CREDENTIAL_LIMIT', 413);
    try {
      const encrypted = await this.encryptSecret(plaintext);
      const sealed = Buffer.isBuffer(encrypted) ? encrypted.toString('base64') : encrypted;
      if (typeof sealed !== 'string' || !sealed || sealed === plaintext || sealed.includes(plaintext) || Buffer.isBuffer(encrypted) && encrypted.equals(Buffer.from(plaintext)) || Buffer.byteLength(sealed) > BROWSER_CREDENTIAL_LIMITS.bytes - 2048) throw Error();
      const bytes = JSON.stringify({ schema: 1, profileId: this.profileId, namespace: this.namespace, revision: state.revision, encoding: Buffer.isBuffer(encrypted) ? 'base64' : 'string', sealed });
      let previous = null; try { previous = await this.io.readFile(this.file); } catch (error) { if (error.code !== 'ENOENT' || this.seen) throw error; }
      if (previous !== null) await this.atomic(`${this.file}.bak`, previous, signal, ownership);
      await this.atomic(this.file, bytes, signal, ownership); this.seen = true; this.lastError = null;
    } catch (error) {
      if (['ABORT_ERR', 'CREDENTIAL_CLOSED', 'CREDENTIAL_STORAGE_UNAVAILABLE', 'CREDENTIAL_LOCK_LOST'].includes(error.code)) throw error;
      throw credentialError('Credentials could not be encrypted and saved. No credential use was performed.', 'CREDENTIAL_STORAGE', 503);
    }
  }
  async publishLock(file, token, signal) {
    this.assertAvailable(signal); const temporary = `${file}.${randomUUID()}.tmp`; let handle, published = false;
    try {
      handle = await this.io.open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync(); this.assertAvailable(signal);
      await this.io.link(temporary, file); published = true; return handle;
    } finally { if (!published) await handle?.close(); await this.io.rm(temporary, { force: true }).catch(() => {}); }
  }
  async releaseLock(file, handle, token) { await handle.close(); try { if (JSON.parse(await this.io.readFile(file, 'utf8')).token === token) await this.io.unlink(file); } catch {} }
  async acquireLock(file, token, signal, depth = 0) {
    const busy = () => credentialError('The credential store is busy in another process. Retry this same request after it settles.', 'CREDENTIAL_BUSY', 409);
    if (depth > 12) throw busy();
    try { return await this.publishLock(file, token, signal); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    let raw, owner;
    try { const info = await this.io.lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw Error(); raw = await this.io.readFile(file, 'utf8'); owner = JSON.parse(raw); } catch { throw busy(); }
    if (!dead(owner.pid) || typeof owner.token !== 'string') throw busy();
    const claim = `${file}.reclaim-${credentialDigest(raw).slice(0, 24)}`, handle = await this.acquireLock(claim, token, signal, depth + 1);
    try { if (await this.io.readFile(file, 'utf8') !== raw || !dead(owner.pid)) throw busy(); this.assertAvailable(signal); await this.io.unlink(file); return await this.publishLock(file, token, signal); }
    finally { await this.releaseLock(claim, handle, token); }
  }
  run(operation, { signal, beforeCommit } = {}) {
    const pending = this.tail.catch(() => {}).then(async () => {
      this.assertAvailable(signal); await this.init(); const lock = `${this.file}.lock`, token = randomUUID(), deadline = Date.now() + this.lockTimeoutMs; let handle;
      while (true) { try { handle = await this.acquireLock(lock, token, signal); break; } catch (error) { if (error.code !== 'CREDENTIAL_BUSY' || Date.now() >= deadline) throw error; await delay(15, undefined, signal ? { signal } : undefined); } }
      const ownership = async () => { this.assertAvailable(signal); if (beforeCommit) await beforeCommit({ signal }); this.assertAvailable(signal); let owner; try { owner = JSON.parse(await this.io.readFile(lock, 'utf8')); } catch {} if (owner?.token !== token || owner?.pid !== process.pid) throw credentialError('Credential write ownership changed. Nothing further was dispatched.', 'CREDENTIAL_LOCK_LOST', 409); };
      try { const state = await this.read(signal); return await operation(state, async next => this.write(next, signal, ownership)); }
      finally { await this.releaseLock(lock, handle, token); }
    });
    this.tail = pending; return pending;
  }
  async close() { this.closed = true; await this.tail.catch(() => {}); }
}

const metadata = entry => { const { password, ...safe } = entry; return copy(safe); };
const freshVault = profileId => ({ schema: 1, namespace: 'vault', profileId, revision: 0, entries: [], requests: [], updatedAt: null });
function validateVault(state) {
  if (!object(state) || state.schema !== 1 || state.namespace !== 'vault' || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.entries) || state.entries.length > BROWSER_CREDENTIAL_LIMITS.entries || !Array.isArray(state.requests) || state.requests.length > BROWSER_CREDENTIAL_LIMITS.requests) throw Error('Invalid credential store');
  const ids = new Set(), logins = new Set();
  for (const entry of state.entries) {
    if (!keys(entry, ['credentialId', 'revision', 'origin', 'username', 'label', 'source', 'createdAt', 'updatedAt', 'password']) || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || !['generated', 'saved', 'imported'].includes(entry.source)) throw Error('Invalid credential entry');
    identifier(entry.credentialId); if (credentialOrigin(entry.origin) !== entry.origin) throw Error(); line(entry.username, 320, true); line(entry.label, 160, true); secret(entry.password);
    const login = JSON.stringify([entry.origin, entry.username]); if (ids.has(entry.credentialId) || logins.has(login)) throw Error(); ids.add(entry.credentialId); logins.add(login);
    if (!Number.isFinite(Date.parse(entry.createdAt)) || !Number.isFinite(Date.parse(entry.updatedAt))) throw Error();
  }
  const requests = new Set();
  for (const request of state.requests) { if (!object(request) || typeof request.ownerId !== 'string' || !/^[a-f0-9]{64}$/.test(request.digest) || !object(request.result)) throw Error(); credentialRequestId(request.requestId); const key = JSON.stringify([request.ownerId, request.requestId]); if (requests.has(key)) throw Error(); requests.add(key); }
}
function requireLocal(options) { if (options?.source !== 'user') throw credentialError('This credential operation is available only from the local password manager.', 'CREDENTIAL_LOCAL_ONLY', 403); }
function expectedRevision(state, value) { if (!Number.isSafeInteger(value) || value !== state.revision) throw Object.assign(credentialError('Saved passwords changed. Reload and review the edit before saving.', 'CREDENTIAL_REVISION_CONFLICT', 409), { currentRevision: state.revision }); }
const requestOwner = value => identifier(value ?? 'local', 'request owner');
function previousRequest(state, ownerId, requestId, digest) { const previous = state.requests.find(item => item.ownerId === ownerId && item.requestId === requestId); if (!previous) return null; if (previous.digest !== digest) throw credentialError('This request identifier was already used for different credential data.', 'CREDENTIAL_REQUEST_CONFLICT', 409); return { ...copy(previous.result), existing: true }; }
function rememberRequest(state, ownerId, requestId, digest, result) { if (state.requests.length >= BROWSER_CREDENTIAL_LIMITS.requests) throw credentialError('The credential request history is full. Nothing was changed.', 'CREDENTIAL_LIMIT', 413); state.requests.push({ ownerId, requestId, digest, result: copy(result) }); }
function generatedPassword(length) {
  if (!Number.isInteger(length) || length < 16 || length > 128) throw credentialError('Generated passwords must contain between 16 and 128 characters.');
  const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%*-_=+?'], all = groups.join(''), result = groups.map(group => group[randomInt(group.length)]);
  while (result.length < length) result.push(all[randomInt(all.length)]);
  for (let i = result.length - 1; i > 0; i--) { const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]]; }
  return result.join('');
}
function parseCSV(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > BROWSER_CREDENTIAL_LIMITS.importBytes) throw credentialError('Choose a password CSV file no larger than 1 MiB.');
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  const add = () => { row.push(field); field = ''; closed = false; if (row.length > 30) throw credentialError('The password CSV has too many columns.'); };
  const end = () => { add(); if (row.some(value => value !== '')) rows.push(row); row = []; if (rows.length > BROWSER_CREDENTIAL_LIMITS.importRows + 1) throw credentialError('Import at most 1000 passwords at a time.'); };
  value = value.replace(/^\uFEFF/, '');
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quoted) { if (char === '"') { if (value[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } } else field += char; }
    else if (char === ',') add();
    else if (char === '\n' || char === '\r') { if (char === '\r' && value[i + 1] === '\n') i++; end(); }
    else if (char === '"' && !field && !closed) quoted = true;
    else { if (closed || char === '"') throw credentialError('The password CSV contains an invalid quoted field.'); field += char; }
    if (field.length > 4096) throw credentialError('A password CSV field exceeds its supported size.');
  }
  if (quoted) throw credentialError('The password CSV contains an unfinished quoted field.');
  if (field || row.length || closed) end();
  if (rows.length < 2) throw credentialError('Choose a CSV with a header and at least one password.');
  const header = rows.shift().map(value => value.trim().toLowerCase()), column = header.indexOf('url') >= 0 ? header.indexOf('url') : header.indexOf('origin') >= 0 ? header.indexOf('origin') : header.indexOf('hostname'), username = header.indexOf('username'), password = header.indexOf('password'), label = header.indexOf('name');
  if (new Set(header).size !== header.length || [column, username, password].some(index => index < 0)) throw credentialError('The CSV needs unique url, username, and password columns.');
  return rows.map((row, index) => { try { if (row.length !== header.length) throw Error(); return { origin: credentialOrigin(row[column], { allowPath: true }), username: line(row[username], 320, true), password: secret(row[password]), label: label >= 0 ? line(row[label], 160, true) : '' }; } catch { throw credentialError(`Password CSV row ${index + 2} has an unsupported origin or invalid fields. No rows were imported.`); } });
}

export class BrowserCredentialVault extends EventEmitter {
  constructor(options = {}) {
    super(); const profileId = options.profileId || BROWSER_CREDENTIAL_PROFILE;
    this.profileId = profileId; this.onChange = options.onChange || (() => {});
    this.store = new CredentialEncryptedStore({ ...options, profileId, name: 'vault', empty: () => freshVault(profileId), validate: validateVault });
  }
  async init() { try { await this.store.init(); await this.store.read(); } catch {} return this; }
  changed(value) { const event = { profileId: this.profileId, vaultRevision: value.vaultRevision ?? value.revision }; try { this.onChange(event); } catch {} for (const listener of this.rawListeners('changed')) { try { listener.call(this, event); } catch {} } }
  async status() {
    let state, error; try { state = await this.store.read(); } catch (cause) { error = { code: /^CREDENTIAL_[A-Z_]+$/.test(cause?.code || '') ? cause.code : 'CREDENTIAL_STORAGE', message: 'Protected saved credentials are unavailable. Existing files were preserved.' }; }
    const available = Boolean(state), capabilities = Object.fromEntries(['generate', 'save', 'delete', 'import', 'use'].map(key => [key, available]));
    return { available, healthy: available, profileId: this.profileId, revision: state?.revision ?? null, entries: state ? state.entries.map(metadata) : [], lastError: error || null, capabilities };
  }
  async list({ origin } = {}) { const wanted = origin === undefined ? null : credentialOrigin(origin), state = await this.store.read(); return state.entries.filter(entry => !wanted || entry.origin === wanted).map(metadata); }
  async generate(input, { ownerId = 'local', signal, beforeCommit } = {}) {
    if (!keys(input, ['origin', 'username', 'requestId', 'label', 'length'])) throw credentialError('Use the generated-credential fields only.');
    const data = { origin: credentialOrigin(input.origin), username: line(input.username ?? '', 320, true), label: line(input.label ?? '', 160, true), length: input.length ?? 24 }, requestId = credentialRequestId(input.requestId), owner = requestOwner(ownerId), digest = credentialDigest({ action: 'generate', ...data });
    // Validate the policy before looking up a request; generate only inside the lock.
    if (!Number.isInteger(data.length) || data.length < 16 || data.length > 128) throw credentialError('Generated passwords must contain between 16 and 128 characters.');
    if (beforeCommit !== undefined && typeof beforeCommit !== 'function') throw credentialError('Credential generation requires a valid host authorization callback.');
    const result = await this.store.run(async (state, persist) => {
      if (beforeCommit) await beforeCommit({ signal }); this.store.assertAvailable(signal);
      const prior = previousRequest(state, owner, requestId, digest); if (prior) return prior;
      if (state.entries.some(entry => entry.origin === data.origin && entry.username === data.username)) throw credentialError('A saved login already exists for this origin and username. Use that handle or explicitly update it.', 'CREDENTIAL_EXISTS', 409);
      if (state.entries.length >= BROWSER_CREDENTIAL_LIMITS.entries) throw credentialError('The password manager reached its entry limit.', 'CREDENTIAL_LIMIT', 413);
      const at = now(), entry = { credentialId: `credential_${randomUUID()}`, revision: 1, origin: data.origin, username: data.username, label: data.label, source: 'generated', createdAt: at, updatedAt: at, password: generatedPassword(data.length) };
      state.entries.push(entry); state.revision++; state.updatedAt = at; const result = { ...metadata(entry), vaultRevision: state.revision, existing: false };
      rememberRequest(state, owner, requestId, digest, result); await persist(state); return result;
    }, { signal, beforeCommit }); this.changed(result); return result;
  }
  async save(input, options = {}) {
    requireLocal(options); if (!keys(input, ['origin', 'username', 'password', 'label', 'credentialId', 'revision', 'requestId'])) throw credentialError('Use the local saved-login fields only.');
    const data = { origin: credentialOrigin(input.origin), username: line(input.username ?? '', 320, true), password: secret(input.password), label: line(input.label ?? '', 160, true), ...(input.credentialId !== undefined ? { credentialId: identifier(input.credentialId), revision: input.revision } : {}) };
    if (input.revision !== undefined && input.credentialId === undefined) throw credentialError('A credential revision requires its identifier.');
    const requestId = credentialRequestId(input.requestId), digest = credentialDigest({ action: 'save', ...data });
    const result = await this.store.run(async (state, persist) => {
      const prior = previousRequest(state, 'local', requestId, digest); if (prior) return prior; expectedRevision(state, options.expectedRevision);
      const existing = data.credentialId ? state.entries.find(entry => entry.credentialId === data.credentialId) : null;
      if (data.credentialId && !existing) throw credentialError('The saved credential no longer exists.', 'CREDENTIAL_MISSING', 404);
      if (existing && existing.revision !== data.revision) throw credentialError('This saved password changed. Reload and review it before updating.', 'CREDENTIAL_REVISION_CONFLICT', 409);
      if (state.entries.some(entry => entry !== existing && entry.origin === data.origin && entry.username === data.username)) throw credentialError('A saved login already exists for this origin and username.', 'CREDENTIAL_EXISTS', 409);
      if (!existing && state.entries.length >= BROWSER_CREDENTIAL_LIMITS.entries) throw credentialError('The password manager reached its entry limit.', 'CREDENTIAL_LIMIT', 413);
      const at = now(), entry = { credentialId: existing?.credentialId || `credential_${randomUUID()}`, revision: (existing?.revision || 0) + 1, origin: data.origin, username: data.username, label: data.label, source: 'saved', createdAt: existing?.createdAt || at, updatedAt: at, password: data.password };
      if (existing) state.entries[state.entries.indexOf(existing)] = entry; else state.entries.push(entry);
      state.revision++; state.updatedAt = at; const result = { ...metadata(entry), vaultRevision: state.revision, existing: false }; rememberRequest(state, 'local', requestId, digest, result); await persist(state); return result;
    }, options); this.changed(result); return result;
  }
  async importCSV(input, options = {}) {
    requireLocal(options); if (!keys(input, ['csv', 'requestId'])) throw credentialError('Use a local password CSV and request identifier.');
    const requestId = credentialRequestId(input.requestId), rows = parseCSV(input.csv), digest = credentialDigest({ action: 'import', rows });
    const result = await this.store.run(async (state, persist) => {
      const prior = previousRequest(state, 'local', requestId, digest); if (prior) return prior; expectedRevision(state, options.expectedRevision);
      const imported = [], skipped = [], conflicts = [], at = now();
      for (const row of rows) {
        const present = state.entries.find(entry => entry.origin === row.origin && entry.username === row.username);
        if (present) { (present.password === row.password ? skipped : conflicts).push(metadata(present)); continue; }
        if (state.entries.length >= BROWSER_CREDENTIAL_LIMITS.entries) throw credentialError('The password manager reached its entry limit. No rows were imported.', 'CREDENTIAL_LIMIT', 413);
        const entry = { ...row, credentialId: `credential_${randomUUID()}`, revision: 1, source: 'imported', createdAt: at, updatedAt: at }; state.entries.push(entry); imported.push(metadata(entry));
      }
      state.revision++; state.updatedAt = at; const result = { revision: state.revision, imported, skipped, conflicts, existing: false }; rememberRequest(state, 'local', requestId, digest, result); await persist(state); return result;
    }, options); this.changed(result); return result;
  }
  async delete(input, options = {}) {
    requireLocal(options); if (!keys(input, ['credentialId', 'revision', 'requestId'])) throw credentialError('Use the credential identifier, revision, and request identifier.');
    const credentialId = identifier(input.credentialId), requestId = credentialRequestId(input.requestId), digest = credentialDigest({ action: 'delete', credentialId, revision: input.revision });
    const result = await this.store.run(async (state, persist) => {
      const prior = previousRequest(state, 'local', requestId, digest); if (prior) return prior; expectedRevision(state, options.expectedRevision);
      const entry = state.entries.find(item => item.credentialId === credentialId); if (!entry) throw credentialError('The saved credential no longer exists.', 'CREDENTIAL_MISSING', 404);
      if (entry.revision !== input.revision) throw credentialError('This saved password changed. Reload before deleting it.', 'CREDENTIAL_REVISION_CONFLICT', 409);
      state.entries = state.entries.filter(item => item !== entry); state.revision++; state.updatedAt = now(); const result = { deleted: true, credentialId, revision: state.revision, existing: false }; rememberRequest(state, 'local', requestId, digest, result); await persist(state); return result;
    }, options); this.changed(result); return result;
  }
  // Host-only: never register these methods as generic HTTP or model tools.
  async withSecrets(selections, operation, { signal } = {}) {
    if (!Array.isArray(selections) || !selections.length || selections.length > BROWSER_CREDENTIAL_LIMITS.importRows || typeof operation !== 'function') throw credentialError('Choose a bounded credential selection and a host operation.');
    const wanted = selections.map(value => { if (!keys(value, ['credentialId', 'revision', 'origin'])) throw credentialError('Use exact credential references.'); return { credentialId: identifier(value.credentialId), revision: value.revision, origin: credentialOrigin(value.origin) }; });
    if (new Set(wanted.map(value => value.credentialId)).size !== wanted.length) throw credentialError('Choose each credential once.');
    return this.store.run(async state => {
      const entries = wanted.map(value => { const entry = state.entries.find(item => item.credentialId === value.credentialId); if (!entry) throw credentialError('The saved credential no longer exists.', 'CREDENTIAL_MISSING', 404); if (entry.revision !== value.revision) throw credentialError('The saved credential changed before use.', 'CREDENTIAL_REVISION_CONFLICT', 409); if (entry.origin !== value.origin) throw credentialError('The credential belongs to a different HTTPS origin.', 'CREDENTIAL_ORIGIN_MISMATCH', 403); return entry; });
      this.store.assertAvailable(signal); let result;
      try { result = await operation(entries.map(entry => ({ credentialId: entry.credentialId, revision: entry.revision, origin: entry.origin, username: entry.username, password: entry.password }))); }
      catch (cause) { const code = /^[A-Z][A-Z0-9_]{1,70}$/.test(cause?.code) && !entries.some(entry => cause.code.includes(entry.password)) ? cause.code : 'CREDENTIAL_USE_FAILED'; throw credentialError('The credential operation did not complete. Inspect the current state before retrying.', code, Number.isInteger(cause?.status) && cause.status >= 400 && cause.status <= 599 ? cause.status : 502); }
      if (result !== undefined) { let serialized; try { serialized = JSON.stringify(result); } catch { throw credentialError('The host credential operation returned an invalid receipt.', 'CREDENTIAL_SECRET_RESULT', 502); } if (typeof serialized !== 'string' || serialized.length > 1024 * 1024 || entries.some(entry => serialized.includes(JSON.stringify(entry.password).slice(1, -1)))) throw credentialError('The host credential operation returned a private or invalid receipt.', 'CREDENTIAL_SECRET_RESULT', 502); }
      return result;
    }, { signal });
  }
  withSecret(selection, operation, options) { return this.withSecrets([selection], entries => operation(entries[0]), options); }
  async close() { await this.store.close(); this.removeAllListeners(); }
}
