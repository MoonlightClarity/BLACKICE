#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSafetensorsModel } from '../lib/native-inference/safetensors.mjs';
import { Qwen3Reference } from '../lib/native-inference/reference-qwen3.mjs';
import { Qwen3Tokenizer } from '../lib/native-inference/qwen3-tokenizer.mjs';
import { NativeSimdMatvec } from '../lib/native-inference/simd-matvec.mjs';

const invariant = (condition, reason) => { if (!condition) throw new Error(reason); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function sha256File(file) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}
const metric = (expectedBytes, actual, label, topCount = 0) => {
  invariant(expectedBytes.length === actual.length * 4, label + ' vector length mismatch.');
  const data = new DataView(expectedBytes.buffer, expectedBytes.byteOffset, expectedBytes.byteLength);
  let abs = 0, square = 0, max = 0, maxIndex = 0, rel = 0, maxRel = 0;
  const discrepancies = [];
  for (let i = 0; i < actual.length; i++) {
    const expected = data.getFloat32(i * 4, true), received = actual[i];
    invariant(Number.isFinite(expected) && Number.isFinite(received), label + ': nonfinite floating value at ' + i);
    const diff = Math.abs(expected - received), relative = diff / Math.max(1, Math.abs(expected));
    abs += diff; square += diff * diff; rel += relative;
    if (diff > max) { max = diff; maxIndex = i; }
    maxRel = Math.max(maxRel, relative);
    if (topCount > 0) discrepancies.push({ index: i, expected, actual: received, difference: diff });
  }
  const indices = topCount ? discrepancies.sort((a, b) => b.expected - a.expected).slice(0, topCount) : [];
  let expectedArgmax = 0, actualArgmax = 0;
  if (topCount > 0) {
    for (let i = 1; i < actual.length; i++) {
      if (data.getFloat32(i * 4, true) > data.getFloat32(expectedArgmax * 4, true)) expectedArgmax = i;
      if (actual[i] > actual[actualArgmax]) actualArgmax = i;
    }
  }
  return {
    n: actual.length,
    meanAbsolute: abs / actual.length,
    rms: Math.sqrt(square / actual.length),
    maxAbsolute: max,
    maxIndex,
    maxRelativeAboveOne: maxRel,
    meanRelativeAboveOne: rel / actual.length,
    ...(topCount ? {
      referenceArgmax: expectedArgmax,
      blackiceArgmax: actualArgmax,
      argmaxMatches: expectedArgmax === actualArgmax,
      referenceTop: indices,
    } : {}),
  };
};
const filename = (layer, kind, position) => 'cache-layer-' + layer + '-' + kind + '-' + position + '.f32';

export async function verifyQwen3Parity({ modelDirectory, oracleDirectory, outputFile, maxContext = 64, cpuKernel = 'reference',
  tolerances = { logitsRms: 0.0001, logitsMax: 0.001, cacheRms: 0.0001, cacheMax: 0.001 } } = {}) {
  const manifest = JSON.parse(await readFile(path.join(oracleDirectory, 'manifest.json'), 'utf8'));
  invariant(typeof manifest.modelSha256 === 'string' &&
    await sha256File(path.join(modelDirectory, 'model.safetensors')) === manifest.modelSha256,
    'Model SHA-256 mismatch: BLACKICE and PyTorch must compare the exact same FP16 checkpoint.');
  invariant(manifest.reference === 'Hugging Face Transformers/PyTorch',
    'Expected a trusted PyTorch Transformers reference manifest.');
  const tokenizer = await Qwen3Tokenizer.load(modelDirectory);
  const tokenIds = tokenizer.encode(manifest.prompt);
  invariant(JSON.stringify(tokenIds) === JSON.stringify(manifest.inputIds),
    'Tokenizer mismatch: BLACKICE token IDs do not match the trusted tokenizer.');
  const source = await openSafetensorsModel(modelDirectory);
  invariant(source.sourcePrecision.includes('F16'), 'Reference comparison must use original FP16 input.');
  if (!['reference', 'simd'].includes(cpuKernel)) throw new Error('Choose reference or simd CPU kernel.');
  const simd = cpuKernel === 'simd' ? await NativeSimdMatvec.create() : null;
  const model = new Qwen3Reference({ config: source.config, tensors: source, maxContext,
    ...(simd ? { matvecImpl: simd.matvec.bind(simd) } : {}) });
  const reports = [];
  const started = performance.now();
  try {
    for (let pos = 0; pos < tokenIds.length; pos++) {
      const before = performance.now();
      const logits = await model.step(tokenIds[pos]);
      const expectedInfo = manifest.logits[pos];
      const expected = await readFile(path.join(oracleDirectory, expectedInfo.filename));
      invariant(sha256(expected) === expectedInfo.sha256, 'PyTorch logits were changed after generation.');
      const comparison = metric(expected, logits, 'logits-' + pos, 10);
      const cache = [];
      for (let layer = 0; layer < model.cache.length; layer++) {
        for (const kind of ['key', 'value']) {
          const entry = manifest.cache.find(item => item.position === pos && item.layer === layer && item.kind === kind);
          invariant(entry, 'Trusted reference is missing KV cache for layer ' + layer + ' token ' + pos);
          const bytes = await readFile(path.join(oracleDirectory, filename(layer, kind, pos)));
          invariant(sha256(bytes) === entry.sha256, 'Trusted KV-cache file has changed.');
          const actual = model.cache[layer][kind === 'key' ? 'keys' : 'values'][pos];
          cache.push({ layer, kind, ...metric(bytes, actual, filename(layer, kind, pos)) });
        }
      }
      const maxCacheRms = Math.max(...cache.map(item => item.rms));
      const maxCacheAbs = Math.max(...cache.map(item => item.maxAbsolute));
      reports.push({
        position: pos, inputId: tokenIds[pos], elapsedMs: Math.round(performance.now() - before),
        logits: comparison, maxCacheRms, maxCacheAbs,
        cacheByLayer: cache,
      });
    }
    const passed = reports.every(item => item.logits.rms <= tolerances.logitsRms &&
      item.logits.maxAbsolute <= tolerances.logitsMax && item.logits.argmaxMatches &&
      item.maxCacheRms <= tolerances.cacheRms && item.maxCacheAbs <= tolerances.cacheMax);
    const report = {
      format: 'BLACKICE-Qwen3-fp16-pytorch-parity-v1',
      cpuKernel,
      ...(simd ? { cpuKernelMetrics: simd.snapshot() } : {}),
      reference: { framework: manifest.reference, torchVersion: manifest.torchVersion,
        transformersVersion: manifest.transformersVersion, computeDtype: manifest.computeDtype },
      input: { prompt: manifest.prompt, tokenIds, precision: source.sourcePrecision },
      tolerances, passed,
      elapsedMs: Math.round(performance.now() - started),
      steps: reports,
    };
    if (outputFile) await writeFile(outputFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
    return report;
  } finally { source.release(); }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const flags = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (i % 2 === 0) pairs.push([arg, all[i + 1]]);
    return pairs;
  }, []));
  const modelDirectory = flags['--model'], oracleDirectory = flags['--oracle'];
  if (!modelDirectory || !oracleDirectory) {
    console.error('Usage: node scripts/verify-native-qwen3-parity.mjs --model ABSOLUTE_MODEL --oracle PYTORCH_REFERENCE --output RESULTS_JSON');
    process.exitCode = 2;
  } else {
    try {
      const result = await verifyQwen3Parity({ modelDirectory, oracleDirectory,
        outputFile: flags['--output'], cpuKernel: flags['--kernel'] || 'reference' });
      console.log(JSON.stringify({
        reference: result.reference,
        passed: result.passed,
        cpuKernel: result.cpuKernel,
        ...(result.cpuKernelMetrics ? { cpuKernelMetrics: result.cpuKernelMetrics } : {}),
        elapsedMs: result.elapsedMs,
        steps: result.steps.map(({ position, inputId, elapsedMs, logits, maxCacheRms, maxCacheAbs }) => ({
          position, inputId, elapsedMs, logits: {
            meanAbsolute: logits.meanAbsolute, rms: logits.rms, maxAbsolute: logits.maxAbsolute,
            referenceArgmax: logits.referenceArgmax, blackiceArgmax: logits.blackiceArgmax,
            argmaxMatches: logits.argmaxMatches,
          }, maxCacheRms, maxCacheAbs,
        })),
      }, null, 2));
      if (!result.passed) process.exitCode = 1;
    } catch (error) {
      console.error('Parity verification failed: ' + String(error?.stack || error));
      process.exitCode = 1;
    }
  }
}
