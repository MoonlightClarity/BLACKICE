import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { ProviderRuntime } from '../lib/providers.mjs';

// These adapters only record delegation. No native process, model or HTTP
// endpoint is available to this fixture.
class NativeCodex extends EventEmitter {
  constructor({ verified = true } = {}) {
    super(); this.verified = verified; this.runs = []; this.preflights = [];
  }
  status() { return { connected: true, authenticated: true, defaultModel: 'native-fixture', models: [{ model: 'native-fixture' }] }; }
  supportsHostOnlyToolDispatch() { return this.verified; }
  async ensureHostOnlyToolDispatch(options) { this.preflights.push(options); this.verified = true; return true; }
  async runAgent(options) { this.runs.push(options); return { output: 'stub Codex result', threadId: options.threadId || 'native-fixture-thread' }; }
  async close() {}
}
class NativeVibe extends EventEmitter {
  constructor() { super(); this.runs = []; this.savedLookups = []; }
  status() { return { installed: true, available: true, authenticated: true, models: [{ id: 'vibe-fixture', available: true }] }; }
  async savedThreadModel(threadId) { this.savedLookups.push(threadId); return 'mistral-vibe::vibe-fixture'; }
  async runAgent(options) { this.runs.push(options); return { output: 'stub Vibe result', threadId: options.threadId || 'vibe_fixture' }; }
  async close() {}
}
async function fixture(t, { verified = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackice-benchmark-native-guard-'));
  const workspace = path.join(root, 'workspace'), directory = path.join(root, 'traces');
  fs.mkdirSync(workspace);
  const codex = new NativeCodex({ verified }), vibe = new NativeVibe(), fetches = [];
  const runtime = await new ProviderRuntime({
    codex, mistralVibe: vibe, dataDir: path.join(root, 'provider'),
    fetchImpl: async (...args) => { fetches.push(args); throw new Error('No HTTP request is permitted in this native guard fixture.'); },
    modelLimitResolver: { enrich: async (_config, models) => models },
  }).init();
  t.after(async () => { await runtime.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const context = {
    schema: 'blackice.minicpm.provider-trace-context.v1', directory, workspace,
    runId: 'guard-run', taskId: 'guard-run', nodeId: 'agent', clientRequestId: 'guard-request',
  };
  return {
    root, workspace, directory, context, runtime, codex, vibe, fetches,
    options: { cwd: workspace, model: 'native-fixture', prompt: 'Synthetic native routing fixture.', hostOnlyTools: true, benchmarkTrace: context },
  };
}
function counters(h) {
  return {
    codexDispatches: h.codex.runs.length, codexPreflights: h.codex.preflights.length,
    vibeDispatches: h.vibe.runs.length, vibeSavedLookups: h.vibe.savedLookups.length,
    httpDispatches: h.fetches.length,
  };
}
async function rejectsBeforeNative(h, options) {
  let cause, result;
  try { result = await h.runtime.runAgent(options); } catch (error) { cause = error; }
  assert.deepEqual(counters(h), {
    codexDispatches: 0, codexPreflights: 0, vibeDispatches: 0, vibeSavedLookups: 0, httpDispatches: 0,
  }, 'A supplied benchmark context must be rejected before unsupported native preflight or delegation.');
  assert.equal(cause?.code, 'BENCHMARK_TRACE_INVALID', 'The benchmark boundary must reject explicitly, not silently delegate or rely on another native error.');
  assert.equal(result, undefined);
  assert.equal(fs.existsSync(h.directory), false, 'A rejected native benchmark must not create trace artifacts.');
}

test('fresh verified Codex benchmark context rejects before native dispatch', async t => {
  const h = await fixture(t);
  await rejectsBeforeNative(h, h.options);
});

test('fresh unverified Codex benchmark context rejects before native preflight', async t => {
  const h = await fixture(t, { verified: false });
  await rejectsBeforeNative(h, h.options);
});

test('fresh native Vibe benchmark context rejects as unsupported before delegation', async t => {
  const h = await fixture(t);
  await rejectsBeforeNative(h, { ...h.options, model: 'mistral-vibe::vibe-fixture' });
});

for (const route of [
  { name: 'Codex', model: 'native-fixture', threadId: 'native-existing-thread' },
  { name: 'Vibe', model: 'mistral-vibe::vibe-fixture', threadId: 'vibe_existing' },
]) {
  for (const hostOnlyTools of [false, true]) {
    test('saved ' + route.name + ' supplied context rejects before lookup or delegation with hostOnlyTools=' + hostOnlyTools, async t => {
      const h = await fixture(t);
      await rejectsBeforeNative(h, { ...h.options, model: route.model, threadId: route.threadId, hostOnlyTools });
    });
  }
}

const invalidInputs = [
  ['null context', h => ({ benchmarkTrace: null })],
  ['wrong schema', h => ({ benchmarkTrace: { ...h.context, schema: 'wrong' } })],
  ['missing host run identity', h => ({ benchmarkTrace: { ...h.context, runId: undefined } })],
  ['evidence inside model workspace', h => ({ benchmarkTrace: { ...h.context, directory: path.join(h.workspace, 'traces') } })],
  ['relative evidence directory', h => ({ benchmarkTrace: { ...h.context, directory: 'traces' } })],
  ['relative bound workspace', h => ({ benchmarkTrace: { ...h.context, workspace: 'workspace' } })],
  ['missing observed client request identity', h => ({ benchmarkTrace: { ...h.context, clientRequestId: undefined } })],
  ['missing cwd', () => ({ cwd: undefined })],
  ['relative cwd', () => ({ cwd: 'workspace' })],
  ['different cwd', h => ({ cwd: path.join(h.root, 'different-workspace') })],
  ['host-only tools disabled', () => ({ hostOnlyTools: false })],
  ['host-only tools absent', () => ({ hostOnlyTools: undefined })],
];
for (const [name, change] of invalidInputs) {
  test('benchmark entry rejects ' + name + ' without native work', async t => {
    const h = await fixture(t);
    await rejectsBeforeNative(h, { ...h.options, ...change(h) });
  });
}

test('supplied context cannot reuse a provider thread before any saved-thread read', async t => {
  const h = await fixture(t);
  await rejectsBeforeNative(h, { ...h.options, threadId: 'provider_nonexistent-fixture' });
});

for (const verified of [true, false]) {
  test('ordinary fresh Codex without benchmark context preserves verified=' + verified + ' native dispatch', async t => {
    const h = await fixture(t, { verified });
    const { benchmarkTrace, ...options } = h.options;
    const result = await h.runtime.runAgent(options);
    assert.equal(result.output, 'stub Codex result');
    assert.deepEqual(counters(h), {
      codexDispatches: 1, codexPreflights: verified ? 0 : 1,
      vibeDispatches: 0, vibeSavedLookups: 0, httpDispatches: 0,
    });
    assert.equal(h.codex.runs[0].model, options.model);
    assert.equal(h.codex.runs[0].hostOnlyTools, true);
    assert.equal(Object.hasOwn(h.codex.runs[0], 'benchmarkTrace'), false);
    assert.equal(fs.existsSync(h.directory), false);
  });
}

test('ordinary saved Codex without benchmark context keeps its native thread', async t => {
  const h = await fixture(t);
  const { benchmarkTrace, ...base } = h.options;
  const options = { ...base, threadId: 'native-existing-thread', hostOnlyTools: false };
  const result = await h.runtime.runAgent(options);
  assert.equal(result.output, 'stub Codex result');
  assert.equal(result.threadId, options.threadId);
  assert.deepEqual(counters(h), { codexDispatches: 1, codexPreflights: 0, vibeDispatches: 0, vibeSavedLookups: 0, httpDispatches: 0 });
  assert.equal(Object.hasOwn(h.codex.runs[0], 'benchmarkTrace'), false);
  assert.equal(fs.existsSync(h.directory), false);
});

for (const saved of [false, true]) {
  test('ordinary ' + (saved ? 'saved' : 'fresh') + ' retired Vibe without benchmark context prevents native dispatch', async t => {
    const h = await fixture(t);
    const { benchmarkTrace, ...base } = h.options;
    const options = {
      ...base, model: 'mistral-vibe::vibe-fixture', hostOnlyTools: false,
      ...(saved ? { threadId: 'vibe_existing' } : {}),
    };
    await assert.rejects(h.runtime.runAgent(options), /retired/);
    assert.deepEqual(counters(h), {codexDispatches:0,codexPreflights:0,vibeDispatches:0,vibeSavedLookups:0,httpDispatches:0});
    assert.equal(fs.existsSync(h.directory), false);
  });
}
