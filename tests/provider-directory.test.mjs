import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeModelsDevIndex,searchProviderEntries,
  searchAPIProviderDirectory,resetProviderDirectoryCache
} from '../lib/provider-directory.mjs';

const index={
  'sample-compatible':{
    name:'Independent Model Gateway',api:'https://models.example.org/v1',
    npm:'@ai-sdk/openai-compatible',env:['MODEL_API_KEY'],doc:'https://models.example.org/docs',
    models:{
      'model/one':{tool_call:true,cost:{input:0,output:0}},
      'model/two':{tool_call:false,cost:{input:1,output:1}},
    },
  },
  'unknown-auth':{
    name:'Mystery Inference',api:'https://mystery.example.org/v1',npm:'@ai-sdk/openai-compatible',
    models:{'mystery-preview':{cost:{input:0,output:0}}}
  },
  'unsupported-native':{
    name:'Native Provider',npm:'native-protocol',env:['NATIVE_KEY'],
    models:{'native-model':{cost:{input:0,output:0}}}
  }
};

test('searches actual model providers, including model IDs, across reviewed and external sources',()=>{
  const entries=normalizeModelsDevIndex(index);
  assert.equal(entries.length,3);
  const keyed=entries.find(x=>x.providerId==='sample-compatible');
  assert.equal(keyed.authentication,'keyed');
  assert.equal(keyed.compatibility,'index-reported-compatible');
  assert.equal(keyed.zeroPriceModels,1);
  assert.equal(keyed.toolModels,1);
  assert.deepEqual(searchProviderEntries({query:'model/one',source:'index'},entries).items.map(x=>x.name),['Independent Model Gateway']);
  assert.deepEqual(searchProviderEntries({query:'mystery',source:'index',auth:'unverified'},entries).items.map(x=>x.name),['Mystery Inference']);
  assert.equal(searchProviderEntries({query:'model',source:'index',freeModelsOnly:true},entries).total,2);
  assert.equal(searchProviderEntries({source:'supported',auth:'keyless'},entries).items.some(x=>x.preset==='kilo_free'),true);
  assert.equal(searchProviderEntries({source:'supported',auth:'keyed'},entries).items.some(x=>x.preset==='openrouter'),true);
});

test('model indexes cannot claim keyless just because no environment variable is listed',()=>{
  const entries=normalizeModelsDevIndex(index);
  assert.equal(entries.find(e=>e.providerId==='unknown-auth').authentication,'unverified');
  assert.equal(entries.find(e=>e.providerId==='unsupported-native').compatibility,'unverified');
  assert.equal(entries.find(e=>e.providerId==='unsupported-native').baseUrl,'');
  assert.equal(entries.find(e=>e.providerId==='sample-compatible').referenceUrl,'https://models.dev/providers/sample-compatible/');
});

test('read-only index search caches, pages, and sends no credentials or settings to the directory',async()=>{
  resetProviderDirectoryCache();
  let sent=[], clock=Date.parse('2026-11-06T10:00:00Z');
  const fetchImpl=async(url,opts)=>{
    sent.push({url,method:opts.method,headers:opts.headers});
    return new Response(JSON.stringify(index),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const deps={fetchImpl,now:()=>clock};
  const first=await searchAPIProviderDirectory({query:'model',source:'index',limit:1},deps);
  assert.equal(first.items.length,1);
  assert.equal(first.hasMore,true);
  assert.equal(first.indexStale,false);
  await searchAPIProviderDirectory({query:'model',source:'index',offset:1,limit:1},deps);
  assert.equal(sent.length,1,'pagination searches cached full index');
  assert.equal(sent[0].url,'https://models.dev/api.json');
  assert.deepEqual(sent[0].headers,{Accept:'application/json'});
  assert.equal((await searchAPIProviderDirectory({source:'supported'},deps)).items.length>0,true);
  assert.equal(sent.length,1,'reviewed preset searches never contact external index');
  clock+=11*60_000;
  await searchAPIProviderDirectory({query:'model',source:'index'},deps);
  assert.equal(sent.length,2,'expired provider directory refreshes');
  resetProviderDirectoryCache();
});

test('failed index refresh retains the last successful snapshot as stale, not live',async()=>{
  resetProviderDirectoryCache();
  const successful=async()=>new Response(JSON.stringify(index),{status:200,headers:{'Content-Type':'application/json'}});
  let clock=Date.parse('2026-11-06T10:00:00Z');
  await searchAPIProviderDirectory({source:'index'},{fetchImpl:successful,now:()=>clock});
  clock+=11*60_000;
  const failed=await searchAPIProviderDirectory({source:'index'},{fetchImpl:async()=>{throw Error('offline');},now:()=>clock});
  assert.equal(failed.items.length,3);
  assert.equal(failed.indexStale,true);
  assert.match(failed.warning,/Could not refresh/);
  resetProviderDirectoryCache();
});

test('bad filters reject before any index fetch',async()=>{
  resetProviderDirectoryCache();
  let called=0;
  await assert.rejects(
    searchAPIProviderDirectory({auth:'fake'},{fetchImpl:()=>{called++;}}),
    {code:'INVALID_MODEL_PROVIDER_SEARCH'});
  assert.equal(called,0);
});
