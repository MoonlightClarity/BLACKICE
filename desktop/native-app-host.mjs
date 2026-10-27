import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { launchNativeExecutable } from './native-app-launcher.mjs';
import { NativeForegroundGuard } from './native-foreground-guard.mjs';

const SCRIPT = fileURLToPath(new URL('./native-window-host.ps1', import.meta.url));
const IDENTITY_SCRIPT = fileURLToPath(new URL('./native-app-identity.ps1', import.meta.url));
const normalizedFile = value => typeof value === 'string' && path.win32.isAbsolute(value) ? path.win32.normalize(value).toLowerCase() : '';

/** Inspect actual on-disk identities, never infer an application from its title
 * or a similar executable name. Used for signed launcher -> GUI handoffs. */
export function inspectNativeApplicationFiles(paths, { spawnImpl = spawn, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass', '-File', IDENTITY_SCRIPT], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { finish(new Error('Application identity inspection timed out.')); try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 1024 * 1024) { finish(new Error('Application identity response was too large.')); try { child.kill(); } catch {} } });
    child.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-1500); });
    child.once('error', error => finish(error)); child.stdin.on('error', error => finish(error));
    child.once('close', code => {
      if (code !== 0) return finish(new Error(stderr || 'Application identity inspection failed.'));
      try { const result = JSON.parse(stdout.trim().replace(/^\uFEFF/, '')); finish(null, Array.isArray(result.files) ? result.files : []); }
      catch { finish(new Error('Application identity inspection returned an invalid response.')); }
    });
    child.stdin.end(JSON.stringify({ paths }));
  });
}

export function sameSignedInstallation(target, candidate) {
  const a = normalizedFile(target?.path), b = normalizedFile(candidate?.path);
  if (!a || !b || path.win32.dirname(a) !== path.win32.dirname(b)) return false;
  if (target.signatureStatus !== 'Valid' || candidate.signatureStatus !== 'Valid') return false;
  return ['signerThumbprint', 'company', 'product', 'version'].every(key => {
    const value = String(target[key] || '').trim().toLowerCase();
    return value && value === String(candidate[key] || '').trim().toLowerCase();
  });
}
const integer = (value, name, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid native application ' + name + '.');
  return value;
};
const rectangle = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provide the visible Activity panel bounds.');
  return {
    x: integer(value.x, 'x', 0, 32768),
    y: integer(value.y, 'y', 0, 32768),
    width: integer(value.width, 'width', 80, 10000),
    height: integer(value.height, 'height', 60, 10000),
  };
};
const windowHandle = value => {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value)) throw new Error('Choose a current native application window.');
  return value;
};

export function nativeHandle(window) {
  const bytes = window?.getNativeWindowHandle?.();
  if (!Buffer.isBuffer(bytes) || bytes.length < 4) throw new Error('BLACKICE native window is unavailable.');
  const handle = bytes.length >= 8 ? bytes.readBigUInt64LE(0).toString() : String(bytes.readUInt32LE(0));
  return windowHandle(handle);
}

/** Dock real, unsandboxed Win32 windows into the BLACKICE desktop shell.
 * The child process is a window manager only; it never owns or kills the apps.
 * Commands are serialized to preserve one selected window and its original style.
 */
export class NativeAppHost {
  constructor({ platform = process.platform, spawnImpl = spawn, foregroundGuard, statImpl = stat, launchExecutable = launchNativeExecutable, inspectApplicationFiles = inspectNativeApplicationFiles, wait = delay, now = Date.now, getWindow, catalog, ownerPid = process.pid, timeoutMs = 15000, launchTimeoutMs = 30000, continuationTimeoutMs = 60000, windowSettleMs = 100 } = {}) {
    this.platform = platform;
    this.spawnImpl = spawnImpl;
    this.statImpl = statImpl;
    this.launchExecutable = launchExecutable;
    this.inspectApplicationFiles = inspectApplicationFiles;
    this.wait = wait;
    this.now = now;
    this.launchTimeoutMs = launchTimeoutMs;
    this.continuationTimeoutMs = continuationTimeoutMs;
    this.windowSettleMs = windowSettleMs;
    this.getWindow = getWindow;
    this.catalog = catalog;
    this.ownerPid = ownerPid;
    this.timeoutMs = timeoutMs;
    this.worker = null;
    this.pending = null;
    this.buffer = '';
    this.sequence = 0;
    this.tail = Promise.resolve();
    this.closed = false;
    this.closing = false;
    this.closePromise = null;
    this.closeReceipt = null;
    this.attached = false;
    this.sessionActive = false;
    this.ownershipPossible = false;
    this.visible = false;
    this.bounds = null;
    this.foregroundGuard = foregroundGuard === undefined ? platform === 'win32' && spawnImpl === spawn && typeof getWindow === 'function' ? new NativeForegroundGuard() : null : foregroundGuard;
    this.foregroundStatus = null;
  }
  setForegroundLogDirectory(directory) { this.foregroundGuard?.setDirectory?.(directory); }
  async beginQuietOperation() {
    if (this.closed || this.closing) throw new Error('Native applications are closing.');
    if (!this.foregroundGuard) return;
    // Await the independent event pump before allowing a shell or direct
    // executable activation. Failure here prevents an unobserved activation.
    this.foregroundStatus = await this.foregroundGuard.begin(nativeHandle(this.getWindow?.()));
  }
  async foreground(action, value) {
    if (!this.foregroundGuard) return null;
    try { this.foregroundStatus = await this.foregroundGuard[action](value); }
    catch (error) { this.foregroundStatus = { active: false, continuous: false, zeroFlashGuaranteed: false, error: String(error.message || error), ...(this.foregroundStatus?.logPath ? { logPath: this.foregroundStatus.logPath } : {}) }; }
    return this.foregroundStatus;
  }
  availability() {
    return { available: this.platform === 'win32' && !this.closed && !!this.getWindow?.(),
      mode: 'native_window', isolated: false, sandboxed: false,
      details: 'Uses the existing Windows desktop and the application’s normal Windows permissions.' };
  }
  ensureWorker() {
    if (this.platform !== 'win32' || this.closed) throw new Error('Native applications require the Windows desktop.');
    if (this.worker) return;
    const child = this.spawnImpl('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Mta', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Stream',
    ], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.worker = child;
    this.buffer = '';
    const fail = (error, exited = false) => {
      if (this.worker !== child) return;
      const possible = this.attached || this.sessionActive || this.ownershipPossible;
      if (possible) {
        // Losing a helper reply or helper process is never permission to expose
        // an embedded app or stop watching it for desktop activation.
        this.ownershipPossible = true;
        if (exited) { this.worker = null; this.attached = false; this.sessionActive = false; }
      } else {
        this.worker = null; this.attached = false; this.sessionActive = false; this.ownershipPossible = false;
        void this.foreground('release');
      }
      this.visible = false;
      this.buffer = '';
      const request = this.pending;
      this.pending = null;
      request?.finish(error);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.worker !== child) return;
      this.buffer += chunk;
      if (this.buffer.length > 2 * 1024 * 1024) return fail(new Error('Native application response was too large.'));
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end).trim().replace(/^\uFEFF/, '');
        this.buffer = this.buffer.slice(end + 1);
        if (!line) continue;
        const pending = this.pending;
        if (!pending) continue;
        let reply;
        try { reply = JSON.parse(line); } catch { pending.finish(new Error('Native application host returned an invalid message.')); continue; }
        if (Number.isSafeInteger(reply.requestId) && reply.requestId < pending.id) continue; // A timed-out operation can finish late.
        if (reply.requestId !== pending.id) { pending.finish(new Error('Native application host returned an unrelated message.')); continue; }
        pending.finish(reply.ok === true ? null : new Error(String(reply.error || 'Native application operation failed.')), reply.result);
      }
    });
    let failureDetail = '';
    child.stderr?.on('data', chunk => { failureDetail = (failureDetail + String(chunk)).slice(-1500); });
    child.stdin.on('error', error => fail(error));
    child.on('error', error => fail(error));
    child.on('close', code => fail(new Error('Native application host closed (' + String(code) + '). ' + failureDetail), true));
  }
  dispatch(action, args = {}) {
    this.tail = this.tail.catch(() => {}).then(() => this.execute(action, args));
    return this.tail;
  }
  execute(action, args) {
    return new Promise((resolve, reject) => {
      if (this.closing && !['detach', 'status'].includes(action)) { reject(new Error('Native applications are closing.')); return; }
      try { this.ensureWorker(); } catch (error) { reject(error); return; }
      if (this.pending) { reject(new Error('Native application host is busy.')); return; }
      const id = ++this.sequence;
      let timer, settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.pending?.id === id) this.pending = null;
        if (error) reject(error); else resolve(value);
      };
      this.pending = { id, finish };
      timer = setTimeout(() => {
        finish(new Error('Native application host timed out; check the existing app window before retrying.'));
        // Killing a helper that owns foreign child windows can destroy their
        // native parents while a workbook is busy. Preserve it and accept its
        // eventual reply; a later status can reconcile the same session.
        if (this.attached || this.sessionActive || this.ownershipPossible) return;
        const old = this.worker; this.worker = null; this.attached = false; this.visible = false;
        try { old?.kill(); } catch {}
      }, this.timeoutMs);
      try { this.worker.stdin.write(JSON.stringify({ ...args, action, requestId: id }) + '\n'); }
      catch (error) { finish(error); }
    });
  }
  async windows(launchPid = 0) {
    const result = await this.dispatch('windows', { excludePid: this.ownerPid, ...(Number.isSafeInteger(launchPid) && launchPid > 0 ? { launchPid } : {}) });
    return Array.isArray(result) ? result : result ? [result] : [];
  }
  async apps(options = {}) { if (!this.catalog) throw new Error('Installed applications are unavailable in this runtime.'); return this.catalog.list(options); }
  async launchInstalled(appId, bounds, { signal } = {}) {
    if (!this.catalog) throw new Error('Installed applications are unavailable in this runtime.');
    const check = () => { if (this.closed || this.closing) throw new Error('Native applications are closing.'); if (signal?.aborted) throw Object.assign(new Error('Application launch cancelled before activation.'), { name: 'AbortError', code: 'ABORT_ERR' }); };
    check(); const area = bounds ? rectangle(bounds) : null, entry = await this.catalog.resolve(appId, { signal }); check();
    const beforeWindowIds = (await this.windows()).map(item => item.id); check();
    await this.beginQuietOperation(); check();
    const nativeExcel = path.win32.basename(String(entry.targetPath || '')).toLowerCase() === 'excel.exe'
      && !String(entry.arguments || '').trim();
    // Excel's first workbook must exist before XLMAIN becomes a child window.
    // Reparenting its empty start screen crashes Excel when Book1 is created.
    const started = nativeExcel ? await this.dispatch('excel-prepare', { executable: entry.targetPath })
      : await this.catalog.launch(appId, { signal });
    const receipt = { ...started, ...(nativeExcel ? { appId, name: entry.name,
      identity: { kind: entry.kind, targetPath: entry.targetPath } } : {}),
      isolated: false, sandboxed: false, attached: false };
    await this.foreground('bind', { pid: receipt.activationPid || receipt.pid, processStartedAt: receipt.activationProcessStartedAt });
    if (nativeExcel) {
      receipt.intent = { version: 1, beforeWindowIds, targetPath: entry.targetPath, aumid: '',
        expiresAt: this.now() + this.launchTimeoutMs + this.continuationTimeoutMs };
      const prepared = { ...receipt, phase: 'loading', pending: false };
      if (!area) return prepared;
      return { ...prepared, ...await this.attach(receipt.windowId, area,
        { preexistingWindowIds: beforeWindowIds }), phase: 'embedded' };
    }
    if (this.foregroundStatus) receipt.foregroundGuard = this.foregroundStatus;
    receipt.intent = { version: 1, beforeWindowIds, targetPath: entry.targetPath || '', aumid: entry.aumid || '',
      expiresAt: this.now() + this.launchTimeoutMs + this.continuationTimeoutMs };
    return this.observeLaunch(receipt, area, { signal });
  }
  async continueLaunch(receipt, { signal, isCurrent, renew = false } = {}) {
    if (renew && receipt?.intent) receipt = { ...receipt, intent: { ...receipt.intent, expiresAt: this.now() + this.continuationTimeoutMs } };
    return this.observeLaunch(receipt, undefined, { signal, isCurrent, timeoutMs: Math.max(0, Math.min(this.continuationTimeoutMs, Number(receipt?.intent?.expiresAt || 0) - this.now())) });
  }
  async watchLaunch(receipt, { signal, isCurrent, onLost } = {}) {
    while (!this.closed && this.now() < Number(receipt?.intent?.expiresAt || 0)) {
      if (signal?.aborted || isCurrent && !await isCurrent()) return null;
      const current = await this.status();
      if (signal?.aborted) return null;
      const sameSession = receipt.sessionId && current.sessionActive === true && current.sessionId === receipt.sessionId
        && current.sessionPid === receipt.sessionPid && typeof receipt.sessionProcessStartedAt === 'string'
        && current.sessionProcessStartedAt === receipt.sessionProcessStartedAt;
      if (sameSession && current.attached && current.embedded && current.windowId !== receipt.windowId) return { ...receipt, ...current, pending: false, phase: 'embedded' };
      if (current.attached && current.windowId !== receipt.windowId) return null;
      if (!current.attached || !current.embedded) {
        await onLost?.();
        if (sameSession) { await this.wait(500); continue; }
        return this.continueLaunch(receipt, { signal, isCurrent });
      }
      await this.wait(500);
    }
    return null;
  }
  /** Continue observing this accepted activation; never start another process. */
  async observeLaunch(receipt, bounds, { signal, isCurrent, timeoutMs = this.launchTimeoutMs } = {}) {
    if (!receipt?.intent || receipt.intent.version !== 1 || !Array.isArray(receipt.intent.beforeWindowIds)) throw new Error('The accepted application activation has no recoverable window identity.');
    // A previous splash/root may already be gone. Retain activation identity,
    // never its stale HWND, containment claims or old window geometry.
    const { windowId, title, attached, embedded, visible, containerWindowId, parentWindowId, containerParentWindowId, hostWindowId,
      stageBounds, windowBounds, visibleBounds, dialogCount, phase, pending, reason, windows: previousWindows, ...activation } = receipt;
    receipt = { ...activation, attached: false, embedded: false, visible: false };
    const area = bounds ? rectangle(bounds) : null;
    const before = new Set(receipt.intent.beforeWindowIds);
    const activationPid = [receipt.activationPid, receipt.pid].find(value => Number.isSafeInteger(value) && value > 0) || 0;
    const target = normalizedFile(receipt.intent.targetPath), aumid = String(receipt.intent.aumid || '').toLowerCase();
    // Cache only within this activation. An edited/replaced installation must
    // be inspected afresh on the next launch, rather than inheriting trust.
    const identities = new Map();
    const installationMatches = async windows => {
      if (!target) return [];
      const paths = [...new Set(windows.map(item => normalizedFile(item.processPath)).filter(file => file && file !== target && path.win32.dirname(file) === path.win32.dirname(target)))];
      if (!paths.length) return [];
      const missing = [target, ...paths].filter(file => !identities.has(file));
      if (missing.length) {
        for (const file of missing) identities.set(file, null);
        try { for (const info of await this.inspectApplicationFiles(missing)) { const file = normalizedFile(info?.path); if (missing.includes(file)) identities.set(file, info); } }
        catch { /* Missing identity evidence leaves the application unattached. */ }
      }
      return windows.filter(item => sameSignedInstallation(identities.get(target), identities.get(normalizedFile(item.processPath))));
    };
    const until = this.now() + timeoutMs;
    let candidateId = '', candidateSince = 0, lastCandidates = [], lastMatches = [], lastWindows = [];
    do {
      if (isCurrent && !await isCurrent()) return { ...receipt, pending: false, phase: 'failed', reason: 'Applications was left before the main window became available. The application remains running in Windows.' };
      if (signal?.aborted) return { ...receipt, pending: false, phase: 'failed', reason: 'Application started before cancellation. It remains running in Windows and was not loaded into BLACKICE.' };
      let windows;
      try { windows = await this.windows(activationPid); } catch (error) { return { ...receipt, phase: 'pending', pending: true, reason: 'Application started; window observation is pending: ' + error.message }; }
      lastWindows = windows;
      if (signal?.aborted) return { ...receipt, pending: false, phase: 'failed', reason: 'Application started before cancellation. It remains running in Windows and was not loaded into BLACKICE.' };
      const lineage = activationPid ? windows.filter(item => item.pid === activationPid || item.launchDescendant === true && !before.has(item.id)) : [];
      const exact = windows.filter(item => aumid && String(item.appId || '').toLowerCase() === aumid || target && normalizedFile(item.processPath) === target);
      // Shell activation can finish in a differently named signed executable
      // (e.g. a suite launcher and its GUI). Require the observed file to share
      // its directory, valid signer, product, company AND exact file version.
      const matches = lineage.length ? lineage : exact.length ? exact : await installationMatches(windows);
      lastMatches = matches;
      if (signal?.aborted) return { ...receipt, pending: false, phase: 'failed', reason: 'Application started before cancellation. It remains running in Windows and was not loaded into BLACKICE.' };
      const fresh = matches.filter(item => !before.has(item.id));
      // A new window title is not application identity: the user can open an
      // unrelated document containing this app's name while activation runs.
      // A suite's signer identifies the installation, not which pre-existing
      // document/module was activated. Only exact identity/lineage may reuse an
      // old window automatically; a family-only handoff needs a fresh window.
      const suitable = (fresh.length ? fresh : lineage.length || exact.length ? matches : []).filter(item => item.toolWindow !== true || item.appWindow === true);
      // A main window may have a hidden owner (Office SDI and many toolkits).
      // Only an actually visible owner makes a window secondary to an observed
      // primary from the same activation; never reject all owned windows.
      const primary = suitable.filter(item => item.ownerVisible !== true);
      const candidates = primary.length ? primary : suitable;
      lastCandidates = candidates;
      if (candidates.length === 1) {
        if (candidateId !== candidates[0].id) { candidateId = candidates[0].id; candidateSince = this.now(); }
        if (timeoutMs === 0 || this.now() - candidateSince >= this.windowSettleMs) {
          await this.foreground('bind', { windowId: candidates[0].id });
          const observed = { ...receipt, pending: false, phase: 'loading', windowId: candidates[0].id, title: candidates[0].title };
          if (!area) return observed;
          try { return { ...observed, ...await this.attach(candidates[0].id, area, { preexistingWindowIds: receipt.intent.beforeWindowIds }), phase: 'embedded' }; }
          catch (error) { return { ...observed, phase: 'failed', reason: 'Application started; it was not loaded into BLACKICE. ' + error.message }; }
        }
      } else { candidateId = ''; candidateSince = 0; }
      if (this.now() >= until || this.closed) {
        const pending = !this.closed && this.now() < receipt.intent.expiresAt;
        return { ...receipt, pending, phase: pending ? 'pending' : 'failed', windows: lastCandidates.length ? lastCandidates : lastMatches.length ? lastMatches : lastWindows.filter(item => !before.has(item.id)),
          reason: pending ? 'Application started. BLACKICE is still waiting for its main window and will load it without launching again.'
            : 'Application started, but its main window could not be identified and loaded. It remains running in Windows; inspect its windows without launching again.' };
      }
      await this.wait(250);
    } while (!this.closed);
    return { ...receipt, pending: false, phase: 'failed' };
  }
  async launch(input, bounds, { signal } = {}) {
    if (this.platform !== 'win32' || this.closed) throw new Error('Native app launching requires Windows.');
    if (input && typeof input === 'object' && input.appId !== undefined) {
      if (input.executable !== undefined || input.args?.length) throw new Error('Choose an installed appId or an executable with arguments. Shortcut arguments remain defined by Windows.');
      return this.launchInstalled(input.appId, bounds, { signal });
    }
    const checkBeforeSpawn = () => { if(this.closed||this.closing)throw new Error('Native applications are closing.'); if(signal?.aborted)throw Object.assign(new Error('Native application launch cancelled before starting a process.'),{name:'AbortError',code:'ABORT_ERR'}); };
    checkBeforeSpawn();
    const { executable: suppliedExecutable, args = [] } = typeof input === 'string' ? { executable: input } : input || {};
    const executable = typeof suppliedExecutable === 'string' ? suppliedExecutable.trim().replace(/^"(.+)"$/, '$1') : suppliedExecutable;
    if (typeof executable !== 'string' || !path.win32.isAbsolute(executable) || !/\.exe$/i.test(executable)) throw new Error('Select an installed Windows executable.');
    if (!Array.isArray(args) || args.length > 100 || args.some(arg => typeof arg !== 'string' || arg.length > 8000 || arg.includes('\0'))) throw new Error('Application arguments must be a list of text values.');
    const area = bounds ? rectangle(bounds) : null;
    const info = await this.statImpl(executable);
    checkBeforeSpawn();
    if (!info.isFile()) throw new Error('The selected application is not a file.');
    const beforeWindowIds = (await this.windows()).map(item => item.id);
    checkBeforeSpawn();
    await this.beginQuietOperation(); checkBeforeSpawn();
    const nativeExcel = path.win32.basename(executable).toLowerCase() === 'excel.exe' && args.length === 0;
    const started = nativeExcel ? await this.dispatch('excel-prepare', { executable })
      : await this.launchExecutable({ executable, args, cwd: path.win32.dirname(executable) }, { signal });
    const receipt = { ...started, isolated: false, sandboxed: false, attached: false };
    await this.foreground('bind', { pid: receipt.activationPid || receipt.pid, processStartedAt: receipt.activationProcessStartedAt });
    if (nativeExcel) {
      receipt.intent = { version: 1, beforeWindowIds, targetPath: executable, aumid: '',
        expiresAt: this.now() + this.launchTimeoutMs + this.continuationTimeoutMs };
      const prepared = { ...receipt, phase: 'loading', pending: false };
      if (!area) return prepared;
      return { ...prepared, ...await this.attach(receipt.windowId, area,
        { preexistingWindowIds: beforeWindowIds }), phase: 'embedded' };
    }
    if (this.foregroundStatus) receipt.foregroundGuard = this.foregroundStatus;
    receipt.intent = { version: 1, beforeWindowIds, targetPath: executable, aumid: '',
      expiresAt: this.now() + this.launchTimeoutMs + this.continuationTimeoutMs };
    return this.observeLaunch(receipt, area, { signal });
  }
  async attach(id, bounds, { preexistingWindowIds } = {}) {
    if (this.closed || this.closing) throw new Error('Native applications are closing.');
    const window = this.getWindow?.();
    const hostWindowId = nativeHandle(window);
    const windowId = windowHandle(id);
    const current = this.worker && (this.attached || this.sessionActive || this.ownershipPossible) ? await this.status() : null;
    const tracked = current?.sessionActive === true && typeof current.sessionId === 'string' && current.sessionId
      && Number.isSafeInteger(current.sessionPid) && current.sessionPid > 0 && typeof current.sessionProcessStartedAt === 'string' && current.sessionProcessStartedAt
      && current.windowIds?.includes(windowId);
    const choices = tracked ? [] : await this.windows();
    if (!tracked && !choices.some(choice => choice.id === windowId)) throw new Error('Refresh the window list and select an available application.');
    const area = rectangle(bounds);
    if (preexistingWindowIds !== undefined && (!Array.isArray(preexistingWindowIds) || preexistingWindowIds.length > 120)) throw new Error('Invalid observed window baseline.');
    const baseline = preexistingWindowIds?.map(windowHandle);
    if (this.foregroundGuard && !this.foregroundGuard.active) await this.beginQuietOperation();
    await this.foreground('bind', { windowId });
    let result;
    if (this.closed || this.closing) throw new Error('Native applications are closing.');
    this.ownershipPossible = true; // A lost attach reply can still leave a real native child.
    try { result = await this.dispatch('attach', { windowId, hostWindowId, ...area, ...(baseline ? { preexistingWindowIds: baseline } : {}) }); }
    catch (error) { await this.status().catch(() => {}); throw error; }
    if (result?.attached !== true || result.embedded !== true || result.windowId !== windowId
      || !result.containerWindowId || result.parentWindowId !== result.containerWindowId
      || result.hostWindowId !== hostWindowId || result.containerParentWindowId !== hostWindowId) {
      await this.status().catch(() => {});
      throw new Error('Windows did not confirm the application → stage → BLACKICE parent chain. The application was not confirmed loaded.');
    }
    this.attached = result?.attached === true;
    this.sessionActive = result?.sessionActive === true;
    this.visible = result?.visible === true;
    this.bounds = rectangle(bounds);
    await this.foreground('bind', { windowId, retain: true });
    return { ...result, ...(this.foregroundStatus ? { foregroundGuard: this.foregroundStatus } : {}) };
  }
  async position(bounds) {
    if (!this.attached && !this.sessionActive) return this.availability();
    const result = await this.dispatch('position', rectangle(bounds));
    this.attached = result?.attached === true; this.visible = result?.visible === true;
    this.sessionActive = result?.sessionActive === true;
    this.bounds = rectangle(bounds);
    return result;
  }
  async visibleState(show) {
    if (!this.attached && !this.sessionActive && !this.ownershipPossible) return this.availability();
    const result = await this.dispatch(show ? 'show' : 'hide');
    this.attached = result?.attached === true;
    this.sessionActive = result?.sessionActive === true;
    this.visible = result?.visible === true;
    return result;
  }
  async dialogs() {
    if (!this.attached || !this.visible) return [];
    const result = await this.dispatch('dialogs');
    return Array.isArray(result) ? result : result ? [result] : [];
  }
  async requestClose() {
    if (!this.attached && !this.sessionActive) throw new Error('Load an application window first.');
    const result = await this.dispatch('close-app');
    this.attached = result?.attached === true;
    this.sessionActive = result?.sessionActive === true;
    this.visible = result?.visible === true;
    this.ownershipPossible = this.attached || this.sessionActive;
    return result;
  }
  async status() {
    if (!this.worker) return { ...this.availability(), attached: false, visible: false, dialogCount: 0,
      ...(this.ownershipPossible ? { currentStatusUnavailable: true, ownershipPossible: true,
        reason: 'The native window manager is unavailable; the last embedded application was not released.' } : {}) };
    const result = await this.dispatch('status');
    this.attached = result?.attached === true; this.visible = result?.visible === true;
    this.sessionActive = result?.sessionActive === true;
    this.ownershipPossible = this.attached || this.sessionActive;
    await this.foreground('status');
    return { ...this.availability(), ...result, ...(this.foregroundStatus ? { foregroundGuard: this.foregroundStatus } : {}) };
  }
  async focus() {
    if (!this.attached) throw new Error('Load an application window first.');
    // Keyboard focus stays within the already embedded child; do not permit
    // or activate an independent desktop foreground window.
    return this.dispatch('focus');
  }
  async reposition() {
    if (this.attached && this.visible && this.bounds) return this.position(this.bounds);
  }
  async detach() {
    throw Object.assign(new Error('Applications cannot be detached from BLACKICE.'), { code: 'NATIVE_DETACH_UNAVAILABLE' });
  }
  close() {
    if (this.closed) return Promise.resolve(this.closeReceipt);
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      // This closes the empty window-manager helper, never its hosted app.
      // A retained native child must keep its parent instead of being released.
      if (this.attached || this.sessionActive || this.ownershipPossible) {
        if (this.worker) await this.status();
        if (this.attached || this.sessionActive || this.ownershipPossible)
          throw Object.assign(new Error('An embedded application is still running. Close it inside BLACKICE first.'), { code: 'NATIVE_APPLICATIONS_RETAINED' });
      }
      const value = {attached:false,embedded:false,sessionActive:false,visible:false,released:false};
      this.closed = true;
      const child = this.worker; this.worker = null;
      try { child?.stdin.end(); } catch {}
      try { child?.kill(); } catch {}
      await this.foregroundGuard?.close().catch(() => {});
      this.closeReceipt = value; return value;
    })().finally(() => { this.closing = false; if (!this.closed) this.closePromise = null; });
    return this.closePromise;
  }
}
