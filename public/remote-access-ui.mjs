import { writeClipboard as copyToClipboard, clipboardFailureMessage } from './clipboard.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const date = value => { const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : 'Unknown'; };
const remoteLocation = () => typeof location !== 'undefined' && (location.protocol === 'https:' || !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname));
const button = (id, action, label, busy, extra = '') => `<button type="button"${id ? ` id="${id}"` : ''} data-remote-action="${action}"${busy ? ' aria-disabled="true"' : ''}${extra}>${label}</button>`;

/** A persistent Settings mount. Credentials exist only in this controller until dismissed. */
export function mountRemoteAccess({ mount, api, status, desktop, onBackground, onShow, writeClipboard = copyToClipboard } = {}) {
  if (!mount || typeof api !== 'function') throw new Error('Remote access requires a Settings mount and API.');
  const state = { status: status || {}, desktop: desktop || {}, remote: remoteLocation() || status?.localManagement === false || status?.client === 'remote', mode: status?.mode === 'public' ? 'public' : 'private', modeDirty: false, confirmPublic: false, busy: '', error: '', receipt: '', pairing: null, credential: null, credentialVisible: false, agentName: '', agentOpen: false };
  let destroyed = false, previousHTML = '';
  const document = mount.ownerDocument || globalThis.document;
  const activeMarker = () => {
    const active = document?.activeElement; if (!active || !mount.contains(active)) return null;
    const selector = active.id ? '#' + active.id : active.dataset?.remoteRevoke ? `[data-remote-revoke="${active.dataset.remoteRevoke}"]` : active.dataset?.remoteAction ? `[data-remote-action="${active.dataset.remoteAction}"]` : null;
    return selector ? { selector, start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection } : null;
  };
  function render() {
    if (destroyed) return;
    const current = state.status, enabled = current.enabled === true, busy = Boolean(state.busy);
    const notice = state.error || current.error?.message;
    const message = notice ? `<p id="remote-access-message" class="remote-error" role="alert">${escape(notice)}</p>` : state.receipt ? `<p id="remote-access-message" role="status">${escape(state.receipt)}</p>` : '';
    let content;
    if (state.remote) {
      content = `<p>This browser is connected remotely${current.device?.label ? ` as <strong>${escape(current.device.label)}</strong>` : ''}. Chats, plans and connected tools run on the computer hosting BLACKICE.</p><p class="remote-note">Pairing, agent credentials and network exposure are managed in BLACKICE on that computer.</p>${button('remote-logout', 'logout', 'Disconnect this browser', busy)}`;
    } else {
      const change = enabled && state.mode !== current.mode;
      const route = current.url ? `<div class="remote-address"><span>${current.mode === 'public' ? 'Authenticated public address' : 'Private Tailscale address'}</span><a href="${escape(current.url)}" target="_blank" rel="noreferrer">${escape(current.url)}</a>${button('', 'copy-address', 'Copy address', busy)}</div>` : '';
      const pair = state.pairing ? `<div class="remote-secret" aria-label="Browser pairing code"><label for="remote-pair-code">One-use pairing code</label><input id="remote-pair-code" readonly spellcheck="false" value="${escape(state.pairing.code)}"><p class="remote-note">Expires ${escape(date(state.pairing.expiresAt))}. Share the code or pairing link only with the browser you want to authorize.</p><div class="remote-actions">${button('', 'copy-code', 'Copy code', busy)}${button('', 'copy-pair-link', 'Copy pairing link', busy)}${button('', 'clear-pair', 'Hide code', busy)}</div></div>` : '';
      const credential = state.credential ? `<div class="remote-secret" aria-label="New agent credential"><label for="remote-agent-token">Agent credential · shown only here</label><input id="remote-agent-token" type="${state.credentialVisible ? 'text' : 'password'}" readonly autocomplete="off" spellcheck="false" value="${escape(state.credential.token)}"><p class="remote-note">Copy it now. BLACKICE stores only its hash. Expires ${escape(date(state.credential.device.expiresAt))}.</p><div class="remote-actions">${button('', 'copy-token', 'Copy credential', busy)}${button('', 'show-token', state.credentialVisible ? 'Hide credential' : 'Show credential', busy)}${button('', 'clear-token', 'Dismiss', busy)}</div></div>` : '';
      const endpoints = current.endpoints ? `<dl class="remote-endpoints"><dt>MCP endpoint</dt><dd><code>${escape(current.endpoints.mcp)}</code></dd><dt>Agent REST API</dt><dd><code>${escape(current.endpoints.api)}</code></dd><dt>Authentication header</dt><dd><code>Authorization: Bearer &lt;credential&gt;</code></dd></dl>` : '';
      const devices = (current.devices || []).map(device => `<li><div><strong>${escape(device.label)}</strong><span>${device.kind === 'agent' ? 'Agent' : 'Browser'} · expires ${escape(date(device.expiresAt))}</span>${device.kind === 'agent' ? `<small>Connected agent</small>` : ''}</div><button type="button" data-remote-revoke="${escape(device.id)}"${busy ? ' aria-disabled="true"' : ''} aria-label="Revoke ${escape(device.label)}">Revoke</button></li>`).join('');
      content = `<p>Open this workspace in another browser or connect an outside agent. Work and provider credentials stay on this computer.</p><div class="remote-transport"><label for="remote-mode">Who can reach the address?</label><select id="remote-mode"><option value="private"${state.mode === 'private' ? ' selected' : ''}>Private · devices on your Tailscale network</option><option value="public"${state.mode === 'public' ? ' selected' : ''}>Public · browsers and agents on the internet</option></select><p class="remote-note">${state.mode === 'public' ? 'Public access gives outside agents an internet-reachable HTTPS endpoint. Every client still needs a paired browser session or a paired bearer credential.' : 'Private access requires a connected Tailscale device. Choose Public for an outside agent that cannot join your Tailscale network.'}</p>${state.mode === 'public' && (!enabled || change) ? `<label class="remote-check"><input id="remote-public-confirm" type="checkbox"${state.confirmPublic ? ' checked' : ''}>Publish the authenticated BLACKICE endpoint to the internet.</label>` : ''}<div class="remote-actions">${!enabled || change ? button('remote-enable', 'enable', state.busy === 'enable' ? 'Enabling…' : `${change ? 'Switch to' : 'Enable'} ${state.mode} access`, busy, current.available === false || state.mode === 'public' && !state.confirmPublic ? ' disabled' : '') : ''}${enabled || current.configuredEnabled || current.gateway?.listening ? button('remote-disable', 'disable', state.busy === 'disable' ? 'Disabling…' : 'Disable & revoke all', busy) : ''}${button('remote-refresh', 'refresh', state.busy === 'refresh' ? 'Checking…' : 'Check connection', busy)}</div></div>${enabled ? `${route}<div class="remote-browser-pair"><h3>Connect a browser</h3><p class="remote-note">Create a five-minute code, then open the HTTPS address on the other device.</p>${button('remote-pair', 'pair', 'Create pairing code', busy)}${pair}</div><details id="remote-agent-setup"${state.agentOpen ? ' open' : ''}><summary>Connect an outside agent</summary>${endpoints}<form id="remote-agent-form"><label for="remote-agent-name">Agent name</label><input id="remote-agent-name" maxlength="80" required autocomplete="off" value="${escape(state.agentName)}" placeholder="For example, my cloud agent"><p class="remote-note">Paired agents can use all BLACKICE capabilities.</p><button id="remote-create-agent" type="submit"${busy ? ' aria-disabled="true"' : ''}>${state.busy === 'create-agent' ? 'Creating…' : 'Create agent credential'}</button></form>${credential}</details>` : `<p class="remote-note">Tailscale must be installed and connected on this computer. Enabling access uses a separate HTTPS port and preserves existing Tailscale routes.</p>`}${devices ? `<div class="remote-devices"><h3>Paired browsers & agents</h3><ul>${devices}</ul></div>` : ''}`;
      if (state.desktop.available) content += `<div class="remote-background"><h3>Desktop runtime</h3><p>${state.desktop.mode === 'headless' || state.desktop.mode === 'background' ? 'BLACKICE is running in the background with this same profile and connected tools.' : 'Keep agent work running while the BLACKICE window is hidden.'}</p><div class="remote-actions">${state.desktop.mode === 'headless' || state.desktop.mode === 'background' ? button('desktop-show', 'show', 'Show desktop window', busy) : button('desktop-background', 'background', 'Run in background', busy)}</div><p class="remote-note">Reopen BLACKICE to show this same session. Quit stops work and pauses scheduled jobs.</p></div>`;
    }
    const html = `<section id="remote-access-settings" class="remote-access" aria-label="Remote access and background runtime"><div class="remote-heading"><h2>Remote access</h2><span class="remote-state">${state.remote ? 'Connected remotely' : enabled ? current.mode === 'public' ? 'Public · authenticated' : 'Private · ready' : state.busy === 'enable' ? 'Starting' : 'Disabled'}</span></div>${message}${content}</section>`;
    if (html === previousHTML) return;
    const marker = activeMarker(); mount.innerHTML = html; previousHTML = html;
    if (marker) { const next = mount.querySelector(marker.selector); next?.focus?.({ preventScroll: true }); if (Number.isInteger(marker.start) && Number.isInteger(marker.end)) try { next?.setSelectionRange?.(marker.start, marker.end, marker.direction); } catch {} }
  }
  function adopt(value) {
    if (!value || typeof value !== 'object') return;
    state.status = value;
    if (value.localManagement === false || value.client === 'remote') state.remote = true;
    if (!state.modeDirty && ['private', 'public'].includes(value.mode)) state.mode = value.mode;
    if (value.enabled === false) { state.pairing = null; state.credential = null; }
  }
  async function perform(action, operation) {
    if (destroyed || state.busy) return;
    state.busy = action; state.error = ''; state.receipt = ''; render();
    try { await operation(); }
    catch (cause) { if (!destroyed) state.error = cause?.message || 'The request could not be completed.'; }
    finally { if (!destroyed) { state.busy = ''; render(); } }
  }
  async function copy(value, receipt) {
    if (!value) return;
    try { await writeClipboard(value); }
    catch (error) { throw new Error(clipboardFailureMessage(error)); }
    if (!destroyed) state.receipt = receipt;
  }
  const refresh = () => perform('refresh', async () => { adopt(await api('/api/remote-access' + (state.remote ? '' : '/refresh'), state.remote ? 'GET' : 'POST', state.remote ? undefined : {})); });
  const click = event => {
    const target = event.target.closest?.('[data-remote-action], [data-remote-revoke]'); if (!target || !mount.contains(target)) return;
    event.preventDefault(); if (state.busy || target.disabled) return;
    const action = target.dataset.remoteAction || 'revoke';
    if (state.remote && !['logout', 'refresh'].includes(action)) return;
    if (action === 'refresh') return refresh();
    return perform(action, async () => {
      if (action === 'enable') {
        if (state.mode === 'public' && !state.confirmPublic) throw new Error('Confirm public access before enabling it.');
        adopt(await api('/api/remote-access/enable', 'POST', { mode: state.mode, ...(state.mode === 'public' ? { confirmPublic: true } : {}) })); state.modeDirty = false; state.confirmPublic = false;
      } else if (action === 'disable') { adopt(await api('/api/remote-access/disable', 'POST', {})); state.pairing = null; state.credential = null; }
      else if (action === 'pair') { const result = await api('/api/remote-access/pair', 'POST', {}); adopt(result.status); state.pairing = result; }
      else if (action === 'revoke') { adopt(await api('/api/remote-access/revoke', 'POST', { id: target.dataset.remoteRevoke })); if (state.credential?.device.id === target.dataset.remoteRevoke) state.credential = null; }
      else if (action === 'copy-address') await copy(state.status.url, 'Address copied.');
      else if (action === 'copy-code') await copy(state.pairing?.code, 'Pairing code copied.');
      else if (action === 'copy-pair-link') await copy(state.pairing?.pairUrl, 'Pairing link copied.');
      else if (action === 'clear-pair') state.pairing = null;
      else if (action === 'copy-token') await copy(state.credential?.token, 'Agent credential copied.');
      else if (action === 'show-token') state.credentialVisible = !state.credentialVisible;
      else if (action === 'clear-token') { state.credential = null; state.credentialVisible = false; }
      else if (action === 'background') state.desktop = await (onBackground ? onBackground() : api('/api/desktop/background', 'POST', {}));
      else if (action === 'show') state.desktop = await (onShow ? onShow() : api('/api/desktop/show', 'POST', {}));
      else if (action === 'logout') { await api('/remote/logout', 'POST', {}); if (typeof location !== 'undefined') location.assign('/'); }
    });
  };
  const input = event => {
    if (event.target.id === 'remote-agent-name') { state.agentName = event.target.value; return; }
    if (event.target.id === 'remote-mode') { state.mode = event.target.value === 'public' ? 'public' : 'private'; state.modeDirty = true; state.confirmPublic = false; render(); }
    else if (event.target.id === 'remote-public-confirm') { state.confirmPublic = event.target.checked; render(); }
  };
  const submit = event => {
    if (event.target.id !== 'remote-agent-form') return; event.preventDefault();
    if (state.remote) return;
    return perform('create-agent', async () => {
      if (!state.agentName.trim()) throw new Error('Enter an agent name.');
      const result = await api('/api/remote-access/create-agent', 'POST', { label: state.agentName.trim() });
      adopt(result.status); state.credential = result; state.credentialVisible = false; state.agentOpen = true;
    });
  };
  const toggle = event => { if (event.target.id === 'remote-agent-setup') state.agentOpen = event.target.open; };
  mount.addEventListener('click', click); mount.addEventListener('input', input); mount.addEventListener('change', input); mount.addEventListener('submit', submit); mount.addEventListener('toggle', toggle, true); render();
  return { update(value = {}) { if (value.status !== undefined) adopt(value.status); if (value.desktop !== undefined) state.desktop = value.desktop; render(); }, refresh, destroy() { destroyed = true; state.pairing = null; state.credential = null; mount.removeEventListener('click', click); mount.removeEventListener('input', input); mount.removeEventListener('change', input); mount.removeEventListener('submit', submit); mount.removeEventListener('toggle', toggle, true); } };
}
