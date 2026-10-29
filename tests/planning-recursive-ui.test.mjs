import test from 'node:test';
import assert from 'node:assert/strict';
import { taskPlanView, planPredicateText, planBranchText, planLogicFields, planAttemptHistory } from '../public/task-plan-model.mjs';
import { renderPlanHeader, renderPlanInspector } from '../public/task-plan-ui.mjs';
import { exportTaskPlanMM, renderTaskPlanMapSVG } from '../public/task-plan-map.mjs';
import { planningDraftValues, planningEditOperations } from '../public/planning-workspace-model.mjs';
import { renderPlanningEditor } from '../public/planning-workspace-ui.mjs';
import { createPlanningDraft, planningDraftDirty, planningDraftOperations, acceptPlanningSnapshot, rebasePlanningDraft, commitPlanningDraft } from '../public/next/workspaces/planning-visual.mjs';
import { createPlanningWorkspace } from '../public/next/workspaces/planning.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';

const expression = { and: [{ fact: 'input_ready' }, { not: { or: [{ fact: 'needs_revision' }, { fact: 'missing_detail' }] } }] };
const branch = { if: expression, then: 'use', else: 'inspect' };
const choicePlan = () => ({ taskId: 'choice-plan', revision: 3, goal: 'Use the supplied material when ready', planVersion: 1,
  plan: { layout: 'sequence', detail: 'detailed', facts: [{ id: 'input_ready', value: true, evidence: 'Read the complete record.' }, { id: 'needs_revision', value: false, evidence: 'Revision check passed.' }] },
  steps: [{ id: 'route', title: 'Decide the next operation', kind: 'choice', status: 'pending', parentId: null, branch },
    { id: 'use', title: 'Use the record', kind: 'action', status: 'pending', parentId: 'route', doneWhen: 'Record used' },
    { id: 'inspect', title: 'Inspect missing detail', kind: 'action', status: 'pending', parentId: 'route', doneWhen: 'Detail checked' }], artifacts: [] });
const workPlan = (revision = 3) => ({ taskId: 'work-plan', revision, goal: 'Repair the measured defect', planVersion: 1,
  plan: { layout: 'sequence', detail: 'detailed' }, steps: [
    { id: 'measure', title: 'Measure the defect', kind: 'action', status: 'done', doneWhen: 'One measured result', note: 'Read the instrument once.', evidence: 'Measured 4.2', parentId: null },
    { id: 'repair', title: 'Repair its cause', kind: 'action', status: 'pending', doneWhen: 'Cause repaired', note: 'Change the measured fault.', parentId: null }], artifacts: [] });

test('nested saved Boolean expressions remain visible without choosing an unknown ELSE path', () => {
  const state = choicePlan(), before = structuredClone(state), view = taskPlanView(state), choice = view.byId.get('route');
  assert.equal(planPredicateText(expression), '(input_ready AND NOT ((needs_revision OR missing_detail)))');
  assert.deepEqual(choice.branchLogic, branch);
  assert.deepEqual(choice.source.branch, branch);
  assert.equal(choice.branch, 'included');
  assert.equal(choice.statusLabel, 'Waiting for condition');
  assert.equal(view.byId.get('use').branchRole, 'THEN');
  assert.equal(view.byId.get('inspect').branchRole, 'ELSE');
  assert.equal(view.byId.get('inspect').isSelectedOption, false);
  assert.equal(view.byId.get('inspect').branch, 'option');
  const fields = new Map(planLogicFields(view, choice));
  assert.match(fields.get('Observed facts'), /missing_detail: Unknown/);
  assert.equal(fields.get('Condition result'), 'Waiting for the condition to be resolved');
  const html = renderPlanInspector(view, { selectedId: 'route' });
  assert.match(html, /IF \(input_ready AND NOT/);
  assert.match(html, /An unknown fact is not false/);
  assert.match(html, />Then<.*Use the record/);
  assert.match(html, />Else<.*Inspect missing detail/);
  assert.deepEqual(state, before);
});

test('branch conditions and observations are escaped in inspectors and map exports', () => {
  const state = choicePlan(); state.plan.facts[0].evidence = '<img src=x onerror=alert(1)>';
  const view = taskPlanView(state);
  assert.ok(renderPlanInspector(view, { selectedId: 'route' }).includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!renderPlanInspector(view, { selectedId: 'route' }).includes('<img'));
  const exported = exportTaskPlanMM(view);
  assert.match(exported, /IF \(input_ready AND NOT/);
  assert.match(exported, /missing_detail: Unknown/);
  assert.match(exported, /&lt;img/);
  const cyclic = {}; cyclic.not = cyclic;
  assert.equal(planPredicateText(cyclic), 'NOT (Unknown condition)');
});

test('an unknown inner choice stays unselected when an outer condition excludes it', () => {
  const state = choicePlan();
  state.plan.layout = 'choice'; state.plan.branch = { if: { fact: 'use_inner' }, then: 'route', else: 'chosen' }; state.plan.selectedChildId = 'chosen';
  state.plan.facts.push({ id: 'use_inner', value: false, evidence: 'The observed input takes the outer ELSE path.' });
  state.steps.push({ id: 'chosen', title: 'Complete the selected path', kind: 'action', parentId: null, status: 'done', doneWhen: 'The selected result is reported.', evidence: 'The selected path returned its result.' });
  state.availableWork = { byId: { route: { state: 'unselected', reason: 'A different outer path is selected.' } } };
  state.progress = { total: 1, done: 1, skipped: 0, complete: true, unresolvedBranches: 0 };
  const view = taskPlanView(state), inner = view.byId.get('route');
  assert.equal(inner.selectedChildId, undefined);
  assert.equal(inner.branch, 'not-selected');
  assert.equal(inner.statusLabel, 'Not chosen');
  assert.equal(view.complete, true);
  assert.ok(!view.unchosen.includes(inner));
  assert.ok(!renderTaskPlanMapSVG(view).includes('Waiting for condition'));
});

test('ELIF paths, nested comparisons and typed observations remain readable without choosing a path in the browser', () => {
  const state = choicePlan();
  const compare = (id, op, value) => ({ compare: { left: { fact: id }, op, right: { value } } });
  const rule = { if: compare('count', '>=', 3), elif: [
    { if: { xor: [compare('tag', 'in', ['ready', 'retry']), { not: compare('missing', 'is', null) }] }, then: 'fallback' },
    { if: compare('stale', '==', 0), then: 'recheck' },
  ], then: 'use', else: 'inspect' };
  Object.assign(state.steps[0], { branch: rule, selectedChildId: 'fallback' });
  state.steps.push({ id: 'fallback', title: 'Use the fallback', kind: 'action', parentId: 'route', status: 'pending' }, { id: 'recheck', title: 'Check again', kind: 'action', parentId: 'route', status: 'pending' });
  state.plan.facts = [
    { id: 'count', value: 2, evidence: 'Two inputs were supplied.' },
    { id: 'tag', value: 'ready', evidence: 'The current tag is ready.' },
    { id: 'missing', value: null, known: true, evidence: 'The returned field was explicitly None.' },
    { id: 'stale', value: 0, known: false, evidence: 'The old value needs another observation.' },
  ];
  const before = structuredClone(state), view = taskPlanView(state), fields = new Map(planLogicFields(view, view.byId.get('route')));
  assert.equal(fields.get('Condition'), 'IF (count >= 3)');
  assert.equal(fields.get('Elif 1'), 'ELIF ((tag in ["ready", "retry"]) XOR NOT ((missing is None)))');
  assert.equal(fields.get('Then (elif 1)'), 'Use the fallback');
  assert.equal(fields.get('Condition result'), 'Earlier conditions are false · ELIF 1 path selected');
  assert.match(fields.get('Observed facts'), /count: 2/);
  assert.match(fields.get('Observed facts'), /tag: "ready"/);
  assert.match(fields.get('Observed facts'), /missing: None/);
  assert.match(fields.get('Observed facts'), /stale: Unknown/);
  assert.equal(view.byId.get('fallback').branchRole, 'ELIF 1');
  assert.equal(view.byId.get('recheck').branchRole, 'ELIF 2');
  assert.equal(view.byId.get('fallback').isSelectedOption, true);
  assert.match(renderPlanInspector(view, { selectedId: 'route' }), /ELIF.*XOR/);
  assert.match(renderTaskPlanMapSVG(view), /ELIF 1/);
  assert.match(exportTaskPlanMM(view), /ELIF.*XOR/);
  assert.deepEqual(state, before);
  delete state.steps[0].selectedChildId;
  assert.equal(new Map(planLogicFields(taskPlanView(state), taskPlanView(state).byId.get('route'))).get('Condition result'), 'Waiting for the condition to be resolved');
});

test('root IF/ELIF/ELSE conditions and Python-style comparison literals are preserved in headers and exports', () => {
  const state = choicePlan(), hostile = '<img src=x onerror=alert(1)>';
  state.plan = { layout: 'choice', facts: [{ id: 'items', value: ['safe', hostile], evidence: 'Observed both exact strings.' }], branch: {
    if: { compare: { left: { value: hostile }, op: 'not in', right: { fact: 'items' } } }, then: 'use',
    elif: [{ if: { compare: { left: { fact: 'optional' }, op: 'is not', right: { value: null } } }, then: 'fallback' }], else: 'inspect',
  } };
  state.steps = state.steps.slice(1).map(step => ({ ...step, parentId: null }));
  state.steps.push({ id: 'fallback', title: 'Use the fallback', kind: 'action', status: 'pending' });
  const view = taskPlanView(state), rule = state.plan.branch;
  assert.match(planBranchText(rule), /\nELIF .* is not None.*\nELSE → inspect/);
  for (const output of [renderPlanHeader(view), renderTaskPlanMapSVG(view), exportTaskPlanMM(view)]) {
    assert.match(output, /ELIF/); assert.match(output, /ELSE/);
    assert.ok(output.includes('&lt;img')); assert.ok(!output.includes('<img'));
  }
  const observations = new Map(planLogicFields(view, { branchLogic: rule })).get('Observed facts');
  assert.match(observations, /items: \["safe", "<img/);
  assert.match(observations, /optional: Unknown/);
  for (const op of ['==', '!=', '<', '<=', '>', '>=', 'in', 'not in', 'is', 'is not']) {
    assert.equal(planPredicateText({ compare: { left: { fact: 'left' }, op, right: { fact: 'right' } } }), '(left ' + op + ' right)');
  }
});

test('valid expression depth and breadth are displayed at the server limits', () => {
  let nested = { fact: 'deep_observation' };
  for (let level = 1; level < 24; level++) nested = { not: nested };
  assert.ok(planPredicateText(nested).includes('deep_observation'));
  assert.ok(!planPredicateText(nested).includes('…'));
  const broad = { and: Array.from({ length: 200 }, (_, index) => ({ fact: 'observed_' + index })) };
  assert.ok(planPredicateText(broad).includes('observed_199'));
  assert.ok(!planPredicateText(broad).includes('…'));
  assert.ok(planPredicateText({ not: nested }).includes('…'));
});

test('reopened work displays earlier attempts without treating earlier evidence as current completion', () => {
  const state = workPlan(), step = state.steps[0];
  step.status = 'pending'; delete step.evidence; step.attempt = 2;
  step.pastAttempts = [{ attempt: 1, status: 'done', at: '2026-10-29T12:00:00.000Z', reason: 'A later observation contradicted the measurement.', doneWhen: 'One measured result', note: 'Read the instrument once.', evidence: 'Measured 4.2' }];
  const view = taskPlanView(state), node = view.byId.get('measure');
  assert.equal(view.progress.done, 0);
  assert.equal(node.status, 'pending');
  assert.equal(planAttemptHistory(node)[0].fields.at(-1)[1], 'Measured 4.2');
  const html = renderPlanInspector(view, { selectedId: 'measure' });
  assert.match(html, /Current attempt/);
  assert.match(html, /Previous attempts · 1/);
  assert.match(html, /Attempt 1 · done/);
  assert.match(html, /does not undo its effects/);
  assert.match(html, /Measured 4.2/);
  assert.match(exportTaskPlanMM(view), /Revisited|contradicted the measurement/);
});

test('previous attempts expose blockers, skipped reasons and observed effects with archival dates', () => {
  const state = workPlan(), step = state.steps[0], at = '2026-10-29T12:00:00.000Z';
  step.status = 'pending'; delete step.evidence; step.attempt = 4;
  step.pastAttempts = [
    { attempt: 1, status: 'blocked', at, reason: 'The input became available.', blockedReason: '<input.txt> was unavailable.' },
    { attempt: 2, status: 'skipped', at, reason: 'The requested scope changed.', skipReason: 'The then-current request excluded this measurement.' },
    { attempt: 3, status: 'done', at, reason: 'A new destination observation is required.', evidence: 'The destination read returned its actual state.', reconciliation: { callId: 'old-write', outcome: 'absent', evidence: 'The successful later read found the unchanged destination.' } },
  ];
  const view = taskPlanView(state), history = planAttemptHistory(view.byId.get('measure'));
  assert.equal(new Map(history[0].fields).get('Blocked by'), '<input.txt> was unavailable.');
  assert.equal(new Map(history[1].fields).get('Why skipped'), 'The then-current request excluded this measurement.');
  assert.equal(new Map(history[2].fields).get('Effect observation'), 'Earlier effect checked absent');
  for (const rendered of [renderPlanInspector(view, { selectedId: 'measure' }), exportTaskPlanMM(view)]) {
    assert.match(rendered, /Archived on/);
    assert.match(rendered, /&lt;input.txt&gt; was unavailable/);
    assert.match(rendered, /then-current request excluded/);
    assert.match(rendered, /Earlier effect checked absent/);
    assert.match(rendered, /successful later read found the unchanged destination/);
  }
});

test('revisit drafts archive the prior attempt before procedure edits and require a concrete reason', () => {
  const draft = createPlanningDraft(workPlan());
  draft.revisit = { stepId: 'measure', reason: '  Recheck after the instrument reset.  ' };
  draft.notes.set('measure', 'Read the reset instrument once.');
  assert.equal(planningDraftDirty(draft), true);
  assert.deepEqual(planningDraftOperations(draft), [
    { type: 'revisit', stepId: 'measure', reason: 'Recheck after the instrument reset.' },
    { type: 'update', stepId: 'measure', patch: { note: 'Read the reset instrument once.' } },
  ]);
  draft.revisit.reason = ' ';
  assert.throws(() => planningDraftOperations(draft), /Explain why/);
  draft.revisit.reason = 'x'.repeat(1001);
  assert.throws(() => planningDraftOperations(draft), /1,000/);
});

test('revisit drafts survive revision changes and only the submitted request is consumed on save', () => {
  const draft = createPlanningDraft(workPlan()); draft.revisit = { stepId: 'measure', reason: 'Inspect the changed instrument.' };
  const later = workPlan(4), conflicted = acceptPlanningSnapshot(draft, later);
  assert.equal(conflicted.base.revision, 3); assert.equal(conflicted.latest.revision, 4);
  const rebased = rebasePlanningDraft(conflicted);
  assert.equal(rebased.base.revision, 4); assert.deepEqual(rebased.revisit, draft.revisit);
  const submitted = { goal: rebased.goal, notes: new Map(rebased.notes), revisit: { ...rebased.revisit } };
  assert.equal(commitPlanningDraft(rebased, workPlan(5), submitted).revisit, null);
  rebased.revisit = { stepId: 'repair', reason: 'Reassess its effect.' };
  assert.deepEqual(commitPlanningDraft(rebased, workPlan(5), submitted).revisit, rebased.revisit);
  later.steps.shift();
  const removed = rebasePlanningDraft(acceptPlanningSnapshot(draft, later));
  assert.equal(removed.revisit, null);
  assert.match(removed.detachedNotes[0].note, /Revisit requested: Inspect the changed instrument/);
  assert.deepEqual(planningDraftOperations(removed), []);
});

test('legacy editor offers explicit revisit and does not manually choose a Boolean branch', () => {
  const task = workPlan(), original = planningDraftValues(task, 'measure');
  const draft = { key: 'measure', mode: 'step', stepId: 'measure', values: { ...original, revisitReason: 'The measurement changed.' }, original };
  assert.deepEqual(planningEditOperations(draft), [{ type: 'revisit', stepId: 'measure', reason: 'The measurement changed.' }]);
  assert.match(renderPlanningEditor(task, draft), /data-planning-field="revisitReason"/);
  const choice = choicePlan(), values = planningDraftValues(choice, 'route');
  const html = renderPlanningEditor(choice, { key: 'route', mode: 'step', stepId: 'route', values, original: values });
  assert.match(html, /IF \(input_ready AND NOT/);
  assert.ok(!html.includes('data-planning-field="selectedChildId"'));
  draft.values = { ...original, status: 'pending' };
  assert.throws(() => planningEditOperations(draft), /Return to this step/);
});

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
test('current Planning UI saves a queued revisit once at the observed revision and shows preserved history', async t => {
  const dom = planningDOM(t), writes = [];
  const prototype = Object.getPrototypeOf(dom.mount);
  Object.defineProperty(prototype, 'type', { get() { return this.getAttribute('type') || this.tagName.toLowerCase(); }, set(value) { this.setAttribute('type', value); }, configurable: true });
  prototype.replaceChildren = function (...nodes) { for (const child of [...this.children]) child.remove(); this.rawText = ''; this.append(...nodes); };
  const matches = prototype.matches; prototype.matches = function (selector) { return matches.call(this, selector.replace(/\[([^=\]]+)=([^\]"']+)\]/g, '[$1="$2"]')); };
  let stored = workPlan();
  const api = async (route, method = 'GET', payload) => {
    if (route.startsWith('/api/planning?')) return { plans: [{ taskId: stored.taskId, revision: stored.revision, goal: stored.goal, bucket: 'active', editable: true, status: 'completed' }], nextOffset: null };
    if (route === '/api/tasks/work-plan' && method === 'GET') return structuredClone(stored);
    if (route === '/api/tasks/work-plan/plan/edit' && method === 'POST') {
      writes.push(structuredClone(payload));
      assert.equal(payload.expectedRevision, 3);
      assert.deepEqual(payload.operations, [{ type: 'revisit', stepId: 'measure', reason: 'New evidence changed the measurement.' }]);
      const previous = stored.steps[0];
      stored = { ...stored, revision: 4, steps: [{ ...previous, status: 'pending', evidence: undefined, attempt: 2, pastAttempts: [{ attempt: 1, status: previous.status, at: '2026-10-29T12:00:00.000Z', reason: payload.operations[0].reason, evidence: previous.evidence }] }, stored.steps[1]] };
      return structuredClone(stored);
    }
    throw Error('Unexpected ' + method + ' ' + route);
  };
  const component = createPlanningWorkspace({ mount: dom.mount, api, events: { subscribe: () => () => {} } });
  t.after(() => component.destroy());
  dom.$('#next-planning-type').value = 'conversation'; component.enter(); await settle();
  await dom.click('[data-plan-map-node="measure"]');
  assert.equal(dom.$('#next-planning-inspector').dataset.selectedStepId, 'measure');
  await dom.input('#next-planning-revisit-reason', 'New evidence changed the measurement.');
  await dom.click('#next-planning-queue-revisit');
  assert.equal(writes.length, 0);
  assert.ok(!dom.$('#next-planning-save').disabled);
  await dom.$('#next-planning-edit').dispatch('submit', {}, true); await settle();
  assert.equal(writes.length, 1);
  assert.equal(stored.revision, 4);
  assert.match(dom.$('#next-planning-inspector').textContent, /Previous attempts · 1/);
  assert.match(dom.$('#next-planning-inspector').textContent, /Archived on/);
  assert.match(dom.$('#next-planning-inspector').textContent, /Measured 4.2/);
  assert.ok(dom.$('#next-planning-save').disabled);
});
