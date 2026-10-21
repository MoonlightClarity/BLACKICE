import { Worker } from 'node:worker_threads';

export const PDF_LIMITS = Object.freeze({ inputBytes: 10 * 1024 * 1024, outputBytes: 8 * 1024 * 1024, pages: 2000, readPages: 20, readChars: 20000, searchPages: 20, searchMatches: 40, queryChars: 256, pageChars: 2000000, renderLongSide: 1600, renderPixels: 4000000, timeoutMs: 20000, concurrent: 2, queued: 4 });
const fail = (message, code = 'PDF_INVALID_ARGUMENT', status = 400) => Object.assign(new Error(message), { code, status });
const cancelled = () => Object.assign(fail('PDF processing was cancelled.', 'PDF_ABORTED', 499), { name: 'AbortError' });
function integer(value, fallback, min, max, label) { const chosen = value ?? fallback; if (!Number.isSafeInteger(chosen) || chosen < min || chosen > max) throw fail(`${label} must be an integer from ${min} to ${max}.`); return chosen; }
// A data URL is a module input, so inherited --input-type is valid. Leave execArgv absent:
// Node's default inheritance preserves runtime/security settings without explicitly replaying
// process-only flags inserted by its test runner, which Worker constructors can reject.
const WORKER_BOOTSTRAP = new URL(`data:text/javascript,${encodeURIComponent(`await import(${JSON.stringify(new URL('./pdf-worker.mjs', import.meta.url).href)});`)}`);
function validateBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw fail('Supply PDF bytes as a Uint8Array or Buffer.');
  if (!bytes.byteLength) throw fail('This PDF is empty.', 'PDF_INVALID');
  if (bytes.byteLength > PDF_LIMITS.inputBytes) throw fail('PDF processing supports files up to 10 MiB.', 'PDF_LIMIT_EXCEEDED', 413);
  if (!Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from('%PDF-'))) throw fail('This file has no PDF header. It may be damaged or use another format.', 'PDF_INVALID');
}
function optionsFor(operation, value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('PDF options must be an object.');
  const { signal } = value;
  if (signal != null && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw fail('PDF cancellation requires an AbortSignal.');
  if (signal?.aborted) throw cancelled();
  if (operation === 'inspect') return { signal, options: {} };
  if (operation === 'render') return { signal, options: { page: integer(value.page, 1, 1, PDF_LIMITS.pages, 'Page') } };
  const options = {
    startPage: integer(value.startPage, 1, 1, PDF_LIMITS.pages, 'Start page'),
    pageCount: integer(value.pageCount, operation === 'read' ? 3 : 20, 1, operation === 'read' ? PDF_LIMITS.readPages : PDF_LIMITS.searchPages, 'Page count'),
    startChar: integer(value.startChar, 0, 0, PDF_LIMITS.pageChars, 'Start character'),
  };
  if (operation === 'read') options.charCount = integer(value.charCount, PDF_LIMITS.readChars, 1, PDF_LIMITS.readChars, 'Character count');
  else {
    if (typeof value.query !== 'string' || !value.query.length || value.query.length > PDF_LIMITS.queryChars) throw fail('PDF search needs literal text of 1–256 characters.');
    if (value.caseSensitive !== undefined && typeof value.caseSensitive !== 'boolean') throw fail('Case-sensitive search must be true or false.');
    Object.assign(options, { query: value.query, caseSensitive: value.caseSensitive ?? false, limit: integer(value.limit, 20, 1, PDF_LIMITS.searchMatches, 'Match limit') });
  }
  return { signal, options };
}

/** A small, bounded queue. PDF parsing and compression never run on the caller's thread. */
export class PDFDocumentEngine {
  constructor({ timeoutMs = PDF_LIMITS.timeoutMs, concurrent = PDF_LIMITS.concurrent, queued = PDF_LIMITS.queued, workerFactory = (url, options) => new Worker(url, options) } = {}) {
    this.timeoutMs = integer(timeoutMs, PDF_LIMITS.timeoutMs, 1, PDF_LIMITS.timeoutMs, 'PDF deadline');
    this.concurrency = integer(concurrent, PDF_LIMITS.concurrent, 1, PDF_LIMITS.concurrent, 'PDF concurrency');
    this.queueLimit = integer(queued, PDF_LIMITS.queued, 0, PDF_LIMITS.queued, 'PDF queue size');
    if (typeof workerFactory !== 'function') throw fail('A PDF worker factory must be a function.');
    this.workerFactory = workerFactory; this.queue = []; this.active = new Set(); this.closed = false;
  }
  status() { return { active: this.active.size, queued: this.queue.length, closed: this.closed }; }
  inspect(bytes, options) { return this.run('inspect', bytes, options); }
  read(bytes, options) { return this.run('read', bytes, options); }
  search(bytes, options) { return this.run('search', bytes, options); }
  render(bytes, options) { return this.run('render', bytes, options); }
  async run(operation, input, value) {
    const { signal, options } = optionsFor(operation, value); validateBytes(input);
    if (this.closed) throw fail('PDF processing is closed.', 'PDF_CLOSED', 503);
    if (this.active.size >= this.concurrency && this.queue.length >= this.queueLimit) throw fail('PDF processing is busy. Wait for an active document operation to finish, then retry.', 'PDF_BUSY', 429);
    // Own an exact copy: transferring it must never detach the saved attachment or caller's buffer.
    const bytes = Uint8Array.from(input);
    return new Promise((resolve, reject) => {
      const job = { operation, options, bytes, signal, resolve, reject, settled: false, worker: null, outcome: null };
      job.abort = () => this.finish(job, cancelled(), undefined, true);
      job.timer = setTimeout(() => this.finish(job, fail(`PDF processing exceeded its ${this.timeoutMs / 1000}-second limit. Try a smaller or simpler document.`, 'PDF_TIMEOUT', 408), undefined, true), this.timeoutMs);
      signal?.addEventListener('abort', job.abort, { once: true });
      this.queue.push(job); this.pump();
      if (signal?.aborted) job.abort();
    });
  }
  finish(job, error, result, terminate = false) {
    if (job.settled) return;
    job.settled = true; clearTimeout(job.timer); job.signal?.removeEventListener('abort', job.abort);
    const queuedIndex = this.queue.indexOf(job); if (queuedIndex !== -1) this.queue.splice(queuedIndex, 1);
    if (terminate && job.worker) {
      // Keep its concurrency slot until the actual exit event. Cancellation never claims cleanup early.
      job.worker.unref(); job.termination = job.worker.terminate().catch(() => {});
    }
    job.bytes = null;
    if (error) job.reject(error); else job.resolve(result);
    this.pump();
  }
  pump() {
    while (!this.closed && this.active.size < this.concurrency && this.queue.length) {
      const job = this.queue.shift(); if (job.settled) continue;
      this.active.add(job);
      try {
        job.worker = this.workerFactory(WORKER_BOOTSTRAP, {
          workerData: { operation: job.operation, options: job.options, bytes: job.bytes }, transferList: [job.bytes.buffer],
          // Node limits the JavaScript heap here; WebAssembly memory is separate. The deadline,
          // input/page/text/pixel/output limits and small worker count also bound each operation.
          resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }, stdout: true, stderr: true,
        });
        job.bytes = null;
        job.worker.stdout?.resume(); job.worker.stderr?.resume();
        job.worker.on('message', message => { if (!job.settled && !job.outcome) job.outcome = message; });
        job.worker.once('error', error => {
          const memory = error.code === 'ERR_WORKER_OUT_OF_MEMORY';
          this.finish(job, fail(memory ? 'This PDF exceeded its processing memory limit. Try a smaller or simpler document.' : 'The isolated PDF worker could not process this document.', memory ? 'PDF_LIMIT_EXCEEDED' : 'PDF_PROCESSING_FAILED', memory ? 413 : 422), undefined, true);
        });
        job.worker.once('exit', code => {
          this.active.delete(job);
          if (!job.settled) {
            if (code === 0 && job.outcome?.ok === true) {
              const result = job.outcome.result;
              if (job.operation === 'render' && result?.bytes instanceof Uint8Array) result.bytes = Buffer.from(result.bytes);
              this.finish(job, null, result);
            } else if (job.outcome?.ok === false) {
              const error = job.outcome.error || {};
              this.finish(job, fail(error.message || 'This PDF could not be processed.', error.code || 'PDF_PROCESSING_FAILED', error.status || 422));
            } else this.finish(job, fail('The PDF worker stopped without a complete result.', 'PDF_PROCESSING_FAILED', 422));
          }
          this.pump();
        });
      } catch {
        this.active.delete(job); this.finish(job, fail('The isolated PDF worker could not start.', 'PDF_PROCESSING_FAILED', 503));
      }
    }
  }
  async close() {
    this.closed = true;
    for (const job of [...this.queue, ...this.active]) this.finish(job, cancelled(), undefined, true);
    await Promise.allSettled([...this.active].map(job => job.termination));
  }
}

const engine = new PDFDocumentEngine();
export const inspectPdf = (bytes, options) => engine.inspect(bytes, options);
export const readPdfPages = (bytes, options) => engine.read(bytes, options);
export const searchPdfPages = (bytes, options) => engine.search(bytes, options);
export const renderPdfPage = (bytes, options) => engine.render(bytes, options);
