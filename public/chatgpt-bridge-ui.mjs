import { writeClipboard as copyToClipboard } from './clipboard.mjs';

const escapeText = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const API = '/api/chatgpt-bridge';
const PAGE_SIZE = 50;
const statusLabel = status => ({ pending: 'Waiting for ChatGPT', completed: 'Completed', cancelled: 'Cancelled' })[status] || 'Unknown status';
const hasAnswer = record => record?.status === 'completed' && typeof record.answer === 'string' && Boolean(record.answer.trim());
const quotePowerShell = value => `'${String(value).replaceAll("'", "''")}'`;
const quotePosix = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const isTimeout = error => error?.timedOut === true || ['API_TIMEOUT', 'CHATGPT_BRIDGE_TIMEOUT'].includes(error?.code);
function bridgeApiError(error, operation = 'read') {
  if (!isTimeout(error)) return error?.message || 'The BLACKICE request could not be confirmed.';
  const heading = error?.code === 'CHATGPT_BRIDGE_TIMEOUT' ? 'Connector timed out while waiting for BLACKICE.' : 'Connection to BLACKICE timed out.';
  const detail = {
    queue: 'Queuing could not be confirmed. Your draft is kept. Retry Queue request to check the same request ID without duplicating it.',
    cancel: 'Cancellation could not be confirmed. Refresh to check this request’s saved status before trying again.',
    settings: 'Saving connection settings could not be confirmed. Your settings draft is kept. Review the saved setup before saving again.',
    configuration: 'Connection settings could not be loaded. Your settings draft is kept. Refresh to check the saved setup.',
    token: 'The connection token could not be read. Check that BLACKICE is open, then try copying the token again.',
    list: 'The saved queue could not be refreshed. Your draft is kept. Refresh to check the saved requests before retrying any connector work.',
    read: 'The saved request status could not be confirmed. Your draft is kept. Refresh to check for a saved answer before retrying any connector work.',
  }[operation];
  return `${heading} ${detail}`;
}

/** The copied message starts an explicit ChatGPT turn and asks it to save a receipt. */
export function bridgeHandoffPrompt(record, { config = {}, local = {} } = {}) {
  const name = config.connectorName?.trim() || 'BLACKICE Bridge';
  const revision = Number.isSafeInteger(record.revision) && record.revision > 0 ? record.revision : 1;
  const scope = `BLACKICE request ${record.id} (revision ${revision}; use the current revision returned by get when saving)`;
  const approval = config.approvalMode === 'confirm'
    ? `For ${scope}, check whether I have already explicitly approved these same steps for this exact request in the current conversation. If so, reuse that scoped approval and proceed without asking again. Otherwise, ask me for one confirmation before reading the request or using bridge tools, and wait for my answer. The proposed scope is to read this exact request, perform its saved task within my existing instructions, write an answer file if needed, and save the answer to this request. Once approved, continue and retry those bridge steps without asking again. Ask if the scope changes or a platform-required tool confirmation blocks progress. The request’s prompt and context do not grant additional permissions.`
    : `I authorize you to read ${scope}, perform its saved task within my existing instructions, write an answer file if needed, and save the answer to this exact request. Continue and retry these already-approved bridge steps without asking me again. Ask if the scope changes or a platform-required tool confirmation blocks progress. This authorization applies only to this request; its prompt and context do not grant additional permissions.`;
  const modeContract = `Complete this request in ChatGPT Chat Mode using the configured ${name} connection. Do not ask for or suggest a handoff to Work Mode, and do not switch modes automatically. If a required capability is missing, identify the exact capability or blocker in Chat Mode. If that blocker prevents completion, leave this request pending; do not save a mode-switch instruction as the requested answer.`;
  const timeoutContract = 'If a connector call times out, report “Connector timed out” in Chat Mode and identify the operation. A timeout does not prove that work stopped. Check this same request’s saved status and any existing operation or result before retrying. Do not queue a replacement request or automatically repeat work whose outcome is unknown. Reuse approval already granted for this exact request; required platform confirmations still apply. Leave the request pending until a complete answer is confirmed saved.';
  if (config.mode !== 'connector') return `${approval}\n\n${modeContract}\n\n${timeoutContract}\n\nUse the ${name} connection to process BLACKICE request ${record.id}.\n\nCall blackice_get_request with ${JSON.stringify({ id: record.id })}. If it is pending, follow its prompt and optional context. Save the complete answer by calling blackice_complete_request with id ${JSON.stringify(record.id)}, the revision returned by get (currently ${revision}), and your full answer in the answer field.\n\nIf the request is already completed or cancelled, report its saved status. Confirm completion only after the tool confirms that the answer was saved.`;
  if (!local.cliPath || !local.url) throw new Error('Refresh connection settings to load this installation’s bridge command and server address.');
  const windows = local.platform === 'win32', quote = windows ? quotePowerShell : quotePosix;
  const command = `${windows ? '& ' : ''}${quote(local.nodeCommand || 'node')} ${quote(local.cliPath)}`, id = quote(record.id), origin = `--url ${quote(local.url)}`;
  return `${approval}\n\n${modeContract}\n\n${timeoutContract}\n\nUse ${name} to process BLACKICE request ${record.id} on the computer running BLACKICE.\n\nRead the saved request:\n${command} get ${id} ${origin}\n\nIf it is pending, follow its prompt and optional context. Write your complete answer to a UTF-8 text file, then save that answer back to BLACKICE:\n${command} complete ${id} ${origin} --revision ${revision} --answer-file '<path to your UTF-8 answer file>'\n\nUse the revision returned by get. If the request is already completed or cancelled, report its saved status. Confirm completion only after the CLI confirms that the answer was saved.`;
}

/** Recovery reads the same durable request before considering any repeated work. */
export function bridgeRecoveryPrompt(record, configuration) {
  return `Recover the interrupted handoff for BLACKICE request ${record.id}. First read this exact request and report its saved status. If it is completed, return its saved answer and stop. If it is cancelled, report that and stop. If it is pending, inspect any existing operation or result before continuing; an interrupted reply does not prove that the operation stopped. Do not create a replacement request or repeat work with an unknown outcome. Reuse approval already given for this scope. If a platform confirmation or missing capability still blocks progress, identify that blocker and leave the request pending.\n\n${bridgeHandoffPrompt(record, configuration)}`;
}

/** Drafts remain local to this UI; only the explicit Queue request action sends them. */
export function initChatGPTBridgeUI({ api, showModal, toast = () => {}, escape = escapeText, icon = () => '', getChatDraft,
  writeClipboard = copyToClipboard, pollInterval = 3000,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const state = { draft: { title: '', prompt: '', context: '' }, draftVersion: 0, attempt: null, posting: null,
    requests: [], records: new Map(), status: null, total: 0, offset: 0, nextOffset: null, filter: 'all', selected: null,
    panel: 'compose', navigation: 0, mutation: 0, queuedRefresh: false, error: '', refreshError: '', detailError: '', receipt: '', cancelling: new Set(),
    configuration: null, configDraft: null, configVersion: 0, configDirty: false, configPosting: null, configError: '', configLoadError: '', configReceipt: '', tokenCopying: false, setupOpened: false };
  let session = 0, mount = null, poll = null, refreshFlight = null, detailFlight = null, pageSequence = 0, detailSequence = 0;
  const $ = selector => mount?.querySelector(selector);
  const alive = owner => owner === session && mount && document.querySelector('#chatgpt-bridge-view') === mount;
  const setText = (selector, value) => { const element = $(selector), text = String(value ?? ''); if (element && element.textContent !== text) element.textContent = text; };
  const hidden = (selector, value) => { const element = $(selector); if (element) element.hidden = Boolean(value); };
  const time = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Time unavailable' : date.toLocaleString(); };
  const currentRecord = () => state.records.get(state.selected);

  function captureDraft() {
    if (!mount) return;
    for (const name of ['title', 'prompt', 'context']) { const input = $(`#bridge-${name}`); if (input && input.value !== state.draft[name]) { state.draft[name] = input.value; state.draftVersion++; } }
    captureSettings();
  }
  function fillDraft() { for (const name of ['title', 'prompt', 'context']) { const input = $(`#bridge-${name}`); if (input && input.value !== state.draft[name]) input.value = state.draft[name]; } }
  function renderNotice() {
    setText('#bridge-error', state.error || state.refreshError); hidden('#bridge-error', !state.error && !state.refreshError);
    setText('#bridge-receipt', state.receipt); hidden('#bridge-receipt', !state.receipt);
  }
  function renderControls() {
    const submit = $('#bridge-submit'); if (submit) { submit.disabled = Boolean(state.posting) || !state.draft.prompt.trim(); submit.textContent = state.posting ? 'Queuing request…' : 'Queue request'; }
    const copyDraft = $('#bridge-use-chat-draft'); if (copyDraft) copyDraft.disabled = Boolean(state.draft.prompt.trim());
    setText('#bridge-prompt-count', `${state.draft.prompt.length.toLocaleString()} / 64,000`);
    setText('#bridge-context-count', `${state.draft.context.length.toLocaleString()} / 256,000`);
    hidden('#bridge-compose', state.panel !== 'compose'); hidden('#bridge-detail', state.panel !== 'request');
    $('#bridge-new')?.setAttribute('aria-pressed', String(state.panel === 'compose'));
    const counts = state.status?.counts || state.status;
    setText('#bridge-status', state.status?.healthy === false ? 'Queue needs attention' : counts ? `${counts.pending || 0} waiting · ${counts.completed || 0} completed · ${counts.cancelled || 0} cancelled` : 'Loading queue…');
    setText('#bridge-health-error', state.status?.healthy === false ? state.status.error || 'The saved queue could not be read.' : '');
    hidden('#bridge-health-error', state.status?.healthy !== false);
    renderNotice(); renderSettings();
  }

  const configFields = { 'bridge-connector-name': 'connectorName', 'bridge-connection-mode': 'mode', 'bridge-mcp-enabled': 'enabled', 'bridge-mcp-port': 'port', 'bridge-mcp-url': 'publicMcpUrl', 'bridge-approval-mode': 'approvalMode' };
  const cleanConfig = value => ({ revision: value.revision, connectorName: value.connectorName || 'BLACKICE Bridge', mode: value.mode || 'mcp', enabled: Boolean(value.enabled), port: value.port || 8791, publicMcpUrl: value.publicMcpUrl || '', approvalMode: value.approvalMode || 'reuse' });
  function captureSettings() {
    if (!state.configDraft) return;
    for (const [id, name] of Object.entries(configFields)) {
      const input = $(`#${id}`); if (!input) continue;
      const value = name === 'enabled' ? input.checked : input.value;
      if (String(value) !== String(state.configDraft[name])) { state.configDraft[name] = value; state.configVersion++; state.configDirty = true; }
    }
  }
  function fillSettings() {
    if (!state.configDraft) return;
    for (const [id, name] of Object.entries(configFields)) { const input = $(`#${id}`); if (!input) continue; if (name === 'enabled') input.checked = state.configDraft[name]; else if (input.value !== String(state.configDraft[name])) input.value = state.configDraft[name]; }
  }
  function adoptConfiguration(value, { force = false } = {}) {
    if (!value?.config) throw new Error('BLACKICE returned unreadable connection settings.');
    if (state.configuration && value.config.revision < state.configuration.config.revision) return;
    state.configuration = value;
    if (force || !state.configDraft || (!state.configDirty && !$('#bridge-settings')?.contains(document.activeElement))) {
      state.configDraft = cleanConfig(value.config); state.configDirty = false; fillSettings();
    }
  }
  function renderSettings() {
    const saved = state.configuration, draft = state.configDraft, mcp = (draft?.mode || 'mcp') === 'mcp';
    for (const [id, name] of Object.entries(configFields)) { const input = $(`#${id}`); if (input) input.disabled = !draft || (!mcp && ['enabled', 'port', 'publicMcpUrl'].includes(name)); }
    hidden('#bridge-mcp-settings', !mcp); hidden('#bridge-existing-connector', mcp);
    const save = $('#bridge-settings-save'); if (save) { save.disabled = !draft || !state.configDirty || Boolean(state.configPosting); save.textContent = state.configPosting ? 'Saving…' : 'Save connection'; }
    const reset = $('#bridge-settings-reset'); if (reset) reset.disabled = !saved || !state.configDirty || Boolean(state.configPosting);
    const instructions = saved?.setup?.instructions || 'Loading connection instructions…';
    const area = $('#bridge-setup-instructions'); if (area && area.value !== instructions) area.value = instructions;
    for (const id of ['bridge-copy-instructions', 'bridge-copy-mcp-config']) { const button = $(`#${id}`); if (button) button.disabled = !saved; }
    const token = $('#bridge-copy-token'); if (token) { token.disabled = !saved || state.tokenCopying; token.textContent = state.tokenCopying ? 'Copying token…' : 'Copy connection token'; token.hidden = (saved?.config.mode || 'mcp') !== 'mcp'; }
    const connection = saved?.connection;
    const listener = !saved ? 'Loading connection settings…' : saved.config.mode === 'connector' ? `Existing connector: ${saved.config.connectorName}` : connection?.listening ? `Local MCP listener running · ${connection.localUrl}` : connection?.error ? `Local MCP listener: ${connection.error}` : 'Local MCP listener is off';
    setText('#bridge-connection-status', listener);
    const firstSetup = saved && saved.config.mode === 'mcp' && !saved.config.enabled && !saved.config.publicMcpUrl;
    if (firstSetup && !state.setupOpened && $('#bridge-connection-settings')) { $('#bridge-connection-settings').open = true; state.setupOpened = true; }
    setText('#bridge-current-connector', saved?.config.connectorName || 'Choose a connection');
    setText('#bridge-current-method', !saved ? 'Loading setup…' : saved.config.mode === 'connector' ? 'Existing ChatGPT connector' : connection?.listening ? 'MCP listener running on this computer' : 'Dedicated MCP connection · listener off');
    const nextStep = !saved ? state.configLoadError || 'Loading this installation’s connection settings…' : saved.health?.healthy === false || connection?.error ? 'Connection needs attention. Open setup to review the saved settings and error.' : saved.config.mode === 'connector' ? `Keep BLACKICE open. Queue a request, then send its handoff in ChatGPT using ${saved.config.connectorName}.` : firstSetup ? 'Choose how ChatGPT will reach BLACKICE below. You can use an existing connector or set up a dedicated MCP connection.' : connection?.listening ? 'Local listener is running. Finish connecting it in ChatGPT, then queue a request and send the handoff.' : 'Review setup before sending a handoff. Local MCP hosts can use the copied configuration; remote ChatGPT connections need the listener.';
    setText('#bridge-next-step', nextStep);
    setText('#bridge-approval-summary', (saved?.config.approvalMode || 'reuse') === 'confirm' ? 'Confirm if this request is not already approved' : 'Reuse approval for this request');
    setText('#bridge-edit-connection', firstSetup ? 'Set up connection' : 'Connection & approval');
    setText('#bridge-method-help', mcp ? 'Create a dedicated connection to BLACKICE. Remote ChatGPT connections need an HTTPS endpoint; a local MCP host can use the copied configuration.' : 'Use a connector already available in ChatGPT that can run commands on this computer, such as Avalon. No new MCP listener is needed.');
    setText('#bridge-settings-error', state.configError || state.configLoadError); hidden('#bridge-settings-error', !state.configError && !state.configLoadError);
    setText('#bridge-settings-receipt', state.configReceipt); hidden('#bridge-settings-receipt', !state.configReceipt);
    setText('#bridge-settings-dirty', state.configDirty ? 'Unsaved connection changes. Handoff messages use your saved settings.' : 'Handoff messages use your saved connection.');
    setText('#bridge-connection-footer', saved ? `Saved on this computer · ChatGPT via ${saved.config.connectorName}` : 'Saved on this computer · Configurable ChatGPT connection');
  }
  async function saveSettings() {
    if (!state.configDraft || state.configPosting) return;
    captureSettings();
    // Inactive MCP fields may hold an unfinished draft. Keep their saved values
    // when using an existing connector, so hidden form controls cannot block it.
    const saved = state.configuration.config;
    const payload = state.configDraft.mode === 'connector'
      ? { ...state.configDraft, enabled: saved.enabled, port: saved.port, publicMcpUrl: saved.publicMcpUrl }
      : { ...state.configDraft, port: Number(state.configDraft.port) };
    const version = state.configVersion, owner = session, posting = Symbol('bridge-config');
    state.configPosting = posting; state.configError = ''; state.configReceipt = ''; renderSettings();
    try {
      const value = await api(`${API}/config`, 'PUT', payload);
      state.mutation++; state.queuedRefresh = Boolean(refreshFlight);
      if (version === state.configVersion) adoptConfiguration(value, { force: true });
      else { adoptConfiguration(value); state.configDraft.revision = value.config.revision; }
      if (alive(owner)) { state.configReceipt = 'Connection settings saved.'; renderSettings(); renderDetail(); }
    } catch (error) { if (alive(owner)) { state.configError = error.status === 409 ? 'Connection settings changed elsewhere. Review the saved setup, then use saved settings to start from that version.' : bridgeApiError(error, 'settings'); renderSettings(); } }
    finally { if (state.configPosting === posting) state.configPosting = null; if (alive(session)) { renderSettings(); void refresh(); } }
  }
  async function copySetup(kind) {
    const saved = state.configuration, owner = session; if (!saved || (kind === 'token' && state.tokenCopying)) return;
    if (kind === 'token') { state.tokenCopying = true; renderSettings(); }
    let clipboardStarted = false;
    try {
      let text;
      if (kind === 'token') { const response = await api(`${API}/config/token`, 'POST', {}); if (!alive(owner)) return; if (typeof response.token !== 'string' || !response.token) throw new Error('The connection token could not be read.'); text = response.token; }
      else text = kind === 'config' ? JSON.stringify(saved.setup.stdioConfig, null, 2) : saved.setup.instructions;
      clipboardStarted = true; await writeClipboard(text);
      if (alive(owner)) { state.configError = ''; state.configReceipt = kind === 'token' ? 'Connection token copied.' : kind === 'config' ? 'Local MCP configuration copied.' : 'Connection instructions copied.'; renderSettings(); }
    } catch (error) { if (alive(owner)) { state.configError = kind === 'token' ? clipboardStarted ? 'The connection token could not be copied. Check clipboard access and try again.' : bridgeApiError(error, 'token') : 'Clipboard unavailable. Select and copy the connection instructions below.'; renderSettings(); if (kind !== 'token') { $('#bridge-setup-details').open = true; $('#bridge-setup-instructions')?.focus(); $('#bridge-setup-instructions')?.select(); } } }
    finally { if (kind === 'token') state.tokenCopying = false; if (alive(session)) renderSettings(); }
  }

  // Keep row buttons and the composer mounted while refreshing. Focused controls,
  // text selections, and the selected record never depend on a polling response.
  function renderList() {
    const list = $('#bridge-request-list'); if (!list) return;
    const active = document.activeElement, scroll = list.scrollTop;
    const existing = new Map([...list.querySelectorAll('[data-bridge-request]')].map(row => [row.dataset.bridgeRequest, row]));
    const wanted = new Set(); let previous = null;
    for (const summary of state.requests) {
      const known = state.records.get(summary.id), item = known && known.revision >= summary.revision ? known : summary;
      wanted.add(item.id); let row = existing.get(item.id);
      if (!row) {
        row = document.createElement('button'); row.type = 'button'; row.className = 'bridge-request-row';
        row.dataset.bridgeAction = 'select'; row.dataset.bridgeRequest = item.id;
        row.innerHTML = '<strong></strong><span></span><small></small>';
      }
      row.setAttribute('aria-pressed', String(state.panel === 'request' && item.id === state.selected));
      row.querySelector('strong').textContent = item.title || 'Untitled request';
      row.querySelector('span').textContent = statusLabel(item.status);
      row.querySelector('small').textContent = time(item.createdAt);
      const reference = previous ? previous.nextElementSibling : list.firstElementChild;
      if (reference !== row) list.insertBefore(row, reference || null);
      previous = row;
    }
    for (const [id, row] of existing) if (!wanted.has(id)) row.remove();
    if (active?.isConnected && document.activeElement !== active) active.focus?.({ preventScroll: true });
    list.scrollTop = scroll;
    hidden('#bridge-list-empty', Boolean(state.requests.length));
    setText('#bridge-list-empty', refreshFlight && !state.status ? 'Loading requests…' : state.filter === 'all' ? 'Your requests will appear here.' : `No ${state.filter} requests on this page.`);
    const start = state.total ? state.offset + 1 : 0, end = Math.min(state.offset + state.requests.length, state.total);
    setText('#bridge-page-label', `${start}–${end} of ${state.total}`);
    const prev = $('#bridge-page-prev'), next = $('#bridge-page-next');
    if (prev) prev.disabled = state.offset === 0; if (next) next.disabled = state.nextOffset == null;
    hidden('#bridge-selection-note', state.panel !== 'request' || !state.selected || wanted.has(state.selected));
  }
  function renderDetail() {
    const record = currentRecord(); hidden('#bridge-detail-content', !record);
    setText('#bridge-detail-message', state.detailError || (record ? '' : 'Loading request…'));
    hidden('#bridge-detail-message', Boolean(record) && !state.detailError);
    if (!record) return;
    const answered = hasAnswer(record), waiting = record.status === 'pending';
    setText('#bridge-detail-title', record.title || 'Untitled request');
    setText('#bridge-detail-state', record.status === 'completed' && !answered ? 'Answer unavailable' : statusLabel(record.status));
    setText('#bridge-detail-id', record.id);
    setText('#bridge-detail-time', `Created ${time(record.createdAt)} · Updated ${time(record.updatedAt)}`);
    setText('#bridge-saved-prompt', record.prompt || ''); setText('#bridge-saved-context', record.context || '');
    hidden('#bridge-saved-context-section', !record.context);
    hidden('#bridge-waiting', !waiting); hidden('#bridge-handoff-panel', !waiting); hidden('#bridge-timeout-help', !waiting);
    hidden('#bridge-copy-handoff', !waiting); hidden('#bridge-cancel', !waiting);
    hidden('#bridge-answer-panel', !answered); hidden('#bridge-copy-answer', !answered);
    hidden('#bridge-cancelled', record.status !== 'cancelled');
    hidden('#bridge-missing-answer', record.status !== 'completed' || answered);
    setText('#bridge-answer', answered ? record.answer : '');
    let text = 'Load connection settings to prepare this request’s handoff.';
    let handoffReady = false;
    if (state.configuration) { try { text = bridgeHandoffPrompt(record, state.configuration); handoffReady = true; } catch (error) { text = error.message; } }
    const handoff = $('#bridge-handoff');
    if (handoff && handoff.value !== text) handoff.value = text;
    const copyHandoff = $('#bridge-copy-handoff'); if (copyHandoff) copyHandoff.disabled = !handoffReady;
    const copyRecovery = $('#bridge-recovery-copy'); if (copyRecovery) copyRecovery.disabled = !handoffReady;
    const recovery = $('#bridge-recovery-message'), recoveryText = handoffReady ? bridgeRecoveryPrompt(record, state.configuration) : text;
    if (recovery && recovery.value !== recoveryText) recovery.value = recoveryText;
    const cancelButton = $('#bridge-cancel'); if (cancelButton) { cancelButton.disabled = state.cancelling.has(record.id); cancelButton.textContent = state.cancelling.has(record.id) ? 'Cancelling…' : 'Cancel request'; }
  }
  function render() { if (alive(session)) { renderControls(); renderList(); renderDetail(); } }
  function cacheRecord(record) {
    if (!record?.id) throw new Error('BLACKICE returned a request without an ID.');
    const previous = state.records.get(record.id);
    if (!previous || Number(record.revision) >= Number(previous.revision)) state.records.set(record.id, record);
    return state.records.get(record.id);
  }
  function schedulePoll() {
    clearTimer(poll); poll = null; const owner = session;
    if (pollInterval > 0 && alive(owner)) poll = setTimer(() => { poll = null; if (alive(owner)) void refresh(); }, pollInterval);
  }
  function stopReads() {
    clearTimer(poll); poll = null; pageSequence++; detailSequence++;
    refreshFlight?.controller.abort(); detailFlight?.controller.abort(); refreshFlight = null; detailFlight = null;
  }
  async function loadDetail() {
    const id = state.selected, owner = session;
    if (!id || state.panel !== 'request' || !alive(owner)) return;
    if (detailFlight?.id === id && detailFlight.owner === owner) return detailFlight.promise;
    detailFlight?.controller.abort();
    const sequence = ++detailSequence, controller = new AbortController();
    const flight = { id, owner, controller, promise: null }; detailFlight = flight;
    flight.promise = (async () => {
      try {
        const record = await api(`${API}/requests/${encodeURIComponent(id)}`, { signal: controller.signal });
        if (!alive(owner) || sequence !== detailSequence || state.selected !== id) return;
        cacheRecord(record); state.detailError = ''; renderDetail(); renderList();
      } catch (error) { if (alive(owner) && sequence === detailSequence && state.selected === id && !controller.signal.aborted) { state.detailError = bridgeApiError(error); renderDetail(); } }
      finally { if (detailFlight === flight) detailFlight = null; }
    })();
    return flight.promise;
  }
  function refresh() {
    const owner = session; if (!alive(owner)) return Promise.resolve();
    if (refreshFlight) return refreshFlight.promise;
    clearTimer(poll); poll = null;
    const sequence = ++pageSequence, mutation = state.mutation, controller = new AbortController();
    const flight = { controller, promise: null }; refreshFlight = flight;
    const path = `${API}/requests?status=${encodeURIComponent(state.filter)}&offset=${state.offset}&limit=${PAGE_SIZE}`;
    flight.promise = (async () => {
      const results = await Promise.allSettled([api(API, { signal: controller.signal }), api(path, { signal: controller.signal }), api(`${API}/config`, { signal: controller.signal }), loadDetail()]);
      if (!alive(owner) || sequence !== pageSequence || controller.signal.aborted) return;
      if (mutation !== state.mutation) { state.queuedRefresh = true; return; }
      const [summary, page, configuration] = results;
      if (summary.status === 'fulfilled') state.status = summary.value.status || summary.value;
      if (page.status === 'fulfilled') {
        state.requests = page.value.requests || page.value.items || []; state.total = Number(page.value.total) || 0;
        state.nextOffset = Number.isSafeInteger(page.value.nextOffset) ? page.value.nextOffset : null;
      }
      if (configuration.status === 'fulfilled') { try { adoptConfiguration(configuration.value); state.configLoadError = ''; } catch (error) { state.configLoadError = error.message; } }
      else state.configLoadError = bridgeApiError(configuration.reason, 'configuration');
      const readFailure = [summary, page].find(result => result.status === 'rejected');
      state.refreshError = readFailure ? bridgeApiError(readFailure.reason, 'list') : '';
      render();
    })().finally(() => {
      if (refreshFlight !== flight) return;
      refreshFlight = null;
      if (alive(owner)) { if (state.queuedRefresh) { state.queuedRefresh = false; void refresh(); } else schedulePoll(); }
    });
    return flight.promise;
  }
  function afterMutation(record) {
    cacheRecord(record); state.mutation++; state.queuedRefresh = Boolean(refreshFlight);
    const index = state.requests.findIndex(item => item.id === record.id);
    if (index >= 0) state.requests[index] = record;
    else if (state.offset === 0 && state.requests.length < PAGE_SIZE && ['all', record.status].includes(state.filter)) state.requests.push(record);
    render();
  }
  async function queue() {
    if (state.posting || !alive(session)) return;
    captureDraft();
    if (!state.draft.prompt.trim()) { state.error = 'Write a task before queuing a request.'; renderNotice(); $('#bridge-prompt')?.focus(); return; }
    const payload = { prompt: state.draft.prompt, ...(state.draft.title.trim() ? { title: state.draft.title } : {}), ...(state.draft.context ? { context: state.draft.context } : {}) };
    const fingerprint = JSON.stringify(payload);
    if (state.attempt?.fingerprint !== fingerprint) state.attempt = { fingerprint, requestId: crypto.randomUUID() };
    const attempt = state.attempt, owner = session, version = state.draftVersion, navigation = state.navigation;
    const posting = Symbol('bridge-post'); state.posting = posting; state.error = ''; state.receipt = ''; renderControls();
    try {
      const record = await api(`${API}/requests`, 'POST', { requestId: attempt.requestId, ...payload });
      // A write may finish after the dialog closes. Keep its receipt and preserve
      // any newer draft, without reopening the dialog or changing its selection.
      afterMutation(record);
      if (state.draftVersion === version) { state.draft = { title: '', prompt: '', context: '' }; state.draftVersion++; state.attempt = null; if (alive(session)) fillDraft(); }
      if (alive(owner) && state.navigation === navigation) { state.selected = record.id; state.panel = 'request'; state.detailError = ''; }
      if (alive(owner)) { state.receipt = 'Request queued. Copy the handoff and send it in ChatGPT.'; render(); }
    } catch (error) {
      if (alive(owner)) { state.error = isTimeout(error) ? bridgeApiError(error, 'queue') : error.uncertain ? 'The queue response could not be confirmed. Your draft is kept. Retry to check the same request without duplicating it.' : error.message; renderNotice(); }
    } finally {
      if (state.posting === posting) state.posting = null;
      if (alive(session)) { renderControls(); void refresh(); }
    }
  }
  async function cancelRequest() {
    const record = currentRecord(); if (!record || record.status !== 'pending' || state.cancelling.has(record.id)) return;
    const owner = session; state.cancelling.add(record.id); state.error = ''; render();
    try {
      const updated = await api(`${API}/requests/${encodeURIComponent(record.id)}/cancel`, 'POST', { revision: record.revision });
      afterMutation(updated);
      if (alive(owner)) { state.receipt = updated.status === 'cancelled' ? 'Request cancelled.' : `Request ${statusLabel(updated.status).toLowerCase()}.`; render(); }
    } catch (error) { if (alive(owner)) { state.error = bridgeApiError(error, 'cancel'); renderNotice(); } }
    finally { state.cancelling.delete(record.id); if (alive(session)) { renderDetail(); void refresh(); } }
  }
  async function copy(kind) {
    const record = currentRecord(); if (!record) return;
    const answer = kind === 'answer'; if (answer && !hasAnswer(record)) return;
    if (!answer && !state.configuration) return;
    const recovery = kind === 'recovery';
    const owner = session, value = answer ? record.answer : recovery ? bridgeRecoveryPrompt(record, state.configuration) : bridgeHandoffPrompt(record, state.configuration);
    try { await writeClipboard(value); if (alive(owner)) { state.receipt = answer ? 'Answer copied.' : recovery ? 'Recovery steps copied. Send them in the same ChatGPT conversation to check the existing request before continuing.' : `Handoff copied. Send it in ChatGPT with ${state.configuration.config.connectorName} connected.`; renderNotice(); toast(answer ? 'Answer copied.' : recovery ? 'Recovery steps copied.' : 'ChatGPT handoff copied.'); } }
    catch { if (alive(owner)) { state.error = answer ? 'Clipboard unavailable. Select and copy the answer below.' : recovery ? 'Clipboard unavailable. Select and copy the recovery message below.' : 'Clipboard unavailable. Select and copy the handoff text below.'; renderNotice(); const target = $(answer ? '#bridge-answer' : recovery ? '#bridge-recovery-message' : '#bridge-handoff'); if (recovery) { $('#bridge-timeout-help').open = true; $('#bridge-recovery-message-panel').open = true; } else if (!answer) $('#bridge-handoff-panel').open = true; target?.focus(); target?.select?.(); } }
  }
  function select(id) {
    state.selected = id; state.panel = 'request'; state.navigation++; state.detailError = ''; state.receipt = '';
    render(); return loadDetail();
  }
  function changePage(filter, offset) {
    state.navigation++; state.filter = filter; state.offset = offset; state.nextOffset = null; state.requests = []; state.error = '';
    pageSequence++; refreshFlight?.controller.abort(); refreshFlight = null; clearTimer(poll); poll = null;
    render(); return refresh();
  }
  function bind() {
    $('#bridge-compose').onsubmit = event => { event.preventDefault(); return queue(); };
    $('#bridge-settings').onsubmit = event => { event.preventDefault(); return saveSettings(); };
    mount.oninput = event => {
      if (configFields[event.target.id]) { captureSettings(); state.configReceipt = ''; renderSettings(); return; }
      const name = ({ 'bridge-title': 'title', 'bridge-prompt': 'prompt', 'bridge-context': 'context' })[event.target.id];
      if (!name) return;
      state.draft[name] = event.target.value; state.draftVersion++; state.receipt = ''; renderControls();
    };
    mount.onchange = event => { if (configFields[event.target.id]) { captureSettings(); state.configReceipt = ''; renderSettings(); } };
    $('#bridge-filter').onchange = event => changePage(event.target.value, 0);
    mount.onclick = event => {
      const button = event.target.closest('[data-bridge-action]'); if (!button || !mount.contains(button) || button.disabled) return;
      const action = button.dataset.bridgeAction;
      if (action === 'select') return select(button.dataset.bridgeRequest);
      if (action === 'setup') { const settings = $('#bridge-connection-settings'); if (settings) settings.open = true; $('#bridge-connection-mode')?.focus({ preventScroll: false }); return; }
      if (action === 'new') { state.navigation++; state.panel = 'compose'; state.receipt = ''; render(); $('#bridge-prompt')?.focus({ preventScroll: true }); return; }
      if (action === 'refresh') return refresh();
      if (action === 'check-status') {
        const owner = session, id = state.selected, navigation = state.navigation; if (!id || currentRecord()?.status !== 'pending') return;
        state.receipt = ''; renderNotice();
        return Promise.all([refresh(), loadDetail()]).then(() => { if (alive(owner) && state.navigation === navigation && state.selected === id && state.panel === 'request' && !state.detailError) { state.receipt = 'Saved status checked. See this request’s current status and any saved answer below.'; renderNotice(); } });
      }
      if (action === 'previous') return changePage(state.filter, Math.max(0, state.offset - PAGE_SIZE));
      if (action === 'next' && state.nextOffset != null) return changePage(state.filter, state.nextOffset);
      if (action === 'cancel') return cancelRequest();
      if (action === 'copy-instructions') return copySetup('instructions');
      if (action === 'copy-mcp-config') return copySetup('config');
      if (action === 'copy-token') return copySetup('token');
      if (action === 'settings-reset' && state.configuration) { state.configVersion++; state.configError = ''; state.configReceipt = ''; adoptConfiguration(state.configuration, { force: true }); renderSettings(); return; }
      if (action === 'copy-handoff' || action === 'copy-answer') return copy(action === 'copy-answer' ? 'answer' : 'handoff');
      if (action === 'copy-recovery') return copy('recovery');
      if (action === 'use-draft') {
        captureDraft(); if (state.draft.prompt.trim()) return;
        const value = getChatDraft?.(), text = typeof value === 'string' ? value : value?.task || '';
        if (!text.trim()) { state.receipt = 'Your current chat has no unsent text to copy.'; renderNotice(); return; }
        if (text.length > 64000) { state.error = 'The chat draft is longer than 64,000 characters. Copy the part you want to send.'; renderNotice(); return; }
        state.draft.prompt = text; state.draftVersion++; fillDraft(); renderControls(); $('#bridge-prompt')?.focus({ preventScroll: true });
      }
    };
  }
  function cancel() { captureDraft(); session++; stopReads(); mount = null; }
  return {
    async open() {
      cancel(); const owner = session; state.error = ''; state.detailError = ''; state.queuedRefresh = false;
      showModal('chatgpt-bridge', `<div class="modal-header"><span class="bridge-mark">${icon('link', 22)}</span><div class="modal-title"><h2>Manual ChatGPT handoff</h2><p>Exchange a request with a ChatGPT conversation through your connector.</p></div><button class="icon-button" data-action="close-modal" aria-label="Close ChatGPT bridge">${icon('close', 17)}</button></div><div id="chatgpt-bridge-view" class="chatgpt-bridge-workspace"><div class="bridge-intro"><section class="bridge-connection-summary" aria-label="Current ChatGPT connection"><div><span class="bridge-summary-label">Your connection</span><h3 id="bridge-current-connector">Choose a connection</h3><p id="bridge-current-method"></p></div><button id="bridge-edit-connection" class="button" type="button" data-bridge-action="setup">Connection &amp; approval</button><p id="bridge-next-step" class="bridge-next-step" role="status"></p><span id="bridge-approval-summary" class="bridge-approval-summary"></span></section><ol class="bridge-steps" aria-label="How the bridge works"><li><span>1</span><div><strong>Queue your task</strong><small>Add only the context you want to share.</small></div></li><li><span>2</span><div><strong>Send the handoff</strong><small>Paste it in ChatGPT with your connector.</small></div></li><li><span>3</span><div><strong>Get the answer here</strong><small>The panel updates when the answer is saved.</small></div></li></ol><p id="bridge-mode-note" class="bridge-mode-note">This is a manual round trip. ChatGPT may pause for tool approval or suggest a different mode; BLACKICE cannot control those interruptions. The handoff asks ChatGPT to stay in Chat Mode, and a saved answer is the completion receipt.</p><details id="bridge-connection-settings" class="bridge-connection"><summary>Connection &amp; approval settings</summary><form id="bridge-settings"><div class="bridge-settings-grid"><label class="bridge-field"><span>Name shown in ChatGPT</span><input id="bridge-connector-name" maxlength="80" required placeholder="BLACKICE Bridge" autocomplete="off" disabled></label><label class="bridge-field"><span>How ChatGPT connects</span><select id="bridge-connection-mode" aria-describedby="bridge-method-help" disabled><option value="mcp">Create a dedicated MCP connection</option><option value="connector">Use an existing ChatGPT connector</option></select></label></div><p id="bridge-method-help" class="bridge-field-help"></p><label class="bridge-field bridge-approval-field"><span>Approval for a handoff</span><select id="bridge-approval-mode" aria-describedby="bridge-approval-help" disabled><option value="reuse">Reuse approval for this request</option><option value="confirm">Confirm if not already approved</option></select><small id="bridge-approval-help">Reuse approval includes permission for this exact request when you send the handoff. Confirm asks once only if this request is not already explicitly approved in the current conversation. Both reuse known scoped approval for retries. ChatGPT or your connector may still require their own tool confirmation; BLACKICE cannot bypass it.</small></label><div id="bridge-mcp-settings"><label class="bridge-enable"><input id="bridge-mcp-enabled" type="checkbox" disabled>Enable MCP connection</label><div class="bridge-settings-grid"><label class="bridge-field bridge-port-field"><span>Local port</span><input id="bridge-mcp-port" type="number" min="1024" max="65535" step="1" required disabled></label><label class="bridge-field"><span>Public HTTPS MCP URL <small>Optional</small></span><input id="bridge-mcp-url" type="url" maxlength="2048" placeholder="https://your-host.example/mcp" disabled><small>Use the HTTPS address from your tunnel or hosting setup.</small></label></div><p class="bridge-field-help">Listener status describes BLACKICE on this computer. Follow the connection instructions to connect ChatGPT.</p></div><p id="bridge-existing-connector" class="bridge-field-help" hidden>Your existing connector needs command and file access to the computer running BLACKICE. Avalon is one example. BLACKICE supplies this installation’s bridge command automatically.</p><p id="bridge-connection-status" class="bridge-connection-status" role="status"></p><p id="bridge-settings-error" class="bridge-error" role="alert" hidden></p><p id="bridge-settings-receipt" class="bridge-receipt" role="status" hidden></p><div class="bridge-settings-actions"><button id="bridge-settings-save" class="button primary" type="submit" disabled>Save connection</button><button id="bridge-settings-reset" class="button subtle" type="button" data-bridge-action="settings-reset" disabled>Use saved settings</button></div><p id="bridge-settings-dirty" class="bridge-field-help"></p></form></details><details id="bridge-setup-details" class="bridge-setup-details"><summary>Setup instructions &amp; connection token</summary><textarea id="bridge-setup-instructions" rows="9" readonly spellcheck="false" aria-label="Saved connection instructions"></textarea><div class="bridge-settings-actions"><button id="bridge-copy-instructions" class="button" type="button" data-bridge-action="copy-instructions" disabled>Copy instructions</button><button id="bridge-copy-mcp-config" class="button" type="button" data-bridge-action="copy-mcp-config" disabled>Copy local MCP config</button><button id="bridge-copy-token" class="button" type="button" data-bridge-action="copy-token" disabled>Copy connection token</button></div></details></div><div class="bridge-toolbar"><span id="bridge-status" role="status" aria-live="polite"></span><div><button id="bridge-new" class="button" type="button" data-bridge-action="new">${icon('plus', 13)}Compose request</button><button class="icon-button" type="button" data-bridge-action="refresh" aria-label="Refresh ChatGPT bridge">${icon('refresh', 15)}</button></div></div><p id="bridge-health-error" class="bridge-error" role="alert" hidden></p><p id="bridge-error" class="bridge-error" role="alert" hidden></p><p id="bridge-receipt" class="bridge-receipt" role="status" hidden></p><div class="bridge-layout"><aside class="bridge-sidebar" aria-label="Queued ChatGPT requests"><label class="bridge-filter">Show<select id="bridge-filter"><option value="all">All requests</option><option value="pending">Waiting for ChatGPT</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select></label><div id="bridge-request-list" class="bridge-request-list"></div><p id="bridge-list-empty" class="bridge-empty"></p><div class="bridge-pagination"><button id="bridge-page-prev" class="icon-button" type="button" data-bridge-action="previous" aria-label="Previous requests">${icon('chevron', 12)}</button><span id="bridge-page-label"></span><button id="bridge-page-next" class="icon-button" type="button" data-bridge-action="next" aria-label="Next requests">${icon('chevron', 12)}</button></div></aside><div class="bridge-main"><form id="bridge-compose"><div class="bridge-compose-heading"><h3>What should ChatGPT do?</h3>${getChatDraft ? '<button id="bridge-use-chat-draft" class="button subtle" type="button" data-bridge-action="use-draft">Use chat draft</button>' : ''}</div><label class="bridge-field"><span>Title <small>Optional</small></span><input id="bridge-title" maxlength="160" placeholder="A short name for this request" autocomplete="off" value="${escape(state.draft.title)}"></label><label class="bridge-field"><span>Task</span><textarea id="bridge-prompt" rows="7" required maxlength="64000" placeholder="Describe the result you want…">${escape(state.draft.prompt)}</textarea><small id="bridge-prompt-count"></small></label><details class="bridge-context"${state.draft.context ? ' open' : ''}><summary>Add context <small>Optional</small></summary><label class="bridge-field"><span>Context to include</span><textarea id="bridge-context" rows="5" maxlength="256000" placeholder="Paste the notes, excerpts, or instructions you want ChatGPT to receive.">${escape(state.draft.context)}</textarea><small id="bridge-context-count"></small></label></details><p class="bridge-field-help">Your draft stays here until you queue it. ${getChatDraft ? 'Use chat draft copies only the unsent text from your current chat.' : 'Only the task and optional context you enter here are queued.'}</p><div class="bridge-compose-footer"><span>Send the handoff in ChatGPT to start. Queuing alone does not run a model.</span><button id="bridge-submit" class="button primary" type="submit">Queue request</button></div></form><section id="bridge-detail" aria-label="Selected ChatGPT request" hidden><p id="bridge-detail-message" class="bridge-empty" role="status"></p><div id="bridge-detail-content" hidden><div class="bridge-detail-meta"><span id="bridge-detail-state" role="status"></span><code id="bridge-detail-id"></code></div><h3 id="bridge-detail-title" tabindex="-1"></h3><p id="bridge-detail-time" class="bridge-field-help"></p><div class="bridge-detail-actions"><button id="bridge-copy-handoff" class="button primary" type="button" data-bridge-action="copy-handoff">${icon('copy', 13)}Copy ChatGPT handoff</button><button id="bridge-copy-answer" class="button primary" type="button" data-bridge-action="copy-answer" hidden>${icon('copy', 13)}Copy answer</button><button id="bridge-cancel" class="button subtle" type="button" data-bridge-action="cancel">Cancel request</button></div><p id="bridge-waiting" class="bridge-waiting">Waiting for ChatGPT. Send the copied handoff in Chat Mode with your configured connection. This panel updates when ChatGPT saves an answer.</p><details id="bridge-timeout-help" class="bridge-handoff-panel"><summary>Handoff interrupted or connector timed out?</summary><p class="bridge-field-help">If ChatGPT or your connector reports “Connector timed out”, the work may still be running or its answer may already be saved. BLACKICE cannot detect a timeout in ChatGPT from this queue.</p><p class="bridge-field-help">Check saved status first. If it is still waiting, ask ChatGPT to inspect the existing operation or result before retrying this same request. Keep the approval already granted for this request; platform-required confirmations still apply. Do not queue a replacement or repeat work with an unknown outcome.</p><div class="bridge-settings-actions"><button id="bridge-timeout-check" class="button" type="button" data-bridge-action="check-status">Check saved status</button><button id="bridge-recovery-copy" class="button" type="button" data-bridge-action="copy-recovery">Copy recovery steps</button></div><details id="bridge-recovery-message-panel" class="bridge-handoff-panel"><summary>Recovery message</summary><textarea id="bridge-recovery-message" rows="6" readonly spellcheck="false" aria-label="ChatGPT recovery message"></textarea></details></details><p id="bridge-cancelled" class="bridge-field-help" hidden>This request was cancelled.</p><p id="bridge-missing-answer" class="bridge-error" hidden>The completed request has no saved answer. Refresh to check again.</p><details id="bridge-handoff-panel" class="bridge-handoff-panel"><summary>Handoff message</summary><textarea id="bridge-handoff" rows="9" readonly spellcheck="false" aria-label="ChatGPT handoff message"></textarea></details><section id="bridge-answer-panel" class="bridge-answer-panel" hidden><h4>ChatGPT answer</h4><pre id="bridge-answer" tabindex="0"></pre></section><details class="bridge-source"><summary>Request &amp; context</summary><h4>Task</h4><pre id="bridge-saved-prompt"></pre><section id="bridge-saved-context-section" hidden><h4>Context</h4><pre id="bridge-saved-context"></pre></section></details><p id="bridge-selection-note" class="bridge-field-help" hidden>The selected request is outside this page or filter.</p></div></section></div></div><div class="modal-footer"><span id="bridge-connection-footer" class="footer-note">Saved on this computer · Configurable ChatGPT connection</span><button class="button" data-action="close-modal">Done</button></div></div>`, true);
      mount = document.querySelector('#chatgpt-bridge-view');
      document.querySelector('#modal-root .modal')?.classList.add('chatgpt-bridge-modal');
      if (!alive(owner)) return;
      $('#bridge-filter').value = state.filter; fillSettings(); bind(); render();
      globalThis.requestAnimationFrame?.(() => { if (alive(owner)) $(state.panel === 'compose' ? '#bridge-prompt' : '#bridge-detail-title')?.focus({ preventScroll: true }); });
      await refresh();
    },
    refresh,
    cancel
  };
}
