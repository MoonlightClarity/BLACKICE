import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const problem = (message, code, status = 409, extra = {}) => Object.assign(new Error(message), { code, status, ...extra });
const windowsPath = value => path.win32.normalize(value).toLowerCase();

/** A native-app handoff only. It never reads accounts, messages or Thunderbird profiles. */
export class EmailClientBridge {
  constructor({ platform = process.platform, env = process.env, launch = spawn, lstat = fs.lstat, realpath = fs.realpath, isClosing = () => false, launchTimeoutMs = 5000 } = {}) {
    this.platform = platform;
    this.launch = launch;
    this.lstat = lstat;
    this.realpath = realpath;
    this.isClosing = isClosing;
    this.launchTimeoutMs = Math.max(100, Math.min(10000, Number(launchTimeoutMs) || 5000));
    this.closed = false;
    this.pending = null;
    const roots = [
      [env.ProgramFiles || 'C:\\Program Files', 'Mozilla Thunderbird'],
      [env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Mozilla Thunderbird'],
      ...(env.LOCALAPPDATA ? [[env.LOCALAPPDATA, 'Programs', 'Mozilla Thunderbird'], [env.LOCALAPPDATA, 'Programs', 'Thunderbird']] : [])
    ];
    this.candidates = [...new Set(roots.filter(([root]) => typeof root === 'string' && path.win32.isAbsolute(root) && !root.startsWith('\\\\')).map(parts => path.win32.join(...parts, 'thunderbird.exe')))];
  }

  async discover() {
    if (this.platform !== 'win32') return null;
    for (const executable of this.candidates) {
      try {
        const entry = await this.lstat(executable);
        // Do not follow a replacement executable or directory link elsewhere.
        if (!entry.isFile() || entry.isSymbolicLink?.()) continue;
        if (windowsPath(await this.realpath(executable)) !== windowsPath(executable)) continue;
        return executable;
      } catch { /* A missing or inaccessible installation is not an account error. */ }
    }
    return null;
  }

  async status() {
    const supported = this.platform === 'win32';
    const available = Boolean(await this.discover());
    const enabled = available && !this.closed && !this.isClosing();
    return { id: 'thunderbird', name: 'Thunderbird', supported, available, capabilities: { open: enabled, compose: enabled }, handoff: 'native-app', accountReuse: false };
  }

  assertAdmission(signal) {
    if (this.closed || this.isClosing()) throw problem('BLACKICE is closing for maintenance.', 'EMAIL_CLIENT_CLOSED', 503);
    if (signal?.aborted) throw problem('Opening Thunderbird was cancelled before launch.', 'EMAIL_CLIENT_CANCELLED', 409);
  }

  async open(value, { signal } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'action') || !['open', 'compose'].includes(value.action)) {
      throw problem('Choose Open Thunderbird or New message. Message fields and custom launch arguments are not accepted.', 'EMAIL_CLIENT_ACTION', 400);
    }
    this.assertAdmission(signal);
    if (this.pending) throw problem('A Thunderbird handoff is already in progress.', 'EMAIL_CLIENT_BUSY');
    const action = value.action;
    const run = async () => {
      const executable = await this.discover();
      this.assertAdmission(signal);
      if (!executable) throw problem(this.platform === 'win32' ? 'Thunderbird was not found in a supported installation location.' : 'The Thunderbird handoff is available on Windows.', 'EMAIL_CLIENT_UNAVAILABLE', 503);
      // No recipient, message, URL, profile, or user-controlled argument is passed.
      const args = action === 'compose' ? ['-compose'] : [];
      return new Promise((resolve, reject) => {
        let settled = false, child, timer;
        const finish = (error, result) => {
          if (settled) return;
          settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
          if (error) reject(error); else resolve(result);
        };
        const abort = () => finish(problem('The Thunderbird launch response was interrupted. Check its window before trying again.', 'EMAIL_CLIENT_UNCERTAIN', 409, { uncertain: true }));
        const receipt = { requested: true, action, application: 'Thunderbird', nativeWindow: true, windowVerified: false, sent: false };
        try {
          this.assertAdmission(signal);
          child = this.launch(executable, args, { shell: false, detached: true, windowsHide: false, stdio: 'ignore' });
          child.once('error', () => finish(problem('Thunderbird could not be started. Check the installed application before trying again.', 'EMAIL_CLIENT_LAUNCH_FAILED', 503)));
          child.once('spawn', () => { child.unref?.(); finish(null, receipt); });
          signal?.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => finish(problem('The Thunderbird launch could not be confirmed. Check its window before trying again.', 'EMAIL_CLIENT_UNCERTAIN', 504, { uncertain: true })), this.launchTimeoutMs);
          if (signal?.aborted) abort();
        } catch (error) { finish(error?.code?.startsWith('EMAIL_CLIENT_') ? error : problem('Thunderbird could not be started. Check the installed application before trying again.', 'EMAIL_CLIENT_LAUNCH_FAILED', 503)); }
      });
    };
    const pending = run();
    this.pending = pending;
    try { return await pending; }
    finally { if (this.pending === pending) this.pending = null; }
  }

  async close() {
    this.closed = true;
    // Closing BLACKICE never closes or terminates the user's native mail app.
    await this.pending?.catch(() => {});
  }
}
