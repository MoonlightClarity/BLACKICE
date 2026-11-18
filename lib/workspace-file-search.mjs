import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileSearchLocations } from './workspace-file-search-locations.mjs';

// Streams directory entries; never materializes a folder listing or reads file contents.
// Cursors are process-local capabilities. Expiry/restart is reported, never silently restarted.
const sessions = new Map();
const TTL = 10 * 60 * 1000, MAX_SESSIONS = 16, MAX_DEPTH = 64, MAX_PAGE = 35000;
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
}
async function dispose(s) {
  clearTimeout(s.timer); sessions.delete(s.id); await close(s);
}
function arm(s) {
  clearTimeout(s.timer);
  s.timer = setTimeout(() => { if (s.busy) arm(s); else void dispose(s); }, TTL);
  s.timer.unref?.();
}
function options(cwd, args) {
  if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 256 || /[\r\n\0]/.test(args.query)) throw fail('find requires a literal filename/path query of 1 to 256 characters; wildcards and | are literal.');
  if (args.path !== undefined && args.roots !== undefined) throw fail('Specify path or roots, not both.');
  const source = args.roots ?? [args.path ?? cwd];
  if (!Array.isArray(source) || !source.length || source.length > 8) throw fail('Specify one to eight search roots.');
  const resolved = source.map(value => validPath(cwd, value));
  const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const unique = resolved.filter((value, i) => resolved.findIndex(other => key(other) === key(value)) === i);
  const roots = unique.filter(value => !unique.some(other => key(other) !== key(value) && key(value).startsWith(key(other).replace(/[\\/]+$/, '') + path.sep)));
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
  const scanComplete = s.rootIndex >= s.options.roots.length && s.stack.length === 0 && !s.pending;
  return { engine: 'filesystem', matchMode: 'literal', query: s.options.query, match: s.options.match,
    roots: s.options.roots, rootsAttempted: s.rootIndex, rootsPending: s.options.roots.length - s.rootIndex, matches, cursor, scanComplete,
    searchComplete: scanComplete && s.errorCount === 0 && s.skippedCount === 0,
    stopReason: reason, scannedEntries: s.scannedEntries, matchedFiles: s.matchedFiles,
    errors, errorCount: s.errorCount, skippedCount: s.skippedCount, durationMs,
    coverage: 'roots lists selected coverage, not a claim every root was completed; rootsAttempted includes failed attempts. Only the specified roots are searched. Symbolic links are not followed; depth beyond 64 is skipped. Filesystem changes during pagination may affect results. Cursors expire after 10 minutes idle or process restart. Time budget and cancellation are checked between filesystem operations.',
    ...(scanComplete && !matches.length ? { note: 'No further matches in this traversal; inspect searchComplete, errorCount and skippedCount before concluding absence.' } : {}) };
}
async function candidate(s, errors, signal) {
  for (;;) {
    check(signal);
    if (!s.stack.length) {
      if (s.rootIndex >= s.options.roots.length) return null;
      const root = s.options.roots[s.rootIndex++];
      try {
        const stat = await fs.lstat(root); check(signal);
        if (stat.isSymbolicLink()) { s.skippedCount++; issue(s, errors, root, 'SYMLINK_NOT_FOLLOWED'); continue; }
        if (stat.isFile()) return { file: root, stat };
        if (!stat.isDirectory()) { s.skippedCount++; issue(s, errors, root, 'NOT_REGULAR_FILE_OR_DIRECTORY'); continue; }
        s.stack.push({ path: root, dir: await fs.opendir(root), depth: 0 });
      } catch (cause) { check(signal); issue(s, errors, root, cause.code || 'IO_ERROR'); continue; }
    }
    const frame = s.stack.at(-1);
    let entry;
    try { entry = await frame.dir.read(); } catch (cause) {
      check(signal); issue(s, errors, frame.path, cause.code || 'IO_ERROR'); await frame.dir.close().catch(() => {}); s.stack.pop(); continue;
    }
    check(signal);
    if (!entry) { await frame.dir.close().catch(() => {}); s.stack.pop(); continue; }
    s.scannedEntries++;
    const file = path.join(frame.path, entry.name);
    if (entry.isSymbolicLink()) { s.skippedCount++; issue(s, errors, file, 'SYMLINK_NOT_FOLLOWED'); return { skipped: true }; }
    if (entry.isDirectory()) {
      if (frame.depth >= MAX_DEPTH) { s.skippedCount++; issue(s, errors, file, 'DEPTH_LIMIT'); return { skipped: true }; }
      try { s.stack.push({ path: file, dir: await fs.opendir(file), depth: frame.depth + 1 }); }
      catch (cause) { check(signal); issue(s, errors, file, cause.code || 'IO_ERROR'); }
      return { skipped: true };
    }
    if (!entry.isFile()) return { skipped: true };
    return { file };
  }
}

export function createFileSearch({ cwd = process.cwd(), scope = 'local', resolveLocations = fileSearchLocations } = {}) {
  cwd = path.resolve(cwd); scope = String(scope);
  return async (args, signal) => {
    const requestStarted = Date.now();
    check(signal);
    const limit = integer(args.limit, 50, 1, 100), timeoutMs = integer(args.timeoutMs, 1000, 100, 10000);
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
      s = { id: randomUUID(), cwd, scope, options: opts, stack: [], rootIndex: 0, scannedEntries: 0,
        matchedFiles: 0, skippedCount: 0, errorCount: 0, pending: null, next: null, replay: null, busy: false };
      s.discoveryErrors = []; for (const detail of discovered?.errors || []) issue(s, s.discoveryErrors, detail.path, detail.code);
      sessions.set(s.id, s);
    }
    s.busy = true; arm(s);
    const started = Date.now(), matches = [], errors = s.discoveryErrors.splice(0, 12);
    let reason = 'complete';
    try {
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
      const complete = s.rootIndex >= s.options.roots.length && s.stack.length === 0 && !s.pending;
      s.next = complete ? null : `fs1:${s.id}:${randomUUID()}`;
      const value = response(s, matches, errors, complete ? 'complete' : reason, s.next, Date.now() - requestStarted);
      s.replay = token ? { token, result: structuredClone(value) } : null;
      if (complete) await close(s);
      return value;
    } catch (cause) { await dispose(s); throw cause; }
    finally { s.busy = false; if (sessions.has(s.id)) arm(s); }
  };
}
