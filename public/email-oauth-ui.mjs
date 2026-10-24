const escapeText = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const registrationKey = value => JSON.stringify(value?.config || {});
const providerName = value => value === 'microsoft' ? 'Microsoft' : 'Google';
const registrationConflict = () => Object.assign(Error('Email sign-in settings changed. Reload the saved registration before continuing.'), { code: 'EMAIL_OAUTH_REVISION_CONFLICT' });

function googleRegistration(source) {
  const value = JSON.parse(source), installed = value?.installed;
  const allowed = ['client_id', 'client_secret', 'project_id', 'auth_uri', 'token_uri', 'auth_provider_x509_cert_url', 'redirect_uris'];
  if (!value || Array.isArray(value) || Object.keys(value).length !== 1 || !installed || Array.isArray(installed) || typeof installed !== 'object' || Object.keys(installed).some(key => !allowed.includes(key)) ||
      typeof installed.client_id !== 'string' || installed.client_id.length > 400 || !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(installed.client_id) ||
      typeof installed.client_secret !== 'string' || !installed.client_secret.trim() || installed.client_secret.length > 4000 || /[\x00-\x1f\x7f]/.test(installed.client_secret)) throw Error('Invalid desktop registration');
  return { clientId: installed.client_id, clientSecret: installed.client_secret.trim() };
}

export function emailOAuthCopy(value = {}) {
  if (value.available === false) return { label: 'Open BLACKICE on this computer to connect', note: 'Email sign-in needs the desktop app and its encrypted credential storage.' };
  if (value.authorization?.pending) return { label: 'Finish sign-in in your browser', note: 'Choose your account to authorize reading and managing mail, and sending messages. This screen updates when sign-in finishes.' };
  if (value.state === 'unavailable') return { label: 'Connection needs attention', note: value.lastError?.message || 'Saved email authorization could not be loaded. Existing files have been preserved.' };
  if (value.lastError) return { label: 'Sign-in needs attention', note: value.lastError.message || 'Sign in again to reconnect your account.' };
  if (value.connected) {
    const access = value.capabilities?.read === true && value.capabilities?.send === true ? 'Mailbox and sending access is available.'
      : value.capabilities?.read === true && value.capabilities?.send === false ? 'Mailbox access is available. This saved connection does not include sending access.'
        : 'Mailbox and sending permissions have not been reported for this saved connection.';
    return { label: `Signed in with ${providerName(value.provider)}`, note: `${value.identity?.email && value.identity?.verifiedAt ? `Account: ${value.identity.email}. ` : ''}${access} Access refreshes automatically. Your account password stays with your mail provider.` };
  }
  if (!value.configured) return { label: 'Connect your mailbox', note: 'Use browser sign-in with Google or Microsoft for mailbox and sending access. No app password is needed.' };
  return { label: 'Ready to sign in', note: 'Your application registration is saved. Sign in to request access to read and manage mail, and send messages.' };
}

/** Manages authorization controls without replacing the mailbox or compose form. */
export function initEmailOAuthUI({ mount, api, getSnapshot, adoptSnapshot, onBusy = () => {}, outerBusy = () => false, showReceipt = () => {}, onChanged = () => {}, signal, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!mount || !getSnapshot()?.oauth) return { sync() {}, adopt() {}, destroy() {} };
  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let closed = false, busy = false, dirty = false, stale = false, timer = null, polling = false, readEpoch = 0, importEpoch = 0, wasOuterBusy = false;
  let oauth = getSnapshot().oauth, baseRevision = oauth.revision, baseKey = registrationKey(oauth);
  const $ = selector => mount.querySelector(selector);
  const management = () => getSnapshot().localManagement !== false;
  const available = () => management() && oauth.available !== false && oauth.state !== 'unavailable';
  const current = () => !closed && !requestSignal.aborted;
  const saved = getSnapshot(), hint = saved.config?.executable || saved.setupHints?.executable || '';
  mount.innerHTML = `<section class="email-oauth" aria-labelledby="email-oauth-title">
    <div class="email-oauth-heading"><h3 id="email-oauth-title">Connect your mailbox</h3><span class="email-oauth-tag">Browser sign-in</span></div>
    <p id="email-oauth-note" class="field-help"></p><p id="email-oauth-remote" class="field-help" hidden>Manage email sign-in from BLACKICE on the computer running it. Your connected mailbox remains available here.</p>
    <form id="email-oauth-form"><label for="email-oauth-provider">Mail provider</label><select id="email-oauth-provider"><option value="gmail">Google / Gmail</option><option value="microsoft">Microsoft / Outlook</option></select>
      <details id="email-oauth-registration"${!oauth.configured ? ' open' : ''}><summary>Application registration</summary>
        <p class="field-help">One-time setup for BLACKICE. Register your own desktop application with your mail provider, then enter its client ID. This is an application identifier, not an email password.</p>
        <label id="email-oauth-import-label" for="email-oauth-import">Import Google client file</label><input id="email-oauth-import" type="file" accept=".json,application/json" aria-describedby="email-oauth-import-note"><p id="email-oauth-import-note" class="field-help">Choose the JSON downloaded for your Desktop app. This fills the fields below; nothing is saved or sent yet.</p>
        <label for="email-oauth-client-id">Client ID</label><input id="email-oauth-client-id" autocomplete="off" spellcheck="false" maxlength="400">
        <label id="email-oauth-client-secret-label" for="email-oauth-client-secret">Google desktop client secret</label><input id="email-oauth-client-secret" type="password" autocomplete="new-password" spellcheck="false" maxlength="4000" placeholder="From your downloaded desktop client registration">
        <p id="email-oauth-secret-note" class="field-help"></p>
        <label for="email-oauth-login-hint">Account to suggest <span class="field-help">(optional)</span></label><input id="email-oauth-login-hint" type="email" autocomplete="email" maxlength="254" placeholder="you@example.com">
        <p class="field-help"><a id="email-oauth-guide" href="https://developers.google.com/identity/protocols/oauth2/native-app" target="_blank" rel="noreferrer">Provider setup instructions</a></p>
        <p id="email-oauth-testing-note" class="field-help">For lasting Gmail access, finish your app's publishing setup. Google Testing registrations with Gmail permissions require sign-in again after seven days.</p>
        <button class="button" id="email-oauth-save" type="button">Save registration</button><button class="button" id="email-oauth-reload" type="button" hidden>Reload saved registration</button>
      </details>
      <details id="email-oauth-runtime"${!hint ? ' open' : ''}><summary>Mail engine</summary><label for="email-oauth-executable">Himalaya executable</label><input id="email-oauth-executable" value="${escapeText(hint)}" autocomplete="off" spellcheck="false"><p class="field-help">BLACKICE uses Himalaya in the background and manages the OAuth connection for it.</p></details>
      <p id="email-oauth-stale" class="field-help" role="status" hidden>Saved registration changed. Reload it before saving or signing in. Reloading replaces registration edits only.</p>
      <div class="email-actions"><button class="button primary" id="email-oauth-connect" type="submit">Sign in with Google</button><button class="button" id="email-oauth-cancel" type="button" hidden>Cancel sign-in</button><button class="button" id="email-oauth-disconnect" type="button" hidden>Disconnect</button></div>
      <p id="email-oauth-permissions" class="field-help">Sign-in requests access to read and manage your mailbox and send messages. Existing connections keep their granted permissions. Saving a local draft does not send it.</p>
    </form></section>`;
  const secretInput = $('#email-oauth-client-secret'), importInput = $('#email-oauth-import');

  function populate() {
    $('#email-oauth-provider').value = oauth.config?.provider || oauth.provider || 'gmail';
    $('#email-oauth-client-id').value = oauth.config?.clientId || '';
    $('#email-oauth-client-secret').value = '';
    $('#email-oauth-login-hint').value = oauth.config?.loginHint || '';
    baseRevision = oauth.revision; baseKey = registrationKey(oauth); dirty = false; stale = false;
  }
  function sync() {
    if (!current()) return;
    const parentBusy = outerBusy();
    if (parentBusy && !wasOuterBusy && !busy) readEpoch++;
    wasOuterBusy = parentBusy;
    const pending = oauth.authorization?.pending === true, disabled = busy || parentBusy || !available();
    for (const field of mount.querySelectorAll('button, input, select')) field.disabled = disabled;
    const provider = $('#email-oauth-provider').value || 'gmail', microsoft = provider === 'microsoft';
    const copy = emailOAuthCopy(oauth);
    $('#email-oauth-title').textContent = copy.label;
    $('#email-oauth-note').textContent = copy.note;
    $('#email-oauth-remote').hidden = management();
    $('#email-oauth-stale').hidden = !stale;
    $('#email-oauth-reload').hidden = !stale;
    $('#email-oauth-client-secret-label').hidden = microsoft;
    $('#email-oauth-client-secret').hidden = microsoft;
    $('#email-oauth-client-secret').disabled = disabled || microsoft || pending;
    for (const id of ['email-oauth-import-label', 'email-oauth-import', 'email-oauth-import-note']) $(`#${id}`).hidden = microsoft;
    importInput.disabled = disabled || microsoft || pending;
    $('#email-oauth-secret-note').hidden = microsoft;
    $('#email-oauth-secret-note').textContent = oauth.config?.clientSecretConfigured && provider === oauth.provider ? 'A client secret is saved securely. Leave this empty to keep it.' : 'Use the value from your own Google Desktop app registration.';
    $('#email-oauth-testing-note').hidden = microsoft;
    $('#email-oauth-guide').setAttribute('href', microsoft ? 'https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app' : 'https://developers.google.com/identity/protocols/oauth2/native-app');
    $('#email-oauth-connect').textContent = `${oauth.connected ? 'Sign in again with' : 'Sign in with'} ${providerName(provider)}`;
    $('#email-oauth-connect').disabled = disabled || pending || stale || !$('#email-oauth-client-id').value.trim() || !$('#email-oauth-executable').value.trim();
    $('#email-oauth-save').disabled = disabled || pending || stale || !dirty || !$('#email-oauth-client-id').value.trim();
    $('#email-oauth-cancel').hidden = !pending;
    $('#email-oauth-disconnect').hidden = !oauth.connected;
    for (const id of ['email-oauth-provider', 'email-oauth-client-id', 'email-oauth-login-hint', 'email-oauth-executable']) $(`#${id}`).disabled = disabled || pending;
    schedule();
  }
  function adopt(value, { own = false } = {}) {
    if (!current() || !value?.oauth) return;
    readEpoch++;
    oauth = value.oauth;
    if (own || !dirty) populate();
    // The public config never exposes secret changes. Keep the original revision
    // while editing so a concurrent rotation cannot be silently overwritten.
    else if (registrationKey(oauth) !== baseKey || oauth.revision !== baseRevision) stale = true;
    sync();
  }
  async function reload({ own = false, configSaved = false, background = false } = {}) {
    const epoch = readEpoch;
    const value = await api('/api/email', { signal: requestSignal });
    if (!current() || epoch !== readEpoch || background && (busy || outerBusy())) return null;
    adoptSnapshot(value, { configSaved });
    adopt(value, { own });
    return value;
  }
  function schedule() {
    if (!current() || !oauth.authorization?.pending) { if (timer !== null) clearTimer(timer); timer = null; return; }
    if (timer !== null || polling) return;
    timer = setTimer(async () => {
      timer = null;
      if (!current()) return;
      if (busy || outerBusy() || globalThis.document?.visibilityState === 'hidden') { schedule(); return; }
      polling = true;
      try {
        const previousPending = oauth.authorization?.pending, previousRevision = oauth.revision;
        const value = await reload({ background: true });
        if (current() && value && previousPending && !value.oauth?.authorization?.pending) {
          const completed = value.oauth?.connected && !value.oauth?.lastError && value.oauth.revision > previousRevision;
          const note = completed ? `Email sign-in completed. ${emailOAuthCopy(value.oauth).note}` : value.oauth?.connected && !value.oauth?.lastError ? 'Sign-in ended. Your existing email connection is still available.' : emailOAuthCopy(value.oauth).note;
          showReceipt(note, Boolean(value.oauth?.lastError) || !value.oauth?.connected);
          await onChanged();
        }
      } catch (error) { if (current()) showReceipt(error?.message || 'Could not read sign-in status. Reopen Email to check the saved result.', true); }
      finally { polling = false; schedule(); }
    }, 2000);
    timer?.unref?.();
  }
  async function run(action) {
    if (!current() || busy || outerBusy() || !available()) return;
    readEpoch++; importEpoch++;
    busy = true; onBusy(true); sync();
    try { await action(); }
    catch (error) {
      if (!current()) return;
      if (error?.code === 'EMAIL_OAUTH_REVISION_CONFLICT') {
        // A failed comparison is a review point, not a reason to replay a write.
        stale = true;
        try { await reload(); } catch {}
        if (!current()) return;
        stale = true;
      }
      showReceipt(error?.message || 'Email sign-in could not be completed.', true);
    }
    finally { if (current()) { busy = false; onBusy(false); sync(); } }
  }
  async function saveRegistration() {
    if (stale) throw registrationConflict();
    if (!dirty && oauth.configured) return { revision: baseRevision, key: baseKey };
    const config = { provider: $('#email-oauth-provider').value || 'gmail', clientId: $('#email-oauth-client-id').value.trim(), loginHint: $('#email-oauth-login-hint').value.trim() };
    const secret = $('#email-oauth-client-secret').value;
    if (secret && config.provider === 'gmail') config.clientSecret = secret;
    secretInput.value = ''; importInput.value = '';
    const result = await api('/api/email/oauth/config', { method: 'PUT', body: { config, expectedRevision: baseRevision }, signal: requestSignal });
    if (!current()) return null;
    adopt({ oauth: result }, { own: true });
    return { revision: result.revision, key: registrationKey(result) };
  }
  $('#email-oauth-form').addEventListener('input', event => {
    if (!current()) return;
    if (!['email-oauth-executable', 'email-oauth-import'].includes(event.target?.id)) { dirty = true; importEpoch++; }
    sync();
  });
  $('#email-oauth-provider').addEventListener('change', () => {
    if (!current()) return;
    importEpoch++;
    if ($('#email-oauth-provider').value !== oauth.provider) {
      $('#email-oauth-client-id').value = ''; $('#email-oauth-client-secret').value = ''; $('#email-oauth-login-hint').value = '';
    }
    dirty = true; sync();
  });
  importInput.addEventListener('change', async () => {
    if (!current() || importInput.disabled) return;
    const file = importInput.files?.[0], owner = ++importEpoch;
    importInput.value = '';
    if (!file) return;
    try {
      if (file.size > 32 * 1024) throw Error('File too large');
      const source = await file.text();
      if (!current() || owner !== importEpoch) return;
      if (source.length > 32 * 1024) throw Error('File too large');
      const registration = googleRegistration(source);
      $('#email-oauth-client-id').value = registration.clientId; secretInput.value = registration.clientSecret;
      dirty = true; sync();
      showReceipt('Google Desktop registration filled in. Save it when ready; no file was uploaded.');
    } catch { if (current() && owner === importEpoch) showReceipt('Choose the JSON downloaded for your own Google Desktop app, up to 32 KB. Web client files and saved tokens cannot be imported.', true); }
  });
  $('#email-oauth-save').addEventListener('click', () => run(async () => { await saveRegistration(); if (!current()) return; await reload(); if (current()) showReceipt('Application registration saved. Sign in to connect your mailbox.'); }));
  $('#email-oauth-reload').addEventListener('click', () => run(async () => { await reload({ own: true }); if (current()) showReceipt('Saved registration reloaded. Your message draft is unchanged.'); }));
  $('#email-oauth-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!current() || $('#email-oauth-connect').disabled) return;
    return run(async () => {
      const executable = $('#email-oauth-executable').value.trim();
      const registration = await saveRegistration(); if (!current() || !registration) return;
      const latest = await reload(); if (!current() || !latest) return;
      if (registration.key !== registrationKey(latest.oauth) || registration.revision !== latest.oauth?.revision) throw registrationConflict();
      const configured = await api('/api/email/config', { method: 'PUT', body: { expectedRevision: latest.revision, config: { connection: 'oauth', enabled: true, executable } }, signal: requestSignal });
      if (!current()) return;
      adoptSnapshot(configured, { configSaved: true }); adopt(configured);
      const checked = await api('/api/email/check', { method: 'POST', body: {}, timeoutMs: 45000, signal: requestSignal });
      if (!current()) return;
      adoptSnapshot(checked); adopt(checked);
      if (registration.key !== registrationKey(oauth)) throw registrationConflict();
      await api('/api/email/oauth/begin', { method: 'POST', body: { expectedRevision: registration.revision }, signal: requestSignal });
      if (!current()) return;
      await reload(); if (!current()) return;
      showReceipt('Finish email sign-in in your default browser.'); await onChanged();
    });
  });
  for (const action of ['cancel', 'disconnect']) $(`#email-oauth-${action}`).addEventListener('click', () => run(async () => {
    await api(`/api/email/oauth/${action}`, { method: 'POST', body: {}, signal: requestSignal });
    if (!current()) return;
    await reload(); if (!current()) return;
    showReceipt(action === 'cancel' ? 'Email sign-in cancelled.' : 'Email disconnected. Your local drafts are still available.'); await onChanged();
  }));
  populate(); sync();
  return { sync, adopt, destroy() { if (closed) return; closed = true; readEpoch++; importEpoch++; if (timer !== null) clearTimer(timer); timer = null; secretInput.value = ''; importInput.value = ''; controller.abort(); } };
}
