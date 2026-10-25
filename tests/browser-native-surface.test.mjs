import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserSurfaceHost, browserSurfaceBounds, createLiveBrowserWindow, performBrowserSurface } from '../desktop/browser-surface.mjs';
import { BrowserRouter } from '../desktop/browser-router.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bounds = { x: 25, y: 120, width: 700, height: 450 };
const host = () => ({ isDestroyed: () => false, isVisible: () => true, getContentSize: () => [800, 600] });
function fixture({ activate = async () => {}, human = async () => {}, save = async () => {} } = {}) {
  const pages = new Map(), events = [];
  for (const id of ['first', 'second']) pages.set(id, { id, window: { liveSurface: true, isDestroyed: () => false,
    attach: (parent, rect) => events.push(['attach', id, parent, rect]), hide: () => events.push(['hide', id]),
    position: rect => events.push(['position', id, rect]), focus: () => events.push(['focus', id]) } });
  const driver = { tab(id) { const value = pages.get(id); if (!value) throw Error('Missing tab.'); return value; },
    activate, async setHumanSurface(tab, enabled) { tab.humanSurface = enabled; events.push(['human', tab.id, enabled]); await human(tab, enabled); },
    persist() { events.push(['persist', this.activeTab]); }, async savedStatus() { await save(); return { activeTab: this.activeTab }; },
    emit: type => events.push([type]) };
  return { surface: new BrowserSurfaceHost(driver), driver, pages, events, window: host() };
}

test('native surface clips page geometry to the shell and rejects unusable viewports', () => {
  assert.deepEqual(browserSurfaceBounds({ x: -20.4, y: 80.2, width: 1000, height: 900 }, host()), { x: 0, y: 80, width: 800, height: 520 });
  for (const invalid of [null, {}, { ...bounds, width: NaN }, { ...bounds, height: 0 }, { ...bounds, x: 900 }, { ...bounds, extra: true }])
    assert.throws(() => browserSurfaceBounds(invalid, host()));
});

test('native selection moves the real page, resizes it and parks it on workspace leave', async () => {
  const f = fixture();
  assert.equal((await f.surface.perform(f.window, { action: 'attach', tabId: 'first', bounds })).attached, true);
  assert.equal(f.driver.activeTab, 'first'); assert.equal(f.pages.get('first').humanSurface, true);
  await f.surface.perform(f.window, { action: 'bounds', bounds: { ...bounds, width: 500 } });
  await f.surface.perform(f.window, { action: 'focus' });
  await f.surface.perform(f.window, { action: 'attach', tabId: 'second', bounds });
  assert.ok(f.events.some(event => event[0] === 'hide' && event[1] === 'first'));
  assert.equal(f.pages.get('first').humanSurface, false);
  assert.deepEqual(await f.surface.perform(f.window, { action: 'hide' }), { attached: false, tabId: null, bounds: null });
  assert.equal(f.pages.get('second').humanSurface, false);
  assert.deepEqual(f.events.filter(event => event[0] === 'persist').map(event => event[1]), ['first', 'second']);
});

test('native selection confirms its saved ID before replying and hide revokes a delayed save receipt', async () => {
  const saving = deferred(), f = fixture({ save: () => saving.promise }); let replied = false;
  const attaching = f.surface.perform(f.window, { action: 'attach', tabId: 'second', bounds }).then(value => { replied = true; return value; });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(f.driver.activeTab, 'second'); assert.equal(replied, false);
  assert.deepEqual(f.events.filter(event => event[0] === 'persist'), [['persist', 'second']]);
  f.surface.hide(); saving.resolve();
  assert.equal((await attaching).attached, false); assert.equal(f.surface.status().attached, false);
});

test('a host closed during the selection save cannot receive a successful attachment receipt', async () => {
  const saving = deferred(), f = fixture({ save: () => saving.promise });
  const attaching = f.surface.perform(f.window, { action: 'attach', tabId: 'first', bounds });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  f.window.isDestroyed = () => true; saving.resolve();
  assert.equal((await attaching).attached, false); assert.equal(f.pages.get('first').humanSurface, false);
});

test('hiding while a suspended page resumes prevents its late native view from covering another workspace', async () => {
  const loading = deferred(), f = fixture({ activate: () => loading.promise });
  const opening = f.surface.perform(f.window, { action: 'attach', tabId: 'first', bounds });
  f.surface.hide(); loading.resolve();
  assert.equal((await opening).attached, false);
  assert.equal(f.events.some(event => event[0] === 'attach'), false);
});

test('a later tab wins even if the first activation completes last', async () => {
  const first = deferred(), f = fixture({ activate: tab => tab.id === 'first' ? first.promise : Promise.resolve() });
  const old = f.surface.perform(f.window, { action: 'attach', tabId: 'first', bounds });
  await f.surface.perform(f.window, { action: 'attach', tabId: 'second', bounds });
  first.resolve(); await old;
  assert.equal(f.surface.status().tabId, 'second');
  assert.deepEqual(f.events.filter(event => event[0] === 'attach').map(event => event[1]), ['second']);
});

test('hide revokes a surface while the native picker transition is awaiting Chromium', async () => {
  const transition = deferred(), f = fixture({ human: (_tab, enabled) => enabled ? transition.promise : Promise.resolve() });
  const opening = f.surface.perform(f.window, { action: 'attach', tabId: 'first', bounds });
  await Promise.resolve(); f.surface.hide(); transition.resolve(); await opening;
  assert.equal(f.surface.status().attached, false);
  assert.equal(f.pages.get('first').humanSurface, false);
  assert.equal(f.events.some(event => event[0] === 'attach'), false);
});

test('a human native tab selection remains selected in router status and the next browser event', async () => {
  const f = fixture(), observed = [];
  f.driver.activeTab = 'first'; f.driver.surface = f.surface;
  f.driver.status = () => ({ activeTab: f.driver.activeTab, tabs: [...f.pages.values()].map(page => ({ tabId: page.id, url: 'https://fixture.invalid/' + page.id })) });
  f.driver.setHostSurface = (parent, request) => f.surface.perform(parent, request);
  const router = new BrowserRouter({ independent: f.driver });
  router.activeTab = 'first'; router.status(); router.on('changed', () => observed.push(router.status().activeTab));
  await performBrowserSurface(router, f.window, { action: 'attach', tabId: 'second', bounds });
  assert.equal(router.status().activeTab, 'second'); assert.equal(observed.at(-1), 'second');
  await performBrowserSurface(router, f.window, { action: 'hide' });
  assert.equal(router.status().activeTab, 'second');
});

test('the website sign-in form can focus BLACKICE controls without detaching or focusing the page', async () => {
  const f = fixture(); let chromeFocus = 0;
  f.window.webContents = { focus: () => chromeFocus++ };
  await f.surface.perform(f.window, { action: 'attach', tabId: 'first', bounds });
  await f.surface.perform(f.window, { action: 'focus-chrome' });
  assert.equal(chromeFocus, 1); assert.equal(f.surface.status().tabId, 'first');
  assert.equal(f.events.some(event => event[0] === 'focus'), false);
});

test('the native adapter retains one WebContents while reparenting and routes browser shortcuts only when attached', () => {
  const windows = [], shortcuts = [];
  class BaseWindow {
    constructor() { this.destroyed = false; this.children = new Set(); this.contentView = {
      addChildView: view => this.children.add(view), removeChildView: view => this.children.delete(view),
    }; windows.push(this); }
    isDestroyed() { return this.destroyed; } isVisible() { return true; }
    destroy() { this.destroyed = true; }
  }
  class WebContentsView {
    constructor(options) { this.options = options; this.webContents = options.webContents || new EventEmitter();
      if (!options.webContents) Object.assign(this.webContents, { isDestroyed: () => false, close: () => this.webContents.emit('destroyed'), focus() {} }); }
    getBounds() { return this.bounds; } setBounds(value) { this.bounds = value; } setVisible(value) { this.visible = value; }
  }
  const page = createLiveBrowserWindow({ BaseWindow, WebContentsView, options: { webPreferences: { sandbox: false, offscreen: true, session: 'same-profile' } }, onShortcut: action => shortcuts.push(action) });
  const contents = page.webContents, parent = new BaseWindow();
  assert.equal(page.view.options.webPreferences.offscreen, false);
  assert.equal(page.view.options.webPreferences.sandbox, true, 'Live pages must keep native window.close instead of targeting their containing BrowserWindow.');
  assert.equal(page.view.options.webPreferences.session, 'same-profile');
  let prevented = 0;
  const keyboard = () => contents.emit('before-input-event', { preventDefault: () => prevented++ }, { type: 'keyDown', control: true, key: 'l' });
  keyboard(); assert.equal(shortcuts.length, 0);
  page.attach(parent, bounds); keyboard(); assert.deepEqual(shortcuts, ['address']); assert.equal(prevented, 1);
  assert.equal(parent.children.has(page.view), true); assert.equal(windows[0].children.has(page.view), false);
  page.hide(); assert.equal(page.webContents, contents); assert.equal(parent.children.size, 0); assert.equal(windows[0].children.has(page.view), true);
  page.destroy(); assert.equal(windows[0].destroyed, true);
  const popupContents = new EventEmitter();
  Object.assign(popupContents, { isDestroyed: () => false, close: () => popupContents.emit('destroyed'), focus() {} });
  const popup = createLiveBrowserWindow({ BaseWindow, WebContentsView,
    options: { webContents: popupContents, webPreferences: { session: 'same-profile' } } });
  assert.equal(popup.webContents, popupContents, 'Electron guest creation requires the exact supplied WebContents.');
  popup.attach(parent, bounds);
  popupContents.emit('destroyed');
  assert.equal(parent.children.has(popup.view), false, 'Script-closed popups must remove their native child view.');
});
