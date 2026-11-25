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