import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFloatTensor, float16ToFloat32, bfloat16ToFloat32 } from '../lib/native-inference/precision.mjs';

test('all 65,536 FP16 patterns decode to the same IEEE754 float32 value as the scalar reference', () => {
  const bytes = Buffer.allocUnsafe(65536 * 2);
  for (let i = 0; i < 65536; i++) bytes.writeUInt16LE(i, i * 2);
  const decoded = decodeFloatTensor(bytes, 'F16');
  assert.equal(decoded.length, 65536);
  for (let i = 0; i < 65536; i++) {
    const expected = float16ToFloat32(i);
    if (Number.isNaN(expected)) assert.ok(Number.isNaN(decoded[i]), 'NaN at ' + i);
    else assert.ok(Object.is(decoded[i], expected), 'FP16 mismatch at ' + i);
  }
  assert.equal(Object.is(decoded[0x8000], -0), true);
});

test('all 65,536 BF16 patterns match their scalar conversion', () => {
  const bytes = Buffer.allocUnsafe(65536 * 2);
  for (let i = 0; i < 65536; i++) bytes.writeUInt16LE(i, i * 2);
  const decoded = decodeFloatTensor(bytes, 'BF16');
  for (let i = 0; i < 65536; i++) {
    const expected = bfloat16ToFloat32(i);
    if (Number.isNaN(expected)) assert.ok(Number.isNaN(decoded[i]), 'NaN at ' + i);
    else assert.ok(Object.is(decoded[i], expected), 'BF16 mismatch at ' + i);
  }
});

test('unaligned byte slices use the correct endian-safe decode without truncation', () => {
  const parent = Buffer.alloc(20);
  parent.writeUInt16LE(0x3c00, 1);
  parent.writeUInt16LE(0xc000, 3);
  parent.writeFloatLE(1.5, 1);
  parent.writeFloatLE(-2.5, 5);
  const f32 = decodeFloatTensor(parent.subarray(1, 9), 'F32');
  assert.deepEqual([...f32], [1.5, -2.5]);
  parent.writeUInt16LE(0x3c00, 1);
  parent.writeUInt16LE(0xc000, 3);
  assert.deepEqual([...decodeFloatTensor(parent.subarray(1, 5), 'F16')], [1, -2]);
});

test('F32 byte transfer preserves exact float32 and rejects truncated buffers', () => {
  const values = [0, -0, 1, -2, 3.5, Number.MIN_VALUE, 1e30];
  const bytes = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) bytes.writeFloatLE(values[i], i * 4);
  const result = decodeFloatTensor(bytes, 'F32');
  assert.deepEqual([...result], [...new Float32Array(values)]);
  assert.equal(Object.is(result[1], -0), true);
  assert.throws(() => decodeFloatTensor(Buffer.alloc(3), 'F32'), /match/);
  assert.throws(() => decodeFloatTensor(Buffer.alloc(4), 'Q4'), /F16, BF16 and F32/);
});
