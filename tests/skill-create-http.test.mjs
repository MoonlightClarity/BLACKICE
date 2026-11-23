import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';
import { createRetrievalToolHandler, RETRIEVAL_TOOLS } from '../lib/retrieval-tools.mjs';

class Runtime extends EventEmitter {
 status(){return {connected:true,authenticated:true,models:[]};}
 async start(){return this.status();}
 async close(){}
 async runAgent(){throw Error('Human skill creation must not start a model.');}
}

test('new human skill is authenticated, searchable, readable, editable and persists without enabling model writes',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'skill-create-http-'));let app,base,cookie;
 t.after(async()=>{await app?.close();await rm(root,{recursive:true,force:true});});
 const open=async()=>{
  app=await createHarnessServer({runtime:new Runtime(),dataDir:root,defaultCwd:root,port:0,remoteAccess:false});
  base=await app.listen();cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];
 };
 await open();
 const request=(method,payload,route='/api/skills',headers={Cookie:cookie})=>fetch(new URL(route,base),{method,headers:{...headers,'Content-Type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{})});
 const content='---\r\nname: zymurgy\r\n---\r\n# Zymurgy Guide ##\r\nUnique test procedure.\r\n';
 assert.equal((await request('POST',{content},'/api/skills',{})).status,401);
 assert.equal((await request('POST',{content},'/api/skills',{Cookie:cookie,'x-blackice-remote':'1'})).status,403);
 for(const bad of [{},{content:' '},{content:'## No top-level title'},{content:'#\nNot a title'},{content:'```md\n# Code only\n```'},{content:'# ###'},{content,id:'builtin-decomposition'},{content,expectedRevision:1}]){
  assert.equal((await request('POST',bad)).status,400,JSON.stringify(bad));
 }
 const empty=await (await request('GET',null,'/api/skills?source=user')).json();
 assert.deepEqual(empty.entries,[]);
 const response=await request('POST',{content});
 assert.equal(response.status,201);
 const created=await response.json();
 assert.match(created.id,/^user-[0-9a-f-]{36}$/);
 assert.equal(created.title,'Zymurgy Guide');
 assert.equal(created.source,'user');
 assert.equal(created.userEditable,true);
 assert.equal(created.content,content);
 assert.equal(created.revision,2);
 await app.close();await open();
 const route='/api/skills/'+created.id;
 assert.deepEqual(await (await request('GET',null,route)).json(),created);
 const catalog=await (await request('GET',null,'/api/skills?source=user&query=Zymurgy')).json();
 assert.deepEqual(catalog.entries.map(row=>row.id),[created.id]);
 const relay=RETRIEVAL_TOOLS.find(row=>row.name==='relay_skills');
 assert.deepEqual(relay.inputSchema.properties.action.enum,['search','read','save']);
 const modelTool=createRetrievalToolHandler({cwd:root,dataDir:root});
 const read=await modelTool({name:'relay_skills',arguments:{action:'read',id:created.id}});
 assert.match(JSON.stringify(read),/Unique test procedure/);
 await assert.rejects(modelTool({name:'relay_skills',arguments:{action:'create'}}),/Unknown knowledge action/);
 const edited=await request('POST',{expectedRevision:created.revision,content:'# Zymurgy, revised.'},route);
 assert.equal(edited.status,200);
 assert.equal((await edited.json()).title,'Zymurgy, revised.');
});
