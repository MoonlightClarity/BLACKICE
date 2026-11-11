import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Qwen3WorkerHost } from '../lib/native-inference/worker-host.mjs';
import { BuiltinInferenceManager } from '../lib/native-inference/backends.mjs';

const fixtureConfig = {
  model_type: 'qwen3', hidden_size: 2, num_hidden_layers: 1,
  num_attention_heads: 2, num_key_value_heads: 1, head_dim: 2,
  intermediate_size: 2, vocab_size: 151936,
  max_position_embeddings: 64, rms_norm_eps: 1e-6,
  rope_theta: 10000, rope_scaling: null, tie_word_embeddings: true, eos_token_id: 151645,
};
const strings = [...'abcdefghijklmnopqrstuvwxyz', 'Ġ', 'Ċ', 'Ã', '©'];
const smallVocab = Object.fromEntries(strings.map((text, id) => [text, id]));
smallVocab.ab = strings.length;
const canonPattern = "(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+";
const tokenizerJson = {
  model: { type: 'BPE', vocab: smallVocab, merges: [['a', 'b']] },
  normalizer: { type: 'NFC' },
  pre_tokenizer: {
    type: 'Sequence',
    pretokenizers: [
      { type: 'Split', pattern: { Regex: canonPattern }, behavior: 'Isolated' },
      { type: 'ByteLevel', add_prefix_space: false, use_regex: false },
    ],
  },
  decoder: { type: 'ByteLevel' },
  added_tokens: [
    { id: 151643, content: '<|endoftext|>', special: true },
    { id: 151644, content: '<|im_start|>', special: true },
    { id: 151645, content: '<|im_end|>', special: true },
    { id: 151667, content: '<think>', special: false },
    { id: 151668, content: '</think>', special: false },
  ],
};
const shapes = Object.fromEntries([
  ['model.embed_tokens.weight', [fixtureConfig.vocab_size, 2]],
  ['model.layers.0.input_layernorm.weight', [2]],
  ['model.layers.0.self_attn.q_proj.weight', [4, 2]],
  ['model.layers.0.self_attn.k_proj.weight', [2, 2]],
  ['model.layers.0.self_attn.v_proj.weight', [2, 2]],
  ['model.layers.0.self_attn.q_norm.weight', [2]],
  ['model.layers.0.self_attn.k_norm.weight', [2]],
  ['model.layers.0.self_attn.o_proj.weight', [2, 4]],
  ['model.layers.0.post_attention_layernorm.weight', [2]],
  ['model.layers.0.mlp.gate_proj.weight', [2, 2]],
  ['model.layers.0.mlp.up_proj.weight', [2, 2]],
  ['model.layers.0.mlp.down_proj.weight', [2, 2]],
  ['model.norm.weight', [2]],
]);
function makeWeights() {
  const header = {}, blocks = []; let offset = 0;
  for (const [name, shape] of Object.entries(shapes)) {
    const count = shape.reduce((a, b) => a * b, 1), bytes = Buffer.alloc(count * 4);
    if (name.endsWith('_norm.weight') || name.endsWith('layernorm.weight')) {
      for (let i = 0; i < count; i++) bytes.writeFloatLE(1, i * 4);
    }
    header[name] = { dtype: 'F32', shape, data_offsets: [offset, offset + bytes.length] };
    offset += bytes.length; blocks.push(bytes);
  }
  const json = Buffer.from(JSON.stringify(header));
  const intro = Buffer.alloc(8); intro.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([intro, json, ...blocks]);
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blackice-native-worker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'config.json'), JSON.stringify(fixtureConfig));
  await writeFile(path.join(directory, 'tokenizer.json'), JSON.stringify(tokenizerJson));
  await writeFile(path.join(directory, 'model.safetensors'), makeWeights());
  return directory;
}

test('BLACKICE native model loads a real worker and emits text without llama.cpp', async t => {
  const modelDirectory = await fixture(t), host = new Qwen3WorkerHost({ modelDirectory, maxContext: 64 });
  t.after(() => host.unload());
  const info = await host.load();
  assert.equal(info.backend, 'blackice');
  assert.equal(info.cpuKernel, 'simd');
  assert.equal(host.status().cpuKernel, 'simd');
  assert.deepEqual(info.sourcePrecision, ['F32']);
  assert.equal(host.status().runningInWorker, true);
  const pieces = [], ids = [];
  const result = await host.generate({
    messages: [{ role: 'user', content: 'ab' }],
    maxNewTokens: 3, onText: text => pieces.push(text), onToken: id => ids.push(id),
  });
  assert.equal(result.backend, 'blackice');
  assert.equal(result.completed, true);
  assert.equal(result.text, 'aaa');
  assert.deepEqual(result.tokenIds, [0, 0, 0]);
  assert.deepEqual(ids, [0, 0, 0]);
  assert.deepEqual(pieces, ['a', 'a', 'a']);
  assert.equal(result.promptTokens > 4, true);
  assert.equal(host.status().busy, false);
});

test('explicit JavaScript reference kernel remains selectable and produces the same output', async t => {
  const modelDirectory = await fixture(t), host = new Qwen3WorkerHost({ modelDirectory, maxContext: 64, cpuKernel: 'reference' });
  t.after(() => host.unload());
  const info = await host.load();
  assert.equal(info.cpuKernel, 'reference');
  const result = await host.generate({ prompt: 'ab', maxNewTokens: 2 });
  assert.deepEqual(result.tokenIds, [0, 0]);
  assert.equal(result.text, 'aa');
  assert.throws(() => new Qwen3WorkerHost({ modelDirectory, cpuKernel: 'quantized' }), /SIMD or reference/);
});

test('worker isolates CPU work from the parent event loop', async t => {
  const modelDirectory = await fixture(t), host = new Qwen3WorkerHost({ modelDirectory, maxContext: 64 });
  t.after(() => host.unload());
  await host.load();
  let nextTickRan = false;
  const running = host.generate({ messages: [{ role: 'user', content: 'a' }], maxNewTokens: 7 });
  await new Promise(resolve => setImmediate(() => { nextTickRan = true; resolve(); }));
  assert.equal(nextTickRan, true);
  assert.equal((await running).text, 'aaaaaaa');
});

test('shared-memory cancellation interrupts worker inference and prevents a successful result', async t => {
  const modelDirectory = await fixture(t), host = new Qwen3WorkerHost({ modelDirectory, maxContext: 64 });
  t.after(() => host.unload());
  await host.load();
  const running = host.generate({ messages: [{ role: 'user', content: 'ab' }], maxNewTokens: 30 });
  for (let i = 0; i < 100 && !host.active; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.cancel(), true);
  await assert.rejects(running, error => error.code === 'ABORT_ERR');
  assert.equal(host.status().busy, false);
  const newResult = await host.generate({ messages: [{ role: 'user', content: 'ab' }], maxNewTokens: 1 });
  assert.deepEqual(newResult.tokenIds, [0], 'cancellation must not poison the next run');
});

test('unload terminates the worker and rejects further model use', async t => {
  const modelDirectory = await fixture(t), host = new Qwen3WorkerHost({ modelDirectory, maxContext: 64 });
  await host.load();
  await host.unload();
  assert.equal(host.status().runningInWorker, false);
  await assert.rejects(() => host.generate({ messages: [{ role: 'user', content: 'a' }] }), /already closed/);
});

test('invalid model directory reports a load failure without replacing the engine', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blackice-worker-missing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const host = new Qwen3WorkerHost({ modelDirectory: directory });
  t.after(() => host.unload());
  await assert.rejects(() => host.load());
  assert.equal(host.status().runningInWorker, false);
});
