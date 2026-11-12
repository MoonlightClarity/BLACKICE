import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { HarnessEngine } from '../lib/engine.mjs';
import { TaskStateStore, createTaskToolHandler } from '../lib/task-state.mjs';
import { WORKSPACE_TOOL, createWorkspaceToolHandler } from '../lib/workspace-tools.mjs';
import { describeHostOperation } from '../lib/operation-descriptors.mjs';
import { createPlanningWorkerGuard } from '../lib/planning-awareness.mjs';
import { readContractJournal } from '../lib/planning-contract-runtime.mjs';

const body = result => JSON.parse(result.contentItems.find(item => item.type === 'inputText').text);
const call = (name, args) => ({ name, arguments: args, callId: randomUUID() });
const originalInput = 'Inspect input.txt, prepare the requested local artifact once, and preserve the original task until its result is verified.';
const workflow = model => ({ id: 'catalog-migration', name: 'Catalog migration',
  nodes: [{ id: 'input', type: 'input' }, { id: 'agent', type: 'agent', model, effort: 'high', sandbox: 'danger-full-access', prompt: 'Complete the supplied request.' }, { id: 'output', type: 'output' }],
  edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }], settings: { maxParallel: 1 } });

async function fixture(t, { provider = 'mistral-vibe', afterRefresh } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-provider-migration-'));
  const cwd = path.join(directory, 'workspace'); await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'input.txt'), 'Original fixture input.\n');
  const tasks = await new TaskStateStore({ dataDir: directory }).init();
  const model = provider + '::fixture-model', sourceDescription = WORKSPACE_TOOL.description;
  let context, changed = false;
  class Runtime extends EventEmitter {
    constructor() { super(); this.calls = []; }
    status() { return { connected: true, authenticated: true, defaultModel: model,
      models: [{ id: model, supportsTools: true, supportedReasoningEfforts: ['high'], contextWindowTokens: 262144 }] }; }
    async runAgent(options) {
      const threadId = options.threadId || (provider === 'mistral-vibe' ? 'vibe_' : 'provider_') + randomUUID();
      this.calls.push({ threadId: options.threadId, providerExecutionContract: structuredClone(options.providerExecutionContract), model: options.model, effort: options.effort, prompt: options.prompt });
      options.onEvent?.({ type: 'thread', threadId, model, providerId: provider });
      const invoke = async (name, args) => {
        const item = call(name, args), result = await options.onToolCall(item, { signal: options.signal });
        await options.onToolResultDelivered?.({ call: item, result }); return result;
      };
      if (this.calls.length === 1) {
        const current = body(await invoke('relay_task', { action: 'read' }));
        const descriptor = await describeHostOperation(call('relay_workspace', { action: 'list', path: '.' }), { cwd });
        const resourceKey = descriptor.resources.find(item => item.key.startsWith('workspace:')).key;
        const contract = { contractVersion: 2, goal: originalInput,
          criteria: [{ id: 'verified-result', kind: 'judgment', description: 'The original input and requested artifact have been checked using actual evidence.' }],
          workItems: [{ id: 'prepare-artifact', title: 'Prepare and verify artifact', objective: originalInput, owner: 'agent', resourceKeys: [resourceKey], effects: ['observe', 'interact', 'opaque'], dependsOn: [], criterionIds: ['verified-result'] }], instructions: [] };
        const planned = await invoke('relay_task', { action: 'plan', expectedRevision: current.revision, contract });
        assert.equal(planned.success, true, JSON.stringify(planned));
        assert.equal((await invoke('relay_workspace', { action: 'read', path: 'input.txt' })).success, true);
        throw Object.assign(new Error('Fixture pauses after recording its original intent and actual read.'), { code: 'FIXTURE_PAUSED' });
      }
      const current = body(await invoke('relay_task', { action: 'read' }));
      assert.equal(current.contract.goal, originalInput);
      await afterRefresh?.(options, { ...context, invoke, current });
      return { output: 'The saved task and its observations are preserved. No unverified artifact is claimed complete.', threadId };
    }
    async close() {}
  }
  const runtime = new Runtime();
  const engine = await new HarnessEngine({ runtime, tasks, dataDir: directory, defaultCwd: cwd }).init();
  engine.runtimeSettings = { get: () => ({ executionGuardrails: false }) };
  const settle = async accepted => { await engine.executions.get(accepted.id); return engine.getRun(accepted.id); };
  context = { engine, runtime, tasks, cwd, directory, model, settle };
  t.after(async () => { if (changed) WORKSPACE_TOOL.description = sourceDescription; await engine.close(); await tasks.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const first = await settle(engine.startRun({ workflow: workflow(model), input: originalInput, planningMode: 'forced' }));
  assert.equal(first.nodes.agent.errorCode, 'FIXTURE_PAUSED'); assert.equal(runtime.calls.length, 1);
  const savedContract = structuredClone(first.nodes.agent.providerExecutionContract);
  const savedPlan = structuredClone((await tasks.get(first.taskId)).contract);
  return { ...context, first, savedContract, savedPlan,
    changeCatalog() { WORKSPACE_TOOL.description = sourceDescription + ' Fixture catalog revision two.'; changed = true; },
    async rejectedContinuation() {
      const result = await settle(engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue the original request.', requestId: 'fixture-catalog-' + randomUUID() }, { historyRuns: [first] }));
      assert.equal(result.nodes.agent.errorCode, 'TASK_CONTRACT_FRESH_SESSION_REQUIRED');
      assert.equal(runtime.calls.length, 1, 'Catalog rejection must occur before another provider call.');
      return result;
    },
    async assertPreserved(result) {
      assert.equal(result.taskId, first.taskId); assert.equal(result.planningContractVersion, 14); assert.equal(result.planningEnforcement, undefined);
      assert.equal(result.cwd, cwd); assert.equal(result.workflow.nodes.find(node => node.id === 'agent').model, model);
      assert.deepEqual((await tasks.get(first.taskId)).contract, savedPlan);
      assert.deepEqual(engine.getRun(first.id).nodes.agent.providerExecutionContract, savedContract);
      assert.equal(engine.getRun(first.id).input, originalInput);
    },
  };
}

async function loseActualWriteReceipt(f) {
  const runId = 'lost-receipt-' + randomUUID(), nodeId = 'agent', taskId = f.first.taskId;
  const workspace = createWorkspaceToolHandler({ cwd: f.cwd, runId, nodeId });
  const handler = createTaskToolHandler({ store: f.tasks, taskId, runId, nodeId, task: originalInput, schemaVersion: 14, planningMode: 'on', executionGuardrails: true });
  const guard = await createPlanningWorkerGuard({ store: f.tasks, taskId, runId, nodeId, cwd: f.cwd, schemaVersion: 14, coordinator: true, executionGuardrails: true, getOperationAdapter: () => workspace });
  try {
    const read = call('relay_task', { action: 'read' });
    guard.observeToolDelivery({ call: read, result: await handler(read) });
    const write = call('relay_workspace', { action: 'write', path: 'written-once.txt', text: 'Actual single write.' });
    assert.equal(await guard.before(write), null);
    assert.equal((await workspace(write, guard.dispatchContext(write))).success, true);
    // The actual file was written, but the owning host did not receive its return receipt.
  } finally { await guard.finish('failed'); }
  const journal = await readContractJournal(f.tasks, taskId);
  const uncertain = journal.records.find(record => record.runId === runId);
  assert.equal(uncertain.deliveryState, 'dispatched');
  assert.ok((await f.tasks.get(taskId)).contractRuntime.unresolved.some(record => record.operationId === uncertain.operationId));
  return structuredClone(uncertain);
}

test('an unchanged catalog keeps the recorded same-model session on explicit Retry', async t => {
  const f = await fixture(t);
  const retried = await f.settle(f.engine.retryRun(f.first.id, { historyRuns: [f.first] }));
  assert.equal(f.runtime.calls.length, 2);
  assert.equal(f.runtime.calls[1].threadId, f.first.nodes.agent.threadId);
  assert.deepEqual(f.runtime.calls[1].providerExecutionContract, f.savedContract);
  assert.notEqual(retried.nodeHandoffs?.agent?.reason, 'execution-contract-refresh');
  await f.assertPreserved(retried);
});

for (const provider of ['mistral-vibe', 'fixture-api']) test('explicit Retry refreshes a rejected ' + provider + ' catalog without replaying an uncertain write', async t => {
  let attemptedReplay, observed;
  const f = await fixture(t, { provider, afterRefresh: async (options, { invoke }) => {
    assert.equal(options.threadId, undefined, 'The stale provider session must not be reopened.');
    assert.match(options.prompt, /RELAY CONTINUITY/); assert.ok(options.prompt.includes(originalInput));
    attemptedReplay = await invoke('relay_workspace', { action: 'write', path: 'written-once.txt', text: 'Must never replace the original.' });
    observed = await invoke('relay_workspace', { action: 'read', path: 'written-once.txt' });
  } });
  const uncertain = await loseActualWriteReceipt(f);
  f.changeCatalog();
  const rejected = await f.rejectedContinuation();
  const retried = await f.settle(f.engine.retryRun(rejected.id, { historyRuns: [f.first, rejected] }));
  assert.equal(f.runtime.calls.length, 2, retried.error || retried.nodes.agent.error);
  assert.equal(retried.nodeHandoffs?.agent?.reason, 'execution-contract-refresh');
  assert.equal(retried.nodeHandoffs.agent.sourceThreadId, f.first.nodes.agent.threadId);
  assert.equal(f.runtime.calls[1].model, f.model); assert.equal(f.runtime.calls[1].effort, 'high');
  assert.notEqual(f.runtime.calls[1].providerExecutionContract.catalogHash, f.savedContract.catalogHash);
  assert.equal(attemptedReplay.code, 'TASK_CONTRACT_EFFECT_UNCERTAIN'); assert.equal(observed.success, true);
  assert.equal(await fs.readFile(path.join(f.cwd, 'written-once.txt'), 'utf8'), 'Actual single write.');
  const journal = await readContractJournal(f.tasks, f.first.taskId);
  assert.deepEqual(journal.records.find(record => record.operationId === uncertain.operationId), uncertain);
  assert.equal(journal.records.filter(record => record.effect !== 'observe').length, 1);
  await f.assertPreserved(retried);
});

test('ordinary Continue records the explicit refresh boundary after a catalog rejection', async t => {
  const f = await fixture(t, { afterRefresh: options => assert.equal(options.threadId, undefined) });
  f.changeCatalog(); const rejected = await f.rejectedContinuation();
  const continued = await f.settle(f.engine.continueRun(rejected.id, { nodeId: 'agent', message: 'Continue the original request.' }, { historyRuns: [f.first, rejected] }));
  assert.equal(f.runtime.calls.length, 2);
  assert.equal(continued.modelHandoff?.reason, 'execution-contract-refresh');
  assert.equal(continued.modelHandoff.sourceThreadId, f.first.nodes.agent.threadId);
  await f.assertPreserved(continued);
});
