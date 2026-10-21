import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../public/api-client.mjs';
import { observeBrowserModel, observeBrowserFrame, observeBrowserDocument, observeBrowserPoint } from '../public/observe-model.mjs';
import { initObserveBrowser, initObserveUI, renderObserveBrowser } from '../public/observe-ui.mjs';

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const tab = (tabId, extra = {}) => ({ tabId, browser: 'relay', visible: false, title: 'Contained ' + tabId, url: 'https://example.test/' + tabId, ...extra });
const status = (tabs = [tab('one')]) => ({ available: true, background: true, physicalInput: false, acceptingActions: true, busy: false, browsers: { relay: { available: true } }, activeTab: tabs[0]?.tabId, tabs });
const frame = id => ({ tabId: id, width: 1280, height: 900, imageUrl: image, url: 'https://example.test/' + id });
const documentFor = id => ({ tabId: id, frames: [{ text: 'Actual contained page text', elements: [{ ref: 'observed:text', role: 'textbox', name: 'Message' }, { ref: 'observed:select', role: 'combobox', name: 'Destination', options: [{ value: 'first', label: 'First' }, { value: '', label: 'Empty value' }] }, { ref: 'observed:button', role: 'button', name: 'Apply' }] }] });
const decode = value => String(value).replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, decode(value)]));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { initial = status(), handle } = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'), doc = { activeElement: null, body: {} }; globalThis.document = doc;
  const listeners = new Map(), calls = []; let html = '', nodes = [], clock = 0, visible = true;
  const mount = { isConnected: true, writes: 0, setAttribute() {}, addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name), contains: node => node?.parentHost === mount && node.isConnected, querySelector: selector => selector.startsWith('#') ? nodes.find(node => node.id === selector.slice(1)) : null, querySelectorAll: selector => selector === '[data-observe-browser]' ? nodes.filter(node => node.dataset.observeBrowser) : [] };
  Object.defineProperty(mount, 'innerHTML', { get: () => html, set(value) {
    html = value; mount.writes++; for (const node of nodes) { node.isConnected = false; if (doc.activeElement === node) doc.activeElement = doc.body; } nodes = [];
    for (const [tag, kind] of value.matchAll(/<(input|select|button|details|img)\b[^>]*>/g)) {
      const attrs = attributes(tag), node = { ...attrs, tagName: kind.toUpperCase(), id: attrs.id || '', value: attrs.value || '', disabled: /\sdisabled(?:\s|>)/.test(tag), open: /\sopen(?:\s|>)/.test(tag), parentHost: mount, isConnected: true, dataset: attrs['data-observe-browser'] ? { observeBrowser: attrs['data-observe-browser'] } : {}, focus(options) { if (this.disabled) return; doc.activeElement = this; this.focusOptions = options; }, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }, closest(selector) { return selector === '[data-observe-browser]' && this.dataset.observeBrowser ? this : null; }, getBoundingClientRect: () => ({ left: 10, top: 20, width: 640, height: 450 }) };
      if (kind === 'select') { const body = new RegExp('<select\\b[^>]*id="' + node.id + '"[^>]*>([\\s\\S]*?)</select>').exec(value)?.[1] || '', options = [...body.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].map(([, attrs, label]) => ({ value: attributes(attrs).value ?? decode(label), selected: /\bselected\b/.test(attrs) })); node.value = (options.find(option => option.selected) || options[0])?.value || ''; }
      nodes.push(node);
    }
  } });
  const data = { status: initial, clicks: 0 };
  const api = createApiClient({ timeoutMs: 2000, fetcher: async (route, options) => {
    assert.ok(['/api/browser/status', '/api/browser/action'].includes(route), 'the contained surface cannot call a native show or connection route');
    const body = options.body ? JSON.parse(options.body) : undefined, call = { route, method: options.method, body, signal: options.signal }; calls.push(call);
    if (body) assert.equal(body.browser, 'relay', 'every page action explicitly targets contained Chromium');
    const custom = await handle?.(call, data); if (custom !== undefined) return Response.json(custom);
    if (route === '/api/browser/status') return Response.json(data.status);
    if (body.action === 'screenshot') return Response.json(frame(body.tabId));
    if (body.action === 'open') { data.status.tabs.push(tab('new', { url: body.url })); data.status.activeTab = 'new'; return Response.json(documentFor('new')); }
    if (body.action === 'navigate') data.status.tabs.find(tab => tab.tabId === body.tabId).url = body.url;
    if (body.action === 'close') { data.status.tabs = data.status.tabs.filter(tab => tab.tabId !== body.tabId); data.status.activeTab = data.status.tabs[0]?.tabId || null; return Response.json(data.status); }
    if (body.action === 'click') data.clicks++;
    return Response.json(documentFor(body.tabId));
  } });
  const ui = initObserveBrowser({ mount, api, isVisible: () => visible, now: () => clock });
  t.after(() => { ui.destroy(); if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document; });
  return { ui, mount, data, calls, api, element: id => mount.querySelector('#' + id), button: action => nodes.find(node => node.dataset.observeBrowser === action), get html() { return html; }, get focused() { return doc.activeElement; }, advance(ms) { clock += ms; }, hide() { visible = false; }, show() { visible = true; }, async click(action, extra = {}) { const target = this.button(action); assert.ok(target, 'rendered action exists: ' + action); await listeners.get('click')({ target, ...extra }); }, async change(id, value) { const target = this.element(id); target.value = value; await listeners.get('change')({ target }); }, async submit() { await listeners.get('submit')({ target: { id: 'observe-browser-address-form' }, preventDefault() {} }); } };
}

test('contained browser inventory admits only known hidden BLACKICE pages and never infers native containment', () => {
  const original = status([tab('one'), tab('shown', { visible: true }), tab('unknown', { visible: undefined }), tab('firefox:1', { browser: 'firefox' }), tab('native', { browser: 'neo' })]), before = structuredClone(original), model = observeBrowserModel(original);
  assert.deepEqual(model.tabs.map(tab => tab.tabId), ['one']); assert.equal(model.selected.tabId, 'one'); assert.deepEqual(original, before);
  assert.equal(observeBrowserModel(original, 'shown').selected, null);
  assert.equal(observeBrowserModel(status([tab('duplicate'), tab('duplicate')])).tabs.length, 0);
  assert.equal(observeBrowserModel({ available: true, signedBrowser: { available: true } }).available, false);
  assert.equal(observeBrowserModel({ ...original, recovery: { required: true, message: 'Inspect the prior action.' } }).blocked, true);
});

test('page frames, current control receipts, and screenshot coordinates are bounded and identity checked', () => {
  assert.equal(observeBrowserFrame(frame('one'), 'other'), null); assert.equal(observeBrowserFrame({ ...frame('one'), imageUrl: 'https://remote.test/image' }, 'one'), null);
  assert.equal(observeBrowserFrame({ ...frame('one'), width: 0 }, 'one'), null); assert.equal(observeBrowserFrame({ ...frame('one'), imageUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }, 'one'), null);
  assert.equal(observeBrowserDocument(documentFor('one'), 'other'), null);
  const observed = observeBrowserDocument({ tabId: 'one', frames: [{ text: 'x'.repeat(50000), elements: [{ ref: 'safe', name: '<script>label</script>', role: 'textbox', type: 'password', value: 'private-value' }, { ref: 'safe' }, { ref: 'disabled', disabled: true }] }] }, 'one');
  assert.equal(observed.text.length, 24000); assert.equal(observed.controls.length, 1); assert.ok(!JSON.stringify(observed).includes('private-value'));
  assert.deepEqual(observeBrowserPoint(frame('one'), { clientX: 330, clientY: 245 }, { left: 10, top: 20, width: 640, height: 450 }), { x: 640, y: 450 });
  assert.equal(observeBrowserPoint(frame('one'), { clientX: 650, clientY: 245 }, { left: 10, top: 20, width: 640, height: 450 }), null);
});

test('the actual public API client refreshes a real rendered contained frame and excludes native routes', async t => {
  const f = fixture(t, { initial: status([tab('one'), tab('native-window', { browser: 'neo' }), tab('shown', { visible: true })]) }); await f.ui.enter();
  assert.match(f.html, /Captured contained browser page/); assert.match(f.html, /Websites and their sign-ins stay in this contained browser/); assert.doesNotMatch(f.html, /value="native-window"|value="shown"|Open window/);
  assert.deepEqual(f.calls.map(call => [call.route, call.body?.action]), [['/api/browser/status', undefined], ['/api/browser/action', 'screenshot']]);
  assert.equal(f.element('observe-browser-url').value, 'https://example.test/one'); assert.ok(f.calls.every(call => call.signal instanceof AbortSignal));
});

test('five-second preview refresh is single flight and preserves an edited address with keyboard focus', async t => {
  const gate = deferred(); let held = false;
  const f = fixture(t, { handle: call => held && call.route === '/api/browser/status' ? gate.promise : undefined }); await f.ui.enter();
  const address = f.element('observe-browser-url'); address.value = 'https://draft.test/unfinished'; address.focus(); address.selectionStart = 8; address.selectionEnd = 12;
  held = true; f.advance(4999); f.ui.update(); assert.equal(f.calls.length, 2); f.advance(1); f.ui.update(); f.ui.update(); assert.equal(f.calls.length, 3);
  assert.equal(f.element('observe-browser-url').value, 'https://draft.test/unfinished'); assert.equal(f.focused.id, 'observe-browser-url'); assert.equal(f.focused.selectionStart, 8);
  f.element('observe-browser-url').value += '/newer'; gate.resolve(f.data.status); await flush();
  assert.equal(f.calls.length, 4); assert.equal(f.element('observe-browser-url').value, 'https://draft.test/unfinished/newer'); assert.equal(f.focused.id, 'observe-browser-url');
});

test('graphical clicks are mapped to the captured page and duplicate clicks cannot enqueue twice', async t => {
  const gate = deferred(); const f = fixture(t, { handle: call => call.body?.action === 'click' ? gate.promise : undefined }); await f.ui.enter();
  const first = f.click('point', { clientX: 330, clientY: 245 }); await flush(); await f.click('point', { clientX: 330, clientY: 245 });
  const clicks = f.calls.filter(call => call.body?.action === 'click'); assert.equal(clicks.length, 1); assert.deepEqual(clicks[0].body, { x: 640, y: 450, action: 'click', browser: 'relay', tabId: 'one' });
  gate.resolve(documentFor('one')); await first; assert.match(f.html, /Actual contained page text/);
});

test('observed controls allow actual field and option input without operating-system keys or focus routes', async t => {
  const f = fixture(t); await f.ui.enter(); await f.click('inspect');
  assert.match(f.html, /Message/); f.element('observe-browser-text').value = 'User-written text'; await f.click('fill');
  assert.deepEqual(f.calls.find(call => call.body?.action === 'fill').body, { ref: 'observed:text', text: 'User-written text', action: 'fill', browser: 'relay', tabId: 'one' }); assert.equal(f.element('observe-browser-text').value, '');
  await f.change('observe-browser-ref', 'observed:select'); f.element('observe-browser-value').value = ''; await f.click('fill');
  assert.equal(f.calls.find(call => call.body?.action === 'select').body.value, '', 'an observed empty option remains selectable');
  await f.change('observe-browser-key', 'Tab'); await f.click('key'); assert.equal(f.calls.find(call => call.body?.action === 'press').body.key, 'Tab');
  await f.click('down'); assert.equal(f.calls.find(call => call.body?.action === 'scroll').body.direction, 'down');
});

test('opening a website is contained and a hidden page cannot be acted on after it becomes visible', async t => {
  const f = fixture(t, { initial: status([]) }); await f.ui.enter(); f.element('observe-browser-url').value = 'https://example.test/new'; await f.submit();
  assert.deepEqual(f.calls.find(call => call.body?.action === 'open').body, { url: 'https://example.test/new', action: 'open', browser: 'relay' });
  assert.match(f.html, /Actual contained page text/, 'the new page keeps its actual post-open control receipt');
  f.data.status.tabs[0].visible = true; const count = f.calls.filter(call => call.body?.action === 'click').length; await f.click('point', { clientX: 50, clientY: 50 });
  assert.equal(f.calls.filter(call => call.body?.action === 'click').length, count); assert.match(f.html, /hidden BLACKICE page|no longer a hidden BLACKICE tab/);
});

test('closing a selected hidden page leaves other pages intact and then shows the next actual contained page', async t => {
  const f = fixture(t, { initial: status([tab('one'), tab('two'), tab('visible', { visible: true }), tab('firefox:outside', { browser: 'firefox' })]) }); await f.ui.enter();
  await f.click('close'); assert.deepEqual(f.calls.find(call => call.body?.action === 'close').body, { action: 'close', browser: 'relay', tabId: 'one' });
  assert.deepEqual(f.data.status.tabs.map(tab => tab.tabId), ['two','visible','firefox:outside']); assert.match(f.html, /Contained two/); assert.match(f.html, /Captured contained browser page/);
  await f.click('close'); assert.equal(f.calls.filter(call => call.body?.action === 'close').length, 2); assert.deepEqual(f.data.status.tabs.map(tab => tab.tabId), ['visible','firefox:outside']); assert.match(f.html, /Open a website here/); assert.equal(f.button('close'), undefined);
});

test('a page becoming visible between rendering and Close cannot receive the closing mutation', async t => {
  const f = fixture(t); await f.ui.enter(); f.data.status.tabs[0].visible = true; await f.click('close');
  assert.equal(f.calls.filter(call => call.body?.action === 'close').length, 0); assert.equal(f.data.status.tabs.length, 1);
});

test('keyboard focus returns to a page action after its temporarily disabled control is replaced', async t => {
  const f = fixture(t); await f.ui.enter(); f.button('inspect').focus(); await f.click('inspect'); assert.equal(f.focused.dataset.observeBrowser, 'inspect'); assert.equal(f.focused.disabled, false);
});

test('leaving aborts requests and late responses cannot capture, act, or repopulate a fresh entry', async t => {
  const gate = deferred(); let held = true; const f = fixture(t, { handle: call => held && call.route === '/api/browser/status' ? gate.promise : undefined });
  const pending = f.ui.enter(); await flush(); const initial = f.calls[0]; f.ui.leave(); assert.equal(initial.signal.aborted, true); assert.equal(f.html, '');
  held = false; await f.ui.enter(); const count = f.calls.length, writes = f.mount.writes; gate.resolve(status([tab('old-private-page')])); await pending;
  assert.equal(f.calls.length, count); assert.equal(f.mount.writes, writes); assert.doesNotMatch(f.html, /old-private-page/);
  f.ui.leave(); f.advance(20000); f.ui.update(); assert.equal(f.calls.length, count); assert.equal(f.html, '');
});

test('an accepted page click finishing after leave cannot dispatch follow-up reads or capture', async t => {
  const gate = deferred(); const f = fixture(t, { handle: call => call.body?.action === 'click' ? gate.promise : undefined }); await f.ui.enter();
  const pending = f.click('point', { clientX: 80, clientY: 90 }); await flush(); const count = f.calls.length; f.ui.leave(); gate.resolve(documentFor('one')); await pending;
  assert.equal(f.calls.length, count); assert.equal(f.html, '');
});

test('uncertain page input permits read-only recovery and never replays a possible submission', async t => {
  const f = fixture(t, { handle: call => { if (call.body?.action === 'click') throw Error('Response was lost.'); } }); await f.ui.enter(); await f.click('point', { clientX: 80, clientY: 90 });
  assert.match(f.html, /action may have completed/); assert.match(f.html, /Pause preview/); const count = f.calls.length; f.advance(1000); f.ui.update(); await flush(); assert.ok(f.calls.length > count);
  assert.equal(f.calls.filter(call => call.body?.action === 'click').length, 1); assert.match(f.html, /Captured contained browser page/);
  assert.match(f.html, /action may have completed/); assert.equal(f.button('point').disabled, false);
});

test('paused previews become visibly stale and cannot receive an old graphical click', async t => {
  const f = fixture(t); await f.ui.enter(); await f.click('watch'); f.advance(10001); f.ui.update(); assert.match(f.html, /Earlier frame/); assert.equal(f.button('point').disabled, true);
  await f.click('point', { clientX: 80, clientY: 90 }); assert.equal(f.calls.filter(call => call.body?.action === 'click').length, 0);
});

test('contained surface is available in Activity without fabricating a selected task', async t => {
  const elements = new Map(), listeners = new Map(), basic = () => ({ innerHTML: '', textContent: '', value: '', hidden: false, classList: { add() {}, toggle() {} }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, isConnected: true });
  const element = key => { if (!elements.has(key)) elements.set(key, basic()); return elements.get(key); }, mount = { ...basic(), hidden: false, querySelector: element, addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name), contains: () => false };
  const calls = [], ui = initObserveUI({ mount, getSnapshot: () => ({ runs: [], currentRun: null }), api: async route => { calls.push(route); return status([]); } }); t.after(() => ui.destroy()); ui.enter(); await flush();
  assert.equal(element('#observe-content').hidden, true); assert.match(element('#observe-browser').innerHTML, /Contained browser/); assert.equal(element('#observe-application-sessions').innerHTML, ''); assert.deepEqual(calls, ['/api/browser/status']); assert.equal(element('#observe-browser').hidden, false); assert.equal(element('#observe-application-sessions').hidden, true); ui.selectSurface('applications'); await flush(); assert.match(element('#observe-application-sessions').innerHTML, /Application sessions/); assert.equal(element('#observe-browser').hidden, true); assert.equal(element('#observe-application-sessions').hidden, false); assert.deepEqual(calls, ['/api/browser/status', '/api/application-sessions/status']);
  assert.doesNotMatch(mount.innerHTML, /Open Windows|data-observe-action="desktop"/);
});

test('browser surface renders page content as escaped text and never embeds a remote website iframe', () => {
  const html = renderObserveBrowser({ status: status([tab('unsafe', { title: '<img src=x onerror=alert(1)>' })]), document: { controls: [{ ref: 'unsafe" onclick="bad', name: '<script>bad</script>', role: 'textbox' }], text: '<svg onload=alert(1)>' }, address: 'https://example.test/?a=" onfocus="bad', watching: true });
  assert.doesNotMatch(html, /<iframe|<script|<svg|<img src=x|onclick="bad|onfocus="bad/); assert.match(html, /&lt;script&gt;/); assert.match(html, /&lt;svg/);
});
