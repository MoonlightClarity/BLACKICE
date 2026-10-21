import { promptTemplateFields, renderPromptTemplate, validatePromptTemplate, PROMPT_TEMPLATE_LIMITS } from './prompt-template-model.mjs';
import { createDraftStore } from './draft-store.mjs';

const clone = value => structuredClone(value);
const newSection = () => ({ id: `section_${crypto.randomUUID().replaceAll('-', '')}`, title: '', content: '', level: 0 });
const cleanAuthoring = template => ({ title: template.title, description: template.description || '', sections: clone(template.sections) });

/** A section and all of its descendants form one movable outline branch. */
export function outlineBranch(sections, index) {
  if (!Array.isArray(sections) || !Number.isSafeInteger(index) || index < 0 || index >= sections.length) throw new Error('Choose an outline section.');
  const level = sections[index].level; let end = index + 1;
  while (end < sections.length && sections[end].level > level) end++;
  let previous = index - 1; while (previous >= 0 && sections[previous].level > level) previous--;
  return { start: index, end, previous: previous >= 0 && sections[previous].level === level ? previous : null, next: end < sections.length && sections[end].level === level ? end : null };
}

export function outlineDepthBounds(sections, index) {
  const { end } = outlineBranch(sections, index), level = sections[index].level;
  if (!index) return { min: 0, max: 0 };
  const relativeDepth = Math.max(...sections.slice(index, end).map(section => section.level - level));
  return { min: 0, max: Math.min(4 - relativeDepth, sections[index - 1].level + 1) };
}

export function moveOutlineBranch(sections, index, direction) {
  const branch = outlineBranch(sections, index), result = sections.map(section => ({ ...section }));
  if (direction === 'up' && branch.previous !== null) {
    const selected = result.slice(index, branch.end), preceding = result.slice(branch.previous, index);
    result.splice(branch.previous, branch.end - branch.previous, ...selected, ...preceding); return { sections: result, index: branch.previous };
  }
  if (direction === 'down' && branch.next !== null) {
    const nextEnd = outlineBranch(sections, branch.next).end, selected = result.slice(index, branch.end), following = result.slice(branch.next, nextEnd);
    result.splice(index, nextEnd - index, ...following, ...selected); return { sections: result, index: index + following.length };
  }
  return { sections: result, index };
}

export function insertOutlineSibling(sections, index, section) {
  const { end } = outlineBranch(sections, index), result = sections.map(item => ({ ...item }));
  result.splice(end, 0, { ...section, level: sections[index].level }); return { sections: result, index: end };
}

export function removeOutlineBranch(sections, index, replacement = newSection()) {
  const { end } = outlineBranch(sections, index), result = sections.map(section => ({ ...section })); result.splice(index, end - index);
  if (!result.length) return { sections: [{ ...replacement, level: 0 }], index: 0 };
  return { sections: result, index: Math.min(index, result.length - 1) };
}

export function setOutlineDepth(sections, index, requestedLevel) {
  if (!Number.isSafeInteger(requestedLevel)) throw new Error('Choose a section depth.');
  const { end } = outlineBranch(sections, index), bounds = outlineDepthBounds(sections, index), target = Math.max(bounds.min, Math.min(bounds.max, requestedLevel)), delta = target - sections[index].level;
  const result = sections.map((section, position) => ({ ...section, level: section.level + (position >= index && position < end ? delta : 0) }));
  if (delta < 0) {
    // Lift the complete branch after its target ancestor's remaining children.
    // Former siblings keep their parent instead of becoming the lifted node's children.
    let ancestor = index - 1; while (ancestor >= 0 && sections[ancestor].level !== target) ancestor--;
    const ancestorEnd = outlineBranch(sections, ancestor).end, selected = result.splice(index, end - index), nextIndex = ancestorEnd - selected.length;
    result.splice(nextIndex, 0, ...selected); return { sections: result, index: nextIndex };
  }
  return { sections: result, index };
}

/** Optional prompt authoring. Filled values never enter the saved library. */
export function initPromptsUI({ api, showModal, closeModal, toast, escape, icon, captureDraft, applyDraft, draftStore = createDraftStore({ prefix: 'relay.prompt-draft.v1:' }) }) {
  let session = 0, state = null;
  const windowId = crypto.randomUUID();
  const current = owner => state === owner && owner.session === session && document.getElementById('prompt-workspace') === owner.mount;
  const $ = selector => state?.mount?.querySelector(selector);
  const fail = error => { if (!state) return; state.error = error?.message || String(error); renderNotice(); };
  const editable = owner => Boolean(owner.template && !owner.busy);
  function stash(owner) {
    if (!owner?.template || !owner.authorDirty) return;
    owner.draftKey ||= `${owner.template.id || crypto.randomUUID()}:${windowId}`;
    const data = { template: clone(owner.template), section: owner.section };
    const receipt = draftStore.save(owner.draftKey, data); owner.cachedDraft = data;
    if (!receipt.persistent && !owner.error) owner.error = receipt.error;
  }
  const filtered = owner => owner.templates.filter(template => Boolean(template.deleted) === Boolean(owner.trash) && `${template.title} ${template.description || ''} ${(template.fields || []).map(field => field.key).join(' ')}`.toLowerCase().includes(owner.query.toLowerCase().trim()));
  function renderNotice() { const node = $('#prompt-error'); if (node) { node.hidden = !state.error; node.textContent = state.error; } }
  function renderLibrary() {
    const owner = state, rows = filtered(owner), list = $('#prompt-library'); if (!list) return;
    const deletedCount = owner.templates.filter(template => template.deleted).length, trashControl = $('#prompt-trash-control');
    if (trashControl) trashControl.innerHTML = deletedCount || owner.trash ? `<button type="button" class="button subtle" data-prompt-action="trash" aria-pressed="${Boolean(owner.trash)}">${owner.trash ? 'Outlines' : `Trash ${deletedCount}`}</button>` : '';
    list.innerHTML = rows.length ? rows.map(template => owner.trash ? `<article class="prompt-row prompt-trash-row"><div><strong>${escape(template.title)}</strong><small>${escape(template.description || 'Deleted outline')}</small></div><button type="button" class="button subtle" data-prompt-action="restore-deleted" data-id="${escape(template.id)}" data-revision="${template.revision}"${owner.busy ? ' disabled' : ''}>Restore</button></article>` : `<button type="button" class="prompt-row" data-prompt-action="select" data-id="${escape(template.id)}"><strong>${escape(template.title)}${!template.builtin ? '<span class="prompt-saved">Saved</span>' : ''}</strong><small>${escape(template.description || (template.builtin ? 'Starter outline' : 'Saved outline'))}</small></button>`).join('') : `<p class="prompt-empty">${owner.loading ? 'Loading outlines…' : owner.query ? 'No matching outlines.' : owner.trash ? 'No deleted outlines.' : 'No saved outlines yet.'}</p>`;
  }
  function compiled(owner) {
    try { const rendered = renderPromptTemplate(owner.template, owner.values); owner.compileError = ''; return rendered.text; }
    catch (error) { owner.compileError = error.message; return ''; }
  }
  function renderPreview({ reset = false } = {}) {
    const owner = state; if (!owner?.template || owner.editing) return;
    const result = compiled(owner); if (reset || !owner.previewEdited) owner.result = result;
    const preview = $('#prompt-result'); if (preview && preview.value !== owner.result) preview.value = owner.result;
    const notice = $('#prompt-compile-error'); if (notice) { notice.hidden = !owner.compileError || owner.previewEdited; notice.textContent = owner.compileError; }
    const apply = $('[data-prompt-action="apply"]'); if (apply) apply.disabled = owner.busy || Boolean(owner.compileError && !owner.previewEdited) || !owner.result.trim() || owner.result.length > 50000;
    const count = $('#prompt-result-count'); if (count) count.textContent = `${owner.result.length.toLocaleString()} / 50,000`;
  }
  function renderFields() {
    const owner = state, fields = promptTemplateFields(owner.template);
    const primary = fields.some(field => field.required) ? fields.filter(field => field.required) : fields.slice(0, 1), optional = fields.filter(field => !primary.includes(field));
    const fieldHTML = field => `<label class="prompt-field"><span>${escape(field.label || field.key)}${field.required ? '<span class="prompt-required">Required</span>' : '<span class="prompt-optional">Optional</span>'}</span><textarea rows="${field.key === 'task' ? 3 : 2}" maxlength="50000" data-prompt-value="${escape(field.key)}" aria-label="${escape(field.label || field.key)}">${escape(owner.values[field.key] || '')}</textarea></label>`;
    return primary.map(fieldHTML).join('') + (optional.length ? `<details class="prompt-extra-fields"${optional.some(field => owner.values[field.key]?.trim()) ? ' open' : ''}><summary>Add details <small>${optional.length}</small></summary>${optional.map(fieldHTML).join('')}</details>` : '');
  }
  function renderEditor() {
    const owner = state, template = owner.template, selected = template.sections[owner.section] || template.sections[0], branch = outlineBranch(template.sections, owner.section), bounds = outlineDepthBounds(template.sections, owner.section);
    return `<div class="prompt-name-row"><label class="prompt-field"><span>Name</span><input id="prompt-name" maxlength="120" value="${escape(template.title)}" placeholder="Name this outline"></label><label class="prompt-field prompt-description"><span>Description <span class="prompt-optional">Optional</span></span><input id="prompt-description" maxlength="400" value="${escape(template.description || '')}"></label></div><div class="prompt-outline-layout"><nav class="prompt-section-list" aria-label="Outline sections">${template.sections.map((section, index) => `<button type="button" data-prompt-action="section" data-index="${index}" aria-current="${owner.section === index ? 'true' : 'false'}" style="--prompt-level:${section.level}"><span>${escape(section.title || `Section ${index + 1}`)}</span></button>`).join('')}<button type="button" class="prompt-add-section" data-prompt-action="add">${icon('plus', 13)}Add section</button></nav><section class="prompt-section-editor"><div class="prompt-section-tools"><span>Section ${owner.section + 1}</span><button type="button" data-prompt-action="up" title="Move section up" aria-label="Move section up"${branch.previous !== null ? '' : ' disabled'}>${icon('up', 13)}</button><button type="button" data-prompt-action="down" title="Move section down" aria-label="Move section down"${branch.next !== null ? '' : ' disabled'}>${icon('down', 13)}</button><label>Depth<select id="prompt-section-level" aria-label="Section depth"${owner.section ? '' : ' disabled'}>${[0,1,2,3,4].map(level => `<option value="${level}"${selected.level === level ? ' selected' : ''}${level < bounds.min || level > bounds.max ? ' disabled' : ''}>${level + 1}</option>`).join('')}</select></label><button type="button" data-prompt-action="remove" title="Remove section and nested sections" aria-label="Remove section and nested sections">${icon('trash', 13)}</button></div><label class="prompt-field"><span>Heading <span class="prompt-optional">Optional</span></span><input id="prompt-section-title" maxlength="120" value="${escape(selected.title)}"></label><label class="prompt-field"><span>Instructions</span><textarea id="prompt-section-content" rows="10" maxlength="50000" spellcheck="false">${escape(selected.content)}</textarea><small>Use {{task}}, {{context}}, or your own {{variable}}.</small></label></section></div>`;
  }
  function renderHistory() {
    const owner = state;
    if (owner.historyLoading) return '<p class="prompt-empty">Loading outline history…</p>';
    if (!owner.history) return '<p class="prompt-empty">History could not be loaded.</p><button type="button" class="button" data-prompt-action="history">Try again</button>';
    return `<div class="prompt-history">${owner.history.history.map(revision => {
      const currentRevision = revision.revision === owner.history.currentRevision, date = Date.parse(revision.updatedAt || revision.createdAt || ''), source = revision.provenance?.source || 'user';
      return `<article class="prompt-history-row"><div><strong>Revision ${revision.revision}</strong><small>${escape(Number.isNaN(date) ? source : `${new Date(date).toLocaleString()} · ${source}`)}${revision.action ? ` · ${escape(revision.action)}` : ''}</small></div><button type="button" class="button subtle" data-prompt-action="restore-revision" data-revision="${revision.revision}"${currentRevision || owner.busy ? ' disabled' : ''}>${currentRevision ? 'Current' : 'Restore'}</button><details><summary>${escape(revision.title)}</summary>${revision.sections.map(section => `<section><strong>${escape(section.title || 'Instructions')}</strong><pre>${escape(section.content)}</pre></section>`).join('')}</details></article>`;
    }).join('')}</div>`;
  }
  function render() {
    const owner = state; if (!current(owner)) return;
    const detail = Boolean(owner.template), editing = detail && owner.editing;
    owner.mount.innerHTML = `<header class="modal-header prompt-header"><div class="modal-title"><h2>${detail ? escape(editing ? 'Edit outline' : owner.template.title) : 'Prompt outlines'}</h2></div><button type="button" class="icon-button" data-action="close-modal" aria-label="Close prompt outlines">${icon('close', 17)}</button></header><div class="prompt-toolbar">${detail ? `<button type="button" class="button subtle" data-prompt-action="library">${icon('chevron', 12)}Outlines</button><span class="prompt-toolbar-spacer"></span>${owner.historyMode ? '<button type="button" class="button subtle" data-prompt-action="history-back">Back to outline</button>' : !editing ? '<button type="button" class="button subtle" data-prompt-action="edit">Edit outline</button>' : '<button type="button" class="button subtle" data-prompt-action="fill">Fill outline</button>'}<details class="prompt-more"><summary aria-label="Outline actions" title="Outline actions">${icon('more', 17)}</summary><div><button type="button" data-prompt-action="export">Export JSON</button>${!owner.template.builtin && owner.template.id ? '<button type="button" data-prompt-action="history">History</button><button type="button" data-prompt-action="delete">Delete outline</button>' : ''}</div></details>` : `<label class="prompt-search">${icon('search', 15)}<input id="prompt-search" type="search" placeholder="Search outlines…" aria-label="Search outlines" value="${escape(owner.query)}"></label><span id="prompt-trash-control"></span>${draftStore.list().length ? '<button type="button" class="button subtle" data-prompt-action="resume-draft">Draft</button>' : ''}<button type="button" class="button" data-prompt-action="new">${icon('plus', 13)}New</button><button type="button" class="button subtle" data-prompt-action="import">Import</button><input id="prompt-import" type="file" accept="application/json,.json" hidden>`}</div><div id="prompt-error" class="prompt-error" role="alert"${owner.error ? '' : ' hidden'}>${escape(owner.error)}</div>${owner.deleted ? `<div class="prompt-deleted" role="status"><span>Outline deleted.</span><button type="button" class="button subtle" data-prompt-action="undo-delete"${owner.busy ? ' disabled' : ''}>Undo</button></div>` : ''}<main class="prompt-body">${!detail ? '<div id="prompt-library" class="prompt-library"></div>' : owner.historyMode ? renderHistory() : editing ? renderEditor() : `<div class="prompt-fill-layout"><div id="prompt-fields" class="prompt-fields">${renderFields() || '<p class="prompt-empty">This outline is ready to use.</p>'}</div><section class="prompt-preview"><label class="prompt-field"><span>Message <span class="prompt-optional">Editable</span></span><textarea id="prompt-result" rows="12" maxlength="50000" aria-label="Message preview">${escape(owner.result)}</textarea></label><div class="prompt-preview-meta"><small id="prompt-result-count"></small>${owner.previewEdited ? '<button type="button" data-prompt-action="reset-preview">Reset from fields</button>' : ''}</div><p id="prompt-compile-error" class="prompt-error" role="status" hidden></p></section></div>`}</main><footer class="modal-footer prompt-footer">${detail && !owner.historyMode ? `<button type="button" class="button subtle" data-prompt-action="save"${owner.busy ? ' disabled' : ''}>${owner.busy ? 'Saving…' : owner.template.builtin ? 'Save a copy' : 'Save outline'}</button>` : '<span class="footer-note">Reusable structure. Your message stays yours.</span>'}<button type="button" class="button" data-action="close-modal">Cancel</button>${detail && !owner.historyMode ? `<button type="button" class="button primary" data-prompt-action="${editing ? 'fill' : 'apply'}"${owner.busy ? ' disabled' : ''}>${editing ? 'Preview message' : 'Use in draft'}</button>` : ''}</footer>`;
    for (const field of owner.mount.querySelectorAll('input,textarea,select')) field.disabled = owner.busy;
    if (detail && !editing && !owner.historyMode) renderPreview(); else if (!detail) renderLibrary();
  }
  async function load(owner) {
    owner.loading = true; renderLibrary();
    try { const data = await api('/api/prompts?includeDeleted=true'); if (!current(owner)) return; owner.templates = data.templates || []; owner.libraryError = data.status?.healthy === false ? data.status.error || 'Saved outlines need attention. Starter outlines are still available.' : ''; if (!owner.template) owner.error = owner.libraryError; }
    catch (error) { if (!current(owner)) return; owner.error = error.message; }
    finally { if (current(owner)) { owner.loading = false; renderLibrary(); renderNotice(); } }
  }
  function selectTemplate(template, { editing = false } = {}) {
    const owner = state; stash(owner); owner.request++; owner.template = clone(template); owner.values = Object.fromEntries(promptTemplateFields(template).map(field => [field.key, field.key === 'task' ? owner.capture?.task || '' : ''])); owner.section = 0; owner.editing = editing; owner.historyMode = false; owner.history = null; owner.result = ''; owner.previewEdited = false; owner.error = owner.libraryError || ''; owner.authorDirty = !template.id; owner.draftKey = `${template.id || crypto.randomUUID()}:${windowId}`; owner.cachedDraft = null; render(); owner.mount.querySelector(editing ? '#prompt-name' : '[data-prompt-value],#prompt-result')?.focus({ preventScroll: true });
  }
  function beginNew(fromDraft = false) { const section = newSection(); section.content = fromDraft ? state.capture?.task || '' : '{{task}}'; selectTemplate({ title: fromDraft ? 'My outline' : 'New outline', description: '', sections: [section] }, { editing: true }); }
  async function choose(owner, id) {
    const request = ++owner.request; owner.error = '';
    try { const data = await api(`/api/prompts/${encodeURIComponent(id)}`); if (!current(owner) || request !== owner.request) return; selectTemplate(data.template); }
    catch (error) { if (current(owner) && request === owner.request) fail(error); }
  }
  async function save(owner) {
    if (!editable(owner)) return;
    let template; try { template = validatePromptTemplate(cleanAuthoring(owner.template)); } catch (error) { fail(error); return; }
    const previous = owner.template, captured = JSON.stringify(cleanAuthoring(previous)); owner.busy = true; owner.error = ''; render();
    try {
      const payload = { template: { ...template, ...(!previous.builtin && previous.id ? { id: previous.id } : {}) }, ...(!previous.builtin && previous.id ? { expectedRevision: previous.revision } : {}) };
      const data = await api('/api/prompts/save', 'POST', payload); if (!current(owner)) return;
      if (JSON.stringify(cleanAuthoring(owner.template)) === captured) { owner.template = clone(data.template); owner.authorDirty = false; if (owner.cachedDraft) draftStore.remove(owner.draftKey, { expected: owner.cachedDraft }); owner.cachedDraft = null; }
      owner.templates = [data.template, ...owner.templates.filter(item => item.id !== data.template.id)]; toast('Outline saved.');
    } catch (error) { if (current(owner)) owner.error = error.message; }
    finally { if (current(owner)) { owner.busy = false; render(); } }
  }
  async function remove(owner) {
    if (!editable(owner) || owner.template.builtin || !owner.template.id) return;
    const template = owner.template; owner.busy = true; owner.error = ''; render();
    try { const data = await api(`/api/prompts/${encodeURIComponent(template.id)}/delete`, 'POST', { expectedRevision: template.revision }); if (!current(owner)) return; owner.deleted = data.template; owner.templates = [data.template, ...owner.templates.filter(item => item.id !== template.id)]; owner.template = null; owner.request++; }
    catch (error) { if (current(owner)) owner.error = error.message; }
    finally { if (current(owner)) { owner.busy = false; render(); } }
  }
  async function undoDelete(owner) {
    if (owner.deleted) return restoreDeleted(owner, owner.deleted);
  }
  async function restoreDeleted(owner, template) {
    if (owner.busy || !template?.deleted) return; owner.busy = true; owner.error = ''; render();
    try { const data = await api(`/api/prompts/${encodeURIComponent(template.id)}/restore`, 'POST', { expectedRevision: template.revision }); if (!current(owner)) return; owner.templates = [data.template, ...owner.templates.filter(item => item.id !== data.template.id)]; if (owner.deleted?.id === template.id) owner.deleted = null; if (!owner.templates.some(item => item.deleted)) owner.trash = false; owner.error = ''; toast('Outline restored.'); }
    catch (error) { if (current(owner)) owner.error = error.message; }
    finally { if (current(owner)) { owner.busy = false; render(); } }
  }
  async function showHistory(owner) {
    if (!owner.template?.id || owner.template.builtin) return;
    stash(owner); const request = ++owner.request, id = owner.template.id; owner.historyMode = true; owner.historyLoading = true; owner.history = null; owner.error = ''; render();
    try { const data = await api(`/api/prompts/${encodeURIComponent(id)}/history`); if (!current(owner) || request !== owner.request || !owner.historyMode) return; owner.history = data; }
    catch (error) { if (current(owner) && request === owner.request && owner.historyMode) owner.error = error.message; }
    finally { if (current(owner) && request === owner.request && owner.historyMode) { owner.historyLoading = false; render(); } }
  }
  async function restoreRevision(owner, revision) {
    if (owner.busy || !owner.history || !Number.isSafeInteger(revision) || revision === owner.history.currentRevision) return;
    const request = ++owner.request, id = owner.template.id; owner.busy = true; owner.error = ''; render();
    try { const data = await api(`/api/prompts/${encodeURIComponent(id)}/restore`, 'POST', { expectedRevision: owner.history.currentRevision, revision }); if (!current(owner) || request !== owner.request) return; owner.template = clone(data.template); owner.authorDirty = false; owner.values = Object.fromEntries(promptTemplateFields(owner.template).map(field => [field.key, owner.values[field.key] || (field.key === 'task' ? owner.capture?.task || '' : '')])); owner.previewEdited = false; owner.result = compiled(owner); owner.templates = [data.template, ...owner.templates.filter(item => item.id !== id)]; owner.busy = false; toast(`Restored revision ${revision} as revision ${data.template.revision}.`); return showHistory(owner); }
    catch (error) { if (current(owner) && request === owner.request) owner.error = error.message; }
    finally { if (current(owner)) { owner.busy = false; render(); } }
  }
  async function importFile(owner, file) {
    if (!file || owner.busy) return; if (file.size > PROMPT_TEMPLATE_LIMITS.documentBytes) { fail(new Error('Choose an outline JSON file smaller than 512 KB.')); return; }
    owner.busy = true; renderNotice();
    try { const text = await file.text(); if (!current(owner)) return; const document = JSON.parse(text); const data = await api('/api/prompts/import', 'POST', { document }); if (!current(owner)) return; owner.templates = [data.template, ...owner.templates.filter(item => item.id !== data.template.id)]; selectTemplate(data.template); toast('Outline imported.'); }
    catch (error) { if (current(owner)) fail(error instanceof SyntaxError ? new Error('This file is not valid JSON.') : error); }
    finally { if (current(owner)) { owner.busy = false; render(); } }
  }
  async function exportTemplate(owner) {
    if (!owner.template || owner.busy) return;
    let template; try { template = validatePromptTemplate(cleanAuthoring(owner.template)); } catch (error) { fail(error); return; }
    // Export the visible authoring draft, including edits, without filled values.
    const portableDocument = { format: 'relay-prompt-template', version: 1, template };
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(portableDocument, null, 2)}\n`], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `${template.title.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'outline'}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  function onInput(event) {
    const owner = state; if (!current(owner) || owner.busy) return; const target = event.target;
    if (target.id === 'prompt-search') { owner.query = target.value; renderLibrary(); return; }
    if (target.dataset.promptValue) { owner.values[target.dataset.promptValue] = target.value; owner.previewEdited = false; renderPreview({ reset: true }); return; }
    if (target.id === 'prompt-result') { owner.result = target.value; owner.previewEdited = true; renderPreview(); const meta = $('#prompt-result-count'); if (meta && !meta.parentNode?.querySelector('[data-prompt-action="reset-preview"]')) meta.insertAdjacentHTML('afterend', '<button type="button" data-prompt-action="reset-preview">Reset from fields</button>'); return; }
    if (!owner.template || !owner.editing) return;
    if (target.id === 'prompt-name') owner.template.title = target.value;
    if (target.id === 'prompt-description') owner.template.description = target.value;
    if (target.id === 'prompt-section-title') { owner.template.sections[owner.section].title = target.value; const row = $(`[data-prompt-action="section"][data-index="${owner.section}"] span`); if (row) row.textContent = target.value || `Section ${owner.section + 1}`; }
    if (target.id === 'prompt-section-content') owner.template.sections[owner.section].content = target.value;
    if (target.id === 'prompt-section-level') { const changed = setOutlineDepth(owner.template.sections, owner.section, Number(target.value)); owner.template.sections = changed.sections; owner.section = changed.index; owner.authorDirty = true; stash(owner); render(); $('#prompt-section-level')?.focus({ preventScroll: true }); return; }
    owner.authorDirty = true; stash(owner);
  }
  async function onClick(event) {
    const owner = state; if (!current(owner)) return; const button = event.target.closest('[data-prompt-action]'); if (!button || button.disabled) return; const action = button.dataset.promptAction;
    if (owner.busy) return;
    if (action === 'trash') { owner.request++; owner.trash = !owner.trash; owner.error = owner.libraryError || ''; render(); return; }
    if (action === 'restore-deleted') return restoreDeleted(owner, owner.templates.find(template => template.id === button.dataset.id && template.deleted));
    if (action === 'select') return choose(owner, button.dataset.id);
    if (action === 'library') { stash(owner); owner.request++; owner.template = null; owner.editing = false; owner.historyMode = false; owner.error = owner.libraryError || ''; render(); return; }
    if (action === 'resume-draft') { const cached = draftStore.list()[0]; if (!cached?.data?.template) return; const template = cached.data.template; if (!Array.isArray(template.sections) || !template.sections.length || template.sections.some(section => !section || typeof section.title !== 'string' || typeof section.content !== 'string')) { fail(new Error('This cached outline draft could not be read. Its saved outline is still available.')); return; } owner.request++; owner.template = clone(template); owner.draftKey = cached.key; owner.cachedDraft = cached.data; owner.authorDirty = true; owner.section = Math.max(0, Math.min(Number(cached.data.section) || 0, owner.template.sections.length - 1)); owner.editing = true; owner.historyMode = false; owner.values = {}; owner.error = ''; render(); return; }
    if (action === 'new') return beginNew();
    if (action === 'import') return $('#prompt-import').click();
    if (action === 'undo-delete') return undoDelete(owner);
    if (action === 'save') return save(owner);
    if (action === 'delete') return remove(owner);
    if (action === 'export') return exportTemplate(owner);
    if (!owner.template) return;
    if (action === 'history') return showHistory(owner);
    if (action === 'history-back') { owner.request++; owner.historyMode = false; owner.error = owner.libraryError || ''; render(); return; }
    if (action === 'restore-revision') return restoreRevision(owner, Number(button.dataset.revision));
    if (action === 'edit') { owner.editing = true; owner.error = ''; render(); return; }
    if (action === 'fill') {
      try { const normalized = validatePromptTemplate(cleanAuthoring(owner.template)); owner.template = { ...owner.template, ...normalized }; const known = new Set(promptTemplateFields(owner.template).map(field => field.key)); owner.values = Object.fromEntries([...known].map(key => [key, owner.values[key] || (key === 'task' ? owner.capture?.task || '' : '')])); owner.editing = false; owner.previewEdited = false; owner.error = ''; render(); }
      catch (error) { fail(error); } return;
    }
    if (action === 'reset-preview') { owner.previewEdited = false; owner.result = compiled(owner); render(); return; }
    if (action === 'apply') {
      compiled(owner); if (owner.compileError && !owner.previewEdited || !owner.result.trim() || owner.result.length > 50000) return;
      const result = applyDraft(owner.capture, owner.result); if (!result?.applied) { fail(new Error(result?.error || 'This draft changed. Reopen outlines from the chat you want to edit.')); return; }
      closeModal(); toast('Outline added to your draft.'); return;
    }
    if (!owner.editing) return;
    if (action === 'section') { owner.section = Number(button.dataset.index); render(); return; }
    let changed;
    if (action === 'add') changed = insertOutlineSibling(owner.template.sections, owner.section, newSection());
    if (action === 'remove') changed = removeOutlineBranch(owner.template.sections, owner.section);
    if (action === 'up' || action === 'down') changed = moveOutlineBranch(owner.template.sections, owner.section, action);
    if (!changed) return;
    owner.template.sections = changed.sections; owner.section = changed.index; owner.authorDirty = true; stash(owner); render();
  }
  return {
    async open({ saveCurrent = false } = {}) {
      session++; const capture = captureDraft(); showModal({ title: 'Prompt outlines', body: '<div id="prompt-workspace" class="prompt-workspace"></div>', wide: true });
      const owner = state = { session: ++session, mount: document.getElementById('prompt-workspace'), capture, templates: [], template: null, query: '', values: {}, result: '', previewEdited: false, compileError: '', editing: false, section: 0, request: 0, error: '', loading: true, busy: false, deleted: null };
      owner.mount.addEventListener('input', onInput); owner.mount.addEventListener('change', event => { if (event.target.id === 'prompt-import') void importFile(owner, event.target.files?.[0]); else onInput(event); }); owner.mount.addEventListener('click', event => void onClick(event).catch(error => { if (current(owner)) fail(error); }));
      render(); if (saveCurrent) beginNew(true); await load(owner);
    },
    cancel() { stash(state); session++; state = null; },
    destroy() { stash(state); session++; state = null; },
  };
}
