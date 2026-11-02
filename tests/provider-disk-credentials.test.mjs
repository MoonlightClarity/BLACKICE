import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderStore } from '../lib/provider-store.mjs';
import { parseProviderEnv, providerDiskKeyName, resolveProviderDiskKey, writeProviderDiskKey } from '../lib/provider-disk-credentials.mjs';
import { createDirectProviderSetupTools } from '../lib/provider-setup-tools.mjs';

const SECRET = 'synthetic_chinese_provider_key_349073829';
const root = async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'blackice-profile-env-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
};
const source = { action: 'import', tabId: 'tab-a', origin: 'https://provider.example', expectedUrl: 'https://provider.example/keys', expectedDocumentId: 'tab-a:0', ref: 'key-source' };
const client = { id: 'direct-fixture' };
const result = value => JSON.parse(value.contentItems[0].text);

test('Hermes-style profile env parser supports quotes, comments, and provider-specific names', () => {
  assert.equal(providerDiskKeyName('swt_free'), 'BLACKICE_PROVIDER_SWT_FREE_API_KEY');
  assert.equal(providerDiskKeyName('swt-free'), 'BLACKICE_PROVIDER_SWT-FREE_API_KEY');
  const entries = parseProviderEnv('export BLACKICE_PROVIDER_SWT_FREE_API_KEY="key#one"\n# note\nBLACKICE_PROVIDER_SWT_FREE_API_KEY=next-key # comment\nOTHER=\'quoted-value\'\n');
  assert.equal(entries.get('BLACKICE_PROVIDER_SWT_FREE_API_KEY'), 'next-key');
  assert.equal(entries.get('OTHER'), 'quoted-value');
});

test('profile-local plaintext key works immediately, survives cold reload, and is not copied to providers.json', async t => {
  const dataDir = await root(t), store = new ProviderStore({ dataDir });
  await store.init();
  const saved = await store.save({ id: 'jasper', type: 'compatible', baseUrl: 'https://api.example/v1', name: 'Jasper', enabled: true, models: [{ id: 'demo-model', contextWindowTokens: 8192 }] });
  const result = await store.writeDiskCredential('jasper', SECRET, { expectedUpdatedAt: saved.updatedAt });
  assert.equal(result.variable, 'BLACKICE_PROVIDER_JASPER_API_KEY');
  assert.equal(result.provider.secretStorage, 'file');
  assert.equal(result.provider.hasApiKey, true);
  assert.equal(store.key('jasper'), SECRET);
  assert.equal((await readFile(path.join(dataDir, '.env'), 'utf8')).includes(SECRET), true);
  assert.equal((await readFile(path.join(dataDir, 'providers.json'), 'utf8')).includes(SECRET), false);
  const reload = new ProviderStore({ dataDir }); await reload.init();
  assert.equal(reload.key('jasper'), SECRET);
  assert.equal(reload.public(reload.get('jasper')).secretStorage, 'file');
  await reload.save({ id: 'jasper', name: 'Renamed provider' });
  assert.equal((await readFile(path.join(dataDir, 'providers.json'), 'utf8')).includes(SECRET), false);
  await writeProviderDiskKey(dataDir, 'jasper', SECRET + '_rotated');
  assert.equal(reload.key('jasper'), SECRET + '_rotated', 'profile env edits take effect without a restart');
  const metadata = reload.public(reload.get('jasper'));
  assert.equal(metadata.credentialVariable, 'BLACKICE_PROVIDER_JASPER_API_KEY');
  assert.equal(JSON.stringify(metadata).includes(SECRET), false);
});

test('profile .env takes precedence over inherited environment; missing source uses process override', async t => {
  const dataDir = await root(t);
  const name = providerDiskKeyName('xinjianya');
  const environment = { [name]: 'inherited_sample_key_12345' };
  assert.deepEqual(resolveProviderDiskKey(dataDir, 'xinjianya', { environment }), { value: environment[name], source: 'environment', variable: name });
  await writeFile(path.join(dataDir, '.env'), name + '="fresh_sample_key_12345"\n', 'utf8');
  assert.deepEqual(resolveProviderDiskKey(dataDir, 'xinjianya', { environment }), { value: 'fresh_sample_key_12345', source: 'file', variable: name });
});

test('browser key import defaults to disk without an encryption prerequisite or secret in receipts', async t => {
  const dataDir = await root(t), store = new ProviderStore({ dataDir }); await store.init();
  const saved = await store.save({ id: 'xinjianya', type: 'compatible', baseUrl: 'https://api.example/v1', enabled: true });
  let browserCalls = 0, encryptionChecks = 0;
  const runtime = {
    store, writeDiskProviderKey: async (id, key, options) => store.writeDiskCredential(id, key, options),
  };
  const tools = createDirectProviderSetupTools({
    runtime,
    browser: { providerKeySource: async (_source, options) => {
      browserCalls++;
      await options.beforeDispatch();
      return options.consume(SECRET, {});
    } },
    reauthorize: async () => {}, isEncryptionAvailable: () => { encryptionChecks++; return false; },
  });
  const action = { requestId: 'disk-import-test', ...source, providerId: saved.id, expectedUpdatedAt: saved.updatedAt };
  const imported = result(await tools[2].execute(action, { client }));
  assert.equal(imported.imported, true);
  assert.equal(imported.storage, 'disk');
  assert.equal(imported.provider.secretStorage, 'file');
  assert.equal(browserCalls, 1);
  assert.equal(encryptionChecks, 0);
  assert.equal(store.key('xinjianya'), SECRET);
  assert.equal(JSON.stringify(imported).includes(SECRET), false);
  assert.equal((await readFile(path.join(dataDir, 'providers.json'), 'utf8')).includes(SECRET), false);
  assert.equal((await readFile(path.join(dataDir, '.env'), 'utf8')).includes(SECRET), true);
  await assert.rejects(tools[2].execute({ ...action, requestId: 'stale-import', expectedUpdatedAt: '2025-01-01T00:00:00.000Z' }, { client }), { code: 'PROVIDER_CHANGED' });
  assert.equal(browserCalls, 1);
});

test('existing saved provider keys can be copied by identity to the profile file without a plaintext argument', async t => {
  const dataDir = await root(t);
  const store = new ProviderStore({ dataDir, encryptSecret: value => Buffer.from(value).toString('base64'), decryptSecret: value => Buffer.from(value, 'base64').toString('utf8') });
  const saved = await store.save({ id: 'ywz_translation', type: 'compatible', baseUrl: 'https://api.example/v1', apiKey: SECRET });
  const runtime = {
    store, copySavedProviderKeyToDisk: async (id, options) => store.writeDiskCredential(id, store.keys.get(id), options),
  };
  const configure = createDirectProviderSetupTools({ runtime, browser: {}, reauthorize: async () => {} })[1];
  const imported = result(await configure.execute({ requestId: 'migration', action: 'key_to_disk', providerId: saved.id, expectedUpdatedAt: saved.updatedAt }, { client }));
  assert.equal(imported.source, 'file');
  assert.equal(imported.provider.secretStorage, 'file');
  assert.equal(imported.defaultChanged, false);
  assert.equal(JSON.stringify(imported).includes(SECRET), false);
  assert.equal((await readFile(path.join(dataDir, '.env'), 'utf8')).includes(SECRET), true);
});
