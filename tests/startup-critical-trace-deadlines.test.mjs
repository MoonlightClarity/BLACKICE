import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { StartupCriticalTrace } from '../lib/startup-critical-trace.mjs';

const codeFile = fileURLToPath(new URL('../lib/startup-critical-trace.mjs', import.meta.url));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function isolated(t) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'blackice-startup-diagnostic-deadlines-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function observedWithin(operation, limitMs = 600) {
  const t = performance.now();
  const value = await operation();
  const durationMs = performance.now() - t;
  assert.ok(durationMs < limitMs, 'diagnostic call exceeded non-gating budget: ' + durationMs);
  return value;
}
async function eventually(check, timeoutMs = 4000) {
  const until = performance.now() + timeoutMs;
  while (performance.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 8));
  }
  assert.fail('Late diagnostic completion did not settle in its expected bounded fixture');
}

test('desktop startup indicator and fatal-error reporting do not await diagnostic IO', async () => {
  const source = await fs.readFile(fileURLToPath(new URL('../desktop/main.mjs', import.meta.url)), 'utf8');
  assert.match(source, /void criticalStartupTrace\.start\(/);
  assert.match(source, /void criticalStartupTrace\.finish\('ready'\)/);
  assert.match(source, /void criticalStartupTrace\.finish\('failed'\)/);
  assert.doesNotMatch(source, /await criticalStartupTrace\.(start|finish)\(/);
});

test('finish before a held build resolves never creates or enables a late monitor, timer or new samples', async t => {
  const root = await isolated(t), held = deferred();
  const monitors = { created: 0, enabled: 0, disabled: 0 };
  const io = { ...fs, readFile: selected => selected === codeFile ? held.promise : fs.readFile(selected) };
  const trace = new StartupCriticalTrace({ dataDir: root, io, intervalMs: 250, startTimer: true,
    buildTimeoutMs: 25, checkpointTimeoutMs: 60,
    createDelayMonitor: () => {
      monitors.created++;
      return {
        enable() { monitors.enabled++; },
        disable() { monitors.disabled++; },
        get count() { return 0; }, get max() { return 0; },
        percentile: () => 0,
      };
    },
  });
  const starting = trace.start({ buildFiles: { code: codeFile } });
  const completed = await observedWithin(() => trace.finish('failed'));
  assert.equal(completed.state.outcome, 'failed');
  assert.equal(trace.done, true);
  const sampleCountAtFinish = trace.samples.length;
  assert.equal(sampleCountAtFinish, 1, 'finish must capture its terminal sample once');
  await observedWithin(() => starting);
  assert.equal(trace.source.status, 'timed_out');
  assert.deepEqual(monitors, { created: 0, enabled: 0, disabled: 0 });
  assert.equal(trace.delay, null);
  assert.equal(trace.timer, null);
  assert.equal(trace.samples.length, sampleCountAtFinish);
  const durable = await eventually(async () => {
    try {
      const value = JSON.parse(await fs.readFile(trace.file, 'utf8'));
      return value.state.outcome === 'failed' && value.launch.source.status === 'timed_out' ? value : null;
    } catch { return null; }
  });
  assert.equal(durable.progressSamples.length, sampleCountAtFinish);
  const checkpoints = trace.checkpointNumber;
  await new Promise(resolve => setTimeout(resolve, 300)); // Beyond the would-be timer interval.
  assert.equal(trace.timer, null);
  assert.equal(trace.checkpointNumber, checkpoints);
  assert.equal(trace.samples.length, sampleCountAtFinish);
  held.resolve(Buffer.from('late successful source must not re-enable diagnostics'));
  await eventually(() => trace.traceIo.lateBuildSettlements === 1);
  assert.equal(trace.source.status, 'timed_out');
  assert.deepEqual(monitors, { created: 0, enabled: 0, disabled: 0 });
});

test('a real event-loop delay monitor is disabled exactly once and does not resample after finish', async t => {
  const root = await isolated(t);
  const calls = { created: 0, enabled: 0, disabled: 0 };
  let histogram;
  const trace = new StartupCriticalTrace({ dataDir: root, intervalMs: 250, startTimer: true,
    createDelayMonitor: options => {
      calls.created++;
      histogram = monitorEventLoopDelay(options);
      return {
        enable() { calls.enabled++; return histogram.enable(); },
        disable() { calls.disabled++; return histogram.disable(); },
        get count() { return histogram.count; },
        get max() { return histogram.max; },
        percentile(p) { return histogram.percentile(p); },
      };
    },
  });
  await trace.start({ buildFiles: { code: codeFile } });
  assert.deepEqual(calls, { created: 1, enabled: 1, disabled: 0 });
  assert.ok(trace.timer);
  await observedWithin(() => trace.finish('ready'));
  assert.deepEqual(calls, { created: 1, enabled: 1, disabled: 1 });
  assert.equal(trace.done, true);
  assert.equal(trace.timer, null);
  const savedSamples = trace.samples.length;
  await trace.checkpoint();
  assert.equal(trace.samples.length, savedSamples, 'post-finish persistence cannot create samples');
  await trace.finish('ready');
  await trace.start({ buildFiles: { code: codeFile } });
  assert.deepEqual(calls, { created: 1, enabled: 1, disabled: 1 });
  const checkpoints = trace.checkpointNumber, delayCount = histogram.count;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(trace.timer, null);
  assert.equal(trace.checkpointNumber, checkpoints);
  assert.equal(trace.samples.length, savedSamples);
  assert.equal(histogram.count, delayCount, 'disabled real monitor cannot keep sampling');
});

test('desktop-style finish racing timed-out binding retains final state and degraded source evidence', async t => {
  const root = await isolated(t), held = deferred();
  let reads = 0;
  const io = { ...fs, readFile: selected => {
    if (selected === codeFile) { reads++; return held.promise; }
    return fs.readFile(selected);
  } };
  const trace = new StartupCriticalTrace({ dataDir: root, io, startTimer: false,
    buildTimeoutMs: 25, checkpointTimeoutMs: 60 });
  const starting = trace.start({ buildFiles: { code: codeFile } });
  const completed = await observedWithin(() => trace.finish('failed'));
  assert.equal(completed.state.outcome, 'failed');
  assert.equal(completed.state.incomplete, false);
  await observedWithin(() => starting);
  const persisted = await eventually(async () => {
    try {
      const data = JSON.parse(await fs.readFile(trace.file, 'utf8'));
      return data.launch.source.status === 'timed_out' && data.state.outcome === 'failed' ? data : null;
    } catch { return null; }
  });
  assert.equal(persisted.traceHealth.buildTimeouts, 1);
  assert.equal(persisted.state.incomplete, false);
  assert.equal(trace.done, true);
  assert.equal(reads, 1);
  held.resolve(Buffer.from('late source body never becomes a verified build'));
  await eventually(() => trace.traceIo.lateBuildSettlements === 1);
  assert.equal(trace.source.status, 'timed_out');
});

test('permanently unresolved build read cannot block start, error handling or initial incomplete checkpoint', async t => {
  const root = await isolated(t);
  let reads = 0;
  const io = { ...fs, readFile: selected => {
    if (selected === codeFile) { reads++; return new Promise(() => {}); }
    return fs.readFile(selected);
  } };
  const trace = new StartupCriticalTrace({ dataDir: root, io, startTimer: false,
    buildTimeoutMs: 25, checkpointTimeoutMs: 60 });
  assert.equal(await observedWithin(() => trace.start({ buildFiles: { code: codeFile, next: codeFile } })), false);
  assert.equal(reads, 1, 'do not start the next build read after the deadline');
  assert.equal(trace.source.status, 'timed_out');
  assert.equal(trace.traceIo.buildTimeouts, 1);
  assert.equal(trace.traceIo.degraded, true);
  const initial = JSON.parse(await fs.readFile(trace.file, 'utf8'));
  assert.equal(initial.state.outcome, 'incomplete');
  assert.equal(initial.launch.source.status, 'timed_out');
  assert.equal(initial.launch.source.errorCode, 'TRACE_BUILD_TIMEOUT');
  await observedWithin(() => trace.finish('failed'));
  const saved = JSON.parse(await fs.readFile(trace.file, 'utf8'));
  assert.equal(saved.state.outcome, 'failed');
  assert.equal(saved.traceHealth.buildTimeouts, 1);
  assert.equal(saved.traceHealth.degraded, true);
  assert.equal(trace.traceIo.lateBuildSettlements, 0);
});

test('late failed build binding is consumed and never overwrites the timed-out source identity', async t => {
  const root = await isolated(t), suspended = deferred();
  const io = { ...fs, readFile: selected => selected === codeFile ? suspended.promise : fs.readFile(selected) };
  const trace = new StartupCriticalTrace({ dataDir: root, io, startTimer: false,
    buildTimeoutMs: 25, checkpointTimeoutMs: 60 });
  assert.equal(await observedWithin(() => trace.start({ buildFiles: { code: codeFile } })), false);
  const initialSource = structuredClone(trace.source);
  // Node's test runner also detects unhandled rejections: a late rejection
  // must remain consumed even though start no longer waits on the worker.
  suspended.reject(Object.assign(new Error('private build path must not appear'), { code: 'EIO' }));
  await eventually(() => trace.traceIo.lateBuildSettlements === 1);
  assert.deepEqual(trace.source, initialSource);
  await observedWithin(() => trace.finish('failed'));
  const disk = JSON.parse(await fs.readFile(trace.file, 'utf8'));
  assert.equal(disk.launch.source.status, 'timed_out');
  assert.ok(!JSON.stringify(disk).includes('private build path'));
});

test('permanently unresolved checkpoint sync never gates startup or failure and cannot start another writer', async t => {
  const root = await isolated(t);
  let opened = 0, synchronized = 0, written = 0;
  const io = { ...fs, open: async (filename, mode, ...args) => {
    if (typeof filename === 'string' && filename.endsWith('.tmp') && mode === 'wx') {
      opened++;
      return { writeFile: async () => { written++; },
        sync: () => { synchronized++; return new Promise(() => {}); },
        close: async () => {} };
    }
    return fs.open(filename, mode, ...args);
  } };
  const trace = new StartupCriticalTrace({ dataDir: root, io, startTimer: false,
    buildTimeoutMs: 60, checkpointTimeoutMs: 25 });
  assert.equal(await observedWithin(() => trace.start({ buildFiles: { code: codeFile } })), false);
  assert.equal(trace.traceIo.checkpointTimeouts, 1);
  assert.equal(trace.traceIo.degraded, true);
  assert.equal(trace.traceIo.healthy, false);
  assert.equal(trace.traceIo.lastErrorCode, 'TRACE_CHECKPOINT_TIMEOUT');
  assert.ok(trace.pendingWrite, 'the underlying writer remains exclusively owned');
  assert.equal(await observedWithin(() => trace.checkpoint()), false);
  assert.equal(await observedWithin(() => trace.checkpoint()), false);
  assert.equal(opened, 1);
  assert.equal(synchronized, 1);
  assert.equal(written, 1);
  assert.equal(trace.traceIo.droppedCheckpoints, 2);
  const final = await observedWithin(() => trace.finish('failed'));
  assert.equal(final.state.outcome, 'failed');
  assert.equal(final.state.incomplete, false);
  assert.equal(trace.traceIo.finalCheckpointDeferred, true);
  assert.equal(opened, 1, 'finish must not overlap the pending writer');
  assert.equal((await fs.readdir(trace.directory)).filter(name => name.endsWith('.json')).length, 0);
  assert.equal(trace.publicStatus().traceHealth.checkpointTimeouts, 1);
});

test('late checkpoint sync success publishes a terminal checkpoint only after old writer fully closes', async t => {
  const root = await isolated(t), held = deferred();
  let opened = 0, active = 0, peak = 0, completed = 0;
  const io = { ...fs, open: async (filename, mode, ...args) => {
    const handle = await fs.open(filename, mode, ...args);
    if (typeof filename !== 'string' || !filename.endsWith('.tmp') || mode !== 'wx') return handle;
    const index = ++opened;
    active++; peak = Math.max(peak, active);
    return {
      writeFile: contents => handle.writeFile(contents),
      sync: () => index === 1 ? held.promise : handle.sync(),
      close: async () => {
        await handle.close(); active--; completed++;
      },
    };
  } };
  const trace = new StartupCriticalTrace({ dataDir: root, io, startTimer: false,
    buildTimeoutMs: 60, checkpointTimeoutMs: 25 });
  assert.equal(await observedWithin(() => trace.start({ buildFiles: { code: codeFile } })), false);
  assert.equal(opened, 1);
  const completedSnapshot = await observedWithin(() => trace.finish('failed'));
  assert.equal(completedSnapshot.state.outcome, 'failed');
  assert.equal(completedSnapshot.state.incomplete, false);
  assert.equal(opened, 1, 'finalization must not start a second writer before late sync');
  assert.equal(trace.traceIo.finalCheckpointDeferred, true);
  held.resolve();
  // Observe writer settlement, not its destination while rename may replace it.
  // Preserve one absolute four-second fixture budget across settlement and read.
  const deadline = performance.now() + 4000;
  const diagnostics = () => JSON.stringify({ opened, active, peak, completed,
    pendingWrite: Boolean(trace.pendingWrite), finalCheckpointRequested: trace.finalCheckpointRequested,
    traceIo: trace.traceIo });
  while (trace.pendingWrite || trace.finalCheckpointRequested) {
    assert.ok(performance.now() < deadline, 'Late diagnostic writer did not settle: ' + diagnostics());
    await new Promise(resolve => setTimeout(resolve, 8));
  }
  assert.equal(trace.traceIo.failedWrites, 0, diagnostics());
  const remaining = deadline - performance.now();
  assert.ok(remaining > 0, 'No fixture budget remains for terminal read: ' + diagnostics());
  const saved = JSON.parse(await fs.readFile(trace.file, { encoding: 'utf8',
    signal: AbortSignal.timeout(Math.max(1, Math.ceil(remaining))) }));
  assert.ok(performance.now() <= deadline, 'Terminal read exceeded fixture budget: ' + diagnostics());
  assert.equal(saved.state.outcome, 'failed');
  assert.equal(saved.state.incomplete, false);
  assert.equal(opened, 2);
  assert.equal(peak, 1);
  assert.equal(completed, 2);
  assert.equal(active, 0);
  assert.equal(saved.traceHealth.checkpointTimeouts, 1);
  assert.equal(saved.traceHealth.degraded, true);
  assert.equal(saved.traceHealth.finalCheckpointDeferred, false);
  assert.equal(trace.pendingWrite, null);
});

test('late checkpoint sync rejection is consumed and a single follow-up writer preserves failure evidence', async t => {
  const root = await isolated(t), held = deferred();
  let opened = 0, active = 0, peak = 0, completed = 0;
  const io = { ...fs, open: async (filename, mode, ...args) => {
    const handle = await fs.open(filename, mode, ...args);
    if (typeof filename !== 'string' || !filename.endsWith('.tmp') || mode !== 'wx') return handle;
    const index = ++opened;
    active++; peak = Math.max(peak, active);
    return {
      writeFile: contents => handle.writeFile(contents),
      sync: () => index === 1 ? held.promise : handle.sync(),
      close: async () => { await handle.close(); active--; completed++; },
    };
  } };
  const trace = new StartupCriticalTrace({ dataDir: root, io, startTimer: false,
    buildTimeoutMs: 60, checkpointTimeoutMs: 25 });
  await observedWithin(() => trace.start({ buildFiles: { code: codeFile } }));
  await observedWithin(() => trace.finish('failed'));
  held.reject(Object.assign(new Error('do not persist secret diagnostic error'), { code: 'EIO' }));
  const saved = await eventually(async () => {
    try {
      const data = JSON.parse(await fs.readFile(trace.file, 'utf8'));
      return data.state.outcome === 'failed' ? data : null;
    } catch { return null; }
  });
  assert.equal(opened, 2);
  assert.equal(peak, 1);
  assert.equal(completed, 2);
  assert.equal(active, 0);
  assert.equal(saved.traceHealth.failedWrites, 1);
  assert.equal(saved.traceHealth.checkpointTimeouts, 1);
  assert.equal(saved.traceHealth.degraded, true);
  assert.ok(!JSON.stringify(saved).includes('secret diagnostic error'));
});

test('sub-millisecond parse/hash/index costs accumulate precisely before one presentation rounding', async t => {
  const root = await isolated(t); let clock = 0;
  const trace = new StartupCriticalTrace({ dataDir: root, now: () => clock, startTimer: false });
  const count = 66848, sliceMs = 0.2;
  const kinds = ['parse', 'hash', 'index'];
  for (let index = 0; index < count; index++) {
    for (const kind of kinds) {
      const token = trace.beginOp(kind);
      clock += sliceMs;
      trace.endOp(token);
    }
  }
  const expected = count * sliceMs;
  for (const kind of kinds) {
    const metric = trace.opMetrics[kind];
    assert.equal(metric.completed, count);
    assert.ok(Math.abs(metric.cumulativeMs - expected) < 0.01, kind + ' lost fractional durations');
    assert.ok(metric.maxMs > 0 && metric.maxMs < 1);
    assert.equal(metric.histogram[0], count);
    assert.ok(Math.abs(trace.snapshot().operations[kind].cumulativeMs - expected) < 0.01);
  }
  assert.equal(trace.activeOps.size, 0);
  clock += 25.125;
  const token = trace.beginOp('read'); clock += 25.125; trace.endOp(token);
  const slow = trace.snapshot().slowOperations.find(value => value.kind === 'read');
  assert.ok(Math.abs(slow.durationMs - 25.125) < 0.001);
});


test('a real Windows checkpoint reader releases after sharing failure and the same terminal writer recovers', { skip: process.platform !== 'win32' }, async t => {
  const root = await isolated(t);
  let reader, attempts = 0, failures = 0, writes = 0;
  const io = { ...fs, open: async (...args) => { if (args[1] === 'wx') writes++; return fs.open(...args); },
    rename: async (...args) => {
      attempts++;
      try { return await fs.rename(...args); }
      catch (error) {
        failures++;
        assert.equal(error.code, 'EPERM');
        await reader.close(); reader = null;
        throw error;
      }
    } };
  const trace = new StartupCriticalTrace({ dataDir: root, io, startTimer: false });
  await trace.start({ buildFiles: { code: codeFile } });
  await eventually(() => !trace.pendingWrite);
  reader = await fs.open(trace.file, 'r');
  try {
    await observedWithin(() => trace.finish('ready'));
    await eventually(() => !trace.pendingWrite);
    assert.equal(failures, 1);
    assert.equal(attempts, 3);
    assert.equal(writes, 2, 'retry must retain the same terminal temp bytes');
    assert.equal(trace.traceIo.failedWrites, 0);
    assert.equal(trace.traceIo.renameRetries, 1);
    const terminal = JSON.parse(await fs.readFile(trace.file, 'utf8'));
    assert.equal(terminal.state.outcome, 'ready');
    assert.equal(terminal.state.incomplete, false);
    assert.equal(terminal.state.checkpointNumber, 2);
  } finally { await reader?.close(); }
});

test('persistent Windows reader bounds replacement failure, preserves old bytes, and allows explicit recovery', { skip: process.platform !== 'win32' }, async t => {
  const root = await isolated(t);
  const trace = new StartupCriticalTrace({ dataDir: root, startTimer: false, checkpointTimeoutMs: 25 });
  await trace.start({ buildFiles: { code: codeFile } });
  await eventually(() => !trace.pendingWrite);
  const original = await fs.readFile(trace.file, 'utf8');
  const reader = await fs.open(trace.file, 'r');
  try {
    await observedWithin(() => trace.finish('ready'));
    await eventually(() => !trace.pendingWrite, 1500);
    assert.equal(trace.traceIo.failedWrites, 1);
    assert.equal(trace.traceIo.lastErrorCode, 'EPERM');
    assert.ok(trace.traceIo.renameRetries > 0 && trace.traceIo.renameRetries <= 7);
    assert.equal(trace.traceIo.degraded, true);
    assert.equal(await fs.readFile(trace.file, 'utf8'), original);
  } finally { await reader.close(); }
  // The 25 ms deadline above deliberately tests rejection under a held
  // Windows reader. Recovery uses the normal bounded deadline so a busy
  // test worker's scheduler delay is not mistaken for another I/O failure.
  trace.checkpointTimeoutMs=500;
  // A 25 ms public diagnostic deadline is not a durability deadline. Under
  // parallel Windows IO the explicit recovery may time out publicly while its
  // sole writer is still syncing. Require a durable terminal recovery, not a
  // scheduler-dependent synchronous response within 25 ms.
  let retryCount = 0;
  await trace.checkpoint();
  const terminal = await eventually(async () => {
    if (trace.pendingWrite) return null;
    try {
      const saved = JSON.parse(await fs.readFile(trace.file, 'utf8'));
      if (saved.state.outcome === 'ready' && saved.state.incomplete === false && trace.traceIo.healthy) return saved;
    } catch {}
    assert.ok(['EPERM', 'TRACE_CHECKPOINT_TIMEOUT'].includes(trace.traceIo.lastErrorCode),
      'Only a bounded Windows sharing failure or diagnostic timeout permits recovery retry.');
    if (retryCount++ < 3) await trace.checkpoint();
    return null;
  }, 4000);
  assert.equal(terminal.state.outcome, 'ready');
  assert.equal(terminal.state.incomplete, false);
  assert.equal(terminal.traceHealth.failedWrites, 1, 'recovery preserves failure history');
  assert.equal(trace.traceIo.healthy, true);
});

test('non-sharing rename failure is not retried', async t => {
  const root = await isolated(t);
  let attempts = 0;
  const trace = new StartupCriticalTrace({ dataDir: root, startTimer: false,
    io: { ...fs, rename: async () => { attempts++; throw Object.assign(Error('fixture'), { code: 'ENOSPC' }); } } });
  await trace.start({ buildFiles: { code: codeFile } });
  await eventually(() => !trace.pendingWrite);
  assert.equal(attempts, 1);
  assert.equal(trace.traceIo.renameRetries, 0);
  assert.equal(trace.traceIo.failedWrites, 1);
  assert.equal(trace.traceIo.lastErrorCode, 'ENOSPC');
  await trace.finish('failed');
});

test('finish during Windows rename retry preserves one writer and one terminal followup', { skip: process.platform !== 'win32' }, async t => {
  const root = await isolated(t), entered = deferred(), release = deferred();
  let attempts = 0, opened = 0, active = 0, peak = 0;
  const io = { ...fs,
    open: async (...args) => { if (args[1] === 'wx') { opened++; active++; peak = Math.max(peak, active); } return fs.open(...args); },
    rename: async (...args) => {
      attempts++;
      if (attempts === 1) { entered.resolve(); await release.promise; throw Object.assign(Error('fixture'), { code: 'EBUSY' }); }
      const result = await fs.rename(...args); active--; return result;
    } };
  const trace = new StartupCriticalTrace({ dataDir: root, io, startTimer: false, checkpointTimeoutMs: 25 });
  const starting = trace.start({ buildFiles: { code: codeFile } });
  await entered.promise;
  await trace.finish('failed');
  assert.equal(opened, 1);
  assert.equal(trace.finalCheckpointRequested, true);
  release.resolve();
  await starting;
  await eventually(() => !trace.pendingWrite && !trace.finalCheckpointRequested);
  assert.equal(opened, 2); assert.equal(peak, 1); assert.equal(active, 0);
  assert.equal(attempts, 3); assert.equal(trace.traceIo.failedWrites, 0);
  const terminal = JSON.parse(await fs.readFile(trace.file, 'utf8'));
  assert.equal(terminal.state.outcome, 'failed');
  assert.equal(terminal.state.checkpointNumber, 2);
});

for (const status of ['verified-runtime-bytes', 'timed_out']) test('finish writer predating held build binding receives one source-fresh terminal refresh: ' + status, async t => {
  const root = await isolated(t), build = deferred(), sync = deferred(), entered = deferred();
  let opened = 0, active = 0, peak = 0;
  const io = { ...fs, readFile: (...args) => args[0] === codeFile ? build.promise : fs.readFile(...args),
    open: async (...args) => {
      const handle = await fs.open(...args);
      if (args[1] !== 'wx') return handle;
      const index = ++opened; active++; peak = Math.max(peak, active);
      return { writeFile: (...a) => handle.writeFile(...a),
        sync: async () => { if (index === 1) { entered.resolve(); await sync.promise; } return handle.sync(); },
        close: async () => { await handle.close(); active--; } };
    } };
  const trace = new StartupCriticalTrace({ dataDir: root, io, startTimer: false,
    buildTimeoutMs: 250, checkpointTimeoutMs: 25 });
  const starting = trace.start({ buildFiles: { code: codeFile } });
  const finishing = trace.finish('failed');
  await entered.promise;
  assert.equal(trace.source.status, 'binding');
  if (status === 'verified-runtime-bytes') build.resolve(Buffer.from('synthetic source now available'));
  await starting;
  assert.equal(trace.source.status, status);
  assert.equal(trace.finalCheckpointRequested, true);
  assert.equal(opened, 1);
  sync.resolve();
  await finishing;
  await eventually(() => !trace.pendingWrite && !trace.finalCheckpointRequested);
  const terminal = JSON.parse(await fs.readFile(trace.file, 'utf8'));
  assert.equal(terminal.state.outcome, 'failed');
  assert.equal(terminal.state.incomplete, false);
  assert.equal(terminal.launch.source.status, status);
  assert.equal(terminal.launch.source.fingerprint, trace.source.fingerprint);
  assert.equal(opened, 2); assert.equal(peak, 1); assert.equal(active, 0);
  assert.equal(trace.traceIo.failedWrites, 0);
});
