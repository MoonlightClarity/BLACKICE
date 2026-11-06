// Historical schema-13 protocol regression; current canonical evidence and handoff have separate acceptance.
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
import { responseCycleStage } from '../public/response-cycle-model.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';
import { fixtureUserAgency } from './fixture-user-agency.mjs';
import { planningResponseBody } from '../public/planning-browser-model.mjs';
import { normalizeOutputSchema, validateResponseOnlyOptions } from '../lib/response-profile.mjs';

const request = 'List the files in the current workspace.';
const payload = receipt => JSON.parse(receipt.contentItems.find(item => item.type === 'inputText').text);
const tool = (options, name, args, callId) => options.onToolCall({ name, arguments: args, callId });
const captured = options => JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n') + 2));
const criterion = { id: 'workspace-list', label: 'Current workspace inventory', description: 'Report the directory entries returned by the requested current workspace listing.', verification: 'response' };

function checkedResponse(input) {
  const stage = responseCycleStage(input.module.kind, { pipelineVersion: input.cycle?.pipelineVersion });
  const sourceId = input.sources.find(source => source.id === 'viability:task')?.id || input.sources[0].id;
  const body = {
    userAgency: fixtureUserAgency(),
    values: Object.fromEntries(input.template.fields.map(field => [field.id, field.label + ': inspect the requested workspace and report only the observed entries.'])),
    grounding: input.template.fields.filter(field => field.grounding === 'required').map(field => ({ field: field.id, sourceId })),
    openQuestions: [], challengeResponses: []
  };
  if (stage.id === 'feasibility') return { ...body, requirements: [] };
  Object.assign(body, {
    checks: stage.checks.map(check => ({
      id: check.id, assessment: check.when === 'effects' ? 'not_applicable' : 'supported',
      sourceIds: check.grounding === 'required' && check.when !== 'effects' ? [sourceId] : [],
      note: 'The captured request supports this bounded inspection; its results must come from actual execution.'
    })),
    subproblems: [], childResults: []
  });
  if (stage.id === 'inference') body.inferences = [{
    id: 'requested-inspection', claim: 'The user wants an actual current workspace listing.',
    basis: 'inferred', sourceIds: [sourceId], limitation: 'The listing has not run during this preparation.'
  }];
  const criteria = input.cycle?.requiredAcceptanceCriteria?.length ? input.cycle.requiredAcceptanceCriteria
    : input.cycle?.acceptanceCriteria?.length ? input.cycle.acceptanceCriteria : [criterion];
  if (stage.id === 'plan') Object.assign(body, {
    acceptanceCriteria: criteria,
    // A real accepted analytical Plan has semantic steps, not executable tool leaves.
    steps: [{
      id: 'inspect-workspace', label: 'Inspect the current workspace',
      description: 'List the current workspace through the available workspace tool and use the returned directory entries in the answer.',
      dependsOn: [], criterionIds: criteria.map(item => item.id), sourceIds: [sourceId]
    }]
  });
  if (stage.id === 'think') body.criterionResults = criteria.map(item => ({
    criterionId: item.id, assessment: 'satisfied', sourceIds: [sourceId], receiptIds: [],
    rationale: 'The operational fixture separately checks the actual workspace receipt.'
  }));
  if (stage.id === 'respond') {
    body.values.answer = 'The current workspace contains input.txt.';
    body.coverage = criteria.map(item => ({
      criterionId: item.id, disposition: 'addressed', sourceIds: [sourceId],
      responseExcerpt: body.values.answer, limitation: ''
    }));
  }
  return body;
}

function findSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  if (Number.isSafeInteger(value.revision) && typeof value.taskId === 'string' && Array.isArray(value.steps)) return value;
  for (const item of Object.values(value)) {
    const found = findSnapshot(item);
    if (found) return found;
  }
  return null;
}
function deliveredSnapshot(text) {
  const marker = 'ACCEPTED EXECUTION OUTLINE SNAPSHOT';
  const start = text.indexOf('{', text.indexOf(marker) + marker.length);
  assert.ok(text.includes(marker) && start >= 0, 'The worker must receive the saved outline as actual JSON.');
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return findSnapshot(JSON.parse(text.slice(start, index + 1)));
  }
  assert.fail('The delivered execution outline JSON is incomplete.');
}
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
  if (!receipt.success) return { output: 'The fixture workspace operation was rejected.' };
  const stateReceipt = await tool(options, 'relay_task', { action: 'read' }, 'post-operation-read');
  assert.equal(stateReceipt.success, true, stateReceipt.contentItems?.[0]?.text);
  const state = payload(stateReceipt), active = state.steps.find(step => step.status === 'active' && step.operation?.kind === 'tool');
  assert.ok(active);
  const completed = await tool(options, 'relay_task', {
    action: 'step', expectedRevision: state.revision, stepId: active.id, status: 'done',
    evidence: 'The actual relay_workspace list response contains the pre-existing input.txt file.'
  }, 'record-observed-list');
  assert.equal(completed.success, true, completed.contentItems?.[0]?.text);
  const current = payload(completed);
  const reviewed = await tool(options, 'relay_task', {
    action: 'review', expectedRevision: current.revision,
    review: { decision: 'respond', summary: 'The actual directory receipt was checked and contains input.txt. The requested listing is complete.' }
  }, 'review-observed-list');
  assert.equal(reviewed.success, true, reviewed.contentItems?.[0]?.text);
  return { output: 'The current workspace contains input.txt.' };
}

async function fixture(t, { execute, withPlanning = true, invalidHandoff = null, handoffFailure = null, postResponseSourceFailure = null, historicalTool = false } = {}) {
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
      if (options.responseOnly && options.prompt.includes('NATIVE PLAN EXECUTION HANDOFF')) {
        const input = captured(options), snapshot = findSnapshot(input);
        assert.ok(snapshot, 'The handoff provider must receive the actual saved task revision.');
        observations.handoffs.push({ options, input, snapshot });
        // Exercise the same pre-provider boundary as the installed runtimes.
        // A mock returning JSON alone misses unresolved $ref and size/depth errors.
        validateResponseOnlyOptions(options);
        assert.equal(options.outputSchema?.type, 'object', 'Native refinement must supply an actual structured-output schema.');
        assert.ok(options.outputSchema.properties?.steps, 'The output schema must preserve the executable steps field.');
        observations.handoffs.at(-1).validatedOutputSchema = normalizeOutputSchema(options.outputSchema);
        if (handoffFailure) throw handoffFailure;
        const body = {
          action: 'plan', expectedRevision: snapshot.revision,
          plan: { layout: 'sequence', detail: 'detailed', taskType: 'general' },
          steps: [...structuredClone(snapshot.steps), executionLeaf()]
        };
        if (invalidHandoff === 'malformed-expression') body.steps = [
          { id: 'route', title: 'Choose the workspace inspection', kind: 'choice', parentId: null,
            branch: { if: { and: [] }, then: 'inspect-workspace', else: 'alternative-list' } },
          { ...executionLeaf(), parentId: 'route' },
          { ...executionLeaf(), id: 'alternative-list', parentId: 'route', status: 'pending' }
        ];
        if (invalidHandoff === 'bookkeeping') body.steps.at(-1).operation = { kind: 'tool', tool: 'relay_task', action: 'read', target: snapshot.taskId };
        if (invalidHandoff === 'detached') body.steps.at(-1).operation = { kind: 'tool', tool: 'relay_retired_reader', action: 'read', target: 'input.txt' };
        if (invalidHandoff === 'invalid-action') body.steps.at(-1).operation.action = 'invented-action';
        if (invalidHandoff === 'historical-rewrite') body.steps[0].operation.target = 'rewritten-history.txt';
        if (invalidHandoff === 'empty') body.steps = [];
        if (invalidHandoff === 'stale') body.expectedRevision = snapshot.revision - 1;
        if (postResponseSourceFailure && observations.handoffs.length === 1) {
          const getSource = context.service.getExecutionPlan.bind(context.service);
          let pending = true;
          context.service.getExecutionPlan = async run => {
            if (pending) { pending = false; observations.injectedSourceFailures = 1; throw postResponseSourceFailure; }
            return getSource(run);
          };
        }
        return { output: JSON.stringify(body), threadId: 'fixture-handoff-planner', usage: { inputTokens: 29, outputTokens: 8, totalTokens: 37 } };
      }
      if (options.responseOnly) {
        const input = captured(options);
        observations.analyticalStages.push(input.module.kind);
        if (historicalTool && input.module.kind === 'plan' && !observations.historicalStep) {
          const run = context.engine.listRuns()[0];
          let previous = await tasks.ensure({ taskId: run.taskId, runId: run.id, nodeId: 'agent', cwd, goal: request });
          const actor = revision => ({ expectedRevision: revision, runId: run.id, nodeId: 'agent', schemaVersion: 13, planningMode: 'on', executionGuardrails: true });
          previous = await tasks.setPlan(previous.taskId, {
            plan: { layout: 'sequence', detail: 'detailed', taskType: 'general' },
            steps: [{
              id: 'observed-prior-input', title: 'Read the prior input file', kind: 'action', parentId: null, status: 'active',
              operation: { kind: 'tool', tool: 'relay_retired_reader', action: 'read', target: 'input.txt' },
              result: 'The actual input.txt contents returned by the earlier reader.',
              note: 'Read input.txt through the earlier fixture reader and inspect the returned contents.',
              doneWhen: 'The actual read returns the existing input.txt contents.'
            }]
          }, actor(previous.revision));
          // This older fixture adapter performs its real read before it is absent
          // from the new catalog. The saved outcome is history, not future work.
          const observed = await readFile(path.join(cwd, 'input.txt'), 'utf8');
          previous = await tasks.setStep(previous.taskId, 'observed-prior-input', {
            status: 'done', evidence: 'The prior fixture reader returned input.txt contents: ' + JSON.stringify(observed)
          }, actor(previous.revision));
          observations.historicalStep = structuredClone(previous.steps.find(step => step.id === 'observed-prior-input'));
        }
        return { output: JSON.stringify(checkedResponse(input)), threadId: 'fixture-analytical', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
      }
      observations.operationalCalls++;
      const run = context.engine.listRuns()[0], state = await tasks.get(run.taskId);
      observations.atWorkerEntry = { state, options, awareness: tasks.awareness.snapshot(state) };
      return execute ? execute(options, context, state) : { output: 'No fixture operation requested.' };
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

test('an ordinary Forced request hands its accepted Plan to the first workspace operation without user coaching', async t => {
  const f = await fixture(t, { execute: completeListing });
  const run = await f.run();
  assert.deepEqual(f.observations.analyticalStages.slice(0, 3), ['inference', 'viability', 'plan']);
  assert.equal(run.input, request, 'The ordinary request must not gain per-task planner coaching.');
  assert.equal(f.observations.operationalCalls, 1, run.error);
  const before = f.observations.atWorkerEntry;
  assert.ok(before.state.steps.some(step => step.kind === 'action' && step.operation?.kind === 'tool'),
    'A valid preparatory Plan must be materialized into a saved executable outline before the worker starts.');
  assert.equal(f.observations.handoffs.length, 1, 'Semantic planning needs one genuine provider-authored refinement, not fabricated host operations.');
  assert.deepEqual(f.observations.handoffs[0].validatedOutputSchema, f.observations.handoffs[0].options.outputSchema,
    'The actual handoff schema must survive the real runtime normalizer before a provider response can be accepted.');
  assertOperationalChoices(f.observations.handoffs[0]);
  const refinementInput = f.observations.handoffs[0].input;
  assert.ok(refinementInput.taskDescription?.plan?.inputSchema,
    'Native refinement must receive the actual normal task description, not just a detached schema.');
  assert.ok(refinementInput.taskCatalog?.ontology,
    'Native refinement must receive the actual supported describe catalog before choosing saved reference IDs.');
  const operationalCatalog = refinementInput.tools;
  assert.ok(operationalCatalog.length > 0, 'The refinement needs actual attached operational choices.');
  assert.ok(operationalCatalog.every(tool => tool.name !== 'relay_task'),
    'Task bookkeeping must not be advertised as a valid primary operational leaf and then rejected by the host.');
  assert.ok(before.options.dynamicTools.some(tool => tool.name === 'relay_task'),
    'Excluding bookkeeping from operation choices must not remove the worker task-state tool.');
  const fullTaskSchema = f.observations.handoffs[0].input.taskPlanSchema;
  assert.equal(fullTaskSchema?.type, 'object', 'The model must receive the complete host task-plan grammar separately from its detached transport schema.');
  assert.ok(fullTaskSchema.$defs?.planExpression);
  assert.ok(JSON.stringify(fullTaskSchema.$defs.planExpression).includes('"$ref":"#/$defs/planExpression"'),
    'The prompt must preserve the full recursive branch-expression grammar that remains authoritative at host validation.');
  const delivered = [before.options.prompt, before.options.developerInstructions].filter(Boolean).join('\n');
  assert.match(delivered, /ACCEPTED EXECUTION OUTLINE SNAPSHOT/);
  const snapshot = deliveredSnapshot(delivered);
  assert.ok(snapshot, 'The delivered JSON must contain the actual task snapshot.');
  assert.equal(snapshot.taskId, before.state.taskId);
  assert.equal(snapshot.revision, before.state.revision, 'The delivered revision must be the revision actually materialized before execution.');
  assert.deepEqual(snapshot.steps, before.state.steps, 'The saved operation descriptors must reach the worker without truncation or substitution.');
  assert.equal(f.observations.operations.length, 1);
  assert.equal(f.observations.operations[0].receipt.success, true, f.observations.operations[0].receipt.contentItems?.[0]?.text);
  const read = f.observations.operations[0].awareness.workers.find(worker => worker.runId === run.id && worker.nodeId === 'agent');
  assert.equal(read?.lastReadRevision, snapshot.revision, 'The first permitted operation may acknowledge only its delivered revision.');
  assert.ok(payload(f.observations.operations[0].receipt).entries.some(entry => entry.name === 'input.txt'));
  assert.equal(run.status, 'completed', run.error);
  const handoff = run.nodes.agent.planningHandoff;
  assert.equal(handoff?.state, 'delivered');
  assert.equal(handoff.taskRevision, snapshot.revision);
  assert.match(handoff.sourceSha256, /^[a-f0-9]{64}$/);
  assert.match(handoff.snapshotSha256, /^[a-f0-9]{64}$/);
  const accepted = await f.store.get(run.responseCycle.requestId);
  const acceptedPlan = accepted.nodes.find(node => node.id === handoff.planRef.nodeId);
  assert.equal(handoff.planRef.requestId, accepted.id);
  assert.equal(handoff.planRef.responseId, acceptedPlan.response.id, 'Operational execution must remain traceable to the exact accepted Plan response.');
  assert.equal(handoff.planRef.nodeRevision, acceptedPlan.revision);
  assert.deepEqual(handoff.attempts[0].usage, { inputTokens: 29, outputTokens: 8, totalTokens: 37 });
  const analyticalCount = f.observations.analyticalStages.length;
  assert.equal(run.planningUsage.inputTokens, 29 + 5 * analyticalCount);
  assert.equal(run.planningUsage.outputTokens, 8 + 2 * analyticalCount);
  assert.equal(run.planningUsage.totalTokens, 37 + 7 * analyticalCount, 'The real native refinement usage must be counted exactly once alongside analytical planning.');
});

test('saving a handoff does not claim a worker read before the delivered snapshot is used', async t => {
  const f = await fixture(t, { execute: async () => { throw Object.assign(new Error('The fixture stops before requesting any tool.'), { code: 'FIXTURE_BEFORE_TOOL' }); } });
  const run = await f.run();
  assert.ok(f.observations.atWorkerEntry.state.steps.length, 'This case must first materialize a real accepted outline.');
  const worker = f.observations.atWorkerEntry.awareness.workers.find(item => item.runId === run.id && item.nodeId === 'agent');
  assert.ok(worker);
  assert.equal(worker.lastReadRevision ?? null, null, 'A stored outline or queued native invocation alone is not a delivered-use acknowledgment.');
  assert.equal(f.observations.operations.length, 0);
});

test('a correction after handoff delivery remains unread and blocks the first operation', async t => {
  const f = await fixture(t, { execute: async (options, context, delivered) => {
    const active = delivered.steps.find(step => step.kind === 'action' && step.status === 'active');
    if (!active) return { output: 'No operational outline was handed off.' };
    const changed = await context.tasks.editPlan(delivered.taskId, {
      operations: [{ type: 'update', stepId: active.id, patch: { note: 'Read this later human correction before running the directory inspection.' } }]
    }, { expectedRevision: delivered.revision, source: 'human' });
    context.observations.changed = changed;
    await context.operation(options, { action: 'list', path: '.' });
    return { output: 'The changed outline must be read before operating.' };
  } });
  await f.run();
  assert.ok(f.observations.changed, 'The regression requires a real saved correction after delivery.');
  assert.equal(f.observations.operations[0].receipt.code, 'TASK_PLAN_REVIEW_REQUIRED');
  const workers = f.tasks.awareness.snapshot(await f.tasks.get(f.observations.changed.taskId)).workers;
  const worker = workers.find(item => item.nodeId === 'agent');
  assert.ok(!worker || worker.lastReadRevision < f.observations.changed.revision,
    'The runtime must never auto-acknowledge a revision absent from its delivered snapshot.');
});

test('an accepted listing handoff does not permit a mismatched primary write', async t => {
  const f = await fixture(t, { execute: async (options, context) => {
    await context.operation(options, { action: 'write', path: 'must-not-exist.txt', text: 'Unplanned write.' });
    return { output: 'The unplanned primary write must not run.' };
  } });
  await f.run();
  assert.ok(f.observations.atWorkerEntry.state.steps.length, 'The valid handoff must exist before mismatch admission is tested.');
  const receipt = f.observations.operations[0].receipt;
  assert.equal(receipt.success, false);
  assert.match(receipt.code || payload(receipt).code || '', /^TASK_PLAN_/,
    'The planner gate must reject the primary mismatch before the filesystem handler: ' + JSON.stringify(receipt));
  await assert.rejects(readFile(path.join(f.cwd, 'must-not-exist.txt')), { code: 'ENOENT' });
});

test('using a handoff once does not bypass primary-result reconciliation', async t => {
  const f = await fixture(t, { execute: async (options, context, delivered) => {
    await context.operation(options, { action: 'list', path: '.' });
    // Replacing the dispatched action would erase its unresolved receipt.
    // Ordinary read-only auxiliary observations retain their existing contract.
    const next = {
      ...executionLeaf(), id: 'write-after-list',
      operation: { kind: 'tool', tool: 'relay_workspace', action: 'write', target: 'must-not-exist.txt' },
      result: 'The actual receipt of writing the planned file.',
      note: 'Write the requested text to must-not-exist.txt once.',
      doneWhen: 'The actual workspace write receipt identifies the saved file.'
    };
    context.observations.prematureReplan = await tool(options, 'relay_task', {
      action: 'plan', expectedRevision: delivered.revision,
      plan: { layout: 'sequence', detail: 'detailed', taskType: 'general' }, steps: [next]
    }, 'premature-replacement');
    return { output: 'The dispatched listing must retain its actual unresolved result.' };
  } });
  await f.run();
  assert.equal(f.observations.operations[0].receipt.success, true);
  const denied = f.observations.prematureReplan;
  assert.equal(denied.success, false);
  assert.equal(denied.code || payload(denied).code, 'TASK_PLAN_RESULT_REQUIRED');
  await assert.rejects(readFile(path.join(f.cwd, 'must-not-exist.txt')), { code: 'ENOENT' });
});

test('changing the accepted source Plan after delivery blocks the first ordinary operation', async t => {
  const f = await fixture(t, { execute: async (options, context, delivered) => {
    const activeRun = context.engine.listRuns()[0], ref = activeRun.nodes.agent.planningHandoff.planRef;
    const accepted = await context.store.get(ref.requestId), plan = accepted.nodes.find(node => node.id === ref.nodeId);
    const body = planningResponseBody(plan.response);
    body.steps[0].description += ' A later human correction requires another source review before executing.';
    const changed = await context.store.recordHumanResponse(ref.requestId, ref.nodeId, body, {
      expectedNodeRevision: plan.revision, actor: { type: 'human', id: 'fixture-human' }
    });
    const revised = changed.nodes.find(node => node.id === ref.nodeId);
    context.observations.sourceChange = { before: ref, after: revised.response.id, revision: revised.revision };
    assert.equal((await context.tasks.get(delivered.taskId)).revision, delivered.revision,
      'This regression changes the accepted source Plan, independently of task snapshot freshness.');
    try {
      await context.operation(options, { action: 'list', path: '.' });
      assert.fail('An operation based on the superseded accepted source must not dispatch.');
    } catch (error) {
      context.observations.sourceError = { code: error.code, message: error.message };
      throw error;
    }
  } });
  const run = await f.run();
  assert.equal(f.observations.operationalCalls, 1, 'The provider must first receive the real saved handoff.');
  assert.ok(f.observations.sourceChange);
  assert.notEqual(f.observations.sourceChange.after, f.observations.sourceChange.before.responseId);
  assert.equal(f.observations.sourceError?.code, 'RESPONSE_CYCLE_PLAN_CONFLICT');
  assert.equal(f.observations.operations.length, 0, 'No workspace receipt may be produced after source conflict.');
  assert.equal(run.nodes.agent.planningHandoff.state, 'prepared', 'A superseded source must not gain a delivered acknowledgment.');
  assert.equal(run.status, 'failed');
});

test('a refinement provider transport failure is terminal and is not automatically replayed', async t => {
  const f = await fixture(t, { handoffFailure: Object.assign(new Error('Fixture refinement transport unavailable.'), { code: 'FIXTURE_PROVIDER_UNAVAILABLE' }) });
  const run = await f.run();
  assert.deepEqual(f.observations.analyticalStages, ['inference', 'viability', 'plan']);
  assert.equal(f.observations.handoffs.length, 1, 'A transport failure is not a rejected completed response eligible for repair.');
  assert.equal(f.observations.operationalCalls, 0);
  assert.equal(f.observations.operations.length, 0);
  const handoff = run.nodes.agent.planningHandoff;
  assert.equal(handoff.state, 'failed');
  assert.equal(handoff.attempts.length, 1);
  assert.equal(handoff.attempts[0].error.code, 'FIXTURE_PROVIDER_UNAVAILABLE');
  assert.equal(run.status, 'failed');
});

test('a source read failure after completed refinement is terminal instead of replaying the provider', async t => {
  const f = await fixture(t, { postResponseSourceFailure: Object.assign(new Error('Fixture accepted-Plan storage temporarily unavailable.'), { code: 'EIO' }) });
  const run = await f.run();
  assert.equal(f.observations.injectedSourceFailures, 1, 'The transient source failure must happen after the completed refinement response.');
  assert.equal(f.observations.handoffs.length, 1, 'A completed provider response does not make a source/storage error eligible for model repair.');
  assert.equal(f.observations.operationalCalls, 0);
  assert.equal(f.observations.operations.length, 0);
  const handoff = run.nodes.agent.planningHandoff;
  assert.equal(handoff.state, 'failed');
  assert.equal(handoff.attempts.length, 1);
  assert.equal(handoff.attempts[0].error.code, 'EIO');
  assert.equal(run.status, 'failed');
});

test('without an accepted preparatory Plan an empty outline still rejects ordinary operations', async t => {
  const f = await fixture(t, { withPlanning: false, execute: async (options, context) => {
    await context.operation(options, { action: 'list', path: '.' });
    return { output: 'No unplanned inspection is claimed.' };
  } });
  await f.run();
  assert.deepEqual(f.observations.atWorkerEntry.state.steps, []);
  assert.equal(f.observations.operations[0].receipt.code, 'TASK_PLAN_REQUIRED');
});

for (const invalidHandoff of ['empty', 'stale']) test('a refinement with ' + invalidHandoff + ' content cannot start an operational worker', async t => {
  const f = await fixture(t, { invalidHandoff });
  const run = await f.run();
  assert.ok(f.observations.handoffs.length, 'The runtime must actually request a native handoff refinement.');
  assert.equal(f.observations.operationalCalls, 0);
  assert.notEqual(run.status, 'completed');
  assert.equal(f.observations.operations.length, 0);
});

test('detached handoff schema does not bypass full recursive branch-expression validation', async t => {
  const f = await fixture(t, { invalidHandoff: 'malformed-expression' });
  const run = await f.run();
  assert.equal(f.observations.handoffs.length, 2, 'A completed invalid plan permits only the one bounded repair.');
  assert.ok(f.observations.handoffs.every(handoff => handoff.validatedOutputSchema),
    'The transport schema must pass the real provider boundary before host expression validation is exercised.');
  assert.equal(f.observations.operationalCalls, 0);
  assert.equal(f.observations.operations.length, 0);
  const attempts = run.nodes.agent.planningHandoff.attempts;
  assert.equal(attempts.length, 2);
  for (const attempt of attempts) {
    assert.equal(attempt.error.code, 'INVALID_TASK_PLAN');
    assert.match(attempt.error.message, /nonempty bounded array of Boolean expressions/);
  }
  assert.equal(run.status, 'failed');
});

test('a handoff preserves terminal history from a tool no longer attached before new work', async t => {
  const f = await fixture(t, { historicalTool: true, execute: completeListing });
  const run = await f.run();
  assert.equal(f.observations.handoffs.length, 1, run.error);
  const handoff = f.observations.handoffs[0], historical = f.observations.historicalStep;
  assertOperationalChoices(handoff);
  assert.equal(historical?.status, 'done');
  assert.ok(historical.evidence.includes('A real fixture file.'));
  assert.ok(handoff.input.tools.every(tool => tool.name !== 'relay_retired_reader'),
    'The test must actually remove the historical adapter from the current operational catalog.');
  assert.deepEqual(handoff.input.currentTask.steps.find(step => step.id === historical.id), historical);
  assert.deepEqual(f.observations.atWorkerEntry.state.steps.find(step => step.id === historical.id), historical,
    'Refinement must retain the exact saved historical operation and observations, including detached tools.');
  assert.equal(f.observations.operations.length, 1);
  assert.equal(f.observations.operations[0].receipt.success, true, f.observations.operations[0].receipt.contentItems?.[0]?.text);
  assert.equal(run.status, 'completed', run.error);
  const finalState = await f.tasks.get(run.taskId);
  assert.deepEqual(finalState.steps.find(step => step.id === historical.id), historical);
});

for (const [invalidHandoff, message] of [
  ['bookkeeping', /attached operational tool|bookkeeping/],
  ['detached', /attached operational tool/],
  ['invalid-action', /actual relay_workspace action/],
  ['historical-rewrite', /historical|preserve|saved|operation/i]
]) test('refinement rejects a new or changed ' + invalidHandoff + ' operation without dropping it', async t => {
  const historicalTool = invalidHandoff === 'detached' || invalidHandoff === 'historical-rewrite';
  const f = await fixture(t, { invalidHandoff, historicalTool });
  const run = await f.run();
  assert.equal(f.observations.handoffs.length, 2, 'Only the one bounded repair may follow a completed rejected response.');
  assert.ok(f.observations.handoffs.every(handoff => handoff.validatedOutputSchema),
    'The real runtime output-schema boundary must accept the schema before the host rejects the returned operation.');
  assert.equal(f.observations.operationalCalls, 0, 'An invalid leaf must not be silently dropped, substituted or admitted.');
  assert.equal(f.observations.operations.length, 0);
  const attempts = run.nodes.agent.planningHandoff.attempts;
  assert.equal(attempts.length, 2);
  for (const attempt of attempts) {
    assert.equal(attempt.error.code, 'TASK_PLAN_HANDOFF_INVALID');
    assert.match(attempt.error.message, message);
  }
  if (historicalTool) {
    const current = await f.tasks.get(run.taskId);
    assert.deepEqual(current.steps.find(step => step.id === f.observations.historicalStep.id), f.observations.historicalStep,
      'Rejected refinement must not rewrite recorded historical work.');
  }
  assert.equal(run.status, 'failed');
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
    async prepare({ respond = input => referencePlan(input), beforePlan, encode = JSON.stringify } = {}) {
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
        return { output: observation.output };
      } };
      return prepareExecutionPlanHandoff({ runtime, taskHandler, taskId, runId, nodeId, cwd, context: request, tools,
        getSource: async () => source, model: 'fixture-handoff', effort: 'low', onUpdate: value => observed.updates.push(value) });
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
