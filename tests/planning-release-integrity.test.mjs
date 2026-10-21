import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appFingerprint } from '../scripts/release-check.mjs';
import { installedFile, validatePatchPath } from '../scripts/install-background-update.mjs';

test('lifecycle is an installed runtime input whose changes invalidate fingerprints while old baselines stay readable', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-lifecycle-integrity-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  for (const directory of ['lib', 'public', 'desktop']) await fs.mkdir(path.join(root, directory));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '2.28.0' }));
  for (const file of ['server.mjs', 'desktop/main.mjs', 'desktop/maintenance-helper.mjs', 'desktop/preload.cjs', 'desktop/browser-driver.mjs', 'desktop/browser-capture.mjs', 'desktop/browser-router.mjs', 'desktop/firefox-driver.mjs', 'desktop/firefox-lazy.mjs', 'desktop/icon.ico']) await fs.writeFile(path.join(root, file), 'owned fixture');
  const baseline = await appFingerprint(root);
  await fs.writeFile(path.join(root, 'desktop/lifecycle.mjs'), 'owned lifecycle'); const added = await appFingerprint(root); assert.notEqual(added, baseline);
  await fs.appendFile(path.join(root, 'desktop/lifecycle.mjs'), ' changed'); assert.notEqual(await appFingerprint(root), added);
  await fs.unlink(path.join(root, 'desktop/lifecycle.mjs')); assert.equal(await appFingerprint(root), baseline);
  assert.equal(installedFile('desktop/lifecycle.mjs'), true);
  const packaging = await fs.readFile(new URL('../desktop/electron-builder.yml', import.meta.url), 'utf8'); assert.match(packaging, /^  - desktop\/(?:lifecycle\.mjs|\*\*\/\*\.mjs)$/m);
});

test('remote and browser instructions pass the application patch boundary and are included with runtime files', () => {
  for (const file of ['REMOTE-ACCESS.md', 'BROWSER-PROTECTION.md', 'RELEASE-NOTES-2.29.0.md', 'lib/vendor/ghostery-adblocker.mjs', 'lib/vendor/adblock-filter-data.json']) { assert.equal(validatePatchPath(file), file); assert.equal(installedFile(file), true); }
  for (const file of ['data/remote-access.json', 'data/browser-protection.json', '../REMOTE-ACCESS.md']) assert.throws(() => validatePatchPath(file));
});
