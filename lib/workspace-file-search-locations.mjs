import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

// Resolve OS folder configuration, not profile-memory hints. Never change settings.
export async function fileSearchLocations(cwd, signal) {
  const home = homedir(), roots = [cwd], errors = [];
  let candidates = [];
  if (process.platform === 'win32') {
    const script = "$ErrorActionPreference='Stop';$p='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';$k=Get-ItemProperty -LiteralPath $p;$v=@([Environment]::GetFolderPath('MyDocuments'),[Environment]::GetFolderPath('Desktop'),$k.'{374DE290-123F-4565-9164-39C4925E467B}');ConvertTo-Json -Compress -InputObject @($v | Where-Object {$_} | ForEach-Object {[Environment]::ExpandEnvironmentVariables($_)})";
    try {
      const { stdout } = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 3000, maxBuffer: 16384, signal });
      const found = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
      if (!Array.isArray(found) || found.some(x => typeof x !== 'string' || !path.isAbsolute(x))) throw new Error('Invalid OS folder response');
      candidates = found;
    } catch (cause) {
      if (signal?.aborted) throw cause;
      errors.push({ path: home, code: 'COMMON_FOLDERS_UNAVAILABLE' });
    }
  } else if (process.platform === 'darwin') {
    candidates = ['Documents', 'Desktop', 'Downloads'].map(x => path.join(home, x));
  } else {
    try {
      const text = await fs.readFile(path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'user-dirs.dirs'), 'utf8');
      for (const name of ['DOCUMENTS', 'DESKTOP', 'DOWNLOAD']) {
        const match = text.match(new RegExp('^XDG_' + name + '_DIR="([^"\\n]*)"', 'm'));
        if (match) {
          const value = match[1].replace(/^\$HOME(?=\/|$)/, home);
          if (path.isAbsolute(value) && value !== home) candidates.push(value);
        }
      }
    } catch (cause) {
      if (cause.code !== 'ENOENT') errors.push({ path: home, code: 'COMMON_FOLDERS_UNAVAILABLE' });
      candidates = ['Documents', 'Desktop', 'Downloads'].map(x => path.join(home, x));
    }
  }
  for (const candidate of candidates) {
    if (signal?.aborted) throw Object.assign(new Error('File search cancelled.'), { name: 'AbortError' });
    try { if ((await fs.stat(candidate)).isDirectory()) roots.push(candidate); }
    catch (cause) { if (cause.code !== 'ENOENT') errors.push({ path: candidate, code: cause.code || 'IO_ERROR' }); }
  }
  return { roots, errors };
}
