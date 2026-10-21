import test from 'node:test';
import assert from 'node:assert/strict';
import { taskPlanView, planAncestors, visiblePlanNodes, reconcilePlanSession, selectPlanStep, togglePlanBranch, planKeyboard } from '../public/task-plan-model.mjs';
import { renderPlanHeader, renderPlanInspector } from '../public/task-plan-ui.mjs';

const action = (id, status = 'pending', parentId = null, extra = {}) => ({ id, title: id.replaceAll('-', ' '), kind: 'action', status, parentId, dependsOn: [], ...extra });
const group = (id, kind = 'sequence', parentId = null, extra = {}) => ({ ...action(id, 'pending', parentId), kind, ...extra });
test('Off preserves saved plan state without presenting prior active steps as current work', () => {
  const state = { taskId: 'saved', plan: { origin: 'agent' }, steps: [action('read', 'active', null, { note: 'Keep this note', evidence: 'Saved source evidence' })] }, before = structuredClone(state);
  const view = taskPlanView(state, { runStatus: 'running', planningMode: 'off' });
  assert.equal(view.phase, 'paused'); assert.equal(view.byId.get('read').status, 'active'); assert.equal(view.byId.get('read').statusLabel, 'Paused here'); assert.equal(view.planningEnabled, false); assert.deepEqual(state, before);
  assert.match(renderPlanHeader(view), /Planning off · saved notes/); assert.match(renderPlanInspector(view, { selectedId: 'read' }), /Saved source evidence/);
  assert.equal(taskPlanView({ steps: [] }, { runStatus: 'running', planningStatus: 'off' }).phase, 'off');
});
function nestedPlan() {
  return { taskId: 'branching-task', revision: 4, goal: 'Choose a useful approach, build it, and check the result.', planVersion: 1, plan: { origin: 'agent', layout: 'sequence', detail: 'balanced', taskType: 'software', method: { id: 'implement', revision: 2, name: 'Implement a change' } }, steps: [
    action('understand', 'done', null, { evidence: 'Read the three supplied files.' }),
    group('investigate', 'parallel', null, { status: 'active' }),
    group('constraints', 'sequence', 'investigate'),
    action('check-input', 'active', 'constraints', { doneWhen: 'The file format and limits are recorded.' }),
    action('check-output', 'pending', 'constraints', { dependsOn: ['check-input'] }),
    action('review-options', 'active', 'investigate'),
    group('choose-route', 'choice'),
    action('reuse-local', 'pending', 'choose-route', { condition: 'The local method meets the requirements.' }),
    action('create-new', 'pending', 'choose-route', { condition: 'No existing method fits.' }),
    action('verify', 'pending', null, { dependsOn: ['choose-route'] }),
  ], artifacts: [] };
}

test('Current step uses the server-computed current instead of a completed or unselected retained focus', () => {
  const source = nestedPlan(); source.plan.focusStepId = 'understand'; source.progress = { current: { id: 'review-options' } };
  assert.equal(taskPlanView(source, { runStatus: 'running' }).focus.id, 'review-options');
  source.plan.focusStepId = 'reuse-local'; delete source.progress.current;
  assert.equal(taskPlanView(source, { runStatus: 'running' }).focus.id, 'check-input', 'an alternative outside the chosen plan is not the current work');
  source.plan.focusStepId = 'understand'; assert.equal(taskPlanView(source).focus.id, 'check-input', 'a terminal authored focus cannot hide remaining work');
});

test('a nested plan retains sibling order and counts action leaves, never the structural groups', () => {
  const source = nestedPlan(), before = structuredClone(source), view = taskPlanView(source, { runStatus: 'running' });
  assert.deepEqual(view.roots.map(node => node.id), ['understand', 'investigate', 'choose-route', 'verify']);
  assert.deepEqual(view.byId.get('investigate').children.map(node => node.id), ['constraints', 'review-options']);
  assert.equal(view.byId.get('check-input').number, '2.1.1');
  assert.deepEqual(planAncestors(view, 'check-input'), ['investigate', 'constraints']);
  assert.deepEqual(view.progress, { total: 5, done: 1, skipped: 0 });
  assert.deepEqual(view.active.map(node => node.id), ['check-input', 'review-options']);
  assert.equal(view.byId.get('verify').statusLabel, 'Waiting');
  assert.deepEqual(source, before, 'presentation must not change persisted data');
});

test('explicit choice paths distinguish proposed options, a chosen route, and deliberate skips', () => {
  const state = nestedPlan(), awaiting = taskPlanView(state, { runStatus: 'running' });
  assert.equal(awaiting.byId.get('reuse-local').statusLabel, 'Option');
  assert.equal(awaiting.byId.get('create-new').branch, 'option');
  state.steps.find(step => step.id === 'choose-route').selectedChildId = 'reuse-local';
  const selected = taskPlanView(state, { runStatus: 'running' });
  assert.equal(selected.byId.get('reuse-local').isSelectedOption, true);
  assert.equal(selected.byId.get('reuse-local').branch, 'included');
  assert.equal(selected.byId.get('create-new').statusLabel, 'Not chosen');
  assert.equal(selected.byId.get('create-new').status, 'pending', 'selection never invents skipped work');
  state.steps.find(step => step.id === 'create-new').status = 'skipped';
  state.steps.find(step => step.id === 'create-new').skipReason = 'The existing implementation meets the requirements.';
  const skipped = taskPlanView(state, { runStatus: 'running' });
  assert.equal(skipped.progress.skipped, 1); assert.equal(skipped.byId.get('create-new').statusLabel, 'Skipped');
  const detail = renderPlanInspector(skipped, { selectedId: 'create-new' });
  assert.match(detail, /outside the completion count/); assert.match(detail, /Why skipped/); assert.match(detail, /existing implementation/);
});

test('a complete chosen route with unused pending alternatives is not a complete plan', () => {
  const state = { taskId: 'choice', plan: { origin: 'agent', layout: 'choice', selectedChildId: 'chosen' }, steps: [action('chosen', 'done'), action('other')], progress: { total: 1, done: 1, skipped: 0, current: null, eligible: ['chosen'], unresolvedBranches: 1, complete: false } };
  let view = taskPlanView(state, { runStatus: 'completed', settled: true });
  assert.equal(view.complete, false); assert.equal(view.phase, 'closing');
  assert.match(renderPlanHeader(view), /Closing unused paths/); assert.doesNotMatch(renderPlanHeader(view), /Plan complete/);
  state.steps[1].status = 'skipped'; state.steps[1].skipReason = 'Another path was chosen.';
  state.progress = { ...state.progress, skipped: 1, unresolvedBranches: 0, complete: true };
  view = taskPlanView(state, { runStatus: 'completed', settled: true });
  assert.deepEqual(view.progress, { total: 1, done: 1, skipped: 1 }); assert.equal(view.complete, true);
  assert.match(renderPlanHeader(view), /1 skipped/); assert.match(renderPlanHeader(view), /width:100%/);
});

test('all skipped actions and an empty root choice never fabricate a completed outcome', () => {
  const skipped = taskPlanView({ taskId: 'all-skipped', plan: { origin: 'agent' }, steps: [action('unused', 'skipped', null, { skipReason: 'The task is no longer needed.' })], progress: { total: 0, done: 0, skipped: 1, complete: false, unresolvedBranches: 0 } }, { runStatus: 'completed', settled: true });
  assert.equal(skipped.complete, false); assert.match(renderPlanHeader(skipped), /1 step skipped/); assert.doesNotMatch(renderPlanHeader(skipped), /Plan complete/);
  const choice = taskPlanView({ plan: { layout: 'choice' }, steps: [action('one'), action('two')] });
  assert.equal(choice.progress.total, 0); assert.equal(choice.complete, false); assert.equal(choice.rootChoicePending, true);
});

test('saved authoritative completion and readiness override tempting fraction or dependency shortcuts', () => {
  const view = taskPlanView({ plan: { origin: 'agent' }, steps: [action('first', 'done'), action('second')], progress: { total: 1, done: 1, skipped: 0, current: { id: 'second' }, eligible: ['first', 'second'], ready: [], complete: false, unresolvedBranches: 0 } }, { runStatus: 'completed', settled: true });
  assert.equal(view.complete, false); assert.equal(view.focus.id, 'second'); assert.equal(view.byId.get('second').statusLabel, 'Waiting');
});

test('a runtime scaffold carries an honest goal and no invented child steps or progress', () => {
  const view = taskPlanView({ taskId: 'new', goal: 'Inspect the supplied PDF.', planVersion: 1, plan: { origin: 'runtime' }, steps: [], progress: { total: 0, done: 0, skipped: 0, complete: false } }, { runStatus: 'running' });
  assert.equal(view.title, 'Inspect the supplied PDF.'); assert.equal(view.nodes.length, 0); assert.equal(view.phase, 'preparing'); assert.equal(view.complete, false);
  assert.match(renderPlanHeader(view), /Preparing the plan/); assert.doesNotMatch(renderPlanHeader(view), /0\s*<span> \/ 0/);
});

test('missing plans and unavailable planning are distinct from a provider still preparing work', () => {
  assert.equal(taskPlanView({ steps: [] }, { runStatus: 'running', planningStatus: 'missing' }).phase, 'missing');
  assert.equal(taskPlanView({ steps: [] }, { runStatus: 'running', planningAvailable: false }).phase, 'unavailable');
  assert.equal(taskPlanView({ steps: [] }, { runStatus: 'completed' }).phase, 'empty');
});

test('a settled response preserves unfinished legacy milestones and labels saved active work accurately', () => {
  const state = { taskId: 'old', steps: [{ id: 'read', title: 'Read the document', status: 'done' }, { id: 'write', title: 'Write the findings', status: 'active' }], progress: { total: 2, done: 1, current: { id: 'write' } } };
  const view = taskPlanView(state, { runStatus: 'completed', settled: true });
  assert.equal(view.complete, false); assert.equal(view.phase, 'paused'); assert.equal(view.byId.get('write').statusLabel, 'Paused here'); assert.equal(view.active.length, 1);
  assert.deepEqual(view.roots.map(node => node.id), ['read', 'write']); assert.equal(view.byId.get('write').kind, 'action');
});

test('a partially finished parallel group is not counted as an actually active leaf', () => {
  const view = taskPlanView({ plan: { origin: 'agent' }, steps: [group('paths', 'parallel', null, { status: 'active' }), action('a', 'done', 'paths'), action('b', 'pending', 'paths')] }, { runStatus: 'running' });
  assert.deepEqual(view.active, []); assert.equal(view.progress.total, 2); assert.match(renderPlanHeader(view), /In progress/); assert.doesNotMatch(renderPlanHeader(view), /2 steps in progress/);
});

test('balanced disclosure opens the actual current path without expanding every nested group', () => {
  const view = taskPlanView(nestedPlan(), { runStatus: 'running' }), session = reconcilePlanSession(view);
  assert.equal(session.selectedId, 'check-input'); assert.equal(session.collapsed.has('constraints'), false);
  assert.ok(visiblePlanNodes(view, session.collapsed).some(node => node.id === 'check-input'));
  const hidden = togglePlanBranch(view, session, 'constraints', false), next = reconcilePlanSession(view, hidden);
  assert.equal(next.collapsed.has('constraints'), true, 'an explicit collapse survives SSE updates');
  assert.equal(next.selectedId, 'constraints');
});

test('user inspection remains pinned when another parallel step becomes current', () => {
  const state = nestedPlan(); let view = taskPlanView(state, { runStatus: 'running' }), session = reconcilePlanSession(view);
  session = selectPlanStep(view, session, 'understand');
  state.plan.focusStepId = 'review-options'; state.steps[0].note = 'A new fact from the stream.';
  view = taskPlanView(state, { runStatus: 'running' }); session = reconcilePlanSession(view, session);
  assert.equal(session.selectedId, 'understand'); assert.equal(session.pinned, true);
  session = selectPlanStep(view, session, view.focus.id, { pinned: false });
  state.plan.focusStepId = 'check-output'; view = taskPlanView(state, { runStatus: 'running' });
  assert.equal(reconcilePlanSession(view, session).selectedId, 'check-output');
});

test('removed rows fall back to an existing focus and stale disclosure keys are pruned', () => {
  const state = nestedPlan(); let view = taskPlanView(state, { runStatus: 'running' }), session = selectPlanStep(view, reconcilePlanSession(view), 'review-options');
  session.collapsed.add('removed-group'); session.touched.add('removed-group');
  state.steps = state.steps.filter(step => step.id !== 'review-options'); view = taskPlanView(state, { runStatus: 'running' });
  session = reconcilePlanSession(view, session);
  assert.equal(session.selectedId, 'check-input'); assert.equal(session.collapsed.has('removed-group'), false); assert.equal(session.touched.has('removed-group'), false);
});

test('keyboard tree navigation expands, descends, collapses, and returns to parent without editing the plan', () => {
  const state = nestedPlan(), before = structuredClone(state), view = taskPlanView(state, { runStatus: 'running' });
  let session = selectPlanStep(view, reconcilePlanSession(view), 'investigate'); session = togglePlanBranch(view, session, 'investigate', false);
  let result = planKeyboard(view, session, 'ArrowRight'); session = result.session;
  assert.equal(session.collapsed.has('investigate'), false); assert.equal(result.focusId, 'investigate');
  session = planKeyboard(view, session, 'ArrowRight').session; assert.equal(session.selectedId, 'constraints');
  session = planKeyboard(view, session, 'ArrowRight').session; assert.equal(session.selectedId, 'check-input');
  session = planKeyboard(view, session, 'ArrowDown').session; assert.equal(session.selectedId, 'check-output');
  session = planKeyboard(view, session, 'ArrowLeft').session; assert.equal(session.selectedId, 'constraints');
  session = planKeyboard(view, session, 'ArrowLeft').session; assert.equal(session.collapsed.has('constraints'), true);
  session = planKeyboard(view, session, 'End').session; assert.equal(session.selectedId, 'verify');
  session = planKeyboard(view, session, 'Home').session; assert.equal(session.selectedId, 'understand');
  assert.equal(planKeyboard(view, session, 'Escape').handled, false); assert.deepEqual(state, before);
});

test('malformed historical parent cycles, duplicate IDs, and missing parents render deterministically without hiding steps', () => {
  const view = taskPlanView({ steps: [action('a', 'pending', 'b'), action('b', 'pending', 'a'), action('orphan', 'pending', 'missing'), action('a', 'done'), action('self', 'pending', 'self')] });
  assert.equal(view.nodes.length, 4); assert.equal(new Set(view.nodes.map(node => node.id)).size, 4); assert.equal(view.byId.get('orphan').parentId, null); assert.equal(view.byId.get('self').parentId, null);
  assert.equal(visiblePlanNodes(view).length, 4); assert.ok(planAncestors(view, 'b').length < 4);
});

test('step details escape agent content and link only registered files belonging to the task', () => {
  const source = { taskId: 'task/&value', goal: '<script>goal()</script>', plan: { origin: 'agent', method: { id: 'm', name: '<img src=x onerror=run()>', revision: 2 } }, steps: [action('write', 'done', null, { title: '<img src=x onerror=run()>', doneWhen: '<script>criterion()</script>', result: '<svg onload=run()>', evidence: 'actual & limited', artifactIds: ['known', 'invented'] })], artifacts: [{ id: 'known', title: '<b>Result</b>', fileName: 'result.pdf' }] };
  const view = taskPlanView(source), header = renderPlanHeader(view, { onMethod() {} }), detail = renderPlanInspector(view, { selectedId: 'write' }, { canGuide: true, onDraftDirection() {} });
  assert.doesNotMatch(header, /<script>|<img src=x/); assert.match(header, /&lt;script&gt;/); assert.doesNotMatch(detail, /<img src=x|<svg onload|criterion\(\)<\/script>/);
  assert.match(detail, /actual &amp; limited/); assert.match(detail, /\/api\/tasks\/task%2F%26value\/artifacts\/known\/preview/); assert.doesNotMatch(detail, /invented/);
  assert.match(detail, /Opens a draft/); assert.match(detail, /File bytes checked/); assert.doesNotMatch(detail, /independently verified/);
});

test('the inspector distinguishes a planned result from evidence before and after completion', () => {
  const expected = 'A checked report saved at report.txt', evidence = 'Read report.txt and matched its bytes to the checked report.';
  const source = { taskId: 'planned-outcome', goal: 'Save the report', plan: { origin: 'agent', detail: 'detailed' }, steps: [action('save', 'pending', null, { result: expected, doneWhen: 'The saved report is read and checked.', note: 'Write the report and inspect the saved bytes.' })] }, before = structuredClone(source);
  const pending = renderPlanInspector(taskPlanView(source, { planningMode: 'maximal', runStatus: 'running' }), { selectedId: 'save' });
  assert.match(pending, /<dt>Expected result<\/dt>/); assert.ok(pending.includes(expected));
  assert.doesNotMatch(pending, /<dt>(?:Result|Evidence)<\/dt>/); assert.equal(source.steps[0].evidence, undefined);
  const completed = { ...source, steps: [{ ...source.steps[0], status: 'done', evidence }] };
  const done = renderPlanInspector(taskPlanView(completed, { planningMode: 'maximal', runStatus: 'completed' }), { selectedId: 'save' });
  assert.match(done, /<dt>Expected result<\/dt>/); assert.ok(done.includes(expected));
  assert.match(done, /<dt>Evidence<\/dt>/); assert.ok(done.includes(evidence)); assert.doesNotMatch(done, /<dt>Result<\/dt>/);
  assert.deepEqual(source, before); assert.equal(completed.steps[0].result, expected);
});


test('a long compact heading always has a keyboard-readable full goal with the complete original text', () => {
  const goal = 'Build and check the requested result with parallel preparation and a carefully selected delivery path.\nKeep every supplied constraint, including <literal> details.';
  const html = renderPlanHeader(taskPlanView({ taskId: 'long-goal', goal, steps: [] }));
  assert.match(html, /data-plan-disclosure="goal"/); assert.match(html, /Full task/);
  assert.match(html, /class="task-plan-goal-text" tabindex="0" role="region" aria-label="Full task"/);
  assert.ok(html.includes(goal.replace('<literal>', '&lt;literal&gt;'))); assert.ok(!html.includes('<literal>'));
});
