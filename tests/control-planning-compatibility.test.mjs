import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PlanningBrowserStore } from '../lib/planning-browser.mjs';
import { ResponseCycleService } from '../lib/response-cycle.mjs';
import { createControlToolHandler, CONTROL_TOOL, PRE_USER_AGENCY_CONTROL_TOOL } from '../lib/control-tools.mjs';
import { validRemoteArguments } from '../lib/remote-agent-api.mjs';
import { responseCycleStage, responseCycleTemplate } from '../public/response-cycle-model.mjs';
import { planningResponseBody } from '../public/planning-browser-model.mjs';
import { fixtureUserAgency } from './fixture-user-agency.mjs';

const planBody = () => ({
  values: Object.fromEntries(responseCycleTemplate('plan').fields.map(field => [field.id, 'A bounded synthetic plan preserves the requested outcome.'])),
  grounding: [], openQuestions: [], challengeResponses: [],
  checks: responseCycleStage('plan').checks.map(check => ({ id: check.id, assessment: 'supported', sourceIds: [], note: 'The saved synthetic plan records this bounded check.' })),
  subproblems: [], childResults: [],
  acceptanceCriteria: [{ id: 'outcome', label: 'Recorded outcome', description: 'Retain the requested bounded result.', verification: 'response', accuracy: null }],
  steps: [{ id: 'work', label: 'Inspect the synthetic result', description: 'Inspect the recorded result against its criterion.', dependsOn: [], criterionIds: ['outcome'], sourceIds: [] }],
});

test('saved schema10 Plan edits survive reopen and distinct revisions without weakening current agency writes', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-control-plan-compat-'));
  let store, service, starts = 0;
  const runner = { start: () => { starts++; throw Error('Compatibility edits must not start a model.'); } };
  const open = async () => {
    store = await new PlanningBrowserStore({ dataDir: directory }).init();
    service = new ResponseCycleService({ store, runner });
  };
  await open();
  t.after(async () => { await service.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  let request = await store.create({ conversationId: 'saved-native-conversation', title: 'Historical Plan', objective: 'Retain a synthetic saved Plan through continuation.', cwd: directory });
  request = await service.createCycle(request.id, { title: 'Historical cycle', purpose: request.objective, planningExecutionMode: 'plan_only', expectedRequestRevision: request.revision, clientRequestId: 'create-fixture-cycle' });
  const requestId = request.id, cycleId = request.cycles[0].id;
  const planOf = value => value.nodes.find(node => node.id === value.cycles.find(cycle => cycle.id === cycleId).stageNodeIds.plan);
  let node = planOf(request);
  request = await store.recordHumanResponse(requestId, node.id, planBody(), { expectedNodeRevision: node.revision, actor: 'historical-fixture-author' });
  node = planOf(request);
  request = await store.runtimeWriter().configureResponseCycle(requestId, { cyclePatch: { id: cycleId, state: 'paused_after_plan', planRef: { requestId, cycleId, nodeId: node.id, nodeRevision: node.revision, responseId: node.response.id } } });
  assert.equal(planOf(request).response.userAgency, undefined);

  await service.close(); await store.close(); await open();
  const handler = toolDefinition => createControlToolHandler({ engine: { responseCycle: service }, run: { id: 'saved-native', cwd: directory }, nodeId: 'supervisor', toolDefinition });
  const legacy = handler(PRE_USER_AGENCY_CONTROL_TOOL), current = handler(CONTROL_TOOL);
  const argumentsFor = async (clientRequestId, approach, checkpoint) => {
    const saved = await store.get(requestId), plan = planOf(saved), body = planningResponseBody(plan.response);
    delete body.userAgency;
    for (const criterion of [...body.acceptanceCriteria, ...body.subproblems.flatMap(item => item.acceptanceCriteria)]) if (!Object.hasOwn(criterion, 'accuracy')) criterion.accuracy = null;
    body.values.approach = approach;
    if (checkpoint !== undefined) body.userAgency = checkpoint;
    return { action: 'planning_cycle_edit_plan', graphRequestId: requestId, cycleId, cycle: {
      expectedRequestRevision: saved.revision, expectedCycleRevision: saved.nodes.find(item => item.id === cycleId).revision,
      expectedPlanRevision: plan.revision, expectedPlanResponseId: plan.response.id, clientRequestId, plan: body,
    } };
  };
  const invoke = (gateway, args) => gateway({ name: 'relay_control', arguments: args });
  const first = await argumentsFor('legacy-first', 'First distinct legacy edit.');
  assert.equal(validRemoteArguments(first, PRE_USER_AGENCY_CONTROL_TOOL.inputSchema), true, JSON.stringify(first));
  const firstResult = await invoke(legacy, first);
  assert.equal(firstResult.success, true, firstResult.contentItems[0].text);
  let saved = await store.get(requestId), firstResponseId = planOf(saved).response.id;
  assert.equal(planOf(saved).response.userAgency, undefined);
  assert.equal(planOf(saved).response.provenance.kind, 'supervising_model');
  assert.equal(planOf(saved).response.provenance.author, 'saved-native:supervisor');
  const replay = await invoke(legacy, first);
  assert.equal(replay.success, true, replay.contentItems[0].text);
  assert.equal(planOf(await store.get(requestId)).response.id, firstResponseId);

  const second = await argumentsFor('legacy-second', 'Second distinct legacy edit.');
  assert.equal(validRemoteArguments(second, PRE_USER_AGENCY_CONTROL_TOOL.inputSchema), true);
  const secondResult = await invoke(legacy, second);
  assert.equal(secondResult.success, true, secondResult.contentItems[0].text);
  saved = await store.get(requestId);
  assert.notEqual(planOf(saved).response.id, firstResponseId);
  assert.equal(planOf(saved).response.values.approach, 'Second distinct legacy edit.');
  assert.equal(planOf(saved).response.userAgency, undefined);

  const previousResponseId = planOf(saved).response.id;
  const rejected = await invoke(current, await argumentsFor('current-missing-checkpoint', 'Must not be saved.'));
  assert.equal(rejected.success, false);
  assert.match(rejected.contentItems[0].text, /USER_AGENCY_REQUIRED|requires a userAgency checkpoint/);
  assert.equal(planOf(await store.get(requestId)).response.id, previousResponseId);

  const checkpoint = fixtureUserAgency();
  const upgraded = await invoke(current, await argumentsFor('current-checkpoint', 'Current contract edit.', checkpoint));
  assert.equal(upgraded.success, true, upgraded.contentItems[0].text);
  saved = await store.get(requestId);
  assert.deepEqual(planOf(saved).response.userAgency, checkpoint);
  const preserved = await invoke(legacy, await argumentsFor('legacy-after-upgrade', 'Legacy edit retains the existing checkpoint.'));
  assert.equal(preserved.success, true, preserved.contentItems[0].text);
  saved = await store.get(requestId);
  assert.deepEqual(planOf(saved).response.userAgency, checkpoint);
  assert.equal(planOf(saved).response.values.approach, 'Legacy edit retains the existing checkpoint.');

  // A caller cannot use the trusted legacy flag to remove an already current checkpoint.
  const currentNode = planOf(saved), omitted = planningResponseBody(currentNode.response); delete omitted.userAgency;
  await assert.rejects(store.runtimeWriter().recordSupervisedResponse(requestId, currentNode.id, omitted, {
    expectedNodeRevision: currentNode.revision, actor: { type: 'agent', id: 'saved-native:supervisor' }, legacyControlPlan: true,
  }), { code: 'USER_AGENCY_REQUIRED' });

  await service.close(); await store.close(); await open();
  const reopened = planOf(await store.get(requestId));
  assert.deepEqual(reopened.response.userAgency, checkpoint);
  assert.equal(reopened.response.values.approach, 'Legacy edit retains the existing checkpoint.');
  assert.equal(starts, 0);
});
