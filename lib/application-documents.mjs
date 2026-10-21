import {promises as fs, constants} from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const DOCUMENT_ID = new RegExp(`^doc_${UUID}$`);
const DOCUMENT_FILE = new RegExp(`^(doc_${UUID})\\.json$`);
const MAX_CHARACTERS = 10000;
const MAX_FILE_BYTES = 80 * 1024;
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 400, code = 'APPLICATION_DOCUMENTS') => Object.assign(new Error(message), {status, code});
const digest = value => createHash('sha256').update(value).digest('hex');
const fields = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;

function label(value, name, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value) || !value.isWellFormed()) {
    throw fail(`${name} must be nonempty text of at most ${limit} characters without control characters.`);
  }
  return value.trim();
}

function sourceMetadata(value) {
  if (!fields(value, ['sessionId', 'appId', 'applicationName'])) throw fail('Document source must identify its application session.');
  return {
    sessionId: label(value.sessionId, 'Source session', 160),
    appId: label(value.appId, 'Source application ID', 80),
    applicationName: label(value.applicationName, 'Source application name', 100),
  };
}

function documentText(value) {
  if (typeof value !== 'string' || value.length > MAX_CHARACTERS || value.includes('\0') || !value.isWellFormed()) {
    throw fail(`Document text must contain at most ${MAX_CHARACTERS} characters, with no NUL or unpaired Unicode surrogates.`);
  }
  return value;
}

function publicMetadata(value) {
  return {id: value.id, title: value.title, source: clone(value.source), createdAt: value.createdAt, sha256: value.sha256, bytes: value.bytes, characters: value.characters};
}

function validateStored(value, expectedId) {
  if (!fields(value, ['version', 'id', 'title', 'source', 'createdAt', 'sha256', 'bytes', 'characters', 'text']) || value.version !== 1 || value.id !== expectedId || !DOCUMENT_ID.test(value.id)) throw Error('Invalid snapshot identity.');
  const title = label(value.title, 'Document title', 160);
  const source = sourceMetadata(value.source);
  if (title !== value.title || JSON.stringify(source) !== JSON.stringify(value.source)) throw Error('Invalid snapshot metadata.');
  const text = documentText(value.text);
  const bytes = Buffer.from(text, 'utf8');
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) throw Error('Invalid snapshot date.');
  if (!/^[a-f0-9]{64}$/.test(value.sha256) || value.sha256 !== digest(bytes) || value.bytes !== bytes.length || value.characters !== text.length) throw Error('Snapshot content does not match its receipt.');
  return {...publicMetadata(value), text};
}

/** Immutable local text snapshots. App processes and working files are never reopened here. */
export class ApplicationDocumentStore {
  constructor({dataDir, maxDocuments = 100} = {}) {
    if (typeof dataDir !== 'string' || !dataDir) throw fail('A document data directory is required.');
    if (!Number.isInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > 1000) throw fail('Document capacity must be an integer from 1 to 1000.');
    this.dataDir = path.resolve(dataDir);
    this.directory = path.join(this.dataDir, 'application-documents');
    this.maxDocuments = maxDocuments;
    this.documents = new Map();
    this.errors = new Set();
    this.tail = Promise.resolve();
    this.initialized = false;
    this.closed = false;
  }

  async init() {
    if (this.initialized) return this;
    this.initialized = true;
    try {
      await fs.mkdir(this.dataDir, {recursive: true});
      const parent = await fs.lstat(this.dataDir);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error('Unsafe data directory.');
      this.parentRealPath = await fs.realpath(this.dataDir);
      await fs.mkdir(this.directory, {recursive: false}).catch(error => {if (error.code !== 'EEXIST') throw error;});
      await this.verifyDirectory();
      const entries = await fs.readdir(this.directory, {withFileTypes: true});
      if (entries.length > 10000) throw Error('Too many document directory entries.');
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const match = DOCUMENT_FILE.exec(entry.name);
        if (!match || !entry.isFile() || entry.isSymbolicLink()) {
          this.markError('An unexpected or unsafe document entry was preserved.');
          continue;
        }
        try {
          const document = await this.load(match[1]);
          this.documents.set(document.id, publicMetadata(document));
        } catch {
          this.markError(`Document ${match[1]} could not be verified. Its file was preserved.`);
        }
      }
    } catch {
      this.markError('The document storage directory could not be safely opened. Existing files were preserved.');
    }
    return this;
  }

  markError(message) { this.errors.add(message); }

  status() {
    return {healthy: this.initialized && this.errors.size === 0, error: this.errors.size ? [...this.errors].slice(0, 5).join(' ') : null, count: this.documents.size, maxDocuments: this.maxDocuments};
  }

  list() {
    return [...this.documents.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).map(publicMetadata);
  }

  enqueue(operation) {
    if (this.closed) return Promise.reject(fail('The document store is closed.', 409));
    const pending = this.tail.then(() => {
      if (!this.initialized) throw fail('Initialize the document store first.', 409);
      return operation();
    });
    this.tail = pending.catch(() => {});
    return pending;
  }

  async verifyDirectory() {
    const parent = await fs.lstat(this.dataDir);
    const directory = await fs.lstat(this.directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || !directory.isDirectory() || directory.isSymbolicLink()) throw Error('Unsafe document directory.');
    if (await fs.realpath(this.dataDir) !== this.parentRealPath || await fs.realpath(this.directory) !== path.join(this.parentRealPath, 'application-documents')) throw Error('The document directory moved.');
    return directory;
  }

  filename(id) {
    if (typeof id !== 'string' || !DOCUMENT_ID.test(id)) throw fail('Invalid document ID.');
    return path.join(this.directory, `${id}.json`);
  }

  async load(id) {
    await this.verifyDirectory();
    const filename = this.filename(id);
    const before = await fs.lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_FILE_BYTES) throw Error('Unsafe or oversized document file.');
    let handle;
    try {
      handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened)) throw Error('Document file changed while opening.');
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const {bytesRead} = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (offset > MAX_FILE_BYTES || offset !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || after.nlink !== 1) throw Error('Document file changed or exceeded its size bound.');
      const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(buffer.subarray(0, offset)));
      return validateStored(value, id);
    } finally {
      await handle?.close();
    }
  }

  async readVerified(id) {
    const expected = this.documents.get(id);
    if (!expected) throw fail('Document not found.', 404);
    try {
      const document = await this.load(id);
      if (JSON.stringify(publicMetadata(document)) !== JSON.stringify(expected)) throw Error('Immutable document receipt changed.');
      return document;
    } catch {
      this.markError(`Document ${id} could not be verified. Its file was preserved.`);
      this.documents.delete(id);
      throw fail('This document could not be verified. Its file was preserved; other intact documents remain readable.', 500, 'APPLICATION_DOCUMENT_CORRUPT');
    }
  }

  read(id) {
    return this.enqueue(() => {this.filename(id); return this.readVerified(id);});
  }

  save(value) {
    return this.enqueue(async () => {
      if (!fields(value, ['title', 'source', 'text'])) throw fail('Save a title, source and text only.');
      const title = label(value.title, 'Document title', 160);
      const source = sourceMetadata(value.source);
      const text = documentText(value.text);
      const bytes = Buffer.from(text, 'utf8');
      const sha256 = digest(bytes);
      const duplicate = [...this.documents.values()].find(item => item.source.sessionId === source.sessionId && item.sha256 === sha256);
      if (duplicate) return publicMetadata(await this.readVerified(duplicate.id));
      if (this.errors.size) throw fail('Document storage needs attention. Existing files were preserved; new snapshots are paused.', 503, 'APPLICATION_DOCUMENT_STORAGE');
      if (this.documents.size >= this.maxDocuments) throw fail('Document snapshot capacity was reached. Existing snapshots are preserved.', 507, 'APPLICATION_DOCUMENT_CAPACITY');
      const document = {version: 1, id: `doc_${randomUUID()}`, title, source, createdAt: new Date().toISOString(), sha256, bytes: bytes.length, characters: text.length, text};
      const encoded = Buffer.from(JSON.stringify(document), 'utf8');
      if (encoded.length > MAX_FILE_BYTES) throw fail('Document snapshot exceeded its storage bound.', 413);
      const filename = this.filename(document.id);
      const temporary = path.join(this.directory, `.${document.id}.${randomUUID()}.pending`);
      let handle;
      let published = false;
      try {
        await this.verifyDirectory();
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(encoded);
        await handle.sync();
        await handle.close();
        handle = null;
        await this.verifyDirectory();
        // Linking the complete, synced file publishes it atomically and refuses every existing destination.
        await fs.link(temporary, filename);
        published = true;
        await fs.unlink(temporary);
        await this.syncDirectory();
        const receipt = publicMetadata(await this.load(document.id));
        this.documents.set(document.id, receipt);
        return publicMetadata(receipt);
      } catch {
        this.markError(published ? `Document ${document.id} was published but could not be fully verified. Its file was preserved; inspect storage before repeating this save.` : 'A document snapshot could not be saved. Existing files were preserved.');
        throw fail(published ? `The snapshot outcome needs inspection. Document ID: ${document.id}. Do not repeat the save automatically.` : 'The document snapshot could not be saved. Existing files were preserved.', 500, 'APPLICATION_DOCUMENT_STORAGE');
      } finally {
        await handle?.close().catch(() => {});
        // This unpredictable, exclusively created name belongs only to this write, never to a snapshot.
        await fs.unlink(temporary).catch(() => {});
      }
    });
  }

  async syncDirectory() {
    let handle;
    try {
      handle = await fs.open(this.directory, constants.O_RDONLY);
      await handle.sync();
    } catch (error) {
      // Windows does not expose directory fsync through Node. The file itself was synced before publication.
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'EBADF', 'EISDIR'].includes(error.code)) throw error;
    } finally {
      await handle?.close();
    }
  }

  close() {
    if (this.closePromise) return this.closePromise;
    // Drain accepted operations before rejecting later calls; closing never writes or deletes snapshots.
    this.closed = true;
    this.closePromise = this.tail.then(() => {});
    return this.closePromise;
  }
}
