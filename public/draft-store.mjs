const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const secret = /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|client[-_]?secret|credentials)$/i;
const clean = (value, depth = 0) => depth > 24 ? null : Array.isArray(value) ? value.map(entry => clean(entry, depth + 1)) : plain(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => !secret.test(key)).map(([key, entry]) => [key, clean(entry, depth + 1)])) : ['string', 'number', 'boolean'].includes(typeof value) || value === null ? value : null;
export const draftKey = (...parts) => parts.map(part => encodeURIComponent(String(part ?? ''))).join(':');
export const draftWorkspace = value => /^[a-z]:[\\/]/i.test(value || '') ? value.replaceAll('\\', '/').toLowerCase() : String(value || '');

/** Apply this window's edits to the latest shared Mission snapshot. Unchanged
 * drafts and fields must not overwrite work written by another BLACKICE window. */
export function mergeMissionDrafts(latest = {}, baseline = {}, current = {}, { preserveNewerDrafts = false } = {}) {
  const object = value => plain(value) ? value : {};
  latest = object(latest); baseline = object(baseline); current = object(current);
  const mergeFields = (remoteValue, beforeValue, localValue) => {
    const remote = object(remoteValue), before = object(beforeValue), local = object(localValue), result = structuredClone(remote);
    for (const key of new Set([...Object.keys(before), ...Object.keys(local)])) {
      if (JSON.stringify(before[key]) === JSON.stringify(local[key])) continue;
      if (Object.hasOwn(local, key)) Object.defineProperty(result, key, { value: structuredClone(local[key]), enumerable: true, writable: true, configurable: true });
      else delete result[key];
    }
    return result;
  };
  const result = mergeFields(latest, baseline, current), remoteDrafts = object(latest.conversationDrafts), beforeDrafts = object(baseline.conversationDrafts), localDrafts = object(current.conversationDrafts);
  const drafts = structuredClone(remoteDrafts);
  for (const key of new Set([...Object.keys(beforeDrafts), ...Object.keys(localDrafts)])) {
    if (JSON.stringify(beforeDrafts[key]) === JSON.stringify(localDrafts[key])) continue;
    // Sending clears only the draft that was actually submitted. Another
    // window may already be writing its next message under the same chat key.
    if (preserveNewerDrafts && JSON.stringify(remoteDrafts[key]) !== JSON.stringify(beforeDrafts[key])) continue;
    if (!Object.hasOwn(localDrafts, key)) { delete drafts[key]; continue; }
    const before = beforeDrafts[key] || { task: '', attachmentIds: [] }, local = localDrafts[key];
    // A receipt belongs to one authored message/configuration. Never combine a
    // newly submitted receipt with text or settings from a different window.
    const submitting = local?.pendingSend && JSON.stringify(local.pendingSend) !== JSON.stringify(before.pendingSend);
    const merged = submitting ? structuredClone(local) : mergeFields(remoteDrafts[key], before, local);
    if (!submitting && ['task', 'model', 'context', 'effort', 'planningMode', 'planDetail', 'attachmentIds', 'agentId'].some(field => JSON.stringify(local?.[field]) !== JSON.stringify(before[field]))) delete merged.pendingSend;
    if (Object.keys(merged).length) Object.defineProperty(drafts, key, { value: merged, enumerable: true, writable: true, configurable: true });
  }
  result.conversationDrafts = drafts;
  return result;
}

/** Unsaved editor content only. Credentials are excluded; a failed disk cache keeps its window copy. */
export function createDraftStore({ storage, prefix = 'relay.editor-draft.v1:', maxChars = 600000 } = {}) {
  const memory = new Map();
  const backend = () => { try { return storage === undefined ? globalThis.localStorage : storage; } catch { return null; } };
  const parse = (raw, limit = maxChars) => {
    if (typeof raw !== 'string' || raw.length > limit) return null;
    try { const value = JSON.parse(raw); return value?.version === 1 && plain(value.data) && typeof value.savedAt === 'string' ? { data: clean(value.data), savedAt: value.savedAt } : null; } catch { return null; }
  };
  const raw = key => { if (memory.has(key)) return memory.get(key); try { return backend()?.getItem(prefix + key); } catch { return null; } };
  return {
    load(key) { const value = parse(raw(key), memory.has(key) ? Infinity : maxChars); return value ? structuredClone(value) : null; },
    list(startsWith = '') {
      const keys = new Set(memory.keys());
      try { const target = backend(); for (let index = 0; target && index < target.length; index++) { const name = target.key(index); if (name?.startsWith(prefix)) keys.add(name.slice(prefix.length)); } } catch {}
      return [...keys].filter(key => key.startsWith(startsWith)).map(key => { const value = parse(raw(key), memory.has(key) ? Infinity : maxChars); return value ? { key, ...structuredClone(value) } : null; }).filter(Boolean).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    },
    save(key, data) {
      let value, serialized;
      try { value = clean(data); serialized = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), data: value }); }
      catch { return { saved: false, persistent: false, data: {}, error: 'Draft kept in this window only.' }; }
      memory.set(key, serialized);
      try { const target = backend(); if (!target || serialized.length > maxChars) throw Error('Draft cache unavailable'); target.setItem(prefix + key, serialized); return { saved: true, persistent: true, data: structuredClone(value), error: '' }; }
      catch { return { saved: true, persistent: false, data: structuredClone(value), error: 'Draft kept in this window only.' }; }
    },
    remove(key, { expected } = {}) {
      if (!plain(expected)) return { removed: false };
      const matches = (serialized, limit = maxChars) => JSON.stringify(parse(serialized, limit)?.data) === JSON.stringify(clean(expected));
      if (memory.has(key)) { if (!matches(memory.get(key), Infinity)) return { removed: false }; memory.delete(key); }
      try { const target = backend(); if (!target) throw Error('Draft cache unavailable'); const current = target.getItem(prefix + key); if (current && !matches(current)) return { removed: false, persistent: true }; target.removeItem(prefix + key); return { removed: true, persistent: true }; }
      catch { return { removed: true, persistent: false, error: 'Draft changes are kept in this window only.' }; }
    },
  };
}
