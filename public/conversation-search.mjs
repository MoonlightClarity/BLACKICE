/** Search requests belong to one query and surface. Late replies never replace newer results. */
export function createConversationSearch({ api, onChange = () => {}, limit = 40, delayMs = 180,
  schedule = setTimeout, unschedule = clearTimeout } = {}) {
  let generation = 0, timer = null, controller = null, destroyed = false, retryOffset = 0, retryExtent = 0, refreshPending = false;
  let view = { query: '', scope: 'all', status: 'idle', conversations: [], total: 0, hasMore: false, truncated: false, error: '' };
  const emit = () => { if (!destroyed) onChange(view); };
  function abandon() {
    generation++;
    if (timer !== null) unschedule(timer);
    timer = null; controller?.abort(); controller = null; refreshPending = false;
  }
  async function request(offset = 0, extent = 0) {
    if (destroyed || !view.query) return false;
    abandon(); const own = generation, query = view.query, scope = view.scope;
    const pending = new AbortController(); controller = pending; retryOffset = offset; retryExtent = extent;
    const unique = new Map((offset ? view.conversations : []).map(item => [item.rootId || item.taskId || item.id, item]));
    let nextOffset = offset, total = 0, hasMore = false, truncated = offset > 0 && view.truncated;
    view = { ...view, status: offset ? 'loading-more' : 'loading', error: '' }; emit();
    try {
      // Refresh every page the user has reached before replacing the visible list.
      // A failed or superseded page leaves that entire previous result set intact.
      do {
        if (destroyed || own !== generation || pending.signal.aborted) return false;
        const params = new URLSearchParams({ q: query, state: scope, limit: String(limit), offset: String(nextOffset) });
        const result = await api(`/api/conversations/search?${params}`, { signal: pending.signal });
        if (destroyed || own !== generation || pending.signal.aborted) return false;
        if (!result || result.query !== query || result.state !== scope || !Array.isArray(result.conversations)
          || !Number.isSafeInteger(result.total) || result.total < 0 || result.offset !== nextOffset
          || result.limit !== limit || typeof result.hasMore !== 'boolean'
          || result.conversations.some(item => !item || typeof (item.rootId || item.taskId || item.id) !== 'string'
            || typeof item.title !== 'string' || !item.match || typeof item.match.runId !== 'string'
            || !['title', 'message', 'file'].includes(item.match.kind) || typeof item.match.text !== 'string')) {
          throw new Error('BLACKICE returned unreadable search results.');
        }
        for (const item of result.conversations) unique.set(item.rootId || item.taskId || item.id, item);
        nextOffset += result.conversations.length; total = result.total;
        hasMore = result.hasMore && result.conversations.length > 0; truncated ||= result.truncated === true;
      } while (hasMore && nextOffset < extent);
      view = { ...view, status: 'ready', conversations: [...unique.values()], total, nextOffset, hasMore, truncated, error: '' };
      emit(); return true;
    } catch (error) {
      if (destroyed || own !== generation || pending.signal.aborted) return false;
      view = { ...view, status: 'error', error: error?.message || 'Saved messages could not be searched.' };
      emit(); return false;
    } finally {
      if (controller === pending) controller = null;
      if (!destroyed && own === generation && refreshPending) { refreshPending = false; void request(0, view.nextOffset || 0); }
    }
  }
  function search(query, { scope = 'all', immediate = false } = {}) {
    if (destroyed) return Promise.resolve(false);
    query = String(query || '').trim().slice(0, 200);
    if (view.query === query && view.scope === scope && view.status !== 'idle') return Promise.resolve(false);
    abandon(); retryOffset = 0; retryExtent = 0;
    view = { query, scope, status: query ? 'waiting' : 'idle', conversations: [], total: 0, hasMore: false, truncated: false, error: '' };
    emit();
    if (!query) return Promise.resolve(false);
    if (immediate) return request();
    timer = schedule(() => { timer = null; void request(); }, delayMs);
    return Promise.resolve(false);
  }
  return {
    get: () => view,
    search,
    retry() { return view.status === 'error' ? request(retryOffset, retryExtent) : Promise.resolve(false); },
    more() { return view.status === 'ready' && view.hasMore ? request(view.nextOffset) : Promise.resolve(false); },
    refresh() {
      if (destroyed || !view.query || view.status === 'waiting') return Promise.resolve(false);
      if (['loading', 'loading-more'].includes(view.status)) { refreshPending = true; return Promise.resolve(false); }
      return request(0, view.nextOffset || 0);
    },
    cancel() { abandon(); view = { query: '', scope: 'all', status: 'idle', conversations: [], total: 0, hasMore: false, truncated: false, error: '' }; emit(); },
    destroy() { destroyed = true; abandon(); },
  };
}

export const searchMatchLabel = match => match?.kind === 'file' ? 'File' : match?.kind === 'message' ? 'Message' : 'Chat title';

/** Preserve current execution and attention state while showing the server's ranked matches. */
export function searchedSidebarConversations(matches, catalog, { historyState = 'active', isUnread = () => false } = {}) {
  const live = new Map(catalog.map(item => [item.id, item]));
  return matches.map(item => {
    const id = item.rootId || item.taskId || item.id, current = live.get(id);
    return { ...item, ...current, id, runId: current?.runId || item.latestRunId || item.runId || item.id,
      unread: isUnread(id), match: item.match };
  }).filter(item => historyState === 'deleted' ? item.state === 'deleted' : item.state !== 'deleted')
    .filter(item => historyState !== 'unread' || item.unread)
    .filter(item => historyState !== 'working' || ['queued', 'running', 'waiting'].includes(item.status) || item.settled === false);
}
