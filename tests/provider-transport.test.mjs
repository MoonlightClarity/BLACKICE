import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProviderTransport, readProviderText } from '../lib/provider-transport.mjs';
import { MAX_TIMER_DELAY_MS } from '../lib/run-timeout.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
class FakeCodex extends EventEmitter {
  status() { return { connected: false, authenticated: false, models: [] }; }
  async close() {}
}
async function harness(t, handler, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'relay-idle-test-')), requests = [], timers = new Set();
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const record = { url: request.url, body: raw ? JSON.parse(raw) : null }; requests.push(record);
    handler?.(record, response, requests.length, timer => timers.add(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const runtime = await new ProviderRuntime({ codex: new FakeCodex(), dataDir, idleTimeoutMs: 120, ...options }).init();
  const provider = await runtime.saveProvider({ id: 'fixture', type: 'compatible', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: ['fixture-model'] });
  t.after(async () => { for (const timer of timers) { clearTimeout(timer); clearInterval(timer); } await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  return { runtime, requests, provider, dataDir, run: options => runtime.runAgent({ cwd: dataDir, prompt: 'Disposable local transport fixture.', model: 'fixture::fixture-model', ...options }) };
}
const completed = text => ({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });

test('a silent connection has a bounded idle failure without retrying the accepted request', async t => {
  const { runtime, requests, run } = await harness(t, () => {});
  await assert.rejects(run(), failure => failure.code === 'PROVIDER_IDLE_TIMEOUT' && failure.failureScope === 'connection' && /stopped sending data/i.test(failure.message));
  assert.equal(requests.length, 1); assert.equal(runtime.active.size, 0);
  assert.equal(runtime.listProviders()[0].lastFailure.code, 'PROVIDER_IDLE_TIMEOUT');
});

test('a partial JSON body also expires while preserving the accepted conversation', async t => {
  const { runtime, requests, run, dataDir } = await harness(t, (_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"choices":'); });
  const events = [];
  await assert.rejects(run({ onEvent: event => events.push(event) }), { code: 'PROVIDER_IDLE_TIMEOUT' });
  assert.equal(requests.length, 1); assert.equal(runtime.active.size, 0);
  const thread = events.find(event => event.type === 'thread').threadId;
  const saved = JSON.parse(await readFile(path.join(dataDir, 'provider-threads', `${thread}.json`), 'utf8'));
  assert.equal(saved.messages[0].content, 'Disposable local transport fixture.');
  assert.ok(!events.some(event => event.type === 'turn' && event.status === 'completed'));
});

test('SSE comment heartbeats keep a healthy long response alive without inventing chat messages', async t => {
  const { requests, run } = await harness(t, (_request, response, _index, track) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': keepalive\n\n');
    const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 25); track(heartbeat);
    track(setTimeout(() => { clearInterval(heartbeat); response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Still healthy.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`); }, 320));
  });
  const events = [], result = await run({ onEvent: event => events.push(event) });
  assert.equal(result.output, 'Still healthy.'); assert.equal(requests.length, 1);
  assert.deepEqual(events.filter(event => event.type === 'delta').map(event => event.delta), ['Still healthy.']);
});

test('partial JSON bytes and split UTF-8 continue beyond one idle period', async t => {
  const answer = Buffer.from(JSON.stringify(completed('A knight ♞ and a moon 🌙.'))), split = answer.indexOf(Buffer.from('🌙'));
  const chunks = [answer.subarray(0, 18), answer.subarray(18, split + 1), answer.subarray(split + 1, split + 2), answer.subarray(split + 2)];
  const { run } = await harness(t, (_request, response, _index, track) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.write(chunks.shift());
    const timer = setInterval(() => { if (chunks.length) response.write(chunks.shift()); else { clearInterval(timer); response.end(); } }, 55); track(timer);
  });
  assert.equal((await run()).output, 'A knight ♞ and a moon 🌙.');
});

test('an explicit unlimited idle budget supports a silent wait and remains stoppable', async t => {
  const arrived = deferred(); let response;
  const { run } = await harness(t, (_request, value) => { response = value; arrived.resolve(); }, { idleTimeoutMs: 40 });
  const controller = new AbortController(), running = run({ providerIdleTimeoutMs: null, signal: controller.signal });
  running.catch(() => {}); await arrived.promise; await wait(100);
  controller.abort(); await assert.rejects(running, { code: 'ABORT_ERR' });
  assert.equal(response.writableEnded, false);
});

test('an idle abort-ignoring SSE exchange releases its connection and does not interrupt another chat', async t => {
  const partial = deferred(), disconnected = deferred(); let parallelResponse;
  const { runtime, run, requests } = await harness(t, (_request, response, index) => {
    if (index === 2) { parallelResponse = response; return; }
    response.on('close', () => disconnected.resolve());
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'A visible partial.' } }] })}\n\n`);
  }, { fetchImpl: (url, { signal, ...options }) => fetch(url, options) });
  const events = [], stalled = run({ onEvent: event => { events.push(event); if (event.type === 'delta') partial.resolve(); } });
  stalled.catch(() => {}); await partial.promise;
  const parallel = run({ providerIdleTimeoutMs: null }); parallel.catch(() => {});
  await assert.rejects(stalled, { code: 'PROVIDER_IDLE_TIMEOUT' });
  await disconnected.promise; assert.equal(runtime.active.size, 1);
  parallelResponse.writeHead(200, { 'Content-Type': 'application/json' }); parallelResponse.end(JSON.stringify(completed('Other chat finished.')));
  assert.equal((await parallel).output, 'Other chat finished.'); assert.equal(requests.length, 2);
  assert.deepEqual(events.filter(event => event.type === 'delta').map(event => event.delta), ['A visible partial.']);
  assert.ok(!events.some(event => event.type === 'turn' && event.status === 'completed'));
});

test('Stop settles a stalled abort-ignoring SSE adapter and owns its reader cancellation once', async t => {
  const started = deferred(), controller = new AbortController(); let cancelled = 0, released = 0;
  const { run } = await harness(t, null, { fetchImpl: async () => ({ ok: true, headers: new Headers({ 'Content-Type': 'text/event-stream' }), body: { getReader: () => ({ read: () => { started.resolve(); return new Promise(() => {}); }, cancel: () => { cancelled++; }, releaseLock: () => { released++; } }) } }) });
  const pending = run({ providerIdleTimeoutMs: null, signal: controller.signal }); pending.catch(() => {});
  await started.promise; controller.abort(); await assert.rejects(pending, { code: 'ABORT_ERR' });
  assert.equal(cancelled, 1); assert.equal(released, 1);
});

test('a stalled abort-ignoring fetch settles and releases a late body without issuing another request', async () => {
  const arrived = deferred(), response = deferred(); let calls = 0, cancels = 0;
  const transport = createProviderTransport({ idleTimeoutMs: 30 });
  try {
    const pending = transport.fetch(async () => { calls++; arrived.resolve(); return response.promise; }, 'http://local.invalid', {});
    pending.catch(() => {}); await arrived.promise;
    await assert.rejects(pending, { code: 'PROVIDER_IDLE_TIMEOUT' });
    response.resolve({ body: { cancel: () => { cancels++; return Promise.resolve(); } } });
    await wait(0); assert.equal(calls, 1); assert.equal(cancels, 1);
  } finally { transport.dispose(); }
});

test('an immediate Stop prevents dispatch before an abort-ignoring adapter can send the request', async () => {
  const controller = new AbortController(); let calls = 0;
  const transport = createProviderTransport({ signal: controller.signal, idleTimeoutMs: null });
  try {
    const pending = transport.fetch(async () => { calls++; return new Response('{}'); }, 'http://fixture.invalid', {});
    controller.abort(Object.assign(new Error('Stopped before dispatch.'), { code: 'ABORT_ERR' }));
    await assert.rejects(pending, { code: 'ABORT_ERR' });
    assert.equal(calls, 0);
  } finally { transport.dispose(); }
});

for (const reason of ['idle', 'stop']) test(`${reason}: an abort-ignoring JSON reader settles and is cancelled once`, async () => {
  const started = deferred(), controller = new AbortController(); let cancels = 0, releases = 0;
  const transport = createProviderTransport({ signal: controller.signal, idleTimeoutMs: reason === 'idle' ? 30 : null });
  const response = { body: { getReader: () => ({ read: () => { started.resolve(); return new Promise(() => {}); }, cancel: () => { cancels++; return Promise.resolve(); }, releaseLock: () => { releases++; } }) } };
  try {
    const pending = readProviderText(response, transport); pending.catch(() => {}); await started.promise;
    if (reason === 'stop') controller.abort(Object.assign(new Error('Stopped.'), { code: 'ABORT_ERR' }));
    await assert.rejects(pending, { code: reason === 'idle' ? 'PROVIDER_IDLE_TIMEOUT' : 'ABORT_ERR' });
    assert.equal(cancels, 1); assert.equal(releases, 1);
  } finally { transport.dispose(); }
});

test('an adapter with an abort-ignoring response.text fallback is still bounded', async () => {
  const transport = createProviderTransport({ idleTimeoutMs: 30 });
  try { await assert.rejects(readProviderText({ text: () => new Promise(() => {}) }, transport), { code: 'PROVIDER_IDLE_TIMEOUT' }); }
  finally { transport.dispose(); }
});

test('HTTP rate-limit guidance retains Retry-After and does not retry', async t => {
  const { run, requests } = await harness(t, (_request, response) => { response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '7' }); response.end('{"error":{"message":"Too many requests."}}'); });
  await assert.rejects(run(), failure => failure.code === 'PROVIDER_RATE_LIMIT' && /Wait 7 seconds/.test(failure.message));
  assert.equal(requests.length, 1);
});

test('malformed JSON remains an explicit protocol error and releases its idle timer', async t => {
  const { run } = await harness(t, (_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"invalid":'); });
  await assert.rejects(run(), { code: 'PROVIDER_PROTOCOL' });
});

test('idle rearming uses monotonic chunked deadlines and disposal prevents a late abort', () => {
  let now = 0, serial = 0; const timers = new Map(), delays = [];
  const idleTimeoutMs = MAX_TIMER_DELAY_MS + 1000;
  const transport = createProviderTransport({ idleTimeoutMs, deadlineOptions: { now: () => now, setTimeoutImpl: (fn, delay) => { delays.push(delay); timers.set(++serial, fn); return serial; }, clearTimeoutImpl: id => timers.delete(id) } });
  assert.equal(delays[0], MAX_TIMER_DELAY_MS);
  now = MAX_TIMER_DELAY_MS; const first = timers.values().next().value; timers.clear(); first(); assert.equal(delays.at(-1), 1000);
  transport.activity(); assert.equal(delays.at(-1), MAX_TIMER_DELAY_MS);
  transport.dispose(); assert.equal(timers.size, 0); now += idleTimeoutMs + 1; assert.equal(transport.signal.aborted, false);
});
