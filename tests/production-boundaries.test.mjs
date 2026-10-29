import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';

const SECRET = 'PRIVATE_SUPPORT_BOUNDARY_MARKER';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const until = async (check, label = 'production boundary condition') => { const deadline = Date.now() + 5000; while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail(`${label} did not settle`); };
const workflow = () => ({ id: 'production-boundary', name: `Workflow ${SECRET}`, nodes: [{ id: 'input', type: 'input' }, { id: 'agent', type: 'agent', name: 'Agent', model: 'fixture-model', prompt: `Private instructions ${SECRET}` }, { id: 'output', type: 'output' }], edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }], settings: { maxParallel: null, planningMode: 'off' } });

async function fixture(t, { hold = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-production-boundaries-')), dataDir = path.join(directory, 'data'), cwd = path.join(directory, 'workspace');
  const calls = [], waiting = [], apps = [], effects = { browser: 0, desktop: 0, reconnects: 0 }; let app, url, cookie, runtime;
  class Runtime extends EventEmitter {
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture-model', models: [{ model: 'fixture-model' }], providers: [{ id: SECRET, name: SECRET, apiKey: SECRET }], account: { email: `${SECRET}@example.invalid` }, lastError: `Hidden status ${SECRET}` }; }
    async start() { effects.reconnects++; if (this.reconnectError) throw this.reconnectError; return this.status(); }
    async runAgent(options) {
      calls.push(options); const threadId = `fixture-thread-${calls.length}`;
      options.onEvent?.({ type: 'thread', threadId, turnId: `fixture-turn-${calls.length}`, model: 'fixture-model' });
      options.onEvent?.({ type: 'delta', delta: `Chat ${SECRET}` });
      options.onEvent?.({ type: 'item', item: { type: 'dynamicToolCall', id: 'private-tool', name: 'private_tool', arguments: { token: SECRET, path: path.join(cwd, SECRET), prompt: SECRET }, status: 'inProgress' } });
      if (hold) {
        const gate = deferred(); waiting.push(gate);
        await new Promise((resolve, reject) => { const stop = () => reject(Object.assign(new Error(`Stopped ${SECRET}`), { code: 'ABORT_ERR', name: 'AbortError' })); if (options.signal?.aborted) return stop(); options.signal?.addEventListener('abort', stop, { once: true }); gate.promise.then(() => { options.signal?.removeEventListener('abort', stop); resolve(); }); });
      }
      if (options.dynamicTools?.some(tool => tool.name === 'relay_learn')) await options.onToolCall({ name: 'relay_learn', arguments: { action: 'finish', summaryOfReview: 'Fixture review completed without changes.' } });
      return { output: `Reply ${SECRET}`, threadId };
    }
    async close() { for (const gate of waiting) gate.resolve(); }
  }
  class Desktop extends EventEmitter { status() { return { enabled: false, available: false, path: SECRET }; } async setEnabled() { return this.status(); } async perform() { effects.desktop++; return {}; } }
  class Browser extends EventEmitter { status() { return { available: false, tabs: [{ url: `https://${SECRET}.invalid/` }] }; } async perform() { effects.browser++; return {}; } async cancel() {} async close() {} }
  async function boot() {
    runtime = new Runtime(); app = await createHarnessServer({ port: 0, dataDir, defaultCwd: cwd, runtime, desktop: new Desktop(), browser: new Browser() }); apps.push(app);
    await app.learning.updateSettings({ mode: 'manual' }); url = await app.listen();
    const home = await fetch(url); cookie = home.headers.get('set-cookie').split(';', 1)[0]; await home.arrayBuffer();
    await until(() => effects.reconnects >= apps.length, 'initial provider startup'); return app;
  }
  await boot();
  t.after(async () => { for (const gate of waiting) gate.resolve(); for (const instance of apps) await instance.close(); assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.match(path.basename(directory), /^relay-production-boundaries-/); await rm(directory, { recursive: true, force: true }); });
  const request = (route, { method = 'GET', auth = true, body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(new URL(route, url), { method, headers: { ...(auth ? { Cookie: cookie } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...headers } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.on('end', () => { try { resolve({ status: response.statusCode, headers: response.headers, data: JSON.parse(text) }); } catch (error) { reject(error); } }); response.on('error', reject);
    }); req.setTimeout(5000, () => req.destroy(new Error('Boundary HTTP request timed out'))); req.on('error', reject); req.end(payload);
  });
  return { get app() { return app; }, get runtime() { return runtime; }, get url() { return url; }, get cookie() { return cookie; }, directory, dataDir, cwd, calls, waiting, effects, request, start: () => request('/api/runs', { method: 'POST', body: { workflow: workflow(), input: `User task ${SECRET}` } }), async restart() { await app.close(); return boot(); } };
}

test('actual support HTTP export omits chat, path, tool, account and malicious error contents while active work continues', async t => {
  const context = await fixture(t, { hold: true }), { app, runtime, request, effects, calls } = context;
  const admitted = await context.start(); assert.equal(admitted.status, 201); await until(() => calls.length === 1);
  runtime.emit('error', Object.assign(new Error(`Bearer ${SECRET}; Cookie=${SECRET}; ${context.directory}`), { code: SECRET, stack: `PRIVATE STACK ${SECRET}`, token: SECRET }));
  runtime.reconnectError = Object.assign(new Error(`API path ${context.directory}; prompt ${SECRET}`), { code: SECRET });
  const failed = await request('/api/runtime/reconnect', { method: 'POST', body: {} }); assert.equal(failed.status, 400); assert.match(failed.data.error, new RegExp(SECRET));
  const before = { ...effects }, snapshot = await request('/api/diagnostics/export');
  assert.equal(snapshot.status, 200); assert.equal(snapshot.data.format, 'relay-support'); assert.match(snapshot.data.application.version, /^\d+\.\d+\.\d+$/);
  assert.equal(snapshot.data.counts.activeRuns, 1); assert.equal(snapshot.data.counts.savedRuns, 1); assert.equal(snapshot.data.counts.providers, 1);
  assert.ok(snapshot.data.events.some(event => event.component === 'runtime' && event.code === 'UNKNOWN_ERROR'));
  assert.ok(snapshot.data.events.some(event => event.component === 'server' && event.event === 'request_failed' && event.code === 'UNKNOWN_ERROR'));
  const serialized = JSON.stringify(snapshot.data);
  for (const privateValue of [SECRET, context.directory, context.cwd, context.url, context.cookie, 'PRIVATE STACK', 'private_tool']) assert.ok(!serialized.includes(privateValue), privateValue);
  assert.deepEqual(effects, before, 'export must not reconnect providers or invoke desktop/browser actions'); assert.equal(calls.length, 1);
  assert.equal(app.engine.getRun(admitted.data.id).settled, false);
  context.waiting[0].resolve(); await until(() => app.engine.getRun(admitted.data.id).settled);
  assert.equal(app.engine.getRun(admitted.data.id).status, 'completed');
});

test('support export enforces local session, Host and Origin boundaries and repeated exports never start agent work', async t => {
  const context = await fixture(t), { request, calls, effects } = context;
  assert.equal((await request('/api/diagnostics/export', { auth: false })).status, 401);
  assert.equal((await request('/api/diagnostics/export', { headers: { Cookie: 'relay_session_invalid=bad' } })).status, 401);
  assert.equal((await request('/api/diagnostics/export', { headers: { Host: 'unrelated.invalid' } })).status, 403);
  assert.equal((await request('/api/diagnostics/export', { headers: { Origin: 'https://unrelated.invalid' } })).status, 403);
  assert.equal((await request('/api/diagnostics/export', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const before = { ...effects };
  const results = await Promise.all([request('/api/diagnostics/export'), request('/api/diagnostics/export')]);
  assert.ok(results.every(result => result.status === 200 && result.data.counts.activeRuns === 0)); assert.equal(calls.length, 0); assert.deepEqual(effects, before);
});

test('support lifecycle metadata survives a real server restart without exporting local session or error text', async t => {
  const context = await fixture(t); await context.app.diagnostics.recordError('server', 'request_failed', Object.assign(new Error(SECRET), { code: 'ENOSPC' }));
  const first = await context.request('/api/diagnostics/export');
  const event = first.data.events.find(item => item.code === 'ENOSPC'); assert.ok(event);
  const oldCookie = context.cookie; await context.restart(); assert.notEqual(context.cookie, oldCookie);
  const restored = await context.request('/api/diagnostics/export'); assert.equal(restored.status, 200);
  assert.ok(restored.data.events.some(item => item.at === event.at && item.code === 'ENOSPC'));
  assert.ok(restored.data.events.some(item => item.component === 'server' && item.event === 'stopped'));
  assert.ok(!JSON.stringify(restored.data).includes(SECRET)); assert.ok(!JSON.stringify(restored.data).includes(oldCookie));
  assert.equal((await context.request('/api/diagnostics/export', { headers: { Cookie: oldCookie } })).status, 401); assert.equal(context.calls.length, 0);
});

test('maintenance refuses an actual running chat and an actual learning review before setting its admission latch', async t => {
  const context = await fixture(t, { hold: true }), { app } = context;
  const admitted = await context.start(); await until(() => context.calls.length === 1);
  await assert.rejects(app.beginMaintenance(), error => error.status === 409 && /active work/.test(error.message)); assert.notEqual(app.engine.maintenanceRequested, true);
  context.waiting[0].resolve(); await until(() => app.engine.getRun(admitted.data.id).settled);
  app.learning.delayMs = 60000; await app.learning.learnNow(admitted.data.id); const reviewWork = app.learning.pump();
  await until(() => app.learning.active && context.calls.length === 2);
  await assert.rejects(app.beginMaintenance(), error => error.status === 409 && /active work/.test(error.message)); assert.notEqual(app.engine.maintenanceRequested, true);
  context.waiting[1].resolve(); await reviewWork;
  assert.equal(app.learning.active, null); assert.equal(app.learning.listReviews()[0].status, 'no_changes');
});

test('maintenance atomically blocks direct engine and delayed HTTP admission, rejects duplicate calls and keeps queues paused after release', async t => {
  const context = await fixture(t), { app, request } = context;
  await app.inbox.add({ input: 'Passive queued fixture', cwd: context.cwd, workflow: workflow() });
  const paused = deferred(), releasePause = deferred(), originalPause = app.inbox.pause.bind(app.inbox); let pauseCalls = 0;
  app.inbox.pause = async (...args) => { pauseCalls++; const saved = await originalPause(...args); paused.resolve(); await releasePause.promise; return saved; };
  const payload = JSON.stringify({ workflow: workflow(), input: 'Request whose body was already in flight.' }), received = deferred();
  app.server.once('request', incoming => { if (incoming.url === '/api/runs') received.resolve(); });
  let pendingRequest;
  const inFlight = new Promise((resolve, reject) => { pendingRequest = http.request(new URL('/api/runs', context.url), { method: 'POST', headers: { Cookie: context.cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, response => { let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(text) })); }); pendingRequest.on('error', reject); pendingRequest.write(payload.slice(0, 1)); });
  inFlight.catch(() => {}); await received.promise;
  const maintenance = app.beginMaintenance(); maintenance.catch(() => {}); await paused.promise;
  try {
    assert.equal(app.engine.maintenanceRequested, true);
    await assert.rejects(app.beginMaintenance(), error => error.status === 409); assert.equal(pauseCalls, 1);
    assert.throws(() => app.engine.startRun({ workflow: workflow(), input: 'Direct bypass must not run.' }), { status: 503, code: 'PROFILE_MAINTENANCE' });
    const blocked = await Promise.all([context.start(), context.start()]); assert.ok(blocked.every(response => response.status === 503));
    pendingRequest.end(payload.slice(1)); const delayed = await inFlight; assert.equal(delayed.status, 503);
    assert.equal((await request('/api/diagnostics/export')).status, 200); assert.equal(context.calls.length, 0); assert.equal(app.engine.listRuns().length, 0);
    releasePause.resolve(); await maintenance; assert.equal(app.inbox.status().paused, true); assert.equal(app.operations.status().paused, true);
    app.endMaintenance(); app.endMaintenance(); assert.equal(app.engine.maintenanceRequested, false);
    assert.equal(app.inbox.status().paused, true); assert.equal(app.operations.status().paused, true);
    const started = await context.start(); assert.equal(started.status, 201); await until(() => app.engine.getRun(started.data.id).settled); assert.equal(context.calls.length, 1);
    assert.equal(app.inbox.snapshot().items[0].status, 'queued', 'releasing maintenance does not authorize running saved work');
  } finally { releasePause.resolve(); pendingRequest.end(); app.inbox.pause = originalPause; app.endMaintenance(); }
});

test('maintenance rejects valid webhook deliveries before they mutate durable jobs', async t => {
  const context = await fixture(t), { app, request } = context;
  const deployment = await app.operations.create({ name: 'Fixture webhook', input: 'Do not dispatch during maintenance.', cwd: context.cwd, workflow: workflow(), enabled: true, trigger: { type: 'webhook' } });
  const token = app.operations.getWebhook(deployment.id).token; await app.beginMaintenance();
  const before = await readFile(path.join(context.dataDir, 'operations.json'), 'utf8');
  const deliveries = await Promise.all(['one', 'two'].map(key => request(`/hooks/${deployment.id}`, { method: 'POST', auth: false, headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': key }, body: { private: SECRET } })));
  assert.ok(deliveries.every(result => result.status === 503)); assert.equal(await readFile(path.join(context.dataDir, 'operations.json'), 'utf8'), before);
  assert.equal(context.calls.length, 0); assert.equal(app.operations.snapshot().jobs.length, 0); assert.equal((await request('/api/diagnostics/export')).status, 200);
  app.endMaintenance(); assert.equal(app.operations.status().paused, true);
});

test('a queued learning review cannot start while maintenance pause writes are still settling', async t => {
  const context = await fixture(t), { app } = context;
  const first = await context.start(); await until(() => app.engine.getRun(first.data.id).settled);
  app.learning.delayMs = 60000; const review = await app.learning.learnNow(first.data.id); assert.equal(review.status, 'queued');
  const paused = deferred(), release = deferred(), original = app.inbox.pause.bind(app.inbox);
  app.inbox.pause = async (...args) => { const value = await original(...args); paused.resolve(); await release.promise; return value; };
  const maintenance = app.beginMaintenance(); await paused.promise;
  try { await app.learning.pump(); assert.equal(app.learning.active, null); assert.equal(app.learning.getReview(review.id).status, 'queued'); assert.equal(context.calls.length, 1); }
  finally { release.resolve(); await maintenance; app.inbox.pause = original; app.endMaintenance(); }
});
