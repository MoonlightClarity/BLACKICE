import test from 'node:test';
import assert from 'node:assert/strict';
import {llamaCppDownloads} from '../lib/llama-cpp-downloads.mjs';
import {localModelHTTP} from '../lib/local-model-http.mjs';
test('download HTTP route is local, GET-only and retains actionable failures',async()=>{
 let calls=0; const manager={downloads:async()=>{calls++;return {tag:'b1',assets:[]}}};
 const args={manager,pathname:'/api/local-models/downloads',method:'GET'};
 assert.equal((await localModelHTTP({...args,remote:true})).status,403);
 assert.equal((await localModelHTTP({...args,method:'POST'})).status,405); assert.equal(calls,0);
 assert.equal((await localModelHTTP(args)).status,200); assert.equal(calls,1);
 manager.downloads=async()=>{throw Object.assign(Error('offline'),{status:502,code:'LLAMA_DOWNLOAD_CATALOG_UNAVAILABLE'})};
 assert.equal((await localModelHTTP(args)).body.code,'LLAMA_DOWNLOAD_CATALOG_UNAVAILABLE');
});
const asset = (name = 'llama-b123-bin-win-cpu-x64.zip') => ({name, size: 1234, browser_download_url: 'https://github.com/ggml-org/llama.cpp/releases/download/b123/' + name, digest: 'sha256:' + 'a'.repeat(64)});
const fetcher = data => async (url, options) => { assert.equal(new URL(url).hostname, 'api.github.com'); assert.equal(options.redirect, 'error'); return {ok:true,json:async()=>data}; };
test('official download discovery skips pointer tags and exposes exact runtime/dependency assets', async () => {
 const r=await llamaCppDownloads(fetcher([{tag_name:'v1.0.0',assets:[]},{tag_name:'b123',assets:[asset(),asset('cudart-llama-bin-win-cuda-x64.zip')]}]));
 assert.equal(r.tag,'b123'); assert.equal(r.assets.length,2); assert.equal(r.assets[0].sha256,'a'.repeat(64)); assert.equal(r.assets[1].dependency,true);
});
test('download discovery rejects unofficial, malformed, nonarchive and invalid size assets', async () => {
 const bad=[{...asset(),browser_download_url:'https://evil.example/a.zip'},{...asset(),browser_download_url:asset().browser_download_url+'?x=1'},{...asset(),size:-1},{...asset(),browser_download_url:'https://github.com/ggml-org/llama.cpp/releases/download/b123/%ZZ'},{...asset(),name:'source.exe'}];
 const r=await llamaCppDownloads(fetcher([{tag_name:'b123',assets:[...bad,asset()]}])); assert.equal(r.assets.length,1);
});
test('download metadata failures are actionable and never install anything', async () => {
 for(const fn of [async()=>{throw Error('offline')},async()=>({ok:false,status:429}),fetcher([]),fetcher({})])
 await assert.rejects(llamaCppDownloads(fn),{code:'LLAMA_DOWNLOAD_CATALOG_UNAVAILABLE'});
});
