import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export const acpError = (message, code = 'ACCOUNT_ACP_ERROR') => Object.assign(new Error(message), { code });

export function safeAcpError(value) {
  return String(value?.message || value || 'Account client failed.')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|complete[_-]?token|authorization|bearer)\s*[=: ]\s*)[^\s&"']+/gi, '$1[redacted]')
    .replace(/([?&](?:token|code|secret|key|complete_token|poll_token)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 1800);
}

const abortError = signal => signal?.reason instanceof Error ? signal.reason
  : acpError('Account client was cancelled.', 'ABORTED');

/** Official ACP JSON-RPC, newline-delimited over one owned stdio process.
 * No filesystem, terminal, or external-browser client capability is advertised.
 */
export class AccountAcpConnection extends EventEmitter {
  constructor({ command, cwd, env, spawnImpl = spawn, onRequest, requestTimeoutMs = 45_000, closeGraceMs = 2000, closeKillTimeoutMs = 10_000 }) {
    super();
    this.command = command;
    this.cwd = cwd;
    this.onRequest = onRequest;
    this.requestTimeoutMs = requestTimeoutMs;
    if (!Number.isSafeInteger(closeGraceMs) || closeGraceMs < 0 || closeGraceMs > 60_000 ||
        !Number.isSafeInteger(closeKillTimeoutMs) || closeKillTimeoutMs <= 0 || closeKillTimeoutMs > 60_000)
      throw acpError('Choose bounded ACP shutdown timeouts.', 'ACCOUNT_ACP_CONFIG');
    this.closeGraceMs = closeGraceMs;
    this.closeKillTimeoutMs = closeKillTimeoutMs;
    this.spawned = false;
    this.startFailed = false;
    this.exitInfo = null;
    // A stop request is not proof of process exit. The runtime retains its
    // native-session lease until this promise confirms the owned child stopped.
    this.terminated = new Promise(resolve => { this.resolveTerminated = resolve; });
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
      this.child.once('spawn', () => { this.spawned = true; resolve(); });
      this.child.once('error', reject);
    });
    // A process can fail before its first request; retain the error without an
    // unhandled rejection or EventEmitter's special unhandled "error" event.
    this.started.catch(() => {});
    this.child.on('error', cause => {
      if (!this.spawned) {
        this.startFailed = true; this.closed = true;
        this.resolveTerminated({ exitCode: null, signal: null, notStarted: true });
      }
      this.fail(acpError(safeAcpError(cause), 'ACCOUNT_ACP_START_FAILED'));
    });
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      this.exitInfo = { exitCode: code ?? null, signal: signal ?? null };
      this.resolveTerminated(this.exitInfo);
      const cause = this.closing ? acpError('Account client connection closed.', 'ACCOUNT_ACP_CLOSED')
        : acpError('Account client exited before the operation was confirmed' + (code == null ? '.' : ' (exit ' + code + ').'), 'ACCOUNT_ACP_EXITED');
      this.fail(cause);
      this.emit('exit', { code, signal });
    });
    this.child.stdin.on('error', cause => this.fail(acpError(safeAcpError(cause), 'ACCOUNT_ACP_PIPE')));
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + String(chunk)).slice(-4000); });
    this.child.stdout.on('data', chunk => this.receive(this.decoder.write(chunk)));
  }

  receive(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 24 * 1024 * 1024) {
      this.fail(acpError('Account client exceeded the ACP message limit.', 'ACCOUNT_ACP_PROTOCOL'));
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
        this.fail(acpError('Account client sent invalid ACP JSON.', 'ACCOUNT_ACP_PROTOCOL'));
        this.close().catch(() => {});
        return;
      }
      if (!message || message.jsonrpc !== '2.0') {
        this.fail(acpError('Account client sent an invalid ACP envelope.', 'ACCOUNT_ACP_PROTOCOL'));
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
        const cause = acpError(safeAcpError(message.error.message), 'ACCOUNT_ACP_RPC');
        cause.rpcCode = message.error.code;
        request.reject(cause);
      } else if (Object.hasOwn(message, 'result')) request.resolve(message.result);
      else request.reject(acpError('Account client omitted its ACP result.', 'ACCOUNT_ACP_PROTOCOL'));
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
        message: safeAcpError(cause),
      } });
    }
  }

  write(message) {
    if (this.closed || this.closing || this.failure) throw this.failure || acpError('Account client is disconnected.', 'ACCOUNT_ACP_CLOSED');
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
        reject(acpError('Account client did not answer ' + method + ' in time.', 'ACCOUNT_ACP_TIMEOUT'));
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
      this.fail(acpError('Account client connection closed.', 'ACCOUNT_ACP_CLOSED'));
      let forced = false;
      const waitForTermination = async ms => {
        let timer;
        try {
          return await Promise.race([
            this.terminated.then(() => true),
            new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); }),
          ]);
        } finally { clearTimeout(timer); }
      };
      if (!this.closed) {
        try { this.child.stdin.end(); } catch { /* Still confirm exit or request termination below. */ }
        await waitForTermination(this.closeGraceMs);
        if (!this.closed) {
          forced = true;
          try { this.child.kill(); } catch { /* A failed signal cannot establish process exit. */ }
          if (!await waitForTermination(this.closeKillTimeoutMs))
            throw acpError('Account client did not confirm that its owned process exited. The native session remains unconfirmed.', 'ACCOUNT_ACP_CLOSE_UNCONFIRMED');
        }
      }
      return { closed: true,
        graceful: this.spawned && !this.startFailed && !forced && this.exitInfo?.exitCode === 0 && !this.exitInfo?.signal,
        forced, exitCode: this.exitInfo?.exitCode ?? null, signal: this.exitInfo?.signal ?? null,
        ...(this.startFailed ? { notStarted: true } : {}) };
    })();
    return this.closePromise;
  }
}
