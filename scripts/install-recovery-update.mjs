/** Guarded BLACKICE 2.26.0 local recovery update from the exact inspected 2.25.0 install.
 * Usage: node scripts/install-recovery-update.mjs SOURCE INSTALLED_APP --prepare
 *        node scripts/install-recovery-update.mjs SOURCE INSTALLED_APP --commit PLAN_SHA256
 * This update neither launches the app nor modifies profile or connector settings.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appFingerprint } from './release-check.mjs';
import { validatePatchPath, captureSourceFiles, verifyCanonicalSource, commitOperations, installedFile } from './install-background-update.mjs';

const VERSION = '2.26.0', PREVIOUS_VERSION = '2.25.0';
export const BASELINE_FINGERPRINT = '09743cab1f3ba2d9ba7100b38f1b44f5cc67523f72c9d2ed71defed19acdbfed';
export const BASELINE_SHA256 = '59d7a42f9c3c9fec7cf2c21d3b1eb24c6bf14f5c428ad2bb89627b7e24f51955';
const BASELINE_FILE = 'baseline-2.25.0.json';
const MAXIMUM_PATCH_BYTES = 64 * 1024 * 1024, MAXIMUM_BACKUP_BYTES = 128 * 1024 * 1024;
const SHA256 = /^[a-f\d]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sameDirectory = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const overlaps = (left, right) => { const a = left.toLowerCase(), b = right.toLowerCase(); return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep); };
const invariant = (condition, message) => { if (!condition) throw Error(message); };
const readJson = async file => JSON.parse((await readRegular(file)).bytes.toString('utf8').replace(/^\uFEFF/, ''));
function requireSources(actual, expected, label, subset) {
  const keys = subset || Object.keys(expected);
  invariant(object(actual) && Object.keys(actual).length === keys.length && keys.every(key => SHA256.test(expected[key] || '') && actual[key] === expected[key]), label + ' differs from the exact candidate source files.');
}

export function validateRecoveryBaseline(bytes, { source, installed, candidate } = {}) {
  invariant(Buffer.isBuffer(bytes) && hash(bytes) === BASELINE_SHA256, 'Supply the exact inspected 2.25.0 baseline bytes.');
  const baseline = JSON.parse(bytes);
  invariant(baseline.format === 1 && baseline.product === 'BLACKICE' && baseline.version === PREVIOUS_VERSION && baseline.appFingerprint === BASELINE_FINGERPRINT && Object.keys(baseline.sourceFiles || {}).length === 511 && Object.keys(baseline.installedFiles || {}).length === 283 && Object.keys(baseline.preservedSourceFiles || {}).length === 447, 'The recovery baseline has an invalid identity or inventory.');
  for (const [key, actual] of Object.entries({ source, installed, candidate })) if (actual) invariant(sameDirectory(actual, baseline[key]), 'The baseline belongs to a different ' + key + ' directory.');
  for (const [relative, sha256] of Object.entries(baseline.sourceFiles)) { validatePatchPath(relative); invariant(SHA256.test(sha256), 'Invalid baseline source hash.'); }
  for (const [relative, file] of Object.entries(baseline.installedFiles)) { validatePatchPath(relative); invariant(SHA256.test(baseline.sourceFiles[relative] || '') && SHA256.test(file.sha256 || '') && Number.isSafeInteger(file.bytes) && file.bytes >= 0, 'Invalid baseline installed file.'); }
  return baseline;
}

export function candidateChanges(baseline, sourceFiles) {
  invariant(object(sourceFiles) && Object.keys(sourceFiles).length <= 10000, 'Supply the complete candidate source map.');
  invariant(Object.keys(baseline.sourceFiles).every(relative => sourceFiles[relative]), 'The candidate omitted a baseline file; this updater does not remove files.');
  const seen = new Set(), preserved = new Set(Object.keys(baseline.preservedSourceFiles).map(file => file.toLowerCase()));
  for (const [relative, sha256] of Object.entries(sourceFiles)) {
    validatePatchPath(relative);
    invariant(SHA256.test(sha256 || '') && !seen.has(relative.toLowerCase()) && !preserved.has(relative.toLowerCase()), 'Unsafe, conflicting or invalid candidate path: ' + relative);
    seen.add(relative.toLowerCase());
  }
  return Object.entries(sourceFiles).filter(([file, sha256]) => baseline.sourceFiles[file] !== sha256).map(([file, sha256]) => ({ path: file, sha256, previousSha256: baseline.sourceFiles[file] ?? null }));
}

export async function verifyInstalledFiles(root, expected) {
  for (const [relative, sha256] of Object.entries(expected)) {
    const actual = await readFrom(root, validatePatchPath(relative));
    invariant(hash(actual.bytes) === sha256, 'An installed application file differs from its inspected hash: ' + relative);
  }
  return Object.keys(expected).length;
}

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
  const temporary = target + `.blackice-ui-${randomUUID()}.tmp`;
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


const expectedOptionalSkips = [
  'Relay-owned sign-in and local storage survive a full process restart without foregrounding',
  'restored hidden browser tabs defer requests until used and never load closed or replaced pages',
  'real headless Firefox operates disposable pages and keeps its own sign-in across a clean restart',
  'live background accessibility actions change only a dedicated non-activating fixture and leave foreground and cursor untouched',
];
const uiSources = ['public/conversation.css','public/blackice-experience.css','public/run-state-model.mjs','public/icon-symbols.mjs','lib/harness-identity.mjs', 'public/planning-mode.mjs', 'public/task-plan-map.mjs', 'public/task-plan.css', 'public/blackice-material.css', 'public/assets/blackice-field.svg', 'public/assets/blackice-wordmark.svg', 'server.mjs', 'lib/engine.mjs', 'lib/task-state.mjs', 'lib/task-plan.mjs', 'lib/cron.mjs', 'lib/projects.mjs', 'lib/subagents.mjs', 'lib/agent-email.mjs', 'public/app.js', 'public/index.html', 'public/workspace-integrations.mjs', 'public/mission-ui.mjs', 'public/task-plan-ui.mjs', 'public/advanced-ui.mjs', 'public/email-ui.mjs', 'public/email.css', 'scripts/revised-workspace-ui-qa.mjs'];
export const RECOVERY_FLAGS = Object.freeze([
  'workspace.blockedCardsAccurate',
  'map.liveUpdatePreservedFocus', 'map.keyboardPanPreserved', 'map.enabledZoomFallback',
  'directions.newDraftUsable', 'directions.originLockRestored', 'directions.lateErrorOwned',
  'directions.otherDraftPreservedAfterError', 'directions.lateSuccessPreservedOtherDraft', 'directions.originRetryEnabled',
  'emptyPlans.missing.conversationDefault', 'emptyPlans.missing.planReachable', 'emptyPlans.missing.explicitChoicePreserved',
  'emptyPlans.unavailable.conversationDefault', 'emptyPlans.unavailable.planReachable', 'emptyPlans.unavailable.explicitChoicePreserved',
  'header.stoppingUntilSettled', 'header.readyAfterSettlement',
  'composer.offControlsSeparated', 'composer.unavailableControlsSeparated',
]);
const evidencePaths = ['qa-regression-root/regression-report.json', 'qa-regression-root/regression.tap', 'qa-workspace-final/revised-workspace-ui-report.json'];

export function validateRecoveryEvidence({ regression, tap, ui, fingerprint, sourceFiles, candidate }) {
  const invariant = (condition, message) => { if (!condition) throw Error(message); };
  for (const [name, receipt] of [['workspace UI', ui], ['regression', regression]]) invariant(receipt && !receipt.error && !receipt.cleanupError && !receipt.cleanupErrors?.length && !receipt.runnerError, 'The ' + name + ' receipt contains an error.');
  const count = name => { const values = [...tap.matchAll(new RegExp('^# ' + name + ' (\\d+)\\r?$', 'gm'))]; return values.length ? Number(values.at(-1)[1]) : null; };
  invariant(regression?.format === 1 && regression.product === 'BLACKICE' && regression.version === VERSION && regression.platform === 'win32' && regression.passed === true && regression.exitCode === 0 && !regression.timedOut && !regression.error && regression.unchanged === true && regression.appFingerprintBefore === fingerprint && regression.appFingerprintAfter === fingerprint && sameDirectory(regression.candidate, candidate), 'Require successful Windows regression on this exact candidate.');
  requireSources(regression.sourceHashesBefore, sourceFiles, 'Regression source inventory before');
  requireSources(regression.sourceHashesAfter, sourceFiles, 'Regression source inventory after');
  invariant(regression.testFiles === Object.keys(sourceFiles).filter(file => /^tests\/[^/]+\.test\.mjs$/.test(file)).length, 'Regression did not include every top-level test file.');
  const counts = { total: count('tests'), passed: count('pass'), failed: count('fail'), cancelled: count('cancelled'), skipped: count('skipped') };
  invariant(same(counts, regression.tests) && counts.total > 2690 && counts.passed > 2690 && counts.failed === 0 && counts.cancelled === 0 && counts.total === counts.passed + counts.skipped && counts.skipped === 4 && hash(Buffer.from(tap)) === regression.logSha256, 'Regression TAP counts or bytes do not match the successful receipt.');
  const skipped = tap.split(/\r?\n/).filter(line => /# SKIP\b/.test(line));
  invariant(skipped.length === expectedOptionalSkips.length && expectedOptionalSkips.every(name => skipped.some(line => line.includes(name))) && same(skipped, regression.skips), 'Only the four explicitly optional browser/desktop fixtures may be skipped.');
  invariant(ui?.ok === true && ui.version === VERSION && ui.platform === 'win32' && sameDirectory(ui.candidate, candidate) && ui.appFingerprintBefore === fingerprint && ui.appFingerprintAfter === fingerprint && ui.unchangedDuringChecks === true && ui.serverClosed === true && ui.disposableStateRemoved === true && Array.isArray(ui.checks) && ui.checks.length >= 60 && ui.passed === ui.checks.length && new Set(ui.checks).size === ui.checks.length && Array.isArray(ui.pageErrors) && ui.pageErrors.length === 0 && Array.isArray(ui.emailCliCalls) && ui.emailCliCalls.length === 0 && ui.runtimeCalls?.length === 6 && ui.runtimeCalls.every(call => call.externalRequests === 0 && call.harnessIdentified === true), 'Require current background-workspace UI acceptance with clean, exclusively local fixtures.');
  invariant(ui.cancellation?.directionRequests === 3 && ui.cancellation?.directionRequestScope === 'entire-owned-fixture' && ui.cancellation?.stopJourneyDirectionRequests === 1 && ui.cancellation?.cancellationObserved === 1 && ui.cancellation?.settled === true && ui.cancellation?.status === 'cancelled' && /\bStopping\b/.test(ui.cancellation?.pendingStatus || '') && !/\bStopped\b/.test(ui.cancellation?.pendingStatus || '') && ui.cancellation?.settledStatus === 'Stopped' && ui.checks.some(name => /Stop stays available while a direction request is pending/.test(name)) && ui.checks.some(name => /Only acknowledged cancellation is marked stopped/.test(name)), 'Require real UI cancellation while direction submission is pending and verified settlement.');
  invariant(same(ui.planning?.choices, ['maximal','on','auto','off']) && object(ui.planning?.descriptions) && ['maximal','on','auto','off'].every(mode => typeof ui.planning.descriptions[mode] === 'string' && ui.planning.descriptions[mode].length > 20) && ui.planning.plannedMode === 'on' && ui.planning.offMode === 'off' && ui.planning.offCompleted === true && ui.planning.offToolCalls === 0 && ui.planning.offFinalVisible === true, 'Require real UI planning mode controls and a completed Off turn without automatic plan calls.');
  invariant(same(ui.mindMap?.savedNodeIds, ['inspect','save']) && ['dependenciesVisible','sharedNotesVisible','focusPreservesTree','zoomChangesViewport','keyboardSelection','hoverPreservesPosition','internallyScrollable'].every(key => ui.mindMap[key] === true) && Number.isFinite(ui.mindMap.readingTitlePx) && ui.mindMap.readingTitlePx >= 11, 'Require the rendered mind map to preserve saved steps, dependencies, notes, focus and keyboard selection.');
  invariant(ui.visual?.sceneUsesSvg === true && ui.visual.gradientSurfaceCount === 6 && ui.visual.repeatedSceneInReadingPanels === false && same(ui.visual.vectorAssets?.map(asset => asset.name), ['blackice-field.svg','blackice-wordmark.svg']) && ui.visual.vectorAssets.every(asset => asset.served === true && asset.vectorOnly === true), 'Require served editable SVG assets and gradient reading surfaces in the real UI.');
  requireSources(ui.before, sourceFiles, 'UI source bindings before', uiSources);
  requireSources(ui.after, sourceFiles, 'UI source bindings after', uiSources);
  invariant(ui.checks.some(name => /plan.*before.*answer|task pane appears before the answer/i.test(name)), 'UI acceptance lacks the plan-before-answer contract.');
  for (const file of ['tests/tool-settlement.test.mjs', 'tests/runtime-reconnect-queue.test.mjs', 'tests/mission-ui.test.mjs', 'tests/recovery-update.test.mjs']) invariant(SHA256.test(sourceFiles[file] || ''), 'The candidate lacks a required recovery test: ' + file);
  const cases = ['API Stop keeps a real pending patch leased', 'API close drains an admitted callback', 'native cancel retains a held dynamic callback', 'native exit retains a held dynamic callback', 'native close retains a held dynamic callback', 'successful reconnect wakes a persisted explicit queue'];
  invariant(cases.every(name => tap.includes(name)), 'Regression evidence lacks the real recovery scenarios.');
  for (const field of RECOVERY_FLAGS) {
    const value = field.split('.').reduce((current, key) => current?.[key], ui.recovery);
    invariant(value === true, 'The real UI recovery check did not pass: ' + field);
  }
  invariant(ui.recovery.directions.requests === 3 && Array.isArray(ui.recovery.directions.receipts) && same(ui.recovery.directions.receipts.map(receipt => receipt.accepted), [false, true, false]), 'Require all three controlled direction requests.');
  invariant(Array.isArray(ui.directionHttpReceipts) && same(ui.directionHttpReceipts.map(receipt => receipt.status), [409, 200, 409]) && ui.directionHttpReceipts.every(receipt => receipt.finished === true), 'Require the three completed real direction HTTP receipts.');
  return { regression: counts, uiChecks: ui.checks.length, localModelTurns: ui.runtimeCalls.length, controlledDirectionRequests: ui.recovery.directions.requests, recoveryChecks: RECOVERY_FLAGS, runtimeFixtures: cases, externalProviderRequests: 0, emailCliCalls: 0 };
}

export async function installRecoveryUpdate(args = process.argv.slice(2)) {
  if (process.platform !== 'win32' || ![3, 4].includes(args.length) || !['--prepare', '--commit'].includes(args[2]) || args[2] === '--prepare' && args.length !== 3 || args[2] === '--commit' && !SHA256.test(args[3] || '')) throw Error('Supply SOURCE INSTALLED_APP --prepare, or SOURCE INSTALLED_APP --commit PLAN_SHA256 on Windows.');
  const candidate = await directoryRoot(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const work = path.dirname(candidate);
  const [source, installed] = await Promise.all(args.slice(0, 2).map(directoryRoot));
  if (overlaps(source, installed) || overlaps(source, candidate) || overlaps(installed, candidate) || path.basename(installed).toLowerCase() !== 'app' || path.basename(path.dirname(installed)).toLowerCase() !== 'resources' || path.basename(candidate) !== 'candidate' || !work.includes('blackice-2.26.0-execution-recovery')) throw Error('Use the isolated background candidate and distinct source/installed resources/app roots.');
  const locks = [], temporaries = new Set();
  let backup, result, failure;
  try {
    await acquireLock(path.join(path.dirname(source), `.${path.basename(source)}.blackice-recovery-update.lock`), locks);
    await acquireLock(path.join(path.dirname(installed), '.blackice-recovery-update.lock'), locks);
    nativeClosed(installed);
    const baselineBytes = (await readRegular(path.join(work, BASELINE_FILE))).bytes;
    const baseline = validateRecoveryBaseline(baselineBytes, { source, installed, candidate }), originalSourceFiles = baseline.sourceFiles;
    const sourceFiles = await captureSourceFiles(candidate), fingerprint = await appFingerprint(candidate);
    const changes = candidateChanges(baseline, sourceFiles);
    invariant(changes.some(file => file.path === 'package.json') && changes.some(file => file.path === 'UI-VALIDATION.md'), 'The candidate must include its new version and validation scope.');
    const evidenceHashes = Object.fromEntries(await Promise.all(evidencePaths.map(async file => [file, hash((await readRegular(path.join(work, file))).bytes)])));
    const [regression, ui] = await Promise.all([evidencePaths[0], evidencePaths[2]].map(file => readJson(path.join(work, file))));
    const tap = (await readRegular(path.join(work, evidencePaths[1]))).bytes.toString('utf8');
    const accepted = validateRecoveryEvidence({ regression, tap, ui, fingerprint, sourceFiles, candidate });
    const installedBeforeFiles = Object.fromEntries(Object.entries(baseline.installedFiles).map(([file, value]) => [file, value.sha256]));
    await verifyInstalledFiles(installed, installedBeforeFiles);
    const installedAfterFiles = { ...installedBeforeFiles };
    for (const file of changes) if (installedFile(file.path)) installedAfterFiles[file.path] = file.sha256;
    for (const [root, version] of [[candidate, VERSION], [source, PREVIOUS_VERSION], [installed, PREVIOUS_VERSION]]) if (JSON.parse((await readFrom(root, 'package.json')).bytes).version !== version) throw Error('An application version changed before the update.');
    const [sourceBefore, installedBefore] = await Promise.all([appFingerprint(source), appFingerprint(installed)]);
    if (sourceBefore !== BASELINE_FINGERPRINT || installedBefore !== BASELINE_FINGERPRINT) throw Error('The source or installed runtime differs from the inspected 2.25.0 baseline.');
    const sourceBeforeInventory = await verifyCanonicalSource(source, { releaseFiles: sourceFiles, expectedFiles: originalSourceFiles, expectedExtras: baseline.preservedSourceFiles });
    const operations = []; let patchBytes = 0, backupBytes = 0;
    for (const file of changes) {
      const next = await readFrom(candidate, file.path); patchBytes += next.bytes.length;
      if (patchBytes > MAXIMUM_PATCH_BYTES || hash(next.bytes) !== file.sha256) throw Error('The candidate patch changed or exceeds its byte limit.');
      for (const [scope, root] of [['source', source], ...(installedFile(file.path) ? [['installed', installed]] : [])]) {
        const original = await readFrom(root, file.path, true), previousSha256 = original ? hash(original.bytes) : null;
        backupBytes += original?.bytes.length || 0;
        if (backupBytes > MAXIMUM_BACKUP_BYTES) throw Error('The rollback backup exceeds its byte limit.');
        if (previousSha256 !== (scope === 'installed' ? (baseline.installedFiles[file.path]?.sha256 ?? null) : file.previousSha256)) throw Error('An original file differs from its inspected hash: ' + scope + '/' + file.path);
        operations.push({ scope, root, path: file.path, bytes: next.bytes, original: original?.bytes ?? null, mode: original?.mode ?? next.mode, originalMode: original?.mode ?? null, sha256: file.sha256, previousSha256 });
      }
    }
    const plan = { format: 1, product: 'BLACKICE', version: VERSION, previousVersion: PREVIOUS_VERSION, source, installed, candidate, originalFingerprint: BASELINE_FINGERPRINT, verifiedFingerprint: fingerprint, sourceFiles, baselineSha256: BASELINE_SHA256, installedBeforeFiles, installedAfterFiles, sourceUnmanaged: { fileCount: sourceBeforeInventory.extraFileCount, totalBytes: sourceBeforeInventory.extraBytes, sha256: sourceBeforeInventory.extraSha256 }, evidenceHashes, accepted, files: operations.map(({ bytes, original, root, ...item }) => ({ ...item, bytes: bytes.length, originalExisted: original !== null })) };
    const planBytes = Buffer.from(JSON.stringify(plan, null, 2) + '\n'), planSha256 = hash(planBytes), planFile = path.join(work, 'recovery-update-plan.json');
    if (args[2] === '--prepare') {
      const prior = await readRegular(planFile, { optional: true });
      if (prior && hash(prior.bytes) !== planSha256) throw Error('A different prepared update plan already exists; preserve it and review the changed inputs before preparing another.');
      if (!prior) await atomicWrite(planFile, planBytes, 0o600, temporaries);
      result = { prepared: true, installed: false, planFile, planSha256, sourceFiles: Object.keys(sourceFiles).length, sourceFilesToUpdate: operations.filter(item => item.scope === 'source').length, installedFilesToUpdate: operations.filter(item => item.scope === 'installed').length, patchBytes, backupBytes, appFingerprint: fingerprint, accepted };
    } else {
      if (planSha256 !== args[3] || hash((await readRegular(planFile)).bytes) !== args[3]) throw Error('The prepared update plan changed. No application files were written.');
      backup = path.join(work, 'recovery-update-backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID());
      await fs.mkdir(backup);
      for (const [name, bytes] of [['change-plan.json', planBytes], [BASELINE_FILE, baselineBytes]]) await atomicWrite(path.join(backup, name), bytes, 0o600, temporaries);
      for (const item of operations) if (item.original !== null) {
        const target = path.join(backup, item.scope, item.path); await fs.mkdir(path.dirname(target), { recursive: true });
        await atomicWrite(target, item.original, 0o600, temporaries);
        if (hash((await readRegular(target)).bytes) !== item.previousSha256) throw Error('A rollback backup failed verification: ' + item.path);
      }
      const recheckEvidence = async () => { validateRecoveryBaseline((await readRegular(path.join(work, BASELINE_FILE))).bytes, { source, installed, candidate }); for (const [file, expected] of Object.entries(evidenceHashes)) if (hash((await readRegular(path.join(work, file))).bytes) !== expected) throw Error('Verification evidence changed: ' + file); };
      await recheckEvidence();
      requireSources(await captureSourceFiles(candidate), sourceFiles, 'Candidate before installation');
      await verifyCanonicalSource(source, { releaseFiles: sourceFiles, expectedFiles: originalSourceFiles, expectedExtras: baseline.preservedSourceFiles });
      if (await appFingerprint(source) !== sourceBefore || await appFingerprint(installed) !== installedBefore) throw Error('Original application files changed while backups were prepared.');
      await verifyInstalledFiles(installed, installedBeforeFiles);
      let sourceAfterInventory;
      await commitOperations(operations, {
        assertClosed: () => nativeClosed(installed),
        verify: async () => {
          if (await appFingerprint(source) !== fingerprint || await appFingerprint(installed) !== fingerprint || await appFingerprint(candidate) !== fingerprint) throw Error('Updated runtimes do not match the verified candidate.');
          for (const item of operations) await checkOperation(item, item.sha256);
          sourceAfterInventory = await verifyCanonicalSource(source, { releaseFiles: sourceFiles, expectedFiles: sourceFiles, expectedExtras: baseline.preservedSourceFiles });
          requireSources(await captureSourceFiles(candidate), sourceFiles, 'Candidate after installation');
          await verifyInstalledFiles(installed, installedAfterFiles);
          await recheckEvidence();
        },
        verifyRollback: async () => {
          if (await appFingerprint(source) !== sourceBefore || await appFingerprint(installed) !== installedBefore) throw Error('Rollback did not restore both original runtime fingerprints.');
          await verifyInstalledFiles(installed, installedBeforeFiles);
          await verifyCanonicalSource(source, { releaseFiles: sourceFiles, expectedFiles: originalSourceFiles, expectedExtras: baseline.preservedSourceFiles });
        },
      });
      result = { format: 1, product: 'BLACKICE', version: VERSION, previousVersion: PREVIOUS_VERSION, installed: true, installedAt: new Date().toISOString(), source, installation: installed, candidate, appFingerprint: fingerprint, originalFingerprint: BASELINE_FINGERPRINT, planSha256, baselineSha256: BASELINE_SHA256, installedFilesVerified: Object.keys(installedAfterFiles).length, sourceFilesVerified: Object.keys(sourceFiles).length, sourceFilesUpdated: operations.filter(item => item.scope === 'source').length, installedFilesUpdated: operations.filter(item => item.scope === 'installed').length, fullRuntimeMatch: true, backupDirectory: backup, allChangedFilesBackedUp: true, sourceUnmanaged: { beforeSha256: sourceBeforeInventory.extraSha256, afterSha256: sourceAfterInventory.extraSha256, fileCount: sourceAfterInventory.extraFileCount, preserved: true }, nativeAppLaunched: false, existingProfileDataPreserved: true, profileSettingsWritten: false, connectorSettingsWritten: false, installerArchivesRebuilt: false, accepted, evidenceHashes };
      await atomicWrite(path.join(work, 'installation-verification.json'), Buffer.from(JSON.stringify(result, null, 2) + '\n'), 0o600, temporaries);
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
  try { console.log(JSON.stringify(await installRecoveryUpdate(), null, 2)); }
  catch (error) { console.error(JSON.stringify({ installed: error.installed === true, error: error.message, backupDirectory: error.backupDirectory || null, rollback: error.rollback || null, cleanupError: error.cleanupError || null }, null, 2)); process.exitCode = 1; }
}

