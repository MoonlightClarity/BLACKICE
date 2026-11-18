import { createHash } from 'node:crypto';

const invalid = (message, code = 'BROWSER_CLEANUP_SCOPE_INVALID') =>
  Object.assign(new Error(message), { code, status: 400, actionDispatched: false });
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200
  && !/[\u0000-\u001f\u007f]/.test(value);

/** An explicitly identified conversation, or an exact worker within it. Never a shared connector grant. */
export function browserCleanupScope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['kind', 'conversationId', 'taskId', 'nodeId'].includes(key))
    || !validId(value.conversationId) || !['conversation', 'task'].includes(value.kind))
    throw invalid('Choose one saved conversation or one exact task within it.');
  if (value.kind === 'conversation') {
    if (value.taskId !== undefined || value.nodeId !== undefined)
      throw invalid('Conversation cleanup cannot silently narrow or broaden a task.');
    return { kind: 'conversation', conversationId: value.conversationId };
  }
  if (!validId(value.taskId) || !validId(value.nodeId))
    throw invalid('Task cleanup needs its exact saved task and worker IDs.');
  return { kind: 'task', conversationId: value.conversationId,
    taskId: value.taskId, nodeId: value.nodeId };
}

export function scopedBrowserTabs(status, scopeValue) {
  const scope = browserCleanupScope(scopeValue);
  return (Array.isArray(status?.tabs) ? status.tabs : []).filter(tab =>
    tab && tab.purpose !== 'chat-mode' && tab.owner
    && tab.conversationId === scope.conversationId
    && (scope.kind === 'conversation' || tab.owner.taskId === scope.taskId && tab.owner.nodeId === scope.nodeId));
}

export function browserCleanupTaskGroups(status, conversationId) {
  if (!validId(conversationId)) return [];
  const groups = new Map();
  for (const tab of scopedBrowserTabs(status, { kind: 'conversation', conversationId })) {
    if (!validId(tab.owner?.taskId) || !validId(tab.owner?.nodeId)) continue;
    const key = JSON.stringify([tab.owner.taskId, tab.owner.nodeId]);
    if (!groups.has(key)) groups.set(key, { taskId: tab.owner.taskId, nodeId: tab.owner.nodeId,
      label: tab.owner.label || tab.owner.nodeId, count: 0 });
    groups.get(key).count++;
  }
  return [...groups.values()];
}

function reasonFor(tab, status, inspection, activeRunIds) {
  if (status.persistence?.healthy !== true) return 'Browser storage has not confirmed it can save a cleanup.';
  if(tab.inUse===true)return 'This tab is explicitly marked in use.';
  if (tab.protectedContent) return 'Protected authentication content.';
  if (tab.humanCreated || tab.userPinned) return 'A person opened or interacted with this page.';
  if (activeRunIds.has(tab.owner?.runId) || activeRunIds.has(tab.owner?.taskId))
    return 'This task or conversation has work running or queued.';
  if (tab.pendingInteraction || tab.interactionSettling)
    return 'A website dialog, form chooser or input is unresolved.';
  if (tab.loading || tab.rendererFailure)
    return 'Navigation or renderer recovery is unfinished.';
  if ((status.downloads || []).some(item => item.tabId === tab.tabId && item.status === 'downloading'))
    return 'A download is still running.';
  if (tab.uncertainEffects) return 'A website effect may still be pending or uncertain.';
  // "limited" means no editable content was seen in reachable DOM, not
  // proof that closed shadow roots on built-in elements are empty.
  // Such pages are manually reviewable candidates, never auto-approved.
  if (inspection?.state === 'clear' || inspection?.state === 'limited') return null;
  if (inspection?.state === 'interactive') return 'This page contains a form or editable content; inspect it individually.';
  if (inspection?.state === 'suspended') return 'This suspended page may be needed to resume work.';
  return inspection?.reason || 'Page safety could not be verified; retain it for inspection.';
}

/** Preview is keyed to exact IDs, documents, owners, state and the task's eligible set. */
export function browserCleanupPreview(status, scopeValue, { inspections = new Map(), activeRunIds = new Set() } = {}) {
  const scope = browserCleanupScope(scopeValue);
  const scoped = scopedBrowserTabs(status, scope);
  const rows = scoped.map(tab => {
    const inspection = inspections.get(tab.tabId);
    const reason = reasonFor(tab, status, inspection, activeRunIds);
    const manualReviewRequired = !reason && inspection?.state === 'limited';
    return { tabId: tab.tabId, title: String(tab.title || tab.url || 'Untitled page').slice(0, 240),
      url: tab.url, documentId: tab.documentId, parentTabId: tab.parentTabId || null,
      owner: { taskId: tab.owner.taskId, nodeId: tab.owner.nodeId, runId: tab.owner.runId },
      eligible: !reason, ...(manualReviewRequired
        ? { manualReviewRequired: true, inspectionCoverage: 'reachable-dom-only',
            inspectionWarning: inspection.reason ||
              'No visible editable content observed. Closed shadow roots on ordinary div/span elements can hide unfinished forms; review this page before selecting.' }
        : {}), ...(reason ? { reason } : {}) };
  });
  const previewId = createHash('sha256').update(JSON.stringify({ version: 2, scope, rows })).digest('hex');
  return { scope, previewId, total: rows.length, eligible: rows.filter(tab => tab.eligible).length,
    reviewRequired: rows.filter(tab => tab.manualReviewRequired).length,
    protected: rows.filter(tab => !tab.eligible).length, rows };
}

export function browserCleanupSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['scope', 'previewId', 'selectedTabIds', 'reviewedTabIds'].includes(key))
    || typeof value.previewId !== 'string' || !/^[a-f0-9]{64}$/.test(value.previewId)
    || !Array.isArray(value.selectedTabIds) || value.selectedTabIds.length > 1000
    || value.selectedTabIds.some(id => !validId(id)) || new Set(value.selectedTabIds).size !== value.selectedTabIds.length)
    throw invalid('Confirm the exact preview and distinct tab IDs.');
  const reviewedTabIds = value.reviewedTabIds === undefined ? [] : value.reviewedTabIds;
  const selected = new Set(value.selectedTabIds);
  if (!Array.isArray(reviewedTabIds) || reviewedTabIds.length > selected.size ||
    reviewedTabIds.some(id => !validId(id) || !selected.has(id)) ||
    new Set(reviewedTabIds).size !== reviewedTabIds.length)
    throw invalid('Review only distinct, explicitly selected tabs within this exact preview.');
  return { scope: browserCleanupScope(value.scope), previewId: value.previewId,
    selectedTabIds: [...value.selectedTabIds], reviewedTabIds: [...reviewedTabIds] };
}
