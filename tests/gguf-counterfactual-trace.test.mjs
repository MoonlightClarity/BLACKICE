import test from 'node:test';
import assert from 'node:assert/strict';
import {runBehaviorTrace,createOrderPair,parseChoiceTrace,summarizeBehaviorTrace,validateLocalUrl} from '../scripts/gguf-counterfactual-trace.mjs';
const sample={id:'x',source:'Only two of five participants improved.',question:'Did everyone improve? A) Yes. B) No.',answer:'B'};
test('balanced question and source ordering, with thinking disabled for answer-token comparison',async()=>{
 const calls=[];
 const transport=async(url,body)=>{
  calls.push({url,body});
  if(url.endsWith('/apply-template'))return {prompt:body.messages.map(x=>x.content).join('\n')+'<think>\n</think>\n'};
  assert.equal(body.cache_prompt,false);
  assert.equal(body.grammar,'root ::= "A" | "B"');
  return {content:'B',completion_probabilities:[{token:'B',logprob:-0.1,top_logprobs:[{token:'B',logprob:-0.1},{token:'A',logprob:-2.3},{token:' B',logprob:-9}]}],tokens_evaluated:40};
 };
 const rows=await runBehaviorTrace({url:'http://127.0.0.1:18086',cases:[sample],limit:1,transport});
 assert.equal(rows.length,2);
 assert.ok(rows.every(x=>x.correct&&x.logOddsAOverB<0));
 assert.ok(calls.filter(c=>c.url.endsWith('/apply-template')).every(c=>c.body.chat_template_kwargs.enable_thinking===false));
 assert.ok(!JSON.stringify(rows).includes('two of five'));
 assert.notEqual(calls[0].body.messages[1].content,calls[2].body.messages[1].content);
 assert.deepEqual(summarizeBehaviorTrace(rows).orderFlips,[]);
});
test('forced-token probes retrieve missing logprobs but cannot set the observed answer',async()=>{
 const calls=[];
 const transport=async(url,body)=>{
  calls.push({url,body});
  if(url.endsWith('/apply-template'))return {prompt:'<|im_start|>assistant\n<think>\n</think>\n'};
  if(body.grammar==='root ::= "A"')return {content:'A',completion_probabilities:[{token:'A',logprob:-15}]};
  return {content:'B',completion_probabilities:[{token:'B',logprob:-0.1,top_logprobs:[{token:'B',logprob:-0.1}]}]};
 };
 const rows=await runBehaviorTrace({url:'http://localhost:18086',cases:[sample],limit:1,transport});
 assert.equal(rows.length,2);
 assert.equal(rows[0].constrainedAnswer,'B');
 assert.equal(rows[0].forcedProbeLetters[0],'A');
 assert.ok(rows[0].logOddsAOverB<0);
});
test('template with open reasoning section must fail before logits are interpreted',async()=>{
 await assert.rejects(runBehaviorTrace({url:'http://127.0.0.1:18086',cases:[sample],limit:1,transport:async()=>({prompt:'<|im_start|>assistant\n<think>\n'})}),/Reasoning section remains open/);
});
test('only local endpoints; no semantic certification',()=>{
 assert.throws(()=>validateLocalUrl('http://example.com'),/local loopback/);
 assert.throws(()=>validateLocalUrl('https://127.0.0.1'),/local loopback/);
 assert.equal(parseChoiceTrace({content:'Other'}).choice,null);
 assert.equal(summarizeBehaviorTrace([]).semanticVerification,'not-established');
 assert.equal(summarizeBehaviorTrace([]).layerTracing,'not-instrumented');
 assert.deepEqual(createOrderPair(sample).map(x=>x.expected),['B','B']);
});
