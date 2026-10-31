import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { tokenUsagePresentation } from '../public/token-usage.mjs';

class NoNativeProvider extends EventEmitter {
  calls = 0;
  status() { return { connected: false, authenticated: false, models: [] }; }
  async runAgent() { this.calls++; throw new Error('No native fallback belongs in this fixture.'); }
  async close() {}
}
const fields = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningOutputTokens'];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const json = (response, body, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
const writeEvent = (response, event) => response.write('data: ' + JSON.stringify(event) + '\n\n');
const sse = (response, events, done = false) => {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of events) writeEvent(response, event);
  response.end(done ? 'data: [DONE]\n\n' : '');
};
const failure = { code: 504, message: 'Upstream idle timeout exceeded', metadata: { error_type: 'timeout' } };
const thought = { model: 'fixture', choices: [{ index: 0, delta: { content: '', reasoning: 'Processing the synthetic fixture.' }, finish_reason: null }] };
const complete = (usage, toolId) => [
  { choices: [{ index: 0, delta: toolId ? { tool_calls: [{ index: 0, id: toolId, type: 'function', function: { name: 'fixture_observe', arguments: JSON.stringify({ action: toolId === 'fixture-list' ? 'list' : 'read' }) } }] } : { content: 'Completed.' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: toolId ? 'tool_calls' : 'stop' }] },
  { choices: [], usage },
];
const knownA = { prompt_tokens: 28528, completion_tokens: 94, total_tokens: 28622, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 73 } };
const knownB = { prompt_tokens: 28711, completion_tokens: 63, total_tokens: 28774, prompt_tokens_details: { cached_tokens: 21600 }, completion_tokens_details: { reasoning_tokens: 31 } };
const smallUsage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
const observeTool = { name: 'fixture_observe', description: 'Inspect a synthetic fixture.', inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } };

async function harness(t, handler, { type = 'compatible', ...options } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-failed-usage-')), requests = [], events = [], codex = new NoNativeProvider();
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') return json(response, { data: [] });
    let raw = ''; for await (const chunk of request) raw += chunk;
    requests.push({ method: request.method, url: request.url, body: raw ? JSON.parse(raw) : null });
    try { await handler(requests.at(-1), response, requests.length); }
    catch (cause) { if (!response.headersSent) json(response, { error: { message: cause.message } }, 500); else response.destroy(cause); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let runtime;
  t.after(async () => {
    await runtime?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(codex.calls, 0);
    await rm(dataDir, { recursive: true, force: true });
  });
  runtime = await new ProviderRuntime({ codex, dataDir, modelLimitResolver: { enrich: async (_config, models) => models }, ...options }).init();
  await runtime.saveProvider({ id: 'failed-usage', type, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', ...(type === 'compatible' ? {} : { apiKey: 'synthetic-local-fixture-key' }), models: ['fixture'], maxSteps: 8 });
  const run = (extra = {}) => runtime.runAgent({ cwd: dataDir, model: 'failed-usage::fixture', prompt: 'Inspect the synthetic fixture.', ...extra, onEvent: event => { events.push(event); extra.onEvent?.(event); } });
  return { runtime, dataDir, requests, events, run,
    lastUsage: () => events.filter(event => event.type === 'usage').at(-1)?.usage,
    thread: () => runtime.readThread(events.find(event => event.type === 'thread').threadId) };
}
const unavailable = usage => {
  assert.ok(usage, 'accepted failed response must publish its usage availability');
  assert.equal(usage.samples, 1);
  for (const field of fields) { assert.equal(usage[field], null); assert.equal(usage.availability[field], 'unavailable'); }
};

test('Kilo-shaped accepted failed stream preserves two real tool results and marks the known subtotal partial', async t => {
  const h = await harness(t, (_request, response, number) => {
    if (number === 1) return sse(response, complete(knownA, 'fixture-list'), true);
    if (number === 2) return sse(response, complete(knownB, 'fixture-read'), true);
    sse(response, [thought, { choices: [], error: failure }]);
  });
  await writeFile(path.join(h.dataDir, 'fixture.txt'), 'Synthetic test content.\n');
  const callbacks = new Map();
  await assert.rejects(h.run({ dynamicTools: [observeTool], onToolCall: async call => {
    callbacks.set(call.callId, (callbacks.get(call.callId) || 0) + 1);
    const result = call.arguments.action === 'list' ? await readdir(h.dataDir) : await readFile(path.join(h.dataDir, 'fixture.txt'), 'utf8');
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
  } }), { code: 'PROVIDER_SERVICE' });
  assert.deepEqual([...callbacks.values()], [1, 1]);
  assert.equal(h.requests.length, 3, 'HTTP200 failed stream must not be retried');
  const usage = h.lastUsage();
  assert.equal(usage.samples, 3);
  assert.deepEqual(fields.map(field => usage[field]), [57239, 157, 57396, 21600, 104]);
  assert.ok(fields.every(field => usage.availability[field] === 'partial'));
  unavailable(usage.last);
  assert.equal(tokenUsagePresentation(usage).usageLabel, 'At least 57,396 tokens');
  const saved = await h.thread();
  assert.deepEqual(saved.totalUsage, usage.total);
  assert.equal(saved.totalUsage.samples, 3);
  assert.equal(saved.messages.filter(message => message.role === 'tool').length, 2);
  assert.equal(h.events.filter(event => event.type === 'usage').length, 3);
  assert.ok(!h.events.some(event => event.type === 'turn' && event.status === 'completed'));
});

for (const [name, delta] of [
  ['reasoning-only', { reasoning: 'Synthetic reasoning fragment.', content: '' }],
  ['ordinary text', { content: 'A partial answer.' }],
  ['incomplete tool arguments', { tool_calls: [{ index: 0, id: 'unfinished-call', type: 'function', function: { name: 'fixture_observe', arguments: '{"action":' } }] }],
]) test('first accepted ' + name + ' stream failure records one unavailable measurement', async t => {
  const h = await harness(t, (_request, response) => sse(response, [{ choices: [{ index: 0, delta }] }, { error: failure }]));
  let tools = 0;
  await assert.rejects(h.run({ dynamicTools: [observeTool], onToolCall: async () => { tools++; } }), { code: 'PROVIDER_SERVICE' });
  unavailable(h.lastUsage());
  assert.equal((await h.thread()).totalUsage.samples, 1);
  assert.equal(tokenUsagePresentation(h.lastUsage()).usageLabel, 'Token usage unavailable');
  assert.equal(h.requests.length, 1); assert.equal(tools, 0);
});

for (const combined of [false, true]) test('failed compatible stream retains its latest usage snapshot once (' + (combined ? 'usage with error' : 'usage before error') + ')', async t => {
  const h = await harness(t, (_request, response) => sse(response, [
    thought, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ...(combined ? [{ error: failure, usage: smallUsage }] : [{ choices: [], usage: smallUsage }, { error: failure }]),
  ]));
  await assert.rejects(h.run(), { code: 'PROVIDER_SERVICE' });
  const usage = h.lastUsage();
  assert.ok(usage); assert.equal(usage.samples, 1); assert.equal(usage.totalTokens, 13);
  assert.equal(usage.inputTokens, 10); assert.equal(usage.outputTokens, 3);
  assert.equal(usage.availability.totalTokens, 'partial'); assert.equal(usage.last.samples, 1);
  assert.equal(tokenUsagePresentation(usage).usageLabel, 'At least 13 tokens');
  assert.deepEqual((await h.thread()).totalUsage, usage.total);
  assert.equal(h.requests.length, 1);
});

test('explicit reported zero remains zero when its stream later fails', async t => {
  const h = await harness(t, (_request, response) => sse(response, [{ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, error: failure }]));
  await assert.rejects(h.run(), { code: 'PROVIDER_SERVICE' });
  assert.equal(h.lastUsage()?.totalTokens, 0); assert.equal(h.lastUsage()?.samples, 1);
  assert.equal(h.lastUsage()?.availability.totalTokens, 'partial');
});

for (const type of ['openai', 'anthropic']) test(type + ' failed stream retains protocol-specific reported usage', async t => {
  const events = type === 'openai' ? [
    { type: 'response.output_text.delta', delta: 'Partial.' },
    { type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'Synthetic upstream failure.' }, usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } },
  ] : [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial.' } },
    { type: 'message_delta', usage: { output_tokens: 3 }, delta: {} },
    { type: 'error', error: { type: 'overloaded_error', message: 'Synthetic upstream failure.' } },
  ];
  const h = await harness(t, (_request, response) => sse(response, events), { type });
  await assert.rejects(h.run(), { code: 'PROVIDER_ERROR' });
  const usage = h.lastUsage();
  assert.equal(usage?.samples, 1); assert.equal(usage?.inputTokens, 10);
  assert.equal(usage?.outputTokens, 3); assert.equal(usage?.totalTokens, 13);
  assert.equal(usage?.availability.totalTokens, 'partial');
  assert.equal(h.requests.length, 1);
});

for (const status of [401, 429, 502]) test('HTTP' + status + ' rejection contributes no accepted exchange sample', async t => {
  const h = await harness(t, (_request, response) => json(response, { error: { message: 'Synthetic rejection.' } }, status));
  await assert.rejects(h.run());
  assert.equal(h.events.filter(event => event.type === 'usage').length, 0);
  assert.equal((await h.thread()).totalUsage.samples, 0);
  assert.equal(h.requests.length, status === 502 ? 2 : 1);
});

test('one rejected HTTP502 followed by a successful response contributes only one reported sample', async t => {
  const h = await harness(t, (_request, response, number) => number === 1 ? json(response, { error: { message: 'Temporarily unavailable.' } }, 502) : sse(response, complete(smallUsage), true));
  const result = await h.run();
  assert.equal(result.usage.samples, 1); assert.equal(result.usage.totalTokens, 13);
  assert.equal(result.usage.availability.totalTokens, 'reported');
  assert.equal(h.requests.length, 2);
});

test('HTTP200 error with only an empty role event is not invented model production', async t => {
  const h = await harness(t, (_request, response) => sse(response, [{ choices: [{ delta: { role: 'assistant', content: '' } }] }, { error: { code: 'invalid_api_key', message: 'Unauthorized.' } }]));
  await assert.rejects(h.run(), { code: 'PROVIDER_AUTH' });
  assert.equal(h.events.filter(event => event.type === 'usage').length, 0);
  assert.equal((await h.thread()).totalUsage.samples, 0);
  assert.equal(h.requests.length, 1);
});

test('cancellation before model data adds no sample, even after HTTP200 heartbeat headers', async t => {
  const arrived = deferred(), controller = new AbortController();
  const h = await harness(t, (_request, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': keepalive\n\n'); arrived.resolve(); });
  const pending = h.run({ signal: controller.signal }); pending.catch(() => {});
  await arrived.promise; controller.abort();
  await assert.rejects(pending, { code: 'ABORT_ERR' });
  assert.equal(h.events.filter(event => event.type === 'usage').length, 0);
  assert.equal((await h.thread()).totalUsage.samples, 0);
  assert.equal(h.requests.length, 1);
});

test('cancellation after accepted text settles one unavailable sample without retrying', async t => {
  const controller = new AbortController();
  const h = await harness(t, (_request, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); writeEvent(response, { choices: [{ delta: { content: 'Partial.' } }] }); });
  await assert.rejects(h.run({ signal: controller.signal, onEvent: event => { if (event.type === 'delta') controller.abort(); } }), { code: 'ABORT_ERR' });
  unavailable(h.lastUsage()); assert.equal((await h.thread()).totalUsage.samples, 1);
  assert.equal(h.requests.length, 1);
});

test('final-review failure after a measured completed response does not add a missing exchange', async t => {
  const h = await harness(t, (_request, response) => sse(response, complete(smallUsage), true));
  await assert.rejects(h.run({ onBeforeFinal: async () => { throw Object.assign(new Error('Synthetic review failure.'), { code: 'FIXTURE_REVIEW' }); } }), { code: 'FIXTURE_REVIEW' });
  assert.equal(h.lastUsage().samples, 1); assert.equal(h.lastUsage().availability.totalTokens, 'reported');
  assert.equal((await h.thread()).totalUsage.samples, 1); assert.equal(h.requests.length, 1);
});

test('tool cancellation after its measured response does not add a missing exchange or repeat the callback', async t => {
  const controller = new AbortController(); let calls = 0;
  const h = await harness(t, (_request, response) => sse(response, complete(smallUsage, 'fixture-read'), true));
  await assert.rejects(h.run({ signal: controller.signal, dynamicTools: [observeTool], onToolCall: async () => {
    calls++; controller.abort(); return { success: true, contentItems: [{ type: 'inputText', text: 'Completed fixture read.' }] };
  } }), { code: 'ABORT_ERR' });
  assert.equal(calls, 1); assert.equal(h.requests.length, 1);
  assert.equal(h.lastUsage().samples, 1); assert.equal(h.lastUsage().availability.totalTokens, 'reported');
  assert.equal((await h.thread()).totalUsage.samples, 1);
});

test('failed context-summary stream settles into the parent accounting state and preserves conversation', async t => {
  const h = await harness(t, (_request, response, number) => {
    if (number === 1) return sse(response, complete({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }, 'fixture-read'), true);
    if (number === 2) return sse(response, complete({ prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 }), true);
    sse(response, [thought, { error: failure }]);
  });
  let tools = 0;
  const first = await h.run({ context: { keepRecentTokens: 256, autoCompact: false }, dynamicTools: [observeTool], onToolCall: async () => {
    tools++; return { success: true, contentItems: [{ type: 'inputText', text: 'Verified synthetic ALPHA. '.repeat(400) }] };
  } });
  const before = await h.runtime.readThread(first.threadId), events = [];
  await assert.rejects(h.runtime.compactThread(first.threadId, { onEvent: event => events.push(event) }), { code: 'PROVIDER_SERVICE' });
  const usage = events.filter(event => event.type === 'usage').at(-1)?.usage;
  unavailable(usage); assert.equal(usage.total.samples, 3);
  assert.equal(usage.total.totalTokens, 35); assert.equal(usage.total.availability.totalTokens, 'partial');
  const after = await h.runtime.readThread(first.threadId);
  assert.deepEqual(after.messages, before.messages); assert.deepEqual(after.compactions, before.compactions);
  assert.deepEqual(after.totalUsage, usage.total);
  assert.equal(h.requests.length, 3); assert.equal(h.requests[2].body.tools, undefined); assert.equal(tools, 1);
});

test('a usage observer failure cannot replace the original provider stream error', async t => {
  const h = await harness(t, (_request, response) => sse(response, [thought, { error: failure }]));
  await assert.rejects(h.run({ onEvent: event => { if (event.type === 'usage') throw new Error('Synthetic observer failure.'); } }), cause => cause.code === 'PROVIDER_SERVICE' && /Upstream idle timeout exceeded/.test(cause.message));
  assert.equal((await h.thread()).totalUsage.samples, 1); assert.equal(h.requests.length, 1);
});
