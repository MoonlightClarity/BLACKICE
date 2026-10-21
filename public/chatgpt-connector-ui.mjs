import { writeClipboard, clipboardFailureMessage } from './clipboard.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
export const connectorPermissions = [
  ['read', 'Plans and action receipts', 'Read saved plans, groups, and results from this connection.'],
  ['planning:write', 'Edit plans', 'Rename, group, and edit saved plans with revision checks.'],
  ['files:read', 'Read files on this computer', 'Read and search files with your Windows account’s access. Relative paths use the configured working folder.'],
  ['files:write', 'Change files on this computer', 'Import selected attachments, write, patch, and undo files with your Windows account’s access. Absolute file paths are supported.'],
  ['browser:read', 'Read contained browser', 'Read pages and screenshots in BLACKICE’s browser.'],
  ['browser:write', 'Act in contained browser', 'Navigate, click, type, and upload selected files in BLACKICE’s browser.'],
  ['commands:run', 'Run commands on this computer', 'Execute shell commands with your Windows account’s permissions. The working folder is not a system sandbox.'],
];
const label = scope => connectorPermissions.find(item => item[0] === scope)?.[1] || scope;
const offeredPermissions = request => connectorPermissions.filter(([scope]) => request.scopes.includes(scope));
const selectionSummary = (request, selected) => `${offeredPermissions(request).filter(([scope]) => selected.includes(scope)).length} of ${offeredPermissions(request).length} permissions selected`;
const button = (action, text, id = '', busy = false, extra = '') => `<button type="button" data-connector-action="${action}"${id ? ` data-connector-id="${escape(id)}"` : ''}${busy ? ' aria-disabled="true" aria-busy="true"' : ''}${extra}>${text}</button>`;

/** A server receipt and the owner's confirmation are separate observed stages. */
export function connectorProgress(state = {}) {
  const current = state.current || {}, grants = current.oauth?.grants || [];
  const stage = (key, label, description, tone = 'waiting', busy = false) => ({ key, label, description, tone, busy });
  if (state.loading || state.checking) return stage('checking', 'Checking connector', 'Reading BLACKICE connection status on this computer.', 'working', true);
  if (state.busy) {
    const actions = {
      'open-chatgpt': ['opening', 'Opening setup in your browser', 'Waiting for the normal browser to accept the setup request.'],
      'approve-access': ['approving', 'Saving your approval', 'ChatGPT will finish connecting after your selected access is saved.'],
      prepare: ['preparing', 'Preparing this computer', 'Preparing the approved HTTPS route and ChatGPT access.'],
      'enable-startup': ['startup', 'Setting up automatic startup', 'Waiting for Windows startup settings to be applied and verified.'],
      'check-connection': ['diagnosing', 'Checking public connection', 'Checking this computer’s discovery, OAuth and tool endpoints.'],
      'confirm-connection': ['confirming', 'Saving your confirmation', 'Recording that you saw the matching result in ChatGPT.'],
      enable: ['enabling', 'Enabling connector', 'Saving connector access on this computer.'],
      disable: ['disabling', 'Disabling access', 'Stopping new actions and revoking this connection.'],
    };
    const [key, label, description] = actions[state.busy] || ['updating', 'Updating connector', 'Waiting for BLACKICE to finish this request.'];
    return stage(key, label, description, 'working', true);
  }
  const error = state.error || state.statusError || current.error || current.oauth?.error || current.setup?.error;
  if (error || current.available === false || current.oauth?.healthy === false) return stage('attention', 'Needs attention', typeof error === 'string' ? error : error?.message || 'Check the connection details below, then check status again.', 'error');
  if (!current.enabled) return stage('disabled', 'Connector disabled', 'Choose Prepare this computer below to enable ChatGPT access.', 'idle');
  if (current.remoteAccess?.state === 'starting') return stage('https-starting', 'Public HTTPS is starting', 'Check preparation again when the public route is ready.');
  if (!current.remoteAccess?.enabled || current.remoteAccess?.mode !== 'public') return stage('https-waiting', 'Waiting for public HTTPS', 'Choose Prepare this computer below and approve public HTTPS to continue.');
  if (current.oauth?.requests?.length) return stage('approval', 'Approval needed in BLACKICE', 'Match the request code below, choose permissions, and allow access.');
  if (current.setup?.ready === false) return stage('prepare', 'Prepare this computer', 'Review the preparation checks below before adding BLACKICE in ChatGPT.');
  const receipt = current.setup?.verification;
  const received = receipt?.receivedAt && grants.some(grant => grant.id === receipt.clientId);
  if (received && receipt.confirmedAt) return stage('confirmed', 'Connection confirmed by you', 'You confirmed the matching BLACKICE result in your ChatGPT conversation.', 'success');
  if (received) return stage('tool-received', 'Authenticated tool call received', 'The matching status check reached BLACKICE. Confirm that you see its result in your ChatGPT conversation.', 'success');
  if (grants.length) return stage('authorized', 'Access approved · tool check needed', 'Copy the status-check prompt below and send it with BLACKICE selected in ChatGPT.');
  if (state.setupRequested) return stage('browser-waiting', 'Continue setup in ChatGPT', 'Add this computer’s address in ChatGPT, then start its connection flow. An approval request will appear here.');
  return stage('ready', 'Ready to add in ChatGPT', 'Add this computer’s address as BLACKICE in ChatGPT, then start its connection flow.', 'idle');
}

const progressContents = progress => '<span class="connector-progress-indicator" aria-hidden="true"></span><div><strong>' + escape(progress.label) + '</strong><p>' + escape(progress.description) + '</p></div>';
const progressMarkup = state => {
  const progress = connectorProgress(state);
  return '<div class="connector-progress" data-connector-progress data-stage="' + progress.key + '" data-tone="' + progress.tone + '" data-busy="' + progress.busy + '" role="status" aria-live="polite" aria-atomic="true">' + progressContents(progress) + '</div>';
};

const startupReady = value => value?.ready === true && Array.isArray(value.checks) && value.checks.length > 0 && value.checks.every(check => check.ok === true);
const startupMarkup = (state, busy) => {
  const startup = state.current?.startup;
  if (!startup) return '';
  const checks = Array.isArray(startup.checks) ? startup.checks : [];
  const ready = startupReady(startup);
  return `<div class="connector-section" data-connector-startup><h4>After Windows restarts</h4><p class="connector-note">Tailscale can start at Windows boot. BLACKICE runs in your signed-in Windows session. The connection needs both, and this computer must be awake and online.</p><p><strong>${ready ? 'Automatic startup settings verified' : startup.busy ? 'Startup setup is still running' : 'Automatic startup needs attention'}</strong></p><ul class="connector-checks">${checks.map(check => `<li data-startup-check="${escape(check.key)}" data-ok="${check.ok === true}"><strong>${check.ok === true ? 'Ready' : check.ok === false ? 'Needs attention' : 'Not verified'} · ${escape(check.label)}</strong>${check.detail ? `<span>${escape(check.detail)}</span>` : ''}</li>`).join('')}</ul>${startup.detail ? `<p class="connector-note">${escape(startup.detail)}</p>` : ''}${startup.checkedAt ? `<p class="connector-note">Settings checked: ${escape(startup.checkedAt)}. A restart has not been tested by this check.</p>` : ''}${startup.canEnable === true && !ready ? `<div class="connector-actions">${button('enable-startup', escape(startup.actionLabel || 'Enable automatic startup'), '', busy || startup.busy === true)}</div>` : ''}</div>`;
};

export function renderChatGPTConnector(state) {
  const current = state.current || {}, busy = Boolean(state.busy || state.loading || state.checking), requests = current.oauth?.requests || [], grants = current.oauth?.grants || [], jobs = current.pending?.jobs || [];
  const setup = current.setup || {}, verification = setup.verification, prepared = setup.ready === true;
  const needsPublicConsent = !current.remoteAccess?.enabled || current.remoteAccess?.mode !== 'public';
  const endpoint = Object.hasOwn(current, 'setup') ? setup.serverUrl : current.endpoint, verificationPrompt = verification?.prompt || setup.verificationPrompt;
  const matchingReceipt = verification?.receivedAt && grants.some(grant => grant.id === verification.clientId);
  const confirmed = matchingReceipt && verification.confirmedAt;
  const error = state.error || state.statusError || current.error || current.oauth?.error || setup.error;
  const notice = error ? `<p class="connector-error" role="alert">${escape(typeof error === 'string' ? error : error.message)}</p>` : state.receipt ? `<p class="connector-receipt" role="status">${escape(state.receipt)}</p>` : '';
  if (state.remote) return `<section class="chatgpt-connector"><h2>ChatGPT connector</h2><p>Manage connection access and required browser interactions in BLACKICE on the host computer.</p></section>`;
  const accessRequests = requests.map(request => {
    const selected = state.scopes.get(request.id) || ['read'];
    return `<form class="connector-card" data-connector-request="${escape(request.id)}"><h3>Connect ${escape(request.clientLabel || 'ChatGPT')}</h3><p>Match this code with the connection page in your browser:</p><strong class="connector-code">${escape(request.displayCode)}</strong><fieldset><legend>Allow this connection to</legend><div class="connector-actions">${button('select-all-access', 'Select all', request.id, busy, ` aria-label="Select all permissions for request ${escape(request.displayCode)}"`)}</div><p class="connector-note" data-connector-selection role="status" aria-live="polite">${selectionSummary(request, selected)}</p>${offeredPermissions(request).map(([scope, name, description]) => `<label class="connector-permission"><input type="checkbox" data-connector-scope="${scope}"${selected.includes(scope) ? ' checked' : ''}${scope === 'read' ? ' disabled' : ''}><span><strong>${name}</strong><small>${description}</small></span></label>`).join('')}</fieldset><div class="connector-actions"><button type="submit"${busy ? ' aria-disabled="true" aria-busy="true"' : ''}>Allow selected access</button>${button('reject-access', 'Decline', request.id, busy)}</div><p class="connector-note">The browser returns to ChatGPT automatically after your choice.</p></form>`;
  }).join('');
  const pendingJobs = jobs.map(job => {
    const legacyApproval = job.interaction?.kind === 'approval';
    return `<article class="connector-card"><div class="connector-heading"><h3>${escape(job.tool)}</h3><span class="connector-state">${legacyApproval ? 'Old approval request' : 'Needs input'}</span></div><p>${escape(job.owner?.label || 'ChatGPT')} · ${escape(job.interaction?.message)}</p><details><summary>Review exact action</summary><pre>${escape(JSON.stringify(job.request, null, 2).slice(0, 18000))}</pre><p class="connector-note">Action ${escape(job.jobId)}. Typed page input and temporary file links are kept out of saved history.</p></details><div class="connector-actions">${legacyApproval ? '' : button('resolve-action', 'I handled this interaction', job.jobId, busy, ` data-connector-interaction="${escape(job.interaction?.id)}"`)}${button('reject-action', 'Cancel action', job.jobId, busy, ` data-connector-interaction="${escape(job.interaction?.id)}"`)}</div><p class="connector-note">${legacyApproval ? 'This request came from the former local approval gate. It has not been approved or replayed. Cancel it here and inspect its saved receipt before requesting new work.' : 'Acknowledging the interaction does not repeat the action. ChatGPT must inspect the current page before continuing.'}</p></article>`;
  }).join('');
  const linked = grants.map(grant => `<li><div><strong>${escape(grant.label || 'ChatGPT')}</strong><small>${escape(grant.scopes.map(label).join(' · '))}</small></div>${button('revoke', 'Revoke access', grant.id, busy)}</li>`).join('');
  const checks = items => `<ul class="connector-checks">${(items || []).map(check => `<li data-check="${escape(check.key)}" data-ok="${check.ok === true}"><strong>${check.ok ? 'Ready' : 'Needs attention'} · ${escape(check.label)}</strong>${!check.ok && check.detail ? `<span>${escape(check.detail)}</span>` : ''}</li>`).join('')}</ul>`;
  const diagnostics = setup.diagnostics;
  return `<section class="chatgpt-connector" aria-label="ChatGPT connector"><div class="connector-heading"><div><p class="connector-eyebrow">Use BLACKICE from ChatGPT</p><h2>ChatGPT connector</h2></div></div>${progressMarkup(state)}<p>Keep your conversation in ChatGPT. Add this computer once, approve its access here, then check the result in your chat.</p>${notice}${setup.recoveryNotice ? `<p class="connector-note" role="status">${escape(setup.recoveryNotice)}</p>` : ''}
  <ol class="connector-steps">
    <li class="connector-step" data-connector-step="prepare"><h3>1. Prepare this computer</h3><p>${prepared ? 'This computer is prepared. Keep BLACKICE and Tailscale running.' : 'Preparation enables ChatGPT access and publishes this computer’s authentication-protected HTTPS address.'}</p>${prepared ? `<details><summary>Preparation checks</summary>${checks(setup.checks)}</details>` : checks(setup.checks)}${needsPublicConsent ? `<label class="connector-permission connector-public-consent"><input id="connector-public-confirmation" type="checkbox" data-connector-public-confirmation${state.confirmPublic ? ' checked' : ''}><span>I agree to publish this computer’s authentication-protected HTTPS address. Access still requires my approval in BLACKICE.</span></label>` : '<p class="connector-note">Public HTTPS is already enabled. Preparation keeps existing permissions.</p>'}<div class="connector-actions">${button('prepare', prepared ? 'Check preparation' : 'Prepare this computer', '', busy, needsPublicConsent && !state.confirmPublic ? ' disabled' : '')}${button('check-connection', state.busy === 'check-connection' ? 'Checking public connection…' : 'Check public connection', '', busy, !prepared ? ' disabled' : '')}${button('refresh', 'Check status', '', busy)}</div>${diagnostics ? `<div class="connector-diagnostics" role="status"><strong>${diagnostics.ok ? 'Public connection checks passed' : 'Public connection needs attention'}</strong>${checks(diagnostics.checks)}<p class="connector-note">${escape(diagnostics.limitation || 'These checks run from this computer. They do not confirm a result in ChatGPT.')}</p>${!diagnostics.ok ? '<p class="connector-note">Keep BLACKICE and Tailscale running, resolve the checks above, then choose Check public connection again.</p>' : ''}</div>` : '<p class="connector-note">Public checks test this computer’s endpoints. They do not confirm a result in ChatGPT.</p>'}${startupMarkup(state, busy)}</li>
    <li class="connector-step" data-connector-step="register"><h3>2. Add BLACKICE in ChatGPT once</h3><p>Open <a href="${escape(setup.chatGPTUrl || 'https://chatgpt.com/plugins')}" target="_blank" rel="noopener noreferrer">ChatGPT Plugins</a>. Choose <strong>Add</strong> → <strong>Add custom MCP server</strong>. Use <strong>BLACKICE connection</strong> for the name and paste this computer’s server URL:</p>${endpoint ? `<label class="connector-endpoint">Server URL for this computer<input id="connector-endpoint" type="url" readonly value="${escape(endpoint)}" spellcheck="false"></label><div class="connector-actions">${button('copy', 'Copy server URL', '', busy)}</div>` : '<p class="connector-note">Prepare this computer to obtain its server URL.</p>'}<p>Choose <strong>OAuth</strong>. Open <strong>Advanced OAuth settings</strong> and wait for <strong>Client Identifier Metadata Document (CIMD)</strong> to be selected. No client secret or Owner login key is needed. Choose <strong>Create as a plugin</strong>, then <strong>Connect BLACKICE connection</strong> in the connection dialog. If ChatGPT offers <strong>Install</strong> first, install it and then connect.</p>${state.canOpenChatGPT ? `<div class="connector-actions">${button('open-chatgpt', state.busy === 'open-chatgpt' ? 'Opening setup…' : grants.length ? 'Manage in ChatGPT' : 'Open ChatGPT setup', '', busy, !prepared ? ' disabled' : '')}</div><p class="connector-note"${state.busy === 'open-chatgpt' ? ' role="status"' : ''}>${state.busy === 'open-chatgpt' ? 'Requesting setup in your default browser…' : 'Opens ChatGPT Plugins in your default browser. Reconnecting keeps valid BLACKICE permissions.'}</p>` : '<p class="connector-note">Open the ChatGPT Plugins link in your usual browser to continue.</p>'}<p class="connector-note">If BLACKICE is already listed with this server URL, reuse it. Reconnect only when ChatGPT asks.</p><details><summary>Cannot connect, missing Add, or the wrong connector?</summary><p>If Add or Add custom MCP server is missing, check the ChatGPT account and workspace you intend to use and ask its administrator whether custom MCP connections are available.</p><p>If you see Avalon or another connector, return to Plugins and add BLACKICE connection using the exact server URL above. An installed package or an Open in desktop app button alone does not register the Chat connection.</p><p>If ChatGPT says “Couldn’t discover OAuth settings” or CIMD is unavailable, keep BLACKICE and Tailscale running and retry with this computer’s current server URL. Public checks run from this computer; they can pass while ChatGPT still cannot reach that address. Resolve the public-address problem before continuing. Do not generate an Owner login key or fill in guessed client credentials.</p><p>If the default browser does not open, use the ChatGPT Plugins link above and copy the server URL. Use that browser’s own ChatGPT sign-in.</p></details></li>
    <li class="connector-step" data-connector-step="approve"><h3>3. Match the code and approve permissions</h3><p>Match the browser’s request code with the request below. Choose the permissions you need, or choose <strong>Select all</strong> and check the selected count to include every offered permission. Then choose <strong>Allow selected access</strong>. Select all changes the checkboxes; it does not approve access. Undecided requests wait for your decision.</p>${accessRequests || `<p class="connector-note">${grants.length ? 'Access is approved. Review the granted permissions under Access controls, then continue with the status check below. Reuse this connection; reconnect only when ChatGPT asks or you need additional permissions.' : 'No approval request yet. Start connecting the BLACKICE server in ChatGPT, then check status here.'}</p>`}</li>
    <li class="connector-step" data-connector-step="verify"><h3>4. Check the result in your ChatGPT conversation</h3><p>After installation, start a new conversation in <strong>Chat mode</strong>. Type <strong>@BLACKICE</strong> and choose <strong>BLACKICE connection</strong> from <strong>Plugins</strong>. Send this prompt and compare the returned nonce. If the picker shows only <strong>Files</strong>, check <strong>Plugins → Installed</strong> in this same account and workspace. If only the desktop package is installed, complete step 2 to register and connect this computer’s tools.</p>${verificationPrompt ? `<label class="connector-endpoint">Status-check prompt<textarea id="connector-verification-prompt" readonly rows="5" spellcheck="false">${escape(verificationPrompt)}</textarea></label><div class="connector-actions">${button('copy-verification', 'Copy status-check prompt', '', busy)}</div><p class="connector-note">Expected nonce: <code>${escape(verification?.nonce)}</code></p>` : '<p class="connector-note">Prepare this computer to create its unique status-check prompt.</p>'}<div class="connector-verification" role="status">${confirmed ? `<strong>Connection confirmed by you</strong><p>You confirmed the matching ChatGPT result at ${escape(verification.confirmedAt)}.</p>` : matchingReceipt ? `<strong>Matching authenticated status check received</strong><p>BLACKICE received ${escape(verification.tool || 'blackice_direct_status')} at ${escape(verification.receivedAt)}. Check that the same nonce appears in your ChatGPT result, then confirm below.</p>` : '<p>No matching authenticated status check has been received yet.</p>'}</div>${matchingReceipt && !confirmed ? `<div class="connector-actions">${button('confirm-connection', 'I see the matching result in ChatGPT', '', busy)}</div>` : ''}<p class="connector-note">A server receipt alone does not verify the ChatGPT conversation. Your confirmation records that you saw its matching result.</p></li>
  </ol>${pendingJobs ? `<div class="connector-section"><h3>Actions waiting for you</h3>${pendingJobs}</div>` : ''}${current.enabled || linked ? `<details class="connector-section"><summary>Access controls</summary><p>Actions within this connection’s granted scopes execute directly, without a separate BLACKICE approval prompt. ChatGPT’s plugin permission is configured separately in ChatGPT.</p>${linked ? `<ul class="connector-grants">${linked}</ul>` : ''}${current.enabled ? button('disable', 'Disable & revoke access', '', busy) : ''}</details>` : ''}<details class="connector-section"><summary>DOT task failure or Status unavailable?</summary><p>If your BLACKICE status check succeeds with the matching nonce and your personal computer shows <strong>Connected</strong>, a DOT desktop task failure or <strong>Status unavailable</strong> message points to a separate task-start issue.</p><p>Keep the working BLACKICE connection. Save the exact error message and its reference for task investigation or support.</p></details><details class="connector-section"><summary>Connection limits</summary><p>Long actions keep their own IDs and results across reconnects. ChatGPT must check their status; automatic updates into an idle conversation are not assumed. Cancelling an action does not undo effects already completed.</p><p>Relative file paths use the configured working folder. Absolute file and upload paths are allowed with your Windows account’s access. Shell commands run with the same Windows account’s permissions. New writes, browser actions, imports, and commands execute within the connection’s granted scopes without a separate local approval step. Website sign-in and other required human interactions can still pause an action.</p></details></section>`;
}

/** Keep this mount alive across Settings redraws. Background polling never replaces a focused control. */
export function mountChatGPTConnector({ mount, api, presence, copy = writeClipboard, intervalMs = 3000 } = {}) {
  if (!mount || typeof api !== 'function') throw Error('The ChatGPT connector needs a Settings mount and API.');
  const document = mount.ownerDocument || globalThis.document;
  const state = { current: {}, scopes: new Map(), confirmPublic: false, loading: true, checking: false, setupRequested: false, busy: '', error: '', statusError: '', receipt: '', canOpenChatGPT: false, remote: presence?.localManagement === false || (typeof location !== 'undefined' && location.protocol === 'https:') };
  let destroyed = false, fetching = false, previous = '', pointer = false, dirty = false;
  function syncProgress() {
    const region = mount.querySelector('[data-connector-progress]');
    if (!region) return null;
    const progress = connectorProgress(state), signature = JSON.stringify(progress);
    if (region.connectorProgressSignature !== signature) {
      region.setAttribute('data-stage', progress.key); region.setAttribute('data-tone', progress.tone); region.setAttribute('data-busy', String(progress.busy));
      region.innerHTML = progressContents(progress); region.connectorProgressSignature = signature;
    }
    return region;
  }
  function render(force = false) {
    if (destroyed) return;
    // Progress may change while a permission control is focused. Keep that
    // control intact and update only the separate live status region.
    const progressRegion = syncProgress();
    if (!force && (pointer || mount.contains(document?.activeElement))) { dirty = true; return; }
    const html = renderChatGPTConnector(state); dirty = false;
    if (html === previous) return;
    const focused = document?.activeElement, marker = mount.contains(focused) ? { action: focused.dataset?.connectorAction, id: focused.dataset?.connectorId, idAttr: focused.id } : null;
    mount.innerHTML = html; previous = html;
    const nextProgress = mount.querySelector('[data-connector-progress]');
    if (nextProgress && progressRegion) nextProgress.replaceWith(progressRegion);
    else if (nextProgress) nextProgress.connectorProgressSignature = JSON.stringify(connectorProgress(state));
    if (marker) {
      const target = [...mount.querySelectorAll('button,input,textarea')].find(node => marker.idAttr ? node.id === marker.idAttr : marker.action && node.dataset?.connectorAction === marker.action && node.dataset?.connectorId === marker.id);
      target?.focus?.({ preventScroll: true });
    }
  }
  function adopt(value) {
    state.current = value;
    state.canOpenChatGPT = value.canOpenChatGPT === true;
    if (value.oauth?.grants?.length) state.setupRequested = false;
    for (const request of value.oauth?.requests || []) if (!state.scopes.has(request.id)) state.scopes.set(request.id, ['read']);
    const present = new Set((value.oauth?.requests || []).map(request => request.id));
    for (const id of state.scopes.keys()) if (!present.has(id)) state.scopes.delete(id);
  }
  async function refresh(explicit = false) {
    if (destroyed || fetching || state.busy || state.remote || !explicit && (!mount.isConnected || document?.visibilityState === 'hidden')) return;
    fetching = true;
    if (explicit && !state.loading) { state.checking = true; state.error = ''; render(true); }
    try { const value = await api('/api/chatgpt-connector'); if (!destroyed) { adopt(value); state.statusError = ''; } }
    catch (error) { if (!destroyed) state.statusError = error.message || 'The connector status could not be loaded.'; }
    finally { fetching = false; if (!destroyed) { state.loading = false; state.checking = false; render(explicit); } }
  }
  async function perform(action, payload = {}) {
    if (destroyed || state.busy || state.remote) return;
    if (action === 'refresh') return refresh(true);
    if (action === 'enable-startup' && (state.current.startup?.canEnable !== true || state.current.startup?.busy === true || startupReady(state.current.startup))) return;
    if (action === 'prepare') payload = { confirmPublic: state.confirmPublic === true };
    if (action === 'confirm-connection') {
      const verification = state.current.setup?.verification;
      if (!verification?.receivedAt || verification.confirmedAt || !state.current.oauth?.grants?.some(grant => grant.id === verification.clientId)) return;
      payload = { nonce: verification.nonce };
    }
    state.busy = action; state.error = ''; state.statusError = ''; state.receipt = ''; render(true);
    try {
      if (action === 'open-chatgpt') {
        const result = await api('/api/chatgpt-connector/open-chatgpt', 'POST', {});
        if (result?.requested !== true) throw Error('The browser setup request was not confirmed.');
        state.setupRequested = true;
        state.receipt = 'BLACKICE setup was requested in your default browser. Add this computer’s server URL there, then match its approval code here.';
      }
      else if (action === 'copy' || action === 'copy-verification') {
        const value = action === 'copy' ? Object.hasOwn(state.current, 'setup') ? state.current.setup?.serverUrl : state.current.endpoint : state.current.setup?.verification?.prompt || state.current.setup?.verificationPrompt;
        if (!value) throw Error('Prepare this computer before copying its connection details.');
        try { await copy(value); } catch (error) { throw Error(clipboardFailureMessage(error)); }
        state.receipt = action === 'copy' ? 'Server URL copied.' : 'Status-check prompt copied. Send it in your ChatGPT conversation with BLACKICE selected.';
      }
      else { const value = await api(`/api/chatgpt-connector/${action}`, 'POST', payload); if (!destroyed) { adopt(value); if (action === 'approve-access' && !value.oauth?.grants?.length) state.setupRequested = true; if (['disable', 'reject-access', 'revoke'].includes(action)) state.setupRequested = false; state.receipt = action === 'resolve-action' ? 'Interaction acknowledged. The original action will not be replayed.' : action === 'enable-startup' ? startupReady(value.startup) ? 'Automatic startup settings verified. Review the startup checks below.' : 'Startup setup finished. Review the checks that still need attention.' : action === 'prepare' ? value.setup?.ready ? 'This computer is prepared. Add its server URL in ChatGPT.' : 'Preparation checked. Review the checks below.' : action === 'check-connection' ? 'Public connection checks finished. Review their results below.' : action === 'confirm-connection' ? 'Connection confirmed by you.' : 'Connection settings updated.'; } }
    } catch (error) { if (!destroyed) state.error = error.message || 'The request could not be completed.'; }
    finally { if (!destroyed) { state.busy = ''; render(true); } }
  }
  const click = event => {
    const target = event.target.closest?.('[data-connector-action]'); if (!target || !mount.contains(target)) return;
    event.preventDefault(); if (state.busy || target.disabled || target.getAttribute('aria-disabled') === 'true') return;
    const { connectorAction: action, connectorId: id, connectorInteraction: interactionId } = target.dataset;
    if (action === 'select-all-access') {
      if (destroyed || state.remote) return;
      const request = state.current.oauth?.requests?.find(item => item.id === id); if (!request) return;
      state.scopes.set(id, offeredPermissions(request).map(([scope]) => scope)); render(true); return;
    }
    void perform(action, { ...(id ? { id } : {}), ...(interactionId ? { interactionId } : {}) });
  };
  const change = event => {
    const input = event.target;
    if (input.dataset?.connectorPublicConfirmation !== undefined) { state.confirmPublic = input.checked; render(true); return; }
    const form = input.closest?.('[data-connector-request]'); if (!form || !input.dataset?.connectorScope) return;
    const scopes = [...form.querySelectorAll('[data-connector-scope]')].filter(node => node.checked).map(node => node.dataset.connectorScope);
    state.scopes.set(form.dataset.connectorRequest, [...new Set(['read', ...scopes])]);
    const request = state.current.oauth?.requests?.find(item => item.id === form.dataset.connectorRequest), summary = form.querySelector('[data-connector-selection]');
    if (request && summary) summary.textContent = selectionSummary(request, state.scopes.get(request.id));
  };
  const submit = event => {
    const form = event.target; if (!form.dataset?.connectorRequest) return;
    event.preventDefault(); void perform('approve-access', { id: form.dataset.connectorRequest, scopes: state.scopes.get(form.dataset.connectorRequest) || ['read'] });
  };
  const down = () => { pointer = true; }, up = () => { pointer = false; }, blur = () => { queueMicrotask(() => { if (dirty) render(); }); };
  mount.addEventListener('click', click); mount.addEventListener('change', change); mount.addEventListener('submit', submit); mount.addEventListener('pointerdown', down); document?.addEventListener?.('pointerup', up); mount.addEventListener('focusout', blur);
  render(); void refresh(true);
  const timer = setInterval(() => { void refresh(); }, intervalMs); timer.unref?.();
  return { update(value) { if (value?.localManagement === false) state.remote = true; }, refresh,
    destroy() { destroyed = true; clearInterval(timer); mount.removeEventListener('click', click); mount.removeEventListener('change', change); mount.removeEventListener('submit', submit); mount.removeEventListener('pointerdown', down); document?.removeEventListener?.('pointerup', up); mount.removeEventListener('focusout', blur); mount.innerHTML = ''; } };
}
