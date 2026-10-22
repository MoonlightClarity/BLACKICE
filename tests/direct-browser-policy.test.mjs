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
  const { api, directory } = await fixture(t), connector = new ChatGPTConnector({ dataDir: directory, execution: api, planning: { tools: () => [], call: async () => { throw new Error('No planning tools in this fixture.'); } }, oauth: {} });
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

test('direct requests accept optional page guards and guarded coordinate hover through the same contract', async t => {
  const { api, calls } = await fixture(t), guard = { expectedUrl: 'https://example.test/', expectedDocumentId: 'one:1' };
  const requests = [
    ['blackice_browser_read', { action: 'read' }], ['blackice_browser_read', { action: 'snapshot' }],
    ['blackice_browser_action', { action: 'hover', x: 30, y: 40 }], ['blackice_browser_action', { action: 'fill', ref: 'field', text: 'draft' }],
    ['blackice_browser_action', { action: 'select', ref: 'choice', value: 'one' }], ['blackice_browser_action', { action: 'close' }],
  ];
  for (const [index, [name, args]] of requests.entries()) {
    const submitted = await api.call(name, { requestId: `guarded-${index}`, ...args, tabId: 'one', ...guard }, client);
    const done = await waitJob(api, submitted.jobId); assert.equal(done.status, 'succeeded', JSON.stringify(done));
  }
  assert.equal(calls.length, requests.length);
  assert.ok(calls.every(args => args.expectedDocumentId === guard.expectedDocumentId && args.expectedUrl === guard.expectedUrl));
  await assert.rejects(api.call('blackice_browser_action', { requestId: 'unguarded-hover', action: 'hover', tabId: 'one', x: 30, y: 40 }, client), { code: 'DIRECT_REQUEST_INVALID', actionDispatched: false });
  assert.equal(calls.length, requests.length);
});

test('a pending dialog leaves observation, cleanup, navigation and other tabs available', async t => {
  const { api, calls, tabs } = await fixture(t, { pending: { ...interaction }, inspect: true });
  tabs.push({ tabId: 'two', url: 'https://unrelated.test/', folderId: 'personal' });
  const requests = [
    ['blackice_browser_read', { action: 'read', tabId: 'one' }], ['blackice_browser_read', { action: 'tabs' }],
    ['blackice_browser_action', { action: 'navigate', tabId: 'one', url: 'https://example.test/next' }],
    ['blackice_browser_action', { action: 'close', tabId: 'one' }], ['blackice_browser_action', { action: 'click', tabId: 'two', ref: 'observed' }],
  ];
  for (const [index, [name, args]] of requests.entries()) {
    const submitted = await api.call(name, { requestId: `available-${index}`, ...args }, client), done = await waitJob(api, submitted.jobId);
    assert.equal(done.status, 'succeeded', JSON.stringify(done));
  }
  assert.equal(calls.length, requests.length);
  const click = await api.call('blackice_browser_action', { requestId: 'blocked-page-input', action: 'click', tabId: 'one', ref: 'observed' }, client), waiting = await waitJob(api, click.jobId);
  assert.equal(waiting.status, 'awaiting_input'); assert.deepEqual(waiting.effects, { possible: false, confirmed: false }); assert.equal(calls.length, requests.length);
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
