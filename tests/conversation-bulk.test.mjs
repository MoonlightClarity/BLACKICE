import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBulkConversations } from '../public/conversation-bulk-model.mjs';
import { renderSidebarGroups } from '../public/sidebar-model.mjs';

const entry = (id, state = 'active', working = false) => ({ id, runId: 'run-' + id, title: 'Chat ' + id, state, working, settled: !working, status: working ? 'running' : 'completed' });
const selected = (...entries) => new Map(entries.map(({ id, runId, state }) => [id, { runId, state }]));
const resolve = (...entries) => {
  const byId = new Map(entries.map(item => [item.id, item]));
  return id => byId.get(id);
};

test('bulk archive and restore use the originally observed exact conversation identity', () => {
  const a = entry('a'), b = entry('b');
  assert.deepEqual(resolveBulkConversations(selected(a, b), resolve(a, b), 'archive'), [a, b]);
  const archive = entry('archived', 'archived'), deleted = entry('trashed', 'deleted');
  assert.deepEqual(resolveBulkConversations(selected(archive, deleted), resolve(archive, deleted), 'restore'), [archive, deleted]);
});

test('bulk action rejects stale run identities or state before changing any conversations', () => {
  const a = entry('a'), snapshot = selected(a);
  assert.throws(() => resolveBulkConversations(snapshot, resolve({ ...a, runId: 'new-run-a' }), 'delete'), /changed/);
  assert.throws(() => resolveBulkConversations(snapshot, resolve({ ...a, state: 'archived' }), 'archive'), /changed/);
  assert.throws(() => resolveBulkConversations(snapshot, resolve(), 'archive'), /changed/);
});

test('working chats may be archived but cannot be moved to Trash', () => {
  const active = entry('active', 'active', true), paused = entry('archived', 'archived');
  assert.deepEqual(resolveBulkConversations(selected(active), resolve(active), 'archive'), [active]);
  assert.throws(() => resolveBulkConversations(selected(active, paused), resolve(active, paused), 'delete'), /Stop working conversations/);
  assert.deepEqual(resolveBulkConversations(selected(paused), resolve(paused), 'delete'), [paused]);
});

test('invalid bulk action and ineligible states fail closed', () => {
  const active = entry('a'), archived = entry('b', 'archived'), trashed = entry('c', 'deleted');
  assert.throws(() => resolveBulkConversations(new Map(), resolve(active), 'delete'), /Select at least one/);
  assert.throws(() => resolveBulkConversations(selected(active), resolve(active), 'purge'), /supported/);
  assert.throws(() => resolveBulkConversations(selected(active, archived), resolve(active, archived), 'archive'), /Only active/);
  assert.throws(() => resolveBulkConversations(selected(active), resolve(active), 'restore'), /Only archived or trashed/);
  assert.throws(() => resolveBulkConversations(selected(trashed), resolve(trashed), 'delete'), /already in Trash/);
});

test('bulk list render exposes checkboxes while suppressing normal menu actions', () => {
  const a = entry('a'), b = entry('b');
  const groups = [{ label: 'Today', items: [a, b] }], escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;');
  const old = renderSidebarGroups(groups, { selectedId: a.id, escape });
  assert.match(old, /data-mission-action="open-run"/);
  assert.match(old, /data-chat-more="true"/);
  assert.doesNotMatch(old, /data-bulk-id/);
  const markup = renderSidebarGroups(groups, { selectedId: a.id, escape, bulkSelecting: true, bulkSelected: new Set([b.id]) });
  assert.match(markup, /data-mission-action="bulk-toggle"/);
  assert.match(markup, /data-bulk-id="b" aria-label="Select Chat b" checked/);
  assert.match(markup, /data-bulk-id="a" aria-label="Select Chat a"/);
  assert.doesNotMatch(markup, /data-chat-more="true"/);
  assert.match(markup, /aria-pressed="true"/);
  assert.match(markup, /aria-current="page"/);
});
