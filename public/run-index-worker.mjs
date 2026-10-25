import { projectRunCollection } from './run-index-model.mjs';

const source = typeof self !== 'undefined' ? self : null;
if (source) {
  let pending = null;
  source.onmessage = async event => {
    if (event.data?.type !== 'fetch' || !Number.isSafeInteger(event.data.id)) return;
    const id = event.data.id;
    try {
      // The transport, 70+MB JSON parse and event-array discard all occur
      // outside the interactive renderer's main thread.
      const response = await fetch('/api/runs', {
        method: 'GET', credentials: 'same-origin', cache: 'no-store',
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error('Run list request failed (' + response.status + ').');
      const data = await response.json();
      const runs = projectRunCollection(data);
      source.postMessage({ id, ok: true, runs });
    } catch (cause) {
      source.postMessage({ id, ok: false, error: String(cause?.message || 'Could not load run list.') });
    } finally {
      pending = null;
    }
  };
}
