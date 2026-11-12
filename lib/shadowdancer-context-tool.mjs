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
} from './shadowdancer-context.mjs';

const ID=/^[A-Za-z0-9_-]{1,120}$/;
const MAX_LIST=80;
const fail=(code,message,status=400)=>Object.assign(new Error(message),{code,status});
const clamp=(x,min,max,defaultValue)=>Number.isSafeInteger(x)?Math.max(min,Math.min(x,max)):defaultValue;
const check=signal=>{if(signal?.aborted)throw Object.assign(Error('Context operation cancelled.'),{name:'AbortError',code:'ABORT_ERR'});};
const receipt=(value,success=true,code)=>({success, ...(code?{code}:{}), contentItems:[{type:'inputText',text:JSON.stringify(value)}]});

export const SHADOWDANCER_CONTEXT_TOOL={
  type:'function',
  name:'relay_context',
  description:'Auditable Shadowdancer context for BLACKICE conversations. Defaults to the CURRENT conversation: current, search_titles, list, read, history, edit. Filter conversations by their saved TITLES; never merge different conversations implicitly. Read source provenance, module result files, labeled turns and synthesis references. Edit user-authorable fields only with an observed SHA-256 expectedHash and a revision reason. Edits preserve immutable before/after revisions and mark previous syntheses stale.',
  inputSchema:{
    type:'object',
    properties:{
      action:{type:'string',enum:['current','search_titles','list','read','history','edit']},
      conversationId:{type:'string',description:'Optional explicit saved conversation or run ID, from search_titles. Omit for this conversation.'},
      title:{type:'string',description:'Conversation TITLE substring for search_titles (not prompts or file text).'},
      query:{type:'string',description:'Optional relative context-file path substring for list.'},
      file:{type:'string',description:'Path relative to that conversation’s Shadowdancer directory (from list).'},
      offset:{type:'integer',minimum:0,maximum:1000000},
      limit:{type:'integer',minimum:1,maximum:120},
      expectedHash:{type:'string',description:'Exact current SHA-256 from read; required for edit.'},
      changes:{type:'object',description:'Only editable fields shown by read, with corrected JSON-compatible values.'},
      reason:{type:'string',description:'Explicit revision reason; required for edit.'},
    },
    required:['action'],additionalProperties:false,
  },
};
export const SHADOWDANCER_CONTEXT_INSTRUCTIONS='\n\nSHADOWDANCER CONTEXT TOOL\nThe relay_context tool exposes the same local, auditable Context data as the BLACKICE Context tab. It defaults to THIS conversation, not all BLACKICE history. Use current to inspect scope, search_titles to find other conversations by saved title, list to discover that conversation’s files, read to inspect exact JSON and SHA-256, and history for provenance. A context edit requires a current observed SHA-256 and an explicit reason; it creates a durable audit revision, invalidates downstream synthesized results, and does NOT automatically re-run synthesis. Never claim a stale synthesis is current or treat model-generated text as independently verified. In a saved Codex session lacking relay_context, do not invent the tool: start a new session for the updated catalog. Do not inject unrelated conversation data into the active prompt.\n';

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
    const rootSummary=summaries.find(x=>(x.rootId||x.taskId||x.id)===(run.taskId||run.id));
    if(!rootSummary||!['active','archived'].includes(rootSummary.state||'active'))throw fail('SHADOWDANCER_CONTEXT_NOT_FOUND','Conversation context is unavailable.',404);
    return {cwd:run.cwd,conversationId:run.taskId||run.id,runId:run.id,state:rootSummary.state||'active'};
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
        if(args.title!==undefined&&(typeof args.title!=='string'||args.title.length>120))throw fail('SHADOWDANCER_TITLE','Search titles with at most 120 characters.');
        const needle=String(args.title||'').trim().toLocaleLowerCase();
        if(conversations.status?.().stateRecoveryRequired)throw fail('SHADOWDANCER_CONVERSATION_STATE','Conversation organization needs repair.',503);
        const hits=conversations.list('all').filter(x=>['active','archived'].includes(x.state||'active')&&String(x.title||'').toLocaleLowerCase().includes(needle));
        const offset=clamp(args.offset,0,1000000,0),limit=clamp(args.limit,1,100,40);
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
          ...(valid?{summary:summary.summary,revisionCount:summary.revisionCount,
              staleRuns:summary.invalidation?.staleRuns||{},fileCount:summary.files.length}:{}),
          scopedToOneConversation:true});
      }
      if(action==='list'){
        const data=await listShadowdancerContext(selected);
        const needle=String(args.query||'').trim().toLocaleLowerCase();
        if(needle.length>180)throw fail('SHADOWDANCER_QUERY','Use a file query of at most 180 characters.');
        const found=data.files.filter(x=>x.file.toLocaleLowerCase().includes(needle));
        const offset=clamp(args.offset,0,1000000,0),limit=clamp(args.limit,1,MAX_LIST,40);
        return receipt({conversationId:selected.conversationId,runId:selected.runId,
          files:found.slice(offset,offset+limit),totalMatches:found.length,offset,hasMore:offset+limit<found.length,
          summary:data.summary,staleRuns:data.invalidation?.staleRuns||{},revisionCount:data.revisionCount});
      }
      if(action==='read'){
        if(!args.file)throw fail('SHADOWDANCER_FILE_REQUIRED','Select a context file returned by list.');
        const data=await readShadowdancerFile({...selected,file:args.file});
        // Preserve full values only within a small bounded model-tool return.
        const content=JSON.stringify(data.value);
        if(content.length>14000){
          const offset=clamp(args.offset,0,1000000,0),chars=clamp(args.limit,1,120,80)*100;
          return receipt({...data,value:undefined,valueExcerpt:content.slice(offset,offset+chars),
            valueChars:content.length,offset,nextOffset:offset+chars<content.length?offset+chars:null,
            truncated:true,note:'Open the local file in BLACKICE Context for editing large values.'});
        }
        return receipt({...data,truncated:false});
      }
      if(action==='history'){
        const data=await contextAuditHistory({...selected,limit:clamp(args.limit,1,120,40)});
        return receipt(data);
      }
      if(action==='edit'){
        if(!canWrite)return receipt({code:'SHADOWDANCER_READ_ONLY',error:'This agent is read-only; use the human Context tab for edits.'},false,'SHADOWDANCER_READ_ONLY');
        if(!args.file||!args.expectedHash||!args.changes||!args.reason)throw fail('SHADOWDANCER_EDIT_REQUIRED','Read the exact file and supply file, expectedHash, changes and reason.');
        if(selected.state==='archived')throw fail('SHADOWDANCER_ARCHIVED','Restore the conversation before editing its context.',409);
        const targetId=selected.conversationId;
        const updated=await editShadowdancerContext({...selected,
          file:args.file,expectedHash:args.expectedHash,changes:args.changes,reason:args.reason,
          actor:'codex:'+nodeId,
          isActive:()=>getActiveRuns().some(x=>
            (x.taskId||x.id)===targetId&&(x.settled!==true||['queued','running','waiting'].includes(x.status))
          )});
        onEvent({type:'shadowdancer.context.edited',conversationId:targetId,
          file:args.file,editId:updated.editId,invalidatedRuns:updated.invalidatedRuns||[],actor:'codex:'+nodeId});
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
