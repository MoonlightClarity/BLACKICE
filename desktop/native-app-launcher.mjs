import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const SCRIPT = fileURLToPath(new URL('./native-app-launcher.ps1', import.meta.url));
const abortError = () => Object.assign(new Error('Application launch cancelled before starting.'), { name: 'AbortError', code: 'ABORT_ERR' });

export function launchNativeExecutable(input, { signal, spawnImpl = spawn, timeoutMs = 30000 } = {}) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    // Only the transport helper is hidden. Its native STARTUPINFO requests a
    // visible, non-activating application on the ordinary Windows desktop.
    const child = spawnImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    // Once delivered, launching is an uncertain side effect: cancellation or a
    // missing reply must not kill an accepted app or automatically launch twice.
    const timer = setTimeout(() => finish(new Error('Application launch response timed out. Check running windows before retrying; the application may have started.')), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', value => { stdout += value; if (stdout.length > 65536) finish(new Error('Application launch response was too large; check running windows before retrying.')); });
    child.stderr?.on('data', value => { stderr = (stderr + String(value)).slice(-1500); });
    child.once('error', error => finish(error)); child.stdin.on('error', error => finish(new Error('Application launch receipt was lost. Check running windows before retrying. ' + error.message)));
    child.once('close', code => {
      if (code !== 0) return finish(new Error(stderr || 'Windows application launch failed.'));
      try {
        const result = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''));
        if (result.launched !== true || !Number.isSafeInteger(result.pid) || result.pid < 1) throw new Error();
        finish(null, result);
      } catch { finish(new Error('Application launch receipt was invalid. Check running windows before retrying.')); }
    });
    if (signal?.aborted) { child.stdin.end(); try { child.kill(); } catch {} return finish(abortError()); }
    child.stdin.end(JSON.stringify(input));
  });
}
