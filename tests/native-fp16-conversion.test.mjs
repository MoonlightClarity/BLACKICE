import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { SafetensorsFile } from '../lib/native-inference/safetensors.mjs';
import { float32ToFloat16Bits, convertSafetensorsToFP16 } from '../lib/native-inference/convert-fp16.mjs';
import { convertNativeModelDirectory } from '../scripts/convert-native-model-fp16.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blackice-fp16-conversion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function original(dtype, values) {
  const data = Buffer.alloc(values.length * (dtype === 'F32' ? 4 : 2));
  for (let i = 0; i < values.length; i++) {
    if (dtype === 'F32') data.writeFloatLE(values[i], i * 4);
    else data.writeUInt16LE(values[i], i * 2);
  }
  const header = Buffer.from(JSON.stringify({
    __metadata__: { format: 'pt' },
    'model.weights': { dtype, shape: [values.length], data_offsets: [0, data.length] },
  }));
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([prefix, header, data]);
}

test('IEEE754 FP16 conversion rounds to nearest even and handles signed zero / NaN', () => {
  assert.equal(float32ToFloat16Bits(1), 0x3c00);
  assert.equal(float32ToFloat16Bits(-2), 0xc000);
  assert.equal(float32ToFloat16Bits(-0), 0x8000);
  assert.equal(float32ToFloat16Bits(2 ** -24), 0x0001);
  assert.equal(float32ToFloat16Bits(2 ** -25), 0x0000);
  assert.equal(float32ToFloat16Bits(1 + 1 / 2048), 0x3c00, 'tie rounds to even lower value');
  assert.equal(float32ToFloat16Bits(1 + 3 / 2048), 0x3c02, 'tie rounds to even upper value');
  assert.equal(float32ToFloat16Bits(65504), 0x7bff);
  assert.equal(float32ToFloat16Bits(70000), 0x7c00);
  assert.equal(float32ToFloat16Bits(Infinity), 0x7c00);
  assert.equal(float32ToFloat16Bits(-Infinity), 0xfc00);
  assert.equal(float32ToFloat16Bits(NaN) & 0x7e00, 0x7e00);
});

test('streaming conversion keeps original F32 file intact and creates real FP16 weights', async t => {
  const root = await fixture(t), input = path.join(root, 'source.safetensors'),
    output = path.join(root, 'fp16.safetensors');
  const source = original('F32', [1, -2, 0, 65504, 70000, 2 ** -24]);
  await writeFile(input, source);
  const hashBefore = createHash('sha256').update(source).digest('hex');
  const report = await convertSafetensorsToFP16({ sourceFile: input, outputFile: output, chunkElements: 2 });
  assert.deepEqual(report.sourceDtypes, ['F32']);
  assert.equal(report.quantizationRequested, false);
  assert.equal(report.overflowCount, 1);
  assert.equal(report.originalSha256, hashBefore);
  assert.equal((await stat(output)).size, report.outputBytes);
  assert.deepEqual(await readFile(input), source);
  const fp16 = await new SafetensorsFile(output).init();
  assert.equal(fp16.entries.get('model.weights').dtype, 'F16');
  const result = await fp16.tensor('model.weights');
  assert.deepEqual([...result.data], [1, -2, 0, 65504, Infinity, 2 ** -24]);
  assert.equal((await readFile(output)).subarray(fp16.dataStart).readUInt16LE(0), 0x3c00);
  await assert.rejects(() => convertSafetensorsToFP16({ sourceFile: input, outputFile: output }), /already exists/);
});

test('BF16 checkpoint converts to FP16 without quantization or changing source', async t => {
  const root = await fixture(t), input = path.join(root, 'bf16.safetensors'),
    output = path.join(root, 'fp16.safetensors');
  await writeFile(input, original('BF16', [0x3f80, 0xc000, 0x7f80]));
  const report = await convertSafetensorsToFP16({ sourceFile: input, outputFile: output, chunkElements: 1 });
  assert.deepEqual(report.sourceDtypes, ['BF16']);
  assert.deepEqual([...(await (await new SafetensorsFile(output).init()).tensor('model.weights')).data], [1, -2, Infinity]);
});

test('directory conversion preserves tokenizer/config, records hashes, and does not overwrite paths', async t => {
  const root = await fixture(t), source = path.join(root, 'source'), destination = path.join(root, 'output');
  await mkdir(source);
  await writeFile(path.join(source, 'model.safetensors'), original('F32', [1, 2]));
  await writeFile(path.join(source, 'config.json'), JSON.stringify({ model_type: 'qwen3' }));
  await writeFile(path.join(source, 'tokenizer.json'), '{"model":{"type":"BPE"}}');
  const result = await convertNativeModelDirectory({ sourceDirectory: source, outputDirectory: destination });
  assert.equal(result.dtype, 'F16');
  assert.equal(result.quantizationRequested, false);
  const config = JSON.parse(await readFile(path.join(destination, 'config.json'), 'utf8'));
  assert.equal(config.model_type, 'qwen3');
  assert.equal(config.torch_dtype, 'float16');
  assert.equal((await stat(path.join(destination, 'model.safetensors'))).isFile(), true);
  const manifest = JSON.parse(await readFile(path.join(destination, 'fp16-conversion.json'), 'utf8'));
  assert.equal(manifest.sha256, result.sha256);
  assert.equal(manifest.sourceDtypes[0], 'F32');
  await assert.rejects(() => convertNativeModelDirectory({ sourceDirectory: source, outputDirectory: destination }), /already exists/);
  await assert.rejects(() => convertNativeModelDirectory({ sourceDirectory: source, outputDirectory: source }), /separate directory/);
});

test('aborted conversion cannot publish a partial FP16 checkpoint', async t => {
  const root = await fixture(t), input = path.join(root, 'input.safetensors'),
    output = path.join(root, 'output.safetensors'), controller = new AbortController();
  await writeFile(input, original('F32', [1, 2, 3]));
  controller.abort();
  await assert.rejects(() => convertSafetensorsToFP16({ sourceFile: input, outputFile: output, signal: controller.signal }), /abort/i);
  await assert.rejects(() => stat(output), error => error.code === 'ENOENT');
});
