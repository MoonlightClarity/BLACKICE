import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

// No receipt paths, request/owner IDs, arguments, result bodies, URLs or errors
// are written. This trace complements (and never replaces) durable job receipts.
const MAX_SPANS = 64, MAX_PENDING = 12, MAX_SLOW = 12, MAX_SAMPLES = 160;
const EDGES = Object.freeze([1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 30000, 120000]);
const OPERATIONS = new Set(['enumerate', 'stat', 'open', 'read', 'close', 'parse', 'validate', 'hash', 'index', 'recover',
  'pack-stat', 'pack-open', 'pack-read', 'pack-close', 'pack-validate', 'pack-hydrate']);
const ERROR_CODES = new Set(['EACCES', 'EPERM', 'EBUSY', 'EIO', 'ENOENT', 'EMFILE', 'ENFILE', 'ENOSPC', 'EROFS', 'EEXIST', 'ABORT_ERR']);
const safeCode = error => ERROR_CODES.has(error?.code) ? error.code : 'UNCLASSIFIED';
const elapsed = (now, start) => Math.max(0, Math.round(now - start));
const preciseDuration = (now, start) => Number.isFinite(now - start) ? Math.max(0, now - start) : 0;
const presentedMs = value => Number.isFinite(value) ? Math.max(0, Math.round(value * 1000) / 1000) : 0;
const digest = data => createHash('sha256').update(data).digest('hex');
const number = value => Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
const label = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,50}$/.test(value) ? value : 'unclassified';
const DEFAULT_DIAGNOSTIC_DEADLINE_MS = 250;
// Attach fulfillment AND rejection handlers before racing the deadline. A late
// diagnostic result can never become an unhandled rejection or block the app.
async function settleWithin(operation, deadlineMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(operation).then(value => ({ kind: 'fulfilled', value }),
        error => ({ kind: 'rejected', error })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ kind: 'timeout' }), deadlineMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export class StartupCriticalTrace {
  constructor({ dataDir, version = 'unknown', profileDir = dataDir, profileMode = 'unknown',
    executable = process.execPath, processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString(),
    io = fs, now = () => performance.now(), wall = () => Date.now(), intervalMs = 1500,
    maxBytes = 48 * 1024, startTimer = true, onFailure = () => {},
    buildTimeoutMs = DEFAULT_DIAGNOSTIC_DEADLINE_MS,
    checkpointTimeoutMs = DEFAULT_DIAGNOSTIC_DEADLINE_MS,
    createDelayMonitor = monitorEventLoopDelay } = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw Error('Trace requires an absolute data directory.');
    this.directory = path.join(dataDir, 'diagnostics', 'startup-critical');
    this.launchId = randomUUID(); this.file = path.join(this.directory, 'launch-' + this.launchId + '.json');
    this.io = io; this.now = now; this.wall = wall;
    this.intervalMs = Math.max(250, intervalMs); this.maxBytes = Math.min(64 * 1024, Math.max(2048, maxBytes));
    this.startTimer = startTimer; this.onFailure = onFailure;
    this.buildTimeoutMs = Math.max(10, Math.min(2000, buildTimeoutMs));
    this.checkpointTimeoutMs = Math.max(10, Math.min(2000, checkpointTimeoutMs));
    this.createDelayMonitor = createDelayMonitor;
    this.version = version; this.profileMode = profileMode;
    this.profileBinding = digest(path.resolve(profileDir || dataDir).toLowerCase());
    this.executableBinding = digest(path.resolve(executable).toLowerCase());
    this.processStartedAt = processStartedAt; this.pid = process.pid; this.ppid = process.ppid;
    this.startedAt = new Date(this.wall()).toISOString(); this.startMono = this.now();
    this.performanceTimeOriginMs = performance.timeOrigin;
    this.outcome = 'incomplete'; this.started = false; this.done = false;
    this.checkpointNumber = 0; this.lastCheckpointAt = null; this.pendingWrite = null;
    this.sourceRevision = 0; this.pendingWriteSourceRevision = null;
    this.finalCheckpointRequested = false; this.buildExpired = false; this.warningCount = 0;
    this.traceIo = { healthy: true, degraded: false, failedWrites: 0, droppedCheckpoints: 0,
      buildTimeouts: 0, checkpointTimeouts: 0, lateBuildSettlements: 0,
      finalCheckpointDeferred: false, lastErrorCode: null,
      renameRetries: 0, lastRenameRetryCode: null,
      lastWriteMs: null, maximumWriteMs: 0, tickLatenessMaxMs: 0 };
    this.spans = []; this.points = []; this.samples = []; this.droppedSamples = 0;
    this.activeSpans = new Map(); this.context = new AsyncLocalStorage(); this.nextSpan = 0;
    this.truncatedSpans = 0; this.ledger = { required: 0, dispatched: 0, validated: 0,
      failed: 0, bytes: 0, recovered: 0 };
    this.activeOps = new Map(); this.opNumber = 0; this.peakPending = 0;
    this.opMetrics = Object.fromEntries([...OPERATIONS].map(key => [key, {
      started: 0, completed: 0, failed: 0, cumulativeMs: 0, maxMs: 0,
      histogram: Array(EDGES.length + 1).fill(0),
    }]));
    this.slowest = []; this.delay = null; this.cpuStart = process.cpuUsage();
    this.eluStart = performance.eventLoopUtilization(); this.timer = null;
    this.source = { status: 'unverified', sourceCommit: null, fingerprint: null, files: null };
  }
  nowOffset() { return elapsed(this.now(), this.startMono); }
  reportDegraded(code) {
    this.traceIo.degraded = true;
    this.traceIo.lastErrorCode = code;
    // Do not emit an unbounded console stream if the diagnostic disk stalls.
    const n = ++this.warningCount;
    if (n === 1 || (n & (n - 1)) === 0) {
      try { this.onFailure({ code, writes: this.traceIo.failedWrites }); } catch {}
    }
  }
  // Return immutable binding metadata; never publish from an in-flight worker.
  // A worker completing after its deadline cannot replace the timeout state.
  async bindBuild(files = {}) {
    const hashes = {};
    try {
      for (const [key, file] of Object.entries(files)) {
        if (this.buildExpired) return null;
        if (!/^[a-z][a-z0-9-]{0,40}$/.test(key) || typeof file !== 'string' || !path.isAbsolute(file)) throw Error('Invalid build binding input.');
        hashes[key] = digest(await this.io.readFile(file));
        if (this.buildExpired) return null;
      }
      if (!Object.keys(hashes).length) throw Error('Missing build input.');
      return { status: 'verified-runtime-bytes', sourceCommit: null,
        fingerprint: digest(JSON.stringify(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)))),
        files: hashes };
    } catch (error) {
      return { status: 'unverified', sourceCommit: null, fingerprint: null, files: null, errorCode: safeCode(error) };
    }
  }
  start({ buildFiles = {} } = {}) {
    if (this.startTask) return this.startTask;
    this.started = true;
    this.source = { status: 'binding', sourceCommit: null, fingerprint: null, files: null };
    this.sourceRevision++;
    this.startTask = (async () => {
      const binding = Promise.resolve().then(() => this.bindBuild(buildFiles));
      // Explicitly observe late fulfillment/rejection; only the bounded caller
      // can publish a verified fingerprint. No late result can change it.
      void binding.then(() => {
        if (this.buildExpired) this.traceIo.lateBuildSettlements++;
      }, () => {
        if (this.buildExpired) this.traceIo.lateBuildSettlements++;
      });
      const bound = await settleWithin(binding, this.buildTimeoutMs);
      if (bound.kind === 'timeout') {
        this.buildExpired = true;
        this.traceIo.buildTimeouts++;
        this.source = { status: 'timed_out', sourceCommit: null, fingerprint: null, files: null, errorCode: 'TRACE_BUILD_TIMEOUT' };
        this.reportDegraded('TRACE_BUILD_TIMEOUT');
      } else {
        this.source = bound.kind === 'fulfilled' && bound.value
          ? bound.value
          : { status: 'unverified', sourceCommit: null, fingerprint: null, files: null,
            errorCode: bound.kind === 'rejected' ? safeCode(bound.error) : 'UNCLASSIFIED' };
        if (this.source.status !== 'verified-runtime-bytes') this.reportDegraded(this.source.errorCode || 'UNCLASSIFIED');
      }
      this.sourceRevision++;
      // finish() may run while build binding is still pending. Never create
      // or enable an event-loop monitor after terminal completion.
      if (!this.done) {
        let monitor;
        try {
          monitor = this.createDelayMonitor({ resolution: 20 });
          monitor.enable();
          this.delay = monitor;
        } catch {
          try { monitor?.disable?.(); } catch {}
          this.delay = null;
        }
      }
      // finish() may have captured a terminal snapshot before build binding
      // settled. Refresh only that older revision, not an already-current
      // terminal followup. A writer not yet snapshotted will capture fresh data.
      if (this.done && this.pendingWrite && this.pendingWriteSourceRevision !== null
        && this.pendingWriteSourceRevision < this.sourceRevision) {
        this.finalCheckpointRequested = true;
        this.traceIo.finalCheckpointDeferred = true;
      }
      await this.checkpoint(); // Bounded even if mkdir, sync or rename never settles.
      if (this.startTimer && !this.done) {
        let due = this.now() + this.intervalMs;
        this.timer = setInterval(() => {
          const actual = this.now(); this.traceIo.tickLatenessMaxMs = Math.max(
            this.traceIo.tickLatenessMaxMs, elapsed(actual, due));
          due = actual + this.intervalMs;
          void this.checkpoint();
        }, this.intervalMs);
        this.timer.unref?.();
      }
      return this.traceIo.healthy && !this.traceIo.degraded;
    })().catch(error => {
      this.reportDegraded(safeCode(error));
      return false; // Diagnostic setup can never prevent desktop startup.
    });
    return this.startTask;
  }
  mark(name) {
    if (this.points.length < 16) this.points.push({ name: label(name), atMs: this.nowOffset() });
  }
  begin(name) {
    const id = ++this.nextSpan; const parentId = this.context.getStore() || null;
    const span = { id, parentId, name: label(name), startMs: this.nowOffset(), endMs: null, outcome: 'incomplete' };
    if (this.spans.length < MAX_SPANS) this.spans.push(span);
    else this.truncatedSpans++;
    this.activeSpans.set(id, span);
    return span;
  }
  within(span, operation) {
    return this.context.run(span?.id || null, operation);
  }
  end(span, outcome, error) {
    if (!span || !this.activeSpans.has(span.id)) return;
    span.endMs = this.nowOffset(); span.durationMs = Math.max(0, span.endMs - span.startMs);
    span.outcome = outcome === 'ready' ? 'ready' : outcome === 'failed' ? 'failed' : 'interrupted';
    if (span.outcome === 'failed') span.errorCode = safeCode(error);
    this.activeSpans.delete(span.id);
  }
  beginOp(kind) {
    if (!OPERATIONS.has(kind)) return null;
    const token = { sequence: ++this.opNumber, kind, started: this.now() };
    const metric = this.opMetrics[kind]; metric.started++;
    this.activeOps.set(token.sequence, token);
    this.peakPending = Math.max(this.peakPending, this.activeOps.size);
    return token;
  }
  endOp(token, { error = null, bytes = 0 } = {}) {
    if (!token || !this.activeOps.delete(token.sequence)) return;
    // Retain fractional monotonic durations until presentation. Rounding each
    // receipt's sub-millisecond CPU operation loses hours of aggregate evidence.
    const durationMs = preciseDuration(this.now(), token.started), metric = this.opMetrics[token.kind];
    metric.completed++; metric.cumulativeMs += durationMs; metric.maxMs = Math.max(metric.maxMs, durationMs);
    const index = EDGES.findIndex(edge => durationMs <= edge);
    metric.histogram[index < 0 ? EDGES.length : index]++;
    if (error) metric.failed++;
    if (durationMs >= 25) {
      this.slowest.push({ kind: token.kind, durationMs, sequence: token.sequence, ...(error ? { errorCode: safeCode(error) } : {}) });
      this.slowest.sort((a, b) => b.durationMs - a.durationMs || a.sequence - b.sequence);
      this.slowest.length = Math.min(MAX_SLOW, this.slowest.length);
    }
    if (token.kind === 'read' && bytes) this.ledger.bytes += number(bytes);
  }
  async operation(kind, fn, bytesOfResult) {
    const token = this.beginOp(kind);
    try {
      const result = await fn();
      this.endOp(token, { bytes: bytesOfResult?.(result) || 0 });
      return result;
    } catch (error) { this.endOp(token, { error }); throw error; }
  }
  synchronous(kind, fn) {
    const token = this.beginOp(kind);
    try { const result = fn(); this.endOp(token); return result; }
    catch (error) { this.endOp(token, { error }); throw error; }
  }
  ledgerProgress(patch) {
    for (const key of Object.keys(this.ledger)) {
      const value = patch?.[key];
      if (Number.isSafeInteger(value) && value >= 0) this.ledger[key] = value;
    }
  }
  captureProgressSample() {
    this.samples.push(this.progressSample());
    if (this.samples.length > MAX_SAMPLES) { this.samples.shift(); this.droppedSamples++; }
  }
  progressSample() {
    const pending = [...this.activeOps.values()];
    const oldest = pending.reduce((best, value) => best && best.started < value.started ? best : value, null);
    const cpu = process.cpuUsage(this.cpuStart);
    const span = [...this.activeSpans.values()].at(-1);
    return { atMs: this.nowOffset(), stage: span?.name || 'idle',
      required: this.ledger.required, dispatched: this.ledger.dispatched, validated: this.ledger.validated,
      pending: pending.length, pendingKinds: [...new Set(pending.map(v => v.kind))].sort(),
      oldestPendingMs: oldest ? elapsed(this.now(), oldest.started) : 0,
      cpuMs: number((cpu.user + cpu.system) / 1000),
      eventLoopDelayMaxMs: this.delay?.count > 0 ? number(this.delay.max / 1e6) : null };
  }
  snapshot() {
    const now = this.now(), cpu = process.cpuUsage(this.cpuStart);
    const elu = performance.eventLoopUtilization(this.eluStart);
    const eluGood = Number.isFinite(elu.active) && Number.isFinite(elu.idle) && elu.active + elu.idle > 0;
    const pending = [...this.activeOps.values()].slice(0, MAX_PENDING)
      .map(v => ({ kind: v.kind, sequence: v.sequence, elapsedMs: elapsed(now, v.started) }));
    let loop = { available: false, reason: 'not-sampled', maxDelayMs: null, p99DelayMs: null, eluActiveMs: null, eluIdleMs: null };
    if (this.delay) {
      const max = this.delay.max / 1e6, p99 = this.delay.percentile(99) / 1e6;
      loop = { available: this.delay.count > 0, reason: this.delay.count > 0 ? null : 'no-delay-samples',
        maxDelayMs: Number.isFinite(max) ? number(max) : null,
        p99DelayMs: Number.isFinite(p99) ? number(p99) : null,
        eluAvailable: eluGood, eluReason: eluGood ? null : 'zero-or-unavailable-counters',
        eluActiveMs: eluGood ? number(elu.active) : null, eluIdleMs: eluGood ? number(elu.idle) : null };
    }
    return {
      schema: 'blackice-startup-critical-v1',
      launch: { id: this.launchId, version: this.version, pid: this.pid, ppid: this.ppid,
        processStartedAt: this.processStartedAt, traceStartedAt: this.startedAt,
        performanceTimeOriginMs: this.performanceTimeOriginMs, traceMonotonicStartMs: this.startMono,
        profileMode: this.profileMode, profilePathSha256: this.profileBinding,
        executablePathSha256: this.executableBinding, source: this.source },
      state: { outcome: this.outcome, incomplete: !this.done, lastCheckpointAt: this.lastCheckpointAt,
        monotonicElapsedMs: this.nowOffset(), checkpointNumber: this.checkpointNumber },
      spans: this.spans.map(v => ({ ...v, ...(v.endMs === null ? { elapsedMs: this.nowOffset() - v.startMs } : {}) })),
      points: this.points.map(v => ({ ...v })),
      progressSamples: this.samples.map(v => ({ ...v })), droppedSamples: this.droppedSamples, sampleIntervalMs: this.intervalMs,
      truncatedSpans: this.truncatedSpans, ledger: { ...this.ledger, queued: Math.max(0, this.ledger.required - this.ledger.dispatched),
        peakOperations: this.peakPending, pendingTotal: this.activeOps.size, pending },
      histogramBoundsMs: EDGES,
      operations: Object.fromEntries(Object.entries(this.opMetrics).map(([name, metric]) => [name, {
        ...metric, cumulativeMs: presentedMs(metric.cumulativeMs), maxMs: presentedMs(metric.maxMs),
        cumulativeMsInterpretation: 'overlapping-awaits-not-wall-time',
      }])),
      slowOperations: this.slowest.map(value => ({ ...value, durationMs: presentedMs(value.durationMs) })),
      processCpuMs: number((cpu.user + cpu.system) / 1000),
      eventLoop: loop,
      traceHealth: { ...this.traceIo },
      limits: 'No paths, job identities or payloads. Aggregate overlapping awaits cannot be added as a wall-time critical path. Last durable checkpoint may precede a hard crash, blocked event loop or failed diagnostics write.',
    };
  }
  publicStatus() {
    return { launchId: this.launchId, version: this.version, outcome: this.outcome,
      incomplete: !this.done, lastCheckpointAt: this.lastCheckpointAt,
      pendingCheckpoint: Boolean(this.pendingWrite),
      sourceStatus: this.source.status, sourceFingerprint: this.source.fingerprint,
      pendingOperations: [...this.activeOps.values()].slice(0, MAX_PENDING).map(v => v.kind),
      activeStages: [...this.activeSpans.values()].slice(0, MAX_SPANS).map(v => v.name),
      ledger: { ...this.ledger }, traceHealth: { ...this.traceIo } };
  }
  // Exactly one underlying writer for this trace. It may outlive its public
  // deadline, but no other write (or final checkpoint) overlaps it.
  async replaceCheckpoint(temp) {
    // Windows readers can briefly deny replacement. Retry only this rename,
    // retaining the same synced bytes and exclusive writer; never unlink the
    // previous checkpoint. The public diagnostic deadline remains independent.
    const deadline = performance.now() + 500;
    for (let attempt = 0; ; attempt++) {
      try { await this.io.rename(temp, this.file); return; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)
          || attempt >= 7 || performance.now() >= deadline) throw error;
        const delayMs = Math.min(4 * 2 ** attempt, 64, Math.max(0, deadline - performance.now()));
        this.traceIo.renameRetries++;
        this.traceIo.lastRenameRetryCode = error.code;
        await new Promise(resolve => setTimeout(resolve, delayMs));
        if (performance.now() >= deadline) throw error;
      }
    }
  }
  async persistCheckpoint() {
    this.checkpointNumber++;
    // A terminal checkpoint may persist later, but must not restart sampling.
    if (!this.done) this.captureProgressSample();
    const started = this.now();
    try {
      await this.io.mkdir(this.directory, { recursive: true });
      const snapshot = this.snapshot();
      this.pendingWriteSourceRevision = this.sourceRevision;
      // This snapshot is marked healthy only if its rename ultimately commits.
      snapshot.traceHealth.healthy = true;
      snapshot.traceHealth.lastErrorCode = null;
      snapshot.state.lastCheckpointAt = new Date(this.wall()).toISOString();
      snapshot.state.checkpointNumber = this.checkpointNumber;
      const raw = JSON.stringify(snapshot);
      if (Buffer.byteLength(raw) > this.maxBytes) throw Object.assign(Error('Trace size exceeded'), { code: 'TRACE_SIZE' });
      const temp = this.file + '.' + this.checkpointNumber + '.tmp';
      let handle;
      try {
        handle = await this.io.open(temp, 'wx', 0o600);
        await handle.writeFile(raw); await handle.sync();
        await handle.close(); handle = null;
        await this.replaceCheckpoint(temp);
      } finally {
        await handle?.close().catch(() => {});
        // Only this trace's own temporary checkpoint is eligible for cleanup.
        await this.io.rm(temp, { force: true }).catch(() => {});
      }
      this.lastCheckpointAt = snapshot.state.lastCheckpointAt;
      this.traceIo.healthy = true; this.traceIo.lastErrorCode = null;
      const writeMs = elapsed(this.now(), started);
      this.traceIo.lastWriteMs = writeMs;
      this.traceIo.maximumWriteMs = Math.max(this.traceIo.maximumWriteMs, writeMs);
      return true;
    } catch (error) {
      this.traceIo.healthy = false; this.traceIo.failedWrites++;
      this.reportDegraded(error?.code === 'TRACE_SIZE' ? 'TRACE_SIZE' : safeCode(error));
      return false;
    }
  }
  checkpoint() {
    if (this.pendingWrite) {
      this.traceIo.droppedCheckpoints++;
      return Promise.resolve(false); // Never wait for a stuck diagnostic writer.
    }
    this.pendingWriteSourceRevision = null;
    const work = Promise.resolve().then(() => this.persistCheckpoint()).catch(error => {
      this.traceIo.healthy = false; this.traceIo.failedWrites++;
      this.reportDegraded(safeCode(error));
      return false;
    });
    this.pendingWrite = work;
    // Completion remains observed even after the public timeout. A deferred
    // terminal checkpoint runs only AFTER this writer fully settles.
    void work.then(() => {
      if (this.pendingWrite === work) { this.pendingWrite = null; this.pendingWriteSourceRevision = null; }
      if (this.finalCheckpointRequested && !this.pendingWrite) {
        this.finalCheckpointRequested = false;
        this.traceIo.finalCheckpointDeferred = false;
        void this.checkpoint();
      }
    }, error => {
      if (this.pendingWrite === work) { this.pendingWrite = null; this.pendingWriteSourceRevision = null; }
      this.traceIo.healthy = false; this.reportDegraded(safeCode(error));
    }).catch(() => {});
    return settleWithin(work, this.checkpointTimeoutMs).then(result => {
      if (result.kind === 'timeout') {
        this.traceIo.checkpointTimeouts++;
        this.traceIo.healthy = false;
        this.reportDegraded('TRACE_CHECKPOINT_TIMEOUT');
        return false;
      }
      if (result.kind === 'rejected') {
        this.traceIo.healthy = false;
        this.reportDegraded(safeCode(result.error));
        return false;
      }
      return result.value === true;
    }).catch(error => {
      this.traceIo.healthy = false;
      this.reportDegraded(safeCode(error));
      return false;
    });
  }
  async finish(outcome = 'failed') {
    if (this.done) return this.snapshot();
    // Capture the terminal boundary once; subsequent late persistence must
    // serialize it unchanged rather than sampling a finished launch.
    this.captureProgressSample();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.outcome = ['ready', 'failed', 'interrupted'].includes(outcome) ? outcome : 'failed';
    this.done = true;
    if (this.delay) { try { this.delay.disable(); } catch {} }
    if (this.pendingWrite) {
      // A stuck sync/mkdir/rename must not block error reporting or shutdown.
      // If it eventually settles, the single writer publishes one terminal
      // checkpoint afterward; its late errors are already consumed.
      this.finalCheckpointRequested = true;
      this.traceIo.finalCheckpointDeferred = true;
      return this.snapshot();
    }
    await this.checkpoint(); // Bounded, including a never-settling fs.sync.
    return this.snapshot();
  }
}
