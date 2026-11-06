import { PROVIDER_PRESETS, getProviderPreset } from '../public/provider-catalog.mjs';
import { MODEL_SORTS, browseModels, groupModels } from '../public/model-browser.mjs';
import { providerEndpointURL } from './provider-endpoints.mjs';
import { modelLimitReport } from './provider-model-metadata.mjs';

const invalidSearch = message => Object.assign(new Error(message), { code: 'INVALID_MODEL_SEARCH', status: 400 });
export function providerCatalogQuery({ query = '', offset = 0, limit = 200, sort = 'name', toolsOnly = false, freeOnly = false, visionOnly = false, minContextTokens = null, refresh = false } = {}) {
  if (typeof query !== 'string' || query.length > 256 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 || typeof toolsOnly !== 'boolean' || typeof freeOnly !== 'boolean' || typeof visionOnly !== 'boolean' || typeof refresh !== 'boolean') throw invalidSearch('Use a search of at most 256 characters and a catalog page of 1 to 200 models.');
  if (!MODEL_SORTS.some(item => item.id === sort)) throw invalidSearch('Choose a supported model catalog sort.');
  if (minContextTokens !== null && (!Number.isSafeInteger(minContextTokens) || minContextTokens < 0)) throw invalidSearch('Minimum context must be a nonnegative whole token count or null.');
  return { query, offset, limit, sort, toolsOnly, freeOnly, visionOnly, minContextTokens, refresh };
}

const address = value => {
  try { const url = new URL(value); url.pathname = url.pathname.replace(/\/+$/, ''); return url.href; } catch { return null; }
};
/** A preset's authentication claim applies only to its documented, unmodified catalog. */
export function providerCatalogInfo(config) {
  const matches = preset => preset?.baseUrl && preset.type === config.type && address(preset.baseUrl) === address(config.baseUrl);
  const declared = getProviderPreset(config.preset);
  const preset = matches(declared) ? declared : !declared || declared.id === 'compatible' ? PROVIDER_PRESETS.find(matches) : null;
  const defaultEndpoints = preset?.catalogEndpoint ? { ...preset.endpoints, models: preset.catalogEndpoint } : preset?.endpoints;
  const routed = !config.endpoints?.models && preset?.catalogEndpoint ? { ...config, endpoints: { ...config.endpoints, models: preset.catalogEndpoint } } : config;
  const url = providerEndpointURL(routed, 'models');
  const documented = Boolean(preset && url.href === providerEndpointURL({ ...preset, endpoints: defaultEndpoints }, 'models').href);
  return {
    url, preset: documented ? preset : null,
    strategy: documented ? preset.catalogStrategy || 'openai-models' : 'manual-or-models',
    authentication: documented ? preset.catalogAuthentication || 'optional' : 'optional',
    sourceUrl: url.origin + url.pathname,
    method: 'GET',
  };
}

/** Search, capability and price filters always run against the complete list before paging. */
export function providerCatalogPage(config, catalog, options) {
  const { query, offset, limit, sort, toolsOnly, visionOnly, minContextTokens } = options;
  const freeOnly = options.freeOnly || getProviderPreset(config.preset)?.freeOnly === true;
  const entries = [...new Map(catalog.models.map(model => [model.id, model])).values()];
  const matches = browseModels(entries, { query, sort, toolsOnly, freeOnly, visionOnly, minContextTokens, defaultProviderId: config.id, providers: [{ id: config.id, name: config.name }] });
  const models = matches.slice(offset, offset + limit);
  const groups = groupModels(matches, { defaultProviderId: config.id, defaultLabel: config.name, mode: 'publisher' }).map(group => ({ id: group.id, label: group.label, total: group.models.length }));
  return {
    providerId: config.id, models, selectedModels: catalog.selectedModels || config.models.map(modelLimitReport),
    selectedPresence: catalog.catalogAvailable === false ? null : config.models.map(model => ({ id: model.id, listed: entries.some(candidate => candidate.id === model.id) })),
    fetchedAt: catalog.fetchedAt || null,
    catalogAvailable: catalog.catalogAvailable !== false, ...(catalog.catalogError ? { catalogError: catalog.catalogError } : {}),
    total: matches.length, totalModels: entries.length, returned: models.length, offset,
    hasMore: offset + models.length < matches.length, truncated: offset > 0 || models.length < matches.length,
    sort, filters: { query, toolsOnly, freeOnly, visionOnly, minContextTokens }, groups,
  };
}

/** Draft secrets live only for this operation; do not add them to the runtime's credential caches. */
export function providerDraftRedaction(input, fallback = value => String(value ?? '')) {
  const secrets = new Set();
  for (const value of [input?.apiKey, ...Object.values(input?.headers && typeof input.headers === 'object' ? input.headers : {})]) {
    if (typeof value !== 'string' || !value) continue;
    secrets.add(value); if (value.trim()) secrets.add(value.trim());
    const token = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value)?.[1]; if (token) secrets.add(token);
  }
  const redact = value => {
    let text = fallback(value);
    for (const secret of secrets) text = text.replaceAll(secret, '[redacted]');
    return text;
  };
  const safe = value => typeof value === 'string' ? redact(value) : Array.isArray(value) ? value.map(safe) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), safe(item)])) : value;
  return { redact, safe };
}
