import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeContextOptions, contextSnapshot, nativeContextSnapshot } from '../lib/context.mjs';
import { CodexRuntime } from '../lib/codex.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';
import { CONTROL_TOOL, CONTROL_SCHEMA_VERSION, PRE_PERSISTENT_HISTORY_CONTROL_TOOL, PRE_PERSISTENT_HISTORY_CONTROL_INSTRUCTIONS, PRE_CONTEXT_CONTROL_TOOL, PRE_CONTEXT_CONTROL_INSTRUCTIONS, PRE_PROFILE_CONTROL_TOOL, PRE_ACCURACY_CONTROL_TOOL, createControlToolHandler } from '../lib/control-tools.mjs';
import { RuntimeSettingsStore } from '../lib/runtime-settings.mjs';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const model = Object.freeze({ id: 'fixture', model: 'fixture', contextWindowTokens: 272000, runtimeDefaultContextWindowTokens: 272000, maxContextWindowTokens: 872000, effectiveContextWindowPercent: 95, contextWindowSource: 'runtime-reported', defaultReasoningEffort: 'high' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('extended stays dynamic while legacy 900k and API capacity rules remain compatible', () => {
  assert.deepEqual(normalizeContextOptions({ preset: 'extended', windowTokens: 872000 }), { preset: 'extended', windowTokens: null, autoCompact: true });
  assert.equal(normalizeContextOptions({ preset: '900k', windowTokens: 872000 }).windowTokens, 900000);
  const api = contextSnapshot({ options: { preset: 'extended' }, modelWindowTokens: 131072, modelWindowSource: 'provider-reported' });
  assert.equal(api.requestedWindowTokens, 131072); assert.equal(api.effectiveWindowTokens, 131072);
  assert.equal(contextSnapshot({ options: { preset: '900k' }, modelWindowTokens: 1000000, modelWindowSource: 'provider-reported' }).effectiveWindowTokens, 900000);
  assert.throws(() => contextSnapshot({ options: { preset: 'extended' } }), { code: 'INVALID_CONTEXT' });
});

test('current control tools advertise and persist Extended through runtime_set/get while historical schemas stay unchanged', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-extended-controls-'));
  const settings = await new RuntimeSettingsStore({ dataDir: directory }).init();
  t.after(async () => { await settings.close(); await rm(directory, { recursive: true, force: true }); });
  const engine = { runtimeSettings: settings }, handler = createControlToolHandler({ engine, run: { id: 'fixture', cwd }, nodeId: 'agent' });
  const invoke = async args => { const result = await handler({ name: 'relay_control', arguments: args }); return { success: result.success, value: JSON.parse(result.contentItems[0].text) }; };
  const described = await invoke({ action: 'describe' });
  assert.equal(described.success, true);
  assert.ok(described.value.tool.inputSchema.properties.runtime.properties.defaultContext.properties.preset.enum.includes('extended'));
  for (const historical of [PRE_PROFILE_CONTROL_TOOL, PRE_ACCURACY_CONTROL_TOOL, PRE_CONTEXT_CONTROL_TOOL]) assert.deepEqual(historical.inputSchema.properties.runtime.properties.defaultContext.properties.preset.enum, ['model', '900k', 'custom']);
  assert.equal(CONTROL_SCHEMA_VERSION, 9);
  assert.equal(createHash('sha256').update(JSON.stringify(PRE_CONTEXT_CONTROL_TOOL)).digest('hex'), 'b66363382582754f1de21b9390adc92e5ab4639fba8ee6c620c8e967fe4d11a8');
  assert.equal(createHash('sha256').update(PRE_CONTEXT_CONTROL_INSTRUCTIONS).digest('hex'), 'bb2474986bc93c57f706685adcb2a8cda43e4d003761abff1c3b5f3e645f6a9c');
  assert.notEqual(CONTROL_TOOL.inputSchema.properties.runtime.properties.defaultContext, PRE_ACCURACY_CONTROL_TOOL.inputSchema.properties.runtime.properties.defaultContext);
  const saved = await invoke({ action: 'runtime_set', runtime: { defaultContext: { preset: 'extended', autoCompact: true } } });
  assert.equal(saved.success, true); assert.deepEqual(saved.value.defaultContext, { preset: 'extended', windowTokens: null, autoCompact: true });
  assert.deepEqual((await invoke({ action: 'runtime_get' })).value.defaultContext, saved.value.defaultContext);
  const restored = await new RuntimeSettingsStore({ dataDir: directory }).init();
  assert.deepEqual(restored.get().defaultContext, saved.value.defaultContext); await restored.close();
  const legacy = await invoke({ action: 'runtime_set', runtime: { defaultContext: { preset: '900k' } } });
  assert.equal(legacy.success, true); assert.equal(legacy.value.defaultContext.windowTokens, 900000);
  const invalid = await invoke({ action: 'runtime_set', runtime: { defaultContext: { preset: 'invented' } } });
  assert.equal(invalid.success, false); assert.equal(settings.get().defaultContext.preset, '900k');
});

for(const savedVersion of [7,8])test('a new engine turn gets schema9 while a saved schema'+savedVersion+' native continuation keeps its exact old tool', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-context-schema-')), calls = [], runtime = new EventEmitter();
  runtime.status = () => ({ connected: true, authenticated: true, defaultModel: 'fixture', models: [model] });
  runtime.runAgent = async options => { calls.push(options); const threadId = options.threadId || 'schema-fixture-thread'; options.onEvent({ type: 'thread', threadId, model: 'fixture', effort: 'high', codexHistory: 'codex' }); return { output: 'Local schema fixture.', threadId, codexHistory: 'codex' }; };
  const engine = await new HarnessEngine({ runtime, dataDir: directory, defaultCwd: cwd }).init();
  engine.runtimeSettings = { get: () => ({ codexHistory: 'codex' }) };
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  const workflow = { id: 'schema-context', name: 'Schema fixture', nodes: [{ id: 'input', type: 'input' }, { id: 'agent', type: 'agent', name: 'Fixture', model: 'fixture', prompt: 'Local protocol fixture.', effort: 'high' }, { id: 'output', type: 'output' }], edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }], settings: { maxParallel: 1, planningMode: 'off' } };
  const first = engine.startRun({ workflow, input: 'Inspect fixture schema.' }); await engine.executions.get(first.id);
  assert.equal(engine.getRun(first.id).status, 'completed');
  assert.equal(engine.getRun(first.id).nodes.agent.controlSchemaVersion, CONTROL_SCHEMA_VERSION);
  assert.ok(calls[0].dynamicTools.find(tool => tool.name === 'relay_control').inputSchema.properties.runtime.properties.defaultContext.properties.preset.enum.includes('extended'));
  engine.runs.get(first.id).nodes.agent.controlSchemaVersion = savedVersion;
  const follow = engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue the recorded schema'+savedVersion+' fixture.' }); await engine.executions.get(follow.id);
  assert.equal(engine.getRun(follow.id).status, 'completed'); assert.equal(engine.getRun(follow.id).nodes.agent.controlSchemaVersion, savedVersion);
  assert.equal(calls[1].threadId, 'schema-fixture-thread');
  assert.deepEqual(calls[1].dynamicTools.find(tool => tool.name === 'relay_control'), savedVersion===8?PRE_PERSISTENT_HISTORY_CONTROL_TOOL:PRE_CONTEXT_CONTROL_TOOL);
  assert.ok(calls[1].prompt.includes(savedVersion===8?PRE_PERSISTENT_HISTORY_CONTROL_INSTRUCTIONS:PRE_CONTEXT_CONTROL_INSTRUCTIONS));
});

test('native raw default, supported maximum and expected usable window stay separate', () => {
  const cases = [
    [{ preset: 'model' }, null, 272000, 258400],
    [{ preset: 'extended' }, 872000, 872000, 828400],
    [{ preset: 'custom', windowTokens: 800000 }, 800000, 800000, 760000],
    [{ preset: '900k' }, 900000, 872000, 828400],
  ];
  for (const [options, requested, configured, usable] of cases) {
    const value = nativeContextSnapshot({ model, options });
    assert.equal(value.requestedWindowTokens, requested);
    assert.equal(value.nativeConfiguredWindowTokens, configured);
    assert.equal(value.effectiveWindowTokens, usable);
    assert.equal(value.nativeDefaultContextWindowTokens, 272000);
    assert.equal(value.nativeMaxContextWindowTokens, 872000);
    assert.equal(value.nativeWindowBasis, 'metadata-percent');
    assert.equal(value.nativeObservedWindowTokens, null);
    assert.ok(value.compactAtTokens < value.inputBudgetTokens);
  }
  const reported = nativeContextSnapshot({ model, options: { preset: 'extended' }, observedWindowTokens: 800000 });
  assert.equal(reported.nativeConfiguredWindowTokens, 872000);
  assert.equal(reported.effectiveWindowTokens, 800000, 'an already effective observation is not multiplied by 95% again');
  assert.equal(reported.nativeObservedWindowTokens, 800000);
  assert.equal(reported.nativeWindowBasis, 'runtime-usage');
  assert.match(nativeContextSnapshot({ model, options: { preset: '900k' } }).warnings.join(' '), /872,000.*supported maximum/);
  const switched = nativeContextSnapshot({ model: { ...model, id: 'another', contextWindowTokens: 128000, runtimeDefaultContextWindowTokens: 128000, maxContextWindowTokens: 500000 }, options: { preset: 'extended' } });
  assert.equal(switched.nativeConfiguredWindowTokens, 500000); assert.equal(switched.effectiveWindowTokens, 475000);
});

test('an effective catalog observation cannot replace the raw default, while an explicit config override remains authoritative', () => {
  const observedCatalog = { ...model, contextWindowTokens: 828400 };
  const reset = nativeContextSnapshot({ model: observedCatalog, options: { preset: 'model' } });
  assert.equal(reset.nativeConfiguredWindowTokens, 272000); assert.equal(reset.effectiveWindowTokens, 258400);
  const configured = nativeContextSnapshot({ model: { ...observedCatalog, contextWindowTokens: 128000, contextWindowSource: 'user-configured' } });
  assert.equal(configured.nativeConfiguredWindowTokens, 128000); assert.equal(configured.effectiveWindowTokens, 121600);
  assert.equal(configured.nativeDefaultContextWindowTokens, 272000); assert.equal(configured.windowSource, 'user-configured');
});

test('missing native maximum is explicit, and unknown capacity never becomes a claimed extended maximum', () => {
  const fallback = nativeContextSnapshot({ model: { ...model, maxContextWindowTokens: undefined }, options: { preset: 'extended' } });
  assert.equal(fallback.nativeConfiguredWindowTokens, 272000); assert.equal(fallback.nativeMaxContextWindowTokens, null);
  assert.match(fallback.warnings.join(' '), /not reported an extended maximum/);
  assert.throws(() => nativeContextSnapshot({ options: { preset: 'extended' } }), { code: 'INVALID_CONTEXT' });
  const custom = nativeContextSnapshot({ options: { preset: 'custom', windowTokens: 500000 } });
  assert.equal(custom.modelWindowTokens, null); assert.equal(custom.windowSource, 'user-configured');
});

function handoffEngine(entry = model) {
  return Object.assign(Object.create(HarnessEngine.prototype), { runtime: { status: () => ({ models: [entry] }) } });
}
function priorRun(options, context) {
  const node = { id: 'agent', type: 'agent', model: 'fixture', effort: 'high', context: options };
  return { workflow: { nodes: [node], settings: {} }, nodes: { agent: { resolvedModel: 'fixture', resolvedEffort: 'high', contextStatus: { ...context, nativeCompaction: true } } } };
}

test('handoff observations require actual native usage and the same model, preset, raw window and effort', () => {
  const engine = handoffEngine(), options = { preset: 'extended' }, node = { id: 'agent', type: 'agent', model: 'fixture', effort: 'high', context: options }, graph = { settings: {} };
  const actual = nativeContextSnapshot({ model, options, observedWindowTokens: 800000 }), previous = priorRun(options, actual);
  const confirmed = engine.confirmedHandoffWindow([previous], node, graph);
  assert.equal(confirmed.reportedModelWindowTokens, 800000); assert.equal(confirmed.reportedModelWindowSource, 'runtime-reported');
  assert.equal(engine.handoffLimits(node, graph, [], [], confirmed).effectiveWindowTokens, 800000);
  for (const [changed, expected] of [
    [{ ...node, context: { preset: 'model' } }, 258400],
    [{ ...node, context: { preset: 'custom', windowTokens: 800000 } }, 760000],
    [{ ...node, effort: 'low' }, 828400],
  ]) {
    const ignored = engine.confirmedHandoffWindow([previous], changed, graph);
    assert.deepEqual(ignored, {}); assert.equal(engine.handoffLimits(changed, graph, [], [], ignored).effectiveWindowTokens, expected);
  }
  const defaultPrevious = priorRun({ preset: 'model' }, nativeContextSnapshot({ model, observedWindowTokens: 258400 }));
  assert.deepEqual(engine.confirmedHandoffWindow([defaultPrevious], node, graph), {}, 'Model default and Extended both normalize windowTokens:null but are different requests');
  assert.deepEqual(engine.confirmedHandoffWindow([previous], { ...node, model: 'another' }, graph), {});
  assert.deepEqual(handoffEngine({ ...model, maxContextWindowTokens: 1000000 }).confirmedHandoffWindow([previous], node, graph), {}, 'a changed supported raw maximum invalidates an Extended observation');
  const estimate = priorRun(options, nativeContextSnapshot({ model, options }));
  assert.deepEqual(engine.confirmedHandoffWindow([estimate], node, graph), {}, 'a metadata estimate must not be relabeled as runtime usage');
  const legacyAmbiguous = priorRun(options, { modelWindowTokens: 828400, windowSource: 'runtime-reported' });
  assert.deepEqual(engine.confirmedHandoffWindow([legacyAmbiguous], node, graph), {});
  const legacyReported = priorRun(options, { modelWindowTokens: 828400, windowSource: 'provider-reported' });
  assert.equal(engine.confirmedHandoffWindow([legacyReported], node, graph).reportedModelWindowTokens, 828400);
});

function nativeRuntime(t) {
  const fixture = fileURLToPath(new URL('./fixtures/context-app-server.mjs', import.meta.url));
  const metadata = { enabled: true, resolve: async rows => ({ models: rows.map(row => ({ ...row, ...model })), candidates: [] }) };
  const runtime = new CodexRuntime({ command: process.execPath, args: [fixture], cwd, nativeModelMetadata: metadata, requestTimeoutMs: 3000, runTimeoutMs: 5000 });
  const requests = [], rawWindows = new Map(), request = runtime._request.bind(runtime), notification = runtime._notification.bind(runtime);
  runtime._request = async (method, params = {}, ...args) => {
    requests.push({ method, params: structuredClone(params) });
    const result = await request(method, params, ...args);
    if (method === 'thread/start' || method === 'thread/resume') {
      const id = result.thread.id, setting = params.config?.model_context_window;
      rawWindows.set(id, setting === null ? 272000 : setting || rawWindows.get(id) || 272000);
    }
    return result;
  };
  // The protocol fixture's fixed usage window is replaced with its advertised
  // configuration behavior. This remains a local child process, not inference.
  runtime._notification = (method, params) => notification(method, method === 'thread/tokenUsage/updated' ? { ...params, tokenUsage: { ...params.tokenUsage, modelContextWindow: Math.floor(rawWindows.get(params.threadId) * .95) } } : params);
  t.after(() => runtime.close());
  return { runtime, requests };
}

test('native start/resume sends raw Extended/custom limits, and resetting defaults never sends an old effective window', async t => {
  const { runtime, requests } = nativeRuntime(t), events = [];
  const first = await runtime.runAgent({ cwd, prompt: 'Local protocol fixture.', context: { preset: 'extended' }, onEvent: event => events.push(event) });
  const started = requests.find(entry => entry.method === 'thread/start').params.config;
  assert.equal(started.model_context_window, 872000);
  assert.equal(events.find(event => event.type === 'context').context.effectiveWindowTokens, 828400);
  assert.equal(first.context.nativeObservedWindowTokens, 828400); assert.equal(first.context.effectiveWindowTokens, 828400);
  assert.equal(first.context.nativeConfiguredWindowTokens, 872000);
  const custom = await runtime.runAgent({ cwd, prompt: 'Change fixture window.', threadId: first.threadId, context: { preset: 'custom', windowTokens: 800000 } });
  assert.equal(requests.filter(entry => entry.method === 'thread/resume').at(-1).params.config.model_context_window, 800000);
  assert.equal(custom.context.effectiveWindowTokens, 760000);
  const reset = await runtime.runAgent({ cwd, prompt: 'Restore fixture default.', threadId: first.threadId, context: { preset: 'model' } });
  const resumed = requests.filter(entry => entry.method === 'thread/resume').at(-1).params.config;
  assert.equal(resumed.model_context_window, null); assert.equal(resumed.model_auto_compact_token_limit, null);
  assert.equal(reset.context.nativeConfiguredWindowTokens, 272000); assert.equal(reset.context.effectiveWindowTokens, 258400);
});

test('manual native compression uses the saved exact model after cache loss and waits beyond the RPC acknowledgement', async t => {
  const { runtime, requests } = nativeRuntime(t);
  const first = await runtime.runAgent({ cwd, prompt: 'Create a saved fixture thread.', context: { preset: 'extended' } });
  runtime.contexts.clear(); runtime.info.defaultModel = 'unrelated'; runtime.info.models.push({ ...model, id: 'unrelated', model: 'unrelated', maxContextWindowTokens: 400000 });
  const notification = runtime._notification.bind(runtime), held = [], acknowledged = deferred();
  runtime._notification = (method, params) => { if (params.threadId === first.threadId && /^(turn\/|item\/|thread\/tokenUsage)/.test(method)) held.push([method, params]); else notification(method, params); };
  const request = runtime._request.bind(runtime);
  runtime._request = async (method, params, ...args) => { const result = await request(method, params, ...args); if (method === 'thread/compact/start') acknowledged.resolve(); return result; };
  let settled = false;
  const operation = runtime.compactThread(first.threadId, { model: 'fixture', context: { preset: 'extended' } }).finally(() => { settled = true; });
  await acknowledged.promise;
  const completionDeadline = Date.now() + 3000;
  while (!held.some(([method]) => method === 'turn/completed') && Date.now() < completionDeadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(settled, false, 'the empty ACK is not a completed compaction');
  assert.equal(requests.filter(entry => entry.method === 'thread/resume').at(-1).params.config.model_context_window, 872000);
  assert.ok(held.some(([method]) => method === 'turn/completed'));
  runtime._notification = notification; for (const [method, params] of held) notification(method, params);
  const result = await operation;
  assert.equal(result.compacted, true); assert.equal(result.threadId, first.threadId);
  assert.equal(result.context.nativeConfiguredWindowTokens, 872000); assert.equal(result.context.nativeObservedWindowTokens, 828400);
  assert.equal(result.context.compactionCount, 1); assert.equal(result.context.estimatedInputTokens, null);
});

test('provider facade forwards the historical native model without consulting a new default', async () => {
  let received;
  const runtime = Object.assign(Object.create(ProviderRuntime.prototype), { store: { init: async () => {} }, codex: { compactThread: async (threadId, options) => { received = { threadId, options }; return { compacted: true }; } } });
  await runtime._compactThread('saved-native-thread', { model: 'fixture', context: { preset: 'extended' } });
  assert.equal(received.options.model, 'fixture'); assert.equal(received.options.context.preset, 'extended');
});

test('engine compression locks the saved conversation until completion, error or cancellation and preserves saved choices', async () => {
  const runtime = new EventEmitter(), calls = [], pending = [];
  runtime.status = () => ({ models: [model] });
  runtime.compactThread = (threadId, options) => { const gate = deferred(); calls.push({ threadId, options }); pending.push(gate); options.signal.addEventListener('abort', () => gate.reject(Object.assign(new Error('Cancelled fixture compression.'), { name: 'AbortError', code: 'ABORT_ERR' })), { once: true }); return gate.promise; };
  const engine = new HarnessEngine({ runtime, dataDir: cwd, defaultCwd: cwd });
  engine.schedulePersist = () => {}; engine.persist = async () => {};
  const node = { id: 'agent', type: 'agent', name: 'Fixture', model: 'fixture', prompt: 'Local fixture only.', effort: 'high', context: { preset: 'extended' } };
  const run = { id: 'compact-fixture', taskId: 'shared-task', cwd, status: 'completed', settled: true, events: [], workflow: { id: 'compact-graph', name: 'Fixture', nodes: [{ id: 'input', type: 'input' }, node, { id: 'output', type: 'output' }], edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }], settings: { maxParallel: 1, planningMode: 'off' } }, nodes: { input: { status: 'completed' }, agent: { status: 'completed', threadId: 'saved-native-thread', resolvedModel: 'fixture', codexHistory: 'codex' }, output: { status: 'completed' } } };
  engine.runs.set(run.id, run); const choices = structuredClone(run.workflow);
  const first = engine.compactRun(run.id, { nodeId: 'agent' });
  assert.equal(engine.conversationBusy(run), true);
  assert.throws(() => engine.continueRun(run.id, { nodeId: 'agent', message: 'Concurrent fixture turn.' }), { code: 'CHAT_BUSY' });
  await assert.rejects(engine.compactRun(run.id, { nodeId: 'agent' }), { code: 'CHAT_BUSY' });
  await Promise.resolve(); assert.equal(calls[0].options.model, 'fixture');
  pending[0].resolve({ compacted: true, method: 'codex-native', threadId: 'saved-native-thread' }); await first;
  assert.equal(engine.conversationBusy(run), false); const successful = structuredClone(run.nodes.agent.lastCompaction);
  const failed = engine.compactRun(run.id, { nodeId: 'agent' }); await new Promise(resolve => setImmediate(resolve)); pending[1].reject(new Error('Fixture summary failed.'));
  await assert.rejects(failed, /Fixture summary failed/); assert.equal(engine.conversationBusy(run), false);
  assert.deepEqual(run.nodes.agent.lastCompaction, successful);
  const cancelled = engine.compactRun(run.id, { nodeId: 'agent' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine.cancelRun(run.id).status, 'completed', 'stopping compression preserves the finished run status');
  await assert.rejects(cancelled, { code: 'ABORT_ERR' }); assert.equal(engine.conversationBusy(run), false);
  assert.deepEqual(run.workflow, choices); assert.equal(run.nodes.agent.threadId, 'saved-native-thread');
});
