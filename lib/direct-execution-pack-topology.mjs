import path from 'node:path';
import { promises as fs } from 'node:fs';

const refuse = message => Object.assign(new Error(message), { code: 'DIRECT_JOB_STORAGE', status: 503 });
const unavailable = error => error?.code === 'ENOENT';
const key = (value, platform) => {
  let normalized = path.normalize(path.resolve(value));
  if (platform === 'win32') {
    // Strip Win32 extended-length spelling, then compare case-insensitively.
    if (normalized.startsWith('\\\\?\\UNC\\')) normalized = '\\\\' + normalized.slice(8);
    else if (normalized.startsWith('\\\\?\\')) normalized = normalized.slice(4);
    normalized = normalized.replaceAll('/', '\\').toLowerCase();
  }
  return path.normalize(normalized);
};
const contains = (base, selected, platform) => {
  const left = key(base, platform), right = key(selected, platform);
  const relation = path.relative(left, right);
  return !relation || (relation !== '..' && !relation.startsWith('..' + path.sep) && !path.isAbsolute(relation));
};
function sameFilesystemObject(a, b) {
  return a && b && Number.isSafeInteger(a.ino) && a.ino > 0 &&
    Number.isSafeInteger(b.ino) && b.ino > 0 && a.dev === b.dev && a.ino === b.ino;
}
// Resolve existing symlink/junction ancestors before appending any yet-missing
// tail. Never guess a path from its lexical spelling after a failed realpath.
async function canonicalOrExistingAncestor(io, absolute) {
  const missing = [];
  let candidate = path.resolve(absolute);
  for (;;) {
    try {
      const resolved = await io.realpath(candidate);
      return { resolved: path.join(resolved, ...missing.reverse()), existing: resolved };
    } catch (error) {
      if (!unavailable(error)) throw refuse('Export path topology could not be resolved.');
      const parent = path.dirname(candidate);
      if (parent === candidate) throw refuse('Export destination has no resolvable existing ancestor.');
      missing.push(path.basename(candidate));
      candidate = parent;
    }
  }
}
/** Canonical filesystem-topology check, not a general TOCTOU guarantee.
 * An attacker able to mutate directories concurrently could still race Node
 * path-based operations. Root must keep the profile/backup tree quiescent.
 */
export async function independentExportTopology(io = fs, storeDirectory, destination, {
  expectedCanonical = null, platform = process.platform,
} = {}) {
  if (typeof storeDirectory !== 'string' || !path.isAbsolute(storeDirectory) ||
      typeof destination !== 'string' || !path.isAbsolute(destination))
    throw refuse('A supported absolute source and independent export destination are required.');
  let source, target;
  const profile = path.dirname(path.resolve(storeDirectory));
  try {
    source = await io.realpath(profile);
    target = await canonicalOrExistingAncestor(io, destination);
  } catch (error) {
    if (error?.code === 'DIRECT_JOB_STORAGE') throw error;
    throw refuse('Export source or destination topology cannot be verified.');
  }
  if (contains(source, target.resolved, platform) || contains(target.resolved, source, platform))
    throw refuse('Export destination resolves to the source profile or its ancestor/descendant.');
  if (expectedCanonical !== null && key(expectedCanonical, platform) !== key(target.resolved, platform))
    throw refuse('Export destination changed its real filesystem topology during maintenance.');
  // On Windows aliasing and volume spellings can be complex. Check object
  // identity as an independent defense when inode metadata is available.
  let sourceIdentity, ancestorIdentity;
  try {
    sourceIdentity = await io.stat(source);
    ancestorIdentity = await io.stat(target.existing);
  } catch { throw refuse('Export filesystem identity cannot be verified.'); }
  if (sameFilesystemObject(sourceIdentity, ancestorIdentity))
    throw refuse('Export destination shares the authoritative source directory identity.');
  return { canonicalDestination: target.resolved, canonicalSource: source,
    topologyVerified: true, concurrentFilesystemMutationsExcluded: false };
}
