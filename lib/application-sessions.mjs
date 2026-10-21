import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./windows-application-session.ps1', import.meta.url));
const ACTIONS = new Set(['windows', 'screenshot', 'inspect', 'get_text', 'invoke', 'set_value', 'select', 'toggle', 'expand', 'collapse', 'scroll', 'scroll_into_view']);
const REFERENCE = /^uia_[a-f0-9]{12}_[1-9]\d{0,6}$/;
const MAX_RESPONSE = 12 * 1024 * 1024;
const TERMINAL = new Set(['closed', 'failed']);
const error = (message, code = 'APPLICATION_SESSION_ERROR') => Object.assign(new Error(message), { code });
const aborted = () => Object.assign(error('The isolated application session was closed or cancelled.', 'ABORT_ERR'), { name: 'AbortError' });
const invalid = message => { throw error(message, 'APPLICATION_SESSION_VALIDATION'); };
const integer = (value, label, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label} must be an integer between ${min} and ${max}.`);
  return value;
};

/** Only bounded ownership/lifetime counters cross the helper boundary. No
 * executable paths, process names, window titles or arbitrary native objects. */
export function sanitizeApplicationDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) return null;
  const result = { version: 1, windowStation: ['WinSta0', 'other', 'unknown'].includes(value.windowStation) ? value.windowStation : 'unknown', phase: ['initializing', 'launching', 'waiting-for-window', 'ready'].includes(value.phase) ? value.phase : 'initializing' };
  for (const key of ['rootPid', 'observedProcessLimit', 'jobTotalProcesses', 'jobActiveProcesses', 'jobTerminatedProcesses', 'unobservedProcessCount', 'jobQueryError', 'processQueryError', 'terminationError', 'enumerationError', 'privateWindows', 'ownedWindows', 'visibleOwnedWindows', 'hiddenOwnedWindows', 'unownedWindows', 'ownershipQueryFailures', 'windowGeometryFailures']) {
    const item = value[key], min = ['jobTotalProcesses', 'jobActiveProcesses', 'jobTerminatedProcesses'].includes(key) ? -1 : 0;
    if (Number.isSafeInteger(item) && item >= min && item <= 0x7fffffff) result[key] = item;
  }
  for (const key of ['isolationVerified', 'processListTruncated', 'windowsTruncated', 'diagnosticsIncomplete', 'closed', 'terminationAttempted', 'terminationSucceeded']) if (typeof value[key] === 'boolean') result[key] = value[key];
  const supplied = Array.isArray(value.processes) ? value.processes : [], seen = new Set();
  result.processes = supplied.slice(0, 64).flatMap(item => {
    if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.pid) || item.pid < 1 || item.pid > 0x7fffffff || seen.has(item.pid) || !['launcher', 'descendant'].includes(item.role) || !['running', 'exited', 'unavailable'].includes(item.state)) return [];
    seen.add(item.pid); const process = { pid: item.pid, role: item.role, state: item.state };
    for (const key of ['firstSeenMs', 'lastObservedMs']) if (Number.isSafeInteger(item[key]) && item[key] >= 0) process[key] = item[key];
    process.exitCode = item.state === 'exited' && Number.isSafeInteger(item.exitCode) && item.exitCode >= 0 && item.exitCode <= 0xffffffff ? item.exitCode : null;
    return [process];
  });
  if (result.processes.length !== supplied.length) result.processListTruncated = true;
  result.allObservedProcessesExited = value.allObservedProcessesExited === true && result.processes.length > 0 && result.processes.length === supplied.length && result.processes.every(item => item.state === 'exited');
  return result;
}

/** Defense in depth. Product admission must additionally use a verified application catalog. */
export async function validateApplicationExecutable(executable) {
  if (typeof executable !== 'string' || executable.length > 1024 || !path.win32.isAbsolute(executable) || !/^[a-z]:\\/i.test(executable) || executable.includes('\0') || /["\r\n]/.test(executable) || !/\.exe$/i.test(executable)) invalid('Choose an absolute local Windows executable from the verified application catalog.');
  if (/(?:^|\\)(?:WindowsApps|AppData\\Local\\Microsoft\\WindowsApps)(?:\\|$)/i.test(executable)) invalid('Packaged applications and execution aliases cannot run in a private application desktop.');
  const basename = path.win32.basename(executable).toLowerCase();
  if (/^(?:cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32|explorer|openwith|applicationframehost|shellexperiencehost|systemsettings|calc|chrome|msedge|firefox|opera|browseros|browseros_neo|electron)\.exe$/i.test(basename)) invalid('This shell, browser, or brokered application is not supported by isolated application sessions.');
  const stat = await lstat(executable);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 512 || stat.size > 1024 * 1024 * 1024) invalid('The application must be a regular local executable, not an alias or link.');
  const resolved = await realpath(executable);
  if (path.win32.normalize(resolved).toLowerCase() !== path.win32.normalize(executable).toLowerCase()) invalid('Application links and redirected executable paths are not supported.');
  const file = await open(executable, 'r');
  try {
    const dos = Buffer.alloc(64);
    if ((await file.read(dos, 0, dos.length, 0)).bytesRead !== dos.length || dos.toString('ascii', 0, 2) !== 'MZ') invalid('The application is not a Windows executable.');
    const offset = dos.readUInt32LE(0x3c);
    if (offset < 64 || offset > stat.size - 96 || offset > 16 * 1024 * 1024) invalid('The application executable header is invalid.');
    const pe = Buffer.alloc(96);
    if ((await file.read(pe, 0, pe.length, offset)).bytesRead !== pe.length || pe.readUInt32LE(0) !== 0x00004550 || ![0x10b, 0x20b].includes(pe.readUInt16LE(24)) || pe.readUInt16LE(92) !== 2 || (pe.readUInt16LE(22) & 0x2000)) invalid('Only ordinary Win32 GUI executables are supported. Console applications, DLLs and launch scripts are not supported.');
  } finally { await file.close(); }
  return resolved;
}

/** A killable helper owns the desktop and a kill-on-close job, never the user's processes. */
export function createWindowsApplicationRunner({ spawnImpl = spawn } = {}) {
  let child, pending, buffer = '', sequence = 0, closed = false;
  const closeListeners = new Set();
  const stop = reason => {
    if (closed) return;
    closed = true;
    const instance = child; child = null; buffer = '';
    const request = pending; pending = null;
    request?.finish(reason || aborted());
    try { instance?.stdin.end(); } catch {}
    // Terminating this helper closes its private job handle. Windows then terminates
    // only the suspended/admitted session processes and their non-breakaway children.
    try { instance?.kill(); } catch {}
    for (const listener of closeListeners) { try { listener(reason || aborted()); } catch {} }
    closeListeners.clear();
  };
  const start = () => {
    if (closed) throw aborted();
    if (child) return;
    const instance = spawnImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Mta', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-ParentProcessId', String(process.pid), '-Stream'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    child = instance;
    const lost = message => { if (child === instance) stop(error(message)); };
    instance.stdout.setEncoding('utf8');
    instance.stdout.on('data', chunk => {
      if (child !== instance) return;
      buffer += chunk;
      if (buffer.length > MAX_RESPONSE) return lost('The isolated application response exceeded its size limit. The session was closed.');
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).trim().replace(/^\uFEFF/, ''); buffer = buffer.slice(end + 1);
        if (!line) continue;
        const request = pending;
        if (!request) return lost('The isolated application helper returned an unexpected response.');
        let result;
        try { result = JSON.parse(line); } catch { return lost('The isolated application helper returned an invalid response.'); }
        if (result.requestId !== request.id || typeof result.ok !== 'boolean') return lost('The isolated application helper returned an unrelated response.');
        pending = null;
        const { ok, requestId, error: message, diagnostics: rawDiagnostics, ...value } = result;
        const diagnostics = sanitizeApplicationDiagnostics(rawDiagnostics);
        const cause = ok ? null : error(message || 'The isolated application operation failed.');
        if (cause && diagnostics) cause.diagnostics = diagnostics;
        request.finish(cause, { ...value, ...(diagnostics ? { diagnostics } : {}) });
      }
    });
    instance.stderr.on('data', () => {});
    instance.stdin.on('error', cause => lost(`The isolated application helper input failed: ${cause.message}`));
    instance.on('error', cause => lost(`The isolated application helper could not start: ${cause.message}`));
    instance.on('close', code => lost(`The isolated application helper stopped (${code ?? 'terminated'}). The session is closed.`));
  };
  const request = (value, { signal, timeoutMs = 20_000 } = {}) => new Promise((resolve, reject) => {
    if (closed || signal?.aborted) return reject(aborted());
    if (pending) return reject(error('An isolated application operation is already in progress.'));
    let timer, settled = false;
    const abort = () => stop(aborted());
    const finish = (cause, result) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (cause) reject(cause); else resolve(result);
    };
    try {
      start();
      const id = ++sequence;
      pending = { id, finish };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      timer = setTimeout(() => stop(error('The isolated application operation timed out. Its private session was closed; no foreground fallback was used.')), timeoutMs);
      child.stdin.write(`${JSON.stringify({ ...value, requestId: id })}\n`);
    } catch (cause) { stop(cause); finish(cause); }
  });
  request.close = () => stop(aborted());
  request.isClosed = () => closed;
  request.onClose = listener => { if (closed) listener(error('The isolated application helper is already closed.')); else closeListeners.add(listener); return () => closeListeners.delete(listener); };
  return request;
}

/** Ordinary GUI applications on private, never-visible Windows desktops. No physical input. */
export class ApplicationSessions extends EventEmitter {
  constructor({ platform = process.platform, runnerFactory = createWindowsApplicationRunner, validateExecutable = validateApplicationExecutable, maxSessions = 3, operationTimeoutMs = 20_000 } = {}) {
    super();
    this.platform = platform;
    this.runnerFactory = runnerFactory;
    this.validateExecutable = validateExecutable;
    this.maxSessions = integer(maxSessions, 'Maximum application sessions', 1, 6);
    this.operationTimeoutMs = integer(operationTimeoutMs, 'Application operation timeout', 10, 30_000);
    this.sessions = new Map();
    this.closed = false;
  }

  status() {
    return {
      available: this.platform === 'win32' && !this.closed, mode: 'private_desktop', isolated: true,
      physicalInput: false, requiresForeground: false, sessions: this.list(), actions: [...ACTIONS],
      limitations: ['Only verified ordinary Win32 GUI applications are supported. Packaged, elevated, brokered and existing singleton applications are rejected.', 'Private desktops isolate application windows, not files, network access or the current Windows account.', 'Custom drawing may not render through PrintWindow and accessibility controls depend on each application. A failure never switches the visible desktop or sends physical input.', 'Closing, cancellation or an unresponsive operation terminates only the processes owned by that private application session.'],
    };
  }

  snapshot(record) {
    return { id: record.id, label: record.label, state: record.state, mode: 'private_desktop', isolated: true, physicalInput: false, requiresForeground: false, createdAt: record.createdAt, updatedAt: record.updatedAt, busy: record.busy, windows: structuredClone(record.windows || []), ...(record.pid ? { pid: record.pid } : {}), ...(record.lastError ? { lastError: record.lastError } : {}), ...(record.diagnostics ? { diagnostics: structuredClone(record.diagnostics) } : {}) };
  }

  list() {
    for (const record of this.sessions.values()) if (!TERMINAL.has(record.state) && record.runner?.isClosed?.()) {
      record.state = 'failed'; record.windows = []; record.busy = false;
      record.lastError = 'The isolated application helper stopped. Open a new application session explicitly.';
      record.updatedAt = new Date().toISOString(); record.controller.abort();
    }
    return [...this.sessions.values()].map(record => this.snapshot(record));
  }

  async create(args, { signal } = {}) {
    if (this.platform !== 'win32' || this.closed) throw error('Isolated application sessions are unavailable.', 'APPLICATION_SESSION_UNAVAILABLE');
    if (!args || typeof args !== 'object' || Array.isArray(args)) invalid('Choose a verified application to open.');
    if (signal?.aborted) throw aborted();
    const argv = args.args ?? [];
    if (!Array.isArray(argv) || argv.length > 32 || argv.some(value => typeof value !== 'string' || value.length > 4096 || value.includes('\0') || /[\r\n]/.test(value)) || argv.join(' ').length > 16000) invalid('Application arguments must be a bounded array of literal strings.');
    if (args.label !== undefined && (typeof args.label !== 'string' || args.label.length > 100 || /[\0\r\n]/.test(args.label))) invalid('Application label must be text of at most 100 characters.');
    if ([...this.sessions.values()].filter(record => !TERMINAL.has(record.state)).length >= this.maxSessions) throw error('Close an isolated application session before opening another.', 'APPLICATION_SESSION_LIMIT');
    // Reserve before validation so concurrent admissions cannot exceed capacity.
    const record = { id: `app_${randomUUID().replaceAll('-', '')}`, label: args.label || (typeof args.executable === 'string' ? path.win32.basename(args.executable) : 'Application'), state: 'starting', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), windows: [], busy: true, controller: new AbortController(), tail: Promise.resolve() };
    this.sessions.set(record.id, record);
    this.trimHistory(); this.changed(record);
    const onAbort = () => { record.state = 'closed'; record.windows = []; record.controller.abort(); record.runner?.close?.(); this.changed(record); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const executable = await this.validateExecutable(args.executable);
      if (record.controller.signal.aborted || signal?.aborted || this.closed || record.state === 'closed') throw aborted();
      record.runner = this.runnerFactory();
      record.runner.onClose?.(cause => {
        if (TERMINAL.has(record.state)) return;
        record.state = cause?.name === 'AbortError' ? 'closed' : 'failed';
        record.lastError = cause?.name === 'AbortError' ? null : (cause?.message || 'The isolated application helper stopped. Open a new application session.');
        const diagnostics = sanitizeApplicationDiagnostics(cause?.diagnostics); if (diagnostics) record.diagnostics = diagnostics;
        record.windows = []; record.busy = false; record.controller.abort(); this.changed(record);
      });
      const result = await record.runner({ action: 'launch', executable, args: [...argv] }, { signal: record.controller.signal, timeoutMs: 30_000 });
      if (record.controller.signal.aborted || record.state !== 'starting' || this.closed) throw aborted();
      this.validateWindows(result.windows);
      if (result.isolated !== true || result.mode !== 'private_desktop' || !Number.isSafeInteger(result.pid) || result.pid < 1 || !result.windows.length) throw error('The application did not establish an owned window on its private desktop. Its session was closed.');
      record.windows = result.windows; record.pid = result.pid; record.state = 'running'; record.lastError = null;
      return this.snapshot(record);
    } catch (cause) {
      if (!TERMINAL.has(record.state)) record.state = cause.name === 'AbortError' ? 'closed' : 'failed';
      record.runner?.close?.();
      record.windows = [];
      if (cause.name !== 'AbortError' || !record.lastError) record.lastError = cause.name === 'AbortError' ? null : cause.message;
      const diagnostics = sanitizeApplicationDiagnostics(cause.diagnostics); if (diagnostics) record.diagnostics = diagnostics;
      throw cause;
    } finally { record.busy = false; signal?.removeEventListener('abort', onAbort); this.changed(record); }
  }

  async perform(args, { signal } = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || !ACTIONS.has(args.action)) invalid('Choose an advertised isolated application action. Physical input, focus and desktop-switch actions are unavailable.');
    const record = this.sessions.get(args.sessionId);
    if (!record || record.state !== 'running' || this.closed) throw error('The isolated application session is not running.', 'APPLICATION_SESSION_CLOSED');
    if (signal?.aborted) throw aborted();
    const request = this.normalize(args);
    const onAbort = () => { record.state = 'closed'; record.windows = []; record.controller.abort(); record.runner?.close?.(); this.changed(record); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const operation = record.tail.then(async () => {
      if (record.state !== 'running' || record.controller.signal.aborted) throw aborted();
      record.busy = true; this.changed(record);
      try {
        const result = await record.runner(request, { signal: record.controller.signal, timeoutMs: this.operationTimeoutMs });
        if (record.state !== 'running' || record.controller.signal.aborted) throw aborted();
        if (!result || typeof result !== 'object') throw error('The isolated application returned no result.');
        if (args.action === 'windows') {
          this.validateWindows(result.windows); record.windows = result.windows;
          if (!result.windows.length) { record.state = 'closed'; record.runner?.close?.(); record.controller.abort(); }
        }
        if (args.action === 'screenshot') this.validateCapture(result);
        record.lastError = null;
        return result;
      } catch (cause) {
        if (cause.name !== 'AbortError' || !record.lastError) record.lastError = cause.name === 'AbortError' ? null : cause.message;
        const diagnostics = sanitizeApplicationDiagnostics(cause.diagnostics); if (diagnostics) record.diagnostics = diagnostics;
        // Validation failures before admission do not terminate; an admitted helper
        // failure has uncertain application state, so close this session completely.
        if (!TERMINAL.has(record.state)) record.state = cause.name === 'AbortError' ? 'closed' : 'failed';
        record.runner?.close?.(); record.controller.abort(); record.windows = [];
        throw cause;
      } finally { record.busy = false; this.changed(record); }
    });
    record.tail = operation.catch(() => {});
    try { return await operation; }
    finally { signal?.removeEventListener('abort', onAbort); }
  }

  normalize(args) {
    const request = { action: args.action };
    const window = args.windowId;
    if (window !== undefined) {
      if (typeof window !== 'string' || !/^[1-9]\d{0,18}$/.test(window)) invalid('Choose an owned windowId from this application session.');
      request.windowId = window;
    }
    if (args.ref !== undefined) { if (typeof args.ref !== 'string' || !REFERENCE.test(args.ref)) invalid('Choose a current accessibility ref from this application session.'); request.ref = args.ref; }
    if (request.ref && request.windowId) invalid('Choose an accessibility ref or a windowId, not both.');
    switch (args.action) {
      case 'windows': return request;
      case 'screenshot': return { ...request, maxWidth: 1280, maxHeight: 900 };
      case 'inspect':
        if (!request.ref && !request.windowId) invalid('Inspect needs a windowId or accessibility ref from this application session.');
        if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 200 || args.query.includes('\0'))) invalid('Inspection query must be text of at most 200 characters.');
        return { ...request, maxDepth: integer(args.maxDepth ?? 5, 'Inspection depth', 0, 10), maxNodes: integer(args.maxNodes ?? 150, 'Inspection size', 1, 300), query: args.query || '' };
      default:
        if (!request.ref || request.windowId) invalid('This action needs a current accessibility ref from inspect.');
        if (args.action === 'set_value') {
          if (!['string', 'number'].includes(typeof args.value) || (typeof args.value === 'number' && !Number.isFinite(args.value)) || String(args.value).length > 10000 || String(args.value).includes('\0')) invalid('Value must be text of at most 10000 characters or a finite number.');
          request.value = args.value;
        }
        if (args.action === 'get_text') request.maxCharacters = integer(args.maxCharacters ?? 4000, 'Text length', 1, 12000);
        if (args.action === 'scroll') {
          if (!['up', 'down', 'left', 'right'].includes(args.direction) || (args.unit !== undefined && !['small', 'large'].includes(args.unit))) invalid('Choose a supported scroll direction and unit.');
          Object.assign(request, { direction: args.direction, unit: args.unit || 'large', amount: integer(args.amount ?? 1, 'Scroll amount', 1, 10) });
        }
        return request;
    }
  }

  validateWindows(windows) {
    if (!Array.isArray(windows) || windows.length > 200 || windows.some(item => !item || typeof item.id !== 'string' || !/^[1-9]\d{0,18}$/.test(item.id) || !Number.isSafeInteger(item.pid) || item.pid < 1 || item.isolated !== true || typeof item.title !== 'string' || item.title.length > 512)) throw error('The helper returned invalid private application windows.');
  }

  validateCapture(result) {
    const image = result.image;
    if (!image || image.mimeType !== 'image/png' || typeof image.data !== 'string' || image.data.length > 8 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) || !Number.isSafeInteger(image.width) || image.width < 1 || image.width > 1280 || !Number.isSafeInteger(image.height) || image.height < 1 || image.height > 900) throw error('The isolated application frame is invalid.');
    const bytes = Buffer.from(image.data, 'base64');
    if (bytes.toString('base64') !== image.data || bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(16) !== image.width || bytes.readUInt32BE(20) !== image.height) throw error('The isolated application frame is not a valid bounded PNG.');
  }

  async close(sessionId) {
    const record = this.sessions.get(sessionId);
    if (!record) throw error('The isolated application session does not exist.', 'APPLICATION_SESSION_CLOSED');
    record.state = 'closed'; record.controller.abort(); record.runner?.close?.(); record.windows = []; record.busy = false; this.changed(record);
    return this.snapshot(record);
  }

  async closeAll() {
    this.closed = true;
    for (const record of this.sessions.values()) if (!TERMINAL.has(record.state)) await this.close(record.id);
  }

  trimHistory() { const history = [...this.sessions.values()].filter(record => TERMINAL.has(record.state)); for (const record of history.slice(0, Math.max(0, history.length - 20))) this.sessions.delete(record.id); }
  changed(record) { record.updatedAt = new Date().toISOString(); this.emit('status', this.status()); }
}
