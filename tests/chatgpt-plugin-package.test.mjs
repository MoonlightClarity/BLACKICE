import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { canonicalChatGPTPlugin, buildChatGPTPlugin } from '../scripts/build-chatgpt-plugin.mjs';

const appId = 'asdk_app_fixture', appName = 'dev-fixture';
const scopes = ['read', 'files:read', 'files:write', 'commands:run', 'browser:read', 'browser:write', 'planning:write'];
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const read = (files, name) => JSON.parse(files.get(name));
function fixture() {
  const presentation = { displayName: 'BLACKICE', shortDescription: 'Direct workspace tools', defaultPrompt: ['Use BLACKICE.', 'Continue the authorized task.'], capabilities: [] };
  const plugin = { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'blackice', version: '1.1.4', author: { name: 'Owner' }, description: 'Direct tools.', extensions: { 'com.openai': { apps: './.app.json', interface: presentation }, 'example.vendor': { retained: true } } };
  const server = { type: 'streamable-http', url: 'https://blackice.example/mcp/chatgpt', extensions: { 'com.openai': { auth: { type: 'oauth', client: { mode: 'cimd' }, baseScopes: ['read'], defaultScopes: scopes } } } };
  return new Map([
    ['plugin.json', json(plugin)],
    ['.codex-plugin/plugin.json', json({ name: plugin.name, version: plugin.version, interface: presentation, description: plugin.description, apps: './.app.json', skills: './skills', mcpServers: './.mcp.json', keywords: [], legacyOnly: { retained: true } })],
    ['.app.json', Buffer.from(JSON.stringify({ apps: { [appName]: { id: appId, category: 'Productivity' } } }) + '\n\n')],
    ['mcp.json', json({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { 'blackice-direct': server } })],
    ['.mcp.json', json({ mcpServers: { 'blackice-direct': { ...server, headers: {} } }, legacyOnly: true })],
    ['skills/blackice-preflight/SKILL.md', Buffer.from('---\nname: blackice-preflight\ndescription: Use BLACKICE.\n---\nContinue authorized work.\n')],
    ['assets/blackice.png', Buffer.from([137, 80, 78, 71, 0, 255])],
  ]);
}
async function writeFiles(directory, files) {
  for (const [name, bytes] of files) { await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true }); await fs.writeFile(path.join(directory, name), bytes); }
}

test('hosted and fallback routes share one name without changing the App, endpoint, auth, scopes, or content', () => {
  const source = fixture(), original = new Map([...source].map(([key, value]) => [key, Buffer.from(value)]));
  const built = canonicalChatGPTPlugin(source, { appId });
  const portable = read(built.files, 'mcp.json'), legacy = read(built.files, '.mcp.json');
  assert.deepEqual(Object.keys(portable.mcpServers), [appName]);
  assert.deepEqual(Object.keys(legacy.mcpServers), [appName]);
  assert.deepEqual(portable.mcpServers, legacy.mcpServers);
  const server = portable.mcpServers[appName];
  assert.equal(server.url, 'https://blackice.example/mcp/chatgpt');
  assert.equal(server.type, 'streamable-http');
  assert.deepEqual(server.headers, {});
  assert.deepEqual(server.extensions['com.openai'].auth, { type: 'oauth', client: { mode: 'cimd' }, baseScopes: ['read'], defaultScopes: scopes });
  assert.deepEqual(built.files.get('.app.json'), source.get('.app.json'));
  for (const name of ['skills/blackice-preflight/SKILL.md', 'assets/blackice.png']) assert.deepEqual(built.files.get(name), source.get(name));
  assert.deepEqual(source, original);
  assert.equal(built.receipt.appId, appId);
  assert.equal(built.receipt.hostedAppIdentityChanged, false);
  assert.equal(built.receipt.directClientIdentityChanged, true);
  assert.equal(read(built.files, '.mcp.json').legacyOnly, true);
});

test('portable identity, version, and presentation drive compatibility metadata while unique metadata survives', () => {
  const source = fixture(), plugin = read(source, 'plugin.json'), legacy = read(source, '.codex-plugin/plugin.json');
  plugin.extensions['com.openai'].interface.longDescription = 'Complete direct execution.';
  legacy.interface.longDescription = 'Old description.';
  legacy.interface.logoDark = './assets/dark.svg';
  source.set('plugin.json', json(plugin)); source.set('.codex-plugin/plugin.json', json(legacy));
  const built = canonicalChatGPTPlugin(source, { version: '1.1.5' }), next = read(built.files, 'plugin.json'), compat = read(built.files, '.codex-plugin/plugin.json');
  assert.equal(next.name, 'blackice'); assert.equal(compat.name, next.name);
  assert.equal(next.version, '1.1.5'); assert.equal(compat.version, next.version);
  assert.deepEqual(next.extensions['com.openai'].interface, compat.interface);
  assert.deepEqual(compat.interface.defaultPrompt, ['Use BLACKICE.', 'Continue the authorized task.']);
  assert.equal(compat.interface.longDescription, 'Complete direct execution.');
  assert.equal(compat.interface.logoDark, './assets/dark.svg');
  assert.deepEqual(next.extensions['example.vendor'], { retained: true });
  assert.deepEqual(compat.legacyOnly, { retained: true });
  assert.deepEqual(compat.keywords, []);
  assert.equal(compat.skills, './skills');
});

test('a rebuilt package is byte-stable and keeps unrelated App and MCP declarations', () => {
  const source = fixture(), apps = read(source, '.app.json');
  apps.apps.other = { id: 'connector_other' }; source.set('.app.json', json(apps));
  for (const filename of ['mcp.json', '.mcp.json']) {
    const value = read(source, filename); value.mcpServers.other = { type: 'stdio', command: 'other', args: ['--unchanged'] }; source.set(filename, json(value));
  }
  assert.throws(() => canonicalChatGPTPlugin(source), /Select exactly one/);
  const first = canonicalChatGPTPlugin(source, { appId }), second = canonicalChatGPTPlugin(first.files, { appId });
  assert.deepEqual(second.files, first.files);
  assert.equal(second.receipt.directClientIdentityChanged, false);
  assert.deepEqual(read(first.files, '.app.json'), apps);
  assert.deepEqual(read(first.files, 'mcp.json').mcpServers.other, read(source, 'mcp.json').mcpServers.other);
  assert.deepEqual(read(first.files, '.mcp.json').mcpServers.other, read(source, '.mcp.json').mcpServers.other);
});

test('conflicting routing, endpoint, auth, or scopes fail before changing source bytes', () => {
  for (const mutate of [
    value => { value.mcpServers['blackice-direct'].url = 'https://different.example/mcp/chatgpt'; },
    value => { value.mcpServers['blackice-direct'].extensions['com.openai'].auth.client.mode = 'dcr'; },
    value => { value.mcpServers['blackice-direct'].extensions['com.openai'].auth.defaultScopes = ['read']; },
    value => { value.mcpServers[appName] = { type: 'streamable-http', url: 'https://different.example/mcp' }; },
  ]) {
    const source = fixture(), legacy = read(source, '.mcp.json'); mutate(legacy); source.set('.mcp.json', json(legacy));
    const original = new Map([...source].map(([key, value]) => [key, Buffer.from(value)]));
    assert.throws(() => canonicalChatGPTPlugin(source), /disagree|different MCP server/);
    assert.deepEqual(source, original);
  }
  assert.throws(() => canonicalChatGPTPlugin(fixture(), { appId: 'asdk_app_unrelated' }), /Select exactly one/);
});

test('copy-only directory build preserves source and refuses an existing destination or a nested output', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-plugin-build-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source'), output = path.join(directory, 'generated'), files = fixture();
  await writeFiles(source, files);
  const receipt = await buildChatGPTPlugin({ source, output, appId });
  assert.equal(receipt.output, output); assert.equal(receipt.files.length, files.size);
  assert.ok(receipt.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
  for (const [name, bytes] of files) assert.deepEqual(await fs.readFile(path.join(source, name)), bytes);
  assert.deepEqual(await fs.readFile(path.join(output, '.app.json')), files.get('.app.json'));
  assert.deepEqual(await fs.readFile(path.join(output, 'assets/blackice.png')), files.get('assets/blackice.png'));
  await fs.writeFile(path.join(output, 'leave-alone.txt'), 'Existing output.');
  await assert.rejects(buildChatGPTPlugin({ source, output }), error => error.code === 'EEXIST');
  assert.equal(await fs.readFile(path.join(output, 'leave-alone.txt'), 'utf8'), 'Existing output.');
  await assert.rejects(buildChatGPTPlugin({ source, output: path.join(source, 'nested') }), /outside/);
});
