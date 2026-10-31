import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';
import { DesktopRestartController } from '../desktop/restart.mjs';

const held = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
class Runtime extends EventEmitter {
  async runAgent() { assert.fail('This server fixture must not execute a model.'); }
  status() { return { connected: false, authenticated: false, activeTurns: 0, models: [] }; }
  async start() { return this.status(); }
  async close() {}
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-restart-browser-'));
  const state = { available: true, contained: true, busy: false, lifecycle: 'ready', persistence: { healthy: true }, tabs: Array.from({ length: 8 }, (_, index) => ({ tabId: `saved-${index}`, url: `https://saved${index}.example/`, suspended: true })), downloads: [] };
  const effects = [], browser = new EventEmitter();
  browser.status = () => structuredClone(state);
  browser.flushPersistence = async () => { effects.push('flush'); return browser.status(); };
  browser.cancel = () => { effects.push('cancel'); };
  browser.close = async () => { effects.push('close'); };
  const desktop = new EventEmitter(); desktop.status = () => ({ available: false, enabled: false }); desktop.setEnabled = async () => desktop.status();
  const app = await createHarnessServer({ port: 0, runtime: new Runtime(), browser, desktop, dataDir: path.join(directory, 'data'), defaultCwd: path.join(directory, 'workspace'), autoAttachDesktop: false, remoteAccess: false, emailExecutableHint: null });
  t.after(async () => { app.endRestart(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, browser, state, effects, directory };
}

test('restart browser drain saves retained pages under the gate without closing or cancelling them', async t => {
  const f = await fixture(t), entered = held(), finish = held(), before = structuredClone(f.state.tabs);
  f.browser.flushPersistence = async () => {
    assert.equal(f.app.engine.maintenanceRequested, true);
    f.effects.push('flush'); entered.resolve(); await finish.promise;
    return f.browser.status();
  };
  await f.app.assertRestartReady(); assert.deepEqual(f.effects, []);
  const pending = f.app.beginRestart(); await entered.promise;
  assert.deepEqual(f.effects, ['flush']); assert.deepEqual(f.state.tabs, before);
  finish.resolve(); await pending;
  assert.equal(f.app.engine.maintenanceRequested, true); assert.deepEqual(f.effects, ['flush']);
  f.app.endRestart(); assert.equal(f.app.engine.maintenanceRequested, false);
});

test('restart browser storage failure leaves the runtime open and a deliberate retry can save it', async t => {
  const f = await fixture(t), failure = Object.assign(new Error('Fixture browser write failed.'), { code: 'BROWSER_SAVE_FAILED' });
  f.browser.flushPersistence = async () => { f.effects.push('failed-flush'); throw failure; };
  await assert.rejects(f.app.beginRestart(), error => error === failure);
  assert.equal(f.app.engine.maintenanceRequested, false); assert.deepEqual(f.effects, ['failed-flush']);
  f.browser.flushPersistence = async () => { f.effects.push('saved'); return f.browser.status(); };
  await f.app.beginRestart(); assert.deepEqual(f.effects, ['failed-flush', 'saved']);
  f.app.endRestart(); assert.equal(f.state.tabs.length, 8);
});

test('restart browser readiness blocks active work and requires a persistence drain for an available adapter', async t => {
  const f = await fixture(t);
  f.state.busy = true;
  await assert.rejects(f.app.assertRestartReady(), { code: 'DESKTOP_RESTART_BROWSER_BUSY' });
  await assert.rejects(f.app.beginRestart(), { code: 'DESKTOP_RESTART_BROWSER_BUSY' });
  assert.deepEqual(f.effects, []); assert.equal(Boolean(f.app.engine.maintenanceRequested), false);
  f.state.busy = false; delete f.browser.flushPersistence;
  await assert.rejects(f.app.beginRestart(), { code: 'DESKTOP_RESTART_STORAGE' });
  assert.deepEqual(f.effects, []); assert.equal(f.app.engine.maintenanceRequested, false);
  f.state.available = false; f.state.tabs = [];
  await f.app.beginRestart(); f.app.endRestart();
  assert.deepEqual(f.effects, [], 'An absent browser has no persistence work to drain.');
});

test('restart browser final native callback refuses a download that starts after asynchronous preparation', async t => {
  const f = await fixture(t), native = [], profileDir = path.join(f.directory, 'profile');
  const identity = { pid: 1234, startedAt: new Date().toISOString(), profileDir, mode: 'headless' };
  const main = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  const callback = /relaunch:\s*(options\s*=>\s*\{[^{}]+\})/.exec(main)?.[1];
  assert.ok(callback, 'Exercise the desktop runtime’s actual native relaunch callback.');
  const relaunch = new Function('harness', 'app', `let restartClosing = false; return (${callback});`)(f.app, { relaunch: () => native.push('relaunch') });
  const controller = new DesktopRestartController({
    profileDir, getIdentity: () => identity,
    checkReady: context => f.app.assertRestartReady(context),
    prepare: context => f.app.beginRestart(context),
    release: () => f.app.endRestart(),
    getLaunchOptions: async () => {
      f.state.downloads.push({ tabId: 'saved-0', status: 'downloading' });
      return { execPath: process.execPath, args: ['--headless'], profileDir, mode: 'headless' };
    },
    relaunch, quit: () => native.push('quit'),
  });
  const scheduled = await controller.request({ requestId: 'late-browser-download' });
  assert.equal(scheduled.status, 'scheduled');
  const result = await controller.waitForHandoff();
  assert.equal(result.status, 'failed'); assert.deepEqual(native, []);
  assert.deepEqual(f.effects, ['flush']); assert.equal(f.app.engine.maintenanceRequested, false);
  assert.equal(f.state.downloads[0].status, 'downloading'); assert.equal(f.state.tabs.length, 8);
});

test('browser tree HTTP assets and the full app module import graph resolve through the served allowlist', async t => {
  const { app } = await fixture(t), origin = await app.listen();
  for (const pathname of ['/browser-tree-model.mjs', '/browser-tree.css', '/conversation-bulk-model.mjs', '/conversation-bulk.css']) {
    const response = await fetch(origin + pathname);
    assert.equal(response.status, 200, `${pathname} must be served`);
    assert.match(response.headers.get('content-type'), pathname.endsWith('.css') ? /^text\/css\b/ : /^text\/javascript\b/);
    assert.equal(await response.text(), await readFile(new URL('../public' + pathname, import.meta.url), 'utf8'));
  }
  const pending = ['/app.js'], visited = new Set();
  while (pending.length) {
    const pathname = pending.pop(); if (visited.has(pathname)) continue; visited.add(pathname);
    const response = await fetch(origin + pathname);
    assert.equal(response.status, 200, `Required module ${pathname} must be served`);
    assert.match(response.headers.get('content-type'), /^text\/javascript\b/);
    const source = await response.text();
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]((?:\.{1,2}\/|\/)[^'"]+)['"]/g)) {
      const target = new URL(match[1], origin + pathname);
      assert.equal(target.origin, origin);
      if (/\.(?:m?js)$/.test(target.pathname)) pending.push(target.pathname);
    }
  }
  assert.ok(visited.has('/browser-tree-model.mjs'), 'The real app import graph reaches the new browser tree model.');
  assert.ok(visited.has('/browser-ui.mjs')); assert.ok(visited.has('/observe-ui.mjs'));
});
