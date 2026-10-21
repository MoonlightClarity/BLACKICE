import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const PLANNING_ORGANIZATION_LIMITS = Object.freeze({ groups: 200, assignments: 100000, bytes: 24 * 1024 * 1024, operations: 100 });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const fail = (message, code = 'PLANNING_ORGANIZATION_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const check = signal => { if (signal?.aborted) throw Object.assign(fail('Planning organization update cancelled.', 'ABORT_ERR'), { name: 'AbortError' }); };
const id = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) throw fail('Use an existing plan, project or group identifier.'); return value; };
const name = (value, maximum, label) => { if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw fail(`${label} needs nonempty text of at most ${maximum} characters on one line.`); return value.trim(); };
const empty = () => ({ version: 1, revision: 0, groups: [], plans: [], projects: [], updatedAt: null });
const duplicate = (items, key) => new Set(items.map(item => item[key])).size !== items.length;
const normalizedName = value => value.normalize('NFKC').toLocaleLowerCase();
const busy = () => fail('Planning organization is being updated elsewhere. Reload it and try again.', 'PLANNING_ORGANIZATION_BUSY', 409);
const dead = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };

function validateState(value) {
  if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.groups) || value.groups.length > PLANNING_ORGANIZATION_LIMITS.groups || !Array.isArray(value.plans) || !Array.isArray(value.projects) || value.plans.length + value.projects.length > PLANNING_ORGANIZATION_LIMITS.assignments) throw fail('Invalid saved Planning organization.');
  const groups = new Set();
  for (const group of value.groups) {
    if (!object(group)) throw fail('Invalid saved plan group.');
    id(group.id); name(group.name, 120, 'Group name');
    if (['all', 'ungrouped'].includes(group.id) || groups.has(group.id)) throw fail('Saved plan groups must have unique identifiers.');
    groups.add(group.id);
  }
  if (new Set(value.groups.map(group => normalizedName(group.name))).size !== value.groups.length) throw fail('Saved plan groups must have unique names.');
  for (const [field, key] of [['plans', 'taskId'], ['projects', 'projectId']]) {
    for (const item of value[field]) {
      if (!object(item)) throw fail('Invalid saved Planning assignment.');
      id(item[key]);
      if (item.groupId !== null && (!groups.has(item.groupId) || typeof item.groupId !== 'string')) throw fail('A saved plan group assignment is unavailable.');
      if (field === 'plans' && item.name !== null) name(item.name, 160, 'Plan name');
      if (field === 'projects' && typeof item.archived !== 'boolean') throw fail('Invalid saved project archive state.');
    }
    if (duplicate(value[field], key)) throw fail('Saved Planning assignments must have unique identifiers.');
  }
  return value;
}

/** Display organization is separate from executable task revisions and worker ownership. */
export class PlanningOrganizationStore {
  constructor({ dataDir, io = fs, lockTimeoutMs = 5000 } = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw fail('An absolute Planning data folder is required.');
    this.file = path.join(dataDir, 'planning-organization.json'); this.io = io; this.lockTimeoutMs = lockTimeoutMs;
    this.tail = Promise.resolve(); this.ready = null; this.closed = false; this.seen = false;
  }
  init() { return this.ready ||= this.io.mkdir(path.dirname(this.file), { recursive: true }).then(() => this); }
  async get({ signal } = {}) {
    await this.init(); check(signal);
    try {
      const info = await this.io.stat(this.file);
      if (!info.isFile() || info.size > PLANNING_ORGANIZATION_LIMITS.bytes) throw fail('Saved Planning organization exceeds its storage limit.');
      const value = validateState(JSON.parse(await this.io.readFile(this.file, 'utf8'))); check(signal); this.seen = true; return copy(value);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      if (error.code === 'ENOENT' && !this.seen) {
        try { await this.io.stat(`${this.file}.bak`); }
        catch (backup) { if (backup.code === 'ENOENT') return empty(); }
      }
      throw fail('Saved Planning names and groups could not be read. Existing files were preserved; restore the organization file before editing it.', 'PLANNING_ORGANIZATION_STORAGE', 503);
    }
  }
  async publishLock(file, token, signal) {
    check(signal); const temporary = `${file}.${randomUUID()}.tmp`; let handle, published = false;
    try {
      handle = await this.io.open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync(); check(signal);
      await this.io.link(temporary, file); published = true; return handle;
    } finally { if (!published) await handle?.close(); await this.io.rm(temporary, { force: true }).catch(() => {}); }
  }
  async releaseLock(file, handle, token) {
    await handle.close();
    try { if (JSON.parse(await this.io.readFile(file, 'utf8')).token === token) await this.io.unlink(file); } catch {}
  }
  async acquireLock(file, token, signal, depth = 0) {
    check(signal); if (depth > 16) throw busy();
    try { return await this.publishLock(file, token, signal); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    let raw, owner;
    try { const info = await this.io.stat(file); if (!info.isFile() || info.size > 65536) throw busy(); raw = await this.io.readFile(file, 'utf8'); owner = JSON.parse(raw); } catch { throw busy(); }
    if (!dead(owner.pid) || typeof owner.token !== 'string' || !owner.token) throw busy();
    const claim = `${file}.reclaim-${createHash('sha256').update(raw).digest('hex').slice(0, 24)}`, handle = await this.acquireLock(claim, token, signal, depth + 1);
    try {
      if (await this.io.readFile(file, 'utf8') !== raw || !dead(owner.pid)) throw busy();
      check(signal); await this.io.unlink(file);
      try { return await this.publishLock(file, token, signal); } catch (error) { if (error.code === 'EEXIST') throw busy(); throw error; }
    } finally { await this.releaseLock(claim, handle, token); }
  }
  async atomic(file, value, signal, ownership) {
    check(signal); const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await this.io.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
      check(signal); await ownership(); await this.io.rename(temporary, file);
    } finally { await this.io.rm(temporary, { force: true }).catch(() => {}); }
  }
  // Admission and archival share this lock, so a project cannot start between
  // checking its settled state and publishing its archive membership.
  withState(operation, { signal } = {}) {
    if (this.closed) return Promise.reject(fail('Planning organization is closed.', 'PLANNING_ORGANIZATION_CLOSED', 503));
    const pending = this.tail.catch(() => {}).then(async () => {
      await this.init(); check(signal);
      const lock = `${this.file}.lock`, token = randomUUID(), deadline = Date.now() + this.lockTimeoutMs; let handle;
      while (true) {
        try { handle = await this.acquireLock(lock, token, signal); break; }
        catch (error) { if (error.code !== 'PLANNING_ORGANIZATION_BUSY') throw error; check(signal); if (Date.now() >= deadline) throw error; await delay(15, undefined, signal ? { signal } : undefined); }
      }
      try { const state = await this.get({ signal }); check(signal); return await operation(state); }
      finally { await this.releaseLock(lock, handle, token); }
    });
    this.tail = pending; return pending;
  }
  edit(value, { signal, validateTargets = async () => {}, actor } = {}) {
    if (!object(value) || Object.keys(value).some(key => !['expectedRevision', 'operations'].includes(key)) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 || !Array.isArray(value.operations) || !value.operations.length || value.operations.length > PLANNING_ORGANIZATION_LIMITS.operations) return Promise.reject(fail('Supply the organization expectedRevision and from 1 to 100 organization operations.'));
    if (this.closed) return Promise.reject(fail('Planning organization is closed.', 'PLANNING_ORGANIZATION_CLOSED', 503));
    // Freeze the caller's request before it waits behind another writer.
    const requested = copy(value);
    const pending = this.tail.catch(() => {}).then(async () => {
      await this.init(); check(signal); const lock = `${this.file}.lock`, token = randomUUID(), deadline = Date.now() + this.lockTimeoutMs; let handle;
      while (true) {
        try { handle = await this.acquireLock(lock, token, signal); break; }
        catch (error) { if (error.code !== 'PLANNING_ORGANIZATION_BUSY') throw error; check(signal); if (Date.now() >= deadline) throw error; await delay(15, undefined, signal ? { signal } : undefined); }
      }
      try {
        const previous = await this.get({ signal });
        if (previous.revision !== requested.expectedRevision) throw Object.assign(fail('Plan names or groups changed while you were editing. Reload them and review your change before saving.', 'PLANNING_ORGANIZATION_CONFLICT', 409), { currentRevision: previous.revision });
        const next = copy(previous), createdGroupIds = [], taskIds = new Set(), projectIds = new Set(), now = new Date().toISOString();
        for (const operation of requested.operations) {
          if (!object(operation)) throw fail('Each organization edit needs a supported operation.');
          const fields = { create_group: ['type', 'id', 'name'], rename_group: ['type', 'groupId', 'name'], remove_group: ['type', 'groupId'], update_plan: ['type', 'taskId', 'name', 'groupId'], update_project: ['type', 'projectId', 'groupId', 'archived'] }[operation.type];
          if (!Array.isArray(fields) || Object.keys(operation).some(key => !fields.includes(key))) throw fail('Use a supported organization operation and its declared fields.');
          if (operation.type === 'create_group') {
            const groupId = operation.id === undefined ? `group_${randomUUID()}` : id(operation.id);
            if (['all', 'ungrouped'].includes(groupId) || next.groups.some(group => group.id === groupId)) throw fail('Choose a new group identifier.');
            next.groups.push({ id: groupId, name: name(operation.name, 120, 'Group name'), createdAt: now, updatedAt: now }); createdGroupIds.push(groupId);
          } else if (operation.type === 'rename_group' || operation.type === 'remove_group') {
            id(operation.groupId); const group = next.groups.find(group => group.id === operation.groupId);
            if (!group) throw fail('This plan group no longer exists. Reload the groups.', 'PLANNING_GROUP_MISSING', 404);
            if (operation.type === 'rename_group') { group.name = name(operation.name, 120, 'Group name'); group.updatedAt = now; }
            else {
              next.groups = next.groups.filter(item => item.id !== group.id);
              for (const item of next.plans) if (item.groupId === group.id) { item.groupId = null; taskIds.add(item.taskId); }
              for (const item of next.projects) if (item.groupId === group.id) { item.groupId = null; projectIds.add(item.projectId); }
            }
          } else {
            const task = operation.type === 'update_plan', key = task ? 'taskId' : 'projectId', collection = task ? next.plans : next.projects;
            id(operation[key]);
            if (!Object.hasOwn(operation, 'groupId') && !Object.hasOwn(operation, task ? 'name' : 'archived')) throw fail('Choose a plan name, group or archive change.');
            let item = collection.find(item => item[key] === operation[key]);
            if (!item) { item = { [key]: operation[key], groupId: null, ...(task ? { name: null } : { archived: false }) }; collection.push(item); }
            if (Object.hasOwn(operation, 'groupId')) {
              if (operation.groupId !== null && !next.groups.some(group => group.id === operation.groupId)) throw fail('Choose an existing plan group, or null for Ungrouped.', 'PLANNING_GROUP_MISSING', 404);
              item.groupId = operation.groupId;
            }
            if (task && Object.hasOwn(operation, 'name')) item.name = operation.name === null ? null : name(operation.name, 160, 'Plan name');
            if (!task && Object.hasOwn(operation, 'archived')) {
              if (typeof operation.archived !== 'boolean') throw fail('Use true or false for project archive state.');
              item.archived = operation.archived;
            }
            (task ? taskIds : projectIds).add(operation[key]);
          }
        }
        next.plans = next.plans.filter(item => item.name !== null || item.groupId !== null);
        next.projects = next.projects.filter(item => item.archived || item.groupId !== null);
        next.revision++; next.updatedAt = now;
        next.provenance = { source: 'human', at: now, ...(actor ? { actor: copy(actor) } : {}) };
        validateState(next);
        if (Buffer.byteLength(JSON.stringify(next)) > PLANNING_ORGANIZATION_LIMITS.bytes) throw fail('Saved plan organization exceeds its storage limit.', 'PLANNING_ORGANIZATION_LIMIT', 413);
        await validateTargets(requested.operations); check(signal);
        const ownership = async () => { check(signal); let owner; try { owner = JSON.parse(await this.io.readFile(lock, 'utf8')); } catch {} if (owner?.token !== token || owner?.pid !== process.pid) throw fail('Planning organization write ownership changed. Reload before retrying.', 'PLANNING_ORGANIZATION_LOCK_LOST', 409); };
        await this.atomic(`${this.file}.bak`, previous, signal, ownership);
        await this.atomic(this.file, next, signal, ownership); this.seen = true;
        return { ...copy(next), createdGroupIds, taskIds: [...taskIds], projectIds: [...projectIds] };
      } finally { await this.releaseLock(lock, handle, token); }
    });
    this.tail = pending; return pending;
  }
  async close() { this.closed = true; await this.tail.catch(() => {}); }
}
