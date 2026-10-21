#!/usr/bin/env node
/** Real Electron lifecycle acceptance. Uses only a newly owned disposable profile; never requests a model turn. */
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
export const HEADLESS_QA_SOURCES = Object.freeze(['package.json', 'desktop/main.mjs', 'desktop/lifecycle.mjs', 'desktop/browser-driver.mjs', 'desktop/browser-router.mjs', 'server.mjs', 'lib/browser.mjs', 'lib/browser-protection.mjs', 'lib/vendor/ghostery-adblocker.mjs', 'lib/vendor/adblock-filter-data.json', 'lib/remote-access.mjs', 'lib/remote-access-auth.mjs', 'lib/remote-access-gateway.mjs', 'lib/remote-access-tailscale.mjs', 'scripts/headless-desktop-qa.mjs']);
export const HEADLESS_QA_CHECKS = Object.freeze([
  'headless starts the real Electron runtime without a visible window',
  'headless keeps Electron encrypted storage and the contained browser adapter',
  'the disposable profile starts without inherited tasks or enabled remote exposure',
  'normal reopening reveals the same profile instance and server',
  'the ordinary UI action hides the window and keeps its runtime alive',
  'the local show action restores the same window',
  'normal API shutdown closes the runtime and removes its marker',
  'the same explicit profile reopens headlessly with its encrypted runtime',
  'profile-scoped --quit uses graceful single-instance shutdown',
  'no provider turn or task was requested by headless acceptance',
]);
export function parseHeadlessQAArguments(argv) {
  const options = { candidate: ROOT, out: path.resolve(ROOT, '..', 'qa-headless'), timeoutMs: 120000 };
  const names = { '--candidate': 'candidate', '--out': 'out', '--electron': 'electron', '--timeout-ms': 'timeoutMs' };
  for (let index = 0; index < argv.length; index++) { const key = names[argv[index]]; if (!key || !argv[index + 1]) throw new Error('Use --candidate, --out, --electron and --timeout-ms with values.'); options[key] = key === 'timeoutMs' ? Number(argv[++index]) : path.resolve(argv[++index]); }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 45000 || options.timeoutMs > 180000) throw new Error('Use a bounded timeout from 45000 to 180000 milliseconds.');
  return options;
}

export async function runHeadlessDesktopQA(options) {
  if (process.platform !== 'win32') throw new Error('This acceptance script requires the actual Windows Electron runtime.');
  const candidate = path.resolve(options.candidate), out = path.resolve(options.out), executable = options.electron || path.join(candidate, 'node_modules', 'electron', 'dist', 'electron.exe');
  assert.ok((await fs.stat(executable)).isFile(), 'Use the candidate Electron executable.');
  const version = JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8')).version;
  await fs.mkdir(out, { recursive: true });
  const profile = path.join(out, 'owned-profile-' + randomUUID()), marker = path.join(profile, 'desktop-runtime.json');
  await fs.mkdir(profile, { recursive: false });
  const started = Date.now(), deadline = started + options.timeoutMs, children = [];
  const report = { schema: 1, candidate, version, platform: process.platform, startedAt: new Date(started).toISOString(), providerTurnsRequested: 0, profile: { disposable: true, custom: true }, checks: [], sourceHashesBefore: {}, sourceHashesAfter: {}, appFingerprintBefore: null, appFingerprintAfter: null, unchangedDuringChecks: false, lifecycle: [], cleanup: false, forcedCleanup: false, errors: [] };
  const check = (name, value) => { assert.ok(value, name); report.checks.push({ name, passed: true }); };
  async function until(read, description, limit = 30000) {
    const stop = Math.min(deadline, Date.now() + limit); let last;
    while (Date.now() < stop) { try { const value = await read(); if (value) return value; } catch (cause) { last = cause; } await wait(150); }
    throw new Error(`Timed out waiting for ${description}.${last ? ' ' + last.message : ''}`);
  }
  async function launch(args, label) {
    const stdout = await fs.open(path.join(out, label + '.stdout.log'), 'w'), stderr = await fs.open(path.join(out, label + '.stderr.log'), 'w');
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    const child = spawn(executable, [candidate, '--profile-dir=' + profile, ...args], { cwd: candidate, windowsHide: true, stdio: ['ignore', stdout.fd, stderr.fd], env });
    const owned = { child, label, exited: false, exit: null }; children.push(owned);
    owned.done = new Promise(resolve => { child.once('exit', (code, signal) => { owned.exited = true; owned.exit = { code, signal }; resolve(owned.exit); }); child.once('error', cause => { owned.exited = true; owned.exit = { error: cause.message }; resolve(owned.exit); }); });
    await Promise.all([stdout.close(), stderr.close()]);
    if (!Number.isInteger(child.pid)) throw new Error('The owned Electron process could not be started.');
    return owned;
  }
  async function runtime(owned) {
    if (owned.exited) throw new Error('The owned Electron process exited before becoming ready.');
    const value = JSON.parse(await fs.readFile(marker, 'utf8')); assert.equal(value.pid, owned.child.pid); assert.equal(value.version, version); assert.equal(value.profileMode, 'custom');
    const url = new URL(value.url); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:'); assert.ok(Number(url.port) >= 1024); return value;
  }
  let current, address, cookie;
  async function connect(owned) {
    const value = await until(() => runtime(owned), 'the owned headless runtime marker'); address = value.url;
    const response = await fetch(address + '/', { redirect: 'manual', signal: AbortSignal.timeout(5000) }); assert.equal(response.status, 200); await response.arrayBuffer();
    const cookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie') || ''];
    cookie = cookies.map(value => value.split(';')[0]).find(value => /^relay_session_\d+=[a-f0-9]{64}$/.test(value)); assert.ok(cookie, 'The owned loopback server issues its own session.');
    return value;
  }
  async function api(route, method = 'GET') {
    await runtime(current); const response = await fetch(address + route, { method, headers: { Cookie: cookie, Origin: address, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}), redirect: 'manual', signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, route); return response.json();
  }
  async function stopped(owned) { await until(() => owned.exited, 'the owned Electron process to stop', 30000); assert.equal(owned.exit.code, 0); await until(async () => { try { await fs.access(marker); return false; } catch (cause) { return cause.code === 'ENOENT'; } }, 'runtime marker cleanup', 5000); }
  try {
    report.appFingerprintBefore = await appFingerprint(candidate); report.sourceHashesBefore = await captureSourceFiles(candidate);
    for (const name of HEADLESS_QA_SOURCES) assert.match(report.sourceHashesBefore[name] || '', /^[a-f0-9]{64}$/, 'Bind native lifecycle acceptance to ' + name);
    current = await launch(['--headless'], 'headless-start'); const first = await connect(current);
    const initial = await api('/api/status'); report.lifecycle.push(initial.desktopLifecycle);
    check('headless starts the real Electron runtime without a visible window', initial.desktopLifecycle?.mode === 'headless' && initial.desktopLifecycle.windowVisible === false && first.capabilities?.electron === true);
    check('headless keeps Electron encrypted storage and the contained browser adapter', first.capabilities?.encryptedSecretsAvailable === true && first.capabilities?.containedBrowser === true && initial.desktopLifecycle.sameProfile === true);
    check('the disposable profile starts without inherited tasks or enabled remote exposure', (await api('/api/runs')).length === 0 && (await api('/api/remote-access')).enabled === false);
    const reopening = await launch([], 'headless-reopen'); await until(() => reopening.exited, 'the second process to hand off to the same instance', 15000); assert.equal(reopening.exit.code, 0);
    const visible = await until(async () => { const value = await api('/api/status'); return value.desktopLifecycle?.mode === 'window' && value.desktopLifecycle.windowVisible === true ? value : null; }, 'the same instance to reveal its window');
    report.lifecycle.push(visible.desktopLifecycle); check('normal reopening reveals the same profile instance and server', (await runtime(current)).pid === first.pid && address === first.url);
    const background = await api('/api/desktop/background', 'POST'); report.lifecycle.push(background); check('the ordinary UI action hides the window and keeps its runtime alive', background.mode === 'background' && background.windowVisible === false && (await api('/api/runs')).length === 0);
    const shown = await api('/api/desktop/show', 'POST'); report.lifecycle.push(shown); check('the local show action restores the same window', shown.mode === 'window' && shown.windowVisible === true);
    await api('/api/desktop/background', 'POST'); await api('/api/shutdown', 'POST'); await stopped(current); check('normal API shutdown closes the runtime and removes its marker', current.exit.code === 0);
    current = await launch(['--headless'], 'headless-restart'); const restarted = await connect(current); check('the same explicit profile reopens headlessly with its encrypted runtime', restarted.lifecycle?.mode === 'headless' && restarted.profileMode === 'custom' && restarted.capabilities?.encryptedSecretsAvailable === true);
    const quitting = await launch(['--quit'], 'headless-quit'); await until(() => quitting.exited, 'the profile-scoped quit command', 15000); assert.equal(quitting.exit.code, 0); await stopped(current); check('profile-scoped --quit uses graceful single-instance shutdown', current.exit.code === 0);
    check('no provider turn or task was requested by headless acceptance', report.providerTurnsRequested === 0);
  } catch (cause) { report.errors.push(cause.message); }
  finally {
    for (const owned of children) if (!owned.exited) {
      if (owned === current && address && cookie) try { await api('/api/shutdown', 'POST'); await Promise.race([owned.done, wait(5000)]); } catch {}
      if (!owned.exited) {
        report.forcedCleanup = true;
        const killer = spawn('taskkill.exe', ['/PID', String(owned.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); await Promise.race([new Promise(resolve => { killer.once('exit', resolve); killer.once('error', resolve); }), wait(5000)]); await Promise.race([owned.done, wait(2000)]);
      }
    }
    if (children.every(owned => owned.exited)) {
      for (let attempt = 0; attempt < 20; attempt++) { try { await fs.rm(profile, { recursive: true, force: true }); report.cleanup = true; break; } catch { await wait(200); } }
    }
    try {
      report.appFingerprintAfter = await appFingerprint(candidate); report.sourceHashesAfter = await captureSourceFiles(candidate);
      report.unchangedDuringChecks = report.appFingerprintBefore === report.appFingerprintAfter && JSON.stringify(report.sourceHashesBefore) === JSON.stringify(report.sourceHashesAfter);
      if (!report.unchangedDuringChecks) report.errors.push('Candidate application or acceptance sources changed during native lifecycle checks.');
    } catch (cause) { report.errors.push('Could not bind final candidate sources: ' + cause.message); }
    report.completedAt = new Date().toISOString(); report.durationMs = Date.now() - started; report.passed = report.errors.length === 0 && report.checks.length === HEADLESS_QA_CHECKS.length && report.checks.every((entry, index) => entry.name === HEADLESS_QA_CHECKS[index] && entry.passed === true) && report.unchangedDuringChecks && report.cleanup && !report.forcedCleanup;
    await fs.writeFile(path.join(out, 'headless-desktop-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const report = await runHeadlessDesktopQA(parseHeadlessQAArguments(process.argv.slice(2))); console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, cleanup: report.cleanup, errors: report.errors })); if (!report.passed) process.exitCode = 1; }
  catch (cause) { console.error(cause.message); process.exitCode = 1; }
}
