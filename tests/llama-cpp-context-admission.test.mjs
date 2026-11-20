import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProviderRuntime } from '../lib/providers.mjs';
import { workbenchFramePng } from './fixtures/legacy-bmp-to-png.mjs';

const modelId = 'mini.gguf';
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
class Native extends EventEmitter {
  status() { return { connected: true, authenticated: true, defaultModel: 'native', models: [{ id: 'native' }] }; }
  async close() {}
  async runAgent() { throw Error('Native inference is not allowed in this fixture.'); }
}
async function fixture(t, settings = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'llama-context-admission-'));
  const control = { capacity: 262144, vision: true, loaded: new Set(), acquired: [], released: 0, events: [], inferences: [], ...settings };
  const models = settings.models || [{ id: modelId, inputModalities: ['text'] }];
  const runtime = await new ProviderRuntime({ codex: new Native(), dataDir: dir, fetchImpl: async (url, request) => {
    const route = new URL(url).pathname;
    if (request.method === 'GET' && route === '/v1/models') {
      control.events.push('catalog');
      await control.beforeCatalog?.(request.signal);
      if (control.catalogUnavailable) return response({ error: { message: 'Catalog unavailable' } }, 404);
      return response({ data: models.map(model => ({ id: model.id,
        architecture: { input_modalities: control.loaded.has(model.id) && control.vision ? ['text', 'image'] : ['text'], output_modalities: ['text'] },
        ...(control.advertisedCapacity ? { context_length: control.advertisedCapacity, max_output_tokens: 8192 } : {}),
      })) });
    }
    if (request.method === 'GET' && route === '/models') {
      control.events.push('runtime');
      return response({ data: models.map(model => ({ id: model.id,
        status: { value: control.loaded.has(model.id) ? 'loaded' : 'unloaded' },
        ...(control.loaded.has(model.id) ? { meta: { n_ctx: control.capacity }, memory: { effective: { n_ctx: control.capacity * 4 } } } : {}),
      })) });
    }
    if (request.method === 'POST' && route === '/v1/chat/completions/input_tokens') return response({ input_tokens: control.measuredTokens || 50000 });
    assert.equal(route, '/v1/chat/completions', 'Only fixture inference is permitted');
    assert.equal(request.method, 'POST');
    const body = JSON.parse(request.body);
    assert.ok(control.loaded.has(body.model), 'The exact selected model must be loaded before inference');
    control.events.push('generate'); control.inferences.push(body);
    if (control.generationFailure) return response({ error: { message: 'Synthetic request failure' } }, 400);
    return response({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
  } }).init();
  runtime.localModels = { acquireLlama: async (model, { signal }) => {
    signal.throwIfAborted(); control.events.push('acquire'); control.acquired.push(model);
    if (control.acquireFailure) throw Object.assign(Error('Synthetic model load failure'), { code: 'LOCAL_MODEL_UNAVAILABLE' });
    control.loaded.add(model);
    return { release() { control.events.push('release'); control.released++; } };
  } };
  await runtime.store.save({ id: 'local_llamacpp', type: 'compatible', preset: 'llamacpp', baseUrl: settings.baseUrl || 'http://127.0.0.1:8080/v1', models, maxTokens: 4096 });
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  return { runtime, dir, control, options: { cwd: dir, prompt: 'Read this request.', model: 'local_llamacpp::' + modelId, dynamicTools: [], context: { autoCompact: false } } };
}
function pngURL() {
  const bytes = Buffer.alloc(58); bytes.write('BM'); bytes.writeUInt32LE(58, 2); bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(1, 18); bytes.writeInt32LE(-1, 22); bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(32, 28);
  bytes[54] = 91; bytes[55] = 43; bytes[56] = 17;
  return 'data:image/png;base64,' + workbenchFramePng({ bytes, width: 1, height: 1, contentType: 'image/bmp' }).toString('base64');
}

test('cold catalog browsing does not load a model, then admission uses its newly allocated slot capacity', async t => {
  const f = await fixture(t);
  const cold = await f.runtime.discoverModels('local_llamacpp', { refresh: true });
  assert.equal(cold.selectedModels[0].contextWindowTokens, null);
  assert.deepEqual(f.control.acquired, []);
  f.control.events.length = 0;
  const result = await f.runtime.runAgent({ ...f.options, responseOnly: true, prompt: 'a'.repeat(400000) });
  assert.equal(result.output, 'ok');
  assert.equal(result.context.effectiveWindowTokens, 262144);
  assert.equal(result.context.windowSource, 'runtime-reported');
  assert.ok(result.context.estimatedInputTokens > 128000, 'The old fallback would reject this prompt');
  assert.deepEqual(f.control.events, ['acquire', 'catalog', 'runtime', 'generate', 'release']);
  assert.deepEqual(f.control.acquired, [modelId]);
  assert.equal(f.control.released, 1);
  assert.equal(f.runtime.active.size, 0);
});

test('extended context is validated after a cold managed model reports its allocation', async t => {
  const f = await fixture(t);
  const result = await f.runtime.runAgent({ ...f.options, context: { preset: 'extended', autoCompact: false } });
  assert.equal(result.context.effectiveWindowTokens, 262144);
  assert.equal(result.context.requestedWindowTokens, 262144);
  assert.equal(f.control.released, 1);
});

test('explicit smaller model capacity, working window and output limit survive live discovery', async t => {
  const f = await fixture(t, { models: [{ id: modelId, contextWindowTokens: 65536, maxOutputTokens: 1024 }] });
  const before = await readFile(path.join(f.dir, 'providers.json'), 'utf8');
  const result = await f.runtime.runAgent({ ...f.options, context: { preset: 'custom', windowTokens: 32768, autoCompact: false } });
  assert.equal(result.context.effectiveWindowTokens, 32768);
  assert.equal(result.context.configuredModelWindowTokens, 65536);
  assert.equal(result.context.windowSource, 'user-configured');
  assert.equal(f.control.inferences[0].max_tokens, 1024);
  assert.equal(await readFile(path.join(f.dir, 'providers.json'), 'utf8'), before, 'Observations do not rewrite saved choices');
});

test('a manual capacity larger than the live slot is capped without replacing a smaller output limit', async t => {
  for (const catalogUnavailable of [false, true]) await t.test('catalogUnavailable=' + catalogUnavailable, async t => {
    const f = await fixture(t, { capacity: 8192, advertisedCapacity: 262144, catalogUnavailable, models: [{ id: modelId, contextWindowTokens: 262144, maxOutputTokens: 1024 }] });
    const result = await f.runtime.runAgent({ ...f.options, responseOnly: true });
    assert.equal(result.context.effectiveWindowTokens, 8192);
    assert.equal(result.context.windowSource, 'runtime-reported');
    assert.equal(f.control.inferences[0].max_tokens, 1024);
    await assert.rejects(f.runtime.runAgent({ ...f.options, responseOnly: true, prompt: 'a'.repeat(30000) }), { code: 'CONTEXT_OVERFLOW' });
    assert.equal(f.control.inferences.length, 1, 'Oversized requests fail before generation');
    assert.equal(f.control.released, 2);
  });
});

test('fresh image modalities replace stale text-only observations before image admission', async t => {
  const f = await fixture(t), imageUrl = pngURL();
  await f.runtime.discoverModels('local_llamacpp', { refresh: true });
  const result = await f.runtime.runAgent({ ...f.options, responseOnly: true, inputImages: [{ imageUrl }] });
  assert.equal(result.output, 'ok');
  const user = f.control.inferences[0].messages.find(message => message.role === 'user');
  assert.equal(user.content.find(block => block.type === 'image_url').image_url.url, imageUrl);
  assert.deepEqual(f.runtime.listProviders().find(provider => provider.id === 'local_llamacpp').models[0].inputModalities, ['text', 'image']);
  assert.deepEqual(f.runtime.store.get('local_llamacpp').models[0].inputModalities, ['text'], 'Saved configuration is not rewritten');
  f.control.vision = false;
  await assert.rejects(f.runtime.runAgent({ ...f.options, responseOnly: true, inputImages: [{ imageUrl }] }), { code: 'INPUT_IMAGES_UNSUPPORTED' });
  assert.equal(f.control.inferences.length, 1, 'A removed projector is not masked by an old image-capable cache');
  assert.equal(f.control.released, 2);
  await assert.rejects(f.runtime.runAgent({ ...f.options, inputImages: [{ imageUrl }] }), { code: 'INVALID_INPUT_IMAGES' });
  assert.equal(f.control.acquired.length, 2, 'Initial images still require an analytical response');
});

test('resuming a saved thread retains its model and refreshes an obsolete server-error capacity', async t => {
  const f = await fixture(t, { capacity: 65536, models: [{ id: modelId }, { id: 'other.gguf' }] });
  const first = await f.runtime.runAgent(f.options);
  const record = await f.runtime.readThread(first.threadId); record.reportedContextWindow = 8192; await f.runtime.persistThread(record);
  await f.runtime.store.setDefaultModel('local_llamacpp::other.gguf'); f.control.capacity = 262144;
  const { model, ...options } = f.options;
  const result = await f.runtime.runAgent({ ...options, threadId: first.threadId, prompt: 'Continue the saved conversation.' });
  assert.equal(result.context.effectiveWindowTokens, 262144);
  assert.equal(result.context.windowSource, 'runtime-reported');
  assert.deepEqual(f.control.acquired, [modelId, modelId]);
  assert.equal((await f.runtime.readThread(first.threadId)).reportedContextWindow, undefined);
  assert.equal(f.control.released, 2);
});

test('catalog failure still permits native capacity lookup for the selected managed model', async t => {
  const f = await fixture(t, { catalogUnavailable: true });
  const result = await f.runtime.runAgent(f.options);
  assert.equal(result.context.effectiveWindowTokens, 262144);
  assert.equal(f.control.released, 1);
});

test('a cancelled metadata refresh and a failed generation each release the admitted model once', async t => {
  for (const failure of ['cancel', 'generation']) await t.test(failure, async t => {
    const f = await fixture(t), controller = new AbortController();
    if (failure === 'cancel') f.control.beforeCatalog = () => controller.abort();
    else f.control.generationFailure = true;
    await assert.rejects(f.runtime.runAgent({ ...f.options, signal: controller.signal }), failure === 'cancel' ? { code: 'ABORT_ERR' } : /Synthetic request failure/);
    assert.equal(f.control.acquired.length, 1);
    assert.equal(f.control.released, 1);
    assert.equal(f.runtime.active.size, 0);
    if (failure === 'cancel') assert.equal(f.control.inferences.length, 0);
  });
});

test('a model load failure never attempts discovery or inference and leaves no active run', async t => {
  const f = await fixture(t, { acquireFailure: true });
  await assert.rejects(f.runtime.runAgent(f.options), { code: 'LOCAL_MODEL_UNAVAILABLE' });
  assert.deepEqual(f.control.events, ['acquire']);
  assert.equal(f.control.released, 0, 'A failed acquisition returns no lease');
  assert.equal(f.runtime.active.size, 0);
});

test('manual compaction refreshes a changed allocation and releases even when no old history exists', async t => {
  const f = await fixture(t, { capacity: 65536 });
  const result = await f.runtime.runAgent(f.options); f.control.capacity = 262144;
  const compacted = await f.runtime.compactThread(result.threadId);
  assert.equal(compacted.compacted, false);
  assert.equal(compacted.context.effectiveWindowTokens, 262144);
  assert.equal(f.control.inferences.length, 1);
  assert.equal(f.control.acquired.length, 2);
  assert.equal(f.control.released, 2);
});

test('output profile failure releases the prepared model before generation', async t => {
  const f = await fixture(t);
  f.runtime.compatibleOutputProfile = async () => { throw Object.assign(Error('Synthetic output profile failure'), { code: 'PROVIDER_RESPONSE_FORMAT' }); };
  await assert.rejects(f.runtime.runAgent({ ...f.options, responseOnly: true, outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } }), { code: 'PROVIDER_RESPONSE_FORMAT' });
  assert.equal(f.control.released, 1);
  assert.equal(f.control.inferences.length, 0);
  assert.equal(f.runtime.active.size, 0);
});

test('localhost and equivalent trailing-slash routes receive managed context preflight without rewriting the saved URL', async t => {
  for (const baseUrl of ['http://localhost:8080/v1', 'http://localhost:8080/v1/', 'http://127.0.0.1:8080/v1/']) await t.test(baseUrl, async t => {
    const f = await fixture(t, { baseUrl }), savedUrl = f.runtime.store.get('local_llamacpp').baseUrl;
    const result = await f.runtime.runAgent(f.options);
    assert.equal(result.context.effectiveWindowTokens, 262144);
    assert.deepEqual(f.control.acquired, [modelId]);
    assert.equal(f.control.released, 1);
    assert.equal(f.runtime.store.get('local_llamacpp').baseUrl, savedUrl);
  });
});

test('other ports and remote llama.cpp URLs never acquire the managed local server', async t => {
  for (const baseUrl of ['http://127.0.0.1:18080/v1', 'http://localhost:18080/v1', 'http://llama.example:8080/v1']) await t.test(baseUrl, async t => {
    const f = await fixture(t, { baseUrl }); f.control.loaded.add(modelId);
    const result = await f.runtime.runAgent(f.options);
    assert.equal(result.output, 'ok');
    assert.deepEqual(f.control.acquired, []);
    assert.equal(f.control.released, 0);
    assert.deepEqual(f.control.events, ['generate']);
  });
});
