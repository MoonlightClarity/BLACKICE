import test from 'node:test';
import { recordFixturePlan } from './fixture-task-plan.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const waitFor = async (condition, label = 'condition') => {
  const until = Date.now() + 4000;
  while (Date.now() < until) { const value = condition(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`${label} did not become ready`);
};
const decode = result => { assert.equal(result.success, true); return JSON.parse(result.contentItems[0].text); };
const tool = (name, arguments_) => ({ name, arguments: arguments_ });

class FakeRuntime extends EventEmitter {
  constructor(execute = async options => ({ output: 'Fixture result', threadId: options.threadId || 'fixture-thread' })) { super(); this.execute = execute; this.calls = []; this.steers = []; }
  status() { return { connected: true, authenticated: true, defaultModel: 'fixture-model', activeTurns: 0 }; }
  async start() { return this.status(); }
  async close() {}
  async runAgent(options) { this.calls.push(options); return this.execute(options, this.calls.length); }
  async steerAgent(threadId, message) { this.steers.push({ threadId, message }); return { accepted: true, threadId, turnId: 'fixture-turn' }; }
}
class NoDesktop extends EventEmitter {
  status() { return { available: false, enabled: false }; }
  async setEnabled() { return this.status(); }
}

const graph = {
  id: 'session-flow', name: 'Session integration',
  nodes: [
    { id: 'input', type: 'input', name: 'Task' },
    { id: 'alpha', type: 'agent', name: 'Alpha', prompt: 'ALPHA_MARKER' },
    { id: 'beta', type: 'agent', name: 'Beta', prompt: 'BETA_MARKER' },
    { id: 'output', type: 'output', name: 'Result' },
  ],
  edges: [{ source: 'input', target: 'alpha' }, { source: 'input', target: 'beta' }, { source: 'alpha', target: 'output' }, { source: 'beta', target: 'output' }],
  settings: { maxParallel: 2 },
};
const singleAgentGraph = () => ({ ...structuredClone(graph), nodes: graph.nodes.filter(node => node.id !== 'beta'), edges: graph.edges.filter(edge => edge.source !== 'beta' && edge.target !== 'beta') });

async function application(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-session-test-'));
  const dataDir = path.join(directory, 'data'), cwd = path.join(directory, 'project-a'), otherCwd = path.join(directory, 'project-b');
  await mkdir(otherCwd, { recursive: true });
  const runtime = options.runtime || new FakeRuntime();
  const app = await createHarnessServer({ runtime, desktop: new NoDesktop(), dataDir, defaultCwd: cwd, port: 0, ...options });
  const url = await app.listen();
  let closed = false;
  const close = async () => { if (!closed) { await app.close(); closed = true; } };
  t.after(async () => {
    await close();
    await app.knowledge.writeChain.catch(() => {});
    assert.match(path.basename(directory), /^relay-session-test-/);
    await rm(directory, { recursive: true, force: true });
  });
  const target = new URL(url);
  const request = (route, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: target.hostname, port: target.port, path: route, method, headers: { ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...headers } }, res => {
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString();
        let data = text;
        if (String(res.headers['content-type']).includes('application/json')) { try { data = JSON.parse(text); } catch (error) { reject(error); return; } }
        resolve({ status: res.statusCode, headers: res.headers, data });
      });
      res.on('error', reject);
    });
    req.setTimeout(4000, () => req.destroy(new Error('Session HTTP request timed out')));
    req.on('error', reject); req.end(payload);
  });
  const home = await request('/');
  const auth = { Cookie: home.headers['set-cookie'][0].split(';', 1)[0] };
  const api = (route, options = {}) => request(route, { ...options, headers: { ...auth, ...options.headers } });
  const settled = id => waitFor(() => { const value = app.engine.getRun(id); return value.settled && value; }, 'settled run');
  return { app, runtime, request, api, auth, cwd, otherCwd, dataDir, close, settled };
}

test('HTTP continuation preserves its original snapshot and resumes only the chosen saved conversation', async t => {
  let plans = Promise.resolve();
  const runtime = new FakeRuntime(async options => {
    // The two initial agents share one durable task revision. Serialize only
    // their fixture outline writes, keeping the actual parallel run unchanged.
    await (plans = plans.then(() => recordFixturePlan(options, { title: 'Retain this agent’s saved conversation', doneWhen: 'Continuation resumes only the selected agent and preserves the original run snapshot.' })));
    const selected = options.prompt.includes('ALPHA_MARKER');
    return { output: options.threadId ? 'Refined result' : selected ? 'Alpha result' : 'Beta result', threadId: options.threadId || (selected ? 'alpha-thread' : 'beta-thread'), usage: { totalTokens: 20, total: { totalTokens: options.threadId ? 40 : 20 } } };
  });
  const { api, settled, app } = await application(t, { runtime });
  assert.equal((await api('/api/runtime/settings', { method: 'POST', body: { codexHistory: 'codex' } })).status, 200);
  const initial = await api('/api/runs', { method: 'POST', body: { workflow: graph, input: 'Original task' } });
  assert.equal(initial.status, 201);
  const original = await settled(initial.data.id);
  assert.equal(original.status, 'completed', original.error);
  const savedOriginal = structuredClone(original);
  const callsBefore = runtime.calls.length;
  // Mutating the saved editor draft must not change the original conversation snapshot.
  const modified = structuredClone(graph); modified.nodes.find(node => node.id === 'alpha').prompt = 'CHANGED_EDITOR_INSTRUCTIONS';
  assert.equal((await api('/api/workflows', { method: 'POST', body: modified })).status, 200);
  const response = await api(`/api/runs/${original.id}/continue`, { method: 'POST', body: { nodeId: 'alpha', message: 'Refine the result using the prior context.' } });
  assert.equal(response.status, 201);
  const continued = await settled(response.data.id);
  assert.equal(continued.status, 'completed');
  assert.equal(continued.kind, 'continuation');
  assert.equal(continued.workflowId, graph.id);
  assert.equal(continued.parentRunId, original.id);
  assert.deepEqual(continued.continuedFrom, { runId: original.id, nodeId: 'alpha', threadId: 'alpha-thread' });
  assert.deepEqual(continued.workflow.nodes.map(node => node.id), ['input', 'alpha', 'output']);
  assert.equal(continued.workflow.nodes.find(node => node.id === 'alpha').prompt, 'ALPHA_MARKER');
  assert.equal(runtime.calls.length, callsBefore + 1);
  assert.equal(runtime.calls.at(-1).threadId, 'alpha-thread');
  assert.deepEqual(runtime.calls.at(-1).usageBaseline, { totalTokens: 20 });
  assert.equal(runtime.calls.at(-1).cwd, original.cwd);
  assert.equal(continued.output, '[Alpha]\nRefined result');
  assert.deepEqual(app.engine.getRun(original.id), savedOriginal, 'follow-up never rewrites the original run or its metrics');
  assert.equal((await api(`/api/runs/${original.id}/continue`, { method: 'POST', body: { nodeId: 'output', message: 'Invalid target' } })).status, 400);
  assert.equal((await api('/api/runs/missing/continue', { method: 'POST', body: { nodeId: 'alpha', message: 'Unknown run' } })).status, 404);
});

test('HTTP directions target the working agent and capacity one retains cancellation until acknowledgement', async t => {
  const running = deferred(), release = deferred();
  const runtime = new FakeRuntime(async options => {
    options.onEvent({ type: 'turn', threadId: 'live-thread', turnId: 'fixture-turn' });
    running.resolve(options);
    return release.promise;
  });
  const { api, app, settled } = await application(t, { runtime, maxConcurrentRuns: 1 });
  const start = await api('/api/runs', { method: 'POST', body: { workflow: singleAgentGraph(), input: 'A working task' } });
  const options = await running.promise;
  try {
    const accepted = await api(`/api/runs/${start.data.id}/steer`, { method: 'POST', body: { nodeId: 'alpha', message: 'Use the corrected target.' } });
    assert.equal(accepted.status, 200);
    assert.deepEqual(runtime.steers, [{ threadId: 'live-thread', message: 'Use the corrected target.' }]);
    assert.equal((await api(`/api/runs/${start.data.id}/continue`, { method: 'POST', body: { nodeId: 'alpha', message: 'Premature continuation' } })).status, 409);
    assert.equal((await api(`/api/runs/${start.data.id}/cancel`, { method: 'POST', body: {} })).status, 200);
    assert.equal(options.signal.aborted, true);
    assert.equal((await api(`/api/runs/${start.data.id}/steer`, { method: 'POST', body: { nodeId: 'alpha', message: 'Too late' } })).status, 409);
    assert.equal(runtime.steers.length, 1);
    assert.equal((await api('/api/runs', { method: 'POST', body: { workflow: graph, input: 'Must wait' } })).status, 409);
    assert.equal((await api(`/api/runs/${start.data.id}/continue`, { method: 'POST', body: { nodeId: 'alpha', message: 'Must also wait' } })).status, 409);
    const status = await api('/api/status');
    assert.equal(status.data.execution.activeRunId, start.data.id);
    assert.equal(status.data.execution.stopping, true);
  } finally { release.resolve({ output: 'Discard this late output', threadId: 'live-thread' }); }
  const completed = await settled(start.data.id);
  assert.equal(completed.status, 'cancelled');
  assert.equal(completed.nodes.alpha.status, 'cancelled');
  assert.equal(completed.output, '');
  assert.ok(app.engine.getRun(start.data.id).events.some(event => event.data.type === 'steer'));
});

test('HTTP knowledge CRUD is authenticated, workspace-filtered, durable and records trusted user provenance', async t => {
  const { api, request, cwd, otherCwd, close, dataDir } = await application(t);
  const note = { id: 'project-note', kind: 'memory', title: 'Project convention', content: 'Use meaningful regression checks.', cwd, provenance: { source: 'agent', runId: 'spoofed-run' } };
  assert.equal((await request('/api/knowledge')).status, 401);
  assert.equal((await request('/api/knowledge', { method: 'POST', body: note })).status, 401);
  const saved = await api('/api/knowledge', { method: 'POST', body: note });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.revision, 1);
  assert.equal(saved.data.provenance.source, 'user');
  assert.equal(saved.data.provenance.runId, undefined, 'request body cannot forge agent provenance');
  await api('/api/knowledge', { method: 'POST', body: { kind: 'skill', title: 'Shared procedure', content: '# Verify\nRead before writing.', cwd: null } });
  await api('/api/knowledge', { method: 'POST', body: { kind: 'memory', title: 'Other project', content: 'Other project specific fact.', cwd: otherCwd } });
  const list = await api(`/api/knowledge?cwd=${encodeURIComponent(cwd)}`);
  assert.deepEqual(list.data.map(entry => entry.title).sort(), ['Project convention', 'Shared procedure']);
  assert.ok(list.data.every(entry => !Object.hasOwn(entry, 'content')));
  assert.equal((await api(`/api/knowledge?cwd=${encodeURIComponent(otherCwd)}&kind=memory`)).data.length, 1);
  const updated = await api('/api/knowledge', { method: 'POST', body: { ...note, content: 'Run focused checks before packaging.' } });
  assert.equal(updated.data.revision, 2);
  assert.equal(updated.data.createdAt, saved.data.createdAt);
  assert.equal((await api('/api/knowledge/project-note')).data.content, 'Run focused checks before packaging.');
  assert.equal((await api('/api/knowledge?limit=301')).status, 400);
  assert.equal((await api('/api/knowledge', { method: 'POST', body: { ...note, cwd: 'relative-workspace' } })).status, 400);
  await close();
  // Restart uses the same persisted store, not an in-memory fixture.
  const { KnowledgeStore } = await import('../lib/knowledge.mjs');
  const restarted = await new KnowledgeStore({ dataDir }).init();
  assert.equal(restarted.get('project-note').revision, 2);
  assert.equal(restarted.get('project-note').cwd, cwd);
  await restarted.remove('project-note');
  assert.throws(() => restarted.get('project-note'), { status: 404 });
});

test('attached agent tools read and write the actual scoped store with run provenance and bounded history', async t => {
  const observations = [];
  const runtime = new FakeRuntime(async options => {
    await recordFixturePlan(options, { title: 'Read and maintain the scoped knowledge store', doneWhen: 'Reads enforce workspace scope and saved entries retain actual run provenance.' });
    const attached = new Set(options.dynamicTools.map(spec => spec.name));
    for (const name of ['relay_history', 'relay_memory', 'relay_skills', 'relay_workspace']) assert.ok(attached.has(name), `${name} is attached to the agent`);
    const found = decode(await options.onToolCall(tool('relay_memory', { action: 'search', query: 'convention' })));
    observations.push(found);
    assert.equal(found.entries.length, 2, 'workspace search combines local and shared facts');
    assert.ok(found.entries.every(entry => !Object.hasOwn(entry, 'content')));
    const read = decode(await options.onToolCall(tool('relay_memory', { action: 'read', id: 'local-note' })));
    assert.equal(read.entry.content, 'Local convention body.');
    const remembered = decode(await options.onToolCall(tool('relay_memory', { action: 'remember', title: 'Verified fact', content: 'Checked from this workspace.' })));
    assert.equal(remembered.entry.provenance.source, 'agent');
    assert.equal(remembered.entry.provenance.nodeId, 'alpha');
    const skill = decode(await options.onToolCall(tool('relay_skills', { action: 'save', title: 'Check and package', content: '# Steps\nRun checks, inspect, package.' })));
    assert.equal(skill.entry.kind, 'skill');
    const history = decode(await options.onToolCall(tool('relay_history', { action: 'search' })));
    assert.equal(history.results.length, 0, 'active run is excluded from its own history');
    // A thrown mutation has no confirmed runtime receipt. Keep the expected
    // scope-denial checks after the intended writes; only read-only inspection
    // follows an uncertain dispatched attempt.
    await assert.rejects(options.onToolCall(tool('relay_memory', { action: 'forget', id: 'global-note' })), /global scope explicitly/);
    await assert.rejects(options.onToolCall(tool('relay_memory', { action: 'read', id: 'other-note' })), { status: 404 });
    return { output: 'Remembered and verified', threadId: 'knowledge-thread' };
  });
  const { api, app, cwd, otherCwd, settled } = await application(t, { runtime });
  for (const [id, selectedCwd, content] of [['local-note', cwd, 'Local convention body.'], ['global-note', null, 'Shared convention body.'], ['other-note', otherCwd, 'Other convention body.']]) {
    assert.equal((await api('/api/knowledge', { method: 'POST', body: { id, kind: 'memory', title: `${id} convention`, summary: 'A concise project convention.', content, cwd: selectedCwd } })).status, 200);
  }
  const started = await api('/api/runs', { method: 'POST', body: { workflow: singleAgentGraph(), input: 'Remember a checked fact and save a procedure.' } });
  const run = await settled(started.data.id);
  assert.equal(run.status, 'completed', run.error);
  assert.equal(observations.length, 1);
  const agentEntries = (await api('/api/knowledge')).data.filter(entry => entry.provenance.source === 'agent');
  assert.equal(agentEntries.length, 2);
  for (const metadata of agentEntries) {
    const entry = (await api(`/api/knowledge/${metadata.id}`)).data;
    assert.equal(entry.cwd, cwd);
    assert.equal(entry.provenance.runId, run.id);
    assert.equal(entry.provenance.nodeId, 'alpha');
    assert.equal(entry.provenance.source, 'agent');
  }
  assert.ok(runtime.calls[0].prompt.includes('local-note'));
  assert.ok(!runtime.calls[0].prompt.includes('other-note'));
  assert.ok(!runtime.calls[0].prompt.includes('Local convention body.'), 'catalog inserts metadata, full content requires a read');
  assert.deepEqual(app.engine.getRun(run.id).nodes.alpha.knowledgeCatalog.memories.map(entry => entry.id).sort(), ['global-note', 'local-note']);
  assert.ok(run.events.some(event => event.data.type === 'knowledge' && event.data.status === 'completed' && event.data.title === 'Verified fact'));
});

test('cancellation blocks late agent knowledge writes and queued store writes before they commit', async t => {
  const entered = deferred(), release = deferred();
  const runtime = new FakeRuntime(async options => { await recordFixturePlan(options, { title: 'Exercise cancellation of a queued knowledge save', doneWhen: 'Cancellation preserves the original entry and rejects late writes.' }); entered.resolve(options); return release.promise; });
  const { api, app, settled } = await application(t, { runtime });
  await api('/api/knowledge', { method: 'POST', body: { id: 'queued-agent-note', kind: 'memory', title: 'Prior fact', content: 'Must remain unchanged.', cwd: app.engine.defaultCwd } });
  const started = await api('/api/runs', { method: 'POST', body: { workflow: singleAgentGraph(), input: 'Await cancellation.' } });
  const active = await entered.promise;
  const blocker = deferred();
  // Hold the shared write queue to exercise the cancellation check at execution time,
  // after the callback accepted a valid request but before any storage mutation.
  const originalChain = app.knowledge.writeChain;
  app.knowledge.writeChain = originalChain.then(() => blocker.promise);
  const pending = active.onToolCall(tool('relay_memory', { action: 'remember', id: 'queued-agent-note', title: 'Queued fact', content: 'Must not commit.' }));
  pending.catch(() => {});
  try {
    await api(`/api/runs/${started.data.id}/cancel`, { method: 'POST', body: {} });
    blocker.resolve();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(active.onToolCall(tool('relay_memory', { action: 'remember', title: 'Late fact', content: 'Must not persist.' })), { name: 'AbortError' });
    assert.equal(app.knowledge.get('queued-agent-note').content, 'Must remain unchanged.');
    assert.equal(app.knowledge.get('queued-agent-note').revision, 1);
    assert.equal(app.knowledge.list().length, 1);
  } finally { blocker.resolve(); release.resolve({ output: 'Late output', threadId: 'cancelled-knowledge-thread' }); }
  assert.equal((await settled(started.data.id)).status, 'cancelled');
});

test('shutdown drains an admitted HTTP knowledge save and rejects new mutations while storage settles', async t => {
  const { api, app, cwd, dataDir, close } = await application(t);
  const entered = deferred(), release = deferred();
  const writeSnapshot = app.knowledge.writeSnapshot.bind(app.knowledge);
  app.knowledge.writeSnapshot = async (...args) => { entered.resolve(); await release.promise; return writeSnapshot(...args); };
  const pending = api('/api/knowledge', { method: 'POST', body: { id: 'closing-note', kind: 'memory', title: 'Closing fact', content: 'Save finishes before shutdown.', cwd } });
  pending.catch(() => {});
  await entered.promise;
  let finished = false;
  const closing = close().then(() => { finished = true; });
  try {
    const denied = await api('/api/knowledge', { method: 'POST', body: { kind: 'memory', title: 'Late save', content: 'Must not be admitted.' } });
    assert.equal(denied.status, 503);
    assert.equal(finished, false, 'shutdown must wait until the existing knowledge snapshot is durable');
  } finally { release.resolve(); }
  assert.equal((await pending).status, 200);
  await closing;
  const { KnowledgeStore } = await import('../lib/knowledge.mjs');
  const restored = await new KnowledgeStore({ dataDir }).init();
  assert.equal(restored.get('closing-note').content, 'Save finishes before shutdown.');
  assert.equal(restored.list().length, 1);
});

test('a mutation body opened before shutdown cannot enqueue a late knowledge write after shutdown begins', async t => {
  const { app, auth, close } = await application(t);
  const received = deferred(), closingEntered = deferred(), releaseClose = deferred();
  const engineClose = app.engine.close.bind(app.engine);
  app.engine.close = async () => { closingEntered.resolve(); await releaseClose.promise; return engineClose(); };
  const payload = JSON.stringify({ id: 'late-body-note', kind: 'memory', title: 'Late body', content: 'This body completes during shutdown.' });
  let pendingRequest;
  app.server.once('request', () => received.resolve());
  const response = new Promise((resolve, reject) => {
    pendingRequest = http.request({ hostname: '127.0.0.1', port: app.server.address().port, path: '/api/knowledge', method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode)); res.on('error', reject);
    });
    pendingRequest.setTimeout(4000, () => pendingRequest.destroy(new Error('Delayed body timed out')));
    pendingRequest.on('error', reject);
    pendingRequest.write(payload.slice(0, 1));
  });
  response.catch(() => {});
  await received.promise;
  const closing = close();
  await closingEntered.promise;
  try {
    pendingRequest.end(payload.slice(1));
    assert.equal(await response, 503, 'shutdown must be checked after body parsing, not only when headers arrive');
    assert.throws(() => app.knowledge.get('late-body-note'), { status: 404 });
  } finally { releaseClose.resolve(); }
  await closing;
});
