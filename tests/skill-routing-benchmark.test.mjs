import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateRetrieval} from '../scripts/evaluate-skill-routing.mjs';

test('offline retrieval evaluator preserves relevant labels and never counts absent evidence as success',()=>{
 const skills=[{id:'a',name:'Source Inspection',description:'Inspect source documents'},
 {id:'b',name:'Allocation',description:'Compare effort and opportunity cost'},
 {id:'c',name:'Unrelated',description:'Garden pruning'}];
 const queries=[{id:'q1',query:'Choose where to invest scarce effort',skill_ids:['b']},
  {id:'q2',query:'Inspect source documents',skill_ids:['a']}];
 const route=(q)=>q.includes('effort')?{automatic:[{id:'b'}],candidates:[{id:'a'}]}:
  {automatic:[],candidates:[{id:'a'},{id:'b'}]};
 const result=evaluateRetrieval({skills,queries,route,limit:2,topK:2});
 assert.equal(result.queriesEvaluated,2);assert.equal(result.missingLabels,0);
 assert.equal(result.recallAtK,1);assert.equal(result.ndcgAtK,1);assert.equal(result.completenessAtK,1);
 assert.equal(result.meanAutomatic,0.5);
 const missing=evaluateRetrieval({skills,queries:[{id:'z',query:'missing',skill_ids:['unknown']}],route,limit:1});
 assert.equal(missing.queriesEvaluated,0);assert.equal(missing.missingLabels,1);
});
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
test('CLI executes from a path alias and produces scored JSON instead of exiting empty',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'blackice-skillret-cli-'));
 try{
  const skills=path.join(dir,'skills.jsonl'),queries=path.join(dir,'queries.jsonl'),qrels=path.join(dir,'qrels.jsonl');
  writeFileSync(skills,JSON.stringify({id:'x',name:'Review a report',description:'Assess a written report',major:'Information Retrieval'})+'\n');
  writeFileSync(queries,JSON.stringify({id:'q-1',query:'Review this report',skill_ids:['x']})+'\n');
  writeFileSync(qrels,JSON.stringify({query_id:'q-1',skill_id:'x',relevance:1})+'\n');
  const script=path.resolve('scripts/evaluate-skill-routing.mjs');
  const executed=spawnSync(process.execPath,[script,'--skills='+skills,'--queries='+queries,'--qrels='+qrels,'--limit=1','--top-k=8'],{encoding:'utf8',timeout:15000,env:{...process.env,NODE_NO_WARNINGS:'1'}});
  assert.equal(executed.status,0,executed.stderr);
  assert(executed.stdout.trim(), 'CLI must not exit successfully with empty stdout');
  const summary=JSON.parse(executed.stdout);assert.equal(summary.corpus,1);assert.equal(summary.queriesEvaluated,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('spaced sample is reproducible, independent of labels, and the evaluator reports automatic fanout',()=>{
 const skills=[{id:'s',name:'Generic task',description:'A generic useful method'}];
 const queries=Array.from({length:10},(_,i)=>({id:'q-'+i,query:'Prompt '+i,skill_ids:['s']}));
 const selected=[];
 const route=(q)=>{selected.push(q);return {automatic:[{id:'s'}],candidates:[]}};
 const out=evaluateRetrieval({skills,queries,limit:3,sample:'spaced',topK:8,route});
 assert.deepEqual(selected,['Prompt 1','Prompt 5','Prompt 8']);
 assert.equal(out.sample,'spaced');assert.equal(out.queriesEvaluated,3);
 assert.equal(out.maxAutomatic,1);assert.equal(out.meanAutomatic,1);
 assert.throws(()=>evaluateRetrieval({skills,queries,route,sample:'random'}),/sampling/);
});


test('paired evaluation compares the same query with metadata-only and inert body reranking',()=>{
 const skills=[{id:'generic',name:'General method',description:'Generic writing help',body:'Manage files and messages.'},
  {id:'typeset',name:'Typeset',description:'Fix typography',body:'Improve font choices hierarchy readability and typography by adjusting weights and sizes.'}];
 const queries=[{id:'q-1',query:'Improve font choices hierarchy and readability through typography',skill_ids:['typeset']}];
 const route=()=>({automatic:[],candidates:[{id:'generic'}],selection:{decisions:[
  {id:'generic',routingScore:80,decision:'candidate'},
  {id:'typeset',routingScore:50,decision:'candidate-limit'}
 ]}});
 const results=evaluateRetrieval({skills,queries,route,limit:1,topK:1,bodyPool:2});
 assert.equal(results.recallAtK,0);assert.equal(results.bodyExperiment.recallAtK,1);
 assert.equal(results.bodyExperiment.poolCeilingRecall,1);
 assert.equal(results.bodyExperiment.kind,'inert-offline-rerank-not-runtime-enabled');
 assert.equal(results.examples[0].bodySelected[0],'typeset');
});
