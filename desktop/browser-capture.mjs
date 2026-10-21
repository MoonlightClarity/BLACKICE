const failure = (message, code, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });
const cancelled = () => Object.assign(failure('Browser capture cancelled.', 'ABORT_ERR'), { name: 'AbortError' });
const transient = error => /^(?:UnknownVizError|VizSentEmptyBitmap|Current display surface not available for capture|Empty browser capture)$/.test(String(error?.message || ''));
function bounded(promise, signal, milliseconds) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); callback(value); };
    const abort = () => finish(reject, cancelled());
    const timer = setTimeout(() => finish(reject, failure('The browser did not produce a frame before the capture deadline.', 'BROWSER_CAPTURE_TIMEOUT')), Math.max(1, milliseconds));
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

/** Retry only the read-only frame copy. Consequential browser input is never retried here. */
export async function captureHiddenPage(contents, { signal, assertCurrent = () => {}, timeoutMs = 4000, retryDelays = [50, 100] } = {}) {
  const deadline = Date.now() + Math.max(1, Math.min(12000, timeoutMs)), delays = retryDelays.slice(0, 2); let lastError;
  const current = () => { if (signal?.aborted) throw cancelled(); if (contents.isDestroyed()) throw failure('The browser page closed before capture completed.', 'BROWSER_CLOSED'); assertCurrent(); };
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    current(); if (Date.now() >= deadline) throw failure('The browser did not produce a frame before the capture deadline.', 'BROWSER_CAPTURE_TIMEOUT');
    let image;
    try {
      image = await bounded(contents.capturePage(undefined, { stayHidden: true }), signal, deadline - Date.now());
      current(); const size = image?.getSize?.(); if (!image || image.isEmpty?.() || !size?.width || !size?.height) throw new Error('Empty browser capture');
      return { image, retries: attempt };
    } catch (error) { current(); if (!transient(error)) throw error; lastError = error; }
    if (attempt < delays.length) { const wait = Math.max(0, Math.min(250, delays[attempt])); if (Date.now() + wait >= deadline) throw failure('The browser did not produce a frame before the capture deadline.', 'BROWSER_CAPTURE_TIMEOUT', lastError); await bounded(new Promise(resolve => setTimeout(resolve, wait)), signal, deadline - Date.now()); }
  }
  throw failure('The browser renderer could not produce a frame after three capture attempts. Inspect or reload before acting again.', 'BROWSER_CAPTURE_UNAVAILABLE', lastError);
}
