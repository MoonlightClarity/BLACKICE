import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A path suggestion only: never starts a client, reads its config, or selects an account. */
export async function discoverHimalayaExecutable({ platform = process.platform, userDirectory = os.homedir(), searchPath = process.env.PATH || '', stat = fs.stat } = {}) {
  const filename = platform === 'win32' ? 'himalaya.exe' : 'himalaya';
  const candidates = [path.join(userDirectory, '.local', 'bin', filename), ...searchPath.split(path.delimiter).slice(0, 100).filter(Boolean).map(directory => path.join(directory, filename))];
  for (const candidate of new Set(candidates)) {
    if (!path.isAbsolute(candidate)) continue;
    try { if ((await stat(candidate)).isFile()) return candidate; } catch {}
  }
  return '';
}
