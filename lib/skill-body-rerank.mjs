/** Inert offline skill-body reranker.
 * Skill text is treated only as capped lexical evidence; no tools, eval,
 * provider prompts, network calls, or authority changes occur here.
 */
const STOP=new Set('a an and are as at be been by can could do does for from has have how i in into is it its me my of on or our please should so some than that the their there these this those through to us use using want was were what when where which while who why will with without would you your then after before all any every each more most enough with in order make show give need help'.split(' '));
const words=text=>[...new Set((String(text||'').normalize('NFKC').toLowerCase().match(/[a-z][a-z0-9+#._-]{1,38}/g)||[])
 .map(w=>w.length>4&&w.endsWith('ies')?w.slice(0,-3)+'y':w.length>4&&w.endsWith('s')&&!w.endsWith('ss')?w.slice(0,-1):w)
 .filter(w=>w.length>2&&!STOP.has(w)))];
export function rankInertSkillBodies(query,candidates,{limit=8,maxBodyChars=16000}={}){
 if(!Array.isArray(candidates)||candidates.length>256)throw Error('Use a bounded skill shortlist of at most 256 entries.');
 if(!Number.isInteger(limit)||limit<1||limit>32||!Number.isInteger(maxBodyChars)||maxBodyChars<128||maxBodyChars>24000)throw Error('Invalid read-only reranking budget.');
 const terms=words(query).slice(0,100),rows=candidates.map((c,i)=>({
  id:String(c.id),ordinal:i,routingScore:Number.isFinite(c.routingScore)?Math.max(0,Math.min(240,c.routingScore)):0,
  title:new Set(words(c.name||c.title)),description:new Set(words(c.description)),
  body:new Set(words(String(c.body||c.skill_md||'').slice(0,maxBodyChars)))
 }));
 const df=new Map(terms.map(t=>[t,rows.reduce((n,r)=>n+Number(r.title.has(t)||r.description.has(t)||r.body.has(t)),0)]));
 const out=rows.map(row=>{
  let lexical=0,titleHits=0,descriptionHits=0,bodyHits=0;
  for(const t of terms){
   const rarity=Math.log(1+(rows.length-(df.get(t)||0)+0.5)/((df.get(t)||0)+0.5));
   if(row.title.has(t)){lexical+=5*rarity;titleHits++;}
   if(row.description.has(t)){lexical+=2.5*rarity;descriptionHits++;}
   if(row.body.has(t)){lexical+=0.8*rarity;bodyHits++;}
  }
  const score=row.routingScore*0.12+lexical;
  return {id:row.id,score,metadataScore:row.routingScore,bodyMatches:bodyHits,titleMatches:titleHits,descriptionMatches:descriptionHits,ordinal:row.ordinal};
 });
 out.sort((a,b)=>b.score-a.score||a.ordinal-b.ordinal);
 return {ranked:out.slice(0,limit).map(({ordinal,...row})=>row),examined:rows.length,queryTerms:terms.length,
  totalUniqueBodyTerms:rows.reduce((n,r)=>n+r.body.size,0)};
}
