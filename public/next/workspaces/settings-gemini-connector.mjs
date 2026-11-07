const GEMINI_CONNECTORS_URL = 'https://gemini.google.com/customize/connectors';
const PROBE = 'Use the BLACKICE Direct Execution connected app to call blackice_direct_status with nonce GEMINI_BLACKICE_CHECK. Return the actual nonce, available, and connectionId from its tool result.';
const SCOPES = {
  read: 'Read plans and action receipts',
  'planning:write': 'Edit saved plans',
  'files:read': 'Read local files',
  'files:write': 'Modify local files',
  'browser:read': 'Read BLACKICE browser',
  'browser:write': 'Control BLACKICE browser',
  'commands:run': 'Run local commands',
};
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const isGoogle = value => value?.kind === 'mcp' && value?.label === 'Google';
const googleGrants = value => (value?.oauth?.grants || []).filter(isGoogle);
const googleRequests = value => (value?.oauth?.requests || []).filter(request => request.clientLabel === 'Google');
const readableTime = value => {
  if (!value) return 'Not yet';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value);
};

export function createGeminiConnectorSettings({ mount, api, notify = () => {} } = {}) {
  if (!mount || typeof api !== 'function') throw Error('Gemini connector needs its settings mount and API.');
  let active = false, destroyed = false, fetching = false, busy = false;
  let current = null, error = '', receipt = '', confirmRevoke = null, timer = null;
  const selected = new Map();

  function saveSelections() {
    for (const form of mount.querySelectorAll('[data-gemini-request]')) {
      const id = form.dataset.geminiRequest;
      selected.set(id, [...form.querySelectorAll('[data-gemini-scope]')].filter(node => node.checked).map(node => node.dataset.geminiScope));
    }
  }
  function render() {
    if (destroyed || !active) return;
    saveSelections();
    const grants = googleGrants(current), requests = googleRequests(current);
    const chatgptCount = (current?.oauth?.grants || []).filter(grant => grant.kind === 'chatgpt').length;
    const available = current?.available === true && current?.oauth?.healthy !== false;
    const endpoint = current?.endpoint || current?.setup?.serverUrl || '';
    const locked = busy || fetching;
    const feedback = error
      ? '<p class="next-help" role="alert">' + escape(error) + '</p>'
      : receipt ? '<p class="next-help" role="status">' + escape(receipt) + '</p>' : '';
    const status = !current ? 'Checking connection…'
      : grants.length ? 'Connected' : requests.length ? 'Approval needed'
      : !available ? 'Unavailable' : 'Not connected';

    mount.innerHTML = '<div class="next-stack gemini-connector-settings">'
      + '<section class="next-card"><h2>Gemini connector</h2>'
      + '<p class="next-help">Gemini uses the existing BLACKICE MCP server, with its own independent OAuth grant. ChatGPT stays connected when Gemini is added or removed.</p>'
      + '<div class="next-row"><strong>Google: ' + escape(status) + '</strong>'
      + '<button type="button" data-gemini-action="refresh"' + (locked ? ' disabled' : '') + '>Check status</button>'
      + '<button type="button" data-gemini-action="open"' + (locked ? ' disabled' : '') + '>Open Gemini connector setup in BLACKICE Browser</button></div>'
      + (chatgptCount ? '<p class="next-help">ChatGPT: ' + chatgptCount + ' separate active grant' + (chatgptCount === 1 ? '' : 's') + ' (unchanged).</p>' : '<p class="next-help">ChatGPT currently has no active grant; Gemini setup will not change that.</p>')
      + (endpoint ? '<p class="next-help">Shared MCP endpoint: <code>' + escape(endpoint) + '</code></p>' : '')
      + (current?.toolCatalog?.toolCount ? '<p class="next-help">Server tools available: ' + escape(current.toolCatalog.toolCount) + '</p>' : '')
      + feedback + '</section>'
      + '<section class="next-card"><h3>Google authorization</h3>'
      + (grants.length ? grants.map(grant =>
        '<div class="next-stack"><p><strong>Active Google grant</strong></p>'
        + '<p class="next-help">Grant: <code>' + escape(grant.id) + '</code><br>Last used: ' + escape(readableTime(grant.lastUsedAt))
        + '<br>Grant expires: ' + escape(readableTime(grant.expiresAt)) + '</p>'
        + '<p class="next-help">Permissions: ' + escape((grant.scopes || []).map(scope => SCOPES[scope] || scope).join(' · ')) + '</p>'
        + '<div class="next-row"><button type="button" data-gemini-action="disconnect" data-gemini-grant="' + escape(grant.id) + '"' + (locked ? ' disabled' : '') + '>'
        + (confirmRevoke === grant.id ? 'Keep Gemini connected' : 'Disconnect Gemini only') + '</button>'
        + (confirmRevoke === grant.id ? '<button type="button" data-gemini-action="confirm-disconnect" data-gemini-grant="' + escape(grant.id) + '"' + (locked ? ' disabled' : '') + '>Confirm disconnect Gemini</button>' : '')
        + '</div></div>'
      ).join('') : '<p class="next-help">No active Google grant. Use the setup button above, then approve the matching Google request below.</p>')
      + (requests.length ? requests.map(request => {
        const chosen = selected.get(request.id) || request.scopes || [];
        return '<form class="next-stack" data-gemini-request="' + escape(request.id) + '"><h3>Pending Google request</h3>'
          + '<p>Match this request code in Gemini: <strong><code>' + escape(request.displayCode) + '</code></strong></p>'
          + '<p class="next-help">Callback: ' + escape(request.clientOrigin || 'Google') + '</p>'
          + (request.scopes || []).map(scope =>
            '<label class="next-row"><input type="checkbox" data-gemini-scope="' + escape(scope) + '"'
            + (chosen.includes(scope) ? ' checked' : '') + (scope === 'read' ? ' disabled' : '')
            + '> ' + escape(SCOPES[scope] || scope) + '</label>'
          ).join('')
          + '<div class="next-row"><button type="submit" class="next-primary"' + (locked ? ' disabled' : '') + '>Allow selected access</button>'
          + '<button type="button" data-gemini-action="decline" data-gemini-request-id="' + escape(request.id) + '"' + (locked ? ' disabled' : '') + '>Decline Google request</button></div></form>';
      }).join('') : '') + '</section>'
      + '<section class="next-card"><h3>Test Gemini tool execution</h3>'
      + '<p class="next-help">In a Gemini chat, ask the connected app to call a BLACKICE tool. A saved connector or an authorization grant alone does not prove tool execution.</p>'
      + '<p><code id="gemini-connector-probe">' + escape(PROBE) + '</code></p>'
      + '<div class="next-row"><button type="button" data-gemini-action="copy-test">Copy test prompt</button>'
      + '<button type="button" data-gemini-action="browser">Go to BLACKICE Browser</button></div></section>'
      + '</div>';
  }

  async function refresh({ quiet = false } = {}) {
    if (destroyed || !active || fetching || busy) return;
    fetching = true;
    if (!quiet) error = '';
    try {
      current = await api('/api/chatgpt-connector');
      if (!quiet) receipt = '';
    } catch (failure) {
      error = failure.message || 'Could not retrieve BLACKICE connector status.';
    } finally {
      fetching = false;
      render();
    }
  }
  async function execute(action, id = null, scopes = null) {
    if (busy || destroyed || !active) return;
    if (action === 'refresh') return refresh();
    if (action === 'browser') {
      window.location.hash = '#browser';
      return;
    }
    if (action === 'disconnect') {
      confirmRevoke = confirmRevoke === id ? null : id;
      render();
      return;
    }
    if (action === 'copy-test') {
      try {
        await navigator.clipboard.writeText(PROBE);
        receipt = 'Status-check prompt copied.';
      } catch {
        error = 'Select the displayed prompt to copy it.';
      }
      render();
      return;
    }
    busy = true; error = ''; receipt = ''; render();
    try {
      if (action === 'open') {
        const result = await api('/api/browser/action', 'POST', { action: 'open', browser: 'relay', url: GEMINI_CONNECTORS_URL });
        if (!result?.tabId) throw Error('BLACKICE did not confirm the new Gemini browser tab.');
        receipt = 'Gemini connectors opened in BLACKICE Browser.';
      } else {
        // Re-read the live records before any grant or request mutation.
        const latest = await api('/api/chatgpt-connector');
        if (action === 'confirm-disconnect') {
          const grant = googleGrants(latest).find(value => value.id === id);
          if (!grant || confirmRevoke !== id) throw Error('Google grant changed. Refresh before disconnecting.');
          await api('/api/chatgpt-connector/revoke', 'POST', { id: grant.id });
          confirmRevoke = null;
          receipt = 'Gemini disconnected. ChatGPT grants were not changed.';
        } else if (action === 'approve' || action === 'decline') {
          const request = googleRequests(latest).find(value => value.id === id);
          if (!request) throw Error('This Google request is no longer pending.');
          if (action === 'approve') {
            const allowed = ['read', ...(scopes || []).filter(scope => scope !== 'read' && request.scopes.includes(scope))];
            await api('/api/chatgpt-connector/approve-access', 'POST', { id: request.id, scopes: allowed });
            receipt = 'Google request approved. Complete the redirect in Gemini.';
          } else {
            await api('/api/chatgpt-connector/reject-access', 'POST', { id: request.id });
            receipt = 'Google request declined.';
          }
          selected.delete(id);
        }
      }
      current = await api('/api/chatgpt-connector');
    } catch (failure) {
      error = failure.message || 'Gemini connector action failed.';
      notify(error, true);
    } finally {
      busy = false;
      render();
    }
  }
  function onClick(event) {
    const button = event.target.closest('[data-gemini-action]');
    if (!button || !mount.contains(button)) return;
    const action = button.dataset.geminiAction;
    void execute(action, button.dataset.geminiGrant || button.dataset.geminiRequestId || null);
  }
  function onSubmit(event) {
    const form = event.target.closest('[data-gemini-request]');
    if (!form || !mount.contains(form)) return;
    event.preventDefault();
    const scopes = [...form.querySelectorAll('[data-gemini-scope]')].filter(node => node.checked).map(node => node.dataset.geminiScope);
    void execute('approve', form.dataset.geminiRequest, scopes);
  }
  mount.addEventListener('click', onClick);
  mount.addEventListener('submit', onSubmit);
  return {
    enter() {
      if (destroyed || active) return;
      active = true; render();
      void refresh();
      timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh({ quiet: true }); }, 10000);
      timer.unref?.();
    },
    leave() { active = false; if (timer) clearInterval(timer); timer = null; },
    destroy() {
      destroyed = true; active = false; if (timer) clearInterval(timer); timer = null;
      mount.removeEventListener('click', onClick);
      mount.removeEventListener('submit', onSubmit);
      mount.replaceChildren();
    },
    updateStatus() {},
  };
}
