const invalid = (message, code = 'BROWSER_CONVERSATION_INVALID', status = 400) => Object.assign(new Error(message), { code, status, actionDispatched: false });
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
export const conversationBrowserNode = 'conversation';

/** Shared conversation pages remain usable by later turns and workers in that conversation. */
export function sameBrowserOwner(left, right) {
  if (!left || !right) return !left && !right;
  return left.taskId === right.taskId && (left.nodeId === right.nodeId
    || left.nodeId === conversationBrowserNode || right.nodeId === conversationBrowserNode);
}

function summaries(archive) {
  const entries = typeof archive?.list === 'function' ? archive.list('all') : Array.isArray(archive) ? archive : [];
  return entries.map(item => {
    const id = item.rootId || item.taskId || item.id;
    return { id, taskId: id, title: String(item.title || 'Conversation').slice(0, 200),
      state: item.state || 'active', latestRunId: item.latestRunId || item.runId || item.id || id };
  }).filter(item => validId(item.id));
}

export function resolveBrowserConversationOwner(conversationId, archive) {
  if (!validId(conversationId)) throw invalid('Choose a saved conversation.');
  const destination = summaries(archive).find(item => item.id === conversationId && item.state !== 'deleted');
  if (!destination) throw invalid('This conversation is no longer available. Choose another conversation.', 'BROWSER_CONVERSATION_NOT_FOUND', 404);
  return { taskId: destination.id, runId: destination.latestRunId, nodeId: conversationBrowserNode,
    conversationId: destination.id, label: destination.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || 'Conversation' };
}

/** Add conversation labels without guessing ownership from the UI selection or connector identity. */
export function browserConversationStatus(status, archive) {
  const all = summaries(archive), byId = new Map(all.map(item => [item.id, item]));
  const conversationFor = owner => {
    if (!owner) return null;
    const explicit = owner.conversationId || owner.taskId;
    if (byId.has(explicit)) return byId.get(explicit);
    const entry = archive?.entries?.get?.(owner.taskId) || archive?.entries?.get?.(owner.runId);
    const rootId = entry && archive?.rootIdFor?.(entry);
    return byId.get(rootId) || null;
  };
  const decorateTab = tab => {
    const conversation = conversationFor(tab.owner);
    return { ...tab, ownershipKind: tab.owner ? 'ai' : 'user',
      conversationId: conversation?.id || null, conversationTitle: conversation?.title || null };
  };
  const tabs = (status?.tabs || []).map(decorateTab);
  const counts = new Map();
  for (const tab of tabs) if (tab.conversationId) counts.set(tab.conversationId, (counts.get(tab.conversationId) || 0) + 1);
  const conversations = all.filter(item => item.state !== 'deleted').map(item => ({ ...item, tabCount: counts.get(item.id) || 0 }));
  const folders = (status?.folders || []).map(folder => {
    const conversation = folder.kind === 'task' ? conversationFor({ taskId: folder.taskId }) : null;
    return { ...folder, ownershipKind: folder.kind === 'task' ? 'ai' : 'user',
      conversationId: conversation?.id || null, conversationTitle: conversation?.title || null };
  });
  const browsers = status?.browsers ? Object.fromEntries(Object.entries(status.browsers).map(([key, value]) =>
    [key, { ...value, ...(Array.isArray(value.tabs) ? { tabs: value.tabs.map(decorateTab) } : {}) }])) : undefined;
  return { ...status, tabs, folders, conversations, ...(browsers ? { browsers } : {}) };
}

/** Only the local user route supplies this operation; task destinations are host resolved. */
export function browserConversationTransfer(value, archive) {
  const fields = ['tabId', 'expectedUrl', 'expectedDocumentId', 'destination', 'conversationId'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))
    || !validId(value.tabId) || !validId(value.expectedDocumentId) || typeof value.expectedUrl !== 'string'
    || !value.expectedUrl || value.expectedUrl.length > 20000 || !['user', 'conversation'].includes(value.destination)
    || value.destination === 'user' && value.conversationId !== undefined) throw invalid('Choose one observed tab and its destination.');
  const destinationOwner = value.destination === 'conversation' ? resolveBrowserConversationOwner(value.conversationId, archive) : null;
  return { args: { action: 'transfer_ownership', browser: 'relay', ...value, includeChildren: true },
    destinationOwner };
}
