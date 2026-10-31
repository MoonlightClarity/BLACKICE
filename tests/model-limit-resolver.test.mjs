import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelLimitResolver } from '../lib/model-limit-resolver.mjs';

const OPENROUTER = 'https://openrouter.ai/api/v1/models';
const CLASSIC = 'https://text.pollinations.ai/models';
const GEN = 'https://gen.pollinations.ai/text/models?reliability=all';
const HF = 'https://huggingface.co/openai/gpt-oss-20b/raw/main/config.json';
const MODELS = 'https://models.dev/api.json';
const classic = { id: 'pollinations_classic', type: 'compatible', baseUrl: 'https://text.pollinations.ai' };
const openrouter = { id: 'router', type: 'compatible', preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' };
const legacyRow = { name: 'openai-fast', aliases: ['openai', 'gpt-oss', 'gpt-oss-20b', 'ovh-reasoning'] };
const nano = { id: 'openai/gpt-5-nano', context_length: 400000, top_provider: { context_length: 400000, max_completion_tokens: 128000 } };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function fixture(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (!(url in responses)) throw new Error(`Unexpected public request: ${url}`);
    const value = typeof responses[url] === 'function' ? await responses[url](options) : responses[url];
    return value instanceof Response ? value : json(value);
  };
  return { calls, fetchImpl };
}

test('Classic openai-fast uses its exact legacy alias and official GPT-OSS reference, never modern Nano', async () => {
  const f = fixture({ [CLASSIC]: [legacyRow], [HF]: { max_position_embeddings: 131072 } });
  const input = { id: 'openai-fast', displayName: 'Saved model', tools: true };
  const [model] = await new ModelLimitResolver(f).enrich(classic, [input]);
  assert.equal(model.contextWindowTokens, 131072);
  assert.equal(model.contextWindowSource, 'model-reference');
  assert.equal(model.contextWindowEvidence.endpointSpecific, false);
  assert.equal(model.contextWindowEvidence.modelId, 'openai/gpt-oss-20b');
  assert.equal(model.maxOutputTokens, undefined);
  assert.equal(model.modelLimitLookup.status, 'partial');
  assert.equal(model.tools, true);
  assert.deepEqual(f.calls.map(call => call.url), [CLASSIC, HF]);
  assert.deepEqual(input, { id: 'openai-fast', displayName: 'Saved model', tools: true });
});

test('fresh raw Classic aliases avoid a redundant catalog request', async () => {
  const f = fixture({ [HF]: { max_position_embeddings: 131072 } });
  const [model] = await new ModelLimitResolver(f).enrich(classic, [{ id: 'openai-fast' }], { rawModels: [legacyRow] });
  assert.equal(model.contextWindowTokens, 131072);
  assert.deepEqual(f.calls.map(call => call.url), [HF]);
});

test('modern Pollinations alias maps to its own canonical model with separate reference provenance', async () => {
  const f = fixture({ [GEN]: [{ name: nano.id, aliases: ['openai-fast'], context_length: 400000 }], [OPENROUTER]: { data: [nano] } });
  const [model] = await new ModelLimitResolver(f).enrich({ ...classic, baseUrl: 'https://gen.pollinations.ai/v1' }, [{ id: 'openai-fast' }]);
  assert.equal(model.contextWindowTokens, 400000);
  assert.equal(model.contextWindowSource, 'provider-reported');
  assert.equal(model.contextWindowEvidence.endpointSpecific, true);
  assert.equal(model.maxOutputTokens, 128000);
  assert.equal(model.maxOutputTokensSource, 'model-reference');
  assert.equal(model.maxOutputEvidence.endpointSpecific, false);
  assert.equal(model.modelLimitLookup.status, 'resolved');
});

test('neither model name similarity nor ambiguous aliases authorize a published capacity', async () => {
  const f = fixture({ [CLASSIC]: [{ name: 'openai-fast', description: 'GPT-OSS 20B' }] });
  const [model] = await new ModelLimitResolver(f).enrich(classic, [{ id: 'openai-fast' }]);
  assert.equal(model.contextWindowTokens, undefined);
  assert.equal(f.calls.length, 1);
  const ambiguous = fixture({ [CLASSIC]: [{ name: 'one', aliases: ['custom', 'gpt-oss-20b'] }, { name: 'two', aliases: ['custom'] }] });
  const [other] = await new ModelLimitResolver(ambiguous).enrich(classic, [{ id: 'custom' }]);
  assert.equal(other.contextWindowTokens, undefined);
  assert.equal(other.modelLimitLookup.status, 'unresolved');
});

test('existing numeric limits, user sources and evidence are never overwritten or fetched', async () => {
  const f = fixture({});
  const evidence = { label: 'User value', modelId: 'custom', endpointSpecific: true };
  const input = { id: 'custom', contextWindowTokens: 32000, contextWindowSource: 'user-configured', contextWindowEvidence: evidence, maxOutputTokens: 1500, maxOutputTokensSource: 'user-configured', modelLimitLookup: { status: 'partial', sources: [] } };
  const [model] = await new ModelLimitResolver(f).enrich(classic, [input], { refresh: true });
  assert.equal(model.contextWindowTokens, 32000);
  assert.equal(model.contextWindowSource, 'user-configured');
  assert.equal(model.contextWindowEvidence, evidence);
  assert.equal(model.maxOutputTokens, 1500);
  assert.equal(model.modelLimitLookup.status, 'resolved');
  assert.equal(f.calls.length, 0);
});

test('only a missing field is filled and public requests contain no saved credentials', async () => {
  const f = fixture({ [OPENROUTER]: { data: [nano] } });
  const config = { ...openrouter, apiKey: 'must-not-leak', headers: { Authorization: 'must-not-leak' } };
  const [model] = await new ModelLimitResolver(f).enrich(config, [{ id: nano.id, contextWindowTokens: 32000, contextWindowSource: 'user-configured' }]);
  assert.equal(model.contextWindowTokens, 32000);
  assert.equal(model.contextWindowSource, 'user-configured');
  assert.equal(model.maxOutputTokens, 128000);
  assert.equal(model.maxOutputTokensSource, 'provider-reported');
  assert.equal(model.maxOutputEvidence.endpointSpecific, false);
  assert.deepEqual(f.calls[0].options.headers, { Accept: 'application/json' });
  assert.equal(f.calls[0].options.credentials, 'omit');
  assert.equal(f.calls[0].options.redirect, 'error');
  assert.equal(JSON.stringify(f.calls).includes('must-not-leak'), false);
});

test('OpenRouter variants match exactly, without stripping suffixes or guessing model prefixes', async () => {
  const f = fixture({ [OPENROUTER]: { data: [nano] } });
  const models = await new ModelLimitResolver(f).enrich(openrouter, [{ id: nano.id }, { id: nano.id + ':free' }, { id: 'gpt-5-nano' }]);
  assert.equal(models[0].contextWindowTokens, 400000);
  assert.equal(models[1].contextWindowTokens, undefined);
  assert.equal(models[2].contextWindowTokens, undefined);
  assert.equal(f.calls.length, 1);
});

test('exact OpenRouter preset behind another origin remains a model reference', async () => {
  const f = fixture({ [OPENROUTER]: { data: [nano] } });
  const [model] = await new ModelLimitResolver(f).enrich({ ...openrouter, baseUrl: 'https://my-gateway.example/v1' }, [{ id: nano.id }]);
  assert.equal(model.contextWindowSource, 'model-reference');
  assert.equal(model.contextWindowEvidence.endpointSpecific, false);
});

test('successful model metadata is cached for 24 hours and refresh bypasses caches', async () => {
  let now = Date.parse('2026-10-30T19:00:00Z'), count = 0;
  const f = fixture({ [OPENROUTER]: () => ({ data: [{ ...nano, context_length: ++count * 1000, top_provider: { context_length: count * 1000, max_completion_tokens: 500 } }] }) });
  const resolver = new ModelLimitResolver({ ...f, now: () => now });
  const read = options => resolver.enrich(openrouter, [{ id: nano.id }], options);
  const [first] = await read(); now += 23 * 3600000;
  const [cached] = await read();
  assert.equal(cached.contextWindowTokens, first.contextWindowTokens);
  assert.equal(cached.contextWindowObservedAt, first.contextWindowObservedAt);
  assert.equal(f.calls.length, 1);
  const [fresh] = await read({ refresh: true }); assert.equal(fresh.contextWindowTokens, 2000);
  now += 24 * 3600000 + 1;
  const [expired] = await read(); assert.equal(expired.contextWindowTokens, 3000);
  assert.equal(f.calls.length, 3);
});

test('negative exact-ID lookups retry after five minutes, including the catalog', async () => {
  let now = 0, available = false;
  const f = fixture({ [OPENROUTER]: () => ({ data: available ? [nano] : [] }) });
  const resolver = new ModelLimitResolver({ ...f, now: () => now });
  const read = () => resolver.enrich(openrouter, [{ id: nano.id }]);
  assert.equal((await read())[0].modelLimitLookup.status, 'unresolved');
  available = true; now += 299999;
  assert.equal((await read())[0].contextWindowTokens, undefined);
  assert.equal(f.calls.length, 1);
  now += 2;
  assert.equal((await read())[0].contextWindowTokens, 400000);
  assert.equal(f.calls.length, 2);
});

test('Ollama reports the actual loaded context ahead of saved defaults and architecture capacity', async () => {
  const calls = [];
  const request = async (path, body) => {
    calls.push({ path, body });
    if (path === '/api/ps') return { models: [{ model: 'test:latest', context_length: 4096 }] };
    assert.equal(path, '/api/show'); assert.deepEqual(body, { model: 'test:latest' });
    return { parameters: 'num_ctx 8192\nnum_predict 2000', model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072 } };
  };
  const [model] = await new ModelLimitResolver({ fetchImpl: () => assert.fail('no public fetch') }).enrich({ id: 'local', preset: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }, [{ id: 'test:latest' }], { request });
  assert.equal(model.contextWindowTokens, 4096);
  assert.equal(model.contextWindowSource, 'runtime-reported');
  assert.equal(model.contextWindowEvidence.endpointSpecific, true);
  assert.equal(model.maxOutputTokens, undefined);
  assert.equal(calls.length, 2);
});

test('Ollama distinguishes num_ctx configuration from model maximum and does not guess architecture keys', async () => {
  const config = { id: 'local', preset: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' };
  const request = async (path, body) => path === '/api/ps' ? { models: [] } : { parameters: body.model === 'configured' ? 'num_ctx 8000' : '', model_info: { 'general.architecture': 'llama', 'llama.context_length': 16000 } };
  const models = await new ModelLimitResolver().enrich(config, [{ id: 'configured' }, { id: 'unloaded' }], { request });
  assert.equal(models[0].contextWindowTokens, 8000);
  assert.equal(models[0].contextWindowSource, 'runtime-reported');
  assert.equal(models[1].contextWindowTokens, 16000);
  assert.equal(models[1].contextWindowSource, 'model-reference');
  const [unknown] = await new ModelLimitResolver().enrich(config, [{ id: 'unknown' }], { request: async path => path === '/api/ps' ? { models: [] } : { model_info: { 'wrong.context_length': 16000 } } });
  assert.equal(unknown.contextWindowTokens, undefined);
});

test('LM Studio uses loaded instance IDs, keeps model maximum distinct, and batches one native request', async () => {
  let calls = 0;
  const request = async (path, body) => {
    calls++; assert.equal(path, '/api/v1/models'); assert.equal(body, undefined);
    return { models: [
      { key: 'publisher/model', max_context_length: 131072, loaded_instances: [{ id: 'custom-instance', config: { context_length: 8192 } }] },
      { key: 'unloaded', max_context_length: 64000, loaded_instances: [] },
      { key: 'ambiguous', max_context_length: 64000, loaded_instances: [{ id: 'small', config: { context_length: 4096 } }, { id: 'large', config: { context_length: 8192 } }] },
    ] };
  };
  const models = await new ModelLimitResolver().enrich({ id: 'lm', preset: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' }, [{ id: 'custom-instance' }, { id: 'unloaded' }, { id: 'ambiguous' }], { request });
  assert.equal(calls, 1);
  assert.equal(models[0].contextWindowTokens, 8192);
  assert.equal(models[0].contextWindowSource, 'runtime-reported');
  assert.equal(models[1].contextWindowTokens, 64000);
  assert.equal(models[1].contextWindowSource, 'model-reference');
  assert.equal(models[2].contextWindowSource, 'model-reference');
});

test('Anthropic model retrieval supplies exact returned limits without inference', async () => {
  const calls = [];
  const request = async (path, body) => { calls.push({ path, body }); return { id: 'claude-exact-snapshot', max_input_tokens: 200000, max_tokens: 64000 }; };
  const f = fixture({});
  const [model] = await new ModelLimitResolver(f).enrich({ id: 'anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }, [{ id: 'claude-alias' }], { request });
  assert.deepEqual(calls, [{ path: '/v1/models/claude-alias', body: undefined }]);
  assert.equal(model.contextWindowTokens, 200000);
  assert.equal(model.maxOutputTokens, 64000);
  assert.equal(model.contextWindowEvidence.modelId, 'claude-exact-snapshot');
  assert.equal(model.contextWindowSource, 'provider-reported');
  assert.equal(f.calls.length, 0);
});

test('Anthropic details follow configured tenant prefixes and explicit model routes while preserving the base query', async () => {
  const config = { id: 'anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1/tenant?api-version=2026-10-30' };
  const calls = [], request = async path => { calls.push(path); return { id: 'claude-exact', max_input_tokens: 200000, max_tokens: 64000 }; };
  const resolver = new ModelLimitResolver({ fetchImpl: () => assert.fail('no public reference lookup needed') });
  const [prefixed] = await resolver.enrich(config, [{ id: 'claude-alias' }], { request });
  assert.equal(calls[0], '/v1/tenant/models/claude-alias');
  assert.equal(prefixed.contextWindowEvidence.url, 'https://api.anthropic.com/v1/tenant/models/claude-alias?api-version=2026-10-30');
  const [overridden] = await resolver.enrich({ ...config, endpoints: { models: '/tenant-catalog/models' } }, [{ id: 'claude/alias' }], { request });
  assert.equal(calls[1], '/tenant-catalog/models/claude%2Falias');
  assert.equal(overridden.contextWindowEvidence.url, 'https://api.anthropic.com/tenant-catalog/models/claude%2Falias?api-version=2026-10-30');
});

test('different configured API-version queries have separate model and native-resource cache identities', async () => {
  const resolver = new ModelLimitResolver(); let value = 16000, calls = 0;
  const request = async () => { calls++; return { id: 'model', max_input_tokens: value, max_tokens: 2000 }; };
  const config = { id: 'custom', type: 'anthropic', baseUrl: 'https://custom.example/v1?api-version=one' };
  assert.equal((await resolver.enrich(config, [{ id: 'model' }], { request }))[0].contextWindowTokens, 16000);
  value = 32000;
  const [second] = await resolver.enrich({ ...config, baseUrl: 'https://custom.example/v1?api-version=two' }, [{ id: 'model' }], { request });
  assert.equal(second.contextWindowTokens, 32000);
  assert.equal(second.contextWindowEvidence.url, 'https://custom.example/v1/models/model?api-version=two');
  assert.equal(calls, 2);
});

test('models.dev is an exact known-provider community reference, never a verified endpoint capacity', async () => {
  const f = fixture({ [MODELS]: { openai: { models: { 'gpt-exact': { id: 'gpt-exact', limit: { context: 200000, output: 16000 } } } } } });
  const models = await new ModelLimitResolver(f).enrich({ id: 'openai', type: 'openai', baseUrl: 'https://api.openai.com/v1' }, [{ id: 'gpt-exact' }, { id: 'gpt-exact-variant' }]);
  assert.equal(models[0].contextWindowTokens, 200000);
  assert.equal(models[0].contextWindowSource, 'model-reference');
  assert.equal(models[0].contextWindowEvidence.endpointSpecific, false);
  assert.match(models[0].contextWindowEvidence.label, /community/);
  assert.equal(models[1].contextWindowTokens, undefined);
  assert.equal(f.calls.length, 1);
});

test('unknown and lookalike origins are not probed or treated as official providers', async () => {
  const f = fixture({});
  for (const baseUrl of ['https://text.pollinations.ai.evil.example', 'https://text.pollinations.ai:8443', 'https://my-gateway.example/v1']) {
    const [model] = await new ModelLimitResolver(f).enrich({ id: 'custom', type: 'compatible', baseUrl }, [{ id: 'openai-fast' }]);
    assert.equal(model.modelLimitLookup.status, 'unresolved');
  }
  assert.equal(f.calls.length, 0);
});

test('local native catalogs are not capped at sixteen detail lookups and transport concurrency stays at four', async () => {
  let active = 0, maximum = 0, shows = 0, ps = 0;
  const request = async (path, body) => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    if (path === '/api/ps') { ps++; return { models: [] }; }
    assert.equal(path, '/api/show'); shows++;
    return { model_info: { 'general.architecture': 'llama', 'llama.context_length': 16000 } };
  };
  const models = await new ModelLimitResolver().enrich({ id: 'ollama', preset: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }, Array.from({ length: 100 }, (_, i) => ({ id: `model-${i}` })), { request });
  assert.equal(shows, 100); assert.equal(ps, 1); assert.ok(maximum <= 4);
  assert.equal(models.filter(model => model.contextWindowTokens === 16000).length, 100);
  assert.equal(models.at(-1).modelLimitLookup.status, 'partial');
});

test('refresh uses new credentials while an old request is pending and late old results cannot poison either cache', async () => {
  const resolver = new ModelLimitResolver({ timeoutMs: 1000 });
  const config = { id: 'custom', type: 'anthropic', baseUrl: 'https://custom.example/v1' };
  let releaseOld, notifyOldStarted, newCalls = 0;
  const oldResponse = new Promise(resolve => { releaseOld = resolve; });
  const oldStarted = new Promise(resolve => { notifyOldStarted = resolve; });
  const old = resolver.enrich(config, [{ id: 'model' }], { request: async () => { notifyOldStarted(); return oldResponse; } });
  await oldStarted;
  const [fresh] = await resolver.enrich(config, [{ id: 'model' }], { refresh: true, request: async () => { newCalls++; return { id: 'model', max_input_tokens: 32000, max_tokens: 4000 }; } });
  assert.equal(newCalls, 1);
  assert.equal(fresh.contextWindowTokens, 32000);
  releaseOld({ id: 'model', max_input_tokens: 8000, max_tokens: 2000 });
  assert.equal((await old)[0].contextWindowTokens, 8000);
  const request = async () => assert.fail('Expected the new credential metadata to be cached');
  assert.equal((await resolver.enrich(config, [{ id: 'model' }], { request }))[0].contextWindowTokens, 32000);
  // A new raw catalog identity misses the model cache but must still read the
  // refreshed native resource cache, not the old request that finished later.
  assert.equal((await resolver.enrich(config, [{ id: 'model' }], { request, rawModels: [{ id: 'model', aliases: ['exact-alias'] }] }))[0].contextWindowTokens, 32000);
});

test('selected exact IDs and missing contexts are scheduled first without changing catalog order', async () => {
  const shows = [];
  const input = [...Array.from({ length: 40 }, (_, i) => ({ id: `known-context-${i}`, contextWindowTokens: 8000 })), { id: 'missing-context' }, { id: 'selected-late' }];
  const request = async (path, body) => {
    if (path === '/api/ps') return { models: [] };
    shows.push(body.model);
    return { model_info: { 'general.architecture': 'llama', 'llama.context_length': 16000 } };
  };
  const result = await new ModelLimitResolver().enrich({ id: 'local', preset: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: [{ id: 'selected-late' }] }, input, { request });
  assert.deepEqual(shows.slice(0, 2), ['selected-late', 'missing-context']);
  assert.deepEqual(result.map(model => model.id), input.map(model => model.id));
  assert.equal(result.at(-1).contextWindowTokens, 16000);
});

test('repeated time-bounded local refreshes rotate to models that were not attempted yet', async () => {
  const resolver = new ModelLimitResolver({ timeoutMs: 25 });
  const config = { id: 'local', preset: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' };
  const input = Array.from({ length: 12 }, (_, i) => ({ id: `model-${i}` })), first = [], second = [];
  await resolver.enrich(config, input, { refresh: true, request: async (path, body) => {
    if (path === '/api/ps') return { models: [] };
    first.push(body.model); return new Promise(() => {});
  } });
  assert.ok(first.length > 0 && first.length < input.length);
  const result = await resolver.enrich(config, input, { refresh: true, request: async (path, body) => {
    if (path === '/api/ps') return { models: [] };
    second.push(body.model); return { model_info: { 'general.architecture': 'llama', 'llama.context_length': 16000 } };
  } });
  assert.equal(first.includes(second[0]), false);
  assert.equal(result.filter(model => model.contextWindowTokens === 16000).length, 12);
});

test('remote detail budget is 200 and an unattempted model remains immediately retryable', async () => {
  const resolver = new ModelLimitResolver(), calls = [];
  const config = { id: 'custom', type: 'anthropic', baseUrl: 'https://custom.example/v1' };
  const request = async path => { calls.push(path); return { id: path.split('/').at(-1), max_input_tokens: 32000, max_tokens: 4000 }; };
  const input = Array.from({ length: 201 }, (_, i) => ({ id: `model-${i}` }));
  const results = await resolver.enrich(config, input, { request });
  assert.equal(calls.length, 200);
  assert.equal(results.at(-1).contextWindowTokens, undefined);
  assert.match(results.at(-1).modelLimitLookup.reason, /budget/);
  const [retried] = await resolver.enrich(config, [input.at(-1)], { request });
  assert.equal(retried.contextWindowTokens, 32000);
  assert.equal(calls.length, 201);
});

test('timeouts finish even if the HTTP implementation ignores cancellation', async () => {
  const resolver = new ModelLimitResolver({ timeoutMs: 20, fetchImpl: () => new Promise(() => {}) });
  const started = Date.now();
  const [model] = await resolver.enrich(openrouter, [{ id: nano.id }]);
  assert.ok(Date.now() - started < 1000);
  assert.equal(model.modelLimitLookup.status, 'unavailable');
  assert.equal(model.contextWindowTokens, undefined);
});

test('already-aborted work makes no network request and does not poison the next lookup cache', async () => {
  const f = fixture({ [OPENROUTER]: { data: [nano] } }), resolver = new ModelLimitResolver(f), controller = new AbortController();
  controller.abort();
  await assert.rejects(resolver.enrich(openrouter, [{ id: nano.id }], { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.calls.length, 0);
  assert.equal((await resolver.enrich(openrouter, [{ id: nano.id }]))[0].contextWindowTokens, 400000);
});

test('external cancellation reaches the authenticated metadata transport and throws AbortError', async () => {
  const controller = new AbortController(); let transportSignal;
  const pending = new ModelLimitResolver({ timeoutMs: 1000 }).enrich({ id: 'local', preset: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' }, [{ id: 'model' }], {
    signal: controller.signal,
    request: async (_path, _body, signal) => { transportSignal = signal; controller.abort(); return new Promise(() => {}); },
  });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(transportSignal.aborted, true);
});

test('native cache identity includes the configured endpoint mappings', async () => {
  const resolver = new ModelLimitResolver(); let value = 16000, calls = 0;
  const request = async () => { calls++; return { id: 'model', max_input_tokens: value, max_tokens: 2000 }; };
  const config = { id: 'custom', type: 'anthropic', baseUrl: 'https://custom.example/v1', endpoints: { models: '/models' } };
  assert.equal((await resolver.enrich(config, [{ id: 'model' }], { request }))[0].contextWindowTokens, 16000);
  value = 32000;
  assert.equal((await resolver.enrich({ ...config, endpoints: { models: '/updated/models' } }, [{ id: 'model' }], { request }))[0].contextWindowTokens, 32000);
  assert.equal(calls, 2);
});

test('404 and transport errors remain explicit without inventing limits', async () => {
  const f = fixture({ [OPENROUTER]: new Response('', { status: 404 }) });
  const [notFound] = await new ModelLimitResolver(f).enrich(openrouter, [{ id: nano.id }]);
  assert.equal(notFound.modelLimitLookup.sources[0].status, 'not-found');
  assert.equal(notFound.modelLimitLookup.status, 'unresolved');
  const [unavailable] = await new ModelLimitResolver({ fetchImpl: async () => { throw new Error('network'); } }).enrich(openrouter, [{ id: nano.id }]);
  assert.equal(unavailable.modelLimitLookup.status, 'unavailable');
  assert.equal(unavailable.contextWindowTokens, undefined);
});

test('oversized public metadata is rejected and invalid numeric limits stay unknown', async () => {
  const big = fixture({ [OPENROUTER]: new Response('{}', { headers: { 'content-length': String(9 * 1024 * 1024) } }) });
  assert.equal((await new ModelLimitResolver(big).enrich(openrouter, [{ id: nano.id }]))[0].modelLimitLookup.status, 'unavailable');
  const invalid = fixture({ [OPENROUTER]: { data: [{ id: nano.id, context_length: -1, top_provider: { max_completion_tokens: 'Infinity' } }] } });
  const [model] = await new ModelLimitResolver(invalid).enrich(openrouter, [{ id: nano.id }]);
  assert.equal(model.contextWindowTokens, undefined); assert.equal(model.maxOutputTokens, undefined);
});
