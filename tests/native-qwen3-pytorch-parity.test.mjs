import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { verifyQwen3Parity } from '../scripts/verify-native-qwen3-parity.mjs';

const model = process.env.BLACKICE_QWEN3_ABLITERATED_FP16_DIR;
const oracle = process.env.BLACKICE_PYTORCH_PARITY_DIR;

test('real Shadowdancer FP16 logits and 28 layers of KV state match PyTorch (SIMD)',
  { skip: !model || !oracle ||
    !existsSync(path.join(model, 'model.safetensors')) ||
    !existsSync(path.join(oracle, 'manifest.json')) },
  async () => {
    const result = await verifyQwen3Parity({
      modelDirectory: model, oracleDirectory: oracle,
      cpuKernel: 'simd',
    });
    assert.equal(result.passed, true);
    assert.deepEqual(result.input.tokenIds, [9707, 1879]);
    assert.deepEqual(result.steps.map(item => item.logits.referenceArgmax), [21806, 0]);
    assert.deepEqual(result.steps.map(item => item.logits.blackiceArgmax), [21806, 0]);
    for (const step of result.steps) {
      assert.ok(step.logits.rms < 0.0001);
      assert.ok(step.maxCacheRms < 0.0001);
      assert.equal(step.cacheByLayer.length, 56);
    }
    assert.equal(result.cpuKernelMetrics.implementation, 'blackice-owned-wasm-simd128');
  });

test('real Shadowdancer FP16 logits and KV state match PyTorch (JavaScript reference)',
  { skip: !model || !oracle ||
    !existsSync(path.join(model, 'model.safetensors')) ||
    !existsSync(path.join(oracle, 'manifest.json')) },
  async () => {
    const result = await verifyQwen3Parity({
      modelDirectory: model, oracleDirectory: oracle,
      cpuKernel: 'reference',
    });
    assert.equal(result.passed, true);
    for (const step of result.steps) {
      assert.ok(step.logits.rms < 0.0001);
      assert.ok(step.maxCacheRms < 0.0001);
    }
  });
