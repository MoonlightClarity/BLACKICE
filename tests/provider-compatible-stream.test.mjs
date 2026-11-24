import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { createCompatibleStreamAccumulator } from '../lib/provider-compatible-stream.mjs';
import { estimateContextTokens, summarySource } from '../lib/context.mjs';

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


for (const providerDefault of [false, true]) test('compatible runtime replays exact signatures and reasoning across two streamed tool turns and a restored thread (' + (providerDefault ? 'provider-default, JSON reply' : 'configured output, streamed reply') + ')', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-stream-signatures-test-'));
  const runtimes = new Set(), requests = [], toolCalls = [], events = [];
  const tool = { type: 'function', name: 'relay_observe', description: 'Read a fixture fact.', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false } };
  const metadata = value => ({ google: { thought_signature: value }, opaque: { flags: ['keep', null, false] } });
  const firstMetadata = metadata('message-first+/=='), secondMetadata = metadata('message-second+/=='), finalMetadata = metadata('message-final+/==');
  const reasoning = ['First α\n思考 🧭', 'Second β\nexact fields', 'Final γ\ncomplete', 'Restored δ\noriginal provenance'];
  const providerId = providerDefault ? 'local_llamacpp' : 'signature-fixture';
  const call = (id, target, signature) => ({ id, type: 'function', function: { name: 'relay_observe', arguments: JSON.stringify({ target }) }, extra_content: metadata(signature) });
  const firstCalls = [call('call-a', 'first', 'tool-first-a+/=='), call('call-b', 'parallel', 'tool-first-b+/==')];
  const secondCalls = [call('call-c', 'second', 'tool-second-c+/==')];
  const fetchImpl = async (url, options) => {
    const endpoint = new URL(url);
    assert.equal(endpoint.hostname, '127.0.0.1', 'all provider traffic stays inside the injected fixture');
    if (options.method === 'GET') return Response.json({ data: [] });
    assert.equal(endpoint.pathname, '/v1/chat/completions');
    requests.push(JSON.parse(options.body));
    if (providerDefault) {
      for (const field of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
        assert.equal(Object.hasOwn(requests.at(-1), field), false, field + ' stays omitted under provider-default');
      }
    } else assert.ok(Number.isSafeInteger(requests.at(-1).max_tokens) && requests.at(-1).max_tokens > 0);
    let chunks;
    if (requests.length === 1) {
      chunks = [
        { reasoning_content: 'First α\n', tool_calls: [{ ...firstCalls[0], extra_content: undefined }] },
        { reasoning_content: null, tool_calls: [{ ...firstCalls[1], extra_content: undefined }] },
        { reasoning_content: '思考 🧭', extra_content: firstMetadata, tool_calls: [{ id: 'call-b', extra_content: firstCalls[1].extra_content }, { id: 'call-a', extra_content: firstCalls[0].extra_content }] },
      ];
    } else if (requests.length === 2) {
      chunks = [
        { reasoning_content: 'Second β\n', tool_calls: [{ index: 0, id: 'call-c', type: 'function', function: { name: 'relay_', arguments: '{"target":' } }] },
        { reasoning_content: '', tool_calls: [{ index: 0, function: { name: 'observe', arguments: '"second"}' } }] },
        { reasoning_content: 'exact fields', extra_content: secondMetadata, tool_calls: [{ index: 0, extra_content: secondCalls[0].extra_content }] },
      ];
    } else {
      assert.ok(requests.length <= 4, 'the fixture must finish without retrying a completed tool');
      const content = requests.length === 3 ? 'Two tool turns complete.' : 'Restored context complete.';
      if (providerDefault && requests.length === 4) {
        return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content, reasoning_content: reasoning[3], extra_content: finalMetadata }, finish_reason: 'stop' }] });
      }
      chunks = [{ reasoning_content: reasoning[requests.length - 1] }, { content, extra_content: finalMetadata }, { reasoning_content: null }];
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
  await runtime.saveProvider({ id: providerId, preset: providerDefault ? 'llamacpp' : 'compatible', type: 'compatible', baseUrl: providerDefault ? 'http://127.0.0.1:8080/v1' : 'http://127.0.0.1:1/v1', models: ['fixture-model'], maxSteps: 4, ...(providerDefault ? { outputTokenPolicy: 'provider-default' } : { outputTokenPolicy: 'configured-limit', maxTokens: 8192 }) });
  const result = await runtime.runAgent({
    cwd: dataDir, prompt: 'Read both facts, then confirm the next step.', model: providerId + '::fixture-model', dynamicTools: [tool],
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
  const expectedFirst = { role: 'assistant', content: null, reasoning_content: reasoning[0], extra_content: firstMetadata, tool_calls: firstCalls };
  const expectedSecond = { role: 'assistant', content: null, reasoning_content: reasoning[1], extra_content: secondMetadata, tool_calls: secondCalls };
  assert.deepEqual(signedMessages(requests[1]), [expectedFirst]);
  assert.deepEqual(signedMessages(requests[2]), [expectedFirst, expectedSecond]);
  assert.deepEqual(requests[2].messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['call-a', 'call-b', 'call-c']);
  assert.ok(events.some(event => event.type === 'delta' && event.delta === 'Two tool turns complete.'));

  const durable = await runtime.readThread(result.threadId);
  assert.deepEqual(signedMessages(durable), [expectedFirst, expectedSecond]);
  assert.equal(durable.messages.find(message => message.role === 'assistant' && message.content === result.output).reasoning_content, reasoning[2]);
  if (providerDefault) assert.deepEqual(durable.outputTokenPolicy, { version: 1, policy: 'provider-default' });
  await runtime.close(); runtimes.delete(runtime);
  const restored = await createRuntime();
  const followup = await restored.runAgent({ cwd: dataDir, prompt: 'Continue using the saved facts.', model: providerId + '::fixture-model', threadId: result.threadId, onEvent: event => events.push(event) });
  assert.equal(followup.threadId, result.threadId);
  assert.equal(followup.output, 'Restored context complete.');
  assert.equal(requests.length, 4);
  assert.deepEqual(signedMessages(requests[3]), [expectedFirst, expectedSecond]);
  assert.deepEqual(requests[3].messages.find(message => message.role === 'assistant' && message.content === 'Two tool turns complete.').extra_content, finalMetadata);
  assert.equal(requests[3].messages.find(message => message.role === 'assistant' && message.content === 'Two tool turns complete.').reasoning_content, reasoning[2]);
  const restoredRecord = await restored.readThread(result.threadId);
  assert.deepEqual(signedMessages(restoredRecord), [expectedFirst, expectedSecond]);
  const restoredReply = restoredRecord.messages.find(message => message.role === 'assistant' && message.content === followup.output);
  assert.equal(restoredReply.reasoning_content, reasoning[3], 'streamed and complete JSON messages preserve the provider field');
  assert.deepEqual(restoredReply.extra_content, finalMetadata);
  for (const request of [...requests, restoredRecord]) {
    for (const message of request.messages) {
      if (message.role !== 'assistant') assert.equal(Object.hasOwn(message, 'reasoning_content'), false);
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content) || '';
      assert.equal(reasoning.some(value => content.includes(value)), false, 'reasoning never becomes visible content or instructions');
    }
  }
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.delta).join(''), 'Two tool turns complete.Restored context complete.');
});

test('streamed reasoning keeps exact Unicode fragments beside content, calls and opaque metadata', () => {
  const stream = createCompatibleStreamAccumulator();
  stream.append({ reasoning_content: 'α\n', content: 'Visible ', tool_calls: [{ index: 0, id: 'original-call', type: 'function', function: { name: 'relay_', arguments: '{"target":' } }] });
  stream.append({ content: 'answer', extra_content: { vendor: { signature: 'opaque+/==' } }, tool_calls: [{ index: 0, function: { name: 'observe', arguments: '"fact"}' } }] });
  stream.append({ reasoning_content: '思考 🧭\n' });
  stream.append({ reasoning_content: 'finished' });
  stream.append({ reasoning_content: null });
  const expected = {
    role: 'assistant', content: 'Visible answer', reasoning_content: 'α\n思考 🧭\nfinished',
    extra_content: { vendor: { signature: 'opaque+/==' } },
    tool_calls: [{ id: 'original-call', type: 'function', function: { name: 'relay_observe', arguments: '{"target":"fact"}' } }],
  };
  assert.deepEqual(stream.message('Visible answer'), expected);
  assert.deepEqual(stream.message('Visible answer'), expected, 'reading a message never appends a fragment again');
  const { reasoning_content, ...withoutReasoning } = expected;
  assert.ok(estimateContextTokens([expected]) > estimateContextTokens([withoutReasoning]), 'existing context accounting includes reasoning');
  assert.deepEqual(JSON.parse(summarySource([expected])), [expected], 'existing history serialization preserves the same assistant field');
});

test('reasoning omission, null and explicit empty strings remain distinct without accepting aliases', () => {
  const stream = createCompatibleStreamAccumulator();
  for (const delta of [{}, { reasoning_content: undefined }, { reasoning_content: null }, { reasoning: 'unrelated field', reasoning_details: [{ text: 'unrelated detail' }] }]) {
    stream.append(delta);
    assert.deepEqual(stream.message('Visible'), { role: 'assistant', content: 'Visible' });
  }
  stream.append({ reasoning_content: '' });
  assert.deepEqual(stream.message(), { role: 'assistant', content: null, reasoning_content: '' });
  stream.append({ reasoning_content: null });
  assert.equal(stream.message().reasoning_content, '');
  stream.append({ reasoning_content: 'kept' });
  stream.append({ reasoning_content: null });
  assert.equal(stream.message().reasoning_content, 'kept');
});

for (const [kind, value] of [['number', 0], ['boolean', false], ['array', []], ['object', { text: 'not a text fragment' }]]) {
  test('malformed ' + kind + ' reasoning fails as PROVIDER_PROTOCOL before accepting that delta tool call', () => {
    const stream = createCompatibleStreamAccumulator();
    stream.append({ reasoning_content: 'previous valid text' });
    assert.throws(() => stream.append({
      reasoning_content: value,
      tool_calls: [{ id: 'must-not-appear', type: 'function', function: { name: 'relay_observe', arguments: '{}' } }],
    }), cause => cause.code === 'PROVIDER_PROTOCOL');
    assert.deepEqual(stream.message(), { role: 'assistant', content: null, reasoning_content: 'previous valid text' });
  });
}

test('separate response accumulators and returned message mutations cannot share reasoning', () => {
  const first = createCompatibleStreamAccumulator(), second = createCompatibleStreamAccumulator();
  first.append({ reasoning_content: 'first response' });
  const copy = first.message();
  copy.reasoning_content = 'caller mutation';
  second.append({ reasoning_content: 'second response' });
  assert.equal(first.message().reasoning_content, 'first response');
  assert.equal(second.message().reasoning_content, 'second response');
  assert.equal(Object.hasOwn(createCompatibleStreamAccumulator().message(), 'reasoning_content'), false);
});

test('malformed streamed reasoning rejects a buffered complete call without tool dispatch or retry', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-stream-reasoning-invalid-test-'));
  const codex = new EventEmitter(), requests = [], tools = [], events = [];
  codex.status = () => ({ connected: false, authenticated: false, models: [], activeTurns: 0 });
  codex.close = async () => {};
  const tool = { type: 'function', name: 'relay_observe', description: 'Observe a fixture fact.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
  const fetchImpl = async (url, options) => {
    assert.equal(new URL(url).hostname, '127.0.0.1', 'all traffic is intercepted by the fixture');
    if (options.method === 'GET') return Response.json({ data: [] });
    requests.push(JSON.parse(options.body));
    assert.equal(requests.length, 1, 'malformed completed responses are not retried');
    const frames = [
      { choices: [{ index: 0, delta: { reasoning_content: 'valid prefix', tool_calls: [{ id: 'buffered-original-id', type: 'function', function: { name: 'relay_observe', arguments: '{}' } }] } }] },
      { choices: [{ index: 0, delta: { reasoning_content: { text: 'invalid fragment' } } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ];
    return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const runtime = await new ProviderRuntime({ codex, dataDir, fetchImpl, modelLimitResolver: { enrich: async (_config, models) => models } }).init();
  t.after(async () => {
    await runtime.close();
    assert.match(path.basename(dataDir), /^blackice-stream-reasoning-invalid-test-/);
    await rm(dataDir, { recursive: true, force: true });
  });
  await runtime.saveProvider({ id: 'malformed-reasoning', preset: 'compatible', type: 'compatible', baseUrl: 'http://127.0.0.1:1/v1', models: ['fixture-model'], maxSteps: 4 });
  await assert.rejects(runtime.runAgent({
    cwd: dataDir, prompt: 'Observe the fixture.', model: 'malformed-reasoning::fixture-model', dynamicTools: [tool],
    onEvent: event => events.push(event),
    onToolCall: async invocation => { tools.push(invocation); return { success: true, contentItems: [{ type: 'inputText', text: 'must not execute' }] }; },
  }), cause => cause.code === 'PROVIDER_PROTOCOL');
  assert.equal(requests.length, 1);
  assert.deepEqual(tools, [], 'a buffered complete call is never dispatched from the rejected response');
  assert.deepEqual(events.filter(event => event.type === 'delta'), []);
});
