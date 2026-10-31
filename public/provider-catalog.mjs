/** Shared connection defaults. Keys and provider responses never belong here. */
export const PROVIDER_PRESETS = Object.freeze([
  { id: 'kilo_free', name: 'Kilo Free', type: 'compatible', baseUrl: 'https://ai-gateway.kilo.ai/api/v1', requiresApiKey: false, anonymous: true, freeOnly: true, docsUrl: 'https://kilo.ai/docs/gateway/authentication' },
  { id: 'pollinations_classic', name: 'Pollinations Classic', type: 'compatible', baseUrl: 'https://text.pollinations.ai', endpoints: Object.freeze({ models: '/models', chatCompletions: '/openai' }), requiresApiKey: false, anonymous: true, freeOnly: true, docsUrl: 'https://text.pollinations.ai/models' },
  { id: 'openrouter', name: 'OpenRouter', type: 'compatible', baseUrl: 'https://openrouter.ai/api/v1', requiresApiKey: true, keyUrl: 'https://openrouter.ai/settings/keys', docsUrl: 'https://openrouter.ai/docs/quickstart' },
  { id: 'huggingface', name: 'Hugging Face', type: 'compatible', baseUrl: 'https://router.huggingface.co/v1', requiresApiKey: true, keyUrl: 'https://huggingface.co/settings/tokens', docsUrl: 'https://huggingface.co/docs/inference-providers/hub-api' },
  { id: 'deepinfra', name: 'DeepInfra', type: 'compatible', baseUrl: 'https://api.deepinfra.com/v1/openai', requiresApiKey: true, docsUrl: 'https://deepinfra.com/docs/openai_api' },
  { id: 'openai', name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', requiresApiKey: true, keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', name: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', requiresApiKey: true, keyUrl: 'https://platform.claude.com/settings/keys' },
  { id: 'ollama', name: 'Ollama', type: 'compatible', baseUrl: 'http://127.0.0.1:11434/v1', requiresApiKey: false, docsUrl: 'https://docs.ollama.com/api/openai-compatibility' },
  { id: 'lmstudio', name: 'LM Studio', type: 'compatible', baseUrl: 'http://127.0.0.1:1234/v1', requiresApiKey: false, docsUrl: 'https://lmstudio.ai/docs/developer/openai-compat' },
  { id: 'compatible', name: 'Custom API', type: 'compatible', baseUrl: '', requiresApiKey: false },
].map(preset => Object.freeze(preset)));
export const getProviderPreset = id => PROVIDER_PRESETS.find(preset => preset.id === id) || null;
export function isOpenRouterProvider(config) {
  if (config?.preset === 'openrouter') return true;
  try { const url = new URL(config?.baseUrl); return url.hostname === 'openrouter.ai' && /^\/api\/v1\/?$/.test(url.pathname); } catch { return false; }
}
export const providerRequiresApiKey = config => isOpenRouterProvider(config) || config?.preset !== 'compatible' && (config?.type !== 'compatible' || Boolean(getProviderPreset(config?.preset)?.requiresApiKey));
export const MODEL_LIMIT_SOURCE_LABELS = Object.freeze({
  'provider-reported': 'Provider reported', 'user-configured': 'User configured',
  'runtime-reported': 'Runtime reported', 'model-reference': 'Model reference',
});
const positiveLimit = value => Number.isSafeInteger(value) && value > 0;
const displayText = (value, limit = 240) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const displayDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : '';
const sourceURL = value => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
};
const limitFields = [
  { key: 'contextWindowTokens', label: 'Context window', source: 'contextWindowSource', observed: 'contextWindowObservedAt', evidence: 'contextWindowEvidence' },
  { key: 'maxOutputTokens', label: 'Max output', source: 'maxOutputTokensSource', observed: 'maxOutputObservedAt', evidence: 'maxOutputEvidence' },
];
const unknownLimit = model => {
  const lookup = model?.modelLimitLookup;
  if (lookup?.status === 'unavailable') return 'Unknown · lookup unavailable';
  if (['resolved', 'partial', 'unresolved'].includes(lookup?.status)) return 'Unknown · not found after lookup';
  return 'Unknown · lookup not run';
};

/** Capacities, runtime defaults and supported maxima are separate from application budgets. */
export function modelLimitDetails(model = {}) {
  model = model && typeof model === 'object' ? model : {};
  const field = descriptor => {
    const tokens = model?.[descriptor.key];
    if (!positiveLimit(tokens)) return unknownLimit(model);
    const source = model?.[descriptor.source], evidence = model?.[descriptor.evidence] || {};
    const parts = [tokens.toLocaleString() + ' tokens', MODEL_LIMIT_SOURCE_LABELS[source] || 'Source unspecified'];
    const label = displayText(evidence.label), observed = displayDate(model?.[descriptor.observed]);
    if (label && label !== parts[1]) parts.push(label);
    if (source === 'model-reference' && evidence.endpointSpecific !== true) parts.push('Endpoint unconfirmed');
    if (observed) parts.push('Observed ' + observed);
    return parts.join(' · ');
  };
  const details = limitFields.map(descriptor => [descriptor.label, field(descriptor)]);
  if (positiveLimit(model.runtimeDefaultContextWindowTokens)) details.push(['Runtime default context', model.runtimeDefaultContextWindowTokens.toLocaleString() + ' tokens']);
  if (positiveLimit(model.maxContextWindowTokens)) details.push(['Maximum supported context', model.maxContextWindowTokens.toLocaleString() + ' tokens']);
  return details;
}

/** Links are data, never markup; render them outside selection buttons and checkbox labels. */
export function modelLimitReferences(model = {}) {
  model = model && typeof model === 'object' ? model : {};
  const references = [], seen = new Set();
  const add = value => {
    const url = sourceURL(value.url), path = displayText(value.path, 2000);
    if (!url && !path) return;
    const label = displayText(value.label) || 'Model limit source', modelId = displayText(value.modelId, 400);
    const key = [url || path, label, modelId].join('\n');
    if (seen.has(key)) return; seen.add(key);
    references.push({ label: label + (modelId ? ' · ' + modelId : ''), ...(url ? { url } : { path }) });
  };
  for (const descriptor of limitFields) if (positiveLimit(model[descriptor.key]) && model[descriptor.source] !== 'user-configured') add(model[descriptor.evidence] || {});
  if (model.modelLimitLookup?.status !== 'resolved') for (const source of (Array.isArray(model.modelLimitLookup?.sources) ? model.modelLimitLookup.sources : []).slice(0, 16)) {
    if (!source || !['found', 'not-found', 'unavailable'].includes(source.status)) continue;
    add({ ...source, label: (displayText(source.label) || 'Lookup source') + (source.status === 'not-found' ? ' · not found' : source.status === 'unavailable' ? ' · unavailable' : '') });
  }
  return references;
}

export function modelLimitLookupSummary(model = {}) {
  const lookup = model?.modelLimitLookup;
  const summary = { partial: 'Some model limits were not found after lookup.', unresolved: 'No model limits were found after lookup.', unavailable: 'Model limit lookup was unavailable.' }[lookup?.status];
  if (!summary) return '';
  const checked = displayDate(lookup.checkedAt), reason = displayText(lookup.reason);
  const sources = (Array.isArray(lookup.sources) ? lookup.sources : []).filter(source => source && ['found', 'not-found', 'unavailable'].includes(source.status))
    .map(source => (displayText(source.label) || displayText(source.id) || 'Source') + ': ' + source.status.replace('-', ' '));
  return [summary, reason, checked && 'Checked ' + checked + '.', sources.length && 'Sources: ' + sources.join('; ') + '.'].filter(Boolean).join(' ');
}

