const names = ['models', 'chatCompletions'];
const invalid = message => Object.assign(new Error(message), { code: 'INVALID_PROVIDER_ENDPOINT', status: 400 });

/** Explicit overrides are root-relative paths on the configured API origin. */
export function normalizeProviderEndpoints(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !names.includes(key))) throw invalid('Use only models and chatCompletions endpoint paths.');
  const result = {};
  for (const key of names) {
    if (!Object.hasOwn(value, key)) continue;
    const route = value[key];
    let decoded;
    try { decoded = typeof route === 'string' ? decodeURIComponent(route) : ''; } catch { throw invalid('Endpoint paths must use valid URL encoding.'); }
    if (typeof route !== 'string' || !route || route.length > 2000 || !route.startsWith('/') || route.startsWith('//')
      || !decoded.startsWith('/') || decoded.startsWith('//') || /[\\?#\s\u0000-\u001f\u007f]/.test(route + decoded)
      || decoded.split('/').some(segment => segment === '.' || segment === '..')) throw invalid('Endpoint paths must begin with one slash and contain no origin, query, fragment, backslash, whitespace or traversal segments.');
    result[key] = route;
  }
  return result;
}

export function providerEndpointURL(config, endpoint) {
  const target = new URL(config.baseUrl), routes = normalizeProviderEndpoints(config.endpoints);
  const key = endpoint === 'models' ? 'models' : endpoint === 'chat/completions' ? 'chatCompletions' : null;
  target.pathname = key && routes[key] ? routes[key] : `${target.pathname.replace(/\/+$/, '')}/${endpoint}`;
  return target;
}

/** A saved conversation binds its inference route as well as its provider origin. */
export function providerInferenceURL(config) {
  return providerEndpointURL(config, config.type === 'compatible' ? 'chat/completions' : config.type === 'anthropic' ? 'messages' : 'responses').href;
}
