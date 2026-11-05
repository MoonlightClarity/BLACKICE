import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';

const MODEL = 'mistral-vibe::fixture-alias-a';
const OTHER_MODEL = 'mistral-vibe::fixture-alias-b';
const graph = (model = MODEL) => ({
  id: 'vibe-history-fixture', name: 'Vibe continuation fixture',
  nodes: [{ id: 'input', type: 'input' }, { id: 'agent', type: 'agent', name: 'Agent', model, effort: 'default', prompt: 'Complete the fixture task.' }, { id: 'output', type: 'output' }],
  edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }],
  settings: { maxParallel: 1, planningMode: 'off' },
});

class FixtureRuntime extends EventEmitter {
  constructor() {
    super(); this.calls = []; this.compactions = []; this.defaultModel = MODEL;
    this.failure = null; this.rejectResume = false;
  }
  status() {
    return { connected: true, authenticated: true, isolatedHistory: true, defaultModel: this.defaultModel,
      models: [MODEL, OTHER_MODEL, 'fixture-codex'].map(model => ({ id: model, model, available: true, supportsTools: true, contextWindowTokens: 200000, maxOutputTokens: 8192 })) };
  }
  async runAgent(options) {
    this.calls.push(options);
    const provider = options.model?.startsWith('mistral-vibe::') ? 'mistral-vibe' : 'codex';
    const threadId = options.threadId || (provider === 'mistral-vibe' ? 'vibe_' : 'codex_') + this.calls.length;
    const turnId = 'turn_' + this.calls.length;
    options.onEvent?.({ type: 'thread', threadId, turnId, model: options.model, providerId: provider, resumed: Boolean(options.threadId) });
    if (this.rejectResume && options.threadId) throw Object.assign(new Error('The saved turn is uncertain; observe it before continuing.'), { code: 'VIBE_TURN_UNCERTAIN' });
    if (this.failure) { const failure = this.failure; this.failure = null; throw failure; }
    options.onEvent?.({ type: 'message', threadId, turnId, phase: 'final_answer', text: 'Fixture result.' });
    options.onEvent?.({ type: 'turn', threadId, turnId, status: 'completed' });
    return { output: 'Fixture result.', threadId, turnId };
  }
  async compactThread(threadId, options) { this.compactions.push({ threadId, options }); throw Object.assign(new Error('Vibe compaction is not supported.'), { code: 'VIBE_COMPACTION_UNSUPPORTED' }); }
}

async function harness(t, runtime = new FixtureRuntime()) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-vibe-engine-'));
  const cwd = path.join(directory, 'workspace'), dataDir = path.join(directory, 'data');
  await mkdir(cwd);
  const engine = new HarnessEngine({ runtime, dataDir, defaultCwd: cwd });
  engine.runtimeSettings = { get: () => ({ codexHistory: 'relay', runTimeoutMs: null, executionGuardrails: false }) };
  await engine.init();
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  return { engine, runtime };
}
async function finish(engine, run) {
  await engine.executions.get(run.id);
  const result = engine.getRun(run.id);
  assert.equal(result.settled, true);
  return result;
}
async function start(engine, model = MODEL) {
  return finish(engine, engine.startRun({ workflow: graph(model), input: 'Do the original fixture task.' }));
}

test('Vibe continuation preserves its durable thread and exact model despite global Codex isolation and a changed default', async t => {
  const { engine, runtime } = await harness(t), first = await start(engine);
  runtime.defaultModel = OTHER_MODEL;
  const continued = await finish(engine, engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue this fixture.' }));
  assert.equal(continued.status, 'completed', continued.error);
  assert.equal(runtime.calls[1].model, MODEL);
  assert.equal(runtime.calls[1].threadId, first.nodes.agent.threadId);
  assert.equal(continued.nodes.agent.threadId, first.nodes.agent.threadId);
  assert.equal(continued.modelHandoff, undefined);
  assert.match(runtime.calls[1].prompt, /USER FOLLOW-UP/);
  assert.equal(runtime.calls.length, 2);
});

test('Vibe load rebinds the current dynamic tool catalog instead of retaining a saved Codex schema filter', async t => {
  const { engine, runtime } = await harness(t), first = await start(engine);
  const state = engine.runs.get(first.id).nodes.agent;
  state.toolNames = []; state.taskSchemaVersion = 1; state.controlSchemaVersion = 1;
  const continued = await finish(engine, engine.continueRun(first.id, { nodeId: 'agent', message: 'Use current tools.' }));
  assert.equal(continued.status, 'completed', continued.error);
  assert.equal(runtime.calls[1].threadId, first.nodes.agent.threadId);
  assert.ok(runtime.calls[1].dynamicTools.some(tool => tool.name === 'relay_workspace'));
  assert.deepEqual(runtime.calls[1].dynamicTools, runtime.calls[0].dynamicTools);
  assert.equal(continued.nodes.agent.capabilitiesNote, undefined);
});

test('explicit retry retains an interrupted Vibe thread and refuses uncertain recovery without a fresh automatic replay', async t => {
  const { engine, runtime } = await harness(t);
  runtime.failure = Object.assign(new Error('The process exited after accepting the turn.'), { code: 'VIBE_PROCESS_EXIT' });
  const first = await start(engine);
  assert.equal(first.status, 'failed');
  assert.match(first.nodes.agent.threadId, /^vibe_/);
  runtime.rejectResume = true;
  const retry = await finish(engine, engine.retryRun(first.id));
  assert.equal(retry.status, 'failed');
  assert.equal(retry.nodes.agent.errorCode, 'VIBE_TURN_UNCERTAIN');
  assert.equal(runtime.calls.length, 2, 'No third fresh-thread recovery is admitted.');
  assert.equal(runtime.calls[1].threadId, first.nodes.agent.threadId);
  assert.equal(runtime.calls[1].model, MODEL);
  assert.match(runtime.calls[1].prompt, /Preserve confirmed tool results/);
  assert.equal(retry.nodeHandoffs, undefined);
});

test('provider switches make explicit continuity handoffs while a Vibe model selection stays in its native session', async t => {
  const { engine, runtime } = await harness(t), first = await start(engine);
  const switched = await finish(engine, engine.continueRun(first.id, { nodeId: 'agent', message: 'Use the Codex fixture.', model: 'fixture-codex' }));
  assert.equal(switched.status, 'completed', switched.error);
  assert.equal(switched.modelHandoff.reason, 'model-change');
  assert.equal(runtime.calls[1].threadId, undefined);
  assert.equal(runtime.calls[1].model, 'fixture-codex');
  const back = await finish(engine, engine.continueRun(switched.id, { nodeId: 'agent', message: 'Use Vibe again.', model: MODEL }));
  assert.equal(back.status, 'completed', back.error);
  assert.equal(back.modelHandoff.reason, 'model-change');
  assert.equal(runtime.calls[2].threadId, undefined);
  assert.equal(runtime.calls[2].model, MODEL);
});

test('Codex continues to restart private history and to retain its saved context handoff', async t => {
  const { engine, runtime } = await harness(t), first = await start(engine, 'fixture-codex');
  const continued = await finish(engine, engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue the private Codex fixture.' }));
  assert.equal(continued.status, 'completed', continued.error);
  assert.equal(runtime.calls[1].threadId, undefined);
  assert.equal(continued.modelHandoff.reason, 'relay-history');
  assert.match(runtime.calls[1].prompt, /Do the original fixture task/);
});

test('Vibe compaction reaches its provider policy and never attempts a Codex private-history migration', async t => {
  const { engine, runtime } = await harness(t), first = await start(engine);
  await assert.rejects(engine.compactRun(first.id, { nodeId: 'agent' }), { code: 'VIBE_COMPACTION_UNSUPPORTED' });
  assert.equal(runtime.compactions.length, 1);
  assert.equal(runtime.compactions[0].threadId, first.nodes.agent.threadId);
  assert.equal(runtime.compactions[0].options.model, MODEL);
  assert.equal(runtime.calls.length, 1);
});

test('an explicit different Vibe model starts a new session with saved context and preserves the old attribution', async t => {
  const { engine, runtime } = await harness(t), first = await start(engine);
  const original = structuredClone(engine.getRun(first.id));
  const switched = await finish(engine, engine.continueRun(first.id, { nodeId: 'agent', message: 'Use the other Vibe model.', model: OTHER_MODEL }));
  assert.equal(switched.status, 'completed', switched.error);
  assert.equal(switched.modelHandoff.reason, 'model-change');
  assert.equal(switched.modelHandoff.from, MODEL);
  assert.equal(switched.modelHandoff.to, OTHER_MODEL);
  assert.equal(runtime.calls[1].threadId, undefined);
  assert.equal(runtime.calls[1].model, OTHER_MODEL);
  assert.match(runtime.calls[1].prompt, /Do the original fixture task/);
  assert.notEqual(switched.nodes.agent.threadId, first.nodes.agent.threadId);
  assert.deepEqual(engine.getRun(first.id), original);
});
