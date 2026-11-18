import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PACK_MAX_BYTES, PACK_MAX_RECORDS,
  readPackedEntryExact, readStableLoose, readBoundedFile, writeNewPackFile,
  packDigest, packStatOf, packError } from './direct-execution-packs.mjs';
import { requireDiskSpace, syncDirectoryEntry } from './direct-execution-pack-durability.mjs';
import { independentExportTopology } from './direct-execution-pack-topology.mjs';

// This filename and journal format identify durable backup data already on disk.
// Retaining them avoids orphaning backups; it does not enable old-version behavior.
export const RECEIPT_BACKUP_JOURNAL = 'legacy-export-v1.json';
const JOB_FILE = /^direct_[a-f0-9]{64}\.json$/;
const JOB_ID = /^direct_[a-f0-9]{64}$/;
const safe = message => packError('Verified receipt backup/restore: ' + message);
// Missing/stale/corrupted independent backup input is a pre-mutation refusal;
// it does not mean the authoritative receipt store is itself corrupt.
const backupOnly = message => Object.assign(safe(message), { backupOnly: true });
const checkBackupInput = async operation => {
  try { return await operation(); }
  catch { throw backupOnly('Independent backup destination or journal cannot be trusted.'); }
};
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isDirectory = stat => stat?.isDirectory() && !stat.isSymbolicLink();
const outFile = (target, id) => path.join(target, 'direct-execution-jobs', id + '.json');
const journalPath = target => path.join(target, RECEIPT_BACKUP_JOURNAL);
// Unfinished receipts are full in-memory records with hashes held in the
// WeakMap, whereas terminal metadata carries its digest as a field.
const ordered = store => [...store.records.values()].map(record => ({
  id: record.id, revision: record.revision,
  receiptHash: store.receiptHashes.get(record) || record.receiptHash,
})).sort((a, b) => a.id.localeCompare(b.id));
function sourceFingerprint(records) {
  const digest = createHash('sha256');
  for (const item of records) {
    if (!JOB_ID.test(item.id) || !validHash(item.receiptHash) ||
        !Number.isSafeInteger(item.revision))
      throw safe('Source index contains an unverified receipt identity.');
    digest.update(item.id + '\0' + item.revision + '\0' + item.receiptHash + '\n');
  }
  return digest.digest('hex');
}
async function validateTarget(store, target, expectedCanonical = null) {
  const result = await independentExportTopology(store.io, store.directory, target, { expectedCanonical });
  return result.canonicalDestination;
}
async function ensureTarget(io, folder, { allowCreate }) {
  let present;
  try { present = await io.lstat(folder); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!present) {
    if (!allowCreate) throw safe('Receipt backup does not exist.');
    await io.mkdir(folder, { recursive: true, mode: 0o700 });
    present = await io.lstat(folder);
  }
  if (!isDirectory(present)) throw safe('Receipt backup folder is not an ordinary directory.');
  const jobs = path.join(folder, 'direct-execution-jobs');
  let stat;
  try { stat = await io.lstat(jobs); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!stat) { if (!allowCreate) throw safe('Receipt backup job directory disappeared.'); await io.mkdir(jobs, { mode: 0o700 }); stat = await io.lstat(jobs); }
  if (!isDirectory(stat)) throw safe('Receipt backup receipts are not in an ordinary directory.');
}
const journalValid = value => value && typeof value === 'object' && !Array.isArray(value) &&
  value.version === 1 && validHash(value.sourceFingerprint) &&
  Number.isSafeInteger(value.total) && value.total >= 0 &&
  Number.isSafeInteger(value.copyCursor) && value.copyCursor >= 0 && value.copyCursor <= value.total &&
  Number.isSafeInteger(value.verifyCursor) && value.verifyCursor >= 0 && value.verifyCursor <= value.total &&
  Number.isSafeInteger(value.restoreCursor) && value.restoreCursor >= 0 && value.restoreCursor <= value.total &&
  ['copy','verify','complete'].includes(value.phase) &&
  typeof value.exportId === 'string' && /^[a-f0-9-]{36}$/.test(value.exportId);
async function readJournal(io, folder) {
  const file = journalPath(folder), stat = await packStatOf(io, file);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 || stat.size < 10)
    throw safe('Receipt backup journal is unsafe.');
  let raw;
  try { raw = await readBoundedFile(io, file, stat); } catch { throw safe('Receipt backup journal cannot be read.'); }
  if (raw.length !== stat.size) throw safe('Receipt backup journal changed during read.');
  let value;
  try { value = JSON.parse(raw.toString('utf8')); } catch { throw safe('Receipt backup journal has invalid JSON.'); }
  if (!journalValid(value)) throw safe('Receipt backup journal has invalid bounds or identity.');
  return value;
}
async function writeJournal(io, target, value, { reserveBytes }) {
  if (!journalValid(value)) throw safe('Receipt backup journal update is invalid.');
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 16 * 1024) throw safe('Receipt backup journal exceeds bounded size.');
  await requireDiskSpace(io, target, bytes.length, { reserveBytes });
  const file = journalPath(target), temporary = file + '.' + randomUUID() + '.tmp';
  const previous = await readJournal(io, target);
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const delays = [20, 40, 80, 160], transient = new Set(['EACCES', 'EPERM', 'EBUSY']);
  try {
    await writeNewPackFile(io, temporary, bytes);
    for (let attempt = 0; ; attempt++) {
      const current = await readJournal(io, target);
      if (same(current, value)) return await syncDirectoryEntry(io, target);
      if (!same(current, previous)) throw safe('Another export journal revision appeared unexpectedly.');
      try { await io.rename(temporary, file); }
      catch (error) {
        const after = await readJournal(io, target);
        if (same(after, value)) return await syncDirectoryEntry(io, target);
        if (!same(after, previous) || process.platform !== 'win32' ||
            !transient.has(error?.code) || attempt >= delays.length) throw error;
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
        continue;
      }
      const after = await readJournal(io, target);
      if (!same(after, value)) throw safe('Receipt backup journal publication was not verified.');
      return await syncDirectoryEntry(io, target);
    }
  } finally { await io.rm(temporary, { force: true }).catch(() => {}); }
}
function verifyIdentity(journal, records) {
  if (!journalValid(journal) || journal.total !== records.length ||
      journal.sourceFingerprint !== sourceFingerprint(records))
    throw safe('Receipt backup does not match the current authoritative receipt revisions.');
}
async function sourceBytes(store, item, validateRecord) {
  let saved;
  if (store.packedIndex.has(item.id) && !store.looseIds.has(item.id)) {
    const loc = store.packedIndex.get(item.id), segment = store.packSegments.get(loc.name);
    if (!segment) throw safe('Authoritative archive location was not validated.');
    saved = await readPackedEntryExact(store.io, store.directory, loc, segment.signature, validateRecord);
  } else {
    saved = await readStableLoose(store.io, store.file(item.id), item.receiptHash, validateRecord);
  }
  if (saved.record.id !== item.id || saved.record.revision !== item.revision ||
      saved.receiptHash !== item.receiptHash)
    throw safe('Source receipt changed after authoritative indexing.');
  return saved.bytes;
}
async function exportFile(io, target, item, bytes, validateRecord) {
  const destination = outFile(target, item.id);
  if (await packStatOf(io, destination)) {
    const existing = await readStableLoose(io, destination, item.receiptHash, validateRecord);
    if (existing.record.id !== item.id || existing.record.revision !== item.revision ||
        !existing.bytes.equals(bytes)) throw safe('Existing backup receipt is not exactly equivalent.');
    return false;
  }
  const temporary = destination + '.' + randomUUID() + '.tmp';
  try {
    await writeNewPackFile(io, temporary, bytes);
    try { await io.link(temporary, destination); }
    catch (error) {
      if (!(await packStatOf(io, destination))) throw error;
      const found = await readStableLoose(io, destination, item.receiptHash, validateRecord);
      if (!found.bytes.equals(bytes)) throw safe('Concurrent export publication disagrees.');
    }
    const verified = await readStableLoose(io, destination, item.receiptHash, validateRecord);
    if (!verified.bytes.equals(bytes)) throw safe('Exported receipt publication failed verification.');
    return true;
  } finally { await io.rm(temporary, { force: true }).catch(() => {}); }
}
function limits({ maxRecords = PACK_MAX_RECORDS, maxBytes = PACK_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > PACK_MAX_RECORDS ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PACK_MAX_BYTES)
    throw safe('Choose a bounded export or restore batch.');
  return { maxRecords, maxBytes };
}

/** Each call writes/verifies no more than 256 records and 16MiB.
 * Resume is safe after process kill between file link and journal rename:
 * a present output must match exact authoritative bytes, or we fail closed.
 * Nothing in the source profile is removed.
 */
export async function exportReceiptBackupBatch(store, validateRecord, { destination, maxRecords, maxBytes, reserveBytes } = {}) {
  const io = store.io, target = await validateTarget(store, destination), cap = limits({ maxRecords, maxBytes });
  await store.assertLease();
  await ensureTarget(io, target, { allowCreate: true });
  await validateTarget(store, destination, target);
  const records = ordered(store);
  let journal = await readJournal(io, target);
  if (!journal) {
    const contents = await io.readdir(path.join(target, 'direct-execution-jobs'));
    if (contents.length || (await io.readdir(target)).some(name => name !== 'direct-execution-jobs'))
      throw safe('New export folder is not empty and has no authoritative journal.');
    journal = { version: 1, exportId: randomUUID(), sourceFingerprint: sourceFingerprint(records),
      total: records.length, copyCursor: 0, verifyCursor: 0, restoreCursor: 0, phase: 'copy' };
    await validateTarget(store, destination, target);
    await writeJournal(io, target, journal, { reserveBytes });
  }
  verifyIdentity(journal, records);
  if (journal.phase === 'complete')
    return { phase: 'complete', copied: 0, verified: 0, total: records.length,
      cursor: journal.copyCursor, exportId: journal.exportId };
  const step = journal.phase, key = step === 'copy' ? 'copyCursor' : 'verifyCursor';
  const begin = journal[key], batch = [];
  let bytes = 0;
  for (let index = begin; index < records.length && batch.length < cap.maxRecords; index++) {
    const item = records[index], raw = await sourceBytes(store, item, validateRecord);
    if (bytes + raw.length > cap.maxBytes) {
      if (!batch.length) throw safe('An individual source receipt exceeds the chosen batch limit.');
      break;
    }
    batch.push({ item, bytes: raw });
    bytes += raw.length;
  }
  if (step === 'copy') {
    await requireDiskSpace(io, target, bytes, { reserveBytes });
    for (const item of batch) {
      await validateTarget(store, destination, target);
      await exportFile(io, target, item.item, item.bytes, validateRecord);
    }
    await syncDirectoryEntry(io, path.join(target, 'direct-execution-jobs'));
  } else {
    for (const item of batch) {
      const dest = await readStableLoose(io, outFile(target, item.item.id), item.item.receiptHash, validateRecord);
      if (!dest.bytes.equals(item.bytes) || dest.record.revision !== item.item.revision)
        throw safe('Export verification found a changed or incomplete receipt.');
    }
  }
  journal = { ...journal, [key]: begin + batch.length };
  if (step === 'copy' && journal.copyCursor === journal.total) journal.phase = 'verify';
  if (step === 'verify' && journal.verifyCursor === journal.total) journal.phase = 'complete';
  await validateTarget(store, destination, target);
  const sync = await writeJournal(io, target, journal, { reserveBytes });
  return { phase: journal.phase, copied: step === 'copy' ? batch.length : 0,
    verified: step === 'verify' ? batch.length : 0, total: journal.total,
    cursor: journal[key], exportId: journal.exportId, directorySync: sync };
}

/** Restore exact source copies from a complete, verified independent export.
 * This is not a rollback shortcut; the pack manifest and refusal marker remain
 * in place after restoration as well; receipt recovery never enables downgrade.
 */
export async function restoreReceiptBackupBatch(store, validateRecord, { destination, maxRecords, maxBytes, reserveBytes } = {}) {
  const io = store.io, target = await validateTarget(store, destination), cap = limits({ maxRecords, maxBytes });
  await store.assertLease(); await ensureTarget(io, target, { allowCreate: false });
  await validateTarget(store, destination, target);
  let journal = await readJournal(io, target);
  const records = ordered(store);
  verifyIdentity(journal, records);
  if (journal.phase !== 'complete') throw safe('Backup export must be fully verified before restoring.');
  const begin = journal.restoreCursor, batch = [];
  let bytes = 0;
  for (let index = begin; index < records.length && batch.length < cap.maxRecords; index++) {
    const item = records[index], raw = await sourceBytes(store, item, validateRecord);
    const backed = await readStableLoose(io, outFile(target, item.id), item.receiptHash, validateRecord);
    if (!backed.bytes.equals(raw) || backed.record.revision !== item.revision)
      throw safe('Verified backup no longer matches its authoritative source.');
    if (bytes + backed.bytes.length > cap.maxBytes) {
      if (!batch.length) throw safe('An individual restore receipt exceeds the chosen byte limit.');
      break;
    }
    batch.push({ item, bytes: backed.bytes }); bytes += backed.bytes.length;
  }
  const missing = batch.filter(({ item }) => !store.looseIds.has(item.id));
  if (missing.length) {
    await requireDiskSpace(io, store.directory,
      missing.reduce((sum, item) => sum + item.bytes.length, 0), { reserveBytes });
  }
  for (const { item, bytes: raw } of batch) {
    await validateTarget(store, destination, target);
    const file = store.file(item.id);
    if (store.looseIds.has(item.id)) {
      const existing = await readStableLoose(io, file, item.receiptHash, validateRecord);
      if (!existing.bytes.equals(raw)) throw safe('An existing loose receipt disagrees with backup.');
      continue;
    }
    await exportFile(io, path.dirname(store.directory), item, raw, validateRecord);
    const verified = await readStableLoose(io, file, item.receiptHash, validateRecord);
    if (!verified.bytes.equals(raw)) throw safe('Restored source receipt has changed.');
    store.looseIds.add(item.id);
  }
  const sync = await syncDirectoryEntry(io, store.directory);
  journal = { ...journal, restoreCursor: begin + batch.length };
  await validateTarget(store, destination, target);
  await writeJournal(io, target, journal, { reserveBytes });
  return { copiedOrChecked: batch.length, remaining: journal.total - journal.restoreCursor,
    fullyRestored: journal.restoreCursor === journal.total, directorySync: sync,
    markerPresent: store.packMarkerPresent };
}


/** Production-intent retirement preflight. A completed independent export is
 * required and EVERY targeted loose original must match that export exactly.
 * This helper only checks; the existing lease-serialized retirement does the
 * mutation after the full targeted batch passes. No live connector route.
 */
export async function verifyRetirementBackupBatch(store, validateRecord, {
  destination, maxRecords = PACK_MAX_RECORDS,
} = {}) {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > PACK_MAX_RECORDS)
    throw safe('Choose a bounded retirement backup validation batch.');
  const target = await checkBackupInput(() => validateTarget(store, destination)), io = store.io;
  await store.assertLease();
  await checkBackupInput(() => ensureTarget(io, target, { allowCreate: false }));
  await checkBackupInput(() => validateTarget(store, destination, target));
  const journal = await checkBackupInput(() => readJournal(io, target)), records = ordered(store);
  try { verifyIdentity(journal, records); }
  catch { throw backupOnly('Independent backup no longer matches the current authoritative revisions.'); }
  if (journal.phase !== 'complete') throw backupOnly('Independent backup export is not fully verified.');
  let checked = 0;
  const checkedIds = [];
  for (const [id, location] of store.packedIndex) {
    if (!store.looseIds.has(id)) continue;
    const indexed = store.records.get(id);
    if (!indexed || indexed.receiptHash !== location.receiptHash) continue; // Newer override not retired.
    await checkBackupInput(() => validateTarget(store, destination, target));
    const item = { id, revision: indexed.revision, receiptHash: indexed.receiptHash };
    const raw = await sourceBytes(store, item, validateRecord);
    const backup = await checkBackupInput(() => readStableLoose(io, outFile(target, id), item.receiptHash, validateRecord));
    if (!backup.bytes.equals(raw) || backup.record.revision !== item.revision)
      throw backupOnly('Independent export no longer matches a retirement candidate.');
    checked++;
    checkedIds.push(id);
    if (checked >= maxRecords) break;
  }
  return { verified: checked, checkedIds, sourceFingerprint: journal.sourceFingerprint,
    exportId: journal.exportId, independentPath: target, powerLossDurabilityProven: false };
}


/** Immediately before one unlink, repeat topology and byte-equivalence checks.
 * This guards a stale/replaced independent export and changed loose revision,
 * without claiming Node path-based operations are immune to a concurrent
 * filesystem rename or junction swap between this check and unlink.
 */
export async function verifyRetirementBackupReceipt(store, validateRecord, {
  destination, expectedCanonical, exportId, sourceFingerprint: fingerprint, id, revision, receiptHash,
} = {}) {
  const target = await validateTarget(store, destination, expectedCanonical);
  const journal = await readJournal(store.io, target);
  if (!journal || journal.phase !== 'complete' || journal.exportId !== exportId ||
      journal.sourceFingerprint !== fingerprint)
    throw safe('Completed independent export changed after batch verification.');
  const indexed = store.records.get(id);
  if (!indexed || indexed.revision !== revision ||
      (store.receiptHashes.get(indexed) || indexed.receiptHash) !== receiptHash ||
      !store.looseIds.has(id)) throw safe('Authoritative loose revision changed before retirement.');
  const item = { id, revision, receiptHash };
  const raw = await sourceBytes(store, item, validateRecord);
  const backup = await readStableLoose(store.io, outFile(target, id), receiptHash, validateRecord);
  if (!backup.bytes.equals(raw) || backup.record.revision !== revision ||
      backup.record.id !== id) throw safe('Independent export no longer verifies the exact retirement receipt.');
  return { verified: true, canonicalDestination: target };
}
