import { normalizeRunTimeout, startRunDeadline } from './run-timeout.mjs';

const cancelled = () => Object.assign(new Error('Agent run cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
const cancelBody = response => { try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch {} };

/** Owns one API exchange. Received bytes refresh its idle budget; elapsed run time does not. */
export function createProviderTransport({ signal, idleTimeoutMs = 300_000, providerName = 'The provider', deadlineOptions } = {}) {
  normalizeRunTimeout(idleTimeoutMs);
  const controller = new AbortController(); let disposed = false, stopDeadline = () => {};
  const abort = reason => { if (!controller.signal.aborted) controller.abort(reason || cancelled()); };
  const onAbort = () => abort(signal.reason);
  const activity = () => {
    stopDeadline();
    if (disposed || controller.signal.aborted) return;
    stopDeadline = startRunDeadline(idleTimeoutMs, () => abort(Object.assign(new Error(`${providerName}: The API stopped sending data. Review the last activity before continuing, or change the API inactivity timeout in Settings.`), { code: 'PROVIDER_IDLE_TIMEOUT', failureScope: 'connection' })), deadlineOptions);
  };
  const race = async promise => {
    if (controller.signal.aborted) { Promise.resolve(promise).catch(() => {}); throw controller.signal.reason || cancelled(); }
    let listener;
    const aborted = new Promise((resolve, reject) => { listener = () => reject(controller.signal.reason || cancelled()); controller.signal.addEventListener('abort', listener, { once: true }); });
    try { return await Promise.race([promise, aborted]); }
    finally { controller.signal.removeEventListener('abort', listener); }
  };
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  activity();
  return {
    signal: controller.signal,
    activity,
    race,
    async fetch(fetchImpl, url, options) {
      if (controller.signal.aborted) throw controller.signal.reason || cancelled();
      // An adapter may ignore AbortSignal. Release a late response rather than retaining its body.
      const pending = Promise.resolve().then(() => {
        // Stop may arrive between scheduling and dispatch, before an adapter sees the signal.
        if (controller.signal.aborted) throw controller.signal.reason || cancelled();
        return fetchImpl(url, { ...options, signal: controller.signal });
      }).then(response => {
        if (controller.signal.aborted) { cancelBody(response); throw controller.signal.reason || cancelled(); }
        activity(); return response;
      });
      return race(pending);
    },
    async read(reader) {
      const result = await race(reader.read());
      if (result.value?.byteLength > 0) activity();
      return result;
    },
    dispose() { if (disposed) return; disposed = true; stopDeadline(); signal?.removeEventListener('abort', onAbort); },
  };
}

/** Decode incrementally so JSON and error bodies have the same heartbeat and Stop behavior as SSE. */
export async function readProviderText(response, transport, { maxChars = Infinity } = {}) {
  if (!response.body?.getReader) return (await transport.race(response.text())).slice(0, maxChars);
  const reader = response.body.getReader(), decoder = new TextDecoder(); let text = '', ended = false;
  try {
    while (true) {
      const { value, done } = await transport.read(reader);
      if (done) { ended = true; break; }
      text += decoder.decode(value, { stream: true });
      if (text.length >= maxChars) return text.slice(0, maxChars);
    }
    text += decoder.decode(); return text.slice(0, maxChars);
  } finally {
    if (!ended) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} }
    try { reader.releaseLock(); } catch {}
  }
}
