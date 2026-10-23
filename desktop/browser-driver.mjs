import { BrowserWindow, session } from 'electron';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { browserURL, browserCredentialTarget, browserOwner, browserOwnerKey, browserWheelScroll, validateBrowserWheelScroll } from '../lib/browser.mjs';
import { captureHiddenPage } from './browser-capture.mjs';
import { loadBrowserCompatibility } from './browser-compatibility.mjs';
import { BrowserDiagnostics } from '../lib/browser-diagnostics.mjs';
import { BrowserProtection, protectionOrigin } from '../lib/browser-protection.mjs';

const error = message => new Error(message);
const DEFAULT_FOLDER = 'folder_user';
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value);
const ownerRecord = owner => owner ? { taskId: owner.taskId, runId: owner.runId, nodeId: owner.nodeId } : null;
const sameOwner = (left, right) => left?.taskId === right?.taskId && left?.nodeId === right?.nodeId;
const folderName = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw Object.assign(error('Use a folder name from 1 to 200 characters.'), { code: 'BROWSER_FOLDER_VALIDATION', actionDispatched: false });
  return value.trim();
};
const capacityError = (message, code) => Object.assign(error(message), { code, actionDispatched: false });
const navigationFailure = tab => Object.assign(error(`The browser could not load the requested page: ${String(tab.loadError || 'navigation failed').slice(0, 1000)}`), { code: 'BROWSER_NAVIGATION_FAILED', actionDispatched: tab.navigationDispatched === true });
const rendererFailure = (tab, actionDispatched = false) => Object.assign(error(`This browser page stopped unexpectedly (${tab.rendererFailure?.reason || 'unknown'}). Reload or navigate this tab explicitly, then inspect it before repeating any action.`), { code: 'BROWSER_RENDERER_GONE', actionDispatched });
// Match ordinary file-picker metadata without changing the selected bytes/name.
const uploadMimeTypes = new Map(Object.entries({
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.rtf': 'application/rtf', '.odt': 'application/vnd.oasis.opendocument.text',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.zip': 'application/zip', '.json': 'application/json',
}));
const uploadRejected = () => Object.assign(error('Delivery of the selected files could not be verified at this file input. Inspect the page before another upload.'), { code: 'BROWSER_UPLOAD_REJECTED' });
const uploadMetadata = list => Array.isArray(list) && Array.from(list).every(file => file && typeof file.name === 'string' && typeof file.type === 'string' && Number.isSafeInteger(file.size) && file.size >= 0);
const sameUploadFiles = (actual, expected) => actual.length === expected.length && expected.every((file, index) => { const value = actual[index]; return value && value.name === file.name && value.size === file.size && value.type === file.type; });
function validateUploadReceipt(receipt, files) {
  if (!uploadMetadata(receipt?.delivered) || !sameUploadFiles(receipt.delivered, files) || receipt.eventsDispatched !== true || !uploadMetadata(receipt.uploaded)) throw uploadRejected();
  // Sites may consume a File into application state and reset the native input.
  // Neither retaining nor clearing that input proves server-side acceptance.
  const retained = receipt.uploaded, unchanged = sameUploadFiles(retained, files);
  const inputSelection = unchanged ? 'retained' : retained.length ? 'changed_by_page' : 'cleared_by_page';
  return { delivered: receipt.delivered, retained, deliveryVerified: true, inputSelection, siteAcceptance: 'unconfirmed', inspectBeforeContinuing: true,
    ...(unchanged ? { uploaded: retained } : { warning: 'The page changed or cleared the file input after delivery. Inspect the page for an attachment or rejection before continuing. Do not repeat the upload based on this receipt.' }) };
}
const inputDocumentId = tab => `${tab.id}:${tab.revision}`;
const interactionError = () => Object.assign(error('This page is waiting for an explicit local dialog decision.'), { code: 'BROWSER_INTERACTION_PENDING' });
const interactionChanged = () => Object.assign(error('This exact browser interaction is no longer current. Inspect the page before continuing.'), { code: 'BROWSER_INTERACTION_CHANGED' });
const interactionText = value => typeof value === 'string' ? value.slice(0, 4096) : '';
const INPUT_MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
function keyboardModifiers(value) {
  if (value === undefined) return 0;
  if (!Array.isArray(value) || value.length > 4 || new Set(value).size !== value.length || value.some(item => !Object.hasOwn(INPUT_MODIFIERS, item))) throw error('Use the supported keyboard modifiers: Alt, Control, Meta or Shift.');
  return value.reduce((mask, item) => mask | INPUT_MODIFIERS[item], 0);
}
const containedWindowOptions = browserSession => ({
  width: 1280, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
  frame: false, fullscreenable: false, minimizable: false, maximizable: false, backgroundColor: '#000000', autoHideMenuBar: true, title: 'BLACKICE contained browser',
  webPreferences: { session: browserSession, offscreen: true, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, backgroundThrottling: false, spellcheck: false, paintWhenInitiallyHidden: true, disableDialogs: false },
});
const cancel = signal => { if (signal?.aborted) throw Object.assign(error('Browser action cancelled.'), { name: 'AbortError' }); };
const bounded = (promise, signal, ms = 12000) => new Promise((resolve, reject) => {
  let timer;
  const done = (fn, value) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); };
  const abort = () => done(reject, Object.assign(error('Browser action cancelled; inspect before repeating an action.'), { name: 'AbortError' }));
  timer = setTimeout(() => done(reject, error('The page did not respond. Inspect or reload before repeating an action.')), ms);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  Promise.resolve(promise).then(value => done(resolve, value), reason => done(reject, reason));
});

// The same function executes inside each frame, including cross-origin frames.
// No Node APIs, keys or local application handles are exposed to the page.
function pageSnapshot(key, prefix, query) {
  let state = globalThis[key];
  if (!state || state.document !== document || state.prefix !== prefix) state = globalThis[key] = { document, prefix, documentId: Math.random().toString(36).slice(2), elements: new Map(), ids: new WeakMap(), next: 0, credentialFields: state?.document === document && state.credentialFields || new WeakSet() };
  const items = [], text = [], seen = new Set(); let scanned = 0, truncated = false;
  const normalized = value => String(value || '').replace(/\s+/g, ' ').trim();
  function walk(root) {
    for (const el of root.children || []) {
      if (++scanned > 16000 || items.length >= 300) { truncated = true; return; }
      if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(el.tagName)) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const role = el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox', SUMMARY: 'button' }[el.tagName]) || (/^H[1-6]$/.test(el.tagName) ? 'heading' : '');
      const namedContainer = !!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'));
      const control = (!!role && (namedContainer || !/^(main|navigation|region|list|listitem|article|group|presentation|none|rowgroup|table|grid)$/.test(role))) || el.isContentEditable || el.tabIndex >= 0 || el.tagName === 'CANVAS';
      // Reading every ancestor's innerText/geometry can repeatedly lay out a
      // large feed. Only controls need boxes and accessible names.
      const box = control ? el.getBoundingClientRect() : null;
      if (box && (box.width > 0 || box.height > 0)) {
        // A site's show-password toggle or same-document navigation must not
        // turn an opaque host-filled password into a model-visible value.
        const privateValue = el.type === 'password' || state.credentialFields?.has(el);
        const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
        const label = normalized(el.getAttribute('aria-label') || labelled || (el.labels ? [...el.labels].map(l => l.textContent).join(' ') : '') || el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || el.getAttribute('data-placeholder') || el.textContent || el.getAttribute('title') || el.getAttribute('alt')).slice(0, 300);
        let ref = state.ids.get(el); if (!ref) { ref = `${prefix}:${state.documentId}:${++state.next}`; state.ids.set(el, ref); }
        if (!query || `${label} ${!privateValue && 'value' in el ? el.value : ''}`.toLowerCase().includes(query.toLowerCase())) {
          state.elements.set(ref, el); seen.add(ref);
          items.push({ ref, role: role || (el.isContentEditable ? 'textbox' : el.tagName === 'CANVAS' ? 'canvas' : 'element'), name: label, tag: el.tagName.toLowerCase(), ...(el.type ? { type: el.type } : {}), ...(!privateValue && 'value' in el ? { value: String(el.value).slice(0, 300) } : {}), ...(el.disabled ? { disabled: true } : {}), ...(el.checked ? { checked: true } : {}), ...(el.getAttribute('aria-expanded') ? { expanded: el.getAttribute('aria-expanded') } : {}), ...(el.tagName === 'A' ? { href: el.href } : {}), ...(el.tagName === 'SELECT' ? { options: [...el.options].slice(0, 80).map(o => ({ value: o.value, label: o.label })) } : {}) });
        }
      }
      for (const node of el.childNodes) if (node.nodeType === 3) { const value = normalized(node.textContent); if (value && (!query || value.toLowerCase().includes(query.toLowerCase()))) text.push(value); }
      if (el.shadowRoot) walk(el.shadowRoot);
      walk(el);
    }
  }
  walk(document.documentElement);
  // The host retires every previous snapshot's refs. Keep only this bounded
  // result, including when a query skips many otherwise connected controls.
  for (const ref of state.elements.keys()) if (!seen.has(ref)) state.elements.delete(ref);
  return { title: document.title, url: location.href, elements: query ? items.filter(i => `${i.name} ${i.value || ''}`.toLowerCase().includes(query.toLowerCase())) : items, text: text.join('\n').slice(0, 22000), truncated, readyState: document.readyState };
}

async function smoothPageScroll(target, top, left) {
  const position = () => ({ scrollTop: target.scrollTop, scrollLeft: target.scrollLeft });
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  target.scrollBy({ top, left, behavior: reducedMotion ? 'instant' : 'smooth' });
  if (reducedMotion || !top && !left) return position();
  const started = performance.now(); let previous = position(), steady = 0;
  await new Promise(resolve => {
    const sample = () => {
      const current = position();
      if (Math.abs(current.scrollTop - previous.scrollTop) < 0.5 && Math.abs(current.scrollLeft - previous.scrollLeft) < 0.5) steady++;
      else { previous = current; steady = 0; }
      const elapsed = performance.now() - started;
      if (elapsed >= 120 && steady >= 3 || elapsed >= 1800) { resolve(); return; }
      setTimeout(sample, 40);
    };
    setTimeout(sample, 40);
  });
  return position();
}

function elementAction(key, ref, action, args, scrollPage) {
  const el = globalThis[key]?.elements.get(ref);
  if (!el?.isConnected) return { __blackiceElementError: { message: 'This element ref is stale. Take a new snapshot and choose its current ref.', code: 'BROWSER_REF_STALE' } };
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('This element is disabled. Inspect what is required first.');
  if (action === 'prepare') {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    let host = el, shadowMatch = false;
    while (host?.getRootNode()?.host) { host = host.getRootNode().host; if (host === top) shadowMatch = true; }
    if (top && top !== el && !el.contains(top) && !top.contains(el) && !shadowMatch) throw new Error('Another element covers this target. Inspect the page and dismiss or use the covering control.');
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, viewportWidth: innerWidth, viewportHeight: innerHeight };
  }
  if (action === 'click') { el.click(); return { clicked: true }; }
  if (action === 'focus') { el.focus({ preventScroll: true }); return { focused: document.activeElement === el || el.getRootNode()?.activeElement === el }; }
  if (action === 'fill') {
    if (el.readOnly) throw new Error('This field is read only.');
    if (el.isContentEditable) {
      el.focus({ preventScroll: true });
      const selection = el.ownerDocument.getSelection(), range = el.ownerDocument.createRange();
      range.selectNodeContents(el); selection.removeAllRanges(); selection.addRange(range);
      return { needsTrustedTextInput: true };
    }
    else {
      if (!['INPUT', 'TEXTAREA'].includes(el.tagName) || ['file','checkbox','radio','button','submit'].includes(el.type)) throw new Error('Choose a text field to fill.');
      const setter = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
      setter.call(el, args.text);
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: args.text }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true })); return { filled: true, characters: args.text.length };
  }
  if (action === 'select') {
    if (el.tagName !== 'SELECT') throw new Error('This is not a native select. Click it and inspect the available options.');
    if (![...el.options].some(o => o.value === args.value)) throw new Error('Select value is not available.');
    el.value = args.value; el.dispatchEvent(new Event('input', { bubbles: true, composed: true })); el.dispatchEvent(new Event('change', { bubbles: true, composed: true })); return { selected: el.value };
  }
  if (action === 'upload') {
    if (el.tagName !== 'INPUT' || el.type !== 'file') throw new Error('Choose a file input from a fresh snapshot.');
    if (el.webkitdirectory || !el.multiple && args.files.length > 1) throw new Error('Choose files matching this input; directory selection is not supported.');
    const transfer = new DataTransfer();
    for (const file of args.files) { const raw = atob(file.data); const bytes = Uint8Array.from(raw, c => c.charCodeAt(0)); transfer.items.add(new File([bytes], file.name, { type: file.type })); }
    el.files = transfer.files;
    const delivered = [...el.files].map(file => ({ name: file.name, size: file.size, type: file.type }));
    if (delivered.length !== args.files.length || args.files.some((file, index) => { const actual = delivered[index]; return !actual || actual.name !== file.name || actual.size !== file.size || actual.type !== file.type; })) return { delivered, uploaded: delivered, eventsDispatched: false };
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true })); el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return { delivered, uploaded: [...el.files].map(file => ({ name: file.name, size: file.size, type: file.type })), eventsDispatched: true };
  }
  if (action === 'scroll') return scrollPage(el, args.top, args.left);
  throw new Error('Unsupported element action.');
}

async function elementActionResult(run, scrollPage, key, ref, action, args) {
  try { return await run(key, ref, action, args, scrollPage); }
  catch (reason) {
    // Preserve non-enumerable Error.message before the renderer result crosses
    // Electron's process boundary. Unknown failures cannot prove no side effect.
    const message = typeof reason === 'string' ? reason : typeof reason?.message === 'string' ? reason.message : typeof reason?.description === 'string' ? reason.description : '';
    const code = typeof reason?.code === 'string' && reason.code.trim() ? reason.code.slice(0, 120) : typeof reason?.code === 'number' && Number.isFinite(reason.code) ? reason.code : 'BROWSER_ELEMENT_ACTION_FAILED';
    return { __blackiceElementError: { message: message.trim() ? message.slice(0, 1500) : 'The page could not complete this element action. Take a fresh snapshot and inspect before repeating it.', code } };
  }
}

// Host-only credential path. Validation runs once without a secret and again
// in the same renderer task as all writes. No page text or exception escapes.
function credentialFields(key, args, secret) {
  try {
    const current = globalThis[key];
    if (!current || current.document !== document || globalThis.origin !== args.origin || location.origin !== args.origin || location.href !== args.frameUrl || window.top.location.href !== args.expectedUrl) return { valid: false };
    const visible = el => {
      if (!el?.isConnected || el.ownerDocument?.defaultView?.origin !== args.origin || el.closest?.('[inert],[hidden]')) return false;
      const box = el.getBoundingClientRect(), style = el.ownerDocument.defaultView.getComputedStyle(el);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility) && Number(style.opacity) !== 0 && el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true }) === true;
    };
    for (let view = window; view !== view.top; view = view.parent) if (view.parent.origin !== args.origin || !visible(view.frameElement)) return { valid: false };
    const selected = [{ ref: args.passwordRef, password: true }, ...(args.confirmationRef ? [{ ref: args.confirmationRef, password: true }] : []), ...(args.usernameRef ? [{ ref: args.usernameRef, password: false }] : [])].map(item => ({ ...item, element: current.elements.get(item.ref) }));
    const editable = item => item.element instanceof HTMLInputElement && item.element.ownerDocument === document && visible(item.element) && item.element.tagName === 'INPUT' && !item.element.disabled && !item.element.readOnly && !item.element.matches(':disabled') && item.element.getAttribute('aria-disabled') !== 'true' && (item.password ? item.element.type === 'password' : ['text', 'email', 'tel'].includes(item.element.type));
    if (new Set(selected.map(item => item.element)).size !== selected.length || !selected.every(editable)) return { valid: false };
    if (secret === undefined) return { valid: true };
    if (!secret || secret.origin !== args.origin || secret.credentialId !== args.credentialId || secret.revision !== args.revision || typeof secret.password !== 'string' || !secret.password || secret.password.length > 4096 || args.usernameRef && (typeof secret.username !== 'string' || !secret.username)) return { valid: false };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (typeof setter !== 'function') return { valid: false };
    current.credentialFields ||= new WeakSet();
    for (const item of selected) if (item.password) current.credentialFields.add(item.element);
    // All fields are checked before any secret write; values are assigned
    // before site event handlers run. This path never clicks or submits.
    for (const item of selected) {
      if (!editable(item) || globalThis.origin !== args.origin || window.top.location.href !== args.expectedUrl) return { valid: false };
      setter.call(item.element, item.password ? secret.password : secret.username);
    }
    for (const item of selected) {
      item.element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: null }));
      item.element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }
    return { valid: true, filled: true };
  } catch { return { valid: false }; }
}

// CDP resolves the actual intercepted input, including display:none inputs.
// No local path or privileged application object is exposed to page JavaScript.
function assignChosenFiles(files) {
  if (!this.isConnected || this.tagName !== 'INPUT' || this.type !== 'file' || this.disabled || this.webkitdirectory) throw new Error('The selected file input changed or requires a directory. Choose files again on the current page.');
  if (!this.multiple && files.length > 1) throw new Error('This file input accepts only one file.');
  const transfer = new DataTransfer();
  for (const file of files) { const raw = atob(file.data); transfer.items.add(new File([Uint8Array.from(raw, c => c.charCodeAt(0))], file.name, { type: file.type })); }
  this.files = transfer.files;
  const delivered = [...this.files].map(file => ({ name: file.name, size: file.size, type: file.type }));
  if (delivered.length !== files.length || files.some((file, index) => { const actual = delivered[index]; return !actual || actual.name !== file.name || actual.size !== file.size || actual.type !== file.type; })) return { delivered, uploaded: delivered, eventsDispatched: false };
  this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  return { delivered, uploaded: [...this.files].map(file => ({ name: file.name, size: file.size, type: file.type })), eventsDispatched: true };
}

export class ElectronBrowserDriver extends EventEmitter {
  constructor({ dataDir, downloadDir, maxTabs = 8, maxLiveTabs = 32, maxTaskTabs = 8, maxSavedTabs = 256, protection } = {}) {
    super();
    if (![maxTabs, maxLiveTabs, maxTaskTabs, maxSavedTabs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 1024)) throw error('Browser capacity limits must be positive whole numbers up to 1024.');
    this.dataDir = dataDir; this.downloadDir = downloadDir; this.maxTabs = maxTabs; this.maxLiveTabs = maxLiveTabs; this.maxTaskTabs = maxTaskTabs; this.maxSavedTabs = maxSavedTabs; this.tabs = new Map(); this.folders = new Map([[DEFAULT_FOLDER, { id: DEFAULT_FOLDER, name: 'Personal', kind: 'user', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]]); this.ownerActiveTabs = new Map(); this.downloads = []; this.activeTab = null; this.key = `__relay_${randomUUID().replaceAll('-', '')}`; this.writeChain = Promise.resolve(); this.closed = false;
    // Retire the 2.4.2 partition that could contain transferred site credentials.
    // Preserve its files offline; never open it or replay its cookies again.
    this.session = session.fromPartition('persist:relay-agent-browser-v2');
    this.compatibilityLoaded = false;
    this.compatibilityReady = loadBrowserCompatibility(this.session).then(() => { this.compatibilityLoaded = true; });
    this.compatibilityReady.catch(() => {});
    this.protection = protection || new BrowserProtection({ dataDir });
    this.protectionListener = () => this.emit('changed'); this.protection.on('updated', this.protectionListener);
    // This dedicated partition owns one request interceptor. The app window's
    // independent default-session containment policy is left unchanged.
    this.beforeRequest = (details, callback) => {
      let blocked = false;
      try {
        const tab = [...this.tabs.values()].find(item => item.window && !item.window.isDestroyed() && item.window.webContents.id === details.webContentsId);
        const sourceUrl = tab ? tab.window.webContents.getURL() : details.initiator || details.referrer || '';
        const result = this.protection.match({ url: details.url, type: details.resourceType, sourceUrl, tabId: tab?.id });
        blocked = result.cancel === true;
      } catch {}
      callback({ cancel: blocked });
    };
    this.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, this.beforeRequest);
    this.diagnostics = new BrowserDiagnostics();
    this.cookieListener = (_event, cookie, cause, removed) => this.diagnostics.cookie(cookie, cause, removed);
    this.session.cookies.on('changed', this.cookieListener);
    this.session.webRequest.onCompleted(details => this.diagnostics.request(details));
    this.session.webRequest.onErrorOccurred(details => this.diagnostics.request(details));
    // BLACKICE grants web capabilities in this dedicated browsing profile without approval prompts.
    // OS permission checks and device selection remain separate.
    this.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(true));
    this.session.setPermissionCheckHandler(() => true);
    this.session.setDevicePermissionHandler(() => true);
    this.session.setUSBProtectedClassesHandler(() => []);
    this.fileSystemAccessListener = (_event, _details, callback) => callback('allow');
    this.session.on('file-system-access-restricted', this.fileSystemAccessListener);
    this.downloadListener = (_event, item, contents) => this.download(item, contents);
    this.session.on('will-download', this.downloadListener);
  }
  async init() {
    await this.compatibilityReady;
    await fs.mkdir(this.downloadDir, { recursive: true });
    await this.protection.init();
    let saved; try { saved = JSON.parse(await fs.readFile(path.join(this.dataDir, 'browser-tabs.json'), 'utf8')); } catch {}
    const entries = Array.isArray(saved) ? saved : saved?.version === 2 && Array.isArray(saved.tabs) ? saved.tabs : [];
    if (saved?.version === 2 && Array.isArray(saved.folders)) for (const entry of saved.folders.slice(0, this.maxSavedTabs)) {
      try {
        if (!validId(entry.id) || !['user', 'task'].includes(entry.kind) || entry.id === DEFAULT_FOLDER && entry.kind !== 'user' || entry.kind === 'task' && (typeof entry.taskId !== 'string' || !entry.taskId || entry.taskId.length > 200)) continue;
        this.folders.set(entry.id, { id: entry.id, name: folderName(entry.name), kind: entry.kind, ...(entry.kind === 'task' ? { taskId: entry.taskId } : {}), createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(), updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString() });
      } catch {}
    }
    this.restoring = true;
    try {
      for (const entry of entries.slice(0, this.maxSavedTabs)) try {
        const owner = entry.owner ? browserOwner(entry.owner) : null;
        this.newTab(browserURL(entry.url), { restore: true, id: validId(entry.tabId) && !this.tabs.has(entry.tabId) ? entry.tabId : undefined, title: typeof entry.title === 'string' ? entry.title : '', purpose: entry.purpose === 'chat-mode' ? 'chat-mode' : null, owner, folderId: this.folders.has(entry.folderId) ? entry.folderId : undefined });
      } catch {}
      for (const entry of entries) {
        const tab = this.tabs.get(entry.tabId), parent = this.tabs.get(entry.parentTabId);
        if (tab && parent && tab.id !== parent.id && tab.folderId === parent.folderId && sameOwner(tab.owner, parent.owner)) {
          let ancestor = parent, cycle = false;
          for (const seen = new Set([tab.id]); ancestor; ancestor = this.tabs.get(ancestor.parentTabId)) { if (seen.has(ancestor.id)) { cycle = true; break; } seen.add(ancestor.id); }
          if (!cycle) tab.parentTabId = parent.id;
        }
      }
      this.activeTab = this.tabs.has(saved?.activeTab) ? saved.activeTab : this.tabs.keys().next().value || null;
    } finally { this.restoring = false; }
    return this;
  }
  tabURL(tab) {
    const actual = tab.window?.webContents.getURL();
    return tab.pendingURL || tab.preparingURL || (tab.loadError ? tab.url : /^https?:/.test(actual || '') ? actual : tab.url || actual);
  }
  liveTabs() { return [...this.tabs.values()].filter(tab => tab.window && !tab.window.isDestroyed()); }
  status() {
    const live = this.liveTabs();
    return { contained: true, canShow: false, protection: this.protection.status(), persistence: { healthy: !this.persistenceError, ...(this.persistenceError ? { error: 'Browser folders and pages could not be saved.' } : {}) }, folders: [...this.folders.values()].map(folder => ({ ...folder })), capacity: { live: live.filter(tab => tab.purpose !== 'chat-mode').length, maxLive: this.maxLiveTabs, saved: this.tabs.size, maxSaved: this.maxSavedTabs, perTaskLive: this.maxTaskTabs }, ownerActiveTabs: Object.fromEntries(this.ownerActiveTabs), tabs: [...this.tabs.values()].map(t => ({ tabId: t.id, folderId: t.folderId, parentTabId: t.parentTabId || null, ...(t.owner ? { owner: { ...t.owner } } : {}), ...(t.purpose === 'chat-mode' ? { purpose: 'chat-mode' } : {}), url: this.tabURL(t), title: t.pendingURL ? t.title : t.window?.webContents.getTitle() || t.title, loading: !t.pendingURL && Boolean(t.window?.webContents.isLoading()), visible: Boolean(t.window?.isVisible()), contained: true, canShow: false, protection: this.protection.tabStatus(t.id, this.tabURL(t)), suspended: !t.window || Boolean(t.pendingURL), interactionSettling: t.suspendedWork.size > 0, ...(t.rendererFailure ? { rendererFailure: { ...t.rendererFailure } } : {}), ...(t.pendingInteraction ? { pendingInteraction: structuredClone(t.pendingInteraction) } : {}) })), activeTab: this.activeTab, downloads: this.downloads.filter((item, index) => item.status === 'downloading' || index >= this.downloads.length - 20), activeDownloads: this.downloads.filter(item => item.status === 'downloading').length, profile: 'BLACKICE contained browser · saved locally', ...(this.diagnostics ? { diagnostics: this.diagnostics.snapshot() } : {}) };
  }
  protectionStatus() { return { ...this.protection.status(), tabs: [...this.tabs.values()].map(tab => ({ tabId: tab.id, ...this.protection.tabStatus(tab.id, this.tabURL(tab)) })) }; }
  async configureProtection(options, { signal } = {}) {
    if (this.closed) throw Object.assign(error('The browser workspace is closing.'), { code: 'BROWSER_CLOSED' });
    await this.protection.configure(options, { signal, currentOrigin: id => { const tab = this.tabs.get(id); return tab ? protectionOrigin(this.tabURL(tab)) : null; } });
    return this.protectionStatus();
  }
  persist() {
    if (this.restoring || this.closed) return;
    const entries = [...this.tabs.values()].filter(t => /^https?:/.test(this.tabURL(t))).map(t => ({ tabId: t.id, url: this.tabURL(t), title: t.window?.webContents.getTitle() || t.title || '', folderId: t.folderId, parentTabId: t.parentTabId || null, ...(t.owner ? { owner: { ...t.owner } } : {}), ...(t.purpose === 'chat-mode' ? { purpose: 'chat-mode' } : {}) }));
    const saved = { version: 2, folders: [...this.folders.values()].map(folder => ({ ...folder })), tabs: entries, activeTab: this.activeTab };
    // Navigation and title events can arrive faster than the disk can flush.
    // Retain one latest pending snapshot instead of an unbounded promise queue
    // of obsolete tab trees. The shared drain still backs every save receipt.
    this.pendingPersistence = saved;
    if (this.persistenceRunning) return;
    this.persistenceRunning = true;
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      try {
        while (this.pendingPersistence) {
          const next = this.pendingPersistence; this.pendingPersistence = null;
          try {
            const file = path.join(this.dataDir, 'browser-tabs.json');
            await fs.writeFile(`${file}.tmp`, JSON.stringify(next)); await fs.rename(`${file}.tmp`, file);
            const recovered = Boolean(this.persistenceError); this.persistenceError = null;
            if (recovered) this.emit('changed');
          } catch (cause) {
            const changed = this.persistenceError !== cause.message; this.persistenceError = cause.message;
            if (changed) this.emit('changed');
          }
        }
      } finally { this.persistenceRunning = false; }
    });
  }
  async flushPersistence() {
    if (this.closed) throw Object.assign(error('The browser workspace is closing.'), { code: 'BROWSER_CLOSED' });
    this.persist();
    let saved;
    do { saved = this.writeChain; await saved; } while (saved !== this.writeChain);
    if (this.persistenceError) throw Object.assign(error('Browser folders and pages could not be saved. Keep the browser open and retry after storage is available.'), { code: 'BROWSER_SAVE_FAILED' });
    return this.status();
  }
  async savedStatus(extra = {}) {
    await this.writeChain;
    if (this.persistenceError) throw Object.assign(error('The browser changed in memory, but its folder and page state could not be saved. Inspect the current browser state before repeating the action.'), { code: 'BROWSER_SAVE_FAILED', actionDispatched: true });
    return { ...this.status(), ...extra };
  }
  folderFor(owner, folderId) {
    if (folderId != null) {
      const folder = this.folders.get(folderId);
      if (!folder || owner && (folder.kind !== 'task' || folder.taskId !== owner.taskId)) throw capacityError('Choose a browser folder belonging to this task.', 'BROWSER_FOLDER_OWNERSHIP');
      return folder;
    }
    if (!owner) return this.folders.get(DEFAULT_FOLDER);
    const id = `task_${createHash('sha256').update(owner.taskId).digest('hex').slice(0, 32)}`;
    if (!this.folders.has(id)) {
      if (this.folders.size >= this.maxSavedTabs) throw capacityError('The saved browser folder capacity is full. Remove an unneeded folder in the browser workspace.', 'BROWSER_FOLDER_LIMIT');
      const now = new Date().toISOString(); this.folders.set(id, { id, name: owner.label || `Task ${owner.taskId}`, kind: 'task', taskId: owner.taskId, createdAt: now, updatedAt: now });
    }
    const folder = this.folders.get(id);
    if (folder.kind !== 'task' || folder.taskId !== owner.taskId) throw capacityError('The task browser folder identity conflicts with saved data.', 'BROWSER_FOLDER_OWNERSHIP');
    return folder;
  }
  hasTabCapacity(purpose = null, owner = null) {
    if (purpose === 'chat-mode') return ![...this.tabs.values()].some(tab => tab.purpose === 'chat-mode');
    if (this.tabs.size >= this.maxSavedTabs) return false;
    const live = this.liveTabs().filter(tab => tab.purpose !== 'chat-mode');
    if (live.length >= this.maxLiveTabs) return false;
    return owner ? live.filter(tab => tab.owner?.taskId === owner.taskId).length < this.maxTaskTabs : [...this.tabs.values()].filter(tab => tab.purpose !== 'chat-mode' && !tab.owner).length < this.maxTabs;
  }
  assertLiveCapacity(tab) {
    if (tab.purpose === 'chat-mode') return;
    const live = this.liveTabs().filter(item => item.purpose !== 'chat-mode');
    if (live.length >= this.maxLiveTabs) throw capacityError(`The browser has ${this.maxLiveTabs} live pages. Suspend a page in the browser workspace, or wait for another task to finish. Existing pages were preserved.`, 'BROWSER_LIVE_LIMIT');
    if (tab.owner && live.filter(item => item.owner?.taskId === tab.owner.taskId).length >= this.maxTaskTabs) throw capacityError(`This task has ${this.maxTaskTabs} live pages. Reuse or close one of its own pages before opening another.`, 'BROWSER_TASK_TAB_LIMIT');
  }
  newTab(url, { restore = false, title = '', window: suppliedWindow, purpose = null, owner: context, folderId, parentTabId = null, id } = {}) {
    if (this.closed) throw error('Browser workspace has closed.');
    let owner = browserOwner(context);
    if (purpose !== null && purpose !== 'chat-mode') throw error('Use a supported contained browser tab purpose.');
    if (purpose === 'chat-mode' && owner) throw capacityError('The human ChatGPT tab cannot belong to an agent task.', 'BROWSER_HUMAN_CHAT_RESERVED');
    const parent = parentTabId ? this.tabs.get(parentTabId) : null;
    if (parentTabId && (!parent || parent.purpose === 'chat-mode' || owner && !sameOwner(parent.owner, owner))) throw capacityError('Choose a parent tab owned by this worker.', 'BROWSER_TAB_OWNERSHIP');
    if (parent && folderId != null && folderId !== parent.folderId) throw capacityError('A child tab must remain in its parent folder.', 'BROWSER_FOLDER_VALIDATION');
    if (!owner && parent?.owner) owner = { ...parent.owner };
    const folder = this.folderFor(owner, parent?.folderId || folderId);
    if (!owner && folder.kind === 'task') owner = { taskId: folder.taskId, runId: 'user', nodeId: 'user' };
    if (this.tabs.size >= this.maxSavedTabs) throw capacityError('The saved browser page capacity is full. Close an unneeded page in the browser workspace.', 'BROWSER_SAVED_LIMIT');
    if (purpose === 'chat-mode' && !this.hasTabCapacity(purpose)) throw capacityError('The dedicated human ChatGPT tab is already open.', 'BROWSER_CHAT_MODE_TAB_EXISTS');
    if (!restore && purpose !== 'chat-mode' && !owner && [...this.tabs.values()].filter(tab => tab.purpose !== 'chat-mode' && !tab.owner).length >= this.maxTabs) throw capacityError(`Use at most ${this.maxTabs} personal browser tabs. Close one before opening another; task folders have separate capacity.`, 'BROWSER_TAB_LIMIT');
    const tab = { id: id || randomUUID(), url, title, purpose, folderId: folder.id, parentTabId: parent?.id || null, owner: ownerRecord(owner), pendingURL: restore && !suppliedWindow ? url : null, preparingURL: !restore && !suppliedWindow ? url : null, window: null, refs: new Map(), revision: 0, interactionWaiters: new Set(), rendererWaiters: new Set(), suspendedWork: new Set(), loading: Promise.resolve() };
    if (!restore) this.assertLiveCapacity(tab);
    this.tabs.set(tab.id, tab);
    if (owner) this.ownerActiveTabs.set(browserOwnerKey(owner), tab.id); else this.activeTab = tab.id;
    try { if (!restore || suppliedWindow) this.materialize(tab, suppliedWindow); }
    catch (cause) { this.removeTab(tab); throw cause; }
    if (!restore) { this.persist(); this.emit('changed'); }
    return tab;
  }
  materialize(tab, suppliedWindow) {
    if (tab.rendererFailure) throw rendererFailure(tab);
    if (tab.window && !tab.window.isDestroyed()) return;
    this.assertLiveCapacity(tab);
    if (suppliedWindow && !this.compatibilityLoaded) {
      suppliedWindow.destroy(); throw capacityError('The contained browser compatibility extension is not ready. No popup was adopted.', 'BROWSER_COMPATIBILITY_NOT_READY');
    }
    if (suppliedWindow && (suppliedWindow.webContents.isOffscreen?.() !== true || suppliedWindow.isVisible() || suppliedWindow.isFocusable())) {
      suppliedWindow.destroy(); throw error('The browser popup could not remain contained. Use the Observe view to inspect the original page.');
    }
    const window = suppliedWindow || new BrowserWindow(containedWindowOptions(this.session));
    window.removeMenu();
    tab.window = window; tab.suspending = false; tab.closing = false;
    tab.popupViewport = suppliedWindow ? { ready: false, resetRequired: false, pending: null } : null;
    const wc = window.webContents;
    wc.on('render-process-gone', (_event, details) => this.rendererGone(tab, window, details));
    wc.on('login', (event, _details, _authInfo, callback) => {
      event.preventDefault(); callback();
      tab.inputWarning = 'HTTP authentication was cancelled. This contained browser does not accept credentials through a native login prompt.';
      this.setInteraction(tab, { kind: 'http_auth', status: 'blocked', message: tab.inputWarning, reason: 'http_auth_unsupported' });
    });
    wc.debugger.on('message', (_event, method, params) => {
      if (method === 'Page.fileChooserOpened') {
        const supported = Number.isSafeInteger(params?.backendNodeId) && params.backendNodeId > 0;
        tab.inputWarning = supported ? 'This page requested files. Choose explicit file paths in BLACKICE, or cancel this selection.' : 'This file request does not expose a contained input. No native file picker was opened.';
        this.setInteraction(tab, { kind: 'file_chooser', status: supported ? 'pending' : 'blocked', message: tab.inputWarning, multiple: params?.mode === 'selectMultiple', ...(supported ? {} : { reason: 'file_input_unavailable' }) }, supported ? { backendNodeId: params.backendNodeId } : null);
      } else if (method === 'Page.javascriptDialogOpening') {
        // An observed native dialog is resolvable through CDP even when
        // Electron reports its own browser handler. A subsequent closed event
        // retires that exact decision if the page or browser resolves it first.
        const supported = ['alert', 'confirm', 'prompt', 'beforeunload'].includes(params?.type);
        this.setInteraction(tab, { kind: 'javascript_dialog', status: supported ? 'pending' : 'blocked', dialogType: supported ? params.type : 'unknown', message: interactionText(params?.message), ...(supported ? {} : { reason: 'dialog_type_unsupported' }) });
      } else if (method === 'Page.javascriptDialogClosed' && tab.pendingInteraction?.kind === 'javascript_dialog') {
        tab.pendingInteraction = { ...tab.pendingInteraction, status: 'blocked', reason: params?.result === true ? 'dialog_closed_elsewhere' : 'dialog_cancelled', closedAt: new Date().toISOString() };
        this.emit('changed');
      }
    });
    wc.debugger.on('detach', () => { tab.containmentReady = null; this.clearInteraction(tab); });
    wc.setWindowOpenHandler(({ url }) => {
      try { if (url && url !== 'about:blank') browserURL(url); if (this.closed || !this.compatibilityLoaded || !this.hasTabCapacity(null, tab.owner)) return { action: 'deny' }; }
      catch { return { action: 'deny' }; }
      // Preserve window.opener for OAuth while rendering the popup only inside BLACKICE.
      return { action: 'allow', overrideBrowserWindowOptions: containedWindowOptions(this.session) };
    });
    wc.on('did-create-window', (child, details) => {
      if (this.closed || !this.compatibilityLoaded || !this.hasTabCapacity(null, tab.owner)) child.destroy();
      else try { this.newTab(details.url || 'about:blank', { window: child, owner: tab.owner, folderId: tab.folderId, parentTabId: tab.id }); } catch { if (!child.isDestroyed()) child.destroy(); }
    });
    wc.on('will-attach-webview', event => event.preventDefault());
    const navigated = () => { tab.revision++; tab.refs.clear(); this.clearInteraction(tab); this.persist(); this.emit('changed'); };
    wc.on('did-frame-navigate', (_event, _url, _responseCode, _statusText, isMainFrame) => {
      // Only a new top-level document retires the capture restriction. Hash
      // changes, SPA routes and child navigations can retain a filled field.
      if (isMainFrame === true) tab.credentialCaptureBlocked = false;
      navigated();
    });
    wc.on('did-navigate-in-page', navigated);
    wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => { if (isMainFrame !== false && code !== -3) { tab.loadError = String(description || `Navigation failed (${code}).`); this.emit('changed'); } });
    wc.on('page-title-updated', (_event, value) => { tab.title = value; this.persist(); this.emit('changed'); });
    wc.on('will-navigate', (event, target) => { try { browserURL(target); } catch { event.preventDefault(); } });
    wc.on('will-redirect', (event, target) => { try { browserURL(target); } catch { event.preventDefault(); } });
    window.on('close', event => {
      // A script-opened authentication window must be able to finish its own
      // native close lifecycle, so the opener observes window.closed normally.
      if (suppliedWindow) return;
      if (!this.closed && !tab.closing) { event.preventDefault(); window.hide(); this.emit('changed'); }
    });
    window.on('closed', () => {
      // An old renderer can finish closing after an explicit recovery created
      // its replacement. It must not remove that replacement's saved tab.
      if (tab.window !== window) return;
      tab.window = null;
      if (!tab.suspending) this.removeTab(tab);
      if (!this.closed) { this.persist(); this.emit('changed'); }
    });
    // A new offscreen WebContents needs an inert renderer before Page protocol
    // commands can complete. Never load a website until its native-picker guard
    // and session-wide document-start compatibility script are ready. Restored
    // website URLs remain suspended behind the same guards.
    tab.rendererReady = suppliedWindow ? Promise.resolve() : wc.loadURL('about:blank'); tab.rendererReady.catch(() => {});
    const containment = this.ensureContained(tab); containment.catch(() => {});
    tab.navigationDispatched = Boolean(suppliedWindow);
    tab.loading = suppliedWindow || tab.pendingURL ? Promise.resolve() : containment.then(() => { if (tab.window !== window || tab.rendererFailure) throw rendererFailure(tab); tab.preparingURL = null; tab.navigationDispatched = true; return wc.loadURL(tab.url); }).catch(reason => { if (tab.window === window) tab.loadError = reason.message; });
  }
  tab(id) { const tab = this.tabs.get(id || this.activeTab); if (!tab || tab.window?.isDestroyed()) throw error('Choose an existing browser tab, or open a URL first.'); return tab; }
  removeTab(tab) {
    this.tabs.delete(tab.id); this.protection.forgetTab(tab.id);
    for (const child of this.tabs.values()) if (child.parentTabId === tab.id) child.parentTabId = this.tabs.has(tab.parentTabId) ? tab.parentTabId : null;
    for (const [key, id] of this.ownerActiveTabs) if (id === tab.id) { const next = [...this.tabs.values()].find(item => browserOwnerKey(item.owner) === key); if (next) this.ownerActiveTabs.set(key, next.id); else this.ownerActiveTabs.delete(key); }
    if (this.activeTab === tab.id) this.activeTab = [...this.tabs.values()].find(item => !item.owner)?.id || this.tabs.keys().next().value || null;
  }
  closeTab(tab) {
    tab.closing = true; tab.suspending = false;
    if (tab.window && !tab.window.isDestroyed()) tab.window.destroy(); else this.removeTab(tab);
    this.persist(); this.emit('changed');
  }
  rendererGone(tab, window, details = {}) {
    if (this.closed || tab.closing || tab.suspending || tab.window !== window) return;
    // Preserve the page identity, but discard every renderer-owned target and
    // release the dead window's native resources. Never replay a website load
    // or input here: even a completed click may have lost its response.
    try { tab.url = this.tabURL(tab); tab.title = window.webContents.getTitle() || tab.title; } catch {}
    const reasons = ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure'];
    tab.rendererFailure = { reason: reasons.includes(details.reason) ? details.reason : 'unknown', ...(Number.isInteger(details.exitCode) ? { exitCode: details.exitCode } : {}), at: new Date().toISOString() };
    tab.pendingURL = tab.url; tab.preparingURL = null; tab.revision++; tab.refs.clear();
    this.clearInteraction(tab); tab.suspendedWork.clear();
    tab.containmentReady = null; tab.rendererReady = null; tab.loading = Promise.resolve();
    for (const notify of tab.rendererWaiters || []) notify();
    tab.rendererWaiters?.clear();
    tab.window = null;
    try { if (!window.isDestroyed()) window.destroy(); } catch {}
    this.persist(); this.emit('changed');
  }
  suspendTab(tab, { automatic = false } = {}) {
    if (!tab.window) return { suspended: true, alreadySuspended: true };
    if (automatic && tab.userPinned) return { suspended: false, reason: 'The person interacted with this page; keep it open until they suspend or close it.' };
    if (tab.pendingInteraction || tab.suspendedWork.size) return { suspended: false, reason: 'A website interaction still requires inspection.' };
    if (this.downloads.some(item => item.tabId === tab.id && item.status === 'downloading')) return { suspended: false, reason: 'A download is still running.' };
    tab.url = this.tabURL(tab); tab.title = tab.window.webContents.getTitle() || tab.title; tab.pendingURL = tab.url; tab.preparingURL = null;
    tab.revision++; tab.refs.clear(); tab.suspending = true; tab.userPinned = false; tab.containmentReady = null; tab.rendererReady = null; tab.loading = Promise.resolve();
    tab.window.destroy(); tab.window = null; this.persist(); this.emit('changed');
    return { suspended: true };
  }
  async releaseOwner(context) {
    const owner = browserOwner(context), suspended = [], retained = [];
    if (!owner) throw capacityError('A host browser owner is required for cleanup.', 'BROWSER_OWNER_INVALID');
    for (const tab of this.tabs.values()) if (tab.purpose !== 'chat-mode' && sameOwner(tab.owner, owner) && tab.owner.runId === owner.runId) {
      const result = this.suspendTab(tab, { automatic: true }); if (result.suspended) suspended.push(tab.id); else retained.push({ tabId: tab.id, reason: result.reason });
    }
    await this.writeChain;
    if (this.persistenceError) throw Object.assign(error('Browser pages were suspended, but their saved folder state could not be confirmed.'), { code: 'BROWSER_SAVE_FAILED' });
    return { suspended, retained };
  }
  async organize(args, source, context) {
    const owner = browserOwner(context);
    const assertFolder = folder => {
      if (owner && !(folder.kind === 'task' && folder.taskId === owner.taskId) && !(owner.allowUserTabs && folder.kind === 'user')) throw capacityError('Choose a browser folder belonging to this task.', 'BROWSER_FOLDER_OWNERSHIP');
    };
    const assertTab = tab => {
      if (source !== 'user' && tab.purpose === 'chat-mode') throw capacityError('The human ChatGPT tab is reserved for its caller.', 'BROWSER_HUMAN_CHAT_RESERVED');
      if (owner && !sameOwner(tab.owner, owner) && !(owner.allowUserTabs && !tab.owner)) throw capacityError('This browser tab belongs to another task.', 'BROWSER_TAB_OWNERSHIP');
    };
    if (args.action === 'folder_create') {
      if (this.folders.size >= this.maxSavedTabs) throw capacityError('The browser folder capacity is full.', 'BROWSER_FOLDER_LIMIT');
      const now = new Date().toISOString(), folder = { id: `folder_${randomUUID()}`, name: folderName(args.name), kind: owner ? 'task' : 'user', ...(owner ? { taskId: owner.taskId } : {}), createdAt: now, updatedAt: now };
      this.folders.set(folder.id, folder); this.persist(); this.emit('changed'); return this.savedStatus({ folder: { ...folder } });
    }
    if (args.action === 'folder_rename' || args.action === 'folder_close') {
      const folder = this.folders.get(args.folderId); if (!folder) throw capacityError('Choose an existing browser folder.', 'BROWSER_FOLDER_NOT_FOUND');
      assertFolder(folder);
      if (args.action === 'folder_rename') { folder.name = folderName(args.name); folder.updatedAt = new Date().toISOString(); }
      else {
        const affected = [...this.tabs.values()].filter(tab => tab.folderId === folder.id);
        affected.forEach(assertTab);
        for (const tab of affected) this.closeTab(tab);
        if (folder.id !== DEFAULT_FOLDER) this.folders.delete(folder.id);
      }
      this.persist(); this.emit('changed'); return this.savedStatus();
    }
    const tab = this.tab(args.tabId); assertTab(tab);
    if (args.action === 'suspend') { const receipt = this.suspendTab(tab); return this.savedStatus({ receipt: { tabId: tab.id, ...receipt } }); }
    if (args.action === 'tab_move') {
      const parent = args.parentTabId == null ? null : this.tabs.get(args.parentTabId), folder = this.folders.get(args.folderId || parent?.folderId || tab.folderId);
      if (!folder || args.parentTabId != null && !parent) throw capacityError('Choose an existing browser folder and parent tab.', 'BROWSER_FOLDER_NOT_FOUND');
      assertFolder(folder); if (parent) assertTab(parent);
      if (tab.purpose === 'chat-mode' || parent?.purpose === 'chat-mode' || (tab.owner ? folder.kind !== 'task' || folder.taskId !== tab.owner.taskId : folder.kind !== 'user')) throw capacityError('Keep task-owned and personal tabs in their own folders.', 'BROWSER_FOLDER_OWNERSHIP');
      if (parent && (parent.folderId !== folder.id || !sameOwner(parent.owner, tab.owner))) throw capacityError('A parent tab must have the same folder and task owner.', 'BROWSER_TAB_OWNERSHIP');
      const branch = new Set([tab.id]); let changed = true;
      while (changed) { changed = false; for (const child of this.tabs.values()) if (branch.has(child.parentTabId) && !branch.has(child.id)) { branch.add(child.id); changed = true; } }
      if (parent && branch.has(parent.id)) throw capacityError('A tab cannot become a child of its own branch.', 'BROWSER_TAB_CYCLE');
      for (const id of branch) assertTab(this.tabs.get(id));
      for (const id of branch) this.tabs.get(id).folderId = folder.id;
      tab.parentTabId = parent?.id || null; this.persist(); this.emit('changed'); return this.savedStatus();
    }
    throw capacityError('Choose a supported browser organization action.', 'BROWSER_VALIDATION');
  }
  setInteraction(tab, value, target = null) {
    const interaction = { id: `browser_input_${randomUUID()}`, tabId: tab.id, url: tab.window.webContents.getURL() || tab.url, documentId: inputDocumentId(tab), createdAt: new Date().toISOString(), ...value };
    tab.pendingInteraction = interaction; tab.interactionTarget = target;
    if (interaction.kind === 'javascript_dialog' && interaction.status === 'pending') for (const notify of tab.interactionWaiters) notify();
    this.emit('changed'); return interaction;
  }
  clearInteraction(tab) { tab.pendingInteraction = null; tab.interactionTarget = null; tab.inputWarning = null; }
  interactionReceipt(tab, extra = {}) {
    return { tabId: tab.id, url: tab.window.webContents.getURL(), documentId: inputDocumentId(tab), ...(tab.pendingInteraction ? { pendingInteraction: structuredClone(tab.pendingInteraction) } : {}), ...extra };
  }
  currentInteraction(tab, args) {
    this.assertInputDocument(tab, args);
    const value = tab.pendingInteraction;
    if (!value || value.id !== (args.interactionId || args.chooserId) || value.tabId !== tab.id || value.documentId !== inputDocumentId(tab) || value.url !== tab.window.webContents.getURL()) throw interactionChanged();
    return value;
  }
  async pageWork(tab, promise, signal, ms = 12000) {
    const native = Promise.resolve(promise); native.catch(() => {});
    let interrupted = false, notify, rendererGone;
    const pending = new Promise((_, reject) => { notify = () => { interrupted = true; reject(interactionError()); }; rendererGone = () => reject(rendererFailure(tab, true)); });
    tab.interactionWaiters.add(notify);
    (tab.rendererWaiters ||= new Set()).add(rendererGone);
    if (tab.rendererFailure) rendererGone();
    if (tab.pendingInteraction?.kind === 'javascript_dialog' && tab.pendingInteraction.status === 'pending') notify();
    try { return await bounded(Promise.race([native, pending]), signal, ms); }
    finally {
      tab.interactionWaiters.delete(notify);
      tab.rendererWaiters.delete(rendererGone);
      // A modal-suspended protocol operation is not a completed operation.
      // Keep it observed and reject unrelated input until an explicit decision
      // has released it; do not replay its original command on resolution.
      if (interrupted && !tab.rendererFailure) { tab.suspendedWork.add(native); native.finally(() => { tab.suspendedWork.delete(native); this.emit('changed'); }).catch(() => {}); }
    }
  }
  async resolveInteraction(tab, args, signal) {
    const current = this.currentInteraction(tab, args);
    if (current.status === 'blocked') {
      if (args.decision !== 'acknowledge' || args.promptText !== undefined) throw error('This interaction has already been blocked or cancelled. Acknowledge it, then inspect before choosing another action.');
      this.clearInteraction(tab); this.emit('changed');
      return this.interactionReceipt(tab, { receipt: { interactionId: current.id, acknowledged: true, replayed: false } });
    }
    if (current.kind === 'file_chooser') {
      if (args.decision !== 'dismiss' || args.promptText !== undefined) throw error('Upload explicitly chosen files, or dismiss this file request.');
      const backendNodeId = tab.interactionTarget?.backendNodeId;
      if (!Number.isSafeInteger(backendNodeId)) throw interactionChanged();
      await this.ensureContained(tab, signal); this.currentInteraction(tab, args); cancel(signal);
      await this.cdp(tab, 'DOM.setFileInputFiles', { files: [], backendNodeId }, signal);
    } else if (current.kind === 'javascript_dialog') {
      if (!['accept', 'dismiss'].includes(args.decision) || args.promptText !== undefined && (current.dialogType !== 'prompt' || args.decision !== 'accept')) throw error('Accept or dismiss this exact dialog; prompt text is only valid for accepting a prompt.');
      await this.ensureContained(tab, signal); this.currentInteraction(tab, args); cancel(signal);
      // This one command is deliberately outside pageWork: it releases the
      // modal that pageWork is observing, without queueing another DOM script.
      await this.cdp(tab, 'Page.handleJavaScriptDialog', { accept: args.decision === 'accept', ...(args.promptText !== undefined ? { promptText: args.promptText } : {}) }, signal);
    } else throw error('This interaction cannot be completed in the contained browser.');
    if (tab.pendingInteraction?.id === current.id) this.clearInteraction(tab);
    this.emit('changed');
    return this.interactionReceipt(tab, { receipt: { interactionId: current.id, decision: args.decision, replayed: false, inspectBeforeContinuing: true } });
  }
  async activate(tab, signal) {
    if (tab.rendererFailure) throw rendererFailure(tab);
    if (!tab.window) this.materialize(tab);
    await this.ensureContained(tab, signal);
    if (tab.pendingURL) {
      const url = tab.pendingURL; tab.pendingURL = null; tab.loadError = null; tab.navigationDispatched = true;
      const window = tab.window;
      tab.loading = window.webContents.loadURL(url).catch(reason => { if (tab.window === window) tab.loadError = reason.message; });
    }
    await this.pageWork(tab, tab.loading, signal, 20000);
    if (tab.popupViewport) await this.ensurePopupViewport(tab, signal);
  }
  async show() { throw Object.assign(error('Browser pages stay contained inside BLACKICE. Use the Observe view to inspect and control them.'), { code: 'BROWSER_CONTAINED' }); }
  async download(item, contents) {
    const fileName = path.basename(item.getFilename()).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'download';
    const target = path.join(this.downloadDir, `${Date.now()}-${randomUUID().slice(0,8)}-${fileName}`);
    item.setSavePath(target);
    const record = { id: randomUUID(), tabId: [...this.tabs.values()].find(t => t.window?.webContents === contents)?.id, name: fileName, path: target, status: 'downloading', receivedBytes: 0, totalBytes: item.getTotalBytes() };
    this.downloads.push(record); this.pruneDownloads();
    item.on('updated', () => { record.receivedBytes = item.getReceivedBytes(); record.totalBytes = item.getTotalBytes(); });
    item.once('done', (_event, state) => { record.status = state; this.pruneDownloads(); this.emit('changed'); }); this.emit('changed');
  }
  pruneDownloads() {
    // History is bounded; unfinished work is never history. Its source page
    // and restart admission must stay protected until Electron reports done.
    const cutoff = this.downloads.length - 100;
    this.downloads = this.downloads.filter((item, index) => index >= cutoff || item.status === 'downloading');
  }
  async snapshot(tab, query, signal) {
    if (tab.pendingInteraction?.status === 'pending') return this.interactionReceipt(tab, { frames: [] });
    if (tab.popupViewport) await this.ensurePopupViewport(tab, signal);
    cancel(signal); const frames = [], errors = []; let remainingElements = 400, remainingText = 24000;
    const deadline = Date.now() + 7000;
    tab.refs.clear();
    const mainFrame = tab.window.webContents.mainFrame;
    // Electron does not promise subtree traversal order. Ad-heavy pages can
    // have more descendants than the cap; always inspect their main document.
    const allFrames = [mainFrame, ...mainFrame.framesInSubtree.filter(frame => frame !== mainFrame)].slice(0, 30);
    for (const frame of allFrames) {
      cancel(signal);
      if (Date.now() >= deadline) { errors.push({ error: 'Snapshot time budget reached. Narrow the query to the controls you need.' }); break; }
      try {
        const prefix = `${tab.revision}-${frame.processId}-${frame.routingId}`;
        const value = await this.pageWork(tab, frame.executeJavaScript(`(${pageSnapshot.toString()})(${JSON.stringify(this.key)},${JSON.stringify(prefix)},${JSON.stringify(query || '')})`), signal, Math.max(1, Math.min(deadline - Date.now(), frame === mainFrame ? 5000 : 500)));
        if (value.elements.length > remainingElements || value.text.length > remainingText) value.truncated = true;
        value.elements = value.elements.slice(0, remainingElements); value.text = value.text.slice(0, remainingText);
        remainingElements -= value.elements.length; remainingText -= value.text.length;
        for (const item of value.elements) tab.refs.set(item.ref, frame);
        frames.push({ frame: `${frame.processId}-${frame.routingId}`, ...value });
        if (query && frame === mainFrame && value.elements.length) break;
      } catch (reason) { if (signal?.aborted || ['BROWSER_INTERACTION_PENDING', 'BROWSER_RENDERER_GONE'].includes(reason.code)) throw reason; errors.push({ frame: frame.url, error: reason.message }); }
    }
    return { tabId: tab.id, url: tab.window.webContents.getURL(), documentId: inputDocumentId(tab), title: tab.window.webContents.getTitle(), frames, ...(frames.some(f => f.truncated) ? { hint: 'Large page: supply query to narrow the controls/text, or scroll a virtualized region and inspect again.' } : {}), ...(errors.length ? { frameErrors: errors } : {}), ...(tab.loadError ? { navigationError: tab.loadError } : {}), ...(tab.inputWarning ? { inputWarning: tab.inputWarning } : {}), ...(tab.pendingInteraction ? { pendingInteraction: structuredClone(tab.pendingInteraction) } : {}) };
  }
  async element(tab, args, action, signal, extra = {}) {
    if (typeof args.ref !== 'string' || !tab.refs.has(args.ref)) throw Object.assign(error('Take a fresh snapshot and choose an element ref.'), { code: 'BROWSER_REF_STALE' });
    const frame = tab.refs.get(args.ref);
    const result = await this.pageWork(tab, frame.executeJavaScript(`(${elementActionResult.toString()})(${elementAction.toString()},${smoothPageScroll.toString()},${JSON.stringify(this.key)},${JSON.stringify(args.ref)},${JSON.stringify(action)},${JSON.stringify({ ...args, ...extra })})`), signal);
    if (result?.__blackiceElementError) {
      const { message, code } = result.__blackiceElementError;
      // An earlier preparation pass can already have scrolled the page. Keep
      // dispatch uncertainty even when this particular ref check sent no input.
      throw Object.assign(error(message), { code });
    }
    return { frame, result };
  }
  async prepareCredentialFill(value, { signal, source = 'agent', owner: context } = {}) {
    const args = browserCredentialTarget({ browser: 'relay', ...value }), tab = this.tab(args.tabId);
    const owner = browserOwner(context);
    const unavailable = () => Object.assign(error('The protected password target changed or could not be verified.'), { code: 'BROWSER_CREDENTIAL_TARGET_CHANGED' });
    if (source !== 'agent' || tab.purpose === 'chat-mode' || owner && !sameOwner(tab.owner, owner) && !(owner.allowUserTabs && !tab.owner)) throw unavailable();
    if (owner && tab.owner) tab.owner.runId = owner.runId;
    await this.activate(tab, signal); this.assertInputDocument(tab, args); cancel(signal);
    const refs = [args.passwordRef, args.confirmationRef, args.usernameRef].filter(Boolean), frame = tab.refs.get(args.passwordRef);
    if (!frame || refs.some(ref => tab.refs.get(ref) !== frame) || new URL(frame.url).origin !== args.origin) throw unavailable();
    const frameUrl = frame.url, input = { ...args, frameUrl };
    const assertCurrent = () => {
      cancel(signal); this.assertInputDocument(tab, args);
      if (this.closed || tab.window.isDestroyed() || tab.purpose === 'chat-mode' || tab.pendingInteraction || tab.suspendedWork.size || frame.url !== frameUrl || refs.some(ref => tab.refs.get(ref) !== frame)) throw unavailable();
    };
    const evaluate = secret => frame.executeJavaScript(`(${credentialFields.toString()})(${JSON.stringify(this.key)},${JSON.stringify(input)}${secret === undefined ? '' : ',' + JSON.stringify(secret)})`);
    assertCurrent();
    const verified = await this.pageWork(tab, evaluate(), signal);
    assertCurrent(); if (verified?.valid !== true) throw unavailable();
    let used = false;
    return async secret => {
      if (used) throw unavailable(); used = true;
      try {
        await this.ensureContained(tab, signal); assertCurrent();
        // This host-owned flag is set before an uncertain renderer write. A
        // site can reveal/hide a password during asynchronous capture, so a
        // field-type scan cannot safely authorize agent screenshots.
        tab.credentialCaptureBlocked = true;
        const result = await this.pageWork(tab, evaluate(secret), signal);
        if (result?.filled !== true) throw unavailable();
        cancel(signal);
        return { filled: true, submissionRequested: false };
      } catch { throw Object.assign(error('Credential filling could not be confirmed. Inspect the page before trying again.'), { code: 'BROWSER_CREDENTIAL_FILL_UNCONFIRMED' }); }
    };
  }
  assertInputDocument(tab, expected) {
    if (expected?.expectedDocumentId === undefined && expected?.expectedUrl === undefined) return;
    if (typeof expected.expectedDocumentId !== 'string' || typeof expected.expectedUrl !== 'string' || expected.expectedDocumentId !== inputDocumentId(tab) || expected.expectedUrl !== tab.window.webContents.getURL()) throw Object.assign(error('The page changed before keyboard or pointer input. Refresh the preview and click the intended field again.'), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
  }
  async cdp(tab, method, params = {}, signal, expected, sessionId) {
    if (tab.rendererFailure) throw rendererFailure(tab);
    const wc = tab.window.webContents;
    if (method.startsWith('Input.')) {
      await this.ensureContained(tab, signal);
      // A detach can invalidate the guard while the awaiting caller resumes.
      // Never reconnect and send this input under a fresh, unguarded session.
      if (!wc.debugger.isAttached() || !tab.containmentReady) throw Object.assign(error('The contained browser connection changed before input. Inspect the page and try the action again after it reconnects.'), { code: 'BROWSER_CONTAINMENT_LOST' });
      this.assertInputDocument(tab, expected);
    } else if (!wc.debugger.isAttached()) { wc.debugger.attach('1.3'); tab.containmentReady = null; }
    cancel(signal);
    const native = sessionId ? wc.debugger.sendCommand(method, params, sessionId) : wc.debugger.sendCommand(method, params);
    if (method === 'Page.handleJavaScriptDialog' || method === 'DOM.setFileInputFiles' || params.type === 'mouseReleased' || params.type === 'keyUp') return bounded(native, signal);
    return this.pageWork(tab, native, signal);
  }
  async ensureContained(tab, signal) {
    if (tab.rendererFailure) throw rendererFailure(tab);
    cancel(signal); const wc = tab.window.webContents;
    if (this.closed || !tab.window || tab.window.isDestroyed()) throw error('The contained browser page closed.');
    await bounded(this.compatibilityReady, signal); cancel(signal);
    await bounded(tab.rendererReady, signal, 8000); cancel(signal);
    if (tab.rendererFailure) throw rendererFailure(tab);
    if (this.closed || !tab.window || tab.window.isDestroyed()) throw error('The contained browser page closed.');
    if (!wc.debugger.isAttached()) { wc.debugger.attach('1.3'); tab.containmentReady = null; }
    if (!tab.containmentReady) {
      tab.containmentReady = bounded((async () => {
        await wc.debugger.sendCommand('Page.enable');
        await wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
      })(), undefined, 8000).catch(() => {
        tab.containmentReady = null; throw error('The browser could not disable native file dialogs. No contained browser input was sent.');
      });
      tab.containmentReady.catch(() => {});
    }
    await bounded(tab.containmentReady, signal, 8000); cancel(signal);
  }
  async ensurePopupViewport(tab, signal) {
    const state = tab.popupViewport;
    if (!state || state.ready) return;
    cancel(signal);
    if (!state.pending) {
      state.pending = (async () => {
        const window = tab.window, wc = window.webContents, containment = tab.containmentReady;
        const expected = { expectedUrl: wc.getURL(), expectedDocumentId: inputDocumentId(tab) };
        const current = () => {
          cancel(signal);
          if (tab.rendererFailure) throw rendererFailure(tab);
          if (this.closed || tab.window !== window || tab.popupViewport !== state || window.isDestroyed() || wc.isDestroyed()) throw Object.assign(error('The popup closed before its browser viewport was ready.'), { code: 'BROWSER_CLOSED' });
          if (!containment || tab.containmentReady !== containment || !wc.debugger.isAttached()) throw Object.assign(error('The contained popup connection changed before its viewport was ready. Inspect the page after it reconnects.'), { code: 'BROWSER_CONTAINMENT_LOST' });
          this.assertInputDocument(tab, expected);
        };
        const clear = async () => {
          if (wc.isDestroyed() || !wc.debugger.isAttached()) throw Object.assign(error('The popup viewport reset could not be confirmed. Inspect the page after it reconnects.'), { code: 'BROWSER_CONTAINMENT_LOST' });
          // Cleanup uses the same debugger, even after Stop or a document change.
          // Do not reconnect or leave an unconfirmed override marked as ready.
          await bounded(wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride'), undefined, 1500);
          state.resetRequired = false;
        };
        const viewport = async () => {
          current();
          const size = await this.pageWork(tab, wc.executeJavaScript('({width:innerWidth,height:innerHeight})'), signal);
          current(); return size;
        };
        const usable = size => Number.isFinite(size?.width) && size.width > 0 && Number.isFinite(size?.height) && size.height > 0;
        const unavailable = () => Object.assign(error('The contained popup has no usable browser viewport. Inspect or reload it before acting.'), { code: 'BROWSER_VIEWPORT_UNAVAILABLE' });
        current();
        if (state.resetRequired) { await clear(); current(); }
        const before = await viewport();
        if (!usable(before)) {
          if (before?.width !== 0 || before?.height !== 0) throw unavailable();
          const [width, height] = window.getContentSize();
          if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) throw unavailable();
          // Electron's adopted offscreen popup can have a 0×0 render widget
          // despite nonzero native bounds. Chromium resizes that actual widget;
          // clearing immediately retains the initialized size without emulation.
          state.resetRequired = true;
          let failure;
          try {
            current();
            await this.pageWork(tab, wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false, dontSetVisibleSize: false }), signal);
            current();
          } catch (reason) { failure = reason; }
          try { await clear(); } catch (reason) { failure ||= reason; }
          if (failure) throw failure;
          if (!usable(await viewport())) throw unavailable();
        }
        current(); state.ready = true;
      })().finally(() => { state.pending = null; });
      state.pending.catch(() => {});
    }
    await bounded(state.pending, signal);
  }
  async capture(tab, signal, revision) {
    return captureHiddenPage(tab.window.webContents, { signal, assertCurrent: () => {
      if (this.closed || tab.window.isDestroyed()) throw error('The browser page closed before capture completed.');
      if (revision !== undefined && tab.revision !== revision) throw error('The page changed while preparing browser input. Take a fresh snapshot before acting.');
    } });
  }
  async clickPoint(tab, point, signal, expected, sessionId) {
    cancel(signal);
    try { await this.cdp(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, signal, expected, sessionId); }
    finally {
      try { await this.cdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, AbortSignal.timeout(1500), undefined, sessionId); }
      catch { tab.inputWarning = 'Browser button release could not be confirmed. Inspect or reload before continuing.'; }
    }
    cancel(signal);
  }
  async pointerTarget(tab, point, signal, expected) {
    const wc = tab.window.webContents, guard = expected?.expectedDocumentId === undefined
      ? { expectedDocumentId: inputDocumentId(tab), expectedUrl: wc.getURL() } : expected;
    this.assertInputDocument(tab, guard);
    const sessions = [], close = async () => {
      for (const sessionId of sessions.reverse()) {
        try { await bounded(wc.debugger.sendCommand('Target.detachFromTarget', { sessionId }), undefined, 1500); } catch {}
      }
    };
    let sessionId, contextId, targetPoint = { x: point.x, y: point.y }, localPoint = targetPoint;
    // Ordinary documents retain the fast root-target path. Only a point that
    // actually hits an iframe needs child-frame inspection or attachment.
    if (!wc.mainFrame.framesInSubtree.some(frame => frame !== wc.mainFrame)) return { point: targetPoint, guard, close };
    const command = (method, params = {}) => this.cdp(tab, method, params, signal, undefined, sessionId);
    try {
      for (let depth = 0; depth < 16; depth++) {
        cancel(signal); this.assertInputDocument(tab, guard);
        const hit = await command('Runtime.evaluate', { expression: `((x,y)=>{let el=document.elementFromPoint(x,y);while(el?.shadowRoot){const next=el.shadowRoot.elementFromPoint(x,y);if(!next||next===el)break;el=next;}return el&&['IFRAME','FRAME'].includes(el.tagName)?el:null;})(${JSON.stringify(localPoint.x)},${JSON.stringify(localPoint.y)})`, ...(contextId ? { contextId } : {}), returnByValue: false });
        if (hit.exceptionDetails) throw error('The current frame could not be inspected before pointer input.');
        const objectId = hit.result?.objectId;
        if (!objectId) return { point: targetPoint, guard, sessionId, close };
        let frameId, quad;
        try {
          const described = await command('DOM.describeNode', { objectId });
          frameId = described.node?.frameId;
          if (!frameId || !['IFRAME', 'FRAME'].includes(described.node.nodeName)) throw error('The iframe hit target changed before pointer input.');
          quad = (await command('DOM.getBoxModel', { objectId })).model?.content;
        } finally { try { await command('Runtime.releaseObject', { objectId }); } catch {} }
        if (!Array.isArray(quad) || quad.length !== 8 || !quad.every(Number.isFinite)) throw error('The current iframe does not expose usable pointer geometry.');
        // DOM box quads belong to the current target viewport, even when the
        // owner element is in a same-process child document. Invert its affine
        // transform before switching to the child renderer's CSS coordinates.
        const ax = quad[2] - quad[0], ay = quad[3] - quad[1], bx = quad[6] - quad[0], by = quad[7] - quad[1], determinant = ax * by - ay * bx;
        if (Math.abs(determinant) < 0.000001 || Math.abs(quad[4] - quad[2] - quad[6] + quad[0]) > 0.5 || Math.abs(quad[5] - quad[3] - quad[7] + quad[1]) > 0.5) throw error('The iframe has unsupported pointer geometry. Inspect its page before another action.');
        const dx = targetPoint.x - quad[0], dy = targetPoint.y - quad[1], u = (dx * by - dy * bx) / determinant, v = (ax * dy - ay * dx) / determinant;
        // A border click remains on its owner document; it must not be moved
        // into an unrelated point inside the child document.
        if (u < 0 || u >= 1 || v < 0 || v >= 1) return { point: targetPoint, guard, sessionId, close };
        const targets = (await command('Target.getTargets')).targetInfos || [];
        const target = targets.find(value => value.type === 'iframe' && value.targetId === frameId);
        if (target) {
          const attached = await command('Target.attachToTarget', { targetId: frameId, flatten: true });
          if (!attached.sessionId) throw error('The exact iframe could not be attached for pointer input.');
          sessionId = attached.sessionId; sessions.push(sessionId); contextId = undefined;
          const frameTree = (await command('Page.getFrameTree')).frameTree;
          if (frameTree?.frame?.id !== frameId) throw error('The attached pointer target is not the observed iframe.');
        } else {
          // A same-process iframe needs no input redirect, but its descendant
          // may live in a different renderer. Inspect it without reading any
          // page values or changing its main-world application state.
          const world = await command('Page.createIsolatedWorld', { frameId, worldName: this.key + '_pointer' });
          if (!Number.isInteger(world.executionContextId)) throw error('The iframe document changed before pointer input.');
          contextId = world.executionContextId;
        }
        const viewport = await command('Runtime.evaluate', { expression: '({width:innerWidth,height:innerHeight})', ...(contextId ? { contextId } : {}), returnByValue: true });
        const size = viewport.result?.value;
        if (viewport.exceptionDetails || !Number.isFinite(size?.width) || !Number.isFinite(size?.height) || size.width <= 0 || size.height <= 0) throw error('The iframe viewport could not be inspected before pointer input.');
        localPoint = { x: u * size.width, y: v * size.height };
        if (target) targetPoint = localPoint;
      }
      throw error('The iframe nesting exceeds the supported pointer inspection depth.');
    } catch (cause) {
      await close();
      if (!cause.code) Object.assign(cause, { code: 'BROWSER_INPUT_FRAME_UNAVAILABLE', actionDispatched: false });
      throw cause;
    }
  }
  async pointerInput(tab, point, action, signal, expected) {
    const target = await this.pointerTarget(tab, point, signal, expected);
    try {
      await this.cdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...target.point, button: 'none' }, signal, target.guard, target.sessionId);
      if (action === 'click') await this.clickPoint(tab, target.point, signal, target.guard, target.sessionId);
      if (action === 'scroll') await this.cdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseWheel', ...target.point, deltaX: expected.deltaX, deltaY: expected.deltaY, button: 'none' }, signal, target.guard, target.sessionId);
    } finally { await target.close(); }
  }
  async browserPoint(tab, frame, point, signal) {
    const main = tab.window.webContents.mainFrame;
    if (frame === main) return { x: point.x, y: point.y };
    const tree = (await this.cdp(tab, 'Page.getFrameTree', {}, signal)).frameTree;
    const indices = []; let current = frame;
    while (current && current !== main) { const parent = current.parent; if (!parent) throw error('Embedded frame changed. Take a fresh snapshot.'); indices.unshift(parent.frames.indexOf(current)); current = parent; }
    let branch = tree;
    for (const index of indices) branch = branch?.childFrames?.[index];
    if (!branch || branch.frame.url !== frame.url) {
      const matches = []; const walk = node => { if (node.frame.url === frame.url && (node.frame.name || '') === (frame.name || '')) matches.push(node); for (const child of node.childFrames || []) walk(child); }; walk(tree);
      if (matches.length === 1) branch = matches[0];
      else {
        const targets = (await this.cdp(tab, 'Target.getTargets', {}, signal)).targetInfos;
        const embedded = targets.filter(t => t.type === 'iframe' && t.url === frame.url && (frame.parent !== main || t.parentFrameId === tree.frame.id || t.parentId === tree.frame.id));
        if (embedded.length !== 1) throw error('Embedded frame identity is ambiguous. Refresh the snapshot or use screenshot coordinates for this control.');
        branch = { frame: { id: embedded[0].targetId } };
      }
    }
    try {
      const owner = await this.cdp(tab, 'DOM.getFrameOwner', { frameId: branch.frame.id }, signal);
      const { model } = await this.cdp(tab, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId }, signal);
      const q = model.content, u = point.x / point.viewportWidth, v = point.y / point.viewportHeight;
      return { x: q[0] + (q[2] - q[0]) * u + (q[6] - q[0]) * v, y: q[1] + (q[3] - q[1]) * u + (q[7] - q[1]) * v };
    } catch { throw error('This embedded frame does not expose a page-level input target. Use its screenshot coordinates for a trusted browser click, or open the frame URL in a separate tab.'); }
  }
  async settle(tab, signal) {
    const wc = tab.window.webContents;
    if (!wc.isLoadingMainFrame()) return;
    await new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); wc.removeListener('dom-ready', done); wc.removeListener('did-stop-loading', done); wc.removeListener('render-process-gone', done); signal?.removeEventListener('abort', abort); resolve(); };
      const abort = () => { done(); reject(Object.assign(error('Browser action cancelled.'), { name: 'AbortError' })); };
      const timer = setTimeout(done, 8000);
      wc.once('dom-ready', done); wc.once('did-stop-loading', done); wc.once('render-process-gone', done); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else if (!wc.isLoadingMainFrame()) done();
    });
    cancel(signal);
  }
  watchNavigation(tab, signal) {
    const wc = tab.window.webContents; let started = false, wake, timer;
    const listener = () => { started = true; wake?.(); };
    wc.on('did-start-navigation', listener);
    return {
      wait: async () => {
        if (!started && !wc.isLoadingMainFrame()) await bounded(new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, 200); }), signal, 1500);
        cancel(signal);
      },
      dispose: () => { clearTimeout(timer); wc.removeListener('did-start-navigation', listener); wake?.(); },
    };
  }
  async perform(args, { signal, source = 'agent', owner: context, validateUploadPath } = {}) {
    cancel(signal);
    const wheel = browserWheelScroll(args);
    // The router removes its transport selector before entering this adapter.
    if (wheel) validateBrowserWheelScroll({ ...args, browser: args.browser ?? 'relay' });
    const owner = browserOwner(context);
    if (args.action === 'tabs') return this.status();
    if (args.action === 'downloads') return { downloads: this.downloads.slice(-30) };
    if (['folder_create', 'folder_rename', 'folder_close', 'tab_move', 'suspend'].includes(args.action)) return this.organize(args, source, owner);
    if (args.action === 'reuse_session') throw error('Session transfer was removed because it can invalidate the source sign-in. Connect directly to the existing browser instead.');
    const selected = args.tabId || (owner ? this.ownerActiveTabs.get(browserOwnerKey(owner)) : this.activeTab);
    let tab = args.action === 'open' ? this.newTab(browserURL(args.url), { owner, folderId: args.folderId, parentTabId: args.parentTabId }) : this.tab(selected);
    if (owner && !sameOwner(tab.owner, owner) && !(owner.allowUserTabs && !tab.owner)) throw capacityError('This browser tab belongs to another task.', 'BROWSER_TAB_OWNERSHIP');
    if (wheel) {
      if (tab.rendererFailure) throw rendererFailure(tab);
      if (!tab.window || tab.window.isDestroyed()) throw Object.assign(error('The observed browser page is no longer active. Refresh its preview before scrolling.'), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED', actionDispatched: false });
      try { this.assertInputDocument(tab, args); }
      catch (cause) { throw Object.assign(cause, { actionDispatched: false, stage: 'document' }); }
    }
    if (owner) { this.ownerActiveTabs.set(browserOwnerKey(owner), tab.id); if (tab.owner) tab.owner.runId = owner.runId; }
    else this.activeTab = tab.id;
    if (source === 'user' && tab.owner && ['navigate', 'click', 'fill', 'type', 'select', 'press', 'scroll', 'upload', 'interaction', 'back', 'forward', 'reload'].includes(args.action)) tab.userPinned = true;
    if (args.action === 'close') { this.closeTab(tab); return this.status(); }
    const recoveringRenderer = tab.rendererFailure;
    if (tab.rendererFailure) {
      if (!['reload', 'navigate'].includes(args.action)) throw rendererFailure(tab);
      if (args.action === 'navigate') browserURL(args.url);
      // Only this explicit new navigation may recreate the renderer. Its
      // previous refs and uncertain actions remain retired.
      tab.rendererFailure = null; tab.loadError = null;
    }
    if (args.action === 'interaction') {
      return this.resolveInteraction(tab, args, signal);
    }
    const pending = tab.pendingInteraction;
    if (pending && !(args.action === 'upload' && pending.kind === 'file_chooser' && pending.status === 'pending' && args.chooserId === pending.id)) {
      if (pending.status === 'pending' || !['snapshot', 'read', 'screenshot', 'navigate', 'reload', 'back', 'forward'].includes(args.action)) return this.interactionReceipt(tab, { actionDispatched: false });
    }
    if (tab.suspendedWork.size) throw Object.assign(error('The previous dialog action has not settled. Wait for its completion and inspect before continuing.'), { code: 'BROWSER_INTERACTION_SETTLING' });
    if (args.chooserId !== undefined) this.currentInteraction(tab, args);
    try {
    const resumed = !!tab.pendingURL && args.action !== 'navigate';
    if (args.action !== 'navigate') await this.activate(tab, signal);
    else { if (!tab.window) this.materialize(tab); await this.ensureContained(tab, signal); }
    // Reloading a saved page already dispatches its one navigation in activate.
    // A failed activation cannot be cleared by the no-op "already reloaded" arm.
    if (tab.loadError && (resumed && args.action === 'reload' || !['navigate', 'reload', 'back', 'forward'].includes(args.action))) throw navigationFailure(tab);
    if (['type', 'press', 'click', 'upload'].includes(args.action)) this.assertInputDocument(tab, args);
    if (args.action === 'type' && (typeof args.text !== 'string' || !args.text.length || args.text.length > 16384 || typeof args.expectedDocumentId !== 'string' || typeof args.expectedUrl !== 'string')) throw error('Type 1–16384 characters into a field on the current observed page.');
    const navigation = ['click','press','reload','back','forward'].includes(args.action) ? this.watchNavigation(tab, signal) : null;
    try {
    if (args.action === 'open') await bounded(tab.loading, signal, 20000);
    if (['navigate', 'reload', 'back', 'forward'].includes(args.action)) {
      tab.loadError = null; tab.navigationDispatched = true;
      const wc = tab.window.webContents;
      if (args.action === 'navigate') { tab.pendingURL = null; tab.url = browserURL(args.url); await bounded(wc.loadURL(tab.url).catch(e => { tab.loadError = e.message; }), signal, 20000); }
      else if (args.action === 'reload' && !resumed) wc.reload();
      else if (args.action === 'reload') { /* Resuming the suspended URL already performs this reload. */ }
      else if (args.action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      else if (args.action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      else throw error('There is no page in that direction.');
    }
    let receipt;
    if (args.action === 'type') {
      await this.cdp(tab, 'Input.insertText', { text: args.text }, signal, args);
      cancel(signal);
      // Human typing is streamed in order. Do not scan the whole page or echo
      // input text (including passwords) into a per-keystroke response.
      return { ...this.interactionReceipt(tab), receipt: { typed: true, characters: args.text.length, input: 'browser protocol' } };
    }
    if (args.action === 'fill') {
      const text = String(args.text ?? '');
      receipt = (await this.element(tab, { ...args, text }, 'fill', signal)).result;
      if (receipt.needsTrustedTextInput) {
        await this.cdp(tab, 'Input.insertText', { text }, signal);
        receipt = { filled: true, characters: text.length, input: 'browser' };
      }
    }
    if (args.action === 'select') receipt = (await this.element(tab, args, 'select', signal)).result;
    if (['click', 'hover'].includes(args.action)) {
      if (args.ref) {
        let { frame, result } = await this.element(tab, args, 'prepare', signal);
        const revision = tab.revision;
        // Flush layout/compositing after scroll or SPA changes before hit testing.
        const { retries } = await this.capture(tab, signal, revision);
        // A retry waited for another frame: the target can have moved or detached meanwhile.
        if (retries) ({ frame, result } = await this.element(tab, args, 'prepare', signal));
        const point = await this.browserPoint(tab, frame, result, signal);
        await this.pointerInput(tab, point, args.action, signal, args);
        receipt = { [args.action === 'click' ? 'clicked' : 'hovered']: args.ref, input: 'browser protocol' };
      } else {
        const viewport = await bounded(tab.window.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})'), signal);
        if (![args.x, args.y].every(n => Number.isFinite(n) && n >= 0) || args.x >= viewport.width || args.y >= viewport.height) throw error(`Canvas coordinates must be within the current ${viewport.width} × ${viewport.height} browser viewport. Prefer element refs.`);
        const { retries } = await this.capture(tab, signal, tab.revision);
        if (retries) {
          const current = await bounded(tab.window.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})'), signal);
          if (current.width !== viewport.width || current.height !== viewport.height) throw error('The browser viewport changed while preparing input. Take a fresh screenshot before acting.');
        }
        await this.pointerInput(tab, { x: args.x, y: args.y }, args.action, signal, args);
        receipt = { [args.action === 'click' ? 'clicked' : 'hovered']: true };
        // Human preview input shares a queue with typing. A completed guarded
        // click must not hold that queue for navigation settling or a DOM scan;
        // the preview refresh observes its result, as it does for typing/keys.
        if (args.action === 'click' && source === 'user' && args.expectedDocumentId !== undefined) {
          cancel(signal);
          return { ...this.interactionReceipt(tab), receipt: { ...receipt, input: 'browser protocol' } };
        }
      }
    }
    if (args.action === 'press') {
      const rawKey = String(args.key || ''), key = rawKey.toLowerCase() === 'a' ? 'A' : rawKey, modifiers = keyboardModifiers(args.modifiers);
      const keys = { Enter: { code: 'Enter', windowsVirtualKeyCode: 13 }, Tab: { code: 'Tab', windowsVirtualKeyCode: 9 }, Escape: { code: 'Escape', windowsVirtualKeyCode: 27 }, Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 }, Delete: { code: 'Delete', windowsVirtualKeyCode: 46 }, Home: { code: 'Home', windowsVirtualKeyCode: 36 }, End: { code: 'End', windowsVirtualKeyCode: 35 }, PageUp: { code: 'PageUp', windowsVirtualKeyCode: 33 }, PageDown: { code: 'PageDown', windowsVirtualKeyCode: 34 }, ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 }, ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 }, ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 }, ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 }, Space: { code: 'Space', windowsVirtualKeyCode: 32 }, A: { code: 'KeyA', windowsVirtualKeyCode: 65 } };
      if (!Object.hasOwn(keys, key) || key === 'A' && (!(modifiers & 6) || modifiers & 1)) throw error('Use a supported editing or navigation key, or Control/Meta+A to select all. Use type or fill for text.');
      if (args.ref) await this.element(tab, args, 'focus', signal);
      const eventKey = key === 'Space' ? ' ' : key === 'A' && !(modifiers & 8) ? 'a' : key;
      try {
        await this.cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', key: eventKey, ...keys[key], modifiers }, signal, args);
        if (key === 'Enter') await this.cdp(tab, 'Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter', ...keys[key], modifiers }, signal, args);
      } finally {
        try { await this.cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', key: eventKey, ...keys[key], modifiers }, AbortSignal.timeout(1500)); }
        catch { tab.inputWarning = 'Browser key release could not be confirmed. Inspect or reload before continuing.'; }
      }
      cancel(signal); receipt = { pressed: key };
      if (args.expectedDocumentId !== undefined) return { ...this.interactionReceipt(tab), receipt: { ...receipt, ...(args.modifiers?.length ? { modifiers: [...args.modifiers] } : {}), input: 'browser protocol' } };
    }
    if (args.action === 'scroll') {
      if (wheel) {
        const contents = tab.window.webContents;
        const viewport = await this.pageWork(tab, contents.executeJavaScript('({width:innerWidth,height:innerHeight})'), signal);
        cancel(signal);
        if (tab.window?.webContents !== contents) throw Object.assign(error('The observed browser page changed before scrolling.'), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED', actionDispatched: false });
        try { this.assertInputDocument(tab, args); }
        catch (cause) { throw Object.assign(cause, { actionDispatched: false, stage: 'document' }); }
        if (!Number.isFinite(viewport?.width) || !Number.isFinite(viewport?.height) || viewport.width <= 0 || viewport.height <= 0 || args.x >= viewport.width || args.y >= viewport.height) throw Object.assign(error('Scroll coordinates must be within the current browser viewport.'), { code: 'BROWSER_VALIDATION', actionDispatched: false });
        // Native hit testing preserves nested panes, both axes and page handlers.
        // Keep the input queue available without a DOM scan or settling wait.
        await this.pointerInput(tab, { x: args.x, y: args.y }, 'scroll', signal, args);
        cancel(signal); this.assertInputDocument(tab, args);
        return { ...this.interactionReceipt(tab), receipt: { scrolled: true, deltaX: args.deltaX, deltaY: args.deltaY, input: 'browser protocol' } };
      }
      const amount = Math.min(2000, Math.max(1, Number(args.amount) || 450)), direction = args.direction || 'down';
      const movement = { top: ['up','down'].includes(direction) ? amount * (direction === 'up' ? -1 : 1) : 0, left: ['left','right'].includes(direction) ? amount * (direction === 'left' ? -1 : 1) : 0 };
      if (args.ref) receipt = (await this.element(tab, args, 'scroll', signal, movement)).result;
      else receipt = await bounded(tab.window.webContents.executeJavaScript(`(async()=>{await (${smoothPageScroll.toString()})(document.scrollingElement||document.documentElement,${movement.top},${movement.left});return {scrollY,scrollX};})()`), signal);
    }
    if (args.action === 'upload') {
      if (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > 10) throw error('Supply 1–10 absolute local file paths.');
      if (Boolean(args.ref) === Boolean(args.chooserId)) throw error('Choose exactly one observed input ref or pending chooser ID.');
      const chooser = args.chooserId ? this.currentInteraction(tab, args) : null;
      if (chooser && (chooser.kind !== 'file_chooser' || chooser.status !== 'pending' || !chooser.multiple && args.paths.length > 1)) throw error('Choose files matching this exact pending file input.');
      const files = []; let total = 0;
      for (const file of args.paths) {
        if (typeof file !== 'string' || !path.isAbsolute(file)) throw error('Upload paths must be absolute.');
        cancel(signal); if (validateUploadPath) await validateUploadPath(file);
        const stat = await fs.lstat(file); total += stat.size;
        if (!stat.isFile() || total > 20 * 1024 * 1024) throw error('Upload regular files totalling at most 20 MB.');
        const handle = await fs.open(file, 'r'); let bytes;
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw error('An upload file changed before it could be opened. Choose its current contents explicitly.');
          const boundedBytes = Buffer.alloc(stat.size + 1); let length = 0;
          while (length < boundedBytes.length) { cancel(signal); const result = await handle.read(boundedBytes, length, boundedBytes.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
          bytes = boundedBytes.subarray(0, length);
        } finally { await handle.close(); }
        const after = await fs.lstat(file);
        if (!after.isFile() || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || bytes.length !== stat.size) throw error('An upload file changed while it was being read. Choose its current contents explicitly.');
        if (validateUploadPath) await validateUploadPath(file); cancel(signal);
        files.push({ name: path.basename(file), size: bytes.length, type: uploadMimeTypes.get(path.extname(file).toLowerCase()) || 'application/octet-stream', data: bytes.toString('base64') });
      }
      this.assertInputDocument(tab, args);
      if (chooser) {
        this.currentInteraction(tab, args);
        const target = tab.interactionTarget, resolved = await this.cdp(tab, 'DOM.resolveNode', { backendNodeId: target.backendNodeId }, signal);
        if (typeof resolved?.object?.objectId !== 'string') throw interactionChanged();
        const objectId = resolved.object.objectId;
        try {
          this.currentInteraction(tab, args); cancel(signal);
          const value = await this.cdp(tab, 'Runtime.callFunctionOn', { objectId, functionDeclaration: assignChosenFiles.toString(), arguments: [{ value: files }], returnByValue: true }, signal);
          if (value?.exceptionDetails) throw uploadRejected();
          receipt = value?.result?.value;
        } finally {
          if (tab.pendingInteraction?.id === chooser.id) this.clearInteraction(tab);
          void this.cdp(tab, 'Runtime.releaseObject', { objectId }).catch(() => {});
          this.emit('changed');
        }
      } else receipt = (await this.element(tab, args, 'upload', signal, { files })).result;
      receipt = validateUploadReceipt(receipt, files);
    }
    if (args.action === 'screenshot') {
      const assertCredentialCapture = () => {
        if (source !== 'user' && tab.credentialCaptureBlocked) throw Object.assign(error('This page received a protected credential. Continue with its masked snapshot; only the local human preview is available until the main page is replaced.'), { code: 'BROWSER_CREDENTIAL_CAPTURE_BLOCKED' });
      };
      assertCredentialCapture();
      const revision = tab.revision, { image } = await this.capture(tab, signal, revision);
      cancel(signal);
      assertCredentialCapture();
      if (tab.revision !== revision) throw Object.assign(error('The page changed while the preview was being captured. Refresh the preview before typing.'), { code: 'BROWSER_INPUT_DOCUMENT_CHANGED' });
      return { tabId: tab.id, url: tab.window.webContents.getURL(), documentId: inputDocumentId(tab), width: image.getSize().width, height: image.getSize().height, imageUrl: image.toDataURL(), ...(tab.pendingInteraction ? { pendingInteraction: structuredClone(tab.pendingInteraction) } : {}) };
    }
    if (args.action === 'wait') {
      const expected = args.text || args.query;
      if (!expected || typeof expected !== 'string' || expected.length > 1000) throw error('Specify expected page text to wait for.');
      const deadline = Date.now() + Math.min(20000, Math.max(100, Number(args.timeoutMs) || 10000));
      do {
        cancel(signal); const snapshot = await this.snapshot(tab, expected, signal);
        if (snapshot.frames.some(f => f.text.toLowerCase().includes(expected.toLowerCase()) || f.elements.length)) return { ...await this.snapshot(tab, undefined, signal), matched: expected };
        if (Date.now() >= deadline) throw error('Expected text did not appear. Inspect the page before choosing another action.');
        await bounded(new Promise(resolve => setTimeout(resolve, 120)), signal, 1000);
      } while (true);
    }
    cancel(signal); await navigation?.wait(); await this.settle(tab, signal);
    if (tab.loadError) throw navigationFailure(tab);
    const result = await this.snapshot(tab, args.query, signal);
    return { ...result, ...(receipt ? { receipt } : {}), tabs: this.status().tabs };
    } finally { navigation?.dispose(); }
    } catch (reason) {
      if (recoveringRenderer && !tab.window && !tab.rendererFailure) { tab.rendererFailure = recoveringRenderer; throw reason; }
      if (tab.rendererFailure) throw rendererFailure(tab, true);
      if (reason.code === 'BROWSER_INTERACTION_PENDING' && tab.pendingInteraction) return this.interactionReceipt(tab, { actionDispatched: true, inspectBeforeContinuing: true });
      throw reason;
    }
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.persist(); this.closed = true;
    const closingProtection = Promise.resolve().then(() => this.protection.close()); this.protection.off('updated', this.protectionListener);
    this.session.removeListener('will-download', this.downloadListener);
    this.session.removeListener('file-system-access-restricted', this.fileSystemAccessListener);
    this.session.cookies.removeListener('changed', this.cookieListener);
    this.session.webRequest.onCompleted(null); this.session.webRequest.onErrorOccurred(null);
    for (const t of [...this.tabs.values()]) { t.closing = true; if (t.window) t.window.destroy(); else this.removeTab(t); }
    this.session.webRequest.onBeforeRequest(null);
    this.closePromise = Promise.allSettled([closingProtection, this.writeChain, Promise.resolve().then(() => this.session.flushStorageData())]).then(results => {
      if (this.persistenceError) throw Object.assign(error('Browser shutdown could not confirm saved folders and pages.'), { code: 'BROWSER_SAVE_FAILED' });
      const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
    });
    return this.closePromise;
  }
}
