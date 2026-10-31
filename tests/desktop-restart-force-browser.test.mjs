import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserWorkspace } from '../lib/browser.mjs';
import { createHarnessServer } from '../server.mjs';
import { DesktopRestartController } from '../desktop/restart.mjs';
import { ApplicationWorkspace } from '../lib/application-workspace.mjs';
import { createDesktopRestartBarrier } from '../lib/desktop-restart-barrier.mjs';

const held = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('forced native handoff cancels a busy browser and waits for its physical settlement', { timeout: 25000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blackice-force-browser-'));
  const profileDir = path.join(directory, 'profile'), workspace = path.join(directory, 'workspace');
  await mkdir(profileDir); await mkdir(workspace);
  const started = held(), interrupted = held(), finishPhysicalWork = held(), cleanupStarted = held(), finishCleanup = held();
  class Driver extends EventEmitter {
    status() { return { available: true, persistence: { healthy: true }, tabs: [], downloads: [] }; }
    async perform(_args, { signal }) {
      started.resolve();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      interrupted.resolve();
      await finishPhysicalWork.promise;
      throw Object.assign(new Error('Stopped after dispatch; inspect effects before retrying.'), { name: 'AbortError' });
    }
    async flushPersistence() {}
    async releaseOwner() { cleanupStarted.resolve(); await finishCleanup.promise; return { suspended: [], retained: [] }; }
    async stopForRestart({ onEffect }) {
      const effects = { browsers: { relay: { loads: [{ tabId: 'page', outcome: 'stopped' }], interactions: [], downloads: [{ id: 'download', tabId: 'page', outcome: 'cancelled' }] } } };
      onEffect(effects); return effects;
    }
    async close() {}
  }
  class Runtime extends EventEmitter {
  async runAgent() { assert.fail('This server fixture must not execute a model.'); }
    status() { return { connected: false, authenticated: false, activeTurns: 0, models: [] }; }
    async start() { return this.status(); }
    async close() {}
  }
  const browser = new BrowserWorkspace({ driver: new Driver() });
  const desktop = new EventEmitter(); desktop.status = () => ({ available: false, enabled: false }); desktop.setEnabled = async () => desktop.status();
  const native = []; let app;
  const controller = new DesktopRestartController({
    profileDir, pollMs: 2, receiptTimeoutMs: 10000,
    getIdentity: () => ({ pid: 1234, startedAt: '2026-10-22T00:00:00.000Z', profileDir, mode: 'window' }),
    getLaunchOptions: () => ({ execPath: process.execPath, args: [], profileDir, mode: 'window' }),
    checkReady: context => app.assertRestartReady(context),
    prepare: context => app.beginRestart(context), release: () => app.endRestart(),
    relaunch: () => { app.assertRestartPrepared(); native.push('relaunch'); },
    quit: () => native.push('quit'),
  });
  app = await createHarnessServer({ port: 0, runtime: new Runtime(), browser, desktop, desktopRestart: controller, dataDir: path.join(directory, 'data'), defaultCwd: workspace, autoAttachDesktop: false, remoteAccess: false, emailExecutableHint: null });
  t.after(async () => {
    finishPhysicalWork.resolve(); finishCleanup.resolve();
    if (controller.cancelPending()) await controller.waitForHandoff();
    app.endRestart(); await app.close(); await rm(directory, { recursive: true, force: true });
  });
  const work = browser.perform({ action: 'tabs' }, { source: 'user' });
  const workRejected = assert.rejects(work, { name: 'AbortError' });
  await started.promise;
  const cleanup = browser.releaseOwner({ taskId: 'task', runId: 'run', nodeId: 'node' });
  const scheduled = await controller.request({ requestId: 'force-busy-browser', force: true });
  assert.equal(scheduled.status, 'scheduled'); assert.equal(scheduled.force, true);
  await interrupted.promise; await workRejected;
  assert.equal(browser.status().busy, true); assert.deepEqual(native, []);
  finishPhysicalWork.resolve();
  await cleanupStarted.promise; assert.deepEqual(native, []);
  finishCleanup.resolve(); await cleanup;
  const final = await controller.waitForHandoff();
  assert.equal(final.status, 'restarting'); assert.deepEqual(native, ['relaunch', 'quit']);
  assert.deepEqual(final.forceEffects, { browser: { loads: { stopped: 1 }, downloads: { cancelled: 1 } } });
  assert.equal(browser.status().busy, false);
});

test('forced native handoff interrupts an owned private session and persists its cleanup receipt', { timeout: 25000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blackice-force-private-handoff-'));
  const profileDir = path.join(directory, 'profile'), workspace = path.join(directory, 'workspace'), dataDir = path.join(directory, 'data');
  await mkdir(profileDir); await mkdir(workspace); await mkdir(dataDir);
  const closed = [];
  const privateRuntime = {
    async create() { return { id: 'owned-private', isolated: true, state: 'running', windows: [] }; },
    list() { return []; }, async close(id) { closed.push(id); return {}; }, async closeAll() {},
  };
  const applications = await new ApplicationWorkspace({ dataDir, runtime: privateRuntime, platform: 'win32', catalog: [{ appId: 'editor', name: 'Editor', executable: 'C:\\editor.exe', available: true }] }).init();
  const session = await applications.create({ appId: 'editor' });
  class Runtime extends EventEmitter {
  async runAgent() { assert.fail('This server fixture must not execute a model.'); } status() { return { connected: false, authenticated: false, activeTurns: 0, models: [] }; } async start() {} async close() {} }
  const browser = new EventEmitter(); browser.status = () => ({ available: false, busy: false, lifecycle: 'ready', persistence: { healthy: true }, tabs: [], downloads: [] }); browser.cancel = () => {}; browser.close = async () => {};
  const desktop = new EventEmitter(); desktop.status = () => ({ available: false, enabled: false }); desktop.setEnabled = async () => desktop.status();
  const native = []; let app;
  const controller = new DesktopRestartController({
    profileDir, pollMs: 2, receiptTimeoutMs: 10000,
    getIdentity: () => ({ pid: 1234, startedAt: '2026-10-22T00:00:00.000Z', profileDir, mode: 'window' }),
    getLaunchOptions: () => ({ execPath: process.execPath, args: [], profileDir, mode: 'window' }),
    checkReady: context => app.assertRestartReady(context),
    prepare: context => app.beginRestart(context), release: () => app.endRestart(),
    relaunch: () => {
      app.assertRestartPrepared();
      const saved = JSON.parse(readFileSync(path.join(dataDir, 'application-sessions.json'), 'utf8')).sessions.find(value => value.id === session.id);
      assert.equal(saved.state, 'interrupted'); assert.equal(saved.restartCleanup.outcome, 'requested');
      const restartReceipt = JSON.parse(readFileSync(path.join(profileDir, 'desktop-restart.json'), 'utf8')).receipts.find(value => value.requestId === 'force-private');
      assert.deepEqual(restartReceipt.forceEffects, { privateSessions: [{ sessionId: session.id, outcome: 'requested' }] });
      assert.match(saved.reason, /exit was not confirmed/i); native.push('relaunch');
    },
    quit: () => native.push('quit'),
  });
  app = await createHarnessServer({ port: 0, runtime: new Runtime(), browser, desktop, desktopRestart: controller, applicationWorkspace: applications, dataDir, defaultCwd: workspace, autoAttachDesktop: false, remoteAccess: false, emailExecutableHint: null });
  t.after(async () => {
    if (controller.cancelPending()) await controller.waitForHandoff();
    app.endRestart(); await app.close(); await rm(directory, { recursive: true, force: true });
  });
  const ordinary = await controller.request({ requestId: 'ordinary-private' });
  assert.equal(ordinary.status, 'failed'); assert.deepEqual(closed, []);
  const scheduled = await controller.request({ requestId: 'force-private', force: true });
  assert.equal(scheduled.status, 'scheduled');
  const final = await controller.waitForHandoff();
  assert.equal(final.status, 'restarting'); assert.deepEqual(closed, ['owned-private']);
  assert.deepEqual(final.forceEffects, { privateSessions: [{ sessionId: session.id, outcome: 'requested' }] });
  assert.deepEqual(native, ['relaunch', 'quit']);
  const replacement = new DesktopRestartController({
    profileDir,
    getIdentity: () => ({ pid: 5678, startedAt: '2026-10-22T00:01:00.000Z', profileDir, mode: 'window' }),
    getLaunchOptions: () => ({ execPath: process.execPath, args: [], profileDir, mode: 'window' }),
    relaunch: () => {}, quit: () => {},
  });
  await replacement.init(); await replacement.confirmStartup();
  const completed = replacement.receipt({ ownerId: 'local', requestId: 'force-private' });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.forceEffects, { privateSessions: [{ sessionId: session.id, outcome: 'requested' }] });
});

test('failed forced handoff retains already interrupted private-session effects in its durable receipt', async t => {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'blackice-force-partial-'));
  t.after(() => rm(profileDir, { recursive: true, force: true }));
  let maintenance = false;
  const barrier = createDesktopRestartBarrier({
    isClosing: () => false, isMaintenance: () => maintenance,
    getEngineStatus: () => ({ activeCount: 0 }), getLearningActive: () => false,
    getApplicationSessions: () => [], getBrowserStatus: () => ({ busy: false, tabs: [], downloads: [], persistence: { healthy: true } }),
    getDirectJobs: async () => [], getPendingActions: () => false,
    setMaintenance: value => { maintenance = value; }, drain: async () => {},
    stopWork: async ({ onPrivateSessionStopped, onBrowserEffects }) => {
      onPrivateSessionStopped({ sessionId: 'app_partial', outcome: 'requested' });
      onBrowserEffects({ browsers: { relay: { loads: [{ tabId: 't1', outcome: 'stopped' }], interactions: [{ tabId: 't2', outcome: 'uncertain' }], downloads: [{ id: 'd1', outcome: 'cancelled' }] } } });
      throw new Error('Another owned operation could not stop.');
    },
  });
  const native = [];
  const controller = new DesktopRestartController({
    profileDir, getIdentity: () => ({ pid: 1234, startedAt: '2026-10-22T00:00:00.000Z', profileDir, mode: 'window' }),
    getLaunchOptions: () => ({ execPath: process.execPath, args: [], profileDir, mode: 'window' }),
    checkReady: context => barrier.assertReady(context), prepare: context => barrier.begin(context), release: () => barrier.end(),
    relaunch: () => native.push('relaunch'), quit: () => native.push('quit'),
  });
  const scheduled = await controller.request({ requestId: 'force-partial', force: true });
  assert.equal(scheduled.status, 'scheduled');
  const final = await controller.waitForHandoff();
  assert.equal(final.status, 'failed'); assert.deepEqual(native, []); assert.equal(maintenance, false);
  assert.deepEqual(final.forceEffects, { privateSessions: [{ sessionId: 'app_partial', outcome: 'requested' }], browser: { loads: { stopped: 1 }, interactions: { uncertain: 1 }, downloads: { cancelled: 1 } } });
  const saved = JSON.parse(readFileSync(path.join(profileDir, 'desktop-restart.json'), 'utf8')).receipts.find(value => value.requestId === 'force-partial');
  assert.deepEqual(saved.forceEffects, final.forceEffects);
  const replacement = new DesktopRestartController({ profileDir, getIdentity: () => ({ pid: 5678, startedAt: '2026-10-22T00:01:00.000Z', profileDir, mode: 'window' }), getLaunchOptions: () => ({ execPath: process.execPath, args: [], profileDir, mode: 'window' }), relaunch: () => {}, quit: () => {} });
  await replacement.init();
  assert.deepEqual(replacement.receipt({ ownerId: 'local', requestId: 'force-partial' }).forceEffects, final.forceEffects);
});

test('force effects remain visible when preparation succeeds but launch validation later fails', async t => {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'blackice-force-late-failure-'));
  t.after(() => rm(profileDir, { recursive: true, force: true }));
  const effects = { privateSessions: [{ sessionId: 'app_late', outcome: 'requested' }] };
  const controller = new DesktopRestartController({
    profileDir, getIdentity: () => ({ pid: 1234, startedAt: '2026-10-22T00:00:00.000Z', profileDir, mode: 'window' }),
    getLaunchOptions: () => ({ execPath: process.execPath, args: ['--background'], profileDir, mode: 'background' }),
    prepare: async () => ({ forceEffects: effects }), release: async () => {},
    relaunch: () => assert.fail('Invalid launch options must not relaunch.'), quit: () => assert.fail('Invalid launch options must not quit.'),
  });
  assert.equal((await controller.request({ requestId: 'force-late-failure', force: true })).status, 'scheduled');
  const final = await controller.waitForHandoff();
  assert.equal(final.status, 'failed'); assert.equal(final.error.code, 'DESKTOP_RESTART_LAUNCH_INVALID');
  assert.deepEqual(final.forceEffects, effects);
  const saved = JSON.parse(readFileSync(path.join(profileDir, 'desktop-restart.json'), 'utf8')).receipts.find(value => value.requestId === 'force-late-failure');
  assert.deepEqual(saved.forceEffects, effects);
});
