import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LocalModelManager, registerLocalModel } from '../lib/local-model-manager.mjs';
import { localModelHTTP } from '../lib/local-model-http.mjs';

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fixtureFetch = calls => async (url, options = {}) => {
  const route = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : null;
  calls.push({ url, route, body });
  if (route === '/api/tags') return reply({ models: [{ name: 'qwen-local:latest', size: 1_000_000, details: { quantization_level: 'F16' } }] });
  if (route === '/api/ps') return reply({ models: [{ name: 'qwen-local:latest' }] });
  if (route === '/api/v1/models') return reply({ models: [{ type: 'llm', key: 'qwen/local', display_name: 'Qwen local', loaded_instances: [{ id: 'qwen-instance' }] }, { type: 'embedding', key: 'embedding' }] });
  if (route === '/api/generate') return reply({ model: body.model, done: true });
  if (route === '/api/v1/models/load') return reply({ status: 'loaded', instance_id: 'qwen-instance' });
  if (route === '/api/v1/models/unload') return reply({ instance_id: body.instance_id });
  throw Error('Unexpected request ' + route);
};

test('discovers downloaded models and loaded instances from both local engines', async () => {
  const calls = [], manager = new LocalModelManager({ fetchImpl: fixtureFetch(calls) });
  const { engines } = await manager.list();
  assert.equal(engines[0].available, true);
  assert.deepEqual(engines[0].models.map(item => [item.id, item.loaded, item.format]), [['qwen-local:latest', true, 'F16']]);
  assert.equal(engines[1].available, true);
  assert.deepEqual(engines[1].models.map(item => [item.id, item.loaded]), [['qwen/local', true]]);
  assert.deepEqual(engines[1].models[0].instanceIds, ['qwen-instance']);
  assert.equal(calls.filter(call => call.route === '/api/v1/models').length, 1);
});

test('loading and unloading only use the chosen local runtime; context is passed without changing precision', async () => {
  const calls = [], manager = new LocalModelManager({ fetchImpl: fixtureFetch(calls) });
  const first = await manager.load({ engine: 'ollama', model: 'qwen-local:latest', contextLength: 8192 });
  assert.equal(first.loaded, true);
  assert.deepEqual(calls.at(-1).body, { model: 'qwen-local:latest', prompt: '', stream: false, keep_alive: '30m', options: { num_ctx: 8192 } });
  const second = await manager.load({ engine: 'lmstudio', model: 'qwen/local' });
  assert.equal(second.instanceId, 'qwen-instance');
  assert.deepEqual(calls.at(-1).body, { model: 'qwen/local' });
  await manager.unload({ engine: 'lmstudio', model: 'qwen/local', instanceId: 'qwen-instance' });
  assert.deepEqual(calls.at(-1).body, { instance_id: 'qwen-instance' });
  await manager.unload({ engine: 'ollama', model: 'qwen-local:latest' });
  assert.equal(calls.at(-1).body.keep_alive, 0);
});

test('rejects invalid model identifiers and reports unavailable runtimes instead of saving a fake success', async () => {
  const manager = new LocalModelManager({ fetchImpl: async () => { throw Object.assign(new Error('connect failed'), { cause: { code: 'ECONNREFUSED' } }); } });
  assert.equal((await manager.list()).engines.every(item => item.available === false), true);
  await assert.rejects(() => manager.load({ engine: 'ollama', model: 'bad::model' }), /valid local model ID/);
  await assert.rejects(() => manager.load({ engine: 'ollama', model: 'model', contextLength: -1 }), /Context length/);
  await assert.rejects(() => manager.load({ engine: 'ollama', model: 'model' }), /not running/);
});

test('imports GGUF files and original Safetensors directories via Ollama CLI without quantization', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'blackice-model-fixture-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const gguf = path.join(temp, 'Sample F16.gguf');
  await writeFile(gguf, 'GGUF');
  const safetensors = path.join(temp, 'Qwen F16');
  await mkdir(safetensors);
  await writeFile(path.join(safetensors, 'config.json'), '{}');
  await writeFile(path.join(safetensors, 'model-00001-of-00001.safetensors'), 'weights');
  const invocations = [];
  const spawnImpl = (command, args, options) => {
    invocations.push({ command, args, options, modelfile: readFileSync(args[args.indexOf('-f') + 1], 'utf8') });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => child.emit('close', 0));
    return child;
  };
  const manager = new LocalModelManager({ spawnImpl, ollamaExecutable: 'mock-ollama' });
  const a = await manager.importFromDisk({ sourcePath: gguf, model: 'sample-f16' });
  const b = await manager.importFromDisk({ sourcePath: safetensors, model: 'qwen-f16' });
  assert.equal(a.sourceFormat, 'GGUF'); assert.equal(b.sourceFormat, 'Safetensors');
  assert.equal(a.quantizationRequested, false); assert.equal(b.quantizationRequested, false);
  for (const call of invocations) {
    assert.equal(call.command, 'mock-ollama');
    assert.deepEqual(call.args.slice(0, 2), ['create', call.args[1]]);
    assert.equal(call.args.includes('--quantize'), false);
    assert.match(call.modelfile, /^FROM "/);
    assert.equal(call.options.shell, false);
  }
  await assert.rejects(() => manager.importFromDisk({ sourcePath: temp, model: 'invalid' }), /Safetensors folder/);
});

test('registration preserves existing connection models and never silently changes the default', async () => {
  const calls = [];
  const providers = [{ id: 'my_ollama', preset: 'ollama', type: 'compatible', baseUrl: 'http://127.0.0.1:11434/v1', models: [{ id: 'old-model' }] }];
  const runtime = { listProviders: () => providers,
    saveProvider: async (config, options) => { calls.push({ config, options }); } };
  assert.deepEqual(await registerLocalModel(runtime, 'ollama', 'new-model'), { providerId: 'my_ollama', selection: 'my_ollama::new-model' });
  assert.deepEqual(calls[0].config, { id: 'my_ollama', enabled: true, models: ['old-model', 'new-model'] });
  assert.equal(calls[0].options.preserveDefault, true);
  const fresh = { listProviders: () => [{ id: 'local_lmstudio' }],
    saveProvider: async (config, options) => calls.push({ config, options }) };
  const result = await registerLocalModel(fresh, 'lmstudio', 'another');
  assert.equal(result.selection, 'local_lmstudio_2::another');
  assert.equal(calls[1].config.baseUrl, 'http://127.0.0.1:1234/v1');
});

test('local model HTTP loads and registers models, and refuses remote mutation', async () => {
  const calls = [], manager = {
    list: async () => ({ engines: [] }),
    load: async args => { calls.push({ kind: 'load', args }); return { engine: args.engine, model: args.model, loaded: true }; },
    unload: async args => { calls.push({ kind: 'unload', args }); return { loaded: false }; },
    importFromDisk: async args => { calls.push({ kind: 'import', args }); return { engine: 'ollama', model: args.model, imported: true }; },
  };
  const runtime = { listProviders: () => [], saveProvider: async args => calls.push({ kind: 'save', args }) };
  const blocked = await localModelHTTP({ manager, runtime, pathname: '/api/local-models/load', method: 'POST', remote: true, value: { engine: 'ollama', model: 'x' } });
  assert.equal(blocked.status, 403); assert.equal(calls.length, 0);
  const read = await localModelHTTP({ manager, runtime, pathname: '/api/local-models', method: 'GET' });
  assert.equal(read.status, 200);
  const imported = await localModelHTTP({ manager, runtime, pathname: '/api/local-models/import', method: 'POST', value: { sourcePath: 'C:\\Models\\Qwen', model: 'qwen-f16' } });
  assert.equal(imported.status, 200); assert.equal(imported.body.selection, 'local_ollama::qwen-f16');
  assert.deepEqual(calls.map(call => call.kind), ['import', 'load', 'save']);
  assert.equal((await localModelHTTP({ manager, runtime, pathname: '/api/local-models/import', method: 'POST', value: { model: 'x', unexpected: true } })).status, 400);
});

test('the local model settings module is registered in the static asset allowlist', async () => {
  const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(server, /'workspaces\/settings-local-models\.mjs'/);
});
