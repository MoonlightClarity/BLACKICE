import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { DESKTOP_RESTART_ORIGIN_ENV } from './desktop-restart-origin.mjs';

const MAX_OUTPUT = 40000, MAX_CAPTURE = 35000, MAX_READ = 1024 * 1024;
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
const result = (value, success = true) => {
  let text = JSON.stringify(value);
  if (text.length > MAX_OUTPUT) {
    const metadata = Object.fromEntries(['path', 'cwd', 'exitCode', 'signal', 'timedOut', 'durationMs', 'engine'].filter(key => value[key] !== undefined).map(key => [key, typeof value[key] === 'string' ? value[key].slice(0, 2000) : value[key]]));
    let preview = text.slice(0, MAX_OUTPUT - 1000);
    text = JSON.stringify({ ...metadata, truncated: true, message: 'Result exceeded the output limit. Narrow the path, query, or line range.', preview });
    while (text.length > MAX_OUTPUT) { preview = preview.slice(0, Math.floor(preview.length * .8)); text = JSON.stringify({ ...metadata, truncated: true, message: 'Result exceeded the output limit. Narrow the path, query, or line range.', preview }); }
  }
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

/** Capture bounded output while continuing to drain both pipes. */
async function processRun(executable, args, { cwd, signal, timeoutMs = 30000, outputLimit = MAX_CAPTURE, restartOriginToken } = {}) {
  check(signal); const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // Only the direct executor may supply this one-command origin. Ordinary
    // workspace actions and search subprocesses never inherit a stale binding.
    for (const key of Object.keys(env)) if (key.toUpperCase() === DESKTOP_RESTART_ORIGIN_ENV) delete env[key];
    if (restartOriginToken !== undefined) env[DESKTOP_RESTART_ORIGIN_ENV] = restartOriginToken;
    const child = spawn(executable, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
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
      if (spawnError) { reject(spawnError); return; }
      if (cancelled || signal?.aborted) { reject(aborted()); return; }
      resolve({ cwd, exitCode, signal: exitSignal, stdout, stderr, truncated, timedOut, durationMs: Date.now() - startedAt });
    });
    if (signal?.aborted) onAbort();
  });
}

async function listFiles(base, args, signal) {
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
  await visit(selected, 0); return { path: selected, entries, truncated };
}
async function readText(base, args, signal) {
  const selected = location(base, args.path), startLine = integer(args.startLine, 1, 1, 200000), lineCount = integer(args.lineCount, 200, 1, 1500);
  check(signal); const handle = await fs.open(selected, 'r');
  try {
    const stat = await handle.stat(); if (!stat.isFile()) throw fail('Choose a regular file to read.');
    const bytes = Buffer.alloc(Math.min(stat.size, MAX_READ));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0); check(signal);
    const fileTruncated = stat.size > bytesRead, lines = decode(bytes.subarray(0, bytesRead), fileTruncated).split(/\r?\n/);
    // The final fragment of a bounded prefix is not a complete file line.
    if (fileTruncated) lines.pop();
    if (startLine > lines.length && fileTruncated) throw fail('That line is beyond the complete lines in the first 1 MiB. Use run for large-file inspection.', 'WORKSPACE_READ_PREVIEW_LIMIT');
    const chosen = lines.slice(startLine - 1, startLine - 1 + lineCount);
    let page = { path: selected, size: stat.size, ...(!fileTruncated ? {sha256:createHash('sha256').update(bytes.subarray(0,bytesRead)).digest('hex')} : {}), startLine, endLine: startLine, content: '', truncated: fileTruncated, nextStartLine: null,
      ...(fileTruncated ? { note: 'Only complete lines from the first 1 MiB are available. Use run to inspect the remaining file.' } : { totalLines: lines.length }) };
    for (let index = 0; index < chosen.length; index++) {
      const lineNumber = startLine + index;
      const candidate = { ...page, endLine: lineNumber, content: `${page.content}${index ? '\n' : ''}${lineNumber}: ${chosen[index]}`, truncated: fileTruncated || lineNumber < lines.length, nextStartLine: lineNumber < lines.length ? lineNumber + 1 : null };
      // Keep whole lines and budget their serialized form, which can expand
      // quotes, backslashes and tabs beyond the bounded result size.
      if (candidate.content.length > 32000 || JSON.stringify(candidate).length > MAX_OUTPUT) {
        if (index === 0) throw fail(`Line ${lineNumber} is too large for one bounded text result. Use run to inspect it.`, 'WORKSPACE_READ_LINE_TOO_LONG');
        return page;
      }
      page = candidate;
    }
    return page;
  } finally { await handle.close(); }
}
async function writeText(base, args, signal) {
  if (typeof args.text !== 'string' || Buffer.byteLength(args.text, 'utf8') > MAX_READ) throw fail('Supply UTF-8 text of at most 1 MiB.');
  const selected = location(base, args.path), parent = path.dirname(selected), temporary = path.join(parent, `.${path.basename(selected)}.relay-${randomUUID()}.tmp`);
  check(signal); await fs.mkdir(parent, { recursive: true });
  let mode = 0o600;
  try { const stat = await fs.stat(selected); if (!stat.isFile()) throw fail('The destination exists and is not a regular file.'); mode = stat.mode & 0o777; } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  try { await fs.writeFile(temporary, args.text, { encoding: 'utf8', mode, ...(signal ? { signal } : {}) }); check(signal); await fs.rename(temporary, selected); }
  catch (cause) { await fs.rm(temporary, { force: true }).catch(() => {}); throw cause; }
  return { path: selected, bytesWritten: Buffer.byteLength(args.text, 'utf8'), atomic: true };
}
async function fallbackSearch(base, args, signal) {
  const selected = location(base, args.path), limit = integer(args.limit, 50, 1, 100), query = args.caseSensitive ? args.query : args.query.toLowerCase(), matches = [];
  let scannedFiles = 0, scannedBytes = 0, scannedEntries = 0, truncated = false;
  async function visit(file, level = 0) {
    check(signal); if (matches.length >= limit || scannedFiles >= 2000 || scannedBytes >= 16 * 1024 * 1024 || scannedEntries >= 10000 || level > 16) { truncated = true; return; }
    let stat; try { stat = await fs.stat(file); } catch { return; }
    if (stat.isDirectory()) {
      let children; try { children = await fs.readdir(file, { withFileTypes: true }); } catch { return; }
      for (const child of children) { scannedEntries++; if (!SKIP.has(child.name) && !child.isSymbolicLink()) await visit(path.join(file, child.name), level + 1); if (matches.length >= limit || scannedEntries >= 10000) { truncated = true; break; } }
      return;
    }
    if (!stat.isFile() || stat.size > 512 * 1024) return;
    scannedFiles++; scannedBytes += stat.size;
    let lines; try { lines = decode(await fs.readFile(file, signal ? { signal } : {})).split(/\r?\n/); } catch (cause) { check(signal); return; }
    for (let index = 0; index < lines.length; index++) if ((args.caseSensitive ? lines[index] : lines[index].toLowerCase()).includes(query)) { matches.push({ path: file, line: index + 1, text: lines[index].slice(0, 500) }); if (matches.length >= limit) { truncated = true; break; } }
  }
  await visit(selected); return { path: selected, query: args.query, engine: 'filesystem', matches, scannedFiles, truncated };
}
async function searchText(base, args, signal, rgCommand) {
  if (typeof args.query !== 'string' || !args.query || args.query.length > 2000 || /[\r\n\0]/.test(args.query)) throw fail('Enter a literal, single-line search query of 1 to 2,000 characters.');
  const selected = location(base, args.path), limit = integer(args.limit, 50, 1, 100);
  const parameters = ['--line-number', '--no-heading', '--color', 'never', '--fixed-strings', '--hidden', '--max-count', String(limit), '--max-filesize', '1M', ...(!args.caseSensitive ? ['--ignore-case'] : []), ...[...SKIP].flatMap(name => ['--glob', `!${name}/**`]), '--', args.query, selected];
  try {
    const found = await processRun(rgCommand, parameters, { cwd: base, signal, timeoutMs: 10000, outputLimit: 32000 });
    if (found.timedOut) return { path: selected, query: args.query, engine: 'rg', output: found.stdout, truncated: true, timedOut: true };
    if (![0, 1].includes(found.exitCode)) throw fail(`Search failed: ${found.stderr.slice(0, 1000) || `exit ${found.exitCode}`}`);
    const lines = found.stdout.trimEnd().split(/\r?\n/).filter(Boolean);
    return { path: selected, query: args.query, engine: 'rg', output: lines.slice(0, limit).join('\n'), truncated: found.truncated || lines.length > limit };
  } catch (cause) { if (cause.code !== 'ENOENT') throw cause; return fallbackSearch(base, args, signal); }
}

export const WORKSPACE_TOOL = {
  type: 'function', name: 'relay_workspace',
  description: 'Work directly with local files and commands. List folders, read UTF-8 text with line numbers, atomically write files, search literal text (ripgrep when installed), or run a real shell command with a bounded timeout and captured exit code. Relative paths resolve from the configured working folder; explicit absolute paths and working folders are supported. Windows commands use PowerShell; other systems use sh. Read before editing and inspect command exit codes. Use patch with exact unique oldText/newText for focused edits; it preserves surrounding content and records before/after for patch_history and undo_patch. These apply immediately. Undo refuses to overwrite newer file edits.',
  inputSchema: { type: 'object', properties: {
    action: { type: 'string', enum: ['list', 'read', 'write', 'patch', 'patch_history', 'undo_patch', 'search', 'run'] }, path: { type: 'string' }, cwd: { type: 'string', description: 'Optional working folder for this action, relative to the run folder or absolute.' },
    oldText: { type: 'string', description: 'Exact unique existing text for a targeted patch. Surrounding content is preserved.' }, newText: { type: 'string', description: 'Replacement for that span; empty deletes the span.' }, expectedHash: { type: 'string', description: 'Optional SHA-256 of the current UTF-8 file.' }, patchId: { type: 'string', description: 'Receipt ID for patch_history or undo_patch.' },
    text: { type: 'string', description: 'Complete UTF-8 file contents for write.' }, query: { type: 'string', description: 'Literal text for search.' }, caseSensitive: { type: 'boolean' },
    command: { type: 'string', description: 'PowerShell command on Windows; sh command elsewhere.' }, timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 },
    startLine: { type: 'integer', minimum: 1, maximum: 200000 }, lineCount: { type: 'integer', minimum: 1, maximum: 1500 }, limit: { type: 'integer', minimum: 1, maximum: 300, description: 'Maximum entries: list accepts up to 300; search accepts up to 100.' }, depth: { type: 'integer', minimum: 0, maximum: 3 },
  }, required: ['action'], additionalProperties: false },
};
export const WORKSPACE_INSTRUCTIONS = '\n\nLOCAL WORKSPACE\nUse relay_workspace to inspect project files, make focused edits, search existing code, and run real verification commands. Relative paths use the configured working folder. Explicit absolute paths are supported. Read relevant files before changing them. Prefer action patch with exact unique oldText and newText for focused edits; use write for complete new files or deliberate full rewrites. Patch returns a durable receipt ID and hashes. Use patch_history to inspect saved before/after and undo_patch with patchId to reverse a change. No approval step is required; an ambiguous oldText or changed file must be re-read, not force-overwritten. The run action uses PowerShell on Windows and sh elsewhere; check its actual exitCode and captured output, and use timeoutMs up to 120000 for longer commands. A timed-out or cancelled command is terminated with its child process tree. When the user asks to leave a local preview or server running, use relay_workspace to launch a detached project process with redirected log files, an owned PID record and an explicit stop command. A built-in terminal session can end when the agent turn completes; do not present it as a durable preview. Verify the local URL and leave restart instructions. Output is bounded: narrow a search or file line range when truncated. Use relay_desktop for supported Windows accessibility actions with current element refs, relay_apps for compatible private application sessions, and the contained relay_browser for website actions. Authorized application launches and other task-relevant operating system commands may use run. The relay_apps compatibility catalog does not restrict which applications the user may ask to launch or automate through another available adapter. Describe actual adapter capabilities and results, preserve unrelated user work, and respect stop, detach and cancellation across tools. Do not claim a command or edit succeeded without checking its result.\n';
export function createWorkspaceToolHandler({ cwd, signal, onEvent = () => {}, maxCalls = null, rgCommand = 'rg', patchStore, runId, nodeId, restartOriginToken } = {}) {
  if (!cwd || !path.isAbsolute(cwd)) throw fail('Workspace tools need an absolute working folder.');
  if (restartOriginToken !== undefined && (typeof restartOriginToken !== 'string' || !/^[a-f0-9]{64}$/.test(restartOriginToken))) throw fail('Use an executor-owned restart origin.');
  if (maxCalls !== null && (!Number.isSafeInteger(maxCalls) || maxCalls < 1)) throw fail('Workspace action limit must be a positive whole number, or null for no application limit.');
  let calls = 0;
  return async (call, context = {}) => {
    const effectiveSignal = context.signal ? AbortSignal.any([signal, context.signal].filter(Boolean)) : signal;
    check(effectiveSignal);
    if (call.name !== 'relay_workspace') throw fail('Unknown workspace tool.');
    if (maxCalls !== null && ++calls > maxCalls) return result({ error: 'The configured workspace action limit was reached. Return a checkpoint or change that limit before continuing.' }, false);
    try {
      const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
      if (!args || typeof args !== 'object' || !['list', 'read', 'write', 'patch', 'patch_history', 'undo_patch', 'search', 'run'].includes(args.action)) throw fail('Choose list, read, write, patch, patch_history, undo_patch, search, or run.');
      const base = args.cwd ? location(cwd, args.cwd) : cwd;
      if (!(await fs.stat(base)).isDirectory()) throw fail('The working folder is not a directory.');
      check(effectiveSignal); onEvent({ type: 'workspace.action', action: args.action, message: `Workspace · ${args.action}`, ...(args.path ? { path: location(base, args.path) } : {}) });
      if (args.action === 'list') return result(await listFiles(base, args, effectiveSignal));
      if (args.action === 'read') return result(await readText(base, args, effectiveSignal));
      if (args.action === 'write') return result(await writeText(base, args, effectiveSignal));
      if (['patch','patch_history','undo_patch'].includes(args.action)) {
        if (!patchStore) throw fail('Durable patch history is unavailable for this execution.');
        if (args.action === 'patch_history') return result(args.patchId ? await patchStore.get(args.patchId) : await patchStore.list({cwd:base,limit:integer(args.limit,50,1,100)}));
        const receipt = args.action === 'patch' ? await patchStore.patch({cwd:base,path:args.path,oldText:args.oldText,newText:args.newText,expectedHash:args.expectedHash,signal:effectiveSignal,runId,nodeId}) : await patchStore.undo(args.patchId,{signal:effectiveSignal,source:'agent',runId,nodeId});
        onEvent({type:'workspace.patch',action:args.action,path:receipt.path,patchId:receipt.id,message:args.action==='patch'?'Applied file patch':'Undid file patch'});
        return result(receipt);
      }
      if (args.action === 'search') return result(await searchText(base, args, effectiveSignal, rgCommand));
      if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 20000 || args.command.includes('\0')) throw fail('Enter a shell command of 1 to 20,000 characters.');
      const timeoutMs = integer(args.timeoutMs, 30000, 100, 120000), windows = process.platform === 'win32';
      const executable = windows ? 'powershell.exe' : '/bin/sh';
      const parameters = windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();$OutputEncoding=[Console]::OutputEncoding;\n${args.command}`] : ['-c', args.command];
      const ran = await processRun(executable, parameters, { cwd: base, signal: effectiveSignal, timeoutMs, restartOriginToken });
      return result({ ...ran, command: args.command.slice(0, 1000), shell: windows ? 'powershell' : 'sh' }, !ran.timedOut && ran.exitCode === 0);
    } catch (cause) { if (effectiveSignal?.aborted || cause.name === 'AbortError') throw aborted(); return result({ error: cause.message, code: cause.code || 'WORKSPACE_ERROR' }, false); }
  };
}
