import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {discoverTaskSkills} from '../lib/task-skill-discovery.mjs';
import {SkillHybridIndex} from '../lib/skill-hybrid-retrieval.mjs';
import {rankInertSkillBodies} from './skill-body-rerank.mjs';

// Offline-only evaluator. Dataset rows are inert retrieval text, never
// installed skills, authorized instructions, model training, or executable code.
function readRows(file) {
 const text=fs.readFileSync(file,'utf8');
 if(text.trimStart().startsWith('['))return JSON.parse(text);
 return text.split(/\r?\n/).filter(Boolean).map((line,index)=>{
  try{return JSON.parse(line);}catch{throw Error('Invalid JSONL at '+file+':'+(index+1));}
 });
}
export function evaluateRetrieval({skills,queries,qrels=[],limit=25,topK=8,sample='head',bodyPool=0,route=discoverTaskSkills}) {
 if(!Number.isInteger(bodyPool)||bodyPool<0||bodyPool>256)throw Error('Invalid bounded body experiment pool.');
 if(!['head','spaced'].includes(sample))throw Error('Unknown evaluation sampling method.');
 const corpus=skills.map(row=>({id:String(row.id),title:String(row.name||row.title||''),
  description:String(row.description||'').slice(0,260),source:'public-evaluation-only',
  revision:'evaluation',tags:[row.major,row.sub,row.domain].filter(Boolean).map(String),
  aliases:[],ownerCreated:false}));
 const index=new Set(corpus.map(row=>row.id)),rels=new Map();
 for(const r of qrels)if(Number(r.relevance??1)>0){
  const k=String(r.query_id||r.queryId||'');if(!rels.has(k))rels.set(k,new Set());rels.get(k).add(String(r.skill_id||r.skillId));
 }
 let evaluated=0,recall=0,precision=0,ndcg=0,complete=0,mrr=0,latency=0,autoselections=0,maxAutomatic=0,missingLabels=0;
 const examples=[];
 const bodies=bodyPool?new Map(skills.map(row=>[String(row.id),row])):null;
 let bodyRecall=0,bodyNdcg=0,bodyComplete=0,bodyMrr=0,bodyPoolRecall=0,bodyLatency=0;
 const rows=sample==='spaced'&&limit<queries.length
  ?Array.from({length:limit},(_,i)=>queries[Math.floor((i+0.5)*queries.length/limit)])
  :queries.slice(0,limit);
 // One disposable full-corpus index for all queries. Runtime dispatch still
 // validates each effective catalog revision before loading skill contents.
 const sharedIndex=new SkillHybridIndex();
 try { for(const row of rows){
  const name=String(row.query||row.text||''),key=String(row.id||row.query_id||'');
  const relevant=new Set([...(rels.get(key)||[]),...(Array.isArray(row.skill_ids)?row.skill_ids:[])].filter(id=>index.has(String(id))).map(String));
  if(!relevant.size){missingLabels++;continue;}
  const start=performance.now(),r=route(name,corpus,{hybridIndex:sharedIndex}),elapsed=performance.now()-start;
  const selected=[...(r.automatic||[]),...(r.candidates||[])].map(x=>x.id);
  const ordered=[...new Set(selected)].slice(0,topK),hits=ordered.map(id=>relevant.has(id)?1:0);
  const found=hits.reduce((a,b)=>a+b,0),ideal=Math.min(topK,relevant.size);
  const dcg=hits.reduce((sum,value,i)=>sum+value/Math.log2(i+2),0);
  const idcg=Array.from({length:ideal},(_,i)=>1/Math.log2(i+2)).reduce((a,b)=>a+b,0);
  evaluated++;recall+=found/relevant.size;precision+=found/topK;ndcg+=idcg?dcg/idcg:0;
  complete+=found===relevant.size?1:0;mrr+=hits.indexOf(1)<0?0:1/(hits.indexOf(1)+1);
  latency+=elapsed;autoselections+=(r.automatic||[]).length;maxAutomatic=Math.max(maxAutomatic,(r.automatic||[]).length);
  let bodyFound,bodySelected;
  if(bodyPool){
   const stage1=(r.selection?.decisions||[])
    .filter(decision=>Number.isFinite(decision.routingScore)&&decision.routingScore>=0
      &&['candidate','candidate-limit','selected'].includes(decision.decision))
    .sort((a,b)=>b.routingScore-a.routingScore||String(a.id).localeCompare(String(b.id))).slice(0,bodyPool);
   const members=new Set(stage1.map(item=>item.id));
   bodyPoolRecall+=[...relevant].filter(id=>members.has(id)).length/relevant.size;
   const pool=stage1.map(item=>({...bodies.get(item.id),id:item.id,routingScore:item.routingScore}));
   const bodyStart=performance.now();const ranked=rankInertSkillBodies(name,pool,{limit:topK});bodyLatency+=performance.now()-bodyStart;
   bodySelected=ranked.ranked.map(item=>item.id);
   const alternative=bodySelected.map(id=>Number(relevant.has(id)));
   bodyFound=alternative.reduce((a,b)=>a+b,0);
   const alternativeDcg=alternative.reduce((sum,value,i)=>sum+value/Math.log2(i+2),0);
   bodyRecall+=bodyFound/relevant.size;bodyNdcg+=idcg?alternativeDcg/idcg:0;
   bodyComplete+=Number(bodyFound===relevant.size);
   bodyMrr+=alternative.indexOf(1)<0?0:1/(alternative.indexOf(1)+1);
  }
  if(examples.length<12)examples.push({queryId:key,needed:relevant.size,found,selected:ordered,ms:Math.round(elapsed),...(bodyPool?{bodyFound,bodySelected}:{})});
 } } finally { sharedIndex.close(); }
 const n=Math.max(1,evaluated);
 return {corpus:corpus.length,queriesEvaluated:evaluated,missingLabels,topK,sample,
  recallAtK:recall/n,precisionAtK:precision/n,ndcgAtK:ndcg/n,completenessAtK:complete/n,
  mrrAtK:mrr/n,meanQueryMs:latency/n,meanAutomatic:autoselections/n,maxAutomatic,examples,
  ...(bodyPool?{bodyExperiment:{pool:bodyPool,recallAtK:bodyRecall/n,ndcgAtK:bodyNdcg/n,completenessAtK:bodyComplete/n,mrrAtK:bodyMrr/n,poolCeilingRecall:bodyPoolRecall/n,meanRerankMs:bodyLatency/n,kind:'inert-offline-rerank-not-runtime-enabled'}}:{}),
  caveats:['This is retrieval only, not skill use or task success.','Labels and queries may be synthetic.',
  'Public skill bodies are not executed, loaded as instructions, or included in model context.',
  'Quality must also be assessed with paired task outcomes and user constraints.']};
}
function main(){
 const arg={};for(const value of process.argv.slice(2)){const m=/^--([a-z-]+)=(.+)$/.exec(value);if(m)arg[m[1]]=m[2];}
 if(!arg.skills||!arg.queries)throw Error('Supply --skills=PATH --queries=PATH [--qrels=PATH] [--limit=25] [--top-k=8] [--sample=spaced] [--body-pool=100]');
 const limit=Number(arg.limit||25),topK=Number(arg['top-k']||8),bodyPool=Number(arg['body-pool']||0);
 if(!Number.isInteger(limit)||limit<1||limit>500||!Number.isInteger(topK)||topK<1||topK>32||!Number.isInteger(bodyPool)||bodyPool<0||bodyPool>256)throw Error('Bounded evaluation limits are required.');
 const out=evaluateRetrieval({skills:readRows(path.resolve(arg.skills)),queries:readRows(path.resolve(arg.queries)),
  sample:arg.sample||'head',
  qrels:arg.qrels?readRows(path.resolve(arg.qrels)):[],limit,topK,bodyPool});
 console.log(JSON.stringify(out,null,2));
}
function invokedAsMain() {
 if (!process.argv[1]) return false;
 try {
  const invoked=fs.realpathSync.native(path.resolve(process.argv[1]));
  const loaded=fs.realpathSync.native(fileURLToPath(import.meta.url));
  return process.platform==='win32'?invoked.toLowerCase()===loaded.toLowerCase():invoked===loaded;
 } catch { return false; }
}
if (invokedAsMain()) main();