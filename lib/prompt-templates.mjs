import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BUILTIN_PROMPT_TEMPLATES, PROMPT_TEMPLATE_LIMITS, validatePromptTemplate, promptTemplateFields, renderPromptTemplate } from '../public/prompt-template-model.mjs';

export const PROMPT_TEMPLATE_FORMAT = 'relay-prompt-template';
export const PROMPT_TEMPLATE_STORAGE_BYTES = 32 * 1024 * 1024;
const clone = value => structuredClone(value), now = () => new Date().toISOString();
const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const fail = (message, status = 400, code = 'PROMPT_TEMPLATE_INVALID') => Object.assign(new Error(message), { status, code });
const check = signal => { if (signal?.aborted) throw Object.assign(new Error('Prompt operation stopped.'), { name: 'AbortError', code: 'ABORT_ERR' }); };
const idOf = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw fail('Choose a valid prompt ID.'); return value; };
const revisionOf = value => { if (!Number.isSafeInteger(value) || value < 1) throw fail('Read the current prompt and send its expectedRevision before changing it.'); return value; };
const assertRevision = (previous, expected) => { revisionOf(expected); if (previous.revision !== expected) throw fail('This prompt changed while it was open. Reload it before saving or restoring.', 409, 'PROMPT_TEMPLATE_CONFLICT'); };
const authored = value => { const normalized = validatePromptTemplate(value); return { title: normalized.title, description: normalized.description, sections: normalized.sections }; };
const current = entry => { const { history, ...value } = entry; return clone(value); };
const provenanceOf = value => {
  if (!plain(value) || Object.keys(value).some(key => !['source', 'runId', 'nodeId', 'reason'].includes(key)) || !['user', 'agent', 'import'].includes(value.source || 'user')) throw fail('Invalid prompt change source.');
  const result = { source: value.source || 'user' };
  for (const key of ['runId', 'nodeId', 'reason']) if (value[key] !== undefined) { if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > (key === 'reason' ? 240 : 100) || value[key].includes('\0')) throw fail('Invalid prompt change provenance.'); result[key] = value[key]; }
  return result;
};
const summary = template => ({ id: template.id, title: template.title, description: template.description, revision: template.revision, builtin: Boolean(template.builtin), deleted: Boolean(template.deleted), fields: promptTemplateFields(current(template)), ...(template.updatedAt ? { updatedAt: template.updatedAt } : {}) });
const portable = template => ({ format: PROMPT_TEMPLATE_FORMAT, version: 1, template: authored(template) });

/** Durable outlines with immutable built-ins, optimistic edits and complete local revisions. */
export class PromptTemplateStore extends EventEmitter {
  constructor({ dataDir, io = fs } = {}) {
    super(); if (typeof dataDir !== 'string' || !dataDir) throw fail('A prompt data folder is required.');
    this.file = path.join(path.resolve(dataDir), 'prompt-templates.json'); this.lockDirectory = `${this.file}.lock`; this.io = io;
    this.entries = new Map(); this.writeChain = Promise.resolve(); this.initialized = false; this.closed = false; this.snapshotSeen = false; this.lastError = null; this.recovered = false; this.unavailable = false; this.lockWarning = null;
  }
  init() {
    if (this.initialized) return Promise.resolve(this); if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      await this.io.mkdir(path.dirname(this.file), { recursive: true });
      await this.withLock(async () => {
        let entries;
        try { entries = await this.readSnapshot(this.file); this.snapshotSeen = true; }
        catch (cause) {
          try { entries = await this.readSnapshot(`${this.file}.bak`); if (cause.code !== 'ENOENT') await this.io.rename(this.file, `${this.file}.corrupt-${randomUUID()}`); this.recovered = true; this.snapshotSeen = true; }
          catch (backup) { if (cause.code !== 'ENOENT' || backup.code !== 'ENOENT') throw fail(`Cannot load saved prompts: ${cause.message}. Existing files were preserved.`, 500, 'PROMPT_TEMPLATE_STORAGE'); entries = new Map(); }
        }
        this.entries = entries; if (this.recovered) await this.writeSnapshot(entries);
      });
      this.initialized = true; this.lastError = null; return this;
    })().catch(cause => { this.lastError = cause.message; this.unavailable = true; this.initialized = true; return this; });
    return this.initPromise;
  }
  assertReady() { if (!this.initialized) throw fail('Saved prompts are not ready.', 503); }
  async withLock(operation, signal) {
    const ownerFile = path.join(this.lockDirectory, 'owner.json'), token = randomUUID(), deadline = Date.now() + 5000;
    while (true) {
      check(signal);
      try { await this.io.mkdir(this.lockDirectory); try { await this.io.writeFile(ownerFile, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 }); } catch (cause) { await this.io.rm(ownerFile, { force: true }).catch(() => {}); await this.io.rmdir(this.lockDirectory).catch(() => {}); throw cause; } break; }
      catch (cause) {
        if (cause.code !== 'EEXIST') throw cause;
        try {
          const raw = await this.io.readFile(ownerFile, 'utf8'), owner = JSON.parse(raw); let dead = false;
          if (Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string') { try { process.kill(owner.pid, 0); } catch (failure) { dead = failure.code === 'ESRCH'; } }
          if (dead && await this.io.readFile(ownerFile, 'utf8') === raw) { await this.io.rm(ownerFile); await this.io.rmdir(this.lockDirectory); continue; }
        } catch (failure) { if (failure.code === 'ENOENT') { const info = await this.io.stat(this.lockDirectory).catch(() => null); if (info && Date.now() - info.mtimeMs > 180000) await this.io.rmdir(this.lockDirectory).catch(() => {}); } }
        if (Date.now() >= deadline) throw fail('Saved prompts are being updated elsewhere. Retry in a moment.', 409, 'PROMPT_TEMPLATE_CONFLICT');
        await delay(15, undefined, signal ? { signal } : undefined);
      }
    }
    try { check(signal); return await operation(); }
    finally {
      // Unlock failures must not turn a committed save into a false failure.
      // Retry transient access errors, then keep the confirmed receipt and make
      // the library read-only until its uncertain lock can be recovered.
      let ownerRemoved = false, released = false;
      for (let attempt = 0; attempt < 3 && !released; attempt++) {
        try {
          if (!ownerRemoved) { const owner = JSON.parse(await this.io.readFile(ownerFile, 'utf8')); if (owner.token !== token) throw fail('The prompt lock owner changed.'); await this.io.rm(ownerFile); ownerRemoved = true; }
          await this.io.rmdir(this.lockDirectory); released = true;
        } catch (cause) {
          if (cause.code === 'ENOENT') { try { await this.io.stat(this.lockDirectory); } catch (missing) { if (missing.code === 'ENOENT') { released = true; break; } } }
          if (attempt < 2) await delay(15);
        }
      }
      if (!released) { this.lockWarning = 'The prompt library could not release its storage lock. Saved receipts remain valid. Reopen Relay after restoring access to the prompt library folder.'; this.unavailable = true; if (this.initialized) this.emit('updated', this.status()); }
    }
  }
  async readSnapshot(file) {
    if ((await this.io.stat(file)).size > PROMPT_TEMPLATE_STORAGE_BYTES) throw fail('The saved prompt file exceeds its storage budget.');
    const value = JSON.parse(await this.io.readFile(file, 'utf8'));
    if (!plain(value) || Object.keys(value).some(key => !['version', 'entries'].includes(key)) || value.version !== 1 || !Array.isArray(value.entries)) throw fail('Invalid saved prompt file.');
    const entries = new Map();
    const validateRecord = record => {
      if (!plain(record) || Object.keys(record).some(key => !['id', 'title', 'description', 'sections', 'revision', 'builtin', 'deleted', 'createdAt', 'updatedAt', 'action', 'provenance', 'restoredFromRevision'].includes(key))) throw fail('Invalid saved prompt revision.');
      validatePromptTemplate(record); idOf(record.id); revisionOf(record.revision);
      if (record.id.startsWith('builtin_') || record.builtin !== false || typeof record.deleted !== 'boolean' || !['create', 'update', 'delete', 'restore', 'import', 'patch'].includes(record.action) || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) throw fail('Invalid saved prompt metadata.');
      provenanceOf(record.provenance);
      if (record.restoredFromRevision !== undefined && (!Number.isSafeInteger(record.restoredFromRevision) || record.restoredFromRevision < 1 || record.restoredFromRevision >= record.revision)) throw fail('Invalid restored prompt revision.');
    };
    for (const entry of value.entries) {
      if (!plain(entry) || !Array.isArray(entry.history)) throw fail('Invalid prompt revision history.'); const latest = current(entry); validateRecord(latest);
      if (entries.has(entry.id)) throw fail('Duplicate saved prompt IDs.');
      let previousRevision = 0;
      for (const saved of entry.history) { validateRecord(saved); if (saved.id !== entry.id || saved.revision !== previousRevision + 1 || saved.createdAt !== entry.createdAt) throw fail('Invalid prompt revision sequence.'); previousRevision = saved.revision; }
      if (entry.revision !== previousRevision + 1) throw fail('Incomplete prompt revision history.');
      entries.set(entry.id, entry);
    }
    return entries;
  }
  async readCurrent() {
    try { const entries = await this.readSnapshot(this.file); this.snapshotSeen = true; return entries; }
    catch (cause) { if (cause.code === 'ENOENT' && !this.snapshotSeen && !this.entries.size) { try { await this.io.stat(`${this.file}.bak`); } catch (backup) { if (backup.code === 'ENOENT') return new Map(); } } throw fail(`Cannot update saved prompts: ${cause.message}. Existing files were preserved. Reopen Relay to recover them.`, 500, 'PROMPT_TEMPLATE_STORAGE'); }
  }
  async writeSnapshot(entries, signal) {
    const serialized = JSON.stringify({ version: 1, entries: [...entries.values()] }, null, 2);
    if (Buffer.byteLength(serialized) > PROMPT_TEMPLATE_STORAGE_BYTES) throw fail('Saved prompts and their revision history exceed the local storage budget. Export a copy before editing the library file.', 507, 'PROMPT_TEMPLATE_STORAGE');
    const temporary = `${this.file}.${randomUUID()}.tmp`, backup = `${this.file}.${randomUUID()}.bak.tmp`;
    try {
      check(signal);
      try { await this.readSnapshot(this.file); await this.io.copyFile(this.file, backup); check(signal); await this.io.rename(backup, `${this.file}.bak`); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      const handle = await this.io.open(temporary, 'wx', 0o600); try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
      check(signal); await this.io.rename(temporary, this.file);
    } finally { await this.io.rm(temporary, { force: true }).catch(() => {}); await this.io.rm(backup, { force: true }).catch(() => {}); }
  }
  status() { return { healthy: !(this.lastError || this.lockWarning), error: this.lastError || this.lockWarning, recovered: this.recovered, recoveryRequired: this.unavailable, count: [...this.entries.values()].filter(entry => !entry.deleted).length, deleted: [...this.entries.values()].filter(entry => entry.deleted).length, builtins: BUILTIN_PROMPT_TEMPLATES.length }; }
  list({ query = '', includeDeleted = false } = {}) {
    this.assertReady(); if (typeof query !== 'string' || query.length > 256 || typeof includeDeleted !== 'boolean') throw fail('Choose a search of at most 256 characters and includeDeleted true or false.');
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return [...BUILTIN_PROMPT_TEMPLATES, ...this.entries.values()].filter(entry => (includeDeleted || !entry.deleted) && words.every(word => `${entry.title}\n${entry.description}`.toLowerCase().includes(word))).map(summary);
  }
  get(id, { includeDeleted = false } = {}) { this.assertReady(); idOf(id); const builtin = BUILTIN_PROMPT_TEMPLATES.find(item => item.id === id); if (builtin) return current(builtin); const entry = this.entries.get(id); if (this.unavailable && !entry) throw fail('Saved prompts need recovery. Restore the prompt library file or its backup, then reopen Relay. Built-in prompts remain available.', 503, 'PROMPT_TEMPLATE_STORAGE'); if (!entry || entry.deleted && !includeDeleted) throw fail('Prompt not found.', 404); return current(entry); }
  history(id) { this.assertReady(); const entry = this.entries.get(idOf(id)); if (!entry) { const builtin = this.get(id); return { templateId: id, currentRevision: builtin.revision, deleted: false, history: [builtin] }; } return { templateId: id, currentRevision: entry.revision, deleted: entry.deleted, history: [current(entry), ...entry.history.map(current).reverse()] }; }
  render(request = {}) { this.assertReady(); if (!plain(request) || Object.keys(request).some(key => !['template', 'id', 'values'].includes(key))) throw fail('Choose a saved prompt ID or an outline, and its text field values.'); const { template, id, values } = request; if ((template === undefined) === (id === undefined)) throw fail('Choose either a saved prompt ID or an outline to render.'); const source = template === undefined ? this.get(id) : validatePromptTemplate(template), rendered = renderPromptTemplate(source, values); return { ...rendered, sha256: createHash('sha256').update(rendered.text).digest('hex') }; }
  export(id) { return portable(this.get(id)); }
  mutate(operation, signal) {
    this.assertReady(); if (this.closed) return Promise.reject(fail('Relay is closing. Reopen it before changing prompts.', 503)); if (this.unavailable) return Promise.reject(fail('Saved prompts need recovery. Restore the prompt library file or its backup, then reopen Relay. Existing files were preserved.', 503, 'PROMPT_TEMPLATE_STORAGE'));
    const pending = this.writeChain.catch(() => {}).then(() => { if (this.unavailable) throw fail('Saved prompts need recovery before another edit can be committed.', 503, 'PROMPT_TEMPLATE_STORAGE'); return this.withLock(async () => {
      check(signal); let next; try { next = await this.readCurrent(); } catch (cause) { this.lastError = cause.message; throw cause; }
      // Refresh confirmed external changes even when this edit later conflicts.
      // Keep a separate copy so a failed or stopped draft cannot leak into reads.
      this.entries = new Map([...next].map(([id, entry]) => [id, clone(entry)]));
      check(signal); const result = operation(next);
      try { await this.writeSnapshot(next, signal); } catch (cause) { if (cause.name !== 'AbortError') this.lastError = cause.message; throw cause; }
      this.entries = next; this.snapshotSeen = true; this.lastError = null; this.emit('updated', this.status()); return clone(result);
    }, signal); }); this.writeChain = pending; return pending;
  }
  save(value, { expectedRevision, provenance = { source: 'user' }, signal, action } = {}) {
    const template = validatePromptTemplate(value), source = provenanceOf(provenance);
    if (template.id?.startsWith('builtin_')) throw fail('Built-in prompts are read-only. Omit the ID to save your own copy.');
    if (template.id === undefined && expectedRevision !== undefined) throw fail('A new prompt does not have an expected revision.');
    return this.mutate(next => {
      const previous = template.id ? next.get(template.id) : null;
      if (template.id && !previous) throw fail('Prompt not found. Omit the ID to create a new prompt.', 404);
      if (previous) { assertRevision(previous, expectedRevision); if (previous.deleted) throw fail('Restore this prompt before editing it.', 409); }
      const at = now(), entry = { id: previous?.id || `prompt_${randomUUID()}`, ...authored(template), builtin: false, deleted: false, revision: (previous?.revision || 0) + 1, createdAt: previous?.createdAt || at, updatedAt: at, action: previous ? 'update' : action === 'import' ? 'import' : 'create', provenance: source, history: previous ? [...previous.history, current(previous)] : [] };
      next.set(entry.id, entry); return current(entry);
    }, signal);
  }
  remove(id, { expectedRevision, provenance = { source: 'user' }, signal } = {}) {
    idOf(id); const source = provenanceOf(provenance);
    if (id.startsWith('builtin_')) throw fail('Built-in prompts are read-only.');
    return this.mutate(next => { const previous = next.get(id); if (!previous || previous.deleted) throw fail('Prompt not found.', 404); assertRevision(previous, expectedRevision); const entry = { ...current(previous), deleted: true, revision: previous.revision + 1, updatedAt: now(), action: 'delete', provenance: source, history: [...previous.history, current(previous)] }; next.set(id, entry); return current(entry); }, signal);
  }
  restore(id, { expectedRevision, revision, provenance = { source: 'user' }, signal } = {}) {
    idOf(id); const source = provenanceOf(provenance); if (id.startsWith('builtin_')) throw fail('Built-in prompts are read-only.'); if (revision !== undefined) revisionOf(revision);
    return this.mutate(next => {
      const previous = next.get(id); if (!previous) throw fail('Prompt history not found.', 404); assertRevision(previous, expectedRevision);
      const selected = revision === undefined ? previous : previous.revision === revision ? previous : previous.history.find(item => item.revision === revision);
      if (!selected) throw fail('Prompt revision not found.', 404); if (!previous.deleted && revision === undefined) throw fail('Choose an earlier revision to restore.', 409);
      const entry = { ...current(previous), ...authored(current(selected)), deleted: false, revision: previous.revision + 1, updatedAt: now(), action: 'restore', provenance: source, restoredFromRevision: selected.revision, history: [...previous.history, current(previous)] }; next.set(id, entry); return current(entry);
    }, signal);
  }
  import(document, { provenance = { source: 'import' }, signal } = {}) {
    let value = document; if (typeof value === 'string') { if (Buffer.byteLength(value) > PROMPT_TEMPLATE_LIMITS.documentBytes) throw fail('The prompt file is too large.'); try { value = JSON.parse(value); } catch { throw fail('Choose a valid Relay prompt JSON file.'); } }
    if (!plain(value) || Object.keys(value).some(key => !['format', 'version', 'template'].includes(key)) || value.format !== PROMPT_TEMPLATE_FORMAT || value.version !== 1) throw fail('Choose a supported Relay prompt file.');
    const normalized = validatePromptTemplate(value.template, { allowMetadata: false });
    return this.save(authored(normalized), { provenance, signal, action: 'import' });
  }
  async close() { this.closed = true; await this.writeChain.catch(() => {}); }
}

const sectionSchema = { type: 'object', properties: { id: { type: 'string', maxLength: 100 }, title: { type: 'string', maxLength: 120 }, content: { type: 'string', maxLength: 50000 }, level: { type: 'integer', minimum: 0, maximum: 4 } }, required: ['id', 'title', 'content', 'level'], additionalProperties: false };
const templateSchema = { type: 'object', properties: { id: { type: 'string', maxLength: 100 }, title: { type: 'string', maxLength: 120 }, description: { type: 'string', maxLength: 400 }, sections: { type: 'array', minItems: 1, items: sectionSchema } }, required: ['title', 'sections'], additionalProperties: false };
export const PROMPT_TOOL = { type: 'function', name: 'relay_prompts', description: 'Optional reusable prompt outlines. List/read before rendering or editing; ordinary chat never needs a template. Render replaces {{field}} literally and returns plain text, without sending a task. Save custom outlines, inspect history, delete and restore with the current expectedRevision. Built-ins are read-only; omit their ID to save a copy. Import creates a new custom prompt from portable Relay JSON. No code, file includes or expressions are evaluated.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'read', 'render', 'save', 'delete', 'history', 'restore', 'export', 'import'] }, id: { type: 'string', maxLength: 100 }, query: { type: 'string', maxLength: 256 }, includeDeleted: { type: 'boolean' }, template: templateSchema, values: { type: 'object', additionalProperties: { type: 'string', maxLength: 50000 } }, expectedRevision: { type: 'integer', minimum: 1 }, revision: { type: 'integer', minimum: 1 }, document: { type: 'string', description: 'Portable Relay prompt JSON; import always creates a new ID.' } }, required: ['action'], additionalProperties: false } };
export const PROMPT_INSTRUCTIONS = '\n\nOPTIONAL PROMPT OUTLINES\nUse relay_prompts when a reusable outline would help or the user asks to save, reuse or improve a prompt. Ordinary tasks do not require a template. List summaries, read the relevant outline, then render with text fields. Rendered text is a draft, never an automatic send or a change to this active task. Save only useful reusable instructions; keep task-specific values and credentials out of templates. {{task}} is required when present; other fields may be blank. No expressions or includes are evaluated. Read before editing, deleting or restoring and send the current expectedRevision; built-ins require a new copy without their ID. Changes apply immediately with local history and undo. Preserve the user\'s intent and report only successful tool receipts.\n';

export function createPromptToolHandler({ store, runId, nodeId, signal, onEvent } = {}) {
  return async (call, context = {}) => {
    const effectiveSignal = context.signal ? AbortSignal.any([signal, context.signal].filter(Boolean)) : signal;
    try {
      check(effectiveSignal); if (call.name !== PROMPT_TOOL.name) throw fail('Unknown prompt tool.');
      const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
      if (!plain(args) || Object.keys(args).some(key => !Object.hasOwn(PROMPT_TOOL.inputSchema.properties, key))) throw fail('Choose prompt arguments from the tool schema.');
      const provenance = { source: 'agent', ...(runId ? { runId } : {}), ...(nodeId ? { nodeId } : {}) }, options = { expectedRevision: args.expectedRevision, provenance, signal: effectiveSignal }; let result;
      if (args.action === 'list') result = { templates: store.list({ query: args.query, includeDeleted: args.includeDeleted }) };
      else if (args.action === 'read') result = { template: store.get(args.id) };
      else if (args.action === 'render') result = store.render({ template: args.template, id: args.id, values: args.values });
      else if (args.action === 'save') result = { template: await store.save(args.template, options) };
      else if (args.action === 'delete') result = { template: await store.remove(args.id, options) };
      else if (args.action === 'history') result = store.history(args.id);
      else if (args.action === 'restore') result = { template: await store.restore(args.id, { ...options, revision: args.revision }) };
      else if (args.action === 'export') result = { document: store.export(args.id) };
      else if (args.action === 'import') result = { template: await store.import(args.document, { provenance, signal: effectiveSignal }) };
      else throw fail('Choose a prompt action from the tool schema.');
      check(effectiveSignal); onEvent?.({ type: 'prompts.result', action: args.action, ...(result.template?.id ? { templateId: result.template.id } : {}) });
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
    } catch (cause) { return { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: cause.message, ...(cause.code ? { code: cause.code } : {}) }) }] }; }
  };
}
