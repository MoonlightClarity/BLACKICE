/** Authenticated server hook for one conversation's Directory evidence. */
import {listShadowdancerContext,readShadowdancerFile,contextAuditHistory,editShadowdancerContext} from './shadowdancer-context.mjs';
const fail=(code,message,status=400)=>Object.assign(Error(message),{code,status});
const ID=/^[A-Za-z0-9_-]{1,100}$/;
export async function resolveDirectoryContext({conversations,runId,write=false}){
  if(!ID.test(runId||''))throw fail('SHADOWDANCER_CONVERSATION_ID','Choose a saved conversation.');
  if(conversations.status?.().stateRecoveryRequired)throw fail('SHADOWDANCER_CONVERSATION_STATE','Conversation organization needs repair.',503);
  const run=await conversations.get(runId);
  const conversationId=run.taskId||run.id;
  const summary=conversations.list('all').find(x=>(x.rootId||x.taskId||x.id)===conversationId||x.id===runId);
  if(!summary||!['active','archived'].includes(summary.state||'active'))throw fail('SHADOWDANCER_CONTEXT_NOT_FOUND','Conversation context is unavailable.',404);
  if(write&&summary.state==='archived')throw fail('SHADOWDANCER_ARCHIVED','Restore the conversation before editing its context.',409);
  return {cwd:run.cwd,conversationId,runId:run.id};
}
export function directoryContextIsActive(engine,conversationId){
  return [...engine.runs.values()].some(run=>(run.taskId||run.id)===conversationId&&
    (run.settled!==true||['queued','running','waiting'].includes(run.status)));
}
export async function handleShadowdancerContextHttp({req,res,pathname,host,conversations,engine,body,json,fileMutations,onUpdated=()=>{}}){
  const base='/api/shadowdancer/context';
  if(pathname!==base&&!pathname.startsWith(base+'/'))return false;
  try{
    const suffix=pathname.slice(base.length);
    if(!['','/file','/audit','/edit'].includes(suffix))throw fail('SHADOWDANCER_ACTION','Unsupported Directory context action.',404);
    if(req.method!==(suffix==='/edit'?'POST':'GET'))throw fail('SHADOWDANCER_METHOD','Unsupported Directory context method.',405);
    const params=new URL(req.url,'http://'+host).searchParams;
    const keys=suffix==='/edit'?[]:suffix==='/file'?['runId','file']:['runId'];
    if([...params.keys()].some(k=>!keys.includes(k)||params.getAll(k).length!==1))throw fail('SHADOWDANCER_QUERY','Use each supported context parameter once.');
    if(suffix==='/edit'){
      const value=await body(req,110000);
      if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(k=>!['runId','file','expectedHash','changes','reason'].includes(k)))throw fail('SHADOWDANCER_EDIT','Use the supported context edit fields.');
      const selected=await resolveDirectoryContext({conversations,runId:value.runId,write:true});
      const pending=editShadowdancerContext({...selected,file:value.file,expectedHash:value.expectedHash,changes:value.changes,reason:value.reason,actor:'local-user',
        isActive:()=>directoryContextIsActive(engine,selected.conversationId)});
      fileMutations.add(pending);
      try{
        const result=await pending;
        onUpdated({type:'shadowdancer.context.edited',conversationId:selected.conversationId,file:value.file,editId:result.editId,invalidatedRuns:result.invalidatedRuns||[]});
        json(res,200,result);
      }finally{fileMutations.delete(pending);}
    }else{
      const selected=await resolveDirectoryContext({conversations,runId:params.get('runId')});
      const result=suffix==='/file'?await readShadowdancerFile({...selected,file:params.get('file')}):
        suffix==='/audit'?await contextAuditHistory(selected):await listShadowdancerContext(selected);
      json(res,200,result);
    }
  }catch(error){json(res,error.status||400,{error:error.message,code:error.code||'SHADOWDANCER_CONTEXT_ERROR'});}
  return true;
}
