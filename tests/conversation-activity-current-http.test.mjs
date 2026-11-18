import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createHarnessServer} from '../server.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createActivityInspector} from '../public/next/chat/activity-inspector.mjs';
test('authenticated conversation activity reads retained events without Directory data',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'conversation-activity-'));
 class Runtime extends EventEmitter{status(){return {connected:true,authenticated:true};}async start(){}async close(){}async runAgent(){throw Error("No provider should run");}}
 const app=await createHarnessServer({runtime:new Runtime(),port:0,dataDir:dir,defaultCwd:dir,remoteAccess:null});
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const file=path.join(dir,'directory-record.json');await writeFile(file,'unreadable preserved evidence');
 const calls=[];app.conversations.get=async id=>{calls.push(id);if(id!=='selected')throw Object.assign(Error('Not found'),{status:404});return {id,events:[{data:{type:'message',phase:'commentary',text:'Selected update'}},{data:{type:'tool.result',tool:'relay_workspace',success:true,result:'PRIVATE RAW'}},{data:{type:'item',item:{type:'reasoning',text:'PRIVATE REASONING'}}}]};};
 const base=await app.listen({waitForRemote:false});const home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0];await home.arrayBuffer();
 const get=(url,auth=true)=>fetch(base+url,{headers:auth?{Cookie:cookie}:{}});
 assert.equal((await get('/api/conversations/selected/activity',false)).status,401);assert.equal(calls.length,0);
 const updates=await get('/api/conversations/selected/activity');assert.equal(updates.status,200);assert.equal((await updates.json()).items[0].text,'Selected update');
 const tools=await get('/api/conversations/selected/activity?view=tools');const body=await tools.json();assert.equal(body.items.length,1);assert.doesNotMatch(JSON.stringify(body),/PRIVATE/);
 const bad=await get('/api/conversations/selected/activity?file=foreign');assert.equal(bad.status,400);
 const duplicate=await get('/api/conversations/selected/activity?q=a&q=b');assert.equal(duplicate.status,400);
 assert.equal((await get('/api/conversations/missing/activity')).status,404);
 assert.equal((await get('/api/shadowdancer/context?runId=selected')).status,404);
 const dom=planningDOM(t),requests=[];const inspector=createActivityInspector({frame:dom.mount,getRunId:()=>'selected',api:async route=>{requests.push(route);const r=await get(route),body=await r.json();if(!r.ok)throw Error(body.error);return body;}});t.after(()=>inspector.destroy());
 await inspector.open();assert.match(dom.mount.textContent,/Selected update/);assert.ok(requests[0].startsWith('/api/conversations/selected/activity?'));assert.doesNotMatch(requests[0],/runId=/);assert.doesNotMatch(dom.mount.textContent,/PRIVATE|Directory Context/);
 assert.equal(await readFile(file,'utf8'),'unreadable preserved evidence');
});

