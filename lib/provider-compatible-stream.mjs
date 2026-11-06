const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);

/** Merge metadata fields without interpreting or concatenating opaque values such as signatures. */
function mergeOpaque(previous, incoming) {
  if (!record(incoming)) return clone(incoming);
  const fields = new Map(Object.entries(record(previous) ? previous : {}));
  for (const [key, value] of Object.entries(incoming)) {
    fields.set(key, record(value) ? mergeOpaque(fields.get(key), value) : clone(value));
  }
  return Object.fromEntries(fields);
}

function appendFragment(previous, value, field) {
  if (value === undefined || value === null) return previous;
  if (typeof value !== 'string') {
    const cause = new Error('The compatible provider streamed an invalid function ' + field + '.');
    cause.code = 'PROVIDER_PROTOCOL';
    throw cause;
  }
  return previous + value;
}

/**
 * Assemble one Chat Completions assistant message. Text rendering stays with the
 * caller; provider extra_content stays attached to its original message or call.
 * An index identifies a streamed call when present. IDs and array positions also
 * support compatible providers that omit indices; IDs never collapse into one
 * shared undefined-index entry. Missing call IDs are not invented.
 */
export function createCompatibleStreamAccumulator() {
  const calls = [], byIndex = new Map(), byId = new Map(), byPosition = new Map();
  let extraContent;

  function append(delta) {
    if (!record(delta)) return;
    if (delta.extra_content !== undefined && delta.extra_content !== null) {
      extraContent = mergeOpaque(extraContent, delta.extra_content);
    }
    const used = new Set();
    for (const [position, part] of (Array.isArray(delta.tool_calls) ? delta.tool_calls : []).entries()) {
      if (!record(part)) continue;
      const index = Number.isSafeInteger(part.index) && part.index >= 0 ? part.index : null;
      const id = typeof part.id === 'string' && part.id ? part.id : null;
      let entry = index !== null ? byIndex.get(index) : undefined;
      if (!entry && id) {
        const matchingId = byId.get(id);
        if (matchingId && (index === null || matchingId.index === null || matchingId.index === index)) entry = matchingId;
      }
      if (!entry) {
        const atPosition = byPosition.get(position);
        if (atPosition && !used.has(atPosition)
          && (index === null || atPosition.index === null)
          && (!id || !atPosition.call.id || atPosition.call.id === id)) entry = atPosition;
      }
      if (!entry) {
        entry = { index, order: calls.length, call: { id: '', type: 'function', function: { name: '', arguments: '' } } };
        calls.push(entry);
      }
      if (index !== null) { entry.index = index; byIndex.set(index, entry); }
      if (id) {
        if (entry.call.id && entry.call.id !== id && byId.get(entry.call.id) === entry) byId.delete(entry.call.id);
        entry.call.id = id; byId.set(id, entry);
      }
      if (typeof part.type === 'string' && part.type) entry.call.type = part.type;
      if (record(part.function)) {
        entry.call.function.name = appendFragment(entry.call.function.name, part.function.name, 'name');
        entry.call.function.arguments = appendFragment(entry.call.function.arguments, part.function.arguments, 'arguments');
      }
      if (part.extra_content !== undefined && part.extra_content !== null) {
        entry.call.extra_content = mergeOpaque(entry.call.extra_content, part.extra_content);
      }
      byPosition.set(position, entry); used.add(entry);
    }
  }

  function message(content = null) {
    const ordered = [...calls].sort((a, b) =>
      a.index !== null && b.index !== null ? a.index - b.index :
        a.index !== null ? -1 : b.index !== null ? 1 : a.order - b.order);
    return {
      role: 'assistant',
      content,
      ...(extraContent === undefined ? {} : { extra_content: clone(extraContent) }),
      ...(ordered.length ? { tool_calls: ordered.map(entry => clone(entry.call)) } : {}),
    };
  }

  return { append, message };
}
