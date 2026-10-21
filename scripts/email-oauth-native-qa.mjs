#!/usr/bin/env node
/** Native email acceptance. All grants, profiles and mailbox messages are owned fixtures. */
import assert from 'node:assert/strict';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appFingerprint } from './release-check.mjs';
import { captureSourceFiles } from './install-background-update.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export const EMAIL_OAUTH_NATIVE_QA_SOURCES = Object.freeze([
  'package.json', 'lib/email-oauth.mjs', 'lib/agent-email.mjs', 'lib/email-tools.mjs',
  'scripts/email-oauth-token.mjs', 'scripts/email-oauth-native-qa.mjs',
  'tests/fixtures/email-oauth-native.mjs',
]);
export const EMAIL_OAUTH_NATIVE_QA_CHECKS = Object.freeze([
  'native Electron uses an owned disposable profile, encrypted storage and no BrowserWindow',
  'the actual Himalaya 2.2.1 binary exposes the read interface and Gmail and Graph backends',
  'the actual CLI parses generated Gmail configuration without requesting an access token',
  'the actual CLI parses generated Graph configuration without requesting an access token',
  'an owned loopback OAuth fixture verifies PKCE, account identity and a read-only grant',
  'the actual Electron executable runs the token helper with child-only credentials and rejects a missing token',
  'native encrypted credentials reopen and refresh once without another interactive sign-in',
  'the actual CLI lists the owned local Maildir message',
  'the actual CLI searches and reads the owned message without changing its flags',
  'draft creation writes only an owned local unsent file and starts no CLI command',
  'only owned fixtures are used and credentials stay out of public state, configuration and logs',
  'owned email stores, callback listeners and fixture servers stop without forced cleanup',
]);

export function parseEmailOAuthNativeQAArguments(argv) {
  const options = { candidate: ROOT, out: path.resolve(ROOT, '..', 'qa-email-native'), timeoutMs: 150000 };
  const names = { '--candidate': 'candidate', '--out': 'out', '--electron': 'electron', '--himalaya': 'himalaya', '--timeout-ms': 'timeoutMs' };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const key = names[argv[index]];
    if (!key || seen.has(key) || !argv[index + 1]) throw new Error('Use --candidate, --out, --electron, --himalaya and --timeout-ms once each with values.');
    seen.add(key); options[key] = key === 'timeoutMs' ? Number(argv[++index]) : path.resolve(argv[++index]);
  }
  if (!options.himalaya) throw new Error('Use --himalaya with the installed Himalaya 2.2.1 executable.');
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 45000 || options.timeoutMs > 180000) throw new Error('Use a bounded timeout from 45000 to 180000 milliseconds.');
  return options;
}

async function fileHash(filename) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex');
}

export async function runEmailOAuthNativeQA(options) {
  if (process.platform !== 'win32') throw new Error('This acceptance requires the actual Windows Electron and Himalaya runtimes.');
  const candidate = path.resolve(options.candidate), out = path.resolve(options.out);
  const executable = options.electron || path.join(candidate, 'node_modules', 'electron', 'dist', 'electron.exe');
  const himalaya = path.resolve(options.himalaya);
  for (const filename of [executable, himalaya]) assert.ok((await fs.stat(filename)).isFile(), 'Use existing runtime executables.');
  await fs.mkdir(out, { recursive: true });
  const nonce = randomUUID(), profile = path.join(out, 'owned-profile-' + nonce), nativeFile = path.join(out, 'native-email-result-' + nonce + '.json');
  await fs.mkdir(profile, { recursive: false });
  const started = Date.now(), version = JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8')).version;
  const report = {
    schema: 1, candidate, version, platform: process.platform, startedAt: new Date(started).toISOString(),
    appFingerprintBefore: null, appFingerprintAfter: null, sourceHashesBefore: {}, sourceHashesAfter: {}, unchangedDuringChecks: false,
    runtime: { electron: executable, himalaya, electronHashBefore: null, electronHashAfter: null, himalayaHashBefore: null, himalayaHashAfter: null, unchanged: false },
    checks: [], cleanup: false, forcedCleanup: false, providerTurnsRequested: 0, providerMailboxConnected: false,
    providerNetworkTested: false, realAccountLogin: false, messageDeliveryAttempted: false,
    profile: { disposable: true, custom: true }, errors: [],
    limitation: 'Native acceptance covers managed configuration parsing, Electron token delivery, encrypted store reopen and local Maildir operations. It does not verify Gmail or Graph provider transport, real account consent or a live mailbox.',
  };
  let owned;
  try {
    report.appFingerprintBefore = await appFingerprint(candidate); report.sourceHashesBefore = await captureSourceFiles(candidate);
    for (const name of EMAIL_OAUTH_NATIVE_QA_SOURCES) assert.match(report.sourceHashesBefore[name] || '', /^[a-f0-9]{64}$/, 'Bind native email acceptance to ' + name);
    [report.runtime.electronHashBefore, report.runtime.himalayaHashBefore] = await Promise.all([fileHash(executable), fileHash(himalaya)]);
    const stdout = await fs.open(path.join(out, 'email-native.stdout.log'), 'w'), stderr = await fs.open(path.join(out, 'email-native.stderr.log'), 'w');
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.BLACKICE_EMAIL_ACCESS_TOKEN;
    const child = spawn(executable, [path.join(candidate, 'tests', 'fixtures', 'email-oauth-native.mjs'), '--profile-dir', profile, '--out', out, '--receipt', nativeFile, '--nonce', nonce, '--himalaya', himalaya], { cwd: candidate, env, shell: false, windowsHide: true, stdio: ['ignore', stdout.fd, stderr.fd] });
    owned = { child, exited: false, exit: null };
    owned.done = new Promise(resolve => {
      child.once('exit', (code, signal) => { owned.exited = true; owned.exit = { code, signal }; resolve(); });
      child.once('error', () => { owned.exited = true; owned.exit = { error: 'Owned native email fixture could not start.' }; resolve(); });
    });
    await Promise.all([stdout.close(), stderr.close()]); assert.ok(Number.isInteger(child.pid), 'Start only the owned native email process.');
    while (!owned.exited && Date.now() - started < options.timeoutMs) await wait(200);
    if (!owned.exited) throw new Error('The bounded native email acceptance timed out.');
    const native = JSON.parse(await fs.readFile(nativeFile, 'utf8'));
    assert.equal(native.nonce, nonce); assert.equal(native.pid, child.pid); assert.equal(native.profile, profile); assert.equal(native.platform, 'win32'); assert.ok(native.electronVersion);
    report.native = native; report.checks = native.checks; report.errors.push(...native.errors); report.forcedCleanup = native.forcedCleanup === true;
    for (const key of ['providerTurnsRequested', 'providerMailboxConnected', 'providerNetworkTested', 'realAccountLogin', 'messageDeliveryAttempted']) assert.equal(native[key], report[key], 'Keep native email acceptance confined to owned fixtures.');
    assert.equal(owned.exit.code, 0, 'The owned native email process exits normally.');
    assert.equal(native.cli.version, '2.2.1'); assert.equal(native.cli.executable, himalaya); assert.ok(native.cli.commands.length >= 12);
    assert.ok(native.cli.commands.every(command => Array.isArray(command.args) && command.exitCode === 0 && command.providerRequest === false));
    assert.equal(native.checks.length, EMAIL_OAUTH_NATIVE_QA_CHECKS.length); assert.ok(native.checks.every((entry, index) => entry.name === EMAIL_OAUTH_NATIVE_QA_CHECKS[index] && entry.passed === true));
    assert.equal(native.cleanup, true); assert.equal(native.forcedCleanup, false);
  } catch (cause) {
    report.errors.push(cause.message);
    if (!report.native && owned?.child.pid) try {
      const progress = JSON.parse(await fs.readFile(path.join(out, 'native-email-progress-' + nonce + '.json'), 'utf8'));
      if (progress.nonce === nonce && progress.pid === owned.child.pid && progress.profile === profile) report.nativeProgress = progress;
    } catch {}
  } finally {
    if (owned && !owned.exited) {
      report.forcedCleanup = true;
      const killer = spawn('taskkill.exe', ['/PID', String(owned.child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      await Promise.race([new Promise(resolve => { killer.once('exit', resolve); killer.once('error', resolve); }), wait(5000)]);
      await Promise.race([owned.done, wait(3000)]);
    }
    if (!owned || owned.exited) for (let attempt = 0; attempt < 20; attempt++) {
      try { await fs.rm(profile, { recursive: true, force: true }); report.cleanup = report.native?.cleanup === true && !report.native?.forcedCleanup; break; } catch { await wait(200); }
    }
    try {
      report.appFingerprintAfter = await appFingerprint(candidate); report.sourceHashesAfter = await captureSourceFiles(candidate);
      report.unchangedDuringChecks = report.appFingerprintBefore === report.appFingerprintAfter && JSON.stringify(report.sourceHashesBefore) === JSON.stringify(report.sourceHashesAfter);
      [report.runtime.electronHashAfter, report.runtime.himalayaHashAfter] = await Promise.all([fileHash(executable), fileHash(himalaya)]);
      report.runtime.unchanged = report.runtime.electronHashBefore === report.runtime.electronHashAfter && report.runtime.himalayaHashBefore === report.runtime.himalayaHashAfter;
      if (!report.unchangedDuringChecks || !report.runtime.unchanged) report.errors.push('Candidate email sources or native executables changed during acceptance.');
    } catch { report.errors.push('Could not bind final candidate email sources and native executables.'); }
    report.completedAt = new Date().toISOString(); report.durationMs = Date.now() - started;
    report.passed = report.errors.length === 0 && report.checks.length === EMAIL_OAUTH_NATIVE_QA_CHECKS.length && report.unchangedDuringChecks && report.runtime.unchanged && report.cleanup && !report.forcedCleanup;
    await fs.writeFile(path.join(out, 'email-oauth-native-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const report = await runEmailOAuthNativeQA(parseEmailOAuthNativeQAArguments(process.argv.slice(2))); console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, cleanup: report.cleanup, errors: report.errors })); if (!report.passed) process.exitCode = 1; }
  catch (cause) { console.error(cause.message); process.exitCode = 1; }
}
