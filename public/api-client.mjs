/** A request deadline also covers a stalled response body. Never replay mutations. */
export function createApiClient({ fetcher = globalThis.fetch, timeoutMs = 30000 } = {}) {
  return async function api(path, method = 'GET', body) {
    const options = method && typeof method === 'object' && !Array.isArray(method) ? method : {};
    if (options === method) { method = options.method ?? 'GET'; body = options.body === undefined ? body : options.body; }
    const deadlineMs = options.timeoutMs === undefined ? timeoutMs : options.timeoutMs;
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || options.timeoutMs !== undefined && deadlineMs > 60000) throw new Error('Choose a request deadline of up to 60 seconds.');
    if (typeof method !== 'string' || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method.toUpperCase())) throw new Error('Choose a supported request method.');
    method = method.toUpperCase();
    const mutation = !['GET', 'HEAD'].includes(method), controller = new AbortController();
    const headers = new Headers(options.headers); if (mutation) headers.set('Content-Type', 'application/json');
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    let timedOut = false, timer;
    const request = (async () => {
      const response = await fetcher(path, { method, credentials: 'same-origin', signal,
        headers, body: mutation ? JSON.stringify(body ?? {}) : undefined });
      let data;
      try { data = await response.json(); }
      catch { throw new Error(response.ok ? 'BLACKICE returned an unreadable response.' : `Request failed (${response.status}).`); }
      if (!response.ok) {
        const code = data?.error?.code || data?.code;
        throw Object.assign(new Error(data?.error?.message || data?.error || data?.message || `Request failed (${response.status}).`), { status: response.status, ...(typeof code === 'string' ? { code } : {}), ...(data?.error?.timedOut === true || data?.timedOut === true ? { timedOut: true } : {}) });
      }
      if (data === null || typeof data !== 'object') throw new Error('BLACKICE returned an unreadable response.');
      return data;
    })();
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('BLACKICE took too long to respond.')); }, deadlineMs); });
    try { return await Promise.race([request, deadline]); }
    catch (cause) {
      const uncertain = mutation && (!cause?.status || cause.status >= 500);
      const message = timedOut ? 'Connection timed out: BLACKICE took too long to respond.' : cause?.message || 'Could not reach BLACKICE.';
      throw Object.assign(new Error(uncertain ? `${message} Your request may have completed. Check the conversation before sending again.` : message), { cause, uncertain, status: cause?.status, ...(timedOut ? { code: 'API_TIMEOUT', timedOut: true } : { ...(typeof cause?.code === 'string' ? { code: cause.code } : {}), ...(cause?.timedOut === true ? { timedOut: true } : {}) }) });
    } finally { clearTimeout(timer); }
  };
}
