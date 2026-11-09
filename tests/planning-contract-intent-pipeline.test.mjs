import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';
import { createTaskToolHandler, TaskStateStore } from '../lib/task-state.mjs';
import { PlanningBrowserStore } from '../lib/planning-browser.mjs';
import { PlanningBrowserRuntime } from '../lib/planning-browser-runtime.mjs';
import { TaskViability } from '../lib/task-viability.mjs';
import { ResponseCycleService } from '../lib/response-cycle.mjs';
import { AttachmentStore } from '../lib/attachments.mjs';
import { attachmentResourceKey, attachmentSetResourceKey } from '../lib/operation-descriptors.mjs';
import { adoptExecutionPlanContract, executionOutlineHash } from '../lib/planning-execution-handoff.mjs';
import { readContractJournal } from '../lib/planning-contract-runtime.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';
import { responseCycleStage } from '../public/response-cycle-model.mjs';
import { TASK_ACCURACY_SCOPE_GUIDANCE } from '../public/task-viability-model.mjs';
import { fixtureUserAgency } from './fixture-user-agency.mjs';

// This is a deterministic provider boundary test. It checks production stage
// delivery, required-criterion inheritance and adoption, not model reasoning.
// The fictional alternatives are explicitly authorized by this request; no
// geographic equivalence, personal profile or application outcome is supplied.
const request = 'Using demo-profile.json, submit exactly 20 new applications at https://applications.example.invalid. '
  + 'For the city field, Oak Hollow or Harbor City is acceptable. Avoid duplicate applications and report each destination confirmation.';
const locationPermission = 'For the city field, Oak Hollow or Harbor City is acceptable.';
const requiredCriteria = [
  { id: 'applications-confirmed', label: 'Exactly 20 new confirmed applications',
    description: 'Observe exactly 20 distinct new destination-confirmed applications and report each confirmation.', verification: 'effect',
    accuracy: { mode: 'exact', tolerance: 'Exactly 20 new confirmations and zero duplicate applications.',
      decisionThreshold: 'Any count other than 20 or any duplicate leaves this outcome incomplete.',
      evidenceNeeded: 'Actual destination confirmations correlated with the distinct admitted applications.',
      consequence: 'An incorrect count or receipt identity would misstate completion.', unknownPolicy: 'block',
      stopWhen: 'Exactly 20 distinct new application confirmations are established by host evidence.' } },
  { id: 'city-permission', label: 'Use an authorized city option', description: locationPermission, verification: 'response',
    accuracy: { mode: 'qualitative', tolerance: 'Either Oak Hollow or Harbor City is acceptable for the city field.',
      decisionThreshold: 'Use an observed supported option within those user-authorized alternatives.',
      evidenceNeeded: 'The explicit user permission and the actual form option selected during execution.',
      consequence: 'Replacing this permission with one exact spelling would add a constraint the user did not request.', unknownPolicy: 'block',
      stopWhen: 'An observed supported city option is selected within the user-authorized alternatives.' } },
];
const copy = value => structuredClone(value);
const captured = options => JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n') + 2));

function analyticalResponse(input, { strictCity = false, workspaceKey, conditional = null, attachmentScope, misspellAttachment } = {}) {
  const stage = responseCycleStage(input.module.kind, { pipelineVersion: input.cycle?.pipelineVersion });
  const sourceId = input.sources.find(source => source.id === 'viability:task')?.id || input.sources[0].id;
  const body = { userAgency: fixtureUserAgency(),
    values: Object.fromEntries(input.template.fields.map(field => [field.id,
      field.label + ': preserve the user-authorized city alternatives while obtaining exactly 20 distinct new destination confirmations. No application has been performed.'])),
    grounding: input.template.fields.filter(field => field.grounding === 'required').map(field => ({ field: field.id, sourceId })),
    openQuestions: [], challengeResponses: [] };
  if (stage.id === 'feasibility') {
    const inference = input.cycle.prerequisites.find(item => item.stageId === 'inference');
    assert.ok(input.sources.some(source => source.id === inference?.sourceId));
    return { ...body, requirements: [{ id: 'authorized-city', label: 'Authorized city alternatives', importance: 'essential', basis: 'user',
      consequence: 'Preserve the location flexibility already authorized while checking actual form options.', resolution: 'observed',
      value: locationPermission + ' The operational owner still needs to observe the form options.', sourceIds: [sourceId, inference.sourceId],
      checkedSourceIds: input.sources.filter(source => source.kind !== 'response').map(source => source.id),
      rationale: 'The supplied request resolves permission. An unobserved literal option is not evidence that the authorized task is infeasible.',
      inferable: false, omissionAllowed: false, question: '', dependentNodeIds: ['agent'], stopKind: null, accuracy: copy(requiredCriteria[1].accuracy),
      ...(conditional ? { commitPrerequisite: true } : {}) }] };
  }
  Object.assign(body, { checks: stage.checks.map(check => ({ id: check.id,
    assessment: check.when === 'effects' ? 'not_applicable' : 'supported',
    sourceIds: check.grounding === 'required' && check.when !== 'effects' ? [sourceId] : [],
    note: 'The explicit request supports the intent and authorization; operational completion still requires actual destination evidence.' })),
    subproblems: [], childResults: [] });
  if (stage.id === 'inference') {
    body.inferences = [{ id: 'city-tolerance', claim: locationPermission, basis: 'inferred', sourceIds: [sourceId],
      limitation: 'This authorizes the two choices for this field only. It does not establish any form availability, application or confirmation.' }];
    body.subproblems = [{ key: 'application-workflow', title: 'Complete the authorized applications', objective: request,
      reason: 'Application operations belong to the operational owner after preparation.', required: true, executionTarget: 'workflow',
      sourceIds: [sourceId], acceptanceCriteria: copy(requiredCriteria) }];
  }
  if (stage.id === 'plan') {
    assert.deepEqual(input.cycle.requiredAcceptanceCriteria, requiredCriteria,
      'The actual Infer workflow request must reach Plan as required criteria, including both accuracy scopes.');
    body.contract = { contractVersion: 2, goal: request,
      criteria: input.cycle.requiredAcceptanceCriteria.map(item => ({ id: item.id, label: item.label,
        description: item.description, kind: item.verification === 'effect' ? 'external-confirmation' : 'judgment',
        targetCount: item.verification === 'effect' ? 20 : 1, accuracy: copy(item.accuracy) })),
      workItems: [{ id: 'complete-applications', title: 'Complete the requested applications',
        objective: 'Inspect the profile and actual form, use an authorized city alternative, submit new applications and verify distinct confirmations.',
        owner: 'agent', resourceKeys: ['origin:https://applications.example.invalid', workspaceKey], effects: ['observe', 'interact', 'commit'],
        dependsOn: [], criterionIds: requiredCriteria.map(item => item.id) }],
      instructions: [{ id: 'city-alternatives', text: locationPermission + ' Preserve all other supplied facts and the exact new-confirmation count.', handling: 'preserve' }] };
    if (strictCity) body.contract.criteria.find(item => item.id === 'city-permission').accuracy.tolerance = 'Only the exact string Oak Hollow is acceptable.';
    if (attachmentScope) {
      body.contract.criteria.push({ id: 'attached-profile', kind: 'observation', description: 'Read the current immutable attached profile.', resourceKey: attachmentScope.files[0].resourceKey });
      const resourceKeys = misspellAttachment ? [workspaceKey, attachmentScope.files[0].resourceKey.slice(0, -7), attachmentScope.files[1].resourceKey] : [workspaceKey];
      body.contract.workItems.push({ id: 'inspect-attachment', title: 'Read the attached profile', objective: 'Read the supplied attachment.',
        owner: 'agent', resourceKeys, effects: ['observe'], dependsOn: [], criterionIds: ['attached-profile'] });
    }
    if (conditional) {
      const [gate] = input.cycle.commitPrerequisites;
      assert.equal(gate.id, 'authorized-city', 'Feasibility must deliver the typed condition to Plan.');
      const commit = body.contract.workItems[0];
      if (conditional === 'valid') {
        body.contract.workItems.push({ ...commit, id: 'inspect-prerequisite', effects: ['observe'], criterionIds: [gate.id] });
        commit.dependsOn = ['inspect-prerequisite'];
      } else commit.criterionIds.push(gate.id);
    }
  }
  return body;
}

async function fixture(t, { mode = 'plan_only', strictCity = false, conditional = null, attach = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-intent-pipeline-')), cwd = path.join(directory, 'workspace');
  await mkdir(cwd);
  const tasks = await new TaskStateStore({ dataDir: directory }).init();
  const store = await new PlanningBrowserStore({ dataDir: directory }).init();
  const attachments = attach ? await new AttachmentStore({ dataDir: directory }).init() : undefined;
  const attached = attachments ? await attachments.importBytes({ name: 'demo-profile.txt', bytes: Buffer.from('Bounded attached profile fixture.') }) : null;
  const misspellAttachment = attach === 'misspelled-key';
  const guidance = misspellAttachment ? await attachments.importBytes({ name: 'demo-guidance.txt', bytes: Buffer.from('Bounded attached guidance fixture.') }) : null;
  const unattached = misspellAttachment ? await attachments.importBytes({ name: 'unattached.txt', bytes: Buffer.from('Out-of-scope fixture.') }) : null;
  const runFiles = [attached, guidance].filter(Boolean);
  const settings = { defaultModel: 'fixture-intent', defaultEffort: 'low', runTimeoutMs: null, executionGuardrails: false, subagentsEnabled: false };
  const calls = [], toolCalls = []; let operationalCalls = 0, adoptedTask = null, finalCheck = null, engine;
  class Runtime extends EventEmitter {
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture-intent', models: [{ id: 'fixture-intent', supportsTools: true }] }; }
    async runAgent(options) {
      if (options.responseOnly) {
        const input = captured(options); calls.push({ input, prompt: options.prompt });
        assert.ok(['inference', 'viability', 'plan'].includes(input.module.kind), 'The fixture stops before post-execution analysis.');
        assert.equal(input.cycle.pipelineVersion, 2);
        assert.ok(options.prompt.includes(TASK_ACCURACY_SCOPE_GUIDANCE), 'Each actual current stage receives the shared accuracy-scope guidance.');
        assert.ok(input.sources.some(source => source.text.includes(locationPermission)), 'The stage retains the original explicit user permission.');
        const workspaceKey = 'workspace:' + (process.platform === 'win32' ? cwd.replaceAll('\\', '/').toLowerCase() : cwd);
        const executionSource = input.sources.find(source => source.id.startsWith('cycle:execution-contract:'));
        const attachmentScope = executionSource && JSON.parse(executionSource.text).attachmentScope;
        if (input.module.kind === 'plan') {
          if (attached) assert.deepEqual(attachmentScope, { tool: 'relay_files', effect: 'observe', resourceKey: attachmentSetResourceKey(runFiles.map(file => file.id)),
            files: runFiles.map(file => ({ id: file.id, name: file.name, resourceKey: attachmentResourceKey(file.sha256) })) });
          else assert.equal(attachmentScope, undefined, 'An empty run does not advertise an attached scope.');
        }
        return { output: JSON.stringify(analyticalResponse(input, { strictCity, workspaceKey, conditional, attachmentScope, misspellAttachment })), threadId: 'fixture-intent-planning', turnId: randomUUID() };
      }
      operationalCalls++;
      assert.equal(mode, 'automatic', 'Plan only must never enter an operational worker.');
      assert.ok(JSON.stringify(options).includes(JSON.stringify(TASK_ACCURACY_SCOPE_GUIDANCE).slice(1, -1)), 'The actual worker receives canonical execution guidance.');
      const call = { name: 'relay_task', arguments: { action: 'read' }, callId: randomUUID() }; toolCalls.push([call.name, call.arguments.action]);
      const result = await options.onToolCall(call, { signal: options.signal });
      await options.onToolResultDelivered?.({ call, result });
      assert.equal(result.success, true, JSON.stringify(result));
      adoptedTask = JSON.parse(result.contentItems.find(item => item.type === 'inputText').text);
      if (attached) {
        const invoke = (action, file = attached) => options.onToolCall({ name: 'relay_files', arguments: { action, attachmentId: file.id }, callId: randomUUID() }, { signal: options.signal });
        const read = await invoke('read');
        assert.equal(read.success, true, JSON.stringify(read));
        assert.match(read.contentItems[0].text, /Bounded attached profile fixture/);
        if (guidance) assert.equal((await invoke('read', guidance)).success, true);
        if (unattached) await assert.rejects(invoke('read', unattached), /This file is not attached to the current task/);
        const denied = await invoke('export');
        assert.equal(denied.code, 'TASK_CONTRACT_SCOPE', 'An attachment observation scope cannot export files.');
      }
      finalCheck = await options.onBeforeFinal({ output: 'No applications have been performed by this fixture.' });
      assert.equal(finalCheck?.continue, true, 'Permitted city tolerance cannot satisfy the unperformed application count or receipt requirements.');
      throw Object.assign(new Error('Fixture stopped after inspecting the canonical handoff; no application operation was dispatched.'), { code: 'FIXTURE_STOP_AFTER_HANDOFF' });
    }
    async close() {}
  }
  const runtime = new Runtime();
  engine = await new HarnessEngine({ runtime, tasks, attachments, dataDir: directory, defaultCwd: cwd }).init();
  engine.runtimeSettings = { get: () => settings };
  const runner = new PlanningBrowserRuntime({ store, runtime, defaultCwd: cwd, getSettings: () => settings });
  const viability = new TaskViability({ store, runner, engine, attachments, identity: { read: async () => ({ content: 'No personal profile or external result is supplied by this deterministic fixture.' }) }, getSettings: () => settings });
  const service = new ResponseCycleService({ store, runner, taskViability: viability, engine, getSettings: () => settings });
  engine.responseCycle = service;
  t.after(async () => { await engine.close(); await runner.close(); await service.close(); await viability.close(); await store.close(); await tasks.close(); await attachments?.close(); await rm(directory, { recursive: true, force: true }); });
  const workflow = createMissionWorkflow({ id: 'intent-pipeline', task: request, model: 'fixture-intent', cwd, planningMode: 'forced' });
  const accepted = engine.startRun({ workflow, input: attached ? { task: request, attachmentIds: runFiles.map(file => file.id) } : request,
    planningMode: 'forced', planningExecutionMode: mode, requestId: 'intent-pipeline-' + mode + '-' + strictCity });
  await engine.executions.get(accepted.id);
  const run = engine.getRun(accepted.id), saved = await store.get(run.responseCycle.requestId), cycle = saved.cycles.find(item => item.id === run.responseCycle.cycleId);
  return { run, saved, cycle, calls, operationalCalls, toolCalls, adoptedTask, finalCheck, tasks, attached, guidance,
    journal: await readContractJournal(tasks, run.taskId), task: operationalCalls ? await tasks.get(run.taskId) : null };
}

test('automatic canonical execution reads a supplied attachment within its actual observation scope', { timeout: 20000 }, async t => {
  const f = await fixture(t, { mode: 'automatic', attach: true });
  assert.equal(f.run.errorCode, 'FIXTURE_STOP_AFTER_HANDOFF', f.run.error);
  const [operation] = f.journal.records;
  assert.equal(f.journal.records.length, 1);
  assert.equal(operation.tool, 'relay_files');
  assert.equal(operation.effect, 'observe');
  assert.equal(operation.workItemId, 'inspect-attachment');
  assert.ok(f.journal.evidence.some(item => item.resourceKey === attachmentResourceKey(f.attached.sha256) && item.sourceVersion === f.attached.sha256));
});

test('a correct attachment key does not suppress repair of a misspelled key on the same reader', { timeout: 20000 }, async t => {
  const f = await fixture(t, { mode: 'automatic', attach: 'misspelled-key' });
  assert.equal(f.run.errorCode, 'FIXTURE_STOP_AFTER_HANDOFF', f.run.error);
  const scope = attachmentSetResourceKey([f.attached.id, f.guidance.id]);
  const reader = f.task.contract.workItems.find(item => item.id === 'inspect-attachment');
  assert.ok(reader.resourceKeys.includes(scope));
  assert.ok(reader.resourceKeys.includes(attachmentResourceKey(f.guidance.sha256)));
  assert.ok(!reader.resourceKeys.includes(attachmentResourceKey(f.attached.sha256).slice(0, -7)));
  assert.ok(f.task.contract.workItems.filter(item => item.id !== reader.id).every(item => !item.resourceKeys.includes(scope)));
  assert.deepEqual(f.journal.records.map(operation => [operation.tool, operation.effect, operation.workItemId]), [
    ['relay_files', 'observe', 'inspect-attachment'], ['relay_files', 'observe', 'inspect-attachment'],
  ]);
  assert.deepEqual(f.journal.evidence.map(item => [item.resourceKey, item.sourceVersion]), [f.attached, f.guidance].map(file => [attachmentResourceKey(file.sha256), file.sha256]));
});

function assertIntentAndProofBoundary(contract) {
  assert.equal(contract.contractVersion, 2);
  const count = contract.criteria.find(item => item.id === 'applications-confirmed'), city = contract.criteria.find(item => item.id === 'city-permission');
  assert.equal(count.kind, 'external-confirmation'); assert.equal(count.targetCount, 20);
  assert.deepEqual(count.accuracy, requiredCriteria[0].accuracy);
  assert.equal(count.receiptBinding, undefined, 'Preparation cannot invent unobserved receipt fields.');
  assert.equal(city.kind, 'judgment'); assert.deepEqual(city.accuracy, requiredCriteria[1].accuracy);
  assert.equal(city.description, locationPermission);
  assert.ok(contract.instructions.some(item => item.text.includes(locationPermission)));
}

test('Forced Plan only preserves authorized city tolerance through Infer, Feasibility and canonical Plan while exact20 proof remains pending', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  assert.equal(f.run.status, 'completed', f.run.error); assert.equal(f.run.settled, true);
  assert.equal(f.run.viability.pausedAfterPlan, true); assert.equal(f.run.viability.awaitingInput, false);
  assert.equal(f.run.startedAt, null); assert.equal(f.operationalCalls, 0);
  assert.deepEqual(f.calls.map(call => call.input.module.kind), ['inference', 'viability', 'plan']);
  const plan = f.saved.nodes.find(node => node.id === f.cycle.stageNodeIds.plan);
  assert.equal(plan.readiness.cycle.analysisReady, true); assertIntentAndProofBoundary(plan.response.contract);
  assert.deepEqual(plan.response.acceptanceCriteria, requiredCriteria);
  assert.ok(Object.values(f.run.nodes).every(node => node.status === 'skipped' && node.planningHeld === true));
  assert.deepEqual(f.cycle.effectReceipts || [], []);
  assert.equal(f.journal.records.length, 0); assert.equal(f.journal.evidence.length, 0);
});

test('a later Plan cannot upgrade the inherited approved city tolerance to an exact-string prerequisite', { timeout: 20000 }, async t => {
  const f = await fixture(t, { strictCity: true });
  assert.equal(f.run.status, 'failed'); assert.equal(f.run.errorCode, 'PLANNING_RESPONSE_FORMAT');
  assert.match(f.run.error, /changed a required workflow criterion/);
  assert.deepEqual(f.calls.map(call => call.input.module.kind), ['inference', 'viability', 'plan', 'plan']);
  assert.equal(f.operationalCalls, 0); assert.equal(f.run.startedAt, null);
  const plan = f.saved.nodes.find(node => node.id === f.cycle.stageNodeIds.plan);
  assert.equal(Boolean(plan.response), false, 'Neither the first invalid Plan nor its bounded failed repair is adopted.');
  assert.equal(f.journal.records.length, 0); assert.equal(f.journal.evidence.length, 0);
});

test('automatic canonical handoff delivers the same city tolerance and guidance without granting application proof', { timeout: 20000 }, async t => {
  const f = await fixture(t, { mode: 'automatic' });
  assert.equal(f.run.status, 'failed'); assert.equal(f.run.errorCode, 'FIXTURE_STOP_AFTER_HANDOFF', f.run.error);
  assert.equal(f.operationalCalls, 1); assert.deepEqual(f.toolCalls, [['relay_task', 'read']]);
  assert.equal(f.run.nodes.agent.planning.goalStatus, 'active', 'Reading the adopted plan cannot erase the active goal.');
  assertIntentAndProofBoundary(f.adoptedTask.contract);
  assert.equal(f.task.contractAdoption.planRef.responseId, f.run.responseCycle.planRef.responseId);
  assert.equal(f.adoptedTask.contractRuntime.criteria.find(item => item.id === 'applications-confirmed').observedCount, 0);
  assert.equal(f.adoptedTask.contractRuntime.criteria.every(item => item.satisfied === false), true);
  assert.equal(f.journal.records.length, 0); assert.equal(f.journal.evidence.length, 0);
  assert.deepEqual(f.adoptedTask.contractRuntime.outcomes, []);
});

test('the host separates an eligibility condition from a commitment even if the model groups them', { timeout: 20000 }, async t => {
  const f = await fixture(t, { mode: 'automatic', conditional: 'combined' });
  assert.equal(f.run.errorCode, 'FIXTURE_STOP_AFTER_HANDOFF', f.run.error);
  assert.deepEqual(f.calls.map(call => call.input.module.kind), ['inference', 'viability', 'plan']);
  assert.equal(f.operationalCalls, 1);
  const items = f.adoptedTask.contract.workItems, check = items.find(item => item.criterionIds.includes('authorized-city'));
  assert.deepEqual(check.effects, ['observe']);
  assert.deepEqual(items.find(item => item.effects.includes('commit')).dependsOn, [check.id]);
  assert.equal(f.journal.records.length, 0);
});

test('an adopted prerequisite remains required through an operational edit', { timeout: 20000 }, async t => {
  const f = await fixture(t, { mode: 'automatic', conditional: 'valid' });
  assert.equal(f.run.errorCode, 'FIXTURE_STOP_AFTER_HANDOFF', f.run.error);
  assert.deepEqual(f.adoptedTask.contractAdoption.commitPrerequisiteIds, ['authorized-city']);
  assert.ok(f.adoptedTask.contractAdoption.requiredCriterionIds.includes('authorized-city'));
  assert.deepEqual(f.adoptedTask.contract.criteria.find(criterion => criterion.id === 'authorized-city'), {
    id: 'authorized-city', kind: 'judgment', label: 'Authorized city alternatives', description: 'Authorized city alternatives', targetCount: 1,
    accuracy: requiredCriteria[1].accuracy
  });
  assert.equal(f.task.contract.workItems.find(item => item.effects.includes('commit')).dependsOn[0], 'inspect-prerequisite');
  const { planEpoch, ...contract } = copy(f.task.contract);
  contract.workItems.find(item => item.effects.includes('commit')).dependsOn = [];
  await assert.rejects(f.tasks.setContract(f.run.taskId, contract, { expectedRevision: f.task.revision, schemaVersion: 14 }),
    { code: 'TASK_CONTRACT_INVALID', message: /make every committing item wait/ });
});

test('an operational refinement cannot narrow the adopted goal or weaken inherited outcomes', { timeout: 20000 }, async t => {
  const f = await fixture(t, { mode: 'automatic' });
  const { taskId, id: runId } = f.run;
  const relayTask = createTaskToolHandler({ store: f.tasks, taskId, runId, nodeId: 'agent', schemaVersion: 14 });
  const authorable = (state, change) => {
    const { planEpoch, ...contract } = copy(state.contract);
    change(contract);
    return contract;
  };
  const refine = (state, change) => relayTask({ name: 'relay_task', arguments: {
    action: 'plan', expectedRevision: state.revision, contract: authorable(state, change)
  } });
  const original = f.task;
  assert.deepEqual(original.contractAdoption.requiredCriterionIds, ['applications-confirmed', 'city-permission']);
  const narrowed = await refine(original, contract => { contract.goal = 'List available jobs instead of applying.'; });
  assert.equal(narrowed.code, 'TASK_CONTRACT_GOAL_CHANGE');
  const checkpoint = await relayTask({ name: 'relay_task', arguments: {
    action: 'checkpoint', expectedRevision: original.revision, goal: 'List available jobs instead of applying.'
  } });
  assert.equal(checkpoint.code, 'TASK_CONTRACT_GOAL_CHANGE');
  for (const change of [
    contract => { contract.criteria.shift(); contract.workItems[0].criterionIds.shift(); },
    contract => { contract.criteria[0].targetCount = 1; },
    contract => { contract.criteria[0].kind = 'observation'; },
    contract => { contract.criteria[1].accuracy.tolerance = 'Only Oak Hollow is acceptable.'; }
  ]) assert.equal((await refine(original, change)).code, 'TASK_CONTRACT_CRITERION_CHANGE');
  assert.equal((await f.tasks.get(taskId)).revision, original.revision);

  const result = await refine(original, contract => {
    const receiptResource = 'browser:https://applications.example.invalid/receipt';
    contract.workItems[0].resourceKeys.push(receiptResource);
    contract.workItems[0].objective += ' Inspect the observed confirmation route.';
    contract.criteria[0].resourceKey = receiptResource;
    contract.criteria[0].receiptBinding = { version: 1, format: 'json', resourceKey: receiptResource,
      record: 'receipt', status: 'status', confirmedValues: ['confirmed'], outcomeId: 'id', history: false };
    contract.criteria.push({ id: 'source-review', kind: 'observation', description: 'Inspect the application source.' });
    contract.workItems[0].criterionIds.push('source-review');
  });
  assert.equal(result.success, true, JSON.stringify(result));
  const refined = await f.tasks.get(taskId);
  assert.equal(refined.contract.goal, request);
  assert.equal(refined.contract.planEpoch, original.contract.planEpoch + 1);
  assert.equal(refined.contract.criteria[0].receiptBinding.status, 'status');
  assert.equal(refined.contractRuntime.criteria[0].satisfied, false);
  assert.deepEqual(refined.contractAdoption, original.contractAdoption);

  const revised = await f.tasks.setContract(taskId, authorable(refined, contract => {
    contract.goal = 'Submit one new application at the same authorized destination.';
    Object.assign(contract.criteria[0], {
      label: 'One new confirmed application', description: 'Obtain and report one distinct new destination confirmation.',
      targetCount: 1, accuracy: undefined
    });
  }), { expectedRevision: refined.revision, source: 'human', schemaVersion: 14 });
  assert.equal(revised.contract.goal, 'Submit one new application at the same authorized destination.');
  assert.equal(revised.contract.criteria[0].targetCount, 1);
  assert.equal((await refine(revised, contract => { contract.goal = request; })).code, 'TASK_CONTRACT_GOAL_CHANGE');
  assert.equal((await refine(revised, contract => { contract.criteria[0].targetCount = 2; })).code, 'TASK_CONTRACT_CRITERION_CHANGE');

  const plan = { contract: authorable(revised, contract => {
    contract.goal = 'Inspect the saved application source and report the result.';
    contract.criteria = contract.criteria.filter(criterion => criterion.id === 'source-review');
    contract.workItems[0].criterionIds = ['source-review'];
    contract.workItems[0].effects = ['observe'];
  }) };
  const planRef = { ...f.run.responseCycle.planRef, cycleId: 'revised-cycle', responseId: 'revised-plan' };
  const { snapshot } = await adoptExecutionPlanContract({ store: f.tasks, taskId, runId: 'revised-run', nodeId: 'agent',
    getSource: async () => ({ planRef, plan, sha256: executionOutlineHash(plan), requiredCriterionIds: ['source-review'] }) });
  assert.equal(snapshot.contract.goal, plan.contract.goal);
  assert.deepEqual(snapshot.contractAdoption.planRef, planRef);
  assert.deepEqual(snapshot.contractAdoption.requiredCriterionIds, ['source-review']);
  assert.equal((await refine(snapshot, contract => { contract.criteria[0].description = 'Read a different source.'; })).code, 'TASK_CONTRACT_CRITERION_CHANGE');
});
