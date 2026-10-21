import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BROWSER_CREDENTIAL_LIMITS, BROWSER_CREDENTIAL_PROFILE, CredentialEncryptedStore, credentialCheck, credentialDigest, credentialError, credentialRequestId } from './browser-credentials.mjs';

const destinations = new Set(['chrome', 'firefox', 'neo']);
const states = new Set(['pending', 'awaiting_browser_import', 'confirmed_by_user', 'failed', 'cancelled']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).every(key => names.includes(key));
const copy = value => structuredClone(value);
const id = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw credentialError('Choose a valid saved credential or import batch.'); return value; };
const destination = value => { if (!destinations.has(value)) throw credentialError('Choose Chrome, Firefox, or Neo.'); return value; };
const revision = value => { if (!Number.isSafeInteger(value) || value < 1) throw credentialError('Choose an exact saved credential revision.'); return value; };
const local = options => { if (options?.source !== 'user') throw credentialError('Start password-manager import from BLACKICE on this computer.', 'CREDENTIAL_LOCAL_ONLY', 403); };
const at = () => new Date().toISOString();
const fresh = profileId => ({ schema: 1, namespace: 'mirror', profileId, revision: 0, settings: { enabled: false, destination: 'chrome' }, entries: [], batches: [], requests: [], updatedAt: null });
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const queueKey = entry => JSON.stringify([entry.credentialId, entry.credentialRevision, entry.destination]);
const safeError = (code, message) => ({ code, message });
const interrupted = () => safeError('CREDENTIAL_IMPORT_INTERRUPTED', 'The temporary import handoff ended. Check the destination browser before starting another import.');
const stale = () => safeError('CREDENTIAL_IMPORT_STALE', 'A selected credential changed or was deleted. Select its current revision before importing.');
const expired = () => safeError('CREDENTIAL_IMPORT_EXPIRED', 'The temporary password file expired. Check the destination browser before starting another import.');
const processAlive = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return true; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
function validate(state) {
  if (!object(state) || state.schema !== 1 || state.namespace !== 'mirror' || !Number.isSafeInteger(state.revision) || state.revision < 0 || !keys(state.settings, ['enabled', 'destination']) || typeof state.settings.enabled !== 'boolean' || !destinations.has(state.settings.destination) || !Array.isArray(state.entries) || state.entries.length > 10000 || !Array.isArray(state.batches) || state.batches.length > 10000 || !Array.isArray(state.requests) || state.requests.length > BROWSER_CREDENTIAL_LIMITS.requests) throw Error('Invalid credential mirror');
  const entryIds = new Set(), batchIds = new Set(), requests = new Set();
  for (const entry of state.entries) {
    if (!keys(entry, ['id', 'credentialId', 'credentialRevision', 'destination', 'state', 'createdAt', 'updatedAt', 'batchId', 'error']) || !states.has(entry.state) || !destinations.has(entry.destination) || entryIds.has(entry.id)) throw Error();
    id(entry.id); id(entry.credentialId); revision(entry.credentialRevision); entryIds.add(entry.id);
    if (entry.batchId !== null) id(entry.batchId);
    if (!Number.isFinite(Date.parse(entry.createdAt)) || !Number.isFinite(Date.parse(entry.updatedAt))) throw Error();
    if (entry.error !== null && (!keys(entry.error, ['code', 'message']) || typeof entry.error.code !== 'string' || typeof entry.error.message !== 'string' || entry.error.message.length > 300)) throw Error();
  }
  for (const batch of state.batches) {
    if (!keys(batch, ['batchId', 'state', 'count', 'destination', 'expiresAt', 'createdAt', 'updatedAt', 'entryIds', 'error']) || !states.has(batch.state) || batch.state === 'pending' || !destinations.has(batch.destination) || batchIds.has(batch.batchId) || !Array.isArray(batch.entryIds) || !batch.entryIds.length || batch.entryIds.length > BROWSER_CREDENTIAL_LIMITS.importRows || batch.count !== batch.entryIds.length || new Set(batch.entryIds).size !== batch.entryIds.length || batch.entryIds.some(value => !entryIds.has(value))) throw Error();
    id(batch.batchId); batchIds.add(batch.batchId);
    if (![batch.createdAt, batch.updatedAt, batch.expiresAt].every(value => Number.isFinite(Date.parse(value)))) throw Error();
    if (batch.error !== null && (!keys(batch.error, ['code', 'message']) || typeof batch.error.code !== 'string' || typeof batch.error.message !== 'string' || batch.error.message.length > 300)) throw Error();
    for (const entryId of batch.entryIds) { const entry = state.entries.find(value => value.id === entryId); if (entry.batchId !== batch.batchId || entry.destination !== batch.destination || entry.state !== batch.state) throw Error(); }
  }
  for (const entry of state.entries) if (entry.batchId !== null && !batchIds.has(entry.batchId)) throw Error();
  for (const request of state.requests) {
    if (!keys(request, ['requestId', 'digest', 'kind', 'ids']) || !/^[a-f0-9]{64}$/.test(request.digest) || !['queue', 'begin'].includes(request.kind) || !Array.isArray(request.ids) || request.ids.some(value => !(request.kind === 'queue' ? entryIds : batchIds).has(value)) || requests.has(request.requestId)) throw Error();
    credentialRequestId(request.requestId); requests.add(request.requestId);
  }
}
const compareRevision = (state, value) => { if (!Number.isSafeInteger(value) || value !== state.revision) throw Object.assign(credentialError('The browser-copy queue changed. Reload and review the selected passwords.', 'CREDENTIAL_MIRROR_REVISION_CONFLICT', 409), { currentRevision: state.revision }); };
function previous(state, requestId, digest) { const request = state.requests.find(value => value.requestId === requestId); if (request && request.digest !== digest) throw credentialError('This request identifier already belongs to a different browser-copy operation.', 'CREDENTIAL_MIRROR_REQUEST_CONFLICT', 409); return request; }
function remember(state, request) { if (state.requests.length >= BROWSER_CREDENTIAL_LIMITS.requests) throw credentialError('The browser-copy request history is full.', 'CREDENTIAL_LIMIT', 413); state.requests.push(request); }
function queueEntry(credential, target) { const createdAt = at(); return { id: `copy_${randomUUID()}`, credentialId: credential.credentialId, credentialRevision: credential.revision, destination: target, state: 'pending', createdAt, updatedAt: createdAt, batchId: null, error: null }; }
function finishBatch(state, batch, nextState, error = null) { batch.state = nextState; batch.error = error; batch.updatedAt = at(); for (const entry of state.entries) if (batch.entryIds.includes(entry.id)) { entry.state = nextState; entry.error = error; entry.updatedAt = batch.updatedAt; } }
function bump(state) { state.revision++; state.updatedAt = at(); }
const quote = value => `"${String(value).replaceAll('"', '""')}"`;

/** Encrypted outbound intentions; plaintext is created only for an explicit local
 * native-browser import, then removed on completion, cancellation, expiry or restart. */
export class BrowserCredentialMirror {
  constructor(options = {}) {
    const profileId = options.profileId || options.vault?.profileId || BROWSER_CREDENTIAL_PROFILE;
    this.vault = options.vault; this.begin = options.beginImport; this.protect = options.protectTemporaryDirectory;
    this.platform = options.platform || process.platform; this.io = options.io || fs; this.onChange = options.onChange || (() => {});
    this.exportLifetimeMs = Math.max(50, Math.min(300000, Number(options.exportLifetimeMs) || 300000));
    this.handoffTimeoutMs = Math.max(25, Math.min(15000, Number(options.handoffTimeoutMs) || 10000));
    this.store = new CredentialEncryptedStore({ ...options, profileId, name: 'mirror', empty: () => fresh(profileId), validate });
    this.exportRoot = path.join(this.store.directory, 'exports'); this.instanceId = randomUUID(); this.ready = null; this.closed = false; this.timer = null; this.active = new Map(); this.ownedBatches = new Map(); this.lastError = null;
  }
  changed(state) { try { this.onChange({ profileId: this.store.profileId, revision: state.revision }); } catch {} }
  capability() { return typeof this.begin === 'function' && (this.platform !== 'win32' || typeof this.protect === 'function'); }
  admission(signal) { credentialCheck(signal); if (this.closed) throw credentialError('The browser-copy manager is closing.', 'CREDENTIAL_CLOSED', 503); this.store.assertAvailable(signal); }
  async init() {
    if (!this.ready) this.ready = (async () => {
      try {
        await this.store.init(); await this.cleanupOwnedExports({ orphanedOnly: true });
        await this.store.run(async (state, persist) => {
          let changed = false;
          for (const batch of state.batches) if (batch.state === 'awaiting_browser_import') {
            let present = false; try { const target = await this.owned(batch.batchId), info = await this.io.lstat(target.filePath); present = info.isFile() && !info.isSymbolicLink(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (!present) { finishBatch(state, batch, 'failed', interrupted()); changed = true; }
          }
          if (changed) { bump(state); await persist(state); this.changed(state); }
        });
        await this.reconcile();
      } catch (error) { this.lastError = safeError(/^CREDENTIAL_[A-Z_]+$/.test(error?.code || '') ? error.code : 'CREDENTIAL_STORAGE', 'The encrypted browser-copy queue or its temporary files are unavailable. Existing encrypted records were preserved.'); }
      return this;
    })();
    return this.ready;
  }
  async ordinary(directory, { create = false } = {}) {
    if (create) await this.io.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await this.io.lstat(directory), real = await this.io.realpath(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(real, directory)) throw credentialError('The temporary import folder is not an ordinary owned directory.', 'CREDENTIAL_EXPORT_PROTECTION', 503);
  }
  paths(batchId) { if (!/^batch_[a-f0-9-]{36}$/.test(id(batchId))) throw credentialError('Choose a known import batch.'); const directory = path.join(this.exportRoot, batchId); return { directory, marker: path.join(directory, 'owner.json'), filePath: path.join(directory, 'passwords.csv') }; }
  async owned(batchId) {
    const target = this.paths(batchId); await this.ordinary(this.store.directory); await this.ordinary(this.exportRoot); await this.ordinary(target.directory);
    const info = await this.io.lstat(target.marker); if (!info.isFile() || info.isSymbolicLink() || info.size > 2048) throw Error();
    const marker = JSON.parse(await this.io.readFile(target.marker, 'utf8'));
    if (!keys(marker, ['schema', 'profileId', 'batchId', 'pid', 'instanceId', 'expiresAt']) || marker.schema !== 1 || marker.profileId !== this.store.profileId || marker.batchId !== batchId || !Number.isSafeInteger(marker.pid) || marker.pid < 1 || typeof marker.instanceId !== 'string' || !/^[a-f0-9-]{36}$/.test(marker.instanceId) || !Number.isFinite(Date.parse(marker.expiresAt))) throw Error();
    return { ...target, owner: marker };
  }
  async remove(batchId) {
    try { const target = await this.owned(batchId); await this.io.rm(target.directory, { recursive: true, force: false }); }
    catch (error) { if (error.code !== 'ENOENT') throw credentialError('A temporary password file could not be removed. Close any program using that file and check status again.', 'CREDENTIAL_EXPORT_CLEANUP', 503); }
    this.ownedBatches.delete(batchId);
  }
  async cleanupOwnedExports({ orphanedOnly = false, thisInstanceOnly = false } = {}) {
    let files; try { await this.ordinary(this.exportRoot); files = await this.io.readdir(this.exportRoot); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (files.length > 10000) throw credentialError('The temporary password folder needs local attention.', 'CREDENTIAL_EXPORT_CLEANUP', 503);
    for (const name of files) if (/^batch_[a-f0-9-]{36}$/.test(name)) {
      const target = await this.owned(name);
      if (orphanedOnly && processAlive(target.owner.pid) || thisInstanceOnly && target.owner.instanceId !== this.instanceId) continue;
      await this.remove(name);
    }
  }
  async createExport(batch, entries, signal) {
    this.admission(signal); await this.ordinary(this.store.directory); await this.ordinary(this.exportRoot, { create: true });
    const target = this.paths(batch.batchId); await this.io.mkdir(target.directory, { mode: 0o700 });
    await this.io.writeFile(target.marker, JSON.stringify({ schema: 1, profileId: this.store.profileId, batchId: batch.batchId, pid: process.pid, instanceId: this.instanceId, expiresAt: batch.expiresAt }), { flag: 'wx', mode: 0o600 });
    await this.owned(batch.batchId);
    if (this.platform === 'win32') {
      if (typeof this.protect !== 'function') throw credentialError('A private Windows import folder is unavailable.', 'CREDENTIAL_EXPORT_PROTECTION', 503);
      const result = await this.protect(target.directory); this.admission(signal);
      if (result?.protected !== true) throw credentialError('The temporary password folder could not be protected.', 'CREDENTIAL_EXPORT_PROTECTION', 503);
    } else {
      await this.io.chmod(target.directory, 0o700); const info = await this.io.stat(target.directory);
      if ((info.mode & 0o077) !== 0) throw credentialError('The temporary password folder is not private.', 'CREDENTIAL_EXPORT_PROTECTION', 503);
    }
    this.admission(signal); await this.owned(batch.batchId);
    const csv = 'name,url,username,password\r\n' + entries.map(entry => [new URL(entry.origin).hostname, entry.origin, entry.username, entry.password].map(quote).join(',')).join('\r\n') + '\r\n';
    let file;
    try { file = await this.io.open(target.filePath, 'wx', 0o600); await file.writeFile(csv); await file.sync(); }
    finally { await file?.close(); }
    this.admission(signal); return target.filePath;
  }
  async invokeHandoff(value, controller, externalSignal) {
    let timer, abort;
    const timeout = new Promise((_, reject) => {
      abort = () => reject(credentialError('The browser import handoff was interrupted.', 'ABORT_ERR', 409));
      externalSignal?.addEventListener('abort', abort, { once: true }); controller.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(credentialError('The browser import handoff did not settle in time.', 'CREDENTIAL_IMPORT_TIMEOUT', 504)); }, this.handoffTimeoutMs);
      if (externalSignal?.aborted || controller.signal.aborted) abort();
    });
    try { return await Promise.race([Promise.resolve().then(() => { this.admission(externalSignal); credentialCheck(controller.signal); return this.begin({ ...value, signal: controller.signal }); }), timeout]); }
    finally { clearTimeout(timer); externalSignal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', abort); }
  }
  schedule(state, minimumDelay = 1) {
    clearTimeout(this.timer); this.timer = null; if (this.closed) return;
    const pending = state.batches.filter(batch => batch.state === 'awaiting_browser_import' && this.ownedBatches.has(batch.batchId)).map(batch => ({ batchId: batch.batchId, expiresAt: batch.expiresAt }));
    if (!pending.length) return;
    this.timer = setTimeout(() => { this.timer = null; this.expire(pending).catch(() => {}); }, Math.max(minimumDelay, Math.min(...pending.map(batch => Date.parse(batch.expiresAt))) - Date.now())); this.timer.unref?.();
  }
  async expire(pending) {
    let cleanupFailed = false;
    // This path deliberately does not decrypt either store or call admission.
    // Locking the OS key store must never extend a plaintext CSV's lifetime.
    for (const batch of pending) {
      if (Date.parse(batch.expiresAt) > Date.now()) continue;
      this.active.get(batch.batchId)?.abort();
      try {
        const target = await this.owned(batch.batchId);
        if (target.owner.instanceId !== this.instanceId || Date.parse(target.owner.expiresAt) > Date.now()) continue;
        await this.remove(batch.batchId);
      } catch (error) { if (error.code === 'ENOENT') this.ownedBatches.delete(batch.batchId); else { cleanupFailed = true; this.lastError = safeError('CREDENTIAL_EXPORT_CLEANUP', 'A temporary password file needs local cleanup. Close programs using the file and check status again.'); } }
    }
    try { await this.reconcile(); } catch { /* The file is gone even if protected metadata cannot be updated yet. */ }
    // A locked store must not strand later batches after the earliest expiry.
    if (!this.closed) this.schedule({ batches: [...this.ownedBatches].map(([batchId, expiresAt]) => ({ batchId, expiresAt, state: 'awaiting_browser_import' })) }, cleanupFailed ? 1000 : 1);
  }
  async currentCredentials() { if (!this.vault || typeof this.vault.list !== 'function') throw credentialError('The protected password vault is unavailable.', 'CREDENTIAL_MIRROR_UNAVAILABLE', 503); return this.vault.list(); }
  async reconcile() {
    this.admission();
    const result = await this.store.run(async (state, persist) => {
      const credentials = await this.currentCredentials(), current = new Map(credentials.map(entry => [entry.credentialId, entry])); let changed = false;
      for (const batch of state.batches) {
        if (batch.state !== 'awaiting_browser_import') continue;
        const outdated = batch.entryIds.some(value => { const entry = state.entries.find(item => item.id === value); return current.get(entry.credentialId)?.revision !== entry.credentialRevision; });
        let missing = false, anotherLiveOwner = false; try { const target = await this.owned(batch.batchId), info = await this.io.lstat(target.filePath); if (!info.isFile() || info.isSymbolicLink()) missing = true; anotherLiveOwner = target.owner.instanceId !== this.instanceId && processAlive(target.owner.pid); } catch (error) { if (error.code === 'ENOENT') missing = true; else throw error; }
        if (anotherLiveOwner && !missing) continue;
        if (outdated || missing || Date.parse(batch.expiresAt) <= Date.now()) { this.active.get(batch.batchId)?.abort(); await this.remove(batch.batchId); finishBatch(state, batch, 'failed', outdated ? stale() : Date.parse(batch.expiresAt) <= Date.now() ? expired() : interrupted()); changed = true; }
      }
      for (const entry of state.entries) if (entry.state === 'pending' && current.get(entry.credentialId)?.revision !== entry.credentialRevision) { entry.state = 'failed'; entry.updatedAt = at(); entry.error = stale(); changed = true; }
      if (state.settings.enabled) {
        const seen = new Set(state.entries.map(queueKey));
        for (const credential of credentials) { const key = JSON.stringify([credential.credentialId, credential.revision, state.settings.destination]); if (seen.has(key)) continue; if (state.entries.length >= 10000) throw credentialError('The browser-copy queue reached its limit.', 'CREDENTIAL_LIMIT', 413); state.entries.push(queueEntry(credential, state.settings.destination)); seen.add(key); changed = true; }
      }
      if (changed) { bump(state); await persist(state); this.changed(state); }
      this.lastError = null; this.schedule(state); return { revision: state.revision, changed };
    });
    return result;
  }
  async status() {
    let state, failure;
    try { await this.reconcile(); state = await this.store.read(); } catch (error) { failure = safeError(/^CREDENTIAL_[A-Z_]+$/.test(error?.code || '') ? error.code : 'CREDENTIAL_STORAGE', 'The encrypted browser-copy queue or temporary password cleanup needs attention.'); try { state = await this.store.read(); } catch {} }
    const available = Boolean(state && !failure && !this.lastError), healthy = available;
    return { available, healthy, revision: state?.revision ?? null, settings: copy(state?.settings || { enabled: false, destination: 'chrome' }), entries: copy(state?.entries || []), batches: copy(state?.batches || []), lastError: failure || this.lastError, capabilities: { configure: available, queue: available, beginImport: available && this.capability() } };
  }
  async configure(input, options = {}) {
    local(options); if (!keys(input, ['enabled', 'destination']) || typeof input.enabled !== 'boolean') throw credentialError('Choose a browser and whether to queue passwords automatically.');
    const settings = { enabled: input.enabled, destination: destination(input.destination) }; this.admission(options.signal);
    const result = await this.store.run(async (state, persist) => {
      compareRevision(state, options.expectedRevision); const credentials = settings.enabled ? await this.currentCredentials() : [];
      state.settings = settings;
      const seen = new Set(state.entries.map(queueKey));
      for (const credential of credentials) if (!seen.has(JSON.stringify([credential.credentialId, credential.revision, settings.destination]))) { if (state.entries.length >= 10000) throw credentialError('The browser-copy queue reached its limit.', 'CREDENTIAL_LIMIT', 413); state.entries.push(queueEntry(credential, settings.destination)); }
      bump(state); await persist(state); this.changed(state); return { revision: state.revision, settings: copy(settings) };
    }, options); return result;
  }
  async queue(input, options = {}) {
    local(options); if (!keys(input, ['credentials', 'destination', 'requestId']) || !Array.isArray(input.credentials) || !input.credentials.length || input.credentials.length > BROWSER_CREDENTIAL_LIMITS.importRows) throw credentialError('Choose a bounded selection of saved passwords.');
    const selections = input.credentials.map(value => { if (!keys(value, ['credentialId', 'revision'])) throw credentialError('Choose exact saved password references.'); return { credentialId: id(value.credentialId), revision: revision(value.revision) }; }).sort((a, b) => a.credentialId.localeCompare(b.credentialId));
    if (new Set(selections.map(value => value.credentialId)).size !== selections.length) throw credentialError('Choose each saved password once.');
    const target = destination(input.destination), requestId = credentialRequestId(input.requestId), digest = credentialDigest({ action: 'queue', selections, destination: target }); this.admission(options.signal);
    return this.store.run(async (state, persist) => {
      const prior = previous(state, requestId, digest); if (prior) return { revision: state.revision, entries: copy(state.entries.filter(entry => prior.ids.includes(entry.id))), existing: true };
      compareRevision(state, options.expectedRevision); const credentials = await this.currentCredentials(), selected = selections.map(selection => { const credential = credentials.find(value => value.credentialId === selection.credentialId); if (!credential) throw credentialError('A selected password no longer exists.', 'CREDENTIAL_MISSING', 404); if (credential.revision !== selection.revision) throw credentialError('A selected password changed. Review its current revision.', 'CREDENTIAL_REVISION_CONFLICT', 409); return credential; });
      const entries = selected.map(credential => { let entry = state.entries.find(value => value.credentialId === credential.credentialId && value.credentialRevision === credential.revision && value.destination === target && ['pending', 'awaiting_browser_import'].includes(value.state)); if (!entry) { if (state.entries.length >= 10000) throw credentialError('The browser-copy queue reached its limit.', 'CREDENTIAL_LIMIT', 413); entry = queueEntry(credential, target); state.entries.push(entry); } return entry; });
      remember(state, { requestId, digest, kind: 'queue', ids: entries.map(entry => entry.id) }); bump(state); await persist(state); this.changed(state); return { revision: state.revision, entries: copy(entries), existing: false };
    }, options);
  }
  async beginImport(input, options = {}) {
    local(options); if (!keys(input, ['ids', 'requestId']) || !Array.isArray(input.ids) || !input.ids.length || input.ids.length > BROWSER_CREDENTIAL_LIMITS.importRows) throw credentialError('Choose a bounded pending password-copy selection.');
    const ids = input.ids.map(id).sort(); if (new Set(ids).size !== ids.length) throw credentialError('Choose each queued password once.');
    const requestId = credentialRequestId(input.requestId), digest = credentialDigest({ action: 'begin', ids }); this.admission(options.signal);
    return this.store.run(async (state, persist) => {
      const prior = previous(state, requestId, digest); if (prior) return { ...copy(state.batches.find(batch => batch.batchId === prior.ids[0])), revision: state.revision, existing: true };
      if (!this.capability()) throw credentialError('A protected native browser import handoff is unavailable.', 'CREDENTIAL_MIRROR_UNAVAILABLE', 503);
      compareRevision(state, options.expectedRevision);
      const entries = ids.map(value => state.entries.find(entry => entry.id === value));
      if (entries.some(entry => !entry) || new Set(entries.map(entry => entry.destination)).size !== 1) throw credentialError('Choose available queued passwords for one destination browser.');
      if (entries.every(entry => entry.state === 'awaiting_browser_import') && new Set(entries.map(entry => entry.batchId)).size === 1) {
        const batch = state.batches.find(value => value.batchId === entries[0].batchId); remember(state, { requestId, digest, kind: 'begin', ids: [batch.batchId] }); bump(state); await persist(state); return { ...copy(batch), revision: state.revision, existing: true };
      }
      if (entries.some(entry => entry.state !== 'pending')) throw credentialError('These passwords are no longer a pending selection. Review the current import state.', 'CREDENTIAL_MIRROR_REVISION_CONFLICT', 409);
      if (state.batches.length >= 10000) throw credentialError('The browser-import history reached its limit.', 'CREDENTIAL_LIMIT', 413);
      const credentials = await this.currentCredentials(), selections = entries.map(entry => { const credential = credentials.find(value => value.credentialId === entry.credentialId); if (!credential || credential.revision !== entry.credentialRevision) throw credentialError('A selected password changed or was deleted. Review the current vault.', 'CREDENTIAL_REVISION_CONFLICT', 409); return { credentialId: credential.credentialId, revision: credential.revision, origin: credential.origin }; });
      const createdAt = at(), batch = { batchId: `batch_${randomUUID()}`, state: 'awaiting_browser_import', count: entries.length, destination: entries[0].destination, expiresAt: new Date(Date.now() + this.exportLifetimeMs).toISOString(), createdAt, updatedAt: createdAt, entryIds: ids, error: null };
      for (const entry of entries) { entry.batchId = batch.batchId; entry.state = batch.state; entry.updatedAt = createdAt; }
      state.batches.push(batch); remember(state, { requestId, digest, kind: 'begin', ids: [batch.batchId] }); bump(state); await persist(state);
      const controller = new AbortController(); this.active.set(batch.batchId, controller); this.ownedBatches.set(batch.batchId, batch.expiresAt); this.schedule(state);
      const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true });
      try {
        this.admission(options.signal); credentialCheck(controller.signal);
        await this.vault.withSecrets(selections, async secrets => {
          const filePath = await this.createExport(batch, secrets, controller.signal);
          await this.invokeHandoff({ destination: batch.destination, filePath, batchId: batch.batchId, count: batch.count, expiresAt: batch.expiresAt }, controller, options.signal);
          this.admission(options.signal); credentialCheck(controller.signal); return undefined;
        }, { signal: controller.signal });
        this.schedule(state); this.changed(state); return { ...copy(batch), revision: state.revision, existing: false };
      } catch (error) {
        controller.abort(); await this.remove(batch.batchId);
        finishBatch(state, batch, 'failed', safeError('CREDENTIAL_IMPORT_HANDOFF_FAILED', 'The browser import handoff was not confirmed. The temporary file was removed; check the browser before starting another import.')); bump(state);
        // Cleanup remains mandatory even if closing/revocation prevents publishing a final receipt.
        try { await persist(state); } catch {} this.changed(state);
        throw credentialError('The browser import handoff did not complete. Check the saved queue before retrying; no import was confirmed.', error?.code === 'CREDENTIAL_EXPORT_PROTECTION' ? error.code : 'CREDENTIAL_IMPORT_HANDOFF_FAILED', 503);
      } finally { options.signal?.removeEventListener('abort', abort); this.active.delete(batch.batchId); }
    }, options);
  }
  async settle(input, options, nextState) {
    local(options); if (!keys(input, ['batchId'])) throw credentialError('Choose an existing import batch.'); const batchId = id(input.batchId); this.admission(options.signal);
    if (nextState === 'cancelled') this.active.get(batchId)?.abort();
    return this.store.run(async (state, persist) => {
      compareRevision(state, options.expectedRevision); const batch = state.batches.find(value => value.batchId === batchId); if (!batch) throw credentialError('The import batch no longer exists.', 'CREDENTIAL_MISSING', 404);
      if (batch.state === nextState) return { ...copy(batch), revision: state.revision, existing: true };
      if (batch.state !== 'awaiting_browser_import') throw credentialError('This handoff is no longer awaiting a browser import.', 'CREDENTIAL_MIRROR_REVISION_CONFLICT', 409);
      if (nextState === 'confirmed_by_user' && Date.parse(batch.expiresAt) <= Date.now()) { await this.remove(batchId); finishBatch(state, batch, 'failed', expired()); bump(state); await persist(state); this.changed(state); throw credentialError('The temporary handoff expired. Check the browser before creating another one.', 'CREDENTIAL_IMPORT_EXPIRED', 409); }
      await this.remove(batchId); finishBatch(state, batch, nextState); bump(state); await persist(state); this.schedule(state); this.changed(state); return { ...copy(batch), revision: state.revision, existing: false };
    }, options);
  }
  confirm(input, options = {}) { return this.settle(input, options, 'confirmed_by_user'); }
  cancel(input, options = {}) { return this.settle(input, options, 'cancelled'); }
  async close() {
    this.closed = true; clearTimeout(this.timer); for (const controller of this.active.values()) controller.abort();
    await this.store.tail.catch(() => {}); await this.cleanupOwnedExports({ thisInstanceOnly: true }); await this.store.close();
  }
}
