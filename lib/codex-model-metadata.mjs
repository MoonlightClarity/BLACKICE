import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';

const executeFile = promisify(execFile);
const MAX_BYTES = 8 * 1024 * 1024;
const limit = value => Number.isSafeInteger(value) && value > 0 ? value : undefined;
const text = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const modelId = model => text(model?.model) || text(model?.id);
const empty = (id, label, reason) => ({ id, label, state: 'unavailable', reason, models: new Map() });

export function codexMetadataHome({ codexHome, env = process.env, home = homedir() } = {}) {
  return path.resolve(text(codexHome) || text(env.CODEX_HOME) || path.join(home, '.codex'));
}

/** Extract capacities and exact IDs only; never retain model prompts or account identity. */
export function parseCodexModelMetadata(value) {
  const data = typeof value === 'string' ? JSON.parse(value) : value;
  const entries = Array.isArray(data) ? data : data?.models || data?.data;
  if (!Array.isArray(entries) || entries.length > 10000) throw new Error('Invalid native model metadata.');
  const models = new Map(), ambiguous = new Set();
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const id = text(item.slug) || text(item.model) || text(item.id);
    if (!id || id.length > 256 || /[\x00-\x1f\x7f]/.test(id) || ambiguous.has(id)) continue;
    if (models.has(id)) { models.delete(id); ambiguous.add(id); continue; }
    const contextWindowTokens = limit(item.context_window ?? item.contextWindowTokens ?? item.contextWindow ?? item.context_length);
    const maxOutputTokens = limit(item.max_output_tokens ?? item.maxOutputTokens ?? item.max_completion_tokens);
    const maxContextWindowTokens = limit(item.max_context_window ?? item.maxContextWindowTokens);
    const percent = item.effective_context_window_percent ?? item.effectiveContextWindowPercent;
    const input = item.input_modalities ?? item.inputModalities;
    models.set(id, { id, displayName: (text(item.display_name) || text(item.displayName) || id).slice(0, 160),
      ...(contextWindowTokens ? { contextWindowTokens } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(maxContextWindowTokens ? { maxContextWindowTokens } : {}),
      ...(Number.isFinite(percent) && percent > 0 && percent <= 100 ? { effectiveContextWindowPercent: percent } : {}),
      ...(Array.isArray(input) && input.length <= 20 && input.every(value => typeof value === 'string' && value.length <= 40) ? { inputModalities: [...input] } : {}) });
  }
  return models;
}

function metadataArgs(args) {
  const result = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (['-c', '--config', '--enable', '--disable'].includes(value) && typeof args[index + 1] === 'string') result.push(value, args[++index]);
    else if (/^(?:--config|--enable|--disable)=/.test(value)) result.push(value);
  }
  return result;
}

function evidence(source, id) {
  return { label: 'Codex runtime metadata', modelId: id, ...(source.path?.length <= 2000 ? { path: source.path } : {}), endpointSpecific: true };
}
function lookupStatus(models) {
  const contexts = models.filter(model => limit(model.contextWindowTokens)).length;
  const outputs = models.filter(model => limit(model.maxOutputTokens)).length;
  return models.length && contexts === models.length && outputs === models.length ? 'resolved' : contexts || outputs ? 'partial' : 'unresolved';
}

/** Read exact native metadata without inference; CLI refresh is used only for an explicit catalog refresh. */
export class CodexModelMetadata {
  constructor({ command, args = ['app-server'], cwd, env = process.env, codexHome, home, enabled,
    readFileImpl = readFile, execFileImpl = executeFile, now = Date.now, maxAgeMs = 86400000 } = {}) {
    this.command = command; this.args = args; this.cwd = cwd; this.env = text(codexHome) ? { ...env, CODEX_HOME: codexHome } : env; this.now = now;
    this.home = codexMetadataHome({ codexHome, env, home }); this.cachePath = path.join(this.home, 'models_cache.json');
    this.readFile = readFileImpl; this.execFile = execFileImpl; this.maxAgeMs = maxAgeMs; this.bundlePromise = null;
    this.enabled = enabled ?? (/^codex(?:\.exe)?$/i.test(String(command || '').split(/[\\/]/).at(-1)) && args.includes('app-server'));
  }

  async cache() {
    try {
      const raw = await this.readFile(this.cachePath, 'utf8');
      if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) return empty('codex-cache', 'Codex model cache', 'oversized');
      const data = JSON.parse(raw), observedAt = date(data.fetched_at), age = this.now() - Date.parse(observedAt);
      if (!observedAt || age < -300000 || age > this.maxAgeMs) return empty('codex-cache', 'Codex model cache', 'stale');
      return { id: 'codex-cache', label: 'Codex model cache', state: 'available', models: parseCodexModelMetadata(data), observedAt, path: this.cachePath };
    } catch (cause) { return empty('codex-cache', 'Codex model cache', cause?.code === 'ENOENT' ? 'missing' : 'unreadable'); }
  }

  async raw({ bundled = false } = {}) {
    if (bundled && this.bundlePromise) return this.bundlePromise;
    const operation = (async () => {
      const id = bundled ? 'codex-bundled' : 'codex-runtime', label = bundled ? 'Bundled Codex model catalog' : 'Codex raw model catalog';
      try {
        const args = [...metadataArgs(this.args), 'debug', 'models', ...(bundled ? ['--bundled'] : [])];
        const result = await this.execFile(this.command, args, { cwd: this.cwd, env: this.env, windowsHide: true, encoding: 'utf8', timeout: bundled ? 3000 : 8000, maxBuffer: MAX_BYTES });
        const raw = typeof result === 'string' ? result : result.stdout;
        if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_BYTES) return empty(id, label, 'invalid-response');
        return { id, label, state: 'available', models: parseCodexModelMetadata(raw), observedAt: new Date(this.now()).toISOString(), path: this.command };
      } catch { return empty(id, label, 'unavailable'); }
    })();
    if (bundled) this.bundlePromise = operation;
    return operation;
  }

  async resolve(models, { refresh = false, config } = {}) {
    if (!this.enabled) return { models, candidates: [] };
    const checkedAt = new Date(this.now()).toISOString();
    const [cached, refreshed, bundled] = await Promise.all([this.cache(), refresh ? this.raw() : null, this.raw({ bundled: true })]);
    const sources = [refreshed, cached, bundled].filter(Boolean);
    const override = limit(config?.model_context_window), compactAt = limit(config?.model_auto_compact_token_limit);
    const enrich = model => {
      const id = modelId(model), result = { ...model };
      const matches = sources.filter(source => source.state === 'available' && source.models.has(id));
      const metadata = matches.map(source => ({ source, entry: source.models.get(id) }));
      for (const [field, sourceField, observedField, evidenceField] of [
        ['contextWindowTokens', 'contextWindowSource', 'contextWindowObservedAt', 'contextWindowEvidence'],
        ['maxOutputTokens', 'maxOutputTokensSource', 'maxOutputObservedAt', 'maxOutputEvidence'],
      ]) {
        if (limit(result[field])) continue;
        const match = metadata.find(({ entry }) => limit(entry[field]));
        if (match) Object.assign(result, { [field]: match.entry[field], [sourceField]: 'runtime-reported', [observedField]: match.source.observedAt, [evidenceField]: evidence(match.source, id) });
      }
      const defaults = metadata.find(({ entry }) => limit(entry.contextWindowTokens));
      if (defaults) result.runtimeDefaultContextWindowTokens = defaults.entry.contextWindowTokens;
      for (const field of ['maxContextWindowTokens', 'effectiveContextWindowPercent', 'inputModalities']) {
        if (result[field] !== undefined) continue;
        const match = metadata.find(({ entry }) => entry[field] !== undefined);
        if (match) result[field] = Array.isArray(match.entry[field]) ? [...match.entry[field]] : match.entry[field];
      }
      if (override) {
        result.contextWindowTokens = override; result.contextWindowSource = 'user-configured'; result.contextWindowObservedAt = checkedAt;
        result.contextWindowEvidence = { label: 'Codex effective configuration', modelId: id, endpointSpecific: true };
      }
      if (compactAt) result.nativeAutoCompactTokenLimit = compactAt;
      const checked = [{ id: 'codex-model-list', label: 'Codex model list', status: limit(model.contextWindowTokens) || limit(model.maxOutputTokens) ? 'found' : 'not-found' },
        ...sources.map(source => ({ id: source.id, label: source.label, status: source.state !== 'available' ? 'unavailable' : source.models.has(id) ? 'found' : 'not-found' }))];
      if (override) checked.unshift({ id: 'codex-configuration', label: 'Codex effective configuration', status: 'found' });
      const measuredStatus = lookupStatus([result]);
      const status = measuredStatus === 'unresolved' && sources.every(source => source.state !== 'available') ? 'unavailable' : measuredStatus;
      result.modelLimitLookup = { status, checkedAt, sources: checked,
        ...(status === 'unavailable' ? { reason: 'Native model metadata is currently unavailable. Refresh the model list to retry.' }
          : status === 'unresolved' ? { reason: 'No exact context or output limit was found in the native model list, runtime metadata, or bundled catalog.' }
          : status === 'partial' ? { reason: limit(result.contextWindowTokens) ? 'Context window resolved; the native metadata does not supply a maximum output limit.' : 'Maximum output resolved; the native metadata does not supply a context window.' } : {}) };
      return result;
    };
    const reapply = nextModels => {
      const resolved = nextModels.map(enrich), advertised = new Set(nextModels.map(modelId)), extra = new Map();
      for (const source of sources) if (source.state === 'available') for (const [id, entry] of source.models) {
        if (!advertised.has(id) && !extra.has(id)) extra.set(id, { id, model: id, displayName: entry.displayName, source: 'runtime-candidate', access: { state: 'unverified' } });
      }
      const candidates = [...extra.values()].map(enrich);
      return { models: resolved, candidates, lookup: { status: lookupStatus(resolved) === 'unresolved' && sources.every(source => source.state !== 'available') ? 'unavailable' : lookupStatus(resolved), checkedAt, sources: sources.map(source => ({ id: source.id, label: source.label, status: source.state === 'available' ? 'found' : 'unavailable' })) } };
    };
    // Internal callback: a later authoritative model/list can use these exact
    // observations without another CLI refresh or a different cache snapshot.
    return { ...reapply(models), reapply };
  }
}
