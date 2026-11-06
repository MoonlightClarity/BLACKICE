import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatGPTPlanningAPI } from '../lib/chatgpt-planning.mjs';
import { RemoteAgentAPI, validRemoteArguments } from '../lib/remote-agent-api.mjs';
import { TaskStateStore, TASK_TOOL_V13 as TASK_TOOL, TASK_TOOL_V10, TASK_TOOL_V11, TASK_TOOL_V12 } from '../lib/task-state.mjs';
import { listPlanningWorkspace } from '../lib/planning-workspace.mjs';
import { projectNativeTaskResult, TASK_TOOL_VIEW_LIMITS } from '../lib/task-tool-view.mjs';

const client = { id: 'external-chatgpt', label: 'External ChatGPT', kind: 'agent', scopes: ['read', 'planning:write'] };
const cost = (value, basis = 'Illustrative minute-equivalent user-loss estimate, not a measurement.') => ({ value, basis });
const risk = (probability, severity) => ({
  id: 'correctable_error', probability, severity,
  probabilityBasis: { kind: probability === null ? 'unknown' : 'assumption', rationale: 'A labeled subjective estimate for the concrete action, not a category-wide risk rate.' },
  severityBasis: { anchor: severity <= 5 ? 'brief_rework' : 'substantial_rework', consequence: 'Correct and verify this affected item.', conversionBasis: String(severity) + ' equivalent minutes conditional on this event.' },
});
function comparison(probability = 0.01, severity = 5) {
  const option = (id, risks, friction) => ({
    id, action: id, reversibility: 'reversible', outcome: 'Complete the authorized work with the indicated residual user cost.', risks,
    delayCost: cost(0), interruptionCost: cost(id === 'ask' ? friction : 0),
    opportunityCost: cost(id === 'defer' ? friction : 0),
    ...(id === 'ask' ? { clarification: { baselineOptionId: 'proceed', informationNeeded: 'The user choice that determines the final branch.', howAnswerChangesAction: 'The answer selects the correct branch before the consequential step.', residualRiskBasis: 'The answer resolves this specific uncertainty; no unlisted risk is assumed away.' } } : {}),
  });
  return {
    decision: 'Proceed, ask or defer this concrete authorized action?',
    assumptions: ['All probabilities and minute-equivalent costs here are illustrative subjective planning estimates.'],
    hardConstraints: [],
    options: [option('proceed', [risk(probability, severity)], 0), option('ask', [], 2), option('defer', [], 4)],
  };
}
const leaf = (id = 'work', parentId = 'root') => ({
  id, parentId, kind: 'action', title: 'Inspect the concrete item',
  note: 'Use the available evidence to resolve one bounded question.',
  result: 'A grounded finding that advances the user goal.',
  doneWhen: 'The relevant observed evidence and its implication are recorded.',
  operation: { kind: 'reasoning', target: 'Which available evidence resolves this concrete item?' },
});
const createArgs = (taskId = 'external-plan') => ({
  taskId, expectedRevision: 0,
  operations: [{ type: 'create', goal: 'Advance the user outcome without unnecessary disclosure or interruption.', plan: { layout: 'sequence', detail: 'balanced' }, steps: [{ id: 'root', title: 'User-directed work', kind: 'sequence', parentId: null }, leaf()] }],
});
const checkpoint = (input = comparison(), selectedOptionId = 'proceed') => ({
  version: 1, audience: 'internal', userBenefit: 'Advance the authorized user goal with proportionate costs.',
  representation: { actualQuestion: 'Choose the next authorized action.', requiredFacts: [], relevantClaims: [], privateFindings: ['The possible mistake is small and correctable.'], userReport: ['Report completed work and any material remaining uncertainty.'] },
  action: selectedOptionId, decisionRequired: true, decisionReason: 'Compare proceeding against a user interruption using all three costed options.',
  decisions: [{ id: 'next-action', input, selectedOptionId }], chosenDecisionId: 'next-action',
});
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-external-plan-'));
  const tasks = await new TaskStateStore({ dataDir: directory }).init();
  const events = [], history = [];
  const engine = {
    runs: new Map(), defaultCwd: directory, listRuns: () => [],
    startRun: () => { throw Error('Planning documents must not start models.'); },
    continueRun: () => { throw Error('Planning documents must not resume models.'); },
    adoptTaskState: () => { throw Error('No worker exists for this standalone plan.'); },
  };
  const conversations = { list: () => structuredClone(history), status: () => ({ healthy: true }) };
  const context = { tasks, engine, conversations, onUpdated: event => events.push(event) };
  const api = new ChatGPTPlanningAPI(context);
  t.after(async () => { await tasks.close(); await rm(directory, { recursive: true, force: true }); });
  return { ...context, api, directory, events, history };
}

test('an existing external edit tool creates a durable standalone plan, discovers it in the desktop workspace and never starts a model', async t => {
  const f = await fixture(t), created = await f.api.call('blackice_edit_plan', createArgs(), client);
  assert.equal(created.revision, 1);
  assert.equal(created.provenance.source, 'external-agent');
  assert.equal(created.provenance.actor.id, client.id);
  assert.equal(created.standalonePlan.kind, 'standalone');
  assert.equal(created.standalonePlan.createdBy.actor.id, client.id);
  assert.equal(created.cwd, f.directory);
  assert.equal(created.execution, undefined);
  assert.equal(f.engine.runs.size, 0);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].data.created, true);
  const workspace = await listPlanningWorkspace(f, {});
  assert.equal(workspace.plans[0].taskId, created.taskId);
  assert.equal(workspace.plans[0].documentKind, 'standalone');
  assert.equal(workspace.plans[0].runId, null);
  assert.equal(workspace.plans[0].conversationTitle, null);
  assert.equal(workspace.plans[0].editable, true);
  const saved = JSON.parse(await readFile(path.join(f.directory, 'task-state', 'external-plan.json'), 'utf8'));
  assert.equal(saved.history[0].standalonePlan.createdBy.actor.type, 'external-agent');
  const reopened = await new TaskStateStore({ dataDir: f.directory }).init();
  try {
    const api = new ChatGPTPlanningAPI({ ...f, tasks: reopened });
    assert.equal((await api.call('blackice_get_plan', { taskId: created.taskId }, client)).revision, 1);
    const list = await api.call('blackice_list_plans', {}, client);
    assert.equal(list.plans[0].taskId, created.taskId);
    assert.equal(list.planningContract.modelExecution, false);
    assert.ok(list.planningContract.decisionInputSchema);
    assert.match(list.planningContract.guidance, /user/i);
  } finally { await reopened.close(); }
});

test('external numeric assessment chooses inexpensive progress, persists it, and changes only with revised concrete evidence', async t => {
  const f = await fixture(t);
  let state = await f.api.call('blackice_edit_plan', createArgs(), client);
  const edit = operations => f.api.call('blackice_edit_plan', { taskId: state.taskId, expectedRevision: state.revision, operations }, client);
  state = await edit([{ type: 'assess_decision', decisionId: 'next-action', input: comparison(), selectedOptionId: 'proceed' }]);
  let assessment = state.decisionAssessments[0];
  assert.equal(assessment.evaluation.recommendedOptionId, 'proceed');
  assert.equal(assessment.evaluation.recommendedCost, 0.05);
  assert.equal(assessment.evaluation.comparableCosts.find(item => item.optionId === 'ask').totalCost, 2);
  assert.equal(assessment.author.actor.id, client.id);
  state = await edit([{ type: 'update', stepId: 'work', patch: { title: 'Clarified work title' } }]);
  assert.deepEqual(state.decisionAssessments[0], assessment, 'ordinary graph editing preserves the computed decision');
  const previous = state.revision;
  await assert.rejects(edit([{ type: 'metadata', patch: { goal: 'Must remain atomic.' } }, { type: 'assess_decision', decisionId: 'next-action', input: comparison(), selectedOptionId: 'ask' }]), { code: 'USER_COST_RECALCULATION_REQUIRED' });
  assert.equal((await f.tasks.get(state.taskId)).revision, previous);
  assert.equal((await f.tasks.get(state.taskId)).goal, state.goal);
  state = await edit([{ type: 'assess_decision', decisionId: 'next-action', input: comparison(0.4, 100), selectedOptionId: 'ask' }]);
  assessment = state.decisionAssessments[0];
  assert.equal(assessment.evaluation.recommendedOptionId, 'ask');
  assert.equal(assessment.evaluation.recommendedCost, 2);
  assert.equal(assessment.evaluation.comparableCosts.find(item => item.optionId === 'proceed').totalCost, 40);
  const read = await f.api.call('blackice_get_plan', { taskId: state.taskId }, client);
  assert.deepEqual(read.decisionAssessments, state.decisionAssessments);
  assert.equal(read.provenance.source, 'external-agent');
  assert.equal(f.engine.runs.size, 0);
  const history = await f.tasks.history(state.taskId);
  assert.ok(history.some(item => item.decisionAssessments?.[0]?.evaluation.recommendedOptionId === 'proceed'), 'prior evidence and recommendation remain in task history');
});

test('nullable numeric estimates pass the actual connector schema and never silently choose an interruption', async t => {
  const f = await fixture(t), created = await f.api.call('blackice_edit_plan', createArgs(), client);
  const args = { taskId: created.taskId, expectedRevision: created.revision, operations: [{ type: 'assess_decision', decisionId: 'unknown', input: comparison(null), selectedOptionId: null }] };
  const spec = f.api.tools(client).find(tool => tool.name === 'blackice_edit_plan').inputSchema;
  assert.equal(validRemoteArguments(args, spec), true);
  const state = await f.api.call('blackice_edit_plan', args, client), evaluation = state.decisionAssessments[0].evaluation;
  assert.equal(evaluation.status, 'needs_estimates');
  assert.equal(evaluation.preferredAction, null);
  assert.equal(evaluation.escalationJustified, false);
  assert.match(evaluation.internalNextStep, /continue_other_authorized_work/);
  const forged = { ...args, expectedRevision: state.revision, operations: [{ ...args.operations[0], evaluation: { recommendedOptionId: 'ask' } }] };
  await assert.rejects(f.api.call('blackice_edit_plan', forged, client), { code: 'CHATGPT_ARGUMENTS_INVALID' });
  await assert.rejects(f.api.call('blackice_edit_plan', { ...args, expectedRevision: state.revision, operations: [{ ...args.operations[0], selectedOptionId: 'ask' }] }, client), { code: 'USER_COST_RECALCULATION_REQUIRED' });
});

test('a shared typed user-agency checkpoint is recomputed and retained through external recursive edits', async t => {
  const f = await fixture(t), args = createArgs();
  args.operations[0].userAgency = checkpoint();
  let state = await f.api.call('blackice_edit_plan', args, client);
  assert.equal(state.userAgency.action, 'proceed');
  assert.equal(state.userAgencyEvaluation.preferredAction, 'proceed');
  state = await f.api.call('blackice_edit_plan', {
    taskId: state.taskId, expectedRevision: state.revision, operations: [
      { type: 'add', step: { id: 'nested', title: 'Nested work', kind: 'sequence', parentId: 'root' } },
      { type: 'move', stepId: 'work', parentId: 'nested' },
      { type: 'add', step: leaf('verify', 'nested') },
      { type: 'dependencies', stepId: 'verify', dependsOn: ['work'] },
    ],
  }, client);
  assert.equal(state.steps.find(step => step.id === 'work').parentId, 'nested');
  assert.deepEqual(state.steps.find(step => step.id === 'verify').dependsOn, ['work']);
  assert.equal(state.userAgencyEvaluation.preferredAction, 'proceed');
  state = await f.api.call('blackice_edit_plan', { taskId: state.taskId, expectedRevision: state.revision, operations: [{ type: 'agency_checkpoint', userAgency: checkpoint(comparison(0.4, 100), 'ask') }] }, client);
  assert.equal(state.userAgencyEvaluation.preferredAction, 'ask');
  const invalid = checkpoint(comparison(), 'ask');
  await assert.rejects(f.api.call('blackice_edit_plan', { taskId: state.taskId, expectedRevision: state.revision, operations: [{ type: 'agency_checkpoint', userAgency: invalid }] }, client), error => /USER_COST|USER_AGENCY/.test(error.code));
  assert.equal((await f.tasks.get(state.taskId)).revision, state.revision);
});

test('creation is explicit, scoped, atomic and optimistic; retries cannot overwrite any saved plan', async t => {
  const f = await fixture(t), args = createArgs();
  await assert.rejects(f.api.call('blackice_edit_plan', args, { ...client, scopes: ['read'] }), { code: 'CHATGPT_SCOPE_REQUIRED' });
  await assert.rejects(f.tasks.get(args.taskId), { code: 'TASK_STATE_MISSING' });
  const broken = createArgs(); broken.operations[0].steps[1].parentId = 'missing-parent';
  await assert.rejects(f.api.call('blackice_edit_plan', broken, client));
  await assert.rejects(f.tasks.get(args.taskId), { code: 'TASK_STATE_MISSING' });
  await assert.rejects(f.api.call('blackice_edit_plan', { ...args, operations: [...args.operations, { type: 'metadata', patch: { goal: 'Mixed creation' } }] }, client), { code: 'PLANNING_REQUEST_INVALID' });
  await assert.rejects(f.api.call('blackice_edit_plan', { ...args, expectedRevision: 1 }, client), { code: 'PLANNING_REQUEST_INVALID' });
  const outcomes = await Promise.allSettled([f.api.call('blackice_edit_plan', args, client), f.api.call('blackice_edit_plan', args, client)]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(item => item.status === 'rejected').reason.code, 'TASK_STATE_CONFLICT');
  const saved = await f.tasks.get(args.taskId);
  assert.equal(saved.revision, 1);
  await assert.rejects(f.api.call('blackice_edit_plan', args, client), error => error.code === 'TASK_STATE_CONFLICT' && error.currentRevision === saved.revision);
  await assert.rejects(f.api.call('blackice_edit_plan', { taskId: saved.taskId, expectedRevision: 0, operations: [{ type: 'update', stepId: 'work', patch: { title: 'Implicit create is forbidden' } }] }, client), { code: 'PLANNING_REQUEST_INVALID' });
  const edited = await f.api.call('blackice_edit_plan', { taskId: saved.taskId, expectedRevision: saved.revision, operations: [{ type: 'update', stepId: 'work', patch: { title: 'One intended change' } }] }, client);
  await assert.rejects(f.api.call('blackice_edit_plan', { taskId: saved.taskId, expectedRevision: saved.revision, operations: [{ type: 'update', stepId: 'work', patch: { title: 'Stale overwrite' } }] }, client), error => error.code === 'TASK_STATE_CONFLICT' && error.currentRevision === edited.revision);
  assert.equal((await f.tasks.get(saved.taskId)).steps.find(step => step.id === 'work').title, 'One intended change');
});

test('a standalone document cannot resurrect an archived chat identity or bypass Trash visibility', async t => {
  const f = await fixture(t);
  f.history.push({ id: 'existing-chat', taskId: 'existing-chat', title: 'Saved chat', state: 'deleted' });
  await assert.rejects(f.api.call('blackice_edit_plan', createArgs('existing-chat'), client), { code: 'TASK_STATE_CONFLICT' });
  const state = await f.api.call('blackice_edit_plan', createArgs(), client);
  f.history.push({ id: state.taskId, taskId: state.taskId, title: 'Now a saved chat', state: 'deleted' });
  await assert.rejects(f.api.call('blackice_get_plan', { taskId: state.taskId }, client), { code: 'CHATGPT_PLAN_UNAVAILABLE' });
  assert.equal((await f.api.call('blackice_list_plans', {}, client)).plans.length, 0);
});

test('the A2A surface shares the same external document lifecycle and actor without worker dispatch', async t => {
  const f = await fixture(t), api = new RemoteAgentAPI({ ...f, defaultCwd: f.directory });
  let state = await api.call('blackice_edit_plan', createArgs('a2a-plan'), client);
  assert.equal(state.provenance.source, 'external-agent');
  state = await api.call('blackice_edit_plan', { taskId: state.taskId, expectedRevision: state.revision, operations: [{ type: 'assess_decision', decisionId: 'next', input: comparison() }] }, client);
  assert.equal((await api.call('blackice_get_task', { taskId: state.taskId }, client)).decisionAssessments[0].evaluation.preferredAction, 'proceed');
  assert.equal((await api.call('blackice_list_tasks', {}, client)).plans[0].taskId, state.taskId);
  assert.equal(f.engine.runs.size, 0);
});

test('bounded native replies expose authoritative decision costs and link complete saved evidence', async t => {
  const f = await fixture(t), created = await f.api.call('blackice_edit_plan', createArgs(), client);
  const args = { action: 'edit', expectedRevision: created.revision, operations: [{ type: 'assess_decision', decisionId: 'native-choice', input: comparison(), selectedOptionId: 'proceed' }] };
  const state = await f.tasks.editPlan(created.taskId, { operations: args.operations }, { source: 'agent', schemaVersion: 13, expectedRevision: created.revision });
  const receipt = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(state) }] };
  const native = projectNativeTaskResult(receipt, args), body = JSON.parse(native.contentItems[0].text);
  assert.equal(body.userCostDecisions.items[0].recommendedOptionId, 'proceed');
  assert.equal(body.userCostDecisions.items[0].recommendedCost, 0.05);
  assert.equal(body.userCostDecisions.items[0].options.find(option => option.id === 'ask').totalCost, 2);
  assert.equal(body.userCostDecisions.read.expectedRevision, state.revision);
  assert.equal(body.userCostDecisions.read.view, 'full');
  assert.ok(body.view.omittedSections.includes('decisionAssessments.inputs_evidence_and_calibration'));
  assert.ok(Buffer.byteLength(JSON.stringify(native)) <= TASK_TOOL_VIEW_LIMITS.replyBytes);
  assert.deepEqual((await f.tasks.get(state.taskId)).decisionAssessments[0].input, comparison());
});

test('oversized decision input is rejected before any graph edit is committed', async t => {
  const f = await fixture(t), state = await f.api.call('blackice_edit_plan', createArgs(), client);
  const input = comparison();
  input.assumptions = Array.from({ length: 20 }, () => 'Assumption. '.repeat(190));
  const args = { taskId: state.taskId, expectedRevision: state.revision, operations: [{ type: 'update', stepId: 'work', patch: { title: 'Never committed' } }, { type: 'assess_decision', decisionId: 'oversized', input }] };
  assert.equal(validRemoteArguments(args, f.api.tools(client).find(tool => tool.name === 'blackice_edit_plan').inputSchema), true);
  await assert.rejects(f.api.call('blackice_edit_plan', args, client), { code: 'PLANNING_DECISION_LIMIT' });
  assert.equal((await f.tasks.get(state.taskId)).revision, state.revision);
  assert.equal((await f.tasks.get(state.taskId)).steps.find(step => step.id === 'work').title, 'Inspect the concrete item');
});

test('only the current native task catalog exposes the new review checkpoint', () => {
  assert.ok(TASK_TOOL.inputSchema.properties.review.properties.userAgency);
  assert.equal(TASK_TOOL_V10.inputSchema.properties.review.properties.userAgency, undefined);
  assert.equal(TASK_TOOL_V11.inputSchema.properties.review.properties.userAgency, undefined);
  assert.equal(TASK_TOOL_V12.inputSchema.properties.review.properties.userAgency, undefined);
});
