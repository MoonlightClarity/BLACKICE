const retired = () => Object.assign(new Error('This browser page instance has closed or been replaced. Inspect the current tab before continuing.'), { code: 'BROWSER_CLOSED' });
const protocolChanged = () => Object.assign(new Error('The browser protocol connection changed before the action completed. Inspect the current page before continuing.'), { code: 'BROWSER_CONTAINMENT_LOST' });

/**
 * One native renderer lifetime behind a persistent logical tab. Native events,
 * protocol readiness and asynchronous results belong to this instance, never
 * to whichever window happens to occupy the tab when they eventually finish.
 */
export class BrowserPageLifetime {
  constructor({ tab, window, isClosed = () => false }) {
    this.tab = tab; this.window = window; this.contents = window.webContents; this.isClosed = isClosed;
    this.generation = (tab.nativeGeneration || 0) + 1; tab.nativeGeneration = this.generation;
    this.listeners = new Set(); this.waiters = new Set(); this.protocolEpoch = 0; this.protocolReady = null; this.protocolInterrupt = null; this.retirement = null;
    tab.instance = this;
  }
  owns() { return !this.retirement && this.tab.instance === this && this.tab.window === this.window; }
  current() { return this.owns() && !this.isClosed() && !this.window.isDestroyed() && !this.contents.isDestroyed?.(); }
  assertCurrent() { if (!this.current()) throw this.retirement || retired(); return this; }
  on(emitter, event, callback) {
    const listener = (...args) => { if (this.owns()) callback(...args); };
    const entry = { emitter, event, listener }; this.listeners.add(entry); emitter.on(event, listener);
    return () => { emitter.removeListener(event, listener); this.listeners.delete(entry); };
  }
  invalidateProtocol() {
    this.protocolEpoch++; this.protocolReady = null;
    this.protocolInterrupt?.(protocolChanged()); this.protocolInterrupt = null;
    if (this.owns()) this.tab.containmentReady = null;
  }
  prepareProtocol(prepare) {
    this.assertCurrent();
    if (this.protocolReady) return this.protocolReady;
    const epoch = this.protocolEpoch;
    const assertProtocol = () => {
      this.assertCurrent();
      if (this.protocolEpoch !== epoch) throw protocolChanged();
    };
    let interrupt;
    const invalidated = new Promise((_, reject) => { interrupt = reject; });
    const work = Promise.resolve().then(async () => {
      assertProtocol(); await prepare(assertProtocol); assertProtocol();
    });
    const ready = this.observe(Promise.race([work, invalidated])).catch(cause => {
      // A retired preparation must not erase a newer debugger's readiness.
      if (this.protocolReady === ready) {
        this.protocolReady = null;
        if (this.owns() && this.tab.containmentReady === ready) this.tab.containmentReady = null;
      }
      throw cause;
    }).finally(() => {
      if (this.protocolInterrupt === interrupt) this.protocolInterrupt = null;
    });
    this.protocolReady = ready; this.protocolInterrupt = interrupt; this.tab.containmentReady = ready; ready.catch(() => {});
    return ready;
  }
  observe(promise) {
    const work = Promise.resolve(promise); work.catch(() => {});
    try { this.assertCurrent(); } catch (cause) { return Promise.reject(cause); }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => { if (settled) return; settled = true; this.waiters.delete(interrupt); callback(value); };
      const interrupt = cause => finish(reject, cause);
      this.waiters.add(interrupt);
      work.then(value => {
        try { this.assertCurrent(); finish(resolve, value); } catch (cause) { finish(reject, cause); }
      }, cause => finish(reject, this.current() ? cause : this.retirement || retired()));
    });
  }
  retire(cause = retired()) {
    if (this.retirement) return;
    this.retirement = cause;
    for (const { emitter, event, listener } of this.listeners) emitter.removeListener(event, listener);
    this.listeners.clear();
    for (const interrupt of [...this.waiters]) interrupt(cause);
    this.waiters.clear(); this.protocolReady = null; this.protocolEpoch++;
    this.protocolInterrupt?.(cause); this.protocolInterrupt = null;
    if (this.tab.instance === this) this.tab.containmentReady = null;
  }
}
