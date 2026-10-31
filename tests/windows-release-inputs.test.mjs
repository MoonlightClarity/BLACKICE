import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { approvedWindowsPackageFile, forbiddenWindowsPackagePath, readWindowsSourceTestReceipt, nativeRestartCLIOutcome } from '../scripts/windows-release-inputs.mjs';

test('native restart diagnostics retain only the exit code and an enumerated error code from noisy private logs', () => {
  const log = ['Native warning: C:\\private\\profile Bearer private-token', 'not JSON ACCESS_RUNTIME_OWNERSHIP', '{broken', JSON.stringify({ error: 'Private message C:\\private\\profile Bearer private-token', code: 'ACCESS_HOST_NOT_RUNNING', requestId: 'private-request', token: 'private-token' })].join('\r\n');
  const outcome = nativeRestartCLIOutcome(log, 1);
  assert.deepEqual(outcome, { exitCode: 1, errorCode: 'ACCESS_HOST_NOT_RUNNING' });
  assert.doesNotMatch(JSON.stringify(outcome), /private|Bearer|requestId|token|message/);
});

test('native restart failed receipt diagnostics omit the receipt, profile identity and private error message', () => {
  const log = JSON.stringify({ protocol: 1, acknowledged: true, receipt: { status: 'failed', requestId: 'private-request', origin: { profileDir: 'C:\\private\\profile' }, error: { code: 'DESKTOP_RESTART_BUSY', message: 'private-token' } } });
  assert.deepEqual(nativeRestartCLIOutcome(log, 1), { exitCode: 1, errorCode: 'DESKTOP_RESTART_BUSY' });
});

test('native restart diagnostics ignore unknown codes, non-error JSON, malformed lines and success noise', () => {
  for (const line of ['null', '[]', '42', '{}', '{"code":"ACCESS_HOST_NOT_RUNNING"}', '{"error":"private","code":"ACCESS_PRIVATE_TOKEN"}', '{"error":"private","code":{"token":"private"}}', 'prefix {"error":"private","code":"ACCESS_HOST_NOT_RUNNING"}', '{"error":"private","code":"ACCESS_HOST_NOT_RUNNING"' ]) assert.deepEqual(nativeRestartCLIOutcome(line, 1), { exitCode: 1 });
  assert.deepEqual(nativeRestartCLIOutcome('{"error":"private","code":"ACCESS_HOST_NOT_RUNNING"}', 0), { exitCode: 0 });
  assert.deepEqual(nativeRestartCLIOutcome('noise', 'private-token'), { exitCode: null });
});

test('Windows installer inventory accepts the new runtime assets and the selected release notes', () => {
  for (const file of ['BROWSER-IMPORT.md', 'CHATGPT-CONNECTOR.md', 'scripts/browser-cli.mjs', 'scripts/repair-shortcuts.ps1', 'desktop/browser-compatibility/manifest.json', 'desktop/browser-compatibility/main.js', 'desktop/browser-compatibility.mjs', 'lib/browser-profile.mjs', 'public/browser-ui.mjs', 'RELEASE-NOTES-9.8.7.md', 'RELEASE-NOTES-2.33.8.md', 'RELEASE-NOTES-2.33.9.md', 'RELEASE-NOTES-2.33.10.md', 'RELEASE-NOTES-2.33.11.md', 'RELEASE-NOTES-2.33.12.md', 'RELEASE-NOTES-2.33.13.md', 'RELEASE-NOTES-2.34.0.md']) {
    assert.equal(approvedWindowsPackageFile(file, '9.8.7'), true, file);
  }
  for (const file of ['README.md', 'scripts/browser-profile-smoke.mjs', 'scripts/windows-release-inputs.mjs', 'RELEASE-NOTES-9.8.6.md', 'RELEASE-NOTES-2.33.14.md', 'desktop/unknown.json', 'desktop/build-icon.mjs', 'lib/example.test.mjs', 'public/.env', 'lib/node_modules/unsafe.mjs', 'lib/.currents-backup-file.mjs', 'lib/browser.mjs.ownership-backup', 'public/assets.ownership-backup/private.mjs', 'desktop/old.ownership-backup/worker.mjs', 'scripts/other-shortcuts.ps1', '../lib/file.mjs', 'lib/../private.txt', 'lib\\file.mjs']) {
    assert.equal(approvedWindowsPackageFile(file, '9.8.7'), false, file);
  }
  for (const directory of ['data', 'lib/node_modules', 'public/.git', 'tests']) assert.equal(forbiddenWindowsPackagePath(directory), true, directory);
});

test('2.33.14 permits its current notes and preserved 2.33.13 notes without approving arbitrary release documents', () => {
  for (const file of ['RELEASE-NOTES-2.33.13.md', 'RELEASE-NOTES-2.33.14.md']) assert.equal(approvedWindowsPackageFile(file, '2.33.14'), true, file);
  for (const file of ['RELEASE-NOTES-2.33.15.md', 'RELEASE-NOTES-9.8.6.md', 'RELEASE-NOTES-custom.md', 'RELEASE-NOTES.md']) assert.equal(approvedWindowsPackageFile(file, '2.33.14'), false, file);
});

test('Windows installer native helpers use exact approved paths without permitting arbitrary PowerShell or C# files', async () => {
  for (const file of ['desktop/make-icon.ps1', 'desktop/native-window-host.cs', 'desktop/native-window-host.ps1', 'desktop/installed-app-icons.cs', 'desktop/native-app-launcher.cs', 'desktop/native-foreground-guard.cs']) {
    assert.equal(approvedWindowsPackageFile(file, '2.35.2'), true, file);
    assert.equal((await fs.stat(new URL('../' + file, import.meta.url))).isFile(), true, file);
  }
  for (const file of ['desktop/unknown.ps1', 'desktop/unknown.cs', 'desktop/nested/native-window-host.ps1', 'desktop/native-window-host.cmd', 'desktop/native-window-host.cs.bak', 'desktop/native-window-host.ps1.currents-backup-private', 'desktop/../native-window-host.ps1', 'desktop\\native-window-host.ps1', '/desktop/native-window-host.ps1']) {
    assert.equal(approvedWindowsPackageFile(file, '2.35.2'), false, file);
  }
});

test('Windows CI uses hidden native validation and retains every required lifecycle and recovery check', async () => {
  const script = await fs.readFile(new URL('../scripts/verify-windows-release.ps1', import.meta.url), 'utf8');
  const invocation = script.split(/\r?\n/).find(line => line.includes('Invoke-Node') && line.includes('scripts\\verify-installed-runtime.mjs'));
  assert.ok(invocation, 'The installer verifier invokes the actual isolated runtime validator.');
  assert.match(invocation, /'--hidden-only'/);
  const required = /foreach \(\$name in @\(([^)]+)\)\) \{ Assert \(\$runtime\[\$name\]\.passed/.exec(script);
  assert.ok(required, 'Native runtime results remain mandatory.');
  assert.deepEqual([...required[1].matchAll(/'([^']+)'/g)].map(match => match[1]), ['startup', 'restart', 'window', 'shutdown', 'profileBackup', 'diagnostics']);
  assert.match(script, /\$runtime\.shutdown\.forcedTerminationUsed -eq \$false/);
  assert.match(script, /\$runtime\.shutdown\.nativeQuitVerified -eq \$true/);
  assert.match(script, /\$runtime\.shutdown\.ownedProcessesExited -eq \$true/);
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

test('current source publication requires the exact full tested source inventory', async t => {
  const f = await fixture(t), sourceIndexSha256 = 'c'.repeat(64), options = { ...f.options, sourceIndexSha256 };
  await assert.rejects(readWindowsSourceTestReceipt(options), /inventory binding mismatch/);
  await f.write({ ...f.prior, sourceIndexSha256 });
  assert.equal((await readWindowsSourceTestReceipt(options)).sourceIndexSha256, sourceIndexSha256);
  for (const value of ['d'.repeat(64), '', null]) {
    await assert.rejects(readWindowsSourceTestReceipt({ ...options, sourceIndexSha256: value }), /inventory binding mismatch/);
  }
  await f.write(f.prior);
  assert.equal((await readWindowsSourceTestReceipt(f.options)).sourceIndexSha256, undefined, 'historical callers retain their original receipt contract');
});
