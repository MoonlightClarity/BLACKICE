import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexRuntime } from '../lib/codex.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
import { RuntimeSettingsStore } from '../lib/runtime-settings.mjs';
import { MAX_TIMER_DELAY_MS, normalizeRunTimeout, startRunDeadline } from '../lib/run-timeout.mjs';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/fake-app-server.mjs', import.meta.url));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const until = async predicate => { const end = Date.now() + 5000; while (Date.now() < end) { if (predicate()) return; await delay(5); } assert.fail('The fixture did not become ready.'); };

function clock() {
  let elapsed = 0, nextId = 0; const pending = new Map(), delays = [];
  return {
    pending, delays,
    options: { now: () => elapsed, setTimeoutImpl: (callback, milliseconds) => { delays.push(milliseconds); const id = ++nextId; pending.set(id, { callback, at: elapsed + milliseconds }); return id; }, clearTimeoutImpl: id => pending.delete(id) },
    advance(milliseconds) { const target = elapsed + milliseconds; while (true) { const entry = [...pending].sort((a, b) => a[1].at - b[1].at)[0]; if (!entry || entry[1].at > target) break; elapsed = entry[1].at; pending.delete(entry[0]); entry[1].callback(); } elapsed = target; },
  };
}

test('no agent deadline allocates no timer even after the former thirty-minute cutoff', () => {
  const fake = clock(); let fired = 0; const cancel = startRunDeadline(null, () => fired++, fake.options);
  fake.advance(365 * 86400000); cancel(); assert.equal(fired, 0); assert.equal(fake.pending.size, 0); assert.deepEqual(fake.delays, []);
});

test('long explicit budgets are chunked without overflow and fire exactly once at the chosen deadline', () => {
  const fake = clock(), budget = 30 * 86400000; let fired = 0;
  startRunDeadline(budget, () => fired++, fake.options);
  assert.deepEqual(fake.delays, [MAX_TIMER_DELAY_MS]); fake.advance(MAX_TIMER_DELAY_MS); assert.equal(fired, 0);
  assert.deepEqual(fake.delays, [MAX_TIMER_DELAY_MS, budget - MAX_TIMER_DELAY_MS]);
  fake.advance(budget - MAX_TIMER_DELAY_MS - 1); assert.equal(fired, 0); fake.advance(1); assert.equal(fired, 1);
  fake.advance(budget); assert.equal(fired, 1); assert.equal(fake.pending.size, 0);
});

test('safe integer maximum budgets stay armed until cancellation and invalid values cannot schedule timers', () => {
  const fake = clock(); let fired = 0; const cancel = startRunDeadline(Number.MAX_SAFE_INTEGER, () => fired++, fake.options);
  fake.advance(MAX_TIMER_DELAY_MS * 2); assert.equal(fired, 0); assert.equal(fake.pending.size, 1); cancel(); fake.advance(MAX_TIMER_DELAY_MS * 2); assert.equal(fired, 0); assert.equal(fake.pending.size, 0);
  for (const value of [undefined, 0, -1, 1.1, '100', false, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => normalizeRunTimeout(value), { code: 'INVALID_RUN_TIMEOUT' });
});

test('native explicit unlimited overrides a constructor budget, keeps Stop and leaves parallel work independent', async t => {
  const runtime = new CodexRuntime({ command: process.execPath, args: [fixture], cwd, runTimeoutMs: 30, requestTimeoutMs: 5000 }); t.after(() => runtime.close()); await runtime.start();
  const controller = new AbortController(), ready = deferred();
  const pending = runtime.runAgent({ cwd, prompt: 'WAIT_FOR_CANCEL', timeoutMs: null, signal: controller.signal, onEvent: event => { if (event.type === 'turn' && event.status === 'inProgress') ready.resolve(); } }); pending.catch(() => {});
  await ready.promise; await delay(75); assert.equal(runtime.status().activeTurns, 1);
  const sibling = await runtime.runAgent({ cwd, prompt: 'Independent healthy task.', timeoutMs: null }); assert.match(sibling.output, /Independent healthy task/);
  controller.abort(); await assert.rejects(pending, { code: 'ABORT_ERR' }); assert.equal(runtime.status().activeTurns, 0); assert.equal(runtime.status().connected, true);
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'WAIT_FOR_CANCEL' }), { code: 'CODEX_RUN_TIMEOUT' });
});

test('Stop during held native bootstrap releases one caller before readiness without disrupting a parallel caller', async t => {
  const runtime = new CodexRuntime({ command: process.execPath, args: [fixture, '--hold-initialize'], cwd, requestTimeoutMs: 5000 }); t.after(() => runtime.close());
  const requests = [], request = runtime._request.bind(runtime); runtime._request = (method, params, ...args) => { requests.push({ method, params }); return request(method, params, ...args); };
  const controller = new AbortController();
  const stopped = runtime.runAgent({ cwd, prompt: 'STOPPED_CALLER_MUST_NOT_START', signal: controller.signal }); stopped.catch(() => {});
  const sibling = runtime.runAgent({ cwd, prompt: 'PARALLEL_CALLER_MUST_FINISH' }); sibling.catch(() => {});
  await until(() => requests.some(entry => entry.method === 'initialize')); controller.abort();
  await assert.rejects(stopped, { code: 'ABORT_ERR' });
  assert.ok(runtime.startPromise, 'shared initialization remains pending after the stopped caller returns');
  assert.equal(requests.some(entry => ['thread/start', 'turn/start'].includes(entry.method)), false, 'neither task starts before actual bootstrap readiness');
  await runtime._request('fixture/releaseInitialize', {});
  const result = await sibling; assert.match(result.output, /PARALLEL_CALLER_MUST_FINISH/); assert.equal(runtime.status().connected, true);
  assert.equal(requests.filter(entry => entry.method === 'initialize').length, 1, 'both callers share one native process initialization');
  assert.equal(requests.filter(entry => entry.method === 'thread/start').length, 1);
  const turns = requests.filter(entry => entry.method === 'turn/start'); assert.equal(turns.length, 1); assert.doesNotMatch(JSON.stringify(turns), /STOPPED_CALLER_MUST_NOT_START/);
});

test('Stop during held thread creation returns before its acknowledgement and cleans the late ephemeral thread', async t => {
  const runtime = new CodexRuntime({ command: process.execPath, args: [fixture, '--hold-first-thread-start'], cwd, requestTimeoutMs: 5000 }); t.after(() => runtime.close()); await runtime.start();
  const requests = [], request = runtime._request.bind(runtime); runtime._request = (method, params, ...args) => { requests.push({ method, params }); return request(method, params, ...args); };
  const controller = new AbortController();
  const stopped = runtime.runAgent({ cwd, prompt: 'STOPPED_OPEN_MUST_NOT_START', signal: controller.signal, codexHistory: 'relay' }); stopped.catch(() => {});
  await until(() => requests.some(entry => entry.method === 'thread/start'));
  const heldState = await runtime._request('fixture/threadState', {}), lateThreadId = heldState.threads[0].threadId;
  assert.equal(heldState.threads[0].ephemeral, true); assert.equal(heldState.threads[0].turnCount, 0);
  controller.abort(); await assert.rejects(stopped, { code: 'ABORT_ERR' });
  assert.ok([...runtime.pending.values()].length, 'the native thread opening RPC remains tracked until its response');
  const sibling = await runtime.runAgent({ cwd, prompt: 'SIBLING_DURING_HELD_OPEN' }); assert.match(sibling.output, /SIBLING_DURING_HELD_OPEN/);
  assert.equal(requests.some(entry => entry.method === 'turn/start' && entry.params.threadId === lateThreadId), false);
  const released = await runtime._request('fixture/releaseThreadOpen', {}); assert.equal(released.threadId, lateThreadId);
  await until(() => requests.some(entry => entry.method === 'thread/unsubscribe' && entry.params.threadId === lateThreadId));
  const state = await runtime._request('fixture/threadState', {});
  assert.equal(state.threads.some(entry => entry.threadId === lateThreadId), false, 'late ephemeral creation is actually discarded by the native fixture');
  assert.ok(state.threads.some(entry => entry.threadId === sibling.threadId));
  assert.doesNotMatch(JSON.stringify(requests.filter(entry => entry.method === 'turn/start')), /STOPPED_OPEN_MUST_NOT_START/);
  assert.equal(runtime.status().connected, true); assert.equal(runtime.status().activeTurns, 0);
});

test('Stop during held native resume keeps its opening lease until the RPC settles and never submits the stopped follow-up', async t => {
  const runtime = new CodexRuntime({ command: process.execPath, args: [fixture, '--hold-first-thread-resume'], cwd, requestTimeoutMs: 5000 }); t.after(() => runtime.close());
  const initial = await runtime.runAgent({ cwd, prompt: 'PERSISTENT_ORIGINAL_TASK' });
  const requests = [], request = runtime._request.bind(runtime); runtime._request = (method, params, ...args) => { requests.push({ method, params }); return request(method, params, ...args); };
  const controller = new AbortController();
  const stopped = runtime.runAgent({ cwd, prompt: 'STOPPED_RESUME_MUST_NOT_START', threadId: initial.threadId, signal: controller.signal }); stopped.catch(() => {});
  await until(() => requests.some(entry => entry.method === 'thread/resume'));
  await runtime._request('fixture/threadState', {}); controller.abort(); await assert.rejects(stopped, { code: 'ABORT_ERR' });
  assert.equal(runtime.openingThreads.has(initial.threadId), true);
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'OVERLAPPING_RESUME_MUST_NOT_START', threadId: initial.threadId }), { code: 'THREAD_BUSY' });
  const sibling = await runtime.runAgent({ cwd, prompt: 'SIBLING_DURING_HELD_RESUME' }); assert.match(sibling.output, /SIBLING_DURING_HELD_RESUME/);
  assert.equal(runtime.openingThreads.has(initial.threadId), true, 'independent chats do not release the held resume lease');
  const released = await runtime._request('fixture/releaseThreadOpen', {}); assert.equal(released.threadId, initial.threadId);
  await until(() => !runtime.openingThreads.has(initial.threadId));
  await until(() => requests.some(entry => entry.method === 'thread/unsubscribe' && entry.params.threadId === initial.threadId));
  const beforeRetry = await runtime._request('fixture/threadState', {}); assert.equal(beforeRetry.threads.find(entry => entry.threadId === initial.threadId).turnCount, 1, 'only the original task has run');
  const continued = await runtime.runAgent({ cwd, prompt: 'READ_PRIOR', threadId: initial.threadId }); assert.match(continued.output, /PERSISTENT_ORIGINAL_TASK/);
  const turns = requests.filter(entry => entry.method === 'turn/start'); assert.equal(turns.length, 2); assert.doesNotMatch(JSON.stringify(turns), /STOPPED_RESUME_MUST_NOT_START|OVERLAPPING_RESUME_MUST_NOT_START/);
  assert.equal(runtime.status().connected, true); assert.equal(runtime.status().activeTurns, 0);
});

class NativeFixture extends EventEmitter {
  constructor() { super(); this.calls = []; }
  status() { return { connected: true, authenticated: true, defaultModel: 'native-model', models: [{ id: 'native-model', model: 'native-model' }] }; }
  async start() { return this.status(); }
  async close() {}
  async runAgent(options) { this.calls.push(options); return { output: 'Native receipt.', threadId: 'native-receipt' }; }
}

test('provider runtime applies a configured agent budget to native models and keeps explicit unlimited', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'relay-budget-provider-')), codex = new NativeFixture();
  const runtime = await new ProviderRuntime({ codex, dataDir, runTimeoutMs: 75000 }).init();
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  await runtime.runAgent({ cwd, prompt: 'Configured budget.', model: 'native-model' });
  await runtime.runAgent({ cwd, prompt: 'No budget.', model: 'native-model', timeoutMs: null });
  assert.deepEqual(codex.calls.map(call => call.timeoutMs), [75000, null]);
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Invalid budget.', model: 'native-model', timeoutMs: 0 }), { code: 'INVALID_RUN_TIMEOUT' }); assert.equal(codex.calls.length, 2);
  assert.equal(new CodexRuntime().runTimeoutMs, null);
  const defaults = new ProviderRuntime({ codex, dataDir }); assert.equal(defaults.runTimeoutMs, null); assert.equal(defaults.idleTimeoutMs, 300000); await defaults.close();
});

test('API explicit unlimited and long deadlines survive a shorter constructor budget, while omitted budgets stop stalled work', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'relay-budget-api-')), codex = new NativeFixture(); let calls = 0;
  const runtime = await new ProviderRuntime({ codex, dataDir, runTimeoutMs: 20, fetchImpl: async (url, options) => {
    calls++; await delay(55); if (options.signal.aborted) throw options.signal.reason;
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'API budget verified.' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
  } }).init();
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  await runtime.saveProvider({ id: 'api', name: 'Budget API', type: 'compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-api-key', models: ['model'] });
  for (const timeoutMs of [null, 30 * 86400000]) {
    const result = await runtime.runAgent({ cwd, prompt: 'Complete on the chosen API.', model: 'api::model', timeoutMs }); assert.equal(result.output, 'API budget verified.');
  }
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Use the bounded constructor choice.', model: 'api::model' }), { code: 'PROVIDER_TIMEOUT' });
  assert.ok(calls >= 2 && calls <= 3, 'the budget may expire during history persistence, but generation is never retried');
});

test('unlimited API Stop signals immediately and retains the tool lease until its callback settles', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'relay-budget-tool-')), codex = new NativeFixture(), started = deferred(), release = deferred(), controller = new AbortController(), events = [];
  let requests = 0, settled = false;
  const runtime = await new ProviderRuntime({ codex, dataDir, fetchImpl: async () => {
    requests++;
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'fixture_tool', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }), { headers: { 'content-type': 'application/json' } });
  } }).init();
  t.after(async () => { controller.abort(); release.resolve(); await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  await runtime.saveProvider({ id: 'api', name: 'Budget API', type: 'compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-api-key', models: ['model'] });
  const pending = runtime.runAgent({ cwd, prompt: 'Observe the fixture.', model: 'api::model', timeoutMs: null, providerIdleTimeoutMs: null, signal: controller.signal, dynamicTools: [{ type: 'function', name: 'fixture_tool', inputSchema: { type: 'object', properties: {} } }], onEvent: event => events.push(event), onToolCall: async (call, context) => { started.resolve(context.signal); await release.promise; throw context.signal.reason; } });
  pending.then(() => { settled = true; }, () => { settled = true; });
  const signal = await Promise.race([started.promise, pending.then(() => assert.fail('The fixture turn finished without admitting its tool.'))]);
  controller.abort(); assert.equal(signal.aborted, true, 'Stop signals the callback without relying on a run or idle deadline.');
  await delay(40); assert.equal(settled, false); assert.equal(runtime.active.size, 1); assert.equal(requests, 1);
  const threadId = events.find(event => event.type === 'thread').threadId;
  await assert.rejects(runtime.runAgent({ cwd, prompt: 'Do not overlap the unsettled callback.', model: 'api::model', threadId }), { code: 'THREAD_BUSY' });
  release.resolve(); await assert.rejects(pending, { code: 'ABORT_ERR' });
  assert.equal(runtime.active.size, 0); assert.equal(requests, 1); assert.equal(events.some(event => event.type === 'turn' && event.status === 'completed'), false);
  const receipt = events.find(event => event.type === 'tool.result' && event.callId === 'tool-1');
  assert.equal(receipt.success, false); assert.equal(receipt.code, 'ABORT_ERR'); assert.equal(receipt.duringSettlement, true);
  const record = await runtime.readThread(threadId);
  assert.equal(record.messages.filter(message => message.tool_call_id === 'tool-1').length, 1); assert.equal(record.pendingToolCalls, undefined);
});

const flow = { id: 'execution-budget', name: 'Execution budget', nodes: [{ id: 'input', type: 'input' }, { id: 'agent', type: 'agent', prompt: 'Return the verified result.', model: 'native-model' }, { id: 'output', type: 'output' }], edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }], settings: { maxParallel: 1, planningMode: 'off' } };

test('admitted run budgets stay immutable while future continuations and retries use the current choices', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-budget-engine-')), dataDir = path.join(directory, 'data'), workspace = path.join(directory, 'workspace'); await mkdir(workspace);
  const settings = await new RuntimeSettingsStore({ dataDir }).init(), gate = deferred(), calls = []; let shouldFail = false;
  const runtime = new NativeFixture(); runtime.runAgent = async options => { calls.push(options); if (calls.length === 1) await gate.promise; if (shouldFail) { shouldFail = false; throw Object.assign(new Error('Interrupted fixture.'), { code: 'FIXTURE_INTERRUPTED' }); } return { output: 'Budget fixture complete.', threadId: 'budget-native-thread', codexHistory: 'codex' }; };
  const engine = await new HarnessEngine({ runtime, dataDir, defaultCwd: workspace }).init(); engine.runtimeSettings = settings;
  t.after(async () => { gate.resolve(); await engine.close(); await settings.close(); await rm(directory, { recursive: true, force: true }); });
  await settings.update({ codexHistory: 'codex', runTimeoutMs: 10000, providerIdleTimeoutMs: 2000, defaultEffort:'default', defaultContext:{preset:'model',windowTokens:null,autoCompact:true} });
  const first = engine.startRun({ workflow: flow, input: 'First admitted task.' }); await until(() => calls.length === 1);
  await settings.update({ runTimeoutMs: null, providerIdleTimeoutMs: null }); assert.equal(calls[0].timeoutMs, 10000); assert.equal(calls[0].providerIdleTimeoutMs, 2000); assert.equal(calls[0].signal.aborted, false);
  gate.resolve(); await engine.executions.get(first.id); assert.deepEqual(engine.getRun(first.id).runtimeSettings, { codexHistory: 'codex', runTimeoutMs: 10000, providerIdleTimeoutMs: 2000, defaultEffort:'default', defaultServiceTier:'default', defaultContext:{preset:'model',windowTokens:null,autoCompact:true}, verbosity:'balanced',subagentsEnabled:false,maxSubagents:3 });
  const next = engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue the verified result.' }); await engine.executions.get(next.id);
  assert.equal(calls[1].timeoutMs, null); assert.equal(calls[1].providerIdleTimeoutMs, null);
  shouldFail = true; const failed = engine.startRun({ workflow: flow, input: 'A recoverable task.' }); await engine.executions.get(failed.id); assert.equal(engine.getRun(failed.id).status, 'failed');
  await settings.update({ runTimeoutMs: 60000, providerIdleTimeoutMs: 5000 });
  const retried = engine.retryRun(failed.id); await engine.executions.get(retried.id); assert.equal(engine.getRun(retried.id).status, 'completed'); assert.equal(calls.at(-1).timeoutMs, 60000); assert.equal(calls.at(-1).providerIdleTimeoutMs, 5000);
});
