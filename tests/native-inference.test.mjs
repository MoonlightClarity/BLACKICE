import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { float16ToFloat32, bfloat16ToFloat32, decodeFloatTensor } from '../lib/native-inference/precision.mjs';
import { SafetensorsFile, openSafetensorsModel } from '../lib/native-inference/safetensors.mjs';
import { matvec, rmsNorm, groupedAttention, rotateRopeInPlace, Qwen3Reference } from '../lib/native-inference/reference-qwen3.mjs';
import { LlamaCppBackend } from '../lib/native-inference/llama-cpp.mjs';
import { BuiltinInferenceManager } from '../lib/native-inference/backends.mjs';

const modelConfig = {
  model_type: 'qwen3', hidden_size: 2, num_hidden_layers: 1, num_attention_heads: 2,
  num_key_value_heads: 1, head_dim: 2, intermediate_size: 2, vocab_size: 3,
  max_position_embeddings: 16, rms_norm_eps: 1e-6, rope_theta: 10000,
  tie_word_embeddings: true, eos_token_id: 2,
};
const shapes = {
  'model.embed_tokens.weight': [3, 2],
  'model.layers.0.input_layernorm.weight': [2],
  'model.layers.0.self_attn.q_proj.weight': [4, 2],
  'model.layers.0.self_attn.k_proj.weight': [2, 2],
  'model.layers.0.self_attn.v_proj.weight': [2, 2],
  'model.layers.0.self_attn.q_norm.weight': [2],
  'model.layers.0.self_attn.k_norm.weight': [2],
  'model.layers.0.self_attn.o_proj.weight': [2, 4],
  'model.layers.0.post_attention_layernorm.weight': [2],
  'model.layers.0.mlp.gate_proj.weight': [2, 2],
  'model.layers.0.mlp.up_proj.weight': [2, 2],
  'model.layers.0.mlp.down_proj.weight': [2, 2],
  'model.norm.weight': [2],
};
const weightData = name => {
  if (name === 'model.embed_tokens.weight') return [1, 0, 0, 1, -1, 0];
  if (name.endsWith('_norm.weight') || name === 'model.norm.weight' || name.endsWith('layernorm.weight')) return [1, 1];
  return Array(shapes[name].reduce((a, b) => a * b, 1)).fill(0);
};
const tensorMap = Object.fromEntries(Object.entries(shapes).map(([name, shape]) => [name,
  { shape, data: Float32Array.from(weightData(name)) }]));
const tensors = { async tensor(name) {
  if (!(name in tensorMap)) throw Error('Unknown tensor: ' + name);
  return tensorMap[name];
}, release() {} };

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'blackice-native-inference-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function writeSafetensorsBuffer(entries, { overlap = false } = {}) {
  const manifest = {}, parts = []; let offset = 0;
  for (const [name, { shape, data }] of Object.entries(entries)) {
    const values = Float32Array.from(data);
    const bytes = Buffer.allocUnsafe(values.length * 4);
    values.forEach((number, i) => bytes.writeFloatLE(number, i * 4));
    manifest[name] = { dtype: 'F32', shape, data_offsets: [overlap ? 0 : offset, (overlap ? 0 : offset) + bytes.length] };
    parts.push(bytes); offset += bytes.length;
  }
  const json = Buffer.from(JSON.stringify(manifest));
  const prefix = Buffer.allocUnsafe(8); prefix.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([prefix, json, ...parts]);
}

test('BLACKICE owns precision conversion without quantizing original weights', () => {
  assert.equal(float16ToFloat32(0x3c00), 1);
  assert.equal(float16ToFloat32(0xc000), -2);
  assert.equal(float16ToFloat32(0x0001), 2 ** -24);
  assert.equal(float16ToFloat32(0x7c00), Infinity);
  assert.ok(Number.isNaN(float16ToFloat32(0x7e00)));
  assert.equal(bfloat16ToFloat32(0x3f80), 1);
  assert.equal(bfloat16ToFloat32(0xc000), -2);
  assert.deepEqual([...decodeFloatTensor(Buffer.from([0, 0x3c, 0, 0xc0]), 'F16')], [1, -2]);
});

test('read Safetensors metadata lazily and recover exact float tensors from disk', async t => {
  const dir = await fixture(t), file = path.join(dir, 'model.safetensors');
  await writeFile(file, writeSafetensorsBuffer(tensorMap));
  const reader = await new SafetensorsFile(file).init();
  assert.equal(reader.entries.size, Object.keys(shapes).length);
  assert.deepEqual(reader.entries.get('model.embed_tokens.weight').shape, [3, 2]);
  const embedding = await reader.tensor('model.embed_tokens.weight');
  assert.deepEqual([...embedding.data], [1, 0, 0, 1, -1, 0]);
  assert.equal(await reader.tensor('model.embed_tokens.weight'), embedding, 'lazy weight is cached');
  assert.equal(reader.cache.size, 1);
  reader.release();
  assert.equal(reader.cache.size, 0);
  await assert.rejects(() => reader.tensor('unknown'), /weight is missing/);
});

test('model directory loads only local Qwen3 configuration and validated shards', async t => {
  const dir = await fixture(t);
  await writeFile(path.join(dir, 'config.json'), JSON.stringify(modelConfig));
  await writeFile(path.join(dir, 'model.safetensors'), writeSafetensorsBuffer(tensorMap));
  const loaded = await openSafetensorsModel(dir);
  assert.equal(loaded.config.model_type, 'qwen3');
  assert.equal(loaded.tensors, Object.keys(shapes).length);
  assert.deepEqual(loaded.sourcePrecision, ['F32']);
  assert.deepEqual([...((await loaded.tensor('model.norm.weight')).data)], [1, 1]);
  loaded.release();
});

test('malformed Safetensors headers and overlapping ranges are rejected', async t => {
  const dir = await fixture(t);
  const file = path.join(dir, 'broken.safetensors');
  await writeFile(file, Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f, 0x7b, 0x7d]));
  await assert.rejects(() => new SafetensorsFile(file).init(), /header length/);
  await writeFile(file, writeSafetensorsBuffer({ a: { shape: [1], data: [1] }, b: { shape: [1], data: [2] } }, { overlap: true }));
  await assert.rejects(() => new SafetensorsFile(file).init(), /overlapping/);
});

test('independent BLACKICE transformer operators implement RMSNorm, GQA and rotate-half RoPE', () => {
  assert.deepEqual([...matvec(Float32Array.from([1, 2, 3, 4]), 2, 2, Float32Array.from([2, 1]))], [4, 10]);
  const norm = rmsNorm(Float32Array.from([3, 4]), Float32Array.from([1, 1]), 1e-6);
  assert.ok(Math.abs(norm[0] - 3 / Math.sqrt(12.5 + 1e-6)) < 1e-6);
  const query = Float32Array.from([1, 0, 1, 0]);
  const keys = [Float32Array.from([1, 0]), Float32Array.from([0, 1])];
  const vals = [Float32Array.from([2, 0]), Float32Array.from([0, 4])];
  const attention = groupedAttention(query, keys, vals, 2, 1, 2);
  assert.ok(attention[0] > 1 && attention[0] < 2);
  assert.ok(attention[1] > 0 && attention[1] < 2);
  assert.equal(attention[0], attention[2]);
  assert.equal(attention[1], attention[3]);
  const vector = Float32Array.from([1, 0, 0, 1]);
  rotateRopeInPlace(vector, 2, 2, 0, 10000);
  assert.deepEqual([...vector], [1, 0, 0, 1]);
  rotateRopeInPlace(vector, 2, 2, 1, 10000);
  assert.ok(Math.abs(vector[0] - Math.cos(1)) < 1e-6);
  assert.ok(Math.abs(vector[1] - Math.sin(1)) < 1e-6);
});

test('self-authored Qwen3 forward pass returns deterministic logits and saves KV cache', async () => {
  const model = new Qwen3Reference({ config: modelConfig, tensors, maxContext: 3 });
  const logits = await model.step(0);
  assert.equal(logits.length, 3);
  assert.ok(logits[0] > logits[1] && logits[1] > logits[2]);
  assert.equal(model.position, 1);
  assert.equal(model.cache[0].keys.length, 1);
  assert.equal(model.cache[0].keys[0].length, 2);
  assert.equal(model.cache[0].values.length, 1);
  model.reset();
  const emitted = [];
  assert.deepEqual(await model.generateTokenIds([0], { maxNewTokens: 2, onToken: id => emitted.push(id) }), [0, 0]);
  assert.deepEqual(emitted, [0, 0]);
  assert.equal(model.position, 2);
  await assert.rejects(() => model.step(0).then(() => model.step(0)), /Maximum reference context/);
});

test('cancelled reference inference cannot commit incomplete token KV state', async () => {
  const ctrl = new AbortController();
  const instrumented = { async tensor(name) {
    if (name === 'model.layers.0.self_attn.o_proj.weight') ctrl.abort();
    return tensors.tensor(name);
  } };
  const model = new Qwen3Reference({ config: modelConfig, tensors: instrumented });
  await assert.rejects(() => model.step(0, { signal: ctrl.signal }), /abort/i);
  assert.equal(model.position, 0);
  assert.equal(model.cache[0].keys.length, 0);
});

test('llama.cpp uses a standalone binary with an ephemeral prompt file, never Ollama/LM Studio', async t => {
  const dir = await fixture(t), gguf = path.join(dir, 'weights-f16.gguf');
  await writeFile(gguf, 'GGUF');
  const calls = [], chunks = [];
  const spawnImpl = (binary, args, options) => {
    const p = new EventEmitter();p.stdout = new EventEmitter();p.stderr = new EventEmitter();p.kill = () => p.emit('close', 1);
    calls.push({ binary, args, options, prompt: readFileSync(args[args.indexOf('--file') + 1], 'utf8') });
    process.nextTick(() => { p.stdout.emit('data', Buffer.from('Hello '));p.stdout.emit('data', Buffer.from('world'));p.emit('close', 0); });
    return p;
  };
  const engine = new LlamaCppBackend({ binaryPath: path.join(dir, 'llama-cli.exe'), accessImpl: async () => {}, spawnImpl });
  const result = await engine.generate({ modelPath: gguf, prompt: 'Secret test prompt', maxTokens: 4, onText: s => chunks.push(s) });
  assert.equal(result.text, 'Hello world');
  assert.deepEqual(chunks, ['Hello ', 'world']);
  assert.equal(calls[0].prompt, 'Secret test prompt');
  assert.equal(calls[0].binary.endsWith('llama-cli.exe'), true);
  assert.equal(calls[0].args.includes('Secret test prompt'), false);
  assert.equal(calls[0].args.includes('--offline'), true);
  assert.equal(calls[0].args.includes('--no-display-prompt'), true);
  assert.equal(calls[0].options.shell, false);
  await assert.rejects(() => engine.generate({ modelPath: 'some-model.gguf', prompt: 'hello' }), /absolute path/);
});

test('server exposes read-only native readiness without running inference on the main loop', async () => {
  const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(source, /\/api\/native-inference\/status/);
  assert.doesNotMatch(source, /\/api\/native-inference\/generate/);
});

test('native manager never silently replaces BLACKICE inference with llama.cpp', async () => {
  const manager = new BuiltinInferenceManager({
    llamaCpp: { available: async () => false },
    modelLoader: async () => ({ config: modelConfig, ...tensors }),
  });
  const status = await manager.status();
  assert.equal(status.engines[0].id, 'blackice');
  assert.equal(status.engines[1].available, false);
  assert.equal(status.engines[0].productionReady, false);
  await assert.rejects(() => manager.load({ backend: 'llama.cpp', modelPath: path.resolve('missing.gguf') }), /not been bundled/);
  const { id } = await manager.load({ backend: 'blackice', modelPath: path.resolve('mock-qwen3') });
  const result = await manager.generate({ id, tokenIds: [0], maxTokens: 1 });
  assert.deepEqual(result, { backend: 'blackice', tokens: [0] });
  await assert.rejects(() => manager.generate({ id, prompt: 'hi', maxTokens: 1 }), /pretokenized integer IDs/);
  assert.equal(manager.unload(id).unloaded, true);
  assert.equal((await manager.status()).sessions.length, 0);
});
