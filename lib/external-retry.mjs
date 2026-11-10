import { contractRetryReceipts, readContractJournal } from './planning-contract-runtime.mjs';

function retryHold(runId, taskId, receipts, backupRecovery, recordedAt, { journalRecovery = false } = {}) {
  const message = journalRecovery
    ? 'Retry is held because the original operation journal could not be verified. Open the original run and recover its saved evidence before creating new work.'
    : 'Retry is held because the original task has external actions that may already have succeeded. Open its run, inspect the destination and continue that original task with its saved receipts before creating new work.';
  return { code: 'EXTERNAL_ACTION_RECONCILE', runId, taskId, receipts, backupRecovery, recordedAt, message,
    ...(journalRecovery ? { journalRecovery: true } : {}) };
}

/** Find remote-action uncertainty before starting a fresh task without its ledger. */
export function externalRetryHold({runIds=[],runs=[],existing=null,recordedAt=new Date().toISOString()}={}){
  if(existing)return structuredClone(existing);
  for(const id of new Set(runIds.filter(Boolean))){
    const run=runs.find(value=>value.id===id),state=run?.taskState;if(!state)continue;
    const receipts=(state.externalActions||[]).filter(value=>['uncertain','confirmed'].includes(value.status)).map(value=>({id:value.id,status:value.status})),backupRecovery=state.externalRecovery?.required===true;
    if(!receipts.length&&!backupRecovery)continue;
    return retryHold(run.id,run.taskId||run.id,receipts,backupRecovery,recordedAt);
  }
  return null;
}

/** Use the exact settled attempt's journal at admission. A run snapshot can
 * predate the durable dispatch or omit effects from earlier planning cycles. */
export async function freshExternalRetryHold({ runIds = [], runs = [], existing = null, taskStore, archive, recordedAt = new Date().toISOString() } = {}) {
  const legacy = externalRetryHold({ runIds, runs, existing, recordedAt });
  if (legacy || !taskStore) return legacy;
  for (const runId of new Set(runIds.filter(Boolean))) {
    let run = runs.find(value => value.id === runId);
    if (!run && archive) {
      try { run = await archive.get(runId); } catch {}
    }
    if (run && (run.id !== runId || run.settled !== true)) continue;
    const taskId = run?.taskId || runId;
    const expectedCanonical = run?.planningContractVersion === 2 || run?.taskState?.taskSchemaVersion === 14 ||
      run?.taskState?.contract?.contractVersion === 2;
    try {
      const journal = await readContractJournal(taskStore, taskId);
      const receipts = contractRetryReceipts(journal, runId);
      if (receipts.length) return retryHold(runId, taskId, receipts, false, recordedAt);
      if (journal.journalSeq < (run?.taskState?.contractRuntime?.journalSeq || 0)) {
        return retryHold(runId, taskId, [], false, recordedAt, { journalRecovery: true });
      }
    } catch (error) {
      if (!expectedCanonical && error.code === 'TASK_CONTRACT_MIGRATION_REQUIRED') continue;
      return retryHold(runId, taskId, [], false, recordedAt, { journalRecovery: true });
    }
  }
  return null;
}
