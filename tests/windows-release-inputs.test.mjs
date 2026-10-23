import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { approvedWindowsPackageFile, forbiddenWindowsPackagePath, readWindowsSourceTestReceipt } from '../scripts/windows-release-inputs.mjs';

test('Windows installer inventory accepts the new runtime assets and the selected release notes', () => {
  for (const file of ['BROWSER-IMPORT.md', 'CHATGPT-CONNECTOR.md', 'scripts/browser-cli.mjs', 'desktop/browser-compatibility/manifest.json', 'desktop/browser-compatibility/main.js', 'desktop/browser-compatibility.mjs', 'lib/browser-profile.mjs', 'public/browser-ui.mjs', 'RELEASE-NOTES-9.8.7.md', 'RELEASE-NOTES-2.33.8.md', 'RELEASE-NOTES-2.33.9.md', 'RELEASE-NOTES-2.33.10.md']) {
    assert.equal(approvedWindowsPackageFile(file, '9.8.7'), true, file);
  }
  for (const file of ['README.md', 'scripts/browser-profile-smoke.mjs', 'scripts/windows-release-inputs.mjs', 'RELEASE-NOTES-9.8.6.md', 'RELEASE-NOTES-2.33.11.md', 'desktop/unknown.json', 'desktop/build-icon.mjs', 'lib/example.test.mjs', 'public/.env', 'lib/node_modules/unsafe.mjs', 'lib/.currents-backup-file.mjs', '../lib/file.mjs', 'lib/../private.txt', 'lib\\file.mjs']) {
    assert.equal(approvedWindowsPackageFile(file, '9.8.7'), false, file);
  }
  for (const directory of ['data', 'lib/node_modules', 'public/.git', 'tests']) assert.equal(forbiddenWindowsPackagePath(directory), true, directory);
});

test('every explicit installer file is approved for the current release', async () => {
  const config = await fs.readFile(new URL('../desktop/electron-builder.yml', import.meta.url), 'utf8');
  const { version } = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const section = /^files:\r?\n([\s\S]*?)(?=^\S)/m.exec(config)?.[1];
  assert.ok(section, 'installer files section is present');
  const rules = section.split(/\r?\n/).map(line => /^  - (.+?)\s*$/.exec(line)?.[1]).filter(Boolean)
    .map(rule => rule.replace(/^(['"])(.*)\1$/, '$2'));
  const files = rules.filter(rule => !rule.startsWith('!') && !/[*?\[\]{}]/.test(rule));
  assert.ok(files.includes('package.json'), 'explicit installer file rules were found');
  assert.ok(files.includes('RELEASE-NOTES-' + version + '.md'), 'the installer includes current release notes');
  for (const file of files) assert.equal(approvedWindowsPackageFile(file, version), true, file);
});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-release-receipt-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'verification'));
  const receiptPath = 'verification/windows-fixture-9.8.7.json';
  const prior = { format: 1, product: 'BLACKICE', scope: 'source-publication', version: '9.8.7', appFingerprint: 'a'.repeat(64), fingerprintUnchanged: true, platform: 'win32', node: 'v24.13.0', checkedAt: '2026-01-01T00:00:00.000Z', tests: { total: 11, passed: 10, failed: 0, requiredSkipped: 0, optionalSkipped: 1, cancelled: 0, exitCode: 0 }, testLogSha256: 'b'.repeat(64) };
  const write = value => fs.writeFile(path.join(directory, receiptPath), JSON.stringify(value) + '\n');
  await write(prior);
  return { directory, receiptPath, prior, write, options: { directory, receiptPath, version: prior.version, appFingerprint: prior.appFingerprint, tracked: new Set([receiptPath]) } };
}

test('the selected tracked receipt retains exact existing evidence and binds its bytes', async t => {
  const f = await fixture(t), evidence = await readWindowsSourceTestReceipt(f.options);
  const bytes = await fs.readFile(path.join(f.directory, f.receiptPath));
  assert.equal(evidence.receiptPath, f.receiptPath);
  assert.equal(evidence.receiptSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(evidence.tests, f.prior.tests); assert.equal(evidence.testLogSha256, f.prior.testLogSha256);
  assert.equal(evidence.appFingerprint, f.prior.appFingerprint); assert.equal(evidence.node, f.prior.node);
  assert.equal(await fs.readFile(path.join(f.directory, f.receiptPath), 'utf8'), JSON.stringify(f.prior) + '\n');
});

test('old, unbound, or unsuccessful receipts cannot establish current source readiness', async t => {
  const f = await fixture(t);
  for (const mutate of [
    value => { value.version = '9.8.6'; },
    value => { value.appFingerprint = 'c'.repeat(64); },
    value => { value.fingerprintUnchanged = false; },
    value => { value.scope = 'fixture'; },
    value => { value.platform = 'linux'; },
    value => { value.tests.failed = 1; value.tests.total++; },
    value => { value.tests.requiredSkipped = 1; value.tests.total++; },
    value => { value.tests.cancelled = 1; },
    value => { value.tests.total++; },
    value => { value.tests = null; },
    value => { delete value.testLogSha256; },
  ]) {
    const prior = structuredClone(f.prior); mutate(prior); await f.write(prior);
    await assert.rejects(readWindowsSourceTestReceipt(f.options));
  }
});

test('receipt selection rejects untracked and external paths before reading evidence', async t => {
  const f = await fixture(t);
  await assert.rejects(readWindowsSourceTestReceipt({ ...f.options, tracked: new Set() }), /not tracked/);
  for (const receiptPath of ['../outside.json', '/tmp/outside.json', 'verification/../outside.json', 'verification\\outside.json', 'verification/nested/file.json']) {
    await assert.rejects(readWindowsSourceTestReceipt({ ...f.options, receiptPath, tracked: new Set([receiptPath]) }), /under verification/);
  }
  await fs.rm(path.join(f.directory, f.receiptPath));
  await assert.rejects(readWindowsSourceTestReceipt(f.options), { code: 'ENOENT' });
});

test('a linked receipt directory cannot redirect verification outside the approved source', async t => {
  const f = await fixture(t), redirected = path.join(f.directory, 'redirected');
  await fs.rename(path.join(f.directory, 'verification'), redirected);
  await fs.symlink(redirected, path.join(f.directory, 'verification'), 'junction');
  await assert.rejects(readWindowsSourceTestReceipt(f.options), /must not be a link/);
});
