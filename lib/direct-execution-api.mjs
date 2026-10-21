import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectorBrowserOwner } from './connector-browser-owner.mjs';
import { createWorkspaceToolHandler } from './workspace-tools.mjs';
import { createBrowserToolHandler, containedBrowserAvailable, agentBrowserRequest } from './browser.mjs';
import { DirectExecutionJobs, DIRECT_JOB_LIMITS, DIRECT_JOB_STATES, directJobTerminal, directRequestDigest } from './direct-execution-jobs.mjs';

export const DIRECT_EXECUTION_SCOPES = Object.freeze(['read', 'files:read', 'files:write', 'commands:run', 'browser:read', 'browser:write']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const fail = (message, code = 'DIRECT_REQUEST_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const check = signal => { if (signal?.aborted) throw Object.assign(fail('Direct action cancelled.', 'ABORT_ERR', 409), { name: 'AbortError' }); };
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
const requestId = { ...string(120), pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$', description: 'A stable ID for this exact action under one connectionId. Retry identical arguments with the same ID only while blackice_direct_status reports the same connectionId. After the connection changes, inspect uncertain prior effects before submitting new work. A changed action needs a new ID.' };
const jobId = { ...string(71), pattern: '^direct_[a-f0-9]{64}$' };
const pathField = { ...string(4096), description: 'An explicit absolute path or a path relative to the configured working directory. Filesystem access uses the Windows account permissions.' };
const hashField = { type: 'string', pattern: '^[a-f0-9]{64}$', minLength: 64, maxLength: 64 };
const paging = { offset: { type: 'integer', minimum: 0, maximum: 1000000 }, limit: { type: 'integer', minimum: 1, maximum: 100 } };
const browserIdentity = { tabId: string(200), browser: { const: 'relay' }, expectedUrl: string(20000), expectedDocumentId: string(200) };
const browserArgs = {
  ...browserIdentity, parentTabId: string(200), folderId: string(200), url: string(20000), ref: string(500), text: { type: 'string', maxLength: 16384 }, value: { type: 'string', maxLength: 16384 }, key: string(40),
  modifiers: { type: 'array', items: { enum: ['Alt', 'Control', 'Meta', 'Shift'] }, maxItems: 4, uniqueItems: true }, query: { type: 'string', maxLength: 1000 },
  x: { type: 'number', minimum: 0, maximum: 100000 }, y: { type: 'number', minimum: 0, maximum: 100000 },
  direction: { enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'number', minimum: 1, maximum: 2000 }, timeoutMs: { type: 'integer', minimum: 1, maximum: 30000 },
};
const definitions = [
  ['blackice_direct_status', 'Check the direct BLACKICE connector without reading files, pages or starting a model. Optional nonce is echoed as proof that this authenticated request reached BLACKICE.', 'read', schema({ nonce: { type: 'string', maxLength: 120, pattern: '^[A-Za-z0-9_.:-]*$' } }), false],
  ['blackice_list_jobs', 'Read durable jobs belonging to this authenticated connector grant. Reconnecting never reruns an action.', 'read', schema({ status: { enum: DIRECT_JOB_STATES }, ...paging }), false],
  ['blackice_get_job', 'Read one owned job and its bounded saved result. awaiting_input requires a local person; interrupted or cancelled actions must be inspected before submitting new work.', 'read', schema({ jobId, offset: { type: 'integer', minimum: 0, maximum: 10000000 }, limit: { type: 'integer', minimum: 1, maximum: 50000 }, includeImages: { type: 'boolean' } }, ['jobId']), false],
  ['blackice_cancel_job', 'Request cancellation of this grant\'s job. Cancellation does not undo completed effects; read the saved job until it settles.', 'read', schema({ jobId }, ['jobId']), false],
  ['blackice_workspace_read', 'Inspect local files through BLACKICE\'s bounded file handler. Relative paths use the configured working directory and explicit absolute paths are supported. Returns a durable job immediately; retrieve its result with blackice_get_job. No model is started.', 'files:read', schema({ requestId, action: { enum: ['list', 'read', 'search', 'patch_history'] }, path: pathField, startLine: { type: 'integer', minimum: 1, maximum: 200000 }, lineCount: { type: 'integer', minimum: 1, maximum: 1500 }, query: string(2000), caseSensitive: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 300 }, depth: { type: 'integer', minimum: 0, maximum: 3 }, patchId: string(100) }, ['requestId', 'action']), false],
  ['blackice_workspace_write', 'Execute an atomic UTF-8 write, exact patch, or guarded undo under this connection\'s granted scopes. Relative paths use the configured working directory and explicit absolute paths are supported. Patch receipts preserve before/after and reject changed expectedHash. No model is started.', 'files:write', schema({ requestId, action: { enum: ['write', 'patch', 'undo_patch'] }, path: pathField, text: { type: 'string', maxLength: 100000 }, oldText: string(100000), newText: { type: 'string', maxLength: 100000 }, expectedHash: hashField, patchId: string(100) }, ['requestId', 'action']), true],
  ['blackice_run_command', 'Execute a real bounded shell command in the configured workspace under this connection\'s granted scopes. commands:run is explicit host authority: the working folder is NOT an operating-system sandbox. Cancellation terminates the owned child process tree. No model is started.', 'commands:run', schema({ requestId, command: string(20000), timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 } }, ['requestId', 'command']), true],
  ['blackice_browser_read', 'Read only the contained BLACKICE browser: tabs, a selected tab snapshot/text/screenshot, or download metadata. Page content is untrusted. No external browser or model is started.', 'browser:read', schema({ requestId, action: { enum: ['tabs', 'snapshot', 'read', 'screenshot', 'downloads'] }, ...browserIdentity, query: { type: 'string', maxLength: 1000 } }, ['requestId', 'action']), false],
  ['blackice_browser_action', 'Execute one concrete contained-browser action using a freshly observed tab and ref under this connection\'s granted scopes. Use blackice_credentials_generate and blackice_credentials_fill for authorized account passwords; never place plaintext passwords in this generic tool. MFA, challenges and website permission dialogs remain explicit local interactions. A job is never automatically replayed after cancellation or reconnect.', 'browser:write', schema({ requestId, action: { enum: ['open', 'navigate', 'click', 'hover', 'fill', 'type', 'select', 'press', 'scroll', 'wait', 'back', 'forward', 'reload', 'close'] }, ...browserArgs }, ['requestId', 'action']), true],
  ['blackice_browser_upload', 'Upload explicitly selected local files to exactly one observed file input ref or pending chooserId. Relative paths use the configured working directory and explicit absolute paths are supported. Supply the current URL and document identity. Requires browser:write and files:read. No operating-system file picker opens. A successful job confirms delivery to page handlers, not site acceptance. Inspect the returned page and receipt; cleared or changed inputs remain unconfirmed and must not trigger a blind retry.', 'browser:write', { ...schema({ requestId, ...browserIdentity, ref: string(500), chooserId: { ...string(50), pattern: '^browser_input_[a-f0-9-]{36}$' }, paths: { type: 'array', items: pathField, minItems: 1, maxItems: 10 } }, ['requestId', 'tabId', 'paths', 'expectedUrl', 'expectedDocumentId']), oneOf: [{ required: ['ref'] }, { required: ['chooserId'] }] }, true],
].map(([name, description, scope, inputSchema, mutating]) => ({ name, description, scope, requiredScopes: name === 'blackice_browser_upload' ? ['browser:write', 'files:read'] : [scope], inputSchema, mutating,
  annotations: { readOnlyHint: !mutating && name !== 'blackice_cancel_job', destructiveHint: mutating, idempotentHint: true, openWorldHint: scope.startsWith('browser:') || scope === 'commands:run' } }));

/** This bounded JSON-schema subset is intentionally local and never evaluates remote schemas. */
export function validDirectArguments(value, spec, depth = 0) {
  if (depth > 32 || !object(spec)) return false;
  if (spec.anyOf && !spec.anyOf.some(item => validDirectArguments(value, item, depth + 1))) return false;
  if (spec.oneOf && spec.oneOf.filter(item => validDirectArguments(value, item, depth + 1)).length !== 1) return false;
  if (spec.required && (!object(value) || !spec.required.every(key => Object.hasOwn(value, key)))) return false;
  if (Object.hasOwn(spec, 'const') && value !== spec.const || spec.enum && !spec.enum.includes(value)) return false;
  if (spec.type === 'object') return object(value) && Object.keys(value).length >= (spec.minProperties || 0) && (spec.required || []).every(key => Object.hasOwn(value, key)) && Object.entries(value).every(([key, item]) => Object.hasOwn(spec.properties || {}, key) ? validDirectArguments(item, spec.properties[key], depth + 1) : spec.additionalProperties !== false);
  if (spec.type === 'array') return Array.isArray(value) && value.length >= (spec.minItems || 0) && value.length <= (spec.maxItems ?? Infinity) && (!spec.uniqueItems || new Set(value.map(item => JSON.stringify(item))).size === value.length) && value.every(item => validDirectArguments(item, spec.items, depth + 1));
  if (spec.type === 'string') return typeof value === 'string' && !value.includes('\0') && value.length >= (spec.minLength || 0) && value.length <= (spec.maxLength ?? Infinity) && (!spec.pattern || new RegExp(spec.pattern).test(value));
  if (spec.type === 'integer') return Number.isSafeInteger(value) && value >= (spec.minimum ?? -Infinity) && value <= (spec.maximum ?? Infinity);
  if (spec.type === 'number') return typeof value === 'number' && Number.isFinite(value) && value >= (spec.minimum ?? -Infinity) && value <= (spec.maximum ?? Infinity);
  if (spec.type === 'boolean') return typeof value === 'boolean';
  if (spec.type === 'null') return value === null;
  return spec.type === undefined;
}

/** A working directory for relative paths, not a filesystem containment boundary. */
export class DirectWorkspaceRoot {
  constructor(root) { this.root = typeof root === 'string' && path.isAbsolute(root) ? path.resolve(root) : null; }
  async init() {
    if (!this.root) throw fail('Set an absolute working directory before using file or command tools.', 'DIRECT_WORKSPACE_UNAVAILABLE', 503);
    const info = await fs.stat(this.root);
    if (!info.isDirectory()) throw fail('The configured working directory is not a directory.', 'DIRECT_WORKSPACE_UNAVAILABLE', 503);
    return this.root;
  }
  async resolve(value = '.', { missing = false, directory = false } = {}) {
    const root = await this.init();
    if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) throw fail('Choose a valid file or folder path.');
    const selected = path.resolve(root, value);
    try {
      const info = await fs.stat(selected); if (directory && !info.isDirectory()) throw fail('Choose a directory for this action.');
      return selected;
    } catch (error) { if (missing && error.code === 'ENOENT') return selected; throw error; }
  }
}

function publicJob(value) {
  return { jobId: value.id, requestId: value.requestId, tool: value.tool, action: value.action || value.arguments?.action || (value.tool === 'blackice_run_command' ? 'run' : null), status: value.status, revision: value.revision,
    createdAt: value.createdAt, updatedAt: value.updatedAt, startedAt: value.startedAt, finishedAt: value.finishedAt, settled: directJobTerminal(value),
    effects: clone(value.effects), resultAvailable: Object.hasOwn(value, 'resultAvailable') ? value.resultAvailable : value.result !== null, error: clone(value.error), interaction: clone(value.interaction), requiredScopes: [...value.requiredScopes],
    ...(value.status === 'awaiting_input' ? { nextAction: value.interaction.kind === 'approval' ? 'This legacy approval request will not run. Cancel it, inspect any prior effects, and submit new authorized work with a new requestId.' : 'Complete the indicated local interaction, then inspect the page before submitting a new action. This action will not be replayed.' } : {}) };
}
const inputInteraction = (kind, message, extra = {}) => ({ id: `input_${randomUUID()}`, kind, message, createdAt: new Date().toISOString(), ...extra });
const safeError = error => ({ code: typeof error?.code === 'string' ? error.code.slice(0, 120) : 'DIRECT_ACTION_FAILED', message: typeof error?.message === 'string' ? error.message.slice(0, 1500) : 'The direct action failed.' });
const receiptText = result => (result?.contentItems || []).filter(item => item.type === 'inputText' && typeof item.text === 'string').map(item => item.text).join('\n\n');
const receiptJSON = result => { try { return JSON.parse(result?.contentItems?.find(item => item.type === 'inputText')?.text || 'null'); } catch { return null; } };
const privateBrowserInput = record => record.tool === 'blackice_browser_action' && ['fill', 'type', 'select'].includes(record.arguments.action);
function durableInputReceipt(result, record) {
  // Input can be echoed into a value, label, URL, title, dialog or screenshot.
  // Do not try to find/replace one literal in an arbitrary returned page: keep
  // only adapter-owned identities and non-text outcome facts for this action.
  const data = receiptJSON(result) || {}, pending = data.pendingInteraction, value = { action: record.arguments.action, pageContentOmitted: true, inspectBeforeContinuing: true };
  for (const key of ['tabId', 'documentId']) if (typeof data[key] === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(data[key])) value[key] = data[key];
  if (typeof data.actionDispatched === 'boolean') value.actionDispatched = data.actionDispatched;
  const receipt = {};
  for (const key of ['typed', 'filled']) if (data.receipt?.[key] === true) receipt[key] = true;
  if (typeof data.receipt?.selected === 'string') receipt.selected = true;
  if (Number.isSafeInteger(data.receipt?.characters) && data.receipt.characters >= 0 && data.receipt.characters <= 16384) receipt.characters = data.receipt.characters;
  if (Object.keys(receipt).length) value.receipt = receipt;
  if (object(pending)) {
    value.pendingInteraction = {};
    for (const key of ['id', 'kind', 'tabId', 'documentId', 'status', 'dialogType', 'reason']) if (typeof pending[key] === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(pending[key])) value.pendingInteraction[key] = pending[key];
    if (typeof pending.multiple === 'boolean') value.pendingInteraction.multiple = pending.multiple;
  }
  if (!result.success) value.error = 'The browser input did not complete. Inspect the current page before repeating it.';
  return { success: result.success, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] };
}

/** Concrete direct tools. This module has no engine, provider or model admission. */
export class DirectExecutionAPI {
  constructor({ dataDir, allowedRoot, browser, patchStore, jobs, authorizeClient, isClosing = () => false, onChange = () => {}, additionalTools = [], inspectBrowserInteraction, restartStatus = null, maxConcurrent = 4 } = {}) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw fail('Use 1–8 concurrent direct jobs.');
    if (restartStatus !== null && typeof restartStatus !== 'function') throw fail('Use an app-owned restart status provider.', 'DIRECT_TOOL_CONFIGURATION', 503);
    this.jobs = jobs || new DirectExecutionJobs({ dataDir }); this.workspace = new DirectWorkspaceRoot(allowedRoot); this.browser = browser; this.patchStore = patchStore;
    this.authorizeClient = authorizeClient; this.isClosing = isClosing; this.onChange = onChange; this.inspectBrowserInteraction = inspectBrowserInteraction; this.restartStatus = restartStatus;
    this.definitions = new Map(definitions.map(value => [value.name, clone(value)])); this.extensions = new Map(); this.active = new Map(); this.queue = []; this.queued = new Set(); this.revoked = new Set(); this.transient = new Map();
    this.maxConcurrent = maxConcurrent; this.closed = false; this.draining = false; this.ready = null;
    for (const entry of additionalTools) {
      const def = entry?.definition;
      if (!object(def) || !/^blackice_[a-z0-9_]{1,70}$/.test(def.name) || this.definitions.has(def.name) || !DIRECT_EXECUTION_SCOPES.includes(def.scope) || !object(def.inputSchema) || typeof entry.execute !== 'function' || entry.durableArguments !== undefined && typeof entry.durableArguments !== 'function') throw fail('Register a concrete host-owned direct tool with a unique name, scope, schema and handler.');
      if (entry.timeoutMs !== undefined && entry.timeoutMs !== null && (!Number.isSafeInteger(entry.timeoutMs) || entry.timeoutMs < 1 || entry.timeoutMs > 86400000)) throw fail('Use a valid host-owned direct-tool time budget, or null for cancellable work without a timer.', 'DIRECT_TOOL_CONFIGURATION', 503);
      const registered = { ...clone(def), requiredScopes: [...new Set(def.requiredScopes || [def.scope])], mutating: def.mutating ?? !['read', 'files:read', 'browser:read'].includes(def.scope) };
      if (registered.requiredScopes.some(scope => !DIRECT_EXECUTION_SCOPES.includes(scope)) || !registered.requiredScopes.includes(def.scope) || !registered.inputSchema.required?.includes('requestId')) throw fail('An additional direct tool must declare its scopes and stable requestId.');
      registered.annotations ||= { readOnlyHint: !registered.mutating, destructiveHint: registered.mutating, idempotentHint: true, openWorldHint: true };
      this.definitions.set(def.name, registered); this.extensions.set(def.name, entry);
    }
  }
  init() {
    return this.ready ||= (async () => {
      // This optional connector must not prevent the desktop app from opening
      // when its ledger needs local recovery. The ledger itself stays strict:
      // no damaged record is repaired, discarded or admitted around.
      try { await this.jobs.init(); } catch (error) { this.storageError = safeError(error); this.storageFailedAtInit = true; }
      if (this.workspace.root) { try { await this.workspace.init(); } catch (error) { this.workspaceError = safeError(error); } }
      return this;
    })();
  }
  async requireStorage() {
    await this.init();
    if (this.jobs.storageError) this.storageError = safeError(this.jobs.storageError);
    if (this.storageError) throw fail('Direct execution storage needs local recovery. Existing receipts were preserved and no job data or new action is available.', 'DIRECT_JOB_STORAGE', 503);
  }
  tools(client) {
    return [...this.definitions.values()].filter(tool => !client || ['read', ...tool.requiredScopes].every(scope => client.scopes?.includes(scope))).map(({ mutating, ...value }) => clone(value));
  }
  async require(client, requiredScopes = ['read']) {
    if (!object(client) || typeof client.id !== 'string' || !client.id || client.id.length > 240 || !Array.isArray(client.scopes) || this.revoked.has(client.id)) throw fail('Connect with an active authenticated ChatGPT grant.', 'DIRECT_AUTH_REQUIRED', 401);
    const required = [...new Set(['read', ...requiredScopes])];
    for (const scope of required) if (!client.scopes.includes(scope)) throw Object.assign(fail(`This action requires the ${scope} permission.`, 'DIRECT_SCOPE_REQUIRED', 403), { scope, requiredScopes: required });
    if (this.authorizeClient && await this.authorizeClient(client, { requiredScopes: required }) !== true) throw Object.assign(fail('This connector grant is no longer authorized for the action.', 'DIRECT_AUTH_REQUIRED', 401), { requiredScopes: required });
    if (this.revoked.has(client.id)) throw fail('This connector grant was revoked before the action was admitted.', 'DIRECT_AUTH_REQUIRED', 401);
  }
  async status(client, { nonce } = {}) {
    await this.init(); if (client) await this.require(client);
    let counts;
    if (!this.storageError) try { counts = await this.jobs.counts(client ? { ownerId: client.id } : {}); } catch (error) { this.storageError = safeError(error); }
    let restart;
    if (this.restartStatus) {
      let canRestart = Boolean(client?.scopes?.includes('commands:run'));
      if (canRestart) try { await this.require(client, ['commands:run']); } catch (error) { if (![401, 403].includes(error.status)) throw error; canRestart = false; }
      const value = await this.restartStatus({ ownerId: client?.id, canRestart });
      if (object(value)) {
        restart = { available: value.available === true, provider: value.provider === 'electron' ? 'electron' : null,
          status: ['idle', 'scheduled', 'restarting', 'completed', 'failed', 'cancelled', 'interrupted'].includes(value.status) ? value.status : 'unavailable' };
        if (canRestart && object(value.receipt) && value.receipt.ownerId === client.id) {
          restart.receipt = clone(value.receipt);
        }
      }
      if (client) await this.require(client, restart?.receipt ? ['commands:run'] : ['read']);
    }
    return { app: 'BLACKICE', mode: 'direct-execution', modelStarted: false, providerTurns: false, available: !this.closed && !this.isClosing() && !this.storageError, workspaceConfigured: Boolean(this.workspace.root), workspaceRestricted: false,
      ...(client ? { connectionId: client.id, grantedScopes: [...client.scopes] } : {}),
      containedBrowserAvailable: containedBrowserAvailable(this.browser?.status?.()), supportedScopes: [...DIRECT_EXECUTION_SCOPES], defaultScope: 'read', localMutationApproval: false,
      jobs: { available: !this.storageError, total: counts?.total ?? null, active: [...this.active.keys()].filter(id => !client || this.active.get(id).ownerId === client.id).length },
      capabilities: { directTools: true, durableJobs: true, reconnectReadsResults: true, automaticReplay: false, modelWorkers: false, arbitraryAPIProxy: false, shellIsSandboxed: false },
      ...(restart ? { restart } : {}), ...(this.storageError ? { storageError: clone(this.storageError) } : {}), ...(this.workspaceError ? { workspaceError: clone(this.workspaceError) } : {}), ...(nonce !== undefined ? { nonce } : {}) };
  }
  async call(name, args, client) {
    const definition = this.definitions.get(name); if (!definition) throw fail('Unknown direct BLACKICE tool.', 'DIRECT_TOOL_UNKNOWN', 404);
    await this.require(client, definition.requiredScopes);
    if (!validDirectArguments(args, definition.inputSchema)) throw fail(`Use the declared arguments for ${name}.`);
    directRequestDigest(args); await this.init();
    if (name === 'blackice_direct_status') return this.status(client, args);
    if (name === 'blackice_cancel_job') {
      // Revoking a capability must not prevent stopping already owned work, but
      // cancellation is not another route to the old action's protected details.
      const value = await this.cancel(args.jobId, { ownerId: client.id, reason: 'Requested by the authenticated connector.', beforeSignal: () => this.require(client) });
      if (value.durable === false) { await this.require(client); return value; }
      try { await this.require(client, value.requiredScopes); return value; }
      catch (error) {
        if (![401, 403].includes(error.status)) throw error;
        await this.require(client);
        return { jobId: value.jobId, status: value.status, revision: value.revision, settled: value.settled, detailsRestricted: true };
      }
    }
    await this.requireStorage();
    if (name === 'blackice_list_jobs') return this.listJobs(client, args);
    if (name === 'blackice_get_job') return this.getJob(args.jobId, client, args);
    if (this.closed || this.isClosing()) throw fail('BLACKICE is closing for maintenance. No direct action was admitted.', 'PROFILE_MAINTENANCE', 503);
    return this.submit(definition, clone(args), clone(client));
  }
  async listJobs(client, { status, offset = 0, limit = 40 } = {}) {
    await this.requireStorage(); await this.require(client);
    // One immutable metadata view avoids payload copies and moving offset pages
    // while scope authorization yields to concurrent admissions or completions.
    const records = await this.jobs.snapshot({ ownerId: client.id, status });
    const decisions = new Map(), visible = [];
    for (const record of records) {
      const key = [...new Set(record.requiredScopes)].sort().join('\0');
      if (!decisions.has(key)) {
        try { await this.require(client, record.requiredScopes); decisions.set(key, true); }
        catch (error) { if (![401, 403].includes(error.status)) throw error; decisions.set(key, false); }
      }
      if (decisions.get(key)) visible.push(record);
    }
    // A scope refresh can race the earlier checks. Recheck their union before
    // releasing even error messages, interaction details or caller request IDs.
    await this.require(client, [...new Set(visible.flatMap(record => record.requiredScopes))]);
    return { jobs: visible.slice(offset, offset + limit).map(publicJob), total: visible.length, offset, limit,
      nextOffset: offset + limit < visible.length ? offset + limit : null, filteredToCurrentScopes: true };
  }
  async getJob(id, client, { offset = 0, limit = 12000, includeImages = false } = {}) {
    await this.requireStorage(); await this.require(client); const record = await this.jobs.get(id, { ownerId: client.id });
    await this.require(client, record.requiredScopes); const value = publicJob(record);
    if (record.result !== null) {
      const text = receiptText(record.result), images = (record.result.contentItems || []).filter(item => item.type === 'inputImage' && typeof item.imageUrl === 'string');
      value.result = { success: record.result.success === true, text: { text: text.slice(offset, offset + limit), offset, limit, totalCharacters: text.length, nextOffset: offset + limit < text.length ? offset + limit : null }, imageCount: images.length,
        ...(includeImages ? { images: images.map(item => ({ imageUrl: item.imageUrl })) } : {}) };
    }
    return value;
  }
  async submit(definition, args, client) {
    const { requestId: requestedId, ...operation } = args;
    const extension = this.extensions.get(definition.name), payload = extension ? args : operation;
    this.validateAction(definition.name, payload);
    const requestDigest = directRequestDigest({ tool: definition.name, arguments: payload });
    // An identical retry reads its admitted receipt even if the page has since
    // closed or become reserved. It never repeats admission or browser work.
    const existing = await this.jobs.findRequest({ ownerId: client.id, requestId: requestedId, requestDigest });
    if (existing) { await this.require(client, existing.requiredScopes); return { ...publicJob(existing), existing: true }; }
    if (definition.name.startsWith('blackice_browser_')) agentBrowserRequest({ ...payload, action: definition.name === 'blackice_browser_upload' ? 'upload' : payload.action, browser: 'relay' }, this.browser?.status?.(), connectorBrowserOwner(client.id));
    const browserSecret = definition.name === 'blackice_browser_action' && ['fill', 'type', 'select'].includes(payload.action);
    const transientArguments = Boolean(extension?.durableArguments || browserSecret);
    const durable = extension?.durableArguments ? extension.durableArguments(clone(payload)) : browserSecret ? { ...payload,
      ...Object.fromEntries(['text', 'value', 'url', 'expectedUrl', 'query'].filter(key => Object.hasOwn(payload, key)).map(key => [key, '[input retained only in process memory]'])) } : payload;
    if (!object(durable)) throw fail('The host tool did not supply valid durable request metadata.', 'DIRECT_TOOL_CONFIGURATION', 503);
    const retainedClient = { id: client.id, label: typeof client.label === 'string' ? client.label.slice(0, 160) : 'ChatGPT', kind: typeof client.kind === 'string' ? client.kind : 'chatgpt', scopes: [...client.scopes], ...(typeof client.grantId === 'string' ? { grantId: client.grantId } : {}) };
    const { created, job } = await this.jobs.admit({ ownerId: client.id, requestId: requestedId, tool: definition.name, arguments: durable, requiredScopes: definition.requiredScopes, client: retainedClient, mutating: definition.mutating,
      transientArguments, originalRequestDigest: requestDigest });
    if (created) { if (transientArguments) this.transient.set(job.id, payload); this.changed(job); this.schedule(job.id); }
    return { ...publicJob(job), existing: !created };
  }
  validateAction(name, args) {
    const allowed = fields => { if (Object.keys(args).some(key => !fields.includes(key))) throw fail('Use only the fields for this specific action.'); };
    if (name === 'blackice_workspace_read') {
      const common = ['action', 'path'];
      const byAction = { list: ['limit', 'depth'], read: ['startLine', 'lineCount'], search: ['query', 'caseSensitive', 'limit'], patch_history: ['patchId', 'limit'] };
      allowed([...common, ...byAction[args.action]]);
      if (args.action === 'search' && !args.query || args.action === 'search' && args.limit > 100 || args.action === 'patch_history' && args.limit > 100) throw fail('Supply a literal search query and a supported result limit.');
      if (args.action === 'patch_history' && args.path !== undefined) throw fail('Patch history uses the configured working directory and an optional receipt ID.');
    }
    if (name === 'blackice_workspace_write') {
      const byAction = { write: ['path', 'text'], patch: ['path', 'oldText', 'newText', 'expectedHash'], undo_patch: ['patchId'] };
      allowed(['action', ...byAction[args.action]]);
      const required = { write: ['path', 'text'], patch: ['path', 'oldText', 'newText'], undo_patch: ['patchId'] };
      if (!required[args.action].every(key => Object.hasOwn(args, key))) throw fail('Supply the required fields for this file action.');
    }
    if (name.startsWith('blackice_browser_')) {
      const action = name === 'blackice_browser_upload' ? 'upload' : args.action;
      if (!['tabs', 'downloads', 'open'].includes(action) && !args.tabId) throw fail('Select an explicitly observed contained browser tab.');
      if (['open', 'navigate'].includes(action) && !args.url || ['click', 'hover'].includes(action) && !args.ref && !(Number.isFinite(args.x) && Number.isFinite(args.y)) || ['fill', 'select'].includes(action) && !args.ref || action === 'upload' && Boolean(args.ref) === Boolean(args.chooserId) || action === 'press' && !args.key || action === 'type' && (!args.text || !args.expectedDocumentId || !args.expectedUrl)) throw fail('Supply the observed target and required fields for this browser action.');
      if (['click', 'hover'].includes(action) && !args.ref && (!args.expectedDocumentId || !args.expectedUrl)) throw fail('Coordinate input requires a freshly observed document identity and URL.');
      if (args.expectedDocumentId !== undefined || args.expectedUrl !== undefined) if (!['click', 'press', 'type', 'upload'].includes(action) || !args.expectedDocumentId || !args.expectedUrl) throw fail('Use document guards with click, press, type or upload and supply both identity and URL.');
      if (['fill', 'type'].includes(action) && typeof args.text !== 'string' || action === 'select' && typeof args.value !== 'string') throw fail('Supply text or a selection value for this input action.');
    }
  }
  changed(record) { try { this.onChange({ type: 'direct.job', job: publicJob(record) }); } catch {} }
  schedule(id) { if (this.closed || this.storageError || this.queued.has(id) || this.active.has(id)) return; this.queued.add(id); this.queue.push(id); queueMicrotask(() => { void this.drain(); }); }
  drain() {
    if (this.drainPromise || this.closed || this.storageError) return this.drainPromise;
    this.drainPromise = this.drainJobs().finally(() => { this.drainPromise = null; }); return this.drainPromise;
  }
  async drainJobs() {
    try {
      while (!this.closed && !this.storageError && this.active.size < this.maxConcurrent && this.queue.length) {
        const id = this.queue.shift(); this.queued.delete(id); const record = await this.jobs.get(id);
        if (record.status !== 'queued') continue;
        if (this.closed) { this.queue.unshift(id); this.queued.add(id); break; }
        const active = { ownerId: record.ownerId, controller: new AbortController(), settled: null };
        this.active.set(id, active); active.settled = this.execute(record, active).catch(async error => {
          this.storageError = safeError(error);
        }).finally(() => { this.active.delete(id); this.transient.delete(id); queueMicrotask(() => { void this.drain(); }); });
      }
    } catch (error) { this.storageError = safeError(error); }
  }
  async execute(initial, active) {
    let record = initial;
    try {
      await this.require(record.client, record.requiredScopes); check(active.controller.signal);
      if (this.closed || this.isClosing()) throw fail('BLACKICE is closing. The direct action was not dispatched.', 'PROFILE_MAINTENANCE', 503);
      const args = record.transientArguments ? this.transient.get(record.id) : record.arguments;
      if (!args) throw fail('Transient action inputs are no longer available. The action was not dispatched.', 'DIRECT_INPUT_EXPIRED', 409);
      const prepared = await this.prepare(record, args, active.controller.signal); check(active.controller.signal);
      await this.require(record.client, record.requiredScopes); check(active.controller.signal);
      if (this.closed || this.isClosing()) throw fail('BLACKICE is closing. The direct action was not dispatched.', 'PROFILE_MAINTENANCE', 503);
      const dispatchesAction = prepared.dispatchesAction !== false;
      record = await this.jobs.update(record.id, current => current.status === 'queued' ? { status: 'running', startedAt: new Date().toISOString(), dispatched: dispatchesAction, effects: { possible: dispatchesAction && current.mutating, confirmed: false }, interaction: null } : null);
      if (record.status !== 'running') return;
      await this.require(record.client, record.requiredScopes); check(active.controller.signal);
      if (this.closed || this.isClosing()) throw fail('BLACKICE is closing. The direct action was not dispatched.', 'PROFILE_MAINTENANCE', 503);
      this.changed(record);
      const extension = this.extensions.get(record.tool);
      const duration = extension?.timeoutMs === null ? null : extension?.timeoutMs ?? (record.tool === 'blackice_run_command' ? (args.timeoutMs || 30000) + 5000 : 40000);
      if (duration !== null) active.timer = setTimeout(() => { void this.cancel(record.id, { reason: 'The direct action exceeded its time budget; cancellation was requested. Inspect possible effects before repeating.' }).catch(error => { this.storageError = safeError(error); active.controller.abort(); }); }, duration);
      let result = await prepared(); clearTimeout(active.timer);
      if (!object(result) || typeof result.success !== 'boolean' || !Array.isArray(result.contentItems) || Buffer.byteLength(JSON.stringify(result)) > DIRECT_JOB_LIMITS.resultBytes) throw fail('The direct tool result was invalid or exceeded its durable output limit. Inspect any possible effects before retrying.', 'DIRECT_RESULT_INVALID', 502);
      if (privateBrowserInput(record)) result = durableInputReceipt(result, record);
      const interaction = await this.browserInteraction(record, result);
      const notDispatched = record.tool.startsWith('blackice_browser_') && receiptJSON(result)?.actionDispatched === false;
      record = await this.jobs.update(record.id, current => directJobTerminal(current) ? null : ({ status: current.status === 'cancelling' ? 'cancelled' : interaction ? 'awaiting_input' : result.success && !notDispatched ? 'succeeded' : 'failed',
        finishedAt: interaction && current.status !== 'cancelling' ? null : new Date().toISOString(), result, interaction: current.status === 'cancelling' ? null : interaction,
        dispatched: current.dispatched && !notDispatched,
        effects: { possible: current.dispatched && !notDispatched && current.mutating, confirmed: current.dispatched && !notDispatched && !interaction && current.mutating && result.success === true }, error: current.status === 'cancelling' ? { code: 'DIRECT_CANCELLED_AFTER_DISPATCH', message: 'Cancellation was requested after dispatch. The tool returned this receipt; inspect its result before repeating any action.' } : interaction || result.success && !notDispatched ? null : { code: 'DIRECT_TOOL_FAILED', message: 'The tool did not complete the requested action. Read the saved result before deciding what to do next.' } }));
      this.changed(record);
    } catch (error) {
      clearTimeout(active.timer);
      record = await this.jobs.update(initial.id, current => directJobTerminal(current) ? null : ({ status: current.status === 'cancelling' || active.controller.signal.aborted ? 'cancelled' : 'failed', finishedAt: new Date().toISOString(), interaction: null,
        effects: { possible: current.dispatched && current.mutating, confirmed: false }, error: active.controller.signal.aborted ? { code: 'DIRECT_CANCELLED', message: current.dispatched ? 'Cancellation requested after dispatch. Some effects may already have occurred; inspect before repeating.' : 'Cancelled before the tool was dispatched.' } : privateBrowserInput(current) ? { code: 'DIRECT_BROWSER_INPUT_FAILED', message: 'The browser input could not complete. Inspect the current page before repeating it.' } : safeError(error) }));
      this.changed(record);
    }
  }
  async prepare(record, original, signal) {
    const args = clone(original), extension = this.extensions.get(record.tool);
    if (extension) {
      if (record.requiredScopes.some(scope => scope.startsWith('files:'))) await this.workspace.init();
      return async () => {
        if (record.requiredScopes.some(scope => scope.startsWith('files:'))) await this.workspace.init();
        check(signal); return extension.execute(args, { signal, jobId: record.id, client: clone(record.client) });
      };
    }
    if (record.tool.startsWith('blackice_browser_')) {
      const owner = connectorBrowserOwner(record.ownerId);
      Object.assign(args, agentBrowserRequest({ ...args, action: record.tool === 'blackice_browser_upload' ? 'upload' : args.action, browser: 'relay' }, this.browser?.status?.(), owner));
      if (record.tool === 'blackice_browser_upload') { args.action = 'upload'; args.paths = await Promise.all(args.paths.map(value => this.workspace.resolve(value))); }
      if (this.inspectBrowserInteraction) {
        const pending = await this.inspectBrowserInteraction(args);
        if (pending) {
          const blocked = async () => ({ success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ pendingInteraction: pending, actionDispatched: false }) }] });
          blocked.dispatchesAction = false; return blocked;
        }
      }
      const validateUploadPath = value => this.workspace.resolve(value);
      const beforeDispatch = async ({ signal: activeSignal } = {}) => {
        await this.require(record.client, record.requiredScopes); check(activeSignal || signal);
        if (this.closed || this.isClosing()) throw fail('BLACKICE is closing. The browser action was not dispatched.', 'PROFILE_MAINTENANCE', 503);
        if (record.tool === 'blackice_browser_upload') for (const value of args.paths) await validateUploadPath(value);
        check(activeSignal || signal);
      };
      const handler = createBrowserToolHandler({ browser: this.browser, owner, signal, maxCalls: 1, beforeDispatch,
        ...(record.tool === 'blackice_browser_upload' ? { validateUploadPath } : {}) });
      return () => handler({ name: 'relay_browser', arguments: { ...args, browser: 'relay' } }, { signal });
    }
    const cwd = await this.workspace.init();
    if (record.tool === 'blackice_run_command') args.action = 'run';
    let target;
    if (['list', 'read', 'search', 'write', 'patch'].includes(args.action)) { target = await this.workspace.resolve(args.path || '.', { missing: args.action === 'write', directory: args.action === 'list' }); args.path = target; }
    if (['patch_history', 'undo_patch'].includes(args.action) && args.patchId) {
      if (!this.patchStore) throw fail('Durable patch history is unavailable.', 'DIRECT_PATCH_UNAVAILABLE', 503);
      const receipt = await this.patchStore.get(args.patchId); await this.workspace.resolve(receipt.path);
    }
    const handler = createWorkspaceToolHandler({ cwd, signal, patchStore: this.patchStore, runId: record.id, nodeId: 'direct', maxCalls: 1 });
    return async () => {
      // Resolve against the configured working directory immediately before use.
      await this.workspace.init(); if (target) await this.workspace.resolve(target, { missing: args.action === 'write' }); check(signal);
      let result = await handler({ name: 'relay_workspace', arguments: args }, { signal });
      await this.workspace.init(); if (target) await this.workspace.resolve(target, { missing: args.action === 'write' });
      return result;
    };
  }
  async browserInteraction(record, result) {
    if (!record.tool.startsWith('blackice_browser_')) return null;
    const data = receiptJSON(result), supplied = data?.pendingInteraction || data?.interaction;
    if (object(supplied)) {
      const kind = ['browser', 'javascript_dialog', 'http_auth', 'file_chooser', 'sign_in', 'verification', 'permission'].includes(supplied.kind) ? supplied.kind : 'browser';
      return inputInteraction(kind, supplied.status === 'blocked' ? 'The browser blocked or cancelled this interaction. Review the exact page locally; the action will not be replayed.' : 'A browser interaction needs the local person. No dialog was accepted and the action will not be replayed.', {
        ...(typeof supplied.id === 'string' ? { browserInteractionId: supplied.id.slice(0, 200) } : {}),
        ...(typeof (supplied.tabId || data.tabId || record.arguments.tabId) === 'string' ? { tabId: supplied.tabId || data.tabId || record.arguments.tabId } : {}),
        ...(typeof supplied.documentId === 'string' ? { documentId: supplied.documentId.slice(0, 200) } : {}),
        ...(['pending', 'blocked'].includes(supplied.status) ? { status: supplied.status } : {}),
      });
    }
    // Older snapshots contain historical warning strings. They are not evidence
    // that a dialog is still pending; only a concrete adapter interaction blocks.
    return null;
  }
  async pendingInteractions() {
    await this.init();
    if (this.storageError) return { available: false, storageError: clone(this.storageError), jobs: [], total: null, offset: 0, limit: 100, nextOffset: null };
    const list = await this.jobs.list({ status: 'awaiting_input', limit: 100 });
    return { available: true, ...list, jobs: list.jobs.map(record => ({ ...publicJob(record), owner: { id: record.ownerId, label: record.client.label }, request: clone(record.arguments) })) };
  }
  async reject(id, interactionId) {
    await this.requireStorage();
    const current = await this.jobs.get(id);
    if (current.status !== 'awaiting_input' || current.interaction?.id !== interactionId) throw fail('This exact pending interaction is no longer available.', 'DIRECT_INTERACTION_CHANGED', 409);
    return this.cancel(id, { reason: 'Rejected locally.', expectedRevision: current.revision });
  }
  async resolveInteraction(id, interactionId) {
    await this.requireStorage();
    const current = await this.jobs.get(id);
    if (current.status !== 'awaiting_input' || current.interaction?.kind === 'approval' || current.interaction?.id !== interactionId) throw fail('This exact browser interaction is no longer available.', 'DIRECT_INTERACTION_CHANGED', 409);
    const record = await this.jobs.update(id, () => ({ status: 'interrupted', finishedAt: new Date().toISOString(), resolvedInteraction: current.interaction, interaction: null,
      error: { code: 'DIRECT_REINSPECT_REQUIRED', message: 'The local person acknowledged the blocker. Inspect the current page and prior effects before submitting a new action; the original action was not replayed.' } }), { expectedRevision: current.revision });
    this.changed(record); return publicJob(record);
  }
  async cancel(id, { ownerId, reason = 'Cancelled locally.', expectedRevision, beforeSignal } = {}) {
    try {
      await this.requireStorage();
      const current = await this.jobs.get(id, { ownerId }); if (directJobTerminal(current)) return publicJob(current);
      const record = await this.jobs.update(id, value => directJobTerminal(value) ? null : ({ status: this.active.has(id) && value.dispatched ? 'cancelling' : 'cancelled', interaction: null,
        ...(this.active.has(id) && value.dispatched ? {} : { finishedAt: new Date().toISOString() }), error: { code: 'DIRECT_CANCEL_REQUESTED', message: reason }, effects: { possible: value.dispatched && value.mutating, confirmed: false } }), { expectedRevision });
      this.active.get(id)?.controller.abort(); this.transient.delete(id); this.changed(record); return publicJob(record);
    } catch (error) {
      if (error.code !== 'DIRECT_JOB_STORAGE') throw error;
      this.storageError = safeError(this.jobs.storageError || error);
      // The live executor is sufficient to identify and stop owned work. It is
      // not a replacement receipt store: keep uncertain disk evidence untouched.
      await beforeSignal?.();
      const active = this.active.get(id);
      if (!active || ownerId !== undefined && active.ownerId !== ownerId) throw error;
      active.controller.abort();
      return { jobId: id, cancellationRequested: true, settled: false, durable: false, detailsRestricted: true, storageUnavailable: true };
    }
  }
  async revokeClient(ownerId) {
    this.revoked.add(ownerId);
    for (const active of this.active.values()) if (active.ownerId === ownerId) active.controller.abort();
    await this.init();
    if (this.jobs.storageError) this.storageError = safeError(this.jobs.storageError);
    if (this.storageError) return { ownerId, cancelled: 0, available: false, storageError: clone(this.storageError) };
    const records = await this.jobs.snapshot({ ownerId, unfinishedOnly: true }); let cancelled = 0;
    for (const record of records) { await this.cancel(record.id, { ownerId, reason: 'Connector access was revoked locally.' }); cancelled++; }
    return { ownerId, cancelled };
  }
  async close({ timeoutMs = 15000 } = {}) {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const active of this.active.values()) active.controller.abort();
    this.closePromise = (async () => {
      await this.init();
      await this.drainPromise;
      const cancelSaved = async (id, reason) => {
        if (this.storageError || this.jobs.storageError) return;
        try { await this.cancel(id, { reason }); }
        catch (error) {
          if (error.code !== 'DIRECT_JOB_STORAGE' && !this.jobs.storageError) throw error;
          this.storageError = safeError(this.jobs.storageError || error);
        }
      };
      for (const [id] of this.active) await cancelSaved(id, 'BLACKICE is closing.');
      for (const id of this.queue.splice(0)) { this.queued.delete(id); await cancelSaved(id, 'BLACKICE closed before this queued action was dispatched.'); }
      const work = Promise.allSettled([...this.active.values()].map(value => value.settled)); let timer;
      try {
        await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(fail('A direct action has not acknowledged shutdown. Its ledger remains locked; inspect possible effects before restarting.', 'DIRECT_SHUTDOWN_UNCONFIRMED', 503)), timeoutMs); })]);
      } finally { clearTimeout(timer); }
      this.transient.clear(); await this.jobs.close();
    })().catch(error => { this.closePromise = null; throw error; });
    return this.closePromise;
  }
}
