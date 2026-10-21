import { promises as fs } from 'node:fs';

const RENAME_RETRY_DELAYS = [25, 50, 100, 200, 400, 800];
const WINDOWS_RENAME_BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Called through main's write chain so each complete snapshot publishes in order. */
export async function writeDesktopRuntimeRecord(file, contents, { io = fs, platform = process.platform, wait = delay } = {}) {
  const temporary = file + '.tmp';
  await io.writeFile(temporary, contents);
  for (let attempt = 0; ; attempt++) {
    try { await io.rename(temporary, file); return; }
    catch (error) {
      // A Windows reader or scanner may briefly deny rename/delete sharing.
      // Keep the previous snapshot intact; never unlink it to force replacement.
      if (platform !== 'win32' || !WINDOWS_RENAME_BUSY.has(error.code) || attempt >= RENAME_RETRY_DELAYS.length) throw error;
      await wait(RENAME_RETRY_DELAYS[attempt]);
    }
  }
}
