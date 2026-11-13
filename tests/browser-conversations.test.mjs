import test from 'node:test';
import assert from 'node:assert/strict';
import { browserConversationStatus, browserConversationTransfer, resolveBrowserConversationOwner, sameBrowserOwner } from '../lib/browser-conversations.mjs';
import { agentBrowserRequest, browserOwner } from '../lib/browser.mjs';
import { ownershipChange } from '../lib/browser-ownership.mjs';

const conversations = [
  { rootId: 'alpha', title: 'First conversation', latestRunId: 'alpha-new', state: 'active' },
  { rootId: 'beta', title: 'Archived conversation', latestRunId: 'beta-last', state: 'archived' },
  { rootId: 'deleted', title: 'Trash', latestRunId: 'deleted-last', state: 'deleted' }
];
const alpha = resolveBrowserConversationOwner('alpha', conversations);
const beta = resolveBrowserConversationOwner('beta', conversations);
const page = { tabId: 'page', url: 'https://example.test/form', documentId: 'page:1', folderId: 'folder_user' };
const guarded = { tabId: page.tabId, expectedUrl: page.url, expectedDocumentId: page.documentId };

test('conversation destinations include empty and archived conversations, never Trash', () => {
  assert.equal(alpha.taskId, 'alpha');
  assert.equal(alpha.nodeId, 'conversation');
  assert.equal(beta.taskId, 'beta');
  assert.deepEqual(browserOwner(alpha), alpha);
  assert.equal(browserOwner(resolveBrowserConversationOwner('alpha', [{ ...conversations[0], title: 'Two\nlines' }])).label, 'Two lines');
  assert.throws(() => resolveBrowserConversationOwner('deleted', conversations), { code: 'BROWSER_CONVERSATION_NOT_FOUND' });
  assert.throws(() => resolveBrowserConversationOwner('missing', conversations), { code: 'BROWSER_CONVERSATION_NOT_FOUND' });
  const request = browserConversationTransfer({ ...guarded, destination: 'conversation', conversationId: 'beta' }, conversations);
  assert.deepEqual(request.destinationOwner, beta);
  assert.equal(request.args.includeChildren, true);
  assert.throws(() => browserConversationTransfer({ ...guarded, destination: 'user', conversationId: 'alpha' }, conversations));
});

test('catalog separates personal, native-conversation and unassigned connector tabs without guessed attribution', () => {
  const archive = { list: () => conversations, entries: new Map([['old-turn', { root: 'alpha' }]]), rootIdFor: entry => entry.root };
  const input = { tabs: [
    page,
    { ...page, tabId: 'native', owner: { taskId: 'alpha', runId: 'alpha-old', nodeId: 'agent' } },
    { ...page, tabId: 'legacy-native', owner: { taskId: 'old-turn', runId: 'old-turn', nodeId: 'agent' } },
    { ...page, tabId: 'connection', owner: { taskId: 'chatgpt_connection', runId: 'chatgpt_connection', nodeId: 'bridge' } }
  ], folders: [{ id: 'folder_user', kind: 'user' }, { id: 'alpha_folder', kind: 'task', taskId: 'alpha' }] };
  const result = browserConversationStatus(input, archive);
  assert.deepEqual(result.conversations.map(item => [item.id, item.tabCount]), [['alpha', 2], ['beta', 0]]);
  assert.equal(result.tabs[0].ownershipKind, 'user');
  assert.equal(result.tabs[0].conversationId, null);
  assert.equal(result.tabs[1].conversationTitle, 'First conversation');
  assert.equal(result.tabs[2].conversationId, 'alpha');
  assert.equal(result.tabs[3].ownershipKind, 'ai');
  assert.equal(result.tabs[3].conversationId, null);
  assert.equal(result.folders[1].conversationId, 'alpha');
  assert.equal(input.tabs[0].ownershipKind, undefined, 'metadata decoration must not mutate driver state');
});

test('a transferred conversation page belongs to later workers and excludes the previous conversation', () => {
  const worker = { taskId: 'alpha', runId: 'future-turn', nodeId: 'agent' };
  const otherWorker = { taskId: 'alpha', runId: 'future-turn', nodeId: 'different-worker' };
  assert.equal(sameBrowserOwner(alpha, worker), true);
  assert.equal(sameBrowserOwner(worker, otherWorker), false);
  assert.equal(sameBrowserOwner(alpha, beta), false);
  const status = { tabs: [{ ...page, owner: alpha }], ownerActiveTabs: { ['alpha\0conversation']: page.tabId } };
  assert.equal(agentBrowserRequest({ action: 'read' }, status, worker).tabId, page.tabId);
  assert.throws(() => agentBrowserRequest({ action: 'read', tabId: page.tabId }, status, beta), { code: 'BROWSER_TAB_OWNERSHIP' });
  assert.throws(() => agentBrowserRequest({ action: 'read', tabId: page.tabId }, { tabs: [page] }, alpha), { code: 'BROWSER_TAB_OWNERSHIP' });
});

test('the empty-conversation transfer requires resolved destination and exact observed page identity', () => {
  const { args, destinationOwner } = browserConversationTransfer({ ...guarded, destination: 'conversation', conversationId: 'alpha' }, conversations);
  const status = { tabs: [page], folders: [] };
  assert.deepEqual(ownershipChange(args, status, null, 'user', destinationOwner).owner, alpha);
  assert.throws(() => ownershipChange(args, status, null, 'user'), { code: 'BROWSER_DESTINATION_CHANGED' });
  assert.throws(() => ownershipChange({ ...args, expectedDocumentId: 'page:stale' }, status, null, 'user', alpha), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
  assert.throws(() => ownershipChange(args, status, beta, 'agent', alpha), { code: 'BROWSER_OWNERSHIP_VALIDATION' });
  const toUser = browserConversationTransfer({ ...guarded, destination: 'user' }, conversations);
  assert.equal(ownershipChange(toUser.args, { tabs: [{ ...page, owner: alpha }] }, null, 'user').owner, null);
});
