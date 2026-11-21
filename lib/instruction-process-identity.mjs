import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
const unavailable = () => Object.assign(new Error('The Instructions lock process identity could not be verified. Existing ownership was preserved.'),
  { status: 503, code: 'INSTRUCTIONS_LOCK_IDENTITY_UNAVAILABLE' });
const missing = pid => {
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
};
let currentIdentity;

async function observe(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw unavailable();
  if (missing(pid)) return null;
  try {
    if (process.platform === 'win32') {
      const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const command = "$ErrorActionPreference='Stop'; $instructionOwnerProcess=Get-Process -Id " + pid
        + "; $instructionHost=[Microsoft.Win32.Registry]::GetValue('HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography','MachineGuid',$null);"
        + " if(-not $instructionHost){throw 'Host identity unavailable'};"
        + " [pscustomobject]@{hostId=[string]$instructionHost;startId=$instructionOwnerProcess.StartTime.ToUniversalTime().Ticks.ToString()} | ConvertTo-Json -Compress";
      const { stdout } = await execute(shell, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 10000, maxBuffer: 8192 });
      const value = JSON.parse(stdout.trim());
      if (typeof value.hostId !== 'string' || !value.hostId || typeof value.startId !== 'string' || !/^\d+$/.test(value.startId)) throw unavailable();
      return { hostId: digest('windows:' + value.hostId), startId: value.startId };
    }
    if (process.platform === 'linux') {
      const [stat, boot, machine] = await Promise.all([
        fs.readFile('/proc/' + pid + '/stat', 'utf8'), fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
        fs.readFile('/etc/machine-id', 'utf8').catch(() => ''),
      ]);
      // /proc stat field 22; the parenthesized command can contain spaces.
      const started = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
      if (!/^\d+$/.test(started || '') || !boot.trim()) throw unavailable();
      return { hostId: digest('linux:' + (machine.trim() || boot.trim())), startId: boot.trim() + ':' + started };
    }
    if (process.platform === 'darwin') {
      const [{ stdout: host }, { stdout: start }] = await Promise.all([
        execute('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 10000, maxBuffer: 65536 }),
        execute('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 10000, maxBuffer: 4096, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }),
      ]);
      const uuid = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(host)?.[1];
      if (!uuid || !start.trim()) throw unavailable();
      return { hostId: digest('darwin:' + uuid), startId: start.trim() };
    }
    throw unavailable();
  } catch {
    if (missing(pid)) return null;
    throw unavailable();
  }
}

// Own identity is stable for this process lifetime. Normal saves need no new
// subprocess; another process is observed only when a lock is contested.
export function instructionProcessIdentity(pid) {
  if (pid !== process.pid) return observe(pid);
  if (!currentIdentity) currentIdentity = observe(pid).catch(error => { currentIdentity = null; throw error; });
  return currentIdentity;
}
