#!/usr/bin/env node
/** Guarded BLACKICE 2.30 shared-editing and OAuth email update.
 * --prepare writes the immutable reviewed plan without stopping the installed app.
 * --commit PLAN_SHA256 requires separate fresh idle/normal-close evidence and
 * repeats every candidate, baseline, backup and acceptance hash guard.
 * This helper does not launch, close or configure the installed application.
 */
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appFingerprint } from './release-check.mjs';
import { validatePatchPath, captureSourceFiles, verifyCanonicalSource, commitOperations, installedFile } from './install-background-update.mjs';
import { candidateChanges, verifyInstalledFiles } from './install-planning-update.mjs';
import { SOURCES as UI_SOURCES, REQUIRED_FEATURES } from './planning-remote-ui-qa.mjs';
import { HEADLESS_QA_CHECKS, HEADLESS_QA_SOURCES } from './headless-desktop-qa.mjs';
import { EMAIL_OAUTH_NATIVE_QA_CHECKS, EMAIL_OAUTH_NATIVE_QA_SOURCES } from './email-oauth-native-qa.mjs';
import { REMOTE_ACCESS_NATIVE_QA_CHECKS, REMOTE_ACCESS_NATIVE_QA_SOURCES, validateRemoteAccessNativeReceipt } from './remote-access-native-qa.mjs';
import { validateAwarenessBaseline, AWARENESS_WORK, AWARENESS_VERSION as VERSION, AWARENESS_PREVIOUS_VERSION as PREVIOUS_VERSION, AWARENESS_BASELINE_SHA256 as BASELINE_SHA256, AWARENESS_BASELINE_FILE as BASELINE_FILE, AWARENESS_BASELINE_FINGERPRINT as BASELINE_FINGERPRINT } from './prepare-awareness-candidate.mjs';
import { validateAwarenessManifest } from './freeze-awareness-candidate.mjs';
import { requireAwarenessSources as requireSources, validateAwarenessRegression, validateAwarenessUI, validateAwarenessNative, validateAwarenessClosure } from './awareness-release-evidence.mjs';

const MAXIMUM_PATCH_BYTES = 64 * 1024 * 1024, MAXIMUM_BACKUP_BYTES = 128 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sameDirectory = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const overlaps = (left, right) => { const a = left.toLowerCase(), b = right.toLowerCase(); return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep); };
const invariant = (condition, message) => { if (!condition) throw Error(message); };
const readJson = async file => JSON.parse((await readRegular(file)).bytes.toString('utf8').replace(/^\uFEFF/, ''));
export const AWARENESS_EVIDENCE_PATHS = Object.freeze([
  'candidate-manifest.json', 'baseline-clone-verification.json',
  'qa-regression/regression-report.json', 'qa-regression/regression.tap',
  'qa-ui/planning-remote-ui-report.json', 'qa-headless/headless-desktop-report.json', 'qa-email/email-oauth-native-report.json',
  'qa-remote-access/remote-access-native-report.json',
]);

async function readRegular(file, { optional = false, maximum = MAXIMUM_PATCH_BYTES } = {}) {
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw Error('Expected a bounded regular file: ' + file);
    return { bytes: await fs.readFile(file), mode: info.mode & 0o777 };
  } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}

async function checkParents(root, relative, createdDirectories) {
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw Error('An application root became unavailable or linked.');
  let directory = root;
  for (const part of relative.split('/').slice(0, -1)) {
    directory = path.join(directory, part);
    let info;
    try { info = await fs.lstat(directory); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!createdDirectories) return;
      try { await fs.mkdir(directory); createdDirectories.push(directory); }
      catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
      info = await fs.lstat(directory);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Application patch parents cannot contain links: ' + relative);
  }
}

async function readFrom(root, relative, optional = false) {
  await checkParents(root, relative);
  return readRegular(path.join(root, relative), { optional });
}

async function atomicWrite(target, bytes, mode, temporaries) {
  const temporary = target + `.blackice-awareness-${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', mode);
  temporaries.add(temporary);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, target);
  temporaries.delete(temporary);
}

async function cleanupTemporaries(temporaries) {
  const errors = [];
  for (const file of temporaries) {
    try { await fs.rm(file, { force: true }); temporaries.delete(file); }
    catch (error) { errors.push(`${file}: ${error.message}`); }
  }
  if (errors.length) throw Error('Could not remove this updater’s temporary files: ' + errors.join('; '));
}

async function checkOperation(item, expected = item.previousSha256) {
  const current = await readFrom(item.root, item.path, true);
  if ((current ? hash(current.bytes) : null) !== expected) throw Error('An application file changed: ' + item.scope + '/' + item.path);
  return current;
}

function nativeClosed(installed) {
  const script = "$ErrorActionPreference='Stop'; $root=[IO.Path]::GetFullPath($env:BLACKICE_UI_INSTALL_ROOT).TrimEnd('\\')+'\\'; $count=0; foreach($p in Get-Process) { $file=$null; try { $file=$p.Path } catch { if($p.ProcessName -match '^(BLACKICE|Relay|Agent Desk)$') { throw 'Could not verify the BLACKICE process path.' } }; if($file -and $file.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) { $count++ }; if(-not $file -and $p.ProcessName -match '^(BLACKICE|Relay|Agent Desk)$') { throw 'Could not verify the BLACKICE process path.' } }; $count";
  const count = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, BLACKICE_UI_INSTALL_ROOT: path.resolve(installed, '../..') }, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024 }).trim();
  if (count !== '0') throw Error('BLACKICE is open. Close the native application before updating its files.');
}


async function directoryRoot(value) {
  const resolved = path.resolve(value), info = await fs.lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Supply ordinary application directories, without links.');
  return fs.realpath(resolved);
}

async function acquireLock(file, locks) {
  const token = `${process.pid}:${randomUUID()}`;
  let handle;
  try { handle = await fs.open(file, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw Error('An update lock already exists. Verify the previous updater has finished before clearing it: ' + file); throw error; }
  const lock = { file, token, complete: false }; locks.push(lock);
  try { await handle.writeFile(token); await handle.sync(); lock.complete = true; }
  finally { await handle.close(); }
}


export function validateAwarenessEvidence({ regression, tap, ui, headless, email, remoteAccess, fingerprint, sourceFiles, candidate }) {
  const context = { fingerprint, sourceFiles, candidate };
  const regressionAccepted = validateAwarenessRegression(regression, tap, context);
  const uiAccepted = validateAwarenessUI(ui, { ...context, requiredFeatures: REQUIRED_FEATURES, uiSources: UI_SOURCES });
  const headlessAccepted = validateAwarenessNative(headless, { ...context, name: 'headless Electron', requiredChecks: HEADLESS_QA_CHECKS, requiredSources: HEADLESS_QA_SOURCES });
  invariant(headless.profile?.disposable === true && headless.profile.custom === true, 'Headless acceptance must use a disposable explicit profile.');
  const emailAccepted = validateAwarenessNative(email, { ...context, name: 'OAuth email CLI/runtime', requiredChecks: EMAIL_OAUTH_NATIVE_QA_CHECKS, requiredSources: EMAIL_OAUTH_NATIVE_QA_SOURCES });
  invariant(email.providerMailboxConnected === false && email.providerNetworkTested === false && email.realAccountLogin === false && email.messageDeliveryAttempted === false, 'Email acceptance must accurately separate owned local fixtures from a real account connection or delivery.');
  invariant(Number.isSafeInteger(email.native?.pid) && email.native.pid > 0 && typeof email.native.electronVersion === 'string' && email.native.electronVersion.length > 0 && typeof email.native.nonce === 'string' && email.native.nonce.length >= 16 && email.native.cli?.version === '2.2.1' && path.win32.isAbsolute(email.native.cli.executable || '') && Array.isArray(email.native.cli.commands) && email.native.cli.commands.length > 0 && email.native.cli.commands.every(command => command.exitCode === 0 && command.providerRequest === false && Array.isArray(command.args) && command.args.length > 0), 'Require actual Electron and Himalaya command evidence from the owned native fixture.');
  invariant(email.profile?.disposable === true && email.profile.custom === true && email.runtime?.unchanged === true && SHA256.test(email.runtime.electronHashBefore || '') && SHA256.test(email.runtime.himalayaHashBefore || '') && email.runtime.electronHashBefore === email.runtime.electronHashAfter && email.runtime.himalayaHashBefore === email.runtime.himalayaHashAfter && sameDirectory(email.runtime.himalaya, email.native.cli.executable), 'Native email acceptance must bind unchanged executable bytes and a disposable explicit profile.');
  const remoteAccepted = validateAwarenessNative(remoteAccess, { ...context, name: 'native CLI pairing', requiredChecks: REMOTE_ACCESS_NATIVE_QA_CHECKS, requiredSources: REMOTE_ACCESS_NATIVE_QA_SOURCES });
  invariant(remoteAccess.fixtureOnly === true && remoteAccess.realRemoteExposure === false && remoteAccess.realCredentialIssued === false && remoteAccess.profile?.disposable === true && remoteAccess.profile.custom === true && remoteAccess.runtime?.unchanged === true && SHA256.test(remoteAccess.runtime.hashBefore || '') && remoteAccess.runtime.hashBefore === remoteAccess.runtime.hashAfter && remoteAccess.runtime.hashAfter === email.runtime.electronHashAfter && sameDirectory(remoteAccess.runtime.executable, email.runtime.electron), 'Native pairing must use the same measured executable and owned fixtures without publishing a real route or credential.');
  const native = remoteAccess.native;
  invariant(Number.isSafeInteger(native?.pid) && native.pid > 0 && /^[a-f0-9-]{36}$/.test(native.nonce || '') && path.win32.isAbsolute(native.profile || '') && path.win32.basename(native.profile) === 'owned-profile-' + native.nonce && native.runtime?.browserWindows === 0 && native.transport?.fixtureOnly === true && native.transport.tailscaleCommandsEmulated === true && native.transport.unexpected === 0, 'Native pairing requires its exact owned process, profile and non-activating fixture transport.');
  validateRemoteAccessNativeReceipt(native, { nonce: native.nonce, pid: native.pid, profile: native.profile, executable: remoteAccess.runtime.executable });
  return { regression: regressionAccepted, ui: uiAccepted, headless: headlessAccepted, email: emailAccepted, remoteAccess: { ...remoteAccepted, fixtureOnly: true, tlsValidated: true, realRemoteExposure: false, realCredentialIssued: false }, realAccountLoginVerified: false, providerMailboxConnected: false, messageDeliveryAttempted: false };
}

export async function verifyAwarenessExecutables(runtime) {
  const result = {};
  for (const name of ['electron', 'himalaya']) {
    const file = runtime?.[name], expected = runtime?.[name + 'HashAfter'];
    invariant(typeof file === 'string' && path.isAbsolute(file) && SHA256.test(expected || ''), 'Require the absolute measured executable and its exact SHA-256.');
    const info = await fs.lstat(file); invariant(info.isFile() && !info.isSymbolicLink(), 'A measured native executable is no longer an ordinary file.');
    const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk);
    invariant(digest.digest('hex') === expected, 'A measured native executable changed after acceptance: ' + name);
    result[name] = { file, sha256: expected };
  }
  return result;
}

async function writeExclusive(file, bytes) {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

async function verifyCompleteInstalled(root, expected) {
  const count = await verifyInstalledFiles(root, expected);
  requireSources(await captureSourceFiles(root), expected, 'Complete installed inventory');
  return count;
}

export async function installAwarenessUpdate(args = process.argv.slice(2)) {
  if (process.platform !== 'win32' || ![3, 4].includes(args.length) || !['--prepare', '--commit'].includes(args[2]) || args[2] === '--prepare' && args.length !== 3 || args[2] === '--commit' && !SHA256.test(args[3] || '')) throw Error('Supply SOURCE INSTALLED_APP --prepare, or SOURCE INSTALLED_APP --commit PLAN_SHA256 on Windows.');
  const candidate = await directoryRoot(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')), work = path.dirname(candidate);
  const [source, installed] = await Promise.all(args.slice(0, 2).map(directoryRoot));
  invariant(sameDirectory(work, AWARENESS_WORK) && !overlaps(source, installed) && !overlaps(source, candidate) && !overlaps(installed, candidate), 'Use the reviewed isolated 2.30 work/candidate and separate original application roots.');
  const locks = [], temporaries = new Set();
  let backup, result, failure;
  try {
    await acquireLock(path.join(path.dirname(source), `.${path.basename(source)}.blackice-awareness-update.lock`), locks);
    await acquireLock(path.join(path.dirname(installed), '.blackice-awareness-update.lock'), locks);
    const baselineBytes = (await readRegular(path.join(work, BASELINE_FILE))).bytes;
    const baseline = validateAwarenessBaseline(baselineBytes, { source, installed, candidate }), originalSourceFiles = baseline.sourceFiles;
    const sourceFiles = await captureSourceFiles(candidate), fingerprint = await appFingerprint(candidate);
    const evidenceHashes = Object.fromEntries(await Promise.all(AWARENESS_EVIDENCE_PATHS.map(async file => [file, hash((await readRegular(path.join(work, file))).bytes)])));
    const manifest = await readJson(path.join(work, 'candidate-manifest.json')); validateAwarenessManifest(manifest, baseline, sourceFiles);
    const clone = await readJson(path.join(work, 'baseline-clone-verification.json'));
    invariant(clone.product === 'BLACKICE' && clone.version === PREVIOUS_VERSION && clone.targetVersion === VERSION && clone.platform === 'win32' && clone.baselineSha256 === BASELINE_SHA256 && sameDirectory(clone.source, source) && sameDirectory(clone.installed, installed) && sameDirectory(clone.candidate, candidate) && clone.appFingerprint === BASELINE_FINGERPRINT && clone.sourceFilesVerified === Object.keys(originalSourceFiles).length && clone.installedFilesVerified === Object.keys(baseline.installedFiles).length && clone.completeInstalledInventory === true && clone.sourceUnmanaged?.preserved === true && clone.sourceUnmanaged.beforeSha256 === baseline.preservedSourceSummary.sha256 && clone.sourceUnmanaged.afterSha256 === baseline.preservedSourceSummary.sha256 && clone.sourceUnmanaged.fileCount === Object.keys(baseline.preservedSourceFiles).length && clone.originalSourceWritten === false && clone.installationWritten === false && clone.profileWritten === false && clone.nativeLifecycleChanged === false && Array.isArray(clone.errors) && clone.errors.length === 0, 'Require the complete freshly verified baseline clone receipt for this isolated work root.');
    const changes = candidateChanges(baseline, sourceFiles);
    invariant(changes.some(file => file.path === 'package.json') && changes.some(file => file.path === 'UI-VALIDATION.md') && changes.some(file => file.path === 'scripts/email-oauth-token.mjs'), 'The candidate must include its version, current validation scope and packaged OAuth token helper.');
    const [regression, ui, headless, email, remoteAccess] = await Promise.all(['qa-regression/regression-report.json', 'qa-ui/planning-remote-ui-report.json', 'qa-headless/headless-desktop-report.json', 'qa-email/email-oauth-native-report.json', 'qa-remote-access/remote-access-native-report.json'].map(file => readJson(path.join(work, file))));
    const tap = (await readRegular(path.join(work, 'qa-regression/regression.tap'))).bytes.toString('utf8');
    const accepted = validateAwarenessEvidence({ regression, tap, ui, headless, email, remoteAccess, fingerprint, sourceFiles, candidate });
    const runtimeExecutables = await verifyAwarenessExecutables(email.runtime);
    const installedBeforeFiles = Object.fromEntries(Object.entries(baseline.installedFiles).map(([file, value]) => [file, value.sha256]));
    await verifyCompleteInstalled(installed, installedBeforeFiles);
    const installedAfterFiles = { ...installedBeforeFiles };
    for (const file of changes) if (installedFile(file.path)) installedAfterFiles[file.path] = file.sha256;
    for (const [root, version] of [[candidate, VERSION], [source, PREVIOUS_VERSION], [installed, PREVIOUS_VERSION]]) invariant(JSON.parse((await readFrom(root, 'package.json')).bytes).version === version, 'An application version changed before the update.');
    const [sourceBefore, installedBefore] = await Promise.all([appFingerprint(source), appFingerprint(installed)]);
    invariant(sourceBefore === BASELINE_FINGERPRINT && installedBefore === BASELINE_FINGERPRINT, 'The source or installed runtime differs from the exact verified 2.29.0 baseline.');
    const sourceBeforeInventory = await verifyCanonicalSource(source, { releaseFiles: sourceFiles, expectedFiles: originalSourceFiles, expectedExtras: baseline.preservedSourceFiles });
    const operations = []; let patchBytes = 0, backupBytes = 0;
    for (const file of changes) {
      const next = await readFrom(candidate, file.path); patchBytes += next.bytes.length;
      invariant(patchBytes <= MAXIMUM_PATCH_BYTES && hash(next.bytes) === file.sha256, 'The candidate patch changed or exceeds its byte limit.');
      for (const [scope, root] of [['source', source], ...(installedFile(file.path) ? [['installed', installed]] : [])]) {
        const original = await readFrom(root, file.path, true), previousSha256 = original ? hash(original.bytes) : null;
        backupBytes += original?.bytes.length || 0;
        invariant(backupBytes <= MAXIMUM_BACKUP_BYTES, 'The rollback backup exceeds its byte limit.');
        invariant(previousSha256 === (scope === 'installed' ? (baseline.installedFiles[file.path]?.sha256 ?? null) : file.previousSha256), 'An original file differs from its inspected hash: ' + scope + '/' + file.path);
        operations.push({ scope, root, path: file.path, bytes: next.bytes, original: original?.bytes ?? null, mode: original?.mode ?? next.mode, originalMode: original?.mode ?? null, sha256: file.sha256, previousSha256 });
      }
    }
    const plan = { format: 1, product: 'BLACKICE', version: VERSION, previousVersion: PREVIOUS_VERSION, source, installed, candidate, originalFingerprint: BASELINE_FINGERPRINT, verifiedFingerprint: fingerprint, sourceFiles, baselineSha256: BASELINE_SHA256, installedBeforeFiles, installedAfterFiles, sourceUnmanaged: { fileCount: sourceBeforeInventory.extraFileCount, totalBytes: sourceBeforeInventory.extraBytes, sha256: sourceBeforeInventory.extraSha256 }, evidenceHashes, runtimeExecutables, accepted, files: operations.map(({ bytes, original, root, ...item }) => ({ ...item, bytes: bytes.length, originalExisted: original !== null })) };
    const planBytes = Buffer.from(JSON.stringify(plan, null, 2) + '\n'), planSha256 = hash(planBytes), planFile = path.join(work, 'awareness-update-plan.json');
    if (args[2] === '--prepare') {
      const prior = await readRegular(planFile, { optional: true });
      invariant(!prior || hash(prior.bytes) === planSha256, 'A different prepared update plan exists. Preserve it and review the changed inputs before another preparation.');
      if (!prior) await writeExclusive(planFile, planBytes);
      result = { prepared: true, installed: false, normalCloseRequiredBeforeCommit: true, planFile, planSha256, sourceFiles: Object.keys(sourceFiles).length, sourceFilesToUpdate: operations.filter(item => item.scope === 'source').length, installedFilesToUpdate: operations.filter(item => item.scope === 'installed').length, patchBytes, backupBytes, appFingerprint: fingerprint, accepted };
    } else {
      invariant(planSha256 === args[3] && hash((await readRegular(planFile)).bytes) === args[3], 'The reviewed update plan changed. No application files were written.');
      const idleBytes = (await readRegular(path.join(work, 'pre-install-idle-verification.json'))).bytes, closeBytes = (await readRegular(path.join(work, 'native-close-verification.json'))).bytes;
      const closureEvidenceHashes = { 'pre-install-idle-verification.json': hash(idleBytes), 'native-close-verification.json': hash(closeBytes) };
      const closure = validateAwarenessClosure(JSON.parse(idleBytes), JSON.parse(closeBytes), { planSha256, idleSha256: hash(idleBytes), installed });
      nativeClosed(installed);
      backup = path.join(work, 'awareness-update-backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID());
      await fs.mkdir(backup);
      for (const [name, bytes] of [['change-plan.json', planBytes], [BASELINE_FILE, baselineBytes], ['pre-install-idle-verification.json', idleBytes], ['native-close-verification.json', closeBytes]]) await writeExclusive(path.join(backup, name), bytes);
      for (const item of operations) if (item.original !== null) {
        const target = path.join(backup, item.scope, item.path); await fs.mkdir(path.dirname(target), { recursive: true });
        await atomicWrite(target, item.original, 0o600, temporaries);
        invariant(hash((await readRegular(target)).bytes) === item.previousSha256, 'A rollback backup failed verification: ' + item.path);
      }
      const recheckEvidence = async () => {
        validateAwarenessBaseline((await readRegular(path.join(work, BASELINE_FILE))).bytes, { source, installed, candidate });
        invariant(hash((await readRegular(planFile)).bytes) === planSha256, 'The reviewed update plan changed.');
        for (const [file, expected] of Object.entries({ ...evidenceHashes, ...closureEvidenceHashes })) invariant(hash((await readRegular(path.join(work, file))).bytes) === expected, 'Verification evidence changed: ' + file);
        await verifyAwarenessExecutables(email.runtime);
      };
      await recheckEvidence();
      requireSources(await captureSourceFiles(candidate), sourceFiles, 'Candidate before installation');
      await verifyCanonicalSource(source, { releaseFiles: sourceFiles, expectedFiles: originalSourceFiles, expectedExtras: baseline.preservedSourceFiles });
      invariant(await appFingerprint(source) === sourceBefore && await appFingerprint(installed) === installedBefore, 'Original application files changed while backups were prepared.');
      await verifyCompleteInstalled(installed, installedBeforeFiles);
      let sourceAfterInventory;
      await commitOperations(operations, {
        assertClosed: () => nativeClosed(installed),
        verify: async () => {
          for (const root of [source, installed, candidate]) invariant(await appFingerprint(root) === fingerprint, 'An updated runtime does not match the verified candidate.');
          for (const item of operations) await checkOperation(item, item.sha256);
          sourceAfterInventory = await verifyCanonicalSource(source, { releaseFiles: sourceFiles, expectedFiles: sourceFiles, expectedExtras: baseline.preservedSourceFiles });
          requireSources(await captureSourceFiles(candidate), sourceFiles, 'Candidate after installation');
          await verifyCompleteInstalled(installed, installedAfterFiles); await recheckEvidence();
        },
        verifyRollback: async () => {
          invariant(await appFingerprint(source) === sourceBefore && await appFingerprint(installed) === installedBefore, 'Rollback did not restore both original runtime fingerprints.');
          await verifyCompleteInstalled(installed, installedBeforeFiles);
          await verifyCanonicalSource(source, { releaseFiles: sourceFiles, expectedFiles: originalSourceFiles, expectedExtras: baseline.preservedSourceFiles });
        },
      });
      result = { format: 1, product: 'BLACKICE', version: VERSION, previousVersion: PREVIOUS_VERSION, installed: true, installedAt: new Date().toISOString(), source, installation: installed, candidate, appFingerprint: fingerprint, originalFingerprint: BASELINE_FINGERPRINT, planSha256, baselineSha256: BASELINE_SHA256, installedFilesVerified: Object.keys(installedAfterFiles).length, sourceFilesVerified: Object.keys(sourceFiles).length, sourceFilesUpdated: operations.filter(item => item.scope === 'source').length, installedFilesUpdated: operations.filter(item => item.scope === 'installed').length, fullRuntimeMatch: true, completeInstalledInventory: true, backupDirectory: backup, allChangedFilesBackedUp: true, sourceUnmanaged: { beforeSha256: sourceBeforeInventory.extraSha256, afterSha256: sourceAfterInventory.extraSha256, fileCount: sourceAfterInventory.extraFileCount, preserved: true }, nativeAppLaunched: false, existingProfileDataPreserved: true, profileSettingsWritten: false, connectorSettingsWritten: false, installerArchivesRebuilt: false, accepted, evidenceHashes, closure, closureEvidenceHashes };
      await writeExclusive(path.join(work, 'installation-verification.json'), Buffer.from(JSON.stringify(result, null, 2) + '\n'));
    }
  } catch (error) { failure = error; failure.backupDirectory = backup; }
  finally {
    try { await cleanupTemporaries(temporaries); } catch (error) { if (failure) failure.cleanupError = error.message; else failure = error; }
    for (const lock of locks.reverse()) try { const current = await readRegular(lock.file, { optional: true }); const contents = current?.bytes.toString('utf8'); if (current && (contents === lock.token || !lock.complete && lock.token.startsWith(contents))) await fs.unlink(lock.file); else if (current) throw Error('An update lock changed ownership and was preserved.'); } catch (error) { if (failure) failure.cleanupError = error.message; else failure = error; }
  }
  if (failure) { if (result?.installed) failure.installed = true; throw failure; }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await installAwarenessUpdate(), null, 2)); }
  catch (error) { console.error(JSON.stringify({ installed: error.installed === true, error: error.message, backupDirectory: error.backupDirectory || null, rollback: error.rollback || null, cleanupError: error.cleanupError || null }, null, 2)); process.exitCode = 1; }
}
