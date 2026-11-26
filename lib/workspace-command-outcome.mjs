// A native process close receipt describes execution, not the semantic
// effects of an arbitrary shell command. Do not infer no effects from exit 1.
import {createHash} from 'node:crypto';
const digest=text=>createHash('sha256').update(text).digest('hex');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function identity(call){
  if(call?.namespace||call?.name!=='relay_workspace')return null;
  let args=call.arguments;
  if(typeof args==='string')try{args=JSON.parse(args);}catch{return null;}
  if(!object(args))return null;
  if(args.action==='run'&&typeof args.command==='string'&&args.command)return digest(JSON.stringify([call.callId??null,args.command,args.cwd??null,args.timeoutMs??null]));
  if(args.action==='run_js'&&typeof args.script==='string'&&args.script)return digest(JSON.stringify(['node-direct-script',call.callId??null,args.script,args.cwd??null,args.timeoutMs??null]));
  return null;
}
const firstText=result=>result?.contentItems?.[0]?.type==='inputText'&&typeof result.contentItems[0].text==='string'?result.contentItems[0].text:null;
const statusOf=({exitCode,signal,timedOut})=>timedOut?'timed-out':signal?'signalled':Number.isInteger(exitCode)?'exited':'unknown';
/** Called only by the native workspace adapter after its child close event. */
export function attachWorkspaceCommandOutcome(call,result,ran){
  const requestIdentity=identity(call),text=firstText(result);
  if(!requestIdentity||text===null)return result;
  const {exitCode,signal,timedOut,cwd}=ran;
  const status=statusOf(ran);
  const code=status==='timed-out'?'WORKSPACE_COMMAND_TIMED_OUT':status==='signalled'?'WORKSPACE_COMMAND_SIGNALLED':
    status==='exited'&&exitCode!==0?'WORKSPACE_COMMAND_EXIT_NONZERO':status==='unknown'?'WORKSPACE_COMMAND_OUTCOME_UNKNOWN':undefined;
  return {...result,...(code?{code}:{}),commandExecution:{version:1,source:'native-workspace-process-close',
    requestIdentity,resultTextSha256:digest(text),status,exitCode,signal,timedOut,cwd,
    effectOutcome:'not-assessed'}};
}
/** Bind the host receipt to the original request and delivered first result.
 * Neither model prose, shell stdout, nor a legacy exit-code-shaped JSON blob
 * establishes this provenance. Keep interrupted/malformed cases unresolved.
 */
export function readWorkspaceCommandOutcome(call,result){
  const meta=result?.commandExecution,text=firstText(result),requestIdentity=identity(call);
  if(!requestIdentity||!object(meta)||meta.version!==1||meta.source!=='native-workspace-process-close'||
    meta.requestIdentity!==requestIdentity||text===null||meta.resultTextSha256!==digest(text)||
    meta.effectOutcome!=='not-assessed'||typeof meta.cwd!=='string'||!meta.cwd||
    !(meta.exitCode===null||Number.isInteger(meta.exitCode))||
    !(meta.signal===null||typeof meta.signal==='string'&&meta.signal.length>0)||
    typeof meta.timedOut!=='boolean'||meta.status!==statusOf(meta))return null;
  if(meta.status==='exited'&&(meta.signal!==null||meta.timedOut!==false))return null;
  const success=meta.status==='exited'&&meta.exitCode===0;
  if(result.success!==success||result.actionDispatched===false)return null;
  let body;try{body=JSON.parse(text);}catch{return null;}
  if(!object(body)||body.actionDispatched===false||body.cwd!==meta.cwd||
    body.exitCode!==meta.exitCode||body.signal!==meta.signal||body.timedOut!==meta.timedOut)return null;
  return {source:meta.source,status:meta.status,exitCode:meta.exitCode,signal:meta.signal,
    timedOut:meta.timedOut,effectOutcome:meta.effectOutcome,requestIdentity,resultTextSha256:meta.resultTextSha256};
}
