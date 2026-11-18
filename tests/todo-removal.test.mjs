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
test('removed To-do has no UI, API, assets or service and leaves disk records untouched',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'blackice-todo-removed-'));
 const saved=path.join(dir,'user-todos.json'),bytes='original user data is not parsed or migrated';
 await writeFile(saved,bytes);
 const app=await createHarnessServer({runtime:new Runtime(),port:0,dataDir:dir,defaultCwd:dir,remoteAccess:null});
 t.after(async()=>{await app.close();assert.match(path.basename(dir),/^blackice-todo-removed-/);await rm(dir,{recursive:true,force:true});});
 const base=await app.listen({waitForRemote:false}),home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0];
 assert.doesNotMatch(await home.text(),/data-space="todos"|todos.css|>To-do</);
 assert.equal(Object.hasOwn(app,'userTodos'),false);
 for(const [route,method] of [['/api/todos','GET'],['/api/todos','POST'],['/api/todos/legacy','GET'],['/next/workspaces/todos.mjs','GET'],['/next/todos.css','GET']]){
  const response=await fetch(base+route,{method,headers:{Cookie:cookie,...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:'{}'}:{})});
  assert.equal(response.status,404,route);await response.arrayBuffer();
 }
 assert.equal(await readFile(saved,'utf8'),bytes);
 assert.equal(app.engine.listRuns().length,0);
 for(const file of ['lib/user-todos.mjs','lib/user-todo-http.mjs','public/next/workspaces/todos.mjs','public/next/todos.css'])await assert.rejects(access(new URL('../'+file,import.meta.url)),{code:'ENOENT'});
});
