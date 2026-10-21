/** Convert explicit form fields to an MCP connection. Blank secret fields preserve saved values. */
export function toolConnectionPayload(fields, selected = {}) {
  const name = String(fields.name || '').trim();
  if (!name) throw new Error('Give this connection a name.');
  const transport = fields.transport === 'http' ? 'http' : 'stdio';
  const timeout = Number(fields.timeoutSeconds);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 180) throw new Error('Choose a timeout between 1 and 180 seconds.');
  const value = { id: selected.id || `tools-${crypto.randomUUID().slice(0, 8)}`, name, transport, enabled: fields.enabled === true, timeoutMs: timeout * 1000 };
  if (transport === 'stdio') {
    value.command = String(fields.command || '').trim();
    if (!value.command) throw new Error('Enter the executable that starts this tool server.');
    // Each line is one argument; spaces and quotes inside it are literal, never shell syntax.
    const args = String(fields.args || '').replace(/\r\n?/g, '\n');
    value.args = args ? args.split('\n') : [];
    if (value.args.at(-1) === '') value.args.pop();
    value.cwd = String(fields.cwd || '').trim();
  } else {
    let url; try { url = new URL(String(fields.url || '').trim()); } catch { throw new Error('Enter the complete HTTP endpoint supplied by the MCP server.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('Use an HTTP or HTTPS endpoint without credentials, a query, or a fragment. Put credentials in headers.');
    value.url = url.href;
  }
  for (const [key, label] of [['env', 'Environment variables'], ['headers', 'HTTP headers']]) {
    const raw = String(fields[key] || '').trim();
    if (!raw) continue;
    let object; try { object = JSON.parse(raw); } catch { throw new Error(`${label} need a JSON object, such as {"NAME":"value"}.`); }
    if (!object || typeof object !== 'object' || Array.isArray(object) || Object.values(object).some(item => typeof item !== 'string')) throw new Error(`${label} must be an object with text values.`);
    value[key] = object;
  }
  return value;
}

/** Configure real stdio / Streamable HTTP servers without renderer-side credential storage. */
export function initToolConnectionsUI({ api, showModal, closeModal, toast, escape, icon }) {
  const $ = selector => document.querySelector(selector);
  const state = { entries: [], selected: null, busy: false, listRequest: 0, catalogRequest: 0, generation: 0, catalog: null, query: '', tab: 'setup', importPreview: null };
  const alive = () => Boolean($('#tool-connections-view'));
  const clearSensitiveFields = () => { for (const field of document.querySelectorAll('#tool-import-source,#tool-connection-form textarea[name="env"],#tool-connection-form textarea[name="headers"]')) field.value = ''; };
  const endpoint = id => `/api/connections/${encodeURIComponent(id)}`;
  const status = entry => entry.agentAvailable === false ? 'Manual connection only' : entry.enabled === false ? 'Disabled' : entry.busy ? `${entry.busy} active ${entry.busy === 1 ? 'tool' : 'tools'}` : entry.connected ? 'Connected' : entry.error ? 'Needs attention' : 'Disconnected';
  const storage = entry => entry.secretStorage === 'encrypted' ? 'Credentials encrypted for your Windows account' : entry.secretStorage === 'session' ? 'Credentials kept for this server session' : 'No credentials saved';
  const header = () => `<div class="modal-header"><span class="tool-connections-mark">${icon('connections', 26)}</span><div class="modal-title"><h2>Connected tools</h2><p>Manage your local and remote MCP servers.</p></div><button class="icon-button" data-action="close-modal" aria-label="Close connected tools">${icon('close', 17)}</button></div>`;
  const error = message => { const element = $('#tool-connections-error'); if (element) element.textContent = message; else if (alive()) toast(message, true); };
  function renderList() {
    if (!alive()) return;
    clearSensitiveFields();
    state.selected = null; state.catalogRequest++; state.catalog = null;
    $('#tool-connections-view').innerHTML = `<div class="tool-connections-toolbar"><div><strong>Your tool servers</strong><span>Agents discover supported tools when a task needs them.</span></div><button class="button subtle" data-mcp-action="refresh">${icon('refresh', 13)}Refresh</button><button class="button" data-mcp-action="import">${icon('upload', 13)}Import</button><button class="button primary" data-mcp-action="new">${icon('plus', 14)}Add server</button></div><div id="tool-connections-error" class="tool-connections-error error-text" role="alert"></div><div class="tool-connections-list">${state.entries.length ? state.entries.map(entry => `<article class="tool-connection-card"><div class="tool-connection-card-heading"><div><strong>${escape(entry.name)}</strong><span class="tool-connection-state${entry.connected ? ' connected' : entry.error ? ' needs-attention' : ''}"><i></i>${escape(status(entry))}</span></div><span class="tool-connection-transport">${entry.transport === 'http' ? 'Streamable HTTP' : 'Local process · stdio'}</span></div><p class="tool-connection-destination" title="${escape(entry.url || entry.command || '')}">${escape(entry.url || entry.command || '')}</p>${entry.error ? `<p class="tool-connection-error">${escape(entry.error)}</p>` : ''}${entry.agentUnavailableReason ? `<p class="field-help">${escape(entry.agentUnavailableReason)}</p>` : ''}<div class="tool-connection-card-footer"><span>${entry.connected ? `${Number(entry.toolCount || 0).toLocaleString()} ${entry.toolCount === 1 ? 'tool' : 'tools'}` : escape(storage(entry))}</span><div><button class="button subtle" data-mcp-action="edit" data-id="${escape(entry.id)}">Configure</button><button class="button" data-mcp-action="tools" data-id="${escape(entry.id)}"${entry.enabled === false ? ' disabled' : ''}>${icon('search', 12)}Tools</button><button class="button" data-mcp-action="${entry.connected ? 'disconnect' : 'connect'}" data-id="${escape(entry.id)}"${entry.busy || entry.enabled === false ? ' disabled' : ''}>${entry.connected ? 'Disconnect' : 'Connect'}</button></div></div></article>`).join('') : `<div class="tool-connections-empty"><img src="/assets/connections.svg" alt="" width="150" height="100"><h3>Bring your tools to the task.</h3><p>Connect a server for files, search, databases, or the services you use. BLACKICE discovers its actual tools and makes them available to agents.</p><button class="button primary" data-mcp-action="new">${icon('plus', 14)}Add your first server</button></div>`}</div><footer class="tool-connections-footer"><span>${icon('info', 12)}Local processes and Streamable HTTP are supported. Use headers for HTTP authentication.</span><button class="button" data-mcp-action="done">Done</button></footer>`;
    bind();
  }
  async function loadList() {
    const request = ++state.listRequest, generation = state.generation;
    try { const data = await api('/api/connections'); if (request !== state.listRequest || generation !== state.generation || !alive()) return; state.entries = Array.isArray(data) ? data : data.connections || []; renderList(); }
    catch (cause) { if (generation === state.generation && alive()) { if (!$('#tool-connections-error')) $('#tool-connections-view').innerHTML = '<div class="tool-connections-load-error"><p id="tool-connections-error" class="error-text" role="alert"></p><button class="button" data-mcp-action="refresh">Try again</button></div>'; error(cause.message); bind(); } }
  }
  function renderImport() {
    if (!alive()) return;
    state.selected = null; state.importPreview = null; state.catalogRequest++;
    $('#tool-connections-view').innerHTML = `<div class="tool-connection-editor-heading"><button class="button subtle" data-mcp-action="back">${icon('chevron', 13)}All servers</button><span>Import MCP configuration</span></div><form id="tool-import-form" class="tool-import-form"><div class="tool-import-scroll"><div class="tool-import-intro"><strong>Bring an existing tool setup.</strong><p>Paste a common <code>mcpServers</code> object or a BLACKICE <code>connections</code> array. This adds new connections and preserves your existing ones.</p></div><label class="field"><span class="field-label">Configuration JSON</span><textarea id="tool-import-source" maxlength="512000" rows="9" spellcheck="false" autocomplete="off" placeholder='{"mcpServers":{"my-server":{"command":"node","args":["server.mjs"]}}}' required></textarea></label><div class="tool-import-file-row"><button class="button subtle" type="button" data-mcp-action="import-file">${icon('upload', 12)}Choose JSON file</button><span>Up to 512,000 characters. Credential values are never shown in the preview.</span><input id="tool-import-file" type="file" accept=".json,application/json,text/plain" hidden></div><div id="tool-connections-error" class="tool-connections-error error-text" role="alert"></div><div id="tool-import-preview" class="tool-import-preview" aria-live="polite"></div><p class="tool-import-note">Local processes and Streamable HTTP are supported. Imported servers connect when an agent needs their tools. Legacy SSE and OAuth sign-in are not supported.</p></div><div class="tool-connection-save-row"><span class="tool-import-count" id="tool-import-count">Read the configuration to see its servers.</span><div><button class="button" type="submit">Read configuration</button><button class="button primary" type="button" data-mcp-action="import-apply" disabled>Import servers</button></div></div></form>`;
    bind();
    const importForm = $('#tool-import-form'); importForm.onsubmit = event => { event.preventDefault(); importConfiguration(false); };
    $('#tool-import-source').oninput = () => { state.importPreview = null; $('#tool-import-preview').innerHTML = ''; $('#tool-import-count').textContent = 'Configuration changed. Read it again to update the list.'; $('[data-mcp-action="import-apply"]').disabled = true; error(''); };
    $('#tool-import-file').onchange = async event => {
      const file = event.target.files[0]; if (!file) return;
      try { if (file.size > 2 * 1024 * 1024) throw new Error('Choose a configuration with at most 512,000 characters.'); const source = await file.text(); if ($('#tool-import-form') !== importForm) return; if (source.length > 512000) throw new Error('Choose a configuration with at most 512,000 characters.'); $('#tool-import-source').value = source; $('#tool-import-source').dispatchEvent(new Event('input', { bubbles: true })); await importConfiguration(false); }
      catch (cause) { error(cause.message); }
      finally { if (event.target.isConnected) event.target.value = ''; }
    };
    $('#tool-import-source').focus({ preventScroll: true });
  }
  async function importConfiguration(apply) {
    const form = $('#tool-import-form'); if (!form || state.busy || !form.reportValidity() || apply && !state.importPreview?.length) return;
    const source = $('#tool-import-source').value, generation = state.generation; state.busy = true; error('');
    const controls = [...form.querySelectorAll('button,input,textarea')]; controls.forEach(control => control.disabled = true);
    $('#tool-import-count').textContent = apply ? 'Saving new connections…' : 'Reading configuration…';
    try {
      const result = await api('/api/connections/import', 'POST', { configuration: source, apply });
      if (!alive() || generation !== state.generation || $('#tool-import-form') !== form) return;
      if (apply) {
        const count = Array.isArray(result.imported) ? result.imported.length : result.imported ?? result.connections?.length ?? result.saved?.length ?? state.importPreview.length;
        $('#tool-import-source').value = ''; state.importPreview = null;
        toast(`${count} tool ${count === 1 ? 'server' : 'servers'} imported. Connections start when needed.`); await loadList();
      } else {
        state.importPreview = result.preview || result.connections || [];
        $('#tool-import-count').textContent = `${state.importPreview.length} new ${state.importPreview.length === 1 ? 'connection' : 'connections'}`;
        $('#tool-import-preview').innerHTML = `<div class="tool-import-preview-heading"><strong>Servers to add</strong><span>Existing servers stay as they are.</span></div>${state.importPreview.map(entry => `<article class="tool-import-preview-row"><div><strong>${escape(entry.name)}</strong><span>${entry.transport === 'http' ? 'Streamable HTTP' : 'Local process · stdio'}${entry.enabled === false ? ' · disabled' : ''}</span></div><code>${escape(entry.url || entry.command || '')}</code><small>${entry.transport === 'stdio' ? `${Number(entry.argumentCount || 0)} command arguments · ` : ''}${entry.envKeys?.length ? `${entry.envKeys.length} environment ${entry.envKeys.length === 1 ? 'value' : 'values'} · ` : ''}${entry.headerNames?.length ? `${entry.headerNames.length} HTTP ${entry.headerNames.length === 1 ? 'header' : 'headers'} · ` : ''}new ID: ${escape(entry.id)}</small></article>`).join('')}${(result.warnings || []).map(warning => `<p class="tool-import-warning">${escape(warning)}</p>`).join('')}`;
      }
    } catch (cause) { if (alive() && generation === state.generation && $('#tool-import-form') === form) { error(cause.message); $('#tool-import-count').textContent = apply ? 'No completion receipt. Check your servers before retrying.' : 'Fix the configuration, then read it again.'; } }
    finally { if (generation === state.generation) state.busy = false; if (alive() && generation === state.generation && $('#tool-import-form') === form) { controls.forEach(control => control.disabled = false); $('[data-mcp-action="import-apply"]').disabled = !state.importPreview?.length; } }
  }
  function renderEditor(entry = {}) {
    state.selected = entry; state.catalog = null; state.catalogRequest++; state.tab = 'setup'; state.query = '';
    $('#tool-connections-view').innerHTML = `<div class="tool-connection-editor-heading"><button class="button subtle" data-mcp-action="back">${icon('chevron', 13)}All servers</button><span id="tool-connection-edit-state">${entry.id ? escape(status(entry)) : 'New connection'}</span></div><div class="tool-connection-tabs" role="tablist" aria-label="Connection settings"><button role="tab" aria-selected="true" data-mcp-action="tab" data-tab="setup">Connection</button><button role="tab" aria-selected="false" data-mcp-action="tab" data-tab="tools"${entry.id && entry.enabled !== false ? '' : ' disabled'}>Tool catalog${entry.connected ? ` · ${Number(entry.toolCount || 0)}` : ''}</button></div><div id="tool-connections-error" class="tool-connections-error error-text" role="alert"></div><div class="tool-connection-editor-panels"><form id="tool-connection-form" class="tool-connection-form" autocomplete="off"><div class="tool-connection-form-scroll"><div class="tool-connection-form-row"><label class="field"><span class="field-label">Server name</span><input name="name" required maxlength="120" value="${escape(entry.name || '')}" placeholder="A name you’ll recognize"></label><label class="field"><span class="field-label">Connection type</span><select name="transport"><option value="stdio"${entry.transport === 'http' ? '' : ' selected'}>Local process · stdio</option><option value="http"${entry.transport === 'http' ? ' selected' : ''}>Streamable HTTP</option></select></label></div><div id="tool-connection-local"${entry.transport === 'http' ? ' hidden' : ''}><label class="field"><span class="field-label">Executable</span><input name="command" maxlength="2000" spellcheck="false" value="${escape(entry.command || '')}" placeholder="npx, python, node, or a full executable path"><span class="field-help">BLACKICE starts this program directly. It must speak MCP over standard input and output.</span></label><label class="field"><span class="field-label">Arguments · one per line</span><textarea name="args" rows="4" spellcheck="false" placeholder="-y&#10;package-name&#10;C:\\path with spaces">${escape((entry.args || []).join('\n'))}</textarea><span class="field-help">Each line is one argument. Keep paths with spaces on one line; do not add shell quotes.</span></label><label class="field"><span class="field-label">Working folder · optional</span><input name="cwd" spellcheck="false" value="${escape(entry.cwd || '')}" placeholder="Absolute folder path"><span class="field-help">Leave blank to use BLACKICE’s server folder.</span></label></div><div id="tool-connection-http"${entry.transport === 'http' ? '' : ' hidden'}><label class="field"><span class="field-label">MCP endpoint</span><input name="url" type="url" spellcheck="false" value="${escape(entry.url || '')}" placeholder="https://your-server.example/mcp"><span class="field-help">Use the server’s Streamable HTTP endpoint. OAuth sign-in is not available in this version.</span></label></div><details class="tool-connection-credentials"><summary>Credentials & environment<span>${escape(storage(entry))}</span></summary><p>Saved values never come back to this screen. Leave a field blank to keep it. Enter <code>{}</code> to remove all saved values in that field.</p><label class="field"><span class="field-label">Environment variables · JSON object</span><textarea name="env" rows="3" spellcheck="false" autocomplete="off" placeholder='{"API_KEY":"your-key"}'></textarea><span class="field-help">${entry.envKeys?.length ? `Saved names: ${escape(entry.envKeys.join(', '))}. ` : ''}Used by local processes. Entering an object replaces this entire group.</span></label><label class="field"><span class="field-label">HTTP headers · JSON object</span><textarea name="headers" rows="3" spellcheck="false" autocomplete="off" placeholder='{"Authorization":"Bearer your-token"}'></textarea><span class="field-help">${entry.headerNames?.length ? `Saved names: ${escape(entry.headerNames.join(', '))}. ` : ''}Used by HTTP servers. Entering an object replaces this entire group.</span></label></details><div class="tool-connection-form-row tool-connection-options"><label class="field"><span class="field-label">Tool timeout · seconds</span><input name="timeoutSeconds" type="number" required min="1" max="180" step="1" value="${Math.round((entry.timeoutMs || 30000) / 1000)}"></label><label class="tool-connection-enabled"><input name="enabled" type="checkbox"${entry.enabled === false ? '' : ' checked'}>Enabled connection</label></div>${entry.agentUnavailableReason ? `<p class="field-help">${escape(entry.agentUnavailableReason)}</p>` : ''}${entry.busy ? '<p class="field-help">This server is doing work. Finish or stop its active agent task before editing this connection.</p>' : ''}<p id="tool-connection-receipt" class="tool-connection-receipt" role="status"></p></div><div class="tool-connection-save-row">${entry.id ? `<button class="button subtle" type="button" data-mcp-action="remove"${entry.busy ? ' disabled' : ''}>Remove server</button>` : '<span></span>'}<div><button class="button" type="submit"${entry.busy ? ' disabled' : ''}>${icon('save', 13)}Save</button><button class="button primary" type="button" data-mcp-action="save-connect"${entry.busy ? ' disabled' : ''}>Save & connect</button></div></div></form><section id="tool-connection-catalog" class="tool-connection-catalog" aria-label="Available tools" hidden><div class="tool-connection-search"><label class="tool-connection-search-input">${icon('search', 14)}<input id="tool-connection-query" type="search" maxlength="256" placeholder="Find a tool by name or purpose" aria-label="Search connected tools"></label><button class="button" data-mcp-action="search">Search</button><button class="icon-button" data-mcp-action="catalog-refresh" title="Refresh tool catalog" aria-label="Refresh tool catalog">${icon('refresh', 14)}</button></div><div id="tool-connection-tools" class="tool-connection-tools"><p class="field-help">Open the catalog to connect and read this server’s real tools.</p></div><div class="tool-connection-catalog-footer"><span>Agents discover matching schemas as needed. Opening this catalog does not run a tool.</span><button class="button" data-mcp-action="tab" data-tab="setup">Connection settings</button></div></section></div>`;
    bind(); transportChanged();
    $('#tool-connection-form').onsubmit = event => { event.preventDefault(); save(false); };
    $('#tool-connection-form').elements.transport.onchange = transportChanged;
    $('#tool-connection-query').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); loadTools(); } };
    $('#tool-connection-form').elements.name.focus({ preventScroll: true });
  }
  function transportChanged() {
    const form = $('#tool-connection-form'); if (!form) return;
    const http = form.elements.transport.value === 'http';
    $('#tool-connection-local').hidden = http; $('#tool-connection-http').hidden = !http;
    form.elements.command.required = !http; form.elements.url.required = http;
    // Hidden transport fields must not block native validation.
    form.elements.command.disabled = http; form.elements.url.disabled = !http;
  }
  function setTab(tab) {
    state.tab = tab;
    $('#tool-connection-form').hidden = tab !== 'setup'; $('#tool-connection-catalog').hidden = tab !== 'tools';
    document.querySelectorAll('.tool-connection-tabs [role="tab"]').forEach(button => { button.setAttribute('aria-selected', String(button.dataset.tab === tab)); });
    if (tab === 'tools' && !state.catalog) loadTools();
  }
  async function loadTools({ reconnect = false } = {}) {
    const entry = state.selected; if (!entry?.id) return;
    state.query = $('#tool-connection-query')?.value.trim() || '';
    const request = ++state.catalogRequest, generation = state.generation;
    $('#tool-connection-tools').innerHTML = '<p class="tool-connection-loading" role="status">Connecting and reading the tool catalog…</p>'; error('');
    try {
      if (reconnect) await api(`${endpoint(entry.id)}/connect`, 'POST', { reconnect: true });
      const data = await api(`${endpoint(entry.id)}/tools?query=${encodeURIComponent(state.query)}`);
      if (!alive() || request !== state.catalogRequest || generation !== state.generation || state.selected?.id !== entry.id) return;
      state.catalog = data;
      $('#tool-connection-edit-state').textContent = `Connected · ${Number(data.total || 0).toLocaleString()} tools`;
      $('#tool-connection-tools').innerHTML = `<p class="tool-connection-catalog-count">${Number(data.returned ?? data.tools?.length ?? 0).toLocaleString()} of ${Number(data.matches ?? data.total ?? 0).toLocaleString()} ${state.query ? 'matching ' : ''}tools${data.truncated ? ' · narrow your search for more' : ''}</p>${(data.tools || []).map(tool => `<article class="tool-connection-tool"><div><strong>${escape(tool.annotations?.title || tool.title || tool.name)}</strong>${tool.annotations?.readOnlyHint === true ? '<span class="tool-connection-tool-hint">Read only</span>' : ''}</div>${tool.annotations?.title || tool.title ? `<code>${escape(tool.name)}</code>` : ''}${tool.description ? `<p>${escape(tool.description)}</p>` : ''}<details><summary>Input schema</summary><pre>${escape(JSON.stringify(tool.inputSchema || {}, null, 2))}</pre></details></article>`).join('') || `<div class="tool-connection-no-tools"><strong>${state.query ? 'No tools match that search.' : 'This server reports no tools.'}</strong><p>${state.query ? 'Try a shorter tool name or another description.' : 'Check the server configuration, then refresh the catalog.'}</p></div>`}`;
    } catch (cause) { if (alive() && request === state.catalogRequest && generation === state.generation) { $('#tool-connection-tools').innerHTML = '<p class="field-help">The catalog could not be loaded. Check the connection, then try again.</p>'; error(cause.message); } }
  }
  async function save(connect) {
    const form = $('#tool-connection-form'); if (!form || state.busy || !form.reportValidity()) return;
    let value; try { const values = Object.fromEntries(new FormData(form)); value = toolConnectionPayload({ ...values, enabled: form.elements.enabled.checked }, state.selected); if (connect && !value.enabled) throw new Error('Enable “Available to agents” to connect this server.'); } catch (cause) { error(cause.message); return; }
    state.busy = true; error(''); const generation = state.generation, buttons = [...form.querySelectorAll('button')]; buttons.forEach(button => button.disabled = true);
    const controls = [...form.querySelectorAll('input,textarea,select')], disabled = controls.map(control => control.disabled); controls.forEach(control => control.disabled = true);
    try {
      const saved = await api('/api/connections', 'POST', value);
      if (!alive() || generation !== state.generation || $('#tool-connection-form') !== form) return;
      form.elements.env.value = ''; form.elements.headers.value = ''; state.selected = saved; state.catalog = null;
      const existing = state.entries.findIndex(entry => entry.id === saved.id); if (existing >= 0) state.entries[existing] = saved; else state.entries.push(saved);
      $('#tool-connection-receipt').textContent = `Saved. ${storage(saved)}.`;
      $('#tool-connection-edit-state').textContent = status(saved);
      const catalogButton = document.querySelector('.tool-connection-tabs [data-tab="tools"]'); catalogButton.disabled = !saved.enabled;
      if (connect) {
        $('#tool-connection-receipt').textContent = 'Saved. Connecting to the server…';
        const connected = await api(`${endpoint(saved.id)}/connect`, 'POST', {});
        if (!alive() || generation !== state.generation || $('#tool-connection-form') !== form || state.selected?.id !== saved.id) return;
        state.selected = connected; $('#tool-connection-edit-state').textContent = status(connected);
        $('#tool-connection-receipt').textContent = `Connected · ${Number(connected.toolCount || 0)} tools available. ${storage(connected)}.`;
        toast('Tool server connected.'); setTab('tools');
      } else toast('Tool connection saved.');
    } catch (cause) { if (alive() && generation === state.generation && $('#tool-connection-form') === form) error(cause.message); }
    finally { if (generation === state.generation) state.busy = false; if (alive() && generation === state.generation && $('#tool-connection-form') === form) { buttons.forEach(button => button.disabled = false); controls.forEach((control, index) => control.disabled = disabled[index]); } }
  }
  async function connectionAction(action, id) {
    if (state.busy) return; state.busy = true; error(''); const generation = state.generation;
    const buttons = [...($('#tool-connections-view')?.querySelectorAll('button') || [])]; buttons.forEach(button => button.disabled = true);
    try {
      if (action === 'remove') await api(endpoint(id), 'DELETE', {});
      else await api(`${endpoint(id)}/${action === 'reconnect' ? 'connect' : action}`, 'POST', action === 'reconnect' ? { reconnect: true } : {});
      if (alive() && generation === state.generation) { toast(action === 'remove' ? 'Tool server removed.' : action === 'disconnect' ? 'Tool server disconnected.' : 'Tool server connected.'); await loadList(); }
    } catch (cause) { if (alive() && generation === state.generation) { error(cause.message); buttons.forEach(button => button.disabled = false); } }
    finally { if (generation === state.generation) state.busy = false; }
  }
  function bind() {
    $('#tool-connections-view').onclick = event => {
      const button = event.target.closest('[data-mcp-action]'); if (!button || button.disabled) return;
      const action = button.dataset.mcpAction, id = button.dataset.id || state.selected?.id;
      if (action === 'done') closeModal();
      if (action === 'new') renderEditor();
      if (action === 'import') renderImport();
      if (action === 'import-file') $('#tool-import-file')?.click();
      if (action === 'import-apply') importConfiguration(true);
      if (action === 'edit' || action === 'tools') { const entry = state.entries.find(item => item.id === id); if (entry) { renderEditor(entry); if (action === 'tools') setTab('tools'); } }
      if (action === 'refresh' || action === 'back') loadList();
      if (action === 'tab') setTab(button.dataset.tab);
      if (action === 'search' || action === 'catalog-refresh') loadTools({ reconnect: action === 'catalog-refresh' });
      if (action === 'save-connect') save(true);
      if (['connect', 'disconnect', 'reconnect', 'remove'].includes(action)) connectionAction(action, id);
    };
  }
  document.addEventListener('click', event => { if (alive() && event.target.closest('[data-action="close-modal"]')) clearSensitiveFields(); }, true);
  document.addEventListener('keydown', event => { if (alive() && event.key === 'Escape') clearSensitiveFields(); }, true);
  return {
    async open() { clearSensitiveFields(); state.generation++; state.busy = false; state.selected = null; showModal('tool-connections', `${header()}<div id="tool-connections-view" class="tool-connections-workspace"><p class="tool-connection-loading" role="status">Loading your tool servers…</p></div>`, true); $('#modal-root .modal')?.classList.add('tool-connections-modal'); await loadList(); },
    close() { clearSensitiveFields(); state.generation++; state.catalogRequest++; closeModal(); }
  };
}
