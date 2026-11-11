/** Self-authored Qwen3 CPU reference. No llama.cpp or external inference calls.
 * Numerical reference only: slow, token-ID interface, not yet a production chat backend.
 */
const invalid = message => Object.assign(new Error(message), { code: 'BLACKICE_REFERENCE_INFERENCE' });
const needed = (condition, message) => { if (!condition) throw invalid(message); };
const expectedArray = (tensor, shape, label) => {
  needed(tensor && tensor.data instanceof Float32Array &&
    Array.isArray(tensor.shape) && tensor.shape.length === shape.length &&
    shape.every((value, i) => tensor.shape[i] === value),
    'Incorrect tensor shape or dtype: ' + label);
  return tensor.data;
};

export function matvec(weight, rows, cols, input) {
  needed(input.length === cols && weight.length === rows * cols, 'Matrix dimensions do not match.');
  const result = new Float32Array(rows);
  for (let i = 0; i < rows; i++) {
    let sum = 0;
    const offset = i * cols;
    for (let j = 0; j < cols; j++) sum += weight[offset + j] * input[j];
    result[i] = sum;
  }
  return result;
}

export function rmsNorm(vector, scale, epsilon) {
  needed(vector.length === scale.length && Number.isFinite(epsilon) && epsilon > 0,
    'RMSNorm dimensions or epsilon are invalid.');
  let variance = 0;
  for (const number of vector) variance += number * number;
  const invRms = 1 / Math.sqrt(variance / vector.length + epsilon);
  return Float32Array.from(vector, (v, i) => v * invRms * scale[i]);
}

/** Hugging Face Qwen3 rotate_half convention: x[firstHalf], x[secondHalf]. */
export function rotateRopeInPlace(vector, heads, headDim, position, theta) {
  needed(headDim > 0 && headDim % 2 === 0 && vector.length === heads * headDim &&
    Number.isSafeInteger(position) && position >= 0 && Number.isFinite(theta) && theta > 0,
    'RoPE shape or position is invalid.');
  const half = headDim / 2;
  for (let pair = 0; pair < half; pair++) {
    const angle = position / theta ** (2 * pair / headDim);
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    for (let head = 0; head < heads; head++) {
      const a = head * headDim + pair, b = a + half;
      const x = vector[a], y = vector[b];
      vector[a] = x * cosine - y * sine;
      vector[b] = y * cosine + x * sine;
    }
  }
}

function normalizedHeads(values, heads, headDim, normScale, epsilon) {
  for (let h = 0; h < heads; h++) {
    const head = rmsNorm(values.subarray(h * headDim, (h + 1) * headDim), normScale, epsilon);
    values.set(head, h * headDim);
  }
}

/** GQA: one KV head is shared by (queryHeads / kvHeads) query heads. */
export function groupedAttention(query, pastKeys, pastValues, queryHeads, kvHeads, headDim) {
  needed(queryHeads > 0 && kvHeads > 0 && Number.isInteger(queryHeads / kvHeads) &&
    query.length === queryHeads * headDim && pastKeys.length === pastValues.length && pastKeys.length > 0,
    'Grouped attention dimensions are invalid.');
  const out = new Float32Array(query.length), group = queryHeads / kvHeads;
  const scale = 1 / Math.sqrt(headDim);
  for (let head = 0; head < queryHeads; head++) {
    const kv = Math.floor(head / group), qOffset = head * headDim, kOffset = kv * headDim;
    let max = -Infinity;
    const scores = new Float64Array(pastKeys.length);
    for (let t = 0; t < pastKeys.length; t++) {
      needed(pastKeys[t].length === kvHeads * headDim && pastValues[t].length === kvHeads * headDim,
        'Cached key/value dimensions differ from the model.');
      let sum = 0;
      for (let d = 0; d < headDim; d++) sum += query[qOffset + d] * pastKeys[t][kOffset + d];
      scores[t] = sum * scale;
      if (scores[t] > max) max = scores[t];
    }
    let denominator = 0;
    for (let t = 0; t < scores.length; t++) {
      scores[t] = Math.exp(scores[t] - max);
      denominator += scores[t];
    }
    needed(Number.isFinite(denominator) && denominator > 0, 'Attention softmax is not finite.');
    for (let t = 0; t < scores.length; t++) {
      const factor = scores[t] / denominator;
      for (let d = 0; d < headDim; d++) out[qOffset + d] += factor * pastValues[t][kOffset + d];
    }
  }
  return out;
}

export function validateQwen3Config(config) {
  needed(config?.model_type === 'qwen3', 'Only Qwen3 architecture is supported by this reference engine.');
  for (const key of ['hidden_size', 'num_hidden_layers', 'num_attention_heads', 'num_key_value_heads',
    'head_dim', 'intermediate_size', 'vocab_size', 'max_position_embeddings']) {
    needed(Number.isSafeInteger(config[key]) && config[key] > 0, 'Invalid Qwen3 configuration: ' + key);
  }
  needed(config.num_attention_heads % config.num_key_value_heads === 0 && config.head_dim % 2 === 0,
    'Qwen3 query-to-KV ratio and head dimensions must be valid.');
  needed(Number.isFinite(config.rms_norm_eps) && config.rms_norm_eps > 0 &&
    Number.isFinite(config.rope_theta) && config.rope_theta > 0 &&
    (config.rope_scaling === undefined || config.rope_scaling === null),
    'This Qwen3 reference backend does not support alternate RoPE scaling.');
  needed(config.tie_word_embeddings === true || config.tie_word_embeddings === false,
    'Qwen3 tied-embedding setting is required.');
  return config;
}

/** For comparison and unit tests, not a high-throughput inference engine. */
export class Qwen3Reference {
  constructor({ config, tensors, maxContext = 2048 } = {}) {
    this.config = validateQwen3Config(config);
    needed(tensors && typeof tensors.tensor === 'function', 'A Safetensors model reader is required.');
    needed(Number.isSafeInteger(maxContext) && maxContext >= 1, 'Maximum context must be positive.');
    this.tensors = tensors;
    this.maxContext = Math.min(maxContext, config.max_position_embeddings);
    this.reset();
  }
  reset() {
    this.position = 0;
    this.cache = Array.from({ length: this.config.num_hidden_layers }, () => ({ keys: [], values: [] }));
  }
  async weight(name, shape) {
    return expectedArray(await this.tensors.tensor(name), shape, name);
  }
  async step(id, { signal } = {}) {
    const cfg = this.config, hidden = cfg.hidden_size, head = cfg.head_dim,
      nQ = cfg.num_attention_heads, nKV = cfg.num_key_value_heads, intermediate = cfg.intermediate_size;
    needed(Number.isInteger(id) && id >= 0 && id < cfg.vocab_size, 'Token ID is outside the model vocabulary.');
    needed(this.position < this.maxContext, 'Maximum reference context reached: reset or reduce input length.');
    signal?.throwIfAborted();
    const embedding = await this.weight('model.embed_tokens.weight', [cfg.vocab_size, hidden]);
    let x = Float32Array.from(embedding.subarray(id * hidden, (id + 1) * hidden));
    const pending = [];
    const position = this.position;
    for (let layer = 0; layer < cfg.num_hidden_layers; layer++) {
      signal?.throwIfAborted();
      const root = 'model.layers.' + layer + '.', attn = root + 'self_attn.';
      const inputNorm = await this.weight(root + 'input_layernorm.weight', [hidden]);
      const norm = rmsNorm(x, inputNorm, cfg.rms_norm_eps);
      const [qWeights, kWeights, vWeights] = await Promise.all([
        this.weight(attn + 'q_proj.weight', [nQ * head, hidden]),
        this.weight(attn + 'k_proj.weight', [nKV * head, hidden]),
        this.weight(attn + 'v_proj.weight', [nKV * head, hidden]),
      ]);
      const q = matvec(qWeights, nQ * head, hidden, norm);
      const k = matvec(kWeights, nKV * head, hidden, norm);
      const v = matvec(vWeights, nKV * head, hidden, norm);
      normalizedHeads(q, nQ, head,
        await this.weight(attn + 'q_norm.weight', [head]), cfg.rms_norm_eps);
      normalizedHeads(k, nKV, head,
        await this.weight(attn + 'k_norm.weight', [head]), cfg.rms_norm_eps);
      rotateRopeInPlace(q, nQ, head, position, cfg.rope_theta);
      rotateRopeInPlace(k, nKV, head, position, cfg.rope_theta);
      // Read old KV cache and one candidate token; do not commit until all layers succeed.
      const old = this.cache[layer];
      const attended = groupedAttention(q, [...old.keys, k], [...old.values, v], nQ, nKV, head);
      const o = matvec(await this.weight(attn + 'o_proj.weight', [hidden, nQ * head]),
        hidden, nQ * head, attended);
      for (let j = 0; j < hidden; j++) x[j] += o[j];
      const postNorm = rmsNorm(x,
        await this.weight(root + 'post_attention_layernorm.weight', [hidden]), cfg.rms_norm_eps);
      const gate = matvec(await this.weight(root + 'mlp.gate_proj.weight', [intermediate, hidden]),
        intermediate, hidden, postNorm);
      const up = matvec(await this.weight(root + 'mlp.up_proj.weight', [intermediate, hidden]),
        intermediate, hidden, postNorm);
      for (let j = 0; j < intermediate; j++) gate[j] = gate[j] / (1 + Math.exp(-gate[j])) * up[j];
      const ff = matvec(await this.weight(root + 'mlp.down_proj.weight', [hidden, intermediate]),
        hidden, intermediate, gate);
      for (let j = 0; j < hidden; j++) x[j] += ff[j];
      pending.push({ key: k, value: v });
    }
    signal?.throwIfAborted();
    const normalized = rmsNorm(x, await this.weight('model.norm.weight', [hidden]), cfg.rms_norm_eps);
    const headWeights = cfg.tie_word_embeddings ? embedding : await this.weight('lm_head.weight', [cfg.vocab_size, hidden]);
    const logits = matvec(headWeights, cfg.vocab_size, hidden, normalized);
    signal?.throwIfAborted();
    for (let layer = 0; layer < this.cache.length; layer++) {
      this.cache[layer].keys.push(pending[layer].key);
      this.cache[layer].values.push(pending[layer].value);
    }
    this.position++;
    return logits;
  }
  async generateTokenIds(ids, { maxNewTokens = 16, signal, onToken } = {}) {
    needed(Array.isArray(ids) && ids.length > 0 && ids.every(Number.isInteger),
      'Provide at least one integer token ID.');
    needed(Number.isSafeInteger(maxNewTokens) && maxNewTokens >= 0 && maxNewTokens <= 2048,
      'Generation budget must be from 0 through 2048 tokens.');
    this.reset();
    let logits;
    for (const id of ids) logits = await this.step(id, { signal });
    const tokens = [];
    for (let i = 0; i < maxNewTokens; i++) {
      signal?.throwIfAborted();
      let chosen = 0;
      for (let j = 1; j < logits.length; j++) if (logits[j] > logits[chosen]) chosen = j;
      tokens.push(chosen);
      if (onToken) await onToken(chosen);
      if (chosen === this.config.eos_token_id) break;
      if (i !== maxNewTokens - 1) logits = await this.step(chosen, { signal });
    }
    return tokens;
  }
}
