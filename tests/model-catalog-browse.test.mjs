import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProviderRuntime} from '../lib/providers.mjs';
import {createDirectProviderSetupTools} from '../lib/provider-setup-tools.mjs';
import {validDirectArguments} from '../lib/direct-execution-api.mjs';

class Native extends EventEmitter {
  status(){return {connected:true,authenticated:true,defaultModel:'native-known',models:[{id:'native-known',model:'native-known'}]};}
  async close(){}
  async runAgent(){throw Error('Browsing models must not start inference.');}
}
const prices={prompt:'0',completion:'0',request:'0'};
const catalog=[
  {id:'alpha/tiny:free',name:'Alpha tiny',context_length:8192,max_output_tokens:1024,supported_parameters:['tools'],pricing:prices},
  {id:'beta/big:free',name:'Beta big',context_length:200000,max_output_tokens:32000,supported_parameters:['tools'],architecture:{input_modalities:['text','image'],output_modalities:['text']},pricing:prices},
  {id:'alpha/paid',name:'Alpha paid',context_length:50000,max_output_tokens:65000,supported_parameters:['max_tokens'],pricing:{prompt:'0.0001',completion:'0.0002'}},
  {id:'beta/unknown:free',name:'Beta unknown',pricing:prices},
  {id:'gamma/no-price:free',name:'Gamma no-price',context_length:1000000,max_output_tokens:4096,supported_parameters:['tools']},
  {id:'alpha/medium:free',name:'Alpha medium',context_length:65536,max_output_tokens:16384,supported_parameters:['max_tokens'],pricing:prices}
];
async function fixture(t){
  const dir=await mkdtemp(path.join(os.tmpdir(),'model-browse-')),requests=[];
  const runtime=await new ProviderRuntime({codex:new Native(),dataDir:dir,fetchImpl:async(url,options)=>{
    requests.push({url,method:options.method});assert.equal(options.method,'GET');
    return new Response(JSON.stringify({data:catalog}),{headers:{'Content-Type':'application/json'}});
  }}).init();
  t.after(async()=>{await runtime.close();await rm(dir,{recursive:true,force:true});});
  await runtime.saveProvider({id:'fixture',type:'compatible',baseUrl:'https://model-browse.example/v1',apiKey:'saved-catalog-fixture-key',models:[{id:'saved-existing',contextWindowTokens:32768,maxOutputTokens:4096}]});
  assert.equal(requests.length,0);
  return {runtime,requests};
}

test('catalog filtering and context/output ordering cover all models before pagination and preserve saved connection',async t=>{
  const {runtime,requests}=await fixture(t),before=JSON.stringify(runtime.listProviders());
  const largest=await runtime.discoverModels('fixture',{sort:'context-desc',limit:2});
  assert.deepEqual(largest.models.map(m=>m.id),['gamma/no-price:free','beta/big:free']);
  assert.equal(largest.total,6);assert.equal(largest.totalModels,6);assert.equal(largest.returned,2);assert.equal(largest.hasMore,true);
  assert.equal(largest.groups.reduce((sum,g)=>sum+g.total,0),6);
  assert.equal(largest.groups.find(g=>g.label.toLowerCase()==='alpha').total,3);
  const tail=await runtime.discoverModels('fixture',{sort:'context-desc',offset:4,limit:2});
  assert.deepEqual(tail.models.map(m=>m.id),['alpha/tiny:free','beta/unknown:free']);assert.equal(tail.hasMore,false);
  const ascending=await runtime.discoverModels('fixture',{sort:'context-asc'});
  assert.equal(ascending.models[0].id,'alpha/tiny:free');assert.equal(ascending.models.at(-1).id,'beta/unknown:free');
  const output=await runtime.discoverModels('fixture',{sort:'output-desc'});
  assert.equal(output.models[0].id,'alpha/paid');assert.equal(output.models.at(-1).id,'beta/unknown:free');
  const filtered=await runtime.discoverModels('fixture',{query:'beta BIG',sort:'context-desc',minContextTokens:131072,toolsOnly:true,visionOnly:true,freeOnly:true,limit:1});
  assert.deepEqual(filtered.models.map(m=>m.id),['beta/big:free']);assert.equal(filtered.total,1);assert.equal(filtered.hasMore,false);
  const tools=await runtime.discoverModels('fixture',{toolsOnly:true});
  assert.ok(tools.models.every(m=>m.supportsTools===true));assert.equal(tools.total,3);
  const free=await runtime.discoverModels('fixture',{freeOnly:true});
  assert.ok(!free.models.some(m=>m.id==='gamma/no-price:free'));assert.equal(free.total,4);
  assert.equal(requests.length,1,'search, filters and pages use the same cached full catalog');
  assert.equal(JSON.stringify(runtime.listProviders()),before);assert.equal(runtime.store.key('fixture'),'saved-catalog-fixture-key');
});

test('invalid catalog sort, capability flags and minimum context fail before a provider request',async t=>{
  const {runtime,requests}=await fixture(t);
  for(const options of [{sort:'random'},{minContextTokens:-1},{minContextTokens:1.5},{minContextTokens:'32000'},{minContextTokens:Number.MAX_SAFE_INTEGER+1},{visionOnly:'true'},{toolsOnly:'true'}]){
    await assert.rejects(runtime.discoverModels('fixture',options),{code:'INVALID_MODEL_SEARCH'});
  }
  assert.equal(requests.length,0);
});

test('direct catalog tool exposes and executes the same search, context and capability filter contract',async t=>{
  const {runtime}=await fixture(t),tools=createDirectProviderSetupTools({runtime,browser:{},reauthorize:async()=>{}});
  const tool=tools.find(item=>item.definition.name==='blackice_provider_read');
  const value={requestId:'catalog-filter-contract',action:'catalog',providerId:'fixture',sort:'context-desc',query:'beta',minContextTokens:131072,freeOnly:true,toolsOnly:true,visionOnly:true,limit:1};
  assert.equal(validDirectArguments(value,tool.definition.inputSchema),true);
  assert.equal(validDirectArguments({...value,sort:'random'},tool.definition.inputSchema),false);
  const response=JSON.parse((await tool.execute(value,{client:{id:'catalog-fixture'}})).contentItems[0].text);
  assert.equal(response.modelStarted,false);assert.equal(response.providerTurns,false);assert.equal(response.total,1);
  assert.deepEqual(response.models.map(m=>m.id),['beta/big:free']);assert.equal(response.filters.minContextTokens,131072);
});
