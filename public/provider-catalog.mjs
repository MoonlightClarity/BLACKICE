/**
 * Reviewed connection defaults, not a bundled model catalog or an inference guarantee.
 * catalogAuthentication describes discovery only; public listings do not validate API keys.
 * catalogMetadataUrl is reference metadata and is not an alternate inference endpoint.
 */
export const PROVIDER_CATALOG_REVIEWED_AT = '2026-11-06';
const COMPATIBLE_CHAT = 'OpenAI-compatible Chat Completions';
export const PROVIDER_PRESETS = Object.freeze([
  {
    id: 'kilo_free', name: 'Kilo free models', type: 'compatible',
    baseUrl: 'https://ai-gateway.kilo.ai/api/v1', requiresApiKey: false, anonymous: true, freeOnly: true,
    protocolLabel: COMPATIBLE_CHAT, catalogStrategy: 'openai-models', catalogAuthentication: 'public',
    authNote: 'Anonymous access is limited to free models in the live catalog and is rate limited.',
    billingNote: 'This preset shows provider-reported zero-price models. Availability and limits can change.',
    docsUrl: 'https://kilo.ai/docs/gateway/authentication', keyUrl: 'https://app.kilo.ai/',
    sourceUrls: ['https://kilo.ai/docs/gateway/authentication', 'https://kilo.ai/docs/gateway/models-and-providers'],
  },
  {
    id: 'kilo', name: 'Kilo Gateway', type: 'compatible',
    baseUrl: 'https://ai-gateway.kilo.ai/api/v1', requiresApiKey: true,
    protocolLabel: COMPATIBLE_CHAT, catalogStrategy: 'openai-models', catalogAuthentication: 'public',
    authNote: 'Use a Kilo account API key for the full gateway. Its public model catalog does not verify your key.',
    billingNote: 'Pricing and limits depend on the selected model and your account.',
    docsUrl: 'https://kilo.ai/docs/gateway/api-reference', keyUrl: 'https://app.kilo.ai/',
    sourceUrls: ['https://kilo.ai/docs/gateway/authentication', 'https://kilo.ai/docs/gateway/usage-and-billing'],
  },
  {
    id: 'pollinations', name: 'Pollinations', type: 'compatible',
    baseUrl: 'https://gen.pollinations.ai/v1', requiresApiKey: true,
    protocolLabel: COMPATIBLE_CHAT, catalogStrategy: 'pollinations-text',
    catalogEndpoint: '/text/models', catalogAuthentication: 'public',
    authNote: 'Use a secret sk_ key. A publishable pk_ app key cannot authorize generation.',
    billingNote: 'Generation uses Pollen. Check your balance, model prices and key limits in Pollinations.',
    docsUrl: 'https://gen.pollinations.ai/', keyUrl: 'https://enter.pollinations.ai/keys',
    sourceUrls: ['https://gen.pollinations.ai/', 'https://gen.pollinations.ai/text/models'],
  },
  {
    id: 'openrouter', name: 'OpenRouter', type: 'compatible',
    baseUrl: 'https://openrouter.ai/api/v1', requiresApiKey: true,
    protocolLabel: COMPATIBLE_CHAT, catalogStrategy: 'openai-models', catalogAuthentication: 'public',
    authNote: 'Use an OpenRouter API key for generation. Browsing the public catalog does not verify the key.',
    billingNote: 'Models have separate prices and limits, including any current zero-price variants.',
    docsUrl: 'https://openrouter.ai/docs/quickstart', keyUrl: 'https://openrouter.ai/settings/keys',
    sourceUrls: ['https://openrouter.ai/docs/api/api-reference/models/get-models', 'https://openrouter.ai/api/v1/models'],
  },
  {
    id: 'mistral', name: 'Mistral API', type: 'compatible',
    baseUrl: 'https://api.mistral.ai/v1', requiresApiKey: true,
    protocolLabel: COMPATIBLE_CHAT, catalogStrategy: 'openai-models', catalogAuthentication: 'required',
    authNote: 'Use a Mistral Studio API key for your workspace.',
    billingNote: 'Quotas and charges follow your Mistral account plan; a key does not imply free usage.',
    docsUrl: 'https://docs.mistral.ai/api/endpoint/models',
    keyUrl: 'https://console.mistral.ai/home?profile_dialog=api-keys',
    sourceUrls: ['https://docs.mistral.ai/api/endpoint/models', 'https://docs.mistral.ai/admin/identity-access/api-keys'],
  },
  {
    id: 'groq', name: 'Groq', type: 'compatible',
    baseUrl: 'https://api.groq.com/openai/v1', requiresApiKey: true,
    protocolLabel: COMPATIBLE_CHAT, catalogStrategy: 'openai-models', catalogAuthentication: 'required',
    authNote: 'Use a Groq API key. This connection uses the Chat Completions compatibility API.',
    billingNote: 'Model availability and rate limits follow your Groq account tier.',
    docsUrl: 'https://console.groq.com/docs/openai', keyUrl: 'https://console.groq.com/keys',
    sourceUrls: ['https://console.groq.com/docs/openai', 'https://console.groq.com/docs/models'],
  },
  {
    id: 'cerebras', name: 'Cerebras', type: 'compatible',
    baseUrl: 'https://api.cerebras.ai/v1', requiresApiKey: true,
    protocolLabel: COMPATIBLE_CHAT, catalogStrategy: 'openai-models', catalogAuthentication: 'required',
    catalogMetadataUrl: 'https://api.cerebras.ai/public/v1/models',
    authNote: 'Use a Cerebras API key. Discovery reads the models available through that key.',
    billingNote: 'Pricing, context limits and quotas depend on the model and your account.',
    docsUrl: 'https://inference-docs.cerebras.ai/api-reference/models/list-models', keyUrl: 'https://cloud.cerebras.ai/',
    sourceUrls: ['https://inference-docs.cerebras.ai/api-reference/models/list-models', 'https://inference-docs.cerebras.ai/api-reference/models/public-models'],
  },
  {
    id: 'gemini', name: 'Google Gemini', type: 'compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', requiresApiKey: true,
    protocolLabel: COMPATIBLE_CHAT, catalogStrategy: 'openai-models', catalogAuthentication: 'required',
    authNote: 'Use a Gemini API key from Google AI Studio. This uses Google\'s OpenAI compatibility API.',
    billingNote: 'Model access, prices and quotas depend on your Google project and billing tier.',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai', keyUrl: 'https://aistudio.google.com/apikey',
    sourceUrls: ['https://ai.google.dev/gemini-api/docs/openai'],
  },
  {
    id: 'nvidia', name: 'NVIDIA NIM', type: 'compatible',
    baseUrl: 'https://integrate.api.nvidia.com/v1', requiresApiKey: true,
    protocolLabel: COMPATIBLE_CHAT, catalogStrategy: 'openai-models', catalogAuthentication: 'public',
    authNote: 'Use an NVIDIA API key for hosted inference. The public catalog does not verify account access.',
    billingNote: 'Check your NVIDIA access, credits and endpoint terms. A catalog listing does not guarantee inference access.',
    docsUrl: 'https://docs.api.nvidia.com/nim/reference/llm-apis', keyUrl: 'https://build.nvidia.com/',
    sourceUrls: ['https://docs.api.nvidia.com/nim/reference/llm-apis', 'https://integrate.api.nvidia.com/v1/models'],
  },
  {
    id: 'huggingface', name: 'Hugging Face', type: 'compatible',
    baseUrl: 'https://router.huggingface.co/v1', requiresApiKey: true,
    protocolLabel: COMPATIBLE_CHAT, catalogStrategy: 'openai-models', catalogAuthentication: 'public',
    authNote: 'Use a Hugging Face token authorized for Inference Providers. Discovery uses the router\'s chat-model catalog.',
    billingNote: 'Charges and available credits follow your account and the routed inference provider.',
    docsUrl: 'https://huggingface.co/docs/inference-providers/hub-api', keyUrl: 'https://huggingface.co/settings/tokens',
    sourceUrls: ['https://huggingface.co/docs/inference-providers/hub-api', 'https://router.huggingface.co/v1/models'],
  },
  {
    id: 'deepinfra', name: 'DeepInfra', type: 'compatible',
    baseUrl: 'https://api.deepinfra.com/v1/openai', requiresApiKey: true,
    protocolLabel: COMPATIBLE_CHAT, catalogStrategy: 'openai-models', catalogAuthentication: 'public',
    catalogMetadataUrl: 'https://api.deepinfra.com/models/list',
    authNote: 'Use a DeepInfra API key with inference access. The public catalog does not validate that key.',
    billingNote: 'Check current model pricing and account limits in DeepInfra.',
    docsUrl: 'https://docs.deepinfra.com/quickstart', keyUrl: 'https://deepinfra.com/dash/api_keys',
    sourceUrls: ['https://docs.deepinfra.com/account/authentication', 'https://api.deepinfra.com/v1/openai/models'],
  },
  {
    id: 'openai', name: 'OpenAI', type: 'openai',
    baseUrl: 'https://api.openai.com/v1', requiresApiKey: true,
    protocolLabel: 'OpenAI Responses', catalogStrategy: 'openai-models', catalogAuthentication: 'required',
    authNote: 'Use an OpenAI API key for a project with access to the selected model.',
    billingNote: 'API usage follows your OpenAI project billing and limits.',
    docsUrl: 'https://developers.openai.com/api/reference/resources/models', keyUrl: 'https://platform.openai.com/api-keys',
    sourceUrls: ['https://developers.openai.com/api/reference/resources/models'],
  },
  {
    id: 'anthropic', name: 'Anthropic', type: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1', requiresApiKey: true,
    protocolLabel: 'Anthropic Messages', catalogStrategy: 'anthropic-models', catalogAuthentication: 'required',
    authNote: 'Use a Claude API key. Add an anthropic-workspace-id header if your key requires workspace selection.',
    billingNote: 'Model access and charges follow your Anthropic workspace and account limits.',
    docsUrl: 'https://platform.claude.com/docs/en/api/overview', keyUrl: 'https://platform.claude.com/settings/keys',
    sourceUrls: ['https://platform.claude.com/docs/en/api/overview', 'https://platform.claude.com/docs/en/api/models/list'],
  },
  {
    id: 'ollama', name: 'Ollama', type: 'compatible',
    baseUrl: 'http://127.0.0.1:11434/v1', requiresApiKey: false,
    protocolLabel: COMPATIBLE_CHAT, catalogStrategy: 'local-openai-models', catalogAuthentication: 'optional',
    authNote: 'The local Ollama server does not require an API key. Start the server and make a model available first.',
    billingNote: 'Local models run on your hardware. Cloud models through Ollama have separate account requirements.',
    docsUrl: 'https://docs.ollama.com/api/openai-compatibility',
    sourceUrls: ['https://docs.ollama.com/api/openai-compatibility'],
  },
  {
    id: 'lmstudio', name: 'LM Studio', type: 'compatible',
    baseUrl: 'http://127.0.0.1:1234/v1', requiresApiKey: false,
    protocolLabel: COMPATIBLE_CHAT, catalogStrategy: 'local-openai-models', catalogAuthentication: 'optional',
    authNote: 'Start the LM Studio server. If server authentication is enabled, provide an LM Studio API token.',
    billingNote: 'Local models run on the hardware serving your LM Studio endpoint.',
    docsUrl: 'https://lmstudio.ai/docs/developer/openai-compat',
    keyUrl: 'https://lmstudio.ai/docs/developer/core/authentication',
    sourceUrls: ['https://lmstudio.ai/docs/developer/openai-compat', 'https://lmstudio.ai/docs/developer/core/authentication'],
  },
  {
    id: 'llamacpp', name: 'llama.cpp', type: 'compatible',
    baseUrl: 'http://127.0.0.1:8080/v1', requiresApiKey: false,
    protocolLabel: COMPATIBLE_CHAT, catalogStrategy: 'local-openai-models', catalogAuthentication: 'optional',
    authNote: 'Start a compatible llama-server. Configure a token if server authentication is enabled.',
    billingNote: 'Local models run on the hardware serving your llama.cpp endpoint.',
    docsUrl: 'https://github.com/ggml-org/llama.cpp/blob/v1.0.0/tools/server/README.md',
    sourceUrls: ['https://github.com/ggml-org/llama.cpp/blob/v1.0.0/tools/server/README.md'],
  },
  {
    id: 'compatible', name: 'Custom API', type: 'compatible', baseUrl: '', requiresApiKey: false,
    protocolLabel: 'Choose an API protocol', catalogStrategy: 'manual-or-models', catalogAuthentication: 'optional',
    authNote: 'Use the credentials required by your endpoint. You can enter exact model IDs when discovery is unavailable.',
    billingNote: 'Pricing, quotas and available features are set by the endpoint owner.',
    reviewedAt: null, sourceUrls: [],
  },
  // Preserve saved legacy endpoints. Choosing a current connection is an explicit user action.
  {
    id: 'pollinations_classic', name: 'Pollinations Classic', type: 'compatible',
    baseUrl: 'https://text.pollinations.ai',
    endpoints: Object.freeze({ models: '/models', chatCompletions: '/openai' }),
    requiresApiKey: false, anonymous: true, freeOnly: true,
    deprecated: true, hidden: true, replacementId: 'pollinations',
    protocolLabel: 'Legacy Pollinations Chat Completions', catalogStrategy: 'openai-models', catalogAuthentication: 'public',
    authNote: 'Legacy connection retained for existing settings. Add a current Pollinations connection with a secret key to migrate.',
    billingNote: 'Legacy endpoint availability is unverified. Current Pollinations pricing and access use its Pollen account system.',
    docsUrl: 'https://gen.pollinations.ai/', keyUrl: 'https://enter.pollinations.ai/keys',
    sourceUrls: ['https://gen.pollinations.ai/'],
  },
].map(preset => Object.freeze({
  reviewedAt: PROVIDER_CATALOG_REVIEWED_AT,
  ...preset,
  sourceUrls: Object.freeze(preset.sourceUrls),
})));
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

