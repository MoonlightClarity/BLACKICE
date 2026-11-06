import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTerminalBrowserOwners, recoverTerminalBrowserOwners } from '../lib/browser-owner-recovery.mjs';


const original = { taskId: 'task-1', nodeId: 'agent', runId: 'run-failed' };

test('only verified failed/cancelled runs are inspected at startup without browser handoff', async () => {
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
    seen.push([owner.runId, opts.status, opts.retainForContinuation]);
    return { released: [], retained: [{ tabId: owner.runId }] };
  } };
  const available = collectTerminalBrowserOwners(browser.status(), runs);
  assert.deepEqual(available.map(o => o.owner.runId), ['run-failed', 'run-cancelled']);
  const result = await recoverTerminalBrowserOwners(browser, runs);
  assert.deepEqual(seen, [['run-failed', 'failed', true], ['run-cancelled', 'cancelled', true]]);
  assert.equal(result.released, 0);
  assert.equal(result.retained, 2);
  assert.equal(result.checked, 2);
  assert.equal(result.failures.length, 0);
});

test('startup recovery never assigns an agent browser tab to the user', async () => {
  const tab = { tabId: 'waymo', id: 'waymo', url: 'https://example.org/apply', documentId: 'waymo:17',
    folderId: 'task-folder', owner: { ...original }, parentTabId: 'parent', humanCreated: false, userPinned: false };
  const runs = new Map([[original.runId, { id: original.runId, taskId: original.taskId, status: 'failed' }]]);
  const browser = {
    status: () => ({ tabs: [tab] }),
    releaseOwner: async (owner, options) => {
      assert.deepEqual(owner, original);
      assert.equal(options.retainForContinuation, true);
      return { suspended: [], retained: [{ tabId: tab.id }], released: [] };
    },
  };
  const result = await recoverTerminalBrowserOwners(browser, runs);
  assert.equal(result.checked, 1);
  assert.equal(result.released, 0);
  assert.equal(result.retained, 1);
  assert.deepEqual(tab.owner, original);
  assert.equal(tab.folderId, 'task-folder');
  assert.equal(tab.documentId, 'waymo:17');
  assert.equal(tab.humanCreated, false);
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
