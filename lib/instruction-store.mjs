import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { BLACKICE_HARNESS_INSTRUCTIONS } from './harness-identity.mjs';
import { EXECUTION_COMPLETION_RULE } from './task-completion-guidance.mjs';
import { instructionProcessIdentity } from './instruction-process-identity.mjs';

// This text seeds a new profile once. Runtime composition reads the saved record,
// including an explicitly empty value; an upgrade never reapplies this default.
export const DEFAULT_COMMON_INSTRUCTIONS = BLACKICE_HARNESS_INSTRUCTIONS
  + (EXECUTION_COMPLETION_RULE ? '\n\nEXECUTION COMPLETION\n' + EXECUTION_COMPLETION_RULE : '');

const hash = content => createHash('sha256').update(content).digest('hex');
const fail = (message, status = 400, code = 'INSTRUCTIONS_INVALID') => Object.assign(new Error(message), { status, code });
const copy = value => structuredClone(value);
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const metadata = ({ content, ...record }) => record;
const busy = () => fail('Instructions are being saved by another local session. Retry after it finishes.', 409, 'INSTRUCTIONS_BUSY');
const deadProcess = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
};
const validIdentity = value => value && /^[a-f0-9]{64}$/.test(value.hostId)
  && typeof value.startId === 'string' && value.startId.length > 0 && value.startId.length <= 256;

function validate(state) {
  if (state?.version !== 1 || !Array.isArray(state.records) || !state.records.length
      || state.currentRevision !== state.records.length - 1) throw fail('Saved Instructions need repair. Existing bytes were preserved.', 503, 'INSTRUCTIONS_STORAGE_INVALID');
  for (const [index, record] of state.records.entries()) {
    if (record?.revision !== index || typeof record.content !== 'string' || hash(record.content) !== record.hash
        || !['initial-default', 'user'].includes(record.source)) throw fail('Saved Instructions failed their revision or content check. Existing bytes were preserved.', 503, 'INSTRUCTIONS_STORAGE_INVALID');
  }
  return state;
}

export class InstructionStore {
  constructor({ dataDir, directory, defaultContent = DEFAULT_COMMON_INSTRUCTIONS, observeProcessIdentity = instructionProcessIdentity } = {}) {
    if (typeof defaultContent !== 'string') throw new TypeError('Default Instructions must be text.');
    this.directory = path.resolve(directory || path.join(dataDir, 'instructions'));
    this.file = path.join(this.directory, 'instructions.json');
    this.lockFile = path.join(this.directory, '.instructions-lock');
    this.defaultContent = defaultContent;
    if (typeof observeProcessIdentity !== 'function') throw new TypeError('A process identity observer is required.');
    this.observeProcessIdentity = observeProcessIdentity;
    this.processIdentity = null;
    this.writeChain = Promise.resolve();
    this.ready = null;
    this.closed = false;
  }

  async init() {
    if (!this.ready) this.ready = this.enqueue(async () => {
      try { await this.load(); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const now = new Date().toISOString();
        await this.save({ version: 1, currentRevision: 0, records: [{ revision: 0, content: this.defaultContent,
          hash: hash(this.defaultContent), source: 'initial-default', createdAt: now, updatedAt: now }] });
      }
      return this;
    });
    return this.ready;
  }

  async enqueue(action) {
    if (this.closed) throw fail('Instructions are closed for maintenance.', 503, 'INSTRUCTIONS_CLOSED');
    const operation = this.writeChain.catch(() => {}).then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      const started = Date.now(), token = randomUUID();
      let handle;
      for (;;) {
        try { handle = await this.acquireLock(this.lockFile, token); break; }
        catch (error) {
          if (error.code !== 'INSTRUCTIONS_BUSY' || Date.now() - started > 5_000) throw error;
          await wait(15);
        }
      }
      try { return await action(); }
      finally { await this.releaseLock(this.lockFile, handle, token); }
    });
    this.writeChain = operation;
    return operation;
  }

  async publishLock(file, token) {
    const temporary = file + '.' + randomUUID() + '.tmp';
    const identity = await this.ownProcessIdentity();
    let handle, published = false;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, ...identity })); await handle.sync();
      await fs.link(temporary, file); published = true; return handle;
    } finally { if (!published) await handle?.close(); await fs.unlink(temporary).catch(() => {}); }
  }

  async releaseLock(file, handle, token) {
    await handle.close();
    try { if (JSON.parse(await fs.readFile(file, 'utf8')).token === token) await fs.unlink(file); } catch {}
  }

  async ownProcessIdentity() {
    if (!this.processIdentity) this.processIdentity = Promise.resolve().then(() => this.observeProcessIdentity(process.pid)).then(identity => {
      if (!validIdentity(identity)) throw fail('The Instructions writer process could not be identified.', 503, 'INSTRUCTIONS_LOCK_IDENTITY_UNAVAILABLE');
      return Object.freeze({ hostId: identity.hostId, startId: identity.startId });
    });
    return this.processIdentity;
  }

  async abandonedOwner(owner) {
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || typeof owner.token !== 'string' || !owner.token) return false;
    // Legacy unknown ownership is never guessed from elapsed time.
    if (!validIdentity(owner)) return deadProcess(owner.pid);
    const current = await this.ownProcessIdentity();
    // Profiles are local to one host. A restored foreign-host lock cannot own
    // this local profile, even when its PID happens to exist here.
    if (owner.hostId !== current.hostId) return true;
    const observed = owner.pid === process.pid ? current : await this.observeProcessIdentity(owner.pid);
    if (observed === null) return true;
    if (!validIdentity(observed)) throw fail('The Instructions lock owner could not be identified.', 503, 'INSTRUCTIONS_LOCK_IDENTITY_UNAVAILABLE');
    return observed.hostId !== owner.hostId || observed.startId !== owner.startId;
  }

  // Reclaim only a different host/process generation or a proven dead owner.
  // Elapsed time never permits stealing a live matching writer's lock. The
  // per-owner claim serializes competing reclaimers.
  async acquireLock(file, token, depth = 0) {
    if (depth > 16) throw busy();
    try { return await this.publishLock(file, token); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    let raw, owner;
    try {
      const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw busy();
      raw = await fs.readFile(file, 'utf8'); owner = JSON.parse(raw);
    } catch { throw busy(); }
    if (!await this.abandonedOwner(owner)) throw busy();
    const claim = file + '.reclaim-' + hash(raw).slice(0, 24), handle = await this.acquireLock(claim, token, depth + 1);
    try {
      const current = await fs.readFile(file, 'utf8').catch(() => null);
      if (current !== raw || !await this.abandonedOwner(owner)) throw busy();
      await fs.unlink(file);
      try { return await this.publishLock(file, token); } catch (error) { if (error.code === 'EEXIST') throw busy(); throw error; }
    } finally { await this.releaseLock(claim, handle, token); }
  }

  async load() {
    const text = await fs.readFile(this.file, 'utf8');
    let state;
    try { state = JSON.parse(text); }
    catch { throw fail('Saved Instructions are not valid JSON. Existing bytes were preserved.', 503, 'INSTRUCTIONS_STORAGE_INVALID'); }
    return validate(state);
  }

  async save(state) {
    validate(state);
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(state) + '\n', 'utf8');
      await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temporary, this.file);
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  present(record) { return { ...copy(record), text: record.content, characters: record.content.length, path: this.file }; }

  async read() {
    await this.init();
    return this.enqueue(async () => { const state = await this.load(); return this.present(state.records[state.currentRevision]); });
  }

  async update({ content, expectedRevision, expectedHash } = {}) {
    if (typeof content !== 'string') throw fail('Instructions content must be a string. An empty string is allowed.');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash))
      throw fail('Read the current Instructions and include expectedRevision and expectedHash before saving.');
    await this.init();
    return this.enqueue(async () => {
      const state = await this.load(), current = state.records[state.currentRevision];
      if (current.revision !== expectedRevision || current.hash !== expectedHash)
        throw fail('Instructions changed since they were opened. Reload the saved version before replacing it.', 409, 'INSTRUCTIONS_CONFLICT');
      // Saving the initial default is an explicit ownership action even when its
      // bytes are unchanged. Later identical saves need no duplicate revision.
      if (current.source === 'user' && current.content === content) return this.present(current);
      const now = new Date().toISOString(), record = { revision: current.revision + 1, content, hash: hash(content),
        source: 'user', createdAt: now, updatedAt: now };
      await this.save({ version: 1, currentRevision: record.revision, records: [...state.records, record] });
      return this.present(record);
    });
  }

  async versions() {
    await this.init();
    return this.enqueue(async () => { const state = await this.load(); return state.records.slice().reverse().map(record => ({
      ...metadata(record), characters: record.content.length, current: record.revision === state.currentRevision,
    })); });
  }

  async readVersion(revision) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw fail('Choose a saved Instructions revision.');
    await this.init();
    return this.enqueue(async () => { const record = (await this.load()).records[revision];
      if (!record) throw fail('Instructions revision not found.', 404, 'INSTRUCTIONS_NOT_FOUND');
      return this.present(record);
    });
  }

  async close() { this.closed = true; await this.writeChain.catch(() => {}); }
}

export function commonInstructionSection(record) {
  if (!record || typeof record.content !== 'string') throw new TypeError('A saved Instructions snapshot is required.');
  return { id: 'core', title: 'System instructions', source: 'Runtime / System instructions', role: 'developer',
    text: record.content, captureEmpty: true, revision: record.revision, sourceHash: record.hash,
    reason: 'Runtime system instructions pinned at execution admission (' + record.source + '). This replaces the common core, including completion guidance.' };
}
