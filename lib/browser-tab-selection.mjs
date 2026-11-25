import {sameBrowserOwner,conversationBrowserNode} from './browser-conversations.mjs';
const fail=(message,code)=>Object.assign(new Error(message),{code});
export const browserOwnerKey=owner=>owner?`${owner.taskId}\u0000${owner.nodeId}`:null;
export const ownsTab=(tab,owner)=>!owner||(tab?.owner?sameBrowserOwner(tab.owner,owner):owner.allowUserTabs===true);
const unverifiedTabs = () => Object.assign(fail('Current browser tab ownership is unavailable. Inspect the contained browser before acting.', 'BROWSER_TAB_STATE_UNAVAILABLE'), { status: 409, actionDispatched: false });
export const containedTab = tab => (!tab?.browser || tab.browser === 'relay') && typeof tab?.tabId === 'string' && !tab.tabId.startsWith('firefox:');
export function agentTabs(status) {
  if (!Array.isArray(status?.tabs)) throw unverifiedTabs();
  return status.tabs.filter(containedTab);
}
export function taskBrowserCapacity(status, owner) {
  const limit = (status?.browsers?.relay?.capacity || status?.capacity)?.perTaskLive;
  if (!owner || !Number.isSafeInteger(limit) || limit < 1 || limit > 1024 || !Array.isArray(status?.tabs)) return null;
  // The budget is shared across this task's workers; page visibility is not.
  const tabs = status.tabs.filter(tab => containedTab(tab) && tab.purpose !== 'chat-mode' && tab.owner?.taskId === owner.taskId);
  if (tabs.some(tab => typeof tab.suspended !== 'boolean')) return null;
  const live = tabs.filter(tab => !tab.suspended).length;
  if (live > 1024) return null;
  return { live, limit, remaining: Math.max(0, limit - live) };
}

export function agentActiveTab(status, tabs, owner) {
  if (owner) {
    const sharedKey = browserOwnerKey({ ...owner, nodeId: conversationBrowserNode });
    const selection = status?.ownerActiveTabs?.[browserOwnerKey(owner)] ?? status?.browsers?.relay?.ownerActiveTabs?.[browserOwnerKey(owner)]
      ?? status?.ownerActiveTabs?.[sharedKey] ?? status?.browsers?.relay?.ownerActiveTabs?.[sharedKey];
    return tabs.find(tab => tab.tabId === selection && ownsTab(tab, owner)) || null;
  }
  const relay = status?.browsers?.relay;
  // The router's global selection may be a manually selected external tab.
  // Use the contained driver's verified selection, never the first visible tab.
  const id = relay && Object.hasOwn(relay, 'activeTab') ? relay.activeTab : status?.activeTab;
  return tabs.find(tab => tab.tabId === id) || null;
}
