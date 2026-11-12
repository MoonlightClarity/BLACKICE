/** Authenticated server hook for one conversation's Directory evidence. */
import {listShadowdancerContext,readShadowdancerFile,contextAuditHistory,editShadowdancerContext,deleteShadowdancerContext,importShadowdancerContext} from './shadowdancer-context.mjs';
const fail=(code,message,status=400)=>Object.assign(Error(message),{code,status});
const ID=/^[A-Za-z0-9_-]{1,100}$/;
export async function resolveDirectoryContext({conversations,runId,write=false}){
  if(!ID.test(runId||''))throw fail('SHADOWDANCER_CONVERSATION_ID','Choose a saved conversation.');
  if(conversations.status?.().stateRecoveryRequired)throw fail('SHADOWDANCER_CONVERSATION_STATE','Conversation organization needs repair.',503);
  const run=await conversations.get(runId);
  const conversationId=run.taskId||conversations.rootIdFor?.(run)||run.id;
  const summary=conversations.list('all').find(x=>(x.rootId||x.taskId||x.id)===conversationId||x.id===runId);
  if(!summary||!['active','archived'].includes(summary.state||'active'))throw fail('SHADOWDANCER_CONTEXT_NOT_FOUND','Conversation context is unavailable.',404);
  return {cwd:run.cwd,conversationId,runId:run.id};
}
export async function listDirectoryContextConversations({conversations,runId}){
  const selected=await resolveDirectoryContext({conversations,runId});
  const groups=new Map();
  for(const row of conversations.list('all')){
    if(!['active','archived'].includes(row.state||'active'))continue;
    const conversationId=row.rootId||row.taskId||row.id;
    if(groups.has(conversationId))continue;
    groups.set(conversationId,{conversationId,runId:row.latestRunId||row.runId||row.id,
      latestRunId:row.latestRunId||row.runId||row.id,title:row.title||'Conversation',
      state:row.state||'active',status:row.status||null,updatedAt:row.updatedAt||row.createdAt||null,
      current:conversationId===selected.conversationId});
  }
  return {currentConversationId:selected.conversationId,conversations:[...groups.values()],metadataOnly:true};
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
    if(!['','/file','/audit','/edit','/delete','/import','/conversations'].includes(suffix))throw fail('SHADOWDANCER_ACTION','Unsupported Directory context action.',404);
    const mutation=['/edit','/delete','/import'].includes(suffix);
    if(req.method!==(mutation?'POST':'GET'))throw fail('SHADOWDANCER_METHOD','Unsupported Directory context method.',405);
    const params=new URL(req.url,'http://'+host).searchParams;
    const keys=mutation?[]:suffix==='/file'?['runId','file']:suffix==='/audit'?['runId','offset','limit']:['runId'];
    if([...params.keys()].some(k=>!keys.includes(k)||params.getAll(k).length!==1))throw fail('SHADOWDANCER_QUERY','Use each supported context parameter once.');
    if(mutation){
      // These are owner-authored context documents. Their length is determined
      // by the document, not an arbitrary UI or model-context token allowance.
      const value=await body(req,Infinity);
      const allowed=suffix==='/import'?['runId','sourceRunId','sourceFile','expectedSourceHash','expectedSourceManagedEditId','expectedHash','reason']:
        suffix==='/delete'?['runId','file','expectedHash','expectedManagedEditId','reason']:['runId','file','expectedHash','expectedManagedEditId','changes','value','reason'];
      if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(k=>!allowed.includes(k)))throw fail('SHADOWDANCER_EDIT','Use the supported context change fields.');
      const selected=await resolveDirectoryContext({conversations,runId:value.runId,write:true});
      const common={...selected,file:value.file,expectedHash:value.expectedHash,expectedManagedEditId:value.expectedManagedEditId,reason:value.reason,actor:'local-user',
        isActive:()=>directoryContextIsActive(engine,selected.conversationId)};
      let pending;
      if(suffix==='/import'){
        const source=await resolveDirectoryContext({conversations,runId:value.sourceRunId});
        pending=importShadowdancerContext({...common,source:{...source,file:value.sourceFile},expectedSourceHash:value.expectedSourceHash??value.expectedHash,expectedSourceManagedEditId:value.expectedSourceManagedEditId});
      }else if(suffix==='/delete')pending=deleteShadowdancerContext(common);
      else pending=editShadowdancerContext({...common,changes:value.changes,value:value.value});
      fileMutations.add(pending);
      try{
        const result=await pending;
        onUpdated({type:'shadowdancer.context.'+(suffix==='/delete'?'deleted':suffix==='/import'?'imported':'edited'),conversationId:selected.conversationId,file:result.file||value.file,editId:result.editId,invalidatedRuns:result.invalidatedRuns||[]});
        json(res,200,result);
      }finally{fileMutations.delete(pending);}
    }else if(suffix==='/conversations'){
      json(res,200,await listDirectoryContextConversations({conversations,runId:params.get('runId')}));
    }else{
      const selected=await resolveDirectoryContext({conversations,runId:params.get('runId')});
      const result=suffix==='/file'?await readShadowdancerFile({...selected,file:params.get('file')}):
        suffix==='/audit'?await contextAuditHistory({...selected,
          ...(params.has('offset')?{offset:Number(params.get('offset'))}:{}),
          ...(params.has('limit')?{limit:Number(params.get('limit'))}:{})}):await listShadowdancerContext(selected);
      json(res,200,result);
    }
  }catch(error){json(res,error.status||400,{error:error.message,code:error.code||'SHADOWDANCER_CONTEXT_ERROR'});}
  return true;
}
