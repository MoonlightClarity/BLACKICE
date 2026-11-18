import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
class Runtime extends EventEmitter{
 status(){return{connected:true,authenticated:true,defaultModel:'fixture',activeTurns:0};}
 async start(){return this.status();}
 async close(){}
 async runAgent(){throw Error('Removing an interface must not start a model.');}
}
test('removed Learning has no UI, API, assets or service and leaves disk records untouched',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'blackice-learning-removed-'));
 const saved=path.join(dir,'learning.json'),bytes='original user data is not parsed or migrated';
 await writeFile(saved,bytes);
 const app=await createHarnessServer({runtime:new Runtime(),port:0,dataDir:dir,defaultCwd:dir,remoteAccess:null});
 t.after(async()=>{await app.close();assert.match(path.basename(dir),/^blackice-learning-removed-/);await rm(dir,{recursive:true,force:true});});
 const base=await app.listen({waitForRemote:false}),home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0];
 assert.doesNotMatch(await home.text(),/data-space="learning"|learning.css|>Learning</);
 assert.equal(Object.hasOwn(app,'learning'),false);
 for(const [route,method] of [['/api/learning','GET'],['/api/learning','POST'],['/learning-ui.mjs','GET'],['/learning.css','GET']]){
  const response=await fetch(base+route,{method,headers:{Cookie:cookie,...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:'{}'}:{})});
  assert.equal(response.status,404,route);await response.arrayBuffer();
 }
 assert.equal(await readFile(saved,'utf8'),bytes);
 assert.equal(app.engine.listRuns().length,0);
 for(const file of ['lib/learning.mjs','public/learning-ui.mjs','public/learning.css'])await assert.rejects(access(new URL('../'+file,import.meta.url)),{code:'ENOENT'});
});
