import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';
import { AgentEmailStore } from '../lib/agent-email.mjs';
import { RemoteAccessManager } from '../lib/remote-access.mjs';
import { createRemoteTransportFixture } from './fixtures/remote-transport.mjs';
import { recordFixturePlan } from './fixture-task-plan.mjs';

class Runtime extends EventEmitter {
  status() { return { connected: true, authenticated: true, models: [{ model: 'awareness-http-fixture' }], defaultModel: 'awareness-http-fixture' }; }
  async start() { return this.status(); }
  async close() {}
  async runAgent(options) {
    await recordFixturePlan(options);
    return { output: 'The local HTTP fixture task completed.', threadId: 'awareness-http-thread' };
  }
}
class Desktop extends EventEmitter {
  status() { return { available: false, enabled: false }; }
  async setEnabled() { return this.status(); }
}

function requestAt(target, route, { method = 'GET', headers = {}, body } = {}) {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: target.port, path: route, method, agent: false,
      headers: { Host: target.host, ...(encoded === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }), ...headers },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let value; try { value = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, value });
      });
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('Fixture HTTP request timed out.')));
    req.on('error', reject); req.end(encoded);
  });
}

async function waitFor(read, message, timeout = 5000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = read(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function fixture(t, { remote = false, emailEnabled = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-planning-awareness-http-')), dataDir = path.join(root, 'data');
  await mkdir(dataDir);
  const transport = createRemoteTransportFixture(), manager = new RemoteAccessManager({ dataDir, transport: transport.transport, defaultHttpsPort: 8443 }), streams = new Set();
  let app, cliCalls = 0;
  t.after(async () => {
    for (const close of streams) close();
    try { await app?.close(); assert.equal(cliCalls, 0, 'The fixture must never access a real mailbox or CLI.'); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const email = emailEnabled ? await new AgentEmailStore({ dataDir, runner: async () => { cliCalls++; throw new Error('No mailbox CLI is available in this fixture.'); } }).init() : null;
  app = await createHarnessServer({ port: 0, dataDir, defaultCwd: path.join(root, 'workspace'), runtime: new Runtime(), desktop: new Desktop(), email, remoteAccess: manager, autoAttachDesktop: false });
  await app.learning.updateSettings({ mode: 'manual' });
  const url = new URL(await app.listen()), localTarget = { port: Number(url.port), host: url.host };
  const page = await requestAt(localTarget, '/'); assert.equal(page.status, 200);
  const cookie = page.headers['set-cookie'][0].split(';')[0];
  const local = (route, { authenticated = true, headers = {}, ...options } = {}) => requestAt(localTarget, route, { ...options, headers: { ...(authenticated ? { Cookie: cookie } : {}), ...headers } });
  if (remote) await manager.enable();
  const remoteTarget = () => ({ port: manager.gateway.port, host: new URL(manager.status().url).host });
  const remoteRequest = (route, options) => requestAt(remoteTarget(), route, options);
  async function browser(label) {
    const issued = manager.pair(), response = await remoteRequest('/remote/pair', { method: 'POST', headers: { Origin: manager.status().url }, body: { code: issued.code, label } });
    assert.equal(response.status, 200, response.text);
    return { device: response.value.device, headers: { Cookie: response.headers['set-cookie'][0].split(';')[0], Origin: manager.status().url } };
  }
  async function events({ remote: outside = false, headers = {} } = {}) {
    const target = outside ? remoteTarget() : localTarget, route = outside ? '/api/agent/events' : '/api/events', received = [];
    return new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port: target.port, path: route, agent: false, headers: { Host: target.host, ...(outside ? {} : { Cookie: cookie }), ...headers } }, res => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`Fixture event stream returned ${res.statusCode}.`)); return; }
        let buffered = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          buffered += chunk;
          const frames = buffered.split(/\r?\n\r?\n/); buffered = frames.pop();
          for (const frame of frames) {
            const data = frame.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
            if (data) received.push(JSON.parse(data));
          }
        });
        res.on('error', () => {});
        const close = () => { req.destroy(); res.destroy(); streams.delete(close); };
        streams.add(close); resolve({ received, close });
      });
      req.on('error', reject);
    });
  }
  const workflow = { id: 'awareness-http-flow', name: 'Planning awareness fixture', nodes: [
    { id: 'input', type: 'input', name: 'Task' },
    { id: 'agent', type: 'agent', name: 'Fixture worker', prompt: 'Complete the local fixture task.', model: 'awareness-http-fixture' },
    { id: 'output', type: 'output', name: 'Result' },
  ], edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }], settings: { maxParallel: 1 } };
  const started = await local('/api/runs', { method: 'POST', body: { workflow, input: 'Exercise shared Planning HTTP awareness.' } });
  assert.equal(started.status, 201, started.text);
  const run = await waitFor(() => { const current = app.engine.getRun(started.value.id); return current.settled ? current : null; }, 'The fixture run did not settle.', 7000);
  assert.equal(run.status, 'completed', run.error);
  await app.conversations.chain;
  const taskId = run.taskId || run.id, state = await app.tasks.get(taskId), stepId = state.steps.find(step => step.kind === 'action')?.id;
  assert.ok(stepId, 'The actual task tool should have created an actionable saved plan.');
  return { root, app, manager, local, remote: remoteRequest, browser, events, taskId, stepId, state, run, route: `/api/tasks/${taskId}/plan` };
}

test('local presence endpoints require the session, accept only a node lease, and never write saved plan bytes or worker receipts', async t => {
  const f = await fixture(t), before = await readFile(f.app.tasks.file(f.taskId));
  const initial = await f.local(f.route + '/awareness'); assert.equal(initial.status, 200);
  assert.equal(initial.value.revision, f.state.revision); assert.equal(initial.value.leaseMs, 20000);
  assert.equal(initial.value.workers.length, 1); assert.equal(initial.value.workers[0].runId, f.run.id);
  assert.equal(initial.value.workers[0].status, 'completed'); assert.ok(initial.value.workers[0].lastReadRevision >= 1);
  assert.equal((await f.local(f.route + '/awareness', { authenticated: false })).status, 401);
  assert.equal((await f.local(f.route + '/presence', { authenticated: false, method: 'POST', body: { editorId: 'editor', stepId: f.stepId } })).status, 401);
  assert.equal((await f.local(f.route + '/presence', { method: 'POST', headers: { Origin: 'https://unrelated.example' }, body: { editorId: 'editor', stepId: f.stepId } })).status, 403);
  const posted = await f.local(f.route + '/presence', { method: 'POST', body: { editorId: 'editor', stepId: f.stepId } });
  assert.equal(posted.status, 200, posted.text); assert.equal(posted.value.presence.length, 1);
  assert.equal(posted.value.presence[0].stepId, f.stepId);
  assert.deepEqual(posted.value.presence[0].actor, { type: 'local-human', id: 'local-user', name: 'Local user' });
  assert.ok(Date.parse(posted.value.presence[0].expiresAt) > Date.now());
  for (const injected of [{ text: 'An unsaved draft must not be accepted.' }, { actor: { type: 'human-client', id: 'other-human' } }, { label: 'Forged label' }, { lastReadRevision: f.state.revision }, { workerId: initial.value.workers[0].id }]) {
    assert.equal((await f.local(f.route + '/presence', { method: 'POST', body: { editorId: 'editor', stepId: f.stepId, ...injected } })).status, 400);
  }
  assert.equal((await f.local(f.route + '/presence', { method: 'POST', body: { editorId: 'editor', stepId: 'missing-step' } })).status, 404);
  const released = await f.local(f.route + '/presence', { method: 'DELETE', body: { editorId: 'editor' } });
  assert.equal(released.status, 200); assert.deepEqual(released.value.presence, []);
  assert.deepEqual(released.value.workers, initial.value.workers);
  assert.deepEqual(await readFile(f.app.tasks.file(f.taskId)), before);
});

test('paired human leases retain verified identity while read and planning-write agent credentials cannot impersonate editors or acknowledge workers', async t => {
  const f = await fixture(t, { remote: true }), first = await f.browser('First plan reviewer'), second = await f.browser('Second plan reviewer');
  const created = await f.remote(f.route + '/presence', { method: 'POST', headers: { ...first.headers, 'X-Blackice-Client-Id': second.device.id, 'X-Blackice-Forward': 'forged' }, body: { editorId: 'same-editor-id', stepId: f.stepId } });
  assert.equal(created.status, 200, created.text);
  assert.deepEqual(created.value.presence[0].actor, { type: 'human-client', id: first.device.id, name: 'First plan reviewer' });
  assert.equal(created.value.presence[0].label, 'First plan reviewer');
  const otherRelease = await f.remote(f.route + '/presence', { method: 'DELETE', headers: second.headers, body: { editorId: 'same-editor-id' } });
  assert.equal(otherRelease.status, 200); assert.equal(otherRelease.value.presence.length, 1);
  const secondLease = await f.remote(f.route + '/presence', { method: 'POST', headers: second.headers, body: { editorId: 'same-editor-id', stepId: null } });
  assert.equal(secondLease.status, 200); assert.equal(secondLease.value.presence.length, 2);
  const firstRelease = await f.remote(f.route + '/presence', { method: 'DELETE', headers: first.headers, body: { editorId: 'same-editor-id' } });
  assert.equal(firstRelease.status, 200); assert.equal(firstRelease.value.presence.length, 1);
  assert.equal(firstRelease.value.presence[0].actor.id, second.device.id);
  const workerReceipts = firstRelease.value.workers;
  for (const scopes of [['read'], ['read', 'planning:write']]) {
    const agent = await f.manager.createAgent({ label: 'Outside fixture client', scopes }), headers = { Authorization: 'Bearer ' + agent.token };
    const read = await f.remote(`/api/agent/tasks/${f.taskId}`, { headers });
    assert.equal(read.status, 200, read.text); assert.equal(read.value.planningAwareness.revision, read.value.revision);
    assert.equal(read.value.planningAwareness.presence[0].actor.id, second.device.id);
    assert.deepEqual(read.value.planningAwareness.workers, workerReceipts);
    for (const method of ['POST', 'DELETE']) {
      const spoof = await f.remote(f.route + '/presence', { method, headers, body: { editorId: 'same-editor-id', ...(method === 'POST' ? { stepId: f.stepId } : {}) } });
      assert.equal(spoof.status, 403); assert.equal(spoof.value.code, 'REMOTE_AGENT_ROUTE_REQUIRED');
      assert.equal((await f.remote(`/api/agent/tasks/${f.taskId}/plan/presence`, { method, headers, body: { editorId: 'spoof' } })).status, 404);
    }
    assert.equal((await f.remote(`/api/agent/tasks/${f.taskId}?lastReadRevision=${f.state.revision}`, { headers })).status, 400);
    const edit = await f.remote(`/api/agent/tasks/${f.taskId}/plan`, { method: 'POST', headers, body: { expectedRevision: read.value.revision, operations: [{ type: 'update', stepId: f.stepId, patch: { note: 'An authorized outside fixture client saved this correction.' } }] } });
    assert.equal(edit.status, scopes.includes('planning:write') ? 200 : 403, edit.text);
    if (edit.status === 200) assert.equal(edit.value.revision, read.value.revision + 1);
  }
  const final = await f.local(f.route + '/awareness');
  assert.equal(final.value.presence.length, 1); assert.deepEqual(final.value.workers, workerReceipts);
  assert.equal(f.app.engine.getRun(f.run.id).status, 'completed');
});

test('human presence and saved plan changes reach real local and outside-agent event streams as compact invalidations', async t => {
  const f = await fixture(t, { remote: true }), agent = await f.manager.createAgent({ label: 'Fixture event reader', scopes: ['read'] });
  const local = await f.events(), outside = await f.events({ remote: true, headers: { Authorization: 'Bearer ' + agent.token } });
  await waitFor(() => local.received.some(event => event.type === 'runtime.status'), 'Local event stream did not initialize.');
  await waitFor(() => outside.received.some(event => event.type === 'ready'), 'Outside event stream did not initialize.');
  const posted = await f.local(f.route + '/presence', { method: 'POST', body: { editorId: 'live-editor', stepId: f.stepId } });
  assert.equal(posted.status, 200);
  const localPresence = await waitFor(() => local.received.find(event => event.type === 'planning.awareness' && event.data?.taskId === f.taskId), 'The local presence event was not forwarded.');
  const outsidePresence = await waitFor(() => outside.received.find(event => event.type === 'planning.awareness' && event.taskId === f.taskId), 'The outside presence event was not forwarded.');
  assert.deepEqual(localPresence.data, { taskId: f.taskId });
  assert.deepEqual(Object.keys(outsidePresence).sort(), ['at', 'taskId', 'type']);
  const saved = await f.local(f.route + '/edit', { method: 'POST', body: { expectedRevision: f.state.revision, operations: [{ type: 'update', stepId: f.stepId, patch: { note: 'The saved fixture correction stays in the task read.' } }] } });
  assert.equal(saved.status, 200, saved.text);
  const change = await waitFor(() => outside.received.find(event => event.type === 'planning.updated' && event.taskId === f.taskId && event.revision === saved.value.revision), 'The outside saved-plan event was not forwarded.');
  assert.equal(change.state, undefined); assert.ok(!JSON.stringify(change).includes('saved fixture correction'));
  assert.ok(!JSON.stringify(outsidePresence).includes('live-editor'));
  local.close(); outside.close();
  await f.app.close(); assert.equal(f.app.tasks.awareness.listeners.size, 0);
});

test('awareness respects chat visibility and maintenance while existing leases can be released from Trash', async t => {
  const f = await fixture(t);
  assert.equal((await f.local('/api/tasks/unavailable-task/plan/awareness')).status, 404);
  assert.equal((await f.local('/api/tasks/unavailable-task/plan/presence', { method: 'POST', body: { editorId: 'editor', stepId: null } })).status, 404);
  assert.equal((await f.local(`/api/conversations/${f.run.id}/archive`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await f.local(f.route + '/presence', { method: 'POST', body: { editorId: 'archived-editor', stepId: f.stepId } })).status, 200);
  assert.equal((await f.local(`/api/conversations/${f.run.id}/delete`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await f.local(f.route + '/awareness')).status, 200);
  assert.equal((await f.local(f.route + '/presence', { method: 'POST', body: { editorId: 'trash-editor', stepId: f.stepId } })).status, 409);
  const released = await f.local(f.route + '/presence', { method: 'DELETE', body: { editorId: 'archived-editor' } });
  assert.equal(released.status, 200); assert.deepEqual(released.value.presence, []);
  assert.equal((await f.local(`/api/conversations/${f.run.id}/restore`, { method: 'POST', body: {} })).status, 200);
  await f.app.beginMaintenance();
  assert.equal((await f.local(f.route + '/awareness')).status, 200);
  for (const method of ['POST', 'DELETE']) assert.equal((await f.local(f.route + '/presence', { method, body: { editorId: 'maintenance-editor', ...(method === 'POST' ? { stepId: f.stepId } : {}) } })).status, 503);
  f.app.endMaintenance();
  assert.equal((await f.local(f.route + '/awareness')).value.revision, f.state.revision);
});

test('retired built-in email routes fail closed locally and for paired browsers without invoking a mailbox CLI', async t => {
  const f = await fixture(t, { remote: true, emailEnabled: false }), paired = await f.browser('Paired browser');
  assert.equal(f.app.email, null, 'No built-in email runtime is started.');
  const routes = [
    ['/api/email', 'GET'],
    ['/api/email/oauth/status', 'GET'],
    ['/api/email/drafts', 'POST'],
    ['/api/email/action', 'POST'],
    ['/api/email/config', 'PUT'],
    ['/api/email/oauth/begin', 'POST'],
  ];
  for (const [route, method] of routes) {
    const options = { method, ...(method === 'GET' ? {} : { body: {} }) };
    const local = await f.local(route, options);
    assert.equal(local.status, 410, route+' must reject a retired built-in adapter');
    assert.equal(local.value.code, 'EMAIL_RETIRED');
    const remote = await f.remote(route, { ...options, headers: paired.headers });
    assert.ok([400,403,404,410].includes(remote.status),route+' must remain unavailable through a paired browser');
    assert.equal(remote.status === 200 || remote.status === 201,false,'Remote mail operations must not be accepted');
  }
});
