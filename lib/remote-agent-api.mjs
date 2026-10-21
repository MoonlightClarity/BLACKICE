import { createHash } from 'node:crypto';
import { createMissionWorkflow } from '../public/mission-model.mjs';
import { planningQuery, planningConversations, listPlanningWorkspace, editPlanningWorkspace } from './planning-workspace.mjs';
import { writeEventStream } from './event-stream.mjs';

// Credentials are authenticated by the remote gateway. This module never accepts
// an identity, token or permission supplied in request JSON or ordinary headers.
export const MCP_VERSIONS = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18']);
const META = 'io.modelcontextprotocol/';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 400, code = 'REMOTE_REQUEST_INVALID') => Object.assign(new Error(message), { status, code });
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const idSchema = { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$', minLength: 1, maxLength: 120 };
const nullableId = { anyOf: [idSchema, { type: 'null' }] };
const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
const textOrNull = { anyOf: [{ type: 'string', maxLength: 10000 }, { type: 'null' }] };
const stepFields = {
  title: string(500), kind: { enum: ['action', 'sequence', 'parallel', 'choice'] },
  status: { enum: ['pending', 'active', 'blocked', 'done', 'skipped'] },
  note: textOrNull, doneWhen: textOrNull, result: textOrNull, evidence: textOrNull,
  blockedReason: textOrNull, skipReason: textOrNull, condition: textOrNull,
  artifactIds: { anyOf: [{ type: 'array', items: { type: 'string' }, maxItems: 40 }, { type: 'null' }] },
  stepType: textOrNull,
};
const dependencies = { type: 'array', items: idSchema, uniqueItems: true, maxItems: 199 };
export const PLAN_EDIT_SCHEMA = { type: 'array', minItems: 1, maxItems: 100, items: { oneOf: [
  schema({ type: { const: 'add' }, step: schema({ id: idSchema, ...stepFields, parentId: nullableId, dependsOn: dependencies, selectedChildId: nullableId }, ['id', 'title']), beforeId: nullableId }, ['type', 'step']),
  schema({ type: { const: 'update' }, stepId: idSchema, patch: { ...schema(stepFields), minProperties: 1 } }, ['type', 'stepId', 'patch']),
  schema({ type: { const: 'remove' }, stepId: idSchema }, ['type', 'stepId']),
  schema({ type: { const: 'move' }, stepId: idSchema, parentId: nullableId, beforeId: nullableId }, ['type', 'stepId', 'parentId']),
  schema({ type: { const: 'dependencies' }, stepId: idSchema, dependsOn: dependencies }, ['type', 'stepId', 'dependsOn']),
  schema({ type: { const: 'choose' }, stepId: nullableId, selectedChildId: nullableId }, ['type', 'stepId', 'selectedChildId']),
  schema({ type: { const: 'metadata' }, patch: { ...schema({ goal: string(2000), layout: { enum: ['sequence', 'parallel', 'choice'] }, detail: { enum: ['compact', 'balanced', 'detailed'] }, focusStepId: nullableId }), minProperties: 1 } }, ['type', 'patch']),
] } };
const paging = { offset: { type: 'integer', minimum: 0, maximum: 1000000 }, limit: { type: 'integer', minimum: 1, maximum: 100 } };
const outputPaging = { offset: { type: 'integer', minimum: 0, maximum: 100000000 }, limit: { type: 'integer', minimum: 1, maximum: 50000 } };
const turnFields = { model: string(400), effort: { enum: ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }, planningMode: { enum: ['maximal', 'on', 'auto', 'off'] } };
const requestIdSchema = { ...idSchema, description: 'A unique ID for this intended task or reply. Reuse the same ID and exact arguments after a connection failure; BLACKICE returns the admitted run. A different task needs a new ID.' };
const definitions = [
  ['blackice_status', 'Read BLACKICE availability, active runs and the authenticated client permissions. No task is started.', 'read', schema()],
  ['blackice_models', 'Search a compact paginated list of connected model choices. Omit model when starting a task to use the saved default.', 'read', schema({ query: { type: 'string', maxLength: 500 }, ...paging })],
  ['blackice_list_tasks', 'Search saved tasks and their shared visual plans. Active plans are the default. All includes active and archived chats; Trash must be requested explicitly. Filter by groupId or exact taskId. Each plan supplies its name, group, current revision and ready work.', 'read', schema({ query: { type: 'string', maxLength: 500 }, state: { enum: ['all', 'active', 'archived', 'deleted'] }, groupId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,120}$', minLength: 1, maxLength: 120 }, taskId: idSchema, ...paging })],
  ['blackice_get_task', 'Read the exact shared plan, revision, artifacts and ready or blocked work for a saved task. Includes live human editing presence and BLACKICE worker read receipts in planningAwareness. Your client must incorporate saved changes; this read does not acknowledge them on behalf of another worker.', 'read', schema({ taskId: idSchema }, ['taskId'])],
  ['blackice_get_run', 'Read execution status, node states and a bounded window of the final output. Poll this after submitting work; nextOffset reads the remaining output.', 'read', schema({ runId: idSchema, ...outputPaging }, ['runId'])],
  ['blackice_read_output', 'Read a bounded text window of a run result or one worker output, using the returned nextOffset for longer results.', 'read', schema({ runId: idSchema, nodeId: idSchema, ...outputPaging }, ['runId'])],
  ['blackice_read_artifact', 'Read a registered task artifact up to 1 MiB. Returns base64 bytes and the stored filename/content type; larger files are available through the authenticated download endpoint.', 'read', schema({ taskId: idSchema, artifactId: { type: 'string', pattern: '^artifact_[a-f0-9-]{36}$' } }, ['taskId', 'artifactId'])],
  ['blackice_edit_plan', 'Apply one atomic edit batch to the shared plan at expectedRevision. A conflict returns currentRevision; reread and reconcile. Plan edits change the work document and never start, finish or cancel an execution.', 'planning:write', schema({ taskId: idSchema, expectedRevision: { type: 'integer', minimum: 1 }, operations: PLAN_EDIT_SCHEMA }, ['taskId', 'expectedRevision', 'operations'])],
  ['blackice_start_task', 'Start an authorized task in BLACKICE’s configured workspace, with the usual model/tool permissions and visible chat. Returns promptly with runId/taskId; poll blackice_get_run for results. Reuse requestId after a network failure.', 'tasks:write', schema({ task: string(50000), requestId: requestIdSchema, ...turnFields }, ['task', 'requestId'])],
  ['blackice_continue_task', 'Send a follow-up to a stopped, settled run in an active chat. Omit nodeId to continue the last agent. Uses the existing context and plan; reuse requestId after a network failure.', 'tasks:write', schema({ runId: idSchema, nodeId: idSchema, message: string(50000), requestId: requestIdSchema, ...turnFields }, ['runId', 'message', 'requestId'])],
  ['blackice_cancel_task', 'Request cancellation of one run. Stopping may take time; poll until settled is true. Saved results and plans are retained.', 'tasks:write', schema({ runId: idSchema }, ['runId'])],
].map(([name, description, scope, inputSchema]) => ({ name, description, scope, inputSchema, annotations: { readOnlyHint: scope === 'read', destructiveHint: scope === 'tasks:write', idempotentHint: true, openWorldHint: scope === 'tasks:write' } }));

// Validate the bounded schema subset used above; no remote schema evaluation.
function valid(value, spec) {
  if (spec.anyOf) return spec.anyOf.some(item => valid(value, item));
  if (spec.oneOf) return spec.oneOf.filter(item => valid(value, item)).length === 1;
  if (Object.hasOwn(spec, 'const') && value !== spec.const || spec.enum && !spec.enum.includes(value)) return false;
  if (spec.type === 'null') return value === null;
  if (spec.type === 'object') return object(value) && Object.keys(value).length >= (spec.minProperties || 0) && (spec.required || []).every(key => Object.hasOwn(value, key)) && Object.entries(value).every(([key, item]) => spec.properties?.[key] ? valid(item, spec.properties[key]) : spec.additionalProperties !== false);
  if (spec.type === 'array') return Array.isArray(value) && value.length >= (spec.minItems || 0) && value.length <= (spec.maxItems ?? Infinity) && (!spec.uniqueItems || new Set(value.map(item => JSON.stringify(item))).size === value.length) && value.every(item => valid(item, spec.items));
  if (spec.type === 'integer') return Number.isSafeInteger(value) && value >= (spec.minimum ?? -Infinity) && value <= (spec.maximum ?? Infinity);
  if (spec.type === 'string') return typeof value === 'string' && !value.includes('\0') && value.length >= (spec.minLength || 0) && value.length <= (spec.maxLength ?? Infinity) && (!spec.pattern || new RegExp(spec.pattern).test(value));
  return true;
}

export const isRemoteAgentPath = pathname => pathname === '/mcp' || pathname === '/api/agent' || pathname.startsWith('/api/agent/');
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const errorValue = error => ({ error: error.message, code: error.code || 'REMOTE_REQUEST_FAILED', ...(Number.isSafeInteger(error.currentRevision) ? { currentRevision: error.currentRevision } : {}), ...(error.scope ? { requiredScope: error.scope } : {}) });
const windowOf = (text = '', { offset = 0, limit = 12000 } = {}) => ({ text: text.slice(offset, offset + limit), offset, limit, totalCharacters: text.length, nextOffset: offset + limit < text.length ? offset + limit : null, truncated: offset + limit < text.length });
const scopedRequestId = (client, requestId) => `remote_${createHash('sha256').update(`${client.id}\0${requestId}`).digest('hex')}`;
function summary(run) {
  return { runId: run.id, taskId: run.taskId || run.id, status: run.status, settled: run.settled === true, title: run.workflowName, createdAt: run.createdAt, updatedAt: run.updatedAt, finishedAt: run.finishedAt, error: run.error || null, remoteClient: run.metadata?.remoteClient || null, nodes: Object.entries(run.nodes || {}).map(([id, state]) => ({ id, name: run.workflow?.nodes?.find(node => node.id === id)?.name || id, status: state.status, blockedBy: state.blockedBy || [], error: state.error || null })) };
}

export class RemoteAgentAPI {
  constructor(options) { Object.assign(this, options); this.streams = new Set(); }
  tools(client) { return definitions.filter(tool => client.scopes.includes(tool.scope)).map(({ scope, ...tool }) => structuredClone(tool)); }
  require(client, scope) {
    if (!client || !['agent', 'browser'].includes(client.kind) || !Array.isArray(client.scopes)) throw fail('Connect with a valid remote client credential.', 401, 'REMOTE_AUTH_REQUIRED');
    if (!client.scopes.includes(scope)) throw Object.assign(fail(`This client needs the ${scope} permission.`, 403, 'REMOTE_SCOPE_REQUIRED'), { scope });
  }
  visibleTask(taskId) {
    const item = planningConversations(this).get(taskId);
    if (!item || !['active', 'archived'].includes(item.bucket)) throw fail('This task is not available. Restore a trashed chat from BLACKICE first.', 404, 'REMOTE_TASK_UNAVAILABLE');
    return item;
  }
  async visibleRun(runId) {
    const run = await this.conversations.get(runId); this.visibleTask(run.taskId || run.id); return run;
  }
  record(runId, client, action) {
    const run = this.engine.runs.get(runId); if (!run) return;
    const actor = { id: client.id, name: client.label, kind: client.kind };
    if (action !== 'cancel' && run.metadata?.remoteClient?.id === client.id) return;
    if (action !== 'cancel') run.metadata = { ...run.metadata, remoteClient: actor };
    this.engine.notify('agent.event', run, undefined, { type: 'remote.request', action, actor });
  }
  async call(name, args, client) {
    const tool = definitions.find(item => item.name === name);
    if (!tool) throw fail('Unknown BLACKICE tool.', 404, 'REMOTE_TOOL_UNKNOWN');
    this.require(client, tool.scope);
    if (!valid(args, tool.inputSchema)) throw fail(`Use the declared arguments for ${name}.`);
    if (tool.scope !== 'read' && this.isClosing?.()) throw fail('BLACKICE is closing for maintenance. Retry after it reopens.', 503, 'PROFILE_MAINTENANCE');
    if (name === 'blackice_status') {
      const runtime = this.runtime.status();
      return { app: 'BLACKICE', version: this.version, connected: runtime.connected === true, authenticated: runtime.authenticated === true, defaultModel: runtime.defaultModel || null, execution: this.engine.executionStatus(), client: { id: client.id, name: client.label, kind: client.kind, scopes: [...client.scopes] }, events: '/api/agent/events', eventsReplay: false };
    }
    if (name === 'blackice_models') {
      const current = this.runtime.status(), query = (args.query || '').toLowerCase();
      const models = (current.models || []).filter(model => `${model.id || model.model} ${model.displayName || ''}`.toLowerCase().includes(query));
      const offset = args.offset || 0, limit = args.limit || 40;
      return { defaultModel: current.defaultModel || null, models: models.slice(offset, offset + limit).map(model => ({ id: model.id || model.model, name: model.displayName || model.id || model.model, available: model.available !== false, provider: model.providerId || 'codex' })), total: models.length, offset, limit, nextOffset: offset + limit < models.length ? offset + limit : null };
    }
    if (name === 'blackice_list_tasks') return listPlanningWorkspace(this, { query: '', state: 'active', limit: 40, offset: 0, ...args });
    if (name === 'blackice_get_task') {
      this.visibleTask(args.taskId);
      const state = await this.tasks.get(args.taskId);
      return { ...state, ...(this.tasks.awareness ? { planningAwareness: this.tasks.awareness.snapshot(state) } : {}) };
    }
    if (name === 'blackice_get_run' || name === 'blackice_read_output') {
      const run = await this.visibleRun(args.runId);
      if (args.nodeId && !Object.hasOwn(run.nodes || {}, args.nodeId)) throw fail('The requested worker is not part of this run.', 404, 'REMOTE_NODE_UNAVAILABLE');
      const output = windowOf(args.nodeId ? run.nodes[args.nodeId].output || '' : run.output || '', args);
      return name === 'blackice_get_run' ? { ...summary(run), output } : { runId: run.id, nodeId: args.nodeId || null, status: run.status, settled: run.settled === true, ...output };
    }
    if (name === 'blackice_read_artifact') {
      this.visibleTask(args.taskId);
      const value = await this.tasks.readArtifact(args.taskId, args.artifactId, { maxBytes: 1024 * 1024 });
      return { taskId: args.taskId, artifactId: args.artifactId, fileName: value.fileName, contentType: value.contentType, encoding: 'base64', data: value.buffer.toString('base64'), bytes: value.buffer.length };
    }
    if (name === 'blackice_edit_plan') {
      const { taskId, ...edit } = args;
      return editPlanningWorkspace({ ...this, source: client.kind === 'agent' ? 'agent' : 'human', actor: { type: client.kind === 'agent' ? 'external-agent' : 'human-client', id: client.id, name: client.label }, onUpdated: this.onEvent }, taskId, edit);
    }
    if (name === 'blackice_start_task') {
      const requestId = scopedRequestId(client, args.requestId);
      const workflow = createMissionWorkflow({ id: requestId, task: args.task, cwd: this.defaultCwd, ...Object.fromEntries(Object.entries(args).filter(([key]) => Object.hasOwn(turnFields, key))) });
      const value = { requestId, workflow, input: { task: args.task, cwd: this.defaultCwd } };
      await this.recoverClientRequest(value);
      const run = this.engine.startRun(value); this.record(run.id, client, 'start');
      return { ...summary(this.engine.getRun(run.id)), requestId: args.requestId };
    }
    if (name === 'blackice_continue_task') {
      const previous = await this.visibleRun(args.runId), family = await this.conversations.family(args.runId);
      if (family.state !== 'active') throw fail('Restore this archived chat before sending a follow-up.', 409, 'REMOTE_CHAT_READ_ONLY');
      const nodeId = args.nodeId || previous.workflow?.nodes?.filter(node => node.type === 'agent').at(-1)?.id;
      if (!this.engine.runs.has(args.runId)) this.engine.restoreArchivedRun(previous);
      const { runId, ...value } = { ...args, nodeId, requestId: scopedRequestId(client, args.requestId) };
      await this.recoverClientRequest(value);
      const threadModel = await this.runtime.savedThreadModel?.(previous.nodes[nodeId]?.threadId);
      const run = this.engine.continueRun(runId, value, { historyRuns: family.runs, threadModel }); this.record(run.id, client, 'continue');
      return { ...summary(this.engine.getRun(run.id)), requestId: args.requestId };
    }
    if (name === 'blackice_cancel_task') {
      const previous = await this.visibleRun(args.runId);
      if (previous.settled === true) return summary(previous);
      const run = this.engine.cancelRun(args.runId); this.record(args.runId, client, 'cancel'); return summary(run);
    }
  }
  async readBody(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fail('Send application/json.', 415);
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) throw fail('The remote request exceeds 256 KiB.', 413); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('Invalid JSON.', 400, 'REMOTE_JSON_INVALID'); }
  }
  async handle(req, res, client) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/mcp') return this.mcp(req, res, client, url);
    try {
      if (url.pathname === '/api/agent/events' && req.method === 'GET') {
        this.require(client, 'read'); if (url.search) throw fail('The event stream takes no query fields.');
        return this.listen(res);
      }
      if (['/api/agent', '/api/agent/'].includes(url.pathname) && req.method === 'GET') {
        this.require(client, 'read'); return json(res, 200, { app: 'BLACKICE', version: this.version, mcp: '/mcp', protocolVersions: MCP_VERSIONS, auth: 'Bearer', tools: this.tools(client), events: '/api/agent/events', instructions: this.instructions() });
      }
      let name, args;
      const actionBody = async identifiers => {
        const value = await this.readBody(req);
        if (!object(value) || Object.keys(identifiers).some(key => Object.hasOwn(value, key))) throw fail('Send an action object; identify the task or run in its URL.');
        return { ...value, ...identifiers };
      };
      const params = Object.fromEntries(url.searchParams);
      if ([...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)) throw fail('Use query fields once.');
      for (const key of ['offset', 'limit']) if (Object.hasOwn(params, key)) { if (!/^\d+$/.test(params[key])) throw fail('Use integer pagination fields.'); params[key] = Number(params[key]); }
      if (req.method === 'GET' && url.pathname === '/api/agent/status') { name = 'blackice_status'; args = params; }
      if (req.method === 'GET' && url.pathname === '/api/agent/models') { name = 'blackice_models'; args = params; }
      if (req.method === 'GET' && ['/api/agent/tasks', '/api/agent/plans'].includes(url.pathname)) { name = 'blackice_list_tasks'; args = planningQuery(url.searchParams); }
      if (req.method === 'POST' && url.pathname === '/api/agent/tasks') { name = 'blackice_start_task'; args = await actionBody({}); }
      const task = url.pathname.match(/^\/api\/agent\/tasks\/([A-Za-z0-9_-]+)(\/plan)?$/);
      if (task && req.method === 'GET' && !task[2]) { name = 'blackice_get_task'; args = { ...params, taskId: task[1] }; }
      if (task && req.method === 'POST' && task[2]) { name = 'blackice_edit_plan'; args = await actionBody({ taskId: task[1] }); }
      const run = url.pathname.match(/^\/api\/agent\/runs\/([A-Za-z0-9_-]+)(\/(continue|cancel|output))?$/);
      if (run && req.method === 'GET' && (!run[2] || run[3] === 'output')) { name = run[2] ? 'blackice_read_output' : 'blackice_get_run'; args = { ...params, runId: run[1] }; }
      if (run && req.method === 'POST' && ['continue', 'cancel'].includes(run[3])) { name = run[3] === 'continue' ? 'blackice_continue_task' : 'blackice_cancel_task'; args = await actionBody({ runId: run[1] }); }
      const artifact = url.pathname.match(/^\/api\/agent\/tasks\/([A-Za-z0-9_-]+)\/artifacts\/(artifact_[a-f0-9-]{36})$/);
      if (artifact && req.method === 'GET') {
        this.require(client, 'read'); this.visibleTask(artifact[1]); if (url.search) throw fail('The artifact download takes no query fields.');
        const value = await this.tasks.readArtifact(artifact[1], artifact[2], { maxBytes: 128 * 1024 * 1024 });
        res.writeHead(200, { 'Content-Type': value.contentType || 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(value.fileName)}`, 'Cache-Control': 'no-store', 'Content-Length': value.buffer.length }); return res.end(value.buffer);
      }
      if (!name) throw fail('Agent endpoint not found.', 404, 'REMOTE_ENDPOINT_UNKNOWN');
      if (req.method === 'POST' && url.search) throw fail('Put action arguments in the JSON body.');
      const value = await this.call(name, args, client); return json(res, name === 'blackice_start_task' || name === 'blackice_continue_task' ? 202 : 200, value);
    } catch (error) { return json(res, error.status || 400, errorValue(error)); }
  }
  instructions() { return 'BLACKICE shares one durable plan with its human and local workers. Read a task before editing; send expectedRevision and reconcile conflicts. planningAwareness shows advisory human editing presence and actual BLACKICE worker read receipts; unsaved text is never included. A read by your outside client does not acknowledge a revision for a BLACKICE worker. Your automation must reread and incorporate relevant saved changes before its own affected actions; BLACKICE cannot gate tools running outside its runtime. Start or continue only work the user authorized. Use the same requestId and exact task arguments after a network failure. Plans describe work; changing step status never starts or completes a runtime. Independent work follows its actual dependencies. Read results with blackice_get_run and paginated output. /api/agent/events is an optional SSE change feed without replay, including planning.awareness invalidations; refetch state after reconnecting. Credentials are issued and revoked in the host BLACKICE Settings.'; }
  async mcp(req, res, client, url) {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, { error: 'Use MCP Streamable HTTP POST. Live work changes are available at /api/agent/events.' }); }
    let value, modern = false;
    const rpcError = (status, code, message, data) => json(res, status, { jsonrpc: '2.0', ...(typeof value?.id === 'string' || Number.isSafeInteger(value?.id) ? { id: value.id } : {}), error: { code, message, ...(data ? { data } : {}) } });
    try {
      if (url.search) return rpcError(400, -32600, 'The MCP endpoint does not accept query fields.');
      if (!String(req.headers.accept || '').includes('application/json') || !String(req.headers.accept || '').includes('text/event-stream')) return rpcError(406, -32600, 'Accept application/json and text/event-stream.');
      value = await this.readBody(req);
      if (!object(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string' || value.method.length > 128 || Object.keys(value).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key)) || value.params !== undefined && !object(value.params) || Object.hasOwn(value, 'id') && typeof value.id !== 'string' && !Number.isSafeInteger(value.id)) return rpcError(400, -32600, 'Send one JSON-RPC request or notification.');
      const params = value.params || {}, meta = params._meta;
      modern = object(meta) && Object.hasOwn(meta, `${META}protocolVersion`) || req.headers['mcp-protocol-version'] === MCP_VERSIONS[0];
      let protocol = req.headers['mcp-protocol-version'];
      if (modern) {
        protocol = meta?.[`${META}protocolVersion`];
        if (typeof protocol !== 'string' || !object(meta?.[`${META}clientCapabilities`])) return rpcError(400, -32602, 'Include per-request protocolVersion and clientCapabilities metadata.');
        if (!MCP_VERSIONS.includes(protocol)) return rpcError(400, -32022, 'Unsupported protocol version', { supported: MCP_VERSIONS, requested: protocol });
        if (protocol !== MCP_VERSIONS[0]) return rpcError(400, -32602, 'Legacy protocol versions use initialize and their HTTP protocol header.');
        const decode = header => {
          if (typeof header !== 'string') return undefined;
          if (header.startsWith('=?base64?') && header.endsWith('?=')) {
            const encoded = header.slice(9, -2); if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return undefined;
            return Buffer.from(encoded, 'base64').toString('utf8');
          }
          return /^[\x20-\x7e]+$/.test(header) && header.trim() === header ? header : undefined;
        };
        if (req.headers['mcp-protocol-version'] !== protocol || req.headers['mcp-method'] !== value.method || ['tools/call', 'resources/read', 'prompts/get'].includes(value.method) && decode(req.headers['mcp-name']) !== (params.name || params.uri)) return rpcError(400, -32020, 'Required MCP headers must match the request body.');
      } else if (value.method !== 'initialize' && protocol && !MCP_VERSIONS.slice(1).includes(protocol)) return rpcError(400, -32022, 'Unsupported protocol version', { supported: MCP_VERSIONS, requested: protocol });
      if (!Object.hasOwn(value, 'id')) {
        if (!modern && ['notifications/initialized', 'notifications/cancelled'].includes(value.method)) { res.writeHead(202, { 'Cache-Control': 'no-store' }); return res.end(); }
        return rpcError(400, -32600, 'This method needs a request ID.');
      }
      const serverInfo = { name: 'BLACKICE', version: this.version }, capabilities = { tools: { listChanged: false } };
      const reply = result => json(res, 200, { jsonrpc: '2.0', id: value.id, result: modern ? { ...result, resultType: 'complete', _meta: { [`${META}serverInfo`]: serverInfo } } : result });
      if (!modern && value.method === 'initialize') {
        if (typeof params.protocolVersion !== 'string' || !object(params.capabilities) || !object(params.clientInfo)) return rpcError(400, -32602, 'Initialize requires protocolVersion, capabilities and clientInfo.');
        return reply({ protocolVersion: MCP_VERSIONS.slice(1).includes(params.protocolVersion) ? params.protocolVersion : MCP_VERSIONS[1], capabilities, serverInfo, instructions: this.instructions() });
      }
      if (modern && value.method === 'server/discover') return reply({ supportedVersions: MCP_VERSIONS, capabilities, instructions: this.instructions() });
      if (value.method === 'ping') return reply({});
      if (value.method === 'tools/list') {
        if (params.cursor !== undefined) return rpcError(400, -32602, 'The tool catalog fits in one page; omit cursor.');
        return reply({ tools: this.tools(client) });
      }
      if (value.method !== 'tools/call') return rpcError(modern ? 404 : 200, -32601, 'Method not found.');
      if (typeof params.name !== 'string' || !definitions.some(tool => tool.name === params.name)) return rpcError(400, -32602, 'Unknown BLACKICE tool.');
      try {
        const result = await this.call(params.name, params.arguments || {}, client);
        return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
      } catch (error) {
        if (error.status === 401 || error.status === 403) return rpcError(error.status, -32602, error.message, errorValue(error));
        if (error.code === 'REMOTE_REQUEST_INVALID') return rpcError(400, -32602, error.message);
        const result = errorValue(error); return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: true });
      }
    } catch (error) { return rpcError(error.status || 400, error.code === 'REMOTE_JSON_INVALID' ? -32700 : -32600, error.message); }
  }
  listen(res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`data: ${JSON.stringify({ type: 'ready', replay: false, refetchOnReconnect: true, at: new Date().toISOString() })}\n\n`);
    this.streams.add(res);
    const heartbeat = setInterval(() => { if (!writeEventStream(res, ': heartbeat\n\n')) { clearInterval(heartbeat); this.streams.delete(res); } }, 15000); heartbeat.unref();
    res.once('close', () => { clearInterval(heartbeat); this.streams.delete(res); });
  }
  publish(event) {
    if (!['run.updated', 'node.updated', 'planning.updated', 'planning.awareness', 'agent.event'].includes(event.type)) return;
    if (event.type === 'agent.event' && event.data?.type !== 'task.state') return;
    const data = { type: event.type === 'agent.event' ? 'planning.updated' : event.type, runId: event.runId, nodeId: event.nodeId, taskId: event.data?.taskId, revision: event.data?.revision || event.data?.state?.revision, status: event.data?.status, at: event.at };
    const text = `data: ${JSON.stringify(data)}\n\n`;
    for (const res of this.streams) if (!writeEventStream(res, text)) this.streams.delete(res);
  }
  close() { for (const res of this.streams) res.end(); this.streams.clear(); }
}
