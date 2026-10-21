import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTaskState } from '../public/task-state-ui.mjs';
import { missionMilestones, missionProgress } from '../public/mission-model.mjs';

const state = steps => ({ taskId: 'saved-task', revision: 3, goal: 'A keyboard accessible chess trainer', steps, checkpoint: null, artifacts: [] });
const fixture = () => state([
  { id: 'inspect', title: 'Inspect the existing game', status: 'done', evidence: 'Read the board and input files.' },
  { id: 'build', title: 'Build keyboard controls', status: 'active', doneWhen: 'All board actions work without a mouse.' },
  { id: 'verify', title: 'Test a complete game', status: 'pending' },
]);

test('saved milestones expose one current action, a criterion and a real win before any disclosure', () => {
  const saved = fixture(), html = renderTaskState(saved, { runStatus: 'running' }), visible = html.split('<details')[0];
  assert.match(visible, /Now<\/span><strong>Build keyboard controls/);
  assert.match(visible, /Done when<\/span><p>All board actions work/);
  assert.match(visible, />Next<\/span><p>Test a complete game/);
  assert.match(visible, />Done<\/span><p>Inspect the existing game/);
  assert.match(visible, /1<span> \/ 3 done/); assert.match(visible, /Agent-reported/);
  assert.doesNotMatch(html, /data-mission-action="continue-milestone"/); assert.doesNotMatch(html, /\b\d+%|ETA/);
  assert.match(html, /<details class="task-plan" data-task-detail="plan">/);
  assert.deepEqual(saved, fixture(), 'rendering does not mutate saved status or evidence');
});

test('a finished or stopped response never marks its saved active milestone done or says it is running', () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    const saved = fixture(), html = renderTaskState(saved, { runStatus: status, settled: true, canContinue: true, canRepeat: true, runId: 'turn-3' }), visible = html.split('<details')[0];
    assert.match(visible, /Resume<\/span><strong>Build keyboard controls/); assert.doesNotMatch(visible, />Now</);
    assert.match(html, /Draft next action/); assert.doesNotMatch(html, /Make repeatable/); assert.equal(saved.steps[1].status, 'active');
  }
  const progress = missionProgress({ status: 'completed', taskState: fixture(), nodes: { agent: { status: 'completed' } } });
  assert.equal(progress.completed, 1); assert.equal(progress.total, 3); assert.equal(progress.title, 'Response finished. Milestones remain.');
});

test('a blocker stays actionable, escaped and visually distinct, with unverified evidence inside details', () => {
  const saved = state([{ id: 'blocked', title: '<script>Connect the target app</script>', status: 'blocked', blockedReason: '<img src=x onerror=bad> Session expired', doneWhen: 'The target page is available.', evidence: '<b>Agent report</b>' }]);
  saved.checkpoint = { kind: 'agent', nextAction: 'Reconnect the account, then inspect the page.', nextSteps: ['Do not lose the context'] };
  const html = renderTaskState(saved, { runStatus: 'completed', settled: true, canContinue: true, runId: 'blocked-turn' }), visible = html.split('<details')[0];
  assert.match(visible, />Blocked</); assert.match(visible, />Needs<\/span><p>&lt;img/); assert.match(visible, />Next action<\/span><p>Reconnect the account/);
  assert.match(html, /Evidence · agent-reported/); assert.match(html, /&lt;b&gt;Agent report&lt;\/b&gt;/); assert.doesNotMatch(html, /<script>|<img|<b>Agent/);
  assert.match(visible, /M12 7v6m0 4h.01/); assert.match(html, /Draft next action/);
  assert.equal(missionProgress({ status: 'completed', taskState: saved }).title, 'A milestone needs attention.');
});

test('long plans keep a small visible working set and retain every milestone in All milestones', () => {
  const saved = state(Array.from({ length: 80 }, (_, index) => ({ id: `step-${index}`, title: `Milestone ${index + 1}`, status: index < 37 ? 'done' : index === 37 ? 'active' : 'pending' })));
  const html = renderTaskState(saved, { runStatus: 'running' }), visible = html.split('<details')[0];
  assert.match(visible, /Milestone 38/); assert.match(visible, /Milestone 39/); assert.match(visible, /Milestone 37/); assert.doesNotMatch(visible, /Milestone 80/);
  assert.equal((html.match(/class="task-plan-step /g) || []).length, 80); assert.match(html, /80 done/); assert.equal(saved.steps.length, 80);
});

test('complete saved milestones expose repeat setup only for a settled completed run and never manufacture progress', () => {
  const saved = state([{ id: 'ship', title: 'Verify delivery', status: 'done', evidence: 'Verified delivery receipt.' }]);
  saved.checkpoint = { nextSteps: ['A stale legacy next action'] };
  const html = renderTaskState(saved, { runStatus: 'completed', settled: true, canContinue: true, canRepeat: true, runId: 'finished-turn' });
  assert.match(html, /Saved milestones complete/); assert.match(html, /Make repeatable/); assert.doesNotMatch(html, /Draft next action/);
  assert.doesNotMatch(html.split('<details')[0], /A stale legacy next action/);
  for (const options of [{ runStatus: 'running', settled: false }, { runStatus: 'failed', settled: true }, { runStatus: 'completed', settled: true, canRepeat: false }]) assert.doesNotMatch(renderTaskState(saved, { canRepeat: true, ...options }), /Make repeatable/);
  assert.equal(missionMilestones(state([])).complete, false); assert.equal(renderTaskState(state([])), '');
});

test('checkpoint-only work can draft one concrete next action while legacy broad instructions do not override a current milestone', () => {
  const saved = state([]); saved.checkpoint = { kind: 'agent', nextAction: 'Run the keyboard checks.' };
  const html = renderTaskState(saved, { runStatus: 'completed', settled: true, canContinue: true, runId: 'checkpoint-turn' });
  assert.match(html.split('<details')[0], /Run the keyboard checks/); assert.match(html, /Draft next action/);
  const current = fixture(); current.checkpoint = { nextSteps: ['An older broad action'] };
  assert.equal(missionMilestones(current).nextAction, ''); assert.equal(missionMilestones(current).current.id, 'build');
});
