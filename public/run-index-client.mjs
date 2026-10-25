import { projectRunCollection } from './run-index-model.mjs';

/** A single in-flight run-index fetch; the 77MB JSON body never passes through
 * the Electron renderer main thread. Falls back to the existing API if browser
 * workers are unavailable, without changing the backend or stored history.
 */
export function createRunIndexClient({ api, WorkerClass = globalThis.Worker, timeoutMs = 65000 } = {}) {
  if (typeof api !== 'function') throw Error('Run index requires the existing BLACKICE API.');
  let worker = null, pending = null, serial = 0, disabled = false, closed = false;
  const fallback = async () => projectRunCollection(await api('/api/runs', { timeoutMs: 60000 }));
  const disable = error => {
    disabled = true;
    const p = pending; pending = null;
    try { worker?.terminate(); } catch {}
    worker = null;
    p?.reject(error || Error('Run indexing worker is unavailable.'));
  };
  if (typeof WorkerClass === 'function') {
    try {
      worker = new WorkerClass('/run-index-worker.mjs', { type: 'module', name: 'BLACKICE run index' });
      worker.addEventListener('message', event => {
        const message = event.data, p = pending;
        if (!p || p.id !== message?.id) return;
        pending = null; clearTimeout(p.timer);
        if (message.ok && Array.isArray(message.runs)) p.resolve(message.runs);
        else p.reject(Error(message.error || 'Could not read the run index.'));
      });
      worker.addEventListener('error', () => disable(Error('Run indexing worker stopped.')));
      worker.addEventListener('messageerror', () => disable(Error('Run indexing worker returned unreadable data.')));
    } catch { disabled = true; worker = null; }
  } else disabled = true;
  let inFlight = null;
  const read = () => {
    if (closed) return Promise.reject(Error('Run index is closed.'));
    if (inFlight) return inFlight;
    const work = !worker || disabled ? fallback() : new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        if (pending?.id === id) disable(Error('Run index did not respond.'));
      }, timeoutMs);
      pending = { id, resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }, timer };
      try { worker.postMessage({ type: 'fetch', id }); } catch (error) { disable(error); }
    }).catch(async () => {
      // If the worker could not start, restore the baseline behavior, but never
      // retry writes and never repeat a failed index fetch silently.
      if (!disabled) throw Error('BLACKICE could not refresh the chat list.');
      return fallback();
    });
    inFlight = work;
    void work.then(() => { if (inFlight === work) inFlight = null; },
      () => { if (inFlight === work) inFlight = null; });
    return work;
  };
  return { read, get usingWorker() { return !!worker && !disabled; },
    close() { closed = true; disable(Error('Run index closed.')); } };
}
