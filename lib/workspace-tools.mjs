import { promises as fs } from 'node:fs';
import { createFileSearch } from './workspace-file-search.mjs';
import { FIND_FILES_TOOL, validateFileSearchCall } from './file-search-contract.mjs';
export { FIND_FILES_TOOL } from './file-search-contract.mjs';
import { describeHostOperation, normalizeHostOperationResult } from './operation-descriptors.mjs';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { inspectWordDocument } from './office-documents.mjs';
import { XLSX_ROWS, XLSX_COLUMNS } from './spreadsheet-documents.mjs';
import { readSpreadsheetInWorker } from './spreadsheet-reader-worker.mjs';
import { PDF_LIMITS, readPdfPages } from './pdf-documents.mjs';
import { StringDecoder } from 'node:string_decoder';
import { DESKTOP_RESTART_ORIGIN_ENV } from './desktop-restart-origin.mjs';
import { attachWorkspaceCommandOutcome } from './workspace-command-outcome.mjs';
import { inspectWorkspaceFile, appendWorkspaceChunk, validateAppend, withWorkspaceMutationLock } from './workspace-file-chunks.mjs';

const MAX_OUTPUT = 40000, MAX_CAPTURE = 35000, MAX_READ = 1024 * 1024;
const PDF_RESULT_CHARS = 5000; // Leave room for JSON escaping and per-page metadata.
const SEARCH_BYTE_BUDGET = 16 * 1024 * 1024;
const SKIP = new Set(['.git', 'node_modules', '.next', '.cache', '.venv', 'venv', 'dist', 'build']);
const fail = (message, code = 'WORKSPACE_ERROR') => Object.assign(new Error(message), { code });
const aborted = () => Object.assign(fail('Workspace action cancelled.', 'ABORT_ERR'), { name: 'AbortError' });
const check = signal => { if (signal?.aborted) throw aborted(); };
const integer = (value, fallback, min, max) => { if (value === undefined) return fallback; if (!Number.isInteger(value) || value < min || value > max) throw fail(`Choose an integer from ${min} to ${max}.`); return value; };
const location = (base, value = '.') => { if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw fail('Use a valid file or folder path.'); return path.resolve(base, value); };
const decode = (bytes, partial = false) => {
  if (bytes.includes(0)) throw fail('This is a binary or non-UTF-8 file. Use the run action to inspect or convert it.');
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: partial }); } catch { throw fail('This file is not valid UTF-8 text. Use the run action to inspect or convert it.'); }
  if ((text.match(/[\u0001-\u0008\u000e-\u001f]/g)?.length || 0) > Math.max(3, text.length * .01)) throw fail('This file contains binary data. Read a text file or use the run action.');
  return text;
};
const result = (value, success = true, onEncoding) => {
  let text = JSON.stringify(value);
  const resultPreviewOnly = text.length > MAX_OUTPUT;
  if (resultPreviewOnly) {
    const metadata = Object.fromEntries(['path', 'cwd', 'exitCode', 'signal', 'timedOut', 'durationMs', 'engine', 'query', 'matchMode', 'nextAction'].filter(key => value[key] !== undefined).map(key => [key, typeof value[key] === 'string' ? value[key].slice(0, 2000) : value[key]]));
    let preview = text.slice(0, MAX_OUTPUT - 1000);
    text = JSON.stringify({ ...metadata, truncated: true, message: 'Result exceeded the output limit. Narrow the path, query, or line range.', preview });
    while (text.length > MAX_OUTPUT) { preview = preview.slice(0, Math.floor(preview.length * .8)); text = JSON.stringify({ ...metadata, truncated: true, message: 'Result exceeded the output limit. Narrow the path, query, or line range.', preview }); }
  }
  onEncoding?.(resultPreviewOnly);
  return { success, contentItems: [{ type: 'inputText', text }] };
};

async function terminateTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { killer.kill(); child.kill(); resolve(); }, 3000);
      const done = () => { clearTimeout(timer); resolve(); };
      killer.once('error', () => { child.kill(); done(); }); killer.once('close', done);
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    await new Promise(resolve => setTimeout(resolve, 150));
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}

function processFailure(cause, { executable, cwd, spawnObserved = false, pid = null } = {}) {
  // EPERM/EACCES alone do not identify Defender, malware, or a policy decision.
  const securityBlockPossible = ['EPERM', 'EACCES', 'ERROR_VIRUS_INFECTED', 'ERROR_VIRUS_DELETED'].includes(cause.code);
  cause.launch = { executable: String(executable ?? '').slice(0, 240), cwd: String(cwd ?? '').slice(0, 1024), stage: spawnObserved ? 'process_started' : 'process_start_not_observed',
    processStartObserved: spawnObserved, pid: Number.isInteger(pid) ? pid : null,
    executionOutcome: 'unknown', securityBlockPossible,
    securityBlockConfirmed: false, automaticRetry: false };
  cause.recovery = ['ERROR_VIRUS_INFECTED', 'ERROR_VIRUS_DELETED'].includes(cause.code)
    ? 'The operating system reported a protection denial. Inspect the executable and host protection record, and resolve that actual denial before retrying. Do not use another route to evade it. Preserve any observed effects before a repeat.'
    : 'Inspect the launch receipt, executable, working folder and actual permissions. This error alone does not confirm a protection denial. Correct the cause and use an available supported route for the authorized action; no automatic retry occurred. Check possible existing effects before repeating an action whose outcome remains uncertain. If separate host evidence establishes a protection denial, resolve that actual denial before retrying.';
  return cause;
}

/** Capture bounded output while continuing to drain both pipes. No launch retry. */
export async function processRun(executable, args, { cwd, signal, timeoutMs = 30000, outputLimit = MAX_CAPTURE, restartOriginToken, childEnv } = {}) {
  check(signal);
  if (childEnv !== undefined && (!childEnv || typeof childEnv !== 'object' || Array.isArray(childEnv) || Object.values(childEnv).some(value => typeof value !== 'string'))) throw fail('An explicit child environment must contain string values.');
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    // Benchmark callers can provide a minimal environment; ordinary calls retain inheritance.
    const env = { ...(childEnv === undefined ? process.env : childEnv) };
    // Only the direct executor may supply this one-command origin. Ordinary
    // workspace actions and search subprocesses never inherit a stale binding.
    for (const key of Object.keys(env)) if (key.toUpperCase() === DESKTOP_RESTART_ORIGIN_ENV) delete env[key];
    if (restartOriginToken !== undefined) env[DESKTOP_RESTART_ORIGIN_ENV] = restartOriginToken;
    let child, spawnObserved = false;
    try {
      // Avoid a new console window in the desktop app; this does not hide output
      // or alter PowerShell execution policy. Both output streams are captured.
      child = spawn(executable, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (cause) { reject(processFailure(cause, { executable, cwd })); return; }
    child.once('spawn', () => { spawnObserved = true; });
    let stdout = '', stderr = '', captured = 0, truncated = false, timedOut = false, cancelled = false, cleanup, spawnError;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const capture = (name, chunk, final = false) => {
      const text = final ? decoders[name].end() : decoders[name].write(chunk);
      const available = Math.max(0, outputLimit - captured), keep = text.slice(0, available); captured += keep.length;
      if (name === 'stdout') stdout += keep; else stderr += keep;
      if (keep.length < text.length) truncated = true;
    };
    child.stdout.on('data', chunk => capture('stdout', chunk)); child.stderr.on('data', chunk => capture('stderr', chunk));
    const stop = () => { cleanup ||= terminateTree(child); };
    const onAbort = () => { cancelled = true; stop(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.once('error', cause => { spawnError = cause; });
    child.once('close', async (exitCode, exitSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort); capture('stdout', null, true); capture('stderr', null, true);
      await cleanup;
      if (spawnError) { reject(processFailure(spawnError, { executable, cwd, spawnObserved, pid: child.pid })); return; }
      if (cancelled || signal?.aborted) { reject(aborted()); return; }
      resolve({ cwd, exitCode, signal: exitSignal, stdout, stderr, truncated, timedOut, durationMs: Date.now() - startedAt });
    });
    if (signal?.aborted) onAbort();
  });
}

async function listFiles(base, args, signal, filenameSearchRoute) {
  const selected = location(base, args.path), limit = integer(args.limit, 150, 1, 300), depth = integer(args.depth, 0, 0, 3), entries = [];
  let truncated = false;
  async function visit(directory, level) {
    check(signal);
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const child of children) {
      check(signal); if (entries.length >= limit) { truncated = true; return; }
      const file = path.join(directory, child.name);
      entries.push({ name: path.relative(selected, file), path: file, type: child.isDirectory() ? 'directory' : child.isSymbolicLink() ? 'symlink' : child.isFile() ? 'file' : 'other' });
      if (child.isDirectory() && level < depth && !SKIP.has(child.name)) await visit(file, level + 1);
    }
  }
  await visit(selected, 0); return { path: selected, entries, truncated, ...(truncated ? { nextAction: `Listing truncated. Use ${filenameSearchRoute} with path and query for a narrow filename search in this observed directory; follow its cursor rather than repeating the full listing or concluding the file is missing.` } : {}), discovery: { workingDirectory: base, parentDirectory: path.dirname(selected), homeDirectory: homedir(), filesystemRoot: path.parse(selected).root, scope: 'This listing covers only the selected directory and requested depth, not the whole computer. Absolute paths use the current OS account permissions.' } };
}
async function readLocalFile(base, args, signal) {
  const selected = location(base, args.path), startLine = integer(args.startLine, 1, 1, 200000), lineCount = integer(args.lineCount, 200, 1, 1500);
  const extension = path.extname(selected).toLowerCase();
  const format = extension === '.pdf' ? 'pdf' : extension === '.docx' ? 'docx' : extension === '.xlsx' ? 'xlsx' : null;
  if ((format === 'pdf' || format === 'xlsx') && (args.startLine !== undefined || args.lineCount !== undefined)) throw fail(format === 'pdf' ? 'Use startPage, pageCount, startChar and charCount for PDF reads.' : 'Use sheet and row/column options for XLSX reads.');
  if (format !== 'pdf' && [args.startPage, args.pageCount, args.startChar, args.charCount].some(value => value !== undefined)) throw fail('PDF paging options apply only to PDF reads; use startLine and lineCount otherwise.');
  if (format !== 'xlsx' && Object.keys(WORKSPACE_XLSX_READ_FIELDS).some(key => args[key] !== undefined)) throw fail('Sheet and row/column options apply only to XLSX reads.');
  const pdfCharCount = format === 'pdf' ? integer(args.charCount, PDF_RESULT_CHARS, 1, PDF_RESULT_CHARS) : undefined;
  check(signal); const handle = await fs.open(selected, 'r');
  try {
    const stat = await handle.stat(); if (!stat.isFile()) throw fail('Choose a regular file to read.');
    const maxBytes = format ? PDF_LIMITS.inputBytes : MAX_READ;
    if (format && stat.size > maxBytes) throw fail('Direct local PDF, DOCX and XLSX reads support files up to 10 MiB.', 'WORKSPACE_DOCUMENT_LIMIT');
    const bytes = Buffer.alloc(Math.min(stat.size, maxBytes));
    let { bytesRead } = await handle.read(bytes, 0, bytes.length, 0); check(signal);
    if (format) {
      while (bytesRead < bytes.length) {
        const read = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead); check(signal);
        if (!read.bytesRead) break;
        bytesRead += read.bytesRead;
      }
      const current = await handle.stat(); check(signal);
      if (bytesRead !== stat.size || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) throw fail('The document changed while being read. Read it again.', 'WORKSPACE_DOCUMENT_CHANGED');
    }
    const source = bytes.subarray(0, bytesRead);
    if (format === 'pdf') {
      const page = await readPdfPages(source, { startPage: args.startPage, pageCount: args.pageCount, startChar: args.startChar, charCount: pdfCharCount, signal });
      const pages = page.pages.map(({ hint, ...entry }) => ({ ...entry, ...(entry.textAvailable ? {} : { hint: 'No selectable text on this page. OCR is not included.' }) }));
      return { path: selected, size: stat.size, sha256: createHash('sha256').update(source).digest('hex'), ...page, pages, truncated: page.nextPage !== null };
    }
    if (format === 'xlsx') {
      const page = await readSpreadsheetInWorker(source, { ...args, signal });
      return { path: selected, size: stat.size, sha256: createHash('sha256').update(source).digest('hex'), ...page };
    }
    const word = format === 'docx' ? inspectWordDocument(source, { signal }) : null;
    if (format === 'docx' && !word) throw fail('This file is not a supported Word document. It may be damaged or use another format.', 'OFFICE_DOCUMENT_INVALID');
    const fileTruncated = stat.size > bytesRead, lines = (word ? word.text : decode(source, fileTruncated)).split(/\r?\n/);
    // The final fragment of a bounded prefix is not a complete file line.
    if (fileTruncated) lines.pop();
    if (startLine > lines.length && fileTruncated) throw fail('That line is beyond the complete lines in the first 1 MiB. Use run for large-file inspection.', 'WORKSPACE_READ_PREVIEW_LIMIT');
    const chosen = lines.slice(startLine - 1, startLine - 1 + lineCount);
    let page = { path: selected, size: stat.size, ...(word ? { format, reader: word.reader } : {}), ...(!fileTruncated ? {sha256:createHash('sha256').update(source).digest('hex')} : {}), startLine, endLine: startLine, content: '', truncated: fileTruncated, nextStartLine: null,
      ...(fileTruncated ? { note: 'Only complete lines from the first 1 MiB are available. Use run to inspect the remaining file.' } : { totalLines: lines.length }) };
    for (let index = 0; index < chosen.length; index++) {
      const lineNumber = startLine + index;
      const candidate = { ...page, endLine: lineNumber, content: `${page.content}${index ? '\n' : ''}${lineNumber}: ${chosen[index]}`, truncated: fileTruncated || lineNumber < lines.length, nextStartLine: lineNumber < lines.length ? lineNumber + 1 : null };
      // Keep whole lines and budget their serialized form, which can expand
      // quotes, backslashes and tabs beyond the bounded result size.
      if (candidate.content.length > 32000 || JSON.stringify(candidate).length > MAX_OUTPUT) {
        if (index === 0 && word) throw fail('This extracted DOCX line is too large for one bounded text result.', 'WORKSPACE_READ_LINE_TOO_LONG');
        if (index === 0) throw fail(`Line ${lineNumber} is too large for one bounded text result. Use run to inspect it.`, 'WORKSPACE_READ_LINE_TOO_LONG');
        return page;
      }
      page = candidate;
    }
    return page;
  } finally { await handle.close(); }
}
async function assertWritePreimage(selected, expectedHash, signal) {
  if (expectedHash === undefined) return;
  let handle;
  try {
    handle = await fs.open(selected, 'r');
    if (!(await handle.stat()).isFile()) throw fail('The expected write target is not a regular file.', 'WORKSPACE_WRITE_CONFLICT');
    const digest = createHash('sha256');
    for await (const bytes of handle.createReadStream({ autoClose: false })) { check(signal); digest.update(bytes); }
    check(signal);
    if (digest.digest('hex') !== expectedHash)
      throw fail('The file changed before this write. Read the current file and submit its current hash; no write occurred.', 'WORKSPACE_WRITE_CONFLICT');
  } catch (cause) {
    if (cause.code === 'ENOENT') cause = fail('The expected write target is missing. No file or parent directory was created.', 'WORKSPACE_WRITE_CONFLICT');
    throw Object.assign(cause, { actionDispatched: false });
  } finally { await handle?.close(); }
}
async function writeText(base, args, signal) {
  if (typeof args.text !== 'string' || Buffer.byteLength(args.text, 'utf8') > MAX_READ) throw fail('Supply UTF-8 text of at most 1 MiB.');
  const selected = location(base, args.path), parent = path.dirname(selected), temporary = path.join(parent, `.${path.basename(selected)}.relay-${randomUUID()}.tmp`);
  check(signal); await assertWritePreimage(selected, args.expectedHash, signal); await fs.mkdir(parent, { recursive: true });
  let mode = 0o600;
  try { const stat = await fs.stat(selected); if (!stat.isFile()) throw fail('The destination exists and is not a regular file.'); mode = stat.mode & 0o777; } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  try { await fs.writeFile(temporary, args.text, { encoding: 'utf8', mode, ...(signal ? { signal } : {}) }); check(signal); await fs.rename(temporary, selected); }
  catch (cause) { await fs.rm(temporary, { force: true }).catch(() => {}); throw cause; }
  return { path: selected, bytesWritten: Buffer.byteLength(args.text, 'utf8'), size: Buffer.byteLength(args.text, 'utf8'), sha256: createHash('sha256').update(args.text).digest('hex'), atomic: true, ...(args.expectedHash === undefined ? {} : { previousHash: args.expectedHash }) };
}
// Feedback never changes the saved effect or exposes a parser's content excerpt.
async function savedJsonFeedback(receipt, expectedHash) {
  if (typeof receipt.path !== 'string' || path.extname(receipt.path).toLowerCase() !== '.json') return receipt;
  const skipped = reason => ({ ...receipt, formatValidation: { format: 'json', performed: false, warning: `JSON validation was not performed: ${reason}. The save receipt is unchanged.` } });
  let handle;
  try {
    handle = await fs.open(receipt.path, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return skipped('the saved destination is not a regular file');
    if (stat.size > MAX_READ) return skipped('the saved file exceeds the 1 MiB validation limit');
    const bytes = Buffer.alloc(MAX_READ + 1); let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_READ) return skipped('the saved file exceeds the 1 MiB validation limit');
    const saved = bytes.subarray(0, length);
    if (expectedHash && createHash('sha256').update(saved).digest('hex') !== expectedHash) return skipped('the file changed after the save');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(saved); }
    catch { return skipped('the saved bytes could not be decoded as UTF-8'); }
    try { JSON.parse(text); }
    catch { return { ...receipt, formatValidation: { format: 'json', performed: true, valid: false, warning: 'Saved content is not valid JSON. The save succeeded; check the file syntax before relying on it.' } }; }
    return { ...receipt, formatValidation: { format: 'json', performed: true, valid: true } };
  } catch { return skipped('the saved file could not be checked'); }
  finally { await handle?.close().catch(() => {}); }
}
function literalSearchResult(value) {
  const hasMatches = Array.isArray(value.matches) ? value.matches.length > 0 : Boolean(value.output);
  return { ...value, matchMode: 'literal', ...(!hasMatches ? { note: 'No matches returned for this exact literal within the reported search coverage. Search separate terms with separate calls; | is literal text, not OR.' } : {}), ...(value.skippedFiles ? { nextAction: 'Some files were not searched. Pass the exact file path to search larger text files up to 16 MiB.' } : {}) };
}
async function fallbackSearch(base, args, signal, explicitFile) {
  const selected = location(base, args.path), limit = integer(args.limit, 50, 1, 100), query = args.caseSensitive ? args.query : args.query.toLowerCase(), matches = [];
  let scannedFiles = 0, scannedBytes = 0, scannedEntries = 0, skippedFiles = 0, truncated = false;
  async function visit(file, level = 0) {
    check(signal); if (matches.length >= limit || scannedFiles >= 2000 || scannedBytes >= SEARCH_BYTE_BUDGET || scannedEntries >= 10000 || level > 16) { truncated = true; return; }
    let stat; try { stat = await fs.stat(file); } catch (cause) { if (explicitFile) throw cause; skippedFiles++; truncated = true; return; }
    if (stat.isDirectory()) {
      if (explicitFile) throw fail('The selected file became a folder. Check the path and search again.');
      let children; try { children = await fs.readdir(file, { withFileTypes: true }); } catch { truncated = true; return; }
      for (const child of children) { scannedEntries++; if (!SKIP.has(child.name) && !child.isSymbolicLink()) await visit(path.join(file, child.name), level + 1); if (matches.length >= limit || scannedEntries >= 10000) { truncated = true; break; } }
      return;
    }
    if (!stat.isFile()) { if (explicitFile) throw fail('Choose a regular file to search.'); return; }
    if (stat.size > (explicitFile ? SEARCH_BYTE_BUDGET : 512 * 1024) || scannedBytes + stat.size > SEARCH_BYTE_BUDGET) {
      if (explicitFile) throw searchFileTooLarge();
      skippedFiles++; truncated = true; return;
    }
    const allowance = Math.min(explicitFile ? SEARCH_BYTE_BUDGET : 512 * 1024, SEARCH_BYTE_BUDGET - scannedBytes);
    let lines;
    try {
      const handle = await fs.open(file, 'r');
      try {
        const current = await handle.stat();
        if (!current.isFile()) throw fail('Choose a regular file to search.');
        if (current.size > allowance) throw searchFileTooLarge();
        const bytes = Buffer.alloc(current.size + 1);
        let count = 0;
        while (count < bytes.length) {
          check(signal);
          const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
          if (!bytesRead) break;
          count += bytesRead;
        }
        const after = await handle.stat();
        check(signal);
        if (count !== current.size || after.size !== current.size || after.mtimeMs !== current.mtimeMs)
          throw fail('The file changed while it was searched. Search it again.', 'WORKSPACE_SEARCH_FILE_CHANGED');
        lines = decode(bytes.subarray(0, count)).split(/\r?\n/);
        scannedFiles++;
        scannedBytes += count;
      } finally { await handle.close(); }
    } catch (cause) { check(signal); if (explicitFile) throw cause; skippedFiles++; truncated = true; return; }
    for (let index = 0; index < lines.length; index++) if ((args.caseSensitive ? lines[index] : lines[index].toLowerCase()).includes(query)) { matches.push({ path: file, line: index + 1, text: lines[index].slice(0, 500) }); if (matches.length > limit) { truncated = true; break; } }
  }
  await visit(selected); return literalSearchResult({ path: selected, query: args.query, engine: 'filesystem', matches: matches.slice(0, limit), scannedFiles, skippedFiles, truncated });
}
const searchFileTooLarge = () => fail('This file exceeds the 16 MiB content search limit. Use the run action to search this exact file.', 'WORKSPACE_SEARCH_FILE_TOO_LARGE');
async function searchTextResult(base, args, signal, rgCommand, reportCoverage) {
  if (typeof args.query !== 'string' || !args.query || args.query.length > 2000 || /[\r\n\0]/.test(args.query)) throw fail('Enter a literal, single-line search query of 1 to 2,000 characters.');
  const selected = location(base, args.path), limit = integer(args.limit, 50, 1, 100);
  const target = args.path === undefined ? null : await fs.stat(selected);
  const explicitFile = target?.isFile() === true;
  if (target && !explicitFile && !target.isDirectory()) throw fail('Choose a regular file or folder to search.');
  if (explicitFile && target.size > SEARCH_BYTE_BUDGET) throw searchFileTooLarge();
  const report = (body, matchCount) => result(body, true, reportCoverage && (resultPreviewOnly => {
    reportCoverage({
      searchScope: explicitFile ? 'explicit-file' : target ? 'explicit-folder' : args.cwd ? 'explicit-working-folder' : 'working-folder',
      searchBackend: body.engine,
      searchRoute: body.engine === 'filesystem' ? 'rg-unavailable' : 'rg',
      matchLimit: limit,
      caseSensitive: Boolean(args.caseSensitive),
      resultPreviewOnly,
      ...(!resultPreviewOnly && Number.isSafeInteger(matchCount) ? { returnedMatches: matchCount } : {}),
      ...(Number.isSafeInteger(body.scannedFiles) ? { scannedFiles: body.scannedFiles } : {}),
      ...(Number.isSafeInteger(body.skippedFiles) ? { skippedFiles: body.skippedFiles } : {}),
      perFileByteLimit: explicitFile ? SEARCH_BYTE_BUDGET : body.engine === 'filesystem' ? 512 * 1024 : 1024 * 1024,
      ...(body.engine === 'rg' ? { searchTimeoutMs: 10000, searchCaptureChars: 32000 } : { searchScanByteLimit: SEARCH_BYTE_BUDGET }),
      truncated: resultPreviewOnly || body.truncated === true,
      ...(body.engine === 'rg' ? { timedOut: body.timedOut === true } : {})
    });
  }));
  const parameters = ['--line-number', '--no-heading', '--color', 'never', '--fixed-strings', '--hidden', '--max-count', String(limit + 1), '--max-filesize', explicitFile ? '16M' : '1M', ...(!args.caseSensitive ? ['--ignore-case'] : []), ...[...SKIP].flatMap(name => ['--glob', `!${name}/**`]), '--', args.query, selected];
  try {
    const [executable, ...prefix] = Array.isArray(rgCommand) ? rgCommand : [rgCommand];
    const found = await processRun(executable, [...prefix, ...parameters], { cwd: base, signal, timeoutMs: 10000, outputLimit: 32000 });
    if (found.timedOut) return report(literalSearchResult({ path: selected, query: args.query, engine: 'rg', output: found.stdout, truncated: true, timedOut: true }));
    if (![0, 1].includes(found.exitCode)) throw fail(`Search failed: ${found.stderr.slice(0, 1000) || `exit ${found.exitCode}`}`);
    const lines = found.stdout.trimEnd().split(/\r?\n/).filter(Boolean);
    return report(literalSearchResult({ path: selected, query: args.query, engine: 'rg', output: lines.slice(0, limit).join('\n'), truncated: found.truncated || lines.length > limit }), found.truncated ? undefined : Math.min(lines.length, limit));
  } catch (cause) { if (cause.code !== 'ENOENT') throw cause; const body = await fallbackSearch(base, args, signal, explicitFile); return report(body, body.matches.length); }
}

export const WORKSPACE_PDF_READ_FIELDS = {
  startPage: { type: 'integer', minimum: 1, maximum: PDF_LIMITS.pages, description: 'PDF read: first page (1-based); use nextPage to continue.' }, pageCount: { type: 'integer', minimum: 1, maximum: PDF_LIMITS.readPages, description: 'PDF read: maximum pages (default 3).' },
  startChar: { type: 'integer', minimum: 0, maximum: PDF_LIMITS.pageChars, description: 'PDF read: starting offset within the first page (0-based); use nextChar with nextPage to continue.' }, charCount: { type: 'integer', minimum: 1, maximum: PDF_RESULT_CHARS, description: 'PDF read: total character budget across returned pages (default 5000).' },
};
export const WORKSPACE_XLSX_READ_FIELDS = {
  sheet: { type: 'string', description: 'XLSX read: exact worksheet name; omit to list worksheets.' },
  startRow: { type: 'integer', minimum: 1, maximum: XLSX_ROWS, description: 'XLSX read: first worksheet row, 1-based.' },
  rowCount: { type: 'integer', minimum: 1, maximum: 50, description: 'XLSX read: row range length (default 20); continue using nextRow.' },
  startColumn: { type: 'integer', minimum: 1, maximum: XLSX_COLUMNS, description: 'XLSX read: first worksheet column, 1-based.' },
  columnCount: { type: 'integer', minimum: 1, maximum: 20, description: 'XLSX read: column range length (default 12); continue using nextColumn.' },
};
export const WORKSPACE_TOOL = {
  type: 'function', name: 'relay_workspace',
  description: "Read local file contents, search literal text inside files, edit files when requested, or run commands. The configured working folder supplies the starting cwd; it is not a filesystem access boundary. Use a user-provided absolute input path directly, including outside that folder. OS permissions still apply.\nlist returns folder entries. read returns numbered UTF-8/DOCX lines, PDF page text, or XLSX sheets and stored cells. PDF reading has no OCR. Continue with the returned line, page, character or cell cursors.\nwrite replaces a file with text and returns its SHA-256. append adds one text chunk to an existing file atomically, requiring expectedHash from write/append/stat; it returns the new SHA-256. stat returns the complete file size and SHA-256 without returning content. patch replaces one unique oldText with newText; expectedHash checks the current file. patch_history reads saved changes; undo_patch restores a patch only if the file still matches its result.\nsearch matches one literal string inside files. For filenames or paths use relay_find_files. list/search cover path, or cwd when path is omitted; an empty result describes that location only.\nrun executes command with timeoutMs and returns stdout, stderr and exitCode. Windows runs Windows PowerShell (powershell.exe, not cmd.exe, Bash or pwsh); use cwd for the working directory, PowerShell syntax and explicit $LASTEXITCODE checks. Other systems use /bin/sh.\npath is one filename or folder, never a list. Relative paths use cwd or the configured working folder; absolute paths are supported. Changes apply immediately.",
  inputSchema: { type: 'object', properties: {
    action: { type: 'string', enum: ['list', 'read', 'stat', 'write', 'append', 'patch', 'patch_history', 'undo_patch', 'search', 'run'] }, path: { type: 'string', description: "One local file or folder path. Use a supplied absolute path directly, including outside cwd. For scalar file operations supply one path per call; for bulk extraction across files use folder-scoped search or one bounded run command. Relative paths use cwd." }, cwd: { type: 'string', description: "Starting directory for commands and relative paths, relative to the run folder or absolute. It is not a filesystem access boundary or an input-search limit." },
    oldText: { type: 'string', description: 'Exact unique existing text for a targeted patch. Surrounding content is preserved.' }, newText: { type: 'string', description: 'Replacement for that span; empty deletes the span.' }, expectedHash: { type: 'string', description: 'Required lowercase SHA-256 of the current file for append. Optional for write or patch. A stale hash or missing expected file fails.' }, patchId: { type: 'string', description: 'Receipt ID for patch_history or undo_patch.' },
    text: { type: 'string', description: 'Complete UTF-8 file contents for write, or only the next nonempty UTF-8 chunk for append. For a long deliverable, save the first section with write and subsequent sections with append.' }, query: { type: 'string', description: 'One exact literal search string. search matches file contents; use relay_find_files for filename/path matching. | is not OR and regex is not interpreted.' }, caseSensitive: { type: 'boolean' },
    command: { type: 'string', description: 'One Windows PowerShell (powershell.exe) command on Windows or /bin/sh command elsewhere, up to 20,000 characters. Set cwd instead of chaining directory changes. Windows PowerShell does not support the PowerShell 7 && operator or Unix head. Save larger scripts to a file and run that file.' }, timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 },
    startLine: { type: 'integer', minimum: 1, maximum: 200000 }, lineCount: { type: 'integer', minimum: 1, maximum: 1500 },
    ...WORKSPACE_PDF_READ_FIELDS,
    ...WORKSPACE_XLSX_READ_FIELDS,
    limit: { type: 'integer', minimum: 1, maximum: 300, description: 'Maximum entries: list accepts up to 300; search accepts up to 100.' }, depth: { type: 'integer', enum: [0, 1, 2, 3], minimum: 0, maximum: 3, description: 'list only: nesting depth 0, 1, 2 or 3. Filename discovery uses relay_find_files, which recurses automatically.' },
  }, required: ['action'], additionalProperties: false },
};
export const WORKSPACE_INSTRUCTIONS = "\n\nLOCAL FILES AND COMMANDS\nRead known absolute paths via relay_workspace, including outside cwd. Discover partial locations with relay_find_files using relevant path/roots. A cwd miss is not a computer-wide absence: expand from the supplied path or the list discovery metadata.\nUse relay_files for a listed chat attachment ID; local paths need no attachment. read/write/patch/stat take one path per call. Across many files, prefer folder-scoped search or one read-only run command returning bounded matching lines; correct PowerShell syntax before fallback to large reads. Follow find cursors; searchComplete, errors, skippedCount and roots bound claims of search coverage.\nFor long file deliverables, write early, append only new sections with returned sha256 as expectedHash, and use stat for final hash. Verify the file; report its path instead of echoing it. Honor inline/read-only scope and never write internal reasoning. For edits read, patch and reread; refresh after a hash conflict. Check command exitCode and actual output. For machine-readable artifacts, verify saved bytes using the actual consumer/parser, not merely a shell reader. On Windows PowerShell 5.1, Set-Content -Encoding utf8 adds a BOM that Node JSON.parse rejects; write UTF-8 without BOM and validate with Node. Cancellation stops a command\u0027s child tree; detached previews require redirected logs, PID, stop command and URL check. Follow attached adapter schemas.\nFor code repairs, a missing package.json does not prevent node --test when test files exist. For substantial multi-module or stateful repairs, check the written contract: positive cases, invalid inputs and specified error semantics, unchanged state on rejection, snapshot/restore integrity, retries and uncertain effects, and cross-module boundaries. Verify highest-risk missing cases against saved code, not reviewer claims. Do not guess undocumented error labels, invent requirements or modify protected tests; do not demand an exhaustive matrix for a small change. Passing tests prove their checked scope only. Check important missing concurrency/retry/failure paths proportionately and report untested requirements accurately.\n";
// Structured file protection is an application guard, not a shell sandbox.
async function canonicalMutationPath(file) {
  let current = path.resolve(file), suffix = [];
  for (;;) {
    try { return path.join(await fs.realpath(current), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current)); current = parent;
    }
  }
}
const mutationPathKey = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
// Atomic managed snapshots use UUID siblings; protecting only the final name permits staging-file substitution.
const managedStagingSibling = (target, root) => target.startsWith(root + '.') && /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.bak)?\.tmp$/i.test(target.slice(root.length));
async function assertUnprotectedMutation(file, protectedPaths) {
  if (!protectedPaths.length) return;
  const targetKeys = [mutationPathKey(file), mutationPathKey(await canonicalMutationPath(file))];
  for (const protectedPath of protectedPaths) {
    const protectedKeys = [mutationPathKey(protectedPath), mutationPathKey(await canonicalMutationPath(protectedPath))];
    if (targetKeys.some(target => protectedKeys.some(protectedKey => target === protectedKey || managedStagingSibling(target, protectedKey) || target.startsWith(protectedKey.endsWith(path.sep) ? protectedKey : protectedKey + path.sep)))) {
      throw fail('This managed context file is read-only to file tools. Use the owner editor for user-authored content; release-owned skills change only with the application release.', 'WORKSPACE_PROTECTED_PATH');
    }
  }
}
export function createWorkspaceToolHandler({ cwd, signal, onEvent = () => {}, maxCalls = null, rgCommand = 'rg', patchStore, runId, nodeId, restartOriginToken, protectedPaths = [], fileSearchScope, filenameSearchTool = 'relay_find_files', captureSearchCoverage = false } = {}) {
  if (!['relay_find_files', 'relay_workspace.find'].includes(filenameSearchTool)) throw fail('Use an attached filename-search capability.');
  const filenameSearchRoute = filenameSearchTool === 'relay_workspace.find' ? 'relay_workspace action find' : 'relay_find_files';
  if (!cwd || !path.isAbsolute(cwd)) throw fail('Workspace tools need an absolute working folder.');
  if (restartOriginToken !== undefined && (typeof restartOriginToken !== 'string' || !/^[a-f0-9]{64}$/.test(restartOriginToken))) throw fail('Use an executor-owned restart origin.');
  if (maxCalls !== null && (!Number.isSafeInteger(maxCalls) || maxCalls < 1)) throw fail('Workspace action limit must be a positive whole number, or null for no application limit.');
  if (!Array.isArray(protectedPaths) || protectedPaths.some(file => typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0'))) throw fail('Protected paths must be absolute file paths.');
  protectedPaths = [...protectedPaths];
  let calls = 0;
  const handler = async (call, context = {}) => {
    const effectiveSignal = context.signal ? AbortSignal.any([signal, context.signal].filter(Boolean)) : signal;
    check(effectiveSignal);
    if (!['relay_workspace', FIND_FILES_TOOL.name].includes(call.name)) throw fail('Unknown workspace tool.');
    if (maxCalls !== null && ++calls > maxCalls) return result({ error: 'The configured workspace action limit was reached. Return a checkpoint or change that limit before continuing.', actionDispatched: false }, false);
    let actionStarted = false;
    try {
      let args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
      if (call.name === FIND_FILES_TOOL.name) args = { ...validateFileSearchCall(args), action: 'find' };
      if (!args || typeof args !== 'object' || !['list', 'read', 'stat', 'write', 'append', 'patch', 'patch_history', 'undo_patch', 'search', 'find', 'run'].includes(args.action)) throw fail(`Choose ${WORKSPACE_TOOL.inputSchema.properties.action.enum.join(', ')}. For filename/path discovery use ${filenameSearchRoute}.`);
      const base = args.cwd ? location(cwd, args.cwd) : cwd;
      if (!(await fs.stat(base)).isDirectory()) throw fail('The working folder is not a directory.');
      // Validate pure inputs before any operation admission or filesystem effect.
      if (args.path !== undefined) location(base, args.path);
      if (args.action === 'list' && args.depth !== undefined && (!Number.isInteger(args.depth) || args.depth < 0 || args.depth > 3)) throw fail(`relay_workspace list: depth must be 0, 1, 2 or 3. For recursive filename matching use ${filenameSearchRoute} with query.`, 'WORKSPACE_DEPTH_INVALID');
      if (args.action === 'append') validateAppend(args);
      if (args.action === 'stat' && (typeof args.path!=='string'||!args.path.trim())) throw fail('Supply one exact file path for stat.');
      if (args.action === 'write' && (typeof args.text !== 'string' || Buffer.byteLength(args.text, 'utf8') > MAX_READ)) throw fail('Supply UTF-8 text of at most 1 MiB.');
      if (args.action === 'write' && args.expectedHash !== undefined && (typeof args.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedHash))) throw fail('Supply expectedHash as a lowercase SHA-256, or omit it for an unguarded write.', 'WORKSPACE_WRITE_HASH_INVALID');
      if (['patch','patch_history','undo_patch'].includes(args.action) && !patchStore) throw fail('Durable patch history is unavailable for this execution.');
      if (args.action === 'run') {
        if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 20000 || args.command.includes('\0')) throw fail('Enter a shell command of 1 to 20,000 characters.');
        integer(args.timeoutMs, 30000, 100, 120000);
      }
      if (['write', 'append', 'patch', 'undo_patch'].includes(args.action) && protectedPaths.length) {
        const target = args.action === 'undo_patch' ? (await patchStore.get(args.patchId)).path : location(base, args.path);
        await assertUnprotectedMutation(target, protectedPaths);
      }
      if (context.operationDescriptor || context.onOperationDispatch) {
        const current = await handler.describeOperation(call, { ...context, signal: effectiveSignal });
        if (context.operationDescriptor && current.operationKey !== context.operationDescriptor.operationKey) throw Object.assign(new Error('The workspace operation target changed after admission.'), { code: 'OPERATION_DESCRIPTOR_CHANGED', actionDispatched: false });
        if (context.onOperationDispatch) try { await context.onOperationDispatch(current); } catch (error) { throw Object.assign(error, { actionDispatched: false }); }
      }
      // Admission can await callbacks; re-resolve aliases and undo targets afterward.
      if (['write', 'append', 'patch', 'undo_patch'].includes(args.action) && protectedPaths.length) {
        const target = args.action === 'undo_patch' ? (await patchStore.get(args.patchId)).path : location(base, args.path);
        await assertUnprotectedMutation(target, protectedPaths);
      }
      if (effectiveSignal?.aborted) throw Object.assign(aborted(), { actionDispatched: false });
      actionStarted = true;
      onEvent({ type: 'workspace.action', action: args.action, message: `Workspace · ${args.action}`, ...(args.path ? { path: location(base, args.path) } : {}) });
      if (args.action === 'list') return result(await listFiles(base,args,effectiveSignal,filenameSearchRoute));
      if (args.action === 'read') return result(await readLocalFile(base, args, effectiveSignal));
      if (args.action === 'stat') return result(await inspectWorkspaceFile(location(base,args.path),{signal:effectiveSignal}));
      if (['write','append'].includes(args.action)) {
        const target=location(base,args.path),key=await canonicalMutationPath(target);
        return await withWorkspaceMutationLock(key,async()=>{
          check(effectiveSignal);
          await assertUnprotectedMutation(target,protectedPaths);
          if(await canonicalMutationPath(target)!==key)throw Object.assign(fail('The workspace destination changed while waiting for its mutation lock.','OPERATION_DESCRIPTOR_CHANGED'),{actionDispatched:false});
          const receipt=args.action==='append'?await appendWorkspaceChunk(target,args,effectiveSignal):await writeText(base,args,effectiveSignal);
          return result(await savedJsonFeedback(receipt,receipt.sha256));
        });
      }
      if (['patch','patch_history','undo_patch'].includes(args.action)) {
        if (!patchStore) throw fail('Durable patch history is unavailable for this execution.');
        if (args.action === 'patch_history') return result(args.patchId ? await patchStore.get(args.patchId) : await patchStore.list({cwd:base,limit:integer(args.limit,50,1,100)}));
        const target=args.action==='undo_patch'?(await patchStore.get(args.patchId)).path:location(base,args.path);
        const key=await canonicalMutationPath(target);
        const receipt=await withWorkspaceMutationLock(key,async()=>{
          check(effectiveSignal);await assertUnprotectedMutation(target,protectedPaths);
          if(await canonicalMutationPath(target)!==key)throw Object.assign(fail('The workspace destination changed while waiting for its mutation lock.','OPERATION_DESCRIPTOR_CHANGED'),{actionDispatched:false});
          return args.action==='patch'?patchStore.patch({cwd:base,path:args.path,oldText:args.oldText,newText:args.newText,expectedHash:args.expectedHash,signal:effectiveSignal,runId,nodeId}):patchStore.undo(args.patchId,{signal:effectiveSignal,source:'agent',runId,nodeId});
        });
        onEvent({type:'workspace.patch',action:args.action,path:receipt.path,patchId:receipt.id,message:args.action==='patch'?'Applied file patch':'Undid file patch'});
        return result(receipt.status === 'applied' ? await savedJsonFeedback(receipt, receipt.afterHash) : receipt);
      }
      if (args.action === 'find') {
        const found = await createFileSearch({ cwd: base, scope: fileSearchScope || runId || cwd })(args, effectiveSignal);
        const view={...found,searchDomain:'filename-and-path-only',searchScopeNotice:'No file contents were searched. For a literal inside a known file use relay_workspace action search with path and query. A filename/path miss does not establish absence of text inside a file.'};
        if (call.name !== FIND_FILES_TOOL.name || !found.matches?.length) return result(view);
        const readMatch = {tool:'relay_workspace', arguments:{action:'read',path:found.matches.length===1?found.matches[0].path:'<selected matches[].path>'}};
        return result({readMatch, readHint:'If a match is the requested file, read its local path now. It is not a chat attachment.', ...view});
      }
      if (args.action === 'search') return await searchTextResult(base, args, effectiveSignal, rgCommand,
        captureSearchCoverage ? coverage => onEvent({ type:'workspace.search.coverage', tool:'relay_workspace', action:'search', callId:call.callId, ...coverage }) : undefined);
      if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 20000 || args.command.includes('\0')) throw fail('Enter a shell command of 1 to 20,000 characters.');
      const timeoutMs = integer(args.timeoutMs, 30000, 100, 120000), windows = process.platform === 'win32';
      const executable = windows ? 'powershell.exe' : '/bin/sh';
      const parameters = windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();$OutputEncoding=[Console]::OutputEncoding;\n${args.command}`] : ['-c', args.command];
      // A workspace command is a fresh invocation, not a child test-file worker.
      // NODE_TEST_CONTEXT from a parent Node test runner makes a nested
      // `node --test` silently skip its tests and falsely exit successfully.
      const childEnv = { ...process.env };
      for (const key of Object.keys(childEnv)) if (key.toUpperCase() === 'NODE_TEST_CONTEXT') delete childEnv[key];
      const ran = await processRun(executable, parameters, { cwd: base, signal: effectiveSignal, timeoutMs, restartOriginToken, childEnv });
      return attachWorkspaceCommandOutcome(call,result({ ...ran, command: args.command.slice(0, 1000), shell: windows ? 'powershell' : 'sh' }, !ran.timedOut && ran.exitCode === 0 && ran.signal === null),ran);
    } catch (cause) { if (effectiveSignal?.aborted || cause.name === 'AbortError') throw Object.assign(aborted(), !actionStarted || cause.actionDispatched === false ? { actionDispatched: false } : {}); return result({ error: cause.message, code: cause.code || 'WORKSPACE_ERROR', ...(cause.launch ? { launch: cause.launch, recovery: cause.recovery } : {}), ...(!actionStarted ? { actionDispatched: false } : typeof cause.actionDispatched === 'boolean' ? { actionDispatched: cause.actionDispatched } : {}) }, false); }
  };
  handler.describeOperation = async (call, context = {}) => {
    const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
    const receipt = args?.action === 'undo_patch' && patchStore ? await patchStore.get(args.patchId) : null;
    return describeHostOperation(call, { cwd, signal: context.signal || signal,
      ...(receipt?.path ? { workspaceObservation: { patchId: args.patchId, path: receipt.path } } : {}) });
  };
  handler.operationAdapter = 'relay_workspace';
  handler.normalizeOperationResult = (result, context = {}) => normalizeHostOperationResult(result, { ...context, cwd, signal: context.signal || signal });
  return handler;
}
