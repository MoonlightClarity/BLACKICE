import { promises as fs } from 'node:fs';
import path from 'node:path';

const COMPONENTS = new Set(['desktop', 'server', 'runtime', 'provider', 'engine', 'browser', 'storage', 'maintenance', 'operations', 'inbox', 'learning', 'system']);
const EVENTS = new Set(['started', 'ready', 'stopping', 'stopped', 'start_failed', 'stop_failed', 'request_failed', 'run_started', 'run_finished', 'uncaught_exception', 'unhandled_rejection', 'renderer_gone', 'emergency_stop', 'emergency_stop_failed', 'runtime_failed', 'provider_failed', 'browser_failed', 'storage_failed', 'storage_recovered', 'backup_started', 'backup_completed', 'backup_failed', 'restore_started', 'restore_completed', 'restore_failed', 'repair_started', 'repair_completed', 'repair_failed', 'maintenance_started', 'maintenance_completed', 'maintenance_failed', 'support_exported', 'restart_failed', 'window_reopen_failed', 'lifecycle_request_failed', 'desktop_detach_failed']);
const LEVELS = new Set(['info', 'warning', 'error']);
const CODES = new Set(['OK', 'UNKNOWN_ERROR', 'EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EROFS', 'EMFILE', 'ENFILE', 'EIO', 'EBUSY', 'EEXIST', 'EINVAL', 'EADDRINUSE', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ABORT_ERR', 'CODEX_DISCONNECTED', 'CODEX_TIMEOUT', 'CODEX_RUN_TIMEOUT', 'CODEX_UNAUTHENTICATED', 'CODEX_HISTORY_UNSUPPORTED', 'PROVIDER_AUTH', 'PROVIDER_ACCESS', 'PROVIDER_QUOTA', 'PROVIDER_RATE_LIMIT', 'PROVIDER_MODEL', 'PROVIDER_ENDPOINT', 'PROVIDER_SERVICE', 'PROVIDER_NETWORK', 'PROVIDER_PROTOCOL', 'PROVIDER_TIMEOUT', 'PROVIDER_IDLE_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_HTTP', 'PROVIDER_TRUNCATED', 'PROVIDER_STEP_LIMIT', 'CONTEXT_OVERFLOW', 'BROWSER_TIMEOUT', 'BROWSER_UNAVAILABLE', 'BROWSER_RECOVERY_REQUIRED', 'BROWSER_SHUTDOWN_TIMEOUT', 'STORAGE_FAILED', 'CONVERSATION_STATE_DAMAGED', 'BACKUP_FAILED', 'RESTORE_FAILED', 'MAINTENANCE_FAILED']);
const RENDERER_REASONS = new Set(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction']);
const COUNTS = new Set(['runs', 'savedRuns', 'activeRuns', 'queuedRuns', 'conversations', 'providers', 'configuredProviders', 'connections', 'connectedConnections', 'attachments', 'deployments', 'jobs', 'pendingReviews', 'downloads', 'openTabs']);
const HEALTH = new Set(['storageHealthy', 'conversationStorageHealthy', 'identityHealthy', 'attachmentsHealthy', 'knowledgeHealthy', 'promptsHealthy', 'providersReady', 'browserAvailable', 'desktopAvailable', 'operationsPaused', 'inboxPaused']);
const PLATFORMS = new Set(['win32', 'darwin', 'linux', 'freebsd', 'openbsd', 'aix', 'sunos', 'android']);
const ARCHITECTURES = new Set(['x64', 'arm64', 'ia32', 'arm', 'ppc64', 's390x', 'riscv64', 'loong64']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validVersion = value => typeof value === 'string' && /^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(value) ? value : 'unknown';
const safeCode = value => CODES.has(value) ? value : 'UNKNOWN_ERROR';
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const bounded = (value, fallback, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
function sanitizeEvent(value, at) {
  if (!plain(value) || !COMPONENTS.has(value.component) || !EVENTS.has(value.event) || !validDate(at)) return null;
  const result = { at, component: value.component, event: value.event, level: LEVELS.has(value.level) ? value.level : 'info' };
  if (value.code !== undefined) result.code = safeCode(value.code);
  if (Number.isSafeInteger(value.status) && value.status >= 100 && value.status <= 599) result.status = value.status;
  if (['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted'].includes(value.state)) result.state = value.state;
  if (RENDERER_REASONS.has(value.reason)) result.reason = value.reason;
  if (Number.isSafeInteger(value.exitCode) && value.exitCode >= -2147483648 && value.exitCode <= 2147483647) result.exitCode = value.exitCode;
  return result;
}
function safeState(value, keys, check) {
  const result = {};
  if (!plain(value)) return result;
  for (const key of keys) if (check(value[key])) result[key] = value[key];
  return result;
}

/** Local diagnostic metadata only. No arbitrary text, paths, IDs or payloads enter a log. */
export class DiagnosticsStore {
  constructor({ dataDir, version, platform = process.platform, arch = process.arch, io = fs, now = () => new Date(), maxFileBytes, maxFiles, maxEvents, maxPending } = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new Error('Diagnostics require an absolute data directory.');
    this.directory = path.join(dataDir, 'diagnostics'); this.io = io; this.now = now;
    this.version = validVersion(version); this.platform = PLATFORMS.has(platform) ? platform : 'unknown'; this.arch = ARCHITECTURES.has(arch) ? arch : 'unknown';
    this.maxFileBytes = bounded(maxFileBytes, 256 * 1024, 512, 4 * 1024 * 1024); this.maxFiles = bounded(maxFiles, 3, 1, 10);
    this.maxEvents = bounded(maxEvents, 1000, 1, 10000); this.maxPending = bounded(maxPending, 128, 1, 1000);
    this.events = []; this.tail = Promise.resolve(); this.ready = null; this.closed = false; this.pending = 0;
    this.healthy = true; this.errorCode = null; this.dropped = 0; this.malformed = 0; this.truncatedFiles = 0; this.ioFailures = 0;
  }
  file(index) { return path.join(this.directory, `events.${index}.jsonl`); }
  timestamp() { try { const value = this.now(); const at = value instanceof Date ? value.toISOString() : value; return validDate(at) ? at : new Date().toISOString(); } catch { return new Date().toISOString(); } }
  remember(event) { this.events.push(event); if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents); }
  failed() { this.healthy = false; this.errorCode = 'DIAGNOSTICS_IO_FAILED'; this.ioFailures++; }
  init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      try {
        await this.io.mkdir(this.directory, { recursive: true });
        // A smaller retention setting must also retire segments from older runs.
        for (let index = this.maxFiles; index < 10; index++) await this.io.rm(this.file(index), { force: true });
        for (let index = this.maxFiles - 1; index >= 0; index--) {
          let handle;
          try {
            handle = await this.io.open(this.file(index), 'r'); const { size } = await handle.stat();
            const start = Math.max(0, size - this.maxFileBytes), bytes = Buffer.alloc(Math.min(size, this.maxFileBytes));
            const { bytesRead } = await handle.read(bytes, 0, bytes.length, start); let text = bytes.subarray(0, bytesRead).toString('utf8');
            if (start) { this.truncatedFiles++; text = text.slice(text.indexOf('\n') + 1); }
            for (const line of text.split('\n')) {
              if (!line.trim()) continue;
              try { const parsed = JSON.parse(line), event = sanitizeEvent(parsed, parsed.at); if (!event) this.malformed++; else this.remember(event); }
              catch { this.malformed++; }
            }
            await handle.close(); handle = null;
            if (size > this.maxFileBytes) await this.io.truncate(this.file(index), 0);
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          finally { await handle?.close().catch(() => {}); }
        }
      } catch { this.failed(); }
      return this;
    })();
    return this.ready;
  }
  record(value) {
    let event;
    try { event = sanitizeEvent(value, this.timestamp()); } catch { event = null; }
    if (!event || this.closed || this.pending >= this.maxPending) { this.dropped++; return Promise.resolve(false); }
    this.pending++;
    const save = async () => {
      await this.init(); this.remember(event);
      try { await this.write(event); this.healthy = true; this.errorCode = null; return true; }
      catch { this.failed(); return false; }
      finally { this.pending--; }
    };
    const pending = this.tail.then(save, save).catch(() => { this.pending = Math.max(0, this.pending - 1); this.failed(); return false; });
    this.tail = pending; return pending;
  }
  recordError(component, event, cause) {
    let code; try { code = safeCode(cause?.code); } catch { code = 'UNKNOWN_ERROR'; }
    return this.record({ component, event, level: 'error', code });
  }
  async write(event) {
    await this.io.mkdir(this.directory, { recursive: true });
    const line = `${JSON.stringify(event)}\n`; let size = 0, separator = '';
    let previous;
    try {
      previous = await this.io.open(this.file(0), 'r'); size = (await previous.stat()).size;
      if (size > 0 && size <= this.maxFileBytes) { const byte = Buffer.alloc(1); await previous.read(byte, 0, 1, size - 1); if (byte[0] !== 10) separator = '\n'; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { await previous?.close(); }
    if (size > this.maxFileBytes) { await this.io.truncate(this.file(0), 0); size = 0; separator = ''; this.truncatedFiles++; }
    if (size + Buffer.byteLength(separator + line) > this.maxFileBytes) {
      for (let index = this.maxFiles - 1; index > 0; index--) {
        await this.io.rm(this.file(index), { force: true });
        try { await this.io.rename(this.file(index - 1), this.file(index)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (this.maxFiles === 1) await this.io.rm(this.file(0), { force: true });
      separator = '';
    }
    const handle = await this.io.open(this.file(0), 'a', 0o600);
    try { await handle.writeFile(separator + line); await handle.sync(); } finally { await handle.close(); }
  }
  status() { return { healthy: this.healthy, errorCode: this.errorCode, ioFailures: this.ioFailures, pendingWrites: this.pending, retainedEvents: this.events.length, droppedEvents: this.dropped, malformedRecords: this.malformed, truncatedFiles: this.truncatedFiles, maxFiles: this.maxFiles, maxFileBytes: this.maxFileBytes, maxEvents: this.maxEvents }; }
  async flush() { await this.init(); await this.tail.catch(() => {}); return this.status(); }
  async snapshot({ version = this.version, counts, health } = {}) {
    await this.flush();
    return { format: 'relay-support', schemaVersion: 1, capturedAt: this.timestamp(), application: { name: 'Relay', version: validVersion(version), platform: this.platform, arch: this.arch }, diagnostics: this.status(), counts: safeState(counts, COUNTS, value => Number.isSafeInteger(value) && value >= 0), health: safeState(health, HEALTH, value => typeof value === 'boolean'), events: this.events.map(event => ({ ...event })) };
  }
  async close() { this.closed = true; return this.flush(); }
}
