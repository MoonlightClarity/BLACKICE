import { applicationSessionModel, applicationSessionFrame, applicationSessionDocument, applicationSavedText, applicationEditorVersion } from './application-session-model.mjs';

const escapeText = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const stamp = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'this view';
const sessionState = state => ({ starting: 'Starting', ready: 'Ready', running: 'Running', stopping: 'Stopping', stopped: 'Stopped', closed: 'Closed', failed: 'Failed', interrupted: 'Interrupted', needs_attention: 'Needs inspection', blocked: 'Needs inspection', unsupported: 'Unsupported' }[state] || 'State unconfirmed');

export function installApplicationSessionStyles() {
  if (typeof document === 'undefined' || document.getElementById('blackice-application-session-styles')) return;
  const link = document.createElement('link'); link.id = 'blackice-application-session-styles'; link.rel = 'stylesheet'; link.href = '/application-session.css'; document.head.append(link);
}

function renderSavedText(state, model, button, sessionDisabled, escape) {
  const selected = model.documents.find(item => item.id === state.savedId), saved = state.savedDocument?.id === selected?.id ? state.savedDocument : null;
  const preview = state.restorePreview, restoring = saved && preview && preview.sessionId === model.selected?.id && preview.documentId === selected?.id;
  const snippet = value => escape(value.slice(0, 12000)) + (value.length > 12000 ? '\n… Preview shortened; the complete saved text is preserved.' : '');
  return `<section class="application-session-saved" aria-label="Saved text"><div class="application-session-saved-heading"><h3>Saved text</h3><span>Stored in BLACKICE · survives ending a session</span></div><p class="application-session-note">Save a version of the actual application editor. The draft field below is not saved until you apply it. This does not save a Notepad file on Windows.</p><div class="application-session-save-actions"><label class="application-session-sr-only" for="application-session-save-title">Title for saved text</label><input id="application-session-save-title" value="${escape(state.saveTitle || '')}" maxlength="120" placeholder="Optional version title"${state.busy ? ' disabled' : ''}>${button('save-text', 'Save text in BLACKICE', sessionDisabled || !model.documentStorage.healthy)}</div>${!model.documentStorage.healthy && model.documentStorage.error ? `<p class="application-session-note error">${escape(model.documentStorage.error)}</p>` : ''}${model.documents.length ? `<div class="application-session-saved-actions"><label>Saved version<select id="application-session-saved"${state.busy ? ' disabled' : ''}><option value="">Choose saved text</option>${model.documents.map(item => `<option value="${escape(item.id)}"${item.id === state.savedId ? ' selected' : ''}>${escape(item.title)} · ${item.characters.toLocaleString()} characters</option>`).join('')}</select></label>${button('read-saved', 'Read saved text', state.busy || !selected)}</div>` : '<p class="application-session-note">No saved text yet. Saved versions remain available here after a session ends or BLACKICE restarts.</p>'}${saved ? `<div class="application-session-saved-version"><div class="application-session-saved-meta"><strong>${escape(saved.title)}</strong><span>${escape(saved.source.applicationName || saved.source.appId)} · ${saved.characters.toLocaleString()} characters · saved ${escape(stamp(saved.createdAt))}</span></div><pre class="application-session-text">${snippet(saved.text)}</pre>${button('restore-preview', 'Compare with current editor', sessionDisabled || !model.documentStorage.healthy)}</div>` : ''}${restoring ? `<div class="application-session-restore-confirm" role="group" aria-label="Confirm restoring saved text"><strong>Replace the editor in ${escape(model.selected.name)}?</strong><p>BLACKICE will first save a recovery version of the current text, then restore “${escape(saved.title)}”. Your unapplied draft stays here. If the editor has changed since this comparison, restore will stop.</p><div class="application-session-compare"><div><h4>Current editor · ${preview.current.characters.toLocaleString()} characters</h4><pre class="application-session-text">${snippet(preview.current.text)}</pre></div><div><h4>Saved version · ${saved.characters.toLocaleString()} characters</h4><pre class="application-session-text">${snippet(saved.text)}</pre></div></div>${button('restore-confirm', 'Save recovery version and restore text', sessionDisabled || !model.documentStorage.healthy)}${button('restore-cancel', 'Keep current editor', state.busy)}</div>` : ''}</section>`;
}

function renderDraftEditorActions(state, model, button, sessionDisabled, escape) {
  if (!state.editorVersion || state.editorVersion.sessionId !== model.selected?.id || state.editorVersion.ref !== state.ref) return '';
  const candidate = state.draftReplaceCandidate;
  return `${button('edit-current', 'Edit current text', sessionDisabled || state.controlsStale !== false)}${candidate ? `<div class="application-session-draft-confirm" role="group" aria-label="Replace unapplied draft"><strong>Replace your unapplied draft with current editor text?</strong><p>Your draft has ${state.text.length.toLocaleString()} characters. The observed editor has ${candidate.version.characters.toLocaleString()} characters. This changes only the draft field; nothing is sent to the application.</p>${button('draft-replace-confirm', 'Replace draft with current editor text', sessionDisabled)}${button('draft-replace-cancel', 'Keep my draft', state.busy)}</div>` : ''}`;
}

function renderApplicationCompatibility(model, escape) {
  const info=model.compatibility;if(!info)return'';
  const label={verified:'Verified controls',blocked:'Startup blocked',not_admitted:'Not admitted'};
  return `<details class="application-compatibility"><summary>Application compatibility · ${info.apps.length} checked</summary><p>${escape(info.system)} · checked ${escape(info.testedAt)}</p><div class="application-compatibility-list">${info.apps.map(app=>`<article data-compatibility="${app.result}"><div><strong>${escape(app.name)}</strong><small>${escape(app.version)}</small></div><span>${label[app.result]}</span><p>${escape(app.detail)}</p></article>`).join('')}</div><p class="application-session-note">${escape(info.note)}</p></details>`;
}
function renderSessionDiagnostics(model,escape){
  const info=model.selected?.diagnostics;if(!info)return'';
  return `<details class="application-session-diagnostics"><summary>Startup &amp; cleanup details</summary><dl><div><dt>Owned processes observed</dt><dd>${info.processes??'Not recorded'}</dd></div><div><dt>Visible private windows</dt><dd>${info.windows??'Not recorded'}</dd></div><div><dt>Cleanup</dt><dd>${info.cleanupConfirmed?'Owned processes stopped':info.closed?'Session closed; complete cleanup evidence is unavailable':'Session still active'}</dd></div>${info.exitCodes.length?`<div><dt>Observed exit codes</dt><dd>${info.exitCodes.join(', ')}</dd></div>`:''}</dl>${!info.complete?'<p class="application-session-note">Some startup diagnostics are incomplete.</p>':''}</details>`;
}

export function renderApplicationSession(state, { escape = escapeText } = {}) {
  const model = applicationSessionModel(state.status, state.selectedId), control = state.document?.controls.find(item => item.ref === state.ref);
  const setupDisabled = !model.available || model.blocked, disabled = state.busy || setupDisabled || model.busy, sessionDisabled = disabled || !model.selected?.isolated || model.selected.state !== 'running';
  const button = (action, label, off = sessionDisabled) => `<button type="button" class="button" data-application-session="${action}"${off ? ' disabled' : ''}>${label}</button>`;
  return `<header class="application-session-heading"><div><h2>Application sessions</h2><p>Text editing and previews · private Windows desktops</p></div>${button('watch', state.watching ? 'Pause preview' : 'Resume preview', state.busy || !!state.restorePreview)}</header><p class="application-session-boundary">These sessions run separately from your Windows desktop. No desktop switching. Applications already open on your desktop stay there. Only compatible applications in the supported list can be started here. This version exposes editor text and previews; application menu actions are unavailable.</p>${renderApplicationCompatibility(model,escape)}<form id="application-session-create" class="application-session-create"><label>Application<select id="application-session-app"${setupDisabled || !model.supportedApps.length ? ' disabled' : ''}><option value="">Choose a supported application</option>${model.supportedApps.map(app => `<option value="${escape(app.appId)}"${state.appId === app.appId ? ' selected' : ''}${app.available ? '' : ' disabled'}>${escape(app.name)}${app.available ? '' : ' · Unavailable'}</option>`).join('')}</select></label><label>Session name<input id="application-session-name" value="${escape(state.name || '')}" maxlength="80" autocomplete="off" placeholder="Optional name"${setupDisabled ? ' disabled' : ''}></label><button type="submit" class="button"${disabled || !model.supportedApps.some(app => app.appId === state.appId && app.available) ? ' disabled' : ''}>Open application</button></form>${model.available && !model.supportedApps.some(app => app.available) ? '<p class="application-session-description">No compatible application is available in this runtime.</p>' : ''}${model.supportedApps.filter(app => !app.available).map(app => `<p class="application-session-description"><strong>${escape(app.name)} is unavailable.</strong> ${escape(app.reason || 'This application is not admitted by the current compatibility catalog.')}</p>`).join('')}${model.supportedApps.find(app => app.appId === state.appId)?.description ? `<p class="application-session-description">${escape(model.supportedApps.find(app => app.appId === state.appId).description)}</p>` : ''}<div class="application-session-toolbar"><label>Session<select id="application-session-selected"${state.busy ? ' disabled' : ''}><option value="">Follow latest session</option>${model.sessions.map(session => `<option value="${escape(session.id)}"${state.selectedId === session.id ? ' selected' : ''}>${escape(session.name)} · ${escape(sessionState(session.state))}</option>`).join('')}</select></label>${button('refresh', 'Refresh view', state.busy)}${button('inspect', 'Read editor')}${button('close-intent', 'End session', disabled || !model.selected || ['closed', 'stopped'].includes(model.selected.state))}</div>${state.closeConfirmId && state.closeConfirmId === model.selected?.id ? `<div class="application-session-close-confirm" role="group" aria-label="End isolated application session"><strong>End ${escape(model.selected.name)}?</strong><p>Unsaved work in this isolated application will be discarded. Text saved in BLACKICE remains available in Saved text.</p>${button('close-confirm', 'End session and discard unsaved work', disabled)}${button('close-cancel', 'Keep session', state.busy)}</div>` : ''}<p class="application-session-status${state.error ? ' error' : ''}" role="status" aria-live="polite">${escape(state.busy ? state.pending || 'Updating application session…' : state.error || state.notice || model.reason || model.selected?.reason || (state.restorePreview ? 'Preview paused while you compare saved text.' : state.watching ? 'Preview refreshes every five seconds while this view is visible.' : 'Preview paused. Refresh the view before interacting.'))}</p>${model.selected ? `<div class="application-session-title"><strong>${escape(model.selected.name)}</strong><span>${escape(model.selected.applicationName || model.selected.appId)} · ${escape(sessionState(model.selected.state))}</span></div>` : ''}<div class="application-session-stage">${state.frame ? `<img class="application-session-frame" src="${escape(state.frame.imageUrl)}" width="${state.frame.width}" height="${state.frame.height}" alt="Captured isolated application window" draggable="false"><p class="application-session-stamp">${state.stale ? 'Earlier frame · refresh before interacting' : `Captured ${escape(stamp(state.capturedAt))} · use observed controls below`}</p>` : `<div class="application-session-placeholder"><strong>${model.selected ? 'No current application frame' : 'Start an isolated application'}</strong><p>${model.selected ? ['closed', 'stopped', 'failed', 'interrupted'].includes(model.selected.state) ? 'This session has ended. Applications never relaunch automatically; start another session explicitly when ready.' : 'The application may still be starting or may not provide a capturable window. A frame appears only after the broker captures a real window.' : 'Choose a supported application to create a private session. Opening this view starts no Windows application.'}</p></div>`}</div>${renderSavedText(state, model, button, sessionDisabled, escape)}<details id="application-session-controls" class="application-session-controls"${state.controlsOpen ? ' open' : ''}><summary>Observed editor &amp; text${state.document ? ` · ${state.document.controls.length} observed controls` : ''}</summary>${state.document ? `<label>Control<select id="application-session-ref"${sessionDisabled ? ' disabled' : ''}>${state.document.controls.map(item => `<option value="${escape(item.ref)}"${item.ref === state.ref ? ' selected' : ''}>${escape(item.name)}${item.role ? ` · ${escape(item.role)}` : ''}</option>`).join('')}</select></label><div class="application-session-control-actions">${state.document.controls.some(item => item.invokable) ? button('invoke', 'Use control', sessionDisabled || state.controlsStale !== false || !control?.invokable) : ''}<label class="application-session-sr-only" for="application-session-text">Value for selected control</label><textarea id="application-session-text" rows="4" maxlength="10000" placeholder="Text for the observed editor · up to 10,000 characters" autocomplete="off"${sessionDisabled || state.controlsStale !== false || !control?.writable ? ' disabled' : ''}>${escape(state.text || '')}</textarea>${button('set-value', 'Set value', sessionDisabled || state.controlsStale !== false || !control?.writable)}${renderDraftEditorActions(state, model, button, sessionDisabled, escape)}</div>${state.document.reason ? `<p class="application-session-note">${escape(state.document.reason)}</p>` : ''}${state.document.text ? `<pre class="application-session-text">${escape(state.document.text)}</pre>` : '<p class="application-session-note">No readable text was returned.</p>'}` : '<p class="application-session-note">Read the editor to inspect the text fields this application exposes. Mouse and keyboard input on your Windows desktop is never used by this surface.</p>'}</details>${renderSessionDiagnostics(model,escape)}${model.selected?.output ? `<details class="application-session-output"><summary>Session output</summary><pre>${escape(model.selected.output)}</pre></details>` : ''}`;
}

/** The transport is intentionally limited to the isolated application-session broker. */
export function initApplicationSessionUI({ mount, api, isVisible = () => true, now = () => Date.now() }) {
  const $ = selector => mount.querySelector(selector), state = { status: {}, selectedId: null, appId: '', name: '', text: '', editorVersion: null, draftVersion: null, draftReplaceCandidate: null, saveTitle: '', savedId: '', savedDocument: null, restorePreview: null, ref: null, frame: null, document: null, controlsOpen: false, watching: true, busy: false, stale: true, controlsStale: true, controlsAt: null, active: false, generation: 0, nextAt: 0, controller: null, error: '', notice: '' };
  const visible = () => state.active && mount.isConnected !== false && isVisible();
  const remember = () => {
    for (const [key, id] of [['appId', 'app'], ['name', 'name'], ['text', 'text'], ['saveTitle', 'save-title']]) { const node = $('#application-session-' + id); if (node && node.value !== state.rendered?.[key]) { if (key === 'text' && !state.text && node.value) state.draftVersion = state.editorVersion?.sha256 || null; state[key] = node.value; } }
    if ($('#application-session-controls')) state.controlsOpen = $('#application-session-controls').open;
  };
  function focusRecord() { const node = typeof document === 'undefined' ? null : document.activeElement; return mount.contains?.(node) ? { id: node.id, action: node.dataset?.applicationSession, start: node.selectionStart, end: node.selectionEnd } : null; }
  function render() {
    remember(); const focused = typeof document === 'undefined' ? null : document.activeElement, focus = focusRecord() || (!focused || focused === document.body || focused.isConnected === false ? state.pendingFocus : null);
    mount.innerHTML = renderApplicationSession(state); mount.setAttribute?.('aria-busy', String(state.busy)); state.needsRender = false; state.rendered = { appId: state.appId, name: state.name, text: state.text, saveTitle: state.saveTitle };
    if (focus) { const replacement = focus.id ? $('#' + focus.id) : [...mount.querySelectorAll('[data-application-session]')].find(node => node.dataset.applicationSession === focus.action); replacement?.focus?.({ preventScroll: true }); if (Number.isInteger(focus.start)) try { replacement?.setSelectionRange?.(focus.start, focus.end); } catch {} }
  }
  function applyStatus(value) {
    const previous = applicationSessionModel(state.status, state.selectedId).selected; state.status = value;
    const model = applicationSessionModel(value, state.selectedId);
    if (model.selected?.id !== previous?.id || state.frame && state.frame.sessionId !== model.selected?.id) { state.frame = null; state.document = null; state.editorVersion = null; state.ref = null; state.restorePreview = null; state.draftReplaceCandidate = null; state.stale = true; state.controlsStale = true; }
    if (state.savedDocument && !model.documents.some(item => item.id === state.savedDocument.id && item.sha256 === state.savedDocument.sha256)) { state.savedDocument = null; state.restorePreview = null; }
    return model;
  }
  function adoptDocument(value, sessionId) {
    const observed = applicationSessionDocument(value, sessionId); if (!observed) return null;
    state.document = observed; state.editorVersion = applicationEditorVersion(value, sessionId); if (!state.text) state.draftVersion = state.editorVersion?.sha256 || null; state.controlsStale = false; state.controlsAt = now(); if (!observed.controls.some(control => control.ref === state.ref)) state.ref = (observed.controls.find(control => control.writable) || observed.controls.find(control => control.invokable) || observed.controls[0])?.ref || null;
    return observed;
  }
  async function savedWork(action, extra = {}) {
    if (!visible() || state.busy) return; remember(); state.pendingFocus = focusRecord();
    const generation = state.generation, controller = new AbortController(), current = () => visible() && generation === state.generation && state.controller === controller;
    state.controller = controller; state.mutationPending = false;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
    const request = async (path, body) => { if (!current()) throw Error('Application session view closed.'); return api(path, { method: body ? 'POST' : 'GET', ...(body ? { body } : {}), signal }); };
    const send = body => request('/api/application-sessions/action', body); let dispatched = false;
    state.busy = true; state.error = ''; state.notice = ''; state.pending = ({ save_text: 'Saving the actual editor text in BLACKICE…', read_document: 'Reading saved text…', preview_restore: 'Comparing saved text with the current editor…', restore_document: 'Saving a recovery version and restoring the selected text…' })[action]; render();
    try {
      const model = applyStatus(await request('/api/application-sessions/status')); if (!current()) return;
      const target = model.documents.find(item => item.id === extra.documentId);
      if (action !== 'read_document' && (!model.available || model.blocked || model.busy)) throw Error(model.reason || 'An application operation is still settling. Refresh before continuing.');
      if (action !== 'read_document' && (!model.selected?.isolated || model.selected.state !== 'running' || model.selected.id !== extra.sessionId)) throw Error('The selected session changed or is no longer running. Compare again before restoring text.');
      if (action !== 'read_document' && !model.documentStorage.healthy) throw Error(model.documentStorage.error || 'Saved text storage is not ready.');
      if (action !== 'save_text' && (!target || state.savedId !== extra.documentId)) throw Error('That saved version is no longer available. Choose it again.');
      if (action === 'read_document' || action === 'preview_restore') {
        const result = await send({ action: 'read_document', documentId: target.id }); if (!current()) return;
        const saved = applicationSavedText(result, target); if (!saved) throw Error('The saved text did not match its recorded version. No editor was changed.');
        state.savedDocument = saved; state.restorePreview = null;
        if (action === 'preview_restore') {
          const observation = await send({ action: 'inspect', sessionId: extra.sessionId }); if (!current()) return;
          const editor = applicationEditorVersion(observation, extra.sessionId); if (!editor) throw Error('The current editor could not be read as one complete text field. No editor was changed.');
          adoptDocument(observation, extra.sessionId); state.restorePreview = { sessionId: extra.sessionId, documentId: target.id, documentSha256: target.sha256, current: editor };
        } else state.notice = 'Saved text loaded. Reading saved versions starts no application.';
      } else {
        if (action === 'restore_document') {
          const preview = state.restorePreview;
          if (!preview || preview.sessionId !== extra.sessionId || preview.documentId !== target.id || preview.documentSha256 !== target.sha256 || preview.current.sha256 !== extra.expectedTextSha256) throw Error('The comparison is no longer current. Compare with the editor again before restoring.');
        }
        dispatched = true; state.mutationPending = true;
        const result = await send({ action, sessionId: extra.sessionId, ...(action === 'save_text' ? extra.title ? { title: extra.title } : {} : { documentId: extra.documentId, expectedTextSha256: extra.expectedTextSha256 }) }); if (!current()) return;
        if (result.sessionId !== extra.sessionId || !result.document?.id || action === 'restore_document' && (result.verified !== true || result.unchanged !== true && !result.recoveryDocument?.id)) throw Error('The saved text operation returned no complete verification receipt.');
        state.restorePreview = null; state.stale = true;
        const updated = applyStatus(await request('/api/application-sessions/status')); if (!current()) return;
        const saved = updated.documents.find(item => item.id === result.document.id && item.sha256 === result.document.sha256);
        if (!saved) throw Error('The saved version is not yet confirmed in BLACKICE. Inspect Saved text before repeating.');
        state.savedId = saved.id; state.savedDocument = null;
        if (action === 'restore_document') {
          const observation = await send({ action: 'inspect', sessionId: extra.sessionId }); if (!current()) return;
          adoptDocument(observation, extra.sessionId); state.notice = result.unchanged === true ? 'Editor already matches the saved version; no replacement was needed.' : 'Saved text restored and verified. The previous editor text was saved as a recovery version.';
        } else state.notice = `Saved “${saved.title}” in BLACKICE. The application file remains unsaved.`;
      }
    } catch (error) {
      if (current()) { state.error = String(error.message || 'Saved text could not be updated.').slice(0, 800) + (dispatched ? ' The action may have completed. Inspect Saved text and the editor before repeating it.' : ''); state.restorePreview = null; state.controlsStale = true; state.watching = false; }
    } finally {
      if (current()) { state.busy = false; state.pending = ''; state.controller = null; state.mutationPending = false; state.nextAt = now() + 5000; render(); state.pendingFocus = null; }
      else if (generation === state.generation && state.controller === controller) { state.controller = null; state.busy = false; state.controlsStale = true; state.pendingFocus = null; state.needsRender = true; state.restorePreview = null; if (dispatched) { state.watching = false; state.error = 'The view became hidden while a saved text action was pending. Inspect Saved text and the editor before repeating it.'; } state.mutationPending = false; }
    }
  }
  async function work(action = 'refresh', extra = {}) {
    if (!visible() || state.busy) return; remember(); state.pendingFocus = focusRecord();
    const generation = state.generation, controller = new AbortController(), current = () => visible() && generation === state.generation && state.controller === controller;
    state.controller = controller; state.mutationPending = false; const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
    const request = async (path, method = 'GET', body) => { if (!current()) throw Error('Application session view closed.'); return api(path, { method, ...(body ? { body } : {}), signal }); };
    const send = body => request('/api/application-sessions/action', 'POST', body);
    const mutation = ['create', 'control', 'close'].includes(action); let dispatched = false;
    state.busy = true; state.error = ''; state.notice = ''; state.pending = action === 'create' ? 'Starting the selected application on a private desktop…' : action === 'close' ? 'Ending the selected private session…' : action === 'control' ? 'Applying an observed application control…' : action === 'inspect' ? 'Reading isolated application controls…' : 'Refreshing isolated application view…'; render();
    try {
      let model = applyStatus(await request('/api/application-sessions/status')); if (!current()) return;
      if (!model.available || model.blocked) throw Error(model.reason);
      if (model.busy) { state.notice = 'An application operation is still settling. Refresh after it completes.'; return; }
      let sessionId = model.selected?.id;
      if (action === 'close' && extra.expectedSessionId !== sessionId) throw Error('The selected session changed. Choose the session again before ending it.');
      if (action === 'create' && !model.supportedApps.some(app => app.appId === extra.appId && app.available)) throw Error('Choose an application from the current supported list.');
      if (!['refresh', 'create'].includes(action) && !sessionId) throw Error('Choose an isolated application session first.');
      if (['inspect', 'control'].includes(action) && (!model.selected?.isolated || model.selected.state !== 'running')) throw Error(model.selected?.reason || 'That session is not running. Start another session explicitly if needed.');
      if (action === 'control') {
        const observed = adoptDocument(await send({ action: 'inspect', sessionId }), sessionId); if (!current()) return;
        const control = observed?.controls.find(control => control.ref === extra.ref);
        if (!control || extra.operation === 'invoke' && !control.invokable || extra.operation === 'set_value' && !control.writable) throw Error('That control is no longer available. Read the current controls before interacting.');
      }
      if (action !== 'refresh') {
        dispatched = mutation; state.mutationPending = mutation;
        const { expectedSessionId, ...transportExtra } = extra;
        const result = await send({ ...transportExtra, action, ...(action === 'create' ? {} : { sessionId }) }); if (!current()) return;
        if (action === 'create') { const createdId = result.sessionId || result.id; if (typeof createdId !== 'string' || !createdId) throw Error('The application broker did not return its new session identity.'); state.selectedId = sessionId = createdId; }
        if (action === 'close') { state.closeConfirmId = null; state.selectedId = null; state.frame = null; state.document = null; state.ref = null; state.text = ''; }
        if (mutation) state.stale = true;
        model = applyStatus(await request('/api/application-sessions/status')); if (!current()) return;
        if (!model.available || model.blocked || action !== 'close' && model.selected?.id !== sessionId) throw Error('The isolated session is no longer available. Inspect the current session list.');
        if (action === 'close') sessionId = model.selected?.id;
        else if (!adoptDocument(result, sessionId) && action === 'inspect') throw Error('The application broker returned no valid control observation.');
      }
      if (sessionId && model.selected.isolated && model.selected.state === 'running') {
        if (action !== 'inspect') { const result = await send({ action: 'inspect', sessionId }); if (!current()) return; if (!adoptDocument(result, sessionId)) throw Error('The application broker returned no valid control observation.'); }
        const result = await send({ action: 'screenshot', sessionId }); if (!current()) return;
        const frame = applicationSessionFrame(result, sessionId);
        if (!frame) { state.frame = null; state.stale = true; state.notice = String(result.reason || 'No capturable application window is ready. Refresh to check its current state.').slice(0, 800); }
        else { state.frame = frame; state.capturedAt = frame.capturedAt || new Date(now()).toISOString(); state.stale = false; }
      } else { state.frame = null; state.document = null; state.ref = null; }
    } catch (error) {
      if (current()) { state.error = String(error.message || 'The application session could not be updated.').slice(0, 800) + (dispatched ? ' The action may have completed. Inspect the session before repeating it.' : ''); state.stale = true; state.controlsStale = true; state.watching = false; }
      if (current() && action === 'control' && extra.operation === 'set_value') { const id = applicationSessionModel(state.status, state.selectedId).selected?.id; if (id) try { const result = await send({ action: 'inspect', sessionId: id }); if (current()) adoptDocument(result, id); } catch {} }
    } finally {
      if (current()) { state.busy = false; state.pending = ''; state.controller = null; state.mutationPending = false; state.nextAt = now() + 5000; render(); state.pendingFocus = null; }
      else if (generation === state.generation && state.controller === controller) { state.controller = null; state.busy = false; state.stale = true; state.controlsStale = true; state.nextAt = 0; state.pendingFocus = null; state.needsRender = true; if (dispatched) { state.watching = false; state.error = 'The view became hidden while an application action was pending. Inspect the session before repeating it.'; } state.mutationPending = false; }
    }
  }
  const click = async event => {
    const button = event.target.closest?.('[data-application-session]'); if (!button || !mount.contains(button) || !visible() || state.busy || button.disabled) return;
    remember(); const action = button.dataset.applicationSession;
    const model = applicationSessionModel(state.status, state.selectedId);
    const editCurrent = version => { state.text = version.text; state.draftVersion = version.sha256; state.draftReplaceCandidate = null; state.notice = 'Current editor text loaded into your draft. Review or edit it before applying.'; render(); };
    if (action === 'edit-current') { const version = state.editorVersion; if (!version || version.sessionId !== model.selected?.id || version.ref !== state.ref || state.controlsStale !== false) return; if (state.text) { state.draftReplaceCandidate = { version, draftText: state.text }; render(); } else editCurrent(version); return; }
    if (action === 'draft-replace-cancel') { state.draftReplaceCandidate = null; render(); return; }
    if (action === 'draft-replace-confirm') { const candidate = state.draftReplaceCandidate; if (!candidate) return; if (candidate.version.sessionId !== model.selected?.id || candidate.version.sha256 !== state.editorVersion?.sha256 || candidate.draftText !== state.text) { state.draftReplaceCandidate = null; state.error = 'The editor or your draft changed during confirmation. Read the editor again before replacing your draft.'; render(); } else editCurrent(candidate.version); return; }
    if (action === 'save-text') { state.restorePreview = null; await savedWork('save_text', { sessionId: model.selected?.id, ...(state.saveTitle.trim() ? { title: state.saveTitle.trim().slice(0, 120) } : {}) }); return; }
    if (action === 'read-saved') { state.restorePreview = null; await savedWork('read_document', { documentId: state.savedId }); return; }
    if (action === 'restore-preview') { await savedWork('preview_restore', { sessionId: model.selected?.id, documentId: state.savedId }); return; }
    if (action === 'restore-cancel') { state.restorePreview = null; state.nextAt = now() + 5000; render(); return; }
    if (action === 'restore-confirm') { const preview = state.restorePreview; if (preview) await savedWork('restore_document', { sessionId: preview.sessionId, documentId: preview.documentId, expectedTextSha256: preview.current.sha256 }); return; }
    if (action === 'close-intent') { const selected = applicationSessionModel(state.status, state.selectedId).selected; if (selected) { state.selectedId = selected.id; state.closeConfirmId = selected.id; render(); } return; }
    if (action === 'close-cancel') { state.closeConfirmId = null; render(); return; }
    if (action === 'close-confirm') { if (state.closeConfirmId) await work('close', { expectedSessionId: state.closeConfirmId }); return; }
    if (action === 'watch') { state.watching = !state.watching; state.nextAt = 0; render(); if (state.watching) await work(); return; }
    if (action === 'invoke' || action === 'set-value') {
      state.restorePreview = null;
      const control = state.document?.controls.find(item => item.ref === state.ref); if (!control || state.controlsStale !== false) return;
      const text = state.text, generation = state.generation; if (action === 'set-value' && (text.length > 10000 || text.includes('\0'))) { state.error = 'Editor text must contain at most 10,000 characters and no null characters.'; render(); return; } await work('control', { ref: control.ref, operation: action === 'invoke' ? 'invoke' : 'set_value', ...(action === 'set-value' ? { text, ...(state.draftVersion ? { expectedTextSha256: state.draftVersion } : {}) } : {}) });
      if (visible() && generation === state.generation && !state.error && action === 'set-value' && state.text === text) { state.text = ''; state.draftVersion = state.editorVersion?.sha256 || null; if ($('#application-session-text')) $('#application-session-text').value = ''; } return;
    }
    if (['refresh', 'inspect'].includes(action)) { state.restorePreview = null; await work(action); }
  };
  const submit = async event => { if (event.target.id !== 'application-session-create') return; event.preventDefault(); if (!visible() || state.busy) return; remember(); await work('create', { appId: state.appId, ...(state.name.trim() ? { name: state.name.trim().slice(0, 80) } : {}) }); };
  const change = async event => {
    if (!visible() || state.busy) return; remember();
    if (event.target.id === 'application-session-selected') { state.selectedId = event.target.value || null; state.closeConfirmId = null; state.restorePreview = null; state.draftReplaceCandidate = null; state.frame = null; state.document = null; state.editorVersion = null; state.draftVersion = null; state.ref = null; state.text = ''; state.stale = true; state.controlsStale = true; render(); await work(); }
    if (event.target.id === 'application-session-saved') { state.savedId = event.target.value; state.savedDocument = null; state.restorePreview = null; render(); }
    if (event.target.id === 'application-session-ref') { state.draftReplaceCandidate = null; state.ref = event.target.value; state.text = ''; state.draftVersion = state.editorVersion?.sha256 || null; if ($('#application-session-text')) $('#application-session-text').value = ''; render(); }
    if (event.target.id === 'application-session-app') render();
  };
  mount.addEventListener('click', click); mount.addEventListener('submit', submit); mount.addEventListener('change', change); render();
  return {
    enter() { state.active = true; state.nextAt = 0; return work(); },
    update() {
      if (!visible()) { if (state.restorePreview) { state.restorePreview = null; state.needsRender = true; } if (state.active && state.controller) { state.generation++; state.controller.abort(); state.controller = null; state.busy = false; state.stale = true; state.controlsStale = true; state.nextAt = 0; state.pendingFocus = null; state.needsRender = true; if (state.mutationPending) { state.watching = false; state.error = 'The view became hidden while an application action was pending. Inspect the session before repeating it.'; } state.mutationPending = false; } return; }
      let changed = state.needsRender; if (!state.stale && now() - Date.parse(state.capturedAt) > 10000) { state.stale = true; changed = true; } if (!state.controlsStale && now() - state.controlsAt > 10000) { state.controlsStale = true; changed = true; } if (changed) render(); if (state.watching && !state.restorePreview && !state.busy && now() >= state.nextAt) void work();
    },
    leave() { remember(); state.active = false; state.generation++; state.controller?.abort(); state.controller = null; state.busy = false; state.frame = null; state.document = null; state.ref = null; state.restorePreview = null; state.draftReplaceCandidate = null; state.savedDocument = null; state.pendingFocus = null; state.rendered = null; state.error = ''; state.notice = ''; state.closeConfirmId = null; state.stale = true; state.controlsStale = true; state.mutationPending = false; mount.innerHTML = ''; },
    destroy() { this.leave(); mount.removeEventListener('click', click); mount.removeEventListener('submit', submit); mount.removeEventListener('change', change); }
  };
}
