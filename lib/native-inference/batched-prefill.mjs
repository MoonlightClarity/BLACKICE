import { rmsNorm, rotateRopeInPlace, groupedAttention } from './reference-qwen3.mjs';
import { referenceBatchedMatmul } from './batched-matmul.mjs';

const error = message => Object.assign(new Error(message), { code: 'BLACKICE_BATCHED_PREFILL' });
const required = (condition, message) => { if (!condition) throw error(message); };
const tensorView = (array, index, width) => array.subarray(index * width, (index + 1) * width);

/**
 * Prefill multiple Qwen3 tokens with matrix-matrix projections. Every block
 * loads model weights once per projection rather than once per token.
 * Attention remains causal and uses the same GQA/RoPE/RMSNorm as the original
 * model. A snapshot of the KV cache is only committed on full success.
 *
 * @param {Qwen3Reference} model Existing instance with config, .weight(),
 * .matvec(), .cache and .position.
 * @param {number[]} ids Ordered token IDs.
 * @param {object} options { projector, blockSize, signal }
 * @returns {Float32Array} The final token's full-vocabulary logits.
 */
export async function prefillQwen3(model, ids, {
  projector = { project: referenceBatchedMatmul }, blockSize = 64, signal,
} = {}) {
  const cfg = model?.config;
  required(cfg?.model_type === 'qwen3' && typeof model.weight === 'function' &&
    typeof model.matvec === 'function' && Array.isArray(model.cache),
  'A loaded BLACKICE Qwen3 reference model is required.');
  required(Array.isArray(ids) && ids.length >= 1 &&
    ids.every(id => Number.isSafeInteger(id) && id >= 0 && id < cfg.vocab_size),
  'Prefill requires at least one valid token ID.');
  required(Number.isSafeInteger(blockSize) && blockSize >= 1 && blockSize <= 128,
    'The bounded prefill block size must be from 1 to 128 tokens.');
  required(model.position + ids.length <= model.maxContext,
    'Prefill would exceed the current model context window.');
  required(projector && typeof projector.project === 'function',
    'A BLACKICE batched projection implementation is required.');
  const basePosition = model.position;
  const H = cfg.hidden_size, D = cfg.head_dim, Q = cfg.num_attention_heads,
    K = cfg.num_key_value_heads, intermediate = cfg.intermediate_size;
  const cache = model.cache.map(layer => ({ keys: [...layer.keys], values: [...layer.values] }));
  required(cache.length === cfg.num_hidden_layers,
    'The reference KV cache does not match the Qwen3 layer configuration.');
  const embedding = await model.weight('model.embed_tokens.weight', [cfg.vocab_size, H]);
  let lastHidden = null;
  for (let start = 0; start < ids.length; start += blockSize) {
    signal?.throwIfAborted();
    const tokens = Math.min(blockSize, ids.length - start);
    let states = new Float32Array(tokens * H);
    for (let token = 0; token < tokens; token++)
      states.set(embedding.subarray(ids[start + token] * H, (ids[start + token] + 1) * H), token * H);
    const project = (weights, rows, cols, values) =>
      projector.project(weights, rows, cols, values, tokens, { signal });

    for (let layer = 0; layer < cfg.num_hidden_layers; layer++) {
      signal?.throwIfAborted();
      const prefix = 'model.layers.' + layer + '.', attn = prefix + 'self_attn.';
      const inputScale = await model.weight(prefix + 'input_layernorm.weight', [H]);
      const normalized = new Float32Array(tokens * H);
      for (let token = 0; token < tokens; token++)
        normalized.set(rmsNorm(tensorView(states, token, H), inputScale, cfg.rms_norm_eps), token * H);
      const [qWeight, kWeight, vWeight] = await Promise.all([
        model.weight(attn + 'q_proj.weight', [Q * D, H]),
        model.weight(attn + 'k_proj.weight', [K * D, H]),
        model.weight(attn + 'v_proj.weight', [K * D, H]),
      ]);
      const query = project(qWeight, Q * D, H, normalized);
      const keys = project(kWeight, K * D, H, normalized);
      const values = project(vWeight, K * D, H, normalized);
      const [qScale, kScale] = await Promise.all([
        model.weight(attn + 'q_norm.weight', [D]),
        model.weight(attn + 'k_norm.weight', [D]),
      ]);
      const newKeys = [], newValues = [];
      for (let token = 0; token < tokens; token++) {
        const q = tensorView(query, token, Q * D);
        const k = tensorView(keys, token, K * D);
        const v = tensorView(values, token, K * D);
        for (let qhead = 0; qhead < Q; qhead++)
          q.set(rmsNorm(q.subarray(qhead * D, (qhead + 1) * D), qScale, cfg.rms_norm_eps), qhead * D);
        for (let khead = 0; khead < K; khead++)
          k.set(rmsNorm(k.subarray(khead * D, (khead + 1) * D), kScale, cfg.rms_norm_eps), khead * D);
        const position = basePosition + start + token;
        rotateRopeInPlace(q, Q, D, position, cfg.rope_theta);
        rotateRopeInPlace(k, K, D, position, cfg.rope_theta);
        newKeys.push(Float32Array.from(k));
        newValues.push(Float32Array.from(v));
      }
      const attended = new Float32Array(tokens * Q * D);
      const previous = cache[layer];
      for (let token = 0; token < tokens; token++) {
        signal?.throwIfAborted();
        const q = tensorView(query, token, Q * D);
        const result = groupedAttention(q,
          [...previous.keys, ...newKeys.slice(0, token + 1)],
          [...previous.values, ...newValues.slice(0, token + 1)], Q, K, D);
        attended.set(result, token * Q * D);
      }
      const outWeight = await model.weight(attn + 'o_proj.weight', [H, Q * D]);
      const attentionOut = project(outWeight, H, Q * D, attended);
      for (let i = 0; i < states.length; i++) states[i] += attentionOut[i];
      const postScale = await model.weight(prefix + 'post_attention_layernorm.weight', [H]);
      const postNorm = new Float32Array(tokens * H);
      for (let token = 0; token < tokens; token++)
        postNorm.set(rmsNorm(tensorView(states, token, H), postScale, cfg.rms_norm_eps), token * H);
      const gateWeight = await model.weight(prefix + 'mlp.gate_proj.weight', [intermediate, H]);
      const upWeight = await model.weight(prefix + 'mlp.up_proj.weight', [intermediate, H]);
      const gate = project(gateWeight, intermediate, H, postNorm);
      const up = project(upWeight, intermediate, H, postNorm);
      for (let i = 0; i < gate.length; i++)
        gate[i] = gate[i] / (1 + Math.exp(-gate[i])) * up[i];
      const downWeight = await model.weight(prefix + 'mlp.down_proj.weight', [H, intermediate]);
      const down = project(downWeight, H, intermediate, gate);
      for (let i = 0; i < states.length; i++) states[i] += down[i];
      previous.keys.push(...newKeys);
      previous.values.push(...newValues);
    }
    lastHidden = Float32Array.from(tensorView(states, tokens - 1, H));
  }
  signal?.throwIfAborted();
  const scale = await model.weight('model.norm.weight', [H]);
  const normalized = rmsNorm(lastHidden, scale, cfg.rms_norm_eps);
  const headWeights = cfg.tie_word_embeddings ? embedding :
    await model.weight('lm_head.weight', [cfg.vocab_size, H]);
  const logits = model.matvec(headWeights, cfg.vocab_size, H, normalized);
  signal?.throwIfAborted();
  model.cache = cache;
  model.position = basePosition + ids.length;
  return logits;
}
