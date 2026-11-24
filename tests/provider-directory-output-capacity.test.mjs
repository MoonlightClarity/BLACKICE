import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProviderRuntime} from '../lib/providers.mjs';

class Native extends EventEmitter {
  status(){return {connected:false,authenticated:false,models:[]};}
  async close(){}
  async runAgent(){throw Error('This fixture must not start native inference.');}
}
const json=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
async function fixture(t,{type='compatible',window=1000000,modelOutput=128000,configuredOutput=90000,outputTokenPolicy}={}){
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'directory-output-capacity-'));
  const requests=[],events=[];
  const runtime=await new ProviderRuntime({codex:new Native(),dataDir,
    modelLimitResolver:{enrich:async(_config,models)=>models},
    fetchImpl:async(url,options={})=>{
      assert.ok(String(url).startsWith('http://127.0.0.1:45678/'),'all requests remain within the fixture');
      if((options.method||'GET')==='GET')return json({data:[{id:'fixture',
        ...(window?{context_length:window,context_window:window}:{}),
        ...(modelOutput?{max_output_tokens:modelOutput,top_provider:{max_completion_tokens:modelOutput}}:{})}]});
      const body=JSON.parse(options.body);requests.push(body);
      if(type==='openai')return json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Done.'}]}],usage:{input_tokens:20,output_tokens:2,total_tokens:22}});
      if(type==='anthropic')return json({content:[{type:'text',text:'Done.'}],stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:2}});
      return json({choices:[{message:{role:'assistant',content:'Done.'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2,total_tokens:22}});
    }}).init();
  t.after(async()=>{await runtime.close();await rm(dataDir,{recursive:true,force:true});});
  await runtime.saveProvider({id:'fixture',type,baseUrl:'http://127.0.0.1:45678/v1',models:['fixture'],maxTokens:configuredOutput,...(outputTokenPolicy?{outputTokenPolicy}:{}),
    ...(type!=='compatible'?{apiKey:'synthetic-output-capacity-fixture'}:{})});
  const run=(context={enforceKnownCapacityOnly:true,autoCompact:false},prompt='Complete this Directory work package.')=>runtime.runAgent({
    cwd:dataDir,model:'fixture::fixture',prompt,context,dynamicTools:[],onEvent:event=>events.push(event)});
  return {runtime,requests,events,run};
}
const outputOf=body=>body.max_output_tokens??body.max_tokens;

for(const type of ['compatible','openai','anthropic'])test(type+': Directory uses configured/model output capacity beyond the implicit 8192-token reserve',async t=>{
  const f=await fixture(t,{type});
  await f.run();
  assert.equal(f.requests.length,1);assert.equal(outputOf(f.requests[0]),90000);
  const context=f.events.find(event=>event.type==='context').context;
  assert.equal(context.outputReserveTokens,90000);assert.equal(context.effectiveWindowTokens,1000000);
});

test('Directory honors the model output ceiling below the provider configuration',async t=>{
  const f=await fixture(t,{modelOutput:32768});await f.run();
  assert.equal(outputOf(f.requests[0]),32768);
});

test('Directory permits the complete input and reserves only actual remaining window capacity',async t=>{
  const f=await fixture(t,{window:32768,modelOutput:64000,configuredOutput:64000});
  const prompt='x'.repeat(75000)+'COMPLETE_INPUT_TAIL';
  await f.run({enforceKnownCapacityOnly:true,autoCompact:false,headroomTokens:128},prompt);
  const context=f.events.find(event=>event.type==='context').context;
  const available=32768-context.estimatedInputTokens-128;
  assert.ok(available>0&&available<8192);assert.equal(outputOf(f.requests[0]),available);
  assert.ok(JSON.stringify(f.requests[0].messages).includes(prompt));
  assert.equal(context.inputBudgetTokens,context.estimatedInputTokens);
});

test('Directory output is not restricted to twenty percent of a known window',async t=>{
  const f=await fixture(t,{window:32768,modelOutput:64000,configuredOutput:64000});
  await f.run({enforceKnownCapacityOnly:true,autoCompact:false,headroomTokens:128});
  const context=f.events.find(event=>event.type==='context').context;
  assert.equal(outputOf(f.requests[0]),32768-context.estimatedInputTokens-128);
  assert.ok(outputOf(f.requests[0])>30000);
});

test('an explicit conversation reserve governs admission but does not cap generation',async t=>{
  const f=await fixture(t);await f.run({enforceKnownCapacityOnly:true,autoCompact:false,outputReserveTokens:16384});
  assert.equal(outputOf(f.requests[0]),90000);
  assert.equal(f.events.find(event=>event.type==='context').context.outputReserveTokens,16384);
  const lower=await fixture(t,{configuredOutput:4096});
  await lower.run({enforceKnownCapacityOnly:true,autoCompact:false,outputReserveTokens:16384});
  assert.equal(outputOf(lower.requests[0]),4096);
});

test('unknown Directory window capacity defers input capacity to the provider and retains its configured output maximum',async t=>{
  const f=await fixture(t,{window:null,modelOutput:null,configuredOutput:24000});
  const prompt='x'.repeat(450000)+'FULL_UNKNOWN_CAPACITY_INPUT';
  await f.run(undefined,prompt);
  assert.equal(outputOf(f.requests[0]),24000);
  assert.ok(JSON.stringify(f.requests[0].messages).includes(prompt));
  assert.equal(f.events.find(event=>event.type==='context').context.effectiveWindowTokens,null);
});

test('ordinary Chat retains its reserve for admission without capping generation',async t=>{
  const f=await fixture(t);await f.run({autoCompact:false});
  assert.equal(outputOf(f.requests[0]),90000);
  assert.equal(f.events.find(event=>event.type==='context').context.outputReserveTokens,8192);
});

test('Directory still rejects input beyond a known model window before making a provider request',async t=>{
  const f=await fixture(t,{window:32768});
  await assert.rejects(f.run({enforceKnownCapacityOnly:true,autoCompact:false,headroomTokens:128},'x'.repeat(110000)),{code:'CONTEXT_OVERFLOW'});
  assert.equal(f.requests.length,0);
});

for(const type of ['compatible','openai','anthropic'])test(type+': automatic generation uses reported output capacity above 8192',async t=>{
  const f=await fixture(t,{type,configuredOutput:8192,modelOutput:64000,outputTokenPolicy:'provider-default'});
  await f.run({autoCompact:false});assert.equal(outputOf(f.requests[0]),64000);
});
for(const type of ['compatible','openai','anthropic'])test(type+': unknown input capacity never invents a 128k admission ceiling',async t=>{
  const f=await fixture(t,{type,window:null,modelOutput:null,configuredOutput:8192,outputTokenPolicy:'provider-default'});
  await f.run({autoCompact:false},'x'.repeat(450000)+'FULL_INPUT');
  const body=f.requests[0];assert.ok(JSON.stringify(body).includes('FULL_INPUT'));
  const context=f.events.find(event=>event.type==='context').context;
  assert.equal(context.effectiveWindowTokens,null);assert.equal(context.windowSource,'unresolved');
  assert.equal(outputOf(body),type==='anthropic'?8192:undefined);
});
test('default reserves cannot reject an otherwise fitting input near the known context boundary',async t=>{
  const f=await fixture(t,{window:32768,modelOutput:64000,configuredOutput:64000});
  await f.run({autoCompact:false},'x'.repeat(92000));
  const contexts=f.events.filter(e=>e.type==='context').map(e=>e.context);
  assert.ok(contexts.some(c=>c.warnings.some(w=>w.includes('Implicit context reserves reduced'))));
  assert.ok(outputOf(f.requests[0])>0);
  const g=await fixture(t,{window:32768,modelOutput:64000,configuredOutput:64000});
  await assert.rejects(g.run({autoCompact:false,outputReserveTokens:8192},'x'.repeat(92000)),{code:'CONTEXT_OVERFLOW'});
  assert.equal(g.requests.length,0);
});
