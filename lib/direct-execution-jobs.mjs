import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const DIRECT_JOB_LIMITS = Object.freeze({ jobs: 1000, requestBytes: 128 * 1024, recordBytes: 8 * 1024 * 1024, resultBytes: 4 * 1024 * 1024 });
export const DIRECT_JOB_STATES = Object.freeze(['queued', 'awaiting_input', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted']);
export const directJobTerminal = value => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(typeof value === 'string' ? value : value?.status);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, code = 'DIRECT_JOB_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const clone = value => structuredClone(value);
const timestamp = () => new Date().toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
const jobId = value => typeof value === 'string' && /^direct_[a-f0-9]{64}$/.test(value);
const principal = value => typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value);
const requestId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value);
const dead = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
const check = signal => { if (signal?.aborted) throw Object.assign(fail('Direct action cancelled.', 'ABORT_ERR', 409), { name: 'AbortError' }); };

/** A canonical request digest rejects changed arguments behind an idempotency key. */
export function directRequestDigest(value) {
  const canonical = item => {
    if (item === null || ['string', 'boolean'].includes(typeof item)) return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (object(item)) return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(',')}}`;
    throw fail('Direct action requests must contain ordinary JSON values.');
  };
  let encoded;
  try { encoded = canonical(value); } catch (error) { if (error.code) throw error; throw fail('Direct action request is too deeply nested.'); }
  if (Buffer.byteLength(encoded) > DIRECT_JOB_LIMITS.requestBytes) throw fail('Direct action request exceeds 128 KiB.', 'DIRECT_JOB_TOO_LARGE', 413);
  return hash(encoded);
}

function validateRecord(value, id) {
  if (!object(value) || value.version !== 1 || !jobId(value.id) || value.id !== id || !principal(value.ownerId) || !requestId(value.requestId)
      || value.id !== `direct_${hash(`${value.ownerId}\0${value.requestId}`)}` || !/^[a-f0-9]{64}$/.test(value.requestDigest)
      || typeof value.tool !== 'string' || !object(value.arguments) || !Array.isArray(value.requiredScopes) || value.requiredScopes.some(scope => typeof scope !== 'string')
      || !DIRECT_JOB_STATES.includes(value.status) || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.dispatched !== 'boolean'
      || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' || typeof value.transientArguments !== 'boolean' || !object(value.client)
      || value.client.id !== value.ownerId || !Array.isArray(value.client.scopes) || !object(value.effects)) throw fail('A saved direct job is invalid.', 'DIRECT_JOB_STORAGE', 503);
  if (value.interaction !== null && (!object(value.interaction) || typeof value.interaction.id !== 'string' || !['approval', 'browser', 'javascript_dialog', 'http_auth', 'file_chooser', 'sign_in', 'verification', 'permission'].includes(value.interaction.kind))) throw fail('A saved direct interaction is invalid.', 'DIRECT_JOB_STORAGE', 503);
  if (value.status === 'awaiting_input' && !value.interaction) throw fail('A saved direct interaction is missing.', 'DIRECT_JOB_STORAGE', 503);
  if (value.storedRequestDigest !== directRequestDigest({ tool: value.tool, arguments: value.arguments }) || !value.transientArguments && value.requestDigest !== value.storedRequestDigest) throw fail('A saved direct request has changed.', 'DIRECT_JOB_STORAGE', 503);
  return value;
}

// This projection deliberately has no arguments, client or result payload. Full
// version-1 receipts remain authoritative on disk and are hydrated on demand.
function metadata(value) {
  return { id: value.id, ownerId: value.ownerId, requestId: value.requestId, tool: value.tool,
    action: value.arguments?.action ?? value.action ?? (value.tool === 'blackice_run_command' ? 'run' : null),
    status: value.status, revision: value.revision, createdAt: value.createdAt, updatedAt: value.updatedAt,
    startedAt: value.startedAt, finishedAt: value.finishedAt, dispatched: value.dispatched,
    effects: clone(value.effects), error: clone(value.error), interaction: clone(value.interaction), requiredScopes: [...value.requiredScopes],
    resultAvailable: Object.hasOwn(value, 'resultAvailable') ? value.resultAvailable : value.result !== null };
}

/**
 * Durable single-executor ledger. The profile lease prevents two app processes
 * from admitting the same action; request IDs and completed receipts never expire
 * implicitly. Restart recovery records uncertainty instead of replaying work.
 * maxJobs limits unfinished work. Terminal payloads live only on disk; the
 * metadata index and startup validation scan still grow with retained history.
 */
export class DirectExecutionJobs {
  constructor({ dataDir, io = fs, maxJobs = DIRECT_JOB_LIMITS.jobs } = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw fail('Direct jobs need an absolute data directory.');
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > DIRECT_JOB_LIMITS.jobs) throw fail('Use a supported direct-job limit.');
    this.directory = path.join(dataDir, 'direct-execution-jobs'); this.leaseFile = path.join(this.directory, 'executor.lock');
    this.io = io; this.maxJobs = maxJobs; this.records = new Map(); this.tail = Promise.resolve(); this.token = randomUUID();
    this.ready = null; this.closed = false; this.hasLease = false; this.unfinished = 0; this.storageError = null;
  }
  file(id) { if (!jobId(id)) throw fail('Use a valid direct job ID.'); return path.join(this.directory, `${id}.json`); }
  async ensureDirectory() {
    await this.io.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await this.io.lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('The direct-job directory must be an ordinary local directory.', 'DIRECT_JOB_STORAGE', 503);
  }
  async publishLease(file = this.leaseFile) {
    const temporary = `${file}.${randomUUID()}.tmp`; let handle;
    try {
      handle = await this.io.open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, token: this.token })); await handle.sync();
      await this.io.link(temporary, file); if (file === this.leaseFile) this.hasLease = true;
    } finally { await handle?.close(); await this.io.rm(temporary, { force: true }).catch(() => {}); }
  }
  async readLease(file = this.leaseFile) {
    const info = await this.io.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw fail('Direct execution storage is locked by an unrecognized owner.', 'DIRECT_JOB_LOCKED', 503);
    const raw = await this.io.readFile(file, 'utf8'); let owner;
    try { owner = JSON.parse(raw); } catch { throw fail('Direct execution storage is locked by an unrecognized owner.', 'DIRECT_JOB_LOCKED', 503); }
    if (owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string' || owner.token.length > 120) throw fail('Direct execution storage is locked by an unrecognized owner.', 'DIRECT_JOB_LOCKED', 503);
    return { owner, raw };
  }
  async acquireLease(file = this.leaseFile, depth = 0) {
    if (depth > 8) throw fail('Direct execution ownership recovery needs local review.', 'DIRECT_JOB_LOCKED', 503);
    try { await this.publishLease(file); return; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const { owner, raw } = await this.readLease(file);
    if (!dead(owner.pid)) throw fail('Another BLACKICE process owns direct execution. Close that process before enabling this connector.', 'DIRECT_JOB_LOCKED', 503);
    // A hard-link claim ensures only one contender removes this exact stale lease.
    const claim = `${file}.reclaim-${hash(raw)}`;
    await this.acquireLease(claim, depth + 1);
    try {
      if ((await this.io.readFile(file, 'utf8')) !== raw || !dead(owner.pid)) throw fail('Direct execution ownership changed. Retry connector startup.', 'DIRECT_JOB_LOCKED', 503);
      await this.io.unlink(file); await this.publishLease(file);
    } catch (error) {
      if (error.code === 'EEXIST') throw fail('Direct execution ownership is being recovered. Retry connector startup.', 'DIRECT_JOB_LOCKED', 503);
      throw error;
    } finally {
      const current = await this.readLease(claim);
      if (current.owner.pid === process.pid && current.owner.token === this.token) await this.io.unlink(claim);
    }
  }
  async assertLease() {
    if (!this.hasLease) throw fail('Direct execution storage has no owner.', 'DIRECT_JOB_STORAGE', 503);
    let owner;
    try { ({ owner } = await this.readLease()); } catch { throw fail('Direct execution storage ownership could not be verified.', 'DIRECT_JOB_STORAGE', 503); }
    if (owner.pid !== process.pid || owner.token !== this.token) throw fail('Direct execution storage ownership changed.', 'DIRECT_JOB_STORAGE', 503);
  }
  async releaseLease() {
    if (!this.hasLease) return;
    try { const { owner } = await this.readLease(); if (owner.pid === process.pid && owner.token === this.token) await this.io.unlink(this.leaseFile); }
    finally { this.hasLease = false; }
  }
  remember(record, receiptHash) {
    const previous = this.records.get(record.id);
    if (previous && !directJobTerminal(previous)) this.unfinished--;
    if (!directJobTerminal(record)) this.unfinished++;
    this.records.set(record.id, directJobTerminal(record) ? { ...metadata(record), requestDigest: record.requestDigest, receiptHash } : record);
  }
  async readRecord(id) {
    try {
      const file = this.file(id), info = await this.io.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > DIRECT_JOB_LIMITS.recordBytes) throw new Error('Unsafe receipt file.');
      const raw = await this.io.readFile(file, 'utf8');
      if (Buffer.byteLength(raw) > DIRECT_JOB_LIMITS.recordBytes) throw new Error('Oversized receipt file.');
      return { record: validateRecord(JSON.parse(raw), id), receiptHash: hash(raw) };
    } catch {
      this.storageError = fail('A saved direct job could not be read safely. Existing records were preserved.', 'DIRECT_JOB_STORAGE', 503);
      throw this.storageError;
    }
  }
  async fullRecord(value) {
    if (!directJobTerminal(value)) return value;
    const saved = await this.readRecord(value.id);
    if (saved.receiptHash !== value.receiptHash) {
      this.storageError = fail('A saved direct job changed after it was indexed. Existing records were preserved.', 'DIRECT_JOB_STORAGE', 503);
      throw this.storageError;
    }
    return saved.record;
  }
  init() {
    return this.ready ||= (async () => {
      await this.ensureDirectory(); await this.acquireLease();
      try {
        for (const name of await this.io.readdir(this.directory)) {
          if (!/^direct_[a-f0-9]{64}\.json$/.test(name)) continue;
          const saved = await this.readRecord(name.slice(0, -5));
          this.remember(saved.record, saved.receiptHash);
        }
        for (const record of this.records.values()) {
          if (['queued', 'running', 'cancelling'].includes(record.status) || record.status === 'awaiting_input' && record.transientArguments && !record.dispatched) {
            const next = { ...record, status: 'interrupted', revision: record.revision + 1, updatedAt: timestamp(), finishedAt: timestamp(), interaction: null,
              effects: { possible: record.dispatched, confirmed: false }, error: { code: 'DIRECT_JOB_RESTARTED', message: record.dispatched ? 'BLACKICE restarted before the action result was saved. Inspect its effects; it was not replayed.' : 'BLACKICE restarted before this action was dispatched. It was not replayed.' } };
            this.remember(next, await this.save(next));
          }
        }
        return this;
      } catch (error) { await this.releaseLease().catch(() => {}); throw error; }
    })();
  }
  async save(record) {
    validateRecord(record, record.id);
    const encoded = JSON.stringify(record); if (Buffer.byteLength(encoded) > DIRECT_JOB_LIMITS.recordBytes) throw fail('The direct-job receipt exceeds its storage limit.', 'DIRECT_JOB_TOO_LARGE', 413);
    const file = this.file(record.id), temporary = `${file}.${randomUUID()}.tmp`; let handle;
    try {
      await this.assertLease(); handle = await this.io.open(temporary, 'wx', 0o600); await handle.writeFile(encoded); await handle.sync(); await handle.close(); handle = null;
      await this.assertLease(); await this.io.rename(temporary, file); return hash(encoded);
    } catch {
      // A failed acknowledgement can follow a committed rename. Do not let a
      // subsequent update overwrite evidence using the older in-memory record.
      this.storageError = fail('A direct-job write could not be confirmed. Existing receipts were preserved; restart or recover storage before continuing.', 'DIRECT_JOB_STORAGE', 503);
      throw this.storageError;
    } finally { await handle?.close().catch(() => {}); await this.io.rm(temporary, { force: true }).catch(() => {}); }
  }
  serialized(operation) {
    if (this.closed) return Promise.reject(fail('Direct execution storage is closed.', 'DIRECT_JOB_CLOSED', 503));
    const pending = this.tail.catch(() => {}).then(async () => { await this.init(); if (this.storageError) throw this.storageError; await this.assertLease(); return operation(); });
    this.tail = pending; return pending;
  }
  get(id, { ownerId } = {}) {
    return this.serialized(async () => {
      const value = this.records.get(id);
      if (!jobId(id) || !value || ownerId !== undefined && value.ownerId !== ownerId) throw fail('This direct job is unavailable.', 'DIRECT_JOB_NOT_FOUND', 404);
      return clone(await this.fullRecord(value));
    });
  }
  matching({ ownerId, status, unfinishedOnly = false } = {}) {
    if (ownerId !== undefined && !principal(ownerId) || status !== undefined && !DIRECT_JOB_STATES.includes(status) || typeof unfinishedOnly !== 'boolean') throw fail('Use a supported direct-job filter.');
    return [...this.records.values()].filter(value => (ownerId === undefined || value.ownerId === ownerId) && (status === undefined || value.status === status) && (!unfinishedOnly || !directJobTerminal(value)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
  snapshot(options = {}) { return this.serialized(() => this.matching(options).map(metadata)); }
  counts({ ownerId } = {}) {
    return this.serialized(() => {
      if (ownerId !== undefined && !principal(ownerId)) throw fail('Use a supported direct-job filter.');
      if (ownerId === undefined) return { total: this.records.size, unfinished: this.unfinished };
      let total = 0, unfinished = 0;
      for (const value of this.records.values()) if (value.ownerId === ownerId) { total++; if (!directJobTerminal(value)) unfinished++; }
      return { total, unfinished };
    });
  }
  listMetadata(options = {}) { return this.list({ ...options, metadataOnly: true }); }
  list({ ownerId, status, offset = 0, limit = 40, metadataOnly = false } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || typeof metadataOnly !== 'boolean') return Promise.reject(fail('Use a supported direct-job filter.'));
    return this.serialized(async () => {
      const values = this.matching({ ownerId, status }), jobs = [];
      for (const value of values.slice(offset, offset + limit)) jobs.push(metadataOnly ? metadata(value) : clone(await this.fullRecord(value)));
      return { jobs, total: values.length, offset, limit, nextOffset: offset + limit < values.length ? offset + limit : null };
    });
  }
  findRequest({ ownerId, requestId: requestedId, requestDigest }) {
    if (!principal(ownerId) || !requestId(requestedId) || typeof requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(requestDigest)) return Promise.reject(fail('Use a valid direct request identity and digest.'));
    const id = `direct_${hash(`${ownerId}\0${requestedId}`)}`;
    // Wait for an earlier admission to finish before treating this key as new.
    // This lookup never admits, updates, or dispatches an action.
    return this.serialized(async () => {
      const existing = this.records.get(id);
      if (!existing) return null;
      if (existing.requestDigest !== requestDigest) throw fail('This requestId already belongs to different action arguments. Read the original job or use a new requestId.', 'DIRECT_REQUEST_CONFLICT', 409);
      return clone(await this.fullRecord(existing));
    });
  }
  admit({ ownerId, requestId: requestedId, tool, arguments: args, requiredScopes, client, mutating, interaction = null, originalRequestDigest, transientArguments = false }) {
    if (!principal(ownerId) || !requestId(requestedId) || typeof tool !== 'string' || !object(args) || !object(client) || client.id !== ownerId || !Array.isArray(client.scopes) || !Array.isArray(requiredScopes) || typeof mutating !== 'boolean') return Promise.reject(fail('Use a valid direct action request.'));
    const frozen = clone({ tool, arguments: args }), metadata = clone({ requiredScopes, client, mutating, interaction }), storedRequestDigest = directRequestDigest(frozen), digest = originalRequestDigest || storedRequestDigest, id = `direct_${hash(`${ownerId}\0${requestedId}`)}`;
    if (typeof transientArguments !== 'boolean' || !/^[a-f0-9]{64}$/.test(digest) || !transientArguments && digest !== storedRequestDigest) return Promise.reject(fail('Invalid direct request storage contract.'));
    return this.serialized(async () => {
      const existing = this.records.get(id);
      if (existing) {
        if (existing.requestDigest !== digest) throw fail('This requestId already belongs to different action arguments. Read the original job or use a new requestId.', 'DIRECT_REQUEST_CONFLICT', 409);
        return { created: false, job: clone(await this.fullRecord(existing)) };
      }
      if (this.unfinished >= this.maxJobs) throw fail('The unfinished direct-job limit has been reached. Finish or cancel pending work before admitting another action; completed receipts were preserved.', 'DIRECT_JOB_LIMIT', 503);
      const at = timestamp(), record = { version: 1, id, ownerId, requestId: requestedId, requestDigest: digest, storedRequestDigest, transientArguments, ...frozen, ...metadata,
        status: metadata.interaction ? 'awaiting_input' : 'queued', revision: 1, createdAt: at, updatedAt: at, startedAt: null, finishedAt: null, dispatched: false, effects: { possible: false, confirmed: false }, result: null, error: null };
      this.remember(record, await this.save(record)); return { created: true, job: clone(record) };
    });
  }
  update(id, updater, { expectedRevision } = {}) {
    if (typeof updater !== 'function') return Promise.reject(fail('A direct job update requires a host operation.'));
    return this.serialized(async () => {
      const indexed = this.records.get(id); if (!indexed) throw fail('This direct job is unavailable.', 'DIRECT_JOB_NOT_FOUND', 404);
      if (expectedRevision !== undefined && indexed.revision !== expectedRevision) throw Object.assign(fail('This direct job changed. Read it before trying again.', 'DIRECT_JOB_CONFLICT', 409), { currentRevision: indexed.revision });
      const current = await this.fullRecord(indexed);
      const change = await updater(clone(current)); if (change === null) return clone(current);
      if (!object(change)) throw fail('Invalid direct job update.');
      for (const key of ['id', 'ownerId', 'requestId', 'requestDigest', 'storedRequestDigest', 'transientArguments', 'tool', 'arguments', 'requiredScopes', 'client', 'createdAt', 'mutating']) if (Object.hasOwn(change, key)) throw fail('A direct job cannot change its admitted request.');
      const next = { ...current, ...clone(change), revision: current.revision + 1, updatedAt: timestamp() };
      if (directJobTerminal(current) && !directJobTerminal(next) && this.unfinished >= this.maxJobs) throw fail('The unfinished direct-job limit has been reached.', 'DIRECT_JOB_LIMIT', 503);
      this.remember(next, await this.save(next)); return clone(next);
    });
  }
  async close() {
    this.closed = true; await this.tail.catch(() => {}); await this.ready?.catch(() => {});
    await this.releaseLease();
  }
}
