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

test('per-model reasoning modes reach only their own native INI sections', () => {
  for (const reasoning of ['on', 'off', 'auto']) {
    const original = { ctxSize: 262144, ...sample, reasoning };
    const other = { ctxSize: 4096 };
    const launch = buildLlamaCppLaunch(settings({ original, other }));
    const before = launch.preset.slice(0, launch.preset.indexOf('[original]\n'));
    const selected = launch.preset.split('[original]\n')[1].split('[other]\n')[0];
    const after = launch.preset.split('[other]\n')[1];
    assert.equal(selected.split('\n').filter(row => row === 'reasoning = ' + reasoning).length, 1);
    assert.doesNotMatch(before + after, /^reasoning =/m);
    assert.doesNotMatch(launch.args.join(' '), /reasoning|predict|max-tokens/);
    assert.match(launch.preset, /^\[\*\]\nfit = on$/m);
    assert.deepEqual(launch.effective.modelOverrides, { original, other });
    assert.equal(launch.effective.modelOverrides.original.ctxSize, 262144);
  }
});

test('reasoning omission preserves native defaults and rejects global or invalid values', () => {
  const omitted = buildLlamaCppLaunch(settings({ original: { ...sample } }));
  assert.doesNotMatch(omitted.preset, /^reasoning =/m);
  assert.equal(Object.hasOwn(omitted.effective.modelOverrides.original, 'reasoning'), false);
  for (const reasoning of ['OFF', '', 'none', 0, false, null, {}, ['off']]) {
    assert.throws(() => settings({ original: { reasoning } }),
      { code: 'LOCAL_LLAMA_SETTINGS_INVALID' });
  }
  assert.throws(() => validateLlamaCppSettings({
    ...DEFAULT_LLAMA_CPP_SETTINGS, modelsDirectory: 'C:\\Models', reasoning: 'off',
  }), { code: 'LOCAL_LLAMA_SETTINGS_INVALID' });
});

test('revisioned settings preserve native reasoning and explicit later edits', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minicpm-reasoning-settings-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = await new LlamaCppSettingsStore({ dataDir }).init();
  const original = { ...sample, reasoning: 'off', ctxSize: 262144, cacheTypeK: 'q8_0', mmprojOffload: false };
  const other = { reasoning: 'on', gpuLayers: 0 };
  const configured = settings({ original, other });
  await store.update({ expectedRevision: 0, settings: configured });
  const reloaded = await new LlamaCppSettingsStore({ dataDir }).init();
  assert.deepEqual(reloaded.snapshot().settings, configured);
  const edited = structuredClone(configured);
  edited.modelOverrides.original.reasoning = 'auto';
  await reloaded.update({ expectedRevision: 1, settings: edited });
  const final = await new LlamaCppSettingsStore({ dataDir }).init();
  assert.deepEqual(final.snapshot().settings, edited);
  assert.deepEqual(final.snapshot().settings.modelOverrides.other, other);
});
