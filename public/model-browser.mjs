/** Shared display-only model browsing. These helpers never change saved model IDs or execution. */
export const MODEL_SORTS = Object.freeze([
  Object.freeze({ id: 'name', label: 'Name' }),
  Object.freeze({ id: 'context-desc', label: 'Largest context first' }),
  Object.freeze({ id: 'context-asc', label: 'Smallest context first' }),
  Object.freeze({ id: 'output-desc', label: 'Largest output first' }),
]);

const text = value => typeof value === 'string' ? value.trim() : '';
const identifier = model => text(model?.id) || text(model?.model) || text(model?.value);
const rawIdentifier = model => {
  const id = identifier(model), delimiter = id.indexOf('::');
  return delimiter < 0 ? id : id.slice(delimiter + 2);
};
const providerPrefix = model => {
  const id = identifier(model), delimiter = id.indexOf('::');
  return delimiter > 0 ? id.slice(0, delimiter) : '';
};
const positiveLimit = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const compareName = (a, b) => collator.compare(text(a?.displayName) || text(a?.name) || text(a?.label) || identifier(a), text(b?.displayName) || text(b?.name) || text(b?.label) || identifier(b))
  || collator.compare(identifier(a), identifier(b));

export function modelProvider(model, { providers = [], defaultProviderId, defaultLabel } = {}) {
  const id = text(model?.providerId) || providerPrefix(model) || text(defaultProviderId) || 'codex';
  const provider = (Array.isArray(providers) ? providers : []).find(item => (text(item?.id) || text(item?.providerId)) === id);
  const label = text(provider?.name) || text(provider?.displayName) || text(provider?.label) || text(model?.providerName)
    || (id === text(defaultProviderId) ? text(defaultLabel) : '') || (id === 'codex' ? 'Codex' : id);
  return { id, label };
}

const zero = value => typeof value === 'string' && /^-?(?:0+(?:\.0*)?|\.0+)(?:e[+-]?\d+)?$/i.test(value);
/** Free filtering uses reported prices or an explicit reported flag, never a naming convention. */
export function modelIsFree(model) {
  const reportedFlag = model?.freeSource === 'provider-reported';
  if (reportedFlag && model.isFree === false || model?.pricingIncomplete === true) return false;
  if (reportedFlag && model.isFree === true && (!model.pricing || Object.values(model.pricing).every(zero))) return true;
  return model?.pricingSource === 'provider-reported' && zero(model.pricing?.prompt) && zero(model.pricing?.completion) && Object.values(model.pricing).every(zero);
}

function hasVision(model) {
  if (model?.supportsVision === true || model?.supportsImage === true || model?.supportsImages === true) return true;
  const inputs = [model?.inputModalities, model?.input_modalities, model?.supportedInputModalities, model?.architecture?.input_modalities];
  return inputs.some(values => Array.isArray(values) && values.some(value => ['image', 'vision'].includes(text(value).toLowerCase())));
}

function publisher(model, options) {
  const value = model?.publisher;
  const id = text(typeof value === 'object' ? value?.id : value) || text(model?.publisherId) || text(model?.publisher_id);
  const label = text(typeof value === 'object' ? value?.displayName || value?.name || value?.label : value)
    || text(model?.publisherName) || text(model?.publisher_name);
  if (id || label) return { id: id || label, label: label || id };
  const modelId = rawIdentifier(model), slash = modelId.indexOf('/');
  if (slash > 0) return { id: modelId.slice(0, slash), label: modelId.slice(0, slash) };
  const connection = modelProvider(model, options), explicit = text(model?.providerId) || providerPrefix(model) || text(options.defaultProviderId);
  return { id: explicit ? connection.id : 'models', label: text(options.defaultLabel) || (explicit ? connection.label : 'Models') };
}

export function browseModels(models = [], options = {}) {
  const query = text(options.query).toLowerCase().split(/\s+/).filter(Boolean);
  const hidden = new Set(Array.isArray(options.hiddenModelProviders) ? options.hiddenModelProviders : []);
  const minimum = positiveLimit(options.minContextTokens);
  const filtered = (Array.isArray(models) ? models : []).filter(model => {
    const provider = modelProvider(model, options);
    if (hidden.has(provider.id) || options.freeOnly && !modelIsFree(model) || options.toolsOnly && model?.supportsTools !== true || options.visionOnly && !hasVision(model)) return false;
    const capacity = positiveLimit(model?.contextWindowTokens);
    if (minimum !== null && (capacity === null || capacity < minimum)) return false;
    if (!query.length) return true;
    const author = publisher(model, options);
    const haystack = [identifier(model), text(model?.model), text(model?.value), text(model?.displayName), text(model?.name), text(model?.label), provider.id, provider.label, author.id, author.label, ...(Array.isArray(model?.aliases) ? model.aliases.map(text) : [])].join(' ').toLowerCase();
    return query.every(word => haystack.includes(word));
  });
  const sort = MODEL_SORTS.some(item => item.id === options.sort) ? options.sort : 'name';
  if (sort === 'name') return filtered.sort(compareName);
  const field = sort === 'output-desc' ? 'maxOutputTokens' : 'contextWindowTokens', direction = sort === 'context-asc' ? 1 : -1;
  return filtered.sort((a, b) => {
    const left = positiveLimit(a?.[field]), right = positiveLimit(b?.[field]);
    if (left === null) return right === null ? compareName(a, b) : 1;
    if (right === null) return -1;
    return direction * (left - right) || compareName(a, b);
  });
}

export function groupModels(models = [], { providers = [], defaultProviderId, defaultLabel, mode = 'connection' } = {}) {
  const options = { providers, defaultProviderId, defaultLabel }, groups = new Map();
  for (const model of Array.isArray(models) ? models : []) {
    const group = mode === 'publisher' ? publisher(model, options) : modelProvider(model, options);
    if (!groups.has(group.id)) groups.set(group.id, { ...group, models: [] });
    groups.get(group.id).models.push(model);
  }
  return [...groups.values()].sort((a, b) => collator.compare(a.label, b.label) || collator.compare(a.id, b.id));
}
