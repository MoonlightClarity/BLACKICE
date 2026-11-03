import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

// Evicted rolling task revisions are durable, immutable content-addressed
// checkpoints. A primary task-state file remains a bounded working set.
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const archiveDirectory = (dataDir, taskId) => path.join(dataDir, 'task-state-archives', taskId);
const archiveName = (revision, sha256) => String(revision).padStart(10, '0') + '-' + sha256 + '.json.gz';
const archivePattern = /^(\d{10})-([a-f0-9]{64})\.json\.gz$/;

async function verifiedArchive(file, revision, sha256, taskId) {
  const packed = await fs.readFile(file);
  const bytes = gunzipSync(packed);
  if (digest(bytes) !== sha256) throw new Error('Task history archive hash mismatch: ' + file);
  const saved = JSON.parse(bytes.toString('utf8'));
  if (saved.revision !== revision || saved.taskId !== taskId)
    throw new Error('Task history archive identity mismatch: ' + file);
  return saved;
}

export async function archiveTaskRevisions(dataDir, taskId, revisions, { signal, assertOwnership = async () => {} } = {}) {
  if (!revisions.length) return [];
  const directory = archiveDirectory(dataDir, taskId);
  await fs.mkdir(directory, { recursive: true });
  const receipts = [];
  for (const state of revisions) {
    if (signal?.aborted) throw signal.reason || new Error('Task archive cancelled.');
    const bytes = Buffer.from(JSON.stringify(state), 'utf8');
    const sha256 = digest(bytes), file = path.join(directory, archiveName(state.revision, sha256));
    let existing = false;
    try { await verifiedArchive(file, state.revision, sha256, taskId); existing = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!existing) {
      const temporary = file + '.' + randomUUID() + '.tmp';
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(gzipSync(bytes)); await handle.sync(); } finally { await handle.close(); }
        await assertOwnership();
        try { await fs.link(temporary, file); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      // A failed or partial archive may never permit eviction of the source.
      await verifiedArchive(file, state.revision, sha256, taskId);
    }
    receipts.push({ revision: state.revision, sha256, file });
  }
  return receipts;
}

export async function readArchivedTaskRevisions(dataDir, taskId, { signal } = {}) {
  const directory = archiveDirectory(dataDir, taskId);
  let names;
  try { names = await fs.readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const revisions = [], seen = new Map();
  for (const name of names.sort()) {
    if (signal?.aborted) throw signal.reason || new Error('Task archive read cancelled.');
    const match = archivePattern.exec(name);
    if (!match) continue;
    const revision = Number(match[1]);
    const sha256 = match[2];
    if (seen.has(revision) && seen.get(revision) !== sha256)
      throw new Error('Task history has conflicting archived revisions: ' + revision);
    seen.set(revision, sha256);
    revisions.push(await verifiedArchive(path.join(directory, name), revision, sha256, taskId));
  }
  return revisions;
}
