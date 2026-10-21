import { EventEmitter } from 'node:events';
import path from 'node:path';
import { promises as fs } from 'node:fs';

/** Parse app flags before Electron chooses its profile and acquires its profile-specific lock. */
export function parseDesktopLaunchArgs(argv = process.argv, { platform = process.platform } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  let headless = false, background = false, quit = false, restart = false, profileDir = null;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--headless') headless = true;
    else if (argument === '--background') background = true;
    else if (argument === '--quit') quit = true;
    else if (argument === '--restart') restart = true;
    else if (argument === '--profile-dir' || argument === '--profile' || argument.startsWith('--profile-dir=') || argument.startsWith('--profile=')) {
      if (profileDir !== null) throw new Error('Choose the desktop profile only once.');
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argv[++index];
      if (typeof value !== 'string' || !value || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value) || !paths.isAbsolute(value) || platform === 'win32' && (/^[\\/]{2}/.test(value) || !/^[a-z]:[\\/]/i.test(value))) throw new Error('Use --profile-dir with an absolute local directory path.');
      const normalized = paths.normalize(value);
      if (normalized === paths.parse(normalized).root) throw new Error('Choose a profile directory inside a local drive, not the drive root.');
      profileDir = normalized;
    } else if (/^--(?:headless|background|quit|restart)=/.test(argument)) throw new Error('Use desktop lifecycle flags without a value.');
  }
  if (restart && (quit || headless || background)) throw new Error('Use --restart without --quit, --headless or --background; restarting preserves the current mode.');
  if (headless && background || quit && (headless || background)) throw new Error('Choose only one of --headless, --background or --quit.');
  return { headless, background, quit, restart, profileDir };
}

/** Electron relaunch arguments omit the executable and restore the current profile and mode. */
export function buildDesktopRelaunchArgs({ argv = process.argv, profileDir = null, mode } = {}) {
  if (!['window', 'background', 'headless'].includes(mode)) throw new Error('Choose the current desktop mode before restarting.');
  const args = [];
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (/^--(?:restart|quit|headless|background)(?:=|$)/.test(argument)) continue;
    if (argument === '--profile-dir' || argument === '--profile') { index++; continue; }
    if (/^--(?:profile-dir|profile)=/.test(argument)) continue;
    args.push(argument);
  }
  if (profileDir !== null) args.push('--profile-dir', profileDir);
  if (mode !== 'window') args.push(`--${mode}`);
  return args;
}

export async function prepareDesktopProfile(launch, { defaultProfile } = {}) {
  if (!launch.profileDir) return defaultProfile;
  const profile = launch.profileDir;
  // Reject redirected profile ancestors before creating anything. SafeStorage,
  // Chromium and BLACKICE must all use the same ordinary local directory.
  for (let current = profile; ; current = path.dirname(current)) {
    try { const stat = await fs.lstat(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('The desktop profile must be an ordinary local directory without symbolic links.'); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    const parent = path.dirname(current); if (parent === current) break;
  }
  await fs.mkdir(profile, { recursive: true });
  const stat = await fs.lstat(profile); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('The desktop profile must be an ordinary local directory.');
  return profile;
}

/** Routes desktop requests and owns window visibility; runtime shutdown remains with main.mjs. */
export class DesktopLifecycle extends EventEmitter {
  constructor({ headless = false, background = false, getWindow, createWindow, saveWindow = async () => {}, quit, restart } = {}) {
    super(); this.mode = headless ? 'headless' : background ? 'background' : 'window'; this.getWindow = getWindow; this.createWindow = createWindow; this.saveWindow = saveWindow; this.quit = quit; this.restart = restart;
    this.ready = new Promise(resolve => { this.resolveReady = resolve; }); this.started = false; this.stopped = false; this.quitting = false; this.creating = null; this.restarting = null;
  }
  status() { const window = this.getWindow?.(); return { available: true, mode: this.mode, windowVisible: Boolean(window && !window.isDestroyed() && window.isVisible()), sameProfile: true, supportsHeadless: true, supportsRestart: typeof this.restart === 'function', localManagement: true }; }
  updated() { this.emit('updated', this.status()); }
  async start() { if (this.started) return this.status(); this.started = true; this.resolveReady(); if (this.mode === 'window' && !this.stopped) return this.show(); this.updated(); return this.status(); }
  async show() {
    await this.ready; if (this.stopped) throw new Error('BLACKICE is closing.');
    this.mode = 'window';
    const existing = this.getWindow?.();
    if (!existing || existing.isDestroyed()) {
      if (!this.creating) this.creating = Promise.resolve().then(() => this.createWindow()).finally(() => { this.creating = null; });
      await this.creating;
    }
    const window = this.getWindow?.();
    if (!this.stopped && this.mode === 'window' && window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
    this.updated(); return this.status();
  }
  async background() {
    if (this.stopped) throw new Error('BLACKICE is closing.');
    this.mode = 'background'; await this.saveWindow();
    const window = this.getWindow?.(); if (window && !window.isDestroyed()) window.hide();
    this.updated(); return this.status();
  }
  secondInstance(launch = {}) {
    if (launch.quit) { this.requestQuit(); return Promise.resolve(this.status()); }
    if (launch.restart) return this.requestRestart();
    return launch.headless || launch.background ? Promise.resolve(this.status()) : this.show();
  }
  requestRestart() {
    if (typeof this.restart !== 'function') return Promise.reject(new Error('Desktop restart is unavailable.'));
    if (!this.restarting) {
      this.restarting = this.ready.then(async () => {
        if (this.stopped || this.quitting) throw new Error('BLACKICE is closing.');
        await this.restart(); return this.status();
      }).catch(error => { this.restarting = null; throw error; });
    }
    return this.restarting;
  }
  windowClosed() { if (!this.stopped && this.mode === 'window') this.requestQuit(); }
  requestQuit() { if (!this.quitting) { this.quitting = true; this.quit?.(); } }
  stop() { this.stopped = true; this.resolveReady(); }
}
