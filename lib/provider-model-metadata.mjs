const amount = value => typeof value === 'string' && value.length <= 80 && /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value);
const zero = value => typeof value === 'string' && /^-?(?:0+(?:\.0*)?|\.0+)(?:e[+-]?\d+)?$/i.test(value);
const priceText = value => typeof value === 'number' && Number.isFinite(value) ? String(value) : value;

const limitFields = [
  { value: 'contextWindowTokens', source: 'contextWindowSource', observed: 'contextWindowObservedAt', evidence: 'contextWindowEvidence', aliases: ['context_window', 'context_length', 'contextWindow', 'max_input_tokens'], nested: 'context_length' },
  { value: 'maxOutputTokens', source: 'maxOutputTokensSource', observed: 'maxOutputObservedAt', evidence: 'maxOutputEvidence', aliases: ['max_output_tokens', 'max_completion_tokens', 'maxOutput'], nested: 'max_completion_tokens' }
];
const knownSource = value => ['provider-reported', 'runtime-reported', 'model-reference', 'user-configured'].includes(value);
const discoveredSource = value => knownSource(value) && value !== 'user-configured';
const observedAt = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
export const validModelLimit = value => Number.isSafeInteger(value) && value > 0;
const shortText = (value, max = 240) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
const sourceURL = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && value.length <= 2400 ? value : undefined; } catch { return undefined; } };
export function modelLimitEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const [key, max] of [['label', 240], ['modelId', 256], ['path', 2400]]) { const text = shortText(value[key], max); if (text) result[key] = text; }
  const url = sourceURL(value.url); if (url) result.url = url;
  if (typeof value.endpointSpecific === 'boolean') result.endpointSpecific = value.endpointSpecific;
  return Object.keys(result).length ? result : undefined;
}
export function modelLimitLookup(value) {
  if (!value || typeof value !== 'object' || !['resolved', 'partial', 'unresolved', 'unavailable'].includes(value.status)) return undefined;
  const result = { status: value.status }, checkedAt = observedAt(value.checkedAt), reason = shortText(value.reason, 500);
  if (checkedAt) result.checkedAt = checkedAt;
  if (reason) result.reason = reason;
  if (Array.isArray(value.sources)) result.sources = value.sources.slice(0, 24).flatMap(source => {
    if (!source || !['found', 'not-found', 'unavailable'].includes(source.status)) return [];
    const id = shortText(source.id, 100), label = shortText(source.label), url = sourceURL(source.url);
    return id && label ? [{ id, label, status: source.status, ...(url ? { url } : {}) }] : [];
  });
  return result;
}
const limitValue = (model, field) => {
  for (const key of [field.value, ...field.aliases]) if (Object.hasOwn(model || {}, key) && model[key] !== undefined) return model[key];
  return model?.top_provider?.[field.nested];
};
export const modelLimitValues = model => Object.fromEntries(limitFields.map(field => [field.value, limitValue(model, field)]));

/** Capacity metadata has no working-budget defaults and never comes from a model's prose. */
export function modelLimitMetadata(model, { reported = false, reportedAt, previous, verifiedModel, preserveSources = false, discardPreviousReports = false } = {}) {
  const result = {};
  for (const field of limitFields) {
    const oldValue = limitValue(previous, field), discardPrior = discardPreviousReports && discoveredSource(previous?.[field.source]);
    let supplied = limitValue(model, field);
    // An address/protocol edit often echoes the complete old UI model object.
    // Its old report is not evidence about the new endpoint, even when explicit.
    if (discardPrior && supplied === oldValue && model?.[field.source] !== 'user-configured'
      && !(supplied === limitValue(verifiedModel, field) && discoveredSource(verifiedModel?.[field.source]))) supplied = undefined;
    const prior = discardPrior ? undefined : oldValue, value = supplied === undefined ? prior : supplied;
    if (!validModelLimit(value)) continue;
    let source = 'user-configured', date, evidence;
    if (reported) { source = preserveSources && knownSource(model?.[field.source]) ? model[field.source] : 'provider-reported'; date = observedAt(reportedAt) || observedAt(model?.[field.observed]); evidence = modelLimitEvidence(model?.[field.evidence]); }
    // An unchanged manual override remains manual even when a refreshed catalog
    // happens to advertise the same number.
    else if (!discardPrior && value === prior && previous?.[field.source] === 'user-configured') { source = 'user-configured'; }
    else if (value === limitValue(verifiedModel, field) && discoveredSource(verifiedModel?.[field.source])) { source = verifiedModel[field.source]; date = observedAt(verifiedModel[field.observed]); evidence = modelLimitEvidence(verifiedModel[field.evidence]); }
    else if (!discardPrior && value === prior && knownSource(previous?.[field.source])) { source = previous[field.source]; date = observedAt(previous[field.observed]); evidence = modelLimitEvidence(previous[field.evidence]); }
    else if (preserveSources && knownSource(model?.[field.source])) { source = model[field.source]; date = observedAt(model[field.observed]); evidence = modelLimitEvidence(model[field.evidence]); }
    result[field.value] = value; result[field.source] = source;
    if (discoveredSource(source)) { if (date) result[field.observed] = date; if (evidence) result[field.evidence] = evidence; }
  }
  const metadata = verifiedModel || (preserveSources ? model : discardPreviousReports ? null : previous);
  const lookup = modelLimitLookup(metadata?.modelLimitLookup); if (lookup) result.modelLimitLookup = lookup;
  for (const key of ['maxContextWindowTokens', 'runtimeDefaultContextWindowTokens']) if (validModelLimit(metadata?.[key])) result[key] = metadata[key];
  return result;
}

/** Overlay refreshed metadata without changing an explicit manual capacity. */
export function mergeModelLimits(model = {}, discovered = {}) {
  const merged = { ...model };
  for (const field of limitFields) {
    if (validModelLimit(model[field.value]) && model[field.source] === 'user-configured') continue;
    if (!validModelLimit(discovered[field.value]) || !discoveredSource(discovered[field.source])) continue;
    for (const key of [field.value, field.source, field.observed, field.evidence]) {
      delete merged[key]; if (discovered[key] !== undefined) merged[key] = discovered[key];
    }
  }
  for (const key of ['modelLimitLookup', 'maxContextWindowTokens', 'runtimeDefaultContextWindowTokens']) {
    if (discovered[key] === undefined) continue;
    if (key === 'modelLimitLookup' && !model.modelLimitLookup && !discovered[key]?.sources?.length && limitFields.every(field => validModelLimit(model[field.value]) && model[field.source] === 'user-configured')) continue;
    merged[key] = discovered[key];
  }
  return modelLimitReport(merged);
}

/** Every catalog/save response reports both capacities, including an explicit unknown. */
export function modelLimitReport(model = {}) {
  const limits = modelLimitMetadata(model, { preserveSources: true });
  if (limits.modelLimitLookup) {
    const count = limitFields.filter(field => validModelLimit(limits[field.value])).length;
    limits.modelLimitLookup = { ...limits.modelLimitLookup, status: count === 2 ? 'resolved' : count === 1 ? 'partial' : limits.modelLimitLookup.status === 'unavailable' ? 'unavailable' : 'unresolved' };
  }
  const rest = { ...model };
  for (const field of limitFields) for (const key of [field.value, field.source, field.observed, field.evidence]) delete rest[key];
  for (const key of ['modelLimitLookup', 'maxContextWindowTokens', 'runtimeDefaultContextWindowTokens']) delete rest[key];
  return { ...rest, contextWindowTokens: limits.contextWindowTokens ?? null, contextWindowSource: limits.contextWindowSource ?? 'unknown',
    maxOutputTokens: limits.maxOutputTokens ?? null, maxOutputTokensSource: limits.maxOutputTokensSource ?? 'unknown',
    ...limits };
}

/** Preserve provider-reported amounts as strings; never infer account eligibility. */
export function providerModelMetadata(model, { reportedAt, reported = false } = {}) {
  const result = typeof model?.id === 'string' && model.id.endsWith(':free') ? { freeVariant: true } : {};
  if (Array.isArray(model?.aliases)) result.aliases = [...new Set(model.aliases.filter(value => typeof value === 'string' && value.trim() && value.length <= 256 && !/[\r\n\x00]/.test(value) && !value.includes('::')).map(value => value.trim()))].slice(0, 64);
  const publisher = shortText(model?.publisher, 100); if (publisher) result.publisher = publisher;
  const free = typeof model?.is_free === 'boolean' ? model.is_free : typeof model?.isFree === 'boolean' ? model.isFree : typeof model?.free === 'boolean' ? model.free : undefined;
  if (typeof free === 'boolean') { result.isFree = free; result.freeSource = reported || model.freeSource === 'provider-reported' ? 'provider-reported' : 'user-configured'; }
  const parameters = model?.supportedParameters ?? model?.supported_parameters;
  if (Array.isArray(parameters) && parameters.length <= 128 && parameters.every(value => typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,79}$/.test(value))) result.supportedParameters = [...new Set(parameters)];
  if (model?.pricing && typeof model.pricing === 'object' && !Array.isArray(model.pricing)) {
    const source = { ...model.pricing };
    if (source.prompt === undefined) source.prompt = source.input ?? source.input_tokens;
    if (source.completion === undefined) source.completion = source.output ?? source.output_tokens;
    const entries = Object.entries(source).filter(([, value]) => value !== undefined).map(([key, value]) => [key, priceText(value)]), selected = entries.filter(([key, value]) => /^[a-z][a-z0-9_]{0,59}$/.test(key) && amount(value)).slice(0, 32);
    const pricing = Object.fromEntries(selected);
    if (Object.keys(pricing).length) {
      result.pricing = pricing;
      if (model.pricingIncomplete === true || selected.length !== entries.length) result.pricingIncomplete = true;
      result.pricingSource = reported || model.pricingSource === 'provider-reported' ? 'provider-reported' : 'user-configured';
      const date = reportedAt ?? model.pricingObservedAt;
      if (typeof date === 'string' && Number.isFinite(Date.parse(date))) result.pricingObservedAt = new Date(date).toISOString();
    }
  }
  return result;
}

/** Normalize only documented catalog schemas; route references are not endpoint guarantees. */
export function normalizeCatalogModelMetadata(raw, config = {}) {
  const model = { ...raw }; let contextReference = null, host = '', origin = '';
  try { const url = new URL(config.baseUrl); host = url.hostname; origin = url.origin; } catch { /* Normal provider validation reports an invalid address. */ }
  // Classic is an anonymous service distinct from the authenticated Gen API.
  // Its catalog reports access using tier rather than numeric token prices.
  if (origin === 'https://text.pollinations.ai' && raw.tier === 'anonymous' && model.is_free === undefined && model.isFree === undefined && model.free === undefined) model.is_free = true;
  const architecture = model.architecture && typeof model.architecture === 'object' ? model.architecture : {};
  if (Array.isArray(raw.input_modalities) || Array.isArray(raw.output_modalities)) model.architecture = { ...architecture,
    ...(Array.isArray(architecture.input_modalities) ? {} : Array.isArray(raw.input_modalities) ? { input_modalities: raw.input_modalities } : {}),
    ...(Array.isArray(architecture.output_modalities) ? {} : Array.isArray(raw.output_modalities) ? { output_modalities: raw.output_modalities } : {}) };
  if (config.preset === 'deepinfra' || host === 'api.deepinfra.com') {
    const metadata = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};
    if (!validModelLimit(model.contextWindowTokens) && !validModelLimit(model.context_length) && validModelLimit(metadata.context_length)) model.context_length = metadata.context_length;
    if (!model.pricing && metadata.pricing && typeof metadata.pricing === 'object') model.pricing = metadata.pricing;
    const tags = Array.isArray(metadata.tags) ? metadata.tags.filter(tag => typeof tag === 'string').map(tag => tag.toLowerCase()) : [];
    if (tags.includes('vision') || tags.includes('vlm')) {
      const architecture = model.architecture && typeof model.architecture === 'object' ? model.architecture : {};
      const inputs = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : Array.isArray(model.inputModalities) ? model.inputModalities : [];
      model.architecture = { ...architecture, input_modalities: [...new Set([...inputs, 'image'])] };
    }
    // DeepInfra max_tokens is also present on embedding models and is not an output limit.
  }
  if ((config.preset === 'huggingface' || host === 'router.huggingface.co') && Array.isArray(raw.providers)) {
    const routes = raw.providers.filter(route => route && typeof route === 'object' && (route.status === 'live' || route.status === undefined));
    if (routes.length) {
      const capacities = routes.map(route => route.context_length).filter(validModelLimit);
      if (capacities.length) {
        const missing = routes.length - capacities.length;
        contextReference = { value: Math.min(...capacities), label: `Hugging Face route context: minimum of ${capacities.length} reported routes${missing ? `; ${missing} route limits unknown` : ''}; routing unconfirmed` };
      }
      const routeMetadata = routes.map(route => providerModelMetadata(route, { reported: true }));
      const zeroPrice = route => route.pricingSource === 'provider-reported' && route.pricingIncomplete !== true && zero(route.pricing?.prompt) && zero(route.pricing?.completion) && Object.values(route.pricing).every(zero);
      const free = route => route.isFree !== false && route.pricingIncomplete !== true && (route.isFree === true && (!route.pricing || Object.values(route.pricing).every(zero)) || zeroPrice(route));
      if (routeMetadata.every(free)) model.is_free = true;
      else if (routeMetadata.some(route => route.isFree === false || route.pricing && Object.values(route.pricing).some(value => !zero(value)))) model.is_free = false;
      if (routeMetadata.every(zeroPrice)) model.pricing = { prompt: '0', completion: '0' };
      if (routes.every(route => route.supports_tools === true)) model.supports_tools = true;
      else if (routes.some(route => route.supports_tools === false)) model.supports_tools = false;
    }
  }
  return { model, contextReference };
}

/** A catalog filter, not a statement about quotas, access or future prices. */
export function zeroPricedFreeVariant(model) {
  return model?.freeVariant === true && model.pricingSource === 'provider-reported' && model.pricingIncomplete !== true
    && zero(model.pricing?.prompt) && zero(model.pricing?.completion) && Object.values(model.pricing).every(zero);
}

