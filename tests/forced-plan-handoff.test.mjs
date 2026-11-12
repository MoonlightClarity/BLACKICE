import { fixtureOutcomeReview, finishFixtureCandidate } from './fixture-modular-provider.mjs';
// Explicit schema-13 handoff/schema regression; ordinary Engine turns no longer invoke forced Planning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from './fixture-legacy-planning-engine.mjs';
import { MethodStore } from '../lib/methods.mjs';
import { normalizeTaskPlan } from '../lib/task-plan.mjs';
import { TaskStateStore, createTaskToolHandler, TASK_TOOL } from './fixture-legacy-task-state.mjs';
import { prepareExecutionPlanHandoff, executionOutlineHash } from '../lib/planning-execution-handoff.mjs';
import { PlanningBrowserStore } from '../lib/planning-browser.mjs';
import { PlanningBrowserRuntime } from '../lib/planning-browser-runtime.mjs';
import { TaskViability } from '../lib/task-viability.mjs';
import { ResponseCycleService } from '../lib/response-cycle.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';
import { normalizeOutputSchema, validateResponseOnlyOptions } from '../lib/response-profile.mjs';

const request = 'List the files in the current workspace.';
const payload = receipt => JSON.parse(receipt.contentItems.find(item => item.type === 'inputText').text);
const tool = (options, name, args, callId) => options.onToolCall({ name, arguments: args, callId });
const captured = options => JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n') + 2));
function executionLeaf() {
  return {
    id: 'inspect-workspace', title: 'List the current workspace entries', kind: 'action', parentId: null, status: 'active',
    operation: { kind: 'tool', tool: 'relay_workspace', action: 'list', target: '.' },
    result: 'The actual directory entries returned for the current workspace.',
    note: 'Call relay_workspace list once for path "." and inspect its returned entries.',
    doneWhen: 'The actual list receipt identifies the current workspace and its entries; no entry is invented.'
  };
}

function assertOperationalChoices(handoff) {
  const { input, options } = handoff;
  const step = options.outputSchema.properties.steps.items;
  const historical = input.currentTask.steps.filter(saved => (saved.kind || 'action') === 'action' && ['done', 'skipped'].includes(saved.status));
  const operation = historical.length ? step.allOf.at(-1).anyOf[0].properties.operation : step.properties.operation;
  const choices = operation.anyOf.filter(choice => choice.properties?.kind?.const === 'tool');
  assert.deepEqual(choices.map(choice => choice.properties.tool.enum?.[0]).sort(), input.tools.map(tool => tool.name).sort(),
    'The provider schema must admit exactly the advertised current operational tools.');
  for (const tool of input.tools) {
    const choice = choices.find(choice => choice.properties.tool.enum?.[0] === tool.name);
    assert.deepEqual(choice.properties.tool.enum, [tool.name], 'Each schema branch binds its own tool identity.');
    assert.equal(choice.additionalProperties, false);
    const action = tool.inputSchema?.properties?.action;
    if (action) {
      assert.ok(choice.required.includes('action'), 'A tool with an action field must require that field in its operation descriptor.');
      if (action.enum) assert.deepEqual(choice.properties.action.enum, action.enum,
        'One tool must not borrow another tool’s actions.');
    } else {
      assert.equal(choice.properties.action, undefined, 'Actionless tools must not advertise invented action fields.');
      assert.ok(!choice.required.includes('action'));
    }
  }
  assert.deepEqual(operation.anyOf.filter(choice => choice.properties?.kind?.const === 'reasoning'),
    input.taskPlanSchema.properties.steps.items.properties.operation.anyOf.filter(choice => choice.properties?.kind?.const === 'reasoning'),
    'Operational catalog projection must preserve the original bounded reasoning operation grammar.');
  if (historical.length) {
    const exception = step.allOf.at(-1).anyOf[1];
    assert.deepEqual(exception.required, ['id', 'status']);
    assert.deepEqual(exception.properties.id.enum, historical.map(saved => saved.id),
      'Only already saved terminal IDs receive historical compatibility.');
    assert.deepEqual(exception.properties.status.enum, ['done', 'skipped'],
      'Historical compatibility cannot authorize active new work with a detached tool.');
  }
}

async function completeListing(options, context) {
  const receipt = await context.operation(options, { action: 'list', path: '.' });
  assert.equal(receipt.success, true, receipt.contentItems?.[0]?.text);
  assert.ok(payload(receipt).entries.some(entry => entry.name === 'input.txt'));
  return { output: 'The current workspace contains input.txt.' };
}

async function fixture(t, { execute, withPlanning = true } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-forced-handoff-'));
  const cwd = path.join(directory, 'workspace');
  await mkdir(cwd);
  await writeFile(path.join(cwd, 'input.txt'), 'A real fixture file.\n');
  const tasks = await new TaskStateStore({ dataDir: directory }).init();
  const store = await new PlanningBrowserStore({ dataDir: directory }).init();
  const settings = { defaultModel: 'fixture-handoff', defaultEffort: 'low', executionGuardrails: false, runTimeoutMs: null };
  const observations = { analyticalStages: [], handoffs: [], operationalCalls: 0, operations: [] };
  let context;
  class Runtime extends EventEmitter {
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture-handoff', models: [{ id: 'fixture-handoff', supportsTools: true }] }; }
    async runAgent(options) {
      const review = fixtureOutcomeReview(options); if (review) return review;
      assert.notEqual(options.responseOnly, true, 'Ordinary Engine work must not dispatch retired analytical or handoff turns.');
      observations.operationalCalls++;
      const run = context.engine.listRuns()[0], state = await tasks.get(run.taskId);
      observations.atWorkerEntry = { state, options, awareness: tasks.awareness.snapshot(state) };
      return finishFixtureCandidate(options, execute ? await execute(options, context, state) : { output: 'No fixture operation requested.' });
    }
    async close() {}
  }
  const runtime = new Runtime();
  const engine = await new HarnessEngine({ runtime, tasks, dataDir: directory, defaultCwd: cwd }).init();
  engine.runtimeSettings = { get: () => settings };
  const runner = new PlanningBrowserRuntime({ store, runtime, defaultCwd: cwd, getSettings: () => settings });
  const viability = new TaskViability({
    store, runner, engine, identity: { read: async () => ({ content: 'The user requested a bounded local workspace inspection.' }) },
    getSettings: () => settings
  });
  const service = new ResponseCycleService({ store, runner, taskViability: viability, engine, getSettings: () => settings });
  if (withPlanning) engine.responseCycle = service;
  context = { directory, cwd, tasks, store, engine, runtime, observations, service, async operation(options, args) {
    const receipt = await tool(options, 'relay_workspace', args, 'ordinary-operation-' + observations.operations.length);
    const activeRun = engine.listRuns()[0], observedState = await tasks.get(activeRun.taskId);
    observations.operations.push({ args, receipt, awareness: tasks.awareness.snapshot(observedState) });
    return receipt;
  } };
  t.after(async () => {
    await engine.close(); await runner.close(); await service.close(); await viability.close(); await store.close(); await tasks.close();
    assert.match(path.basename(directory), /^blackice-forced-handoff-/);
    await rm(directory, { recursive: true, force: true });
  });
  context.run = async () => {
    const workflow = createMissionWorkflow({ id: 'ordinary-forced-handoff', task: request, model: 'fixture-handoff', cwd, planningMode: 'forced' });
    const accepted = engine.startRun({ workflow, input: request, planningMode: 'forced', planningExecutionMode: 'automatic', requestId: 'ordinary-forced-handoff' });
    await engine.executions.get(accepted.id);
    return engine.getRun(accepted.id);
  };
  return context;
}

test('a legacy Forced request starts directly without analytical stages or native refinement', async t => {
  const f = await fixture(t, { execute: completeListing });
  const run = await f.run();
  assert.equal(run.status, 'completed', run.error);
  assert.equal(run.input, request);
  assert.equal(run.planningMode, 'off');
  assert.equal(f.observations.operationalCalls, 1);
  assert.deepEqual(f.observations.analyticalStages, []);
  assert.deepEqual(f.observations.handoffs, []);
  assert.deepEqual(f.observations.atWorkerEntry.state.steps, []);
  assert.equal(f.observations.atWorkerEntry.state.plan, undefined);
  assert.equal(run.responseCycle, undefined);
  assert.equal(run.nodes.agent.planningHandoff, undefined);
  assert.equal(f.observations.operations.length, 1);
  const receipt = f.observations.operations[0].receipt;
  assert.equal(receipt.success, true);
  assert.ok(payload(receipt).entries.some(entry => entry.name === 'input.txt'));
  assert.doesNotMatch(f.observations.atWorkerEntry.options.prompt, /ACCEPTED EXECUTION OUTLINE SNAPSHOT|NATIVE PLAN EXECUTION HANDOFF/);
});

test('an ordinary worker failure remains its actual cause without a synthetic planning retry', async t => {
  const f = await fixture(t, { execute: async () => { throw Object.assign(new Error('Fixture stops before a tool.'), { code: 'FIXTURE_BEFORE_TOOL' }); } });
  const run = await f.run();
  assert.equal(run.status, 'failed'); assert.equal(run.errorCode, 'FIXTURE_BEFORE_TOOL');
  assert.equal(f.observations.operationalCalls, 1); assert.equal(f.observations.operations.length, 0);
  assert.deepEqual(f.observations.handoffs, []);
  assert.deepEqual(f.observations.atWorkerEntry.state.steps, []);
});

test('an explicitly prepared handoff preserves exact schema and snapshot without dispatch or read acknowledgment', async t => {
  const f = await referenceFixture(t), handoff = await f.prepare();
  assert.equal(handoff.metadata.state, 'prepared');
  assert.equal(f.observed.handoffs.length, 1);
  assertOperationalChoices(f.observed.handoffs[0]);
  const input = f.observed.handoffs[0].input;
  assert.ok(input.taskPlanSchema.$defs?.planExpression);
  assert.ok(JSON.stringify(input.taskPlanSchema.$defs.planExpression).includes('"$ref":"#/$defs/planExpression"'));
  assert.ok(input.tools.every(item => item.name !== 'relay_task'));
  assert.deepEqual(handoff.metadata.planRef, { requestId: 'reference-source', nodeId: 'reference-plan', nodeRevision: 1, responseId: 'reference-response' });
  assert.deepEqual(handoff.metadata.attempts[0].usage, { inputTokens: 29, outputTokens: 8, totalTokens: 37 });
  const state = await f.tasks.get(f.taskId);
  assert.deepEqual(handoff.snapshot.steps, state.steps); assert.equal(handoff.snapshot.revision, state.revision);
  assert.equal(handoff.snapshot.taskId, f.taskId);
  assert.match(handoff.metadata.snapshotSha256, /^[a-f0-9]{64}$/);
  assert.match(handoff.metadata.sourceSha256, /^[a-f0-9]{64}$/);
  const awareness = f.tasks.awareness.snapshot(state);
  const worker = awareness.workers.find(item => item.runId === f.runId && item.nodeId === f.nodeId);
  assert.ok(!worker || worker.lastReadRevision == null || worker.lastReadRevision < state.revision,
    'Saving an outline alone must not claim the new revision was read or executed.');
});

test('a human correction remains unread while ordinary execution no longer has a compulsory plan-review gate', async t => {
  const f = await fixture(t, { execute: async (options, context) => {
    let receipt = await tool(options, 'relay_task', { action: 'read' });
    let state = payload(receipt);
    receipt = await tool(options, 'relay_task', { action: 'plan', expectedRevision: state.revision,
      plan: { layout: 'sequence', detail: 'detailed', taskType: 'general' }, steps: [executionLeaf()] });
    assert.equal(receipt.success, true); state = payload(receipt);
    const changed = await context.tasks.editPlan(state.taskId, {
      operations: [{ type: 'update', stepId: 'inspect-workspace', patch: { note: 'A human correction to the optional inspection note.' } }]
    }, { expectedRevision: state.revision, source: 'human' });
    context.observations.changed = changed;
    const result = await context.operation(options, { action: 'list', path: '.' });
    assert.equal(result.success, true);
    const workers = context.tasks.awareness.snapshot(await context.tasks.get(state.taskId)).workers;
    const worker = workers.find(item => item.nodeId === 'agent');
    assert.ok(!worker || worker.lastReadRevision < changed.revision, 'Tool execution cannot pretend the later human correction was read.');
    return { output: 'The current workspace contains input.txt.' };
  } });
  const run = await f.run(); assert.equal(run.status, 'completed', run.error);
  assert.equal(run.taskState.steps[0].note, f.observations.changed.steps[0].note);
  assert.equal(run.taskState.steps[0].status, 'active', 'An answer cannot fabricate completion of optional authored steps.');
});

test('an optional listing outline does not veto an independent write or fabricate its completion', async t => {
  const f = await fixture(t, { execute: async (options, context) => {
    const initial = payload(await tool(options, 'relay_task', { action: 'read' }));
    const saved = await tool(options, 'relay_task', { action: 'plan', expectedRevision: initial.revision,
      plan: { layout: 'sequence', taskType: 'general' }, steps: [executionLeaf()] });
    assert.equal(saved.success, true);
    const receipt = await context.operation(options, { action: 'write', path: 'direct.txt', text: 'Actual direct write.' });
    assert.equal(receipt.success, true);
    return { output: 'Wrote direct.txt; the optional listing is not claimed complete.' };
  } });
  const run = await f.run(); assert.equal(run.status, 'completed', run.error);
  assert.equal(await readFile(path.join(f.cwd, 'direct.txt'), 'utf8'), 'Actual direct write.');
  assert.equal(run.taskState.steps[0].status, 'active');
});

test('direct tool-call idempotency retains its exact receipt without compulsory reconciliation leaves', async t => {
  const f = await fixture(t, { execute: async (options, context) => {
    const args = { action: 'write', path: 'once.txt', text: 'One original write.' };
    const first = await tool(options, 'relay_workspace', args, 'stable-write-once');
    assert.equal(first.success, true);
    await writeFile(path.join(context.cwd, 'once.txt'), 'Independent later edit.');
    const second = await tool(options, 'relay_workspace', args, 'stable-write-once');
    assert.deepEqual(second, first);
    assert.equal(await readFile(path.join(context.cwd, 'once.txt'), 'utf8'), 'Independent later edit.',
      'A replayed call must not repeat the original effect.');
    return { output: 'The original receipt was reused without repeating its write.' };
  } });
  const run = await f.run(); assert.equal(run.status, 'completed', run.error);
  assert.deepEqual(run.taskState.steps, []);
});

test('explicit handoff detects a changed accepted source before saving the proposed outline', async t => {
  const f = await referenceFixture(t);
  const before = await readFile(f.tasks.file(f.taskId), 'utf8');
  await assert.rejects(f.prepare({ getSource: (source, count) => count < 3 ? source : {
    ...source, planRef: { ...source.planRef, nodeRevision: 2, responseId: 'revised-response' }
  } }), { code: 'RESPONSE_CYCLE_PLAN_CONFLICT' });
  assert.equal(f.observed.handoffs.length, 1);
  assert.equal(await readFile(f.tasks.file(f.taskId), 'utf8'), before);
});

test('an explicit refinement transport failure is terminal and is not automatically replayed', async t => {
  const f = await referenceFixture(t);
  await assert.rejects(f.prepare({ respond: () => { throw Object.assign(new Error('Fixture refinement transport unavailable.'), { code: 'FIXTURE_PROVIDER_UNAVAILABLE' }); } }),
    { code: 'FIXTURE_PROVIDER_UNAVAILABLE' });
  assert.equal(f.observed.handoffs.length, 1); assert.equal(f.observed.planCalls.length, 0);
  assert.equal(f.observed.updates.at(-1).state, 'failed');
  assert.deepEqual((await f.tasks.get(f.taskId)).steps, []);
});

test('a source storage failure after explicit refinement is terminal without replaying the provider', async t => {
  const f = await referenceFixture(t);
  await assert.rejects(f.prepare({ getSource: (source, count) => {
    if (count > 2) throw Object.assign(new Error('Fixture source storage unavailable.'), { code: 'EIO' });
    return source;
  } }), { code: 'EIO' });
  assert.equal(f.observed.handoffs.length, 1); assert.equal(f.observed.planCalls.length, 0);
  assert.equal(f.observed.updates.at(-1).attempts[0].error.code, 'EIO');
  assert.deepEqual((await f.tasks.get(f.taskId)).steps, []);
});

test('an ordinary request needs no preparatory Plan or response-cycle service', async t => {
  const f = await fixture(t, { withPlanning: false, execute: completeListing });
  const run = await f.run(); assert.equal(run.status, 'completed', run.error);
  assert.deepEqual(f.observations.atWorkerEntry.state.steps, []);
  assert.equal(f.observations.operations[0].receipt.success, true);
  assert.equal(run.responseCycle, undefined);
});

for (const invalid of ['empty', 'stale']) test('explicit refinement rejects ' + invalid + ' content atomically', async t => {
  const f = await referenceFixture(t);
  const before = await readFile(f.tasks.file(f.taskId), 'utf8');
  await assert.rejects(f.prepare({ respond: input => {
    const response = referencePlan(input);
    if (invalid === 'empty') response.steps = []; else response.expectedRevision--;
    return response;
  } }), { code: 'TASK_PLAN_HANDOFF_FAILED' });
  assert.equal(f.observed.handoffs.length, 2, 'Only one repair follows a completed invalid response.');
  assert.equal(await readFile(f.tasks.file(f.taskId), 'utf8'), before);
});

test('explicit detached handoff schema preserves full recursive branch-expression validation', async t => {
  const f = await referenceFixture(t);
  await assert.rejects(f.prepare({ respond: input => ({ ...referencePlan(input), steps: [
    { id: 'route', title: 'Choose an inspection', kind: 'choice', parentId: null,
      branch: { if: { and: [] }, then: 'inspect-workspace', else: 'alternative-list' } },
    { ...executionLeaf(), parentId: 'route' },
    { ...executionLeaf(), id: 'alternative-list', parentId: 'route', status: 'pending' }
  ] }) }), error => error.code === 'TASK_PLAN_HANDOFF_FAILED' && error.cause?.code === 'INVALID_TASK_PLAN'
    && /nonempty bounded array of Boolean expressions/.test(error.cause.message));
  assert.equal(f.observed.handoffs.length, 2);
  assert.deepEqual((await f.tasks.get(f.taskId)).steps, []);
});

async function seedHistoricalOperation(f) {
  const initial = payload(await f.call({ action: 'read' }));
  const saved = await f.call({ ...referencePlan({ currentTask: initial }), steps: [{
    ...executionLeaf(), id: 'observed-prior-input', title: 'Read prior input',
    operation: { kind: 'tool', tool: 'relay_retired_reader', action: 'read', target: 'input.txt' }
  }] });
  assert.equal(saved.success, true, saved.contentItems?.[0]?.text);
  const observed = await readFile(path.join(f.cwd, 'input.txt'), 'utf8');
  const done = await f.call({ action: 'step', expectedRevision: payload(saved).revision,
    stepId: 'observed-prior-input', status: 'done', evidence: 'Prior reader returned input.txt: ' + JSON.stringify(observed) });
  assert.equal(done.success, true); return payload(done).steps[0];
}

test('explicit handoff preserves exact terminal history from a detached tool before optional new work', async t => {
  const f = await referenceFixture(t), historical = await seedHistoricalOperation(f);
  const handoff = await f.prepare({ respond: input => ({ ...referencePlan(input), steps: [...input.currentTask.steps, executionLeaf()] }) });
  assert.equal(f.observed.handoffs.length, 1); assertOperationalChoices(f.observed.handoffs[0]);
  assert.deepEqual(handoff.snapshot.steps.find(step => step.id === historical.id), historical);
  assert.deepEqual((await f.tasks.get(f.taskId)).steps.find(step => step.id === historical.id), historical);
  assert.equal(historical.status, 'done'); assert.match(historical.evidence, /Actual reference fixture input/);
});

for (const [invalid, message] of [
  ['bookkeeping', /attached operational tool|bookkeeping/],
  ['detached', /attached operational tool/],
  ['invalid-action', /actual relay_workspace action/],
  ['historical-rewrite', /historical|preserve|saved|operation/i]
]) test('explicit refinement rejects a ' + invalid + ' operation without dropping or rewriting evidence', async t => {
  const f = await referenceFixture(t);
  const historical = invalid === 'historical-rewrite' ? await seedHistoricalOperation(f) : null;
  const before = await readFile(f.tasks.file(f.taskId), 'utf8');
  await assert.rejects(f.prepare({ respond: input => {
    const response = { ...referencePlan(input), steps: [...structuredClone(input.currentTask.steps), executionLeaf()] };
    if (invalid === 'bookkeeping') response.steps.at(-1).operation = { kind: 'tool', tool: 'relay_task', action: 'read', target: f.taskId };
    if (invalid === 'detached') response.steps.at(-1).operation.tool = 'relay_retired_reader';
    if (invalid === 'invalid-action') response.steps.at(-1).operation.action = 'invented-action';
    if (invalid === 'historical-rewrite') response.steps[0].operation.target = 'rewritten-history.txt';
    return response;
  } }), error => error.code === 'TASK_PLAN_HANDOFF_FAILED' && error.cause?.code === 'TASK_PLAN_HANDOFF_INVALID' && message.test(error.cause.message));
  assert.equal(f.observed.handoffs.length, 2);
  assert.equal(await readFile(f.tasks.file(f.taskId), 'utf8'), before);
  if (historical) assert.deepEqual((await f.tasks.get(f.taskId)).steps[0], historical);
});

for (const inventedAction of [false, true]) test('an attached actionless tool ' + (inventedAction ? 'rejects an invented action' : 'remains expressible in the handoff schema'), async t => {
  const f = await fixture(t);
  const taskId = 'actionless-handoff', runId = 'actionless-run', nodeId = 'agent';
  await f.tasks.ensure({ taskId, runId, nodeId, cwd: f.cwd, goal: request, defaultPlan: true });
  const taskHandler = createTaskToolHandler({
    store: f.tasks, taskId, runId, nodeId, task: request,
    schemaVersion: 13, planningMode: 'on', executionGuardrails: true
  });
  const tools = [TASK_TOOL, {
    name: 'relay_actionless', description: 'Read the requested fixture path.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }
  }];
  const plan = { steps: [{ id: 'inspect-workspace', description: 'Inspect the current workspace through the attached path reader.' }] };
  const source = { planRef: { requestId: 'fixture-source', nodeId: 'fixture-plan', nodeRevision: 1, responseId: 'fixture-response' }, sha256: executionOutlineHash(plan), plan };
  const calls = [], updates = [];
  const runtime = { async runAgent(options) {
    validateResponseOnlyOptions(options);
    assert.deepEqual(normalizeOutputSchema(options.outputSchema), options.outputSchema);
    assert.equal(options.responseOnly, true);
    assert.deepEqual(options.dynamicTools, []);
    const input = captured(options), current = input.currentTask;
    calls.push({ options, input });
    assertOperationalChoices(calls.at(-1));
    const operation = { kind: 'tool', tool: 'relay_actionless', target: '.' };
    if (inventedAction) operation.action = 'invented-action';
    return { output: JSON.stringify({
      action: 'plan', expectedRevision: current.revision,
      plan: { layout: 'sequence', detail: 'detailed', taskType: 'general' },
      steps: [{ ...executionLeaf(), operation, note: 'Read the current fixture path with relay_actionless.' }]
    }) };
  } };
  const prepare = () => prepareExecutionPlanHandoff({
    runtime, taskHandler, taskId, runId, nodeId, cwd: f.cwd, context: request, tools,
    getSource: async () => source, model: 'fixture-handoff', effort: 'low', onUpdate: value => updates.push(value)
  });
  if (inventedAction) {
    await assert.rejects(prepare(), error => error.code === 'TASK_PLAN_HANDOFF_FAILED'
      && error.cause?.code === 'TASK_PLAN_HANDOFF_INVALID'
      && /actionless tool relay_actionless cannot use an invented action/.test(error.cause.message));
    assert.equal(calls.length, 2);
    assert.equal((await f.tasks.get(taskId)).steps.length, 0, 'Rejected actionless descriptors must not be saved.');
    assert.equal(updates.at(-1).state, 'failed');
  } else {
    const handoff = await prepare();
    assert.equal(calls.length, 1);
    assert.equal(handoff.metadata.state, 'prepared');
    assert.deepEqual(handoff.snapshot.steps[0].operation, { kind: 'tool', tool: 'relay_actionless', target: '.' });
  }
  assert.ok(calls.every(call => call.input.tools.length === 1 && call.input.tools[0].name === 'relay_actionless'),
    'Bookkeeping is excluded even when the sole operational tool is actionless.');
  assert.equal(f.observations.operationalCalls, 0, 'Schema/refinement tests must not dispatch an operational worker.');
});

function assertReferenceChoices(handoff) {
  const { input, options } = handoff, schema = options.outputSchema;
  assert.deepEqual(input.taskDescription.plan.inputSchema, input.taskPlanSchema);
  assert.equal(input.taskDescription.ontology, undefined, 'The normal schema-13 describe branch does not supply the reference catalog.');
  assert.deepEqual(schema.properties.plan.properties.taskType.enum, input.taskCatalog.ontology.taskTypes.map(item => item.id));
  assert.deepEqual(schema.properties.steps.items.properties.stepType.enum, input.taskCatalog.ontology.stepTypes.map(item => item.id));
  const observed = [...input.taskCatalog.methods, ...(input.existingMethod?.status === 'available' ? [input.existingMethod.description.method] : [])];
  const pairs = [...new Set(observed.map(item => item.id + ':' + item.revision))].sort();
  const methodObjects = schema.properties.plan.properties.method.anyOf.filter(item => item.properties?.id);
  assert.equal(methodObjects.length, 1, 'The original method object grammar should appear once in the bounded transport schema.');
  assert.deepEqual(methodObjects[0].required, ['id', 'revision']);
  assert.equal(methodObjects[0].additionalProperties, false);
  const variants = methodObjects[0].allOf.at(-1).anyOf;
  assert.deepEqual(variants.map(item => item.properties.id.enum[0] + ':' + item.properties.revision.enum[0]).sort(), pairs,
    'Method choices must bind observed IDs to their exact observed revisions.');
  for (const variant of variants) {
    assert.equal(variant.properties.id.enum.length, 1);
    assert.equal(variant.properties.revision.enum.length, 1);
  }
  assert.ok(schema.properties.plan.properties.method.anyOf.some(item => item.type === 'null'));
  const artifactSchema = schema.properties.steps.items.properties.artifactIds;
  if (input.currentTask.artifacts.length) assert.deepEqual(artifactSchema.items.enum, input.currentTask.artifacts.map(item => item.id));
  else assert.equal(artifactSchema.maxItems, 0, 'No saved artifacts means no artifact references may be proposed.');
  assert.equal(input.taskPlanSchema.properties.plan.properties.taskType.enum, undefined,
    'The authoritative general schema must remain intact; context belongs in the detached transport projection.');
  assert.equal(input.taskCatalog.methods.length, 40);
  assert.ok(input.taskCatalog.totalMethods > input.taskCatalog.methods.length);
  assert.ok(input.taskCatalog.catalogRevision);
  assert.deepEqual({ offset: input.taskCatalog.offset, limit: input.taskCatalog.limit, nextOffset: input.taskCatalog.nextOffset },
    { offset: 0, limit: 40, nextOffset: 40 }, 'The bounded method page must retain its real flat pagination fields.');
  assert.ok(Buffer.byteLength(JSON.stringify(schema), 'utf8') < 60000);
}

const referencePlan = input => ({
  action: 'plan', expectedRevision: input.currentTask.revision,
  plan: { layout: 'sequence', detail: 'detailed' }, steps: [executionLeaf()]
});
const referenceMethodDefinition = () => ({
  name: 'ZZZ retained fixture inspection', description: 'Inspect an actual fixture input.',
  taskType: 'analysis', inputs: [],
  steps: [{ id: 'inspect', title: 'Inspect the fixture input', type: 'analyze',
    instructions: 'Read the supplied fixture path and record its actual contents.',
    inputs: ['The fixture path'], result: 'The observed input contents.',
    checks: ['The finding identifies the actual fixture path.'] }]
});

async function referenceFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-handoff-references-')), cwd = path.join(directory, 'workspace');
  await mkdir(cwd); await writeFile(path.join(cwd, 'input.txt'), 'Actual reference fixture input.\n');
  const tasks = await new TaskStateStore({ dataDir: directory }).init();
  const projects = { definition() { assert.fail('Reference discovery must not prepare a project.'); }, create() { assert.fail('Reference discovery must not execute work.'); } };
  const libraries = [];
  let library = await new MethodStore({ dataDir: directory, projects }).init(), getError = null;
  libraries.push(library);
  const methods = {
    status: () => library.status(), ontology: () => library.ontology(), search: options => library.search(options),
    list: () => library.list(), get: id => { if (getError) throw getError; return library.get(id); }
  };
  const taskId = 'reference-task', runId = 'reference-run', nodeId = 'agent';
  await tasks.ensure({ taskId, runId, nodeId, cwd, goal: request, defaultPlan: true });
  const handler = createTaskToolHandler({ store: tasks, taskId, runId, nodeId, task: request, methods,
    schemaVersion: 13, planningMode: 'on', executionGuardrails: true });
  const observed = { handoffs: [], taskCalls: [], planCalls: [], updates: [] };
  const h = { directory, cwd, tasks, methods, taskId, runId, nodeId, observed,
    library: () => library,
    call: args => handler({ name: 'relay_task', arguments: args }),
    setGetError: error => { getError = error; },
    async removeCatalogEntry(kind, id) {
      // A valid independently saved catalog replacement models a real library
      // change without changing the task revision or fabricating a tool receipt.
      const file = library.file;
      await library.close();
      const saved = JSON.parse(await readFile(file, 'utf8'));
      const field = kind === 'method' ? 'methods' : 'types', before = saved[field].length;
      saved[field] = saved[field].filter(item => item.id !== id);
      assert.equal(saved[field].length, before - 1);
      await writeFile(file, JSON.stringify(saved));
      library = await new MethodStore({ dataDir: directory, projects }).init(); libraries.push(library);
      assert.equal(library.status().healthy, true);
    },
    async seedMethod(method) {
      const state = payload(await h.call({ action: 'read' }));
      const saved = await h.call({ ...referencePlan({ currentTask: state }), plan: { layout: 'sequence', detail: 'detailed', method: { id: method.id, revision: method.revision } } });
      assert.equal(saved.success, true, saved.contentItems?.[0]?.text);
      return payload(saved);
    },
    async prepare({ respond = input => referencePlan(input), beforePlan, encode = JSON.stringify, getSource = source => source } = {}) {
      const plan = { steps: [{ id: 'inspect-workspace', description: 'Inspect the actual current workspace.' }] };
      const source = { planRef: { requestId: 'reference-source', nodeId: 'reference-plan', nodeRevision: 1, responseId: 'reference-response' }, sha256: executionOutlineHash(plan), plan };
      const tools = [TASK_TOOL, { name: 'relay_workspace', description: 'Inspect the fixture workspace.',
        inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'read'] }, path: { type: 'string' } }, required: ['action'], additionalProperties: false } }];
      const taskHandler = async call => {
        if (call.arguments.action !== 'plan') {
          const receipt = await handler(call);
          observed.taskCalls.push({ args: structuredClone(call.arguments), receipt });
          return receipt;
        }
        const before = await readFile(tasks.file(taskId), 'utf8'), revisionBefore = (await tasks.get(taskId)).revision;
        if (beforePlan) await beforePlan(call.arguments, observed.planCalls.length + 1, h);
        const receipt = await handler(call);
        observed.planCalls.push({ args: structuredClone(call.arguments), receipt, before,
          after: await readFile(tasks.file(taskId), 'utf8'), revisionBefore, revisionAfter: (await tasks.get(taskId)).revision });
        return receipt;
      };
      const runtime = { async runAgent(options) {
        validateResponseOnlyOptions(options);
        assert.deepEqual(normalizeOutputSchema(options.outputSchema), options.outputSchema);
        assert.equal(options.responseOnly, true); assert.deepEqual(options.dynamicTools, []);
        const input = captured(options), observation = { input, options };
        observed.handoffs.push(observation);
        assertReferenceChoices(observation);
        const response = await respond(input, observed.handoffs.length, h);
        observation.proposed = structuredClone(response);
        observation.output = encode(response);
        return { output: observation.output, threadId: 'explicit-refinement-thread', usage: { inputTokens: 29, outputTokens: 8, totalTokens: 37 } };
      } };
      let sourceReads = 0;
      return prepareExecutionPlanHandoff({ runtime, taskHandler, taskId, runId, nodeId, cwd, context: request, tools,
        getSource: async () => getSource(source, ++sourceReads), model: 'fixture-handoff', effort: 'low', onUpdate: value => observed.updates.push(value) });
    }
  };
  t.after(async () => {
    for (const item of libraries) await item.close();
    await tasks.close();
    assert.match(path.basename(directory), /^blackice-handoff-references-/);
    await rm(directory, { recursive: true, force: true });
  });
  return h;
}

function assertAtomicRejectedPlan(observation, code) {
  assert.equal(observation.receipt.success, false);
  assert.equal(observation.receipt.code, code, observation.receipt.contentItems?.[0]?.text);
  assert.equal(observation.after, observation.before, 'A rejected candidate must not publish any task-file change.');
  assert.equal(observation.revisionAfter, observation.revisionBefore);
}

test('handoff supplies the real schema-13 reference catalog, exact choices, artifacts and truthful pagination', async t => {
  const h = await referenceFixture(t);
  const taskType = await h.library().createType({ id: 'fixture-task-type', kind: 'task', name: 'Fixture task', description: 'Inspect a fixture input.' });
  const stepType = await h.library().createType({ id: 'fixture-step-type', kind: 'step', name: 'Fixture observation', description: 'Inspect actual input.' });
  let state = await h.tasks.get(h.taskId);
  state = await h.tasks.addArtifact(h.taskId, { path: 'input.txt', title: 'Actual fixture input' }, { expectedRevision: state.revision, runId: h.runId, nodeId: h.nodeId });
  const artifact = state.artifacts[0];
  const result = await h.prepare({ respond: input => {
    const body = referencePlan(input); body.plan.taskType = taskType.id; body.steps[0].stepType = stepType.id; body.steps[0].artifactIds = [artifact.id]; return body;
  } });
  const handoff = h.observed.handoffs[0], calls = h.observed.taskCalls;
  const normal = calls.find(call => call.args.action === 'describe' && call.args.methodLimit === undefined);
  const catalog = calls.find(call => call.args.action === 'describe' && call.args.methodLimit === 40);
  assert.ok(normal && catalog, 'Use the supported normal and bounded-method describe requests.');
  assert.deepEqual(handoff.input.taskDescription, payload(normal.receipt));
  assert.deepEqual(handoff.input.taskCatalog, payload(catalog.receipt));
  assert.equal(result.snapshot.plan.taskType, taskType.id);
  assert.equal(result.snapshot.steps[0].stepType, stepType.id);
  assert.deepEqual(result.snapshot.steps[0].artifactIds, [artifact.id]);
  assert.equal(result.metadata.attempts.length, 1);
  t.diagnostic('Reference transport schema bytes: ' + Buffer.byteLength(JSON.stringify(handoff.options.outputSchema), 'utf8') + '; observed method page: ' + handoff.input.taskCatalog.methods.length);
});

for (const invalid of ['taskType', 'stepType', 'method', 'methodRevision', 'artifact']) test('unobserved ' + invalid + ' references are rejected before save and allow one corrected response', async t => {
  const h = await referenceFixture(t);
  const result = await h.prepare({ respond: (input, attempt) => {
    const body = referencePlan(input);
    if (attempt === 1) {
      if (invalid === 'taskType') body.plan.taskType = 'unobserved-task-type';
      if (invalid === 'stepType') body.steps[0].stepType = 'unobserved-step-type';
      if (invalid === 'method') body.plan.method = { id: 'unobserved-method', revision: 1 };
      if (invalid === 'methodRevision') body.plan.method = { id: input.taskCatalog.methods[0].id, revision: input.taskCatalog.methods[0].revision + 1 };
      if (invalid === 'artifact') body.steps[0].artifactIds = ['artifact_00000000-0000-0000-0000-000000000000'];
    }
    return body;
  } });
  assert.equal(h.observed.handoffs.length, 2);
  assert.equal(result.metadata.attempts[0].error.code, 'TASK_PLAN_HANDOFF_INVALID');
  assert.equal(result.metadata.attempts[1].status, 'completed');
  assert.equal(h.observed.planCalls.length, 1, 'The unobserved reference must not reach or mutate the actual task handler.');
  assert.equal(h.observed.planCalls[0].receipt.success, true);
  assert.equal(h.observed.taskCalls.filter(call => call.args.action === 'describe' && call.args.methodLimit === 40).length, 2,
    'Repair must refresh the actual supported catalog, not reuse an invented or stale page.');
});

test('unobserved reference repair remains bounded to two completed responses', async t => {
  const h = await referenceFixture(t);
  await assert.rejects(h.prepare({ respond: input => {
    const body = referencePlan(input); body.plan.taskType = 'unobserved-task-type'; return body;
  } }), { code: 'TASK_PLAN_HANDOFF_FAILED' });
  assert.equal(h.observed.handoffs.length, 2);
  assert.equal(h.observed.planCalls.length, 0);
  assert.equal((await h.tasks.get(h.taskId)).revision, 1);
});

for (const kind of ['task', 'step']) test('a real ' + kind + ' type catalog change causes an atomic rejection and one fresh repair', async t => {
  const h = await referenceFixture(t);
  const type = await h.library().createType({ id: 'changing-' + kind + '-type', kind, name: 'Changing fixture type', description: 'A fixture vocabulary entry.' });
  const result = await h.prepare({
    respond: (input, attempt) => {
      const body = referencePlan(input);
      if (attempt === 1) { if (kind === 'task') body.plan.taskType = type.id; else body.steps[0].stepType = type.id; }
      return body;
    },
    beforePlan: async (args, attempt) => { if (attempt === 1) await h.removeCatalogEntry('type', type.id); }
  });
  assertAtomicRejectedPlan(h.observed.planCalls[0], 'TASK_TYPE_MISSING');
  assert.equal(h.observed.planCalls.length, 2);
  assert.equal(h.observed.planCalls[1].receipt.success, true);
  assert.equal(result.metadata.attempts[0].error.code, 'TASK_TYPE_MISSING');
  const key = kind === 'task' ? 'taskTypes' : 'stepTypes';
  assert.ok(h.observed.handoffs[0].input.taskCatalog.ontology[key].some(item => item.id === type.id));
  assert.ok(!h.observed.handoffs[1].input.taskCatalog.ontology[key].some(item => item.id === type.id));
});

test('a saved method outside the bounded page receives one exact lookup and is preserved by omission', async t => {
  const h = await referenceFixture(t), page = h.library().search({ limit: 40 });
  const outside = h.library().list().find(method => !page.methods.some(item => item.id === method.id));
  assert.ok(outside, 'This fixture needs a real method beyond the first page.');
  const method = h.library().get(outside.id), before = await h.seedMethod(method);
  const result = await h.prepare();
  const input = h.observed.handoffs[0].input;
  assert.ok(!input.taskCatalog.methods.some(item => item.id === method.id));
  assert.equal(input.existingMethod.status, 'available');
  assert.deepEqual(input.existingMethod.reference, { id: method.id, revision: method.revision });
  const lookups = h.observed.taskCalls.filter(call => call.args.action === 'describe' && call.args.methodId);
  assert.equal(lookups.length, 1);
  assert.deepEqual(lookups[0].args, { action: 'describe', methodId: method.id, methodRevision: method.revision });
  assert.deepEqual(input.existingMethod.description, payload(lookups[0].receipt));
  assert.deepEqual(result.snapshot.plan.method, before.plan.method, 'Omitting method must retain previously saved metadata.');
});

for (const change of ['removed', 'revised']) test('a real method ' + change + ' after advertised context is rejected atomically and preserved truthfully on repair', async t => {
  const h = await referenceFixture(t), method = await h.library().create(referenceMethodDefinition()), before = await h.seedMethod(method);
  const expectedCode = change === 'removed' ? 'TASK_METHOD_MISSING' : 'TASK_METHOD_CONFLICT';
  const result = await h.prepare({
    respond: (input, attempt) => { const body = referencePlan(input); if (attempt === 1) body.plan.method = { id: method.id, revision: method.revision }; return body; },
    beforePlan: async (args, attempt) => {
      if (attempt !== 1) return;
      if (change === 'removed') await h.removeCatalogEntry('method', method.id);
      else await h.library().update(method.id, { expectedRevision: method.revision, description: 'A revised actual fixture method description.' });
    }
  });
  assertAtomicRejectedPlan(h.observed.planCalls[0], expectedCode);
  assert.equal(h.observed.planCalls[1].receipt.success, true);
  assert.equal(result.metadata.attempts[0].error.code, expectedCode);
  const second = h.observed.handoffs[1].input;
  assert.equal(second.existingMethod.status, 'unavailable');
  assert.equal(second.existingMethod.error.code, expectedCode);
  assert.ok(!second.taskCatalog.methods.some(item => item.id === method.id && item.revision === method.revision));
  assert.deepEqual(result.snapshot.plan.method, before.plan.method, 'Unavailable historical metadata must remain distinct from current selectable choices.');
});

test('an unmet prerequisite rejects atomically and permits one correctly ordered refinement', async t => {
  const h = await referenceFixture(t);
  const result = await h.prepare({ respond: (input, attempt) => {
    const body = referencePlan(input);
    body.steps = [{ ...executionLeaf(), id: 'first-observation', status: attempt === 1 ? 'pending' : 'active' },
      { ...executionLeaf(), id: 'dependent-observation', status: attempt === 1 ? 'active' : 'pending', dependsOn: ['first-observation'] }];
    return body;
  } });
  assertAtomicRejectedPlan(h.observed.planCalls[0], 'TASK_PLAN_PREREQUISITE');
  assert.equal(h.observed.planCalls[1].receipt.success, true);
  assert.equal(result.metadata.attempts[0].error.code, 'TASK_PLAN_PREREQUISITE');
  assert.equal(result.snapshot.steps.find(step => step.status === 'active').id, 'first-observation');
});

test('the actual handler rejects a missing artifact before commit without weakening artifact revision checks', async t => {
  const h = await referenceFixture(t), state = payload(await h.call({ action: 'read' })), body = referencePlan({ currentTask: state });
  body.steps[0].artifactIds = ['artifact_00000000-0000-0000-0000-000000000000'];
  const before = await readFile(h.tasks.file(h.taskId), 'utf8'), denied = await h.call(body);
  assert.equal(denied.code, 'TASK_PLAN_ARTIFACT_MISSING', denied.contentItems?.[0]?.text);
  assert.equal(await readFile(h.tasks.file(h.taskId), 'utf8'), before);
  assert.equal((await h.tasks.get(h.taskId)).revision, state.revision);
  delete body.steps[0].artifactIds;
  const corrected = await h.call(body);
  assert.equal(corrected.success, true, corrected.contentItems?.[0]?.text);
});

test('a generic method read failure after a completed valid response is terminal with no task change or replay', async t => {
  const h = await referenceFixture(t), method = await h.library().create(referenceMethodDefinition());
  await h.seedMethod(method);
  await assert.rejects(h.prepare({
    respond: input => { const body = referencePlan(input); body.plan.method = { id: method.id, revision: method.revision }; return body; },
    beforePlan: () => h.setGetError(Object.assign(new Error('Fixture method storage read failed.'), { code: 'METHOD_ERROR' }))
  }), { code: 'METHOD_ERROR' });
  assert.equal(h.observed.handoffs.length, 1, 'A general method/storage failure must not consume a repair or automatically replay the provider.');
  assert.equal(h.observed.planCalls.length, 1);
  assertAtomicRejectedPlan(h.observed.planCalls[0], 'METHOD_ERROR');
  assert.equal(h.observed.updates.at(-1).state, 'failed');
});

test('the legal maximum retained history and artifact IDs fit the real schema normalizer with exact method pairs', async t => {
  const h = await referenceFixture(t);
  let saved = await h.tasks.get(h.taskId);
  saved = await h.tasks.addArtifact(h.taskId, { path: 'input.txt', title: 'Actual fixture input' }, { expectedRevision: saved.revision, runId: h.runId, nodeId: h.nodeId });
  const observed = await readFile(path.join(h.cwd, 'input.txt'), 'utf8');
  const history = Array.from({ length: 199 }, (_, index) => ({
    ...executionLeaf(), id: ('prior-observation-' + String(index).padStart(3, '0') + '-').padEnd(120, 'x'),
    title: 'Retained fixture observation ' + index, status: 'done',
    evidence: 'The fixture input was observed as ' + JSON.stringify(observed)
  }));
  // This is an explicitly constructed retained-snapshot fixture, never a claim
  // about the live task. The actual plan normalizer checks its legal shape.
  const normalized = normalizeTaskPlan({ plan: saved.plan, steps: history }, { executionGuardrails: true });
  const snapshot = { ...saved, ...normalized, artifacts: Array.from({ length: 40 }, (_, index) => ({
    ...structuredClone(saved.artifacts[0]), id: ('artifact_' + String(index).padStart(2, '0') + '_').padEnd(120, 'a')
  })) };
  assert.equal(snapshot.steps.length, 199);
  assert.ok(snapshot.steps.every(step => step.id.length === 120 && step.status === 'done'));
  assert.ok(snapshot.artifacts.every(artifact => artifact.id.length === 120));
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') < 432000);
  let capture, reads = 0;
  const taskHandler = async call => {
    if (call.arguments.action === 'read') {
      reads++;
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(snapshot) }] };
    }
    assert.equal(call.arguments.action, 'describe', 'Schema capture must never save or execute a proposed plan.');
    return h.call(call.arguments);
  };
  const runtime = { async runAgent(options) {
    validateResponseOnlyOptions(options);
    assert.deepEqual(normalizeOutputSchema(options.outputSchema), options.outputSchema);
    capture = { options, input: captured(options) };
    assertReferenceChoices(capture); assertOperationalChoices(capture);
    throw Object.assign(new Error('The fixture has captured the bounded transport schema; no provider inference is needed.'), { code: 'FIXTURE_SCHEMA_CAPTURE_COMPLETE' });
  } };
  const tools = [TASK_TOOL, { name: 'relay_workspace', description: 'Inspect the fixture workspace.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'read'] } }, required: ['action'], additionalProperties: false } }];
  const plan = { steps: [{ id: 'inspect-workspace', description: 'Inspect the actual workspace after prior recorded work.' }] };
  const source = { planRef: { requestId: 'maximum-source', nodeId: 'maximum-plan', nodeRevision: 1, responseId: 'maximum-response' }, sha256: executionOutlineHash(plan), plan };
  await assert.rejects(prepareExecutionPlanHandoff({
    runtime, taskHandler, taskId: h.taskId, runId: h.runId, nodeId: h.nodeId, cwd: h.cwd,
    context: request, tools, getSource: async () => source, model: 'fixture-handoff', effort: 'low'
  }), { code: 'FIXTURE_SCHEMA_CAPTURE_COMPLETE' });
  assert.equal(reads, 1);
  assert.equal((await h.tasks.get(h.taskId)).steps.length, 0, 'The constructed history must not be written into even the isolated saved task.');
  const bytes = Buffer.byteLength(JSON.stringify(capture.options.outputSchema), 'utf8');
  assert.ok(bytes < 60000);
  t.diagnostic('Maximum retained-history schema bytes: ' + bytes + '; 199 terminal IDs, 40 artifact IDs, 40 exact observed method pairs.');
});

const outputBoundaryFact = { id: 'inspection_pending', value: null };

test('handoff output boundary reports an unknown root facts field before any task save', async t => {
  const h = await referenceFixture(t), before = await readFile(h.tasks.file(h.taskId), 'utf8');
  await assert.rejects(h.prepare({ respond: input => ({ ...referencePlan(input), facts: [outputBoundaryFact] }) }),
    error => {
      assert.equal(error.code, 'TASK_PLAN_HANDOFF_FAILED');
      assert.equal(error.cause?.code, 'TASK_PLAN_HANDOFF_INVALID');
      assert.match(error.cause.message, /(?:unknown|unexpected)[\s\S]*\bfacts\b/i,
        'The repair must identify the actual unexpected field, not blame a missing or empty plan.');
      return true;
    });
  assert.equal(h.observed.handoffs.length, 2);
  assert.equal(h.observed.planCalls.length, 0);
  assert.equal(await readFile(h.tasks.file(h.taskId), 'utf8'), before);
  const firstError = h.observed.updates.at(-1).attempts[0].error.message;
  assert.ok(h.observed.handoffs[1].options.prompt.includes(firstError),
    'The bounded repair must receive the precise rejection that actually occurred.');
});

test('handoff output boundary accepts a single whole-output JSON fence through the real handler', async t => {
  const h = await referenceFixture(t);
  const result = await h.prepare({
    respond: input => { const body = referencePlan(input); body.plan.facts = [outputBoundaryFact]; return body; },
    encode: body => ' \n```json\n' + JSON.stringify(body) + '\n```\n '
  });
  assert.equal(h.observed.handoffs.length, 1, 'One harmless whole-output JSON fence must not consume a repair.');
  assert.equal(h.observed.planCalls.length, 1);
  assert.equal(h.observed.planCalls[0].receipt.success, true);
  assert.deepEqual(h.observed.planCalls[0].args, h.observed.handoffs[0].proposed,
    'Fence normalization must not move, drop, or rewrite any parsed field.');
  assert.deepEqual(result.snapshot.plan.facts, [outputBoundaryFact]);
  assert.deepEqual(result.snapshot.steps[0].operation, executionLeaf().operation);
  const returned = h.observed.handoffs[0].output;
  assert.deepEqual(result.metadata.attempts[0].outputNormalization, {
    kind: 'json-code-fence', originalSha256: createHash('sha256').update(returned).digest('hex'),
    jsonSha256: createHash('sha256').update(JSON.stringify(h.observed.handoffs[0].proposed)).digest('hex')
  }, 'The attempt must record normalization of the exact returned wrapper and unchanged JSON body.');
});

test('handoff output boundary accepts a bare whole-output code fence with the same exact payload', async t => {
  const h = await referenceFixture(t);
  const result = await h.prepare({ encode: body => '```\r\n' + JSON.stringify(body) + '\r\n```' });
  assert.equal(h.observed.handoffs.length, 1);
  assert.equal(h.observed.planCalls[0].receipt.success, true);
  assert.deepEqual(h.observed.planCalls[0].args, h.observed.handoffs[0].proposed);
  assert.equal(result.metadata.attempts[0].outputNormalization.kind, 'json-code-fence');
});

test('handoff output boundary rejects fenced root facts without moving or dropping them', async t => {
  const h = await referenceFixture(t), before = await readFile(h.tasks.file(h.taskId), 'utf8');
  await assert.rejects(h.prepare({
    respond: input => ({ ...referencePlan(input), facts: [outputBoundaryFact] }),
    encode: body => '```json\n' + JSON.stringify(body) + '\n```'
  }), error => {
    assert.equal(error.code, 'TASK_PLAN_HANDOFF_FAILED');
    assert.equal(error.cause?.code, 'TASK_PLAN_HANDOFF_INVALID');
    assert.match(error.cause.message, /(?:unknown|unexpected)[\s\S]*\bfacts\b/i);
    assert.match(error.cause.message, /plan\.facts/,
      'The supplied schema defines the actual valid facts location and can name it without rewriting output.');
    return true;
  });
  assert.equal(h.observed.handoffs.length, 2, 'Formatting tolerance must not enlarge the completed-response repair budget.');
  assert.equal(h.observed.planCalls.length, 0);
  assert.equal(await readFile(h.tasks.file(h.taskId), 'utf8'), before);
  for (const attempt of h.observed.updates.at(-1).attempts) {
    assert.equal(attempt.outputNormalization.kind, 'json-code-fence');
    assert.equal(attempt.error.code, 'TASK_PLAN_HANDOFF_INVALID');
  }
});

test('handoff output boundary gives precise feedback for one provider-authored nested-facts correction', async t => {
  const h = await referenceFixture(t);
  const result = await h.prepare({
    respond: (input, attempt) => {
      const body = referencePlan(input);
      if (attempt === 1) body.facts = [outputBoundaryFact];
      else body.plan.facts = [outputBoundaryFact];
      return body;
    },
    encode: body => '```json\n' + JSON.stringify(body) + '\n```'
  });
  assert.equal(h.observed.handoffs.length, 2);
  assert.equal(h.observed.planCalls.length, 1, 'Only the actual corrected provider response may reach the normal handler.');
  const rejected = result.metadata.attempts[0];
  assert.match(rejected.error.message, /(?:unknown|unexpected)[\s\S]*\bfacts\b/i);
  assert.ok(h.observed.handoffs[1].options.prompt.includes(rejected.error.message));
  assert.deepEqual(h.observed.handoffs[0].proposed.facts, [outputBoundaryFact],
    'The first returned candidate must remain intact in the fixture evidence.');
  assert.equal(h.observed.handoffs[0].proposed.plan.facts, undefined);
  assert.deepEqual(h.observed.planCalls[0].args, h.observed.handoffs[1].proposed);
  assert.deepEqual(result.snapshot.plan.facts, [outputBoundaryFact]);
  assert.equal(result.metadata.attempts[1].status, 'completed');
});

for (const [label, change, diagnostic] of [
  ['null root', () => null, /root[\s\S]*object|object[\s\S]*root/i],
  ['array root', () => [], /root[\s\S]*object|object[\s\S]*root/i],
  ['wrong action', body => ({ ...body, action: 'read' }), /action[\s\S]*plan/i],
  ['missing steps', body => { delete body.steps; return body; }, /steps[\s\S]*array|steps[\s\S]*required/i],
  ['object steps', body => ({ ...body, steps: {} }), /steps[\s\S]*array/i],
  ['empty steps', body => ({ ...body, steps: [] }), /steps[\s\S]*(nonempty|non-empty|at least one)/i]
]) test('handoff output boundary identifies the actual ' + label + ' defect', async t => {
  const h = await referenceFixture(t), before = await readFile(h.tasks.file(h.taskId), 'utf8');
  await assert.rejects(h.prepare({ respond: input => change(referencePlan(input)) }), error => {
    assert.equal(error.code, 'TASK_PLAN_HANDOFF_FAILED');
    assert.equal(error.cause?.code, 'TASK_PLAN_HANDOFF_INVALID');
    assert.match(error.cause.message, diagnostic);
    return true;
  });
  assert.equal(h.observed.handoffs.length, 2);
  assert.equal(h.observed.planCalls.length, 0);
  assert.equal(await readFile(h.tasks.file(h.taskId), 'utf8'), before);
});

for (const [label, encode] of [
  ['prose before JSON', body => 'Here is the plan.\n' + JSON.stringify(body)],
  ['prose after JSON', body => JSON.stringify(body) + '\nThe plan is ready.'],
  ['prose around a fenced block', body => 'Here is the plan.\n```json\n' + JSON.stringify(body) + '\n```'],
  ['two raw payloads', body => JSON.stringify(body) + '\n' + JSON.stringify(body)],
  ['two fenced payloads', body => '```json\n' + JSON.stringify(body) + '\n```\n```json\n' + JSON.stringify(body) + '\n```'],
  ['an unclosed fence', body => '```json\n' + JSON.stringify(body)],
  ['truncated JSON', body => JSON.stringify(body).slice(0, -1)],
  ['a non-JSON language fence', body => '```javascript\n' + JSON.stringify(body) + '\n```'],
  ['multiple payloads in one fence', body => '```json\n' + JSON.stringify(body) + '\n' + JSON.stringify(body) + '\n```']
]) test('handoff output boundary refuses ' + label + ' without extracting a plausible plan', async t => {
  const h = await referenceFixture(t), before = await readFile(h.tasks.file(h.taskId), 'utf8');
  await assert.rejects(h.prepare({ encode }), error => {
    assert.equal(error.code, 'TASK_PLAN_HANDOFF_FAILED');
    assert.equal(error.cause?.code, 'TASK_PLAN_HANDOFF_INVALID');
    assert.match(error.cause.message, /JSON/);
    assert.notEqual(error.cause.message, 'Refinement must return the JSON plan call without prose or Markdown fences.',
      'A parsing failure must describe the actual parsing/format problem instead of assuming its cause.');
    return true;
  });
  assert.equal(h.observed.handoffs.length, 2);
  assert.equal(h.observed.planCalls.length, 0, 'Neither ambiguous payload selection nor invalid syntax may publish a plan.');
  assert.equal(await readFile(h.tasks.file(h.taskId), 'utf8'), before);
});
