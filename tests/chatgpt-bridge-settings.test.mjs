import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatGPTBridgeSettings } from '../lib/chatgpt-bridge-settings.mjs';

const defaults = { revision: 1, connectorName: 'BLACKICE Bridge', mode: 'mcp', enabled: false, port: 8791, publicMcpUrl: '', approvalMode: 'reuse' };
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-bridge-settings-'));
  const store = await new ChatGPTBridgeSettings({ dataDir: directory }).init();
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, store, file: path.join(directory, 'chatgpt-bridge-settings.json'), tokenFile: path.join(directory, 'chatgpt-bridge-token.txt') };
}

test('each installation begins disabled with generic defaults and no token file', async t => {
  const { directory, store } = await fixture(t);
  assert.deepEqual(store.get(), defaults); assert.deepEqual(store.status(), { healthy: true, error: null, hasToken: false });
  const value = store.get(); value.enabled = true; assert.equal(store.get().enabled, false);
  assert.deepEqual(await store.update({ revision: 1, ...defaults }), defaults);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('configuration persists, no-op updates retain revision, and stale writes conflict', async t => {
  const { directory, file, store } = await fixture(t);
  const saved = await store.update({ revision: 1, connectorName: 'Personal Research Bridge', mode: 'connector', enabled: true, port: 9891, publicMcpUrl: 'https://bridge.example.test/mcp' });
  assert.equal(saved.revision, 2); assert.equal(saved.enabled, true);
  const persisted = await fs.readFile(file, 'utf8');
  assert.deepEqual(await store.update({ revision: 2, enabled: true }), saved); assert.equal(await fs.readFile(file, 'utf8'), persisted);
  await assert.rejects(store.update({ revision: 1, enabled: true }), cause => cause.status === 409);
  const results = await Promise.allSettled([store.update({ revision: 2, port: 9892 }), store.update({ revision: 2, connectorName: 'Stale competing edit' })]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected'); assert.equal(results[1].reason.status, 409);
  await store.close(); const restarted = await new ChatGPTBridgeSettings({ dataDir: directory }).init(); t.after(() => restarted.close());
  assert.deepEqual(restarted.get(), { ...saved, port: 9892, revision: 3 }); assert.equal(restarted.status().hasToken, false);
});

test('settings strictly validate fields, revisions, names, ports, and the public MCP URL', async t => {
  const { directory, store } = await fixture(t);
  const invalid = [
    null, [], {}, { revision: '1' }, { revision: 0 }, { revision: 1.5 }, { revision: 1, token: 'must not be accepted' },
    { revision: 1, connectorName: '' }, { revision: 1, connectorName: 'line\nbreak' }, { revision: 1, connectorName: 'x'.repeat(81) },
    { revision: 1, mode: 'automatic' }, { revision: 1, approvalMode: 'always' }, { revision: 1, approvalMode: true }, { revision: 1, approvalMode: null }, { revision: 1, enabled: 'true' }, { revision: 1, port: 1023 }, { revision: 1, port: 65536 }, { revision: 1, port: 8791.5 },
    ...['http://example.test/mcp', 'https://example.test/', 'https://example.test/mcp/', 'https://user:password@example.test/mcp', 'https://@example.test/mcp', 'https://example.test/mcp?token=secret', 'https://example.test/mcp?', 'https://example.test/mcp#', 'https://example.test/other/../mcp', 'https://example.test/%6dcp', 'https://example.test\\mcp', 'https://example.test/MCP', ' https://example.test/mcp'].map(publicMcpUrl => ({ revision: 1, publicMcpUrl })),
  ];
  for (const value of invalid) await assert.rejects(store.update(value), cause => cause.status === 400);
  assert.deepEqual(store.get(), defaults); assert.deepEqual(await fs.readdir(directory), []);
  const valid = await store.update({ revision: 1, connectorName: ' Custom connector ', publicMcpUrl: 'https://EXAMPLE.test:443/mcp', port: 1024 });
  assert.equal(valid.connectorName, 'Custom connector'); assert.equal(valid.publicMcpUrl, 'https://example.test/mcp');
  assert.equal((await store.update({ revision: 2, publicMcpUrl: '', port: 65535 })).publicMcpUrl, '');
});

test('concurrent token creation publishes one durable secret, separate from public settings', async t => {
  const { directory, tokenFile, store } = await fixture(t);
  const other = await new ChatGPTBridgeSettings({ dataDir: directory }).init(); t.after(() => other.close());
  const tokens = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? store : other).token()));
  assert.equal(new Set(tokens).size, 1); const token = tokens[0]; assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await fs.readFile(tokenFile, 'utf8')).trim(), token);
  if (process.platform !== 'win32') assert.equal((await fs.stat(tokenFile)).mode & 0o777, 0o600);
  assert.equal(store.status().hasToken, true); assert.equal(JSON.stringify(store.get()).includes(token), false); assert.equal(JSON.stringify(store.status()).includes(token), false);
  await store.update({ revision: 1, enabled: true });
  assert.equal((await fs.readFile(path.join(directory, 'chatgpt-bridge-settings.json'), 'utf8')).includes(token), false);
  const restarted = await new ChatGPTBridgeSettings({ dataDir: directory }).init(); t.after(() => restarted.close());
  assert.equal(restarted.status().hasToken, true); assert.equal(await restarted.token(), token);
  const separate = await fixture(t); assert.notEqual(await separate.store.token(), token);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['chatgpt-bridge-settings.json', 'chatgpt-bridge-token.txt']);
});

test('invalid saved settings return disabled defaults and preserve the source file', async t => {
  const { directory, file, store } = await fixture(t); await store.close();
  for (const contents of ['{ not JSON', JSON.stringify({ ...defaults, enabled: 'true' }), JSON.stringify({ ...defaults, extra: 'not allowed' }), JSON.stringify({ revision: 1, enabled: true })]) {
    await fs.writeFile(file, contents); const broken = await new ChatGPTBridgeSettings({ dataDir: directory }).init();
    assert.deepEqual(broken.get(), defaults); assert.equal(broken.status().healthy, false);
    await assert.rejects(broken.update({ revision: 1, enabled: true }), cause => cause.status === 503);
    await assert.rejects(broken.token(), cause => cause.status === 503);
    assert.equal(await fs.readFile(file, 'utf8'), contents); await broken.close();
  }
});

test('malformed or missing existing secrets are never exposed or silently regenerated', async t => {
  const { directory, tokenFile, store } = await fixture(t);
  const token = await store.token(); await fs.rm(tokenFile);
  await assert.rejects(store.token(), cause => cause.status === 503 && !cause.message.includes(token));
  assert.equal(store.status().healthy, false); assert.equal(store.status().hasToken, false); assert.equal(store.get().enabled, false);
  await assert.rejects(fs.readFile(tokenFile), cause => cause.code === 'ENOENT'); await store.close();
  const malformed = 'secret-that-must-not-appear-in-an-error!'; await fs.writeFile(tokenFile, malformed);
  const broken = await new ChatGPTBridgeSettings({ dataDir: directory }).init(); t.after(() => broken.close());
  assert.equal(broken.status().healthy, false); assert.equal(broken.status().hasToken, false);
  assert.equal(JSON.stringify(broken.status()).includes(malformed), false);
  await assert.rejects(broken.token(), cause => cause.status === 503 && !cause.message.includes(malformed));
  assert.equal(await fs.readFile(tokenFile, 'utf8'), malformed);
});

test('older installations load scoped approval defaults without rewriting their saved settings', async t => {
  const { directory, file, store } = await fixture(t); await store.close();
  const { approvalMode, ...legacy } = { ...defaults, revision: 7, connectorName: 'Team connector', mode: 'connector' };
  const original = JSON.stringify(legacy, null, 2); await fs.writeFile(file, original);
  const loaded = await new ChatGPTBridgeSettings({ dataDir: directory }).init(); t.after(() => loaded.close());
  assert.equal(loaded.status().healthy, true); assert.deepEqual(loaded.get(), { ...legacy, approvalMode: 'reuse' });
  assert.equal(await fs.readFile(file, 'utf8'), original);
  const saved = await loaded.update({ revision: 7, approvalMode: 'confirm' });
  assert.equal(saved.revision, 8); assert.equal(saved.approvalMode, 'confirm');
  assert.deepEqual(await loaded.update({ revision: 8, approvalMode: 'confirm' }), saved);
  await assert.rejects(loaded.update({ revision: 7, approvalMode: 'reuse' }), error => error.status === 409);
  const reopened = await new ChatGPTBridgeSettings({ dataDir: directory }).init(); t.after(() => reopened.close());
  assert.deepEqual(reopened.get(), saved);
});
