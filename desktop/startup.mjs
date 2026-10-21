const STARTUP_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Starting BLACKICE</title><style>html{color-scheme:dark;background:#080e14;color:#e4edf4;font:16px system-ui,sans-serif}body{margin:0;min-height:220px;display:grid;place-items:center}main{width:calc(100% - 64px);max-width:440px;padding:24px 0}small{font-size:11px;letter-spacing:.22em;color:#8fa9ba}h1{font-size:25px;font-weight:550;margin:17px 0 12px}p{font-size:14px;line-height:1.6;color:#a5b8c6;margin:0}.track{height:3px;overflow:hidden;background:#23323c;margin-top:27px;border-radius:3px}.track:after{content:'';display:block;width:32%;height:100%;background:#9ac9e8;animation:loading 1.8s ease-in-out infinite}@keyframes loading{from{transform:translateX(-110%)}to{transform:translateX(420%)}}@media(prefers-reduced-motion:reduce){.track:after{animation:none;transform:translateX(105%)}}</style></head><body><main role="status" aria-live="polite"><small>BLACKICE</small><h1>Starting BLACKICE…</h1><p>Preparing your workspace.</p><div class="track" aria-hidden="true"></div></main></body></html>`;

/** A static, isolated window. It never loads the app profile or a remote page. */
export function createStartupIndicator({ BrowserWindow, icon, onQuit = () => {} } = {}) {
  let disposed = false, closing = false, resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const window = new BrowserWindow({ width: 560, height: 270, title: 'BLACKICE', backgroundColor: '#080e14', show: false, resizable: false, maximizable: false, fullscreenable: false, autoHideMenuBar: true, ...(icon ? { icon } : {}),
    webPreferences: { partition: 'blackice-startup', nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, devTools: false, spellcheck: false } });
  window.removeMenu();
  const contents = window.webContents, documentUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(STARTUP_HTML);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-redirect', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== documentUrl }));
  window.once('ready-to-show', () => { if (!disposed && !closing && !window.isDestroyed()) { window.show(); resolveReady(true); } });
  window.on('close', () => { if (!disposed) { closing = true; resolveReady(false); onQuit(); } });
  window.on('closed', () => resolveReady(false));
  Promise.resolve().then(() => window.loadURL(documentUrl)).catch(() => {
    if (disposed || closing) resolveReady(false); else rejectReady(new Error('The BLACKICE startup window could not be loaded.'));
  });
  const dispose = () => { if (disposed) return; disposed = true; resolveReady(false); if (!closing && !window.isDestroyed()) window.destroy(); };
  return { ready, dispose, handoff(workspace, readyToShow) { if (!readyToShow || !workspace || workspace.isDestroyed() || !workspace.isVisible()) return false; dispose(); return true; } };
}

const cancelled = () => Object.assign(new Error('BLACKICE startup was cancelled.'), { code: 'BLACKICE_STARTUP_CANCELLED' });

/** Stops admission and disposes resources that finish initializing after quit. */
export class DesktopStartup {
  constructor({ headless = false, createIndicator } = {}) { this.headless = headless; this.createIndicator = createIndicator; this.indicator = null; this.pending = new Set(); this.stopped = false; }
  step(operation, dispose) {
    if (this.stopped) return Promise.reject(cancelled());
    const pending = Promise.resolve().then(async () => {
      if (this.stopped) throw cancelled();
      let value;
      try { value = await operation(); } catch (error) { if (this.stopped) throw cancelled(); throw error; }
      if (this.stopped) { await dispose?.(value); throw cancelled(); }
      return value;
    });
    this.pending.add(pending); const settled = () => this.pending.delete(pending); pending.then(settled, settled); return pending;
  }
  showIndicator() { return this.step(() => { if (this.headless) return false; this.indicator ||= this.createIndicator(); return this.indicator.ready; }); }
  handoff(window, readyToShow) { return !this.stopped && Boolean(this.indicator?.handoff(window, readyToShow)); }
  stop() { this.stopped = true; this.indicator?.dispose(); }
  async drain() { for (const result of await Promise.allSettled([...this.pending])) if (result.status === 'rejected' && result.reason?.code !== 'BLACKICE_STARTUP_CANCELLED') throw result.reason; }
  async drainAfter(cleanup) { try { await cleanup(); } finally { await this.drain(); } }
}
