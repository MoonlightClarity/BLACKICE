#!/usr/bin/env node
/** Proposal only: run on Windows after the guarded update and a separately recorded normal native launch.
 * node verify-awareness-reopen.mjs WORK PLAN_SHA256 LAUNCH_PID EXE LAUNCHED_AT_ISO
 * Reads application/profile metadata and GET endpoints only. Writes one new work/reopen-verification.json.
 * Does not launch, stop, reveal, install, configure a route, or request a provider turn.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function verify() {
  assert.equal(process.platform, 'win32', 'Use actual Windows native reopening evidence.');
  const [workArg, planSha256, launchPidText, executable, launchedAt] = process.argv.slice(2);
  assert.equal(process.argv.length, 7, 'Supply WORK PLAN_SHA256 LAUNCH_PID EXE LAUNCHED_AT_ISO.');
  assert.ok(path.isAbsolute(workArg) && path.isAbsolute(executable));
  assert.match(planSha256, /^[a-f0-9]{64}$/);
  const launchPid = Number(launchPidText), launchTime = Date.parse(launchedAt), work = path.resolve(workArg);
  assert.ok(Number.isSafeInteger(launchPid) && launchPid > 0 && Number.isFinite(launchTime));
  assert.ok(launchTime <= Date.now() && Date.now() - launchTime < 10 * 60_000, 'Use the recorded fresh native launch.');
  const planBytes = await fs.readFile(path.join(work, 'awareness-update-plan.json'));
  assert.equal(sha(planBytes), planSha256, 'Guarded plan bytes changed.');
  const plan = JSON.parse(planBytes);
  assert.equal(plan.product, 'BLACKICE'); assert.equal(plan.version, '2.30.0');
  assert.equal(sha(await fs.readFile(new URL(import.meta.url))), plan.sourceFiles['scripts/verify-awareness-reopen.mjs'], 'The source-bound reopening helper changed.');
  assert.ok(samePath(plan.candidate, path.join(work, 'candidate')));
  assert.ok(samePath(path.dirname(executable), path.resolve(plan.installed, '../..')));
  const installedReceiptBytes = await fs.readFile(path.join(work, 'installation-verification.json'));
  const installedReceipt = JSON.parse(installedReceiptBytes);
  assert.equal(installedReceipt.installed, true); assert.equal(installedReceipt.fullRuntimeMatch, true);
  assert.equal(installedReceipt.planSha256, planSha256); assert.equal(installedReceipt.version, plan.version);
  assert.equal(installedReceipt.appFingerprint, plan.verifiedFingerprint);
  assert.ok(samePath(installedReceipt.installation, plan.installed));
  const baselineBytes = await fs.readFile(path.join(work, 'baseline-awareness-2.29.0.json'));
  assert.equal(sha(baselineBytes), plan.baselineSha256);
  const helperNames = ['scripts/release-check.mjs', 'scripts/install-background-update.mjs', 'scripts/install-planning-update.mjs', 'scripts/prepare-awareness-candidate.mjs'];
  for (const name of helperNames) assert.equal(sha(await fs.readFile(path.join(plan.candidate, name))), plan.sourceFiles[name], 'Reviewed verification helper changed: ' + name);
  const [{ appFingerprint }, { captureSourceFiles, verifyCanonicalSource }, { verifyInstalledFiles }, { validateAwarenessBaseline }] = await Promise.all(helperNames.map(name => import(pathToFileURL(path.join(plan.candidate, name)).href)));
  const baseline = validateAwarenessBaseline(baselineBytes, { source: plan.source, installed: plan.installed, candidate: plan.candidate });

  const markerFile = path.join(process.env.APPDATA, 'Relay', 'desktop-runtime.json');
  async function marker() {
    const value = await readJson(markerFile);
    assert.equal(value.pid, launchPid); assert.ok(samePath(value.executable, executable));
    assert.equal(value.version, plan.version); assert.equal(value.profileMode, 'default');
    assert.ok(Date.parse(value.startedAt) >= launchTime - 1000, 'Runtime marker belongs to an older launch.');
    assert.equal(value.capabilities?.electron, true); assert.equal(value.capabilities?.containedBrowser, true);
    assert.equal(value.capabilities?.encryptedSecretsAvailable, true);
    const url = new URL(value.url);
    assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
    assert.ok(Number(url.port) >= 1024 && Number(url.port) <= 65535);
    assert.equal(url.username + url.password + url.search + url.hash, ''); assert.equal(url.pathname, '/');
    return value;
  }
  let runtime, status, cookie, lastReadError;
  async function getStatus() {
    const current = await marker(); assert.equal(current.url, runtime.url);
    const response = await fetch(runtime.url + '/api/status', { headers: { Cookie: cookie, Origin: runtime.url }, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, 'Fresh installed /api/status request failed.');
    const value = await response.json();
    assert.equal(value.app, 'relay-agent-harness'); assert.equal(value.version, plan.version); assert.equal(value.desktopApp, true);
    assert.ok(samePath(value.installPath, path.dirname(executable)));
    assert.equal(value.execution?.activeCount, 0); assert.equal(value.execution?.settling, false); assert.equal(value.execution?.stopping, false);
    assert.equal(value.activeTurns, 0); assert.equal(value.learning?.activeReviewId, null);
    assert.equal(value.inbox?.active, 0); assert.equal(value.inbox?.paused, true);
    assert.equal(value.operations?.running, 0); assert.equal(value.operations?.paused, true);
    assert.equal(value.desktopLifecycle?.mode, 'window'); assert.equal(value.desktopLifecycle?.windowVisible, true);
    assert.equal(value.desktopLifecycle?.sameProfile, true); assert.equal(value.desktopLifecycle?.supportsHeadless, true);
    assert.equal(value.remoteAccess?.client, 'local'); assert.equal(value.remoteAccess?.localManagement, true);
    assert.equal(value.browser?.available, true);
    assert.equal(value.email?.oauth?.available, true, 'Managed email sign-in must be available in the reopened native encrypted profile.');
    return value;
  }
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    try {
      runtime = await marker();
      const response = await fetch(runtime.url + '/', { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200); await response.arrayBuffer();
      cookie = (response.headers.getSetCookie?.() || [response.headers.get('set-cookie') || '']).map(value => value.split(';')[0]).find(value => /^relay_session_\d+=[a-f0-9]{64}$/.test(value));
      assert.ok(cookie, 'Installed loopback session cookie was not issued.');
      status = await getStatus(); break;
    } catch (error) { lastReadError = error; await wait(300); }
  }
  if (!status) throw lastReadError || new Error('Installed desktop did not become ready.');
  const processScript = "$ErrorActionPreference='Stop';$taskProc=Get-Process -Id ([int]$env:BLACKICE_REOPEN_VERIFY_PID) -ErrorAction Stop;$taskListeners=@(Get-NetTCPConnection -State Listen -LocalPort ([int]$env:BLACKICE_REOPEN_VERIFY_PORT) -ErrorAction Stop);[pscustomobject]@{pid=$taskProc.Id;executable=$taskProc.Path;startedAt=$taskProc.StartTime.ToUniversalTime().ToString('o');listeners=@($taskListeners|ForEach-Object{[pscustomobject]@{address=$_.LocalAddress;pid=$_.OwningProcess}})}|ConvertTo-Json -Depth 4 -Compress";
  const native = JSON.parse(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', processScript], { windowsHide: true, shell: false, timeout: 10000, maxBuffer: 65536, encoding: 'utf8', env: { ...process.env, BLACKICE_REOPEN_VERIFY_PID: String(launchPid), BLACKICE_REOPEN_VERIFY_PORT: new URL(runtime.url).port } }).trim());
  assert.equal(native.pid, launchPid); assert.ok(samePath(native.executable, executable));
  assert.ok(Date.parse(native.startedAt) >= launchTime - 1000 && Math.abs(Date.parse(native.startedAt) - Date.parse(runtime.startedAt)) < 5000);
  assert.ok(native.listeners.length > 0 && native.listeners.every(item => item.address === '127.0.0.1' && item.pid === launchPid));

  assert.deepEqual(await captureSourceFiles(plan.candidate), plan.sourceFiles);
  const sourceInventory = await verifyCanonicalSource(plan.source, { releaseFiles: plan.sourceFiles, expectedFiles: plan.sourceFiles, expectedExtras: baseline.preservedSourceFiles });
  const installedCount = await verifyInstalledFiles(plan.installed, plan.installedAfterFiles);
  assert.deepEqual(await captureSourceFiles(plan.installed), plan.installedAfterFiles, 'Installed file inventory differs from the complete guarded map.');
  assert.equal(sourceInventory.extraSha256, plan.sourceUnmanaged.sha256);
  const [sourceFingerprint, installedFingerprint, verifiedCandidateFingerprint] = await Promise.all([plan.source, plan.installed, plan.candidate].map(root => appFingerprint(root)));
  for (const fingerprint of [sourceFingerprint, installedFingerprint, verifiedCandidateFingerprint]) assert.equal(fingerprint, plan.verifiedFingerprint);
  await wait(1000); status = await getStatus();
  const finalMarker = await marker(); assert.equal(finalMarker.pid, runtime.pid); assert.equal(finalMarker.startedAt, runtime.startedAt);
  assert.equal(sha(await fs.readFile(path.join(work, 'awareness-update-plan.json'))), planSha256);
  assert.equal(sha(await fs.readFile(path.join(work, 'installation-verification.json'))), sha(installedReceiptBytes));
  const receipt = {
    format: 1, product: 'BLACKICE', version: plan.version, platform: 'win32', verifiedAt: new Date().toISOString(),
    desktopApp: true, statusOk: true, idle: true, freshNativeLaunch: true, fullRuntimeMatch: true,
    planSha256, baselineSha256: plan.baselineSha256, installationReceiptSha256: sha(installedReceiptBytes),
    sourceFingerprint, installedFingerprint, verifiedCandidateFingerprint,
    sourceFilesVerified: Object.keys(plan.sourceFiles).length, installedFilesVerified: installedCount,
    completeInstalledInventory: true, sourceUnmanaged: { preserved: true, sha256: sourceInventory.extraSha256, fileCount: sourceInventory.extraFileCount },
    native: { pid: launchPid, executable, startedAt: runtime.startedAt, profileMode: runtime.profileMode, loopbackListenerOwned: true, capabilities: runtime.capabilities },
    lifecycle: status.desktopLifecycle,
    execution: { activeCount: 0, activeTurns: 0, settling: false, stopping: false, activeReview: false, inboxPaused: true, operationsPaused: true },
    providers: { connected: status.connected === true, authenticated: status.authenticated === true, defaultModelAvailable: status.defaultModelAvailable === true, hasError: Boolean(status.error) },
    remote: { state: status.remoteAccess.state, enabled: status.remoteAccess.enabled, configuredEnabled: status.remoteAccess.configuredEnabled, mode: status.remoteAccess.mode },
    email: { oauthAvailable: status.email.oauth.available === true, registrationConfigured: status.email.oauth.configured === true, connected: status.email.oauth.connected === true, cliChecked: status.email.cli?.checked === true, accountObserved: status.email.account?.observed === true },
    routesMutatedByVerification: false, providerTurnsRequestedByVerification: 0, errors: []
  };
  const output = path.join(work, 'reopen-verification.json');
  await fs.writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ verified: true, version: receipt.version, pid: launchPid, sourceFiles: receipt.sourceFilesVerified, installedFiles: installedCount, receipt: output }));
}

const deadline = setTimeout(() => { console.error(JSON.stringify({ verified: false, error: 'Native reopening verification exceeded 60 seconds.' })); process.exit(1); }, 60_000);
try { await verify(); }
catch (error) { console.error(JSON.stringify({ verified: false, error: error.message })); process.exitCode = 1; }
finally { clearTimeout(deadline); }
