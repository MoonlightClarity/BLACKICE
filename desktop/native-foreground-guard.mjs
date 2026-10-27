import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const script = fileURLToPath(new URL('./native-foreground-guard.ps1', import.meta.url));
export class NativeForegroundGuard {
  constructor({ spawnImpl = spawn, timeoutMs = 10000 } = {}) {
    this.spawnImpl = spawnImpl; this.timeoutMs = timeoutMs; this.worker = null; this.pending = null;
    this.sequence = 0; this.buffer = ''; this.tail = Promise.resolve(); this.active = false; this.directory = null; this.failure = null; this.closed = false;
  }
  setDirectory(directory) { this.directory = path.resolve(directory); }
  ensureWorker() {
    if (this.closed) throw Error('Foreground observer is closed.');
    if (this.worker) return;
    const child = this.spawnImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.worker = child; this.buffer = ''; let detail = '';
    const fail = error => {
      if (this.worker !== child) return;
      this.worker = null; this.active = false; this.failure = String(error.message || error); this.pending?.finish(error);
      // The observer owns no application HWNDs. An abandoned protocol cannot
      // retain a hook or compete with a replacement observer.
      try { child.stdin.end(); } catch {} try { child.kill(); } catch {}
    };
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
      if (this.worker !== child) return; this.buffer += chunk;
      if (this.buffer.length > 2 * 1024 * 1024) return fail(Error('Foreground observation response was too large.'));
      let end; while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end).trim().replace(/^\uFEFF/, ''); this.buffer = this.buffer.slice(end + 1); if (!line || !this.pending) continue;
        let value; try { value = JSON.parse(line); } catch { return fail(Error('Invalid foreground observation response.')); }
        if (value.requestId < this.pending.id) continue;
        if (value.requestId !== this.pending.id) return fail(Error('Unrelated foreground observation response.'));
        this.pending.finish(value.ok === true ? null : Error(value.error || 'Foreground observation failed.'), value.result);
      }
    });
    child.stderr?.on('data', chunk => { detail = (detail + String(chunk)).slice(-1500); });
    child.stdin.on('error', fail); child.once('error', fail); child.once('close', code => fail(Error('Foreground observer closed (' + code + '). ' + detail)));
  }
  dispatch(action, args = {}) {
    if (this.closed) return Promise.reject(Error('Foreground observer is closed.'));
    const operation = this.tail.catch(() => {}).then(() => new Promise((resolve, reject) => {
      try { this.ensureWorker(); } catch (error) { reject(error); return; }
      const id = ++this.sequence; let timer;
      const finish = (error, result) => { if (this.pending?.id !== id) return; clearTimeout(timer); this.pending = null; if (error) reject(error); else resolve(result); };
      this.pending = { id, finish }; timer = setTimeout(() => {
        const error = Error('Foreground observation timed out.'); finish(error);
        const child = this.worker; this.worker = null; this.active = false; this.failure = error.message;
        // This observer owns no application/parent HWNDs. Stopping an uncertain
        // observer cannot destroy an app or leave an unacknowledged hook alive.
        try { child?.kill(); } catch {}
      }, this.timeoutMs);
      try { this.worker.stdin.write(JSON.stringify({ action, requestId: id, ...args }) + '\n'); } catch (error) { finish(error); }
    })); this.tail = operation; return operation;
  }
  async begin(hostWindowId) {
    if (this.closed) throw Error('Foreground observer is closed.');
    let logPath; if (this.directory) { await mkdir(this.directory, { recursive: true }); logPath = path.join(this.directory, randomUUID() + '.jsonl'); }
    if (this.closed) throw Error('Foreground observer is closed.');
    const value = await this.dispatch('begin', { hostWindowId, ...(logPath ? { logPath } : {}) });
    if (this.closed) throw Error('Foreground observer is closed.');
    if (value?.active !== true || value.continuous !== true) throw Error('Windows foreground tracking did not acknowledge startup.');
    this.active = true; this.failure = null; return value;
  }
  async bind({ pid, processStartedAt, windowId, retain = false } = {}) { return this.dispatch('bind', { ...(pid ? { pid } : {}), ...(processStartedAt ? { processStartedAt } : {}), ...(windowId ? { windowId } : {}), retain }); }
  allowFocus() { return this.active ? this.dispatch('allow-focus') : Promise.resolve(null); }
  status() { return this.active ? this.dispatch('status') : Promise.resolve(this.failure ? { active: false, continuous: false, zeroFlashGuaranteed: false, error: this.failure } : null); }
  async release() { if (!this.active) return null; const value = await this.dispatch('release'); this.active = false; return value; }
  async close() { this.closed = true; await this.tail.catch(() => {}); const child = this.worker; this.worker = null; this.active = false; if (!child) return; await new Promise(resolve => { const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 2500); child.once('close', () => { clearTimeout(timer); resolve(); }); try { child.stdin.end(); } catch { try { child.kill(); } catch {} clearTimeout(timer); resolve(); } }); }
}
