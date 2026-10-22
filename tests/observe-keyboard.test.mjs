import test from 'node:test';
import assert from 'node:assert/strict';
import { initObserveBrowser } from '../public/observe-ui.mjs';
import { observeBrowserFrame, observeBrowserDocument, observeBrowserModel, observeBrowserInteraction } from '../public/observe-model.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const page = id => ({ tabId: id, browser: 'relay', visible: false, title: `Owned page ${id}`, url: `https://${id}.example.test/` });
async function fixture(t, { hook, identity = true, url, focusPage = false, chatGPTConversation = false, onOpenConnectionSettings, pickBrowserFiles } = {}) {
  const dom = planningDOM(t), calls = [], tabs = [page('one'), page('two')]; let clock = 0, currentHook = hook;
  if (url) tabs[0].url = url;
  const state = { available: true, acceptingActions: true, busy: false, browsers: { relay: { available: true } }, activeTab: 'one', tabs };
  const receipt = tabId => { const tab = tabs.find(tab => tab.tabId === tabId); return { tabId, url: tab?.url, documentId: `${tabId}:${tab?.revision || 1}`, receipt: { completed: true } }; };
  const api = async (route, options = {}) => {
    const call = { route, ...options }; calls.push(call);
    const overridden = await currentHook?.(call, { state, receipt }); if (overridden !== undefined) return overridden;
    if (route === '/api/browser/status?view=contained') return structuredClone(state);
    assert.equal(route, '/api/browser/action'); assert.equal(options.body.browser, 'relay');
    const { action, tabId } = options.body;
    if (action === 'screenshot') return { ...receipt(tabId), ...(identity ? {} : { documentId: undefined }), imageUrl: image, width: 1280, height: 900 };
    if (action === 'type' || action === 'press') return receipt(tabId);
    return { ...receipt(tabId), frames: [{ text: 'Owned fixture page', elements: [{ ref: 'unrelated-control', role: 'textbox', name: 'Other field' }] }] };
  };
  const ui = initObserveBrowser({ mount: dom.mount, api, now: () => clock, pickBrowserFiles, onOpenConnectionSettings });
  t.after(() => ui.destroy()); await ui.enter(focusPage ? { tabId: 'one', focusPage, chatGPTConversation } : {});
  return { ...dom, ui, calls, state, receipt, input: () => dom.$('#observe-browser-input'),
    mutations: () => calls.filter(call => ['type', 'press'].includes(call.body?.action)),
    async point() { const button = dom.$('[data-observe-browser="point"]'); return button.dispatch('click', { clientX: 100, clientY: 20 }, true); },
    async text(text, extra = {}) { const input = this.input(); input.value = text; await input.dispatch('input', { data: text, inputType: 'insertText', ...extra }, true); },
    async key(key, extra = {}) { return this.input().dispatch('keydown', { key, ...extra }, true); },
    async paste(text) { return this.input().dispatch('paste', { clipboardData: { getData(type) { assert.equal(type, 'text/plain'); return text; } } }, true); },
    async settle() { for (let i = 0; i < 8; i++) await tick(); },
    async poll(ms = 5001) { clock += ms; ui.update(); await this.settle(); },
    navigate(tabId, url) { const tab = tabs.find(tab => tab.tabId === tabId); tab.url = url || tab.url; tab.revision = (tab.revision || 1) + 1; return receipt(tabId); },
    hook(value) { currentHook = value; }
  };
}

test('observed frames and control documents retain bounded identity without inventing it', () => {
  const frame = { tabId: 'one', documentId: 'one:9', url: 'https://one.example.test/', width: 10, height: 10, imageUrl: image };
  assert.equal(observeBrowserFrame(frame, 'one').documentId, 'one:9');
  assert.equal(observeBrowserFrame({ ...frame, documentId: 'x'.repeat(257) }, 'one').documentId, undefined);
  assert.equal(observeBrowserDocument({ tabId: 'one', documentId: 'one:9', frames: [] }, 'one').documentId, 'one:9');
});

test('long sign-in URLs retain the exact identity used by guarded keyboard input', () => {
  const url = 'https://signin.example.test/authorize?state=' + 'x'.repeat(7000);
  const frame = { tabId: 'one', documentId: 'one:9', url, width: 10, height: 10, imageUrl: image };
  assert.equal(observeBrowserFrame(frame, 'one').url, url);
  assert.equal(observeBrowserModel({ available: true, tabs: [{ ...page('one'), url }] }, 'one').selected.url, url);
});

test('focused sign-in shows the page before optional tools and keeps long OAuth data out of page labels', async t => {
  const url = 'https://signin.example.test/authorize?state=' + 'x'.repeat(7000) + '#private-fragment';
  const f = await fixture(t, { url, focusPage: true });
  assert.equal(f.mount.classList.contains('observe-browser-focused'), true);
  assert.match(f.$('.observe-browser-heading').textContent, /Website sign-in/);
  assert.equal(f.$('.observe-browser-page-title span').textContent, 'https://signin.example.test/authorize');
  assert.ok(!f.$('.observe-browser-tab').getAttribute('title').includes('state='));
  assert.equal(f.$('#observe-browser-url').value, url, 'the authored address is not truncated');
  assert.equal(f.$('#observe-browser-tools').open, false);
  assert.equal(f.$('#observe-browser-page').closest('details'), null, 'the sign-in page is never inside collapsed tools');
  assert.ok(f.mount.innerHTML.indexOf('id="observe-browser-page"') < f.mount.innerHTML.indexOf('id="observe-browser-tools"'));
  assert.ok(f.mount.innerHTML.indexOf('id="observe-browser-input-help"') < f.mount.innerHTML.indexOf('id="observe-browser-image"'));
  assert.equal(f.document.activeElement, f.$('[data-observe-browser="point"]'), 'entry gives the visible page keyboard focus');
  assert.equal(f.$('#observe-browser-input-help').dataset.active, 'false');
  await f.point(); await f.text('Owned fixture input'); await f.settle();
  assert.equal(f.$('#observe-browser-input-help').dataset.active, 'true');
  assert.match(f.$('#observe-browser-input-help').textContent, /Typing goes to this page/);
  assert.equal(f.mutations()[0].body.expectedUrl, url, 'typing still guards against the exact OAuth URL');
  await f.key('Escape'); assert.equal(f.$('#observe-browser-input-help').dataset.active, 'false');
  await f.click('[data-observe-browser="tab"][data-tab-id="two"]');
  assert.equal(f.mount.classList.contains('observe-browser-focused'), false);
});

test('a popup opened by the current preview click is presented and closes back to its parent', async t => {
  const f = await fixture(t, { focusPage: true, hook(call, { state, receipt }) {
    if (call.body?.action !== 'click') return;
    state.tabs.push({ ...page('signin'), parentTabId: 'one' }); state.activeTab = 'signin';
    return receipt('one');
  } });
  await f.point(); await f.poll(1000);
  assert.equal(f.$('[role="tab"][aria-selected="true"]').dataset.tabId, 'signin');
  assert.equal(f.calls.filter(call => call.body?.action === 'screenshot').at(-1).body.tabId, 'signin');
  assert.equal(f.$('#observe-browser-url').value, 'https://signin.example.test/');
  assert.equal(f.$('#observe-browser-input-help').dataset.active, 'false', 'the old document cannot keep receiving keyboard input');
  assert.equal(f.mount.classList.contains('observe-browser-focused'), true, 'the sign-in remains in the visible focused page surface');
  f.state.activeTab = 'two'; await f.poll(1000);
  assert.equal(f.$('[role="tab"][aria-selected="true"]').dataset.tabId, 'signin', 'the initial exact-tab handoff must not pin the parent again');
  f.state.tabs.splice(f.state.tabs.findIndex(tab => tab.tabId === 'signin'), 1); await f.poll(1000);
  assert.equal(f.$('[role="tab"][aria-selected="true"]').dataset.tabId, 'one', 'closing sign-in returns to its opener instead of an unrelated neighbor');
  assert.equal(f.calls.filter(call => call.body?.action === 'click').length, 1);
  assert.equal(f.calls.filter(call => call.body?.action === 'screenshot').at(-1).body.tabId, 'one');
});

test('popup presentation ignores existing children and newly opened children of another page', async t => {
  const f = await fixture(t, { focusPage: true });
  f.state.tabs.push({ ...page('existing'), parentTabId: 'one' }); await f.poll();
  await f.point();
  f.state.tabs.push({ ...page('unrelated'), parentTabId: 'two' }); f.state.activeTab = 'unrelated'; await f.poll(1000);
  assert.equal(f.$('[role="tab"][aria-selected="true"]').dataset.tabId, 'one');
  f.state.activeTab = 'existing'; await f.poll(1000);
  assert.equal(f.$('[role="tab"][aria-selected="true"]').dataset.tabId, 'one');
  f.state.tabs.push({ ...page('signin'), parentTabId: 'one' }); await f.poll(1000);
  assert.equal(f.$('[role="tab"][aria-selected="true"]').dataset.tabId, 'signin');
});

test('a child observed before a queued click dispatches is not mistaken for its popup', async t => {
  const f = await fixture(t), gate = deferred();
  f.hook(call => call.route === '/api/browser/status?view=contained' ? gate.promise : undefined); await f.poll();
  await f.point();
  f.state.tabs.push({ ...page('existing'), parentTabId: 'one' }); f.state.activeTab = 'existing';
  f.hook(); gate.resolve(structuredClone(f.state)); await f.settle(); await f.poll(1000);
  assert.equal(f.calls.filter(call => call.body?.action === 'click').length, 1);
  assert.equal(f.$('[role="tab"][aria-selected="true"]').dataset.tabId, 'one');
});

test('a later manual tab selection cancels popup presentation from an unfinished click', async t => {
  const f = await fixture(t), gate = deferred();
  f.hook(call => call.body?.action === 'click' ? gate.promise : undefined);
  const clicking = f.point(); await tick();
  await f.click('[data-observe-browser="tab"][data-tab-id="two"]');
  f.state.tabs.push({ ...page('signin'), parentTabId: 'one' }); f.state.activeTab = 'signin';
  f.hook(); gate.resolve(f.receipt('one')); await clicking; await f.poll(1000);
  assert.equal(f.$('[role="tab"][aria-selected="true"]').dataset.tabId, 'two');
  assert.equal(f.calls.filter(call => call.body?.action === 'screenshot').at(-1).body.tabId, 'two');
});

test('an old completed gesture cannot make a later background popup replace its pinned page', async t => {
  const f = await fixture(t); await f.point();
  f.state.tabs.push({ ...page('late'), parentTabId: 'one' }); f.state.activeTab = 'late'; await f.poll(10001);
  assert.equal(f.$('[role="tab"][aria-selected="true"]').dataset.tabId, 'one');
});

test('popup discovery survives a slow pending activation and supports nested sign-in returning to a surviving ancestor', async t => {
  const f = await fixture(t, { focusPage: true }), gate = deferred();
  await f.point();
  f.hook(call => call.body?.action === 'press' ? gate.promise : undefined);
  await f.key('Enter'); await tick(); await f.poll(12000);
  f.state.tabs.push({ ...page('signin'), parentTabId: 'one' }); f.state.activeTab = 'signin';
  f.hook(); gate.resolve(f.receipt('one')); await f.settle(); await f.poll(1000);
  assert.equal(f.$('[role="tab"][aria-selected="true"]').dataset.tabId, 'signin');
  f.hook((call, { state, receipt }) => {
    if (call.body?.action !== 'click') return;
    state.tabs.push({ ...page('challenge'), parentTabId: 'signin' }); state.activeTab = 'challenge'; return receipt('signin');
  });
  await f.point(); await f.poll(1000);
  assert.equal(f.$('[role="tab"][aria-selected="true"]').dataset.tabId, 'challenge');
  f.state.tabs.splice(f.state.tabs.findIndex(tab => tab.tabId === 'signin'), 1); await f.poll(1000);
  f.state.tabs.splice(f.state.tabs.findIndex(tab => tab.tabId === 'challenge'), 1); f.state.activeTab = 'two'; await f.poll(1000);
  assert.equal(f.$('[role="tab"][aria-selected="true"]').dataset.tabId, 'one');
});

test('the focused ChatGPT conversation stays on its exact tab and returns to connection settings without a browser action', async t => {
  let settings = 0;
  const f = await fixture(t, { focusPage: true, chatGPTConversation: true, onOpenConnectionSettings() { settings++; } });
  assert.equal(f.$('.observe-browser-heading h2').textContent, 'ChatGPT in BLACKICE');
  assert.match(f.$('.observe-browser-heading p').textContent, /Manage BLACKICE tool access/);
  assert.equal(f.$('#observe-browser-follow').getAttribute('aria-pressed'), 'false');
  f.state.activeTab = 'two'; await f.poll();
  assert.ok(f.calls.filter(call => call.body?.action === 'screenshot').every(call => call.body.tabId === 'one'));
  assert.equal(f.calls.some(call => call.body && !['screenshot', 'snapshot'].includes(call.body.action)), false, 'entry and polling never type or submit anything');
  const before = f.calls.length;
  await f.click('[data-observe-browser="connection-settings"]');
  assert.equal(settings, 1); assert.equal(f.calls.length, before, 'the return action is local navigation');
  await f.click('[data-observe-browser="tab"][data-tab-id="two"]');
  assert.equal(f.$('.observe-browser-heading h2').textContent, 'Contained browser');
  assert.equal(f.$('[data-observe-browser="connection-settings"]'), null);
});

test('a conversation settings navigation error is visible without becoming a browser command', async t => {
  const f = await fixture(t, { focusPage: true, chatGPTConversation: true, onOpenConnectionSettings() { throw Error('Settings is still loading.'); } });
  const before = f.calls.length;
  await f.click('[data-observe-browser="connection-settings"]');
  assert.match(f.$('#observe-browser-status').textContent, /Settings is still loading/);
  assert.equal(f.calls.length, before);
});

test('Connection settings remains available while the preview is pending or the browser is unavailable', async t => {
  let settings = 0;
  const gate = deferred(), f = await fixture(t, { focusPage: true, chatGPTConversation: true, onOpenConnectionSettings() { settings++; } });
  f.hook(call => call.body?.action === 'screenshot' ? gate.promise : undefined);
  await f.poll(); assert.equal(f.mount.getAttribute('aria-busy'), 'true');
  assert.equal(f.$('[data-observe-browser="connection-settings"]').disabled, false);
  await f.click('[data-observe-browser="connection-settings"]'); assert.equal(settings, 1);
  f.hook(null); gate.resolve({ ...f.receipt('one'), imageUrl: image, width: 1280, height: 900 }); await f.settle();
  f.state.available = false; await f.poll();
  assert.equal(f.$('[data-observe-browser="connection-settings"]').disabled, false);
  await f.click('[data-observe-browser="connection-settings"]'); assert.equal(settings, 2);
});

test('a pending focused entry cannot take keyboard focus from a newly opened external input', async t => {
  const f = await fixture(t), gate = deferred();
  const outside = f.document.createElement('input'); outside.id = 'external-modal-input'; f.document.body.append(outside);
  f.hook(call => call.body?.action === 'screenshot' ? gate.promise : undefined);
  const entering = f.ui.enter({ tabId: 'one', focusPage: true }); await f.settle();
  outside.focus();
  f.hook(null); gate.resolve({ ...f.receipt('one'), imageUrl: image, width: 1280, height: 900 }); await entering;
  assert.equal(f.document.activeElement, outside);
});

test('a field click during a read-only preview refresh waits with its text and is never dropped', async t => {
  const f = await fixture(t), gate = deferred();
  await f.point(); await f.text('email'); await f.settle();
  const original = f.$('[data-observe-browser="point"]'), input = f.input();
  f.hook(call => call.body?.action === 'screenshot' ? gate.promise : undefined);
  await f.poll();
  assert.equal(f.mount.getAttribute('aria-busy'), 'true');
  assert.equal(f.$('[data-observe-browser="point"]'), original, 'refresh preserves the pointer target');
  assert.equal(original.disabled, false, 'a read-only refresh does not block the page');
  const before = f.calls.length;
  await f.point(); await f.text('password'); await f.settle();
  assert.equal(f.calls.length, before, 'the field click and text wait behind the in-flight read');
  assert.equal(f.document.activeElement, input);
  f.hook(null); gate.resolve({ ...f.receipt('one'), imageUrl: image, width: 1280, height: 900 }); await f.settle();
  assert.deepEqual(f.calls.slice(before).map(call => [call.body?.action, call.body?.text]), [['click', undefined], ['type', 'password']]);
  assert.equal(f.document.activeElement, input);
  assert.equal(f.input().value, '');
});

test('a first field click can capture keyboard input while its existing frame is being refreshed', async t => {
  const f = await fixture(t), gate = deferred();
  f.hook(call => call.body?.action === 'screenshot' ? gate.promise : undefined);
  await f.poll(); const before = f.calls.length;
  await f.point(); await f.text('first field');
  assert.equal(f.mutations().length, 0);
  f.hook(null); gate.resolve({ ...f.receipt('one'), imageUrl: image, width: 1280, height: 900 }); await f.settle();
  assert.deepEqual(f.calls.slice(before).map(call => [call.body?.action, call.body?.text]), [['click', undefined], ['type', 'first field']]);
});

test('navigation discovered during a preview refresh discards its queued old-document click and text', async t => {
  const f = await fixture(t), gate = deferred();
  f.hook(call => call.body?.action === 'screenshot' ? gate.promise : undefined);
  await f.poll(); await f.point(); await f.text('must not enter a different document');
  const before = f.calls.length;
  gate.resolve({ ...f.receipt('one'), documentId: 'one:2', imageUrl: image, width: 1280, height: 900 }); await f.settle();
  assert.equal(f.calls.length, before);
  assert.equal(f.mutations().length, 0);
  assert.equal(f.$('#observe-browser-input-help').dataset.active, 'false');
  assert.match(f.$('#observe-browser-status').textContent, /page changed/);
});

test('a screenshot completing between pointerdown and click never removes the pressed target', async t => {
  const f = await fixture(t), gate = deferred();
  f.hook(call => call.body?.action === 'screenshot' ? gate.promise : undefined);
  await f.poll();
  const button = f.$('[data-observe-browser="point"]'), imageNode = f.$('#observe-browser-image'), before = f.calls.length;
  await button.dispatch('pointerdown', { button: 0, pointerId: 1 }, true);
  f.hook(null); gate.resolve({ ...f.receipt('one'), imageUrl: image, width: 1280, height: 900 }); await f.settle();
  assert.equal(f.mount.getAttribute('aria-busy'), 'false', 'read completion stays observable while rendering is deferred');
  assert.equal(f.$('[data-observe-browser="point"]'), button);
  assert.equal(f.$('#observe-browser-image'), imageNode);
  assert.equal(button.isConnected, true);
  await f.page('pointerup'); await f.point(); await f.text('after physical click');
  await new Promise(resolve => setTimeout(resolve, 0)); await f.settle();
  assert.deepEqual(f.calls.slice(before).map(call => [call.body?.action, call.body?.text]), [['click', undefined], ['type', 'after physical click']]);
  assert.equal(f.document.activeElement, f.input());
});

test('a local browser-tools press keeps its native target through preview completion', async t => {
  const f = await fixture(t, { focusPage: true }), gate = deferred();
  await f.point();
  f.hook(call => call.body?.action === 'screenshot' ? gate.promise : undefined);
  await f.poll();
  const summary = f.$('#observe-browser-tools > summary');
  const press = await summary.dispatch('pointerdown', { button: 0, pointerId: 1 }, true);
  assert.equal(press.defaultPrevented, false, 'local controls retain native focus and activation');
  summary.focus();
  f.hook(null); gate.resolve({ ...f.receipt('one'), imageUrl: image, width: 1280, height: 900 }); await f.settle();
  assert.equal(f.mount.getAttribute('aria-busy'), 'false');
  assert.equal(summary.isConnected, true, 'a preview cannot detach the summary between native press and release');
  assert.equal(f.$('#observe-browser-tools > summary'), summary);
  await f.page('pointerup'); f.$('#observe-browser-tools').open = true;
  await new Promise(resolve => setTimeout(resolve, 0)); await f.settle();
  assert.equal(f.$('#observe-browser-tools').open, true);
  assert.equal(f.mutations().length, 0);
});

test('a protection-settings press stays attached while its pending site response completes', async t => {
  const f = await fixture(t), gate = deferred(), origin = new URL(f.state.tabs[0].url).origin;
  const protection = exempt => ({ available: true, enabled: true, ready: true, filterCount: 1000, tabs: f.state.tabs.map(tab => ({ tabId: tab.tabId, available: true, enabled: tab.tabId !== 'one' || !exempt, siteExempt: tab.tabId === 'one' && exempt, origin: new URL(tab.url).origin })) });
  f.state.protection = protection(true);
  f.state.tabs.forEach(tab => { tab.protection = f.state.protection.tabs.find(value => value.tabId === tab.tabId); });
  await f.poll();
  f.hook(call => {
    if (call.route !== '/api/browser/protection') return;
    assert.deepEqual(call.body, { action: 'site', tabId: 'one', origin, enabled: true });
    return gate.promise;
  });
  const pending = f.click('#observe-browser-site-protection'); await f.settle();
  const summary = f.$('#observe-browser-protection-settings > summary');
  const press = await summary.dispatch('pointerdown', { button: 0, pointerId: 1 }, true); summary.focus();
  assert.equal(press.defaultPrevented, false, 'the local disclosure retains native activation');
  gate.resolve(protection(false)); await pending;
  assert.equal(summary.isConnected, true, 'the response must not detach a physically pressed disclosure');
  assert.equal(f.$('#observe-browser-protection-settings > summary'), summary);
  assert.equal(f.document.activeElement, summary);
  await f.page('pointerup');
  const click = await summary.dispatch('click', {}, true); assert.equal(click.defaultPrevented, false);
  // The small DOM fixture supplies the browser's default details activation.
  summary.parentElement.open = true;
  await new Promise(resolve => setTimeout(resolve, 0)); await f.settle();
  assert.equal(f.$('#observe-browser-protection-settings').open, true);
  assert.equal(f.$('#observe-browser-global-protection').disabled, false);
  assert.equal(f.calls.filter(call => call.route === '/api/browser/protection').length, 1, 'disclosure activation never repeats the mutation');
});

test('a local address press remains attached and keeps normal input behavior through preview completion', async t => {
  const f = await fixture(t, { focusPage: true }), gate = deferred();
  f.$('#observe-browser-tools').open = true;
  await f.point();
  f.hook(call => call.body?.action === 'screenshot' ? gate.promise : undefined);
  await f.poll();
  const address = f.$('#observe-browser-url'), form = address.parentElement;
  const press = await address.dispatch('pointerdown', { button: 0, pointerId: 1 }, true);
  assert.equal(press.defaultPrevented, false, 'the address field receives native focus');
  address.focus();
  f.hook(null); gate.resolve({ ...f.receipt('one'), imageUrl: image, width: 1280, height: 900 }); await f.settle();
  assert.ok(address.parentElement === form, 'a local pointer gesture must not detach and reinsert the address input');
  assert.equal(f.document.activeElement, address);
  await f.page('pointerup'); await new Promise(resolve => setTimeout(resolve, 0)); await f.settle();
  address.value = 'https://local-only.example.test/';
  const before = await address.dispatch('beforeinput', { data: 'x', inputType: 'insertText', cancelable: true }, true);
  await address.dispatch('input', { data: 'x', inputType: 'insertText' }, true);
  assert.equal(before.defaultPrevented, false);
  assert.equal(address.value, 'https://local-only.example.test/');
  assert.equal(f.document.activeElement, address);
  assert.equal(f.mutations().length, 0);
});

test('a document or viewport change during a held pointer rejects the old click and releasing outside resumes rendering', async t => {
  for (const changed of [{ documentId: 'one:2' }, { width: 1000 }]) {
    const f = await fixture(t), gate = deferred();
    f.hook(call => call.body?.action === 'screenshot' ? gate.promise : undefined); await f.poll();
    const button = f.$('[data-observe-browser="point"]');
    await button.dispatch('pointerdown', { button: 0, pointerId: 1 }, true);
    f.hook(null); gate.resolve({ ...f.receipt('one'), imageUrl: image, width: 1280, height: 900, ...changed }); await f.settle();
    const before = f.calls.length;
    await f.point(); await f.text('not for the replacement page'); assert.equal(f.calls.length, before);
    await f.page('pointercancel');
    assert.notEqual(f.$('[data-observe-browser="point"]'), button, 'a release outside the pane unblocks its pending render');
    assert.equal(button.isConnected, false); assert.equal(f.input().value, '');
  }
});

test('rapid input waits for the graphical click and preserves text/key ordering without control refs', async t => {
  const gate = deferred();
  const f = await fixture(t, { hook: call => call.body?.action === 'click' ? gate.promise : undefined });
  const clicking = f.point(); await tick();
  assert.equal(f.document.activeElement, f.input()); const original = f.input();
  await f.text('a'); await f.text('b'); await f.key('Tab'); await f.text('OwnedFixturePassword');
  assert.equal(f.mutations().length, 0, 'keys cannot overtake the field click');
  assert.equal(f.input().value, '', 'captured text is cleared immediately');
  gate.resolve({ ...f.receipt('one'), frames: [] }); await clicking; await f.settle();
  assert.equal(f.input(), original); assert.equal(f.document.activeElement, original);
  assert.deepEqual(f.mutations().map(call => [call.body.action, call.body.text ?? call.body.key]), [['type', 'ab'], ['press', 'Tab'], ['type', 'OwnedFixturePassword']]);
  for (const { body } of f.mutations()) {
    assert.equal(body.tabId, 'one'); assert.equal(body.expectedUrl, 'https://one.example.test/'); assert.equal(body.expectedDocumentId, 'one:1'); assert.equal(Object.hasOwn(body, 'ref'), false);
  }
  assert.ok(!f.mount.innerHTML.includes('OwnedFixturePassword'));
});

test('a slow first type coalesces later characters while preserving editing keys and literal paste', async t => {
  const gate = deferred(); let first = true;
  const f = await fixture(t, { hook: call => { if (call.body?.action === 'type' && first) { first = false; return gate.promise; } } });
  await f.point(); await f.text('first'); await tick(); await f.text('x'); await f.text('y');
  await f.key('Backspace'); await f.key('End', { shiftKey: true }); await f.key('a', { ctrlKey: true });
  const pasted = await f.paste('Pasted ✓ 日本語'); assert.equal(pasted.defaultPrevented, true);
  assert.equal(f.mutations().length, 1);
  gate.resolve(f.receipt('one')); await f.settle();
  assert.deepEqual(f.mutations().map(call => [call.body.action, call.body.text ?? call.body.key, call.body.modifiers]), [
    ['type', 'first', undefined], ['type', 'xy', undefined], ['press', 'Backspace', []], ['press', 'End', ['Shift']], ['press', 'A', ['Control']], ['type', 'Pasted ✓ 日本語', undefined]
  ]);
  assert.equal(f.input().value, '');
});

test('continuous typing receives a bounded preview without waiting for a quiet pause', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t);
  await f.point();
  const captures = () => f.calls.filter(call => call.body?.action === 'screenshot').length;
  const initial = captures();
  for (const character of 'abcdefgh') {
    await f.text(character); await f.settle();
    t.mock.timers.tick(80); await f.settle();
  }
  assert.equal(f.mutations().map(call => call.body.text).join(''), 'abcdefgh');
  assert.equal(captures() - initial, 2, 'two coalesced previews during 640 ms of uninterrupted typing');
  assert.equal(f.document.activeElement, f.input());
  assert.equal(f.input().value, '');
});

test('a preview due during a slow key receipt starts as soon as ordered input finishes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t), gate = deferred();
  await f.point();
  const captures = () => f.calls.filter(call => call.body?.action === 'screenshot').length;
  const initial = captures();
  let first = true;
  f.hook(call => { if (call.body?.action === 'type' && first) { first = false; return gate.promise; } });
  await f.text('a'); await f.settle();
  t.mock.timers.tick(250); await f.settle();
  await f.text('b'); await f.key('Backspace'); await f.text('c');
  assert.equal(captures(), initial, 'a preview cannot overtake unconfirmed input');
  gate.resolve(f.receipt('one')); await f.settle();
  assert.deepEqual(f.mutations().map(call => [call.body.action, call.body.text ?? call.body.key]), [['type', 'a'], ['type', 'b'], ['press', 'Backspace'], ['type', 'c']]);
  assert.equal(captures(), initial + 1, 'the expired preview deadline must not restart another 250 ms timer');
  assert.equal(f.document.activeElement, f.input());
});

test('leaving clears a due input preview and late key completion cannot refresh a new session', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t), gate = deferred();
  await f.point();
  f.hook(call => call.body?.action === 'type' ? gate.promise : undefined);
  await f.text('old'); await f.settle(); t.mock.timers.tick(250); await f.settle();
  const sent = f.mutations()[0]; f.ui.leave(); assert.equal(sent.signal.aborted, true);
  f.hook(null); await f.ui.enter(); const count = f.calls.length;
  gate.resolve(f.receipt('one')); await f.settle(); t.mock.timers.tick(250); await f.settle();
  assert.equal(f.calls.length, count);
  assert.equal(f.$('#observe-browser-input-help').dataset.active, 'false');
});

test('a normal preview refresh consumes the pending input deadline without a duplicate capture', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t); await f.point(); await f.text('a'); await f.settle();
  await f.poll();
  const count = f.calls.filter(call => call.body?.action === 'screenshot').length;
  t.mock.timers.tick(250); await f.settle();
  assert.equal(f.calls.filter(call => call.body?.action === 'screenshot').length, count);
});

test('input preview deadlines never overlap a slow capture or reorder its queued text', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t), gate = deferred();
  await f.point();
  f.hook(call => call.body?.action === 'screenshot' ? gate.promise : undefined);
  t.mock.timers.tick(250); await f.settle();
  const captures = f.calls.filter(call => call.body?.action === 'screenshot').length;
  await f.text('abc'); await f.text('def'); await f.settle();
  t.mock.timers.tick(1000); await f.settle();
  assert.equal(f.calls.filter(call => call.body?.action === 'screenshot').length, captures);
  assert.equal(f.mutations().length, 0, 'input remains behind the in-flight read');
  f.hook(null); gate.resolve({ ...f.receipt('one'), imageUrl: image, width: 1280, height: 900 }); await f.settle();
  assert.deepEqual(f.mutations().map(call => call.body.text), ['abcdef']);
  assert.equal(f.document.activeElement, f.input());
});

test('a lightweight guarded click receipt releases text and refreshes independently without a DOM snapshot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t, { hook: (call, { receipt }) => call.body?.action === 'click' ? { ...receipt(call.body.tabId), receipt: { clicked: true, input: 'browser protocol' } } : undefined });
  await f.point(); await f.text('field input'); await f.settle();
  assert.equal(f.mutations()[0].body.text, 'field input');
  assert.equal(f.mutations()[0].body.expectedDocumentId, 'one:1');
  t.mock.timers.tick(250); await f.settle();
  assert.deepEqual(f.calls.filter(call => call.body).map(call => call.body.action), ['screenshot', 'click', 'type', 'screenshot']);
  assert.equal(f.$('#observe-browser-input-help').dataset.active, 'true');
});

test('cancelable native text is forwarded before editing the hidden textarea can scroll its caret', async t => {
  const gate = deferred(), f = await fixture(t, { hook: call => call.body?.action === 'click' ? gate.promise : undefined });
  const clicking = f.point(); await tick(); const input = f.input();
  for (const [inputType, data] of [['insertText', 'a'], ['insertText', 'b'], ['insertReplacementText', ' ✓']]) {
    const event = await input.dispatch('beforeinput', { inputType, data, cancelable: true }, true);
    assert.equal(event.defaultPrevented, true, 'native editing must be canceled before the browser reveals the caret');
    assert.equal(event.stopped, true); assert.equal(input.value, '');
  }
  assert.equal(f.mutations().length, 0, 'text still waits for the original page click');
  gate.resolve(f.receipt('one')); await clicking; await f.settle();
  assert.deepEqual(f.mutations().map(call => [call.body.action, call.body.text]), [['type', 'ab ✓']]);
});

test('noncancelable and data-less native insertions retain the input fallback without duplicate dispatch', async t => {
  const f = await fixture(t); await f.point(); const input = f.input();
  const noncancelable = await input.dispatch('beforeinput', { inputType: 'insertText', data: 'fallback', cancelable: false }, true);
  assert.equal(noncancelable.defaultPrevented, false); assert.equal(f.mutations().length, 0);
  await f.text('fallback'); await f.settle();
  const missing = await input.dispatch('beforeinput', { inputType: 'insertText', data: null, cancelable: true }, true);
  assert.equal(missing.defaultPrevented, false);
  await f.text('from native value'); await f.settle();
  assert.deepEqual(f.mutations().map(call => call.body.text), ['fallback', 'from native value']);
});

test('IME stays native while composing and a cancelable final insertion is not sent twice', async t => {
  const f = await fixture(t); await f.point(); const input = f.input();
  await input.dispatch('compositionstart', {}, true);
  const interim = await input.dispatch('beforeinput', { inputType: 'insertCompositionText', data: 'に', isComposing: true, cancelable: true }, true);
  assert.equal(interim.defaultPrevented, false);
  await f.text('に', { isComposing: true, inputType: 'insertCompositionText' });
  await f.poll(); assert.equal(f.mutations().length, 0); assert.equal(f.input(), input);
  await input.dispatch('compositionend', { data: '日本語' }, true);
  const committed = await input.dispatch('beforeinput', { inputType: 'insertFromComposition', data: '日本語', cancelable: true }, true);
  assert.equal(committed.defaultPrevented, true);
  await f.settle(); assert.deepEqual(f.mutations().map(call => call.body.text), ['日本語']); assert.equal(input.value, '');
  await input.dispatch('beforeinput', { inputType: 'insertText', data: '日本語', cancelable: true }, true); await f.settle();
  assert.deepEqual(f.mutations().map(call => call.body.text), ['日本語', '日本語'], 'the next intentional repeated text is not swallowed');
});

test('a pointer field switch is an ordered barrier between earlier and later rapid text', async t => {
  const gate = deferred(); let held = true;
  const f = await fixture(t, { hook: call => call.body?.action === 'type' && held ? gate.promise : undefined });
  await f.point(); await f.text('email text'); await tick();
  const switching = f.point(); await f.text('password text'); await tick();
  assert.deepEqual(f.calls.filter(call => ['click', 'type'].includes(call.body?.action)).map(call => [call.body.action, call.body.text]), [['click', undefined], ['type', 'email text']]);
  held = false; gate.resolve(f.receipt('one')); await switching; await f.settle();
  assert.deepEqual(f.calls.filter(call => ['click', 'type'].includes(call.body?.action)).map(call => [call.body.action, call.body.text]), [['click', undefined], ['type', 'email text'], ['click', undefined], ['type', 'password text']]);
  for (const { body } of f.calls.filter(call => call.body?.action === 'click')) {
    assert.equal(body.expectedUrl, 'https://one.example.test/'); assert.equal(body.expectedDocumentId, 'one:1');
  }
});

test('a rejected field click never releases queued text into a previously focused field', async t => {
  const gate = deferred(); const f = await fixture(t, { hook: async call => { if (call.body?.action === 'click') { await gate.promise; throw Error('Contained browser busy.'); } } });
  const clicking = f.point(); await tick(); await f.text('must not reach old field'); gate.resolve(); await clicking; await f.settle();
  assert.equal(f.mutations().length, 0); assert.match(f.mount.textContent, /Page input could not be confirmed/);
});

test('IME composition commits once and does not lose its focused native textarea to a poll', async t => {
  const f = await fixture(t); await f.point(); const input = f.input();
  await input.dispatch('compositionstart', {}, true); await f.text('に', { isComposing: true, inputType: 'insertCompositionText' });
  const before = f.calls.length; await f.poll(); assert.equal(f.calls.length, before); assert.equal(f.input(), input); assert.equal(input.value, 'に');
  await input.dispatch('compositionend', { data: '日本語' }, true);
  await f.text('日本語', { inputType: 'insertFromComposition' }); await f.settle();
  assert.deepEqual(f.mutations().map(call => call.body.text), ['日本語']); assert.equal(input.value, '');
  await f.poll(); assert.equal(f.input(), input); assert.equal(f.document.activeElement, input);
});

test('local controls and application shortcuts retain keyboard ownership, and Escape releases page capture', async t => {
  const f = await fixture(t); await f.point();
  for (const key of ['k', 'm']) {
    const event = await f.key(key, { ctrlKey: true }); assert.equal(event.defaultPrevented, false); assert.equal(event.stopped, undefined);
  }
  const escaped = await f.key('Escape'); assert.equal(escaped.defaultPrevented, true); assert.equal(f.document.activeElement.dataset.observeBrowser, 'point');
  const address = f.$('#observe-browser-url'); address.focus(); address.value = 'https://local-draft.example/';
  await address.dispatch('input', { data: 'address text' }, true); await address.dispatch('keydown', { key: 'Enter' }, true);
  await address.dispatch('paste', { clipboardData: { getData: () => 'Local paste' } }, true); await f.settle();
  assert.equal(f.mutations().length, 0); assert.equal(address.value, 'https://local-draft.example/');
});

test('focus loss discards queued input and does not reuse an observed controls-panel selection', async t => {
  const gate = deferred(); const f = await fixture(t, { hook: call => call.body?.action === 'type' ? gate.promise : undefined });
  await f.click('[data-observe-browser="inspect"]'); await f.point();
  await f.text('already dispatched'); await f.text('must not dispatch');
  const input = f.input(), address = f.$('#observe-browser-url'); address.focus(); await input.dispatch('focusout', { relatedTarget: address }, true);
  gate.resolve(f.receipt('one')); await f.settle();
  assert.equal(f.mutations().length, 1); assert.equal(f.mutations()[0].signal.aborted, true); assert.equal(f.document.activeElement, address);
  assert.equal(Object.hasOwn(f.mutations()[0].body, 'ref'), false);
});

test('a document change clears remaining keys, refreshes automatically and captures only a newly clicked field', async t => {
  const gate = deferred(); const f = await fixture(t, { hook: call => call.body?.action === 'type' ? gate.promise : undefined });
  await f.point(); await f.text('first'); await f.text('not on the next page');
  gate.resolve(f.navigate('one')); await f.settle();
  assert.equal(f.mutations().length, 1); assert.match(f.mount.textContent, /Click its next field/);
  assert.equal(f.$('[data-observe-browser="point"]').disabled, false);
  await f.poll(1000); assert.equal(f.mutations().length, 1);
  assert.equal(f.input().value, '');
  f.hook(); await f.point(); await f.text('next field'); await f.settle();
  assert.equal(f.mutations().at(-1).body.expectedDocumentId, 'one:2');
  assert.equal(f.mutations().at(-1).body.text, 'next field');
});

test('Enter and Next document changes progress without replaying a submission or queued text', async t => {
  for (const action of ['press', 'click']) {
    const gate = deferred(), f = await fixture(t, { focusPage: true }); await f.point();
    f.hook(call => call.body?.action === action ? gate.promise : undefined);
    const submitted = action === 'press' ? f.key('Enter') : f.point();
    await tick(); await f.text('discard this old-page text');
    gate.resolve(f.navigate('one', 'https://one.example.test/password')); await submitted; await f.settle();
    assert.equal(f.calls.filter(call => call.body?.action === action).length, action === 'click' ? 2 : 1);
    assert.equal(f.calls.filter(call => call.body?.action === 'type').length, 0);
    assert.equal(f.$('#observe-browser-url').value, 'https://one.example.test/password');
    assert.equal(f.$('[data-observe-browser="point"]').disabled, false);
    f.hook(); await f.point(); await f.text('owned password'); await f.settle();
    assert.deepEqual(f.mutations().at(-1).body, { action: 'type', text: 'owned password', browser: 'relay', tabId: 'one', expectedUrl: 'https://one.example.test/password', expectedDocumentId: 'one:2' });
    f.ui.destroy();
  }
});

test('late redirects and same-URL document changes are discovered by fast read-only sign-in previews', async t => {
  const f = await fixture(t, { focusPage: true }); await f.point(); await f.key('Enter'); await f.settle();
  const sent = f.mutations().length, reads = f.calls.filter(call => call.body?.action === 'screenshot').length;
  f.navigate('one', 'https://one.example.test/redirected'); await f.poll(1000);
  assert.equal(f.$('#observe-browser-url').value, 'https://one.example.test/redirected');
  assert.equal(f.$('[data-observe-browser="point"]').disabled, false);
  assert.equal(f.calls.filter(call => call.body?.action === 'screenshot').length, reads + 1);
  assert.equal(f.mutations().length, sent);
  await f.point(); f.navigate('one'); await f.poll(1000);
  assert.equal(f.$('#observe-browser-input-help').dataset.active, 'false');
  await f.point(); await f.text('new document'); await f.settle();
  assert.equal(f.mutations().at(-1).body.expectedDocumentId, 'one:3');
});

test('same-document delayed forms refresh without stealing an external field or resending input', async t => {
  const f = await fixture(t, { focusPage: true }); await f.point(); await f.key('Enter'); await f.settle();
  const sent = f.mutations().length, oldImage = f.$('#observe-browser-image');
  const external = f.document.createElement('input'); f.document.body.append(external); external.focus();
  await f.poll(1000);
  assert.notEqual(f.$('#observe-browser-image'), oldImage, 'a fresh screenshot is presented even without a URL/document change');
  assert.equal(f.document.activeElement, external);
  assert.equal(f.mutations().length, sent);
});

test('transient preview failures retry reads with backoff and never resume an old input queue', async t => {
  const f = await fixture(t, { focusPage: true }); await f.point(); let failures = 2;
  f.hook(call => { if (call.body?.action === 'screenshot' && failures-- > 0) throw Error('Renderer is navigating.'); });
  await f.poll(1000); assert.equal(f.$('[data-observe-browser="point"]').disabled, true);
  assert.match(f.mount.textContent, /retry automatically/);
  const failedReads = f.calls.length; await f.poll(999); assert.equal(f.calls.length, failedReads);
  await f.poll(1); assert.match(f.mount.textContent, /retry automatically/);
  const secondReads = f.calls.length; await f.poll(1999); assert.equal(f.calls.length, secondReads);
  await f.poll(1); assert.equal(f.$('[data-observe-browser="point"]').disabled, false);
  assert.equal(f.$('#observe-browser-input-help').dataset.active, 'false');
  assert.equal(f.mutations().length, 0);
  await f.point(); await f.text('after recovery'); await f.settle(); assert.equal(f.mutations().length, 1);
});

test('an uncertain submission keeps a visible outcome warning while read-only recovery continues', async t => {
  const f = await fixture(t, { focusPage: true }); await f.point();
  f.hook(call => { if (call.body?.action === 'press') throw Error('Response lost after dispatch.'); });
  await f.key('Enter'); await f.settle();
  assert.match(f.mount.textContent, /Page input could not be confirmed/);
  assert.equal(f.$('[data-observe-browser="point"]').disabled, false);
  const reads = f.calls.filter(call => call.body?.action === 'screenshot').length;
  await f.poll(1000);
  assert.equal(f.calls.filter(call => call.body?.action === 'screenshot').length, reads + 1);
  assert.equal(f.mutations().length, 1); assert.match(f.mount.textContent, /Some input may have reached/);
});

test('leaving or selecting another tab cannot deliver pending keys to a replacement page', async t => {
  for (const leave of [true, false]) {
    const gate = deferred(); const f = await fixture(t, { hook: call => call.body?.action === 'type' ? gate.promise : undefined });
    await f.point(); await f.text('first'); await f.text('discarded');
    if (leave) f.ui.leave(); else await f.click('[data-observe-browser="tab"][data-tab-id="two"]');
    const count = f.calls.length; gate.resolve(f.receipt('one')); await f.settle();
    assert.equal(f.mutations().length, 1); assert.equal(f.mutations()[0].signal.aborted, true); assert.equal(f.calls.length, count);
    if (leave) assert.equal(f.mount.innerHTML, ''); else assert.equal(f.$('[role="tab"][aria-selected="true"]').dataset.tabId, 'two');
  }
});

test('missing document identity and oversized paste never create a guessed input target', async t => {
  const missing = await fixture(t, { identity: false }); await missing.point(); await missing.text('No document identity'); await missing.settle(); assert.equal(missing.mutations().length, 0);
  const bounded = await fixture(t); await bounded.point(); await bounded.paste('x'.repeat(16385)); await bounded.settle();
  assert.equal(bounded.mutations().length, 0); assert.equal(bounded.input().value, ''); assert.match(bounded.mount.textContent, /16,384/);
});

const interactionFor = (kind = 'javascript_dialog', extra = {}) => ({ id: 'owned-interaction-1', kind, tabId: 'one', url: 'https://one.example.test/', documentId: 'one:1', status: 'pending', message: 'Owned page request', ...(kind === 'javascript_dialog' ? { dialogType: 'prompt', defaultPrompt: 'Initial value' } : {}), ...extra });

test('only bounded, document-bound interactions become actionable in the browser model', () => {
  const valid = interactionFor(); assert.equal(observeBrowserInteraction(valid, 'one').id, valid.id);
  for (const value of [{ ...valid, id: '' }, { ...valid, documentId: '' }, { ...valid, tabId: 'two' }, { ...valid, dialogType: 'guessed' }, interactionFor('http_auth')]) assert.equal(observeBrowserInteraction(value, 'one'), null);
  assert.equal(observeBrowserModel({ available: true, browsers: { relay: { available: true } }, tabs: [{ ...page('one'), inputWarning: 'A site might need sign-in' }] }).selected.pendingInteraction, null);
});

test('a page dialog preserves a local prompt draft across status polling and accepts only the explicit guarded answer', async t => {
  const f = await fixture(t); const interaction = interactionFor();
  f.state.tabs[0].pendingInteraction = interaction;
  const screenshots = f.calls.filter(call => call.body?.action === 'screenshot').length;
  await f.poll(); assert.equal(f.$('[data-observe-browser="point"]').disabled, true);
  const input = f.$('#observe-browser-dialog-text'); assert.equal(input.value, 'Initial value'); input.focus(); input.value = 'Human response';
  await f.poll(1000);
  assert.equal(f.$('#observe-browser-dialog-text'), input); assert.equal(input.value, 'Human response'); assert.equal(f.document.activeElement, input);
  assert.equal(f.calls.filter(call => call.body?.action === 'screenshot').length, screenshots, 'a paused page is not probed for DOM/screenshot work');
  f.hook(call => { if (call.body?.action === 'interaction') { delete f.state.tabs[0].pendingInteraction; return f.receipt('one'); } });
  await f.click('[data-decision="accept"]'); await f.settle();
  assert.deepEqual(f.calls.filter(call => call.body?.action === 'interaction').map(call => call.body), [{ action: 'interaction', browser: 'relay', tabId: 'one', interactionId: interaction.id, decision: 'accept', expectedUrl: interaction.url, expectedDocumentId: interaction.documentId, promptText: 'Human response' }]);
  assert.equal(f.$('#observe-browser-interaction'), null); assert.equal(f.$('[data-observe-browser="point"]').disabled, false);
});

test('blocked HTTP authentication only offers acknowledgment and never collects or retries credentials', async t => {
  const f = await fixture(t); f.state.tabs[0].pendingInteraction = interactionFor('http_auth', { status: 'blocked', message: '<script>not executable</script>', reason: 'Native HTTP authentication was canceled.' });
  await f.poll(); assert.equal(f.$('[data-decision="accept"]'), null); assert.equal(f.$('#observe-browser-dialog-text'), null);
  assert.equal(f.$('#observe-browser-interaction script'), null); assert.match(f.mount.textContent, /does not repeat the page action/);
  f.hook(call => { if (call.body?.action === 'interaction') { delete f.state.tabs[0].pendingInteraction; return f.receipt('one'); } });
  await f.click('[data-decision="acknowledge"]');
  const command = f.calls.find(call => call.body?.action === 'interaction').body;
  assert.equal(command.decision, 'acknowledge'); assert.equal(Object.hasOwn(command, 'promptText'), false);
  assert.equal(f.mutations().length, 0);
});

test('an input receipt opening a real dialog drops subsequent text and presents that exact interaction', async t => {
  const gate = deferred(), f = await fixture(t); await f.point();
  f.hook(call => call.body?.action === 'type' ? gate.promise : undefined);
  await f.text('first'); await f.text('never into a dialog');
  f.state.tabs[0].pendingInteraction = interactionFor('javascript_dialog', { dialogType: 'confirm' });
  gate.resolve({ ...f.receipt('one'), pendingInteraction: f.state.tabs[0].pendingInteraction }); await f.settle();
  assert.equal(f.mutations().length, 1); assert.equal(f.$('#observe-browser-input-help').dataset.active, 'false');
  assert.equal(f.$('[data-decision="dismiss"]').dataset.interactionId, 'owned-interaction-1');
  await f.poll(); assert.equal(f.mutations().length, 1);
});

test('a file request uploads only explicitly selected paths to its observed chooser and document', async t => {
  const picked = ['C:\\Owned\\chosen.txt']; let pickerCalls = 0;
  const f = await fixture(t, { pickBrowserFiles: async options => { pickerCalls++; assert.deepEqual(options, { multiple: false }); return picked; } });
  const interaction = interactionFor('file_chooser', { multiple: false }); f.state.tabs[0].pendingInteraction = interaction; await f.poll();
  f.hook(call => { if (call.body?.action === 'upload') { delete f.state.tabs[0].pendingInteraction; return f.receipt('one'); } });
  await f.click('[data-decision="upload"]'); await f.settle();
  assert.equal(pickerCalls, 1);
  assert.deepEqual(f.calls.filter(call => call.body?.action === 'upload').map(call => call.body), [{ action: 'upload', browser: 'relay', tabId: 'one', chooserId: interaction.id, paths: picked, expectedUrl: interaction.url, expectedDocumentId: interaction.documentId }]);
  assert.equal(f.$('#observe-browser-interaction'), null);
});

test('canceling file choice or selecting too many files never submits an upload', async t => {
  let picked = [], count = 0; const f = await fixture(t, { pickBrowserFiles: async () => { count++; return picked; } });
  f.state.tabs[0].pendingInteraction = interactionFor('file_chooser', { multiple: false }); await f.poll();
  await f.click('[data-decision="upload"]'); assert.equal(f.calls.filter(call => call.body?.action === 'upload').length, 0);
  picked = ['C:\\Owned\\one.txt', 'C:\\Owned\\two.txt']; await f.click('[data-decision="upload"]');
  assert.match(f.mount.textContent, /accepts one file/); assert.equal(count, 2); assert.equal(f.calls.filter(call => call.body?.action === 'upload').length, 0);
  assert.ok(f.$('[data-decision="dismiss"]'));
});

test('file choice cannot cross a tab change, document change, or closed Activity view', async t => {
  for (const change of ['tab', 'document', 'leave']) {
    const gate = deferred(), f = await fixture(t, { pickBrowserFiles: () => gate.promise });
    f.state.tabs[0].pendingInteraction = interactionFor('file_chooser'); await f.poll();
    const picking = f.click('[data-decision="upload"]'); await tick();
    if (change === 'tab') await f.click('[data-observe-browser="tab"][data-tab-id="two"]');
    else if (change === 'document') { f.navigate('one'); f.state.tabs[0].pendingInteraction.documentId = 'one:2'; await f.poll(); }
    else f.ui.leave();
    gate.resolve(['C:\\Owned\\chosen.txt']); await picking; await f.settle();
    assert.equal(f.calls.filter(call => call.body?.action === 'upload').length, 0, change + ' invalidates file selection');
    f.ui.destroy();
  }
});

test('a lost dialog response resumes only page reads and never repeats acceptance', async t => {
  const f = await fixture(t); f.state.tabs[0].pendingInteraction = interactionFor('javascript_dialog', { dialogType: 'confirm' }); await f.poll();
  f.hook(call => { if (call.body?.action === 'interaction') { delete f.state.tabs[0].pendingInteraction; throw Error('The dialog response was lost.'); } });
  await f.click('[data-decision="accept"]'); await f.poll(1000);
  assert.equal(f.calls.filter(call => call.body?.action === 'interaction').length, 1);
  assert.equal(f.$('#observe-browser-interaction'), null); assert.equal(f.$('[data-observe-browser="point"]').disabled, false);
  assert.match(f.mount.textContent, /action may have completed/);
});

test('a status poll completing during a physical dialog-button press retains its target and validates the interaction ID', async t => {
  for (const changed of [false, true]) {
    const f = await fixture(t), gate = deferred();
    f.state.tabs[0].pendingInteraction = interactionFor('javascript_dialog', { dialogType: 'confirm' }); await f.poll();
    const button = f.$('[data-decision="accept"]'); await button.dispatch('pointerdown', { button: 0, pointerId: 1 }, true);
    f.hook(call => call.route === '/api/browser/status?view=contained' ? gate.promise : undefined); await f.poll(1000);
    if (changed) f.state.tabs[0].pendingInteraction.id = 'replacement-interaction';
    gate.resolve(structuredClone(f.state)); await f.settle();
    assert.equal(f.mount.getAttribute('aria-busy'), 'false'); assert.equal(f.$('[data-decision="accept"]'), button); assert.equal(button.isConnected, true);
    f.hook(call => { if (call.body?.action === 'interaction') { delete f.state.tabs[0].pendingInteraction; return f.receipt('one'); } });
    await f.page('pointerup'); await button.dispatch('click', {}, true); await new Promise(resolve => setTimeout(resolve, 0)); await f.settle();
    assert.equal(f.calls.filter(call => call.body?.action === 'interaction').length, changed ? 0 : 1);
    if (changed) assert.equal(f.$('[data-decision="accept"]').dataset.interactionId, 'replacement-interaction');
    f.ui.destroy();
  }
});
