import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';
import { TaskStateStore, TASK_SCHEMA_VERSION } from '../lib/task-state.mjs';
import { recordFixturePlan } from './fixture-task-plan.mjs';

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
      : 'The actual saved receipts and separate assertions cover this fixture request; no further operation is needed before the final handoff.'
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
      this.calls.push(options);
      const threadId = options.threadId || `native-fixture-${this.calls.length}`;
      options.onEvent({ type: 'thread', threadId, model: 'fixture-model' });
      return { ...(await execute(options, this.calls.length, context)), threadId };
    }
  }
  const runtime = new Runtime(), engine = await new HarnessEngine({ runtime, tasks, dataDir: directory, defaultCwd: cwd }).init();
  engine.runtimeSettings = { get: () => ({ codexHistory: 'codex', executionGuardrails: true, subagentsEnabled: delegates, maxSubagents: 1 }) };
  context = { engine, runtime, tasks, cwd, async settle(id) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { const run = engine.getRun(id); if (run.settled) return run; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.fail('The sequential fixture did not settle.');
  }, start: planningMode => engine.startRun({ workflow: graph, input: 'Perform the local fixture operations.', planningMode }) };
  t.after(async () => { await engine.close(); await tasks.close(); await rm(directory, { recursive: true, force: true }); });
  return context;
}

test('actual engine requires planning before inspection and reconciles each operation before the next', async t => {
  const f = await fixture(t, async (options, count, context) => {
    const before = await tool(options, 'relay_workspace', { action: 'list' }, 'before-plan');
    assert.equal(before.code, 'TASK_PLAN_REQUIRED');
    let state = await task(options, { action: 'read' });
    state = await task(options, { action: 'plan', expectedRevision: state.revision, plan: { layout: 'sequence' }, steps: [leaf('write', 'active'), leaf('inspect', 'pending', 'read')] });
    assert.equal((await tool(options, 'relay_workspace', { action: 'write', path: 'fixture.txt', text: 'The actual fixture value.' }, 'first-write')).success, true);
    const premature = await tool(options, 'relay_workspace', { action: 'write', path: 'must-not-exist.txt', text: 'Repeated work.' }, 'premature-write');
    assert.equal(premature.code, 'TASK_PLAN_RESULT_REQUIRED');
    await assert.rejects(readFile(path.join(context.cwd, 'must-not-exist.txt')), { code: 'ENOENT' });
    state = await task(options, { action: 'step', expectedRevision: state.revision, stepId: 'write', status: 'done', evidence: 'The write returned the exact saved file path and byte count.' });
    state = await task(options, { action: 'step', expectedRevision: state.revision, stepId: 'inspect', status: 'active' });
    const observed = await tool(options, 'relay_workspace', { action: 'read', path: 'fixture.txt' }, 'second-read');
    assert.equal(observed.success, true, observed.contentItems[0].text);
    assert.match(observed.contentItems[0].text, /actual fixture value/);
    await task(options, { action: 'step', expectedRevision: state.revision, stepId: 'inspect', status: 'done', evidence: 'The file read returned The actual fixture value.' });
    await reviewCurrent(options);
    return { output: 'Wrote and separately checked the fixture value.' };
  });
  const run = await f.settle(f.start('on').id);
  assert.equal(run.status, 'completed', run.error);
  assert.equal(run.taskState.steps.filter(step => step.kind === 'action' && step.status === 'done').length, 2);
  assert.equal(run.taskState.executionObservations.total, 2, 'Rejected operations are not executed receipts.');
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
  assert.match(actions[1].blockedReason, /returned success:false/); assert.equal(run.taskState.executionObservations.total, 3);
});

test('native schema 9 continuation refreshes its provider session inside the same saved task', async t => {
  const f = await fixture(t, async (options, count) => {
    if (count === 1) return { output: 'The saved conversation already contains this prior context.' };
    assert.equal(options.threadId, undefined, 'A cached native catalog must receive a fresh provider session.');
    assert.match(options.prompt, /same Relay conversation/);
    assert.match(options.prompt, /saved conversation already contains this prior context/);
    const currentTool = options.dynamicTools.find(spec => spec.name === 'relay_task');
    assert.ok(currentTool.inputSchema.properties.operations.items.properties.type.enum.includes('revisit'));
    assert.ok(currentTool.inputSchema.properties.action.enum.includes('review'));
    let state = await task(options, { action: 'read' });
    state = await task(options, { action: 'plan', expectedRevision: state.revision, plan: { layout: 'sequence' }, steps: [{ ...leaf('answer', 'active'), operation: { kind: 'reasoning', target: 'Answer the saved follow-up question.' } }] });
    await task(options, { action: 'step', expectedRevision: state.revision, stepId: 'answer', status: 'done', evidence: 'The saved earlier context and current follow-up were compared to produce the answer.' });
    await reviewCurrent(options);
    return { output: 'The same conversation continued with current Planning tools.' };
  });
  const original = await f.settle(f.start('off').id); assert.equal(original.status, 'completed', original.error);
  const saved = f.engine.runs.get(original.id); saved.nodes.agent.taskSchemaVersion = 9;
  const accepted = f.engine.continueRun(original.id, { nodeId: 'agent', message: 'Continue the same task with Planning On.', planningMode: 'on' });
  assert.equal(accepted.taskId, original.taskId); assert.equal(accepted.parentRunId, original.id);
  assert.equal(accepted.modelHandoff.reason, 'planning-tool-upgrade');
  const continued = await f.settle(accepted.id);
  assert.equal(continued.status, 'completed', continued.error);
  assert.equal(continued.taskId, original.taskId); assert.equal(continued.nodes.agent.taskSchemaVersion, TASK_SCHEMA_VERSION);
  assert.equal(f.runtime.calls.length, 2);
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

test('retry upgrades an interrupted native catalog while retaining its task and saved transcript', async t => {
  const f = await fixture(t, async (options, count) => {
    if (count === 1) {
      options.onEvent({ type: 'delta', delta: 'An actual partial finding before interruption.' });
      throw new Error('The controlled native turn was interrupted.');
    }
    assert.equal(options.threadId, undefined);
    assert.match(options.prompt, /actual partial finding before interruption/);
    let state = await task(options, { action: 'read' });
    state = await task(options, { action: 'plan', expectedRevision: state.revision, plan: { layout: 'sequence' }, steps: [{ ...leaf('answer', 'active'), operation: { kind: 'reasoning', target: 'Reconcile the interrupted finding.' } }] });
    await task(options, { action: 'step', expectedRevision: state.revision, stepId: 'answer', status: 'done', evidence: 'The persisted partial finding and retry request were checked together.' });
    await reviewCurrent(options);
    return { output: 'Continued the interrupted task.' };
  });
  const original = await f.settle(f.start('off').id); assert.equal(original.status, 'failed');
  f.engine.runs.get(original.id).nodes.agent.taskSchemaVersion = 8;
  const accepted = f.engine.retryRun(original.id, { planningMode: 'on' });
  assert.equal(accepted.taskId, original.taskId); assert.equal(accepted.retryOf, original.id);
  assert.equal(accepted.nodeHandoffs.agent.reason, 'planning-tool-upgrade');
  const retried = await f.settle(accepted.id);
  assert.equal(retried.status, 'completed', retried.error); assert.equal(retried.nodes.agent.taskSchemaVersion, TASK_SCHEMA_VERSION);
});

test('one assigned worker follows the same leaf protocol without an enclosing dispatch deadlock', async t => {
  let childRan = false;
  const f = await fixture(t, async options => {
    if (options.prompt.startsWith('You are a short-lived BLACKICE subagent.')) {
      childRan = true;
      let state = await task(options, { action: 'read' });
      state = await task(options, { action: 'edit', expectedRevision: state.revision, operations: [{ type: 'update', stepId: 'assigned', patch: {
        operation: { kind: 'tool', tool: 'relay_workspace', action: 'write', target: 'fixture.txt' },
        note: 'Write the requested fixture value to fixture.txt.', result: 'The saved fixture value.', doneWhen: 'The workspace write returns its actual path and byte count.'
      } }] });
      assert.equal((await tool(options, 'relay_workspace', { action: 'write', path: 'fixture.txt', text: 'The worker value.' }, 'worker-write')).success, true);
      await task(options, { action: 'step', expectedRevision: state.revision, stepId: 'assigned', status: 'done', evidence: 'The worker received the actual fixture.txt path and written byte count.' });
      await reviewCurrent(options);
      return { output: 'The assigned operation returned its actual write result.' };
    }
    let state = await task(options, { action: 'read' });
    state = await task(options, { action: 'plan', expectedRevision: state.revision, plan: { layout: 'sequence' }, steps: [{ ...leaf('assigned', 'active'), operation: { kind: 'tool', tool: 'relay_delegate', target: 'assigned' } }] });
    const delegated = await tool(options, 'relay_delegate', { tasks: [{ id: 'one-worker', stepId: 'assigned', prompt: 'Write the one requested fixture value and record its actual result.' }] }, 'delegate-one');
    assert.equal(delegated.success, true, delegated.contentItems[0].text);
    await task(options, { action: 'read' });
    await reviewCurrent(options);
    return { output: 'The same task completed through its one assigned worker.' };
  }, { delegates: true });
  const run = await f.settle(f.start('on').id);
  assert.equal(run.status, 'completed', run.error); assert.equal(childRan, true);
  assert.equal(await readFile(path.join(f.cwd, 'fixture.txt'), 'utf8'), 'The worker value.');
});

test('a delegated review cannot acknowledge a new direction until its actual text reaches the worker', async t => {
  let parentOptions, continuationPrompt;
  const f = await fixture(t, async (options, count, context) => {
    if (options.prompt.startsWith('You are a short-lived BLACKICE subagent.')) {
      let state = await task(options, { action: 'read' });
      state = await task(options, { action: 'edit', expectedRevision: state.revision, operations: [{ type: 'update', stepId: 'assigned', patch: {
        operation: { kind: 'reasoning', target: 'The supplied $145 workshop subtotal and enrollment fee.' },
        note: 'Add the supplied enrollment fee to the $145 workshop subtotal.', result: 'The total bundle price.',
        doneWhen: 'The arithmetic uses the latest fee actually delivered to this worker.'
      } }] });
      state = await task(options, { action: 'step', expectedRevision: state.revision, stepId: 'assigned', status: 'done', evidence: 'The delivered $10 fee gives a $155 bundle total.' });
      // The parent receives this real direction while its child is still
      // working. Reading the plan alone does not deliver that direction text.
      const active = context.engine.listRuns().find(run => run.status === 'running');
      const receipt = await context.engine.steerRun(active.id, { nodeId: 'agent', message: 'Use a $20 enrollment fee instead of $10.' });
      assert.equal(receipt.accepted, true);
      await reviewCurrent(options);
      const returned = await options.onBeforeFinal({ output: 'The old total is $155.' });
      assert.equal(returned.continue, true);
      continuationPrompt = returned.prompt;
      assert.match(continuationPrompt, /Use a \$20 enrollment fee instead of \$10/);

      state = await task(options, { action: 'read' });
      state = await task(options, { action: 'edit', expectedRevision: state.revision, operations: [{ type: 'revisit', stepId: 'assigned', reason: 'The just-delivered user direction changes the enrollment fee to $20.' }] });
      state = await task(options, { action: 'step', expectedRevision: state.revision, stepId: 'assigned', status: 'active' });
      await task(options, { action: 'step', expectedRevision: state.revision, stepId: 'assigned', status: 'done', evidence: 'The delivered $20 fee plus $145 subtotal gives a corrected $165 bundle total.' });
      await reviewCurrent(options);
      assert.equal(await options.onBeforeFinal({ output: 'The current total is $165.' }), null);
      return { output: 'The current total is $165.' };
    }
    parentOptions = options;
    parentOptions.onEvent({ type: 'thread', threadId: 'parent-thread', turnId: 'parent-turn', model: 'fixture-model' });
    let state = await task(options, { action: 'read' });
    await task(options, { action: 'plan', expectedRevision: state.revision, plan: { layout: 'sequence' }, steps: [{ ...leaf('assigned', 'active'), operation: { kind: 'tool', tool: 'relay_delegate', target: 'assigned' } }] });
    const delegated = payload(await tool(options, 'relay_delegate', { tasks: [{ id: 'fee-worker', stepId: 'assigned', prompt: 'Add the $10 enrollment fee to the $145 workshop subtotal.' }] }, 'delegate-fee'));
    assert.equal(delegated.results[0].status, 'completed', delegated.results[0].error);
    assert.equal(delegated.results[0].output, 'The current total is $165.');
    await reviewCurrent(options);
    return { output: 'The current total is $165.' };
  }, { delegates: true });
  f.runtime.steerAgent = async threadId => ({ accepted: true, threadId, turnId: 'parent-turn' });
  const run = await f.settle(f.start('on').id);
  assert.equal(run.status, 'completed', run.error);
  assert.match(continuationPrompt, /CURRENT ACCEPTED USER CONTEXT/);
  const assigned = run.taskState.steps.find(step => step.id === 'assigned');
  assert.equal(assigned.attempt, 2);
  assert.match(assigned.pastAttempts[0].evidence, /\$155/);
  assert.match(assigned.evidence, /\$165/);
});
