import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';
class Runtime extends EventEmitter {
  status(){return {connected:true,authenticated:true,defaultModel:'fixture',activeTurns:0};}
  async start(){return this.status();} async close(){} async runAgent(){assert.fail('No model may run in folder API tests.');}
}
test('folder HTTP workflow preserves saved content and supports unfile/source queries',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-folders-http-'));
  const app=await createHarnessServer({runtime:new Runtime(),port:0,dataDir:path.join(root,'data'),defaultCwd:path.join(root,'workspace')});
  const url=await app.listen();
  t.after(async()=>{await app.close();assert.match(path.basename(root),/^blackice-folders-http-/);await rm(root,{recursive:true,force:true});});
  const home=await fetch(url),cookie=home.headers.get('set-cookie').split(';')[0];await home.text();
  const request=async(route,body)=>{const res=await fetch(url+route,{method:body?'POST':'GET',headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()};};
  const saved=(await request('/api/knowledge',{kind:'memory',title:'Remember',content:'Keep this intact'})).data;
  const initial=(await request('/api/knowledge/folders')).data;assert.equal(initial.revision,1);
  let state=(await request('/api/knowledge/folders',{action:'create',name:'Personal',expectedRevision:1})).data;
  const folderId=state.folders[0].id;
  state=(await request('/api/knowledge/folders',{action:'move',entryIds:[saved.id],folderId,expectedRevision:state.revision})).data;
  assert.equal((await request('/api/knowledge?folderId='+folderId+'&source=user')).data[0].id,saved.id);
  assert.equal((await request('/api/knowledge?folderId=')).data.length,0);
  assert.equal((await request('/api/knowledge?source=learned')).data.length,0);
  assert.equal((await request('/api/knowledge/folders',{action:'rename',folderId,name:'Stale',expectedRevision:1})).status,409);
  await request('/api/knowledge/folders',{action:'remove',folderId,expectedRevision:state.revision});
  assert.equal((await request('/api/knowledge?folderId=')).data[0].id,saved.id);
  assert.deepEqual((await request('/api/knowledge/'+saved.id)).data,saved);
  assert.equal((await request('/api/knowledge/'+saved.id+'/history')).data.history.length,1);
});
