import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { HarnessEngine } from '../lib/engine.mjs';

const DEFAULT_MODEL = 'gpt-6-luna';
const NATIVE_ALIAS = 'fixture-vibe-backup';
const MODEL = 'mistral-vibe::' + NATIVE_ALIAS;
const workflow = {
  id: 'offline-codex-vibe-backup', name: 'Offline Codex backup fixture',
  nodes: [
    { id: 'input', type: 'input' },
    { id: 'agent', type: 'agent', name: 'Backup agent', model: MODEL, effort: 'default', prompt: 'Complete the isolated fixture task.' },
    { id: 'output', type: 'output' },
  ],
  edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }],
  settings: { maxParallel: 1, planningMode: 'off' },
};

class OfflineCodex extends EventEmitter {
  constructor() { super(); this.starts = 0; this.runs = 0; this.startBehavior = null; }
  status() {
    return { connected: false, authenticated: false, isolatedHistory: true,
      defaultModel: DEFAULT_MODEL, models: [{ id: DEFAULT_MODEL, model: DEFAULT_MODEL, displayName: 'Luna' }],
      lastError: 'Fixture Codex is offline.', activeTurns: 0 };
  }
  async start() {
    this.starts++;
    if (this.startBehavior) return this.startBehavior();
    throw Object.assign(new Error('Fixture Codex startup failed.'), { code: 'CODEX_OFFLINE' });
  }
  async runAgent() { this.runs++; throw new Error('An explicit Vibe backup must never call Codex.'); }
  async close() {}
}

class AvailableVibe extends EventEmitter {
  constructor() { super(); this.calls = []; this.saved = new Map(); }
  async init() { return this; }
  status() {
    return { installed: true, connected: true, authenticated: true, available: true, activeTurns: 0,
      models: [{ id: NATIVE_ALIAS, displayName: 'Fixture Vibe backup', available: true, supportsTools: true, contextWindowTokens: 200000, maxOutputTokens: 8192 }] };
  }
  async savedThreadModel(id) { return this.saved.get(id); }
  async runAgent(options) {
    this.calls.push(options);
    const threadId = options.threadId || 'vibe_offline_fixture_' + this.calls.length;
    const turnId = 'vibe_turn_' + this.calls.length;
    const model = 'mistral-vibe::' + options.model;
    this.saved.set(threadId, model);
    options.onEvent?.({ type: 'thread', threadId, turnId, model, providerId: 'mistral-vibe', resumed: Boolean(options.threadId) });
    options.onEvent?.({ type: 'message', threadId, turnId, phase: 'final_answer', text: 'Backup completed.' });
    options.onEvent?.({ type: 'turn', threadId, turnId, status: 'completed' });
    return { output: 'Backup completed.', threadId, turnId, model };
  }
  async close() {}
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-vibe-offline-backup-'));
  const cwd = path.join(directory, 'workspace'), dataDir = path.join(directory, 'data');
  await Promise.all([mkdir(cwd), mkdir(dataDir)]);
  const providerFile = path.join(dataDir, 'providers.json');
  await writeFile(providerFile, JSON.stringify({ version: 1, defaultModel: DEFAULT_MODEL, providers: [] }));
  const codex = new OfflineCodex(), vibe = new AvailableVibe();
  const runtime = await new ProviderRuntime({ codex, mistralVibe: vibe, dataDir,
    fetchImpl: async () => { assert.fail('This isolated native fixture must never make an API request.'); },
    modelLimitResolver: { enrich: async (_config, models) => models },
  }).init();
  const engine = new HarnessEngine({ runtime, dataDir, defaultCwd: cwd });
  engine.runtimeSettings = { get: () => ({ codexHistory: 'relay', runTimeoutMs: null, executionGuardrails: false }) };
  await engine.init();
  const initialProviders = await readFile(providerFile, 'utf8');
  t.after(async () => { await engine.close(); await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  async function unchangedDefault() {
    assert.equal(runtime.store.defaultModel, DEFAULT_MODEL);
    assert.equal(runtime.status().defaultModel, DEFAULT_MODEL);
    assert.equal(runtime.status().defaultModelAvailable, false);
    assert.equal(await readFile(providerFile, 'utf8'), initialProviders);
  }
  return { engine, runtime, codex, vibe, unchangedDefault };
}

async function finish(engine, run) {
  await engine.executions.get(run.id);
  const result = engine.getRun(run.id);
  assert.equal(result.settled, true);
  assert.equal(result.status, 'completed', result.error || result.nodes.agent.error);
  return result;
}
function start(engine) {
  return finish(engine, engine.startRun({ workflow, input: 'Use the explicitly selected backup.' }));
}

test('explicit Vibe completes and resumes through the real engine and provider facade while Codex is offline and Luna remains saved', { timeout: 10000 }, async t => {
  const { engine, runtime, codex, vibe, unchangedDefault } = await fixture(t);
  assert.equal(runtime.status().codex.connected, false);
  assert.equal(runtime.resolveModel('default').available, false);
  assert.equal(runtime.resolveModel(MODEL).available, true);
  const first = await start(engine);
  const resumed = await finish(engine, engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue with the same backup.' }));
  assert.equal(vibe.calls.length, 2);
  assert.ok(vibe.calls.every(call => call.model === NATIVE_ALIAS));
  assert.equal(vibe.calls[1].threadId, first.nodes.agent.threadId);
  assert.equal(resumed.nodes.agent.threadId, first.nodes.agent.threadId);
  assert.equal(first.workflow.nodes.find(node => node.id === 'agent').model, MODEL);
  assert.equal(await runtime.savedThreadModel(first.nodes.agent.threadId), MODEL);
  assert.equal(codex.starts, 0);
  assert.equal(codex.runs, 0);
  await unchangedDefault();
});

test('a failed startup of the saved Luna default does not block an explicit Vibe engine run or rewrite the default', { timeout: 10000 }, async t => {
  const { engine, runtime, codex, vibe, unchangedDefault } = await fixture(t);
  await assert.rejects(runtime.start(), { code: 'CODEX_OFFLINE' });
  await start(engine);
  assert.equal(codex.starts, 1, 'Only the independently requested application startup attempted Codex.');
  assert.equal(codex.runs, 0);
  assert.equal(vibe.calls.length, 1);
  assert.equal(vibe.calls[0].model, NATIVE_ALIAS);
  await unchangedDefault();
});

test('an explicit Vibe engine run does not wait for an unfinished startup of the saved Codex default', { timeout: 10000 }, async t => {
  const { engine, runtime, codex, vibe, unchangedDefault } = await fixture(t);
  let release, markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  codex.startBehavior = () => { markStarted(); return new Promise(resolve => { release = resolve; }); };
  let startupSettled = false;
  const startup = runtime.start().finally(() => { startupSettled = true; });
  await started;
  try {
    await start(engine);
    assert.equal(startupSettled, false, 'Backup completion must not depend on unused Codex startup.');
    assert.equal(codex.starts, 1);
    assert.equal(codex.runs, 0);
    assert.equal(vibe.calls[0].model, NATIVE_ALIAS);
    await unchangedDefault();
  } finally { release(); await startup; }
  await unchangedDefault();
});
