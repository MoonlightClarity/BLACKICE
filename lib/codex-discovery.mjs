import path from 'node:path';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';

// Current-user package registration is fast even when the AppX deployment
// service is unresponsive. Only trust the exact Codex publisher/family,
// native architecture and a registered, existing binary.
function registeredDesktopCodexCommand({env, exists, execFile, arch}) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  const reg = path.win32.join(systemRoot, 'System32', 'reg.exe');
  const packages = 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages';
  const options = {encoding: 'utf8', timeout: 2000, maxBuffer: 65536, windowsHide: true, env};
  try {
    const output = execFile(reg, ['query', packages, '/f', 'OpenAI.Codex_', '/k'], options);
    const matches = [];
    for (const line of String(output).split(/\r?\n/)) {
      const key = line.trim();
      const match = /^HKEY_CURRENT_USER\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages\\OpenAI\.Codex_(\d+)\.(\d+)\.(\d+)\.(\d+)_(x64|arm64)__2p2nqsd0c76g0$/i.exec(key);
      if (match && match[5].toLowerCase() === arch) matches.push({key, version: match.slice(1, 5).map(Number)});
    }
    matches.sort((a,b) => {
      for(let i=0;i<4;i++) if(a.version[i]!==b.version[i]) return b.version[i]-a.version[i];
      return 0;
    });
    for (const {key} of matches) {
      try {
        const values = execFile(reg, ['query', key, '/v', 'PackageRootFolder'], options);
        const root = /^\s*PackageRootFolder\s+REG_SZ\s+(.+?)\s*$/im.exec(String(values))?.[1];
        if (!root || !path.win32.isAbsolute(root) ||
            path.win32.basename(root).toLowerCase() !== key.split('\\').at(-1).toLowerCase()) continue;
        const command = path.win32.join(root,'app','resources','codex.exe');
        if (exists(command)) return command;
      } catch { /* A stale registration cannot block the next candidate. */ }
    }
  } catch { /* Fall through to the supported AppX query. */ }
  return null;
}

function desktopCodexCommand({env, exists, execFile, arch}) {
  const registered = registeredDesktopCodexCommand({env, exists, execFile, arch});
  if (registered) return registered;
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    // Query the currently registered package, rather than pinning a Store version
    // or selecting an arbitrary executable from the WindowsApps directory.
    const locations = execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
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
  return desktopCodexCommand({env, exists, execFile, arch}) || 'codex';
}

/** Compare a running absolute CLI with fresh supported discovery before new work. */
export function assessCodexRuntime({current, discovered, exists = existsSync, platform = process.platform} = {}) {
  const absolute = value => typeof value === 'string' && (platform === 'win32' ? path.win32.isAbsolute(value) : path.isAbsolute(value));
  const normalize = value => platform === 'win32' ? path.win32.normalize(value).toLowerCase() : path.normalize(value);
  if (absolute(discovered) && (!absolute(current) || normalize(current) !== normalize(discovered)) && exists(discovered))
    return {state:'moved', command:discovered};
  if (!absolute(current) || exists(current)) return {state:'current'};
  return {state:'missing'};
}
