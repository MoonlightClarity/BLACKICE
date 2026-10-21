import { EventEmitter } from 'node:events';
import { promises as fs, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

export const PROTECTION_SOURCES = Object.freeze([
  Object.freeze({ id: 'easylist', url: 'https://easylist.to/easylist/easylist.txt', license: 'GPL-3.0-or-later OR CC-BY-SA-3.0' }),
  Object.freeze({ id: 'easyprivacy', url: 'https://easylist.to/easylist/easyprivacy.txt', license: 'GPL-3.0-or-later OR CC-BY-SA-3.0' }),
]);
const MAX_LIST_BYTES = 8 * 1024 * 1024, MAX_COMBINED_BYTES = 2 * MAX_LIST_BYTES;
const TYPES = { mainFrame: 'main_frame', subFrame: 'sub_frame', stylesheet: 'stylesheet', script: 'script', image: 'image', font: 'font', object: 'object', xhr: 'xmlhttprequest', ping: 'ping', cspReport: 'csp_report', media: 'media', webSocket: 'websocket', other: 'other' };
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, code = 'BROWSER_PROTECTION_ERROR', status = 400) => Object.assign(new Error(message), { code, status });
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
export function protectionOrigin(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null; } catch { return null; }
}
function exactOrigin(value) { const origin = protectionOrigin(value); if (!origin || origin !== value) throw fail('Use the exact origin of the currently observed contained tab.', 'BROWSER_PROTECTION_ORIGIN'); return origin; }

async function atomicJson(file, value, beforeCommit = () => {}) {
  await fs.mkdir(path.dirname(file), { recursive: true }); const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
    // No event-loop turn separates the final tab-origin assertion and rename.
    beforeCommit(); renameSync(temporary, file);
  } catch (cause) { await fs.rm(temporary, { force: true }).catch(() => {}); throw cause; }
}

export function decodeProtectionBundle(value) {
  if (!value || value.schema !== 1 || value.encoding !== 'gzip-base64' || typeof value.data !== 'string' || value.data.length > 18 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data) || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > MAX_COMBINED_BYTES || !/^[a-f0-9]{64}$/.test(value.sha256 || '') || !validTime(value.fetchedAt) || !Array.isArray(value.sources) || value.sources.length !== PROTECTION_SOURCES.length) throw fail('The browser filter bundle is invalid.', 'BROWSER_PROTECTION_FILTERS_INVALID', 503);
  for (const source of PROTECTION_SOURCES) {
    const entries = value.sources.filter(entry => entry.id === source.id && entry.url === source.url);
    if (entries.length !== 1 || !/^[a-f0-9]{64}$/.test(entries[0].sha256 || '') || !Number.isSafeInteger(entries[0].bytes) || entries[0].bytes < 1 || entries[0].bytes > MAX_LIST_BYTES) throw fail('The browser filter source metadata is invalid.', 'BROWSER_PROTECTION_FILTERS_INVALID', 503);
  }
  let text;
  try { const bytes = gunzipSync(Buffer.from(value.data, 'base64'), { maxOutputLength: MAX_COMBINED_BYTES }); if (bytes.length !== value.bytes || hash(bytes) !== value.sha256) throw Error(); text = bytes.toString('utf8'); }
  catch { throw fail('The browser filter bundle failed its integrity check.', 'BROWSER_PROTECTION_FILTERS_INVALID', 503); }
  if (text.includes('\u0000') || /<\s*(?:html|!doctype)/i.test(text.slice(0, 512))) throw fail('The browser filter bundle is not a filter list.', 'BROWSER_PROTECTION_FILTERS_INVALID', 503);
  return { text, metadata: { fetchedAt: value.fetchedAt, sha256: value.sha256, bytes: value.bytes, sources: value.sources.map(source => ({ id: source.id, url: source.url, sha256: source.sha256, bytes: source.bytes, license: source.license || PROTECTION_SOURCES.find(item => item.id === source.id).license })) } };
}

async function compileFilters(text) {
  const { FiltersEngine, Request } = await import('./vendor/ghostery-adblocker.mjs');
  const engine = FiltersEngine.parse(text, { loadCosmeticFilters: false, loadCSPFilters: false, loadNetworkFilters: true, enableCompression: true });
  const filterCount = engine.getFilters().networkFilters.length;
  return { engine, filterCount, makeRequest: details => Request.fromRawDetails(details) };
}

/** Network filtering only: no extension permissions, preload, scriptlets, CSS or redirects. */
export class BrowserProtection extends EventEmitter {
  constructor({ dataDir, compile = compileFilters, fetch = globalThis.fetch, bundledFile = new URL('./vendor/adblock-filter-data.json', import.meta.url), now = Date.now, minimumRules = 1000 } = {}) {
    super(); this.file = path.join(dataDir, 'browser-protection.json'); this.cacheFile = path.join(dataDir, 'browser-protection-filters.json'); this.bundledFile = bundledFile;
    this.compile = compile; this.fetch = fetch; this.now = now; this.minimumRules = minimumRules;
    this.settings = { schema: 2, enabled: false, exemptOrigins: [] }; this.preferenceSource = 'default'; this.settingsHealthy = true; this.compiled = null; this.metadata = null; this.source = null;
    this.error = null; this.refreshError = null; this.closed = false; this.initialized = false; this.blockedRequests = 0; this.tabCounts = new Map(); this.tail = Promise.resolve(); this.refreshPromise = null; this.refreshController = null; this.updateTimer = null;
  }
  async init() {
    if (this.initialized) return this; this.initialized = true;
    try {
      const stat = await fs.stat(this.file); if (stat.size > 65536) throw Error(); const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!value || ![1, 2].includes(value.schema) || Object.keys(value).some(key => !['schema', 'enabled', 'exemptOrigins'].includes(key)) || typeof value.enabled !== 'boolean' || !Array.isArray(value.exemptOrigins) || value.exemptOrigins.length > 200 || new Set(value.exemptOrigins).size !== value.exemptOrigins.length || value.exemptOrigins.some(origin => exactOrigin(origin) !== origin)) throw Error();
      // Schema 1 also persisted the old enabled-by-default value during site-only
      // edits, so true does not establish a global opt-in. Keep exemptions and
      // explicit disabled choices; schema 2 records choices made with the new default.
      this.settings = { schema: 2, enabled: value.schema === 2 && value.enabled, exemptOrigins: [...value.exemptOrigins] };
      this.preferenceSource = value.schema === 1 && value.enabled ? 'legacy-default-disabled' : 'saved';
    } catch (cause) { if (cause.code !== 'ENOENT') { this.settingsHealthy = false; this.error = { code: 'BROWSER_PROTECTION_SETTINGS_UNREADABLE', message: 'Browser filtering settings could not be read. Browsing remains unfiltered; the original file was preserved.' }; } }
    let cacheFailure = null;
    for (const [file, source] of [[this.cacheFile, 'updated'], [this.bundledFile, 'bundled']]) {
      try {
        const stat = await fs.stat(file); if (stat.size > 20 * 1024 * 1024) throw Error();
        const decoded = decodeProtectionBundle(JSON.parse(await fs.readFile(file, 'utf8'))), compiled = await this.compile(decoded.text);
        this.validateCompiled(compiled); this.compiled = compiled; this.metadata = decoded.metadata; this.source = source; break;
      } catch (cause) { if (source === 'updated') { if (cause.code !== 'ENOENT') cacheFailure = 'The saved filter update was unreadable. Bundled filters remain in use.'; } else this.error ||= { code: 'BROWSER_PROTECTION_FILTERS_UNAVAILABLE', message: 'Browser filters could not load. Browsing continues without filtering.' }; }
    }
    if (this.compiled && cacheFailure) this.refreshError = { code: 'BROWSER_PROTECTION_CACHE_UNREADABLE', message: cacheFailure };
    this.updated(); return this;
  }
  validateCompiled(value) { if (!value || typeof value.engine?.match !== 'function' || typeof value.makeRequest !== 'function' || !Number.isSafeInteger(value.filterCount) || value.filterCount < this.minimumRules) throw fail('The filter update did not contain a usable network rule set.', 'BROWSER_PROTECTION_FILTERS_INVALID', 503); }
  status() { return { available: !this.closed, enabled: this.settings.enabled, ready: Boolean(this.compiled), preferenceSource: this.preferenceSource, engine: 'Ghostery', engineVersion: '2.20.1', mode: 'network-only', filterCount: this.compiled?.filterCount || 0, blockedRequests: this.blockedRequests, source: this.source, updatedAt: this.metadata?.fetchedAt || null, sources: this.metadata?.sources.map(source => ({ ...source })) || [], refreshing: Boolean(this.refreshPromise), exemptOrigins: [...this.settings.exemptOrigins], error: this.error || this.refreshError, settingsHealthy: this.settingsHealthy }; }
  tabStatus(tabId, url) { const origin = protectionOrigin(url), siteExempt = Boolean(origin && this.settings.exemptOrigins.includes(origin)), enabled = !this.closed && this.settings.enabled && !siteExempt && Boolean(this.compiled); return { available: !this.closed, ready: Boolean(this.compiled), origin, siteExempt, enabled, enforced: enabled, blockedRequests: this.tabCounts.get(tabId) || 0 }; }
  updated() { if (!this.closed) this.emit('updated', this.status()); }
  count(tabId) { this.blockedRequests++; if (tabId) this.tabCounts.set(tabId, (this.tabCounts.get(tabId) || 0) + 1); if (!this.updateTimer) { this.updateTimer = setTimeout(() => { this.updateTimer = null; this.updated(); }, 75); this.updateTimer.unref?.(); } }
  forgetTab(tabId) { this.tabCounts.delete(tabId); }
  match({ url, type = 'other', sourceUrl, tabId } = {}) {
    if (this.closed) return { cancel: false, reason: 'closed' };
    let requestUrl; try { requestUrl = new URL(url); } catch { return { cancel: false, reason: 'invalid-url' }; }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(requestUrl.protocol)) return { cancel: false, reason: 'non-network' };
    if (!this.settings.enabled) return { cancel: false, reason: 'disabled' };
    const page = type === 'mainFrame' || type === 'main_frame' ? url : sourceUrl, origin = protectionOrigin(page);
    // Unattributed worker traffic is filtered and cannot borrow a tab exemption.
    if (tabId && origin && this.settings.exemptOrigins.includes(origin)) return { cancel: false, reason: 'site-exemption' };
    if (!this.compiled) return { cancel: false, reason: 'filters-unavailable' };
    try {
      const request = this.compiled.makeRequest({ url, sourceUrl: protectionOrigin(sourceUrl) ? sourceUrl : url, type: TYPES[type] || type, requestId: 'blackice-network', tabId });
      const result = this.compiled.engine.match(request);
      if (result.match) { this.count(tabId); return { cancel: true, reason: 'filter' }; }
      return { cancel: false, reason: 'allowed' };
    } catch { this.error = { code: 'BROWSER_PROTECTION_MATCH_FAILED', message: 'A network request could not be filtered and was allowed.' }; return { cancel: false, reason: 'filter-error' }; }
  }
  configure(options, { currentOrigin, signal } = {}) {
    if (signal?.aborted) return Promise.reject(fail('The browser protection action was cancelled.', 'ABORT_ERR', 409));
    if (!options || typeof options !== 'object' || Array.isArray(options)) return Promise.reject(fail('Choose a browser protection action.'));
    if (options.action === 'refresh') { if (Object.keys(options).some(key => key !== 'action')) return Promise.reject(fail('Refresh does not accept a URL or extra fields.')); return this.refresh({ signal }); }
    const allowed = options.action === 'global' ? ['action', 'enabled'] : options.action === 'site' ? ['action', 'tabId', 'origin', 'enabled'] : [];
    if (!allowed.length || Object.keys(options).some(key => !allowed.includes(key)) || typeof options.enabled !== 'boolean') return Promise.reject(fail('Choose global or current-site protection and an enabled value.'));
    let origin;
    try { if (options.action === 'site') { origin = exactOrigin(options.origin); if (typeof options.tabId !== 'string' || !options.tabId || typeof currentOrigin !== 'function') throw fail('Choose an observed contained tab.', 'BROWSER_PROTECTION_TAB_REQUIRED'); } }
    catch (cause) { return Promise.reject(cause); }
    const pending = this.tail.catch(() => {}).then(async () => {
      if (this.closed) throw fail('The browser workspace is closing.', 'BROWSER_CLOSED', 503);
      if (!this.settingsHealthy) throw fail('The original browser protection settings need recovery before they can be changed.', 'BROWSER_PROTECTION_SETTINGS_UNREADABLE', 503);
      const assertCurrent = () => { if (this.closed) throw fail('The browser workspace is closing.', 'BROWSER_CLOSED', 503); if (signal?.aborted) throw fail('The browser protection action was cancelled.', 'ABORT_ERR', 409); if (origin && currentOrigin(options.tabId) !== origin) throw fail('This tab navigated to another origin. Inspect its current page before changing protection.', 'BROWSER_PROTECTION_STALE_TAB', 409); };
      assertCurrent(); const next = { ...this.settings, exemptOrigins: [...this.settings.exemptOrigins] };
      if (options.action === 'global') next.enabled = options.enabled;
      else if (options.enabled) next.exemptOrigins = next.exemptOrigins.filter(value => value !== origin);
      else if (!next.exemptOrigins.includes(origin)) next.exemptOrigins.push(origin);
      if (next.exemptOrigins.length > 200) throw fail('The browser has reached its site-exemption limit.', 'BROWSER_PROTECTION_SITE_LIMIT', 409);
      next.exemptOrigins.sort(); await atomicJson(this.file, next, assertCurrent); this.settings = next; this.preferenceSource = 'saved'; this.updated(); return this.status();
    }); this.tail = pending; return pending;
  }
  refresh({ signal } = {}) {
    if (this.closed) return Promise.reject(fail('The browser workspace is closing.', 'BROWSER_CLOSED', 503));
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshController = new AbortController(); const controller = this.refreshController;
    const abort = () => controller.abort(signal.reason); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const timeout = setTimeout(() => controller.abort(new Error('The filter update timed out.')), 20000); timeout.unref?.();
    this.refreshPromise = Promise.resolve().then(async () => {
      try {
        const texts = [], sources = [];
        for (const source of PROTECTION_SOURCES) {
          const response = await this.fetch(source.url, { signal: controller.signal, redirect: 'error', headers: { Accept: 'text/plain' } });
          if (!response.ok || response.url && response.url !== source.url || !/^text\/plain(?:\s*;|$)/i.test(response.headers?.get('content-type') || '') || Number(response.headers?.get('content-length') || 0) > MAX_LIST_BYTES || !response.body) throw fail('A filter source did not return a usable text list.', 'BROWSER_PROTECTION_REFRESH_FAILED', 503);
          const chunks = []; let bytes = 0;
          for await (const chunk of response.body) { if (controller.signal.aborted) throw controller.signal.reason; bytes += chunk.length; if (bytes > MAX_LIST_BYTES) { await response.body.cancel?.().catch(() => {}); throw fail('A filter source exceeded the download limit.', 'BROWSER_PROTECTION_REFRESH_FAILED', 503); } chunks.push(chunk); }
          const buffer = Buffer.concat(chunks), text = buffer.toString('utf8');
          if (!/^\[Adblock(?: Plus)?[^\]\r\n]*\]/i.test(text.trimStart()) || text.includes('\u0000') || /<\s*(?:html|!doctype)/i.test(text.slice(0, 512))) throw fail('A filter source returned something other than an ad-blocking list.', 'BROWSER_PROTECTION_REFRESH_FAILED', 503);
          texts.push(text); sources.push({ ...source, sha256: hash(buffer), bytes });
        }
        const text = texts.join('\n'), bytes = Buffer.from(text), compiled = await this.compile(text); this.validateCompiled(compiled);
        if (controller.signal.aborted || this.closed) throw fail('The filter update was cancelled.', 'BROWSER_PROTECTION_REFRESH_FAILED', 503);
        const value = { schema: 1, encoding: 'gzip-base64', fetchedAt: new Date(this.now()).toISOString(), sources, sha256: hash(bytes), bytes: bytes.length, data: gzipSync(bytes).toString('base64') };
        const decoded = decodeProtectionBundle(value); await atomicJson(this.cacheFile, value, () => { if (controller.signal.aborted || this.closed) throw fail('The filter update was cancelled.', 'BROWSER_PROTECTION_REFRESH_FAILED', 503); });
        this.compiled = compiled; this.metadata = decoded.metadata; this.source = 'updated'; this.refreshError = null; if (this.settingsHealthy) this.error = null; return this.status();
      } catch (cause) { if (!this.closed) this.refreshError = { code: 'BROWSER_PROTECTION_REFRESH_FAILED', message: this.compiled ? 'Filter update failed. The last working filters remain available when filtering is enabled.' : 'Filter update failed. Browsing continues without filtering.' }; throw fail(this.refreshError?.message || 'The filter update was cancelled.', 'BROWSER_PROTECTION_REFRESH_FAILED', 503); }
      finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); this.refreshController = null; this.refreshPromise = null; this.updated(); }
    }); this.updated(); return this.refreshPromise;
  }
  async close() { if (this.closed) return; this.closed = true; clearTimeout(this.updateTimer); this.refreshController?.abort(); await Promise.allSettled([this.tail, this.refreshPromise]); this.compiled = null; this.tabCounts.clear(); }
}
