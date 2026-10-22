import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_TOOL, BrowserWorkspace, browserOwnerKey, createBrowserToolHandler } from '../lib/browser.mjs';
import { browserDownloadProvenance } from '../lib/browser-access.mjs';

const owner = { taskId: 'task', runId: 'run', nodeId: 'worker' };
const call = arguments_ => ({ name: 'relay_browser', arguments: arguments_ });
const receipt = value => JSON.parse(value.contentItems[0].text);
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const calls = [], folders = [
    { id: 'owned', kind: 'task', taskId: 'task' }, { id: 'foreign', kind: 'task', taskId: 'other-task' },
    { id: 'personal', kind: 'user' }, { id: 'calling', kind: 'user' },
  ], tabs = [
    { tabId: 'mine', folderId: 'owned', owner: { ...owner }, url: 'https://owned.test/' },
    { tabId: 'child', folderId: 'owned', parentTabId: 'mine', owner: { ...owner }, url: 'https://child.test/' },
    { tabId: 'other', folderId: 'foreign', owner: { ...owner, taskId: 'other-task' }, url: 'https://other.test/' },
    { tabId: 'personal-tab', folderId: 'personal', url: 'https://personal.test/' },
    { tabId: 'chat', folderId: 'calling', purpose: 'chat-mode', url: 'https://chatgpt.com/c/private' },
  ];
  let enabled = false;
  const driver = {
    status: () => ({ available: true, contained: true, tabs: structuredClone(tabs), folders: structuredClone(folders), activeTab: 'personal-tab', ownerActiveTabs: { [browserOwnerKey(owner)]: 'mine' } }),
    async perform(args, context) { calls.push({ args: structuredClone(args), owner: context.owner, source: context.source }); return { tabs: structuredClone(tabs), folders: structuredClone(folders) }; },
    protectionStatus: () => ({ available: true, enabled, ready: true, exemptOrigins: ['https://owned.test', 'https://other.test', 'https://chatgpt.com'], tabs: tabs.map(tab => ({ tabId: tab.tabId, origin: new URL(tab.url).origin, enabled })) }),
    async configureProtection(args) { calls.push({ protection: structuredClone(args) }); if (args.action === 'global') enabled = args.enabled; return this.protectionStatus(); },
    async close() {},
  };
  const browser = new BrowserWorkspace({ driver }); t.after(() => browser.close());
  return { browser, driver, calls, folders, tabs, handler: createBrowserToolHandler({ browser, owner }) };
}

test('ordinary tools expose supported dialogs, organization and filtering operations', () => {
  for (const action of ['interaction', 'folder_create', 'folder_rename', 'folder_close', 'tab_move', 'suspend', 'protection']) assert.ok(BROWSER_TOOL.inputSchema.properties.action.enum.includes(action), action);
  for (const field of ['interactionId', 'decision', 'promptText', 'name', 'operation', 'origin', 'enabled']) assert.ok(BROWSER_TOOL.inputSchema.properties[field], field);
  assert.equal(BROWSER_TOOL.inputSchema.properties.password, undefined);
});

test('agent organization acts on its observed folders and tabs without a local-user gate', async t => {
  const { handler, calls } = fixture(t);
  for (const args of [
    { action: 'folder_create', name: 'Research' }, { action: 'folder_rename', folderId: 'owned', name: 'Verified' },
    { action: 'tab_move', tabId: 'child', folderId: 'owned', parentTabId: null }, { action: 'suspend', tabId: 'mine' },
    { action: 'folder_close', folderId: 'owned' },
  ]) assert.equal((await handler(call(args))).success, true, args.action);
  assert.deepEqual(calls.map(value => value.args.action), ['folder_create', 'folder_rename', 'tab_move', 'suspend', 'folder_close']);
  assert.ok(calls.every(value => value.source === 'agent' && value.owner.taskId === owner.taskId));
});

test('organization preserves task, sibling-worker, descendant and caller ownership', async t => {
  const { handler, calls, tabs } = fixture(t);
  for (const args of [
    { action: 'folder_close', folderId: 'foreign' }, { action: 'folder_rename', folderId: 'foreign', name: 'Other' },
    { action: 'tab_move', tabId: 'mine', folderId: 'foreign' }, { action: 'tab_move', tabId: 'mine', parentTabId: 'other' },
    { action: 'suspend', tabId: 'personal-tab' },
  ]) assert.equal(receipt(await handler(call(args))).code, 'BROWSER_TAB_OWNERSHIP', args.action);
  assert.equal(receipt(await handler(call({ action: 'tab_move', tabId: 'mine', parentTabId: 'chat' }))).code, 'BROWSER_HUMAN_CHAT_RESERVED');
  tabs.push({ tabId: 'sibling', folderId: 'owned', parentTabId: 'mine', owner: { ...owner, nodeId: 'sibling-worker' }, url: 'https://sibling.test/' });
  assert.equal(receipt(await handler(call({ action: 'folder_close', folderId: 'owned' }))).code, 'BROWSER_TAB_OWNERSHIP');
  assert.equal(receipt(await handler(call({ action: 'tab_move', tabId: 'mine', parentTabId: null }))).code, 'BROWSER_TAB_OWNERSHIP');
  assert.deepEqual(calls, []);
});

test('direct connector ownership permits ordinary personal tabs but preserves the calling tab', async t => {
  const { browser, calls } = fixture(t), handler = createBrowserToolHandler({ browser, owner: { ...owner, allowUserTabs: true } });
  assert.equal((await handler(call({ action: 'suspend', tabId: 'personal-tab' }))).success, true);
  assert.equal((await handler(call({ action: 'folder_close', folderId: 'personal' }))).success, true);
  assert.equal(receipt(await handler(call({ action: 'folder_close', folderId: 'calling' }))).code, 'BROWSER_HUMAN_CHAT_RESERVED');
  assert.equal(calls.length, 2);
});

test('an authorized connector can open inside a personal folder or under its personal parent', async t => {
  const { browser, handler: taskHandler, calls } = fixture(t), handler = createBrowserToolHandler({ browser, owner: { ...owner, allowUserTabs: true } });
  for (const target of [{ folderId: 'personal' }, { parentTabId: 'personal-tab' }, { folderId: 'personal', parentTabId: 'personal-tab' }]) {
    const args = { action: 'open', url: 'https://example.test/child', ...target };
    assert.equal((await handler(call(args))).success, true, JSON.stringify(target));
    assert.equal(receipt(await taskHandler(call(args))).code, 'BROWSER_TAB_OWNERSHIP');
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every(value => value.owner.allowUserTabs && value.args.url === 'https://example.test/child'));
  assert.equal(receipt(await handler(call({ action: 'open', url: 'https://example.test/', folderId: 'foreign' }))).code, 'BROWSER_TAB_OWNERSHIP');
});

test('closed source downloads keep their original owner and calling-tab provenance', async t => {
  const { browser, driver, tabs, handler } = fixture(t), connector = createBrowserToolHandler({ browser, owner: { ...owner, allowUserTabs: true } });
  const downloads = tabs.map(tab => ({ tabId: tab.tabId, name: `${tab.tabId}.txt`, provenance: browserDownloadProvenance(tab) }));
  downloads.push({ tabId: 'unattributed', name: 'legacy.txt' }, { tabId: 'mismatch', name: 'mismatch.txt', provenance: downloads[0].provenance });
  driver.perform = async () => ({ downloads, browsers: { relay: { downloads } } });
  tabs.find(tab => tab.tabId === 'chat').purpose = null;
  assert.ok(!receipt(await connector(call({ action: 'downloads' }))).downloads.some(item => item.name === 'chat.txt'), 'a calling-tab download cannot be relabeled by later page metadata');
  tabs.splice(0);
  const owned = receipt(await handler(call({ action: 'downloads' })));
  const personal = receipt(await connector(call({ action: 'downloads' })));
  assert.deepEqual(owned.downloads.map(item => item.name), ['mine.txt', 'child.txt']);
  assert.deepEqual(personal.downloads.map(item => item.name), ['mine.txt', 'child.txt', 'personal-tab.txt']);
  assert.deepEqual(personal.browsers.relay.downloads, personal.downloads);
  assert.equal(downloads[0].provenance.owner.taskId, owner.taskId);
  assert.equal(downloads.find(item => item.name === 'chat.txt').provenance.purpose, 'chat-mode');
});

test('page commands share optional document guards and coordinate hover has a dispatchable shape', async t => {
  const { handler, calls } = fixture(t), guard = { expectedUrl: 'https://owned.test/', expectedDocumentId: 'mine:1' };
  const actions = [
    { action: 'read' }, { action: 'snapshot' }, { action: 'screenshot' }, { action: 'navigate', url: 'https://owned.test/next' },
    { action: 'hover', x: 45, y: 30 }, { action: 'fill', ref: 'field', text: 'owned input' }, { action: 'select', ref: 'choice', value: 'one' },
    { action: 'wait', text: 'ready' }, { action: 'scroll', direction: 'down' }, { action: 'back' }, { action: 'forward' }, { action: 'reload' }, { action: 'close' },
  ];
  for (const action of actions) assert.equal((await handler(call({ ...action, tabId: 'mine', ...guard }))).success, true, action.action);
  assert.equal(calls.length, actions.length);
  assert.ok(calls.every(value => value.args.expectedUrl === guard.expectedUrl && value.args.expectedDocumentId === guard.expectedDocumentId));
  const invalid = await handler(call({ action: 'hover', tabId: 'mine', x: 45, y: 30 }));
  assert.equal(receipt(invalid).code, 'BROWSER_VALIDATION'); assert.equal(receipt(invalid).actionDispatched, false); assert.equal(receipt(invalid).stage, 'validation');
  assert.equal(calls.length, actions.length, 'incomplete document guards must not reach the adapter');
});

test('unsupported command names cannot resolve inherited registry entries', async t => {
  const { browser, calls } = fixture(t);
  for (const action of ['toString', 'constructor', '__proto__', { name: 'read' }]) await assert.rejects(browser.perform({ action, tabId: 'mine' }, { owner }), { code: 'BROWSER_VALIDATION', actionDispatched: false });
  assert.deepEqual(calls, []);
});

test('wheel scrolling accepts signed pixel deltas only with an explicit observed page', async t => {
  const { browser, calls } = fixture(t);
  const wheel = { action: 'scroll', browser: 'relay', tabId: 'mine', x: 120.5, y: 48.25, deltaX: -13.5, deltaY: 200.75, expectedUrl: 'https://owned.test/', expectedDocumentId: 'mine:1' };
  await browser.perform(wheel, { source: 'user' });
  assert.deepEqual(calls[0].args, wheel);
  for (const change of [
    { x: undefined }, { y: undefined }, { deltaX: undefined }, { deltaY: undefined }, { x: -1 }, { y: -1 },
    { deltaX: Infinity }, { deltaY: NaN }, { deltaX: '12' }, { deltaX: 0, deltaY: 0 },
    { ref: 'control' }, { direction: 'down' }, { amount: 200 }, { tabId: undefined }, { browser: undefined },
    { expectedUrl: undefined }, { expectedDocumentId: undefined },
  ]) await assert.rejects(browser.perform({ ...wheel, ...change }, { source: 'user' }), { code: 'BROWSER_VALIDATION', actionDispatched: false });
  assert.equal(calls.length, 1, 'malformed wheel input must never reach the native adapter');
  await browser.perform({ action: 'scroll', tabId: 'mine', direction: 'up', amount: 500 }, { source: 'user' });
  await browser.perform({ action: 'scroll', tabId: 'mine', ref: 'pane', direction: 'right', amount: 50 }, { source: 'user' });
  assert.equal(calls.length, 3, 'existing directional and element-ref scrolling remain supported');
});

test('organization ownership is checked again after queued work and host admission', async t => {
  const { browser, driver, tabs, calls } = fixture(t);
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const perform = driver.perform.bind(driver); driver.perform = async (args, context) => { if (args.action === 'read') await waiting; return perform(args, context); };
  const first = browser.perform({ action: 'read', tabId: 'mine' }, { owner }); await tick();
  const queued = browser.perform({ action: 'folder_close', folderId: 'owned' }, { owner });
  const denied = assert.rejects(queued, { code: 'BROWSER_TAB_OWNERSHIP' });
  tabs.find(tab => tab.tabId === 'child').owner.nodeId = 'sibling'; release(); await first; await denied;
  assert.deepEqual(calls.map(value => value.args.action), ['read']);
});

test('tools inspect and change optional filtering while receipts omit other tasks and caller origins', async t => {
  const { handler, calls } = fixture(t);
  const inspected = receipt(await handler(call({ action: 'protection', operation: 'status' })));
  assert.equal(inspected.enabled, false); assert.deepEqual(inspected.tabs.map(tab => tab.tabId), ['mine', 'child']); assert.deepEqual(inspected.exemptOrigins, ['https://owned.test']);
  const changed = await handler(call({ action: 'protection', operation: 'global', enabled: true })); assert.equal(changed.success, true); assert.equal(receipt(changed).enabled, true);
  assert.deepEqual(calls, [{ protection: { action: 'global', enabled: true } }]);
  const site = await handler(call({ action: 'protection', operation: 'site', tabId: 'mine', origin: 'https://owned.test', enabled: false })); assert.equal(site.success, true);
  assert.equal(receipt(await handler(call({ action: 'protection', operation: 'site', tabId: 'other', origin: 'https://other.test', enabled: false }))).code, 'BROWSER_TAB_OWNERSHIP');
  assert.equal(receipt(await handler(call({ action: 'protection', operation: 'site', tabId: 'chat', origin: 'https://chatgpt.com', enabled: false }))).code, 'BROWSER_HUMAN_CHAT_RESERVED');
});

test('filtering changes retain queued host admission and do not dispatch after authorization changes', async t => {
  const { browser, calls } = fixture(t);
  await assert.rejects(browser.perform({ action: 'protection', operation: 'global', enabled: true }, { owner, beforeDispatch: async () => { throw Object.assign(new Error('Grant revoked'), { code: 'DIRECT_AUTH_REQUIRED' }); } }), { code: 'DIRECT_AUTH_REQUIRED' });
  assert.deepEqual(calls, []);
  await browser.configureProtection({ action: 'global', enabled: true }, { source: 'agent', owner }); assert.equal(calls.length, 1);
});
