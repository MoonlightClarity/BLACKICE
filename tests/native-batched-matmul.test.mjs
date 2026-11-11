import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeBatchedMatmul, referenceBatchedMatmul } from '../lib/native-inference/batched-matmul.mjs';

const sample = (rows, cols, tokens) => ({
  weights: Float32Array.from({ length: rows * cols }, (_, i) =>
    Math.sin(i * 0.019) * 0.25 + Math.cos(i * 0.002) * 0.125),
  input: Float32Array.from({ length: cols * tokens }, (_, i) =>
    Math.sin(i * 0.011) - Math.cos(i * 0.03) / 2),
});
function matches(actual, expected, tolerance = 0.001) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) {
    const error = Math.abs(actual[i] - expected[i]);
    assert.ok(error < tolerance + Math.abs(expected[i]) * 0.0003,
      'Mismatch at ' + i + ': actual=' + actual[i] + ' expected=' + expected[i] + ' diff=' + error);
  }
}

test('BLACKICE batched SIMD projection matches independent scalar FP32 across irregular tokens', async () => {
  const kernel = await NativeBatchedMatmul.create({ tileBytes: 1 << 20 });
  for (const [rows, cols, tokens] of [
    [1, 1, 1], [3, 7, 1], [3, 7, 2], [7, 15, 3], [8, 16, 4], [16, 31, 7],
    [17, 64, 16], [37, 33, 19], [21, 71, 31], [128, 96, 64], [257, 128, 96],
    [513, 768, 16], [1024, 1024, 32],
  ]) {
    const { weights, input } = sample(rows, cols, tokens);
    const expected = referenceBatchedMatmul(weights, rows, cols, input, tokens);
    matches(kernel.project(weights, rows, cols, input, tokens), expected);
  }
  assert.equal(kernel.snapshot().calls, 13);
  assert.equal(kernel.snapshot().implementation, 'blackice-owned-wasm-batched-simd128');
});

test('bounded projection tiles weights once per batch regardless of token count', async () => {
  const kernel = await NativeBatchedMatmul.create({ tileBytes: 1 << 20 });
  const rows = 4096, cols = 1024, tokens = 64;
  const { weights, input } = sample(rows, cols, tokens);
  const result = kernel.project(weights, rows, cols, input, tokens);
  assert.equal(result.length, rows * tokens);
  assert.equal(kernel.snapshot().weightCopiesBytes, weights.byteLength,
    'Weights should be copied only once per batch, not once per token.');
  assert.ok(kernel.snapshot().tiles > 1);
  assert.ok(kernel.snapshot().scratchBytes < 3 * 1024 * 1024);
  const referenceRow = referenceBatchedMatmul(
    weights.subarray(0, 3 * cols), 3, cols, input, tokens);
  for (let token = 0; token < tokens; token++) {
    for (let row = 0; row < 3; row++) {
      const difference = Math.abs(referenceRow[token * 3 + row] -
        result[token * rows + row]);
      assert.ok(difference < 0.001 + Math.abs(referenceRow[token * 3 + row]) * 0.0003);
    }
  }
});

test('invalid layouts and oversized input are rejected before SIMD dispatch', async () => {
  const kernel = await NativeBatchedMatmul.create({ tileBytes: 1 << 20 });
  assert.throws(() => kernel.project(new Float32Array(3), 2, 2,
    new Float32Array(2), 1), /dimensions/);
  assert.throws(() => kernel.project(new Float32Array(4), 2, 2,
    new Float32Array(2), 0), /dimensions/);
  assert.throws(() => kernel.project(new Float32Array(4), 2, 2,
    new Float32Array(2 * 513), 513), /dimensions/);
  assert.throws(() => kernel.project(new Float32Array(4), 2, 2,
    new Float32Array(2), 1, {
      signal: { throwIfAborted() { throw new Error('cancelled'); } },
    }), /cancelled/);
});
