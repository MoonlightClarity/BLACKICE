import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizePlanContract, validatePlanContractFeasibility, contractPlanProjection } from '../public/planning-contract-model.mjs';
import { PlanningBrowserStore } from '../lib/planning-browser.mjs';
import { validatePlanningModuleResponse } from '../lib/planning-browser-runtime.mjs';
import { TaskStateStore } from '../lib/task-state.mjs';
import { planningModuleTemplate, planningResponseBody } from '../public/planning-browser-model.mjs';
import { RESPONSE_CYCLE_STAGES, responseCycleStage } from '../public/response-cycle-model.mjs';
import { fixtureUserAgency } from './fixture-user-agency.mjs';

const draft = (targetCount = 2, count = 1, kind = 'judgment') => ({
  contractVersion: 2, goal: 'Review the supplied catalog and enrollment history.',
  criteria: [{ id: 'catalog-reviewed', kind, description: 'The supplied catalog and history support the requested review.',
    resourceKey: 'origin:https://fixture.test', ...(targetCount === undefined ? {} : { targetCount }) }],
  workItems: Array.from({ length: count }, (_, i) => ({ id: 'review-' + (i + 1), title: 'Review the supplied records',
    objective: 'Inspect the supplied evidence and assess the review criterion.', owner: 'agent',
    resourceKeys: ['origin:https://fixture.test'], effects: ['observe'], dependsOn: [], criterionIds: ['catalog-reviewed'] })),
  instructions: [],
});
const impossible = error => error.code === 'TASK_CONTRACT_INVALID' && /catalog-reviewed.*2 assessments.*1 work item/.test(error.message);
const sourceDraft = (targetCount = 1, resourceKey = 'path:/fixture/catalog.txt') => {
  const value = draft(targetCount, 1, 'source-coverage');
  value.criteria[0].description = 'Read the complete current catalog source.';
  value.criteria[0].resourceKey = resourceKey;
  value.workItems[0].resourceKeys = [resourceKey];
  return value;
};
const unsupportedSource = error => error.code === 'TASK_CONTRACT_INVALID' && error.message.includes('catalog-reviewed');
const invalidPlans = () => [
  { contract: draft(), reject: impossible },
  ...[sourceDraft(4), sourceDraft(1, 'workspace:/fixture'), sourceDraft(1, 'origin:https://fixture.test')]
    .map(contract => ({ contract, reject: unsupportedSource })),
];
const sha = text => createHash('sha256').update(text).digest('hex');

function stageBody(kind, requestId, contract = draft(1)) {
  const stage = responseCycleStage(kind, { pipelineVersion: 2 }), fields = planningModuleTemplate(kind, { pipelineVersion: 2 }).fields;
  const sourceId = 'request:' + requestId;
  const body = { userAgency: fixtureUserAgency(),
    values: Object.fromEntries(fields.map(field => [field.id, field.label + ': review the supplied catalog and enrollment history using actual observations.'])),
    grounding: fields.filter(field => field.grounding === 'required').map(field => ({ field: field.id, sourceId })),
    openQuestions: [], challengeResponses: [] };
  if (kind === 'viability') body.requirements = [];
  else Object.assign(body, { checks: stage.checks.map(check => ({ id: check.id,
    assessment: check.when === 'effects' ? 'not_applicable' : 'supported',
    sourceIds: check.grounding === 'required' && check.when !== 'effects' ? [sourceId] : [],
    note: 'The request identifies the bounded review and requires actual evidence for its findings.' })),
    subproblems: [], childResults: [] });
  if (kind === 'inference') body.inferences = [{ id: 'review-request', claim: 'The user requests a review of the supplied catalog and enrollment history.',
    basis: 'inferred', sourceIds: [sourceId], limitation: 'No operational observations have been made.' }];
  if (kind === 'plan') body.contract = contract;
  return body;
}

async function planningFixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-feasibility-plan-'));
  const store = await new PlanningBrowserStore({ dataDir }).init();
  t.after(async () => { await store.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  let request = await store.create({ conversationId: 'feasibility-conversation', title: 'Review supplied records',
    objective: 'Review the supplied catalog and enrollment history using actual evidence.', cwd: dataDir });
  const cycleId = 'feasibility-cycle', stages = Object.fromEntries(RESPONSE_CYCLE_STAGES.map(stage => [stage.id, cycleId + '-' + stage.id]));
  const writer = store.runtimeWriter();
  request = await writer.configureResponseCycle(request.id, { createCycle: { id: cycleId, title: request.title, objective: request.objective,
    stageNodeIds: stages, parentCycleId: null, parentStageId: null, depth: 0, pipelineVersion: 2,
    planningExecutionMode: 'plan_only', state: 'pending', acceptanceCriteria: [], sourceIds: null, execution: { required: false, state: 'not_required' } },
    rootPatch: { rootCycleId: cycleId },
    sources: [{ id: 'cycle:execution-contract:' + cycleId, kind: 'source', label: 'Canonical execution contract',
      text: JSON.stringify({ taskSchemaVersion: 14, contractVersion: 2 }) }] });
  for (const kind of ['inference', 'viability']) request = await store.recordHumanResponse(request.id, stages[responseCycleStage(kind).id],
    stageBody(kind, request.id), { expectedNodeRevision: 1 });
  const planId = stages.plan;
  const write = async contract => {
    const current = await store.get(request.id), node = current.nodes.find(item => item.id === planId);
    return store.recordHumanResponse(request.id, planId, stageBody('plan', request.id, contract), { expectedNodeRevision: node.revision });
  };
  return { dataDir, store, writer, requestId: request.id, planId, write };
}

test('new judgment targets count distinct referring work items without changing the authored contract', () => {
  const invalid = normalizePlanContract(draft()), before = structuredClone(invalid);
  assert.throws(() => validatePlanContractFeasibility(invalid), impossible);
  assert.deepEqual(invalid, before);
  const multiple = normalizePlanContract(draft(2, 2));
  assert.equal(multiple.workItems[0].owner, multiple.workItems[1].owner);
  assert.equal(validatePlanContractFeasibility(multiple), multiple);
  const defaultTarget = draft(1); delete defaultTarget.criteria[0].targetCount;
  assert.doesNotThrow(() => validatePlanContractFeasibility(normalizePlanContract(defaultTarget)));
  assert.doesNotThrow(() => contractPlanProjection({ ...invalid, planEpoch: 2 }));
});

test('observation and external outcome targets do not count judgment owners', () => {
  for (const kind of ['observation', 'external-confirmation']) {
    const contract = normalizePlanContract(draft(4, 1, kind));
    assert.equal(validatePlanContractFeasibility(contract), contract);
    assert.equal(contract.criteria[0].targetCount, 4);
  }
});

test('new source coverage accepts one exact source without restricting concrete resource schemes', () => {
  for (const resourceKey of ['path:/fixture/catalog.txt', 'file:catalog.csv', 'url:https://fixture.test/catalog', 'document:fixture-tab:1']) {
    const contract = normalizePlanContract(sourceDraft(1, resourceKey));
    assert.equal(validatePlanContractFeasibility(contract), contract);
    assert.equal(contract.criteria[0].targetCount, 1);
    delete contract.criteria[0].targetCount;
    assert.equal(validatePlanContractFeasibility(contract), contract, 'The omitted target defaults to one without rewriting the contract.');
    assert.equal(Object.hasOwn(contract.criteria[0], 'targetCount'), false);
  }
});

test('new source coverage rejects unreachable counts and scope-only selectors without changing historical normalization', () => {
  for (const { contract, reject } of invalidPlans().slice(1)) {
    const normalized = normalizePlanContract(contract), before = structuredClone(normalized);
    assert.throws(() => validatePlanContractFeasibility(normalized), reject);
    assert.deepEqual(normalized, before);
    assert.deepEqual(normalizePlanContract({ ...normalized, planEpoch: 2 }, { allowEpoch: true }), { ...before, planEpoch: 2 });
    assert.doesNotThrow(() => contractPlanProjection({ ...normalized, planEpoch: 2 }));
  }
});

test('new human Plan writes reject impossible targets while captured old response history stays readable', async t => {
  const f = await planningFixture(t), initial = await f.store.get(f.requestId), file = f.store.file(f.requestId);
  const unchanged = await fs.readFile(file, 'utf8');
  for (const { contract, reject } of invalidPlans()) {
    await assert.rejects(f.write(contract), reject);
    assert.equal(await fs.readFile(file, 'utf8'), unchanged, 'A rejected new human Plan does not mutate the saved request.');
    assert.equal((await f.store.get(f.requestId)).revision, initial.revision);
  }
  let saved = await f.write(sourceDraft());
  // Simulate v2 responses captured before the authoring bounds; each old contract remains readable.
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  const old = document.responses.find(response => response.nodeId === f.planId);
  for (const { contract } of invalidPlans()) {
    old.contract = structuredClone(contract);
    // A valid captured response keeps its derived views consistent with its own contract.
    Object.assign(old, contractPlanProjection(old.contract, old.steps[0].sourceIds));
    old.provenance.contentHash = sha(JSON.stringify(planningResponseBody(old)));
    await fs.writeFile(file, JSON.stringify(document), 'utf8');
    const historicalBytes = await fs.readFile(file, 'utf8');
    const reopened = await f.store.get(f.requestId);
    assert.deepEqual(reopened.responses.find(response => response.id === old.id).contract, contract);
    assert.equal(await fs.readFile(file, 'utf8'), historicalBytes);
  }
  saved = await f.write(draft(2, 2));
  assert.deepEqual(saved.responses.find(response => response.id === old.id).contract, old.contract);
  const latest = saved.nodes.find(node => node.id === f.planId).response;
  assert.equal(latest.contract.criteria[0].targetCount, 2);
  assert.equal(latest.contract.workItems.length, 2);
  assert.ok(saved.revision > initial.revision);
});

test('new provider validation and durable response writing both reject an impossible Plan', async t => {
  const f = await planningFixture(t), current = await f.store.get(f.requestId);
  const started = await f.writer.beginAttempt(f.requestId, f.planId, { ownerId: 'fixture-provider',
    expectedNodeRevision: current.nodes.find(node => node.id === f.planId).revision, model: 'fixture::deterministic' });
  const metadata = { runId: 'fixture-run', executionNodeId: 'fixture-worker', model: 'fixture::deterministic', provider: 'fixture' };
  const before = await fs.readFile(f.store.file(f.requestId), 'utf8');
  for (const { contract, reject } of invalidPlans()) {
    const badOutput = JSON.stringify(stageBody('plan', f.requestId, contract));
    assert.throws(() => validatePlanningModuleResponse(started.attempt, badOutput), reject);
    await assert.rejects(f.writer.recordResponse(f.requestId, started.attempt.id, { output: badOutput, metadata }), reject);
    assert.equal(await fs.readFile(f.store.file(f.requestId), 'utf8'), before, 'Rejected provider authoring does not complete or mutate the attempt.');
  }
  const goodOutput = JSON.stringify(stageBody('plan', f.requestId, draft(2, 2)));
  assert.doesNotThrow(() => validatePlanningModuleResponse(started.attempt, goodOutput));
  const saved = await f.writer.recordResponse(f.requestId, started.attempt.id, { output: goodOutput, metadata });
  assert.equal(saved.attempts.find(item => item.id === started.attempt.id).status, 'completed');
  assert.equal(saved.nodes.find(node => node.id === f.planId).response.contract.workItems.length, 2);
});

test('task writes reject unreachable counts without making older canonical history unreadable', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-feasibility-task-'));
  const store = await new TaskStateStore({ dataDir }).init(), taskId = 'feasibility-task';
  t.after(async () => { await store.close?.(); await fs.rm(dataDir, { recursive: true, force: true }); });
  await store.ensure({ taskId, runId: 'run', nodeId: 'agent', cwd: dataDir, goal: 'Review supplied records.', schemaVersion: 14, defaultPlan: true });
  const write = async contract => { const state = await store.get(taskId); return store.setContract(taskId, contract,
    { schemaVersion: 14, expectedRevision: state.revision, runId: 'run', nodeId: 'agent', source: 'agent' }); };
  const file = store.file(taskId), initialBytes = await fs.readFile(file, 'utf8');
  for (const { contract, reject } of invalidPlans()) {
    await assert.rejects(write(contract), reject);
    assert.equal(await fs.readFile(file, 'utf8'), initialBytes, 'Rejected task authoring does not mutate the current contract or its history.');
  }
  await write(sourceDraft());
  const repaired = sourceDraft(); repaired.goal += ' Preserve the earlier saved evidence.';
  await write(repaired);
  const history = JSON.parse(await fs.readFile(file, 'utf8'));
  const old = history.history.find(state => state.contract);
  const historicalEpoch = old.contract.planEpoch;
  for (const { contract } of invalidPlans()) {
    old.contract = { ...structuredClone(contract), planEpoch: historicalEpoch };
    await fs.writeFile(file, JSON.stringify(history), 'utf8');
    const historicalBytes = await fs.readFile(file, 'utf8');
    const current = await store.get(taskId);
    assert.equal(current.contract.criteria[0].targetCount, 1);
    assert.deepEqual((await store.load(taskId)).history.find(state => state.contract).contract, old.contract);
    assert.equal(await fs.readFile(file, 'utf8'), historicalBytes);
  }
  const accepted = await write(draft(2, 2));
  assert.equal(accepted.contract.criteria[0].targetCount, 2);
  assert.equal(accepted.contract.workItems.length, 2);
});
