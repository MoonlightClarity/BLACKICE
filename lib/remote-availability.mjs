import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { matchesHttpsAuthority } from './remote-authority.mjs';
import { CHATGPT_OAUTH_CLIENT_ID, CHATGPT_OAUTH_SCOPES } from './chatgpt-oauth.mjs';
import { OAUTH_CLIENT_AUTH_METHODS, validateRegisteredOAuthClients, findRegisteredOAuthClient } from './mcp-oauth-clients.mjs';
import {
  CHATGPT_MCP_PATH, CHATGPT_PROTOCOLS, decodeMCPRequest, invalidParams,
  methodNotFound, readMCPBody, sendJSON, sendRPCError, sendRPCResult, toolResult,
} from './chatgpt-mcp-protocol.mjs';

export const REMOTE_AVAILABILITY_VERSION = 7;

const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1']);
const HASH = /^[a-f0-9]{64}$/;
const equal = (a, b) => HASH.test(a || '') && HASH.test(b || '') && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const fail = (message, code = 'BLACKICE_UNREACHABLE', status = 503) => Object.assign(new Error(message), { code, status });
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const STATUS_TOOL = { name: 'blackice_direct_status', description: 'Read BLACKICE connection availability.', inputSchema: { type: 'object', properties: { nonce: { type: 'string', maxLength: 120 } } }, securitySchemes: [{ type: 'oauth2', scopes: ['read'] }] };

const EARLY_REJECTION_LIMIT = 32;
const DIAGNOSTIC_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const DIAGNOSTIC_ENDPOINTS = new Map([
  [CHATGPT_MCP_PATH, 'mcp'],
  ['/.well-known/oauth-protected-resource', 'resource-root'],
  ['/.well-known/oauth-protected-resource/mcp/chatgpt', 'resource-path'],
  ['/.well-known/oauth-authorization-server', 'authorization-metadata'],
  ['/chatgpt/oauth/register', 'oauth-register'],
  ['/chatgpt/oauth/authorize', 'oauth-authorize'],
  ['/chatgpt/oauth/token', 'oauth-token'],
  ['/chatgpt/oauth/revoke', 'oauth-revoke'],
]);
const DIAGNOSTIC_MISTRAL_ORIGINS = new Map([
  ['https://chat.mistral.ai', 'mistral-chat'],
  ['https://mistral.ai', 'mistral-home'],
  ['https://admin.mistral.ai', 'mistral-admin'],
]);

// Classification is diagnostic only. It never changes the exact-origin policy.
function diagnosticOrigin(value, origin) {
  if (value === undefined) return 'absent';
  if (value === origin) return 'blackice';
  if (DIAGNOSTIC_MISTRAL_ORIGINS.has(value)) return DIAGNOSTIC_MISTRAL_ORIGINS.get(value);
  if (typeof value !== 'string' || value.length > 2048) return 'malformed';
  if (value === 'null') return 'other';
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && url.origin === value && !url.username && !url.password ? 'other' : 'malformed';
  } catch { return 'malformed'; }
}

function diagnosticEndpoint(value) {
  if (typeof value !== 'string' || value.length > 8192 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return 'invalid';
  try { return DIAGNOSTIC_ENDPOINTS.get(new URL(value, 'https://blackice.invalid').pathname) || 'other'; }
  catch { return 'invalid'; }
}

export function processPresence(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : null; }
}

function loopbackOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.origin !== value || url.username || url.password) throw Error('Use the exact local BLACKICE gateway.');
  return url;
}

/** Read-only verification of the existing grant. Never rotate, revoke, or persist credentials. */
export async function readAvailabilityGrant(req, { dataDir, origin, now = Date.now } = {}) {
  const header = req.headers?.authorization;
  if ((req.rawHeaders || []).filter((_, index, list) => index % 2 === 0 && String(list[index]).toLowerCase() === 'authorization').length > 1
    || typeof header !== 'string' || !/^Bearer blackice_at_[A-Za-z0-9_-]{43}$/i.test(header)
    || !/^blackice_at_[A-Za-z0-9_-]{43}$/.test(header.slice(7))) return null;
  const file = path.join(dataDir, 'chatgpt-oauth.json');
  let value, clients;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw Error('Invalid grant store.');
    value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (![1, 2].includes(value.schema) || !Array.isArray(value.grants) || value.grants.length > 20) throw Error('Invalid grant store.');
    clients = value.schema === 2 ? validateRegisteredOAuthClients(value.clients) : [];
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw fail('BLACKICE is unavailable and its saved connection could not be read. Open BLACKICE to inspect the connection; no credentials were changed.', 'BLACKICE_CONNECTION_UNAVAILABLE');
  }
  const hash = createHash('sha256').update(header.slice(7)).digest('hex'), at = now();
  const knownClient = grant => {
    if (grant.clientId === CHATGPT_OAUTH_CLIENT_ID) return true;
    const client = findRegisteredOAuthClient(clients, grant.clientId);
    return Boolean(client && grant.label === client.clientName);
  };
  const candidates = value.grants.filter(grant => grant && typeof grant.id === 'string'
    && knownClient(grant) && grant.resource === origin + CHATGPT_MCP_PATH
    && Date.parse(grant.expiresAt) > at && Array.isArray(grant.scopes) && grant.scopes.includes('read')
    && grant.scopes.every(scope => CHATGPT_OAUTH_SCOPES.includes(scope)) && Array.isArray(grant.accessTokens)
    && grant.accessTokens.some(token => Date.parse(token.expiresAt) > at
      && Date.parse(token.expiresAt) <= Date.parse(grant.expiresAt) && equal(token.hash, hash)));
  if (candidates.length !== 1) return null;
  return { id: candidates[0].id, scopes: [...candidates[0].scopes] };
}

/** A stable transport endpoint. The main application exclusively owns execution and OAuth writes. */
export class RemoteAvailabilityResponder {
  constructor({ dataDir, origin, port = 0, now = Date.now, presence = processPresence } = {}) {
    const publicUrl = new URL(origin);
    if (publicUrl.protocol !== 'https:' || publicUrl.origin !== origin || publicUrl.username || publicUrl.password) throw Error('Use the existing exact HTTPS origin.');
    Object.assign(this, { dataDir, origin, publicUrl, port, now, presence });
    this.application = { pid: null, state: 'unreachable', target: null, enabled: false, tools: [], version: 'unknown' };
    this.earlyRejectionTotal = 0; this.earlyRejectionCounts = { source: 0, host: 0, path: 0, origin: 0 }; this.earlyRejections = [];
    this.sockets = new Set(); this.pending = new Set(); this.closed = false; this.generation = 0; this.intentionalOffline = false; this.lifetimeGeneration = null;
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch(error => { if (!res.headersSent) sendJSON(res, error.status || 503, { error: error.message, code: error.code || 'BLACKICE_UNREACHABLE' }); else res.destroy(); });
    });
    this.server.requestTimeout = 30000; this.server.headersTimeout = 10000; this.server.keepAliveTimeout = 5000;
    this.server.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); });
    this.server.on('upgrade', (_req, socket) => socket.destroy());
  }

  configure(value) {
    value = { tools: this.application.tools, version: this.application.version, ...value };
    if (!value || !Number.isSafeInteger(value.pid) || value.pid < 1
      || !['starting', 'ready', 'closing'].includes(value.state) || typeof value.enabled !== 'boolean'
      || typeof value.version !== 'string' || !Array.isArray(value.tools)) throw Error('Provide the application process and connection state.');
    if (this.application.pid && value.pid !== this.application.pid && this.application.target && this.applicationPresent()) throw fail('Another BLACKICE process still owns this route.', 'BLACKICE_PROCESS_ACTIVE', 409);
    const target = value.target === null ? null : loopbackOrigin(value.target);
    if (value.state === 'ready' && !target) throw Error('Ready BLACKICE must have a local gateway.');
    if (target && Number(target.port) === this.port) throw Error('The availability route cannot proxy to itself.');
    this.application = { ...value, target: target?.origin || null, tools: structuredClone(value.tools) };
    this.generation++; this.intentionalOffline = false; this.lifetimeGeneration = null;
    return this.status();
  }

  connected(generation) {
    if (generation !== this.generation) return false;
    this.lifetimeGeneration = generation;
    return true;
  }

  applicationPresent() {
    const alive = this.presence(this.application.pid);
    // A persistent unelevated responder cannot signal an elevated Windows app.
    // Only its authenticated, current-generation lifetime socket resolves that
    // unknown result; a dead process or a stale socket never does.
    return alive === true || alive === null && this.lifetimeGeneration === this.generation;
  }

  offline(state = 'closing') {
    if (!['starting', 'closing'].includes(state)) throw Error('Use starting or closing during a lifecycle transition.');
    this.application = { ...this.application, state, target: null };
    this.intentionalOffline = true; this.lifetimeGeneration = null;
    return this.status();
  }

  disconnected(generation) {
    if (generation !== this.generation) return;
    this.lifetimeGeneration = null;
    // A lifetime connection belongs to one application generation, not a reusable OS PID.
    this.application = { ...this.application, target: null, state: this.intentionalOffline ? this.application.state : 'unreachable' };
  }

  catalog() {
    const list = structuredClone(this.application.tools);
    if (!list.some(tool => tool.name === STATUS_TOOL.name)) list.push(structuredClone(STATUS_TOOL));
    return list;
  }

  status({ delivery = 'not-sent', nonce } = {}) {
    const alive = this.presence(this.application.pid);
    const state = alive === false ? 'closed' : alive === true && ['starting', 'closing'].includes(this.application.state) ? this.application.state : 'unreachable';
    const message = {
      closed: 'BLACKICE is closed on this computer. Open BLACKICE and retry this request.',
      starting: 'BLACKICE is starting. Wait for the application to finish opening, then retry this request.',
      closing: 'BLACKICE is closing. Open BLACKICE again before retrying this request.',
      unreachable: 'BLACKICE could not be reached. Its process may still be running; check the application and retry when it is available.',
    }[state];
    return {
      app: 'BLACKICE', mode: 'direct-execution', available: false, state, responderVersion: REMOTE_AVAILABILITY_VERSION,
      code: 'BLACKICE_' + state.toUpperCase(), message,
      modelStarted: delivery === 'not-sent' ? false : null, providerTurns: delivery === 'not-sent' ? false : null,
      responderModelStarted: false,
      action: { admitted: delivery === 'not-sent' ? false : null, outcome: delivery === 'not-sent' ? 'not-started' : 'unknown', automaticReplay: false },
      ...(delivery !== 'not-sent' ? { recovery: 'The connection was lost after delivery may have begun. Read the saved job, or retry identical arguments with the same requestId under the same connection after BLACKICE returns.' } : {}),
      ...(nonce !== undefined ? { nonce } : {}),
    };
  }

  // Only the authenticated local controller exposes this detached snapshot.
  earlyRejectionDiagnostics() {
    return { schema: 1, capacity: EARLY_REJECTION_LIMIT, total: this.earlyRejectionTotal,
      counts: { ...this.earlyRejectionCounts }, recent: this.earlyRejections.map(value => ({ ...value })) };
  }

  recordEarlyRejection(req, reason, statusCode) {
    try {
      const value = { at: new Date(this.now()).toISOString(), reason, statusCode,
        method: DIAGNOSTIC_METHODS.has(req.method) ? req.method : 'other',
        endpoint: diagnosticEndpoint(req.url), origin: diagnosticOrigin(req.headers.origin, this.origin) };
      this.earlyRejectionTotal++; this.earlyRejectionCounts[reason]++;
      this.earlyRejections.push(value);
      if (this.earlyRejections.length > EARLY_REJECTION_LIMIT) this.earlyRejections.shift();
    } catch {} // Optional diagnostics must never change request handling.
  }

  async enabled() {
    try {
      const [remote, connector] = await Promise.all([
        fs.readFile(path.join(this.dataDir, 'remote-access.json'), 'utf8'),
        fs.readFile(path.join(this.dataDir, 'chatgpt-connector.json'), 'utf8'),
      ]);
      return JSON.parse(remote).enabled === true && JSON.parse(connector).enabled === true;
    } catch { throw fail('BLACKICE is unavailable and its connection settings could not be read. Open BLACKICE to inspect them.', 'BLACKICE_CONNECTION_UNAVAILABLE'); }
  }

  async handle(req, res) {
    if (!LOOPBACK.has(req.socket.remoteAddress) || !matchesHttpsAuthority(req.headers.host, this.publicUrl)) {
      this.recordEarlyRejection(req, !LOOPBACK.has(req.socket.remoteAddress) ? 'source' : 'host', 403);
      return sendJSON(res, 403, { error: 'Use the configured BLACKICE HTTPS address.' });
    }
    if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) {
      this.recordEarlyRejection(req, 'path', 400);
      return sendJSON(res, 400, { error: 'Use a relative endpoint path.' });
    }
    const url = new URL(req.url, this.origin);
    if (url.origin !== this.origin || req.headers.origin && req.headers.origin !== this.origin) {
      this.recordEarlyRejection(req, 'origin', 403);
      return sendJSON(res, 403, { error: 'Unrecognized connector origin.' });
    }

    const mcp = url.pathname === CHATGPT_MCP_PATH;
    const canProxy = () => this.application.state === 'ready' && this.application.target && this.applicationPresent();
    let request;
    // Buffer only authenticated MCP requests so a lost connection retains their
    // JSON-RPC ID. The live application owns authentication; unknown credentials
    // reach it untouched so its challenge precedes content or protocol parsing.
    if (mcp && req.method === 'POST') {
      if (!canProxy() && !await this.enabled()) {

        return sendJSON(res, 503, { error: 'The BLACKICE connector is disabled.', code: 'CHATGPT_CONNECTOR_DISABLED' });
      }
      let client;
      try { client = await readAvailabilityGrant(req, { dataDir: this.dataDir, origin: this.origin, now: this.now }); }
      catch (error) { if (canProxy()) return this.proxy(req, res); throw error; }
      if (!client) return canProxy() ? this.proxy(req, res) : this.unavailable(req, res);
      try { request = await readMCPBody(req); }
      catch (error) { return sendRPCError(res, null, error); }
    }
    if (canProxy()) return this.proxy(req, res, request);
    return this.unavailable(req, res, request);
  }

  proxy(req, res, request) {
    const target = new URL(this.application.target);
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP_HEADERS.has(name)));
    const body = request === undefined ? undefined : Buffer.from(JSON.stringify(request));
    if (body) headers['content-length'] = String(body.length);
    let connected = false;
    const upstream = http.request({ hostname: '127.0.0.1', port: target.port, method: req.method, path: req.url, headers, agent: false }, response => {
      for (const [name, value] of Object.entries(response.headers)) if (!HOP_HEADERS.has(name) && value !== undefined) res.setHeader(name, value);
      res.writeHead(response.statusCode || 502); response.pipe(res); response.once('error', () => res.destroy());
    });
    this.pending.add(upstream);
    upstream.once('socket', socket => { socket.once('connect', () => { connected = true; }); });
    upstream.once('error', () => {
      this.pending.delete(upstream);
      if (res.headersSent || res.destroyed) return res.destroy();
      void this.unavailable(req, res, request, connected ? 'uncertain' : 'not-sent').catch(error => sendJSON(res, 503, { error: error.message, code: error.code || 'BLACKICE_UNREACHABLE' }));
    });
    const finish = () => { this.pending.delete(upstream); if (!upstream.destroyed) upstream.destroy(); };
    res.once('close', finish); res.once('finish', finish);
    req.once('aborted', () => upstream.destroy());
    upstream.setTimeout(30000, () => upstream.destroy(fail('BLACKICE did not answer in time.')));
    if (body) upstream.end(body); else req.pipe(upstream);
  }

  async unavailable(req, res, request, delivery = 'not-sent') {

    const url = new URL(req.url, this.origin);
    const state = this.status({ delivery });
    if (url.pathname.startsWith('/chatgpt/oauth/')) {
      res.setHeader('Retry-After', '3');
      return sendJSON(res, 503, { error: 'temporarily_unavailable', error_description: state.message, code: state.code });
    }
    const resource = this.origin + CHATGPT_MCP_PATH;
    if (req.method === 'GET' && !url.search && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp/chatgpt'].includes(url.pathname)) {
      return sendJSON(res, 200, { resource, authorization_servers: [this.origin], bearer_methods_supported: ['header'], scopes_supported: [...CHATGPT_OAUTH_SCOPES] });
    }
    if (req.method === 'GET' && !url.search && url.pathname === '/.well-known/oauth-authorization-server') {
      return sendJSON(res, 200, { issuer: this.origin, authorization_endpoint: this.origin + '/chatgpt/oauth/authorize', token_endpoint: this.origin + '/chatgpt/oauth/token', revocation_endpoint: this.origin + '/chatgpt/oauth/revoke', registration_endpoint: this.origin + '/chatgpt/oauth/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: [...OAUTH_CLIENT_AUTH_METHODS], revocation_endpoint_auth_methods_supported: [...OAUTH_CLIENT_AUTH_METHODS], code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true });
    }
    if (url.pathname !== CHATGPT_MCP_PATH) return sendJSON(res, 503, { error: state.message, code: state.code, state: state.state });
    if (!await this.enabled()) return sendJSON(res, 503, { error: 'The BLACKICE connector is disabled.', code: 'CHATGPT_CONNECTOR_DISABLED' });
    if (req.method !== 'POST') return sendJSON(res, 405, { error: state.message, code: state.code });
    const client = await readAvailabilityGrant(req, { dataDir: this.dataDir, origin: this.origin, now: this.now });
    if (!client) {
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${this.origin}/.well-known/oauth-protected-resource/mcp/chatgpt", error="invalid_token", scope="read"`);
      return sendJSON(res, 401, { error: 'The existing BLACKICE access token is unavailable or expired. Open BLACKICE to resume the connection.', code: 'CHATGPT_AUTH_REQUIRED', state: state.state });
    }
    if (url.search) return sendJSON(res, 405, { error: state.message, code: state.code });
    try {
      const { params, modern, notification } = decodeMCPRequest(request, req.headers);
      const reply = result => sendRPCResult(res, request, modern, { name: 'BLACKICE direct execution', version: this.application.version }, result);
      if (notification) { res.writeHead(202, { 'Cache-Control': 'no-store' }); return res.end(); }
      if (!modern && request.method === 'initialize') return reply({ protocolVersion: CHATGPT_PROTOCOLS.slice(1).includes(params.protocolVersion) ? params.protocolVersion : CHATGPT_PROTOCOLS[1], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'BLACKICE direct execution', version: this.application.version }, instructions: state.message + ' This availability responder does not execute, replay, or queue actions.' });
      if (modern && request.method === 'server/discover') return reply({ supportedVersions: CHATGPT_PROTOCOLS, capabilities: { tools: { listChanged: false } }, instructions: state.message });
      if (request.method === 'ping') return reply({});
      if (request.method === 'tools/list') return reply({ tools: this.catalog() });
      if (request.method !== 'tools/call') throw methodNotFound(modern);
      const tool = this.catalog().find(item => item.name === params.name);
      if (!tool) throw invalidParams('Unknown BLACKICE direct tool.');
      const required = [...new Set(['read', ...(tool.securitySchemes || []).flatMap(scheme => scheme.type === 'oauth2' ? scheme.scopes || [] : [])])];
      if (required.some(scope => !client.scopes.includes(scope))) return reply(toolResult({ error: 'This connection lacks the required BLACKICE scope.', code: 'CHATGPT_SCOPE_REQUIRED', requiredScopes: required }, true));
      const nonce = params.name === 'blackice_direct_status' && typeof params.arguments?.nonce === 'string' && /^[A-Za-z0-9_.:-]{0,120}$/.test(params.arguments.nonce) ? params.arguments.nonce : undefined;
      const result = { ...this.status({ delivery, nonce }), connectionId: client.id, grantedScopes: client.scopes };
      return reply(toolResult(result, params.name !== 'blackice_direct_status'));
    } catch (error) { return sendRPCError(res, request, error); }
  }

  async listen() {
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.port, '127.0.0.1', () => { this.server.off('error', reject); resolve(); }); });
    this.port = this.server.address().port; return `http://127.0.0.1:${this.port}`;
  }
  async close() {
    if (this.closed) return; this.closed = true;
    for (const request of this.pending) request.destroy();
    await new Promise(resolve => { this.server.close(resolve); for (const socket of this.sockets) socket.destroy(); });
  }
}
