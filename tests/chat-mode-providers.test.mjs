import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { ProviderStore } from '../lib/provider-store.mjs';
import { RETIRED_CHAT_MODE_MODEL as model, CHAT_MODE_RETIRED_MESSAGE } from '../lib/retired-models.mjs';

const retiredThread = 'provider_chatmode_00000000-0000-0000-0000-000000000000';
class Codex extends EventEmitter {
  calls = []; starts = 0;
  status() { return { connected: true, authenticated: true, defaultModel: 'test-model', models: [{ id: 'test-model', model: 'test-model', supportsTools: true }], activeTurns: 0 }; }
  async start() { this.starts++; return this.status(); }
  async runAgent(options) { this.calls.push(['run', options]); return { output: 'Supported model answer.', threadId: 'codex-thread' }; }
  async steerAgent(...args) { this.calls.push(['steer', ...args]); }
  async compactThread(...args) { this.calls.push(['compact', ...args]); }
  async close() {}
}
async function fixture(t, { savedDefault, corruptReceipt = false } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-retired-provider-')), codex = new Codex(), network = [], reverseCalls = [];
  const obsolete = new Proxy({}, { get(_target, name) { reverseCalls.push(String(name)); throw Error('Retired browser runtime must never be inspected or invoked.'); } });
  const stateFile = path.join(dataDir, 'chat-mode-state.json'), state = corruptReceipt ? 'preserve unreadable historical receipt' : JSON.stringify({ version: 1, threads: [{ id: retiredThread, route: model }], pending: { id: 'historical-unconfirmed-attempt' } });
  await writeFile(stateFile, state);
  if (savedDefault) await writeFile(path.join(dataDir, 'providers.json'), JSON.stringify({ version: 1, defaultModel: savedDefault, providers: [] }));
  const runtime = await new ProviderRuntime({ codex, dataDir, chatMode: obsolete, fetchImpl: (...args) => { network.push(args); throw Error('Unexpected API request.'); } }).init();
  t.after(async () => { await runtime.close(); assert.deepEqual(reverseCalls, []); assert.equal(await readFile(stateFile, 'utf8'), state); await rm(dataDir, { recursive: true, force: true }); });
  return { runtime, codex, network, dataDir, reverseCalls };
}

test('retired provider is absent from the catalog and ignored obsolete runtime options cannot revive it', async t => {
  const { runtime, codex, dataDir } = await fixture(t);
  assert.equal(runtime.status().chatMode, undefined);
  assert.equal(runtime.status().models.some(entry => entry.id === model), false);
  const oldStatus = codex.status.bind(codex);
  codex.status = () => ({ ...oldStatus(), models: [...oldStatus().models, { id: model, model, available: true }] });
  assert.equal(runtime.status().models.some(entry => entry.id === model), false, 'even a stale catalog cannot offer the removed provider');
  assert.equal((await runtime.runAgent({ model: 'test-model', prompt: 'Use the supported model.', cwd: dataDir })).output, 'Supported model answer.');
  await assert.rejects(runtime.runAgent({ model, prompt: 'Never substitute a provider.', cwd: dataDir }), { code: 'CHAT_MODE_RETIRED' });
  assert.equal(codex.calls.length, 1);
});

test('a saved retired default is readable, unchanged, unavailable, and never falls back during startup', async t => {
  const { runtime, codex, network, dataDir } = await fixture(t, { savedDefault: model });
  const file = path.join(dataDir, 'providers.json'), before = await readFile(file, 'utf8');
  const status = await runtime.start();
  assert.equal(status.defaultModel, model); assert.equal(status.defaultModelSelection, model); assert.equal(status.defaultModelAvailable, false);
  assert.equal(status.defaultModelError, CHAT_MODE_RETIRED_MESSAGE); assert.equal(codex.starts, 0);
  await assert.rejects(runtime.runAgent({ prompt: 'Preserve the selected route.', cwd: dataDir }), { code: 'CHAT_MODE_RETIRED' });
  assert.equal(await readFile(file, 'utf8'), before); assert.deepEqual(network, []); assert.deepEqual(codex.calls, []);
  await runtime.setDefaultModel('test-model');
  assert.equal((await runtime.runAgent({ prompt: 'An explicit supported choice.', cwd: dataDir })).output, 'Supported model answer.');
});

test('retired thread identity remains available for explicit history handoff but cannot execute, steer, or compact', async t => {
  const { runtime, codex, network, dataDir } = await fixture(t);
  assert.equal(await runtime.savedThreadModel(retiredThread), model);
  for (const options of [{}, { model }, { model: 'test-model' }]) await assert.rejects(runtime.runAgent({ ...options, threadId: retiredThread, prompt: 'Keep the original owner.', cwd: dataDir }), { code: 'CHAT_MODE_RETIRED' });
  await assert.rejects(runtime.steerAgent(retiredThread, 'No browser interaction.'), { code: 'CHAT_MODE_RETIRED' });
  await assert.rejects(runtime.compactThread(retiredThread), { code: 'CHAT_MODE_RETIRED' });
  assert.deepEqual(codex.calls, []); assert.deepEqual(network, []);
});

test('the retired model cannot be newly selected, automatically pinned, or impersonated as an API', async t => {
  const { runtime, dataDir } = await fixture(t);
  await assert.rejects(runtime.setDefaultModel(model), { code: 'CHAT_MODE_RETIRED' });
  await assert.rejects(runtime.saveProvider({ id: 'chatgpt', type: 'compatible', baseUrl: 'http://127.0.0.1:35412/v1', models: ['chat-mode'] }), { code: 'CHAT_MODE_RETIRED' });
  const store = new ProviderStore({ dataDir, explicitRoutes: [model] }); await store.init();
  await assert.rejects(store.setDefaultModel(model), { code: 'CHAT_MODE_RETIRED' });
  await assert.rejects(store.pinAutomaticDefault(model), { code: 'CHAT_MODE_RETIRED' });
  assert.notEqual(runtime.automaticCandidate(), model);
});

test('unreadable retired browser receipts cannot block supported model startup and remain untouched', async t => {
  const { runtime, dataDir } = await fixture(t, { corruptReceipt: true });
  await runtime.start();
  assert.equal(runtime.status().defaultModel, 'test-model');
  assert.equal((await runtime.runAgent({ prompt: 'Use the supported model.', cwd: dataDir })).output, 'Supported model answer.');
});
