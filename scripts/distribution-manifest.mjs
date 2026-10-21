import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MANIFEST_FILE = 'relay-distribution.json';

/** Match the desktop runtime globs and exclusions in electron-builder.yml. */
export async function desktopRuntimeModules(directory) {
  const files = [];
  async function visit(relative) {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.name.includes('.currents-backup-') || name === 'desktop/build-icon.mjs') continue;
      if (entry.isSymbolicLink()) throw new Error('Application inputs cannot contain links.');
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile() && (/\.(?:mjs|cjs)$/.test(name) || name.startsWith('desktop/browser-compatibility/')) && !name.endsWith('.test.mjs')) files.push(name);
    }
  }
  await visit('desktop'); return files.sort();
}

export async function distributionFiles(directory) {
  const files = [];
  async function visit(relative = '') {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
      if (entry.isSymbolicLink()) throw new Error('Distribution files cannot contain links.');
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile() && name !== MANIFEST_FILE) files.push(name);
      else if (!entry.isFile()) throw new Error('Unsupported distribution file type.');
    }
  }
  await visit(); return files.sort();
}
export async function createDistributionManifest(directory, version) {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('A release version is required.');
  const files = [];
  for (const relative of await distributionFiles(directory)) {
    const file = path.join(directory, relative), handle = await fs.open(file, 'r');
    try { const digest = createHash('sha256'); for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk); files.push({ path: relative, size: (await handle.stat()).size, sha256: digest.digest('hex') }); }
    finally { await handle.close(); }
  }
  if (!files.some(file => file.path === 'Relay.exe') || !files.some(file => file.path === 'resources/app/package.json') || !files.some(file => file.path === 'Install-Relay.ps1')) throw new Error('The distribution is missing required application files.');
  const manifest = { format: 1, product: 'Relay', version, createdAt: new Date().toISOString(), files };
  await fs.writeFile(path.join(directory, MANIFEST_FILE), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  return manifest;
}
export async function verifyDistribution(directory) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, MANIFEST_FILE), 'utf8'));
  if (manifest.format !== 1 || manifest.product !== 'Relay' || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid Relay distribution manifest.');
  const actual = await distributionFiles(directory), expected = manifest.files.map(file => file.path).sort();
  if (new Set(expected).size !== expected.length || JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Distribution file list does not match its manifest.');
  for (const record of manifest.files) {
    if (typeof record.path !== 'string' || record.path.includes('\\') || record.path.startsWith('/') || record.path.split('/').some(part => !part || ['.', '..'].includes(part)) || !/^[a-f0-9]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.size) || record.size < 0) throw new Error('Invalid distribution file record.');
    const file = path.join(directory, record.path), handle = await fs.open(file, 'r');
    try { const digest = createHash('sha256'); for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk); if ((await handle.stat()).size !== record.size || digest.digest('hex') !== record.sha256) throw new Error(`Distribution file failed verification: ${record.path}`); }
    finally { await handle.close(); }
  }
  if (JSON.parse(await fs.readFile(path.join(directory, 'resources/app/package.json'), 'utf8')).version !== manifest.version) throw new Error('Application version does not match its manifest.');
  return manifest;
}

export function validateArchiveListing(listing, manifest, root = 'Relay-Desktop-Windows') {
  const files = new Set();
  for (const raw of listing.split(/\r?\n/).filter(Boolean)) {
    const name = raw.replaceAll('\\', '/');
    if (!name.startsWith(`${root}/`) || name.split('/').some(part => ['.', '..'].includes(part)) || name.includes(':')) throw new Error('Archive contains an unexpected path.');
    if (!name.endsWith('/')) { const file = name.slice(root.length + 1); if (files.has(file)) throw new Error('Archive contains duplicate files.'); files.add(file); }
  }
  const expected = [MANIFEST_FILE, ...manifest.files.map(file => file.path)].sort();
  if (JSON.stringify([...files].sort()) !== JSON.stringify(expected)) throw new Error('Archive does not contain the complete verified distribution.');
}
