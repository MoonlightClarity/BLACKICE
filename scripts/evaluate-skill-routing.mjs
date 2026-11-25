import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {discoverTaskSkills} from '../lib/task-skill-discovery.mjs';

// Offline-only evaluator. Dataset rows are inert retrieval text, never
// installed skills, authorized instructions, model training, or executable code.
function readRows(file) {
 const text=fs.readFileSync(file,'utf8');
 if(text.trimStart().startsWith('['))return JSON.parse(text);
 return text.split(/\r?\n/).filter(Boolean).map((line,index)=>{
  try{return JSON.parse(line);}catch{throw Error('Invalid JSONL at '+file+':'+(index+1));}
 });
}
export function evaluateRetrieval({skills,queries,qrels=[],limit=25,topK=8,route=discoverTaskSkills}) {
 const corpus=skills.map(row=>({id:String(row.id),title:String(row.name||row.title||''),
  description:String(row.description||'').slice(0,260),source:'public-evaluation-only',
  revision:'evaluation',tags:[row.major,row.sub,row.domain].filter(Boolean).map(String),
  aliases:[],ownerCreated:false}));
 const index=new Set(corpus.map(row=>row.id)),rels=new Map();
 for(const r of qrels)if(Number(r.relevance??1)>0){
  const k=String(r.query_id||r.queryId||'');if(!rels.has(k))rels.set(k,new Set());rels.get(k).add(String(r.skill_id||r.skillId));
 }
 let evaluated=0,recall=0,precision=0,ndcg=0,complete=0,mrr=0,latency=0,autoselections=0,missingLabels=0;
 const examples=[];
 for(const row of queries.slice(0,limit)){
  const name=String(row.query||row.text||''),key=String(row.id||row.query_id||'');
  const relevant=new Set([...(rels.get(key)||[]),...(Array.isArray(row.skill_ids)?row.skill_ids:[])].filter(id=>index.has(String(id))).map(String));
  if(!relevant.size){missingLabels++;continue;}
  const start=performance.now(),r=route(name,corpus),elapsed=performance.now()-start;
  const selected=[...(r.automatic||[]),...(r.candidates||[])].map(x=>x.id);
  const ordered=[...new Set(selected)].slice(0,topK),hits=ordered.map(id=>relevant.has(id)?1:0);
  const found=hits.reduce((a,b)=>a+b,0),ideal=Math.min(topK,relevant.size);
  const dcg=hits.reduce((sum,value,i)=>sum+value/Math.log2(i+2),0);
  const idcg=Array.from({length:ideal},(_,i)=>1/Math.log2(i+2)).reduce((a,b)=>a+b,0);
  evaluated++;recall+=found/relevant.size;precision+=found/topK;ndcg+=idcg?dcg/idcg:0;
  complete+=found===relevant.size?1:0;mrr+=hits.indexOf(1)<0?0:1/(hits.indexOf(1)+1);
  latency+=elapsed;autoselections+=(r.automatic||[]).length;
  if(examples.length<12)examples.push({queryId:key,needed:relevant.size,found,selected:ordered,ms:Math.round(elapsed)});
 }
 const n=Math.max(1,evaluated);
 return {corpus:corpus.length,queriesEvaluated:evaluated,missingLabels,topK,
  recallAtK:recall/n,precisionAtK:precision/n,ndcgAtK:ndcg/n,completenessAtK:complete/n,
  mrrAtK:mrr/n,meanQueryMs:latency/n,meanAutomatic:autoselections/n,examples,
  caveats:['This is retrieval only, not skill use or task success.','Labels and queries may be synthetic.',
  'Public skill bodies are not executed, loaded as instructions, or included in model context.',
  'Quality must also be assessed with paired task outcomes and user constraints.']};
}
function main(){
 const arg={};for(const value of process.argv.slice(2)){const m=/^--([a-z-]+)=(.+)$/.exec(value);if(m)arg[m[1]]=m[2];}
 if(!arg.skills||!arg.queries)throw Error('Supply --skills=PATH --queries=PATH [--qrels=PATH] [--limit=25] [--top-k=8]');
 const limit=Number(arg.limit||25),topK=Number(arg['top-k']||8);
 if(!Number.isInteger(limit)||limit<1||limit>500||!Number.isInteger(topK)||topK<1||topK>32)throw Error('Bounded evaluation limits are required.');
 const out=evaluateRetrieval({skills:readRows(path.resolve(arg.skills)),queries:readRows(path.resolve(arg.queries)),
  qrels:arg.qrels?readRows(path.resolve(arg.qrels)):[],limit,topK});
 console.log(JSON.stringify(out,null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main();