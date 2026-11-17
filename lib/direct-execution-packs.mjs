import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Immutable terminal pack format: magic + repeated (uint32 little-endian length,
// original JSON UTF-8 bytes). Never stores trusted metadata in place of receipts.
export const PACK_MAGIC = Buffer.from('BIDJPK01');
export const PACK_MAX_BYTES = 16 * 1024 * 1024;
export const PACK_MAX_RECORDS = 256;
export const PACK_MAX_SEGMENTS = 4096;
export const PACK_MANIFEST = 'terminal-packs-v1.json';
export const PACK_MARKER = 'direct_' + '0'.repeat(64) + '.json';
export const PACK_MARKER_CONTENT = 'BLACKICE_TERMINAL_PACKS_V1_REQUIRED\n';
const sha = value => createHash('sha256').update(value).digest('hex');
const segmentName = value => typeof value === 'string' && /^terminal-pack-[a-f0-9]{32}\.bin$/.test(value);
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const reject = message => Object.assign(new Error(message), { code: 'DIRECT_JOB_STORAGE', status: 503 });
const stable = (a, b) => ['dev','ino','mode','size','mtimeMs','ctimeMs'].every(key => a[key] === b[key]);
const ordinary = stat => stat?.isFile() === true && stat.isSymbolicLink() === false;
const missing = error => error?.code === 'ENOENT';
// Bound allocations to a verified lstat size, rather than io.readFile() which
// can allocate unbounded bytes if a file is enlarged between stat and read.
export async function readBoundedFile(io, file, before, trace = null) {
  if (!ordinary(before) || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > PACK_MAX_BYTES)
    throw reject('Unsafe bounded archive read.');
  const measured = (kind, operation, bytesOfResult) => trace
    ? trace.operation(kind, operation, bytesOfResult) : operation();
  let handle;
  try {
    handle = await measured('pack-open', () => io.open(file, 'r'));
    return await measured('pack-read', async () => {
      const opened = await handle.stat();
      if (!stable(before, opened)) throw reject('Archived file changed while opening.');
      const bytes = Buffer.allocUnsafe(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw reject('Archived file was truncated.');
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (!stable(before, after)) throw reject('Archived file changed while reading.');
      return bytes;
    }, bytes => bytes.byteLength);
  } finally {
    if (handle) await measured('pack-close', () => handle.close());
  }
}
const statOf = async (io, file) => {
  try { return await io.lstat(file); } catch (error) { if (missing(error)) return null; throw error; }
};
export const packManifestPath = directory => path.join(directory, PACK_MANIFEST);
export const packMarkerPath = directory => path.join(directory, PACK_MARKER);
export const packSegmentPath = (directory, name) => {
  if (!segmentName(name)) throw reject('Unrecognized terminal pack filename.');
  return path.join(directory, name);
};
export const packName = () => 'terminal-pack-' + randomUUID().replaceAll('-', '') + '.bin';

export function validatePackManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
      !Number.isSafeInteger(value.generation) || value.generation < 1 ||
      !Array.isArray(value.segments) || !value.segments.length || value.segments.length > PACK_MAX_SEGMENTS)
    throw reject('Terminal pack manifest is invalid.');
  const seen = new Set();
  for (const item of value.segments) {
    if (!item || typeof item !== 'object' || !segmentName(item.name) ||
        !isHash(item.sha256) || !Number.isSafeInteger(item.bytes) ||
        item.bytes < PACK_MAGIC.length + 5 || item.bytes > PACK_MAX_BYTES ||
        !Number.isSafeInteger(item.count) || item.count < 1 || item.count > PACK_MAX_RECORDS ||
        seen.has(item.name)) throw reject('Terminal pack manifest has an unsafe segment.');
    seen.add(item.name);
  }
  return value;
}

export async function readPackManifest(io, directory) {
  const file = packManifestPath(directory), marker = packMarkerPath(directory);
  const markerStat = await statOf(io, marker), stat = await statOf(io, file);
  if (markerStat && (!ordinary(markerStat) || markerStat.size !== Buffer.byteLength(PACK_MARKER_CONTENT)))
    throw reject('Terminal archive rollback marker is invalid.');
  if (markerStat && await io.readFile(marker, 'utf8') !== PACK_MARKER_CONTENT)
    throw reject('Terminal archive rollback marker was altered.');
  if (!stat) {
    if (markerStat) throw reject('Terminal archive manifest disappeared while its rollback marker remains.');
    return { manifest: null, manifestSha256: null, markerPresent: false };
  }
  if (!ordinary(stat) || stat.size > 2 * 1024 * 1024) throw reject('Terminal pack manifest is unsafe.');
  const bytes = await readBoundedFile(io, file, stat), after = await io.lstat(file);
  if (!stable(stat, after) || bytes.byteLength !== stat.size) throw reject('Terminal pack manifest changed while reading.');
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { throw reject('Terminal pack manifest cannot be decoded.'); }
  return { manifest: validatePackManifest(parsed), manifestSha256: sha(bytes), markerPresent: Boolean(markerStat) };
}

export function encodePackSegment(raws) {
  if (!Array.isArray(raws) || raws.length < 1 || raws.length > PACK_MAX_RECORDS ||
      raws.some(raw => !Buffer.isBuffer(raw) || !raw.length || raw.length > 8 * 1024 * 1024))
    throw reject('Unsupported terminal pack payload batch.');
  const bytes = PACK_MAGIC.length + raws.reduce((size, raw) => size + 4 + raw.byteLength, 0);
  if (bytes > PACK_MAX_BYTES) throw reject('Terminal pack byte budget exceeded.');
  const out = Buffer.allocUnsafe(bytes), entries = [];
  PACK_MAGIC.copy(out);
  let offset = PACK_MAGIC.length;
  for (const raw of raws) {
    out.writeUInt32LE(raw.byteLength, offset); offset += 4;
    raw.copy(out, offset);
    entries.push({ offset, length: raw.byteLength, receiptHash: sha(raw) });
    offset += raw.byteLength;
  }
  return { bytes: out, entries, sha256: sha(out) };
}

export async function readPackSegment(io, directory, descriptor, validateRecord, trace = null) {
  const file = packSegmentPath(directory, descriptor.name);
  let before;
  try { before = trace ? await trace.operation('pack-stat', () => io.lstat(file)) : await io.lstat(file); }
  catch { throw reject('Published terminal pack is missing or unavailable.'); }
  if (!ordinary(before) || before.size !== descriptor.bytes || before.size > PACK_MAX_BYTES)
    throw reject('Published terminal pack is missing, unsafe or the wrong size.');
  let raw, after;
  try {
    raw = await readBoundedFile(io, file, before, trace);
    after = trace ? await trace.operation('pack-stat', () => io.lstat(file)) : await io.lstat(file);
  } catch { throw reject('Published terminal pack could not be read safely.'); }
  const validate = () => {
  if (!stable(before, after) || raw.byteLength !== descriptor.bytes || sha(raw) !== descriptor.sha256 ||
      !raw.subarray(0, PACK_MAGIC.length).equals(PACK_MAGIC))
    throw reject('Published terminal pack failed byte validation.');
  let offset = PACK_MAGIC.length;
  const entries = [], seen = new Set();
  while (offset < raw.byteLength) {
    if (entries.length >= PACK_MAX_RECORDS || offset + 4 > raw.length) throw reject('Terminal pack frame is truncated.');
    const size = raw.readUInt32LE(offset); offset += 4;
    if (!size || size > 8 * 1024 * 1024 || offset + size > raw.length)
      throw reject('Terminal pack frame exceeds its declared bounds.');
    const body = raw.subarray(offset, offset + size), location = { name: descriptor.name, offset, length: size, receiptHash: sha(body) };
    let record;
    try { record = JSON.parse(body.toString('utf8')); record = validateRecord(record, record?.id); }
    catch { throw reject('Terminal pack contains an invalid direct-job receipt.'); }
    if (seen.has(record.id) || !['succeeded','failed','cancelled','interrupted'].includes(record.status))
      throw reject('Terminal pack has duplicate or unfinished receipts.');
    seen.add(record.id);
    entries.push({ record, location }); offset += size;
  }
  if (offset !== raw.length || entries.length !== descriptor.count)
    throw reject('Terminal pack frame count or extent is invalid.');
  // Caller retains only metadata + offset; the segment buffer is not retained.
  return { entries, signature: before };
  };
  return trace ? trace.synchronous('pack-validate', validate) : validate();
}

export async function readPackedEntryExact(io, directory, location, signature, validateRecord) {
  const file = packSegmentPath(directory, location.name);
  const before = await io.lstat(file);
  if (!ordinary(before) || !stable(before, signature) ||
      !Number.isSafeInteger(location.offset) || location.offset < PACK_MAGIC.length + 4 ||
      !Number.isSafeInteger(location.length) || location.length < 1 ||
      location.offset + location.length > before.size)
    throw reject('Archived receipt changed after startup validation.');
  let handle;
  try {
    handle = await io.open(file, 'r');
    const opened = await handle.stat();
    if (!stable(opened, before)) throw reject('Terminal pack changed while opening.');
    const bytes = Buffer.allocUnsafe(location.length); let read = 0;
    while (read < bytes.length) {
      const part = await handle.read(bytes, read, bytes.length - read, location.offset + read);
      if (!part.bytesRead) throw reject('Archived receipt was truncated.');
      read += part.bytesRead;
    }
    const after = await handle.stat();
    if (!stable(after, before) || sha(bytes) !== location.receiptHash)
      throw reject('Archived receipt failed post-startup integrity verification.');
    let record;
    try { record = JSON.parse(bytes.toString('utf8')); record = validateRecord(record, record?.id); }
    catch { throw reject('Archived receipt failed post-startup schema validation.'); }
    return { record, bytes, receiptHash: sha(bytes) };
  } finally { await handle?.close(); }
}
export async function readPackedEntry(io, directory, location, signature, validateRecord) {
  return (await readPackedEntryExact(io, directory, location, signature, validateRecord)).record;
}

export async function readStableLoose(io, file, expectedHash, validateRecord) {
  const before = await io.lstat(file);
  if (!ordinary(before) || before.size > 8 * 1024 * 1024)
    throw reject('Loose terminal receipt is unsafe.');
  const bytes = await readBoundedFile(io, file, before), after = await io.lstat(file);
  if (!stable(before, after) || bytes.byteLength !== before.size || expectedHash && sha(bytes) !== expectedHash)
    throw reject('Loose terminal receipt changed after validation.');
  let record;
  try { record = JSON.parse(bytes.toString('utf8')); record = validateRecord(record, record?.id); }
  catch { throw reject('Loose terminal receipt cannot be validated.'); }
  return { bytes, record, receiptHash: sha(bytes) };
}

export async function writeNewPackFile(io, file, bytes) {
  let handle;
  try {
    handle = await io.open(file, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle?.close(); }
}

export const packDigest = sha;
export const packStatOf = statOf;
export const packStatStable = stable;
export const packError = reject;
