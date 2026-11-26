const label=(value,max)=>typeof value==='string'&&value.length<=max&&/^[a-zA-Z0-9_ .-]+$/.test(value)?value:'';
const code=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{1,79}$/.test(value)?value:'';
const callId=value=>typeof value==='string'&&/^[A-Za-z0-9_.:~-]{1,160}$/.test(value)?value:'';
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:'';


const TOOL_FAILURE_HISTORY_LIMIT = 128;
const safeReceiptTime=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const safeFailureReceipt=row=>{
 if(!row||!label(row.tool,100))return null;
 const receipt={
  sequence:Number.isSafeInteger(row.sequence)&&row.sequence>0?row.sequence:0,
  at:safeReceiptTime(row.at),nodeId:label(row.nodeId,100),
  tool:label(row.tool,100),action:label(row.action,100),code:code(row.code)||'TOOL_FAILED',
  recovered:row.recovered===true,...(callId(row.callId)?{callId:callId(row.callId)}:{})
 };
 if(typeof row.actionDispatched==='boolean')receipt.actionDispatched=row.actionDispatched;
 if(typeof row.inputDispatched==='boolean')receipt.inputDispatched=row.inputDispatched;
 if(Number.isSafeInteger(row.exitCode)&&Math.abs(row.exitCode)<65536)receipt.exitCode=row.exitCode;
 return receipt;
};
/** Individual chronological failures; no result bodies, arguments, secret values, or raw error prose. */
export function retainToolFailureHistory(previous,entry){
 const e=entry?.data;
 if(e?.type!=='tool.result'||typeof e.tool!=='string')return previous;
 const prior=previous&&typeof previous==='object'?previous:{};
 const receipts=Array.isArray(prior.receipts)?prior.receipts.slice(-TOOL_FAILURE_HISTORY_LIMIT).map(row=>({...row})):[];
 const tool=label(e.tool,100)||'Tool',nodeId=label(entry.nodeId,100),operationKey=digest(e.operationKey);
 const total=Number.isSafeInteger(prior.total)&&prior.total>=receipts.length?prior.total:receipts.length;
 const receiptIdentity=typeof e.callId==='string'&&/^[A-Za-z0-9_.:~-]{1,160}$/.test(e.callId)?nodeId+':'+e.callId+':'+e.status:null;
 if(e.success===false&&receiptIdentity&&receipts.some(row=>row.receiptIdentity===receiptIdentity))return previous;
 if(e.success===true){
  if(!operationKey)return previous;
  let changed=false;
  for(const row of receipts)if(!row.recovered&&row.operationKey===operationKey&&row.nodeId===nodeId&&row.tool===tool){row.recovered=true;changed=true;}
  return changed?{version:1,total,omitted:Math.max(0,total-receipts.length),receipts}:previous;
 }
 if(e.success!==false)return previous;
 const row={sequence:total+1,at:entry.at,nodeId,tool,action:label(e.action,100),code:code(e.code)||'TOOL_FAILED',
   recovered:false,...(callId(e.callId)?{callId:callId(e.callId)}:{}),...(operationKey?{operationKey}:{}),...(receiptIdentity?{receiptIdentity}:{}),
   ...(typeof e.actionDispatched==='boolean'?{actionDispatched:e.actionDispatched}:{}),
   ...(typeof e.inputDispatched==='boolean'?{inputDispatched:e.inputDispatched}:{}),
   ...(e.commandExecution?.source==='native-workspace-process-close'&&Number.isSafeInteger(e.commandExecution.exitCode)?{exitCode:e.commandExecution.exitCode}:{})};
 receipts.push(row);
 return {version:1,total:total+1,omitted:Math.max(0,total+1-TOOL_FAILURE_HISTORY_LIMIT),receipts:receipts.slice(-TOOL_FAILURE_HISTORY_LIMIT)};
}
/** Safe Chat projection. Keep chronological failures and omit matching digests. */
export function projectToolFailureHistory(history){
 if(!history||!Array.isArray(history.receipts))return null;
 const receipts=history.receipts.slice(-TOOL_FAILURE_HISTORY_LIMIT).map(safeFailureReceipt).filter(Boolean);
 const total=Number.isSafeInteger(history.total)&&history.total>=receipts.length?history.total:receipts.length;
 return receipts.length?{version:1,total,omitted:Math.max(0,total-receipts.length),receipts}:null;
}
export const archivedToolFailureHistory=projectToolFailureHistory;

/** Retain one bounded failure, no arbitrary messages, arguments or result payloads. */
export function retainChatToolFailure(latest,entry){
  const e=entry?.data;
  if(e?.type!=='tool.result'||typeof e.tool!=='string')return latest;
  const tool=label(e.tool,100)||'Tool',nodeId=label(entry.nodeId,100),key=digest(e.operationKey);
  if(e.success===false)return {tool,action:label(e.action,100),code:code(e.code),nodeId,key,followedBySuccess:false};
  if(e.success===true&&latest?.key&&nodeId&&latest.key===key&&latest.nodeId===nodeId&&latest.tool===tool&&!latest.followedBySuccess)
    return {...latest,followedBySuccess:true};
  return latest;
}

export function archivedChatToolFailure(run){
  const saved=run.chatToolFailureReceipt??(Array.isArray(run.events)?run.events:[]).reduce((latest,event)=>
    event?.runId===run.id&&event.nodeId&&Object.hasOwn(run.nodes||{},event.nodeId)?retainChatToolFailure(latest,event):latest,undefined)??run.archivedToolFailure;
  if(!saved||!label(saved.tool,100))return null;
  return {tool:saved.tool,action:label(saved.action,100),code:code(saved.code),followedBySuccess:saved.followedBySuccess===true};
}

/** Compact projection of observed tool receipts, independent of turn delivery. */
export function chatToolFailure(run={}){
  let latest;
  for(const entry of Array.isArray(run.events)?run.events:[]){
    const event=entry?.data;
    if(event?.type!=='tool.result'||typeof event.tool!=='string')continue;
    if(event.success===false){
      latest={node:entry.nodeId,tool:event.tool.slice(0,100),action:typeof event.action==='string'?event.action.slice(0,100):'',
        key:event.operationKey,reason:typeof event.message==='string'?event.message.slice(0,300):'',code:typeof event.code==='string'?event.code.slice(0,80):'',followedBySuccess:false};
    } else if(event.success===true&&latest?.key&&latest.key===event.operationKey&&latest.node===entry.nodeId&&latest.tool===event.tool){
      latest.followedBySuccess=true;
    }
  }
  const archived=!latest;
  if(archived)latest=archivedChatToolFailure(run);
  if(!latest)return null;
  const display=[latest.tool,latest.action].filter(Boolean).join(' · ');
  const reason=latest.reason||latest.code||(archived?'Details are not kept in saved Chat.':'No reason was recorded.');
  return {label:latest.followedBySuccess?'Tool failure recorded; matching call later succeeded':'Tool failure recorded',
    detail:display+': '+reason};
}

const alarmActions=new Set('call open tabs read search snapshot click fill select press type upload download navigate attach send draft list get find plan note observe focus block start edit write delete move status previous_turn_diagnostics'.split(' '));
const alarmTools=Object.freeze({
 relay_browser:'Browser',relay_skills:'Skills',relay_workspace:'Workspace',relay_find_files:'File search',relay_files:'Task files',
 relay_email:'Email',relay_directory_action:'Action Directory',relay_task:'Planning',relay_history:'Search other chats',
 relay_agents:'Agents',relay_control:'Controls',relay_identity:'Identity',relay_apps:'Applications',relay_windows:'Windows',
 relay_browser_signin:'Browser sign-in',relay_browser_credentials:'Browser credentials',relay_prompt:'Prompts',
 'Codex command':'Codex command','Codex file edit':'Codex file edit','Connected tool':'Connected tool',
});
const cancelCodes=new Set(['ABORT_ERR','USER_STEER','TOOL_SUPERSEDED','GOAL_DEADLINE_REACHED']);
const own=(object,key)=>typeof key==='string'&&Object.hasOwn(object,key);
function alarmCode(tool,value) {
 if(value==='TOOL_UNAVAILABLE'||value==='DIRECTORY_FOCUS')return value;
 if(tool==='relay_agents'&&value==='NATIVE_AGENT_ACTION_INVALID')return value;
 if(tool==='relay_files'&&value==='ATTACHMENT_NOT_IN_TASK_SCOPE')return value;
 if(tool==='relay_browser'&&['BROWSER_REF_STALE','BROWSER_INPUT_DOCUMENT_CHANGED','BROWSER_UNAVAILABLE'].includes(value))return value;
 if(tool==='relay_skills'&&['SKILL_NOT_FOUND','SKILL_UNAVAILABLE'].includes(value))return value;
 if(tool==='relay_history'&&value==='PAST_CHATS_OFF')return value;
 if(tool==='relay_workspace'&&['ENOENT','EACCES','EPERM','WORKSPACE_ERROR','WORKSPACE_COMMAND_EXIT_NONZERO','WORKSPACE_COMMAND_TIMED_OUT','WORKSPACE_COMMAND_SIGNALLED','WORKSPACE_READ_PREVIEW_LIMIT'].includes(value))return value;
 if(tool==='relay_directory_action'&&['DIRECTORY_BLOCKER','DIRECTORY_UNKNOWN','DIRECTORY_CHANGED','DIRECTORY_NOT_READY'].includes(value))return value;
 return null;
}
const safeAlarmRow=row=>{
 const tool=own(alarmTools,row?.tool)?row.tool:'Connected tool';
 const reason=alarmCode(tool,row?.code);
 const action=typeof row?.action==='string'&&alarmActions.has(row.action)?row.action:null;
 return {tool,action,code:reason,knownNotDispatched:own(alarmTools,row?.tool)&&tool!=='Connected tool'&&row?.knownNotDispatched===true,
  count:Number.isSafeInteger(row?.count)&&row.count>0?Math.min(row.count,999999):1};
};

export function projectDiagnosticAlarms(value){
 if(!Number.isSafeInteger(value?.revision)||value.revision<1||!Array.isArray(value.rows))return null;
 const rows=value.rows.slice(0,5).map(safeAlarmRow);
 return rows.length?{revision:value.revision,rows}:null;
}
export function latestDiagnosticAlarms(known,incoming){
 const current=projectDiagnosticAlarms(known), next=projectDiagnosticAlarms(incoming);
 return next&&(!current||next.revision>current.revision)?next:current;
}
export function recordDiagnosticAlarm(previous,event){
 if(event?.type!=='tool.result'||event.success!==false||cancelCodes.has(event.code))return null;
 const prior=projectDiagnosticAlarms(previous);
 const row=safeAlarmRow({tool:event.tool,action:event.action,code:event.code,knownNotDispatched:event.actionDispatched===false});
 const key=r=>JSON.stringify([r.tool,r.action,r.code,r.knownNotDispatched]);
 const old=prior?.rows.find(r=>key(r)===key(row));
 row.count=Math.min(999999,(old?.count||0)+1);
 return {revision:Math.min(Number.MAX_SAFE_INTEGER,(prior?.revision||0)+1),rows:[row,...(prior?.rows||[]).filter(r=>key(r)!==key(row))].slice(0,5)};
}
export function diagnosticAlarmCopy(raw) {
 const row=safeAlarmRow(raw), name=alarmTools[row.tool];
 const skillLoad=row.tool==='relay_skills'&&row.action==='read';
 const title=skillLoad?'Skill load failed':name+' tool failed'+(row.action?' ('+row.action+')':'');
 let observed=skillLoad?'The skill read returned a failure.':'The tool reported failure.';
 let explanation='Root cause is not yet known.';
 switch(row.code){
  case 'BROWSER_REF_STALE':
  case 'BROWSER_INPUT_DOCUMENT_CHANGED':
   observed='The browser rejected the current page reference.';
   observed+=row.knownNotDispatched?' No page input was dispatched.':' Dispatch status is not confirmed by this receipt.';
   explanation='The page or target may have changed. This receipt does not establish why.';
   break;
  case 'TOOL_UNAVAILABLE':observed='The runtime reported that this tool was not available to the active turn.';break;
  case 'BROWSER_UNAVAILABLE':observed='The runtime reported no available contained browser.';break;
  case 'SKILL_NOT_FOUND':observed='The skill catalog could not find the requested entry.';explanation='The entry may have been deleted or requested under a different ID.';break;
  case 'SKILL_UNAVAILABLE':observed='The runtime could not load the requested skill.';explanation='The receipt does not identify which catalog or storage check failed.';break;
  case 'WORKSPACE_COMMAND_EXIT_NONZERO':observed='The launched workspace shell command exited with a nonzero code.';explanation='The shell or child program failed; this is not proof that the workspace adapter malfunctioned. Inspect the saved stderr and command syntax, including nested PowerShell/Node quoting. The effects of that command have not been assessed.';break;
  case 'WORKSPACE_COMMAND_TIMED_OUT':observed='The workspace command exceeded its execution deadline.';explanation='The process may have performed partial effects. Inspect saved output and state before retrying.';break;
  case 'WORKSPACE_COMMAND_SIGNALLED':observed='The workspace command process ended with a signal.';explanation='Partial effects are unknown; inspect its saved command receipt.';break;
  case 'WORKSPACE_READ_PREVIEW_LIMIT':observed='The workspace reader reached its bounded preview limit.';explanation='Use a specific range or a bounded command; this is not evidence that the file was missing.';break;
  case 'WORKSPACE_ERROR':observed='The workspace adapter returned an error.';explanation='Inspect the exact saved tool error and operation; this generic code does not identify a root cause.';break;
  case 'ENOENT':observed='The workspace tool did not find the file or a folder in its path.';explanation='The path may have moved, been typed differently, or pointed to a folder that is not present.';break;
  case 'EACCES':
  case 'EPERM':observed='The operating system did not let the workspace tool access the path.';explanation='Check this file or folder’s access and whether another app is holding it. A permission error does not mean the file is missing.';break;
  case 'PAST_CHATS_OFF':observed='The tool denied the unrelated chat lookup because Search other chats is Off.';explanation='This setting does not block current-chat continuity.';break;
  case 'DIRECTORY_FOCUS':observed='Action Directory rejected the call before the tool ran.';explanation='The call required an active action in the outline. Check that the tool and action are valid before retrying.';break;
  case 'NATIVE_AGENT_ACTION_INVALID':observed='The requested Agents action does not exist.';explanation='Use list or get for saved runs, or Workspace read for a local file.';break;
  case 'ATTACHMENT_NOT_IN_TASK_SCOPE':observed='The attachment reader rejected an ID outside this task.';explanation='For files on disk, use Workspace read with the file path.';break;
  case 'DIRECTORY_BLOCKER':observed='Action Directory rejected the proposed block.';explanation='A candidate may have failed without demonstrating that the whole action is blocked.';break;
  case 'DIRECTORY_UNKNOWN':observed='Action Directory recorded an unresolved attempt.';explanation='This is not proof that the effect happened or that it did not.';break;
  case 'DIRECTORY_CHANGED':observed='The action outline changed before the operation could use the prior revision.';explanation='The receipt does not say who changed it.';break;
  case 'DIRECTORY_NOT_READY':observed='Action Directory rejected the attempt to focus an action that was not ready.';break;
 }
 return {title,observed,explanation,code:row.code,count:row.count};
}
