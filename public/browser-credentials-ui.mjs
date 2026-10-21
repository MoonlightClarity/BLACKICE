const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const text = (value, limit = 512) => typeof value === 'string' ? value.slice(0, limit) : '';
const destinations = [['chrome', 'Google Chrome'], ['firefox', 'Mozilla Firefox'], ['neo', 'BrowserOS Neo']];
const states = { pending: 'Pending', awaiting_browser_import: 'Awaiting browser import', confirmed_by_user: 'Confirmed by you', failed: 'Failed', cancelled: 'Cancelled' };
const name = id => destinations.find(([value]) => value === id)?.[1] || 'Browser';
const requestId = () => `credentials-${globalThis.crypto.randomUUID()}`;
const button = (action, label, extra = '') => `<button type="button" data-credentials-action="${action}"${extra}>${label}</button>`;
const safeOrigin = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.origin : ''; } catch { return ''; } };

/** Deliberately project metadata. Unexpected secret or export-path fields never enter UI state. */
export function browserCredentialsView(value = {}) {
  const vault = value.vault || {}, mirror = value.mirror || {};
  const entry = item => ({ credentialId: text(item.credentialId, 160), revision: item.revision, origin: safeOrigin(item.origin), username: text(item.username), label: text(item.label, 160), source: text(item.source, 64), createdAt: text(item.createdAt, 80), updatedAt: text(item.updatedAt, 80) });
  const queue = item => ({ id: text(item.id, 160), credentialId: text(item.credentialId, 160), credentialRevision: item.credentialRevision, destination: text(item.destination, 40), state: Object.hasOwn(states, item.state) ? item.state : 'failed', batchId: text(item.batchId, 160) });
  const batch = item => ({ batchId: text(item.batchId, 160), state: Object.hasOwn(states, item.state) ? item.state : 'failed', count: Number.isSafeInteger(item.count) ? item.count : 0, destination: text(item.destination, 40), expiresAt: text(item.expiresAt, 80), entryIds: (Array.isArray(item.entryIds) ? item.entryIds : []).map(id => text(id, 160)) });
  return {
    localManagement: value.localManagement !== false,
    vault: { available: vault.available === true, healthy: vault.healthy !== false, revision: vault.revision, capabilities: { save: vault.capabilities?.save === true, delete: vault.capabilities?.delete === true }, entries: (Array.isArray(vault.entries) ? vault.entries : []).map(entry) },
    mirror: { available: mirror.available === true, healthy: mirror.healthy !== false, revision: mirror.revision, settings: { enabled: mirror.settings?.enabled === true, destination: destinations.some(([id]) => id === mirror.settings?.destination) ? mirror.settings.destination : 'chrome' }, capabilities: { configure: mirror.capabilities?.configure === true, queue: mirror.capabilities?.queue === true, beginImport: mirror.capabilities?.beginImport === true }, entries: (Array.isArray(mirror.entries) ? mirror.entries : []).map(queue), batches: (Array.isArray(mirror.batches) ? mirror.batches : []).map(batch) },
    destinations: destinations.map(([id, label]) => { const found = value.destinations?.find?.(item => item.id === id); return { id, name: label, available: found?.available === true && found?.supported !== false }; }),
  };
}

function safeError(error) {
  const messages = {
    CREDENTIAL_REVISION_CONFLICT: 'The vault changed. Review its current entries, then save your draft again. Your local password field has been kept.',
    CREDENTIAL_MIRROR_REVISION_CONFLICT: 'The copy queue changed. Review the current queue before starting another import.',
    CREDENTIAL_EXISTS: 'A login for this site and username is already saved. Use Replace password on that entry to update it explicitly.',
    CREDENTIAL_MISSING: 'This saved login is no longer available. Refresh the vault before continuing.',
    CREDENTIAL_STORAGE_UNAVAILABLE: 'Protected password storage is unavailable on this computer.',
    CREDENTIAL_STORAGE: 'The encrypted vault could not be opened or saved. Unlock your system key storage if requested, then check status.',
    CREDENTIAL_LOCAL_ONLY: 'Manage passwords in BLACKICE on the host computer.',
    CREDENTIAL_MIRROR_UNAVAILABLE: 'Browser password copying is unavailable. Check status before continuing.',
    CREDENTIAL_DESTINATION_UNAVAILABLE: 'The selected browser is not available in a supported location.',
    CREDENTIAL_DESTINATION_LAUNCH_FAILED: 'The browser could not be opened. Check the copy queue before trying again.',
    CREDENTIAL_DESTINATION_UNCERTAIN: 'The browser may have opened. Check its password manager and the copy queue before continuing.',
    CREDENTIAL_IMPORT_HANDOFF_FAILED: 'The browser import handoff was not confirmed. Check the browser and recover the same request receipt before starting another import.',
    CREDENTIAL_EXPORT_PROTECTION: 'A protected temporary export could not be prepared. No browser import was confirmed.',
    CREDENTIAL_INVALID: 'Check the site, username, and password fields, then try again.',
    CREDENTIAL_REQUEST_CONFLICT: 'This request no longer matches the original submission. Check the vault before starting a new request.',
    CREDENTIAL_MIRROR_REQUEST_CONFLICT: 'This request no longer matches the original copy. Check the queue before starting a new request.',
  };
  return messages[error?.code] || (error?.uncertain || !error?.status || error.status >= 500 ? 'BLACKICE could not confirm the result. Check status; do not assume the operation failed.' : 'The request was not accepted. Check status and review the selected entries before trying again.');
}

function shell(remote) {
  if (remote) return '<section class="browser-credentials" aria-label="Password manager"><h2>Password manager</h2><p>Manage encrypted passwords and browser imports in BLACKICE on the host computer.</p></section>';
  return `<section class="browser-credentials" aria-label="Password manager"><header class="credentials-heading"><div><p class="credentials-eyebrow">Local passwords</p><h2>Password manager</h2></div><span id="credentials-vault-state" class="credentials-state">Checking…</span></header><p>Save logins in BLACKICE’s encrypted vault, then copy selected passwords to your browser’s native password manager.</p><div class="credentials-feedback"><p id="credentials-error" class="credentials-error" role="alert" hidden></p><p id="credentials-receipt" class="credentials-receipt" role="status" hidden></p></div><div class="credentials-actions">${button('refresh', 'Check status')}${button('retry-save', 'Retry the same save', ' hidden')}${button('retry-operation', 'Retry the same request', ' hidden')}</div><p id="credentials-unavailable" class="credentials-note" hidden>Protected system storage is unavailable or needs attention. Password changes are disabled.</p><details id="credentials-add" class="credentials-section"><summary>Add an existing login</summary><form id="credentials-login-form" autocomplete="off"><div class="credentials-form-grid"><label>Site<input id="credentials-origin" name="credential-origin" type="url" placeholder="https://example.com" required maxlength="2048" autocomplete="off" spellcheck="false"></label><label>Username or email <span class="credentials-optional">(optional)</span><input id="credentials-username" name="credential-username" type="text" maxlength="320" autocomplete="off" spellcheck="false"></label><label>Label <span class="credentials-optional">(optional)</span><input id="credentials-label" name="credential-label" type="text" maxlength="160" autocomplete="off"></label><label>Password<input id="credentials-password" name="credential-password" type="password" required maxlength="1024" autocomplete="new-password" spellcheck="false"></label></div><p id="credentials-editing" class="credentials-note" hidden></p>${button('review-revision', 'Use current revision for this draft', ' hidden')}<div class="credentials-actions"><button id="credentials-save" type="submit">Save login</button>${button('clear-draft', 'Clear local form')}</div><p class="credentials-note">The password is sent only to this local vault. It stays masked here and is cleared after a confirmed save. Passwords generated by BLACKICE tools also appear in the saved list.</p></form></details><section class="credentials-section" aria-label="Saved logins"><div class="credentials-heading"><h3>Saved logins</h3><span id="credentials-selected" class="credentials-note">0 selected</span></div><div id="credentials-list"></div><div id="credentials-delete-review"></div></section><section class="credentials-section" aria-label="Copy passwords to a browser"><h3>Copy to your browser</h3><form id="credentials-preferences"><label class="credentials-destination">Browser password manager<select id="credentials-destination" aria-describedby="credentials-destination-note">${destinations.map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select></label><p id="credentials-destination-note" class="credentials-note"></p><label class="credentials-checkbox"><input id="credentials-auto-queue" type="checkbox"><span>Automatically queue saved passwords<small>Includes current saved revisions and new or updated passwords. The queue remains encrypted. You still start each native import below.</small></span></label><button id="credentials-save-preferences" type="submit">Save copy preferences</button></form><p class="credentials-note">Choose the destination profile in the browser and unlock its password manager if asked. Copying creates a temporary, unencrypted CSV for native import. BLACKICE removes it after five minutes, or when you confirm, cancel, or close BLACKICE.</p><div class="credentials-actions">${button('copy-selected', 'Copy to browser password manager')}${button('queue-selected', 'Queue selected for later')}</div><p class="credentials-note">This copies passwords saved in BLACKICE. It does not import browser sign-ins, cookies, or an authenticated account session.</p></section><section class="credentials-section" aria-label="Browser copy queue"><div class="credentials-heading"><h3>Copy queue</h3><span id="credentials-queue-count" class="credentials-note"></span></div><div id="credentials-queue"></div><div class="credentials-actions">${button('copy-queued', 'Copy selected queued passwords')}</div><div id="credentials-batches"></div></section></section>`;
}

/** The secret input is a persistent DOM node. Polling never reads or serializes its value. */
export function mountBrowserCredentials({ mount, api, presence, onIdle, intervalMs = 3000, makeRequestId = requestId } = {}) {
  if (!mount || typeof api !== 'function') throw Error('Password manager requires a Settings mount and local API.');
  const document = mount.ownerDocument || globalThis.document;
  const state = { current: browserCredentialsView(), remote: presence?.localManagement === false || (typeof location !== 'undefined' && location.protocol === 'https:'), loading: true, busy: '', error: '', receipt: '', selected: new Map(), queued: new Map(), editing: null, deleting: null, preferencesDirty: false, saveAttempt: null, operation: null, formVersion: 0 };
  let destroyed = false, fetching = null, pointer = false, idleTimer, refreshSequence = 0;
  const regions = new Map();
  const $ = selector => mount.querySelector(selector);
  mount.innerHTML = shell(state.remote);
  const fields = () => ['origin', 'username', 'label', 'password'].map(key => $(`#credentials-${key}`)).filter(Boolean);
  const canVault = key => !state.remote && !state.loading && state.current.vault.available && state.current.vault.healthy && state.current.vault.capabilities[key];
  const canMirror = key => !state.remote && !state.loading && state.current.mirror.available && state.current.mirror.healthy && state.current.mirror.capabilities[key];
  const destination = () => $('#credentials-destination')?.value || state.current.mirror.settings.destination;
  const available = id => state.current.destinations.some(item => item.id === id && item.available);
  const chosen = () => [...state.selected].map(([credentialId, revision]) => ({ credentialId, revision }));
  const message = (id, value) => { const node = $(`#${id}`); if (node) { node.textContent = value || ''; node.hidden = !value; } };
  function region(id, html) {
    const node = $(`#${id}`); if (!node || regions.get(id) === html) return;
    if (pointer || node.contains(document?.activeElement)) return;
    node.innerHTML = html; regions.set(id, html);
  }
  function blocked(action, value) { const node = $(`[data-credentials-action="${action}"]`); if (node) node.setAttribute('aria-disabled', String(Boolean(value))); }
  function render() {
    if (destroyed || state.remote) return;
    mount.setAttribute('aria-busy', String(Boolean(state.busy || state.loading)));
    // Even a notice above the form can move a native click target between down and up.
    if (pointer) return;
    const vault = state.current.vault, mirror = state.current.mirror, busy = Boolean(state.busy), uncertain = Boolean(state.saveAttempt?.uncertain || state.operation?.uncertain);
    message('credentials-vault-state', state.loading ? 'Checking…' : vault.available && vault.healthy ? 'Encrypted vault' : 'Unavailable');
    message('credentials-error', state.error); message('credentials-receipt', state.receipt);
    $('#credentials-unavailable').hidden = state.loading || vault.available && vault.healthy;
    message('credentials-selected', `${state.selected.size} selected`);
    const currentEdit = state.editing && vault.entries.find(item => item.credentialId === state.editing.credentialId);
    const editChanged = Boolean(state.editing && (!currentEdit || currentEdit.revision !== state.editing.revision));
    message('credentials-editing', state.editing ? editChanged ? currentEdit ? `This login changed while you were editing. Current saved entry: ${currentEdit.origin} · ${currentEdit.username}, revision ${currentEdit.revision}. Review it before applying your local draft.` : 'This login was removed from the vault. Your local draft remains here; it has not been saved.' : `Replacing the password for ${state.editing.origin} · ${state.editing.username}. The saved password is never filled into this form.` : '');
    const reviewRevision = $('[data-credentials-action="review-revision"]');
    if (reviewRevision) { reviewRevision.hidden = !editChanged || !currentEdit; reviewRevision.setAttribute('aria-disabled', String(busy || uncertain)); }
    const retrySave = $('[data-credentials-action="retry-save"]'), retryOperation = $('[data-credentials-action="retry-operation"]');
    retrySave.hidden = !state.saveAttempt?.uncertain; retryOperation.hidden = !state.operation?.uncertain;
    for (const field of fields()) { field.readOnly = busy || Boolean(state.saveAttempt?.uncertain); field.disabled = !canVault('save'); }
    $('#credentials-save').disabled = busy || !canVault('save') || uncertain || editChanged;
    $('#credentials-save').textContent = state.busy === 'save' ? 'Saving…' : state.editing ? 'Replace saved password' : 'Save login';
    $('#credentials-destination').disabled = busy || uncertain || !canMirror('configure');
    $('#credentials-auto-queue').disabled = busy || uncertain || !canMirror('configure');
    $('#credentials-save-preferences').disabled = busy || uncertain || !canMirror('configure') || !state.preferencesDirty;
    message('credentials-destination-note', available(destination()) ? 'The browser opens its password-manager/settings page. Choose the profile, then use its native Import passwords controls to finish the import.' : 'This browser is not available in a supported location. You can keep passwords in the vault and check again after installing it.');
    for (const option of $('#credentials-destination').querySelectorAll('option')) option.textContent = `${name(option.value)}${available(option.value) ? '' : ' · unavailable'}`;
    for (const action of ['refresh', 'retry-save', 'retry-operation', 'clear-draft']) blocked(action, busy);
    for (const action of ['copy-selected', 'queue-selected']) blocked(action, busy || uncertain || !state.selected.size || !canMirror('queue') || action === 'copy-selected' && (!canMirror('beginImport') || !available(destination())));
    blocked('copy-queued', busy || uncertain || !state.queued.size || !canMirror('beginImport'));
    const list = vault.entries.map(item => `<li data-credentials-entry="${escape(item.credentialId)}"><label class="credentials-checkbox"><input type="checkbox" data-credentials-select="${escape(item.credentialId)}" data-credential-revision="${escape(item.revision)}"${state.selected.has(item.credentialId) ? ' checked' : ''}><span><strong>${escape(item.label || item.origin)}</strong><small>${escape(item.origin)} · ${escape(item.username)}</small></span></label><div class="credentials-row-actions">${button('edit', 'Replace password', ` data-credential-id="${escape(item.credentialId)}"`)}${button('delete-review', 'Remove', ` data-credential-id="${escape(item.credentialId)}"`)}</div></li>`).join('');
    region('credentials-list', list ? `<ul class="credentials-list">${list}</ul>` : `<p class="credentials-note">${state.loading ? 'Loading saved logins…' : 'No logins saved yet.'}</p>`);
    const deletion = vault.entries.find(item => item.credentialId === state.deleting?.credentialId);
    region('credentials-delete-review', deletion ? `<div class="credentials-import-card"><p>Remove <strong>${escape(deletion.origin)} · ${escape(deletion.username)}</strong> from BLACKICE’s vault? Existing copies in your browser will remain.</p><div class="credentials-actions">${button('delete-confirm', 'Remove from vault')}${button('delete-cancel', 'Keep login')}</div></div>` : '');
    const pending = mirror.entries.filter(item => item.state === 'pending');
    message('credentials-queue-count', `${pending.length} pending`);
    const queue = mirror.entries.filter(item => !item.batchId).map(item => { const credential = vault.entries.find(value => value.credentialId === item.credentialId); return `<li><label class="credentials-checkbox"><input type="checkbox" data-credentials-queue="${escape(item.id)}" data-credential-revision="${escape(item.credentialRevision)}"${state.queued.has(item.id) ? ' checked' : ''}${item.state !== 'pending' ? ' disabled' : ''}><span><strong>${escape(credential?.label || credential?.origin || 'Saved login')}</strong><small>${escape(credential?.username || '')} · ${escape(name(item.destination))} · ${states[item.state]}</small></span></label></li>`; }).join('');
    region('credentials-queue', queue ? `<ul class="credentials-list">${queue}</ul>` : '<p class="credentials-note">No passwords waiting in the queue.</p>');
    region('credentials-batches', mirror.batches.map(batch => `<article class="credentials-import-card"><div class="credentials-heading"><h4>${escape(name(batch.destination))} · ${batch.count} ${batch.count === 1 ? 'password' : 'passwords'}</h4><span class="credentials-state">${states[batch.state]}</span></div>${batch.state === 'awaiting_browser_import' ? `<ol><li>Choose the intended profile in ${escape(name(batch.destination))} and unlock its password manager if prompted.</li><li>Choose <strong>Import passwords</strong>, then select the temporary CSV shown in the opened folder.</li><li>After the browser reports the import result, return here to confirm or cancel.</li></ol><p class="credentials-note">The temporary file expires ${escape(batch.expiresAt ? new Date(batch.expiresAt).toLocaleTimeString() : 'after five minutes')}. Opening the browser does not mean the import completed.</p><div class="credentials-actions">${button('confirm', 'I imported these passwords', ` data-credentials-batch="${escape(batch.batchId)}"`)}${button('cancel', 'Cancel and remove temporary file', ` data-credentials-batch="${escape(batch.batchId)}"`)}</div>` : `<p class="credentials-note">${batch.state === 'confirmed_by_user' ? 'You confirmed the browser import. BLACKICE has not independently verified the browser’s saved passwords.' : batch.state === 'cancelled' ? 'This handoff was cancelled. Any import already completed in the browser is not undone.' : batch.state === 'failed' ? 'This handoff was not completed. Check the browser before starting another import.' : 'Waiting for a local import handoff.'}</p>`}</article>`).join(''));
  }
  function adopt(value) {
    state.current = browserCredentialsView(value);
    if (!state.current.localManagement) { setRemote(); return; }
    let changed = false;
    for (const [id, revision] of state.selected) if (!state.current.vault.entries.some(item => item.credentialId === id && item.revision === revision)) { state.selected.delete(id); changed = true; }
    for (const [id, revision] of state.queued) if (!state.current.mirror.entries.some(item => item.id === id && item.credentialRevision === revision && item.state === 'pending')) state.queued.delete(id);
    if (changed) state.receipt = 'Some selected logins changed. Review and select them again before copying.';
    if (!state.preferencesDirty && !state.remote) { $('#credentials-destination').value = state.current.mirror.settings.destination; $('#credentials-auto-queue').checked = state.current.mirror.settings.enabled; }
  }
  async function refresh(explicit = false) {
    if (destroyed || state.remote || !explicit && (state.busy || !mount.isConnected || document?.visibilityState === 'hidden')) return;
    if (fetching) return fetching;
    const sequence = ++refreshSequence;
    const pending = (async () => { try { const value = await api('/api/browser-credentials'); if (!destroyed && sequence === refreshSequence) adopt(value); } catch { if (!destroyed && sequence === refreshSequence) state.error = 'Password manager status could not be loaded. Your local form has been kept.'; } finally { if (!destroyed && sequence === refreshSequence) { state.loading = false; render(); } } })();
    fetching = pending; try { await pending; } finally { if (fetching === pending) fetching = null; }
  }
  function clearDraft() {
    for (const field of fields()) field.value = '';
    state.editing = null; state.saveAttempt = null; state.formVersion++;
  }
  function setRemote() {
    clearDraft(); state.remote = true; state.operation = null; state.selected.clear(); state.queued.clear();
    mount.innerHTML = shell(true); regions.clear();
  }
  async function withBusy(kind, work) {
    if (destroyed || state.remote || state.busy) return;
    const actionFocus = document?.activeElement;
    // A response admitted before the mutation must not overwrite its newer receipt.
    if (fetching) { ++refreshSequence; fetching = null; }
    state.busy = kind; state.error = ''; state.receipt = ''; render();
    try { await work(); } catch (error) { if (!destroyed) state.error = safeError(error); }
    finally { if (!destroyed) { state.busy = ''; if (!pointer && document?.activeElement === actionFocus && actionFocus?.dataset?.credentialsAction && actionFocus.closest?.('#credentials-batches, #credentials-delete-review')) { const heading = $('.credentials-heading h2'); heading?.setAttribute('tabindex', '-1'); heading?.focus({ preventScroll: true }); } render(); } }
  }
  async function save(retry = false) {
    if (!canVault('save') || state.operation?.uncertain || state.saveAttempt?.uncertain && !retry) return;
    if (!retry && state.editing && !state.current.vault.entries.some(item => item.credentialId === state.editing.credentialId && item.revision === state.editing.revision)) { state.error = 'Review the current saved entry before applying this draft.'; render(); return; }
    const form = $('#credentials-login-form');
    if (form.checkValidity && !form.checkValidity()) { form.reportValidity?.(); return; }
    const origin = safeOrigin($('#credentials-origin').value), username = $('#credentials-username').value, label = $('#credentials-label').value;
    if (!origin || !$('#credentials-password').value) { state.error = 'Enter a valid HTTPS site and a password.'; render(); return; }
    if (!retry) state.saveAttempt = { requestId: makeRequestId(), expectedRevision: state.current.vault.revision, origin, username, label, version: state.formVersion, ...(state.editing ? { credentialId: state.editing.credentialId, revision: state.editing.revision } : {}) };
    const attempt = state.saveAttempt;
    if (!attempt || attempt.version !== state.formVersion || attempt.origin !== origin || attempt.username !== username || attempt.label !== label) { state.error = 'The form changed after its previous request. Check the vault before starting a new save.'; render(); return; }
    return withBusy('save', async () => {
      try {
        const { version, uncertain, ...metadata } = attempt;
        // The secret exists only in this DOM input and the immediate local request body.
        const result = await api('/api/browser-credentials/save', 'POST', { ...metadata, password: $('#credentials-password').value });
        if (destroyed || state.remote) return;
        if (!result?.credentialId || !Number.isSafeInteger(result.vaultRevision)) throw Error('Unverified save response.');
        clearDraft(); state.receipt = 'Login saved in the encrypted vault. The local password field has been cleared.';
      } catch (error) {
        if (!destroyed) { attempt.uncertain = error?.uncertain === true || !error?.status || error.status >= 500; if (!attempt.uncertain) state.saveAttempt = null; }
        throw error;
      } finally { if (!destroyed && !state.remote) await refresh(true); }
    });
  }
  function newOperation(kind, payload) { return { kind, payload, ...(kind === 'copy' ? { stage: 'queue', beginRequestId: makeRequestId() } : {}), uncertain: false }; }
  async function operate(operation) {
    if (!operation || state.saveAttempt?.uncertain) return;
    return withBusy(operation.kind, async () => {
      state.operation = operation;
      try {
        let result;
        if (operation.kind === 'copy' && operation.stage === 'queue') {
          result = await api('/api/browser-credentials/mirror/queue', 'POST', operation.payload);
          if (!Array.isArray(result?.entries) || result.entries.length !== operation.payload.credentials.length || !Number.isSafeInteger(result.revision) || new Set(result.entries.map(item => item.id)).size !== result.entries.length || result.entries.some(item => !item.id || item.destination !== operation.payload.destination || !operation.payload.credentials.some(value => value.credentialId === item.credentialId && value.revision === item.credentialRevision))) throw Error('Unverified queue response.');
          operation.stage = 'begin'; operation.payload = { ids: result.entries.map(item => item.id), expectedRevision: result.revision, requestId: operation.beginRequestId };
        }
        if (destroyed || state.remote) return;
        const path = operation.kind === 'copy' || operation.kind === 'begin' ? 'mirror/begin' : operation.kind === 'queue' ? 'mirror/queue' : operation.kind === 'delete' ? 'delete' : `mirror/${operation.kind}`;
        result = await api(`/api/browser-credentials/${path}`, 'POST', operation.payload);
        if (destroyed || state.remote) return;
        if (['copy', 'begin'].includes(operation.kind) && (!result?.batchId || !['awaiting_browser_import', 'confirmed_by_user', 'failed', 'cancelled'].includes(result.state) || !Number.isSafeInteger(result.revision))) throw Error('Unverified handoff response.');
        if (operation.kind === 'delete' && (!result?.deleted || result.credentialId !== operation.payload.credentialId || !Number.isSafeInteger(result.revision))) throw Error('Unverified removal response.');
        if (operation.kind === 'configure' && (!Number.isSafeInteger(result?.revision) || result.settings?.enabled !== operation.payload.enabled || result.settings?.destination !== operation.payload.destination)) throw Error('Unverified preference response.');
        if (operation.kind === 'queue' && (!Array.isArray(result?.entries) || !Number.isSafeInteger(result.revision))) throw Error('Unverified queue response.');
        if (['confirm', 'cancel'].includes(operation.kind) && (result?.batchId !== operation.payload.batchId || result.state !== (operation.kind === 'confirm' ? 'confirmed_by_user' : 'cancelled') || !Number.isSafeInteger(result.revision))) throw Error('Unverified import decision.');
        state.operation = null;
        if (operation.kind === 'configure') state.preferencesDirty = false;
        if (operation.kind === 'delete') { state.deleting = null; if (state.editing?.credentialId === operation.payload.credentialId) clearDraft(); }
        state.receipt = ['copy', 'begin'].includes(operation.kind) ? result.state === 'awaiting_browser_import' ? 'The browser import handoff is awaiting your action. Finish the import in the browser, then confirm below.' : `The existing import receipt is ${states[result.state].toLowerCase()}. No new file or browser handoff was created by this retry.` : operation.kind === 'confirm' ? 'Your import confirmation was recorded. BLACKICE has not independently checked the browser’s saved passwords.' : operation.kind === 'cancel' ? 'The handoff was cancelled. Any import already completed in the browser remains.' : operation.kind === 'configure' ? 'Copy preferences saved. Automatic copying only queues encrypted entries until you start an import.' : operation.kind === 'delete' ? 'Login removed from the BLACKICE vault. Existing browser copies remain.' : 'Selected passwords queued. No plaintext file has been created.';
      } catch (error) {
        if (!destroyed) { operation.uncertain = error?.uncertain === true || !error?.status || error.status >= 500; if (!operation.uncertain || !['copy', 'begin', 'queue', 'delete'].includes(operation.kind)) state.operation = null; }
        throw error;
      } finally { if (!destroyed && !state.remote) await refresh(true); }
    });
  }
  function startSelection(kind) {
    if (!canMirror('queue') || !state.selected.size || state.operation?.uncertain || state.saveAttempt?.uncertain) return;
    if (kind === 'copy' && (!canMirror('beginImport') || !available(destination()))) return;
    void operate(newOperation(kind, { credentials: chosen(), destination: destination(), requestId: makeRequestId(), expectedRevision: state.current.mirror.revision }));
  }
  const click = event => {
    const target = event.target.closest?.('[data-credentials-action]'); if (!target || !mount.contains(target)) return;
    event.preventDefault(); if (state.remote || state.busy || target.disabled || target.getAttribute('aria-disabled') === 'true') return;
    const action = target.dataset.credentialsAction;
    if (action === 'refresh') { void refresh(true); return; }
    if (action === 'retry-save') { void save(true); return; }
    if (action === 'retry-operation') { void operate(state.operation); return; }
    if (action === 'clear-draft') { const uncertain = state.saveAttempt?.uncertain; clearDraft(); state.receipt = uncertain ? 'Local form cleared. A previous save may still have completed; check the vault before adding the login again.' : 'Local password form cleared.'; render(); return; }
    if (state.operation?.uncertain || state.saveAttempt?.uncertain) return;
    if (action === 'review-revision' && state.editing) {
      const current = state.current.vault.entries.find(item => item.credentialId === state.editing.credentialId);
      if (current) { state.editing = { ...current }; state.saveAttempt = null; state.error = ''; state.receipt = 'Current saved revision selected. Saving will replace it with the local draft shown above.'; render(); }
      return;
    }
    if (action === 'copy-selected' || action === 'queue-selected') { startSelection(action === 'copy-selected' ? 'copy' : 'queue'); return; }
    if (action === 'copy-queued') {
      const items = state.current.mirror.entries.filter(item => state.queued.get(item.id) === item.credentialRevision && item.state === 'pending');
      if (!canMirror('beginImport') || !items.length) return;
      if (new Set(items.map(item => item.destination)).size !== 1 || !available(items[0].destination)) { state.error = 'Choose pending passwords for one available browser at a time.'; render(); return; }
      void operate(newOperation('begin', { ids: items.map(item => item.id), expectedRevision: state.current.mirror.revision, requestId: makeRequestId() })); return;
    }
    if (action === 'edit' || action === 'delete-review') {
      const entry = state.current.vault.entries.find(item => item.credentialId === target.dataset.credentialId);
      if (!entry || !canVault(action === 'edit' ? 'save' : 'delete')) return;
      if (action === 'delete-review') { state.deleting = { credentialId: entry.credentialId, revision: entry.revision }; render(); return; }
      if ($('#credentials-password').value) { state.error = 'Save or clear the current local password form before replacing another login.'; render(); return; }
      clearDraft(); state.editing = { ...entry }; $('#credentials-origin').value = entry.origin; $('#credentials-username').value = entry.username; $('#credentials-label').value = entry.label; $('#credentials-add').open = true; state.error = ''; render(); $('#credentials-password').focus({ preventScroll: true }); return;
    }
    if (action === 'delete-cancel') { state.deleting = null; render(); return; }
    if (action === 'delete-confirm' && state.deleting && canVault('delete')) { void operate(newOperation('delete', { ...state.deleting, expectedRevision: state.current.vault.revision, requestId: makeRequestId() })); return; }
    if (action === 'confirm' || action === 'cancel') {
      const batch = state.current.mirror.batches.find(item => item.batchId === target.dataset.credentialsBatch && item.state === 'awaiting_browser_import');
      if (batch) void operate(newOperation(action, { batchId: batch.batchId, expectedRevision: state.current.mirror.revision }));
    }
  };
  const input = event => { if (event.target.closest?.('#credentials-login-form')) { state.formVersion++; if (!state.saveAttempt?.uncertain) state.saveAttempt = null; } };
  const change = event => {
    const node = event.target; if (state.remote || state.busy) return;
    if (node.dataset?.credentialsSelect) {
      const id = node.dataset.credentialsSelect, displayedRevision = Number(node.dataset.credentialRevision), item = state.current.vault.entries.find(value => value.credentialId === id);
      if (!item || !Number.isSafeInteger(displayedRevision) || displayedRevision < 1 || item.revision !== displayedRevision) {
        node.checked = false; state.selected.delete(id); state.error = 'This login changed after it was displayed. Check its current entry and select it again.'; render(); void refresh(true); return;
      }
      node.checked ? state.selected.set(id, displayedRevision) : state.selected.delete(id); render();
    }
    else if (node.dataset?.credentialsQueue) {
      const id = node.dataset.credentialsQueue, displayedRevision = Number(node.dataset.credentialRevision), item = state.current.mirror.entries.find(value => value.id === id && value.state === 'pending');
      if (!item || !Number.isSafeInteger(displayedRevision) || displayedRevision < 1 || item.credentialRevision !== displayedRevision) {
        node.checked = false; state.queued.delete(id); state.error = 'This queue entry changed after it was displayed. Check the current queue and select it again.'; render(); void refresh(true); return;
      }
      node.checked ? state.queued.set(id, displayedRevision) : state.queued.delete(id); render();
    }
    else if (node.id === 'credentials-destination' || node.id === 'credentials-auto-queue') { state.preferencesDirty = true; render(); }
  };
  const submit = event => {
    if (!['credentials-login-form', 'credentials-preferences'].includes(event.target.id)) return;
    event.preventDefault(); if (state.remote || state.busy) return;
    if (event.target.id === 'credentials-login-form') { void save(); return; }
    if (canMirror('configure') && state.preferencesDirty && !state.saveAttempt?.uncertain && !state.operation?.uncertain) void operate(newOperation('configure', { enabled: $('#credentials-auto-queue').checked, destination: destination(), expectedRevision: state.current.mirror.revision }));
  };
  const idle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (!destroyed) { render(); onIdle?.(); } }, 0); };
  const down = () => { pointer = true; };
  const up = () => { pointer = false; idle(); };
  mount.addEventListener('click', click); mount.addEventListener('input', input); mount.addEventListener('change', change); mount.addEventListener('submit', submit); mount.addEventListener('pointerdown', down); mount.addEventListener('focusout', idle);
  document?.addEventListener?.('pointerup', up); document?.addEventListener?.('pointercancel', up); globalThis.window?.addEventListener?.('blur', up);
  render(); void refresh(true);
  const timer = setInterval(() => { void refresh(); }, intervalMs); timer.unref?.();
  return { refresh, isInteracting: () => pointer || mount.contains(document?.activeElement), update(value) { if (value?.localManagement === false && !state.remote) setRemote(); },
    destroy() { clearDraft(); destroyed = true; clearInterval(timer); clearTimeout(idleTimer); ++refreshSequence; mount.removeEventListener('click', click); mount.removeEventListener('input', input); mount.removeEventListener('change', change); mount.removeEventListener('submit', submit); mount.removeEventListener('pointerdown', down); mount.removeEventListener('focusout', idle); document?.removeEventListener?.('pointerup', up); document?.removeEventListener?.('pointercancel', up); globalThis.window?.removeEventListener?.('blur', up); mount.innerHTML = ''; state.operation = null; },
  };
}
