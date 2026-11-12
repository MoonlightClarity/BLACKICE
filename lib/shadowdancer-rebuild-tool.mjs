/** Separate native Codex tool for Context rebuilds.
 * Existing relay_context schemas are unchanged; older sessions never
 * silently receive extra actions.
 */
import {previewShadowdancerRebuild,startShadowdancerRebuild} from './shadowdancer-rebuild-actions.mjs';
const ID=/^[A-Za-z0-9_-]{1,120}$/;
const fail=(code,message)=>Object.assign(Error(message),{code});
const result=(value,success=true,code)=>({success,...(code?{code}:{}),
  contentItems:[{type:'inputText',text:JSON.stringify(value)}]});
export const SHADOWDANCER_REBUILD_TOOL={
 type:'function',name:'relay_context_rebuild',
 description:'Preview or start an audited targeted rebuild of a Shadowdancer conversation after a Context edit. Defaults to the current conversation, never merges unrelated conversations. Preview returns edited files and which saved modules/pages must rerun versus be reused. Start requires the latest edit revision and creates a NEW follow-up run with fresh model contexts. Historical results remain preserved. Rebuild is not completed when its run is queued.',
 inputSchema:{type:'object',properties:{
   action:{type:'string',enum:['preview','start']},
   conversationId:{type:'string',description:'Optional explicit saved conversation/run ID, previously selected by title.'},
   sourceRunId:{type:'string',description:'Optional stale source-run ID; otherwise the newest stale run within the selected conversation.'},
   expectedEditId:{type:'string',description:'The latest edit-00001 revision observed in preview; mandatory to start.'},
 },required:['action'],additionalProperties:false}
};
export const SHADOWDANCER_REBUILD_INSTRUCTIONS='\n\nCONTEXT REBUILD TOOL\nUse relay_context_rebuild preview after an audited Context edit to see affected work. To continue, call start with the exact expectedEditId returned by preview. Rebuild creates a continuation in the selected conversation, keeps old results historical, and returns its queued run ID. Never claim completion or verified correctness until that run has finished with a verified host receipt. The default scope is this conversation, not a global Context search. Read-only agents can preview but cannot start a rebuild.\n';
export function createShadowdancerRebuildToolHandler({
 conversations,engine,cwd,runId,taskId,signal,canWrite=true,onEvent=()=>{}
}={}){
 if(!conversations||!engine)throw Error('BLACKICE conversation/rebuild runtime required');
 if(typeof cwd!=='string'||!ID.test(taskId||runId||''))throw Error('A valid conversation-scoped workspace is required');
 const defaultId=taskId||runId;
 const selected=async requested=>{
  if(!requested||requested===defaultId)return {cwd,conversationId:defaultId};
  if(typeof requested!=='string'||!ID.test(requested))throw fail('DIRECTORY_REBUILD_CONVERSATION','Select a saved conversation ID');
  const saved=await conversations.get(requested);
  return {cwd:saved.cwd,conversationId:saved.taskId||saved.id};
 };
 return async(call,context={})=>{
  try{
   (context.signal||signal)?.throwIfAborted?.();
   if(call?.name!==SHADOWDANCER_REBUILD_TOOL.name)throw fail('DIRECTORY_REBUILD_TOOL','Wrong tool name');
   let args;try{args=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments}catch{}
   if(!args||typeof args!=='object'||Array.isArray(args)||
      Object.keys(args).some(k=>!Object.hasOwn(SHADOWDANCER_REBUILD_TOOL.inputSchema.properties,k))||
      !SHADOWDANCER_REBUILD_TOOL.inputSchema.properties.action.enum.includes(args.action))
    throw fail('DIRECTORY_REBUILD_ARGS','Choose preview or start with the supported fields');
   const scope=await selected(args.conversationId);
   if(args.action==='preview'){
    return result(await previewShadowdancerRebuild({...scope,sourceRunId:args.sourceRunId}));
   }
   if(canWrite===false)return result({code:'DIRECTORY_REBUILD_READ_ONLY',
    error:'This agent may inspect but not start Context rebuilds'},false,'DIRECTORY_REBUILD_READ_ONLY');
   if(typeof args.expectedEditId!=='string'||!/^edit-\d{5,10}$/.test(args.expectedEditId))
    throw fail('DIRECTORY_REBUILD_EXPECTED_EDIT','Preview the affected Context and pass its latest edit revision');
   const started=await startShadowdancerRebuild({engine,...scope,
    sourceRunId:args.sourceRunId,expectedEditId:args.expectedEditId});
   onEvent({type:'shadowdancer.context.rebuild_started',sourceRunId:started.sourceRunId,
    newRunId:started.runId,conversationId:scope.conversationId,editId:started.latestEditId});
   return result(started);
  }catch(e){
   if(e?.name==='AbortError')throw e;
   const code=e?.code||'DIRECTORY_REBUILD_ERROR';
   return result({code,error:String(e?.message||e)},false,code);
  }
 };
}
