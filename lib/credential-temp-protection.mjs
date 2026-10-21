import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const problem = () => Object.assign(new Error('A private temporary import directory could not be established.'), { code: 'CREDENTIAL_EXPORT_PROTECTION', status: 503 });

/** Protect a newly owned export directory before writing any plaintext CSV.
 * This helper never sees a credential, and invokes fixed Windows tools without
 * a shell. Inherited profile ACLs are removed, then this OS user alone is added. */
export function credentialTemporaryProtection({ dataDir, platform = process.platform, env = process.env, execute = run, io = fs } = {}) {
  return async directory => {
    if (platform !== 'win32' || typeof directory !== 'string') throw problem();
    const base = path.win32.resolve(dataDir), target = path.win32.resolve(directory), relative = path.win32.relative(base, target);
    if (!relative || relative === '..' || relative.startsWith('..\\') || path.win32.isAbsolute(relative)) throw problem();
    try {
      let cursor = base;
      for (const part of ['', ...relative.split('\\')]) {
        if (part) cursor = path.win32.join(cursor, part);
        const info = await io.lstat(cursor);
        if (!info.isDirectory() || info.isSymbolicLink() || path.win32.resolve(await io.realpath(cursor)).toLowerCase() !== cursor.toLowerCase()) throw problem();
      }
      const windows = env.SystemRoot || 'C:\\Windows';
      if (!/^[A-Za-z]:[\\/]/.test(windows) || /[\0\r\n]/.test(windows)) throw problem();
      const options = { windowsHide: true, shell: false, timeout: 5000, maxBuffer: 16384, encoding: 'utf8' };
      const identity = await execute(path.win32.join(windows, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], options);
      const matches = String(identity.stdout || '').match(/\bS-1-(?:\d+-){1,14}\d+\b/g);
      if (!matches || matches.length !== 1) throw problem();
      // icacls otherwise rejects a valid owned directory beyond MAX_PATH even
      // though Node can create and inspect it. Preserve its exact normalized
      // identity using the Windows extended-length path form.
      await execute(path.win32.join(windows, 'System32', 'icacls.exe'), [path.win32.toNamespacedPath(target), '/inheritance:r', '/grant:r', `*${matches[0]}:(OI)(CI)F`], options);
      return { protected: true, method: 'windows-user-acl' };
    } catch { throw problem(); }
  };
}
