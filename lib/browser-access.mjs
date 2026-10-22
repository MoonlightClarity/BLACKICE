const fail = (message, code = 'BROWSER_ERROR') => Object.assign(new Error(message), { code, stage: 'target' });

// Only the host may bind this context. Tool JSON never grants ownership.
export function browserOwner(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['taskId', 'runId', 'nodeId', 'label', 'allowUserTabs'].includes(key))) throw fail('Invalid host browser ownership context.', 'BROWSER_OWNER_INVALID');
  for (const key of ['taskId', 'runId', 'nodeId']) if (typeof value[key] !== 'string' || !value[key] || value[key].length > 200 || /[\u0000-\u001f\u007f]/.test(value[key])) throw fail('Invalid host browser ownership context.', 'BROWSER_OWNER_INVALID');
  if (value.label !== undefined && (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 200 || /[\u0000-\u001f\u007f]/.test(value.label))) throw fail('Invalid browser task folder name.', 'BROWSER_OWNER_INVALID');
  if (value.allowUserTabs !== undefined && typeof value.allowUserTabs !== 'boolean') throw fail('Invalid host browser ownership context.', 'BROWSER_OWNER_INVALID');
  return { taskId: value.taskId, runId: value.runId, nodeId: value.nodeId, ...(value.label ? { label: value.label.trim() } : {}), ...(value.allowUserTabs === true ? { allowUserTabs: true } : {}) };
}
export const browserOwnerKey = owner => owner ? `${owner.taskId}\u0000${owner.nodeId}` : null;
export const sameBrowserOwner = (left, right) => !left && !right || Boolean(left && right && left.taskId === right.taskId && left.nodeId === right.nodeId);
export const browserOwnsTab = (tab, owner) => !owner || (tab?.owner ? sameBrowserOwner(tab.owner, owner) : owner.allowUserTabs === true);
export const browserOwnsFolder = (folder, owner) => !owner || Boolean(folder && (folder.kind === 'task' && folder.taskId === owner.taskId || owner.allowUserTabs && folder.kind === 'user'));
const ownsTab = browserOwnsTab;
const ownershipError = () => Object.assign(fail('This tab belongs to another task or to the person. Open a page in this task’s browser folder.', 'BROWSER_TAB_OWNERSHIP'), { status: 409, actionDispatched: false });

const reservedTabError = () => Object.assign(fail('This ChatGPT tab belongs to the person calling BLACKICE. Choose an ordinary contained browser tab for tool work.', 'BROWSER_HUMAN_CHAT_RESERVED'), { status: 409, actionDispatched: false });
const unverifiedTabs = () => Object.assign(fail('Current browser tab ownership is unavailable. Inspect the contained browser before acting.', 'BROWSER_TAB_STATE_UNAVAILABLE'), { status: 409, actionDispatched: false });
const containedTab = tab => (!tab?.browser || tab.browser === 'relay') && typeof tab?.tabId === 'string' && !tab.tabId.startsWith('firefox:');
export function assertBrowserCallingTabBoundary(args, status) {
  if (args?.tabId != null && Array.isArray(status?.tabs) && status.tabs.some(tab => containedTab(tab) && tab.tabId === args.tabId && tab.purpose === 'chat-mode')) throw reservedTabError();
}
function agentTabs(status) {
  if (!Array.isArray(status?.tabs)) throw unverifiedTabs();
  return status.tabs.filter(containedTab);
}

function agentActiveTab(status, tabs, owner) {
  if (owner) {
    const selection = status?.ownerActiveTabs?.[browserOwnerKey(owner)] ?? status?.browsers?.relay?.ownerActiveTabs?.[browserOwnerKey(owner)];
    return tabs.find(tab => tab.tabId === selection && ownsTab(tab, owner)) || null;
  }
  const relay = status?.browsers?.relay;
  // The router's global selection may be a manually selected external tab.
  // Use the contained driver's verified selection, never the first visible tab.
  const id = relay && Object.hasOwn(relay, 'activeTab') ? relay.activeTab : status?.activeTab;
  return tabs.find(tab => tab.tabId === id) || null;
}

/** Resolve a tool target from trusted adapter metadata, never caller-supplied purpose. */
export function agentBrowserRequest(args, status, context) {
  const owner = browserOwner(context);
  if (Object.hasOwn(args, 'source') || Object.hasOwn(args, 'purpose') || Object.hasOwn(args, 'owner')) throw Object.assign(fail('Browser source, ownership and tab purpose belong to the host, not tool arguments.', 'BROWSER_VALIDATION'), { actionDispatched: false });
  if (args.browser !== undefined && args.browser !== 'relay' || String(args.tabId || '').startsWith('firefox:')) throw Object.assign(fail('External browser interaction is unavailable to task agents. Use the contained relay browser in Observe.', 'BROWSER_CONTAINED_ONLY'), { actionDispatched: false });
  const tabs = agentTabs(status);
  if (args.tabId != null && (typeof args.tabId !== 'string' || !args.tabId)) throw Object.assign(fail('Choose an observed browser tab ID.', 'BROWSER_VALIDATION'), { actionDispatched: false });
  const explicit = args.tabId != null ? tabs.find(tab => tab.tabId === args.tabId) : null;
  assertBrowserCallingTabBoundary(args, status);
  if (explicit && !ownsTab(explicit, owner)) throw ownershipError();
  if (args.action !== 'open' && args.tabId != null && !explicit) throw Object.assign(fail('The selected browser tab is no longer available. Inspect the current tabs before acting.', 'BROWSER_TAB_NOT_FOUND'), { actionDispatched: false });
  const folderForAction = id => {
    const folder = status?.folders?.find(value => value.id === id);
    if (!folder) throw Object.assign(fail('Choose an observed browser folder.', 'BROWSER_FOLDER_NOT_FOUND'), { actionDispatched: false });
    if (!browserOwnsFolder(folder, owner)) throw ownershipError();
    return folder;
  };
  if (args.action === 'folder_create') return { ...args, browser: 'relay' };
  if (['folder_rename', 'folder_close'].includes(args.action)) {
    const folder = folderForAction(args.folderId);
    if (args.action === 'folder_close') for (const tab of tabs.filter(value => value.folderId === folder.id)) {
      if (tab.purpose === 'chat-mode') throw reservedTabError();
      if (!ownsTab(tab, owner)) throw ownershipError();
    }
    return { ...args, browser: 'relay' };
  }
  if (args.action === 'protection' && args.operation !== 'site') return { ...args, browser: 'relay' };
  if (args.action === 'open') {
    if (args.tabId != null) throw Object.assign(fail('Opening an ordinary browser tab does not accept an existing tab ID.', 'BROWSER_VALIDATION'), { actionDispatched: false });
    if (args.parentTabId != null) {
      const parent = tabs.find(tab => tab.tabId === args.parentTabId);
      if (!parent || parent.purpose === 'chat-mode' || !ownsTab(parent, owner)) throw ownershipError();
    }
    if (args.folderId != null) folderForAction(args.folderId);
    return { ...args, browser: 'relay' };
  }
  if (['tabs', 'downloads'].includes(args.action)) return { ...args, browser: 'relay' };
  const target = explicit || agentActiveTab(status, tabs, owner);
  if (!target) throw Object.assign(fail('Choose an ordinary contained browser tab, or open a URL first.', 'BROWSER_TAB_NOT_FOUND'), { actionDispatched: false });
  if (target.purpose === 'chat-mode') throw reservedTabError();
  if (args.action === 'tab_move') {
    if (args.folderId != null) folderForAction(args.folderId);
    if (args.parentTabId != null) {
      const parent = tabs.find(tab => tab.tabId === args.parentTabId);
      if (parent?.purpose === 'chat-mode') throw reservedTabError();
      if (!parent || !ownsTab(parent, owner)) throw ownershipError();
    }
    const branch = new Set([target.tabId]);
    for (let changed = true; changed;) {
      changed = false;
      for (const tab of tabs) if (branch.has(tab.parentTabId) && !branch.has(tab.tabId)) { branch.add(tab.tabId); changed = true; }
    }
    for (const tab of tabs.filter(value => branch.has(value.tabId))) {
      if (tab.purpose === 'chat-mode') throw reservedTabError();
      if (!ownsTab(tab, owner)) throw ownershipError();
    }
  }
  // A later active-tab change must not retarget work queued for this page.
  return { ...args, browser: 'relay', tabId: target.tabId };
}

/** Agent receipts omit the human calling tab and session-wide diagnostics. */
export function agentBrowserResult(result, status, context) {
  const owner = browserOwner(context), tabs = agentTabs(status), allowed = new Set(tabs.filter(tab => tab.purpose !== 'chat-mode' && ownsTab(tab, owner)).map(tab => tab.tabId));
  const value = { ...result };
  if (value.purpose === 'chat-mode' || value.tabId != null && !allowed.has(value.tabId) || value.pendingInteraction?.tabId != null && !allowed.has(value.pendingInteraction.tabId)) throw Object.assign(fail('The browser result no longer belongs to an ordinary tool tab. Inspect the current tabs before continuing.', 'BROWSER_RESULT_TAB_CHANGED'), { status: 409 });
  const belongs = item => containedTab(item) && item.purpose !== 'chat-mode' && allowed.has(item.tabId);
  if (Array.isArray(value.tabs)) value.tabs = value.tabs.filter(belongs);
  // A completed download retains its source identity after the source tab closes.
  if (Array.isArray(value.downloads)) value.downloads = value.downloads.filter(item => browserDownloadVisible(item, tabs, owner));
  if (Array.isArray(value.exemptOrigins)) {
    const origins = new Set(tabs.filter(tab => allowed.has(tab.tabId)).flatMap(tab => { try { return [new URL(tab.url).origin]; } catch { return []; } }));
    value.exemptOrigins = value.exemptOrigins.filter(origin => origins.has(origin));
  }
  if (Object.hasOwn(value, 'activeTab')) { const active = agentActiveTab(status, tabs, owner); value.activeTab = active && allowed.has(active.tabId) ? active.tabId : null; }
  if (Array.isArray(value.folders) && owner) value.folders = value.folders.filter(folder => browserOwnsFolder(folder, owner));
  delete value.ownerActiveTabs;
  delete value.diagnostics; delete value.protection;
  if (value.browsers) {
    const relay = { ...value.browsers.relay };
    delete relay.diagnostics; delete relay.protection;
    delete relay.ownerActiveTabs;
    if (Array.isArray(relay.folders) && owner) relay.folders = relay.folders.filter(folder => browserOwnsFolder(folder, owner));
    if (Array.isArray(relay.tabs)) relay.tabs = relay.tabs.filter(belongs);
    if (Array.isArray(relay.downloads)) relay.downloads = relay.downloads.filter(item => browserDownloadVisible(item, tabs, owner));
    if (relay.activeTab != null && !allowed.has(relay.activeTab)) relay.activeTab = null;
    value.browsers = { relay };
  }
  return value;
}

/** Captured by the host when a download starts, independently of tab lifetime. */
export function browserDownloadProvenance(tab) {
  const tabId = tab?.tabId || tab?.id;
  if (typeof tabId !== 'string' || !tabId) return null;
  return { version: 1, tabId, purpose: tab.purpose === 'chat-mode' ? 'chat-mode' : null, owner: browserOwner(tab.owner) };
}

function browserDownloadVisible(item, tabs, owner) {
  if (!containedTab(item)) return false;
  const source = tabs.find(tab => tab.tabId === item.tabId);
  if (source && (source.purpose === 'chat-mode' || !ownsTab(source, owner))) return false;
  // Older live records can still be attributed through their source. New
  // records retain the original identity even if that tab is later repurposed.
  if (!Object.hasOwn(item, 'provenance')) return Boolean(source);
  const provenance = item.provenance;
  if (provenance?.version !== 1 || provenance.tabId !== item.tabId || provenance.purpose !== null || !Object.hasOwn(provenance, 'owner')) return false;
  try { return ownsTab({ owner: browserOwner(provenance.owner) }, owner); } catch { return false; }
}
