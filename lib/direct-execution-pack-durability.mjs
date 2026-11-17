// Explicit capacity and best-effort directory-entry durability for terminal
// archive maintenance. No heuristic about antivirus, physical media, or caches.
const MIN_RESERVE = 64 * 1024 * 1024;
const SPACE_OVERHEAD = 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code, status: 507 });

export async function requireDiskSpace(io, directory, bytesToAllocate, {
  reserveBytes = MIN_RESERVE, overheadBytes = SPACE_OVERHEAD,
} = {}) {
  if (!Number.isSafeInteger(bytesToAllocate) || bytesToAllocate < 0 ||
      !Number.isSafeInteger(reserveBytes) || reserveBytes < MIN_RESERVE ||
      !Number.isSafeInteger(overheadBytes) || overheadBytes < SPACE_OVERHEAD)
    throw fail('DIRECT_JOB_SPACE_INVALID', 'Choose an explicit, safe migration capacity budget.');
  let state;
  try { state = await io.statfs(directory, { bigint: true }); }
  catch { throw fail('DIRECT_JOB_SPACE_UNKNOWN', 'Filesystem capacity cannot be verified for migration.'); }
  if (!state || typeof state.bsize !== 'bigint' || typeof state.bavail !== 'bigint' ||
      state.bsize <= 0n || state.bavail < 0n)
    throw fail('DIRECT_JOB_SPACE_UNKNOWN', 'Filesystem capacity data is unavailable.');
  const available = state.bsize * state.bavail;
  const rounded = ((BigInt(bytesToAllocate) + state.bsize - 1n) / state.bsize) * state.bsize;
  const needed = rounded + BigInt(overheadBytes) + BigInt(reserveBytes);
  if (available < needed) {
    const error = fail('DIRECT_JOB_INSUFFICIENT_SPACE', 'Insufficient verified free space for bounded migration.');
    error.requiredBytes = needed.toString();
    error.availableBytes = available.toString();
    throw error;
  }
  return { source: 'filesystem-statfs', filesystemBlockBytes: state.bsize.toString(),
    availableBytes: available.toString(), requiredBytes: needed.toString(),
    reservedBytes: reserveBytes, requestedPayloadBytes: bytesToAllocate };
}

// File handles are synced individually before publication. POSIX-style
// directory sync is attempted for link/rename/unlink durability. Windows Node
// may return EPERM for directories: the caller MUST report "unproven", not
// pretend that file sync implies directory-entry power-loss durability.
const DIRECTORY_UNAVAILABLE = new Set(['EPERM', 'EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'ENOSYS']);
export async function syncDirectoryEntry(io, directory) {
  let handle;
  try {
    handle = await io.open(directory, 'r');
    await handle.sync();
    return { state: 'synced', powerLossProven: false };
  } catch (error) {
    if (DIRECTORY_UNAVAILABLE.has(error?.code))
      return { state: 'unsupported', code: error.code, powerLossProven: false };
    throw error;
  } finally { await handle?.close().catch(() => {}); }
}
