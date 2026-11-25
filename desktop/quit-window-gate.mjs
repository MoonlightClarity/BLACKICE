/** Let the renderer veto closing before any service is torn down.
 * A veto or unanswered close is cancellation, never permission to discard a draft.
 * Keep ownership of a retired native close until its late outcome or the next
 * explicit close request, so a timed-out attempt cannot implicitly quit.
 */
const quitError = (code, message) => Object.assign(new Error(message), { code });
export function createQuitWindowGate({ getWindow, timeoutMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout, onLateClose = () => {} }) {
  let pending = null;
  const attempts = new WeakMap(), acceptedClosures = new WeakSet();
  const prepare = ({ signal } = {}) => {
    if (pending) return pending;
    const cancelled = () => quitError('DESKTOP_RESTART_CANCELLED', 'The close negotiation was cancelled.');
    if (signal?.aborted) return Promise.reject(cancelled());
    const window = getWindow();
    if (!window || window.isDestroyed()) return Promise.resolve(true);
    attempts.get(window)?.dispose();
    const contents = window.webContents;
    let resolve, reject, timer, state = 'closing';
    const raw = new Promise((yes, no) => { resolve = yes; reject = no; });
    const current = raw.finally(() => { if (pending === current) pending = null; });
    pending = current;
    const cleanupWait = () => { if (timer !== undefined) clearTimer(timer); signal?.removeEventListener('abort', aborted); };
    const dispose = () => {
      cleanupWait(); window.removeListener('closed', closed); window.removeListener('close', laterRequest);
      contents.removeListener('will-prevent-unload', blocked);
      if (attempts.get(window)?.dispose === dispose) attempts.delete(window);
    };
    const closed = () => {
      acceptedClosures.add(window);
      const late = state === 'retired';
      dispose();
      if (late) queueMicrotask(() => onLateClose(window)); else resolve(true);
    };
    const blocked = () => { const waiting = state === 'closing'; dispose(); if (waiting) resolve(false); };
    const laterRequest = () => { if (state === 'retired') dispose(); };
    const retire = error => {
      if (state !== 'closing') return;
      state = 'retired'; cleanupWait(); reject(error);
      // A late native close cannot authorize a cancelled shutdown.
    };
    const aborted = () => retire(cancelled());
    attempts.set(window, { dispose });
    window.on('close', laterRequest); window.once('closed', closed); contents.once('will-prevent-unload', blocked);
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimer(() => retire(quitError('DESKTOP_RESTART_QUIT_TIMEOUT', 'BLACKICE did not receive a window-close decision. It remains open; save any edits and retry.')), timeoutMs);
    try { window.close(); } catch (error) { dispose(); reject(error); }
    return current;
  };
  prepare.ownsClose = window => Boolean(window && (attempts.has(window) || acceptedClosures.has(window)));
  return prepare;
}
