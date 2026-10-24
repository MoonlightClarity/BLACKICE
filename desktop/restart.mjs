import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const STATUSES = new Set(['scheduled', 'restarting', 'completed', 'failed', 'cancelled', 'interrupted']);
const PENDING = new Set(['scheduled', 'restarting']);
const MODES = new Set(['window', 'background', 'headless']);
const MESSAGES = {
  DESKTOP_RESTART_STORAGE_UNAVAILABLE: 'The saved restart receipt could not be safely read or written.',
  DESKTOP_RESTART_HISTORY_FULL: 'Restart receipt history is full; new restart requests are disabled to preserve idempotency.',
  DESKTOP_RESTART_BUSY: 'BLACKICE must be idle before restarting.',
  DESKTOP_RESTART_REQUEST_MISMATCH: 'This request ID was saved with a different force choice. Inspect that receipt; use a new ID for a new restart intent.',
  DESKTOP_RESTART_CLOSING: 'BLACKICE is already closing.',
  DESKTOP_RESTART_BROWSER_BUSY: 'Finish browser actions, downloads, page loads, or pending interactions before restarting BLACKICE.',
  DESKTOP_RESTART_BROWSER_STATE: 'Browser state could not be checked before restarting BLACKICE.',
  DESKTOP_RESTART_STORAGE: 'Pending browser or direct-action storage could not be safely drained before restarting BLACKICE.',
  DESKTOP_RESTART_DRAIN_TIMEOUT: 'BLACKICE could not finish pending writes before the restart deadline.',
  DESKTOP_RESTART_RELEASED: 'The pending restart preparation was released.',
  DESKTOP_RESTART_NOT_PREPARED: 'BLACKICE has no prepared native restart gate.',
  DESKTOP_RESTART_CANCELLED: 'The restart request was cancelled before relaunch was armed.',
  DESKTOP_RESTART_ORIGIN_INVALID: 'The restart origin is no longer an owned direct action.',
  DESKTOP_RESTART_ORIGIN_UNAUTHORIZED: 'The originating connection is no longer authorized to restart BLACKICE.',
  DESKTOP_RESTART_ORIGIN_FAILED: 'The originating action did not succeed; BLACKICE remains open.',
  DESKTOP_RESTART_RECEIPT_UNAVAILABLE: 'The originating action receipt could not be verified.',
  DESKTOP_RESTART_RECEIPT_TIMEOUT: 'The originating action did not finish before the restart deadline.',
  DESKTOP_RESTART_ACK_UNAVAILABLE: 'The native restart scheduling acknowledgement could not be delivered. Inspect the same request ID before continuing.',
  DESKTOP_RESTART_PREPARE_FAILED: 'BLACKICE could not prepare a graceful restart and remains open.',
  DESKTOP_RESTART_RELEASE_FAILED: 'The restart barrier could not be released safely.',
  DESKTOP_RESTART_LAUNCH_INVALID: 'Restart launch options must preserve the current profile and desktop mode.',
  DESKTOP_RESTART_ARM_FAILED: 'The replacement process could not be armed; BLACKICE remains open.',
  DESKTOP_RESTART_QUIT_UNCONFIRMED: 'Relaunch was armed, but the graceful quit request could not be confirmed.',
  DESKTOP_RESTART_INTERRUPTED: 'The prior process stopped before the restart handoff; this request will not be replayed.',
  DESKTOP_RESTART_MODE_CHANGED: 'BLACKICE reopened in a different desktop mode; this restart request will not be replayed.',
};
function failure(code, status = 409) { return Object.assign(new Error(MESSAGES[code] || 'The restart request could not be completed.'), { code, status }); }
const BLOCKERS = {
  maintenance: 'BLACKICE is already preparing profile maintenance.',
  active_runs: 'Active agent work must finish or be stopped before restarting BLACKICE.',
  learning: 'A background learning review must finish or be stopped before restarting BLACKICE.',
  application_sessions: 'End private application sessions before restarting BLACKICE; they may contain unsaved work.',
  pending_actions: 'Queued work, sign-ins, or connection checks must finish or be stopped before restarting BLACKICE.',
  direct_actions: 'Unfinished direct actions, including actions waiting for input, must finish or be cancelled before restarting BLACKICE.',
};
function publicError(error) { const code = MESSAGES[error?.code] ? error.code : 'DESKTOP_RESTART_PREPARE_FAILED'; const blocker = code === 'DESKTOP_RESTART_BUSY' && Object.hasOwn(BLOCKERS, error?.blocker) ? error.blocker : null; return { code, message: blocker ? BLOCKERS[blocker] : MESSAGES[code], ...(blocker ? { blocker } : {}) }; }
function copy(value) { return value == null ? value : structuredClone(value); }
function text(value, max = 240) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value); }
function requestKey(ownerId, requestId) { return JSON.stringify([ownerId, requestId]); }
function sameProfile(left, right) { if (!text(left, 4096) || !text(right, 4096)) return false; const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value); return normalize(left) === normalize(right); }
function validDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

/**
 * A restart is an app-owned, one-shot handoff. No saved request is ever replayed.
 * relaunch and quit are synchronous Electron callbacks; relaunch is armed first.
 */
export class DesktopRestartController {
  constructor({ profileDir, getIdentity, getLaunchOptions, checkReady = async () => {}, prepare = async () => {}, release = async () => {}, relaunch, quit, receiptTimeoutMs = 30000, pollMs = 100, maxHistory = 1024, io = fs, now = () => Date.now() } = {}) {
    if (!text(profileDir, 4096) || !path.isAbsolute(profileDir)) throw new TypeError('An absolute desktop profile directory is required.');
    for (const callback of [getIdentity, getLaunchOptions, checkReady, prepare, release, relaunch, quit]) if (typeof callback !== 'function') throw new TypeError('Desktop restart callbacks are required.');
    if (![receiptTimeoutMs, pollMs].every(value => Number.isFinite(value) && value > 0) || !Number.isSafeInteger(maxHistory) || maxHistory < 1 || maxHistory > 4096) throw new TypeError('Invalid desktop restart bounds.');
    Object.assign(this, { profileDir: path.resolve(profileDir), getIdentity, getLaunchOptions, checkReady, prepare, release, relaunch, quit, receiptTimeoutMs, pollMs, maxHistory, now });
    this.io = { ...fs, ...io }; this.file = path.join(this.profileDir, 'desktop-restart.json'); this.receipts = []; this.loaded = new Set(); this.storageError = null; this.operationalError = null; this.active = null; this.initPromise = null; this.tail = Promise.resolve(); this.handoff = Promise.resolve(null);
  }
  timestamp() { return new Date(this.now()).toISOString(); }
  serial(operation) { const result = this.tail.then(operation); this.tail = result.catch(() => {}); return result; }
  identity(value) {
    if (!value || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !validDate(value.startedAt) || !path.isAbsolute(value.profileDir || '') || !sameProfile(value.profileDir, this.profileDir) || !MODES.has(value.mode)) throw failure('DESKTOP_RESTART_LAUNCH_INVALID');
    return { pid: value.pid, startedAt: new Date(value.startedAt).toISOString(), profileDir: this.profileDir, mode: value.mode };
  }
  validateReceipt(value) {
    if (!value || !text(value.id, 120) || !text(value.ownerId) || !text(value.requestId, 120) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value.requestId) || value.jobId !== null && !text(value.jobId) || !STATUSES.has(value.status) || !validDate(value.requestedAt) || !validDate(value.updatedAt) || value.completedAt !== undefined && !validDate(value.completedAt)) throw failure('DESKTOP_RESTART_STORAGE_UNAVAILABLE');
    const receipt = { id: value.id, requestId: value.requestId, ownerId: value.ownerId, jobId: value.jobId, status: value.status, requestedAt: value.requestedAt, updatedAt: value.updatedAt, origin: this.identity(value.origin), durable: true };
    if (value.force !== undefined && typeof value.force !== 'boolean') throw failure('DESKTOP_RESTART_STORAGE_UNAVAILABLE');
    receipt.force = value.force === true;
    if (value.completedAt !== undefined) receipt.completedAt = value.completedAt;
    if (value.started !== undefined) receipt.started = this.identity(value.started);
    if (value.error !== undefined) { if (!MESSAGES[value.error?.code]) throw failure('DESKTOP_RESTART_STORAGE_UNAVAILABLE'); receipt.error = publicError(value.error); }
    return receipt;
  }
  async init() {
    if (!this.initPromise) this.initPromise = (async () => {
      try {
        const stat = await this.io.lstat(this.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw failure('DESKTOP_RESTART_STORAGE_UNAVAILABLE');
        const saved = JSON.parse(await this.io.readFile(this.file, 'utf8'));
        if (saved.version !== 1 || !Array.isArray(saved.receipts) || saved.receipts.length > this.maxHistory) throw failure('DESKTOP_RESTART_STORAGE_UNAVAILABLE');
        const receipts = saved.receipts.map(value => this.validateReceipt(value)), keys = new Set(receipts.map(value => requestKey(value.ownerId, value.requestId)));
        if (keys.size !== receipts.length || new Set(receipts.map(value => value.id)).size !== receipts.length || receipts.filter(value => PENDING.has(value.status)).length > 1) throw failure('DESKTOP_RESTART_STORAGE_UNAVAILABLE');
        this.receipts = receipts; this.loaded = new Set(receipts.filter(value => PENDING.has(value.status)).map(value => value.id));
      } catch (error) { if (error.code !== 'ENOENT') this.storageError = publicError(failure('DESKTOP_RESTART_STORAGE_UNAVAILABLE')); }
      return this.status();
    })();
    return this.initPromise;
  }
  // Consult after init, before starting schedulers. This only recognizes a
  // pending handoff loaded from the prior process; it never confirms or replays it.
  isRestartStartup(identity) {
    if (this.storageError || !this.loaded.size) return false;
    let current; try { current = this.identity(identity ?? this.getIdentity()); } catch { return false; }
    return this.receipts.some(receipt => this.loaded.has(receipt.id) && receipt.status === 'restarting' && sameProfile(receipt.origin.profileDir, current.profileDir) && receipt.origin.mode === current.mode && (receipt.origin.pid !== current.pid || receipt.origin.startedAt !== current.startedAt));
  }
  status({ ownerId } = {}) {
    const error = this.storageError || this.operationalError || (this.receipts.length >= this.maxHistory ? publicError(failure('DESKTOP_RESTART_HISTORY_FULL')) : null);
    const latest = this.receipts.at(-1), receipt = ownerId === undefined ? null : this.receipts.findLast(value => value.ownerId === ownerId);
    return { available: !error, provider: 'electron', status: latest?.status || 'idle', ...(receipt ? { receipt: copy(receipt) } : {}), ...(error ? { error: copy(error) } : {}) };
  }
  receipt({ ownerId, requestId } = {}) { return copy(this.receipts.find(value => value.ownerId === ownerId && value.requestId === requestId) || null); }
  isPending() { return Boolean(this.active && !this.active.armed); }
  cancelPending({ ownerId, requestId, jobId } = {}) {
    const active = this.active;
    if (!active || active.armed || ownerId !== undefined && active.ownerId !== ownerId || requestId !== undefined && active.requestId !== requestId || jobId !== undefined && active.jobId !== jobId) return false;
    active.controller.abort();
    return true;
  }
  releaseActive(active) {
    active.detachSignal?.();
    if (!active.armed && this.active === active) this.active = null;
  }
  async persist(receipts) {
    const temporary = `${this.file}.${randomUUID()}.tmp`, encoded = JSON.stringify({ version: 1, receipts }) + '\n'; let handle;
    try {
      await this.io.mkdir(this.profileDir, { recursive: true });
      handle = await this.io.open(temporary, 'wx', 0o600); await handle.writeFile(encoded); await handle.sync(); await handle.close(); handle = null;
      try { await this.io.rename(temporary, this.file); }
      catch (error) {
        let committed = false;
        try { const stat = await this.io.lstat(this.file); committed = stat.isFile() && !stat.isSymbolicLink() && stat.size === Buffer.byteLength(encoded) && await this.io.readFile(this.file, 'utf8') === encoded; } catch {}
        if (!committed) throw error;
      }
      // Windows does not expose directory fsync. On supporting platforms, sync
      // the rename as well as the file before allowing a process to quit.
      let directory;
      try { directory = await this.io.open(this.profileDir, 'r'); await directory.sync(); }
      catch (error) { if (process.platform !== 'win32' || !['EINVAL', 'ENOTSUP', 'EBADF', 'EPERM', 'EISDIR', 'EACCES'].includes(error.code)) throw error; }
      finally { await directory?.close(); }
      this.receipts = receipts;
    } catch (error) { this.storageError = publicError(failure('DESKTOP_RESTART_STORAGE_UNAVAILABLE')); throw failure('DESKTOP_RESTART_STORAGE_UNAVAILABLE', 503); }
    finally { await handle?.close().catch(() => {}); await this.io.unlink(temporary).catch(() => {}); }
  }
  async update(id, changes) {
    return this.serial(async () => {
      const receipt = { ...this.receipts.find(value => value.id === id), ...changes, updatedAt: this.timestamp(), durable: true };
      await this.persist(this.receipts.map(value => value.id === id ? receipt : value)); return copy(receipt);
    });
  }
  abortIfNeeded(signal) { if (signal?.aborted) throw failure('DESKTOP_RESTART_CANCELLED'); }
  async request({ requestId, ownerId = 'local', jobId = null, force = false, origin: actionOrigin = null, waitForReceipt = null, waitForAcknowledgement = null, signal } = {}) {
    await this.init();
    if (!text(requestId, 120) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(requestId) || !text(ownerId) || typeof force !== 'boolean' || jobId !== null && !text(jobId) || waitForReceipt !== null && typeof waitForReceipt !== 'function' || waitForAcknowledgement != null && typeof waitForAcknowledgement !== 'function') throw new TypeError('A stable restart request ID, owner and boolean force choice are required.');
    return this.serial(async () => {
      const previous = this.receipts.find(value => value.requestId === requestId && value.ownerId === ownerId); if (previous) { if (previous.force !== force) throw failure('DESKTOP_RESTART_REQUEST_MISMATCH'); return copy(previous); }
      if (this.storageError) throw failure('DESKTOP_RESTART_STORAGE_UNAVAILABLE', 503);
      if (this.operationalError) throw failure(this.operationalError.code, 503);
      if (this.receipts.length >= this.maxHistory) throw failure('DESKTOP_RESTART_HISTORY_FULL');
      if (this.active || this.receipts.some(value => PENDING.has(value.status))) throw failure('DESKTOP_RESTART_BUSY');
      this.abortIfNeeded(signal);
      const origin = this.identity(await this.getIdentity()), at = this.timestamp(); this.abortIfNeeded(signal);
      const receipt = { id: randomUUID(), requestId, ownerId, jobId, force, status: 'scheduled', requestedAt: at, updatedAt: at, origin, durable: true };
      const active = this.active = { id: receipt.id, ownerId, requestId, jobId, armed: false, controller: new AbortController() };
      const abort = () => { if (!active.armed) active.controller.abort(); };
      signal?.addEventListener('abort', abort, { once: true });
      active.detachSignal = () => signal?.removeEventListener('abort', abort);
      if (signal?.aborted) abort();
      let complete;
      this.handoff = new Promise(resolve => { complete = resolve; });
      const context = { requestId, ownerId, jobId, force, origin: actionOrigin, signal: active.controller.signal };
      try {
        // Save the identity before readiness checks so a refusal has a durable,
        // same-request receipt instead of disappearing into a secondary process.
        await this.persist([...this.receipts, receipt]);
        const ready = await this.bounded(() => this.checkReady(context), performance.now() + this.receiptTimeoutMs, context.signal);
        if (ready === false || ready?.ready === false) throw failure('DESKTOP_RESTART_BUSY');
        this.abortIfNeeded(context.signal);
      } catch (error) {
        const failed = { ...receipt, status: error?.code === 'DESKTOP_RESTART_CANCELLED' ? 'cancelled' : 'failed', error: publicError(error), updatedAt: this.timestamp(), durable: !this.storageError };
        try {
          if (this.storageError) throw failure('DESKTOP_RESTART_STORAGE_UNAVAILABLE', 503);
          await this.persist(this.receipts.map(value => value.id === active.id ? failed : value));
          complete(copy(failed)); return copy(failed);
        } catch (storageError) { complete({ ...failed, durable: false }); throw storageError; }
        finally { this.releaseActive(active); }
      }
      // The receipt must return to the caller before any closing work begins.
      setImmediate(() => { this.runHandoff(active, { ...context, waitForReceipt, waitForAcknowledgement }).then(complete, () => complete(copy(this.receipts.find(value => value.id === active.id)))); });
      return copy(receipt);
    });
  }
  waitForHandoff() { return this.handoff; }
  async bounded(callback, deadline, signal) {
    this.abortIfNeeded(signal); const remaining = deadline - performance.now();
    if (remaining <= 0) throw failure('DESKTOP_RESTART_RECEIPT_TIMEOUT');
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (action, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); action(value); };
      const abort = () => finish(reject, failure('DESKTOP_RESTART_CANCELLED'));
      const timer = setTimeout(() => finish(reject, failure('DESKTOP_RESTART_RECEIPT_TIMEOUT')), remaining);
      signal?.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(callback).then(value => finish(resolve, value), error => finish(reject, error));
    });
  }
  async waitForOrigin(waitForReceipt, signal) {
    if (!waitForReceipt) { this.abortIfNeeded(signal); return; }
    const deadline = performance.now() + this.receiptTimeoutMs;
    while (true) {
      let job;
      try { job = await this.bounded(waitForReceipt, deadline, signal); }
      catch (error) { throw MESSAGES[error?.code] ? error : failure('DESKTOP_RESTART_RECEIPT_UNAVAILABLE'); }
      this.abortIfNeeded(signal);
      if (job?.status === 'succeeded' && validDate(job.finishedAt)) return;
      if (job?.status === 'cancelled') throw failure('DESKTOP_RESTART_CANCELLED');
      if (['failed', 'interrupted'].includes(job?.status)) throw failure('DESKTOP_RESTART_ORIGIN_FAILED');
      if (!job || typeof job.status !== 'string') throw failure('DESKTOP_RESTART_RECEIPT_UNAVAILABLE');
      await this.bounded(() => new Promise(resolve => setTimeout(resolve, Math.min(this.pollMs, Math.max(1, deadline - performance.now())))), deadline, signal);
    }
  }
  launchOptions(value, origin) {
    if (!value || !text(value.execPath, 4096) || !path.isAbsolute(value.execPath) || !Array.isArray(value.args) || value.args.some(argument => typeof argument !== 'string' || argument.includes('\0') || /^--(?:restart|quit|force)(?:=|$)/.test(argument)) || !sameProfile(value.profileDir, this.profileDir) || !MODES.has(value.mode) || value.mode !== origin.mode) throw failure('DESKTOP_RESTART_LAUNCH_INVALID');
    return { execPath: value.execPath, args: [...value.args] };
  }
  async runHandoff(active, context) {
    const { waitForReceipt, waitForAcknowledgement, signal } = context;
    let prepared = false;
    try {
      if (waitForAcknowledgement) {
        try { await this.bounded(waitForAcknowledgement, performance.now() + this.receiptTimeoutMs, signal); }
        catch (error) { throw error?.code === 'DESKTOP_RESTART_CANCELLED' ? error : failure('DESKTOP_RESTART_ACK_UNAVAILABLE'); }
      }
      await this.waitForOrigin(waitForReceipt, signal); this.abortIfNeeded(signal);
      prepared = true; const ready = await this.bounded(() => this.prepare(context), performance.now() + this.receiptTimeoutMs, signal);
      if (ready === false || ready?.ready === false) throw failure('DESKTOP_RESTART_BUSY');
      this.abortIfNeeded(signal);
      const receipt = this.receipts.find(value => value.id === active.id), options = this.launchOptions(await this.getLaunchOptions(), receipt.origin);
      this.abortIfNeeded(signal); await this.update(active.id, { status: 'restarting' }); this.abortIfNeeded(signal);
      try { this.relaunch(options); } catch (error) { throw MESSAGES[error?.code] ? error : failure('DESKTOP_RESTART_ARM_FAILED'); }
      active.armed = true;
      // There must be no awaited or fallible preparation between arming Electron
      // and requesting its existing graceful before-quit shutdown path.
      try { this.quit(); }
      catch { this.receipts = this.receipts.map(value => value.id === active.id ? { ...value, error: publicError(failure('DESKTOP_RESTART_QUIT_UNCONFIRMED')), durable: false } : value); }
      return copy(this.receipts.find(value => value.id === active.id));
    } catch (error) {
      if (active.armed) return copy(this.receipts.find(value => value.id === active.id));
      if (prepared) {
        try { await this.release(context); }
        catch { this.operationalError = publicError(failure('DESKTOP_RESTART_RELEASE_FAILED')); error = failure('DESKTOP_RESTART_RELEASE_FAILED'); }
      }
      const changes = { status: error?.code === 'DESKTOP_RESTART_CANCELLED' ? 'cancelled' : 'failed', error: publicError(error) };
      try { if (this.storageError) throw failure('DESKTOP_RESTART_STORAGE_UNAVAILABLE'); return await this.update(active.id, changes); }
      catch { const failed = { ...this.receipts.find(value => value.id === active.id), ...changes, error: this.storageError || changes.error, updatedAt: this.timestamp(), durable: false }; this.receipts = this.receipts.map(value => value.id === active.id ? failed : value); return copy(failed); }
    } finally { this.releaseActive(active); }
  }
  async confirmStartup(identity) {
    await this.init();
    return this.serial(async () => {
      if (this.storageError || !this.loaded.size) return this.status();
      let current; try { current = this.identity(await (identity ?? this.getIdentity())); } catch { return this.status(); }
      const at = this.timestamp(); let changed = false;
      const receipts = this.receipts.map(receipt => {
        if (!this.loaded.has(receipt.id)) return receipt;
        if (receipt.status === 'scheduled') { changed = true; return { ...receipt, status: 'interrupted', error: publicError(failure('DESKTOP_RESTART_INTERRUPTED')), updatedAt: at }; }
        if (receipt.status === 'restarting' && sameProfile(receipt.origin.profileDir, current.profileDir) && (receipt.origin.pid !== current.pid || receipt.origin.startedAt !== current.startedAt)) {
          changed = true;
          if (receipt.origin.mode !== current.mode) return { ...receipt, status: 'interrupted', updatedAt: at, started: current, error: publicError(failure('DESKTOP_RESTART_MODE_CHANGED')) };
          return { ...receipt, status: 'completed', updatedAt: at, completedAt: at, started: current };
        }
        return receipt;
      });
      if (changed) { try { await this.persist(receipts); for (const receipt of receipts) if (!PENDING.has(receipt.status)) this.loaded.delete(receipt.id); } catch { /* Opening BLACKICE must remain possible when restart storage fails. */ } }
      return this.status();
    });
  }
}
