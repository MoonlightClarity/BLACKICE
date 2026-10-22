import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { browserURL } from '../lib/browser.mjs';

// Uses Firefox's supported WebDriver BiDi protocol, not patched Playwright or OS input.
// https://developer.mozilla.org/en-US/docs/Web/WebDriver/How_to/Create_BiDi_connection
// https://w3c.github.io/webdriver-bidi/
export const FIREFOX_ACTIONS = ['tabs', 'open', 'navigate', 'snapshot', 'read', 'click', 'hover', 'fill', 'select', 'press', 'scroll', 'wait', 'screenshot', 'back', 'forward', 'reload', 'close'];
const fail = (message, code = 'BROWSER_ERROR') => Object.assign(new Error(message), { code });
const cancelled = () => Object.assign(fail('Browser action cancelled; inspect before repeating an action.', 'ABORT_ERR'), { name: 'AbortError' });
const check = signal => { if (signal?.aborted) throw typeof signal.reason?.code==='string'&&signal.reason.code.startsWith('BROWSER_') ? signal.reason : cancelled(); };
const MAX_PROTOCOL_CHARS = 12 * 1024 * 1024, MAX_PAGE_CHARS = 512000;
const value = data => {
  if (data === null) return { type: 'null' };
  if (typeof data === 'string' || typeof data === 'boolean' || typeof data === 'number') return { type: typeof data, value: data };
  if (Array.isArray(data)) return { type: 'array', value: data.map(value) };
  if (data && typeof data === 'object') return { type: 'object', value: Object.entries(data).map(([key,entry]) => [key,value(entry)]) };
  return { type: 'undefined' };
};

function endpointURL(endpoint) {
  let url; try { url = new URL(endpoint); } catch { throw fail('Firefox needs a loopback WebDriver BiDi WebSocket endpoint.', 'BROWSER_VALIDATION'); }
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw fail('Firefox WebDriver BiDi must use a local loopback WebSocket endpoint.', 'BROWSER_VALIDATION');
  if (url.pathname === '/') url.pathname = '/session';
  if (url.pathname !== '/session') throw fail('Use Firefox’s local /session WebDriver BiDi endpoint.', 'BROWSER_VALIDATION');
  return url.href;
}

class BiDiConnection extends EventEmitter {
  constructor(endpoint, { timeoutMs = 25000, WebSocketClass = WebSocket } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw fail('Firefox command timeout must be between 1 and 60000 milliseconds.', 'BROWSER_VALIDATION');
    super(); this.endpoint = endpointURL(endpoint); this.timeoutMs = timeoutMs; this.WebSocketClass = WebSocketClass; this.pending = new Map(); this.next = 0; this.closed = false;
  }
  async open(signal) {
    check(signal); this.socket = new this.WebSocketClass(this.endpoint);
    this.socket.addEventListener('message', event => {
      if (typeof event.data !== 'string' || event.data.length > MAX_PROTOCOL_CHARS) { this.disconnect(fail('Firefox returned an oversized or invalid protocol message.', 'BROWSER_PROTOCOL')); return; }
      let message; try { message = JSON.parse(event.data); } catch { this.disconnect(fail('Firefox returned invalid protocol JSON.', 'BROWSER_PROTOCOL')); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { this.disconnect(fail('Firefox returned an invalid protocol response.', 'BROWSER_PROTOCOL')); return; }
      if (typeof message.id !== 'number') { if (message.type === 'event') this.emit('event', message); return; }
      const pending = this.pending.get(message.id); if (!pending) return;
      if (message.type === 'error') pending.reject(fail(`Firefox ${pending.method}: ${String(message.message || message.error || 'protocol error').slice(0,1000)}`, typeof message.error === 'string' ? message.error : 'BROWSER_PROTOCOL'));
      else if (message.type === 'success') pending.resolve(message.result);
      else pending.reject(fail('Firefox returned an invalid protocol response.', 'BROWSER_PROTOCOL'));
    });
    this.socket.addEventListener('close', () => this.disconnect(fail('Firefox disconnected. Inspect the browser status before retrying.', 'BROWSER_DISCONNECTED')));
    this.socket.addEventListener('error', () => { if (this.socket.readyState !== 0) this.disconnect(fail('Firefox transport failed. Inspect its status before retrying.', 'BROWSER_DISCONNECTED')); });
    await new Promise((resolve, reject) => {
      let timer; const finish = (fn, data) => { clearTimeout(timer); this.socket.removeEventListener('open', opened); this.socket.removeEventListener('error', errored); this.socket.removeEventListener('close', disconnected); signal?.removeEventListener('abort', abort); fn(data); };
      const opened = () => finish(resolve), errored = () => finish(reject, fail('Could not connect to Firefox WebDriver BiDi.', 'BROWSER_UNAVAILABLE'));
      const disconnected = () => finish(reject, fail('Firefox disconnected before its connection was ready.', 'BROWSER_DISCONNECTED'));
      const abort = () => { try { this.socket.close(); } catch {} finish(reject, cancelled()); };
      this.socket.addEventListener('open', opened, { once: true }); this.socket.addEventListener('error', errored, { once: true }); signal?.addEventListener('abort', abort, { once: true });
      this.socket.addEventListener('close', disconnected, { once: true });
      timer = setTimeout(() => { try { this.socket.close(); } catch {} finish(reject, fail('Firefox WebDriver BiDi did not connect in time.', 'BROWSER_TIMEOUT')); }, this.timeoutMs);
      if (signal?.aborted) abort();
    });
    return this;
  }
  send(method, params = {}, { signal, timeoutMs = this.timeoutMs } = {}) {
    check(signal);
    if (this.closed || this.socket?.readyState !== 1) return Promise.reject(fail('Firefox is not connected.', 'BROWSER_DISCONNECTED'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      let timer, settled=false; const finish = (fn, data) => { if(settled)return;settled=true;clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id); fn(data); };
      const abort = () => { try { check(signal); } catch(error) { finish(reject,error); } };
      this.pending.set(id, { method, resolve: data => finish(resolve, data), reject: error => finish(reject, error) });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(reject, fail(`Firefox ${method} timed out. Inspect before retrying; the action may have completed.`, 'BROWSER_TIMEOUT')), timeoutMs);
      try { this.socket.send(JSON.stringify({ id, method, params })); } catch (error) { finish(reject, error); }
      if (signal?.aborted) abort();
    });
  }
  disconnect(error) { if(this.closed)return;this.closed=true;for(const pending of [...this.pending.values()])pending.reject(error);this.emit('closed',error);try{this.socket?.close();}catch{} }
  close() { this.disconnect(fail('Firefox connection closed.', 'BROWSER_DISCONNECTED')); }
}

// This function executes independently in each web-content frame. It never has
// Node, profile, cookie-database, or privileged browser access.
function snapshotPage(key, prefix, query) {
  let state = globalThis[key];
  if (!state || state.document !== document) state = globalThis[key] = { document, token: Math.random().toString(36).slice(2), next: 0, ids: new WeakMap(), elements: new Map() };
  const normalize = input => String(input || '').slice(0,12000).replace(/\s+/g, ' ').trim();
  const elements = [], texts = []; let scanned = 0, textLength=0, truncated = false;
  state.elements.clear();
  const needle = String(query || '').toLowerCase();
  function walk(root) {
    for (const el of root.children || []) {
      if (++scanned > 16000 || elements.length >= 300) { truncated = true; return; }
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)) continue;
      const style = getComputedStyle(el), rect = el.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || el.getAttribute('aria-hidden') === 'true') continue;
      const role = el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: ['checkbox','radio'].includes(el.type) ? el.type : 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox', SUMMARY: 'button' }[el.tagName]) || (/^H[1-6]$/.test(el.tagName) ? 'heading' : el.isContentEditable ? 'textbox' : '');
      const interactive = (rect.width > 0 || rect.height > 0) && (!!role || el.tabIndex >= 0 || el.tagName === 'CANVAS');
      if (interactive) {
        const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
        const name = normalize(el.getAttribute('aria-label') || labelled || (el.labels ? [...el.labels].map(label => label.textContent).join(' ') : '') || el.getAttribute('placeholder') || el.innerText || el.getAttribute('title') || el.getAttribute('alt')).slice(0, 300);
        let ref = state.ids.get(el); if (!ref) { ref = `${prefix}:${state.token}:${++state.next}`; state.ids.set(el, ref); }
        const fieldValue = el.type !== 'password' && 'value' in el ? String(el.value).slice(0, 300) : undefined;
        if (!needle || `${name} ${fieldValue || ''}`.toLowerCase().includes(needle)) { state.elements.set(ref,el); elements.push({ ref, role: role || (el.tagName === 'CANVAS' ? 'canvas' : 'element'), name, tag: el.tagName.toLowerCase(), ...(el.type ? { type: el.type } : {}), ...(el.isContentEditable ? { contentEditable: true } : {}), ...(fieldValue !== undefined ? { value: fieldValue } : {}), ...(el.disabled || el.getAttribute('aria-disabled') === 'true' ? { disabled: true } : {}), ...(el.tagName === 'A' ? { href: el.href.slice(0,4000) } : {}), ...(el.tagName === 'SELECT' ? { options: [...el.options].slice(0,80).map(option => ({ value: option.value.slice(0,300), label: option.label.slice(0,300) })) } : {}) }); }
      }
      for (const node of el.childNodes) if (node.nodeType === 3) { const text = normalize(node.textContent); if (text && (!needle || text.toLowerCase().includes(needle))) { if(textLength<22000){const part=text.slice(0,22000-textLength);texts.push(part);textLength+=part.length;}else truncated=true; } }
      if (el.shadowRoot) walk(el.shadowRoot);
      walk(el);
    }
  }
  walk(document.documentElement);
  for (const [ref, el] of state.elements) if (!el.isConnected) state.elements.delete(ref);
  return JSON.stringify({ title: document.title, url: location.href, readyState: document.readyState, elements, text: texts.join('\n').slice(0,22000), truncated });
}

function inspectElement(key, ref, action, argument) {
  const el = globalThis[key]?.elements.get(ref);
  if (!el?.isConnected) throw new Error('This element ref is stale. Take a new snapshot.');
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('This element is disabled. Inspect the page first.');
  if (action === 'node') return el;
  if (action === 'verifyFill') {
    const actual = el.isContentEditable ? el.innerText : el.value;
    const normalize = text => String(text ?? '').replace(/\r\n/g,'\n');
    const normalizedActual = normalize(actual), normalizedExpected = normalize(argument);
    const matched = el.isContentEditable ? normalizedActual.replace(/\n+$/,'') === normalizedExpected.replace(/\n+$/,'') : normalizedActual === normalizedExpected;
    return JSON.stringify({ matched, characters: normalizedActual.length });
  }
  if (action === 'focus' || action === 'focusText') {
    if (action === 'focusText' && (el.readOnly || (!el.isContentEditable && !['INPUT', 'TEXTAREA'].includes(el.tagName)) || ['file','checkbox','radio','button','submit','reset','hidden'].includes(el.type))) throw new Error('Choose an editable text field.');
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); el.focus({ preventScroll: true });
    if (document.activeElement !== el && el.getRootNode()?.activeElement !== el) throw new Error('This text field could not receive browser focus.');
    return JSON.stringify({ focused: true, contentEditable: !!el.isContentEditable });
  }
  if (action === 'prepare') {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    if (!rect.width || !rect.height) throw new Error('This target is not visible. Take a new snapshot.');
    const top = document.elementFromPoint(x,y); let host = el; while (host.getRootNode()?.host) host = host.getRootNode().host;
    if (top && top !== el && !el.contains(top) && !top.contains(el) && host !== top) throw new Error('Another element covers this target. Inspect the page first.');
    return JSON.stringify({ prepared: true });
  }
  if (action === 'select') {
    if (el.tagName !== 'SELECT' || ![...el.options].some(option => option.value === argument)) throw new Error('Choose an available native select option.');
    el.value = argument; el.dispatchEvent(new Event('input', { bubbles: true, composed: true })); el.dispatchEvent(new Event('change', { bubbles: true, composed: true })); return JSON.stringify({ selected: el.value });
  }
  if (action === 'scroll') {
    const { top, left } = JSON.parse(argument), position = () => ({ scrollTop: el.scrollTop, scrollLeft: el.scrollLeft }), reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    el.scrollBy({ top, left, behavior: reducedMotion ? 'instant' : 'smooth' }); if (reducedMotion) return JSON.stringify(position());
    const started = performance.now(); let previous = position(), steady = 0;
    return new Promise(resolve => {
      const sample = () => { const current = position(); if (Math.abs(current.scrollTop - previous.scrollTop) < 0.5 && Math.abs(current.scrollLeft - previous.scrollLeft) < 0.5) steady++; else { previous = current; steady = 0; } const elapsed = performance.now() - started; if (elapsed >= 120 && steady >= 3 || elapsed >= 1800) { resolve(); return; } setTimeout(sample, 40); };
      setTimeout(sample, 40);
    }).then(() => JSON.stringify(position()));
  }
  throw new Error('Unsupported element operation.');
}

function waitForPage(key, query, ref, timeoutMs) {
  return new Promise((resolve, reject) => {
    let observer, timer;
    const dispose = () => { observer?.disconnect(); clearTimeout(timer); };
    const test = () => {
      const el = ref ? globalThis[key]?.elements.get(ref) : null;
      if ((!ref || el?.isConnected) && (!query || (document.body?.innerText || '').toLowerCase().includes(query.toLowerCase()))) { dispose(); resolve(JSON.stringify({ matched: true, query: query || undefined, ref: ref || undefined })); return true; }
      return false;
    };
    if (test()) return;
    observer = new MutationObserver(test); observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true });
    timer = setTimeout(() => { dispose(); reject(new Error('Expected page text or element did not appear before the wait ended.')); }, timeoutMs);
  });
}

const KEYS = { Enter: '\uE007', Return: '\uE006', Escape: '\uE00C', Esc: '\uE00C', Tab: '\uE004', Backspace: '\uE003', Delete: '\uE017', Space: ' ', ArrowLeft: '\uE012', ArrowUp: '\uE013', ArrowRight: '\uE014', ArrowDown: '\uE015', Home: '\uE011', End: '\uE010', PageUp: '\uE00E', PageDown: '\uE00F', Control: '\uE009', Ctrl: '\uE009', Shift: '\uE008', Alt: '\uE00A', Meta: '\uE03D', Command: '\uE03D' };
function keySequence(key) {
  const input = String(key || '');
  const parts = input === '+' ? ['+'] : input.endsWith('++') ? [...input.slice(0,-2).split('+'),'+'] : input.split('+');
  if (!parts.length || parts.some(part => !part)) throw fail('Choose a browser key, such as Enter, Escape, or Control+A.', 'BROWSER_VALIDATION');
  const converted = parts.map(part => KEYS[part] || ([...part].length === 1 ? part : null));
  if (converted.some(part => !part)) throw fail('That browser key is not supported.', 'BROWSER_VALIDATION');
  return [...converted.map(value => ({ type: 'keyDown', value })), ...converted.toReversed().map(value => ({ type: 'keyUp', value }))];
}

function scrollDocument(argument) {
  const { top, left } = JSON.parse(argument), target = document.scrollingElement || document.documentElement, position = () => ({ scrollY, scrollX }), reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  target.scrollBy({ top, left, behavior: reducedMotion ? 'instant' : 'smooth' }); if (reducedMotion) return JSON.stringify(position());
  const started = performance.now(); let previous = position(), steady = 0;
  return new Promise(resolve => {
    const sample = () => { const current = position(); if (Math.abs(current.scrollY - previous.scrollY) < 0.5 && Math.abs(current.scrollX - previous.scrollX) < 0.5) steady++; else { previous = current; steady = 0; } const elapsed = performance.now() - started; if (elapsed >= 120 && steady >= 3 || elapsed >= 1800) { resolve(); return; } setTimeout(sample, 40); };
    setTimeout(sample, 40);
  }).then(() => JSON.stringify(position()));
}

export class FirefoxBiDiDriver extends EventEmitter {
  constructor({ endpoint, profileName = 'Existing Firefox profile', profileSource = 'existing-profile', timeoutMs = 25000, maxTabs = 8, WebSocketClass, onClose } = {}) {
    super(); this.connection = new BiDiConnection(endpoint, { timeoutMs, WebSocketClass }); this.profileName = profileName; this.profileSource = profileSource; this.timeoutMs = timeoutMs; this.maxTabs = maxTabs; this.tabs = new Map(); this.contextOwners=new Map();this.ownedTabs = new Set();this.uncertainInputs=new Set();this.operations=new Set();this.lifetime=new AbortController();this.activeTab = null; this.key = `__relay_bidi_${randomUUID().replaceAll('-','')}`; this.closed = false; this.onClose = onClose;
    if(!Number.isInteger(maxTabs)||maxTabs<1||maxTabs>32)throw fail('Firefox task tab limit must be between 1 and 32.','BROWSER_VALIDATION');
    this.connection.on('closed', error => { this.connected = false;for(const tab of this.tabs.values())tab.refs.clear();this.lifetime.abort(error); this.emit('changed'); });
    this.connection.on('event', event => {
      const context = event.params?.context;
      if (typeof context!=='string')return;
      if (event.method === 'browsingContext.contextCreated' && event.params.parent == null && this.ownedTabs.has(event.params.originalOpener)) {this.ownedTabs.add(context);this.tabs.set(context,this.newTab(context,event.params.url||'about:blank'));this.emit('changed');}
      const tab = this.tabs.get(context)||this.tabs.get(this.contextOwners.get(context));
      if (event.method === 'browsingContext.contextDestroyed') { if(tab){tab.revision++;tab.refs.clear();}this.tabs.delete(context); this.ownedTabs.delete(context);this.contextOwners.delete(context);this.uncertainInputs.delete(context); this.emit(`settled:${tab?.tabId||context}`); this.emit('changed'); }
      if (tab && event.method === 'browsingContext.navigationStarted') { tab.revision++;tab.refs.clear();if(context===tab.tabId)tab.loading=true; }
      if (tab && context===tab.tabId && ['browsingContext.domContentLoaded','browsingContext.load'].includes(event.method)) { tab.loading = false; this.emit(`settled:${context}`); }
    });
  }
  async init({ signal } = {}) {
    try {
      await this.connection.open(signal);
      const session = await this.connection.send('session.new', { capabilities: { alwaysMatch: { browserName: 'firefox', acceptInsecureCerts: false } } }, { signal });
      this.sessionId = session.sessionId; this.capabilities = session.capabilities || {}; this.connected = true;
      await this.connection.send('session.subscribe', { events: ['browsingContext.contextCreated', 'browsingContext.contextDestroyed', 'browsingContext.navigationStarted', 'browsingContext.domContentLoaded', 'browsingContext.load'] }, { signal });
      await this.refreshTabs(signal); return this;
    } catch (error) { await this.close().catch(()=>{}); throw error; }
  }
  status() {
    return { available: !!this.connected && !this.closed, connected: !!this.connected && !this.closed, browser: 'firefox', engine: 'Firefox · WebDriver BiDi', background: true, physicalInput: false, foregrounded: false, persistentSession: true, profile: this.profileName, profileSource: this.profileSource, existingProfile: true, accountAuthenticated: 'unknown', actions: FIREFOX_ACTIONS, tabs: [...this.tabs.values()].map(({refs,revision,...tab})=>({...tab,owned:this.ownedTabs.has(tab.tabId)})), activeTab: this.activeTab, ...(this.uncertainInputs.size?{inputWarning:'Firefox input release has not been confirmed. The next input will retry release first.'}:{}), ...(this.capabilities?.browserVersion ? { browserVersion: this.capabilities.browserVersion } : {}) };
  }
  async refreshTabs(signal) {
    const tree = await this.connection.send('browsingContext.getTree', { maxDepth: 0 }, { signal });
    const current = new Map();
    if(!Array.isArray(tree?.contexts))throw fail('Firefox returned an invalid tab list.','BROWSER_PROTOCOL');
    for (const entry of tree.contexts) {if(typeof entry?.context!=='string')throw fail('Firefox returned an invalid tab identity.','BROWSER_PROTOCOL');const previous = this.tabs.get(entry.context); current.set(entry.context, previous ? Object.assign(previous,{url:entry.url}) : this.newTab(entry.context,entry.url)); }
    for (const id of this.ownedTabs) if (!current.has(id)) this.ownedTabs.delete(id);
    for(const[context,owner]of this.contextOwners)if(!current.has(owner))this.contextOwners.delete(context);
    this.tabs = current; if (!this.tabs.has(this.activeTab)) this.activeTab = [...this.ownedTabs].find(id=>this.tabs.has(id)) || null;
    this.emit('changed'); return tree;
  }
  newTab(tabId,url){this.contextOwners.set(tabId,tabId);return{tabId,url,title:'',visible:false,loading:false,refs:new Map(),revision:0};}
  assertCurrent(tab,revision){if(this.closed||!this.connected||this.tabs.get(tab.tabId)!==tab)throw fail('The Firefox page closed or disconnected.','BROWSER_DISCONNECTED');if(tab.revision!==revision)throw fail('The Firefox page changed while preparing this action. Take a fresh snapshot.','BROWSER_STALE_PAGE');}
  tab(id) { const tab = this.tabs.get(id || this.activeTab); if (!tab) throw fail('Choose an existing Firefox tab, or open a URL first.', 'BROWSER_VALIDATION'); return tab; }
  async call(context, fn, args, { signal, raw = false, timeoutMs } = {}) {
    const result = await this.connection.send('script.callFunction', { functionDeclaration: fn.toString(), target: { context }, awaitPromise: true, arguments: args.map(value), resultOwnership: 'none', userActivation: false }, { signal, ...(timeoutMs ? { timeoutMs } : {}) });
    if (result?.type === 'exception') throw fail(`Firefox page: ${String(result.exceptionDetails?.text || 'page script failed').slice(0,1000)}`, 'BROWSER_PAGE');
    if(result?.type!=='success')throw fail('Firefox returned an invalid page response.','BROWSER_PROTOCOL');
    if (raw) return result.result;
    if (result.result?.type !== 'string'||typeof result.result.value!=='string'||result.result.value.length>MAX_PAGE_CHARS) throw fail('Firefox returned an unexpected or oversized page result.', 'BROWSER_PROTOCOL');
    try { return JSON.parse(result.result.value); } catch { throw fail('Firefox returned an invalid page result.', 'BROWSER_PROTOCOL'); }
  }
  async snapshot(tab, query, signal) {
    const revision=tab.revision;
    const tree = await this.connection.send('browsingContext.getTree', { root: tab.tabId, maxDepth: 8 }, { signal });
    const contexts = []; const walk = entry => { if (contexts.length < 30) contexts.push(entry); for (const child of entry.children || []) if (contexts.length < 30) walk(child); }; for (const entry of tree.contexts || []) walk(entry);
    const frames = [], frameErrors = [], refs=new Map(); let elementsLeft = 400, textLeft = 24000; tab.refs.clear();
    if(contexts[0]?.context!==tab.tabId)throw fail('Firefox did not return this page’s frame tree.','BROWSER_PROTOCOL');
    for(const context of contexts)this.contextOwners.set(context.context,tab.tabId);
    for (const context of contexts) {
      check(signal);
      try {
        const snapshot = await this.call(context.context, snapshotPage, [this.key, context.context, String(query || '')], { signal, timeoutMs: frames.length ? 3000 : this.timeoutMs });
        this.assertCurrent(tab,revision);
        if(!snapshot||!Array.isArray(snapshot.elements)||typeof snapshot.text!=='string'||typeof snapshot.url!=='string'||typeof snapshot.title!=='string')throw fail('Firefox returned an invalid page snapshot.','BROWSER_PROTOCOL');
        snapshot.truncated ||= snapshot.elements.length > elementsLeft || snapshot.text.length > textLeft;
        snapshot.elements = snapshot.elements.slice(0, elementsLeft); snapshot.text = snapshot.text.slice(0, textLeft); elementsLeft -= snapshot.elements.length; textLeft -= snapshot.text.length;
        snapshot.elements=snapshot.elements.filter(element=>element&&typeof element.ref==='string'&&element.ref.startsWith(`${context.context}:`));
        for (const element of snapshot.elements) refs.set(element.ref, context.context);
        frames.push({ frame: context.context, ...snapshot });
      } catch (error) { check(signal);if(context.context===tab.tabId||error.code==='BROWSER_STALE_PAGE'||error.code==='BROWSER_DISCONNECTED')throw error;frameErrors.push({ frame: context.context, error: error.message }); }
    }
    if (!frames.length) throw fail(frameErrors[0]?.error || 'Firefox could not inspect this page.', 'BROWSER_PAGE');
    this.assertCurrent(tab,revision);tab.refs=refs;tab.url = frames[0].url; tab.title = frames[0].title; this.emit('changed');
    return { tabId: tab.tabId, url: tab.url, title: tab.title, frames, ...(frameErrors.length ? { frameErrors } : {}), ...(frames.some(frame => frame.truncated) ? { hint: 'Large page: use query to narrow controls and text, or scroll and inspect again.' } : {}) };
  }
  ref(tab, ref) { const context = typeof ref === 'string' && tab.refs.get(ref); if (!context) throw fail('Take a fresh snapshot in this tab and choose its element ref.', 'BROWSER_VALIDATION'); return context; }
  async input(context, actions, signal) {
    for(const prior of [...this.uncertainInputs]){await this.connection.send('input.releaseActions',{context:prior},{signal,timeoutMs:1500});this.uncertainInputs.delete(prior);}
    let result,actionError;
    try { result=await this.connection.send('input.performActions', { context, actions }, { signal }); }
    catch(error){actionError=error;}
    try{await this.connection.send('input.releaseActions',{context},{timeoutMs:1500});this.uncertainInputs.delete(context);}
    catch{this.uncertainInputs.add(context);this.emit('changed');if(!actionError)actionError=fail('Firefox input release could not be confirmed. Inspect before repeating the action.','BROWSER_INPUT_UNCONFIRMED');}
    if(actionError)throw actionError;return result;
  }
  async keys(context, actions, signal) { return this.input(context, [{ type: 'key', id: 'relay-keyboard', actions }], signal); }
  async settle(tab,signal) {
    if (!tab.loading) return;
    await new Promise((resolve,reject) => {
      let timer; const event = `settled:${tab.tabId}`;
      const done = (fn,data) => { clearTimeout(timer); this.removeListener(event,finish); signal?.removeEventListener('abort',abort); fn(data); };
      const finish = () => done(resolve), abort = () => {try{check(signal);}catch(error){done(reject,error);}};
      this.once(event,finish); signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>done(reject,fail('Firefox navigation has not settled. Inspect the page before retrying the action.','BROWSER_TIMEOUT')),10000);
      if (signal?.aborted) abort(); else if (!tab.loading) finish();
    });
  }
  show(tabId) { return { tabId: this.tab(tabId).tabId, visible: false, foregrounded: false, message: 'Firefox is running in the background. Use snapshot or screenshot to inspect it.' }; }
  async perform(args, { signal } = {}) {
    check(signal);if(this.closed||!this.connected)throw fail('Firefox is not connected.','BROWSER_UNAVAILABLE');
    const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(fail('Firefox action timed out. Inspect before retrying; the action may have completed.','BROWSER_TIMEOUT')),this.timeoutMs);
    const active=AbortSignal.any([deadline.signal,this.lifetime.signal,...(signal?[signal]:[])]);
    const work=this.performAction(args,{signal:active});this.operations.add(work);
    try{return await work;}finally{clearTimeout(timer);this.operations.delete(work);}
  }
  async performAction(args, { signal } = {}) {
    check(signal); if (this.closed || !this.connected) throw fail('Firefox is not connected.', 'BROWSER_UNAVAILABLE');
    if (!FIREFOX_ACTIONS.includes(args?.action)) throw fail(`Firefox does not currently support ${args?.action || 'this action'}. Supported actions: ${FIREFOX_ACTIONS.join(', ')}.`, 'BROWSER_UNSUPPORTED');
    if (args.action === 'tabs') { await this.refreshTabs(signal); return this.status(); }
    let tab;
    if (args.action === 'open') {
      const url = browserURL(args.url); await this.refreshTabs(signal);
      if (this.ownedTabs.size >= this.maxTabs) throw fail(`Use at most ${this.maxTabs} Firefox task tabs. Close a test tab first.`, 'BROWSER_VALIDATION');
      const created = await this.connection.send('browsingContext.create', { type: 'tab', background: true }, { signal });
      if(typeof created?.context!=='string')throw fail('Firefox did not return a new tab identity.','BROWSER_PROTOCOL');
      tab = this.newTab(created.context,'about:blank'); this.tabs.set(tab.tabId, tab); this.ownedTabs.add(tab.tabId); this.activeTab = tab.tabId;
      await this.connection.send('browsingContext.navigate', { context: tab.tabId, url, wait: 'interactive' }, { signal });
    } else { tab = this.tab(args.tabId); this.activeTab = tab.tabId; }
    if (args.action === 'close') { if (!this.ownedTabs.has(tab.tabId)) throw fail('Close only Firefox task tabs created by Relay. Existing user tabs are preserved.', 'BROWSER_VALIDATION'); await this.connection.send('browsingContext.close', { context: tab.tabId, promptUnload: false }, { signal }); this.ownedTabs.delete(tab.tabId); await this.refreshTabs(signal); return this.status(); }
    if (args.action === 'navigate') await this.connection.send('browsingContext.navigate', { context: tab.tabId, url: browserURL(args.url), wait: 'interactive' }, { signal });
    if (args.action === 'reload') await this.connection.send('browsingContext.reload', { context: tab.tabId, wait: 'interactive' }, { signal });
    if (['back','forward'].includes(args.action)) await this.connection.send('browsingContext.traverseHistory', { context: tab.tabId, delta: args.action === 'back' ? -1 : 1 }, { signal });
    const actionRevision=tab.revision;
    let receipt;
    if (['click','hover'].includes(args.action)) {
      let origin, context = tab.tabId, x = 0, y = 0;
      if (args.ref) { context = this.ref(tab,args.ref); await this.call(context, inspectElement, [this.key,args.ref,'prepare',''], { signal }); const node = await this.call(context, inspectElement, [this.key,args.ref,'node',''], { signal, raw: true }); if (!node?.sharedId) throw fail('Firefox could not resolve this element. Take a new snapshot.'); origin = { type: 'element', element: { sharedId: node.sharedId } }; }
      else { if (!Number.isFinite(args.x) || !Number.isFinite(args.y) || args.x < 0 || args.y < 0) throw fail('Choose a ref or valid screenshot coordinates.', 'BROWSER_VALIDATION'); x = Math.round(args.x); y = Math.round(args.y); origin = 'viewport'; }
      const actions = [{ type: 'pointerMove', x, y, origin, duration: 0 }, ...(args.action === 'click' ? [{ type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] : [])];
      this.assertCurrent(tab,actionRevision);
      await this.input(context, [{ type: 'pointer', id: 'relay-pointer', parameters: { pointerType: 'mouse' }, actions }], signal); receipt = { [args.action === 'click' ? 'clicked' : 'hovered']: true };
    }
    if (args.action === 'fill') {
      const text = String(args.text ?? ''); if (text.length > 50000) throw fail('Text is too long.', 'BROWSER_VALIDATION');
      const context = this.ref(tab,args.ref); await this.call(context, inspectElement, [this.key,args.ref,'focusText',''], { signal });
      // Gecko can retain keyboard focus in a previously used child frame even
      // after DOM focus() succeeds in the parent. A trusted browser click moves
      // the focused frame as well; it never dispatches operating-system input.
      await this.call(context, inspectElement, [this.key,args.ref,'prepare',''], { signal });
      const node = await this.call(context, inspectElement, [this.key,args.ref,'node',''], { signal, raw: true });
      if (!node?.sharedId) throw fail('Firefox could not resolve this text field. Take a new snapshot.');
      this.assertCurrent(tab,actionRevision);
      await this.input(context,[{type:'pointer',id:'relay-pointer',parameters:{pointerType:'mouse'},actions:[{type:'pointerMove',x:0,y:0,origin:{type:'element',element:{sharedId:node.sharedId}},duration:0},{type:'pointerDown',button:0},{type:'pointerUp',button:0}]}],signal);
      await this.call(context, inspectElement, [this.key,args.ref,'focusText',''], { signal });
      this.assertCurrent(tab,actionRevision);
      await this.keys(context, [...keySequence('Control+A'), ...keySequence('Backspace')], signal);
      const characters = [...text]; for (let offset = 0; offset < characters.length; offset += 256) { check(signal);this.assertCurrent(tab,actionRevision);const actions = characters.slice(offset,offset+256).flatMap(character => [{ type: 'keyDown', value: character === '\n' ? KEYS.Enter : character === '\t' ? KEYS.Tab : character }, { type: 'keyUp', value: character === '\n' ? KEYS.Enter : character === '\t' ? KEYS.Tab : character }]); await this.keys(context,actions,signal); }
      const verified = await this.call(context,inspectElement,[this.key,args.ref,'verifyFill',text],{signal});
      if (!verified.matched) throw fail('Firefox did not confirm the requested text in this field. Inspect the page before retrying.', 'BROWSER_INPUT_UNCONFIRMED');
      receipt = { filled: true, verified: true, characters: text.length, input: 'browser-keyboard' };
    }
    if (args.action === 'press') { const context = args.ref ? this.ref(tab,args.ref) : tab.tabId; if (args.ref) await this.call(context,inspectElement,[this.key,args.ref,'focus',''],{signal});this.assertCurrent(tab,actionRevision);await this.keys(context,keySequence(args.key),signal); receipt = { pressed: args.key }; }
    if (args.action === 'select') { const context = this.ref(tab,args.ref); receipt = await this.call(context,inspectElement,[this.key,args.ref,'select',String(args.value ?? '')],{signal}); }
    if (args.action === 'scroll') {
      const amount = Number.isFinite(args.amount) ? Math.min(10000,Math.max(1,args.amount)) : 450, direction = args.direction || 'down';
      if (!['up','down','left','right'].includes(direction)) throw fail('Choose a scroll direction.', 'BROWSER_VALIDATION');
      const top = direction === 'up' ? -amount : direction === 'down' ? amount : 0, left = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
      if (args.ref) receipt = await this.call(this.ref(tab,args.ref),inspectElement,[this.key,args.ref,'scroll',JSON.stringify({top,left})],{signal});
      else receipt = await this.call(tab.tabId,scrollDocument,[JSON.stringify({top,left})],{signal});
    }
    if (args.action === 'wait') { const query=String(args.query || args.text || ''); if (!query && !args.ref) throw fail('Wait requires expected page text in query or text, or an element ref.', 'BROWSER_VALIDATION'); const timeoutMs = Math.min(20000,Math.max(1,Number(args.timeoutMs)||10000)); receipt = await this.call(args.ref ? this.ref(tab,args.ref) : tab.tabId,waitForPage,[this.key,query,String(args.ref || ''),timeoutMs],{signal,timeoutMs:timeoutMs+1500}); }
    await this.settle(tab,signal);
    const snapshot = await this.snapshot(tab,args.query,signal);
    if (args.action === 'screenshot') {const revision=tab.revision;const capture = await this.connection.send('browsingContext.captureScreenshot',{context:tab.tabId,origin:'viewport',format:{type:'image/png'}},{signal});this.assertCurrent(tab,revision);if(typeof capture?.data!=='string'||!capture.data||capture.data.length>10*1024*1024||!/^[A-Za-z0-9+/]+={0,2}$/.test(capture.data))throw fail('Firefox returned invalid or oversized screenshot data.','BROWSER_PROTOCOL');return {...snapshot,imageUrl:`data:image/png;base64,${capture.data}`}; }
    return { ...snapshot, ...(receipt ? { receipt } : {}) };
  }
  close() {
    if (this.closePromise) return this.closePromise; this.closed = true;this.lifetime.abort(cancelled());
    return this.closePromise = (async () => {
      let shutdownError=!this.connected&&this.sessionId?fail('Firefox disconnected before shutdown was confirmed.','BROWSER_SHUTDOWN_UNCONFIRMED'):null;
      await Promise.allSettled([...this.operations]);
      try {
        if (this.connected) {
          await Promise.allSettled([...this.ownedTabs].map(context=>this.connection.send('browsingContext.close',{context,promptUnload:false},{timeoutMs:1500})));
          await this.connection.send('browser.close',{}, {timeoutMs:10000});
        }
      }
      catch (error) { shutdownError = error; }
      finally { this.connected = false; this.connection.close(); this.tabs.clear(); this.ownedTabs.clear();this.contextOwners.clear();this.uncertainInputs.clear();this.activeTab=null;this.emit('changed'); }
      // The launcher owns the process handle and confirms that profile writes
      // have finished. It never substitutes a global Firefox kill operation.
      if (this.onClose) { try { await this.onClose(); shutdownError = null; } catch (error) { shutdownError = error; } }
      if (shutdownError) throw fail('Firefox shutdown could not be confirmed. Its profile may still be in use.', 'BROWSER_SHUTDOWN_UNCONFIRMED');
    })();
  }
}

export async function createFirefoxDriver(options) { return new FirefoxBiDiDriver(options).init({ signal: options?.signal }); }

// The launcher may use this only for the endpoint of its own observed process
// after initialization failed. It never discovers or inspects existing pages.
export async function closeOwnedFirefoxSession({ endpoint, signal, timeoutMs = 5000, WebSocketClass } = {}) {
  const connection = new BiDiConnection(endpoint, { timeoutMs, WebSocketClass });
  const deadline = new AbortController(), active = AbortSignal.any([deadline.signal, ...(signal ? [signal] : [])]);
  const timer = setTimeout(() => deadline.abort(fail('Firefox cleanup timed out before shutdown was confirmed.', 'BROWSER_TIMEOUT')), timeoutMs);
  try {
    await connection.open(active);
    await connection.send('session.new', { capabilities: { alwaysMatch: { browserName: 'firefox' } } }, { signal: active });
    await connection.send('browser.close', {}, { signal: active });
    return { closed: true };
  } finally { clearTimeout(timer); connection.close(); }
}
