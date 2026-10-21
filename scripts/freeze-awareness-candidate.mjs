#!/usr/bin/env node
/** Freeze the local source overlay onto the complete pinned Windows baseline.
 * Missing local baseline assets are inherited by hash, never removed.
 * node scripts/freeze-awareness-candidate.mjs BASELINE_FILE OUTPUT_MANIFEST
 * The output must be outside the candidate and must not already exist.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { captureSourceFiles, validatePatchPath } from './install-background-update.mjs';
import { candidateChanges } from './install-planning-update.mjs';
import { validateAwarenessBaseline, AWARENESS_BASELINE_SHA256, AWARENESS_BASELINE_FINGERPRINT, AWARENESS_VERSION, AWARENESS_PREVIOUS_VERSION } from './prepare-awareness-candidate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA256 = /^[a-f0-9]{64}$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const invariant = (value, message) => { if (!value) throw Error(message); };
const sorted = value => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));

export function createAwarenessManifest(baseline, localSourceFiles) {
  invariant(localSourceFiles && typeof localSourceFiles === 'object' && !Array.isArray(localSourceFiles) && Object.keys(localSourceFiles).length > 0, 'Supply a nonempty exact local candidate inventory.');
  for (const [relative, digest] of Object.entries(localSourceFiles)) { validatePatchPath(relative); invariant(SHA256.test(digest), 'Invalid local source hash.'); }
  const sourceFiles = sorted({ ...baseline.sourceFiles, ...localSourceFiles }), changes = candidateChanges(baseline, sourceFiles);
  const localFiles = Object.keys(localSourceFiles).sort(), inheritedFiles = Object.keys(baseline.sourceFiles).filter(file => !Object.hasOwn(localSourceFiles, file)).sort();
  invariant(changes.some(item => item.path === 'package.json'), 'Freeze the new candidate version before release.');
  return {
    format: 1, product: 'BLACKICE', version: AWARENESS_VERSION, previousVersion: AWARENESS_PREVIOUS_VERSION,
    baselineSha256: AWARENESS_BASELINE_SHA256, originalFingerprint: AWARENESS_BASELINE_FINGERPRINT,
    candidate: baseline.candidate, sourceFiles, localFiles, inheritedFiles, changes,
  };
}

export function validateAwarenessManifest(value, baseline, currentSourceFiles) {
  invariant(value?.format === 1 && value.product === 'BLACKICE' && value.version === AWARENESS_VERSION && value.previousVersion === AWARENESS_PREVIOUS_VERSION && value.baselineSha256 === AWARENESS_BASELINE_SHA256 && value.originalFingerprint === AWARENESS_BASELINE_FINGERPRINT && value.candidate === baseline.candidate, 'The candidate manifest belongs to another release or baseline.');
  invariant(Array.isArray(value.localFiles) && Array.isArray(value.inheritedFiles) && value.sourceFiles && typeof value.sourceFiles === 'object', 'The candidate manifest lacks its full local and inherited inventory.');
  const localFiles = Object.fromEntries(value.localFiles.map(relative => [relative, value.sourceFiles[relative]]));
  const expected = createAwarenessManifest(baseline, localFiles);
  invariant(JSON.stringify(value) === JSON.stringify(expected), 'The frozen source manifest is incomplete, duplicated, reordered or inconsistent.');
  if (currentSourceFiles) invariant(JSON.stringify(sorted(currentSourceFiles)) === JSON.stringify(expected.sourceFiles), 'The staged candidate differs from the frozen complete source inventory.');
  return expected;
}

export async function freezeAwarenessCandidate(baselineFile, outputFile, candidate = ROOT) {
  const baseline = validateAwarenessBaseline(await fs.readFile(path.resolve(baselineFile))), out = path.resolve(outputFile), root = path.resolve(candidate);
  invariant(out !== root && !out.startsWith(root + path.sep), 'Write the frozen manifest outside the candidate.');
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  invariant(version === AWARENESS_VERSION, 'The local candidate has not adopted version ' + AWARENESS_VERSION + '.');
  const sourceFiles = await captureSourceFiles(root), manifest = createAwarenessManifest(baseline, sourceFiles);
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await fs.writeFile(out, bytes, { flag: 'wx', mode: 0o600 });
  invariant(JSON.stringify(await captureSourceFiles(root)) === JSON.stringify(sourceFiles), 'Local source changed while its manifest was written. Preserve this failed attempt and freeze the final bytes again.');
  return { frozen: true, manifestFile: out, manifestSha256: sha(bytes), localFiles: manifest.localFiles.length, inheritedFiles: manifest.inheritedFiles.length, completeSourceFiles: Object.keys(manifest.sourceFiles).length, changedFiles: manifest.changes.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    invariant(process.argv.length === 4, 'Supply BASELINE_FILE OUTPUT_MANIFEST.');
    console.log(JSON.stringify(await freezeAwarenessCandidate(...process.argv.slice(2)), null, 2));
  } catch (error) { console.error(JSON.stringify({ frozen: false, error: error.message })); process.exitCode = 1; }
}
