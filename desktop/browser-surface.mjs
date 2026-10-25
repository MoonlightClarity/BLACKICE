import { EventEmitter } from 'node:events';

/** Keep each page's real Chromium view alive while moving it between the shell
 * and a hidden parking window. The driver always observes the same WebContents. */
export function createLiveBrowserWindow({ WebContentsView, BaseWindow, options, onShortcut, onContextMenu }) {
  const parking = new BaseWindow({ width: options.width || 1280, height: options.height || 900,
    show: false, focusable: false, skipTaskbar: true, frame: false, backgroundColor: '#000000' });
  // Electron supplies the exact popup WebContents in createWindow's options.
  // Adopting it preserves the opener and satisfies Electron's guest identity.
  // Sandboxed Chromium keeps native window.close(). Electron's unsandboxed
  // renderer replaces it with BrowserWindow.close(), which cannot close a
  // WebContentsView and can instead target its containing shell window.
  const view = new WebContentsView({ ...(options.webContents ? { webContents: options.webContents } : {}),
    webPreferences: { ...options.webPreferences, sandbox: true, offscreen: false } });
  const handle = new EventEmitter();
  let parent = parking, destroyed = false, attached = false;
  handle.webContents = view.webContents;
  handle.view = view;
  handle.liveSurface = true;
  handle.removeMenu = () => {};
  handle.isDestroyed = () => destroyed || view.webContents.isDestroyed();
  handle.isVisible = () => attached && !parent.isDestroyed() && parent.isVisible();
  handle.isFocusable = () => attached;
  handle.getContentSize = () => { const bounds = view.getBounds(); return [bounds.width, bounds.height]; };
  handle.attach = (host, bounds) => {
    if (handle.isDestroyed() || host.isDestroyed()) throw Error('The browser page or its host closed.');
    if (parent !== host) { if (!parent.isDestroyed()) parent.contentView.removeChildView(view); host.contentView.addChildView(view); parent = host; }
    attached = true; view.setBounds(bounds); view.setVisible(true);
  };
  handle.position = bounds => { if (!handle.isDestroyed()) view.setBounds(bounds); };
  handle.focus = () => { if (attached && !handle.isDestroyed()) view.webContents.focus(); };
  handle.hide = () => {
    if (handle.isDestroyed() || parking.isDestroyed()) return;
    if (parent !== parking) { if (!parent.isDestroyed()) parent.contentView.removeChildView(view); parking.contentView.addChildView(view); parent = parking; }
    attached = false; view.setBounds({ x: 0, y: 0, width: 1280, height: 900 }); view.setVisible(true);
  };
  handle.destroy = () => {
    if (destroyed) return;
    destroyed = true;
    if (!parent.isDestroyed()) parent.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    if (!parking.isDestroyed()) parking.destroy();
  };
  view.webContents.once('destroyed', () => {
    destroyed = true; attached = false;
    if (!parent.isDestroyed()) parent.contentView.removeChildView(view);
    if (!parking.isDestroyed()) parking.destroy();
    handle.emit('closed');
  });
  view.webContents.on('before-input-event', (event, input) => {
    if (!attached || input.type !== 'keyDown') return;
    const modified = input.control || input.meta, key = String(input.key || '').toLowerCase();
    const action = input.alt && !modified && !input.shift ? { arrowleft: 'back', arrowright: 'forward' }[key]
      : modified && !input.alt && key === 'tab' ? input.shift ? 'previous-tab' : 'next-tab'
      : modified && !input.alt && !input.shift ? { l: 'address', t: 'new-tab', w: 'close-tab', r: 'reload' }[key] : null;
    if (action && onShortcut) { event.preventDefault(); onShortcut(action, parent); }
  });
  view.webContents.on('context-menu', (_event, params) => { if (attached) onContextMenu?.(view.webContents, params, parent); });
  parking.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: options.width || 1280, height: options.height || 900 });
  return handle;
}

export function browserSurfaceBounds(value, host) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['x', 'y', 'width', 'height'].includes(key))
      || ![value.x, value.y, value.width, value.height].every(Number.isFinite)
      || value.width < 1 || value.height < 1 || value.width > 32768 || value.height > 32768)
    throw Error('Provide the visible browser page bounds.');
  const [width, height] = host.getContentSize();
  const x = Math.max(0, Math.min(width, Math.round(value.x))), y = Math.max(0, Math.min(height, Math.round(value.y)));
  const right = Math.max(x, Math.min(width, Math.round(value.x + value.width)));
  const bottom = Math.max(y, Math.min(height, Math.round(value.y + value.height)));
  if (right <= x || bottom <= y) throw Error('The browser page is outside the BLACKICE window.');
  return { x, y, width: right - x, height: bottom - y };
}

/** Native view mutations are generation-scoped: hide revokes an in-flight
 * activation immediately, so a late page load cannot cover another workspace. */
export class BrowserSurfaceHost {
  constructor(driver) { this.driver = driver; this.generation = 0; this.current = null; this.pending = null; this.host = null; this.bounds = null; }
  status() { return { attached: Boolean(this.current?.window && !this.current.window.isDestroyed()), tabId: this.current?.id || null, bounds: this.bounds }; }
  hide() {
    this.generation++;
    const tab = this.current, pending = this.pending;
    this.current = null; this.host = null; this.bounds = null;
    this.pending = null;
    if (tab?.window && !tab.window.isDestroyed()) tab.window.hide();
    if (tab) { tab.humanSurface = false; void this.driver.setHumanSurface(tab, false).catch(() => {}); this.driver.emit('changed'); }
    if (pending && pending !== tab) { pending.humanSurface = false; void this.driver.setHumanSurface(pending, false).catch(() => {}); }
    return this.status();
  }
  async perform(host, request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw Error('Choose a browser surface action.');
    const fields = { attach: ['action', 'tabId', 'bounds'], bounds: ['action', 'bounds'], hide: ['action'], focus: ['action'], 'focus-chrome': ['action'], status: ['action'],
      authenticate: ['action', 'tabId', 'challengeId', 'username', 'password'], 'cancel-auth': ['action', 'tabId', 'challengeId'] }[request.action];
    if (!fields || Object.keys(request).some(key => !fields.includes(key))) throw Error('Unsupported browser surface action.');
    if (request.action === 'hide') return this.hide();
    if (request.action === 'status') return this.status();
    if (!host || host.isDestroyed()) { this.hide(); throw Error('The BLACKICE browser host is unavailable.'); }
    if (['authenticate', 'cancel-auth'].includes(request.action)) return this.driver.resolveAuthentication(request);
    if (request.action === 'focus-chrome') { host.webContents?.focus(); return this.status(); }
    if (request.action === 'focus') { this.current?.window?.focus(); return this.status(); }
    const bounds = browserSurfaceBounds(request.bounds, host);
    if (request.action === 'bounds') {
      if (this.current && this.host === host) { this.current.window.position(bounds); this.bounds = bounds; }
      return this.status();
    }
    if (typeof request.tabId !== 'string' || !request.tabId || request.tabId.length > 200) throw Error('Choose a current BLACKICE browser tab.');
    this.hide(); const generation = this.generation, tab = this.driver.tab(request.tabId);
    this.pending = tab;
    // Script/file dialogs can be retired before native interaction takes over.
    // HTTP authentication remains pending while its live view is attached.
    try {
      if (tab.window && !tab.window.isDestroyed() && tab.pendingInteraction) await this.driver.setHumanSurface(tab, true);
      await this.driver.activate(tab);
      if (generation !== this.generation) return this.status();
      if (host.isDestroyed()) return this.hide();
      if (!tab.window?.liveSurface) throw Error('This browser page does not have a live native view.');
      await this.driver.setHumanSurface(tab, true);
      if (generation !== this.generation) return this.status();
      if (host.isDestroyed() || tab.window.isDestroyed()) return this.hide();
      tab.window.attach(host, bounds); tab.userPinned = true; this.pending = null;
      this.current = tab; this.host = host; this.bounds = bounds;
      this.driver.activeTab = tab.id; this.driver.persist(); this.driver.emit('changed');
      await this.driver.savedStatus();
      if (generation !== this.generation) return this.status();
      if (host.isDestroyed() || tab.window.isDestroyed()) return this.hide();
      return this.status();
    } catch (error) { if (generation === this.generation) this.hide(); throw error; }
  }
}

export async function performBrowserSurface(router, host, request) {
  const driver = router?.drivers?.relay;
  if (!driver) throw Error('The native browser is unavailable.');
  const result = await driver.setHostSurface(host, request);
  if (request?.action === 'attach' && result.attached === true && result.tabId === request.tabId
      && driver.surface?.status().tabId === result.tabId) {
    router.activeTab = result.tabId;
    router.emit('changed');
  }
  return result;
}
