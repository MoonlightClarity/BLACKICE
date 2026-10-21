import { renderMarkdown } from './editor-model.mjs';

const memoryTypes = ['note', 'fact', 'assumption', 'decision'];
const relationTypes = ['supports', 'contradicts', 'informs', 'supersedes'];
const label = value => String(value || 'note').replace(/^./, first => first.toUpperCase());

/** The local, user-editable context library. Agent execution stays in the main app. */
export function initKnowledgeUI({ api, showModal, closeModal, toast, escape, getCwd, icon, onOpenRun, onOpenLearning }) {
  const $ = selector => document.querySelector(selector);
  const state = { kind: 'memory', memoryType: '', editorRelations: [], editorTargets: [], query: '', scope: 'available', deleted: false, entries: [], mode: 'list', entry: null, audit: null, revision: null, request: 0, loading: false, saving: false, error: '' };
  let searchTimer;
  const alive = () => Boolean($('#knowledge-view'));
  const kindName = () => state.kind === 'skill' ? 'skill' : 'memory';
  const scopeName = entry => entry.cwd ? 'Working folder' : 'Global';
  const normalizePath = value => String(value || '').replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
  const timeLabel = value => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Just now';
  const header = () => `<div class="modal-header"><span class="node-icon">${icon('book', 20)}</span><div class="modal-title"><h2>Memory & skills</h2><p>Useful context, with sources and undo.</p></div><button class="icon-button modal-close" data-action="close-modal" aria-label="Close knowledge library">${icon('close', 17)}</button></div>`;
  function chrome() {
    showModal('knowledge', `${header()}<div id="knowledge-view" class="knowledge-workspace"></div>`, true);
    $('#modal-root .modal')?.classList.add('knowledge-modal');
  }
  const learned = entry => String(entry.provenance?.nodeId || '').startsWith('learning-');
  const sourceName = entry => entry.provenance?.source === 'user' ? 'You' : learned(entry) ? 'Learned' : entry.provenance?.source === 'agent' ? 'Agent' : 'Local';
  function sourceActions(entry) {
    return `${entry.provenance?.runId && onOpenRun ? `<button class="button subtle" data-knowledge-action="source" data-run-id="${escape(entry.provenance.runId)}">${icon('link', 13)}Source chat</button>` : ''}${learned(entry) && onOpenLearning ? `<button class="button subtle" data-knowledge-action="evidence" data-id="${escape(entry.id)}">Review evidence</button>` : ''}`;
  }
  function provenanceLabel(entry) {
    const provenance = entry.provenance;
    if (typeof provenance === 'string') return provenance;
    if (provenance?.source === 'user') return 'Saved by you';
    if (provenance?.source === 'agent') return provenance.reason || (learned(entry) ? 'Learned after a task' : 'Saved by an agent');
    return provenance?.source || provenance?.kind || 'Saved locally';
  }
  function memoryDetails(entry, interactive = true) {
    if (entry.kind !== 'memory') return '';
    return `<section class="knowledge-memory-details" aria-label="Memory context"><p class="knowledge-memory-type">${escape(label(entry.memoryType))}<span>Classification records how this memory is used; it is not an independent check.</span></p>${entry.sources?.length ? `<h3>Sources</h3><ul>${entry.sources.map(source => `<li>${escape(source)}</li>`).join('')}</ul>` : ''}${entry.relations?.length ? `<h3>Relationships</h3><ul>${entry.relations.map(relation => {
      const target = state.entries.find(item => item.id === relation.targetId);
      return `<li>${escape(label(relation.type))} ${interactive ? `<button type="button" class="button subtle" data-knowledge-action="read" data-id="${escape(relation.targetId)}">${escape(target?.title || relation.targetId)}</button>` : escape(target?.title || relation.targetId)}</li>`;
    }).join('')}</ul><p class="field-help">Links describe context. They do not change or delete the related memory.</p>` : ''}</section>`;
  }
  function filteredEntries() {
    const cwd = normalizePath(getCwd());
    return state.entries.filter(entry => (state.kind !== 'memory' || !state.memoryType || (entry.memoryType || 'note') === state.memoryType)).filter(entry => state.scope === 'global' ? !entry.cwd : state.scope === 'workspace' ? Boolean(cwd && normalizePath(entry.cwd) === cwd) : !entry.cwd || Boolean(cwd && normalizePath(entry.cwd) === cwd));
  }
  function renderList() {
    if (!alive()) return;
    state.mode = 'list';
    $('#knowledge-view').innerHTML = `<div class="knowledge-toolbar"><div class="knowledge-tabs" role="group" aria-label="Knowledge type"><button class="${state.kind === 'memory' ? 'active' : ''}" data-knowledge-action="kind" data-kind="memory" aria-pressed="${state.kind === 'memory'}">${icon('book', 14)}Memory</button><button class="${state.kind === 'skill' ? 'active' : ''}" data-knowledge-action="kind" data-kind="skill" aria-pressed="${state.kind === 'skill'}">${icon('bolt', 14)}Skills</button></div><button class="button primary" data-knowledge-action="new">${icon('plus', 13)}New ${kindName()}</button></div><div class="knowledge-description">${state.deleted ? 'Deleted entries are not used by agents. Restore one to use it again.' : state.kind === 'memory' ? 'Facts, decisions, and preferences remembered as you work.' : 'Reusable methods learned from your work.'}</div><div class="knowledge-filters"><label class="knowledge-search">${icon('search', 14)}<input id="knowledge-search" type="search" maxlength="256" placeholder="Search ${state.kind === 'skill' ? 'skills' : 'memory'}…" aria-label="Search knowledge" value="${escape(state.query)}"></label><select id="knowledge-scope" class="knowledge-scope" aria-label="Filter knowledge scope"><option value="available"${state.scope === 'available' ? ' selected' : ''}>Folder + global</option><option value="workspace"${state.scope === 'workspace' ? ' selected' : ''}${getCwd() ? '' : ' disabled'}>This working folder</option><option value="global"${state.scope === 'global' ? ' selected' : ''}>Global only</option></select></div><div class="knowledge-library-options">${state.kind === 'memory' ? `<label class="knowledge-type-filter">Memory type<select id="knowledge-memory-filter" aria-label="Filter memory type"><option value="">All types</option>${memoryTypes.map(type => `<option value="${type}"${state.memoryType === type ? ' selected' : ''}>${label(type)}</option>`).join('')}</select></label>` : ''}<button class="button subtle ${state.deleted ? 'active' : ''}" data-knowledge-action="deleted" aria-pressed="${state.deleted}">${icon('trash', 12)}${state.deleted ? 'Show active' : 'Deleted'}</button></div><div class="knowledge-folder">${icon('folder', 12)}<span title="${escape(getCwd())}">${escape(getCwd() || 'Choose a working folder to create folder-specific knowledge.')}</span></div><div id="knowledge-results" class="knowledge-results" aria-live="polite"></div><div class="modal-footer"><span class="footer-note">Your library stays on this computer.</span><button class="button" data-action="close-modal">Done</button></div>`;
    renderResults();
  }
  function renderResults() {
    const results = $('#knowledge-results'); if (!results || state.mode !== 'list') return;
    if (state.loading) { results.innerHTML = `<div class="knowledge-empty">${icon('clock', 22)}<strong>Loading your library…</strong></div>`; return; }
    if (state.error) { results.innerHTML = `<div class="knowledge-empty"><span class="error-text">${escape(state.error)}</span><button class="button" data-knowledge-action="refresh">${icon('refresh', 13)}Try again</button></div>`; return; }
    const entries = filteredEntries();
    results.innerHTML = entries.length ? `<div class="knowledge-count">${entries.length} ${state.kind === 'skill' ? entries.length === 1 ? 'skill' : 'skills' : entries.length === 1 ? 'memory' : 'memories'}</div><div class="knowledge-list">${entries.map(entry => `<button class="knowledge-card" data-knowledge-action="read" data-id="${escape(entry.id)}"><span class="node-icon">${icon(entry.kind === 'skill' ? 'bolt' : 'book', 17)}</span><span class="knowledge-card-main"><strong>${escape(entry.title)}</strong><span>${escape(entry.summary || String(entry.content || '').split('\n').find(line => line.trim()) || 'Open to read this entry.')}</span><small><span class="knowledge-scope-tag">${scopeName(entry)}</span>${entry.kind === 'memory' ? `<span class="knowledge-type-tag">${escape(label(entry.memoryType))}</span>` : ''}<span class="knowledge-source-tag">${escape(sourceName(entry))}</span>${entry.deleted ? 'Deleted' : 'Updated'} ${escape(timeLabel(entry.updatedAt))}</small></span>${icon('chevron', 13)}</button>`).join('')}</div>` : `<div class="knowledge-empty"><span class="node-icon">${icon(state.kind === 'skill' ? 'bolt' : 'book', 28)}</span><h3>${state.query ? 'No matching entries.' : state.deleted ? 'Nothing deleted.' : state.kind === 'skill' ? 'Your playbook grows as you work.' : 'Useful context, remembered.'}</h3><p>${state.query ? 'Try another search or change the scope filter.' : state.deleted ? 'Deleted memories and skills can be restored here.' : state.kind === 'skill' ? 'Verified reusable methods appear here. Open any skill to inspect its source and changes.' : 'Durable facts and preferences appear here. Open any memory to inspect its source and changes.'}</p><button class="button" data-knowledge-action="new">${icon('plus', 13)}New ${kindName()}</button></div>`;
  }
  async function loadEntries() {
    const request = ++state.request;
    state.loading = true; state.error = ''; renderResults();
    const query = new URLSearchParams({ kind: state.kind, query: state.query, limit: '300', ...(state.deleted ? { deletedOnly: 'true' } : {}), ...(state.kind === 'memory' && state.memoryType ? { memoryType: state.memoryType } : {}) });
    if (getCwd()) query.set('cwd', getCwd());
    try {
      const data = await api(`/api/knowledge?${query}`);
      if (request !== state.request || !alive()) return;
      state.entries = Array.isArray(data) ? data : data.entries || [];
    } catch (error) { if (request === state.request) state.error = error.message; }
    finally { if (request === state.request && alive()) { state.loading = false; renderResults(); } }
  }
  function renderEntry() {
    if (!alive() || !state.entry) return;
    state.mode = 'read'; const entry = state.entry;
    $('#knowledge-view').innerHTML = `<div class="knowledge-entry-toolbar"><button class="button subtle" data-knowledge-action="back">${icon('chevron', 12)}Back</button><div><button class="button" data-knowledge-action="history">${icon('clock', 13)}Changes</button><button class="button" data-knowledge-action="edit">${icon('text', 13)}Edit</button><button class="button subtle" data-knowledge-action="delete">${icon('trash', 13)}Delete</button></div></div><article class="knowledge-entry"><div class="knowledge-entry-meta"><span class="knowledge-scope-tag">${entry.kind === 'skill' ? 'Skill' : 'Memory'}</span><span class="knowledge-scope-tag">${scopeName(entry)}</span><span class="knowledge-source-tag">${escape(sourceName(entry))}</span><span>Updated ${escape(timeLabel(entry.updatedAt))}</span></div><h2>${escape(entry.title)}</h2>${entry.summary ? `<p class="knowledge-entry-summary">${escape(entry.summary)}</p>` : ''}${entry.cwd ? `<div class="knowledge-folder">${icon('folder', 12)}<span>${escape(entry.cwd)}</span></div>` : ''}<div class="knowledge-entry-content output-document">${renderMarkdown(entry.content || '')}</div>${memoryDetails(entry)}<div class="knowledge-provenance"><span>${escape(provenanceLabel(entry))} · Revision ${Number(entry.revision) || 1}</span><div class="knowledge-source-actions">${sourceActions(entry)}</div></div></article><div class="modal-footer"><span class="footer-note">${entry.cwd ? 'Available in this working folder.' : 'Available across working folders.'}</span><button class="button" data-action="close-modal">Done</button></div>`;
  }
  async function readEntry(id) {
    if (state.deleted) return openHistory(id);
    const request = ++state.request;
    state.mode = 'loading'; $('#knowledge-view').innerHTML = `<div class="knowledge-empty">${icon('clock', 22)}<strong>Opening entry…</strong></div>`;
    try {
      const data = await api(`/api/knowledge/${encodeURIComponent(id)}`);
      if (request !== state.request || !alive()) return;
      state.entry = data.entry || data; renderEntry();
    } catch (error) { if (request === state.request && alive()) { state.error = error.message; renderList(); } }
  }
  const changeName = entry => entry.action === 'restore' ? 'Restored' : entry.deleted ? 'Deleted' : entry.action === 'create' || entry.revision === 1 ? 'Created' : 'Updated';
  function renderHistory() {
    if (!alive() || !state.audit) return;
    state.mode = 'history';
    const history = state.audit.history || [], selected = history.find(item => item.revision === state.revision) || history[0], index = history.indexOf(selected), before = history[index + 1], latest = history[0];
    if (!selected || !latest) return;
    state.revision = selected.revision;
    const snapshot = entry => !entry || entry.deleted ? `<div class="knowledge-revision-empty">${entry ? 'Deleted · unavailable to agents' : selected.revision === 1 ? 'This entry did not exist.' : 'Earlier content is no longer retained.'}</div>` : `<h4>${escape(entry.title)}</h4>${entry.summary ? `<p>${escape(entry.summary)}</p>` : ''}<pre>${escape(entry.content)}</pre>${memoryDetails(entry, false)}`;
    $('#knowledge-view').innerHTML = `<div class="knowledge-entry-toolbar"><button class="button subtle" data-knowledge-action="${state.audit.deleted ? 'back' : 'back-entry'}">${icon('chevron', 12)}Back</button><button class="icon-button" data-knowledge-action="refresh-history" aria-label="Refresh change history">${icon('refresh', 13)}</button><button class="button" data-knowledge-action="undo"${state.saving || !history[1] && (latest.deleted || latest.revision !== 1) ? ' disabled' : ''}>Undo latest change</button></div><section class="knowledge-audit"><div class="knowledge-audit-heading"><div><span class="knowledge-scope-tag">${state.audit.deleted ? 'Deleted' : 'Active'}</span><h2>${escape(latest.title)}</h2></div><label class="knowledge-revision-select"><span>Change</span><select id="knowledge-revision" aria-label="Knowledge change"${state.saving ? ' disabled' : ''}>${history.map(item => `<option value="${item.revision}"${item.revision === selected.revision ? ' selected' : ''}>${escape(`${changeName(item)} · ${sourceName(item)} · ${timeLabel(item.updatedAt)}`)}</option>`).join('')}</select></label></div><div class="knowledge-audit-source"><span>${escape(provenanceLabel(selected))} · Revision ${Number(selected.revision)}</span><div class="knowledge-source-actions">${sourceActions(selected)}</div></div>${state.error ? `<p class="knowledge-audit-error error-text" role="alert">${escape(state.error)}</p>` : ''}<div class="knowledge-revision-grid"><section><h3>Before</h3>${snapshot(before)}</section><section><h3>After${selected.deleted ? ' · deleted' : ''}</h3>${snapshot(selected)}</section></div></section><div class="modal-footer"><span class="footer-note">Latest ${state.audit.retentionLimit || 9} revisions are kept locally.</span><button class="button" data-knowledge-action="restore"${state.saving || selected.revision === state.audit.currentRevision ? ' disabled' : ''}>${state.saving ? 'Saving…' : 'Restore this revision'}</button></div>`;
  }
  async function openHistory(id) {
    const request = ++state.request; state.error = ''; state.mode = 'loading';
    $('#knowledge-view').innerHTML = `<div class="knowledge-empty">${icon('clock', 22)}<strong>Opening change history…</strong></div>`;
    try {
      const data = await api(`/api/knowledge/${encodeURIComponent(id)}/history`);
      if (request !== state.request || !alive()) return;
      state.audit = data; state.entry = data.history?.[0] || state.entry; state.revision = data.currentRevision; renderHistory();
    } catch (error) { if (request === state.request && alive()) { state.error = error.message; renderList(); } }
  }
  async function restoreRevision(undo = false) {
    if (state.saving || !state.audit) return;
    const audit = state.audit, revision = undo ? audit.history?.[1]?.revision : state.revision, latest = audit.history?.[0], request = ++state.request;
    if (undo && !revision && latest?.revision !== 1) return;
    if (!revision && latest?.deleted) return;
    state.saving = true; state.error = ''; renderHistory();
    try {
      if (revision) await api(`/api/knowledge/${encodeURIComponent(audit.entryId)}/restore`, 'POST', { revision, expectedRevision: audit.currentRevision });
      else await api(`/api/knowledge/${encodeURIComponent(audit.entryId)}`, 'DELETE', { expectedRevision: audit.currentRevision });
      if (request !== state.request || !alive()) return;
      state.saving = false; toast(undo ? 'Latest change undone.' : 'Revision restored.'); await openHistory(audit.entryId);
    } catch (error) { if (request === state.request && alive()) { state.error = error.message; state.saving = false; renderHistory(); } }
    finally { state.saving = false; }
  }
  function renderEditorRelations() {
    const target = $('#knowledge-relation-list'); if (!target) return;
    target.innerHTML = state.editorRelations.length ? `<ul>${state.editorRelations.map((relation, index) => `<li><span>${escape(label(relation.type))} <strong>${escape(state.editorTargets.find(item => item.id === relation.targetId)?.title || relation.targetId)}</strong></span><button class="button subtle" type="button" data-knowledge-action="remove-relation" data-index="${index}" aria-label="Remove ${escape(relation.type)} relationship">Remove</button></li>`).join('')}</ul>` : '<p class="field-help">No related memories yet.</p>';
  }
  function renderRelationChoices() {
    const target = $('#knowledge-relation-target'); if (!target) return;
    const selected = target.value, globalOnly = $('#knowledge-edit-scope')?.value === 'global';
    target.innerHTML = `<option value="">Choose a memory…</option>${state.editorTargets.filter(item => item.kind === 'memory' && !item.deleted && item.id !== state.entry?.id && (!globalOnly || !item.cwd)).map(item => `<option value="${escape(item.id)}"${item.id === selected ? ' selected' : ''}>${escape(item.title)} · ${scopeName(item)}</option>`).join('')}`;
  }
  async function loadRelationChoices(request) {
    const query = new URLSearchParams({ kind: 'memory', limit: '300' }); if (getCwd()) query.set('cwd', getCwd());
    try {
      const data = await api(`/api/knowledge?${query}`);
      if (request !== state.request || state.mode !== 'edit' || !alive()) return;
      state.editorTargets = Array.isArray(data) ? data : data.entries || []; renderRelationChoices(); renderEditorRelations();
    } catch (error) { if (request === state.request && state.mode === 'edit' && $('#knowledge-relation-error')) $('#knowledge-relation-error').textContent = `Could not load related memories: ${error.message}`; }
  }
  function renderEditor(entry = null) {
    if (!alive()) return;
    state.request++; state.mode = 'edit'; state.entry = entry; state.editorRelations = (entry?.relations || []).map(item => ({ ...item })); state.editorTargets = state.entries;
    const cwd = getCwd(), scoped = entry ? Boolean(entry.cwd) : Boolean(cwd), kind = entry?.kind || state.kind;
    $('#knowledge-view').innerHTML = `<form id="knowledge-editor" class="knowledge-editor"><div class="knowledge-entry-toolbar"><button class="button subtle" type="button" data-knowledge-action="cancel-edit">${icon('chevron', 12)}${entry ? 'Back to entry' : 'Back to library'}</button><span class="badge">${entry ? 'Edit' : 'New'} ${kind === 'skill' ? 'skill' : 'memory'}</span></div><div class="knowledge-editor-fields"><label class="field"><span class="field-label">Title</span><input id="knowledge-title" name="title" value="${escape(entry?.title || '')}" placeholder="${kind === 'skill' ? 'e.g. Review a pull request' : 'e.g. Project conventions'}" maxlength="120" required></label><div class="knowledge-editor-row"><label class="field"><span class="field-label">Type</span><select id="knowledge-kind" name="kind"${entry ? ' disabled' : ''}><option value="memory"${kind === 'memory' ? ' selected' : ''}>Memory</option><option value="skill"${kind === 'skill' ? ' selected' : ''}>Skill</option></select></label><label class="field"><span class="field-label">Use in</span><select id="knowledge-edit-scope" name="scope"><option value="workspace"${scoped ? ' selected' : ''}${cwd ? '' : ' disabled'}>This working folder</option><option value="global"${scoped ? '' : ' selected'}>Every working folder</option></select></label></div><label class="field"><span class="field-label">Short description <span class="optional">OPTIONAL</span></span><input id="knowledge-summary" name="summary" value="${escape(entry?.summary || '')}" placeholder="When should an agent use this?" maxlength="400"></label><label class="field"><span class="field-label">Content</span><textarea id="knowledge-content" name="content" rows="12" maxlength="${kind === 'skill' ? 40000 : 8000}" spellcheck="false" placeholder="${kind === 'skill' ? 'Describe the steps, useful context, and how to verify success…' : 'Write the facts, preferences, or decisions your agents should remember…'}" required>${escape(entry?.content || '')}</textarea><span class="field-help">Markdown is supported. You can edit this whenever your context changes.</span></label><section id="knowledge-memory-fields" class="knowledge-memory-fields"${kind === 'skill' ? ' hidden' : ''}><label class="field"><span class="field-label">Memory type</span><select id="knowledge-memory-type" name="memoryType">${memoryTypes.map(type => `<option value="${type}"${(entry?.memoryType || 'note') === type ? ' selected' : ''}>${label(type)}</option>`).join('')}</select><span class="field-help">Use Assumption for uncertain premises and Decision for recorded choices.</span></label><label class="field"><span class="field-label">Sources <span class="optional">OPTIONAL</span></span><textarea id="knowledge-sources" rows="3" maxlength="40020" placeholder="One URL, file location, or citation per line">${escape((entry?.sources || []).join('\n'))}</textarea><span class="field-help">Up to 20 references. References are saved as text and are not opened automatically.</span></label><fieldset class="knowledge-relations-editor"><legend>Related memories</legend><div id="knowledge-relation-list"></div><div class="knowledge-relation-controls"><label class="field"><span class="field-label">This memory</span><select id="knowledge-relation-type">${relationTypes.map(type => `<option value="${type}">${label(type)}</option>`).join('')}</select></label><label class="field"><span class="field-label">Related memory</span><select id="knowledge-relation-target"><option value="">Choose a memory…</option></select></label><button class="button" type="button" data-knowledge-action="add-relation">Add relationship</button></div><p id="knowledge-relation-error" class="error-text" role="alert"></p></fieldset></section><p id="knowledge-editor-error" class="error-text" role="alert"></p></div><div class="modal-footer"><span class="footer-note">Saved locally and available to your agents.</span><button class="button" type="button" data-knowledge-action="cancel-edit">Cancel</button><button class="button primary" type="submit">${icon('save', 13)}Save ${kind === 'skill' ? 'skill' : 'memory'}</button></div></form>`;
    renderRelationChoices(); renderEditorRelations(); void loadRelationChoices(state.request);
    const editor = $('#knowledge-editor'), focusRequest = state.request;
    requestAnimationFrame(() => {
      if (focusRequest === state.request && state.mode === 'edit' && $('#knowledge-editor') === editor
          && (!document.activeElement || document.activeElement === document.body)) $('#knowledge-title')?.focus({ preventScroll: true });
    });
  }
  async function saveEntry(form) {
    if (state.saving) return;
    const title = $('#knowledge-title').value.trim(), content = $('#knowledge-content').value.trim(), kind = $('#knowledge-kind').value;
    if (!title || !content) return;
    if (content.length > (kind === 'skill' ? 40000 : 8000)) { $('#knowledge-editor-error').textContent = `${kind === 'skill' ? 'Skill' : 'Memory'} content can contain at most ${(kind === 'skill' ? 40000 : 8000).toLocaleString()} characters.`; return; }
    const cwd = $('#knowledge-edit-scope').value === 'workspace' ? getCwd() : null;
    if ($('#knowledge-edit-scope').value === 'workspace' && !cwd) { $('#knowledge-editor-error').textContent = 'Choose a working folder in workflow settings first.'; return; }
    const button = form.querySelector('button[type="submit"]'), request = ++state.request; state.saving = true; button.disabled = true; button.textContent = 'Saving…';
    try {
      const payload = { ...(state.entry?.id ? { id: state.entry.id, expectedRevision: state.entry.revision } : {}), kind, title, summary: $('#knowledge-summary').value.trim(), content, cwd, ...(kind === 'memory' ? { memoryType: $('#knowledge-memory-type')?.value || 'note', sources: String($('#knowledge-sources')?.value || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean), relations: state.editorRelations.map(item => ({ ...item })) } : {}) };
      const data = await api('/api/knowledge', 'POST', payload);
      if (request !== state.request || !alive()) return;
      state.entry = data.entry || data; state.kind = kind; state.deleted = false; state.error = ''; renderEntry(); toast(`${kind === 'skill' ? 'Skill' : 'Memory'} saved.`);
    } catch (error) { if (request === state.request && state.mode === 'edit' && alive() && $('#knowledge-editor-error')) $('#knowledge-editor-error').textContent = error.message; }
    finally { state.saving = false; if (button.isConnected) { button.disabled = false; button.innerHTML = `${icon('save', 13)}Save ${kind === 'skill' ? 'skill' : 'memory'}`; } }
  }
  async function deleteEntry(button) {
    if (!state.entry || state.saving) return;
    button.disabled = true; state.saving = true; const entry = state.entry, request = ++state.request;
    try { await api(`/api/knowledge/${encodeURIComponent(entry.id)}`, 'DELETE', { expectedRevision: entry.revision }); if (request === state.request && alive()) { state.saving = false; state.error = ''; toast(`${entry.kind === 'skill' ? 'Skill' : 'Memory'} deleted. You can undo it here.`); await openHistory(entry.id); } }
    catch (error) { if (request === state.request && alive()) { toast(error.message, true); if (button.isConnected) button.disabled = false; } }
    finally { state.saving = false; }
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-knowledge-action]'); if (!button || !alive()) return;
    clearTimeout(searchTimer);
    const action = button.dataset.knowledgeAction;
    if (action === 'kind') { state.kind = button.dataset.kind; state.entry = null; renderList(); await loadEntries(); }
    if (action === 'new') renderEditor();
    if (action === 'add-relation' && state.mode === 'edit' && !state.saving) {
      const type = $('#knowledge-relation-type')?.value, targetId = $('#knowledge-relation-target')?.value, error = $('#knowledge-relation-error');
      if (!relationTypes.includes(type) || !targetId) { if (error) error.textContent = 'Choose a related memory first.'; return; }
      if (state.editorRelations.length >= 20) { if (error) error.textContent = 'A memory can have up to 20 relationships.'; return; }
      if (state.editorRelations.some(item => item.type === type && item.targetId === targetId)) { if (error) error.textContent = 'This relationship is already included.'; return; }
      state.editorRelations.push({ type, targetId }); if (error) error.textContent = ''; renderEditorRelations();
    }
    if (action === 'remove-relation' && state.mode === 'edit' && !state.saving) { const index = Number(button.dataset.index); if (Number.isSafeInteger(index) && index >= 0 && index < state.editorRelations.length) { state.editorRelations.splice(index, 1); renderEditorRelations(); } }
    if (action === 'read') await readEntry(button.dataset.id);
    if (action === 'edit') renderEditor(state.entry);
    if (action === 'delete') await deleteEntry(button);
    if (action === 'history' && state.entry) await openHistory(state.entry.id);
    if (action === 'refresh-history' && state.audit) await openHistory(state.audit.entryId);
    if (action === 'restore') await restoreRevision();
    if (action === 'undo') await restoreRevision(true);
    if (action === 'back-entry') renderEntry();
    if (action === 'deleted') { state.deleted = !state.deleted; state.entry = null; state.error = ''; renderList(); await loadEntries(); }
    if (action === 'source' && button.dataset.runId) { try { await onOpenRun?.(button.dataset.runId); } catch (error) { toast(error.message, true); } }
    if (action === 'evidence' && button.dataset.id) { try { await onOpenLearning?.({ knowledgeId: button.dataset.id }); } catch (error) { toast(error.message, true); } }
    if (action === 'refresh') await loadEntries();
    if (action === 'back') { state.entry = null; state.error = ''; renderList(); await loadEntries(); }
    if (action === 'cancel-edit') { if (state.entry) renderEntry(); else { state.error = ''; renderList(); await loadEntries(); } }
  });
  document.addEventListener('input', event => {
    if (event.target.id !== 'knowledge-search' || !alive()) return;
    state.query = event.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(loadEntries, 180);
  });
  document.addEventListener('change', event => { if (event.target.id === 'knowledge-memory-filter' && alive()) { state.memoryType = event.target.value; void loadEntries(); } if (event.target.id === 'knowledge-edit-scope' && alive()) renderRelationChoices(); if (event.target.id === 'knowledge-revision' && alive()) { state.revision = Number(event.target.value); renderHistory(); } if (event.target.id === 'knowledge-scope' && alive()) { state.scope = event.target.value; renderResults(); } if (event.target.id === 'knowledge-kind' && alive()) { const skill = event.target.value === 'skill'; if ($('#knowledge-memory-fields')) $('#knowledge-memory-fields').hidden = skill; $('#knowledge-content').maxLength = skill ? 40000 : 8000; $('#knowledge-editor button[type="submit"]').innerHTML = `${icon('save', 13)}Save ${skill ? 'skill' : 'memory'}`; } });
  document.addEventListener('submit', async event => { if (event.target.id === 'knowledge-editor' && alive()) { event.preventDefault(); await saveEntry(event.target); } });
  document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && state.mode === 'edit' && alive()) { event.preventDefault(); $('#knowledge-editor')?.requestSubmit(); } });
  return {
    async open() { clearTimeout(searchTimer); state.entry = null; state.error = ''; state.mode = 'list'; chrome(); renderList(); requestAnimationFrame(() => $('#knowledge-search')?.focus({ preventScroll: true })); await loadEntries(); },
    refresh() { if (alive() && state.mode === 'list') return loadEntries(); },
    close() { state.request++; clearTimeout(searchTimer); closeModal(); }
  };
}
