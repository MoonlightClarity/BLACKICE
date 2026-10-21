#!/usr/bin/env node
/** Actual Electron network acceptance, with only newly owned profile/server resources. */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appFingerprint } from './release-check.mjs';
import { captureSourceFiles } from './install-background-update.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export const BROWSER_PROTECTION_QA_SOURCES = Object.freeze(['package.json', 'desktop/browser-driver.mjs', 'desktop/browser-router.mjs', 'desktop/browser-capture.mjs', 'lib/browser.mjs', 'lib/browser-protection.mjs', 'lib/vendor/ghostery-adblocker.mjs', 'lib/vendor/adblock-filter-data.json', 'scripts/browser-protection-qa.mjs', 'tests/fixtures/browser-protection-native.mjs']);
export const BROWSER_PROTECTION_QA_CHECKS = Object.freeze([
  'native Electron loads the pinned bundled network filters in an owned disposable profile',
  'ordinary page resources reach the owned server while ad and tracker requests are blocked',
  'blocked requests are attributed to the observed contained tab',
  'an explicit current-site exemption allows that site\'s blocked resources',
  'the exact-origin exemption does not disable protection on another tab origin',
  'a stale observed origin cannot create a site exemption after navigation',
  're-enabling current-site protection blocks ad and tracker requests again',
  'global disable is explicit and preserves per-site status',
  'global and exact-origin choices survive contained-driver shutdown and restore',
  'task agents cannot change browser protection',
  'restored protection blocks requests after global and site re-enablement',
  'page inspection and screenshot stay in hidden nonfocusable Electron tabs',
  'only owned loopback fixtures are contacted and no provider turn is requested',
  'owned tabs and server stop without forced cleanup',
]);

export function parseBrowserProtectionQAArguments(argv) {
  const options = { candidate: ROOT, out: path.resolve(ROOT, '..', 'qa-browser'), timeoutMs: 120000 }, names = { '--candidate': 'candidate', '--out': 'out', '--electron': 'electron', '--timeout-ms': 'timeoutMs' };
  for (let index = 0; index < argv.length; index++) { const key = names[argv[index]]; if (!key || !argv[index + 1]) throw new Error('Use --candidate, --out, --electron and --timeout-ms with values.'); options[key] = key === 'timeoutMs' ? Number(argv[++index]) : path.resolve(argv[++index]); }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 45000 || options.timeoutMs > 180000) throw new Error('Use a bounded timeout from 45000 to 180000 milliseconds.');
  return options;
}

export async function runBrowserProtectionQA(options) {
  if (process.platform !== 'win32') throw new Error('This acceptance script requires the actual Windows Electron runtime.');
  const candidate = path.resolve(options.candidate), out = path.resolve(options.out), executable = options.electron || path.join(candidate, 'node_modules', 'electron', 'dist', 'electron.exe');
  assert.ok((await fs.stat(executable)).isFile(), 'Use the candidate Electron executable.'); await fs.mkdir(out, { recursive: true });
  const nonce = randomUUID(), profile = path.join(out, 'owned-profile-' + nonce), nativeFile = path.join(out, 'native-browser-result-' + nonce + '.json'); await fs.mkdir(profile, { recursive: false });
  const started = Date.now(), version = JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8')).version;
  const report = { schema: 1, candidate, version, platform: process.platform, startedAt: new Date(started).toISOString(), appFingerprintBefore: null, appFingerprintAfter: null, sourceHashesBefore: {}, sourceHashesAfter: {}, unchangedDuringChecks: false, checks: [], cleanup: false, forcedCleanup: false, providerTurnsRequested: 0, profile: { disposable: true, custom: true }, errors: [] };
  let owned;
  try {
    report.appFingerprintBefore = await appFingerprint(candidate); report.sourceHashesBefore = await captureSourceFiles(candidate);
    for (const name of BROWSER_PROTECTION_QA_SOURCES) assert.match(report.sourceHashesBefore[name] || '', /^[a-f0-9]{64}$/, 'Bind native browser acceptance to ' + name);
    const stdout = await fs.open(path.join(out, 'browser-native.stdout.log'), 'w'), stderr = await fs.open(path.join(out, 'browser-native.stderr.log'), 'w');
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    const child = spawn(executable, [path.join(candidate, 'tests', 'fixtures', 'browser-protection-native.mjs'), '--profile-dir', profile, '--out', out, '--receipt', nativeFile, '--nonce', nonce], { cwd: candidate, env, windowsHide: true, stdio: ['ignore', stdout.fd, stderr.fd] });
    owned = { child, exited: false, exit: null }; owned.done = new Promise(resolve => { child.once('exit', (code, signal) => { owned.exited = true; owned.exit = { code, signal }; resolve(); }); child.once('error', cause => { owned.exited = true; owned.exit = { error: cause.message }; resolve(); }); });
    await Promise.all([stdout.close(), stderr.close()]); assert.ok(Number.isInteger(child.pid), 'Start only the owned native fixture process.');
    while (!owned.exited && Date.now() - started < options.timeoutMs) await wait(200);
    if (!owned.exited) throw new Error('The bounded native browser acceptance timed out.');
    const native = JSON.parse(await fs.readFile(nativeFile, 'utf8')); assert.equal(native.nonce, nonce); assert.equal(native.pid, child.pid); assert.equal(native.profile, profile); assert.equal(native.platform, 'win32'); assert.ok(native.electronVersion);
    report.native = native; report.checks = native.checks; report.errors.push(...native.errors); report.providerTurnsRequested = native.providerTurnsRequested; report.forcedCleanup = native.forcedCleanup === true;
    assert.equal(owned.exit.code, 0, 'The owned native browser process exits normally.');
    assert.equal(native.checks.length, BROWSER_PROTECTION_QA_CHECKS.length); assert.ok(native.checks.every((entry, index) => entry.name === BROWSER_PROTECTION_QA_CHECKS[index] && entry.passed === true)); assert.equal(native.cleanup, true); assert.equal(native.forcedCleanup, false); assert.equal(native.providerTurnsRequested, 0);
  } catch (cause) {
    report.errors.push(cause.message);
    if (!report.native && owned?.child.pid) try {
      const progress = JSON.parse(await fs.readFile(path.join(out, 'native-browser-progress-' + nonce + '.json'), 'utf8'));
      if (progress.nonce === nonce && progress.pid === owned.child.pid && progress.profile === profile) report.nativeProgress = progress;
    } catch {}
  }
  finally {
    if (owned && !owned.exited) {
      report.forcedCleanup = true; const killer = spawn('taskkill.exe', ['/PID', String(owned.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      await Promise.race([new Promise(resolve => { killer.once('exit', resolve); killer.once('error', resolve); }), wait(5000)]); await Promise.race([owned.done, wait(3000)]);
    }
    if (!owned || owned.exited) for (let attempt = 0; attempt < 20; attempt++) { try { await fs.rm(profile, { recursive: true, force: true }); report.cleanup = report.native?.cleanup === true && !report.native?.forcedCleanup; break; } catch { await wait(200); } }
    try {
      report.appFingerprintAfter = await appFingerprint(candidate); report.sourceHashesAfter = await captureSourceFiles(candidate);
      report.unchangedDuringChecks = report.appFingerprintBefore === report.appFingerprintAfter && JSON.stringify(report.sourceHashesBefore) === JSON.stringify(report.sourceHashesAfter);
      if (!report.unchangedDuringChecks) report.errors.push('Candidate application or acceptance sources changed during native browser checks.');
    } catch (cause) { report.errors.push('Could not bind final candidate sources: ' + cause.message); }
    report.completedAt = new Date().toISOString(); report.durationMs = Date.now() - started; report.passed = report.errors.length === 0 && report.checks.length === BROWSER_PROTECTION_QA_CHECKS.length && report.unchangedDuringChecks && report.cleanup && !report.forcedCleanup;
    await fs.writeFile(path.join(out, 'browser-protection-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const report = await runBrowserProtectionQA(parseBrowserProtectionQAArguments(process.argv.slice(2))); console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, cleanup: report.cleanup, errors: report.errors })); if (!report.passed) process.exitCode = 1; }
  catch (cause) { console.error(cause.message); process.exitCode = 1; }
}
