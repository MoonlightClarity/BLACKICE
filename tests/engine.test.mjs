import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rmdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HarnessEngine, validateWorkflow } from '../lib/engine.mjs';
import { ConversationArchive } from '../lib/conversations.mjs';
import { DesktopController } from '../lib/desktop.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled']);
const waitFor = async (predicate, message, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out: ${message}`);
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const node = (id, type, prompt = '') => ({ id, type, name: id, prompt, x: 40, y: 40 });
const edge = (source, target) => ({ id: `${source}-${target}`, source, target });
const workflow = (overrides = {}) => ({
  id: 'test-flow', name: 'Bounded QA',
  nodes: [node('input', 'input'), node('agent', 'agent', 'AGENT_MARKER'), node('output', 'output')],
  edges: [edge('input', 'agent'), edge('agent', 'output')],
  ...overrides, settings: { maxParallel: 2, planningMode: 'off', ...overrides.settings },
});
class FakeRuntime extends EventEmitter {
  constructor(execute = async () => ({ output: 'agent result', threadId: 'fake-thread' })) {
    super(); this.execute = execute; this.calls = [];
  }
  status() { return { connected: true, authenticated: true, defaultModel: 'test-model' }; }
  async runAgent(options) { this.calls.push(options); return this.execute(options); }
  async close() {}
}
async function harness(t, runtime = new FakeRuntime(), options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-harness-test-'));
  const cwd = path.join(directory, 'workspace');
  const dataDir = path.join(directory, 'data');
  await mkdir(cwd);
  const engine = new HarnessEngine({ runtime, dataDir, defaultCwd: cwd, ...options });
  const engines = [engine];
  await engine.init();
  t.after(async () => {
    for (const instance of engines) await instance.close();
    assert.match(path.basename(directory), /^relay-harness-test-/);
    await rm(directory, { recursive: true, force: true });
  });
  return { engine, runtime, cwd, dataDir, engines };
}
const finish = (engine, id) => waitFor(() => {
  const run = engine.getRun(id);
  return terminal.has(run?.status) && run;
}, 'run reaches a terminal status');
// Frozen 2.5 receipt format, independent of current engine admission helpers.
const legacyDigest = value => {
  const canonical = item => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, canonical(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
};

test('new installs have no application concurrency limit and more than four independent chats run together', async t => {
  const release = deferred(), runtime = new FakeRuntime(() => release.promise), { engine } = await harness(t, runtime);
  try {
    assert.deepEqual(engine.executionSettings(), { maxConcurrentRuns: null });
    const runs = Array.from({ length: 8 }, (_, index) => engine.startRun({ workflow: workflow(), input: `Unlimited concurrent chat ${index}` }));
    await waitFor(() => runtime.calls.length === 8, 'all eight chats enter the runtime before any completes');
    assert.equal(engine.executionStatus().capacity, null); assert.equal(engine.executionStatus().unlimited, true); assert.equal(engine.executionStatus().availableSlots, null); assert.equal(engine.executionStatus().activeCount, 8);
    release.resolve({ output: 'Independent fixture complete.' }); await Promise.all(runs.map(run => engine.executions.get(run.id)));
    assert.ok(runs.every(run => engine.getRun(run.id).status === 'completed'));
  } finally { release.resolve({ output: 'Fixture cleanup.' }); }
});

test('execution settings persist user limits above 32, retain explicit constructor overrides, and can return to unlimited', async t => {
  const { engine, dataDir, cwd, runtime, engines } = await harness(t);
  const events = []; engine.on('event', event => { if (event.type === 'execution.settings') events.push(event); });
  await engine.updateExecutionSettings({ maxConcurrentRuns: 65 });
  assert.deepEqual(engine.executionSettings(), { maxConcurrentRuns: 65 }); assert.equal(engine.executionStatus().availableSlots, 65); assert.equal(engine.executionStatus().unlimited, false);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'execution-settings.json'), 'utf8')), { maxConcurrentRuns: 65 }); assert.equal(events.length, 1); assert.equal(events[0].data.execution.capacity, 65);
  await engine.close();
  const restored = await new HarnessEngine({ runtime, dataDir, defaultCwd: cwd }).init(); engines.push(restored); assert.equal(restored.executionStatus().capacity, 65); await restored.close();
  const controlled = await new HarnessEngine({ runtime, dataDir, defaultCwd: cwd, maxConcurrentRuns: 1 }).init(); engines.push(controlled); assert.equal(controlled.executionStatus().capacity, 1); assert.equal(JSON.parse(await readFile(path.join(dataDir, 'execution-settings.json'), 'utf8')).maxConcurrentRuns, 65);
  await controlled.updateExecutionSettings({ maxConcurrentRuns: Number.MAX_SAFE_INTEGER }); assert.equal(controlled.executionStatus().capacity, Number.MAX_SAFE_INTEGER);
  await controlled.updateExecutionSettings({ maxConcurrentRuns: null }); await controlled.close();
  const unbounded = await new HarnessEngine({ runtime, dataDir, defaultCwd: cwd }).init(); engines.push(unbounded); assert.deepEqual(unbounded.executionSettings(), { maxConcurrentRuns: null }); assert.equal(unbounded.executionStatus().availableSlots, null);
});

test('lowering the limit leaves all current chats running and delays only new starts until capacity is free', async t => {
  const holds = [deferred(), deferred(), deferred(), deferred()], runtime = new FakeRuntime(() => holds[runtime.calls.length - 1].promise), { engine } = await harness(t, runtime);
  try {
    const runs = Array.from({ length: 3 }, (_, index) => engine.startRun({ workflow: workflow(), input: `Held limit-change chat ${index}` })); await waitFor(() => runtime.calls.length === 3, 'three chats start');
    await engine.updateExecutionSettings({ maxConcurrentRuns: 1 }); assert.equal(engine.executionStatus().activeCount, 3); assert.equal(engine.executionStatus().availableSlots, 0); assert.ok(runtime.calls.every(call => !call.signal.aborted));
    assert.throws(() => engine.startRun({ workflow: workflow(), input: 'Wait for capacity.' }), { code: 'RUN_CAPACITY' });
    holds[0].resolve({ output: 'First complete.' }); holds[1].resolve({ output: 'Second complete.' }); await Promise.all(runs.slice(0, 2).map(run => engine.executions.get(run.id)));
    assert.equal(engine.executionStatus().activeCount, 1); assert.equal(engine.executionStatus().availableSlots, 0); assert.throws(() => engine.startRun({ workflow: workflow(), input: 'Still full.' }), { code: 'RUN_CAPACITY' });
    await engine.updateExecutionSettings({ maxConcurrentRuns: null }); const fourth = engine.startRun({ workflow: workflow(), input: 'New chat after removing limit.' }); await waitFor(() => runtime.calls.length === 4, 'unlimited change admits another chat without interrupting the old one');
    assert.ok(runtime.calls.every(call => !call.signal.aborted)); holds[2].resolve({ output: 'Third complete.' }); holds[3].resolve({ output: 'Fourth complete.' }); await Promise.all([engine.executions.get(runs[2].id), engine.executions.get(fourth.id)]);
  } finally { holds.forEach(hold => hold.resolve({ output: 'Fixture cleanup.' })); }
});

test('invalid concurrency settings are rejected without changing the effective or saved limit', async t => {
  const { engine, dataDir } = await harness(t); await engine.updateExecutionSettings({ maxConcurrentRuns: 64 });
  const invalid = [0, -1, 2.5, Infinity, NaN, '8', true, {}, Number.MAX_SAFE_INTEGER + 1];
  for (const maxConcurrentRuns of invalid) { assert.throws(() => new HarnessEngine({ maxConcurrentRuns }), { code: 'EXECUTION_SETTINGS_INVALID' }); await assert.rejects(engine.updateExecutionSettings({ maxConcurrentRuns }), { status: 400, code: 'EXECUTION_SETTINGS_INVALID' }); }
  for (const value of [null, [], {}, { maxConcurrentRuns: null, extra: true }]) await assert.rejects(engine.updateExecutionSettings(value), { status: 400, code: 'EXECUTION_SETTINGS_INVALID' });
  assert.equal(engine.executionStatus().capacity, 64); assert.equal(JSON.parse(await readFile(path.join(dataDir, 'execution-settings.json'), 'utf8')).maxConcurrentRuns, 64);
});

test('a failed execution settings save does not apply or announce a limit and a later successful save clears its error', async t => {
  const { engine, dataDir } = await harness(t, new FakeRuntime(), { maxConcurrentRuns: 2 }), events = [];
  engine.on('event', event => { if (event.type === 'execution.settings') events.push(event); });
  const destination = path.join(dataDir, 'execution-settings.json'); await mkdir(destination);
  await assert.rejects(engine.updateExecutionSettings({ maxConcurrentRuns: null }), { status: 500, code: 'EXECUTION_SETTINGS_SAVE_FAILED' });
  assert.equal(engine.executionStatus().capacity, 2); assert.equal(events.length, 0); assert.equal(engine.storageStatus().healthy, false); assert.match(engine.storageStatus().error, /Execution settings were not saved/);
  assert.equal((await readdir(dataDir)).some(file => file.startsWith('execution-settings.json.') && file.endsWith('.tmp')), false, 'failed temporary write is cleaned');
  await rmdir(destination); await engine.updateExecutionSettings({ maxConcurrentRuns: 70 }); assert.equal(engine.executionStatus().capacity, 70); assert.equal(engine.storageStatus().healthy, true); assert.equal(events.length, 1);
});

test('invalid saved execution settings are preserved and reported instead of silently applying unlimited', async t => {
  const { engine, dataDir, cwd, runtime, engines } = await harness(t); await engine.close();
  const destination = path.join(dataDir, 'execution-settings.json'); await writeFile(destination, '{broken settings');
  const restored = new HarnessEngine({ runtime, dataDir, defaultCwd: cwd }); engines.push(restored);
  await assert.rejects(restored.init(), /Cannot load execution settings.*existing file has been preserved/); assert.equal(await readFile(destination, 'utf8'), '{broken settings');
});

test('large valid workflows retain user-selected parallelism and start all ready branches when unlimited', async t => {
  const release = deferred(), runtime = new FakeRuntime(() => release.promise), { engine } = await harness(t, runtime);
  const agents = Array.from({ length: 60 }, (_, index) => node(`worker-${index}`, 'agent', `Independent branch ${index}`));
  const graph = workflow({ nodes: [node('input', 'input'), ...agents, node('output', 'output')], edges: agents.flatMap(agent => [edge('input', agent.id), edge(agent.id, 'output')]), settings: { maxParallel: null } });
  assert.equal(validateWorkflow(graph).settings.maxParallel, null); assert.equal(validateWorkflow({ ...graph, settings: { maxParallel: 65 } }).settings.maxParallel, 65);
  for (const maxParallel of [0, -1, 3.5, '8', Infinity]) assert.throws(() => validateWorkflow({ ...graph, settings: { maxParallel } }), /positive whole number/);
  await engine.saveWorkflow(graph); assert.equal(engine.listWorkflows()[0].nodes.length, 62);
  try { const run = engine.startRun({ workflow: graph, input: 'Execute the independent branches.' }); await waitFor(() => runtime.calls.length === 60, 'all sixty ready branches start without a node, edge or four-worker ceiling'); release.resolve({ output: 'Branch complete.' }); await engine.executions.get(run.id); assert.equal(engine.getRun(run.id).status, 'completed'); }
  finally { release.resolve({ output: 'Fixture cleanup.' }); }
});

test('desktop agents run in parallel while their actual shared Windows actions remain serialized by the adapter', async t => {
  const firstAction = deferred(); let entered = 0, active = 0, peak = 0;
  const desktop = new DesktopController({ platform: 'win32', runner: async () => { active++; peak = Math.max(peak, active); if (++entered === 1) await firstAction.promise; await new Promise(resolve => setTimeout(resolve, 5)); active--; return { windows: [] }; } }); desktop.setEnabled(true);
  const runtime = new FakeRuntime(async options => { const result = await options.onToolCall({ name: 'relay_desktop', arguments: { action: 'windows' } }); assert.equal(result.success, true); return { output: 'Desktop observations complete.' }; });
  const { engine } = await harness(t, runtime, { desktop });
  const agents = Array.from({ length: 5 }, (_, index) => ({ ...node(`desktop-${index}`, 'agent', `Observe branch ${index}`), desktop: true }));
  const graph = workflow({ nodes: [node('input', 'input'), ...agents, node('output', 'output')], edges: agents.flatMap(agent => [edge('input', agent.id), edge(agent.id, 'output')]), settings: { maxParallel: 5 } });
  try { const run = engine.startRun({ workflow: graph, input: 'Observe independent Windows information.' }); await waitFor(() => runtime.calls.length === 5 && entered === 1, 'all five agents execute while the first shared desktop action is held'); assert.equal(engine.getRun(run.id).workflow.settings.maxParallel, 5); assert.equal(peak, 1); firstAction.resolve(); await engine.executions.get(run.id); assert.equal(engine.getRun(run.id).status, 'completed'); assert.equal(entered, 5); assert.equal(peak, 1); }
  finally { firstAction.resolve(); desktop.setEnabled(false); }
});

test('provider failure codes survive saved run reconstruction and archived conversation recovery', async t => {
  const runtime = new FakeRuntime(async options => {
    options.onEvent({ type: 'thread', threadId: 'provider_failure_fixture', turnId: 'failed-turn' });
    throw Object.assign(new Error('Fixture API credentials were rejected. Check the API key in Models.'), { code: 'PROVIDER_AUTH' });
  });
  const { engine, cwd, dataDir, engines } = await harness(t, runtime);
  const archive = await new ConversationArchive({ dataDir, engine }).init();
  const run = engine.startRun({ workflow: workflow(), input: 'Keep this actionable failure.' }); await engine.executions.get(run.id);
  const failed = engine.getRun(run.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.errorCode, 'PROVIDER_AUTH'); assert.equal(failed.nodes.agent.errorCode, 'PROVIDER_AUTH');
  assert.equal(failed.canRetry, true, 'no application limit still permits retrying a settled failure');
  assert.equal(typeof failed.error, 'string'); assert.equal(typeof failed.nodes.agent.error, 'string');
  await archive.setState(run.id, 'archived'); await engine.close(); await archive.close();
  const restored = await new HarnessEngine({ runtime, dataDir, defaultCwd: cwd }).init(); engines.push(restored);
  assert.equal(restored.getRun(run.id).errorCode, 'PROVIDER_AUTH'); assert.equal(restored.getRun(run.id).nodes.agent.errorCode, 'PROVIDER_AUTH');
  const saved = await new ConversationArchive({ dataDir, engine: restored }).init();
  try {
    restored.runs.delete(run.id);
    const family = await saved.family(run.id);
    assert.equal(family.state, 'archived'); assert.equal(family.runs[0].errorCode, 'PROVIDER_AUTH'); assert.equal(family.runs[0].nodes.agent.errorCode, 'PROVIDER_AUTH');
    assert.match(family.runs[0].error, /Check the API key/); assert.equal(runtime.calls.length, 1);
  } finally { await saved.close(); }
});

test('a coded cancellation acknowledged after user Stop remains cancelled without a provider failure code', async t => {
  const entered = deferred(), runtime = new FakeRuntime(options => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped by user.'), { code: 'ABORT_ERR', name: 'AbortError' })), { once: true }); entered.resolve();
  }));
  const { engine } = await harness(t, runtime);
  const run = engine.startRun({ workflow: workflow(), input: 'Stop this run.' }); await entered.promise; engine.cancelRun(run.id); await engine.executions.get(run.id);
  const stopped = engine.getRun(run.id);
  assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.nodes.agent.status, 'cancelled'); assert.equal(stopped.errorCode, undefined); assert.equal(stopped.nodes.agent.errorCode, undefined);
  assert.equal(stopped.error, undefined); assert.equal(stopped.nodes.agent.error, undefined);
});

test('independent chats reserve capacity immediately, run together, and retain separate Stop and completion boundaries', async t => {
  const holds = new Map(['FIRST CHAT', 'SECOND CHAT', 'THIRD CHAT'].map(key => [key, deferred()]));
  const runtime = new FakeRuntime(async options => {
    const key = [...holds.keys()].find(value => options.prompt.includes(value));
    options.onEvent({ type: 'thread', threadId: `thread-${key.replaceAll(' ', '-')}` });
    return holds.get(key).promise;
  });
  const { engine } = await harness(t, runtime, { maxConcurrentRuns: 2 });
  try {
    const request = { requestId: 'parallel-first', workflow: workflow(), input: 'FIRST CHAT' }, first = engine.startRun(request), second = engine.startRun({ workflow: workflow(), input: 'SECOND CHAT' });
    assert.deepEqual(engine.executionStatus().activeRunIds, [first.id, second.id]); assert.equal(engine.executionStatus().activeCount, 2); assert.equal(engine.executionStatus().capacity, 2); assert.equal(engine.executionStatus().availableSlots, 0);
    assert.equal(engine.startRun(request).id, first.id, 'receipt replay precedes capacity rejection');
    assert.throws(() => engine.startRun({ workflow: workflow(), input: 'THIRD CHAT' }), { status: 409, code: 'RUN_CAPACITY' });
    await waitFor(() => runtime.calls.length === 2, 'both independent chats enter the runtime before either finishes');
    engine.cancelRun(first.id);
    assert.equal(runtime.calls[0].signal.aborted, true); assert.equal(runtime.calls[1].signal.aborted, false); assert.equal(engine.getRun(second.id).status, 'running');
    assert.equal(engine.executionStatus().availableSlots, 0, 'a stopped chat retains its slot until the runtime acknowledges');
    holds.get('FIRST CHAT').resolve({ output: 'Stopped reply.', threadId: 'thread-first' }); await engine.executions.get(first.id);
    assert.equal(engine.executionStatus().availableSlots, 1); assert.deepEqual(engine.executionStatus().activeRunIds, [second.id]);
    const third = engine.startRun({ workflow: workflow(), input: 'THIRD CHAT' }); await waitFor(() => runtime.calls.length === 3, 'a replacement uses the freed slot');
    holds.get('THIRD CHAT').resolve({ output: 'Third complete.', threadId: 'thread-third' }); await engine.executions.get(third.id);
    assert.equal(engine.getRun(third.id).status, 'completed'); assert.equal(engine.getRun(second.id).status, 'running'); assert.equal(runtime.calls[1].signal.aborted, false);
    holds.get('SECOND CHAT').resolve({ output: 'Second complete.', threadId: 'thread-second' }); await engine.executions.get(second.id);
    assert.equal(engine.getRun(first.id).status, 'cancelled'); assert.equal(engine.getRun(second.id).nodes.agent.output, 'Second complete.'); assert.equal(engine.executionStatus().activeCount, 0); assert.equal(engine.executionStatus().availableSlots, 2);
  } finally { for (const hold of holds.values()) hold.resolve({ output: 'Fixture cleanup.' }); }
});

test('failure and retry in one chat leave another chat running independently', async t => {
  const failure = deferred(), other = deferred(); let firstCalls = 0;
  const runtime = new FakeRuntime(async options => {
    if (options.prompt.includes('MAY FAIL')) { options.onEvent({ type: 'thread', threadId: 'thread-failing-chat' }); if (++firstCalls === 1) return failure.promise; return { output: 'Retried independently.', threadId: 'thread-failing-chat' }; }
    options.onEvent({ type: 'thread', threadId: 'thread-independent-chat' }); return other.promise;
  });
  const { engine } = await harness(t, runtime, { maxConcurrentRuns: 2 });
  try {
    const first = engine.startRun({ workflow: workflow(), input: 'MAY FAIL' }), second = engine.startRun({ workflow: workflow(), input: 'INDEPENDENT CHAT' }); await waitFor(() => runtime.calls.length === 2, 'both chats start');
    failure.reject(Object.assign(new Error('Fixture API rate limit.'), { code: 'PROVIDER_RATE_LIMIT' })); await engine.executions.get(first.id);
    assert.equal(engine.getRun(first.id).status, 'failed'); assert.equal(engine.getRun(first.id).canRetry, true); assert.equal(engine.getRun(second.id).status, 'running'); assert.equal(runtime.calls[1].signal.aborted, false);
    const retried = engine.retryRun(first.id); await engine.executions.get(retried.id); assert.equal(engine.getRun(retried.id).nodes.agent.output, 'Retried independently.'); assert.equal(engine.getRun(second.id).status, 'running');
    other.resolve({ output: 'Other chat complete.', threadId: 'thread-independent-chat' }); await engine.executions.get(second.id); assert.equal(engine.getRun(second.id).status, 'completed');
  } finally { failure.resolve({ output: 'Fixture cleanup.' }); other.resolve({ output: 'Fixture cleanup.' }); }
});

test('a conversation cannot fork another continuation or compaction while its saved thread is active', async t => {
  const followup = deferred();
  const runtime = new FakeRuntime(async options => options.threadId ? followup.promise : { output: 'Initial reply.', threadId: options.prompt.includes('UNRELATED') ? 'thread-unrelated' : 'thread-same-chat' });
  runtime.compactThread = async () => ({ compacted: true });
  const { engine } = await harness(t, runtime);
  const original = engine.startRun({ workflow: workflow(), input: 'ORIGINAL CHAT' }); await engine.executions.get(original.id);
  const request = { requestId: 'one-chat-followup', nodeId: 'agent', message: 'Continue this chat.' }, next = engine.continueRun(original.id, request);
  try {
    assert.equal(engine.continueRun(original.id, request).id, next.id);
    assert.throws(() => engine.continueRun(original.id, { nodeId: 'agent', message: 'A conflicting turn.' }), { status: 409, code: 'CHAT_BUSY' });
    assert.throws(() => engine.continueRun(next.id, { nodeId: 'agent', message: 'A second conflicting turn.' }), { status: 409, code: 'CHAT_BUSY' });
    await assert.rejects(engine.compactRun(original.id, { nodeId: 'agent' }), { status: 409, code: 'CHAT_BUSY' });
    const independent = engine.startRun({ workflow: workflow(), input: 'UNRELATED CHAT' }); await engine.executions.get(independent.id); assert.equal(engine.getRun(independent.id).status, 'completed');
    assert.equal(engine.getRun(next.id).settled, false);
  } finally { followup.resolve({ output: 'Follow-up complete.', threadId: 'thread-same-chat' }); }
  await engine.executions.get(next.id); assert.equal(engine.getRun(next.id).status, 'completed');
});

test('multiple admitted chats wait for the same background review to finish before reading learned context', async t => {
  const review = deferred(), releases = [deferred(), deferred()]; let reviewSettled = false, contextReads = 0, cancellations = 0;
  const learning = { cancelBackground() { cancellations++; return review.promise; }, getContext() { assert.equal(reviewSettled, true); contextReads++; return { lessons: [], skills: [], facts: [], truncated: false }; }, async scheduleAfterRun() {} };
  const runtime = new FakeRuntime(() => releases[runtime.calls.length - 1].promise);
  const { engine } = await harness(t, runtime, { learning, maxConcurrentRuns: 2 });
  try {
    const first = engine.startRun({ workflow: workflow(), input: 'First queued behind review.' }), second = engine.startRun({ workflow: workflow(), input: 'Second queued behind review.' });
    assert.equal(engine.executionStatus().activeCount, 2); assert.equal(engine.executionStatus().availableSlots, 0); await new Promise(resolve => setImmediate(resolve));
    assert.equal(runtime.calls.length, 0); assert.equal(contextReads, 0); assert.equal(cancellations, 2);
    reviewSettled = true; review.resolve(); await waitFor(() => runtime.calls.length === 2, 'both chats start after review acknowledgement'); assert.equal(contextReads, 2);
    releases.forEach((release, index) => release.resolve({ output: 'Ready.', threadId: `review-thread-${index}` })); await Promise.all([engine.executions.get(first.id), engine.executions.get(second.id)]);
  } finally { reviewSettled = true; review.resolve(); releases.forEach(release => release.resolve({ output: 'Fixture cleanup.' })); }
});

test('shutdown cancels and drains every active chat and advertises no new capacity while waiting', async t => {
  const holds = [deferred(), deferred()], runtime = new FakeRuntime(() => holds[runtime.calls.length - 1].promise);
  const { engine } = await harness(t, runtime);
  const first = engine.startRun({ workflow: workflow(), input: 'First held chat.' }), second = engine.startRun({ workflow: workflow(), input: 'Second held chat.' }); await waitFor(() => runtime.calls.length === 2, 'both shutdown fixtures start');
  let finished = false; const closing = engine.close().then(() => { finished = true; });
  try {
    assert.ok(runtime.calls.every(call => call.signal.aborted)); assert.equal(engine.executionStatus().availableSlots, 0); assert.equal(engine.executionStatus().activeCount, 2); assert.equal(engine.executionStatus().stopping, true);
    holds[0].resolve({ output: 'First stopped.' }); await engine.executions.get(first.id); await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false); assert.equal(engine.executionStatus().activeCount, 1);
    holds[1].resolve({ output: 'Second stopped.' }); await closing; assert.equal(engine.getRun(first.id).status, 'cancelled'); assert.equal(engine.getRun(second.id).status, 'cancelled'); assert.equal(engine.executions.size, 0); assert.equal(engine.controllers.size, 0); assert.equal(engine.executionStatus().availableSlots, 0);
  } finally { holds.forEach(hold => hold.resolve({ output: 'Fixture cleanup.' })); await closing; }
});

test('context compaction occupies one slot, locks its conversation, and can stop without interrupting another chat', async t => {
  const other = deferred(), entered = deferred();
  const runtime = new FakeRuntime(async options => options.prompt.includes('HELD OTHER CHAT') ? other.promise : { output: 'Saved reply.', threadId: 'thread-to-compact' });
  runtime.compactThread = (threadId, { signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(Object.assign(new Error('Compaction stopped.'), { code: 'ABORT_ERR' })), { once: true }); entered.resolve(); });
  const { engine } = await harness(t, runtime, { maxConcurrentRuns: 2 });
  const original = engine.startRun({ workflow: workflow(), input: 'ORIGINAL COMPACT CHAT' }); await engine.executions.get(original.id);
  const unrelated = engine.startRun({ workflow: workflow(), input: 'HELD OTHER CHAT' }); await waitFor(() => runtime.calls.length === 2, 'unrelated chat is active');
  const notifications = [], observe = event => { if (event.type === 'node.updated' && event.runId === original.id && event.nodeId === 'agent') notifications.push({ node: event.data, execution: engine.executionStatus() }); }; engine.on('event', observe);
  const compacting = engine.compactRun(original.id, { nodeId: 'agent' });
  try {
    assert.equal(notifications.length, 1, 'compaction publishes its reservation synchronously before the silent runtime starts'); assert.equal(notifications[0].node.status, 'completed'); assert.equal(notifications[0].execution.activeCount, 2); assert.equal(notifications[0].execution.availableSlots, 0);
    await entered.promise; assert.equal(engine.executionStatus().activeCount, 2); assert.equal(engine.executionStatus().availableSlots, 0); assert.deepEqual(engine.executionStatus().activeRunIds, [unrelated.id, original.id]);
    assert.throws(() => engine.continueRun(original.id, { nodeId: 'agent', message: 'Wait for compaction.' }), { status: 409, code: 'CHAT_BUSY' });
    assert.throws(() => engine.startRun({ workflow: workflow(), input: 'No slot yet.' }), { status: 409, code: 'RUN_CAPACITY' });
    engine.cancelRun(original.id); await assert.rejects(compacting, { code: 'ABORT_ERR' });
    assert.equal(notifications.at(-1).node.status, 'completed'); assert.equal(notifications.at(-1).execution.availableSlots, 1, 'compaction publishes its released slot after acknowledgement');
    assert.equal(runtime.calls[1].signal.aborted, false); assert.equal(engine.getRun(unrelated.id).status, 'running'); assert.equal(engine.getRun(original.id).status, 'completed'); assert.equal(engine.executionStatus().availableSlots, 1);
    const continued = engine.continueRun(original.id, { nodeId: 'agent', message: 'Continue after stopped compaction.' }); await engine.executions.get(continued.id); assert.equal(engine.getRun(continued.id).status, 'completed');
  } finally { engine.cancelRun(original.id); await compacting.catch(() => {}); engine.off('event', observe); other.resolve({ output: 'Other complete.', threadId: 'other-compact-thread' }); }
  await engine.executions.get(unrelated.id);
});

test('long-running chats survive recent-history rollover and remain in the durable run snapshot', async t => {
  const hold = deferred(), runtime = new FakeRuntime(options => options.prompt.includes('LONG RUN') ? hold.promise : { output: 'Short complete.', threadId: 'short-thread' });
  const { engine, dataDir } = await harness(t, runtime);
  const long = engine.startRun({ workflow: workflow(), input: 'LONG RUN' }); await waitFor(() => runtime.calls.length === 1, 'long-running fixture starts');
  try {
    const snapshot = engine.getRun(long.id);
    for (let index = 0; index < 100; index++) { const historical = structuredClone(snapshot); historical.id = `old-run-${index}`; historical.taskId = historical.id; historical.status = 'completed'; historical.settled = true; for (const state of Object.values(historical.nodes)) state.status = 'completed'; engine.runs.set(historical.id, historical); }
    const recent = engine.startRun({ workflow: workflow(), input: 'SHORT RUN' }); await engine.executions.get(recent.id); await engine.persist();
    assert.equal(engine.runs.size, 100); assert.equal(engine.getRun(long.id).status, 'running');
    const saved = JSON.parse(await readFile(path.join(dataDir, 'runs.json'), 'utf8')); assert.equal(saved.length, 100); assert.equal(saved.find(run => run.id === long.id)?.status, 'running');
    assert.deepEqual(engine.executionStatus().activeRunIds, [long.id]);
  } finally { hold.resolve({ output: 'Long complete.', threadId: 'long-thread' }); }
  await engine.executions.get(long.id);
});

test('a repeated client request returns its admitted run before active-run checks', async t => {
  const hold = deferred(), runtime = new FakeRuntime(() => hold.promise);
  const { engine, cwd } = await harness(t, runtime);
  const graph = workflow(), request = { requestId: 'ui-start-1', workflow: graph, input: { task: 'Run this once.', cwd }, metadata: { inboxId: 'inbox-fixture', inboxDispatchId: 'dispatch-fixture' } };
  try {
    const first = engine.startRun(request);
    const rewritten = { ...request, workflow: { ...graph, id: 'resaved-flow', createdAt: 'new timestamp', updatedAt: 'later timestamp' } };
    assert.equal(engine.startRun(rewritten).id, first.id);
    assert.equal(engine.runs.size, 1); assert.equal(first.metadata.clientRequestId, request.requestId); assert.match(first.metadata.clientRequestHash, /^[a-f0-9]{64}$/);
    assert.equal(first.metadata.inboxId, 'inbox-fixture'); assert.equal(first.metadata.inboxDispatchId, 'dispatch-fixture');
    for (const change of [ { input: { task: 'Changed task.', cwd } }, { input: { task: 'Run this once.', cwd: path.dirname(cwd) } }, { workflow: workflow({ nodes: [node('input', 'input'), node('agent', 'agent', 'CHANGED'), node('output', 'output')] }) }, { workflow: workflow({ nodes: [node('input', 'input'), { ...node('agent', 'agent', 'AGENT_MARKER'), model: 'another-model' }, node('output', 'output')] }) } ]) {
      assert.throws(() => engine.startRun({ ...request, ...change }), { status: 409, code: 'RUN_REQUEST_CONFLICT' });
    }
    await waitFor(() => runtime.calls.length === 1, 'only one admitted dispatch');
  } finally { hold.resolve({ output: 'Done once.', threadId: 'one-thread' }); }
});

test('client request hashes canonicalize authored keys and replay the same admission after default changes', async t => {
  const hold = deferred(), runtime = new FakeRuntime(() => hold.promise), { engine } = await harness(t, runtime);
  let defaultModel = 'model-a'; runtime.status = () => ({ connected: true, authenticated: true, defaultModel });
  const graph = workflow(); graph.nodes[1].providerOptions = { createdAt: 'meaningful nested option', budget: 5 };
  const request = { requestId: 'canonical-request', workflow: graph, input: 'Canonical task.' };
  try {
    const first = engine.startRun(request), reordered = structuredClone(graph);
    reordered.nodes[1].providerOptions = { budget: 5, createdAt: 'meaningful nested option' };
    assert.equal(engine.startRun({ ...request, workflow: reordered }).id, first.id);
    reordered.nodes[1].providerOptions.createdAt = 'changed nested option';
    assert.throws(() => engine.startRun({ ...request, workflow: reordered }), { code: 'RUN_REQUEST_CONFLICT' });
    defaultModel = 'model-b'; assert.equal(engine.startRun(request).id,first.id);assert.equal(first.workflow.nodes.find(node=>node.type==='agent').model,'model-a');
  } finally { hold.resolve({ output: 'Canonical result.', threadId: 'canonical-thread' }); }
});

test('admission pins every default agent before delayed work and leaves the saved workflow authored',async t=>{
  let selected='first-model';const entered=deferred(),release=deferred();
  const runtime=new FakeRuntime(async options=>{if(options.prompt.startsWith('You are first.')){entered.resolve();await release.promise;}return{output:'Pinned fixture result',threadId:'pinned-thread'};});
  runtime.status=()=>({connected:true,authenticated:true,defaultModel:selected});
  const{engine}=await harness(t,runtime),graph=workflow({nodes:[node('input','input'),{...node('first','agent','FIRST'),model:'default'},{...node('second','agent','SECOND'),model:'default'},node('output','output')],edges:[edge('input','first'),edge('first','second'),edge('second','output')],settings:{maxParallel:1}});
  await engine.saveWorkflow(graph);const run=engine.startRun({workflow:graph,input:'Keep the selected model for all queued agents.'});
  try{await entered.promise;selected='later-model';assert.deepEqual(engine.getRun(run.id).workflow.nodes.filter(node=>node.type==='agent').map(node=>node.model),['first-model','first-model']);assert.deepEqual(engine.listWorkflows()[0].nodes.filter(node=>node.type==='agent').map(node=>node.model),['default','default']);}
  finally{release.resolve();}
  await engine.executions.get(run.id);assert.deepEqual(runtime.calls.map(call=>call.model),['first-model','first-model']);
  const next=engine.startRun({workflow:graph,input:'Use the new default on the next submission.'});await engine.executions.get(next.id);assert.equal(runtime.calls.at(-1).model,'later-model');
});

test('qualified provider defaults are pinned once and replay remains available after provider configuration changes',async t=>{
  const release=deferred(),runtime=new FakeRuntime(()=>release.promise);let current={providerId:'primary',model:'vendor/first',available:true},resolutions=0;
  runtime.resolveModel=value=>{if(value==='default'){resolutions++;return current;}const [providerId,model]=value.split('::');return{providerId,model,available:true};};
  const{engine}=await harness(t,runtime),request={requestId:'provider-default-receipt',workflow:workflow(),input:'Admit once with the API provider.'};
  try{const first=engine.startRun(request);assert.equal(first.workflow.nodes.find(node=>node.type==='agent').model,'primary::vendor/first');assert.equal(resolutions,1);current={providerId:'secondary',model:'other',available:false,error:'Offline fixture'};assert.equal(engine.startRun(request).id,first.id);assert.equal(resolutions,1);assert.throws(()=>engine.startRun({...request,workflow:workflow({nodes:[node('input','input'),{...node('agent','agent','AGENT_MARKER'),model:'primary::vendor/first'},node('output','output')]})}),{code:'RUN_REQUEST_CONFLICT'});}
  finally{release.resolve({output:'Admitted fixture',threadId:'provider_fixture'});}
});

test('new default continuation resolves at admission while omitted models keep the prior actual selection',async t=>{
  let selected='model-a';const runtime=new FakeRuntime(async options=>({output:'Continuation fixture',threadId:options.threadId||'same-native-thread'}));runtime.status=()=>({connected:true,authenticated:true,defaultModel:selected});
  const{engine}=await harness(t,runtime),first=engine.startRun({workflow:workflow(),input:'Begin with the initial default.'});await engine.executions.get(first.id);selected='model-b';
  const kept=engine.continueRun(first.id,{nodeId:'agent',message:'Keep the saved actual model.'});assert.equal(kept.workflow.nodes.find(node=>node.type==='agent').model,'model-a');await engine.executions.get(kept.id);
  const request={requestId:'explicit-default-followup',nodeId:'agent',message:'Now use the new application default.',model:'default'},next=engine.continueRun(kept.id,request);assert.equal(next.workflow.nodes.find(node=>node.type==='agent').model,'model-b');
  selected='model-c';assert.equal(engine.continueRun(kept.id,request).id,next.id);assert.throws(()=>engine.continueRun(kept.id,{...request,model:'model-c'}),{code:'RUN_REQUEST_CONFLICT'});await engine.executions.get(next.id);assert.equal(runtime.calls.at(-1).model,'model-b');
});

test('pinned admission and authored request receipts survive reconstruction after the default changes',async t=>{
  let selected='original-model';const runtime=new FakeRuntime();runtime.status=()=>({connected:true,authenticated:true,defaultModel:selected});
  const{engine,dataDir,cwd,engines}=await harness(t,runtime),request={requestId:'durable-default-selection',workflow:workflow(),input:'Persist the first admission.'},first=engine.startRun(request);await engine.executions.get(first.id);await engine.close();selected='new-model';
  const restored=await new HarnessEngine({runtime,dataDir,defaultCwd:cwd}).init();engines.push(restored);const replay=restored.startRun(request);assert.equal(replay.id,first.id);assert.equal(replay.workflow.nodes.find(node=>node.type==='agent').model,'original-model');assert.equal(runtime.calls.length,1);
});

test('an upgraded legacy start receipt replays its original admission using saved model evidence only', async t => {
  const runtime = new FakeRuntime(async options => { options.onEvent({ type: 'thread', model: 'primary::vendor/original', threadId: 'provider_legacy' }); return { output: 'Legacy fixture reply', threadId: 'provider_legacy' }; });
  runtime.resolveModel = value => ({ providerId: 'primary', model: value === 'default' ? 'vendor/original' : value.split('::')[1], available: true });
  const { engine, dataDir, cwd, engines } = await harness(t, runtime);
  const request = { requestId: 'upgrade-start', workflow: workflow(), input: 'Recover the already accepted send.', metadata: { inboxId: 'legacy-inbox' } };
  const first = engine.startRun(request); await engine.executions.get(first.id);
  assert.equal(first.metadata.clientRequestHashVersion, 3);
  const accepted = engine.runs.get(first.id), normalized = validateWorkflow(request.workflow), { id, createdAt, updatedAt, ...content } = normalized;
  for(const node of content.nodes)if(node.effort===undefined)node.effort='medium';
  accepted.workflow.nodes.find(node => node.type === 'agent').model = 'default';
  accepted.metadata.clientRequestHash = legacyDigest({ kind: 'start', workflow: content, task: request.input, cwd, attachmentIds: [], models: [{ nodeId: 'agent', providerId: 'primary', model: 'vendor/original' }], metadata: request.metadata, planningMode: 'off' });
  delete accepted.metadata.clientRequestHashVersion;
  await engine.close();
  runtime.resolveModel = () => { throw new Error('Legacy replay must not consult the current provider/default.'); };
  const restored = await new HarnessEngine({ runtime, dataDir, defaultCwd: cwd }).init(); engines.push(restored);
  assert.equal(restored.startRun(request).id, first.id); assert.equal(runtime.calls.length, 1);
  for (const changed of [{ input: 'A different send.' }, { metadata: { inboxId: 'different-inbox' } }, { workflow: workflow({ nodes: [node('input', 'input'), { ...node('agent', 'agent', 'AGENT_MARKER'), model: 'primary::vendor/original' }, node('output', 'output')] }) }]) assert.throws(() => restored.startRun({ ...request, ...changed }), { code: 'RUN_REQUEST_CONFLICT' });
  const saved = restored.runs.get(first.id), resolved = saved.nodes.agent.resolvedModel;
  delete saved.nodes.agent.resolvedModel; saved.events = [];
  assert.throws(() => restored.startRun(request), { code: 'RUN_REQUEST_CONFLICT' }, 'missing historical model evidence cannot resolve from the current default');
  saved.nodes.agent.resolvedModel = resolved;
  assert.equal(restored.startRun(request).id, first.id); assert.equal(runtime.calls.length, 1);
});

test('legacy continuation receipts survive restart and default changes without changing symbolic model intent', async t => {
  for (const explicitDefault of [false, true]) await t.test(explicitDefault ? 'explicit default' : 'omitted saved model', async t => {
    let selected = 'model-a';
    const runtime = new FakeRuntime(async options => { options.onEvent({ type: 'thread', model: options.model, threadId: options.threadId || 'legacy-native-thread' }); return { output: 'Legacy continuation fixture', threadId: options.threadId || 'legacy-native-thread' }; });
    runtime.resolveModel = value => ({ providerId: 'codex', model: value === 'default' ? selected : value, available: true });
    const { engine, dataDir, cwd, engines } = await harness(t, runtime), first = engine.startRun({ workflow: workflow(), input: 'Original legacy conversation.' });
    await engine.executions.get(first.id); selected = 'model-b';
    const request = { requestId: 'legacy-followup', nodeId: 'agent', message: 'Recover the accepted follow-up.', ...(explicitDefault ? { model: 'default' } : {}) };
    const next = engine.continueRun(first.id, request); await engine.executions.get(next.id);
    assert.equal(next.metadata.clientRequestHashVersion, 2);
    const accepted = engine.runs.get(next.id), originalSelectedModel = explicitDefault ? 'default' : 'model-a';
    accepted.workflow.nodes.find(node => node.id === 'agent').model = originalSelectedModel;
    accepted.metadata.clientRequestHash = legacyDigest({ kind: 'continue', runId: first.id, nodeId: 'agent', message: request.message, model: originalSelectedModel, models: [{ nodeId: 'agent', providerId: 'codex', model: explicitDefault ? 'model-b' : 'model-a' }], attachmentIds: [] });
    delete accepted.metadata.clientRequestHashVersion;
    await engine.close(); selected = 'model-c';
    runtime.resolveModel = () => { throw new Error('Recovered continuation cannot resolve a new default.'); };
    const restored = await new HarnessEngine({ runtime, dataDir, defaultCwd: cwd }).init(); engines.push(restored);
    assert.equal(restored.continueRun(first.id, request).id, next.id);
    for (const changed of [{ message: 'Changed follow-up.' }, { model: 'model-c' }, { prompt: 'Changed agent instructions.' }]) assert.throws(() => restored.continueRun(first.id, { ...request, ...changed }), { code: 'RUN_REQUEST_CONFLICT' });
    if (explicitDefault) assert.throws(() => restored.continueRun(first.id, { ...request, model: 'model-b' }), { code: 'RUN_REQUEST_CONFLICT' }, 'explicit default remains part of the legacy authored intent');
    assert.equal(runtime.calls.length, 2);
  });
});

test('client requests bind attachments and duplicate receipts do not require reopening attachment files', async t => {
  const hold = deferred(), runtime = new FakeRuntime(() => hold.promise), { engine } = await harness(t, runtime);
  engine.attachments = { validateIds: ids => [...new Set(ids)], prompt: async () => 'Disposable attachment fixture.' };
  const request = { requestId: 'attached-request', workflow: workflow(), input: { task: 'Use the attachment.', attachmentIds: ['fixture-file-a', 'fixture-file-a'] } };
  try {
    const first = engine.startRun(request);
    engine.attachments.validateIds = () => { throw new Error('Attachment is no longer available.'); };
    assert.equal(engine.startRun({ ...request, input: { ...request.input, attachmentIds: ['fixture-file-a'] } }).id, first.id);
    assert.throws(() => engine.startRun({ ...request, input: { ...request.input, attachmentIds: ['fixture-file-b'] } }), { code: 'RUN_REQUEST_CONFLICT' });
  } finally { hold.resolve({ output: 'Attachment result.', threadId: 'attachment-thread' }); }
});

test('client request IDs are optional, validated before admission, and survive reconstruction', async t => {
  const { engine, cwd, dataDir, engines, runtime } = await harness(t);
  for (const requestId of [null, '', 'invalid id', 'x'.repeat(101), 42]) assert.throws(() => engine.startRun({ requestId, workflow: workflow(), input: 'Task.' }), { status: 400, code: 'RUN_REQUEST_INVALID' });
  assert.equal(engine.runs.size, 0);
  const request = { requestId: 'persisted-request', workflow: workflow(), input: 'Persist admission.' }, run = engine.startRun(request);
  await waitFor(() => engine.getRun(run.id).settled, 'admission settles'); await engine.close();
  const restored = new HarnessEngine({ runtime: new FakeRuntime(), dataDir, defaultCwd: cwd }); engines.push(restored); await restored.init();
  assert.equal(restored.startRun(request).id, run.id); assert.equal(restored.runtime.calls.length, 0); assert.equal(runtime.calls.length, 1);
  assert.equal(restored.clientRequestRunId(request.requestId), run.id);
});

test('follow-up request IDs deduplicate an active turn and reject changed message, model or source', async t => {
  const { engine, runtime } = await harness(t), first = engine.startRun({ workflow: workflow(), input: 'Original.' });
  await waitFor(() => engine.getRun(first.id).settled, 'original settles');
  const hold = deferred(); runtime.execute = () => hold.promise;
  const request = { requestId: 'followup-request', nodeId: 'agent', message: 'Follow up once.', model: 'test-model' };
  try {
    const next = engine.continueRun(first.id, request);
    assert.equal(engine.continueRun(first.id, { ...request }).id, next.id);
    assert.equal(next.metadata.clientRequestId, request.requestId);
    for (const changed of [{ message: 'Changed.' }, { model: 'new-model' }]) assert.throws(() => engine.continueRun(first.id, { ...request, ...changed }), { status: 409, code: 'RUN_REQUEST_CONFLICT' });
    const another = structuredClone(engine.runs.get(first.id)); another.id = 'another-source'; engine.runs.set(another.id, another);
    assert.throws(() => engine.continueRun(another.id, request), { status: 409, code: 'RUN_REQUEST_CONFLICT' });
    await waitFor(() => runtime.calls.length === 2, 'one follow-up dispatch');
  } finally { hold.resolve({ output: 'One follow-up.', threadId: 'fake-thread' }); }
});

test('evicted admission receipts require archive recovery and never dispatch another run', async t => {
  const { engine, runtime } = await harness(t), request = { requestId: 'archived-request', workflow: workflow(), input: 'Archive this.' };
  const run = engine.startRun(request); await waitFor(() => engine.getRun(run.id).settled, 'run settles');
  const saved = structuredClone(engine.runs.get(run.id)); engine.runs.delete(run.id);
  assert.throws(() => engine.startRun(request), { status: 409, code: 'RUN_REQUEST_RECOVERY_REQUIRED', runId: run.id });
  assert.equal(engine.runs.size, 0); assert.equal(runtime.calls.length, 1);
  engine.restoreArchivedRun(saved); assert.equal(engine.startRun(request).id, run.id); assert.equal(runtime.calls.length, 1);
  const imported = { ...saved, id: 'conflicting-saved-run' }; engine.rememberClientRequest(imported);
  assert.throws(() => engine.clientRequestRunId(request.requestId), { status: 409, code: 'RUN_REQUEST_CONFLICT' });
});

test('request receipts are persisted before runtime actions and retries do not inherit submission identity', async t => {
  let dataDir;
  const runtime = new FakeRuntime(async () => {
    const runs = JSON.parse(await readFile(path.join(dataDir, 'runs.json'), 'utf8'));
    if (runtime.calls.length === 1) { assert.equal(runs[0].metadata.clientRequestId, 'durable-before-action'); throw new Error('Fixture failure.'); }
    return { output: 'Retry complete.', threadId: 'retry-thread' };
  });
  const context = await harness(t, runtime); dataDir = context.dataDir; const { engine } = context;
  const request = { requestId: 'durable-before-action', workflow: workflow(), input: 'Persist before action.' }, first = engine.startRun(request);
  await waitFor(() => engine.getRun(first.id).settled, 'first run fails');
  const retry = engine.retryRun(first.id); assert.equal(retry.metadata?.clientRequestId, undefined);
  await waitFor(() => engine.getRun(retry.id).settled, 'retry settles');
  assert.equal(engine.startRun(request).id, first.id); assert.equal(runtime.calls.length, 2);
});

test('follow-up continues only its selected saved agent and preserves the original run', async t => {
  const runtime = new FakeRuntime(async options => ({ output: options.threadId ? 'follow-up result' : 'original result', threadId: options.threadId || (options.prompt.includes('OTHER_MARKER') ? 'other-thread' : 'selected-thread'), usage: { totalTokens: 20, total: { totalTokens: 20 } } }));
  const { engine } = await harness(t, runtime);
  const graph = workflow({ nodes: [node('input', 'input'), node('agent', 'agent', 'AGENT_MARKER'), node('other', 'agent', 'OTHER_MARKER'), node('output', 'output')], edges: [edge('input', 'agent'), edge('input', 'other'), edge('agent', 'output'), edge('other', 'output')] });
  const initial = engine.startRun({ workflow: graph, input: 'original task' });
  await waitFor(() => engine.getRun(initial.id).settled, 'original run settles');
  const before = engine.getRun(initial.id);
  const followup = engine.continueRun(initial.id, { nodeId: 'agent', message: 'Refine your earlier result.' });
  assert.equal(followup.kind, 'continuation');
  assert.equal(followup.parentRunId, initial.id);
  assert.deepEqual(followup.continuedFrom, { runId: initial.id, nodeId: 'agent', threadId: 'selected-thread' });
  assert.deepEqual(followup.workflow.nodes.map(item => item.id), ['input', 'agent', 'output']);
  await waitFor(() => engine.getRun(followup.id).settled, 'follow-up settles');
  assert.equal(runtime.calls.length, 3, 'the other branch is never repeated');
  const call = runtime.calls.at(-1);
  assert.equal(call.threadId, 'selected-thread');
  assert.deepEqual(call.usageBaseline, { totalTokens: 20 });
  assert.match(call.prompt, /Refine your earlier result/);
  assert.match(call.prompt, /Verify the current workspace/);
  assert.equal(call.prompt.includes('OTHER_MARKER'), false);
  assert.equal(engine.getRun(followup.id).status, 'completed');
  assert.deepEqual(engine.getRun(initial.id), before, 'the original run is immutable');
  assert.throws(() => engine.continueRun(initial.id, { nodeId: 'output', message: 'hello' }), /Choose an agent/);
  assert.throws(() => engine.continueRun(initial.id, { nodeId: 'agent', message: ' ' }), /follow-up message/);
});

test('saved agent follow-up survives reconstruction and refuses an overlapping run', async t => {
  const { engine, runtime, cwd, dataDir, engines } = await harness(t);
  const initial = engine.startRun({ workflow: workflow(), input: 'original task' });
  await waitFor(() => engine.getRun(initial.id).settled, 'original run settles');
  await engine.close();
  const nextRuntime = new FakeRuntime();
  const restored = new HarnessEngine({ runtime: nextRuntime, dataDir, defaultCwd: cwd });
  engines.push(restored); await restored.init();
  const hold = deferred(); nextRuntime.execute = () => hold.promise;
  const followup = restored.continueRun(initial.id, { nodeId: 'agent', message: 'Continue after restart.' });
  try {
    await waitFor(() => nextRuntime.calls.length, 'saved thread dispatches');
    assert.equal(nextRuntime.calls[0].threadId, 'fake-thread');
    assert.throws(() => restored.continueRun(initial.id, { nodeId: 'agent', message: 'overlap' }), /still active/);
  } finally { hold.resolve({ output: 'restored follow-up', threadId: 'fake-thread' }); }
  await waitFor(() => restored.getRun(followup.id).settled, 'restored follow-up settles');
  assert.equal(restored.getRun(followup.id).status, 'completed');
});

test('continuing an older run subtracts the latest known usage of its shared conversation', async t => {
  let turn = 0;
  const runtime = new FakeRuntime(async () => ({ output: 'result', threadId: 'shared-thread', usage: { totalTokens: 20, total: { totalTokens: ++turn * 20 } } }));
  const { engine } = await harness(t, runtime);
  const original = engine.startRun({ workflow: workflow(), input: 'original' });
  await waitFor(() => engine.getRun(original.id).settled, 'original settles');
  const first = engine.continueRun(original.id, { nodeId: 'agent', message: 'first follow-up' });
  await waitFor(() => engine.getRun(first.id).settled, 'first follow-up settles');
  const second = engine.continueRun(original.id, { nodeId: 'agent', message: 'another follow-up from old history' });
  await waitFor(() => engine.getRun(second.id).settled, 'second follow-up settles');
  assert.deepEqual(runtime.calls[1].usageBaseline, { totalTokens: 20 });
  assert.deepEqual(runtime.calls[2].usageBaseline, { totalTokens: 40 });
  assert.equal(engine.getRun(original.id).nodes.agent.usage.total.totalTokens, 20);
});

test('manual compaction usage becomes the continuation baseline and survives engine reconstruction', async t => {
  let total = 0;
  const runtime = new FakeRuntime(async () => ({ output: 'result', threadId: 'compacted-shared-thread', usage: { totalTokens: 20, total: { totalTokens: total += 20 } } }));
  runtime.compactThread = async (threadId, { onEvent }) => {
    assert.equal(threadId, 'compacted-shared-thread'); total += 7;
    const context = { nativeCompaction: true, estimatedInputTokens: null, remainingTokens: null, compactionCount: 1 };
    onEvent({ type: 'context', context });
    return { compacted: true, threadId, context, usage: { totalTokens: 7, total: { totalTokens: total } } };
  };
  const { engine, cwd, dataDir, engines } = await harness(t, runtime);
  const original = engine.startRun({ workflow: workflow(), input: 'original' }); await waitFor(() => engine.getRun(original.id).settled, 'original settles');
  const compacted = await engine.compactRun(original.id, { nodeId: 'agent' }); assert.equal(compacted.usage.total.totalTokens, 27);
  assert.equal(engine.getRun(original.id).nodes.agent.usage.total.totalTokens, 20, 'compaction preserves the original turn cost');
  const first = engine.continueRun(original.id, { nodeId: 'agent', message: 'Continue after compaction.' }); await waitFor(() => engine.getRun(first.id).settled, 'follow-up settles');
  assert.deepEqual(runtime.calls.at(-1).usageBaseline, { totalTokens: 27 }, 'the new turn excludes manual compaction cost');
  assert.deepEqual(engine.threadUsageBaseline('compacted-shared-thread'), { totalTokens: 47 }, 'a newer turn supersedes the earlier checkpoint baseline');
  await engine.compactRun(original.id, { nodeId: 'agent' }); assert.deepEqual(engine.threadUsageBaseline('compacted-shared-thread'), { totalTokens: 54 });
  await engine.close();
  const nextRuntime = new FakeRuntime(async () => ({ output: 'restored', threadId: 'compacted-shared-thread', usage: { totalTokens: 20, total: { totalTokens: 74 } } }));
  const restored = new HarnessEngine({ runtime: nextRuntime, dataDir, defaultCwd: cwd }); engines.push(restored); await restored.init();
  const afterRestart = restored.continueRun(original.id, { nodeId: 'agent', message: 'Continue after restarting Relay.' }); await waitFor(() => restored.getRun(afterRestart.id).settled, 'restored follow-up settles');
  assert.deepEqual(nextRuntime.calls[0].usageBaseline, { totalTokens: 54 });
  assert.equal(restored.getRun(original.id).nodes.agent.lastCompaction.usage.total.totalTokens, 54);
});

test('validation accepts a usable DAG and returns an independent copy', () => {
  const original = workflow();
  const result = validateWorkflow(original);
  assert.equal(result.nodes.length, 3);
  result.nodes[0].name = 'changed';
  assert.equal(original.nodes[0].name, 'input');
  assert.equal(validateWorkflow({ ...original, settings: {} }).settings.maxParallel, 2, 'legacy omitted parallelism retains its normalized request-receipt identity');
  assert.equal(validateWorkflow({ ...original, settings: { maxParallel: null } }).settings.maxParallel, null);
});

test('agent workflows normalize defaults and saved restricted access settings to full trust', async t => {
  const graph = workflow();
  graph.nodes.find(item => item.type === 'agent').sandbox = 'read-only';
  const normalized = validateWorkflow(graph);
  assert.equal(normalized.nodes.find(item => item.type === 'agent').sandbox, 'danger-full-access');
  const { engine, runtime, cwd } = await harness(t);
  const run = engine.startRun({ workflow: workflow(), input: { task: 'trusted runtime defaults', cwd } });
  assert.equal((await finish(engine, run.id)).status, 'completed');
  assert.equal(runtime.calls[0].sandbox, 'danger-full-access');
  assert.equal(runtime.calls[0].onApproval, undefined, 'trusted agents receive no approval callback');
});

test('validation rejects cycles, duplicate IDs, missing references and disconnected nodes', () => {
  const cycle = workflow(); cycle.edges.push(edge('agent', 'input'));
  assert.throws(() => validateWorkflow(cycle));
  const duplicate = workflow(); duplicate.nodes.push(node('agent', 'agent'));
  assert.throws(() => validateWorkflow(duplicate));
  const missing = workflow(); missing.edges.push(edge('missing', 'output'));
  assert.throws(() => validateWorkflow(missing));
  const disconnected = workflow(); disconnected.nodes.push(node('stray', 'agent'));
  assert.throws(() => validateWorkflow(disconnected));
});

test('independent agents overlap while join waits for both outputs', async t => {
  const alpha = deferred(); const beta = deferred();
  const runtime = new FakeRuntime(async ({ prompt }) => {
    if (prompt.includes('ALPHA_MARKER')) return alpha.promise;
    if (prompt.includes('BETA_MARKER')) return beta.promise;
    assert.ok(prompt.includes('alpha result'), 'join receives alpha output');
    assert.ok(prompt.includes('beta result'), 'join receives beta output');
    return { output: 'joined result', threadId: 'join-thread' };
  });
  const { engine, cwd } = await harness(t, runtime);
  const graph = workflow({
    nodes: [node('input', 'input'), node('alpha', 'agent', 'ALPHA_MARKER'), node('beta', 'agent', 'BETA_MARKER'), node('join', 'agent', 'JOIN_MARKER'), node('output', 'output')],
    edges: [edge('input', 'alpha'), edge('input', 'beta'), edge('alpha', 'join'), edge('beta', 'join'), edge('join', 'output')],
  });
  const run = await engine.startRun({ workflow: graph, input: { task: 'test parallel graph', cwd } });
  await waitFor(() => runtime.calls.length === 2, 'both independent agents start');
  alpha.resolve({ output: 'alpha result', threadId: 'alpha-thread' });
  await waitFor(() => engine.getRun(run.id).nodes.alpha.status === 'completed', 'alpha completes');
  assert.equal(runtime.calls.length, 2, 'join stays pending until beta completes');
  beta.resolve({ output: 'beta result', threadId: 'beta-thread' });
  const result = await finish(engine, run.id);
  assert.equal(result.status, 'completed');
  assert.equal(runtime.calls.length, 3);
  assert.match(result.nodes.output.output, /joined result/);
});

test('legacy approval checkpoints pass upstream context to agents without pausing', async t => {
  const { engine, runtime, cwd } = await harness(t);
  let approvalRequests = 0;
  engine.requestApproval = () => { approvalRequests++; throw new Error('No permission gate is expected.'); };
  const graph = workflow({
    nodes: [node('input', 'input'), node('gate', 'approval'), node('agent', 'agent', 'AFTER_GATE'), node('output', 'output')],
    edges: [edge('input', 'gate'), edge('gate', 'agent'), edge('agent', 'output')],
  });
  const run = await engine.startRun({ workflow: graph, input: { task: 'CHECKPOINT_CONTEXT', cwd } });
  const result = await finish(engine, run.id);
  assert.equal(result.status, 'completed');
  assert.equal(runtime.calls.length, 1);
  assert.equal(approvalRequests, 0);
  assert.match(result.nodes.gate.output, /CHECKPOINT_CONTEXT/);
  assert.match(runtime.calls[0].prompt, /UPSTREAM RESULTS[^]*CHECKPOINT_CONTEXT/);
  assert.equal(result.events.some(event => event.type.startsWith('approval.')), false);
});

test('cancellation aborts active agents and prevents dependent execution', async t => {
  let aborted = false;
  const runtime = new FakeRuntime(({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('Cancelled by test')); }, { once: true });
  }));
  const { engine, cwd } = await harness(t, runtime);
  const graph = workflow({
    nodes: [node('input', 'input'), node('agent', 'agent', 'ACTIVE'), node('next', 'agent', 'PENDING'), node('output', 'output')],
    edges: [edge('input', 'agent'), edge('agent', 'next'), edge('next', 'output')],
  });
  const run = await engine.startRun({ workflow: graph, input: { task: 'cancel test', cwd } });
  await waitFor(() => runtime.calls.length === 1, 'active agent starts');
  await engine.cancelRun(run.id);
  const result = await finish(engine, run.id);
  assert.equal(result.status, 'cancelled');
  assert.equal(aborted, true);
  assert.equal(runtime.calls.length, 1);
});

test('capacity one waits until a cancelled agent has confirmed it stopped', async t => {
  const stopped = deferred();
  // A real Codex interrupt is asynchronous. Model that acknowledgement boundary.
  const runtime = new FakeRuntime(async () => stopped.promise);
  const { engine, cwd } = await harness(t, runtime, { maxConcurrentRuns: 1 });
  const run = engine.startRun({ workflow: workflow(), input: { task: 'first run', cwd } });
  await waitFor(() => runtime.calls.length === 1, 'first agent starts');
  engine.cancelRun(run.id);
  try {
    assert.throws(() => engine.startRun({ workflow: workflow(), input: { task: 'overlapping run', cwd } }), /stopping|current run|finish/i);
    assert.equal(runtime.calls.length, 1);
  } finally {
    stopped.resolve({ output: 'stopped', threadId: 'stopped-thread' });
  }
});

test('failed parent prevents its dependent from being dispatched', async t => {
  const runtime = new FakeRuntime(async () => { throw new Error('deliberate agent failure'); });
  const { engine, cwd } = await harness(t, runtime);
  const graph = workflow({
    nodes: [node('input', 'input'), node('agent', 'agent', 'FAIL'), node('next', 'agent', 'PENDING'), node('output', 'output')],
    edges: [edge('input', 'agent'), edge('agent', 'next'), edge('next', 'output')],
  });
  const run = await engine.startRun({ workflow: graph, input: { task: 'failure test', cwd } });
  const result = await finish(engine, run.id);
  assert.equal(result.status, 'failed');
  assert.equal(runtime.calls.length, 1);
});

test('saved workflows and completed runs survive engine reconstruction', async t => {
  const { engine, cwd, dataDir, engines } = await harness(t);
  const saved = await engine.saveWorkflow(workflow());
  const run = await engine.startRun({ workflow: saved, input: { task: 'persistence test', cwd } });
  const result = await finish(engine, run.id);
  assert.equal(result.status, 'completed');
  await engine.close();
  const restored = new HarnessEngine({ runtime: new FakeRuntime(), dataDir, defaultCwd: cwd });
  await restored.init();
  engines.push(restored);
  assert.ok(restored.listWorkflows().find(item => item.id === saved.id));
  assert.equal(restored.getRun(run.id).status, 'completed');
  assert.match(restored.getRun(run.id).nodes.agent.output, /agent result/);
});

test('cancel immediately after dispatch stays cancelled and starts no agents', async t => {
  const { engine, runtime, cwd } = await harness(t);
  const run = engine.startRun({ workflow: workflow(), input: { task: 'immediate cancellation', cwd } });
  engine.cancelRun(run.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine.getRun(run.id).status, 'cancelled');
  assert.equal(runtime.calls.length, 0);
});

test('cancelling a trusted workflow after a legacy checkpoint stops the active agent', async t => {
  const runtime = new FakeRuntime(({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Cancelled by test')), { once: true });
  }));
  const { engine, cwd } = await harness(t, runtime);
  const graph = workflow({
    nodes: [node('input', 'input'), node('gate', 'approval'), node('agent', 'agent', 'AFTER_GATE'), node('output', 'output')],
    edges: [edge('input', 'gate'), edge('gate', 'agent'), edge('agent', 'output')],
  });
  const run = engine.startRun({ workflow: graph, input: { task: 'cancel after checkpoint', cwd } });
  await waitFor(() => runtime.calls.length === 1, 'agent runs through the legacy checkpoint');
  assert.equal(engine.getRun(run.id).nodes.gate.status, 'completed');
  assert.equal(engine.listApprovals, undefined, 'permission queue API has been removed');
  engine.cancelRun(run.id);
  const result = await finish(engine, run.id);
  assert.equal(result.status, 'cancelled');
  assert.equal(runtime.calls[0].signal.aborted, true);
  assert.equal(result.events.some(event => event.type.startsWith('approval.')), false);
  assert.equal(runtime.calls.length, 1);
});

test('restart marks interrupted runs failed without rerunning agents', async t => {
  const { engine, runtime, cwd, dataDir, engines } = await harness(t);
  await engine.close();
  const interrupted = {
    id: 'interrupted-run', status: 'running', nodes: { input: { status: 'completed', output: 'task' }, agent: { status: 'running', output: 'partial' }, output: { status: 'queued', output: '' } },
  };
  const queued = structuredClone(interrupted); queued.id = 'interrupted-queued'; queued.status = 'queued'; queued.nodes.agent.status = 'queued';
  const finished = structuredClone(interrupted); finished.id = 'already-completed'; finished.status = 'completed'; for (const state of Object.values(finished.nodes)) state.status = 'completed';
  await writeFile(path.join(dataDir, 'runs.json'), JSON.stringify([interrupted, queued, finished]));
  const restored = new HarnessEngine({ runtime, dataDir, defaultCwd: cwd });
  engines.push(restored);
  await restored.init();
  assert.equal(restored.getRun(interrupted.id).status, 'failed');
  assert.equal(restored.getRun(interrupted.id).nodes.agent.status, 'cancelled');
  assert.equal(restored.getRun(queued.id).status, 'failed'); assert.equal(restored.getRun(queued.id).nodes.agent.status, 'cancelled'); assert.equal(restored.getRun(finished.id).status, 'completed');
  assert.equal(restored.executionStatus().activeCount, 0); assert.equal(restored.executionStatus().availableSlots, null); assert.equal(restored.executionStatus().unlimited, true);
  assert.equal(runtime.calls.length, 0);
  const onDisk = JSON.parse(await readFile(path.join(dataDir, 'runs.json'), 'utf8'));
  assert.equal(onDisk[0].status, 'failed');
  assert.equal(onDisk[1].status, 'failed'); assert.equal(onDisk[2].status, 'completed');
});

test('resume retains completed independent branches and runs unfinished descendants from the original snapshot', async t => {
  const failure = deferred(); let attempts = 0;
  const runtime = new FakeRuntime(async ({ prompt, onEvent }) => {
    if (prompt.includes('HEALTHY_MARKER')) return { output: 'retained result', threadId: 'retained-thread', usage: { totalTokens: 11 } };
    if (prompt.includes('FLAKY_MARKER')) {
      attempts++;
      if (attempts === 1) { onEvent({ type: 'usage', usage: { totalTokens: 3 } }); return failure.promise; }
      assert.match(prompt, /original task/);
      return { output: 'recovered result', threadId: 'retry-thread', usage: { totalTokens: 7 } };
    }
    assert.match(prompt, /recovered result/);
    return { output: 'downstream result', threadId: 'downstream-thread', usage: { totalTokens: 5 } };
  });
  const { engine, cwd } = await harness(t, runtime);
  const graph = workflow({
    nodes: [node('input', 'input'), node('healthy', 'agent', 'HEALTHY_MARKER'), node('healthyOut', 'output'), node('flaky', 'agent', 'FLAKY_MARKER'), node('next', 'agent', 'NEXT_MARKER'), node('output', 'output')],
    edges: [edge('input', 'healthy'), edge('healthy', 'healthyOut'), edge('input', 'flaky'), edge('flaky', 'next'), edge('next', 'output')],
  });
  const first = engine.startRun({ workflow: graph, input: { task: 'original task', cwd } });
  await waitFor(() => engine.getRun(first.id).nodes.healthyOut.status === 'completed', 'healthy branch completes');
  failure.reject(new Error('temporary provider failure'));
  await waitFor(() => engine.getRun(first.id).settled, 'failed execution settles');
  graph.nodes.find(item => item.id === 'flaky').prompt = 'CHANGED_DRAFT';
  await engine.saveWorkflow(graph);
  const retry = engine.retryRun(first.id);
  assert.equal(retry.retryOf, first.id);
  assert.equal(retry.parentRunId, first.id);
  assert.equal(retry.input, 'original task');
  assert.equal(retry.cwd, cwd);
  assert.equal(retry.nodes.healthy.reused, true);
  assert.equal(retry.nodes.healthy.threadId, 'retained-thread');
  assert.equal(retry.nodes.healthyOut.reused, true);
  assert.equal(retry.nodes.flaky.output, '');
  assert.equal(retry.nodes.flaky.usage, undefined, 'partial failed usage is not charged again');
  assert.deepEqual(retry.nodes.next.blockedBy, ['flaky']);
  assert.throws(() => engine.retryRun(first.id), /active|stopping|current run/i);
  await waitFor(() => engine.getRun(retry.id).settled, 'retry settles');
  const finished = engine.getRun(retry.id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.progress.reused, 3);
  assert.equal(finished.usage.totalTokens, 12);
  assert.equal(finished.reusedUsage.totalTokens, 11);
  assert.equal(runtime.calls.filter(call => call.prompt.includes('HEALTHY_MARKER')).length, 1);
  assert.equal(runtime.calls.length, 4);
  assert.match(finished.output, /retained result/);
  assert.match(finished.output, /downstream result/);
  assert.equal(engine.getRun(first.id).status, 'failed');
  assert.equal(engine.getRun(first.id).nodes.flaky.error, 'temporary provider failure');
  assert.ok(finished.startedAt && finished.finishedAt);
  assert.throws(() => engine.retryRun(finished.id), /failed or cancelled/);
});

test('resume resets completed descendants of an unfinished node', async t => {
  const { engine, runtime, cwd } = await harness(t);
  const run = engine.startRun({ workflow: workflow(), input: { task: 'dependency invalidation', cwd } });
  await waitFor(() => engine.getRun(run.id).settled, 'first execution settles');
  // Simulate an interrupted persisted snapshot whose dependent result is stale.
  const stored = engine.runs.get(run.id);
  stored.status = 'failed'; stored.nodes.agent.status = 'failed';
  stored.nodes.output.output = 'stale dependent result';
  const retry = engine.retryRun(run.id);
  assert.equal(retry.nodes.input.reused, true);
  assert.equal(retry.nodes.output.status, 'queued');
  assert.equal(retry.nodes.output.output, '');
  assert.equal(retry.nodes.output.reused, false);
  await waitFor(() => engine.getRun(retry.id).settled, 'retried descendants settle');
  assert.equal(engine.getRun(retry.id).status, 'completed');
  assert.doesNotMatch(engine.getRun(retry.id).output, /stale/);
  assert.equal(runtime.calls.length, 2);
});

test('cancelled runs cannot resume until every agent acknowledges stopping', async t => {
  const stopped = deferred(); let attempts = 0;
  const runtime = new FakeRuntime(async () => ++attempts === 1 ? stopped.promise : { output: 'resumed output', threadId: 'resumed-thread' });
  const { engine, cwd } = await harness(t, runtime);
  const run = engine.startRun({ workflow: workflow(), input: { task: 'wait for stop', cwd } });
  await waitFor(() => runtime.calls.length === 1, 'agent starts');
  assert.throws(() => engine.retryRun(run.id), /active|stopping/i);
  engine.cancelRun(run.id);
  try {
    assert.equal(engine.getRun(run.id).settled, false);
    assert.equal(engine.getRun(run.id).canRetry, false);
    assert.equal(engine.executionStatus().stopping, true);
    assert.equal(engine.executionStatus().settling, true);
    assert.throws(() => engine.retryRun(run.id), /stopping/i);
    assert.equal(runtime.calls.length, 1);
  } finally { stopped.resolve({ output: 'late cancelled result', threadId: 'stopped-thread' }); }
  await waitFor(() => engine.getRun(run.id).settled, 'cancelled agent acknowledges stop');
  assert.equal(engine.getRun(run.id).canRetry, true);
  const retry = engine.retryRun(run.id);
  await waitFor(() => engine.getRun(retry.id).settled, 'resumed run finishes');
  assert.equal(engine.getRun(retry.id).status, 'completed');
  assert.doesNotMatch(engine.getRun(retry.id).output, /late cancelled/);
  assert.equal(runtime.calls.length, 2);
});

test('resume rechecks the original workspace and direct desktop connection', async t => {
  const runtime = new FakeRuntime(async () => { throw new Error('retry me'); });
  const { engine, cwd } = await harness(t, runtime);
  let attached = true;
  engine.desktop = { status: () => ({ enabled: attached }) };
  const graph = workflow(); graph.nodes.find(item => item.type === 'agent').desktop = true;
  const run = engine.startRun({ workflow: graph, input: { task: 'desktop retry', cwd } });
  await waitFor(() => engine.getRun(run.id).settled, 'desktop failure settles');
  attached = false;
  assert.throws(() => engine.retryRun(run.id), /Attach the Windows desktop/);
  attached = true;
  runtime.status = () => ({ connected: false, authenticated: true, lastError: 'Codex connection interrupted' });
  assert.throws(() => engine.retryRun(run.id), /Codex connection interrupted/);
  assert.equal(runtime.calls.length, 1);
  assert.throws(() => engine.startRun({ workflow: workflow(), input: { task: 'bad workspace', cwd: {} } }), /Workspace folder must be a path/);
});

test('history recovers a valid backup and preserves a corrupt live snapshot', async t => {
  const { engine, cwd, dataDir, engines } = await harness(t);
  const run = engine.startRun({ workflow: workflow(), input: { task: 'recover history', cwd } });
  await waitFor(() => engine.getRun(run.id).settled, 'run settles before backup');
  await engine.close();
  await writeFile(path.join(dataDir, 'runs.json'), '{ interrupted write');
  const restored = new HarnessEngine({ runtime: new FakeRuntime(), dataDir, defaultCwd: cwd });
  engines.push(restored);
  await restored.init();
  assert.equal(restored.getRun(run.id).status, 'completed');
  assert.deepEqual(restored.storageStatus(), { healthy: true, error: null, recovered: ['runs.json'] });
  const preserved = (await readdir(dataDir)).find(name => name.startsWith('runs.json.corrupt-'));
  assert.ok(preserved);
  assert.equal(await readFile(path.join(dataDir, preserved), 'utf8'), '{ interrupted write');
});

test('storage failures are visible, preserve valid history and recover after the fault is removed', async t => {
  const { engine, dataDir } = await harness(t);
  const updates = []; const errors = [];
  engine.on('storage.updated', value => updates.push(value));
  engine.on('storage.error', error => errors.push(error));
  const before = await readFile(path.join(dataDir, 'runs.json'), 'utf8');
  const originalOpen = engine.snapshots.io.open;
  engine.snapshots.io = { ...engine.snapshots.io, open: async (file, ...args) => {
    if (file.startsWith(path.join(dataDir, 'runs.json.'))) throw Object.assign(new Error('Fixture storage device is full.'), { code: 'ENOSPC' });
    return originalOpen(file, ...args);
  } };
  engine.runs.set('storage-fixture', { id: 'storage-fixture', nodes: {}, events: [], status: 'completed' });
  try {
    await assert.rejects(engine.persist(), { code: 'ENOSPC' });
    assert.equal(engine.storageStatus().healthy, false);
    assert.ok(engine.storageStatus().error);
    assert.equal(errors.length, 1);
    assert.equal(updates[0].healthy, false);
    assert.equal(await readFile(path.join(dataDir, 'runs.json'), 'utf8'), before);
  } finally { engine.snapshots.io = { ...engine.snapshots.io, open: originalOpen }; }
  await engine.persist();
  assert.equal(engine.storageStatus().healthy, true);
  assert.equal(updates.at(-1).healthy, true);
});

test('unrecoverable corrupt history is preserved and reports a useful startup error', async t => {
  const { engine, cwd, dataDir } = await harness(t);
  await engine.close();
  await rm(path.join(dataDir, 'runs.json.bak'), { force: true });
  await writeFile(path.join(dataDir, 'runs.json'), 'not valid JSON');
  const restored = new HarnessEngine({ runtime: new FakeRuntime(), dataDir, defaultCwd: cwd });
  await assert.rejects(restored.init(), /Cannot load runs.json[^]*preserved/);
  assert.equal(await readFile(path.join(dataDir, 'runs.json'), 'utf8'), 'not valid JSON');
});

test('models declaring no tool support receive an explicit limitation and persist an empty attached catalog', async t => {
  const runtime = new FakeRuntime(async options => {
    assert.equal(options.dynamicTools, undefined); assert.equal(options.onToolCall, undefined);
    assert.match(options.prompt, /Plain chat model does not support tools/);
    assert.match(options.prompt, /clearly say it was not performed/);
    assert.match(options.prompt, /Never claim to browse, edit, post or execute anything without tools/);
    assert.match(options.developerInstructions, /ACTUAL ATTACHED CATALOG\n\[\]/);
    return { output: 'This model cannot edit files because it has no tool support.', threadId: 'plain-no-tools' };
  });
  runtime.status = () => ({ connected: true, authenticated: true, defaultModel: 'plain::text', models: [{ id: 'plain::text', displayName: 'Plain chat model', supportsTools: false }, { id: 'other::tools', supportsTools: true }] });
  const { engine, dataDir, cwd, engines } = await harness(t, runtime);
  const run = engine.startRun({ workflow: workflow(), input: 'Update the local project files.' });
  await waitFor(() => engine.getRun(run.id).settled, 'text-only model settles');
  const saved = engine.getRun(run.id).nodes.agent;
  assert.deepEqual(saved.toolNames, []); assert.equal(saved.toolCapability.available, false); assert.equal(saved.toolCapability.model, 'plain::text');
  await engine.close();
  const restored = await new HarnessEngine({ runtime: new FakeRuntime(), dataDir, defaultCwd: cwd }).init(); engines.push(restored);
  assert.deepEqual(restored.getRun(run.id).nodes.agent.toolCapability, saved.toolCapability);
  assert.deepEqual(restored.getRun(run.id).nodes.agent.toolNames, []);
});

test('tool result failures and recovery remain auditable after engine persistence and event history removal', async t => {
  const runtime = new FakeRuntime(async ({ onEvent }) => {
    onEvent({ type: 'tool.result', tool: 'relay_connections', action: 'call', integration: 'browseros-neo', callId: 'failed-browser', operationKey: 'fixture-operation', status: 'failed', success: false, code: 'MCP_FAILURE', message: 'The site rejected the action.' });
    onEvent({ type: 'tool.result', tool: 'relay_connections', action: 'call', integration: 'browseros-neo', callId: 'recovered-browser', operationKey: 'fixture-operation', status: 'completed', success: true });
    onEvent({ type: 'tool.result', tool: 'relay_workspace', action: 'read', callId: 'missing-file', status: 'failed', success: false, code: 'ENOENT', message: 'The requested fixture file was not found.' });
    return { output: 'The browser recovered; the requested file was not found.', threadId: 'tool-results-fixture' };
  });
  const { engine, dataDir, cwd, engines } = await harness(t, runtime);
  const run = engine.startRun({ workflow: workflow(), input: 'Inspect fixture state.' });
  await waitFor(() => engine.getRun(run.id).settled, 'tool outcomes settle');
  const summary = structuredClone(engine.getRun(run.id).nodes.agent.toolSummary);
  assert.equal(summary.failed, 2); assert.equal(summary.completed, 1); assert.equal(summary.issues.length, 2);
  assert.equal(summary.issues[0].resolved, true); assert.equal(summary.issues[1].resolved, false); assert.equal(summary.issues[1].code, 'ENOENT');
  engine.runs.get(run.id).events = []; await engine.persist(); await engine.close();
  const restored = await new HarnessEngine({ runtime: new FakeRuntime(), dataDir, defaultCwd: cwd }).init(); engines.push(restored);
  assert.deepEqual(restored.getRun(run.id).nodes.agent.toolSummary, summary);
  assert.equal(restored.getRun(run.id).events.some(event => event.data?.type === 'tool.result'), false);
});

for (const throws of [false, true]) test(`unavailable contained browser records an issue without starting external browsers (${throws ? 'thrown transport error' : 'readiness receipt'})`, async t => {
  const attempts = [], runtime = new FakeRuntime();
  const connections = { list: () => [], redact: value => String(value), refreshSignedBrowser: async options => {
    attempts.push(options); if (throws) throw new Error('BrowserOS Neo sidecar is unavailable.');
    return { available: false, reason: 'BrowserOS Neo sidecar is unavailable.' };
  } };
  const { engine, dataDir, cwd, engines } = await harness(t, runtime, { connections });
  const events = []; engine.on('event', event => events.push(event));
  const run = engine.startRun({ workflow: workflow(), input: 'Create a LinkedIn post using the browser.' });
  await waitFor(() => engine.getRun(run.id).settled, 'browser readiness failure settles');
  assert.equal(attempts.length, 0, 'Engine prompt setup does not attach browsers before an explicit tool call.');
  const issue = engine.getRun(run.id).nodes.agent.capabilityIssues[0];
  assert.equal(issue.available, false); assert.equal(issue.tool, 'Contained browser'); assert.match(issue.message, /contained BLACKICE browser is unavailable/i);
  assert.match(issue.message, /do not connect or launch an external browser/);
  assert.ok(events.some(event => event.type === 'agent.event' && event.data?.type === 'capability' && event.data.available === false));
  assert.ok(runtime.calls[0].dynamicTools.some(tool => tool.name === 'relay_connections'), 'other supported connection tools remain attached');
  assert.match(runtime.calls[0].prompt, /All website work stays in the contained BLACKICE relay_browser/);
  assert.match(runtime.calls[0].prompt, /other external browser adapters are not task fallbacks/);
  assert.deepEqual(runtime.calls[0].dynamicTools.find(tool => tool.name === 'relay_connections').inputSchema.properties.action.enum, ['connections', 'tools', 'call']);
  await engine.close();
  const restored = await new HarnessEngine({ runtime: new FakeRuntime(), dataDir, defaultCwd: cwd }).init(); engines.push(restored);
  assert.deepEqual(restored.getRun(run.id).nodes.agent.capabilityIssues, [issue]);
});

test('continuations validate revised agent instructions and deliver them on the saved provider thread', async t => {
  const { engine, runtime } = await harness(t), first = engine.startRun({ workflow: workflow(), input: 'Original task.' });
  await engine.executions.get(first.id);
  const initialCount=engine.runs.size;
  for(const prompt of [null,42,'',' ','x'.repeat(40001)]) assert.throws(
    ()=>engine.continueRun(first.id,{nodeId:'agent',message:'Continue.',prompt}),
    /agent instructions/i);
  assert.equal(engine.runs.size,initialCount,'invalid instructions are rejected before admission');
  assert.equal(runtime.calls.length,1);
  const prompt='CURRENT_MARKER: Use the revised task instructions and preserve confirmed work.';
  const request={requestId:'revised-instructions',nodeId:'agent',message:'Continue once.',prompt};
  const next=engine.continueRun(first.id,request);
  assert.equal(engine.continueRun(first.id,request).id,next.id);
  for(const changed of [{prompt:'DIFFERENT_MARKER'},{prompt:undefined}]) assert.throws(
    ()=>engine.continueRun(first.id,{...request,...changed}),{code:'RUN_REQUEST_CONFLICT'});
  await engine.executions.get(next.id);
  assert.equal(next.taskId,first.taskId);
  assert.equal(next.workflow.nodes.find(node=>node.id==='agent').prompt,prompt);
  assert.equal(engine.getRun(first.id).workflow.nodes.find(node=>node.id==='agent').prompt,'AGENT_MARKER');
  assert.equal(runtime.calls[1].threadId,'fake-thread');
  assert.ok(runtime.calls[1].prompt.includes(prompt));
  const omitted={requestId:'saved-instructions',nodeId:'agent',message:'Keep the saved instructions.'};
  const third=engine.continueRun(next.id,omitted);
  assert.throws(()=>engine.continueRun(next.id,{...omitted,prompt}),{code:'RUN_REQUEST_CONFLICT'});
  await engine.executions.get(third.id);
  assert.equal(runtime.calls[2].threadId,'fake-thread');
  assert.ok(runtime.calls[2].prompt.includes(prompt));
  assert.equal(runtime.calls.length,3);
});
