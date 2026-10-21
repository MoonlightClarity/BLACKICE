import { renderMarkdown } from './editor-model.mjs';
import { createDraftStore, draftKey } from './draft-store.mjs';
import { writeClipboard, clipboardFailureMessage } from './clipboard.mjs';

/** Explicit, editable global persona/profile files. No approval or staging state. */
export function initIdentityUI({ api, showModal, closeModal, toast, escape, icon, draftStore = createDraftStore() }) {
  const $ = selector => document.querySelector(selector);
  const state = { kind: 'soul', documents: {}, drafts: {}, bases: {}, persisted: {}, restored: {}, storageErrors: {}, versions: {}, incoming: {}, recoveredDraft: {}, previousPersisted: {}, preview: false, history: false, saving: false, request: 0, error: '' };
  const names = { soul: 'SOUL.md', user: 'USER.md' };
  const limits = { soul: 64000, user: 96000 };
  const alive = () => Boolean($('#identity-view'));
  const current = () => state.documents[state.kind];
  const dirty = kind => state.documents[kind] && state.drafts[kind] !== state.documents[kind].content;
  const baseOf = doc => ({ revision: doc.revision, hash: doc.diskHash || doc.hash });
  const localKey = kind => draftKey('identity', kind, state.documents[kind]?.path || names[kind]);
  const localRecord = kind => ({ content: state.drafts[kind], base: state.bases[kind] || baseOf(state.documents[kind]) });
  function persistDraft(kind = state.kind) {
    if (!state.documents[kind]) return;
    if (!dirty(kind)) { if (state.persisted[kind]) draftStore.remove(localKey(kind), { expected: state.persisted[kind] }); delete state.persisted[kind]; delete state.restored[kind]; delete state.storageErrors[kind]; return; }
    const result = draftStore.save(localKey(kind), localRecord(kind)); state.persisted[kind] = result.data; state.storageErrors[kind] = result.error || '';
  }
  function recoverLocalDraft(kind, doc) {
    const cached = draftStore.load(localKey(kind));
    if (cached && typeof cached.data.content === 'string' && cached.data.content.length <= limits[kind]) {
      if (cached.data.content === doc.content) draftStore.remove(localKey(kind), { expected: cached.data });
      else {
        state.drafts[kind] = cached.data.content; state.persisted[kind] = cached.data; state.restored[kind] = true;
        state.bases[kind] = cached.data.base || { revision: -1, hash: '' };
        if (state.bases[kind].revision !== doc.revision || state.bases[kind].hash !== (doc.diskHash || doc.hash)) state.incoming[kind] = doc;
      }
    }
    const previous = draftStore.load(localKey(kind) + ':previous');
    if (typeof previous?.data.content === 'string' && previous.data.content.length <= limits[kind]) { state.recoveredDraft[kind] = previous.data.content; state.previousPersisted[kind] = previous.data; }
  }
  function preservePrevious(kind, content) { state.recoveredDraft[kind] = content; const result = draftStore.save(localKey(kind) + ':previous', { content }); if (result.saved) state.previousPersisted[kind] = result.data; }
  function removePrevious(kind) { if (state.previousPersisted[kind]) draftStore.remove(localKey(kind) + ':previous', { expected: state.previousPersisted[kind] }); delete state.previousPersisted[kind]; }
  function renderDraftNotice() {
    if (!current() || !$('#identity-save-state')) return;
    if (!$('#identity-draft-notice')) $('#identity-save-state').closest('.identity-save-row')?.insertAdjacentHTML('beforebegin', '<div id="identity-draft-notice" class="identity-save-row" role="status"></div>');
    const notice = $('#identity-draft-notice'); if (!notice) return;
    notice.hidden = !dirty(state.kind) && !state.storageErrors[state.kind];
    notice.innerHTML = `<span>${escape(state.storageErrors[state.kind] || (state.restored[state.kind] ? 'Draft restored.' : ''))}</span>${dirty(state.kind) ? `<button class="button subtle" type="button" data-identity-action="discard-draft"${state.saving ? ' disabled' : ''}>Discard draft</button>` : ''}`;
  }
  const date = value => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not recorded';
  const origin = source => ({ seed: 'BLACKICE starter', user: 'Edited by you', agent: 'Agent update', learning: 'Learned from a user statement', external: 'Edited on disk', recovery: 'Recovered file', unavailable: 'File unavailable' }[source] || source || 'Saved locally');
  function header() { return `<div class="modal-header"><span class="identity-header-icon">${icon('identity', 26)}</span><div class="modal-title"><h2>Identity & profile</h2><p>BLACKICE’s lasting character, and what it actually knows about you.</p></div><button class="icon-button" data-action="close-modal" aria-label="Close identity and profile">${icon('close', 17)}</button></div>`; }
  function render() {
    if (!alive()) return;
    const doc = current(), incoming = state.incoming[state.kind];
    $('#identity-view').innerHTML = `<div class="identity-toolbar"><div class="identity-tabs" role="tablist" aria-label="Identity files">${['soul', 'user'].map(kind => `<button role="tab" aria-selected="${state.kind === kind}" data-identity-action="tab" data-kind="${kind}" class="${state.kind === kind ? 'active' : ''}">${icon(kind === 'soul' ? 'identity' : 'agent', 15)}${kind === 'soul' ? 'Soul' : 'User profile'}</button>`).join('')}</div><button class="button subtle" data-identity-action="history" aria-pressed="${state.history}">${icon('clock', 13)}Version history</button></div>${doc ? `<div class="identity-file-heading"><div><strong>${names[state.kind]}</strong><span>${state.kind === 'soul' ? 'Global personality, voice, and working style.' : 'Confirmed facts and preferences. Unknown details stay unknown.'}</span></div><button class="icon-button" data-identity-action="copy-path" title="Copy file path" aria-label="Copy identity file path">${icon('copy', 13)}</button></div><div class="identity-file-path" title="${escape(doc.path || '')}">${escape(doc.path || names[state.kind])}</div>${doc.warning ? `<div class="identity-notice error-text">${escape(doc.warning)}</div>` : ''}${incoming ? `<div class="identity-conflict"><strong>The file has a newer disk version.</strong><p>Your draft is kept. Choose which text to continue editing.</p><div><button class="button" data-identity-action="use-disk">Use file version</button><button class="button" data-identity-action="keep-draft">Keep my draft</button></div></div>` : ''}<div class="identity-content-layout${state.history ? ' with-history' : ''}"><form id="identity-editor" class="identity-editor"><div class="identity-editor-heading"><label for="identity-content">${state.preview ? 'Preview' : 'Markdown'}</label><div><span id="identity-count">${(state.drafts[state.kind] || '').length.toLocaleString()} / ${limits[state.kind].toLocaleString()}</span><button class="button subtle" type="button" data-identity-action="preview" aria-pressed="${state.preview}">${icon(state.preview ? 'code' : 'eye', 13)}${state.preview ? 'Edit' : 'Preview'}</button></div></div>${state.preview ? `<div class="identity-preview output-document">${state.drafts[state.kind] ? renderMarkdown(state.drafts[state.kind]) : '<p>This file is empty.</p>'}</div>` : `<textarea id="identity-content" name="content" maxlength="${limits[state.kind]}" spellcheck="false" aria-label="${names[state.kind]} Markdown">${escape(state.drafts[state.kind] ?? doc.content)}</textarea>`}<p id="identity-error" class="identity-error error-text" role="alert">${escape(state.error)}</p><div class="identity-save-row"><div><strong id="identity-save-state">${dirty(state.kind) ? 'Unsaved changes' : `Revision ${doc.revision}`}</strong><span>${escape(origin(doc.provenance?.source))} · ${escape(date(doc.updatedAt))}</span></div><button class="button" type="button" data-identity-action="reload">${icon('refresh', 13)}Reload file</button><button class="button primary" type="submit"${state.saving || incoming || !dirty(state.kind) ? ' disabled' : ''}>${icon('save', 13)}${state.saving ? 'Saving…' : 'Save changes'}</button></div>${state.recoveredDraft[state.kind] != null ? '<button class="button subtle identity-recover-draft" type="button" data-identity-action="recover-draft">Recover previous unsaved draft</button>' : ''}</form>${state.history ? `<aside class="identity-history" aria-label="Saved identity revisions"><div class="identity-history-heading"><strong>Saved revisions</strong><span>${names[state.kind]}</span></div><div id="identity-version-list">${historyHTML()}</div></aside>` : ''}</div><div class="identity-footer"><span>${icon('info', 12)}Changes apply to the next agent turn. Current turns keep their original snapshot.</span><button class="button" data-action="close-modal">Done</button></div>` : `<div class="identity-empty">${state.error ? `<p class="error-text">${escape(state.error)}</p><button class="button" data-identity-action="reload">Try again</button>` : `<span>${icon('identity', 30)}</span><p>Loading the real identity files…</p>`}</div>`}`;
    renderDraftNotice();
  }
  function historyHTML() {
    const versions = state.versions[state.kind]; if (!versions) return '<p class="field-help">Loading history…</p>';
    return versions.length ? versions.map(version => `<div class="identity-version"><div><strong>Revision ${version.revision}${version.current ? ' · current' : ''}</strong><small>${escape(origin(version.provenance?.source))} · ${escape(date(version.updatedAt))}</small><span>${Number(version.chars || 0).toLocaleString()} characters${version.provenance?.restoredFrom ? ` · restored from ${version.provenance.restoredFrom}` : ''}</span></div>${version.provenance?.sourceQuote ? `<details class="identity-version-source"><summary>Source statement</summary><p>${escape(version.provenance.sourceQuote)}</p>${version.provenance.sourceRunId || version.provenance.runId ? `<code>${escape(version.provenance.sourceRunId || version.provenance.runId)}</code>` : ''}</details>` : ''}<button class="button subtle" data-identity-action="restore" data-revision="${version.revision}"${version.current || state.saving ? ' disabled' : ''}>${icon('refresh', 12)}Restore this version</button></div>`).join('') : '<p class="field-help">No saved revisions yet.</p>';
  }
  async function load({ all = false } = {}) {
    const request = ++state.request, kind = state.kind;
    try {
      const data = await api(all ? '/api/identity' : `/api/identity/${kind}`); if (request !== state.request || !alive()) return;
      const docs = all ? data.documents || data : { [kind]: data.document || data };
      for (const key of ['soul', 'user']) if (docs[key]) {
        const doc = docs[key], previous = state.documents[key], wasDirty = dirty(key);
        if (previous && wasDirty && (doc.revision !== previous.revision || doc.diskHash !== previous.diskHash)) state.incoming[key] = doc;
        else { state.documents[key] = doc; if (!previous || !wasDirty) { state.drafts[key] = doc.content; state.bases[key] = baseOf(doc); if (!previous) recoverLocalDraft(key, doc); } }
      }
      state.error = ''; render(); if (state.history) await loadHistory();
    } catch (error) { if (request === state.request && alive()) { state.error = error.message; render(); } }
  }
  async function loadHistory() {
    const kind = state.kind;
    try { const data = await api(`/api/identity/${kind}/versions`); state.versions[kind] = Array.isArray(data) ? data : data.versions || []; if (alive() && kind === state.kind && $('#identity-version-list')) $('#identity-version-list').innerHTML = historyHTML(); }
    catch (error) { if ($('#identity-version-list')) $('#identity-version-list').textContent = error.message; }
  }
  async function save() {
    const doc = current(), kind = state.kind; if (!doc || !dirty(kind) || state.saving || state.incoming[kind]) return;
    state.saving = true; state.error = ''; const request = ++state.request;
    const payload = { content: state.drafts[kind], expectedRevision: doc.revision, expectedHash: doc.diskHash || doc.hash }, submitted = localRecord(kind), key = localKey(kind); render();
    try { const data = await api(`/api/identity/${kind}`, 'PUT', payload); const saved = data.document || data; draftStore.remove(key, { expected: submitted }); if (!state.documents[kind] || state.documents[kind].revision <= saved.revision) { state.documents[kind] = saved; state.bases[kind] = baseOf(saved); if (state.drafts[kind] === payload.content) state.drafts[kind] = saved.content; delete state.incoming[kind]; state.versions[kind] = null; persistDraft(kind); } if (alive()) toast(`${names[kind]} saved · revision ${saved.revision}.`); }
    catch (error) { if (request === state.request) state.error = error.message; }
    finally { state.saving = false; if (request === state.request && alive()) { render(); if (state.history) await loadHistory(); } }
  }
  async function restore(revision) {
    const kind = state.kind, doc = current(); if (!doc || state.saving) return; state.saving = true; state.error = ''; const request = ++state.request;
    if (dirty(kind)) preservePrevious(kind, state.drafts[kind]); render();
    try { const data = await api(`/api/identity/${kind}/restore`, 'POST', { revision, expectedRevision: doc.revision, expectedHash: doc.diskHash || doc.hash }); if (request !== state.request || !alive()) return; const saved = data.document || data; if (dirty(kind)) preservePrevious(kind, state.drafts[kind]); state.documents[kind] = saved; state.drafts[kind] = saved.content; state.bases[kind] = baseOf(saved); delete state.incoming[kind]; state.versions[kind] = null; persistDraft(kind); toast(saved.revision === doc.revision ? `File already matches revision ${revision}.` : `Restored revision ${revision} as revision ${saved.revision}.`); }
    catch (error) { if (request === state.request) state.error = error.message; }
    finally { state.saving = false; if (request === state.request && alive()) { render(); await loadHistory(); } }
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-identity-action]'); if (!button || !alive()) return; const action = button.dataset.identityAction;
    if (action === 'tab') { state.kind = button.dataset.kind; state.preview = false; state.error = ''; render(); if (!current()) await load(); else if (state.history) await loadHistory(); }
    if (action === 'preview') { state.preview = !state.preview; render(); }
    if (action === 'history') { state.history = !state.history; render(); if (state.history) await loadHistory(); }
    if (action === 'reload') { if (!current()) await load({ all: true }); else await load(); }
    if (action === 'use-disk') { const incoming = state.incoming[state.kind]; if (incoming) { preservePrevious(state.kind, state.drafts[state.kind]); state.documents[state.kind] = incoming; state.drafts[state.kind] = incoming.content; state.bases[state.kind] = baseOf(incoming); delete state.incoming[state.kind]; state.error = ''; persistDraft(); render(); } }
    if (action === 'keep-draft') { if (state.incoming[state.kind]) { state.documents[state.kind] = state.incoming[state.kind]; state.bases[state.kind] = baseOf(current()); delete state.incoming[state.kind]; state.error = ''; persistDraft(); render(); } }
    if (action === 'recover-draft') { state.drafts[state.kind] = state.recoveredDraft[state.kind]; delete state.recoveredDraft[state.kind]; removePrevious(state.kind); state.bases[state.kind] = baseOf(current()); state.preview = false; persistDraft(); render(); }
    if (action === 'discard-draft' && !state.saving) { const doc = state.incoming[state.kind] || current(); state.documents[state.kind] = doc; state.drafts[state.kind] = doc.content; state.bases[state.kind] = baseOf(doc); delete state.incoming[state.kind]; delete state.recoveredDraft[state.kind]; removePrevious(state.kind); persistDraft(); state.error = ''; render(); }
    if (action === 'restore') await restore(Number(button.dataset.revision));
    if (action === 'copy-path') { try { await writeClipboard(current()?.path || names[state.kind]); toast('Identity file path copied.'); } catch (error) { toast(clipboardFailureMessage(error, 'Copy is unavailable here. Select the file path above and use your device’s Copy command.'), true); } }
  });
  document.addEventListener('input', event => { if (event.target.id !== 'identity-content' || !alive()) return; state.drafts[state.kind] = event.target.value; persistDraft(); $('#identity-count').textContent = `${event.target.value.length.toLocaleString()} / ${limits[state.kind].toLocaleString()}`; $('#identity-save-state').textContent = dirty(state.kind) ? 'Unsaved changes' : `Revision ${current().revision}`; const button = $('#identity-editor button[type="submit"]'); button.disabled = state.saving || Boolean(state.incoming[state.kind]) || !dirty(state.kind); renderDraftNotice(); });
  document.addEventListener('submit', async event => { if (event.target.id === 'identity-editor' && alive()) { event.preventDefault(); await save(); } });
  document.addEventListener('keydown', event => {
    if (!alive()) return;
    if ((event.ctrlKey || event.metaKey) && ['s', 'enter'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); save(); }
    if (event.target.closest('.identity-tabs') && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const other = state.kind === 'soul' ? 'user' : 'soul'; $(`[data-identity-action="tab"][data-kind="${other}"]`)?.click(); $(`[data-identity-action="tab"][data-kind="${other}"]`)?.focus({ preventScroll: true }); }
  }, true);
  return { async open(kind = state.kind) { state.request++; state.kind = ['soul', 'user'].includes(kind) ? kind : 'soul'; state.error = ''; showModal('identity', `${header()}<div id="identity-view" class="identity-workspace"></div>`, true); $('#modal-root .modal')?.classList.add('identity-modal'); render(); await load({ all: true }); }, close() { state.request++; closeModal(); } };
}

let controller;
export async function openIdentity(options) { controller ||= initIdentityUI(options); return controller.open(options.kind); }
