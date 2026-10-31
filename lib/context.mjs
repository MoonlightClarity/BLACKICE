const invalid = message => Object.assign(new Error(message), { code: 'INVALID_CONTEXT' });
const bounded = (value, fallback, min, max, name) => { if (value === undefined || value === null) return fallback; if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(`${name} must be an integer from ${min.toLocaleString()} to ${max.toLocaleString()}.`); return value; };
export const CONTEXT_PRESETS = [{ id: 'model', label: 'Model default', windowTokens: null }, { id: 'extended', label: 'Extended context', windowTokens: null }, { id: '900k', label: '900k tokens', windowTokens: 900000 }, { id: 'custom', label: 'Custom window', windowTokens: null }];
export function normalizeContextOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Context options must be an object.');
  const preset = input.preset ?? 'model'; if (!['model', 'extended', '900k', 'custom'].includes(preset)) throw invalid('Choose model default, extended context, 900k, or a custom context window.');
  if (input.autoCompact !== undefined && typeof input.autoCompact !== 'boolean') throw invalid('Automatic compaction must be true or false.');
  const windowTokens = preset === '900k' ? 900000 : preset === 'custom' ? bounded(input.windowTokens, null, 4096, 4000000, 'Context window') : null;
  if (preset === 'custom' && windowTokens === null) throw invalid('Enter the custom context window in tokens.');
  const options = { preset, windowTokens, autoCompact: input.autoCompact !== false };
  for (const [name, min, max] of [['outputReserveTokens', 256, 128000], ['headroomTokens', 128, 256000], ['compactAtTokens', 256, 4000000], ['keepRecentTokens', 256, 256000]]) if (input[name] !== undefined && input[name] !== null && input[name] !== '') options[name] = bounded(input[name], null, min, max, name);
  if (windowTokens && (options.outputReserveTokens || 0) + (options.headroomTokens || 0) >= windowTokens) throw invalid('Output reserve and headroom must leave room for input.');
  return options;
}
/** Deliberately labelled heuristic. Provider token usage remains a separate measurement. */
export function estimateContextTokens(value) {
  let bytes = 0, images = 0;
  const visit = item => {
    if (typeof item === 'string') { bytes += Buffer.byteLength(item, 'utf8'); return; }
    if (Array.isArray(item)) { bytes += item.length * 8; for (const child of item) visit(child); return; }
    if (!item || typeof item !== 'object') return;
    if (['input_image', 'image_url', 'image'].includes(item.type) || item.type === 'inputImage') { images++; return; }
    for (const [key, child] of Object.entries(item)) { bytes += key.length + 4; visit(child); }
  };
  visit(value); return Math.ceil(bytes / 3) + images * 2048;
}
export function contextSnapshot({ options = {}, modelWindowTokens = null, modelWindowSource = 'unknown', extendedWindowTokens = null, suppressRequestedWarning = false, messages = [], tools = [], lastUsage = null, lastInputEstimate = null, compactions = [], maxOutputTokens = 8192, defaultOutputReserveTokens = 8192 } = {}) {
  const normalized = normalizeContextOptions(options), reported = ['provider-reported', 'runtime-reported'].includes(modelWindowSource) && Number.isSafeInteger(modelWindowTokens) && modelWindowTokens > 0 ? modelWindowTokens : null;
  const configured = Number.isSafeInteger(modelWindowTokens) && modelWindowTokens > 0 ? modelWindowTokens : null;
  const capacitySource = configured && ['provider-reported', 'runtime-reported', 'model-reference', 'user-configured'].includes(modelWindowSource) ? modelWindowSource : configured ? 'user-configured' : null;
  const requestedWindowTokens = normalized.preset === 'extended' ? extendedWindowTokens || configured : normalized.windowTokens;
  if (normalized.preset === 'extended' && !requestedWindowTokens) throw invalid('Extended context needs a known capacity for the selected model. Choose Model default or a custom window.');
  const effectiveWindowTokens = Math.min(requestedWindowTokens || configured || 128000, configured || Infinity);
  const outputReserveTokens = normalized.outputReserveTokens ?? Math.max(256, Math.min(maxOutputTokens, defaultOutputReserveTokens, Math.floor(effectiveWindowTokens * .2)));
  const headroomTokens = normalized.headroomTokens ?? Math.max(128, Math.min(8192, Math.floor(effectiveWindowTokens * .05)));
  const inputBudgetTokens = effectiveWindowTokens - outputReserveTokens - headroomTokens;
  if (inputBudgetTokens < 256) throw invalid('The model window is too small for the requested output reserve and headroom.');
  const compactAtTokens = normalized.compactAtTokens ?? Math.floor(inputBudgetTokens * .8);
  if (compactAtTokens > inputBudgetTokens) throw invalid('The compaction trigger exceeds the model’s usable input budget.');
  const rawEstimate = estimateContextTokens([messages, tools]), actualInputTokens = Number(lastUsage?.inputTokens) || null;
  const calibration = actualInputTokens && lastInputEstimate ? Math.max(1, actualInputTokens / Math.max(1, lastInputEstimate)) : 1;
  const estimatedInputTokens = Math.ceil(rawEstimate * calibration), warnings = [];
  if (!suppressRequestedWarning && requestedWindowTokens && configured && requestedWindowTokens > configured) {
    warnings.push(reported
      ? `Requested ${requestedWindowTokens.toLocaleString()} tokens; the ${capacitySource === 'runtime-reported' ? 'runtime' : 'model'} reports ${reported.toLocaleString()}. The reported limit is used.`
      : capacitySource === 'model-reference'
        ? `Requested ${requestedWindowTokens.toLocaleString()} tokens; the published model context capacity is ${configured.toLocaleString()} tokens. The published capacity is used; the endpoint may have a smaller limit.`
        : `Requested ${requestedWindowTokens.toLocaleString()} tokens; the saved model context capacity is ${configured.toLocaleString()} tokens (user-configured). The saved capacity is used.`);
  }
  if (!reported) warnings.push(capacitySource === 'model-reference' ? 'This is a published model capacity; the configured endpoint has not independently confirmed its limit.' : requestedWindowTokens || configured ? 'This window is a user setting; the provider has not confirmed its capacity.' : 'Model capacity has not been resolved. A 128,000-token working budget is used; this is not a model capability claim.');
  return { preset: normalized.preset, requestedWindowTokens, modelWindowTokens: reported, configuredModelWindowTokens: configured, effectiveWindowTokens, windowSource: capacitySource || (requestedWindowTokens ? 'user-configured' : 'working-budget'), estimatedInputTokens, estimateMethod: 'UTF-8 bytes / 3 plus image allowance, calibrated against reported input usage', actualInputTokens, actualOutputTokens: Number(lastUsage?.outputTokens) || null, outputReserveTokens, headroomTokens, inputBudgetTokens, compactAtTokens, keepRecentTokens: normalized.keepRecentTokens ?? Math.max(512, Math.min(24000, Math.floor(inputBudgetTokens * .2))), remainingTokens: Math.max(0, inputBudgetTokens - estimatedInputTokens), remainingIsEstimate: true, autoCompact: normalized.autoCompact, compactionCount: compactions.length, lastCompaction: compactions.at(-1) || null, warnings };
}

const positiveWindow = value => Number.isSafeInteger(value) && value > 0 ? value : null;
/** Native raw configuration, supported maximum, and usable context are separate quantities. */
export function nativeContextSnapshot({ model = {}, options = {}, observedWindowTokens = null, observedWindowSource = 'runtime-reported', ...details } = {}) {
  const normalized = normalizeContextOptions(options), runtimeDefault = positiveWindow(model.runtimeDefaultContextWindowTokens), listed = positiveWindow(model.contextWindowTokens), maximum = positiveWindow(model.maxContextWindowTokens);
  // An effective catalog observation must not replace the raw model default.
  const current = model.contextWindowSource === 'user-configured' ? listed || runtimeDefault : runtimeDefault || listed;
  const expanding = normalized.preset === 'extended' || normalized.windowTokens !== null;
  const capacity = expanding && maximum ? maximum : current && Math.min(current, maximum || Infinity);
  const requested = normalized.preset === 'extended' ? maximum || current : normalized.windowTokens;
  const configured = requested || capacity ? Math.min(requested || capacity, capacity || Infinity) : null;
  const percent = Number.isFinite(model.effectiveContextWindowPercent) && model.effectiveContextWindowPercent > 0 && model.effectiveContextWindowPercent <= 100 ? model.effectiveContextWindowPercent : null;
  const expected = configured && (percent ? Math.floor(configured * percent / 100) : configured), observed = positiveWindow(observedWindowTokens);
  // An observed window is already effective. Never apply the metadata percentage again.
  const usable = observed ? Math.min(observed, configured || Infinity) : expected;
  const source = observed ? observedWindowSource : expanding && maximum ? 'runtime-reported' : model.contextWindowSource || (configured ? 'user-configured' : 'unknown');
  const result = contextSnapshot({ ...details, options: normalized, modelWindowTokens: usable, modelWindowSource: source, extendedWindowTokens: requested, suppressRequestedWarning: true });
  if (requested && capacity && requested > capacity) result.warnings.push(`Requested ${requested.toLocaleString()} tokens; Codex reports ${capacity.toLocaleString()} configured tokens${maximum ? ' as the supported maximum' : ''}. The known capacity is used.`);
  if (normalized.preset === 'extended' && !maximum) result.warnings.push('Codex has not reported an extended maximum for this model. Its current known capacity is used.');
  return { ...result, nativeConfiguredWindowTokens: configured, nativeDefaultContextWindowTokens: runtimeDefault || current, nativeMaxContextWindowTokens: maximum, nativeEffectiveContextWindowPercent: percent, nativeObservedWindowTokens: observed, nativeWindowBasis: observed ? 'runtime-usage' : configured && percent ? 'metadata-percent' : capacity ? 'metadata-window' : 'unconfirmed' };
}
const calls = message => message.type === 'function_call' ? [message.call_id] : message.tool_calls ? message.tool_calls.map(call => call.id) : Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_use').map(block => block.id) : [];
const results = message => message.type === 'function_call_output' ? [message.call_id] : message.role === 'tool' ? [message.tool_call_id] : Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result').map(block => block.tool_use_id) : [];
const imageSupplement = message => message.role === 'user' && Array.isArray(message.content) && message.content.some(block => block.type === 'image_url');
export const realUserMessage = message => message.role === 'user' && !results(message).length && !imageSupplement(message);
export function splitContext(messages, keepRecentTokens = 24000) {
  const pending = new Set(), cuts = [];
  for (let index = 0; index < messages.length - 1; index++) {
    for (const id of calls(messages[index])) pending.add(id);
    for (const id of results(messages[index])) pending.delete(id);
    if (!pending.size && messages[index].type !== 'reasoning' && !imageSupplement(messages[index + 1])) cuts.push(index + 1);
  }
  if (!cuts.length || messages.length < 4) return null;
  // Keep at least two complete protocol groups whenever possible.
  const usableCuts = cuts.filter(index => index >= 2);
  const candidates = usableCuts.length > 1 ? usableCuts.slice(0, -1) : usableCuts;
  if (!candidates.length) return null;
  const cut = candidates.find(index => estimateContextTokens(messages.slice(index)) <= keepRecentTokens) ?? candidates.at(-1);
  if (!cut || cut < 2) return null;
  const prefix = messages.slice(0, cut), tail = messages.slice(cut);
  const latestUser = [...messages].reverse().find(realUserMessage);
  return { prefix, tail, cut, pinnedUser: latestUser && prefix.includes(latestUser) ? latestUser : null };
}
export function summarySource(messages) {
  const clean = value => {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') return value;
    if (['input_image', 'image_url', 'image', 'inputImage'].includes(value.type)) return { type: 'image', note: 'Historical screenshot omitted; observe the current interface again before acting.' };
    return Object.fromEntries(Object.entries(value).filter(([key]) => !['encrypted_content'].includes(key)).map(([key, child]) => [key, clean(child)]));
  };
  return JSON.stringify(clean(messages));
}
export function reportedWindowFromError(message) {
  const matched = /(?:maximum context length(?: is| of)?|context (?:window|length)(?: is| of)?|max(?:imum)? context tokens?)[^\d]{0,24}([\d,]+)/i.exec(message || '');
  const value = matched ? Number(matched[1].replaceAll(',', '')) : null; return Number.isSafeInteger(value) && value >= 4096 ? value : null;
}

/** Unicode-safe bounded history chunks; no source text is discarded. */
export function contextTextChunks(text, tokenBudget) {
  if (typeof text !== 'string' || !Number.isSafeInteger(tokenBudget) || tokenBudget < 128) throw invalid('History chunks need text and a usable token budget.');
  const chunks = []; let offset = 0;
  while (offset < text.length) {
    let low = 1, high = Math.min(text.length - offset, tokenBudget * 3), length = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (estimateContextTokens(text.slice(offset, offset + middle)) <= tokenBudget) { length = middle; low = middle + 1; } else high = middle - 1;
    }
    if (length && offset + length < text.length && /[\uD800-\uDBFF]/.test(text[offset + length - 1])) length--;
    if (!length) throw invalid('The history chunk budget is too small for its contents.');
    chunks.push(text.slice(offset, offset + length)); offset += length;
  }
  return chunks;
}

/** Reserve the complete current request before budgeting a history checkpoint. */
export function checkpointBudget({inputBudgetTokens,baseTokens,calibration=1,preferredTokens=4096,minimumTokens=256}={}) {
  const scale=Math.max(1,Number(calibration)||1),availableTokens=Math.floor((inputBudgetTokens-baseTokens)/scale)-16;
  if(!Number.isSafeInteger(availableTokens)||availableTokens<minimumTokens)throw Object.assign(new Error(`Current instructions, tools, and the new message leave fewer than ${minimumTokens} tokens for a useful history checkpoint. No summary was requested; original messages were kept. Reduce this input or choose a larger supported context window.`),{code:'CONTEXT_OVERFLOW'});
  return{availableTokens,summaryTokens:Math.min(availableTokens,preferredTokens)};
}

