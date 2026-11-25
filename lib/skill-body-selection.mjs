import {performance} from 'node:perf_hooks';
import {rankInertSkillBodies} from './skill-body-rerank.mjs';

const TRUSTED=new Set(['user','bundled']);
const ELIGIBLE=new Set(['candidate','candidate-limit']);

/** Local, bounded second-stage metadata selection. Skill bodies are plain
 * scoring data, never provider instructions; only IDs and metadata leave this
 * function. A failed read does not block the task or silently load old skills.
 */
export async function rerankSkillMetadataCandidates({
 request,discovery,metadata,readSkill,signal,limit=8,poolLimit=64,maxBodyChars=16000
}={}){
 if(!Number.isInteger(limit)||limit<1||limit>8||!Number.isInteger(poolLimit)||poolLimit<1||poolLimit>128
   ||!Number.isInteger(maxBodyChars)||maxBodyChars<128||maxBodyChars>24000)throw Error('Invalid bounded skill retrieval limits.');
 const started=performance.now();
 const fallback=Array.isArray(discovery?.candidates)?discovery.candidates.slice(0,limit):[];
 const defaultReceipt={version:1,status:'metadata-only',reviewed:0,selected:fallback.map(c=>c.id),elapsedMs:0};
 if(!request||!Array.isArray(discovery?.selection?.decisions)||!Array.isArray(metadata)||typeof readSkill!=='function')
  return {candidates:fallback,diagnostics:defaultReceipt};
 const byId=new Map(metadata.filter(row=>row&&typeof row.id==='string').map(row=>[row.id,row]));
 const candidates=discovery.selection.decisions
  .filter(d=>ELIGIBLE.has(d.decision)&&Number.isFinite(d.routingScore)&&d.routingScore>=0
    &&TRUSTED.has(d.source)&&byId.has(d.id))
  .sort((a,b)=>b.routingScore-a.routingScore||a.id.localeCompare(b.id)).slice(0,poolLimit);
 if(candidates.length<2)return {candidates:fallback,diagnostics:{...defaultReceipt,status:'small-pool',considered:candidates.length}};
 const seen=new Set(),stale=new Set(),docs=[];let failedReads=0,mismatch=0;
 for(const row of candidates){
  if(seen.has(row.id))continue;seen.add(row.id);
  if(signal?.aborted)throw signal.reason||new Error('Skill routing aborted');
  let skill;try{skill=await readSkill(row.id);}catch(e){if(signal?.aborted)throw e;failedReads++;continue;}
  if(!skill||typeof skill.content!=='string'||!skill.content.trim()){failedReads++;continue;}
  const source=skill.source,actualRevision=source==='user'?skill.revision:(skill.provenance?.revision??skill.revision);
  const meta=byId.get(row.id);
  if(source!==row.source||source!==meta.source||String(actualRevision)!==String(row.revision)
    ||String(meta.revision)!==String(row.revision)||skill.title!==meta.title){
   mismatch++;stale.add(row.id);continue;
  }
  docs.push({id:row.id,name:meta.title,description:meta.description,body:skill.content.slice(0,maxBodyChars),routingScore:row.routingScore});
 }
 if(signal?.aborted)throw signal.reason||new Error('Skill routing aborted');
 const ranked=docs.length?rankInertSkillBodies(request,docs,{limit:Math.min(limit,docs.length),maxBodyChars}).ranked:[];
 const output=[],used=new Set();
 const append=(id,role)=>{
  if(used.has(id)||stale.has(id)||output.length>=limit)return;
  const meta=byId.get(id);if(!meta||!TRUSTED.has(meta.source))return;
  used.add(id);output.push({id:meta.id,title:meta.title,description:meta.description,source:meta.source,revision:meta.revision,selectionRole:role});
 };
 for(const hit of ranked)append(hit.id,'body-reviewed-candidate');
 for(const item of fallback)append(item.id,item.selectionRole||'metadata-fallback');
 return {candidates:output,diagnostics:{
  version:1,status:docs.length?'body-reviewed':'metadata-fallback',
  considered:candidates.length,reviewed:docs.length,failedReads,mismatch,selected:output.map(x=>x.id),
  elapsedMs:Math.round(performance.now()-started)
 }};
}
