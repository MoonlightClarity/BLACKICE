import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_ID = /^[A-Za-z0-9_-]{1,80}$/;
const DEFAULT_THRESHOLD_BYTES = 12000;
const DEFAULT_PAGE_BYTES = 4096;
const MAX_PAGE_BYTES = 8192;
const PAGEABLE = new Set(['relay_workspace', 'relay_find_files', 'relay_browser', 'relay_history', 'relay_agents', 'relay_files', 'relay_directory_action']);
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
const digestFor = (taskId, toolName, contents) => createHash('sha256').update(taskId).update('\0').update(toolName).update('\0').update(contents).digest('hex');
const referenceFor = digest => [digest.slice(0,8),digest.slice(8,12),digest.slice(12,16),digest.slice(16,20),digest.slice(20,32)].join('-');

/** Keep the original host result unchanged until the complete text is durably stored. */
export const EXTERNAL_CONTEXT_TOOL = Object.freeze({
  type: 'function',
  name: 'relay_context_page',
  description: 'Read task-owned text from a previous large tool result. To find exact text, call search with reference and needle, then read using the match offset. Read does not accept needle. A sourceContinuation cursor refers to source bytes beyond the archived returned page, not a search of that archive. This only reads the current task.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { type: 'string', enum: ['read', 'list', 'search'] },
      reference: { type: 'string', description: 'Exact reference returned by an externalized tool result.' },
      offset: { type: 'integer', minimum: 0, description: 'UTF-8 byte offset from a previous page nextOffset; zero starts from the beginning.' },
      maxBytes: { type: 'integer', minimum: 512, maximum: MAX_PAGE_BYTES },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
      needle: { type: 'string', minLength: 1, maxLength: 200, description: 'For action search only: exact text to locate. Do not add needle to a read call.' },
      startOffset: { type: 'integer', minimum: 0, description: 'UTF-8 byte position to resume a bounded search.' },
    },
  },
});

export const EXTERNAL_CONTEXT_INSTRUCTIONS =
  'Large read-only tool outputs may be replaced with EXTERNAL CONTEXT RECORD references. ' +
  'These references retain the returned tool text outside the model context for this task. ' +
  'For an exact target phrase or diagnosis, FIRST use relay_context_page search with reference and needle to find its byte offset in the archived returned text. Then read with reference and offset to inspect the original passage. Never pass needle to a read call. ' +
  'A preview is not complete evidence; retrieve relevant archived pages. If the complete archive search has no match and sourceContinuation is present, continue the original relay_workspace read from that next source line: the archive only stores returned text, not omitted source bytes. ' +
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
    this.pendingSaves = new Map();
  }

  file(reference, extension) {
    if (!ID.test(reference || '')) throw error('Invalid external context reference.');
    return path.join(this.root, reference + extension);
  }

  async save(text, toolName) {
    const digest=digestFor(this.taskId,toolName,text),reference=referenceFor(digest);
    const inFlight=this.pendingSaves.get(reference);
    if(inFlight)return inFlight;
    const work=this.saveUnique({text,toolName,digest,reference});
    this.pendingSaves.set(reference,work);
    try{return await work;}
    finally{if(this.pendingSaves.get(reference)===work)this.pendingSaves.delete(reference);}
  }

  async saveUnique({text,toolName,digest,reference}) {
    const contentPath=this.file(reference,'.txt'),metadataPath=this.file(reference,'.json');
    const bytes=Buffer.byteLength(text,'utf8');
    await fs.mkdir(this.root,{recursive:true});
    const reuse=async()=>{
      const saved=await this.metadata(reference);
      if(saved.sha256!==digest||saved.bytes!==bytes||saved.tool!==toolName)
        throw error('Content-addressed context metadata does not match the original result.','CONTEXT_ARCHIVE_CORRUPT');
      const existing=await fs.readFile(contentPath,'utf8');
      if(existing!==text)throw error('Content-addressed context text has changed.','CONTEXT_ARCHIVE_CORRUPT');
      return{reference,bytes};
    };
    try{return await reuse();}
    catch(cause){if(cause.code!=='CONTEXT_ARCHIVE_NOT_FOUND')throw cause;}
    let created=false;
    try{
      try{
        await fs.writeFile(contentPath,text,{encoding:'utf8',flag:'wx'});
        created=true;
      }catch(cause){
        if(cause.code!=='EEXIST')throw cause;
        // Another writer may have published the content but not the metadata yet.
        // Never replace it, assume success, or delete another writer's file.
        for(let attempt=0;attempt<15;attempt++){
          try{return await reuse();}
          catch(error){if(error.code!=='CONTEXT_ARCHIVE_NOT_FOUND')throw error;}
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        throw error('Concurrent context archive did not settle; retain the full tool result.','CONTEXT_ARCHIVE_UNAVAILABLE');
      }
      await fs.writeFile(metadataPath,JSON.stringify({
        version:1,taskId:this.taskId,reference,tool:toolName,bytes,
        sha256:digest,createdAt:new Date().toISOString(),
      }),{encoding:'utf8',flag:'wx'});
      return{reference,bytes};
    }catch(cause){
      if(created)await Promise.allSettled([fs.rm(contentPath,{force:true}),fs.rm(metadataPath,{force:true})]);
      throw cause;
    }
  }

  async archiveResult(call, result) {
    if (result?.success !== true || !eligibleExternalContextCall(call) || !Array.isArray(result?.contentItems)) return result;
    const items = [...result.contentItems];
    let changed = false;
    try {
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (item?.type !== 'inputText' || typeof item.text !== 'string') continue;
        const bytes = Buffer.byteLength(item.text, 'utf8');
        if (bytes <= this.thresholdBytes) continue;
        const saved = await this.save(item.text, call.name);
        const preview = externalResultPreview(item.text);
        const sourceContinuation=call.name==='relay_workspace'&&preview.truncated===true&&typeof preview.path==='string'&&Number.isInteger(preview.nextStartLine)&&preview.nextStartLine>0
          ? {tool:'relay_workspace',action:'read',path:preview.path,startLine:preview.nextStartLine}
          : null;
        items[index] = { ...item, text: JSON.stringify({
          externalContext: true, reference: saved.reference, bytes: saved.bytes,
          tool: call.name, contentIndex: index, preview,
          ...(sourceContinuation?{sourceContinuation}:{}),
          nextAction: sourceContinuation?'The original workspace result was truncated, but the archived returned page may still contain the desired middle evidence. FIRST use relay_context_page search with reference and needle, then read at its match offset. Only when a complete archive search finds no match use sourceContinuation to read later source lines. Do not mistake continuation for searching the archive.':'For exact target text, FIRST use relay_context_page search with reference and needle, then read at the returned offset. Use sequential read/nextOffset when no target phrase is known.',
        }) };
        changed = true;
      }
    } catch {
      // Do not discard evidence or remove a shared, already-published archive.
      // A failed archive keeps the complete original tool response.
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
        !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0 ||
        metadata.sha256!==undefined&&!/^[a-f0-9]{64}$/.test(metadata.sha256)) throw error('Saved context metadata is invalid.', 'CONTEXT_ARCHIVE_CORRUPT');
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
      if(metadata.sha256){const source=await fs.readFile(this.file(reference,'.txt'),'utf8');
        if(digestFor(this.taskId,metadata.tool,source)!==metadata.sha256)throw error('Stored context text no longer matches its durable receipt.','CONTEXT_ARCHIVE_CORRUPT');}
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
      if (!args || typeof args !== 'object' || Array.isArray(args))
        throw error('Supply context action arguments as an object.');
      const permitted = {
        read: ['action','reference','offset','maxBytes'],
        search: ['action','reference','needle','startOffset','limit'],
        list: ['action','limit'],
      }[args.action];
      if (!permitted) throw error('Choose context action read, search or list.');
      const ignored = Object.keys(args).filter(name => !permitted.includes(name));
      if (ignored.length) {
        const help = args.action === 'read' && ignored.includes('needle')
          ? 'Use action "search" with reference and needle, then action "read" with reference and returned match offset.'
          : args.action === 'search' && ignored.includes('offset')
            ? 'Use startOffset to resume a search. Use offset only for read.'
            : 'Send only fields used by the selected action.';
        throw error('Context action '+args.action+' does not accept '+ignored.join(', ')+'. '+help);
      }
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
