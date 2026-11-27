import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {semanticSkillTerms} from './skill-hybrid-retrieval.mjs';

// Disposable effective-metadata index. Bodies are never loaded by discovery.
const COMMON=new Set('a an and are as at be been by can could do does for from has have how i in into is it its me my of on or our please should so some than that the their there these this those through to us use using want was were what when where which while who why will with without would you your then after before all any every each more most enough let need want please just can into even over under use using make made work working could'.split(' '));
const SPECIAL=new Set(['go','c++','c#']);
const lexicalStem=term=>term.length>4&&term.endsWith('ies')?term.slice(0,-3)+'y':term.length>3&&/[^sui]s$/.test(term)?term.slice(0,-1):term;
export function fieldSkillTerms(text){
 const matches=String(text??'').normalize('NFKC').toLowerCase().match(/c\+\+|c#|[\p{L}][\p{L}\p{N}]{1,39}/gu)||[];
 return matches.filter(w=>(w.length>2||SPECIAL.has(w))&&!COMMON.has(w)).map(lexicalStem);
}
const frequencies=(value,tokenize=fieldSkillTerms)=>{
 const out=new Map();
 for(const term of tokenize(value))out.set(term,(out.get(term)||0)+1);
 return out;
};
const strings=(value,limit)=>Array.isArray(value)?value.slice(0,limit).map(x=>String(x).slice(0,128)):[];
const normalized=e=>({
 id:e.id,title:String(e.title??e.name??'').slice(0,200),
 purpose:[...new Set([e.description,e.summary,e.appliesWhen,e.scope].filter(x=>typeof x==='string'&&x.trim()).map(x=>x.slice(0,500)))].join(' ').slice(0,2000),
 tags:strings(e.tags,32),aliases:strings(e.aliases,32),
 revision:e.revision??null,source:e.source??null,catalog:e.catalog??null,
});
const hashEntries=entries=>createHash('sha256').update(JSON.stringify(entries)).digest('hex');
function buildField(entries,extract,tokenize=fieldSkillTerms){
 const documents=entries.map(e=>frequencies(extract(e),tokenize)),df=new Map();
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
function scoreField(index,query,n,minMatches=1){
 const scores=new Float64Array(n),hits=new Uint16Array(n);let qnorm=0;
 for(const [term,freq] of query){
  const idf=index.idf.get(term);if(!idf)continue;
  const qw=(1+Math.log(freq))*idf;qnorm+=qw*qw;
  for(const [id,weight]of index.postings.get(term)||[]){scores[id]+=qw*weight;hits[id]++;}
 }
 const denominator=Math.sqrt(qnorm)||1;
 for(let i=0;i<n;i++)scores[i]=hits[i]>=minMatches?scores[i]/(denominator*index.norms[i]):0;
 return scores;
}

/** One first-stage retrieval strategy for small and large libraries. Every
 * indexed effective field participates in invalidation, including owner edits
 * that keep a body revision unchanged. Local concepts preserve bounded synonym
 * recall without a provider, downloaded model, or instruction-body scan.
 */
export class SkillFieldIndex{
 #fingerprint='';#entries=[];#title=null;#purpose=null;#tags=null;#aliases=null;#concepts=null;#buildMs=0;
 refresh(entries){
  if(!Array.isArray(entries))throw Error('Invalid skill metadata corpus.');
  const ids=new Set();for(const e of entries){
   if(!e||typeof e.id!=='string'||!e.id||ids.has(e.id))throw Error('Duplicate or invalid skill identifier.');
   ids.add(e.id);
  }
  const kept=entries.map(normalized),fingerprint=hashEntries(kept);
  if(fingerprint===this.#fingerprint)return false;
  const start=performance.now();
  this.#title=buildField(kept,e=>e.title);
  this.#purpose=buildField(kept,e=>e.purpose);
  this.#tags=buildField(kept,e=>e.tags.join(' '));
  this.#aliases=buildField(kept,e=>e.aliases.join(' '));
  this.#concepts=buildField(kept,e=>[e.title,e.purpose,...e.tags,...e.aliases].join(' '),semanticSkillTerms);
  this.#entries=kept;this.#fingerprint=fingerprint;this.#buildMs=performance.now()-start;
  return true;
 }
 search(query,{limit=100}={}){
  if(!Number.isInteger(limit)||limit<1||limit>256)throw Error('Invalid bounded skill candidate limit.');
  const started=performance.now(),text=String(query??'').slice(0,50000),terms=frequencies(text);
  const size=this.#entries.length;
  if(!size||!terms.size)return {candidates:[],totalMatches:0,queryTerms:terms.size,queryMs:performance.now()-started};
  const t=scoreField(this.#title,terms,size),d=scoreField(this.#purpose,terms,size),
   tags=scoreField(this.#tags,terms,size),aliases=scoreField(this.#aliases,terms,size),
   concepts=scoreField(this.#concepts,frequencies(text,semanticSkillTerms),size,2),ranked=[];
  for(let i=0;i<size;i++){
   const exactId=text.trim().toLowerCase()===this.#entries[i].id.toLowerCase();
   const score=exactId?1000:4*t[i]+2*d[i]+3*tags[i]+4*aliases[i]+concepts[i];
   if(score>0)ranked.push({i,score});
  }
  ranked.sort((a,b)=>b.score-a.score||this.#entries[a.i].id.localeCompare(this.#entries[b.i].id));
  const maximum=ranked[0]?.score||1;
  return {candidates:ranked.slice(0,limit).map(({i,score},index)=>({
   id:this.#entries[i].id,rank:index+1,score,routingScore:score/maximum*100
  })),totalMatches:ranked.length,queryTerms:terms.size,queryMs:performance.now()-started};
 }
 stats(){return {documents:this.#entries.length,buildMs:this.#buildMs,
  titleTerms:this.#title?.postings.size||0,descriptionTerms:this.#purpose?.postings.size||0,
  tagTerms:this.#tags?.postings.size||0,aliasTerms:this.#aliases?.postings.size||0};}
 close(){this.#fingerprint='';this.#entries=[];this.#title=null;this.#purpose=null;this.#tags=null;this.#aliases=null;this.#concepts=null;this.#buildMs=0;}
}
