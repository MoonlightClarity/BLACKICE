import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  PACK_MAX_BYTES, PACK_MAX_RECORDS, PACK_MAX_SEGMENTS,
  PACK_MARKER_CONTENT, packManifestPath, packMarkerPath, packSegmentPath,
  readPackManifest, readPackSegment, readPackedEntry, readStableLoose,
  encodePackSegment, writeNewPackFile, packName, packDigest, packStatOf,
  packStatStable, packError, readBoundedFile,
} from './direct-execution-packs.mjs';
import { requireDiskSpace, syncDirectoryEntry } from './direct-execution-pack-durability.mjs';
import { verifyRetirementBackupBatch, verifyRetirementBackupReceipt } from './direct-execution-pack-recovery.mjs';

const WINDOWS_RETRY_MS = [20, 40, 80, 160];
const WINDOWS_RETRY_CODES = new Set(['EACCES', 'EPERM', 'EBUSY']);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digestFile = async (io, file) => {
  const before = await packStatOf(io, file);
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.size > 2 * 1024 * 1024)
    throw packError('Published terminal manifest is unsafe.');
  const bytes = await readBoundedFile(io, file, before), after = await io.lstat(file);
  if (!packStatStable(before, after) || before.size !== bytes.byteLength)
    throw packError('Published terminal manifest changed during verification.');
  return packDigest(bytes);
};
const storageFailure = (store, error) => {
  store.storageError = packError('Terminal pack publication or duplicate retirement could not be confirmed. Existing records were preserved; restart to validate authoritative storage.');
  store.storageError.cause = error; return store.storageError;
};
async function publishManifest(store, next, previousHash) {
  const io = store.io, file = packManifestPath(store.directory), bytes = Buffer.from(JSON.stringify(next)), nextHash = packDigest(bytes);
  if (bytes.byteLength > 2 * 1024 * 1024) throw packError('Terminal pack manifest exceeds its size budget.');
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await writeNewPackFile(io, temp, bytes);
    for (let attempt = 0; ; attempt++) {
      await store.assertLease();
      const current = await digestFile(io, file);
      if (current !== null && current === nextHash) {
        store.packDurability.manifest = await syncDirectoryEntry(io, store.directory);
        return nextHash; // Lost rename acknowledgment, exact bytes confirmed.
      }
      if (current !== previousHash)
        throw packError('Terminal pack manifest changed since last validation.');
      try { await io.rename(temp, file); }
      catch (error) {
        if (await digestFile(io, file) === nextHash) {
          store.packDurability.manifest = await syncDirectoryEntry(io, store.directory);
          return nextHash;
        }
        if (store.platform !== 'win32' || !WINDOWS_RETRY_CODES.has(error.code) ||
            attempt >= WINDOWS_RETRY_MS.length) throw error;
        if (await digestFile(io, temp) !== nextHash) throw packError('Uncommitted manifest bytes changed.');
        await pause(WINDOWS_RETRY_MS[attempt]);
        continue;
      }
      if (await digestFile(io, file) !== nextHash) throw packError('Manifest rename was not verified.');
      store.packDurability.manifest = await syncDirectoryEntry(io, store.directory);
      return nextHash;
    }
  } finally { await io.rm(temp, { force: true }).catch(() => {}); }
}
async function publishNewSegment(store, name, encoded, descriptor, validateRecord) {
  const io = store.io, file = packSegmentPath(store.directory, name);
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await writeNewPackFile(io, temp, encoded.bytes);
    await store.assertLease();
    // link creates exactly one immutable name without overwriting an archive.
    // A lost acknowledgment is checked before proceeding.
    try { await io.link(temp, file); }
    catch (error) {
      try { await readPackSegment(io, store.directory, descriptor, validateRecord); }
      catch { throw error; }
    }
    const checked = await readPackSegment(io, store.directory, descriptor, validateRecord);
    store.packDurability.segment = await syncDirectoryEntry(io, store.directory);
    return checked;
  } finally { await io.rm(temp, { force: true }).catch(() => {}); }
}
async function assertSameManifest(store) {
  const fresh = await readPackManifest(store.io, store.directory);
  if (fresh.manifestSha256 !== store.packManifestHash ||
      fresh.markerPresent !== store.packMarkerPresent)
    throw packError('Terminal pack manifest/rollback guard changed after startup validation.');
  return fresh;
}
async function ensureDowngradeMarker(store) {
  if (store.packMarkerPresent) return;
  if (!store.packManifest || !store.packManifestHash) throw packError('Cannot protect unpublished terminal pack.');
  const io = store.io, marker = packMarkerPath(store.directory);
  if (await packStatOf(io, marker)) throw packError('Unexpected rollback marker appeared.');
  // Refuse before changing anything if even the marker's file data cannot be
  // allocated while maintaining the reserved free-space floor.
  await requireDiskSpace(io, store.directory, Buffer.byteLength(PACK_MARKER_CONTENT));
  const temp = marker + '.' + randomUUID() + '.tmp';
  try {
    await writeNewPackFile(io, temp, Buffer.from(PACK_MARKER_CONTENT));
    await store.assertLease();
    try { await io.link(temp, marker); }
    catch (error) {
      const now = await readPackManifest(io, store.directory);
      if (!now.markerPresent || now.manifestSha256 !== store.packManifestHash) throw error;
    }
    const verified = await readPackManifest(io, store.directory);
    if (!verified.markerPresent || verified.manifestSha256 !== store.packManifestHash)
      throw packError('Rollback marker publication could not be confirmed.');
    store.packDurability.marker = await syncDirectoryEntry(io, store.directory);
    store.packMarkerPresent = true;
  } finally { await io.rm(temp, { force: true }).catch(() => {}); }
}

/** Explicit two-phase maintenance. Stages ONE <=16MiB immutable segment,
 * publishes its manifest atomically, but NEVER deletes originals. Requires a
 * new, complete validating startup before duplicate retirement. Not exposed
 * to the live connector or automatic startup.
 */
export async function stageTerminalPack(store, validateRecord, {
  maxRecords = PACK_MAX_RECORDS, maxBytes = PACK_MAX_BYTES, reserveBytes,
} = {}) {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > PACK_MAX_RECORDS ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 13 || maxBytes > PACK_MAX_BYTES)
    throw packError('Unsupported bounded terminal packing request.');
  try {
    await store.assertLease(); await assertSameManifest(store);
    if ((store.packManifest?.segments.length || 0) >= PACK_MAX_SEGMENTS)
      throw packError('Terminal pack segment-count limit reached.');
    let size = 8, candidates = [];
    for (const value of store.records.values()) {
      if (candidates.length >= maxRecords) break;
      if (!['succeeded','failed','cancelled','interrupted'].includes(value.status) ||
          store.packedIndex.has(value.id) || !store.looseIds.has(value.id)) continue;
      const saved = await readStableLoose(store.io, store.file(value.id), store.receiptHashes.get(value), validateRecord);
      if (saved.record.revision !== value.revision || saved.record.id !== value.id)
        throw packError('A loose receipt changed after startup indexing.');
      if (size + 4 + saved.bytes.length > maxBytes) {
        if (!candidates.length) continue; // Oversized receipts remain individual files.
        break;
      }
      candidates.push(saved); size += 4 + saved.bytes.length;
    }
    if (!candidates.length) return { staged: 0, bytes: 0, removed: 0, generation: store.packManifest?.generation || 0 };
    const segment = encodePackSegment(candidates.map(item => item.bytes));
    const name = packName(), descriptor = { name, sha256: segment.sha256, bytes: segment.bytes.length, count: candidates.length };
    const next = { version: 1, generation: (store.packManifest?.generation || 0) + 1,
      segments: [...(store.packManifest?.segments || []), descriptor] };
    // Measure free blocks on the DESTINATION volume before any new segment or
    // temporary manifest is written. The hard link shares the segment inode.
    const space = await requireDiskSpace(store.io, store.directory,
      segment.bytes.length + Buffer.byteLength(JSON.stringify(next)), { reserveBytes });
    const loaded = await publishNewSegment(store, name, segment, descriptor, validateRecord);
    for (const { record, location } of loaded.entries) {
      const value = store.records.get(record.id);
      if (!value || value.revision !== record.revision || store.receiptHashes.get(value) !== location.receiptHash)
        throw packError('Verified segment does not equal indexed authoritative receipt.');
    }
    const nextHash = await publishManifest(store, next, store.packManifestHash);
    store.packManifest = next; store.packManifestHash = nextHash;
    // This newly published pack must pass an independent subsequent startup
    // before any loose original can be retired.
    store.packsValidatedOnStartup = false;
    store.packSegments.set(name, { descriptor, signature: loaded.signature });
    for (const { record, location } of loaded.entries) store.packedIndex.set(record.id, location);
    return { staged: candidates.length, bytes: segment.bytes.length, removed: 0, generation: next.generation, segment: name,
      diskSpace: space, directorySync: { ...store.packDurability } };
  } catch (error) {
    // A preflight space refusal occurs before effects; the ordinary ledger
    // remains usable and does not inherit a false storage-corruption state.
    if (typeof error?.code === 'string' && (error.code.startsWith('DIRECT_JOB_SPACE_') ||
        error.code === 'DIRECT_JOB_INSUFFICIENT_SPACE')) throw error;
    throw storageFailure(store, error);
  }
}

/** Explicit second-phase deletion only after a separate restart completely
 * revalidates every published segment and duplicate loose receipt.
 */
export async function retirePackedCopies(store, validateRecord, { maxRecords = PACK_MAX_RECORDS, destination } = {}) {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > PACK_MAX_RECORDS)
    throw packError('Unsupported bounded terminal retirement limit.');
  // The actual deletion function—not merely a preferred public wrapper—must
  // reject every call that lacks an independent verified export destination.
  if (typeof destination !== 'string' || !path.isAbsolute(destination))
    throw packError('Direct-job duplicate retirement requires an independent verified export.');
  try {
    await store.assertLease(); await assertSameManifest(store);
    if (!store.packManifest) return { removed: 0, bytesReclaimed: 0, protectedByMarker: false };
    if (!store.packsValidatedOnStartup)
      throw packError('Duplicate retirement requires a separate completed validating startup.');
    const pending = [];
    for (const [id, location] of store.packedIndex) {
      if (!store.looseIds.has(id)) continue;
      const indexed = store.records.get(id);
      if (!indexed || indexed.receiptHash !== location.receiptHash) continue; // Higher-revision override, keep.
      pending.push({ id, location });
      if (pending.length >= maxRecords) break;
    }
    if (!pending.length) return { removed: 0, bytesReclaimed: 0, protectedByMarker: store.packMarkerPresent };
    const backed = await verifyRetirementBackupBatch(store, validateRecord, { destination, maxRecords });
    if (backed.verified !== pending.length || backed.checkedIds.length !== pending.length ||
        pending.some((item, index) => item.id !== backed.checkedIds[index]))
      throw packError('Verified backup candidates disagree with the exact planned retirement batch.');
    // Verify entire affected segment before ANY deletion, including other frames.
    const verified = new Set();
    for (const { location } of pending) {
      if (verified.has(location.name)) continue;
      const segment = store.packSegments.get(location.name);
      if (!segment) throw packError('Archived segment index is missing.');
      const fresh = await readPackSegment(store.io, store.directory, segment.descriptor, validateRecord);
      if (!packStatStable(fresh.signature, segment.signature))
        throw packError('Packed segment changed since validated startup.');
      verified.add(location.name);
    }
    await ensureDowngradeMarker(store);
    let removed = 0, bytesReclaimed = 0;
    for (const { id, location } of pending) {
      const value = store.records.get(id), file = store.file(id);
      if (!store.looseIds.has(id) || !value || value.receiptHash !== location.receiptHash)
        throw packError('Duplicate retirement target changed.');
      const packed = await readPackedEntry(store.io, store.directory, location,
        store.packSegments.get(location.name).signature, validateRecord);
      const loose = await readStableLoose(store.io, file, location.receiptHash, validateRecord);
      if (packed.id !== loose.record.id || packed.revision !== loose.record.revision ||
          packed.id !== id || packed.revision !== value.revision)
        throw packError('Retirement would remove a nonidentical or revised receipt.');
      await verifyRetirementBackupReceipt(store, validateRecord, {
        destination, expectedCanonical: backed.independentPath,
        exportId: backed.exportId, sourceFingerprint: backed.sourceFingerprint,
        id, revision: value.revision, receiptHash: location.receiptHash,
      });
      await store.assertLease();
      try { await store.io.unlink(file); }
      catch (error) {
        // A lost unlink acknowledgment can follow successful deletion.
        if (await packStatOf(store.io, file)) throw error;
      }
      if (await packStatOf(store.io, file)) throw packError('Duplicate receipt removal could not be verified.');
      store.looseIds.delete(id);
      removed++; bytesReclaimed += loose.bytes.length;
    }
    store.packDurability.retirement = await syncDirectoryEntry(store.io, store.directory);
    return { removed, bytesReclaimed, protectedByMarker: store.packMarkerPresent,
      directorySync: store.packDurability.retirement,
      verifiedBackup: { exportId: backed.exportId, checked: backed.verified,
        powerLossDurabilityProven: false } };
  } catch (error) {
    // Missing, stale or corrupted independent backup input is a safe refusal
    // if detected before any marker/link/unlink; source work remains usable.
    if (error?.backupOnly) throw error;
    // The marker capacity preflight has no effect and must not poison normal
    // ledger work with an invented storage-corruption state.
    if (typeof error?.code === 'string' && (error.code.startsWith('DIRECT_JOB_SPACE_') ||
        error.code === 'DIRECT_JOB_INSUFFICIENT_SPACE')) throw error;
    throw storageFailure(store, error);
  }
}
