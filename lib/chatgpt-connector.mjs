import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeRemoteJson } from './remote-access-auth.mjs';
import { createChatGPTToolCatalog } from './chatgpt-tool-catalog.mjs';
import { ChatGPTGrantAdmission, ChatGPTGrantChallenge } from './chatgpt-grant-admission.mjs';
import {
  CHATGPT_MCP_PATH, CHATGPT_PROTOCOLS, CHATGPT_SCOPES,
  connectorError, decodeMCPRequest, invalidParams, isObject, methodNotFound,
  readMCPBody, sendJSON, sendRPCError, sendRPCResult, toolErrorValue, toolResult,
} from './chatgpt-mcp-protocol.mjs';

export { CHATGPT_MCP_PATH, CHATGPT_PROTOCOLS, CHATGPT_SCOPES } from './chatgpt-mcp-protocol.mjs';

const RESTART_CONTROLS = new Set([
  'blackice_direct_status', 'blackice_get_job', 'blackice_list_jobs', 'blackice_cancel_job',
]);
const newAuthDiagnostics = () => ({
  invalidBearerChallenges: 0, linkingChallenges: 0,
  scopeChallenges: 0, authorizationLostChallenges: 0, lastChallenge: null,
});

/**
 * One stateless MCP boundary over the existing grant and durable execution services.
 * Client initialization never creates, replaces, or resets authorization.
 */
export class ChatGPTConnector {
  constructor({
    dataDir, execution, planning, oauth, version,
    isClosing = () => false, isRestartPending = () => false, onChange = () => {},
  }) {
    Object.assign(this, { execution, planning, oauth, version, isClosing, isRestartPending, onChange });
    this.file = path.join(dataDir, 'chatgpt-connector.json');
    this.enabled = false;
    this.closed = false;
    this.origin = null;
    this.healthy = true;
    this.error = null;
    this.tail = Promise.resolve();
    this.lastCall = null;
    this.inflight = new Set();
    this.authDiagnostics = newAuthDiagnostics();
    this.admission = new ChatGPTGrantAdmission(oauth);
  }

  async init() {
    try {
      const stat = await fs.stat(this.file);
      if (!stat.isFile() || stat.size > 4096) throw Error('Invalid connector settings.');
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!isObject(value) || value.version !== 1 || typeof value.enabled !== 'boolean'
        || Object.keys(value).some(key => !['version', 'enabled'].includes(key))) {
        throw Error('Invalid connector settings.');
      }
      this.enabled = value.enabled;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.healthy = false;
        this.error = 'ChatGPT connector settings could not be read. Existing settings were preserved.';
      }
    }
    return this;
  }

  setOrigin(origin) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) {
      throw Error('The connector requires its exact owned HTTPS origin.');
    }
    this.oauth.setOrigin(origin);
    this.origin = origin;
  }

  matches(pathname) { return pathname === CHATGPT_MCP_PATH || this.oauth.matches(pathname); }

  catalog() {
    return createChatGPTToolCatalog({ providers: [this.execution, this.planning], version: this.version });
  }

  tools() { return this.catalog().tools(); }
  catalogStatus() { return this.catalog().status(); }
  authStatus() { return structuredClone(this.authDiagnostics); }

  integrationStatus() {
    return {
      implementation: 'direct-connector-v2',
      sessionMode: 'stateless',
      authorization: 'persistent-oauth-grant',
      localMutationApproval: false,
    };
  }

  async status() {
    const [oauth, actions] = await Promise.all([this.oauth.status(), this.execution.status()]);
    return {
      available: !this.closed && this.healthy && oauth.healthy !== false && actions.available !== false,
      enabled: !this.closed && this.enabled && this.healthy,
      error: this.error || oauth.error || actions.storageError?.message,
      endpoint: this.origin ? this.origin + CHATGPT_MCP_PATH : null,
      authentication: 'OAuth 2.1 with PKCE',
      execution: 'direct',
      modelCalls: false,
      requiresWorkComputerTools: false,
      scopes: [...CHATGPT_SCOPES],
      oauth, actions,
      lastAuthenticatedToolCall: this.lastCall ? { ...this.lastCall } : null,
      toolCatalog: this.catalogStatus(),
      authDiagnostics: this.authStatus(),
      integration: this.integrationStatus(),
      chatSurfaceVerification: 'not-recorded',
      compatibility: {
        transport: 'streamable-http',
        protocolVersions: [...CHATGPT_PROTOCOLS],
        automaticChatWakeup: false,
        backgroundResults: 'Poll the durable action ID in the same conversation.',
      },
    };
  }

  notifyChanged() {
    // Observability is optional. A failed observer cannot turn an admitted action
    // into a failed tool response, cause a retry, or request authorization again.
    try { Promise.resolve(this.onChange()).catch(() => {}); } catch {}
  }

  recordAuthChallenge(kind, { method, statusCode, tool = null } = {}) {
    this.authDiagnostics[kind]++;
    this.authDiagnostics.lastChallenge = { kind, at: new Date().toISOString(), method, statusCode, tool };
    this.notifyChanged();
  }

  invalidBearer(req, res, requiredScopes, { tool = null, result = null, authorizationLost = false } = {}) {
    return this.sendGrantChallenge(req, res, new ChatGPTGrantChallenge('Invalid or expired access credential.', {
      code: 'CHATGPT_AUTH_REQUIRED',
      kind: authorizationLost ? 'authorizationLostChallenges' : 'invalidBearerChallenges',
      scopes: requiredScopes, bearerError: 'invalid_token', status: 401, result,
    }), tool);
  }

  sendGrantChallenge(req, res, challenge, tool, reply) {
    const authenticate = this.oauth.challenge(challenge.scopes, challenge.bearerError);
    this.recordAuthChallenge(challenge.kind, { method: req.method, statusCode: challenge.status, tool });
    if (challenge.status === 401) {
      res.setHeader('WWW-Authenticate', authenticate);
      return sendJSON(res, 401, challenge.result || {
        error: 'The BLACKICE access token is invalid or expired. Refresh the connection credentials and retry the same request.',
        code: 'CHATGPT_AUTH_REQUIRED',
      });
    }
    const meta = { 'mcp/www_authenticate': [authenticate] };
    return reply(challenge.result ? toolResult(challenge.result, true, meta) : {
      content: [{ type: 'text', text: challenge.message }], _meta: meta, isError: true,
    });
  }

  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') {
      return Promise.reject(connectorError('Choose whether the ChatGPT connector is enabled.'));
    }
    const next = this.tail.catch(() => {}).then(async () => {
      if (!this.healthy) throw connectorError(this.error, 503, 'CHATGPT_SETTINGS_UNAVAILABLE');
      if (enabled && (this.closed || this.isClosing())) {
        throw connectorError('BLACKICE is closing or preparing maintenance.', 503, 'CHATGPT_CONNECTOR_DISABLED');
      }
      if (enabled && (await this.oauth.status()).healthy === false) {
        throw connectorError('ChatGPT authorization storage needs local recovery before enabling access.', 503, 'CHATGPT_AUTH_UNAVAILABLE');
      }
      if (enabled && (await this.execution.status()).available === false) {
        throw connectorError('Direct execution storage or runtime needs local recovery before enabling access.', 503, 'CHATGPT_EXECUTION_UNAVAILABLE');
      }
      if (!enabled) this.enabled = false;
      await writeRemoteJson(this.file, { version: 1, enabled });
      this.enabled = enabled && !this.closed;
      if (!enabled) await this.oauth.revokeAll();
      this.notifyChanged();
      return this.status();
    });
    this.tail = next;
    return next;
  }

  instructions(catalog = this.catalog()) {
    const restart = catalog.get('blackice_restart')
      ? ' For a requested restart or a restart needed to activate a completed update, use blackice_restart with one stable requestId. Its successful job confirms scheduling only. After reconnecting on the same grant, read blackice_direct_status and require restart.receipt.status completed for that request before claiming completion. A failed, cancelled, interrupted, or busy restart is not permission to close the app.'
      : ' This runtime has no native desktop restart tool. Leave BLACKICE running if an update needs a newer process; do not improvise a restart.';
    return 'Use BLACKICE as a direct execution backend while you reason in this ChatGPT conversation. This connector never starts another model-backed worker. Read saved plans and exact revisions before editing. Active plans are the default; groups and plan names have a separate organization revision. Every execution action has a caller-supplied requestId and durable jobId. Reuse the same requestId and identical arguments after a transport failure, then read the returned jobId; never invent a new requestId just to retry an uncertain mutation. Pending, awaiting_input, running, cancelling and interrupted are not success. Poll blackice_get_job until settled; return the actual result in this conversation. A lost HTTP connection does not cancel the action. Use blackice_cancel_job explicitly and read the resulting state. Actions execute directly within the existing OAuth scopes without a separate BLACKICE action approval. Sign-ins and website dialogs may still require local interaction. Legacy pending approvals are never replayed; cancel them and inspect effects before requesting new work. Never claim that an awaiting_input or interrupted action completed. Uploaded files are imported only; a website upload is a separate authorized browser action. No automatic notification back into an idle ChatGPT conversation is assumed.'
      + restart
      + ' Never substitute --quit, process termination, a detached shell helper, or stop-then-start commands for the native restart. Routine inspections, file edits, and tool errors do not require closing BLACKICE.';
  }

  async track(operation) {
    const pending = Promise.resolve().then(operation);
    this.inflight.add(pending);
    try { return await pending; }
    finally { this.inflight.delete(pending); }
  }

  availableForMCP() {
    return !this.closed && this.enabled && this.healthy && (!this.isClosing() || this.isRestartPending());
  }

  assertAdmissionAllowed(restartControl) {
    if (this.closed || !this.enabled || !this.healthy
      || this.isClosing() && !(this.isRestartPending() && restartControl)) {
      throw connectorError('BLACKICE is closing or this connection was disabled. No action was admitted.', 503, 'CHATGPT_CONNECTOR_DISABLED');
    }
  }

  readBody(req) { return readMCPBody(req); }

  async handle(req, res) {
    const url = new URL(req.url, this.origin);
    if (url.pathname !== CHATGPT_MCP_PATH) {
      return this.track(() => this.oauth.handle(req, res, {
        enabled: !this.closed && this.enabled && this.healthy && !this.isClosing(),
      }));
    }
    if (!this.availableForMCP()) {
      return sendJSON(res, 503, {
        error: this.error || 'The ChatGPT connector is disabled or BLACKICE is closing.',
        code: 'CHATGPT_CONNECTOR_DISABLED',
      });
    }
    if (req.headers.origin && req.headers.origin !== this.origin) {
      return sendJSON(res, 403, { error: 'Unrecognized connector origin.' });
    }
    if (req.method === 'GET' && !url.search && !await this.oauth.authenticateRequest(req)) {
      if (req.headers.authorization !== undefined) return this.invalidBearer(req, res, ['read']);
      this.recordAuthChallenge('linkingChallenges', { method: req.method, statusCode: 401 });
      res.setHeader('WWW-Authenticate', this.oauth.challenge(['read']));
      return sendJSON(res, 401, {
        error: 'Connect BLACKICE to access this protected MCP endpoint.', code: 'CHATGPT_AUTH_REQUIRED',
      });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendJSON(res, 405, {
        error: 'Use MCP Streamable HTTP POST. Read long-running actions through their durable job IDs.',
      });
    }

    let request;
    try {
      if (url.search) throw connectorError('The MCP endpoint does not accept query fields.');
      if (!String(req.headers.accept || '').includes('application/json')
        || !String(req.headers.accept || '').includes('text/event-stream')) {
        throw connectorError('Accept application/json and text/event-stream.', 406);
      }
      request = await this.readBody(req);
      const { params, modern, notification } = decodeMCPRequest(request, req.headers);
      const restartControl = RESTART_CONTROLS.has(params.name);
      if (this.isClosing() && (!this.isRestartPending() || request.method === 'tools/call' && !restartControl)) {
        throw connectorError('BLACKICE is preparing a restart. Only receipt reads and cancellation remain available.', 503, 'CHATGPT_CONNECTOR_DISABLED');
      }
      if (notification) {
        if (!modern && ['notifications/initialized', 'notifications/cancelled'].includes(request.method)) {
          res.writeHead(202, { 'Cache-Control': 'no-store' });
          return res.end();
        }
        throw connectorError('This method requires a request ID.');
      }

      const serverInfo = { name: 'BLACKICE direct execution', version: this.version };
      const capabilities = { tools: { listChanged: false } };
      const reply = result => sendRPCResult(res, request, modern, serverInfo, result);
      if (!modern && request.method === 'initialize') {
        if (typeof params.protocolVersion !== 'string' || !isObject(params.capabilities) || !isObject(params.clientInfo)) {
          throw invalidParams('Initialize requires protocolVersion, capabilities and clientInfo.');
        }
        return reply({
          protocolVersion: CHATGPT_PROTOCOLS.slice(1).includes(params.protocolVersion)
            ? params.protocolVersion : CHATGPT_PROTOCOLS[1],
          capabilities, serverInfo, instructions: this.instructions(),
        });
      }
      if (modern && request.method === 'server/discover') {
        return reply({ supportedVersions: CHATGPT_PROTOCOLS, capabilities, instructions: this.instructions() });
      }
      if (request.method === 'ping') return reply({});
      if (request.method === 'tools/list') {
        if (params.cursor !== undefined) throw invalidParams('The catalog fits in one page; omit cursor.');
        return reply({ tools: this.tools() });
      }
      if (request.method !== 'tools/call') throw methodNotFound(modern);
      if (params.arguments !== undefined && !isObject(params.arguments)) {
        throw invalidParams('Tool arguments must be a JSON object.');
      }
      const catalog = this.catalog();
      const entry = catalog.get(params.name);
      if (!entry) throw invalidParams('Unknown BLACKICE direct tool.');
      return await this.callTool({ req, res, params, entry, catalog, restartControl, reply });
    } catch (error) {
      return sendRPCError(res, request, error);
    }
  }

  async callTool({ req, res, params, entry, catalog, restartControl, reply }) {
    const args = params.arguments || {};
    try {
      const client = await this.admission.authenticate(req, entry.requiredScopes);
      let result = await this.track(async () => {
        this.assertAdmissionAllowed(restartControl);
        const current = await this.admission.revalidate(req, client, entry.requiredScopes);
        return entry.call(args, current);
      });
      if (params.name === 'blackice_direct_status' && isObject(result)) {
        result = {
          ...result,
          toolCatalog: catalog.status(),
          authDiagnostics: this.authStatus(),
          integration: this.integrationStatus(),
        };
      }
      const receipt = {
        tool: params.name, clientId: client.id, at: new Date().toISOString(),
        ...(params.name === 'blackice_direct_status' && typeof args.nonce === 'string' ? { nonce: args.nonce } : {}),
      };
      this.lastCall = receipt;
      // Setup evidence observes the captured receipt without delaying its delivery.
      try { Promise.resolve(this.onAuthenticatedToolCall?.({ ...receipt })).catch(() => {}); } catch {}
      this.notifyChanged();
      return reply(toolResult(result));
    } catch (error) {
      const result = toolErrorValue(error);
      const challenge = error instanceof ChatGPTGrantChallenge ? error
        : this.admission.fromToolError(error, req, entry.requiredScopes, result);
      if (challenge) return this.sendGrantChallenge(req, res, challenge, params.name, reply);
      return reply(toolResult(result, true));
    }
  }

  async close() {
    this.closed = true;
    this.enabled = false;
    await this.tail.catch(() => {});
    await Promise.allSettled([...this.inflight]);
    await this.execution.close();
    await this.oauth.close?.();
  }
}
