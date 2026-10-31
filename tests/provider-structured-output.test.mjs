import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProviderRuntime } from '../lib/providers.mjs';
import { strictProviderSchema } from '../lib/provider-output-schema.mjs';
import { planningModuleOutputSchema } from '../lib/planning-browser-runtime.mjs';
import { responseCycleTemplate } from '../public/response-cycle-model.mjs';

const schema = { type: 'object', additionalProperties: false, required: ['answer', 'accuracy'], properties: {
  answer: { type: 'string' }, accuracy: { anyOf: [{ type: 'object', additionalProperties: false, required: ['tolerance'], properties: { tolerance: { type: 'string' } } }, { type: 'null' }] }
} };
const answer = JSON.stringify({ answer: 'SYNTHETIC_TYPED_RESULT', accuracy: null });
const supported = ['response_format', 'structured_outputs'];
class Native extends EventEmitter {
  status() { return { connected: true, authenticated: true, defaultModel: 'native', models: [{ model: 'native' }] }; }
  async close() {}
  async runAgent() { throw Error('Wire tests cannot start native inference.'); }
}
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

async function fixture(t, { parameters = supported, openrouter = false, catalogError = false, inferenceError = false, blockCatalog = false, outputSchema = schema } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'provider-output-schema-')), requests = [], events = [];
  let catalogEntered;
  const entered = new Promise(resolve => { catalogEntered = resolve; });
  const fetchImpl = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, method: options.method, body });
    if (options.method === 'GET') {
      catalogEntered();
      if (blockCatalog) return new Promise((resolve, reject) => {
        const abort = () => reject(options.signal.reason || Object.assign(Error('Synthetic abort'), { name: 'AbortError' }));
        if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
      });
      if (catalogError) return response({ error: { message: 'Synthetic catalog unavailable' } }, 404);
      return response({ data: [{ id: 'exact-model', ...(parameters === null ? {} : { supported_parameters: parameters }) }] });
    }
    if (inferenceError) return response({ error: { message: 'Synthetic schema unsupported', code: 'unsupported_parameter' } }, 400);
    return response({ id: 'synthetic-reply', choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } });
  };
  // Exercise capability discovery here; public model-limit reference lookup has separate coverage.
  const runtimes = [], make = async () => { const runtime = await new ProviderRuntime({ codex: new Native(), dataDir: dir, fetchImpl, modelLimitResolver: { enrich: async (_config, models) => models } }).init(); runtimes.push(runtime); return runtime; };
  const runtime = await make();
  // Declared synthetic capacities keep these capability tests cold until runAgent.
  // Save-time capacity discovery has its own provider-model-limits suite.
  await runtime.saveProvider({ id: 'fixture', type: 'compatible', baseUrl: openrouter ? 'https://openrouter.ai/api/v1' : 'https://synthetic-api.example/v1', ...(openrouter ? { apiKey: 'synthetic-fixture-key' } : {}), models: [{ id: 'exact-model', contextWindowTokens: 65536, maxOutputTokens: 8192 }] }, { preserveDefault: true });
  t.after(async () => { for (const item of runtimes) await item.close(); await rm(dir, { recursive: true, force: true }); });
  const options = { model: 'fixture::exact-model', cwd: dir, prompt: 'Return the synthetic typed response.', responseOnly: true, dynamicTools: [], outputSchema, onEvent: event => events.push(event) };
  return { dir, runtime, make, requests, events, options, entered };
}

test('cold analytical compatible turn discovers exact support then sends the complete strict schema', async t => {
  const f = await fixture(t, { openrouter: true });
  assert.equal((await f.runtime.runAgent(f.options)).output, answer);
  assert.deepEqual(f.requests.map(item => item.method), ['GET', 'POST']);
  const body = f.requests[1].body;
  assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'planning_response', strict: true, schema } });
  assert.deepEqual(body.provider, { require_parameters: true }); assert.equal(body.tools, undefined);
  const capability = f.events.find(event => event.type === 'capabilities');
  assert.equal(capability.structuredOutput, 'provider-json-schema'); assert.equal(capability.hostValidationRequired, true);
  assert.equal(capability.structuredOutputTransport, 'chat-completions-response-format');
});

test('fresh catalog is reused and a recreated runtime performs one cold discovery before inference', async t => {
  const f = await fixture(t); await f.runtime.discoverModels('fixture');
  await f.runtime.runAgent(f.options); assert.deepEqual(f.requests.map(item => item.method), ['GET', 'POST']);
  assert.equal(f.requests[1].body.provider, undefined, 'OpenRouter routing options must not reach generic endpoints');
  await f.runtime.close(); const restarted = await f.make();
  await restarted.runAgent(f.options); assert.deepEqual(f.requests.map(item => item.method), ['GET', 'POST', 'GET', 'POST']);
  assert.deepEqual(f.requests[3].body.response_format.json_schema.schema, schema);
});

test('expired capability cache is refreshed and a response_format-only catalog cannot enable JSON Schema', async t => {
  const f = await fixture(t, { parameters: ['response_format'] });
  f.runtime.modelCatalogs.set('fixture', { models: [{ id: 'exact-model', supportedParameters: supported }], expiresAt: 0 });
  await f.runtime.runAgent(f.options);
  assert.deepEqual(f.requests.map(item => item.method), ['GET', 'POST']); assert.equal(f.requests[1].body.response_format, undefined);
  assert.equal(f.events.find(event => event.type === 'capabilities').structuredOutputReason, 'structured_output_not_advertised');
});

test('explicit structured_outputs advertisement is sufficient even when response_format is omitted', async t => {
  const f = await fixture(t, { parameters: ['structured_outputs'] }); await f.runtime.runAgent(f.options);
  assert.equal(f.requests[1].body.response_format.type, 'json_schema');
});

test('generic catalogs with missing metadata and unavailable catalogs retain a declared prompt fallback', async t => {
  for (const options of [{ parameters: null }, { catalogError: true }]) {
    const f = await fixture(t, options); assert.equal((await f.runtime.runAgent(f.options)).output, answer);
    assert.equal(f.requests[1].body.response_format, undefined); assert.equal(f.requests[1].body.provider, undefined);
    const capability = f.events.find(event => event.type === 'capabilities'); assert.equal(capability.structuredOutput, 'prompt-and-host-validation');
    assert.equal(capability.structuredOutputReason, options.catalogError ? 'catalog_unavailable' : 'structured_output_support_unknown');
  }
});

test('strict-incompatible optional fields are not rewritten or sent as an invalid strict schema', async t => {
  const optional = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' }, optionalNote: { type: 'string' } } };
  const before = structuredClone(optional), f = await fixture(t, { outputSchema: optional });
  await f.runtime.runAgent(f.options); assert.deepEqual(optional, before); assert.deepEqual(f.requests.map(item => item.method), ['POST']);
  assert.equal(f.requests[0].body.response_format, undefined); assert.equal(f.events.find(event => event.type === 'capabilities').structuredOutputReason, 'schema_not_strict_compatible');
});

test('a schema HTTP rejection is surfaced after one inference request without retry or parameter downgrade', async t => {
  const f = await fixture(t, { inferenceError: true }); await assert.rejects(f.runtime.runAgent(f.options));
  const inference = f.requests.filter(item => item.method === 'POST'); assert.equal(inference.length, 1); assert.equal(inference[0].body.response_format.type, 'json_schema');
});

test('cancelling cold capability discovery never starts an inference request', async t => {
  const f = await fixture(t, { blockCatalog: true }), controller = new AbortController();
  const pending = f.runtime.runAgent({ ...f.options, signal: controller.signal });
  await f.entered; controller.abort(); await assert.rejects(pending);
  assert.deepEqual(f.requests.map(item => item.method), ['GET']); assert.equal(f.runtime.active.size, 0);
});

test('an analytical context checkpoint does not inherit the stage output schema', async t => {
  const f = await fixture(t), config = f.runtime.store.get('fixture');
  const state = { config, responseOnly: true, outputSchema: schema, outputProfile: { structuredOutput: 'provider-json-schema' },
    record: { providerId: 'fixture', model: 'exact-model', messages: [], totalUsage: {} }, controller: new AbortController(), usage: {}, tools: [] };
  await f.runtime.summarizeContextText(state, 'Synthetic historical record.', { inputBudgetTokens: 20000, outputReserveTokens: 2000, headroomTokens: 100, effectiveWindowTokens: 32000 }, { summaryTokens: 256 });
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].body.response_format, undefined); assert.equal(f.requests[0].body.provider, undefined);
  assert.deepEqual(state.outputSchema, schema, 'the current stage keeps its exact schema after checkpointing');
});

test('actual five-stage schemas remain recursively closed and fully required, including nullable accuracy', () => {
  for (const kind of ['viability', 'inference', 'plan', 'think', 'respond']) {
    const actual = planningModuleOutputSchema({ node: { kind }, template: responseCycleTemplate(kind), sources: [{ id: 'source:one' }], challenges: [] });
    assert.equal(strictProviderSchema(actual), true, kind);
    const visit = entry => {
      if (!entry || typeof entry !== 'object') return;
      if (entry.type === 'object') { assert.equal(entry.additionalProperties, false, kind); assert.deepEqual([...entry.required].sort(), Object.keys(entry.properties).sort(), kind); }
      for (const value of Object.values(entry)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
    };
    visit(actual);
  }
  assert.equal(strictProviderSchema(schema), true);
  assert.equal(strictProviderSchema({ ...schema, properties: { answer: { type: 'string', enum: [] }, accuracy: schema.properties.accuracy } }), false);
});
