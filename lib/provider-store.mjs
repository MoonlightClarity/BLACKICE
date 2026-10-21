import { mkdir, readFile, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeContextOptions } from './context.mjs';
import { RETIRED_CHAT_MODE_MODEL, retiredChatModeError } from './retired-models.mjs';
import { getProviderPreset, providerRequiresApiKey } from '../public/provider-catalog.mjs';

const TYPES = new Set(['openai', 'anthropic', 'compatible']);
const DEFAULT_URLS = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1', compatible: 'http://127.0.0.1:11434/v1' };
const fail = message => { const error = new Error(message); error.code = 'INVALID_PROVIDER'; return error; };
export function normalizeProviderHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 40) throw fail('Custom headers must contain at most 40 text values.');
  const headers = {}, seen = new Set();
  for (const [name, content] of Object.entries(value)) {
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]{1,100}$/i.test(name) || seen.has(lower)) throw fail('Use valid, unique HTTP header names.');
    if (/^(host|connection|content-length|transfer-encoding|accept|content-type|cookie|set-cookie)$/i.test(name)) throw fail('That header is managed by Relay. Use an authentication or gateway-specific header.');
    if (typeof content !== 'string' || !content || content.length > 20000 || /[\r\n\x00]/.test(content)) throw fail('Custom header values must be nonempty, single-line text.');
    seen.add(lower); headers[name] = content;
  }
  return headers;
}
export async function atomicJSON(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { const handle = await open(temporary, 'wx', 0o600); try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); } await rename(temporary, file); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}
export function normalizeDefaultModel(value) {
  if (value === null || value === 'default') return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 400 || /[\x00-\x20\x7f]/.test(value)) throw fail('Choose a valid default model.');
  const parts = value.split('::');
  if (parts.length > 2 || parts.length === 2 && (!/^[a-z][a-z0-9_-]{0,39}$/.test(parts[0]) || parts[0] === 'codex' || !parts[1] || parts[1].length > 256)) throw fail('Choose a valid default model.');
  return value;
}
export function normalizeCodexModelId(value) {
  const model = normalizeDefaultModel(value);
  if (!model || model === 'codex' || model.includes('::')) throw fail('Enter an exact native Codex model ID, without spaces or a provider prefix.');
  return model;
}
export function normalizeProvider(input, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('A provider configuration is required.');
  const id = input.id ?? previous.id;
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(id) || ['codex', 'default', 'provider'].includes(id)) throw fail('Provider ID must start with a letter and contain up to 40 lowercase letters, numbers, underscores, or hyphens.');
  const presetId = input.preset === null ? undefined : input.preset ?? previous.preset, preset = presetId === undefined ? null : getProviderPreset(presetId);
  if (presetId !== undefined && !preset) throw fail('Choose a supported connection preset.');
  const type = input.type ?? previous.type ?? preset?.type;
  if (!TYPES.has(type)) throw fail('Choose OpenAI, Anthropic, or an OpenAI-compatible provider.');
  if (preset && preset.id !== 'compatible' && preset.type !== type) throw fail('The connection preset does not match its API protocol.');
  const name = String(input.name ?? previous.name ?? preset?.name ?? id).trim();
  if (!name || name.length > 100) throw fail('Provider name must contain 1 to 100 characters.');
  let url;
  try { url = new URL(input.baseUrl ?? previous.baseUrl ?? (preset?.baseUrl || DEFAULT_URLS[type])); } catch { throw fail('Provider address must be an HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw fail('Provider address must be HTTP or HTTPS, with no credentials or fragment.');
  if ([...url.searchParams].some(([name, value]) => /(?:api[-_]?key|token|secret|password|signature|^sig$|^key$|^authorization$)/i.test(name) || name.length > 100 || value.length > 4000) || url.search.length > 8000) throw fail('Keep credentials out of the provider URL. Put API keys or tokens in the API key field or custom headers.');
  url.pathname = url.pathname.replace(/\/+$/, '');
  const models = input.models ?? previous.models ?? [];
  if (!Array.isArray(models) || models.length > 200) throw fail('Enter up to 200 model IDs.');
  const normalizedModels = models.map(model => {
    const item = typeof model === 'string' ? { id: model } : model;
    if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 256 || /[\r\n\x00]/.test(item.id) || item.id.includes('::')) throw fail('Each model needs a valid model ID of up to 256 characters.');
    const contextWindowTokens = item.contextWindowTokens ?? item.context_window ?? item.context_length;
    if (contextWindowTokens !== undefined && (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 4096 || contextWindowTokens > 4000000)) throw fail('Model context window must be an integer from 4,096 to 4,000,000 tokens.');
    return { id: item.id.trim(), displayName: String(item.displayName || item.name || item.id).slice(0, 160), ...(contextWindowTokens ? { contextWindowTokens, contextWindowSource: item.contextWindowSource === 'provider-reported' ? 'provider-reported' : 'user-configured' } : {}), ...(typeof item.supportsTools === 'boolean' ? { supportsTools: item.supportsTools } : {}), ...(Number.isSafeInteger(item.maxOutputTokens) && item.maxOutputTokens > 0 && item.maxOutputTokens <= 4000000 ? { maxOutputTokens: item.maxOutputTokens } : {}), ...(['inputModalities','outputModalities'].reduce((result, key) => { if (Array.isArray(item[key]) && item[key].length <= 20 && item[key].every(value => typeof value === 'string' && value.length <= 40)) result[key] = [...item[key]]; return result; }, {})) };
  });
  const number = (key, fallback, min, max) => {
    const value = input[key] ?? previous[key] ?? fallback;
    if (!Number.isInteger(value) || value < min || value > max) throw fail(`${key} must be an integer from ${min} to ${max}.`);
    return value;
  };
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 20000 || /[\r\n\x00]/.test(input.apiKey))) throw fail('API key must be a single-line string.');
  // Saved budgets remain explicit choices. New connections have no application step limit.
  const maxSteps = input.maxSteps !== undefined ? input.maxSteps : previous.maxSteps !== undefined ? previous.maxSteps : null;
  if (maxSteps !== null && (!Number.isSafeInteger(maxSteps) || maxSteps < 1)) throw fail('Maximum steps must be a positive whole number, or null for no application limit.');
  return { id, type, name, ...(presetId ? { preset: presetId } : {}), baseUrl: url.origin + url.pathname.replace(/\/+$/, '') + url.search, models: [...new Map(normalizedModels.map(model => [model.id, model])).values()], enabled: input.enabled === undefined ? previous.enabled !== false : Boolean(input.enabled), maxSteps, maxTokens: number('maxTokens', 8192, 1, 128000), ...((input.context ?? previous.context) ? { context: normalizeContextOptions(input.context ?? previous.context) } : {}), updatedAt: new Date().toISOString() };
}

/** Keys are never returned through public config and never written as plaintext. */
export class ProviderStore {
  constructor({ dataDir, encryptSecret, decryptSecret, explicitRoutes = [] } = {}) {
    if (!dataDir) throw new Error('Provider storage directory is required.');
    this.dataDir = dataDir; this.file = path.join(dataDir, 'providers.json');
    this.encryptSecret = encryptSecret; this.decryptSecret = decryptSecret;
    this.configs = new Map(); this.keys = new Map(); this.headers = new Map(); this.redactionKeys = new Set(); this.ready = null; this.writes = Promise.resolve();
    this.defaultModel = null; this.automaticDefaultModel = null; this.customCodexModels = []; this.mutations = Promise.resolve();
    if (!Array.isArray(explicitRoutes) || explicitRoutes.some(value => !normalizeDefaultModel(value)?.includes('::'))) throw fail('Built-in routes must use explicit provider model identifiers.');
    this.explicitRoutes = new Set(explicitRoutes);
  }
  async init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      let parsed;
      try { parsed = JSON.parse(await readFile(this.file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return; throw new Error('Provider settings could not be read. Restore a valid providers.json file.'); }
      if (parsed.version !== 1 || !Array.isArray(parsed.providers)) throw new Error('Provider settings use an unsupported format.');
      this.defaultModel = parsed.defaultModel === undefined ? null : normalizeDefaultModel(parsed.defaultModel);
      this.automaticDefaultModel = parsed.automaticDefaultModel === undefined ? null : normalizeDefaultModel(parsed.automaticDefaultModel);
      if (parsed.customCodexModels !== undefined && !Array.isArray(parsed.customCodexModels)) throw new Error('Custom Codex model settings must be a list of model IDs.');
      this.customCodexModels = [...new Set((parsed.customCodexModels || []).map(normalizeCodexModelId))];
      for (const entry of parsed.providers) {
        const config = normalizeProvider(entry);
        if (entry.secret && typeof entry.secret.data === 'string') config.secret = { encoding: entry.secret.encoding, data: entry.secret.data, ...(entry.secret.kind ? { kind: entry.secret.kind } : {}) };
        this.configs.set(config.id, config);
        if (config.secret && this.decryptSecret) {
          try {
            const encoded = config.secret.encoding === 'base64' ? Buffer.from(config.secret.data, 'base64') : config.secret.data, plain = String(await this.decryptSecret(encoded));
            const credentials = config.secret.kind === 'provider-credentials-v1' ? JSON.parse(plain) : { apiKey: plain, headers: {} };
            if (typeof credentials.apiKey !== 'string' || credentials.apiKey.length > 20000 || /[\r\n\x00]/.test(credentials.apiKey)) throw fail('Invalid stored credentials.');
            const headers = normalizeProviderHeaders(credentials.headers || {});
            this.keys.set(config.id, credentials.apiKey); this.headers.set(config.id, headers); this.rememberSecrets(credentials.apiKey, headers);
          } catch { config.secretError = 'The stored credentials could not be unlocked. Enter the API key and custom headers again in Connections.'; }
        }
      }
    })();
    return this.ready;
  }
  async persist(overrides = {}) {
    const snapshot = { version: 1, defaultModel: Object.hasOwn(overrides, 'defaultModel') ? overrides.defaultModel : this.defaultModel, automaticDefaultModel: Object.hasOwn(overrides, 'automaticDefaultModel') ? overrides.automaticDefaultModel : this.automaticDefaultModel, customCodexModels: Object.hasOwn(overrides, 'customCodexModels') ? overrides.customCodexModels : this.customCodexModels, providers: [...this.configs.values()].map(({ secretError, ...entry }) => entry) };
    this.writes = this.writes.catch(() => {}).then(() => atomicJSON(this.file, snapshot));
    return this.writes;
  }
  get(id) { return this.configs.get(id); }
  key(id) { return this.keys.get(id) || ''; }
  extraHeaders(id) { return { ...(this.headers.get(id) || {}) }; }
  hasCredential(id) { return Boolean(this.key(id) || Object.entries(this.headers.get(id) || {}).some(([name, value]) => /^(authorization|api-key|x-api-key)$/i.test(name) && value)); }
  rememberSecrets(key, headers) { for (const value of [key, ...Object.values(headers)]) if (value) { this.redactionKeys.add(value); const token = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value)?.[1]; if (token) this.redactionKeys.add(token); } }
  secrets() { return [...this.redactionKeys, ...this.keys.values()].filter(Boolean); }
  public(config) {
    if (!config) return null;
    const { secret, secretError, ...safe } = config;
    const hasApiKey = Boolean(this.keys.get(config.id));
    const requiresApiKey = providerRequiresApiKey(config);
    const headerNames = Object.keys(this.headers.get(config.id) || {});
    return structuredClone({ ...safe, requiresApiKey, hasApiKey, headerNames, hasHeaders: headerNames.length > 0, configured: config.enabled && (!requiresApiKey || this.hasCredential(config.id)), secretStorage: secret ? 'encrypted' : hasApiKey || headerNames.length ? 'session' : 'none', ...(secretError ? { lastError: secretError } : {}) });
  }
  list() { return [...this.configs.values()].map(config => this.public(config)); }
  listCodexModels() { return [...this.customCodexModels]; }
  addCodexModel(value) {
    const model = normalizeCodexModelId(value);
    return this.mutate(async () => {
      if (this.customCodexModels.includes(model)) return this.listCodexModels();
      const models = [...this.customCodexModels, model]; await this.persist({ customCodexModels: models }); this.customCodexModels = models; return this.listCodexModels();
    });
  }
  removeCodexModel(value) {
    const model = normalizeCodexModelId(value);
    return this.mutate(async () => {
      if (!this.customCodexModels.includes(model)) return this.listCodexModels();
      const models = this.customCodexModels.filter(id => id !== model); await this.persist({ customCodexModels: models }); this.customCodexModels = models; return this.listCodexModels();
    });
  }
  mutate(operation) { const pending = this.mutations.catch(() => {}).then(async () => { await this.init(); return operation(); }); this.mutations = pending; return pending; }
  setDefaultModel(value) { const selected = normalizeDefaultModel(value); return this.mutate(async () => { if (selected === RETIRED_CHAT_MODE_MODEL) throw retiredChatModeError(); if (selected?.includes('::') && !this.explicitRoutes.has(selected)) { const [id, model] = selected.split('::'); if (!this.configs.get(id)?.models.some(item => item.id === model)) throw fail('Save this model in its connection before making it the app default.'); } await this.persist({ defaultModel: selected, ...(selected === null ? { automaticDefaultModel: null } : {}) }); this.defaultModel = selected; if (selected === null) this.automaticDefaultModel = null; return selected; }); }
  pinAutomaticDefault(value) {
    const selected = normalizeDefaultModel(value);
    if (selected === RETIRED_CHAT_MODE_MODEL) return Promise.reject(retiredChatModeError());
    if (!selected || selected === 'codex' || this.explicitRoutes.has(selected)) return Promise.reject(fail('Choose a concrete automatic API or Codex model.'));
    return this.mutate(async () => {
      if (this.defaultModel !== null || this.automaticDefaultModel !== null) return this.automaticDefaultModel;
      if (selected.includes('::')) { const [id, model] = selected.split('::'); if (!this.configs.get(id)?.models.some(item => item.id === model)) throw fail('Save this model in its connection before making it the app default.'); }
      await this.persist({ automaticDefaultModel: selected }); this.automaticDefaultModel = selected; return selected;
    });
  }
  save(input) { return this.mutate(() => this.saveNow(input)); }
  async saveNow(input) {
    await this.init();
    const previous = this.configs.get(input?.id);
    if (previous && input.type && input.type !== previous.type && input.apiKey === undefined && this.key(previous.id)) throw fail('Enter an API key for the new provider type, or clear the old key.');
    const config = normalizeProvider(input, previous);
    if (input.apiKey === undefined && previous?.secret) config.secret = previous.secret;
    const key = input.apiKey === undefined ? this.key(config.id) : input.apiKey.trim();
    const headers = input.headers === undefined ? this.extraHeaders(config.id) : normalizeProviderHeaders(input.headers);
    this.rememberSecrets(key, headers);
    if ((input.apiKey !== undefined || input.headers !== undefined || !previous?.secret) && (key || Object.keys(headers).length) && this.encryptSecret && this.decryptSecret) {
      const bundled = Object.keys(headers).length > 0, plain = bundled ? JSON.stringify({ apiKey: key, headers }) : key, encrypted = await this.encryptSecret(plain);
      if (!Buffer.isBuffer(encrypted) && typeof encrypted !== 'string') throw new Error('API key encryption did not return a valid encrypted value.');
      if (String(encrypted) === plain) throw new Error('Credential encryption returned plaintext. The credentials were not saved.');
      config.secret = { encoding: Buffer.isBuffer(encrypted) ? 'base64' : 'string', data: Buffer.isBuffer(encrypted) ? encrypted.toString('base64') : encrypted, ...(bundled ? { kind: 'provider-credentials-v1' } : {}) };
    }
    if (!key && !Object.keys(headers).length) delete config.secret;
    const previousKey = this.keys.get(config.id), previousHeaders = this.headers.get(config.id);
    this.configs.set(config.id, config);
    if (key) this.keys.set(config.id, key); else this.keys.delete(config.id);
    this.headers.set(config.id, headers);
    try { await this.persist(); } catch (error) { if (previous) this.configs.set(config.id, previous); else this.configs.delete(config.id); if (previousKey) this.keys.set(config.id, previousKey); else this.keys.delete(config.id); if (previousHeaders) this.headers.set(config.id, previousHeaders); else this.headers.delete(config.id); throw error; }
    return this.public(config);
  }
  remove(id) { return this.mutate(async () => { const previous = this.configs.get(id), key = this.keys.get(id), headers = this.headers.get(id); this.configs.delete(id); this.keys.delete(id); this.headers.delete(id); try { await this.persist(); } catch (error) { if (previous) this.configs.set(id, previous); if (key) this.keys.set(id, key); if (headers) this.headers.set(id, headers); throw error; } return { removed: true, id }; }); }
  redact(value) {
    let text = String(value ?? 'Provider request failed.');
    for (const secret of this.secrets()) text = text.replaceAll(secret, '[redacted]');
    return text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]').replace(/(?:sk-(?:ant-)?)[A-Za-z0-9_-]{12,}/g, '[redacted]');
  }
}
