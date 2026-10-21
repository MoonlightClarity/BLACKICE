/** Find remote-action uncertainty before starting a fresh task without its ledger. */
export function externalRetryHold({runIds=[],runs=[],existing=null,recordedAt=new Date().toISOString()}={}){
  if(existing)return structuredClone(existing);
  for(const id of new Set(runIds.filter(Boolean))){
    const run=runs.find(value=>value.id===id),state=run?.taskState;if(!state)continue;
    const receipts=(state.externalActions||[]).filter(value=>['uncertain','confirmed'].includes(value.status)).map(value=>({id:value.id,status:value.status})),backupRecovery=state.externalRecovery?.required===true;
    if(!receipts.length&&!backupRecovery)continue;
    return{code:'EXTERNAL_ACTION_RECONCILE',runId:run.id,taskId:run.taskId||run.id,receipts,backupRecovery,recordedAt,message:'Retry is held because the original task has external actions that may already have succeeded. Open its run, inspect the destination and continue that original task with its saved receipts before creating new work.'};
  }
  return null;
}
