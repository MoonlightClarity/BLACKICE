import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserWorkspace } from '../lib/browser.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, { loadURL = async () => {} } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-native-auth-')), session = new EventEmitter(), windows = [];
  Object.assign(session, { extensions: { loadExtension: async () => ({ id: 'fixture-extension' }) }, cookies: new EventEmitter(),
    webRequest: { onBeforeRequest() {}, onCompleted() {}, onErrorOccurred() {} }, setPermissionRequestHandler() {},
    setPermissionCheckHandler() {}, setDevicePermissionHandler() {}, setUSBProtectedClassesHandler() {}, flushStorageData: async () => {} });
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.liveSurface = true; this.protocol = []; this.destroyed = false; windows.push(this);
      const contents = this.webContents = new EventEmitter(), debugger_ = contents.debugger = new EventEmitter();
      debugger_.isAttached = () => debugger_.attached === true; debugger_.attach = () => { debugger_.attached = true; };
      debugger_.sendCommand = async (method, params) => { this.protocol.push({ method, params }); return {}; };
      Object.assign(contents, { isDestroyed: () => this.destroyed, getURL: () => this.url || '', getTitle: () => 'Fixture site',
        isLoading: () => false, isLoadingMainFrame: () => false, setWindowOpenHandler() {}, stop() {},
        loadURL: async url => { await loadURL(url, this); this.url = url; },
        mainFrame: { processId: 1, routingId: 1, framesInSubtree: [], executeJavaScript: async () => ({ title: 'Fixture', url: this.url, elements: [], text: 'Fixture page' }) } });
    }
    removeMenu() {} isDestroyed() { return this.destroyed; } isVisible() { return false; } isFocusable() { return false; }
    hide() {} attach() {} position() {} focus() {}
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
  }
  const sourceURL = new URL('../desktop/browser-driver.mjs', import.meta.url), key = '__nativeAuthFixture_' + randomUUID().replaceAll('-', '');
  let source = await readFile(sourceURL, 'utf8');
  source = source.replace("import { BrowserWindow, session } from 'electron';", `const {BrowserWindow,session}=globalThis[${JSON.stringify(key)}];`)
    .replace(/from '(\.\.?\/[^']+)'/g, (_all, relative) => `from '${new URL(relative, sourceURL).href}'`);
  globalThis[key] = { BrowserWindow: Window, session: { fromPartition: () => session } };
  let Driver; try { ({ ElectronBrowserDriver: Driver } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))); } finally { delete globalThis[key]; }
  const driver = await new Driver({ dataDir: directory, downloadDir: path.join(directory, 'downloads'), liveSurface: true, createSurfaceWindow: options => new Window(options) }).init();
  const tab = driver.newTab('https://site.test/private'); await tab.loading;
  t.after(async () => { await driver.close(); assert.match(path.basename(directory), /^blackice-native-auth-/); await rm(directory, { recursive: true, force: true }); });
  const login = (page = tab, callback = () => {}, extra = {}) => {
    let prevented = false;
    page.window.webContents.emit('login', { preventDefault: () => { prevented = true; } }, { url: 'https://in-url:secret@site.test/private?token=secret#fragment' },
      { realm: '<Private site>', isProxy: false, scheme: 'basic', ...extra }, callback);
    assert.equal(prevented, true); return page.pendingInteraction;
  };
  const answer = (pending, extra = {}) => ({ action: 'authenticate', tabId: pending.tabId, challengeId: pending.challengeId, username: 'Synthetic user', password: 'Synthetic password', ...extra });
  return { driver, tab, windows, login, answer, directory, host: { isDestroyed: () => false, getContentSize: () => [1000, 800] } };
}

test('a live HTTP challenge waits for input and exposes only bounded site metadata', async t => {
  const f = await fixture(t), callbacks = [], pending = f.login(f.tab, (...args) => callbacks.push(args));
  assert.equal(callbacks.length, 0); assert.equal(pending.kind, 'http_auth'); assert.equal(pending.status, 'pending');
  assert.equal(pending.challengeId, pending.id); assert.equal(pending.origin, 'https://site.test'); assert.equal(pending.url, 'https://site.test/');
  assert.equal(pending.realm, '<Private site>'); assert.equal(pending.scheme, 'basic'); assert.equal(pending.isProxy, false);
  assert.doesNotMatch(JSON.stringify(f.driver.status()), /in-url|secret|callback|authenticationChallenge/);
  f.driver.persist(); await f.driver.writeChain;
  assert.doesNotMatch(await readFile(path.join(f.directory, 'browser-tabs.json'), 'utf8'), /realm|challengeId|http_auth|callback|secret/);
});

test('the trusted surface answers an exact challenge once without storing or returning credentials', async t => {
  const f = await fixture(t), callbacks = [], pending = f.login(f.tab, (...args) => callbacks.push(args));
  await assert.rejects(f.driver.setHostSurface(f.host, f.answer(pending, { challengeId: 'old_challenge' })), { code: 'BROWSER_AUTHENTICATION_CHANGED' });
  await assert.rejects(f.driver.setHostSurface(f.host, f.answer(pending, { injected: true })), /Unsupported/);
  assert.equal(callbacks.length, 0);
  const receipt = await f.driver.setHostSurface(f.host, f.answer(pending));
  assert.deepEqual(receipt, { tabId: f.tab.id, challengeId: pending.id, submitted: true, cancelled: false });
  assert.deepEqual(callbacks, [['Synthetic user', 'Synthetic password']]); assert.equal(f.tab.pendingInteraction, null);
  assert.doesNotMatch(JSON.stringify(receipt) + JSON.stringify(f.driver.status()) + JSON.stringify(f.tab.authenticationChallenge), /Synthetic/);
  await assert.rejects(f.driver.setHostSurface(f.host, f.answer(pending)), { code: 'BROWSER_AUTHENTICATION_CHANGED' });
  assert.equal(callbacks.length, 1);
});

test('invalid credential values preserve the challenge, while explicit cancel consumes it once', async t => {
  const f = await fixture(t), callbacks = [], pending = f.login(f.tab, (...args) => callbacks.push(args));
  for (const extra of [{ username: null }, { password: 'x'.repeat(4097) }, { password: 'bad\0value' }])
    await assert.rejects(f.driver.setHostSurface(f.host, f.answer(pending, extra)), { code: 'BROWSER_AUTHENTICATION_VALIDATION' });
  assert.equal(callbacks.length, 0); assert.equal(f.tab.pendingInteraction.id, pending.id);
  const result = await f.driver.setHostSurface(f.host, { action: 'cancel-auth', tabId: f.tab.id, challengeId: pending.id });
  assert.equal(result.cancelled, true); assert.equal(result.submitted, false); assert.deepEqual(callbacks, [[]]);
  await assert.rejects(f.driver.setHostSurface(f.host, { action: 'cancel-auth', tabId: f.tab.id, challengeId: pending.id }), { code: 'BROWSER_AUTHENTICATION_CHANGED' });
});

test('a new challenge retires the old callback and old submissions cannot answer the new request', async t => {
  const f = await fixture(t), old = [], next = [], first = f.login(f.tab, (...args) => old.push(args)), second = f.login(f.tab, (...args) => next.push(args), { realm: 'New realm', isProxy: true, host: 'proxy.test', port: 8080 });
  assert.notEqual(first.id, second.id); assert.deepEqual(old, [[]]); assert.equal(second.isProxy, true);
  assert.equal(second.host, 'proxy.test'); assert.equal(second.port, 8080); assert.equal(second.origin, 'https://site.test');
  await assert.rejects(f.driver.setHostSurface(f.host, f.answer(first)), { code: 'BROWSER_AUTHENTICATION_CHANGED' });
  assert.equal(next.length, 0);
  await f.driver.setHostSurface(f.host, f.answer(second, { username: '', password: '' }));
  assert.deepEqual(next, [['', '']]); assert.equal(old.length, 1);
});

test('wrong credentials may produce a fresh challenge during the callback without receiving stale credentials', async t => {
  const f = await fixture(t), callbacks = [], next = [];
  const first = f.login(f.tab, (...args) => { callbacks.push(args); f.login(f.tab, (...values) => next.push(values)); });
  await f.driver.setHostSurface(f.host, f.answer(first));
  const second = f.tab.pendingInteraction;
  assert.notEqual(first.id, second.id); assert.equal(next.length, 0);
  await assert.rejects(f.driver.setHostSurface(f.host, f.answer(first)), { code: 'BROWSER_AUTHENTICATION_CHANGED' });
  await f.driver.setHostSurface(f.host, { action: 'cancel-auth', tabId: f.tab.id, challengeId: second.id });
  assert.deepEqual(next, [[]]); assert.equal(callbacks.length, 1);
});

test('tab switching, native attachment, hiding and debugger reconnection retain the sign-in request', async t => {
  const f = await fixture(t), callbacks = [], pending = f.login(f.tab, (...args) => callbacks.push(args));
  f.tab.loading = new Promise(() => {});
  await f.driver.setHostSurface(f.host, { action: 'attach', tabId: f.tab.id, bounds: { x: 0, y: 0, width: 800, height: 500 } });
  await f.driver.setHostSurface(f.host, { action: 'hide' });
  f.tab.window.webContents.debugger.emit('detach');
  const other = f.driver.newTab('https://other.test/'); await other.loading;
  await f.driver.setHostSurface(f.host, { action: 'attach', tabId: other.id, bounds: { x: 0, y: 0, width: 800, height: 500 } });
  await f.driver.setHostSurface(f.host, { action: 'attach', tabId: f.tab.id, bounds: { x: 0, y: 0, width: 800, height: 500 } });
  assert.equal(f.tab.pendingInteraction.id, pending.id); assert.equal(callbacks.length, 0);
});

test('authentication attachment and detachment never wait on the paused browser protocol', async t => {
  const f = await fixture(t), callbacks = [], pending = f.login(f.tab, (...args) => callbacks.push(args));
  const debug = f.tab.window.webContents.debugger, commands = [];
  debug.attached = false; f.tab.containmentReady = null;
  debug.sendCommand = async (method, params) => {
    commands.push({ method, params });
    if (f.tab.authenticationChallenge) throw Error('The browser protocol is paused by HTTP authentication.');
    return {};
  };
  f.tab.loading = new Promise(() => {});
  await f.driver.setHostSurface(f.host, { action: 'attach', tabId: f.tab.id, bounds: { x: 0, y: 0, width: 800, height: 500 } });
  await f.driver.setHostSurface(f.host, { action: 'hide' });
  await f.driver.setHostSurface(f.host, { action: 'attach', tabId: f.tab.id, bounds: { x: 0, y: 0, width: 800, height: 500 } });
  assert.equal(commands.length, 0); assert.equal(f.tab.humanSurface, true); assert.equal(f.tab.surfaceNeedsSync, true);
  assert.equal(f.tab.pendingInteraction.id, pending.id); assert.equal(callbacks.length, 0);
  await f.driver.setHostSurface(f.host, f.answer(pending));
  debug.attached = true; f.tab.window.webContents.emit('did-stop-loading');
  await tick();
  assert.deepEqual(commands, [{ method: 'Page.setInterceptFileChooserDialog', params: { enabled: false } }]);
  assert.equal(f.tab.surfaceNeedsSync, false); assert.equal(callbacks.length, 1);
});

test('navigation, replacement, tab closure, renderer loss and shutdown cancel pending callbacks once', async t => {
  for (const lifecycle of ['navigation', 'replacement', 'close', 'renderer', 'shutdown']) {
    await t.test(lifecycle, async t => {
      const f = await fixture(t), callbacks = [], pending = f.login(f.tab, (...args) => callbacks.push(args));
      if (lifecycle === 'navigation') f.tab.window.webContents.emit('did-start-navigation', {}, 'https://site.test/next', false, true);
      if (lifecycle === 'replacement') f.tab.window.webContents.emit('did-frame-navigate', {}, 'https://site.test/next', 200, 'OK', true);
      if (lifecycle === 'close') f.driver.closeTab(f.tab);
      if (lifecycle === 'renderer') f.driver.rendererGone(f.tab, f.tab.window, { reason: 'crashed' });
      if (lifecycle === 'shutdown') await f.driver.close();
      assert.deepEqual(callbacks, [[]]);
      assert.throws(() => f.driver.resolveAuthentication(f.answer(pending)), { code: 'BROWSER_AUTHENTICATION_CHANGED' });
      assert.equal(callbacks.length, 1); await tick();
    });
  }
});

test('a pending network load returns a real auth receipt instead of holding the action queue', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { loadURL: async (url, window) => {
    if (!url.endsWith('/challenge')) return;
    window.webContents.emit('login', { preventDefault() {} }, { url }, { realm: 'Navigation realm', scheme: 'basic' }, () => release());
    await held;
  } });
  const result = await f.driver.perform({ action: 'navigate', tabId: f.tab.id, url: 'https://site.test/challenge' }, { source: 'agent' });
  assert.equal(result.pendingInteraction.kind, 'http_auth'); assert.equal(result.pendingInteraction.status, 'pending');
  await f.driver.setHostSurface(f.host, f.answer(result.pendingInteraction));
  await tick(); assert.equal(f.tab.suspendedWork.size, 0);
});

test('an initial user tab open releases the browser queue and auth IPC resumes its one existing network request', async t => {
  let release, requested = 0;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { loadURL: async (url, window) => {
    if (!url.endsWith('/challenge')) return;
    requested++;
    window.webContents.emit('login', { preventDefault() {} }, { url }, { realm: 'Initial sign-in', scheme: 'basic' }, () => release());
    await held;
  } });
  const browser = new BrowserWorkspace({ driver: f.driver });
  t.after(() => browser.close());
  const result = await browser.perform({ action: 'open', url: 'https://site.test/challenge' }, { source: 'user' });
  assert.equal(result.pendingInteraction.kind, 'http_auth'); assert.equal(browser.status().busy, false);
  assert.equal((await browser.perform({ action: 'tabs' }, { source: 'user' })).tabs.length, 2);
  await f.driver.setHostSurface(f.host, f.answer(result.pendingInteraction));
  await tick();
  assert.equal(requested, 1, 'Submitting credentials must continue the original request rather than dispatching another navigation.');
  assert.equal(f.driver.tab(result.tabId).pendingInteraction, null);
});

test('an explicit navigation cancels a pending challenge before loading the user’s new address', async t => {
  const f = await fixture(t), callbacks = [], pending = f.login(f.tab, (...args) => callbacks.push(args));
  const result = await f.driver.perform({ action: 'navigate', tabId: f.tab.id, url: 'https://site.test/next' }, { source: 'user' });
  assert.equal(result.url, 'https://site.test/next'); assert.deepEqual(callbacks, [[]]);
  await assert.rejects(f.driver.setHostSurface(f.host, f.answer(pending)), { code: 'BROWSER_AUTHENTICATION_CHANGED' });
});

test('native callback errors consume credentials once and expose only a generic uncertain result', async t => {
  const f = await fixture(t); let calls = 0;
  const pending = f.login(f.tab, () => { calls++; throw Error('Never expose Synthetic password'); });
  await assert.rejects(f.driver.setHostSurface(f.host, f.answer(pending)), error => error.code === 'BROWSER_AUTHENTICATION_UNCERTAIN' && !error.message.includes('Synthetic'));
  await assert.rejects(f.driver.setHostSurface(f.host, f.answer(pending)), { code: 'BROWSER_AUTHENTICATION_CHANGED' });
  assert.equal(calls, 1); assert.equal(f.tab.pendingInteraction, null);
});
