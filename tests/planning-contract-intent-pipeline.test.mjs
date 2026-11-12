import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';
import { createTaskToolHandler, TaskStateStore } from '../lib/task-state.mjs';
import { PlanningBrowserStore } from '../lib/planning-browser.mjs';
import { PlanningBrowserRuntime } from '../lib/planning-browser-runtime.mjs';
import { ResponseCycleService } from '../lib/response-cycle.mjs';
import { AttachmentStore, createAttachmentToolHandler } from '../lib/attachments.mjs';
import { attachmentResourceKey, attachmentSetResourceKey } from '../lib/operation-descriptors.mjs';
import { readContractJournal } from '../lib/planning-contract-runtime.mjs';
import { createPlanningWorkerGuard, wrapPlanningToolHandler } from '../lib/planning-awareness.mjs';
import { normalizePlanContractResponse } from '../public/planning-contract-model.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';

// Old automatic inference/feasibility/adoption is retired. These fixtures retain
// the independent attachment, saved intent, ownership and proof boundaries and
// assert that retired admission cannot invoke a provider or mutate its archive.
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

const payload = value => JSON.parse(value.contentItems.find(item => item.type === 'inputText').text);
function contractFor(cwd) {
  return { contractVersion: 2, goal: request,
    criteria: requiredCriteria.map(item => ({ id: item.id, label: item.label, description: item.description,
      kind: item.verification === 'effect' ? 'external-confirmation' : 'judgment',
      targetCount: item.verification === 'effect' ? 20 : 1, accuracy: copy(item.accuracy) })),
    workItems: [{ id: 'complete-applications', title: 'Complete the authorized applications', objective: request,
      owner: 'agent', resourceKeys: ['origin:https://applications.example.invalid', 'workspace:' + (process.platform === 'win32' ? cwd.replaceAll('\\\\', '/').toLowerCase() : cwd)],
      effects: ['observe', 'interact', 'commit'], dependsOn: [], criterionIds: requiredCriteria.map(item => item.id) }],
    instructions: [{ id: 'city-alternatives', text: locationPermission, handling: 'preserve' }] };
}
async function fixture(t, execute = async () => ({ output: 'No application was submitted.' })) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-intent-pipeline-')), cwd = path.join(directory, 'workspace'); await mkdir(cwd);
  const tasks = await new TaskStateStore({ dataDir: directory }).init(), store = await new PlanningBrowserStore({ dataDir: directory }).init();
  const attachments = await new AttachmentStore({ dataDir: directory }).init(), calls = [];
  class Runtime extends EventEmitter {
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture-intent', models: [{ id: 'fixture-intent', supportsTools: true }] }; }
    async runAgent(options) { calls.push(options); assert.notEqual(options.responseOnly, true, 'No automatic analytical stage is permitted.'); return execute(options); }
    async close() {}
  }
  const runtime = new Runtime(), engine = await new HarnessEngine({ runtime, tasks, attachments, dataDir: directory, defaultCwd: cwd }).init();
  engine.runtimeSettings = { get: () => ({ executionGuardrails: true, subagentsEnabled: false }) };
  const runner = new PlanningBrowserRuntime({ store, runtime, defaultCwd: cwd, getSettings: () => ({ subagentsEnabled: false }) });
  const service = new ResponseCycleService({ store, runner, engine }); engine.responseCycle = service;
  t.after(async () => { await engine.close(); await runner.close(); await service.close(); await store.close(); await tasks.close(); await attachments.close(); await rm(directory, { recursive: true, force: true }); });
  const workflow = createMissionWorkflow({ id: 'intent-pipeline', task: request, model: 'fixture-intent', cwd, planningMode: 'forced' });
  return { directory, cwd, tasks, store, attachments, engine, runner, service, calls, workflow };
}
async function historicalContract(t, { prerequisite = false } = {}) {
  const f = await fixture(t), taskId = 'saved-intent', runId = 'saved-run';
  await f.tasks.ensure({ taskId, runId, nodeId: 'agent', cwd: f.cwd, goal: request, schemaVersion: 14 });
  const initial = await f.tasks.get(taskId), contract = contractFor(f.cwd);
  if (prerequisite) {
    contract.criteria.push({ id: 'authorized-city', kind: 'judgment', label: 'Authorized city alternatives', description: 'Authorized city alternatives', targetCount: 1, accuracy: copy(requiredCriteria[1].accuracy) });
    contract.workItems.push({ ...copy(contract.workItems[0]), id: 'inspect-prerequisite', effects: ['observe'], criterionIds: ['authorized-city'] });
    contract.workItems[0].dependsOn = ['inspect-prerequisite'];
  }
  const planRef = { requestId: 'historical-request', cycleId: 'historical-cycle', nodeId: 'plan', responseId: 'saved-plan', responseRevision: 1 };
  // Seed only already-saved host provenance. This is not cycle admission.
  await f.tasks.setContract(taskId, contract, { expectedRevision: initial.revision, runId, nodeId: 'agent', schemaVersion: 14,
    adoption: { version: 1, contractVersion: 2, taskId, runId, nodeId: 'agent', planRef,
      requiredCriterionIds: contract.criteria.map(item => item.id), commitPrerequisiteIds: prerequisite ? ['authorized-city'] : [] } });
  const task = await f.tasks.get(taskId);
  return { ...f, task, run: { id: runId, taskId }, adoptedTask: task };
}

for (const location of ['request', 'workflow', 'input']) test('saved Plan-only in ' + location + ' rejects before any provider, task or cycle admission', async t => {
  const f = await fixture(t, async () => { assert.fail('Plan-only cannot enter an operational worker.'); });
  const value = { workflow: copy(f.workflow), input: request, planningMode: 'forced', planningExecutionMode: 'automatic' };
  if (location === 'request') value.planningExecutionMode = 'plan_only';
  if (location === 'workflow') value.workflow.settings.planningExecutionMode = 'plan_only';
  if (location === 'input') { delete value.planningExecutionMode; value.input = { task: request, planningExecutionMode: 'plan_only' }; }
  assert.throws(() => f.engine.startRun(value), { code: 'PLANNING_EXECUTION_MODE_RETIRED', status: 400 });
  assert.equal(f.calls.length, 0); assert.deepEqual(f.engine.listRuns(), []); assert.equal((await f.store.list()).requests.length, 0);
});

test('ordinary admission rejects an unreviewed final without a retired cycle or fabricated outcomes', async t => {
  const f = await fixture(t, async options => {
    assert.match(options.prompt, /Oak Hollow or Harbor City/);
    assert.equal(typeof options.onBeforeFinal, 'function');
    const state = payload(await options.onToolCall({ name: 'relay_task', arguments: { action: 'read' }, callId: 'read-current' }));
    assert.equal(state.contract, undefined);
    return { output: 'No applications have been performed by this fixture.' };
  });
  const accepted = f.engine.startRun({ workflow: f.workflow, input: request, planningMode: 'forced', planningExecutionMode: 'automatic' });
  await f.engine.executions.get(accepted.id); const run = f.engine.getRun(accepted.id);
  assert.equal(run.status, 'failed'); assert.equal(run.errorCode, 'MODULAR_OUTCOME_INCOMPLETE'); assert.equal(f.calls.length, 1);
  assert.equal(run.responseCycle, undefined); assert.equal(run.viability, undefined); assert.equal(run.nodes.agent.planning.status, 'off');
  const journal = await readContractJournal(f.tasks, run.taskId); assert.deepEqual(journal.records, []); assert.deepEqual(journal.evidence, []);
  assert.equal((await f.store.list()).requests.length, 0);
});

async function attachmentFixture(t, { second = false } = {}) {
  const f = await fixture(t), attached = await f.attachments.importBytes({ name: 'demo-profile.txt', bytes: Buffer.from('Bounded attached profile fixture.') });
  const guidance = second ? await f.attachments.importBytes({ name: 'demo-guidance.txt', bytes: Buffer.from('Bounded attached guidance fixture.') }) : null;
  const unattached = await f.attachments.importBytes({ name: 'unattached.txt', bytes: Buffer.from('Not attached to this task.') });
  const files = [attached, guidance].filter(Boolean), scope = { tool: 'relay_files', effect: 'observe', resourceKey: attachmentSetResourceKey(files.map(file => file.id)),
    files: files.map(file => ({ id: file.id, name: file.name, resourceKey: attachmentResourceKey(file.sha256) })) };
  const authored = contractFor(f.cwd);
  authored.criteria.push({ id: 'attached-profile', kind: second ? 'observation' : 'source-coverage', description: 'Read the immutable attached profile.', resourceKey: attachmentResourceKey(attached.sha256) });
  authored.workItems.push({ id: 'inspect-attachment', title: 'Read the attached profile', objective: 'Read the supplied attachments.', owner: 'agent',
    resourceKeys: second ? [attachmentResourceKey(attached.sha256).slice(0, -7), attachmentResourceKey(guidance.sha256)] : [authored.workItems[0].resourceKeys[1]],
    effects: ['observe'], dependsOn: [], criterionIds: ['attached-profile'] });
  const contract = normalizePlanContractResponse(authored, undefined, { attachedReadScope: scope, coordinator: 'agent' });
  const taskId = 'attachment-intent', runId = 'attachment-run', nodeId = 'agent';
  await f.tasks.ensure({ taskId, runId, nodeId, cwd: f.cwd, goal: request, schemaVersion: 14 });
  const initial = await f.tasks.get(taskId);
  await f.tasks.setContract(taskId, contract, { expectedRevision: initial.revision, runId, nodeId, schemaVersion: 14 });
  const adapter = createAttachmentToolHandler({ store: f.attachments, attachmentIds: files.map(file => file.id), cwd: f.cwd });
  const guard = await createPlanningWorkerGuard({ store: f.tasks, taskId, runId, nodeId, cwd: f.cwd, schemaVersion: 14, executionGuardrails: true,
    coordinator: true, getOperationAdapter: () => adapter });
  const taskHandler = createTaskToolHandler({ store: f.tasks, taskId, runId, nodeId, schemaVersion: 14, executionGuardrails: true });
  const invoke = wrapPlanningToolHandler(guard, async (call, context = {}) => {
    const denied = await guard.before(call, context); if (denied) return denied;
    context = guard.dispatchContext(call, context); await guard.dispatchFallback(call, context);
    return call.name === 'relay_task' ? guard.after(call, await taskHandler(call, context)) : adapter(call, context);
  });
  const readCall = { name: 'relay_task', arguments: { action: 'read' }, callId: 'read-current-contract' };
  const readReceipt = await invoke(readCall);
  assert.equal(readReceipt.success, true, JSON.stringify(readReceipt)); guard.observeToolDelivery({ call: readCall, result: readReceipt });
  t.after(() => guard.finish('finished'));
  const send = async (action, file = attached) => {
    const call = { name: 'relay_files', arguments: { action, attachmentId: file.id }, callId: randomUUID() };
    const result = await invoke(call); guard.observeToolDelivery({ call, result }); return result;
  };
  return { ...f, taskId, attached, guidance, unattached, scope, contract, send, adapter };
}

test('retained explicit attachment protection records actual source coverage without an automatic pipeline', async t => {
  const f = await attachmentFixture(t);
  const read = await f.send('read'); assert.equal(read.success, true, JSON.stringify(read)); assert.match(JSON.stringify(read), /Bounded attached profile/);
  const denied = await f.send('export'); assert.equal(denied.code, 'TASK_CONTRACT_SCOPE');
  await assert.rejects(f.adapter({ name: 'relay_files', arguments: { action: 'read', attachmentId: f.unattached.id } }), /not attached to the current task/);
  const journal = await readContractJournal(f.tasks, f.taskId);
  assert.equal(journal.records.length, 1); assert.equal(journal.records[0].tool, 'relay_files'); assert.equal(journal.records[0].workItemId, 'inspect-attachment');
  assert.ok(journal.evidence.some(item => item.kind === 'source-coverage' && item.resourceKey === attachmentResourceKey(f.attached.sha256) && item.sourceVersion === f.attached.sha256 && item.coverage.end === item.coverage.total));
  assert.equal(f.calls.length, 0);
});

test('attachment scope repair preserves the correct independent key and does not broaden another owner', async t => {
  const f = await attachmentFixture(t, { second: true }), reader = f.contract.workItems.find(item => item.id === 'inspect-attachment');
  assert.ok(reader.resourceKeys.includes(f.scope.resourceKey)); assert.ok(reader.resourceKeys.includes(attachmentResourceKey(f.guidance.sha256)));
  assert.ok(!reader.resourceKeys.includes(attachmentResourceKey(f.attached.sha256).slice(0, -7)));
  assert.ok(f.contract.workItems.filter(item => item.id !== reader.id).every(item => !item.resourceKeys.includes(f.scope.resourceKey)));
  assert.equal((await f.send('read')).success, true); assert.equal((await f.send('read', f.guidance)).success, true);
  const journal = await readContractJournal(f.tasks, f.taskId);
  assert.deepEqual(journal.records.map(item => [item.tool, item.effect, item.workItemId]), [['relay_files', 'observe', 'inspect-attachment'], ['relay_files', 'observe', 'inspect-attachment']]);
  assert.deepEqual(journal.evidence.filter(item => item.kind === 'source-coverage').map(item => [item.resourceKey, item.sourceVersion]), [f.attached, f.guidance].map(file => [attachmentResourceKey(file.sha256), file.sha256]));
  assert.equal(f.calls.length, 0);
});

test('retired cycle methods preserve archived user tolerance and pending effect proof byte for byte', async t => {
  const f = await fixture(t);
  await f.store.create({ id: 'archived-intent', conversationId: 'saved-conversation', title: 'Saved application intent', objective: request, cwd: f.cwd });
  await f.store.addNode('archived-intent', { id: 'plan', kind: 'plan', title: 'Saved Plan' });
  const file = f.store.file('archived-intent'), raw = JSON.parse(await readFile(file, 'utf8'));
  raw.responseCycle = { version: 1, rootCycleId: 'saved-cycle', cycles: [] };
  f.store._validate(raw); await writeFile(file, JSON.stringify(raw)); const before = await readFile(file);
  for (const operation of [
    () => f.service.createCycle('archived-intent', {}), () => f.service.runCycle('archived-intent', 'saved-cycle', {}),
    () => f.service.editPlan('archived-intent', 'saved-cycle', {}), () => f.service.continueCycle('archived-intent', 'saved-cycle', {}),
    () => f.runner.start({ requestId: 'archived-intent', nodeId: 'plan', expectedNodeRevision: 1, automatic: false, clientRequestId: 'do-not-run' })
  ]) await assert.rejects(async () => operation(), { code: 'PLANNING_CYCLE_RETIRED', status: 410 });
  const saved = await f.store.get('archived-intent'); assert.equal(saved.objective, request);
  assert.deepEqual(await readFile(file), before); assert.equal(f.calls.length, 0); assert.equal(f.runner.status().activeCount, 0);
});

test('historical canonical intent preserves authorized city alternatives without inventing application proof', async t => {
  const f = await historicalContract(t), contract = f.task.contract;
  assert.equal(contract.goal, request); assert.equal(contract.criteria[0].kind, 'external-confirmation'); assert.equal(contract.criteria[0].targetCount, 20);
  assert.deepEqual(contract.criteria[0].accuracy, requiredCriteria[0].accuracy); assert.equal(contract.criteria[0].receiptBinding, undefined);
  assert.equal(contract.criteria[1].description, locationPermission); assert.deepEqual(contract.criteria[1].accuracy, requiredCriteria[1].accuracy);
  assert.equal(f.task.contractRuntime.criteria[0].observedCount, 0); assert.ok(f.task.contractRuntime.criteria.every(item => item.satisfied === false));
  assert.deepEqual(f.task.contractRuntime.outcomes, []); assert.equal(f.calls.length, 0);
});

test('saved prerequisite remains required through an operational edit with no provider or cycle execution', async t => {
  const f = await historicalContract(t, { prerequisite: true });
  assert.deepEqual(f.task.contractAdoption.commitPrerequisiteIds, ['authorized-city']);
  const { planEpoch, ...contract } = copy(f.task.contract); contract.workItems[0].dependsOn = [];
  await assert.rejects(f.tasks.setContract(f.run.taskId, contract, { expectedRevision: f.task.revision, schemaVersion: 14 }),
    { code: 'TASK_CONTRACT_INVALID', message: /make every committing item wait/ });
  assert.equal((await f.tasks.get(f.run.taskId)).revision, f.task.revision); assert.equal(f.calls.length, 0);
});

test('historically adopted intent cannot be narrowed by an agent while explicit human revisions remain authoritative', { timeout: 20000 }, async t => {
  const f = await historicalContract(t);
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

  assert.equal((await readContractJournal(f.tasks, taskId)).records.length, 0);
  assert.deepEqual((await f.tasks.get(taskId)).contractRuntime.outcomes, []);
  assert.equal(f.calls.length, 0, 'Historical contract edits must not start any provider or revive a cycle.');
});

// Pure normalization of retained authoring data is independent of any cycle.
test('retained authoring separates a commit prerequisite from a committing work item', () => {
  const contract = contractFor('/fixture'), prerequisite = { id: 'authorized-city', label: 'Authorized city alternatives',
    description: locationPermission, accuracy: copy(requiredCriteria[1].accuracy) };
  contract.workItems[0].criterionIds.push(prerequisite.id);
  const normalized = normalizePlanContractResponse(contract, [prerequisite]);
  const check = normalized.workItems.find(item => item.criterionIds.includes(prerequisite.id));
  assert.deepEqual(check.effects, ['observe']);
  const commit = normalized.workItems.find(item => item.effects.includes('commit'));
  assert.deepEqual(commit.dependsOn, [check.id]); assert.ok(!commit.criterionIds.includes(prerequisite.id));
  assert.equal(normalized.criteria.find(item => item.id === 'applications-confirmed').targetCount, 20);
});

test('a namespaced historical prerequisite cannot overwrite an inherited observation with the original ID', () => {
  const contract = contractFor('/fixture'); contract.criteria[1].kind = 'observation';
  const prerequisite = { id: 'prerequisite-city-permission', label: 'Authorized city alternatives',
    description: locationPermission, accuracy: copy(requiredCriteria[1].accuracy) };
  const normalized = normalizePlanContractResponse(contract, [prerequisite]);
  assert.equal(normalized.criteria.find(item => item.id === 'city-permission').kind, 'observation');
  assert.equal(normalized.criteria.find(item => item.id === prerequisite.id).kind, 'judgment');
  assert.deepEqual(normalized.criteria.find(item => item.id === 'city-permission').accuracy, requiredCriteria[1].accuracy);
  const check = normalized.workItems.find(item => item.criterionIds.includes(prerequisite.id));
  assert.deepEqual(check.effects, ['observe']);
  assert.ok(normalized.workItems.find(item => item.effects.includes('commit')).dependsOn.includes(check.id));
});
