import test from 'node:test';
import assert from 'node:assert/strict';
import {semanticContrastPairs,semanticContrastCases} from './semantic-contrast-fixtures.mjs';
import {parseSemanticChoice,summarizeSemanticContrasts,runSemanticContrasts} from '../scripts/semantic-contrast-benchmark.mjs';
test('each contrast contains the same question with opposite decisive source facts',()=>{
 assert.equal(semanticContrastPairs.length,6);
 assert.equal(semanticContrastCases.length,12);
 assert.equal(new Set(semanticContrastCases.map(x=>x.id)).size,12);
 for(const pair of semanticContrastPairs){
  assert.ok(pair.question&&pair.cases.length===2);
  assert.deepEqual(new Set(pair.cases.map(c=>c.answer)),new Set(['A','B']));
  assert.ok(pair.cases.every(c=>c.source&&c.source!==pair.question));
 }
});
test('diagnostic scorer reports counterfactual consistency without pretending semantic certification',()=>{
 const rows=semanticContrastCases.slice(0,4).map(c=>({id:c.id,pair:c.pair,expected:c.answer,choice:c.answer}));
 assert.deepEqual(summarizeSemanticContrasts(rows).pairsBothCorrect,['actor-attribution','repository-presence']);
 const wrong=[...rows];wrong[1]={...wrong[1],choice:'A'};
 const summary=summarizeSemanticContrasts(wrong);
 assert.equal(summary.correct,3);assert.deepEqual(summary.pairsBothCorrect,['repository-presence']);
 assert.equal(summary.status,'diagnostic-partial');assert.equal(summary.semanticVerification,'not-established');
});
test('selected model and source contrasts reach provider requests without external app state',async()=>{
 const seen=[];
 const fetchImpl=async(_url,options)=>{
  const body=JSON.parse(options.body);seen.push(body);
  const expected=semanticContrastCases[seen.length-1].answer;
  return {ok:true,status:200,json:async()=>({choices:[{finish_reason:'stop',message:{role:'assistant',content:expected+') Synthetic reason'}}],usage:{total_tokens:40}})};
 };
 const rows=await runSemanticContrasts({model:'synthetic-model',url:'http://127.0.0.1:9999/v1',limit:2,fetchImpl});
 assert.equal(rows.length,2);assert.equal(rows[0].correct,true);assert.equal(rows[1].correct,true);
 assert.ok(seen.every(b=>b.model==='synthetic-model'&&b.temperature===0&&b.messages[1].content.includes('SOURCE')));
 assert.equal(parseSemanticChoice('A) Because the source says so'),'A');
 assert.equal(parseSemanticChoice('No relevant response'),null);
});
