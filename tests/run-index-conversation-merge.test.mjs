import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeConversationRuns, assistantMessages } from '../public/conversation-model.mjs';
import { projectRunIndex } from '../public/run-index-model.mjs';

test('a compact worker catalog never replaces or reprocesses the loaded transcript', () => {
  const event = index => ({ at: new Date(Date.parse('2026-10-24T10:00:00Z') + index).toISOString(),
    nodeId: 'assistant', data: { type: 'message', itemId: 'm' + index, text: 'Message ' + index } });
  const original = {
    id: 'run-id', taskId: 'run-id', input: 'Read my messages',
    workflow: { nodes: [{ id: 'assistant', type: 'agent' }] },
    nodes: { assistant: { status: 'completed' } }, events: Array.from({ length: 2500 }, (_, i) => event(i)),
  };
  const index = projectRunIndex({ ...original, updatedAt: '2026-10-24T10:00:25Z' });
  assert.equal(index.events.length, 0);
  const merged = mergeConversationRuns([original], [index]);
  assert.equal(merged[0].events, original.events, 'A missing index trace must reuse the full saved message list.');
  assert.equal(assistantMessages(merged[0]).length, 2500);
  const subsequent = mergeConversationRuns([original], [index]);
  assert.equal(subsequent[0].events, original.events, 'Repeated rendering must not merge or sort the old event log.');
});

test('new actual live receipts still merge with loaded archived messages', () => {
  const saved = { id: 'r', events: [{ at: '2026-10-24T10:00:00Z', data: { type: 'message', itemId: 'old', text: 'Before' } }] };
  const incoming = { ...projectRunIndex(saved), events: [{ at: '2026-10-24T10:00:01Z',
    data: { type: 'message', itemId: 'new', text: 'After' } }] };
  const result = mergeConversationRuns([saved], [incoming]);
  assert.equal(result[0].events.length, 2);
});
