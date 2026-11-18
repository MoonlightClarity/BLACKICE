import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';
class Runtime extends EventEmitter {
  status(){return {connected:true,authenticated:true,defaultModel:'fixture',activeTurns:0};}
  async start(){return this.status();} async close(){} async runAgent(){assert.fail('No model may run in folder API tests.');}
}
test('retired folder HTTP rejects organization and reads without changing legacy records',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-folders-http-'));
  const archive=path.join(root,'data','knowledge.json'),saved={id:'legacy',kind:'memory',title:'Legacy record',content:'Keep this intact'},before=JSON.stringify({version:1,entries:[saved]});await mkdir(path.dirname(archive));await writeFile(archive,before);
  const app=await createHarnessServer({runtime:new Runtime(),port:0,dataDir:path.join(root,'data'),defaultCwd:path.join(root,'workspace')});
  t.after(async()=>{await app.close();assert.match(path.basename(root),/^blackice-folders-http-/);await rm(root,{recursive:true,force:true});});
  const url=await app.listen();
  const home=await fetch(url),cookie=home.headers.get('set-cookie').split(';')[0];await home.text();
  const request=async(route,body)=>{const res=await fetch(url+route,{method:body?'POST':'GET',headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()};};
  assert.equal(app.knowledge,undefined);
  for(const [route,body] of [
   ['/api/knowledge/folders'],['/api/knowledge/folders',{action:'create',name:'Personal',expectedRevision:1}],
   ['/api/knowledge/folders',{action:'move',entryIds:[saved.id],folderId:'legacy',expectedRevision:1}],
   ['/api/knowledge/folders',{action:'rename',folderId:'legacy',name:'Changed',expectedRevision:1}],
   ['/api/knowledge/folders',{action:'remove',folderId:'legacy',expectedRevision:1}],
   ['/api/knowledge?folderId=&source=user'],['/api/knowledge/'+saved.id],['/api/knowledge/'+saved.id+'/history']
  ]){
   const result=await request(route,body);assert.equal(result.status,404,route);
  }
  assert.equal(await readFile(archive,'utf8'),before);
  assert.equal((await fetch(url+'/api/knowledge/folders')).status,401);
});
