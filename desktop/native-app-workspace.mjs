import path from 'node:path';
import { NativeAppHost } from './native-app-host.mjs';

const owns = host => host.attached === true || host.sessionActive === true || host.ownershipPossible === true;
const sessionIdentity = value => value?.sessionActive === true && typeof value.sessionId === 'string' && value.sessionId
  && Number.isSafeInteger(value.sessionPid) && value.sessionPid > 0
  && typeof value.sessionProcessStartedAt === 'string' && value.sessionProcessStartedAt
  ? { sessionId: value.sessionId, pid: value.sessionPid, startedAt: value.sessionProcessStartedAt } : null;
const sameIdentity = (a, b) => Boolean(a && b && a.sessionId === b.sessionId && a.pid === b.pid && a.startedAt === b.startedAt);
const handles = status => new Set([status?.windowId, ...(Array.isArray(status?.windowIds) ? status.windowIds : [])].filter(Boolean));
const unavailable = message => Object.assign(new Error(message), { code: 'NATIVE_MANAGED_SESSION_UNAVAILABLE' });
const launchKey = input => {
  if (input && typeof input === 'object' && typeof input.appId === 'string') return JSON.stringify(['app', input.appId]);
  const { executable, args = [] } = typeof input === 'string' ? { executable: input } : input || {};
  return typeof executable === 'string' ? JSON.stringify(['exe', path.win32.normalize(executable.trim().replace(/^"(.+)"$/, '$1')).toLowerCase(), args]) : null;
};

/** Retain a separate native parent for every managed application. Selecting a
 * different app hides its predecessor; it never releases a foreign window.
 * NativeAppHost still owns native observation and exact process/session checks.
 */
export class NativeAppWorkspace {
  constructor({ createHost = options => new NativeAppHost(options), ...options } = {}) {
    this.options = options; this.createHost = createHost;
    this.platform = options.platform ?? process.platform; this.getWindow = options.getWindow; this.catalog = options.catalog;
    this.hosts = new Map(); this.activeId = null; this.sequence = 0; this.selection = 0;
    this.closed = false; this.closing = false; this.tail = Promise.resolve(); this.logDirectory = null;
  }
  get attached() { return [...this.hosts.values()].some(entry => entry.host.attached === true); }
  get sessionActive() { return [...this.hosts.values()].some(entry => entry.host.sessionActive === true); }
  get ownershipPossible() { return [...this.hosts.values()].some(entry => owns(entry.host)); }
  get visible() { return this.active()?.host.visible === true; }
  get bounds() { return this.active()?.host.bounds ?? null; }
  active() { return this.hosts.get(this.activeId) || null; }
  assertOpen() { if (this.closed || this.closing) throw Error('Native applications are closing.'); }
  availability() {
    return { available: this.platform === 'win32' && !this.closed && Boolean(this.getWindow?.()), mode: 'native_window', isolated: false, sandboxed: false,
      details: 'Uses the existing Windows desktop and the application’s normal Windows permissions.' };
  }
  setForegroundLogDirectory(directory) {
    this.logDirectory = directory;
    for (const entry of this.hosts.values()) entry.host.setForegroundLogDirectory?.(path.join(directory, entry.id));
  }
  create() {
    this.assertOpen();
    const id = 'native_' + ++this.sequence, host = this.createHost(this.options);
    if (this.logDirectory) host.setForegroundLogDirectory?.(path.join(this.logDirectory, id));
    const entry = { id, host, status: null, identity: null, keys: new Set(), receipt: null };
    this.hosts.set(id, entry); return entry;
  }
  observer() { return this.active() || [...this.hosts.values()].find(entry => !owns(entry.host) && !entry.receipt) || this.create(); }
  async read(entry) {
    const status = await entry.host.status(), identity = sessionIdentity(status);
    // A recycled PID, helper, or session cannot inherit the previous identity.
    if (identity && entry.identity && !sameIdentity(entry.identity, identity)) throw unavailable('The native application session identity changed. Its retained parent must be checked before selecting it.');
    if (identity) entry.identity ||= identity;
    entry.status = { ...status, workspaceHostId: entry.id };
    // A previously verified session explicitly ended in the native helper.
    // Pending activation, unreadable status, and uncertain ownership never
    // establish that its helper or foreground observation can be discarded.
    if (entry.identity && status.sessionActive === false && status.attached === false && !owns(entry.host)) {
      await entry.host.close();
      this.hosts.delete(entry.id); if (this.activeId === entry.id) this.activeId = null;
    }
    return entry.status;
  }
  async refresh() {
    const statuses = await Promise.all([...this.hosts.values()].map(async entry => {
      try { return await this.read(entry); }
      catch (error) { return { workspaceHostId: entry.id, ...(entry.identity ? { sessionId: entry.identity.sessionId } : {}), attached: false,
        sessionActive: false, currentStatusUnavailable: true, ownershipPossible: owns(entry.host), reason: error.message }; }
    }));
    return statuses;
  }
  async status() {
    const statuses = await this.refresh(), active = statuses.find(value => value.workspaceHostId === this.activeId);
    return { ...this.availability(), attached: false, embedded: false, visible: false, dialogCount: 0, ...active,
      managedSessions: statuses.filter(value => value.sessionActive === true || value.ownershipPossible === true) };
  }
  async statusForSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    const entry = [...this.hosts.values()].find(value => value.identity?.sessionId === sessionId);
    if (!entry) return null;
    const status = await this.read(entry);
    return sameIdentity(entry.identity, sessionIdentity(status)) && status.sessionId === sessionId ? status : null;
  }
  async windows(launchPid = 0) {
    const statuses = await this.refresh(), observed = await this.observer().host.windows(launchPid), result = new Map(observed.map(value => [value.id, value]));
    for (const status of statuses) {
      if (!sessionIdentity(status)) continue;
      for (const id of handles(status)) result.set(id, { ...result.get(id), id, title: result.get(id)?.title || status.title || 'Managed application',
        pid: status.sessionPid, processStartedAt: status.sessionProcessStartedAt, sessionId: status.sessionId,
        managed: true, active: status.workspaceHostId === this.activeId, workspaceHostId: status.workspaceHostId });
    }
    return [...result.values()];
  }
  async apps(options = {}) { if (!this.catalog) throw Error('Installed applications are unavailable in this runtime.'); return this.catalog.list(options); }
  async iconsFor(appIds) { if (!this.catalog) throw Error('Installed applications are unavailable in this runtime.'); return this.catalog.iconsFor(appIds); }
  operation(run) { const operation = this.tail.catch(() => {}).then(() => { this.assertOpen(); return run(); }); this.tail = operation.catch(() => {}); return operation; }
  async select(entry) {
    // Try every predecessor even if one hide fails. Do not activate another app
    // until Windows has acknowledged that the prior stages are hidden.
    const hidden = await Promise.allSettled([...this.hosts.values()].filter(value => value !== entry && owns(value.host)).map(value => value.host.visibleState(false)));
    const failure = hidden.find(value => value.status === 'rejected');
    if (failure) throw failure.reason;
    if (hidden.some(value => value.value?.visible !== false)) throw unavailable('Windows did not confirm that the previous application is hidden. It remains managed; another app was not selected.');
    this.activeId = entry.id; this.selection++; return entry;
  }
  async selectedStatus(entry, result) { return { ...result, ...await this.read(entry), workspaceHostId: entry.id }; }
  launch(input, bounds, options = {}) {
    return this.operation(async () => {
      const key = launchKey(input);
      if (key) for (const entry of this.hosts.values()) {
        if (!entry.keys.has(key) || !entry.identity) continue;
        const current = await this.read(entry);
        if (!sameIdentity(entry.identity, sessionIdentity(current))) continue;
        await this.select(entry);
        let result = { ...entry.receipt, ...current, launched: false, reused: true, pending: !current.attached,
          phase: current.attached && current.embedded ? 'embedded' : 'pending', workspaceHostId: entry.id };
        if (bounds && current.attached) { await entry.host.position(bounds); result = await this.selectedStatus(entry, await entry.host.visibleState(true)); }
        return { ...entry.receipt, ...result, launched: false, reused: true };
      }
      const entry = this.create(); if (key) entry.keys.add(key); await this.select(entry);
      // Discovery can outlive a route. The caller's existing surface protocol
      // supplies fresh bounds before attachment, never stale launch geometry.
      const result = { ...await entry.host.launch(input, undefined, options), workspaceHostId: entry.id };
      entry.receipt = result;
      if (bounds && result.windowId) return { ...result, ...await this.attachSelected(result.windowId, bounds, undefined, entry) };
      return result;
    });
  }
  async findWindow(id, observed, preferred) {
    for (const entry of this.hosts.values()) {
      if (!entry.identity) continue;
      const current = await this.read(entry);
      if (!sameIdentity(entry.identity, sessionIdentity(current))) continue;
      if (handles(current).has(id) || observed && observed.pid === current.sessionPid
        && typeof observed.processStartedAt === 'string' && observed.processStartedAt === current.sessionProcessStartedAt) return entry;
    }
    return preferred || this.create();
  }
  async attachSelected(windowId, bounds, options, preferred) {
    const observed = (await this.windows()).find(value => value.id === windowId);
    if (!observed) throw unavailable('Refresh the window list and select an available application.');
    const entry = await this.findWindow(windowId, observed, preferred); await this.select(entry);
    const current = await this.read(entry);
    let result;
    if (current.attached === true && current.embedded === true && current.windowId === windowId) {
      await entry.host.position(bounds); result = await entry.host.visibleState(true);
    } else result = await entry.host.attach(windowId, bounds, options);
    const selected = await this.selectedStatus(entry, result);
    if (preferred) {
      for (const key of preferred.keys) entry.keys.add(key);
      entry.receipt = { ...preferred.receipt, ...selected };
    }
    return selected;
  }
  attach(windowId, bounds, options) {
    return this.operation(() => this.attachSelected(windowId, bounds, options,
      [...this.hosts.values()].find(entry => entry.receipt?.windowId === windowId && !entry.identity)));
  }
  routed(receipt) {
    const entry = receipt?.workspaceHostId ? this.hosts.get(receipt.workspaceHostId) : [...this.hosts.values()].find(value => value.identity?.sessionId === receipt?.sessionId);
    if (!entry) throw unavailable('The existing activation belongs to a native session that is unavailable. Inspect its windows; do not launch another copy.');
    if (receipt.sessionId && (!entry.identity || !sameIdentity(entry.identity, sessionIdentity(receipt)))) throw unavailable('The saved activation does not match its retained native session.');
    return entry;
  }
  async continueLaunch(receipt, options = {}) {
    const entry = this.routed(receipt);
    // A superseded background observer cannot switch back to an older app.
    if (this.activeId !== entry.id) {
      if (options.isCurrent && options.renew !== true && options.select !== true) return null;
      if (options.signal?.aborted || options.isCurrent && !await options.isCurrent()) return null;
      await this.select(entry);
    }
    const current = await this.read(entry);
    if (current.attached === true && current.embedded === true && sameIdentity(entry.identity, sessionIdentity(current))) {
      return { ...receipt, ...current, pending: false, phase: 'embedded', workspaceHostId: entry.id };
    }
    return { ...await entry.host.continueLaunch(receipt, options), workspaceHostId: entry.id };
  }
  async watchLaunch(receipt, options = {}) {
    const entry = this.routed(receipt);
    if (this.activeId !== entry.id) return null;
    const original = options.isCurrent;
    const result = await entry.host.watchLaunch(receipt, { ...options, isCurrent: async () => this.activeId === entry.id && (!original || await original()) });
    return result && this.activeId === entry.id ? { ...result, workspaceHostId: entry.id } : null;
  }
  async position(bounds) { const entry = this.active(); return entry ? entry.host.position(bounds) : this.status(); }
  async visibleState(show) {
    if (show) {
      const entry = this.active(); if (!entry) return this.status();
      await this.select(entry); return this.selectedStatus(entry, await entry.host.visibleState(true));
    }
    const outcomes = await Promise.allSettled([...this.hosts.values()].filter(entry => owns(entry.host)).map(entry => entry.host.visibleState(false)));
    const failure = outcomes.find(value => value.status === 'rejected'); if (failure) throw failure.reason;
    if (outcomes.some(value => value.value?.visible !== false)) throw unavailable('Windows did not confirm that all managed applications are hidden.');
    return this.status();
  }
  async dialogs() { return this.active()?.host.dialogs() || []; }
  async focus() { const entry = this.active(); if (!entry) throw Error('Load an application window first.'); return entry.host.focus(); }
  closeSelected() { return this.operation(async () => {
    const entry = this.active();
    if (!entry) throw Error('Load an application window first.');
    const current = await this.read(entry);
    if (current.attached !== true || current.embedded !== true) throw unavailable('No embedded application is available to close.');
    const requested = await entry.host.requestClose();
    return this.selectedStatus(entry, requested);
  }); }
  async reposition() { return this.active()?.host.reposition(); }
  async detach() { throw Object.assign(Error('Applications cannot be detached from BLACKICE.'), { code: 'NATIVE_DETACH_UNAVAILABLE' }); }
  async close() {
    if (this.closed) return;
    this.closing = true;
    try {
      await this.tail; await this.refresh();
      if (this.ownershipPossible) throw Object.assign(Error('Managed applications must remain inside BLACKICE. Keep their parent available in the background.'), { code: 'NATIVE_APPLICATIONS_RETAINED' });
      await Promise.all([...this.hosts.values()].map(entry => entry.host.close())); this.closed = true;
    }
    finally { this.closing = false; }
  }
}
