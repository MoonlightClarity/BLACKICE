/** Recover only the shell renderer. The runtime, browser tabs and jobs stay owned by main. */
export class DesktopRendererRecovery {
  constructor({ window, url, isClosing = () => false, showRecovery, onCrash = () => {}, onError = () => {}, onUnavailable = () => {}, stableMs = 60_000, unresponsiveMs = 15_000, loadTimeoutMs = 20_000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.window = window; this.url = url; this.isClosing = isClosing; this.showRecovery = showRecovery;
    this.onCrash = onCrash; this.onError = onError; this.onUnavailable = onUnavailable;
    this.stableMs = stableMs; this.unresponsiveMs = unresponsiveMs; this.loadTimeoutMs = loadTimeoutMs;
    this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.state = 'ready'; this.stopped = false; this.automaticUsed = false; this.revision = 0;
    this.flight = null; this.loadAttempt = null; this.prompt = null; this.hung = false;
    this.listeners = [];
    this.listen(window.webContents, 'render-process-gone', (_event, details) => { void this.rendererGone(details); });
    this.listen(window.webContents, 'did-finish-load', () => this.loaded());
    this.listen(window, 'unresponsive', () => this.unresponsive());
    this.listen(window, 'responsive', () => this.responsive());
    this.listen(window, 'closed', () => this.stop());
  }

  listen(target, name, handler) { target.on(name, handler); this.listeners.push([target, name, handler]); }
  active() { return !this.stopped && !this.isClosing() && !this.window.isDestroyed() && !this.window.webContents.isDestroyed(); }
  observe(callback) { try { Promise.resolve(callback()).catch(() => {}); } catch {} }
  report(error) { this.observe(() => this.onError(error)); }
  cancelTimer(key) { if (this[key] !== undefined) this.clearTimer(this[key]); this[key] = undefined; }
  timer(key, callback, delay) { this.cancelTimer(key); this[key] = this.setTimer(() => { this[key] = undefined; callback(); }, delay); this[key]?.unref?.(); }

  armStable() {
    this.cancelTimer('stableTimer');
    if (!this.active() || this.state !== 'ready' || this.hung) return;
    // Finishing a navigation alone must not reset the retry budget: a renderer
    // that crashes on every load would otherwise restart forever.
    this.timer('stableTimer', () => { if (this.active() && this.state === 'ready' && !this.hung) this.automaticUsed = false; }, this.stableMs);
  }

  loaded() {
    if (!this.active()) return;
    // loadURL can finish after our bounded wait expired. A real main-frame load
    // makes the shell usable again; retire any obsolete recovery prompt and
    // require the same stable interval before restoring automatic retries.
    if (this.state === 'blocked' && !this.loadAttempt) {
      this.state = 'ready';
      if (this.prompt?.kind === 'crash') this.prompt.controller.abort();
    }
    if (this.state === 'ready') this.armStable();
  }

  load() {
    if (!this.active()) return Promise.resolve(false);
    return new Promise(resolve => {
      const attempt = { settled: false, timer: undefined, finish: (loaded, error) => {
        if (attempt.settled) return;
        attempt.settled = true; this.clearTimer(attempt.timer);
        if (this.loadAttempt === attempt) this.loadAttempt = null;
        if (error && this.active()) this.report(error);
        resolve(loaded && this.active());
      } };
      this.loadAttempt?.finish(false); this.loadAttempt = attempt;
      attempt.timer = this.setTimer(() => attempt.finish(false, new Error('The BLACKICE interface did not finish loading.')), this.loadTimeoutMs);
      attempt.timer?.unref?.();
      // Both synchronous load errors and late rejections are contained here.
      Promise.resolve().then(() => this.active() ? this.window.loadURL(this.url) : false).then(value => attempt.finish(value !== false), error => attempt.finish(false, error));
    });
  }

  async loadInitial() {
    const revision = this.revision;
    const loaded = await this.load();
    if (!this.active()) return false;
    if (loaded && revision === this.revision) { this.armStable(); return true; }
    return this.recover();
  }

  rendererGone(details = {}) {
    if (!this.active() || details.reason === 'clean-exit') return Promise.resolve(false);
    this.observe(() => this.onCrash(details));
    this.revision++; this.hung = false;
    this.cancelTimer('stableTimer'); this.cancelTimer('hangTimer');
    if (this.prompt?.kind === 'hang') this.prompt.controller.abort();
    this.loadAttempt?.finish(false);
    // A crash in the small gap after load completion still consumes the same
    // retry budget, even if the preceding recovery promise has not settled.
    if (this.flight && this.state === 'ready') return this.flight.then(() => this.recover());
    return this.recover();
  }

  recover({ manual = false } = {}) {
    if (!this.active() || this.state === 'blocked') return Promise.resolve(false);
    if (this.flight) return this.flight;
    this.cancelTimer('stableTimer'); this.cancelTimer('hangTimer');
    this.state = 'recovering';
    const reload = manual || !this.automaticUsed;
    this.automaticUsed = true;
    this.flight = Promise.resolve().then(async () => {
      if (!this.active()) return false;
      const revision = this.revision;
      if (reload && await this.load() && revision === this.revision) {
        this.state = 'ready'; this.armStable(); return true;
      }
      if (!this.active()) return false;
      if (manual) { this.state = 'blocked'; this.observe(this.onUnavailable); return false; }
      return this.offerRecovery();
    }).catch(error => {
      this.report(error); if (this.active()) this.state = 'blocked'; return false;
    }).finally(() => { this.flight = null; });
    return this.flight;
  }

  retry() {
    if (!this.active() || this.state !== 'blocked') return Promise.resolve(false);
    if (this.flight) return this.flight;
    this.state = 'ready';
    return this.recover({ manual: true });
  }

  async ask(kind, options) {
    const prompt = { kind, controller: new AbortController() };
    this.prompt = prompt;
    let abort;
    const cancelled = new Promise(resolve => { abort = () => resolve(null); prompt.controller.signal.addEventListener('abort', abort, { once: true }); });
    try {
      const answer = Promise.resolve().then(() => prompt.controller.signal.aborted ? null : this.showRecovery?.({ ...options, signal: prompt.controller.signal }));
      return await Promise.race([answer, cancelled]);
    }
    catch (error) { if (!prompt.controller.signal.aborted && this.active()) this.report(error); return null; }
    finally { prompt.controller.signal.removeEventListener('abort', abort); if (this.prompt === prompt) this.prompt = null; }
  }

  async offerRecovery() {
    this.state = 'blocked';
    this.observe(this.onUnavailable);
    // Background work must not raise a native dialog. Keep the failed shell
    // blocked; reopening BLACKICE can use the existing explicit retry path.
    // The initial foreground startup hook may make its window visible above.
    if (!this.active() || !this.window.isVisible()) return false;
    const result = await this.ask('crash', {
      type: 'warning', title: 'BLACKICE interface recovery',
      message: 'The BLACKICE interface could not recover automatically.',
      detail: 'Active work and browser tabs are still running. Keep them running, or try reloading the interface. Reloading does not repeat actions. Text that was not saved may be lost.',
      buttons: ['Keep running', 'Reload interface'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (!this.active() || result?.response !== 1) return false;
    this.state = 'recovering';
    const revision = this.revision;
    const loaded = await this.load();
    if (!this.active()) return false;
    if (loaded && revision === this.revision) { this.state = 'ready'; this.armStable(); return true; }
    // An explicit retry also gets one attempt. A failing load must settle, not
    // open another dialog or silently start another renderer.
    this.state = 'blocked'; return false;
  }

  unresponsive() {
    if (!this.active() || this.hung || this.state !== 'ready') return;
    this.hung = true; this.cancelTimer('stableTimer');
    this.timer('hangTimer', () => {
      if (!this.active() || !this.hung || this.state !== 'ready' || !this.window.isVisible()) return;
      const revision = this.revision;
      void this.ask('hang', {
        type: 'warning', title: 'BLACKICE interface is not responding',
        message: 'The BLACKICE interface is taking longer than expected.',
        detail: 'Active work and browser tabs are still running. You can keep waiting or reload the interface. Text that was not saved may be lost.',
        buttons: ['Keep waiting', 'Reload interface'], defaultId: 0, cancelId: 0, noLink: true,
      }).then(result => {
        if (!this.active() || !this.hung || revision !== this.revision || result?.response !== 1) return;
        this.hung = false; return this.recover({ manual: true });
      }).catch(error => this.report(error));
    }, this.unresponsiveMs);
  }

  responsive() {
    this.hung = false; this.cancelTimer('hangTimer');
    if (this.prompt?.kind === 'hang') this.prompt.controller.abort();
    this.armStable();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true; this.state = 'stopped';
    this.cancelTimer('stableTimer'); this.cancelTimer('hangTimer');
    this.prompt?.controller.abort(); this.loadAttempt?.finish(false);
    for (const [target, name, handler] of this.listeners) target.off(name, handler);
    this.listeners = [];
  }
}
