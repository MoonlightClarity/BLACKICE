import test from 'node:test';import assert from 'node:assert/strict';
import {evaluateFieldRetrieval,heldoutIndices,bootstrapDifference} from '../scripts/evaluate-field-skill-retrieval.mjs';
test('held-out sampling is deterministic and excludes previous calibration queries',()=>{
 const a=heldoutIndices(4392,{limit:200}),b=heldoutIndices(4392,{limit:200});
 assert.deepEqual(a,b);assert.equal(new Set(a).size,200);
 for(let i=0;i<25;i++)assert(!a.includes(i));
 const spaced=Array.from({length:25},(_,i)=>Math.floor((i+.5)*4392/25));for(const i of spaced)assert(!a.includes(i));
});
test('field retrieval evaluation is bounded and labels never enter ranking',()=>{
 const skills=[{id:'rust',name:'Rust async',description:'Build async Rust service',body:'Rust implementation'},
  {id:'garden',name:'Gardening',description:'Plant flowers',body:'Garden flowers'}];
 const queries=Array.from({length:280},(_,i)=>({id:'q-'+i,query:'Rust async service',skill_ids:['rust']}));
 const qrels=queries.map(row=>({query_id:row.id,skill_id:'rust',relevance:1}));
 const out=evaluateFieldRetrieval({skills,queries,qrels,limit:5,baselineLimit:2});
 assert.equal(out.dataset.evaluated,5);assert(out.methods['field-top8'].recall>=.99);
 assert.equal(out.methods['field-body100'].recall,1);
 assert.equal(out.methods['legacy-top8'].n,2);
 assert.equal(out.sample.strategy.includes('excludes'),true);
 assert.throws(()=>evaluateFieldRetrieval({skills,queries,qrels,limit:501}),/limits/);
});
test('paired bootstrap is reproducible and does not manufacture precision',()=>{
 const a=bootstrapDifference([0,1,.5,.5]);const b=bootstrapDifference([0,1,.5,.5]);
 assert.deepEqual(a,b);assert.equal(a.mean,.5);assert(a.ci95[0]>=0&&a.ci95[1]<=1);
});
