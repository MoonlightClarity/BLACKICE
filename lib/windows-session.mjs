import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./windows-desktop.ps1', import.meta.url));
const failure = (message, name = 'Error') => Object.assign(new Error(message), { name });

/** One warm native helper per connected desktop. Requests are serialized by DesktopController. */
export function createWindowsSession({ spawnImpl = spawn } = {}) {
  let child, pending, buffer = '';
  const stop = error => {
    const old = child; child = null; buffer = '';
    const request = pending; pending = null;
    request?.finish(error || failure('Desktop disconnected.', 'AbortError'));
    old?.stdin.end(); old?.kill();
  };
  const start = () => {
    if (child && !child.killed) return;
    const instance = spawnImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Mta', '-ExecutionPolicy', 'Bypass', '-File', script, '-Stream'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    child = instance;
    const lost = message => { if (child === instance) stop(failure(message)); };
    instance.stdout.setEncoding('utf8');
    instance.stdout.on('data', chunk => {
      if (child !== instance) return;
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) return lost('Desktop response exceeded its size limit.');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim().replace(/^\uFEFF/, ''); buffer = buffer.slice(end + 1);
        if (!line) continue;
        const request = pending;
        if (!request) continue;
        pending = null;
        try {
          const { ok, error, ...result } = JSON.parse(line);
          request.finish(ok === true ? null : failure(error || 'Windows desktop operation failed.'), result);
        } catch { request.finish(failure('Windows desktop returned an invalid response.')); }
      }
    });
    instance.stderr.on('data', () => {});
    instance.stdin.on('error', error => lost(`Desktop helper input failed: ${error.message}`));
    instance.on('error', error => lost(`Desktop helper could not start: ${error.message}`));
    instance.on('close', code => lost(`Desktop helper stopped (${code ?? 'terminated'}).`));
  };
  const request = (value, { signal, timeoutMs = 20_000 } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(failure('Desktop operation cancelled.', 'AbortError'));
    if (pending) return reject(failure('A desktop operation is already in progress.'));
    let timer, settled = false;
    const abort = () => stop(failure('Desktop operation cancelled.', 'AbortError'));
    const finish = (error, result) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    };
    try {
      start(); pending = { finish };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      timer = setTimeout(() => stop(failure('Windows desktop operation timed out.')), timeoutMs);
      child.stdin.write(`${JSON.stringify(value)}\n`);
    } catch (error) { if (pending?.finish === finish) pending = null; finish(error); }
  });
  request.close = () => stop();
  return request;
}
