import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// Exact Git blobs from BLACKICE 2.39.101 source at
// 30c4a7f7d5ec75d32f924399daa9af3e56620d93.
// No dependency on another checkout, package installation or network.
export const LEGACY_239101_COMMIT = '30c4a7f7d5ec75d32f924399daa9af3e56620d93';
export const LEGACY_239101_MANIFEST_SHA256 = '4ee5c946550e17d34cbcc2e788de9f4ed7768e17da11f17b83e49ef43144131b';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const root = fileURLToPath(new URL('./legacy-239101-pinned/', import.meta.url));
const required = Object.freeze({
  'direct-execution-jobs.mjs': {
    sha256: 'ddbb83aad9003d4b98f4ae360a764c68643b671b232c9e357133629899b42b9b',
    gitBlob: '726682c802bbb349c997616bca8929fb06e9b3e6',
  },
  'direct-resource-history.mjs': {
    sha256: '75181b29deac1a30741d6bf0ab7378cea81c2a4f0c6bba70c93b702739b13309',
    gitBlob: 'bc1f2e08bd2d989c2e660aef23dfb74a2226a4f0',
  },
  'ledger-startup-metrics.mjs': {
    sha256: 'c91c062d44eb0d382c944cca993c5584be7005975e300ed2394907705bb02238',
    gitBlob: '1f2a7cc8694137fec881d620b11cb20cfde29620',
  },
});
export async function verifyPinnedLegacyReader() {
  const raw = await fs.readFile(path.join(root, 'legacy-source-manifest.json'));
  if (sha256(raw) !== LEGACY_239101_MANIFEST_SHA256) throw Error('Legacy source provenance manifest bytes changed.');
  let manifest;
  try { manifest = JSON.parse(raw.toString('utf8')); }
  catch { throw Error('Legacy source provenance manifest is invalid.'); }
  if (manifest.sourceCommit !== LEGACY_239101_COMMIT || manifest.packageVersion !== '2.39.101' ||
      !Array.isArray(manifest.files) || manifest.files.length !== 3) throw Error('Unexpected legacy reader identity.');
  for (const [name, expected] of Object.entries(required)) {
    const entry = manifest.files.find(file => file.path === name);
    if (!entry || entry.sha256 !== expected.sha256 || entry.gitBlob !== expected.gitBlob)
      throw Error('Legacy fixture provenance does not match pinned Git source.');
    const bytes = await fs.readFile(path.join(root, name));
    if (sha256(bytes) !== expected.sha256 || bytes.byteLength !== entry.bytes)
      throw Error('Legacy fixture bytes differ from accepted 2.39.101 source: ' + name);
  }
  return { sourceCommit: LEGACY_239101_COMMIT, manifestSha256: LEGACY_239101_MANIFEST_SHA256,
    checkedFiles: 3 };
}
export async function loadPinnedLegacyReader() {
  await verifyPinnedLegacyReader();
  return import(pathToFileURL(path.join(root, 'direct-execution-jobs.mjs')).href);
}
