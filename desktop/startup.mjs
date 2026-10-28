const STARTUP_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Starting BLACKICE</title><style>html{color-scheme:dark;background:#080e14;color:#e4edf4;font:16px system-ui,sans-serif}body{margin:0;min-height:220px;display:grid;place-items:center}main{width:calc(100% - 64px);max-width:440px;padding:24px 0}small{font-size:11px;letter-spacing:.22em;color:#8fa9ba}h1{font-size:25px;font-weight:550;margin:17px 0 12px}p{font-size:14px;line-height:1.6;color:#a5b8c6;margin:0}.track{height:6px;overflow:hidden;background:#23323c;margin-top:24px;border-radius:3px}.fill{height:100%;width:0;background:#9ac9e8;transition:width .2s ease}.detail{display:flex;justify-content:space-between;gap:12px;margin-top:10px;font-size:12px;color:#8fa9ba}.hint{margin-top:10px;font-size:11px;color:#8fa9ba}@media(prefers-reduced-motion:reduce){.fill{transition:none}}</style></head><body><main><small>BLACKICE</small><h1>Starting BLACKICE…</h1><p id="stage" role="status" aria-live="polite">Preparing your workspace.</p><div id="progress" class="track" role="progressbar" aria-label="Startup stages completed" aria-valuemin="0" aria-valuemax="6" aria-valuenow="0" aria-valuetext="No startup stages completed"><div id="fill" class="fill"></div></div><div class="detail"><span id="milestones">0 of 6 stages completed</span><span id="elapsed">Current step: 0s</span></div><p id="hint" class="hint">Progress shows completed stages, not an estimated time.</p></main></body></html>`;

// These are real milestones, not estimated fractions of startup duration.
const PROGRESS_STAGES = Object.freeze({
  profile: 'Preparing your profile…', browser: 'Starting the browser…', history: 'Restoring saved work…',
  conversations: 'Loading conversations…', 'direct-jobs': 'Starting local services…',
  window: 'Opening your workspace…',
});
const formatElapsed = ms => { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`; };

/** A static, isolated window. It never loads the app profile or a remote page. */
export function createStartupIndicator({ BrowserWindow, icon, activate = true, onQuit = () => {}, now = Date.now, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let disposed = false, closing = false, painted = false, rendering = false, dirty = false, resolveReady, rejectReady;
  let stage = 'Preparing your workspace.', currentPhase = null, startedAt = now(), failed = false;
  const completed = new Set();
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const window = new BrowserWindow({ width: 560, height: 270, title: 'BLACKICE', backgroundColor: '#080e14', show: false, resizable: false, maximizable: false, fullscreenable: false, autoHideMenuBar: true, ...(icon ? { icon } : {}),
    webPreferences: { partition: 'blackice-startup', nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, devTools: false, spellcheck: false } });
  window.removeMenu();
  const contents = window.webContents, documentUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(STARTUP_HTML);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-redirect', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(true));
  contents.session.setPermissionCheckHandler(() => true);
  contents.session.setDevicePermissionHandler(() => true);
  contents.session.setUSBProtectedClassesHandler(() => []);
  contents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== documentUrl }));
  const render = () => {
    if (!painted || disposed || closing || window.isDestroyed() || typeof contents.executeJavaScript !== 'function') return;
    if (rendering) { dirty = true; return; }
    rendering = true;
    const count = completed.size, elapsed = formatElapsed(now() - startedAt);
    const payload = JSON.stringify({ stage, count, elapsed, failed });
    const script = `(() => { const p = ${payload}; document.getElementById('stage').textContent = p.stage; document.getElementById('fill').style.width = (p.count / 6 * 100) + '%'; const bar = document.getElementById('progress'); bar.setAttribute('aria-valuenow', String(p.count)); bar.setAttribute('aria-valuetext', p.count + ' of 6 startup stages completed'); document.getElementById('milestones').textContent = p.count + ' of 6 stages completed'; document.getElementById('elapsed').textContent = p.failed ? 'Startup stopped' : 'Current step: ' + p.elapsed; document.getElementById('hint').textContent = p.failed ? 'Check the startup error message.' : 'Progress shows completed stages, not an estimated time.'; })()`;
    Promise.resolve().then(() => contents.executeJavaScript(script)).catch(() => {}).finally(() => { rendering = false; if (dirty) { dirty = false; render(); } });
  };
  const timer = setTimer(render, 1000); timer?.unref?.();
  window.once('ready-to-show', () => { if (!disposed && !closing && !window.isDestroyed()) { painted = true; if (activate) window.show(); else window.showInactive(); render(); resolveReady(true); } });
  window.on('close', () => { if (!disposed) { closing = true; clearTimer(timer); resolveReady(false); onQuit(); } });
  window.on('closed', () => { clearTimer(timer); resolveReady(false); });
  Promise.resolve().then(() => window.loadURL(documentUrl)).catch(() => {
    if (disposed || closing) resolveReady(false); else rejectReady(new Error('The BLACKICE startup window could not be loaded.'));
  });
  const dispose = () => { if (disposed) return; disposed = true; clearTimer(timer); resolveReady(false); if (!closing && !window.isDestroyed()) window.destroy(); };
  const progress = (phase, outcome) => {
    if (disposed || closing) return;
    if (outcome === 'failed' && (phase === 'local-harness' || Object.hasOwn(PROGRESS_STAGES, phase))) { failed = true; currentPhase = null; stage = 'BLACKICE could not finish starting.'; render(); return; }
    if (!Object.hasOwn(PROGRESS_STAGES, phase) || failed) return;
    if (outcome === 'started') { currentPhase = phase; stage = PROGRESS_STAGES[phase]; startedAt = now(); }
    else if (outcome === 'ready') {
      completed.add(phase);
      if (currentPhase === phase) { currentPhase = null; stage = phase === 'window' ? 'Finishing startup…' : 'Preparing local services…'; startedAt = now(); }
    } else return;
    render();
  };
  return { ready, dispose, progress, activate() { if (!disposed && !closing && painted && !window.isDestroyed()) window.show(); }, handoff(workspace, readyToShow) { if (!readyToShow || !workspace || workspace.isDestroyed() || !workspace.isVisible()) return false; dispose(); return true; } };
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
  progress(phase, outcome) { if (!this.stopped) this.indicator?.progress(phase, outcome); }
  activateIndicator() { if (!this.stopped) this.indicator?.activate(); }
  handoff(window, readyToShow) { return !this.stopped && Boolean(this.indicator?.handoff(window, readyToShow)); }
  stop() { this.stopped = true; this.indicator?.dispose(); }
  async drain() { for (const result of await Promise.allSettled([...this.pending])) if (result.status === 'rejected' && result.reason?.code !== 'BLACKICE_STARTUP_CANCELLED') throw result.reason; }
  async drainAfter(cleanup) { try { await cleanup(); } finally { await this.drain(); } }
}
