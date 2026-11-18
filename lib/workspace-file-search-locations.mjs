import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

// Priority seeds improve time-to-first-result; drive roots provide general coverage.
// Never enumerate file contents, elevate privileges, or change OS settings here.
export async function fileSearchLocations(cwd, signal, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const home = dependencies.home ?? homedir();
  const execute = dependencies.run ?? run;
  const io = dependencies.fs ?? fs;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const errors = [], common = [];
  let drives = [];
  if (platform === 'win32') {
    const script = "$ErrorActionPreference='Stop';$common=@([Environment]::GetFolderPath('MyDocuments'),[Environment]::GetFolderPath('Desktop'));try{$p=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';$common+= [Environment]::ExpandEnvironmentVariables($p.'{374DE290-123F-4565-9164-39C4925E467B}')}catch{};@{common=@($common | Where-Object {$_});drives=@([Environment]::GetLogicalDrives())}|ConvertTo-Json -Compress";
    try {
      const { stdout } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 3000, maxBuffer: 16384, signal });
      const found = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
      if (!Array.isArray(found.drives) || !found.drives.length || !Array.isArray(found.common) || [...found.drives, ...found.common].some(x => typeof x !== 'string' || !paths.isAbsolute(x))) throw new Error('Invalid filesystem-root response');
      common.push(...found.common); drives = found.drives;
    } catch (cause) {
      if (signal?.aborted) throw cause;
      errors.push({ path: paths.parse(cwd).root, code: 'FILESYSTEM_ROOT_DISCOVERY_FAILED' });
      drives = [paths.parse(cwd).root];
    }
  } else {
    drives = ['/']; // Includes mounted filesystems reachable under the POSIX root.
    if (platform === 'linux') {
      try {
        const text = await io.readFile(paths.join(dependencies.configHome ?? process.env.XDG_CONFIG_HOME ?? paths.join(home, '.config'), 'user-dirs.dirs'), 'utf8');
        for (const name of ['DOCUMENTS', 'DESKTOP', 'DOWNLOAD']) {
          const match = text.match(new RegExp('^XDG_' + name + '_DIR="([^"\\n]*)"', 'm'));
          if (match) { const value = match[1].replace(/^\$HOME(?=\/|$)/, home); if (paths.isAbsolute(value)) common.push(value); }
        }
      } catch (cause) { if (cause.code !== 'ENOENT') errors.push({ path: home, code: 'COMMON_FOLDERS_UNAVAILABLE' }); }
    }
    common.push(...['Documents', 'Desktop', 'Downloads'].map(x => paths.join(home, x)));
  }
  const roots = [];
  for (const candidate of [...common, home, cwd, ...drives]) {
    if (signal?.aborted) throw Object.assign(new Error('File search cancelled.'), { name: 'AbortError' });
    if (!candidate) continue;
    const resolved = paths.resolve(candidate);
    const key = value => platform === 'win32' ? value.toLowerCase() : value;
    if (roots.some(value => key(value) === key(resolved))) continue;
    // Missing optional priority folders are not failed coverage; enclosing roots still cover them.
    if (common.includes(candidate)) {
      try { if (!(await io.stat(resolved)).isDirectory()) continue; }
      catch (cause) { if (cause.code !== 'ENOENT') errors.push({ path: resolved, code: cause.code || 'IO_ERROR' }); continue; }
    }
    roots.push(resolved);
  }
  return { roots, errors };
}
