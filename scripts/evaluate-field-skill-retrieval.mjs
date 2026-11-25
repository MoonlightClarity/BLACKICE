import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {SkillFieldIndex} from '../lib/skill-field-retrieval.mjs';
import {rankInertSkillBodies} from '../lib/skill-body-rerank.mjs';
import {discoverTaskSkills} from '../lib/task-skill-discovery.mjs';
import {SkillHybridIndex} from '../lib/skill-hybrid-retrieval.mjs';

// Inert public retrieval corpus: no skill bodies are installed or injected.
export function readJsonLines(file){
 const text=fs.readFileSync(file,'utf8');
 return text.split(/\r?\n/).filter(Boolean).map((s,i)=>{
  try{return JSON.parse(s);}catch{throw Error('Invalid JSONL row '+(i+1)+' in '+file);}
 });
}
const pseudoRandom=(seed)=>{
 let state=seed>>>0;
 return ()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)/2**32);
};
export function heldoutIndices(size,{limit=200,seed=0xC0FFEE}={}){
 if(!Number.isInteger(size)||size<1||!Number.isInteger(limit)||limit<1||limit>size)throw Error('Invalid held-out sampling limits.');
 const excluded=new Set();
 for(let i=0;i<Math.min(25,size);i++)excluded.add(i);
 for(let i=0;i<25&&size>0;i++)excluded.add(Math.floor((i+0.5)*size/25));
 // Reproduce the earlier, already inspected 200-query sample exactly and
 // exclude it, rather than accidentally measuring on development queries.
 const prior=Array.from({length:size},(_,i)=>i).filter(i=>!excluded.has(i));
 const old=pseudoRandom(0x51AF);
 for(let i=prior.length-1;i>0;i--){const j=Math.floor(old()*(i+1));[prior[i],prior[j]]=[prior[j],prior[i]];}
 for(const i of prior.slice(0,200))excluded.add(i);
 const fresh=Array.from({length:size},(_,i)=>i).filter(i=>!excluded.has(i));
 if(limit>fresh.length)throw Error('Not enough previously unseen queries.');
 const random=pseudoRandom(seed);
 for(let i=fresh.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[fresh[i],fresh[j]]=[fresh[j],fresh[i]];}
 return fresh.slice(0,limit);
}
const rankMetrics=(ids,relevant,k=8)=>{
 const picks=ids.slice(0,k),found=picks.filter(id=>relevant.has(id)).length;
 const ideal=Math.min(k,relevant.size);
 const dcg=picks.reduce((a,id,i)=>a+Number(relevant.has(id))/Math.log2(i+2),0);
 const idcg=Array.from({length:ideal},(_,i)=>1/Math.log2(i+2)).reduce((a,b)=>a+b,0)||1;
 return {recall:found/relevant.size,ndcg:dcg/idcg,complete:Number(found===relevant.size),
  mrr:picks.findIndex(id=>relevant.has(id))<0?0:1/(picks.findIndex(id=>relevant.has(id))+1)};
};
const init=()=>({n:0,recall:0,ndcg:0,complete:0,mrr:0,poolCeiling:0,meanMs:0});
const accumulate=(state,metrics,elapsed=0,ceiling=0)=>{
 state.n++;for(const key of ['recall','ndcg','complete','mrr'])state[key]+=metrics[key];
 state.meanMs+=elapsed;state.poolCeiling+=ceiling;
};
const meanState=state=>Object.fromEntries(Object.entries(state).map(([key,value])=>[key,key==='n'?value:(state.n?value/state.n:0)]));
const average=values=>values.reduce((a,b)=>a+b,0)/Math.max(1,values.length);
export function bootstrapDifference(deltas,{replicates=2000,seed=0xB0057}={}){
 const random=pseudoRandom(seed),boot=[];if(!deltas.length)return {mean:0,ci95:[0,0]};
 for(let i=0;i<replicates;i++){let sum=0;for(let j=0;j<deltas.length;j++)sum+=deltas[Math.floor(random()*deltas.length)];boot.push(sum/deltas.length);}
 boot.sort((a,b)=>a-b);return {mean:average(deltas),ci95:[boot[Math.floor(.025*replicates)],boot[Math.floor(.975*replicates)-1]]};
}
export function evaluateFieldRetrieval({skills,queries,qrels,limit=200,baselineLimit=0,seed=0xC0FFEE}){
 if(!Number.isInteger(limit)||limit<1||limit>500||!Number.isInteger(baselineLimit)||baselineLimit<0||baselineLimit>50||baselineLimit>limit)throw Error('Invalid evaluation limits.');
 const entries=skills.map(s=>({id:String(s.id),title:String(s.name??s.title??''),
  description:String(s.description??'').slice(0,260),source:'public-evaluation-only',revision:'pinned-evaluation'}));
 const skillsById=new Map(skills.map(s=>[String(s.id),s]));
 const refs=new Set(entries.map(e=>e.id));const gold=new Map();
 for(const row of qrels)if(Number(row.relevance??1)>0&&refs.has(String(row.skill_id))){
  const id=String(row.query_id),v=gold.get(id)||new Set();v.add(String(row.skill_id));gold.set(id,v);
 }
 const choices=heldoutIndices(queries.length,{limit,seed});
 const index=new SkillFieldIndex(),hybrid=new SkillHybridIndex();
 const memoryBefore=process.memoryUsage().heapUsed,indexStart=performance.now();index.refresh(entries);
 const buildMs=performance.now()-indexStart,indexStats=index.stats(),memoryAfter=process.memoryUsage().heapUsed;
 const data=Object.fromEntries(['field-top8','field-body50','field-body100','hybrid-sparse-top8','hybrid-sparse-body100','legacy-top8','legacy-body100'].map(k=>[k,init()]));
 const paired=[],failures=[];let cases=0,noLabel=0,indexQueryMs=0,bodyTimeMs=0;
 try{
 for(const selectedIndex of choices){
  const query=queries[selectedIndex],name=String(query.query??query.text??''),key=String(query.id??query.query_id);
  const rel=new Set([...(gold.get(key)||[]),...(Array.isArray(query.skill_ids)?query.skill_ids:[])].map(String).filter(id=>refs.has(id)));
  if(!rel.size){noLabel++;continue;}
  cases++;
  const t=performance.now(),first=index.search(name,{limit:100});
  indexQueryMs+=performance.now()-t;
  const top=first.candidates,top8=top.slice(0,8).map(r=>r.id);
  const fieldTop=rankMetrics(top8,rel),pool50=top.slice(0,50),pool100=top;
  const ceiling50=pool50.filter(r=>rel.has(r.id)).length/rel.size;
  const ceiling100=pool100.filter(r=>rel.has(r.id)).length/rel.size;
  accumulate(data['field-top8'],fieldTop,first.queryMs,ceiling100);
  const options=[];
  for(const [kind,pool,ceiling]of [['field-body50',pool50,ceiling50],['field-body100',pool100,ceiling100]]){
   const docs=pool.map(row=>({...skillsById.get(row.id),id:row.id,routingScore:row.routingScore}));
   const start=performance.now(),ranked=rankInertSkillBodies(name,docs,{limit:8,maxBodyChars:16000});
   const elapsed=performance.now()-start;bodyTimeMs+=elapsed;
   const result=rankMetrics(ranked.ranked.map(x=>x.id),rel);
   accumulate(data[kind],result,first.queryMs+elapsed,ceiling);
   if(kind==='field-body100')options.push(result);
  }
  // Preserve declared task-facet activation while accelerating optional candidates.
  const routeStart=performance.now(),routing=discoverTaskSkills(name,entries,{fieldIndex:index,fieldThreshold:128,fieldLimit:100});
  const routedMs=performance.now()-routeStart;
  const routed=[...(routing.automatic||[]),...(routing.candidates||[])].map(x=>x.id).slice(0,8);
  const routePool=(routing.selection?.decisions||[]).filter(x=>Number.isFinite(x.routingScore)&&x.routingScore>=0
   &&['candidate','candidate-limit','selected'].includes(x.decision))
   .sort((a,b)=>b.routingScore-a.routingScore||String(a.id).localeCompare(String(b.id))).slice(0,100);
  accumulate(data['hybrid-sparse-top8'],rankMetrics(routed,rel),routedMs,0);
  const bodyStart=performance.now(),bodyMatches=rankInertSkillBodies(name,routePool.map(x=>({...skillsById.get(x.id),id:x.id,routingScore:x.routingScore})),{limit:8,maxBodyChars:16000}).ranked;
  const bodyElapsed=performance.now()-bodyStart;
  const hybridOutcome=rankMetrics(bodyMatches.map(x=>x.id),rel);
  accumulate(data['hybrid-sparse-body100'],hybridOutcome,routedMs+bodyElapsed,
   routePool.filter(x=>rel.has(x.id)).length/rel.size);
  if(baselineLimit&&cases<=baselineLimit){
   const start=performance.now(),old=discoverTaskSkills(name,entries,{hybridIndex:hybrid,fieldThreshold:100000});
   const oldMs=performance.now()-start,oldPicks=[...(old.automatic||[]),...(old.candidates||[])].map(x=>x.id).slice(0,8);
   const oldResult=rankMetrics(oldPicks,rel);
   accumulate(data['legacy-top8'],oldResult,oldMs,0);
   const stage=(old.selection?.decisions||[]).filter(x=>Number.isFinite(x.routingScore)&&x.routingScore>=0
    &&['candidate','candidate-limit','selected'].includes(x.decision))
    .sort((a,b)=>b.routingScore-a.routingScore||String(a.id).localeCompare(String(b.id))).slice(0,100);
   const docs=stage.map(r=>({...skillsById.get(r.id),id:r.id,routingScore:r.routingScore}));
   const rt=performance.now(),ranked=rankInertSkillBodies(name,docs,{limit:8,maxBodyChars:16000});
   const rMs=performance.now()-rt;
   accumulate(data['legacy-body100'],rankMetrics(ranked.ranked.map(x=>x.id),rel),oldMs+rMs,stage.filter(x=>rel.has(x.id)).length/rel.size);
  }
  paired.push({id:key,fieldTop:fieldTop.recall,fieldBody100:options[0].recall,hybridBody100:hybridOutcome.recall,
   fieldNdcg:options[0].ndcg,hybridNdcg:hybridOutcome.ndcg});
  if(options[0].recall<1&&failures.length<8)failures.push({queryId:key,relevantCount:rel.size,top100Recall:ceiling100,afterRerank:options[0].recall});
 }
 }finally{hybrid.close();index.close();}
 return {
  dataset:{skills:skills.length,allQueries:queries.length,selected:choices.length,evaluated:cases,missingLabels:noLabel},
  sample:{strategy:'seeded untouched, excludes earlier 50 and prior 200 reviewed queries',seed:seed>>>0,indices:choices.slice(0,10)},
  index:{...indexStats,buildMs,memoryDeltaMB:(memoryAfter-memoryBefore)/1024/1024,meanQueryMs:indexQueryMs/Math.max(1,cases)},
  methods:Object.fromEntries(Object.entries(data).map(([k,v])=>[k,meanState(v)])),
  gain:bootstrapDifference(paired.map(r=>r.fieldBody100-r.fieldTop)),
  hybridGain:bootstrapDifference(paired.map(r=>r.hybridBody100-r.fieldBody100)),
  hybridNdcgGain:bootstrapDifference(paired.map(r=>r.hybridNdcg-r.fieldNdcg)),
  missedExamples:failures,
  note:'Offline public-skill retrieval only. No public skills activated and no job applications run.'
 };
}
const CLI=fileURLToPath(import.meta.url);
const invoked=process.argv[1]?fs.realpathSync.native(path.resolve(process.argv[1])):null;
if(invoked&&(process.platform==='win32'?invoked.toLowerCase()===fs.realpathSync.native(CLI).toLowerCase():invoked===fs.realpathSync.native(CLI))){
 const args=Object.fromEntries(process.argv.slice(2).map(part=>{const m=/^--([a-z-]+)=(.*)$/.exec(part);if(!m)throw Error('Invalid CLI option '+part);return[m[1],m[2]];}));
 for(const key of ['skills','queries','qrels'])if(!args[key])throw Error('Missing --'+key);
 const summary=evaluateFieldRetrieval({skills:readJsonLines(args.skills),queries:readJsonLines(args.queries),qrels:readJsonLines(args.qrels),
  limit:Number(args.limit||200),baselineLimit:Number(args['baseline-limit']||0),seed:Number(args.seed||0xC0FFEE)});
 if(args.output)fs.writeFileSync(args.output,JSON.stringify(summary,null,2));
 console.log(JSON.stringify(summary,null,2));
}
