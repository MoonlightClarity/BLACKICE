const invalid = message => Object.assign(new Error(message), { code: 'INVALID_CONTEXT' });
const bounded = (value, fallback, min, max, name) => { if (value === undefined || value === null) return fallback; if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(`${name} must be an integer from ${min.toLocaleString()} to ${max.toLocaleString()}.`); return value; };
export const CONTEXT_PRESETS = [{ id: 'model', label: 'Model default', windowTokens: null }, { id: '900k', label: '900k tokens', windowTokens: 900000 }, { id: 'custom', label: 'Custom window', windowTokens: null }];
export function normalizeContextOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Context options must be an object.');
  const preset = input.preset ?? 'model'; if (!['model', '900k', 'custom'].includes(preset)) throw invalid('Choose model default, 900k, or a custom context window.');
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
export function contextSnapshot({ options = {}, modelWindowTokens = null, modelWindowSource = 'unknown', messages = [], tools = [], lastUsage = null, lastInputEstimate = null, compactions = [], maxOutputTokens = 8192 } = {}) {
  const normalized = normalizeContextOptions(options), reported = modelWindowSource === 'provider-reported' && Number.isSafeInteger(modelWindowTokens) && modelWindowTokens > 0 ? modelWindowTokens : null;
  const configured = Number.isSafeInteger(modelWindowTokens) && modelWindowTokens > 0 ? modelWindowTokens : null;
  const requestedWindowTokens = normalized.windowTokens;
  const effectiveWindowTokens = Math.min(requestedWindowTokens || configured || 128000, reported || Infinity);
  const outputReserveTokens = normalized.outputReserveTokens ?? Math.max(256, Math.min(maxOutputTokens, 8192, Math.floor(effectiveWindowTokens * .2)));
  const headroomTokens = normalized.headroomTokens ?? Math.max(128, Math.min(8192, Math.floor(effectiveWindowTokens * .05)));
  const inputBudgetTokens = effectiveWindowTokens - outputReserveTokens - headroomTokens;
  if (inputBudgetTokens < 256) throw invalid('The model window is too small for the requested output reserve and headroom.');
  const compactAtTokens = normalized.compactAtTokens ?? Math.floor(inputBudgetTokens * .8);
  if (compactAtTokens > inputBudgetTokens) throw invalid('The compaction trigger exceeds the model’s usable input budget.');
  const rawEstimate = estimateContextTokens([messages, tools]), actualInputTokens = Number(lastUsage?.inputTokens) || null;
  const calibration = actualInputTokens && lastInputEstimate ? Math.max(1, actualInputTokens / Math.max(1, lastInputEstimate)) : 1;
  const estimatedInputTokens = Math.ceil(rawEstimate * calibration), warnings = [];
  if (requestedWindowTokens && reported && requestedWindowTokens > reported) warnings.push(`Requested ${requestedWindowTokens.toLocaleString()} tokens; the model reports ${reported.toLocaleString()}. The reported limit is used.`);
  if (!reported) warnings.push(requestedWindowTokens || configured ? 'This window is a user setting; the provider has not confirmed its capacity.' : 'Model capacity was not reported. A 128,000-token working budget is used; this is not a model capability claim.');
  return { preset: normalized.preset, requestedWindowTokens, modelWindowTokens: reported, configuredModelWindowTokens: configured, effectiveWindowTokens, windowSource: reported ? 'provider-reported' : requestedWindowTokens || configured ? 'user-configured' : 'working-budget', estimatedInputTokens, estimateMethod: 'UTF-8 bytes / 3 plus image allowance, calibrated against reported input usage', actualInputTokens, actualOutputTokens: Number(lastUsage?.outputTokens) || null, outputReserveTokens, headroomTokens, inputBudgetTokens, compactAtTokens, keepRecentTokens: normalized.keepRecentTokens ?? Math.max(512, Math.min(24000, Math.floor(inputBudgetTokens * .2))), remainingTokens: Math.max(0, inputBudgetTokens - estimatedInputTokens), remainingIsEstimate: true, autoCompact: normalized.autoCompact, compactionCount: compactions.length, lastCompaction: compactions.at(-1) || null, warnings };
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
