import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const packages = ['mingw-w64-ucrt-x86_64-freerdp 3.32.2-1', 'mingw-w64-ucrt-x86_64-openssl 3.6.5-1'];
const artifact = (name, body) => ({ file: name.replace(' ', '-') + '-any.pkg.tar.zst', sha256: sha(body) });
const lockFixture = () => ({
  schema: 1,
  bootstrap: { url: 'https://repo.msys2.org/distrib/x86_64/msys2-base-x86_64-20260927.tar.xz', sha256: 'a'.repeat(64) },
  freerdp: { name: packages[0].split(' ')[0], version: '3.32.2-1', sha256: sha('client') },
  packages,
  packageArtifacts: [artifact(packages[0], 'client'), artifact(packages[1], 'dependency')],
});

async function check(t, { mutate = () => {}, operation = 'lock', inventory = packages, corrupt = false, missing = false, committed = false } = {}) {
  const temp = await mkdtemp(path.join(tmpdir(), 'blackice-freerdp-lock-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const lock = lockFixture();
  mutate(lock);
  await writeFile(path.join(temp, 'lock.json'), JSON.stringify(lock));
  await writeFile(path.join(temp, 'inventory.json'), JSON.stringify(inventory));
  await writeFile(path.join(temp, lock.packageArtifacts[0].file), 'client');
  if (!missing) await writeFile(path.join(temp, lockFixture().packageArtifacts[1].file), corrupt ? 'changed dependency' : 'dependency');
  const script = path.join(temp, 'check.ps1');
  await writeFile(script, `param([string]$Repo,[string]$Fixture,[string]$Operation,[switch]$Committed)
$ErrorActionPreference='Stop'
. (Join-Path $Repo 'scripts/workbench-freerdp-lock.ps1')
try {
  $file=Join-Path $Fixture 'lock.json'
  if($Committed){$file=Join-Path $Repo 'docs/workbench-freerdp-dependencies.lock.json'}
  $lock=Read-WorkbenchFreeRdpLock $file
  if($Operation -eq 'artifacts'){Assert-WorkbenchFreeRdpArtifacts $lock $Fixture}
  if($Operation -eq 'inventory'){
    $inventory=Get-Content -LiteralPath (Join-Path $Fixture 'inventory.json') -Raw|ConvertFrom-Json
    Assert-WorkbenchFreeRdpInventory $lock $inventory
  }
  Write-Output 'VALID'
} catch {Write-Output $_.Exception.Message;exit 1}
`);
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Repo', root, '-Fixture', temp, '-Operation', operation];
  if (committed) args.push('-Committed');
  // PowerShell 7's inherited module search path can hide Windows PowerShell 5.1's built-ins.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  return spawnSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 15000, env });
}

test('committed FreeRDP lock has a complete one-to-one package/artifact inventory', { skip: process.platform !== 'win32' }, async t => {
  const result = await check(t, { committed: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('all pinned package archives are verified, including transitive dependencies', { skip: process.platform !== 'win32' }, async t => {
  const good = await check(t, { operation: 'artifacts' });
  assert.equal(good.status, 0, good.stdout + good.stderr);
  const corrupt = await check(t, { operation: 'artifacts', corrupt: true });
  assert.equal(corrupt.status, 1);
  assert.match(corrupt.stdout, /SHA-256 mismatch.*openssl/);
  const missing = await check(t, { operation: 'artifacts', missing: true });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /Missing pinned artifact.*openssl/);
});

test('unchanged client version cannot mask transitive version drift or an extra installed package', { skip: process.platform !== 'win32' }, async t => {
  for (const inventory of [[packages[0], 'mingw-w64-ucrt-x86_64-openssl 9.0-1'], [...packages, 'mingw-w64-ucrt-x86_64-extra 1.0-1']]) {
    const result = await check(t, { operation: 'inventory', inventory });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /inventory differs/);
  }
  const exact = await check(t, { operation: 'inventory', inventory: ['bash 5.3-1', ...packages].reverse() });
  assert.equal(exact.status, 0, exact.stdout + exact.stderr);
});

test('lock refuses unsafe filenames, duplicate inventory, and unpinned packages before installing', { skip: process.platform !== 'win32' }, async t => {
  for (const mutate of [
    lock => { lock.packageArtifacts[1].file = '../outside.pkg.tar.zst'; },
    lock => { lock.packageArtifacts[1].sha256 = 'invalid'; },
    lock => { lock.packages[1] = packages[0]; },
    lock => { lock.packages[1] = 'mingw-w64-ucrt-x86_64-missing 1.0-1'; },
  ]) {
    const result = await check(t, { mutate });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /Invalid|Duplicate|no pinned artifact/);
  }
});

test('FreeRDP setup installs the committed archives without refreshing a floating package repository', async () => {
  const source = await readFile(path.join(root, 'scripts/setup-workbench-freerdp.ps1'), 'utf8');
  assert.doesNotMatch(source, /pacman[^\r\n]*\s-S[y\s]/);
  assert.match(source, /Assert-WorkbenchFreeRdpArtifacts \$lock \$cache[\s\S]*pacman --noconfirm --needed -U/);
  assert.match(source, /Assert-WorkbenchFreeRdpInventory \$lock \$inventory/);
});
