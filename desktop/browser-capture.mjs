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

// Electron's capturePage copies the currently submitted compositor surface.
// A nonempty bitmap need not include changes that the renderer has already
// acknowledged. Cross two animation-frame boundaries in a host-owned isolated
// world before copying it. This does not freeze the page or prove it cannot
// change again; the caller still owns document/viewport identity checks.
// World 1001 is separate from the site's main world and Electron's preload.
const nativeFrameWorld=1001;
export function nativeFrameBoundary(contents) {
  if(typeof contents.executeJavaScriptInIsolatedWorld!=='function')return null;
  return contents.executeJavaScriptInIsolatedWorld(nativeFrameWorld,[{
    code:'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))'
  }]);
}

// Long-lived parked native views can stop requesting normal compositor frames
// even while backgroundThrottling is false and the document reports visible.
// A presentation subscription supplies capture demand only for this operation.
// Discard subscriber pixels: freshness still comes from the isolated frame
// boundary and the final capturePage copy. Overlapping readers share ownership
// so one reader's cancellation cannot stop another reader's frame supply.
const nativeCaptureDemand = new WeakMap();
function acquireCaptureDemand(contents) {
  if (contents.isOffscreen?.() || typeof contents.beginFrameSubscription !== 'function'
      || typeof contents.endFrameSubscription !== 'function') return () => {};
  let state = nativeCaptureDemand.get(contents);
  if (!state) {
    contents.beginFrameSubscription(() => {});
    state = { readers: 0 };
    nativeCaptureDemand.set(contents, state);
  }
  state.readers++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--state.readers !== 0) return;
    nativeCaptureDemand.delete(contents);
    if (!contents.isDestroyed()) contents.endFrameSubscription();
  };
}

/** Retry only the read-only frame copy. Consequential browser input is never retried here. */
export async function captureHiddenPage(contents, { signal, assertCurrent = () => {}, timeoutMs = 4000, retryDelays = [50, 100] } = {}) {
  const deadline = Date.now() + Math.max(1, Math.min(12000, timeoutMs)), delays = retryDelays.slice(0, 2); let lastError;
  const current = () => { if (signal?.aborted) throw cancelled(); if (contents.isDestroyed()) throw failure('The browser page closed before capture completed.', 'BROWSER_CLOSED'); assertCurrent(); };
  current();
  const releaseDemand = acquireCaptureDemand(contents);
  try {
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      current(); if (Date.now() >= deadline) throw failure('The browser did not produce a frame before the capture deadline.', 'BROWSER_CAPTURE_TIMEOUT');
      let image;
      try {
        // A hidden or parked WebContentsView can acknowledge a DOM mutation
        // before Chromium submits its new compositor surface. capturePage then
        // returns a nonempty but stale bitmap (observed one paint behind, 24/24).
        // The same isolated double-rAF boundary required for offscreen views is
        // also required for native parked views; never treat old pixels as fresh.
        // A throttled renderer must report a bounded render-stage failure rather
        // than silently returning the previous surface.
        const frameDeadline = Math.min(deadline, Date.now() + 1500);
        const frame=nativeFrameBoundary(contents);
        if(frame){
          let ready;
          try { ready=await bounded(frame,signal,frameDeadline-Date.now()); }
          catch(cause){ if(cause?.code==='BROWSER_CAPTURE_TIMEOUT')cause.captureStage='render-boundary'; throw cause; }
          current();
          if(ready!==true)throw failure('The native renderer did not confirm a fresh frame boundary.','BROWSER_CAPTURE_RENDER_UNAVAILABLE');
          if(Date.now()>=deadline)throw failure('The browser did not produce a frame before the capture deadline.','BROWSER_CAPTURE_TIMEOUT');
        }
        try { image = await bounded(contents.capturePage(undefined, { stayHidden: true }), signal, deadline - Date.now()); }
        catch(cause){ if(cause?.code==='BROWSER_CAPTURE_TIMEOUT')cause.captureStage='bitmap-copy'; throw cause; }
        current(); const size = image?.getSize?.(); if (!image || image.isEmpty?.() || !size?.width || !size?.height) throw new Error('Empty browser capture');
        return { image, retries: attempt };
      } catch (error) { current(); if (!transient(error)) throw error; lastError = error; }
      if (attempt < delays.length) { const wait = Math.max(0, Math.min(250, delays[attempt])); if (Date.now() + wait >= deadline) throw failure('The browser did not produce a frame before the capture deadline.', 'BROWSER_CAPTURE_TIMEOUT', lastError); await bounded(new Promise(resolve => setTimeout(resolve, wait)), signal, deadline - Date.now()); }
    }
    throw failure('The browser renderer could not produce a frame after three capture attempts. Inspect or reload before acting again.', 'BROWSER_CAPTURE_UNAVAILABLE', lastError);
  } finally {
    releaseDemand();
  }
}
