import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';

const schema = {type:'object',additionalProperties:false,properties:{answer:{type:'string'}},required:['answer']};
const answer = '{"answer":"Verified synthetic response"}';
class NoNativeRuntime extends EventEmitter {
  status(){return {connected:false,authenticated:false,defaultModel:'native-fixture',models:[]};}
  async close(){}
  async runAgent(){assert.fail('Output-budget fixtures cannot start a native model.');}
}
async function fixture(t,{type='compatible',configured=16384,modelLimit=131072,window=1000000}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'planning-output-budget-')),requests=[],events=[];
  const runtime=await new ProviderRuntime({codex:new NoNativeRuntime(),dataDir:directory,fetchImpl:async(url,options={})=>{
    assert.equal(new URL(url).hostname,'127.0.0.1','All provider traffic is intercepted local fixture traffic.');
    if(options.method==='GET')return new Response(JSON.stringify({data:[{id:'budget-model'}]}),{status:200,headers:{'content-type':'application/json'}});
    assert.equal(options.method,'POST');
    const body=JSON.parse(options.body);requests.push(body);
    const result=type==='openai'
      ? {id:'fixture-response',status:'completed',output:[{id:'message',type:'message',role:'assistant',content:[{type:'output_text',text:answer}]}],usage:{input_tokens:2,output_tokens:3}}
      : type==='anthropic'
        ? {id:'fixture-message',type:'message',role:'assistant',content:[{type:'text',text:answer}],stop_reason:'end_turn',usage:{input_tokens:2,output_tokens:3}}
        : {choices:[{message:{role:'assistant',content:answer},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:3}};
    return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}});
  }}).init();
  t.after(async()=>{await runtime.close();await rm(directory,{recursive:true,force:true});});
  await runtime.saveProvider({id:'budget',type,baseUrl:'http://127.0.0.1:1/v1',apiKey:'synthetic-fixture-key',maxTokens:configured,models:[{id:'budget-model',contextWindowTokens:window,maxOutputTokens:modelLimit}]});
  return {requests,events,run:overrides=>runtime.runAgent({cwd:directory,prompt:'Return the requested public JSON response.',model:'budget::budget-model',effort:'default',responseOnly:true,outputSchema:schema,dynamicTools:[],onEvent:event=>events.push(event),...overrides})};
}
async function check(t,setup,overrides,expected){
  const f=await fixture(t,setup),result=await f.run(overrides);
  assert.equal(result.output,answer);
  assert.equal(f.requests.length,1,'Budget selection never repeats the provider request.');
  const body=f.requests[0];
  assert.equal(setup?.type==='openai'?body.max_output_tokens:body.max_tokens,expected,'The actual outgoing request uses the available configured planning budget.');
  const context=f.events.filter(event=>event.type==='context').at(-1)?.context;
  assert.ok(context,'The effective context budget is observable.');
  assert.equal(context.outputReserveTokens,expected);
  assert.equal(context.inputBudgetTokens+context.outputReserveTokens+context.headroomTokens,context.effectiveWindowTokens);
  assert.ok(context.inputBudgetTokens>=256);
  return {f,body,context};
}
for(const type of ['compatible','openai','anthropic']){
  test(type+' structured planning requests use the configured 16K output budget',async t=>{
    await check(t,{type},{},16384);
  });
}
test('an explicit planning context output reserve remains authoritative',async t=>{
  await check(t,{}, {context:{outputReserveTokens:4096}},4096);
});
test('a planning response respects the selected model output limit',async t=>{
  await check(t,{modelLimit:12000},{},12000);
});
test('a planning response reserves at most one fifth of the selected context window by default',async t=>{
  await check(t,{}, {context:{preset:'custom',windowTokens:20000}},4000);
});
test('a planning response respects a lower configured provider output budget',async t=>{
  await check(t,{configured:4096},{},4096);
});
test('ordinary Chat retains its existing inferred 8K reserve',async t=>{
  await check(t,{}, {responseOnly:false,outputSchema:undefined},8192);
});
