import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./native-window-host.ps1', import.meta.url));
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
  constructor({ platform = process.platform, spawnImpl = spawn, getWindow, ownerPid = process.pid, timeoutMs = 15000 } = {}) {
    this.platform = platform;
    this.spawnImpl = spawnImpl;
    this.getWindow = getWindow;
    this.ownerPid = ownerPid;
    this.timeoutMs = timeoutMs;
    this.worker = null;
    this.pending = null;
    this.buffer = '';
    this.sequence = 0;
    this.tail = Promise.resolve();
    this.closed = false;
    this.attached = false;
    this.visible = false;
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
    const fail = error => {
      if (this.worker !== child) return;
      this.worker = null;
      this.attached = false;
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
        if (reply.requestId !== pending.id) { pending.finish(new Error('Native application host returned an unrelated message.')); continue; }
        pending.finish(reply.ok === true ? null : new Error(String(reply.error || 'Native application operation failed.')), reply.result);
      }
    });
    let failureDetail = '';
    child.stderr?.on('data', chunk => { failureDetail = (failureDetail + String(chunk)).slice(-1500); });
    child.stdin.on('error', error => fail(error));
    child.on('error', error => fail(error));
    child.on('close', code => fail(new Error('Native application host closed (' + String(code) + '). ' + failureDetail)));
  }
  dispatch(action, args = {}) {
    this.tail = this.tail.catch(() => {}).then(() => this.execute(action, args));
    return this.tail;
  }
  execute(action, args) {
    return new Promise((resolve, reject) => {
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
        const old = this.worker; this.worker = null; this.attached = false; this.visible = false;
        try { old?.kill(); } catch {}
      }, this.timeoutMs);
      try { this.worker.stdin.write(JSON.stringify({ ...args, action, requestId: id }) + '\n'); }
      catch (error) { finish(error); }
    });
  }
  async windows() {
    const result = await this.dispatch('windows', { excludePid: this.ownerPid });
    return Array.isArray(result) ? result : result ? [result] : [];
  }
  async launch(executable) {
    if (this.platform !== 'win32' || this.closed) throw new Error('Native app launching requires Windows.');
    if (typeof executable !== 'string' || !path.win32.isAbsolute(executable) || !/\.exe$/i.test(executable)) throw new Error('Select an installed Windows executable.');
    const info = await stat(executable);
    if (!info.isFile()) throw new Error('The selected application is not a file.');
    const child = this.spawnImpl(executable, [], {
      cwd: path.dirname(executable), detached: true, shell: false, windowsHide: false, stdio: 'ignore',
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref?.();
    // A normally launched executable may reuse another process or create several
    // windows. Let the user select the real top-level window after launch.
    return { launched: true, pid: child.pid, isolated: false, sandboxed: false };
  }
  async attach(id, bounds) {
    const window = this.getWindow?.();
    const hostWindowId = nativeHandle(window);
    const windowId = windowHandle(id), choices = await this.windows();
    if (!choices.some(choice => choice.id === windowId)) throw new Error('Refresh the window list and select an available application.');
    const result = await this.dispatch('attach', { windowId, hostWindowId, ...rectangle(bounds) });
    this.attached = result?.attached === true;
    this.visible = result?.visible === true;
    return result;
  }
  async position(bounds) {
    if (!this.attached) return this.availability();
    return this.dispatch('position', rectangle(bounds));
  }
  async visibleState(show) {
    if (!this.attached) return this.availability();
    const result = await this.dispatch(show ? 'show' : 'hide');
    this.visible = result?.visible === true;
    return result;
  }
  async dialogs() {
    if (!this.attached || !this.visible) return [];
    const result = await this.dispatch('dialogs');
    return Array.isArray(result) ? result : result ? [result] : [];
  }
  async status() {
    if (!this.worker) return { ...this.availability(), attached: false, visible: false, dialogCount: 0 };
    return { ...this.availability(), ...await this.dispatch('status') };
  }
  async detach() {
    if (!this.worker) { this.attached = false; this.visible = false; return this.availability(); }
    const value = await this.dispatch('detach');
    this.attached = false; this.visible = false;
    return value;
  }
  async close() {
    if (this.closed) return;
    try { await this.detach(); } finally {
      this.closed = true;
      const child = this.worker; this.worker = null;
      try { child?.stdin.end(); } catch {}
      try { child?.kill(); } catch {}
    }
  }
}
