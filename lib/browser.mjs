import {validateTabMark,tabMarkChange,assertTabNotInUse} from './browser-in-use.mjs';
import { createBrowserRecoveryBinding, assertBrowserRecoveryBinding } from './browser-recovery-binding.mjs';
import { normalizeOperationalReceiptBinding } from './operational-receipts.mjs';
import {receiptBindingsForCriterion} from '../public/planning-contract-model.mjs';
import { EventEmitter } from 'node:events';
import { describeHostOperation, normalizeHostOperationResult, browserReceiptBindingKey } from './operation-descriptors.mjs';
import { ownershipAction, ownershipChange } from './browser-ownership.mjs';
import { sameBrowserOwner, conversationBrowserNode, browserConversationStatus } from './browser-conversations.mjs';
import { browserCleanupScope, scopedBrowserTabs, browserCleanupPreview, browserCleanupSelection } from './browser-scoped-cleanup.mjs';
import { normalizeBrowserAddress } from '../public/browser-address.mjs';
import { providerKeyTarget } from './provider-key-contract.mjs';
import { BROWSER_VERIFICATION_GUIDANCE } from './browser-signin.mjs';
import { applicationHistoryTarget, inspectApplicationHistory } from './application-history.mjs';

export const BROWSER_ACTIONS = ['tab_mark','collection_create','collection_rename','collection_move','collection_remove','tab_collect','take_ownership', 'transfer_ownership', 'diagnostics', 'debug_reset', 'stop', 'tabs', 'password_manager', 'open', 'navigate', 'snapshot', 'read', 'click', 'hover', 'fill', 'type', 'select', 'press', 'scroll', 'wait', 'screenshot', 'upload', 'interaction', 'downloads', 'back', 'forward', 'reload', 'close', 'folder_create', 'folder_rename', 'folder_close', 'tab_move', 'tab_select', 'suspend', 'protection'];
const fail = (message, code = 'BROWSER_ERROR') => Object.assign(new Error(message), { code });
const aborted = () => Object.assign(fail('Browser action cancelled. Inspect the page before repeating an action.', 'ABORT_ERR'), { name: 'AbortError' });
const recovery = () => fail('An earlier browser action has not stopped. Wait for it to finish, or close Relay and check the page before retrying. Repeating it could duplicate the action.', 'BROWSER_RECOVERY_REQUIRED');
function bounded(work, timeoutMs, timeoutError) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError()), timeoutMs); });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
export function browserURL(value) {
  try { return normalizeBrowserAddress(value); }
  catch (cause) { throw fail(cause.message, 'BROWSER_VALIDATION'); }
}

export function validateBrowserPreview(args, source) {
  if (args.preview === undefined) return false;
  if (args.preview !== true || source !== 'user' || args.action !== 'screenshot' || args.browser !== 'relay' || typeof args.tabId !== 'string' || !args.tabId || args.tabId.length > 200 || args.tabId.startsWith('firefox:') || typeof args.expectedDocumentId !== 'string' || !args.expectedDocumentId || args.expectedDocumentId.length > 200 || typeof args.expectedUrl !== 'string' || !args.expectedUrl || args.expectedUrl.length > 20000 || Object.keys(args).some(key => !['action', 'browser', 'tabId', 'expectedUrl', 'expectedDocumentId', 'preview'].includes(key))) throw Object.assign(fail('Preview capture requires the local human view and its exact observed contained document.', 'BROWSER_VALIDATION'), { actionDispatched: false });
  browserURL(args.expectedUrl); return true;
}

export const browserWheelScroll = args => args?.action === 'scroll' && ['x', 'y', 'deltaX', 'deltaY'].some(key => Object.hasOwn(args, key));
export function validateBrowserWheelScroll(args) {
  const invalid = message => { throw Object.assign(fail(message, 'BROWSER_VALIDATION'), { actionDispatched: false, stage: 'validation' }); };
  if (args.ref !== undefined || args.direction !== undefined || args.amount !== undefined || ![args.x, args.y, args.deltaX, args.deltaY].every(Number.isFinite) || args.x < 0 || args.y < 0 || !args.deltaX && !args.deltaY || args.browser !== 'relay' || typeof args.tabId !== 'string' || !args.tabId || args.tabId.length > 200 || args.tabId.startsWith('firefox:')) invalid('Scroll the observed contained page with its pointer position and finite horizontal and vertical pixel deltas.');
  if (typeof args.expectedDocumentId !== 'string' || !args.expectedDocumentId || args.expectedDocumentId.length > 200 || typeof args.expectedUrl !== 'string' || !args.expectedUrl || args.expectedUrl.length > 20000) invalid('Wheel input requires the current observed document identity and URL.');
  try { browserURL(args.expectedUrl); } catch (error) { invalid(error.message); }
}

export function validateBrowserUploadRequest(args) {
  const invalid = message => Object.assign(fail(message, 'BROWSER_VALIDATION'), { actionDispatched: false });
  if (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > 10) throw invalid('Supply 1–10 absolute local file paths.');
  const targets = [args.ref, args.chooserId].filter(value => value !== undefined);
  if (targets.length !== 1 || typeof targets[0] !== 'string' || !targets[0].trim()) throw invalid('Choose exactly one observed file input ref or pending chooser ID.');
}

export function validateBrowserFillRequest(args) {
  if (typeof args.text !== 'string' || args.value !== undefined) throw Object.assign(fail('Fill requires an explicit text string and does not accept value. Use text:"" to intentionally clear a field; value is only for select.', 'BROWSER_VALIDATION'), { actionDispatched: false, inputDispatched: false, stage: 'validation' });
  return args.text;
}

// Only the host may bind this context. Tool JSON never grants ownership.
export function browserOwner(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['taskId', 'runId', 'nodeId', 'label', 'allowUserTabs', 'conversationId'].includes(key))) throw fail('Invalid host browser ownership context.', 'BROWSER_OWNER_INVALID');
  for (const key of ['taskId', 'runId', 'nodeId']) if (typeof value[key] !== 'string' || !value[key] || value[key].length > 200 || /[\u0000-\u001f\u007f]/.test(value[key])) throw fail('Invalid host browser ownership context.', 'BROWSER_OWNER_INVALID');
  if (value.conversationId !== undefined && value.conversationId !== value.taskId) throw fail('Invalid host conversation ownership context.', 'BROWSER_OWNER_INVALID');
  if (value.label !== undefined && (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 200 || /[\u0000-\u001f\u007f]/.test(value.label))) throw fail('Invalid browser task folder name.', 'BROWSER_OWNER_INVALID');
  if (value.allowUserTabs !== undefined && typeof value.allowUserTabs !== 'boolean') throw fail('Invalid host browser ownership context.', 'BROWSER_OWNER_INVALID');
  return { taskId: value.taskId, runId: value.runId, nodeId: value.nodeId, ...(value.conversationId ? { conversationId: value.conversationId } : {}), ...(value.label ? { label: value.label.trim() } : {}), ...(value.allowUserTabs === true ? { allowUserTabs: true } : {}) };
}
export const browserOwnerKey = owner => owner ? `${owner.taskId}\u0000${owner.nodeId}` : null;
const ownsTab = (tab, owner) => !owner || (tab?.owner ? sameBrowserOwner(tab.owner, owner) : owner.allowUserTabs === true);
const ownershipError = () => Object.assign(fail('This tab belongs to another task or to the person. Open a page in this task’s browser folder.', 'BROWSER_TAB_OWNERSHIP'), { status: 409, actionDispatched: false });

export function browserCredentialTarget(value) {
  const fields = ['browser', 'tabId', 'credentialId', 'revision', 'origin', 'expectedUrl', 'expectedDocumentId', 'passwordRef', 'confirmationRef', 'usernameRef'];
  const invalid = () => fail('Choose a saved credential and fresh password-field refs on its exact HTTPS page.', 'BROWSER_CREDENTIAL_VALIDATION');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)) || value.browser !== 'relay' || !Number.isSafeInteger(value.revision) || value.revision < 1) throw invalid();
  for (const [key, limit] of [['tabId', 200], ['credentialId', 200], ['origin', 2000], ['expectedUrl', 20000], ['expectedDocumentId', 200], ['passwordRef', 500], ['confirmationRef', 500], ['usernameRef', 500]]) {
    if (['confirmationRef', 'usernameRef'].includes(key) && value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || !value[key] || value[key].length > limit || /[\u0000-\u001f\u007f]/.test(value[key])) throw invalid();
  }
  let origin, page;
  try { origin = new URL(value.origin); page = new URL(value.expectedUrl); } catch { throw invalid(); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || value.origin !== origin.origin || page.protocol !== 'https:' || page.username || page.password || page.origin !== origin.origin) throw invalid();
  const refs = [value.passwordRef, value.confirmationRef, value.usernameRef].filter(Boolean);
  if (new Set(refs).size !== refs.length) throw invalid();
  return { ...value };
}

const reservedTabError = () => Object.assign(fail('This ChatGPT tab belongs to the person calling BLACKICE. Choose an ordinary contained browser tab for tool work.', 'BROWSER_HUMAN_CHAT_RESERVED'), { status: 409, actionDispatched: false });
const unverifiedTabs = () => Object.assign(fail('Current browser tab ownership is unavailable. Inspect the contained browser before acting.', 'BROWSER_TAB_STATE_UNAVAILABLE'), { status: 409, actionDispatched: false });
const containedTab = tab => (!tab?.browser || tab.browser === 'relay') && typeof tab?.tabId === 'string' && !tab.tabId.startsWith('firefox:');
function agentTabs(status) {
  if (!Array.isArray(status?.tabs)) throw unverifiedTabs();
  return status.tabs.filter(containedTab);
}
function taskBrowserCapacity(status, owner) {
  const limit = (status?.browsers?.relay?.capacity || status?.capacity)?.perTaskLive;
  if (!owner || !Number.isSafeInteger(limit) || limit < 1 || limit > 1024 || !Array.isArray(status?.tabs)) return null;
  // The budget is shared across this task's workers; page visibility is not.
  const tabs = status.tabs.filter(tab => containedTab(tab) && tab.purpose !== 'chat-mode' && tab.owner?.taskId === owner.taskId);
  if (tabs.some(tab => typeof tab.suspended !== 'boolean')) return null;
  const live = tabs.filter(tab => !tab.suspended).length;
  if (live > 1024) return null;
  return { live, limit, remaining: Math.max(0, limit - live) };
}

function agentActiveTab(status, tabs, owner) {
  if (owner) {
    const sharedKey = browserOwnerKey({ ...owner, nodeId: conversationBrowserNode });
    const selection = status?.ownerActiveTabs?.[browserOwnerKey(owner)] ?? status?.browsers?.relay?.ownerActiveTabs?.[browserOwnerKey(owner)]
      ?? status?.ownerActiveTabs?.[sharedKey] ?? status?.browsers?.relay?.ownerActiveTabs?.[sharedKey];
    return tabs.find(tab => tab.tabId === selection && ownsTab(tab, owner)) || null;
  }
  const relay = status?.browsers?.relay;
  // The router's global selection may be a manually selected external tab.
  // Use the contained driver's verified selection, never the first visible tab.
  const id = relay && Object.hasOwn(relay, 'activeTab') ? relay.activeTab : status?.activeTab;
  return tabs.find(tab => tab.tabId === id) || null;
}

/** Resolve a tool target from trusted adapter metadata, never caller-supplied purpose. */
export function agentBrowserRequest(args, status, context, destinationOwner = null) {
  const owner = browserOwner(context);
  if (Object.hasOwn(args, 'source') || Object.hasOwn(args, 'purpose') || Object.hasOwn(args, 'owner')) throw Object.assign(fail('Browser source, ownership and tab purpose belong to the host, not tool arguments.', 'BROWSER_VALIDATION'), { actionDispatched: false });
  if (args.browser !== undefined && args.browser !== 'relay' || String(args.tabId || '').startsWith('firefox:')) throw Object.assign(fail('External browser interaction is unavailable to task agents. Use the contained relay browser in Observe.', 'BROWSER_CONTAINED_ONLY'), { actionDispatched: false });
  const tabs = agentTabs(status);
  if (args.tabId != null && (typeof args.tabId !== 'string' || !args.tabId)) throw Object.assign(fail('Choose an observed browser tab ID.', 'BROWSER_VALIDATION'), { actionDispatched: false });
  const explicit = args.tabId != null ? tabs.find(tab => tab.tabId === args.tabId) : null;
  if (explicit?.purpose === 'chat-mode') throw reservedTabError();
  if (ownershipAction(args.action)) { ownershipChange(args, status, owner, 'agent', destinationOwner); return { ...args, browser: 'relay' }; }
  if(args.action==='tab_mark'){tabMarkChange(args,explicit,{source:'agent',owner});return {...args,browser:'relay'};}
  if(args.action==='close'&&explicit)assertTabNotInUse(explicit);
  if (explicit && !ownsTab(explicit, owner)) throw ownershipError();
  if (args.action !== 'open' && args.tabId != null && !explicit) throw Object.assign(fail('The selected browser tab is no longer available. Inspect the current tabs before acting.', 'BROWSER_TAB_NOT_FOUND'), { actionDispatched: false });
  const folderForAction = id => {
    const folder = status?.folders?.find(value => value.id === id);
    if (!folder) throw Object.assign(fail('Choose an observed browser folder.', 'BROWSER_FOLDER_NOT_FOUND'), { actionDispatched: false });
    if (owner && !(folder.kind === 'task' && folder.taskId === owner.taskId || owner.allowUserTabs && folder.kind === 'user')) throw ownershipError();
    return folder;
  };
  if (args.action.startsWith('collection_')) return { ...args, browser: 'relay' };
  if (args.action === 'folder_create') return { ...args, browser: 'relay' };
  if (['folder_rename', 'folder_close'].includes(args.action)) {
    const folder = folderForAction(args.folderId);
    if (args.action === 'folder_close') for (const tab of tabs.filter(value => value.folderId === folder.id)) {
      if (tab.purpose === 'chat-mode') throw reservedTabError();
      if (!ownsTab(tab, owner)) throw ownershipError();
      assertTabNotInUse(tab);
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
    if (owner && args.folderId != null && !status?.folders?.some(folder => folder.id === args.folderId && folder.kind === 'task' && folder.taskId === owner.taskId)) throw ownershipError();
    return { ...args, browser: 'relay' };
  }
  if (['tabs', 'downloads'].includes(args.action)) return { ...args, browser: 'relay' };
  const target = explicit || agentActiveTab(status, tabs, owner);
  if (!target) throw Object.assign(fail('Choose an ordinary contained browser tab, or open a URL first.', 'BROWSER_TAB_NOT_FOUND'), { actionDispatched: false });
  if (target.purpose === 'chat-mode') throw reservedTabError();
  if(args.action==='close')assertTabNotInUse(target);
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

const protectedOrigin = value => { try { return new URL(value).origin + '/'; } catch { return ''; } };
function protectedBrowserMetadata(value) {
  const interaction = value.pendingInteraction;
  return { ...Object.fromEntries(['tabId', 'browser', 'folderId', 'parentTabId', 'owner', 'documentId', 'contained', 'canShow', 'suspended', 'loading', 'canGoBack', 'canGoForward', 'visible', 'interactionSettling'].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])),
    url: protectedOrigin(value.url), title: 'Provider API key setup', protectedContent: true,
    ...(interaction ? { pendingInteraction: Object.fromEntries(['id', 'tabId', 'documentId', 'kind', 'status'].filter(key => Object.hasOwn(interaction, key)).map(key => [key, interaction[key]])) } : {}) };
}

/** Agent receipts omit the human calling tab and session-wide diagnostics. */
function agentBrowserResult(result, status, context, action, includeOwnershipCandidates = false) {
  const owner = browserOwner(context), tabs = agentTabs(status), allowed = new Set(tabs.filter(tab => tab.purpose !== 'chat-mode' && ownsTab(tab, owner)).map(tab => tab.tabId));
  // A successful transfer intentionally removes the tab from this agent's allowed set.
  // Confirm the exact persisted destination and return only the effect receipt,
  // never the newly unowned tab's page content or unrelated browser inventory.
  const receipt = result?.ownershipReceipt;
  const transferred = action === 'transfer_ownership' && receipt?.action === 'transfer_ownership' && owner
    && sameBrowserOwner(receipt.previousOwner, owner) && (receipt.previousOwner?.runId === owner.runId || receipt.previousOwner?.nodeId === conversationBrowserNode || owner.nodeId === conversationBrowserNode)
    && tabs.some(tab => tab.tabId === receipt.tabId && tab.purpose !== 'chat-mode' && !tab.protectedContent
      && tab.documentId === receipt.documentId && tab.url === receipt.url && tab.folderId === receipt.folderId
      && (receipt.owner === null ? !tab.owner
        : !!tab.owner && tab.owner.taskId === receipt.owner?.taskId && tab.owner.nodeId === receipt.owner?.nodeId && tab.owner.runId === receipt.owner?.runId));
  if (transferred) return { transferred: true, tabId: receipt.tabId, documentId: receipt.documentId,
    url: receipt.url, folderId: receipt.folderId, ownershipReceipt: receipt };
  const protectedIds = new Set(tabs.filter(tab => tab.protectedContent === true).map(tab => tab.tabId));
  const value = protectedIds.has(result?.tabId) ? { ...protectedBrowserMetadata(result), frames: [], ...(typeof result.actionDispatched === 'boolean' ? { actionDispatched: result.actionDispatched } : {}) } : { ...result };
  if (value.purpose === 'chat-mode' || value.tabId != null && !allowed.has(value.tabId) || value.pendingInteraction?.tabId != null && !allowed.has(value.pendingInteraction.tabId)) throw Object.assign(fail('The browser result no longer belongs to an ordinary tool tab. Inspect the current tabs before continuing.', 'BROWSER_RESULT_TAB_CHANGED'), { status: 409 });
  const belongs = item => containedTab(item) && item.purpose !== 'chat-mode' && allowed.has(item.tabId);
  const safeTab = tab => protectedIds.has(tab.tabId) ? protectedBrowserMetadata(tab) : tab;
  if (Array.isArray(value.tabs)) {
    value.tabs = value.tabs.filter(belongs).map(safeTab);
    if (action === 'tabs' && includeOwnershipCandidates)
      value.ownershipCandidates = tabs.filter(t => t.purpose !== 'chat-mode' && !t.protectedContent && !allowed.has(t.tabId) && t.owner && t.adoption?.eligible === true)
        .map(t => ({ tabId: t.tabId, url: t.url, documentId: t.documentId, folderId: t.folderId, ownerKey: JSON.stringify([t.owner.taskId,t.owner.nodeId,t.owner.runId]), adoption: t.adoption }));
    else delete value.ownershipCandidates;
  }
  // Unattributed and closed-tab downloads cannot prove an eligible page owner.
  if (Array.isArray(value.downloads)) value.downloads = value.downloads.filter(belongs);
  if (Array.isArray(value.exemptOrigins)) {
    const origins = new Set(tabs.filter(tab => allowed.has(tab.tabId)).flatMap(tab => { try { return [new URL(tab.url).origin]; } catch { return []; } }));
    value.exemptOrigins = value.exemptOrigins.filter(origin => origins.has(origin));
  }
  if (Object.hasOwn(value, 'activeTab')) { const active = agentActiveTab(status, tabs, owner); value.activeTab = active && allowed.has(active.tabId) ? active.tabId : null; }
  if (Array.isArray(value.folders) && owner) value.folders = value.folders.filter(folder => folder.taskId === owner.taskId || owner.allowUserTabs && folder.kind === 'user');
  delete value.ownerActiveTabs;
  delete value.diagnostics; delete value.protection;
  if (value.browsers) {
    const relay = { ...value.browsers.relay };
    delete relay.diagnostics; delete relay.protection;
    delete relay.ownerActiveTabs;
    if (Array.isArray(relay.folders) && owner) relay.folders = relay.folders.filter(folder => folder.taskId === owner.taskId || owner.allowUserTabs && folder.kind === 'user');
    if (Array.isArray(relay.tabs)) relay.tabs = relay.tabs.filter(belongs).map(safeTab);
    if (Array.isArray(relay.downloads)) relay.downloads = relay.downloads.filter(belongs);
    if (relay.activeTab != null && !allowed.has(relay.activeTab)) relay.activeTab = null;
    value.browsers = { relay };
  }
  return value;
}

/** Serialized browser adapters. No operation dispatches operating-system input. */
export class BrowserWorkspace extends EventEmitter {
  constructor({ driver, timeoutMs = 30000, shutdownTimeoutMs = 15000 } = {}) {
    super(); this.driver = driver; this.timeoutMs = timeoutMs; this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.pending = new Set(); this.queue = []; this.active = null; this.quarantine = null; this.closed = false;
    this.driverListener = () => this.emit('status', this.status()); driver?.on?.('changed', this.driverListener);
  }
  setActiveOwnerResolver(resolve) { this.driver?.setActiveOwnerResolver?.(resolve); }
  setStoppedOwnerResolver(resolve, verifyEffects) { this.driver?.setStoppedOwnerResolver?.(resolve, verifyEffects); }
  setPasswordManager(vault) { this.driver?.setPasswordManager?.({ vault, browser: this }); }
  setConversationArchive(conversations) {
    this.conversations = conversations;
    this.driver?.setOwnerAdmission?.(owner => this.assertConversationOpen(owner));
  }
  assertConversationOpen(owner) {
    if (!owner || !this.conversations) return;
    const status = browserConversationStatus({ tabs: [{ owner }] }, this.conversations);
    const id = status.tabs[0]?.conversationId;
    const state = id && this.conversations.list('all').find(item => (item.rootId || item.taskId || item.id) === id)?.state;
    if (state === 'archived' || state === 'deleted') throw Object.assign(fail('Restore this conversation before opening or moving browser tabs into it.', 'BROWSER_CONVERSATION_RETIRED'), { status: 409, actionDispatched: false });
  }
  status() {
    const metadata = this.driver?.status?.() || {};
    return { background: true, physicalInput: false, persistentSession: !!this.driver, actions: BROWSER_ACTIONS, ...metadata,
      available: !!this.driver && metadata.available !== false && !this.closed,
      lifecycle: this.closing ? 'closing' : this.closed ? 'closed' : this.disconnecting ? 'disconnecting' : this.quarantine ? 'recovering' : 'ready',
      acceptingActions: !!this.driver && !this.closed && !this.disconnecting && !this.quarantine,
      busy: !!this.active,
      ...(this.quarantine || this.shutdownError || this.disconnectError ? { recovery: { required: true, message: this.shutdownError?.message || this.disconnectError?.message || recovery().message } } : {}),
    };
  }
  async observeOperation(args, { signal, owner, receiptBindings, expectedDocumentId, expectedUrl, recoveryInspection = false } = {}) {
    this.assertAdmission();
    if (signal?.aborted) throw aborted();
    const target = agentBrowserRequest(args, this.status(), browserOwner(owner));
    if (typeof this.driver?.observeOperation !== 'function') return this.status();
    const observed = await this.driver.observeOperation(target, { signal, owner, receiptBindings, expectedDocumentId, expectedUrl, recoveryInspection });
    if (signal?.aborted) throw aborted();
    // Read-only inspection does not transfer ownership or start/resume a tab.
    agentBrowserRequest(target, this.status(), browserOwner(owner));
    return observed;
  }
  assertAdmission() {
    if (this.closed || !this.driver) throw fail('The browser workspace is available in the Relay desktop app. Open Relay.exe to use it.', 'BROWSER_UNAVAILABLE');
    if (this.disconnecting) throw fail('Firefox is disconnecting. Wait for shutdown to finish before starting another browser action.', 'BROWSER_DISCONNECTING');
    if (this.quarantine) throw recovery();
  }
  async perform(args, { signal, source = 'agent', owner: context, destinationOwner: destinationContext, validateUploadPath, beforeDispatch, operationDescriptor, operationId, recoveryInput, settleRecoveryRead = false, onClickPopup } = {}) {
    const dispatchState = { dispatched: false };
    try {
    const owner = browserOwner(context), destinationOwner = browserOwner(destinationContext);
    this.assertAdmission();
    if (args?.action === 'reuse_session') throw fail('Session transfer was removed because it can invalidate the source sign-in. Connect directly to the existing browser instead.', 'BROWSER_VALIDATION');
    if (!args || !BROWSER_ACTIONS.includes(args.action)) throw fail('Choose a supported browser action.', 'BROWSER_VALIDATION');
    if (args.action === 'fill') validateBrowserFillRequest(args);
    if(args.action==='tab_mark')validateTabMark(args);
    if (['diagnostics', 'debug_reset', 'stop'].includes(args.action)) {
      const fields = args.action === 'diagnostics' ? ['action', 'browser', 'tabId', 'after', 'limit'] : ['action', 'browser', 'tabId', 'expectedUrl', 'expectedDocumentId'];
      if (!args.tabId || Object.keys(args).some(key => !fields.includes(key)) || args.after !== undefined && (!Number.isSafeInteger(args.after) || args.after < 0) || args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 256)) throw fail('Use an exact tab and supported diagnostic cursor/control fields.', 'BROWSER_VALIDATION');
      if (args.action !== 'diagnostics' && (!args.expectedUrl || !args.expectedDocumentId)) throw fail('Debug controls require the exact observed URL and document identity.', 'BROWSER_VALIDATION');
    }
    if (args.action === 'tab_select' && (Object.keys(args).some(key => !['action', 'browser', 'tabId'].includes(key)) || typeof args.tabId !== 'string' || !args.tabId || args.tabId.length > 200)) throw fail('Select one observed browser tab by its tab ID.', 'BROWSER_VALIDATION');
    if (args.action === 'protection') {
      if (source !== 'user') args = agentBrowserRequest(args, this.status(), owner);
      if (Object.keys(args).some(key => !['action', 'browser', 'operation', 'tabId', 'origin', 'enabled'].includes(key)) || args.browser !== undefined && args.browser !== 'relay' || !['status', 'global', 'site', 'refresh'].includes(args.operation || 'status')) throw fail('Choose a supported browser filtering operation.', 'BROWSER_VALIDATION');
      const { action: _action, browser: _browser, operation = 'status', ...options } = args;
      if (operation === 'status' && Object.keys(options).length || ['refresh', 'global'].includes(operation) && args.tabId !== undefined) throw fail('Choose only the fields needed for this browser filtering operation.', 'BROWSER_VALIDATION');
      dispatchState.dispatched = true;
      return await this.configureProtection({ action: operation, ...options }, { signal, source, owner, beforeDispatch });
    }
    if (args.action === 'interaction') {
      if (Object.keys(args).some(key => !['action', 'browser', 'tabId', 'interactionId', 'expectedUrl', 'expectedDocumentId', 'decision', 'promptText'].includes(key)) || args.browser !== 'relay' || typeof args.tabId !== 'string' || !args.tabId || typeof args.interactionId !== 'string' || !/^browser_input_[a-f0-9-]{36}$/.test(args.interactionId) || !['accept', 'dismiss', 'acknowledge'].includes(args.decision) || args.promptText !== undefined && (typeof args.promptText !== 'string' || args.promptText.length > 4096) || !args.expectedDocumentId || !args.expectedUrl) throw fail('Use the exact observed dialog, page and decision.', 'BROWSER_VALIDATION');
    }
    if (args.action === 'upload') validateBrowserUploadRequest(args);
    if (args.chooserId !== undefined && (args.action !== 'upload' || args.browser !== 'relay' || typeof args.tabId !== 'string' || !args.tabId || typeof args.chooserId !== 'string' || !/^browser_input_[a-f0-9-]{36}$/.test(args.chooserId) || !args.expectedDocumentId || !args.expectedUrl)) throw Object.assign(fail('Use a pending contained file chooser with its exact document and URL.', 'BROWSER_VALIDATION'), { actionDispatched: false });
    if (['open', 'navigate'].includes(args.action)) args = { ...args, url: browserURL(args.url) };
    // Navigation targets a tab and a new URL, never a control in the old DOM.
    // Models may carry observation metadata forward; it is not a navigation prerequisite.
    // Waiting observes the current tab over time; stale page metadata must not
    // prevent that read or pretend the eventual observation belongs to an old DOM.
    if (['navigate', 'wait'].includes(args.action)) { args = { ...args }; delete args.expectedDocumentId; delete args.expectedUrl; }
    const preview = validateBrowserPreview(args, source);
    const wheel = browserWheelScroll(args);
    if (wheel) validateBrowserWheelScroll(args);
    const coordinatePointer = ['click', 'hover'].includes(args.action) && !args.ref;
    if (coordinatePointer && (!Number.isFinite(args.x) || !Number.isFinite(args.y) || !args.expectedDocumentId || !args.expectedUrl)) throw fail('Coordinate input requires a freshly observed document identity and URL.', 'BROWSER_VALIDATION');
    if (typeof args.text === 'string' && args.text.length > 50000) throw fail('Text is too long.', 'BROWSER_VALIDATION');
    if (args.action === 'type' && (typeof args.text !== 'string' || !args.text.length || args.text.length > 16384 || typeof args.tabId !== 'string' || !args.tabId || args.browser !== 'relay')) throw fail('Type 1–16384 characters into an explicitly selected contained browser tab.', 'BROWSER_VALIDATION');
    if (args.action === 'type' || args.expectedDocumentId !== undefined || args.expectedUrl !== undefined) {
      if (!['type', 'press', 'click', 'hover', 'fill', 'select', 'upload', 'interaction', 'take_ownership', 'transfer_ownership', 'debug_reset', 'stop', ...(wheel ? ['scroll'] : []), ...(preview ? ['screenshot'] : [])].includes(args.action)) throw fail(`The ${args.action} action does not accept expectedDocumentId or expectedUrl. Omit both fields for this action.`, 'BROWSER_VALIDATION');
      if (typeof args.expectedDocumentId !== 'string' || !args.expectedDocumentId || args.expectedDocumentId.length > 200 || typeof args.expectedUrl !== 'string' || !args.expectedUrl || args.expectedUrl.length > 20000) throw fail('Page input requires the current observed document identity and URL.', 'BROWSER_VALIDATION');
      browserURL(args.expectedUrl);
    }
    if (args.modifiers !== undefined && (args.action !== 'press' || !Array.isArray(args.modifiers) || args.modifiers.length > 4 || new Set(args.modifiers).size !== args.modifiers.length || args.modifiers.some(item => !['Alt', 'Control', 'Meta', 'Shift'].includes(item)))) throw fail('Use supported modifiers with a page key.', 'BROWSER_VALIDATION');
    const agent = source !== 'user';
    if (agent) args = agentBrowserRequest(args, this.status(), owner, destinationOwner);
    const bindUploadRef = agent && args.action === 'upload' && args.expectedDocumentId === undefined && args.expectedUrl === undefined;
    if (bindUploadRef && typeof this.driver.bindObservedUploadRef !== 'function') throw fail('Upload requires the current observed document identity and URL.', 'BROWSER_VALIDATION');
    if (agent && args.action === 'interaction' && args.promptText !== undefined && args.decision !== 'accept') throw fail('Prompt text is only valid when accepting an observed prompt.', 'BROWSER_VALIDATION');
    return await this.enqueue(async activeSignal => {
      // Host-owned admission checks belong inside this queue. A permitted action
      // can wait behind earlier page work while its grant or file paths change.
      if (agent) args = agentBrowserRequest(args, this.status(), owner, destinationOwner);
      if (beforeDispatch) try { await beforeDispatch({ signal: activeSignal, action: args.action, tabId: args.tabId }); }
      catch (error) { throw Object.assign(error, { actionDispatched: false }); }
      if (activeSignal.aborted) throw Object.assign(aborted(), { actionDispatched: false });
      if (agent) args = agentBrowserRequest(args, this.status(), owner, destinationOwner);
      if (bindUploadRef) args = { ...args, ...this.driver.bindObservedUploadRef(args) };
      // Check at dispatch, not only at admission: this operation may have waited
      // behind the Archive/Trash cleanup in the serialized browser queue.
      if (args.action === 'open') this.assertConversationOpen(owner);
      if (destinationOwner) this.assertConversationOpen(destinationOwner);
      if (settleRecoveryRead && args.action === 'snapshot') {
        const current = this.status().tabs?.find(tab => tab.tabId === args.tabId);
        if (!current || current.suspended || current.dormant || current.crashed) throw fail('Automatic recovery cannot restore an inactive tab.', 'BROWSER_RECOVERY_TAB_INACTIVE');
      }
      dispatchState.dispatched = true;
      const result = await this.driver.perform(args, { signal: activeSignal, source, ...(owner ? { owner } : {}), ...(destinationOwner ? { destinationOwner } : {}), ...(validateUploadPath ? { validateUploadPath } : {}), ...(operationDescriptor ? { operationDescriptor } : {}), ...(operationId ? { operationId } : {}), ...(recoveryInput ? { recoveryInput } : {}), ...(settleRecoveryRead && args.action === 'snapshot' ? { settleRecoveryRead: true } : {}), ...(onClickPopup && args.action === 'click' ? { onClickPopup } : {}) });
      return agent ? agentBrowserResult(result, this.status(), owner, args.action, args.action === 'tabs' && args.query === 'stopped-task-recovery') : result;
    }, { signal, action: args.action, tabId: args.tabId, source, dispatchState });
    } catch (error) {
      // Only this boundary proves that neither the driver nor another effectful
      // route was called. Error names alone cannot establish non-dispatch.
      if (!dispatchState.dispatched && error && typeof error === 'object') error.actionDispatched = false;
      throw error;
    }
  }
  async fillCredential(value, { vault, signal, source = 'agent', owner: context, beforeDispatch } = {}) {
    const owner = browserOwner(context);
    this.assertAdmission();
    const args = browserCredentialTarget(value);
    if (source !== 'agent' || typeof vault?.withSecret !== 'function' || typeof this.driver.prepareCredentialFill !== 'function') throw fail('Protected credential filling is unavailable in this browser.', 'BROWSER_CREDENTIAL_UNAVAILABLE');
    const guard = async activeSignal => {
      agentBrowserRequest({ action: 'fill', browser: 'relay', tabId: args.tabId }, this.status(), owner);
      if (beforeDispatch) await beforeDispatch({ signal: activeSignal, action: 'fillCredential', tabId: args.tabId });
      if (activeSignal?.aborted) throw aborted();
      const status = this.status(), target = agentBrowserRequest({ action: 'fill', browser: 'relay', tabId: args.tabId }, status, owner);
      const tab = status.tabs.find(tab => tab.tabId === target.tabId);
      if (tab.url !== args.expectedUrl) throw fail('The credential page changed. Inspect it again before filling.', 'BROWSER_CREDENTIAL_TARGET_CHANGED');
    };
    agentBrowserRequest({ action: 'fill', browser: 'relay', tabId: args.tabId }, this.status(), owner);
    return this.enqueue(async activeSignal => {
      await guard(activeSignal);
      // Inspect actual field types and origin before opening the encrypted
      // vault. The host-only closure repeats those checks before any write.
      let commit;
      try { commit = await this.driver.prepareCredentialFill(args, { signal: activeSignal, source: 'agent', ...(owner ? { owner } : {}) }); }
      catch { throw fail('The credential target could not be verified. Take a fresh snapshot of the password fields.', 'BROWSER_CREDENTIAL_TARGET_CHANGED'); }
      if (typeof commit !== 'function') throw fail('Protected credential filling is unavailable in this browser.', 'BROWSER_CREDENTIAL_UNAVAILABLE');
      return (vault.withLoginSecret || vault.withSecret).call(vault, { credentialId: args.credentialId, revision: args.revision, origin: args.origin }, async secret => {
        await guard(activeSignal);
        try {
          const result = await commit(secret);
          if (activeSignal.aborted) throw aborted();
          agentBrowserRequest({ action: 'fill', browser: 'relay', tabId: args.tabId }, this.status(), owner);
          if (result?.filled !== true) throw new Error('No verified credential receipt.');
          return { credentialId: args.credentialId, revision: args.revision, origin: args.origin, tabId: args.tabId, documentId: args.expectedDocumentId, filled: true, passwordFilled: true, confirmationFilled: Boolean(args.confirmationRef), usernameFilled: Boolean(args.usernameRef), submissionRequested: false };
        } catch { throw fail('Credential filling could not be confirmed. Inspect the current page before trying again; no submission was requested.', 'BROWSER_CREDENTIAL_FILL_UNCONFIRMED'); }
      }, { signal: activeSignal });
    }, { signal, action: 'fillCredential', tabId: args.tabId, source: 'agent' });
  }
  async authenticateCredential(value, { vault, signal, source = 'agent', owner: context, ownerId, beforeDispatch } = {}) {
    this.assertAdmission();
    const owner = browserOwner(context), { intent, submitRef, requestId, ...fill } = value;
    const target = browserCredentialTarget(fill), args = { ...target, intent, submitRef, requestId };
    if (source !== 'agent' || typeof beforeDispatch !== 'function' || typeof vault?.authenticateOnce !== 'function'
      || typeof this.driver.prepareCredentialAuthentication !== 'function' || !['login','signup'].includes(intent)
      || typeof submitRef !== 'string' || !submitRef || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId))
      throw fail('Scoped authentication is unavailable.', 'BROWSER_CREDENTIAL_AUTH_AUTHORITY');
    const guard = async activeSignal => {
      agentBrowserRequest({ action:'fill', browser:'relay', tabId:args.tabId }, this.status(), owner);
      await beforeDispatch({ signal:activeSignal, action:'authenticate', intent, origin:args.origin, credentialId:args.credentialId, revision:args.revision, tabId:args.tabId, documentId:args.expectedDocumentId, submitRef });
      if (activeSignal?.aborted) throw aborted();
      const status = this.status(), target = agentBrowserRequest({ action:'fill', browser:'relay', tabId:args.tabId }, status, owner);
      if (status.tabs.find(tab=>tab.tabId===target.tabId)?.url !== args.expectedUrl) throw fail('Authentication target changed.', 'BROWSER_CREDENTIAL_TARGET_CHANGED');
    };
    return this.enqueue(async activeSignal => {
      // The durable ledger checks prior attempts before opening or filling the page.
      return vault.authenticateOnce(args, async (secret, mark) => {
        await guard(activeSignal);
        const commit = await this.driver.prepareCredentialAuthentication(args,{signal:activeSignal,source:'agent',...(owner?{owner}:{})});
        return commit(secret, async()=>{ await guard(activeSignal); await mark(); await guard(activeSignal); });
      }, {ownerId,signal:activeSignal,beforeDispatch:()=>beforeDispatch({signal:activeSignal,action:'authenticate',intent,origin:args.origin,credentialId:args.credentialId,revision:args.revision,tabId:args.tabId,documentId:args.expectedDocumentId,submitRef})});
    }, {signal,action:'authenticateCredential',tabId:args.tabId,source:'agent'});
  }
  async providerKeySource(value, { signal, owner: context, beforeDispatch, consume } = {}) {
    this.assertAdmission();
    const owner = browserOwner(context), args = providerKeyTarget(value);
    if (typeof this.driver.providerKeySource !== 'function') throw Object.assign(fail('Protected provider key setup is unavailable in this browser.', 'PROVIDER_KEY_SOURCE_UNAVAILABLE'), { status: 503 });
    const guard = () => agentBrowserRequest({ action: args.action === 'click_inspect' ? 'click' : 'read', browser: 'relay', tabId: args.tabId }, this.status(), owner);
    guard();
    return this.enqueue(async activeSignal => {
      guard(); if (beforeDispatch) await beforeDispatch({ signal: activeSignal });
      if (activeSignal.aborted) throw aborted(); guard();
      return this.driver.providerKeySource(args, { signal: activeSignal, owner, beforeDispatch, consume });
    }, { signal, action: 'providerKeySource', tabId: args.tabId, source: 'agent' });
  }
  /** A manual close-all, or a conversation retirement, uses one serialized browser
   * operation so a queued ownership transfer cannot race its target selection.
   * Neither action is exposed as an agent tool. */
  async closeTabs({ conversationId = null, conversations, lifecycleToken } = {}) {
    if (conversationId !== null && (typeof conversationId !== 'string' || !conversationId))
      throw fail('Choose the exact conversation to retire.', 'BROWSER_CONVERSATION_INVALID');
    this.assertAdmission();
    return this.enqueue(async signal => {
      const retirementCurrent = () => conversationId === null || conversations.retirementCurrent(conversationId,lifecycleToken);
      const currentTabs = () => this.status().tabs || [];
      const targets = () => (conversationId === null ? currentTabs()
        : browserConversationStatus({ tabs: currentTabs() }, conversations).tabs)
        .filter(tab => containedTab(tab) && tab.purpose !== 'chat-mode'
          && (conversationId === null || tab.conversationId === conversationId)).map(tab => tab.tabId);
      const closedTabIds = [], failedTabs = [], skippedInUseIds = [], attempted = new Set();
      // Popups can be adopted outside this queue. Drain newly observed tabs, but
      // never spin on failures or an endlessly spawning page. Remaining IDs are
      // an explicit incomplete cleanup result, never a claim of success.
      for (let pass = 0; pass < 4; pass++) {
        if (!retirementCurrent()) break;
        const pending = targets().filter(id => !attempted.has(id));
        if (!pending.length) break;
        for (const tabId of pending) {
        attempted.add(tabId);
        if (signal.aborted) throw aborted();
        if (!retirementCurrent()) break;
        const tab = currentTabs().find(value => value.tabId === tabId);
        if (!tab || tab.purpose === 'chat-mode') continue;
        if (conversationId !== null) {
          const mapped = browserConversationStatus({ tabs: [tab] }, conversations).tabs[0];
          if (mapped?.conversationId !== conversationId) continue;
        }
        if(tab.inUse===true){skippedInUseIds.push(tabId);continue;}
        try {
          assertTabNotInUse(tab);
          await this.driver.perform({ action: 'close', browser: 'relay', tabId }, { source: 'user', signal, protectInUse:true });
          closedTabIds.push(tabId);
        } catch (error) {
          failedTabs.push({ tabId, message: error?.message || 'The tab could not be closed.' });
        }
      }
      }
      return { closed: closedTabIds.length, closedTabIds, failedTabs, skippedInUseIds, remainingTabIds: targets() };
    }, { action: conversationId === null ? 'closeAllTabs' : 'closeConversationTabs', source: 'host', finalizer: true });
  }
  /** A read-only exact-scope preview, serialized after pending browser effects. */
  async inspectScopedCleanup(scopeValue, { conversations, activeRunIds } = {}) {
    const scope = browserCleanupScope(scopeValue);
    const snapshot = browserConversationStatus(this.status(), conversations);
    if (!snapshot.conversations?.some(item => item.id === scope.conversationId && item.state !== 'deleted'))
      throw Object.assign(fail('This conversation is not a saved cleanup destination.', 'BROWSER_CLEANUP_CONVERSATION_MISSING'), { status: 404 });
    const inspections = new Map(await Promise.all(scopedBrowserTabs(snapshot, scope).map(async tab => {
      try {
        return [tab.tabId, typeof this.driver.cleanupInspection === 'function'
          ? await this.driver.cleanupInspection(tab.tabId) : { state: 'unknown' }];
      } catch (cause) {
        return [tab.tabId, { state: 'unknown', reason: 'Page safety inspection failed; retain for review.' }];
      }
    })));
    const active = typeof activeRunIds === 'function' ? activeRunIds() : activeRunIds;
    return browserCleanupPreview(snapshot, scope, { inspections,
      activeRunIds: active instanceof Set ? active : new Set(active || []) });
  }
  async previewScopedCleanup(scope, options = {}) {
    this.assertAdmission();
    return this.enqueue(() => this.inspectScopedCleanup(scope, options),
      { action: 'previewScopedCleanup', source: 'host', finalizer: true });
  }
  /** Only the named, eligible IDs in this preview may close; no popups are adopted after preview. */
  async executeScopedCleanup(value, options = {}) {
    const request = browserCleanupSelection(value);
    this.assertAdmission();
    return this.enqueue(async signal => {
      const preview = await this.inspectScopedCleanup(request.scope, options);
      if (preview.previewId !== request.previewId)
        throw Object.assign(fail('Browser tabs or task activity changed. Preview again before closing.', 'BROWSER_CLEANUP_STALE_PREVIEW'), { status: 409, actionDispatched: false });
      const eligible = new Map(preview.rows.filter(row => row.eligible).map(row => [row.tabId, row]));
      if (request.selectedTabIds.some(id => !eligible.has(id)))
        throw Object.assign(fail('The selection contains a protected or out-of-scope tab.', 'BROWSER_CLEANUP_PROTECTED'), { status: 409, actionDispatched: false });
      const reviewed = new Set(request.reviewedTabIds);
      if (request.selectedTabIds.some(id => eligible.get(id).manualReviewRequired && !reviewed.has(id)))
        throw Object.assign(fail('Some selected pages have limited DOM inspection. Review each page and explicitly select it before cleanup.', 'BROWSER_CLEANUP_REVIEW_REQUIRED'), { status: 409, actionDispatched: false });
      const closedTabIds = [], failedTabs = [];
      for (const tabId of request.selectedTabIds) {
        const recorded = eligible.get(tabId);
        const current = browserConversationStatus(this.status(), options.conversations);
        const actual = scopedBrowserTabs(current, request.scope).find(tab => tab.tabId === tabId);
        if (!actual || actual.url !== recorded.url || actual.documentId !== recorded.documentId
          || actual.owner?.taskId !== recorded.owner.taskId || actual.owner?.nodeId !== recorded.owner.nodeId
          || actual.owner?.runId !== recorded.owner.runId) {
          failedTabs.push({ tabId, reason: 'Ownership or document identity changed before close.' }); continue;
        }
        let inspected;
        try { inspected = typeof this.driver.cleanupInspection === 'function'
          ? await this.driver.cleanupInspection(tabId) : { state: 'unknown' }; }
        catch { inspected = { state: 'unknown' }; }
        const active = typeof options.activeRunIds === 'function' ? options.activeRunIds() : options.activeRunIds;
        const currentRow = browserCleanupPreview({ ...current, tabs: [actual] }, request.scope,
          { inspections: new Map([[tabId, inspected]]),
            activeRunIds: active instanceof Set ? active : new Set(active || []) }).rows[0];
        if (!currentRow?.eligible) {
          failedTabs.push({ tabId, reason: currentRow?.reason || 'The page became busy or its work is no longer verified finished.' }); continue;
        }
        if (currentRow.manualReviewRequired && !reviewed.has(tabId)) {
          failedTabs.push({ tabId, reason: 'Page inspection became limited; explicitly review and select this tab before cleanup.' }); continue;
        }
        try {
          await this.driver.perform({ action: 'close', browser: 'relay', tabId,
            expectedUrl: recorded.url, expectedDocumentId: recorded.documentId },
          { source: 'host-cleanup', signal, cleanupReviewed: reviewed.has(tabId), cleanupGuard: () => {
            // Runs may start while a Chromium DOM safety read is pending.
            // Recheck task activity synchronously immediately before native close.
            const activeNow = typeof options.activeRunIds === 'function'
              ? options.activeRunIds() : options.activeRunIds;
            const ids = activeNow instanceof Set ? activeNow : new Set(activeNow || []);
            if (ids.has(actual.owner.runId) || ids.has(actual.owner.taskId))
              throw Object.assign(fail('This task resumed before its tab could close.', 'BROWSER_CLEANUP_ACTIVE_WORK'), { status: 409 });
            const refreshed = scopedBrowserTabs(
              browserConversationStatus(this.status(), options.conversations), request.scope)
              .find(row => row.tabId === tabId);
            if (!refreshed || refreshed.owner?.taskId !== recorded.owner.taskId
              || refreshed.owner?.nodeId !== recorded.owner.nodeId
              || refreshed.owner?.runId !== recorded.owner.runId
              || refreshed.documentId !== recorded.documentId || refreshed.url !== recorded.url)
              throw Object.assign(fail('Ownership or document identity changed during cleanup.', 'BROWSER_CLEANUP_STALE_TARGET'), { status: 409 });
          } });
          if (this.status().tabs?.some(tab => tab.tabId === tabId))
            failedTabs.push({ tabId, reason: 'Close returned without removing this tab.' });
          else closedTabIds.push(tabId);
        } catch (cause) {
          const absent = !this.status().tabs?.some(tab => tab.tabId === tabId);
          if (absent) closedTabIds.push(tabId);
          failedTabs.push({ tabId, reason: absent
            ? 'Tab closed but its save/acknowledgment failed; verify persistence.'
            : String(cause?.message || 'Tab could not be closed.') });
        }
      }
      let finalPreview, remainingTabIds = null;
      try {
        finalPreview = await this.inspectScopedCleanup(request.scope, options);
        remainingTabIds = finalPreview.rows.map(row => row.tabId);
      } catch (cause) {
        failedTabs.push({ reason: 'Could not verify final scope: ' + cause.message });
        try {
          remainingTabIds = scopedBrowserTabs(
            browserConversationStatus(this.status(), options.conversations), request.scope).map(row => row.tabId);
        } catch { /* Unknown is not zero. */ }
      }
      const persistence = this.status()?.persistence;
      return { scope: request.scope, requested: request.selectedTabIds.length,
        closed: closedTabIds.length, closedTabIds, failedTabs,
        remaining: remainingTabIds === null ? null : remainingTabIds.length,
        remainingTabIds, lateTabIds: remainingTabIds === null ? null
          : remainingTabIds.filter(id => !preview.rows.some(row => row.tabId === id)),
        protected: finalPreview?.protected ?? null, persistenceVerified: persistence?.healthy === true };
    }, { action: 'executeScopedCleanup', source: 'host', finalizer: true });
  }
  async releaseOwner(context, options = {}) {
    const owner = browserOwner(context);
    if (!owner) throw fail('A host browser owner is required for cleanup.', 'BROWSER_OWNER_INVALID');
    if (this.closed || !this.driver) return { suspended: [], retained: [], unavailable: true };
    if (typeof this.driver.releaseOwner !== 'function') return { suspended: [], retained: [], unavailable: true };
    return this.enqueue(() => this.driver.releaseOwner(owner, options), { action: 'releaseOwner', source: 'host', finalizer: true });
  }
  async flushPersistence() {
    this.assertAdmission();
    if (typeof this.driver.flushPersistence !== 'function') throw fail('Browser storage cannot confirm that its current pages and folders were saved.', 'BROWSER_PERSISTENCE_UNAVAILABLE');
    await this.enqueue(() => this.driver.flushPersistence(), { action: 'flushPersistence', source: 'host', finalizer: true });
    return this.status();
  }
  enqueue(invoke, { signal, action, tabId, source = 'user', finalizer = false, dispatchState } = {}) {
    // Host cleanup is part of settling the task, not another timed page action.
    // It must remain behind physically unfinished work even after its caller
    // has timed out or cancelled that work.
    if (finalizer) signal = undefined;
    if (signal?.aborted) return Promise.reject(aborted());
    const record = { invoke, signal, action, tabId, source, finalizer, dispatchState, controller: new AbortController(), started: false, finished: false, workSettled: false };
    const result = new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
    record.onAbort = () => this.interrupt(record, aborted());
    signal?.addEventListener('abort', record.onAbort, { once: true });
    if (!finalizer) record.timer = setTimeout(() => this.interrupt(record, fail('Browser action timed out. Inspect the page before retrying; an action may already have completed.', 'BROWSER_TIMEOUT')), this.timeoutMs);
    this.pending.add(record); this.queue.push(record); this.drain(); return result;
  }
  finish(record, error, result) {
    if (record.finished) return;
    record.finished = true; clearTimeout(record.timer); record.signal?.removeEventListener('abort', record.onAbort); this.pending.delete(record);
    const index = this.queue.indexOf(record); if (index !== -1) this.queue.splice(index, 1);
    if (error) record.reject(error); else record.resolve(result);
  }
  interrupt(record, error) {
    if (record.finished) return;
    if (!record.started || record.dispatchState?.dispatched === false) error = Object.assign(error, { actionDispatched: false });
    const unresolved = record.started && !record.workSettled;
    if (unresolved) this.quarantine = record;
    // The caller's result is independent of an adapter acknowledging abort.
    this.finish(record, error); record.controller.abort();
    if (unresolved) {
      for (const queued of [...this.pending]) if (queued !== record && !queued.started && !queued.finalizer) this.interrupt(queued, recovery());
      this.emit('status', this.status());
    }
  }
  drain() {
    if (this.active || this.closed || this.disconnecting || this.quarantine) return;
    const record = this.queue.shift(); if (!record) return;
    this.active = record;
    const work = Promise.resolve().then(() => {
      if (record.finished || this.closed || this.disconnecting) throw aborted();
      record.started = true; return record.invoke(record.controller.signal);
    });
    // This observes physical completion even after its caller has returned. No
    // next action can reach an adapter until this promise has actually settled.
    record.settled = work.then(result => this.complete(record, null, result), error => this.complete(record, error)).catch(error => this.finish(record, error));
  }
  complete(record, error, result) {
    record.workSettled = true; this.active = null;
    const recovered = this.quarantine === record; if (recovered) this.quarantine = null;
    try {
      if (!record.finished) {
        if (this.closed || this.disconnecting || record.controller.signal.aborted) this.finish(record, aborted());
        else {
          this.finish(record, error, result);
          if (!error) this.emit('action', { action: record.action, tabId: result?.tabId || record.tabId, source: record.source, at: new Date().toISOString() });
        }
      }
      if (recovered) this.emit('status', this.status());
    } finally { this.drain(); }
  }
  async show(tabId, { signal } = {}) {
    this.assertAdmission();
    return this.enqueue(() => this.driver.show(tabId), { signal, action: 'show', tabId });
  }
  protectionStatus() {
    const value = this.driver?.protectionStatus?.() || { available: false, enabled: false, ready: false, tabs: [] };
    return { ...value, available: !this.closed && value.available === true };
  }
  async configureProtection(options, { signal, source = 'user', owner: context, beforeDispatch } = {}) {
    this.assertAdmission();
    const owner = browserOwner(context), agent = source !== 'user';
    if (options?.action === 'status' && Object.keys(options).some(key => key !== 'action')) throw fail('Filtering status does not accept mutation fields.', 'BROWSER_VALIDATION');
    if (typeof this.driver.configureProtection !== 'function') throw fail('Browser protection is available in the contained BLACKICE browser.', 'BROWSER_PROTECTION_UNAVAILABLE');
    const guard = () => { if (agent) agentBrowserRequest({ action: 'protection', browser: 'relay', operation: options?.action, ...(options?.tabId !== undefined ? { tabId: options.tabId } : {}) }, this.status(), owner); };
    guard();
    return this.enqueue(async activeSignal => {
      guard();
      if (beforeDispatch) try { await beforeDispatch({ signal: activeSignal, action: 'protection', tabId: options?.tabId }); }
      catch (error) { throw Object.assign(error, { actionDispatched: false }); }
      if (activeSignal.aborted) throw aborted();
      guard();
      const result = options?.action === 'status' ? this.protectionStatus() : await this.driver.configureProtection(options, { signal: activeSignal });
      return agent ? agentBrowserResult(result, this.status(), owner) : result;
    }, { signal, action: 'protection', tabId: options?.tabId, source });
  }
  disconnectFirefox() {
    if (this.closed || !this.driver) return Promise.reject(fail('The browser workspace has closed.', 'BROWSER_UNAVAILABLE'));
    if (this.disconnectPromise && !this.disconnectSettled) return this.disconnectPromise;
    const firefox = this.driver?.drivers?.firefox;
    if (!firefox?.disconnect) return Promise.reject(fail('Firefox is not available in this browser workspace.', 'BROWSER_UNAVAILABLE'));
    this.disconnecting = true; this.disconnectSettled = false; this.cancel(); this.emit('status', this.status());
    const active = this.active?.settled;
    // Disconnect must be able to stop an in-progress Firefox startup/action.
    // Admission stays blocked until both the adapter and that action settle.
    const attempt = Promise.allSettled([active, Promise.resolve().then(() => firefox.disconnect())]).then(results => {
      const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
    });
    this.disconnectWork = attempt;
    const release = () => { if (this.disconnectWork !== attempt) return; this.disconnecting = false; this.disconnectPromise = null; this.disconnectWork = null; this.disconnectSettled = true; this.disconnectError = null; this.emit('status', this.status()); this.drain(); };
    // A failed disconnect does not prove that the profile is released. Keep
    // admission closed. A user can explicitly retry cleanup only after its
    // physical work has settled; a timeout alone never starts another attempt.
    attempt.then(release, () => { if (this.disconnectWork === attempt) this.disconnectSettled = true; }).catch(() => {});
    this.disconnectPromise = bounded(attempt, this.shutdownTimeoutMs, () => fail('Firefox shutdown has not finished. Its profile may still be in use. Wait for it to stop before reopening Firefox or starting another browser task.', 'BROWSER_DISCONNECT_TIMEOUT')).then(() => this.status()).catch(error => {
      if (this.disconnectWork === attempt) { this.disconnectError = fail('Firefox shutdown could not be confirmed. Its profile may still be in use. Retry Disconnect after cleanup stops, or close Relay and check Firefox before starting another browser task.', 'BROWSER_SHUTDOWN_UNCONFIRMED'); this.emit('status', this.status()); }
      throw error;
    });
    return this.disconnectPromise;
  }
  cancel() {
    const records = [...this.pending].filter(record => !record.finalizer);
    for (const record of records.filter(record => !record.started)) this.interrupt(record, aborted());
    for (const record of records.filter(record => record.started)) this.interrupt(record, aborted());
  }
  async stopForRestart({ signal, onEffect } = {}) {
    if (signal?.aborted) throw aborted();
    if (this.closed || this.active || this.pending.size || this.quarantine) throw fail('Wait for owned browser actions and cleanup to settle before stopping page activity.', 'BROWSER_RESTART_BUSY');
    if (typeof this.driver?.stopForRestart !== 'function') return { browsers: {} };
    return this.driver.stopForRestart({ signal, onEffect });
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.closing = true; this.cancel();
    const work = Promise.allSettled([this.active?.settled, this.disconnectWork, Promise.resolve().then(() => this.driver?.close?.())]).then(results => {
      const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
    }).finally(() => {
      // Shutdown owns the resource lifetime now. Retire queued host work only
      // after physical work and adapter shutdown settle, never on an action
      // timeout; otherwise a task could report completion while work is alive.
      for (const record of [...this.pending]) if (record.finalizer && !record.started) this.finish(record, fail('The browser closed before its queued storage or cleanup operation could run.', 'BROWSER_UNAVAILABLE'));
    });
    this.closePromise = bounded(work, this.shutdownTimeoutMs, () => fail('Browser shutdown could not be confirmed. A browser action or profile may still be in use; inspect it before restarting Relay or repeating the task.', 'BROWSER_SHUTDOWN_TIMEOUT')).catch(error => { this.shutdownError = error; throw error; }).finally(() => {
      this.closing = false; this.driver?.removeListener?.('changed', this.driverListener); this.emit('status', this.status());
    });
    return this.closePromise;
  }
}

export const BROWSER_TOOL = {
  type: 'function', name: 'relay_browser',
  description: "Use websites in BLACKICE's contained browser with browser:\"relay\".\nStart with tabs or open, then snapshot or read on the chosen tabId. Use returned element refs for click, fill, select and press. For screenshot coordinates, supply x/y in CSS pixels, expectedUrl and expectedDocumentId from that same tab.\nAfter BROWSER_REF_STALE or BROWSER_INPUT_DOCUMENT_CHANGED with actionDispatched:false, take a fresh snapshot and retry with its refs. If dispatch is unknown, inspect the page result before repeating the action.\nUpload needs absolute local paths and exactly one current file-input ref or chooserId. Local files need not be chat attachments. password_manager opens the optional saved-password interface for an owned tab.\ntabs lists this task's visible pages; an empty list does not mean the profile is signed out. take_ownership adopts an eligible stopped task's page: pass its tabId, copy ownerKey to expectedOwnerKey, url to expectedUrl and documentId to expectedDocumentId from the same ownershipCandidates entry. inheritedEffects lists unresolved earlier actions. The calling ChatGPT tab and foreign ownershipCandidates are not readable through this tool.\nA control's required flag describes HTML/ARIA, not server validation. Frame observation reports captured content, a complete empty capture, or unknown capture; it does not determine whether a challenge is visible." + ' ' + BROWSER_VERIFICATION_GUIDANCE,
  inputSchema: { type: 'object', properties: {
    destination: { type: 'string', enum: ['user', 'task'] }, destinationTabId: { type: 'string' }, destinationOwnerKey: { type: 'string' }, expectedOwnerKey: { type: 'string', maxLength: 650, description: 'For take_ownership of a stopped task tab: exact ownerKey from ownershipCandidates. The host verifies stopped, settled ownership again at dispatch.' },
    inUse: {type:'boolean',description:'For tab_mark, explicitly protect an owned tab while needed (true), or release your own mark when finished (false). Does not transfer ownership or close the tab. Human marks cannot be cleared by agents.'},
    action: { type: 'string', enum: [...BROWSER_ACTIONS] }, browser: { type: 'string', enum: ['relay'], description: 'The contained BLACKICE browser. Every action remains on this driver.' }, collectionId: { type: ['string','null'] }, parentCollectionId: { type: ['string','null'] }, expectedName: { type:'string', maxLength:200, description:'Original folder name for conflict-checked collection_rename.' }, tabId: { type: 'string' }, folderId: { type: 'string', description: 'An observed folder available to this task; normally the host chooses it automatically.' }, parentTabId: { type: ['string', 'null'], description: 'An observed parent tab available to this worker. Use null with tab_move to make a root tab.' }, name: { type: 'string', maxLength: 200, description: 'Folder name for folder_create or folder_rename.' }, url: { type: 'string' }, ref: { type: 'string', description: 'Observed element ref. For upload, choose a current file input ref from this tab, or use a pending chooserId with explicit document and URL, exactly one.' }, chooserId: { type: 'string', description: 'Exact pending file chooser ID observed after opening the page control. Use for upload in place of ref with the same tab, expectedUrl and expectedDocumentId.' },
    interactionId: { type: 'string', description: 'Exact pending dialog ID from the same observed tab.' }, decision: { type: 'string', enum: ['accept', 'dismiss', 'acknowledge'] }, promptText: { type: 'string', maxLength: 4096, description: 'Response to the exact observed JavaScript prompt within the authorized task.' },
    operation: { type: 'string', enum: ['status', 'global', 'site', 'refresh'], description: 'For protection: inspect optional filtering, change its global/current-site preference, or refresh filter lists.' }, enabled: { type: 'boolean' }, origin: { type: 'string', description: 'Exact observed HTTP(S) origin for a site filtering preference.' },
    after: { type: 'integer', minimum: 0, description: 'Diagnostic event cursor.' }, limit: { type: 'integer', minimum: 1, maximum: 256, description: 'Maximum diagnostic events.' },
    text: { type: 'string', description: 'Required for fill: the exact replacement text, including text:"" for an intentional clear. Also used for type or expected page text for wait. type requires the current observed URL and document identity.' }, value: { type: 'string', description: 'Selection-only value of an observed native option for action:"select". For fill, supply text instead.' }, key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] }, maxItems: 4 }, expectedUrl: { type: 'string', description: 'Exact observed page URL for guarded type, press, click, hover, fill, select, upload, interaction or wheel input. Supply expectedDocumentId with it.' }, expectedDocumentId: { type: 'string', description: 'Current documentId from the same tab snapshot or screenshot. Required with expectedUrl for coordinate click or hover, type, wheel input and chooser uploads. Optional as a pair for observed file input refs; the host binds those refs to their observed document.' }, query: { type: 'string', description: 'For snapshot and read, query is a case-insensitive literal substring, not a semantic search. It filters text and controls; read also includes bounded nearby visible text around matching passages. No matches do not show that the page is empty: omit query and inspect the same tab before concluding content is absent. Also accepted as expected text for wait.' },
    x: { type: 'number', description: 'For click or hover on a visible page control, use current screenshot-relative CSS pixels with the observed tab, URL and document identity; never use physical desktop coordinates.' }, y: { type: 'number' },
    deltaX: { type: 'number', description: 'Signed horizontal wheel movement in CSS pixels. Supply both deltas, x/y and the exact observed tab, URL and document identity.' }, deltaY: { type: 'number', description: 'Signed vertical wheel movement in CSS pixels. Do not combine wheel input with ref, direction or amount.' },
    direction: { type: 'string', enum: ['up','down','left','right'] }, amount: { type: 'number' }, timeoutMs: { type: 'integer' },
    paths: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Absolute local file paths for upload. Also supply the observed tab and document identity with exactly one file input ref or pending chooserId.' },
  }, required: ['action'], additionalProperties: false },
};
// Compatibility export for older consumers; guidance is carried by BROWSER_TOOL only.
export const BROWSER_INSTRUCTIONS = '';

export function containedBrowserAvailable(status) {
  return status?.available === true && status.contained === true && (!status.browsers?.relay || status.browsers.relay.available === true);
}

const browserObservationControlTags = new Set(['input','textarea','select','button']);
const browserObservationControlRoles = new Set(['textbox','searchbox','combobox','checkbox','radio','switch','spinbutton','slider','listbox','button']);

function browserObservation(metadata, action) {
  if (!Array.isArray(metadata.frames) || !metadata.frames.length || metadata.protectedContent) return;
  const counts = { frameCount:0, contentFrameCount:0, emptyFrameCount:0, unknownFrameCount:0,
    frameErrorCount:Array.isArray(metadata.frameErrors) ? Math.min(31,metadata.frameErrors.length) : 0,
    enabledControlCount:0, disabledControlCount:0, unknownControlCount:0 };
  let remaining = 400;
  for (const frame of metadata.frames.slice(0,30)) {
    counts.frameCount++;
    if (frame?.observation === 'content-observed') counts.contentFrameCount++;
    else if (frame?.observation === 'no-content-observed') counts.emptyFrameCount++;
    else counts.unknownFrameCount++;
    if (!Array.isArray(frame?.elements)) continue;
    for (const element of frame.elements.slice(0,remaining)) {
      remaining--;
      if (element?.type === 'hidden' || !(browserObservationControlTags.has(element?.tag) || browserObservationControlRoles.has(element?.role))) continue;
      if (element.disabled === false) counts.enabledControlCount++;
      else if (element.disabled === true) counts.disabledControlCount++;
      else counts.unknownControlCount++;
    }
  }
  return { type:'browser.observation', tool:'relay_browser', action, phase:'returned', ...counts };
}

export function createBrowserToolHandler({ browser, cwd, signal, owner: contextOwner, onEvent = () => {}, maxCalls = null, validateUploadPath, beforeDispatch, onObservation }) {
  const owner = browserOwner(contextOwner);
  if (maxCalls !== null && (!Number.isSafeInteger(maxCalls) || maxCalls < 1)) throw fail('Browser action limit must be a positive whole number, or null for no application limit.');
  const enrichStaleReference = async (details, target, activeSignal, mayObserve, diagnostic) => {
    const {code} = details;
    const staleRef = code === 'BROWSER_REF_STALE';
    const undispatchedDocumentChange = code === 'BROWSER_INPUT_DOCUMENT_CHANGED' && details.actionDispatched === false;
    if (staleRef || undispatchedDocumentChange) {
      details.error = `${details.error.slice(0, 400)} Do not reuse this ref. Observe the current page, then select the intended control's ref from frames[].elements[].ref.${details.actionDispatched === false ? ' No page input was dispatched.' : ' Inspect the page for effects before any retry.'}`;
      details.recovery = { nextCall: target?.tabId ? { action: 'snapshot', browser: 'relay', tabId: target.tabId } : { action: 'tabs', browser: 'relay' }, refSource: 'frames[].elements[].ref' };
      // Recovery may observe a still-owned tab once, waiting for an unstable
      // document to settle first. It must not navigate or replay input.
      if (mayObserve && details.actionDispatched === false && target?.tabId) {
        const limit = AbortSignal.timeout(3000), refreshSignal = activeSignal ? AbortSignal.any([activeSignal, limit]) : limit;
        try {
          const status = browser.status(), current = status.tabs?.find(tab => tab.tabId === target.tabId);
          if (current && !current.suspended && !current.dormant && !current.crashed) {
            const snapshot = agentBrowserRequest(details.recovery.nextCall, status, owner);
            const settleRecoveryRead = undispatchedDocumentChange || ['document-changed', 'frame-changed'].includes(diagnostic?.reason);
            const observed = await bounded(browser.perform(snapshot, { signal: refreshSignal, source: 'agent', ...(owner ? { owner } : {}), ...(settleRecoveryRead ? { settleRecoveryRead: true } : {}) }), 3000, () => fail('Fresh browser observation timed out.', 'BROWSER_SNAPSHOT_TIMEOUT'));
            if (!refreshSignal.aborted && observed?.tabId === target.tabId) {
              const latest = browser.status();
              agentBrowserRequest(snapshot, latest, owner);
              if (observed.navigationUnsettled) {
                details.recovery.navigationUnsettled = true;
                details.recovery.hint = 'The page was still changing after the bounded wait. Use nextCall if you still need this tab. Do not repeat the old click.';
              } else {
                details.recovery.observation = agentBrowserResult(observed, latest, owner, 'snapshot');
                if (settleRecoveryRead && details.recovery.observation.frames?.length)
                  details.recovery.hint = 'Read the attached observation first. If it already shows the intended destination, use it without clicking again. Use nextCall only if you still need a fresh read.';
              }
            }
          }
        } catch (refreshError) {
          if (activeSignal?.aborted) throw refreshError;
        }
        if (activeSignal?.aborted) throw aborted();
      }
    }
  };
  let calls = 0;
  const handler = async (call, context = {}) => {
    const signals = [signal, context.signal].filter(Boolean), activeSignal = signals.length ? AbortSignal.any(signals) : undefined;
    if (activeSignal?.aborted) throw aborted();
    if (call.name !== 'relay_browser') throw fail('Unknown browser tool.');
    if (maxCalls !== null && ++calls > maxCalls) throw fail('The configured browser action limit was reached.');
    let args, target, performStarted = false;
    try {
      args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('Browser tool arguments must be an object.', 'BROWSER_VALIDATION');
      if (args.action === 'fill') validateBrowserFillRequest(args);
      if (args.action === 'reuse_session') throw fail('Session transfer was removed. Use the contained browser and its own sign-in in Observe.', 'BROWSER_VALIDATION');
      if (args.browser !== undefined && args.browser !== 'relay' || String(args.tabId || '').startsWith('firefox:')) throw fail('External browser interaction is unavailable to task agents. Use the contained relay browser in Observe.', 'BROWSER_CONTAINED_ONLY');
      if (!containedBrowserAvailable(browser?.status?.())) throw fail('The contained BLACKICE browser is unavailable. Open its workspace in the desktop app; no external browser was started.', 'BROWSER_UNAVAILABLE');
      target = agentBrowserRequest(args, browser.status(), owner);
      onEvent({ type: 'browser.action', action: args.action, message: `Browser · ${args.action}` });
      if (activeSignal?.aborted) throw aborted();
      if (!containedBrowserAvailable(browser?.status?.())) throw fail('The contained BLACKICE browser is unavailable.', 'BROWSER_UNAVAILABLE');
      const owned = agentBrowserRequest(target, browser.status(), owner);
      const validateAdmission = context.operationDescriptor || context.onOperationDispatch ? async dispatch => {
        if (beforeDispatch) await beforeDispatch(dispatch);
        const current = await handler.describeOperation(call, { ...context, signal: dispatch.signal });
        if (context.operationDescriptor && current.operationKey !== context.operationDescriptor.operationKey)
          throw Object.assign(fail('The browser document, control, or form payload changed after admission.', 'OPERATION_DESCRIPTOR_CHANGED'), { actionDispatched: false });
        if (context.onOperationDispatch) await context.onOperationDispatch(current);
      } : beforeDispatch;
      const recoveryInput = context.recoveryBinding ? async ({ signal: dispatchSignal, prepared = false } = {}) => {
        try { await handler.revalidateRecoveryBinding(context.recoveryBinding, call, { ...context, signal: dispatchSignal || activeSignal }); }
        catch (reason) { if (prepared) { delete reason.actionDispatched; delete reason.inputDispatched; } throw reason; }
      } : undefined;
      performStarted = true;
      const emitObservation = event => { try { onObservation?.(event, call.callId); } catch { /* Diagnostics must not affect the browser outcome. */ } };
      const onClickPopup = onObservation && args.action === 'click' ? (sourceTabId, tabId) => {
        if (!activeSignal?.aborted) emitObservation({type:'browser.destination', action:'click', phase:'popup-during-click', sourceTabId, tabId});
      } : undefined;
      const performed = await browser.perform(owned, { signal: activeSignal, source: 'agent', ...(owner ? { owner } : {}), ...(validateUploadPath ? { validateUploadPath } : {}), ...(validateAdmission ? { beforeDispatch: validateAdmission } : {}), ...(context.operationDescriptor ? { operationDescriptor: context.operationDescriptor } : {}), ...(context.operationId ? { operationId: context.operationId } : {}), ...(recoveryInput ? { recoveryInput } : {}), ...(onClickPopup ? { onClickPopup } : {}) });
      const status = browser.status(), result = agentBrowserResult(performed, status, owner, args.action, args.action === 'tabs' && args.query === 'stopped-task-recovery');
      if (activeSignal?.aborted) throw aborted();
      const { imageUrl, ...metadata } = result || {};
      const historyTarget = applicationHistoryTarget(metadata);
      if (typeof cwd === 'string' && cwd.trim() && historyTarget) {
        let history;
        try { history = await inspectApplicationHistory(cwd, { ...historyTarget, title: metadata.title || '' }); }
        catch { history = { sources: [], errors: ['history-lookup-failed'], matches: [], ...(historyTarget.kind === 'application-page-context' ? { related: [], relatedTruncated: false } : {}) }; }
        if (activeSignal?.aborted) throw aborted();
        metadata.applicationHistory = {
          target: { ...historyTarget, observedUrl: historyTarget.kind === 'application-page-context' ? historyTarget.url : metadata.url }, workspace: cwd,
          basis: 'reported-local-history', coverage: 'supported-top-level-workspace-history-and-legacy-claims-only',
          ...history
        };
      }
      const taskCapacity = args.action === 'open' ? taskBrowserCapacity(status, owner) : null;
      if (taskCapacity) metadata.taskCapacity = taskCapacity;
      const filteredInspection = ['snapshot','read'].includes(args.action) && typeof args.query === 'string' && Boolean(args.query.trim());
      const frames = Array.isArray(metadata.frames) ? metadata.frames : [];
      const matchingEvidence = frames.some(frame => frame?.elements?.length || frame?.text?.trim?.());
      const incompleteCapture = !frames.length || metadata.frameErrors?.length || frames.some(frame => frame?.readyState !== 'complete' || frame.truncated);
      const filterRecovery = filteredInspection && !matchingEvidence && typeof metadata.tabId === 'string' && metadata.tabId === owned.tabId &&
        !metadata.protectedContent && !metadata.navigationUnsettled && !metadata.pendingInteraction
        ? {
          reason: incompleteCapture ? 'capture-unknown' : 'no-filter-match',
          nextCall: { action: 'snapshot', browser: 'relay', tabId: metadata.tabId },
          hint: (incompleteCapture ? 'The capture was incomplete; the match is unknown. ' : 'No controls or text matched the query in this capture. ') +
            'This does not show the page is empty. Take an unfiltered snapshot of this same tab before concluding the content is absent. Do not repeat any prior input.'
        } : null;
      const chooser = metadata.pendingInteraction;
      const chooserUpload = !metadata.protectedContent && !metadata.navigationUnsettled &&
        chooser?.kind === 'file_chooser' && chooser.status === 'pending' &&
        /^browser_input_[a-f0-9-]{36}$/.test(chooser.id) &&
        typeof metadata.tabId === 'string' && chooser.tabId === metadata.tabId &&
        typeof metadata.documentId === 'string' && metadata.documentId && chooser.documentId === metadata.documentId &&
        typeof metadata.url === 'string' && metadata.url && chooser.url === metadata.url
        ? {
          nextCall: { action: 'upload', browser: 'relay', tabId: chooser.tabId, chooserId: chooser.id,
            expectedDocumentId: chooser.documentId, expectedUrl: chooser.url },
          hint: 'If an upload is authorized, copy these fields into the upload call and add the authorized absolute local paths. Do not supply ref or reopen the chooser.'
        } : null;
      const response = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(chooserUpload ? { chooserUpload, ...metadata } : filterRecovery ? { filterRecovery, ...metadata } : metadata) }, ...(imageUrl ? [{ type: 'inputImage', imageUrl }] : [])] };
      if (onObservation) {
        const observation = browserObservation(metadata, args.action);
        if (observation) emitObservation(observation);
        if (['read','snapshot','screenshot'].includes(args.action) && metadata.tabId && !metadata.protectedContent
          && !metadata.navigationUnsettled && (imageUrl || observation?.contentFrameCount > 0))
          emitObservation({type:'browser.destination', action:args.action, phase:'inspection-returned', tabId:metadata.tabId});
      }
      return response;
    } catch (error) {
      if (!performStarted && error && typeof error === 'object') error.actionDispatched = false;
      if (activeSignal?.aborted) throw error;
      // Renderer and protocol rejections are not guaranteed to be Error objects.
      // Keep diagnostic text without serializing arbitrary error objects or stacks.
      const message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : typeof error?.description === 'string' ? error.description : '';
      const code = typeof error?.code === 'string' && error.code.trim() ? error.code.slice(0, 120) : typeof error?.code === 'number' && Number.isFinite(error.code) ? error.code : 'BROWSER_ACTION_FAILED';
      const details = { error: message.trim() ? message.slice(0, 1500) : 'The browser action failed without error details. Inspect the current page before repeating it.', code, ...(typeof error?.actionDispatched === 'boolean' ? { actionDispatched: error.actionDispatched } : {}), ...(typeof error?.inputDispatched === 'boolean' ? { inputDispatched: error.inputDispatched } : {}) };
      await enrichStaleReference(details, target, activeSignal, performStarted, error?.browserReferenceDiagnostic);
      if (['BROWSER_TASK_TAB_LIMIT', 'BROWSER_LIVE_LIMIT'].includes(code)) details.error = `${details.error.slice(0, 400)} Read current pages with the tabs action on the attached browser inspection tool. Use a returned owned tabId with navigate and the next url to reuse a page. For a finished owned page, suspend frees a live slot while keeping the page for later; close removes it. Keep unfinished forms, active downloads and unresolved effects open. Inspect current tabs after the action and retry open when a slot is available. Use the required fields from the attached tool schema; some catalogs expose inspection and mutation as separate tools.`;
      return { success: false, code, contentItems: [{ type: 'inputText', text: JSON.stringify(details) }],
        ...(error?.actionDispatched===false?{actionDispatched:false}:{}),...(error?.browserReferenceDiagnostic?{browserReferenceDiagnostic:error.browserReferenceDiagnostic}:{}) };
    }
  };
  handler.recoverStaleReference = async (call, error, context = {}) => {
    if (!['BROWSER_REF_STALE','BROWSER_INPUT_DOCUMENT_CHANGED'].includes(error?.code) || error.actionDispatched !== false) return null;
    const signals = [signal,context.signal].filter(Boolean), activeSignal = signals.length ? AbortSignal.any(signals) : undefined;
    if (activeSignal?.aborted) throw aborted();
    const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
    const details = {error: String(error.message || 'The browser observation changed before input.'), code: error.code, actionDispatched: false};
    let target; try { target = agentBrowserRequest(args, browser.status(), owner); } catch {}
    await enrichStaleReference(details, target, activeSignal, true, error.browserReferenceDiagnostic);
    return {success:false,code:details.code,actionDispatched:false,contentItems:[{type:'inputText',text:JSON.stringify(details)}],
      ...(error.browserReferenceDiagnostic?{browserReferenceDiagnostic:error.browserReferenceDiagnostic}:{})};
  };
  handler.describeOperation = async (call, context = {}) => {
    const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
    const target = agentBrowserRequest(args, browser.status(), owner);
    const observation = typeof browser.observeOperation === 'function'
      ? await browser.observeOperation(target, { signal: context.signal || signal, owner })
      : browser.status();
    return describeHostOperation({ ...call, arguments: target }, { browserObservation: observation, signal: context.signal || signal });
  };
  const recoverySnapshot = async (call, context = {}) => {
    const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
    if (!containedBrowserAvailable(browser?.status?.())) throw Object.assign(fail('Contained browser recovery is unavailable.', 'BROWSER_UNAVAILABLE'), { actionDispatched: false });
    const target = agentBrowserRequest(args, browser.status(), owner);
    const observation = typeof browser.observeOperation === 'function' ? await browser.observeOperation(target, { signal: context.signal || signal, owner, recoveryInspection: true }) : null;
    return { target, observation };
  };
  handler.captureRecoveryBinding = async (call, context = {}) => {
    const { target, observation } = await recoverySnapshot(call, context);
    return createBrowserRecoveryBinding(call, target, observation);
  };
  handler.revalidateRecoveryBinding = async (binding, call, context = {}) => {
    const { target, observation } = await recoverySnapshot(call, context);
    return assertBrowserRecoveryBinding(binding, call, target, observation);
  };
  handler.normalizeOperationResult = async (result, context = {}) => {
    let browserObservation;
    const args = typeof context.call?.arguments === 'string' ? JSON.parse(context.call.arguments) : context.call?.arguments;
    const bindings = [...new Map((context.criteria || []).flatMap(receiptBindingsForCriterion).map(binding => [browserReceiptBindingKey(binding), binding])).values()];
    if (result?.success === true && (bindings.length || context.descriptor?.commit || context.operationalReceipts === true && context.commitments?.length) && typeof browser.observeOperation === 'function') {
      let body;
      try { body = JSON.parse(result.contentItems?.find(item => item.type === 'inputText')?.text || '{}'); } catch {}
      if (body?.tabId && body?.documentId) try {
        const target = agentBrowserRequest({ action: 'read', tabId: body.tabId, browser: 'relay' }, browser.status(), owner);
        browserObservation = await browser.observeOperation(target, { signal: context.signal || signal, owner,
          expectedDocumentId: body.documentId, expectedUrl: body.url, receiptBindings: bindings });
      } catch { /* A changed or unavailable document supplies no confirmation. The actual tool result stays recorded. */ }
    }
    return normalizeHostOperationResult(result, { ...context, browserObservation, signal: context.signal || signal });
  };
  handler.operationAdapter = 'relay_browser';
  handler.operationOwner = owner ? Object.freeze({ ...owner }) : null;
  handler.normalizeOperationalResult = (result, context = {}) => {
    const receiptBindings = (context.receiptBindings || []).map(normalizeOperationalReceiptBinding);
    // Independent receipt mappings reuse host extraction, not Planning admission.
    return handler.normalizeOperationResult(result, { ...context, operationalReceipts: true,
      criteria: receiptBindings.length ? [{ id: 'operational_receipt', kind: 'external-confirmation', receiptBindings }] : [] });
  };
  return handler;
}
