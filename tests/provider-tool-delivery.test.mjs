import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Writable } from 'node:stream';
import { CodexRuntime } from '../lib/codex.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';
import { providerToolResultDeliveries, providerToolDeliveryObserver } from '../lib/provider-tool-delivery.mjs';
import { projectNativeTaskResult } from '../lib/task-tool-view.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const spec = { name: 'relay_task', wireName: 'relay_task', inputSchema: { type: 'object', properties: {} } };
const args = { action: 'read', view: 'contract' };
const payload = JSON.stringify({ taskSchemaVersion: 14, contractVersion: 2, taskId: 'task', revision: 2, contractDelivery: { version: 1, kind: 'page', revision: 2, offset: 0 }, text: '{"goal":"exact"}' });
const histories = {
  openai: [
    { type: 'function_call', call_id: 'read-1', name: 'relay_task', arguments: JSON.stringify(args) },
    { type: 'function_call_output', call_id: 'read-1', output: [{ type: 'input_text', text: payload }, { type: 'input_text', text: 'separate exact text' }] },
  ],
  anthropic: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'relay_task', input: args }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', is_error: false, content: [{ type: 'text', text: payload }, { type: 'text', text: 'separate exact text' }] }] },
  ],
  compatible: [
    { role: 'assistant', content: null, tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'relay_task', arguments: JSON.stringify(args) } }] },
    { role: 'tool', tool_call_id: 'read-1', content: payload + '\nseparate exact text' },
  ],
};
const bodyFor = type => ({ [type === 'openai' ? 'input' : 'messages']: structuredClone(histories[type]) });

for (const type of ['openai', 'anthropic', 'compatible']) test(type + ' delivery uses the exact final wire projection and excludes compacted historical text', () => {
  const body = bodyFor(type), deliveries = providerToolResultDeliveries(JSON.stringify(body), { type, tools: [spec] });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].call.name, 'relay_task');
  assert.equal(deliveries[0].call.callId, 'read-1');
  assert.deepEqual(deliveries[0].result.contentItems.map(item => item.text), type === 'compatible' ? [payload + '\nseparate exact text'] : [payload, 'separate exact text']);
  assert.equal(deliveries[0].result.success, type === 'anthropic' ? true : undefined, 'Do not invent success omitted by the wire format.');
  const projected = type === 'openai' ? { input: [{ role: 'user', content: 'summary only' }] } : { messages: [{ role: 'user', content: 'summary only' }] };
  assert.deepEqual(providerToolResultDeliveries(projected, { type, tools: [spec] }), []);
});

test('wire pairing rejects ambiguous call IDs and unknown catalog aliases', () => {
  const body = bodyFor('openai');
  body.input.unshift({ type: 'function_call', call_id: 'read-1', name: 'relay_task', arguments: '{"action":"plan"}' });
  assert.deepEqual(providerToolResultDeliveries(body, { type: 'openai', tools: [spec] }), []);
  assert.deepEqual(providerToolResultDeliveries(bodyFor('openai'), { type: 'openai', tools: [{ ...spec, wireName: 'different' }] }), []);
});

test('host namespace mapping comes from the attached catalog and observers cannot replay operations', () => {
  const delivered = [], state = { tools: [{ ...spec, name: 'read', namespace: 'trusted' }], onToolResultDelivered: value => { delivered.push(value); throw new Error('observer failed'); } };
  const observer = providerToolDeliveryObserver(state, 'openai');
  assert.doesNotThrow(() => observer.onAccepted(JSON.stringify(bodyFor('openai'))));
  assert.equal(delivered[0].call.name, 'read'); assert.equal(delivered[0].call.namespace, 'trusted');
  assert.equal(providerToolDeliveryObserver({ tools: [spec] }, 'openai'), undefined);
});

async function apiFixture(t, type, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const runtime = Object.create(ProviderRuntime.prototype);
  Object.assign(runtime, { fetchImpl: fetch, idleTimeoutMs: 2000, emitRun() {}, safe: value => value,
    store: { key: () => '', extraHeaders: () => ({}), redact: value => value } });
  const config = { id: 'fixture', name: 'Fixture', type, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', maxTokens: 1024 };
  return { runtime, config };
}
const finalResponses = {
  openai: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] },
  anthropic: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
  compatible: { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] },
};
for (const type of ['openai', 'anthropic', 'compatible']) test(type + ' adapter acknowledges cached result only after actual HTTP acceptance', async t => {
  const delivered = [], received = [];
  const { runtime, config } = await apiFixture(t, type, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    assert.equal(delivered.length, received.length - 1, 'No early acknowledgment before the request is accepted.');
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(finalResponses[type]));
  });
  const state = { record: { model: 'fixture', messages: structuredClone(histories[type]) }, tools: [spec], controller: new AbortController(), inputImages: [], providerIdleTimeoutMs: 2000, onToolResultDelivered: value => delivered.push(value) };
  const method = type === 'openai' ? 'responses' : type === 'anthropic' ? 'messages' : 'chat';
  assert.equal((await runtime[method](state, config)).text, 'done');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].result.contentItems[0].text, type === 'compatible' ? payload + '\nseparate exact text' : payload);
  await runtime[method](state, config);
  assert.equal(delivered.length, 2, 'A delivered cached transcript receipt is acknowledged again, without executing a tool.');
  assert.equal(received.length, 2);
});

test('HTTP rejection and network uncertainty do not acknowledge retained result texts', async t => {
  const delivered = [];
  const { runtime, config } = await apiFixture(t, 'compatible', async (req, res) => {
    for await (const _ of req) {}
    res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"fixture rejected"}}');
  });
  const observer = providerToolDeliveryObserver({ tools: [spec], onToolResultDelivered: value => delivered.push(value) }, 'compatible');
  await assert.rejects(runtime.request(config, 'chat/completions', bodyFor('compatible'), undefined, undefined, 2000, observer));
  assert.equal(delivered.length, 0);
  runtime.fetchImpl = async () => { throw new TypeError('network failed'); };
  await assert.rejects(runtime.request(config, 'chat/completions', bodyFor('compatible'), undefined, undefined, 2000, observer));
  assert.equal(delivered.length, 0);
});

function codexFixture(receipt, delivered) {
  let finishWrite, serialized;
  const stream = new Writable({ write(chunk, _encoding, callback) { serialized = String(chunk); finishWrite = callback; } });
  stream.on('error', () => {});
  const runtime = Object.create(CodexRuntime.prototype), child = { stdin: stream, killed: false };
  const state = { threadId: 'thread', turnId: 'turn', done: false, messages: new Map(), dynamicTools: [{ type: 'function', name: 'relay_task', inputSchema: { properties: { view: { enum: ['current', 'full'] }, viewHash: {} } } }],
    toolController: new AbortController(), onToolCall: async () => receipt, onToolResultDelivered: value => delivered.push(value) };
  Object.assign(runtime, { child, threads: new Map([['thread', state]]), _emitRun() {} });
  return { runtime, child, finish: cause => finishWrite(cause), serialized: () => serialized };
}
test('native Codex reports the final projected task payload only after successful pipe handoff', async () => {
  const receipt = { success: true, contentItems: [{ type: 'inputText', text: payload }] }, delivered = [];
  const fixture = codexFixture(receipt, delivered);
  await fixture.runtime._dynamicToolCall({ id: 9, params: { threadId: 'thread', turnId: 'turn', callId: 'read-1', tool: 'relay_task', arguments: args } });
  assert.equal(delivered.length, 0);
  assert.deepEqual(JSON.parse(fixture.serialized()).result, receipt);
  fixture.finish(); await tick();
  assert.deepEqual(delivered, [{ call: { name: 'relay_task', arguments: args, callId: 'read-1' }, result: receipt }]);
});
test('native failed write or replaced process does not acknowledge a task payload', async () => {
  for (const replacement of [false, true]) {
    const delivered = [], fixture = codexFixture({ success: true, contentItems: [{ type: 'inputText', text: payload }] }, delivered);
    await fixture.runtime._dynamicToolCall({ id: 9, params: { threadId: 'thread', turnId: 'turn', callId: 'read-1', tool: 'relay_task', arguments: args } });
    if (replacement) fixture.runtime.child = { stdin: {}, killed: false };
    fixture.finish(replacement ? undefined : new Error('pipe failed')); await tick();
    assert.equal(delivered.length, 0);
  }
});

test('schema14 complete, manifest, page and journal responses bypass legacy atomic-step projection unchanged', () => {
  for (const body of [
    { contractDelivery: { version: 1, kind: 'complete', revision: 2 }, contract: { contractVersion: 2, goal: 'canonical', workItems: [] } },
    { contractDelivery: { version: 1, kind: 'manifest', revision: 2 }, nextRead: { action: 'read', view: 'contract', offset: 0 } },
    { contractDelivery: { version: 1, kind: 'page', revision: 2 }, text: '{"exact":"page"}' },
    { view: 'operations', total: 4096, operations: [{ operationId: 'last' }] },
    { view: 'evidence', total: 16384, evidence: [{ id: 'actual' }] },
  ]) {
    const receipt = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ taskSchemaVersion: 14, contractVersion: 2, taskId: 'task', revision: 2, steps: [], ...body }) }] };
    assert.equal(projectNativeTaskResult(receipt, { action: 'read', view: body.view || 'current' }), receipt);
  }
});
