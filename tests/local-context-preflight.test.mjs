import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ProviderRuntime } from '../lib/providers.mjs';

function fixture({count=26895,reserve,remote=false,status=200}={}){
  const calls=[],events=[];
  const runtime=new ProviderRuntime({dataDir:'.',codex:new EventEmitter(),fetchImpl:async(url,opts)=>{
    calls.push({url,body:JSON.parse(opts.body),redirect:opts.redirect});
    return new Response(JSON.stringify({input_tokens:count}),{status});
  }});
  const config={type:'compatible',id:'local_llamacpp',preset:'llamacpp',
    baseUrl:remote?'https://remote.example/v1':'http://127.0.0.1:8080/v1',maxTokens:8192,
    models:[{id:'model',contextWindowTokens:32768,contextWindowSource:'provider-reported'}]};
  const tools=[{wireName:'fixture_read',description:'Fixture',inputSchema:{type:'object'}}];
  const state={record:{id:'provider_test',model:'model',messages:[{role:'user',content:'test'}],contextOptions:reserve===undefined?{}:{outputReserveTokens:reserve}},
    config,tools,instructions:'x'.repeat(119000),turnId:'turn-test',onEvent:event=>events.push(event)};
  return {runtime,state,calls,events};
}
test('count-only local preflight uses chat template with tools and adapts only its default answer reserve',async()=>{
  const {runtime,state,calls}=fixture();
  const fit=await runtime.ensureContext(state);
  assert.equal(calls.length,1); assert.equal(new URL(calls[0].url).pathname,'/v1/chat/completions/input_tokens');
  assert.equal(calls[0].redirect,'error');
  assert.equal(calls[0].body.messages[0].role,'system'); assert.deepEqual(calls[0].body.messages.at(-1),{role:'user',content:'test'});
  assert.equal(calls[0].body.tools[0].function.name,'fixture_read'); assert.equal(calls[0].body.max_tokens,undefined);
  assert.equal(fit.effectiveWindowTokens,32768);assert.equal(fit.measuredInputTokens,26895);
  assert.equal(fit.inputBudgetTokens,26895);assert.equal(fit.outputReserveTokens,4235);
  assert.equal(state.responseMaxTokens,undefined,'managed llama.cpp owns generation admission; the context reserve is not a generation ceiling');
});
test('local tokenizer does not overrule explicit reserve, hard context, or missing capability',async()=>{
  for(const [setup,wanted,calls] of [
    [{reserve:6553},'26895 measured',1], [{count:32500},'32500 measured',1],
    [{status:404},'estimated',1], [{remote:true},'estimated',0],
  ]){
    const f=fixture(setup);
    await assert.rejects(f.runtime.ensureContext(f.state),error=>error.code==='CONTEXT_OVERFLOW'&&error.message.includes(wanted)&&error.message.includes('No older exchanges'));
    assert.equal(f.calls.length,calls);
  }
});

test('automatic compaction reports attempts and failures without hiding the original history',async()=>{
  const f=fixture({count:26000});
  f.state.record.messages=[
    {role:'user',content:'First message'},{role:'assistant',content:'An answer'},
    {role:'user',content:'Second message'},{role:'assistant',content:'Another answer'},
  ];
  const before=structuredClone(f.state.record.messages);
  f.runtime.compactRecord=async()=>{throw Object.assign(Error('Summary model stopped.'),{code:'CONTEXT_SUMMARY_FAILED'});};
  const fit=await f.runtime.ensureContext(f.state);
  assert.equal(fit.compactionState,'failed');
  assert.match(fit.compactionReason,/Summary model stopped.*Continuing with unchanged history/);
  assert.deepEqual(f.events.filter(e=>e.context?.compactionState).map(e=>e.context.compactionState),['running','failed']);
  assert.equal(f.state.record.contextStatus.compactionState,'failed');
  assert.equal(f.state.compactionDeferred,fit.compactionReason);
  assert.deepEqual(f.state.record.messages,before);
});

test('a failed early compaction keeps running with unchanged history while the prompt fits',async()=>{
  const f=fixture({count:22000});
  f.state.record.messages=['First direction','First result','Latest direction','Latest result']
    .map((content,index)=>({role:index%2?'assistant':'user',content}));
  const before=structuredClone(f.state.record.messages);
  let attempts=0;
  f.runtime.compactRecord=async()=>{
    attempts++;
    throw Object.assign(Error('Summary model stopped.'),{code:'CONTEXT_SUMMARY_FAILED'});
  };
  const fit=await f.runtime.ensureContext(f.state);
  assert.equal(fit.compactionState,'failed');
  assert.match(fit.compactionReason,/Continuing with unchanged history/);
  assert.deepEqual(f.state.record.messages,before);
  assert.deepEqual(f.events.filter(e=>e.context?.compactionState).map(e=>e.context.compactionState),['running','failed']);
  await f.runtime.ensureContext(f.state);
  assert.equal(attempts,1,'do not repeat a failed early compression at each step');
  // Force a physically impossible prompt rather than just crossing an
  // adjustable implicit reserve; reserve adjustment is not itself a failure.
  f.runtime.measureLocalContext=async(_state,context)=>({...context,measuredInputTokens:context.effectiveWindowTokens+1});
  await assert.rejects(f.runtime.ensureContext(f.state),{code:'CONTEXT_SUMMARY_FAILED'});
  assert.equal(attempts,2,'retry when the original history does not fit');
  assert.deepEqual(f.state.record.messages,before);
});
