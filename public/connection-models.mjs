/** Keep known model metadata when users edit the simple model-ID list. */
export function providerModelsForSave(modelText, capacityText = '', knownModels = []) {
  const previous = new Map(knownModels.map(model => [typeof model === 'string' ? model : model.id, typeof model === 'string' ? { id: model } : model]));
  const ids = [...new Set(String(modelText || '').split(/[\n,]+/).map(id => id.trim()).filter(Boolean))];
  if (ids.length > 200) throw new Error('Choose up to 200 models for this connection.');
  const capacities = new Map();
  for (const [index, line] of String(capacityText || '').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const match = line.match(/^(.+?)\s*=\s*(.+)$/);
    if (!match) throw new Error(`Capacity line ${index + 1}: use model-id = 900000, or model-id = unknown.`);
    const id = match[1].trim(), raw = match[2].trim();
    if (!ids.includes(id)) { if (previous.has(id)) continue; throw new Error(`“${id}” has a capacity but is missing from the model IDs above.`); }
    if (capacities.has(id)) throw new Error(`Enter one capacity for “${id}”.`);
    if (raw.toLowerCase() === 'unknown') capacities.set(id, null);
    else {
      const numeric = raw.replace(/[,_ ]/g, ''), value = Number(numeric);
      if (!/^\d+$/.test(numeric) || !Number.isSafeInteger(value) || value < 4096 || value > 4000000) throw new Error(`Capacity for “${id}” must be a whole token count from 4,096 to 4,000,000.`);
      capacities.set(id, value);
    }
  }
  return ids.map(id => {
    const known = previous.get(id), value = { id, displayName: known?.displayName || known?.name || id };
    for (const key of ['supportsTools', 'maxOutputTokens', 'inputModalities', 'outputModalities']) if (known?.[key] !== undefined) value[key] = Array.isArray(known[key]) ? [...known[key]] : known[key];
    const capacity = capacities.has(id) ? capacities.get(id) : known?.contextWindowTokens;
    if (capacity) { value.contextWindowTokens = capacity; value.contextWindowSource = known?.contextWindowTokens === capacity && known?.contextWindowSource === 'provider-reported' ? 'provider-reported' : 'user-configured'; }
    return value;
  });
}

export function mergeDiscoveredProviderModels(knownModels = [], discoveredModels = []) {
  const known = new Map(knownModels.map(model => [typeof model === 'string' ? model : model.id, typeof model === 'string' ? { id: model } : model]));
  return discoveredModels.map(model => {
    const discovered = typeof model === 'string' ? { id: model } : model, previous = known.get(discovered.id);
    const result = { ...previous, ...discovered };
    if (previous?.contextWindowTokens && previous.contextWindowSource === 'user-configured') { result.contextWindowTokens = previous.contextWindowTokens; result.contextWindowSource = 'user-configured'; }
    return result;
  });
}

/** Selected models survive catalog searches/pages; unselected page data is bounded. */
export function createProviderModelSelection(initial = []) {
  const original = new Map(initial.map(model => { const value = typeof model === 'string' ? { id: model } : model; return [value.id, { ...value }]; }));
  let known = new Map(original), selected = new Set(known.keys()), page = [];
  if (selected.size > 200) throw new Error('Choose up to 200 models for this connection.');
  return {
    selected: () => [...selected].map(id => known.get(id)),
    page: () => page.map(model => ({ ...model, selected: selected.has(model.id) })),
    setPage(models = []) {
      page = mergeDiscoveredProviderModels([...known.values()], models.slice(0, 200));
      known = new Map([...selected].map(id => [id, known.get(id)])); for (const model of page) known.set(model.id, model);
    },
    toggle(id, checked) {
      if (!known.has(id)) throw new Error('Load this model before selecting it.');
      if (checked && !selected.has(id) && selected.size >= 200) throw new Error('Choose up to 200 models for this connection.');
      if (checked) selected.add(id); else selected.delete(id);
    },
    addManual(text) {
      const models = providerModelsForSave([...selected, ...String(text || '').split(/[\n,]+/)].join('\n'), '', [...known.values()]);
      for (const model of models) { known.set(model.id, model); selected.add(model.id); }
    },
    forSave(capacities = '') { return providerModelsForSave([...selected].join('\n'), capacities, [...new Map([...original, ...known]).values()]); },
  };
}

/** Discovery and a completed request are distinct observations, never an entitlement promise. */
export function codexModelAccessLabel(model = {}) {
  if (model.access?.state === 'accepted') return 'Last request completed';
  if (model.access?.state !== 'failed') return '';
  if (/TIMEOUT|TIMED_OUT/i.test(String(model.access.errorCode || ''))) return 'Last request timed out';
  return model.access.outcome === 'interrupted' ? 'Last request interrupted' : 'Last request failed';
}

const observationTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().replace('T', ' ').replace('Z', ' UTC') : null;

/** Results stay historical and account-scoped; an untried model needs no warning. */
export function codexModelAccessDetails(model = {}) {
  const label = codexModelAccessLabel(model);
  if (!label) return null;
  const access = model.access, checkedAt = observationTime(access.checkedAt), lastSuccessAt = observationTime(access.lastSuccessAt);
  const scope = access.scope === 'current-connection' ? 'Current Codex account and connection' : access.scope === 'expired-connection' ? 'Earlier Codex account or connection' : 'Account and connection not recorded';
  const entries = [['Observed', checkedAt || 'Time not recorded'], ['Scope', scope]];
  if (access.errorCode !== undefined && access.errorCode !== null && String(access.errorCode)) entries.push(['Result code', String(access.errorCode)]);
  if (access.state === 'failed' && lastSuccessAt) entries.push(['Earlier completed request', lastSuccessAt]);
  return { label, entries, note: 'This records one request. Future requests can have a different result.' };
}

export function codexModelSourceLabel(model = {}) {
  return model.source === 'documented' ? 'Documented candidate · not advertised by this catalog' : model.source === 'custom' ? 'Custom model ID' : model.hidden === true ? 'Hidden by Codex' : 'Advertised by Codex';
}
export function codexModelLifecycleLabel(model = {}) {
  const lifecycle = model.lifecycle || {};
  return lifecycle.state === 'retired' ? `Retired${/^\d{4}-\d{2}-\d{2}$/.test(lifecycle.date || '') ? ` ${lifecycle.date}` : ''} · documentation` : lifecycle.state === 'deprecated' ? 'Deprecated · documentation' : '';
}

export function connectionDefaultModels(status = {}) {
  const codex = status.codex || status, codexReady = codex.connected && codex.authenticated, values = [{ value: 'default', label: 'Automatic' }];
  if (codexReady) values.push({ value: 'codex', label: 'Codex default' });
  const selected = status.defaultModelSelection || 'default';
  const seen = new Set(values.map(value => value.value));
  for (const model of status.models || []) {
    const id = model.id === selected || model.model === selected ? selected : model.id || model.model;
    const native = !String(id).includes('::'), available = typeof model.available === 'boolean' ? model.available : native && codexReady;
    if (id && available && !seen.has(id)) { values.push({ value: id, label: `${model.displayName || id}${native && model.hidden === true ? ' · Hidden by Codex' : native && model.source === 'custom' ? ' · Custom model ID' : ''}${native && codexModelLifecycleLabel(model) ? ` · ${codexModelLifecycleLabel(model)}` : ''}` }); seen.add(id); }
  }
  if (!seen.has(selected)) values.push({ value: selected, label: `${selected} · unavailable` });
  return values;
}

/** Blank preserves stored headers; only an explicit clear replaces them with {}. */
export function providerHeadersForSave(text = '', clear = false) {
  const lines = String(text).split(/\r?\n/).filter(line => line.trim());
  if (clear && lines.length) throw new Error('Choose replacement headers or remove saved headers, not both.');
  if (clear) return {};
  if (!lines.length) return undefined;
  if (lines.length > 40) throw new Error('Use up to 40 request headers.');
  const headers = {}, seen = new Set();
  for (const [index, line] of lines.entries()) {
    const colon = line.indexOf(':'), name = line.slice(0, colon).trim(), value = line.slice(colon + 1).trim();
    if (colon < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || !value || /[\r\n\x00]/.test(value)) throw new Error(`Header line ${index + 1}: use name: value.`);
    if (seen.has(name.toLowerCase())) throw new Error(`Header line ${index + 1}: use each header name once.`);
    seen.add(name.toLowerCase()); headers[name] = value;
  }
  return headers;
}

