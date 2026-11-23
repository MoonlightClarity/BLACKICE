// Live MiniCPM image transport via BLACKICE ProviderRuntime.
// Uses one fixed repository-owned synthetic fixture, an isolated provider store,
// and the already-running local llama.cpp server. No installed-app mutation.
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ProviderRuntime} from '../lib/providers.mjs';

const model='MiniCPM-V-4.7-1B-heretic-Q4_K_S',selection='local_llamacpp::'+model;
const imagePath=fileURLToPath(new URL('../tests/fixtures/minicpm-vision-transport-q7m2.png',import.meta.url));
const expectedImageHash='b8cb9666f45c829d98f61bf6f5ebe3a5c976c6922f73a4f846010d316ecba0ca';
class NoNative extends EventEmitter {
  status(){return {connected:false,authenticated:false,models:[]};}
  async close(){}
  async runAgent(){throw Error('Native Codex fallback is forbidden.');}
}
const dataDir=await mkdtemp(path.join(os.tmpdir(),'blackice-minicpm-vision-smoke-'));
let runtime;
try{
  const bytes=await readFile(imagePath),sha256=createHash('sha256').update(bytes).digest('hex');
  if(sha256!==expectedImageHash)throw Error('Fixed vision fixture was modified.');
  runtime=await new ProviderRuntime({codex:new NoNative(),dataDir,
    modelLimitResolver:{enrich:async(_config,models)=>models}}).init();
  await runtime.saveProvider({id:'local_llamacpp',type:'compatible',preset:'llamacpp',baseUrl:'http://127.0.0.1:8080/v1',
    models:[{id:model,inputModalities:['text','image'],contextWindowTokens:262144,maxOutputTokens:256}],maxSteps:2},
    {preserveDefault:true});
  const imageUrl='data:image/png;base64,'+bytes.toString('base64');
  const result=await runtime.runAgent({
    cwd:dataDir,model:selection,responseOnly:true,dynamicTools:[],
    prompt:'Read the attached image. Return the four-character code at top, then the color of the left rectangle, then the color of the right rectangle. Use code; left color; right color. Do not guess from filenames.',
    inputImages:[{imageUrl}],
  });
  const observed=String(result.output||'').trim(),normalized=observed.toLowerCase().replace(/\s+/g,'');
  const success=/q7m2;green;blue/.test(normalized);
  console.log('BLACKICE_MINICPM_VISION_PROBE '+JSON.stringify({model:selection,fixtureSha256:sha256,
    expected:'Q7M2; green; blue',observed,success,usage:result.usage?.last?{
    inputTokens:result.usage.last.inputTokens,outputTokens:result.usage.last.outputTokens}:null}));
  if(!success)process.exitCode=5;
}catch(error){console.error('BLACKICE_MINICPM_VISION_PROBE_ERROR '+JSON.stringify({code:error.code||null,message:error.message}));
  process.exitCode=9;
}finally{
 if(runtime)await runtime.close();
 await rm(dataDir,{recursive:true,force:true});
}
