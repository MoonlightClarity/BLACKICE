import { readFile, stat } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const FILE_LIMIT = 256 * 1024;
const unavailable = reason => ({ available: false, canStart: false, reason });
const normalized = value => path.win32.normalize(value).toLowerCase();
const absolute = value => typeof value === 'string' && path.win32.isAbsolute(value) && !value.includes('\0');
const boundedTimeout = (value, fallback = 15000) => Number.isFinite(value) ? Math.max(0, Math.min(30000, value)) : fallback;
const childExited = child => (child?.exitCode !== undefined && child.exitCode !== null) || !!child?.signalCode;

function ini(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > FILE_LIMIT) throw new Error('Metadata limit');
  const sections = new Map(); let current;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[;#]/.test(line)) continue;
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) { current = {}; sections.set(section[1], current); continue; }
    const entry = /^([^=]+)=(.*)$/.exec(line);
    if (current && entry) current[entry[1].trim()] = entry[2].trim();
  }
  return sections;
}
function profilePath(root, value, relative = !absolute(value)) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return null;
  if (!relative && !absolute(value)) return null;
  const result = relative ? path.win32.resolve(root, value) : path.win32.normalize(value);
  return absolute(result) ? result : null;
}
function executables(env) {
  return [...new Set([
    absolute(env.ProgramFiles) && path.win32.join(env.ProgramFiles, 'Mozilla Firefox', 'firefox.exe'),
    absolute(env['ProgramFiles(x86)']) && path.win32.join(env['ProgramFiles(x86)'], 'Mozilla Firefox', 'firefox.exe'),
    absolute(env.LOCALAPPDATA) && path.win32.join(env.LOCALAPPDATA, 'Mozilla Firefox', 'firefox.exe'),
  ].filter(Boolean))];
}

/** Read only Firefox's profile index and compatibility metadata, never account stores. */
export async function discoverFirefoxProfile({ env = process.env, platform = process.platform, statImpl = stat, readFileImpl = readFile } = {}) {
  if (platform !== 'win32') return unavailable('Existing Firefox session reuse is available on Windows.');
  if (!absolute(env.APPDATA)) return unavailable('The Firefox profile index location could not be determined.');
  const installed = [];
  for (const executable of executables(env)) try { if ((await statImpl(executable)).isFile()) installed.push(executable); } catch {}
  if (!installed.length) return unavailable('Firefox was not found in its standard installation folders.');
  const root = path.win32.join(env.APPDATA, 'Mozilla', 'Firefox');
  let sections;
  try { sections = ini(await readFileImpl(path.win32.join(root, 'profiles.ini'), 'utf8')); }
  catch { return unavailable('The existing Firefox profile index could not be read. No profile was created.'); }
  const profiles = [];
  for (const [section, values] of sections) {
    if (!/^Profile\d+$/.test(section)) continue;
    const location = profilePath(root, values.Path, values.IsRelative !== '0');
    if (location) profiles.push({ path: location, name: values.Name || path.win32.basename(location), legacyDefault: values.Default === '1' });
  }
  const defaults = [];
  for (const [section, values] of sections) {
    if (!/^Install[A-Za-z0-9]+$/.test(section)) continue;
    const location = profilePath(root, values.Default);
    if (location && !defaults.some(profile => normalized(profile.path) === normalized(location))) defaults.push({ ...(profiles.find(profile => normalized(profile.path) === normalized(location)) || { path: location, name: path.win32.basename(location) }), source: 'install-default' });
  }
  let selected, executable = installed[0];
  if (defaults.length === 1) selected = defaults[0];
  else if (defaults.length > 1) {
    const matching = [];
    for (const profile of defaults.slice(0, 20)) try {
      const compatibility = ini(await readFileImpl(path.win32.join(profile.path, 'compatibility.ini'), 'utf8')).get('Compatibility');
      const binary = installed.find(candidate => absolute(compatibility?.LastPlatformDir) && normalized(path.win32.dirname(candidate)) === normalized(compatibility.LastPlatformDir));
      if (binary) matching.push({ profile, executable: binary });
    } catch {}
    if (matching.length === 1) { selected = matching[0].profile; executable = matching[0].executable; }
    else return unavailable('Firefox has multiple installation defaults. Select its existing profile before connecting.');
  } else {
    const legacy = profiles.filter(profile => profile.legacyDefault);
    if (legacy.length === 1) selected = { ...legacy[0], source: 'legacy-default' };
    else if (profiles.length === 1) selected = { ...profiles[0], source: 'only-profile' };
    else return unavailable('Firefox has no unambiguous existing default profile.');
  }
  if (!selected) return unavailable('No existing Firefox profile was found.');
  try { if (!(await statImpl(selected.path)).isDirectory()) throw new Error('Missing directory'); }
  catch { return unavailable('The selected Firefox profile directory could not be opened. It was left untouched.'); }
  // A lone per-install default can still belong to an x86 or per-user install.
  try {
    const compatibility = ini(await readFileImpl(path.win32.join(selected.path, 'compatibility.ini'), 'utf8')).get('Compatibility');
    const binary = installed.find(candidate => absolute(compatibility?.LastPlatformDir) && normalized(path.win32.dirname(candidate)) === normalized(compatibility.LastPlatformDir));
    if (binary) executable = binary;
  } catch {}
  return { available: true, executable, profilePath: selected.path, profileName: selected.name, profileSource: selected.source, reason: 'An existing Firefox profile is available. Website sign-in still needs a page check.' };
}

export async function checkFirefoxProcesses({ env = process.env, platform = process.platform, execFileImpl = execFileAsync } = {}) {
  if (platform !== 'win32') return { running: false, uncertain: true };
  const script = `$ErrorActionPreference='Stop'; $taskFirefoxProcesses=@(Get-CimInstance Win32_Process -Filter "Name='firefox.exe'" -ErrorAction Stop); [pscustomobject]@{count=$taskFirefoxProcesses.Count}|ConvertTo-Json -Compress`;
  try {
    const result = await execFileImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env, windowsHide: true, timeout: 3000, maxBuffer: 65536, encoding: 'utf8' });
    const value = JSON.parse(String(result.stdout).trim().replace(/^\uFEFF/, ''));
    if (!Number.isSafeInteger(value.count) || value.count < 0) throw new Error('Invalid process inventory');
    return { running: value.count > 0, uncertain: false };
  } catch { return { running: false, uncertain: true }; }
}

export async function firefoxSessionStatus(options = {}) {
  const profile = await discoverFirefoxProfile(options);
  if (!profile.available) return profile;
  let processes;
  try { processes = await (options.processCheckImpl || checkFirefoxProcesses)(options); } catch { processes = { uncertain: true }; }
  if (processes?.running === true) return { ...profile, running: true, canStart: false, reason: 'Firefox is already running. It was left untouched; close it before starting its profile in the background.' };
  if (processes?.running !== false || processes?.uncertain !== false) return { ...profile, running: false, canStart: false, reason: 'Could not confirm whether Firefox is already running. It was left untouched.' };
  return { ...profile, running: false, canStart: true, background: true, physicalInput: false };
}

export function firefoxBiDiEndpoint(value, expectedPort) {
  let url; try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.search || url.hash || !['', '/', '/session'].includes(url.pathname) || !url.port || expectedPort && Number(url.port) !== expectedPort) return null;
  url.pathname = '/session'; return url.href;
}

/** Wait for Firefox to flush its real profile after BiDi browser.close. Never kill it. */
export async function waitForFirefoxExit(child, { timeoutMs = 15000 } = {}) {
  if (!child || typeof child.once !== 'function') return { closed: false, running: true, reason: 'The owned Firefox process could not be checked.' };
  if (childExited(child)) return { closed: true, running: false };
  return new Promise(resolve => {
    let finished = false;
    const finish = closed => {
      if (finished) return;
      finished = true; clearTimeout(timer); child.removeListener('exit', exited);
      resolve(closed ? { closed: true, running: false } : { closed: false, running: true, reason: 'Firefox is still closing. Its process and profile were left intact.' });
    };
    const exited = () => finish(true);
    const timer = setTimeout(() => finish(false), boundedTimeout(timeoutMs));
    child.once('exit', exited);
    if (childExited(child)) finish(true);
  });
}

function ownedFirefoxLaunch(child, profile, options, onExit) {
  const changes = new EventEmitter();
  let spawned = false, exited = childExited(child), endpoint, buffer = '', startupState = 'starting', closeAttempt, closing = false;
  const endpointReady = () => spawned && !!endpoint && !exited;
  const changed = () => changes.emit('changed');
  const finish = () => {
    if (exited) return;
    exited = true; startupState = 'exited';
    child.stderr?.removeListener('data', data);
    child.stderr?.removeListener('error', streamError);
    child.removeListener('spawn', didSpawn);
    changed(); onExit();
  };
  const data = chunk => {
    buffer = (buffer + String(chunk)).slice(-8192);
    // Wait for the entire line: a pipe chunk can split the port number itself.
    for (const match of buffer.matchAll(/(?:^|\n)WebDriver BiDi listening on (ws:\/\/[^\s]+)[ \t]*(?=\r?\n)/g)) {
      const candidate = firefoxBiDiEndpoint(match[1], options.port);
      if (candidate && !endpoint) { endpoint = candidate; changed(); }
    }
    const newline = buffer.lastIndexOf('\n');
    if (newline >= 0) buffer = buffer.slice(newline + 1);
  };
  const didSpawn = () => {
    spawned = true; child.unref?.(); child.stderr?.unref?.();
    try { options.onSpawn?.(child); } catch {}
    changed();
  };
  const streamError = () => { startupState = 'stream-error'; changed(); };
  child.once('spawn', didSpawn);
  child.once('exit', finish);
  child.once('error', () => {
    // An error before spawn means Node could not create a process. After spawn,
    // only an exit event proves the owned Firefox has released its profile.
    if (!spawned && !child.pid) finish();
    else { startupState = 'process-error'; changed(); }
  });
  child.stderr?.on('data', data);
  child.stderr?.on('error', streamError);
  child.stderr?.resume?.();

  const reason = () => exited ? 'The owned Firefox process has exited and released its profile.'
    : closing ? 'Firefox is closing and saving its profile. Wait for a clean exit before reconnecting.'
    : startupState === 'close-unconfirmed' ? 'Firefox has not confirmed a clean exit. Relay retains ownership; retry Disconnect before opening its profile normally.'
    : startupState === 'cancelled' ? 'Firefox startup was cancelled. Relay still owns its background process until a clean exit is confirmed.'
    : endpoint && spawned ? 'Firefox started in the background using its existing profile. Check the website to verify its sign-in.'
    : startupState === 'timeout' ? 'Firefox did not report a complete browser endpoint in time. Relay retains ownership; retry Disconnect to release its profile.'
    : ['stream-error', 'process-error'].includes(startupState) ? 'Firefox startup could not be confirmed. Relay retains ownership of its background process.'
    : 'Firefox is starting in the background using its existing profile.';

  const handle = {
    ...profile, canStart: false, owned: true,
    get pid() { return child.pid; },
    get started() { return spawned || !exited && !!child.pid; },
    get running() { return !exited; },
    get ready() { return endpointReady() && !closing; },
    get closing() { return closing; },
    get endpoint() { return endpoint; },
    get cancelled() { return startupState === 'cancelled'; },
    get recoveryRequired() { return !exited && !['starting', 'ready'].includes(startupState); },
    get reason() { return reason(); },
    async waitForReady({ timeoutMs = options.timeoutMs, signal } = {}) {
      if (endpointReady() || exited || signal?.aborted) return this;
      await new Promise(resolve => {
        let done = false;
        const finishWait = () => {
          if (done) return; done = true; clearTimeout(timer);
          changes.removeListener('changed', inspect); signal?.removeEventListener('abort', finishWait); resolve();
        };
        const inspect = () => { if (endpointReady() || exited) finishWait(); };
        const timer = setTimeout(finishWait, boundedTimeout(timeoutMs));
        changes.on('changed', inspect); signal?.addEventListener('abort', finishWait, { once: true });
        inspect(); if (signal?.aborted) finishWait();
      });
      return this;
    },
    async stop({ closeBrowser = options.closeBrowserImpl, timeoutMs = options.closeTimeoutMs } = {}) {
      if (exited) return { closed: true, running: false, owned: true };
      if (closeAttempt) return closeAttempt;
      closing = true; changed();
      closeAttempt = (async () => {
        const budget = boundedTimeout(timeoutMs), deadline = Date.now() + budget;
        let closeRequested = false;
        if (typeof closeBrowser === 'function') {
          if (!endpointReady()) await this.waitForReady({ timeoutMs: Math.min(1000, budget) });
          if (exited) return { closed: true, running: false, owned: true };
          if (endpointReady()) {
            const controller = new AbortController();
            let timer;
            try {
              const requested = Promise.resolve().then(() => closeBrowser({ endpoint, pid: child.pid, profileName: profile.profileName, profileSource: profile.profileSource, signal: controller.signal }));
              await Promise.race([requested, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Close deadline')); }, Math.max(0, deadline - Date.now())); })]);
              closeRequested = true;
            } catch {} finally { clearTimeout(timer); }
          }
        }
        const result = await waitForFirefoxExit(child, { timeoutMs: Math.max(0, deadline - Date.now()) });
        if (result.closed) finish();
        if (!result.closed) startupState = 'close-unconfirmed';
        return result.closed ? { closed: true, running: false, owned: true }
          : { closed: false, running: true, owned: true, recoveryRequired: true, closeRequested,
            reason: !endpoint ? 'Firefox has not reported its local control endpoint. Relay retains ownership; retry Disconnect when it becomes ready. Its profile remains in use.'
              : 'Firefox has not confirmed a clean exit. Relay retains ownership; retry Disconnect before opening its profile normally.' };
      })();
      try { return await closeAttempt; } finally { closeAttempt = null; closing = false; changed(); }
    },
    markStartup(state) { startupState = state; },
  };
  if (exited) queueMicrotask(onExit);
  return handle;
}

/** One launcher retains its owned process across timeouts and failed driver handshakes. */
export function createFirefoxSessionLauncher() {
  let startupPromise, owned;
  return { current: () => owned, async start(options = {}) {
    if (options.signal?.aborted) return { ...unavailable('Firefox startup was cancelled.'), started: false, running: false };
    if (startupPromise) return startupPromise;
    if (owned?.running) {
      const current = owned;
      if (current.closing) return current;
      await current.waitForReady({ timeoutMs: options.timeoutMs, signal: options.signal });
      current.markStartup(options.signal?.aborted ? 'cancelled' : current.ready ? 'ready' : current.running ? 'timeout' : 'exited');
      return current;
    }
    startupPromise = (async () => {
    const port = options.port ?? 0;
    if (!Number.isInteger(port) || port < 0 || port > 65535) return { ...unavailable('Choose an available local browser port.'), started: false };
    if (options.signal?.aborted) return { ...unavailable('Firefox startup was cancelled.'), started: false };
    const status = await firefoxSessionStatus(options);
    if (!status.canStart) return { ...status, started: false };
    if (options.signal?.aborted) return { ...status, started: false, reason: 'Firefox startup was cancelled.' };
    // Recheck immediately before spawning; metadata discovery may take time. Firefox's
    // own profile lock remains the final arbiter if another launch wins the race.
    let current;
    try { current = await (options.processCheckImpl || checkFirefoxProcesses)(options); } catch { current = { uncertain: true }; }
    if (current?.running !== false || current?.uncertain !== false) return { ...status, started: false, running: current?.running === true, canStart: false, reason: 'Firefox may already be running. Its existing session was left untouched.' };
    if (options.signal?.aborted) return { ...status, started: false, reason: 'Firefox startup was cancelled.' };
    try {
      const child = (options.spawnImpl || spawn)(status.executable, ['--headless', '--no-remote', '--new-instance', '--profile', status.profilePath, `--remote-debugging-port=${port}`], { windowsHide: true, detached: true, stdio: ['ignore', 'ignore', 'pipe'], shell: false });
      const handle = ownedFirefoxLaunch(child, status, { ...options, port }, () => { if (owned === handle) owned = null; });
      owned = handle;
      await handle.waitForReady({ timeoutMs: options.timeoutMs, signal: options.signal });
      handle.markStartup(options.signal?.aborted ? 'cancelled' : handle.ready ? 'ready' : handle.running ? 'timeout' : 'exited');
      return handle;
    } catch { return { ...status, started: false, reason: 'Firefox could not start in the background. Its existing profile was left in place.' }; }
  })();
  try { return await startupPromise; } finally { startupPromise = null; }
  } };
}

const defaultLauncher = createFirefoxSessionLauncher();
export async function startFirefoxSession(options = {}) { return defaultLauncher.start(options); }
