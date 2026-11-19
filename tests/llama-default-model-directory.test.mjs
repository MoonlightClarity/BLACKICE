import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {LocalModelManager} from '../lib/local-model-manager.mjs';
import {localModelHTTP} from '../lib/local-model-http.mjs';

async function fixture(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-model-folder-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:60}));
 const executable=path.join(root,'llama-server.exe');await fs.writeFile(executable,'fixture, never executed');
 const launches=[],requests=[];
 async function init(){
  let online=false,rows=[],directory;
  const readModels=async()=>{rows=(await fs.readdir(directory)).filter(n=>n.endsWith('.gguf')).map(n=>({id:n.slice(0,-5),status:'unloaded'}));};
  const fetchImpl=async(url,options)=>{
   const {pathname:route,search}=new URL(url);requests.push({route,method:options.method});
   if(!online)throw Error('Router fixture is stopped.');
   if(route==='/props')return Response.json({role:'router'});
   if(route==='/models'){if(search==='?reload=1'){requests.at(-1).reload=true;await readModels();}return Response.json({data:rows});}
   throw Error('Unexpected route '+route);
  };
  const spawnImpl=(_cmd,args)=>{
   directory=args[args.indexOf('--models-dir')+1];
   launches.push(directory);
   const child=new EventEmitter();child.pid=6000+launches.length;
   child.kill=()=>{online=false;queueMicrotask(()=>child.emit('close',0));};
   void readModels().then(()=>{online=true;});
   return child;
  };
  return new LocalModelManager({dataDir:path.join(root,'profile'),fetchImpl,spawnImpl,llamaExecutableCandidates:[executable]}).init();
 }
 const api=(manager,method='GET',value,route='/api/local-models/config',remote=false)=>localModelHTTP({manager,method,value,pathname:route,remote});
 return {root,launches,requests,init,api};
}

test('fresh profile creates the declared default, and owned router discovers a GGUF there without loading',async t=>{
 const f=await fixture(t),manager=await f.init();
 t.after(()=>manager.close());
 const blocked=await f.api(manager,'POST',{},'/api/local-models/discover',true);assert.equal(blocked.status,403);
 const config=(await f.api(manager)).body, directory=path.join(f.root,'profile','models');
 assert.equal(config.settings.modelsDirectory,'','blank remains a default choice, not an explicit override');
 assert.equal(config.defaultModelsDirectory,directory);
 assert.deepEqual(config.modelDirectory,{path:directory,usingDefault:true,available:true});
 assert.equal(config.launchArgs[config.launchArgs.indexOf('--models-dir')+1],directory);
 assert.ok((await fs.stat(directory)).isDirectory());
 assert.equal(f.launches.length,0,'opening Config does not start a router');
 await fs.writeFile(path.join(directory,'fixture.gguf'),'fixture bytes, not loaded');
 const result=await f.api(manager,'POST',{},'/api/local-models/discover');
 assert.equal(result.status,200);assert.equal(result.body.owned,true);
 assert.deepEqual(result.body.models.map(m=>[m.id,m.loaded]),[['fixture',false]]);
 assert.deepEqual(f.launches,[directory]);assert.ok(f.requests.every(r=>r.method==='GET'));
 const active=await manager.llamaSupervisor.acquire(manager.effectiveLlamaSettings(),config.revision);
 await fs.writeFile(path.join(directory,'added.gguf'),'fixture bytes, not loaded');
 const deferred=await f.api(manager,'POST',{},'/api/local-models/discover');
 assert.equal(deferred.status,409);assert.equal(deferred.body.code,'LOCAL_LLAMA_RESTART_BUSY');assert.deepEqual(f.launches,[directory]);
 assert.equal(f.requests.some(r=>r.reload),false,'an active lease prevents a catalog reload');
 active.release();
 const rescanned=await f.api(manager,'POST',{},'/api/local-models/discover');
 assert.deepEqual(rescanned.body.models.map(m=>m.id).sort(),['added','fixture']);
 assert.deepEqual(f.launches,[directory],'same configuration refresh does not replace the router');
 assert.equal(f.requests.filter(r=>r.reload).length,1);
 await manager.close();
 const restarted=await f.init();t.after(()=>restarted.close());
 assert.equal((await f.api(restarted)).body.modelDirectory.path,directory);
});

test('explicit folder is preserved across restart, unavailable folders are not created, blank returns to default',async t=>{
 const f=await fixture(t),manager=await f.init();
 t.after(()=>manager.close());
 const missing=path.join(f.root,'custom model weights');
 const initial=(await f.api(manager)).body;
 const saved=await f.api(manager,'POST',{expectedRevision:initial.revision,settings:{...initial.settings,modelsDirectory:missing}});
 assert.equal(saved.status,200);
 assert.equal(saved.body.modelDirectory.path,missing);
 assert.equal(saved.body.modelDirectory.usingDefault,false);
 assert.equal(saved.body.modelDirectory.available,false);
 await assert.rejects(fs.stat(missing),{code:'ENOENT'});
 const noDiscover=await f.api(manager,'POST',{},'/api/local-models/discover');
 assert.equal(noDiscover.status,503);assert.equal(noDiscover.body.code,'LOCAL_LLAMA_MODELS_DIRECTORY_MISSING');assert.deepEqual(f.launches,[]);
 await fs.mkdir(missing);await fs.writeFile(path.join(missing,'custom.gguf'),'fixture bytes');
 await manager.close();
 const restarted=await f.init();t.after(()=>restarted.close());
 const config=(await f.api(restarted)).body;assert.equal(config.settings.modelsDirectory,missing);
 const result=await f.api(restarted,'POST',{},'/api/local-models/discover');
 assert.equal(result.status,200);assert.equal(result.body.models[0].id,'custom');assert.deepEqual(f.launches,[missing]);
 const cleared=await f.api(restarted,'POST',{expectedRevision:config.revision,settings:{...config.settings,modelsDirectory:''}});
 assert.equal(cleared.body.modelDirectory.path,initial.defaultModelsDirectory);
 const applied=await f.api(restarted,'POST',{},'/api/local-models/discover');
 assert.equal(applied.status,200);assert.deepEqual(applied.body.models,[]);
 assert.deepEqual(f.launches,[missing,initial.defaultModelsDirectory]);
 assert.equal(f.requests.some(r=>r.reload),false,'a fresh router already read its new directory');
});

test('a non-directory at the default location is reported; no model or conflicting file is touched',async t=>{
 const f=await fixture(t),manager=await f.init();
 t.after(()=>manager.close());
 const pending=manager.llamaConfig().defaultModelsDirectory;
 await fs.mkdir(path.dirname(pending),{recursive:true});await fs.writeFile(pending,'kept');
 const state=(await f.api(manager)).body.modelDirectory;
 assert.equal(state.available,false);assert.equal(state.usingDefault,true);assert.match(state.error,/could not create or access/);
 const attempt=await f.api(manager,'POST',{},'/api/local-models/discover');
 assert.equal(attempt.status,503);assert.deepEqual(f.launches,[]);
 assert.equal(await fs.readFile(pending,'utf8'),'kept');
});
