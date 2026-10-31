import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserWorkspace } from '../lib/browser.mjs';
import { DirectExecutionAPI, validDirectArguments } from '../lib/direct-execution-api.mjs';
import { ChatGPTConnector } from '../lib/chatgpt-connector.mjs';

const client = { id: 'browser-policy-connection', label: 'ChatGPT', kind: 'chatgpt', scopes: ['read', 'browser:read', 'browser:write'] };
const interactionId = 'browser_input_11111111-1111-4111-8111-111111111111';
const interaction = { id: interactionId, tabId: 'one', documentId: 'one:1', url: 'https://example.test/', kind: 'javascript_dialog', dialogType: 'prompt', status: 'pending' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, { pending = null, inspect = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-direct-browser-policy-')), calls = [];
  const tabs = [{ tabId: 'one', url: 'https://example.test/', folderId: 'personal' }, { tabId: 'other', url: 'https://other.test/', folderId: 'other', owner: { taskId: 'other', runId: 'other', nodeId: 'other' } }, { tabId: 'chat', url: 'https://chatgpt.com/c/caller', purpose: 'chat-mode', folderId: 'calling' }];
  let enabled = false;
  const driver = {
    status: () => ({ available: true, contained: true, tabs: structuredClone(tabs), activeTab: 'one', folders: [{ id: 'personal', kind: 'user' }, { id: 'other', kind: 'task', taskId: 'other' }, { id: 'calling', kind: 'user' }] }),
    async perform(args) {
      calls.push(structuredClone(args));
      if (args.action === 'interaction') {
        if (!pending || args.interactionId !== pending.id || args.expectedDocumentId !== pending.documentId || args.expectedUrl !== pending.url) throw Object.assign(new Error('The observed interaction changed.'), { code: 'BROWSER_INTERACTION_CHANGED' });
        pending = null;
        return { tabId: 'one', documentId: 'one:1', frames: [{ text: args.promptText }], receipt: { interactionId: args.interactionId, decision: args.decision, replayed: false } };
      }
      return { tabs: structuredClone(tabs), receipt: { action: args.action } };
    },
    protectionStatus: () => ({ available: true, ready: true, enabled, exemptOrigins: [], tabs: tabs.map(tab => ({ tabId: tab.tabId, enabled })) }),
    async configureProtection(args) { calls.push({ action: 'protection', ...structuredClone(args), operation: args.action }); if (args.action === 'global') enabled = args.enabled; return this.protectionStatus(); },
    async close() {},
  };
  const browser = new BrowserWorkspace({ driver }), api = new DirectExecutionAPI({ dataDir: directory, allowedRoot: directory, browser, ...(inspect ? { inspectBrowserInteraction: () => pending } : {}) });
  await api.init(); t.after(async () => { await api.close(); await browser.close(); await rm(directory, { recursive: true, force: true }); });
  return { api, browser, directory, calls, tabs };
}
async function waitJob(api, jobId, who = client) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) { const job = await api.getJob(jobId, who); if (job.settled || job.status === 'awaiting_input') return job; await delay(5); }
  throw new Error('The fixture job did not settle.');
}

test('MCP discovery publishes the same expanded browser schemas with the existing scopes', async t => {
  const { api, directory } = await fixture(t), connector = new ChatGPTConnector({ dataDir: directory, execution: api, planning: { tools: () => [], call: async () => { throw new Error('Discovery must not execute planning tools.'); } }, oauth: {} });
  for (const [name, scope] of [['blackice_browser_action', 'browser:write'], ['blackice_browser_read', 'browser:read']]) {
    const runtime = api.tools().find(tool => tool.name === name), exposed = connector.tools().find(tool => tool.name === name);
    assert.deepEqual(exposed.inputSchema, runtime.inputSchema); assert.deepEqual(exposed.securitySchemes, [{ type: 'oauth2', scopes: ['read', scope] }]);
  }
  const tool = api.tools().find(tool => tool.name === 'blackice_browser_action');
  for (const action of ['interaction', 'folder_create', 'folder_rename', 'folder_close', 'tab_move', 'suspend', 'protection']) assert.ok(tool.inputSchema.properties.action.enum.includes(action));
  assert.equal(tool.inputSchema.properties.password, undefined);
  assert.equal(validDirectArguments({ requestId: 'null-parent', action: 'tab_move', tabId: 'one', parentTabId: null }, tool.inputSchema), true);
  assert.equal(validDirectArguments({ requestId: 'bad-parent', action: 'tab_move', tabId: 'one', parentTabId: {} }, tool.inputSchema), false);
  assert.equal(validDirectArguments({ requestId: 'long-prompt', action: 'interaction', promptText: 'x'.repeat(4097) }, tool.inputSchema), false);
});

test('direct read discovery matches current-page observation while input actions retain their guards', async t => {
  const { api, calls } = await fixture(t), read = api.tools().find(tool => tool.name === 'blackice_browser_read');
  const action = api.tools().find(tool => tool.name === 'blackice_browser_action');
  assert.equal(read.inputSchema.properties.expectedUrl, undefined);
  assert.equal(read.inputSchema.properties.expectedDocumentId, undefined);
  assert.match(read.description, /Reads observe the current page/);
  assert.ok(action.inputSchema.properties.expectedUrl);
  assert.ok(action.inputSchema.properties.expectedDocumentId);
  for (const operation of ['read', 'snapshot', 'screenshot']) {
    const request = { requestId: 'read-contract-' + operation, action: operation, browser: 'relay', tabId: 'one' };
    assert.equal(validDirectArguments(request, read.inputSchema), true);
    for (const guards of [{ expectedUrl: 'https://example.test/' }, { expectedDocumentId: 'one:1' }, { expectedUrl: 'https://example.test/', expectedDocumentId: 'one:1' }]) {
      assert.equal(validDirectArguments({ ...request, ...guards }, read.inputSchema), false);
      await assert.rejects(api.call('blackice_browser_read', { ...request, ...guards }, client), { code: 'DIRECT_REQUEST_INVALID' });
    }
  }
  assert.equal((await api.listJobs(client)).total, 0, 'Unsupported read guards are rejected before admission.');
  const request = { requestId: 'read-current-page', action: 'read', browser: 'relay', tabId: 'one', query: 'visible heading' };
  const job = await api.call('blackice_browser_read', request, client), result = await waitJob(api, job.jobId);
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.deepEqual(result.effects, { possible: false, confirmed: false });
  assert.deepEqual(calls, [{ action: 'read', browser: 'relay', tabId: 'one', query: 'visible heading' }]);
  assert.equal((await api.call('blackice_browser_read', request, client)).existing, true);
  assert.equal(calls.length, 1);
});

test('authorized direct organization and filtering dispatch once without new grants or local approval', async t => {
  const { api, calls } = await fixture(t), writer = { ...client, scopes: ['read', 'browser:write'] };
  const actions = [
    { action: 'folder_create', name: 'Research' }, { action: 'folder_rename', folderId: 'personal', name: 'Sources' },
    { action: 'tab_move', tabId: 'one', parentTabId: null }, { action: 'suspend', tabId: 'one' },
    { action: 'folder_close', folderId: 'personal' }, { action: 'protection', operation: 'global', enabled: true },
    { action: 'protection', operation: 'site', tabId: 'one', origin: 'https://example.test', enabled: false }, { action: 'protection', operation: 'refresh' },
  ];
  for (const [index, action] of actions.entries()) {
    const args = { requestId: `supported-${index}`, ...action }, job = await api.call('blackice_browser_action', args, writer), done = await waitJob(api, job.jobId, writer);
    assert.equal(done.status, 'succeeded', JSON.stringify(done)); assert.deepEqual(done.requiredScopes, ['browser:write']); assert.equal(done.interaction, null);
    const repeated = await api.call('blackice_browser_action', args, writer); assert.equal(repeated.existing, true); assert.equal(repeated.jobId, job.jobId);
  }
  assert.equal(calls.length, actions.length);
  const reader = { ...client, scopes: ['read', 'browser:read'] }, read = await api.call('blackice_browser_read', { requestId: 'filter-status', action: 'protection' }, reader), status = await waitJob(api, read.jobId, reader);
  assert.equal(status.status, 'succeeded'); assert.equal(JSON.parse(status.result.text.text).enabled, true); assert.deepEqual(status.effects, { possible: false, confirmed: false });
  await assert.rejects(api.call('blackice_browser_action', { requestId: 'missing-write', action: 'protection', operation: 'global', enabled: false }, reader), { code: 'DIRECT_SCOPE_REQUIRED' });
});

test('direct form fills, selections and hover retain complete optional guards and deduplicate execution', async t => {
  const { api, calls } = await fixture(t);
  const guard = { tabId: 'one', expectedUrl: 'https://example.test/', expectedDocumentId: 'one:1' };
  for (const action of ['fill', 'select', 'hover']) {
    const args = { requestId: `guarded-${action}`, ...guard, action, ref: 'observed-control', ...(action === 'fill' ? { text: 'Owned draft' } : action === 'select' ? { value: 'available-option' } : {}) };
    const job = await api.call('blackice_browser_action', args, client), done = await waitJob(api, job.jobId);
    assert.equal(done.status, 'succeeded', JSON.stringify(done));
    assert.deepEqual(calls.at(-1), { ...Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'requestId')), browser: 'relay' });
    const count = calls.length, repeated = await api.call('blackice_browser_action', args, client);
    assert.equal(repeated.jobId, job.jobId); assert.equal(repeated.existing, true); assert.equal(calls.length, count);
    for (const [index, missing] of ['expectedUrl', 'expectedDocumentId'].entries()) {
      const incomplete = { ...args, requestId: `incomplete-${action}-${index}` }; delete incomplete[missing];
      await assert.rejects(api.call('blackice_browser_action', incomplete, client), { code: 'DIRECT_REQUEST_INVALID' });
    }
  }
  assert.equal(calls.length, 3);
  assert.equal((await api.listJobs(client)).total, 3, 'Incomplete guards never create durable jobs.');
  await assert.rejects(api.call('blackice_browser_action', { requestId: 'guarded-foreign', action: 'fill', ...guard, tabId: 'other', ref: 'observed-control', text: 'Owned draft' }, client), { code: 'BROWSER_TAB_OWNERSHIP' });
  await assert.rejects(api.call('blackice_browser_action', { requestId: 'guarded-no-write', action: 'fill', ...guard, ref: 'observed-control', text: 'Owned draft' }, { ...client, scopes: ['read', 'browser:read'] }), { code: 'DIRECT_SCOPE_REQUIRED' });
  assert.equal(calls.length, 3);
});

test('an exact direct dialog decision resolves the pending interaction without replaying its original click or storing prompt text', async t => {
  const { api, directory, calls } = await fixture(t, { pending: { ...interaction }, inspect: true });
  const blocked = await api.call('blackice_browser_action', { requestId: 'original-click', action: 'click', tabId: 'one', ref: 'observed' }, client), waiting = await waitJob(api, blocked.jobId);
  assert.equal(waiting.status, 'awaiting_input'); assert.equal(calls.length, 0);
  const promptText = 'private-prompt-fixture-812', args = { requestId: 'resolve-prompt', action: 'interaction', tabId: 'one', interactionId, expectedUrl: interaction.url, expectedDocumentId: interaction.documentId, decision: 'accept', promptText };
  const resolution = await api.call('blackice_browser_action', args, client), done = await waitJob(api, resolution.jobId);
  assert.equal(done.status, 'succeeded', JSON.stringify(done)); assert.equal(calls[0].promptText, promptText); assert.equal(calls.length, 1);
  const result = JSON.parse(done.result.text.text); assert.deepEqual(result.receipt, { replayed: false, decision: 'accept', interactionId });
  assert.doesNotMatch(JSON.stringify(done), new RegExp(promptText)); assert.doesNotMatch(await readFile(path.join(directory, 'direct-execution-jobs', `${resolution.jobId}.json`), 'utf8'), new RegExp(promptText));
  assert.equal((await api.call('blackice_browser_action', args, client)).existing, true); assert.equal(calls.length, 1);
  assert.equal((await api.getJob(blocked.jobId, client)).status, 'awaiting_input', 'Resolving a dialog never relabels or replays its earlier uncertain action.');
});

test('new direct actions reject malformed fields and foreign or caller targets before admission', async t => {
  const { api, calls } = await fixture(t);
  const invalid = [
    { action: 'interaction', tabId: 'one', interactionId, decision: 'accept' },
    { action: 'interaction', tabId: 'one', interactionId, expectedUrl: interaction.url, expectedDocumentId: interaction.documentId, decision: 'dismiss', promptText: 'unexpected' },
    { action: 'folder_create', name: ' ' }, { action: 'folder_rename', name: 'Missing folder' },
    { action: 'protection', operation: 'global' }, { action: 'protection', operation: 'site', enabled: false },
    { action: 'protection', operation: 'refresh', enabled: true }, { action: 'click', tabId: 'one', ref: 'observed', promptText: 'irrelevant' },
  ];
  for (const [index, args] of invalid.entries()) await assert.rejects(api.call('blackice_browser_action', { requestId: `invalid-${index}`, ...args }, client), { code: 'DIRECT_REQUEST_INVALID' });
  await assert.rejects(api.call('blackice_browser_action', { requestId: 'foreign-folder', action: 'folder_close', folderId: 'other' }, client), { code: 'BROWSER_TAB_OWNERSHIP' });
  await assert.rejects(api.call('blackice_browser_action', { requestId: 'caller-folder', action: 'folder_close', folderId: 'calling' }, client), { code: 'BROWSER_HUMAN_CHAT_RESERVED' });
  await assert.rejects(api.call('blackice_browser_read', { requestId: 'read-mutation', action: 'protection', operation: 'global', enabled: true }, client), { code: 'DIRECT_REQUEST_INVALID' });
  assert.equal((await api.listJobs(client)).total, 0); assert.deepEqual(calls, []);
});
