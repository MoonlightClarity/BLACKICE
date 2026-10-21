#!/usr/bin/env node
/** Reviewed staging helper. This does not stop, launch, update or configure the
 * installed application. It copies the exact previously verified 2.29 source
 * inventory into the one new 2.30 work/candidate, after fresh Windows checks.
 * node prepare-awareness-candidate.mjs BASELINE_FILE
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const AWARENESS_VERSION = '2.30.0';
export const AWARENESS_PREVIOUS_VERSION = '2.29.0';
export const AWARENESS_BASELINE_FINGERPRINT = 'c97776f753884f2d75c6b03555a4d7c024a369270833b7b73b6a208442ef4455';
export const AWARENESS_BASELINE_SHA256 = '98059bdd853b7d448cec3bb5a4815bd1445afb69bda525633b630e91237e8b66';
export const AWARENESS_BASELINE_FILE = 'baseline-awareness-2.29.0.json';
export const AWARENESS_WORK = path.win32.join(homedir(), 'Documents', 'Codex', '2026-10-20', 'blackice-2.30.0-shared-editing-email', 'work');
const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLED = path.win32.join(process.env.LOCALAPPDATA || path.win32.join(homedir(), 'AppData', 'Local'), 'Programs', 'Agent Desk', 'resources', 'app');
const SHA256 = /^[a-f0-9]{64}$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (condition, message) => { if (!condition) throw Error(message); };
const sameWindowsPath = (left, right) => typeof left === 'string' && typeof right === 'string' && path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
const normalize = value => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
const sameMap = (left, right) => JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));

export function validateAwarenessBaseline(bytes, { source, installed, candidate } = {}) {
  fail(Buffer.isBuffer(bytes) && sha(bytes) === AWARENESS_BASELINE_SHA256, 'Supply the exact reviewed 2.29.0 baseline bytes.');
  const value = JSON.parse(bytes);
  fail(value.format === 1 && value.product === 'BLACKICE' && value.version === AWARENESS_PREVIOUS_VERSION && value.appFingerprint === AWARENESS_BASELINE_FINGERPRINT, 'The 2.29.0 baseline identity changed.');
  // These counts come from the pinned prior installation and reopen receipts.
  fail(Object.keys(value.sourceFiles).length === 577 && Object.keys(value.installedFiles).length === 308 && Object.keys(value.preservedSourceFiles).length === 447, 'The previously verified inventories changed.');
  fail(sameWindowsPath(value.source, SOURCE) && sameWindowsPath(value.installed, INSTALLED) && sameWindowsPath(value.candidate, path.win32.join(AWARENESS_WORK, 'candidate')), 'The baseline belongs to another source, installation or work directory.');
  for (const [key, supplied] of Object.entries({ source, installed, candidate })) if (supplied !== undefined) fail(sameWindowsPath(supplied, value[key]), 'The supplied ' + key + ' differs from the reviewed directory.');
  for (const [relative, digest] of Object.entries(value.sourceFiles)) {
    fail(typeof relative === 'string' && SHA256.test(digest), 'A baseline source hash is invalid.');
  }
  return value;
}

async function regularFile(file, maximum = 64 * 1024 * 1024) {
  const info = await fs.lstat(file);
  fail(info.isFile() && !info.isSymbolicLink() && info.size <= maximum, 'Require a bounded ordinary file: ' + file);
  return fs.readFile(file);
}

async function ordinaryDirectory(directory, { create = false } = {}) {
  const resolved = path.resolve(directory), parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try { info = await fs.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      await fs.mkdir(current); info = await fs.lstat(current);
    }
    fail(info.isDirectory() && !info.isSymbolicLink(), 'Staging parents must be ordinary directories: ' + current);
  }
  return fs.realpath(resolved);
}

async function sourceFile(root, relative) {
  fail(typeof relative === 'string' && /^[A-Za-z0-9_./-]+$/.test(relative) && relative.split('/').every(part => part && !['.', '..'].includes(part)), 'Unsafe baseline file path.');
  await ordinaryDirectory(path.dirname(path.join(root, relative)));
  return regularFile(path.join(root, relative));
}

async function writeNew(file, bytes) {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

/** Positive checks are deliberately repeated around copying. An incomplete
 * candidate is preserved on failure so a later invocation cannot overwrite it. */
export async function prepareAwarenessCandidate(baselineFile) {
  fail(process.platform === 'win32', 'Create this isolated candidate on the actual Windows host.');
  const baselineBytes = await regularFile(path.resolve(baselineFile)), baseline = validateAwarenessBaseline(baselineBytes);
  const source = await ordinaryDirectory(baseline.source), installed = await ordinaryDirectory(baseline.installed);
  fail(sameWindowsPath(source, baseline.source) && sameWindowsPath(installed, baseline.installed), 'A reviewed application root resolves elsewhere.');
  for (const [relative, digest] of Object.entries(baseline.sourceFiles)) fail(sha(await sourceFile(source, relative)) === digest, 'Canonical 2.29 source changed: ' + relative);
  for (const [relative, expected] of Object.entries(baseline.installedFiles)) {
    const bytes = await sourceFile(installed, relative);
    fail(bytes.length === expected.bytes && sha(bytes) === expected.sha256, 'Installed 2.29 bytes changed: ' + relative);
  }
  // Import only after every transitive source module has matched the prior
  // installation's complete reviewed source inventory.
  const [{ captureSourceFiles, verifyCanonicalSource }, { appFingerprint }] = await Promise.all([
    import(pathToFileURL(path.join(source, 'scripts/install-background-update.mjs')).href),
    import(pathToFileURL(path.join(source, 'scripts/release-check.mjs')).href),
  ]);
  const installedFiles = Object.fromEntries(Object.entries(baseline.installedFiles).map(([relative, file]) => [relative, file.sha256]));
  const verifyOriginals = async () => {
    const inventory = await verifyCanonicalSource(source, { releaseFiles: baseline.sourceFiles, expectedFiles: baseline.sourceFiles, expectedExtras: baseline.preservedSourceFiles });
    fail(sameMap(await captureSourceFiles(installed), installedFiles), 'The complete installed inventory changed.');
    for (const root of [source, installed]) {
      fail(JSON.parse(await sourceFile(root, 'package.json')).version === AWARENESS_PREVIOUS_VERSION, 'The original application version changed.');
      fail(await appFingerprint(root) === AWARENESS_BASELINE_FINGERPRINT, 'The original application fingerprint changed.');
    }
    fail(inventory.extraFileCount === baseline.preservedSourceSummary.fileCount && inventory.extraBytes === baseline.preservedSourceSummary.totalBytes && inventory.extraSha256 === baseline.preservedSourceSummary.sha256, 'The complete preserved source inventory changed.');
    return inventory;
  };
  const before = await verifyOriginals(), work = await ordinaryDirectory(AWARENESS_WORK, { create: true }), candidate = path.join(work, 'candidate');
  fail(sameWindowsPath(candidate, baseline.candidate), 'Candidate staging escaped the reviewed work root.');
  for (const target of [candidate, path.join(work, 'baseline-clone-verification.json')]) {
    try { await fs.lstat(target); throw Error('Preserve the existing staging output and inspect it before retrying: ' + target); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const outputBaseline = path.join(work, AWARENESS_BASELINE_FILE);
  try { fail(sha(await regularFile(outputBaseline)) === AWARENESS_BASELINE_SHA256, 'A different work baseline already exists.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await writeNew(outputBaseline, baselineBytes); }
  await fs.mkdir(candidate);
  for (const [relative, digest] of Object.entries(baseline.sourceFiles)) {
    const bytes = await sourceFile(source, relative); fail(sha(bytes) === digest, 'Source changed during copying: ' + relative);
    await ordinaryDirectory(path.dirname(path.join(candidate, relative)), { create: true });
    await writeNew(path.join(candidate, relative), bytes);
  }
  const dependencies = await fs.realpath(path.join(source, 'node_modules'));
  fail((await fs.stat(dependencies)).isDirectory(), 'Canonical dependencies are unavailable.');
  await fs.symlink(dependencies, path.join(candidate, 'node_modules'), 'junction');
  fail(sameWindowsPath(await fs.realpath(path.join(candidate, 'node_modules')), dependencies), 'The dependency junction points elsewhere.');
  fail(sameMap(await captureSourceFiles(candidate), baseline.sourceFiles), 'The complete staged 2.29 source inventory differs.');
  fail(await appFingerprint(candidate) === AWARENESS_BASELINE_FINGERPRINT, 'The staged baseline fingerprint differs.');
  const after = await verifyOriginals();
  const receipt = {
    format: 1, product: 'BLACKICE', version: AWARENESS_PREVIOUS_VERSION, targetVersion: AWARENESS_VERSION, platform: process.platform,
    verifiedAt: new Date().toISOString(), baselineSha256: AWARENESS_BASELINE_SHA256, source, installed, candidate,
    appFingerprint: AWARENESS_BASELINE_FINGERPRINT, sourceFilesVerified: Object.keys(baseline.sourceFiles).length,
    installedFilesVerified: Object.keys(installedFiles).length, completeInstalledInventory: true,
    candidateSourceMapSha256: sha(Buffer.from(JSON.stringify(normalize(baseline.sourceFiles)))),
    sourceUnmanaged: { beforeSha256: before.extraSha256, afterSha256: after.extraSha256, fileCount: after.extraFileCount, preserved: true },
    dependencies: { kind: 'junction', target: dependencies }, originalSourceWritten: false, installationWritten: false,
    profileWritten: false, nativeLifecycleChanged: false, providerTurnsRequested: 0, routesMutated: false, errors: [],
  };
  const receiptFile = path.join(work, 'baseline-clone-verification.json');
  await writeNew(receiptFile, Buffer.from(JSON.stringify(receipt, null, 2) + '\n'));
  return { staged: true, candidate, baselineFile: outputBaseline, baselineSha256: AWARENESS_BASELINE_SHA256, receiptFile, sourceFiles: receipt.sourceFilesVerified, installedFiles: receipt.installedFilesVerified, preservedSourceFiles: after.extraFileCount };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    fail(process.argv.length === 3, 'Supply the reviewed BASELINE_FILE; all application and work paths are pinned in that baseline.');
    console.log(JSON.stringify(await prepareAwarenessCandidate(process.argv[2]), null, 2));
  } catch (error) { console.error(JSON.stringify({ staged: false, sourceWritten: false, installedWritten: false, error: error.message }, null, 2)); process.exitCode = 1; }
}
