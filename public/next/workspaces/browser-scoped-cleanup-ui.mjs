import { text } from '../core/dom.mjs';

export function browserScopedCleanupMarkup() {
  return [
    '<section id="next-browser-cleanup-panel" class="next-browser-cleanup-panel" aria-label="Task browser cleanup" hidden>',
    '<h2>Clean up one conversation or task</h2>',
    '<p>Preview the exact owner and pages first. Detected forms and active or uncertain effects are protected, but DOM inspection is limited: a closed shadow root on an ordinary div/span can hide unfinished work. Review each candidate before choosing to close it.</p>',
    '<div class="next-browser-cleanup-controls">',
    '<label>Conversation <select id="next-browser-cleanup-conversation" class="next-field"></select></label>',
    '<label>Scope <select id="next-browser-cleanup-task" class="next-field"></select></label>',
    '<button id="next-browser-cleanup-preview" type="button">Preview tabs</button>',
    '<button id="next-browser-cleanup-cancel" type="button">Done</button>',
    '</div>',
    '<p id="next-browser-cleanup-summary" role="status" aria-live="polite"></p>',
    '<div id="next-browser-cleanup-list" class="next-browser-cleanup-list"></div>',
    '<button id="next-browser-cleanup-execute" type="button" disabled>Close selected tabs</button>',
    '</section>',
  ].join('');
}

/** Only groups with a verified conversation association can be bulk-cleaned. */
export function cleanupGroups(status, conversationId) {
  if (!conversationId) return [];
  const groups = new Map();
  for (const tab of status?.tabs || []) {
    if (!tab.owner || tab.conversationId !== conversationId || tab.purpose === 'chat-mode') continue;
    const { taskId, nodeId } = tab.owner;
    if (!taskId || !nodeId) continue;
    const id = JSON.stringify([taskId, nodeId]);
    if (!groups.has(id)) groups.set(id, { taskId, nodeId, label: tab.owner.label || nodeId, count: 0 });
    groups.get(id).count++;
  }
  return [...groups.values()];
}

export function createBrowserScopedCleanup({ mount, api, refresh, notify = () => {}, isBusy = () => false }) {
  const document = mount.ownerDocument, $ = id => mount.querySelector('#' + id);
  const ui = { open: $('next-browser-cleanup-open'), panel: $('next-browser-cleanup-panel'),
    conversation: $('next-browser-cleanup-conversation'), task: $('next-browser-cleanup-task'),
    preview: $('next-browser-cleanup-preview'), cancel: $('next-browser-cleanup-cancel'),
    summary: $('next-browser-cleanup-summary'), list: $('next-browser-cleanup-list'),
    execute: $('next-browser-cleanup-execute') };
  let status = { tabs: [], conversations: [] }, preview = null, pending = false, destroyed = false;
  let lastSignature = '';
  const option = (parent, value, label) => {
    const item = text(parent, label, 'option'); item.value = value; item.setAttribute('value', value); return item;
  };
  const selection = () => {
    const conversationId = ui.conversation.value;
    if (!conversationId) return null;
    if (ui.task.value === 'conversation') return { kind: 'conversation', conversationId };
    try {
      const [taskId, nodeId] = JSON.parse(ui.task.value);
      if (!taskId || !nodeId) return null;
      return { kind: 'task', conversationId, taskId, nodeId };
    } catch { return null; }
  };
  function discard() {
    preview = null; ui.execute.disabled = true; ui.list.replaceChildren();
    ui.summary.textContent = '';
  }
  function populate() {
    const priorConversation = ui.conversation.value, priorTask = ui.task.value;
    const conversations = (status.conversations || []).filter(item =>
      item && item.id && item.state !== 'deleted' && (status.tabs || []).some(tab => tab.conversationId === item.id));
    ui.conversation.replaceChildren(); option(ui.conversation, '', 'Choose a conversation');
    for (const conversation of conversations) option(ui.conversation, conversation.id,
      conversation.title + ' (' + (status.tabs || []).filter(tab => tab.conversationId === conversation.id).length + ')');
    if (conversations.some(item => item.id === priorConversation)) ui.conversation.value = priorConversation;
    ui.task.replaceChildren(); option(ui.task, 'conversation', 'Entire conversation');
    for (const group of cleanupGroups(status, ui.conversation.value)) {
      option(ui.task, JSON.stringify([group.taskId, group.nodeId]), group.label + ' (' + group.count + ')');
    }
    if ([...ui.task.querySelectorAll('option')].some(item => item.value === priorTask)) ui.task.value = priorTask;
    ui.preview.disabled = pending || isBusy() || !selection();
    ui.cancel.disabled = pending;
  }
  function renderPreview() {
    ui.list.replaceChildren();
    if (!preview) { ui.execute.disabled = true; return; }
    ui.summary.textContent = preview.total + ' pages in scope · ' + preview.eligible
      + ' review candidates · ' + (preview.reviewRequired || 0)
      + ' limited inspections requiring manual review · ' + preview.protected
      + ' protected. No candidate is certified free of hidden closed-shadow content. Other conversations and Personal tabs are outside this scope.';
    for (const row of preview.rows) {
      const label = text(ui.list, '', 'label', 'next-browser-cleanup-row');
      if (row.eligible) {
        const checkbox = document.createElement('input');
        checkbox.setAttribute('type','checkbox'); checkbox.checked = row.manualReviewRequired !== true;
        checkbox.dataset.cleanupId = row.tabId;
        if (row.manualReviewRequired) checkbox.setAttribute('aria-label', 'I reviewed ' + row.title + ' and choose to close this page');
        checkbox.addEventListener('change', () => {
          ui.execute.disabled = pending || ![...ui.list.querySelectorAll('input[data-cleanup-id]')].some(input => input.checked);
        });
        label.append(checkbox);
      } else text(label, 'Preserved', 'strong');
      text(label, row.title || row.url || row.tabId, 'span');
      if (row.reason) text(label, row.reason, 'small');
      if (row.inspectionWarning) text(label, row.inspectionWarning, 'small');
      label.title = row.url || '';
    }
    ui.execute.disabled = pending || ![...ui.list.querySelectorAll('input[data-cleanup-id]')].some(input => input.checked);
  }
  async function loadPreview() {
    if (pending || isBusy()) return;
    const scope = selection();
    if (!scope) { ui.summary.textContent = 'Choose a conversation and exact scope.'; return; }
    pending = true; discard(); populate();
    try {
      const result = await api('/api/browser/cleanup-preview', 'POST', scope, { deadlineMs: 30000 });
      if (destroyed || ui.panel.hidden || JSON.stringify(selection()) !== JSON.stringify(scope)) return;
      preview = result; renderPreview();
    } catch (error) { ui.summary.textContent = error.message; notify(error.message, true); }
    finally { pending = false; populate(); if (preview) renderPreview(); }
  }
  async function execute() {
    if (!preview || pending || isBusy()) return;
    const chosen = [...ui.list.querySelectorAll('input[data-cleanup-id]:checked')].map(item => item.dataset.cleanupId);
    if (!chosen.length) return;
    pending = true; populate(); ui.execute.disabled = true;
    const reviewedTabIds = chosen.filter(id => preview.rows.some(row => row.tabId === id && row.manualReviewRequired));
    const request = { scope: preview.scope, previewId: preview.previewId, selectedTabIds: chosen, reviewedTabIds };
    try {
      const result = await api('/api/browser/cleanup', 'POST', request, { deadlineMs: 60000 });
      if (destroyed) return;
      await refresh();
      discard();
      ui.summary.textContent = 'Closed ' + result.closed + ' of ' + result.requested
        + ' selected tabs. ' + (result.remaining === null ? 'Remaining count unverified'
          : result.remaining + ' remain in scope')
        + (result.failedTabs?.length ? '; ' + result.failedTabs.length + ' need attention.' : '.')
        + (result.lateTabIds?.length ? ' New tabs appeared; preview again.' : '')
        + (result.persistenceVerified !== true ? ' Browser persistence is not verified.' : '');
      notify(ui.summary.textContent, Boolean(result.failedTabs?.length || result.remaining === null || !result.persistenceVerified));
    } catch (error) { ui.summary.textContent = error.message + ' Preview again before retrying.'; notify(ui.summary.textContent, true); }
    finally { pending = false; populate(); }
  }
  ui.open.addEventListener('click', () => {
    if (destroyed) return;
    ui.panel.hidden = !ui.panel.hidden;
    if (!ui.panel.hidden) { populate(); ui.conversation.focus(); }
    else discard();
  });
  ui.cancel.addEventListener('click', () => { ui.panel.hidden = true; discard(); });
  ui.conversation.addEventListener('change', () => { discard(); populate(); });
  ui.task.addEventListener('change', discard);
  ui.preview.addEventListener('click', () => void loadPreview());
  ui.execute.addEventListener('click', () => void execute());
  return {
    update(next) {
      if (destroyed) return;
      const signature = JSON.stringify((next?.tabs || []).map(tab =>
        [tab.tabId, tab.documentId, tab.url, tab.conversationId, tab.owner?.taskId, tab.owner?.nodeId]));
      status = next || status;
      if (signature !== lastSignature) { lastSignature = signature; if (preview) discard(); }
      if (!ui.panel.hidden) populate();
    },
    destroy() { destroyed = true; discard(); },
  };
}
