import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';

class NoNativeProvider extends EventEmitter {
  calls = 0;
  status() { return { connected: false, authenticated: false, models: [] }; }
  async runAgent() { this.calls++; throw new Error('Native inference is outside this local fixture.'); }
  async close() {}
}
const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const json = (response, body) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };

async function fixture(t, scenario) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-output-budget-'));
  const requests = [], events = [], codex = new NoNativeProvider();
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') return json(response, { data: [{
      id: 'fixture', context_length: 256000,
      top_provider: { max_completion_tokens: scenario.modelCapacity },
      supported_parameters: ['response_format', 'structured_outputs']
    }] });
    let raw = ''; for await (const chunk of request) raw += chunk;
    requests.push({ url: request.url, body: JSON.parse(raw), authorization: request.headers.authorization });
    const completion = scenario.effectiveBudget - 2;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const packet of [
      { model: 'fixture', choices: [{ index: 0, delta: { content: '{"answer":' }, finish_reason: null }] },
      { model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'length', native_finish_reason: 'max_tokens' }] },
      { choices: [], usage: { prompt_tokens: 9566, completion_tokens: completion, total_tokens: 9566 + completion, cost: 0,
        prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: Math.min(completion, 7124) } } }
    ]) response.write('data: ' + JSON.stringify(packet) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let runtime;
  t.after(async () => {
    await runtime?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(codex.calls, 0);
    await rm(dataDir, { recursive: true, force: true });
  });
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
  runtime = await new ProviderRuntime({
    codex, dataDir, runTimeoutMs: 5000, idleTimeoutMs: 2000,
    modelLimitResolver: { enrich: async (_config, models) => models },
    fetchImpl: (url, options) => {
      assert.ok(String(url).startsWith(baseUrl + '/'), 'fixture requests must remain on its loopback server');
      return fetch(url, options);
    }
  }).init();
  await runtime.saveProvider({ id: 'budget', type: 'compatible', baseUrl, models: ['fixture'], maxTokens: scenario.configuredBudget, ...(scenario.providerContext ? { context: scenario.providerContext } : {}) });
  return { dataDir, runtime, requests, events };
}

const scenarios = [
  { name: 'truncation reports the actual 8192 request under configured 16384 and model capacity 64000', configuredBudget: 16384, modelCapacity: 64000, effectiveBudget: 8192, providerContext: { outputReserveTokens: 16384 }, context: { outputReserveTokens: 8192 } },
  { name: 'truncation reports the configured budget when configuration is the limiting bound', configuredBudget: 2048, modelCapacity: 64000, effectiveBudget: 2048 },
  { name: 'truncation reports the model budget when saved model capacity is the limiting bound', configuredBudget: 16384, modelCapacity: 4096, effectiveBudget: 4096 },
  { name: 'explicit context output reserve 16384 reaches the wire and is reported without a policy change', configuredBudget: 16384, modelCapacity: 64000, effectiveBudget: 16384, context: { outputReserveTokens: 16384 } }
];
for (const scenario of scenarios) test(scenario.name, { timeout: 15000 }, async t => {
  const f = await fixture(t, scenario);
  let failure;
  try {
    await f.runtime.runAgent({
      cwd: f.dataDir, model: 'budget::fixture', prompt: 'Return a synthetic structured answer.',
      responseOnly: true, outputSchema: schema, dynamicTools: [],
      ...(scenario.context ? { context: scenario.context } : {}),
      onEvent: event => f.events.push(event)
    });
    assert.fail('The complete length-limited provider stream must remain a truncation failure.');
  } catch (cause) { failure = cause; }
  assert.equal(failure.code, 'PROVIDER_TRUNCATED');
  assert.equal(f.requests.length, 1, 'truncation must not retry, reroute, or make another inference');
  assert.equal(f.requests[0].url, '/v1/chat/completions');
  assert.equal(f.requests[0].body.model, 'fixture');
  assert.equal(f.requests[0].body.max_tokens, scenario.effectiveBudget);
  assert.equal(f.requests[0].authorization, undefined);
  assert.ok(!f.requests[0].body.tools?.length, 'analytical requests have no operational tools');
  const formatted = value => value.toLocaleString('en-US');
  assert.ok(failure.message.includes('Requested output budget: ' + formatted(scenario.effectiveBudget) + ' tokens.'), failure.message);
  assert.ok(failure.message.includes('Configured output budget: ' + formatted(scenario.configuredBudget) + ' tokens.'), failure.message);
  assert.ok(failure.message.includes('Saved model maximum output: ' + formatted(scenario.modelCapacity) + ' tokens (provider-reported).'), failure.message);
  const lastUsage = f.events.filter(event => event.type === 'usage').at(-1)?.usage;
  assert.equal(lastUsage.samples, 1);
  assert.equal(lastUsage.totalTokens, 9566 + scenario.effectiveBudget - 2);
  assert.equal(lastUsage.availability.totalTokens, 'reported');
  assert.ok(!f.events.some(event => event.type === 'turn' && event.status === 'completed'));
});
