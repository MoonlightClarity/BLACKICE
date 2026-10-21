import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeRemoteJson } from './remote-access-auth.mjs';

export const CHATGPT_MCP_PATH = '/mcp/chatgpt';
export const CHATGPT_PROTOCOLS = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18']);
export const CHATGPT_SCOPES = Object.freeze(['read', 'files:read', 'files:write', 'commands:run', 'browser:read', 'browser:write', 'planning:write']);
const META = 'io.modelcontextprotocol/';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 400, code = 'CHATGPT_REQUEST_INVALID') => Object.assign(new Error(message), { status, code });
const json = (res, status, value) => { if (res.destroyed) return; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const errorValue = error => ({ error: error.message || 'The BLACKICE action could not be completed.', code: error.code || 'CHATGPT_ACTION_FAILED', ...(Number.isSafeInteger(error.currentRevision) ? { currentRevision: error.currentRevision } : {}), ...(error.scope ? { requiredScope: error.scope } : {}), ...(Array.isArray(error.requiredScopes) ? { requiredScopes: error.requiredScopes.filter(scope => CHATGPT_SCOPES.includes(scope)) } : {}) });

/** ChatGPT is the reasoning client. This transport never calls a model provider. */
export class ChatGPTConnector {
  constructor({ dataDir, execution, planning, oauth, version, isClosing = () => false, onChange = () => {} }) {
    Object.assign(this, { execution, planning, oauth, version, isClosing, onChange });
    this.file = path.join(dataDir, 'chatgpt-connector.json');
    this.enabled = false; this.closed = false; this.origin = null; this.healthy = true; this.error = null; this.tail = Promise.resolve(); this.lastCall = null; this.inflight = new Set();
    this.authDiagnostics = { invalidBearerChallenges: 0, linkingChallenges: 0, scopeChallenges: 0, authorizationLostChallenges: 0, lastChallenge: null };
  }
  async init() {
    try {
      const stat = await fs.stat(this.file);
      if (!stat.isFile() || stat.size > 4096) throw Error();
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!object(value) || value.version !== 1 || typeof value.enabled !== 'boolean' || Object.keys(value).some(key => !['version', 'enabled'].includes(key))) throw Error();
      this.enabled = value.enabled;
    } catch (error) {
      if (error.code !== 'ENOENT') { this.healthy = false; this.error = 'ChatGPT connector settings could not be read. Existing settings were preserved.'; }
    }
    return this;
  }
  setOrigin(origin) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw Error('The connector requires its exact owned HTTPS origin.');
    this.origin = origin;
    this.oauth.setOrigin(origin);
  }
  matches(pathname) { return pathname === CHATGPT_MCP_PATH || this.oauth.matches(pathname); }
  async status() {
    const oauth = await this.oauth.status(), actions = await this.execution.status();
    return { available: !this.closed && this.healthy && oauth.healthy !== false && actions.available !== false, enabled: !this.closed && this.enabled && this.healthy, error: this.error || oauth.error || actions.storageError?.message, endpoint: this.origin ? this.origin + CHATGPT_MCP_PATH : null,
      authentication: 'OAuth 2.1 with PKCE', execution: 'direct', modelCalls: false, requiresWorkComputerTools: false,
      scopes: [...CHATGPT_SCOPES], oauth, actions, lastAuthenticatedToolCall: this.lastCall,
      authDiagnostics: { ...this.authDiagnostics, lastChallenge: this.authDiagnostics.lastChallenge ? { ...this.authDiagnostics.lastChallenge } : null },
      chatSurfaceVerification: 'not-recorded', compatibility: { transport: 'streamable-http', protocolVersions: [...CHATGPT_PROTOCOLS], automaticChatWakeup: false, backgroundResults: 'Poll the durable action ID in the same conversation.' } };
  }
  recordAuthChallenge(kind, { method, statusCode, tool = null } = {}) {
    // Process-local counters describe transport behavior only. Never retain
    // credentials, request headers, arguments, URLs or token fingerprints.
    this.authDiagnostics[kind]++;
    this.authDiagnostics.lastChallenge = { kind, at: new Date().toISOString(), method, statusCode, tool };
    try { this.onChange(); } catch {} // Optional diagnostics cannot affect auth.
  }
  invalidBearer(req, res, requiredScopes, { tool = null, result = null, authorizationLost = false } = {}) {
    const challenge = this.oauth.challenge(requiredScopes, 'invalid_token');
    this.recordAuthChallenge(authorizationLost ? 'authorizationLostChallenges' : 'invalidBearerChallenges', { method: req.method, statusCode: 401, tool });
    res.setHeader('WWW-Authenticate', challenge);
    // MCP requires invalid/expired access credentials to receive HTTP 401.
    // A tool-level OAuth error instead asks ChatGPT to display linking UI.
    // Reject before admission; the client can refresh and retry its same ID.
    return json(res, 401, result || { error: 'The BLACKICE access token is invalid or expired. Refresh the connection credentials and retry the same request.', code: 'CHATGPT_AUTH_REQUIRED' });
  }
  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') return Promise.reject(fail('Choose whether the ChatGPT connector is enabled.'));
    const next = this.tail.catch(() => {}).then(async () => {
      if (!this.healthy) throw fail(this.error, 503, 'CHATGPT_SETTINGS_UNAVAILABLE');
      if (enabled && (this.closed || this.isClosing())) throw fail('BLACKICE is closing or preparing maintenance.', 503, 'CHATGPT_CONNECTOR_DISABLED');
      if (enabled && (await this.oauth.status()).healthy === false) throw fail('ChatGPT authorization storage needs local recovery before enabling access.', 503, 'CHATGPT_AUTH_UNAVAILABLE');
      if (enabled && (await this.execution.status()).available === false) throw fail('Direct execution storage or runtime needs local recovery before enabling access.', 503, 'CHATGPT_EXECUTION_UNAVAILABLE');
      // Stop admission immediately, before durable cleanup or revocation.
      if (!enabled) this.enabled = false;
      await writeRemoteJson(this.file, { version: 1, enabled });
      this.enabled = enabled && !this.closed;
      if (!enabled) await this.oauth.revokeAll();
      this.onChange(); return this.status();
    });
    this.tail = next; return next;
  }
  tools() {
    return [...this.execution.tools(), ...this.planning.tools()].map(({ scope, requiredScope, requiredScopes, scopes, ...definition }) => {
      const required = requiredScopes || scopes || [scope || requiredScope || 'read'];
      return { ...definition, securitySchemes: [{ type: 'oauth2', scopes: [...new Set(['read', ...required])] }],
        _meta: { ...definition._meta, 'openai/toolInvocation/invoking': 'Contacting BLACKICE', 'openai/toolInvocation/invoked': 'Action status received' } };
    });
  }
  instructions() {
    const restart = this.execution.tools().some(tool => tool.name === 'blackice_restart')
      ? ' For a requested restart or a restart needed to activate a completed update, use blackice_restart with one stable requestId. Its successful job confirms scheduling only. After reconnecting on the same grant, read blackice_direct_status and require restart.receipt.status completed for that request before claiming completion. A failed, cancelled, interrupted, or busy restart is not permission to close the app.'
      : ' This runtime has no native desktop restart tool. Leave BLACKICE running if an update needs a newer process; do not improvise a restart.';
    return 'Use BLACKICE as a direct execution backend while you reason in this ChatGPT conversation. This connector never starts another model-backed worker. Read saved plans and exact revisions before editing. Active plans are the default; groups and plan names have a separate organization revision. Every execution action has a caller-supplied requestId and durable jobId. Reuse the same requestId and identical arguments after a transport failure, then read the returned jobId; never invent a new requestId just to retry an uncertain mutation. Pending, awaiting_input, running, cancelling and interrupted are not success. Poll blackice_get_job until settled; return the actual result in this conversation. A lost HTTP connection does not cancel the action. Use blackice_cancel_job explicitly and read the resulting state. Actions execute directly within the existing OAuth scopes without a separate BLACKICE action approval. Sign-ins and website dialogs may still require local interaction. Legacy pending approvals are never replayed; cancel them and inspect effects before requesting new work. Never claim that an awaiting_input or interrupted action completed. Uploaded files are imported only; a website upload is a separate authorized browser action. No automatic notification back into an idle ChatGPT conversation is assumed.' + restart + ' Never substitute --quit, process termination, a detached shell helper, or stop-then-start commands for the native restart. Routine inspections, file edits, and tool errors do not require closing BLACKICE.';
  }
  async readBody(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fail('Send application/json.', 415);
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 512 * 1024) throw fail('The connector request exceeds 512 KiB.', 413); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('Invalid JSON.', 400, 'CHATGPT_JSON_INVALID'); }
  }
  async handle(req, res) {
    const url = new URL(req.url, this.origin);
    if (url.pathname !== CHATGPT_MCP_PATH) {
      const pending = Promise.resolve().then(() => this.oauth.handle(req, res, { enabled: !this.closed && this.enabled && this.healthy && !this.isClosing() }));
      this.inflight.add(pending);
      try { return await pending; } finally { this.inflight.delete(pending); }
    }
    if (this.closed || !this.enabled || !this.healthy || this.isClosing()) return json(res, 503, { error: this.error || 'The ChatGPT connector is disabled or BLACKICE is closing.', code: 'CHATGPT_CONNECTOR_DISABLED' });
    if (req.headers.origin && req.headers.origin !== this.origin) return json(res, 403, { error: 'Unrecognized connector origin.' });
    // OAuth setup may probe the resource before it knows its discovery URL.
    if (req.method === 'GET' && !url.search && !await this.oauth.authenticateRequest(req)) {
      if (req.headers.authorization !== undefined) return this.invalidBearer(req, res, ['read']);
      this.recordAuthChallenge('linkingChallenges', { method: req.method, statusCode: 401 });
      res.setHeader('WWW-Authenticate', this.oauth.challenge(['read']));
      return json(res, 401, { error: 'Connect BLACKICE to access this protected MCP endpoint.', code: 'CHATGPT_AUTH_REQUIRED' });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, { error: 'Use MCP Streamable HTTP POST. Read long-running actions through their durable job IDs.' }); }
    let request, modern = false;
    const rpcError = (status, code, message, data) => json(res, status, { jsonrpc: '2.0', id: typeof request?.id === 'string' || Number.isSafeInteger(request?.id) ? request.id : null, error: { code, message, ...(data ? { data } : {}) } });
    try {
      if (url.search) throw fail('The MCP endpoint does not accept query fields.');
      if (!String(req.headers.accept || '').includes('application/json') || !String(req.headers.accept || '').includes('text/event-stream')) throw fail('Accept application/json and text/event-stream.', 406);
      request = await this.readBody(req);
      if (!object(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || request.method.length > 128 || Object.keys(request).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key)) || request.params !== undefined && !object(request.params) || Object.hasOwn(request, 'id') && typeof request.id !== 'string' && !Number.isSafeInteger(request.id)) return rpcError(400, -32600, 'Send one JSON-RPC request or notification.');
      const params = request.params || {}, meta = params._meta, protocolHeader = req.headers['mcp-protocol-version'];
      modern = object(meta) && Object.hasOwn(meta, `${META}protocolVersion`) || protocolHeader === CHATGPT_PROTOCOLS[0];
      if (modern) {
        const version = meta?.[`${META}protocolVersion`];
        if (version !== CHATGPT_PROTOCOLS[0] || protocolHeader !== version || !object(meta?.[`${META}clientCapabilities`])) return rpcError(400, -32022, 'Use matching supported per-request protocol metadata and headers.', { supported: CHATGPT_PROTOCOLS });
        const headerName = req.headers['mcp-name'];
        let decodedName = headerName;
        if (typeof headerName === 'string' && headerName.startsWith('=?base64?') && headerName.endsWith('?=')) {
          const value = headerName.slice(9, -2);
          decodedName = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) ? Buffer.from(value, 'base64').toString('utf8') : undefined;
        }
        if (req.headers['mcp-method'] !== request.method || request.method === 'tools/call' && decodedName !== params.name) return rpcError(400, -32020, 'MCP routing headers must match the request.');
      } else if (request.method !== 'initialize' && protocolHeader && !CHATGPT_PROTOCOLS.slice(1).includes(protocolHeader)) return rpcError(400, -32022, 'Unsupported MCP protocol version.', { supported: CHATGPT_PROTOCOLS });
      if (!Object.hasOwn(request, 'id')) {
        if (!modern && ['notifications/initialized', 'notifications/cancelled'].includes(request.method)) { res.writeHead(202, { 'Cache-Control': 'no-store' }); return res.end(); }
        return rpcError(400, -32600, 'This method requires a request ID.');
      }
      const serverInfo = { name: 'BLACKICE direct execution', version: this.version }, capabilities = { tools: { listChanged: false } };
      const reply = result => json(res, 200, { jsonrpc: '2.0', id: request.id, result: modern ? { ...result, resultType: 'complete', _meta: { ...result._meta, [`${META}serverInfo`]: serverInfo } } : result });
      if (!modern && request.method === 'initialize') {
        if (typeof params.protocolVersion !== 'string' || !object(params.capabilities) || !object(params.clientInfo)) return rpcError(400, -32602, 'Initialize requires protocolVersion, capabilities and clientInfo.');
        return reply({ protocolVersion: CHATGPT_PROTOCOLS.slice(1).includes(params.protocolVersion) ? params.protocolVersion : CHATGPT_PROTOCOLS[1], capabilities, serverInfo, instructions: this.instructions() });
      }
      if (modern && request.method === 'server/discover') return reply({ supportedVersions: CHATGPT_PROTOCOLS, capabilities, instructions: this.instructions() });
      if (request.method === 'ping') return reply({});
      if (request.method === 'tools/list') {
        if (params.cursor !== undefined) return rpcError(400, -32602, 'The catalog fits in one page; omit cursor.');
        return reply({ tools: this.tools() });
      }
      if (request.method !== 'tools/call') return rpcError(modern ? 404 : 200, -32601, 'Method not found.');
      if (params.arguments !== undefined && !object(params.arguments)) return rpcError(400, -32602, 'Tool arguments must be a JSON object.');
      const definition = this.tools().find(tool => tool.name === params.name);
      if (!definition) return rpcError(400, -32602, 'Unknown BLACKICE direct tool.');
      const requiredScopes = definition.securitySchemes[0].scopes;
      const client = await this.oauth.authenticateRequest(req);
      if (!client || requiredScopes.some(scope => !client.scopes.includes(scope))) {
        if (!client && req.headers.authorization !== undefined) return this.invalidBearer(req, res, requiredScopes, { tool: params.name });
        this.recordAuthChallenge(client ? 'scopeChallenges' : 'linkingChallenges', { method: req.method, statusCode: 200, tool: params.name });
        const challenge = this.oauth.challenge(requiredScopes, client ? 'insufficient_scope' : 'invalid_token');
        return reply({ content: [{ type: 'text', text: client ? 'Grant the required BLACKICE permissions to use this tool.' : 'Connect your BLACKICE account to use this tool.' }], _meta: { 'mcp/www_authenticate': [challenge] }, isError: true });
      }
      try {
        const handler = this.execution.tools().some(tool => tool.name === params.name) ? this.execution : this.planning;
        const pending = Promise.resolve().then(async () => {
          if (this.closed || !this.enabled || !this.healthy || this.isClosing()) throw fail('BLACKICE is closing or this connection was disabled. No action was admitted.', 503, 'CHATGPT_CONNECTOR_DISABLED');
          const current = this.oauth.getClient ? await this.oauth.getClient(client.id) : await this.oauth.authenticateRequest(req);
          if (!current || requiredScopes.some(scope => !current.scopes.includes(scope))) throw fail('This connection no longer has the required permissions.', 401, 'CHATGPT_ACCESS_REVOKED');
          return handler.call(params.name, params.arguments || {}, current);
        });
        this.inflight.add(pending);
        let result;
        try { result = await pending; } finally { this.inflight.delete(pending); }
        this.lastCall = { tool: params.name, clientId: client.id, at: new Date().toISOString(), ...(params.name === 'blackice_direct_status' && typeof params.arguments?.nonce === 'string' ? { nonce: params.arguments.nonce } : {}) };
        // Capture optional onboarding evidence before another successful tool can
        // replace lastCall. Guide storage failures never change an action result.
        try { await this.onAuthenticatedToolCall?.({ ...this.lastCall }); } catch {}
        this.onChange();
        return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
      } catch (error) {
        const result = errorValue(error);
        if (error.status === 401 || error.status === 403) {
          const requested = [...new Set([...requiredScopes, ...(Array.isArray(error.requiredScopes) ? error.requiredScopes : []), ...(error.scope ? [error.scope] : [])])].filter(scope => CHATGPT_SCOPES.includes(scope));
          if (error.status === 401 && req.headers.authorization !== undefined) return this.invalidBearer(req, res, requested, { tool: params.name, result, authorizationLost: true });
          this.recordAuthChallenge(error.status === 401 ? 'authorizationLostChallenges' : 'scopeChallenges', { method: req.method, statusCode: 200, tool: params.name });
          return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, _meta: { 'mcp/www_authenticate': [this.oauth.challenge(requested, error.status === 401 ? 'invalid_token' : 'insufficient_scope')] }, isError: true });
        }
        return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: true });
      }
    } catch (error) { return rpcError(error.status || 400, error.code === 'CHATGPT_JSON_INVALID' ? -32700 : -32600, error.message); }
  }
  async close() { this.closed = true; this.enabled = false; await this.tail.catch(() => {}); await Promise.allSettled([...this.inflight]); await this.execution.close(); await this.oauth.close?.(); }
}
