import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserProtection } from '../lib/browser-protection.mjs';
import { BrowserRouter } from '../desktop/browser-router.mjs';
import { BrowserWorkspace, BROWSER_ACTIONS, BROWSER_TOOL } from '../lib/browser.mjs';

test('the contained session filters only after opt-in and exposes guarded filtering through the router', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-protection-driver-')), native = new EventEmitter(), windows = [], registrations = [], protocol = [];
  native.extensions = { loadExtension: async () => ({ id: 'owned-compatibility-extension' }) };
  native.cookies = new EventEmitter(); native.webRequest = { onBeforeRequest(...args) { registrations.push(args); native.beforeRequest = args.at(-1); }, onCompleted() {}, onErrorOccurred() {} }; native.setPermissionRequestHandler = native.setPermissionCheckHandler = native.setDevicePermissionHandler = native.setUSBProtectedClassesHandler = () => {}; native.flushStorageData = async () => {};
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; windows.push(this);
      const wc = this.webContents = new EventEmitter(); wc.id = windows.length; wc.debugger = new EventEmitter(); wc.debugger.isAttached = () => true; wc.debugger.sendCommand = async method => { protocol.push(method); return {}; };
      wc.getURL = () => this.url || ''; wc.getTitle = () => 'Contained fixture'; wc.isLoading = () => false; wc.isOffscreen = () => options.webPreferences.offscreen; wc.isDestroyed = () => this.destroyed; wc.setWindowOpenHandler = () => {}; wc.loadURL = async url => { this.url = url; };
    }
    removeMenu() {} isDestroyed() { return this.destroyed; } isVisible() { return false; } isFocusable() { return false; } destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const sourceURL = new URL('../desktop/browser-driver.mjs', import.meta.url), key = '__protectionFixture_' + randomUUID().replaceAll('-', '');
  const source = (await readFile(sourceURL, 'utf8')).replace("import { BrowserWindow, session } from 'electron';", `const {BrowserWindow,session}=globalThis[${JSON.stringify(key)}];`).replace(/from '(\.\.?\/[^']+)'/g, (_all, relative) => `from '${new URL(relative, sourceURL).href}'`);
  globalThis[key] = { BrowserWindow: Window, session: { fromPartition: name => { assert.equal(name, 'persist:relay-agent-browser-v2'); return native; } } };
  let Driver; try { ({ ElectronBrowserDriver: Driver } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))); } finally { delete globalThis[key]; }
  const protection = new BrowserProtection({ dataDir: directory }), driver = new Driver({ dataDir: directory, downloadDir: path.join(directory, 'downloads'), protection });
  const firefox = { status: () => ({ tabs: [{ tabId: 'external', url: 'https://external.test/' }], activeTab: 'external' }), close: async () => {} };
  const router = new BrowserRouter({ independent: driver, firefox }), workspace = new BrowserWorkspace({ driver: router });
  t.after(async () => { await workspace.close(); assert.equal(native.beforeRequest, null); await rm(directory, { recursive: true, force: true }); }); await driver.init();
  assert.equal(registrations.length, 1); assert.deepEqual(registrations[0][0], { urls: ['<all_urls>'] });
  const tab = driver.newTab('https://example.com/article'); await tab.loading;
  const request = (values = {}) => { const results = []; native.beforeRequest({ url: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', resourceType: 'script', webContentsId: tab.window.webContents.id, ...values }, value => results.push(value)); assert.equal(results.length, 1, 'Every native request must receive exactly one decision.'); return results[0]; };
  assert.deepEqual(request(), { cancel: false });
  await workspace.configureProtection({ action: 'global', enabled: true }, { source: 'agent' });
  assert.deepEqual(request(), { cancel: true }); assert.deepEqual(request({ url: 'https://example.com/article.png', resourceType: 'image' }), { cancel: false });
  assert.equal(workspace.protectionStatus().tabs.find(value => value.tabId === tab.id).blockedRequests, 1); assert.equal(workspace.status().tabs.find(value => value.tabId === tab.id).protection.origin, 'https://example.com');
  await workspace.configureProtection({ action: 'site', tabId: tab.id, origin: 'https://example.com', enabled: false }); assert.deepEqual(request(), { cancel: false });
  tab.window.url = 'https://different.example/article';
  await assert.rejects(workspace.configureProtection({ action: 'site', tabId: tab.id, origin: 'https://example.com', enabled: false }), { code: 'BROWSER_PROTECTION_STALE_TAB' }); assert.deepEqual(request(), { cancel: true });
  await assert.rejects(workspace.configureProtection({ action: 'site', tabId: 'firefox:external', origin: 'https://external.test', enabled: false }), { code: 'BROWSER_PROTECTION_CONTAINED_ONLY' });
  await assert.rejects(workspace.configureProtection({ action: 'site', tabId: 'unknown', origin: 'https://example.com', enabled: false }), { code: 'BROWSER_TAB_NOT_FOUND' });
  await workspace.configureProtection({ action: 'global', enabled: false }, { source: 'agent' }); assert.deepEqual(request(), { cancel: false });
  await assert.rejects(workspace.perform({ action: 'protection', enabled: false }), { code: 'BROWSER_VALIDATION' }); assert.equal(BROWSER_ACTIONS.includes('protection'), true); assert.ok(BROWSER_TOOL.inputSchema.properties.operation.enum.includes('global'));
  await workspace.perform({ action: 'protection', operation: 'global', enabled: true }); assert.deepEqual(request(), { cancel: true });
  const match = protection.match; protection.match = () => { throw new Error('Unexpected filter exception'); }; assert.deepEqual(request(), { cancel: false }); protection.match = match;
  assert.equal(windows.length, 1); assert.equal(windows[0].options.show, false); assert.equal(windows[0].options.focusable, false); assert.equal(windows[0].options.webPreferences.offscreen, true); assert.ok(protocol.includes('Page.setInterceptFileChooserDialog'));
});
