import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rmdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';
import { recordFixturePlan } from './fixture-task-plan.mjs';

class FakeRuntime extends EventEmitter {
  status() { return { connected: true, authenticated: true, defaultModel: 'fixture-model', activeTurns: 0 }; }
  async start() { return this.status(); }
  async runAgent(options) {
    await recordFixturePlan(options);
    options.onEvent?.({ type: 'delta', delta: 'HTTP fixture output' });
    return { output: 'HTTP fixture output', threadId: 'http-fixture-thread' };
  }
  async close() {}
}
async function application(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-http-test-'));
  const app = await createHarnessServer({ runtime: new FakeRuntime(), port: 0, dataDir: path.join(directory, 'data'), defaultCwd: path.join(directory, 'workspace'), ...options });
  const url = await app.listen();
  t.after(async () => {
    await app.close();
    assert.match(path.basename(directory), /^relay-http-test-/);
    await rm(directory, { recursive: true, force: true });
  });
  const target = new URL(url);
  const request = (route, options = {}) => new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    const headers = { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
    if (payload !== undefined) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request({ hostname: target.hostname, port: target.port, path: route, method: options.method || 'GET', headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = text;
        if (String(res.headers['content-type']).includes('application/json')) {
          try { data = JSON.parse(text); } catch (error) { reject(error); return; }
        }
        resolve({ status: res.statusCode, headers: res.headers, text, data });
      });
      res.on('error', reject);
    });
    req.setTimeout(3000, () => req.destroy(new Error('HTTP QA request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
  const home = await request('/');
  assert.equal(home.status, 200);
  const setCookie = home.headers['set-cookie']?.[0];
  assert.ok(setCookie);
  const cookie = setCookie.split(';', 1)[0];
  return { app, url, request, home, cookie, auth: { Cookie: cookie } };
}
const graph = {
  id: 'http-test-flow', name: 'HTTP integration',
  nodes: [
    { id: 'input', type: 'input', name: 'Task' },
    { id: 'agent', type: 'agent', name: 'Agent', prompt: 'Read and report', sandbox: 'read-only' },
    { id: 'output', type: 'output', name: 'Result' },
  ],
  edges: [{ id: 'a', source: 'input', target: 'agent' }, { id: 'b', source: 'agent', target: 'output' }],
  settings: { maxParallel: 2 },
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const until = async (check, label = 'HTTP fixture condition') => { const deadline = Date.now() + 4000; while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail(`${label} did not settle`); };

test('execution settings API saves a user-selected limit, applies it live, and restores it after restart', async t => {
  const { app, request, auth } = await application(t), post = value => request('/api/execution/settings', { method: 'POST', headers: auth, body: value });
  assert.equal((await request('/api/execution/settings')).status, 401); assert.equal((await request('/api/execution/settings', { method: 'POST', body: { maxConcurrentRuns: 1 } })).status, 401);
  const initial = await request('/api/execution/settings', { headers: auth }); assert.equal(initial.status, 200); assert.deepEqual(initial.data, { maxConcurrentRuns: null });
  const saved = await post({ maxConcurrentRuns: 96 }); assert.equal(saved.status, 200); assert.deepEqual(saved.data, { maxConcurrentRuns: 96 });
  assert.equal((await request('/api/status', { headers: auth })).data.execution.capacity, 96);
  const dataDir = app.engine.dataDir, defaultCwd = app.engine.defaultCwd; assert.equal(JSON.parse(await readFile(path.join(dataDir, 'execution-settings.json'), 'utf8')).maxConcurrentRuns, 96); await app.close();
  const restored = await createHarnessServer({ runtime: new FakeRuntime(), port: 0, dataDir, defaultCwd });
  try { assert.equal(restored.engine.executionStatus().capacity, 96); assert.deepEqual(restored.engine.executionSettings(), { maxConcurrentRuns: 96 }); }
  finally { await restored.close(); }
});

test('execution settings API rejects invalid input and reports disk failures without applying changes', async t => {
  const { app, request, auth } = await application(t, { maxConcurrentRuns: 2 }), post = value => request('/api/execution/settings', { method: 'POST', headers: auth, body: value });
  for (const value of [{}, { maxConcurrentRuns: 0 }, { maxConcurrentRuns: -3 }, { maxConcurrentRuns: 2.5 }, { maxConcurrentRuns: '64' }, { maxConcurrentRuns: null, other: 1 }]) { const result = await post(value); assert.equal(result.status, 400); assert.equal(app.engine.executionStatus().capacity, 2); }
  const destination = path.join(app.engine.dataDir, 'execution-settings.json'); await mkdir(destination);
  const failed = await post({ maxConcurrentRuns: null }); assert.equal(failed.status, 500); assert.match(failed.data.error, /not saved/); assert.equal(app.engine.executionStatus().capacity, 2); assert.equal(app.engine.storageStatus().healthy, false);
  await rmdir(destination); const changed = await post({ maxConcurrentRuns: null }); assert.equal(changed.status, 200); assert.equal(app.engine.executionStatus().capacity, null); assert.equal(app.engine.storageStatus().healthy, true);
  const status = await request('/api/status', { headers: auth }); assert.equal(status.data.execution.unlimited, true); assert.equal(status.data.execution.availableSlots, null);
});

test('HTTP Stop all cancels every active chat, retains acknowledgement boundaries, and pauses queued starts', async t => {
  const holds = [deferred(), deferred(), deferred()], calls = [], runtime = new FakeRuntime();
  runtime.runAgent = async options => { await recordFixturePlan(options); const index = calls.length; calls.push(options); options.onEvent({ type: 'thread', threadId: `stop-all-thread-${index}` }); return holds[index].promise; };
  const { app, request, auth } = await application(t, { runtime, maxConcurrentRuns: 2 }); await app.learning.updateSettings({ mode: 'manual' });
  const post = (route, body = {}, authenticated = true) => request(route, { method: 'POST', headers: authenticated ? auth : {}, body });
  try {
    const first = await post('/api/runs', { workflow: graph, input: 'FIRST STOP ALL CHAT' }), second = await post('/api/runs', { workflow: graph, input: 'SECOND STOP ALL CHAT' });
    assert.equal(first.status, 201); assert.equal(second.status, 201); await until(() => calls.length === 2, 'both HTTP chats start');
    const queued = await post('/api/inbox/queue', { workflow: graph, input: 'QUEUED AFTER STOP ALL', cwd: app.engine.defaultCwd, enqueueKey: 'http:stop-all-next' }); assert.equal(queued.status, 201); assert.equal(app.inbox.status().scheduled, 1);
    assert.equal((await post('/api/runs/stop-all', {}, false)).status, 401); assert.ok(calls.every(call => !call.signal.aborted)); assert.equal(app.inbox.status().paused, false);
    const stopped = await post('/api/runs/stop-all'); assert.equal(stopped.status, 200); assert.equal(stopped.data.cancelled, 2); assert.ok(calls.every(call => call.signal.aborted));
    const stopping = await request('/api/status', { headers: auth }); assert.equal(stopping.data.execution.activeRunCount, 2); assert.equal(stopping.data.execution.availableSlots, 0); assert.equal(stopping.data.execution.stopping, true); assert.equal(stopping.data.execution.settling, true); assert.equal(stopping.data.inbox.paused, true); assert.equal(stopping.data.operations.paused, true);
    assert.equal(app.engine.getRun(first.data.id).status, 'cancelled'); assert.equal(app.engine.getRun(second.data.id).status, 'cancelled'); assert.equal(app.engine.getRun(first.data.id).settled, false);
    const repeated = await post('/api/runs/stop-all'); assert.equal(repeated.status, 200); assert.equal(repeated.data.cancelled, 0);
    holds[0].resolve({ output: 'Discard first late reply.', threadId: 'stop-all-thread-0' }); holds[1].resolve({ output: 'Discard second late reply.', threadId: 'stop-all-thread-1' });
    await until(() => app.engine.getRun(first.data.id).settled && app.engine.getRun(second.data.id).settled, 'both stopped chats acknowledge'); await app.inbox.pump(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 2); assert.equal(app.inbox.get(queued.data.id).status, 'queued'); assert.equal(app.inbox.status().paused, true); assert.equal(app.engine.executionStatus().activeRunCount, 0); assert.equal(app.engine.getRun(first.data.id).output, ''); assert.equal(app.engine.getRun(second.data.id).output, '');
  } finally { holds.forEach((hold, index) => hold.resolve({ output: 'Fixture cleanup.', threadId: `stop-all-thread-${index}` })); }
});

test('HTTP Stop for one chat leaves another chat and queued starts running independently', async t => {
  const holds = [deferred(), deferred(), deferred()], calls = [], arrivalOrder = [], secondRecorded = deferred(), runtime = new FakeRuntime();
  const inputs = ['FIRST ISOLATED CHAT', 'SECOND ISOLATED CHAT', 'QUEUED INDEPENDENT CHAT'];
  runtime.runAgent = async options => {
    const index = inputs.findIndex(input => options.prompt.includes(input)); assert.ok(index >= 0, 'the fixture call belongs to an exact submitted chat');
    await recordFixturePlan(options);
    // Plan persistence may finish in either order. Force the later chat to
    // finish first and bind the held turn to its input, not callback arrival.
    if (index === 0) await secondRecorded.promise;
    calls[index] = options; arrivalOrder.push(index); if (index === 1) secondRecorded.resolve();
    options.onEvent({ type: 'thread', threadId: `isolated-stop-thread-${index}` }); return holds[index].promise;
  };
  const { app, request, auth } = await application(t, { runtime, maxConcurrentRuns: 2 }); await app.learning.updateSettings({ mode: 'manual' });
  const post = (route, body = {}) => request(route, { method: 'POST', headers: auth, body });
  try {
    const first = await post('/api/runs', { workflow: graph, input: inputs[0] }), second = await post('/api/runs', { workflow: graph, input: inputs[1] }); assert.equal(first.status, 201); assert.equal(second.status, 201); await until(() => calls[0] && calls[1], 'both isolated chats start'); assert.deepEqual(arrivalOrder, [1, 0]);
    const queued = await post('/api/inbox/queue', { workflow: graph, input: 'QUEUED INDEPENDENT CHAT', cwd: app.engine.defaultCwd, enqueueKey: 'http:isolated-stop-next' }); assert.equal(queued.status, 201);
    const stopped = await post(`/api/runs/${first.data.id}/cancel`); assert.equal(stopped.status, 200); assert.equal(calls[0].signal.aborted, true); assert.equal(calls[1].signal.aborted, false); assert.equal(app.engine.getRun(second.data.id).status, 'running');
    assert.equal(app.inbox.status().paused, false); assert.equal(app.operations.status().paused, false); assert.equal(calls.length, 2); assert.equal(app.engine.executionStatus().availableSlots, 0);
    holds[0].resolve({ output: 'Discard the stopped reply.', threadId: 'isolated-stop-thread-0' });
    await until(() => app.engine.getRun(first.data.id).settled && calls.length === 3 && app.inbox.get(queued.data.id).runId, 'queued chat fills only the acknowledged free slot');
    assert.equal(app.engine.getRun(second.data.id).status, 'running'); assert.equal(calls[1].signal.aborted, false); assert.equal(calls[2].signal.aborted, false); assert.equal(app.inbox.status().paused, false); assert.equal(app.operations.status().paused, false);
    const queuedRunId = app.inbox.get(queued.data.id).runId; assert.equal(app.engine.getRun(queuedRunId).input, 'QUEUED INDEPENDENT CHAT');
    holds[1].resolve({ output: 'Second finished independently.', threadId: 'isolated-stop-thread-1' }); holds[2].resolve({ output: 'Queued chat finished.', threadId: 'isolated-stop-thread-2' });
    await until(() => app.engine.getRun(second.data.id).settled && app.inbox.get(queued.data.id).status === 'completed', 'unrelated chats complete');
    assert.equal(app.engine.getRun(first.data.id).status, 'cancelled'); assert.equal(app.engine.getRun(second.data.id).status, 'completed'); assert.equal(app.engine.getRun(queuedRunId).status, 'completed'); assert.equal(app.engine.getRun(first.data.id).output, '');
  } finally { secondRecorded.resolve(); holds.forEach((hold, index) => hold.resolve({ output: 'Fixture cleanup.', threadId: `isolated-stop-thread-${index}` })); }
});

test('HTTP Stop all still stops every chat and waits for queue saves when browser and learning cleanup fail', async t => {
  const holds = [deferred(), deferred()], saved = deferred(), calls = [], events = [], runtime = new FakeRuntime();
  runtime.runAgent = async options => { await recordFixturePlan(options); const index = calls.length; calls.push(options); return holds[index].promise; };
  const { app, request, auth } = await application(t, { runtime, maxConcurrentRuns: 2 }); await app.learning.updateSettings({ mode: 'manual' });
  const post = (route, body = {}) => request(route, { method: 'POST', headers: auth, body });
  const original = { browser: app.browser.cancel, learning: app.learning.cancelBackground, pause: app.inbox.pause, compactions: app.engine.cancelCompactions };
  let stopping;
  try {
    const first = await post('/api/runs', { workflow: graph, input: 'FIRST CLEANUP FAILURE CHAT' }), second = await post('/api/runs', { workflow: graph, input: 'SECOND CLEANUP FAILURE CHAT' }); await until(() => calls.length === 2, 'both cleanup fixtures start');
    app.inbox.pause = async (...args) => { events.push('inbox'); const result = await original.pause.apply(app.inbox, args); await saved.promise; events.push('saved'); return result; };
    app.browser.cancel = () => { events.push('browser'); throw new Error('Fixture browser adapter did not acknowledge Stop.'); };
    app.learning.cancelBackground = async () => { events.push('learning'); throw new Error('Fixture learning cleanup failed.'); };
    app.engine.cancelCompactions = (...args) => { events.push('compactions'); return original.compactions.apply(app.engine, args); };
    let responded = false; stopping = post('/api/runs/stop-all').then(result => { responded = true; return result; });
    await until(() => events.includes('learning') && app.inbox.status().paused && app.operations.status().paused, 'all cleanup actions are attempted');
    assert.ok(calls.every(call => call.signal.aborted)); assert.equal(app.engine.getRun(first.data.id).status, 'cancelled'); assert.equal(app.engine.getRun(second.data.id).status, 'cancelled'); assert.ok(events.includes('compactions'));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(responded, false, 'an adapter failure cannot skip the admitted queue-save acknowledgement');
    saved.resolve(); const result = await stopping; assert.equal(result.status, 500); assert.equal(result.data.cancelled, 2); assert.equal(result.data.error, 'Some stop actions need attention.'); assert.ok(result.data.details.some(detail => detail.includes('browser adapter'))); assert.ok(result.data.details.some(detail => detail.includes('learning cleanup'))); assert.ok(events.includes('saved'));
  } finally {
    saved.resolve(); if (stopping) await stopping.catch(() => {});
    app.browser.cancel = original.browser; app.learning.cancelBackground = original.learning; app.inbox.pause = original.pause; app.engine.cancelCompactions = original.compactions;
    holds.forEach(hold => hold.resolve({ output: 'Fixture cleanup.' }));
  }
});

test('live execution updates publish parallel admission, stopping acknowledgement, and the freed slots', async t => {
  const holds = [deferred(), deferred()], calls = [], runtime = new FakeRuntime();
  runtime.runAgent = async options => { await recordFixturePlan(options); const index = calls.length; calls.push(options); return holds[index].promise; };
  const { app, request, auth, url } = await application(t, { runtime, maxConcurrentRuns: 2 }); await app.learning.updateSettings({ mode: 'manual' });
  const controller = new AbortController(), stream = await fetch(url + '/api/events', { headers: auth, signal: controller.signal }); assert.equal(stream.status, 200);
  const reader = stream.body.getReader(), events = []; let buffer = '';
  const execution = async predicate => {
    const deadline = setTimeout(() => controller.abort(), 10000);
    try {
      while (true) {
        const found = events.find(event => event.type === 'execution.updated' && predicate(event.data)); if (found) return found.data;
        const next = await reader.read(); assert.equal(next.done, false, 'execution event stream ended before publishing the updated capacity'); buffer += Buffer.from(next.value).toString('utf8');
        let separator; while ((separator = buffer.indexOf('\n\n')) >= 0) { const frame = buffer.slice(0, separator); buffer = buffer.slice(separator + 2); const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'); if (data) events.push(JSON.parse(data)); }
      }
    } finally { clearTimeout(deadline); }
  };
  const post = (route, body = {}) => request(route, { method: 'POST', headers: auth, body });
  try {
    const first = await post('/api/runs', { workflow: graph, input: 'FIRST LIVE CAPACITY CHAT' }), second = await post('/api/runs', { workflow: graph, input: 'SECOND LIVE CAPACITY CHAT' }); await until(() => calls.length === 2, 'live capacity fixtures start');
    const admitted = await execution(value => value.activeRunCount === 2 && value.activeRunIds.includes(first.data.id) && value.activeRunIds.includes(second.data.id)); assert.equal(admitted.availableSlots, 0); assert.equal(admitted.capacity, 2);
    assert.equal((await post(`/api/runs/${first.data.id}/cancel`)).status, 200);
    const stopping = await execution(value => value.activeRunCount === 2 && value.stopping); assert.equal(stopping.availableSlots, 0); assert.equal(stopping.settling, true);
    holds[0].resolve({ output: 'Stopped fixture reply.', threadId: 'live-capacity-first' });
    const freed = await execution(value => value.activeRunCount === 1 && value.activeRunIds[0] === second.data.id); assert.equal(freed.availableSlots, 1); assert.equal(freed.stopping, false);
    holds[1].resolve({ output: 'Second fixture reply.', threadId: 'live-capacity-second' });
    const idle = await execution(value => value.activeRunCount === 0); assert.equal(idle.availableSlots, 2); assert.deepEqual(idle.activeRunIds, []); assert.equal(idle.activeRunId, null);
    assert.equal((await request('/api/status', { headers: auth })).data.execution.availableSlots, idle.availableSlots);
  } finally { holds.forEach(hold => hold.resolve({ output: 'Fixture cleanup.' })); await reader.cancel().catch(() => {}); controller.abort(); }
});

test('parallel Relay instances retain distinct browser cookies without authenticating each other', async t => {
  const first=await application(t),second=await application(t);
  assert.notEqual(first.cookie.split('=')[0],second.cookie.split('=')[0]);
  const browserCookies={Cookie:`relay_session=legacy; ${first.cookie}; ${second.cookie}`};
  assert.equal((await first.request('/api/status',{headers:browserCookies})).status,200);
  assert.equal((await second.request('/api/status',{headers:browserCookies})).status,200);
  assert.equal((await first.request('/api/status',{headers:second.auth})).status,401);
  assert.equal((await second.request('/api/status',{headers:first.auth})).status,401);
});

test('a large live update drains without disconnecting the browser event stream', async t => {
  const runtime=new FakeRuntime();let payload='';runtime.status=()=>({connected:true,authenticated:true,defaultModel:'fixture-model',catalogDetail:payload});
  const app=await application(t,{runtime});const controller=new AbortController();t.after(()=>controller.abort());
  const stream=await fetch(app.url+'/api/events',{headers:app.auth,signal:controller.signal});assert.equal(stream.status,200);
  const reader=stream.body.getReader();let buffer='';
  const readUntil=async predicate=>{const timeout=setTimeout(()=>controller.abort(),2500);try{while(!predicate(buffer)){const {done,value}=await reader.read();assert.equal(done,false,'live stream closed while delivering a buffered event');buffer+=Buffer.from(value).toString('utf8');}}finally{clearTimeout(timeout);}};
  await readUntil(value=>value.includes('\n\n'));buffer='';
  payload='x'.repeat(300000);runtime.emit('status');await readUntil(value=>value.includes('x'.repeat(300000))&&value.endsWith('\n\n'));
  buffer='';payload='AFTER_LARGE_EVENT';runtime.emit('status');await readUntil(value=>value.includes('AFTER_LARGE_EVENT')&&value.endsWith('\n\n'));
  await reader.cancel();
});

test('HTTP submission receipts survive restart and recent-run eviction; rename survives archive and restore', async t => {
  let turns=0;
  const runtime=()=>{const value=new FakeRuntime();value.runAgent=async options=>{await recordFixturePlan(options);turns++;return {output:'Delivered once',threadId:'fixture-receipt-thread'};};return value;};
  const first=await application(t,{runtime:runtime()});
  const payload={workflow:graph,input:'Receipt recovery check',requestId:'stable-http-request'};
  const send=(app,value=payload)=>app.request('/api/runs',{method:'POST',headers:app.auth,body:value});
  const started=await send(first);assert.equal(started.status,201);
  assert.equal((await send(first)).data.id,started.data.id);
  const deadline=Date.now()+3000;
  while(!first.app.engine.getRun(started.data.id).settled&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(first.app.engine.getRun(started.data.id).status,'completed');
  await first.app.conversations.chain;
  const renamed=await first.request(`/api/conversations/${started.data.id}/rename`,{method:'POST',headers:first.auth,body:{title:'Release verification'}});
  assert.equal(renamed.status,200);assert.equal(renamed.data.title,'Release verification');
  for(const action of ['archive','restore'])assert.equal((await first.request(`/api/conversations/${started.data.id}/${action}`,{method:'POST',headers:first.auth,body:{}})).status,200);
  assert.equal((await first.request(`/api/conversations/${started.data.id}`,{headers:first.auth})).data.title,'Release verification');
  const {dataDir,defaultCwd}=first.app.engine;
  first.app.engine.runs.delete(started.data.id);await first.app.engine.persist();await first.app.close();
  const second=await application(t,{runtime:runtime(),dataDir,defaultCwd});
  const recovered=await send(second,{...payload,workflow:{...graph,id:'new-generated-graph'}});
  assert.equal(recovered.status,201);assert.equal(recovered.data.id,started.data.id);assert.equal(turns,1);
  assert.equal((await send(second,{...payload,input:'Changed task'})).status,409);assert.equal(turns,1);
  assert.equal((await second.request(`/api/conversations/${started.data.id}`,{headers:second.auth})).data.title,'Release verification');
  assert.equal((await second.request('/api/status',{headers:second.auth})).data.version,JSON.parse(await readFile(new URL('../package.json', import.meta.url),'utf8')).version);
  assert.equal((await second.request('/api-client.mjs')).status,200);
  await second.app.close();
});

test('server binds loopback and exposes only minimal health without a session', async t => {
  const { app, request, home } = await application(t);
  assert.equal(app.server.address().address, '127.0.0.1');
  const health = await request('/health');
  assert.deepEqual(health.data, { app: 'relay-agent-harness', ok: true });
  assert.equal((await request('/api/status')).status, 401);
  assert.equal((await request('/api/shutdown', { method: 'POST', body: {} })).status, 401);
  assert.match(home.headers['set-cookie'][0], /HttpOnly/);
  assert.match(home.headers['set-cookie'][0], /SameSite=Strict/);
  assert.equal(home.headers['x-content-type-options'], 'nosniff');
  assert.match(home.headers['content-security-policy'], /script-src 'self'/);
});

test('Chrome connection is an explicit desktop action and status reads never connect', async t => {
  let connections = 0;
  const { request, auth } = await application(t, { signedBrowser: true, signedBrowserOptions: { endpoints: [] }, connectChromeBrowser: async () => { connections++; } });
  const initial = await request('/api/browser/status', { headers: auth });
  assert.equal(initial.data.chromeBrowser.connected, false); assert.equal(connections, 0);
  await request('/api/status', { headers: auth }); assert.equal(connections, 0);
  assert.equal((await request('/api/browser/chrome/connect', { method: 'POST', body: {} })).status, 401); assert.equal(connections, 0);
  assert.equal((await request('/api/browser/chrome/connect', { method: 'POST', body: {}, headers: auth })).status, 200); assert.equal(connections, 1);
});

test('source server cannot initiate native Chrome connections', async t => {
  let connections = 0;
  const { request, auth } = await application(t, { connectChromeBrowser: async () => { connections++; } });
  assert.equal((await request('/api/browser/chrome/connect', { method: 'POST', body: {}, headers: auth })).status, 400);
  assert.equal(connections, 0);
});

test('API rejects untrusted Host, cross-site Origin and cross-site browser requests', async t => {
  const { url, request, auth } = await application(t);
  assert.equal((await request('/api/status', { headers: { ...auth, Host: 'evil.example' } })).status, 403);
  assert.equal((await request('/api/status', { headers: { ...auth, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/api/status', { headers: { ...auth, Origin: 'null' } })).status, 403);
  assert.equal((await request('/api/status', { headers: { ...auth, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await request('/api/status', { headers: { ...auth, Origin: url } })).status, 200);
  assert.equal((await request('/api/status', { headers: { Cookie: 'relay_session=invalid' } })).status, 401);
  assert.equal((await request('/api/status', { headers: { Cookie: `relay_session=${'é'.repeat(64)}` } })).status, 401);
});

test('static file allowlist blocks source, state and encoded traversal', async t => {
  const { request, auth } = await application(t);
  for (const route of ['/server.mjs', '/lib/engine.mjs', '/data/runs.json', '/../server.mjs', '/..%2fserver.mjs', '/public/index.html']) {
    assert.equal((await request(route, { headers: auth })).status, 404, route);
  }
  assert.equal((await request('/styles.css')).status, 200);
  const runState = await request('/run-state-model.mjs');
  assert.equal(runState.status, 200);
  assert.match(runState.headers['content-type'], /javascript/);
  assert.match(runState.text, /export function reduceRunEvent/);
  assert.equal((await request('http://[')).status, 400, 'malformed request target is handled');
});

test('mutation endpoints require valid bounded JSON bodies', async t => {
  const { request, auth } = await application(t);
  assert.equal((await request('/api/workflows', { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await request('/api/workflows', { method: 'POST', headers: auth, body: '{broken' })).status, 400);
  assert.equal((await request('/api/workflows', { method: 'POST', headers: auth, body: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }) })).status, 413);
});

test('HTTP workflow save, execution, history and deletion work end to end', async t => {
  const { request, auth } = await application(t);
  const saved = await request('/api/workflows', { method: 'POST', headers: auth, body: graph });
  assert.equal(saved.status, 200);
  assert.equal((await request('/api/workflows', { headers: auth })).data.length, 1);
  assert.equal((await request(`/api/workflows/${saved.data.id}`, { headers: auth })).data.name, graph.name);
  const started = await request('/api/runs', { method: 'POST', headers: auth, body: { workflow: saved.data, input: { task: 'Exercise local HTTP integration' } } });
  assert.equal(started.status, 201);
  let finished;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    finished = await request(`/api/runs/${started.data.id}`, { headers: auth });
    if (['completed', 'failed', 'cancelled'].includes(finished.data.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(finished.data.status, 'completed');
  assert.match(finished.data.output, /HTTP fixture output/);
  assert.equal((await request('/api/runs', { headers: auth })).data[0].id, started.data.id);
  assert.equal((await request(`/api/workflows/${saved.data.id}`, { method: 'DELETE', headers: auth, body: {} })).status, 200);
  assert.equal((await request('/api/workflows', { headers: auth })).data.length, 0);
});

test('HTTP resume creates a linked run from the original snapshot and rejects completed or unknown runs', async t => {
  let attempt = 0;
  const runtime = new FakeRuntime();
  runtime.runAgent = async options => {
    if (++attempt === 1) throw new Error('fixture provider disconnected');
    await recordFixturePlan(options);
    return { output: 'HTTP resumed result', threadId: 'resumed-http-thread', usage: { totalTokens: 8 } };
  };
  const { app, request, auth } = await application(t, { runtime });
  const started = await request('/api/runs', { method: 'POST', headers: auth, body: { workflow: graph, input: 'original HTTP task' } });
  assert.equal(started.status, 201);
  const waitSettled = async id => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const run = app.engine.getRun(id);
      if (run.settled) return run;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('HTTP run did not settle');
  };
  assert.equal((await waitSettled(started.data.id)).status, 'failed');
  const retried = await request(`/api/runs/${started.data.id}/retry`, { method: 'POST', headers: auth, body: {} });
  assert.equal(retried.status, 201);
  assert.notEqual(retried.data.id, started.data.id);
  assert.equal(retried.data.retryOf, started.data.id);
  assert.equal(retried.data.input, 'original HTTP task');
  assert.equal(retried.data.nodes.input.reused, true);
  const finished = await waitSettled(retried.data.id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.usage.totalTokens, 8);
  assert.equal(attempt, 2);
  assert.equal((await request(`/api/runs/${finished.id}/retry`, { method: 'POST', headers: auth, body: {} })).status, 409);
  assert.equal((await request('/api/runs/missing/retry', { method: 'POST', headers: auth, body: {} })).status, 404);
  assert.equal((await request('/api/runs', { headers: auth })).data.length, 2);
});

test('HTTP resume rejects cancellation until the provider has stopped', async t => {
  let acknowledge;
  const stopped = new Promise(resolve => { acknowledge = resolve; });
  let calls = 0;
  const runtime = new FakeRuntime();
  runtime.runAgent = async () => { calls++; return stopped; };
  const { app, request, auth } = await application(t, { runtime });
  const started = await request('/api/runs', { method: 'POST', headers: auth, body: { workflow: graph, input: 'cancellation boundary' } });
  while (!calls) await new Promise(resolve => setTimeout(resolve, 10));
  try {
    assert.equal((await request(`/api/runs/${started.data.id}/cancel`, { method: 'POST', headers: auth, body: {} })).status, 200);
    const blocked = await request(`/api/runs/${started.data.id}/retry`, { method: 'POST', headers: auth, body: {} });
    assert.equal(blocked.status, 409);
    assert.match(blocked.data.error, /stopping/);
    const status = await request('/api/status', { headers: auth });
    assert.equal(status.data.execution.activeRunId, started.data.id);
    assert.equal(status.data.execution.stopping, true);
    assert.equal(status.data.execution.settling, true);
    assert.equal(status.data.storage.healthy, true);
  } finally { acknowledge({ output: 'cancelled completion', threadId: 'stopped-http-thread' }); }
  await app.engine.executions.get(started.data.id);
});

test('desktop attaches directly and disconnecting it stops an active desktop workflow', async t => {
  class FakeDesktop extends EventEmitter {
    constructor() { super(); this.enabled = false; this.attachments = []; }
    status() { return { available: true, enabled: this.enabled, platform: 'win32' }; }
    async setEnabled(enabled) { this.enabled = enabled; this.attachments.push(enabled); this.emit('status', this.status()); return this.status(); }
  }
  const desktop = new FakeDesktop();
  let active;
  const runtime = new FakeRuntime();
  runtime.runAgent = options => {
    active = options;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('desktop detached')), { once: true }));
  };
  const { app, request, auth } = await application(t, { runtime, desktop });
  assert.deepEqual(desktop.attachments, [true], 'desktop connects without an approval step');
  const flow = structuredClone(graph); flow.nodes.find(node => node.type === 'agent').desktop = true;
  const started = await request('/api/runs', { method: 'POST', headers: auth, body: { workflow: flow, input: 'desktop connection test' } });
  assert.equal(started.status, 201);
  while (!active) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(active.dynamicTools.length);
  assert.equal(typeof active.onToolCall, 'function');
  assert.equal(active.sandbox, 'danger-full-access');
  const detached = await request('/api/desktop/detach', { method: 'POST', headers: auth, body: {} });
  assert.equal(detached.status, 200);
  assert.equal(active.signal.aborted, true);
  await app.engine.executions.get(started.data.id);
  assert.equal(app.engine.getRun(started.data.id).status, 'cancelled');
  assert.equal((await request(`/api/runs/${started.data.id}/retry`, { method: 'POST', headers: auth, body: {} })).status, 400);
  assert.equal((await request('/api/desktop/attach', { method: 'POST', headers: auth, body: {} })).data.enabled, true);
});

for (const firstFailure of ['storage', 'desktop']) {
  test(`shutdown closes provider, event streams and listener after ${firstFailure} failure and retains the first error`, { timeout: 5000 }, async t => {
    const stages = [];
    const storageError = new Error('History could not be saved: disk full.');
    const desktopError = new Error('Desktop worker did not detach cleanly.');
    const providerError = new Error('Provider cleanup also failed.');
    class FakeDesktop extends EventEmitter {
      status() { return { available: false, enabled: false }; }
      async setEnabled() { stages.push('desktop'); if (firstFailure === 'desktop') throw desktopError; }
    }
    const runtime = new FakeRuntime();
    runtime.close = async () => { stages.push('provider'); throw providerError; };
    const { app, url, auth } = await application(t, { runtime, desktop: new FakeDesktop() });
    app.engine.persist = async () => { stages.push('storage'); throw storageError; };
    const expectedError = firstFailure === 'desktop' ? desktopError : storageError;
    const close = app.close.bind(app);
    // Fixture cleanup should accept the deliberately injected shutdown error.
    app.close = () => close().catch(error => { if (error !== expectedError) throw error; });
    const stream = await new Promise((resolve, reject) => {
      const request = http.get(`${url}/api/events`, { headers: auth }, response => {
        response.on('error', () => {});
        response.once('data', () => resolve({ request, response }));
      });
      request.on('error', reject);
    });
    t.after(() => stream.request.destroy());
    const disconnected = new Promise(resolve => stream.response.once('close', resolve));
    const results = await Promise.allSettled([close(), close()]);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason, expectedError);
    }
    await disconnected;
    assert.deepEqual(stages, ['desktop', 'storage', 'provider'], 'later cleanup runs once even after earlier errors');
    assert.equal(app.server.listening, false);
    assert.equal(app.engine.closed, true);
    await assert.rejects(close(), error => error === expectedError);
    assert.equal(stages.length, 3, 'repeated close shares the original shutdown result');
  });
}


test('model default and catalog endpoints keep settings local, forward bounded queries and report current status', async t => {
  const runtime = new FakeRuntime(); let selection = null, discovered;
  runtime.status = () => ({connected:true,authenticated:true,defaultModel:selection || 'fixture-model',defaultModelSelection:selection,defaultModelAvailable:true});
  runtime.setDefaultModel = async model => { if (typeof model !== 'string' && model !== null) throw new Error('Choose a valid default model.'); selection = model; };
  runtime.discoverModels = async (id, value) => { discovered={id,...value}; return {models:[{id:'found-model'}],offset:value.offset,total:350,hasMore:true}; };
  const app = await application(t, {runtime});
  const denied = await app.request('/api/models/default',{method:'POST',body:{model:'fixture-next'}});assert.equal(denied.status,401);assert.equal(selection,null);
  const saved = await app.request('/api/models/default',{method:'POST',headers:app.auth,body:{model:'fixture-next'}});
  assert.equal(saved.status,200);assert.equal(saved.data.defaultModelSelection,'fixture-next');assert.equal(saved.data.defaultModel,'fixture-next');
  const invalid = await app.request('/api/models/default',{method:'POST',headers:app.auth,body:{model:{bad:true}}});assert.equal(invalid.status,400);assert.equal(selection,'fixture-next');
  const catalog = await app.request('/api/providers/fixture/models',{method:'POST',headers:app.auth,body:{query:'large',offset:200,limit:100,toolsOnly:true}});
  assert.equal(catalog.status,200);assert.deepEqual(discovered,{id:'fixture',query:'large',offset:200,limit:100,toolsOnly:true});assert.equal(catalog.data.total,350);
  for(const file of ['provider-catalog.mjs','connection-models.mjs','connections.css','draft-store.mjs'])assert.equal((await app.request('/'+file,{headers:app.auth})).status,200,file);
});
