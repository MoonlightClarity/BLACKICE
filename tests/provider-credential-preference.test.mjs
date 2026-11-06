import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderStore, normalizeProvider } from '../lib/provider-store.mjs';
import { providerDiskKeyName } from '../lib/provider-disk-credentials.mjs';

const vault = { encryptSecret: value => Buffer.from('sealed:' + Buffer.from(value).toString('base64')), decryptSecret: value => Buffer.from(String(value).slice(7), 'base64').toString() };
const oldKey = 'synthetic-profile-old-key', savedKey = 'synthetic-encrypted-key', replacement = 'synthetic-replacement-key';
async function fixture(t, options = vault) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-credential-preference-')), store = new ProviderStore({ dataDir, ...options });
  await store.init();
  t.after(async () => { await store.mutations.catch(() => {}); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, store, envFile: path.join(dataDir, '.env') };
}
async function legacy(t) {
  const result = await fixture(t);
  await result.store.save({ id: 'cloud', preset: 'openai', apiKey: savedKey, models: ['kept-model'] });
  await result.store.setDefaultModel('cloud::kept-model');
  const raw = JSON.parse(await readFile(result.store.file, 'utf8'));
  delete raw.providers[0].credentialPreference;
  await writeFile(result.store.file, JSON.stringify(raw));
  await writeFile(result.envFile, providerDiskKeyName('cloud') + '=' + oldKey + '\n');
  result.store = new ProviderStore({ dataDir: result.dataDir, ...vault }); await result.store.init();
  return result;
}

test('an unchanged legacy connection keeps profile-file precedence without migrating or copying its key', async t => {
  const { store, envFile, dataDir } = await legacy(t);
  assert.equal(store.key('cloud'), oldKey); assert.equal(store.public(store.get('cloud')).secretStorage, 'file');
  const env = await readFile(envFile, 'utf8');
  await store.save({ id: 'cloud', name: 'Ordinary rename' });
  assert.equal(store.key('cloud'), oldKey); assert.equal(await readFile(envFile, 'utf8'), env);
  const raw = await readFile(store.file, 'utf8'); assert.equal(raw.includes(oldKey), false);
  assert.equal(JSON.parse(raw).providers[0].credentialPreference, undefined);
  const reload = new ProviderStore({ dataDir, ...vault }); await reload.init(); assert.equal(reload.key('cloud'), oldKey);
});

test('an explicit encrypted replacement overrides the old disk key immediately and after restart without editing the profile file', async t => {
  const { store, envFile, dataDir } = await legacy(t), env = await readFile(envFile, 'utf8'), before = store.get('cloud');
  const result = await store.save({ id: 'cloud', apiKey: replacement }, { expectedUpdatedAt: before.updatedAt });
  assert.equal(store.key('cloud'), replacement); assert.equal(result.hasApiKey, true); assert.equal(result.secretStorage, 'encrypted'); assert.equal(result.credentialVariable, undefined);
  assert.equal(result.credentialPreference, undefined, 'The implementation preference is not public configuration.');
  assert.equal(await readFile(envFile, 'utf8'), env);
  const raw = await readFile(store.file, 'utf8');
  for (const secret of [oldKey, savedKey, replacement]) assert.equal(raw.includes(secret), false);
  assert.equal(JSON.parse(raw).providers[0].credentialPreference, 'saved');
  assert.equal(store.defaultModel, 'cloud::kept-model'); assert.deepEqual(store.get('cloud').models.map(model => model.id), ['kept-model']);
  const reload = new ProviderStore({ dataDir, ...vault }); await reload.init(); assert.equal(reload.key('cloud'), replacement);
  await reload.save({ id: 'cloud', name: 'Later unrelated rename' });
  const second = new ProviderStore({ dataDir, ...vault }); await second.init(); assert.equal(second.key('cloud'), replacement);
  assert.equal(await readFile(envFile, 'utf8'), env);
});

test('explicit clearing persists and does not resurrect an older profile key after restart', async t => {
  const { store, envFile, dataDir } = await legacy(t), env = await readFile(envFile, 'utf8');
  const cleared = await store.save({ id: 'cloud', apiKey: '' });
  assert.equal(store.key('cloud'), ''); assert.equal(cleared.hasApiKey, false); assert.equal(cleared.configured, false); assert.equal(cleared.secretStorage, 'none');
  assert.equal(await readFile(envFile, 'utf8'), env);
  const reload = new ProviderStore({ dataDir, ...vault }); await reload.init();
  assert.equal(reload.key('cloud'), ''); assert.equal(reload.public(reload.get('cloud')).hasApiKey, false);
  await reload.save({ id: 'cloud', name: 'Still cleared' });
  const again = new ProviderStore({ dataDir, ...vault }); await again.init(); assert.equal(again.key('cloud'), '');
  assert.equal(again.defaultModel, 'cloud::kept-model');
});

test('session-only replacement expires safely instead of falling back to a stale disk key after restart', async t => {
  const { store, dataDir, envFile } = await fixture(t, {});
  await writeFile(envFile, providerDiskKeyName('cloud') + '=' + oldKey + '\n');
  const result = await store.save({ id: 'cloud', preset: 'openai', apiKey: replacement });
  assert.equal(result.secretStorage, 'session'); assert.equal(store.key('cloud'), replacement);
  const reload = new ProviderStore({ dataDir }); await reload.init();
  assert.equal(reload.key('cloud'), ''); assert.equal(reload.public(reload.get('cloud')).configured, false);
  assert.equal((await readFile(store.file, 'utf8')).includes(replacement), false);
});

test('a failed vault unlock never falls back to the ignored profile key', async t => {
  const { store, dataDir, envFile } = await fixture(t);
  await writeFile(envFile, providerDiskKeyName('cloud') + '=' + oldKey + '\n');
  await store.save({ id: 'cloud', preset: 'openai', apiKey: replacement });
  const reload = new ProviderStore({ dataDir, ...vault, decryptSecret: () => { throw new Error('Fixture vault locked.'); } }); await reload.init();
  assert.equal(reload.key('cloud'), ''); assert.equal(reload.public(reload.get('cloud')).configured, false); assert.match(reload.public(reload.get('cloud')).lastError, /unlocked/);
});

test('failed persistence rolls back both the preference and credential values', async t => {
  const { store, envFile } = await legacy(t), env = await readFile(envFile, 'utf8'), before = store.get('cloud'), file = await readFile(store.file, 'utf8');
  const persist = store.persist.bind(store); store.persist = async () => { throw new Error('Fixture persistence failure.'); };
  await assert.rejects(store.save({ id: 'cloud', apiKey: replacement }), /persistence failure/);
  assert.equal(store.get('cloud'), before); assert.equal(store.key('cloud'), oldKey); assert.equal(store.keys.get('cloud'), savedKey);
  assert.equal(await readFile(store.file, 'utf8'), file); assert.equal(await readFile(envFile, 'utf8'), env);
  await assert.rejects(store.save({ id: 'cloud', apiKey: '' }), /persistence failure/); assert.equal(store.key('cloud'), oldKey);
  store.persist = persist;
});

test('an explicit later profile-key import becomes the selected source and advances its saved revision', async t => {
  const { store, dataDir } = await fixture(t);
  const saved = await store.save({ id: 'cloud', preset: 'openai', apiKey: replacement });
  const imported = await store.writeDiskCredential('cloud', oldKey, { expectedUpdatedAt: saved.updatedAt });
  assert.equal(imported.provider.secretStorage, 'file'); assert.notEqual(imported.provider.updatedAt, saved.updatedAt); assert.equal(store.key('cloud'), oldKey);
  const reload = new ProviderStore({ dataDir, ...vault }); await reload.init(); assert.equal(reload.key('cloud'), oldKey);
  await assert.rejects(store.save({ id: 'cloud', apiKey: savedKey }, { expectedUpdatedAt: saved.updatedAt }), { code: 'PROVIDER_CHANGED' });
});

test('clearing an API key preserves separately saved headers, which can be cleared independently', async t => {
  const { store, dataDir, envFile } = await fixture(t);
  await writeFile(envFile, providerDiskKeyName('cloud') + '=' + oldKey + '\n');
  await store.save({ id: 'cloud', preset: 'openai', apiKey: replacement, headers: { Authorization: 'Bearer synthetic-header-key' } });
  const cleared = await store.save({ id: 'cloud', apiKey: '' });
  assert.equal(cleared.hasApiKey, false); assert.equal(cleared.hasHeaders, true); assert.equal(cleared.configured, true);
  const reload = new ProviderStore({ dataDir, ...vault }); await reload.init(); assert.equal(reload.key('cloud'), '');
  assert.equal(reload.extraHeaders('cloud').Authorization, 'Bearer synthetic-header-key');
  await reload.save({ id: 'cloud', headers: {} }); assert.equal(reload.hasCredential('cloud'), false);
});

test('credential borrowing validates malformed keys before trimming them', async t => {
  const { store } = await fixture(t), config = normalizeProvider({ id: 'local', preset: 'ollama' });
  for (const apiKey of [null, {}, [], 4, true, 'line\nbreak']) {
    assert.throws(() => store.credentialsFor({ apiKey }, config), { code: 'INVALID_PROVIDER', status: 400 });
    await assert.rejects(store.save({ id: 'local', preset: 'ollama', apiKey }), { code: 'INVALID_PROVIDER' });
  }
});
