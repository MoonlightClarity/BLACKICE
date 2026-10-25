/** One transport, scoped event subscriptions. Hidden workspaces do not render. */
export function createEventBus({ EventSourceClass = globalThis.EventSource, onConnection = () => {} } = {}) {
  let stream = null, closed = false;
  const handlers = new Set();
  function start() {
    if (closed || stream || !EventSourceClass) return;
    const source = new EventSourceClass('/api/events');
    stream = source;
    source.addEventListener('open', () => { if (stream === source) onConnection('connected'); });
    source.addEventListener('error', () => { if (stream === source) onConnection('reconnecting'); });
    source.addEventListener('message', event => {
      if (stream !== source) return;
      let receipt;
      try { receipt = JSON.parse(event.data); } catch { return; }
      if (!receipt || typeof receipt.type !== 'string') return;
      for (const listener of handlers) {
        try { listener(receipt); } catch (error) { console.warn('BLACKICE workspace event:', error); }
      }
    });
  }
  return {
    start,
    subscribe(handler) {
      if (typeof handler !== 'function') return () => {};
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() { closed = true; handlers.clear(); stream?.close(); stream = null; },
    get listenerCount() { return handlers.size; },
  };
}