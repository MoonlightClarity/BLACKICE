/** Guarded local BLACKICE background-workspace update, not a public Setup release.
 * Adapted from the previous updater's unchanged conflict/rollback primitives.
 * Revised acceptance requires current full Windows regression, UI, native plan,
 * real contained-browser and installed-CLI local Maildir receipts.
 * Usage: node scripts/install-background-update.mjs SOURCE INSTALLED_APP --prepare
 *        node scripts/install-background-update.mjs SOURCE INSTALLED_APP --commit PLAN_SHA256
 * Does not launch BLACKICE, open a profile, contact email, or change connections.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appFingerprint } from './release-check.mjs';
import { assessPlanAcceptance } from './verify-task-plan-runtime.mjs';
import { TASK_TOOL } from '../lib/task-state.mjs';

const VERSION = '2.25.0';
const PREVIOUS_VERSION = '2.24.1';
export const BASELINE_FINGERPRINT = '8928f8e1fe57bb37fbd1b378cbbed4240b73e616955233754ac24bcc20d9a731';
const BASELINE_SOURCE_COUNT = 497;
const BASELINE_CANONICAL_SHA256 = 'ece8362dfb025cfe78549631348e0dfa07c2cb477324f609660f9602c04c1378';
const SOURCE_UNMANAGED_INSPECTION = 'source-unmanaged-inspection.json';
const NATIVE_HELPER = 'scripts/verify-task-plan-runtime.mjs';
export const SOURCE_UNMANAGED_INSPECTION_SHA256 = '0a856fadeb0ad2efebb47b02723b7a766ccfad64bd2a20b901f2d040e716e063';
const SOURCE_UNMANAGED_SUMMARY = Object.freeze({ fileCount: 447, totalBytes: 8152873, sha256: '4addba0af73b752d2c7a318bd924e45fe29281b32f0e8684188ce58d94c292e0' });
const NATIVE_SOURCE_FILES = ['lib/planning-policy.mjs','lib/harness-identity.mjs','public/planning-mode.mjs','lib/engine.mjs','lib/task-state.mjs','lib/task-plan.mjs','lib/methods.mjs','lib/process-ontology.mjs','lib/tool-routing.mjs','lib/codex.mjs','public/mission-model.mjs',NATIVE_HELPER];
const NATIVE_CHECKS = ['oneExactModelTurn','completedRun','initialRootWasHonest','agentAuthoredPlan','currentSchemaUsed','plannedBeforeFileWrite','manageableBranches','evidenceForCompletedActions','explicitPlanCompletion','originalInputsRead','savedResultReadBack','correctResult','registeredActualResult','onlyRequestedToolWork','exactArtifactHash','exactSchema'];
const MAXIMUM_PATCH_BYTES = 64 * 1024 * 1024;
const MAXIMUM_BACKUP_BYTES = 128 * 1024 * 1024;
const MAXIMUM_SOURCE_EXTRA_BYTES = 128 * 1024 * 1024;
const SHA256 = /^[a-f\d]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const lexical = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const normalizedMap = value => Object.fromEntries(Object.entries(value).sort(([left], [right]) => lexical(left, right)));
const sameDirectory = (left, right) => {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
};
const documents = new Set(['CHAT-MODE.md', 'RELEASE-NOTES-2.31.0.md', 'README.md', 'RELEASE-NOTES.md', 'CHATGPT-BRIDGE.md', 'CHATGPT-CONNECTOR.md', 'BROWSER-IMPORT.md', 'UI-VALIDATION.md', 'METHODS.md', 'APPLICATION-COMPATIBILITY.md', 'EMAIL.md', 'REMOTE-ACCESS.md', 'BROWSER-PROTECTION.md', 'PLANNING-AWARENESS.md', 'RELEASE-NOTES-2.30.0.md', 'RELEASE-NOTES-2.29.0.md', 'RELEASE-NOTES-2.24.0.md', 'RELEASE-NOTES-2.24.1.md', 'RELEASE-NOTES-2.25.0.md']);
const sourceDocuments = new Set(['RELEASE-NOTES-2.23.md', 'RELEASE-NOTES-2.23.1.md', 'RELEASE-NOTES-2.24.0.md', 'RELEASE-NOTES-2.24.1.md', 'RELEASE-NOTES-2.25.0.md']);
// Match desktop/electron-builder.yml's explicit packaged runtime files. The
// source tree also contains icon sources and build tools that are not installed.
const installedDesktopFiles = new Set([
  'desktop/main.mjs',
  'desktop/clipboard.mjs',
  'desktop/lifecycle.mjs',
  'desktop/maintenance-helper.mjs',
  'desktop/browser-driver.mjs',
  'desktop/browser-capture.mjs',
  'desktop/browser-router.mjs',
  'desktop/firefox-driver.mjs',
  'desktop/firefox-lazy.mjs',
  'desktop/preload.cjs',
  'desktop/icon.ico',
]);
export function validatePatchPath(relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 240 || !/^[A-Za-z0-9_./-]+$/.test(relative)) throw Error('Unsafe patch path.');
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw Error('Unsafe patch path: ' + relative);
  if (parts.some(part => ['node_modules', 'data', 'workspace', 'dist', '.build', '.git'].includes(part.toLowerCase()) || part.includes('.currents-backup-') || part.endsWith('.tmp'))) throw Error('Patch paths cannot include profiles, generated files, or backups: ' + relative);
  if (!['package.json', 'package-lock.json', 'server.mjs', '.gitignore'].includes(relative) && !documents.has(relative) && !sourceDocuments.has(relative) && !/^(?:lib|public|desktop|scripts|tests|assets)\//.test(relative)) throw Error('Patch path is outside the application source: ' + relative);
  return relative;
}

function validateManifest(manifest) {
  if (manifest?.format !== 1 || manifest.product !== 'BLACKICE' || manifest.version !== VERSION || manifest.originalFingerprint !== BASELINE_FINGERPRINT || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 10000) throw Error('Supply the complete BLACKICE 2.25.0 change manifest for the inspected 2.24.1 baseline.');
  const seen = new Set();
  for (const file of manifest.files) {
    validatePatchPath(file?.path);
    const key = file.path.toLowerCase();
    if (seen.has(key) || !SHA256.test(file.sha256 || '') || (file.previousSha256 !== null && !SHA256.test(file.previousSha256 || ''))) throw Error('Invalid or repeated manifest entry: ' + file.path);
    seen.add(key);
  }
  if (!seen.has('ui-validation.md') || !seen.has('package.json')) throw Error('The update manifest must include package.json and UI-VALIDATION.md.');
}

export function validateSourceBaseline(value) {
  if (!object(value) || value.format !== 1 || value.product !== 'BLACKICE' || value.version !== PREVIOUS_VERSION || value.fingerprint !== BASELINE_FINGERPRINT || !object(value.files) || Object.keys(value.files).length !== BASELINE_SOURCE_COUNT || Object.keys(value).some(key => !['format','product','version','fingerprint','files'].includes(key))) throw Error('Supply the exact inspected 497-file BLACKICE 2.24.1 source baseline.');
  const entries = Object.entries(value.files).sort(([left], [right]) => lexical(left, right)), seen = new Set();
  for (const [relative, file] of entries) {
    validatePatchPath(relative);
    if (seen.has(relative.toLowerCase()) || !object(file) || !SHA256.test(file.sha256 || '') || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || Object.keys(file).some(key => !['sha256','bytes'].includes(key))) throw Error('Invalid source baseline file: ' + relative);
    seen.add(relative.toLowerCase());
  }
  const canonical = { format: 1, product: 'BLACKICE', version: PREVIOUS_VERSION, fingerprint: BASELINE_FINGERPRINT, files: Object.fromEntries(entries.map(([relative, file]) => [relative, { sha256: file.sha256, bytes: file.bytes }])) };
  if (hash(Buffer.from(JSON.stringify(canonical))) !== BASELINE_CANONICAL_SHA256) throw Error('The source baseline differs from the inspected file hashes.');
  return Object.fromEntries(entries.map(([relative, file]) => [relative, file.sha256]));
}

export function expectedCandidateFiles(baseline, manifest) {
  const original = validateSourceBaseline(baseline); validateManifest(manifest);
  const result = { ...original }, paths = new Map(Object.keys(original).map(relative => [relative.toLowerCase(), relative]));
  for (const file of manifest.files) {
    if (paths.has(file.path.toLowerCase()) && paths.get(file.path.toLowerCase()) !== file.path || (original[file.path] ?? null) !== file.previousSha256 || file.previousSha256 === file.sha256) throw Error('The change manifest does not match the exact source baseline: ' + file.path);
    paths.set(file.path.toLowerCase(), file.path); result[file.path] = file.sha256;
  }
  return normalizedMap(result);
}

/** Full source evidence includes tests and scripts omitted from runtime hashes. */
export async function captureSourceFiles(directory) {
  const files = {}, excluded = new Set(['node_modules','data','workspace','.build','dist','.git','__pycache__']);
  async function visit(relative) {
    const name = path.posix.basename(relative); if (excluded.has(name) || name.includes('.currents-backup-')) return;
    const location = path.join(directory, relative), info = await fs.lstat(location);
    if (info.isSymbolicLink()) throw Error('Application source inputs cannot contain links: ' + relative);
    if (info.isDirectory()) { for (const child of (await fs.readdir(location)).sort(lexical)) await visit(path.posix.join(relative, child)); }
    else if (info.isFile()) { validatePatchPath(relative); if (Object.keys(files).length >= 10000) throw Error('The application source inventory exceeds its file limit.'); files[relative] = hash((await readRegular(location)).bytes); }
    else throw Error('Application source inputs must be ordinary files: ' + relative);
  }
  for (const name of (await fs.readdir(directory)).sort(lexical)) await visit(name);
  return normalizedMap(files);
}

// Canonical source checkouts can retain inspected build schemas, old launchers
// and editor backups. These paths are read-only preservation inputs; they never
// enter the candidate inventory or become eligible patch destinations.
function validatePreservedPath(relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 240 || !/^[A-Za-z0-9_. /-]+$/.test(relative)) throw Error('Unsafe preserved source path.');
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw Error('Unsafe preserved source path: ' + relative);
  return relative;
}

const sourceExtraSummary = files => ({ fileCount: Object.keys(files).length, totalBytes: Object.values(files).reduce((total, file) => total + file.bytes, 0), sha256: hash(Buffer.from(JSON.stringify(normalizedMap(Object.fromEntries(Object.entries(files).map(([relative, file]) => [relative, { sha256: file.sha256, bytes: file.bytes }])))))) });

export function validateSourceUnmanagedInspection(bytes, { source, releaseFiles } = {}) {
  if (!Buffer.isBuffer(bytes) || hash(bytes) !== SOURCE_UNMANAGED_INSPECTION_SHA256) throw Error('Supply the exact inspected source-unmanaged-inspection.json bytes.');
  const inspection = JSON.parse(bytes);
  if (!object(inspection) || inspection.format !== 1 || inspection.baseVersion !== PREVIOUS_VERSION || inspection.baselineFileCount !== BASELINE_SOURCE_COUNT || typeof inspection.source !== 'string' || !path.win32.isAbsolute(inspection.source) || !Number.isFinite(Date.parse(inspection.inspectedAt)) || !Array.isArray(inspection.files) || inspection.files.length !== SOURCE_UNMANAGED_SUMMARY.fileCount || !same(Object.keys(inspection).sort(), ['format','source','baseVersion','baselineFileCount','inspectedAt','files'].sort())) throw Error('The source preservation inspection has an invalid identity or inventory.');
  if (source && !sameDirectory(source, inspection.source)) throw Error('The preserved source inspection belongs to a different canonical source directory.');
  if (!object(releaseFiles) || !Object.keys(releaseFiles).length) throw Error('Validate preserved files against the complete release file set.');
  const reserved = new Set(Object.keys(releaseFiles).map(relative => validatePatchPath(relative).toLowerCase())), seen = new Set(), files = {};
  for (const file of inspection.files) {
    if (!object(file) || !same(Object.keys(file).sort(), ['path','bytes','sha256'].sort())) throw Error('Invalid inspected preserved source file.');
    const relative = validatePreservedPath(file.path), folded = relative.toLowerCase();
    if (reserved.has(folded)) throw Error('An inspected extra occupies a release destination: ' + relative);
    if (seen.has(folded) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAXIMUM_PATCH_BYTES || !SHA256.test(file.sha256 || '')) throw Error('Invalid or repeated inspected preserved source file: ' + relative);
    seen.add(folded); files[relative] = { sha256: file.sha256, bytes: file.bytes };
  }
  const ordered = normalizedMap(files), summary = sourceExtraSummary(ordered);
  if (summary.totalBytes > MAXIMUM_SOURCE_EXTRA_BYTES) throw Error('Inspected preserved source files exceed the 128-MiB limit.');
  if (!same(summary, SOURCE_UNMANAGED_SUMMARY)) throw Error('The preserved source file map differs from the exact inspected 447-file inventory.');
  return { files: ordered, ...summary };
}

export async function captureCanonicalSource(directory, releaseFiles) {
  if (!object(releaseFiles) || !Object.keys(releaseFiles).length || Object.keys(releaseFiles).length > 10000) throw Error('Canonical source inspection needs the complete release file set.');
  const releasePaths = new Map();
  for (const [relative, sha256] of Object.entries(releaseFiles)) {
    validatePatchPath(relative);
    if (!SHA256.test(sha256 || '') || releasePaths.has(relative.toLowerCase())) throw Error('Invalid canonical source release path: ' + relative);
    releasePaths.set(relative.toLowerCase(), relative);
  }
  const files = {}, extras = {}, seen = new Set(), excluded = new Set(['node_modules','data','workspace','.build','dist','.git','__pycache__']);
  let fileCount = 0, entryCount = 0, extraBytes = 0;
  const rootInfo = await fs.lstat(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw Error('Canonical source must be an ordinary directory without links.');
  async function visit(relative) {
    const name = path.posix.basename(relative);
    if (excluded.has(name.toLowerCase())) return;
    validatePreservedPath(relative);
    if (++entryCount > 20000) throw Error('Canonical source inspection exceeds its entry limit.');
    const folded = relative.toLowerCase();
    if (seen.has(folded)) throw Error('Canonical source paths collide on Windows: ' + relative);
    seen.add(folded);
    const location = path.join(directory, relative), info = await fs.lstat(location);
    if (info.isSymbolicLink()) throw Error('Canonical source inputs cannot contain links: ' + relative);
    if (info.isDirectory()) {
      if (releasePaths.has(folded)) throw Error('A release file became a directory: ' + relative);
      for (const child of (await fs.readdir(location)).sort(lexical)) await visit(path.posix.join(relative, child));
    } else if (info.isFile()) {
      if (++fileCount > 10000) throw Error('Canonical source inspection exceeds its file limit.');
      const releasePath = releasePaths.get(folded);
      if (releasePath && releasePath !== relative) throw Error('A canonical release path changed spelling: ' + relative);
      const current = await readFrom(directory, relative), sha256 = hash(current.bytes);
      if (releasePath) files[relative] = sha256;
      else {
        extraBytes += current.bytes.length;
        if (extraBytes > MAXIMUM_SOURCE_EXTRA_BYTES) throw Error('Preserved source files exceed the 128-MiB inspection limit.');
        extras[relative] = { sha256, bytes: current.bytes.length };
      }
    } else throw Error('Canonical source inputs must be ordinary files: ' + relative);
  }
  for (const name of (await fs.readdir(directory)).sort(lexical)) await visit(name);
  const orderedExtras = normalizedMap(extras);
  return { files: normalizedMap(files), extras: orderedExtras, extraFileCount: Object.keys(extras).length, extraBytes, extraSha256: sourceExtraSummary(orderedExtras).sha256 };
}

export async function verifyCanonicalSource(directory, { releaseFiles, expectedFiles, expectedExtras, label = 'Canonical source inventory' }) {
  if (!object(expectedExtras)) throw Error('Canonical source verification needs its inspected preserved-file inventory.');
  const current = await captureCanonicalSource(directory, releaseFiles);
  requireSources(current.files, expectedFiles, label);
  for (const relative of new Set([...Object.keys(expectedExtras), ...Object.keys(current.extras)])) {
    const expected = expectedExtras[relative], actual = current.extras[relative];
    if (!object(expected) || !object(actual) || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw Error('An inspected preserved source file changed or became unavailable: ' + relative);
  }
  return current;
}

function requireSources(actual, expected, label, subset) {
  const keys = subset || Object.keys(expected);
  if (!object(actual) || Object.keys(actual).length !== keys.length || keys.some(key => actual[key] !== expected[key] || !SHA256.test(actual[key] || ''))) throw Error(label + ' does not match the exact candidate source files.');
}

function requireHelpers(actual, expected, keys, label) {
  if (!object(actual) || Object.keys(actual).length !== keys.length || keys.some(key => !SHA256.test(expected?.[key] || '') || actual[key] !== expected[key])) throw Error(label + ' does not match the exact acceptance helper bytes.');
}

export function validateNativeVerification({ native, fingerprint, sourceFiles, taskSchemaSha256, assessPlanAcceptance, candidate, nativeOutput }) {
  if (!object(native) || native.format !== 1 || native.product !== 'BLACKICE' || native.version !== VERSION || native.platform !== 'win32' || native.live !== true || native.passed !== true || native.appFingerprintBefore !== fingerprint || native.appFingerprintAfter !== fingerprint || native.unchangedDuringCheck !== true || native.modelRuntimeClosed !== true || native.fixtureRemoved !== true || native.cleanupErrors !== undefined && (!Array.isArray(native.cleanupErrors) || native.cleanupErrors.length) || native.error || native.deadlineReached || !Array.isArray(native.calls) || native.calls.length !== 1 || !Array.isArray(native.nativeTools) || native.nativeTools.length || !Array.isArray(native.denied) || native.denied.length) throw Error('Native task-plan acceptance requires one successful real model turn on this exact candidate with confirmed cleanup.');
  if (candidate && !sameDirectory(native.sourceDirectory || '', candidate) || nativeOutput && !sameDirectory(native.outputDirectory || '', nativeOutput)) throw Error('The native task-plan receipt belongs to a different candidate or acceptance directory.');
  if (!object(native.expected) || native.expected.model !== native.requestedModel || !Array.isArray(native.expected.tokens) || native.expected.tokens.length !== 2 || new Set(native.expected.tokens).size !== 2 || native.expected.tokens.some(token => typeof token !== 'string' || !token) || native.runId !== native.run?.id || !Number.isSafeInteger(native.timeoutMs) || native.timeoutMs < 15000 || native.timeoutMs > 100000 || !Number.isFinite(Date.parse(native.startedAt)) || !Number.isFinite(Date.parse(native.finishedAt)) || Date.parse(native.finishedAt) < Date.parse(native.startedAt)) throw Error('Native task-plan acceptance lacks its exact fixture, requested model or completed run identity.');
  requireSources(native.runtimeSources, sourceFiles, 'Native task-plan runtime evidence', NATIVE_SOURCE_FILES);
  if (!SHA256.test(taskSchemaSha256 || '') || native.taskSchemaSha256 !== taskSchemaSha256 || native.calls[0].taskToolSchemaSha256 !== taskSchemaSha256) throw Error('Native task-plan acceptance did not use the exact candidate task tool schema.');
  if (typeof assessPlanAcceptance !== 'function') throw Error('The candidate task-plan acceptance assessor is unavailable.');
  const actual = assessPlanAcceptance({ run: native.run, calls: native.calls, artifact: native.artifact, expected: native.expected, nativeTools: native.nativeTools, denied: native.denied, rootBeforeModel: native.rootBeforeModel });
  if (actual.passed !== true || !same(Object.keys(actual.checks || {}).sort(), NATIVE_CHECKS.slice(0, -2).sort()) || Object.values(actual.checks).some(value => value !== true) || !object(native.checks) || !same(Object.keys(native.checks).sort(), [...NATIVE_CHECKS].sort()) || Object.values(native.checks).some(value => value !== true)) throw Error('Reassessing the native task-plan evidence did not pass every required check.');
  const calls = native.calls.flatMap(call => call.toolCalls || []), writes = calls.filter(call => call.name === 'relay_workspace' && call.arguments?.action === 'write' && path.basename(call.arguments.path || '') === 'result.json' && call.success === true), lastWrite = writes.at(-1);
  if (typeof lastWrite?.arguments?.text !== 'string') throw Error('Native acceptance lacks the acknowledged result file bytes.');
  const bytes = Buffer.from(lastWrite.arguments.text), result = JSON.parse(bytes);
  const equalJson = (left, right) => left && right && typeof left === 'object' && typeof right === 'object' ? same(normalizedMap(left), normalizedMap(right)) : left === right;
  if (!SHA256.test(native.artifactSha256 || '') || hash(bytes) !== native.artifactSha256 || !equalJson(result, native.artifact) || !native.run.taskState.artifacts.some(item => item.fileName === 'result.json' && item.sha256 === native.artifactSha256) || !calls.slice(calls.indexOf(lastWrite) + 1).some(call => call.name === 'relay_workspace' && call.arguments?.action === 'read' && path.basename(call.arguments.path || '') === 'result.json' && call.success === true)) throw Error('Native acceptance result bytes, readback and registered artifact do not agree.');
  return { model: native.requestedModel, checks: NATIVE_CHECKS.length, runId: native.runId, artifactSha256: native.artifactSha256 };
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

// Exported for isolated failure/rollback verification; the CLI admits operations
// only after checking the Windows roots, all receipts, backups, and old hashes.
export async function commitOperations(operations, { verify, verifyRollback = async () => {}, assertClosed = () => {} }) {
  const changed = [], temporaries = new Set(), createdDirectories = [];
  let succeeded = false, failure;
  try {
    assertClosed();
    for (const item of operations) {
      await checkOperation(item);
      await checkParents(item.root, item.path, createdDirectories);
      await atomicWrite(path.join(item.root, item.path), item.bytes, item.mode, temporaries);
      changed.push(item);
      await checkOperation(item, item.sha256);
    }
    await verify();
    assertClosed();
    succeeded = true;
  } catch (error) {
    const rollbackErrors = [];
    for (const item of [...changed].reverse()) {
      try {
        const current = await readFrom(item.root, item.path, true), currentHash = current ? hash(current.bytes) : null;
        if (currentHash === item.previousSha256) continue;
        if (currentHash !== item.sha256) throw Error('Unexpected later edits were preserved; this file needs review.');
        if (item.original !== null) await atomicWrite(path.join(item.root, item.path), item.original, item.originalMode, temporaries);
        else await fs.unlink(path.join(item.root, item.path));
        await checkOperation(item);
      } catch (cause) { rollbackErrors.push({ scope: item.scope, path: item.path, error: cause.message }); }
    }
    // An unfinished temp under lib/public is itself a fingerprint input. Remove
    // only this transaction's temps before checking the restored runtime.
    try { await cleanupTemporaries(temporaries); }
    catch (cause) { rollbackErrors.push({ error: cause.message }); }
    try { await verifyRollback(); }
    catch (cause) { rollbackErrors.push({ error: cause.message }); }
    failure = error;
    failure.rollback = { attempted: true, complete: rollbackErrors.length === 0, filesChangedBeforeFailure: changed.length, errors: rollbackErrors };
  } finally {
    try { await cleanupTemporaries(temporaries); }
    catch (error) { if (failure) failure.cleanupError = error.message; else failure = error; }
    if (!succeeded) for (const directory of createdDirectories.reverse()) {
      try { await fs.rmdir(directory); }
      catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) { if (failure) failure.cleanupError = error.message; else failure = error; } }
    }
  }
  if (failure) throw failure;
}

function nativeClosed(installed) {
  const script = "$ErrorActionPreference='Stop'; $root=[IO.Path]::GetFullPath($env:BLACKICE_UI_INSTALL_ROOT).TrimEnd('\\')+'\\'; $count=0; foreach($p in Get-Process) { $file=$null; try { $file=$p.Path } catch { if($p.ProcessName -match '^(BLACKICE|Relay|Agent Desk)$') { throw 'Could not verify the BLACKICE process path.' } }; if($file -and $file.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) { $count++ }; if(-not $file -and $p.ProcessName -match '^(BLACKICE|Relay|Agent Desk)$') { throw 'Could not verify the BLACKICE process path.' } }; $count";
  const count = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, BLACKICE_UI_INSTALL_ROOT: path.resolve(installed, '../..') }, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024 }).trim();
  if (count !== '0') throw Error('BLACKICE is open. Close the native application before updating its files.');
}

const overlaps = (left, right) => { const a = left.toLowerCase(), b = right.toLowerCase(); return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep); };
export const installedFile = file => file === 'package.json' || file === 'server.mjs' || documents.has(file) || /^(?:lib|public)\//.test(file) || installedDesktopFiles.has(file) || ['scripts/chatgpt-bridge.mjs', 'scripts/email-oauth-token.mjs', 'scripts/remote-access-cli.mjs', 'scripts/browser-cli.mjs'].includes(file);

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
const uiSources = ['public/icon-symbols.mjs','lib/harness-identity.mjs', 'public/planning-mode.mjs', 'public/task-plan-map.mjs', 'public/task-plan.css', 'public/blackice-material.css', 'public/assets/blackice-field.svg', 'public/assets/blackice-wordmark.svg', 'server.mjs', 'lib/engine.mjs', 'lib/task-state.mjs', 'lib/task-plan.mjs', 'lib/cron.mjs', 'lib/projects.mjs', 'lib/subagents.mjs', 'lib/agent-email.mjs', 'public/app.js', 'public/index.html', 'public/workspace-integrations.mjs', 'public/mission-ui.mjs', 'public/task-plan-ui.mjs', 'public/advanced-ui.mjs', 'public/email-ui.mjs', 'public/email.css', 'scripts/revised-workspace-ui-qa.mjs'];
const containedSources = ['desktop/browser-driver.mjs', 'desktop/browser-capture.mjs', 'desktop/browser-router.mjs', 'lib/browser.mjs', 'tests/browser-auth.integration.test.mjs', 'tests/browser-lazy.integration.test.mjs', 'tests/fixtures/browser-auth-live.mjs', 'tests/fixtures/browser-lazy-live.mjs', 'scripts/verify-contained-browser.mjs'];
const requiredEmailChecks = ['configuration_has_no_process_or_account_side_effect', 'installed_cli_version_and_help', 'real_maildir_list', 'real_maildir_search_with_single_argv_query', 'real_maildir_raw_json_read', 'read_preserves_message_flags', 'local_unsent_draft_persistence'];
const readJson = async file => JSON.parse((await readRegular(file)).bytes.toString('utf8').replace(/^\uFEFF/, ''));
const evidencePaths = [
  'qa-regression-root/regression-report.json', 'qa-regression-root/regression.tap',
  'qa-workspace-final/revised-workspace-ui-report.json',
  'qa-native-plan-root/receipt.json',
  'qa-contained-browser-root/contained-browser-report.json', 'qa-contained-browser-root/contained-browser.tap',
  'qa-email-cli-root/email-cli-report.json',
];

export function validateBackgroundEvidence({ regression, tap, ui, browser, browserTap, email, native, fingerprint, sourceFiles, candidate, work }) {
  const invariant = (condition, message) => { if (!condition) throw Error(message); };
  for (const [name, receipt] of [['workspace UI', ui], ['contained browser', browser], ['email CLI', email]]) invariant(receipt && !receipt.error && !receipt.cleanupError && !receipt.cleanupErrors?.length && !receipt.runnerError, 'The ' + name + ' receipt contains an error.');
  const count = name => { const values = [...tap.matchAll(new RegExp('^# ' + name + ' (\\d+)\\r?$', 'gm'))]; return values.length ? Number(values.at(-1)[1]) : null; };
  invariant(regression?.format === 1 && regression.product === 'BLACKICE' && regression.version === VERSION && regression.platform === 'win32' && regression.passed === true && regression.exitCode === 0 && !regression.timedOut && !regression.error && regression.unchanged === true && regression.appFingerprintBefore === fingerprint && regression.appFingerprintAfter === fingerprint && sameDirectory(regression.candidate, candidate), 'Require successful Windows regression on this exact candidate.');
  requireSources(regression.sourceHashesBefore, sourceFiles, 'Regression source inventory before');
  requireSources(regression.sourceHashesAfter, sourceFiles, 'Regression source inventory after');
  invariant(regression.testFiles === Object.keys(sourceFiles).filter(file => /^tests\/[^/]+\.test\.mjs$/.test(file)).length, 'Regression did not include every top-level test file.');
  const counts = { total: count('tests'), passed: count('pass'), failed: count('fail'), cancelled: count('cancelled'), skipped: count('skipped') };
  invariant(same(counts, regression.tests) && counts.total > 2500 && counts.passed > 2500 && counts.failed === 0 && counts.cancelled === 0 && counts.total === counts.passed + counts.skipped && counts.skipped === 4 && hash(Buffer.from(tap)) === regression.logSha256, 'Regression TAP counts or bytes do not match the successful receipt.');
  const skipped = tap.split(/\r?\n/).filter(line => /# SKIP\b/.test(line));
  invariant(skipped.length === expectedOptionalSkips.length && expectedOptionalSkips.every(name => skipped.some(line => line.includes(name))) && same(skipped, regression.skips), 'Only the four explicitly optional browser/desktop fixtures may be skipped.');
  invariant(ui?.ok === true && ui.version === VERSION && ui.platform === 'win32' && sameDirectory(ui.candidate, candidate) && ui.appFingerprintBefore === fingerprint && ui.appFingerprintAfter === fingerprint && ui.unchangedDuringChecks === true && ui.serverClosed === true && ui.disposableStateRemoved === true && Array.isArray(ui.checks) && ui.checks.length >= 40 && ui.passed === ui.checks.length && new Set(ui.checks).size === ui.checks.length && Array.isArray(ui.pageErrors) && ui.pageErrors.length === 0 && Array.isArray(ui.emailCliCalls) && ui.emailCliCalls.length === 0 && ui.runtimeCalls?.length === 4 && ui.runtimeCalls.every(call => call.externalRequests === 0 && call.harnessIdentified === true), 'Require current background-workspace UI acceptance with clean, exclusively local fixtures.');
  invariant(ui.cancellation?.directionRequests === 1 && ui.cancellation?.cancellationObserved === 1 && ui.cancellation?.settled === true && ui.cancellation?.status === 'cancelled' && /\bStopping\b/.test(ui.cancellation?.pendingStatus || '') && !/\bStopped\b/.test(ui.cancellation?.pendingStatus || '') && ui.cancellation?.settledStatus === 'Stopped' && ui.checks.some(name => /Stop stays available while a direction request is pending/.test(name)) && ui.checks.some(name => /Only acknowledged cancellation is marked stopped/.test(name)), 'Require real UI cancellation while direction submission is pending and verified settlement.');
  invariant(same(ui.planning?.choices, ['maximal','on','auto','off']) && object(ui.planning?.descriptions) && ['maximal','on','auto','off'].every(mode => typeof ui.planning.descriptions[mode] === 'string' && ui.planning.descriptions[mode].length > 20) && ui.planning.plannedMode === 'on' && ui.planning.offMode === 'off' && ui.planning.offCompleted === true && ui.planning.offToolCalls === 0 && ui.planning.offFinalVisible === true, 'Require real UI planning mode controls and a completed Off turn without automatic plan calls.');
  invariant(same(ui.mindMap?.savedNodeIds, ['inspect','save']) && ['dependenciesVisible','sharedNotesVisible','focusPreservesTree','zoomChangesViewport','keyboardSelection','hoverPreservesPosition','internallyScrollable'].every(key => ui.mindMap[key] === true) && Number.isFinite(ui.mindMap.readingTitlePx) && ui.mindMap.readingTitlePx >= 11, 'Require the rendered mind map to preserve saved steps, dependencies, notes, focus and keyboard selection.');
  invariant(ui.visual?.sceneUsesSvg === true && ui.visual.gradientSurfaceCount === 6 && ui.visual.repeatedSceneInReadingPanels === false && same(ui.visual.vectorAssets?.map(asset => asset.name), ['blackice-field.svg','blackice-wordmark.svg']) && ui.visual.vectorAssets.every(asset => asset.served === true && asset.vectorOnly === true), 'Require served editable SVG assets and gradient reading surfaces in the real UI.');
  requireSources(ui.before, sourceFiles, 'UI source bindings before', uiSources);
  requireSources(ui.after, sourceFiles, 'UI source bindings after', uiSources);
  invariant(ui.checks.some(name => /plan.*before.*answer|task pane appears before the answer/i.test(name)), 'UI acceptance lacks the plan-before-answer contract.');
  invariant(browser?.passed === true && browser.platform === 'win32' && browser.suite === 'contained-browser' && sameDirectory(browser.candidate, candidate) && browser.exitCode === 0 && browser.unchanged === true && !browser.timedOut && browser.actualUserBrowserAccessed === false && browser.onlyDisposableLocalSites === true && browser.tests?.total === 2 && browser.tests.passed === 2 && browser.tests.failed === 0 && browser.tests.cancelled === 0 && browser.tests.skipped === 0 && hash(Buffer.from(browserTap)) === browser.logSha256, 'Require both real Windows contained-browser tests without skips.');
  requireSources(browser.before, sourceFiles, 'Contained browser source bindings before', containedSources);
  requireSources(browser.after, sourceFiles, 'Contained browser source bindings after', containedSources);
  const browserCount = name => { const values = [...browserTap.matchAll(new RegExp('^# ' + name + ' (\\d+)\\r?$', 'gm'))]; return values.length ? Number(values.at(-1)[1]) : null; };
  invariant(browserCount('tests') === 2 && browserCount('pass') === 2 && browserCount('fail') === 0 && browserCount('cancelled') === 0 && browserCount('skipped') === 0 && !/^not ok\b|# SKIP\b/m.test(browserTap) && expectedOptionalSkips.slice(0, 2).every(name => browserTap.includes(name)), 'Contained browser TAP must show both required named tests passing without skips.');
  invariant(email?.passed === true && email.platform === 'win32' && email.candidateVersion === VERSION && email.offlineFixture === true && email.actualUserAccountAccessed === false && email.sent === false && email.cliVersion === '2.2.1' && email.sourceUnchanged === true && same(email.checks, requiredEmailChecks) && email.executableUnchanged === true && email.executable?.version === '2.2.1' && SHA256.test(email.executable.sha256Before || '') && email.executable.sha256Before === email.executable.sha256After && path.win32.isAbsolute(email.executable.path || ''), 'Require installed Himalaya 2.2.1 to pass the owned local Maildir proof.');
  const emailSources = ['lib/agent-email.mjs', 'lib/email-tools.mjs', 'scripts/verify-email-cli.mjs'];
  requireSources(email.sourceHashesBefore, sourceFiles, 'Email source bindings before', emailSources);
  requireSources(email.sourceHashesAfter, sourceFiles, 'Email source bindings after', emailSources);
  const plan = validateNativeVerification({ native, fingerprint, sourceFiles, taskSchemaSha256: hash(Buffer.from(JSON.stringify(TASK_TOOL))), assessPlanAcceptance, candidate, nativeOutput: path.join(work, 'qa-native-plan-root') });
  return { regression: counts, uiChecks: ui.checks.length, containedBrowserTests: 2, emailChecks: email.checks.length, emailCliVersion: email.cliVersion, nativePlan: plan };
}

export async function installBackgroundUpdate(args = process.argv.slice(2)) {
  if (process.platform !== 'win32' || ![3, 4].includes(args.length) || !['--prepare', '--commit'].includes(args[2]) || args[2] === '--prepare' && args.length !== 3 || args[2] === '--commit' && !SHA256.test(args[3] || '')) throw Error('Supply SOURCE INSTALLED_APP --prepare, or SOURCE INSTALLED_APP --commit PLAN_SHA256 on Windows.');
  const candidate = await directoryRoot(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const work = path.dirname(candidate);
  const [source, installed] = await Promise.all(args.slice(0, 2).map(directoryRoot));
  if (overlaps(source, installed) || overlaps(source, candidate) || overlaps(installed, candidate) || path.basename(installed).toLowerCase() !== 'app' || path.basename(path.dirname(installed)).toLowerCase() !== 'resources' || path.basename(candidate) !== 'candidate' || !work.includes('blackice-2.25.0-visual-planning')) throw Error('Use the isolated background candidate and distinct source/installed resources/app roots.');
  const locks = [], temporaries = new Set();
  let backup, result, failure;
  try {
    await acquireLock(path.join(path.dirname(source), `.${path.basename(source)}.blackice-background-update.lock`), locks);
    await acquireLock(path.join(path.dirname(installed), '.blackice-background-update.lock'), locks);
    nativeClosed(installed);
    const baselineBytes = (await readRegular(path.join(work, 'source-baseline.json'))).bytes;
    const baseline = JSON.parse(baselineBytes), originalSourceFiles = validateSourceBaseline(baseline);
    const sourceFiles = await captureSourceFiles(candidate), fingerprint = await appFingerprint(candidate);
    if (Object.keys(originalSourceFiles).some(file => !sourceFiles[file])) throw Error('The candidate omitted a baseline file. This updater does not remove source files.');
    const manifest = { format: 1, product: 'BLACKICE', version: VERSION, originalFingerprint: BASELINE_FINGERPRINT, files: Object.entries(sourceFiles).filter(([file, sha256]) => originalSourceFiles[file] !== sha256).map(([file, sha256]) => ({ path: file, sha256, previousSha256: originalSourceFiles[file] || null })) };
    requireSources(expectedCandidateFiles(baseline, manifest), sourceFiles, 'Complete change manifest');
    const unmanagedBytes = (await readRegular(path.join(work, SOURCE_UNMANAGED_INSPECTION))).bytes;
    const unmanaged = validateSourceUnmanagedInspection(unmanagedBytes, { source, releaseFiles: sourceFiles });
    const evidenceHashes = Object.fromEntries(await Promise.all(evidencePaths.map(async file => [file, hash((await readRegular(path.join(work, file))).bytes)])));
    const [regression, ui, browser, email, native] = await Promise.all([evidencePaths[0], evidencePaths[2], evidencePaths[4], evidencePaths[6], evidencePaths[3]].map(file => readJson(path.join(work, file))));
    const tap = (await readRegular(path.join(work, evidencePaths[1]))).bytes.toString('utf8');
    const browserTap = (await readRegular(path.join(work, evidencePaths[5]))).bytes.toString('utf8');
    const accepted = validateBackgroundEvidence({ regression, tap, ui, browser, browserTap, email, native, fingerprint, sourceFiles, candidate, work });
    for (const [root, version] of [[candidate, VERSION], [source, PREVIOUS_VERSION], [installed, PREVIOUS_VERSION]]) if (JSON.parse((await readFrom(root, 'package.json')).bytes).version !== version) throw Error('An application version changed before the update.');
    const [sourceBefore, installedBefore] = await Promise.all([appFingerprint(source), appFingerprint(installed)]);
    if (sourceBefore !== BASELINE_FINGERPRINT || installedBefore !== BASELINE_FINGERPRINT) throw Error('The source or installed runtime differs from the inspected 2.24.1 baseline.');
    const sourceBeforeInventory = await verifyCanonicalSource(source, { releaseFiles: sourceFiles, expectedFiles: originalSourceFiles, expectedExtras: unmanaged.files });
    const operations = []; let patchBytes = 0, backupBytes = 0;
    for (const file of manifest.files) {
      const next = await readFrom(candidate, file.path); patchBytes += next.bytes.length;
      if (patchBytes > MAXIMUM_PATCH_BYTES || hash(next.bytes) !== file.sha256) throw Error('The candidate patch changed or exceeds its byte limit.');
      for (const [scope, root] of [['source', source], ...(installedFile(file.path) ? [['installed', installed]] : [])]) {
        const original = await readFrom(root, file.path, true), previousSha256 = original ? hash(original.bytes) : null;
        backupBytes += original?.bytes.length || 0;
        if (backupBytes > MAXIMUM_BACKUP_BYTES) throw Error('The rollback backup exceeds its byte limit.');
        if (!(scope === 'installed' && file.path === 'package.json') && previousSha256 !== file.previousSha256) throw Error('An original file differs from its inspected hash: ' + scope + '/' + file.path);
        operations.push({ scope, root, path: file.path, bytes: next.bytes, original: original?.bytes ?? null, mode: original?.mode ?? next.mode, originalMode: original?.mode ?? null, sha256: file.sha256, previousSha256 });
      }
    }
    const plan = { format: 1, product: 'BLACKICE', version: VERSION, previousVersion: PREVIOUS_VERSION, source, installed, candidate, originalFingerprint: BASELINE_FINGERPRINT, verifiedFingerprint: fingerprint, sourceFiles, sourceUnmanaged: { fileCount: sourceBeforeInventory.extraFileCount, totalBytes: sourceBeforeInventory.extraBytes, sha256: sourceBeforeInventory.extraSha256 }, evidenceHashes, accepted, files: operations.map(({ bytes, original, root, ...item }) => ({ ...item, bytes: bytes.length, originalExisted: original !== null })) };
    const planBytes = Buffer.from(JSON.stringify(plan, null, 2) + '\n'), planSha256 = hash(planBytes), planFile = path.join(work, 'background-update-plan.json');
    if (args[2] === '--prepare') {
      const prior = await readRegular(planFile, { optional: true });
      if (prior && hash(prior.bytes) !== planSha256) throw Error('A different prepared update plan already exists; preserve it and review the changed inputs before preparing another.');
      if (!prior) await atomicWrite(planFile, planBytes, 0o600, temporaries);
      result = { prepared: true, installed: false, planFile, planSha256, sourceFiles: Object.keys(sourceFiles).length, sourceFilesToUpdate: operations.filter(item => item.scope === 'source').length, installedFilesToUpdate: operations.filter(item => item.scope === 'installed').length, patchBytes, backupBytes, appFingerprint: fingerprint, accepted };
    } else {
      if (planSha256 !== args[3] || hash((await readRegular(planFile)).bytes) !== args[3]) throw Error('The prepared update plan changed. No application files were written.');
      backup = path.join(work, 'background-update-backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID());
      await fs.mkdir(backup);
      for (const [name, bytes] of [['change-plan.json', planBytes], ['source-baseline.json', baselineBytes], [SOURCE_UNMANAGED_INSPECTION, unmanagedBytes]]) await atomicWrite(path.join(backup, name), bytes, 0o600, temporaries);
      for (const item of operations) if (item.original !== null) {
        const target = path.join(backup, item.scope, item.path); await fs.mkdir(path.dirname(target), { recursive: true });
        await atomicWrite(target, item.original, 0o600, temporaries);
        if (hash((await readRegular(target)).bytes) !== item.previousSha256) throw Error('A rollback backup failed verification: ' + item.path);
      }
      const recheckEvidence = async () => { for (const [file, expected] of Object.entries(evidenceHashes)) if (hash((await readRegular(path.join(work, file))).bytes) !== expected) throw Error('Verification evidence changed: ' + file); };
      await recheckEvidence();
      requireSources(await captureSourceFiles(candidate), sourceFiles, 'Candidate before installation');
      await verifyCanonicalSource(source, { releaseFiles: sourceFiles, expectedFiles: originalSourceFiles, expectedExtras: unmanaged.files });
      if (await appFingerprint(source) !== sourceBefore || await appFingerprint(installed) !== installedBefore) throw Error('Original application files changed while backups were prepared.');
      let sourceAfterInventory;
      await commitOperations(operations, {
        assertClosed: () => nativeClosed(installed),
        verify: async () => {
          if (await appFingerprint(source) !== fingerprint || await appFingerprint(installed) !== fingerprint || await appFingerprint(candidate) !== fingerprint) throw Error('Updated runtimes do not match the verified candidate.');
          for (const item of operations) await checkOperation(item, item.sha256);
          sourceAfterInventory = await verifyCanonicalSource(source, { releaseFiles: sourceFiles, expectedFiles: sourceFiles, expectedExtras: unmanaged.files });
          requireSources(await captureSourceFiles(candidate), sourceFiles, 'Candidate after installation');
          await recheckEvidence();
        },
        verifyRollback: async () => {
          if (await appFingerprint(source) !== sourceBefore || await appFingerprint(installed) !== installedBefore) throw Error('Rollback did not restore both original runtime fingerprints.');
          await verifyCanonicalSource(source, { releaseFiles: sourceFiles, expectedFiles: originalSourceFiles, expectedExtras: unmanaged.files });
        },
      });
      result = { format: 1, product: 'BLACKICE', version: VERSION, previousVersion: PREVIOUS_VERSION, installed: true, installedAt: new Date().toISOString(), source, installation: installed, candidate, appFingerprint: fingerprint, originalFingerprint: BASELINE_FINGERPRINT, planSha256, sourceFilesVerified: Object.keys(sourceFiles).length, sourceFilesUpdated: operations.filter(item => item.scope === 'source').length, installedFilesUpdated: operations.filter(item => item.scope === 'installed').length, fullRuntimeMatch: true, backupDirectory: backup, allChangedFilesBackedUp: true, sourceUnmanaged: { beforeSha256: sourceBeforeInventory.extraSha256, afterSha256: sourceAfterInventory.extraSha256, fileCount: sourceAfterInventory.extraFileCount, preserved: true }, nativeAppLaunched: false, existingProfileDataPreserved: true, profileSettingsWritten: false, connectorSettingsWritten: false, installerArchivesRebuilt: false, accepted, evidenceHashes };
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
  try { console.log(JSON.stringify(await installBackgroundUpdate(), null, 2)); }
  catch (error) { console.error(JSON.stringify({ installed: error.installed === true, error: error.message, backupDirectory: error.backupDirectory || null, rollback: error.rollback || null, cleanupError: error.cleanupError || null }, null, 2)); process.exitCode = 1; }
}

