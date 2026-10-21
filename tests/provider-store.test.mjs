import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderStore, normalizeProvider, normalizeProviderHeaders, normalizeCodexModelId, atomicJSON } from '../lib/provider-store.mjs';
import { PROVIDER_PRESETS, getProviderPreset, providerRequiresApiKey } from '../public/provider-catalog.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'relay-provider-store-')), store = new ProviderStore({ dataDir, ...options }); await store.init();
  t.after(async () => { await store.mutations.catch(() => {}); await store.writes.catch(() => {}); assert.match(path.basename(dataDir), /^relay-provider-store-/); await rm(dataDir, { recursive: true, force: true }); });
  return { store, dataDir };
}

test('custom native model IDs preserve exact routing and defaults across serialized writes and restart', async t => {
  const { store, dataDir } = await fixture(t), id = 'Vendor/Explicit.Model-2026:preview';
  await store.setDefaultModel('codex');
  await Promise.all([store.addCodexModel(id), store.addCodexModel('second-native'), store.addCodexModel(id), store.save({ id: 'local', preset: 'ollama', models: ['local-model'] })]);
  assert.deepEqual(store.listCodexModels(), [id, 'second-native']); assert.equal(store.defaultModel, 'codex');
  const exposed = store.listCodexModels(); exposed.length = 0; assert.equal(store.listCodexModels().length, 2);
  const restored = new ProviderStore({ dataDir }); await restored.init();
  assert.deepEqual(restored.listCodexModels(), [id, 'second-native']); assert.equal(restored.get('local').models[0].id, 'local-model');
  await store.setDefaultModel(id); await store.removeCodexModel(id);
  assert.equal(store.defaultModel, id, 'removal never chooses a replacement default');
  const disk = JSON.parse(await readFile(store.file, 'utf8')); assert.deepEqual(disk.customCodexModels, ['second-native']); assert.equal(disk.defaultModel, id);
});

test('custom native model writes publish after durability and roll back failed additions and removals', async t => {
  const { store } = await fixture(t); await store.addCodexModel('kept-native');
  const before = await readFile(store.file, 'utf8'), persist = store.persist.bind(store), entered = deferred(), release = deferred();
  store.persist = async () => { entered.resolve(); await release.promise; throw new Error('fixture write rejected'); };
  const saving = store.addCodexModel('unsaved-native'), rejected = assert.rejects(saving, /write rejected/); await entered.promise;
  assert.deepEqual(store.listCodexModels(), ['kept-native']); release.resolve(); await rejected;
  await assert.rejects(store.removeCodexModel('kept-native'), /write rejected/);
  assert.deepEqual(store.listCodexModels(), ['kept-native']); assert.equal(await readFile(store.file, 'utf8'), before);
  store.persist = persist; await store.addCodexModel('later-native'); assert.deepEqual(store.listCodexModels(), ['kept-native', 'later-native']);
});

test('custom native model validation rejects sentinels, provider namespaces and malformed persisted IDs without overwriting them', async t => {
  for (const value of [null, '', undefined, 'default', 'codex', 'model with space', 'model\nnext', 'codex::model', 'api::model', 'a'.repeat(401)]) assert.throws(() => normalizeCodexModelId(value));
  assert.equal(normalizeCodexModelId('Vendor/Case.Sensitive:alias'), 'Vendor/Case.Sensitive:alias');
  const { store, dataDir } = await fixture(t), raw = JSON.stringify({ version: 1, providers: [], customCodexModels: ['valid', 'bad model'] });
  await writeFile(store.file, raw); await assert.rejects(new ProviderStore({ dataDir }).init()); assert.equal(await readFile(store.file, 'utf8'), raw);
});

test('shared presets infer correct protocols and key requirements without embedding a model catalog or credentials', () => {
  const router = normalizeProvider({ id: 'router', preset: 'openrouter' });
  assert.equal(router.baseUrl, 'https://openrouter.ai/api/v1'); assert.equal(router.type, 'compatible'); assert.equal(router.name, 'OpenRouter');
  assert.equal(providerRequiresApiKey(router), true); assert.equal(providerRequiresApiKey(normalizeProvider({ id: 'legacy-router', type: 'compatible', baseUrl: router.baseUrl })), true);
  for (const id of ['ollama', 'lmstudio']) assert.equal(providerRequiresApiKey(normalizeProvider({ id, preset: id })), false);
  assert.equal(getProviderPreset('not-a-preset'), null); assert.ok(PROVIDER_PRESETS.every(item => !Object.hasOwn(item, 'apiKey') && !Object.hasOwn(item, 'models')));
  assert.throws(() => normalizeProvider({ id: 'bad', preset: 'openrouter', type: 'anthropic' }), /does not match/);
  assert.throws(() => normalizeProvider({ id: 'bad', preset: 'unknown' }), /supported/);
});

test('step budgets default to no application limit, preserve saved choices, and accept positive budgets above the former ceiling', async t => {
  const { store, dataDir } = await fixture(t);
  assert.equal(normalizeProvider({ id: 'fresh', preset: 'ollama' }).maxSteps, null);
  await store.save({ id: 'chosen', preset: 'ollama', maxSteps: 24 });
  await store.save({ id: 'chosen', name: 'Renamed without changing the budget' }); assert.equal(store.get('chosen').maxSteps, 24);
  let restored = new ProviderStore({ dataDir }); await restored.init(); assert.equal(restored.get('chosen').maxSteps, 24);
  await store.save({ id: 'chosen', maxSteps: 10000 }); assert.equal(store.get('chosen').maxSteps, 10000);
  await store.save({ id: 'chosen', maxSteps: null }); await store.save({ id: 'chosen', name: 'Unlimited remains explicit' });
  restored = new ProviderStore({ dataDir }); await restored.init(); assert.equal(restored.get('chosen').maxSteps, null);
  for (const maxSteps of [0, -1, 1.5, '24', false, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => normalizeProvider({ id: 'bad', preset: 'ollama', maxSteps }), /positive whole number/);
});

test('durable default metadata survives restart while session-only OpenRouter keys never become configured after restart', async t => {
  const { store, dataDir } = await fixture(t);
  await store.save({ id: 'router', preset: 'openrouter', apiKey: 'session-key-fixture', models: [{ id: 'vendor/model', supportsTools: true, contextWindowTokens: 900000, contextWindowSource: 'provider-reported' }] });
  await store.setDefaultModel('router::vendor/model');
  const raw = await readFile(path.join(dataDir, 'providers.json'), 'utf8'); assert.ok(!raw.includes('session-key-fixture'));
  const restored = new ProviderStore({ dataDir }); await restored.init();
  assert.equal(restored.defaultModel, 'router::vendor/model'); assert.equal(restored.list()[0].configured, false); assert.equal(restored.list()[0].requiresApiKey, true); assert.equal(restored.list()[0].models[0].supportsTools, true);
  assert.equal((await readdir(dataDir)).some(name => name.endsWith('.tmp')), false);
});

test('default changes publish only after the durable write and a failed save preserves the prior default and file', async t => {
  const { store } = await fixture(t); await store.setDefaultModel('codex');
  const before = await readFile(store.file, 'utf8'), entered = deferred(), release = deferred(), persist = store.persist.bind(store);
  store.persist = async () => { entered.resolve(); await release.promise; throw new Error('fixture disk failure'); };
  const saving = store.setDefaultModel(null), rejected = assert.rejects(saving, /disk failure/); await entered.promise;
  assert.equal(store.defaultModel, 'codex'); release.resolve(); await rejected;
  assert.equal(store.defaultModel, 'codex'); assert.equal(await readFile(store.file, 'utf8'), before);
  store.persist = persist; await store.setDefaultModel(null); assert.equal(store.defaultModel, null);
});

test('provider and default mutations serialize without losing either setting, and failed provider changes roll back', async t => {
  const { store } = await fixture(t); await Promise.all([store.save({ id: 'local', preset: 'ollama', models: ['model'] }), store.setDefaultModel('codex')]);
  let saved = JSON.parse(await readFile(store.file, 'utf8')); assert.equal(saved.defaultModel, 'codex'); assert.equal(saved.providers[0].id, 'local');
  const persist = store.persist.bind(store), before = store.get('local'); store.persist = async () => { throw new Error('fixture unsaved'); };
  await assert.rejects(store.save({ id: 'local', name: 'Uncommitted edit' }), /unsaved/); assert.equal(store.get('local'), before);
  await assert.rejects(store.remove('local'), /unsaved/); assert.equal(store.get('local'), before);
  store.persist = persist; saved = JSON.parse(await readFile(store.file, 'utf8')); assert.equal(saved.providers[0].name, before.name);
});

test('invalid saved defaults preserve existing settings instead of resetting to another provider', async t => {
  const { dataDir } = await fixture(t), file = path.join(dataDir, 'providers.json'), raw = JSON.stringify({ version: 1, providers: [], defaultModel: { invalid: true } });
  await writeFile(file, raw); await assert.rejects(new ProviderStore({ dataDir }).init(), /valid default model/); assert.equal(await readFile(file, 'utf8'), raw);
});

test('automatic defaults publish after durable storage, remain stable, and reset only by explicit request', async t => {
  const { store, dataDir } = await fixture(t);
  await store.save({ id: 'local', preset: 'ollama', models: ['model'] });
  const entered = deferred(), release = deferred(), persist = store.persist.bind(store);
  store.persist = async overrides => { entered.resolve(); await release.promise; return persist(overrides); };
  const pending = store.pinAutomaticDefault('local::model'); await entered.promise;
  assert.equal(store.automaticDefaultModel, null);
  release.resolve(); await pending; store.persist = persist;
  await store.pinAutomaticDefault('another-native-model'); assert.equal(store.automaticDefaultModel, 'local::model');
  const restored = new ProviderStore({ dataDir }); await restored.init(); assert.equal(restored.automaticDefaultModel, 'local::model'); assert.equal(restored.defaultModel, null);
  await store.setDefaultModel('codex'); await store.pinAutomaticDefault('another-native-model');
  assert.equal(store.defaultModel, 'codex'); assert.equal(store.automaticDefaultModel, 'local::model');
  await store.setDefaultModel(null); assert.equal(store.automaticDefaultModel, null);
  await store.pinAutomaticDefault('another-native-model'); assert.equal(store.automaticDefaultModel, 'another-native-model');
});

test('failed automatic selection writes and invalid metadata never silently change providers', async t => {
  const { store, dataDir } = await fixture(t), persist = store.persist.bind(store);
  store.persist = async () => { throw new Error('fixture durable selection failure'); };
  await assert.rejects(store.pinAutomaticDefault('native-model'), /durable selection failure/);
  assert.equal(store.automaticDefaultModel, null); store.persist = persist;
  await store.pinAutomaticDefault('native-model'); const before = await readFile(store.file, 'utf8');
  store.persist = async () => { throw new Error('fixture durable reset failure'); };
  await assert.rejects(store.setDefaultModel(null), /durable reset failure/);
  assert.equal(store.automaticDefaultModel, 'native-model'); assert.equal(await readFile(store.file, 'utf8'), before); store.persist = persist;
  const invalid = JSON.stringify({ version: 1, providers: [], defaultModel: null, automaticDefaultModel: { invalid: true } });
  await writeFile(store.file, invalid); await assert.rejects(new ProviderStore({ dataDir }).init(), /valid default model/);
  assert.equal(await readFile(store.file, 'utf8'), invalid);
});

test('failed atomic provider writes remove only their own temporary file', async t => {
  const { dataDir } = await fixture(t), target = path.join(dataDir, 'directory-target'); await mkdir(target);
  await assert.rejects(atomicJSON(target, { fixture: true })); assert.deepEqual((await readdir(dataDir)).sort(), ['directory-target']);
});

test('custom headers use encrypted write-only storage, preserve omissions, and clear independently from the API key', async t => {
  const vault = { encryptSecret: value => Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`), decryptSecret: value => Buffer.from(String(value).slice(7), 'base64').toString() };
  const { store, dataDir } = await fixture(t, vault), key = 'standard-api-key-fixture', header = 'private-gateway-header-fixture';
  const saved = await store.save({ id: 'gateway', preset: 'compatible', type: 'anthropic', baseUrl: 'https://gateway.example.test/api?api-version=2026-01-01', apiKey: key, headers: { 'X-API-Key': header, 'X-Tenant': 'tenant-fixture' }, models: ['model'] });
  assert.equal(saved.hasHeaders, true); assert.equal(saved.secretStorage, 'encrypted'); assert.equal(saved.headers, undefined);
  let raw = await readFile(store.file, 'utf8'); assert.ok(!raw.includes(key)); assert.ok(!raw.includes(header)); assert.ok(!raw.includes('X-API-Key'));
  const restored = new ProviderStore({ dataDir, ...vault }); await restored.init();
  assert.equal(restored.key('gateway'), key); assert.equal(restored.extraHeaders('gateway')['X-API-Key'], header);
  await restored.save({ id: 'gateway', name: 'Renamed gateway' }); assert.equal(restored.extraHeaders('gateway')['X-API-Key'], header);
  await restored.save({ id: 'gateway', headers: {} }); assert.deepEqual(restored.extraHeaders('gateway'), {}); assert.equal(restored.key('gateway'), key);
  const keyOnly = new ProviderStore({ dataDir, ...vault }); await keyOnly.init(); assert.equal(keyOnly.key('gateway'), key); assert.deepEqual(keyOnly.extraHeaders('gateway'), {});
  await keyOnly.save({ id: 'gateway', apiKey: '', headers: { Authorization: `Bearer ${header}` } }); assert.equal(keyOnly.key('gateway'), ''); assert.equal(keyOnly.redact(`Echo ${header}`), 'Echo [redacted]');
  const onlyHeaders = new ProviderStore({ dataDir, ...vault }); await onlyHeaders.init(); assert.equal(onlyHeaders.extraHeaders('gateway').Authorization, `Bearer ${header}`);
  raw = await readFile(store.file, 'utf8'); assert.ok(!raw.includes(header));
});

test('plain-server header credentials stay session-only and failed saves retain the previous secret map', async t => {
  const { store, dataDir } = await fixture(t); await store.save({ id: 'gateway', preset: 'compatible', type: 'openai', headers: { 'api-key': 'session-header-fixture' } });
  assert.equal(store.list()[0].secretStorage, 'session'); assert.ok(!(await readFile(store.file, 'utf8')).includes('session-header-fixture'));
  const restored = new ProviderStore({ dataDir }); await restored.init(); assert.equal(restored.list()[0].hasHeaders, false);
  const persist = store.persist.bind(store); store.persist = async () => { throw new Error('fixture failure'); };
  await assert.rejects(store.save({ id: 'gateway', headers: { 'api-key': 'uncommitted-header-fixture' } }), /fixture failure/); assert.equal(store.extraHeaders('gateway')['api-key'], 'session-header-fixture');
  store.persist = persist;
});

test('gateway URL parameters preserve exact values while credentials and malformed headers fail safely', () => {
  const normalized = normalizeProvider({ id: 'gateway', preset: 'compatible', type: 'anthropic', baseUrl: 'https://gateway.example.test/path/?api-version=2026-01-01&region=west%2F' });
  assert.equal(normalized.baseUrl, 'https://gateway.example.test/path?api-version=2026-01-01&region=west%2F');
  for (const field of ['api_key', 'token', 'secret', 'password', 'sig']) assert.throws(() => normalizeProvider({ id: 'bad', type: 'compatible', baseUrl: `https://example.test/api?${field}=private` }), /credentials/);
  for (const headers of [null, [], { Host: 'example.test' }, { 'Content-Length': '10' }, { 'Bad Name': 'value' }, { Authorization: 'line\nbreak' }, { Authorization: 'one', authorization: 'two' }]) assert.throws(() => normalizeProviderHeaders(headers));
  assert.deepEqual(normalizeProviderHeaders({ 'x-api-key': 'token', 'api-version': '2026-01-01' }), { 'x-api-key': 'token', 'api-version': '2026-01-01' });
});
