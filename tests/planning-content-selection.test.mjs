import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluateUserCostDecision } from '../public/user-cost-decision.mjs';
import { CONTENT_SELECTION_SCHEMA, normalizeContentSelection, decisionInputSha256, resolveSavedDecisionContent, assertPlannedContentSelection } from '../lib/planning-content-selection.mjs';
import { normalizePlanningOperation } from '../lib/task-plan.mjs';
import { TaskStateStore, createTaskToolHandler, TASK_TOOL, TASK_TOOL_V9, TASK_TOOL_V10, TASK_TOOL_V11, TASK_TOOL_V12 } from '../lib/task-state.mjs';
import { createPlanningWorkerGuard, wrapPlanningToolHandler } from '../lib/planning-awareness.mjs';
import { projectNativeTaskResult } from '../lib/task-tool-view.mjs';

const cost = value => ({ value, basis: 'Synthetic cost for exercising the selector, not a measured content benefit.' });
const comparison = (texts = ['Exact fixture wording.\nSecond line: α / ~.', 'Alternative fixture wording.']) => ({
  decision: 'Choose between two literal synthetic outputs.', assumptions: ['Synthetic inputs test identity and arithmetic, not semantic relevance.'], hardConstraints: [],
  options: texts.map((outcome, index) => ({ id: index ? 'alternative' : 'preferred', action: 'proceed', reversibility: 'reversible', outcome,
    risks: [], delayCost: cost(0), interruptionCost: cost(0), opportunityCost: cost(index ? 2 : 0) })),
});
const assessment = (input = comparison(), selectedOptionId = null) => ({ id: 'wording', input, selectedOptionId, evaluation: evaluateUserCostDecision(input), updatedAt: '2026-01-01T00:00:00.000Z' });
const selection = (input = comparison(), argumentPointer = '/text') => ({ decisionId: 'wording', inputSha256: decisionInputSha256(input), argumentPointer });
const operation = contentSelection => ({ kind: 'tool', tool: 'relay_browser', action: 'fill', target: 'The observed fixture field', ...(contentSelection ? { contentSelection } : {}) });
const body = receipt => JSON.parse(receipt.contentItems[0].text);
const success = () => ({ success: true, contentItems: [{ type: 'inputText', text: '{"fixtureResult":"observed"}' }] });

test('saved content selection recalculates raw inputs, preserves exact text and detects changed evidence', () => {
  const input = comparison(), item = assessment(input), state = { decisionAssessments: [item] }, binding = selection(input);
  item.evaluation = { status: 'evaluated', recommendedOptionId: 'alternative', preferredAction: 'proceed' };
  assert.equal(resolveSavedDecisionContent(state, binding).text, input.options[0].outcome, 'Forged cached totals do not choose the content.');
  const reversed = Object.fromEntries(Object.entries(input).reverse());
  assert.equal(decisionInputSha256(reversed), binding.inputSha256, 'Object key order does not invalidate the adopted inputs.');
  item.input.options[0].opportunityCost.value = 5;
  assert.throws(() => resolveSavedDecisionContent(state, binding), { code: 'TASK_PLAN_CONTENT_SELECTION_STALE' });
  assert.equal(resolveSavedDecisionContent(state, selection(input)).text, input.options[1].outcome);
  assert.throws(() => resolveSavedDecisionContent({ decisionAssessments: [] }, binding), { code: 'TASK_PLAN_CONTENT_SELECTION_MISSING' });
});

test('unknown estimates, ineligible choices and non-proceed results cannot become bound content', () => {
  const input = comparison(); input.options[0].delayCost.value = null;
  assert.throws(() => resolveSavedDecisionContent({ decisionAssessments: [assessment(input)] }, selection(input)), { code: 'TASK_PLAN_CONTENT_SELECTION_UNRESOLVED' });
  const deferred = comparison(); deferred.options[0].action = 'defer';
  assert.throws(() => resolveSavedDecisionContent({ decisionAssessments: [assessment(deferred)] }, selection(deferred)), { code: 'TASK_PLAN_CONTENT_SELECTION_UNRESOLVED' });
  const excluded = comparison();
  excluded.hardConstraints = [{ id: 'synthetic', kind: 'user_constraint', rule: 'Synthetic fixture excludes both choices.', source: 'This test only.', observedViolation: 'Both synthetic choices are excluded.', blockedOptionIds: ['preferred', 'alternative'] }];
  assert.throws(() => resolveSavedDecisionContent({ decisionAssessments: [assessment(excluded)] }, selection(excluded)), { code: 'TASK_PLAN_CONTENT_SELECTION_UNRESOLVED' });
  assert.throws(() => resolveSavedDecisionContent({ decisionAssessments: [assessment(comparison(), 'alternative')] }, selection()), error => Boolean(error.code));
});

test('argument pointers inspect only own data properties and never rewrite or normalize outgoing strings', () => {
  const input = comparison(), state = { decisionAssessments: [assessment(input)] }, binding = selection(input, '/body/parts/0/a~1b~0c');
  const args = { body: { parts: [{ 'a/b~c': input.options[0].outcome }] } }, before = structuredClone(args);
  assert.equal(assertPlannedContentSelection(state, operation(binding), args).text, input.options[0].outcome);
  assert.deepEqual(args, before);
  args.body.parts[0]['a/b~c'] += ' Unselected addition.';
  assert.throws(() => assertPlannedContentSelection(state, operation(binding), args), { code: 'TASK_PLAN_CONTENT_SELECTION_MISMATCH' });
  assert.equal(args.body.parts[0]['a/b~c'], before.body.parts[0]['a/b~c'] + ' Unselected addition.');
  assert.throws(() => assertPlannedContentSelection(state, operation(selection(input)), Object.create({ text: input.options[0].outcome })), { code: 'TASK_PLAN_CONTENT_SELECTION_MISMATCH' });
  let accessed = 0;
  const accessor = Object.defineProperty({}, 'text', { get() { accessed++; return input.options[0].outcome; } });
  assert.throws(() => assertPlannedContentSelection(state, operation(selection(input)), accessor), { code: 'TASK_PLAN_CONTENT_SELECTION_MISMATCH' });
  assert.equal(accessed, 0);
  for (const argumentPointer of ['', 'text', '/text~2', '/__proto__/text', '/body/constructor', '/a'.repeat(13)])
    assert.throws(() => normalizeContentSelection({ ...binding, argumentPointer }), { code: 'INVALID_CONTENT_SELECTION' });
  assert.equal(assertPlannedContentSelection({}, operation(), { text: 'Unbound ordinary content.' }), null);
});

test('only current tool-operation schemas expose the optional binding; old operations stay unchanged', () => {
  assert.deepEqual(normalizePlanningOperation(operation()), operation());
  assert.deepEqual(normalizePlanningOperation(operation(selection())), operation(selection()));
  assert.throws(() => normalizePlanningOperation({ kind: 'reasoning', target: 'One analysis.', contentSelection: selection() }));
  assert.throws(() => normalizePlanningOperation({ ...operation(selection()), tool: 'relay_task' }));
  const toolBranch = tool => tool.inputSchema.properties.steps.items.properties.operation.anyOf.find(branch => branch.properties.kind.const === 'tool');
  assert.deepEqual(toolBranch(TASK_TOOL).properties.contentSelection, CONTENT_SELECTION_SCHEMA);
  for (const tool of [TASK_TOOL_V9, TASK_TOOL_V10, TASK_TOOL_V11, TASK_TOOL_V12]) assert.equal(toolBranch(tool).properties.contentSelection, undefined);
});

async function fixture(t, { bound = true, executionGuardrails = true } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-content-selection-')), cwd = path.join(directory, 'work'); await mkdir(cwd);
  const store = await new TaskStateStore({ dataDir: directory }).init(), taskId = 'selected-content', runId = 'run', nodeId = 'agent';
  let state = await store.ensure({ taskId, runId, cwd, goal: 'Deliver one selected synthetic text.', defaultPlan: true });
  state = await store.setPlan(taskId, { plan: { layout: 'sequence' }, steps: [{ id: 'deliver', kind: 'action', title: 'Fill the observed fixture field', status: 'active',
    result: 'The selected fixture text is entered.', note: 'Fill the named observed field with the selected literal text.', doneWhen: 'The fixture records the exact text supplied.', operation: operation() }] },
  { expectedRevision: state.revision, schemaVersion: 13, runId, nodeId });
  const input = comparison();
  if (bound) state = await store.editPlan(taskId, { operations: [
    { type: 'assess_decision', decisionId: 'wording', input },
    { type: 'update', stepId: 'deliver', patch: { operation: operation(selection(input)) } },
  ] }, { expectedRevision: state.revision, schemaVersion: 13, runId, nodeId });
  const guard = await createPlanningWorkerGuard({ store, taskId, runId, nodeId, schemaVersion: 13, executionGuardrails, sequentialEnabled: true });
  const taskHandler = createTaskToolHandler({ store, taskId, runId, nodeId, schemaVersion: 13, executionGuardrails });
  const calls = [];
  const dispatch = wrapPlanningToolHandler(guard, async (call, context) => {
    const denied = await guard.before(call, context); if (denied) return denied;
    if (call.name === 'relay_task') return guard.after(call, await taskHandler(call, context));
    calls.push(structuredClone(call)); return success();
  });
  const task = async arguments_ => { const receipt = await dispatch({ name: 'relay_task', arguments: arguments_ }); assert.equal(receipt.success, true, receipt.contentItems[0].text); return body(receipt); };
  t.after(async () => { guard.finish('completed'); await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, state, taskId, runId, nodeId, input, calls, dispatch, task };
}
const fill = text => ({ name: 'relay_browser', arguments: { action: 'fill', browser: 'relay', tabId: 'observed-fixture', ref: 'observed-field', text } });

test('enforced native dispatch rejects unselected text before reservation, retains auxiliary reads and sends the exact selection once', async t => {
  const f = await fixture(t), before = await readFile(f.store.file(f.taskId), 'utf8');
  assert.equal((await f.dispatch(fill('Different unselected wording.'))).code, 'TASK_PLAN_CONTENT_SELECTION_MISMATCH');
  assert.equal(f.calls.length, 0);
  assert.equal(await readFile(f.store.file(f.taskId), 'utf8'), before);
  await assert.rejects(readFile(f.store.file(f.taskId) + '.sequence'), { code: 'ENOENT' });
  assert.equal((await f.dispatch({ name: 'relay_workspace', arguments: { action: 'write', text: f.input.options[0].outcome } })).code, 'TASK_PLAN_OPERATION_MISMATCH', 'Correct text grants no unrelated tool authority.');
  assert.equal((await f.dispatch({ name: 'relay_browser', arguments: { action: 'snapshot', tabId: 'observed-fixture' } })).success, true, 'A needed auxiliary observation is not a content dispatch.');
  assert.equal((await f.dispatch(fill(f.input.options[0].outcome))).success, true);
  assert.equal(f.calls.filter(call => call.arguments.action === 'fill').length, 1);
  assert.equal(f.calls.at(-1).arguments.text, f.input.options[0].outcome);
  assert.equal((await f.dispatch(fill(f.input.options[0].outcome))).code, 'TASK_PLAN_RESULT_REQUIRED');
  assert.equal(f.calls.filter(call => call.arguments.action === 'fill').length, 1);
});

test('changing decision inputs requires explicit adoption before the next bound dispatch', async t => {
  const f = await fixture(t), input = structuredClone(f.input); input.options[0].opportunityCost.value = 5;
  let state = await f.task({ action: 'read' });
  state = await f.task({ action: 'edit', expectedRevision: state.revision, operations: [{ type: 'assess_decision', decisionId: 'wording', input }] });
  assert.equal((await f.dispatch(fill(input.options[1].outcome))).code, 'TASK_PLAN_CONTENT_SELECTION_STALE');
  assert.equal(f.calls.length, 0);
  state = await f.task({ action: 'edit', expectedRevision: state.revision, operations: [{ type: 'update', stepId: 'deliver', patch: { operation: operation(selection(input)) } }] });
  assert.equal((await f.dispatch(fill(input.options[1].outcome))).success, true);
  const reopened = await new TaskStateStore({ dataDir: f.directory }).init();
  try { assert.equal(resolveSavedDecisionContent(await reopened.get(f.taskId), selection(input)).text, input.options[1].outcome); }
  finally { await reopened.close(); }
});

test('unbound work and advisory mode retain their existing dispatch behavior', async t => {
  for (const options of [{ bound: false }, { bound: true, executionGuardrails: false }]) {
    const f = await fixture(t, options);
    assert.equal((await f.dispatch(fill('Ordinary independently authored wording.'))).success, true);
    assert.equal(f.calls.length, 1);
  }
});

test('old task catalogs cannot silently adopt a field they do not expose', async t => {
  const f = await fixture(t, { bound: false }), state = await f.store.get(f.taskId);
  const old = createTaskToolHandler({ store: f.store, taskId: f.taskId, runId: f.runId, nodeId: f.nodeId, schemaVersion: 12 });
  const result = await old({ name: 'relay_task', arguments: { action: 'edit', expectedRevision: state.revision,
    operations: [{ type: 'update', stepId: 'deliver', patch: { operation: operation(selection()) } }] } });
  assert.equal(result.code, 'TASK_SCHEMA_UNSUPPORTED');
  assert.equal((await f.store.get(f.taskId)).revision, state.revision);
});

test('compact assessments expose exact outcomes or a pinned retrieval without truncating their text', async t => {
  const f = await fixture(t), texts = ['α'.repeat(2300), 'β'.repeat(2300)], input = comparison(texts);
  let state = await f.store.editPlan(f.taskId, { operations: [{ type: 'assess_decision', decisionId: 'wording', input, selectedOptionId: 'preferred' }] }, { expectedRevision: f.state.revision, source: 'human' });
  const receipt = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(state) }] };
  const args = { action: 'edit', operations: [{ type: 'assess_decision', decisionId: 'wording' }] };
  const full = body(projectNativeTaskResult(receipt, args));
  assert.equal(full.userCostDecisions.items[0].recommendedOutcome, texts[0]);
  assert.equal(full.userCostDecisions.items[0].selectedOutcome, texts[0]);
  assert.equal(full.userCostDecisions.items[0].inputSha256, decisionInputSha256(input));
  const small = body(projectNativeTaskResult(receipt, args, { maxBytes: 6500 })), summary = small.userCostDecisions.items[0];
  assert.equal(summary.outcomesOmitted, true);
  assert.equal(Object.hasOwn(summary, 'recommendedOutcome'), false);
  assert.equal(Object.hasOwn(summary, 'selectedOutcome'), false);
  assert.equal(summary.outcomesRead.expectedRevision, state.revision);
  let next = summary.outcomesRead, text = '';
  while (next) { const page = body(projectNativeTaskResult(receipt, next, { maxBytes: 6500 })); text += page.text; next = page.nextRead; }
  const restored = JSON.parse(text);
  assert.equal(restored.decisionAssessments[0].input.options[0].outcome, texts[0]);
  assert.equal(restored.decisionAssessments[0].input.options[1].outcome, texts[1]);
});
