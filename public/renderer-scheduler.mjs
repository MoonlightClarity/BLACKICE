/** Coalesce high-volume stream paints. The canonical event state is still
 * reduced on receipt, but DOM updates use the latest state at a bounded rate.
 * Explicit click/typing handlers continue updating synchronously.
 */
export function createRenderThrottle({
  intervalMs = 100, now = () => performance.now(),
  schedule = (fn, ms) => setTimeout(fn, ms), unschedule = clearTimeout,
} = {}) {
  let pending = null, timer = null, last = -Infinity;
  function flush() {
    if (timer !== null) { unschedule(timer); timer = null; }
    const callback = pending; pending = null;
    if (typeof callback !== 'function') return;
    last = now();
    callback();
  }
  function request(callback) {
    if (typeof callback !== 'function') return;
    pending = callback;
    if (timer !== null) return;
    const elapsed = now() - last;
    if (elapsed >= intervalMs) { flush(); return; }
    timer = schedule(flush, Math.max(1, Math.ceil(intervalMs - elapsed)));
  }
  function cancel() {
    if (timer !== null) { unschedule(timer); timer = null; }
    pending = null;
  }
  return { request, flush, cancel };
}
