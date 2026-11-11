import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const issue = message => Object.assign(new Error(message), { code: 'BLACKICE_BATCHED_SIMD' });
const align64 = n => Math.ceil(n / 64) * 64;
const pageBytes = 65536;

/** Scalar CPU oracle for token-major X[t,cols] and W[rows,cols]. */
export function referenceBatchedMatmul(weight, rows, cols, input, tokens) {
  if (!(weight instanceof Float32Array) || !(input instanceof Float32Array) ||
      !Number.isSafeInteger(rows) || rows < 1 || !Number.isSafeInteger(cols) || cols < 1 ||
      !Number.isSafeInteger(tokens) || tokens < 1 ||
      weight.length !== rows * cols || input.length !== tokens * cols)
    throw issue('Invalid batched projection dimensions.');
  const output = new Float32Array(tokens * rows);
  for (let row = 0; row < rows; row++) {
    for (let token = 0; token < tokens; token++) {
      let sum = 0;
      for (let col = 0; col < cols; col++)
        sum += weight[row * cols + col] * input[token * cols + col];
      output[token * rows + row] = sum;
    }
  }
  return output;
}

/** First-party WebAssembly SIMD batched transformer projection.
 * Encodes input temporarily as X[cols,tokens] so each weight scan produces
 * 16 token outputs. Chunked weight tiles bound scratch allocation.
 * The original F16/BF16 model file is never quantized or modified.
 */
export class NativeBatchedMatmul {
  static async create({ wasmUrl = new URL('./kernels/matmul-simd.wasm', import.meta.url),
    tileBytes = 32 * 1024 * 1024 } = {}) {
    if (!Number.isSafeInteger(tileBytes) || tileBytes < 1024 * 1024 || tileBytes > 128 * 1024 * 1024)
      throw issue('Choose a scratch budget between 1 MiB and 128 MiB.');
    let bytes;
    try { bytes = await readFile(wasmUrl); }
    catch (error) { throw issue('Compiled BLACKICE batched SIMD kernel is missing: ' + error.message); }
    if (!WebAssembly.validate(bytes)) throw issue('The runtime does not support this BLACKICE SIMD kernel.');
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const memory = instance.exports.memory;
    const fn = instance.exports.matmul_f32;
    const rawBase = instance.exports.__heap_base;
    const base = rawBase?.value ?? rawBase;
    if (!(memory instanceof WebAssembly.Memory) || typeof fn !== 'function' ||
        !Number.isSafeInteger(base)) throw issue('Compiled BLACKICE batched SIMD ABI mismatch.');
    return new NativeBatchedMatmul({ memory, fn, heapBase: align64(base), tileBytes });
  }

  constructor({ memory, fn, heapBase, tileBytes }) {
    this.memory = memory;
    this.fn = fn;
    this.heapBase = heapBase;
    this.tileBytes = tileBytes;
    this.stats = { calls: 0, tiles: 0, weightCopiesBytes: 0, elapsedMs: 0, tokenProjections: 0 };
  }

  project(weight, rows, cols, input, tokens, { signal } = {}) {
    if (!(weight instanceof Float32Array) || !(input instanceof Float32Array) ||
        !Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) ||
        !Number.isSafeInteger(tokens) || rows < 1 || cols < 1 || tokens < 1 || tokens > 512 ||
        weight.length !== rows * cols || input.length !== tokens * cols)
      throw issue('Invalid batched projection dimensions or token count.');
    signal?.throwIfAborted();
    const started = performance.now();
    const inputsSize = cols * tokens * 4;
    if (inputsSize + cols * 4 + tokens * 4 > this.tileBytes)
      throw issue('Batched projection inputs exceed bounded scratch memory. Lower the token block size.');
    const inputOffset = this.heapBase;
    const inputEnd = align64(inputOffset + inputsSize);
    const tokenRowBytes = tokens * 4;
    const rowBudget = Math.floor((this.tileBytes - (inputEnd - inputOffset)) / (cols * 4 + tokenRowBytes));
    const tileRows = Math.min(rows, Math.max(1, rowBudget));
    const outputOffset = inputEnd;
    const weightOffset = align64(outputOffset + tileRows * tokenRowBytes);
    const need = weightOffset + tileRows * cols * 4;
    if (need > 256 * 1024 * 1024) throw issue('Batched SIMD scratch limit exceeded.');
    if (need > this.memory.buffer.byteLength) {
      const pages = Math.ceil((need - this.memory.buffer.byteLength) / pageBytes);
      try { this.memory.grow(pages); }
      catch (error) { throw issue('Could not allocate the bounded batched SIMD scratch memory: ' + error.message); }
    }
    // Transpose once for a block of tokens. Input is shared across all row tiles.
    const inputColumnMajor = new Float32Array(this.memory.buffer, inputOffset, cols * tokens);
    for (let col = 0; col < cols; col++)
      for (let token = 0; token < tokens; token++)
        inputColumnMajor[col * tokens + token] = input[token * cols + col];
    const output = new Float32Array(tokens * rows);
    for (let row = 0; row < rows; row += tileRows) {
      signal?.throwIfAborted();
      const count = Math.min(rows - row, tileRows);
      new Float32Array(this.memory.buffer, weightOffset, count * cols).set(
        weight.subarray(row * cols, (row + count) * cols));
      this.fn(weightOffset, inputOffset, outputOffset, count, cols, tokens);
      const tile = new Float32Array(this.memory.buffer, outputOffset, count * tokens);
      for (let local = 0; local < count; local++)
        for (let token = 0; token < tokens; token++)
          output[token * rows + row + local] = tile[local * tokens + token];
      this.stats.tiles++;
      this.stats.weightCopiesBytes += count * cols * 4;
    }
    this.stats.calls++;
    this.stats.elapsedMs += performance.now() - started;
    this.stats.tokenProjections += tokens;
    return output;
  }

  snapshot() {
    return { implementation: 'blackice-owned-wasm-batched-simd128', ...this.stats,
      scratchBytes: this.memory.buffer.byteLength };
  }
}
