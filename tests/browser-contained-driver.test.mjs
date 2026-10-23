import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { BrowserWorkspace, createBrowserToolHandler } from '../lib/browser.mjs';
import { BrowserRouter } from '../desktop/browser-router.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, { command = async () => ({}), loadURL = async () => {}, loadExtension = async () => ({ id: 'owned-compatibility-extension' }), limits = {}, closeError } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-contained-driver-')), windows = [], session = new EventEmitter(), extensionLoads = [];
  session.extensions = { loadExtension: (...args) => { extensionLoads.push(args); return loadExtension(...args); } };
  session.cookies = new EventEmitter(); session.webRequest = { onBeforeRequest(_filter, listener) { session.beforeRequest = listener || null; }, onCompleted() {}, onErrorOccurred() {} }; session.setPermissionRequestHandler = fn => { session.permissionRequest = fn; }; session.setPermissionCheckHandler = fn => { session.permissionCheck = fn; }; session.flushStorageData = async () => {};
  session.setDevicePermissionHandler = fn => { session.devicePermission = fn; }; session.setUSBProtectedClassesHandler = fn => { session.usbProtectedClasses = fn; };
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.visible = Boolean(options.show); this.destroyed = false; this.loads = []; this.protocol = []; windows.push(this);
      const contents = this.webContents = new EventEmitter(), debugger_ = contents.debugger = new EventEmitter(); debugger_.attached = false;
      debugger_.isAttached = () => debugger_.attached; debugger_.attach = () => { debugger_.attached = true; };
      debugger_.sendCommand = async (method, params, sessionId) => { this.protocol.push({ method, params, ...(sessionId ? { sessionId } : {}) }); return command(method, params, this, sessionId); };
      contents.isOffscreen = () => options.webPreferences?.offscreen === true;
      contents.isDestroyed = () => this.destroyed; contents.getURL = () => this.url || ''; contents.getTitle = () => 'Local fixture'; contents.isLoading = () => false;
      contents.isLoadingMainFrame = () => false;
      contents.executeJavaScript = async () => ({ width: options.width, height: options.height });
      contents.mainFrame = { processId: 1, routingId: 1, framesInSubtree: [], executeJavaScript: async () => ({ title: 'Local fixture', url: this.url, elements: [], text: 'Owned fixture page', readyState: 'complete' }) };
      contents.setWindowOpenHandler = fn => { contents.openHandler = fn; }; contents.loadURL = async url => { this.loads.push(url); await loadURL(url, this); this.url = url; };
      contents.capturePage = async (...args) => { this.captureArgs = args; return { isEmpty: () => false, getSize: () => ({ width: 1280, height: 900 }), toDataURL: () => 'data:image/png;base64,fixture' }; };
    }
    removeMenu() {} isDestroyed() { return this.destroyed; } isVisible() { return this.visible; } isFocusable() { return this.options.focusable !== false; }
    show() { assert.fail('A contained page must never show an operating-system window.'); }
    focus() { assert.fail('A contained page must never focus an operating-system window.'); }
    hide() { this.visible = false; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
  }
  // Exercise the actual driver with only Electron's native boundary replaced.
  // This is a dependency fixture, not a simulated passing browser integration.
  const sourceURL = new URL('../desktop/browser-driver.mjs', import.meta.url), key = '__containedFixture_' + randomUUID().replaceAll('-', '');
  let source = await readFile(sourceURL, 'utf8');
  source = source.replace("import { BrowserWindow, session } from 'electron';", `const {BrowserWindow,session}=globalThis[${JSON.stringify(key)}];`).replace(/from '(\.\.?\/[^']+)'/g, (_all, relative) => `from '${new URL(relative, sourceURL).href}'`);
  globalThis[key] = { BrowserWindow: Window, session: { fromPartition: name => { assert.equal(name, 'persist:relay-agent-browser-v2'); return session; }, get defaultSession() { assert.fail('The contained driver must not change the desktop shell session.'); } } };
  let ElectronBrowserDriver; try { ({ ElectronBrowserDriver } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))); } finally { delete globalThis[key]; }
  const driver = new ElectronBrowserDriver({ dataDir: directory, downloadDir: path.join(directory, 'downloads'), ...limits });
  t.after(async () => { if (closeError) await assert.rejects(driver.close(), closeError); else await driver.close(); assert.match(path.basename(directory), /^blackice-contained-driver-/); assert.equal(path.dirname(directory), path.resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  return { driver, windows, Window, session, directory, extensionLoads };
}
const assertContained = window => {
  assert.equal(window.options.show, false); assert.equal(window.options.focusable, false); assert.equal(window.options.skipTaskbar, true); assert.equal(window.options.fullscreenable, false);
  assert.equal(window.options.webPreferences.offscreen, true); assert.equal(window.options.webPreferences.paintWhenInitiallyHidden, true); assert.equal(window.options.webPreferences.backgroundThrottling, false); assert.equal(window.options.webPreferences.disableDialogs, false);
  assert.equal(window.options.webPreferences.nodeIntegration, false); assert.equal(window.options.webPreferences.contextIsolation, true); assert.equal(window.options.webPreferences.sandbox, true); assert.equal(window.visible, false);
  assert.equal(window.options.webPreferences.nodeIntegrationInSubFrames, undefined); assert.equal(window.options.webPreferences.preload, undefined);
};

test('a detached renderer ref preserves its message across a boundary that loses Error properties', async t => {
  const { driver } = await fixture(t), tab = driver.newTab('https://example.test/composer'); await tab.loading;
  const frame = tab.window.webContents.mainFrame, context = vm.createContext({ [driver.key]: { elements: new Map([['old-media', { isConnected: false }]]) } });
  frame.executeJavaScript = async code => {
    // Model a cross-process boundary that copies ordinary data but drops the
    // non-enumerable message of an uncaught renderer Error.
    try { return JSON.parse(JSON.stringify(await vm.runInContext(code, context))); }
    catch (cause) { throw JSON.parse(JSON.stringify(cause)); }
  };
  tab.refs.set('old-media', frame);
  const browser = new BrowserWorkspace({ driver }); t.after(() => browser.close());
  const result = await createBrowserToolHandler({ browser })({ name: 'relay_browser', arguments: { action: 'click', tabId: tab.id, ref: 'old-media' } });
  assert.equal(result.success, false); assert.equal(result.code, 'BROWSER_REF_STALE');
  assert.deepEqual(JSON.parse(result.contentItems[0].text), { error: 'This element ref is stale. Take a new snapshot and choose its current ref.', code: 'BROWSER_REF_STALE' });
  assert.equal(tab.window.protocol.some(item => item.method.startsWith('Input.')), false, 'A detached target must fail before browser input.');
  assert.equal(tab.window.captureArgs, undefined, 'A detached target must fail before pointer preparation.');
});

test('unexpected renderer failures retain their message without trusting a page-supplied no-effect claim', async t => {
  const { driver } = await fixture(t), tab = driver.newTab('https://example.test/composer'); await tab.loading;
  let scrolls = 0;
  const element = { isConnected: true, getAttribute: () => null, scrollIntoView: () => { scrolls++; }, getBoundingClientRect() { throw Object.assign(new Error('Layout changed after scrolling.'), { code: 'BROWSER_LAYOUT_FAILED', actionDispatched: false }); } };
  const frame = tab.window.webContents.mainFrame, context = vm.createContext({ [driver.key]: { elements: new Map([['media', element]]) } });
  frame.executeJavaScript = async code => {
    try { return JSON.parse(JSON.stringify(await vm.runInContext(code, context))); }
    catch (cause) { throw JSON.parse(JSON.stringify(cause)); }
  };
  tab.refs.set('media', frame);
  const browser = new BrowserWorkspace({ driver }); t.after(() => browser.close());
  const result = await createBrowserToolHandler({ browser })({ name: 'relay_browser', arguments: { action: 'click', tabId: tab.id, ref: 'media' } });
  assert.equal(result.success, false); assert.equal(result.code, 'BROWSER_LAYOUT_FAILED');
  assert.deepEqual(JSON.parse(result.contentItems[0].text), { error: 'Layout changed after scrolling.', code: 'BROWSER_LAYOUT_FAILED' });
  assert.equal(scrolls, 1, 'Renderer work has already changed the page before the error.');
});

test('the dedicated contained profile grants website capabilities for documents, subframes and workers', async t => {
  const { driver, session } = await fixture(t), tab = driver.newTab('https://example.test/');
  await tab.loading;
  assert.equal(tab.window.options.webPreferences.session, session);
  const contexts = [
    { contents: tab.window.webContents, origin: 'https://example.test', details: { requestingUrl: 'https://example.test/', isMainFrame: true } },
    { contents: tab.window.webContents, origin: 'https://identity.example.test', details: { requestingUrl: 'https://identity.example.test/signin', embeddingOrigin: 'https://example.test', isMainFrame: false } },
    { contents: null, origin: 'https://worker.example.test', details: { isMainFrame: false } },
  ];
  const permissions = ['notifications', 'geolocation', 'media', 'midiSysex', 'clipboard-read', 'clipboard-sanitized-write', 'display-capture', 'fileSystem', 'fullscreen', 'openExternal', 'storage-access', 'top-level-storage-access', 'local-network', 'loopback-network', 'persistent-storage', 'hid', 'serial', 'usb', 'unknown', 'future-browser-capability'];
  for (const { contents, origin, details } of contexts) for (const permission of permissions) {
    assert.equal(session.permissionCheck(contents, permission, origin, details), true, `check ${permission} for ${origin}`);
    const grants = [];
    session.permissionRequest(contents, permission, value => grants.push(value), details);
    assert.deepEqual(grants, [true], `request ${permission} for ${origin} must grant exactly once`);
  }
});

test('the contained profile grants device access and leaves no protected USB classes', async t => {
  const { session } = await fixture(t);
  for (const deviceType of ['hid', 'serial', 'usb']) {
    assert.equal(session.devicePermission({ deviceType, origin: 'https://device.example.test', device: { vendorId: 1, productId: 2 } }), true);
  }
  const protectedClasses = Object.freeze(['audio', 'audio-video', 'hid', 'mass-storage', 'smart-card', 'video', 'wireless']);
  assert.deepEqual(session.usbProtectedClasses({ protectedClasses }), []);
});

test('compatibility loads before direct tab navigation or input and popups cannot race its readiness', async t => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const { driver, windows, Window, extensionLoads } = await fixture(t, { loadExtension: () => pending });
  t.after(() => release({ id: 'owned-compatibility-extension' }));
  const tab = driver.newTab('https://signin.example.test/'), input = driver.cdp(tab, 'Input.insertText', { text: 'owned fixture' });
  await tick();
  assert.equal(extensionLoads.length, 1); assert.deepEqual(windows[0].loads, ['about:blank']); assert.deepEqual(windows[0].protocol, []);
  assert.equal(windows[0].webContents.openHandler({ url: 'https://signin.example.test/popup' }).action, 'deny');
  const premature = new Window(windows[0].options);
  assert.throws(() => driver.newTab('https://signin.example.test/popup', { window: premature }), { code: 'BROWSER_COMPATIBILITY_NOT_READY', actionDispatched: false });
  assert.equal(premature.destroyed, true); assert.equal(driver.tabs.size, 1);
  release({ id: 'owned-compatibility-extension' }); await tab.loading; await input;
  assert.deepEqual(windows[0].loads, ['about:blank', 'https://signin.example.test/']);
  assert.equal(windows[0].protocol.at(-1).method, 'Input.insertText');
  assert.equal(windows[0].webContents.openHandler({ url: 'https://signin.example.test/popup' }).action, 'allow');
  assertContained(windows[0]); assert.equal(extensionLoads.length, 1);
});

test('startup waits for compatibility before restoring metadata and resumes only afterward', async t => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const { driver, windows, directory } = await fixture(t, { loadExtension: () => pending });
  t.after(() => release({ id: 'owned-compatibility-extension' }));
  await writeFile(path.join(directory, 'browser-tabs.json'), JSON.stringify([{ url: 'https://saved.example.test/', title: 'Owned saved page' }]));
  let initialized = false; const initializedDriver = driver.init().then(() => { initialized = true; });
  await tick(); assert.equal(initialized, false); assert.equal(driver.tabs.size, 0); assert.equal(windows.length, 0);
  release({ id: 'owned-compatibility-extension' }); await initializedDriver;
  assert.equal(driver.tabs.size, 1); assert.equal(windows.length, 0);
  const result = await driver.perform({ action: 'read', tabId: driver.activeTab });
  assert.equal(result.url, 'https://saved.example.test/'); assert.deepEqual(windows[0].loads, ['about:blank', 'https://saved.example.test/']);
});

test('direct metadata resumption cannot bypass compatibility loading', async t => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const { driver, windows } = await fixture(t, { loadExtension: () => pending });
  t.after(() => release({ id: 'owned-compatibility-extension' }));
  const tab = driver.newTab('https://saved.example.test/', { restore: true });
  assert.equal(windows.length, 0);
  const result = driver.perform({ action: 'read', tabId: tab.id });
  await tick(); assert.deepEqual(windows[0].loads, ['about:blank']); assert.deepEqual(windows[0].protocol, []);
  release({ id: 'owned-compatibility-extension' }); assert.equal((await result).url, 'https://saved.example.test/');
  assert.deepEqual(windows[0].loads, ['about:blank', 'https://saved.example.test/']);
});

test('failed compatibility installation rejects startup, navigation, input and popups without a fallback or retry', async t => {
  const { driver, windows, extensionLoads } = await fixture(t, { loadExtension: async () => { throw new Error('Owned fixture extension load failure'); } });
  await assert.rejects(driver.init(), { code: 'BROWSER_COMPATIBILITY_UNAVAILABLE', actionDispatched: false });
  const tab = driver.newTab('https://signin.example.test/'); await tab.loading;
  assert.match(tab.loadError, /compatibility extension could not be loaded/);
  await assert.rejects(driver.perform({ action: 'navigate', tabId: tab.id, url: 'https://signin.example.test/second' }), { code: 'BROWSER_COMPATIBILITY_UNAVAILABLE', actionDispatched: false });
  await assert.rejects(driver.cdp(tab, 'Input.insertText', { text: 'owned fixture' }), { code: 'BROWSER_COMPATIBILITY_UNAVAILABLE', actionDispatched: false });
  assert.equal(windows[0].webContents.openHandler({ url: 'https://signin.example.test/popup' }).action, 'deny');
  assert.deepEqual(windows[0].loads, ['about:blank']); assert.deepEqual(windows[0].protocol, []); assert.equal(extensionLoads.length, 1);
  assertContained(windows[0]);
});

test('direct text enters the observed document through browser input without echoing its contents', async t => {
  const { driver, windows } = await fixture(t), tab = driver.newTab('https://signin.example.test/'); await tab.loading;
  const screenshot = await driver.perform({ action: 'screenshot', tabId: tab.id });
  const text = 'Iris+東京@example.test';
  const result = await driver.perform({ action: 'type', tabId: tab.id, expectedUrl: screenshot.url, expectedDocumentId: screenshot.documentId, text });
  assert.equal(screenshot.documentId, `${tab.id}:${tab.revision}`);
  assert.deepEqual(windows[0].protocol.at(-1), { method: 'Input.insertText', params: { text } });
  assert.deepEqual(result.receipt, { typed: true, characters: text.length, input: 'browser protocol' });
  assert.equal(result.documentId, screenshot.documentId); assert.doesNotMatch(JSON.stringify(result), /Iris|東京/);
  assertContained(windows[0]);
});

test('form edits and hover enforce supplied document identity before touching an observed ref', async t => {
  const { driver } = await fixture(t), tab = driver.newTab('https://careers.example.test/application'); await tab.loading;
  const effects = [], guards = [];
  driver.element = async (_tab, args, action) => { effects.push(action); return { frame: {}, result: action === 'fill' ? { filled: true } : action === 'select' ? { selected: args.value } : { x: 20, y: 20 } }; };
  driver.capture = async () => ({ retries: 0 });
  driver.browserPoint = async () => ({ x: 20, y: 20 });
  driver.pointerInput = async (_tab, _point, action, _signal, expected) => { guards.push(expected); effects.push(action); };
  const guard = { browser: 'relay', tabId: tab.id, expectedUrl: tab.url, expectedDocumentId: `${tab.id}:${tab.revision}` };
  for (const action of ['fill', 'select', 'hover']) {
    const request = { ...guard, action, ref: 'observed-field', ...(action === 'fill' ? { text: 'Owned draft' } : action === 'select' ? { value: 'choice' } : {}) };
    const before = effects.length;
    for (const changed of [{ expectedDocumentId: `${tab.id}:old` }, { expectedUrl: 'https://careers.example.test/other' }]) {
      await assert.rejects(driver.perform({ ...request, ...changed }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
      assert.equal(effects.length, before, 'A stale guard must fail before any renderer or pointer work.');
    }
    const result = await driver.perform(request);
    assert.ok(result.receipt);
    assert.ok(effects.length > before);
  }
  assert.equal(guards[0].expectedDocumentId, guard.expectedDocumentId);
  assert.equal(guards[0].expectedUrl, guard.expectedUrl);
  const { expectedDocumentId, expectedUrl, ...refOnly } = { ...guard, action: 'fill', ref: 'observed-field', text: 'Legacy draft' };
  assert.equal((await driver.perform(refOnly)).receipt.filled, true, 'Existing ref-only fills remain supported.');
});

test('a guarded contenteditable fill cannot insert text after its observed document changes', async t => {
  const { driver, windows } = await fixture(t), tab = driver.newTab('https://careers.example.test/application'); await tab.loading;
  const guard = { browser: 'relay', tabId: tab.id, expectedUrl: tab.url, expectedDocumentId: `${tab.id}:${tab.revision}` };
  driver.element = async () => { tab.revision++; return { result: { needsTrustedTextInput: true } }; };
  await assert.rejects(driver.perform({ ...guard, action: 'fill', ref: 'observed-editor', text: 'Owned draft' }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
  assert.equal(windows[0].protocol.filter(call => call.method === 'Input.insertText').length, 0);
});

test('guarded human preview clicks release the input queue without waiting or scanning the page', async t => {
  const { driver, windows } = await fixture(t), tab = driver.newTab('https://signin.example.test/'); await tab.loading;
  const browser = new BrowserWorkspace({ driver }); t.after(() => browser.close());
  const guard = { browser: 'relay', tabId: tab.id, expectedUrl: 'https://signin.example.test/', expectedDocumentId: `${tab.id}:${tab.revision}` };
  let viewportReads = 0, captures = 0, disposed = 0;
  windows[0].webContents.executeJavaScript = async () => { viewportReads++; return { width: 1280, height: 900 }; };
  const capture = driver.capture.bind(driver);
  driver.capture = async (...args) => { captures++; return capture(...args); };
  driver.watchNavigation = () => ({ wait: async () => assert.fail('Human input must not wait for navigation.'), dispose: () => { disposed++; } });
  driver.settle = async () => assert.fail('Human input must not wait for page settling.');
  driver.snapshot = async () => assert.fail('Human input must not scan the page.');
  const clicked = browser.perform({ action: 'click', ...guard, x: 100, y: 120 }, { source: 'user' });
  const typed = browser.perform({ action: 'type', ...guard, text: 'Owned input' }, { source: 'user' });
  const [result, textResult] = await Promise.all([clicked, typed]);
  assert.equal(result.frames, undefined); assert.equal(result.documentId, guard.expectedDocumentId);
  assert.deepEqual(result.receipt, { clicked: true, input: 'browser protocol' });
  assert.equal(textResult.receipt.typed, true); assert.equal(viewportReads, 1); assert.equal(captures, 1); assert.equal(disposed, 1);
  assert.deepEqual(windows[0].captureArgs, [undefined, { stayHidden: true }]);
  assert.deepEqual(windows[0].protocol.filter(call => call.method.startsWith('Input.')).map(call => call.params.type || call.method), ['mouseMoved', 'mousePressed', 'mouseReleased', 'Input.insertText']);
  assertContained(windows[0]);
});

test('guarded wheel input crosses the real workspace and router with both axes and no DOM scan', async t => {
  let release, scrolling;
  const pending = new Promise(resolve => { release = resolve; });
  const { driver, windows } = await fixture(t, { command: async (method, params) => {
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseWheel') { scrolling = true; await pending; }
    return {};
  } });
  t.after(() => release());
  const tab = driver.newTab('https://example.test/'); await tab.loading;
  const browser = new BrowserWorkspace({ driver: new BrowserRouter({ independent: driver }) }); t.after(() => browser.close());
  const guard = { browser: 'relay', tabId: tab.id, expectedUrl: 'https://example.test/', expectedDocumentId: `${tab.id}:${tab.revision}` };
  driver.settle = async () => assert.fail('Wheel input must not wait for page settling.');
  driver.snapshot = async () => assert.fail('Wheel input must not scan the page.');
  const wheel = browser.perform({ action: 'scroll', ...guard, x: 340.5, y: 190.25, deltaX: -32.5, deltaY: 180.75 }, { source: 'user' });
  const typed = browser.perform({ action: 'type', ...guard, text: 'next input' }, { source: 'user' });
  for (let index = 0; index < 20 && !scrolling; index++) await tick();
  assert.equal(scrolling, true);
  assert.equal(windows[0].protocol.some(call => call.method === 'Input.insertText'), false, 'later input waits for the wheel receipt');
  release();
  const [result, typedResult] = await Promise.all([wheel, typed]);
  assert.equal(result.documentId, guard.expectedDocumentId); assert.equal(result.url, guard.expectedUrl); assert.equal(result.tabId, tab.id);
  assert.deepEqual(result.receipt, { scrolled: true, deltaX: -32.5, deltaY: 180.75, input: 'browser protocol' });
  assert.equal(result.frames, undefined); assert.equal(typedResult.receipt.typed, true);
  assert.deepEqual(windows[0].protocol.filter(call => call.method.startsWith('Input.')), [
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 340.5, y: 190.25, button: 'none' } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: 340.5, y: 190.25, deltaX: -32.5, deltaY: 180.75, button: 'none' } },
    { method: 'Input.insertText', params: { text: 'next input' } },
  ]);
  assertContained(windows[0]);
});

test('wheel input rejects an outdated document or a pointer outside its viewport before dispatch', async t => {
  const { driver, windows } = await fixture(t), tab = driver.newTab('https://example.test/'); await tab.loading;
  const wheel = { action: 'scroll', browser: 'relay', tabId: tab.id, x: 120, y: 90, deltaX: 0, deltaY: 120, expectedUrl: 'https://example.test/', expectedDocumentId: `${tab.id}:${tab.revision}` };
  await assert.rejects(driver.perform({ ...wheel, x: 1280 }), { code: 'BROWSER_VALIDATION', actionDispatched: false });
  await assert.rejects(driver.perform({ ...wheel, y: 900 }), { code: 'BROWSER_VALIDATION', actionDispatched: false });
  await assert.rejects(driver.perform({ ...wheel, expectedDocumentId: tab.id + ':old' }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED', actionDispatched: false });
  windows[0].webContents.executeJavaScript = async () => { tab.revision++; return { width: 1280, height: 900 }; };
  await assert.rejects(driver.perform(wheel), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
  assert.equal(windows[0].protocol.some(call => call.method.startsWith('Input.')), false);
});

test('cancelled wheel viewport work never dispatches native input later', async t => {
  const { driver, windows } = await fixture(t), tab = driver.newTab('https://example.test/'); await tab.loading;
  const wheel = { action: 'scroll', browser: 'relay', tabId: tab.id, x: 120, y: 90, deltaX: 0, deltaY: 120, expectedUrl: 'https://example.test/', expectedDocumentId: tab.id + ':' + tab.revision };
  const controller = new AbortController(); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const viewport = new Promise(resolve => { release = resolve; });
  windows[0].webContents.executeJavaScript = async () => { entered(); return viewport; };
  const result = driver.perform(wheel, { source: 'user', signal: controller.signal });
  const rejected = assert.rejects(result, { name: 'AbortError' });
  await ready; controller.abort(); await rejected;
  release({ width: 1280, height: 900 }); await tick();
  assert.equal(windows[0].protocol.some(call => call.method.startsWith('Input.')), false);
});

test('agent, unguarded, and reference clicks retain their post-action page inspection', async t => {
  const { driver, windows } = await fixture(t), tab = driver.newTab('https://example.test/'); await tab.loading;
  const guard = { tabId: tab.id, expectedUrl: 'https://example.test/', expectedDocumentId: `${tab.id}:${tab.revision}` };
  windows[0].webContents.executeJavaScript = async () => ({ width: 1280, height: 900 });
  let waits = 0, settles = 0, snapshots = 0, disposed = 0;
  driver.watchNavigation = () => ({ wait: async () => { waits++; }, dispose: () => { disposed++; } });
  driver.settle = async () => { settles++; };
  driver.snapshot = async () => { snapshots++; return { frames: [{ text: 'Observed after the click' }] }; };
  driver.element = async () => ({ frame: windows[0].webContents.mainFrame, result: { x: 100, y: 120 } });
  driver.browserPoint = async (_tab, _frame, point) => point;
  for (const [args, options] of [
    [{ action: 'click', ...guard, x: 100, y: 120 }, { source: 'agent' }],
    [{ action: 'click', tabId: tab.id, x: 100, y: 120 }, { source: 'user' }],
    [{ action: 'click', ...guard, ref: 'observed-control' }, { source: 'user' }],
  ]) {
    const result = await driver.perform(args, options);
    assert.deepEqual(result.frames, [{ text: 'Observed after the click' }]);
    assert.ok(result.receipt.clicked); assert.ok(Array.isArray(result.tabs));
  }
  assert.equal(waits, 3); assert.equal(settles, 3); assert.equal(snapshots, 3); assert.equal(disposed, 3);
});

test('guarded human clicks reject a stale document before input and after capture', async t => {
  const { driver, windows } = await fixture(t), tab = driver.newTab('https://signin.example.test/'); await tab.loading;
  windows[0].webContents.executeJavaScript = async () => ({ width: 1280, height: 900 });
  const args = { action: 'click', tabId: tab.id, expectedUrl: 'https://signin.example.test/', expectedDocumentId: `${tab.id}:${tab.revision}`, x: 100, y: 120 };
  tab.revision++;
  await assert.rejects(driver.perform(args, { source: 'user' }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
  assert.equal(windows[0].captureArgs, undefined);
  args.expectedDocumentId = `${tab.id}:${tab.revision}`;
  const capture = driver.capture.bind(driver);
  driver.capture = async (...values) => { const result = await capture(...values); tab.window.webContents.emit('did-frame-navigate', {}, args.expectedUrl, 200, 'OK', true, 1, 1); return result; };
  await assert.rejects(driver.perform(args, { source: 'user' }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
  assert.equal(windows[0].protocol.some(call => call.method.startsWith('Input.')), false);
  assert.equal(windows[0].webContents.listenerCount('did-start-navigation'), 0);
});

test('a modal-paused human click releases its button and reports the interaction without replay', async t => {
  let release, presses = 0;
  const held = new Promise(resolve => { release = resolve; });
  const { driver, windows } = await fixture(t, { command: async (method, params, window) => {
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
      presses++;
      window.webContents.debugger.emit('message', {}, 'Page.javascriptDialogOpening', { hasBrowserHandler: false, type: 'confirm', message: 'Owned paused confirm' });
      return held;
    }
    return {};
  } });
  const tab = driver.newTab('https://example.test/'); await tab.loading;
  windows[0].webContents.executeJavaScript = async () => ({ width: 1280, height: 900 });
  const args = { action: 'click', tabId: tab.id, expectedUrl: 'https://example.test/', expectedDocumentId: `${tab.id}:${tab.revision}`, x: 100, y: 120 };
  driver.settle = async () => assert.fail('A pending dialog must not settle the page.');
  driver.snapshot = async () => assert.fail('A pending dialog must not scan the page.');
  const result = await driver.perform(args, { source: 'user' });
  assert.equal(result.pendingInteraction.status, 'pending'); assert.equal(result.actionDispatched, true); assert.equal(result.inspectBeforeContinuing, true);
  assert.equal(tab.suspendedWork.size, 1); assert.equal(presses, 1);
  assert.deepEqual(windows[0].protocol.filter(call => call.method === 'Input.dispatchMouseEvent').map(call => call.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.equal(windows[0].webContents.listenerCount('did-start-navigation'), 0);
  const blocked = await driver.perform(args, { source: 'user' });
  assert.equal(blocked.actionDispatched, false); assert.equal(presses, 1);
  release({}); await tick(); assert.equal(tab.suspendedWork.size, 0);
});

test('direct input rejects a changed URL or a same-URL replacement document', async t => {
  const { driver, windows } = await fixture(t), tab = driver.newTab('https://signin.example.test/'); await tab.loading;
  const expected = { expectedUrl: 'https://signin.example.test/', expectedDocumentId: `${tab.id}:${tab.revision}` };
  tab.revision++;
  await assert.rejects(driver.perform({ action: 'type', tabId: tab.id, ...expected, text: 'must not arrive' }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
  expected.expectedDocumentId = `${tab.id}:${tab.revision}`; tab.window.url = 'https://elsewhere.example.test/';
  await assert.rejects(driver.perform({ action: 'press', tabId: tab.id, ...expected, key: 'Enter' }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
  assert.equal(windows[0].protocol.some(item => item.method.startsWith('Input.')), false);
});

test('document identity is checked again after the asynchronous containment guard', async t => {
  const { driver, windows } = await fixture(t), tab = driver.newTab('https://signin.example.test/'); await tab.loading;
  const expected = { expectedUrl: 'https://signin.example.test/', expectedDocumentId: `${tab.id}:${tab.revision}` };
  let guards = 0; const ensure = driver.ensureContained.bind(driver);
  driver.ensureContained = async (...args) => { await ensure(...args); if (++guards === 2) tab.revision++; };
  await assert.rejects(driver.perform({ action: 'type', tabId: tab.id, ...expected, text: 'must not arrive' }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
  assert.equal(windows[0].protocol.some(item => item.method === 'Input.insertText'), false);
});

test('cancellation after the containment guard does not dispatch a final text insertion', async t => {
  const { driver, windows } = await fixture(t), tab = driver.newTab('https://signin.example.test/'); await tab.loading;
  const controller = new AbortController(), expected = { expectedUrl: 'https://signin.example.test/', expectedDocumentId: `${tab.id}:${tab.revision}` };
  let guards = 0; const ensure = driver.ensureContained.bind(driver);
  driver.ensureContained = async (...args) => { await ensure(...args); if (++guards === 2) controller.abort(); };
  await assert.rejects(driver.perform({ action: 'type', tabId: tab.id, ...expected, text: 'must not arrive' }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(windows[0].protocol.some(item => item.method === 'Input.insertText'), false);
});

test('a same-URL replacement after capture cannot give old preview pixels a new document token', async t => {
  const { driver } = await fixture(t), tab = driver.newTab('https://signin.example.test/'); await tab.loading;
  const capture = driver.capture.bind(driver);
  driver.capture = async (...args) => { const result = await capture(...args); tab.revision++; return result; };
  await assert.rejects(driver.perform({ action: 'screenshot', tabId: tab.id }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
});

test('editing keys retain modifiers and release keys without scanning a password field', async t => {
  const { driver, windows } = await fixture(t), tab = driver.newTab('https://signin.example.test/'); await tab.loading;
  const expected = { expectedUrl: 'https://signin.example.test/', expectedDocumentId: `${tab.id}:${tab.revision}` };
  for (const [key, modifiers, mask] of [['Tab', ['Shift'], 8], ['a', ['Control'], 2], ['Backspace', [], 0], ['Delete', ['Control'], 2], ['Home', ['Shift', 'Control'], 10]]) {
    const result = await driver.perform({ action: 'press', tabId: tab.id, ...expected, key, modifiers });
    const calls = windows[0].protocol.slice(-2);
    assert.deepEqual(calls.map(item => item.params.type), ['keyDown', 'keyUp']);
    assert.ok(calls.every(item => item.method === 'Input.dispatchKeyEvent' && item.params.modifiers === mask));
    assert.equal(result.frames, undefined); assert.equal(result.documentId, expected.expectedDocumentId);
  }
  const count = windows[0].protocol.length;
  for (const value of [{ key: 'a' }, { key: 'v', modifiers: ['Control'] }, { key: '__proto__' }, { key: 'Tab', modifiers: ['Control', 'Control'] }]) await assert.rejects(driver.perform({ action: 'press', tabId: tab.id, ...expected, ...value }));
  assert.equal(windows[0].protocol.length, count); assertContained(windows[0]);
});

test('actual driver pages and captures remain offscreen, nonfocusable and outside the taskbar', async t => {
  const { driver, windows } = await fixture(t), tab = driver.newTab('https://example.test/'); await tab.loading; assertContained(windows[0]);
  const image = await driver.perform({ action: 'screenshot', tabId: tab.id }); assert.equal(image.imageUrl, 'data:image/png;base64,fixture'); assert.deepEqual(windows[0].captureArgs, [undefined, { stayHidden: true }]);
  const status = driver.status(); assert.equal(status.contained, true); assert.equal(status.canShow, false); assert.equal(status.tabs[0].contained, true); assert.equal(status.tabs[0].canShow, false); assert.equal(status.tabs[0].visible, false);
});

test('protected credential capture restrictions survive SPA and child navigation until a real main-frame replacement', async t => {
  const { driver } = await fixture(t), tab = driver.newTab('https://example.test/'); await tab.loading;
  tab.credentialCaptureBlocked = true;
  tab.window.webContents.emit('did-navigate-in-page', {}, 'https://example.test/#same-document', true, 1, 1);
  assert.equal(tab.credentialCaptureBlocked, true);
  tab.window.webContents.emit('did-frame-navigate', {}, 'https://example.test/child', 200, 'OK', false, 1, 2);
  assert.equal(tab.credentialCaptureBlocked, true);
  tab.window.webContents.emit('did-frame-navigate', {}, 'https://example.test/new-document', 200, 'OK', true, 1, 1);
  assert.equal(tab.credentialCaptureBlocked, false);
});

test('show refuses before creating any page and after an existing contained page has loaded', async t => {
  const { driver, windows } = await fixture(t); await assert.rejects(driver.show(), cause => cause.code === 'BROWSER_CONTAINED' && /Observe/.test(cause.message)); assert.equal(windows.length, 0);
  const tab = driver.newTab('https://example.test/'); await tab.loading; await assert.rejects(driver.show(tab.id), { code: 'BROWSER_CONTAINED' }); assert.equal(windows.length, 1); assertContained(windows[0]);
});

test('OAuth popups inherit the exact contained policy and are adopted without a visible path', async t => {
  const { driver, windows, Window } = await fixture(t), parent = driver.newTab('https://example.test/'); await parent.loading;
  const response = parent.window.webContents.openHandler({ url: 'https://example.test/oauth', features: 'show=yes,fullscreen=yes' }); assert.equal(response.action, 'allow');
  const child = new Window(response.overrideBrowserWindowOptions); assertContained(child); assert.equal(child.options.webPreferences.session, parent.window.options.webPreferences.session);
  parent.window.webContents.emit('did-create-window', child, { url: 'https://example.test/oauth' }); await tick(); assert.equal(driver.tabs.size, 2); assert.equal(windows.length, 2); assert.equal(driver.tab(driver.activeTab).window, child);
  for (const window of windows) assertContained(window);
  assert.equal(child.webContents.openHandler({ url: 'file:///C:/private' }).action, 'deny');
});

async function popupViewportFixture(t, { viewport = { width: 0, height: 0 }, contentSize = [1281, 824], command = async () => {}, readViewport = async () => {}, captureAvailable = true } = {}) {
  const state = { viewport: { ...viewport }, emulated: false, events: [], reads: 0, captures: 0, snapshots: 0, prepares: 0 };
  const f = await fixture(t, { command: async (method, params, window) => {
    if (window !== state.window) return {};
    state.events.push(method);
    if (method === 'Emulation.setDeviceMetricsOverride') { state.viewport = { width: params.width, height: params.height }; state.emulated = true; }
    await command(method, params, state);
    if (method === 'Emulation.clearDeviceMetricsOverride') state.emulated = false;
    return {};
  } });
  const parent = f.driver.newTab('https://parent.example.test/'); await parent.loading;
  const options = parent.window.webContents.openHandler({ url: 'https://identity.example.test/' }).overrideBrowserWindowOptions;
  const window = state.window = new f.Window(options), wc = window.webContents;
  window.url = 'https://identity.example.test/'; window.getContentSize = () => contentSize;
  wc.executeJavaScript = async expression => {
    assert.equal(expression, '({width:innerWidth,height:innerHeight})');
    state.reads++; state.events.push('viewport');
    const value = { ...state.viewport }; await readViewport(state); return value;
  };
  wc.mainFrame.executeJavaScript = async code => {
    assert.equal(state.emulated, false, 'Temporary metrics must be cleared before inspecting or preparing the page.');
    assert.ok(state.viewport.width > 0 && state.viewport.height > 0, 'Page geometry must be initialized first.');
    if (code.includes('function pageSnapshot(')) {
      state.snapshots++; state.events.push('snapshot');
      return { title: 'Popup fixture', url: window.url, elements: [{ ref: 'complete', name: 'Complete fixture sign-in' }], text: 'Identity ready', readyState: 'complete' };
    }
    assert.ok(code.includes('function elementActionResult('));
    state.prepares++; state.events.push('prepare');
    return { x: state.viewport.width / 2, y: state.viewport.height / 2, viewportWidth: state.viewport.width, viewportHeight: state.viewport.height };
  };
  wc.capturePage = async (_rect, options) => {
    assert.deepEqual(options, { stayHidden: true }); assert.equal(state.emulated, false);
    state.captures++; state.events.push('capture');
    const valid = captureAvailable && state.viewport.width > 0 && state.viewport.height > 0;
    return { isEmpty: () => !valid, getSize: () => valid ? { ...state.viewport } : { width: 0, height: 0 }, toDataURL: () => 'data:image/png;base64,popup' };
  };
  parent.window.webContents.emit('did-create-window', window, { url: window.url }); await tick();
  const tab = [...f.driver.tabs.values()].find(tab => tab.window === window);
  assert.ok(tab); Object.assign(state, f, { parent, tab, wc });
  state.guard = { tabId: tab.id, expectedUrl: window.url, expectedDocumentId: `${tab.id}:${tab.revision}` };
  return state;
}

test('a zero-sized adopted popup is initialized and reset before snapshot, pointer preparation and native capture', async t => {
  const f = await popupViewportFixture(t), window = f.tab.window, wc = window.webContents;
  const snapshot = await f.driver.perform({ action: 'snapshot', tabId: f.tab.id });
  assert.equal(snapshot.frames[0].elements[0].ref, 'complete');
  await f.driver.perform({ action: 'click', ...f.guard, ref: 'complete' });
  const preview = await f.driver.perform({ action: 'screenshot', tabId: f.tab.id });
  assert.equal(preview.width, 1281); assert.equal(preview.height, 824);
  assert.deepEqual(f.window.protocol.filter(call => call.method.startsWith('Emulation.')), [
    { method: 'Emulation.setDeviceMetricsOverride', params: { width: 1281, height: 824, deviceScaleFactor: 0, mobile: false, dontSetVisibleSize: false } },
    { method: 'Emulation.clearDeviceMetricsOverride', params: undefined },
  ]);
  assert.ok(f.events.indexOf('Emulation.clearDeviceMetricsOverride') < f.events.indexOf('snapshot'));
  assert.ok(f.events.indexOf('snapshot') < f.events.indexOf('prepare'));
  assert.ok(f.events.indexOf('prepare') < f.events.indexOf('capture'));
  const inputs = f.window.protocol.filter(call => call.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(inputs.map(call => call.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.ok(inputs.every(call => call.params.x === 640.5 && call.params.y === 412));
  assert.equal(f.prepares, 1); assert.equal(f.reads, 2, 'Subsequent actions must reuse the completed initialization.');
  assert.equal(f.tab.window, window); assert.equal(f.tab.window.webContents, wc);
  assert.equal(f.tab.parentTabId, f.parent.id); assert.equal(f.window.options.webPreferences.session, f.parent.window.options.webPreferences.session);
  assert.deepEqual(f.window.loads, [], 'The original native popup must not be replaced or navigated again.');
  assertContained(f.window);
});

test('ordinary windows and already-sized adopted popups do not receive device emulation', async t => {
  const f = await popupViewportFixture(t, { viewport: { width: 1280, height: 900 } });
  f.parent.window.webContents.executeJavaScript = () => assert.fail('Ordinary pages must not enter popup viewport initialization.');
  await f.driver.perform({ action: 'snapshot', tabId: f.parent.id });
  await f.driver.perform({ action: 'snapshot', tabId: f.tab.id });
  await f.driver.perform({ action: 'screenshot', tabId: f.tab.id });
  assert.equal(f.reads, 1); assert.equal(f.emulated, false);
  assert.equal(f.windows.some(window => window.protocol.some(call => call.method.startsWith('Emulation.'))), false);
});

test('an explicit popup navigation initializes before its first resulting snapshot', async t => {
  const f = await popupViewportFixture(t);
  const result = await f.driver.perform({ action: 'navigate', tabId: f.tab.id, url: 'https://identity.example.test/next' });
  assert.equal(result.url, 'https://identity.example.test/next');
  assert.deepEqual(f.window.loads, ['https://identity.example.test/next']);
  assert.ok(f.events.indexOf('Emulation.clearDeviceMetricsOverride') < f.events.indexOf('snapshot'));
});

test('popup viewport initialization still requires a real native frame before pointer input', async t => {
  const f = await popupViewportFixture(t, { captureAvailable: false });
  await f.driver.perform({ action: 'snapshot', tabId: f.tab.id });
  await assert.rejects(f.driver.perform({ action: 'click', ...f.guard, ref: 'complete' }), { code: 'BROWSER_CAPTURE_UNAVAILABLE' });
  assert.equal(f.captures, 3); assert.equal(f.prepares, 1);
  assert.equal(f.window.protocol.some(call => call.method.startsWith('Input.')), false);
});

test('Stop during popup viewport initialization clears metrics without dispatching the requested input', async t => {
  const controller = new AbortController();
  const f = await popupViewportFixture(t, { command: async method => { if (method === 'Emulation.setDeviceMetricsOverride') controller.abort(); } });
  await assert.rejects(f.driver.perform({ action: 'type', ...f.guard, text: 'Must not arrive' }, { signal: controller.signal }), { name: 'AbortError' });
  await tick();
  assert.equal(f.emulated, false); assert.equal(f.tab.popupViewport.resetRequired, false);
  assert.equal(f.window.protocol.filter(call => call.method === 'Emulation.clearDeviceMetricsOverride').length, 1);
  assert.equal(f.window.protocol.some(call => call.method.startsWith('Input.')), false);
  assert.equal(f.snapshots, 0); assert.equal(f.captures, 0);
  await f.driver.perform({ action: 'snapshot', tabId: f.tab.id });
  assert.equal(f.window.protocol.filter(call => call.method === 'Emulation.setDeviceMetricsOverride').length, 1, 'A later explicit read must not repeat the successful resize.');
});

test('document replacement during popup initialization rejects stale input after clearing metrics', async t => {
  for (const stage of ['viewport', 'set', 'clear']) await t.test(stage, async t => {
    let changed = false;
    const replace = state => { if (!changed) { changed = true; state.tab.revision++; } };
    const f = await popupViewportFixture(t, {
      readViewport: async state => { if (stage === 'viewport') replace(state); },
      command: async (method, _params, state) => { if (method === `Emulation.${stage === 'set' ? 'setDeviceMetricsOverride' : 'clearDeviceMetricsOverride'}` && stage !== 'viewport') replace(state); },
    });
    await assert.rejects(f.driver.perform({ action: 'type', ...f.guard, text: 'Must not arrive' }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
    assert.equal(f.emulated, false); assert.equal(f.window.protocol.some(call => call.method.startsWith('Input.')), false);
    assert.equal(f.snapshots, 0); assert.equal(f.captures, 0);
    assert.equal(f.window.protocol.filter(call => call.method === 'Emulation.setDeviceMetricsOverride').length, stage === 'viewport' ? 0 : 1);
  });
});

test('a failed popup metrics acknowledgment is cleared and surfaced without input replay', async t => {
  const failure = Object.assign(Error('Owned uncertain metrics response'), { code: 'FIXTURE_METRICS_FAILED' });
  const f = await popupViewportFixture(t, { command: async method => { if (method === 'Emulation.setDeviceMetricsOverride') throw failure; } });
  await assert.rejects(f.driver.perform({ action: 'type', ...f.guard, text: 'Must not arrive' }), failure);
  assert.equal(f.emulated, false); assert.equal(f.tab.popupViewport.ready, false);
  assert.equal(f.window.protocol.filter(call => call.method === 'Emulation.clearDeviceMetricsOverride').length, 1);
  assert.equal(f.window.protocol.some(call => call.method.startsWith('Input.')), false);
});

test('an unconfirmed popup metrics reset prevents continuation and is cleared before a later explicit read', async t => {
  let failClear = true;
  const f = await popupViewportFixture(t, { command: async method => { if (method === 'Emulation.clearDeviceMetricsOverride' && failClear) throw Error('Owned reset failure'); } });
  await assert.rejects(f.driver.perform({ action: 'type', ...f.guard, text: 'Must not arrive' }), /Owned reset failure/);
  assert.equal(f.emulated, true); assert.equal(f.tab.popupViewport.ready, false); assert.equal(f.tab.popupViewport.resetRequired, true);
  assert.equal(f.window.protocol.some(call => call.method.startsWith('Input.')), false);
  const reads = f.reads; failClear = false;
  await f.driver.perform({ action: 'snapshot', tabId: f.tab.id });
  assert.equal(f.emulated, false); assert.equal(f.tab.popupViewport.resetRequired, false);
  assert.equal(f.reads, reads + 1); assert.equal(f.window.protocol.filter(call => call.method === 'Emulation.setDeviceMetricsOverride').length, 1);
  assert.equal(f.window.protocol.filter(call => call.method === 'Emulation.clearDeviceMetricsOverride').length, 2);
});

test('debugger detachment during popup initialization cannot reattach or admit the interrupted input', async t => {
  let detach = true;
  const f = await popupViewportFixture(t, { command: async (method, _params, state) => {
    if (method === 'Emulation.setDeviceMetricsOverride' && detach) { detach = false; state.wc.debugger.attached = false; state.wc.debugger.emit('detach'); }
  } });
  await assert.rejects(f.driver.perform({ action: 'type', ...f.guard, text: 'Must not arrive' }), { code: 'BROWSER_CONTAINMENT_LOST' });
  assert.equal(f.wc.debugger.isAttached(), false); assert.equal(f.tab.containmentReady, null);
  assert.equal(f.window.protocol.some(call => call.method.startsWith('Input.')), false);
  assert.equal(f.tab.popupViewport.resetRequired, true);
  await f.driver.perform({ action: 'snapshot', tabId: f.tab.id });
  assert.equal(f.wc.debugger.isAttached(), true); assert.equal(f.emulated, false);
  assert.equal(f.window.protocol.filter(call => call.method === 'Emulation.setDeviceMetricsOverride').length, 1);
});

test('popup close during initialization prevents page work and input on a replacement target', async t => {
  const f = await popupViewportFixture(t, { command: async (method, _params, state) => { if (method === 'Emulation.setDeviceMetricsOverride') state.window.destroy(); } });
  await assert.rejects(f.driver.perform({ action: 'type', ...f.guard, text: 'Must not arrive' }), { code: 'BROWSER_CLOSED' });
  assert.equal(f.window.destroyed, true); assert.equal(f.driver.tabs.has(f.tab.id), false);
  assert.equal(f.window.protocol.some(call => call.method.startsWith('Input.')), false);
  assert.equal(f.snapshots, 0); assert.equal(f.windows.length, 2);
});

test('popup initialization rejects unusable native sizes and a viewport that remains empty after reset', async t => {
  await t.test('native size', async t => {
    const f = await popupViewportFixture(t, { contentSize: [0, 824] });
    await assert.rejects(f.driver.perform({ action: 'snapshot', tabId: f.tab.id }), { code: 'BROWSER_VIEWPORT_UNAVAILABLE' });
    assert.equal(f.window.protocol.some(call => call.method.startsWith('Emulation.')), false); assert.equal(f.snapshots, 0);
  });
  await t.test('empty after reset', async t => {
    const f = await popupViewportFixture(t, { command: async (method, _params, state) => { if (method === 'Emulation.clearDeviceMetricsOverride') state.viewport = { width: 0, height: 0 }; } });
    await assert.rejects(f.driver.perform({ action: 'type', ...f.guard, text: 'Must not arrive' }), { code: 'BROWSER_VIEWPORT_UNAVAILABLE' });
    assert.equal(f.emulated, false); assert.equal(f.window.protocol.some(call => call.method.startsWith('Input.')), false); assert.equal(f.snapshots, 0);
  });
});

test('an unexpectedly visible, focusable or non-offscreen popup is destroyed instead of adopted', async t => {
  const { driver, Window } = await fixture(t), parent = driver.newTab('https://example.test/'); await parent.loading;
  for (const overrides of [{ show: true }, { focusable: true }, { webPreferences: { offscreen: false } }]) {
    const safe = parent.window.webContents.openHandler({ url: 'https://example.test/oauth' }).overrideBrowserWindowOptions, child = new Window({ ...safe, ...overrides });
    assert.doesNotThrow(() => parent.window.webContents.emit('did-create-window', child, { url: 'https://example.test/oauth' })); assert.equal(child.destroyed, true); assert.equal(driver.tabs.size, 1);
  }
});

test('native file pickers are intercepted before navigation or trusted input, including debugger reattachment', async t => {
  let release; const pending = new Promise(resolve => { release = resolve; }); let first = true;
  const { driver, windows } = await fixture(t, { command: async method => { if (method === 'Page.setInterceptFileChooserDialog' && first) { first = false; await pending; } return {}; } });
  const tab = driver.newTab('https://example.test/'), input = driver.cdp(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed' }); await tick();
  assert.deepEqual(windows[0].loads, ['about:blank']); assert.deepEqual(windows[0].protocol.map(call => call.method), ['Page.enable', 'Page.setInterceptFileChooserDialog']); release(); await tab.loading; await input;
  assert.deepEqual(windows[0].loads, ['about:blank', 'https://example.test/']);
  const debug = windows[0].webContents.debugger; debug.attached = false; debug.emit('detach'); await driver.cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyDown' });
  assert.deepEqual(windows[0].protocol.map(call => call.method), ['Page.enable', 'Page.setInterceptFileChooserDialog', 'Input.dispatchMouseEvent', 'Page.enable', 'Page.setInterceptFileChooserDialog', 'Input.dispatchKeyEvent']);
  debug.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 42 }); await tick();
  const chooser = driver.status().tabs[0].pendingInteraction;
  assert.equal(chooser.kind, 'file_chooser'); assert.equal(chooser.status, 'pending'); assert.equal(chooser.backendNodeId, undefined);
  assert.equal(windows[0].protocol.some(item => item.method === 'DOM.setFileInputFiles'), false, 'opening the picker must not silently clear a selection');
  await driver.perform({ action: 'interaction', tabId: tab.id, interactionId: chooser.id, expectedUrl: chooser.url, expectedDocumentId: chooser.documentId, decision: 'dismiss' }, { source: 'user' });
  assert.deepEqual(windows[0].protocol.at(-1), { method: 'DOM.setFileInputFiles', params: { files: [], backendNodeId: 42 } }); assert.equal(tab.pendingInteraction, null); assertContained(windows[0]);
});

test('renderer startup finishes on inert blank before protocol guards, website navigation or trusted input', async t => {
  let release; const renderer = new Promise(resolve => { release = resolve; });
  const { driver, windows } = await fixture(t, { loadURL: url => url === 'about:blank' ? renderer : Promise.resolve() });
  const tab = driver.newTab('https://example.test/'), input = driver.cdp(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed' });
  await tick(); assert.deepEqual(windows[0].loads, ['about:blank']); assert.deepEqual(windows[0].protocol, []); assert.equal(driver.status().tabs[0].url, 'https://example.test/');
  release(); await tab.loading; await input;
  assert.deepEqual(windows[0].loads, ['about:blank', 'https://example.test/']); assert.deepEqual(windows[0].protocol.map(call => call.method), ['Page.enable', 'Page.setInterceptFileChooserDialog', 'Input.dispatchMouseEvent']);
});

test('a detach while the input guard resumes rejects without reconnecting or sending input; explicit retry rearms', async t => {
  const { driver, windows } = await fixture(t), tab = driver.newTab('https://example.test/'); await tab.loading;
  const debug = windows[0].webContents.debugger, ensure = driver.ensureContained.bind(driver); let detach = true;
  driver.ensureContained = async (...args) => {
    await ensure(...args);
    if (detach) { detach = false; debug.attached = false; debug.emit('detach'); }
  };
  await assert.rejects(driver.cdp(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed' }), { code: 'BROWSER_CONTAINMENT_LOST' });
  assert.equal(debug.isAttached(), false, 'the interrupted call must not reconnect as a fallback');
  assert.equal(tab.containmentReady, null); assert.deepEqual(windows[0].protocol.map(call => call.method), ['Page.enable', 'Page.setInterceptFileChooserDialog']);
  await driver.cdp(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed' });
  assert.deepEqual(windows[0].protocol.map(call => call.method), ['Page.enable', 'Page.setInterceptFileChooserDialog', 'Page.enable', 'Page.setInterceptFileChooserDialog', 'Input.dispatchMouseEvent']);
});

test('a failed native-picker guard prevents navigation and trusted input without showing a fallback', async t => {
  const { driver, windows } = await fixture(t, { command: async method => { if (method === 'Page.setInterceptFileChooserDialog') throw Error('Unavailable fixture protocol'); return {}; } });
  const tab = driver.newTab('https://example.test/'); await tab.loading; await assert.rejects(driver.cdp(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed' }), /disable native file dialogs/);
  assert.deepEqual(windows[0].loads, ['about:blank']); assert.equal(windows[0].protocol.some(call => call.method.startsWith('Input.')), false); assertContained(windows[0]);
});

test('HTTP authentication is cancelled without invoking a native login prompt or inventing credentials', async t => {
  const { driver } = await fixture(t), tab = driver.newTab('https://example.test/'); await tab.loading; let prevented = false, supplied;
  tab.window.webContents.emit('login', { preventDefault: () => { prevented = true; } }, { url: 'https://example.test/' }, { realm: 'Fixture authentication' }, (...args) => { supplied = args; });
  assert.equal(prevented, true); assert.deepEqual(supplied, []); assert.match(tab.inputWarning, /HTTP authentication/); assertContained(tab.window);
  assert.equal(tab.pendingInteraction.kind, 'http_auth'); assert.equal(tab.pendingInteraction.status, 'blocked'); assert.equal(tab.pendingInteraction.reason, 'http_auth_unsupported');
});

test('a native dialog closed elsewhere becomes a truthful blocked notice and cannot be accepted later', async t => {
  const { driver, windows } = await fixture(t), tab = driver.newTab('https://example.test/'); await tab.loading;
  const debug = windows[0].webContents.debugger;
  debug.emit('message', {}, 'Page.javascriptDialogOpening', { hasBrowserHandler: true, type: 'confirm', message: 'Confirm owned action?', defaultPrompt: 'Never retained fixture text' });
  assert.equal(tab.pendingInteraction.status, 'pending');
  debug.emit('message', {}, 'Page.javascriptDialogClosed', { result: false, userInput: 'Never retained fixture text' });
  const pending = driver.status().tabs[0].pendingInteraction, args = { action: 'interaction', tabId: tab.id, interactionId: pending.id, expectedUrl: pending.url, expectedDocumentId: pending.documentId };
  assert.equal(pending.status, 'blocked'); assert.equal(pending.reason, 'dialog_cancelled'); assert.doesNotMatch(JSON.stringify(pending), /Never retained/);
  await assert.rejects(driver.perform({ ...args, decision: 'accept' }, { source: 'user' }), /blocked or cancelled/);
  assert.equal(windows[0].protocol.some(item => item.method === 'Page.handleJavaScriptDialog'), false);
  const result = await driver.perform({ ...args, decision: 'acknowledge' }, { source: 'user' });
  assert.equal(result.receipt.acknowledged, true); assert.equal(result.receipt.replayed, false); assert.equal(tab.pendingInteraction, null); assertContained(windows[0]);
});

test('a real CDP-paused dialog releases the browser queue for an exact agent decision without replaying input', async t => {
  let release, first = true, typed = 0;
  const held = new Promise(resolve => { release = resolve; });
  const { driver, windows } = await fixture(t, { command: async (method, _params, window) => {
    if (method === 'Input.insertText') { typed++; if (first) { first = false; window.webContents.debugger.emit('message', {}, 'Page.javascriptDialogOpening', { hasBrowserHandler: true, type: 'confirm', message: 'Owned paused confirm' }); return held; } }
    if (method === 'Page.handleJavaScriptDialog') window.webContents.debugger.emit('message', {}, 'Page.javascriptDialogClosed', { result: false });
    return {};
  } });
  const browser = new BrowserWorkspace({ driver }); t.after(() => browser.close());
  const tab = driver.newTab('https://example.test/'); await tab.loading;
  const guard = { browser: 'relay', tabId: tab.id, expectedUrl: 'https://example.test/', expectedDocumentId: `${tab.id}:${tab.revision}` };
  const result = await browser.perform({ action: 'type', ...guard, text: 'Owned input' });
  assert.equal(result.pendingInteraction.status, 'pending'); assert.equal(tab.suspendedWork.size, 1); assert.equal(browser.status().busy, false); assert.equal(typed, 1);
  const blocked = await browser.perform({ action: 'type', ...guard, text: 'Do not dispatch' }); assert.equal(blocked.actionDispatched, false); assert.equal(typed, 1);
  const action = { action: 'interaction', ...guard, interactionId: result.pendingInteraction.id, decision: 'dismiss' };
  await assert.rejects(browser.perform({ ...action, interactionId: `browser_input_${randomUUID()}` }), { code: 'BROWSER_INTERACTION_CHANGED' });
  await assert.rejects(browser.perform({ ...action, expectedDocumentId: 'replaced-document' }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
  const resolved = await browser.perform(action); await tick();
  assert.equal(browser.status().tabs[0].pendingInteraction, undefined);
  assert.equal(browser.status().tabs[0].interactionSettling, true, 'Resolving the dialog does not prove its native page command has settled.');
  release({}); await tick();
  assert.equal(browser.status().tabs[0].interactionSettling, false);
  assert.equal(resolved.receipt.replayed, false); assert.equal(tab.suspendedWork.size, 0); assert.equal(typed, 1);
  assert.deepEqual(windows[0].protocol.find(item => item.method === 'Page.handleJavaScriptDialog').params, { accept: false });
  await browser.perform({ action: 'type', ...guard, text: 'A separate explicit action' }); assert.equal(typed, 2); assertContained(windows[0]);
});

test('cancelled local dialog decisions do not dispatch and a later exact prompt decision is not echoed', async t => {
  const { driver, windows } = await fixture(t), tab = driver.newTab('https://example.test/'); await tab.loading;
  windows[0].webContents.debugger.emit('message', {}, 'Page.javascriptDialogOpening', { hasBrowserHandler: false, type: 'prompt', message: 'Owned prompt' });
  const current = tab.pendingInteraction, controller = new AbortController(), request = { action: 'interaction', tabId: tab.id, interactionId: current.id, expectedUrl: current.url, expectedDocumentId: current.documentId, decision: 'accept', promptText: 'Owned Unicode café answer' };
  controller.abort(); await assert.rejects(driver.perform(request, { source: 'user', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(tab.pendingInteraction.id, current.id); assert.equal(windows[0].protocol.some(item => item.method === 'Page.handleJavaScriptDialog'), false);
  const result = await driver.perform(request, { source: 'user' });
  assert.deepEqual(windows[0].protocol.at(-1), { method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'Owned Unicode café answer' } });
  assert.doesNotMatch(JSON.stringify(result), /café answer/); assert.equal(result.receipt.replayed, false); assert.equal(tab.pendingInteraction, null);
});

test('hidden file chooser uploads use the exact private input identity and bounded selected file bytes', async t => {
  const calls = [];
  const { driver, windows, directory } = await fixture(t, { command: async (method, params) => {
    if (method === 'DOM.resolveNode') { assert.equal(params.backendNodeId, 42); return { object: { objectId: 'owned-file-input' } }; }
    if (method === 'Runtime.callFunctionOn') { calls.push(params); const metadata = params.arguments[0].value.map(file => ({ name: file.name, size: Buffer.from(file.data, 'base64').length, type: file.type })); return { result: { value: { delivered: metadata, uploaded: metadata, eventsDispatched: true } } }; }
    return {};
  } });
  const file = path.join(directory, 'chosen.txt'); await writeFile(file, 'Selected café bytes');
  const tab = driver.newTab('https://example.test/'); await tab.loading;
  windows[0].webContents.debugger.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 42, mode: 'selectSingle' });
  const pending = driver.status().tabs[0].pendingInteraction, request = { action: 'upload', tabId: tab.id, chooserId: pending.id, expectedUrl: pending.url, expectedDocumentId: pending.documentId, paths: [file] }, checked = [];
  assert.equal(pending.multiple, false); assert.doesNotMatch(JSON.stringify(pending), /backendNodeId/);
  await assert.rejects(driver.perform({ ...request, paths: [file, file] }), /exact pending file input/);
  await assert.rejects(driver.perform({ ...request, expectedDocumentId: 'old' }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
  const result = await driver.perform(request, { validateUploadPath: async value => { checked.push(value); } });
  assert.deepEqual(checked, [file, file]); assert.equal(calls.length, 1); assert.equal(calls[0].objectId, 'owned-file-input');
  assert.equal(Buffer.from(calls[0].arguments[0].value[0].data, 'base64').toString(), 'Selected café bytes'); assert.doesNotMatch(JSON.stringify(calls), new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(result.receipt.uploaded, [{ name: 'chosen.txt', size: Buffer.byteLength('Selected café bytes'), type: 'text/plain' }]); assert.equal(tab.pendingInteraction, null);
  assert.equal(result.receipt.deliveryVerified, true); assert.equal(result.receipt.inputSelection, 'retained'); assert.equal(result.receipt.siteAcceptance, 'unconfirmed'); assert.equal(result.receipt.inspectBeforeContinuing, true);
  await assert.rejects(driver.perform(request), { code: 'BROWSER_INTERACTION_CHANGED' }); assertContained(windows[0]);
});

test('navigation invalidates a chooser and a late upload path rejection sends no file data', async t => {
  const { driver, windows, directory } = await fixture(t), tab = driver.newTab('https://example.test/'); await tab.loading;
  const file = path.join(directory, 'chosen.txt'); await writeFile(file, 'owned bytes');
  const debug = windows[0].webContents.debugger;
  debug.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 42, mode: 'selectSingle' });
  let pending = tab.pendingInteraction, request = { action: 'upload', tabId: tab.id, chooserId: pending.id, expectedUrl: pending.url, expectedDocumentId: pending.documentId, paths: [file] };
  windows[0].webContents.emit('did-frame-navigate');
  await assert.rejects(driver.perform(request), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
  debug.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 43, mode: 'selectSingle' });
  pending = tab.pendingInteraction; request = { ...request, chooserId: pending.id, expectedDocumentId: pending.documentId }; let checks = 0;
  await assert.rejects(driver.perform(request, { validateUploadPath: async () => { if (++checks === 2) throw Error('Allowed workspace changed'); } }), /Allowed workspace changed/);
  assert.equal(checks, 2); assert.equal(windows[0].protocol.some(item => item.method === 'DOM.resolveNode' || item.method === 'Runtime.callFunctionOn'), false); assert.equal(tab.pendingInteraction.id, pending.id);
});

test('visible-ref uploads enforce the observed document before reading and again before assigning file bytes', async t => {
  const { driver, windows, directory } = await fixture(t), tab = driver.newTab('https://example.test/'); await tab.loading;
  const file = path.join(directory, 'chosen.txt'); await writeFile(file, 'Owned selected bytes');
  const request = { action: 'upload', tabId: tab.id, ref: 'observed-file', expectedUrl: 'https://example.test/', expectedDocumentId: `${tab.id}:${tab.revision}`, paths: [file] }; let checks = 0;
  await assert.rejects(driver.perform({ ...request, expectedDocumentId: 'previous-document' }, { validateUploadPath: async () => { checks++; } }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
  assert.equal(checks, 0);
  await assert.rejects(driver.perform(request, { validateUploadPath: async () => { if (++checks === 2) tab.revision++; } }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
  assert.equal(checks, 2); assert.equal(windows[0].protocol.some(item => item.method === 'Runtime.callFunctionOn' || item.method === 'DOM.setFileInputFiles'), false);
});

test('one durable Chat Mode tab has reserved capacity without displacing normal tabs or lifting their limit', async t => {
  const { driver, directory } = await fixture(t); driver.maxTabs = 2;
  const normal = [driver.newTab('https://first.example/'), driver.newTab('https://second.example/')];
  await Promise.all(normal.map(tab => tab.loading));
  assert.throws(() => driver.newTab('https://third.example/'), { code: 'BROWSER_TAB_LIMIT' });
  const owned = driver.newTab('https://chatgpt.com/', { purpose: 'chat-mode' }); await owned.loading;
  assert.equal(driver.tabs.size, 3); assert.ok(normal.every(tab => driver.tabs.has(tab.id)));
  assert.equal(driver.status().tabs.find(tab => tab.tabId === owned.id).purpose, 'chat-mode');
  assert.ok(driver.status().tabs.filter(tab => tab.tabId !== owned.id).every(tab => !Object.hasOwn(tab, 'purpose')));
  assert.throws(() => driver.newTab('https://chatgpt.com/', { purpose: 'chat-mode' }), { code: 'BROWSER_CHAT_MODE_TAB_EXISTS' });
  assert.throws(() => driver.newTab('https://third.example/'), { code: 'BROWSER_TAB_LIMIT' });
  assert.equal(owned.window.webContents.openHandler({ url: 'https://third.example/' }).action, 'deny');
  driver.persist(); await driver.writeChain;
  const persisted = JSON.parse(await readFile(path.join(directory, 'browser-tabs.json'), 'utf8')), saved = persisted.tabs;
  assert.equal(persisted.version, 2);
  assert.equal(saved.length, 3); assert.equal(saved.filter(tab => tab.purpose === 'chat-mode').length, 1);
  await driver.close();
  const restored = new driver.constructor({ dataDir: directory, downloadDir: path.join(directory, 'downloads'), maxTabs: 2 });
  try {
    await restored.init(); assert.equal(restored.tabs.size, 3);
    assert.equal([...restored.tabs.values()].filter(tab => tab.purpose === 'chat-mode').length, 1);
    assert.equal(restored.status().tabs.filter(tab => tab.purpose === 'chat-mode').length, 1);
    assert.deepEqual(restored.status().tabs.map(tab => tab.url), saved.map(tab => tab.url));
    assert.ok(restored.status().tabs.every(tab => tab.suspended));
    assert.throws(() => restored.newTab('https://third.example/'), { code: 'BROWSER_TAB_LIMIT' });
  } finally { await restored.close(); }
});

const taskOwner = (taskId, nodeId = 'agent', runId = `run-${taskId}`) => ({ taskId, runId, nodeId, label: `Research ${taskId}` });

test('eight retained personal pages do not consume task folders and concurrent workers cannot retarget each other', async t => {
  const { driver, windows } = await fixture(t), browser = new BrowserWorkspace({ driver }); t.after(() => browser.close());
  const personal = Array.from({ length: 8 }, (_, index) => driver.newTab(`https://personal${index}.example/`));
  await Promise.all(personal.map(tab => tab.loading)); const selected = driver.activeTab;
  const alice = taskOwner('alice'), bob = taskOwner('bob'), delegate = taskOwner('alice', 'delegate');
  const [first, second] = await Promise.all([
    browser.perform({ action: 'open', url: 'https://electron.example/releases' }, { owner: alice }),
    browser.perform({ action: 'open', url: 'https://node.example/releases' }, { owner: bob }),
  ]);
  const child = await browser.perform({ action: 'open', url: 'https://electron.example/notes', parentTabId: first.tabId }, { owner: alice });
  const worker = await browser.perform({ action: 'open', url: 'https://review.example/' }, { owner: delegate });
  assert.equal(driver.activeTab, selected, 'Background tasks do not select a user page.');
  assert.equal(driver.tabs.size, 12); assert.ok(personal.every(tab => driver.tabs.has(tab.id)));
  const a = driver.tabs.get(first.tabId), b = driver.tabs.get(second.tabId), c = driver.tabs.get(child.tabId), d = driver.tabs.get(worker.tabId);
  assert.notEqual(a.folderId, b.folderId); assert.equal(c.folderId, a.folderId); assert.equal(c.parentTabId, a.id); assert.equal(d.folderId, a.folderId);
  assert.equal((await browser.perform({ action: 'snapshot' }, { owner: bob })).tabId, b.id);
  assert.equal((await browser.perform({ action: 'snapshot' }, { owner: alice })).tabId, c.id);
  for (const tabId of [b.id, d.id, personal[0].id]) await assert.rejects(browser.perform({ action: 'navigate', tabId, url: 'https://wrong.example/' }, { owner: alice }), { code: 'BROWSER_TAB_OWNERSHIP' });
  const visible = await browser.perform({ action: 'tabs' }, { owner: alice });
  assert.deepEqual(visible.tabs.map(tab => tab.tabId), [a.id, c.id]); assert.equal(visible.folders.length, 1); assert.equal(visible.ownerActiveTabs, undefined);
  assert.ok(windows.every(window => !window.visible)); windows.forEach(assertContained);
});

test('restored legacy pages are metadata-only and task tree identities survive a native lifecycle', async t => {
  const { driver, windows, directory } = await fixture(t);
  const old = Array.from({ length: 8 }, (_, index) => ({ url: `https://saved${index}.example/`, title: `Saved ${index}` }));
  await writeFile(path.join(directory, 'browser-tabs.json'), JSON.stringify(old)); await driver.init();
  assert.equal(windows.length, 0); assert.equal(driver.status().capacity.live, 0); assert.equal(driver.status().tabs.length, 8); assert.ok(driver.status().tabs.every(tab => tab.suspended && tab.folderId === 'folder_user'));
  const owner = taskOwner('persist'), parent = await driver.perform({ action: 'open', url: 'https://release.example/' }, { owner });
  const child = await driver.perform({ action: 'open', url: 'https://release.example/notes', parentTabId: parent.tabId }, { owner });
  await driver.releaseOwner(owner); const before = driver.status().tabs.map(({ tabId, folderId, parentTabId, owner, url }) => ({ tabId, folderId, parentTabId, owner, url }));
  await driver.close();
  const restored = new driver.constructor({ dataDir: directory, downloadDir: path.join(directory, 'downloads') });
  try {
    const nativeCount = windows.length; await restored.init();
    assert.equal(windows.length, nativeCount); assert.equal(restored.status().capacity.live, 0);
    assert.deepEqual(restored.status().tabs.map(({ tabId, folderId, parentTabId, owner, url }) => ({ tabId, folderId, parentTabId, owner, url })), before);
    const result = await restored.perform({ action: 'read', tabId: child.tabId }, { owner: { ...owner, runId: 'run-later' } });
    assert.equal(result.url, 'https://release.example/notes'); assert.equal(windows.length, nativeCount + 1);
    assert.equal(restored.tabs.get(parent.tabId).window, null, 'Reading a child never reloads its parent.');
  } finally { await restored.close(); }
});

test('live admission is bounded per task and globally while finished pages retain their folder tree', async t => {
  const { driver } = await fixture(t, { limits: { maxLiveTabs: 3, maxTaskTabs: 2 } }), alice = taskOwner('quota-a'), bob = taskOwner('quota-b');
  const personal = driver.newTab('https://personal.example/'); await personal.loading;
  const first = await driver.perform({ action: 'open', url: 'https://a.example/' }, { owner: alice });
  const child = await driver.perform({ action: 'open', url: 'https://a.example/child', parentTabId: first.tabId }, { owner: alice });
  await assert.rejects(driver.perform({ action: 'open', url: 'https://b.example/' }, { owner: bob }), { code: 'BROWSER_LIVE_LIMIT', actionDispatched: false });
  const receipt = await driver.releaseOwner(alice); assert.deepEqual(receipt.suspended, [first.tabId, child.tabId]);
  assert.equal(driver.tabs.size, 3); assert.equal(driver.status().capacity.live, 1); assert.equal(driver.tabs.get(child.tabId).parentTabId, first.tabId); assert.ok(personal.window && !personal.window.isDestroyed());
  await driver.perform({ action: 'open', url: 'https://b.example/' }, { owner: bob });
  await driver.perform({ action: 'read', tabId: first.tabId }, { owner: alice });
  await assert.rejects(driver.perform({ action: 'read', tabId: child.tabId }, { owner: alice }), { code: 'BROWSER_LIVE_LIMIT' });
  assert.equal(driver.tabs.get(child.tabId).window, null);
  await driver.releaseOwner(bob); await driver.perform({ action: 'read', tabId: child.tabId }, { owner: alice });
  driver.maxLiveTabs = 10;
  await assert.rejects(driver.perform({ action: 'open', url: 'https://a.example/third' }, { owner: alice }), { code: 'BROWSER_TASK_TAB_LIMIT' });
  assert.equal(driver.tabs.size, 4, 'Rejected admissions do not consume saved pages.');
});

test('owner cleanup excludes sibling workers, newer runs, personal pages, pending interactions and active downloads', async t => {
  const { driver } = await fixture(t), owner = taskOwner('cleanup'), sibling = taskOwner('cleanup', 'review');
  const own = await driver.perform({ action: 'open', url: 'https://own.example/' }, { owner });
  const other = await driver.perform({ action: 'open', url: 'https://other.example/' }, { owner: sibling });
  const newer = await driver.perform({ action: 'open', url: 'https://newer.example/' }, { owner });
  await driver.perform({ action: 'read', tabId: newer.tabId }, { owner: { ...owner, runId: 'newer-run' } });
  const human = driver.newTab('https://human.example/'); await human.loading;
  driver.tabs.get(own.tabId).pendingInteraction = { kind: 'http_auth', status: 'blocked' };
  let receipt = await driver.releaseOwner(owner); assert.equal(receipt.suspended.length, 0); assert.equal(receipt.retained[0].tabId, own.tabId);
  driver.tabs.get(own.tabId).pendingInteraction = null;
  driver.downloads.push({ tabId: own.tabId, status: 'downloading' });
  receipt = await driver.releaseOwner(owner); assert.equal(receipt.retained.length, 1);
  driver.downloads[0].status = 'completed'; receipt = await driver.releaseOwner(owner); assert.deepEqual(receipt.suspended, [own.tabId]);
  assert.ok([other.tabId, newer.tabId, human.id].every(id => driver.tabs.get(id).window));
});

test('user folders move whole branches, reject cycles and preserve children when a parent closes', async t => {
  const { driver } = await fixture(t), source = { source: 'user' };
  const folder = (await driver.perform({ action: 'folder_create', name: 'Sources' }, source)).folder;
  const parent = await driver.perform({ action: 'open', url: 'https://parent.example/' }, source);
  const child = await driver.perform({ action: 'open', url: 'https://child.example/', parentTabId: parent.tabId }, source);
  const grandchild = await driver.perform({ action: 'open', url: 'https://child.example/detail', parentTabId: child.tabId }, source);
  await driver.perform({ action: 'tab_move', tabId: parent.tabId, folderId: folder.id, parentTabId: null }, source);
  assert.ok([parent, child, grandchild].every(tab => driver.tabs.get(tab.tabId).folderId === folder.id));
  await assert.rejects(driver.perform({ action: 'tab_move', tabId: parent.tabId, parentTabId: grandchild.tabId }, source), { code: 'BROWSER_TAB_CYCLE' });
  await driver.perform({ action: 'close', tabId: child.tabId }, source);
  assert.equal(driver.tabs.get(grandchild.tabId).parentTabId, parent.tabId);
  await driver.perform({ action: 'folder_rename', folderId: folder.id, name: 'Verified sources' }, source);
  assert.equal(driver.folders.get(folder.id).name, 'Verified sources');
  await driver.perform({ action: 'folder_close', folderId: folder.id }, source);
  assert.equal(driver.folders.has(folder.id), false); assert.equal(driver.tabs.size, 0);
  assert.equal(driver.folders.has('folder_user'), true);
});

test('task popups inherit their worker folder and parent without changing the selected personal page', async t => {
  const { driver, Window } = await fixture(t), personal = driver.newTab('https://personal.example/'); await personal.loading;
  const owner = taskOwner('popup'), result = await driver.perform({ action: 'open', url: 'https://task.example/' }, { owner }), tab = driver.tabs.get(result.tabId);
  const response = tab.window.webContents.openHandler({ url: 'https://task.example/oauth' }); assert.equal(response.action, 'allow');
  const childWindow = new Window(response.overrideBrowserWindowOptions); tab.window.webContents.emit('did-create-window', childWindow, { url: 'https://task.example/oauth' }); await tick();
  const child = [...driver.tabs.values()].find(item => item.window === childWindow);
  assert.equal(child.parentTabId, tab.id); assert.equal(child.folderId, tab.folderId); assert.deepEqual(child.owner, tab.owner); assert.equal(driver.activeTab, personal.id);
  await driver.releaseOwner(owner); assert.equal(child.window, null); assert.ok(personal.window);
});

test('a person taking over a task page prevents automatic suspension until explicit local cleanup', async t => {
  const { driver } = await fixture(t), owner = taskOwner('takeover');
  const result = await driver.perform({ action: 'open', url: 'https://task.example/' }, { owner });
  await driver.perform({ action: 'navigate', tabId: result.tabId, url: 'https://task.example/manual' }, { source: 'user' });
  const receipt = await driver.releaseOwner(owner); assert.equal(receipt.suspended.length, 0); assert.match(receipt.retained[0].reason, /person interacted/); assert.ok(driver.tabs.get(result.tabId).window);
  const manual = await driver.perform({ action: 'suspend', tabId: result.tabId }, { source: 'user' }); assert.equal(manual.receipt.suspended, true); assert.equal(driver.tabs.get(result.tabId).window, null);
});

test('failed research navigation returns a coded failure and only an explicit observed retry can recover it', async t => {
  let rejected = true, attempts = 0;
  const { driver } = await fixture(t, { loadURL: async url => { if (url.startsWith('https:')) { attempts++; if (rejected) throw new Error('ERR_NAME_NOT_RESOLVED'); } } });
  const owner = taskOwner('navigation'), browser = new BrowserWorkspace({ driver }), handler = createBrowserToolHandler({ browser, owner }); t.after(() => browser.close());
  const result = await handler({ name: 'relay_browser', arguments: { action: 'open', url: 'https://source.example/release' } });
  assert.equal(result.success, false); assert.equal(result.code, 'BROWSER_NAVIGATION_FAILED');
  assert.equal(JSON.parse(result.contentItems[0].text).actionDispatched, true); assert.equal(attempts, 1);
  const tab = [...driver.tabs.values()][0];
  assert.equal(driver.status().tabs[0].url, 'https://source.example/release', 'Failed pages retain their requested source URL, not the inert blank renderer.');
  const read = await handler({ name: 'relay_browser', arguments: { action: 'read', tabId: tab.id } });
  assert.equal(read.success, false); assert.equal(read.code, 'BROWSER_NAVIGATION_FAILED'); assert.equal(attempts, 1, 'Reading failed state never silently navigates again.');
  rejected = false;
  const retry = await handler({ name: 'relay_browser', arguments: { action: 'navigate', tabId: tab.id, url: 'https://source.example/release' } });
  assert.equal(retry.success, true); assert.equal(attempts, 2); assert.equal(JSON.parse(retry.contentItems[0].text).url, 'https://source.example/release');
  assert.deepEqual((await browser.releaseOwner(owner)).suspended, [tab.id]);
});

test('folder writes report persistence failure and recover without hiding the in-memory change', async t => {
  const { driver, directory } = await fixture(t), obstruction = path.join(directory, 'browser-tabs.json.tmp');
  await mkdir(obstruction);
  await assert.rejects(driver.perform({ action: 'folder_create', name: 'Unsaved sources' }, { source: 'user' }), { code: 'BROWSER_SAVE_FAILED', actionDispatched: true });
  assert.equal(driver.status().persistence.healthy, false);
  const folder = [...driver.folders.values()].find(item => item.name === 'Unsaved sources'); assert.ok(folder);
  await rm(obstruction, { recursive: true });
  const saved = await driver.perform({ action: 'folder_rename', folderId: folder.id, name: 'Saved sources' }, { source: 'user' });
  assert.equal(saved.persistence.healthy, true);
  const disk = JSON.parse(await readFile(path.join(directory, 'browser-tabs.json'), 'utf8')); assert.equal(disk.folders.find(item => item.id === folder.id).name, 'Saved sources');
});

test('reloading a suspended page preserves a failed activation instead of reporting a successful no-op', async t => {
  let rejected = true, attempts = 0;
  const { driver } = await fixture(t, { loadURL: async url => { if (url.startsWith('https:')) { attempts++; if (rejected) throw new Error('ERR_CONNECTION_REFUSED'); } } });
  const owner = taskOwner('saved-reload'), tab = driver.newTab('https://saved.example/release', { restore: true, owner });
  const browser = new BrowserWorkspace({ driver }), handler = createBrowserToolHandler({ browser, owner }); t.after(() => browser.close());
  assert.equal(tab.window, null);
  const result = await handler({ name: 'relay_browser', arguments: { action: 'reload', tabId: tab.id } });
  assert.equal(result.success, false); assert.equal(result.code, 'BROWSER_NAVIGATION_FAILED');
  const receipt = JSON.parse(result.contentItems[0].text); assert.equal(receipt.actionDispatched, true); assert.match(receipt.error, /ERR_CONNECTION_REFUSED/);
  assert.equal(attempts, 1, 'Resuming reload dispatches exactly one navigation.'); assert.match(tab.loadError, /ERR_CONNECTION_REFUSED/);
  rejected = false;
  const recovered = await handler({ name: 'relay_browser', arguments: { action: 'navigate', tabId: tab.id, url: 'https://saved.example/release' } });
  assert.equal(recovered.success, true); assert.equal(attempts, 2);
});

test('persistence flush saves retained pages without closing them and leaves failed storage reviewable', async t => {
  const { driver, directory, windows } = await fixture(t), tab = driver.newTab('https://retained.example/'); await tab.loading; await driver.writeChain;
  const obstruction = path.join(directory, 'browser-tabs.json.tmp'); await mkdir(obstruction);
  await assert.rejects(driver.flushPersistence(), { code: 'BROWSER_SAVE_FAILED' });
  assert.equal(driver.status().persistence.healthy, false); assert.equal(driver.closed, false); assert.equal(windows[0].destroyed, false);
  await rm(obstruction, { recursive: true });
  const flushed = await driver.flushPersistence(); assert.equal(flushed.persistence.healthy, true); assert.equal(windows[0].destroyed, false);
  const saved = JSON.parse(await readFile(path.join(directory, 'browser-tabs.json'), 'utf8')); assert.equal(saved.tabs[0].tabId, tab.id); assert.equal(saved.tabs[0].url, 'https://retained.example/');
});

test('driver shutdown does not claim saved folder state after persistence failure', async t => {
  const { driver, directory, windows } = await fixture(t, { closeError: { code: 'BROWSER_SAVE_FAILED' } });
  const tab = driver.newTab('https://retained.example/'); await tab.loading; await driver.writeChain;
  await mkdir(path.join(directory, 'browser-tabs.json.tmp'));
  const closing = driver.close(); assert.equal(driver.close(), closing);
  await assert.rejects(closing, { code: 'BROWSER_SAVE_FAILED' }); assert.equal(windows[0].destroyed, true);
  assert.equal(driver.status().persistence.healthy, false);
});

test('old active downloads remain visible and prevent page suspension beyond the history limit', async t => {
  const { driver } = await fixture(t), owner = taskOwner('downloads'), tab = driver.newTab('https://downloads.example/', { owner }); await tab.loading;
  const makeDownload = () => Object.assign(new EventEmitter(), { getFilename: () => 'fixture.txt', setSavePath() {}, getTotalBytes: () => 100, getReceivedBytes: () => 0 });
  const held = makeDownload(); await driver.download(held, tab.window.webContents); const activeId = driver.downloads[0].id;
  for (let index = 0; index < 125; index++) { const completed = makeDownload(); await driver.download(completed, tab.window.webContents); completed.emit('done', {}, 'completed'); }
  assert.equal(driver.status().activeDownloads, 1); assert.ok(driver.status().downloads.some(item => item.id === activeId));
  assert.ok(driver.downloads.some(item => item.id === activeId)); assert.ok(driver.downloads.length <= 101);
  const blocked = await driver.releaseOwner(owner); assert.equal(blocked.suspended.length, 0); assert.match(blocked.retained[0].reason, /download/); assert.ok(tab.window);
  held.emit('done', {}, 'completed'); assert.equal(driver.status().activeDownloads, 0); assert.ok(driver.downloads.length <= 100);
  assert.deepEqual((await driver.releaseOwner(owner)).suspended, [tab.id]);
});


async function pointerFixture(t, { beforeInput, inputError, nested = false, iframeTarget = true } = {}) {
  const childURL = 'https://identity.example.test/button', quad = [150, 80, 450, 80, 450, 230, 150, 230];
  let instance;
  const f = await fixture(t, { command: async (method, params, window, sessionId) => {
    if (method === 'Runtime.evaluate') {
      if (params.expression === '({width:innerWidth,height:innerHeight})') {
        beforeInput?.(instance);
        return { result: { value: { width: 300, height: 150 } } };
      }
      if (!sessionId && !params.contextId) return { result: { objectId: nested ? 'outer-owner' : 'exact-owner' } };
      if (params.contextId === 41 && nested) return { result: { objectId: 'exact-owner' } };
      return { result: { subtype: 'null', value: null } };
    }
    if (method === 'DOM.describeNode') return { node: { nodeName: 'IFRAME', frameId: params.objectId === 'outer-owner' ? 'same-process-child' : 'owned-frame' } };
    if (method === 'DOM.getBoxModel') return { model: { content: quad } };
    if (method === 'DOM.getFrameOwner') return { backendNodeId: 7 };
    if (method === 'Target.getTargets') return { targetInfos: [{ type: 'iframe', targetId: 'unrelated-same-url', url: childURL }, ...(iframeTarget ? [{ type: 'iframe', targetId: 'owned-frame', url: childURL }] : [])] };
    if (method === 'Target.attachToTarget') { assert.equal(params.targetId, 'owned-frame'); assert.equal(params.flatten, true); return { sessionId: 'exact-child-session' }; }
    if (method === 'Page.getFrameTree') return sessionId ? { frameTree: { frame: { id: 'owned-frame', url: childURL } } } : { frameTree: { frame: { id: 'root', url: window.url }, childFrames: [{ frame: { id: 'owned-frame', url: childURL } }] } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: nested ? 41 : 42 };
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' && inputError) throw inputError;
    return {};
  } });
  const tab = f.driver.newTab('https://parent.example.test/'); await tab.loading;
  const main = tab.window.webContents.mainFrame, child = { parent: main, processId: 2, routingId: 2, url: childURL, name: '', frames: [], framesInSubtree: [], executeJavaScript: main.executeJavaScript };
  main.url = tab.url; main.frames = [child]; main.framesInSubtree = [main, child];
  tab.window.webContents.executeJavaScript = async () => ({ width: 1280, height: 900 });
  const guard = { browser: 'relay', tabId: tab.id, expectedUrl: tab.url, expectedDocumentId: `${tab.id}:${tab.revision}` };
  f.driver.element = async () => ({ frame: child, result: { x: 150, y: 75, viewportWidth: 300, viewportHeight: 150 } });
  f.driver.snapshot = async () => ({ frames: [] });
  instance = { ...f, tab, child, main, guard };
  return instance;
}

test('reference and coordinate pointers target the exact cross-process iframe with native events', async t => {
  const f = await pointerFixture(t);
  for (const action of ['hover', 'click']) for (const target of [{ ref: 'current-frame-button' }, { x: 300, y: 155 }]) {
    f.windows[0].protocol.length = 0;
    await f.driver.perform({ action, ...(action === 'click' ? f.guard : { tabId: f.tab.id }), ...target }, { source: 'user' });
    const inputs = f.windows[0].protocol.filter(call => call.method === 'Input.dispatchMouseEvent');
    assert.deepEqual(inputs.map(call => call.params.type), action === 'click' ? ['mouseMoved', 'mousePressed', 'mouseReleased'] : ['mouseMoved']);
    for (const input of inputs) { assert.equal(input.sessionId, 'exact-child-session'); assert.equal(input.params.x, 150); assert.equal(input.params.y, 75); }
    assert.equal(f.windows[0].protocol.filter(call => call.method === 'Target.attachToTarget').length, 1);
    assert.equal(f.windows[0].protocol.filter(call => call.method === 'Target.detachFromTarget').length, 1);
  }
});

test('pointer routing can find an OOPIF through a same-process child without routing to duplicate URLs', async t => {
  const f = await pointerFixture(t, { nested: true });
  await f.driver.perform({ action: 'click', ...f.guard, x: 300, y: 155 }, { source: 'user' });
  assert.equal(f.windows[0].protocol.some(call => call.method === 'Page.createIsolatedWorld' && call.params.frameId === 'same-process-child'), true);
  assert.deepEqual(f.windows[0].protocol.filter(call => call.method === 'Target.attachToTarget').map(call => call.params.targetId), ['owned-frame']);
  assert.ok(f.windows[0].protocol.filter(call => call.method === 'Input.dispatchMouseEvent').every(call => call.sessionId === 'exact-child-session'));
});

test('same-process iframe input stays on its existing native root target', async t => {
  const f = await pointerFixture(t, { iframeTarget: false });
  await f.driver.perform({ action: 'click', ...f.guard, x: 300, y: 155 }, { source: 'user' });
  assert.equal(f.windows[0].protocol.some(call => call.method === 'Target.attachToTarget'), false);
  for (const call of f.windows[0].protocol.filter(call => call.method === 'Input.dispatchMouseEvent')) { assert.equal(call.sessionId, undefined); assert.equal(call.params.x, 300); assert.equal(call.params.y, 155); }
});

test('iframe navigation during routing rejects input and detaches the exact child session', async t => {
  let changed = false;
  const f = await pointerFixture(t, { beforeInput: fixture => { if (!changed) { changed = true; fixture.tab.revision++; } } });
  await assert.rejects(f.driver.perform({ action: 'click', ...f.guard, x: 300, y: 155 }, { source: 'user' }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
  assert.equal(f.windows[0].protocol.some(call => call.method.startsWith('Input.')), false);
  assert.equal(f.windows[0].protocol.filter(call => call.method === 'Target.detachFromTarget').length, 1);
});

test('an uncertain iframe press is released in that same session without root fallback or a second press', async t => {
  const f = await pointerFixture(t, { inputError: Error('Owned uncertain pointer receipt') });
  await assert.rejects(f.driver.perform({ action: 'click', ...f.guard, x: 300, y: 155 }, { source: 'user' }), /Owned uncertain pointer receipt/);
  const inputs = f.windows[0].protocol.filter(call => call.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(inputs.map(call => call.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.ok(inputs.every(call => call.sessionId === 'exact-child-session'));
  assert.equal(f.windows[0].protocol.filter(call => call.method === 'Target.detachFromTarget').length, 1);
});

test('restricted file-system requests are granted and the owned listener is removed on close', async t => {
  const { driver, session } = await fixture(t), answers = [];
  session.emit('file-system-access-restricted', {}, { origin: 'https://files.example.test', path: 'fixture-only' }, decision => answers.push(decision));
  assert.deepEqual(answers, ['allow']);
  assert.equal(session.listenerCount('file-system-access-restricted'), 1);
  await driver.close(); assert.equal(session.listenerCount('file-system-access-restricted'), 0);
});

test('a script-opened contained popup can close normally while ordinary window close behavior remains stable', async t => {
  const { driver, Window } = await fixture(t), parent = driver.newTab('https://parent.example.test/'); await parent.loading;
  const options = parent.window.webContents.openHandler({ url: 'https://identity.example.test/' }).overrideBrowserWindowOptions;
  const child = new Window(options); parent.window.webContents.emit('did-create-window', child, { url: 'https://identity.example.test/' }); await tick();
  let prevented = 0; child.emit('close', { preventDefault: () => prevented++ });
  assert.equal(prevented, 0);
  const childTab = [...driver.tabs.values()].find(tab => tab.window === child); assert.equal(childTab.closing, false, 'A cancellable beforeunload must not retire a still-live popup.');
  child.destroy(); assert.equal(driver.tabs.has(childTab.id), false); assert.equal(driver.tabs.has(parent.id), true);
  parent.window.emit('close', { preventDefault: () => prevented++ }); assert.equal(prevented, 1);
});

test('agent organization keeps task provenance and cannot affect sibling workers or the human calling tab', async t => {
  const { driver } = await fixture(t), owner = taskOwner('organize'), sibling = { ...owner, nodeId: 'different-worker' };
  const own = driver.newTab('https://own.example/', { owner }), other = driver.newTab('https://other.example/', { owner: sibling }); await Promise.all([own.loading, other.loading]);
  const created = await driver.perform({ action: 'folder_create', name: 'Owned destination' }, { owner });
  assert.equal(created.folder.kind, 'task'); assert.equal(created.folder.taskId, owner.taskId);
  await driver.perform({ action: 'tab_move', tabId: own.id, folderId: created.folder.id }, { owner });
  assert.equal(own.folderId, created.folder.id);
  await assert.rejects(driver.perform({ action: 'suspend', tabId: other.id }, { owner }), { code: 'BROWSER_TAB_OWNERSHIP' });
  await assert.rejects(driver.perform({ action: 'folder_close', folderId: other.folderId }, { owner }), { code: 'BROWSER_TAB_OWNERSHIP' });
  const human = driver.newTab('https://chatgpt.com/', { purpose: 'chat-mode' }); await human.loading;
  await assert.rejects(driver.perform({ action: 'folder_close', folderId: human.folderId }, { owner: { ...owner, allowUserTabs: true } }), { code: 'BROWSER_HUMAN_CHAT_RESERVED' });
  assert.ok(driver.tabs.has(human.id)); assert.ok(driver.tabs.has(other.id));
  await driver.perform({ action: 'folder_close', folderId: created.folder.id }, { owner }); assert.equal(driver.tabs.has(own.id), false);
});

test('local preview frames use guarded JPEG while ordinary screenshots remain lossless', async t => {
  const f = await fixture(t), tab = f.driver.newTab('https://preview.test/'); await tab.loading;
  let jpeg = 0, png = 0;
  tab.window.webContents.capturePage = async () => ({ isEmpty: () => false, getSize: () => ({ width: 1280, height: 900 }), toJPEG: quality => { assert.equal(quality, 85); jpeg++; return Buffer.from('preview'); }, toDataURL: () => { png++; return 'data:image/png;base64,original'; } });
  const request = { action: 'screenshot', browser: 'relay', tabId: tab.id, expectedUrl: tab.url, expectedDocumentId: tab.id + ':' + tab.revision, preview: true };
  const browser = new BrowserWorkspace({ driver: new BrowserRouter({ independent: f.driver }) }); t.after(() => browser.close());
  const frame = await browser.perform(request, { source: 'user' });
  assert.equal(frame.imageUrl, 'data:image/jpeg;base64,' + Buffer.from('preview').toString('base64')); assert.equal(jpeg, 1); assert.equal(png, 0);
  assert.equal(frame.documentId, request.expectedDocumentId); assert.equal(frame.url, request.expectedUrl);
  const original = await browser.perform({ action: 'screenshot', browser: 'relay', tabId: tab.id }, { source: 'user' });
  assert.equal(original.imageUrl, 'data:image/png;base64,original'); assert.equal(jpeg, 1); assert.equal(png, 1);
});

test('preview capture rejects stale documents without activation or copying pixels', async t => {
  const f = await fixture(t), tab = f.driver.newTab('https://preview.test/'); await tab.loading;
  const request = { action: 'screenshot', browser: 'relay', tabId: tab.id, expectedUrl: tab.url, expectedDocumentId: tab.id + ':' + tab.revision, preview: true };
  let activations = 0, captures = 0;
  f.driver.activate = async () => { activations++; }; f.driver.capture = async () => { captures++; assert.fail('No stale preview may copy pixels.'); };
  tab.revision++;
  await assert.rejects(f.driver.perform(request, { source: 'user' }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED', actionDispatched: false });
  assert.equal(activations, 0); assert.equal(captures, 0);
  tab.window = null;
  await assert.rejects(f.driver.perform({ ...request, expectedDocumentId: tab.id + ':' + tab.revision }, { source: 'user' }), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED', actionDispatched: false });
  assert.equal(activations, 0); assert.equal(captures, 0); assert.equal(f.windows.length, 1);
});

test('navigation while a local preview is captured retires the image before encoding', async t => {
  const f = await fixture(t), tab = f.driver.newTab('https://preview.test/'); await tab.loading;
  let encodings = 0;
  tab.window.webContents.capturePage = async () => { tab.revision++; return { isEmpty: () => false, getSize: () => ({ width: 1280, height: 900 }), toJPEG: () => { encodings++; return Buffer.from('obsolete'); } }; };
  const request = { action: 'screenshot', browser: 'relay', tabId: tab.id, expectedUrl: tab.url, expectedDocumentId: tab.id + ':' + tab.revision, preview: true };
  await assert.rejects(f.driver.perform(request, { source: 'user' }), /page changed/);
  assert.equal(encodings, 0);
});
