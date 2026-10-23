import {createHash} from 'node:crypto';
const brief=value=>String(value??'').replace(/\s+/g,' ').trim().slice(0,1200);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const taskWrites=new Set(['plan','step','checkpoint','artifact','edit']);
// A revision conflict confirms that this attempted write was not applied. Its
// retry can recover the same mutation after a fresh read without changing the
// exact operation identity used for every other outcome. Keep all target and
// payload fields, including any nested revision data, in this separate digest.
function taskConflictKey(tool,args){
 if(tool!=='relay_task'||!args||typeof args!=='object'||Array.isArray(args)||!taskWrites.has(args.action)||!Number.isSafeInteger(args.expectedRevision)||args.expectedRevision<1)return undefined;
 const {expectedRevision,...mutation}=args;
 return createHash('sha256').update(JSON.stringify(['TASK_STATE_CONFLICT',tool,canonical(mutation)])).digest('hex');
}
/** Emit a bounded, explicit receipt for both successful calls and returned failures. */
export function toolResultEvent(call={},result={},redact=value=>value){
 let args=call.arguments;try{if(typeof args==='string')args=JSON.parse(args);}catch{}
 const tool=brief(call.name||call.tool||'Unknown tool').slice(0,160),action=brief(args?.action||'call').slice(0,100),integration=brief(args?.name||'').slice(0,160),connectionId=brief(args?.connectionId||'').slice(0,160);
 const operationKey=createHash('sha256').update(JSON.stringify([tool,canonical(args??null)])).digest('hex');
 // Operational content and appended Planning metadata are independent blocks.
 // Joining their JSON strings can hide a real nonzero exitCode/ok:false result.
 const texts=(result.contentItems||[]).filter(item=>item.type==='inputText').map(item=>item.text||'').filter((text,index)=>{
  if(index===0)return true;try{return !['planning.execution','planning.execution-warning','planning.awareness'].includes(JSON.parse(text)?.type);}catch{return true;}
 });
 let message=texts.join('\n')||result.message||'';
 const details=(texts.length?texts:[message]).flatMap(text=>{try{const value=JSON.parse(text);return value&&typeof value==='object'?[value]:[];}catch{return[];}});
 const detail=details.find(value=>value.success===false||value.isError===true||value.ok===false||Number.isInteger(value.exitCode)&&value.exitCode!==0)||details[0];
 const failed=result.success!==true||detail?.success===false||detail?.isError===true||detail?.ok===false||Number.isInteger(detail?.exitCode)&&detail.exitCode!==0;
 const code=failed?brief(result.code||detail?.code||detail?.error?.code||'TOOL_FAILED').slice(0,100):undefined;
 const recoveryKey=!failed||code==='TASK_STATE_CONFLICT'?taskConflictKey(tool,args):undefined;
 message=failed?typeof detail?.error==='string'?detail.error:detail?.error?.message||detail?.message||(Number.isInteger(detail?.exitCode)?`Command exited with code ${detail.exitCode}.`:message)||'The tool did not complete.':'Tool completed.';
 return{type:'tool.result',tool,action,operationKey,...(recoveryKey?{recoveryKey}:{}),...(integration?{integration}:{}),...(connectionId?{connectionId}:{}),...(call.callId?{callId:brief(call.callId).slice(0,160)}:{}),success:!failed,status:failed?'failed':'completed',...(failed?{message:brief(redact(String(message))),code}:{})};
}
/** Native Codex actions do not pass through the Relay dynamic-tool handler. */
export function nativeToolResultEvent(item={}){
 if(!['commandExecution','fileChange','mcpToolCall'].includes(item.type))return null;
 const failed=['failed','declined','rejected'].includes(item.status)||Boolean(item.error)||item.result?.isError===true||Number.isInteger(item.exitCode)&&item.exitCode!==0;
 const message=item.error?.message||item.error||item.result?.error?.message||(Number.isInteger(item.exitCode)&&item.exitCode!==0?`Command exited with code ${item.exitCode}.`:failed?'The native tool did not complete.':undefined);
 return toolResultEvent({name:item.type==='commandExecution'?'Codex command':item.type==='fileChange'?'Codex file edit':`MCP ${item.server||''}`.trim(),callId:item.id,arguments:{action:item.tool||item.type,command:item.command,changes:item.changes,arguments:item.arguments}}, {success:!failed,...(message?{message:String(message)}:{})});
}
