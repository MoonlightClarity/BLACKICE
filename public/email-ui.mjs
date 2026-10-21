import { initEmailOAuthUI } from './email-oauth-ui.mjs';
import { emailMessagePresentation, emailReplyDraft } from './email-reader.mjs';

const escapeText = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function emailStatusCopy(value = {}) {
  if (value.state === 'unavailable' || value.storage?.healthy === false) return { label: 'Email unavailable', note: value.storage?.error || 'Saved email setup and drafts could not be read. Existing files are preserved. Restore or repair agent-email/state.json, then restart BLACKICE. Other work remains available.' };
  if (value.state === 'error') return { label: 'Needs attention', note: typeof value.lastError === 'string' ? value.lastError : value.lastError?.message || 'Read the connection result and correct the setup before trying again.' };
  if (value.config?.connection === 'oauth' && !value.oauth?.connected) return { label: 'Sign-in required', note: 'Finish browser sign-in to read this mailbox. Local drafts remain available.' };
  if ((!value.configured || !value.enabled) && value.oauth) return { label: 'Setup required', note: 'Connect your mailbox below, or use an existing Himalaya configuration in advanced setup.' };
  if (!value.configured || !value.enabled) return { label: 'Setup required', note: 'Save an explicit Himalaya executable, configuration file and account. Mailbox access has not been checked.' };
  if (value.account?.observed) return { label: 'Mailbox operation observed', note: `A requested mailbox operation succeeded${value.account.lastOperationAt ? ` at ${value.account.lastOperationAt}` : ''}. This records that operation; future requests can still fail.` };
  if (value.cli?.checked) return { label: 'CLI checked · mailbox unchecked', note: `The supported command interface was checked${value.cli.version ? ` (${value.cli.version})` : ''}. No mailbox operation has been verified yet.` };
  return { label: 'Configured · checks required', note: 'Saved paths do not prove that the CLI or mailbox can be used. Check the CLI, then request a mailbox read.' };
}

/** Email UI keeps connection checks, real mailbox receipts and local drafts separate. */
export function initEmailUI({ api, showModal, closeModal, toast = () => {}, onChanged = () => {}, escape = escapeText, icon = () => '' }) {
  let generation = 0, controller = null, view = null, snapshot = {}, busy = false, configDirty = false, configRevision = 0, displayedConfig = '', setupDraft = null, draftRequest = null;
  let mailbox = null, mailboxEpoch = 0;
  let folderCatalog = null;
  let oauthUI = null;
  let clientStatus = null, clientLoading = false, clientBusy = false, clientError = '', clientReceipt = '';
  const pageSize = 20, maxPage = 100000;
  let compose = { to: '', subject: '', body: '' };
  const $ = selector => view?.querySelector(selector);
  const alive = owner => owner === generation && view && document.getElementById('email-workspace') === view;
  const errorText = error => typeof error === 'string' ? error : error?.message || 'The operation could not be completed.';
  const configStale = () => JSON.stringify(snapshot.config || {}) !== displayedConfig;
  const storageAvailable = () => snapshot.state !== 'unavailable' && snapshot.storage?.healthy !== false;
  const accountAvailable = () => storageAvailable() && snapshot.configured && snapshot.enabled && (snapshot.config?.connection !== 'oauth' || snapshot.oauth?.connected === true) && !configDirty && !configStale();
  const mailboxSelection = () => ({ folder: $('#email-folder')?.value.trim() || '', query: $('#email-query')?.value || '', config: displayedConfig, epoch: mailboxEpoch });
  const sameSelection = selection => {
    const current = mailboxSelection();
    return !!selection && accountAvailable() && selection.epoch === current.epoch && selection.config === current.config && selection.folder === current.folder && selection.query === current.query;
  };
  function rememberCompose() {
    if ($('#email-to')) compose = { to: $('#email-to').value, subject: $('#email-subject').value, body: $('#email-body').value };
  }
  function rememberSetup() {
    if ($('#email-executable')) setupDraft = { enabled: $('#email-enabled').checked, executable: $('#email-executable').value, configPath: $('#email-config-path').value, account: $('#email-account').value };
  }
  function cancel() {
    oauthUI?.destroy(); oauthUI = null;
    rememberCompose(); rememberSetup();
    // Aborting the response does not establish whether the local write committed.
    if (draftRequest?.pending) { draftRequest.pending = false; draftRequest.uncertain = true; }
    if (clientBusy) clientReceipt = 'The Thunderbird handoff response was interrupted. Check its window before opening another message.';
    clientStatus = null; clientLoading = false; clientBusy = false; clientError = '';
    mailbox = null; folderCatalog = null; mailboxEpoch++;
    generation++; controller?.abort(); controller = null; view = null; busy = false;
  }
  const headers = items => (Array.isArray(items) ? items : items?.items || items?.messages || items?.envelopes || []);
  const addressText = value => {
    if (Array.isArray(value)) return value.map(addressText).filter(Boolean).join(', ');
    if (value && typeof value === 'object') {
      const address = value.email || value.addr || value.address || '';
      return value.name && address ? `${value.name} <${address}>` : value.name || address;
    }
    return String(value || '');
  };
  function showReceipt(text, failed = false) { const el = $('#email-receipt'); if (el) { el.textContent = text; el.dataset.error = String(failed); } }
  function clearMessagePreview() {
    if ($('#email-message-preview')) { $('#email-message-preview').textContent = ''; $('#email-message-preview').hidden = true; }
  }
  function clearFolderCatalog() {
    folderCatalog = null;
    if ($('#email-folder-select')) { $('#email-folder-select').innerHTML = ''; $('#email-folder-select').hidden = true; }
  }
  function showComposer() {
    $('#email-to').value = compose.to; $('#email-subject').value = compose.subject; $('#email-body').value = compose.body;
  }
  function renderMessage(value, results) {
    const preview = $('#email-message-preview'), message = emailMessagePresentation(value), reply = emailReplyDraft(value);
    if (!message.decoded) { preview.textContent = message.text; preview.hidden = false; return; }
    const metadata = [['From', message.from], ['To', message.to], ['Cc', message.cc], ['Date', message.date]].filter(([, field]) => field);
    const size = bytes => bytes === null ? '' : bytes < 1024 ? `${bytes} bytes` : bytes < 1048576 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
    preview.innerHTML = `<div class="email-reader-heading"><h4>${escape(message.subject)}</h4><button type="button" class="button" id="email-reply-draft"${reply ? '' : ' disabled'}>Reply as local draft</button></div><dl class="email-message-headers">${metadata.map(([label, field]) => `<div><dt>${label}</dt><dd>${escape(field)}</dd></div>`).join('')}</dl><pre class="email-message-text">${escape(message.text || 'No readable message body was returned.')}</pre>${message.truncated ? '<p class="field-help">This message preview was shortened. View the message source for the returned original.</p>' : ''}${message.warnings.length ? `<ul class="email-message-notes">${message.warnings.map(warning => `<li>${escape(warning)}</li>`).join('')}</ul>` : ''}${message.attachments.length ? `<section class="email-message-attachments"><h5>Attachments</h5><ul>${message.attachments.map(item => `<li><strong>${escape(item.filename)}</strong><span>${escape([item.contentType, size(item.size)].filter(Boolean).join(' · '))}</span></li>`).join('')}</ul><p class="field-help">Attachment descriptions are shown here. Files are not opened or downloaded.</p></section>` : ''}<details id="email-message-source"><summary>Message source</summary><pre class="email-preview" id="email-message-raw"></pre></details>`;
    preview.hidden = false;
    const sourceDetails = $('#email-message-source'), replyButton = $('#email-reply-draft');
    sourceDetails.ontoggle = () => { if ($('#email-message-source') === sourceDetails && sourceDetails.open && $('#email-message-raw')) $('#email-message-raw').textContent = message.raw; };
    replyButton.onclick = () => {
      if ($('#email-reply-draft') !== replyButton || !reply || !requireMailbox(results)) return;
      rememberCompose();
      if (Object.values(compose).some(field => field.trim()) || draftRequest?.uncertain) { showReceipt('Save or finish your current draft, then choose New draft before starting this reply. Your current text is still in the composer.', true); return; }
      compose = { ...reply }; draftRequest = null; showComposer();
      $('#email-body').focus?.({ preventScroll: true }); $('#email-draft-form').scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      showReceipt('Reply prepared in the local composer. Review the recipient and text, then save the draft.');
    };
    $('#email-reply-draft').dataset.replyAvailable = String(Boolean(reply));
  }
  function resetMailbox() {
    mailbox = null; mailboxEpoch++;
    for (const button of view?.querySelectorAll('[data-email-message]') || []) button.disabled = true;
    if ($('#email-messages')) $('#email-messages').innerHTML = '';
    clearMessagePreview();
    if ($('#email-indexing-note')) { $('#email-indexing-note').hidden = true; $('#email-indexing-note').textContent = ''; }
    if ($('#email-pages')) $('#email-pages').hidden = true;
    if ($('#email-page-status')) $('#email-page-status').textContent = '';
  }
  function sync() {
    if (!view) return;
    const unavailable = !storageAvailable();
    for (const el of view.querySelectorAll('button, input, textarea, select')) el.disabled = busy || unavailable;
    const configured = accountAvailable(), stale = !unavailable && configStale();
    if ($('#email-refresh')) $('#email-refresh').disabled = busy;
    if ($('#email-check')) $('#email-check').disabled = busy || !configured;
    if ($('#email-mailbox-read')) $('#email-mailbox-read').disabled = busy || !configured || !snapshot.cli?.checked;
    if ($('#email-folders-load')) $('#email-folders-load').disabled = busy || !configured || !snapshot.cli?.checked || snapshot.capabilities?.mailboxes === false;
    if ($('#email-folder-select')) $('#email-folder-select').disabled = busy || !configured || !folderCatalog || folderCatalog.config !== displayedConfig;
    const currentPage = sameSelection(mailbox);
    for (const button of view.querySelectorAll('[data-email-message]')) button.disabled = busy || !currentPage || !snapshot.cli?.checked;
    if ($('#email-pages')) $('#email-pages').hidden = !currentPage;
    if ($('#email-page-status')) $('#email-page-status').textContent = currentPage ? `Page ${mailbox.page} · ${mailbox.count} message${mailbox.count === 1 ? '' : 's'}` : '';
    if ($('#email-page-previous')) $('#email-page-previous').disabled = busy || !currentPage || !snapshot.cli?.checked || mailbox.page <= 1;
    if ($('#email-page-next')) $('#email-page-next').disabled = busy || !currentPage || !snapshot.cli?.checked || !mailbox.mayHaveMore || mailbox.page >= maxPage;
    if ($('#email-save-config')) $('#email-save-config').disabled = busy || unavailable || !configDirty || stale;
    if ($('#email-setup-change')) {
      $('#email-setup-change').hidden = !stale;
      $('#email-setup-change').textContent = `Saved connection setup changed. CLI and mailbox actions are paused until you reload saved setup.${configDirty ? ' Reloading replaces your unsaved setup edits; your local draft text stays in the form.' : ''}`;
    }
    if ($('#email-reload-config')) {
      $('#email-reload-config').hidden = !stale && !configDirty;
      $('#email-reload-config').textContent = configDirty ? 'Reload saved setup (replace edits)' : 'Reload saved setup';
    }
    if ($('#email-draft-save')) $('#email-draft-save').disabled = busy || unavailable || Boolean(draftRequest?.uncertain);
    if ($('#email-draft-new')) $('#email-draft-new').disabled = busy || unavailable || Boolean(draftRequest?.uncertain);
    if ($('#email-reply-draft')) $('#email-reply-draft').disabled = busy || !currentPage || $('#email-reply-draft').dataset.replyAvailable !== 'true';
    if ($('#email-draft-recovery')) {
      $('#email-draft-recovery').hidden = !draftRequest?.uncertain;
      $('#email-draft-retry-preview').textContent = draftRequest?.uncertain ? `To: ${draftRequest.fields.to.join(', ')}\nSubject: ${draftRequest.fields.subject}\n\n${draftRequest.fields.body}` : '';
    }
    if (snapshot.localManagement === false) for (const el of $('#email-config-form')?.querySelectorAll('button, input') || []) el.disabled = true;
    syncClient();
    oauthUI?.sync();
  }
  function syncClient() {
    const local = snapshot.localManagement !== false && clientStatus?.localManagement !== false;
    const available = clientStatus?.id === 'thunderbird' && clientStatus?.available === true && clientStatus?.supported === true;
    for (const [id, action] of [['email-client-open', 'open'], ['email-client-compose', 'compose']]) {
      if ($(`#${id}`)) $(`#${id}`).disabled = !local || clientLoading || clientBusy || !available || clientStatus?.capabilities?.[action] !== true;
    }
    if ($('#email-client-refresh')) $('#email-client-refresh').disabled = clientLoading || clientBusy;
    const note = $('#email-client-note');
    if (note) note.textContent = !local ? 'Open Thunderbird from BLACKICE on this computer.' : clientLoading ? 'Checking for Thunderbird…' : clientError ? `Thunderbird availability could not be checked: ${clientError}` : available ? 'Thunderbird is installed. It opens in its own window with its own accounts.' : clientStatus?.supported === false ? 'The Thunderbird handoff is available on Windows.' : 'Thunderbird was not found in a supported installation location. You can still use the optional mailbox setup and local drafts below.';
    if ($('#email-client-receipt')) $('#email-client-receipt').textContent = clientReceipt;
  }
  async function readClient() {
    if (!view || clientLoading || clientBusy) return;
    const owner = generation; clientLoading = true; clientError = ''; syncClient();
    try {
      const result = await api('/api/email/client', { signal: controller.signal });
      if (alive(owner)) clientStatus = result;
    } catch (error) { if (alive(owner)) { clientStatus = null; clientError = errorText(error); } }
    finally { if (alive(owner)) { clientLoading = false; syncClient(); } }
  }
  async function openClient(action, owner, button) {
    if (!alive(owner) || $(`#email-client-${action === 'open' ? 'open' : 'compose'}`) !== button || button.disabled || clientBusy || clientLoading || snapshot.localManagement === false || clientStatus?.localManagement === false || clientStatus?.capabilities?.[action] !== true) return;
    clientBusy = true; clientReceipt = 'Requesting Thunderbird…'; syncClient();
    try {
      const result = await api('/api/email/client/open', { method: 'POST', body: { action }, signal: controller.signal });
      if (!alive(owner)) return;
      clientReceipt = result?.requested === true && result?.sent === false ? action === 'compose' ? 'An empty compose window was requested in Thunderbird. Check that window; your BLACKICE draft is unchanged. No email was sent.' : 'Thunderbird was requested. Check its native window. Your BLACKICE draft is unchanged.' : 'The Thunderbird handoff could not be confirmed. Check its window before trying again.';
    } catch (error) { if (alive(owner)) clientReceipt = `${errorText(error)}${error?.uncertain || error?.timedOut ? ' Check Thunderbird before trying again.' : ''}`; }
    finally { if (alive(owner)) { clientBusy = false; syncClient(); } }
  }
  async function operation(task, done, isCurrent = () => true) {
    if (busy) return;
    const owner = generation; busy = true; showReceipt('Working…'); sync();
    try { const result = await task(); if (!alive(owner) || !isCurrent()) return; await done(result); }
    catch (error) { if (alive(owner) && isCurrent()) showReceipt(errorText(error) + (error?.uncertain ? ' Read saved status before repeating this operation.' : ''), true); }
    finally { if (alive(owner)) { busy = false; sync(); } }
  }
  function adoptSnapshot(result, { configSaved = false } = {}) {
    const currentConfig = JSON.stringify(result.config || {});
    if (currentConfig !== JSON.stringify(snapshot.config || {}) || result.state === 'unavailable' || result.storage?.healthy === false) { resetMailbox(); clearFolderCatalog(); }
    // A local draft advances the shared revision without changing the form's base
    // config. Accept that revision, but retain a stale base if someone changed setup.
    if (configSaved || !displayedConfig || currentConfig === displayedConfig) configRevision = result.revision;
    if (configSaved || !displayedConfig) { displayedConfig = currentConfig; setupDraft = { ...result.config }; configDirty = false; }
    snapshot = result;
    // Saving or reloading the mail engine does not own registration edits.
    oauthUI?.adopt(result);
    if (draftRequest?.uncertain && headers(result.drafts).some(draft => draft.requestId === draftRequest.requestId)) draftRequest.uncertain = false;
  }
  function renderStatus() {
    const current = emailStatusCopy(snapshot), stale = storageAvailable() && configStale();
    $('#email-state').textContent = stale ? 'Saved setup changed' : current.label;
    $('#email-state-note').textContent = stale ? 'The saved connection differs from the setup shown here. Reload saved setup before checking the CLI or reading a mailbox.' : current.note;
    $('#email-state').dataset.error = String(!storageAvailable());
    $('#email-cli-detail').textContent = snapshot.cli?.checkedAt ? `CLI check: ${snapshot.cli.checkedAt}` : 'CLI check: none recorded';
  }
  function requireAccount({ read = false, expectedConfig = displayedConfig } = {}) {
    if (busy) return false;
    if (!storageAvailable()) { showReceipt(emailStatusCopy(snapshot).note, true); return false; }
    if (accountAvailable() && expectedConfig === displayedConfig && (!read || snapshot.cli?.checked)) return true;
    showReceipt(configStale() || expectedConfig !== displayedConfig ? 'Saved connection setup changed. Reload saved setup, then request messages again before opening one.' : configDirty ? 'Save your setup edits before checking the CLI or reading a mailbox.' : 'Save and enable setup, then check the CLI before requesting mailbox access.', true);
    return false;
  }
  function showSetupFields() {
    $('#email-enabled').checked = Boolean(setupDraft.enabled);
    for (const [id, field] of [['email-executable', 'executable'], ['email-config-path', 'configPath'], ['email-account', 'account']]) $(`#${id}`).value = setupDraft[field] || '';
  }
  function saveDraft(request) {
    if (busy || !request) return;
    if (!storageAvailable()) { showReceipt(emailStatusCopy(snapshot).note, true); return; }
    const owner = generation, signal = controller.signal;
    request.pending = true;
    return operation(async () => {
      try {
        const result = await api('/api/email/drafts', { method: 'POST', body: { ...request.fields, requestId: request.requestId }, signal });
        if (alive(owner) && draftRequest === request) { request.pending = false; request.uncertain = false; }
        return result;
      } catch (error) {
        if (alive(owner) && draftRequest === request) {
          request.pending = false;
          if (error?.uncertain || error?.timedOut) request.uncertain = true;
        }
        throw error;
      }
    }, async result => {
      const receipt = `Local draft saved${result.draft?.id || result.id ? ` (${result.draft?.id || result.id})` : ''}. No email was sent.`;
      try {
        const latest = await api('/api/email', { signal });
        if (!alive(owner)) return;
        adoptSnapshot(latest); renderStatus(); renderDrafts(); showReceipt(receipt);
      } catch (error) {
        if (!alive(owner)) return;
        showReceipt(`${receipt} The saved-draft list could not be refreshed: ${errorText(error)}`, true);
      }
      await onChanged();
    });
  }
  function renderDrafts() {
    if (!storageAvailable()) {
      $('#email-drafts').innerHTML = '<p class="field-help">Saved drafts are unavailable while email storage needs recovery. Existing files have been preserved. The draft count is unknown until storage is recovered.</p>';
      $('#email-draft-preview').textContent = ''; $('#email-draft-preview').hidden = true;
      return;
    }
    const drafts = headers(snapshot.drafts || []);
    $('#email-drafts').innerHTML = drafts.length ? drafts.map(item => `<button type="button" class="email-draft-row" data-email-draft="${escape(item.id)}"><strong>${escape(item.subject || 'Untitled draft')}</strong><span>${escape(Array.isArray(item.to) ? item.to.join(', ') : item.to || '')}</span><small>Local draft${item.createdAt ? ` · ${escape(item.createdAt)}` : ''}</small></button>`).join('') : '<p class="field-help">No local drafts yet. Saving a draft keeps a message on this computer.</p>';
    for (const button of view.querySelectorAll('[data-email-draft]')) button.onclick = () => operation(() => api(`/api/email/drafts/${encodeURIComponent(button.dataset.emailDraft)}`, { signal: controller.signal }), result => {
      const draft = result.draft || result; $('#email-draft-preview').textContent = `To: ${Array.isArray(draft.to) ? draft.to.join(', ') : draft.to || ''}\nSubject: ${draft.subject || ''}\n\n${draft.body || ''}`;
      $('#email-draft-preview').hidden = false; showReceipt('Saved draft read. No message was sent.');
    });
  }
  function requireMailbox(results) {
    if (!requireAccount({ read: true, expectedConfig: results?.config })) return false;
    if (results && results === mailbox && sameSelection(results)) return true;
    showReceipt('Mailbox selection changed. Request messages again before opening a result or changing pages.', true);
    return false;
  }
  function loadMailbox(page) {
    if (!requireAccount({ read: true }) || !Number.isInteger(page) || page < 1 || page > maxPage) return;
    const selection = mailboxSelection();
    return operation(() => api('/api/email/action', { method: 'POST', body: { action: 'list', folder: selection.folder, query: selection.query, limit: pageSize, page }, timeoutMs: 45000, signal: controller.signal }), async result => {
      const items = headers(result), indexingPending = result?.indexingPending === true;
      for (const button of view.querySelectorAll('[data-email-message]')) button.disabled = true;
      clearMessagePreview();
      const results = { ...selection, page, count: items.length, mayHaveMore: result?.mayHaveMore === true };
      mailbox = results;
      $('#email-indexing-note').hidden = !indexingPending;
      $('#email-indexing-note').textContent = indexingPending ? `Mailbox indexing is in progress${Number.isSafeInteger(result.queued) && result.queued > 0 ? ` (${result.queued} queued)` : ''}. Results may be incomplete. Request messages again later.` : '';
      $('#email-messages').innerHTML = items.length ? items.map(item => `<button type="button" class="email-message-row" data-email-message="${escape(item.id)}"><strong>${escape(item.subject || 'No subject')}</strong><span>${escape(addressText(item.from))}</span><small>${escape(item.date || '')}</small></button>`).join('') : `<p class="field-help">${indexingPending ? 'No messages are available yet while indexing is in progress.' : 'The request returned no messages.'}</p>`;
      for (const button of view.querySelectorAll('[data-email-message]')) button.onclick = () => {
        if (!requireMailbox(results)) return;
        return operation(() => api('/api/email/action', { method: 'POST', body: { action: 'read', folder: results.folder, id: button.dataset.emailMessage }, timeoutMs: 45000, signal: controller.signal }), value => {
          renderMessage(value, results); showReceipt('Message preview read from the configured account.');
        }, () => mailbox === results && sameSelection(results));
      };
      showReceipt(`${items.length} message${items.length === 1 ? '' : 's'} returned on page ${page} by the configured account.${indexingPending ? ' Results may be incomplete while mailbox indexing is in progress.' : ''}`);
      const owner = generation, latest = await api('/api/email', { signal: controller.signal }); if (!alive(owner)) return; adoptSnapshot(latest); renderStatus(); await onChanged();
    }, () => sameSelection(selection));
  }
  function loadFolders() {
    if (!requireAccount({ read: true }) || snapshot.capabilities?.mailboxes === false) return;
    const config = displayedConfig;
    return operation(() => api('/api/email/action', { method: 'POST', body: { action: 'mailboxes' }, timeoutMs: 45000, signal: controller.signal }), async result => {
      const folders = [...new Map((Array.isArray(result?.mailboxes) ? result.mailboxes : []).filter(item => typeof item?.id === 'string' && item.id.length > 0 && item.id.length <= 512 && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 512).map(item => [item.id, { id: item.id, name: item.name }])).values()].slice(0, 1000);
      const ids = folders.map(item => item.id), counts = new Map();
      for (const item of folders) counts.set(item.name, (counts.get(item.name) || 0) + 1);
      folderCatalog = { config, ids };
      $('#email-folder-select').innerHTML = '<option value="">Choose a folder</option>' + folders.map(item => `<option value="${escape(item.id)}">${escape(item.name + (counts.get(item.name) > 1 ? ` (${item.id})` : ''))}</option>`).join('');
      $('#email-folder-select').hidden = folders.length === 0;
      $('#email-folder-select').value = ids.includes($('#email-folder').value) ? $('#email-folder').value : '';
      showReceipt(`${folders.length} folder${folders.length === 1 ? '' : 's'} returned by the configured account. Your current folder selection is unchanged.`);
      const owner = generation, latest = await api('/api/email', { signal: controller.signal });
      if (!alive(owner)) return; adoptSnapshot(latest); renderStatus(); await onChanged();
    }, () => accountAvailable() && config === displayedConfig);
  }
  function changePage(delta) {
    if (!requireMailbox(mailbox)) return;
    if ((delta === 1 && !mailbox.mayHaveMore) || (delta !== 1 && delta !== -1)) return;
    return loadMailbox(mailbox.page + delta);
  }
  function render() {
    const config = setupDraft || snapshot.config || {};
    view.innerHTML = `<section class="email-intro" id="email-client-handoff" aria-labelledby="email-client-heading"><h3 id="email-client-heading">Use Thunderbird</h3><p id="email-client-note" role="status">Checking for Thunderbird…</p><div class="email-actions"><button type="button" class="button primary" id="email-client-open" disabled>Open Thunderbird</button><button type="button" class="button" id="email-client-compose" disabled>New message</button><button type="button" class="button" id="email-client-refresh">Check availability</button></div><p class="field-help">Use Thunderbird's own account setup and message editor. BLACKICE does not automatically reuse those accounts. New message opens an empty compose window; your local draft below stays here.</p><p id="email-client-receipt" role="status" aria-live="polite"></p></section><section class="email-intro"><h3>Optional mailbox automation</h3><span id="email-state" class="email-state"></span><p id="email-state-note"></p><small id="email-cli-detail"></small></section><div id="email-oauth-mount"></div>
      <p id="email-setup-change" class="field-help" role="status" hidden></p><details class="email-setup"${!snapshot.oauth && !snapshot.cli?.checked ? ' open' : ''}><summary>Existing Himalaya setup (advanced)</summary><form id="email-config-form"><label class="email-check-label"><input type="checkbox" id="email-enabled"${config.enabled ? ' checked' : ''}>Enable email tools</label><label for="email-executable">Himalaya executable</label><input id="email-executable" value="${escape(config.executable || '')}" placeholder="C:\\path\\to\\himalaya.exe" spellcheck="false" autocomplete="off"><label for="email-config-path">Himalaya configuration file</label><input id="email-config-path" value="${escape(config.configPath || '')}" placeholder="C:\\path\\to\\config.toml" spellcheck="false" autocomplete="off"><label for="email-account">Account name</label><input id="email-account" value="${escape(config.account || '')}" placeholder="Account key in that configuration" spellcheck="false" autocomplete="off"><p class="field-help">Use a configured account that can run without a prompt. Credentials stay in your existing mail configuration and credential provider.</p><div class="email-actions"><button class="button primary" id="email-save-config" type="submit">Save setup</button><button class="button" id="email-check" type="button">Check CLI</button><button class="button" id="email-refresh" type="button">Read saved status</button><button class="button" id="email-reload-config" type="button" hidden>Reload saved setup</button></div></form></details>
      <section class="email-mailbox" aria-labelledby="email-mailbox-heading"><h3 id="email-mailbox-heading">Read mailbox</h3><p class="field-help">An explicit read contacts the configured account. The agent can also list, search and preview messages through its email tool.</p><form id="email-mailbox-form"><label for="email-folder">Folder</label><div class="email-folder-controls"><input id="email-folder" value="INBOX" maxlength="512"><button class="button" id="email-folders-load" type="button">Load folders</button></div><select id="email-folder-select" aria-label="Available mail folders" hidden></select><label for="email-query">Search</label><input id="email-query" placeholder="Optional Himalaya search query" maxlength="2000"><button class="button" id="email-mailbox-read" type="submit">Read messages</button></form><p id="email-indexing-note" class="field-help" role="status" hidden></p><div id="email-messages"></div><div id="email-pages" class="email-pages" hidden><button class="button" id="email-page-previous" type="button">Previous page</button><span id="email-page-status" role="status" aria-live="polite"></span><button class="button" id="email-page-next" type="button">Next page</button></div><section id="email-message-preview" class="email-message-reader" aria-label="Message preview" hidden></section></section>
      <section class="email-compose" aria-labelledby="email-compose-heading"><h3 id="email-compose-heading">Local draft</h3><form id="email-draft-form"><label for="email-to">To</label><input id="email-to" type="email" multiple required autocomplete="off" placeholder="name@example.com"><label for="email-subject">Subject</label><input id="email-subject" required maxlength="998"><label for="email-body">Message</label><textarea id="email-body" rows="6" required maxlength="200000"></textarea><div class="email-actions"><button class="button primary" id="email-draft-save" type="submit">Save local draft</button><button class="button" id="email-draft-check" type="button">Read saved drafts</button><button class="button" id="email-draft-new" type="button">New draft</button></div></form><div id="email-draft-recovery" hidden><p class="field-help">The last save could not be confirmed. Read saved drafts to check, or retry the same local save using its original content. Your current edits stay in the form.</p><details><summary>Original draft for retry</summary><pre id="email-draft-retry-preview" class="email-preview"></pre></details><button class="button" id="email-draft-retry" type="button">Retry the same local save</button></div><div id="email-drafts"></div><pre id="email-draft-preview" class="email-preview" hidden></pre></section><p id="email-receipt" role="status" aria-live="polite"></p>`;
    showComposer();
    renderStatus(); renderDrafts();
    const clientOwner = generation;
    for (const [id, action] of [['email-client-open', 'open'], ['email-client-compose', 'compose']]) { const button = $(`#${id}`); button.onclick = () => openClient(action, clientOwner, button); }
    const clientRefresh = $('#email-client-refresh');
    clientRefresh.onclick = () => alive(clientOwner) && $('#email-client-refresh') === clientRefresh ? readClient() : undefined;
    oauthUI = initEmailOAuthUI({ mount: $('#email-oauth-mount'), api, getSnapshot: () => snapshot, adoptSnapshot: (value, options) => { adoptSnapshot(value, options); if (options?.configSaved) showSetupFields(); renderStatus(); renderDrafts(); sync(); }, onBusy: value => { busy = value; sync(); }, outerBusy: () => busy, showReceipt, onChanged, signal: controller.signal });
    $('#email-config-form').addEventListener('input', () => { rememberSetup(); configDirty = true; resetMailbox(); sync(); });
    $('#email-config-form').onsubmit = event => {
      event.preventDefault();
      if (busy || !storageAvailable() || !configDirty || configStale() || snapshot.localManagement === false) return;
      const config = { ...(snapshot.oauth ? {connection:'external'} : {}), enabled: $('#email-enabled').checked, executable: $('#email-executable').value.trim(), configPath: $('#email-config-path').value.trim(), account: $('#email-account').value.trim() };
      return operation(() => api('/api/email/config', { method: 'PUT', body: { config, expectedRevision: configRevision }, signal: controller.signal }), async result => {
        adoptSnapshot(result, {configSaved:true}); showSetupFields(); renderStatus(); showReceipt('Setup saved. Check the CLI before requesting mailbox access.'); await onChanged();
      });
    };
    $('#email-check').onclick = () => {
      if (!requireAccount()) return;
      return operation(() => api('/api/email/check', { method: 'POST', body: {}, timeoutMs: 45000, signal: controller.signal }), async result => { adoptSnapshot(result); renderStatus(); showReceipt(snapshot.cli?.checked ? 'CLI interface checked. Mailbox access is still checked by a requested read.' : emailStatusCopy(snapshot).note, !snapshot.cli?.checked); await onChanged(); });
    };
    $('#email-refresh').onclick = () => operation(() => api('/api/email', { signal: controller.signal }), result => { adoptSnapshot(result); renderStatus(); renderDrafts(); showReceipt(configDirty ? 'Saved status read. Your unsaved setup remains in the form.' : 'Saved status read. No mailbox request was made.'); });
    $('#email-reload-config').onclick = () => operation(() => api('/api/email', { signal: controller.signal }), result => {
      adoptSnapshot(result, { configSaved: true }); showSetupFields(); renderStatus(); renderDrafts();
      resetMailbox();
      showReceipt(`Saved setup reloaded${snapshot.config?.account ? ` for ${snapshot.config.account}` : ''}. Your local draft text is unchanged. No mailbox request was made.`);
    });
    $('#email-mailbox-form').onsubmit = event => {
      event.preventDefault();
      return loadMailbox(1);
    };
    for (const id of ['email-folder', 'email-query']) $(`#${id}`).addEventListener('input', () => { resetMailbox(); showReceipt('Mailbox selection changed. Read messages to start from the first page.'); sync(); });
    $('#email-folders-load').onclick = loadFolders;
    $('#email-folder-select').onchange = () => {
      const selected = $('#email-folder-select').value;
      if (busy || !accountAvailable() || folderCatalog?.config !== displayedConfig || !folderCatalog?.ids.includes(selected)) return;
      $('#email-folder').value = selected; resetMailbox(); sync(); showReceipt('Folder selected. Read messages to load its first page.');
    };
    $('#email-page-previous').onclick = () => changePage(-1);
    $('#email-page-next').onclick = () => changePage(1);
    $('#email-draft-form').addEventListener('input', rememberCompose);
    $('#email-draft-form').onsubmit = event => {
      event.preventDefault();
      if (busy || !storageAvailable() || draftRequest?.uncertain) return;
      rememberCompose();
      const fields = { to: compose.to.split(',').map(value => value.trim()).filter(Boolean), subject: compose.subject, body: compose.body }, key = JSON.stringify(fields);
      if (!draftRequest || draftRequest.key !== key) draftRequest = { key, fields, requestId: crypto.randomUUID(), pending: false, uncertain: false };
      return saveDraft(draftRequest);
    };
    $('#email-draft-new').onclick = () => {
      if (busy || !storageAvailable() || draftRequest?.uncertain) return;
      compose = { to: '', subject: '', body: '' }; draftRequest = null; showComposer(); sync(); $('#email-to').focus?.(); showReceipt('Ready for a new local draft.');
    };
    $('#email-draft-retry').onclick = () => draftRequest?.uncertain ? saveDraft(draftRequest) : undefined;
    $('#email-draft-check').onclick = () => operation(() => api('/api/email', { signal: controller.signal }), result => {
      const checking = draftRequest?.uncertain;
      adoptSnapshot(result); renderStatus(); renderDrafts();
      if (!storageAvailable()) { showReceipt(emailStatusCopy(snapshot).note, true); return; }
      if (draftRequest?.uncertain) showReceipt('No matching draft appears in saved status. Retry the same local save to confirm it with the original content and request ID; your current edits stay in the form.', true);
      else showReceipt(checking ? 'The previous draft is saved. No email was sent.' : 'Saved drafts read. No mailbox request was made.');
    });
    sync();
  }
  async function open() {
    cancel();
    showModal('email', `<div class="modal-header"><div class="modal-title"><h2>Email</h2><p>Your mail app, background reading and local drafts</p></div><button type="button" class="icon-button" data-action="close-modal" aria-label="Close Email">${icon('close', 17)}</button></div><div id="email-workspace" class="email-workspace"><p role="status">Reading saved setup…</p></div>`, true);
    view = document.getElementById('email-workspace'); document.querySelector('#modal-root .modal')?.classList.add('email-modal');
    controller = new AbortController(); const owner = generation;
    try { const result = await api('/api/email', { signal: controller.signal }); if (alive(owner)) { adoptSnapshot(result); render(); await readClient(); } }
    catch (error) { if (alive(owner)) view.textContent = errorText(error); }
  }
  return { open, cancel };
}
