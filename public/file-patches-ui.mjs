const escapeText = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const PAGE_SIZE = 30;
const canUndo = record => ['applied', 'prepared'].includes(record.status);
const statusLabel = record => ({ applied: 'Applied', prepared: 'Receipt pending', not_applied: 'Not applied', cancelled: 'Cancelled' })[record.status] || 'Recorded';
const sourceLabel = record => ({ user: 'You', agent: 'Agent', learning: 'Learning' })[record.source] || String(record.source || 'Local').replaceAll('_', ' ');
const timeLabel = at => { const value = new Date(at); return Number.isNaN(value.getTime()) ? 'Time not recorded' : value.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
export const patchFileName = file => String(file || '').split(/[\\/]/).filter(Boolean).at(-1) || 'Untitled file';

/** Show the first changed area, including changes late in a very long line. */
export function patchComparison(before = '', after = '', { maxChars = 24000, maxLines = 120 } = {}) {
  before = String(before); after = String(after);
  let first = 0;
  while (first < before.length && first < after.length && before[first] === after[first]) first++;
  if (before === after) first = 0;
  let start = Math.max(0, first - 1200);
  const boundary = before.indexOf('\n', start);
  if (start && boundary >= 0 && boundary < first) start = boundary + 1;
  const preview = text => {
    const from = Math.min(start, text.length); let end = Math.min(text.length, from + maxChars), lines = 0;
    for (let index = from; index < end; index++) if (text[index] === '\n' && ++lines >= maxLines) { end = index + 1; break; }
    const lineAt = index => 1 + (text.slice(0, index).match(/\n/g)?.length || 0);
    return { text: text.slice(from, end), fromLine: lineAt(from), toLine: lineAt(Math.max(from, end - 1)), totalLines: lineAt(text.length), omittedBefore: from > 0, omittedAfter: end < text.length, excerpt: from > 0 || end < text.length };
  };
  return { before: preview(before), after: preview(after), changed: before !== after, lineEndingsOnly: before !== after && before.replace(/\r\n/g, '\n') === after.replace(/\r\n/g, '\n') };
}

/** Applied changes have receipts, not an approval queue. Undo checks the actual file. */
export function initFilePatchesUI({ api, showModal, closeModal, toast = () => {}, escape = escapeText, icon = () => '', getCwd = () => '', onOpenRun }) {
  const $ = selector => document.querySelector(selector);
  const state = { session: 0, request: 0, detailRequest: 0, cwd: '', scope: 'folder', offset: 0, data: null, selected: null, record: null, detailError: '', error: '', message: '', loading: false, detailLoading: false };
  const undoing = new Set(), reversed = new Set();
  let mount;
  const owner = () => ({ session: state.session, mount });
  const owns = value => value.session === state.session && value.mount === mount && $('#file-patches-view') === value.mount;
  const active = () => mount && $('#file-patches-view') === mount;
  const find = id => state.data?.patches?.find(record => record.id === id);
  const focusRow = id => [...(mount?.querySelectorAll('[data-patch-action="expand"]') || [])].find(button => button.dataset.id === id)?.focus({ preventScroll: true });

  function renderShell() {
    mount.innerHTML = `<div class="file-patches-toolbar"><label><span class="sr-only">File change scope</span><select id="file-patches-scope" aria-label="File change scope"><option value="folder"${state.scope === 'folder' ? ' selected' : ''}${state.cwd ? '' : ' disabled'}>This working folder</option><option value="all"${state.scope === 'all' ? ' selected' : ''}>All folders</option></select></label><span class="file-patches-folder" title="${escape(state.cwd)}">${escape(state.scope === 'folder' ? state.cwd : 'Saved patch history')}</span><button class="icon-button" data-patch-action="refresh" aria-label="Refresh file changes" title="Refresh">${icon('refresh', 15)}</button></div><div id="file-patches-message" class="file-patches-message" role="status" aria-live="polite"></div><div id="file-patches-results" class="file-patches-results"></div><div class="file-patches-footer"><span id="file-patches-count"></span><div><button class="button subtle" data-patch-action="previous">Previous</button><button class="button subtle" data-patch-action="next">Next</button><button class="button" data-action="close-modal">Done</button></div></div>`;
    $('#file-patches-scope').onchange = event => { state.scope = event.target.value === 'all' ? 'all' : 'folder'; state.offset = 0; state.selected = null; state.record = null; state.message = ''; renderShell(); load(); };
    mount.onclick = async event => {
      const button = event.target.closest('[data-patch-action]'); if (!button || button.disabled) return;
      const action = button.dataset.patchAction, id = button.dataset.id;
      if (action === 'refresh') return load();
      if (action === 'previous' && state.offset) { state.offset = Math.max(0, state.offset - PAGE_SIZE); state.selected = null; state.record = null; return load(); }
      if (action === 'next' && state.data?.hasMore && !state.loading) { state.offset += PAGE_SIZE; state.selected = null; state.record = null; return load(); }
      if (action === 'expand') return expand(id);
      if (action === 'undo') return undo(id);
      if (action === 'detail-retry') return readDetail(id);
      if (action === 'source' && onOpenRun) { const record = state.record?.id === id ? state.record : find(id); if (!record?.runId) return; closeModal(); try { await onOpenRun(record.runId); } catch (error) { toast(error.message, true); } }
    };
  }

  function renderMessage() {
    if (!active()) return;
    const target = $('#file-patches-message'); target.textContent = state.message || ''; target.hidden = !state.message;
  }

  function renderList() {
    if (!active()) return;
    const results = $('#file-patches-results'), records = state.data?.patches || [];
    renderMessage();
    if (state.loading) results.innerHTML = '<p class="file-patches-empty" role="status">Loading changes…</p>';
    else if (state.error) results.innerHTML = `<div class="file-patches-empty"><p role="alert">${escape(state.error)}</p><button class="button" data-patch-action="refresh">Try again</button></div>`;
    else results.innerHTML = `${state.data?.damaged ? `<p class="file-patches-note">${Number(state.data.damaged)} receipt${state.data.damaged === 1 ? '' : 's'} could not be read.</p>` : ''}${records.length ? records.map(record => `<article class="file-patch${record.id === state.selected ? ' expanded' : ''}"><button class="file-patch-heading" data-patch-action="expand" data-id="${escape(record.id)}" aria-expanded="${record.id === state.selected}"><span class="file-patch-icon">${icon(record.action === 'undo' ? 'undo' : 'file', 17)}</span><span class="file-patch-name"><strong>${escape(patchFileName(record.path))}</strong><small>${escape(timeLabel(record.at))} · ${escape(sourceLabel(record))}${record.action === 'undo' ? ' · Undo' : ''}</small></span><span class="file-patch-status">${escape(statusLabel(record))}</span>${icon(record.id === state.selected ? 'down' : 'chevron', 13)}</button>${record.id === state.selected ? '<div id="file-patch-detail" class="file-patch-detail"></div>' : ''}</article>`).join('') : `<div class="file-patches-empty">${icon('file', 25)}<strong>No saved patches yet.</strong><p>Applied agent patches appear here with saved text and undo.</p></div>`}`;
    const total = Number.isSafeInteger(state.data?.total) ? state.data.total : records.length;
    $('#file-patches-count').textContent = !state.loading && !state.error && total ? `${state.offset + 1}–${state.offset + records.length} of ${total}` : '';
    for (const button of mount.querySelectorAll('[data-patch-action="previous"]')) button.disabled = state.loading || !state.offset;
    for (const button of mount.querySelectorAll('[data-patch-action="next"]')) button.disabled = state.loading || !state.data?.hasMore;
    if (state.selected && !state.loading && !state.error) renderDetail();
  }

  function renderDetail() {
    if (!active()) return;
    const target = $('#file-patch-detail'); if (!target) return;
    if (state.detailLoading) { target.innerHTML = '<p class="file-patches-note" role="status">Loading saved text…</p>'; return; }
    if (state.detailError) { target.innerHTML = `<p class="file-patches-error" role="alert">${escape(state.detailError)}</p><button class="button" data-patch-action="detail-retry" data-id="${escape(state.selected)}">Try again</button>`; return; }
    const record = state.record; if (!record || record.id !== state.selected) return;
    const comparison = patchComparison(record.before, record.after);
    const side = (value, label) => `<section><h3>${label}<small>${value.excerpt ? `Excerpt · lines ${value.fromLine}–${value.toLine} of ${value.totalLines}` : `${value.totalLines} line${value.totalLines === 1 ? '' : 's'}`}</small></h3><pre tabindex="0" aria-label="${label}">${value.omittedBefore ? '…\n' : ''}${escape(value.text || '(Empty file)')}${value.omittedAfter ? '\n…' : ''}</pre></section>`;
    const done = reversed.has(record.id), pending = undoing.has(record.id);
    target.innerHTML = `<p class="file-patch-path">${escape(record.path)}</p><div class="file-patch-actions">${canUndo(record) ? `<button class="button" data-patch-action="undo" data-id="${escape(record.id)}"${pending || done ? ' disabled' : ''}>${icon('undo', 13)}${pending ? 'Undoing…' : done ? 'Undo saved' : 'Undo'}</button>` : ''}${record.runId && onOpenRun ? `<button class="button subtle" data-patch-action="source" data-id="${escape(record.id)}">${icon('link', 13)}Source chat</button>` : ''}<span>Saved patch text</span></div>${record.status === 'prepared' ? '<p class="file-patches-note">The write receipt is incomplete. Undo checks the file before restoring it.</p>' : ''}${comparison.lineEndingsOnly ? '<p class="file-patches-note">Only line endings changed.</p>' : !comparison.changed ? '<p class="file-patches-note">The saved text is unchanged.</p>' : ''}<div class="file-patch-comparison">${side(comparison.before, 'Before')}${side(comparison.after, 'After')}</div>${comparison.before.excerpt || comparison.after.excerpt ? `<p class="file-patches-note">${comparison.changed ? 'Showing the first changed area.' : 'Showing saved text excerpts.'} Other text may be omitted; complete versions remain in the saved receipt.</p>` : ''}<details class="file-patch-receipt"><summary>Receipt details</summary><dl><dt>Patch</dt><dd>${escape(record.id)}</dd>${record.undoOf ? `<dt>Undo of</dt><dd>${escape(record.undoOf)}</dd>` : ''}<dt>Before hash</dt><dd>${escape(record.beforeHash)}</dd><dt>After hash</dt><dd>${escape(record.afterHash)}</dd></dl></details>`;
  }

  async function load() {
    const ownership = owner(), request = ++state.request; state.loading = true; state.error = ''; renderList();
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(state.offset) });
    if (state.scope === 'folder' && state.cwd) query.set('cwd', state.cwd);
    try {
      const data = await api(`/api/file-patches?${query}`); if (!owns(ownership) || request !== state.request) return;
      state.data = { ...data, patches: Array.isArray(data.patches) ? data.patches : [] };
      for (const record of state.data.patches) if (record.action === 'undo' && record.status === 'applied' && record.undoOf) reversed.add(record.undoOf);
      if (state.selected && !find(state.selected)) { state.selected = null; state.record = null; state.detailRequest++; }
    } catch (error) { if (owns(ownership) && request === state.request) state.error = error.message; }
    finally { if (owns(ownership) && request === state.request) { state.loading = false; renderList(); } }
  }

  async function readDetail(id) {
    if (!find(id) || !active()) return;
    const ownership = owner(), request = ++state.detailRequest; state.detailLoading = true; state.detailError = ''; renderDetail();
    try { const data = await api(`/api/file-patches/${encodeURIComponent(id)}`); if (!owns(ownership) || request !== state.detailRequest || state.selected !== id) return; const record = data.patch || data.record || data; if (record.id !== id || typeof record.before !== 'string' || typeof record.after !== 'string') throw new Error('BLACKICE returned an incomplete patch receipt.'); state.record = record; }
    catch (error) { if (owns(ownership) && request === state.detailRequest && state.selected === id) state.detailError = error.message; }
    finally { if (owns(ownership) && request === state.detailRequest && state.selected === id) { state.detailLoading = false; renderDetail(); } }
  }

  async function expand(id) {
    if (!find(id) || !active()) return;
    if (state.selected === id) { state.selected = null; state.record = null; state.detailRequest++; renderList(); focusRow(id); return; }
    state.selected = id; state.record = null; state.detailError = ''; state.detailLoading = true; renderList(); focusRow(id); return readDetail(id);
  }

  async function undo(id) {
    const record = state.record?.id === id ? state.record : find(id);
    if (!record || !canUndo(record) || undoing.has(id) || reversed.has(id) || !active()) return;
    const ownership = owner(); undoing.add(id); state.message = ''; renderMessage(); renderDetail();
    try {
      const result = await api(`/api/file-patches/${encodeURIComponent(id)}/undo`, 'POST', {}); reversed.add(id);
      if (!owns(ownership)) return;
      state.message = result.auditReceiptPending ? 'Undo applied. Its receipt is still being saved.' : 'Change undone.';
      await load();
    } catch (error) {
      if (!owns(ownership)) return;
      state.message = error.status === 409 ? `${error.message} Nothing was overwritten.` : error.uncertain ? 'Undo may have completed. Refresh the history before trying again.' : error.message;
    } finally { undoing.delete(id); if (owns(ownership)) { renderMessage(); renderDetail(); } else if (active() && state.selected === id) renderDetail(); }
  }

  async function open() {
    state.session++; state.request++; state.detailRequest++;
    const cwd = String(getCwd() || ''); if (cwd !== state.cwd && state.scope === 'folder') state.offset = 0; state.cwd = cwd; if (!cwd) state.scope = 'all';
    state.selected = null; state.record = null; state.data = null; state.error = ''; state.message = ''; state.detailLoading = false; state.detailError = '';
    if (!document.getElementById('relay-file-patches-styles')) { const link = document.createElement('link'); link.id = 'relay-file-patches-styles'; link.rel = 'stylesheet'; link.href = '/file-patches.css'; document.head.append(link); }
    showModal('file-patches', `<div class="modal-header"><span class="node-icon">${icon('file', 20)}</span><div class="modal-title"><h2>File changes</h2><p>Saved patches, with undo.</p></div><button class="icon-button" data-action="close-modal" aria-label="Close file changes">${icon('close', 17)}</button></div><div id="file-patches-view" class="file-patches-workspace"></div>`, true);
    mount = $('#file-patches-view'); $('#modal-root .modal')?.classList.add('file-patches-modal'); renderShell(); return load();
  }
  return { open };
}
