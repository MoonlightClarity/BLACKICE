/** Shared authenticated Context rebuild actions for BLACKICE UI and Codex. */
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {assertSafeShadowdancerPath} from './shadowdancer-context.mjs';
import {planShadowdancerRebuild} from './shadowdancer-rebuild.mjs';
const ID=/^[A-Za-z0-9_-]{1,120}$/;
const error=(code,message,status=400)=>Object.assign(Error(message),{code,status});
async function resolveSource({cwd,conversationId,sourceRunId}){
 if(typeof cwd!=='string'||!path.isAbsolute(cwd)||typeof conversationId!=='string'||!ID.test(conversationId))throw error('DIRECTORY_REBUILD_SCOPE','Use an absolute saved workspace and valid conversation ID');
 await assertSafeShadowdancerPath(path.join(cwd,'.shadowdancer',conversationId));
 if(sourceRunId!==undefined&&sourceRunId!==null){
  if(typeof sourceRunId!=='string'||!ID.test(sourceRunId))throw error('DIRECTORY_REBUILD_SOURCE','Invalid source-run ID');
  return sourceRunId;
 }
 const file=path.join(cwd,'.shadowdancer',conversationId,'conversation','context','invalidation.json');
 let invalidation;
 try{await assertSafeShadowdancerPath(file);invalidation=JSON.parse(await readFile(file,'utf8'));}
 catch(e){if(e.code==='ENOENT')throw error('DIRECTORY_REBUILD_NOT_STALE','No edited Context results to rebuild',409);throw e;}
 const stale=Object.entries(invalidation.staleRuns||{}).filter(([,v])=>v?.state==='stale');
 if(!stale.length)throw error('DIRECTORY_REBUILD_NOT_STALE','No pending audited Context revision for this conversation',409);
 // An edited conversation may contain several historical runs with matching
 // invalidation timestamps. The canonical summary, not object iteration or
 // timestamps, decides which run a new continuation should rebuild.
 const summaryFile=path.join(cwd,'.shadowdancer',conversationId,'conversation','context','summary.json');
 let summary;
 try{await assertSafeShadowdancerPath(summaryFile);summary=JSON.parse(await readFile(summaryFile,'utf8'));}
 catch(e){if(e.code!=='ENOENT')throw e;}
 const current=summary?.currentRun;
 if(current!==undefined&&current!==null){
  if(typeof current!=='string'||!ID.test(current))throw error('DIRECTORY_REBUILD_SOURCE','Invalid current run in conversation summary');
  if(invalidation.staleRuns?.[current]?.state!=='stale')
   throw error('DIRECTORY_REBUILD_NOT_STALE','The current conversation result has no pending audited Context revision',409);
  return current;
 }
 // Legacy directories without a saved currentRun retain the historical fallback.
 return stale.sort((a,b)=>String(b[1].at||'').localeCompare(String(a[1].at||'')))[0][0];
}
const present=plan=>({
 sourceRunId:plan.sourceRunId,
 conversationId:plan.conversationId,
 latestEditId:plan.latestEditId,
 editIds:plan.editIds,
 changedFiles:plan.changedFiles,
 globalChange:plan.globalChange,
 rerunModules:plan.rerunModules,
 reusedModules:plan.reusedModules,
 reextractPages:plan.reextractPages,
 reusedPages:plan.reusedPages,
 pageOverrides:plan.pageOverrides,
 resultOverrides:plan.resultOverrides,
 currentOnly:true,
 note:'Rebuild runs as a continuation of this conversation. Historical results are preserved.',
});
export async function previewShadowdancerRebuild({
 cwd,conversationId,sourceRunId,expectedEditId
}){
 const resolved=await resolveSource({cwd,conversationId,sourceRunId});
 return present(await planShadowdancerRebuild({cwd,conversationId,
  sourceRunId:resolved,expectedEditId}));
}
export async function startShadowdancerRebuild({
 engine,cwd,conversationId,sourceRunId,expectedEditId
}){
 if(!engine||typeof engine.continueRun!=='function')throw error('DIRECTORY_REBUILD_RUNTIME','BLACKICE continuation engine is unavailable',503);
 const resolved=await resolveSource({cwd,conversationId,sourceRunId});
 const plan=await planShadowdancerRebuild({cwd,conversationId,
  sourceRunId:resolved,expectedEditId});
 const previous=engine.runs.get(plan.sourceRunId);
 if(!previous)throw error('DIRECTORY_REBUILD_ARCHIVE','Open this saved conversation in BLACKICE first so its run can be continued',409);
 if((previous.taskId||previous.id)!==conversationId||path.resolve(previous.cwd)!==path.resolve(cwd))
   throw error('DIRECTORY_REBUILD_SCOPE','Source run does not belong to the selected conversation',409);
 const agent=previous.workflow?.nodes?.find(x=>x.type==='agent'&&previous.nodes?.[x.id]);
 if(!agent)throw error('DIRECTORY_REBUILD_AGENT','Source run has no recorded agent node',409);
 if(!['completed','failed','cancelled'].includes(previous.status)||previous.settled!==true)
   throw error('DIRECTORY_REBUILD_BUSY','Finish the source run before continuing it',409);
 const message='/directory REBUILD_FROM: '+plan.sourceRunId+'\nEDIT_REVISION: '+plan.latestEditId;
 const result=await engine.continueRun(plan.sourceRunId,{
  requestId:'context-rebuild-'+plan.sourceRunId+'-'+plan.latestEditId,
  nodeId:agent.id,message,planningMode:'off',
 });
 return {...present(plan),accepted:true,
  runId:result.id||result.runId,
  status:result.status||'queued',
  message:'Rebuilding affected Context as a continuation of the original conversation.'};
}
