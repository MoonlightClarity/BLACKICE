import { EventEmitter } from 'node:events';

const FIREFOX_PREFIX = 'firefox:';
const fail = (message, code = 'BROWSER_VALIDATION') => Object.assign(new Error(message), { code });
const externalId = (browser, id) => browser === 'firefox' ? `${FIREFOX_PREFIX}${id}` : String(id);
const cancelled = () => Object.assign(fail('Browser action cancelled. Inspect the page before repeating an action.', 'ABORT_ERR'), { name: 'AbortError' });
function descendsFrom(owners, child, parent) {
  const seen = new Set();
  while (child && !seen.has(child)) {
    seen.add(child); child = owners.get(child)?.parentTabId;
    if (child === parent) return true;
  }
  return false;
}

/** Combines a ready Relay browser with a Firefox adapter that connects lazily. */
export class BrowserRouter extends EventEmitter {
  constructor({ independent, firefox } = {}) {
    super(); this.drivers = { relay: independent, firefox }; this.activeTab = null; this.closed = false; this.listeners = [];
    for (const driver of Object.values(this.drivers)) if (driver?.on) {
      const listener = () => this.emit('changed'); driver.on('changed', listener); this.listeners.push([driver, listener]);
    }
  }
  // Child creation and initialization belong to the desktop runtime. In
  // particular, restoring/listing a workspace must not start Firefox.
  async init() { if (this.closed) throw fail('The browser workspace has closed.', 'BROWSER_CLOSED'); return this; }
  status() {
    const tabs = [], downloads = [], browsers = {}, owners = new Map(), previousOwners = this.owners; let fallback = null, relayStatus = {};
    for (const [browser, driver] of Object.entries(this.drivers)) {
      if (!driver || this.closed) { browsers[browser] = { available: false, canShow: false, contained: browser === 'relay' }; continue; }
      const status = driver.status?.() || {};
      if (browser === 'relay') relayStatus = status;
      const { tabs: childTabs, downloads: childDownloads, activeTab, ...metadata } = status;
      browsers[browser] = { ...metadata, available: status.available !== false, canShow: false, contained: browser === 'relay' };
      for (const tab of childTabs || []) {
        const tabId = externalId(browser, tab.tabId);
        if (owners.has(tabId)) throw fail('Browser tab identities conflict. Close and reopen the affected tab.', 'BROWSER_TAB_CONFLICT');
        owners.set(tabId, { browser, nativeId: tab.tabId, ...(browser === 'relay' && tab.parentTabId ? { parentTabId: tab.parentTabId } : {}) });
        tabs.push({ ...tab, tabId, browser, canShow: false, contained: browser === 'relay' });
      }
      const childActiveTab = activeTab != null ? externalId(browser, activeTab) : null;
      browsers[browser].activeTab = owners.get(childActiveTab)?.browser === browser ? childActiveTab : null;
      if (browsers[browser].activeTab !== null) fallback ||= browsers[browser].activeTab;
      for (const item of childDownloads || []) downloads.push({ ...item, browser, ...(item.tabId != null ? { tabId: externalId(browser, item.tabId) } : {}) });
    }
    this.owners = owners;
    // A closing popup returns to its surviving parent, even when the contained
    // driver's fallback is a different personal page.
    if (!owners.has(this.activeTab) && previousOwners) {
      const seen = new Set(); let parent = this.activeTab;
      while (parent && !seen.has(parent)) {
        seen.add(parent); parent = previousOwners.get(parent)?.parentTabId;
        if (owners.has(parent)) { this.activeTab = parent; break; }
      }
    }
    if (!owners.has(this.activeTab)) this.activeTab = fallback || tabs[0]?.tabId || null;
    // Follow only a newly created live child of the page already being followed.
    // Task popups update ownerActiveTabs rather than the driver's personal active
    // tab, so comparing driver.activeTab alone loses their handoff.
    if (previousOwners) {
      for (;;) {
        const children = tabs.filter(tab => tab.browser === 'relay' && tab.parentTabId === this.activeTab && tab.suspended !== true && !previousOwners.has(tab.tabId));
        if (children.length !== 1) break;
        this.activeTab = children[0].tabId;
      }
    }
    const containedAvailable = !this.closed && browsers.relay?.available === true;
    return { ...relayStatus, available: !this.closed && Object.values(browsers).some(browser => browser.available), background: true, physicalInput: false, contained: containedAvailable, containedAvailable, canShow: false, tabs, downloads, activeTab: this.activeTab, browsers };
  }
  owner(args, status) {
    let tabId = args.tabId;
    if (tabId == null) {
      if (args.browser) {
        const selected = this.drivers[args.browser]?.status?.() || {};
        tabId = selected.activeTab != null ? externalId(args.browser, selected.activeTab) : status.tabs.find(tab => tab.browser === args.browser)?.tabId;
      } else tabId = status.activeTab;
    }
    const owner = this.owners.get(tabId);
    if (!owner) throw fail('Choose an existing browser tab, or open a URL first.', 'BROWSER_TAB_NOT_FOUND');
    if (args.browser && args.browser !== owner.browser) throw fail('This tab belongs to a different browser. Use its listed browser and tab ID.', 'BROWSER_TAB_MISMATCH');
    return { ...owner, tabId };
  }
  async perform(args, options = {}) {
    if (this.closed) throw fail('The browser workspace has closed.', 'BROWSER_CLOSED');
    if (options.signal?.aborted) throw cancelled();
    if (!args || (args.browser != null && !['relay', 'firefox'].includes(args.browser))) throw fail('Choose relay or firefox as the browser.');
    const status = this.status();
    if (args.action === 'tabs') return status;
    if (args.action === 'downloads') return { downloads: args.browser ? status.downloads.filter(item => item.browser === args.browser) : status.downloads };
    const independent = ['open', 'folder_create', 'folder_rename', 'folder_close'].includes(args.action);
    const selected = independent ? { browser: args.browser || 'relay' } : this.owner(args, status);
    if (['folder_create', 'folder_rename', 'folder_close', 'tab_move', 'suspend'].includes(args.action) && selected.browser !== 'relay') throw fail('Browser folders and saved pages belong to the contained BLACKICE browser.', 'BROWSER_CONTAINED_ONLY');
    if (selected.browser !== 'relay' && (args.action === 'type' || args.expectedDocumentId !== undefined || args.expectedUrl !== undefined)) throw fail('Direct page typing is available only in the contained BLACKICE browser.', 'BROWSER_CONTAINED_INPUT_REQUIRED');
    const driver = this.drivers[selected.browser];
    if (!driver) throw fail('This browser is not available.', 'BROWSER_UNAVAILABLE');
    const nativeArgs = { ...args }; delete nativeArgs.browser;
    if (independent) delete nativeArgs.tabId;
    if (selected.nativeId != null) nativeArgs.tabId = selected.nativeId;
    const knownTabs = new Set(status.tabs.map(tab => tab.tabId));
    const result = await driver.perform(nativeArgs, options);
    // An adapter can complete after cancellation or while shutdown is draining
    // it. Do not publish an old success or resurrect the selected tab then.
    if (this.closed) throw fail('The browser workspace closed before the action finished. Inspect before repeating the action.', 'BROWSER_CLOSED');
    if (options.signal?.aborted) throw cancelled();
    const merged = this.status();
    if (['close', 'folder_create', 'folder_rename', 'folder_close', 'tab_move', 'suspend'].includes(args.action)) return { ...merged, ...(result?.folder ? { folder: result.folder } : {}), ...(result?.receipt ? { receipt: result.receipt } : {}) };
    const tabId = result?.tabId != null ? externalId(selected.browser, result.tabId) : selected.tabId;
    // The original action still returns its own receipt; it must not reselect
    // the parent after a native child appeared while that action was finishing.
    const popupHandoff = !knownTabs.has(this.activeTab) && descendsFrom(this.owners, this.activeTab, tabId);
    if (!options.owner && !popupHandoff && tabId && this.owners.has(tabId) && this.activeTab !== tabId) { this.activeTab = tabId; this.emit('changed'); }
    return { ...result, browser: selected.browser, ...(tabId ? { tabId } : {}), ...(result?.tabs ? { tabs: merged.tabs } : {}), ...(result?.activeTab !== undefined ? { activeTab: this.activeTab } : {}) };
  }
  async show(tabId) {
    if (this.closed) throw fail('The browser workspace has closed.', 'BROWSER_CLOSED');
    const status = this.status();
    const selected = tabId != null || status.activeTab ? this.owner({ tabId }, status) : { browser: 'relay' };
    if (selected.browser === 'firefox') throw fail('Firefox runs in the background without a visible window. Use its page snapshot or screenshot here.', 'BROWSER_HEADLESS');
    throw fail('Browser pages stay contained inside BLACKICE. Use the Observe view to inspect and control them.', 'BROWSER_CONTAINED');
  }
  async releaseOwner(owner) {
    if (this.closed || typeof this.drivers.relay?.releaseOwner !== 'function') return { suspended: [], retained: [], unavailable: true };
    return this.drivers.relay.releaseOwner(owner);
  }
  async flushPersistence() {
    if (this.closed) throw fail('The browser workspace has closed.', 'BROWSER_CLOSED');
    if (typeof this.drivers.relay?.flushPersistence !== 'function') throw fail('The contained browser cannot confirm its saved page and folder state.', 'BROWSER_PERSISTENCE_UNAVAILABLE');
    await this.drivers.relay.flushPersistence();
    return this.status();
  }
  async prepareCredentialFill(args, options = {}) {
    if (this.closed || options.signal?.aborted) throw cancelled();
    const selected = this.owner(args, this.status());
    if (selected.browser !== 'relay' || args.browser !== 'relay' || typeof this.drivers.relay?.prepareCredentialFill !== 'function') throw fail('Protected credentials can fill only the contained BLACKICE browser.', 'BROWSER_CREDENTIAL_UNAVAILABLE');
    const commit = await this.drivers.relay.prepareCredentialFill({ ...args, tabId: selected.nativeId }, options);
    return async secret => {
      if (this.closed || options.signal?.aborted) throw cancelled();
      const current = this.owner(args, this.status());
      if (current.browser !== 'relay' || current.nativeId !== selected.nativeId) throw fail('The credential target changed.', 'BROWSER_CREDENTIAL_TARGET_CHANGED');
      return commit(secret);
    };
  }
  protectionStatus() { return this.drivers.relay?.protectionStatus?.() || { available: false, enabled: false, ready: false, tabs: [] }; }
  async configureProtection(options, context = {}) {
    if (this.closed) throw fail('The browser workspace has closed.', 'BROWSER_CLOSED');
    if (typeof this.drivers.relay?.configureProtection !== 'function') throw fail('Browser protection is available in the contained BLACKICE browser.', 'BROWSER_PROTECTION_UNAVAILABLE');
    let value = options;
    if (options?.action === 'site') {
      const selected = this.owner({ tabId: options.tabId }, this.status());
      if (selected.browser !== 'relay') throw fail('Protection settings apply only to the contained BLACKICE browser.', 'BROWSER_PROTECTION_CONTAINED_ONLY');
      value = { ...options, tabId: selected.nativeId };
    }
    return this.drivers.relay.configureProtection(value, context);
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      const results = await Promise.allSettled(Object.values(this.drivers).filter(Boolean).map(driver => Promise.resolve().then(() => driver.close?.())));
      for (const [driver, listener] of this.listeners) driver.removeListener?.('changed', listener);
      this.listeners = [];
      const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
    })();
    return this.closePromise;
  }
}
