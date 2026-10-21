const terminal = new Set(['completed', 'failed', 'cancelled']);
const idOf = item => item?.taskId || item?.rootId || item?.id;
const tokenOf = item => terminal.has(item?.status) && item?.settled !== false ? `${item.runId || item.latestRunId || item.id}:${item.status}` : null;
const timestamp = value => Date.parse(value || '') || 0;

/** Device-local attention receipts contain identifiers only, never chat text.
 * The first-use baseline keeps old or newly loaded history from becoming unread.
 * A known running turn is still unread when it finishes, including after restart. */
export function createConversationAttention({ storage, key = 'relay.conversation.attention.v1', now = Date.now() } = {}) {
  let entries = new Map(), baselineAt = now, lastSaved;
  const receipts = new Map(), receiptPrefix = `${key}:seen:`, receiptKey = (id, token) => `${receiptPrefix}${encodeURIComponent(id)}:${encodeURIComponent(token)}`;
  const backend = () => { try { return storage === undefined ? globalThis.localStorage : storage; } catch { return null; } };
  function readReceipt(id, token) {
    const name = receiptKey(id, token);
    if (receipts.has(name)) return receipts.get(name);
    try { const seen = backend()?.getItem(name) === '1'; receipts.set(name, seen); return seen; } catch { return false; }
  }
  function read() {
    try {
      const raw = backend()?.getItem(key);
      if (!raw || raw === lastSaved) return;
      const value = JSON.parse(raw);
      if (value?.version !== 1 || !Number.isFinite(value.baselineAt) || !Array.isArray(value.entries)) return;
      for (const [name, seen] of receipts) if (!seen) receipts.delete(name);
      const incoming = new Map(value.entries.filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] && typeof entry[1] === 'object' && !Array.isArray(entry[1])).map(([id, item]) => [id, { token: typeof item.token === 'string' ? item.token : null, seen: typeof item.seen === 'string' ? item.seen : null, createdAt: typeof item.createdAt === 'string' ? item.createdAt : '' }]));
      baselineAt = Math.min(baselineAt, value.baselineAt);
      for (const [id, item] of incoming) {
        const local = entries.get(id);
        // Another window may have read the same receipt while this one streamed.
        if (!local || timestamp(item.createdAt) >= timestamp(local.createdAt)) entries.set(id, { ...item });
      }
      lastSaved = raw;
    } catch {}
  }
  function save() {
    try {
      const raw = JSON.stringify({ version: 1, baselineAt, entries: [...entries] });
      if (raw !== lastSaved) backend()?.setItem(key, raw);
      lastSaved = raw;
    } catch { /* A storage failure retains this window's attention state. */ }
  }
  read();
  return {
    observe(items, { catalogIds } = {}) {
      read(); let changed = false;
      for (const item of items) {
        const id = idOf(item); if (!id) continue;
        const token = tokenOf(item), createdAt = item.createdAt || item.updatedAt || '', previous = entries.get(id);
        if (previous && timestamp(createdAt) < timestamp(previous.createdAt)) continue;
        const seen = token && readReceipt(id, token) ? token : previous?.seen || (!previous && token && timestamp(createdAt) <= baselineAt ? token : null);
        if (!previous || previous.token !== token || previous.seen !== seen || previous.createdAt !== createdAt) { entries.set(id, { token, seen, createdAt }); changed = true; }
      }
      // Only a successfully loaded complete catalog can retire missing receipts.
      // Evicting a transcript from the recent run list must never forget attention.
      if (catalogIds) {
        const retained = new Set(catalogIds); for (const id of entries.keys()) if (!retained.has(id)) { entries.delete(id); changed = true; }
        // Read receipts use individual immutable keys so unrelated window writes
        // cannot overwrite a newer read. Retain only current catalog responses.
        try {
          const target = backend(), live = new Set([...entries].filter(([, item]) => item.token).map(([id, item]) => receiptKey(id, item.token))), obsolete = [];
          for (let index = 0; target && index < target.length; index++) { const name = target.key(index); if (name?.startsWith(receiptPrefix) && !live.has(name)) obsolete.push(name); }
          for (const name of obsolete) { target.removeItem(name); receipts.delete(name); }
        } catch {}
      }
      if (changed) save();
    },
    unread(id) { const entry = entries.get(id); return Boolean(entry?.token && entry.token !== entry.seen && !readReceipt(id, entry.token)); },
    markSeen(item) {
      read(); const id = idOf(item), token = tokenOf(item), entry = entries.get(id);
      if (!id || !token || entry?.token !== token || entry.seen === token) return false;
      entry.seen = token;
      const name = receiptKey(id, token); receipts.set(name, true);
      try { backend()?.setItem(name, '1'); } catch {}
      save(); return true;
    },
    refresh() { for (const [name, seen] of receipts) if (!seen) receipts.delete(name); read(); },
  };
}

export const atConversationEnd = view => view.scrollHeight - view.scrollTop - view.clientHeight <= 4;

/** A stable visible message anchors a reading position when earlier history grows. */
export function captureConversationScroll(view, timeline, following = false) {
  if (following) return { top: view.scrollTop, following: true };
  const bounds = view.getBoundingClientRect(), candidates = [...timeline.querySelectorAll('[data-message-id]'), ...timeline.querySelectorAll('[data-run-id]')];
  const anchor = candidates.find(element => { const rect = element.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom; });
  return { top: view.scrollTop, following, ...(anchor ? { messageId: anchor.dataset.messageId, runId: anchor.dataset.runId, offset: anchor.getBoundingClientRect().top - bounds.top } : {}) };
}

export function restoreConversationScroll(view, timeline, position) {
  if (!position || position.following) { view.scrollTop = view.scrollHeight; return true; }
  const anchor = [...timeline.querySelectorAll('[data-message-id], [data-run-id]')].find(element => position.messageId ? element.dataset.messageId === position.messageId : element.dataset.runId === position.runId);
  view.scrollTop = anchor ? view.scrollTop + anchor.getBoundingClientRect().top - view.getBoundingClientRect().top - position.offset : position.top;
  return false;
}
