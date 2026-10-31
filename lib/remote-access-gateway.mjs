import http from 'node:http';
import { EventEmitter } from 'node:events';

export const REMOTE_COOKIE = '__Host-blackice_remote';
const BODY_LIMIT = 32 * 1024 * 1024;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DISCOVERY_PATHS = new Map([['/.well-known/oauth-protected-resource', 'rootPRM'], ['/.well-known/oauth-protected-resource/mcp/chatgpt', 'pathPRM'], ['/.well-known/oauth-authorization-server', 'ASmetadata'], ['/mcp/chatgpt', 'exactMCP']]);
const DISCOVERY_METHODS = new Set(['GET', 'POST', 'HEAD', 'OPTIONS']);
const REQUEST_HEADERS = new Set(['accept', 'accept-language', 'content-type', 'content-length', 'range', 'if-range', 'if-none-match', 'last-event-id', 'mcp-session-id', 'mcp-protocol-version', 'mcp-method', 'mcp-name']);
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'set-cookie']);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const PAIR_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair this device · BLACKICE</title><link rel="stylesheet" href="/remote-auth.css"><script type="module" src="/remote-auth.js"></script></head><body><main><p class="brand">BLACKICE</p><h1>Pair this device</h1><p>On the computer running BLACKICE, open Settings → Remote access and create a pairing code.</p><form id="remote-pair-form"><label>Pairing code<input id="remote-code" type="password" autocomplete="one-time-code" required maxlength="80" spellcheck="false"></label><label>Device name<input id="remote-label" autocomplete="off" value="This browser" required maxlength="80"></label><button id="remote-submit" type="submit">Pair and open BLACKICE</button><p id="remote-error" role="alert"></p></form><p class="note">Every browser requires pairing. Codes expire after five minutes and work once. Outside agents use a separately issued bearer credential with selected permissions.</p></main></body></html>';
const PAIR_CSS = ':root{color-scheme:dark;font:16px system-ui;background:#08131a;color:#e6f0f5}*{box-sizing:border-box}body{margin:0;padding:24px;min-height:100vh;display:grid;place-items:center}main{width:min(100%,460px)}.brand{letter-spacing:.16em;font-weight:700;color:#bce7ee}h1{font-size:28px}p{line-height:1.6;color:#b9ccd6}form{display:grid;gap:18px;padding:24px;background:#11212b;border:1px solid #29404b;border-radius:12px}label{display:grid;gap:8px;font-size:14px}input,button{width:100%;font:inherit;min-height:44px;padding:10px 12px;border:1px solid #48616d;border-radius:6px;background:#091820;color:#e6f0f5}button{cursor:pointer;background:#bce7ee;color:#11212b;font-weight:650}button:disabled{opacity:.65}#remote-error{margin:0;color:#ffb8b3}.note{font-size:13px}';
const PAIR_SCRIPT = `const form=document.querySelector('#remote-pair-form'),code=document.querySelector('#remote-code'),label=document.querySelector('#remote-label'),button=document.querySelector('#remote-submit'),error=document.querySelector('#remote-error');const fragment=new URLSearchParams(location.hash.slice(1));if(fragment.has('code')){code.value=fragment.get('code');history.replaceState(null,'',location.pathname+location.search);}form.addEventListener('submit',async event=>{event.preventDefault();if(button.disabled)return;button.disabled=true;error.textContent='';try{const response=await fetch('/remote/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code.value,label:label.value})});const result=await response.json();if(!response.ok)throw Error(result.error||'Pairing failed.');code.value='';location.replace('/');}catch(cause){error.textContent=cause.message;button.disabled=false;code.focus();}});`;

export function validateRemoteOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.hostname || url.origin !== value) throw new Error('Use one exact private HTTPS origin without a path.');
  return url;
}
export function validateLoopbackTarget(origin, cookie) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password || !/^relay_session_\d+=[a-f0-9]{64}$/.test(cookie || '') || !cookie.startsWith(`relay_session_${url.port}=`)) throw new Error('The remote gateway requires the owned loopback server and its in-process session.');
  return url;
}
export function machineRemotePath(pathname) { return pathname === '/mcp' || /^\/api\/agent(?:\/|$)/.test(pathname); }
export function forwardedIdentityPath(pathname, method, kind) {
  return machineRemotePath(pathname) || kind === 'browser' && (
    method === 'POST' && /^\/api\/tasks\/[a-zA-Z0-9_-]+\/plan\/edit$/.test(pathname)
    || method === 'POST' && pathname === '/api/planning/organization'
    || WRITE_METHODS.has(method) && /^\/api\/planning-browser(?:\/|$)/.test(pathname)
    || ['POST', 'DELETE'].includes(method) && /^\/api\/tasks\/[a-zA-Z0-9_-]+\/plan\/presence$/.test(pathname)
  );
}
export function blockedRemotePath(pathname, method = 'GET') {
  return pathname === '/api/shutdown' || /^\/api\/(?:profile|maintenance)(?:\/|$)/.test(pathname) || /^\/api\/(?:remote-access|chatgpt-connector)(?:\/|$)/.test(pathname) || /^\/api\/desktop\/(?:background|show|quit)(?:\/|$)/.test(pathname)
    || WRITE_METHODS.has(method) && /^\/api\/(?:browser\/chrome\/connect|browser\/neo\/import|browseros\/show|email\/config|email\/oauth)(?:\/|$)/.test(pathname);
}

/** This listener is never exposed directly. Only the explicitly owned Tailscale HTTPS route reaches it. */
export class RemoteAccessGateway extends EventEmitter {
  constructor({ origin, targetOrigin, sessionCookie, sessions, forwardCredential, connector, mode = 'private', port = 0, now = Date.now } = {}) {
    super(); this.publicUrl = validateRemoteOrigin(origin); this.target = validateLoopbackTarget(targetOrigin, sessionCookie);
    this.backendCookie = sessionCookie; this.sessions = sessions; this.port = port; this.now = now; this.mode = mode; this.forwardCredential = forwardCredential; this.connector = connector || null;
    this.requests = new Map(); this.sockets = new Set(); this.closed = false; this.closePromise = null; this.listening = false; this.accepting = true;
    this.pairWindow = { at: now(), count: 0 }; this.discoveryRequests = [];
    this.revoked = ids => { for (const id of ids) this.disconnect(id); };
    sessions.on('revoked', this.revoked);
    this.server = http.createServer((req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) this.json(res, 502, { error: 'Remote access could not complete this request.' }); else res.destroy(); }); });
    this.server.requestTimeout = 30000; this.server.headersTimeout = 10000; this.server.keepAliveTimeout = 5000;
    this.server.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); });
    this.server.on('upgrade', (_req, socket) => socket.destroy());
    this.expiryTimer = setInterval(() => this.expireSessions(), 1000); this.expiryTimer.unref();
  }
  headers(res) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('X-Blackice-Access', 'remote');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  json(res, status, value) { if (res.destroyed) return; this.headers(res); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
  cookie(req) {
    const values = String(req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(REMOTE_COOKIE + '='));
    return values.length === 1 ? values[0].slice(REMOTE_COOKIE.length + 1) : null;
  }
  async jsonBody(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) throw Object.assign(Error('Send JSON.'), { status: 415 });
    const chunks = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > 2048) throw Object.assign(Error('The pairing request is too large.'), { status: 413 }); chunks.push(chunk); }
    try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(); return value; } catch { throw Object.assign(Error('Use a valid pairing request.'), { status: 400 }); }
  }
  remoteStatus(device) { return { available: true, enabled: true, state: 'remote', client: 'remote', clientKind: device.kind, localManagement: false, mode: this.mode, url: this.publicUrl.origin, endpoints: { mcp: this.publicUrl.origin + '/mcp', api: this.publicUrl.origin + '/api/agent' }, device }; }
  connectorDiscovery() { return this.discoveryRequests.map(entry => ({ ...entry })); }
  traceConnectorDiscovery(req, res) {
    // Record only fixed discovery categories. This is local, memory-only routing
    // evidence, never a client identity or authentication decision.
    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) return;
      const url = new URL(req.url, this.publicUrl);
      if (url.origin !== this.publicUrl.origin || /%(?:25|2f|5c|00)/i.test(url.pathname)) return;
      decodeURIComponent(url.pathname);
      const path = DISCOVERY_PATHS.get(url.pathname); if (!path) return;
      const method = DISCOVERY_METHODS.has(req.method) ? req.method : 'other';
      const funnel = req.headers['tailscale-funnel-request'] === '?1', at = new Date(this.now()).toISOString();
      res.once('finish', () => {
        if (this.closed) return;
        this.discoveryRequests.push({ at, path, method, statusCode: res.statusCode, funnel });
        if (this.discoveryRequests.length > 32) this.discoveryRequests.splice(0, this.discoveryRequests.length - 32);
      });
    } catch {} // Optional diagnostics must never change request handling.
  }
  async handle(req, res) {
    this.headers(res); this.traceConnectorDiscovery(req, res);
    if (this.closed || !this.accepting) return this.json(res, 503, { error: 'Remote access is unavailable on this computer.' });
    if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::ffff:127.0.0.1') return this.json(res, 403, { error: 'Use the configured HTTPS address.' });
    if (req.headers.host !== this.publicUrl.host) return this.json(res, 403, { error: 'Unrecognized remote host.' });
    if (!METHODS.has(req.method)) return this.json(res, 405, { error: 'Method not allowed.' });
    let url;
    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) throw Error();
      url = new URL(req.url, this.publicUrl); if (url.origin !== this.publicUrl.origin || /%(?:25|2f|5c|00)/i.test(url.pathname)) throw Error();
      decodeURIComponent(url.pathname);
    } catch { return this.json(res, 400, { error: 'Invalid remote request path.' }); }
    const pathname = url.pathname;
    // The separate ChatGPT endpoint owns OAuth authentication. It never receives
    // the local UI cookie or legacy agent forwarding authority. Host and owned
    // loopback/TLS route checks above still apply to every request.
    if (this.connector?.matches(pathname)) return this.connector.handle(req, res);
    const authorization = req.headers.authorization;
    const authorizationCount = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'authorization').length;
    const bearer = authorizationCount === 1 && typeof authorization === 'string' && /^Bearer blackice_agent_[A-Za-z0-9_-]{43}$/.test(authorization) ? authorization.slice(7) : null;
    const device = authorization !== undefined ? this.sessions.authenticate(bearer, 'agent') : this.sessions.authenticate(this.cookie(req), 'browser');
    const externalNavigation = ['/', '/index.html'].includes(pathname) && ['GET', 'HEAD'].includes(req.method) && req.headers['sec-fetch-mode'] === 'navigate' && !req.headers.origin;
    if (req.headers.origin && req.headers.origin !== this.publicUrl.origin || WRITE_METHODS.has(req.method) && authorization === undefined && req.headers.origin !== this.publicUrl.origin || ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']) && !externalNavigation) return this.json(res, 403, { error: 'Use the exact BLACKICE HTTPS origin.' });
    if (authorization !== undefined && !device) { res.setHeader('WWW-Authenticate', 'Bearer realm="BLACKICE"'); return this.json(res, 401, { error: 'Use an unexpired BLACKICE agent credential.', code: 'REMOTE_CREDENTIAL_REQUIRED' }); }
    if (device?.kind === 'agent' && !machineRemotePath(pathname) && !(pathname === '/remote/session' && req.method === 'GET')) return this.json(res, 403, { error: 'Agent credentials can use only the scoped MCP and agent API endpoints.', code: 'REMOTE_AGENT_ROUTE_REQUIRED' });
    if (req.method === 'GET' && ['/remote-auth.js', '/remote-auth.css'].includes(pathname)) {
      res.writeHead(200, { 'Content-Type': pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' }); return res.end(pathname.endsWith('.js') ? PAIR_SCRIPT : PAIR_CSS);
    }
    if (!device && ['/', '/index.html'].includes(pathname) && ['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(req.method === 'HEAD' ? undefined : PAIR_HTML);
    }
    if (['/remote/pair', '/remote/agent/pair'].includes(pathname) && req.method === 'POST') {
      if (this.now() - this.pairWindow.at >= 60000) this.pairWindow = { at: this.now(), count: 0 };
      if (++this.pairWindow.count > 20) { res.setHeader('Retry-After', '60'); return this.json(res, 429, { error: 'Too many pairing attempts. Wait a minute and create a fresh code.' }); }
      try {
        const value = await this.jsonBody(req); if (Object.keys(value).some(key => !['code', 'label'].includes(key))) throw Object.assign(Error('Use the pairing code and device name.'), { status: 400 });
        const agentPairing = pathname === '/remote/agent/pair';
        const result = await this.sessions[agentPairing ? 'pairAgent' : 'pair'](value.code, value.label);
        if (this.closed) return this.json(res, 503, { error: 'Remote access is closing.' });
        if (agentPairing) return this.json(res, 200, { paired: true, kind: 'agent', token: result.token, device: result.device, url: this.publicUrl.origin, endpoints: { mcp: this.publicUrl.origin + '/mcp', api: this.publicUrl.origin + '/api/agent' } });
        res.setHeader('Set-Cookie', `${REMOTE_COOKIE}=${result.token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.floor((Date.parse(result.device.expiresAt) - this.now()) / 1000))}`);
        return this.json(res, 200, { paired: true, device: result.device });
      } catch (cause) { return this.json(res, cause.status || 503, { error: cause.status ? cause.message : 'Pairing could not be saved. Create a fresh code on the computer running BLACKICE.', ...(cause.status && /^REMOTE_[A-Z_]+$/.test(cause.code || '') ? { code: cause.code } : {}) }); }
    }
    if (!device) return this.json(res, 401, { error: 'Pair this browser with BLACKICE before using remote access.', code: 'REMOTE_PAIRING_REQUIRED' });
    if ((pathname === '/remote/session' || pathname === '/api/remote-access') && req.method === 'GET') return this.json(res, 200, this.remoteStatus(device));
    if (pathname === '/remote/logout' && req.method === 'POST') {
      await this.sessions.revoke(device.id);
      res.setHeader('Set-Cookie', `${REMOTE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`); return this.json(res, 200, { loggedOut: true });
    }
    if (pathname.startsWith('/remote/') || blockedRemotePath(pathname, req.method)) return this.json(res, 403, { error: 'Manage this setting on the computer running BLACKICE.', code: 'REMOTE_LOCAL_ONLY' });
    if (forwardedIdentityPath(pathname, req.method, device.kind) && typeof this.forwardCredential !== 'function') return this.json(res, 503, { error: 'The verified remote client interface is unavailable.' });
    if (Number(req.headers['content-length'] || 0) > BODY_LIMIT) return this.json(res, 413, { error: 'The request is too large.' });
    if ([...this.requests.values()].reduce((count, set) => count + set.size, 0) >= 80) return this.json(res, 503, { error: 'Too many active remote requests. Close unused tabs and retry.' });
    return this.proxy(req, res, url.pathname + url.search, device);
  }
  proxy(req, res, requestPath, device) {
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (REQUEST_HEADERS.has(name) && value !== undefined) headers[name] = value;
    headers.host = this.target.host; headers.origin = this.target.origin; headers.cookie = this.backendCookie;
    headers['sec-fetch-site'] = 'same-origin'; headers['x-blackice-remote'] = '1';
    if (forwardedIdentityPath(new URL(requestPath, this.publicUrl).pathname, req.method, device.kind)) headers['x-blackice-forward'] = this.forwardCredential({ method: req.method, path: requestPath, client: device });
    const group = this.requests.get(device.id) || new Set(); this.requests.set(device.id, group);
    const pending = { req, res, upstream: null }; group.add(pending);
    const upstream = pending.upstream = http.request({ hostname: '127.0.0.1', port: this.target.port, method: req.method, path: requestPath, headers, agent: false }, response => {
      for (const [name, value] of Object.entries(response.headers)) if (!HOP_HEADERS.has(name) && name !== 'content-security-policy' && name !== 'location' && value !== undefined) res.setHeader(name, value);
      if (response.headers.location) {
        try { const location = new URL(response.headers.location, this.target); if (location.origin === this.target.origin) res.setHeader('Location', this.publicUrl.origin + location.pathname + location.search); } catch {}
      }
      this.headers(res); res.writeHead(response.statusCode || 502); response.pipe(res);
      response.once('error', () => res.destroy());
    });
    const finished = () => { group.delete(pending); if (!group.size) this.requests.delete(device.id); if (!upstream.destroyed) upstream.destroy(); };
    res.once('close', finished); res.once('finish', finished);
    req.once('aborted', () => upstream.destroy());
    upstream.once('error', () => { if (!res.headersSent) this.json(res, 502, { error: 'The local BLACKICE runtime is unavailable.' }); else res.destroy(); });
    let transferred = 0;
    req.on('data', chunk => { transferred += chunk.length; if (transferred > BODY_LIMIT) { upstream.destroy(); if (!res.headersSent) this.json(res, 413, { error: 'The request is too large.' }); else res.destroy(); req.resume(); } });
    req.pipe(upstream);
  }
  disconnect(id) { for (const pending of this.requests.get(id) || []) { pending.upstream?.destroy(); pending.res.destroy(); } this.requests.delete(id); }
  suspend() { this.accepting = false; for (const id of this.requests.keys()) this.disconnect(id); }
  expireSessions() { const valid = new Set(this.sessions.status().devices.map(device => device.id)); for (const id of this.requests.keys()) if (!valid.has(id)) this.disconnect(id); }
  async listen() {
    if (this.closed) throw Error('The remote gateway is closed.');
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.port, '127.0.0.1', () => { this.server.off('error', reject); resolve(); }); });
    this.port = this.server.address().port; this.listening = true; return `http://127.0.0.1:${this.port}`;
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.listening = false; this.discoveryRequests = []; clearInterval(this.expiryTimer); this.sessions.off('revoked', this.revoked);
    for (const id of this.requests.keys()) this.disconnect(id);
    this.closePromise = new Promise(resolve => { this.server.close(() => resolve()); for (const socket of this.sockets) socket.destroy(); this.server.closeAllConnections?.(); });
    return this.closePromise;
  }
}
