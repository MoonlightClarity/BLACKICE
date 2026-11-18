import test from 'node:test';
import assert from 'node:assert/strict';
import { planningConversationId, planningConversationRunId, planningConversationActivity,
  planningCurrentConversations } from '../public/next/workspaces/planning-current-model.mjs';

const conversation = { id: 'run-latest', rootId: 'conversation-root', taskId: 'conversation-root', runId: 'run-latest',
  latestRunId: 'run-latest', title: 'Current work', state: 'active', status: 'completed', settled: true,
  goal: { status: 'completed', currentRunId: 'run-latest', running: false, runStatus: null, turns: 3 } };

test('modern conversations are visible without any graph request and preserve root versus latest-run identity', () => {
  const rows = planningCurrentConversations({ conversations: [conversation] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'conversation-root');
  assert.equal(rows[0].runId, 'run-latest');
  assert.equal(planningConversationId(conversation), 'conversation-root');
  assert.equal(planningConversationRunId(conversation), 'run-latest');
  assert.equal(rows[0].activity.label, 'Finished');
});

test('only observed executing work is Running; saved active goals and queued work do not inflate the filter', () => {
  const saved = { ...conversation, goal: { status: 'active', running: false, runStatus: null } };
  const running = { ...conversation, rootId: 'running', status: 'running', settled: false, goal: undefined };
  const queued = { ...running, rootId: 'queued', status: 'queued' };
  assert.equal(planningConversationActivity(saved).running, false);
  assert.equal(planningConversationActivity(queued).label, 'Queued');
  assert.equal(planningConversationActivity(queued).pending, true);
  assert.deepEqual(planningCurrentConversations([saved, running, queued], { view: 'running' }).map(row => row.id), ['running']);
  assert.equal(planningConversationActivity({ status: 'running', settled: true }).running, false);
});

test('live goal observations can describe a newly admitted run before catalog history catches up', () => {
  const live = planningConversationActivity(conversation, { status: 'active', running: true, runStatus: 'running', currentRunId: 'new-run' });
  assert.equal(live.running, true);
  assert.equal(planningConversationActivity({ status: 'running', settled: false }, { running: false, runStatus: 'waiting' }).label, 'Waiting');
  assert.equal(planningConversationActivity({ status: 'running', settled: false }, { running: false, runStatus: null }).state, 'unknown');
});

test('historical failure remains a factual result instead of a current attention demand', () => {
  assert.deepEqual(planningConversationActivity({ status: 'failed', settled: true }), { state: 'failed', label: 'Failed', running: false, pending: false });
  assert.equal(planningConversationActivity({ state: 'active' }).label, 'Saved');
});

test('catalog tolerates malformed list shapes, deduplicates roots, filters archive and excludes trash', () => {
  for (const value of [null, {}, { conversations: null }, { conversations: {} }]) assert.deepEqual(planningCurrentConversations(value), []);
  const older = { ...conversation, id: 'old-run', latestRunId: 'old-run', updatedAt: '2026-11-12T00:00:00Z' };
  const newest = { ...conversation, updatedAt: '2026-11-13T00:00:00Z' };
  const archived = { ...conversation, rootId: 'archived', state: 'archived' };
  const deleted = { ...conversation, rootId: 'deleted', state: 'deleted' };
  const rows = planningCurrentConversations({ conversations: [null, {}, older, newest, archived, deleted] }, { view: 'all' });
  assert.deepEqual(rows.map(row => row.id), ['conversation-root', 'archived']);
  assert.equal(rows[0].runId, 'run-latest');
  assert.equal(planningCurrentConversations(rows, { view: 'archived' })[0].id, 'archived');
  assert.equal(planningCurrentConversations(rows, { query: 'CURRENT' }).length, 1);
});
