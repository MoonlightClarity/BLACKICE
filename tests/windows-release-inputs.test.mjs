import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { approvedWindowsPackageFile, explicitWindowsReleaseNotes, approvedExplicitWindowsReleaseNote, forbiddenWindowsPackagePath, readWindowsSourceTestReceipt, nativeRestartCLIOutcome } from '../scripts/windows-release-inputs.mjs';

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
  assert.equal(approvedWindowsPackageFile('skills/autonomy/SKILL.md','9.8.7'),false);
  assert.equal(approvedWindowsPackageFile('skills/autonomy/unreviewed.md','9.8.7'),false);
  for (const file of ['BROWSER-IMPORT.md', 'CHATGPT-CONNECTOR.md', 'scripts/browser-cli.mjs', 'scripts/repair-shortcuts.ps1', 'desktop/browser-compatibility/manifest.json', 'desktop/browser-compatibility/main.js', 'desktop/browser-compatibility.mjs', 'lib/browser-profile.mjs', 'public/browser-ui.mjs', 'RELEASE-NOTES-9.8.7.md', 'RELEASE-NOTES-2.33.8.md', 'RELEASE-NOTES-2.33.9.md', 'RELEASE-NOTES-2.33.10.md', 'RELEASE-NOTES-2.33.11.md', 'RELEASE-NOTES-2.33.12.md', 'RELEASE-NOTES-2.33.13.md', 'RELEASE-NOTES-2.34.0.md']) {
    assert.equal(approvedWindowsPackageFile(file, '9.8.7'), true, file);
  }
  for (const file of ['README.md', 'scripts/browser-profile-smoke.mjs', 'scripts/windows-release-inputs.mjs', 'RELEASE-NOTES-9.8.6.md', 'RELEASE-NOTES-2.33.14.md', 'desktop/unknown.json', 'desktop/build-icon.mjs', 'lib/example.test.mjs', 'public/.env', 'lib/node_modules/unsafe.mjs', 'lib/.currents-backup-file.mjs', 'lib/browser.mjs.ownership-backup', 'public/assets.ownership-backup/private.mjs', 'desktop/old.ownership-backup/worker.mjs', 'scripts/other-shortcuts.ps1', 'skills/planning/../private.md', 'skills/unapproved/SKILL.md', '../lib/file.mjs', 'lib/../private.txt', 'lib\\file.mjs']) {
    assert.equal(approvedWindowsPackageFile(file, '9.8.7'), false, file);
  }
  for (const directory of ['data', 'lib/node_modules', 'public/.git', 'tests']) assert.equal(forbiddenWindowsPackagePath(directory), true, directory);
});

test('2.33.14 permits its current notes and preserved 2.33.13 notes without approving arbitrary release documents', () => {
  for (const file of ['RELEASE-NOTES-2.33.13.md', 'RELEASE-NOTES-2.33.14.md']) assert.equal(approvedWindowsPackageFile(file, '2.33.14'), true, file);
  for (const file of ['RELEASE-NOTES-2.33.15.md', 'RELEASE-NOTES-9.8.6.md', 'RELEASE-NOTES-custom.md', 'RELEASE-NOTES.md']) assert.equal(approvedWindowsPackageFile(file, '2.33.14'), false, file);
});

test('2.39.98 installer retains exactly its current and reviewed 2.39.97 notes without opening neighboring versions', () => {
  for (const file of ['RELEASE-NOTES-2.39.97.md', 'RELEASE-NOTES-2.39.98.md']) assert.equal(approvedWindowsPackageFile(file, '2.39.98'), true, file);
  for (const file of ['RELEASE-NOTES-2.39.96.md', 'RELEASE-NOTES-2.39.99.md', 'RELEASE-NOTES-2.39.98.md.bak', 'RELEASE-NOTES-custom.md']) assert.equal(approvedWindowsPackageFile(file, '2.39.98'), false, file);
});

test('Windows installer native helpers use exact approved paths without permitting arbitrary PowerShell or C# files', async () => {
  for (const file of ['desktop/make-icon.ps1', 'desktop/native-window-host.cs', 'desktop/native-window-host.ps1', 'desktop/installed-app-icons.cs', 'desktop/native-app-launcher.cs', 'desktop/native-foreground-guard.cs']) {
    assert.equal(approvedWindowsPackageFile(file, '2.35.2'), true, file);
    assert.equal((await fs.stat(new URL('../' + file, import.meta.url))).isFile(), true, file);
  }
  for (const file of ['desktop/unknown.ps1', 'desktop/unknown.cs', 'desktop/nested/native-window-host.ps1', 'desktop/native-window-host.cmd', 'desktop/native-window-host.cs.bak', 'desktop/native-window-host.ps1.currents-backup-private', 'scripts/install-workbench-headless-broker.ps1', 'scripts/random-admin.ps1', 'desktop/../native-window-host.ps1', 'desktop\\native-window-host.ps1', '/desktop/native-window-host.ps1']) {
    assert.equal(approvedWindowsPackageFile(file, '2.35.2'), false, file);
  }
});

test('native password manager approves exactly its shipped HTML and CSS assets, not neighboring content', async () => {
  for (const file of ['desktop/password-manager/index.html', 'desktop/password-manager/style.css']) {
    assert.equal(approvedWindowsPackageFile(file, '2.39.100'), true, file);
    assert.equal((await fs.stat(new URL('../' + file, import.meta.url))).isFile(), true, file);
  }
  for (const file of ['desktop/password-manager/other.html', 'desktop/password-manager/other.css', 'desktop/password-manager/nested/index.html', 'desktop/password-manager/nested/style.css', 'desktop/other/index.html', 'desktop/other/style.css', 'desktop/password-manager/index.html.bak', 'desktop/password-manager/style.css.bak', 'desktop/password-manager/../index.html', 'desktop\\password-manager\\index.html', '/desktop/password-manager/index.html']) {
    assert.equal(approvedWindowsPackageFile(file, '2.39.100'), false, file);
  }
});
test('retired VM files are never approved for Windows packaging', () => {
  for (const file of ['WORKBENCH-NATIVE-DISPLAY.md','desktop/workbench-elevated-command.ps1','desktop/workbench-vmconnect-bridge.cs','scripts/workbench-guest-agent.ps1','scripts/workbench-headless-broker.ps1','scripts/package-workbench-freerdp.mjs','lib/workbench-agent-tools.mjs','lib/windows-workbench.mjs','resources/guest/workbench-guest-video.exe','resources/workbench-native/package.json','public/next/workbench.css','public/next/workspaces/workbench.mjs']) {
    assert.equal(approvedWindowsPackageFile(file, '2.39.60'), false, file);
  }
});

test('all actual desktop native sources matched by builder globs have exact package approval', async () => {
  async function inspect(relative) {
    for (const entry of await fs.readdir(new URL('../' + relative + '/', import.meta.url), { withFileTypes: true })) {
      const file = relative + '/' + entry.name;
      if (entry.isDirectory()) await inspect(file);
      else if (/\.(cs|ps1)$/.test(file) && !forbiddenWindowsPackagePath(file)) assert.equal(approvedWindowsPackageFile(file, '2.38.0'), true, file);
    }
  }
  await inspect('desktop');
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
  assert.ok(files.includes('docs/GOAL-MODE.md'), 'the installer includes the Goal mode guide');
  for (const file of files) assert.equal(approvedWindowsPackageFile(file, version), true, file);
  for (const file of ['docs/private.md', 'docs/GOAL-MODE.md.bak']) assert.equal(approvedWindowsPackageFile(file, version), false, file);
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


test('installed manifest gate reads real PE resources without executing them and rejects wrong launch rights', { skip: process.platform !== 'win32' }, async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-manifest-reader-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'read-manifest.ps1');
  await fs.writeFile(script, String.raw`
param([string]$Verifier,[string]$Directory)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Verifier,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Verifier does not parse.'}
$names=@('Assert','Get-InstalledExecutionManifest','Assert-InstalledExecutionManifest')
$functions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $node.Name},$true))
if($functions.Count -ne 3){throw 'Expected exactly the read-only manifest functions and their assertion helper.'}
. ([scriptblock]::Create(($functions | ForEach-Object {$_.Extent.Text}) -join [Environment]::NewLine))
function Hash-File([string]$Path) { $sha=[Security.Cryptography.SHA256]::Create();try{return [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($Path))).Replace('-','')}finally{$sha.Dispose()} }
$marker=Join-Path $Directory 'entrypoint-executed.txt'
$source='public static class NeverExecute { public static void Main() { System.IO.File.WriteAllText(@"'+$marker.Replace('"','""')+'","executed"); } }'
$provider=[Microsoft.CSharp.CSharpCodeProvider]::new()
$results=@()
try {
  foreach($case in @(
    @{name='highest';level='highestAvailable';uiAccess='false';allowed=$true},
    @{name='required';level='requireAdministrator';uiAccess='false';allowed=$false},
    @{name='invoker';level='asInvoker';uiAccess='false';allowed=$false},
    @{name='ui-access';level='highestAvailable';uiAccess='true';allowed=$false}
  )) {
    $manifest=Join-Path $Directory ($case.name+'.manifest')
    $xml='<?xml version="1.0" encoding="utf-8"?><assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="'+$case.level+'" uiAccess="'+$case.uiAccess+'" /></requestedPrivileges></security></trustInfo></assembly>'
    [IO.File]::WriteAllText($manifest,$xml,[Text.UTF8Encoding]::new($false))
    $file=Join-Path $Directory ($case.name+'.exe')
    $parameters=[CodeDom.Compiler.CompilerParameters]::new()
    $parameters.GenerateExecutable=$true;$parameters.GenerateInMemory=$false;$parameters.OutputAssembly=$file
    $parameters.CompilerOptions='/target:winexe /win32manifest:"'+$manifest+'"'
    $compiled=$provider.CompileAssemblyFromSource($parameters,$source)
    if($compiled.Errors.HasErrors){throw (($compiled.Errors | ForEach-Object {$_.ErrorText}) -join '; ')}
    $before=Hash-File $file
    $read=Get-InstalledExecutionManifest $file
    if($read.requestedExecutionLevel -cne $case.level -or $read.uiAccess -ne ($case.uiAccess -ceq 'true')){throw 'Actual resource policy did not match its known fixture.'}
    $allowed=$true
    try { Assert-InstalledExecutionManifest $read } catch { $allowed=$false }
    if($allowed -ne $case.allowed){throw 'Execution-level policy gate accepted or rejected the wrong real PE.'}
    if((Hash-File $file) -cne $before){throw 'Manifest reader changed the PE.'}
    $moved=$file+'.read-closed';[IO.File]::Move($file,$moved);[IO.File]::Move($moved,$file)
    $results+=@{name=$case.name;requestedExecutionLevel=$read.requestedExecutionLevel;uiAccess=$read.uiAccess;allowed=$allowed;unchanged=$true;handleReleased=$true;resourceType=$read.manifestResourceType;resourceId=$read.manifestResourceId;resourceBytes=$read.manifestBytes;manifestSha256=$read.manifestSha256}
  }
} finally { $provider.Dispose() }
if(Test-Path -LiteralPath $marker){throw 'A fixture executable ran instead of being read as data.'}
@{passed=$true;entrypointExecuted=$false;results=$results}|ConvertTo-Json -Depth 6 -Compress
`, 'utf8');
  const verifier = new URL('../scripts/verify-windows-release.ps1', import.meta.url);
  const { fileURLToPath } = await import('node:url');
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, '-Verifier', fileURLToPath(verifier), '-Directory', directory], { windowsHide: true, timeout: 30000, maxBuffer: 32768, encoding: 'utf8' });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.passed, true); assert.equal(result.entrypointExecuted, false);
  assert.deepEqual(result.results.map(row => [row.name, row.requestedExecutionLevel, row.uiAccess, row.allowed]), [
    ['highest', 'highestAvailable', false, true], ['required', 'requireAdministrator', false, false], ['invoker', 'asInvoker', false, false], ['ui-access', 'highestAvailable', true, false]
  ]);
  for (const row of result.results) {
    assert.equal(row.unchanged, true); assert.equal(row.handleReleased, true);
    assert.equal(row.resourceType, 24); assert.equal(row.resourceId, 1);
    assert.ok(row.resourceBytes > 20 && row.resourceBytes <= 65536); assert.match(row.manifestSha256, /^[a-f0-9]{64}$/);
  }
});


test('retired built-in skill files and neighboring paths are never approved package files', () => {
 for (const file of ['skills/planning/SKILL.md','skills/planning/CONTRACT-V2.md','skills/planning/references/evidence-preserving-execution.md','skills/autonomy/SKILL.md','skills/browser/SKILL.md','skills/job-search/SKILL.md','skills/planning/CONTRACT-V3.md','skills/planning/SKILL.md.bak','skills/unapproved/SKILL.md']) assert.equal(approvedWindowsPackageFile(file, '2.40.3'), false, file);
});

test('.104 retains only its selected .103 recovery note alongside the current release',()=>{
 for(const f of ['RELEASE-NOTES-2.39.103.md','RELEASE-NOTES-2.39.104.md'])assert.equal(approvedWindowsPackageFile(f,'2.39.104'),true,f);
 for(const f of ['RELEASE-NOTES-2.39.102.md','RELEASE-NOTES-2.39.105.md','RELEASE-NOTES-2.39.103.md.bak'])assert.equal(approvedWindowsPackageFile(f,'2.39.104'),false,f);
});

test('retained release notes derive only from exact numeric top-level builder files entries', () => {
  const config = [
    'extraResources:', '  - RELEASE-NOTES-9.8.0.md', 'files:',
    '  - RELEASE-NOTES-2.39.105.md', '  - "RELEASE-NOTES-2.39.106.md"',
    "  - 'RELEASE-NOTES-3.0.0.md'", '  - RELEASE-NOTES-2.39.*.md',
    '  - docs/private.md', '  - ../RELEASE-NOTES-2.39.104.md',
    '  - docs/RELEASE-NOTES-2.39.104.md', '  - RELEASE-NOTES-02.39.104.md',
    '  - !RELEASE-NOTES-2.39.104.md', '  - RELEASE-NOTES-2.39.105.md.bak',
    '  - RELEASE-NOTES-custom.md', 'win:', '  - RELEASE-NOTES-9.8.1.md',
  ].join('\n');
  assert.deepEqual(explicitWindowsReleaseNotes(config), [
    'RELEASE-NOTES-2.39.105.md', 'RELEASE-NOTES-2.39.106.md', 'RELEASE-NOTES-3.0.0.md',
  ]);
  for (const config of [null, '', 'files:\n  - lib/**/*\nwin:\n', 'files:\n  - "RELEASE-NOTES-2.39.105.md\'\nwin:\n'])
    assert.deepEqual(explicitWindowsReleaseNotes(config), []);
});
test('explicit retained note approval survives future version bumps without admitting arbitrary neighbors', () => {
  const notes = explicitWindowsReleaseNotes('files:\n  - RELEASE-NOTES-2.39.105.md\n  - RELEASE-NOTES-2.39.106.md\n  - RELEASE-NOTES-2.39.107.md\n  - RELEASE-NOTES-3.0.0.md\nwin:\n');
  for (const current of ['2.39.106', '2.39.107', '3.0.0']) {
    assert.equal(approvedExplicitWindowsReleaseNote('RELEASE-NOTES-2.39.105.md', current, notes), true);
    assert.equal(approvedExplicitWindowsReleaseNote('RELEASE-NOTES-2.39.106.md', current, notes), true);
    for (const file of ['RELEASE-NOTES-2.39.104.md','RELEASE-NOTES-4.0.0.md','RELEASE-NOTES-custom.md','docs/private.md','../RELEASE-NOTES-2.39.105.md'])
      assert.equal(approvedExplicitWindowsReleaseNote(file, current, notes), false, file);
  }
  assert.equal(approvedExplicitWindowsReleaseNote('RELEASE-NOTES-2.39.107.md', '2.39.106', notes), false);
  assert.equal(approvedExplicitWindowsReleaseNote('RELEASE-NOTES-3.0.0.md', '2.39.107', notes), false);
  for (const bad of [null, '2.39', '2.39.106-beta', '../2.39.106'])
    assert.equal(approvedExplicitWindowsReleaseNote('RELEASE-NOTES-2.39.105.md', bad, notes), false);
  assert.equal(approvedWindowsPackageFile('RELEASE-NOTES-2.39.105.md','2.39.106'), true);
  assert.equal(approvedWindowsPackageFile('RELEASE-NOTES-2.39.107.md','2.39.106'), false);
});

test('disposable native fixture excludes foreign restart origin without altering parent environment', async () => {
  const { disposableDesktopFixtureEnvironment } = await import('../scripts/windows-release-inputs.mjs');
  const source = { BLACKICE_RESTART_ORIGIN: 'a'.repeat(64), ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', PATH: 'fixture-path', APPDATA: 'fixture-appdata', KEEP: 'yes' };
  const prior = { ...source };
  const result = disposableDesktopFixtureEnvironment(source);
  assert.deepEqual(result, { PATH: 'fixture-path', APPDATA: 'fixture-appdata', KEEP: 'yes' });
  assert.deepEqual(source, prior);
  assert.notEqual(result, source);
});

test('diagnostic installer mode retains failed qualification and never supplies a passing receipt', async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-diagnostic-'));
  try {
    await fs.mkdir(path.join(directory, 'verification'));
    const receiptPath = 'verification/qualification.json';
    const original = JSON.parse(await fs.readFile(new URL('../verification/qualification-2.40.1.json', import.meta.url)));
    const options = {directory, receiptPath, version:original.version, appFingerprint:original.appFingerprint, tracked:new Set([receiptPath]), artifactSha256:original.artifact.sha256};
    const save = value => fs.writeFile(path.join(directory, receiptPath), JSON.stringify(value));
    await save(original);
    await assert.rejects(readWindowsSourceTestReceipt(options));
    const result = await readWindowsSourceTestReceipt({...options, diagnosticOnly:true});
    assert.equal(result.publicReleaseReady, false);
    assert.deepEqual(result.qualification, original);
    assert.equal(result.tests.failed, 1);
    assert.match(result.receiptSha256, /^[a-f0-9]{64}$/);
    for (const override of [{version:'0.0.0'}, {appFingerprint:'0'.repeat(64)}, {artifactSha256:'0'.repeat(64)}, {tracked:new Set()}]) {
      await assert.rejects(readWindowsSourceTestReceipt({...options, diagnosticOnly:true, ...override}));
    }
    for (const change of [{passed:true}, {fullSuiteSource:'missing'}, {testLogSha256:'missing'}, {tests:{...original.tests,failed:0}}, {tests:{...original.tests,total:1}}]) {
      await save({...original,...change});
      await assert.rejects(readWindowsSourceTestReceipt({...options, diagnosticOnly:true}));
    }
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});

test('diagnostic hosted mode returns before generating release readiness; default remains strict', async () => {
  const script = await fs.readFile(new URL('../scripts/verify-windows-release.ps1', import.meta.url),'utf8');
  const workflow = await fs.readFile(new URL('../.github/workflows/verify-windows-release.yml', import.meta.url),'utf8');
  const diagnostic = script.slice(script.indexOf('if ($DiagnosticOnly) {'),script.indexOf('$receipts=@{'));
  assert.match(diagnostic,/publicReleaseReady=\$false/);
  assert.match(diagnostic,/sourceQualification=\$prior/);
  assert.match(diagnostic,/return/);
  assert.doesNotMatch(diagnostic,/release-check\.mjs|blackice-release-receipts\.json/);
  assert.match(workflow,/diagnostic_only:[\s\S]*?default: false/);
  assert.match(workflow,/blackice-installer-diagnostic\.json/);
});
