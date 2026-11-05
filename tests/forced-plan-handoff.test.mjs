import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';
import { TaskStateStore } from '../lib/task-state.mjs';
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

async function fixture(t, { execute, withPlanning = true, invalidHandoff = null, handoffFailure = null, postResponseSourceFailure = null } = {}) {
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
          steps: [executionLeaf()]
        };
        if (invalidHandoff === 'malformed-expression') body.steps = [
          { id: 'route', title: 'Choose the workspace inspection', kind: 'choice', parentId: null,
            branch: { if: { and: [] }, then: 'inspect-workspace', else: 'alternative-list' } },
          { ...executionLeaf(), parentId: 'route' },
          { ...executionLeaf(), id: 'alternative-list', parentId: 'route', status: 'pending' }
        ];
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
  const f = await fixture(t, { execute: async (options, context) => {
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
  } });
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
