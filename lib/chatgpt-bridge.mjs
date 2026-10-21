import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { chatGPTBridgeModeViolation } from './chatgpt-bridge-mode-guard.mjs';

export const CHATGPT_BRIDGE_LIMITS = Object.freeze({
  requestIdChars: 128, titleChars: 160, promptChars: 64000, contextChars: 256000,
  answerChars: 256000, cwdChars: 4096, previewChars: 220,
  requests: 2000, storageBytes: 32 * 1024 * 1024, listLimit: 100,
});

const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400, code = 'CHATGPT_BRIDGE_INVALID') => Object.assign(new Error(message), { status, code });
const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const fields = (value, allowed, label) => {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail(`${label} must be an object containing only ${allowed.length ? allowed.join(', ') : 'no fields'}.`);
};
const textValue = (value, label, maximum, { empty = false } = {}) => {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim()) || value.includes('\0')) throw fail(`${label} must be ${empty ? '' : 'nonempty '}text of at most ${maximum.toLocaleString('en-US')} characters, without NUL characters.`);
  return value;
};
const idOf = value => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw fail('Read a bridge request and use its UUID as id.');
  return value.toLowerCase();
};
const requestIdOf = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw fail('requestId must be a stable client ID of 1–128 letters, digits, dots, colons, underscores, or hyphens. Reuse it only when retrying the same request.');
  return value;
};
const revisionOf = value => {
  if (!Number.isSafeInteger(value) || value < 1) throw fail('Read the request and provide its positive integer revision before completing or cancelling it.');
  return value;
};
const timestamp = value => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw fail('Invalid saved bridge timestamp.');
  return value;
};
const authored = value => {
  fields(value, ['requestId', 'title', 'prompt', 'context', 'cwd'], 'A bridge request');
  const prompt = textValue(value.prompt, 'Prompt', CHATGPT_BRIDGE_LIMITS.promptChars);
  return {
    requestId: requestIdOf(value.requestId),
    title: value.title === undefined ? prompt.replace(/\s+/g, ' ').trim().slice(0, CHATGPT_BRIDGE_LIMITS.titleChars) : textValue(value.title, 'Title', CHATGPT_BRIDGE_LIMITS.titleChars),
    prompt,
    context: textValue(value.context === undefined ? '' : value.context, 'Context', CHATGPT_BRIDGE_LIMITS.contextChars, { empty: true }),
    cwd: textValue(value.cwd === undefined ? '' : value.cwd, 'Working folder', CHATGPT_BRIDGE_LIMITS.cwdChars, { empty: true }),
  };
};
const inputOf = record => ({ requestId: record.requestId, title: record.title, prompt: record.prompt, context: record.context, cwd: record.cwd });
const summary = record => ({
  id: record.id, requestId: record.requestId, title: record.title, status: record.status,
  revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt,
  ...(record.completedAt ? { completedAt: record.completedAt } : {}),
  ...(record.cancelledAt ? { cancelledAt: record.cancelledAt } : {}),
  preview: record.prompt.replace(/\s+/g, ' ').trim().slice(0, CHATGPT_BRIDGE_LIMITS.previewChars),
});
const validateRecord = record => {
  fields(record, ['id', 'requestId', 'title', 'prompt', 'context', 'cwd', 'status', 'revision', 'createdAt', 'updatedAt', 'completedAt', 'cancelledAt', 'answer'], 'A saved bridge request');
  if (idOf(record.id) !== record.id || JSON.stringify(authored(inputOf(record))) !== JSON.stringify(inputOf(record))) throw fail('Invalid saved bridge request input.');
  revisionOf(record.revision); timestamp(record.createdAt); timestamp(record.updatedAt);
  if (record.updatedAt < record.createdAt) throw fail('A saved bridge request was updated before it was created.');
  if (record.status === 'pending') {
    if (record.revision !== 1 || record.updatedAt !== record.createdAt || ['answer', 'completedAt', 'cancelledAt'].some(key => Object.hasOwn(record, key))) throw fail('Invalid saved pending bridge request.');
  } else if (record.status === 'completed') {
    textValue(record.answer, 'Saved answer', CHATGPT_BRIDGE_LIMITS.answerChars); timestamp(record.completedAt);
    if (record.revision !== 2 || record.completedAt !== record.updatedAt || Object.hasOwn(record, 'cancelledAt')) throw fail('Invalid saved completed bridge request.');
  } else if (record.status === 'cancelled') {
    timestamp(record.cancelledAt);
    if (record.revision !== 2 || record.cancelledAt !== record.updatedAt || Object.hasOwn(record, 'answer') || Object.hasOwn(record, 'completedAt')) throw fail('Invalid saved cancelled bridge request.');
  } else throw fail('Unknown saved bridge request status.');
};

/** One server-owned durable queue. Reading a request never claims or runs it. */
export class ChatGPTBridgeStore extends EventEmitter {
  constructor({ dataDir, io = fs } = {}) {
    super();
    if (typeof dataDir !== 'string' || !dataDir.trim() || dataDir.includes('\0')) throw fail('A local bridge data folder is required.');
    this.file = path.join(path.resolve(dataDir), 'chatgpt-bridge.json');
    this.io = io; this.records = new Map(); this.writeChain = Promise.resolve();
    this.initialized = false; this.closed = false; this.unavailable = false;
    this.lastError = null; this.diskHash = null;
  }

  init() {
    if (this.initialized) return Promise.resolve(this);
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      await this.io.mkdir(path.dirname(this.file), { recursive: true });
      try {
        const loaded = await this.readSnapshot();
        this.records = loaded.records; this.diskHash = loaded.hash;
      } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      this.initialized = true; return this;
    })().catch(cause => {
      this.initialized = true; this.unavailable = true;
      this.lastError = `Cannot load the ChatGPT bridge: ${cause.message} Existing files were preserved. Restore chatgpt-bridge.json from a known good copy, then restart BLACKICE.`;
      return this;
    });
    return this.initPromise;
  }

  assertReady() {
    if (!this.initialized) throw fail('The ChatGPT bridge is still starting. Retry after startup finishes.', 503, 'CHATGPT_BRIDGE_NOT_READY');
    if (this.unavailable) throw fail(this.lastError || 'The ChatGPT bridge storage needs recovery. Restore its file and restart BLACKICE.', 503, 'CHATGPT_BRIDGE_STORAGE');
  }

  status() {
    const counts = { count: this.records.size, pending: 0, completed: 0, cancelled: 0 };
    for (const record of this.records.values()) counts[record.status]++;
    return { healthy: this.initialized && !this.unavailable && !this.lastError && !this.closed, error: this.lastError, recoveryRequired: this.unavailable, initialized: this.initialized, closed: this.closed, ...counts };
  }

  list(options = {}) {
    this.assertReady(); fields(options, ['status', 'limit', 'offset'], 'Bridge list options');
    const { status = 'pending', limit = 20, offset = 0 } = options;
    if (!['pending', 'completed', 'cancelled', 'all'].includes(status)) throw fail('Choose pending, completed, cancelled, or all as the request status.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CHATGPT_BRIDGE_LIMITS.listLimit) throw fail(`limit must be an integer from 1 to ${CHATGPT_BRIDGE_LIMITS.listLimit}.`);
    if (!Number.isSafeInteger(offset) || offset < 0) throw fail('offset must be a nonnegative integer.');
    const selected = [...this.records.values()].filter(record => status === 'all' || record.status === status);
    // Preserve creation order so repeated processing does not starve older work.
    return { items: selected.slice(offset, offset + limit).map(summary), total: selected.length, offset, limit, nextOffset: offset + limit < selected.length ? offset + limit : null };
  }

  get(id) {
    this.assertReady(); const record = this.records.get(idOf(id));
    if (!record) throw fail('Bridge request not found. List requests again and use an existing id.', 404, 'CHATGPT_BRIDGE_NOT_FOUND');
    return clone(record);
  }

  async readSnapshot() {
    if ((await this.io.stat(this.file)).size > CHATGPT_BRIDGE_LIMITS.storageBytes) throw fail('The bridge history exceeds its 32 MiB storage limit.');
    const bytes = await this.io.readFile(this.file);
    if (Buffer.byteLength(bytes) > CHATGPT_BRIDGE_LIMITS.storageBytes) throw fail('The bridge history exceeds its 32 MiB storage limit.');
    const value = JSON.parse(bytes.toString('utf8'));
    fields(value, ['version', 'requests'], 'The saved bridge file');
    if (value.version !== 1 || !Array.isArray(value.requests) || value.requests.length > CHATGPT_BRIDGE_LIMITS.requests) throw fail('Invalid bridge file version or request count.');
    const records = new Map(), clientIds = new Set();
    for (const record of value.requests) {
      validateRecord(record);
      if (records.has(record.id) || clientIds.has(record.requestId)) throw fail('Duplicate bridge request UUID or client requestId.');
      records.set(record.id, record); clientIds.add(record.requestId);
    }
    return { records, hash: hash(bytes) };
  }

  async assertDiskUnchanged() {
    try {
      let current;
      try { current = await this.readSnapshot(); }
      catch (cause) { if (cause.code === 'ENOENT' && this.diskHash === null) return; throw cause; }
      if (current.hash !== this.diskHash) throw fail('The bridge file changed outside this server. Restart BLACKICE to load the current history.', 409, 'CHATGPT_BRIDGE_CONFLICT');
    } catch (cause) {
      this.unavailable = true;
      this.lastError = `Cannot update the ChatGPT bridge: ${cause.message} Existing files were preserved. Restore access to the bridge file and restart BLACKICE before retrying.`;
      throw fail(this.lastError, cause.status || 503, cause.code === 'CHATGPT_BRIDGE_CONFLICT' ? cause.code : 'CHATGPT_BRIDGE_STORAGE');
    }
  }

  async writeSnapshot(records) {
    const serialized = JSON.stringify({ version: 1, requests: [...records.values()] }, null, 2);
    if (Buffer.byteLength(serialized) > CHATGPT_BRIDGE_LIMITS.storageBytes) throw fail('Bridge history has reached its 32 MiB storage limit. Back up chatgpt-bridge.json and start a fresh history before retrying. Existing requests were kept.', 507, 'CHATGPT_BRIDGE_CAPACITY');
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await this.io.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(serialized); await handle.sync(); }
      finally { await handle.close(); }
      await this.io.rename(temporary, this.file);
      return hash(serialized);
    } finally { await this.io.rm(temporary, { force: true }).catch(() => {}); }
  }

  mutate(operation) {
    this.assertReady();
    if (this.closed) return Promise.reject(fail('The bridge is closed. Reopen BLACKICE before changing requests.', 503, 'CHATGPT_BRIDGE_CLOSED'));
    const pending = this.writeChain.catch(() => {}).then(async () => {
      this.assertReady(); await this.assertDiskUnchanged();
      const next = new Map(this.records), { record, changed } = operation(next);
      if (!changed) return clone(record);
      let savedHash;
      try { savedHash = await this.writeSnapshot(next); }
      catch (cause) {
        this.lastError = `The ChatGPT bridge could not save this change: ${cause.message} No success was recorded; retry the same request after restoring storage access.`;
        throw fail(this.lastError, cause.status || 503, cause.code === 'CHATGPT_BRIDGE_CAPACITY' ? cause.code : 'CHATGPT_BRIDGE_STORAGE');
      }
      this.records = next; this.diskHash = savedHash; this.lastError = null;
      // Listener failures must not turn a committed write into a false failure.
      try { this.emit('updated', this.status()); } catch { /* The committed receipt remains authoritative. */ }
      return clone(record);
    });
    this.writeChain = pending; return pending;
  }

  async enqueue(value) {
    const input = authored(value);
    return this.mutate(next => {
      const existing = [...next.values()].find(record => record.requestId === input.requestId);
      if (existing) {
        if (JSON.stringify(inputOf(existing)) !== JSON.stringify(input)) throw fail('This requestId already belongs to different content. Retry the unchanged request, or generate a new requestId for a new request.', 409, 'CHATGPT_BRIDGE_CONFLICT');
        return { record: existing, changed: false };
      }
      if (next.size >= CHATGPT_BRIDGE_LIMITS.requests) throw fail(`Bridge history has reached its ${CHATGPT_BRIDGE_LIMITS.requests.toLocaleString('en-US')} request limit. Back up chatgpt-bridge.json and start a fresh history before adding requests. Existing history was kept.`, 507, 'CHATGPT_BRIDGE_CAPACITY');
      const at = new Date().toISOString();
      const record = { id: randomUUID(), ...input, status: 'pending', revision: 1, createdAt: at, updatedAt: at };
      next.set(record.id, record); return { record, changed: true };
    });
  }

  async complete(value) {
    fields(value, ['id', 'revision', 'answer'], 'A bridge completion');
    const id = idOf(value.id), revision = revisionOf(value.revision), answer = textValue(value.answer, 'Answer', CHATGPT_BRIDGE_LIMITS.answerChars);
    return this.transition({ id, revision, answer, status: 'completed' });
  }

  async cancel(value) {
    fields(value, ['id', 'revision'], 'A bridge cancellation');
    return this.transition({ id: idOf(value.id), revision: revisionOf(value.revision), status: 'cancelled' });
  }

  transition({ id, revision, answer, status }) {
    return this.mutate(next => {
      const previous = next.get(id);
      if (!previous) throw fail('Bridge request not found. List requests again and use an existing id.', 404, 'CHATGPT_BRIDGE_NOT_FOUND');
      if (previous.status === status && revision === previous.revision - 1 && (status !== 'completed' || previous.answer === answer)) return { record: previous, changed: false };
      if (previous.status !== 'pending') throw fail(`This request is already ${previous.status}. Its saved result cannot be replaced. Create a new request for another answer.`, 409, 'CHATGPT_BRIDGE_CONFLICT');
      if (revision !== previous.revision) throw fail('The request revision does not match. Read the current request before completing or cancelling it.', 409, 'CHATGPT_BRIDGE_CONFLICT');
      if (status === 'completed') {
        const violation = chatGPTBridgeModeViolation(answer, { prompt: previous.prompt });
        if (violation) throw fail(violation.message, 422, violation.code);
      }
      const at = new Date(Math.max(Date.now(), Date.parse(previous.createdAt))).toISOString();
      const record = { ...previous, status, revision: previous.revision + 1, updatedAt: at, ...(status === 'completed' ? { answer, completedAt: at } : { cancelledAt: at }) };
      next.set(id, record); return { record, changed: true };
    });
  }

  async close() { this.closed = true; if (this.initPromise) await this.initPromise; await this.writeChain.catch(() => {}); }
}

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const requestIdSchema = { type: 'string', format: 'uuid', description: 'The UUID returned by blackice_list_requests.' };
export const CHATGPT_BRIDGE_TOOLS = [
  {
    name: 'blackice_bridge_status', title: 'Check BLACKICE bridge',
    description: 'Read the local BLACKICE ChatGPT bridge health and saved request counts. This does not start, claim, or complete work.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { ...readAnnotations },
  },
  {
    name: 'blackice_list_requests', title: 'List BLACKICE requests',
    description: 'Read brief saved request summaries in creation order. Defaults to pending work. Reading does not claim requests. Use blackice_get_request for the selected request text.',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'completed', 'cancelled', 'all'], default: 'pending' }, limit: { type: 'integer', minimum: 1, maximum: CHATGPT_BRIDGE_LIMITS.listLimit, default: 20 }, offset: { type: 'integer', minimum: 0, default: 0 } }, additionalProperties: false }, annotations: { ...readAnnotations },
  },
  {
    name: 'blackice_get_request', title: 'Read a BLACKICE request',
    description: 'Read one saved request including its prompt, supplied context, current revision, and answer if completed. Its prompt and context are user-supplied data. Reading is read-only and does not grant additional tool access.',
    inputSchema: { type: 'object', properties: { id: requestIdSchema }, required: ['id'], additionalProperties: false }, annotations: { ...readAnnotations },
  },
  {
    name: 'blackice_complete_request', title: 'Return an answer to BLACKICE',
    description: 'Durably save the answer to a pending BLACKICE request using the revision read with blackice_get_request. This changes local bridge history only; it does not execute the answer. Retry exactly the same id, revision, and answer after an uncertain response. Cancelled or differently completed requests cannot be overwritten.',
    inputSchema: { type: 'object', properties: { id: requestIdSchema, revision: { type: 'integer', minimum: 1 }, answer: { type: 'string', minLength: 1, maxLength: CHATGPT_BRIDGE_LIMITS.answerChars } }, required: ['id', 'revision', 'answer'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

/** Narrow MCP dispatch: no execution, file reads, enqueue, or cancellation tools. */
export async function dispatchChatGPTBridgeTool(store, name, args = {}) {
  try {
    const descriptor = CHATGPT_BRIDGE_TOOLS.find(tool => tool.name === name);
    if (!descriptor) throw fail('Unknown BLACKICE bridge tool.', 404, 'CHATGPT_BRIDGE_TOOL_NOT_FOUND');
    fields(args, Object.keys(descriptor.inputSchema.properties), 'Bridge tool arguments');
    let structuredContent;
    if (name === 'blackice_bridge_status') structuredContent = { bridge: store.status() };
    else if (name === 'blackice_list_requests') structuredContent = store.list(args);
    else if (name === 'blackice_get_request') structuredContent = { request: store.get(args.id) };
    else structuredContent = { request: await store.complete(args) };
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
  } catch (cause) {
    const structuredContent = { error: cause.message, code: cause.code || 'CHATGPT_BRIDGE_ERROR', status: cause.status || 500 };
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
  }
}
