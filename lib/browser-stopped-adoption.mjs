import { createOperationalEffectGuard } from './operational-effect-guard.mjs';
import { readContractJournal, contractRetryReceipts } from './planning-contract-runtime.mjs';
// Host-only lifecycle evidence. Missing history is unknown, never proof of a stopped owner.
const terminal = new Set(['completed', 'failed', 'cancelled']);
export const ownerIdentity = owner => owner ? JSON.stringify([owner.taskId, owner.nodeId, owner.runId]) : null;
const denied = reason => ({ eligible: false, reason });
export function stoppedBrowserOwnerStatus(owner, engine, directExecution = null) {
  if (!owner || !engine?.runs || engine.closed || engine.storageError) return denied('Owner lifecycle is unavailable.');
  if (owner.nodeId === 'conversation') return denied('Shared conversation ownership requires an explicit transfer.');
  if (directExecution && (directExecution.storageError || !directExecution.jobs?.records)) return denied('Direct execution lifecycle is unavailable.');
  if (directExecution && [...directExecution.jobs.records.values()].some(job => !['succeeded','failed','cancelled','interrupted'].includes(job.status) && job.arguments?.conversationId === owner.taskId)) return denied('A direct action is using this conversation.');
  const run = engine.runs.get(owner.runId);
  if (!run || run.id !== owner.runId || (run.taskId || run.id) !== owner.taskId) return denied('The exact owner run is unknown.');
  const family = [...engine.runs.values()].filter(item => (item.taskId || item.id) === owner.taskId);
  if (!family.length || family.some(item => !terminal.has(item.status) || item.settled !== true)
    || engine.conversationBusy?.(run) || engine.executionEntries?.().some(entry => !entry.run || (entry.run.taskId || entry.run.id) === owner.taskId))
    return denied('The owner task is active, paused, queued or still settling.');
  // Startup changes interrupted runs to failed; that is not evidence that effects settled.
  if (family.some(item => item.browserOwnerInterrupted === true || item.error === 'The harness restarted before this run finished. Resume this run to continue from completed steps.'))
    return denied('The owner was interrupted by restart; reconcile it in its original task.');
  if (family.some(item => item.taskState?.externalRecovery?.required || item.taskState?.executionObservations?.unavailable
    || (item.taskState?.externalActions || []).some(action => action.status === 'uncertain')))
    return denied('The owner retains uncertain external effects.');
  return { eligible: true, reason: 'The exact owner and its task are stopped and settled.', runId: run.id, status: run.status };
}
export function stoppedTabAdoption(tab, status, resolveOwner) {
  if (!tab.owner) return denied('This is a user-owned tab, not a stopped task tab.');
  if (status.persistence?.healthy !== true) return denied('Browser persistence is unavailable.');
  if (tab.purpose === 'chat-mode' || tab.protectedContent || tab.humanCreated || tab.userPinned)
    return denied('This page is reserved, protected or retained by the person.');
  if (tab.pendingInteraction || tab.interactionSettling || tab.loading || tab.rendererFailure || tab.uncertainEffects
    || (status.downloads || []).some(item => item.tabId === tab.tabId && item.status === 'downloading'))
    return denied('The page has unfinished input, navigation, download or uncertain effects.');
  try { return resolveOwner?.(tab.owner) || denied('Owner lifecycle is unavailable.'); }
  catch { return denied('Owner lifecycle could not be verified.'); }
}
export function decorateStoppedTabAdoption(status, resolveOwner) {
  return { ...status, tabs: (status.tabs || []).map(tab => ({ ...tab, adoption: stoppedTabAdoption(tab, status, resolveOwner) })) };
}

/** Read the existing effect authorities, never move/clear their receipts or infer absence. */
export async function assertStoppedTabEffects(owner, engine) {
  const blocked = message => Object.assign(new Error(message), { code: 'BROWSER_ADOPTION_EFFECTS_UNCERTAIN', actionDispatched: false });
  const run = engine.runs?.get(owner.runId);
  if (!run || !engine.tasks || stoppedBrowserOwnerStatus(owner, engine).eligible !== true)
    throw blocked('The stopped owner or its effect history is unavailable.');
  const guard = createOperationalEffectGuard({ store: engine.tasks, cwd: run.cwd, taskId: owner.taskId, runId: owner.runId, nodeId: owner.nodeId });
  const rows = await guard.records();
  if (rows.some(row => row.taskId === owner.taskId && row.adapter === 'relay_browser' && row.state === 'unknown'))
    throw blocked('This task has an uncertain native browser effect. Reconcile it in the original task; no tab was adopted.');
  const journal = await readContractJournal(engine.tasks, owner.taskId);
  if ([...engine.runs.values()].filter(item => (item.taskId || item.id) === owner.taskId)
    .some(item => contractRetryReceipts(journal, item.id).some(receipt => receipt.status === 'uncertain')))
    throw blocked('This task retains an uncertain browser commitment. No tab was adopted.');
  if (stoppedBrowserOwnerStatus(owner, engine).eligible !== true)
    throw blocked('The owner resumed while effect history was being checked.');
}
