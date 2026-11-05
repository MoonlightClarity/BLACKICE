import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export const VIBE_PROVIDER_ID = 'mistral-vibe';
export const VIBE_THREAD_PREFIX = 'vibe_';
export const vibeError = (message, code = 'MISTRAL_VIBE_ERROR') => Object.assign(new Error(message), { code });

export function safeVibeError(value) {
  return String(value?.message || value || 'Mistral Vibe failed.')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|complete[_-]?token|authorization|bearer)\s*[=: ]\s*)[^\s&"']+/gi, '$1[redacted]')
    .replace(/([?&](?:token|code|secret|key|complete_token|poll_token)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 1800);
}

const abortError = signal => signal?.reason instanceof Error ? signal.reason
  : vibeError('Mistral Vibe was cancelled.', 'ABORTED');

/** Official ACP JSON-RPC, newline-delimited over one owned stdio process.
 * No filesystem, terminal, or external-browser client capability is advertised.
 */
export class VibeAcpConnection extends EventEmitter {
  constructor({ command, cwd, env, spawnImpl = spawn, onRequest, requestTimeoutMs = 45_000 }) {
    super();
    this.command = command;
    this.cwd = cwd;
    this.onRequest = onRequest;
    this.requestTimeoutMs = requestTimeoutMs;
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    this.closing = false;
    this.failure = null;
    this.stderr = '';
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.child = spawnImpl(command, [], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.started = new Promise((resolve, reject) => {
      this.child.once('spawn', resolve);
      this.child.once('error', reject);
    });
    // A process can fail before its first request; retain the error without an
    // unhandled rejection or EventEmitter's special unhandled "error" event.
    this.started.catch(() => {});
    this.child.on('error', cause => this.fail(vibeError(safeVibeError(cause), 'MISTRAL_VIBE_START_FAILED')));
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      const cause = this.closing ? vibeError('Mistral Vibe connection closed.', 'MISTRAL_VIBE_CLOSED')
        : vibeError('Mistral Vibe exited before the operation was confirmed' + (code == null ? '.' : ' (exit ' + code + ').'), 'MISTRAL_VIBE_EXITED');
      this.fail(cause);
      this.emit('exit', { code, signal });
    });
    this.child.stdin.on('error', cause => this.fail(vibeError(safeVibeError(cause), 'MISTRAL_VIBE_PIPE')));
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + String(chunk)).slice(-4000); });
    this.child.stdout.on('data', chunk => this.receive(this.decoder.write(chunk)));
  }

  receive(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 24 * 1024 * 1024) {
      this.fail(vibeError('Mistral Vibe exceeded the ACP message limit.', 'MISTRAL_VIBE_PROTOCOL'));
      this.close().catch(() => {});
      return;
    }
    let end;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch {
        this.fail(vibeError('Mistral Vibe sent invalid ACP JSON.', 'MISTRAL_VIBE_PROTOCOL'));
        this.close().catch(() => {});
        return;
      }
      if (!message || message.jsonrpc !== '2.0') {
        this.fail(vibeError('Mistral Vibe sent an invalid ACP envelope.', 'MISTRAL_VIBE_PROTOCOL'));
        continue;
      }
      this.emit('activity');
      if (typeof message.method === 'string') {
        if (message.id !== undefined) this.answer(message).catch(() => {});
        else this.emit('notification', message);
        continue;
      }
      const request = this.pending.get(message.id);
      if (!request) continue;
      this.pending.delete(message.id);
      request.cleanup();
      if (message.error) {
        const cause = vibeError(safeVibeError(message.error.message), 'MISTRAL_VIBE_RPC');
        cause.rpcCode = message.error.code;
        request.reject(cause);
      } else if (Object.hasOwn(message, 'result')) request.resolve(message.result);
      else request.reject(vibeError('Mistral Vibe omitted its ACP result.', 'MISTRAL_VIBE_PROTOCOL'));
    }
  }

  async answer(message) {
    try {
      if (!this.onRequest) throw Object.assign(new Error('BLACKICE does not provide this client capability.'), { rpcCode: -32601 });
      const result = await this.onRequest(message.method, message.params || {});
      this.write({ jsonrpc: '2.0', id: message.id, result: result ?? {} });
    } catch (cause) {
      if (!this.closed) this.write({ jsonrpc: '2.0', id: message.id, error: {
        code: Number.isInteger(cause.rpcCode) ? cause.rpcCode : -32603,
        message: safeVibeError(cause),
      } });
    }
  }

  write(message) {
    if (this.closed || this.closing || this.failure) throw this.failure || vibeError('Mistral Vibe is disconnected.', 'MISTRAL_VIBE_CLOSED');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  async request(method, params = {}, { signal, timeoutMs = this.requestTimeoutMs } = {}) {
    if (signal?.aborted) throw abortError(signal);
    await this.started;
    if (signal?.aborted) throw abortError(signal);
    if (this.failure) throw this.failure;
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      let timer;
      const abort = () => {
        this.pending.delete(id);
        cleanup();
        reject(abortError(signal));
      };
      const cleanup = () => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      if (timeoutMs !== null) timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        reject(vibeError('Mistral Vibe did not answer ' + method + ' in time.', 'MISTRAL_VIBE_TIMEOUT'));
      }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup });
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch (cause) { this.pending.delete(id); cleanup(); reject(cause); }
    });
  }

  notify(method, params = {}) { this.write({ jsonrpc: '2.0', method, params }); }

  initialize(options = {}) {
    return this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'blackice', title: 'BLACKICE', version: '2.39.17' },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        _meta: { 'browser-auth-delegated': true },
      },
    }, { timeoutMs: 90_000, ...options });
  }

  fail(cause) {
    if (!this.failure) this.failure = cause;
    for (const request of this.pending.values()) { request.cleanup(); request.reject(cause); }
    this.pending.clear();
    this.emit('disconnected', cause);
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      this.fail(vibeError('Mistral Vibe connection closed.', 'MISTRAL_VIBE_CLOSED'));
      if (this.closed) return;
      const exited = new Promise(resolve => this.child.once('exit', resolve));
      this.child.stdin.end();
      let timer;
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]);
      clearTimeout(timer);
      if (!this.closed) this.child.kill();
    })();
    return this.closePromise;
  }
}
