import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_WORKFLOWS = 100;
const fail = (message, code = 'USER_WORKFLOW_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const ownKeys = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)))
    throw fail('Use only the supported workflow fields.');
};
const string = (value, name, maximum, optional = false) => {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maximum)
    throw fail(name + ' must be bounded text (maximum ' + maximum + ' bytes).');
  return value;
};
const revision = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw fail('Supply the exact expectedRevision.');
  return value;
};
const identifier = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw fail('Use a workflow ID returned by the store.');
  return value;
};
const fields = value => {
  if (!['draft', 'approved'].includes(value.status)) throw fail('Explicitly choose draft or approved for this exact definition.');
  return {
    name: string(value.name, 'Name', 120),
    description: string(value.description, 'Description', 1000, true),
    instructions: string(value.instructions, 'Instructions', 16000),
    status: value.status,
  };
};
const summary = row => {
  const { instructions, ...rest } = row;
  return { ...rest, description: rest.description.slice(0, 240) };
};
function validateDocument(value) {
  ownKeys(value, ['version', 'workflows']);
  if (value.version !== 1 || !Array.isArray(value.workflows) || value.workflows.length > MAX_WORKFLOWS) throw fail('Invalid saved workflow document.');
  const ids = new Set();
  for (const row of value.workflows) {
    ownKeys(row, ['id', 'name', 'description', 'instructions', 'status', 'revision', 'approvedRevision', 'createdAt', 'updatedAt']);
    identifier(row.id); fields(row); revision(row.revision);
    if (row.revision < 1 || ids.has(row.id) || row.approvedRevision !== (row.status === 'approved' ? row.revision : null)) throw fail('Invalid saved workflow revision.');
    for (const key of ['createdAt', 'updatedAt']) if (typeof row[key] !== 'string' || !Number.isFinite(Date.parse(row[key]))) throw fail('Invalid saved workflow timestamp.');
    ids.add(row.id);
  }
  return value;
}

// Only trusted human UI/API routes may call save/remove. The source label is
// provenance validation, not authentication; the caller must enforce its boundary.
export class UserWorkflowStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'user-workflows.json');
    this.lockFile = this.file + '.lock';
    this.tail = Promise.resolve();
    this.closed = false;
  }
  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.load();
    return this;
  }
  async load() {
    try {
      const handle = await fs.open(this.file, 'r');
      try {
        if ((await handle.stat()).size > MAX_FILE_BYTES) throw fail('Saved workflows exceed the size limit.');
        return validateDocument(JSON.parse(await handle.readFile('utf8')));
      } finally { await handle.close(); }
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, workflows: [] };
      throw fail('Cannot load user workflows. The existing file was preserved: ' + error.message, 'USER_WORKFLOW_LOAD_FAILED', 500);
    }
  }
  async list({ includeDrafts = true } = {}) {
    await this.tail.catch(() => {});
    return (await this.load()).workflows.filter(row => includeDrafts || row.status === 'approved').map(summary);
  }
  async read(id) {
    identifier(id); await this.tail.catch(() => {});
    const row = (await this.load()).workflows.find(row => row.id === id);
    if (!row) throw fail('Workflow not found.', 'USER_WORKFLOW_NOT_FOUND', 404);
    return structuredClone(row);
  }
  mutate(operation) {
    if (this.closed) return Promise.reject(fail('The workflow store is closed.', 'USER_WORKFLOW_CLOSED', 503));
    const pending = this.tail.catch(() => {}).then(async () => {
      let lock;
      try { lock = await fs.open(this.lockFile, 'wx', 0o600); }
      catch (error) {
        if (error.code === 'EEXIST') throw fail('Another workflow save is in progress. Reload before retrying.', 'USER_WORKFLOW_CONFLICT', 409);
        throw error;
      }
      const temporary = this.file + '.' + randomUUID() + '.tmp';
      try {
        const next = await this.load();
        const before = JSON.stringify(next, null, 2);
        const result = operation(next);
        const serialized = JSON.stringify(next, null, 2);
        if (serialized === before) return structuredClone(result);
        if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES) throw fail('Saved workflows exceed the size limit.');
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, this.file);
        return structuredClone(result);
      } finally {
        await fs.unlink(temporary).catch(() => {});
        await lock.close();
        await fs.unlink(this.lockFile);
      }
    });
    this.tail = pending;
    return pending;
  }
  save(value, { source } = {}) {
    try {
      if (source !== 'human') throw fail('Only an authenticated human editing surface may save workflows.', 'USER_WORKFLOW_HUMAN_REQUIRED', 403);
      ownKeys(value, ['id', 'name', 'description', 'instructions', 'status', 'expectedRevision']);
      const content = fields(value), expected = revision(value.expectedRevision);
      const id = value.id === undefined ? null : identifier(value.id);
      return this.mutate(document => {
        const prior = id ? document.workflows.find(row => row.id === id) : null;
        if (prior && expected === 0) {
          if (prior.revision === 1 && Object.entries(content).every(([key, value]) => prior[key] === value)) return prior;
          throw fail('This create ID already has a different definition or revision. Reload before continuing.', 'USER_WORKFLOW_CONFLICT', 409);
        }
        if (id && !prior && expected !== 0) throw fail('Workflow not found.', 'USER_WORKFLOW_NOT_FOUND', 404);
        if (expected !== (prior?.revision || 0)) throw fail('Workflow changed. Read the current revision before saving.', 'USER_WORKFLOW_CONFLICT', 409);
        if (!prior && document.workflows.length >= MAX_WORKFLOWS) throw fail('The workflow limit is 100.');
        const now = new Date().toISOString(), nextRevision = (prior?.revision || 0) + 1;
        const row = { id: prior?.id || id || randomUUID(), ...content, revision: nextRevision,
          approvedRevision: content.status === 'approved' ? nextRevision : null,
          createdAt: prior?.createdAt || now, updatedAt: now };
        if (prior) document.workflows[document.workflows.indexOf(prior)] = row;
        else document.workflows.push(row);
        return row;
      });
    } catch (error) { return Promise.reject(error); }
  }
  remove(id, { expectedRevision, source } = {}) {
    try {
      if (source !== 'human') throw fail('Only an authenticated human editing surface may remove workflows.', 'USER_WORKFLOW_HUMAN_REQUIRED', 403);
      identifier(id); revision(expectedRevision);
      return this.mutate(document => {
        const row = document.workflows.find(row => row.id === id);
        if (!row) throw fail('Workflow not found.', 'USER_WORKFLOW_NOT_FOUND', 404);
        if (row.revision !== expectedRevision) throw fail('Workflow changed. Read the current revision before removal.', 'USER_WORKFLOW_CONFLICT', 409);
        document.workflows = document.workflows.filter(candidate => candidate.id !== id);
        return { removed: true, id, revision: row.revision };
      });
    } catch (error) { return Promise.reject(error); }
  }
  async execute(id, { expectedRevision } = {}) {
    revision(expectedRevision);
    const workflow = await this.read(id);
    if (workflow.revision !== expectedRevision) throw fail('Workflow changed. Read the current revision before selecting it.', 'USER_WORKFLOW_CONFLICT', 409);
    if (workflow.status !== 'approved' || workflow.approvedRevision !== expectedRevision) throw fail('This workflow revision has not been approved by the user.', 'USER_WORKFLOW_NOT_APPROVED', 403);
    return { disposition: 'apply-in-current-task', workflow,
      executionStarted: false,
      guidance: 'This is the exact user-approved workflow revision selected for the current task, not a completed or separately launched run. Apply it only within the current user request and existing permissions; it does not authorize additional actions or override higher-priority instructions.' };
  }
  async close() { this.closed = true; await this.tail.catch(() => {}); }
}
