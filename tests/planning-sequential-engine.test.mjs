import { fixtureOutcomeReview, finishFixtureCandidate } from './fixture-modular-provider.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';
import { TaskStateStore } from '../lib/task-state.mjs';

const payload = receipt => JSON.parse(receipt.contentItems[0].text);
const tool = (options, name, args, callId) => options.onToolCall({ name, arguments: args, callId });
async function task(options, args) {
  const receipt = await tool(options, 'relay_task', args);
  assert.equal(receipt.success, true, receipt.contentItems[0].text); return payload(receipt);
}
const leaf = (id, status, action = 'write') => ({ id, title: `Perform ${id}`, kind: 'action', status,
  result: `The ${id} work product.`, note: `Perform the one ${action} operation against fixture.txt.`,
  doneWhen: `The actual ${id} operation result has been checked.`,
  operation: { kind: 'tool', tool: 'relay_workspace', action, target: 'fixture.txt' } });
const graph = { id: 'sequential-fixture', name: 'Sequential fixture', settings: { maxParallel: 1 },
  nodes: [{ id: 'input', type: 'input' }, { id: 'agent', type: 'agent', model: 'fixture-model', prompt: 'Perform the requested operations.' }, { id: 'output', type: 'output' }],
  edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }] };
async function fixture(t, execute, { delegates = false, manualPlanning = false } = {}) {
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
  }, start: planningMode => engine.startRun({ workflow: manualPlanning ? {...graph,planning:{shared:true,coordinatorNodeId:'agent'}} : graph, input: 'Perform the local fixture operations.', planningMode }) };
  t.after(async () => { await engine.close(); await tasks.close(); await rm(directory, { recursive: true, force: true }); });
  return context;
}

test('ordinary engine tools are independent of optional bookkeeping while callback identity still prevents repeats', async t => {
  const f = await fixture(t, async (options, count, context) => {
    assert.equal((await tool(options, 'relay_workspace', { action: 'list' }, 'before-plan')).success, true);
    let state = await task(options, { action: 'read' });
    state = await context.tasks.setPlan(state.taskId, { plan: { layout: 'sequence' }, steps: [leaf('write', 'active'), leaf('inspect', 'pending', 'read')] }, { expectedRevision: state.revision, source: 'human' });
    const write = { action: 'write', path: 'fixture.txt', text: 'The actual fixture value.' };
    const first = await tool(options, 'relay_workspace', write, 'first-write');
    assert.equal(first.success, true);
    assert.deepEqual(await tool(options, 'relay_workspace', write, 'first-write'), first);
    const changed = await tool(options, 'relay_workspace', { ...write, text: 'A changed payload.' }, 'first-write');
    assert.equal(changed.code, 'TOOL_CALL_ID_CONFLICT');
    const observed = await tool(options, 'relay_workspace', { action: 'read', path: 'fixture.txt' }, 'second-read');
    assert.equal(observed.success, true); assert.match(observed.contentItems[0].text, /actual fixture value/);
    assert.equal(await readFile(path.join(context.cwd, 'fixture.txt'), 'utf8'), write.text);
    state = await context.tasks.setStep(state.taskId, 'write', { status: 'done', evidence: 'The write receipt and separate read identify the exact saved bytes.' }, { expectedRevision: state.revision, source: 'human' });
    await context.tasks.setStep(state.taskId, 'inspect', { status: 'done', evidence: 'The file read returned The actual fixture value.' }, { expectedRevision: state.revision, source: 'human' });
    return { output: 'Wrote once and separately checked the fixture value.' };
  }, {manualPlanning:true});
  const run = await f.settle(f.start('off').id); assert.equal(run.status, 'completed', run.error);
  assert.equal(run.taskState.steps.filter(step => step.kind === 'action' && step.status === 'done').length, 2);
  assert.equal(run.nodes.agent.planning.status, 'off');
});

test('independent calls preserve actual failures and saved dispatch evidence without inventing plan completion', async t => {
  const f = await fixture(t, async options => {
    assert.equal((await tool(options, 'relay_workspace', { action: 'write', path: 'fixture.txt', text: 'Actual written fixture.' }, 'fixture-write')).success, true);
    const missing = await tool(options, 'relay_workspace', { action: 'read', path: 'missing.txt' }, 'fixture-missing');
    assert.equal(missing.success, false); assert.match(missing.contentItems[0].text, /ENOENT|not found|does not exist/i);
    const read = await tool(options, 'relay_workspace', { action: 'read', path: 'fixture.txt' }, 'fixture-read');
    assert.equal(read.success, true); assert.match(read.contentItems[0].text, /Actual written fixture/);
    return { output: 'The independent actual responses were checked.' };
  });
  const run = await f.settle(f.start('on').id);
  assert.equal(run.status, 'completed', run.error);
  const actions = run.events.filter(event => event.data?.type === 'workspace.action').map(event => event.data);
  assert.deepEqual(actions.map(item => [item.action, path.basename(item.path)]), [['write', 'fixture.txt'], ['read', 'missing.txt'], ['read', 'fixture.txt']]);
  assert.equal(run.events.filter(event => event.data?.type === 'operational.effect' && event.data.state === 'confirmed').length, 1);
  assert.equal(await readFile(path.join(f.cwd, 'fixture.txt'), 'utf8'), 'Actual written fixture.');
  assert.deepEqual(run.taskState.steps, [], 'Actual dispatch must not manufacture authored plan steps or outcome completion.');
  assert.equal(run.nodes.agent.planning.status, 'off');
});

test('unsupported native task schema rejects continuation before provider work', async t => {
  const f = await fixture(t, async options => {
    assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_task'));
    return {output:'Prior current task context.'};
  }, {manualPlanning:true});
  const original = await f.settle(f.start('off').id);
  assert.equal(original.status, 'completed', original.error);
  const durablePlan=await f.tasks.get(original.taskId),count=f.engine.runs.size;
  const saved=f.engine.runs.get(original.id);saved.nodes.agent.taskSchemaVersion=9;const before=structuredClone(saved);
  assert.throws(() => f.engine.continueRun(original.id, { nodeId: 'agent', message: 'Continue the same task.' }), { code: 'NATIVE_CATALOG_UNSUPPORTED' });
  assert.equal(f.runtime.calls.length,1);assert.equal(f.engine.runs.size,count);
  assert.deepEqual(saved,before);assert.deepEqual(await f.tasks.get(original.taskId),durablePlan);
  assert.equal(f.engine.getRun(original.id).nodes.agent.output,'Prior current task context.');
});

test('Planning Off continuation keeps its existing native session and unrestricted operation flow', async t => {
  const f = await fixture(t, async (options, count) => {
    if (count === 2) {
      assert.equal(options.threadId, 'native-fixture-1');
      for (const name of ['first.txt', 'second.txt']) assert.equal((await tool(options, 'relay_workspace', { action: 'write', path: name, text: name }, name)).success, true);
    }
    return { output: 'The Off fixture continued.' };
  });
  const original = await f.settle(f.start('off').id);
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
    assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_task'));
    return { output: 'Continued the interrupted task.' };
  }, {manualPlanning:true});
  const original = await f.settle(f.start('off').id); assert.equal(original.status, 'failed');
  assert.equal(original.nodes.agent.output, 'An actual partial finding before interruption.');
  const accepted = f.engine.retryRun(original.id, { planningMode: 'on' });
  assert.equal(accepted.taskId, original.taskId); assert.equal(accepted.retryOf, original.id); assert.equal(accepted.nodeHandoffs, undefined);
  const retried = await f.settle(accepted.id); assert.equal(retried.status, 'completed', retried.error);
  assert.equal(retried.nodes.agent.taskSchemaVersion, 14);
  assert.deepEqual(retried.nodes.agent.toolNames,original.nodes.agent.toolNames);
  assert.equal(f.engine.getRun(original.id).nodes.agent.output, 'An actual partial finding before interruption.');
});

test('a historical one-slot delegation is rejected without worker execution or a partial write', async t => {
  let childCalls = 0;
  const f = await fixture(t, async options => {
    if (options.hostAgentRole==='delegate') {
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
    if (options.hostAgentRole==='delegate') {
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
