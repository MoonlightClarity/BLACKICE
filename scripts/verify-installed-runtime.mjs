// Windows release QA. Every profile and fixture belongs to this invocation.
// Public output contains assertions, counts, timings and hashes; raw evidence
// stays under --test-root and must not be uploaded as a release artifact.
import assert from 'node:assert/strict';
import { promises as fs, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { nativeRestartCLIOutcome } from './windows-release-inputs.mjs';

const args = process.argv.slice(2);
const hiddenOnly = args.includes('--hidden-only');
function option(name, required = true) {
  const index = args.indexOf(name), value = index < 0 ? undefined : args[index + 1];
  if (required && (!value || value.startsWith('--'))) throw new Error('Missing validation argument.');
  return value;
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function assertNoLeaks(text, values) {
  for (const value of values) for (const encoded of [value, JSON.stringify(value).slice(1, -1), value.replaceAll('\\', '/'), encodeURI(value)]) {
    assert.ok(!text.includes(encoded), 'Sensitive content appeared in diagnostics.');
  }
}
async function bounded(work, milliseconds, label) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(label), { code: 'VALIDATION_TIMEOUT' })), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function poll(check, milliseconds, label) {
  const end = performance.now() + milliseconds;
  while (performance.now() < end) { const value = await check(); if (value) return value; await pause(250); }
  throw Object.assign(new Error(label), { code: 'VALIDATION_TIMEOUT' });
}
async function optionalJSON(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (['ENOENT', 'EPERM', 'EACCES'].includes(error.code)) return null; throw error; }
}
async function diagnosticReady(profile) {
  let text;
  try { text = await fs.readFile(path.join(profile, 'diagnostics', 'events.0.jsonl'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const events = text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  return events.findLast(event => event.component === 'desktop' && event.event === 'ready');
}
async function authenticated(base) {
  const response = await fetch(base, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie); await response.arrayBuffer();
  return { cookie, async get(route) {
    const result = await fetch(new URL(route, base), { headers: { Cookie: cookie }, signal: AbortSignal.timeout(15_000) });
    const text = await result.text(); return { status: result.status, text, value: JSON.parse(text) };
  } };
}

async function main() {
  const appDir = path.resolve(option('--app-dir')), executable = path.resolve(option('--exe'));
  const testRoot = path.resolve(option('--test-root')), reportFile = path.resolve(option('--report'));
  const expectedVersion = option('--expected-version', false), expectedFingerprint = option('--expected-fingerprint', false);
  const report = { format: 1, product: 'BLACKICE', validation: 'installed-runtime', startedAt: new Date().toISOString(),
    scope: hiddenOnly ? 'strictly-hidden-runtime' : 'full-native-runtime', visibleDesktopValidation: !hiddenOnly,
    platform: process.platform, arch: process.arch, passed: false, startup: { passed: false }, restart: { passed: false }, window: { passed: false },
    shutdown: { passed: false, cleanupMethod: 'native-quit', forcedTerminationUsed: false }, profileBackup: { passed: false, verified: false, restoreVerified: false },
    diagnostics: { passed: false, redactionVerified: false, credentialLeakScanPassed: false }, failures: [] };
  let stage = 'input-validation', work, profile, firstChild, fixtureApp, attemptedLaunch = false;
  let shutdownRequestedAt = null, lastShutdownRequestedAt = null, quitForwarded = false;
  const ownedPids = new Set();
  const load = relative => import(pathToFileURL(path.join(appDir, relative)).href);
  async function privateFailure(error) {
    if (work) await fs.appendFile(path.join(work, 'private-errors.log'), `${stage}\n${error?.stack || error}\n`).catch(() => {});
    const sites = [...String(error?.stack || '').matchAll(/verify-installed-runtime\.mjs:(\d+):(\d+)/g)].slice(0, 4)
      .map(match => ({ line: Number(match[1]), column: Number(match[2]) }));
    report.failures.push({ stage, code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code || '') ? error.code : 'VALIDATION_FAILED', sites });
  }
  function launch(flags) {
    const fd = openSync(path.join(work, 'private-native.log'), 'a'), env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    let child;
    try { child = spawn(executable, ['--profile-dir', profile, ...flags], { windowsHide: true, stdio: ['ignore', fd, fd], env, shell: false }); }
    finally { closeSync(fd); }
    const state = { child, error: null, exited: false };
    state.done = new Promise(resolve => {
      child.once('error', error => { state.error = error; state.exited = true; resolve({ error }); });
      child.once('exit', (code, signal) => { state.exited = true; resolve({ code, signal }); });
    });
    return state;
  }
  async function runtimeRecord() {
    const record = await optionalJSON(path.join(profile, 'desktop-runtime.json'));
    if (!record) return null;
    assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0);
    assert.ok(samePath(record.executable, executable));
    assert.equal(record.profileMode, 'custom');
    const url = new URL(record.url);
    assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
    assert.ok(Number(url.port) > 0 && !url.username && !url.password);
    ownedPids.add(record.pid);
    return record;
  }
  async function readyRecord() {
    const record = await runtimeRecord();
    if (!record || !alive(record.pid)) return null;
    const ready = await diagnosticReady(profile);
    if (!ready || Date.parse(record.at) < Date.parse(ready.at)) return null;
    if (record.lifecycle?.mode !== 'headless' || record.lifecycle.windowVisible !== false || record.restart?.available !== true) return null;
    return record;
  }
  async function stopOwnedRuntime() {
    if (!attemptedLaunch) { report.shutdown = { passed: true, nativeInstanceStarted: false, cleanupMethod: 'no-instance', forcedTerminationUsed: false }; return; }
    const start = performance.now(), requestedPids = new Set(); let quietSince = null;
    await poll(async () => {
      const current = await runtimeRecord();
      const target = current?.pid || (firstChild?.child.pid && alive(firstChild.child.pid) ? firstChild.child.pid : null);
      if (target && !requestedPids.has(target)) {
        requestedPids.add(target);
        report.shutdown.nativeQuitRequests = (report.shutdown.nativeQuitRequests || 0) + 1;
        lastShutdownRequestedAt = Date.now(); shutdownRequestedAt ??= lastShutdownRequestedAt;
        const quit = launch(['--quit']);
        const result = await bounded(quit.done, 15_000, 'Owned native quit invocation did not exit.');
        if (result.error) throw result.error;
        assert.equal(result.code, 0);
        quitForwarded = true;
      }
      // A replacement may finish launching during failure cleanup. Only a
      // newly observed PID in this exact private profile gets another quit.
      const restartState = await optionalJSON(path.join(profile, 'desktop-restart.json'));
      const handoffPending = restartState?.receipts?.some(receipt => ['scheduled', 'restarting'].includes(receipt.status));
      if (!current && !handoffPending && [...ownedPids].every(pid => !alive(pid)) && (!firstChild?.child.pid || !alive(firstChild.child.pid))) {
        quietSince ??= performance.now(); return performance.now() - quietSince >= 3000;
      }
      quietSince = null; return false;
    }, 60_000, 'Owned native instance did not quit.');
    if (shutdownRequestedAt !== null) {
      const directory = path.join(profile, 'diagnostics');
      const segments = (await fs.readdir(directory)).filter(name => /^events\.\d+\.jsonl$/.test(name));
      const events = [];
      for (const name of segments) {
        const text = await fs.readFile(path.join(directory, name), 'utf8');
        events.push(...text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)));
      }
      const interval = events.filter(event => Date.parse(event.at) >= shutdownRequestedAt);
      assert.ok(!interval.some(event => ['desktop', 'server'].includes(event.component) && event.event === 'stop_failed'));
      assert.ok(interval.some(event => event.component === 'desktop' && event.event === 'stopped' && Date.parse(event.at) >= lastShutdownRequestedAt));
      report.shutdown.stoppedEventVerified = true;
      report.shutdown.stopFailureEvents = 0;
    }
    report.shutdown = { ...report.shutdown, passed: true, cleanupMethod: 'native-quit', forcedTerminationUsed: false,
      nativeQuitVerified: quitForwarded, profileRuntimeRecordRemoved: true,
      ownedProcessesExited: true, milliseconds: Math.round(performance.now() - start) };
  }
  try {
    assert.equal(process.platform, 'win32', 'This validation requires Windows.');
    assert.ok((await fs.stat(executable)).isFile());
    const metadata = JSON.parse(await fs.readFile(path.join(appDir, 'package.json'), 'utf8'));
    assert.match(metadata.version, /^\d+\.\d+\.\d+$/);
    if (expectedVersion) assert.equal(metadata.version, expectedVersion);
    report.version = metadata.version;
    if (expectedFingerprint) { assert.match(expectedFingerprint, /^[a-f0-9]{64}$/); report.expectedAppFingerprint = expectedFingerprint; }
    await fs.mkdir(testRoot, { recursive: true });
    work = await fs.mkdtemp(path.join(testRoot, 'isolated-'));
    profile = path.join(work, 'native-profile');
    await fs.mkdir(path.join(profile, 'data'), { recursive: true });

    // An explicit disabled loopback provider prevents automatic Codex startup.
    // This is normal saved configuration, not a product-code test override.
    const { ProviderStore } = await load('lib/provider-store.mjs');
    const providerStore = new ProviderStore({ dataDir: path.join(profile, 'data') });
    await providerStore.init();
    await providerStore.save({ id: 'release-fixture', name: 'Offline release fixture', type: 'compatible',
      baseUrl: 'http://127.0.0.1:1/v1', models: ['offline'], enabled: false });
    await providerStore.setDefaultModel('release-fixture::offline');

    stage = 'native-startup';
    const startupAt = performance.now(); attemptedLaunch = true; firstChild = launch(['--headless']);
    if (firstChild.child.pid) ownedPids.add(firstChild.child.pid);
    const before = await poll(async () => {
      if (firstChild.error) throw firstChild.error;
      if (firstChild.exited) throw Object.assign(new Error('Native application exited before ready.'), { code: 'STARTUP_EXITED' });
      return readyRecord();
    }, 90_000, 'Native startup did not reach ready.');
    assert.equal(before.pid, firstChild.child.pid); assert.equal(before.version, report.version);
    assert.equal(before.capabilities?.nativeRestart, true);
    const initial = await authenticated(before.url), status = await initial.get('/api/status');
    assert.equal(status.status, 200); assert.equal(status.value.version, report.version);
    assert.equal(status.value.desktopLifecycle.mode, 'headless');
    assert.equal(status.value.desktopLifecycle.windowVisible, false);
    assert.equal(status.value.execution.activeCount, 0);
    assert.equal(status.value.activeTurns, 0);
    assert.equal(status.value.codex.connected, false);
    assert.equal(status.value.providers.length, 1); assert.equal(status.value.providers[0].enabled, false);
    const nativeExport = await initial.get('/api/diagnostics/export');
    assert.equal(nativeExport.status, 200); assert.equal(nativeExport.value.format, 'relay-support');
    assertNoLeaks(nativeExport.text, [profile, work, initial.cookie, initial.cookie.slice(initial.cookie.indexOf('=') + 1), before.url]);
    await fs.writeFile(path.join(work, 'private-native-support.json'), nativeExport.text);
    report.startup = { passed: true, nativeExecutableVerified: true, isolatedProfile: true, mode: 'headless',
      statusHttpVerified: true, providerDisabled: true, externalProviderConnected: false,
      nativeSupportExportSha256: sha(nativeExport.text), milliseconds: Math.round(performance.now() - startupAt) };

    stage = 'native-restart';
    const restartFile = path.join(profile, 'desktop-restart.json');
    const oldIds = new Set((await optionalJSON(restartFile))?.receipts?.map(value => value.id) || []);
    const restartAt = performance.now(), requestTime = Date.now();
    const nativeLog = path.join(work, 'private-native.log'), restartLogOffset = (await fs.stat(nativeLog)).size;
    const command = launch(['--restart']);
    const forwarded = await bounded(command.done, 15_000, 'Native restart forwarding did not exit.');
    const commandLog = (await fs.readFile(nativeLog)).subarray(restartLogOffset).toString('utf8');
    report.restart.schedulingCommand = nativeRestartCLIOutcome(commandLog, forwarded.code);
    if (forwarded.error) throw forwarded.error;
    if (forwarded.code !== 0 && report.restart.schedulingCommand.errorCode) throw Object.assign(new Error('Native restart command failed.'), { code: report.restart.schedulingCommand.errorCode });
    assert.equal(forwarded.code, 0);
    let matchingId;
    const completed = await poll(async () => {
      const saved = await optionalJSON(restartFile);
      const match = saved?.receipts?.find(value => matchingId ? value.id === matchingId :
        !oldIds.has(value.id) && value.ownerId === 'local' && value.origin?.pid === before.pid &&
        value.origin.startedAt === before.startedAt && Date.parse(value.requestedAt) >= requestTime - 1000);
      if (!match) return false;
      matchingId ||= match.id;
      if (['failed', 'cancelled', 'interrupted'].includes(match.status)) throw Object.assign(new Error('Native restart receipt did not complete.'), { code: 'RESTART_RECEIPT_FAILED' });
      if (match.status !== 'completed') return false;
      const after = await readyRecord();
      if (!after || after.pid === before.pid || after.restart?.status !== 'completed') return false;
      return { receipt: match, after };
    }, 90_000, 'Native restart did not produce its completed replacement receipt.');
    const { receipt, after } = completed;
    assert.equal(receipt.origin.mode, 'headless'); assert.equal(receipt.started.mode, 'headless');
    assert.ok(samePath(receipt.origin.profileDir, profile)); assert.ok(samePath(receipt.started.profileDir, profile));
    assert.equal(receipt.started.pid, after.pid); assert.equal(receipt.started.startedAt, after.startedAt);
    assert.notEqual(before.pid, after.pid); assert.equal(alive(before.pid), false);
    assert.equal(after.version, report.version);
    const replacement = await authenticated(after.url), afterStatus = await replacement.get('/api/status');
    assert.equal(afterStatus.status, 200); assert.equal(afterStatus.value.desktopLifecycle.mode, 'headless');
    assert.equal(afterStatus.value.execution.activeCount, 0); assert.equal(afterStatus.value.codex.connected, false);
    const stale = await fetch(new URL('/api/diagnostics/export', after.url), { headers: { Cookie: initial.cookie }, signal: AbortSignal.timeout(10_000) });
    assert.equal(stale.status, 401); await stale.arrayBuffer();
    await fs.writeFile(path.join(work, 'private-native-restart-receipt.json'), JSON.stringify(receipt, null, 2));
    report.restart = { ...report.restart, passed: true, nativeCommandUsed: true, matchingReceiptCompleted: true, replacementPidChanged: true,
      originalProcessExited: true, profilePreserved: true, modePreserved: true, discoveryReread: true,
      oldSessionRejected: true, receiptSha256: sha(JSON.stringify(receipt)), milliseconds: Math.round(performance.now() - restartAt) };

    if(hiddenOnly){
      const hiddenRecord=await runtimeRecord(),hiddenStatus=await replacement.get('/api/status');
      assert.equal(hiddenRecord.pid,after.pid);assert.equal(hiddenRecord.lifecycle.mode,'headless');
      assert.equal(hiddenRecord.lifecycle.windowVisible,false);assert.equal(hiddenStatus.status,200);
      assert.equal(hiddenStatus.value.desktopLifecycle.windowVisible,false);
      report.window={passed:true,validation:'remains-headless',plainNativeLaunchUsed:false,
        sameProfile:true,sameRuntimePid:true,mode:'headless',windowVisible:false,statusHttpVerified:true};
    }else{
    stage = 'native-window';
    const windowAt = performance.now(), windowCommand = launch([]);
    const windowForwarded = await bounded(windowCommand.done, 15_000, 'Native window forwarding did not exit.');
    if (windowForwarded.error) throw windowForwarded.error; assert.equal(windowForwarded.code, 0);
    const visible = await poll(async () => {
      const record = await runtimeRecord();
      if (!record) return false;
      assert.equal(record.pid, after.pid); assert.equal(record.startedAt, after.startedAt);
      return record.lifecycle?.mode === 'window' && record.lifecycle.windowVisible === true ? record : false;
    }, 45_000, 'Plain native launch did not show the owned application window.');
    const windowStatus = await replacement.get('/api/status');
    assert.equal(windowStatus.status, 200); assert.equal(windowStatus.value.desktopLifecycle.mode, 'window');
    assert.equal(windowStatus.value.desktopLifecycle.windowVisible, true);
    assert.equal(windowStatus.value.execution.activeCount, 0); assert.equal(windowStatus.value.codex.connected, false);
    assert.equal(visible.profileMode, 'custom');
    report.window = { passed: true, plainNativeLaunchUsed: true, sameProfile: true, sameRuntimePid: true,
      mode: 'window', windowVisible: true, statusHttpVerified: true, milliseconds: Math.round(performance.now() - windowAt) };
    }

    stage = 'native-shutdown'; await stopOwnedRuntime();

    stage = 'backup-and-restore';
    const { createProfileBackup, verifyProfileBackup, restoreProfileBackup } = await load('lib/profile-backup.mjs');
    const expected = new Map([['data/qa-roundtrip.json', Buffer.from('{"fixture":"durable state"}\n')],
      ['workspace/qa-fixture.bin', Buffer.from([0, 1, 2, 127, 128, 254, 255])]]);
    for (const [relative, bytes] of expected) { const file = path.join(profile, ...relative.split('/')); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); }
    await fs.mkdir(path.join(profile, 'Cache'), { recursive: true });
    await fs.writeFile(path.join(profile, 'Cache', 'qa-excluded.bin'), 'transient fixture');
    const backup = path.join(work, 'profile-backup'), target = path.join(work, 'restore-target');
    await fs.mkdir(target); await fs.writeFile(path.join(target, 'previous-profile.txt'), 'preserved previous profile');
    const created = await createProfileBackup({ profileDir: profile, backupDir: backup, appVersion: report.version });
    const verified = await verifyProfileBackup({ backupDir: backup, appVersion: report.version });
    assert.equal(created.manifestSha256, verified.manifestSha256); assert.equal(verified.bindingCompatible, true);
    assert.ok(verified.excluded.includes('Cache')); assert.ok(!verified.manifest.entries.some(entry => entry.path.startsWith('Cache/')));
    const restored = await restoreProfileBackup({ profileDir: target, backupDir: backup, appVersion: report.version });
    assert.equal(restored.restored, true);
    let verifiedFiles = 0, verifiedBytes = 0;
    for (const entry of verified.manifest.entries) {
      if (entry.type !== 'file') continue;
      const bytes = await fs.readFile(path.join(target, ...entry.path.split('/')));
      assert.equal(bytes.length, entry.size); assert.equal(sha(bytes), entry.sha256); verifiedFiles++; verifiedBytes += bytes.length;
    }
    for (const [relative, bytes] of expected) assert.deepEqual(await fs.readFile(path.join(target, ...relative.split('/'))), bytes);
    assert.equal(await fs.readFile(path.join(restored.previousProfileDir, 'previous-profile.txt'), 'utf8'), 'preserved previous profile');
    const corrupt = path.join(work, 'corrupt-backup'); await fs.cp(backup, corrupt, { recursive: true });
    await fs.appendFile(path.join(corrupt, 'payload', 'data', 'qa-roundtrip.json'), '!');
    await assert.rejects(verifyProfileBackup({ backupDir: corrupt, appVersion: report.version }), error => error.code === 'PROFILE_BACKUP_CORRUPT');
    report.profileBackup = { passed: true, verified: true, restoreVerified: true, realWindowsBinding: true,
      filesVerified: verifiedFiles, bytesVerified: verifiedBytes, manifestSha256: verified.manifestSha256,
      previousProfilePreserved: true, cacheExcluded: true, corruptionRejected: true };

    stage = 'diagnostics-export';
    const { createHarnessServer } = await load('server.mjs');
    const canary = `sk-SYNTHETIC_RELEASE_CANARY_${randomUUID().replaceAll('-', '')}`;
    const diagnosticProfile = path.join(work, 'fixture-diagnostics'), workspace = path.join(diagnosticProfile, 'workspace');
    let modelCalls = 0;
    class FixtureRuntime extends EventEmitter {
      status() { return { connected: true, authenticated: true, defaultModel: 'fixture-model', models: [{ model: 'fixture-model' }],
        providers: [{ id: canary, name: canary, apiKey: canary }], account: { email: `${canary}@example.invalid` }, lastError: `Bearer ${canary}` }; }
      async start() { return this.status(); }
      async runAgent() { modelCalls++; throw new Error('Fixture model execution was not requested.'); }
      async close() {}
    }
    class FixtureDesktop extends EventEmitter { status() { return { enabled: false, available: false, path: canary }; } async setEnabled() { return this.status(); } }
    class FixtureBrowser extends EventEmitter { status() { return { available: false, tabs: [{ url: `https://${canary}.invalid/` }] }; } async cancel() {} async close() {} }
    fixtureApp = await createHarnessServer({ port: 0, dataDir: path.join(diagnosticProfile, 'data'), defaultCwd: workspace,
      runtime: new FixtureRuntime(), desktop: new FixtureDesktop(), browser: new FixtureBrowser(), remoteAccess: false, emailExecutableHint: '' });
    await fixtureApp.learning.updateSettings({ mode: 'manual' });
    await fixtureApp.engine.saveWorkflow({ id: 'release-redaction-fixture', name: canary,
      nodes: [{ id: 'fixture', type: 'agent', prompt: canary }], edges: [] });
    await fixtureApp.diagnostics.record({ component: 'browser', event: 'browser_failed', level: 'error', code: canary,
      message: canary, password: canary, token: canary, url: `https://example.invalid/?token=${canary}`, path: workspace,
      stack: canary, headers: { Authorization: `Bearer ${canary}`, Cookie: canary } });
    await fixtureApp.diagnostics.recordError('server', 'request_failed', Object.assign(new Error(canary), { code: 'ECONNRESET', token: canary }));
    const fixtureBase = await fixtureApp.listen(), client = await authenticated(fixtureBase);
    const exported = await client.get('/api/diagnostics/export');
    assert.equal(exported.status, 200); assert.equal(exported.value.format, 'relay-support'); assert.equal(exported.value.application.version, report.version);
    for (const code of ['UNKNOWN_ERROR', 'ECONNRESET']) assert.ok(exported.value.events.some(event => event.code === code));
    assert.ok(exported.value.events.some(event => event.event === 'support_exported'));
    const forbidden = [canary, client.cookie, client.cookie.slice(client.cookie.indexOf('=') + 1), workspace, diagnosticProfile, fixtureBase];
    assertNoLeaks(exported.text, forbidden);
    assert.equal(modelCalls, 0);
    const exportFile = path.join(work, 'private-fixture-support-export.json'); await fs.writeFile(exportFile, exported.text);
    assert.equal(await fs.readFile(exportFile, 'utf8'), exported.text);
    const logDirectory = fixtureApp.diagnostics.directory;
    await bounded(fixtureApp.close(), 30_000, 'Fixture server cleanup did not finish.'); fixtureApp = null;
    const logs = (await fs.readdir(logDirectory)).filter(name => /^events\.\d+\.jsonl$/.test(name)); assert.ok(logs.length > 0);
    for (const name of logs) assertNoLeaks(await fs.readFile(path.join(logDirectory, name), 'utf8'), forbidden);
    report.diagnostics = { passed: true, redactionVerified: true, credentialLeakScanPassed: true,
      operation: 'installed-authenticated-http-export', fixtureBoundaries: ['provider', 'desktop', 'browser'],
      exportSha256: sha(exported.text), exportBytes: Buffer.byteLength(exported.text), eventsVerified: exported.value.events.length,
      logSegmentsScanned: logs.length, canaryClasses: ['API key', 'password', 'authorization', 'cookie', 'URL', 'path', 'prompt', 'error'], modelCalls };
  } catch (error) { await privateFailure(error); }
  finally {
    if (fixtureApp) { stage = 'fixture-cleanup'; try { await bounded(fixtureApp.close(), 30_000, 'Fixture close failed.'); } catch (error) { await privateFailure(error); } }
    if (!report.shutdown.passed) { stage = 'native-finally-cleanup'; try { await stopOwnedRuntime(); } catch (error) { await privateFailure(error); } }
    report.finishedAt = new Date().toISOString();
    report.passed = !report.failures.length && ['startup', 'restart', 'window', 'shutdown', 'profileBackup', 'diagnostics'].every(key => report[key].passed);
    await fs.mkdir(path.dirname(reportFile), { recursive: true });
    const output = await fs.open(reportFile, 'w');
    try { await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync(); }
    finally { await output.close(); }
    console.log(JSON.stringify(report));
    // Failed bounded cleanup must not leave this validator holding its caller
    // open; the durable failed report remains authoritative for outer cleanup.
    if (!report.passed) process.exit(1);
  }
}
main().catch(() => { console.error('Installed runtime validation could not produce its report.'); process.exitCode = 1; });
