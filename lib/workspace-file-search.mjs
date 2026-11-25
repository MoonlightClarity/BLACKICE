import { promises as fs, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fileSearchLocations } from './workspace-file-search-locations.mjs';
import { DEFAULT_FILE_SEARCH_TIMEOUT_MS } from './file-search-contract.mjs';

// Streams directory entries; never materializes a folder listing or reads file contents.
// Cursors are process-local capabilities. Expiry/restart is reported, never silently restarted.
const sessions = new Map();
const scratchPaths = new Set();
const scratchCanonical = new Map();
function ownedScratch(canonical) {
  return [...scratchCanonical.values()].some(root => canonical === root || canonical.startsWith(root + path.sep));
}
function excludeScratch(s) { s.skippedCount++; s.excludedScratchCount++; return { skipped: true }; }
// Normal process shutdown cannot await async cleanup. Abrupt process/OS termination
// may leave temporary metadata; it is never used to resume a process-local cursor.
process.once('exit', () => {
  for (const s of sessions.values()) {
    try { s.frontier?.close(); } catch {}
  }
  for (const scratch of scratchPaths) { try { rmSync(scratch, { recursive: true, force: true }); } catch {} }
});
const TTL = 10 * 60 * 1000, MAX_SESSIONS = 16, MAX_OPEN = 64, QUANTUM = 128, MAX_PAGE = 35000;
const fail = (message, code = 'FILE_SEARCH_INVALID') => Object.assign(new Error(message), { code });
const abort = () => Object.assign(fail('File search cancelled.', 'ABORT_ERR'), { name: 'AbortError' });
const check = signal => { if (signal?.aborted) throw abort(); };
const integer = (value, fallback, min, max) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw fail(`Expected an integer from ${min} to ${max}.`);
  return value;
};
const normalize = (text, sensitive) => sensitive ? text.normalize('NFC') : text.normalize('NFC').toLowerCase();
const validPath = (cwd, value) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || value.includes('\0')) throw fail('Use a nonempty path of at most 2,048 characters.');
  return path.resolve(cwd, value);
};
async function close(s) {
  for (const frame of s.stack.splice(0)) await frame.dir?.close().catch(() => {});
  if (s.frontier) { s.frontier.close(); s.frontier = null; }
  if (s.scratch) { await fs.rm(s.scratch, { recursive: true, force: true }); scratchPaths.delete(s.scratch); scratchCanonical.delete(s.scratch); s.scratch = null; }
}
async function dispose(s) {
  clearTimeout(s.timer); sessions.delete(s.id); await close(s);
}
function arm(s) {
  clearTimeout(s.timer);
  s.timer = setTimeout(() => { if (s.busy) arm(s); else void dispose(s).catch(() => { /* OS may deny scratch cleanup; never reject an unobserved timer. */ }); }, TTL);
  s.timer.unref?.();
}
function options(cwd, args) {
  if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 256 || /[\r\n\0]/.test(args.query)) throw fail('find requires a literal filename/path query of 1 to 256 characters; wildcards and | are literal.');
  if (args.path !== undefined && args.roots !== undefined) throw fail('Specify path or roots, not both.');
  const source = args.roots ?? [args.path ?? cwd];
  if (!Array.isArray(source) || !source.length || source.length > 64) throw fail('Specify one to 64 search roots.');
  const resolved = source.map(value => validPath(cwd, value));
  const key = value => value;
  const unique = resolved.filter((value, i) => resolved.findIndex(other => key(other) === key(value)) === i);
  const roots = unique;
  if (JSON.stringify(roots).length > 8000) throw fail('Combined search-root paths exceed the response budget; search fewer roots per call.');
  const match = args.match ?? 'name';
  if (!['name', 'path'].includes(match)) throw fail('match must be name or path.');
  if (args.caseSensitive !== undefined && typeof args.caseSensitive !== 'boolean') throw fail('caseSensitive must be boolean.');
  const extensions = args.extensions ?? [];
  if (!Array.isArray(extensions) || extensions.length > 16 || extensions.some(x => typeof x !== 'string' || !/^\.?[\p{L}\p{N}_-]{1,16}$/u.test(x))) throw fail('extensions must contain up to 16 file extensions, such as pdf or .docx.');
  return { roots, query: args.query, match, caseSensitive: args.caseSensitive === true, extensions: [...new Set(extensions.map(x => x.replace(/^\./, '').toLowerCase()))] };
}
function issue(s, errors, file, code) {
  s.errorCount++;
  if (errors.length < 12) {
    const detail = { path: file.slice(0, 1024), code: String(code).slice(0, 64) };
    while (JSON.stringify(detail).length > 800) detail.path = detail.path.slice(0, Math.floor(detail.path.length / 2));
    errors.push(detail);
  }
}
function response(s, matches, errors, reason, cursor, durationMs) {
  const scanComplete = s.rootIndex >= s.options.roots.length && s.stack.length === 0 && s.queued === 0 && !s.pending;
  return { engine: 'filesystem', matchMode: 'literal', query: s.options.query, match: s.options.match,
    caseSensitive:s.options.caseSensitive, extensions:s.options.extensions,
    roots: s.options.roots, rootsAttempted: s.rootIndex, rootsPending: s.options.roots.length - s.rootIndex, matches, cursor, scanComplete,
    searchComplete: scanComplete && s.errorCount === 0 && s.skippedCount === 0,
    stopReason: reason, scannedEntries: s.scannedEntries, matchedFiles: s.matchedFiles,
    errors, errorCount: s.errorCount, skippedCount: s.skippedCount, excludedScratchCount: s.excludedScratchCount, durationMs,
    coverage: "roots lists this traversal's selected search coverage; rootsAttempted includes failed attempts. Follow cursor while present. scanComplete reports a finished traversal; searchComplete also requires zero errors and skipped paths. Check errors, errorCount and skippedCount before reporting absence, and limit that claim to these roots. Owned temporary search databases are excluded (excludedScratchCount). Symbolic-link targets are searched once per canonical target. Filesystem changes may affect pages; cursors expire after 10 minutes idle or process restart.",
    ...(scanComplete && !matches.length ? { note: "No further matches in these roots. Check searchComplete, errors and skippedCount for coverage gaps; this does not establish absence elsewhere." } : {}) };
}
// Bounded SQLite cache and open streams; disk stores frontier and canonical visited keys.
async function initFrontier(s) {
  s.scratch = await fs.mkdtemp(path.join(tmpdir(), 'blackice-file-search-')); scratchPaths.add(s.scratch);
  scratchCanonical.set(s.scratch, await fs.realpath(s.scratch));
  if (process.platform !== 'win32') await fs.chmod(s.scratch, 0o700);
  s.frontier = new DatabaseSync(path.join(s.scratch, 'frontier.sqlite'));
  s.frontier.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-512; PRAGMA temp_store=FILE; CREATE TABLE seen (path TEXT PRIMARY KEY) WITHOUT ROWID; CREATE TABLE returned (path TEXT PRIMARY KEY) WITHOUT ROWID; CREATE TABLE pending (id INTEGER PRIMARY KEY, path TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);');
  s.seen = s.frontier.prepare('INSERT OR IGNORE INTO seen VALUES (?)');
  s.returned = s.frontier.prepare('INSERT OR IGNORE INTO returned VALUES (?)');
  s.enqueue = s.frontier.prepare('INSERT INTO pending(path,consumed) VALUES (?,?)');
  s.dequeue = s.frontier.prepare('SELECT id,path,consumed FROM pending ORDER BY id LIMIT 1');
  s.removeQueued = s.frontier.prepare('DELETE FROM pending WHERE id=?');
}
async function admit(s, file, errors, signal, knownDirectory = false) {
  try {
    const stat = knownDirectory ? null : await fs.stat(file); check(signal);
    const canonical = await fs.realpath(file); check(signal);
    if (ownedScratch(canonical)) return excludeScratch(s);
    if (stat?.isFile()) return { file, stat };
    if (!knownDirectory && !stat.isDirectory()) {
      s.skippedCount++; issue(s, errors, file, 'NOT_REGULAR_FILE_OR_DIRECTORY'); return { skipped: true };
    }
    // Keep case-sensitive Windows directories distinct; realpath resolves aliases.
    if (!s.seen.run(canonical).changes) return { skipped: true };
    s.enqueue.run(file, 0); s.queued++;
  } catch (cause) { check(signal); issue(s, errors, file, cause.code || 'IO_ERROR'); }
  return { skipped: true };
}
async function candidate(s, errors, signal) {
  check(signal);
  if (s.rootIndex < s.options.roots.length) return admit(s, s.options.roots[s.rootIndex++], errors, signal);
  if (s.stack.length < MAX_OPEN && s.queued) {
    const next = s.dequeue.get(); s.removeQueued.run(next.id); s.queued--;
    try { s.stack.push({ path: next.path, dir: await fs.opendir(next.path, { bufferSize: 32 }), consumed: next.consumed, skip: next.consumed, turns: 0 }); }
    catch (cause) { check(signal); issue(s, errors, next.path, cause.code || 'IO_ERROR'); }
    check(signal); return { skipped: true };
  }
  const frame = s.stack.shift();
  if (!frame) return null;
  let entry;
  try {
    // Node has no seekdir cookie. Re-enumerate in bounded, cancellable chunks.
    for (let n = 0; frame.skip && n < 32; n++) {
      const prior = await frame.dir.read(); check(signal);
      if (!prior) { await frame.dir.close().catch(() => {}); return { skipped: true }; }
      frame.skip--;
    }
    if (frame.skip) { s.stack.push(frame); return { skipped: true }; }
    entry = await frame.dir.read();
  } catch (cause) {
    await frame.dir.close().catch(() => {}); check(signal);
    issue(s, errors, frame.path, cause.code || 'IO_ERROR'); return { skipped: true };
  }
  if (!entry) { await frame.dir.close().catch(() => {}); check(signal); return { skipped: true }; }
  frame.consumed++; frame.turns++;
  if (frame.turns >= QUANTUM && s.queued) {
    await frame.dir.close().catch(() => {});
    s.enqueue.run(frame.path, frame.consumed); s.queued++;
  } else s.stack.push(frame);
  check(signal); s.scannedEntries++;
  const file = path.join(frame.path, entry.name);
  if (entry.isDirectory() || entry.isSymbolicLink()) return admit(s, file, errors, signal, entry.isDirectory());
  if (!entry.isFile()) {
    s.skippedCount++; issue(s, errors, file, 'NOT_REGULAR_FILE_OR_DIRECTORY'); return { skipped: true };
  }
  return { file };
}


export function createFileSearch({ cwd = process.cwd(), scope = 'local', resolveLocations = fileSearchLocations } = {}) {
  cwd = path.resolve(cwd); scope = String(scope);
  return async (args, signal) => {
    const requestStarted = Date.now();
    check(signal);
    const limit = integer(args.limit, 50, 1, 100), timeoutMs = integer(args.timeoutMs, DEFAULT_FILE_SEARCH_TIMEOUT_MS, 100, 10000);
    let s, token;
    if (args.cursor !== undefined) {
      if (typeof args.cursor !== 'string' || !/^fs1:[a-f0-9-]{36}:[a-f0-9-]{36}$/.test(args.cursor)) throw fail('Invalid file-search cursor.', 'FILE_SEARCH_CURSOR_INVALID');
      token = args.cursor; s = sessions.get(token.split(':')[1]);
      if (!s || s.cwd !== cwd || s.scope !== scope) throw fail('File-search cursor expired or belongs to a different execution scope. Start a new explicit search.', 'FILE_SEARCH_CURSOR_EXPIRED');
      if (['query', 'path', 'roots', 'match', 'extensions', 'caseSensitive'].some(key => args[key] !== undefined)) {
        const filters = { ...s.options, ...args };
        if (args.path !== undefined && args.roots === undefined) delete filters.roots;
        const normalized = options(cwd, filters);
        if (JSON.stringify(normalized) !== JSON.stringify(s.options)) throw fail('Do not change search filters when continuing a cursor. Start a new search.');
      }
      if (s.busy) throw fail('This file search already has a page in progress.', 'FILE_SEARCH_BUSY');
      if (s.replay?.token === token) { arm(s); return structuredClone(s.replay.result); }
      if (token !== s.next) throw fail('This page cursor is stale. Use the latest returned cursor.', 'FILE_SEARCH_CURSOR_STALE');
    } else {
      options(cwd, args); // Reject invalid input before OS location discovery.
      const discovered = args.path === undefined && args.roots === undefined ? await resolveLocations(cwd, signal) : null;
      check(signal);
      const opts = options(cwd, discovered ? { ...args, roots: discovered.roots } : args);
      if (sessions.size >= MAX_SESSIONS) {
        const oldest = [...sessions.values()].find(x => !x.busy);
        if (oldest) await dispose(oldest);
        else throw fail('All file search slots are busy; retry after a page finishes.', 'FILE_SEARCH_BUSY');
      }
      s = { id: randomUUID(), cwd, scope, options: opts, stack: [], queued: 0, frontier: null, scratch: null, rootIndex: 0, scannedEntries: 0,
        matchedFiles: 0, skippedCount: 0, excludedScratchCount: 0, errorCount: 0, pending: null, next: null, replay: null, busy: false };
      s.discoveryErrors = []; for (const detail of discovered?.errors || []) issue(s, s.discoveryErrors, detail.path, detail.code);
      sessions.set(s.id, s);
    }
    s.busy = true; arm(s);
    const started = Date.now(), matches = [], errors = s.discoveryErrors.splice(0, 12);
    let reason = 'complete';
    try {
      if (!s.frontier) await initFrontier(s);
      for (;;) {
        check(signal);
        if (matches.length >= limit) { reason = 'page_limit'; break; }
        if (Date.now() - started >= timeoutMs) { reason = 'time_budget'; break; }
        let item = s.pending; s.pending = null;
        if (!item) {
          const found = await candidate(s, errors, signal);
          if (!found) break;
          if (found.skipped) continue;
          const name = path.basename(found.file), haystack = s.options.match === 'path' ? found.file : name;
          if (!normalize(haystack, s.options.caseSensitive).includes(normalize(s.options.query, s.options.caseSensitive))) continue;
          if (s.options.extensions.length && !s.options.extensions.includes(path.extname(name).slice(1).toLowerCase())) continue;
          try {
            const stat = found.stat || await fs.lstat(found.file); check(signal);
            if (!stat.isFile()) { s.skippedCount++; issue(s, errors, found.file, 'CHANGED_DURING_SEARCH'); continue; }
            const canonical = await fs.realpath(found.file); check(signal);
            if (ownedScratch(canonical)) { excludeScratch(s); continue; }
            if (!s.returned.run(canonical).changes) continue;
            item = { path: found.file, name, size: stat.size, modifiedAt: stat.mtime.toISOString() }; s.matchedFiles++;
          } catch (cause) { check(signal); issue(s, errors, found.file, cause.code || 'IO_ERROR'); continue; }
        }
        const projected = response(s, [...matches, item], errors, 'page_limit', `fs1:${s.id}:${randomUUID()}`, Date.now() - started);
        if (JSON.stringify(projected).length + (12 - errors.length) * 820 > MAX_PAGE) {
          if (!matches.length) { s.skippedCount++; issue(s, errors, item.path, 'RESULT_PATH_TOO_LONG'); continue; }
          s.pending = item; reason = 'output_budget'; break;
        }
        matches.push(item);
      }
      const complete = s.rootIndex >= s.options.roots.length && s.stack.length === 0 && s.queued === 0 && !s.pending;
      s.next = complete ? null : `fs1:${s.id}:${randomUUID()}`;
      const value = response(s, matches, errors, complete ? 'complete' : reason, s.next, Date.now() - requestStarted);
      s.replay = token ? { token, result: structuredClone(value) } : null;
      if (complete) await close(s);
      return value;
    } catch (cause) { await dispose(s).catch(() => {}); throw cause; }
    finally { s.busy = false; if (sessions.has(s.id)) arm(s); }
  };
}
