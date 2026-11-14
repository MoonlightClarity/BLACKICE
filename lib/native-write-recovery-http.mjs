/** Explicit operator-only recovery; never retries a tool or starts a model. */
export async function handleNativeWriteRecoveryHttp({req,res,pathname,runtime,engine,body,json}) {
  if(pathname!=='/api/codex/native-write-recovery')return false;
  if(req.headers?.['x-blackice-remote']==='1')return json(res,403,{code:'CODEX_RECOVERY_LOCAL_ONLY',error:'Use the local BLACKICE session to reconcile this native connection.'});
  const codex=runtime?.codex??runtime;
  if(typeof codex?.nativeWriteStatus!=='function'||typeof codex?.recoverStalledNativeWrites!=='function')
    return json(res,503,{code:'CODEX_RECOVERY_UNAVAILABLE',error:'Native write recovery is unavailable.'});
  if(req.method==='GET')return json(res,200,{status:codex.nativeWriteStatus(),uncertain:codex.nativeWriteUncertaintyReceipts()});
  if(req.method!=='POST')return json(res,405,{code:'METHOD_NOT_ALLOWED',error:'Use GET or POST.'});
  const value=await body(req);
  if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!=='expectedPid,expectedWriteId'||
     !Number.isSafeInteger(value.expectedWriteId)||value.expectedWriteId<1||!Number.isSafeInteger(value.expectedPid)||value.expectedPid<1)
    return json(res,400,{code:'CODEX_RECOVERY_IDENTITY_REQUIRED',error:'Inspect status and supply the observed write ID and process ID.'});
  let result, failure;
  try { result=await codex.recoverStalledNativeWrites(value); } catch(error) { failure=error; }
  // UNKNOWN events can arrive after cancellation. Flush their run snapshots even
  // when retirement failed; a failed persistence is never reported as success.
  try { await engine.persist(); } catch(error) {
    return json(res,503,{code:'CODEX_RECOVERY_PERSIST_FAILED',error:'Recovery was attempted but uncertainty could not be saved. Inspect the current status; do not repeat an action.',recoveryAttempted:true});
  }
  if(failure)return json(res,409,{code:failure.code||'CODEX_RECOVERY_FAILED',error:failure.message});
  return json(res,200,{result,status:codex.nativeWriteStatus()});
}
