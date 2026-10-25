import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanningDraft, planningDraftDirty, planningDraftOperations, acceptPlanningSnapshot, rebasePlanningDraft, commitPlanningDraft, projectVisualModel } from '../public/next/workspaces/planning-visual.mjs';

const plan = (revision = 1) => ({ taskId: 'task-a', revision, goal: 'Saved goal', steps: [{ id: 'inspect', title: 'Inspect', note: 'Saved note' }, { id: 'check', title: 'Check', note: 'Saved check' }] });

test('Planning drafts require full saved steps and emit only the changed descriptive fields', () => {
  assert.throws(() => createPlanningDraft({ taskId: 'task-a', revision: 1 }), /Load the saved plan/);
  const source = plan(), before = structuredClone(source), draft = createPlanningDraft(source);
  assert.equal(planningDraftDirty(draft), false); draft.notes.set('check', 'Actually checked the result');
  assert.deepEqual(planningDraftOperations(draft), [{ type: 'update', stepId: 'check', patch: { note: 'Actually checked the result' } }]);
  draft.goal = 'Updated goal';
  assert.deepEqual(planningDraftOperations(draft)[0], { type: 'metadata', patch: { goal: 'Updated goal' } });
  assert.deepEqual(source, before);
});

test('a new snapshot preserves local edits and old base until the user explicitly rebases', () => {
  const draft = createPlanningDraft(plan()); draft.goal = 'Local goal'; draft.notes.set('inspect', 'Local note');
  const remote = plan(2); remote.goal = 'Remote goal'; remote.steps[1].note = 'Remote check'; remote.steps.push({ id: 'deliver', title: 'Deliver', note: 'New remote step' });
  const conflict = acceptPlanningSnapshot(draft, remote);
  assert.equal(conflict.base.revision, 1); assert.equal(conflict.latest.revision, 2); assert.equal(conflict.goal, 'Local goal');
  const rebased = rebasePlanningDraft(conflict);
  assert.equal(rebased.base.revision, 2); assert.equal(rebased.goal, 'Local goal'); assert.equal(rebased.notes.get('inspect'), 'Local note'); assert.equal(rebased.notes.get('check'), 'Remote check'); assert.equal(rebased.notes.get('deliver'), 'New remote step');
  assert.deepEqual(planningDraftOperations(rebased), [{ type: 'metadata', patch: { goal: 'Local goal' } }, { type: 'update', stepId: 'inspect', patch: { note: 'Local note' } }]);
});

test('removed step notes remain available locally without writing nonexistent step IDs', () => {
  const draft = createPlanningDraft(plan()); draft.notes.set('inspect', 'A local note worth retaining');
  const remote = plan(2); remote.steps.shift();
  const rebased = rebasePlanningDraft(acceptPlanningSnapshot(draft, remote));
  assert.deepEqual(rebased.detachedNotes, [{ id: 'inspect', title: 'Inspect', note: 'A local note worth retaining' }]);
  assert.deepEqual(planningDraftOperations(rebased), []);
});

test('wrong task, metadata-only and older snapshots cannot replace the loaded document', () => {
  const draft = createPlanningDraft(plan(3));
  for (const snapshot of [{ taskId: 'task-a', revision: 4 }, { ...plan(4), taskId: 'task-b' }, plan(2)]) assert.equal(acceptPlanningSnapshot(draft, snapshot), draft);
  const refreshed = acceptPlanningSnapshot(draft, plan(4)); assert.equal(refreshed.base.revision, 4); assert.equal(planningDraftDirty(refreshed), false);
});

test('a delayed successful save retains newer edits and a later authoritative revision', () => {
  const draft = createPlanningDraft(plan()); draft.goal = 'Submitted goal'; draft.notes.set('check', 'Submitted note');
  const submitted = { goal: draft.goal, notes: new Map(draft.notes) };
  draft.goal = 'Typed after submission'; draft.notes.set('check', 'Newer note');
  draft.latest = plan(3);
  const saved = plan(2); saved.goal = submitted.goal; saved.steps[1].note = 'Submitted note';
  const committed = commitPlanningDraft(draft, saved, submitted);
  assert.equal(committed.base.revision, 2); assert.equal(committed.latest.revision, 3); assert.equal(committed.goal, 'Typed after submission'); assert.equal(committed.notes.get('check'), 'Newer note'); assert.equal(planningDraftDirty(committed), true);
});

test('project maps retain real dependencies and review readiness without inventing dates', () => {
  const project = { id: 'project-a', name: 'Deliver checked work', status: 'paused', tasks: [
    { id: 'first', title: 'Implement', status: 'verifying', dependsOn: [], attempts: [{ implementation: { status: 'completed', runId: 'implementation' }, verification: { status: 'running' } }] },
    { id: 'second', title: 'Deliver', status: 'pending', dependsOn: ['first'], attempts: [] },
  ], milestones: [{ id: 'delivery', title: 'Delivery checked', taskIds: ['second'], dueDate: '2026-11-01', done: false }] };
  const before = structuredClone(project), model = projectVisualModel(project);
  assert.deepEqual(model.edges, [{ source: 'first', target: 'second', kind: 'dependency' }]);
  assert.equal(model.nodes[0].status, 'reviewing'); assert.equal(model.nodes[1].status, 'waiting'); assert.equal(model.progress.completed, 0); assert.equal(model.milestones[0].dueDate, '2026-11-01');
  assert.ok(model.nodes.every(node => !Object.hasOwn(node, 'dueDate') && !Object.hasOwn(node, 'startedAt'))); assert.deepEqual(project, before);
  project.tasks[0].attempts.push({ mode: 'review_only', verification: { status: 'prepared' } }); assert.equal(projectVisualModel(project).nodes[0].status, 'ready');
});
