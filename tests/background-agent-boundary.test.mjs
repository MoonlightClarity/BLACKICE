import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_TOOL, BrowserWorkspace, createBrowserToolHandler, containedBrowserAvailable } from '../lib/browser.mjs';
import { BrowserRouter } from '../desktop/browser-router.mjs';
import { createConnectionToolHandler } from '../lib/mcp.mjs';
import { chromeAutoConnectConnection } from '../lib/chrome-browser.mjs';
import { DesktopController } from '../lib/desktop.mjs';

const browserCall = arguments_ => ({ name: 'relay_browser', arguments: arguments_ });
const connectionCall = arguments_ => ({ name: 'relay_connections', arguments: arguments_ });
const driver = id => ({
  calls: [], status: () => ({ available: true, tabs: [{ tabId: id, url: 'https://example.com/' }], activeTab: id, downloads: [{ id, tabId: id }] }),
  async perform(args) { this.calls.push(args); return { tabId: id, text: 'Observed page' }; }, async close() {},
});

test('agent browser keeps routing and returned tabs on Relay after a manual Firefox selection', async t => {
  const relay = driver('relay-tab'), firefox = driver('native-tab'), router = new BrowserRouter({ independent: relay, firefox });
  const workspace = new BrowserWorkspace({ driver: router }); t.after(() => workspace.close());
  await workspace.perform({ action: 'snapshot', tabId: 'firefox:native-tab' }, { source: 'user' });
  assert.equal(firefox.calls.length, 1, 'the existing manual router remains available');
  const handler = createBrowserToolHandler({ browser: workspace });
  assert.deepEqual(BROWSER_TOOL.inputSchema.properties.browser.enum, ['relay']);
  const listed = JSON.parse((await handler(browserCall({ action: 'tabs' }))).contentItems[0].text);
  assert.deepEqual(listed.tabs.map(tab => tab.tabId), ['relay-tab']);
  assert.deepEqual(Object.keys(listed.browsers), ['relay']);
  assert.equal(listed.activeTab, 'relay-tab');
  const downloads = JSON.parse((await handler(browserCall({ action: 'downloads' }))).contentItems[0].text);
  assert.deepEqual(downloads.downloads.map(item => item.browser), ['relay']);
  assert.equal((await handler(browserCall({ action: 'snapshot' }))).success, true);
  assert.equal(relay.calls.length, 1); assert.equal(firefox.calls.length, 1);
  for (const args of [{ action: 'open', browser: 'firefox', url: 'https://example.com/' }, { action: 'snapshot', tabId: 'firefox:native-tab' }]) {
    const rejected = await handler(browserCall(args)); assert.equal(rejected.success, false); assert.match(rejected.contentItems[0].text, /External browser interaction is unavailable/);
  }
  assert.equal(firefox.calls.length, 1, 'stale agent schemas and external tab IDs cannot select Firefox');
});

test('manual Firefox selection preserves the actual ordinary Relay target regardless of tab ordering', async t => {
  const relay = driver('ordinary-active'), firefox = driver('native-tab');
  const tabs = [{ tabId: 'human-chat', purpose: 'chat-mode' }, { tabId: 'ordinary-first' }, { tabId: 'ordinary-active' }];
  relay.status = () => ({ available: true, tabs, activeTab: 'ordinary-active' });
  const router = new BrowserRouter({ independent: relay, firefox }), workspace = new BrowserWorkspace({ driver: router }); t.after(() => workspace.close());
  await workspace.perform({ action: 'snapshot', tabId: 'firefox:native-tab' }, { source: 'user' });
  assert.equal(router.status().activeTab, 'firefox:native-tab'); assert.equal(router.status().browsers.relay.activeTab, 'ordinary-active');
  const handler = createBrowserToolHandler({ browser: workspace });
  const listed = JSON.parse((await handler(browserCall({ action: 'tabs' }))).contentItems[0].text);
  assert.deepEqual(listed.tabs.map(tab => tab.tabId), ['ordinary-first', 'ordinary-active']);
  assert.equal(listed.activeTab, 'ordinary-active'); assert.equal(listed.browsers.relay.activeTab, 'ordinary-active');
  assert.equal((await handler(browserCall({ action: 'read' }))).success, true);
  assert.equal(relay.calls[0].tabId, 'ordinary-active'); assert.equal(firefox.calls.length, 1);
});

test('manual Firefox selection never substitutes an ordinary tab for the actual reserved Relay selection', async t => {
  const relay = driver('ordinary-first'), firefox = driver('native-tab');
  const tabs = [{ tabId: 'ordinary-first' }, { tabId: 'human-chat', purpose: 'chat-mode', title: 'PRIVATE_CALLING_CONVERSATION' }];
  let activeTab = 'human-chat'; relay.status = () => ({ available: true, tabs, activeTab });
  const router = new BrowserRouter({ independent: relay, firefox }), workspace = new BrowserWorkspace({ driver: router }); t.after(() => workspace.close());
  await workspace.perform({ action: 'snapshot', tabId: 'firefox:native-tab' }, { source: 'user' });
  const handler = createBrowserToolHandler({ browser: workspace });
  let listed = JSON.parse((await handler(browserCall({ action: 'tabs' }))).contentItems[0].text);
  assert.deepEqual(listed.tabs.map(tab => tab.tabId), ['ordinary-first']); assert.equal(listed.activeTab, null); assert.equal(listed.browsers.relay.activeTab, null);
  assert.doesNotMatch(JSON.stringify(listed), /human-chat|PRIVATE_CALLING_CONVERSATION/);
  const implicit = await handler(browserCall({ action: 'read' })); assert.equal(implicit.success, false);
  assert.equal(JSON.parse(implicit.contentItems[0].text).code, 'BROWSER_HUMAN_CHAT_RESERVED'); assert.equal(relay.calls.length, 0);
  assert.equal((await handler(browserCall({ action: 'read', tabId: 'ordinary-first' }))).success, true); assert.equal(relay.calls[0].tabId, 'ordinary-first');
  // A stale or absent contained selection also cannot invent a default target.
  activeTab = 'missing'; listed = JSON.parse((await handler(browserCall({ action: 'tabs' }))).contentItems[0].text);
  assert.equal(listed.activeTab, null); assert.equal(listed.browsers.relay.activeTab, null);
  const missing = await handler(browserCall({ action: 'read' })); assert.equal(missing.success, false);
  assert.equal(JSON.parse(missing.contentItems[0].text).code, 'BROWSER_TAB_NOT_FOUND'); assert.equal(relay.calls.length, 1);
});

test('Firefox-only readiness cannot advertise or dispatch a contained browser', async t => {
  const firefox = driver('native-tab'), router = new BrowserRouter({ firefox }), workspace = new BrowserWorkspace({ driver: router });
  t.after(() => workspace.close());
  assert.equal(router.status().available, true, 'manual Firefox remains available');
  assert.equal(router.status().contained, false); assert.equal(router.status().containedAvailable, false);
  assert.equal(containedBrowserAvailable(workspace.status()), false);
  const result = await createBrowserToolHandler({ browser: workspace })(browserCall({ action: 'open', url: 'https://example.com/' }));
  assert.equal(result.success, false); assert.match(result.contentItems[0].text, /contained BLACKICE browser is unavailable/); assert.deepEqual(firefox.calls, []);
});

test('missing or contradictory contained-driver status is unavailable without browser side effects', async () => {
  for (const status of [undefined, { available: true }, { available: true, contained: false }, { available: true, contained: true, browsers: { relay: { available: false } } }]) {
    let called = 0;
    const result = await createBrowserToolHandler({ browser: { status: () => status, perform: async () => { called++; } } })(browserCall({ action: 'tabs' }));
    assert.equal(result.success, false); assert.equal(called, 0);
  }
});

test('connection discovery hides native browsers and never refreshes or starts one', async () => {
  const chrome = chromeAutoConnectConnection(), configs = new Map([
    ['browseros-neo', { id: 'browseros-neo', name: 'BrowserOS Neo', url: 'http://127.0.0.1:9000/mcp' }],
    ['alias', { id: 'alias', name: 'Saved alias', url: 'http://localhost:9000/mcp' }],
    [chrome.id, chrome], ['notes', { id: 'notes', name: 'Notes' }],
  ]), calls = [];
  const manager = { configs, signedBrowser: { connectionId: 'browseros-neo', available: true }, list: () => [...configs.values()], redact: String,
    refreshSignedBrowser: async () => { calls.push('refresh'); }, connect: async id => { calls.push(['connect', id]); }, call: async id => { calls.push(['call', id]); return { content: [] }; } };
  for (const containedBrowser of [false, true]) {
    const handler = createConnectionToolHandler({ manager, containedBrowser });
    const result = await handler(connectionCall({ action: 'connections' }));
    assert.deepEqual(JSON.parse(result.contentItems[0].text).map(entry => entry.id), ['notes']);
    for (const id of ['browseros-neo', 'alias', chrome.id]) for (const action of ['tools', 'call']) {
      const rejected = await handler(connectionCall({ action, connectionId: id, name: 'tabs' }));
      assert.equal(rejected.success, false); assert.match(rejected.contentItems[0].text, /interaction is disabled/);
    }
  }
  assert.deepEqual(calls, []);
  assert.equal((await createConnectionToolHandler({ manager })(connectionCall({ action: 'call', connectionId: 'notes', name: 'read' }))).success, true);
  assert.deepEqual(calls, [['connect', 'notes'], ['call', 'notes']], 'ordinary MCP integrations still execute');
});

test('a Neo alias identified by its discovered catalog cannot execute a task tool', async () => {
  const clients = new Map(); let executed = 0;
  const manager = { clients, redact: String, connect: async id => clients.set(id, { tools: [{ name: 'tabs' }, { name: 'run', description: 'BrowserOS neo browser.windows(args)' }] }), call: async () => { executed++; } };
  const result = await createConnectionToolHandler({ manager })(connectionCall({ action: 'call', connectionId: 'renamed', name: 'run', arguments: { code: 'never execute' } }));
  assert.equal(result.success, false); assert.match(result.contentItems[0].text, /interaction is disabled/); assert.equal(executed, 0);
});

test('desktop public status advertises only inspection while the dedicated adapter remains separate', () => {
  const desktop = new DesktopController({ platform: 'win32', runner: async () => ({}) }), status = desktop.status();
  assert.equal(status.scope, 'read_only_windows_inspection'); assert.match(status.description, /Read-only inspection/);
  assert.deepEqual(status.actions, ['screenshot', 'windows', 'inspect', 'get_text', 'wait']);
});
