import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebMCPClient, WEBMCP_LIMITS } from '../lib/webmcp-client.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const definition = (name = 'fixture_echo', frameId = 'owned-frame') => ({ name, frameId, description: 'An owned fixture echo tool.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } });

async function harness(t, options = {}) {
  const events = new EventEmitter(), commands = [];
  let document = { tabId: 'owned-tab', frameId: 'owned-frame', generation: 1, url: 'http://127.0.0.1:34567/owned-fixture' }, nextId = 0;
  const emit = (method, params) => events.emit('message', { method, params });
  const client = new WebMCPClient({
    timeoutMs: 150,
    getDocument: () => document,
    subscribe: listener => { events.on('message', listener); return () => events.off('message', listener); },
    sendCommand: async (method, params) => {
      commands.push({ method, params });
      if (options.sendCommand) return options.sendCommand(method, params, { emit, commands });
      if (method === 'WebMCP.enable') { emit('WebMCP.toolsAdded', { tools: options.tools || [definition()] }); return {}; }
      if (method === 'WebMCP.invokeTool') return { invocationId: `owned-invocation-${++nextId}` };
      return {};
    }
  });
  t.after(() => client.close());
  await client.start();
  return { client, commands, emit, events, setDocument: value => { document = value; }, currentDocument: () => document };
}

test('discovers current registered tools through enable events without a debugger attachment or page script', async t => {
  const { client, commands } = await harness(t, { tools: [definition(), definition('unrelated_iframe', 'other-frame')] });
  assert.equal(client.status().supported, true);
  assert.equal(client.status().toolCount, 1);
  assert.deepEqual(commands.map(command => command.method), ['WebMCP.enable']);
  assert.equal(client.tools()[0].name, 'fixture_echo');
  assert.equal(client.tools()[0].origin, 'http://127.0.0.1:34567');
  assert.ok(!JSON.stringify(client.status()).includes('/owned-fixture'));
});

test('invocation acknowledgement remains pending until its own completed result, ignoring other consumers', async t => {
  const { client, emit, commands } = await harness(t);
  let settled = false;
  const operation = client.invoke(client.tools()[0], { text: 'owned input' }).finally(() => { settled = true; });
  await tick(); assert.equal(settled, false); assert.equal(client.status().pendingCount, 1);
  emit('WebMCP.toolResponded', { invocationId: 'not-owned', status: 'Completed', output: 'unrelated private output' });
  assert.equal(settled, false); assert.ok(!JSON.stringify(client.status()).includes('private'));
  emit('WebMCP.toolResponded', { invocationId: 'owned-invocation-1', status: 'Completed', output: { echo: 'owned input' } });
  assert.deepEqual(await operation, { invocationId: 'owned-invocation-1', status: 'Completed', output: { echo: 'owned input' } });
  assert.equal(client.status().pendingCount, 0);
  assert.deepEqual(commands[1].params, { frameId: 'owned-frame', toolName: 'fixture_echo', input: { text: 'owned input' } });
});

test('correlates simultaneous invocations and treats Error and Canceled as failures without reflecting details', async t => {
  const { client, emit } = await harness(t), tool = client.tools()[0];
  const first = assert.rejects(client.invoke(tool, { text: 'first' }), cause => cause.code === 'WEBMCP_TOOL_ERROR' && !cause.message.includes('secret'));
  const second = assert.rejects(client.invoke(tool, { text: 'second' }), { code: 'WEBMCP_CANCELLED' });
  await tick();
  emit('WebMCP.toolResponded', { invocationId: 'owned-invocation-2', status: 'Canceled' });
  emit('WebMCP.toolResponded', { invocationId: 'owned-invocation-1', status: 'Error', errorText: 'secret draft', exception: { description: 'secret browser state' } });
  await Promise.all([first, second]); assert.equal(client.status().pendingCount, 0);
});

test('the pre-current Success status and a missing completed payload do not become answers', async t => {
  const { client, emit } = await harness(t), tool = client.tools()[0];
  for (const [index, value] of [{ status: 'Success', output: 'old status' }, { status: 'Completed' }].entries()) {
    const operation = assert.rejects(client.invoke(tool, { text: 'fixture' }), { code: 'WEBMCP_PROTOCOL' });
    await tick(); emit('WebMCP.toolResponded', { invocationId: `owned-invocation-${index + 1}`, ...value }); await operation;
  }
});

test('aborted invocation sends one bounded cancel without declaring the page action undone', async t => {
  const { client, commands, emit } = await harness(t), controller = new AbortController();
  const operation = assert.rejects(client.invoke(client.tools()[0], { text: 'fixture' }, { signal: controller.signal }), cause => cause.code === 'ABORT_ERR' && cause.outcome === 'unknown');
  await tick(); controller.abort(); await operation; await tick();
  assert.equal(commands.filter(command => command.method === 'WebMCP.cancelInvocation').length, 1);
  emit('WebMCP.toolResponded', { invocationId: 'owned-invocation-1', status: 'Completed', output: 'late answer' });
  assert.equal(client.status().pendingCount, 0);
});

test('cancellation before a delayed acknowledgement cancels only that eventual invocation and never resubmits', async t => {
  const receipt = deferred();
  const { client, commands } = await harness(t, { sendCommand: async (method, params, { emit }) => {
    if (method === 'WebMCP.enable') { emit('WebMCP.toolsAdded', { tools: [definition()] }); return {}; }
    if (method === 'WebMCP.invokeTool') return receipt.promise;
    return {};
  } });
  const controller = new AbortController();
  const operation = assert.rejects(client.invoke(client.tools()[0], { text: 'fixture' }, { signal: controller.signal }), { code: 'ABORT_ERR' });
  await tick(); controller.abort(); await operation;
  receipt.resolve({ invocationId: 'late-owned-receipt' }); await tick();
  assert.equal(commands.filter(command => command.method === 'WebMCP.invokeTool').length, 1);
  assert.deepEqual(commands.at(-1), { method: 'WebMCP.cancelInvocation', params: { invocationId: 'late-owned-receipt' } });
});

test('an uncooperative transport cannot prevent timeout or local cleanup', async t => {
  const { client, commands } = await harness(t, { sendCommand: async (method, params, { emit }) => {
    if (method === 'WebMCP.enable') { emit('WebMCP.toolsAdded', { tools: [definition()] }); return {}; }
    return new Promise(() => {});
  } });
  await assert.rejects(client.invoke(client.tools()[0], { text: 'fixture' }, { timeoutMs: 10 }), cause => cause.code === 'WEBMCP_TIMEOUT' && cause.outcome === 'unknown');
  assert.equal(client.status().pendingCount, 0); assert.equal(commands.length, 2);
  client.close(); assert.equal(client.status().state, 'closed');
});

test('navigation invalidates handles and pending results even if Chromium reuses the same frame ID', async t => {
  const { client, setDocument, currentDocument, emit } = await harness(t), oldTool = client.tools()[0];
  const operation = assert.rejects(client.invoke(oldTool, { text: 'fixture' }), { code: 'WEBMCP_DOCUMENT_CHANGED' });
  await tick(); setDocument({ ...currentDocument(), generation: 2 });
  emit('WebMCP.toolResponded', { invocationId: 'owned-invocation-1', status: 'Completed', output: 'wrong document' });
  await operation; assert.equal(client.status().toolCount, 0);
  await client.start(); assert.notEqual(client.tools()[0].id, oldTool.id);
  await assert.rejects(client.invoke(oldTool, { text: 'fixture' }), { code: 'WEBMCP_STALE_TOOL' });
});

test('tool removal and same-name replacement retire prior handles and pending ownership', async t => {
  const { client, emit } = await harness(t), original = client.tools()[0];
  const operation = assert.rejects(client.invoke(original, { text: 'fixture' }), { code: 'WEBMCP_TOOL_CHANGED' });
  await tick(); emit('WebMCP.toolsAdded', { tools: [definition()] }); await operation;
  const replacement = client.tools()[0]; assert.notEqual(replacement.id, original.id);
  await assert.rejects(client.invoke(original, { text: 'fixture' }), { code: 'WEBMCP_STALE_TOOL' });
  emit('WebMCP.toolsRemoved', { tools: [{ name: replacement.name, frameId: replacement.frameId }] });
  assert.equal(client.tools().length, 0);
  await assert.rejects(client.invoke(replacement, { text: 'fixture' }), { code: 'WEBMCP_STALE_TOOL' });
});

test('forged handles, non-JSON input, and oversized input never dispatch a tool', async t => {
  const { client, commands } = await harness(t), tool = client.tools()[0];
  await assert.rejects(client.invoke({ ...tool, name: 'another_tool' }, {}), { code: 'WEBMCP_STALE_TOOL' });
  await assert.rejects(client.invoke(tool, { text: () => 'not JSON' }), { code: 'WEBMCP_ARGUMENTS' });
  await assert.rejects(client.invoke(tool, { text: 'x'.repeat(WEBMCP_LIMITS.inputBytes) }), { code: 'WEBMCP_ARGUMENTS' });
  assert.deepEqual(commands.map(command => command.method), ['WebMCP.enable']);
});

test('malformed catalogs never create executable handles and empty support stays distinct from unsupported', async t => {
  const { client } = await harness(t, { tools: [{ ...definition(), inputSchema: 'not a schema' }, { ...definition('bad name') }, definition('wrong_frame', 'another-frame')] });
  assert.equal(client.status().supported, true); assert.equal(client.status().toolCount, 0); assert.equal(client.status().ready, true);
  const unavailable = new WebMCPClient({ sendCommand: async () => { throw Object.assign(Error('private detail'), { code: -32601 }); }, subscribe: () => () => {}, getDocument: () => ({ tabId: 'tab', frameId: 'frame', generation: 1, url: 'https://example.test/' }) });
  t.after(() => unavailable.close());
  await assert.rejects(unavailable.start(), { code: 'WEBMCP_UNSUPPORTED' });
  assert.equal(unavailable.status().supported, false); assert.ok(!JSON.stringify(unavailable.status()).includes('private detail'));
});

test('changing only the origin retires the document and close removes the event subscriber', async t => {
  const { client, events, setDocument, currentDocument } = await harness(t), tool = client.tools()[0];
  setDocument({ ...currentDocument(), url: 'https://other.example/' });
  await assert.rejects(client.invoke(tool, {}), { code: 'WEBMCP_DOCUMENT_CHANGED' });
  assert.equal(events.listenerCount('message'), 0);
  client.close(); client.close(); assert.equal(client.status().state, 'closed');
});
