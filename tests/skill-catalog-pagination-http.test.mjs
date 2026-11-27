import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
class NoModelRuntime extends EventEmitter{
 status(){return {connected:true,authenticated:true,models:[]};}
 async start(){return this.status();}async close(){}
 async runAgent(){throw Error('Catalog pagination must not start a model.');}
}
test('native skills HTTP honors bounded pages and exposes every deep owner record',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'skill-page-http-'));let app;
 t.after(async()=>{await app?.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
 const entries=Object.fromEntries(Array.from({length:1205},(_,i)=>['user-scale-'+String(i).padStart(5,'0'),{content:'# Scale method '+i+'\n\nA distinct scalable method.',revision:2}]));
 await mkdir(path.join(root,'skill-edits'),{recursive:true});await writeFile(path.join(root,'skill-edits','skills.json'),JSON.stringify({version:1,entries}));
 app=await createHarnessServer({runtime:new NoModelRuntime(),dataDir:root,defaultCwd:root,port:0,remoteAccess:false});
 const base=await app.listen(),cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];
 const get=route=>fetch(new URL(route,base),{headers:{Cookie:cookie}});
 const first=await (await get('/api/skills?source=user')).json();assert.equal(first.entries.length,200);assert.equal(first.totalMatches,1205);assert.equal(first.nextOffset,200);
 const page=await (await get('/api/skills?source=user&offset=1000&limit=5')).json();
 assert.equal(page.entries.length,5);assert.equal(page.nextOffset,1005);assert.equal(page.totalMatches,1205);assert.equal(page.catalogVersion,first.catalogVersion);
 assert.ok(page.entries.every(row=>!first.entries.some(x=>x.id===row.id)));
 const body=await (await get('/api/skills/'+encodeURIComponent(page.entries[4].id))).json();assert.equal(body.content,entries[body.id].content);
 const end=await (await get('/api/skills?source=user&offset=1200&limit=200')).json();assert.equal(end.entries.length,5);assert.equal(end.nextOffset,null);
 for(const query of ['offset=-1','offset=1.5','offset=','offset=9007199254740992','limit=0','limit=501','limit=1.5','limit=abc'])assert.equal((await get('/api/skills?'+query)).status,400,query);
 const empty=await (await get('/api/skills?offset=20000&limit=10')).json();assert.deepEqual(empty.entries,[]);assert.equal(empty.nextOffset,null);
});
