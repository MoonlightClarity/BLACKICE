import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BROWSER_ACTIONS, BrowserWorkspace, createBrowserToolHandler } from '../lib/browser.mjs';
import { BrowserRouter } from '../desktop/browser-router.mjs';
import { DirectExecutionAPI, DIRECT_EXECUTION_SCOPES } from '../lib/direct-execution-api.mjs';

const held = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const call = arguments_ => ({ name: 'relay_browser', arguments: arguments_ });
const json = value => JSON.parse(value.contentItems[0].text);
const client = { id: 'owned-connector', kind: 'chatgpt', label: 'ChatGPT', scopes: [...DIRECT_EXECUTION_SCOPES] };
const privateMarker = 'HUMAN-CONVERSATION-MUST-NOT-CROSS';

class Driver extends EventEmitter {
  constructor() {
    super(); this.activeTab = 'chat'; this.calls = [];
    this.tabs = new Map([
      ['chat', { tabId: 'chat', purpose: 'chat-mode', url: 'https://chatgpt.com/c/owned', title: privateMarker }],
      ['work', { tabId: 'work', url: 'https://example.test/work', title: 'Ordinary work' }],
    ]);
  }
  status() {
    return { available: true, contained: true, activeTab: this.activeTab, tabs: [...this.tabs.values()].map(tab => ({ ...tab })),
      downloads: [{ tabId: 'chat', name: privateMarker }, { tabId: 'work', name: 'ordinary.txt' }, { tabId: 'closed-chat', name: privateMarker }, { name: privateMarker }],
      diagnostics: { failedRequests: [{ origin: privateMarker }] }, protection: { sites: [privateMarker] } };
  }
  async perform(args, options) {
    this.calls.push({ args: { ...args }, source: options.source });
    if (this.onPerform) return this.onPerform(args, options);
    if (args.action === 'open') { this.tabs.set('new', { tabId: 'new', url: args.url }); this.activeTab = 'new'; return { tabId: 'new', ...this.status() }; }
    if (args.action === 'tabs') return this.status();
    if (args.action === 'downloads') return { downloads: this.status().downloads };
    if (args.action === 'close') { this.tabs.delete(args.tabId); this.activeTab = 'chat'; return this.status(); }
    return { tabId: args.tabId, frames: [{ text: args.tabId === 'chat' ? privateMarker : 'Observed ordinary page' }] };
  }
  async close() {}
}

function fixture(t) {
  const driver = new Driver(), router = new BrowserRouter({ independent: driver }), browser = new BrowserWorkspace({ driver: router });
  t.after(() => browser.close());
  return { driver, router, browser, handler: createBrowserToolHandler({ browser }) };
}

function request(action, tabId = 'chat') {
  return { action, browser: 'relay', tabId,
    ...(['open', 'navigate'].includes(action) ? { url: 'https://example.test/' } : {}),
    ...(['fill', 'select', 'click', 'hover', 'upload'].includes(action) ? { ref: 'observed-ref' } : {}),
    ...(['fill', 'type', 'wait'].includes(action) ? { text: 'Owned test input' } : {}),
    ...(action === 'select' ? { value: 'selected' } : {}),
    ...(action === 'press' ? { key: 'Enter' } : {}),
    ...(action === 'type' ? { expectedUrl: 'https://chatgpt.com/c/owned', expectedDocumentId: 'chat:1' } : {}),
    ...(action === 'upload' ? { paths: ['/owned/file.txt'] } : {}),
  };
}

test('every tool action rejects an explicit human ChatGPT tab before reaching its adapter', async t => {
  const { driver, browser, handler } = fixture(t);
  for (const action of BROWSER_ACTIONS.filter(action => action !== 'interaction')) {
    await assert.rejects(browser.perform(request(action)), { code: 'BROWSER_HUMAN_CHAT_RESERVED', actionDispatched: false }, action);
    const result = await handler(call(request(action)));
    assert.equal(result.success, false, action); assert.equal(json(result).code, 'BROWSER_HUMAN_CHAT_RESERVED', action);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(privateMarker));
  }
  assert.deepEqual(driver.calls, []);
});

test('active human tab defaults are denied while listing and ordinary new tabs stay usable', async t => {
  const { driver, handler } = fixture(t);
  for (const action of ['snapshot', 'read', 'screenshot', 'click', 'navigate', 'back', 'forward', 'reload', 'close', 'wait']) {
    const args = request(action); delete args.tabId;
    const result = await handler(call(args)); assert.equal(result.success, false, action); assert.equal(json(result).code, 'BROWSER_HUMAN_CHAT_RESERVED', action);
  }
  assert.equal(driver.calls.length, 0);
  const tabs = json(await handler(call({ action: 'tabs' })));
  assert.deepEqual(tabs.tabs.map(tab => tab.tabId), ['work']); assert.equal(tabs.activeTab, null);
  assert.doesNotMatch(JSON.stringify(tabs), new RegExp(privateMarker));
  const opened = await handler(call({ action: 'open', url: 'https://chatgpt.com/c/ordinary-user-request' }));
  assert.equal(opened.success, true, 'the reservation follows trusted tab identity, not a blanket URL policy');
  assert.equal(json(opened).tabId, 'new'); assert.deepEqual(json(opened).tabs.map(tab => tab.tabId), ['work', 'new']);
});

test('closing the last ordinary tab cannot expose or default subsequent work to the human conversation', async t => {
  const { driver, handler } = fixture(t);
  const closed = await handler(call({ action: 'close', tabId: 'work' }));
  assert.equal(closed.success, true); assert.deepEqual(json(closed).tabs, []); assert.equal(json(closed).activeTab, null);
  assert.equal(driver.tabs.has('chat'), true); assert.doesNotMatch(JSON.stringify(closed), new RegExp(privateMarker));
  const defaultRead = await handler(call({ action: 'read' }));
  assert.equal(defaultRead.success, false); assert.equal(json(defaultRead).code, 'BROWSER_HUMAN_CHAT_RESERVED');
  assert.deepEqual(driver.calls.map(item => item.args.action), ['close']);
  const opened = await handler(call({ action: 'open', url: 'https://example.test/after-close' }));
  assert.equal(opened.success, true); assert.equal(json(opened).tabId, 'new'); assert.equal(driver.tabs.has('chat'), true);
});

test('agent status and downloads omit reserved, closed and unattributed owners at every returned level', async t => {
  const { browser, handler } = fixture(t);
  for (const action of ['tabs', 'downloads']) {
    const result = await handler(call({ action })); assert.equal(result.success, true);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(privateMarker));
    assert.deepEqual(json(result).downloads.map(item => item.name), ['ordinary.txt']);
  }
  const human = await browser.perform({ action: 'tabs' }, { source: 'user' });
  assert.match(JSON.stringify(human), new RegExp(privateMarker));
  assert.equal(human.tabs.find(tab => tab.tabId === 'chat').purpose, 'chat-mode');
});

test('caller-supplied source or purpose cannot impersonate a human or create a reserved tab', async t => {
  const { driver, handler } = fixture(t);
  for (const args of [{ action: 'read', tabId: 'chat', source: 'user' }, { action: 'open', url: 'https://example.test/', purpose: 'chat-mode' }, { action: 'read', tabId: 'work', purpose: null }, { action: 'open', tabId: 'work', url: 'https://example.test/' }]) {
    const result = await handler(call(args)); assert.equal(result.success, false); assert.equal(json(result).actionDispatched, false);
  }
  assert.equal(driver.calls.length, 0);
});

test('trusted local human input keeps access to its calling tab', async t => {
  const { driver, browser } = fixture(t);
  for (const action of ['read', 'click', 'type', 'upload', 'navigate']) {
    const result = await browser.perform(request(action), { source: 'user' });
    assert.equal(result.tabId, 'chat'); assert.match(JSON.stringify(result), new RegExp(privateMarker));
  }
  assert.deepEqual(driver.calls.map(item => item.source), ['user', 'user', 'user', 'user', 'user']);
});

test('queued default work pins its ordinary target even when the human activates ChatGPT meanwhile', async t => {
  const { driver, router, browser } = fixture(t), release = held(), started = held(); t.after(() => release.resolve());
  driver.activeTab = 'work'; router.activeTab = 'work';
  driver.onPerform = async args => { if (args.action === 'wait') { started.resolve(); await release.promise; } return { tabId: args.tabId }; };
  const first = browser.perform({ action: 'wait', tabId: 'work' }, { source: 'user' }); await started.promise;
  const second = browser.perform({ action: 'click', ref: 'observed-ref' });
  driver.activeTab = 'chat'; router.activeTab = 'chat'; release.resolve(); await first; await second;
  assert.deepEqual(driver.calls.map(item => item.args.tabId), ['work', 'work']);
});

test('a queued target newly reserved before dispatch cannot receive the queued action', async t => {
  const { driver, browser } = fixture(t), release = held(), started = held(); t.after(() => release.resolve());
  driver.onPerform = async args => { started.resolve(); await release.promise; return { tabId: args.tabId }; };
  const first = browser.perform({ action: 'wait', tabId: 'work' }, { source: 'user' }); await started.promise;
  const queued = browser.perform({ action: 'click', tabId: 'work', ref: 'observed-ref' });
  const rejected = assert.rejects(queued, { code: 'BROWSER_HUMAN_CHAT_RESERVED', actionDispatched: false });
  driver.tabs.get('work').purpose = 'chat-mode'; release.resolve(); await first; await rejected;
  assert.deepEqual(driver.calls.map(item => item.args.action), ['wait']);
});

test('ownership is rechecked after asynchronous host validation and before adapter dispatch', async t => {
  const { driver, browser } = fixture(t), release = held(), started = held(); t.after(() => release.resolve());
  const action = browser.perform({ action: 'click', tabId: 'work', ref: 'observed-ref' }, { beforeDispatch: async () => { started.resolve(); await release.promise; } });
  const rejected = assert.rejects(action, { code: 'BROWSER_HUMAN_CHAT_RESERVED', actionDispatched: false });
  await started.promise; driver.tabs.get('work').purpose = 'chat-mode'; release.resolve(); await rejected;
  assert.equal(driver.calls.length, 0);
});

test('a mismatched reserved page response cannot leak text, pixels or pending interaction metadata', async t => {
  const { driver, handler } = fixture(t);
  driver.onPerform = async () => ({ tabId: 'chat', frames: [{ text: privateMarker }], imageUrl: `data:image/png;base64,${privateMarker}`, pendingInteraction: { tabId: 'chat', message: privateMarker } });
  const result = await handler(call({ action: 'screenshot', tabId: 'work' }));
  assert.equal(result.success, false); assert.equal(result.contentItems.length, 1);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(privateMarker)); assert.equal(driver.calls.length, 1);
});

test('unknown tab ownership fails closed instead of delegating an active-tab fallback', async t => {
  let dispatched = 0;
  const browser = new BrowserWorkspace({ driver: { status: () => ({ available: true, contained: true }), perform: async () => { dispatched++; return {}; } } }); t.after(() => browser.close());
  for (const action of ['tabs', 'read', 'open']) await assert.rejects(browser.perform({ action, url: 'https://example.test/' }), { code: 'BROWSER_TAB_STATE_UNAVAILABLE', actionDispatched: false });
  const { browser: known, driver } = fixture(t);
  await assert.rejects(known.perform({ action: 'read', tabId: 'missing' }), { code: 'BROWSER_TAB_NOT_FOUND', actionDispatched: false });
  assert.equal(dispatched, 0); assert.equal(driver.calls.length, 0);
});

async function directFixture(t, browser, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-human-tab-')), cwd = path.join(directory, 'workspace'); await mkdir(cwd);
  const api = new DirectExecutionAPI({ dataDir: path.join(directory, 'data'), allowedRoot: cwd, browser, ...options }); await api.init();
  t.after(async () => { await api.close(); await rm(directory, { recursive: true, force: true }); });
  return api;
}
async function settled(api, id) {
  for (let attempt = 0; attempt < 200; attempt++) { const value = await api.getJob(id, client); if (value.settled) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('The owned direct job did not settle.');
}

test('the direct connector rejects reserved reads, mutations and uploads before approval or interaction inspection', async t => {
  const { browser, driver } = fixture(t); let inspected = 0;
  const api = await directFixture(t, browser, { inspectBrowserInteraction: () => { inspected++; return { tabId: 'chat', message: privateMarker }; } });
  for (const [tool, args] of [
    ['blackice_browser_read', { action: 'snapshot' }],
    ['blackice_browser_action', { action: 'click', ref: 'observed-ref' }],
    ['blackice_browser_action', { action: 'navigate', url: 'https://example.test/' }],
    ['blackice_browser_action', { action: 'open', url: 'https://example.test/' }],
    ['blackice_browser_action', { action: 'close' }],
    ['blackice_browser_upload', { ref: 'observed-file', paths: ['file.txt'], expectedUrl: 'https://chatgpt.com/c/owned', expectedDocumentId: 'chat:1' }],
  ]) await assert.rejects(api.call(tool, { requestId: `reject-${tool}-${args.action || 'upload'}`, tabId: 'chat', ...args }, client), { code: 'BROWSER_HUMAN_CHAT_RESERVED', actionDispatched: false });
  assert.equal((await api.status(client)).jobs.total, 0); assert.equal(inspected, 0); assert.equal(driver.calls.length, 0);
});

test('a lost successful close response retries its exact owned receipt without inspecting or replaying the closed tab', async t => {
  const { browser, driver } = fixture(t); let authorized = true;
  const api = await directFixture(t, browser, { authorizeClient: () => authorized });
  const request = { requestId: 'close-response-lost', action: 'close', tabId: 'work' };
  const admitted = await api.call('blackice_browser_action', request, client), done = await settled(api, admitted.jobId);
  assert.equal(done.status, 'succeeded'); assert.equal(driver.tabs.has('work'), false);
  api.browser = { status() { assert.fail('An exact retry must not inspect the current browser.'); } };
  const retry = await api.call('blackice_browser_action', { ...request }, client);
  assert.equal(retry.existing, true); assert.equal(retry.jobId, done.jobId); assert.equal(retry.status, 'succeeded'); assert.equal(retry.revision, done.revision);
  assert.equal((await api.getJob(retry.jobId, client)).result.text.text, done.result.text.text);
  await assert.rejects(api.call('blackice_browser_action', { ...request, tabId: 'chat' }, client), { code: 'DIRECT_REQUEST_CONFLICT' });
  await assert.rejects(api.call('blackice_browser_action', { ...request, action: 'reload' }, client), { code: 'DIRECT_REQUEST_CONFLICT' });
  await assert.rejects(api.call('blackice_browser_action', { ...request, source: 'user' }, client), { code: 'DIRECT_REQUEST_INVALID' });
  await assert.rejects(api.call('blackice_browser_action', request, { ...client, scopes: ['read'] }), { code: 'DIRECT_SCOPE_REQUIRED' });
  api.browser = browser;
  await assert.rejects(api.call('blackice_browser_action', request, { ...client, id: 'another-grant' }), { code: 'BROWSER_TAB_NOT_FOUND' });
  await assert.rejects(api.call('blackice_browser_action', { ...request, requestId: 'new-close', tabId: 'chat' }, client), { code: 'BROWSER_HUMAN_CHAT_RESERVED', actionDispatched: false });
  await assert.rejects(api.call('blackice_browser_action', { ...request, requestId: 'new-closed-tab-action' }, client), { code: 'BROWSER_TAB_NOT_FOUND' });
  const find = api.jobs.findRequest.bind(api.jobs);
  api.jobs.findRequest = async identity => { const saved = await find(identity); authorized = false; return saved; };
  await assert.rejects(api.call('blackice_browser_action', request, client), { code: 'DIRECT_AUTH_REQUIRED' });
  api.jobs.findRequest = find; authorized = true;
  assert.equal((await api.status(client)).jobs.total, 1);
  assert.deepEqual(driver.calls.map(item => item.args.action), ['close']);
});

test('an admitted read remains retrievable after its tab becomes reserved without admitting new reads', async t => {
  const { browser, driver } = fixture(t), api = await directFixture(t, browser);
  const request = { requestId: 'read-before-reservation', action: 'read', tabId: 'work' };
  const admitted = await api.call('blackice_browser_read', request, client), done = await settled(api, admitted.jobId);
  assert.equal(done.status, 'succeeded'); driver.tabs.get('work').purpose = 'chat-mode';
  const retry = await api.call('blackice_browser_read', { ...request }, client);
  assert.equal(retry.existing, true); assert.equal(retry.jobId, done.jobId); assert.equal(retry.revision, done.revision);
  assert.equal((await api.getJob(retry.jobId, client)).result.text.text, done.result.text.text);
  await assert.rejects(api.call('blackice_browser_read', { ...request, requestId: 'new-reserved-read' }, client), { code: 'BROWSER_HUMAN_CHAT_RESERVED', actionDispatched: false });
  await assert.rejects(api.call('blackice_browser_read', { ...request, query: 'different action arguments' }, client), { code: 'DIRECT_REQUEST_CONFLICT' });
  assert.equal((await api.status(client)).jobs.total, 1); assert.deepEqual(driver.calls.map(item => item.args.action), ['read']);
});

test('dispatch rechecks a tab reservation acquired while the direct action was queued', async t => {
  const { browser, driver } = fixture(t); let inspected = 0;
  const api = await directFixture(t, browser, { inspectBrowserInteraction: () => { inspected++; return null; } });
  const pending = await api.call('blackice_browser_action', { requestId: 'pending-target-change', action: 'click', tabId: 'work', ref: 'observed-ref' }, client);
  assert.notEqual(pending.status, 'awaiting_input'); driver.tabs.get('work').purpose = 'chat-mode';
  const done = await settled(api, pending.jobId);
  assert.equal(done.status, 'failed'); assert.equal(done.error.code, 'BROWSER_HUMAN_CHAT_RESERVED');
  assert.equal(done.effects.possible, false); assert.equal(done.resultAvailable, false); assert.equal(inspected, 0); assert.equal(driver.calls.length, 0);
});

test('direct catalog results retain ordinary pages and omit the calling conversation', async t => {
  const { browser } = fixture(t), api = await directFixture(t, browser);
  const job = await api.call('blackice_browser_read', { requestId: 'ordinary-catalog', action: 'tabs' }, client), done = await settled(api, job.jobId);
  assert.equal(done.status, 'succeeded'); assert.doesNotMatch(JSON.stringify(done), new RegExp(privateMarker));
  assert.deepEqual(JSON.parse(done.result.text.text).tabs.map(tab => tab.tabId), ['work']);
});
