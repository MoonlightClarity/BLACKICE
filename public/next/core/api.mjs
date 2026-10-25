/** The existing BLACKICE API remains authoritative. Never retry a mutation. */
export function createApi({ fetcher = globalThis.fetch, defaultDeadlineMs = 30000 } = {}) {
  return async function request(path, method = 'GET', payload, { signal, deadlineMs = defaultDeadlineMs } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/api/')) throw Error('Invalid BLACKICE API path.');
    if (!['GET', 'POST', 'DELETE', 'PATCH', 'PUT'].includes(method)) throw Error('Unsupported request method.');
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), deadlineMs);
    const externalAbort = () => controller.abort();
    signal?.addEventListener('abort', externalAbort, { once: true });
    try {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const response = await fetcher(path, { method, credentials: 'same-origin',
        signal: controller.signal, cache: 'no-store',
        headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(payload ?? {}) });
      let result;
      try { result = await response.json(); } catch { throw Error('BLACKICE returned an unreadable response.'); }
      if (!response.ok) {
        const message = result?.error?.message || result?.error || result?.message || 'Request failed (' + response.status + ').';
        throw Object.assign(Error(String(message)), { status: response.status, code: result?.error?.code || result?.code });
      }
      return result;
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) throw Error('BLACKICE request timed out. Inspect the result before retrying any action.');
      throw error;
    } finally { clearTimeout(deadline); signal?.removeEventListener('abort', externalAbort); }
  };
}