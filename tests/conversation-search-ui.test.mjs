import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationSearch, searchedSidebarConversations } from '../public/conversation-search.mjs';
import { renderSidebarGroups } from '../public/sidebar-model.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const chat = (id, text = 'A saved answer') => ({ id, rootId: id, runId: id + '-latest', latestRunId: id + '-latest', state: 'active', title: 'Saved chat ' + id, status: 'completed', settled: true, match: { kind: 'message', runId: id + '-earlier', messageId: 'answer-1', text } });
function fixture() {
  const calls = [], updates = [], scheduled = new Map(); let serial = 0;
  const search = createConversationSearch({ limit: 2, api(url, options) { const gate = deferred(); calls.push({ url, options, ...gate }); return gate.promise; },
    onChange: view => updates.push(view), schedule(fn) { const id = ++serial; scheduled.set(id, fn); return id; }, unschedule: id => scheduled.delete(id) });
  const response = (index, conversations, extra = {}) => { const call = calls[index], params = new URL(call.url, 'http://fixture').searchParams;
    call.resolve({ query: params.get('q'), state: params.get('state'), conversations, total: conversations.length, offset: Number(params.get('offset')), limit: 2, hasMore: false, truncated: false, ...extra }); };
  return { search, calls, updates, response, scheduled, flush() { for (const [id, fn] of scheduled) { scheduled.delete(id); fn(); } } };
}

test('rapid typing debounces requests; a superseded response cannot replace the newer query or scope', async () => {
  const f = fixture(); f.search.search('old'); f.search.search('answer'); assert.equal(f.scheduled.size, 1); f.flush(); assert.equal(f.calls.length, 1);
  const next = f.search.search('report', { scope: 'deleted', immediate: true }); assert.equal(f.calls[0].options.signal.aborted, true);
  f.response(1, [chat('trash', '<img src=x>')]); await next;
  f.response(0, [chat('old')]); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.search.get().query, 'report'); assert.equal(f.search.get().scope, 'deleted'); assert.equal(f.search.get().conversations[0].id, 'trash');
  assert.equal(f.search.get().conversations[0].match.text, '<img src=x>', 'the model retains data for the renderer to escape');
});

test('pagination retains earlier matches, rejects repeated activation, and retries only the failed page', async () => {
  const f = fixture(), first = f.search.search('saved', { immediate: true }); f.response(0, [chat('a'), chat('b')], { total: 5, hasMore: true }); await first;
  const more = f.search.more(); await f.search.more(); assert.equal(f.calls.length, 2);
  f.calls[1].reject(Error('Connection interrupted')); await more;
  assert.equal(f.search.get().status, 'error'); assert.deepEqual(f.search.get().conversations.map(item => item.id), ['a', 'b']);
  const retry = f.search.retry(); assert.equal(new URL(f.calls[2].url, 'http://fixture').searchParams.get('offset'), '2');
  f.response(2, [chat('b', 'Updated saved answer'), chat('c')], { total: 5, hasMore: true }); await retry;
  assert.deepEqual(f.search.get().conversations.map(item => item.id), ['a', 'b', 'c']); assert.equal(f.search.get().nextOffset, 4);
  const last = f.search.more(); f.response(3, [chat('d')], { total: 5 }); await last; assert.equal(f.search.get().hasMore, false);
});

async function loadTwoPages(f) {
  const first = f.search.search('saved', { immediate: true }); f.response(0, [chat('a'), chat('b')], { total: 6, hasMore: true }); await first;
  const more = f.search.more(); f.response(1, [chat('c'), chat('d')], { total: 6, hasMore: true }); await more;
  return f.search.get().conversations;
}

test('background refresh replaces the complete loaded extent atomically and continues pagination from that extent', async () => {
  const f = fixture(), before = await loadTwoPages(f), firstUpdate = f.updates.length;
  const refresh = f.search.refresh(); assert.equal(f.search.get().conversations, before);
  f.response(2, [chat('a', 'Refreshed A'), chat('b', 'Refreshed B')], { total: 6, hasMore: true, truncated: true }); await turn();
  assert.equal(f.calls.length, 4, 'refresh requests the second already-loaded page');
  assert.equal(new URL(f.calls[3].url, 'http://fixture').searchParams.get('offset'), '2');
  assert.equal(f.search.get().conversations, before, 'no partial replacement can remove the focused fourth result');
  assert.equal(f.updates.slice(firstUpdate).every(view => view.conversations === before), true);
  f.response(3, [chat('c', 'Refreshed C'), chat('d', 'Refreshed D')], { total: 6, hasMore: true }); assert.equal(await refresh, true);
  assert.deepEqual(f.search.get().conversations.map(item => item.id), ['a', 'b', 'c', 'd']);
  assert.equal(f.search.get().conversations[3].match.text, 'Refreshed D'); assert.equal(f.search.get().nextOffset, 4); assert.equal(f.search.get().truncated, true);
  assert.equal(f.updates.slice(firstUpdate).filter(view => view.status === 'ready').length, 1);
  const more = f.search.more(); assert.equal(new URL(f.calls[4].url, 'http://fixture').searchParams.get('offset'), '4');
  f.response(4, [chat('e'), chat('f')], { total: 6 }); await more;
  assert.deepEqual(f.search.get().conversations.map(item => item.id), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('refreshes queued during load-more coalesce and include the newly loaded page', async () => {
  const f = fixture(), first = f.search.search('saved', { immediate: true }); f.response(0, [chat('a'), chat('b')], { total: 6, hasMore: true }); await first;
  const more = f.search.more(); await Promise.all([f.search.refresh(), f.search.refresh(), f.search.refresh()]); assert.equal(f.calls.length, 2);
  f.response(1, [chat('c'), chat('d')], { total: 6, hasMore: true }); await more;
  const loaded = f.search.get().conversations; assert.deepEqual(loaded.map(item => item.id), ['a', 'b', 'c', 'd']); assert.equal(f.calls.length, 3);
  f.response(2, [chat('a', 'Updated A'), chat('b')], { total: 6, hasMore: true }); await turn();
  assert.equal(f.calls.length, 4); assert.equal(f.search.get().conversations, loaded);
  f.response(3, [chat('c'), chat('d', 'Updated D')], { total: 6, hasMore: true }); await turn();
  assert.equal(f.search.get().status, 'ready'); assert.equal(f.search.get().nextOffset, 4); assert.equal(f.search.get().conversations[3].match.text, 'Updated D');
  assert.equal(f.calls.length, 4, 'three catalog events produce one full refresh');
});

test('a failed later refresh page retains the whole previous result set and Retry refetches the original extent', async () => {
  const f = fixture(), before = await loadTwoPages(f), original = f.search.get();
  const refresh = f.search.refresh(); f.response(2, [chat('new'), chat('a', 'Intermediate A')], { total: 7, hasMore: true }); await turn();
  assert.equal(f.calls.length, 4); f.calls[3].reject(Error('Second page unavailable')); assert.equal(await refresh, false);
  assert.equal(f.search.get().status, 'error'); assert.equal(f.search.get().conversations, before); assert.equal(f.search.get().total, original.total); assert.equal(f.search.get().nextOffset, 4);
  const retry = f.search.retry(); await f.search.retry(); await f.search.more(); assert.equal(f.calls.length, 5);
  assert.equal(new URL(f.calls[4].url, 'http://fixture').searchParams.get('offset'), '0', 'Retry must rebuild the whole refresh, not append its failed page');
  f.response(4, [chat('new'), chat('a', 'Final A')], { total: 7, hasMore: true }); await turn();
  assert.equal(f.search.get().conversations, before); assert.equal(f.calls.length, 6);
  f.response(5, [chat('b'), chat('c')], { total: 7, hasMore: true }); assert.equal(await retry, true);
  assert.deepEqual(f.search.get().conversations.map(item => item.id), ['new', 'a', 'b', 'c']); assert.equal(f.search.get().total, 7); assert.equal(f.search.get().nextOffset, 4);
});

test('refresh uses consumed page offsets after deduplication and stops when the current result set has shrunk', async () => {
  const f = fixture(), first = f.search.search('saved', { immediate: true }); f.response(0, [chat('a'), chat('b')], { total: 5, hasMore: true }); await first;
  const more = f.search.more(); f.response(1, [chat('b'), chat('c')], { total: 5, hasMore: true }); await more; assert.equal(f.search.get().conversations.length, 3);
  const refresh = f.search.refresh(); f.response(2, [chat('a'), chat('b')], { total: 3, hasMore: true }); await turn(); assert.equal(f.calls.length, 4);
  f.response(3, [chat('c')], { total: 3 }); await refresh;
  assert.equal(f.search.get().nextOffset, 3); assert.equal(f.search.get().hasMore, false); assert.deepEqual(f.search.get().conversations.map(item => item.id), ['a', 'b', 'c']);
  const shrink = f.search.refresh(); f.response(4, [chat('c')], { total: 1 }); await shrink;
  assert.deepEqual(f.search.get().conversations.map(item => item.id), ['c']); assert.equal(f.search.get().nextOffset, 1); assert.equal(f.calls.length, 5, 'a final short page does not request nonexistent old offsets');
});

test('newer queries cancel a multi-page refresh before any staged or late page can replace the new results', async () => {
  const f = fixture(); await loadTwoPages(f); const more = f.search.more(); f.response(2, [chat('e'), chat('f')], { total: 6 }); await more;
  const refresh = f.search.refresh(); f.response(3, [chat('a', 'Obsolete A'), chat('b')], { total: 6, hasMore: true }); await turn();
  assert.equal(f.calls.length, 5);
  const newer = f.search.search('another', { scope: 'archived', immediate: true }); assert.equal(f.calls[4].options.signal.aborted, true);
  f.response(4, [chat('c'), chat('d')], { total: 6, hasMore: true }); assert.equal(await refresh, false);
  f.response(5, [chat('new-scope')]); await newer;
  assert.equal(f.calls.length, 6, 'an abandoned refresh does not request its third page'); assert.equal(f.search.get().query, 'another'); assert.equal(f.search.get().scope, 'archived');
  assert.deepEqual(f.search.get().conversations.map(item => item.id), ['new-scope']);
});

test('clearing and destroying a surface cancel both delayed work and late successful or failed reads', async () => {
  const f = fixture(), reading = f.search.search('private phrase', { immediate: true }); f.search.cancel(); const count = f.updates.length;
  f.calls[0].reject(Error('A stale error')); await reading; assert.equal(f.updates.length, count); assert.equal(f.search.get().status, 'idle');
  f.search.search('pending'); f.search.destroy(); f.flush(); assert.equal(f.calls.length, 1);
  const g = fixture(), pending = g.search.search('read', { immediate: true }); g.search.destroy(); const after = g.updates.length; g.response(0, [chat('late')]); await pending;
  assert.equal(g.updates.length, after); assert.equal(g.calls[0].options.signal.aborted, true);
});

test('an invalid result stays recoverable and a refresh reports incomplete archive evidence', async () => {
  const f = fixture(), first = f.search.search('answer', { immediate: true }); f.calls[0].resolve({ conversations: [] }); await first;
  assert.equal(f.search.get().status, 'error'); assert.match(f.search.get().error, /unreadable/);
  const retry = f.search.retry(); f.response(1, [chat('answer')], { truncated: true }); await retry;
  assert.equal(f.search.get().truncated, true); const refresh = f.search.refresh(); assert.equal(f.search.get().conversations.length, 1);
  f.response(2, []); await refresh; assert.equal(f.search.get().status, 'ready'); assert.equal(f.search.get().conversations.length, 0);
});

test('ranked content matches keep their matching turn while current catalog state controls attention and Trash', () => {
  const items = [chat('a'), chat('b'), chat('c')], catalog = [{ id: 'a', state: 'active', runId: 'a-live', status: 'cancelled', settled: false }, { id: 'b', state: 'deleted' }, { id: 'c', state: 'archived' }];
  const found = searchedSidebarConversations(items, catalog, { isUnread: id => id === 'c' }); assert.deepEqual(found.map(item => item.id), ['a', 'c']);
  assert.equal(found[0].runId, 'a-live'); assert.equal(found[0].match.runId, 'a-earlier'); assert.equal(found[1].unread, true);
  assert.deepEqual(searchedSidebarConversations(items, catalog, { historyState: 'working' }).map(item => item.id), ['a']);
  assert.deepEqual(searchedSidebarConversations(items, catalog, { historyState: 'deleted' }).map(item => item.id), ['b']);
});


test('search rows escape saved content and keep navigation metadata separate from the context-menu target', () => {
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const item = { ...chat('safe'), match: { kind: 'file', runId: 'earlier', text: '<img src=x onerror=alert(1)> report.pdf' } };
  const html = renderSidebarGroups([{ label: 'Search results', items: [item] }], { escape });
  assert.ok(html.includes('data-search-run-id="earlier"')); assert.ok(html.includes('data-id="safe-latest"'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;')); assert.ok(!html.includes('<img'));
  assert.ok(html.includes('conversation-sidebar-preview')); assert.ok(html.includes('More actions for Saved chat safe'));
});
