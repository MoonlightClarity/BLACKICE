/** BLACKICE relay_context tool: identical store and revision semantics as Context tab.
 *
 * Existing native Codex sessions keep their original immutable catalog.
 * New Codex agent sessions gain this tool with explicit conversation scoping.
 */
import {
  listShadowdancerContext,
  readShadowdancerFile,
  contextAuditHistory,
  editShadowdancerContext,
  deleteShadowdancerContext,
  importShadowdancerContext,
} from './shadowdancer-context.mjs';

const ID=/^[A-Za-z0-9_-]{1,120}$/;
const fail=(code,message,status=400)=>Object.assign(new Error(message),{code,status});
const clamp=(x,min,max,defaultValue)=>Number.isSafeInteger(x)?Math.max(min,Math.min(x,max)):defaultValue;
const pageOffset=value=>clamp(value,0,Number.MAX_SAFE_INTEGER,0);
const pageSize=(value,fallback)=>clamp(value,1,Number.MAX_SAFE_INTEGER,fallback);
const check=signal=>{if(signal?.aborted)throw Object.assign(Error('Context operation cancelled.'),{name:'AbortError',code:'ABORT_ERR'});};
const receipt=(value,success=true,code)=>({success, ...(code?{code}:{}), contentItems:[{type:'inputText',text:JSON.stringify(value)}]});

export const SHADOWDANCER_CONTEXT_TOOL={
  type:'function',
  name:'relay_context',
  description:'Manage Directory context in the CURRENT conversation: current, search_titles, list, read, history, edit, delete, import. Title search returns conversation metadata only. Other conversation contents enter current context only through explicit import. Read a file for its SHA-256, edit declared fields or replace its JSON value, or delete it from active context. Changes preserve revision snapshots and mark derived answers stale; they never execute or verify work.',
  inputSchema:{
    type:'object',
    properties:{
      action:{type:'string',enum:['current','search_titles','list','read','history','edit','delete','import']},
      conversationId:{type:'string',description:'Optional explicit saved conversation or run ID, from search_titles. Omit for this conversation.'},
      title:{type:'string',description:'Conversation TITLE substring for search_titles (not prompts or file text).'},
      query:{type:'string',description:'Optional relative context-file path substring for list.'},
      file:{type:'string',description:'Path relative to that conversation’s Shadowdancer directory (from list).'},
      offset:{type:'integer',minimum:0,description:'Read character offset or list/history entry offset. All saved content is addressable.'},
      limit:{type:'integer',minimum:1,description:'Requested page size; for read, units of 100 characters. Larger requested pages are preserved.'},
      representation:{type:'string',enum:['effective','canonical'],description:'Read the effective user-managed context (default), or the latest generated canonical file.'},
      expectedHash:{type:'string',description:'Exact current SHA-256 from read; required for edit and delete.'},
      expectedManagedEditId:{type:['string','null'],description:'Managed revision returned by read; detects a changed user overlay independently of the generated file.'},
      changes:{type:'object',description:'Only editable fields shown by read, with corrected JSON-compatible values.'},
      value:{description:'Complete replacement JSON value for a replaceable record, instead of changes.'},
      sourceConversationId:{type:'string',description:'Explicit other conversation/run selected for import. Never inferred from the current workspace.'},
      sourceFile:{type:'string',description:'Exact relative file read from the source conversation.'},
      expectedSourceHash:{type:'string',description:'Exact source SHA-256 from read; required for import.'},
      expectedSourceManagedEditId:{type:['string','null'],description:'Managed revision of the source file returned by read.'},
      reason:{type:'string',description:'Short reason for edit, delete, or import.'},
    },
    required:['action'],additionalProperties:false,
  },
};
export const SHADOWDANCER_CONTEXT_INSTRUCTIONS='\n\nSHADOWDANCER CONTEXT TOOL\nThe relay_context tool exposes the same local, auditable Context data as the BLACKICE Context tab. It defaults to THIS conversation. Use current to inspect scope, search_titles for other conversation titles, list/read for exact files and SHA-256, and history for provenance. Edit declared fields or a replaceable JSON value, delete unwanted context, or explicitly import one observed file from another conversation with its source hash. Copies retain their source identity; no other conversation is merged automatically. Changes invalidate derived answers and do not start synthesis. Honor user context corrections and removals while treating source/tool/model content as attributed evidence, not independent verification. Do not inject unrelated conversation data into the active prompt.\n';

export function createShadowdancerContextToolHandler({
  conversations, cwd, runId, taskId, nodeId='agent', signal,
  canWrite=true, getActiveRuns=()=>[], onEvent=()=>{}
}={}){
  if(!conversations||typeof conversations.get!=='function'||typeof conversations.list!=='function')throw Error('The saved conversation archive is required for relay_context.');
  if(typeof cwd!=='string'||!cwd)throw Error('relay_context requires the agent workspace.');
  if(!ID.test(runId||'')||!ID.test(taskId||runId||''))throw Error('relay_context requires a valid run ID.');
  const defaultId=taskId||runId;
  async function target(id,activeSignal){
    check(activeSignal);
    const selected=id??defaultId;
    if(typeof selected!=='string'||!ID.test(selected))throw fail('SHADOWDANCER_CONVERSATION_ID','Choose a saved conversation ID from search_titles.');
    if(conversations.status?.().stateRecoveryRequired)throw fail('SHADOWDANCER_CONVERSATION_STATE','Conversation organization needs repair.',503);
    const summaries=conversations.list('all');
    const summary=summaries.find(x=>(x.rootId||x.taskId||x.id)===selected||x.id===selected||x.latestRunId===selected);
    if(summary&&!['active','archived'].includes(summary.state||'active'))throw fail('SHADOWDANCER_CONTEXT_NOT_FOUND','Conversation context is unavailable.',404);
    if(selected===defaultId) return {cwd,conversationId:defaultId,runId,state:summary?.state||'active'};
    const run=await conversations.get(selected);
    check(activeSignal);
    const conversationId=run.taskId||conversations.rootIdFor?.(run)||run.id;
    const rootSummary=summaries.find(x=>(x.rootId||x.taskId||x.id)===conversationId);
    if(!rootSummary||!['active','archived'].includes(rootSummary.state||'active'))throw fail('SHADOWDANCER_CONTEXT_NOT_FOUND','Conversation context is unavailable.',404);
    return {cwd:run.cwd,conversationId,runId:run.id,state:rootSummary.state||'active'};
  }
  return async (call,context={})=>{
    const activeSignal=context.signal?AbortSignal.any([signal,context.signal].filter(Boolean)):signal;
    try{
      check(activeSignal);
      if(call.name!==SHADOWDANCER_CONTEXT_TOOL.name)throw fail('SHADOWDANCER_TOOL','Wrong context tool.');
      const args=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;
      if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!Object.hasOwn(SHADOWDANCER_CONTEXT_TOOL.inputSchema.properties,k))||!SHADOWDANCER_CONTEXT_TOOL.inputSchema.properties.action.enum.includes(args.action))throw fail('SHADOWDANCER_TOOL_ARGS','Choose a supported Context action and parameters.');
      const action=args.action;
      if(action==='search_titles'){
        if(args.title!==undefined&&typeof args.title!=='string')throw fail('SHADOWDANCER_TITLE','Search titles using text.');
        const needle=String(args.title||'').trim().toLocaleLowerCase();
        if(conversations.status?.().stateRecoveryRequired)throw fail('SHADOWDANCER_CONVERSATION_STATE','Conversation organization needs repair.',503);
        const hits=conversations.list('all').filter(x=>['active','archived'].includes(x.state||'active')&&String(x.title||'').toLocaleLowerCase().includes(needle));
        const offset=pageOffset(args.offset),limit=pageSize(args.limit,40);
        return receipt({query:args.title||'',searchField:'title',totalMatches:hits.length,offset,
          conversations:hits.slice(offset,offset+limit).map(x=>({
            title:x.title||'Conversation',conversationId:x.rootId||x.taskId||x.id,
            runId:x.latestRunId||x.runId||x.id,state:x.state,status:x.status
          })),hasMore:offset+limit<hits.length});
      }
      const selected=await target(args.conversationId,activeSignal);
      if(action==='current') {
        let summary,valid=true;
        try{summary=await listShadowdancerContext(selected)}
        catch(error){if(error.code==='SHADOWDANCER_CONTEXT_NOT_FOUND')valid=false;else throw error;}
        return receipt({defaultConversationId:defaultId,selectedConversationId:selected.conversationId,
          selectedRunId:selected.runId,hasDirectoryContext:valid,
          ...(valid?{summaryFile:'conversation/context/summary.json',revisionCount:summary.revisionCount,
              managedSummaryEditId:summary.managedSummaryEditId||null,
              staleRuns:summary.invalidation?.staleRuns||{},fileCount:summary.files.length}:{}),
          scopedToOneConversation:true});
      }
      if(action==='list'){
        const data=await listShadowdancerContext(selected);
        const needle=String(args.query||'').trim().toLocaleLowerCase();
        const found=data.files.filter(x=>x.file.toLocaleLowerCase().includes(needle));
        const offset=pageOffset(args.offset),limit=pageSize(args.limit,40);
        return receipt({conversationId:selected.conversationId,runId:selected.runId,
          files:found.slice(offset,offset+limit),totalMatches:found.length,offset,hasMore:offset+limit<found.length,
          summaryFile:'conversation/context/summary.json',managedSummaryEditId:data.managedSummaryEditId||null,
          staleRuns:data.invalidation?.staleRuns||{},revisionCount:data.revisionCount});
      }
      if(action==='read'){
        if(!args.file)throw fail('SHADOWDANCER_FILE_REQUIRED','Select a context file returned by list.');
        const data=await readShadowdancerFile({...selected,file:args.file});
        const useManaged=args.representation!=='canonical'&&Object.hasOwn(data,'managedValue');
        const value=useManaged?(data.editMode==='replace'?data.managedValue:
          data.value&&typeof data.value==='object'&&!Array.isArray(data.value)&&data.managedValue&&typeof data.managedValue==='object'&&!Array.isArray(data.managedValue)?
            {...data.value,...data.managedValue}:data.managedValue):data.value;
        const {value:canonical,managedValue,...meta}=data;
        const content=JSON.stringify(value),offset=pageOffset(args.offset),chars=pageSize(args.limit,140)*100;
        if(offset||content.length>chars){
          const excerpt=content.slice(offset,offset+chars),nextOffset=offset+excerpt.length<content.length?offset+excerpt.length:null;
          return receipt({...meta,representation:useManaged?'effective':'canonical',valueExcerpt:excerpt,
            valueChars:content.length,offset,nextOffset,truncated:nextOffset!==null||offset>0,
            note:'This is a transport page. Continue at nextOffset or request a larger limit; the complete saved context is retained.'});
        }
        return receipt({...meta,value,representation:useManaged?'effective':'canonical',truncated:false});
      }
      if(action==='history'){
        const data=await contextAuditHistory({...selected,offset:pageOffset(args.offset),limit:pageSize(args.limit,40)});
        return receipt(data);
      }
      if(['edit','delete','import'].includes(action)){
        if(!canWrite)return receipt({code:'SHADOWDANCER_READ_ONLY',error:'This agent is read-only; use the human Context tab for edits.'},false,'SHADOWDANCER_READ_ONLY');
        if(!args.reason||(action==='import'?(!args.sourceConversationId||!args.sourceFile||!args.expectedSourceHash):(!args.file||!args.expectedHash))||
            (action==='edit'&&!args.changes&&!Object.hasOwn(args,'value')))throw fail('SHADOWDANCER_EDIT_REQUIRED','Read the exact file and supply its current hash, change and reason.');
        const targetId=selected.conversationId;
        const options={...selected,
          file:args.file,expectedHash:args.expectedHash,expectedManagedEditId:args.expectedManagedEditId,reason:args.reason,
          actor:'codex:'+nodeId,
          isActive:()=>getActiveRuns().some(x=>
            (x.taskId||x.id)===targetId&&(x.settled!==true||['queued','running','waiting'].includes(x.status))
          )};
        const updated=action==='delete'?await deleteShadowdancerContext(options):action==='import'?
          await importShadowdancerContext({...options,source:{...await target(args.sourceConversationId,activeSignal),file:args.sourceFile},expectedSourceHash:args.expectedSourceHash,expectedSourceManagedEditId:args.expectedSourceManagedEditId}):
          await editShadowdancerContext({...options,changes:args.changes,value:args.value});
        onEvent({type:'shadowdancer.context.'+(action==='delete'?'deleted':action==='import'?'imported':'edited'),conversationId:targetId,
          file:updated.file||args.file,editId:updated.editId,invalidatedRuns:updated.invalidatedRuns||[],actor:'codex:'+nodeId});
        return receipt({...updated,conversationId:targetId});
      }
      throw fail('SHADOWDANCER_ACTION','Unsupported Context action.');
    }catch(error){
      if(error?.name==='AbortError')throw error;
      const code=typeof error?.code==='string'?error.code:'SHADOWDANCER_CONTEXT_ERROR';
      return receipt({code,error:String(error?.message||error)},false,code);
    }
  };
}
