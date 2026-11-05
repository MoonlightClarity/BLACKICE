import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { VibeAcpConnection, VIBE_PROVIDER_ID, VIBE_THREAD_PREFIX, vibeError, safeVibeError } from './mistral-vibe-protocol.mjs';
import { createVibeToolBridge } from './mistral-vibe-tools.mjs';
import { emptyTokenUsage, tokenUsageMeasurement, aggregateTokenUsage, reportedTokenCount } from '../public/token-usage.mjs';
import { contextSnapshot, normalizeContextOptions, estimateContextTokens } from './context.mjs';
import { normalizeRunTimeout, startRunDeadline } from './run-timeout.mjs';
import { validateResponseOnlyOptions, normalizeOutputSchema } from './response-profile.mjs';
import { normalizeInputImages, redactInputImageData, assertInputImagesSupported } from './input-images.mjs';

const qualified = model => VIBE_PROVIDER_ID + '::' + model;
const validId = id => typeof id === 'string' && /^vibe_[a-f0-9-]{36}$/.test(id);
const now = () => new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stopError = signal => signal?.reason instanceof Error ? signal.reason : vibeError('Mistral Vibe was cancelled.', 'ABORTED');
const clone = value => JSON.parse(JSON.stringify(value));
function awaitAbortable(value, signal) {
  if (signal.aborted) return Promise.reject(stopError(signal));
  return new Promise((resolve, reject) => {
    const finish = (handler, result) => { signal.removeEventListener('abort', abort); handler(result); };
    const abort = () => finish(reject, stopError(signal));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(value).then(result => finish(resolve, result), cause => finish(reject, cause));
  });
}
const OFFICIAL_AUTH_HOSTS = new Set(['console.mistral.ai', 'chat.mistral.ai', 'admin.mistral.ai', 'mistral.ai']);

async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (cause) { if (cause.code === 'ENOENT') return fallback; throw cause; }
}
async function atomicJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  try { await fs.rename(temp, file); } catch (cause) { await fs.rm(temp, { force: true }); throw cause; }
}
function entries(options = []) {
  return options.flatMap(option => Array.isArray(option?.options) ? entries(option.options) : typeof option?.value === 'string' ? [option] : []);
}
export function vibeModelCatalog(configOptions, observedWindow = null) {
  const modelOption = configOptions?.find(option => option.id === 'model');
  if (!modelOption || typeof modelOption.currentValue !== 'string') throw vibeError('The installed Vibe CLI did not advertise a model catalog.', 'MISTRAL_VIBE_CATALOG');
  const thinking = configOptions.find(option => option.id === 'thinking');
  const effort = value => value === 'off' ? 'none' : value;
  const supported = entries(thinking?.options).filter(option => ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(option.value))
    .map(option => ({ reasoningEffort: effort(option.value), description: option.name || option.value }));
  const seen = new Set();
  const models = entries(modelOption.options).filter(option => {
    if (!option.value || seen.has(option.value) || option.value.length > 200) return false;
    seen.add(option.value); return true;
  }).map(option => ({
    id: option.value, model: option.value, displayName: option.name || option.value,
    description: option.description || '', supportsTools: true,
    ...(option.value === modelOption.currentValue ? {
      supportsReasoningSelection: supported.length > 0,
      ...(supported.length ? { supportedReasoningEfforts: supported, defaultReasoningEffort: effort(thinking.currentValue) } : {}),
      ...(Number.isSafeInteger(observedWindow) && observedWindow > 0 ? { contextWindowTokens: observedWindow, contextWindowSource: 'runtime-reported' } : {}),
    } : {}),
  }));
  if (!models.some(model => model.id === modelOption.currentValue)) throw vibeError('Vibe advertised a default model absent from its model catalog.', 'MISTRAL_VIBE_CATALOG');
  return { models, defaultModel: modelOption.currentValue };
}

const NATIVE_CATALOG_TTL_MS = 30 * 24 * 60 * 60 * 1000;
function nativeCatalogRecords(cache) {
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return [];
  return Object.values(cache).slice(0, 128).filter(record =>
    Number.isSafeInteger(record?.stored_at_timestamp)
    && record.stored_at_timestamp * 1000 > Date.now() - NATIVE_CATALOG_TTL_MS
    && record.stored_at_timestamp * 1000 <= Date.now() + 300_000
    && Array.isArray(record.payload?.models)
  ).sort((a, b) => b.stored_at_timestamp - a.stored_at_timestamp);
}
function accountModels(record) {
  return (record?.payload?.models || []).filter(model =>
    typeof model?.id === 'string' && model.id.length > 0 && model.id.length <= 200
    && typeof model.label === 'string' && model.label.length > 0
    && model.capabilities?.function_calling === true
  );
}
function catalogIdentity(model) {
  return [model.id, ...(Array.isArray(model.aliases) ? model.aliases.filter(alias => typeof alias === 'string' && alias.length <= 200) : [])];
}

/** Metadata is admitted only for identities that this authenticated ACP session
 * advertises. Catalog alias declarations, never matching labels, prove duplicates.
 * The CLI owns credential-keyed cache validation and acquisition; cache keys and
 * credentials never enter the public catalog.
 */
export function vibeAccountCatalog(configOptions, cache, preferredIds = []) {
  const raw = vibeModelCatalog(configOptions);
  const native = entries(configOptions.find(option => option.id === 'model')?.options);
  const record = nativeCatalogRecords(cache).find(candidate => accountModels(candidate).some(model =>
    native.some(option => option.value === model.id && option.description === model.id)
  ));
  if (!record) return { ...raw, accountCatalogState: 'unavailable' };
  const declared = accountModels(record);
  const groups = new Map();
  for (const model of raw.models) {
    const option = native.find(candidate => candidate.value === model.id);
    const entry = declared.find(candidate => {
      const identities = catalogIdentity(candidate);
      return identities.includes(model.id) && identities.includes(option?.description || model.id);
    });
    const key = entry?.id || model.id;
    const group = groups.get(key) || { entry, models: [] };
    group.models.push(model); groups.set(key, group);
  }
  const redirects = new Map(), models = [];
  for (const group of groups.values()) {
    const preferred = [...preferredIds, raw.defaultModel].map(id => group.models.find(model => model.id === id)).find(Boolean)
      || group.models.find(model => model.id === group.entry?.id) || group.models[0];
    for (const model of group.models) redirects.set(model.id, preferred.id);
    const entry = group.entry;
    models.push({
      ...preferred,
      ...(entry ? {
        description: entry.description || preferred.description,
        accountCatalogId: entry.id,
        ...(Number.isSafeInteger(entry.max_context_length) && entry.max_context_length > 0
          ? { contextWindowTokens: entry.max_context_length, contextWindowSource: 'account-catalog' } : {}),
        ...(typeof entry.capabilities.vision === 'boolean'
          ? { inputModalities: entry.capabilities.vision ? ['text', 'image'] : ['text'] } : {}),
      } : {}),
    });
  }
  return { models, defaultModel: redirects.get(raw.defaultModel) || raw.defaultModel, accountCatalogState: 'available' };
}

/** A BLACKICE-owned profile: no user/project tools, skills, hooks or connectors.
 * The only enabled tool names are the exact namespace names of the owned MCP bridge.
 * An empty allowlist has a different meaning in Vibe, so discovery uses a nonmatching regex.
 */
export function vibeIsolationConfig({ toolNames = [], profile = 'blackice' } = {}) {
  return [
    'default_agent = ' + JSON.stringify(profile),
    'enabled_agents = [' + JSON.stringify(profile) + ']',
    'enable_auto_approve = false',
    'enabled_tools = ' + JSON.stringify(toolNames.length ? [...toolNames] : ['re:(?!)']),
    'enable_mcp = ' + Boolean(toolNames.length),
    'enable_connectors = false',
    'enable_subagents = false',
    'enable_background_processes = false',
    'disabled_skills = ["*"]',
    'include_project_context = false',
    'include_commit_signature = false',
    'enable_file_autocomplete = false',
    'file_watcher_for_autocomplete = false',
    'enable_telemetry = false',
    'enable_update_checks = false',
    'experimental_enable_model_catalog = true',
    'enable_auto_update = false',
    'outside_workdir = "deny"',
    '[session_logging]',
    'generate_titles = false',
    '',
  ].join('\n');
}

function usageFromWire(value) {
  if (!value || typeof value !== 'object') return null;
  const counts = {
    inputTokens: reportedTokenCount(value.inputTokens ?? value.input_tokens),
    outputTokens: reportedTokenCount(value.outputTokens ?? value.output_tokens),
    totalTokens: reportedTokenCount(value.totalTokens ?? value.total_tokens),
    cachedInputTokens: reportedTokenCount(value.cachedReadTokens ?? value.cached_read_tokens),
    reasoningOutputTokens: null,
  };
  return Object.values(counts).some(count => count !== null) ? counts : null;
}
function cumulativeUsage(update) {
  const meta = update?._meta;
  if (!meta || !['promptTokens', 'completionTokens', 'totalTokens'].some(field => reportedTokenCount(meta[field]) !== null)) return null;
  return {
    inputTokens: reportedTokenCount(meta.promptTokens),
    outputTokens: reportedTokenCount(meta.completionTokens),
    totalTokens: reportedTokenCount(meta.totalTokens),
    cachedInputTokens: reportedTokenCount(meta.cachedTokens),
    reasoningOutputTokens: null,
  };
}
function usageDifference(after, before) {
  return tokenUsageMeasurement(Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningOutputTokens'].map(field => [
    field, after?.[field] !== null && after?.[field] !== undefined && before?.[field] !== null && before?.[field] !== undefined
      ? after[field] >= before[field] ? after[field] - before[field] : null : null,
  ])));
}

export class MistralVibeRuntime extends EventEmitter {
  constructor({ dataDir, workspaceDir, cliPath, env = process.env, platform = process.platform, connectionFactory, toolBridgeFactory = createVibeToolBridge, runTimeoutMs = null, providerIdleTimeoutMs = 120_000, catalogWaitMs = 8_000 } = {}) {
    super();
    if (!dataDir || !path.isAbsolute(dataDir)) throw vibeError('Mistral Vibe needs an absolute BLACKICE data directory.', 'INVALID_WORKSPACE');
    this.dataDir = dataDir;
    this.root = path.join(dataDir, 'mistral-vibe');
    this.workspaceDir = workspaceDir;
    this.cliPath = cliPath;
    this.env = env;
    this.platform = platform;
    this.connectionFactory = connectionFactory || (options => new VibeAcpConnection(options));
    this.toolBridgeFactory = toolBridgeFactory;
    this.runTimeoutMs = normalizeRunTimeout(runTimeoutMs);
    this.providerIdleTimeoutMs = providerIdleTimeoutMs;
    this.catalogWaitMs = Number.isSafeInteger(catalogWaitMs) && catalogWaitMs >= 0 ? Math.min(catalogWaitMs, 30_000) : 8_000;
    this.connections = new Set();
    this.runs = new Map();
    this.closed = false;
    this.info = {
      id: VIBE_PROVIDER_ID, name: 'Mistral Vibe Code', type: 'subscription-cli',
      installed: false, connected: false, authenticated: false, available: false,
      models: [], defaultModel: null, cliVersion: null, lastError: null, loginState: 'idle',
    };
  }

  status() { return clone({ ...this.info, busy: this.runs.size > 0, activeTurns: this.runs.size }); }
  _status(patch) { Object.assign(this.info, patch); this.emit('status', this.status()); return this.status(); }
  ownsThreadId(id) { return validId(id); }

  async _findCLI() {
    if (this.cliPath) { try { await fs.access(this.cliPath); return this.cliPath; } catch { return null; } }
    const exe = this.platform === 'win32' ? 'vibe-acp.exe' : 'vibe-acp';
    const home = this.env.USERPROFILE || this.env.HOME || os.homedir();
    const candidates = [path.join(home, '.local', 'bin', exe), ...String(this.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, exe))];
    for (const candidate of candidates) { try { await fs.access(candidate); return candidate; } catch {} }
    return null;
  }

  async init() {
    if (this.initialized) return this.status();
    this.initialized = true;
    try {
      await fs.mkdir(this.root, { recursive: true });
      this.command = await this._findCLI();
      const saved = await readJSON(path.join(this.root, 'catalog.json'), null);
      if (saved?.version === 1 && Array.isArray(saved.models) && typeof saved.defaultModel === 'string') {
        this.info.models = saved.models; this.info.defaultModel = saved.defaultModel; this.info.cliVersion = saved.cliVersion || null;
      }
      this._status({ installed: Boolean(this.command), lastError: this.command ? null : 'Install the official Mistral Vibe CLI to use this optional connection.' });
      // An unavailable optional CLI must never prevent BLACKICE from starting.
      if (this.command && saved?.version === 1 && Array.isArray(saved.models) && saved.models.length) this.refresh().catch(() => {});
    } catch (cause) { this._status({ lastError: safeVibeError(cause), available: false }); }
    return this.status();
  }

  async _connect({ home, cwd, onRequest } = {}) {
    if (this.closed) throw vibeError('Mistral Vibe has been closed.', 'MISTRAL_VIBE_CLOSED');
    this.command ||= await this._findCLI();
    if (!this.command) throw vibeError('Install the official Mistral Vibe CLI before connecting.', 'MISTRAL_VIBE_NOT_INSTALLED');
    const connection = this.connectionFactory({
      command: this.command, cwd, env: { ...this.env, ...(home ? { VIBE_HOME: home, VIBE_STRICT_CONFIG: '1' } : {}), PYTHONUNBUFFERED: '1' }, onRequest,
    });
    this.connections.add(connection);
    connection.once('exit', () => this.connections.delete(connection));
    return connection;
  }

  async _profile(directory, instructions = '', toolNames = []) {
    const home = path.join(directory, 'home'), cwd = path.join(directory, 'workspace');
    await Promise.all([fs.mkdir(path.join(home, 'agents'), { recursive: true }), fs.mkdir(path.join(home, 'prompts'), { recursive: true }), fs.mkdir(cwd, { recursive: true })]);
    await fs.writeFile(path.join(home, 'config.toml'), vibeIsolationConfig({ toolNames }), { mode: 0o600 });
    await fs.writeFile(path.join(home, 'agents', 'blackice.toml'), 'system_prompt_id = "blackice"\nsafety = "neutral"\n', { mode: 0o600 });
    await fs.writeFile(path.join(home, 'prompts', 'blackice.md'), [
      instructions,
      'You are Mistral Vibe Code running inside BLACKICE. Use the attached BLACKICE tools for authorized actions. Their results and policies are authoritative. No independent filesystem, terminal, browser, connector, skill, or subagent capability is available in this session.',
    ].filter(Boolean).join('\n\n'), { mode: 0o600 });
    return { home, cwd };
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this._refresh().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  async _nativeCatalogCache(home) {
    const file = path.join(home, 'model_catalog_cache.json');
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
      const cache = await readJSON(file, null);
      return nativeCatalogRecords(cache).length ? cache : null;
    } catch { return null; }
  }

  async _catalogSnapshot(connection, session, home, { signal, requireAccountCatalog = false } = {}) {
    const until = Date.now() + this.catalogWaitMs;
    const check = () => {
      if (signal?.aborted) throw stopError(signal);
      if (this.closed) throw vibeError('Mistral Vibe has been closed.', 'MISTRAL_VIBE_CLOSED');
    };
    const pause = async ms => { check(); await (signal ? awaitAbortable(sleep(ms), signal) : sleep(ms)); check(); };
    let cache;
    do {
      check();
      cache = await this._nativeCatalogCache(home);
      if (cache || Date.now() >= until) break;
      await pause(Math.min(100, Math.max(1, until - Date.now())));
    } while (true);
    if (requireAccountCatalog && !cache) throw vibeError('The fresh Mistral account catalog did not arrive within the discovery limit.', 'MISTRAL_VIBE_CATALOG_UNAVAILABLE');
    let complete = !cache;
    let configOptions = session.configOptions;
    const initialModel = configOptions?.find(option => option.id === 'model')?.currentValue;
    if (typeof initialModel !== 'string') throw vibeError('Vibe did not advertise its current model.', 'MISTRAL_VIBE_CATALOG');
    // ACP does not expose the CLI's ready/wait barrier and does not notify on
    // catalog arrival. A same-alias metadata selection returns its current view.
    for (let attempt = 0; attempt < 4; attempt++) {
      check();
      const response = await connection.request('session/set_config_option', {
        sessionId: session.sessionId, configId: 'model', value: initialModel,
      }, { timeoutMs: 10_000, signal });
      configOptions = response.configOptions || configOptions;
      const advertised = new Set(entries(configOptions?.find(option => option.id === 'model')?.options).map(option => option.value));
      const expected = accountModels(nativeCatalogRecords(cache)[0]).map(model => model.id);
      complete = Boolean(cache) && expected.length > 0 && expected.every(id => advertised.has(id));
      if (!cache || complete || Date.now() >= until) break;
      await pause(Math.min(200, Math.max(1, until - Date.now())));
      cache = await this._nativeCatalogCache(home);
    }
    check();
    if (requireAccountCatalog && !complete) throw vibeError('The native session did not expose the complete fresh account catalog before the discovery limit.', 'MISTRAL_VIBE_CATALOG_UNAVAILABLE');
    return { configOptions, cache };
  }

  async _refresh() {
    let connection, sessionId, profile, catalog, nativeBaseline, catalogStage = false, persistCatalog = false, catalogWarning = null;
    const previous = this.status();
    const previousIds = previous.models.map(model => model.id);
    const previousDefault = previous.defaultModel;
    // A new owned discovery home prevents an old or different-account cache from
    // satisfying Refresh. Ordinary Vibe homes and native run histories stay intact.
    const discoveryDirectory = path.join(this.root, 'catalog-discovery', randomUUID());
    try {
      this.command = await this._findCLI();
      if (!this.command) throw vibeError('Install the official Mistral Vibe CLI to use this optional connection.', 'MISTRAL_VIBE_NOT_INSTALLED');
      profile = await this._profile(discoveryDirectory);
      connection = await this._connect(profile);
      let observedWindow = null;
      connection.on('notification', message => {
        const update = message.params?.update;
        if (message.method === 'session/update' && update?.sessionUpdate === 'usage_update' && Number.isSafeInteger(update.size) && update.size > 0) observedWindow = update.size;
      });
      const initialized = await connection.initialize();
      const auth = await connection.request('_auth/status', {});
      this._status({ installed: true, connected: true, authenticated: auth.authenticated === true, cliVersion: initialized.agentInfo?.version || null, authState: auth.authState || null, lastError: null });
      if (!auth.authenticated) { this._status({ available: false, models: [], defaultModel: null }); return this.status(); }
      const session = await connection.request('session/new', { cwd: profile.cwd, mcpServers: [] }, { timeoutMs: 90_000 });
      sessionId = session.sessionId;
      nativeBaseline = vibeModelCatalog(session.configOptions, observedWindow);
      catalogStage = true;
      const resolved = await this._catalogSnapshot(connection, session, profile.home, { requireAccountCatalog: true });
      catalog = vibeAccountCatalog(resolved.configOptions, resolved.cache, previousIds);
      if (catalog.accountCatalogState !== 'available') throw vibeError('The account catalog identities did not match the native session.', 'MISTRAL_VIBE_CATALOG_UNAVAILABLE');
      const models = [];
      for (const model of catalog.models) {
        const response = await connection.request('session/set_config_option', { sessionId, configId: 'model', value: model.id }, { timeoutMs: 15_000 });
        const current = response.configOptions?.find(option => option.id === 'model')?.currentValue;
        if (current !== model.id) throw vibeError('Vibe did not confirm the requested model during discovery.', 'MISTRAL_VIBE_CATALOG');
        const own = vibeModelCatalog(response.configOptions).models.find(candidate => candidate.id === model.id);
        // Selection does not emit a model-correlated usage/window update. Keep the
        // account's maximum capacity separate from any initial usable-window size.
        const identity = { ...model };
        delete identity.supportedReasoningEfforts; delete identity.defaultReasoningEffort; delete identity.supportsReasoningSelection;
        models.push({
          ...identity,
          supportsReasoningSelection: own.supportsReasoningSelection === true,
          ...(own.supportedReasoningEfforts ? { supportedReasoningEfforts: own.supportedReasoningEfforts, defaultReasoningEffort: own.defaultReasoningEffort } : {}),
        });
      }
      catalog = { ...catalog, models, defaultModel: models.some(model => model.id === previousDefault) ? previousDefault : catalog.defaultModel };
      await connection.request('session/set_config_option', { sessionId, configId: 'model', value: catalog.defaultModel }, { timeoutMs: 15_000 });
      persistCatalog = true;
    } catch (cause) {
      if (catalogStage && !connection?.failure && !this.closed) {
        // Catalog/selection failure is not a sign-out. Keep confirmed choices and
        // never persist a partial or stale discovery over the durable catalog.
        const confirmed = previous.models.length ? { models: previous.models, defaultModel: previous.defaultModel } : nativeBaseline;
        catalog = { ...confirmed, accountCatalogState: previous.models.some(model => model.contextWindowSource === 'account-catalog') ? 'stale' : 'unavailable' };
        catalogWarning = 'The Mistral account model catalog could not be refreshed. Keeping confirmed models; Refresh retries discovery. ' + safeVibeError(cause);
      } else {
        if (!this.closed) this._status({ installed: Boolean(this.command), connected: false, available: false, lastError: safeVibeError(cause) });
        throw cause;
      }
    } finally {
      if (sessionId) await connection.request('session/close', { sessionId }, { timeoutMs: 10_000 }).catch(() => {});
      if (connection) { await connection.close(); this.connections.delete(connection); }
      if (profile) await fs.rm(discoveryDirectory, { recursive: true, force: true }).catch(() => {});
    }
    if (this.closed) throw vibeError('Mistral Vibe has been closed.', 'MISTRAL_VIBE_CLOSED');
    // Publish only after the owned metadata session has settled.
    if (persistCatalog) await atomicJSON(path.join(this.root, 'catalog.json'), { version: 1, ...catalog, cliVersion: this.info.cliVersion, observedAt: now() });
    if (this.closed) throw vibeError('Mistral Vibe has been closed.', 'MISTRAL_VIBE_CLOSED');
    this._status({ ...catalog, connected: true, available: true, lastError: catalogWarning });
    return this.status();
  }

  beginLogin() {
    if (this.loginStartPromise) return this.loginStartPromise;
    this.loginStartPromise = this._beginLogin().finally(() => { this.loginStartPromise = null; });
    return this.loginStartPromise;
  }

  async _beginLogin() {
    if (this.login?.state === 'waiting' && Date.now() < this.login.expiresAt) return { url: this.login.url, state: 'waiting' };
    this._status({ loginState: 'starting', lastError: null });
    let connection;
    try {
      const cwd = path.join(this.root, 'auth-workspace');
      await fs.mkdir(cwd, { recursive: true });
      connection = await this._connect({ cwd });
      const initialized = await connection.initialize();
      const auth = await connection.request('_auth/status', {});
      this._status({ installed: true, connected: true, authenticated: auth.authenticated === true, cliVersion: initialized.agentInfo?.version || null });
      if (auth.authenticated) {
        await connection.close(); this.connections.delete(connection);
        await this.refresh();
        this._status({ loginState: 'complete' });
        return { url: null, state: 'complete' };
      }
      if (!initialized.authMethods?.some(method => method.id === 'browser-auth-delegated')) throw vibeError('This installed Vibe CLI does not support delegated browser sign-in. Update the official CLI.', 'MISTRAL_VIBE_LOGIN_UNSUPPORTED');
      const response = await connection.request('authenticate', { methodId: 'browser-auth-delegated', _meta: { action: 'start', signInTarget: 'mistral' } });
      const attempt = response?._meta?.['browser-auth-delegated'];
      const url = new URL(attempt?.signInUrl);
      if (url.protocol !== 'https:' || !OFFICIAL_AUTH_HOSTS.has(url.hostname) || url.username || url.password) throw vibeError('Vibe returned an unsupported sign-in destination.', 'MISTRAL_VIBE_LOGIN_URL');
      const expiresAt = Date.parse(attempt.expiresAt);
      if (!attempt.attemptId || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw vibeError('Vibe returned an invalid sign-in attempt.', 'MISTRAL_VIBE_LOGIN_PROTOCOL');
      const login = this.login = { state: 'waiting', url: url.href, expiresAt, connection };
      this._status({ loginState: 'waiting' });
      login.promise = this._completeLogin(connection, attempt, login);
      // Completion is owned by this runtime; the caller only opens the URL.
      login.promise.catch(() => {});
      return { url: login.url, state: 'waiting' };
    } catch (cause) {
      if (connection) { await connection.close(); this.connections.delete(connection); }
      this._status({ loginState: 'error', lastError: safeVibeError(cause) });
      throw cause;
    }
  }

  async _completeLogin(connection, attempt, login) {
    try {
      while (!this.closed && Date.now() < login.expiresAt) {
        try {
          await connection.request('authenticate', { methodId: 'browser-auth-delegated', _meta: { action: 'complete', attemptId: attempt.attemptId } }, { timeoutMs: Math.max(1000, login.expiresAt - Date.now()) });
          const auth = await connection.request('_auth/status', {});
          if (!auth.authenticated) throw vibeError('Vibe did not confirm authenticated credentials.', 'MISTRAL_VIBE_LOGIN_PROTOCOL');
          login.state = 'complete'; delete login.url;
          this._status({ authenticated: true, authState: auth.authState, loginState: 'complete', lastError: null });
          await connection.close(); this.connections.delete(connection);
          await this.refresh();
          return;
        } catch (cause) {
          // The official controller retains the attempt for transient polling or
          // exchange failures. Do not discard it while the user is authorizing.
          if (connection.failure || !/status could not be retrieved|exchange|poll/i.test(cause.message) || Date.now() >= login.expiresAt - 2000) throw cause;
          await sleep(1500);
        }
      }
      throw vibeError('The Mistral Vibe sign-in attempt expired. Start sign-in again.', 'MISTRAL_VIBE_LOGIN_EXPIRED');
    } catch (cause) {
      login.state = 'error'; delete login.url;
      this._status({ loginState: 'error', lastError: safeVibeError(cause) });
      throw cause;
    } finally {
      await connection.close(); this.connections.delete(connection);
    }
  }

  _threadFile(id) {
    if (!validId(id)) throw vibeError('The saved Mistral Vibe conversation ID is invalid.', 'INVALID_THREAD');
    return path.join(this.root, 'threads', id, 'thread.json');
  }
  async _readThread(id) {
    const record = await readJSON(this._threadFile(id), null);
    if (record?.version !== 1 || record.id !== id || typeof record.nativeSessionId !== 'string' || typeof record.model !== 'string') throw vibeError('This BLACKICE-owned Vibe conversation is unavailable. Start from the saved BLACKICE conversation context.', 'MISTRAL_VIBE_THREAD_MISSING');
    return record;
  }
  async savedThreadModel(id) { return (await this._readThread(id)).model; }
  async _saveThread(record) { record.updatedAt = now(); await atomicJSON(this._threadFile(record.id), record); }

  _emitRun(state, event) {
    if (event.type === 'delta' && state.inputImages?.length && !state.safeImageDelta) return;
    const payload = redactInputImageData({ ...event, threadId: state.record.id, turnId: state.turnId, at: now() }, state.inputImages || []);
    state.options.onEvent?.(payload);
    this.emit('event', payload);
  }

  _context(state) {
    const snapshot = contextSnapshot({
      options: state.contextOptions,
      modelWindowTokens: state.observedWindow || state.model.contextWindowTokens || null,
      modelWindowSource: state.observedWindow ? 'runtime-reported' : state.model.contextWindowSource || 'runtime-reported',
      messages: [state.options.developerInstructions || '', state.pendingPrompt || state.options.prompt],
      tools: state.options.dynamicTools || [],
    });
    if (Number.isFinite(state.observedContext) && state.observedContext >= 0) {
      snapshot.estimatedInputTokens = state.observedContext;
      snapshot.estimateMethod = 'Active conversation context reported by Mistral Vibe';
      snapshot.remainingTokens = Math.max(0, snapshot.inputBudgetTokens - state.observedContext);
      snapshot.remainingIsEstimate = false;
    }
    if (state.model.contextWindowSource === 'account-catalog') {
      snapshot.remainingTokens = null;
      snapshot.remainingIsEstimate = true;
      snapshot.estimateMethod += '; account catalog maximum is capacity only and native remaining context is unknown';
    }
    state.context = snapshot;
    return snapshot;
  }

  _notification(state, message) {
    if (message.method !== 'session/update') return;
    const { sessionId, update } = message.params || {};
    if (!update || state.nativeSessionId && sessionId !== state.nativeSessionId) return;
    if (update.sessionUpdate === 'usage_update') {
      if (state.model.contextWindowSource !== 'account-catalog' && Number.isSafeInteger(update.size) && update.size > 0) state.observedWindow = update.size;
      if (Number.isFinite(update.used) && update.used >= 0) state.observedContext = update.used;
      const cumulative = cumulativeUsage(update);
      if (cumulative) state.nativeTotals = cumulative;
      if (state.nativeSessionId) this._emitRun(state, { type: 'context', context: this._context(state) });
      return;
    }
    if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
      if (!state.acceptUpdates) return;
      const previous = state.permissionTools.get(update.toolCallId) || {};
      state.permissionTools.set(update.toolCallId, { ...previous, ...update, _meta: { ...previous._meta, ...update._meta } });
      return;
    }
    if (update.sessionUpdate !== 'agent_message_chunk' || !state.acceptUpdates || update.content?.type !== 'text') return;
    const itemId = update.messageId || state.defaultMessageId;
    let item = state.messages.get(itemId);
    if (!item) { item = { id: itemId, text: '' }; state.messages.set(itemId, item); }
    item.text += update.content.text || '';
    this._emitRun(state, { type: 'delta', delta: update.content.text || '', itemId });
  }

  async _permission(state, method, params) {
    if (method !== 'session/request_permission') throw Object.assign(vibeError('BLACKICE does not provide native Vibe filesystem or terminal access.', 'MISTRAL_VIBE_NATIVE_TOOL_DENIED'), { rpcCode: -32601 });
    const id = params.toolCall?.toolCallId;
    const tool = state.permissionTools.get(id);
    const toolName = tool?._meta?.tool_name || id;
    const allowed = state.acceptUpdates && !state.controller.signal.aborted && params.sessionId === state.nativeSessionId && state.bridge?.toolNames?.has(toolName);
    const option = params.options?.find(option => option.kind === (allowed ? 'allow_once' : 'reject_once'));
    if (!allowed && state.acceptUpdates) state.deniedNativeTool = true;
    return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
  }

  async runAgent(options = {}) {
    const prompt = options.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) throw vibeError('An agent prompt is required.', 'INVALID_PROMPT');
    if (!options.cwd || !path.isAbsolute(options.cwd)) throw vibeError('Agent workspace must be an absolute path.', 'INVALID_WORKSPACE');
    if (options.developerInstructions !== undefined && typeof options.developerInstructions !== 'string') throw vibeError('Developer instructions must be text.', 'INVALID_INSTRUCTIONS');
    if (options.sandbox !== undefined && !['read-only', 'workspace-write', 'danger-full-access'].includes(options.sandbox)) throw vibeError('Choose a valid agent sandbox.', 'INVALID_SANDBOX');
    validateResponseOnlyOptions(options);
    const outputSchema = normalizeOutputSchema(options.outputSchema);
    const inputImages = normalizeInputImages(options.inputImages);
    if (inputImages.length && !options.responseOnly) throw vibeError('Initial image evidence is supported only in fresh analytical response sessions.', 'INVALID_INPUT_IMAGES');
    if (options.signal?.aborted) throw stopError(options.signal);
    if (options.serviceTier != null && !['default', 'standard'].includes(options.serviceTier)) throw vibeError('The Vibe CLI does not advertise that service tier.', 'INVALID_SERVICE_TIER');
    if (options.onBeforeFinal !== undefined && typeof options.onBeforeFinal !== 'function') throw vibeError('The final-response callback must be a function.', 'INVALID_FINAL_REVIEW');
    const runTimeout = normalizeRunTimeout(options.timeoutMs === undefined ? this.runTimeoutMs : options.timeoutMs);
    const idleTimeout = options.providerIdleTimeoutMs ?? this.providerIdleTimeoutMs;
    if (idleTimeout !== null && (!Number.isSafeInteger(idleTimeout) || idleTimeout <= 0)) throw vibeError('Provider idle timeout must be null or a positive whole number of milliseconds.', 'INVALID_PROVIDER_IDLE_TIMEOUT');
    if (options.dynamicTools !== undefined && !Array.isArray(options.dynamicTools)) throw vibeError('Attached tools must be an array.', 'INVALID_TOOLS');
    const contextOptions = normalizeContextOptions(options.context || {});
    if (!contextOptions.autoCompact || contextOptions.preset !== 'model' || contextOptions.compactAtTokens !== undefined || contextOptions.keepRecentTokens !== undefined) throw vibeError('The installed Vibe CLI uses its model context window and native automatic history management. Choose Model default and automatic context management; custom history thresholds are not exposed by this connection.', 'MISTRAL_VIBE_CONTEXT_UNSUPPORTED');
    if (options.continuity && (options.threadId || typeof options.continuity.text !== 'string' || !options.continuity.text.trim())) throw vibeError('Saved continuity requires a new session and historical text.', 'INVALID_CONTEXT');
    if (!this.info.available) await this.refresh();
    if (!this.info.authenticated) throw vibeError('Sign in to Mistral Vibe Code before starting an agent.', 'MISTRAL_VIBE_UNAUTHENTICATED');
    const rawModel = options.model || this.info.defaultModel;
    const model = this.info.models.find(candidate => candidate.id === rawModel);
    if (!model) throw vibeError('Choose an exact model advertised by the installed Vibe CLI.', 'MISTRAL_VIBE_MODEL');
    assertInputImagesSupported(inputImages, model);
    const record = options.threadId ? await this._readThread(options.threadId) : {
      version: 1, id: VIBE_THREAD_PREFIX + randomUUID(), model: qualified(rawModel), nativeSessionId: null, cwd: path.resolve(options.cwd),
      state: 'new', usage: emptyTokenUsage(), nativeUsageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: null }, createdAt: now(),
    };
    const workspaceKey = value => { const resolved = typeof value === 'string' && path.isAbsolute(value) ? path.resolve(value) : null; return resolved && this.platform === 'win32' ? resolved.toLowerCase() : resolved; };
    if (options.threadId && workspaceKey(record.cwd) !== workspaceKey(options.cwd)) throw vibeError('A saved Vibe conversation is bound to its original BLACKICE workspace. Start a new conversation for a different workspace.', 'MISTRAL_VIBE_THREAD_WORKSPACE');
    if (record.model !== qualified(rawModel)) throw vibeError('A saved Vibe conversation keeps its original model. Start a new conversation to change it.', 'MISTRAL_VIBE_THREAD_MODEL');
    if (['running', 'uncertain'].includes(record.state)) throw vibeError('The last native Vibe turn was not confirmed. Its BLACKICE history is preserved; continue from saved context in a new native session instead of replaying the uncertain prompt.', 'MISTRAL_VIBE_TURN_UNCERTAIN');
    if (this.runs.has(record.id)) throw vibeError('This Vibe conversation already has an active turn.', 'MISTRAL_VIBE_BUSY');
    const chosenEffort = options.effort === 'default' || options.effort === undefined ? record.effort || model.defaultReasoningEffort : options.effort;
    if (chosenEffort && !model.supportedReasoningEfforts?.some(option => option.reasoningEffort === chosenEffort)) throw vibeError('That reasoning level is not advertised by the installed Vibe model.', 'INVALID_EFFORT');
    const state = {
      record, options, model, contextOptions, inputImages, controller: new AbortController(), turnId: 'vibe_turn_' + randomUUID(),
      messages: new Map(), permissionTools: new Map(), usage: emptyTokenUsage(), steering: [], acceptingSteer: true,
      observedContext: record.observedContext, observedWindow: model.contextWindowSource === 'account-catalog' ? null : model.contextWindowTokens, nativeTotals: null,
      acceptUpdates: false, prompted: false, deniedNativeTool: false, pendingPrompt: prompt,
    };
    state.settled = new Promise(resolve => { state.resolveSettled = resolve; });
    this.runs.set(record.id, state);
    this.emit('status', this.status());
    const abort = () => state.controller.abort(stopError(options.signal));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const deadline = startRunDeadline(runTimeout, () => state.controller.abort(vibeError('The Vibe run exceeded its configured time limit.', 'RUN_TIMEOUT')));
    let idleTimer;
    const armIdle = () => {
      clearTimeout(idleTimer);
      if (idleTimeout !== null && state.acceptUpdates) idleTimer = setTimeout(() => {
        if (!state.toolActive) state.controller.abort(vibeError('Mistral Vibe stopped producing protocol activity.', 'PROVIDER_IDLE_TIMEOUT'));
        else armIdle();
      }, idleTimeout);
    };
    state.controller.signal.addEventListener('abort', () => {
      this._emitRun(state, { type: 'turn', status: 'cancelling' });
      try { if (state.nativeSessionId) state.connection?.notify('session/cancel', { sessionId: state.nativeSessionId }); } catch {}
    }, { once: true });
    try {
      if (state.controller.signal.aborted) throw stopError(state.controller.signal);
      const tools = options.responseOnly ? [] : options.dynamicTools || [];
      if (tools.length && typeof options.onToolCall !== 'function') throw vibeError('BLACKICE must handle every attached Vibe tool.', 'INVALID_TOOLS');
      if (tools.length) state.bridge = await this.toolBridgeFactory({
        tools, signal: state.controller.signal,
        onToolCall: async (...args) => { state.toolActive = (state.toolActive || 0) + 1; try { return await options.onToolCall(...args); } finally { state.toolActive--; armIdle(); } },
        onEvent: event => this._emitRun(state, event),
      });
      const instructions = [
        options.developerInstructions || '',
        outputSchema ? 'Return a JSON value matching this response schema. BLACKICE validates the final output against the schema; no provider-native schema enforcement is claimed.\n' + JSON.stringify(outputSchema) : '',
      ].filter(Boolean).join('\n\n');
      const profile = await this._profile(path.join(this.root, 'threads', record.id), instructions, state.bridge ? [...state.bridge.toolNames] : []);
      state.connection = await this._connect({ ...profile, onRequest: (method, params) => this._permission(state, method, params) });
      state.connection.on('notification', message => this._notification(state, message));
      state.connection.on('activity', armIdle);
      const initialized = await state.connection.initialize({ signal: state.controller.signal });
      if (inputImages.length && initialized.agentCapabilities?.promptCapabilities?.image !== true) throw vibeError('The installed Vibe ACP agent did not advertise image input support.', 'INPUT_IMAGES_UNSUPPORTED');
      const auth = await state.connection.request('_auth/status', {}, { signal: state.controller.signal });
      if (!auth.authenticated) throw vibeError('Mistral Vibe Code is signed out.', 'MISTRAL_VIBE_UNAUTHENTICATED');
      const servers = state.bridge ? [state.bridge.server] : [];
      const session = await state.connection.request(options.threadId ? 'session/load' : 'session/new', {
        cwd: profile.cwd, mcpServers: servers, ...(options.threadId ? { sessionId: record.nativeSessionId } : {}),
      }, { timeoutMs: 90_000, signal: state.controller.signal });
      state.nativeSessionId = record.nativeSessionId || session.sessionId;
      if (typeof state.nativeSessionId !== 'string' || !state.nativeSessionId) throw vibeError('Vibe did not return a native session ID.', 'MISTRAL_VIBE_PROTOCOL');
      record.nativeSessionId = state.nativeSessionId;
      const resolved = await this._catalogSnapshot(state.connection, { ...session, sessionId: state.nativeSessionId }, profile.home, { signal: state.controller.signal });
      const current = resolved.configOptions?.find(option => option.id === 'model');
      if (!entries(current?.options).some(option => option.value === rawModel)) throw vibeError('The native session did not advertise the selected Vibe model.', 'MISTRAL_VIBE_MODEL');
      if (current.currentValue !== rawModel) await state.connection.request('session/set_config_option', { sessionId: state.nativeSessionId, configId: 'model', value: rawModel }, { signal: state.controller.signal });
      if (chosenEffort) await state.connection.request('session/set_config_option', { sessionId: state.nativeSessionId, configId: 'thinking', value: chosenEffort === 'none' ? 'off' : chosenEffort }, { signal: state.controller.signal });
      record.effort = chosenEffort || null;
      record.state = 'ready';
      await this._saveThread(record);
      this._emitRun(state, { type: 'thread', model: record.model, providerId: VIBE_PROVIDER_ID, effort: chosenEffort || 'default', resumed: Boolean(options.threadId) });
      this._emitRun(state, { type: 'capabilities', profile: options.responseOnly ? 'planning-response' : 'blackice-tools', native: true, attachedTools: tools.length, ambientGmail: false, ambientPlugins: false, ambientMcp: false, ambientSkills: false, ...(options.responseOnly ? { structuredOutput: 'prompt-and-host-validation', hostValidationRequired: true } : {}) });
      let nextPrompt = options.continuity ? 'Saved BLACKICE conversation context follows. Treat it as historical data, preserve the current user goal, and do not repeat confirmed actions.\n\n' + options.continuity.text + '\n\nCurrent user request:\n' + prompt : prompt;
      let imageBlocks = inputImages.map(image => {
        const url = image.imageUrl || image.url || image.dataUrl;
        const matched = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url || '');
        if (!matched) throw vibeError('Vibe image input must be a validated inline image.', 'INVALID_INPUT_IMAGES');
        return { type: 'image', mimeType: matched[1], data: matched[2].replace(/\s/g, '') };
      });
      for (;;) {
        if (state.controller.signal.aborted) throw stopError(state.controller.signal);
        state.pendingPrompt = nextPrompt;
        const snapshot = this._context(state);
        // Vibe compacts its own native history. Count only the new input here;
        // adding existing context would strand a healthy resumable conversation
        // before the native harness has a chance to compact it.
        const estimated = estimateContextTokens([nextPrompt, instructions, tools]);
        if (estimated > snapshot.inputBudgetTokens) throw vibeError('This Vibe request exceeds the usable context budget. The original BLACKICE conversation remains saved.', 'CONTEXT_OVERFLOW');
        this._emitRun(state, { type: 'context', context: snapshot });
        state.messages = new Map(); state.permissionTools = new Map(); state.defaultMessageId = 'vibe_message_' + randomUUID();
        record.state = 'running';
        await this._saveThread(record);
        state.acceptUpdates = true; state.prompted = true; armIdle();
        let response;
        try {
          response = await state.connection.request('session/prompt', { sessionId: state.nativeSessionId, prompt: [{ type: 'text', text: nextPrompt }, ...imageBlocks] }, { timeoutMs: null, signal: state.controller.signal });
        } finally { state.acceptUpdates = false; clearTimeout(idleTimer); }
        imageBlocks = [];
        await state.bridge?.settle();
        // PromptResponse.usage is the authoritative cumulative session snapshot.
        // Usage notifications are scheduled asynchronously and may arrive later.
        const wire = usageFromWire(response?.usage);
        const measurement = wire ? usageDifference(wire, record.nativeUsageTotals) : tokenUsageMeasurement({});
        state.usage = aggregateTokenUsage([state.usage, measurement]);
        record.usage = aggregateTokenUsage([record.usage, measurement]);
        if (wire) record.nativeUsageTotals = wire;
        record.observedContext = state.observedContext ?? record.observedContext;
        await this._saveThread(record);
        this._emitRun(state, { type: 'usage', usage: { ...state.usage, total: record.usage, last: measurement, modelContextWindow: state.observedWindow || null } });
        if (state.controller.signal.aborted) throw stopError(state.controller.signal);
        if (state.deniedNativeTool) throw vibeError('Vibe requested a tool outside the attached BLACKICE bridge. The request was denied.', 'MISTRAL_VIBE_NATIVE_TOOL_DENIED');
        if (response?.stopReason !== 'end_turn') throw vibeError('Vibe ended without a completed response (' + (response?.stopReason || 'unknown') + ').', response?.stopReason === 'cancelled' ? 'ABORTED' : 'MISTRAL_VIBE_INCOMPLETE');
        const messages = [...state.messages.values()].filter(item => item.text);
        const final = messages.at(-1) || { id: state.defaultMessageId, text: '' };
        for (const message of messages.slice(0, -1)) this._emitRun(state, { type: 'message', itemId: message.id, text: message.text, phase: 'commentary' });
        const output = redactInputImageData(final.text, inputImages);
        if (inputImages.length && output) {
          state.safeImageDelta = true;
          try { this._emitRun(state, { type: 'delta', itemId: final.id, delta: output }); } finally { state.safeImageDelta = false; }
        }
        let review = null;
        if (options.onBeforeFinal) review = await awaitAbortable(options.onBeforeFinal({ output, threadId: record.id, turnId: state.turnId, usage: state.usage }), state.controller.signal);
        if (state.controller.signal.aborted) throw stopError(state.controller.signal);
        if (review != null && (typeof review !== 'object' || review.continue !== true || typeof review.prompt !== 'string' || !review.prompt.trim() || review.prompt.length > 50_000)) throw vibeError('The final review returned an invalid continuation prompt.', 'INVALID_FINAL_REVIEW');
        const steering = state.steering.splice(0);
        if (review?.continue || steering.length) {
          if (output) this._emitRun(state, { type: 'message', itemId: final.id, text: output, phase: 'commentary' });
          nextPrompt = [...steering, ...(review?.continue ? [review.prompt] : [])].join('\n\n');
          this._emitRun(state, { type: 'planning.continuation', reason: steering.length ? 'user-direction' : 'review' });
          continue;
        }
        state.acceptingSteer = false;
        record.state = 'ready';
        await this._saveThread(record);
        if (state.controller.signal.aborted) throw stopError(state.controller.signal);
        if (output) this._emitRun(state, { type: 'message', itemId: final.id, text: output, phase: 'final_answer' });
        this._emitRun(state, { type: 'turn', status: 'completed' });
        return { output, threadId: record.id, turnId: state.turnId, usage: state.usage, context: this._context(state), effort: chosenEffort || 'default', model: record.model, providerId: VIBE_PROVIDER_ID };
      }
    } catch (cause) {
      state.acceptingSteer = false;
      if (record.nativeSessionId) { record.state = state.prompted ? 'uncertain' : 'ready'; await this._saveThread(record).catch(() => {}); }
      throw cause;
    } finally {
      deadline(); clearTimeout(idleTimer); options.signal?.removeEventListener('abort', abort);
      // Cancellation is a request, not proof that an admitted mutation settled.
      // Keep the turn lease and every receipt until the bridge callbacks finish.
      try {
        await state.bridge?.close();
      } finally {
        try {
          if (state.connection) {
            if (state.nativeSessionId) await state.connection.request('session/close', { sessionId: state.nativeSessionId }, { timeoutMs: 10_000 }).catch(() => {});
            // A cancelled prompt can report real usage while its admitted tools
            // settle. Keep positive observed deltas without inventing zero usage.
            if (state.prompted && state.nativeTotals && record.nativeUsageTotals) {
              const observed = usageDifference(state.nativeTotals, record.nativeUsageTotals);
              if (['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens'].some(field => observed[field] > 0)) {
                state.usage = aggregateTokenUsage([state.usage, observed]);
                record.usage = aggregateTokenUsage([record.usage, observed]);
                record.nativeUsageTotals = state.nativeTotals;
                await this._saveThread(record);
                this._emitRun(state, { type: 'usage', duringSettlement: true, usage: { ...state.usage, total: record.usage, last: observed, modelContextWindow: state.observedWindow || null } });
              }
            }
            await state.connection.close(); this.connections.delete(state.connection);
          }
        } finally { this.runs.delete(record.id); state.resolveSettled(); this.emit('status', this.status()); }
      }
    }
  }

  async steerAgent(threadId, text) {
    const state = this.runs.get(threadId);
    if (!state?.acceptingSteer || state.controller.signal.aborted) throw vibeError('This Vibe conversation has no active turn accepting direction.', 'NO_ACTIVE_TURN');
    if (typeof text !== 'string' || !text.trim() || text.length > 50_000) throw vibeError('A nonempty direction under 50,000 characters is required.', 'INVALID_PROMPT');
    state.steering.push(text);
    return { threadId, queued: true };
  }
  async compactThread(threadId) {
    await this._readThread(threadId);
    throw vibeError('Manual compaction is not exposed by this Vibe ACP integration. Native automatic context management remains active, and BLACKICE history is preserved.', 'MISTRAL_VIBE_COMPACTION_UNAVAILABLE');
  }
  async close() {
    this.closed = true;
    for (const state of this.runs.values()) state.controller.abort(vibeError('BLACKICE is closing this Vibe run.', 'ABORTED'));
    const settling = [...this.runs.values()].map(state => state.settled);
    await Promise.allSettled([...this.connections].map(connection => connection.close()));
    await Promise.allSettled(settling);
    if (this.refreshPromise) await Promise.allSettled([this.refreshPromise]);
    this.connections.clear();
    this._status({ connected: false, available: false });
  }
}
