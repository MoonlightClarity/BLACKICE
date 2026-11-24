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

test('Codex continues to restart private history and to retain its saved context handoff', async t => {
  const { engine, runtime } = await harness(t), first = await start(engine, 'fixture-codex');
  const continued = await finish(engine, engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue the private Codex fixture.' }));
  assert.equal(continued.status, 'completed', continued.error);
  assert.equal(runtime.calls[1].threadId, undefined);
  assert.equal(continued.modelHandoff.reason, 'relay-history');
  assert.match(runtime.calls[1].prompt, /Do the original fixture task/);
});
