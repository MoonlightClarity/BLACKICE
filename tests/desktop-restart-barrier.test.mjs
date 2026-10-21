import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopRestartBarrier } from '../lib/desktop-restart-barrier.mjs';

const held = () => { let resolve, reject; const promise = new Promise((done, failed) => { resolve = done; reject = failed; }); return { promise, resolve, reject }; };
function fixture(overrides = {}) {
  const state = { closing: false, maintenance: false, engine: { activeCount: 0 }, learning: false, sessions: [], jobs: [], pending: false, browser: { available: true, busy: false, lifecycle: 'ready', persistence: { healthy: true }, tabs: [], downloads: [] } };
  const gates = []; let drains = 0, jobReads = 0;
  const callbacks = {
    isClosing: () => state.closing,
    isMaintenance: () => state.maintenance,
    getEngineStatus: () => state.engine,
    getLearningActive: () => state.learning,
    getApplicationSessions: () => state.sessions,
    getBrowserStatus: () => state.browser,
    getDirectJobs: async () => { jobReads++; return state.jobs; },
    getPendingActions: () => state.pending,
    setMaintenance: value => { state.maintenance = value; gates.push(value); },
    drain: async () => { drains++; },
    ...overrides,
  };
  return { barrier: createDesktopRestartBarrier(callbacks), state, gates, callbacks, get drains() { return drains; }, get jobReads() { return jobReads; } };
}

test('readiness is read-only and completed jobs and inactive sessions do not prevent restart', async () => {
  const f = fixture();
  f.state.jobs = ['succeeded', 'failed', 'cancelled', 'interrupted'].map((status, index) => ({ id: `finished-${index}`, status }));
  f.state.sessions = [{ state: 'stopped' }, { state: 'closed' }];
  const before = structuredClone(f.state);
  await f.barrier.assertReady();
  assert.deepEqual(f.state, before); assert.deepEqual(f.gates, []); assert.equal(f.drains, 0); assert.equal(f.jobReads, 1);
});

test('retained personal and task pages do not prevent restart and are never changed by readiness', async () => {
  const f = fixture();
  f.state.browser.tabs = [
    ...Array.from({ length: 8 }, (_, index) => ({ tabId: `personal-${index}`, url: `https://saved${index}.example/`, suspended: true })),
    { tabId: 'task-root', owner: { taskId: 'research', nodeId: 'capture', runId: 'finished' }, suspended: false, loading: false },
    { tabId: 'task-child', parentTabId: 'task-root', owner: { taskId: 'research', nodeId: 'capture', runId: 'finished' }, suspended: true },
  ];
  f.state.browser.downloads = [{ status: 'completed' }, { status: 'cancelled' }, { status: 'interrupted' }];
  const before = structuredClone(f.state.browser);
  await f.barrier.assertReady(); await f.barrier.begin();
  assert.deepEqual(f.state.browser, before); assert.deepEqual(f.gates, [true]);
  f.barrier.end();
  f.state.browser = { available: false, busy: false, lifecycle: 'ready' };
  await f.barrier.assertReady();
});

test('active browser actions, recovery, page interactions and downloads refuse restart without closing or cancelling work', async () => {
  const cases = [
    { busy: true },
    { recovery: { required: true } },
    ...['recovering', 'disconnecting', 'closing'].map(lifecycle => ({ lifecycle })),
    { tabs: [{ tabId: 'loading', loading: true }] },
    { tabs: [{ tabId: 'dialog', pendingInteraction: { kind: 'javascript_dialog', status: 'pending' } }] },
    { tabs: [{ tabId: 'chooser', pendingInteraction: { kind: 'file_chooser', status: 'pending' } }] },
    { tabs: [{ tabId: 'challenge', pendingInteraction: { kind: 'http_auth', status: 'blocked' } }] },
    { tabs: [{ tabId: 'settling', interactionSettling: true }] },
    { downloads: [{ tabId: 'download', status: 'downloading' }] },
    { activeDownloads: 1, downloads: Array.from({ length: 20 }, () => ({ status: 'completed' })) },
    { browsers: { relay: { tabs: [{ pendingInteraction: { status: 'pending' } }] } } },
    { browsers: { firefox: { downloads: [{ status: 'downloading' }] } } },
  ];
  for (const blocked of cases) {
    const f = fixture(); Object.assign(f.state.browser, blocked); const before = structuredClone(f.state);
    await assert.rejects(f.barrier.assertReady(), { code: 'DESKTOP_RESTART_BROWSER_BUSY' });
    await assert.rejects(f.barrier.begin(), { code: 'DESKTOP_RESTART_BROWSER_BUSY' });
    assert.deepEqual(f.state, before); assert.deepEqual(f.gates, []); assert.equal(f.drains, 0);
  }
});

test('unsaved browser state and unavailable readiness evidence fail closed before taking the restart gate', async () => {
  for (const browser of [
    { available: true, persistence: { healthy: false } },
    { browsers: { relay: { persistence: { healthy: false } } } },
  ]) {
    const f = fixture(); f.state.browser = browser;
    await assert.rejects(f.barrier.begin(), { code: 'DESKTOP_RESTART_STORAGE' });
    assert.deepEqual(f.gates, []); assert.equal(f.drains, 0);
  }
  const f = fixture({ getBrowserStatus: () => undefined });
  await assert.rejects(f.barrier.begin(), { code: 'DESKTOP_RESTART_BROWSER_STATE' });
  assert.deepEqual(f.gates, []);
});

test('browser work that starts while the job ledger is being read prevents restart admission', async () => {
  const reading = held(), finishRead = held();
  const f = fixture({ getDirectJobs: async () => { reading.resolve(); await finishRead.promise; return []; } });
  const pending = f.barrier.begin();
  await reading.promise; f.state.browser.busy = true; finishRead.resolve();
  await assert.rejects(pending, { code: 'DESKTOP_RESTART_BROWSER_BUSY' });
  assert.equal(f.state.browser.busy, true); assert.deepEqual(f.gates, []); assert.equal(f.drains, 0);
});

test('late browser downloads and failed persistence release a drained gate and leave the app open', async () => {
  for (const change of [
    state => { state.browser.downloads.push({ tabId: 'page', status: 'downloading' }); },
    state => { state.browser.tabs.push({ tabId: 'page', interactionSettling: true }); },
    state => { state.browser.persistence.healthy = false; },
  ]) {
    const draining = held(), finishDrain = held();
    const f = fixture({ drain: async () => { draining.resolve(); await finishDrain.promise; } });
    const pending = f.barrier.begin();
    await draining.promise; change(f.state); const browser = structuredClone(f.state.browser); finishDrain.resolve();
    await assert.rejects(pending, error => ['DESKTOP_RESTART_BROWSER_BUSY', 'DESKTOP_RESTART_STORAGE'].includes(error.code));
    assert.deepEqual(f.state.browser, browser); assert.equal(f.state.maintenance, false); assert.deepEqual(f.gates, [true, false]);
  }
});

test('closing, maintenance, active work, private sessions, and pending sign-ins refuse restart without taking the gate', async () => {
  const busy = [
    state => { state.closing = true; },
    state => { state.maintenance = true; },
    state => { state.engine.activeCount = 1; },
    state => { state.learning = true; },
    ...['starting', 'running', 'needs_attention'].map(value => state => { state.sessions = [{ state: value }]; }),
    state => { state.pending = true; },
  ];
  for (const makeBusy of busy) {
    const f = fixture(); makeBusy(f.state); const before = structuredClone(f.state);
    await assert.rejects(f.barrier.assertReady(), error => error.code.startsWith('DESKTOP_RESTART_'));
    await assert.rejects(f.barrier.begin(), error => error.code.startsWith('DESKTOP_RESTART_'));
    f.barrier.end();
    assert.deepEqual(f.state, before); assert.deepEqual(f.gates, []); assert.equal(f.drains, 0);
  }
});

test('all nonterminal direct actions block restart regardless of owner or interaction state', async () => {
  for (const status of ['queued', 'running', 'cancelling', 'awaiting_input', 'awaiting_approval', 'unknown']) {
    const f = fixture();
    f.state.jobs = [{ id: 'another-job', ownerId: 'another-owner', status }];
    await assert.rejects(f.barrier.begin({ jobId: 'own-restart' }), { code: 'DESKTOP_RESTART_BUSY' });
    assert.deepEqual(f.gates, []); assert.equal(f.drains, 0);
  }
});

test('only the exact restart job is excluded; same-owner, prefix-matching, and missing IDs still block', async () => {
  const f = fixture();
  f.state.jobs = [{ id: 'own-restart', ownerId: 'owner', status: 'running' }];
  await f.barrier.assertReady({ jobId: 'own-restart' });
  for (const other of [
    { id: 'other-job', ownerId: 'owner', status: 'queued' },
    { id: 'own-restart-extra', ownerId: 'owner', status: 'running' },
    { status: 'running' },
  ]) {
    f.state.jobs.push(other);
    await assert.rejects(f.barrier.assertReady({ jobId: 'own-restart' }), { code: 'DESKTOP_RESTART_BUSY' });
    f.state.jobs.pop();
  }
  f.state.jobs = [{ status: 'running' }];
  await assert.rejects(f.barrier.assertReady(), { code: 'DESKTOP_RESTART_BUSY' });
  f.state.jobs = [{ jobId: 'own-restart', status: 'running' }];
  await f.barrier.assertReady({ jobId: 'own-restart' });
  assert.deepEqual(f.gates, []);
});

test('begin gates before draining, rechecks after drain, and holds the gate until an idempotent end', async () => {
  const draining = held(), releaseDrain = held();
  const f = fixture({ drain: async () => { assert.equal(f.state.maintenance, true); draining.resolve(); await releaseDrain.promise; } });
  f.state.jobs = [{ id: 'own-restart', status: 'running' }];
  const pending = f.barrier.begin({ jobId: 'own-restart' });
  await draining.promise;
  assert.deepEqual(f.gates, [true]); assert.equal(f.jobReads, 1);
  f.state.jobs[0].status = 'succeeded'; releaseDrain.resolve(); await pending;
  assert.equal(f.jobReads, 2); assert.equal(f.state.maintenance, true);
  f.barrier.end(); f.barrier.end();
  assert.deepEqual(f.gates, [true, false]); assert.equal(f.state.maintenance, false);
});

test('the final native handoff check is synchronous, requires its prepared gate, and catches late browser work', async () => {
  const draining = held(), finishDrain = held();
  const f = fixture({ drain: async () => { draining.resolve(); await finishDrain.promise; } });
  assert.throws(() => f.barrier.assertPrepared(), { code: 'DESKTOP_RESTART_NOT_PREPARED' });
  const pending = f.barrier.begin(); await draining.promise;
  assert.throws(() => f.barrier.assertPrepared(), { code: 'DESKTOP_RESTART_NOT_PREPARED' });
  finishDrain.resolve(); await pending;
  assert.equal(f.barrier.assertPrepared(), undefined);
  f.state.browser.activeDownloads = 1;
  assert.throws(() => f.barrier.assertPrepared(), { code: 'DESKTOP_RESTART_BROWSER_BUSY' });
  assert.equal(f.state.maintenance, true, 'Only the restart controller releases its gate.');
  f.state.browser.activeDownloads = 0; assert.equal(f.barrier.assertPrepared(), undefined);
  f.barrier.end(); assert.throws(() => f.barrier.assertPrepared(), { code: 'DESKTOP_RESTART_NOT_PREPARED' });
});

test('maintenance acquired while readiness reads jobs is never overwritten or released', async () => {
  const reading = held(), finishRead = held();
  const f = fixture({ getDirectJobs: async () => { reading.resolve(); await finishRead.promise; return []; } });
  const pending = f.barrier.begin();
  await reading.promise; f.state.maintenance = true; finishRead.resolve();
  await assert.rejects(pending, { code: 'DESKTOP_RESTART_BUSY' });
  f.barrier.end(); assert.equal(f.state.maintenance, true); assert.deepEqual(f.gates, []); assert.equal(f.drains, 0);
});

test('activity that starts while readiness reads jobs prevents acquiring the gate', async () => {
  const reading = held(), finishRead = held();
  const f = fixture({ getDirectJobs: async () => { reading.resolve(); await finishRead.promise; return []; } });
  const pending = f.barrier.begin();
  await reading.promise; f.state.engine.activeCount = 1; finishRead.resolve();
  await assert.rejects(pending, { code: 'DESKTOP_RESTART_BUSY' });
  assert.deepEqual(f.gates, []); assert.equal(f.drains, 0);
});

test('activity admitted before the gate is detected after drain and leaves the app open', async () => {
  const races = [
    state => { state.engine.activeCount = 1; },
    state => { state.learning = true; },
    state => { state.sessions = [{ state: 'needs_attention' }]; },
    state => { state.jobs.push({ id: 'late-job', ownerId: 'another-owner', status: 'queued' }); },
    state => { state.pending = true; },
    state => { state.closing = true; },
  ];
  for (const race of races) {
    const draining = held(), releaseDrain = held();
    const f = fixture({ drain: async () => { draining.resolve(); await releaseDrain.promise; } });
    const pending = f.barrier.begin({ jobId: 'own-restart' });
    await draining.promise; race(f.state); releaseDrain.resolve();
    await assert.rejects(pending, error => error.code.startsWith('DESKTOP_RESTART_'));
    assert.equal(f.state.maintenance, false); assert.deepEqual(f.gates, [true, false]);
  }
});

test('a failed drain releases the gate and permits a later deliberate retry', async () => {
  const failure = new Error('A pending write failed.'); let failDrain = true;
  const f = fixture({ drain: () => { if (failDrain) throw failure; } });
  await assert.rejects(f.barrier.begin(), error => error === failure);
  assert.equal(f.state.maintenance, false); assert.deepEqual(f.gates, [true, false]);
  failDrain = false; await f.barrier.begin();
  assert.equal(f.state.maintenance, true); f.barrier.end(); assert.deepEqual(f.gates, [true, false, true, false]);
});

test('drain timeout releases the gate and late failure cannot clear a newer restart gate', { timeout: 2000 }, async () => {
  const oldDrain = held(); let count = 0;
  const f = fixture({ timeoutMs: 20, drain: () => ++count === 1 ? oldDrain.promise : undefined });
  await assert.rejects(f.barrier.begin({ jobId: 'first' }), { code: 'DESKTOP_RESTART_DRAIN_TIMEOUT' });
  assert.equal(f.state.maintenance, false); assert.deepEqual(f.gates, [true, false]);
  await f.barrier.begin({ jobId: 'second' });
  oldDrain.reject(new Error('The timed-out write eventually failed.')); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.state.maintenance, true); assert.deepEqual(f.gates, [true, false, true]);
  f.barrier.end();
});

test('duplicate begin requests coalesce and a different restart cannot acquire or release their gate', async () => {
  const draining = held(), releaseDrain = held(); let drains = 0;
  const f = fixture({ drain: async () => { drains++; draining.resolve(); await releaseDrain.promise; } });
  const first = f.barrier.begin({ jobId: 'same' }), duplicate = f.barrier.begin({ jobId: 'same' });
  assert.equal(first, duplicate);
  await assert.rejects(f.barrier.begin({ jobId: 'different' }), { code: 'DESKTOP_RESTART_BUSY' });
  await draining.promise; assert.equal(drains, 1); assert.deepEqual(f.gates, [true]);
  releaseDrain.resolve(); await first;
  assert.equal(f.barrier.begin({ jobId: 'same' }), first);
  await assert.rejects(f.barrier.begin(), { code: 'DESKTOP_RESTART_BUSY' });
  assert.equal(f.state.maintenance, true); f.barrier.end();
});

test('another barrier cannot take or end a gate it does not own', async () => {
  const f = fixture(), other = createDesktopRestartBarrier(f.callbacks);
  await f.barrier.begin();
  await assert.rejects(other.begin(), { code: 'DESKTOP_RESTART_BUSY' });
  other.end(); assert.equal(f.state.maintenance, true); assert.deepEqual(f.gates, [true]);
  f.barrier.end(); await other.begin(); f.barrier.end();
  assert.equal(f.state.maintenance, true); other.end(); assert.deepEqual(f.gates, [true, false, true, false]);
});

test('ending during readiness cannot let an old begin acquire or clear a newer gate', async () => {
  const reading = held(), finishRead = held(); let reads = 0;
  const f = fixture({ getDirectJobs: async () => { if (++reads === 1) { reading.resolve(); await finishRead.promise; } return []; } });
  const first = f.barrier.begin({ jobId: 'first' });
  const rejected = assert.rejects(first, error => ['DESKTOP_RESTART_BUSY', 'DESKTOP_RESTART_RELEASED'].includes(error.code));
  await reading.promise; f.barrier.end(); await f.barrier.begin({ jobId: 'second' });
  finishRead.resolve(); await rejected;
  assert.equal(f.state.maintenance, true); assert.deepEqual(f.gates, [true]); f.barrier.end();
});

test('ending during drain releases only the old gate, even if a newer begin completes first', async () => {
  const draining = held(), releaseDrain = held(); let drains = 0;
  const f = fixture({ drain: async () => { if (++drains === 1) { draining.resolve(); await releaseDrain.promise; } } });
  const first = f.barrier.begin({ jobId: 'first' });
  const rejected = assert.rejects(first, { code: 'DESKTOP_RESTART_RELEASED' });
  await draining.promise; f.barrier.end(); await f.barrier.begin({ jobId: 'second' });
  releaseDrain.resolve(); await rejected;
  assert.equal(f.state.maintenance, true); assert.deepEqual(f.gates, [true, false, true]); f.barrier.end();
});

test('unreadable job storage refuses restart and a failed final read releases its gate', async () => {
  const failure = new Error('Job ledger unavailable.');
  for (const failRead of [1, 2]) {
    let reads = 0;
    const f = fixture({ getDirectJobs: async () => { if (++reads === failRead) throw failure; return []; } });
    await assert.rejects(f.barrier.begin(), error => error === failure);
    assert.equal(f.state.maintenance, false); assert.deepEqual(f.gates, failRead === 1 ? [] : [true, false]);
  }
});
