import { stat } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const BACKGROUND_ARGS = ['--no-first-run', '--no-default-browser-check', '--no-startup-window', '--keep-alive-for-test'];
const CHECK_SCRIPT = `$ErrorActionPreference = 'Stop'
$taskBrowserExecutable = [Environment]::GetEnvironmentVariable('RELAY_BROWSER_STARTUP_EXE')
if ([string]::IsNullOrWhiteSpace($taskBrowserExecutable)) { throw 'Missing target executable' }
$taskBrowserProcesses = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction Stop)
$taskBrowserUnknown = @($taskBrowserProcesses | Where-Object { [string]::IsNullOrWhiteSpace($_.ExecutablePath) })
$taskBrowserMatches = @($taskBrowserProcesses | Where-Object { [string]::Equals($_.ExecutablePath, $taskBrowserExecutable, [StringComparison]::OrdinalIgnoreCase) })
[pscustomobject]@{ matchingCount = $taskBrowserMatches.Count; uncertain = ($taskBrowserUnknown.Count -gt 0) } | ConvertTo-Json -Compress
`;

function installationPath(env) {
  const local = env?.LOCALAPPDATA;
  if (typeof local !== 'string' || !path.win32.isAbsolute(local) || local.includes('\0')) return null;
  return path.win32.join(local, 'BrowserClaw', 'Application', 'chrome.exe');
}
function profilePath(env) {
  if (!installationPath(env)) return null;
  return path.win32.join(env.LOCALAPPDATA, 'BrowserClaw', 'User Data');
}

/** Query full process paths without returning command lines or other browser data. */
export async function checkBrowserProcesses(executable, { execFileImpl = execFileAsync, env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return { running: false, uncertain: true };
  try {
    const result = await execFileImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(CHECK_SCRIPT, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 3000, maxBuffer: 65536, encoding: 'utf8',
      env: { ...env, RELAY_BROWSER_STARTUP_EXE: executable },
    });
    const value = JSON.parse(String(result.stdout).trim().replace(/^\uFEFF/, ''));
    if (!Number.isSafeInteger(value.matchingCount) || value.matchingCount < 0 || typeof value.uncertain !== 'boolean') return { running: false, uncertain: true };
    return { running: value.matchingCount > 0, uncertain: value.uncertain };
  } catch { return { running: false, uncertain: true }; }
}

export async function inspectBackgroundBrowser({ env = process.env, platform = process.platform, statImpl = stat, processCheckImpl = checkBrowserProcesses, execFileImpl } = {}) {
  if (platform !== 'win32') return { available: false, installed: false, running: false, canStart: false, reason: 'Background BrowserOS startup is available on Windows.' };
  const executable = installationPath(env);
  if (!executable) return { available: false, installed: false, running: false, canStart: false, reason: 'The local BrowserOS neo installation folder could not be determined.' };
  try {
    if (!(await statImpl(executable)).isFile()) throw Object.assign(new Error('Not an executable file'), { code: 'ENOENT' });
  } catch (error) {
    return { available: false, installed: error.code === 'ENOENT' ? false : null, running: false, canStart: false, reason: error.code === 'ENOENT' ? 'BrowserOS neo is not installed in its standard local folder.' : 'The BrowserOS neo installation could not be checked.' };
  }
  let processes;
  try { processes = await processCheckImpl(executable, { env, platform, execFileImpl }); }
  catch { processes = { running: false, uncertain: true }; }
  if (processes?.running === true) return { available: true, installed: true, running: true, canStart: false, reason: 'BrowserOS neo is already running. Reconnect its existing browser tools.' };
  if (processes?.running !== false || processes?.uncertain !== false) return { available: true, installed: true, running: false, canStart: false, reason: 'Could not confirm whether BrowserOS neo is already running. It was left untouched.' };
  try {
    if (!(await statImpl(profilePath(env))).isDirectory()) throw Object.assign(new Error('Not a profile directory'), { code: 'ENOENT' });
  } catch (error) {
    return { available: true, installed: true, running: false, canStart: false, persistentProfileAvailable: false, reason: error.code === 'ENOENT' ? 'The existing BrowserOS neo profile folder was not found. Open BrowserOS neo once before starting it here.' : 'The existing BrowserOS neo profile folder could not be checked. It was left untouched.' };
  }
  return { available: true, installed: true, running: false, canStart: true, persistentProfileAvailable: true, reason: 'BrowserOS neo can be started manually using its existing profile. This external browser may foreground.' };
}

// A user can click twice before the UI disables its button. Share the one launch
// instead of forwarding a second start to Chromium's process singleton.
let startupPromise = null;
export async function startBackgroundBrowser(options = {}) {
  if (options.signal?.aborted) return { started: false, running: false, canStart: false, reason: 'Background browser startup was cancelled.' };
  if (startupPromise) return startupPromise;
  startupPromise = (async () => {
    const status = await inspectBackgroundBrowser(options);
    if (options.signal?.aborted) return { ...status, started: false, reason: 'Background browser startup was cancelled.' };
    if (!status.canStart) return { ...status, started: false };
    const startupEnv = options.env || process.env, executable = installationPath(startupEnv), spawnImpl = options.spawnImpl || spawn;
    let child;
    try {
      // Manual startup requests no initial window and a persistent process.
      // These flags do not verify or guarantee that Neo stays out of the
      // foreground. Agent tools cannot use this external browser connection.
      child = spawnImpl(executable, [...BACKGROUND_ARGS, `--user-data-dir=${profilePath(startupEnv)}`], { windowsHide: true, detached: true, stdio: 'ignore', shell: false });
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', resolve);
      });
      child.unref();
      return { ...status, running: true, canStart: false, started: true, pid: child.pid, reason: 'BrowserOS neo started for a manual external browser connection. It may foreground.' };
    } catch {
      return { ...status, started: false, reason: 'BrowserOS neo could not start in the background. Its existing profile was left in place.' };
    }
  })();
  try { return await startupPromise; }
  finally { startupPromise = null; }
}
