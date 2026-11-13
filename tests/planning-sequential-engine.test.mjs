import { fixtureOutcomeReview, finishFixtureCandidate } from './fixture-modular-provider.mjs';
// Historical schema-13 protocol regression; schema-14 behavior has separate canonical-contract and production-engine acceptance coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from './fixture-legacy-planning-engine.mjs';
import { TaskStateStore } from './fixture-legacy-task-state.mjs';
import { recordFixturePlan } from './fixture-task-plan.mjs';
import { fixtureDeferredUserAgency } from './fixture-user-agency.mjs';

const payload = receipt => JSON.parse(receipt.contentItems[0].text);
const tool = (options, name, args, callId) => options.onToolCall({ name, arguments: args, callId });
async function task(options, args) {
  const receipt = await tool(options, 'relay_task', args);
  assert.equal(receipt.success, true, receipt.contentItems[0].text); return payload(receipt);
}
async function reviewCurrent(options, decision = 'respond') {
  const current = await task(options, { action: 'read' });
  return task(options, { action: 'review', expectedRevision: current.revision, review: {
    decision, summary: decision === 'blocked'
      ? 'The fixture compared all actual responses: the recorded missing-file action remains blocked, independent checks are complete, and no ready work remains.'
      : 'The actual saved receipts and separate assertions cover this fixture request; no further operation is needed before the final handoff.',
    ...(decision === 'blocked' && options.dynamicTools?.find(item => item.name === 'relay_task')?.inputSchema?.properties?.review?.properties?.userAgency
      ? { userAgency: fixtureDeferredUserAgency('The actual missing-file read returned a missing-file error; independent write and read checks are complete.') } : {})
  } });
}
const leaf = (id, status, action = 'write') => ({ id, title: `Perform ${id}`, kind: 'action', status,
  result: `The ${id} work product.`, note: `Perform the one ${action} operation against fixture.txt.`,
  doneWhen: `The actual ${id} operation result has been checked.`,
  operation: { kind: 'tool', tool: 'relay_workspace', action, target: 'fixture.txt' } });
const graph = { id: 'sequential-fixture', name: 'Sequential fixture', settings: { maxParallel: 1 },
  nodes: [{ id: 'input', type: 'input' }, { id: 'agent', type: 'agent', model: 'fixture-model', prompt: 'Perform the requested operations.' }, { id: 'output', type: 'output' }],
  edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }] };
async function fixture(t, execute, { delegates = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-sequential-engine-')), cwd = path.join(directory, 'work'); await mkdir(cwd);
  const tasks = await new TaskStateStore({ dataDir: directory }).init(); let context;
  class Runtime extends EventEmitter {
    calls = [];
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture-model', models: [{ id: 'fixture-model', supportsTools: true, contextWindowTokens: 128000 }] }; }
    async runAgent(options) {
      const review = fixtureOutcomeReview(options); if (review) return review;
      this.calls.push(options);
      const threadId = options.threadId || `native-fixture-${this.calls.length}`;
      options.onEvent({ type: 'thread', threadId, model: 'fixture-model' });
      return finishFixtureCandidate(options, { ...(await execute(options, this.calls.length, context)), threadId });
    }
  }
  const runtime = new Runtime(), engine = await new HarnessEngine({ runtime, tasks, dataDir: directory, defaultCwd: cwd }).init();
  engine.runtimeSettings = { get: () => ({ codexHistory: 'codex', executionGuardrails: true, subagentsEnabled: delegates, maxSubagents: 1, planningOntology:{version:2,modules:{decomposition:true}} }) };
  context = { engine, runtime, tasks, cwd, async settle(id) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { const run = engine.getRun(id); if (run.settled) return run; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.fail('The sequential fixture did not settle.');
  }, start: planningMode => engine.startRun({ workflow: graph, input: 'Perform the local fixture operations.', planningMode }) };
  t.after(async () => { await engine.close(); await tasks.close(); await rm(directory, { recursive: true, force: true }); });
  return context;
}

test('ordinary engine tools are independent of optional bookkeeping while callback identity still prevents repeats', async t => {
  const f = await fixture(t, async (options, count, context) => {
    assert.equal((await tool(options, 'relay_workspace', { action: 'list' }, 'before-plan')).success, true);
    let state = await task(options, { action: 'read' });
    state = await task(options, { action: 'plan', expectedRevision: state.revision, plan: { layout: 'sequence' }, steps: [leaf('write', 'active'), leaf('inspect', 'pending', 'read')] });
    const write = { action: 'write', path: 'fixture.txt', text: 'The actual fixture value.' };
    const first = await tool(options, 'relay_workspace', write, 'first-write');
    assert.equal(first.success, true);
    assert.deepEqual(await tool(options, 'relay_workspace', write, 'first-write'), first);
    const changed = await tool(options, 'relay_workspace', { ...write, text: 'A changed payload.' }, 'first-write');
    assert.equal(changed.code, 'TOOL_CALL_ID_CONFLICT');
    const observed = await tool(options, 'relay_workspace', { action: 'read', path: 'fixture.txt' }, 'second-read');
    assert.equal(observed.success, true); assert.match(observed.contentItems[0].text, /actual fixture value/);
    assert.equal(await readFile(path.join(context.cwd, 'fixture.txt'), 'utf8'), write.text);
    state = await task(options, { action: 'step', expectedRevision: state.revision, stepId: 'write', status: 'done', evidence: 'The write receipt and separate read identify the exact saved bytes.' });
    await task(options, { action: 'step', expectedRevision: state.revision, stepId: 'inspect', status: 'done', evidence: 'The file read returned The actual fixture value.' });
    await reviewCurrent(options);
    return { output: 'Wrote once and separately checked the fixture value.' };
  });
  const run = await f.settle(f.start('on').id); assert.equal(run.status, 'completed', run.error);
  assert.equal(run.taskState.steps.filter(step => step.kind === 'action' && step.status === 'done').length, 2);
  assert.equal(run.nodes.agent.planning.status, 'off');
});

test('shared tool fixtures save and settle separate actual calls, preserving failed outcomes', async t => {
  const f = await fixture(t, async options => {
    await recordFixturePlan(options, { title: 'Check actual independent workspace responses' });
    assert.equal((await tool(options, 'relay_workspace', { action: 'write', path: 'fixture.txt', text: 'Actual written fixture.' }, 'fixture-write')).success, true);
    const missing = await tool(options, 'relay_workspace', { action: 'read', path: 'missing.txt' }, 'fixture-missing');
    assert.equal(missing.success, false); assert.match(missing.contentItems[0].text, /ENOENT|not found|does not exist/i);
    const read = await tool(options, 'relay_workspace', { action: 'read', path: 'fixture.txt' }, 'fixture-read');
    assert.equal(read.success, true); assert.match(read.contentItems[0].text, /Actual written fixture/);
    await reviewCurrent(options, 'blocked');
    return { output: 'The independent actual responses were checked.' };
  });
  const run = await f.settle(f.start('on').id);
  assert.equal(run.status, 'completed', run.error);
  const actions = run.taskState.steps.filter(step => step.operation?.kind === 'tool');
  assert.equal(actions.length, 3); assert.deepEqual(actions.map(step => step.status), ['done', 'blocked', 'done']);
  assert.match(actions[1].blockedReason, /returned success:false/); assert.equal(run.nodes.agent.planning.status, 'off');
});

test('native schema 9 continuation preserves its cached session and tool catalog without automatic upgrade', async t => {
  const f = await fixture(t, async (options, count) => {
    if (count === 1) return { output: 'The saved conversation already contains this prior context.' };
    assert.equal(options.threadId, 'native-fixture-1');
    assert.equal(options.onBeforeFinal, undefined);
    const currentTool = options.dynamicTools.find(spec => spec.name === 'relay_task');
    assert.ok(!currentTool.inputSchema.properties.action.enum.includes('review'), 'Schema 9 remains the captured schema.');
    assert.equal((await tool(options, 'relay_workspace', { action: 'list' }, 'historical-list')).success, true);
    return { output: 'The same conversation continued without a forced upgrade.' };
  });
  const original = await f.settle(f.start('off').id); assert.equal(original.status, 'completed', original.error);
  f.engine.runs.get(original.id).nodes.agent.taskSchemaVersion = 9;
  const accepted = f.engine.continueRun(original.id, { nodeId: 'agent', message: 'Continue the same task.', planningMode: 'on' });
  assert.equal(accepted.taskId, original.taskId); assert.equal(accepted.parentRunId, original.id); assert.equal(accepted.modelHandoff, undefined);
  const continued = await f.settle(accepted.id); assert.equal(continued.status, 'completed', continued.error);
  assert.equal(continued.nodes.agent.taskSchemaVersion, 9); assert.equal(f.runtime.calls.length, 2);
});

test('Planning Off continuation keeps its existing native session and unrestricted operation flow', async t => {
  const f = await fixture(t, async (options, count) => {
    if (count === 2) {
      assert.equal(options.threadId, 'native-fixture-1');
      for (const name of ['first.txt', 'second.txt']) assert.equal((await tool(options, 'relay_workspace', { action: 'write', path: name, text: name }, name)).success, true);
    }
    return { output: 'The Off fixture continued.' };
  });
  const original = await f.settle(f.start('off').id); f.engine.runs.get(original.id).nodes.agent.taskSchemaVersion = 8;
  const continued = await f.settle(f.engine.continueRun(original.id, { nodeId: 'agent', message: 'Continue without automatic planning.', planningMode: 'off' }).id);
  assert.equal(continued.status, 'completed', continued.error); assert.equal(continued.modelHandoff, undefined);
  assert.equal(continued.taskId, original.taskId);
});

test('retry preserves an interrupted native catalog, task identity and saved partial output', async t => {
  const f = await fixture(t, async (options, count) => {
    if (count === 1) {
      options.onEvent({ type: 'delta', delta: 'An actual partial finding before interruption.' });
      throw new Error('The controlled native turn was interrupted.');
    }
    assert.equal(options.threadId, 'native-fixture-1');
    assert.equal(options.onBeforeFinal, undefined);
    assert.equal((await tool(options, 'relay_workspace', { action: 'list' }, 'retry-list')).success, true);
    return { output: 'Continued the interrupted task.' };
  });
  const original = await f.settle(f.start('off').id); assert.equal(original.status, 'failed');
  assert.equal(original.nodes.agent.output, 'An actual partial finding before interruption.');
  f.engine.runs.get(original.id).nodes.agent.taskSchemaVersion = 8;
  const accepted = f.engine.retryRun(original.id, { planningMode: 'on' });
  assert.equal(accepted.taskId, original.taskId); assert.equal(accepted.retryOf, original.id); assert.equal(accepted.nodeHandoffs, undefined);
  const retried = await f.settle(accepted.id); assert.equal(retried.status, 'completed', retried.error);
  assert.equal(retried.nodes.agent.taskSchemaVersion, 8);
  assert.equal(f.engine.getRun(original.id).nodes.agent.output, 'An actual partial finding before interruption.');
});

test('a historical one-slot delegation is rejected without worker execution or a partial write', async t => {
  let childCalls = 0;
  const f = await fixture(t, async options => {
    if (options.prompt.startsWith('You are a short-lived BLACKICE subagent.')) {
      childCalls++; assert.fail('One worker slot cannot supply a parallel speedup.');
    }
    const delegated = await tool(options, 'relay_delegate', { tasks: [{ id: 'one-worker', stepId: 'assigned', prompt: 'Write the one requested fixture value and record its actual result.' }] }, 'delegate-one');
    assert.equal(delegated.success, false);
    assert.equal(payload(delegated).code, 'SUBAGENT_NO_PARALLEL_CAPACITY');
    assert.equal(payload(delegated).providerCalls, 0); assert.equal(payload(delegated).gate, 'static_dag');
    return { output: 'The coordinator retains the serial write; no child wrote the fixture.' };
  }, { delegates: true });
  const run = await f.settle(f.start('on').id);
  assert.equal(run.status, 'completed', run.error); assert.equal(childCalls, 0);
  await assert.rejects(readFile(path.join(f.cwd, 'fixture.txt')), { code: 'ENOENT' });
});

test('a fully serial historical delegation is rejected even when two worker slots are available', async t => {
  let childCalls = 0, steerCalls = 0;
  const f = await fixture(t, async options => {
    if (options.prompt.startsWith('You are a short-lived BLACKICE subagent.')) {
      childCalls++; assert.fail('A fully serial batch must remain with the coordinator.');
    }
    const delegated = await tool(options, 'relay_delegate', { tasks: [
      { id: 'fee-worker', prompt: 'Add the $10 enrollment fee to the $145 workshop subtotal.' },
      { id: 'reviewer', dependsOn: ['fee-worker'], prompt: 'Check the returned fee-worker total.' }
    ] }, 'delegate-fee');
    assert.equal(delegated.success, false); assert.equal(payload(delegated).code, 'SUBAGENT_SERIAL_DAG');
    assert.equal(payload(delegated).providerCalls, 0); assert.equal(payload(delegated).gate, 'static_dag');
    return { output: 'The coordinator retains the dependent calculation and review.' };
  }, { delegates: true });
  f.engine.runtimeSettings = { get: () => ({ codexHistory: 'codex', executionGuardrails: true, subagentsEnabled: true, maxSubagents: 2 }) };
  f.runtime.steerAgent = async () => { steerCalls++; assert.fail('No rejected child can request a steering continuation.'); };
  const run = await f.settle(f.start('on').id);
  assert.equal(run.status, 'completed', run.error); assert.equal(childCalls, 0); assert.equal(steerCalls, 0);
  assert.ok(!run.events.some(event => event.data?.type === 'subagent' && event.data.status === 'running'));
});
