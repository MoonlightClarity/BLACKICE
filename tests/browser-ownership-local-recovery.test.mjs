import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DirectExecutionAPI, DIRECT_EXECUTION_SCOPES } from '../lib/direct-execution-api.mjs';
import { BrowserWorkspace } from '../lib/browser.mjs';
import { ownershipChange } from '../lib/browser-ownership.mjs';

async function settled(api, jobId, client) {
  for (let i = 0; i < 100; i++) {
    const job = await api.getJob(jobId, client);
    if (job.settled) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('The local browser command did not settle.');
}

test('local browser transfer can recover a foreign failed-run tab into an observed destination without repeating effects', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blackice-local-browser-recovery-'));
  const previous = { taskId: 'old-task', runId: 'failed-run', nodeId: 'agent' };
  const next = { taskId: 'new-task', runId: 'current-run', nodeId: 'bridge' };
  const tab = { tabId: 'waymo', url: 'https://employer.example/jobs/123#apply',
    documentId: 'waymo:39', folderId: 'old-folder', owner: { ...previous } };
  const destination = { tabId: 'anchor', url: 'https://example.org/',
    documentId: 'anchor:2', folderId: 'new-folder', owner: { ...next } };
  let dispatched = 0;
  const driver = {
    status: () => ({
      contained: true, available: true, tabs: [structuredClone(tab), structuredClone(destination)],
      folders: [{ id: 'old-folder', kind: 'task', taskId: previous.taskId },
        { id: 'new-folder', kind: 'task', taskId: next.taskId }]
    }),
    async perform(args, { owner, source } = {}) {
      const change = ownershipChange(args, this.status(), owner, source);
      dispatched++;
      tab.owner = change.owner;
      if (change.folderId) tab.folderId = change.folderId;
      return { ownershipReceipt: { action: args.action, tabId: tab.tabId,
        documentId: tab.documentId, owner: tab.owner, folderId: tab.folderId } };
    }
  };
  const browser = new BrowserWorkspace({ driver });
  const api = new DirectExecutionAPI({ dataDir: dir, allowedRoot: dir, browser });
  await api.init();
  t.after(async () => { await api.close(); await browser.close(); await rm(dir, { recursive: true, force: true }); });
  const local = { id: 'local-browser-tools', kind: 'local-browser', scopes: [...DIRECT_EXECUTION_SCOPES] };
  const remote = { id: 'another-grant', kind: 'chatgpt', scopes: [...DIRECT_EXECUTION_SCOPES] };
  const base = { action: 'transfer_ownership', tabId: tab.tabId, expectedUrl: tab.url,
    expectedDocumentId: tab.documentId, destination: 'task', destinationTabId: destination.tabId,
    destinationOwnerKey: JSON.stringify([next.taskId, next.nodeId, next.runId]) };

  await assert.rejects(api.call('blackice_browser_action', { requestId: 'remote-take', ...base }, remote),
    { code: 'BROWSER_TAB_OWNERSHIP' }, 'a remote grant may not transfer another task\'s tab');
  assert.equal(dispatched, 0);

  const accepted = await api.call('blackice_browser_action', { requestId: 'local-recover', ...base }, local);
  const first = await settled(api, accepted.jobId, local);
  assert.equal(first.status, 'succeeded', JSON.stringify(first));
  assert.deepEqual(tab.owner, next);
  assert.equal(tab.folderId, 'new-folder');
  assert.equal(dispatched, 1);
  const repeated = await api.call('blackice_browser_action', { requestId: 'local-recover', ...base }, local);
  assert.equal(repeated.jobId, accepted.jobId);
  assert.equal(repeated.existing, true);
  assert.equal(dispatched, 1, 'same durable request must never dispatch twice');

  const stale = await api.call('blackice_browser_action',
    { requestId: 'stale-transfer', action: 'transfer_ownership', tabId: tab.tabId,
      expectedUrl: tab.url, expectedDocumentId: 'waymo:stale', destination: 'user' }, local);
  const invalid = await settled(api, stale.jobId, local);
  assert.notEqual(invalid.status, 'succeeded');
  assert.equal(dispatched, 1, 'stale document must be rejected without an effect');

  const toUser = await api.call('blackice_browser_action', { requestId: 'return-to-user',
    action: 'transfer_ownership', tabId: tab.tabId, expectedUrl: tab.url,
    expectedDocumentId: tab.documentId, destination: 'user' }, local);
  const final = await settled(api, toUser.jobId, local);
  assert.equal(final.status, 'succeeded', JSON.stringify(final));
  assert.equal(tab.owner, null);
  assert.equal(dispatched, 2);
});
