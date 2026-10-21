import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const PASSWORD_DESTINATIONS = Object.freeze([
  { id: 'chrome', name: 'Google Chrome', url: 'chrome://password-manager/settings' },
  { id: 'firefox', name: 'Mozilla Firefox', url: 'about:logins' },
  { id: 'neo', name: 'BrowserOS Neo', url: 'chrome://password-manager/settings' },
]);
const fail = (message, code = 'CREDENTIAL_DESTINATION_UNAVAILABLE', status = 409) => Object.assign(new Error(message), { code, status });
const normal = value => path.win32.normalize(value).toLowerCase();
const root = value => typeof value === 'string' && /^[a-z]:[\\/]/i.test(value) && !/[\0\r\n]/.test(value);

/** Native password-manager handoff. The browser alone chooses its profile and
 * imports the file. No password, export path or browser debugging flag is
 * passed to a process, and a spawn receipt is never an import receipt. */
export class BrowserCredentialDestination {
  constructor({ platform = process.platform, env = process.env, launch = spawn, lstat = fs.lstat, realpath = fs.realpath, isClosing = () => false, timeoutMs = 5000 } = {}) {
    Object.assign(this, { platform, launch, lstat, realpath, isClosing });
    this.timeoutMs = Math.max(100, Math.min(10000, timeoutMs));
    this.pending = new Map(); this.closed = false;
    const local = root(env.LOCALAPPDATA) ? env.LOCALAPPDATA : null;
    const programs = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(root);
    this.paths = {
      chrome: [...(local ? [path.win32.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []), ...programs.map(value => path.win32.join(value, 'Google', 'Chrome', 'Application', 'chrome.exe'))],
      firefox: programs.map(value => path.win32.join(value, 'Mozilla Firefox', 'firefox.exe')),
      neo: local ? [path.win32.join(local, 'BrowserClaw', 'Application', 'chrome.exe')] : [],
    };
    this.neoProfile = local ? path.win32.join(local, 'BrowserClaw', 'User Data') : null;
  }
  async ordinary(filename, directory = false) {
    try { const info = await this.lstat(filename); return !info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile()) && normal(await this.realpath(filename)) === normal(filename); } catch { return false; }
  }
  async discover(id) {
    if (this.platform !== 'win32' || !Object.hasOwn(this.paths, id)) return null;
    for (const executable of this.paths[id]) if (await this.ordinary(executable) && (id !== 'neo' || await this.ordinary(this.neoProfile, true))) return executable;
    return null;
  }
  async status() {
    return Promise.all(PASSWORD_DESTINATIONS.map(async ({ id, name }) => ({ id, name, available: Boolean(await this.discover(id)), supported: this.platform === 'win32', pending: this.pending.has(id), handoff: 'native-password-import', automaticImport: false, profileSelection: 'Choose the destination profile in the native browser.' })));
  }
  admission(signal) {
    if (this.closed || this.isClosing()) throw fail('BLACKICE is closing for maintenance.', 'CREDENTIAL_DESTINATION_CLOSED', 503);
    if (signal?.aborted) throw fail('The browser handoff was cancelled.', 'ABORT_ERR');
  }
  async open(id, { source, signal } = {}) {
    if (source !== 'user') throw fail('Start browser password import from BLACKICE on this computer.', 'CREDENTIAL_DESTINATION_LOCAL_ONLY', 403);
    if (!PASSWORD_DESTINATIONS.some(value => value.id === id)) throw fail('Choose Chrome, Firefox or Neo.', 'CREDENTIAL_DESTINATION_INVALID', 400);
    this.admission(signal);
    if (this.pending.has(id)) return this.pending.get(id);
    const pending = (async () => {
      const executable = await this.discover(id); this.admission(signal);
      if (!executable) throw fail('The selected browser is not installed in a supported location.');
      const url = PASSWORD_DESTINATIONS.find(value => value.id === id).url;
      const args = id === 'firefox' ? ['--new-tab', url] : ['--no-first-run', '--no-default-browser-check', ...(id === 'neo' ? [`--user-data-dir=${this.neoProfile}`] : []), '--new-window', url];
      return new Promise((resolve, reject) => {
        let timer, settled = false;
        const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(result); };
        const uncertain = () => fail('The browser may have opened. Check its password manager before retrying.', 'CREDENTIAL_DESTINATION_UNCERTAIN', 504);
        const abort = () => finish(uncertain());
        try {
          this.admission(signal);
          const child = this.launch(executable, args, { shell: false, detached: true, windowsHide: false, stdio: 'ignore', cwd: path.win32.dirname(executable) });
          child.once('error', () => finish(fail('The selected browser could not be opened.', 'CREDENTIAL_DESTINATION_LAUNCH_FAILED', 503)));
          child.once('spawn', () => { child.unref?.(); finish(null, { destinationId: id, requested: true, windowVerified: false, importCompleted: false, profileVerified: false }); });
          signal?.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => finish(uncertain()), this.timeoutMs);
          if (signal?.aborted) abort();
        } catch (error) { finish(error?.code?.startsWith('CREDENTIAL_DESTINATION_') ? error : fail('The browser handoff failed.', 'CREDENTIAL_DESTINATION_LAUNCH_FAILED', 503)); }
      });
    })();
    this.pending.set(id, pending);
    try { return await pending; } finally { if (this.pending.get(id) === pending) this.pending.delete(id); }
  }
  async close() { this.closed = true; await Promise.allSettled([...this.pending.values()]); }
}
