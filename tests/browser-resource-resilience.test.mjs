import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { browserURL, browserCredentialTarget, browserOwner, browserOwnerKey, browserWheelScroll, validateBrowserWheelScroll, validateBrowserPreview } from '../lib/browser.mjs';
import { BrowserDiagnostics } from '../lib/browser-diagnostics.mjs';
import { loadBrowserCompatibility } from '../desktop/browser-compatibility.mjs';

const source = await readFile(new URL('../desktop/browser-driver.mjs', import.meta.url), 'utf8');

function fixture({ writeFile = async () => {}, loadURL = async () => {} } = {}) {
  const windows = [], writes = [], renames = [];
  class Window extends EventEmitter {
    constructor() {
      super(); windows.push(this); this.destroyed = false;
      const wc = this.webContents = new EventEmitter();
      wc.id = windows.length; wc.url = 'about:blank'; wc.title = 'Test page'; wc.loads = [];
      wc.loadURL = async url => { wc.loads.push(url); await loadURL(url, this); wc.url = url; };
      wc.getURL = () => wc.url; wc.getTitle = () => wc.title;
      wc.isLoading = wc.isLoadingMainFrame = () => false;
      wc.isDestroyed = () => this.destroyed;
      wc.setWindowOpenHandler = () => {};
      wc.debugger = new EventEmitter(); wc.debugger.attached = false;
      wc.debugger.isAttached = () => wc.debugger.attached;
      wc.debugger.attach = () => { wc.debugger.attached = true; };
      wc.debugger.sendCommand = async () => ({});
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return false; }
    isFocusable() { return false; }
    removeMenu() {}
    hide() {}
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
  }
  const session = new EventEmitter();
  session.extensions = { loadExtension: async () => ({ id: 'owned-compatibility-extension' }) };
  session.cookies = new EventEmitter();
  session.webRequest = { onBeforeRequest() {}, onCompleted() {}, onErrorOccurred() {} };
  session.setPermissionRequestHandler = session.setPermissionCheckHandler = session.setDevicePermissionHandler = session.setUSBProtectedClassesHandler = () => {};
  const protection = new EventEmitter();
  protection.status = protection.tabStatus = () => ({});
  protection.forgetTab = () => {};
  const context = vm.createContext({ BrowserWindow: Window, session: { fromPartition: () => session }, EventEmitter,
    createHash, randomUUID, path, browserURL, browserCredentialTarget, browserOwner, browserOwnerKey, browserWheelScroll, validateBrowserWheelScroll, validateBrowserPreview, BrowserDiagnostics, loadBrowserCompatibility,
    fs: { writeFile: async (file, value) => { writes.push(JSON.parse(value)); await writeFile(file, value); }, rename: async (...args) => { renames.push(args); } },
    setTimeout, clearTimeout, AbortSignal, structuredClone, URL,
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replace('export class ElectronBrowserDriver', 'class ElectronBrowserDriver') + '\nglobalThis.Driver = ElectronBrowserDriver;', context);
  const driver = new context.Driver({ dataDir: '/virtual', downloadDir: '/virtual', protection });
  return { driver, windows, writes, renames, context };
}

test('a crashed page releases its window, retires refs, and settles pending page work without replay', async () => {
  const f = fixture(), tab = f.driver.newTab('https://example.test/page');
  await tab.loading;
  const window = tab.window, revision = tab.revision, loads = [...window.webContents.loads];
  tab.refs.set('old-target', {});
  const pending = f.driver.pageWork(tab, new Promise(() => {}), undefined, 5000);
  window.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 9 });
  await assert.rejects(pending, error => error.code === 'BROWSER_RENDERER_GONE' && error.actionDispatched === true);
  assert.equal(window.isDestroyed(), true);
  assert.equal(tab.window, null);
  assert.equal(f.driver.tabs.get(tab.id), tab);
  assert.equal(tab.refs.size, 0);
  assert.equal(tab.rendererWaiters.size, 0);
  assert.equal(tab.revision, revision + 1);
  assert.equal(f.driver.status().capacity.live, 0);
  assert.equal(f.driver.status().tabs[0].rendererFailure.reason, 'oom');
  assert.equal(f.driver.status().tabs[0].url, 'https://example.test/page');
  await assert.rejects(f.driver.perform({ action: 'read', tabId: tab.id }), error => error.code === 'BROWSER_RENDERER_GONE' && error.actionDispatched === false);
  await assert.rejects(f.driver.perform({ action: 'click', tabId: tab.id, ref: 'old-target' }), error => error.code === 'BROWSER_RENDERER_GONE');
  assert.equal(f.windows.length, 1);
  assert.deepEqual(window.webContents.loads, loads);
  await f.driver.writeChain;
});

test('wheel input preserves a crashed page diagnosis without materializing a replacement', async () => {
  const f = fixture(), tab = f.driver.newTab('https://example.test/page'); await tab.loading;
  const window = tab.window, revision = tab.revision, loads = [...window.webContents.loads];
  window.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 9 });
  await assert.rejects(f.driver.perform({ action: 'scroll', browser: 'relay', tabId: tab.id, x: 120, y: 90, deltaX: 0, deltaY: 120, expectedUrl: 'https://example.test/page', expectedDocumentId: tab.id + ':' + revision }), error => error.code === 'BROWSER_RENDERER_GONE' && error.actionDispatched === false);
  assert.equal(window.isDestroyed(), true); assert.equal(tab.window, null); assert.equal(f.windows.length, 1);
  assert.equal(tab.rendererFailure.reason, 'oom'); assert.deepEqual(window.webContents.loads, loads);
  await f.driver.writeChain;
});

test('explicit reload alone recovers a crashed tab and an old window cannot delete its replacement', async () => {
  const f = fixture(), tab = f.driver.newTab('https://example.test/page');
  await tab.loading;
  const old = tab.window;
  old.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  f.driver.snapshot = async () => ({ frames: [] });
  f.driver.watchNavigation = () => ({ wait: async () => {}, dispose() {} });
  await f.driver.perform({ action: 'reload', tabId: tab.id });
  assert.equal(f.windows.length, 2);
  assert.notEqual(tab.window, old);
  assert.equal(tab.rendererFailure, null);
  assert.deepEqual(tab.window.webContents.loads, ['about:blank', 'https://example.test/page']);
  old.emit('closed');
  old.webContents.emit('render-process-gone', {}, { reason: 'killed' });
  assert.equal(f.driver.tabs.get(tab.id), tab);
  assert.equal(tab.window, f.windows[1]);
  await f.driver.writeChain;
});

test('one failed renderer does not close another page and can be closed without recovery', async () => {
  const f = fixture(), first = f.driver.newTab('https://first.test/'), second = f.driver.newTab('https://second.test/');
  await Promise.all([first.loading, second.loading]);
  first.window.webContents.emit('render-process-gone', {}, { reason: 'untrusted text https://secret.test/token' });
  assert.equal(first.rendererFailure.reason, 'unknown');
  assert.equal(second.window.isDestroyed(), false);
  assert.equal(f.driver.status().capacity.live, 1);
  await f.driver.perform({ action: 'close', tabId: first.id });
  assert.equal(f.driver.tabs.has(first.id), false);
  assert.equal(f.driver.tabs.has(second.id), true);
  await f.driver.writeChain;
});

test('failed recovery admission preserves the crash state and never makes a later read navigate', async () => {
  const f = fixture(), tab = f.driver.newTab('https://example.test/page');
  await tab.loading;
  tab.window.webContents.emit('render-process-gone', {}, { reason: 'oom' });
  const other = f.driver.newTab('https://second.test/'); await other.loading;
  f.driver.maxLiveTabs = 1;
  await assert.rejects(f.driver.perform({ action: 'reload', tabId: tab.id }), error => error.code === 'BROWSER_LIVE_LIMIT' && error.actionDispatched === false);
  assert.equal(tab.rendererFailure.reason, 'oom');
  await assert.rejects(f.driver.perform({ action: 'read', tabId: tab.id }), error => error.code === 'BROWSER_RENDERER_GONE');
  assert.equal(f.windows.length, 2);
  await f.driver.writeChain;
});

test('a late load failure from a crashed window cannot poison its replacement', async () => {
  let rejectOld, started;
  const oldLoad = new Promise((_, reject) => { rejectOld = reject; });
  const loading = new Promise(resolve => { started = resolve; });
  const f = fixture({ loadURL: async (url, window) => { if (window === f.windows[0] && url !== 'about:blank') { started(); await oldLoad; } } });
  const tab = f.driver.newTab('https://example.test/page');
  await loading;
  const previous = tab.loading;
  tab.window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  f.driver.snapshot = async () => ({ frames: [] });
  f.driver.watchNavigation = () => ({ wait: async () => {}, dispose() {} });
  await f.driver.perform({ action: 'reload', tabId: tab.id });
  rejectOld(new Error('old renderer failed after recovery'));
  await previous;
  assert.equal(tab.loadError, null);
  assert.equal(tab.window, f.windows[1]);
  await f.driver.writeChain;
});

test('a blocked disk retains only the newest pending browser state and the save receipt drains it', async () => {
  let release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const f = fixture({ writeFile: async () => { if (++calls === 1) { started(); await blocked; } } });
  const tab = f.driver.newTab('https://example.test/', { restore: true });
  f.driver.persist(); await entered;
  const receipt = f.driver.writeChain;
  for (let index = 0; index < 1000; index++) { tab.title = `title-${index}`; f.driver.persist(); }
  assert.equal(f.driver.writeChain, receipt);
  assert.equal(f.writes.length, 1);
  assert.equal(f.driver.pendingPersistence.tabs[0].title, 'title-999');
  release(); await f.driver.savedStatus();
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[1].tabs[0].title, 'title-999');
  assert.equal(f.renames.length, 2);
  assert.equal(f.driver.persistenceRunning, false);
  assert.equal(f.driver.pendingPersistence, null);
});

test('coalesced storage failures remain visible and a later successful save clears the failure', async () => {
  let fail = true;
  const f = fixture({ writeFile: async () => { if (fail) throw new Error('disk unavailable'); } });
  f.driver.newTab('https://example.test/', { restore: true });
  await assert.rejects(f.driver.flushPersistence(), error => error.code === 'BROWSER_SAVE_FAILED');
  assert.equal(f.driver.status().persistence.healthy, false);
  fail = false;
  await f.driver.flushPersistence();
  assert.equal(f.driver.status().persistence.healthy, true);
  assert.equal(f.renames.length, 1);
});

test('query snapshots keep strong DOM refs only for the current bounded result', () => {
  const controls = Array.from({ length: 1500 }, (_, index) => ({
    tagName: 'BUTTON', textContent: `group-${Math.floor(index / 100)} item-${index}`, isConnected: true,
    getAttribute: () => null, getBoundingClientRect: () => ({ width: 10, height: 10 }),
    children: [], childNodes: [], tabIndex: 0,
  }));
  const document = { documentElement: { children: controls }, title: 'Large page', readyState: 'complete', getElementById: () => null };
  const context = vm.createContext({ document, location: { href: 'https://example.test/' }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) });
  const start = source.indexOf('function pageSnapshot('), end = source.indexOf('\nfunction elementAction(', start);
  vm.runInContext(source.slice(start, end), context);
  for (let group = 0; group < 15; group++) {
    const result = context.pageSnapshot('snapshotState', 'doc-1', `group-${group} `);
    assert.equal(result.elements.length, 100);
    assert.equal(context.snapshotState.elements.size, 100);
    assert.ok([...context.snapshotState.elements.values()].every(element => element.textContent.startsWith(`group-${group} `)));
  }
  context.pageSnapshot('snapshotState', 'doc-1', 'no-match');
  assert.equal(context.snapshotState.elements.size, 0);
  const unfiltered = context.pageSnapshot('snapshotState', 'doc-1', '');
  assert.equal(unfiltered.elements.length, 300);
  assert.equal(context.snapshotState.elements.size, 300);
});
