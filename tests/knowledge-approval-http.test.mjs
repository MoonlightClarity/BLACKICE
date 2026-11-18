import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
class Runtime extends EventEmitter {
 status(){return {connected:true,authenticated:true,defaultModel:'fixture',activeTurns:0};}
 async start(){return this.status();} async close(){} async runAgent(){assert.fail('No model in approval test');}
}
test('retired approval HTTP cannot approve, reject or bypass legacy proposals locally or remotely',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-approval-http-')),cwd=path.join(root,'workspace');await mkdir(cwd);
 const dataDir=path.join(root,'data'),archive=path.join(dataDir,'knowledge-approvals.json'),id='saved-proposal';await mkdir(dataDir);
 const before=JSON.stringify({version:1,approvals:[{id,kind:'memory',title:'Legacy pending proposal',status:'pending',content:'Synthetic fact'}]});await writeFile(archive,before);
 const app=await createHarnessServer({runtime:new Runtime(),port:0,dataDir:path.join(root,'data'),defaultCwd:cwd});
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});const url=await app.listen();
 const home=await fetch(url),cookie=home.headers.get('set-cookie').split(';')[0];await home.text();
 const request=async(route,body,remote=false)=>{const res=await fetch(url+route,{method:body?'POST':'GET',headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{}),...(remote?{'x-blackice-remote':'1'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()};};
 assert.equal(app.knowledge,undefined);
 for(const [route,body] of [
 ['/api/knowledge/approvals'],['/api/knowledge/approvals/'+id,{decision:'approve'}],
 ['/api/knowledge/approvals/'+id,{decision:'reject'}],['/api/knowledge/approvals/'+id,{decision:'approve',content:'Injected'}],
 ['/api/knowledge',{kind:'skill',title:'Human authored',content:'Reusable procedure'}]
 ])for(const remote of [false,true]){
  const result=await request(route,body,remote);assert.equal(result.status,404);
 }
 assert.equal((await fetch(url+'/api/knowledge/approvals')).status,401);
 assert.equal(await readFile(archive,'utf8'),before);
});
