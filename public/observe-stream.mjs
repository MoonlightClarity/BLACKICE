/** A visible Observe session owns its stream, reconnect timer and session refresh. */
export function createObserveSubscription(runId, handlers = {}, {
  createSource = url => new EventSource(url),
  refreshSession = async signal => { const response = await fetch('/', { credentials: 'same-origin', cache: 'no-store', signal }); await response.text(); },
  schedule = setTimeout, unschedule = clearTimeout,
  minDelay = 750, maxDelay = 10000,
} = {}) {
  let closed = false, source = null, timer = null, refreshing = null, failures = 0, generation = 0, connected = false;
  const release = () => { const previous = source; source = null; if (previous) { previous.onmessage = null; previous.onerror = null; previous.close(); } };
  const retry = () => {
    if (closed || timer !== null) return;
    const delay = Math.min(maxDelay, minDelay * 2 ** Math.min(failures++, 8));
    timer = schedule(async () => {
      timer = null; if (closed) return;
      const controller = new AbortController(); refreshing = controller;
      const deadline = schedule(() => controller.abort(), 5000);
      let onAbort;
      const aborted = new Promise(resolve => { onAbort = resolve; controller.signal.addEventListener('abort', onAbort, { once: true }); });
      try { await Promise.race([refreshSession(controller.signal), aborted]); } catch {} finally { controller.signal.removeEventListener('abort', onAbort); unschedule(deadline); if (refreshing === controller) refreshing = null; }
      if (!closed) connect();
    }, delay);
  };
  const failed = () => { release(); handlers.onError?.('Live edits disconnected. Reconnecting…', { reconnecting: true }); retry(); };
  function connect() {
    if (closed) return;
    const currentGeneration = ++generation;
    let current;
    try { current = createSource(`/api/runs/${encodeURIComponent(runId)}/observe`); source = current; }
    catch { failed(); return; }
    const owns = () => !closed && source === current && currentGeneration === generation;
    current.onmessage = event => {
      if (!owns()) return;
      let payload; try { payload = JSON.parse(event.data); } catch { return; }
      if (payload.runId && payload.runId !== runId) return;
      if (payload.type === 'observe.ready') {
        const reconnected = connected; connected = true; failures = 0;
        handlers.onReady?.({ ...payload.data, reconnected });
      } else if (payload.type === 'run.edit') handlers.onEdit?.(payload.data);
      else if (payload.type === 'observe.presentation') handlers.onPresentation?.(payload.data);
      else if (payload.type === 'observe.stopped') { close(); handlers.onStopped?.(payload.data); }
      else if (payload.type === 'observe.error') { release(); handlers.onError?.(payload.data?.error || 'Live file watching is unavailable.', { reconnecting: false }); }
    };
    current.onerror = () => { if (owns()) failed(); };
  }
  function close() {
    if (closed) return;
    closed = true; generation++; if (timer !== null) unschedule(timer); timer = null;
    refreshing?.abort(); refreshing = null; release();
  }
  connect(); return close;
}
