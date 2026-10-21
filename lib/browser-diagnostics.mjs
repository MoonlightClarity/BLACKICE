// Small, credential-free evidence for sites that fail after navigation. Never
// retain headers, bodies, cookie values, query strings, or authentication URLs.
export class BrowserDiagnostics {
  constructor({ limit = 24, now = () => new Date().toISOString() } = {}) {
    this.limit = Math.max(1, Math.min(64, limit)); this.now = now;
    this.failures = []; this.cookieRemovals = [];
  }
  request(details = {}) {
    const hasError = !!details.error && !['net::OK', 'OK'].includes(details.error);
    if (!hasError && !(details.statusCode >= 400)) return;
    let origin;
    try { const url = new URL(details.url); if (!['http:', 'https:'].includes(url.protocol)) return; origin = url.origin; } catch { return; }
    const event = { at: this.now(), origin, resourceType: String(details.resourceType || 'unknown').slice(0, 40), ...(Number.isInteger(details.statusCode) ? { status: details.statusCode } : {}) };
    // Chromium network error constants are useful; freeform errors could include
    // a secret URL. Unknown messages are deliberately reduced to a fixed label.
    if (hasError) event.error = /^net::ERR_[A-Z0-9_]+$/.test(details.error) ? details.error : 'Network request failed';
    this.failures.push(event); if (this.failures.length > this.limit) this.failures.shift();
  }
  cookie(cookie, cause, removed) {
    if (!removed || !cookie || !['expired', 'evicted', 'explicit', 'expired-overwrite'].includes(cause)) return;
    // Counts and the host distinguish server invalidation from import rejection.
    // Names can be application-generated secrets, so do not keep even the name.
    const domain = String(cookie.domain || '').replace(/^\./, '');
    if (!/^[a-zA-Z0-9.:-]{1,253}$/.test(domain)) return;
    this.cookieRemovals.push({ at: this.now(), domain, cause });
    if (this.cookieRemovals.length > this.limit) this.cookieRemovals.shift();
  }
  snapshot() { return { failedRequests: this.failures.map(event => ({ ...event })), cookieRemovals: this.cookieRemovals.map(event => ({ ...event })) }; }
}
