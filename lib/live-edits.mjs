import { promises as fs, watch } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { safeSvgPreview, SVG_PREVIEW_LIMIT } from '../public/svg-preview.mjs';

export const LIVE_EDIT_LIMITS = Object.freeze({ files: 6000, fileBytes: 192 * 1024, baselineBytes: 12 * 1024 * 1024, events: 512, journalBytes: 5 * 1024 * 1024, diffLines: 500, diffChars: 40000 });
const IGNORED = new Set(['.git', 'node_modules', '.next', '.cache', '.venv', 'venv', '__pycache__', 'coverage', '$recycle.bin', 'system volume information']);
const stamp = () => new Date().toISOString();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = value => structuredClone(value);
const fail = message => Object.assign(new Error(message), { status: 400, code: 'INVALID_OBSERVE_PRESENTATION' });
const check = signal => { if (signal?.aborted) throw Object.assign(new Error('Live observation cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' }); };
const identifier = value => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(value)) throw new Error('Use a valid run identifier.'); return value; };
const relative = value => {
  if (typeof value !== 'string' || !value || value.length > 1000 || /[\0-\x1f]/.test(value) || path.isAbsolute(value) || /^[a-z]:/i.test(value)) throw fail('Use a relative workspace file path.');
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))) throw fail('Use a relative workspace file path without parent traversal.');
  return parts.join('/');
};
const inside = (root, file) => { const rel = path.relative(root, file); return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`); };
const sensitive = value => /(^|\/)(\.env(?:\..*)?|credentials(?:\.json)?|id_(?:rsa|ed25519))$/i.test(value) || /\.(?:pem|p12|pfx|key)$/i.test(value);

/** Presentation can choose the view, never supply evidence or mark work completed. */
export const OBSERVE_PRESENTATION_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, properties: { version: { const: 1 }, title: { type: 'string', maxLength: 100 }, focus: { enum: ['auto', 'edits', 'activity'] }, file: { type: 'string', maxLength: 1000, description: 'Relative workspace path to focus; only observed edits may be displayed.' }, stepIds: { type: 'array', maxItems: 12, uniqueItems: true, items: { type: 'string', maxLength: 120 } }, showAgents: { type: 'boolean' } } });
export function validateObservePresentation(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Observe presentation must be a JSON object.');
  const allowed = new Set(Object.keys(OBSERVE_PRESENTATION_SCHEMA.properties));
  if (Object.keys(value).some(key => !allowed.has(key))) throw fail('Observe presentation contains an unsupported field.');
  if (value.version !== undefined && value.version !== 1) throw fail('Observe presentation version must be 1.');
  const result = { version: 1, focus: 'auto', showAgents: true };
  if (value.title !== undefined) { if (typeof value.title !== 'string' || value.title.length > 100 || /[\0-\x1f]/.test(value.title)) throw fail('Observe title must be at most 100 characters.'); result.title = value.title.trim(); }
  if (value.focus !== undefined) { if (!['auto', 'edits', 'activity'].includes(value.focus)) throw fail('Observe focus must be auto, edits or activity.'); result.focus = value.focus; }
  if (value.file !== undefined) result.file = relative(value.file);
  if (value.showAgents !== undefined) { if (typeof value.showAgents !== 'boolean') throw fail('showAgents must be a boolean.'); result.showAgents = value.showAgents; }
  if (value.stepIds !== undefined) { if (!Array.isArray(value.stepIds) || value.stepIds.length > 12 || value.stepIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(id)) || new Set(value.stepIds).size !== value.stepIds.length) throw fail('Use at most 12 distinct saved plan step identifiers.'); result.stepIds = [...value.stepIds]; }
  return result;
}

const lines = text => { if (text === '') return []; const result = text.replaceAll('\r\n', '\n').split('\n'); if (result.at(-1) === '') result.pop(); return result; };
/** Bounded line diff. Line numbers always refer to the observed before/after files. */
export function buildTextDiff(before, after, { maxLines = LIVE_EDIT_LIMITS.diffLines, maxChars = LIVE_EDIT_LIMITS.diffChars } = {}) {
  const a = lines(before), b = lines(after); let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const old = a.slice(prefix, a.length - suffix), next = b.slice(prefix, b.length - suffix), operations = [];
  let oldLine = 1, newLine = 1;
  const add = (kind, text) => operations.push({ kind, oldLine: kind === 'add' ? null : oldLine++, newLine: kind === 'remove' ? null : newLine++, text });
  for (let i = 0; i < prefix; i++) add('context', a[i]);
  if (old.length * next.length <= 250000 && old.length < 65535 && next.length < 65535) {
    const table = Array.from({ length: old.length + 1 }, () => new Uint16Array(next.length + 1));
    for (let i = old.length - 1; i >= 0; i--) for (let j = next.length - 1; j >= 0; j--) table[i][j] = old[i] === next[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    let i = 0, j = 0;
    while (i < old.length || j < next.length) {
      if (i < old.length && j < next.length && old[i] === next[j]) { add('context', old[i++]); j++; }
      else if (i < old.length && (j === next.length || table[i + 1][j] >= table[i][j + 1])) add('remove', old[i++]);
      else add('add', next[j++]);
    }
  } else { for (const text of old) add('remove', text); for (const text of next) add('add', text); }
  for (let i = a.length - suffix; i < a.length; i++) add('context', a[i]);
  const changed = operations.flatMap((item, index) => item.kind === 'context' ? [] : [index]);
  const ranges = [];
  for (const index of changed) { const start = Math.max(0, index - 3), end = Math.min(operations.length, index + 4), previous = ranges.at(-1); if (previous && start <= previous.end) previous.end = Math.max(previous.end, end); else ranges.push({ start, end }); }
  let count = 0, chars = 0, truncated = false; const hunks = [];
  for (const range of ranges) {
    const selected = [];
    for (const row of operations.slice(range.start, range.end)) {
      if (count >= maxLines || chars + Math.min(row.text.length, 2000) > maxChars) { truncated = true; break; }
      const text = row.text.slice(0, 2000); if (text.length !== row.text.length) truncated = true;
      selected.push({ ...row, text }); count++; chars += text.length;
    }
    if (selected.length) hunks.push({ oldStart: operations[range.start].oldLine ?? Math.max(1, (operations.slice(0, range.start).filter(row => row.kind !== 'add').length + 1)), newStart: operations[range.start].newLine ?? Math.max(1, (operations.slice(0, range.start).filter(row => row.kind !== 'remove').length + 1)), lines: selected });
    if (count >= maxLines || chars >= maxChars) { truncated = true; break; }
  }
  return { hunks, added: operations.filter(row => row.kind === 'add').length, removed: operations.filter(row => row.kind === 'remove').length, truncated };
}

/** Watches actual disk changes from a pre-run baseline; never attributes concurrent user writes to a particular agent. */
export class LiveEditJournal {
  constructor({ dataDir, onEvent = () => {}, pollMs = 1200, debounceMs = 100, limits = {} } = {}) {
    this.dataDir = dataDir ? path.resolve(dataDir) : null; this.onEvent = onEvent; this.pollMs = Math.max(50, Number(pollMs) || 1200); this.debounceMs = Math.max(10, Number(debounceMs) || 100); this.limits = { ...LIVE_EDIT_LIMITS, ...limits }; this.runs = new Map(); this.closed = false;
  }
  async start(runId, { cwd, signal } = {}) {
    identifier(runId); check(signal); if (this.closed) throw new Error('Live edit journal is closed.');
    if (this.runs.get(runId)?.active) throw new Error('This run already has a live edit journal.');
    const root = await fs.realpath(path.resolve(cwd || process.cwd())); if (!(await fs.stat(root)).isDirectory()) throw new Error('The observed workspace must be a folder.');
    check(signal); if (this.closed) throw new Error('Live edit journal is closed.');
    const state = { runId, cwd: root, startedAt: stamp(), stoppedAt: null, sequence: 0, events: [], truncated: false, active: true, coverage: { files: 0, skipped: 0, limited: false, mode: 'watch' }, baseline: new Map(), queued: Promise.resolve(), timer: null, watcher: null, dirty: new Set(), rescan: false, forceContent: false, scanTimer: null, bytes: 0, signal };
    this.runs.set(runId, state);
    try {
      const initial = await this.scan(state); check(signal); if (!state.active) throw Object.assign(new Error('Live observation closed.'), { name: 'AbortError', code: 'ABORT_ERR' });
      for (const [file, value] of initial) { if (value.text !== null && state.bytes + Buffer.byteLength(value.text) > this.limits.baselineBytes) { value.text = null; value.reason = 'baseline-limit'; state.coverage.limited = true; } else if (value.text !== null) state.bytes += Buffer.byteLength(value.text); state.baseline.set(file, value); }
      state.coverage.files = state.baseline.size;
      try { state.watcher = watch(root, { recursive: true, persistent: false }, (_, filename) => this.queueChange(state, filename)); state.watcher.on('error', () => { state.coverage.mode = 'poll'; state.rescan = true; this.schedule(state); }); }
      catch { state.coverage.mode = 'poll'; }
      state.timer = setInterval(() => { if (state.active) { state.rescan = true; this.schedule(state); } }, this.pollMs); state.timer.unref?.();
      if (signal) { state.onAbort = () => { this.stop(runId).catch(() => {}); }; signal.addEventListener('abort', state.onAbort, { once: true }); }
      return this.snapshot(runId);
    } catch (error) { state.active = false; if (this.runs.get(runId) === state) this.runs.delete(runId); state.watcher?.close(); clearInterval(state.timer); throw error; }
  }
  queueChange(state, filename) {
    if (!state.active) return;
    if (filename) { const file = this.safeRelative(state, String(filename)); if (file) state.dirty.add(file); }
    else { state.rescan = true; state.forceContent = true; }
    this.schedule(state);
  }
  safeRelative(state, value) {
    let file; try { file = relative(value); } catch { return null; }
    if (file.split('/').some(part => IGNORED.has(part.toLowerCase()))) return null;
    const absolute = path.resolve(state.cwd, file), nestedData = this.dataDir && this.dataDir !== state.cwd && inside(state.cwd, this.dataDir);
    if (!inside(state.cwd, absolute) || nestedData && inside(this.dataDir, absolute)) return null;
    return file;
  }
  async read(state, file, { previous, maxContentBytes = this.limits.fileBytes } = {}) {
    const absolute = path.resolve(state.cwd, file); if (!this.safeRelative(state, file)) return null;
    try {
      let current = state.cwd;
      for (const part of file.split('/')) { current = path.join(current, part); if ((await fs.lstat(current)).isSymbolicLink()) return null; }
      const real = await fs.realpath(absolute); if (!inside(state.cwd, real)) return null;
      const stat = await fs.stat(real); if (!stat.isFile()) return null;
      const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (previous?.signature === signature) return { ...previous };
      if (stat.size > this.limits.fileBytes) return { signature, size: stat.size, text: null, hash: null, reason: 'large-file' };
      if (stat.size > maxContentBytes) return { signature, size: stat.size, text: null, hash: null, reason: 'baseline-limit' };
      const handle = await fs.open(real, 'r'); let bytes, after;
      try {
        const opened = await handle.stat(); if (opened.dev !== stat.dev || opened.ino !== stat.ino || !inside(state.cwd, await fs.realpath(real))) return undefined;
        const buffer = Buffer.alloc(Math.min(this.limits.fileBytes + 1, stat.size + 1)); const read = await handle.read(buffer, 0, buffer.length, 0); bytes = buffer.subarray(0, read.bytesRead); after = await handle.stat();
      } finally { await handle.close(); }
      if (after.size > this.limits.fileBytes) return { signature, size: after.size, text: null, hash: null, reason: 'large-file' };
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || bytes.length !== after.size) { state.dirty.add(file); return undefined; }
      const digest = hash(bytes); if (sensitive(file)) return { signature, size: bytes.length, text: null, hash: digest, reason: 'sensitive-file' };
      let text = null; try { if (!bytes.includes(0)) text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {}
      return { signature, size: bytes.length, text, hash: digest, reason: text === null ? 'binary-file' : null };
    } catch (error) { if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) return null; throw error; }
  }
  async scan(state, { forceContent = false, dirty = new Set() } = {}) {
    const result = new Map(), pending = ['']; let visited = 0, retained = 0;
    while (pending.length) {
      if (!state.active) return result; check(state.signal);
      const directory = pending.pop(); let entries;
      try { entries = await fs.readdir(path.join(state.cwd, directory), { withFileTypes: true }); } catch { state.coverage.skipped++; continue; }
      for (const entry of entries) {
        const file = this.safeRelative(state, directory ? `${directory}/${entry.name}` : entry.name); if (!file || entry.isSymbolicLink()) continue;
        if (++visited > this.limits.files * 2 || result.size >= this.limits.files) { state.coverage.limited = true; return result; }
        if (entry.isDirectory()) pending.push(file);
        else if (entry.isFile()) {
          // Filesystems can report identical size and timestamps for rapid
          // rewrites. Explicit verification, watcher hints and polling fallback
          // must read bounded bytes instead of trusting that metadata cache.
          const previous = forceContent || dirty.has(file) || state.dirty.has(file) ? undefined : state.baseline.get(file);
          const value = await this.read(state, file, { previous, maxContentBytes: Math.max(0, this.limits.baselineBytes - retained) });
          if (value) { if (value.reason === 'baseline-limit') state.coverage.limited = true; if (value.text !== null) { const size = Buffer.byteLength(value.text); if (retained + size > this.limits.baselineBytes) { value.text = null; value.reason = 'baseline-limit'; state.coverage.limited = true; } else retained += size; } result.set(file, value); }
        }
      }
    }
    return result;
  }
  schedule(state) {
    if (state.scanTimer || !state.active) return;
    state.scanTimer = setTimeout(() => { state.scanTimer = null; state.queued = state.queued.then(() => this._flush(state)).catch(error => { state.coverage.error = String(error.message || 'Live edit scan failed.').slice(0, 200); }); }, this.debounceMs); state.scanTimer.unref?.();
  }
  async _flush(state, { forceContent = false } = {}) {
    if (!state.active) return;
    forceContent = forceContent || state.forceContent; state.forceContent = false;
    const dirty = new Set(state.dirty); state.dirty.clear(); let scanned = null;
    if (state.rescan || forceContent) { state.rescan = false; scanned = await this.scan(state, { forceContent: forceContent || state.coverage.mode === 'poll', dirty }); for (const file of scanned.keys()) dirty.add(file); if (!state.coverage.limited) for (const file of state.baseline.keys()) if (!scanned.has(file)) dirty.add(file); }
    for (const file of dirty) {
      if (!state.active) break;
      const before = state.baseline.get(file) || null, after = scanned?.get(file) ?? await this.read(state, file);
      if (!state.active) break;
      if (after === undefined || !before && !after) continue;
      if (before && after && (before.hash && after.hash ? before.hash === after.hash : before.signature === after.signature)) continue;
      const change = !before ? 'created' : !after ? 'deleted' : 'modified';
      let reason = before?.reason || after?.reason || null, diff = null;
      if ((!before || before.text !== null) && (!after || after.text !== null)) { reason = null; diff = buildTextDiff(before?.text || '', after?.text || '', { maxLines: this.limits.diffLines, maxChars: this.limits.diffChars }); }
      const preview = after && /\.svg$/i.test(file) && !reason && diff && !diff.truncated && after.size <= SVG_PREVIEW_LIMIT && safeSvgPreview(after.text) ? { type: 'svg', text: after.text } : null;
      const event = { type: 'run.edit', source: 'filesystem', runId: state.runId, sequence: ++state.sequence, at: stamp(), path: file, change, beforeHash: before?.hash || null, afterHash: after?.hash || null, bytes: { before: before?.size || 0, after: after?.size || 0 }, diff, ...(preview ? { preview } : {}), ...(reason ? { contentOmitted: reason } : {}) };
      if (before?.text !== null && before?.text !== undefined) state.bytes -= Buffer.byteLength(before.text);
      if (after) { if (after.text !== null && state.bytes + Buffer.byteLength(after.text) > this.limits.baselineBytes) { after.text = null; after.reason = 'baseline-limit'; state.coverage.limited = true; } else if (after.text !== null) state.bytes += Buffer.byteLength(after.text); state.baseline.set(file, after); } else state.baseline.delete(file);
      state.events.push(event); while (state.events.length > this.limits.events || Buffer.byteLength(JSON.stringify(state.events)) > this.limits.journalBytes) { state.events.shift(); state.truncated = true; }
      try { this.onEvent(state.runId, copy(event)); } catch { /* A display listener must not stop disk observation. */ }
    }
    state.coverage.files = state.baseline.size;
  }
  async flush(runId) {
    const state = this.runs.get(identifier(runId)); if (!state?.active) return this.snapshot(runId);
    clearTimeout(state.scanTimer); state.scanTimer = null; state.rescan = true;
    state.queued = state.queued.then(() => this._flush(state, { forceContent: true })); await state.queued; return this.snapshot(runId);
  }
  snapshot(runId, { after = 0, limit = 50 } = {}) {
    identifier(runId); const state = this.runs.get(runId); if (!state) return null;
    return copy({ runId, cwd: state.cwd, startedAt: state.startedAt, stoppedAt: state.stoppedAt, active: Boolean(state.active), sequence: state.sequence, firstSequence: state.events[0]?.sequence || 0, truncated: state.truncated, coverage: state.coverage, events: state.events.filter(event => event.sequence > (Number(after) || 0)).slice(-Math.min(this.limits.events, Math.max(1, Number(limit) || 50))) });
  }
  async get(runId, options) { return this.snapshot(runId, options); }
  async stop(runId) {
    identifier(runId); const state = this.runs.get(runId); if (!state || !state.active) return this.snapshot(runId);
    if (state.stopping) return state.stopping;
    state.active = false; clearInterval(state.timer); clearTimeout(state.scanTimer); state.watcher?.close(); state.signal?.removeEventListener('abort', state.onAbort); state.dirty.clear(); state.stoppedAt = stamp();
    state.stopping = (async () => { await state.queued; return this.snapshot(runId); })();
    return state.stopping;
  }
  async forget(runId) { const state = this.runs.get(identifier(runId)); await this.stop(runId); if (state) { state.baseline.clear(); state.events.length = 0; state.bytes = 0; if (this.runs.get(runId) === state) this.runs.delete(runId); } }
  async close() { this.closed = true; await Promise.all([...this.runs.keys()].map(runId => this.forget(runId))); }
}
