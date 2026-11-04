import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFreeEvaluationRuntime, FREE_MODEL, FREE_MODEL_ID, FREE_EVALUATION_BUDGETS, observedFreeEvaluationBudgets } from '../scripts/verify-free-advocacy.mjs';

import { ADVOCACY_CASES, runAdvocacyCase } from '../scripts/verify-luna-advocacy.mjs';

const catalog = pricing => ({ data: [{ id: FREE_MODEL_ID, pricing, context_length: 1000000,
  top_provider: { max_completion_tokens: 131072 }, supported_parameters: ['tools', 'tool_choice', 'response_format', 'structured_outputs'] }] });
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-free-eval-test-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.match(path.basename(root), /^blackice-free-eval-test-/);
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test('free setup loads actual runtime with no native startup, credentials, inference, or default change', async t => {
  const root = await temporary(t), calls = [];
  const setup = await createFreeEvaluationRuntime({ root, fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method || 'GET', headers: [...new Headers(options.headers).keys()] });
    assert.equal(options.method || 'GET', 'GET', 'Offline setup must never infer.');
    return new Response(JSON.stringify(catalog({ prompt: '0', completion: '0' })), { headers: { 'content-type': 'application/json' } });
  } });
  t.after(() => setup.runtime.close());
  await setup.flush();
  assert.equal(setup.model, FREE_MODEL);
  assert.deepEqual(setup.budgets, { providerMaxTokens: 32768, runTimeoutMs: 600000, caseTimeoutMs: 900000, maxSteps: 64 });
  assert.equal(setup.runtime.resolveModel(FREE_MODEL).available, true);
  assert.deepEqual(setup.native, { startCalls: 0, runCalls: 0 });
  assert.equal(setup.runtime.store.defaultModel, null);
  assert.equal(setup.runtime.store.automaticDefaultModel, null);
  assert.deepEqual(setup.runtime.listProviders().map(provider => provider.id), ['eval-kilo-free']);
  await fs.writeFile(path.join(root, 'api-profile', '.env'), 'BLACKICE_PROVIDER_EVAL-KILO-FREE_API_KEY=synthetic-unusable-secret\n');
  assert.equal(setup.runtime.store.key('eval-kilo-free'), '', 'The isolated resolver must not read even a synthetic profile key.');
  await assert.rejects(setup.runtime.fetchImpl('https://ai-gateway.kilo.ai/api/v1/models', { headers: { Authorization: 'synthetic-credential' } }), /Credentials are not permitted/);
  await assert.rejects(setup.runtime.fetchImpl('https://ai-gateway.kilo.ai/api/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'paid-model' }) }), /exact free model/);
  await assert.rejects(createFreeEvaluationRuntime({ root, fetchImpl: async () => { throw Error('Reused directories must fail before requests.'); } }), { code: 'EEXIST' });
  assert.ok(calls.every(call => call.method === 'GET' && !call.headers.includes('authorization')));
});

test('missing or nonzero catalog pricing stops setup before a provider turn', async t => {
  for (const pricing of [{ prompt: '0', completion: '0.0001' }, { prompt: '0' }]) {
    const root = await temporary(t), methods = [];
    await assert.rejects(createFreeEvaluationRuntime({ root, fetchImpl: async (_url, options) => {
      methods.push(options.method || 'GET');
      return new Response(JSON.stringify(catalog(pricing)), { headers: { 'content-type': 'application/json' } });
    } }), /explicitly report zero/);
    assert.deepEqual(methods, ['GET']);
    const failure = JSON.parse(await fs.readFile(path.join(root, 'setup-failure.json'), 'utf8'));
    assert.deepEqual(failure.native, { startCalls: 0, runCalls: 0 });
  }
});

test('production Planning serializes the isolated 32768-token budget without calling a model', async t => {
  const root = await temporary(t), bodies = [];
  const setup = await createFreeEvaluationRuntime({ root, fetchImpl: async (_url, options) => {
    if ((options.method || 'GET') === 'GET') return new Response(JSON.stringify(catalog({ prompt: '0', completion: '0' })), { headers: { 'content-type': 'application/json' } });
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ error: { message: 'Synthetic budget capture; no model called.' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  } });
  t.after(() => setup.runtime.close());
  const result = await runAdvocacyCase({ runtime: setup.runtime, root,
    item: ADVOCACY_CASES.find(item => item.id === 'required-nationality-decline'),
    model: FREE_MODEL, effort: 'default', timeoutMs: 10000, runTimeoutMs: FREE_EVALUATION_BUDGETS.runTimeoutMs });
  await setup.flush();
  assert.equal(result.status, 'failed');
  assert.equal(result.settled, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.runTimeoutMs, 600000);
  assert.equal(result.planningConfiguration.enforcement, 'forced');
  assert.equal(result.planningConfiguration.servicesAttached, true);
  assert.ok(bodies.length > 0, 'The real Planning service must reach the injected provider transport.');
  for (const body of bodies) {
    assert.equal(body.model, FREE_MODEL_ID);
    assert.equal(body.max_tokens, 32768, 'A Planning stage override must not retain the old 8192-token cap.');
    assert.equal(body.response_format?.type, 'json_schema');
    assert.ok(!body.tools?.length, 'Analytical Planning cannot execute fixture operations.');
  }
  assert.deepEqual(observedFreeEvaluationBudgets(setup.requests).observedWireMaxTokens, { withTools: [], withoutTools: [32768] });
  assert.ok(result.calls.every(call => call.responseOnly === true));
  assert.deepEqual(setup.native, { startCalls: 0, runCalls: 0 });
  assert.equal(result.form.calls.length, 0);
});

test('isolated 64-step provider completes more than 16 mocked execution turns with its existing wire reserve', async t => {
  const root = await temporary(t);
  let turns = 0, toolCalls = 0;
  const setup = await createFreeEvaluationRuntime({ root, fetchImpl: async (_url, options) => {
    if ((options.method || 'GET') === 'GET') return new Response(JSON.stringify(catalog({ prompt: '0', completion: '0' })), { headers: { 'content-type': 'application/json' } });
    const body = JSON.parse(options.body), final = ++turns === 18;
    assert.equal(body.max_tokens, 8192, 'Execution keeps its existing effective output reserve.');
    const message = final ? { role: 'assistant', content: 'Synthetic execution completed.' }
      : { role: 'assistant', content: '', tool_calls: [{ id: 'fixture-' + turns, type: 'function',
        function: { name: body.tools[0].function.name, arguments: '{}' } }] };
    return new Response(JSON.stringify({ id: 'fixture-' + turns, model: FREE_MODEL_ID,
      choices: [{ message, finish_reason: final ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }), { headers: { 'content-type': 'application/json' } });
  } });
  t.after(() => setup.runtime.close());
  const result = await setup.runtime.runAgent({ model: FREE_MODEL, effort: 'default', cwd: root,
    prompt: 'Run the deterministic offline fixture.', developerInstructions: 'Synthetic fixture only.',
    dynamicTools: [{ name: 'fixture_ping', description: 'Return the synthetic fixture receipt.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
    onToolCall: async () => { toolCalls++; return { success: true, contentItems: [{ type: 'inputText', text: 'Synthetic receipt.' }] }; } });
  await setup.flush();
  assert.equal(setup.budgets.maxSteps, 64);
  assert.equal(turns, 18);
  assert.equal(toolCalls, 17);
  assert.equal(result.output, 'Synthetic execution completed.');
  assert.deepEqual(observedFreeEvaluationBudgets(setup.requests), {
    providerMaxTokens: 32768, runTimeoutMs: 600000, caseTimeoutMs: 900000, maxSteps: 64,
    observedWireMaxTokens: { withTools: [8192], withoutTools: [] },
  });
  assert.deepEqual(setup.native, { startCalls: 0, runCalls: 0 });
});
