import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_TOOL, BrowserWorkspace, browserOwnerKey, createBrowserToolHandler } from '../lib/browser.mjs';

const payload = result => JSON.parse(result.contentItems[0].text);
const owner = { taskId: 'protocol', runId: 'run', nodeId: 'agent' };
function fixture(t, { ownedTab = false } = {}) {
  const state = { tabs: ownedTab ? [{ tabId: 'observed-owned', browser: 'relay', owner, url: 'https://example.test/source' }] : [],
    ownerActiveTabs: ownedTab ? { [browserOwnerKey(owner)]: 'observed-owned' } : {} };
  const calls = [], admissions = [];
  const driver = {
    status: () => ({ available: true, contained: true, ...state }),
    async perform(args) {
      calls.push({ ...args });
      if (args.action === 'tabs') return { tabs: state.tabs };
      if (args.action === 'open') {
        const tab = { tabId: 'returned-new', browser: 'relay', owner, url: args.url };
        state.tabs.push(tab); state.ownerActiveTabs[browserOwnerKey(owner)] = tab.tabId;
        return { ...tab };
      }
      return { tabId: args.tabId, frames: [{ text: 'Observed contained page.' }] };
    }
  };
  const browser = new BrowserWorkspace({ driver });
  t.after(() => browser.close());
  const handler = createBrowserToolHandler({ browser, owner, beforeDispatch: args => admissions.push(args) });
  const call = args => handler({ name: 'relay_browser', arguments: { browser: 'relay', ...args } });
  return { state, calls, admissions, browser, call };
}

test('missing tab recovery observes inventory and opens the intended URL without inventing a tab or changing driver', async t => {
  const f = fixture(t), url = 'https://example.test/requested';
  const missing = await f.call({ action: 'navigate', url });
  assert.equal(missing.code, 'BROWSER_TAB_NOT_FOUND');
  assert.equal(payload(missing).actionDispatched, false);
  assert.match(payload(missing).error, /\{"action":"tabs","browser":"relay"\}/);
  assert.match(payload(missing).error, /action:"open" with the intended url and no tabId/);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.admissions, []);
  assert.deepEqual(payload(await f.call({ action: 'tabs' })).tabs, []);
  const opened = await f.call({ action: 'open', url });
  assert.equal(opened.success, true);
  const tabId = payload(opened).tabId;
  assert.equal(tabId, 'returned-new');
  assert.equal((await f.call({ action: 'snapshot', tabId })).success, true);
  assert.deepEqual(f.calls, [{ action: 'tabs', browser: 'relay' }, { action: 'open', browser: 'relay', url }, { action: 'snapshot', browser: 'relay', tabId }]);
  const stale = await f.call({ action: 'navigate', url, tabId: 'unobserved-id' });
  assert.equal(stale.code, 'BROWSER_TAB_NOT_FOUND');
  assert.match(payload(stale).error, /requested tabId is not in the current contained tabs/);
  assert.equal(f.calls.length, 3);
});

test('open and navigate identify their missing URL before dispatch and accept only the corrected intended destination', async t => {
  const f = fixture(t, { ownedTab: true });
  for (const action of ['open', 'navigate']) for (const url of [undefined, null, '', '   ', 7]) {
    const result = await f.call({ action, url, ...(action === 'navigate' ? { tabId: 'observed-owned' } : {}) });
    assert.equal(result.code, 'BROWSER_VALIDATION');
    assert.match(payload(result).error, new RegExp(`The ${action} action requires a nonempty url`));
    assert.equal(payload(result).actionDispatched, false);
  }
  assert.deepEqual(f.calls, []); assert.deepEqual(f.admissions, []);
  const url = 'https://example.test/corrected';
  assert.equal((await f.call({ action: 'open', url })).success, true);
  assert.deepEqual(f.calls, [{ action: 'open', browser: 'relay', url }]);
  assert.match(BROWSER_TOOL.inputSchema.properties.url.description, /Required for open and navigate/);
  assert.match(BROWSER_TOOL.inputSchema.properties.tabId.description, /Omit it for open; never guess/);
  assert.deepEqual(BROWSER_TOOL.inputSchema.required, ['action'], 'Provider compatibility is preserved without adding conditional schema branches.');
});

test('host-verified owned active-tab routing remains usable and recovery does not broaden ownership', async t => {
  const f = fixture(t, { ownedTab: true });
  f.state.tabs.push({ tabId: 'another-task', browser: 'relay', owner: { ...owner, taskId: 'other' } }, { tabId: 'human', browser: 'relay', purpose: 'chat-mode' });
  assert.equal((await f.call({ action: 'navigate', url: 'https://example.test/next' })).success, true);
  assert.equal(f.calls[0].tabId, 'observed-owned');
  assert.equal((await f.call({ action: 'snapshot', tabId: 'another-task' })).code, 'BROWSER_TAB_OWNERSHIP');
  assert.equal((await f.call({ action: 'snapshot', tabId: 'human' })).code, 'BROWSER_HUMAN_CHAT_RESERVED');
  f.state.ownerActiveTabs[browserOwnerKey(owner)] = 'another-task';
  assert.equal((await f.call({ action: 'snapshot' })).code, 'BROWSER_TAB_NOT_FOUND');
  assert.equal(f.calls.length, 1, 'A recovery hint does not select an unrelated or reserved page.');
});

test('missing keyboard keys fail before admission and recovery preserves the observed button ref', async t => {
  const f = fixture(t, { ownedTab: true });
  const target = { tabId: 'observed-owned', ref: 'observed-button', expectedUrl: 'https://example.test/source', expectedDocumentId: 'observed-document' };
  for (const key of [undefined, null, '', '  ', 13, {}]) {
    const result = await f.call({ action: 'press', ...target, key });
    assert.equal(result.code, 'BROWSER_VALIDATION');
    assert.equal(payload(result).actionDispatched, false);
    assert.match(payload(result).error, /keyboard action and requires key/);
    assert.match(payload(result).error, /action:"click" with its exact snapshot ref/);
  }
  assert.deepEqual(f.calls, []); assert.deepEqual(f.admissions, []);
  await assert.rejects(f.browser.perform({ action: 'press', browser: 'relay', ...target }, { source: 'user' }), error => error.code === 'BROWSER_VALIDATION' && error.actionDispatched === false);
  assert.deepEqual(f.calls, [], 'Programmatic calls also reject the missing key before reaching the driver.');
  assert.equal((await f.call({ action: 'click', ...target })).success, true);
  assert.deepEqual(f.calls[0], { action: 'click', browser: 'relay', ...target });
  assert.equal((await f.call({ action: 'press', ...target, key: 'Enter' })).success, true);
  assert.equal(f.calls[1].key, 'Enter');
  assert.equal(f.admissions.length, 2, 'Only the two valid requests reach admission.');
});

test('navigation diagnostics preserve programmatic URL inputs and established address normalization for local user calls', async t => {
  const f = fixture(t, { ownedTab: true });
  const destinations = [
    [new URL('https://example.test/programmatic'), 'https://example.test/programmatic'],
    [new URL('file:///C:/Documents/local.html'), 'file:///C:/Documents/local.html'],
    ['  ABOUT:blank  ', 'about:blank'],
    ['localhost:3000/page', 'http://localhost:3000/page']
  ];
  for (const action of ['open', 'navigate']) for (const [url, expected] of destinations) {
    await f.browser.perform({ action, url, ...(action === 'navigate' ? { tabId: 'observed-owned' } : {}) }, { source: 'user' });
    assert.equal(f.calls.at(-1).url, expected);
  }
  assert.equal(f.calls.length, destinations.length * 2);
});
