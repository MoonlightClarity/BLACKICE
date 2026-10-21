import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { HarnessEngine } from '../lib/engine.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';
import { CodexRuntime } from '../lib/codex.mjs';
import { TaskStateStore } from '../lib/task-state.mjs';
import { DESKTOP_TOOL } from '../lib/desktop-tools.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const pending = async promise => assert.equal(await Promise.race([promise.then(() => 'settled', () => 'settled'), delay(60, 'pending')]), 'pending');
const admitted = (entered, work) => Promise.race([entered.promise, work.then(() => { throw new Error('The turn finished before the fixture callback was admitted.'); })]);
const until = async predicate => { const deadline = Date.now() + 4000; while (!predicate()) { assert.ok(Date.now() < deadline, 'The bounded fixture reached its expected state.'); await delay(5); } };
const nativeFixture = fileURLToPath(new URL('./fixtures/fake-app-server.mjs', import.meta.url));
const repository = fileURLToPath(new URL('..', import.meta.url));
const callReply = calls => ({ choices: [{ message: { content: null, tool_calls: calls.map(([id, name, args]) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
const finalReply = text => ({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
const graph = (model, planningMode = 'auto') => ({ id: 'settlement-fixture', name: 'Tool settlement', nodes: [{ id: 'input', type: 'input' }, { id: 'agent', type: 'agent', model, prompt: 'Exercise only the controlled fixture.' }, { id: 'output', type: 'output' }], edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }], settings: { planningMode, maxParallel: 1 } });

class OfflineNative extends EventEmitter {
  status() { return { connected: false, authenticated: false, models: [] }; }
  async close() {}
}

async function apiFixture(t, respond) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-tool-settlement-')), cwd = path.join(directory, 'workspace'), dataDir = path.join(directory, 'data');
  await fs.mkdir(cwd);
  const releases = [], requests = [], cleanups = [];
  const runtime = await new ProviderRuntime({ codex: new OfflineNative(), dataDir, fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    return new Response(JSON.stringify(await respond(request, requests)), { headers: { 'content-type': 'application/json' } });
  } }).init();
  await runtime.saveProvider({ id: 'fixture', type: 'compatible', baseUrl: 'http://127.0.0.1:43199/v1', models: ['primary', 'independent'] });
  t.after(async () => {
    for (const release of releases) release();
    for (const close of cleanups) await close();
    await runtime.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.match(path.basename(directory), /^blackice-tool-settlement-/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, cwd, dataDir, runtime, requests, cleanups, hold() { const held = deferred(); releases.push(held.resolve); return held; } };
}

test('API Stop keeps a real pending patch leased, preserves its late receipt, and lets an independent chat finish', async t => {
  let primaryRequests = 0;
  const f = await apiFixture(t, request => {
    if (request.model === 'independent') return finalReply('Independent conversation completed.');
    if (++primaryRequests === 1) return callReply([['plan-read', 'relay_task', { action: 'read' }]]);
    if (primaryRequests === 2) {
      const state = JSON.parse(request.messages.findLast(message => message.role === 'tool').content);
      return callReply([['plan-write', 'relay_task', { action: 'plan', expectedRevision: state.revision, plan: { layout: 'sequence', detail: 'balanced' }, steps: [{ id: 'patch', kind: 'action', title: 'Apply the fixture patch', status: 'active', doneWhen: 'The saved patch receipt and target bytes agree.' }] }]]);
    }
    if (primaryRequests === 3) return callReply([
      ['held-patch', 'relay_workspace', { action: 'patch', path: 'result.txt', oldText: 'before', newText: 'confirmed patch' }],
      ['must-not-start', 'relay_workspace', { action: 'write', path: 'after-stop.txt', text: 'This later operation must not run.' }],
    ]);
    return finalReply('Continuation after actual tool settlement.');
  });
  const tasks = await new TaskStateStore({ dataDir: f.dataDir }).init(), engine = await new HarnessEngine({ runtime: f.runtime, tasks, dataDir: f.dataDir, defaultCwd: f.cwd, maxConcurrentRuns: 2 }).init();
  f.cleanups.push(() => engine.close(), () => tasks.close());
  const file = path.join(f.cwd, 'result.txt'), entered = deferred(), release = f.hold(); await fs.writeFile(file, 'before');
  engine.filePatches.io = { ...fs, rename: async (from, to) => { if (to === file) { entered.resolve(); await release.promise; } return fs.rename(from, to); } };
  const first = engine.startRun({ workflow: graph('fixture::primary'), input: 'Apply the controlled patch once.' }), execution = engine.executions.get(first.id);
  await admitted(entered, execution);
  const initial = engine.getRun(first.id), threadId = initial.nodes.agent.threadId;
  assert.equal(initial.nodes.agent.planning.status, 'recorded', 'The real gateway recorded the current-turn plan before the patch.');
  engine.cancelRun(first.id); await pending(execution);
  assert.equal(engine.getRun(first.id).settled, false); assert.equal(engine.executionStatus().activeCount, 1); assert.equal(engine.executionStatus().availableSlots, 1); assert.equal(engine.executionStatus().stopping, true);
  assert.equal(engine.filePatches.pending.size, 1); assert.equal(await fs.readFile(file, 'utf8'), 'before');
  assert.throws(() => engine.continueRun(first.id, { nodeId: 'agent', message: 'Do not overlap the pending patch.' }), { code: 'CHAT_BUSY' });
  assert.throws(() => engine.retryRun(first.id), { code: 'CHAT_BUSY' });
  await assert.rejects(f.runtime.runAgent({ cwd: f.cwd, model: 'fixture::primary', prompt: 'Direct resume must also wait.', threadId }), { code: 'THREAD_BUSY' });
  await assert.rejects(f.runtime.compactThread(threadId), { code: 'THREAD_BUSY' });
  const sibling = engine.startRun({ workflow: graph('fixture::independent', 'off'), input: 'An independent controlled reply.' });
  await engine.executions.get(sibling.id);
  assert.equal(engine.getRun(sibling.id).status, 'completed'); assert.equal(engine.executionStatus().activeCount, 1); assert.equal(engine.executionStatus().availableSlots, 1); assert.equal(f.runtime.active.has(threadId), true);
  release.resolve(); await execution;
  const stopped = engine.getRun(first.id);
  assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.settled, true); assert.equal(stopped.output, ''); assert.equal(stopped.nodes.agent.output, '');
  assert.equal(stopped.nodes.agent.usage.totalTokens, 15); assert.equal(await fs.readFile(file, 'utf8'), 'confirmed patch');
  await assert.rejects(fs.stat(path.join(f.cwd, 'after-stop.txt')), { code: 'ENOENT' });
  const actual = stopped.events.find(event => event.data?.type === 'tool.result' && event.data.callId === 'held-patch');
  assert.equal(actual.data.success, true); assert.equal(actual.data.duringSettlement, true);
  const item = stopped.events.find(event => event.data?.item?.id === 'held-patch' && event.data.item.status === 'completed');
  const receipt = JSON.parse(item.data.item.contentItems[0].text);
  assert.equal(receipt.status, 'applied'); assert.equal(receipt.path, file); assert.equal((await engine.filePatches.get(receipt.id)).afterHash, receipt.afterHash);
  const transcript = await f.runtime.readThread(threadId);
  assert.equal(JSON.parse(transcript.messages.find(message => message.tool_call_id === 'held-patch').content).afterHash, receipt.afterHash);
  assert.match(transcript.messages.find(message => message.tool_call_id === 'must-not-start').content, /interrupted/);
  assert.equal(transcript.pendingToolCalls, undefined); assert.equal(primaryRequests, 3, 'Stop starts no further provider request.');
  const continued = engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue after the original callback settled.', planningMode: 'off' }); await engine.executions.get(continued.id);
  assert.equal(engine.getRun(continued.id).status, 'completed'); assert.equal(engine.getRun(continued.id).nodes.agent.threadId, threadId);
  assert.equal(engine.executionStatus().activeCount, 0); assert.equal(engine.filePatches.pending.size, 0);
});

for (const outcome of ['confirmed', 'failed']) test(`API close drains an admitted callback and retains its actual ${outcome} result`, async t => {
  const f = await apiFixture(t, () => callReply([['close-tool', 'held_tool', {}]])), entered = deferred(), release = f.hold(), events = [];
  const work = f.runtime.runAgent({ cwd: f.cwd, model: 'fixture::primary', prompt: 'Hold only the local fixture callback.', dynamicTools: [{ type: 'function', name: 'held_tool', description: 'Controlled held callback', inputSchema: { type: 'object', properties: {} } }], onEvent: event => events.push(event), onToolCall: async () => {
    entered.resolve(); await release.promise;
    if (outcome === 'failed') throw Object.assign(new Error('The admitted callback reported its actual failure.'), { code: 'FIXTURE_FAILURE' });
    return { success: true, contentItems: [{ type: 'inputText', text: 'The admitted callback confirmed this result.' }] };
  } });
  work.catch(() => {}); await admitted(entered, work);
  const closing = f.runtime.close(), secondClose = f.runtime.close();
  await pending(closing); await pending(work); await pending(secondClose); assert.equal(f.runtime.active.size, 1);
  release.resolve(); await assert.rejects(work, { code: 'ABORT_ERR' }); await closing; await secondClose;
  assert.equal(f.runtime.active.size, 0); assert.equal(f.requests.length, 1); assert.equal(events.some(event => event.type === 'turn' && event.status === 'completed'), false);
  const receipt = events.find(event => event.type === 'tool.result' && event.callId === 'close-tool');
  assert.equal(receipt.success, outcome === 'confirmed'); assert.equal(receipt.duringSettlement, true);
  if (outcome === 'failed') assert.equal(receipt.code, 'FIXTURE_FAILURE');
  const record = await f.runtime.readThread(events.find(event => event.type === 'thread').threadId);
  assert.match(record.messages.find(message => message.tool_call_id === 'close-tool').content, outcome === 'confirmed' ? /confirmed this result/ : /actual failure/);
});

for (const ending of ['cancel', 'cancel-with-failure', 'exit', 'exit-then-close', 'close', 'cancel-after-completion', 'close-after-completion', 'timeout-after-completion']) test(`native ${ending} retains a held dynamic callback until its result settles`, async t => {
  const client = new CodexRuntime({ command: process.execPath, args: [nativeFixture], cwd: repository, requestTimeoutMs: 3000, runTimeoutMs: null }), entered = deferred(), release = deferred(), events = [], sent = [];
  t.after(async () => { release.resolve(); await client.close(); });
  const send = client._send.bind(client); client._send = message => { sent.push({ child: client.child, message }); return send(message); };
  const controller = new AbortController();
  const work = client.runAgent({ cwd: repository, model: 'fixture-model', prompt: 'DYNAMIC_TOOL', signal: controller.signal, ...(ending === 'timeout-after-completion' ? { timeoutMs: 500 } : {}), dynamicTools: [DESKTOP_TOOL], onEvent: event => events.push(event), onToolCall: async (_call, context) => {
    entered.resolve(); await release.promise; assert.equal(context.signal.aborted, true);
    if (ending === 'cancel-with-failure') throw Object.assign(new Error('The held callback reported its actual failure.'), { code: 'FIXTURE_FAILURE' });
    return { success: true, contentItems: [{ type: 'inputText', text: 'Confirmed held callback result.' }, { type: 'inputImage', imageUrl: 'data:image/png;base64,PRIVATE_FIXTURE_PIXELS' }] };
  } });
  work.catch(() => {}); await admitted(entered, work);
  const threadId = events.find(event => event.type === 'thread').threadId, oldChild = client.child; let closing;
  if (ending.endsWith('-after-completion')) {
    // A protocol completion notification is not local callback settlement.
    const state = client.threads.get(threadId);
    client._notification('turn/completed', { threadId, turn: { id: state.turnId, status: 'completed', items: [] } });
    assert.equal(state.done, true); await pending(work);
  }
  if (ending === 'timeout-after-completion') await until(() => client.threads.get(threadId)?.cancelError?.code === 'CODEX_RUN_TIMEOUT');
  else if (ending.startsWith('cancel')) { controller.abort(); await until(() => client.threads.get(threadId)?.done); }
  else if (ending.startsWith('exit')) { oldChild.kill(); await until(() => !client.status().connected); if (ending === 'exit-then-close') closing = client.close(); }
  else { closing = client.close(); await until(() => !client.status().connected); }
  await pending(work); assert.equal(client.status().activeTurns, 1); assert.equal(client.threads.has(threadId), true);
  if (closing) { await pending(closing); await pending(client.close()); }
  if (ending.startsWith('cancel') || ending === 'timeout-after-completion') {
    await assert.rejects(client.runAgent({ cwd: repository, prompt: 'Resume must wait.', threadId }), { code: 'THREAD_BUSY' });
    const sibling = await client.runAgent({ cwd: repository, prompt: 'Independent native conversation.' });
    assert.match(sibling.output, /Independent native conversation/); assert.equal(client.status().activeTurns, 1); assert.equal(client.child, oldChild);
    assert.equal(events.some(event => ['delta', 'message'].includes(event.type)), false, 'The interruption reply is not an accepted assistant answer.');
  } else if (ending === 'exit') {
    await client.start(); assert.notEqual(client.child, oldChild);
    await assert.rejects(client.runAgent({ cwd: repository, prompt: 'Old callback still owns this thread.', threadId }), { code: 'THREAD_BUSY' });
  }
  release.resolve(); await assert.rejects(work, { code: ending.startsWith('exit') ? 'CODEX_DISCONNECTED' : ending === 'timeout-after-completion' ? 'CODEX_RUN_TIMEOUT' : 'ABORT_ERR' }); if (closing) await closing;
  assert.equal(client.status().activeTurns, 0);
  const actual = events.find(event => event.type === 'tool.result' && event.duringSettlement);
  assert.equal(actual.success, ending !== 'cancel-with-failure');
  if (ending === 'cancel-with-failure') assert.equal(actual.code, 'FIXTURE_FAILURE');
  const item = events.find(event => event.type === 'item' && event.duringSettlement);
  assert.match(item.item.contentItems[0].text, ending === 'cancel-with-failure' ? /actual failure/ : /Confirmed held callback result/); assert.doesNotMatch(JSON.stringify(item), /PRIVATE_FIXTURE_PIXELS/);
  const replies = sent.filter(entry => entry.message.id === actual.callId && !entry.message.method);
  if (ending.startsWith('cancel') || ending === 'timeout-after-completion') {
    assert.equal(replies.length, 1); assert.equal(replies[0].child, oldChild); assert.equal(replies[0].message.result.success, ending !== 'cancel-with-failure');
    const continued = await client.runAgent({ cwd: repository, prompt: 'READ_PRIOR', threadId }); assert.equal(continued.threadId, threadId);
  } else assert.equal(replies.length, 0, 'A late callback cannot write its response on a dead or replacement connection.');
});

test('native ignores stale turn-object notifications without completing or replacing a resumed turn', async t => {
  const client = new CodexRuntime({ runTimeoutMs: null, spawnImpl() { throw new Error('No process is allowed in this protocol fixture.'); } });
  client.child = {}; Object.assign(client.info, { connected: true, authenticated: true, models: [], defaultModel: 'fixture' });
  client._request = async (method, params) => {
    if (method === 'thread/resume') return { thread: { id: params.threadId }, model: 'fixture' };
    if (method === 'turn/start') return { turn: { id: 'current-turn', status: 'inProgress' } };
    if (method === 'thread/unsubscribe') return {};
    throw new Error(`Unexpected protocol fixture request: ${method}`);
  };
  t.after(() => { client.closing = true; client._connectionFailed(Object.assign(new Error('Fixture closed.'), { code: 'CODEX_CLOSED' }), client.child); });
  const work = client.runAgent({ cwd: repository, prompt: 'The current continuation.', threadId: 'fixture-thread', model: 'fixture' }); work.catch(() => {});
  await until(() => client.threads.get('fixture-thread')?.turnId === 'current-turn');
  const state = client.threads.get('fixture-thread');
  client._notification('turn/started', { threadId: 'fixture-thread', turn: { id: 'old-stopped-turn', status: 'inProgress' } });
  assert.equal(state.turnId, 'current-turn', 'A stale started notification cannot replace this continuation’s turn ID.');
  client._notification('turn/completed', { threadId: 'fixture-thread', turn: { id: 'old-stopped-turn', status: 'completed', items: [{ id: 'old-answer', type: 'agentMessage', text: 'Stale answer from the stopped turn.' }] } });
  await pending(work); assert.equal(client.threads.get('fixture-thread'), state); assert.equal(state.done, false);
  client._notification('turn/completed', { threadId: 'fixture-thread', turn: { id: 'current-turn', status: 'completed', items: [{ id: 'current-answer', type: 'agentMessage', text: 'The current continuation completed.' }] } });
  const result = await work;
  assert.equal(result.turnId, 'current-turn'); assert.equal(result.output, 'The current continuation completed.'); assert.equal(client.threads.size, 0);
});
