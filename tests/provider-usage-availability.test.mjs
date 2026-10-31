import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { runMetrics } from '../public/editor-model.mjs';
import { aggregateTokenUsage, emptyTokenUsage, reportedTokenCount, tokenUsageMeasurement, tokenUsagePresentation } from '../public/token-usage.mjs';

class FakeCodex extends EventEmitter {
  status() { return { connected: true, authenticated: true, models: [], activeTurns: 0, defaultModel: 'fixture' }; }
  async start() { return this.status(); }
  async close() {}
}

async function streamingHarness(t, replies) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-usage-test-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [] })); return;
    }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const reply = replies[requests.length - 1];
    if (!reply) { response.writeHead(500); response.end('Unexpected extra model request'); return; }
    const delta = reply.tool
      ? { tool_calls: [{ index: 0, id: 'usage-call', type: 'function', function: { name: 'calculator', arguments: '{"a":17,"b":23}' } }] }
      : { content: 'Completed.' };
    // Captured Vireonix SSE completed normally with stop/[DONE] and no usage:
    // verification/api-lane-raw-probes-2026-10-31T00-33-14-251Z.json.
    const events = [
      { model: 'auto', choices: [{ index: 0, delta }] },
      { model: 'auto', choices: [{ index: 0, delta: {}, finish_reason: reply.tool ? 'tool_calls' : 'stop' }] },
    ];
    if (Object.hasOwn(reply, 'usage')) events.push({ choices: [], usage: reply.usage });
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    response.end(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const runtime = await new ProviderRuntime({
    codex: new FakeCodex(), dataDir,
    modelLimitResolver: { enrich: async (_config, models) => models },
  }).init();
  t.after(async () => {
    await runtime.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.match(path.basename(dataDir), /^blackice-usage-test-/);
    await rm(dataDir, { recursive: true, force: true });
  });
  await runtime.saveProvider({
    id: 'usage-fixture', type: 'compatible',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    models: ['fixture'], maxSteps: 4,
  });
  return { runtime, dataDir, requests };
}

test('token availability distinguishes absent/invalid counts from explicitly reported zero', () => {
  for (const value of [undefined, null, '', ' ', false, true, NaN, Infinity, -1, {}]) assert.equal(reportedTokenCount(value), null);
  assert.equal(reportedTokenCount(0), 0);
  assert.equal(reportedTokenCount('0'), 0);
  const missing = tokenUsageMeasurement(), zero = tokenUsageMeasurement({ totalTokens: 0 });
  assert.equal(missing.totalTokens, null);
  assert.equal(missing.availability.totalTokens, 'unavailable');
  assert.equal(zero.totalTokens, 0);
  assert.equal(zero.availability.totalTokens, 'reported');
  assert.equal(tokenUsagePresentation(missing).usageLabel, 'Token usage unavailable');
  assert.equal(tokenUsagePresentation(zero).usageLabel, '0 tokens');
});

test('aggregation keeps a known subtotal as a lower bound in either order', () => {
  const known = tokenUsageMeasurement({ inputTokens: 10, outputTokens: 3, totalTokens: 13 });
  const missing = tokenUsageMeasurement();
  for (const values of [[known, missing], [missing, known]]) {
    const result = aggregateTokenUsage(values);
    assert.equal(result.totalTokens, 13);
    assert.equal(result.availability.totalTokens, 'partial');
    assert.equal(result.samples, 2);
    assert.equal(tokenUsagePresentation(result).usageLabel, 'At least 13 tokens');
  }
  assert.deepEqual(aggregateTokenUsage([emptyTokenUsage(), known]), known);
  assert.equal(aggregateTokenUsage([missing, missing]).totalTokens, null);
  assert.equal(aggregateTokenUsage([{ totalTokens: 7 }, known]).totalTokens, 20);
  assert.equal(aggregateTokenUsage([{ totalTokens: 7 }, known]).availability.totalTokens, 'reported');
});

for (const [name, reply] of [['omitted', {}], ['null', { usage: null }], ['empty object', { usage: {} }]]) {
  test('compatible streaming with ' + name + ' usage completes without inventing measured zero', async t => {
    const { runtime, dataDir, requests } = await streamingHarness(t, [reply]);
    const events = [];
    const result = await runtime.runAgent({ cwd: dataDir, model: 'usage-fixture::fixture', prompt: 'Name three planets.', onEvent: event => events.push(event) });
    assert.equal(result.output, 'Completed.');
    assert.equal(result.usage.totalTokens, null);
    assert.equal(result.usage.inputTokens, null);
    assert.equal(result.usage.outputTokens, null);
    assert.equal(result.usage.last.totalTokens, null);
    assert.equal(result.usage.total.totalTokens, null);
    assert.equal(result.usage.availability.totalTokens, 'unavailable');
    assert.equal(result.usage.samples, 1);
    assert.equal(requests[0].stream_options.include_usage, true);
    assert.equal(events.find(event => event.type === 'usage').usage.totalTokens, null);
  });
}

test('compatible streaming preserves real zero and derives totals only from two known components', async t => {
  const { runtime, dataDir } = await streamingHarness(t, [
    { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
    { usage: { prompt_tokens: 10 } },
    { usage: { prompt_tokens: 10, completion_tokens: 3 } },
    { usage: { total_tokens: 0 } },
  ]);
  const run = () => runtime.runAgent({ cwd: dataDir, model: 'usage-fixture::fixture', prompt: 'Respond.' });
  const zero = await run();
  assert.equal(zero.usage.totalTokens, 0);
  assert.equal(zero.usage.availability.totalTokens, 'reported');
  const inputOnly = await run();
  assert.equal(inputOnly.usage.inputTokens, 10);
  assert.equal(inputOnly.usage.outputTokens, null);
  assert.equal(inputOnly.usage.totalTokens, null);
  const derived = await run();
  assert.equal(derived.usage.totalTokens, 13);
  assert.equal(derived.usage.availability.totalTokens, 'reported');
  const totalOnlyZero = await run();
  assert.equal(totalOnlyZero.usage.totalTokens, 0);
  assert.equal(totalOnlyZero.usage.inputTokens, null);
  assert.equal(totalOnlyZero.usage.availability.totalTokens, 'reported');
});

test('a real tool turn with one missing usage packet retains incomplete totals through follow-up', async t => {
  const { runtime, dataDir, requests } = await streamingHarness(t, [
    { tool: true, usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
    {},
    { usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 } },
  ]);
  let toolCalls = 0;
  const result = await runtime.runAgent({
    cwd: dataDir, model: 'usage-fixture::fixture', prompt: 'Use the calculator to multiply 17 and 23.',
    dynamicTools: [{ name: 'calculator', description: 'Multiply two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } }],
    onToolCall: async call => {
      toolCalls++;
      assert.deepEqual(call.arguments, { a: 17, b: 23 });
      return { success: true, contentItems: [{ type: 'inputText', text: String(call.arguments.a * call.arguments.b) }] };
    },
  });
  assert.equal(toolCalls, 1);
  assert.equal(result.usage.totalTokens, 13);
  assert.equal(result.usage.availability.totalTokens, 'partial');
  assert.equal(result.usage.last.totalTokens, null);
  assert.equal(result.usage.total.availability.totalTokens, 'partial');
  const followup = await runtime.runAgent({ cwd: dataDir, model: 'usage-fixture::fixture', threadId: result.threadId, prompt: 'Continue.' });
  assert.equal(followup.usage.totalTokens, 20);
  assert.equal(followup.usage.availability.totalTokens, 'reported');
  assert.equal(followup.usage.total.totalTokens, 33);
  assert.equal(followup.usage.total.availability.totalTokens, 'partial');
  assert.equal(requests.length, 3);
});

test('classic metrics use node availability despite the old engine zero accumulator', () => {
  const missing = tokenUsageMeasurement(), zero = tokenUsageMeasurement({ totalTokens: 0 });
  const known = tokenUsageMeasurement({ totalTokens: 13 });
  const metrics = usages => runMetrics({
    usage: { totalTokens: usages.reduce((sum, usage) => sum + (usage.totalTokens || 0), 0) },
    nodes: Object.fromEntries(usages.map((usage, index) => [String(index), { status: 'completed', usage }])),
  });
  const absent = metrics([missing]);
  assert.equal(absent.totalTokens, null);
  assert.equal(absent.hasUsage, false);
  assert.equal(absent.usageLabel, 'Token usage unavailable');
  assert.equal(metrics([zero]).hasUsage, true);
  assert.equal(metrics([zero]).usageLabel, '0 tokens');
  const mixed = metrics([known, missing]);
  assert.equal(mixed.totalTokens, 13);
  assert.equal(mixed.usageStatus, 'partial');
  assert.equal(mixed.usageLabel, 'At least 13 tokens');
  assert.match(mixed.usageTitle, /some model calls did not report/);
  const reused = runMetrics({ usage: { totalTokens: 13 }, nodes: { a: { reused: true, usage: missing }, b: { usage: known } } });
  assert.equal(reused.usageStatus, 'reported');
  assert.equal(reused.totalTokens, 13);
});
