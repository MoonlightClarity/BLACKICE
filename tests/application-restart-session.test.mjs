import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApplicationWorkspace } from '../lib/application-workspace.mjs';
import { createDesktopRestartBarrier } from '../lib/desktop-restart-barrier.mjs';
import { DesktopRestartController } from '../desktop/restart.mjs';

const held = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const confirmedDiagnostics = () => ({ version: 1, closed: true, jobActiveProcesses: 0, allObservedProcessesExited: true, diagnosticsIncomplete: false, processListTruncated: false, windowsTruncated: false, processes: [{ pid: 42, role: 'launcher', state: 'exited', exitCode: 0 }] });
async function fixture(t, close = async () => ({})) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'blackice-force-private-'));
  const calls = [];
  const runtime = {
    async create() { return { id: 'owned-private', isolated: true, state: 'running', windows: [] }; },
    list() { return []; },
    async close(id) { calls.push(id); return close(id); },
    async closeAll() {},
  };
  const workspace = await new ApplicationWorkspace({ dataDir, runtime, platform: 'win32', catalog: [{ appId: 'editor', name: 'Editor', executable: 'C:\\editor.exe', available: true }] }).init();
  t.after(async () => { await workspace.close(); await rm(dataDir, { recursive: true, force: true }); });
  const opened = await workspace.create({ appId: 'editor' });
  return { workspace, calls, opened, file: path.join(dataDir, 'application-sessions.json') };
}

test('forced cleanup persists an interrupted receipt without claiming an unconfirmed process exit', async t => {
  const f = await fixture(t);
  const result = await f.workspace.endForRestart(f.opened.id);
  assert.deepEqual(f.calls, ['owned-private']); assert.equal(result.state, 'interrupted');
  assert.equal(result.restartCleanup.outcome, 'requested'); assert.match(result.reason, /exit was not confirmed/i);
  const saved = JSON.parse(await readFile(f.file, 'utf8')).sessions.find(value => value.id === result.id);
  assert.equal(saved.state, 'interrupted'); assert.equal(saved.restartCleanup.outcome, 'requested');
  assert.match(saved.reason, /exit was not confirmed/i);
});

test('forced cleanup distinguishes an explicitly confirmed owned-process exit', async t => {
  const f = await fixture(t, async () => ({ diagnostics: confirmedDiagnostics() }));
  const result = await f.workspace.endForRestart(f.opened.id);
  assert.equal(result.restartCleanup.outcome, 'confirmed'); assert.match(result.reason, /all observed application processes exited/i);
  assert.equal(result.diagnostics.jobActiveProcesses, 0);
});

test('old diagnostics cannot turn a new unconfirmed cleanup into a confirmed exit', async t => {
  const f = await fixture(t);
  f.workspace.records.find(value => value.id === f.opened.id).diagnostics = confirmedDiagnostics();
  const result = await f.workspace.endForRestart(f.opened.id);
  assert.equal(result.restartCleanup.outcome, 'requested');
  assert.match(result.reason, /exit was not confirmed/i);
});

test('cleanup intent is durable before dispatch and survives crash-style recovery without replay', async t => {
  const entered = held(), finish = held();
  const f = await fixture(t, async () => { entered.resolve(); await finish.promise; return {}; });
  t.after(() => finish.resolve());
  const effects = [];
  const pending = f.workspace.endForRestart(f.opened.id, { onEffect: effect => effects.push(effect) }); await entered.promise;
  const raw = await readFile(f.file, 'utf8'), saved = JSON.parse(raw).sessions.find(value => value.id === f.opened.id);
  assert.equal(saved.state, 'running'); assert.equal(saved.restartCleanup.outcome, 'uncertain');
  assert.deepEqual(effects, [{ sessionId: f.opened.id, outcome: 'uncertain' }]);
  const recoveredDir = await mkdtemp(path.join(os.tmpdir(), 'blackice-force-private-recovered-'));
  await writeFile(path.join(recoveredDir, 'application-sessions.json'), raw);
  let closes = 0;
  const replacement = await new ApplicationWorkspace({ dataDir: recoveredDir, runtime: { list: () => [], close: async () => { closes++; }, closeAll: async () => {} }, platform: 'win32', catalog: [] }).init();
  t.after(async () => { await replacement.close(); await rm(recoveredDir, { recursive: true, force: true }); });
  assert.equal(replacement.status().sessions[0].restartCleanup.outcome, 'uncertain');
  await assert.rejects(replacement.endForRestart(f.opened.id), { code: 'APPLICATION_RESTART_UNCERTAIN' });
  assert.equal(closes, 0); finish.resolve(); await pending;
  assert.deepEqual(effects.at(-1), { sessionId: f.opened.id, outcome: 'requested' });
});

test('a failed durable intent write prevents application cleanup dispatch', async t => {
  const f = await fixture(t), save = f.workspace.save.bind(f.workspace);
  f.workspace.save = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(f.workspace.endForRestart(f.opened.id), { code: 'APPLICATION_HISTORY_FAILED' });
  assert.deepEqual(f.calls, []);
  f.workspace.save = save;
});

test('an uncertain cleanup is saved and never automatically replayed', async t => {
  const f = await fixture(t, async () => { throw new Error('The helper response was lost'); });
  await assert.rejects(f.workspace.endForRestart(f.opened.id), { code: 'APPLICATION_RESTART_UNCERTAIN' });
  const saved = JSON.parse(await readFile(f.file, 'utf8')).sessions.find(value => value.id === f.opened.id);
  assert.equal(saved.state, 'needs_attention'); assert.equal(saved.restartCleanup.outcome, 'uncertain');
  await assert.rejects(f.workspace.endForRestart(f.opened.id), { code: 'APPLICATION_RESTART_UNCERTAIN' });
  assert.deepEqual(f.calls, ['owned-private']);
  const replacement = await new ApplicationWorkspace({ dataDir: path.dirname(f.file), runtime: { list: () => [], closeAll: async () => {} }, platform: 'win32', catalog: [] }).init();
  const restored = replacement.status().sessions.find(value => value.id === f.opened.id);
  assert.equal(restored.state, 'interrupted'); assert.equal(restored.restartCleanup.outcome, 'uncertain');
  await assert.rejects(replacement.endForRestart(f.opened.id), { code: 'APPLICATION_RESTART_UNCERTAIN' });
  await replacement.close();
});

test('a cancelled restart cannot close a session after its queued cleanup begins late', async t => {
  const f = await fixture(t), wait = held(), signal = new AbortController();
  f.workspace.tail = wait.promise;
  const pending = f.workspace.endForRestart(f.opened.id, { signal: signal.signal });
  signal.abort(); wait.resolve();
  await assert.rejects(pending, { code: 'APPLICATION_RESTART_CANCELLED' });
  assert.deepEqual(f.calls, []); assert.equal(f.workspace.status().sessions[0].state, 'running');
});

test('cancellation during an owned close still persists its actual returned outcome', async t => {
  const started = held(), finish = held(), signal = new AbortController();
  const f = await fixture(t, async () => { started.resolve(); await finish.promise; return {}; });
  const pending = f.workspace.endForRestart(f.opened.id, { signal: signal.signal });
  await started.promise; signal.abort(); finish.resolve();
  const result = await pending;
  assert.equal(result.state, 'interrupted'); assert.equal(result.restartCleanup.outcome, 'requested');
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).sessions.find(value => value.id === result.id).restartCleanup.outcome, 'requested');
});

test('a force timeout records an in-flight private cleanup as uncertain in the restart receipt', { timeout: 5000 }, async t => {
  const started = held(), finish = held();
  const f = await fixture(t, async () => { started.resolve(); await finish.promise; return {}; });
  t.after(() => finish.resolve());
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'blackice-force-private-timeout-'));
  t.after(() => rm(profileDir, { recursive: true, force: true }));
  let maintenance = false;
  const barrier = createDesktopRestartBarrier({
    timeoutMs: 300, isClosing: () => false, isMaintenance: () => maintenance,
    getEngineStatus: () => ({ activeCount: 0 }), getLearningActive: () => false,
    getApplicationSessions: () => f.workspace.status().sessions,
    getBrowserStatus: () => ({ busy: false, tabs: [], downloads: [], persistence: { healthy: true } }),
    getDirectJobs: async () => [], getPendingActions: () => false,
    setMaintenance: value => { maintenance = value; }, drain: async () => {},
    stopWork: ({ signal, onPrivateSessionStopped }) => f.workspace.endForRestart(f.opened.id, { signal, onEffect: onPrivateSessionStopped }),
  });
  const controller = new DesktopRestartController({
    profileDir, receiptTimeoutMs: 3000,
    getIdentity: () => ({ pid: 1234, startedAt: '2026-10-22T00:00:00.000Z', profileDir, mode: 'window' }),
    getLaunchOptions: () => ({ execPath: process.execPath, args: [], profileDir, mode: 'window' }),
    checkReady: context => barrier.assertReady(context), prepare: context => barrier.begin(context), release: () => barrier.end(),
    relaunch: () => assert.fail('A timed-out preparation must not relaunch.'), quit: () => assert.fail('A timed-out preparation must not quit.'),
  });
  const scheduled = await controller.request({ requestId: 'force-held-private', force: true });
  assert.equal(scheduled.status, 'scheduled'); await started.promise;
  const final = await controller.waitForHandoff();
  assert.equal(final.status, 'failed'); assert.equal(final.error.code, 'DESKTOP_RESTART_DRAIN_TIMEOUT');
  assert.deepEqual(final.forceEffects, { privateSessions: [{ sessionId: f.opened.id, outcome: 'uncertain' }] });
  finish.resolve(); await f.workspace.tail;
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).sessions.find(value => value.id === f.opened.id).restartCleanup.outcome, 'requested');
  assert.equal(controller.receipt({ ownerId: 'local', requestId: 'force-held-private' }).forceEffects.privateSessions[0].outcome, 'uncertain');
});
