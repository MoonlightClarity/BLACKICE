import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';
import { replyTarget } from '../public/next/chat/model.mjs';
import { submitChat } from '../public/next/chat/send.mjs';
import { projectFamily } from '../public/next/chat/reader-model.mjs';

const graph = () => ({
  id: 'model-switch-failed-run',
  name: 'Switch models after provider failure',
  nodes: [
    { id: 'input', type: 'input' },
    { id: 'agent', type: 'agent', model: 'initial-model', name: 'Assistant', prompt: 'Respond to the user request using the currently selected model.' },
    { id: 'output', type: 'output' },
  ],
  edges: [
    { source: 'input', target: 'agent' },
    { source: 'agent', target: 'output' },
  ],
  settings: { maxParallel: 1, planningMode: 'off' },
});

const priorRun = (status, nodeStatus, settled = true) => ({
  id: 'failed-provider-run',
  taskId: 'same-conversation',
  status,
  settled,
  input: 'Original request that encountered a rate limit',
  workflow: graph(),
  nodes: {
    input: { status: 'completed' },
    agent: { status: nodeStatus },
    output: { status: nodeStatus === 'completed' ? 'completed' : 'skipped' },
  },
  error: status === 'failed' ? 'Provider returned HTTP 429, token limit exceeded.' : undefined,
  errorCode: status === 'failed' ? 'PROVIDER_RATE_LIMIT' : undefined,
  events: [],
});

test('failed rate-limited run is a valid continuation target even if its agent did not finish starting', async () => {
  const original = priorRun('failed', 'queued');
  const projected = projectFamily({ runs: [original] }).runs;
  assert.equal(replyTarget(projected).nodeId, 'agent');
  assert.equal(projected[0].errorCode, 'PROVIDER_RATE_LIMIT');
  const calls = [];
  const api = async (url, method, body) => {
    calls.push({ url, method, body });
    return { id: 'new-response', taskId: 'same-conversation', status: 'queued' };
  };
  const result = await submitChat({
    api, runs: projected, task: 'Try the alternative model using this conversation',
    model: 'alternate-model',
  });
  assert.equal(result.mode, 'continued');
  assert.deepEqual(calls.map(call => call.url), ['/api/runs/failed-provider-run/continue']);
  assert.equal(calls[0].body.nodeId, 'agent');
  assert.equal(calls[0].body.model, 'alternate-model');
});

test('a completed run with no stopped agent and an actively settling run are not silently resumed', () => {
  assert.equal(replyTarget([priorRun('completed', 'queued')]).nodeId, null);
  assert.equal(replyTarget([priorRun('failed', 'queued', false)]).nodeId, null);
});

class NativeRuntime extends EventEmitter {
  calls = [];
  status() {
    return { connected: true, authenticated: true, defaultModel: 'initial-model', models: [
      { id: 'initial-model', model: 'initial-model' },
      { id: 'alternate-model', model: 'alternate-model' },
    ] };
  }
  async runAgent(options) {
    this.calls.push(options);
    const threadId = options.threadId || 'synthetic-thread-' + this.calls.length;
    options.onEvent?.({ type: 'thread', threadId, model: options.model, codexHistory: 'relay' });
    return { output: 'Response by ' + options.model, threadId, codexHistory: 'relay' };
  }
  async close() {}
}

test('engine admits a new model after a settled pre-agent failure without losing conversation identity or resuming an unsafe session', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-model-switch-'));
  const cwd = path.join(root, 'cwd');
  await mkdir(cwd);
  const runtime = new NativeRuntime();
  const engine = await new HarnessEngine({ runtime, defaultCwd: cwd, dataDir: path.join(root, 'data') }).init();
  engine.runtimeSettings = { get: () => ({ codexHistory: 'relay' }) };
  t.after(async () => {
    await engine.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  const first = engine.startRun({ workflow: graph(), input: 'The original discussion' });
  await engine.executions.get(first.id);
  const original = engine.runs.get(first.id);
  assert.equal(original.status, 'completed', original.error);
  assert.equal(runtime.calls.length, 1);
  // Reproduce a durable terminal host failure before the agent node reaches a terminal state.
  original.status = 'failed';
  original.error = 'HTTP 429 from model API before startup completed';
  original.errorCode = 'PROVIDER_RATE_LIMIT';
  original.settled = true;
  original.nodes.agent.status = 'queued';
  const oldThread = original.nodes.agent.threadId;

  const savedRuns = [structuredClone(original)];
  const following = engine.continueRun(original.id, {
    nodeId: 'agent', message: 'Use the alternative model and keep this conversation',
    model: 'alternate-model', requestId: 'failed-model-switch-accepted-once',
  }, { historyRuns: savedRuns });
  assert.equal(following.parentRunId, original.id);
  assert.equal(following.taskId, original.taskId);
  assert.equal(following.workflow.nodes.find(node => node.id === 'agent').model, 'alternate-model');
  assert.equal(following.nodes.agent.resumeThreadId, undefined, 'do not resume a stopped or incomplete old session');
  assert.equal(engine.continueRun(original.id, {
    nodeId: 'agent', message: 'Use the alternative model and keep this conversation',
    model: 'alternate-model', requestId: 'failed-model-switch-accepted-once',
  }, { historyRuns: savedRuns }).id, following.id, 'idempotent replay does not create a second run');
  await engine.executions.get(following.id);
  const stored = engine.getRun(following.id);
  assert.equal(stored.status, 'completed', stored.error);
  assert.equal(runtime.calls.length, 2);
  assert.equal(runtime.calls[1].model, 'alternate-model');
  assert.notEqual(stored.nodes.agent.threadId, oldThread);
  assert.equal(engine.getRun(original.id).errorCode, 'PROVIDER_RATE_LIMIT', 'historical failure remains attributed to its original model');
});
