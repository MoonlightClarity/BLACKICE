import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const NEO_IMPORT_URL = 'chrome://settings/importData';
const problem = (message, code, status = 409, extra = {}) => Object.assign(new Error(message), { code, status, ...extra });
const normalized = value => path.win32.normalize(value).toLowerCase();
const emptyObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;

/** Opens Neo's native import dialog. Never reads, selects or imports browser data. */
export class BrowserImportBridge {
  constructor({ platform = process.platform, env = process.env, launch = spawn, lstat = fs.lstat, realpath = fs.realpath, isClosing = () => false, launchTimeoutMs = 5000 } = {}) {
    this.platform = platform;
    this.launch = launch;
    this.lstat = lstat;
    this.realpath = realpath;
    this.isClosing = isClosing;
    this.launchTimeoutMs = Math.max(100, Math.min(10000, Number(launchTimeoutMs) || 5000));
    this.closed = false;
    this.pending = null;
    this.available = false;
    const root = env.LOCALAPPDATA;
    if (typeof root === 'string' && /^[A-Za-z]:[\\/]/.test(root) && !root.includes('\0')) {
      this.executable = path.win32.join(root, 'BrowserClaw', 'Application', 'chrome.exe');
      this.profile = path.win32.join(root, 'BrowserClaw', 'User Data');
    }
  }

  async discover() {
    if (this.platform !== 'win32' || !this.executable || !this.profile) return null;
    try {
      for (const [location, kind] of [[this.executable, 'isFile'], [this.profile, 'isDirectory']]) {
        const entry = await this.lstat(location);
        if (!entry[kind]() || entry.isSymbolicLink?.()) return null;
        // An executable/profile junction must not redirect this fixed handoff.
        if (normalized(await this.realpath(location)) !== normalized(location)) return null;
      }
      return { executable: this.executable, profile: this.profile };
    } catch { return null; }
  }

  snapshot() {
    return {
      id: 'neo', destination: 'neo', name: 'BrowserOS neo', supported: this.platform === 'win32', available: this.available,
      pending: Boolean(this.pending), capabilities: { open: this.available && !this.pending && !this.closed && !this.isClosing() },
      handoff: 'native-import-dialog', importVerified: false,
      ...(!this.available ? { reason: this.platform === 'win32' ? 'An existing Neo installation and profile are required. Open Neo once before using its import dialog.' : 'The Neo import handoff is available on Windows.' } : {}),
    };
  }

  async status() {
    this.available = Boolean(await this.discover());
    return this.snapshot();
  }

  assertAdmission(signal) {
    if (this.closed || this.isClosing()) throw problem('BLACKICE is closing for maintenance.', 'BROWSER_IMPORT_CLOSED', 503);
    if (signal?.aborted) throw problem('Opening Neo import settings was cancelled before launch.', 'BROWSER_IMPORT_CANCELLED');
  }

  async open(value, { source, signal } = {}) {
    if (source !== 'user') throw problem('Open Neo import settings from BLACKICE on this computer.', 'BROWSER_IMPORT_LOCAL_ONLY', 403);
    if (!emptyObject(value)) throw problem('Neo import accepts an empty request only. Choose the source and data in Neo.', 'BROWSER_IMPORT_REQUEST', 400);
    this.assertAdmission(signal);
    // Two requests admitted while installation checks or spawn are pending
    // share one handoff, including when Neo is already running.
    if (this.pending) return this.pending;
    const pending = Promise.resolve().then(async () => {
      const installation = await this.discover();
      this.available = Boolean(installation);
      this.assertAdmission(signal);
      if (!installation) throw problem(this.snapshot().reason, 'BROWSER_IMPORT_UNAVAILABLE', 503);
      return new Promise((resolve, reject) => {
        let child, timer, settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          if (error) reject(error); else resolve(value);
        };
        const uncertain = () => problem('Neo may have opened its import settings. Check its window before requesting another handoff.', 'BROWSER_IMPORT_UNCERTAIN', 504, { uncertain: true });
        const abort = () => finish(uncertain());
        try {
          this.assertAdmission(signal);
          // Always submit the fixed URL to Chromium's singleton, even when a
          // Neo window already exists. No import switches or source paths.
          child = this.launch(installation.executable, [
            '--no-first-run', '--no-default-browser-check', `--user-data-dir=${installation.profile}`, '--new-window', NEO_IMPORT_URL,
          ], { shell: false, detached: true, windowsHide: false, stdio: 'ignore', cwd: path.win32.dirname(installation.executable) });
          child.once('error', () => finish(problem('Neo could not be started. Check the installed browser before trying again.', 'BROWSER_IMPORT_LAUNCH_FAILED', 503)));
          child.once('spawn', () => {
            child.unref?.();
            finish(null, { requested: true, destination: 'neo', nativeWindow: true, windowVerified: false, importCompleted: false });
          });
          signal?.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => finish(uncertain()), this.launchTimeoutMs);
          if (signal?.aborted) abort();
        } catch (error) {
          finish(error?.code?.startsWith('BROWSER_IMPORT_') ? error : problem('Neo could not be started. Check the installed browser before trying again.', 'BROWSER_IMPORT_LAUNCH_FAILED', 503));
        }
      });
    });
    this.pending = pending;
    try { return await pending; }
    finally { if (this.pending === pending) this.pending = null; }
  }

  async close() {
    this.closed = true;
    // The native browser belongs to the user; never terminate it on shutdown.
    await this.pending?.catch(() => {});
  }
}
