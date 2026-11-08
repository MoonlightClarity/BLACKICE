const CLAUDE_CONNECTORS_URL = 'https://claude.ai/customize/connectors';
const PROBE = 'Use the BLACKICE Direct Execution connected app to call blackice_direct_status with nonce CLAUDE_BLACKICE_CHECK. Return the actual nonce, available, and connectionId from its tool result.';
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
const isClaude = value => value?.kind === 'mcp' && value?.label === 'Claude';
const claudeGrants = value => (value?.oauth?.grants || []).filter(isClaude);
const claudeRequests = value => (value?.oauth?.requests || []).filter(request => request.clientLabel === 'Claude');
const readableTime = value => {
  if (!value) return 'Not yet';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value);
};

export function createClaudeConnectorSettings({ mount, api, notify = () => {} } = {}) {
  if (!mount || typeof api !== 'function') throw Error('Claude connector needs its settings mount and API.');
  let active = false, destroyed = false, fetching = false, busy = false;
  let current = null, error = '', receipt = '', confirmRevoke = null, timer = null;
  const selected = new Map();

  function saveSelections() {
    for (const form of mount.querySelectorAll('[data-claude-request]')) {
      const id = form.dataset.claudeRequest;
      selected.set(id, [...form.querySelectorAll('[data-claude-scope]')].filter(node => node.checked).map(node => node.dataset.claudeScope));
    }
  }
  function render() {
    if (destroyed || !active) return;
    saveSelections();
    const grants = claudeGrants(current), requests = claudeRequests(current);
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

    mount.innerHTML = '<div class="next-stack claude-connector-settings">'
      + '<section class="next-card"><h2>Claude connector</h2>'
      + '<p class="next-help">Claude uses the existing BLACKICE MCP server, with its own independent OAuth grant. ChatGPT stays connected when Claude is added or removed.</p>'
      + '<div class="next-row"><strong>Claude: ' + escape(status) + '</strong>'
      + '<button type="button" data-claude-action="refresh"' + (locked ? ' disabled' : '') + '>Check status</button>'
      + '<button type="button" data-claude-action="open"' + (locked ? ' disabled' : '') + '>Open Claude connector setup in BLACKICE Browser</button></div>'
      + (chatgptCount ? '<p class="next-help">ChatGPT: ' + chatgptCount + ' separate active grant' + (chatgptCount === 1 ? '' : 's') + ' (unchanged).</p>' : '<p class="next-help">ChatGPT currently has no active grant; Claude setup will not change that.</p>')
      + (endpoint ? '<p class="next-help">Shared MCP endpoint: <code>' + escape(endpoint) + '</code></p>' : '')
      + (current?.toolCatalog?.toolCount ? '<p class="next-help">Server tools available: ' + escape(current.toolCatalog.toolCount) + '</p>' : '')
      + feedback + '</section>'
      + '<section class="next-card"><h3>Claude authorization</h3>'
      + (grants.length ? grants.map(grant =>
        '<div class="next-stack"><p><strong>Active Claude grant</strong></p>'
        + '<p class="next-help">Grant: <code>' + escape(grant.id) + '</code><br>Last used: ' + escape(readableTime(grant.lastUsedAt))
        + '<br>Grant expires: ' + escape(readableTime(grant.expiresAt)) + '</p>'
        + '<p class="next-help">Connection access: All BLACKICE MCP tools.</p>'
        + '<div class="next-row"><button type="button" data-claude-action="disconnect" data-claude-grant="' + escape(grant.id) + '"' + (locked ? ' disabled' : '') + '>'
        + (confirmRevoke === grant.id ? 'Keep Claude connected' : 'Disconnect Claude only') + '</button>'
        + (confirmRevoke === grant.id ? '<button type="button" data-claude-action="confirm-disconnect" data-claude-grant="' + escape(grant.id) + '"' + (locked ? ' disabled' : '') + '>Confirm disconnect Claude</button>' : '')
        + '</div></div>'
      ).join('') : '<p class="next-help">No active Claude grant. Use the setup button above, then approve the matching Claude request below.</p>')
      + (requests.length ? requests.map(request => {
        const chosen = selected.get(request.id) || request.scopes || [];
        return '<form class="next-stack" data-claude-request="' + escape(request.id) + '"><h3>Pending Claude request</h3>'
          + '<p>Match this request code in Claude: <strong><code>' + escape(request.displayCode) + '</code></strong></p>'
          + '<p class="next-help">Callback: ' + escape(request.clientOrigin || 'Claude') + '</p>'
          + '<p class="next-help">Connecting Claude grants access to all BLACKICE MCP tools, including plans, local files, browser control, and commands.</p>'
          + '<div class="next-row"><button type="submit" class="next-primary"' + (locked ? ' disabled' : '') + '>Connect Claude</button>'
          + '<button type="button" data-claude-action="decline" data-claude-request-id="' + escape(request.id) + '"' + (locked ? ' disabled' : '') + '>Decline Claude request</button></div></form>';
      }).join('') : '') + '</section>'
      + '<section class="next-card"><h3>Test Claude tool execution</h3>'
      + '<p class="next-help">In a Claude chat, ask the connected app to call a BLACKICE tool. A saved connector or an authorization grant alone does not prove tool execution.</p>'
      + '<p><code id="claude-connector-probe">' + escape(PROBE) + '</code></p>'
      + '<div class="next-row"><button type="button" data-claude-action="copy-test">Copy test prompt</button>'
      + '<button type="button" data-claude-action="browser">Go to BLACKICE Browser</button></div></section>'
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
        const result = await api('/api/browser/action', 'POST', { action: 'open', browser: 'relay', url: CLAUDE_CONNECTORS_URL });
        if (!result?.tabId) throw Error('BLACKICE did not confirm the new Claude browser tab.');
        receipt = 'Claude connectors opened in BLACKICE Browser.';
      } else {
        // Re-read the live records before any grant or request mutation.
        const latest = await api('/api/chatgpt-connector');
        if (action === 'confirm-disconnect') {
          const grant = claudeGrants(latest).find(value => value.id === id);
          if (!grant || confirmRevoke !== id) throw Error('Claude grant changed. Refresh before disconnecting.');
          await api('/api/chatgpt-connector/revoke', 'POST', { id: grant.id });
          confirmRevoke = null;
          receipt = 'Claude disconnected. ChatGPT grants were not changed.';
        } else if (action === 'approve' || action === 'decline') {
          const request = claudeRequests(latest).find(value => value.id === id);
          if (!request) throw Error('This Claude request is no longer pending.');
          if (action === 'approve') {
            const allowed = request.scopes || ['read'];
            await api('/api/chatgpt-connector/approve-access', 'POST', { id: request.id, scopes: allowed });
            receipt = 'Claude request approved. Complete the redirect in Claude.';
          } else {
            await api('/api/chatgpt-connector/reject-access', 'POST', { id: request.id });
            receipt = 'Claude request declined.';
          }
          selected.delete(id);
        }
      }
      current = await api('/api/chatgpt-connector');
    } catch (failure) {
      error = failure.message || 'Claude connector action failed.';
      notify(error, true);
    } finally {
      busy = false;
      render();
    }
  }
  function onClick(event) {
    const button = event.target.closest('[data-claude-action]');
    if (!button || !mount.contains(button)) return;
    const action = button.dataset.claudeAction;
    void execute(action, button.dataset.claudeGrant || button.dataset.claudeRequestId || null);
  }
  function onSubmit(event) {
    const form = event.target.closest('[data-claude-request]');
    if (!form || !mount.contains(form)) return;
    event.preventDefault();
    const scopes = [...form.querySelectorAll('[data-claude-scope]')].filter(node => node.checked).map(node => node.dataset.claudeScope);
    void execute('approve', form.dataset.claudeRequest, scopes);
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
