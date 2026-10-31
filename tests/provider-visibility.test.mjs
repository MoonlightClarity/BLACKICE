import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeSettingsStore, validateRuntimeSettings } from '../lib/runtime-settings.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-provider-visibility-'));
  const settings = await new RuntimeSettingsStore({ dataDir }).init();
  t.after(async () => { await settings.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, settings };
}

test('provider visibility accepts exact provider IDs, deduplicates them, and keeps caller arrays separate', () => {
  const ids = ['codex', 'saved_api', 'my-endpoint', 'codex'];
  const patch = validateRuntimeSettings({ hiddenModelProviders: ids });
  assert.deepEqual(patch, { hiddenModelProviders: ['codex', 'saved_api', 'my-endpoint'] });
  ids.push('later'); assert.deepEqual(patch.hiddenModelProviders, ['codex', 'saved_api', 'my-endpoint']);
  assert.deepEqual(validateRuntimeSettings({ hiddenModelProviders: [] }), { hiddenModelProviders: [] });
  for (const hiddenModelProviders of [null, undefined, false, 'codex', {}, [null], [1], [''], ['Codex'], ['api::model'], [' provider'], ['a'.repeat(41)]]) {
    assert.throws(() => validateRuntimeSettings({ hiddenModelProviders }), { code: 'RUNTIME_SETTINGS_INVALID', status: 400 });
  }
});

test('visibility survives restart and independent partial preference updates without changing conversation defaults', async t => {
  const { settings, dataDir } = await fixture(t), events = [];
  settings.on('updated', value => events.push(value));
  const baseline = settings.get(); assert.deepEqual(baseline.hiddenModelProviders, []);
  const values = await Promise.all([
    settings.update({ hiddenModelProviders: ['codex', 'saved_api'] }),
    settings.update({ defaultEffort: 'high' }),
    settings.update({ defaultContext: { autoCompact: false } }),
  ]);
  const expected = { ...baseline, hiddenModelProviders: ['codex', 'saved_api'], defaultEffort: 'high', defaultContext: { ...baseline.defaultContext, autoCompact: false } };
  assert.deepEqual(values.at(-1), expected); assert.deepEqual(settings.get(), expected);
  assert.deepEqual(JSON.parse(await fs.readFile(settings.file, 'utf8')), expected);
  assert.equal(events.length, 3); assert.deepEqual(events.at(-1), expected);
  const exposed = settings.get(); exposed.hiddenModelProviders.push('mutated');
  assert.deepEqual(settings.get(), expected);
  const restored = await new RuntimeSettingsStore({ dataDir }).init(); t.after(() => restored.close());
  assert.deepEqual(restored.get(), expected);
  await restored.update({ hiddenModelProviders: [] });
  assert.deepEqual(restored.get(), { ...expected, hiddenModelProviders: [] });
});

test('invalid visibility updates preserve saved preferences and the next valid hide or restore still saves', async t => {
  const { settings } = await fixture(t);
  await settings.update({ hiddenModelProviders: ['codex'], verbosity: 'detailed' });
  const before = await fs.readFile(settings.file, 'utf8');
  for (const hiddenModelProviders of [null, ['valid', 'api::model'], { codex: true }]) {
    await assert.rejects(settings.update({ hiddenModelProviders }), { code: 'RUNTIME_SETTINGS_INVALID' });
    assert.equal(await fs.readFile(settings.file, 'utf8'), before);
  }
  await settings.update({ hiddenModelProviders: ['saved_api'] });
  assert.equal(settings.get().verbosity, 'detailed'); assert.deepEqual(settings.get().hiddenModelProviders, ['saved_api']);
});

test('legacy preferences show every provider without rewriting the saved file at startup', async t => {
  const { settings, dataDir } = await fixture(t); await settings.close();
  const legacy = JSON.stringify({ codexHistory: 'codex', defaultEffort: 'high' });
  await fs.writeFile(settings.file, legacy);
  const restored = await new RuntimeSettingsStore({ dataDir }).init(); t.after(() => restored.close());
  assert.deepEqual(restored.get().hiddenModelProviders, []);
  assert.equal(restored.get().defaultEffort, 'high'); assert.equal(await fs.readFile(settings.file, 'utf8'), legacy);
});

test('hiding API and Codex providers leaves endpoints, credentials, model availability, defaults, and running status intact', async t => {
  const { settings, dataDir } = await fixture(t);
  let requests = 0;
  const native = { connected: true, authenticated: true, activeTurns: 1, defaultModel: 'native-model', models: [
    { id: 'native-model', model: 'native-model', contextWindowTokens: 65536 },
    { id: 'native-hidden', model: 'native-hidden', hidden: true },
  ] };
  const codex = { status: () => structuredClone(native), async close() {} };
  const runtime = await new ProviderRuntime({ codex, dataDir, fetchImpl: async () => { requests++; throw new Error('Visibility must not contact providers.'); } }).init();
  t.after(() => runtime.close());
  await runtime.store.save({ id: 'saved_api', type: 'compatible', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-only-key', models: [
    { id: 'saved-model', contextWindowTokens: 32768, maxOutputTokens: 4096 },
  ] });
  await runtime.store.setDefaultModel('saved_api::saved-model');
  const beforeStatus = runtime.status(), beforeProviders = await fs.readFile(runtime.store.file, 'utf8');
  await settings.update({ hiddenModelProviders: ['codex', 'saved_api'] });
  assert.deepEqual(runtime.status(), beforeStatus);
  assert.equal(runtime.resolveModel('saved_api::saved-model').available, true);
  assert.equal(runtime.resolveModel('native-model').available, true);
  assert.equal(runtime.store.key('saved_api'), 'fixture-only-key');
  assert.equal(runtime.store.get('saved_api').enabled, true);
  assert.equal(runtime.store.get('saved_api').baseUrl, 'https://fixture.invalid/v1');
  assert.equal(await fs.readFile(runtime.store.file, 'utf8'), beforeProviders);
  assert.equal(runtime.status().models.find(model => model.id === 'native-hidden').hidden, true);
  await settings.update({ hiddenModelProviders: [] });
  assert.deepEqual(runtime.status(), beforeStatus); assert.equal(requests, 0);
});
