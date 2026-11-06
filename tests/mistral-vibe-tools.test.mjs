import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createVibeToolBridge } from '../lib/mistral-vibe-tools.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const tool = { type: 'function', name: 'relay_fixture', description: 'Fixture action', inputSchema: { type: 'object', properties: { action: { enum: ['read', 'write'] }, value: { type: 'integer' } }, required: ['action'], additionalProperties: false } };
const success = text => ({ success: true, contentItems: [{ type: 'inputText', text }] });

function request(bridge, payload, { method = 'POST', headers = {}, suffix = '' } = {}) {
  return new Promise((resolve, reject) => {
    const authorization = Object.fromEntries(bridge.server.headers.map(item => [item.name, item.value]));
    const session = payload?.method !== 'initialize' && bridge.sessionId ? { 'Mcp-Session-Id': bridge.sessionId } : {};
    const req = http.request(bridge.server.url + suffix, { method, headers: { ...authorization, ...session, 'Content-Type': 'application/json', ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let body; try { body = text ? JSON.parse(text) : undefined; } catch { body = text; } resolve({ status: res.statusCode, headers: res.headers, body, text }); });
    });
    req.on('error', reject); req.end(payload === undefined ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}
const rpc = (bridge, id, method, params = {}, options) => request(bridge, { jsonrpc: '2.0', id, method, params }, options);
async function mcpClient(bridge) {
  const response = await rpc(bridge, 0, 'initialize', { protocolVersion: '2025-06-18' });
  assert.equal(response.status, 200);
  assert.equal(typeof response.headers['mcp-session-id'], 'string');
  const client = { ...bridge, sessionId: response.headers['mcp-session-id'] };
  assert.equal((await request(client, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  return client;
}
async function fixture(t, options = {}) {
  const events = [], calls = [];
  const owner = await createVibeToolBridge({ tools: [tool], onToolCall: async call => { calls.push(call); return success('ok'); }, onEvent: event => events.push(event), ...options });
  t.after(() => owner.close());
  const bridge = await mcpClient(owner);
  const catalog = (await rpc(bridge, 1, 'tools/list')).body.result.tools;
  return { bridge, events, calls, catalog, remote: catalog[0]?.name };
}

test('delivery observer sees exact MCP projection after HTTP finish and cached replay does not re-execute', async t => {
  const delivered = []; let executions = 0;
  const { bridge, remote } = await fixture(t, {
    onToolCall: async () => { executions++; assert.equal(delivered.length, 0); return { success: true, contentItems: [
      { type: 'inputText', text: '{"taskSchemaVersion":14,"contractVersion":2,"exact":"receipt"}' },
      { type: 'inputImage', imageUrl: 'https://unsupported.invalid/image.png' },
    ] }; },
    onToolResultDelivered: value => delivered.push(value),
  });
  const invoke = () => rpc(bridge, 61, 'tools/call', { name: remote, arguments: { action: 'read' } });
  const first = await invoke();
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].result.contentItems.map(item => item.text), first.body.result.content.map(item => item.text));
  assert.match(delivered[0].result.contentItems[1].text, /cannot be sent inline/);
  const replay = await invoke();
  assert.deepEqual(replay.body, first.body);
  assert.equal(executions, 1); assert.equal(delivered.length, 2);
  assert.equal(delivered[0].call.callId, delivered[1].call.callId);
});

test('disconnected MCP response is unacknowledged until its cached receipt is actually delivered', async t => {
  const started = deferred(), release = deferred(), delivered = []; let executions = 0;
  const { bridge, remote } = await fixture(t, {
    onToolCall: async () => { executions++; started.resolve(); await release.promise; return success('retained exact result'); },
    onToolResultDelivered: value => delivered.push(value),
  });
  const payload = { jsonrpc: '2.0', id: 62, method: 'tools/call', params: { name: remote, arguments: { action: 'write' } } };
  const headers = Object.fromEntries(bridge.server.headers.map(item => [item.name, item.value]));
  let disconnected;
  const closed = new Promise(resolve => { disconnected = resolve; });
  const req = http.request(bridge.server.url, { method: 'POST', headers: { ...headers, 'Mcp-Session-Id': bridge.sessionId, 'Content-Type': 'application/json' } });
  req.on('error', disconnected); req.end(JSON.stringify(payload));
  await started.promise; req.destroy(new Error('fixture disconnect')); await closed; await tick(); await tick();
  release.resolve(); await bridge.settle(); await tick();
  assert.equal(delivered.length, 0); assert.equal(executions, 1);
  const replay = await request(bridge, payload);
  assert.equal(replay.body.result.content[0].text, 'retained exact result');
  assert.equal(delivered.length, 1); assert.equal(executions, 1);
});

test('delivery observer failure does not alter a returned MCP receipt or replay an effect', async t => {
  let executions = 0, observed = 0;
  const { bridge, remote } = await fixture(t, {
    onToolCall: async () => { executions++; return success('committed'); },
    onToolResultDelivered: () => { observed++; throw new Error('observer fixture'); },
  });
  for (let pass = 0; pass < 2; pass++) assert.equal((await rpc(bridge, 63, 'tools/call', { name: remote, arguments: { action: 'write' } })).body.result.content[0].text, 'committed');
  assert.equal(executions, 1); assert.equal(observed, 2);
});

test('fresh MCP HTTP sessions can reuse JSON-RPC ids without collisions or stale read receipts', async t => {
  const { bridge, remote, calls } = await fixture(t);
  const open = () => rpc(bridge, 0, 'initialize', { protocolVersion: '2025-06-18' });
  const invoke = (session, value) => rpc(bridge, 1, 'tools/call', { name: remote, arguments: { action: 'read', value } },
    { headers: session.headers['mcp-session-id'] ? { 'Mcp-Session-Id': session.headers['mcp-session-id'] } : {} });
  const first = await open(), firstCall = await invoke(first, 1);
  assert.equal(firstCall.body.result?.isError, false);
  const second = await open(), secondCall = await invoke(second, 2);
  assert.equal(secondCall.body.error, undefined, JSON.stringify(secondCall.body.error));
  assert.equal(secondCall.body.result?.isError, false);
  assert.equal(calls.length, 2);
  const third = await open(), thirdCall = await invoke(third, 1);
  assert.equal(thirdCall.body.result?.isError, false);
  assert.equal(calls.length, 3, 'A fresh session must perform a new read even when its arguments match an earlier read.');
  assert.deepEqual(calls.map(call => call.arguments.value), [1, 2, 1]);
  const ids = [first, second, third].map(response => response.headers['mcp-session-id']);
  assert.ok(ids.every(id => typeof id === 'string' && id.length > 0));
  assert.equal(new Set(ids).size, 3);
});

test('bridge binds only loopback, negotiates supported MCP protocols and preserves exact schemas', async t => {
  const { bridge, catalog } = await fixture(t);
  assert.equal(new URL(bridge.server.url).hostname, '127.0.0.1');
  assert.equal(bridge.server.type, 'http'); assert.equal(bridge.server.name, 'blackice');
  for (const version of ['2025-03-26', '2025-06-18']) {
    const result = await rpc(bridge, 2, 'initialize', { protocolVersion: version });
    assert.equal(result.status, 200); assert.equal(result.body.result.protocolVersion, version);
    assert.deepEqual(result.body.result.capabilities, { tools: { listChanged: false } });
  }
  assert.deepEqual(catalog[0].inputSchema, tool.inputSchema);
  assert.equal(catalog[0].description, tool.description);
  assert.match(catalog[0].name, /^[A-Za-z_][A-Za-z0-9_]*$/);
  assert.ok(bridge.toolNames.has('mcp_blackice.' + catalog[0].name));
  assert.ok(bridge.toolNames.has('blackice_' + catalog[0].name));
  const initialized = await request(bridge, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(initialized.status, 202); assert.equal(initialized.text, '');
});

test('host, path, origin, bearer and method guards cannot invoke a tool or reflect a bearer', async t => {
  const { bridge, remote, calls } = await fixture(t);
  const payload = { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: remote, arguments: { action: 'write' } } };
  for (const [options, status] of [
    [{ headers: { Host: 'unrelated.invalid' } }, 404],
    [{ suffix: '?other=1' }, 404],
    [{ headers: { Origin: 'https://unrelated.invalid' } }, 403],
    [{ headers: { Authorization: 'Bearer wrong' } }, 401],
    [{ method: 'GET' }, 405],
    [{ headers: { 'Content-Type': 'text/plain' } }, 415],
  ]) {
    const result = await request(bridge, payload, options);
    assert.equal(result.status, status); assert.ok(!result.text.includes(bridge.server.headers[0].value));
  }
  assert.equal(calls.length, 0);
});

test('namespaced identities map exactly and cannot collide with ordinary names', async t => {
  const original = structuredClone(tool), calls = [];
  const tools = [{ ...original, name: 'space__run' }, { type: 'namespace', name: 'space', tools: [{ ...original, name: 'run', description: 'Namespaced run' }] }];
  const first = await fixture(t, { tools, onToolCall: async call => { calls.push(call); return success('mapped'); } });
  const second = await fixture(t, { tools });
  assert.deepEqual(first.catalog, second.catalog);
  assert.equal(new Set(first.catalog.map(row => row.name)).size, 2);
  const remote = first.catalog.find(row => row.description === 'Namespaced run').name;
  const result = await rpc(first.bridge, 10, 'tools/call', { name: remote, arguments: { action: 'read', value: 7 } });
  assert.equal(result.body.result.isError, false);
  assert.equal(calls[0].name, 'run'); assert.equal(calls[0].namespace, 'space');
  assert.deepEqual(calls[0].arguments, { action: 'read', value: 7 });
  assert.match(calls[0].callId, /^vibe_tool_/);
});

test('concurrent and completed RPC retries reuse one admitted callback and stable receipt', async t => {
  const entered = deferred(), release = deferred(); let count = 0;
  const { bridge, remote, events } = await fixture(t, { onToolCall: async () => { count++; entered.resolve(); await release.promise; return success('one effect'); } });
  const params = { name: remote, arguments: { action: 'write', value: 9 } };
  const first = rpc(bridge, 'effect-1', 'tools/call', params); await entered.promise;
  const duplicate = rpc(bridge, 'effect-1', 'tools/call', { arguments: { value: 9, action: 'write' }, name: remote });
  const conflict = await rpc(bridge, 'effect-1', 'tools/call', { name: remote, arguments: { action: 'write', value: 10 } });
  assert.equal(conflict.body.error.code, -32600); assert.equal(count, 1);
  release.resolve();
  const [a, b] = await Promise.all([first, duplicate]);
  const replay = await rpc(bridge, 'effect-1', 'tools/call', params);
  assert.deepEqual(a.body, b.body); assert.deepEqual(a.body, replay.body); assert.equal(count, 1);
  assert.equal(events.filter(row => row.type === 'tool.result').length, 1);
  assert.equal(events.filter(row => row.type === 'item' && row.stage === 'completed').length, 1);
});

test('cancellation refuses new effects while close drains an admitted callback and retains its real late receipt', async t => {
  const entered = deferred(), release = deferred(), owner = new AbortController(); let callbackSignal, closeSettled = false, count = 0;
  const { bridge, remote, events } = await fixture(t, { signal: owner.signal, onToolCall: async (_call, { signal }) => { count++; callbackSignal = signal; entered.resolve(); await release.promise; return success('effect completed before cancellation settled'); } });
  const call = rpc(bridge, 10, 'tools/call', { name: remote, arguments: { action: 'write' } }); await entered.promise;
  owner.abort(); assert.equal(callbackSignal.aborted, true);
  const rejected = await rpc(bridge, 11, 'tools/call', { name: remote, arguments: { action: 'write' } });
  assert.equal(rejected.body.error.code, -32000); assert.equal(count, 1);
  const closing = bridge.close().then(() => { closeSettled = true; });
  await tick(); assert.equal(closeSettled, false);
  release.resolve();
  const result = await call; await closing;
  assert.equal(result.body.result.isError, false); assert.equal(closeSettled, true);
  assert.equal(events.find(row => row.type === 'tool.result').success, true);
  assert.equal(events.filter(row => row.type === 'item' && row.stage === 'completed').length, 1);
});

test('MCP cancellation signals only its identified call and settle preserves later continued use', async t => {
  const entered = deferred(), release = deferred(); let callbackSignal;
  const { bridge, remote } = await fixture(t, { onToolCall: async (_call, { signal }) => { callbackSignal = signal; entered.resolve(); await release.promise; return success('settled'); } });
  const call = rpc(bridge, 'cancel-me', 'tools/call', { name: remote, arguments: { action: 'read' } }); await entered.promise;
  const cancelled = await request(bridge, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'cancel-me' } });
  assert.equal(cancelled.status, 202); assert.equal(callbackSignal.aborted, true);
  release.resolve(); await bridge.settle(); await call;
  assert.equal((await rpc(bridge, 15, 'tools/list')).status, 200);
});

test('inline images become MCP image blocks and external image URLs are never fetched or stored in events', async t => {
  const inline = 'data:image/png;base64,aGVsbG8=';
  const { bridge, remote, events } = await fixture(t, { onToolCall: async () => ({ success: true, contentItems: [
    { type: 'inputText', text: 'Screenshot' }, { type: 'inputImage', imageUrl: inline }, { type: 'inputImage', imageUrl: 'https://example.invalid/private-image' },
  ] }) });
  const result = await rpc(bridge, 10, 'tools/call', { name: remote, arguments: { action: 'read' } });
  assert.deepEqual(result.body.result.content[1], { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' });
  assert.match(result.body.result.content[2].text, /No external image URL was fetched/);
  assert.equal(JSON.stringify(events).includes(inline), false);
  assert.equal(JSON.stringify(events).includes('example.invalid'), false);
});

test('callback failures and nested command failures yield consistent failed MCP and BLACKICE receipts', async t => {
  for (const callback of [
    async () => { throw Object.assign(new Error('Fixture failed'), { code: 'FIXTURE_FAILURE' }); },
    async () => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ exitCode: 7 }) }] }),
    async () => ({ success: true, contentItems: [null] }),
  ]) {
    const { bridge, remote, events } = await fixture(t, { onToolCall: callback });
    const result = await rpc(bridge, 10, 'tools/call', { name: remote, arguments: { action: 'read' } });
    assert.equal(result.body.result.isError, true);
    assert.equal(events.find(row => row.type === 'tool.result').success, false);
    assert.equal(events.find(row => row.type === 'item' && row.stage === 'completed').item.success, false);
  }
});

test('invalid, unknown and notification-only tool requests never call the handler', async t => {
  const { bridge, remote, calls } = await fixture(t);
  for (const message of [
    { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'native_shell', arguments: {} } },
    { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: remote, arguments: [] } },
    { jsonrpc: '2.0', id: null, method: 'tools/call', params: { name: remote, arguments: {} } },
    { jsonrpc: '2.0', method: 'tools/call', params: { name: remote, arguments: {} } },
    [{ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: remote, arguments: {} } }],
  ]) {
    const result = await request(bridge, message); assert.ok(result.body.error);
  }
  assert.equal(calls.length, 0);
  assert.equal((await request(bridge, '{')).body.error.code, -32700);
});

test('an already cancelled owner and invalid tool catalogs fail before a listener is created', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createVibeToolBridge({ signal: controller.signal }));
  await assert.rejects(createVibeToolBridge({ tools: [tool, tool], onToolCall: async () => success('unused') }), { code: 'VIBE_TOOL_SCHEMA' });
  await assert.rejects(createVibeToolBridge({ tools: [tool] }), { code: 'VIBE_TOOL_CALLBACK' });
});


test('native invocation guidance maps the actual served catalog and keeps endpoint credentials private', async t => {
  const tools = [
    { ...tool, name: 'relay_workspace' },
    { type: 'namespace', name: 'fixture', tools: [{ ...tool, name: 'read', description: 'Namespaced fixture read' }] },
  ];
  const { bridge, catalog, calls } = await fixture(t, { tools });
  assert.equal(bridge.toolBindings.length, 2);
  for (const binding of bridge.toolBindings) {
    const remote = binding.nativeName.slice('mcp_blackice.'.length);
    assert.ok(catalog.some(entry => entry.name === remote));
    assert.ok(bridge.instructions.includes('await tools.' + binding.nativeName + '(arguments)'));
    const response = await rpc(bridge, binding.nativeName, 'tools/call', { name: remote, arguments: { action: 'read' } });
    assert.equal(response.body.result.isError, false);
    assert.equal(calls.at(-1).name, binding.name);
    assert.equal(calls.at(-1).namespace, binding.namespace);
  }
  assert.match(bridge.instructions, /Use these mapped functions instead of inventing tools\.relay_\*/);
  assert.equal(bridge.instructions.includes(bridge.server.url), false);
  assert.equal(bridge.instructions.includes(bridge.server.headers[0].value), false);
});

test('missing, unknown and terminated MCP sessions cannot invoke a tool', async t => {
  const { bridge, remote, calls } = await fixture(t);
  const params = { name: remote, arguments: { action: 'read', value: 1 } };
  assert.equal((await rpc({ ...bridge, sessionId: null }, 1, 'tools/call', params)).status, 400);
  assert.equal((await rpc({ ...bridge, sessionId: 'unknown' }, 1, 'tools/call', params)).status, 404);
  const closed = await request(bridge, undefined, { method: 'DELETE' });
  assert.equal(closed.status, 204);
  assert.equal((await rpc(bridge, 1, 'tools/call', params)).status, 404);
  assert.equal((await request(bridge, undefined, { method: 'DELETE' })).status, 404);
  assert.equal(calls.length, 0);
  const next = await mcpClient(bridge);
  assert.equal((await rpc(next, 1, 'tools/call', params)).body.result.isError, false);
  assert.equal(calls.length, 1);
});

test('MCP cancellation and DELETE are scoped to the owning session while real pending results drain', async t => {
  const entered = [deferred(), deferred()], release = [deferred(), deferred()], signals = [];
  const { bridge, remote } = await fixture(t, { onToolCall: async (call, { signal }) => {
    const index = call.arguments.value - 1;
    if (index < 2) { signals[index] = signal; entered[index].resolve(); await release[index].promise; }
    return success('Observed result ' + call.arguments.value);
  } });
  const second = await mcpClient(bridge);
  const a = rpc(bridge, 1, 'tools/call', { name: remote, arguments: { action: 'read', value: 1 } });
  await entered[0].promise;
  const b = rpc(second, 1, 'tools/call', { name: remote, arguments: { action: 'read', value: 2 } });
  await entered[1].promise;
  await request(second, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  assert.equal(signals[0].aborted, false);
  assert.equal(signals[1].aborted, true);
  assert.equal((await request(bridge, undefined, { method: 'DELETE' })).status, 204);
  assert.equal(signals[0].aborted, true);
  release.forEach(item => item.resolve());
  const receipts = await Promise.all([a, b]);
  assert.deepEqual(receipts.map(item => item.body.result.content[0].text), ['Observed result 1', 'Observed result 2']);
  await bridge.settle();
  assert.equal((await rpc(bridge, 2, 'tools/list')).status, 404);
  const later = await rpc(second, 2, 'tools/call', { name: remote, arguments: { action: 'read', value: 3 } });
  assert.equal(later.body.result.content[0].text, 'Observed result 3');
});

test('active MCP sessions are bounded and deleting one releases its slot', async t => {
  const bridge = await createVibeToolBridge();
  t.after(() => bridge.close());
  const ids = [];
  for (let i = 0; i < 512; i++) {
    const response = await rpc(bridge, 0, 'initialize', { protocolVersion: '2025-06-18' });
    assert.equal(response.status, 200);
    ids.push(response.headers['mcp-session-id']);
  }
  assert.equal(new Set(ids).size, 512);
  assert.equal((await rpc(bridge, 0, 'initialize')).status, 503);
  assert.equal((await request({ ...bridge, sessionId: ids[0] }, undefined, { method: 'DELETE' })).status, 204);
  assert.equal((await rpc(bridge, 0, 'initialize')).status, 200);
});
