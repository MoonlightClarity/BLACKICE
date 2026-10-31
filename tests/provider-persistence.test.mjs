import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderStore } from '../lib/provider-store.mjs';

const encode = value => Buffer.from(String(value)).toString('base64');
const decode = value => Buffer.from(String(value), 'base64').toString('utf8');
const originalEntry = (id, at) => ({
  id, type: 'compatible', name: id, baseUrl: `https://${id}.example/v1`,
  models: [{ id: `model-${id}`, displayName: `Legacy ${id}`, contextWindowTokens: 65536, maxOutputTokens: 4096 }],
  enabled: true, maxSteps: null, maxTokens: 8192, updatedAt: at,
  secret: { encoding: 'string', kind: 'provider-credentials-v1', data: encode(JSON.stringify({ apiKey: `fixture-key-${id}`, headers: { 'X-Fixture': `header-${id}` } })) },
  legacyExtension: { description: 'Preserve an untouched stored record', nested: [1, { value: id }] },
});
const temporary = id => ({ id, type: 'compatible', name: id, baseUrl: `https://${id}.example/v1`, models: [] });
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'provider-persistence-'));
  const original = { version: 1, defaultModel: null, automaticDefaultModel: null, customCodexModels: [], providers: [
    originalEntry('alpha', '2026-01-02T03:04:05.006Z'), originalEntry('beta', '2026-02-03T04:05:06.007Z'), originalEntry('gamma', '2026-03-04T05:06:07.008Z'),
  ] };
  const file = path.join(dataDir, 'providers.json'), bytes = JSON.stringify(original);
  await writeFile(file, bytes);
  const settings = { dataDir, encryptSecret: encode, decryptSecret: decode, ...options };
  const store = new ProviderStore(settings); await store.init();
  t.after(async () => { await store.writes.catch(() => {}); await rm(dataDir, { recursive: true, force: true }); });
  const read = async () => JSON.parse(await readFile(file, 'utf8'));
  const assertOriginals = async () => {
    const current = await read();
    assert.deepEqual(current.providers.filter(entry => original.providers.some(saved => saved.id === entry.id)), original.providers);
    for (const entry of original.providers) assert.equal(store.get(entry.id).updatedAt, entry.updatedAt);
  };
  return { store, settings, original, file, bytes, read, assertOriginals, dataDir };
}

test('loading preserves valid saved revisions and legacy capacity interpretation without writing the file', async t => {
  const f = await fixture(t);
  for (const entry of f.original.providers) {
    const loaded = f.store.get(entry.id), publicEntry = f.store.public(loaded);
    assert.equal(loaded.updatedAt, entry.updatedAt); assert.equal(publicEntry.updatedAt, entry.updatedAt);
    assert.equal(loaded.models[0].contextWindowSource, 'user-configured'); assert.equal(loaded.models[0].maxOutputTokensSource, 'user-configured');
    assert.equal(Object.hasOwn(entry.models[0], 'contextWindowSource'), false); assert.equal(Object.hasOwn(entry.models[0], 'maxOutputTokensSource'), false);
    assert.equal(f.store.key(entry.id), `fixture-key-${entry.id}`); assert.equal(publicEntry.hasApiKey, true);
  }
  const second = new ProviderStore(f.settings); await second.init();
  for (const entry of f.original.providers) assert.equal(second.get(entry.id).updatedAt, entry.updatedAt);
  assert.equal(await readFile(f.file, 'utf8'), f.bytes);
});

test('unrelated add/remove and default-model persistence retain original provider records and restore identical bytes', async t => {
  const f = await fixture(t);
  await f.store.save(temporary('temporary')); await f.assertOriginals();
  await f.store.setDefaultModel('codex'); await f.assertOriginals();
  await f.store.setDefaultModel(null); await f.assertOriginals();
  await f.store.pinAutomaticDefault('alpha::model-alpha'); await f.assertOriginals();
  await f.store.setDefaultModel(null); await f.assertOriginals();
  await f.store.addCodexModel('fixture-hidden-model'); await f.assertOriginals();
  await f.store.removeCodexModel('fixture-hidden-model'); await f.assertOriginals();
  await f.store.remove('temporary'); await f.assertOriginals();
  assert.equal(await readFile(f.file, 'utf8'), f.bytes);
});

test('an own edit writes a new canonical record and advances its revision, which remains usable after reload', async t => {
  const f = await fixture(t), oldRevision = f.original.providers[0].updatedAt;
  const saved = await f.store.save({ id: 'alpha', name: 'Edited alpha' }, { expectedUpdatedAt: oldRevision });
  assert.ok(Date.parse(saved.updatedAt) > Date.parse(oldRevision)); assert.notEqual(saved.updatedAt, oldRevision);
  const disk = await f.read(), edited = disk.providers.find(entry => entry.id === 'alpha');
  assert.equal(edited.name, 'Edited alpha'); assert.equal(edited.models[0].maxOutputTokensSource, 'user-configured');
  assert.equal(Object.hasOwn(edited, 'legacyExtension'), false, 'An explicitly edited provider is canonically serialized.');
  assert.deepEqual(disk.providers.slice(1), f.original.providers.slice(1));
  const reloaded = new ProviderStore(f.settings); await reloaded.init(); assert.equal(reloaded.get('alpha').updatedAt, saved.updatedAt);
  const next = await reloaded.save({ id: 'alpha', name: 'Edited again' }, { expectedUpdatedAt: saved.updatedAt });
  assert.ok(Date.parse(next.updatedAt) > Date.parse(saved.updatedAt));
  await assert.rejects(reloaded.save({ id: 'alpha', name: 'Stale' }, { expectedUpdatedAt: saved.updatedAt }), { code: 'PROVIDER_CHANGED', status: 409 });
  assert.deepEqual((await f.read()).providers.slice(1), f.original.providers.slice(1));
});

test('failed saves, removal and default changes roll back identities, credentials and original provider order', async t => {
  const f = await fixture(t), identities = new Map(f.store.configs), blocker = path.join(f.dataDir, 'not-a-directory');
  await writeFile(blocker, 'block writes here');
  const failWrite = async operation => {
    const originalPath = f.store.file; f.store.file = path.join(blocker, 'providers.json');
    try { await assert.rejects(operation()); } finally { f.store.file = originalPath; }
    assert.equal(await readFile(f.file, 'utf8'), f.bytes);
    assert.deepEqual([...f.store.configs.keys()], [...identities.keys()]);
    for (const [id, config] of identities) {
      assert.equal(f.store.get(id), config); assert.equal(f.store.key(id), `fixture-key-${id}`); assert.deepEqual(f.store.extraHeaders(id), { 'X-Fixture': `header-${id}` });
    }
  };
  await failWrite(() => f.store.save({ id: 'alpha', name: 'Should roll back', apiKey: 'replacement-fixture-key', headers: { 'X-Fixture': 'replacement-header' } }));
  await failWrite(() => f.store.remove('beta'));
  await failWrite(() => f.store.setDefaultModel('codex')); assert.equal(f.store.defaultModel, null);
  await failWrite(() => f.store.save({ ...temporary('failednew'), apiKey: 'new-fixture-key' })); assert.equal(f.store.get('failednew'), undefined); assert.equal(f.store.key('failednew'), '');
  await f.store.save(temporary('temporary')); await f.store.remove('temporary');
  await f.assertOriginals(); assert.equal(await readFile(f.file, 'utf8'), f.bytes);
});

test('a failed edit after a successful canonical save retains the committed record on the next unrelated persist', async t => {
  const f = await fixture(t); await f.store.save({ id: 'alpha', name: 'Committed edit' });
  const committed = await readFile(f.file, 'utf8'), identity = f.store.get('alpha'), blocker = path.join(f.dataDir, 'blocked');
  await writeFile(blocker, 'block'); f.store.file = path.join(blocker, 'providers.json');
  try { await assert.rejects(f.store.save({ id: 'alpha', name: 'Failed edit' })); } finally { f.store.file = f.file; }
  assert.equal(f.store.get('alpha'), identity); assert.equal(await readFile(f.file, 'utf8'), committed);
  await f.store.save(temporary('temporary')); await f.store.remove('temporary');
  assert.equal(await readFile(f.file, 'utf8'), committed);
});

test('queued persistence snapshots isolate nested models, secrets and override lists from later mutations', async t => {
  const f = await fixture(t); await f.store.save({ id: 'alpha', name: 'Canonical snapshot' });
  const committed = (await f.read()).providers.find(entry => entry.id === 'alpha'), config = f.store.get('alpha'), override = ['snapshot-native-model'];
  let release; f.store.writes = new Promise(resolve => { release = resolve; });
  const pending = f.store.persist({ customCodexModels: override });
  config.models[0].displayName = 'Later unsaved mutation'; config.secret.data = 'later-unsaved-data'; override.push('later-model'); release(); await pending;
  const disk = await f.read(); assert.deepEqual(disk.providers.find(entry => entry.id === 'alpha'), committed); assert.deepEqual(disk.customCodexModels, ['snapshot-native-model']);
});

test('runtime credential errors never enter untouched or canonical serialized records', async t => {
  const f = await fixture(t, { decryptSecret: () => { throw Error('Fixture cannot decrypt'); } });
  assert.equal(typeof f.store.get('alpha').secretError, 'string');
  await f.store.save(temporary('temporary')); await f.assertOriginals();
  assert.ok((await f.read()).providers.every(entry => !Object.hasOwn(entry, 'secretError')));
  f.store.get('temporary').secretError = 'Transient runtime diagnostic'; await f.store.setDefaultModel('codex');
  assert.ok((await f.read()).providers.every(entry => !Object.hasOwn(entry, 'secretError')));
});
