import { BROWSER_CLEANUP_PROTOCOL } from './browser-cleanup-policy.mjs';
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

function sendMCPStatus(req, res, status, value) {
  if (req.method !== 'HEAD') return sendJSON(res, status, value);
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  return res.end();
}

/**
 * One stateless MCP boundary over the existing grant and durable execution services.
 * Client initialization never creates, replaces, or resets authorization.
 */
export class ChatGPTConnector {
  constructor({
    dataDir, execution, planning, schedules, oauth, version,
    isClosing = () => false, isRestartPending = () => false, onChange = () => {}, restartConnectionGuidance = null,
  }) {
    if (restartConnectionGuidance !== null && (typeof restartConnectionGuidance !== 'string' || !restartConnectionGuidance.trim() || restartConnectionGuidance.length > 1500)) throw Error('Use trusted connection restart guidance.');
    Object.assign(this, { execution, planning, oauth, version, isClosing, isRestartPending, onChange, restartConnectionGuidance });
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
    return createChatGPTToolCatalog({ providers: [this.execution, this.planning, ...(this.schedules ? [this.schedules] : [])], version: this.version });
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
    if (challenge.status === 401 || challenge.status === 403) {
      res.setHeader('WWW-Authenticate', authenticate);
      return sendMCPStatus(req, res, challenge.status, challenge.result || {
        error: challenge.status === 403 ? challenge.message : 'The BLACKICE access token is invalid or expired. Refresh the connection credentials and retry the same request.',
        code: challenge.code,
        ...(challenge.status === 403 ? { requiredScopes: [...challenge.scopes] } : {}),
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
    const planningSchema = catalog.get('blackice_planning_graph_read')
      ? " For Planning graph writes, blackice_planning_graph_read action:schema returns the current schema for writeAction; optional field selects one nested field. Build calls from that result, not older examples." : '';
    const restartEntry = catalog.get('blackice_restart');
    const supportsForce = restartEntry?.definition?.inputSchema?.properties?.force?.type === 'boolean';
    const restart = restartEntry
      ? " For restart, use blackice_restart with a stable requestId."
        + (supportsForce ? " force:true pauses automatic queues and stops cancellable work; the receipt identifies any remaining blocker." : '')
        + " Its successful job confirms scheduling."
        + (this.restartConnectionGuidance || " After reconnecting, read blackice_direct_status.restart.receipt. status:completed for that request confirms the replacement process started.")
        + " If scheduling fails or reports busy, inspect its receipt for the reason."
      : " This runtime has no native restart tool; report that limit if activation requires restart.";
    return "Use BLACKICE tools from this conversation. File, command and browser tools execute directly. Local paths belong to the BLACKICE computer. Use a supplied absolute path as given; the configured working directory only resolves relative paths. If location is unknown, blackice_workspace_read action:find can search computer-wide when path/roots are omitted, or search explicit roots. Describe file misses using the returned scope and coverage. Tools that describe starting a model launch the configured provider and return a run or attempt ID to inspect.\nUse each attached tool's action and field schema." + planningSchema + " Read the current saved revision before changing a plan.\nExecution calls return jobId. Read blackice_get_job until settled, then inspect status, effects and result. awaiting_input names the interaction to resolve. A lost connection does not cancel work: recover the saved job, or retry the same requestId and identical arguments on the same connection. Use a new requestId for a different action or fresh read. Cancellation uses blackice_cancel_job and leaves completed effects intact. Report the observed result in this conversation. Importing a file saves it locally; browser upload is a separate action."
      + BROWSER_CLEANUP_PROTOCOL
      + restart
      + " Native restart retains the current profile and mode. Routine reads and edits can run while BLACKICE stays open.";
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
      return sendMCPStatus(req, res, 503, {
        error: this.error || 'The ChatGPT connector is disabled or BLACKICE is closing.',
        code: 'CHATGPT_CONNECTOR_DISABLED',
      });
    }
    if (req.headers.origin && req.headers.origin !== this.origin) {
      return sendMCPStatus(req, res, 403, { error: 'Unrecognized connector origin.' });
    }
    // Challenge before parsing an anonymous MCP request so clients can discover
    // OAuth even when their first probe omits transport headers or a body.
    if ((req.method === 'POST' || (req.method === 'GET' || req.method === 'HEAD') && !url.search)
      && !await this.oauth.authenticateRequest(req)) {
      if (req.headers.authorization !== undefined) return this.invalidBearer(req, res, ['read']);
      this.recordAuthChallenge('linkingChallenges', { method: req.method, statusCode: 401 });
      res.setHeader('WWW-Authenticate', this.oauth.challenge(['read']));
      return sendMCPStatus(req, res, 401, {
        error: 'Connect BLACKICE to access this protected MCP endpoint.', code: 'CHATGPT_AUTH_REQUIRED',
      });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendMCPStatus(req, res, 405, {
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
    let admittedClient = null;
    try {
      const client = await this.admission.authenticate(req, entry.requiredScopes);
      admittedClient = client;
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
        : this.admission.fromToolError(error, req, entry.requiredScopes, result, admittedClient);
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
