import { Worker } from 'node:worker_threads';
import path from 'node:path';

const invalid = (message, code = 'NATIVE_WORKER_ERROR') =>
  Object.assign(new Error(message), { code });

const failure = detail => invalid(
  String(detail?.message || 'Native inference worker failed.').slice(0, 1200),
  detail?.code || 'NATIVE_WORKER_ERROR',
);

/** Runs BLACKICE-authored Qwen3 inference off the Electron/Node main event loop. */
export class Qwen3WorkerHost {
  constructor({ modelDirectory, maxContext = 2048, WorkerImpl = Worker, loadTimeoutMs = 120000 } = {}) {
    if (typeof modelDirectory !== 'string' || !path.isAbsolute(modelDirectory))
      throw invalid('Choose an absolute Qwen3 model directory.');
    if (!Number.isSafeInteger(maxContext) || maxContext < 1 || maxContext > 131072)
      throw invalid('Choose a positive model context window.');
    this.modelDirectory = path.resolve(modelDirectory);
    this.maxContext = maxContext;
    this.WorkerImpl = WorkerImpl;
    this.loadTimeoutMs = loadTimeoutMs;
    this.worker = null;
    this.loading = null;
    this.ready = false;
    this.closed = false;
    this.active = null;
    this.sequence = 0;
    this.metadata = null;
    this.cancelFlag = new Int32Array(new SharedArrayBuffer(4));
  }

  async load() {
    if (this.closed) throw invalid('The native inference worker was already closed.', 'NATIVE_WORKER_CLOSED');
    if (this.ready) return this.metadata;
    if (this.loading) return this.loading;
    this.loading = new Promise((resolve, reject) => {
      const worker = new this.WorkerImpl(new URL('./qwen3-worker.mjs', import.meta.url), {
        type: 'module', workerData: {
          modelDirectory: this.modelDirectory,
          maxContext: this.maxContext,
          cancelBuffer: this.cancelFlag.buffer,
        },
      });
      this.worker = worker;
      const timeout = setTimeout(() => {
        const error = invalid('Loading the native model exceeded its time limit.', 'NATIVE_LOAD_TIMEOUT');
        this.fail(error);
        void worker.terminate();
      }, this.loadTimeoutMs);
      this.loadResolve = metadata => { clearTimeout(timeout); this.loadResolve = null; this.loadReject = null; resolve(metadata); };
      this.loadReject = error => { clearTimeout(timeout); this.loadResolve = null; this.loadReject = null; reject(error); };
      worker.on('message', message => this.message(message));
      worker.on('error', error => this.fail(error));
      worker.on('exit', code => {
        if (!this.closed) this.fail(invalid('Native inference worker exited (' + code + ').', 'NATIVE_WORKER_EXITED'));
      });
    });
    return this.loading;
  }

  fail(error) {
    this.ready = false;
    this.closed = true;
    this.loadReject?.(error);
    if (this.active) {
      const pending = this.active;
      this.active = null;
      pending.reject(error);
    }
  }

  message(message) {
    if (message?.type === 'ready') {
      if (!this.loadResolve || this.closed) return;
      this.ready = true;
      this.metadata = message;
      this.loadResolve(message);
      return;
    }
    if (message?.type === 'load-error') {
      this.fail(failure(message.error));
      void this.worker?.terminate();
      return;
    }
    const pending = this.active;
    if (!pending || pending.id !== message?.requestId) return;
    if (message.type === 'token') {
      if (typeof message.text === 'string') pending.text += message.text;
      if (Number.isInteger(message.tokenId)) pending.tokens.push(message.tokenId);
      // Deliver stream callbacks sequentially and settle only after delivery.
      pending.delivery = pending.delivery.then(async () => {
        if (typeof pending.onToken === 'function' && Number.isInteger(message.tokenId))
          await pending.onToken(message.tokenId);
        if (typeof pending.onText === 'function' && typeof message.text === 'string' && message.text)
          await pending.onText(message.text);
      }).catch(error => {
        this.cancel();
        this.rejectActive(pending, error);
      });
      return;
    }
    if (message.type === 'error') {
      this.rejectActive(pending, failure(message.error));
      return;
    }
    if (message.type === 'done') {
      void pending.delivery.then(() => {
        if (this.active !== pending) return;
        this.active = null;
        pending.resolve({
          backend: 'blackice', completed: true, promptTokens: message.promptTokens,
          tokenIds: message.tokenIds, text: pending.text,
        });
      }).catch(error => this.rejectActive(pending, error));
    }
  }

  rejectActive(pending, error) {
    if (this.active !== pending) return;
    this.active = null;
    pending.reject(error);
  }

  async generate({ messages, prompt, tokenIds, maxNewTokens = 16, enableThinking = false, signal, onToken, onText } = {}) {
    await this.load();
    signal?.throwIfAborted();
    if (this.closed || !this.worker || !this.ready) throw invalid('Native inference worker is not ready.', 'NATIVE_WORKER_CLOSED');
    if (this.active) throw invalid('Native inference worker is busy.', 'NATIVE_WORKER_BUSY');
    const modes = Number(messages !== undefined) + Number(prompt !== undefined) + Number(tokenIds !== undefined);
    if (modes !== 1) throw invalid('Choose exactly one: chat messages, a text prompt, or pretokenized IDs.');
    if (messages !== undefined && (!Array.isArray(messages) || messages.length < 1 || messages.length > 100 ||
        !messages.every(item => ['system', 'user', 'assistant'].includes(item?.role) && typeof item.content === 'string' && item.content.length <= 1_000_000)))
      throw invalid('Provide up to 100 system/user/assistant text messages.');
    if (prompt !== undefined && (typeof prompt !== 'string' || !prompt.length || prompt.length > 1_000_000))
      throw invalid('Text prompt must contain from 1 to 1,000,000 characters.');
    if (tokenIds !== undefined && (!Array.isArray(tokenIds) || tokenIds.length < 1 || tokenIds.length > 131072 ||
        !tokenIds.every(Number.isSafeInteger)))
      throw invalid('Pretokenized IDs must be a nonempty integer array.');
    if (!Number.isSafeInteger(maxNewTokens) || maxNewTokens < 0 || maxNewTokens > 2048)
      throw invalid('Generation budget must be 0 to 2048 tokens.');
    if (typeof enableThinking !== 'boolean') throw invalid('Enable thinking must be true or false.');
    Atomics.store(this.cancelFlag, 0, 0);
    const id = ++this.sequence;
    const request = new Promise((resolve, reject) => {
      this.active = {
        id, resolve, reject, text: '', tokens: [], delivery: Promise.resolve(), onToken, onText,
      };
      this.worker.postMessage({
        type: 'generate', requestId: id, messages, prompt, tokenIds, maxNewTokens, enableThinking,
      });
    });
    if (!signal) return request;
    const abort = () => this.cancel();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try { return await request; }
    finally { signal.removeEventListener('abort', abort); }
  }

  /** Interrupts long synchronous matvec operations without waiting for a worker message. */
  cancel() {
    if (!this.active) return false;
    Atomics.store(this.cancelFlag, 0, 1);
    return true;
  }

  status() {
    return {
      backend: 'blackice', runningInWorker: Boolean(this.worker && this.ready && !this.closed),
      busy: Boolean(this.active), modelDirectory: this.modelDirectory,
      maxContext: this.metadata?.maxContext || this.maxContext,
      sourcePrecision: this.metadata?.sourcePrecision || null,
    };
  }

  async unload() {
    if (this.closed && !this.worker) return;
    this.cancel();
    this.closed = true;
    if (this.active) {
      const pending = this.active;
      this.active = null;
      pending.reject(invalid('Native inference worker was unloaded.', 'ABORT_ERR'));
    }
    this.loadReject?.(invalid('Native inference worker was unloaded during startup.', 'ABORT_ERR'));
    const worker = this.worker;
    this.worker = null;
    this.ready = false;
    if (worker) await worker.terminate();
  }
}
