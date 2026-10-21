import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopRestartController } from '../desktop/restart.mjs';

const finishedAt = '2026-10-21T04:00:01.000Z';
const succeeded = () => ({ status: 'succeeded', finishedAt });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, overrides = {}) {
  const profileDir = overrides.profileDir || await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-restart-'));
  if (!overrides.profileDir) t.after(() => fs.rm(profileDir, { recursive: true, force: true }));
  const events = [], origin = { pid: 1234, startedAt: '2026-10-21T04:00:00.000Z', profileDir, mode: 'headless' };
  const launch = { execPath: process.execPath, args: ['.', '--profile-dir', profileDir, '--headless'], profileDir, mode: 'headless' };
  const options = { profileDir, getIdentity: () => origin, getLaunchOptions: () => launch, checkReady: async ({ jobId }) => { events.push(['check', jobId]); }, prepare: async ({ jobId }) => { events.push(['prepare', jobId]); }, release: async () => { events.push(['release']); }, relaunch: value => { events.push(['relaunch', value]); }, quit: () => { events.push(['quit']); }, receiptTimeoutMs: 3000, pollMs: 5, ...overrides };
  const controller = new DesktopRestartController(options); await controller.init();
  return { controller, profileDir, origin, launch, events, options, file: path.join(profileDir, 'desktop-restart.json'), read: async () => JSON.parse(await fs.readFile(path.join(profileDir, 'desktop-restart.json'), 'utf8')) };
}

test('returns a durable scheduling receipt before arming, and waits for the originating durable success', async t => {
  const f = await fixture(t), receiptReady = deferred(); let polls = 0;
  const receipt = await f.controller.request({ requestId: 'restart-01', ownerId: 'grant-a', jobId: 'job-a', waitForReceipt: async () => { polls++; return receiptReady.promise; } });
  assert.equal(receipt.status, 'scheduled'); assert.equal(receipt.durable, true);
  assert.deepEqual(f.events, [['check', 'job-a']]);
  assert.equal((await f.read()).receipts[0].status, 'scheduled');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(polls, 1); assert.equal(f.events.some(([kind]) => kind === 'relaunch'), false);
  receiptReady.resolve(succeeded());
  const final = await f.controller.waitForHandoff();
  assert.equal(final.status, 'restarting');
  assert.deepEqual(f.events, [['check', 'job-a'], ['prepare', 'job-a'], ['relaunch', { execPath: f.launch.execPath, args: f.launch.args }], ['quit']]);
  assert.equal((await f.read()).receipts[0].status, 'restarting');
  assert.equal(Object.hasOwn(f.events[2][1], 'profileDir'), false);
});

test('concurrent duplicate request IDs coalesce and another owner cannot reuse them to see the receipt', async t => {
  const f = await fixture(t), result = deferred();
  const first = { requestId: 'same-request', ownerId: 'grant-a', jobId: 'job-a', waitForReceipt: () => result.promise };
  const [a, b] = await Promise.all([f.controller.request(first), f.controller.request(first)]);
  assert.equal(a.id, b.id); assert.equal(f.events.filter(([kind]) => kind === 'check').length, 1);
  await assert.rejects(f.controller.request({ requestId: 'same-request', ownerId: 'grant-b' }), { code: 'DESKTOP_RESTART_BUSY' });
  assert.equal(f.controller.status({ ownerId: 'grant-a' }).receipt.id, a.id);
  for (const status of [f.controller.status(), f.controller.status({ ownerId: 'grant-b' })]) {
    assert.equal(status.receipt, undefined); assert.equal(JSON.stringify(status).includes('grant-a'), false); assert.equal(JSON.stringify(status).includes('same-request'), false); assert.equal(JSON.stringify(status).includes('job-a'), false);
  }
  result.resolve(succeeded()); await f.controller.waitForHandoff();
  assert.equal((await f.controller.request(first)).status, 'restarting');
  assert.equal(f.events.filter(([kind]) => kind === 'relaunch').length, 1); assert.equal((await f.read()).receipts.length, 1);
});

test('a scheduling persistence failure leaves the app open and disables restart', async t => {
  const f = await fixture(t, { io: { rename: async () => { throw Object.assign(new Error('disk denied'), { code: 'EACCES' }); } } });
  await assert.rejects(f.controller.request({ requestId: 'disk-failure' }), { code: 'DESKTOP_RESTART_STORAGE_UNAVAILABLE' });
  assert.deepEqual(f.events, [['check', null]]); assert.equal(f.controller.status().available, false);
  assert.equal(f.controller.status().error.code, 'DESKTOP_RESTART_STORAGE_UNAVAILABLE');
  assert.deepEqual(await fs.readdir(f.profileDir), []);
});

test('failure to persist restarting releases the barrier and never arms relaunch', async t => {
  let renames = 0;
  const f = await fixture(t, { io: { rename: async (...args) => { if (++renames === 2) throw new Error('second write failed'); return fs.rename(...args); } } });
  await f.controller.request({ requestId: 'handoff-disk-failure' });
  const final = await f.controller.waitForHandoff();
  assert.equal(final.status, 'failed'); assert.equal(final.durable, false); assert.equal(final.error.code, 'DESKTOP_RESTART_STORAGE_UNAVAILABLE');
  assert.deepEqual(f.events, [['check', null], ['prepare', null], ['release']]);
  assert.equal((await f.read()).receipts[0].status, 'scheduled');
});

test('a relaunch arm failure releases the barrier without quitting and allows a new request ID', async t => {
  let attempts = 0; const events = [];
  const f = await fixture(t, { relaunch: () => { events.push('arm'); if (++attempts === 1) throw new Error('Electron could not arm'); }, quit: () => events.push('quit') });
  await f.controller.request({ requestId: 'arm-failure' }); const failed = await f.controller.waitForHandoff();
  assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, 'DESKTOP_RESTART_ARM_FAILED'); assert.deepEqual(events, ['arm']);
  assert.equal(f.events.filter(([kind]) => kind === 'release').length, 1);
  assert.equal((await f.controller.request({ requestId: 'arm-failure' })).status, 'failed'); assert.deepEqual(events, ['arm']);
  await f.controller.request({ requestId: 'arm-retry' }); assert.equal((await f.controller.waitForHandoff()).status, 'restarting'); assert.deepEqual(events, ['arm', 'arm', 'quit']);
});

test('failed, cancelled, and interrupted origin jobs never reach preparation', async t => {
  for (const status of ['failed', 'cancelled', 'interrupted']) {
    await t.test(status, async t => {
      const f = await fixture(t); await f.controller.request({ requestId: 'origin-' + status, ownerId: 'grant-a', jobId: 'job-a', waitForReceipt: () => ({ status, finishedAt }) });
      const receipt = await f.controller.waitForHandoff();
      assert.equal(receipt.status, status === 'cancelled' ? 'cancelled' : 'failed'); assert.equal(receipt.durable, true);
      assert.deepEqual(f.events, [['check', 'job-a']]); assert.equal((await f.read()).receipts[0].status, receipt.status);
    });
  }
});

test('a stuck origin callback, unfinished origin, and success without a durable finish all time out', async t => {
  for (const [label, waitForReceipt] of [['stuck', () => new Promise(() => {})], ['running', () => ({ status: 'running' })], ['unfinished-success', () => ({ status: 'succeeded' })]]) {
    await t.test(label, async t => {
      const f = await fixture(t, { receiptTimeoutMs: 25 }); await f.controller.request({ requestId: label, jobId: 'job-a', waitForReceipt });
      const receipt = await f.controller.waitForHandoff(); assert.equal(receipt.status, 'failed'); assert.equal(receipt.error.code, 'DESKTOP_RESTART_RECEIPT_TIMEOUT');
      assert.deepEqual(f.events, [['check', 'job-a']]);
    });
  }
});

test('origin lookup failures are recorded without leaking their error or preparing restart', async t => {
  const f = await fixture(t); await f.controller.request({ requestId: 'origin-error', jobId: 'job-a', waitForReceipt: () => { throw new Error('private receipt data'); } });
  const result = await f.controller.waitForHandoff(); assert.equal(result.error.code, 'DESKTOP_RESTART_RECEIPT_UNAVAILABLE'); assert.equal(JSON.stringify(result).includes('private receipt data'), false); assert.deepEqual(f.events, [['check', 'job-a']]);
});

test('aborting an unresolved origin receipt cancels promptly without quitting', async t => {
  const f = await fixture(t, { receiptTimeoutMs: 30000 }), abort = new AbortController(), waiting = deferred();
  await f.controller.request({ requestId: 'cancel-wait', jobId: 'job-a', signal: abort.signal, waitForReceipt: () => { waiting.resolve(); return new Promise(() => {}); } });
  await waiting.promise; abort.abort(); const result = await f.controller.waitForHandoff();
  assert.equal(result.status, 'cancelled'); assert.deepEqual(f.events, [['check', 'job-a']]);
});

test('cancellation during preparation releases the barrier and cannot arm relaunch', async t => {
  const started = deferred(), gate = deferred(), abort = new AbortController();
  const f = await fixture(t, { prepare: async () => { started.resolve(); await gate.promise; } });
  await f.controller.request({ requestId: 'cancel-prepare', signal: abort.signal }); await started.promise; abort.abort(); gate.resolve();
  assert.equal((await f.controller.waitForHandoff()).status, 'cancelled'); assert.deepEqual(f.events, [['check', null], ['release']]);
});

test('readiness rejection does not create a receipt, and preparation becoming busy releases the gate', async t => {
  const early = await fixture(t, { checkReady: () => false });
  await assert.rejects(early.controller.request({ requestId: 'initially-busy' }), { code: 'DESKTOP_RESTART_BUSY' }); assert.deepEqual(await fs.readdir(early.profileDir), []);
  const late = await fixture(t, { prepare: () => ({ ready: false }) }); await late.controller.request({ requestId: 'became-busy' });
  const result = await late.controller.waitForHandoff(); assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'DESKTOP_RESTART_BUSY'); assert.deepEqual(late.events, [['check', null], ['release']]);
});

test('release failure disables new requests instead of clearing an uncertain barrier', async t => {
  const f = await fixture(t, { prepare: () => { throw new Error('busy'); }, release: () => { throw new Error('cannot release'); } });
  await f.controller.request({ requestId: 'gate-failure' }); const result = await f.controller.waitForHandoff();
  assert.equal(result.error.code, 'DESKTOP_RESTART_RELEASE_FAILED'); assert.equal(f.controller.status().available, false);
  await assert.rejects(f.controller.request({ requestId: 'gate-retry' }), { code: 'DESKTOP_RESTART_RELEASE_FAILED' }); assert.deepEqual(f.events, [['check', null]]);
});

test('profile or mode changes in launch options fail before arming', async t => {
  for (const field of ['profileDir', 'mode']) {
    await t.test(field, async t => {
      const f = await fixture(t); f.launch[field] = field === 'mode' ? 'window' : path.join(f.profileDir, 'other-profile');
      await f.controller.request({ requestId: 'wrong-' + field }); const result = await f.controller.waitForHandoff();
      assert.equal(result.error.code, 'DESKTOP_RESTART_LAUNCH_INVALID'); assert.deepEqual(f.events, [['check', null], ['prepare', null], ['release']]);
    });
  }
});

test('new process confirmation completes only the same profile with a changed PID or start time', async t => {
  const f = await fixture(t); const receipt = await f.controller.request({ requestId: 'confirm-restart', ownerId: 'grant-a' }); await f.controller.waitForHandoff();
  const next = await fixture(t, { profileDir: f.profileDir });
  await next.controller.confirmStartup(f.origin); assert.equal(next.controller.status({ ownerId: 'grant-a' }).receipt.status, 'restarting');
  await next.controller.confirmStartup({ ...f.origin, pid: 5678, profileDir: path.join(f.profileDir, 'wrong') }); assert.equal(next.controller.status({ ownerId: 'grant-a' }).receipt.status, 'restarting');
  await next.controller.confirmStartup({ ...f.origin, startedAt: '2026-10-21T04:01:00.000Z' });
  const completed = next.controller.status({ ownerId: 'grant-a' }).receipt; assert.equal(completed.status, 'completed'); assert.equal(completed.id, receipt.id); assert.equal(completed.started.pid, f.origin.pid);
  assert.equal((await next.read()).receipts[0].status, 'completed'); assert.deepEqual(next.events, []);
  assert.equal((await next.controller.request({ requestId: 'confirm-restart', ownerId: 'grant-a' })).status, 'completed'); assert.deepEqual(next.events, []);
});

test('ordinary startup and an in-process restart request cannot opt schedulers into restart startup', async t => {
  const f = await fixture(t); assert.equal(f.controller.isRestartStartup(), false); assert.deepEqual(await fs.readdir(f.profileDir), []);
  await f.controller.request({ requestId: 'not-a-new-process' }); await f.controller.waitForHandoff();
  assert.equal(f.controller.isRestartStartup({ ...f.origin, pid: 5678 }), false);
});

test('restart startup recognition is read-only, requires preserved identity attributes, and ends at confirmation', async t => {
  const f = await fixture(t); await f.controller.request({ requestId: 'scheduler-resume' }); await f.controller.waitForHandoff();
  const current = { ...f.origin, pid: 5678 }, next = await fixture(t, { profileDir: f.profileDir, getIdentity: () => current });
  const before = await fs.readFile(next.file, 'utf8');
  assert.equal(next.controller.isRestartStartup(), true);
  assert.equal(next.controller.isRestartStartup(f.origin), false);
  assert.equal(next.controller.isRestartStartup({ ...current, profileDir: path.join(f.profileDir, 'other') }), false);
  assert.equal(next.controller.isRestartStartup({ ...current, mode: 'window' }), false);
  assert.equal(next.controller.isRestartStartup({ ...current, startedAt: 'invalid' }), false);
  assert.equal(await fs.readFile(next.file, 'utf8'), before); assert.equal(next.controller.status().status, 'restarting'); assert.deepEqual(next.events, []);
  await next.controller.confirmStartup(); assert.equal(next.controller.isRestartStartup(), false); assert.equal(next.controller.status().status, 'completed');
});

test('startup in a different desktop mode records an interruption and never replays or claims success', async t => {
  const f = await fixture(t); await f.controller.request({ requestId: 'preserve-headless', ownerId: 'grant-a' }); await f.controller.waitForHandoff();
  const next = await fixture(t, { profileDir: f.profileDir }); await next.controller.confirmStartup({ ...f.origin, pid: 5678, mode: 'window' });
  const receipt = next.controller.status({ ownerId: 'grant-a' }).receipt;
  assert.equal(receipt.status, 'interrupted'); assert.equal(receipt.error.code, 'DESKTOP_RESTART_MODE_CHANGED'); assert.equal(receipt.completedAt, undefined); assert.equal(receipt.started.mode, 'window');
  assert.equal((await next.read()).receipts[0].status, 'interrupted'); assert.equal((await next.controller.request({ requestId: 'preserve-headless', ownerId: 'grant-a' })).status, 'interrupted'); assert.deepEqual(next.events, []);
});

test('relaunch arguments cannot replay a restart or quit trigger', async t => {
  for (const argument of ['--restart', '--quit', '--restart=true', '--quit=true']) {
    await t.test(argument, async t => {
      const f = await fixture(t); f.launch.args.push(argument); await f.controller.request({ requestId: 'trigger-guard' });
      const receipt = await f.controller.waitForHandoff(); assert.equal(receipt.status, 'failed'); assert.equal(receipt.error.code, 'DESKTOP_RESTART_LAUNCH_INVALID'); assert.deepEqual(f.events, [['check', null], ['prepare', null], ['release']]);
    });
  }
});

test('a scheduled leftover is interrupted on startup and never replayed', async t => {
  const waiting = deferred(), f = await fixture(t); const scheduled = await f.controller.request({ requestId: 'leftover', ownerId: 'grant-a', jobId: 'job-a', waitForReceipt: () => waiting.promise });
  const saved = await f.read();
  waiting.resolve({ status: 'cancelled', finishedAt }); await f.controller.waitForHandoff();
  // Restore the exact durable snapshot a different process sees after a crash.
  await fs.writeFile(f.file, JSON.stringify(saved));
  const next = await fixture(t, { profileDir: f.profileDir }); assert.equal(next.controller.isRestartStartup({ ...f.origin, pid: 5678 }), false); await next.controller.confirmStartup({ ...f.origin, pid: 5678 });
  const interrupted = next.controller.status({ ownerId: 'grant-a' }).receipt; assert.equal(interrupted.id, scheduled.id); assert.equal(interrupted.status, 'interrupted');
  assert.equal((await next.controller.request({ requestId: 'leftover', ownerId: 'grant-a' })).status, 'interrupted'); assert.deepEqual(next.events, []);
  await next.controller.request({ requestId: 'fresh-after-interruption', ownerId: 'grant-a' }); assert.equal((await next.controller.waitForHandoff()).status, 'restarting');
});

test('a receipt cannot be replayed even after a later restart used a different request ID', async t => {
  const f = await fixture(t, { relaunch: () => { throw new Error('fail safely'); } });
  const first = await f.controller.request({ requestId: 'older-id', ownerId: 'grant-a' }); await f.controller.waitForHandoff();
  await f.controller.request({ requestId: 'later-id', ownerId: 'grant-a' }); await f.controller.waitForHandoff();
  const next = await fixture(t, { profileDir: f.profileDir }); await next.controller.confirmStartup();
  assert.equal((await next.controller.request({ requestId: 'older-id', ownerId: 'grant-a' })).id, first.id); assert.deepEqual(next.events, []); assert.equal((await next.read()).receipts.length, 2);
});

test('receipt history saturation rejects new identities without evicting old idempotency keys', async t => {
  const f = await fixture(t, { maxHistory: 2, relaunch: () => { throw new Error('fail safely'); } });
  await f.controller.request({ requestId: 'one' }); await f.controller.waitForHandoff(); await f.controller.request({ requestId: 'two' }); await f.controller.waitForHandoff();
  assert.equal(f.controller.status().error.code, 'DESKTOP_RESTART_HISTORY_FULL'); await assert.rejects(f.controller.request({ requestId: 'three' }), { code: 'DESKTOP_RESTART_HISTORY_FULL' });
  assert.equal((await f.controller.request({ requestId: 'one' })).status, 'failed'); assert.deepEqual((await f.read()).receipts.map(value => value.requestId), ['one', 'two']);
});

test('corrupt receipt storage disables restart but init and startup confirmation still open the app', async t => {
  const f = await fixture(t); await fs.writeFile(f.file, '{bad json');
  const next = await fixture(t, { profileDir: f.profileDir, getIdentity: () => { throw new Error('unavailable identity'); } });
  assert.equal(next.controller.status().available, false); assert.equal(next.controller.isRestartStartup(), false); await next.controller.confirmStartup();
  await assert.rejects(next.controller.request({ requestId: 'unsafe-storage' }), { code: 'DESKTOP_RESTART_STORAGE_UNAVAILABLE' }); assert.deepEqual(next.events, []); assert.equal(await fs.readFile(f.file, 'utf8'), '{bad json');
});

test('confirmation persistence failure does not claim completion or prevent startup', async t => {
  const f = await fixture(t); await f.controller.request({ requestId: 'confirm-write-failure', ownerId: 'grant-a' }); await f.controller.waitForHandoff();
  const next = await fixture(t, { profileDir: f.profileDir, io: { rename: async () => { throw new Error('read-only disk'); } } });
  await next.controller.confirmStartup({ ...f.origin, pid: 5678 });
  assert.equal(next.controller.status().available, false); assert.equal(next.controller.status({ ownerId: 'grant-a' }).receipt.status, 'restarting'); assert.equal((await next.read()).receipts[0].status, 'restarting'); assert.deepEqual(next.events, []);
});

test('a quit callback failure never arms twice or releases an armed restart gate', async t => {
  const f = await fixture(t, { quit: () => { throw new Error('quit failed'); } }); await f.controller.request({ requestId: 'quit-uncertain' });
  const result = await f.controller.waitForHandoff(); assert.equal(result.status, 'restarting'); assert.equal(result.error.code, 'DESKTOP_RESTART_QUIT_UNCONFIRMED'); assert.equal(result.durable, false);
  await f.controller.request({ requestId: 'quit-uncertain' }); await assert.rejects(f.controller.request({ requestId: 'do-not-arm-again' }), { code: 'DESKTOP_RESTART_BUSY' });
  assert.equal(f.events.filter(([kind]) => kind === 'relaunch').length, 1); assert.equal(f.events.some(([kind]) => kind === 'release'), false);
});
