import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserWorkspace } from '../lib/browser.mjs';
import { DirectExecutionAPI, DIRECT_EXECUTION_SCOPES, validDirectArguments } from '../lib/direct-execution-api.mjs';
import { createDirectBrowserCredentialTools } from '../lib/browser-credential-tools.mjs';

const client = { id: 'one-shared-connector', kind: 'chatgpt', scopes: [...DIRECT_EXECUTION_SCOPES] };
const owner = id => ({ taskId: id, runId: id + '-run', nodeId: 'conversation', conversationId: id, label: 'Conversation ' + id });
const parse = result => JSON.parse(result.result.text.text);
async function settled(api, admitted) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = await api.getJob(admitted.jobId, client, { limit: 50000 });
    if (job.settled) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('Conversation browser job did not settle');
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-direct-conversations-'));
  const conversations = new Map(['a', 'b'].map(id => [id, { id, taskId: id, title: 'Conversation ' + id, state: 'active', latestRunId: id + '-run', tabCount: 0 }]));
  const tabs = [{ tabId: 'personal', url: 'https://personal.test/', documentId: 'personal:1', folderId: 'folder_user', owner: null, contained: true }];
  const calls = [];
  const driver = {
    status: () => ({ available: true, contained: true, activeTab: 'personal', tabs: structuredClone(tabs), folders: [{ id: 'folder_user', kind: 'user' }, ...[...conversations.keys()].map(id => ({ id: 'folder_' + id, kind: 'task', taskId: id }))] }),
    async perform(args, context = {}) {
      if (args.action === 'tabs') return driver.status();
      calls.push({ args: structuredClone(args), owner: structuredClone(context.owner) });
      if (args.action === 'open') {
        const tabId = 'opened-' + calls.length;
        const tab = { tabId, url: args.url, documentId: tabId + ':1', folderId: 'folder_' + context.owner.taskId, owner: { ...context.owner }, contained: true };
        tabs.push(tab); return { ...tab };
      }
      return { tabId: args.tabId, documentId: tabs.find(tab => tab.tabId === args.tabId)?.documentId, frames: [], receipt: { action: args.action } };
    },
    async close() {},
  };
  const resolveBrowserConversationOwner = id => {
    if (!conversations.has(id)) throw Object.assign(Error('Conversation unavailable'), { code: 'BROWSER_CONVERSATION_NOT_FOUND', status: 404 });
    return owner(id);
  };
  const browser = new BrowserWorkspace({ driver });
  const api = new DirectExecutionAPI({ dataDir: directory, allowedRoot: directory, browser, resolveBrowserConversationOwner,
    getBrowserConversations: () => [...conversations.values()].map(item => ({ ...item, tabCount: tabs.filter(tab => tab.owner?.taskId === item.taskId).length })),
  });
  await api.init();
  t.after(async () => { await api.close(); await browser.close(); await rm(directory, { recursive: true, force: true }); });
  return { api, tabs, calls, conversations, resolveBrowserConversationOwner };
}

test('direct browser schemas carry an optional saved conversation scope through read, actions and uploads', async t => {
  const { api } = await fixture(t);
  for (const name of ['blackice_browser_read', 'blackice_browser_action', 'blackice_browser_upload']) {
    const schema = api.tools().find(item => item.name === name).inputSchema;
    assert.equal(schema.properties.conversationId.type, 'string');
    assert.ok(!schema.required.includes('conversationId'), 'existing callers remain usable');
    const args = name.endsWith('upload')
      ? { requestId: name, conversationId: 'a', tabId: 'personal', expectedUrl: 'https://personal.test/', expectedDocumentId: 'personal:1', paths: ['resume.pdf'], ref: 'upload' }
      : { requestId: name, conversationId: 'a', action: name.endsWith('read') ? 'tabs' : 'open', ...(name.endsWith('action') ? { url: 'https://a.test/' } : {}) };
    assert.equal(validDirectArguments(args, schema), true);
    assert.equal(validDirectArguments({ ...args, conversationId: '' }, schema), false);
  }
});

test('one connector keeps concurrent conversations separate and exposes an empty conversation in its catalog', async t => {
  const { api, tabs, calls } = await fixture(t);
  const initial = await settled(api, await api.call('blackice_browser_read', { requestId: 'catalog', action: 'tabs' }, client));
  assert.equal(initial.status, 'succeeded', JSON.stringify(initial));
  assert.deepEqual(parse(initial).conversations.map(item => [item.id, item.tabCount]), [['a', 0], ['b', 0]]);
  const opened = await Promise.all(['a', 'b'].map(async conversationId => settled(api, await api.call('blackice_browser_action', {
    requestId: 'open-' + conversationId, action: 'open', url: 'https://' + conversationId + '.test/', conversationId,
  }, client))));
  assert.ok(opened.every(job => job.status === 'succeeded'), JSON.stringify(opened));
  assert.equal(calls.length, 2);
  assert.deepEqual(new Set(calls.map(call => call.owner.conversationId)), new Set(['a', 'b']));
  assert.ok(calls.every(call => !Object.hasOwn(call.args, 'conversationId')), 'scope is host metadata, not a page-action field');
  for (const conversationId of ['a', 'b']) {
    const listed = await settled(api, await api.call('blackice_browser_read', { requestId: 'list-' + conversationId, action: 'tabs', conversationId }, client));
    assert.equal(listed.status, 'succeeded', JSON.stringify(listed));
    const result = parse(listed);
    assert.equal(result.tabs.length, 1);
    assert.equal(result.tabs[0].conversationId, conversationId);
    assert.equal(result.tabs[0].ownershipKind, 'ai');
    assert.equal(result.tabs[0].url, 'https://' + conversationId + '.test/');
    assert.deepEqual(result.browserScope, { kind: 'conversation', conversationId });
    assert.ok(!result.tabs.some(tab => tab.tabId === 'personal'));
  }
  assert.equal(tabs[0].owner, null, 'catalog access does not take ownership of Personal');
});

test('moving a tab changes which conversation can read it without changing its document identity', async t => {
  const { api, tabs, calls } = await fixture(t);
  tabs.push({ tabId: 'moving', url: 'https://moving.test/', documentId: 'moving:7', folderId: 'folder_a', owner: owner('a'), contained: true });
  const read = (scope, requestId) => api.call('blackice_browser_read', { requestId, action: 'snapshot', tabId: 'moving', conversationId: scope }, client);
  assert.equal((await settled(api, await read('a', 'a-before'))).status, 'succeeded');
  const tab = tabs.find(item => item.tabId === 'moving');
  tab.owner = owner('b'); tab.folderId = 'folder_b';
  const count = calls.length;
  await assert.rejects(read('a', 'a-after'), { code: 'BROWSER_TAB_OWNERSHIP' });
  assert.equal(calls.length, count);
  const after = await settled(api, await read('b', 'b-after'));
  assert.equal(after.status, 'succeeded', JSON.stringify(after));
  assert.equal(parse(after).documentId, 'moving:7');
  await assert.rejects(api.call('blackice_browser_read', { requestId: 'legacy-after', action: 'snapshot', tabId: 'moving' }, client), { code: 'BROWSER_TAB_OWNERSHIP' });
});

test('unavailable conversations reject new work while identical request recovery remains idempotent', async t => {
  const { api, conversations, calls } = await fixture(t);
  const args = { requestId: 'open-once', action: 'open', url: 'https://once.test/', conversationId: 'a' };
  const admitted = await api.call('blackice_browser_action', args, client);
  assert.equal((await settled(api, admitted)).status, 'succeeded');
  conversations.delete('a');
  const replay = await api.call('blackice_browser_action', args, client);
  assert.equal(replay.existing, true);
  assert.equal(replay.jobId, admitted.jobId);
  assert.equal(calls.length, 1);
  await assert.rejects(api.call('blackice_browser_action', { ...args, requestId: 'deleted-conversation' }, client), { code: 'BROWSER_CONVERSATION_NOT_FOUND' });
  assert.equal(calls.length, 1);
  await assert.rejects(api.call('blackice_browser_action', { ...args, conversationId: 'b' }, client), { code: 'DIRECT_REQUEST_CONFLICT' });
});

test('saved credentials use the same conversation owner without leaking scope into page inputs', async () => {
  const fills = [];
  const browser = { status: () => ({ contained: true, available: true, tabs: [] }), async fillCredential(args, context) { fills.push({ args, owner: context.owner }); await context.beforeDispatch(); return { filled: true }; } };
  const vault = { status: async () => ({ available: true, healthy: true }) };
  const entries = createDirectBrowserCredentialTools({ vault, browser, reauthorize: async () => true, resolveBrowserConversationOwner: id => owner(id) });
  const fill = entries.find(entry => entry.definition.name === 'blackice_credentials_fill');
  assert.ok(fill.definition.inputSchema.properties.conversationId);
  assert.equal(entries.find(entry => entry.definition.name === 'blackice_credentials_generate').definition.inputSchema.properties.conversationId, undefined);
  const result = await fill.execute({ requestId: 'credential_scope', conversationId: 'a', browser: 'relay', origin: 'https://login.test', credentialId: 'saved', revision: 1,
    tabId: 'login', expectedUrl: 'https://login.test/', expectedDocumentId: 'login:1', passwordRef: 'password',
  }, { client });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(fills.length, 1);
  assert.equal(fills[0].owner.conversationId, 'a');
  assert.equal(fills[0].owner.allowUserTabs, false);
  assert.equal(Object.hasOwn(fills[0].args, 'conversationId'), false);
});
