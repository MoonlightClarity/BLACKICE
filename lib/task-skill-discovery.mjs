import {currentRequestText,wantsJobSearchExecutionSkill} from './chat-intent-inference.mjs';
import {rankSkillMetadata,skillSearchTerms} from './skill-library.mjs';
import {semanticSkillScore} from './skill-hybrid-retrieval.mjs';

// Retrieval uses the current user's task, not model-written progress, prior
// tasks, or raw full skill bodies. The worker can evaluate the meaning of
// metadata and read another method without a separate classifier/provider turn.
const noise=new Set('task method methods skill skills work use current actual available need want choose check first then continue please should real overnight new only find search read apply execute'.split(' '));
const terms=value=>[...new Set(skillSearchTerms(value.replaceAll('-',' ')).map(word=>
 word.length>4&&word.endsWith('ies')?word.slice(0,-3)+'y':
 word.length>3&&/[^sui]s$/.test(word)?word.slice(0,-1):word
 ).filter(word=>!noise.has(word)))];
const boundedText=value=>String(value||'').replace(/\s+/g,' ').trim();
const overlaps=(a,b)=>a.filter(word=>b.includes(word)).length;
const fit=(a,b)=>a.length>0&&a.every(word=>b.includes(word));
const skillMaintenance=request=>/^(?:please\s+)?(?:edit|revise|rewrite|delete|remove|improve|test|audit|review|explain|describe|diagnose|compare)\b[^.!?\n]{0,160}\b(?:skills?|methods?|workflow)\b/i.test(request);

// Intent labels are retrieval queries, not installed skill names or IDs.
// An employment request expressed as "apply to remote positions" has the
// same retrieval intent as "job search"; no skill-name clause is needed.
export function taskSkillQueries(input){
 const request=currentRequestText(input,50000).trim();
 if(!request)return {request,queries:[],intent:[],job:false};
 const job=wantsJobSearchExecutionSkill(input);
 const intent=job?[...(/\b(?:remote|telecommut(?:e|ing)|work from home|distributed)\b/i.test(request)?['remote job search']:[]),'job search']: [];
 const snippets=request.split(/(?:[.!?;](?:\s+|$)|\r?\n)/).map(boundedText)
  .filter(Boolean).map(value=>value.slice(0,256));
 // Short task clauses keep relevant words from being drowned out by a long
 // objective's paths, receipts and factual constraints. This limits only
 // metadata in the initial prompt, never later skill search or tool use.
 const queries=[...new Set([...intent,...snippets.slice(0,12)])];
 return {request,queries,intent,job};
}

export function discoverTaskSkills(input,metadata,{excludeIds=[]}={}){
 const context=taskSkillQueries(input);
 if(!context.queries.length)return {automatic:[],candidates:[]};
 const excluded=new Set(excludeIds),maintenance=skillMaintenance(context.request);
 const ranked=[];
 for(const entry of metadata){
  if(excluded.has(entry.id))continue;
  // Don't use generic catalog retrieval to re-enable the old special job
  // selector for a diagnostic/implementation request.
  if(entry.id==='library-job-search'&&!context.job)continue;
  const titleTerms=terms(entry.title||''),purposeTerms=terms(entry.description||'');
  let score=-1,auto=false;
  for(const query of context.queries){
   const q=terms(query);
   if(!q.length)continue;
   const titleHits=overlaps(titleTerms,q),purposeHits=overlaps(purposeTerms,q);
   const metadataScore=rankSkillMetadata(entry,skillSearchTerms(query),'',query);
   const semanticScore=semanticSkillScore(entry,query);
   const titleMatch=titleTerms.length>=2&&fit(titleTerms,q);
   const purposeMatch=q.length>=4&&purposeHits>=4&&purposeHits/q.length>=0.8&&purposeHits/purposeTerms.length>=0.55;
   const normalizedIntent=context.intent.includes(query);
   const strong=titleMatch||purposeMatch||(entry.ownerCreated&&semanticScore>=50);
   // Auto-attach an owner-created method only for strong task evidence.
   // All other matches are compact candidates for semantic choice by the
   // working model, not a compulsory read or an action-admission gate.
   if(entry.ownerCreated&&!maintenance&&strong&&(normalizedIntent||!/^\s*(?:explain|describe|what|how|why|diagnose|review)\b/i.test(context.request))){
    // If a job-domain method was only mentioned while debugging the search,
    // don't turn that topic into an actual application method.
    if(context.job||!titleTerms.includes('job'))auto=true;
   }
   if(metadataScore>=0||semanticScore>=0||titleHits>=2||purposeHits>=3||strong)
    score=Math.max(score,Math.max(0,metadataScore,semanticScore)+titleHits*12+purposeHits*3+(strong?40:0)+(normalizedIntent&&strong?50:0));
  }
  if(score>=0)ranked.push({entry,score,auto});
 }
 ranked.sort((a,b)=>Number(b.auto)-Number(a.auto)||b.score-a.score||a.entry.id.localeCompare(b.entry.id));
 const automatic=ranked.filter(row=>row.auto).map(row=>row.entry);
 // The initial index is intentionally compact. Search/read remains available
 // for the entire effective catalog and no candidate limits task execution.
 const candidates=ranked.filter(row=>!row.auto).slice(0,8).map(({entry})=>({
  id:entry.id,title:entry.title,description:entry.description,source:entry.source,revision:entry.revision
 }));
 return {automatic,candidates};
}
