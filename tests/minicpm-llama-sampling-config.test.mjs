import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_LLAMA_CPP_SETTINGS, validateLlamaCppSettings, buildLlamaCppLaunch } from '../lib/llama-cpp-launch-config.mjs';
import { LlamaCppSettingsStore } from '../lib/llama-cpp-settings.mjs';

const settings = overrides => validateLlamaCppSettings({
  ...DEFAULT_LLAMA_CPP_SETTINGS, modelsDirectory: 'C:\\Models', modelOverrides: overrides,
});
const sample = { seed: 1234, temperature: 0.8, topK: 40, topP: 0.95, minP: 0.05 };

test('omitted model sampling keeps existing runtime defaults unspecified', () => {
  const result = buildLlamaCppLaunch(settings({ original: { ctxSize: 262144 } }));
  assert.doesNotMatch(result.preset, /^(seed|temp|top-k|top-p|min-p) =/m);
  assert.deepEqual(result.effective.modelOverrides.original, { ctxSize: 262144 });
  for (const key of Object.keys(sample)) assert.equal(Object.hasOwn(result.effective, key), false);
});

test('per-model sampling is serialized in its selected model section', () => {
  const input = settings({ original: { ctxSize: 262144, ...sample }, other: { ctxSize: 8192 } });
  const launch = buildLlamaCppLaunch(input), sections = launch.preset.split('[original]\n');
  assert.doesNotMatch(sections[0], /^(seed|temp|top-k|top-p|min-p) =/m);
  assert.equal(sections[1], 'c = 262144\nseed = 1234\ntemp = 0.8\ntop-k = 40\ntop-p = 0.95\nmin-p = 0.05\n[other]\nc = 8192\n');
  assert.doesNotMatch(launch.args.join(' '), /seed|temp|top-k|top-p|min-p/);
  assert.deepEqual(validateLlamaCppSettings(JSON.parse(JSON.stringify(input))), input);
});

test('zero seed, greedy temperature, and disabled sampling filters are retained', () => {
  const options = { seed: 0, temperature: 0, topK: 0, topP: 1, minP: 0 };
  const launch = buildLlamaCppLaunch(settings({ original: options }));
  assert.deepEqual(launch.effective.modelOverrides.original, options);
  assert.match(launch.preset, /\[original\]\nseed = 0\ntemp = 0\ntop-k = 0\ntop-p = 1\nmin-p = 0\n$/);
  for (const seed of [-1, 4294967295]) assert.equal(settings({ original: { seed } }).modelOverrides.original.seed, seed);
});

test('invalid sampler inputs are rejected without numeric coercion', () => {
  const invalid = [
    ['seed', -2], ['seed', 4294967296], ['seed', 1.5], ['seed', '1234'], ['seed', null],
    ['temperature', -0.1], ['temperature', NaN], ['temperature', Infinity], ['temperature', '0.8'],
    ['topK', -1], ['topK', 2147483648], ['topK', 1.5], ['topK', true],
    ['topP', -0.01], ['topP', 1.01], ['topP', null], ['topP', NaN],
    ['minP', -0.01], ['minP', 1.01], ['minP', Infinity], ['minP', '0.05'],
  ];
  for (const [key, value] of invalid) assert.throws(
    () => settings({ original: { [key]: value } }), { code: 'LOCAL_LLAMA_SETTINGS_INVALID' }, key);
  for (const key of Object.keys(sample)) assert.throws(
    () => validateLlamaCppSettings({ ...DEFAULT_LLAMA_CPP_SETTINGS, modelsDirectory: 'C:\\Models', [key]: sample[key] }),
    { code: 'LOCAL_LLAMA_SETTINGS_INVALID' }, 'Sampling is per-model: ' + key);
});

test('samplers coexist with compute and projector options without changing another model', () => {
  const original = { threads: 6, threadsBatch: 6, batchSize: 2048, ubatchSize: 512,
    cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', mmprojPath: 'C:\\Models\\projector.gguf', mmprojOffload: false, ...sample };
  const other = { gpuLayers: 0, ctxSize: 4096 };
  const launch = buildLlamaCppLaunch(settings({ original, other }));
  assert.deepEqual(launch.effective.modelOverrides.original, original);
  assert.deepEqual(launch.effective.modelOverrides.other, other);
  assert.match(launch.preset, /mmproj-offload = off\nseed = 1234/);
  assert.match(launch.preset, /\[other\]\nc = 4096\nn-gpu-layers = 0\n$/);
});

test('revisioned settings retain exact per-model samplers across save and reload', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minicpm-sampler-settings-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = await new LlamaCppSettingsStore({ dataDir }).init();
  const configured = settings({ original: sample, edited: sample });
  const saved = await store.update({ expectedRevision: 0, settings: configured });
  assert.equal(saved.revision, 1);
  const reloaded = await new LlamaCppSettingsStore({ dataDir }).init();
  assert.deepEqual(reloaded.snapshot().settings, configured);
});
