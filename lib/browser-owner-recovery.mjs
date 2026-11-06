/**
 * Failed or cancelled runs must not strand browser tabs under an unreachable
 * worker identity. Recovery never replays website actions, changes page data,
 * or assumes that a missing run is terminal.
 */
const TERMINAL = new Set(['failed', 'cancelled']);
const keyFor = owner => JSON.stringify([owner.taskId, owner.nodeId, owner.runId]);

export function collectTerminalBrowserOwners(status, runs) {
  if (!Array.isArray(status?.tabs) || typeof runs?.get !== 'function') return [];
  const unique = new Map();
  for (const tab of status.tabs) {
    const owner = tab?.owner;
    if (!owner || tab.purpose === 'chat-mode' || tab.protectedContent === true
      || !['taskId', 'nodeId', 'runId'].every(key => typeof owner[key] === 'string' && owner[key])) continue;
    const run = runs.get(owner.runId);
    if (!run || !TERMINAL.has(run.status) || run.id !== owner.runId || run.taskId !== owner.taskId) continue;
    const key = keyFor(owner);
    if (!unique.has(key)) unique.set(key, { owner: { taskId: owner.taskId, nodeId: owner.nodeId, runId: owner.runId }, status: run.status });
  }
  return [...unique.values()];
}

/** Startup-only reconciliation of explicitly verified terminal run owners. */
export async function recoverTerminalBrowserOwners(browser, runs) {
  const result = { checked: 0, released: 0, retained: 0, failures: [] };
  if (typeof browser?.releaseOwner !== 'function' || typeof browser.status !== 'function') return result;
  let owners;
  try { owners = collectTerminalBrowserOwners(browser.status(), runs); }
  catch (error) {
    result.failures.push({ code: error.code || 'BROWSER_RECOVERY_STATUS', message: String(error.message).slice(0, 300) });
    return result;
  }
  for (const { owner, status } of owners) {
    result.checked++;
    try {
      const receipt = await browser.releaseOwner(owner, { status, retainForContinuation: true }); // Never transfer ownership to a human at startup.
      result.released += receipt?.released?.length || 0;
      result.retained += receipt?.retained?.length || 0;
    } catch (error) {
      result.failures.push({
        owner: keyFor(owner), code: error.code || 'BROWSER_RECOVERY_FAILED',
        message: String(error.message).slice(0, 300),
      });
    }
  }
  return result;
}
