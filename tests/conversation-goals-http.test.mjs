import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';

const graph = {
  id: 'goal-http-flow', name: 'Goal HTTP fixture',
  nodes: [{ id: 'input', type: 'input', name: 'Task' }, { id: 'agent', type: 'agent', name: 'Agent', prompt: 'Do the task' }, { id: 'output', type: 'output', name: 'Result' }],
  edges: [{ id: 'one', source: 'input', target: 'agent' }, { id: 'two', source: 'agent', target: 'output' }],
  settings: { maxParallel: 1, planningMode: 'off' },
};
const until = async (check, label = 'Goal HTTP condition') => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 5)); }
  assert.fail(label + ' did not settle.');
};
class Runtime extends EventEmitter {
  constructor({ hold = false } = {}) { super(); this.calls = []; this.hold = hold; }
  status() { return { connected: true, authenticated: true, defaultModel: 'goal-fixture-model', activeTurns: 0 }; }
  async start() { return this.status(); }
  async runAgent(options) {
    this.calls.push(options);
    options.onEvent?.({ type: 'thread', threadId: 'goal-http-thread' });
    if (this.hold) await new Promise(resolve => {
      if (options.signal.aborted) return resolve();
      options.signal.addEventListener('abort', resolve, { once: true });
    });
    return { output: 'Recorded one concrete fixture step. More work remains.', threadId: 'goal-http-thread' };
  }
  async close() {}
}
async function fixture(t, runtime = new Runtime()) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-goal-http-'));
  const options = { runtime, port: 0, dataDir: path.join(directory, 'data'), defaultCwd: path.join(directory, 'workspace'), remoteAccess: false };
  const app = await createHarnessServer(options);
  const url = await app.listen();
  await app.learning.updateSettings({ mode: 'manual' });
  const home = await fetch(url);
  const cookie = home.headers.get('set-cookie').split(';')[0];
  const request = async (route, body, authenticated = true, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(url + route, { method, headers: { ...(authenticated ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text(); let data = text; try { data = JSON.parse(text); } catch {}
    return { status: response.status, data };
  };
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, options, runtime, request };
}
const input = (objective, maxTurns = null) => ({ workflow: graph, input: { task: objective, directoryMode: 'off', planningMode: 'off', goal: { objective, maxTurns } } });

test('goal API is authenticated, revision checked, and survives a closed server without losing the objective', async t => {
  const { app, options, runtime, request } = await fixture(t, new Runtime({ hold: true }));
  const created = await request('/api/runs', input('Complete the saved artifact and verify all three sections.'));
  assert.equal(created.status, 201, JSON.stringify(created.data));
  await until(() => runtime.calls.length === 1);
  const route = '/api/conversations/' + created.data.id + '/goal';
  assert.equal((await request(route, undefined, false)).status, 401);
  const current = await request(route);
  assert.equal(current.status, 200);
  assert.equal(current.data.goal.objective, 'Complete the saved artifact and verify all three sections.');
  assert.equal(current.data.goal.maxTurns, null);
  const paused = await request(route, { action: 'pause', expectedRevision: current.data.goal.revision, requestId: 'pause-http-goal' });
  assert.equal(paused.status, 200, JSON.stringify(paused.data));
  assert.equal(paused.data.goal.status, 'paused');
  const stale = await request(route, { action: 'update', objective: 'Stale replacement', expectedRevision: current.data.goal.revision, requestId: 'stale-http-goal' });
  assert.equal(stale.status, 409, JSON.stringify(stale.data));
  assert.equal((await request(route)).data.goal.objective, current.data.goal.objective);
  assert.equal((await request(route, {}, true, 'DELETE')).status, 405);
  await app.close();
  const restored = await createHarnessServer({ ...options, runtime: new Runtime() });
  try {
    const goal = await restored.goals.get(created.data.id);
    assert.equal(goal.objective, current.data.goal.objective);
    assert.equal(goal.status, 'paused');
    assert.equal(restored.runtime.calls.length, 0);
  } finally { await restored.close(); }
});

test('a requested turn budget drives automatic continuation in one conversation and then settles', async t => {
  const { app, runtime, request } = await fixture(t);
  const created = await request('/api/runs', input('Keep working on the same fixture until it is verified.', 2));
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const route = '/api/conversations/' + created.data.id + '/goal';
  const goal = await until(async () => {
    const { data } = await request(route);
    return data.goal && !['active', 'running', 'waiting'].includes(data.goal.status) && data.goal;
  }, 'budgeted goal');
  assert.equal(goal.turns, 2);
  assert.ok(runtime.calls.length >= 2);
  const family = await app.conversations.family(created.data.id);
  assert.ok(family.runs.length >= 2);
  assert.equal(app.conversations.list('all').length, 1);
  assert.ok(family.runs.every(run => (run.taskId || run.id) === (created.data.taskId || created.data.id)));
  assert.equal(app.engine.executionStatus().activeRunCount, 0);
  const stoppedAt = runtime.calls.length;
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(runtime.calls.length, stoppedAt);
});

test('invalid goal input cannot admit an ordinary run accidentally', async t => {
  const { app, runtime, request } = await fixture(t);
  const before = app.engine.listRuns().length;
  const rejected = await request('/api/runs', input(''));
  assert.equal(rejected.status, 400, JSON.stringify(rejected.data));
  assert.equal(app.engine.listRuns().length, before);
  assert.equal(runtime.calls.length, 0);
  assert.equal((await request('/next/chat/goals.mjs')).status, 200);
});

test('a human reply holds automatic dispatch while conversation history is still being read', async t => {
  const { app, runtime, request } = await fixture(t);
  app.goals.delay = 80;
  const created = await request('/api/runs', input('Finish a persistent goal while accepting user steering.', 6));
  assert.equal(created.status, 201);
  await until(() => app.engine.getRun(created.data.id).settled === true);
  const original = app.conversations.family.bind(app.conversations);
  let release, entered, blockNext = true;
  const gate = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { entered = resolve; });
  app.conversations.family = async id => {
    if (blockNext && id === created.data.id) { blockNext = false; entered(); await gate; }
    return original(id);
  };
  let reply;
  try {
    const pending = request('/api/runs/' + created.data.id + '/continue', { nodeId: 'agent', message: 'Human steering takes priority over the next automatic step.', requestId: 'manual-goal-priority' });
    await reading;
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(runtime.calls.length, 1, 'automatic work must wait behind the already submitted human reply');
    release();
    reply = await pending;
    assert.equal(reply.status, 201, JSON.stringify(reply.data));
    await until(() => runtime.calls.length >= 2);
    await app.goals.pauseAll('HTTP fixture finished.');
    assert.match(runtime.calls[1].prompt, /Human steering takes priority/);
    assert.equal(runtime.calls.length, 2);
  } finally {
    release(); app.conversations.family = original;
    await app.goals.pauseAll('HTTP fixture cleanup.');
  }
});
