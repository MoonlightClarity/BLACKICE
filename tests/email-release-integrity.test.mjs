import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appFingerprint } from '../scripts/release-check.mjs';
import { installedFile, validatePatchPath } from '../scripts/install-background-update.mjs';
import { discoverHimalayaExecutable } from '../lib/email-setup.mjs';

test('native token, clipboard, and access helpers are installed and fingerprinted without changing old baselines', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-email-integrity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const folder of ['lib', 'public', 'desktop', 'scripts']) await fs.mkdir(path.join(root, folder));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '2.29.0' }));
  for (const file of ['server.mjs', 'desktop/main.mjs', 'desktop/maintenance-helper.mjs', 'desktop/preload.cjs', 'desktop/browser-driver.mjs', 'desktop/browser-capture.mjs', 'desktop/browser-router.mjs', 'desktop/firefox-driver.mjs', 'desktop/firefox-lazy.mjs', 'desktop/icon.ico']) await fs.writeFile(path.join(root, file), 'owned fixture');
  const before = await appFingerprint(root);
  const packaging = await fs.readFile(new URL('../desktop/electron-builder.yml', import.meta.url), 'utf8');
  const entries = packaging.split(/\r?\n/);
  for (const name of ['scripts/email-oauth-token.mjs', 'desktop/clipboard.mjs', 'scripts/remote-access-cli.mjs']) {
    const helper = path.join(root, name);
    await fs.writeFile(helper, 'owned helper'); const bound = await appFingerprint(root); assert.notEqual(bound, before, name);
    await fs.appendFile(helper, ' altered'); assert.notEqual(await appFingerprint(root), bound, name);
    await fs.unlink(helper); assert.equal(await appFingerprint(root), before, name);
    assert.equal(installedFile(name), true, name);
    assert.ok(entries.includes('  - ' + name) || name.startsWith('desktop/') && entries.includes('  - desktop/**/*.mjs'), name);
  }
  for (const name of ['desktop/chat-mode-driver.mjs', 'desktop/chat-mode-transcript.mjs']) {
    assert.equal(installedFile(name), false, name);
    assert.ok(!entries.includes('  - ' + name), name);
    await assert.rejects(fs.stat(new URL('../' + name, import.meta.url)), { code: 'ENOENT' }, name);
    // Reintroducing any retired executable must still invalidate build evidence.
    const helper = path.join(root, name);
    await fs.writeFile(helper, 'retired helper'); const bound = await appFingerprint(root); assert.notEqual(bound, before, name);
    await fs.appendFile(helper, ' altered'); assert.notEqual(await appFingerprint(root), bound, name);
    await fs.unlink(helper); assert.equal(await appFingerprint(root), before, name);
  }
  for (const file of ['CHAT-MODE.md', 'RELEASE-NOTES-2.31.0.md', 'EMAIL.md', 'PLANNING-AWARENESS.md', 'RELEASE-NOTES-2.30.0.md']) assert.equal(validatePatchPath(file), file);
  for (const file of ['data/agent-email/oauth.json', 'agent-email/managed-oauth.toml', '../scripts/email-oauth-token.mjs']) assert.throws(() => validatePatchPath(file));
});

test('Himalaya discovery suggests an existing absolute executable without reading account configuration or starting a process', async () => {
  const visited = [], userDirectory = path.resolve('disposable-mail-user');
  const expected = path.join(userDirectory, '.local', 'bin', process.platform === 'win32' ? 'himalaya.exe' : 'himalaya');
  const result = await discoverHimalayaExecutable({ userDirectory, searchPath: '', stat: async file => { visited.push(file); return { isFile: () => file === expected }; } });
  assert.equal(result, expected); assert.deepEqual(visited, [expected]);
  const absent = await discoverHimalayaExecutable({ userDirectory, searchPath: ['relative-mail-path', path.resolve('absent-mail-bin')].join(path.delimiter), stat: async file => { assert.ok(path.isAbsolute(file)); throw Object.assign(Error('missing'), { code: 'ENOENT' }); } });
  assert.equal(absent, '');
});
