import { isOpenRouterProvider } from '../public/provider-catalog.mjs';

/**
 * OpenRouter's app attribution identifies this actual desktop agent, rather
 * than impersonating one of the hosted/approved agent apps. Localhost is a
 * supported app identifier when accompanied by an actual application title.
 * The initial attribution remains hidden from public app rankings.
 */
export const BLACKICE_OPENROUTER_HEADERS = Object.freeze({
  'HTTP-Referer': 'http://localhost:4317',
  'X-OpenRouter-Title': 'BLACKICE',
  'X-OpenRouter-Categories': 'personal-agent',
  'X-OpenRouter-App-Visibility': 'hidden',
});

// Preserve the existing import name for integrations using this helper.
export const RELAY_OPENROUTER_HEADERS = BLACKICE_OPENROUTER_HEADERS;

export function providerRequestHeaders(config, userHeaders = {}) {
  if (!isOpenRouterProvider(config)) return { ...userHeaders };

  const headers = { ...BLACKICE_OPENROUTER_HEADERS };
  // X-Title is OpenRouter's legacy alias of X-OpenRouter-Title. A user who
  // explicitly supplies that alias is intentionally overriding our default.
  if (Object.keys(userHeaders).some(name => /^(?:x-title|x-openrouter-title)$/i.test(name))) {
    delete headers['X-OpenRouter-Title'];
  }
  for (const [name, value] of Object.entries(userHeaders)) {
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
    }
    headers[name] = value;
  }
  return headers;
}
