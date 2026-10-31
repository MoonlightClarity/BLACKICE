import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createDistributionManifest, verifyDistribution, validateArchiveListing, desktopRuntimeModules, MANIFEST_FILE } from '../scripts/distribution-manifest.mjs';

const execute = promisify(execFile), script = fileURLToPath(new URL('../scripts/Install-Relay.ps1', import.meta.url));
let base;
async function temporary(t) { const directory = await fs.mkdtemp(path.join(tmpdir(), 'relay-distribution-test-')); t.after(async () => { assert.match(path.basename(directory), /^relay-distribution-test-/); await fs.rm(directory, { recursive: true, force: true }); }); return directory; }
async function files(directory, version = '2.5.0') {
  await fs.mkdir(path.join(directory, 'resources/app'), { recursive: true });
  await fs.writeFile(path.join(directory, 'resources/app/package.json'), JSON.stringify({ name: 'relay-agent-harness', version }));
  await fs.writeFile(path.join(directory, 'Relay.exe'), 'disposable binary bytes');
  await fs.writeFile(path.join(directory, 'Read me.txt'), 'Disposable installation fixture, never launched.');
  await fs.copyFile(script, path.join(directory, 'Install-Relay.ps1'));
}
before(async () => {
  if (process.platform !== 'win32') return;
  base = await fs.mkdtemp(path.join(tmpdir(), 'relay-distribution-test-base-'));
  const compile = path.join(base, 'compile.ps1');
  await fs.writeFile(compile, `param([string]$Output,[string]$Release)
$code = @"
using System.Reflection;
[assembly: AssemblyVersion("$Release.0")]
[assembly: AssemblyFileVersion("$Release.0")]
[assembly: AssemblyInformationalVersion("$Release")]
public static class DisposableInstallerFixture { public static void Main() {} }
"@
Add-Type -TypeDefinition $code -OutputAssembly $Output -OutputType ConsoleApplication
`);
  for (const version of ['2.5.0', '2.5.1']) {
    const directory = path.join(base, version); await files(directory, version); await fs.rm(path.join(directory, 'Relay.exe'));
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', compile, '-Output', path.join(directory, 'Relay.exe'), '-Release', version], { windowsHide: true, timeout: 20000 });
    await createDistributionManifest(directory, version);
  }
});
after(async () => { if (base) { assert.match(path.basename(base), /^relay-distribution-test-base-/); await fs.rm(base, { recursive: true, force: true }); } });
async function installation(t, version = '2.5.0') {
  const directory = await temporary(t), source = path.join(directory, 'bundle'), installRoot = path.join(directory, 'Programs/Relay'), desktopPath = path.join(directory, 'Desktop'), marker = path.join(directory, 'no-user-runtime.json');
  await fs.cp(path.join(base, version), source, { recursive: true }); await fs.mkdir(desktopPath);
  const args = ['-Source', source, '-InstallRoot', installRoot, '-DesktopPath', desktopPath, '-RuntimeMarker', marker, '-NoLaunch'];
  const run = extra => execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, ...args, ...(extra || [])], { windowsHide: true, timeout: 20000 });
  return { directory, source, installRoot, desktopPath, marker, run, args };
}
async function waitForFile(file) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { try { await fs.stat(file); return; } catch (error) { if (error.code !== 'ENOENT') throw error; } await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('The disposable installer did not reach its synchronization point.');
}

test('desktop runtime inventory and installer globs cover new helpers without shipping tests or build-only code', async t => {
  const directory = await temporary(t), included = ['main.mjs', 'startup.mjs', 'restart.mjs', 'runtime-record.mjs', 'preload.cjs', 'future/worker.mjs', 'future/bridge.cjs'];
  const excluded = ['build-icon.mjs', 'future/worker.test.mjs', 'worker.mjs.currents-backup-fixture', 'old.currents-backup-fixture/worker.mjs', 'electron-builder.yml'];
  for (const name of [...included, ...excluded]) { const file = path.join(directory, 'desktop', name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'disposable fixture'); }
  assert.deepEqual(await desktopRuntimeModules(directory), included.map(name => `desktop/${name}`).sort());
  const config = (await fs.readFile(new URL('../desktop/electron-builder.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const patterns = config.slice(config.indexOf('files:\n'), config.indexOf('\nwin:')).split(/\r?\n/).map(line => line.replace(/^\s*-\s*/, '').replace(/^'|'$/g, ''));
  for (const pattern of ['desktop/**/*.mjs', 'desktop/**/*.cjs', '!desktop/build-icon.mjs', '!**/*.test.mjs', '!**/*.currents-backup-*']) assert.ok(patterns.includes(pattern), `Installer must retain ${pattern}`);
});

test('distribution hashes cover all executable and runtime files and reject tampering or unlisted files', async t => {
  const directory = await temporary(t); await files(directory); const manifest = await createDistributionManifest(directory, '2.5.0');
  assert.deepEqual(manifest.files.map(file => file.path), ['Install-Relay.ps1', 'Read me.txt', 'Relay.exe', 'resources/app/package.json']);
  assert.equal((await verifyDistribution(directory)).version, '2.5.0');
  await fs.writeFile(path.join(directory, 'Relay.exe'), 'modified binary'); await assert.rejects(verifyDistribution(directory), /failed verification/);
  await fs.writeFile(path.join(directory, 'Relay.exe'), 'disposable binary bytes'); await fs.writeFile(path.join(directory, 'unlisted.txt'), 'unexpected'); await assert.rejects(verifyDistribution(directory), /file list/);
});
test('archive validation rejects missing files, duplicate entries and path traversal before extraction', async t => {
  const directory = await temporary(t); await files(directory); const manifest = await createDistributionManifest(directory, '2.5.0');
  const listing = [MANIFEST_FILE, ...manifest.files.map(file => file.path)].map(file => `Relay-Desktop-Windows/${file}`).join('\n');
  validateArchiveListing(listing, manifest);
  for (const invalid of [listing.replace('Relay.exe', 'Other.exe'), listing + '\nRelay-Desktop-Windows/Relay.exe', listing + '\nRelay-Desktop-Windows/../escaped', listing + '\nC:/escaped']) assert.throws(() => validateArchiveListing(invalid, manifest));
});

test('installer verifies a staged real PE version, creates the exact stable shortcut and preserves a prior install on update', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await installation(t); const first = JSON.parse((await fixture.run()).stdout.trim());
  assert.equal(first.installed, true); assert.equal(first.version, '2.5.0'); assert.equal(first.installRoot, fixture.installRoot);
  assert.equal(JSON.parse(await fs.readFile(path.join(fixture.installRoot, 'relay-install.json'), 'utf8')).version, '2.5.0');
  const linkCheck = path.join(fixture.directory, 'link.ps1'); await fs.writeFile(linkCheck, `param($File) (New-Object -ComObject WScript.Shell).CreateShortcut($File).TargetPath`);
  const target = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', linkCheck, '-File', path.join(fixture.desktopPath, 'Relay.lnk')], { windowsHide: true });
  assert.equal(target.stdout.trim(), path.join(fixture.installRoot, 'Relay.exe'));
  await fs.rm(fixture.source, { recursive: true }); await fs.cp(path.join(base, '2.5.1'), fixture.source, { recursive: true });
  const updated = JSON.parse((await fixture.run()).stdout.trim()); assert.equal(updated.version, '2.5.1'); assert.ok(updated.previousInstall);
  assert.equal(JSON.parse(await fs.readFile(path.join(updated.previousInstall, 'relay-install.json'), 'utf8')).version, '2.5.0');
  assert.equal(JSON.parse(await fs.readFile(path.join(fixture.installRoot, 'relay-install.json'), 'utf8')).version, '2.5.1');
  assert.deepEqual((await fs.readdir(fixture.desktopPath)).sort(), ['Relay.lnk']);
  assert.ok((await fs.readdir(path.join(path.dirname(fixture.installRoot), 'Relay-shortcut-backups'))).every(name => name.endsWith('.lnk.backup')));
});
test('installer refuses corrupt files or mismatched executable versions before changing an existing install', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await installation(t); await fixture.run(); const before = await fs.readFile(path.join(fixture.installRoot, 'relay-install.json'), 'utf8');
  await fs.writeFile(path.join(fixture.source, 'Read me.txt'), 'corrupt'); await assert.rejects(fixture.run(), /checksum/);
  assert.equal(await fs.readFile(path.join(fixture.installRoot, 'relay-install.json'), 'utf8'), before);
  await fs.rm(fixture.source, { recursive: true }); await fs.cp(path.join(base, '2.5.0'), fixture.source, { recursive: true });
  await fs.writeFile(path.join(fixture.source, 'resources/app/package.json'), JSON.stringify({ name: 'relay-agent-harness', version: '2.5.1' })); await fs.rm(path.join(fixture.source, MANIFEST_FILE)); await createDistributionManifest(fixture.source, '2.5.1');
  await assert.rejects(fixture.run(), /versions do not match/); assert.equal(await fs.readFile(path.join(fixture.installRoot, 'relay-install.json'), 'utf8'), before);
});

test('installer refuses accidental downgrades before shutdown or mutation but supports deliberate rollback and same-version reinstall', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await installation(t, '2.5.1'); await fixture.run(); const before = await fs.readFile(path.join(fixture.installRoot, 'relay-install.json'), 'utf8');
  await fs.rm(fixture.source, { recursive: true }); await fs.cp(path.join(base, '2.5.0'), fixture.source, { recursive: true });
  await assert.rejects(fixture.run(), /older\s+than\s+the\s+installed\s+Relay\s+version/); assert.equal(await fs.readFile(path.join(fixture.installRoot, 'relay-install.json'), 'utf8'), before);
  assert.ok((await fs.readdir(path.dirname(fixture.installRoot))).every(file => !file.includes('.stage-')));
  const rollback = JSON.parse((await fixture.run(['-AllowDowngrade'])).stdout.trim()); assert.equal(rollback.version, '2.5.0'); assert.ok(rollback.previousInstall);
  const reinstalled = JSON.parse((await fixture.run()).stdout.trim()); assert.equal(reinstalled.version, '2.5.0'); assert.ok(reinstalled.previousInstall);
});

test('publisher-required local installation refuses unsigned executables without creating an install', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await installation(t); await assert.rejects(fixture.run(['-RequirePublisher', 'Disposable Test Publisher']), /trusted\s+signature\s+from\s+the\s+required\s+publisher/); await assert.rejects(fs.stat(fixture.installRoot), { code: 'ENOENT' });
});

test('two real installer processes serialize the same normalized installation root before version checks and leave busy targets untouched', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await installation(t), ready = path.join(fixture.directory, 'first-reading-version'), release = path.join(fixture.directory, 'release-first'), harness = path.join(fixture.directory, 'held-installer.ps1'); await fixture.run();
  const before = await fs.readFile(path.join(fixture.installRoot, 'relay-install.json'), 'utf8'), linkBefore = await fs.readFile(path.join(fixture.desktopPath, 'Relay.lnk'));
  await fs.rm(fixture.source, { recursive: true }); await fs.cp(path.join(base, '2.5.1'), fixture.source, { recursive: true });
  await fs.writeFile(harness, `param($FixtureInstaller,$FixtureSource,$FixtureInstall,$FixtureDesktop,$FixtureMarker,$FixtureReady,$FixtureRelease)
. $FixtureInstaller
$script:originalInstalledCheck = \${function:Test-RelayInstalledFolder}
function Test-RelayInstalledFolder {
  param($Directory)
  [IO.File]::WriteAllText($FixtureReady,'The first installer owns the installation before reading its version.')
  $deadline=[datetime]::UtcNow.AddSeconds(18)
  while(-not (Test-Path -LiteralPath $FixtureRelease)){if([datetime]::UtcNow -gt $deadline){throw 'Disposable installer synchronization timed out.'};Start-Sleep -Milliseconds 25}
  & $script:originalInstalledCheck $Directory
}
Invoke-RelayInstallation -Source $FixtureSource -InstallRoot $FixtureInstall -DesktopPath $FixtureDesktop -RuntimeMarker $FixtureMarker -NoLaunch | ConvertTo-Json -Compress
`);
  const first = execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', harness, '-FixtureInstaller', script, '-FixtureSource', fixture.source, '-FixtureInstall', fixture.installRoot, '-FixtureDesktop', fixture.desktopPath, '-FixtureMarker', fixture.marker, '-FixtureReady', ready, '-FixtureRelease', release], { windowsHide: true, timeout: 25000 }); first.catch(() => {});
  try {
    await waitForFile(ready);
    const alias = fixture.installRoot.toLowerCase() + '\\..\\Relay\\', args = fixture.args.map((argument, index, array) => array[index - 1] === '-InstallRoot' ? alias : argument);
    await assert.rejects(execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { windowsHide: true, timeout: 10000 }), /Another\s+Relay\s+installer\s+is\s+already\s+updating\s+this\s+installation/);
    assert.equal(await fs.readFile(path.join(fixture.installRoot, 'relay-install.json'), 'utf8'), before); assert.deepEqual(await fs.readFile(path.join(fixture.desktopPath, 'Relay.lnk')), linkBefore); assert.ok((await fs.readdir(path.dirname(fixture.installRoot))).every(name => !name.includes('.stage-')));
    const otherDesktop = path.join(fixture.directory, 'OtherDesktop'), otherRoot = path.join(fixture.directory, 'OtherPrograms', 'Relay'); await fs.mkdir(otherDesktop);
    const otherArgs = fixture.args.map((argument, index, array) => array[index - 1] === '-InstallRoot' ? otherRoot : array[index - 1] === '-DesktopPath' ? otherDesktop : argument);
    const independent = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, ...otherArgs], { windowsHide: true, timeout: 10000 }); assert.equal(JSON.parse(independent.stdout.trim()).installed, true, 'a different installation root does not share the lock');
  } finally { await fs.writeFile(release, 'continue'); await first.catch(() => {}); }
  assert.equal(JSON.parse((await first).stdout.trim()).version, '2.5.1'); const retried = JSON.parse((await fixture.run()).stdout.trim()); assert.equal(retried.installed, true); assert.equal(retried.version, '2.5.1');
});

test('an installer releases its shared lock after validation failure while its process remains alive', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await installation(t), ready = path.join(fixture.directory, 'failed-installer-still-alive'), release = path.join(fixture.directory, 'release-failed-installer'), harness = path.join(fixture.directory, 'failed-held-installer.ps1');
  await fs.writeFile(harness, `param($FixtureInstaller,$FixtureSource,$FixtureInstall,$FixtureDesktop,$FixtureMarker,$FixtureReady,$FixtureRelease)
. $FixtureInstaller
function Assert-RelayPublisher { throw 'Disposable publisher validation failed.' }
$failed=$false
try { Invoke-RelayInstallation -Source $FixtureSource -InstallRoot $FixtureInstall -DesktopPath $FixtureDesktop -RuntimeMarker $FixtureMarker -NoLaunch }
catch { if($_.Exception.Message -notmatch 'Disposable publisher validation failed'){throw};$failed=$true }
if(-not $failed){throw 'The disposable installer did not fail validation.'}
[IO.File]::WriteAllText($FixtureReady,'The failed installer remains alive after releasing its lock.')
$deadline=[datetime]::UtcNow.AddSeconds(18)
while(-not (Test-Path -LiteralPath $FixtureRelease)){if([datetime]::UtcNow -gt $deadline){throw 'Disposable installer synchronization timed out.'};Start-Sleep -Milliseconds 25}
`);
  const failed = execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', harness, '-FixtureInstaller', script, '-FixtureSource', fixture.source, '-FixtureInstall', fixture.installRoot, '-FixtureDesktop', fixture.desktopPath, '-FixtureMarker', fixture.marker, '-FixtureReady', ready, '-FixtureRelease', release], { windowsHide: true, timeout: 25000 }); failed.catch(() => {});
  try { await waitForFile(ready); const recovered = JSON.parse((await fixture.run()).stdout.trim()); assert.equal(recovered.installed, true); assert.equal(recovered.version, '2.5.0'); }
  finally { await fs.writeFile(release, 'continue'); await failed; }
});
test('failed shortcut creation rolls the application and receipt back to the previous version', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await installation(t); await fixture.run(); const before = await fs.readFile(path.join(fixture.installRoot, 'relay-install.json'), 'utf8'), linkBefore = await fs.readFile(path.join(fixture.desktopPath, 'Relay.lnk'));
  await fs.rm(fixture.source, { recursive: true }); await fs.cp(path.join(base, '2.5.1'), fixture.source, { recursive: true });
  const harness = path.join(fixture.directory, 'rollback.ps1'); await fs.writeFile(harness, `param($FixtureInstaller,$FixtureSource,$FixtureInstall,$FixtureDesktop,$FixtureMarker)
. $FixtureInstaller
function New-RelayShortcut { throw 'Disposable shortcut failure' }
Invoke-RelayInstallation -Source $FixtureSource -InstallRoot $FixtureInstall -DesktopPath $FixtureDesktop -RuntimeMarker $FixtureMarker -NoLaunch
`);
  await assert.rejects(execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', harness, '-FixtureInstaller', script, '-FixtureSource', fixture.source, '-FixtureInstall', fixture.installRoot, '-FixtureDesktop', fixture.desktopPath, '-FixtureMarker', fixture.marker], { windowsHide: true, timeout: 20000 }), /Disposable shortcut failure/);
  assert.equal(await fs.readFile(path.join(fixture.installRoot, 'relay-install.json'), 'utf8'), before); assert.deepEqual(await fs.readFile(path.join(fixture.desktopPath, 'Relay.lnk')), linkBefore);
  assert.ok((await fs.readdir(path.dirname(fixture.installRoot))).every(file => !file.includes('.stage-')));
});
test('installer rejects overlapping roots, unrelated destination data and junctions without modifying them', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await installation(t); await fs.mkdir(fixture.installRoot, { recursive: true }); const sentinel = path.join(fixture.installRoot, 'unrelated.txt'); await fs.writeFile(sentinel, 'preserve');
  await assert.rejects(fixture.run(), /unrelated files/); assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserve');
  await fs.rm(fixture.installRoot, { recursive: true });
  const outside = path.join(fixture.directory, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'sentinel.txt'), 'outside untouched'); const junction = path.join(fixture.source, 'external'); await fs.symlink(outside, junction, 'junction');
  try { await assert.rejects(fixture.run(), /link or junction/); assert.equal(await fs.readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside untouched'); }
  finally { await fs.unlink(junction); }
  const overlapping = fixture.args.map((argument,index,array)=>array[index-1]==='-InstallRoot'?fixture.source:argument);
  await assert.rejects(execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, ...overlapping], { windowsHide: true, timeout: 20000 }), /separate folders/);
});

test('graceful update shutdown requires matching executable, process creation, local listener and Relay health', { skip: process.platform !== 'win32' }, async t => {
  const directory = await temporary(t), harness = path.join(directory, 'shutdown-fixture.ps1'), marker = path.join(directory, 'fixture-runtime.json');
  await fs.writeFile(harness, `param($FixtureInstaller,$FixtureMarker)
. $FixtureInstaller
$script:shutdowns=0; $script:waits=0; $script:listener=440; $script:product='relay-agent-harness'
$script:fakeHandle=New-Object PSObject
$script:fakeHandle | Add-Member ScriptMethod WaitForExit { param($milliseconds) $script:waits++; return $true }
function Get-RelayRuntimeProcess { return [pscustomobject]@{ExecutablePath='C:\\Relay\\Relay.exe';CreationDate=[datetime]'2026-01-02T03:04:05Z';Handle=$script:fakeHandle} }
function Get-RelayListenerOwners { return @($script:listener) }
function Invoke-RestMethod { param($Uri) if($Uri.EndsWith('/health')){return @{app=$script:product;ok=$true}};if($Uri.EndsWith('/api/shutdown')){$script:shutdowns++;return @{ok=$true}};throw 'Unexpected request' }
function Invoke-WebRequest { return $null }
$record=@{pid=440;executable='C:\\Relay\\Relay.exe';startedAt='2026-01-02T03:04:05Z';url='http://127.0.0.1:54321';version='2.5.0';at='2026-01-02T03:04:06Z'}
foreach($mode in @('wrong-executable','reused-pid','remote-url','wrong-listener','wrong-product')){
 $testRecord=$record.Clone();$script:listener=440;$script:product='relay-agent-harness'
 switch($mode){'wrong-executable'{$testRecord.executable='C:\\Other\\Relay.exe'};'reused-pid'{$testRecord.startedAt='2025-01-01T00:00:00Z'};'remote-url'{$testRecord.url='http://example.invalid:54321'};'wrong-listener'{$script:listener=999};'wrong-product'{$script:product='unrelated'}}
 Write-RelayJson $FixtureMarker $testRecord
 $refused=$false;try{Stop-VerifiedRelay $FixtureMarker}catch{$refused=$true};if(-not $refused){throw "Failed to refuse $mode"}
 if($script:shutdowns -ne 0 -or $script:waits -ne 0){throw 'An unverified process was touched'}
}
$script:listener=440;$script:product='relay-agent-harness';Write-RelayJson $FixtureMarker $record;Stop-VerifiedRelay $FixtureMarker
if($script:shutdowns -ne 1 -or $script:waits -ne 1){throw 'The verified owned process did not close gracefully'}
@{shutdowns=$script:shutdowns;waits=$script:waits}|ConvertTo-Json -Compress
`);
  const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', harness, '-FixtureInstaller', script, '-FixtureMarker', marker], { windowsHide: true, timeout: 10000 });
  assert.deepEqual(JSON.parse(result.stdout.trim()), { shutdowns: 1, waits: 1 });
});
