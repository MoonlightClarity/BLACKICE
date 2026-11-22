import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

const SCHEMA = 'blackice.local-model-profile-assets.v1';
const PREFIX = 'LOCAL_PROFILE_ASSET_';
const MAX_REDIRECTS = 5;
const error = (code, message, status = 400, extra = {}) => Object.assign(new Error(message), {code:PREFIX + code, status, ...extra});
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const identifier = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value);
const ready = item => item.status === 'reused' || item.status === 'published';
const cancelled = () => error('CANCELLED', 'Profile asset preparation was cancelled.', 499);
const checkAbort = signal => { if (signal?.aborted) throw cancelled(); };
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

function httpsUrl(value, base) {
  if (typeof value !== 'string' || !value || value.length > 16384) throw error('URL', 'Use a valid HTTPS asset URL.');
  let url;
  try { url = base ? new URL(value, base) : new URL(value); } catch { throw error('URL', 'Use a valid HTTPS asset URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw error('URL', 'Asset URLs and redirects must use HTTPS without credentials.');
  return url.href;
}

function validateAsset(asset) {
  if (!exactKeys(asset, ['id', 'fileName', 'url', 'sizeBytes', 'sha256']) || !identifier(asset.id) ||
    typeof asset.fileName !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,179}$/i.test(asset.fileName) || asset.fileName.endsWith('.') ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(asset.fileName) ||
    !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0 || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(asset.sha256))
    throw error('MANIFEST', 'Assets require unique IDs, portable filenames, positive sizes, and SHA-256 identities.');
  return {id:asset.id, fileName:asset.fileName, url:httpsUrl(asset.url), sizeBytes:asset.sizeBytes, sha256:asset.sha256.toLowerCase()};
}

function validate(manifest, modelsDirectory, fetchImpl) {
  if (!exactKeys(manifest, ['profileId', 'version', 'assets']) || !identifier(manifest.profileId) || !identifier(manifest.version) || !Array.isArray(manifest.assets) || !manifest.assets.length)
    throw error('MANIFEST', 'Supply a pinned profile ID, version, and nonempty asset list.');
  if (typeof modelsDirectory !== 'string' || !path.isAbsolute(modelsDirectory) || modelsDirectory.includes('\0'))
    throw error('DESTINATION', 'Supply an absolute models directory.');
  if (typeof fetchImpl !== 'function') throw error('TRANSPORT', 'An HTTPS asset transport is required.');
  const ids = new Set(), names = new Set();
  const assets = manifest.assets.map(value => {
    const asset = validateAsset(value);
    const idKey = asset.id.toLowerCase(), nameKey = asset.fileName.toLowerCase();
    if (ids.has(idKey) || names.has(nameKey)) throw error('MANIFEST', 'Asset IDs and filenames must be unique on every supported platform.');
    ids.add(idKey); names.add(nameKey);
    return asset;
  });
  return {profileId:manifest.profileId, version:manifest.version, assets, modelsDirectory:path.resolve(modelsDirectory)};
}

async function ensureDirectory(directory) {
  let info;
  try { info = await fs.lstat(directory); }
  catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
    await fs.mkdir(directory, {recursive:true});
    info = await fs.lstat(directory);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw error('DESTINATION', 'The models destination must be a real directory.');
}

// This is a point-in-time file observation, not a cross-process lock or CAS.
async function verifyFile(filename, expected, signal, {allowMissing = false, existing = false} = {}) {
  checkAbort(signal);
  let info;
  try { info = await fs.lstat(filename); }
  catch (cause) { if (allowMissing && cause.code === 'ENOENT') return null; throw cause; }
  const code = existing ? 'CONFLICT' : 'INTEGRITY';
  if (!info.isFile() || info.isSymbolicLink()) throw error(code, 'The asset target is not a regular file.', 409);
  if (info.size !== expected.sizeBytes) throw error(code, 'The asset file size does not match its pinned identity.', 409,
    {observed:{sizeBytes:info.size, sha256:null}});
  const handle = await fs.open(filename, 'r');
  let bytes = 0;
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(info, opened)) throw error(code, 'The asset changed while it was being inspected.', 409);
    for (;;) {
      checkAbort(signal);
      const {bytesRead} = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > expected.sizeBytes) throw error(code, 'The asset grew during verification.', 409);
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat(), linked = await fs.lstat(filename);
    if (!linked.isFile() || linked.isSymbolicLink() || !sameFile(opened, linked) ||
      after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs)
      throw error(code, 'The asset changed during verification.', 409);
  } finally { await handle.close(); }
  checkAbort(signal);
  const observed = {sizeBytes:bytes, sha256:hash.digest('hex')};
  if (bytes !== expected.sizeBytes || observed.sha256 !== expected.sha256)
    throw error(code, 'The asset bytes do not match their pinned identity.', 409, {observed});
  return observed;
}

/** Read-only verification of a configured file, including a renamed external file.
 * The pinned identity is shared with preparation; the configured path is never moved.
 */
export async function verifyLocalModelProfileAssetFile({asset, filePath, signal} = {}) {
  const verification = {id:null, path:null, status:'failed', expected:null, observed:null};
  try {
    const pinned = validateAsset(asset);
    verification.id = pinned.id;
    verification.expected = {sizeBytes:pinned.sizeBytes, sha256:pinned.sha256};
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0'))
      throw error('DESTINATION', 'Supply an absolute configured asset file path.');
    verification.path = path.resolve(filePath);
    verification.observed = await verifyFile(verification.path, pinned, signal, {existing:true});
    verification.status = 'verified';
    return verification;
  } catch (cause) {
    const failure = typeof cause?.code === 'string' && cause.code.startsWith(PREFIX) ? cause : signal?.aborted ? cancelled()
      : cause?.code === 'ENOENT' ? error('NOT_FOUND', 'The configured asset file is missing.', 404)
        : error('FILESYSTEM', 'The configured asset file could not be verified.', 500, {filesystemCode:typeof cause?.code === 'string' ? cause.code : null});
    verification.status = failure.code === PREFIX + 'CANCELLED' ? 'cancelled' : 'failed';
    verification.observed = failure.observed || null;
    failure.verification = verification;
    throw failure;
  }
}

async function discard(body) {
  try { await body?.cancel?.(); } catch { /* Preserve the primary protocol failure. */ }
}

async function responseBody(asset, fetchImpl, signal) {
  let url = asset.url;
  for (let redirects = 0; ; redirects++) {
    checkAbort(signal);
    let response;
    try { response = await fetchImpl(url, {redirect:'manual', signal, headers:{accept:'application/octet-stream'}}); }
    catch { checkAbort(signal); throw error('NETWORK', 'The asset request could not be completed.', 502); }
    if (signal?.aborted) { await discard(response?.body); throw cancelled(); }
    if ([301, 302, 303, 307, 308].includes(response?.status)) {
      const location = response.headers?.get?.('location');
      await discard(response.body);
      if (redirects >= MAX_REDIRECTS) throw error('REDIRECT', 'The asset exceeded the supported redirect limit.', 502);
      if (typeof location !== 'string' || !location) throw error('REDIRECT', 'The asset redirect did not supply a destination.', 502);
      url = httpsUrl(location, url);
      continue;
    }
    if (response?.status !== 200) { await discard(response?.body); throw error('HTTP', 'The asset server did not return a complete download.', 502); }
    if (typeof response.body?.getReader !== 'function') { await discard(response.body); throw error('STREAM', 'The asset transport did not supply a readable byte stream.', 502); }
    return response.body;
  }
}

async function writeBody(body, handle, asset, item, signal) {
  const reader = body.getReader(), hash = createHash('sha256');
  let complete = false, cancelPromise;
  const cancelReader = () => cancelPromise ||= Promise.resolve().then(() => reader.cancel()).catch(() => {});
  const onAbort = () => { void cancelReader(); };
  signal?.addEventListener?.('abort', onAbort, {once:true});
  try {
    for (;;) {
      checkAbort(signal);
      let chunk;
      try { chunk = await reader.read(); } catch { checkAbort(signal); throw error('STREAM', 'The asset stream ended with an error.', 502); }
      checkAbort(signal);
      if (chunk.done) { complete = true; break; }
      if (!(chunk.value instanceof Uint8Array)) throw error('STREAM', 'The asset stream contained a non-byte chunk.', 502);
      item.receivedBytes += chunk.value.byteLength;
      if (item.receivedBytes > asset.sizeBytes) throw error('SIZE', 'The download exceeded its pinned byte size.', 502);
      let offset = 0;
      while (offset < chunk.value.byteLength) {
        checkAbort(signal);
        const {bytesWritten} = await handle.write(chunk.value.subarray(offset));
        if (!bytesWritten) throw error('FILESYSTEM', 'The asset temporary file could not be written.', 500);
        offset += bytesWritten;
      }
      hash.update(chunk.value);
    }
    const observed = {sizeBytes:item.receivedBytes, sha256:hash.digest('hex')};
    if (observed.sizeBytes !== asset.sizeBytes) throw error('SIZE', 'The download ended before its pinned byte size.', 502, {observed});
    if (observed.sha256 !== asset.sha256) throw error('INTEGRITY', 'The downloaded bytes do not match their pinned SHA-256.', 502, {observed});
    return observed;
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
    if (!complete || cancelPromise) await cancelReader();
    reader.releaseLock();
  }
}

/** Explicit preparation only. The trusted profile module owns the manifest.
 * Each file is published exclusively; this is not a multi-file/store transaction.
 */
export async function prepareLocalModelProfileAssets({manifest, modelsDirectory, signal, fetchImpl = globalThis.fetch} = {}) {
  const receipt = {schema:SCHEMA, profileId:null, version:null, status:'preparing', modelsDirectory:null, stage:'validate', assets:[]};
  const temporary = new Map();
  let current = null, failure;
  async function removeTemporary(filename) {
    const identity = temporary.get(filename);
    let info;
    try { info = await fs.lstat(filename); }
    catch (cause) { if (cause.code === 'ENOENT') { temporary.delete(filename); return; } throw cause; }
    if (!identity || !info.isFile() || info.isSymbolicLink() || !sameFile(identity, info))
      throw error('CLEANUP', 'A temporary path changed ownership; it was left untouched.', 500);
    await fs.unlink(filename);
    temporary.delete(filename);
  }
  try {
    const pinned = validate(manifest, modelsDirectory, fetchImpl);
    receipt.profileId = pinned.profileId; receipt.version = pinned.version; receipt.modelsDirectory = pinned.modelsDirectory;
    receipt.assets = pinned.assets.map(asset => ({id:asset.id, path:path.join(pinned.modelsDirectory, asset.fileName), status:'not-started', stage:'inspect',
      expected:{sizeBytes:asset.sizeBytes, sha256:asset.sha256}, observed:null, receivedBytes:0}));
    checkAbort(signal);
    receipt.stage = 'destination';
    await ensureDirectory(pinned.modelsDirectory);
    // Inspect every existing target before initiating any download.
    receipt.stage = 'inspect';
    for (let index = 0; index < pinned.assets.length; index++) {
      current = receipt.assets[index];
      const observed = await verifyFile(current.path, pinned.assets[index], signal, {allowMissing:true, existing:true});
      if (observed) Object.assign(current, {status:'reused', stage:'ready', observed});
    }
    for (let index = 0; index < pinned.assets.length; index++) {
      current = receipt.assets[index];
      if (ready(current)) continue;
      const asset = pinned.assets[index];
      checkAbort(signal);
      const existing = await verifyFile(current.path, asset, signal, {allowMissing:true, existing:true});
      if (existing) { Object.assign(current, {status:'reused', stage:'ready', observed:existing}); continue; }
      current.status = 'preparing'; current.stage = receipt.stage = 'download';
      const filename = path.join(pinned.modelsDirectory, '.blackice-profile-' + randomUUID() + '.part');
      const handle = await fs.open(filename, 'wx');
      temporary.set(filename, null);
      try {
        temporary.set(filename, await handle.stat());
        const body = await responseBody(asset, fetchImpl, signal);
        await writeBody(body, handle, asset, current, signal);
        await handle.sync();
      } finally { await handle.close(); }
      current.stage = receipt.stage = 'verify-temporary';
      const observed = await verifyFile(filename, asset, signal);
      checkAbort(signal);
      current.stage = receipt.stage = 'publish';
      try {
        await fs.link(filename, current.path);
        Object.assign(current, {status:'published', stage:'ready', observed});
      } catch (cause) {
        if (cause.code !== 'EEXIST') throw error('PUBLISH', 'Exclusive asset publication is unavailable; the target was not replaced.', 500, {filesystemCode:cause.code || null});
        const concurrent = await verifyFile(current.path, asset, signal, {existing:true});
        Object.assign(current, {status:'reused', stage:'ready', observed:concurrent});
      }
      receipt.stage = 'cleanup';
      await removeTemporary(filename);
    }
    checkAbort(signal);
    receipt.stage = 'ready'; receipt.status = 'ready';
  } catch (cause) {
    failure = cause?.code?.startsWith(PREFIX) ? cause : signal?.aborted ? cancelled()
      : error('FILESYSTEM', 'The asset filesystem operation could not be completed.', 500, {filesystemCode:typeof cause?.code === 'string' ? cause.code : null});
    receipt.status = failure.code === PREFIX + 'CANCELLED' ? 'cancelled' : 'failed';
    if (current && !ready(current)) {
      current.status = receipt.status;
      if (failure.observed) current.observed = failure.observed;
    }
    receipt.error = {code:failure.code, stage:receipt.stage, assetId:current?.id || null};
    if (failure.filesystemCode) receipt.error.filesystemCode = failure.filesystemCode;
  } finally {
    const cleanupErrors = [];
    for (const filename of temporary.keys()) {
      try { await removeTemporary(filename); }
      catch (cause) { cleanupErrors.push({path:filename, code:cause?.code?.startsWith(PREFIX) ? cause.code : PREFIX + 'CLEANUP'}); }
    }
    if (cleanupErrors.length) {
      receipt.cleanup = {temporaryFilesRemaining:[...temporary.keys()], errors:cleanupErrors};
      if (!failure) {
        failure = error('CLEANUP', 'An owned temporary file could not be removed.', 500);
        receipt.status = 'failed'; receipt.error = {code:failure.code, stage:'cleanup', assetId:current?.id || null};
      }
    }
  }
  if (failure) { failure.receipt = receipt; throw failure; }
  return receipt;
}
