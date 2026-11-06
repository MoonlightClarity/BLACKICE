import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { createCompatibleStreamAccumulator } from '../lib/provider-compatible-stream.mjs';

test('Gemini tool and message signatures survive late metadata chunks without joining separate calls', () => {
  const stream = createCompatibleStreamAccumulator();
  stream.append({ tool_calls: [{ id: 'call_weather', type: 'function', function: { name: 'weather', arguments: '{"city":"Boston"}' } }] });
  stream.append({ tool_calls: [{ id: 'call_time', type: 'function', function: { name: 'time', arguments: '{"zone":"UTC"}' } }] });
  stream.append({
    extra_content: { google: { thought_signature: 'message-signature+/==' }, provider: { cache: ['opaque', null, 3] } },
    tool_calls: [{ id: 'call_weather', extra_content: { google: { thought_signature: 'weather-signature+/==' } } }],
  });
  stream.append({ tool_calls: [{ id: 'call_time', extra_content: { google: { thought_signature: 'time-signature+/==' } } }] });
  const message = stream.message();
  assert.deepEqual(message.extra_content, { google: { thought_signature: 'message-signature+/==' }, provider: { cache: ['opaque', null, 3] } });
  assert.deepEqual(message.tool_calls, [
    { id: 'call_weather', type: 'function', function: { name: 'weather', arguments: '{"city":"Boston"}' }, extra_content: { google: { thought_signature: 'weather-signature+/==' } } },
    { id: 'call_time', type: 'function', function: { name: 'time', arguments: '{"zone":"UTC"}' }, extra_content: { google: { thought_signature: 'time-signature+/==' } } },
  ]);
  assert.equal(message.content, null);
});

test('indexed parallel calls keep exact name and JSON fragments and are returned in index order', () => {
  const stream = createCompatibleStreamAccumulator();
  stream.append({ tool_calls: [{ index: 1, id: 'second', type: 'function', function: { name: 'get_', arguments: '{"zone":' } }] });
  stream.append({ tool_calls: [{ index: 0, id: 'first', type: 'function', function: { name: 'get_', arguments: '{"city":' }, extra_content: { vendor: { value: 7 } } }] });
  stream.append({ tool_calls: [
    { index: 1, function: { name: 'time', arguments: '"UTC"}' } },
    { index: 0, function: { name: 'weather', arguments: '"Boston"}' } },
  ] });
  assert.deepEqual(stream.message('Working.').tool_calls, [
    { id: 'first', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Boston"}' }, extra_content: { vendor: { value: 7 } } },
    { id: 'second', type: 'function', function: { name: 'get_time', arguments: '{"zone":"UTC"}' } },
  ]);
  assert.equal(stream.message('Working.').content, 'Working.');
  assert.equal(Object.hasOwn(stream.message().tool_calls[0], 'index'), false);
});

test('position-only fragments can acquire IDs without collapsing parallel calls', () => {
  const stream = createCompatibleStreamAccumulator();
  stream.append({ tool_calls: [
    { function: { name: 'first', arguments: '{"value":' } },
    { function: { name: 'second', arguments: '{"value":' } },
  ] });
  stream.append({ tool_calls: [
    { id: 'a', function: { arguments: '1}' } },
    { id: 'b', function: { arguments: '2}' } },
  ] });
  stream.append({ tool_calls: [{ id: 'b', extra_content: { google: { thought_signature: 'b-only' } } }] });
  const calls = stream.message().tool_calls;
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => [call.id, call.function.name, call.function.arguments]), [['a', 'first', '{"value":1}'], ['b', 'second', '{"value":2}']]);
  assert.equal(Object.hasOwn(calls[0], 'extra_content'), false);
  assert.deepEqual(calls[1].extra_content, { google: { thought_signature: 'b-only' } });
});

test('opaque metadata is copied exactly and merging unrelated fields never concatenates signatures', () => {
  const stream = createCompatibleStreamAccumulator();
  const extra = { google: { thought_signature: 'unaltered==', other: { flag: false } }, data: ['x', 3, null] };
  stream.append({ extra_content: extra, tool_calls: [{ index: 0, id: 'a', function: { name: 'observe', arguments: '{}' }, extra_content: extra }] });
  stream.append({ extra_content: { google: { route: 'preserved' } }, tool_calls: [{ index: 0, extra_content: { vendor: { request: 4 } } }] });
  stream.append({ extra_content: null, tool_calls: [{ index: 0, extra_content: null }] });
  extra.google.thought_signature = 'changed-by-caller';
  const message = stream.message();
  assert.equal(message.extra_content.google.thought_signature, 'unaltered==');
  assert.equal(message.extra_content.google.route, 'preserved');
  assert.deepEqual(message.tool_calls[0].extra_content.vendor, { request: 4 });
  assert.equal(message.tool_calls[0].extra_content.google.thought_signature, 'unaltered==');
  message.tool_calls[0].extra_content.google.thought_signature = 'changed-output';
  assert.equal(stream.message().tool_calls[0].extra_content.google.thought_signature, 'unaltered==');
});

test('each response owns separate metadata and never invents a signature or missing call ID', () => {
  const first = createCompatibleStreamAccumulator(), second = createCompatibleStreamAccumulator();
  first.append({ extra_content: { google: { thought_signature: 'first-response-only' } } });
  second.append({ tool_calls: [{ function: { name: 'observe', arguments: '{}' } }] });
  const message = second.message('Hello');
  assert.equal(message.content, 'Hello');
  assert.equal(Object.hasOwn(message, 'extra_content'), false);
  assert.equal(Object.hasOwn(message.tool_calls[0], 'extra_content'), false);
  assert.equal(message.tool_calls[0].id, '');
  assert.deepEqual(createCompatibleStreamAccumulator().message(), { role: 'assistant', content: null });
});


test('compatible runtime replays exact signatures across two streamed tool turns and a restored thread', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-stream-signatures-test-'));
  const runtimes = new Set(), requests = [], toolCalls = [], events = [];
  const tool = { type: 'function', name: 'relay_observe', description: 'Read a fixture fact.', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false } };
  const metadata = value => ({ google: { thought_signature: value }, opaque: { flags: ['keep', null, false] } });
  const firstMetadata = metadata('message-first+/=='), secondMetadata = metadata('message-second+/=='), finalMetadata = metadata('message-final+/==');
  const call = (id, target, signature) => ({ id, type: 'function', function: { name: 'relay_observe', arguments: JSON.stringify({ target }) }, extra_content: metadata(signature) });
  const firstCalls = [call('call-a', 'first', 'tool-first-a+/=='), call('call-b', 'parallel', 'tool-first-b+/==')];
  const secondCalls = [call('call-c', 'second', 'tool-second-c+/==')];
  const fetchImpl = async (url, options) => {
    const endpoint = new URL(url);
    assert.equal(endpoint.hostname, '127.0.0.1', 'all provider traffic stays inside the injected fixture');
    if (options.method === 'GET') return Response.json({ data: [] });
    assert.equal(endpoint.pathname, '/v1/chat/completions');
    requests.push(JSON.parse(options.body));
    let chunks;
    if (requests.length === 1) {
      chunks = [
        { tool_calls: [{ ...firstCalls[0], extra_content: undefined }] },
        { tool_calls: [{ ...firstCalls[1], extra_content: undefined }] },
        { extra_content: firstMetadata, tool_calls: [{ id: 'call-b', extra_content: firstCalls[1].extra_content }, { id: 'call-a', extra_content: firstCalls[0].extra_content }] },
      ];
    } else if (requests.length === 2) {
      chunks = [
        { tool_calls: [{ index: 0, id: 'call-c', type: 'function', function: { name: 'relay_', arguments: '{"target":' } }] },
        { tool_calls: [{ index: 0, function: { name: 'observe', arguments: '"second"}' } }] },
        { extra_content: secondMetadata, tool_calls: [{ index: 0, extra_content: secondCalls[0].extra_content }] },
      ];
    } else {
      assert.ok(requests.length <= 4, 'the fixture must finish without retrying a completed tool');
      chunks = [{ content: requests.length === 3 ? 'Two tool turns complete.' : 'Restored context complete.', extra_content: finalMetadata }];
    }
    const frames = chunks.map(delta => ({ choices: [{ index: 0, delta }] }));
    frames.push({ choices: [{ index: 0, delta: {}, finish_reason: requests.length <= 2 ? 'tool_calls' : 'stop' }] });
    return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const createRuntime = async () => {
    const codex = new EventEmitter();
    codex.status = () => ({ connected: false, authenticated: false, models: [], activeTurns: 0 });
    codex.close = async () => {};
    const runtime = await new ProviderRuntime({ codex, dataDir, fetchImpl, modelLimitResolver: { enrich: async (_config, models) => models } }).init();
    runtimes.add(runtime);
    return runtime;
  };
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    assert.match(path.basename(dataDir), /^blackice-stream-signatures-test-/);
    await rm(dataDir, { recursive: true, force: true });
  });
  const runtime = await createRuntime();
  await runtime.saveProvider({ id: 'signature-fixture', preset: 'compatible', type: 'compatible', baseUrl: 'http://127.0.0.1:1/v1', models: ['fixture-model'], maxSteps: 4 });
  const result = await runtime.runAgent({
    cwd: dataDir, prompt: 'Read both facts, then confirm the next step.', model: 'signature-fixture::fixture-model', dynamicTools: [tool],
    onEvent: event => events.push(event),
    onToolCall: async invocation => {
      toolCalls.push(invocation);
      return { success: true, contentItems: [{ type: 'inputText', text: 'Observed ' + invocation.arguments.target }] };
    },
  });
  assert.equal(result.output, 'Two tool turns complete.');
  assert.deepEqual(toolCalls.map(item => item.arguments.target), ['first', 'parallel', 'second']);
  assert.equal(requests.length, 3);
  const signedMessages = request => request.messages.filter(message => message.role === 'assistant' && message.tool_calls);
  const expectedFirst = { role: 'assistant', content: null, extra_content: firstMetadata, tool_calls: firstCalls };
  const expectedSecond = { role: 'assistant', content: null, extra_content: secondMetadata, tool_calls: secondCalls };
  assert.deepEqual(signedMessages(requests[1]), [expectedFirst]);
  assert.deepEqual(signedMessages(requests[2]), [expectedFirst, expectedSecond]);
  assert.deepEqual(requests[2].messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['call-a', 'call-b', 'call-c']);
  assert.ok(events.some(event => event.type === 'delta' && event.delta === 'Two tool turns complete.'));

  await runtime.close(); runtimes.delete(runtime);
  const restored = await createRuntime();
  const followup = await restored.runAgent({ cwd: dataDir, prompt: 'Continue using the saved facts.', model: 'signature-fixture::fixture-model', threadId: result.threadId });
  assert.equal(followup.threadId, result.threadId);
  assert.equal(followup.output, 'Restored context complete.');
  assert.equal(requests.length, 4);
  assert.deepEqual(signedMessages(requests[3]), [expectedFirst, expectedSecond]);
  assert.deepEqual(requests[3].messages.find(message => message.role === 'assistant' && message.content === 'Two tool turns complete.').extra_content, finalMetadata);
});
