import { renderMarkdown } from './editor-model.mjs';

const isRemoved = item => item.status === 'deleted' || item.missingKnowledge === true;
export const learningKindLabel = kind => kind === 'skill' ? 'Skill' : kind === 'strategy' ? 'Method' : 'Memory';
export function learningConfidenceLabel(value) {
  return ({ explicit_user_statement: 'You said this', supported_by_multiple_runs: 'Seen in several tasks', observed_once: 'Observed once', tentative_after_negative_feedback: 'Tentative · needs checking', tentative_after_interruption: 'Tentative · task interrupted', tentative_after_failure: 'Tentative · task failed' })[value] || String(value || 'Recorded locally').replaceAll('_', ' ');
}

/** Bounded line comparison. Large revisions explicitly show an excerpt. */
export function learningRevisionDiff(before = '', after = '') {
  if (before === after) return { added: [], removed: [], changed: false, excerpt: false };
  const left = String(before).split('\n'), right = String(after).split('\n');
  let start = 0, endLeft = left.length, endRight = right.length;
  while (start < endLeft && start < endRight && left[start] === right[start]) start++;
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) { endLeft--; endRight--; }
  const a = left.slice(start, endLeft), b = right.slice(start, endRight);
  let removed = [], added = [], excerpt = false;
  if (a.length * b.length <= 120000 && a.length + b.length <= 120000) {
    const width = b.length + 1, table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
      else if (i < a.length && (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) removed.push(a[i++]);
      else added.push(b[j++]);
    }
  } else { removed = a; added = b; excerpt = true; }
  const clip = value => { if (!value.length) return []; if (value.length > 80 || value.join('\n').length > 9000) excerpt = true; return value.slice(0, 80).join('\n').slice(0, 9000).split('\n'); };
  removed = clip(removed); added = clip(added);
  return { added, removed, changed: true, excerpt };
}

/** Learning applies automatically in the store. This surface explains and reverses saved changes. */
export function initLearningUI({ api, showModal, closeModal, toast, escape, getCwd, getRuns = () => [], icon, onOpenRun }) {
  const $ = selector => document.querySelector(selector);
  const state = { data: null, tab: 'saved', filter: 'all', selected: null, revision: null, editing: false, request: 0, session: 0, navigation: 0, saving: null, error: '', runId: null, optionsOpen: false, feedback: '', wantedKnowledgeId: null };
  let poll, lastMarkup = '', lastMount = null;
  const alive = () => Boolean($('#learning-view'));
  const owns = owner => state.session === owner.session && $('#learning-view') === owner.mount;
  const owner = () => ({ session: state.session, mount: $('#learning-view') });
  const time = value => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Time not recorded';
  const text = value => String(value || '').replaceAll('_', ' ');
  const finishedRuns = () => getRuns().filter(run => ['completed', 'failed', 'cancelled'].includes(run.status) && run.settled !== false && (!getCwd() || String(run.cwd).toLowerCase() === String(getCwd()).toLowerCase()));
  const lessons = () => state.data?.lessons || [];
  const collection = () => state.tab === 'activity' ? state.data?.reviews || [] : lessons().filter(item => state.filter === 'removed' ? isRemoved(item) : !isRemoved(item) && (state.filter === 'all' || (state.filter === 'skills' ? item.kind === 'skill' : item.kind !== 'skill')));
  const current = () => collection().find(item => item.id === state.selected);
  const sourceTitle = id => { const run = getRuns().find(item => item.id === id); return run ? String(typeof run.input === 'string' ? run.input : run.input?.task || run.workflowName || 'Source conversation').slice(0, 140) : 'Source conversation'; };
  const disabled = () => state.saving ? ' disabled' : '';
  function sourceLink(runId, title = sourceTitle(runId)) { return runId && onOpenRun ? `<button class="learning-source-link" data-learning="open-run" data-id="${escape(runId)}">${icon('link', 13)}${escape(title)}${icon('chevron', 11)}</button>` : ''; }
  function statusText() {
    const status = state.data?.status || {}, mode = state.data?.settings?.mode || 'auto';
    if (status.error) return 'Learning needs attention';
    return status.activeReviewId ? 'Learning from a task…' : status.queued ? `${status.queued} task${status.queued === 1 ? '' : 's'} waiting to be learned from` : mode === 'auto' ? 'Learns automatically after tasks' : mode === 'off' ? 'Automatic learning is off' : 'Learns when you ask';
  }
  function options() {
    const mode = state.data?.settings?.mode || 'auto', runs = finishedRuns();
    if (!state.runId || !runs.some(run => run.id === state.runId)) state.runId = runs[0]?.id || null;
    return `<details class="learning-options" data-learning-panel="options"${state.optionsOpen ? ' open' : ''}><summary>Learning options</summary><div class="learning-options-body"><label class="learning-mode" for="learning-mode"><span>After tasks</span><select id="learning-mode"${disabled()}><option value="auto"${mode === 'auto' ? ' selected' : ''}>Learn automatically</option><option value="manual"${mode === 'manual' ? ' selected' : ''}>Only when I ask</option><option value="off"${mode === 'off' ? ' selected' : ''}>Off</option></select></label><p>Useful memories and skills apply to future tasks. Background learning uses your selected model.</p><div class="learning-task"><label for="learning-run">Learn from a finished task</label><div class="learning-task-controls"><select id="learning-run"${!runs.length ? ' disabled' : ''}>${runs.length ? runs.slice(0, 100).map(run => `<option value="${escape(run.id)}"${state.runId === run.id ? ' selected' : ''}>${escape(sourceTitle(run.id))}</option>`).join('') : '<option>No finished tasks in this folder</option>'}</select><button class="button" data-learning="learn"${!runs.length || mode === 'off' || state.saving ? ' disabled' : ''}>Learn now</button></div><div class="learning-feedback"><input id="learning-feedback" maxlength="2000" value="${escape(state.feedback)}" placeholder="Optional feedback on this task" aria-label="Feedback on selected task"><button class="button" data-learning="feedback" data-value="good"${!runs.length || state.saving ? ' disabled' : ''}>Useful</button><button class="button" data-learning="feedback" data-value="bad"${!runs.length || state.saving ? ' disabled' : ''}>Needs work</button></div></div></div></details>`;
  }
  function revisionContent(item, earlier) {
    if (!earlier) return '<p class="field-help">Select an earlier revision to compare it with what agents use now.</p>';
    const diff = learningRevisionDiff(earlier.content, item.content), fields = ['title', 'summary', 'whenToUse', 'verification', 'confidence'].filter(key => String(earlier[key] || '') !== String(item[key] || ''));
    return `<div class="learning-revision-head"><span>Revision ${Number(earlier.revision)} → ${Number(item.revision)}</span><button class="button" data-learning="restore" data-revision="${Number(earlier.revision)}"${disabled()}>Restore this revision</button></div>${fields.map(key => `<dl class="learning-field-change"><dt>${escape(({ whenToUse: 'When to use', confidence: 'Confidence' })[key] || text(key))}</dt><dd><del>${escape(earlier[key] || 'Empty')}</del><ins>${escape(item[key] || 'Empty')}</ins></dd></dl>`).join('')}${diff.changed ? `<div class="learning-diff"><section><h5>Earlier text</h5><pre>${escape(diff.removed.join('\n') || '(No removed text)')}</pre></section><section><h5>Current text</h5><pre>${escape(diff.added.join('\n') || '(No added text)')}</pre></section></div>${diff.excerpt ? '<p class="field-help">This large comparison shows excerpts of the changed section. Read the saved versions for the full text.</p>' : ''}` : '<p class="field-help">Instruction text is unchanged.</p>'}<details class="learning-evidence"><summary>Read full earlier version</summary><div class="output-document learning-version-content">${renderMarkdown(earlier.content || '')}</div></details>`;
  }
  function history(item) {
    const revisions = [...(item.history || [])].reverse(), earlier = revisions.find(entry => entry.revision === state.revision) || revisions[0];
    if (!revisions.length) return `<details class="learning-evidence" data-learning-panel="history"><summary>Change history<span>Revision ${Number(item.revision) || 1}</span></summary><p class="learning-note">First saved ${escape(time(item.createdAt))}. No earlier revision is stored.</p></details>`;
    return `<details class="learning-evidence" data-learning-panel="history"><summary>Change history<span>${revisions.length} earlier revision${revisions.length === 1 ? '' : 's'}</span></summary><div class="learning-history"><label for="learning-revision">Compare with</label><select id="learning-revision">${revisions.map(entry => `<option value="${Number(entry.revision)}"${entry === earlier ? ' selected' : ''}>Revision ${Number(entry.revision)} · ${escape(time(entry.at || entry.updatedAt))}</option>`).join('')}</select>${revisionContent(item, earlier)}</div></details>`;
  }
  function evidence(item) {
    const sources = item.evidence || [];
    return `<div class="learning-why"><h4>Why it’s here</h4>${sources.length ? sources.slice(0, 1).map(source => `<blockquote>${escape(source.quote)}</blockquote>${sourceLink(source.runId)}`).join('') : '<p class="learning-note">The original evidence is not available in this record.</p>'}${sources.length > 1 ? `<details class="learning-evidence" data-learning-panel="sources"><summary>More evidence<span>${sources.length - 1} source${sources.length === 2 ? '' : 's'}</span></summary>${sources.slice(1).map(source => `<div class="learning-source"><blockquote>${escape(source.quote)}</blockquote><small>${escape(text(source.kind))} · ${escape(text(source.status))}</small>${sourceLink(source.runId)}</div>`).join('')}</details>` : ''}</div>`;
  }
  function reviewDetails(item) {
    const count = item.appliedIds?.length ?? item.committedIds?.length ?? 0;
    const result = ({ queued: 'Waiting to learn', running: 'Learning', committing: 'Saving changes', completed: `${count} saved change${count === 1 ? '' : 's'}`, no_changes: 'Nothing new to save', failed: 'Learning failed', cancelled: 'Learning cancelled', interrupted: 'Learning interrupted' })[item.status] || text(item.status);
    return `<div class="learning-detail-head"><span class="badge">${escape(result)}</span><span>${escape(time(item.createdAt))}</span></div><h3>${escape(sourceTitle(item.runId) || item.workflowName || 'Task')}</h3><p>${escape(item.summary || 'BLACKICE is looking for useful facts and methods in the recorded task.')}</p>${sourceLink(item.runId)}${item.error ? `<p class="learning-inline-error" role="alert">${escape(item.error)}</p>` : ''}${['failed', 'cancelled', 'interrupted'].includes(item.status) ? `<button class="button" data-learning="retry" data-id="${escape(item.id)}"${disabled()}>Try learning again</button>` : ''}${count ? `<div class="learning-applied">${lessons().filter(lesson => (item.appliedIds || item.committedIds || []).includes(lesson.id)).map(lesson => `<button class="learning-source-link" data-learning="show-lesson" data-id="${escape(lesson.id)}">${icon(lesson.kind === 'skill' ? 'bolt' : 'book', 13)}${escape(lesson.title)}${icon('chevron', 11)}</button>`).join('')}</div>` : ''}<details class="learning-evidence" data-learning-panel="receipt"><summary>Learning receipt<span>${escape(time(item.finishedAt || item.startedAt || item.createdAt))}</span></summary><dl class="learning-meta"><dt>Started by</dt><dd>${escape(({ automatic: 'Automatic learning', feedback: 'Your feedback', manual: 'Learn now' })[item.reason] || text(item.reason))}</dd><dt>Model</dt><dd>${escape(item.model || 'Not recorded')}</dd><dt>Saved changes</dt><dd>${count}</dd>${item.usage?.totalTokens != null ? `<dt>Tokens used</dt><dd>${Number(item.usage.totalTokens).toLocaleString()}</dd>` : ''}</dl>${item.modelSummary ? `<p class="learning-note">${escape(item.modelSummary)}</p>` : ''}${(item.toolReceipts || []).map(receipt => `<div class="learning-tool-receipt"><strong>${escape(text(receipt.action || receipt.tool))} · ${receipt.success ? 'Accepted' : 'Rejected'}</strong>${receipt.error ? `<p>${escape(receipt.error)}</p>` : ''}</div>`).join('')}${item.threadId ? `<dl class="learning-meta"><dt>Provider thread</dt><dd>${escape(item.threadId)}</dd>${item.turnId ? `<dt>Provider turn</dt><dd>${escape(item.turnId)}</dd>` : ''}</dl>` : ''}</details><details class="learning-evidence" data-learning-panel="task-evidence"><summary>Recorded task evidence<span>${item.evidence?.entries?.length || 0} excerpt${item.evidence?.entries?.length === 1 ? '' : 's'}</span></summary>${(item.evidence?.entries || []).map(entry => `<section class="learning-source"><small>${escape(text(entry.kind))}</small><pre>${escape(entry.text)}</pre></section>`).join('')}${item.evidence?.truncated ? '<p class="learning-note">Bounded task excerpts were used. Missing evidence is not proof.</p>' : ''}</details>`;
  }
  function detail() {
    const item = current();
    if (!item) return `<div class="learning-empty">${icon('learning', 27)}<h3>${state.tab === 'activity' ? 'Learning history appears here' : state.filter === 'removed' ? 'No removed items' : 'BLACKICE learns as you work'}</h3><p>${state.tab === 'activity' ? 'See what changed after each task, including tasks with nothing new to save.' : state.filter === 'removed' ? 'Removed memories and skills stay out of future tasks.' : 'Useful memories and skills appear here automatically. Inspect the source, edit anything, or undo a change.'}</p></div>`;
    if (state.tab === 'activity') return reviewDetails(item);
    const removed = isRemoved(item), previous = [...(item.history || [])].reverse()[0], provenance = item.provenance;
    return `<div class="learning-detail-head"><span class="badge">${learningKindLabel(item.kind)}${removed ? ' · removed' : ''}</span><span>${escape(time(item.updatedAt || item.createdAt))}</span></div><h3>${escape(item.title)}</h3>${item.summary ? `<p class="learning-item-summary">${escape(item.summary)}</p>` : ''}<div class="learning-confidence">${escape(learningConfidenceLabel(item.confidence))}${item.userEdited ? ' · edited by you' : ''}${item.profileUpdated ? ' · added to your profile' : ''}</div>${removed ? '<p class="learning-note">Removed. Agents will not use this item.</p>' : ''}<div class="learning-actions">${removed ? `<button class="button" data-learning="restore" data-revision="${Number(item.revision) || 1}"${disabled()}>Restore item</button>` : `<button class="button" data-learning="edit"${disabled()}>${icon('text', 13)}Edit</button>${previous ? `<button class="button" data-learning="restore" data-revision="${Number(previous.revision)}"${disabled()}>${icon('undo', 13)}Undo last change</button>` : ''}<button class="button subtle" data-learning="delete"${disabled()}>${icon('trash', 13)}Remove</button>`}</div>${evidence(item)}<details class="learning-evidence" data-learning-panel="content"><summary>What agents use<span>Revision ${Number(item.revision) || 1}</span></summary><div class="output-document learning-version-content">${renderMarkdown(item.content || '')}</div></details>${history(item)}${provenance ? `<p class="learning-provenance">${escape(({ created: 'Saved', updated: 'Updated', edited: 'Edited', restored: 'Restored' })[provenance.action] || 'Recorded')} ${provenance.source === 'user' ? 'by you' : 'through learning'}${provenance.model ? ` · ${escape(provenance.model)}` : ''}${provenance.restoredFrom ? ` · from revision ${Number(provenance.restoredFrom)}` : ''}</p>` : ''}${item.profileError ? `<p class="learning-inline-error">Profile update: ${escape(item.profileError)}</p>` : ''}`;
  }
  function render() {
    const mount = $('#learning-view'); if (!mount || state.editing) return;
    if (mount.contains?.(document.activeElement) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    if (!state.error && state.data?.status?.error) state.error = state.data.status.error;
    if (!state.data) { mount.innerHTML = state.error ? `<div class="learning-empty"><p class="error-text" role="alert">${escape(state.error)}</p><button class="button" data-learning="refresh">Try again</button></div>` : '<div class="learning-empty">Loading memories and skills…</div>'; return; }
    const available = collection(); if (!available.some(item => item.id === state.selected)) { state.selected = available[0]?.id || null; state.revision = null; }
    const counts = lessons().filter(item => !isRemoved(item)), removedCount = lessons().length - counts.length;
    const markup = `<div class="learning-toolbar"><span class="learning-status" aria-live="polite">${state.data?.status?.activeReviewId ? '<span class="learning-status-dot"></span>' : icon('learning', 14)}${escape(statusText())}</span><button class="icon-button" data-learning="refresh" aria-label="Refresh learning history">${icon('refresh', 14)}</button></div>${state.error ? `<p class="learning-inline-error" role="alert">${escape(state.error)}</p>` : ''}<div class="learning-layout"><aside class="learning-sidebar"><div class="learning-tabs" role="tablist" aria-label="Memories and learning"><button role="tab" aria-selected="${state.tab === 'saved'}" data-learning="tab" data-tab="saved">Saved <small>${counts.length}</small></button><button role="tab" aria-selected="${state.tab === 'activity'}" data-learning="tab" data-tab="activity">Activity</button></div>${state.tab === 'saved' ? `<div class="learning-filters" role="group" aria-label="Filter saved learning">${[['all', 'All'], ['memories', 'Memories'], ['skills', 'Skills'], ...(removedCount ? [['removed', `Removed ${removedCount}`]] : [])].map(([value, title]) => `<button data-learning="filter" data-filter="${value}" aria-pressed="${state.filter === value}">${title}</button>`).join('')}</div>` : ''}<div class="learning-list">${available.length ? available.map(item => `<button class="learning-row${item.id === state.selected ? ' selected' : ''}" data-learning="select" data-id="${escape(item.id)}" aria-pressed="${item.id === state.selected}"><strong>${escape(state.tab === 'saved' ? item.title : sourceTitle(item.runId) || item.workflowName)}</strong><span>${escape(state.tab === 'saved' ? item.summary || learningConfidenceLabel(item.confidence) : item.summary || text(item.status))}</span><small>${escape(state.tab === 'saved' ? `${learningKindLabel(item.kind)} · ${isRemoved(item) ? 'Removed' : learningConfidenceLabel(item.confidence)}` : `${({ completed: 'Learned', no_changes: 'No new changes', queued: 'Queued', running: 'Learning', committing: 'Saving', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' })[item.status] || text(item.status)} · ${time(item.createdAt)}`)}</small></button>`).join('') : `<div class="learning-empty compact">${state.tab === 'activity' ? 'No learning activity in this folder yet.' : state.filter === 'removed' ? 'No removed items.' : 'Nothing saved here yet.'}</div>`}</div></aside><section class="learning-detail" id="learning-detail" aria-label="Learning details">${detail()}</section></div>${options()}<div class="modal-footer"><span class="footer-note" title="${escape(getCwd() || 'All folders')}">${getCwd() ? 'This working folder · saved locally' : 'All working folders · saved locally'}</span><button class="button" data-action="close-modal">Done</button></div>`;
    if (mount === lastMount && markup === lastMarkup) return;
    const detailScroll = $('#learning-detail')?.scrollTop || 0, listScroll = $('.learning-list')?.scrollTop || 0;
    const panels = new Map([...(mount.querySelectorAll?.('details[data-learning-panel]') || [])].map(node => [node.dataset.learningPanel, node.open]));
    mount.innerHTML = markup; lastMount = mount; lastMarkup = markup;
    for (const node of mount.querySelectorAll?.('[role="tab"]') || []) node.tabIndex = node.dataset.tab === state.tab ? 0 : -1;
    for (const node of mount.querySelectorAll?.('details[data-learning-panel]') || []) if (panels.has(node.dataset.learningPanel)) node.open = panels.get(node.dataset.learningPanel);
    if ($('#learning-detail')) $('#learning-detail').scrollTop = detailScroll;
    if ($('.learning-list')) $('.learning-list').scrollTop = listScroll;
  }
  async function load() {
    const request = ++state.request, context = owner(), cwd = getCwd();
    try {
      const data = await api(`/api/learning${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`);
      if (request !== state.request || !owns(context)) return;
      state.data = data; state.error = '';
      if (state.wantedKnowledgeId) { const item = lessons().find(entry => entry.knowledgeId === state.wantedKnowledgeId); if (item) { state.tab = 'saved'; state.filter = isRemoved(item) ? 'removed' : 'all'; state.selected = item.id; } state.wantedKnowledgeId = null; }
      render();
    } catch (cause) { if (request === state.request && owns(context)) { state.error = cause.message; render(); } }
  }
  async function action(fn, message, applied) {
    if (state.saving) return;
    const context = owner(), navigation = state.navigation, saving = Symbol('learning-save'); state.saving = saving;
    try { await fn(); if (!owns(context)) return; state.error = ''; if (navigation === state.navigation) applied?.(); if (message) toast(message); await load(); }
    catch (cause) { if (owns(context)) { state.error = cause.message; toast(cause.message, true); } }
    finally { if (state.saving === saving) state.saving = null; if (owns(context)) render(); }
  }
  function edit() {
    const item = current(); if (!item || state.saving) return;
    state.navigation++; state.editing = true; lastMarkup = '';
    $('#learning-detail').innerHTML = `<form id="learning-editor" data-lesson-id="${escape(item.id)}"><h3>Edit ${learningKindLabel(item.kind).toLowerCase()}</h3><label class="field"><span class="field-label">Title</span><input id="learning-title" required maxlength="120" value="${escape(item.title)}"></label><label class="field"><span class="field-label">Summary</span><input id="learning-summary" maxlength="400" value="${escape(item.summary)}"></label><label class="field"><span class="field-label">What agents should use</span><textarea id="learning-content" rows="10" required maxlength="${item.kind === 'skill' ? 40000 : 8000}">${escape(item.content)}</textarea></label><p class="field-help">Applies to future tasks. The earlier version stays in change history.</p><div class="learning-actions"><button type="button" class="button" data-learning="cancel-edit">Cancel</button><button class="button primary" type="submit">Save changes</button></div></form>`;
    $('#learning-title')?.focus({ preventScroll: true });
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-learning]'); if (!button || !alive() || button.disabled) return;
    const type = button.dataset.learning;
    if (type === 'refresh') return load();
    if (type === 'tab' || type === 'filter' || type === 'select' || type === 'show-lesson') {
      state.navigation++;
      if (type === 'tab') { state.tab = button.dataset.tab; state.selected = null; }
      if (type === 'filter') { state.filter = button.dataset.filter; state.selected = null; }
      if (type === 'select') state.selected = button.dataset.id;
      if (type === 'show-lesson') { const item = lessons().find(entry => entry.id === button.dataset.id); if (!item) return; state.tab = 'saved'; state.filter = isRemoved(item) ? 'removed' : 'all'; state.selected = item.id; }
      state.editing = false; state.revision = null; document.activeElement?.blur?.(); render();
      if (type === 'tab') $(`[data-learning="tab"][data-tab="${state.tab}"]`)?.focus({ preventScroll: true });
      return;
    }
    if (type === 'learn') { const runId = state.runId; return action(() => api('/api/learning/review', 'POST', { runId }), 'Learning queued.'); }
    if (type === 'feedback') { const runId = state.runId, comment = $('#learning-feedback')?.value || state.feedback; return action(() => api('/api/learning/feedback', 'POST', { runId, value: button.dataset.value, comment }), 'Feedback saved.', () => { state.feedback = ''; }); }
    if (type === 'retry') { const id = button.dataset.id; return action(() => api(`/api/learning/reviews/${encodeURIComponent(id)}/retry`, 'POST', {}), 'Learning queued again.'); }
    if (type === 'edit') return edit();
    if (type === 'cancel-edit') { state.navigation++; state.editing = false; document.activeElement?.blur?.(); render(); return; }
    if (type === 'delete') { const item = current(); if (item) return action(() => api(`/api/learning/lessons/${encodeURIComponent(item.id)}`, 'DELETE', {}), 'Removed from future tasks.', () => { state.filter = 'removed'; state.selected = item.id; }); }
    if (type === 'restore') { const item = current(), revision = Number(button.dataset.revision); if (item && Number.isSafeInteger(revision) && revision > 0) return action(() => api(`/api/learning/lessons/${encodeURIComponent(item.id)}/restore`, 'POST', { revision }), 'Learning restored.', () => { state.filter = 'all'; state.selected = item.id; state.revision = null; }); }
    if (type === 'open-run') { const runId = button.dataset.id; state.request++; clearTimeout(poll); return onOpenRun?.(runId); }
  });
  document.addEventListener('change', async event => {
    if (!alive()) return;
    if (event.target.id === 'learning-mode') { const mode = event.target.value; event.target.blur?.(); return action(() => api('/api/learning/settings', 'POST', { mode })); }
    if (event.target.id === 'learning-run') state.runId = event.target.value;
    if (event.target.id === 'learning-revision') { state.revision = Number(event.target.value); event.target.blur?.(); render(); }
  });
  document.addEventListener('input', event => { if (alive() && event.target.id === 'learning-feedback') state.feedback = event.target.value; });
  document.addEventListener('keydown', event => {
    const tab = event.target.closest?.('[data-learning="tab"]');
    if (!alive() || !tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    state.tab = event.key === 'Home' ? 'saved' : event.key === 'End' ? 'activity' : state.tab === 'saved' ? 'activity' : 'saved';
    state.navigation++; state.selected = null; state.editing = false; state.revision = null; render();
    $(`[data-learning="tab"][data-tab="${state.tab}"]`)?.focus({ preventScroll: true });
  });
  document.addEventListener('toggle', event => { if (alive() && event.target.dataset?.learningPanel === 'options') state.optionsOpen = event.target.open; }, true);
  document.addEventListener('submit', async event => {
    if (event.target.id !== 'learning-editor' || !alive()) return; event.preventDefault();
    const item = lessons().find(entry => entry.id === event.target.dataset.lessonId); if (!item) return;
    const payload = { id: item.knowledgeId, kind: item.kind === 'skill' ? 'skill' : 'memory', title: $('#learning-title').value, summary: $('#learning-summary').value, content: $('#learning-content').value, cwd: item.cwd };
    return action(() => api('/api/knowledge', 'POST', payload), 'Learning updated.', () => { state.editing = false; document.activeElement?.blur?.(); });
  });
  function polling() { clearTimeout(poll); const context = owner(); poll = setTimeout(async () => { if (!owns(context)) return; if (!state.editing && !state.saving && !state.feedback) await load(); if (owns(context)) polling(); }, 2500); }
  return {
    async open({ knowledgeId } = {}) {
      state.session++; state.request++; clearTimeout(poll); state.editing = false; state.error = ''; state.data = null; state.wantedKnowledgeId = knowledgeId || null; state.revision = null; state.saving = null;
      showModal('learning', `<div class="modal-header"><span class="learning-mark">${icon('learning', 21)}</span><div class="modal-title"><h2>Learning history</h2><p>Learns as you work. Every saved change is inspectable.</p></div><button class="icon-button" data-action="close-modal" aria-label="Close learning history">${icon('close', 17)}</button></div><div id="learning-view" class="learning-workspace"></div>`, true);
      $('#modal-root .modal')?.classList.add('learning-modal'); render(); const context = owner(); await load(); if (owns(context)) polling();
    },
    refresh() { if (alive() && !state.editing) return load(); },
    close() { state.session++; state.request++; clearTimeout(poll); closeModal(); }
  };
}
