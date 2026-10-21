import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/**
 * A request waits for a snapshot taken after that request. Requests made while
 * disk IO is in flight share one pending batch; they never retain serialized
 * copies of history. A later batch still runs after an earlier batch fails.
 */
export class CoalescingWriter {
  constructor(write) {
    this.write = write;
    this.pending = null;
    this.running = false;
  }
  request() {
    if (!this.pending) {
      const batch = {};
      batch.promise = new Promise((resolve, reject) => { batch.resolve = resolve; batch.reject = reject; });
      // The owner reports storage failures independently. An ignored background
      // request must not turn an already reported IO failure into a process crash.
      batch.promise.catch(() => {});
      this.pending = batch;
    }
    const promise = this.pending.promise;
    if (!this.running) {
      this.running = true;
      // Coalesce requests in the same turn before allocating the first snapshot.
      queueMicrotask(() => this.drain());
    }
    return promise;
  }
  async drain() {
    while (this.pending) {
      const batch = this.pending;
      this.pending = null;
      try { await this.write(); batch.resolve(); }
      catch (error) { batch.reject(error); }
    }
    this.running = false;
  }
}

const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_DELAYS = Object.freeze([20, 50, 100, 200, 400]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Retry Windows scanner/sharing locks without ever deleting the live file. */
export async function renameWithRetry(source, destination, { io = fs, wait = sleep, delays = RETRY_DELAYS } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { await io.rename(source, destination); return; }
    catch (error) {
      if (!TRANSIENT_RENAME_ERRORS.has(error.code) || attempt >= delays.length) throw error;
      await wait(delays[attempt]);
    }
  }
}

const signature = stat => `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
const digest = text => createHash('sha256').update(text).digest('hex');
const changed = name => Object.assign(new Error(`${name} changed while saving. Retry after the other writer finishes.`), { code: 'STORAGE_CHANGED' });

/**
 * Atomic JSON-array snapshots with the last valid file retained as a backup.
 * Only hashes/stat signatures are cached, never a second copy of saved history.
 * Once this writer has validated or installed a file, an unchanged signature
 * permits a native copy instead of rereading/parsing the whole archive again.
 */
export class AtomicJsonSnapshots {
  constructor(directory, { io = fs, wait = sleep, delays = RETRY_DELAYS } = {}) {
    this.directory = directory;
    this.io = io;
    this.renameOptions = { io, wait, delays };
    this.knownFiles = new Map();
  }
  async inspect(file) {
    try { return await this.io.stat(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async backupCurrent(destination, expected) {
    const io = this.io, temporary = `${destination}.bak.${randomUUID()}.tmp`;
    try {
      await io.copyFile(destination, temporary);
      const backup = await io.open(temporary, 'r+');
      let copied;
      try { await backup.sync(); copied = await backup.stat(); } finally { await backup.close(); }
      const afterCopy = await this.inspect(destination);
      // Never replace a known-good backup with bytes from a concurrently changed
      // source. Native copying avoids allocating the entire prior JSON archive.
      if (!afterCopy || signature(afterCopy) !== signature(expected) || copied.size !== expected.size) throw changed(path.basename(destination));
      await renameWithRetry(temporary, `${destination}.bak`, this.renameOptions);
      return signature(await io.stat(`${destination}.bak`));
    } finally { await io.unlink(temporary).catch(() => {}); }
  }
  async checkpoint(name) {
    const destination = path.join(this.directory, name), current = await this.inspect(destination), known = this.knownFiles.get(name);
    if (!current || known?.signature !== signature(current)) throw changed(name);
    if (known.backupHash === known.hash) {
      const backup = await this.inspect(`${destination}.bak`);
      if (backup && signature(backup) === known.backupSignature) return false;
    }
    const backupSignature = await this.backupCurrent(destination, current);
    this.knownFiles.set(name, { ...known, backupHash: known.hash, backupSignature });
    return true;
  }
  async write(name, text) {
    const io = this.io, destination = path.join(this.directory, name);
    const nextHash = digest(text), current = await this.inspect(destination);
    const known = this.knownFiles.get(name), currentSignature = current && signature(current);
    const currentKnown = current && known?.signature === currentSignature;
    let currentHash = currentKnown ? known.hash : undefined;
    if (currentKnown && known.hash === nextHash) return false;

    if (current && !currentKnown) {
      const previous = await io.readFile(destination, 'utf8');
      if (!Array.isArray(JSON.parse(previous))) throw new Error(`Invalid ${name} history file. The existing files have been preserved.`);
      const validatedHash = digest(previous); currentHash = validatedHash;
      const afterRead = await this.inspect(destination);
      // An external writer changed the source during validation. Preserve both
      // current/backup files and retry on the next explicit persistence request.
      if (!afterRead || signature(afterRead) !== currentSignature) {
        throw changed(name);
      }
      this.knownFiles.set(name, { signature: currentSignature, hash: validatedHash });
      if (validatedHash === nextHash) return false;
    }

    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      // Finish and flush the replacement first, so a failed write cannot rotate
      // the backup or damage the current saved state.
      const handle = await io.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      const backupSignature = current ? await this.backupCurrent(destination, current) : undefined;
      await renameWithRetry(temporary, destination, this.renameOptions);
      const installed = await io.stat(destination);
      this.knownFiles.set(name, { signature: signature(installed), hash: nextHash, backupHash: currentHash, backupSignature });
      return true;
    } finally {
      await io.unlink(temporary).catch(() => {});
    }
  }
}
