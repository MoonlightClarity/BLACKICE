const fail = (message, code = 'BROWSER_OWNERSHIP_VALIDATION') => Object.assign(new Error(message), { code, actionDispatched: false });
export const ownershipAction = action => ['take_ownership', 'transfer_ownership'].includes(action);
const same = (a,b) => !!a && !!b && a.taskId === b.taskId && a.nodeId === b.nodeId && a.runId === b.runId;
export function ownershipChange(args, status, caller, source = 'agent') {
  const keys = ['action','browser','tabId','expectedUrl','expectedDocumentId','destination','destinationTabId','destinationOwnerKey'];
  if (!ownershipAction(args.action) || Object.keys(args).some(k => !keys.includes(k)) || ['tabId','expectedUrl','expectedDocumentId'].some(k => typeof args[k] !== 'string' || !args[k] || args[k].length > (k === 'expectedUrl' ? 20000 : 200))) throw fail('Choose one observed tab and its exact URL and document identity.');
  const tab = status.tabs?.find(t => t.tabId === args.tabId);
  if (!tab) throw fail('The selected tab no longer exists.', 'BROWSER_TAB_NOT_FOUND');
  if (tab.purpose === 'chat-mode' || tab.protectedContent) throw fail('This reserved tab cannot change ownership.', 'BROWSER_HUMAN_CHAT_RESERVED');
  if (tab.url !== args.expectedUrl || tab.documentId !== args.expectedDocumentId) throw fail('The selected page changed. Inspect its identity again.', 'BROWSER_INPUT_DOCUMENT_CHANGED');
  if (args.action === 'take_ownership') {
    if (!caller || source === 'user' || args.destination !== undefined || args.destinationTabId !== undefined || args.destinationOwnerKey !== undefined) throw fail('Take ownership uses the current host-bound task, without a destination.');
    if (tab.owner && !same(tab.owner, caller)) throw fail('Another owner must explicitly transfer this tab; taking it is not permitted.', 'BROWSER_TAB_OWNERSHIP');
    return { tab, owner: { ...caller } };
  }
  if (source !== 'user' && !same(tab.owner, caller)) throw fail('Only the current owner can transfer this tab.', 'BROWSER_TAB_OWNERSHIP');
  if (args.destination === 'user') {
    if (args.destinationTabId !== undefined || args.destinationOwnerKey !== undefined) throw fail('A transfer to the user has no destination task.');
    return { tab, owner: null };
  }
  if (args.destination !== 'task' || !args.destinationTabId || !args.destinationOwnerKey) throw fail('Choose user, or task with an observed destination tab and exact owner key.');
  const target = status.tabs?.find(t => t.tabId === args.destinationTabId);
  const key = target?.owner && JSON.stringify([target.owner.taskId,target.owner.nodeId,target.owner.runId]);
  if (!target?.owner || target.purpose === 'chat-mode' || target.protectedContent || key !== args.destinationOwnerKey || !status.folders?.some(f=>f.id===target.folderId && f.kind==='task' && f.taskId===target.owner.taskId)) throw fail('The destination task identity changed or is not available.', 'BROWSER_DESTINATION_CHANGED');
  return { tab, owner: { ...target.owner }, folderId: target.folderId };
}
