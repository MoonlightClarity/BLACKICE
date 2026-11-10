import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTerminalBrowserOwners, recoverTerminalBrowserOwners, returnTerminalBrowserTab } from '../lib/browser-owner-recovery.mjs';
import { ownershipChange } from '../lib/browser-ownership.mjs';

const original = { taskId: 'task-1', nodeId: 'agent', runId: 'run-failed' };
const resumed = { taskId: 'new-task', nodeId: 'bridge', runId: 'new-run' };

test('only verifiably failed/cancelled runs qualify for startup tab recovery', async () => {
  const tabs = [
    { tabId: 'failed-a', owner: original },
    { tabId: 'failed-b', owner: original },
    { tabId: 'cancelled', owner: { ...original, runId: 'run-cancelled' } },
    { tabId: 'live', owner: { ...original, runId: 'run-live' } },
    { tabId: 'blocked', owner: { ...original, runId: 'run-blocked' } },
    { tabId: 'unknown', owner: { ...original, runId: 'run-unknown' } },
    { tabId: 'mismatch', owner: { taskId: 'other-task', nodeId: 'agent', runId: 'run-failed' } },
    { tabId: 'human-chat', purpose: 'chat-mode', owner: original },
    { tabId: 'private', protectedContent: true, owner: original },
  ];
  const runs = new Map([
    ['run-failed', { id: 'run-failed', taskId: 'task-1', status: 'failed' }],
    ['run-cancelled', { id: 'run-cancelled', taskId: 'task-1', status: 'cancelled' }],
    ['run-live', { id: 'run-live', taskId: 'task-1', status: 'running' }],
    ['run-blocked', { id: 'run-blocked', taskId: 'task-1', status: 'blocked' }],
  ]);
  const seen = [];
  const browser = { status: () => ({ tabs }), releaseOwner: async (owner, opts) => {
    assert.equal(opts.retainForContinuation, true, 'startup preserves the continuing worker scope');
    seen.push([owner.runId, opts.status]);
    return { released: [owner.runId], retained: [] };
  } };
  const available = collectTerminalBrowserOwners(browser.status(), runs);
  assert.deepEqual(available.map(o => o.owner.runId), ['run-failed', 'run-cancelled']);
  const result = await recoverTerminalBrowserOwners(browser, runs);
  assert.deepEqual(seen, [['run-failed', 'failed'], ['run-cancelled', 'cancelled']]);
  assert.equal(result.released, 2);
  assert.equal(result.checked, 2);
  assert.equal(result.failures.length, 0);
});

test('terminal tab handback keeps the saved document and permits an explicit future takeover', () => {
  const tab = { tabId: 'waymo', id: 'waymo', url: 'https://example.org/apply', documentId: 'waymo:17', folderId: 'task-folder',
    owner: { ...original }, parentTabId: 'parent', humanCreated: false, userPinned: false, suspendedWork: new Set() };
  const receipt = returnTerminalBrowserTab(tab, { folderId: 'folder_user' });
  assert.deepEqual(receipt.previousOwner, original);
  assert.equal(tab.owner, null);
  assert.equal(tab.folderId, 'folder_user');
  assert.equal(tab.parentTabId, null);
  assert.equal(tab.humanCreated, true);
  assert.equal(tab.userPinned, true);
  assert.equal(tab.url, 'https://example.org/apply');
  assert.equal(tab.documentId, 'waymo:17');
  assert.equal(ownershipChange({ action: 'take_ownership', tabId: tab.tabId, expectedUrl: tab.url,
    expectedDocumentId: tab.documentId }, { tabs: [tab] }, resumed).owner.taskId, 'new-task');
});

test('busy, protected and already-human tabs are not silently reclaimed', () => {
  for (const value of [
    { pendingInteraction: { kind: 'alert' } }, { suspendedWork: new Set(['pending']) },
    { purpose: 'chat-mode' }, { protectedContent: true }, { owner: null },
  ]) {
    const tab = { id: 'one', owner: { ...original }, folderId: 'task-folder', ...value };
    assert.equal(returnTerminalBrowserTab(tab, { folderId: 'folder_user' }), null);
    assert.equal(tab.folderId, 'task-folder');
  }
});

test('recovery is non-destructive on unsupported adapters and records individual failures', async () => {
  assert.equal((await recoverTerminalBrowserOwners({ status: () => ({ tabs: [] }) }, new Map())).checked, 0);
  const tabs = [{ tabId: 'one', owner: original }];
  const runs = new Map([['run-failed', { id: 'run-failed', taskId: 'task-1', status: 'failed' }]]);
  const result = await recoverTerminalBrowserOwners({
    status: () => ({ tabs }), releaseOwner: async () => { throw Object.assign(new Error('disk not writable'), { code: 'BROWSER_SAVE_FAILED' }); },
  }, runs);
  assert.equal(result.released, 0);
  assert.deepEqual(result.failures.map(f => f.code), ['BROWSER_SAVE_FAILED']);
});
