import test from 'node:test';
import assert from 'node:assert/strict';
import { planningQuery, planningConversations, listPlanningWorkspace, editPlanningWorkspace } from '../lib/planning-workspace.mjs';

function context() {
  const entries = [
    { id: 'a-turn', taskId: 'a', latestRunId: 'a-turn', title: 'Renamed active chat', state: 'active', status: 'completed', updatedAt: '2026-10-19T10:00:00Z' },
    { id: 'b-turn', taskId: 'b', title: 'Archived chat', state: 'archived', status: 'completed', updatedAt: '2026-10-19T09:00:00Z' },
    { id: 'c-turn', taskId: 'c', title: 'Discarded chat', state: 'deleted', status: 'failed', updatedAt: '2026-10-19T08:00:00Z' },
  ];
  const runs = new Map([['a-next', { id: 'a-next', taskId: 'a', input: 'Continue working', status: 'running', createdAt: '2026-10-19T10:01:00Z', updatedAt: '2026-10-19T10:01:00Z' }]]), calls = [], events = [];
  return { entries, calls, events, conversations: { list: () => structuredClone(entries), status: () => ({ healthy: true }) },
    engine: { runs, listRuns: () => [...runs.values()].map(run => structuredClone(run)), adoptTaskState: (run, state) => { if ((run.taskState?.revision || 0) >= state.revision) return false; run.taskState = structuredClone(state); return true; }, notify: (...args) => events.push(args) },
    tasks: { async listPlans(options) { calls.push(options); return { plans: options.taskIds.map(taskId => ({ taskId, revision: 3, goal: 'Saved ' + taskId, progress: { total: 2, done: 0 } })), total: options.taskIds.length, limit: options.limit, offset: options.offset, nextOffset: null, hasMore: false, errors: [], healthy: true }; }, async editPlan(taskId, value, options) { calls.push({ taskId, value, options }); return { taskId, revision: options.expectedRevision + 1, steps: [], progress: { done: 0, total: 0 } }; } }, onUpdated: event => events.push(event) };
}
test('Planning catalog query uses exact fields and bounded pagination', () => {
  assert.deepEqual(planningQuery(new URLSearchParams()), { query: '', state: 'active', limit: 40, offset: 0 });
  assert.deepEqual(planningQuery(new URLSearchParams('query=analysis&state=archived&limit=20&offset=40')), { query: 'analysis', state: 'archived', limit: 20, offset: 40 });
  for (const input of ['state=unknown', 'limit=0', 'limit=101', 'offset=-1', 'offset=1.2', 'offset=1000001', 'query=one&query=two', 'taskIds=hidden', 'query=' + 'x'.repeat(501)]) assert.throws(() => planningQuery(new URLSearchParams(input)), { status: 400 });
});
test('Planning catalog preserves renamed titles and buckets when a new turn starts', () => {
  const values = planningConversations(context());
  assert.deepEqual(values.get('a'), { taskId: 'a', title: 'Renamed active chat', runId: 'a-next', runStatus: 'running', bucket: 'active', updatedAt: '2026-10-19T10:01:00Z' }); assert.equal(values.get('c').bucket, 'deleted');
});
test('Planning filters saved-chat buckets before store pagination', async () => {
  const c = context(), result = await listPlanningWorkspace(c, planningQuery(new URLSearchParams()));
  assert.deepEqual(c.calls[0].taskIds, ['a']); assert.deepEqual(result.plans.map(plan => plan.bucket), ['active']); assert.equal(result.plans[0].running, true);
  const trash = await listPlanningWorkspace(c, planningQuery(new URLSearchParams('state=deleted'))); assert.deepEqual(c.calls[1].taskIds, ['c']); assert.equal(trash.plans[0].editable, false);
  const all = await listPlanningWorkspace(c, planningQuery(new URLSearchParams('state=all'))); assert.deepEqual(all.plans.map(plan => plan.bucket), ['active', 'archived']);
});
test('Planning reports damaged history without broadening visibility to unknown chats', async () => {
  const c = context(); c.entries[0].state = 'unknown'; c.conversations.status = () => ({ healthy: false, error: 'History metadata is damaged.' });
  const result = await listPlanningWorkspace(c, planningQuery(new URLSearchParams())); assert.deepEqual(c.calls[0].taskIds, []); assert.equal(result.healthy, false); assert.match(result.errors[0].error, /damaged/);
});
test('Planning renamed-title matches are added within the visible task allowlist before pagination', async () => {
  const c = context(); c.entries[2].title = 'Renamed discarded chat';
  await listPlanningWorkspace(c, planningQuery(new URLSearchParams('query=Renamed&limit=1')));
  assert.deepEqual(c.calls[0].queryTaskIds, ['a']); assert.deepEqual(c.calls[0].taskIds, ['a']); assert.equal(c.calls[0].limit, 1);
});
test('Planning commits only the requested work edit and publishes continuity without changing execution', async () => {
  const c = context(), value = { expectedRevision: 3, operations: [{ type: 'metadata', patch: { goal: 'A shared goal' } }] };
  const saved = await editPlanningWorkspace(c, 'a', value);
  assert.equal(saved.revision, 4); assert.deepEqual(c.calls[0], { taskId: 'a', value: { operations: value.operations }, options: { expectedRevision: 3, source: 'human' } });
  assert.equal(c.engine.runs.get('a-next').status, 'running'); assert.equal(c.engine.runs.get('a-next').taskState.revision, 4); assert.equal(c.events[0][3].type, 'task.state'); assert.equal(c.events[1].type, 'planning.updated');
});
test('Planning rejects ambiguous payloads and unavailable chats before writing or publishing', async () => {
  const c = context(), value = { expectedRevision: 3, operations: [{ type: 'metadata', patch: { goal: 'Continue the saved task' } }] };
  for (const input of [null, [], { ...value, status: 'completed' }, { ...value, expectedRevision: '3' }, { ...value, operations: [] }]) await assert.rejects(editPlanningWorkspace(c, 'a', input), { status: 400 });
  await assert.rejects(editPlanningWorkspace(c, 'c', value), { status: 409, code: 'PLANNING_CHAT_READ_ONLY' }); await assert.rejects(editPlanningWorkspace(c, 'missing', value), { status: 404 }); assert.equal(c.calls.length, 0); assert.equal(c.events.length, 0);
});
test('Planning revision conflict does not overwrite a live run view or broadcast a successful save', async () => {
  const c = context(), before = structuredClone(c.engine.runs.get('a-next'));
  c.tasks.editPlan = async () => { throw Object.assign(Error('Read the latest plan.'), { status: 409, code: 'TASK_STATE_CONFLICT' }); };
  await assert.rejects(editPlanningWorkspace(c, 'a', { expectedRevision: 3, operations: [{ type: 'remove', stepId: 'inspect' }] }), { code: 'TASK_STATE_CONFLICT' }); assert.deepEqual(c.engine.runs.get('a-next'), before); assert.equal(c.events.length, 0);
});
