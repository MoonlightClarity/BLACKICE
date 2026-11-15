import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
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
  const saved = await eventually(async () => {
    try {
      const data = JSON.parse(await fs.readFile(trace.file, 'utf8'));
      return data.state.outcome === 'failed' && data.state.incomplete === false ? data : null;
    } catch { return null; }
  });
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
