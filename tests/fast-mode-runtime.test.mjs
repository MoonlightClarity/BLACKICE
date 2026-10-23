import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine, validateWorkflow } from '../lib/engine.mjs';
import { RuntimeSettingsStore } from '../lib/runtime-settings.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';
import { createHarnessServer } from '../server.mjs';

const workflow = (model = 'native-fast', serviceTier) => ({ id: 'speed-fixture', name: 'Speed fixture', nodes: [
  { id: 'input', type: 'input' },
  { id: 'agent', type: 'agent', model, prompt: 'Complete the local fixture.', effort: 'max', ...(serviceTier === undefined ? {} : { serviceTier }) },
  { id: 'output', type: 'output' },
], edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }], settings: { maxParallel: 1 } });

class Runtime extends EventEmitter {
  calls = []; failNext = false;
  status() { return { connected: true, authenticated: true, defaultModel: 'native-fast', models: [
    { id: 'native-fast', serviceTiers: [{ id: 'fast' }], supportedReasoningEfforts: [{ reasoningEffort: 'max' }] },
    { id: 'native-standard', serviceTiers: [], additionalSpeedTiers: ['fast'] },
    { id: 'free::model', providerId: 'free', serviceTiers: [{ id: 'fast' }] },
  ] }; }
  async runAgent(options) {
    this.calls.push(options);
    if (this.failNext) { this.failNext = false; throw new Error('Observed fixture interruption.'); }
    const threadId = options.threadId || `fixture-thread-${this.calls.length}`;
    const tier = options.serviceTier === undefined ? {} : { serviceTier: options.serviceTier };
    options.onEvent?.({ type: 'thread', threadId, model: options.model, effort: options.effort, ...tier });
    return { output: 'Observed local fixture result.', threadId, effort: options.effort, ...tier };
  }
  async close() {}
}
const until = async check => { const end = Date.now() + 7000; while (Date.now() < end) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Speed fixture did not settle.'); };
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-speed-')), runtime = new Runtime(), engines = [];
  const settings = await new RuntimeSettingsStore({ dataDir: directory }).init();
  const open = async () => { const engine = await new HarnessEngine({ runtime, dataDir: path.join(directory, 'engine'), defaultCwd: directory }).init(); engine.runtimeSettings = settings; engines.push(engine); return engine; };
  t.after(async () => { for (const engine of engines) await engine.close(); await settings.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, runtime, settings, open, settle: (engine, id) => until(() => { const run = engine.getRun(id); return run?.settled && run; }) };
}

test('Fast admission is deduplicated, capability checked, and independent of Max reasoning', async t => {
  const f = await fixture(t), engine = await f.open();
  const request = { requestId: 'speed-exact-request', workflow: workflow(), input: { task: 'A checked fixture.', serviceTier: 'fast' }, planningMode: 'off' };
  const admitted = engine.startRun(request), first = await f.settle(engine, admitted.id);
  assert.equal(first.status, 'completed'); assert.equal(f.runtime.calls.length, 1);
  assert.equal(f.runtime.calls[0].serviceTier, 'fast'); assert.equal(f.runtime.calls[0].effort, 'max');
  assert.equal(first.workflow.nodes.find(node => node.id === 'agent').serviceTier, 'fast'); assert.equal(first.nodes.agent.serviceTier, 'fast');
  assert.equal(engine.startRun(request).id, first.id); assert.equal(f.runtime.calls.length, 1);
  assert.throws(() => engine.startRun({ ...request, input: { ...request.input, serviceTier: 'default' } }), { code: 'RUN_REQUEST_CONFLICT' });
  for (const model of ['native-standard', 'free::model', 'unadvertised']) assert.throws(() => engine.startRun({ workflow: workflow(model, 'fast'), input: 'Do not silently downgrade.', planningMode: 'off' }), { code: 'FAST_MODE_UNAVAILABLE' });
  for (const tier of [null, true, 'priority', 'auto']) assert.throws(() => validateWorkflow(workflow('native-fast', tier)), { code: 'INVALID_SERVICE_TIER' });
  assert.throws(() => engine.startRun({ workflow: workflow(), serviceTier: 'default', input: { task: 'Conflicting intent.', serviceTier: 'fast' } }), { code: 'INVALID_SERVICE_TIER' });
  assert.equal(f.runtime.calls.length, 1, 'Rejected or duplicate choices dispatch no additional turn.');
});

test('new-chat speed defaults are captured without changing existing chats, and survive restart, continuation and Retry', async t => {
  const f = await fixture(t); let engine = await f.open();
  const start = () => engine.startRun({ workflow: workflow(), input: 'Keep the captured speed.', planningMode: 'off' });
  const original = await f.settle(engine, start().id); assert.equal(f.runtime.calls.at(-1).serviceTier, undefined);
  await f.settings.update({ defaultServiceTier: 'fast' });
  const oldFollowup = await f.settle(engine, engine.continueRun(original.id, { nodeId: 'agent', message: 'Keep the older unspecified choice.' }).id);
  assert.equal(oldFollowup.status, 'completed'); assert.equal(f.runtime.calls.at(-1).serviceTier, undefined);
  const fast = await f.settle(engine, start().id); assert.equal(f.runtime.calls.at(-1).serviceTier, 'fast');
  await f.settings.update({ defaultServiceTier: 'default' });
  await engine.close(); engine = await f.open();
  const restored = engine.getRun(fast.id); assert.equal(restored.workflow.nodes.find(node => node.id === 'agent').serviceTier, 'fast');
  const inherited = await f.settle(engine, engine.continueRun(fast.id, { nodeId: 'agent', message: 'Continue captured Fast after restart.' }).id);
  assert.equal(inherited.status, 'completed'); assert.equal(f.runtime.calls.at(-1).serviceTier, 'fast'); assert.equal(f.runtime.calls.at(-1).effort, 'max');
  const standard = await f.settle(engine, engine.continueRun(inherited.id, { nodeId: 'agent', message: 'Use Standard from now on.', serviceTier: 'default' }).id);
  assert.equal(standard.status, 'completed'); assert.equal(f.runtime.calls.at(-1).serviceTier, 'default'); assert.equal(f.runtime.calls.at(-1).effort, 'max');
  f.runtime.failNext = true;
  const interrupted = await f.settle(engine, engine.startRun({ workflow: workflow('native-fast', 'fast'), input: 'Preserve interrupted Fast.', planningMode: 'off' }).id);
  assert.equal(interrupted.status, 'failed');
  const retried = await f.settle(engine, engine.retryRun(interrupted.id).id); assert.equal(retried.status, 'completed'); assert.equal(f.runtime.calls.at(-1).serviceTier, 'fast');
  const stored = JSON.parse(await readFile(path.join(f.directory, 'engine', 'runs.json'), 'utf8'));
  assert.equal(stored.find(run => run.id === retried.id).workflow.nodes.find(node => node.id === 'agent').serviceTier, 'fast');
});

test('an opted-in new-chat default does not leak into unsupported providers or explicit Standard', async t => {
  const f = await fixture(t), engine = await f.open(); await f.settings.update({ defaultServiceTier: 'fast' });
  for (const graph of [workflow('free::model'), workflow('native-standard'), workflow('native-fast', 'default')]) {
    const run = await f.settle(engine, engine.startRun({ workflow: graph, input: 'Preserve this choice.', planningMode: 'off' }).id);
    assert.equal(run.status, 'completed'); assert.notEqual(f.runtime.calls.at(-1).serviceTier, 'fast');
  }
});

test('direct provider callers cannot leak native Fast into an API request', async () => {
  let providerConfigReads = 0;
  const runtime = { runTimeoutMs: null, idleTimeoutMs: 300000, store: { init: async () => {}, get() { providerConfigReads++; throw new Error('An API request must not start.'); } }, resolveModel: () => ({ available: true, providerId: 'free', model: 'model' }) };
  await assert.rejects(ProviderRuntime.prototype.runAgent.call(runtime, { model: 'free::model', prompt: 'No paid fallback.', serviceTier: 'fast' }), { code: 'FAST_MODE_UNAVAILABLE' });
  assert.equal(providerConfigReads, 0);
});

test('the browser can load the Fast capability helper from the actual server', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-speed-http-'));
  const app = await createHarnessServer({ runtime: new Runtime(), dataDir: path.join(directory, 'data'), defaultCwd: directory, port: 0 });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const url = await app.listen(), response = await fetch(url + '/service-tier-model.mjs');
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /javascript/); assert.match(await response.text(), /export function serviceTierSupport/);
});
