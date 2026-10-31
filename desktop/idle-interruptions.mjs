import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IdleInterruptions } from '../lib/idle-interruptions.mjs';

const execute = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('./idle-interruptions.ps1', import.meta.url));
const failure = (message, code = 'IDLE_INTERRUPTION_NATIVE_FAILED') => Object.assign(new Error(message), { code, status: 409 });
const parse = text => {
  let result; try { result = JSON.parse(String(text).replace(/^\uFEFF/, '').trim()); } catch { throw failure('Windows returned an unreadable interruption status.'); }
  if (result?.schemaVersion !== 1 || result.fatal === true) throw failure('Windows interruption settings could not be verified.');
  return result;
};

export async function runIdlePowerShell(action, { backupRoot, statePath, execFileImpl = execute, spawnImpl = spawn, systemRoot = process.env.SystemRoot || 'C:\\Windows', script = SCRIPT } = {}) {
  if (!['Inspect','Enable'].includes(action)) throw failure('Unknown interruption setup action.', 'IDLE_INTERRUPTION_ACTION');
  if (action === 'Enable' && (typeof backupRoot !== 'string' || !path.win32.isAbsolute(backupRoot) || /^[\\/]{2}/.test(backupRoot) || /[\x00-\x1f\x7f"]/.test(backupRoot))) throw failure('Interruption setup requires a local profile backup folder.', 'IDLE_INTERRUPTION_PATH');
  if (statePath !== undefined && (typeof statePath !== 'string' || !path.win32.isAbsolute(statePath) || /^[\\/]{2}/.test(statePath) || /[\x00-\x1f\x7f"]/.test(statePath))) throw failure('Interruption setup requires a local profile state file.', 'IDLE_INTERRUPTION_PATH');
  const file = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',script,'-Action',action, ...(action === 'Enable' ? ['-BackupRoot', backupRoot] : []), ...(statePath ? ['-StatePath',statePath] : [])];
  if (action === 'Inspect') {
    try { return parse((await execFileImpl(file, args, { windowsHide: true, shell: false, timeout: 20000, maxBuffer: 131072, encoding: 'utf8' })).stdout); }
    catch { throw failure('Windows interruption settings could not be read.', 'IDLE_INTERRUPTION_READ_FAILED'); }
  }
  // Killing a wrapper can orphan its UAC child. Like connection startup, setup
  // waits for real completion; the server's mutation barrier holds app restart.
  return new Promise((resolve, reject) => {
    let child; try { child = spawnImpl(file, args, { windowsHide: true, shell: false, stdio: ['ignore','pipe','pipe'] }); }
    catch { reject(failure('Windows could not start interruption setup.')); return; }
    let output = '', failed = false;
    child.stdout.on('data', chunk => { output += String(chunk); if (output.length > 131072) { output = ''; failed = true; } });
    child.stderr.on('data', () => {});
    child.once('error', () => { failed = true; });
    child.once('close', code => {
      if (failed || code !== 0) { reject(failure('Windows could not complete interruption setup. Review the current checks.')); return; }
      try { resolve(parse(output)); } catch (error) { reject(error); }
    });
  });
}

export function createDesktopIdleInterruptions({ platform = process.platform, dataDir, runPowerShell = runIdlePowerShell, now, cacheMs } = {}) {
  if (platform !== 'win32') return new IdleInterruptions({ platform, now, cacheMs });
  const backupRoot = path.win32.join(dataDir, 'idle-interruptions', 'backups');
  const statePath = path.win32.join(dataDir, 'idle-interruptions', 'state.json');
  return new IdleInterruptions({ platform, now, cacheMs,
    inspect: () => runPowerShell('Inspect', { statePath }),
    apply: () => runPowerShell('Enable', { backupRoot, statePath }),
  });
}
