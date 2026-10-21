import { createHash } from 'node:crypto';

/** A stable host scope shared by browser and opaque-credential direct tools. */
export function connectorBrowserOwner(clientId) {
  if (typeof clientId !== 'string' || !clientId) throw new Error('A verified connector identity is required for browser ownership.');
  const taskId = 'chatgpt_' + createHash('sha256').update(clientId).digest('hex').slice(0, 40);
  return { taskId, runId: taskId, nodeId: 'bridge', label: 'ChatGPT connection', allowUserTabs: true };
}
