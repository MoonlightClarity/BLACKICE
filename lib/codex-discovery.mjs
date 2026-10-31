import path from 'node:path';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';

function desktopCodexCommand({env, exists, execFile}) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    // Query the currently registered package, rather than pinning a Store version
    // or selecting an arbitrary executable from the WindowsApps directory.
    const locations = execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "Get-AppxPackage -Name OpenAI.Codex -ErrorAction Stop | Sort-Object Version -Descending | Select-Object -ExpandProperty InstallLocation"],
    {encoding: 'utf8', timeout: 4000, maxBuffer: 16384, windowsHide: true, env});
    for (const location of String(locations).split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
      if (!path.win32.isAbsolute(location)) continue;
      const command = path.win32.join(location, 'app', 'resources', 'codex.exe');
      if (exists(command)) return command;
    }
  } catch { /* A missing desktop package leaves ordinary PATH discovery intact. */ }
  return null;
}

/**
 * Resolve a native Codex CLI without changing global PATH or user credentials.
 * Agent Desk's optional per-user CLI installation is kept outside app resources
 * so in-place patches, uninstallers, or profile backups do not overwrite it.
 */
export function resolveCodexCommand({
  command,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  exists = existsSync,
  home = homedir(),
  execFile = execFileSync,
} = {}) {
  if (typeof command === 'string' && command.trim()) return command;
  if (typeof env.CODEX_BINARY === 'string' && env.CODEX_BINARY.trim()) return env.CODEX_BINARY;
  if (platform !== 'win32') return 'codex';
  const native = arch === 'arm64'
    ? ['codex-win32-arm64', 'aarch64-pc-windows-msvc']
    : arch === 'x64'
      ? ['codex-win32-x64', 'x86_64-pc-windows-msvc']
      : null;
  if (!native) return 'codex';
  const localAppData = env.LOCALAPPDATA || path.win32.join(env.USERPROFILE || home, 'AppData', 'Local');
  const installed = path.win32.join(localAppData, 'AgentDesk', 'codex-cli', 'node_modules', '@openai', native[0], 'vendor', native[1], 'bin', 'codex.exe');
  if (exists(installed)) return installed;
  // A CLI intentionally installed on PATH retains precedence over the desktop
  // fallback. Normal Explorer launches often omit the desktop app's private PATH.
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  for (const entry of pathValue.split(';').map(value => value.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    if (exists(path.win32.join(entry, 'codex.exe'))) return 'codex';
  }
  return desktopCodexCommand({env, exists, execFile}) || 'codex';
}
