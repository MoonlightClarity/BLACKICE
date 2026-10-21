#!/usr/bin/env node
/** Native CLI acceptance. Every profile, code, client and TLS peer is an owned fixture. */
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
export const REMOTE_ACCESS_NATIVE_QA_SOURCES = Object.freeze([
  'package.json', 'desktop/main.mjs', 'desktop/lifecycle.mjs', 'server.mjs',
  'lib/remote-access-cli.mjs', 'lib/remote-access-auth.mjs', 'lib/remote-access.mjs',
  'lib/remote-access-gateway.mjs', 'lib/remote-access-tailscale.mjs', 'lib/remote-agent-api.mjs',
  'scripts/remote-access-cli.mjs', 'scripts/remote-access-native-qa.mjs',
  'tests/fixtures/remote-access-native.mjs', 'tests/fixtures/remote-access-native-client.mjs',
  'tests/fixtures/remote-access-native-tls.mjs', 'tests/fixtures/remote-transport.mjs',
]);
export const REMOTE_ACCESS_NATIVE_QA_CHECKS = Object.freeze([
  'an actual Electron host owns a disposable headless profile and loopback runtime',
  'native access help does not activate a window or change the running profile',
  'the native command creates a compatible browser code with fixed expirations',
  'a browser code cannot become an agent credential and still pairs through the browser endpoint',
  'the native command issues an agent code with explicit pinned permissions',
  'the actual Electron Node-mode helper redeems stdin once over validated fixture TLS without another approval',
  'the paired agent authenticates through the real scoped API and cannot enter host management',
  'replay and redemption scope overrides are rejected without widening the grant',
  'a default read-only agent cannot start tasks or edit plans',
  'private credential files support reuse of the directory and preserve an existing filename',
  'explicit revocation, code expiry and credential expiry are enforced by the gateway',
  'a disabled host rejects issuance without enabling exposure or activating the window',
  'no provider, real transport, real credential, or plaintext report secret is used',
  'all owned CLI processes, runtime and TLS listeners close without forced cleanup',
]);

export function parseRemoteAccessNativeQAArguments(argv) {
  const options = { candidate: ROOT, out: path.resolve(ROOT, '..', 'qa-remote-access'), timeoutMs: 180000 };
  const names = { '--candidate': 'candidate', '--out': 'out', '--electron': 'electron', '--timeout-ms': 'timeoutMs' }, seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const key = names[argv[index]];
    if (!key || seen.has(key) || !argv[index + 1]) throw Error('Use --candidate, --out, --electron and --timeout-ms once each with values.');
    seen.add(key); options[key] = key === 'timeoutMs' ? Number(argv[++index]) : path.resolve(argv[++index]);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 45000 || options.timeoutMs > 180000) throw Error('Use a timeout from 45000 to 180000 milliseconds.');
  const relative = path.relative(options.candidate, options.out);
  if (!relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw Error('Keep native access QA output outside the candidate source.');
  return options;
}

export function validateRemoteAccessNativeReceipt(value, expected) {
  assert.equal(value?.schema, 1); assert.equal(value.nonce, expected.nonce); assert.equal(value.pid, expected.pid); assert.equal(value.profile, expected.profile);
  assert.equal(value.platform, 'win32'); assert.equal(value.runtime?.executable, expected.executable); assert.ok(value.runtime.electronVersion);
  assert.equal(value.providerTurnsRequested, 0); assert.equal(value.realRemoteExposure, false); assert.equal(value.realCredentialIssued, false);
  assert.equal(value.fixtureOnly, true); assert.equal(value.transport?.tlsValidated, true); assert.equal(value.transport?.dnsMappedToOwnedLoopback, true); assert.equal(value.transport?.trustStoreChanged, false);
  assert.ok(value.commands?.length >= 10 && value.commands.every(command => Number.isSafeInteger(command.pid) && command.pid > 0 && command.executable === expected.executable && command.exited === true && command.exitCode === command.expectedExitCode && command.stdinLogged === false && command.stdoutLogged === false));
  assert.equal(value.checks?.length, REMOTE_ACCESS_NATIVE_QA_CHECKS.length);
  assert.ok(value.checks.every((check, index) => check.name === REMOTE_ACCESS_NATIVE_QA_CHECKS[index] && check.passed === true));
  assert.deepEqual(value.errors, []); assert.equal(value.cleanup, true); assert.equal(value.forcedCleanup, false);
  assert.doesNotMatch(JSON.stringify(value), /blackice_agent_[A-Za-z0-9_-]{43}|(?:[A-F0-9]{4}-){7}[A-F0-9]{4}|-----BEGIN (?:RSA )?PRIVATE KEY-----/);
  return value;
}

async function fileHash(filename) { const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex'); }

export async function runRemoteAccessNativeQA(options) {
  if (process.platform !== 'win32') throw Error('Native access acceptance requires the actual Windows Electron runtime.');
  const candidate = path.resolve(options.candidate), out = path.resolve(options.out), executable = options.electron || path.join(candidate, 'node_modules', 'electron', 'dist', 'electron.exe');
  // Apply the same bounded output-path validation for programmatic callers.
  parseRemoteAccessNativeQAArguments(['--candidate', candidate, '--out', out, '--timeout-ms', String(options.timeoutMs)]);
  assert.ok((await fs.stat(executable)).isFile());
  await fs.mkdir(out, { recursive: true });
  const nonce = randomUUID(), profile = path.join(out, 'owned-profile-' + nonce), nativeFile = path.join(out, 'native-remote-access-result-' + nonce + '.json');
  await fs.mkdir(profile, { recursive: false });
  const started = Date.now(), version = JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8')).version;
  const report = { schema: 1, candidate, version, platform: process.platform, startedAt: new Date(started).toISOString(),
    appFingerprintBefore: null, appFingerprintAfter: null, sourceHashesBefore: {}, sourceHashesAfter: {}, unchangedDuringChecks: false,
    runtime: { executable, hashBefore: null, hashAfter: null, unchanged: false },
    profile: { disposable: true, custom: true }, checks: [], fixtureOnly: true, providerTurnsRequested: 0,
    realRemoteExposure: false, realCredentialIssued: false, cleanup: false, forcedCleanup: false, errors: [],
    limitation: 'Uses a real Electron host, CLI, authentication store, gateway and agent API. The Tailscale command responses and remote DNS route are owned fixtures; TLS certificate validation remains enabled. No real route, account or provider is contacted.',
  };
  let owned;
  try {
    report.appFingerprintBefore = await appFingerprint(candidate); report.sourceHashesBefore = await captureSourceFiles(candidate);
    for (const name of REMOTE_ACCESS_NATIVE_QA_SOURCES) assert.match(report.sourceHashesBefore[name] || '', /^[a-f0-9]{64}$/, 'Bind native access acceptance to ' + name);
    report.runtime.hashBefore = await fileHash(executable);
    const env = { ...process.env, BLACKICE_ACCESS_QA_DEADLINE: String(started + options.timeoutMs - 5000) };
    for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'BLACKICE_EMAIL_ACCESS_TOKEN']) delete env[name];
    const child = spawn(executable, [path.join(candidate, 'tests', 'fixtures', 'remote-access-native.mjs'), '--profile-dir', profile, '--out', out, '--receipt', nativeFile, '--nonce', nonce], { cwd: candidate, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    owned = { child, exited: false, exit: null, stdoutBytes: 0, stderrBytes: 0 };
    child.stdout.on('data', chunk => { owned.stdoutBytes += chunk.length; });
    child.stderr.on('data', chunk => { owned.stderrBytes += chunk.length; });
    owned.done = new Promise(resolve => {
      child.once('close', (code, signal) => { owned.exited = true; owned.exit = { code, signal }; resolve(); });
      child.once('error', () => { owned.exited = true; owned.exit = { code: null, error: true }; resolve(); });
    });
    assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
    while (!owned.exited && Date.now() - started < options.timeoutMs) await wait(200);
    assert.ok(owned.exited, 'The bounded native access fixture must exit.');
    const native = JSON.parse(await fs.readFile(nativeFile, 'utf8'));
    report.native = native; report.checks = native.checks || []; report.errors.push(...(native.errors || []));
    validateRemoteAccessNativeReceipt(native, { nonce, pid: child.pid, profile, executable });
    assert.equal(owned.exit.code, 0, 'The owned native access fixture exits normally.');
  } catch (cause) { report.errors.push(cause.message); }
  finally {
    if (owned && !owned.exited) {
      report.forcedCleanup = true;
      const killer = spawn('taskkill.exe', ['/PID', String(owned.child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      await Promise.race([new Promise(resolve => { killer.once('exit', resolve); killer.once('error', resolve); }), wait(5000)]);
      await Promise.race([owned.done, wait(3000)]);
    }
    if (!owned || owned.exited) for (let attempt = 0; attempt < 20; attempt++) {
      try { await fs.rm(profile, { recursive: true, force: true }); report.cleanup = report.native?.cleanup === true && !report.native?.forcedCleanup; break; } catch { await wait(200); }
    }
    report.forcedCleanup ||= report.native?.forcedCleanup === true;
    try {
      report.appFingerprintAfter = await appFingerprint(candidate); report.sourceHashesAfter = await captureSourceFiles(candidate); report.runtime.hashAfter = await fileHash(executable);
      report.unchangedDuringChecks = report.appFingerprintBefore === report.appFingerprintAfter && JSON.stringify(report.sourceHashesBefore) === JSON.stringify(report.sourceHashesAfter);
      report.runtime.unchanged = report.runtime.hashBefore === report.runtime.hashAfter;
      if (!report.unchangedDuringChecks || !report.runtime.unchanged) report.errors.push('Candidate access sources or the native executable changed during acceptance.');
    } catch { report.errors.push('Could not bind final native access sources.'); }
    report.completedAt = new Date().toISOString(); report.durationMs = Date.now() - started;
    report.passed = report.errors.length === 0 && report.checks.length === REMOTE_ACCESS_NATIVE_QA_CHECKS.length && report.unchangedDuringChecks && report.runtime.unchanged && report.cleanup && !report.forcedCleanup;
    await fs.writeFile(path.join(out, 'remote-access-native-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const report = await runRemoteAccessNativeQA(parseRemoteAccessNativeQAArguments(process.argv.slice(2))); console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, cleanup: report.cleanup, errors: report.errors })); if (!report.passed) process.exitCode = 1; }
  catch (cause) { console.error(cause.message); process.exitCode = 1; }
}
