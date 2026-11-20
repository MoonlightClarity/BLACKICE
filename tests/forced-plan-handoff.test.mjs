import { fixtureOutcomeReview, finishFixtureCandidate } from './fixture-modular-provider.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';
import { TaskStateStore } from '../lib/task-state.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';

const request = 'List the files in the current workspace.';
const payload = receipt => JSON.parse(receipt.contentItems.find(item => item.type === 'inputText').text);
const tool = (options, name, args, callId) => options.onToolCall({ name, arguments: args, callId });
function executionLeaf() {
  return {
    id: 'inspect-workspace', title: 'List the current workspace entries', kind: 'action', parentId: null, status: 'active',
    operation: { kind: 'tool', tool: 'relay_workspace', action: 'list', target: '.' },
    result: 'The actual directory entries returned for the current workspace.',
    note: 'Call relay_workspace list once for path "." and inspect its returned entries.',
    doneWhen: 'The actual list receipt identifies the current workspace and its entries; no entry is invented.'
  };
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
  const settings = { defaultModel: 'fixture-handoff', defaultEffort: 'low', executionGuardrails: false, runTimeoutMs: null, planningOntology:{version:2,modules:{decomposition:true}} };
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
  context = { directory, cwd, tasks, engine, runtime, observations, async operation(options, args) {
    const receipt = await tool(options, 'relay_workspace', args, 'ordinary-operation-' + observations.operations.length);
    const activeRun = engine.listRuns()[0], observedState = await tasks.get(activeRun.taskId);
    observations.operations.push({ args, receipt, awareness: tasks.awareness.snapshot(observedState) });
    return receipt;
  } };
  t.after(async () => {
    await engine.close(); await tasks.close();
    assert.match(path.basename(directory), /^blackice-forced-handoff-/);
    await rm(directory, { recursive: true, force: true });
  });
  context.run = async (input = request) => {
    const workflow = createMissionWorkflow({ id: 'ordinary-forced-handoff', task: request, model: 'fixture-handoff', cwd, planningMode: 'forced' });
    const accepted = engine.startRun({ workflow, input, planningMode: 'forced', planningExecutionMode: 'automatic', requestId: 'ordinary-forced-handoff' });
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

test('a human correction remains unread while ordinary execution no longer has a compulsory plan-review gate', async t => {
  const f = await fixture(t, { execute: async (options, context) => {
    const receipt = await tool(options, 'relay_task', { action: 'read' });
    assert.equal(receipt.success, true, receipt.contentItems?.[0]?.text);
    let state = payload(receipt);
    state = await context.tasks.setPlan(state.taskId, { plan: { layout: 'sequence', detail: 'detailed', taskType: 'general' }, steps: [executionLeaf()] }, { expectedRevision: state.revision, source: 'human' });
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
  const run = await f.run('/plan '+request); assert.equal(run.status, 'completed', run.error);
  assert.equal(run.taskState.steps[0].note, f.observations.changed.steps[0].note);
  assert.equal(run.taskState.steps[0].status, 'active', 'An answer cannot fabricate completion of optional authored steps.');
});

test('an optional listing outline does not veto an independent write or fabricate its completion', async t => {
  const f = await fixture(t, { execute: async (options, context, initial) => {
    assert.ok(!options.dynamicTools.some(tool => tool.name === 'relay_task'));
    const saved = await context.tasks.setPlan(initial.taskId, { plan: { layout: 'sequence', taskType: 'general' }, steps: [executionLeaf()] }, { expectedRevision: initial.revision, source: 'human' });
    assert.equal(saved.plan.origin, 'human');
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

test('an ordinary request needs no preparatory Plan or response-cycle service', async t => {
  const f = await fixture(t, { withPlanning: false, execute: completeListing });
  const run = await f.run(); assert.equal(run.status, 'completed', run.error);
  assert.deepEqual(f.observations.atWorkerEntry.state.steps, []);
  assert.equal(f.observations.operations[0].receipt.success, true);
  assert.equal(run.responseCycle, undefined);
});
