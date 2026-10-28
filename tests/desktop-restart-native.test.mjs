import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessServer } from '../server.mjs';
import { DesktopRestartController } from '../desktop/restart.mjs';
import { DIRECT_EXECUTION_SCOPES } from '../lib/direct-execution-api.mjs';

const held = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const quote = text => process.platform === 'win32' ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\\''")}'`;
const nodeCommand = (script, args) => `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(script)} ${args.map(quote).join(' ')}`;
class Runtime extends EventEmitter {
  status() { return { connected: false, authenticated: false, activeTurns: 0, models: [] }; }
  async start() { return this.status(); }
  async close() {}
}

async function fixture(t, { holdPrepare = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-native-restart-'));
  const workspace = path.join(directory, 'workspace'), profileDir = path.join(directory, 'profile');
  await mkdir(workspace); await mkdir(profileDir);
  const client = { id: 'native-fixture-owner', label: 'Disposable restart fixture', scopes: [...DIRECT_EXECUTION_SCOPES] };
  const native = [], prepared = held(), releasePrepare = held(), childHeld = held(), releaseChild = held();
  let app, revoked = false;
  const controller = new DesktopRestartController({
    profileDir, pollMs: 2, receiptTimeoutMs: 10000,
    getIdentity: () => ({ pid: 1234, startedAt: '2026-10-22T00:00:00.000Z', profileDir, mode: 'background' }),
    checkReady: context => app.assertRestartReady(context),
    prepare: async context => {
      await app.beginRestart(context);
      if (context.jobId) {
        const origin = await app.directExecution.validateRestartOrigin(context.origin, { requireFinished: true });
        assert.equal(origin.jobId, context.jobId); assert.equal(origin.ownerId, context.ownerId);
      }
      prepared.resolve(); if (holdPrepare) await releasePrepare.promise;
    },
    release: () => app.endRestart(),
    getLaunchOptions: () => ({ execPath: process.execPath, args: ['--background'], profileDir, mode: 'background' }),
    relaunch: () => {
      app.assertRestartPrepared();
      const receipt = controller.receipts.at(-1);
      if (receipt.jobId) {
        const saved = JSON.parse(readFileSync(app.directExecution.jobs.file(receipt.jobId), 'utf8'));
        assert.equal(saved.status, 'succeeded'); assert.ok(Number.isFinite(Date.parse(saved.finishedAt)));
        assert.equal(saved.ownerId, receipt.ownerId);
        native.push({ action: 'relaunch', savedJob: saved.id, savedStatus: saved.status });
      } else native.push({ action: 'relaunch' });
      const ledger = JSON.parse(readFileSync(controller.file, 'utf8'));
      assert.equal(ledger.receipts.find(value => value.id === receipt.id).status, 'restarting');
    },
    quit: () => native.push({ action: 'quit' }),
  });
  const browser = new EventEmitter();
  browser.status = () => ({ available: false, contained: true, busy: false, lifecycle: 'ready', persistence: { healthy: true }, tabs: [], downloads: [] });
  browser.cancel = () => {}; browser.close = async () => {};
  const desktop = new EventEmitter(); desktop.status = () => ({ available: false, enabled: false }); desktop.setEnabled = async () => desktop.status();
  app = await createHarnessServer({ port: 0, runtime: new Runtime(), browser, desktop, desktopRestart: controller, dataDir: path.join(directory, 'data'), defaultCwd: workspace, autoAttachDesktop: false, remoteAccess: false, emailExecutableHint: null });
  t.after(async () => {
    releaseChild.resolve(); releasePrepare.resolve();
    if (controller.cancelPending()) await controller.waitForHandoff();
    app.endRestart(); await app.close(); await rm(directory, { recursive: true, force: true });
  });
  // No external grant or account is used. Exercise the real dispatch, origin,
  // HTTP management routes, ledger, barrier and controller with this test owner.
  app.directExecution.authorizeClient = async value => !revoked && value.id === client.id;
  app.chatGPTOAuth.revoke = async id => { assert.equal(id, client.id); revoked = true; app.chatGPTOAuth.emit('revoked', [id]); };
  const [handler] = app.server.listeners('request');
  app.server.removeListener('request', handler);
  app.server.on('request', (req, res) => {
    if (req.url === '/__fixture/hold-child') {
      childHeld.resolve(); void releaseChild.promise.then(() => res.end('released')); return;
    }
    void handler(req, res);
  });
  const origin = await app.listen(), opened = await fetch(origin);
  const cookie = opened.headers.get('set-cookie').split(';')[0]; await opened.arrayBuffer();
  const post = async (route, input = {}, headers = {}) => {
    const response = await fetch(origin + route, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) });
    return { status: response.status, value: await response.json() };
  };
  const script = path.join(workspace, 'restart-child.mjs');
  await writeFile(script, `import { runDesktopRestartCLI } from ${JSON.stringify(new URL('../lib/desktop-restart-cli.mjs', import.meta.url).href)};
const [origin, requestId, mode] = process.argv.slice(2);
const opened = await fetch(origin), cookie = opened.headers.get('set-cookie').split(';')[0]; await opened.arrayBuffer();
const exitCode = await runDesktopRestartCLI(['--restart', '--request-id=' + requestId, ...(mode.startsWith('force') ? ['--force'] : [])], {
  connect: async () => ({ runtime: { pid: 1234, startedAt: '2026-10-22T00:00:00.000Z' },
    request: async (route, input) => {
      const response = await fetch(origin + route, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(input) });
      const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.error), { code: value.code, status: response.status }); return value;
    }
  })
});
if (mode.includes('hold') && exitCode === 0) await (await fetch(origin + '/__fixture/hold-child')).text();
process.exitCode = mode.includes('fail') && exitCode === 0 ? 7 : exitCode;
`);
  const run = (requestId, mode = 'normal') => app.directExecution.call('blackice_run_command', { requestId: 'command-' + requestId, command: nodeCommand(script, [origin, requestId, mode]), timeoutMs: 20000 }, client);
  const waitJob = async id => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const value = await app.directExecution.jobs.get(id);
      if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(value.status)) return value;
      await delay(5);
    }
    assert.fail('The disposable originating command did not settle.');
  };
  return { app, controller, directory, client, native, prepared, releasePrepare, childHeld, releaseChild, post, run, waitJob };
}

test('a synchronous child receives its saved ACK, then durable command success precedes native relaunch and quit', { timeout: 25000 }, async t => {
  const f = await fixture(t), requestId = 'native-owned-success';
  const admitted = await f.run(requestId, 'hold'); await f.childHeld.promise;
  assert.equal((await f.app.directExecution.jobs.get(admitted.jobId)).status, 'running');
  const scheduled = f.controller.receipt({ ownerId: f.client.id, requestId });
  assert.equal(scheduled.status, 'scheduled'); assert.equal(scheduled.jobId, admitted.jobId); assert.equal(scheduled.durable, true);
  assert.deepEqual(f.native, []);
  const saved = JSON.parse(await readFile(f.controller.file, 'utf8'));
  assert.equal(saved.receipts.find(value => value.id === scheduled.id).status, 'scheduled');
  f.releaseChild.resolve(); assert.equal((await f.waitJob(admitted.jobId)).status, 'succeeded');
  const result = await f.controller.waitForHandoff(); assert.equal(result.status, 'restarting');
  assert.deepEqual(f.native, [{ action: 'relaunch', savedJob: admitted.jobId, savedStatus: 'succeeded' }, { action: 'quit' }]);
  const same = await f.controller.request({ requestId, ownerId: f.client.id });
  assert.equal(same.id, scheduled.id); assert.equal(f.native.length, 2);
  assert.equal(f.app.directExecution.restartOrigins.tokens.size, 0);
});

test('an acknowledged native restart cannot outlive its failed originating shell command', { timeout: 25000 }, async t => {
  const f = await fixture(t), admitted = await f.run('native-origin-failed', 'fail');
  assert.equal((await f.waitJob(admitted.jobId)).status, 'failed');
  const result = await f.controller.waitForHandoff();
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'DESKTOP_RESTART_ORIGIN_FAILED');
  assert.deepEqual(f.native, []); assert.equal(f.controller.isPending(), false);
});

test('cancelling the exact running origin after its ACK cancels native restart without releasing another job', { timeout: 25000 }, async t => {
  const f = await fixture(t), admitted = await f.run('native-origin-cancelled', 'hold'); await f.childHeld.promise;
  assert.equal(f.controller.cancelPending({ ownerId: 'different-owner', jobId: admitted.jobId }), false);
  await f.app.directExecution.cancel(admitted.jobId, { ownerId: f.client.id });
  f.releaseChild.resolve(); assert.equal((await f.waitJob(admitted.jobId)).status, 'cancelled');
  assert.equal((await f.controller.waitForHandoff()).status, 'cancelled'); assert.deepEqual(f.native, []);
});

for (const sameOwner of [true, false]) test(`an unrelated ${sameOwner ? 'same-owner' : 'other-owner'} awaiting-input receipt blocks native restart`, { timeout: 25000 }, async t => {
  const f = await fixture(t), owner = sameOwner ? f.client : { ...f.client, id: 'other-fixture-owner' };
  const pending = await f.app.directExecution.jobs.admit({ ownerId: owner.id, requestId: 'unresolved-chooser', tool: 'blackice_browser_action', arguments: { action: 'click', tabId: 'fixture', ref: 'button' }, requiredScopes: ['browser:write'], client: owner, mutating: true, interaction: { id: 'fixture-chooser', kind: 'file_chooser', createdAt: new Date().toISOString() } });
  const admitted = await f.run('blocked-by-pending-' + sameOwner);
  assert.equal((await f.waitJob(admitted.jobId)).status, 'failed');
  const receipt = f.controller.receipt({ ownerId: f.client.id, requestId: 'blocked-by-pending-' + sameOwner });
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.error.code, 'DESKTOP_RESTART_BUSY'); assert.equal(receipt.durable, true);
  assert.equal(receipt.error.blocker, 'direct_actions'); assert.match(receipt.error.message, /waiting for input/);
  const original = await f.app.directExecution.jobs.get(pending.job.id);
  assert.equal(original.status, 'awaiting_input'); assert.equal(original.revision, pending.job.revision);
  assert.deepEqual(f.native, []);
});

test('force waits for the originating command success before cancelling a saved other-owner chooser', { timeout: 25000 }, async t => {
  const f = await fixture(t), owner = { ...f.client, id: 'older-fixture-grant' };
  const pending = await f.app.directExecution.jobs.admit({ ownerId: owner.id, requestId: 'old-chooser', tool: 'blackice_browser_action', arguments: { action: 'click', tabId: 'fixture', ref: 'button' }, requiredScopes: ['browser:write'], client: owner, mutating: true, interaction: { id: 'old-file-chooser', kind: 'file_chooser', createdAt: new Date().toISOString() } });
  const admitted = await f.run('force-owned-success', 'force-hold'); await f.childHeld.promise;
  const scheduled = f.controller.receipt({ ownerId: f.client.id, requestId: 'force-owned-success' });
  assert.equal(scheduled.status, 'scheduled'); assert.equal(scheduled.force, true);
  assert.equal((await f.app.directExecution.jobs.get(pending.job.id)).status, 'awaiting_input');
  assert.deepEqual(f.native, []); assert.equal(Boolean(f.app.engine.maintenanceRequested), false);
  f.releaseChild.resolve(); assert.equal((await f.waitJob(admitted.jobId)).status, 'succeeded');
  const receipt = await f.controller.waitForHandoff(); assert.equal(receipt.status, 'restarting'); assert.equal(receipt.force, true);
  const cancelled = await f.app.directExecution.jobs.get(pending.job.id);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.interaction, null); assert.ok(cancelled.finishedAt);
  assert.equal(cancelled.ownerId, owner.id); assert.ok(cancelled.revision > pending.job.revision);
  assert.equal(f.app.inbox.status().paused, true); assert.equal(f.app.operations.status().paused, true);
  assert.deepEqual(f.native, [{ action: 'relaunch', savedJob: admitted.jobId, savedStatus: 'succeeded' }, { action: 'quit' }]);
});

test('force stops and settles a real owned command before the graceful native handoff', { timeout: 25000 }, async t => {
  const f = await fixture(t), script = path.join(f.directory, 'waiting-owned-command.mjs'), marker = path.join(f.directory, 'command-started');
  await writeFile(script, `import { writeFile } from 'node:fs/promises'; await writeFile(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000);`);
  const admitted = await f.app.directExecution.call('blackice_run_command', { requestId: 'force-stops-command', command: nodeCommand(script, []), timeoutMs: 20000 }, f.client);
  const deadline = Date.now() + 10000;
  while (true) {
    try { await readFile(marker); break; } catch (error) { if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error; await delay(5); }
  }
  assert.equal((await f.app.directExecution.jobs.get(admitted.jobId)).status, 'running');
  const response = await f.post('/api/desktop/restart', { requestId: 'force-local-stop', force: true });
  assert.equal(response.status, 200); assert.equal(response.value.receipt.force, true);
  const final = await f.controller.waitForHandoff(); assert.equal(final.status, 'restarting');
  assert.equal((await f.app.directExecution.jobs.get(admitted.jobId)).status, 'cancelled');
  assert.equal(f.app.directExecution.active.size, 0);
  assert.deepEqual(f.native, [{ action: 'relaunch' }, { action: 'quit' }]);
});

test('the direct force tool stops an active command only after its own receipt is durable', { timeout: 25000 }, async t => {
  const f = await fixture(t), script = path.join(f.directory, 'direct-force-owned-command.mjs'), marker = path.join(f.directory, 'direct-force-command-started');
  await writeFile(script, `import { writeFile } from 'node:fs/promises'; await writeFile(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000);`);
  const running = await f.app.directExecution.call('blackice_run_command', { requestId: 'direct-force-active-command', command: nodeCommand(script, []), timeoutMs: 20000 }, f.client);
  const deadline = Date.now() + 10000;
  while (true) {
    try { await readFile(marker); break; } catch (error) { if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error; await delay(5); }
  }
  const restart = await f.app.directExecution.call('blackice_restart', { requestId: 'direct-force-native', force: true }, f.client);
  assert.equal((await f.waitJob(restart.jobId)).status, 'succeeded');
  const receipt = await f.controller.waitForHandoff();
  assert.equal(receipt.status, 'restarting'); assert.equal(receipt.force, true); assert.equal(receipt.jobId, restart.jobId);
  assert.equal((await f.app.directExecution.jobs.get(running.jobId)).status, 'cancelled');
  assert.deepEqual(f.native, [{ action: 'relaunch', savedJob: restart.jobId, savedStatus: 'succeeded' }, { action: 'quit' }]);
});

for (const action of ['cancel-action', 'stop-all', 'revoke']) test(`local ${action} reaches a held pre-arm restart after durable origin success`, { timeout: 25000 }, async t => {
  const f = await fixture(t, { holdPrepare: true }), admitted = await f.run('pre-arm-' + action);
  await f.prepared.promise;
  assert.equal((await f.waitJob(admitted.jobId)).status, 'succeeded');
  assert.equal(f.app.engine.maintenanceRequested, true); assert.equal(f.controller.isPending(), true);
  assert.equal((await f.post('/api/runs', { task: 'Must not start during restart' })).status, 503);
  const response = action === 'stop-all' ? await f.post('/api/runs/stop-all') : await f.post('/api/chatgpt-connector/' + action, { id: action === 'revoke' ? f.client.id : admitted.jobId });
  assert.equal(response.status, 200, JSON.stringify(response.value));
  const receipt = await f.controller.waitForHandoff();
  assert.equal(receipt.status, 'cancelled'); assert.equal(receipt.error.code, 'DESKTOP_RESTART_CANCELLED');
  assert.equal(f.app.engine.maintenanceRequested, false); assert.deepEqual(f.native, []);
  assert.equal((await f.app.directExecution.jobs.get(admitted.jobId)).status, 'succeeded', 'Cancellation preserves the completed origin receipt.');
  f.releasePrepare.resolve();
});

test('native HTTP refuses invented origins, owner/job overrides and remote management forwarding', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const forged = await f.post('/api/desktop/restart', { requestId: 'invented-origin', originToken: 'a'.repeat(64) });
  assert.equal(forged.value.code, 'DESKTOP_RESTART_ORIGIN_INVALID'); assert.equal(forged.status, 409);
  for (const fields of [{ jobId: 'direct_fake' }, { ownerId: f.client.id }, { force: 'true' }, { force: null }]) {
    const response = await f.post('/api/desktop/restart', { requestId: 'invalid-override', ...fields });
    assert.equal(response.status, 400); assert.equal(response.value.code, 'DESKTOP_RESTART_ARGUMENTS');
  }
  const remote = await f.post('/api/desktop/restart', { requestId: 'remote-local-route' }, { 'x-blackice-remote': '1' });
  assert.equal(remote.status, 403); assert.equal(remote.value.code, 'DESKTOP_RESTART_LOCAL_REQUIRED');
  assert.deepEqual(f.controller.receipts, []); assert.deepEqual(f.native, []);
  for (const action of ['status', 'cancel']) assert.equal((await f.post('/api/desktop/restart/' + action, { requestId: 'invalid-force', force: true })).status, 400);
});

test('the authenticated direct restart tool also waits for its exact durable receipt before native handoff', { timeout: 15000 }, async t => {
  const f = await fixture(t), admitted = await f.app.directExecution.call('blackice_restart', { requestId: 'direct-native-restart' }, f.client);
  assert.equal((await f.waitJob(admitted.jobId)).status, 'succeeded');
  const receipt = await f.controller.waitForHandoff();
  assert.equal(receipt.status, 'restarting'); assert.equal(receipt.jobId, admitted.jobId);
  assert.deepEqual(f.native, [{ action: 'relaunch', savedJob: admitted.jobId, savedStatus: 'succeeded' }, { action: 'quit' }]);
});
