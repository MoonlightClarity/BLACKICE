// Per-page diagnostic evidence. No request headers, bodies, cookies or full URLs.
// Raw console text is untrusted; common secret forms are redacted, not evaluated.
export function diagnosticOrigin(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.origin : '[local page]'; } catch { return '[unknown]'; }
}
export function diagnosticText(value) {
  return String(value ?? '').slice(0, 8192)
    .replace(/https?:\/\/[^\s"'<>]+/gi, value => diagnosticOrigin(value) + '/[path omitted]')
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[authorization omitted]')
    .replace(/\b(?:password|passwd|secret|access_token|refresh_token|id_token|api[_-]?key|authorization|cookie|set-cookie)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[secret omitted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_.-]+|[A-Za-z0-9_+/=-]{48,})\b/g, '[token omitted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 1024);
}
export class BrowserTabDiagnostics {
  constructor({ limit = 128, byteLimit = 65536, now = () => new Date().toISOString() } = {}) {
    this.limit = Math.max(1, Math.min(256, Number.isSafeInteger(limit) ? limit : 128));
    this.byteLimit = Math.max(1024, Math.min(262144, Number.isSafeInteger(byteLimit) ? byteLimit : 65536));
    this.now = now; this.events = []; this.sequence = 0; this.bytes = 0; this.dropped = 0; this.clearedThrough = 0;
  }
  add(kind, fields = {}) {
    const event = { sequence: ++this.sequence, at: this.now(), kind, ...fields };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    this.events.push({ event, bytes }); this.bytes += bytes;
    while (this.events.length > this.limit || this.bytes > this.byteLimit) { this.bytes -= this.events.shift().bytes; this.dropped++; }
  }
  console(details = {}) {
    const level = ['debug', 'info', 'warning', 'error'].includes(details.level) ? details.level : ['debug', 'info', 'warning', 'error'][Number(details.level)] || 'info';
    this.add('console', { level, message: diagnosticText(details.message), sourceOrigin: diagnosticOrigin(details.sourceId), ...(Number.isSafeInteger(details.lineNumber) ? { line: details.lineNumber } : {}) });
  }
  network(stage, details = {}) {
    if (!['started', 'response', 'completed', 'failed'].includes(stage)) return;
    let url; try { url = new URL(details.url); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol)) return;
    // Only fixed useful route labels, never arbitrary paths or query strings.
    const route = /^\/backend-api\/conversation(?:\/|$)/.test(url.pathname) ? 'conversation' :
      /^\/backend-api\//.test(url.pathname) ? 'backend-api' : /^\/api\/auth\//.test(url.pathname) ? 'auth' : 'other';
    const type = ['mainFrame', 'subFrame', 'stylesheet', 'script', 'image', 'font', 'object', 'xhr', 'ping', 'cspReport', 'media', 'webSocket', 'other'].includes(details.resourceType) ? details.resourceType : 'other';
    this.add('network', { stage, origin: url.origin, route, resourceType: type,
      ...(Number.isSafeInteger(details.id) ? { requestId: details.id } : {}),
      ...(Number.isInteger(details.statusCode) ? { status: details.statusCode } : {}),
      ...(details.error && !['net::OK', 'OK'].includes(details.error) ? { error: /^net::ERR_[A-Z0-9_]+$/.test(details.error) ? details.error : 'Network request failed' } : {}) });
  }
  lifecycle(kind, details = {}) {
    if (!['loading-started', 'loading-stopped', 'unresponsive', 'responsive', 'renderer-gone', 'navigation-failed', 'debugger-detached'].includes(kind)) return;
    this.add(kind, { ...(Number.isInteger(details.code) ? { code: details.code } : {}),
      ...(details.reason ? { reason: diagnosticText(details.reason) } : {}) });
  }
  clear() { this.events = []; this.bytes = 0; this.clearedThrough = this.sequence; return { clearedThrough: this.clearedThrough }; }
  snapshot({ after = 0, limit = 128 } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new TypeError('Use a nonnegative event cursor and a limit from 1 to 256.');
    const selected = this.events.filter(item => item.event.sequence > after).slice(0, limit).map(item => ({ ...item.event }));
    return { events: selected, cursor: selected.at(-1)?.sequence ?? after, latestSequence: this.sequence, dropped: this.dropped, clearedThrough: this.clearedThrough,
      retained: this.events.length, retainedBytes: this.bytes, eventLimit: this.limit, byteLimit: this.byteLimit,
      hasMore: this.events.some(item => item.event.sequence > (selected.at(-1)?.sequence ?? after)),
      retention: 'Bounded live-page memory; connector read results are preserved in durable job receipts. No historical capture before this collector was installed.' };
  }
}
