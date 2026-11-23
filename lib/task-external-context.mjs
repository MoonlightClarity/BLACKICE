import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_ID = /^[A-Za-z0-9_-]{1,80}$/;
const DEFAULT_THRESHOLD_BYTES = 12000;
const DEFAULT_PAGE_BYTES = 4096;
const MAX_PAGE_BYTES = 8192;
const PAGEABLE = new Set(['relay_workspace', 'relay_find_files', 'relay_browser', 'relay_history', 'relay_agents', 'relay_files']);
const READ_ACTIONS = new Set(['read', 'search', 'find', 'list', 'snapshot', 'tabs', 'get', 'patch_history']);
const VIEW_FIELDS = ['path', 'cwd', 'startLine', 'endLine', 'nextStartLine', 'nextPage', 'truncated', 'exitCode', 'timedOut', 'query', 'matchMode'];
const firstChars = (value, length) => Array.from(value).slice(0, length).join('');
const lastChars = (value, length) => Array.from(value).slice(-length).join('');
/** Preview *content*, not the escaped JSON wrapper; logs often put the diagnosis last. */
export function externalResultPreview(text) {
  let payload;
  try { payload = JSON.parse(text); } catch {}
  const obj = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  const key = obj && ['content', 'stdout', 'stderr', 'text', 'preview'].find(field => typeof obj[field] === 'string' && obj[field].length > 500);
  const source = key ? obj[key] : text;
  const size = Array.from(source).length;
  const head = firstChars(source, 280), tail = size > 400 ? lastChars(source, 480) : '';
  const metadata = obj ? Object.fromEntries(VIEW_FIELDS.filter(field => obj[field] !== undefined).map(field => [field, typeof obj[field] === 'string' ? obj[field].slice(0, 200) : obj[field]])) : {};
  return { ...(key ? {contentField: key} : {}), ...metadata,
    head, ...(tail ? {tail} : {}), omittedMiddle: Math.max(0, size - (tail ? 760 : 280)),
    warning: 'Head and tail are previews, not complete evidence. Retrieve original pages for precise claims.' };
}
const error = (message, code = 'CONTEXT_ARCHIVE_INVALID') => Object.assign(new Error(message), { code });
const output = value => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });

/** Keep the original host result unchanged until the complete text is durably stored. */
export const EXTERNAL_CONTEXT_TOOL = Object.freeze({
  type: 'function',
  name: 'relay_context_page',
  description: 'Read task-owned text from a previous large tool result. The external result is intact on disk; inspect a page by reference and byte offset, or list recent references. This only reads the current task.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { type: 'string', enum: ['read', 'list', 'search'] },
      reference: { type: 'string', description: 'Exact reference returned by an externalized tool result.' },
      offset: { type: 'integer', minimum: 0, description: 'UTF-8 byte offset from a previous page nextOffset; zero starts from the beginning.' },
      maxBytes: { type: 'integer', minimum: 512, maximum: MAX_PAGE_BYTES },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
      needle: { type: 'string', minLength: 1, maxLength: 200, description: 'Exact text to locate in one saved result.' },
      startOffset: { type: 'integer', minimum: 0, description: 'UTF-8 byte position to resume a bounded search.' },
    },
  },
});

export const EXTERNAL_CONTEXT_INSTRUCTIONS =
  'Large read-only tool outputs may be replaced with EXTERNAL CONTEXT RECORD references. ' +
  'These references retain the returned tool text outside the model context for this task. ' +
  'Use relay_context_page read with the exact reference and nextOffset to recover text, ' +
  'search with a literal needle to find byte offsets, or list recent references. ' +
  'A preview is not complete evidence; retrieve the relevant pages. ' +
  'UTF-8 offsets are bytes. Host Directory receipts and task state are unchanged by paging.';

export function eligibleExternalContextCall(call) {
  if (!call || call.namespace || !PAGEABLE.has(call.name)) return false;
  let args = call.arguments ?? call.input ?? {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return false; }
  }
  return args && typeof args === 'object' && (READ_ACTIONS.has(args.action) ||
    (call.name === 'relay_find_files' && typeof args.query === 'string' && args.query.trim().length > 0));
}

function integer(value, fallback, lower, upper) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < lower || value > upper) throw error('Invalid context page limit or offset.');
  return value;
}

export class TaskExternalContextStore {
  constructor({ dataDir, taskId, thresholdBytes = DEFAULT_THRESHOLD_BYTES } = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || !TASK_ID.test(taskId || '')) throw error('A task identity and absolute data directory are required.');
    if (!Number.isSafeInteger(thresholdBytes) || thresholdBytes < 1) throw error('Invalid external context threshold.');
    this.root = path.join(dataDir, 'task-external-context', taskId);
    this.taskId = taskId;
    this.thresholdBytes = thresholdBytes;
  }

  file(reference, extension) {
    if (!ID.test(reference || '')) throw error('Invalid external context reference.');
    return path.join(this.root, reference + extension);
  }

  async save(text, toolName) {
    const reference = randomUUID();
    const contentPath = this.file(reference, '.txt');
    const metadataPath = this.file(reference, '.json');
    const bytes = Buffer.byteLength(text, 'utf8');
    await fs.mkdir(this.root, { recursive: true });
    try {
      await fs.writeFile(contentPath, text, { encoding: 'utf8', flag: 'wx' });
      await fs.writeFile(metadataPath, JSON.stringify({
        version: 1, taskId: this.taskId, reference, tool: toolName,
        bytes, createdAt: new Date().toISOString(),
      }), { encoding: 'utf8', flag: 'wx' });
    } catch (cause) {
      await Promise.allSettled([fs.rm(contentPath, { force: true }), fs.rm(metadataPath, { force: true })]);
      throw cause;
    }
    return { reference, bytes };
  }

  async archiveResult(call, result) {
    if (result?.success !== true || !eligibleExternalContextCall(call) || !Array.isArray(result?.contentItems)) return result;
    const items = [...result.contentItems];
    const created = [];
    let changed = false;
    try {
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (item?.type !== 'inputText' || typeof item.text !== 'string') continue;
        const bytes = Buffer.byteLength(item.text, 'utf8');
        if (bytes <= this.thresholdBytes) continue;
        const saved = await this.save(item.text, call.name);
        created.push(saved.reference);
        const preview = externalResultPreview(item.text);
        items[index] = { ...item, text: JSON.stringify({
          externalContext: true, reference: saved.reference, bytes: saved.bytes,
          tool: call.name, contentIndex: index, preview,
          nextAction: 'Use relay_context_page search for a literal term, or read with reference and byte offset to recover the original full tool text.',
        }) };
        changed = true;
      }
    } catch {
      // Do not silently discard a returned result when disk storage fails.
      await Promise.allSettled(created.flatMap(ref => [fs.rm(this.file(ref, '.txt'), { force: true }), fs.rm(this.file(ref, '.json'), { force: true })]));
      return result;
    }
    return changed ? { ...result, contentItems: items } : result;
  }

  async metadata(reference) {
    const metadataPath = this.file(reference, '.json');
    let metadata;
    try { metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')); }
    catch (cause) {
      if (cause.code === 'ENOENT') throw error('Context reference is absent from this task.', 'CONTEXT_ARCHIVE_NOT_FOUND');
      throw error('Could not read the saved context metadata.', 'CONTEXT_ARCHIVE_UNAVAILABLE');
    }
    if (metadata?.version !== 1 || metadata.taskId !== this.taskId || metadata.reference !== reference ||
        !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0) throw error('Saved context metadata is invalid.', 'CONTEXT_ARCHIVE_CORRUPT');
    return metadata;
  }

  async read({ reference, offset = 0, maxBytes = DEFAULT_PAGE_BYTES } = {}) {
    const metadata = await this.metadata(reference);
    const start = integer(offset, 0, 0, metadata.bytes);
    const requested = integer(maxBytes, DEFAULT_PAGE_BYTES, 512, MAX_PAGE_BYTES);
    const handle = await fs.open(this.file(reference, '.txt'), 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== metadata.bytes) throw error('Stored text changed since it was saved.', 'CONTEXT_ARCHIVE_CORRUPT');
      const capacity = Math.min(requested + 4, stat.size - start);
      const buffer = Buffer.alloc(capacity);
      const { bytesRead } = await handle.read(buffer, 0, capacity, start);
      if (bytesRead && (buffer[0] & 0xc0) === 0x80) throw error('Offset splits a UTF-8 character. Use the prior page nextOffset.');
      let length = Math.min(requested, bytesRead), text = '';
      if (length) {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        while (length) {
          try { text = decoder.decode(buffer.subarray(0, length)); break; }
          catch { length--; }
        }
        if (!length) throw error('Unable to decode the saved context page.', 'CONTEXT_ARCHIVE_CORRUPT');
      }
      const nextOffset = start + length;
      return {
        reference, tool: metadata.tool, bytes: metadata.bytes, offset: start, nextOffset,
        complete: nextOffset === metadata.bytes, text,
      };
    } finally { await handle.close(); }
  }

  async search({ reference, needle, startOffset = 0, limit = 8 } = {}) {
    const metadata = await this.metadata(reference);
    if (typeof needle !== 'string' || !needle.length || needle.length > 200) throw error('Supply a short, nonempty literal search needle.');
    const pattern = Buffer.from(needle, 'utf8');
    const from = integer(startOffset, 0, 0, metadata.bytes);
    const wanted = integer(limit, 8, 1, 20);
    const handle = await fs.open(this.file(reference, '.txt'), 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== metadata.bytes) throw error('Stored text changed since it was saved.', 'CONTEXT_ARCHIVE_CORRUPT');
      const scanBudget = 8 * 1024 * 1024;
      let position = from, scanned = 0, tail = Buffer.alloc(0);
      const matches = [];
      while (position < metadata.bytes && scanned < scanBudget && matches.length < wanted) {
        const count = Math.min(64 * 1024, metadata.bytes - position, scanBudget - scanned);
        const bytes = Buffer.alloc(count);
        const { bytesRead } = await handle.read(bytes, 0, count, position);
        if (!bytesRead) break;
        const combined = Buffer.concat([tail, bytes.subarray(0, bytesRead)]);
        const base = position - tail.length;
        for (let index = 0; matches.length < wanted;) {
          const found = combined.indexOf(pattern, index);
          if (found === -1) break;
          if (base + found >= from) matches.push({ offset: base + found });
          index = found + 1;
        }
        position += bytesRead;
        scanned += bytesRead;
        tail = combined.subarray(Math.max(0, combined.length - pattern.length + 1));
      }
      const complete = position >= metadata.bytes && matches.length < wanted;
      const nextScanOffset = complete ? null : matches.length === wanted
        ? matches.at(-1).offset + 1
        : Math.max(from, position - pattern.length + 1);
      return { reference, bytes: metadata.bytes, needle, startOffset: from,
        matches, scannedBytes: scanned, nextScanOffset, complete };
    } finally { await handle.close(); }
  }

  async list({ limit = 10 } = {}) {
    const count = integer(limit, 10, 1, 20);
    let files;
    try { files = (await fs.readdir(this.root)).filter(name => ID.test(name.slice(0, -5)) && name.endsWith('.json')); }
    catch (cause) {
      if (cause.code === 'ENOENT') return { taskId: this.taskId, items: [] };
      throw cause;
    }
    const rows = await Promise.all(files.map(async name => {
      try { return await this.metadata(name.slice(0, -5)); } catch { return null; }
    }));
    return { taskId: this.taskId, items: rows.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, count) };
  }

  async handle(call) {
    let args = call?.arguments ?? call?.input ?? {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { return { success: false, code: 'CONTEXT_ARCHIVE_INVALID', contentItems: [{ type: 'inputText', text: 'Invalid context tool arguments.' }] }; }
    }
    try {
      if (args.action === 'read') return output(await this.read(args));
      if (args.action === 'list') return output(await this.list(args));
      if (args.action === 'search') return output(await this.search(args));
      throw error('Choose context action read, search or list.');
    } catch (cause) {
      return { success: false, code: cause.code || 'CONTEXT_ARCHIVE_UNAVAILABLE',
        contentItems: [{ type: 'inputText', text: String(cause.message || 'Context read failed.') }] };
    }
  }
}
