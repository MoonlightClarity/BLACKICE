/** Directory is retired, not silently downgraded. Stored records remain untouched. */
export const DIRECTORY_RETIREMENT = Object.freeze({available:false,code:'DIRECTORY_RETIRED',reason:'Directory execution is unavailable because conversation-folder context isolation is not established. Existing records are preserved. Start a new conversation with Directory Off.'});
export function assertDirectoryAvailable(){throw Object.assign(new Error(DIRECTORY_RETIREMENT.reason),{code:DIRECTORY_RETIREMENT.code,status:410});}

/** Old Directory-derived conversation state is quarantined, not relabelled ordinary context. */
export function assertNoRetiredDirectoryHistory(previous,history=[]) {
 if(!previous)return;
 const rows=[previous,...history],byId=new Map(rows.filter(Boolean).map(row=>[row.id,row]));
 const root=previous.taskId||previous.id,seen=new Set(),pending=[previous,...rows.filter(row=>(row.taskId||row.id)===root)];
 while(pending.length){const row=pending.pop();if(!row||seen.has(row.id))continue;seen.add(row.id);
  if(row.executionModes?.directoryMode==='on'||row.executionModes?.directoryMode==='auto'||/^\s*(?:@directory|\/directory|@shadowdancer)\s+/i.test(String(row.input||''))||Object.values(row.nodes||{}).some(node=>node.shadowdancer||node.runtimePhase==='directory'))assertDirectoryAvailable();
  for(const key of ['parentRunId','retryOf'])if(byId.has(row[key]))pending.push(byId.get(row[key]));
 }
}
