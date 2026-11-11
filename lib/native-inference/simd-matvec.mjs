import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const invalid = message => Object.assign(new Error(message), { code: 'BLACKICE_WASM_SIMD' });
const round64 = value => Math.ceil(value / 64) * 64;
const PAGE_BYTES = 65536;

/** BLACKICE-authored SIMD matvec, compiled to a tiny portable Wasm binary.
 * All large weights remain Float32Array; tiles are copied into bounded
 * temporary Wasm memory. Neither GGUF nor quantization is involved.
 */
export class NativeSimdMatvec {
  static async create({ wasmUrl = new URL('./kernels/matvec-simd.wasm', import.meta.url),
    tileBytes = 32 * 1024 * 1024 } = {}) {
    if (!Number.isSafeInteger(tileBytes) || tileBytes < 65536 || tileBytes > 128 * 1024 * 1024)
      throw invalid('Choose a SIMD tile size between 64 KiB and 128 MiB.');
    let binary;
    try { binary = await readFile(wasmUrl); }
    catch (error) { throw invalid('Bundled BLACKICE SIMD kernel not found. Rebuild the native inference assets: ' + error.message); }
    if (!WebAssembly.validate(binary)) throw invalid('BLACKICE SIMD kernel is not supported by this runtime.');
    const { instance } = await WebAssembly.instantiate(binary, {});
    const memory = instance.exports.memory;
    const fn = instance.exports.matvec_f32;
    const globalBase = instance.exports.__heap_base;
    const rawBase = globalBase?.value ?? globalBase;
    if (!(memory instanceof WebAssembly.Memory) || typeof fn !== 'function' || !Number.isSafeInteger(rawBase))
      throw invalid('Bundled SIMD kernel exports an incompatible ABI.');
    return new NativeSimdMatvec({ memory, fn, heapBase: round64(rawBase), tileBytes });
  }

  constructor({ memory, fn, heapBase, tileBytes }) {
    this.memory = memory;
    this.fn = fn;
    this.heapBase = heapBase;
    this.tileBytes = tileBytes;
    this.stats = { calls: 0, tiles: 0, copiedWeightBytes: 0, elapsedMs: 0 };
  }

  matvec(weight, rows, cols, input) {
    if (!(weight instanceof Float32Array) || !(input instanceof Float32Array) ||
      !Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) ||
      rows < 1 || cols < 1 || rows * cols !== weight.length || input.length !== cols)
      throw invalid('SIMD matvec received invalid dimensions or tensor storage.');
    if (cols * 4 > this.tileBytes)
      throw invalid('SIMD matrix row exceeds the configured bounded scratch tile.');
    const started = performance.now();
    const tileRows = Math.max(1, Math.floor(this.tileBytes / (cols * 4)));
    const inputOffset = this.heapBase;
    const outputOffset = round64(inputOffset + cols * 4);
    const weightOffset = round64(outputOffset + Math.min(rows, tileRows) * 4);
    const output = new Float32Array(rows);
    for (let row = 0; row < rows; row += tileRows) {
      const count = Math.min(tileRows, rows - row);
      const weightLength = count * cols;
      const neededBytes = weightOffset + weightLength * 4;
      if (neededBytes > this.memory.buffer.byteLength) {
        const additional = Math.ceil((neededBytes - this.memory.buffer.byteLength) / PAGE_BYTES);
        try { this.memory.grow(additional); }
        catch (error) { throw invalid('Unable to allocate bounded SIMD scratch memory: ' + error.message); }
      }
      const array = this.memory.buffer;
      new Float32Array(array, inputOffset, cols).set(input);
      new Float32Array(array, weightOffset, weightLength).set(
        weight.subarray(row * cols, (row + count) * cols));
      this.fn(weightOffset, inputOffset, outputOffset, count, cols);
      output.set(new Float32Array(array, outputOffset, count), row);
      this.stats.tiles++;
    }
    this.stats.calls++;
    this.stats.copiedWeightBytes += weight.byteLength;
    this.stats.elapsedMs += performance.now() - started;
    return output;
  }

  snapshot() {
    return { implementation: 'blackice-owned-wasm-simd128', ...this.stats,
      scratchMemoryBytes: this.memory.buffer.byteLength };
  }
}
