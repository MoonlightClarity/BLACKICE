import test from 'node:test';
import assert from 'node:assert/strict';
import { sidebarConversations, sidebarGroups, sidebarStatus, renderSidebarGroups } from '../public/sidebar-model.mjs';

const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const entry = (id, updatedAt, extras = {}) => ({ id, taskId: id, runId: id, title: `Chat ${id}`, updatedAt, status: 'completed', ...extras });

test('date groups use local calendar days across a daylight-saving weekend, not elapsed 24-hour buckets', () => {
  const now = new Date(2026, 10, 2, 0, 15);
  const items = [entry('today', new Date(2026, 10, 2, 0, 1).toISOString()), entry('yesterday', new Date(2026, 10, 1, 0, 1).toISOString()), entry('week', new Date(2026, 9, 29, 23).toISOString()), entry('older', new Date(2026, 9, 1).toISOString()), entry('unknown', '')];
  assert.deepEqual(sidebarGroups(items, now).map(group => [group.label, group.items.map(item => item.id)]), [['Today', ['today']], ['Yesterday', ['yesterday']], ['Previous 7 days', ['week']], ['Older', ['older', 'unknown']]]);
});

test('actual latest update timestamps determine chat order and groups even when the loaded turn was created earlier', () => {
  const summaries = { active: [entry('older-turn', '2026-10-16T16:00:00Z'), entry('newer-turn', '2026-10-15T12:00:00Z')] };
  const runs = [{ id: 'older-turn', taskId: 'older-turn', createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-16T17:00:00Z', status: 'completed', input: 'First' }, { id: 'newer-turn', taskId: 'newer-turn', createdAt: '2026-10-15T12:00:00Z', updatedAt: '2026-10-15T12:00:00Z', status: 'completed', input: 'Second' }];
  const items = sidebarConversations({ summaries, runs });
  assert.deepEqual(items.map(item => item.id), ['older-turn', 'newer-turn']); assert.equal(items[0].updatedAt, '2026-10-16T17:00:00.000Z');
  runs[0].updatedAt = '2026-10-01T12:00:00Z'; assert.equal(sidebarConversations({ summaries, runs })[0].updatedAt, '2026-10-16T16:00:00.000Z', 'durable metadata wins over an older loaded run');
});

test('ordinary history has no 200-chat display cap, and title search reaches saved archived chats without exposing Trash', () => {
  const active = Array.from({ length: 431 }, (_, index) => entry(`chat-${index}`, new Date(2026, 9, 16, 9, index).toISOString()));
  const summaries = { active, archived: [entry('archived-match', '2026-10-01T00:00:00Z', { title: 'Café research', preview: 'Résumé for the designer' })], deleted: [entry('trash-match', '2026-10-16T00:00:00Z', { title: 'Café research' })] };
  assert.equal(sidebarConversations({ summaries }).length, 431);
  const found = sidebarConversations({ summaries, query: 'cafe designer' }); assert.deepEqual(found.map(item => [item.id, item.state]), [['archived-match', 'archived']]);
  assert.deepEqual(sidebarConversations({ summaries, historyState: 'deleted', query: 'cafe' }).map(item => item.id), ['trash-match']);
});

test('a working filter includes only actual queued, running or waiting chats', () => {
  const summaries = { active: ['queued', 'running', 'waiting', 'failed', 'completed', 'cancelled'].map(status => entry(status, '2026-10-16T00:00:00Z', { status })) };
  assert.deepEqual(sidebarConversations({ summaries, historyState: 'working' }).map(item => item.status).sort(), ['queued', 'running', 'waiting']);
  assert.deepEqual(['queued', 'running', 'waiting', 'failed', 'cancelled', 'completed'].map(status => sidebarStatus({ status, settled: true })?.label || ''), ['Queued', 'Working', 'Waiting', 'Needs attention', 'Stopped', '']);
});

test('a cancelled chat remains discoverable as Stopping until actual settlement reaches the catalog', () => {
  const run = { id: 'stopping', taskId: 'stopping', status: 'cancelled', settled: false, createdAt: '2026-10-19T10:00:00Z', input: 'Keep this task visible' };
  const summaries = { active: [entry('stopping', run.createdAt, { status: 'cancelled', settled: true })] };
  const working = () => sidebarConversations({ summaries, runs: [run], historyState: 'working' });
  assert.equal(working().length, 1); assert.equal(working()[0].settled, false, 'the current run overrides an older summary settlement');
  assert.deepEqual(sidebarStatus(working()[0]), { label: 'Stopping…', kind: 'working' });
  assert.doesNotMatch(renderSidebarGroups(sidebarGroups(working()), { escape }), />Stopped</);
  run.settled = true;
  assert.equal(working().length, 0); assert.equal(sidebarStatus(sidebarConversations({ summaries, runs: [run] })[0]).label, 'Stopped');
  assert.equal(sidebarStatus({ status: 'cancelled' }).label, 'Stop requested', 'missing settlement is not confirmation that work has stopped');
});

test('failed and completed chats remain in the working filter while their remaining work is finishing', () => {
  const summaries = { active: ['failed', 'completed'].map(status => entry(status, '', { status, settled: false })) };
  const items = sidebarConversations({ summaries, historyState: 'working' });
  assert.equal(items.length, 2); assert.ok(items.every(item => sidebarStatus(item).label === 'Finishing…'));
  for (const item of summaries.active) item.settled = true;
  assert.equal(sidebarConversations({ summaries, historyState: 'working' }).length, 0);
});

test('rendered actions are sibling buttons with captured chat targets and clear archived labels, with untrusted titles escaped', () => {
  const html = renderSidebarGroups([{ label: 'Today', items: [entry('first', '', { title: '<script> "A"', state: 'archived', status: 'failed' }), entry('second', '', { title: 'A working chat', status: 'running' })] }], { selectedId: 'second', escape });
  assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt; &quot;A&quot;/); assert.match(html, /conversation-sidebar-archived">Archived/); assert.match(html, /Needs attention/); assert.match(html, /aria-label="More actions for &lt;script&gt; &quot;A&quot;"/);
  assert.equal([...html.matchAll(/data-conversation-id="first"/g)].length, 2); assert.equal([...html.matchAll(/aria-current="page"/g)].length, 1);
  const buttonDepths = []; let depth = 0;
  for (const token of html.matchAll(/<\/?button\b[^>]*>/g)) { depth += token[0].startsWith('</') ? -1 : 1; buttonDepths.push(depth); }
  assert.equal(Math.max(...buttonDepths), 1, 'More must never be nested inside the chat button'); assert.equal(depth, 0);
});

test('Unread includes archived responses, excludes Trash and keeps success, failure and stopped updates readable without adding a second text row', () => {
  const summaries = { active: [entry('done', '', { status: 'completed' }), entry('error', '', { status: 'failed' }), entry('stopped', '', { status: 'cancelled', settled: true }), entry('read', '')], archived: [entry('archived', '')], deleted: [entry('trash', '')] };
  const items = sidebarConversations({ summaries, historyState: 'unread', isUnread: id => id !== 'read' });
  assert.deepEqual(items.map(item => item.id).sort(), ['archived', 'done', 'error', 'stopped']);
  const html = renderSidebarGroups(sidebarGroups(items), { escape });
  assert.match(html, /Chat done · New response/); assert.match(html, /Chat error · Unseen error/); assert.match(html, /Chat stopped · Unseen stopped response/);
  assert.equal([...html.matchAll(/class="conversation-unread-mark"/g)].length, 4); assert.match(html, /Needs attention/); assert.match(html, />Stopped</);
});
