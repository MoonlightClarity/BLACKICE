import {currentRequestText,wantsJobSearchExecutionSkill} from './chat-intent-inference.mjs';
import {rankSkillMetadata,skillSearchTerms} from './skill-library.mjs';
import {SkillHybridIndex,hybridSkillScore,semanticSkillScore,semanticSkillTopicalMatch} from './skill-hybrid-retrieval.mjs';
import {SkillFieldIndex} from './skill-field-retrieval.mjs';
import {exactDocumentTextRequest} from './exact-document-extraction.mjs';

// Task properties describe the work, not the names or origin of installed
// methods. Methods opt into those properties through effective metadata.
const noise=new Set('task method methods skill skills work use current actual available need want choose check first then continue please should real overnight new only find search read apply execute'.split(' '));
const terms=value=>[...new Set(skillSearchTerms(String(value||'').replaceAll('-',' ')).map(word=>
 word.length>4&&word.endsWith('ies')?word.slice(0,-3)+'y':
 word.length>3&&/[^sui]s$/.test(word)?word.slice(0,-1):word
 ).filter(word=>!noise.has(word)))];
const boundedText=value=>String(value||'').replace(/\s+/g,' ').trim();
const overlaps=(a,b)=>a.filter(word=>b.includes(word)).length;
const fit=(a,b)=>a.length>0&&a.every(word=>b.includes(word));
const skillMaintenance=request=>/^(?:please\s+)?(?:edit|revise|rewrite|delete|remove|improve|test|audit|review|explain|describe|diagnose|compare)\b[^.!?\n]{0,160}\b(?:skills?|methods?)\b/i.test(request);
const analysisMethodIntent=request=>!skillMaintenance(request)&&(/^(?:\s*(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:carefully\s+|critically\s+|deeply\s+|independently\s+)?)(?:analy[sz]e|assess|evaluate|critique|review|audit|examine|interpret|investigate|diagnose|compare)\s+\S/i.test(request)||/\b(?:need|want|would like|give|provide|produce|perform|conduct|do|make|write)\b[^.!?\n]{0,80}\b(?:analysis|assessment|evaluation|critique|audit|review|comparison)\s+(?:of|on|for)\b/i.test(request)||/^(?:please\s+)?(?:what do you think of|how would you (?:assess|evaluate|analy[sz]e|interpret)|what are (?:the )?(?:strengths|weaknesses|implications|risks|tradeoffs))\b/i.test(request));
export const wantsReverseOutlineAnalysis=input=>analysisMethodIntent(currentRequestText(input,50000).trim());

export function taskMethodFacets(request,{job=false}={}){
 if(!request||skillMaintenance(request)||exactDocumentTextRequest(request))return [];
 const facets=new Set();
 const analysis=analysisMethodIntent(request);
 const competing=analysis||/\b(?:root cause|why (?:did|does|is|are|has|have)|alternative explanations|competing (?:claims|explanations|interpretations|hypotheses)|counterarguments?)\b/i.test(request);
 const judgment=competing||/^\s*(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:recommend|predict|forecast|decide|rank|choose|estimate)\b/i.test(request)||/\b(?:which|what)\b[^.!?\n]{0,100}\bshould\b/i.test(request);
 const dependent=analysis||job||/\b(?:multi[- ]?step|dependencies|dependent steps|step.by.step|migration plan|implementation plan|roadmap)\b/i.test(request)||/\b(?:then|after that|before that|followed by)\s+(?:verify|test|install|deploy|build|implement|check|compare|review|run|submit|save)\b/i.test(request);
 if(analysis)facets.add('substantive-analysis');
 if(dependent)facets.add('dependent-work');
 if(competing)facets.add('competing-interpretations');
 if(judgment)facets.add('judgment');
 // Resource allocation is a task property, not an employer qualification or permission.
 const resource=Boolean(job && /\b(?:jobs|positions|roles|vacancies|openings|applications|job search)\b/i.test(request)
   && !/\b(?:only this|this exact|this specific|single requisition)\b/i.test(request))
   || /\b(?:time management|prioriti[sz](?:e|ation|ing)|allocate|allocation|opportunity cost|marginal value|throughput|limited time|time budget|deadline|time constraints?|worth the time|efficien(?:cy|t)|competing (?:options|routes|tasks|actions|approaches)|multiple (?:routes|approaches|options|tasks)|under \d+ (?:hours?|minutes?))\b/i.test(request);
 if(resource)facets.add('resource-allocation');
 return [...facets];
}

// Topic queries remain separate from applicability. Quoted examples, prior
// agent reports and mutable Goal state cannot authorize method selection.
export function taskSkillQueries(input){
 const request=currentRequestText(input,50000).trim();
 if(!request)return {request,queries:[],intent:[],job:false,facets:[]};
 const job=wantsJobSearchExecutionSkill(input);
 // An exact application request often names the jobs instead of repeating the
 // user's normal work arrangement. Offer the installed job-search method as a
 // retrieval alias; an alias never adds a remote/location constraint.
 const intent=job?['job search',...(/\b(?:on[- ]?site only|in[- ]person only|no remote)\b/i.test(request)?[]:['remote job search'])]:[];
 const snippets=request.split(/(?:[.!?;](?:\s+|$)|\r?\n)/).map(boundedText).filter(Boolean).map(value=>value.slice(0,256));
 const queries=[...new Set([...intent,...snippets.slice(0,12)])];
 return {request,queries,intent,job,facets:taskMethodFacets(request,{job})};
}

/** Rerank a bounded shortlist for complementary methods, without adding gates.
 * Preserve the strongest relevant match, discount near-duplicates thereafter.
 * Relevance and method selection remain advisory, never authorization.
 */
export function diversifySkillCandidates(rows,{limit=8}={}){
 if(!Number.isInteger(limit)||limit<1||limit>32)throw new Error('Invalid skill shortlist limit.');
 const pool=[...rows],selected=[],original=new Map(pool.map((row,i)=>[row,i]));
 const signatures=new Map(pool.map(row=>[row,new Set(terms([row.entry?.title,row.entry?.description,...(row.entry?.tags||[]),...(row.entry?.aliases||[])].filter(Boolean).join(' ')).slice(0,72))]));
 const similarity=(a,b)=>{
  const x=signatures.get(a)||new Set(),y=signatures.get(b)||new Set();
  if(!x.size||!y.size)return 0;
  return [...x].filter(word=>y.has(word)).length/Math.min(x.size,y.size);
 };
 while(pool.length&&selected.length<limit){
  let best=0,bestScore=-Infinity;
  for(let i=0;i<pool.length;i++){
   const row=pool[i],maxSim=selected.length?Math.max(...selected.map(other=>similarity(row,other))):0;
   const category=String(row.entry?.tags?.[0]||row.entry?.activation?.[0]||'');
   const duplicateCategory=category&&selected.some(other=>category===String(other.entry?.tags?.[0]||other.entry?.activation?.[0]||''));
   const adjusted=row.score-Math.round(maxSim*35)-(duplicateCategory?9:0);
   if(adjusted>bestScore||adjusted===bestScore&&original.get(row)<original.get(pool[best])){best=i;bestScore=adjusted;}
  }
  const [chosen]=pool.splice(best,1);
  if(chosen.receipt){chosen.receipt.candidateRank=selected.length+1;chosen.receipt.selectionRole=selected.length?'alternative-method':'leading-match';}
  selected.push(chosen);
 }
 return selected;
}

export const AUTO_SKILL_BUDGET=6;
export const SKILL_SHORTLIST_LIMIT=8;

// This projection is the exact metadata contract submitted to a provider.
// A shortlist entry is an invitation to read a method, never a load receipt.
export function projectTaskSkillDiscovery(discovery,{limit=SKILL_SHORTLIST_LIMIT,maxCharacters=6000}={}){
 if(!Number.isInteger(limit)||limit<1||limit>32||!Number.isInteger(maxCharacters)||maxCharacters<500)throw Error('Invalid skill projection budget.');
 const rows=discovery?.shortlist||[...(discovery?.automatic||[]),...(discovery?.candidates||[])],entries=[],ids=new Set();
 for(const row of rows){
  if(entries.length>=limit)break;
  if(!row||ids.has(row.id)||!['user','bundled'].includes(row.source))continue;
  const item={id:row.id,title:boundedText(row.title).slice(0,200),
   description:boundedText(row.description||row.summary||row.appliesWhen).slice(0,260),
   source:row.source,revision:row.revision,...(row.catalog?{catalog:row.catalog}:{})};
  if(JSON.stringify([...entries,item]).length>maxCharacters)break;
  entries.push(item);ids.add(item.id);
 }
 return entries;
}

export function discoverTaskSkills(input,metadata,{excludeIds=[],hybridIndex=null,fieldIndex=null,fieldLimit=100,fieldThreshold=128}={}){
 // fieldThreshold remains accepted for callers created before the unified
 // index. It no longer changes ranking or applicability at a corpus boundary.
 if(!Number.isInteger(fieldLimit)||fieldLimit<8||fieldLimit>256||!Number.isInteger(fieldThreshold)||fieldThreshold<1)throw Error('Invalid sparse selection budget.');
 const context=taskSkillQueries(input);
 const excluded=new Set(excludeIds),maintenance=skillMaintenance(context.request);
 const ranked=[],decisions=[],requestTerms=terms(context.request);
 const exactText=exactDocumentTextRequest(context.request);
 const sparseIndex=fieldIndex||new SkillFieldIndex(),index=hybridIndex||new SkillHybridIndex();
 const ownsSparse=!fieldIndex,ownsIndex=!hybridIndex;
 let sparseResults=null,sparseScores=new Map();
 try{
  sparseIndex.refresh(metadata);
  sparseResults=sparseIndex.search(context.request,{limit:fieldLimit});
  sparseScores=new Map(sparseResults.candidates.map(row=>[row.id,row.routingScore]));
  const isExplicit=entry=>(entry.aliases||[]).some(alias=>typeof alias==='string'&&alias.length>3&&context.request.toLowerCase().includes(alias.toLowerCase()))
   ||(terms(entry.title||'').length>=2&&fit(terms(entry.title||''),requestTerms))
   ||context.request.trim()===entry.id;
  const directMatches=new Set(metadata.filter(isExplicit).map(entry=>entry.id));
  // FTS and the more expensive semantic reranker only see the bounded first
  // stage plus explicit matches. Declared applicability is checked separately.
  index.refresh(metadata.filter(entry=>sparseScores.has(entry.id)||directMatches.has(entry.id)));
  const queryScores=context.queries.map(query=>({query,q:terms(query),boosts:index.score(query)}));
  for(const entry of metadata){
   const receipt={id:entry.id,source:entry.source,revision:entry.revision};decisions.push(receipt);
   if(excluded.has(entry.id)){receipt.decision='already-loaded';continue;}
   if(!context.queries.length){receipt.decision='no-current-request';continue;}
   if(exactText){receipt.decision='exact-text-request';continue;}
   if(entry.id==='library-job-search'&&!context.job){receipt.decision='job-intent-mismatch';continue;}
   const sparseScore=sparseScores.get(entry.id);
   const applicable=(entry.activation||[]).filter(facet=>context.facets.includes(facet));
   if(sparseScore===undefined&&!directMatches.has(entry.id)&&!(entry.activationDeclared&&applicable.length)){
    receipt.decision='sparse-not-shortlisted';continue;
   }
   const titleTerms=terms(entry.title||'');
   const purposeTerms=terms([entry.description,entry.summary,entry.appliesWhen,entry.scope].filter(Boolean).join(' '));
   let score=-1,auto=false,bestLexical=-1,bestSemantic=-1,strongTopic=false;
   for(const {query,q,boosts} of queryScores){
    if(!q.length)continue;
    const titleHits=overlaps(titleTerms,q),purposeHits=overlaps(purposeTerms,q);
    const metadataScore=rankSkillMetadata(entry,skillSearchTerms(query),'',query);
    const semanticScore=semanticSkillScore(entry,query);
    bestLexical=Math.max(bestLexical,metadataScore);bestSemantic=Math.max(bestSemantic,semanticScore);
    const titleMatch=titleTerms.length>=2&&fit(titleTerms,q);
    const purposeMatch=q.length>=4&&purposeHits>=4&&purposeHits/q.length>=0.8&&purposeHits/Math.max(1,purposeTerms.length)>=0.55;
    const normalizedIntent=context.intent.includes(query);
    const strong=titleMatch||purposeMatch||semanticSkillTopicalMatch(entry,query);
    const topical=hybridSkillScore(entry,query,metadataScore,boosts.get(entry.id)||0);
    if(strong&&(normalizedIntent||context.facets.includes('substantive-analysis')||!/^\s*(?:explain|describe|what|how|why|diagnose|review)\b/i.test(context.request))&&(context.job||!titleTerms.includes('job')))strongTopic=true;
    if(topical>=0||titleHits>=2||purposeHits>=3||strong)
     score=Math.max(score,Math.max(0,topical)+titleHits*12+purposeHits*3+(strong?40:0)+(normalizedIntent&&strong?50:0));
   }
   // Sparse relevance provides recall for natural task descriptions that do
   // not repeat half of a title or description. It only nominates metadata.
   if(sparseScore!==undefined)score=Math.max(score,sparseScore);
   Object.assign(receipt,{lexical:bestLexical,semantic:bestSemantic,applicability:applicable});
   const installed=entry.source==='user'||entry.source==='bundled';
   if(!maintenance&&installed){
    if(entry.activationDeclared){auto=applicable.length>0;if(auto)score=Math.max(score,100+applicable.length*10);}
    else auto=strongTopic;
   }
   if(score>=0)receipt.routingScore=score;
   if(auto){receipt.decision='selected';receipt.reason=applicable.length?'declared-applicability':'strong-topic-match';}
   else if(maintenance)receipt.decision='skill-maintenance';
   else if(entry.activationDeclared&&!applicable.length)receipt.decision='not-applicable';
   else if(score>=0)receipt.decision='candidate';
   else receipt.decision='no-relevant-match';
   if(score>=0&&(!entry.activationDeclared||auto||maintenance))ranked.push({entry,score,auto,receipt});
  }
 }finally{if(ownsIndex)index.close();if(ownsSparse)sparseIndex.close();}
 ranked.sort((a,b)=>Number(b.auto)-Number(a.auto)||b.score-a.score||a.entry.id.localeCompare(b.entry.id));
 const autoRows=ranked.filter(row=>row.auto),overflow=autoRows.slice(AUTO_SKILL_BUDGET);
 for(const row of overflow){row.auto=false;row.receipt.decision='candidate';row.receipt.reason='automatic-budget';}
 const automatic=autoRows.slice(0,AUTO_SKILL_BUDGET).map(row=>row.entry);
 const candidateRows=ranked.filter(row=>!row.auto),diverse=diversifySkillCandidates(candidateRows);
 const chosen=new Set(diverse);
 for(const row of candidateRows)if(!chosen.has(row)&&row.receipt.decision==='candidate')row.receipt.decision='candidate-limit';
 const metadataRow=({entry,receipt})=>({id:entry.id,title:entry.title,description:entry.description||entry.summary||entry.appliesWhen||'',
  source:entry.source,revision:entry.revision,...(entry.catalog?{catalog:entry.catalog}:{}),
  ...(receipt?.selectionRole?{selectionRole:receipt.selectionRole}:{})});
 const candidates=diverse.map(metadataRow);
 // Relevance, not an automatic/candidate classification, decides the bounded
 // provider shortlist. Broad general methods must not hide specific matches.
 const shortlist=diversifySkillCandidates([...autoRows.slice(0,AUTO_SKILL_BUDGET),...diverse],{limit:SKILL_SHORTLIST_LIMIT}).map(metadataRow);
 return {automatic,candidates,shortlist,selection:{version:3,facets:context.facets,total:decisions.length,
  automaticLimit:AUTO_SKILL_BUDGET,deferredAutomatic:overflow.length,shortlistLimit:SKILL_SHORTLIST_LIMIT,
  firstStage:{kind:'field-aware-sparse',limit:fieldLimit,corpus:metadata.length,matched:sparseResults?.totalMatches||0,shortlisted:sparseScores.size,queryMs:sparseResults?.queryMs||0},
  decisions}};
}
