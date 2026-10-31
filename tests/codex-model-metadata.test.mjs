import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexModelMetadata, codexMetadataHome, parseCodexModelMetadata } from '../lib/codex-model-metadata.mjs';
import { CodexRuntime } from '../lib/codex.mjs';

const now = Date.parse('2026-10-30T19:30:00.000Z');
const fetchedAt = '2026-10-30T19:00:00.000Z';
const cwd = fileURLToPath(new URL('..', import.meta.url));
const rawModel = (slug, context = 500000, extra = {}) => ({ slug, display_name: slug, context_window: context, max_context_window: 872000, effective_context_window_percent: 95, input_modalities: ['text', 'image'], ...extra });
const listModel = (id, extra = {}) => ({ id, model: id, displayName: id, ...extra });
function metadataFixture({ cacheModels = [rawModel('native-exact')], bundleModels = [rawModel('native-exact', 272000)], rawModels = [rawModel('native-exact', 600000)], cache, rawError = false, bundleError = false, options = {} } = {}) {
  const calls = [], reads = [];
  const resolver = new CodexModelMetadata({
    command: 'codex.exe', args: ['app-server'], cwd, env: {}, home: path.join(cwd, 'fixture-home'), enabled: true, now: () => now,
    readFileImpl: async (file, encoding) => {
      reads.push({ file, encoding });
      if (cache instanceof Error) throw cache;
      return cache !== undefined ? cache : JSON.stringify({ fetched_at: fetchedAt, identity: { secret: 'never-publish' }, models: cacheModels });
    },
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      const bundled = args.includes('--bundled');
      if (bundled ? bundleError : rawError) throw new Error('private upstream diagnostic');
      return { stdout: JSON.stringify({ models: bundled ? bundleModels : rawModels }) };
    },
    ...options,
  });
  return { resolver, calls, reads };
}

test('native metadata projects safe exact IDs and rejects ambiguous or invalid capacities', () => {
  const parsed = parseCodexModelMetadata({ identity: 'secret', models: [
    rawModel('exact', 500000, { model_messages: 'never-publish', max_output_tokens: 32000 }),
    rawModel('duplicate', 1000), rawModel('duplicate', 2000),
    rawModel('bad', '500000', { max_context_window: Number.MAX_SAFE_INTEGER + 1, max_output_tokens: -1 }),
  ] });
  assert.deepEqual([...parsed.keys()], ['exact', 'bad']);
  assert.equal(parsed.get('exact').contextWindowTokens, 500000);
  assert.equal(parsed.get('exact').maxOutputTokens, 32000);
  assert.equal(parsed.get('bad').contextWindowTokens, undefined);
  assert.equal(parsed.get('bad').maxContextWindowTokens, undefined);
  assert.equal(JSON.stringify([...parsed.values()]).includes('never-publish'), false);
  assert.throws(() => parseCodexModelMetadata({ unrelated: [] }), /Invalid native model metadata/);
});

test('fresh cache beats bundled limits without confusing active, maximum, or effective context', async () => {
  const { resolver, calls } = metadataFixture();
  const original = listModel('native-exact', { hidden: true });
  const result = await resolver.resolve([original]);
  const model = result.models[0];
  assert.equal(model.contextWindowTokens, 500000);
  assert.equal(model.runtimeDefaultContextWindowTokens, 500000);
  assert.equal(model.maxContextWindowTokens, 872000);
  assert.equal(model.effectiveContextWindowPercent, 95);
  assert.equal(model.contextWindowSource, 'runtime-reported');
  assert.equal(model.contextWindowObservedAt, fetchedAt);
  assert.equal(model.contextWindowEvidence.modelId, 'native-exact');
  assert.equal(model.contextWindowEvidence.endpointSpecific, true);
  assert.equal(model.contextWindowEvidence.path, resolver.cachePath);
  assert.equal(model.maxOutputTokens, undefined, 'native truncation/budget metadata does not imply max output');
  assert.equal(model.hidden, true);
  assert.equal(model.modelLimitLookup.status, 'partial');
  assert.equal(original.contextWindowTokens, undefined, 'input model rows are not mutated');
  assert.deepEqual(calls.map(call => call.args), [['debug', 'models', '--bundled']]);
  await resolver.resolve([original]);
  assert.equal(calls.length, 1, 'bundled metadata is reused within one native runtime');
});

test('exact lookup leaves an absent chat-thinking model unresolved and exposes checked sources', async () => {
  const { resolver } = metadataFixture({ cacheModels: [rawModel('gpt-6-astra')], bundleModels: [rawModel('gpt-6-astra')] });
  const result = await resolver.resolve([listModel('gpt-6-chat-thinking')]);
  const missing = result.models[0];
  assert.equal(missing.contextWindowTokens, undefined);
  assert.equal(missing.maxOutputTokens, undefined);
  assert.equal(missing.modelLimitLookup.status, 'unresolved');
  assert.ok(missing.modelLimitLookup.sources.every(source => source.status === 'not-found'));
  assert.match(missing.modelLimitLookup.reason, /exact/);
});

test('missing, stale, malformed and future cache data fall back to exact bundled metadata', async () => {
  const missing = Object.assign(new Error('private path'), { code: 'ENOENT' });
  for (const cache of [missing, '{broken-json', JSON.stringify({ fetched_at: '2026-10-28T00:00:00Z', models: [rawModel('native-exact', 999999)] }), JSON.stringify({ fetched_at: '2026-11-02T00:00:00Z', models: [rawModel('native-exact', 999999)] })]) {
    const { resolver } = metadataFixture({ cache });
    const result = await resolver.resolve([listModel('native-exact')]);
    assert.equal(result.models[0].contextWindowTokens, 272000);
    assert.equal(result.models[0].contextWindowEvidence.path, 'codex.exe');
    assert.equal(result.models[0].modelLimitLookup.sources.find(source => source.id === 'codex-cache').status, 'unavailable');
  }
});

test('explicit refresh invokes only bounded raw metadata command and prefers its exact values', async () => {
  const { resolver, calls } = metadataFixture({ options: { args: ['-c', 'model_context_window=128000', '--enable=example', 'app-server', '--transport', 'stdio'] } });
  const result = await resolver.resolve([listModel('native-exact')], { refresh: true });
  assert.equal(result.models[0].contextWindowTokens, 600000);
  assert.equal(result.models[0].contextWindowObservedAt, new Date(now).toISOString());
  assert.equal(result.models[0].contextWindowEvidence.path, 'codex.exe');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.args.includes('debug') && call.args.includes('models'));
    assert.equal(call.args.includes('app-server'), false);
    assert.equal(call.args.includes('--transport'), false);
    assert.deepEqual(call.args.slice(0, 3), ['-c', 'model_context_window=128000', '--enable=example']);
    assert.ok(call.options.timeout > 0 && call.options.timeout <= 8000);
    assert.ok(call.options.maxBuffer <= 8 * 1024 * 1024);
  }
  const failedRefresh = metadataFixture({ rawError: true });
  const fallback = await failedRefresh.resolver.resolve([listModel('native-exact')], { refresh: true });
  assert.equal(fallback.models[0].contextWindowTokens, 500000);
  assert.equal(fallback.models[0].modelLimitLookup.sources.find(source => source.id === 'codex-runtime').status, 'unavailable');
  assert.equal(JSON.stringify(fallback).includes('private upstream diagnostic'), false);
});

test('model list capacities win, while explicit effective native configuration remains authoritative', async () => {
  const { resolver } = metadataFixture({ cacheModels: [rawModel('native-exact', 500000, { max_output_tokens: 32000 })] });
  const listed = listModel('native-exact', { contextWindowTokens: 640000, contextWindowSource: 'provider-reported', maxOutputTokens: 16000, maxOutputTokensSource: 'provider-reported' });
  const normal = (await resolver.resolve([listed])).models[0];
  assert.equal(normal.contextWindowTokens, 640000);
  assert.equal(normal.contextWindowSource, 'provider-reported');
  assert.equal(normal.maxOutputTokens, 16000);
  assert.equal(normal.modelLimitLookup.status, 'resolved');
  const configured = (await resolver.resolve([listed], { config: { model_context_window: 128000, model_auto_compact_token_limit: 110000, unrelated: 'never-publish' } })).models[0];
  assert.equal(configured.contextWindowTokens, 128000);
  assert.equal(configured.contextWindowSource, 'user-configured');
  assert.equal(configured.runtimeDefaultContextWindowTokens, 500000);
  assert.equal(configured.nativeAutoCompactTokenLimit, 110000);
  assert.equal(configured.maxOutputTokens, 16000);
  assert.equal(configured.contextWindowEvidence.label, 'Codex effective configuration');
  assert.equal(JSON.stringify(configured).includes('never-publish'), false);
});

test('metadata candidates remain separate, exact and unverified even when their limits are known', async () => {
  const { resolver } = metadataFixture({ cacheModels: [rawModel('native-exact')], bundleModels: [
    rawModel('native-exact', 272000), rawModel('gpt-daybreak-blue-latest', 272000), rawModel('gpt-daybreak-red-latest', 372000, { max_context_window: 372000 }),
  ] });
  const result = await resolver.resolve([listModel('native-exact', { hidden: true })]);
  assert.deepEqual(result.models.map(model => model.id), ['native-exact']);
  assert.deepEqual(result.candidates.map(model => model.id), ['gpt-daybreak-blue-latest', 'gpt-daybreak-red-latest']);
  for (const candidate of result.candidates) {
    assert.equal(candidate.source, 'runtime-candidate');
    assert.deepEqual(candidate.access, { state: 'unverified' });
    assert.equal(candidate.contextWindowSource, 'runtime-reported');
    assert.equal(candidate.contextWindowEvidence.modelId, candidate.id);
  }
  assert.equal(result.candidates[1].contextWindowTokens, 372000);
  assert.equal(result.candidates[1].maxContextWindowTokens, 372000);
  assert.equal(result.models[0].hidden, true);
});

test('unavailable metadata stays truthful and does not discard the native list', async () => {
  const { resolver } = metadataFixture({ cache: Object.assign(new Error('secret'), { code: 'ENOENT' }), rawError: true, bundleError: true });
  const result = await resolver.resolve([listModel('native-exact', { hidden: true })], { refresh: true });
  assert.equal(result.models[0].id, 'native-exact');
  assert.equal(result.models[0].contextWindowTokens, undefined);
  assert.equal(result.models[0].modelLimitLookup.status, 'unavailable');
  assert.equal(result.lookup.status, 'unavailable');
  assert.match(result.models[0].modelLimitLookup.reason, /Refresh/);
  assert.deepEqual(result.candidates, []);
});

test('configured CODEX_HOME selects both cache location and metadata subprocess environment', async () => {
  const explicit = path.join(cwd, 'isolated-codex-home');
  assert.equal(codexMetadataHome({ env: { CODEX_HOME: explicit }, home: cwd }), path.resolve(explicit));
  assert.equal(codexMetadataHome({ env: {}, home: cwd }), path.resolve(cwd, '.codex'));
  const { resolver, calls, reads } = metadataFixture({ options: { codexHome: explicit, env: { CODEX_HOME: path.join(cwd, 'other-home') } } });
  await resolver.resolve([listModel('native-exact')], { refresh: true });
  assert.equal(reads[0].file, path.join(explicit, 'models_cache.json'));
  assert.equal(calls[0].options.env.CODEX_HOME, explicit);
});

test('custom runtime commands do not accidentally start metadata subprocesses', async () => {
  const resolver = new CodexModelMetadata({ command: process.execPath, args: ['fixture.mjs'], readFileImpl() { throw Error('unexpected read'); }, execFileImpl() { throw Error('unexpected subprocess'); } });
  const models = [listModel('native-exact')];
  const result = await resolver.resolve(models, { refresh: true });
  assert.equal(result.models, models);
  assert.deepEqual(result.candidates, []);
});

test('native catalog keeps hidden models on every page and publishes metadata candidates without advertising them', async () => {
  const entries = Array.from({ length: 201 }, (_, index) => listModel('native-' + index, { hidden: index % 2 === 0, isDefault: index === 0 }));
  const { resolver } = metadataFixture({ cacheModels: entries.map(model => rawModel(model.id)), bundleModels: [rawModel('metadata-only', 272000)] });
  const client = new CodexRuntime({ command: process.execPath, nativeModelMetadata: resolver });
  client.child = {}; client.info.connected = true; const requests = [];
  client._request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'fixture' }, requiresOpenaiAuth: true };
    if (method === 'config/read') return { config: {} };
    if (method === 'model/list') {
      const start = Number(params.cursor || 0), end = start + params.limit;
      return { data: entries.slice(start, end), nextCursor: end < entries.length ? String(end) : null };
    }
    throw Error('Unexpected fixture method ' + method);
  };
  const result = await client.start({ refresh: true });
  assert.equal(result.models.length, 201);
  assert.equal(result.models[200].hidden, true);
  assert.ok(requests.filter(request => request.method === 'model/list').every(request => request.params.includeHidden === true && request.params.limit === 100));
  assert.equal(requests.filter(request => request.method === 'model/list').length, 6, 'explicit metadata refresh rereads every authoritative page once');
  assert.equal(result.modelCatalog.hiddenModelsIncluded, true);
  assert.equal(result.models[200].contextWindowTokens, 500000);
  assert.equal(result.modelMetadataCandidates.find(model => model.id === 'metadata-only').access.state, 'unverified');
  assert.equal(result.models.some(model => model.id === 'metadata-only'), false);
  assert.equal(result.modelCatalog.modelLimitLookup.status, 'partial');
});

test('initial native turn context uses resolved capacity before the first token usage message', async t => {
  const fixture = fileURLToPath(new URL('./fixtures/fake-app-server.mjs', import.meta.url));
  const { resolver } = metadataFixture({ cacheModels: [rawModel('fixture-model')], bundleModels: [] });
  const client = new CodexRuntime({ command: process.execPath, args: [fixture], cwd, nativeModelMetadata: resolver, requestTimeoutMs: 3000, runTimeoutMs: 8000 });
  t.after(() => client.close());
  // This legacy process fixture predates capability isolation. Supply only its
  // missing metadata RPCs; the real native turn/context path still runs below.
  const request = client._request.bind(client);
  client._request = (method, params, ...rest) => method === 'config/read' ? Promise.resolve({ config: {} })
    : method === 'skills/list' ? Promise.resolve({ data: [{ cwd, skills: [], errors: [] }] })
    : request(method, params, ...rest);
  const events = [];
  await client.runAgent({ cwd, prompt: 'Local metadata fixture.', context: { preset: 'model' }, onEvent: event => events.push(event) });
  const initial = events.find(event => event.type === 'context')?.context;
  assert.ok(initial);
  assert.equal(initial.nativeConfiguredWindowTokens, 500000);
  assert.equal(initial.nativeDefaultContextWindowTokens, 500000);
  assert.equal(initial.configuredModelWindowTokens, 475000);
  assert.equal(initial.effectiveWindowTokens, 475000);
  assert.equal(initial.nativeWindowBasis, 'metadata-percent');
  assert.equal(initial.windowSource, 'runtime-reported');
});

test('native context preserves an explicit configuration over later generic usage metadata', () => {
  const client = new CodexRuntime({ command: process.execPath, nativeModelMetadata: false });
  const context = client._context({ threadId: 'fixture', contextModelWindow: 128000, contextModelWindowSource: 'user-configured', contextOptions: { preset: 'model' }, usage: { modelContextWindow: 500000 }, compactions: [] });
  assert.equal(context.configuredModelWindowTokens, 128000);
  assert.equal(context.modelWindowTokens, null);
  assert.equal(context.effectiveWindowTokens, 128000);
  assert.equal(context.windowSource, 'user-configured');
});


for (const metadataKnown of [false, true]) test('explicit native refresh rereads 10 to 11 advertised models after metadata refresh: ' + (metadataKnown ? 'exact limits available' : 'new model limits unknown'), async () => {
  const initial = Array.from({ length: 10 }, (_, index) => listModel('old-' + index, { isDefault: index === 0 }));
  const thinking = listModel('gpt-6-chat-thinking', { hidden: true });
  const rawModels = initial.map(model => rawModel(model.id));
  if (metadataKnown) rawModels.push(rawModel(thinking.id, 272000));
  const { resolver, calls, reads } = metadataFixture({ cacheModels: initial.map(model => rawModel(model.id)), rawModels, bundleModels: [rawModel('metadata-only', 8192)] });
  let refreshed = false;
  const execute = resolver.execFile;
  resolver.execFile = async (command, args, options) => {
    const result = await execute(command, args, options);
    if (!args.includes('--bundled')) refreshed = true;
    return result;
  };
  const client = new CodexRuntime({ command: process.execPath, nativeModelMetadata: resolver });
  client.child = {}; client.info.connected = true; const pages = [];
  client._request = async (method, params) => {
    if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'fixture' }, requiresOpenaiAuth: true };
    if (method === 'config/read') return { config: {} };
    if (method === 'model/list') {
      const models = refreshed ? [...initial, thinking] : initial;
      pages.push({ params, count: models.length });
      return { data: models, nextCursor: null };
    }
    throw Error('Unexpected fixture method ' + method);
  };
  const status = await client.start({ refresh: true });
  assert.deepEqual(pages.map(page => page.count), [10, 11]);
  assert.ok(pages.every(page => page.params.includeHidden === true));
  assert.equal(status.models.length, 11);
  const finalThinking = status.models.find(model => model.id === thinking.id);
  assert.equal(finalThinking.hidden, true);
  assert.equal(finalThinking.source, 'advertised');
  assert.deepEqual(finalThinking.access, { state: 'unverified' });
  assert.equal(finalThinking.contextWindowTokens, metadataKnown ? 272000 : undefined);
  assert.equal(finalThinking.modelLimitLookup.status, metadataKnown ? 'partial' : 'unresolved');
  if (metadataKnown) {
    assert.equal(finalThinking.contextWindowSource, 'runtime-reported');
    assert.equal(finalThinking.contextWindowEvidence.modelId, thinking.id);
    assert.equal(finalThinking.contextWindowEvidence.path, 'codex.exe');
  }
  assert.equal(status.modelMetadataCandidates.some(model => model.id === thinking.id), false, 'the fresh native row is no longer a metadata-only candidate');
  assert.equal(status.models.some(model => model.id === 'metadata-only'), false, 'metadata never promotes an unadvertised candidate');
  assert.equal(calls.filter(call => !call.args.includes('--bundled')).length, 1, 'one bounded raw metadata refresh');
  assert.equal(reads.length, 1, 'the final list reuses the captured metadata snapshot');
  assert.doesNotThrow(() => structuredClone(status), 'internal metadata callbacks never enter public status');
  assert.equal(Object.hasOwn(status, 'reapply'), false);
  assert.equal(Object.hasOwn(status.modelCatalog, 'reapply'), false);
});

test('ordinary native startup does not add a speculative catalog reread or raw refresh', async () => {
  const { resolver, calls } = metadataFixture();
  const client = new CodexRuntime({ command: process.execPath, nativeModelMetadata: resolver });
  client.child = {}; let lists = 0;
  client._request = async method => {
    if (method === 'account/read') return { account: { type: 'chatgpt' }, requiresOpenaiAuth: true };
    if (method === 'config/read') return { config: {} };
    if (method === 'model/list') { lists++; return { data: [listModel('native-exact')], nextCursor: null }; }
    throw Error('Unexpected fixture method ' + method);
  };
  const status = await client._refreshCatalog();
  assert.equal(status.models.length, 1);
  assert.equal(lists, 1);
  assert.ok(calls.every(call => call.args.includes('--bundled')));
});
