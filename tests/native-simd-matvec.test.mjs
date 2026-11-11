import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { matvec } from '../lib/native-inference/reference-qwen3.mjs';
import { NativeSimdMatvec } from '../lib/native-inference/simd-matvec.mjs';

const sample = (rows, cols) => {
  const weights = Float32Array.from({ length: rows * cols }, (_, i) =>
    Math.sin(i * 0.019) * 0.25 + Math.cos(i * 0.002) * 0.125);
  const input = Float32Array.from({ length: cols }, (_, i) =>
    Math.sin(i * 0.011) - Math.cos(i * 0.03) / 2);
  return { weights, input };
};
const match = (expected, actual, maxAbs = 0.0002, maxRel = 0.0002) => {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) {
    const diff = Math.abs(actual[i] - expected[i]);
    assert.ok(diff <= maxAbs + Math.abs(expected[i]) * maxRel,
      'SIMD mismatch at ' + i + ': reference=' + expected[i] + ' actual=' + actual[i] + ' diff=' + diff);
  }
};

test('BLACKICE-authored SIMD WebAssembly has an explicit 128-bit matvec ABI', async () => {
  const kernel = await NativeSimdMatvec.create();
  const data = sample(7, 5);
  match(matvec(data.weights, 7, 5, data.input), kernel.matvec(data.weights, 7, 5, data.input));
  assert.equal(kernel.snapshot().implementation, 'blackice-owned-wasm-simd128');
  assert.equal(kernel.snapshot().calls, 1);
});

test('SIMD matvec matches the independent JavaScript reference for transformer matrices', async () => {
  const kernel = await NativeSimdMatvec.create({ tileBytes: 1 << 20 });
  for (const [rows, cols] of [[1, 1], [8, 16], [32, 64], [64, 128],
    [1024, 1024], [3072, 1024], [1024, 3072]]) {
    const { weights, input } = sample(rows, cols);
    const expected = matvec(weights, rows, cols, input);
    match(expected, kernel.matvec(weights, rows, cols, input), 0.0006, 0.0003);
  }
  assert.equal(kernel.snapshot().calls, 7);
});

test('SIMD uses bounded scratch tiles and handles matrices larger than the scratch buffer', async () => {
  const kernel = await NativeSimdMatvec.create({ tileBytes: 65536 });
  const { weights, input } = sample(130, 1024);
  const actual = kernel.matvec(weights, 130, 1024, input);
  match(matvec(weights, 130, 1024, input), actual, 0.0008, 0.0003);
  assert.equal(kernel.snapshot().tiles > 1, true);
  assert.equal(kernel.snapshot().scratchMemoryBytes <= 4 * 1024 * 1024, true);
  assert.equal(kernel.snapshot().copiedWeightBytes, weights.byteLength);
});

test('SIMD backend rejects malformed dimensions and truncated tensors', async () => {
  const kernel = await NativeSimdMatvec.create({ tileBytes: 65536 });
  const input = new Float32Array([1, 2]), weights = new Float32Array([3, 4]);
  assert.throws(() => kernel.matvec(weights, 2, 2, input), /dimensions/);
  assert.throws(() => kernel.matvec(weights, 1, 2, new Float32Array([1])), /dimensions/);
  assert.throws(() => kernel.matvec(weights, 1, 0, input), /dimensions/);
  assert.throws(() => kernel.matvec(Float32Array.from([1]), 1, 20000,
    new Float32Array(20000)), /scratch tile|dimensions/);
  await assert.rejects(() => NativeSimdMatvec.create({ wasmUrl: new URL('file:///not-a-file.wasm') }), /not found/);
});

test('bundled SIMD binary exactly matches its BLACKICE source and pinned build manifest', async () => {
  const manifestBytes = await readFile(new URL('../lib/native-inference/kernels/matvec-simd.manifest.json', import.meta.url), 'utf8');
  const manifest = JSON.parse(manifestBytes.replace(/^\uFEFF/, ''));
  const wasm = await readFile(new URL('../lib/native-inference/kernels/matvec-simd.wasm', import.meta.url));
  const source = await readFile(new URL('../scripts/native-kernels/matvec-simd.c', import.meta.url));
  const sha = value => createHash('sha256').update(value).digest('hex');
  assert.equal(manifest.format, 'blackice-owned-simd-v1');
  assert.equal(manifest.quantization, 'none');
  assert.equal(manifest.compiler, 'zig 0.15.2');
  assert.equal(manifest.sourceSha256, sha(source));
  assert.equal(manifest.wasmSha256, sha(wasm));
  assert.equal(WebAssembly.validate(wasm), true);
});
