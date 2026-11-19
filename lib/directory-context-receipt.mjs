/** Directory Diagnostics observes host preparation. It never supplies context. */
export function directoryDiagnosticsMode(value){
  if(value===undefined||value==='on'||value==='off')return value;
  throw Object.assign(new Error('Choose Directory Diagnostics Off or On.'),{status:400,code:'DIRECTORY_DIAGNOSTICS_MODE_INVALID'});
}

export function prepareDirectoryContext({run,nodeId,resumed=false,identityIncluded=false,attachmentsIncluded=false,continuity,at=new Date().toISOString()}){
  const method=['saved-messages','automatic-compaction'].includes(continuity?.method)?continuity.method:'none';
  return {schemaVersion:1,runId:run.id,taskId:run.taskId||run.id,nodeId,preparedAt:at,
    requestSource:run.goalDispatch||run.goal?.automatic?'goal-dispatch':run.autonomyDispatch||run.autonomy?.automatic?'autonomy-dispatch':run.retryOf?'retry-of-saved-request':'current-request',
    attachments:{selectedCount:run.attachmentIds?.length||0,included:attachmentsIncluded===true},identityIncluded:identityIncluded===true,
    providerSession:resumed?'resumed-opaque':'fresh',
    continuity:{method,sourceRunId:method!=='none'&&typeof continuity.sourceRunId==='string'?continuity.sourceRunId:null,
      retainedChars:method!=='none'&&Number.isSafeInteger(continuity.retainedChars)?continuity.retainedChars:null,truncated:method!=='none'&&continuity.truncated===true},
    pastChats:run.pastChats==='off'?'off':'on'};
}

// 'thread' may be emitted before turn/start. A bound turn activity envelope is
// stronger, but still doesn't prove which inputs the model semantically used.
export function observeDirectoryProvider(receipt,event,at=new Date().toISOString()){
  if(!receipt||receipt.providerObservedAt||typeof event?.turnId!=='string'||!event.turnId||!['turn','item','message','usage','tool.result'].includes(event.type))return false;
  receipt.providerObservedAt=at;
  return true;
}
