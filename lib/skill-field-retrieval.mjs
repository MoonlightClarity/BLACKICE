import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';

// Pure, disposable metadata index. It reads only skill titles and introductory
// descriptions. It never loads bodies, executes instructions, or grants tool
// authority. Runtime method admission remains a separate decision.
const COMMON=new Set('a an and are as at be been by can could do does for from has have how i in into is it its me my of on or our please should so some than that the their there these this those through to us use using want was were what when where which while who why will with without would you your then after before all any every each more most enough let need want please just can into even over under use using make made work working could'.split(' '));
const SPECIAL=new Set(['go','c++','c#']);
export function fieldSkillTerms(text){
 const matches=String(text??'').normalize('NFKC').toLowerCase().match(/c\+\+|c#|[\p{L}][\p{L}\p{N}]{1,39}/gu)||[];
 return matches.filter(w=>(w.length>2||SPECIAL.has(w))&&!COMMON.has(w));
}
const frequencies=value=>{
 const out=new Map();
 for(const term of fieldSkillTerms(value))out.set(term,(out.get(term)||0)+1);
 return out;
};
const hashEntries=entries=>{
 const h=createHash('sha256');
 for(const e of entries){h.update(String(e.id));h.update('\0');h.update(String(e.source??''));h.update('\0');
 h.update(String(e.revision??''));h.update('\0');h.update(String(e.title??e.name??''));h.update('\0');
 h.update(String(e.description??''));h.update('\n');}
 return h.digest('hex');
};
const descriptionOf=e=>String(e.description??e.summary??e.appliesWhen??'').slice(0,260);
function buildField(entries,extract){
 const documents=entries.map(e=>frequencies(extract(e))),df=new Map();
 for(const doc of documents)for(const term of doc.keys())df.set(term,(df.get(term)||0)+1);
 const idf=new Map([...df].map(([term,n])=>[term,Math.log(1+(entries.length-n+0.5)/(n+0.5))]));
 const postings=new Map(),norms=new Float64Array(entries.length);
 for(let i=0;i<documents.length;i++){
  let norm=0;
  for(const [term,freq] of documents[i]){
   const weight=(1+Math.log(freq))*idf.get(term);norm+=weight*weight;
   let list=postings.get(term);if(!list){list=[];postings.set(term,list);}
   list.push([i,weight]);
  }
  norms[i]=Math.sqrt(norm)||1;
 }
 return {postings,norms,idf};
}
function scoreField(index,query,n){
 const scores=new Float64Array(n);let qnorm=0;
 for(const [term,freq] of query){
  const idf=index.idf.get(term);if(!idf)continue;
  const qw=(1+Math.log(freq))*idf;qnorm+=qw*qw;
  for(const [id,weight]of index.postings.get(term)||[])scores[id]+=qw*weight;
 }
 const denominator=Math.sqrt(qnorm)||1;
 for(let i=0;i<n;i++)scores[i]/=denominator*index.norms[i];
 return scores;
}

/** Field-aware sparse retrieval, deterministic and cache-invalidated by full
 * effective metadata identity. The score is rank evidence, not model authority.
 * The caller must independently validate chosen registered skill revisions.
 */
export class SkillFieldIndex{
 #fingerprint='';#entries=[];#title=null;#description=null;#buildMs=0;
 refresh(entries){
  if(!Array.isArray(entries)||entries.length>100000)throw Error('Invalid bounded skill corpus.');
  const fingerprint=hashEntries(entries);
  if(fingerprint===this.#fingerprint)return false;
  const ids=new Set();for(const e of entries){
   if(!e||typeof e.id!=='string'||!e.id||ids.has(e.id))throw Error('Duplicate or invalid skill identifier.');
   ids.add(e.id);
  }
  const start=performance.now();
  const kept=entries.map(e=>({id:e.id,title:String(e.title??e.name??'').slice(0,200),
   description:descriptionOf(e),revision:e.revision??null,source:e.source??null}));
  this.#title=buildField(kept,e=>e.title);
  this.#description=buildField(kept,e=>e.description);
  this.#entries=kept;this.#fingerprint=fingerprint;this.#buildMs=performance.now()-start;
  return true;
 }
 search(query,{limit=100}={}){
  if(!Number.isInteger(limit)||limit<1||limit>256)throw Error('Invalid bounded skill candidate limit.');
  const started=performance.now(),terms=frequencies(String(query??'').slice(0,50000));
  const size=this.#entries.length;
  if(!size||!terms.size)return {candidates:[],totalMatches:0,queryTerms:terms.size,queryMs:performance.now()-started};
  const t=scoreField(this.#title,terms,size),d=scoreField(this.#description,terms,size),ranked=[];
  for(let i=0;i<size;i++){
   const score=4*t[i]+2*d[i];
   if(score>0)ranked.push({i,score});
  }
  ranked.sort((a,b)=>b.score-a.score||a.i-b.i);
  const maximum=ranked[0]?.score||1;
  return {candidates:ranked.slice(0,limit).map(({i,score},index)=>({
   id:this.#entries[i].id,rank:index+1,score,routingScore:score/maximum*100
  })),totalMatches:ranked.length,queryTerms:terms.size,queryMs:performance.now()-started};
 }
 stats(){return {documents:this.#entries.length,buildMs:this.#buildMs,
  titleTerms:this.#title?.postings.size||0,descriptionTerms:this.#description?.postings.size||0};}
 close(){this.#fingerprint='';this.#entries=[];this.#title=null;this.#description=null;this.#buildMs=0;}
}
