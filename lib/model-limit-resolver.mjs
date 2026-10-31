// Metadata only: no completions, probes, model loading, or credential-bearing public fetches.
// Provider endpoint limits and published model capacities deliberately have different provenance.
const DAY = 24 * 60 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;
const REMOTE_DETAIL_BUDGET = 200;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const OPENROUTER = 'https://openrouter.ai/api/v1/models';
const MODELS_DEV = 'https://models.dev/api.json';
const GPT_OSS_CONFIG = 'https://huggingface.co/openai/gpt-oss-20b/raw/main/config.json';
const MODEL_REFERENCE_PROVIDERS = Object.freeze({
  'api.openai.com': 'openai', 'api.anthropic.com': 'anthropic',
  'api.mistral.ai': 'mistral', 'api.groq.com': 'groq',
  'api.x.ai': 'xai', 'api.deepseek.com': 'deepseek',
});
const FIELDS = Object.freeze({
  context: { value: 'contextWindowTokens', source: 'contextWindowSource', date: 'contextWindowObservedAt', evidence: 'contextWindowEvidence' },
  output: { value: 'maxOutputTokens', source: 'maxOutputTokensSource', date: 'maxOutputObservedAt', evidence: 'maxOutputEvidence' },
});

function positive(value) {
  if (typeof value === 'string' && /^\d{1,16}$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
function modelId(model) { return typeof model?.id === 'string' ? model.id : typeof model?.model === 'string' ? model.model : typeof model?.name === 'string' ? model.name : ''; }
function missing(model) { return !positive(model?.contextWindowTokens) || !positive(model?.maxOutputTokens); }
function safeBase(config) {
  try { return new URL(config?.baseUrl); } catch { return null; }
}
function nativeUrl(base, path) { const url = new URL(base.href); url.pathname = path; return url; }
function indexRows(rows) {
  const exact = new Map(), aliases = new Map();
  const add = (map, id, row) => { if (typeof id !== 'string' || !id) return; if (map.has(id) && map.get(id) !== row) map.set(id, null); else map.set(id, row); };
  for (const row of Array.isArray(rows) ? rows.slice(0, 50_000) : []) {
    if (!row || typeof row !== 'object') continue;
    add(exact, modelId(row), row);
    for (const alias of Array.isArray(row.aliases) ? row.aliases : []) add(aliases, alias, row);
  }
  return { get(id, allowAliases = false) { return exact.has(id) ? exact.get(id) : allowAliases ? aliases.get(id) : null; } };
}
function source(result, id, label, status, url) { result.sources.push({ id, label, status, ...(url ? { url } : {}) }); }
function offer(result, kind, value, provenance, evidence, observedAt) {
  const tokens = positive(value), field = FIELDS[kind];
  if (!tokens || positive(result.patch[field.value])) return;
  Object.assign(result.patch, { [field.value]: tokens, [field.source]: provenance, [field.date]: observedAt, [field.evidence]: evidence });
}
function metadataError(message, status = 'unavailable') { return Object.assign(new Error(message), { metadataStatus: status }); }
function throwIfAborted(signal) { if (signal?.aborted) throw metadataError('Metadata lookup was cancelled or timed out.'); }

async function bounded(work, timeoutMs, signal) {
  const controller = new AbortController();
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const cancel = () => { controller.abort(); rejectAbort(metadataError('Metadata lookup was cancelled or timed out.')); };
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  try {
    if (signal?.aborted) cancel();
    return await Promise.race([Promise.resolve().then(() => { throwIfAborted(controller.signal); return work(controller.signal); }), aborted]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

async function responseJson(response) {
  if (!response?.ok) throw metadataError('Metadata endpoint did not return a successful response.', response?.status === 404 ? 'not-found' : 'unavailable');
  if (Number(response.headers?.get?.('content-length')) > MAX_JSON_BYTES) throw metadataError('Metadata response exceeded the size limit.');
  if (!response.body?.getReader) return response.json();
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > MAX_JSON_BYTES) { await reader.cancel(); throw metadataError('Metadata response exceeded the size limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export class ModelLimitResolver {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 5000, now = () => Date.now() } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(30_000, timeoutMs)) : 5000;
    this.now = now;
    this.results = new Map(); this.resources = new Map(); this.inFlight = new Map();
    this.resultGenerations = new Map(); this.resourceOwners = new Map();
    this.attempts = new Map(); this.generation = 0; this.attemptSequence = 0;
    this.active = 0; this.queue = [];
  }

  async enrich(config, models, { signal, refresh = false, request, rawModels } = {}) {
    if (!Array.isArray(models)) return [];
    const base = safeBase(config), checkedAt = new Date(this.now()).toISOString();
    const output = models.map(model => ({ ...model }));
    const controller = new AbortController(), cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    const timer = setTimeout(cancel, this.timeoutMs);
    const context = { config, base, refresh, request, signal: controller.signal, raw: indexRows(rawModels), batch: new Map(), indexes: new Map(), details: 0, generation: ++this.generation };
    const providerKey = JSON.stringify([config?.id, config?.type, config?.preset, base?.href, config?.endpoints]);
    const selected = new Set((Array.isArray(config?.models) ? config.models : []).map(model => typeof model === 'string' ? model : modelId(model)));
    const work = output.map((model, index) => {
      const id = modelId(model), raw = context.raw.get(id, true);
      const key = JSON.stringify([providerKey, id, raw ? [modelId(raw), raw.aliases, raw.context_length, raw.max_output_tokens, raw.max_completion_tokens] : null]);
      return { index, id, key, selected: selected.has(id), missingContext: !positive(model.contextWindowTokens), attempted: this.attempts.get(key) || 0 };
    }).sort((a, b) => Number(b.selected) - Number(a.selected) || Number(b.missingContext) - Number(a.missingContext) || a.attempted - b.attempted || a.index - b.index);
    let next = 0;
    const worker = async () => {
      while (next < work.length) {
        const { index, id, key } = work[next++], model = output[index];
        if (!missing(model)) {
          model.modelLimitLookup = { checkedAt, sources: [], ...model.modelLimitLookup, status: 'resolved' };
          continue;
        }
        const cached = this.results.get(key);
        let result;
        if (!refresh && cached && cached.expires > this.now()) result = cached.value;
        else {
          result = { patch: {}, sources: [], checkedAt: new Date(this.now()).toISOString() };
          const previousAttempt = this.attempts.get(key); let attempt;
          try {
            throwIfAborted(context.signal);
            if (context.generation >= (this.resultGenerations.get(key) || 0)) {
              this.resultGenerations.set(key, context.generation);
              if (refresh) this.results.delete(key);
            }
            this.attempts.set(key, attempt = ++this.attemptSequence);
            await this.lookup(id, context, result);
          }
          catch { source(result, 'lookup', 'Model metadata lookup', 'unavailable'); result.reason = 'Metadata lookup was cancelled or timed out.'; }
          if (result.retryable && this.attempts.get(key) === attempt) {
            if (previousAttempt === undefined) this.attempts.delete(key); else this.attempts.set(key, previousAttempt);
          }
          if (this.attempts.size > 10_000) this.attempts.delete(this.attempts.keys().next().value);
          if (!context.signal.aborted && !result.retryable && this.resultGenerations.get(key) === context.generation) {
            const found = positive(result.patch.contextWindowTokens) || positive(result.patch.maxOutputTokens);
            this.results.set(key, { value: result, expires: this.now() + (found ? DAY : FIVE_MINUTES) });
            if (this.results.size > 10_000) { const oldest = this.results.keys().next().value; this.results.delete(oldest); this.resultGenerations.delete(oldest); }
          }
          if (!this.results.has(key) && this.resultGenerations.get(key) === context.generation) this.resultGenerations.delete(key);
        }
        for (const field of Object.values(FIELDS)) {
          if (!positive(model[field.value]) && positive(result.patch[field.value])) {
            for (const name of Object.values(field)) model[name] = result.patch[name];
          }
        }
        const hasContext = positive(model.contextWindowTokens), hasOutput = positive(model.maxOutputTokens);
        const unavailable = result.sources.length > 0 && result.sources.every(item => item.status === 'unavailable');
        const status = hasContext && hasOutput ? 'resolved' : hasContext || hasOutput ? 'partial' : unavailable ? 'unavailable' : 'unresolved';
        model.modelLimitLookup = { status, checkedAt: result.checkedAt, sources: result.sources.map(item => ({ ...item })) };
        if (status !== 'resolved') model.modelLimitLookup.reason = result.reason || (status === 'partial' ? 'Some token limits are not published by the checked metadata sources.' : 'No exact model limit was available from the checked metadata sources.');
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(4, output.length) }, worker));
      if (signal?.aborted) { const error = new Error('Model metadata lookup was cancelled.'); error.name = 'AbortError'; throw error; }
      return output;
    }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }

  async resource(key, context, work) {
    if (context.batch.has(key)) return context.batch.get(key);
    const cached = this.resources.get(key);
    const existing = !context.refresh && this.inFlight.get(key);
    if (!existing && !context.refresh && cached && cached.expires > this.now()) return cached.value;
    const pending = existing || (async () => {
      try {
        const data = await this.limited(() => bounded(work, this.timeoutMs, context.signal), context.signal);
        return { ok: true, data, observedAt: new Date(this.now()).toISOString() };
      } catch (error) { return { ok: false, status: error?.metadataStatus || 'unavailable' }; }
    })();
    context.batch.set(key, pending);
    // A refresh must use its own transport/credentials. A late older request must
    // also be prevented from replacing the refreshed resource or model caches.
    if (!existing && context.generation >= (this.resourceOwners.get(key)?.generation || 0)) {
      this.resourceOwners.set(key, { generation: context.generation, pending });
      this.inFlight.set(key, pending);
      if (context.refresh) this.resources.delete(key);
    }
    try {
      const value = await pending;
      // Short catalogue caching lets a negative exact-ID lookup be retried after five minutes.
      // Successfully resolved per-model limits above retain their own 24-hour cache.
      if (!context.signal.aborted && this.resourceOwners.get(key)?.pending === pending) this.resources.set(key, { value, expires: this.now() + FIVE_MINUTES });
      if (this.resources.size > 256) { const oldest = this.resources.keys().next().value; this.resources.delete(oldest); if (!this.inFlight.has(oldest)) this.resourceOwners.delete(oldest); }
      return value;
    } finally { if (this.inFlight.get(key) === pending) this.inFlight.delete(key); }
  }

  limited(work, signal) {
    return new Promise((resolve, reject) => {
      let started = false;
      const cancel = () => {
        if (started) return;
        const index = this.queue.indexOf(run); if (index !== -1) this.queue.splice(index, 1);
        signal?.removeEventListener('abort', cancel); reject(metadataError('Metadata lookup was cancelled or timed out.'));
      };
      const run = () => {
        started = true; signal?.removeEventListener('abort', cancel); this.active++;
        Promise.resolve().then(work).then(resolve, reject).finally(() => { this.active--; this.queue.shift()?.(); });
      };
      if (signal?.aborted) { cancel(); return; }
      signal?.addEventListener('abort', cancel, { once: true });
      if (this.active < 4) run(); else this.queue.push(run);
    });
  }

  publicJson(url, context) {
    return this.resource(`public:${url}`, context, async signal => {
      if (typeof this.fetchImpl !== 'function') throw metadataError('Public metadata fetching is unavailable.');
      return responseJson(await this.fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'error', signal }));
    });
  }

  nativeJson(path, body, context, { detail = false } = {}) {
    const key = JSON.stringify(['native', context.config?.id, context.config?.type, context.config?.preset, context.base?.href, context.config?.endpoints, path, body]);
    if (detail && !context.batch.has(key)) {
      if (context.details >= REMOTE_DETAIL_BUDGET) return Promise.resolve({ ok: false, status: 'unavailable', budget: true });
      context.details++;
    }
    return this.resource(key, context, signal => {
      if (typeof context.request !== 'function') throw metadataError('The configured metadata transport is unavailable.');
      return context.request(path, body, signal);
    });
  }

  row(data, key, id, context, aliases = false) {
    if (!context.indexes.has(key)) context.indexes.set(key, indexRows(data));
    return context.indexes.get(key).get(id, aliases);
  }

  async lookup(id, context, result) {
    if (!id || !context.base) { result.reason = 'A valid provider URL and exact model ID are required for metadata lookup.'; return; }
    const host = context.base.hostname, preset = context.config?.preset;
    if (context.base.origin === 'https://text.pollinations.ai' || context.base.origin === 'https://gen.pollinations.ai') return this.pollinations(id, context, result);
    if (preset === 'ollama') return this.ollama(id, context, result);
    if (preset === 'lmstudio') return this.lmstudio(id, context, result);
    if (host === 'openrouter.ai' || preset === 'openrouter') return this.openrouter(id, context, result, context.base.origin === 'https://openrouter.ai');
    if (context.config?.type === 'anthropic') await this.anthropic(id, context, result);
    const provider = MODEL_REFERENCE_PROVIDERS[host];
    if (provider && (!positive(result.patch.contextWindowTokens) || !positive(result.patch.maxOutputTokens))) await this.modelsDev(provider, id, context, result);
    if (!result.sources.length) result.reason = 'No verified metadata adapter exists for this provider and exact model ID.';
  }

  async pollinations(id, context, result) {
    const legacy = context.base.hostname === 'text.pollinations.ai';
    const url = legacy ? 'https://text.pollinations.ai/models' : 'https://gen.pollinations.ai/text/models?reliability=all';
    const label = legacy ? 'Pollinations Classic model metadata' : 'Pollinations model metadata';
    let row = context.raw.get(id, true), observedAt = result.checkedAt;
    if (!row) {
      const response = await this.publicJson(url, context);
      if (!response.ok) { source(result, 'pollinations-catalog', label, response.status, url); return; }
      observedAt = response.observedAt;
      row = this.row(Array.isArray(response.data) ? response.data : response.data?.data, url, id, context, true);
    }
    source(result, 'pollinations-catalog', label, row ? 'found' : 'not-found', url);
    if (!row) return;
    const canonical = modelId(row), evidence = { label, modelId: canonical, url, endpointSpecific: true };
    offer(result, 'context', positive(row.context_length) || positive(row.context_window), 'provider-reported', { ...evidence, path: positive(row.context_length) ? 'context_length' : 'context_window' }, observedAt);
    offer(result, 'output', positive(row.max_output_tokens) || positive(row.max_completion_tokens), 'provider-reported', { ...evidence, path: positive(row.max_output_tokens) ? 'max_output_tokens' : 'max_completion_tokens' }, observedAt);
    // The Classic and Gen hosts reuse aliases for DIFFERENT upstream models.
    // Only the exact Classic row's explicit GPT-OSS alias authorizes this reference.
    if (legacy) {
      if (!positive(result.patch.contextWindowTokens) && (canonical === 'gpt-oss-20b' || row.aliases?.includes('gpt-oss-20b'))) {
        const response = await this.publicJson(GPT_OSS_CONFIG, context);
        const tokens = response.ok && positive(response.data?.max_position_embeddings);
        source(result, 'openai-gpt-oss-config', 'OpenAI GPT-OSS 20B published model configuration', tokens ? 'found' : response.ok ? 'not-found' : response.status, GPT_OSS_CONFIG);
        if (tokens) offer(result, 'context', tokens, 'model-reference', { label: 'OpenAI GPT-OSS 20B model capacity; Pollinations endpoint limit unconfirmed', modelId: 'openai/gpt-oss-20b', url: GPT_OSS_CONFIG, path: 'max_position_embeddings', endpointSpecific: false }, response.observedAt);
      }
      return;
    }
    if ((!positive(result.patch.contextWindowTokens) || !positive(result.patch.maxOutputTokens)) && canonical.includes('/')) await this.openrouter(canonical, context, result, false);
  }

  async openrouter(id, context, result, sameProvider) {
    const response = await this.publicJson(OPENROUTER, context);
    const label = sameProvider ? 'OpenRouter catalog (preferred provider; routes may differ)' : 'OpenRouter published model reference; configured endpoint unconfirmed';
    if (!response.ok) { source(result, 'openrouter-catalog', label, response.status, OPENROUTER); return; }
    const row = this.row(response.data?.data, OPENROUTER, id, context);
    source(result, 'openrouter-catalog', label, row ? 'found' : 'not-found', OPENROUTER);
    if (!row) return;
    const provenance = sameProvider ? 'provider-reported' : 'model-reference';
    const evidence = { label, modelId: row.id, url: OPENROUTER, endpointSpecific: false };
    offer(result, 'context', positive(row.top_provider?.context_length) || positive(row.context_length), provenance, { ...evidence, path: positive(row.top_provider?.context_length) ? 'top_provider.context_length' : 'context_length' }, response.observedAt);
    offer(result, 'output', row.top_provider?.max_completion_tokens, provenance, { ...evidence, path: 'top_provider.max_completion_tokens' }, response.observedAt);
  }

  async ollama(id, context, result) {
    // https://docs.ollama.com/api-reference/show-model-details.md and /api/ps.md
    // Local catalogs have no fixed per-model ceiling; the shared deadline and
    // four-request semaphore bound the work, with selected/untested IDs first.
    const [show, ps] = await Promise.all([this.nativeJson('/api/show', { model: id }, context), this.nativeJson('/api/ps', undefined, context)]);
    const showUrl = nativeUrl(context.base, '/api/show').href, psUrl = nativeUrl(context.base, '/api/ps').href;
    const running = ps.ok && Array.isArray(ps.data?.models) ? ps.data.models.find(row => row.model === id || row.name === id) : null;
    const allocated = positive(running?.context_length);
    source(result, 'ollama-running', 'Ollama loaded model context', allocated ? 'found' : ps.ok ? 'not-found' : ps.status, psUrl);
    if (allocated) offer(result, 'context', allocated, 'runtime-reported', { label: 'Ollama currently loaded context', modelId: id, url: psUrl, path: 'models[].context_length', endpointSpecific: true }, ps.observedAt);
    if (!show.ok) { source(result, 'ollama-show', 'Ollama model details', show.status, showUrl); return; }
    const parameters = typeof show.data?.parameters === 'string' ? show.data.parameters : '';
    const configured = positive(parameters.match(/^\s*num_ctx\s+(\d+)\s*$/m)?.[1]);
    const info = show.data?.model_info, architecture = info?.['general.architecture'];
    const maximum = typeof architecture === 'string' ? positive(info?.[`${architecture}.context_length`]) : null;
    source(result, 'ollama-show', 'Ollama model details', configured || maximum ? 'found' : 'not-found', showUrl);
    if (configured) offer(result, 'context', maximum ? Math.min(configured, maximum) : configured, 'runtime-reported', { label: 'Ollama saved model context (num_ctx)', modelId: id, url: showUrl, path: 'parameters.num_ctx', endpointSpecific: true }, show.observedAt);
    else if (maximum) offer(result, 'context', maximum, 'model-reference', { label: 'Ollama model capacity; loaded context unconfirmed', modelId: id, url: showUrl, path: `model_info.${architecture}.context_length`, endpointSpecific: false }, show.observedAt);
    // num_predict is a configurable generation default, not a model maximum.
  }

  async lmstudio(id, context, result) {
    // https://github.com/lmstudio-ai/docs/blob/main/1_developer/2_rest/list.md
    const path = '/api/v1/models', url = nativeUrl(context.base, path).href;
    const response = await this.nativeJson(path, undefined, context);
    if (!response.ok) { source(result, 'lmstudio-models', 'LM Studio native model metadata', response.status, url); return; }
    const rows = Array.isArray(response.data?.models) ? response.data.models : [];
    const row = rows.find(item => item.key === id || item.loaded_instances?.some(instance => instance.id === id));
    source(result, 'lmstudio-models', 'LM Studio native model metadata', row ? 'found' : 'not-found', url);
    if (!row) return;
    const instances = Array.isArray(row.loaded_instances) ? row.loaded_instances : [];
    const instance = instances.find(item => item.id === id) || (row.key === id && instances.length === 1 ? instances[0] : null);
    const allocated = positive(instance?.config?.context_length);
    if (allocated) offer(result, 'context', allocated, 'runtime-reported', { label: 'LM Studio loaded instance context', modelId: instance.id, url, path: 'models[].loaded_instances[].config.context_length', endpointSpecific: true }, response.observedAt);
    else offer(result, 'context', row.max_context_length, 'model-reference', { label: 'LM Studio model capacity; loaded context unconfirmed', modelId: row.key, url, path: 'models[].max_context_length', endpointSpecific: false }, response.observedAt);
  }

  async anthropic(id, context, result) {
    // Official SDK: anthropics/anthropic-sdk-typescript/src/resources/models.ts
    // Match providerEndpointURL: explicit models overrides are origin-relative;
    // otherwise the list route extends the configured base path. The transport
    // inherits the base query, so pass only the path and retain the full URL as evidence.
    const listPath = context.config?.endpoints?.models || `${context.base.pathname.replace(/\/+$/, '')}/models`;
    const path = `${listPath.replace(/\/+$/, '')}/${encodeURIComponent(id)}`, url = nativeUrl(context.base, path).href;
    const response = await this.nativeJson(path, undefined, context, { detail: true });
    if (!response.ok) { source(result, 'anthropic-model', 'Anthropic-compatible model detail', response.status, url); if (response.budget) { result.retryable = true; result.reason = 'The bounded model-detail lookup budget was reached; retry to continue checking remaining models.'; } return; }
    const row = response.data, canonical = typeof row?.id === 'string' ? row.id : id;
    const found = positive(row?.max_input_tokens) || positive(row?.max_tokens);
    source(result, 'anthropic-model', 'Anthropic-compatible model detail', found ? 'found' : 'not-found', url);
    const evidence = { label: 'Configured provider model detail', modelId: canonical, url, endpointSpecific: true };
    offer(result, 'context', row?.max_input_tokens, 'provider-reported', { ...evidence, path: 'max_input_tokens' }, response.observedAt);
    offer(result, 'output', row?.max_tokens, 'provider-reported', { ...evidence, path: 'max_tokens' }, response.observedAt);
  }

  async modelsDev(provider, id, context, result) {
    // Community-maintained reference, never represented as a provider-confirmed limit.
    const response = await this.publicJson(MODELS_DEV, context);
    const label = 'Models.dev community model reference; endpoint limit unconfirmed';
    if (!response.ok) { source(result, 'models-dev', label, response.status, MODELS_DEV); return; }
    const row = response.data?.[provider]?.models?.[id];
    const match = row && row.id === id ? row : null;
    source(result, 'models-dev', label, match ? 'found' : 'not-found', MODELS_DEV);
    if (!match) return;
    const evidence = { label, modelId: `${provider}/${id}`, url: MODELS_DEV, endpointSpecific: false };
    offer(result, 'context', match.limit?.context, 'model-reference', { ...evidence, path: `${provider}.models[${JSON.stringify(id)}].limit.context` }, response.observedAt);
    offer(result, 'output', match.limit?.output, 'model-reference', { ...evidence, path: `${provider}.models[${JSON.stringify(id)}].limit.output` }, response.observedAt);
  }
}
