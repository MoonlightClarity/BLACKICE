import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserWorkspace, createBrowserToolHandler } from '../lib/browser.mjs';

const owner = { taskId: 'task', runId: 'run', nodeId: 'agent' };
const parsed = result => JSON.parse(result.contentItems[0].text);
function fixture(t, { limit = 3, capacity = true } = {}) {
  const tabs = [
    { tabId: 'sibling-private-id', owner: { ...owner, nodeId: 'reviewer' }, suspended: false },
    { tabId: 'saved-owned', owner, suspended: true },
    { tabId: 'other-task-private-id', owner: { ...owner, taskId: 'other-task' }, suspended: false },
    { tabId: 'personal-private-id', suspended: false },
    { tabId: 'reserved-human-id', purpose: 'chat-mode', owner, suspended: false },
    { tabId: 'firefox:external', browser: 'firefox', owner, suspended: false },
    { tabId: 'protected-private-id', protectedContent: true, suspended: true },
  ], calls = []; let next = 0;
  const taskLive = () => tabs.filter(tab => !tab.suspended && tab.purpose !== 'chat-mode' && tab.browser !== 'firefox' && tab.owner?.taskId === owner.taskId).length;
  const status = () => ({ available: true, contained: true, tabs: tabs.map(tab => ({ ...tab })), ...(capacity ? { capacity: { live: 4 + next, perTaskLive: limit, maxLive: 32 } } : {}) });
  const driver = { status, perform: async (args, options) => {
    calls.push(args);
    if (args.action === 'tabs') return status();
    if (args.action === 'open') {
      if (taskLive() >= limit) throw Object.assign(new Error(`This task has ${limit} live pages. Reuse or close one of its own pages before opening another.`), { code: 'BROWSER_TASK_TAB_LIMIT', actionDispatched: false, capacity: { privateExtra: 'DO-NOT-ECHO' } });
      const tab = { tabId: `opened-${++next}`, owner: options.owner, suspended: false, url: args.url }; tabs.push(tab); return { tabId: tab.tabId, url: tab.url, tabs };
    }
    const tab = tabs.find(tab => tab.tabId === args.tabId);
    if (args.action === 'close') { tabs.splice(tabs.indexOf(tab), 1); return status(); }
    if (args.action === 'suspend') tab.suspended = true;
    if (args.action === 'navigate') tab.url = args.url;
    return { tabId: tab.tabId, tabs };
  } };
  const browser = new BrowserWorkspace({ driver }); t.after(() => browser.close());
  const handler = createBrowserToolHandler({ browser, owner });
  return { tabs, calls, call: args => handler({ name: 'relay_browser', arguments: { browser: 'relay', ...args } }) };
}

test('open reports the shared task live budget while preserving worker-scoped page visibility', async t => {
  const f = fixture(t), response = await f.call({ action: 'open', url: 'https://example.invalid/research' });
  assert.equal(response.success, true); const result = parsed(response);
  assert.deepEqual(result.taskCapacity, { live: 2, limit: 3, remaining: 1 });
  assert.deepEqual(result.tabs.map(tab => tab.tabId), ['saved-owned', 'opened-1']);
  assert.deepEqual(result.ownershipCandidates, [
    { tabId: 'sibling-private-id', ownerKey: JSON.stringify(['task', 'reviewer', 'run']) },
    { tabId: 'saved-owned', ownerKey: JSON.stringify(['task', 'agent', 'run']) },
    { tabId: 'other-task-private-id', ownerKey: JSON.stringify(['other-task', 'agent', 'run']) },
    { tabId: 'personal-private-id', ownerKey: null },
    { tabId: 'opened-1', url: 'https://example.invalid/research', ownerKey: JSON.stringify(['task', 'agent', 'run']) },
  ], 'Explicit ownership transfers expose only their required public identity metadata.');
  assert.doesNotMatch(JSON.stringify(result), /reserved-human-id|protected-private-id|firefox:external/);
  assert.deepEqual(f.calls.map(call => call.action), ['open'], 'Feedback must not automatically close, suspend, or navigate any page.');
});

test('limit errors preserve no-dispatch semantics and lead to usable tabs, navigate, suspend and open recovery without raising limits', async t => {
  const f = fixture(t);
  for (let index = 0; index < 2; index++) assert.equal((await f.call({ action: 'open', url: `https://example.invalid/${index}` })).success, true);
  const rejected = await f.call({ action: 'open', url: 'https://example.invalid/not-opened' }), error = parsed(rejected);
  assert.equal(rejected.success, false); assert.equal(rejected.code, 'BROWSER_TASK_TAB_LIMIT'); assert.equal(error.actionDispatched, false);
  assert.match(error.error, /"action":"tabs"/); assert.match(error.error, /navigate/); assert.match(error.error, /suspend/); assert.match(error.error, /finished.*owned/);
  assert.ok(error.error.length <= 1500, 'Recovery guidance stays within the existing bounded diagnostic size.');
  assert.deepEqual(Object.keys(error).sort(), ['actionDispatched', 'code', 'error']); assert.doesNotMatch(JSON.stringify(error), /DO-NOT-ECHO|private-id/);
  assert.equal(f.tabs.some(tab => tab.url === 'https://example.invalid/not-opened'), false);
  const example = JSON.parse(error.error.match(/\{"action":"tabs"[^}]*\}/)[0]);
  const inventory = parsed(await f.call(example)); assert.deepEqual(inventory.tabs.map(tab => tab.tabId), ['saved-owned', 'opened-1', 'opened-2']);
  assert.equal((await f.call({ action: 'navigate', tabId: 'opened-1', url: 'https://example.invalid/reused' })).success, true);
  assert.equal((await f.call({ action: 'open', url: 'https://example.invalid/still-full' })).success, false, 'Navigate reuses a slot; it does not increase capacity.');
  const denied = await f.call({ action: 'suspend', tabId: 'personal-private-id' }); assert.equal(denied.success, false);
  assert.equal((await f.call({ action: 'suspend', tabId: 'opened-1' })).success, true);
  const resumed = await f.call({ action: 'open', url: 'https://example.invalid/next' }); assert.equal(resumed.success, true);
  assert.deepEqual(parsed(resumed).taskCapacity, { live: 3, limit: 3, remaining: 0 });
  const close = JSON.parse(error.error.match(/\{"action":"close"[^}]*\}/)[0]); close.tabId = 'opened-2';
  assert.equal((await f.call(close)).success, true); assert.equal(f.tabs.some(tab => tab.tabId === 'opened-2'), false);
  const afterClose = await f.call({ action: 'open', url: 'https://example.invalid/after-finished-close' });
  assert.equal(afterClose.success, true); assert.deepEqual(parsed(afterClose).taskCapacity, { live: 3, limit: 3, remaining: 0 });
  for (const id of ['sibling-private-id', 'other-task-private-id', 'personal-private-id', 'reserved-human-id']) assert.equal(f.tabs.find(tab => tab.tabId === id).suspended, false);
});

test('older or incomplete status metadata omits capacity rather than inventing a limit or failing a successful open', async t => {
  for (const options of [{ capacity: false }, { limit: '3' }]) {
    const f = fixture(t, options), response = await f.call({ action: 'open', url: 'https://example.invalid/' });
    assert.equal(response.success, true); assert.equal(parsed(response).taskCapacity, undefined);
  }
});
