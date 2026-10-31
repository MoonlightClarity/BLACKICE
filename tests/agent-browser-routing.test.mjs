import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTAINED_CONNECTION_TOOL, CONNECTION_TOOL, createConnectionToolHandler } from '../lib/mcp.mjs';
import { chromeAutoConnectConnection } from '../lib/chrome-browser.mjs';
import { BROWSER_TOOL, createBrowserToolHandler } from '../lib/browser.mjs';

const call = arguments_ => ({ name: 'relay_connections', arguments: arguments_ });
function fixture(configs, catalogs = new Map()) {
  const effects = [], clients = new Map();
  const manager = {
    configs: new Map(configs.map(config => [config.id, config])), clients, redact: String,
    list: () => configs.map(config => ({ ...config, connected: clients.has(config.id) })),
    init: async () => {},
    tools: async (id, { query = '' } = {}) => {
      effects.push(['discover', id]);
      const tools = catalogs.get(id) || [{ name: 'lookup_note', inputSchema: { type: 'object' } }];
      clients.set(id, { tools, connected: true });
      return { tools: tools.filter(tool => tool.name.includes(query)), total: tools.length };
    },
    connect: async id => { effects.push(['connect', id]); return clients.get(id); },
    call: async (id, name, args, options = {}) => { effects.push(['call', id, name]); options.onDispatch?.(); return { content: [{ type: 'text', text: 'Verified integration result' }] }; },
  };
  return { manager, effects };
}

test('task schema exposes non-browser integrations while preserving the separate manual schema', () => {
  assert.deepEqual(CONTAINED_CONNECTION_TOOL.inputSchema.properties.action.enum, ['connections', 'tools', 'call']);
  assert.ok(CONNECTION_TOOL.inputSchema.properties.action.enum.includes('connect_chrome'));
  assert.deepEqual(BROWSER_TOOL.inputSchema.properties.browser.enum, ['relay']);
});

test('contained task discovery and stale Chrome calls never connect or dispatch native work', async () => {
  const chrome = chromeAutoConnectConnection(), neo = { id: 'browseros-neo', name: 'BrowserOS Neo', enabled: true };
  const imported = { ...chromeAutoConnectConnection(), id: 'browser-profile-fixture', name: 'Imported profile' };
  const notes = { id: 'notes', name: 'Notes', enabled: true };
  const { manager, effects } = fixture([chrome, neo, imported, notes]);
  let connections = 0;
  const handler = createConnectionToolHandler({ manager, browserPolicy: 'contained', connectChrome: async () => { connections++; } });
  const listed = await handler(call({ action: 'connections' }));
  assert.deepEqual(JSON.parse(listed.contentItems[0].text).map(row => row.id), ['notes']);
  for (const args of [
    { action: 'connect_chrome' },
    ...[chrome.id, neo.id, imported.id].flatMap(connectionId => [
      { action: 'tools', connectionId },
      { action: 'call', connectionId, name: 'new_page', arguments: { url: 'https://example.test/' } },
    ]),
  ]) {
    const result = await handler(call(args));
    assert.equal(result.success, false);
    assert.equal(result.code, 'BROWSER_CONTAINED_ONLY');
    assert.equal(result.receipt.actionDispatched, false);
    assert.equal(result.receipt.outcome, 'not-dispatched');
  }
  assert.equal(connections, 0);
  assert.deepEqual(effects, []);
  const discovered = await handler(call({ action: 'tools', connectionId: notes.id }));
  assert.equal(discovered.success, true);
  const result = await handler(call({ action: 'call', connectionId: notes.id, name: 'lookup_note', arguments: {} }));
  assert.equal(result.success, true);
  assert.deepEqual(effects, [['discover', 'notes'], ['call', 'notes', 'lookup_note']]);
});

for (const [adapter, tools, name] of [
  ['Chrome', ['list_pages', 'take_snapshot', 'new_page'].map(name => ({ name })), 'new_page'],
  ['Neo', [{ name: 'tabs' }, { name: 'run', description: 'BrowserOS neo browser.pages.list() browser.cdp()' }], 'run'],
  ['Playwright', [{ name: 'browser_navigate' }, { name: 'browser_snapshot' }], 'browser_navigate'],
]) test('an unlabelled ' + adapter + ' alias is recognized before its first action and remains unavailable on resume', async () => {
  const { manager, effects } = fixture([{ id: 'custom', name: 'Custom integration', enabled: true }], new Map([['custom', tools]]));
  const request = call({ action: 'call', connectionId: 'custom', name, arguments: {} });
  const first = await createConnectionToolHandler({ manager, browserPolicy: 'contained' })(request);
  assert.equal(first.code, 'BROWSER_CONTAINED_ONLY');
  assert.equal(first.receipt.actionDispatched, false);
  const resumed = await createConnectionToolHandler({ manager, browserPolicy: 'contained' })(request);
  assert.equal(resumed.code, 'BROWSER_CONTAINED_ONLY');
  assert.equal(resumed.receipt.actionDispatched, false);
  assert.deepEqual(effects, [['discover', 'custom']]);
});

test('native browser methods in a mixed integration stay unavailable while unrelated methods remain usable', async () => {
  const config = { id: 'mixed', name: 'Mixed integration', enabled: true };
  const tools = [{ name: 'lookup_note' }, { name: 'blackice_connected_browser_action' }];
  const { manager, effects } = fixture([config], new Map([[config.id, tools]]));
  const handler = createConnectionToolHandler({ manager, browserPolicy: 'contained' });
  const discovered = await handler(call({ action: 'tools', connectionId: config.id }));
  assert.deepEqual(JSON.parse(discovered.contentItems[0].text).tools.map(tool => tool.name), ['lookup_note']);
  const browser = await handler(call({ action: 'call', connectionId: config.id, name: 'blackice_connected_browser_action', arguments: { action: 'connect_chrome' } }));
  assert.equal(browser.code, 'BROWSER_CONTAINED_ONLY');
  const note = await handler(call({ action: 'call', connectionId: config.id, name: 'lookup_note', arguments: {} }));
  assert.equal(note.success, true);
  assert.deepEqual(effects, [['discover', 'mixed'], ['call', 'mixed', 'lookup_note']]);
});

test('contained browser failure leaves native adapters undispatched and still permits independent integrations', async () => {
  let pages = 0;
  const browser = createBrowserToolHandler({ browser: { status: () => ({ available: false, contained: false }), perform: async () => { pages++; } } });
  const result = await browser({ name: 'relay_browser', arguments: { action: 'open', url: 'https://example.test/' } });
  assert.equal(result.code, 'BROWSER_UNAVAILABLE');
  assert.equal(pages, 0);
  const { manager, effects } = fixture([chromeAutoConnectConnection(), { id: 'notes', name: 'Notes', enabled: true }]);
  const handler = createConnectionToolHandler({ manager, browserPolicy: 'contained' });
  assert.equal((await handler(call({ action: 'connect_chrome' }))).code, 'BROWSER_CONTAINED_ONLY');
  assert.equal((await handler(call({ action: 'call', connectionId: 'notes', name: 'lookup_note', arguments: {} }))).success, true);
  assert.deepEqual(effects, [['discover', 'notes'], ['call', 'notes', 'lookup_note']]);
});


test('narrow discovery cannot hide the full native-browser signature of an unknown alias', async () => {
  const tools = ['list_pages', 'take_snapshot', 'new_page'].map(name => ({ name }));
  const { manager, effects } = fixture([{ id: 'alias', name: 'Custom integration', enabled: true }], new Map([['alias', tools]]));
  const handler = createConnectionToolHandler({ manager, browserPolicy: 'contained' });
  const discovered = await handler(call({ action: 'tools', connectionId: 'alias', query: 'take_snapshot' }));
  assert.equal(discovered.code, 'BROWSER_CONTAINED_ONLY');
  assert.equal(discovered.receipt.actionDispatched, false);
  assert.doesNotMatch(discovered.contentItems[0].text, /"tools":/);
  assert.deepEqual(effects, [['discover', 'alias']]);
  const cached = await handler(call({ action: 'tools', connectionId: 'alias', query: 'does-not-match' }));
  assert.equal(cached.code, 'BROWSER_CONTAINED_ONLY');
  assert.deepEqual(effects, [['discover', 'alias']]);
});

test('actual namespaced legacy native tools are excluded while contained browser and unrelated tools still work', async () => {
  const prefix = 'mcp__blackice_bridge___this_computer__blackice_bridge_this_computer_';
  const native = ['blackice_connected_browser_read', 'blackice_connected_browser_action', 'blackice_profile_connect'].map(name => prefix + name);
  const contained = prefix + 'blackice_browser_action', note = 'lookup_note';
  const catalog = [...native, contained, note].map(name => ({ name }));
  const { manager, effects } = fixture([{ id: 'bridge', name: 'Mixed integration', enabled: true }], new Map([['bridge', catalog]]));
  const handler = createConnectionToolHandler({ manager, browserPolicy: 'contained' });
  const tools = await handler(call({ action: 'tools', connectionId: 'bridge' }));
  assert.deepEqual(JSON.parse(tools.contentItems[0].text).tools.map(tool => tool.name), [contained, note]);
  for (const name of native) {
    const result = await handler(call({ action: 'call', connectionId: 'bridge', name, arguments: { action: 'connect_chrome' } }));
    assert.equal(result.code, 'BROWSER_CONTAINED_ONLY');
    assert.equal(result.receipt.actionDispatched, false);
  }
  assert.equal((await handler(call({ action: 'call', connectionId: 'bridge', name: contained, arguments: { action: 'open', browser: 'relay', url: 'https://example.test/' } }))).success, true);
  assert.equal((await handler(call({ action: 'call', connectionId: 'bridge', name: note, arguments: {} }))).success, true);
  assert.deepEqual(effects, [['discover', 'bridge'], ['call', 'bridge', contained], ['call', 'bridge', note]]);
});

test('manual native calls retain the existing separate gateway when task routing is absent', async () => {
  const config = { id: 'browseros-neo', name: 'BrowserOS Neo', enabled: true };
  const { manager, effects } = fixture([config], new Map([[config.id, [{ name: 'tabs' }]]]));
  const handler = createConnectionToolHandler({ manager });
  const discovery = await handler(call({ action: 'tools', connectionId: config.id }));
  assert.equal(discovery.success, true);
  const result = await handler(call({ action: 'call', connectionId: config.id, name: 'tabs', arguments: { action: 'list' } }));
  assert.equal(result.success, true);
  assert.equal(result.receipt.actionDispatched, true);
  assert.deepEqual(effects, [['discover', config.id], ['connect', config.id], ['call', config.id, 'tabs']]);
});
