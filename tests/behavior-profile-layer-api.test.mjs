import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
class QuietRuntime extends EventEmitter{
 status(){return{connected:true,authenticated:true,defaultModel:'fixture',models:[]};}
 async start(){return this.status();}
 async close(){}
 async runAgent(){throw Error('No provider execution expected');}
}
test('local Behavior & Profile endpoints edit, add, disable, restore and delete model guidance with revisions',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-editor-routes-')),cwd=path.join(root,'workspace');
 await mkdir(cwd);
 const app=await createHarnessServer({runtime:new QuietRuntime(),port:0,dataDir:path.join(root,'data'),defaultCwd:cwd});
 const url=await app.listen();
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 const session=await fetch(url),cookie=session.headers.get('set-cookie')?.split(';')[0];
 assert.ok(cookie);
 const headers={Cookie:cookie,Origin:new URL(url).origin,'Content-Type':'application/json'};
 const read=async resource=>{
  const response=await fetch(new URL(resource,url),{headers:{Cookie:cookie}});
  const payload=await response.json();
  assert.equal(response.status,200,resource+' '+JSON.stringify(payload).slice(0,400));
  return payload;
 };
 const put=async(resource,payload,extraHeaders={})=>{
  const response=await fetch(new URL(resource,url),{method:'PUT',headers:{...headers,...extraHeaders},body:JSON.stringify(payload)});
  return {status:response.status,data:await response.json()};
 };
 const first=await read('/api/execution-layers');
 assert.ok(first.layers.some(layer=>layer.id==='core'&&layer.role==='developer'));
 assert.ok(first.layers.some(layer=>layer.id==='capabilities'&&layer.role==='developer'));
 assert.ok(first.layers.some(layer=>layer.id==='browser-signin'&&layer.role==='prompt'));
 let response=await put('/api/execution-layers',{action:'replace',id:'capabilities',text:'ROUTE_API_CHANGED',expectedRevision:first.revision});
 assert.equal(response.status,200);
 assert.equal(response.data.layers.find(layer=>layer.id==='capabilities').text,'ROUTE_API_CHANGED');
 assert.equal((await put('/api/execution-layers',{action:'disable',id:'capabilities',expectedRevision:first.revision})).status,409);
 response=await put('/api/execution-layers',{action:'add',title:'Operator guidance',role:'prompt',text:'Operator prompt',expectedRevision:response.data.revision});
 assert.equal(response.status,200);
 const custom=response.data.affected;assert.match(custom,/^custom-/);
 assert.equal((await read('/api/execution-layers')).layers.find(layer=>layer.id===custom).text,'Operator prompt');
 response=await put('/api/execution-layers',{action:'delete',id:custom,expectedRevision:response.data.revision});
 assert.equal(response.status,200);
 assert.equal(response.data.layers.some(layer=>layer.id===custom),false);
 response=await put('/api/execution-layers',{action:'reset',id:'capabilities',expectedRevision:response.data.revision});
 assert.equal(response.status,200);
 assert.equal(response.data.layers.find(layer=>layer.id==='capabilities').mode,'default');
 assert.equal((await put('/api/execution-layers',{action:'add',title:'Remote',role:'prompt',text:'Attempt',expectedRevision:response.data.revision},{'x-blackice-remote':'1'})).status,403);
 const tools=await read('/api/tool-descriptions'),item=tools.tools.find(row=>row.name==='relay_workspace');
 assert.ok(item);
 response=await put('/api/tool-descriptions',{name:'relay_workspace',description:'Edited only for model',expectedRevision:tools.revision});
 assert.equal(response.status,200);
 assert.equal(response.data.tools.find(row=>row.name==='relay_workspace').description,'Edited only for model');
 response=await put('/api/tool-descriptions',{name:'relay_workspace',description:null,expectedRevision:response.data.revision});
 assert.equal(response.status,200);
 assert.equal(response.data.tools.find(row=>row.name==='relay_workspace').description,item.defaultDescription);
});
