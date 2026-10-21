import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationAttention, atConversationEnd, captureConversationScroll, restoreConversationScroll } from '../public/conversation-attention.mjs';

const now = Date.parse('2026-10-17T12:00:00Z');
const chat = (id, status = 'completed', extras = {}) => ({ id, runId: id, status, createdAt: '2026-10-16T12:00:00Z', ...extras });
function disk() { const values = new Map(); return { values, get length() { return values.size; }, key: index => [...values.keys()][index], getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; }

test('first use baselines old history, and later metadata or transcript loading cannot create false unread replies', () => {
  const tracker = createConversationAttention({ storage: disk(), now });
  tracker.observe([chat('old')]); assert.equal(tracker.unread('old'), false);
  tracker.observe([chat('old', 'completed', { updatedAt: '2026-10-18T12:00:00Z' })]); assert.equal(tracker.unread('old'), false);
  tracker.observe([chat('late-old-history')]); assert.equal(tracker.unread('late-old-history'), false);
});

test('a known running response is unread only after it settles, and new turns need their own read receipt', () => {
  const tracker = createConversationAttention({ storage: disk(), now });
  tracker.observe([chat('chat', 'running')]); assert.equal(tracker.unread('chat'), false);
  tracker.observe([chat('chat', 'completed', { settled: false })]); assert.equal(tracker.unread('chat'), false);
  tracker.observe([chat('chat', 'completed', { settled: true })]); assert.equal(tracker.unread('chat'), true);
  assert.equal(tracker.markSeen(chat('chat')), true); assert.equal(tracker.unread('chat'), false);
  tracker.observe([chat('chat', 'running', { runId: 'reply-2', createdAt: '2026-10-17T13:00:00Z' })]);
  tracker.observe([chat('chat', 'completed', { runId: 'reply-2', createdAt: '2026-10-17T13:00:00Z' })]); assert.equal(tracker.unread('chat'), true);
  assert.equal(tracker.markSeen(chat('chat')), false, 'a receipt for an older response cannot read a newer response');
});

test('completion during a restart and unhydrated summary-only responses retain unread state across windows', () => {
  const storage = disk(), first = createConversationAttention({ storage, now });
  first.observe([chat('running-before-restart', 'running')]);
  const second = createConversationAttention({ storage, now: now + 1000 });
  second.observe([chat('running-before-restart')]); assert.equal(second.unread('running-before-restart'), true);
  second.observe([chat('catalog-only', 'completed', { createdAt: '2026-10-17T13:00:00Z' })]); assert.equal(second.unread('catalog-only'), true);
  const third = createConversationAttention({ storage, now: now + 2000 }); assert.equal(third.unread('catalog-only'), true);
  third.markSeen(chat('catalog-only')); second.refresh(); assert.equal(second.unread('catalog-only'), false);
});

test('recent run eviction does not forget unread receipts, and pruning uses only an explicitly complete catalog', () => {
  const storage = disk(), tracker = createConversationAttention({ storage, now });
  tracker.observe([chat('chat', 'running')]); tracker.observe([chat('chat')]); tracker.observe([]); assert.equal(tracker.unread('chat'), true);
  tracker.observe([], { catalogIds: ['chat'] }); assert.equal(tracker.unread('chat'), true);
  tracker.observe([], { catalogIds: [] }); assert.equal(tracker.unread('chat'), false);
  tracker.observe([chat('chat')]); assert.equal(tracker.unread('chat'), false, 'old history loading again uses the original first-use baseline');
});

test('an unrelated window overwriting an older catalog snapshot cannot undo an individual read receipt', () => {
  const storage = disk(), tracker = createConversationAttention({ storage, now });
  tracker.observe([chat('chat', 'running')]); tracker.observe([chat('chat')]);
  const staleLedger = storage.getItem('relay.conversation.attention.v1'); tracker.markSeen(chat('chat'));
  storage.setItem('relay.conversation.attention.v1', staleLedger);
  const restored = createConversationAttention({ storage, now: now + 1000 }); assert.equal(restored.unread('chat'), false);
  restored.observe([], { catalogIds: [] }); assert.equal([...storage.values.keys()].some(key => key.includes(':seen:')), false, 'complete catalog pruning also retires response receipts');
});

test('unchanged streaming snapshots do not rewrite the catalog on every update', () => {
  const storage = disk(), write = storage.setItem; let writes = 0; storage.setItem = (key, value) => { writes++; write(key, value); };
  const tracker = createConversationAttention({ storage, now }); tracker.observe([chat('chat', 'running')]); const initial = writes;
  for (let index = 0; index < 200; index++) tracker.observe([chat('chat', 'running', { updatedAt: new Date(now + index).toISOString() })]);
  assert.equal(writes, initial);
});

test('failed and stopped turns have independent terminal receipts, while streaming and older snapshots cannot undo them', () => {
  const tracker = createConversationAttention({ storage: disk(), now });
  for (const status of ['failed', 'cancelled']) {
    const id = status; tracker.observe([chat(id, 'running')]); tracker.observe([chat(id, status)]); assert.equal(tracker.unread(id), true);
    tracker.markSeen(chat(id, status)); assert.equal(tracker.unread(id), false);
    tracker.observe([chat(id, 'running', { createdAt: '2026-10-15T12:00:00Z' })]); assert.equal(tracker.unread(id), false);
  }
});

test('a failed write retains attention in this window without storing chat contents', () => {
  const storage = disk(), tracker = createConversationAttention({ storage, now });
  tracker.observe([chat('chat', 'running')]); storage.setItem = () => { throw new Error('disk full'); };
  tracker.observe([chat('chat', 'completed', { title: 'PRIVATE CHAT TEXT', input: 'PRIVATE USER MESSAGE' })]); assert.equal(tracker.unread('chat'), true);
  tracker.observe([]); assert.equal(tracker.unread('chat'), true); tracker.markSeen(chat('chat')); assert.equal(tracker.unread('chat'), false);
  assert.doesNotMatch([...storage.values.values()].join(''), /PRIVATE/);
});

test('attention storage scales with the catalog rather than an arbitrary chat count', () => {
  const tracker = createConversationAttention({ storage: disk(), now });
  const running = Array.from({ length: 1201 }, (_, index) => chat(`chat-${index}`, 'running'));
  tracker.observe(running); tracker.observe(running.map(item => ({ ...item, status: 'completed' })), { catalogIds: running.map(item => item.id) });
  assert.equal(running.filter(item => tracker.unread(item.id)).length, 1201);
});

test('scroll anchors retain the visible message as earlier history grows and prefer it over its containing turn', () => {
  const view = { scrollTop: 400, scrollHeight: 2000, clientHeight: 500, getBoundingClientRect: () => ({ top: 100, bottom: 600 }) };
  let messageTop = 80;
  const message = { dataset: { messageId: 'visible-message' }, getBoundingClientRect: () => ({ top: messageTop, bottom: messageTop + 500 }) };
  const turn = { dataset: { runId: 'long-turn' }, getBoundingClientRect: () => ({ top: -200, bottom: 900 }) };
  const timeline = { querySelectorAll: selector => selector === '[data-message-id]' ? [message] : selector === '[data-run-id]' ? [turn] : [turn, message] };
  const saved = captureConversationScroll(view, timeline, false); assert.equal(saved.messageId, 'visible-message'); assert.equal(saved.offset, -20);
  messageTop += 320; assert.equal(restoreConversationScroll(view, timeline, saved), false); assert.equal(view.scrollTop, 720);
  const noAnchor = { querySelectorAll: () => [] }; view.scrollTop = 0; restoreConversationScroll(view, noAnchor, saved); assert.equal(view.scrollTop, 400);
  restoreConversationScroll(view, timeline, { following: true }); assert.equal(view.scrollTop, 2000); assert.equal(atConversationEnd(view), true);
  view.scrollTop = 1300; assert.equal(atConversationEnd(view), false); view.scrollTop = 1498; assert.equal(atConversationEnd(view), true);
});
