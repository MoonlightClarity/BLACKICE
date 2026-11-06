import test from 'node:test';
import assert from 'node:assert/strict';
import { taskPlanView, reconcilePlanSession, selectPlanStep, planStepContext, planKeyboard } from '../public/task-plan-model.mjs';
import { renderPlanHeader, renderPlanInspector } from '../public/task-plan-ui.mjs';
import { renderContractJournal } from '../public/planning-contract-ui.mjs';
import { newerTaskState } from '../public/run-state-model.mjs';
import { planningActivityForEvent, projectPlanningActivity } from '../public/next/chat/planning-timeline.mjs';

function state(extra = {}) {
  return { taskId: 'task-one', revision: 3, goal: 'Enroll in two distinct workshops', steps: [],
    contract: { contractVersion: 2, planEpoch: 2, goal: 'Enroll in two distinct workshops', criteria: [{ id: 'enrollments', kind: 'external-confirmation', description: 'Distinct confirmed enrollments', targetCount: 2 }],
      workItems: [{ id: 'inspect', title: 'Inspect workshop options', objective: 'Read the complete catalog.', owner: 'coordinator', resourceKeys: ['origin:https://portal.test'], effects: ['observe'], dependsOn: [], criterionIds: [] },
        { id: 'enroll', title: 'Enroll and verify', objective: 'Complete and verify the chosen forms.', owner: 'coordinator', resourceKeys: ['origin:https://portal.test'], effects: ['observe', 'interact', 'commit', 'opaque'], dependsOn: ['inspect'], criterionIds: ['enrollments'] }], instructions: [] },
    contractRuntime: { version: 1, planEpoch: 2, journalSeq: 12,
      workItems: [{ id: 'inspect', status: 'satisfied', ready: false, operationCount: 4, unresolvedCount: 0 }, { id: 'enroll', status: 'running', ready: true, operationCount: 8, unresolvedCount: 1 }],
      focuses: [{ workItemId: 'enroll', runId: 'run-one', nodeId: 'coordinator', planEpoch: 2, deliveredPlanEpoch: 2 }],
      criteria: [{ id: 'enrollments', satisfied: false, observedCount: 0, targetCount: 2, evidenceIds: [], reason: 'Submission is not confirmation.' }],
      operations: [{ operationId: 'op1', workItemId: 'enroll', runId: 'run-one', nodeId: 'coordinator', tool: 'relay_browser', action: 'click', journalSeq: 12,
        deliveryState: 'returned', effectState: 'unconfirmed', success: true, startedAt: '2026-11-05T18:00:00.000Z', arguments: { private: 'DO_NOT_PROJECT' }, rawResult: 'DO_NOT_PROJECT' }],
      omittedOperations: 11, unresolved: ['op1'], findings: [], evidence: [], outcomes: [] }, ...extra };
}

test('work items, outcome counts and actual operations stay separate without legacy step mutation', () => {
  const original = state(), copy = structuredClone(original), view = taskPlanView(original, { runStatus: 'running', planningMode: 'forced' });
  assert.equal(view.contractVersion, 2); assert.equal(view.nodes.length, 2); assert.equal(view.progress.done, 1);
  assert.equal(view.criteria[0].observedCount, 0); assert.equal(view.complete, false);
  assert.equal(view.operations[0].effectState, 'unconfirmed'); assert.equal(view.omittedOperations, 11);
  assert.equal(JSON.stringify(view.operations).includes('DO_NOT_PROJECT'), false);
  assert.deepEqual(original, copy); assert.deepEqual(original.steps, []);
});

test('UI does not count successful delivery as an outcome and escapes public content', () => {
  const saved = state(); saved.contract.workItems[1].title = '<script>bad()</script>';
  const view = taskPlanView(saved), header = renderPlanHeader(view), inspector = renderPlanInspector(view, { selectedId: 'enroll' }), journal = renderContractJournal(view);
  assert.match(header, /work items satisfied/); assert.match(header, /Pending evidence/); assert.doesNotMatch(header, /steps done/);
  assert.match(inspector, /Work item 2/); assert.match(inspector, /&lt;script&gt;/); assert.doesNotMatch(inspector, /<script>/);
  assert.match(journal, /Actual operation history/); assert.match(journal, /unconfirmed/); assert.match(journal, /11 earlier retained/);
  assert.doesNotMatch(journal, /DO_NOT_PROJECT|enrollments completed/);
});

test('a newer same-epoch journal is adopted without replacing canonical same-revision plan or local drafts', () => {
  const before = state(), incoming = state();
  incoming.contractRuntime.journalSeq = 13; incoming.contractRuntime.operations.push({ operationId: 'op2', deliveryState: 'returned', effectState: 'not-applicable' });
  incoming.contract.goal = 'This same-revision divergence must not overwrite the plan';
  const adopted = newerTaskState(before, incoming, 'task-one');
  assert.equal(adopted.contractRuntime.journalSeq, 13); assert.equal(adopted.contract.goal, before.contract.goal);
  let session = reconcilePlanSession(taskPlanView(before), { localDraft: 'Keep my unsent direction', goalOpen: true });
  session = selectPlanStep(taskPlanView(before), session, 'inspect');
  const after = reconcilePlanSession(taskPlanView(adopted), session);
  assert.equal(after.selectedId, 'inspect'); assert.equal(after.pinned, true); assert.equal(after.localDraft, 'Keep my unsent direction'); assert.equal(after.goalOpen, true);
  assert.equal(planStepContext(taskPlanView(adopted), taskPlanView(adopted).byId.get('enroll')).step.id, 'enroll');
});

test('newer same-epoch runtime preserves canonical material and rejects unrelated tasks or epochs', () => {
  const before = state({ progress: { done: 1, journalSeq: 12 }, availableWork: [{ id: 'enroll', ready: true }] });
  const older = state({ revision: 2, goal: 'Stale material goal', steps: [{ id: 'stale' }],
    progress: { done: 1, journalSeq: 900 }, availableWork: [] });
  older.contract.goal = 'Stale canonical goal'; older.contractRuntime.journalSeq = 900;
  const merged = newerTaskState(before, older, 'task-one');
  assert.equal(merged.revision, before.revision); assert.equal(merged.goal, before.goal);
  assert.strictEqual(merged.contract, before.contract); assert.strictEqual(merged.steps, before.steps);
  assert.strictEqual(merged.contractRuntime, older.contractRuntime);
  assert.strictEqual(merged.progress, older.progress); assert.strictEqual(merged.availableWork, older.availableWork);
  assert.equal(before.contractRuntime.journalSeq, 12);
  const otherEpoch = state(); otherEpoch.contract.planEpoch = 3; otherEpoch.contractRuntime.planEpoch = 3; otherEpoch.contractRuntime.journalSeq = 900;
  assert.equal(newerTaskState(before, otherEpoch, 'task-one'), before);
  assert.equal(newerTaskState(before, state({ taskId: 'another' }), 'task-one'), before);
  const initial = state(); delete initial.contractRuntime;
  assert.equal(newerTaskState(initial, before, 'task-one').contractRuntime.journalSeq, 12);
});

test('a stale runtime projection cannot satisfy criteria for a new canonical plan', () => {
  const saved = state(); saved.contract.planEpoch = 3; saved.contractRuntime.criteria[0].satisfied = true; saved.contractRuntime.criteria[0].observedCount = 2;
  const view = taskPlanView(saved);
  assert.equal(view.runtimeCurrent, false); assert.equal(view.criteria[0].observedCount, 0); assert.equal(view.complete, false);
  assert.match(renderPlanHeader(view), /not current for this plan revision/);
});

test('journal-only receipts do not create semantic plan edits; actual criterion changes create outcome evidence rows', () => {
  const before = state(), incoming = state(); incoming.contractRuntime.journalSeq++;
  const event = { at: '2026-11-05T18:02:00Z', data: { type: 'task.state', state: incoming } };
  assert.deepEqual(planningActivityForEvent('run-one', event, before), []);
  incoming.contractRuntime.criteria[0].observedCount = 1;
  const evidence = planningActivityForEvent('run-one', event, before);
  assert.equal(evidence.length, 1); assert.equal(evidence[0].source, 'outcome'); assert.match(evidence[0].text, /1 \/ 2 recorded/);
  incoming.revision++; incoming.contract.planEpoch++; incoming.contractRuntime.planEpoch++;
  assert.equal(planningActivityForEvent('run-one', event, before).filter(item => item.source === 'plan').length, 1);
});

test('equal-revision journal events are retained despite recorded planning revision and preserve public allowlisting', () => {
  const before = state(), after = state(); after.contractRuntime.journalSeq = 14; after.contractRuntime.criteria[0].observedCount = 1;
  const run = { id: 'run-one', planningActivityRevision: 3, planningActivity: [], taskState: after,
    events: [{ at: '2026-11-05T18:01:00Z', data: { type: 'task.state', state: before } }, { at: '2026-11-05T18:02:00Z', data: { type: 'task.state', state: after } }] };
  const rows = projectPlanningActivity(run);
  assert.equal(rows.filter(item => item.source === 'plan').length, 1);
  assert.equal(rows.filter(item => item.source === 'outcome').length, 1);
  assert.doesNotMatch(JSON.stringify(rows), /DO_NOT_PROJECT/);
});

test('work-item keyboard inspection stays local and legacy plan rendering keeps its original semantics', () => {
  const saved = state(), view = taskPlanView(saved), before = structuredClone(saved), session = reconcilePlanSession(view);
  const moved = planKeyboard(view, session, 'Home');
  assert.equal(moved.focusId, 'inspect'); assert.deepEqual(saved, before);
  const legacy = taskPlanView({ taskId: 'old', revision: 1, goal: 'Legacy task', steps: [{ id: 's1', title: 'Read source', status: 'done' }] });
  assert.equal(legacy.contractVersion, undefined); assert.equal(legacy.progress.done, 1);
  assert.match(renderPlanHeader(legacy), /steps done/);
});

test('bounded recent operation projection exposes actual omissions without inventing completion', () => {
  const saved = state(); saved.contractRuntime.operations = Array.from({ length: 200 }, (_, index) => ({ operationId: 'op' + index, action: 'click', success: true, effectState: 'confirmed' }));
  saved.contractRuntime.omittedOperations = 300;
  const view = taskPlanView(saved);
  assert.equal(view.operations.length, 160); assert.equal(view.omittedOperations, 340); assert.equal(view.criteria[0].observedCount, 0); assert.equal(view.complete, false);
});
