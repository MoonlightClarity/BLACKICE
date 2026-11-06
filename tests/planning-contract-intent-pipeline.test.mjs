import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';
import { TaskStateStore } from '../lib/task-state.mjs';
import { PlanningBrowserStore } from '../lib/planning-browser.mjs';
import { PlanningBrowserRuntime } from '../lib/planning-browser-runtime.mjs';
import { TaskViability } from '../lib/task-viability.mjs';
import { ResponseCycleService } from '../lib/response-cycle.mjs';
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

function analyticalResponse(input, { strictCity = false, workspaceKey } = {}) {
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
      inferable: false, omissionAllowed: false, question: '', dependentNodeIds: ['agent'], stopKind: null, accuracy: copy(requiredCriteria[1].accuracy) }] };
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
  }
  return body;
}

async function fixture(t, { mode = 'plan_only', strictCity = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-intent-pipeline-')), cwd = path.join(directory, 'workspace');
  await mkdir(cwd);
  const tasks = await new TaskStateStore({ dataDir: directory }).init();
  const store = await new PlanningBrowserStore({ dataDir: directory }).init();
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
        return { output: JSON.stringify(analyticalResponse(input, { strictCity, workspaceKey })), threadId: 'fixture-intent-planning', turnId: randomUUID() };
      }
      operationalCalls++;
      assert.equal(mode, 'automatic', 'Plan only must never enter an operational worker.');
      assert.ok(JSON.stringify(options).includes(JSON.stringify(TASK_ACCURACY_SCOPE_GUIDANCE).slice(1, -1)), 'The actual worker receives canonical execution guidance.');
      const call = { name: 'relay_task', arguments: { action: 'read' }, callId: randomUUID() }; toolCalls.push([call.name, call.arguments.action]);
      const result = await options.onToolCall(call, { signal: options.signal });
      await options.onToolResultDelivered?.({ call, result });
      assert.equal(result.success, true, JSON.stringify(result));
      adoptedTask = JSON.parse(result.contentItems.find(item => item.type === 'inputText').text);
      finalCheck = await options.onBeforeFinal({ output: 'No applications have been performed by this fixture.' });
      assert.equal(finalCheck?.continue, true, 'Permitted city tolerance cannot satisfy the unperformed application count or receipt requirements.');
      throw Object.assign(new Error('Fixture stopped after inspecting the canonical handoff; no application operation was dispatched.'), { code: 'FIXTURE_STOP_AFTER_HANDOFF' });
    }
    async close() {}
  }
  const runtime = new Runtime();
  engine = await new HarnessEngine({ runtime, tasks, dataDir: directory, defaultCwd: cwd }).init();
  engine.runtimeSettings = { get: () => settings };
  const runner = new PlanningBrowserRuntime({ store, runtime, defaultCwd: cwd, getSettings: () => settings });
  const viability = new TaskViability({ store, runner, engine, identity: { read: async () => ({ content: 'No personal profile or external result is supplied by this deterministic fixture.' }) }, getSettings: () => settings });
  const service = new ResponseCycleService({ store, runner, taskViability: viability, engine, getSettings: () => settings });
  engine.responseCycle = service;
  t.after(async () => { await engine.close(); await runner.close(); await service.close(); await viability.close(); await store.close(); await tasks.close(); await rm(directory, { recursive: true, force: true }); });
  const workflow = createMissionWorkflow({ id: 'intent-pipeline', task: request, model: 'fixture-intent', cwd, planningMode: 'forced' });
  const accepted = engine.startRun({ workflow, input: request, planningMode: 'forced', planningExecutionMode: mode, requestId: 'intent-pipeline-' + mode + '-' + strictCity });
  await engine.executions.get(accepted.id);
  const run = engine.getRun(accepted.id), saved = await store.get(run.responseCycle.requestId), cycle = saved.cycles.find(item => item.id === run.responseCycle.cycleId);
  return { run, saved, cycle, calls, operationalCalls, toolCalls, adoptedTask, finalCheck,
    journal: await readContractJournal(tasks, run.taskId), task: operationalCalls ? await tasks.get(run.taskId) : null };
}

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
  assertIntentAndProofBoundary(f.adoptedTask.contract);
  assert.equal(f.task.contractAdoption.planRef.responseId, f.run.responseCycle.planRef.responseId);
  assert.equal(f.adoptedTask.contractRuntime.criteria.find(item => item.id === 'applications-confirmed').observedCount, 0);
  assert.equal(f.adoptedTask.contractRuntime.criteria.every(item => item.satisfied === false), true);
  assert.equal(f.journal.records.length, 0); assert.equal(f.journal.evidence.length, 0);
  assert.deepEqual(f.adoptedTask.contractRuntime.outcomes, []);
});
