import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { StartupCriticalTrace } from '../lib/startup-critical-trace.mjs';
import { DiagnosticsStore } from '../lib/diagnostics.mjs';
import { DirectExecutionJobs } from '../lib/direct-execution-jobs.mjs';
import { startupPhase } from '../lib/startup-timing.mjs';

const code = relative => fileURLToPath(new URL(relative, import.meta.url));
const client = { id: 'synthetic-owner', label: 'offline fixture', kind: 'chatgpt', scopes: ['read', 'files:read'] };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const readTrace = async trace => JSON.parse(await fs.readFile(trace.file, 'utf8'));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'blackice-startup-critical-offline-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function completedJob(root, requestId = 'fixture') {
  const store = new DirectExecutionJobs({ dataDir: root });
  const job = (await store.admit({ ownerId: client.id, requestId, tool: 'blackice_workspace_read',
    arguments: { action: 'read', path: 'fixture.txt' }, client,
    requiredScopes: ['files:read'], mutating: false })).job;
  await store.update(job.id, () => ({ status: 'succeeded', finishedAt: new Date().toISOString(),
    result: { success: true, contentItems: [{ type: 'inputText', text: 'Café ☕' }] } }));
  await store.close();
  return job;
}

test('parented phases and source binding persist explicit incomplete launch evidence', async t => {
  const root = await fixture(t); let mono = 400;
  const trace = new StartupCriticalTrace({ dataDir: root, version: '2.39.98', now: () => mono,
    wall: () => 1800000000000 + mono, startTimer: false });
  await trace.start({ buildFiles: { code: code('../lib/startup-critical-trace.mjs') } });
  const initial = await readTrace(trace);
  assert.equal(initial.state.incomplete, true);
  assert.equal(initial.state.outcome, 'incomplete');
  assert.equal(initial.launch.version, '2.39.98');
  assert.equal(initial.launch.source.status, 'verified-runtime-bytes');
  const diagnostics = { startupTrace: trace, record: () => Promise.resolve() };
  await startupPhase(diagnostics, 'local-harness', async () => {
    mono += 4;
    await startupPhase(diagnostics, 'direct-jobs', async () => { mono += 17; });
    mono += 5;
  });
  const parent = trace.spans.find(v => v.name === 'local-harness');
  const child = trace.spans.find(v => v.name === 'direct-jobs');
  assert.equal(child.parentId, parent.id);
  assert.equal(parent.durationMs, 26);
  assert.equal(child.durationMs, 17);
  await trace.checkpoint();
  // Intentionally never finish: simulate a hard process exit after a checkpoint.
  const saved = await readTrace(trace);
  assert.equal(saved.state.incomplete, true);
  assert.equal(saved.spans.find(v => v.name === 'direct-jobs').outcome, 'ready');
  assert.equal(saved.launch.profilePathSha256.length, 64);
  assert.ok(!JSON.stringify(saved).includes(root));
});

test('held open and read reveal the exact in-flight wait without touching original receipts', async t => {
  const root = await fixture(t), job = await completedJob(root);
  const file = path.join(root, 'direct-execution-jobs', job.id + '.json'), original = await fs.readFile(file);
  let mono = 500;
  const trace = new StartupCriticalTrace({ dataDir: root, version: '2.39.98',
    now: () => mono, wall: () => 1800000000000 + mono, startTimer: false });
  await trace.start({ buildFiles: { code: code('../lib/direct-execution-jobs.mjs') } });
  const opened = deferred(), releaseOpen = deferred(), reading = deferred(), releaseRead = deferred();
  const io = { ...fs, open: async (filePath, mode, ...extra) => {
    if (filePath !== file) return fs.open(filePath, mode, ...extra);
    opened.resolve(); await releaseOpen.promise;
    const handle = await fs.open(filePath, mode, ...extra);
    return { readFile: async () => { reading.resolve(); await releaseRead.promise; return handle.readFile(); },
      close: () => handle.close() };
  } };
  const store = new DirectExecutionJobs({ dataDir: root, io, startupTrace: trace, onStartupDiagnostics: () => {} });
  t.after(() => store.close());
  const span = trace.begin('direct-jobs');
  const loading = trace.within(span, () => store.init());
  await opened.promise;
  mono += 470;
  await trace.checkpoint();
  const pendingOpen = await readTrace(trace);
  assert.equal(pendingOpen.ledger.required, 1);
  assert.equal(pendingOpen.ledger.dispatched, 1);
  assert.equal(pendingOpen.ledger.validated, 0);
  assert.equal(pendingOpen.ledger.pending[0].kind, 'open');
  assert.equal(pendingOpen.ledger.pending[0].elapsedMs, 470);
  assert.ok(pendingOpen.progressSamples.at(-1).pendingKinds.includes('open'));
  releaseOpen.resolve(); await reading.promise;
  mono += 620;
  await trace.checkpoint();
  const pendingRead = await readTrace(trace);
  assert.equal(pendingRead.ledger.pending[0].kind, 'read');
  assert.equal(pendingRead.operations.open.maxMs, 470);
  assert.ok(pendingRead.progressSamples.at(-1).pendingKinds.includes('read'));
  releaseRead.resolve(); await loading;
  trace.end(span, 'ready'); await trace.finish('ready'); await store.close();
  const ready = await readTrace(trace);
  assert.equal(ready.state.outcome, 'ready');
  assert.equal(ready.state.incomplete, false);
  assert.equal(ready.operations.open.completed, 1);
  assert.equal(ready.operations.read.maxMs, 620);
  for (const kind of ['stat', 'open', 'read', 'close', 'parse', 'validate', 'hash', 'index', 'enumerate'])
    assert.equal(ready.operations[kind].completed, 1, kind);
  assert.equal(ready.ledger.validated, 1);
  assert.equal(ready.ledger.bytes, original.length);
  assert.equal(ready.ledger.pendingTotal, 0);
  assert.ok(ready.progressSamples.some(item => item.pendingKinds.includes('open')));
  assert.ok(ready.progressSamples.some(item => item.pendingKinds.includes('read')));
  assert.equal(ready.slowOperations[0].kind, 'read');
  assert.equal(ready.slowOperations[1].kind, 'open');
  assert.deepEqual(await fs.readFile(file), original);
  assert.ok(!JSON.stringify(ready).includes(job.id));
  assert.ok(!JSON.stringify(ready).includes('Café'));
});

test('injected inaccessible receipt fails closed, preserves original bytes and records stat failure', async t => {
  const root = await fixture(t), job = await completedJob(root, 'stat-failure');
  const file = path.join(root, 'direct-execution-jobs', job.id + '.json'), original = await fs.readFile(file);
  const trace = new StartupCriticalTrace({ dataDir: root, version: '2.39.98', startTimer: false });
  await trace.start({ buildFiles: { code: code('../lib/direct-execution-jobs.mjs') } });
  const hit = deferred(), release = deferred();
  const io = { ...fs, lstat: async chosen => {
    if (chosen !== file) return fs.lstat(chosen);
    hit.resolve(); await release.promise;
    throw Object.assign(Error('Do not log a private receipt name'), { code: 'EACCES' });
  } };
  const store = new DirectExecutionJobs({ dataDir: root, io, startupTrace: trace, onStartupDiagnostics: () => {} });
  const span = trace.begin('direct-jobs');
  const waiting = trace.within(span, () => store.init());
  await hit.promise; await trace.checkpoint();
  assert.equal((await readTrace(trace)).ledger.pending[0].kind, 'stat');
  release.resolve(); await assert.rejects(waiting, { code: 'DIRECT_JOB_STORAGE' });
  trace.end(span, 'failed', { code: 'EACCES' }); await trace.finish('failed');
  const result = await readTrace(trace);
  assert.equal(result.state.outcome, 'failed');
  assert.equal(result.operations.stat.failed, 1);
  assert.equal(result.ledger.failed, 1);
  assert.equal(result.spans.find(v => v.name === 'direct-jobs').errorCode, 'EACCES');
  assert.equal(store.hasLease, false);
  assert.ok(!JSON.stringify(result).includes('Do not log'));
  assert.deepEqual(await fs.readFile(file), original);
  await store.close();
});



test('failed read waits for other in-flight reader to drain and closes both handles before releasing lease', async t => {
  const root = await fixture(t);
  const first = await completedJob(root, 'io-fault-a');
  const second = await completedJob(root, 'io-fault-b');
  const files = [first, second].map(job => path.join(root, 'direct-execution-jobs', job.id + '.json'));
  const before = await Promise.all(files.map(file => fs.readFile(file)));
  const trace = new StartupCriticalTrace({ dataDir: root, startTimer: false });
  await trace.start({ buildFiles: { code: code('../lib/direct-execution-jobs.mjs') } });
  const held = deferred(), release = deferred();
  const closed = new Set();
  const io = { ...fs, open: async (chosen, mode, ...extra) => {
    const handle = await fs.open(chosen, mode, ...extra);
    if (chosen === files[0]) return {
      readFile: async () => { throw Object.assign(Error('private payload'), { code: 'EIO' }); },
      close: async () => { closed.add(chosen); await handle.close(); },
    };
    if (chosen === files[1]) return {
      readFile: async () => { held.resolve(); await release.promise; return handle.readFile(); },
      close: async () => { closed.add(chosen); await handle.close(); },
    };
    return handle;
  } };
  const store = new DirectExecutionJobs({ dataDir: root, io, startupTrace: trace, onStartupDiagnostics: () => {} });
  const loading = store.init();
  await held.promise;
  await trace.checkpoint();
  assert.equal(store.hasLease, true);
  assert.equal(trace.opMetrics.read.failed, 1);
  assert.equal(trace.activeOps.size, 1);
  assert.ok(closed.has(files[0]));
  release.resolve();
  await assert.rejects(loading, { code: 'DIRECT_JOB_STORAGE' });
  await trace.finish('failed');
  assert.equal(store.hasLease, false);
  assert.equal(trace.activeOps.size, 0);
  assert.ok(files.every(file => closed.has(file)));
  assert.equal(store.records.size, 0, 'failed staged scan cannot publish partial index');
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file))), before);
  assert.equal((await readTrace(trace)).state.outcome, 'failed');
  await store.close();
});

test('four-minute-equivalent progress history is bounded and explicitly accounts for truncated samples', async t => {
  const root = await fixture(t); let mono = 0;
  const trace = new StartupCriticalTrace({ dataDir: root, version: '2.39.98',
    now: () => mono, wall: () => 1800000000000 + mono,
    intervalMs: 1500, startTimer: false });
  // checkpoint() deliberately returns at its diagnostic deadline, not
  // necessarily at disk settlement. This test advances a simulated sampling
  // clock, so drain the actual writer before scheduling its next sample.
  const drainWriter = async () => { while (trace.pendingWrite) await trace.pendingWrite; };
  await trace.start({ buildFiles: { code: code('../lib/startup-critical-trace.mjs') } });
  await drainWriter();
  const token = trace.begin('direct-jobs');
  for (let step = 0; step < 175; step++) {
    mono += 1500;
    trace.ledgerProgress({ required: 66848, dispatched: step * 20, validated: step * 20 });
    await trace.checkpoint(); await drainWriter();
  }
  trace.end(token, 'ready'); await trace.finish('ready'); await drainWriter();
  const saved = await readTrace(trace);
  assert.equal(saved.progressSamples.length, 160);
  assert.equal(saved.droppedSamples, 17);
  assert.equal(saved.state.outcome, 'ready');
  assert.ok(saved.progressSamples[0].atMs > 0);
  assert.equal(saved.progressSamples.at(-1).stage, 'idle');
  assert.equal(saved.progressSamples.at(-2).stage, 'direct-jobs');
  assert.ok((await fs.readFile(trace.file)).length <= 48 * 1024);
  assert.equal(saved.traceHealth.failedWrites, 0);
  assert.equal((await fs.readdir(trace.directory)).filter(n => n.endsWith('.json')).length, 1);
});

test('bounded telemetry uses no per-file disk writes and makes persistence failure visible', async t => {
  const root = await fixture(t); let writes = 0, failNext = false;
  const io = { ...fs, rename: async (...args) => {
    writes++; if (failNext) { failNext = false; throw Object.assign(Error('private text'), { code: 'EIO' }); }
    return fs.rename(...args);
  } };
  const trace = new StartupCriticalTrace({ dataDir: root, io, startTimer: false });
  await trace.start({ buildFiles: { code: code('../lib/startup-critical-trace.mjs') } });
  assert.equal(writes, 1);
  const started = performance.now();
  for (let i = 0; i < 20_000; i++) {
    const token = trace.beginOp('read'); trace.endOp(token, { bytes: 128 });
    if (i < 80) { const span = trace.begin('ledger-scan'); trace.end(span, 'ready'); }
  }
  const totalMs = performance.now() - started;
  assert.equal(writes, 1);
  assert.equal(trace.opMetrics.read.completed, 20_000);
  assert.ok(trace.truncatedSpans > 0);
  assert.ok(trace.slowest.length <= 12);
  assert.ok(totalMs < 30_000);
  await trace.checkpoint();
  const safe = await fs.readFile(trace.file);
  assert.ok(safe.length < 48 * 1024);
  failNext = true; await trace.checkpoint();
  assert.equal(trace.traceIo.healthy, false);
  assert.equal(trace.traceIo.failedWrites, 1);
  assert.equal(trace.traceIo.lastErrorCode, 'EIO');
  assert.deepEqual(await fs.readFile(trace.file), safe);
  await trace.finish('ready');
  const final = await readTrace(trace);
  assert.equal(final.state.outcome, 'ready');
  assert.equal(final.traceHealth.failedWrites, 1);
  assert.equal(final.traceHealth.healthy, true, 'a persisted final checkpoint proves this write succeeded');
  assert.equal(final.progressSamples.length, 4);
  const diagnostics = new DiagnosticsStore({ dataDir: root, version: '2.39.98' });
  diagnostics.startupTrace = trace;
  const support = await diagnostics.snapshot();
  assert.equal(support.startupCriticalTrace.launchId, trace.launchId);
  assert.equal(support.startupCriticalTrace.incomplete, false);
  assert.equal(support.startupCriticalTrace.traceHealth.failedWrites, 1);
  assert.ok(!JSON.stringify(support.startupCriticalTrace).includes(root));
  assert.ok(final.spans.length <= 64);
  assert.ok((await fs.readFile(trace.file)).length < 48 * 1024);
  t.diagnostic('20k in-memory operation observations ' + Math.round(totalMs) + ' ms; no per-receipt writes');
});

test('a timed-out checkpoint drops overlapping sample attempts until its writer really settles', async t => {
  const root = await fixture(t), entered = deferred(), release = deferred(); let hold = false, mono = 0;
  const io = { ...fs, rename: async (...args) => {
    if (hold) { entered.resolve(); await release.promise; }
    return fs.rename(...args);
  } };
  const trace = new StartupCriticalTrace({ dataDir: root, io, startTimer: false,
    now: () => mono, wall: () => 1800000000000 + mono, checkpointTimeoutMs: 10 });
  const drainWriter = async () => { while (trace.pendingWrite) await trace.pendingWrite; };
  await trace.start({ buildFiles: { code: code('../lib/startup-critical-trace.mjs') } }); await drainWriter();
  const token = trace.begin('direct-jobs'); hold = true;
  try {
    mono += 1500; const bounded = trace.checkpoint(); await entered.promise;
    assert.equal(await bounded, false, 'The public deadline must not wait for the held rename.');
    for (let attempt = 0; attempt < 3; attempt++) {
      mono += 1500; assert.equal(await trace.checkpoint(), false);
    }
    assert.equal(trace.traceIo.droppedCheckpoints, 3);
    assert.equal(trace.samples.length, 2, 'Overlapping requests do not pretend to have captured three more samples.');
    trace.end(token, 'ready'); await trace.finish('ready');
    assert.equal((await readTrace(trace)).state.incomplete, true, 'finish is bounded too; the previous durable checkpoint remains visible until settlement.');
  } finally { hold = false; release.resolve(); await drainWriter(); }
  const saved = await readTrace(trace);
  assert.equal(saved.state.outcome, 'ready'); assert.equal(saved.progressSamples.length, 3);
  assert.equal(saved.droppedSamples, 0); assert.equal(saved.traceHealth.droppedCheckpoints, 3);
  assert.ok(saved.traceHealth.checkpointTimeouts >= 1);
  assert.equal(saved.traceHealth.failedWrites, 0);
});
