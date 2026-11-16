import { createOperationalEffectGuard } from './operational-effect-guard.mjs';
import { readContractJournal, contractRetryReceipts } from './planning-contract-runtime.mjs';
// Host-only lifecycle evidence. Missing history is unknown, never proof of a stopped owner.
const terminal = new Set(['completed', 'failed', 'cancelled']);
export const ownerIdentity = owner => owner ? JSON.stringify([owner.taskId, owner.nodeId, owner.runId]) : null;
const denied = reason => ({ eligible: false, reason });
export function stoppedBrowserOwnerStatus(owner, engine, directExecution = null) {
  if (!owner || !engine?.runs || engine.closed || engine.storageError) return denied('Owner lifecycle is unavailable.');
  if (directExecution && (directExecution.storageError || !directExecution.jobs?.records)) return denied('Direct execution lifecycle is unavailable.');
  if (directExecution && [...directExecution.jobs.records.values()].some(job => !['succeeded','failed','cancelled','interrupted'].includes(job.status) && job.arguments?.conversationId === owner.taskId)) return denied('A direct action is using this conversation.');
  const run = engine.runs.get(owner.runId);
  if (!run || run.id !== owner.runId || (run.taskId || run.id) !== owner.taskId) return denied('The exact owner run is unknown.');
  const family = [...engine.runs.values()].filter(item => (item.taskId || item.id) === owner.taskId);
  if (!family.length || family.some(item => !terminal.has(item.status) || item.settled !== true)
    || engine.conversationBusy?.(run) || engine.executionEntries?.().some(entry => !entry.run || (entry.run.taskId || entry.run.id) === owner.taskId))
    return denied('The owner task is active, paused, queued or still settling.');
  return { eligible: true, reason: 'The exact owner and its task are stopped and settled.', runId: run.id, status: run.status };
}
export function stoppedTabAdoption(tab, status, resolveOwner) {
  if (!tab.owner) return denied('This is a user-owned tab, not a stopped task tab.');
  if (status.persistence?.healthy !== true) return denied('Browser persistence is unavailable.');
  if (tab.purpose === 'chat-mode' || tab.protectedContent || tab.humanCreated || tab.userPinned)
    return denied('This page is reserved, protected or retained by the person.');
  if (tab.pendingInteraction || tab.interactionSettling || tab.loading || tab.effectInFlight
    || (status.downloads || []).some(item => item.tabId === tab.tabId && item.status === 'downloading'))
    return denied('The page has input, navigation, a download or an external handoff still in flight.');
  try { return resolveOwner?.(tab.owner) || denied('Owner lifecycle is unavailable.'); }
  catch { return denied('Owner lifecycle could not be verified.'); }
}
export function decorateStoppedTabAdoption(status, resolveOwner) {
  return { ...status, tabs: (status.tabs || []).map(tab => ({ ...tab, adoption: stoppedTabAdoption(tab, status, resolveOwner) })) };
}

/** Observe retained history without clearing it or making it a prerequisite to transfer.
 * Adoption itself is not a website operation and never settles or replays effects. */
export async function readStoppedTabEffects(owner, engine) {
  const run = engine.runs?.get(owner.runId);
  const result = { sourceOwner: { ...owner }, operations: [], uncertain: false, unavailable: false,
    instruction: 'Historical effects were not replayed or resolved by adoption. Inspect existing outcomes before repeating a possible submission.' };
  if (!run || !engine.tasks) return { ...result, uncertain: true, unavailable: true };
  const family = [...engine.runs.values()].filter(item => (item.taskId || item.id) === owner.taskId);
  result.interrupted = family.some(item => item.browserOwnerInterrupted || item.error === 'The harness restarted before this run finished. Resume this run to continue from completed steps.');
  result.uncertain = result.interrupted || family.some(item => item.taskState?.externalRecovery?.required || item.taskState?.executionObservations?.unavailable || (item.taskState?.externalActions || []).some(action => action.status === 'uncertain'));
  try {
    const guard = createOperationalEffectGuard({ store: engine.tasks, cwd: run.cwd, taskId: owner.taskId, runId: owner.runId, nodeId: owner.nodeId });
    const rows = (await guard.records()).filter(row => row.taskId === owner.taskId && row.adapter === 'relay_browser');
    result.operations = rows.slice(-100).map(row => ({ operationId: row.operationId, runId: row.runId, nodeId: row.nodeId, state: row.state, action: row.action }));
    result.omittedOperations = Math.max(0, rows.length - result.operations.length);
    result.uncertain ||= rows.some(row => row.state === 'unknown');
    const journal = await readContractJournal(engine.tasks, owner.taskId);
    result.planningUncertain = family.some(item => contractRetryReceipts(journal, item.id).some(receipt => receipt.status === 'uncertain'));
    result.uncertain ||= result.planningUncertain;
  } catch { result.unavailable = true; result.uncertain = true; }
  return result;
}
