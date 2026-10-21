/** Shared connection defaults. Keys and provider responses never belong here. */
export const PROVIDER_PRESETS = Object.freeze([
  { id: 'openrouter', name: 'OpenRouter', type: 'compatible', baseUrl: 'https://openrouter.ai/api/v1', requiresApiKey: true, keyUrl: 'https://openrouter.ai/settings/keys', docsUrl: 'https://openrouter.ai/docs/quickstart' },
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
