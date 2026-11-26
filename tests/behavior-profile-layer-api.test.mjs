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
 const index=await fetch(url,{headers:{Cookie:cookie}});
 const shell=await index.text();
 assert.match(shell,/data-space="runtime"/);
 assert.doesNotMatch(shell,/data-space="planning"/,'the top-level old Planning tab remains retired');
 for(const file of ['/next/workspaces/runtime.mjs','/next/runtime.css']){
  const res=await fetch(new URL(file,url),{headers:{Cookie:cookie}});
  assert.equal(res.status,200,'Runtime asset must be served: '+file);
  assert.ok((await res.text()).length>100);
 }
 for(const old of ['/next/workspaces/settings-tool-descriptions.mjs',
  '/next/workspaces/settings-execution-layers.mjs','/api/instructions/developer-layer']){
  const res=await fetch(new URL(old,url),{headers:{Cookie:cookie}});
  assert.equal(res.status,404,'the obsolete Runtime editor/override must be inaccessible: '+old);
 }

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
 app.engine.runs.set('runtime-observed-fixture',{nodes:{agent:{instructionAudit:{version:1,
  sections:[{id:'runtime-discovered-fixture',title:'Observed runtime instruction',source:'lib/fixture.mjs',
   layer:'prompt',role:'user',text:'OBSERVED_BEHAVIOR_871'}]}}}});
 const discovered=await read('/api/execution-layers');
 assert.equal(discovered.layers.find(layer=>layer.id==='runtime-discovered-fixture')?.text,'OBSERVED_BEHAVIOR_871',
  'recent observed model instructions become editable without a manually supplied run ID');
 app.engine.runs.delete('runtime-observed-fixture');

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
 response=await put('/api/execution-layers',{action:'update',id:'capabilities',
  fields:{title:'Edited routing title',description:'Owner routing notes',sourceLabel:'Owner layer source',
   role:'prompt',enabled:true,order:42,text:'EDITED_ROUTING_TEXT'},
  expectedRevision:response.data.revision});
 assert.equal(response.status,200);
 const edited=response.data.layers.find(layer=>layer.id==='capabilities');
 assert.equal(edited.title,'Edited routing title');
 assert.equal(edited.description,'Owner routing notes');
 assert.equal(edited.source,'Owner layer source');
 assert.equal(edited.role,'prompt');
 assert.equal(edited.order,42);
 assert.equal(edited.text,'EDITED_ROUTING_TEXT');

 assert.equal((await put('/api/execution-layers',{action:'add',title:'Remote',role:'prompt',text:'Attempt',expectedRevision:response.data.revision},{'x-blackice-remote':'1'})).status,403);
 const tools=await read('/api/tool-descriptions'),item=tools.tools.find(row=>row.name==='relay_workspace');
 assert.ok(item);
 response=await put('/api/tool-descriptions',{name:'relay_workspace',description:'Edited only for model',expectedRevision:tools.revision});
 assert.equal(response.status,200);
 assert.equal(response.data.tools.find(row=>row.name==='relay_workspace').description,'Edited only for model');
 response=await put('/api/tool-descriptions',{name:'relay_workspace',description:null,expectedRevision:response.data.revision});
 assert.equal(response.status,200);
 assert.equal(response.data.tools.find(row=>row.name==='relay_workspace').description,item.defaultDescription);
 const schema=structuredClone(item.defaultSchema);
 assert.ok(schema?.properties?.action,'Workspace tool must publish a model schema');
 schema.properties.action.description='OWNER_EDITED_ACTION_FIELD_HTTP';
 response=await put('/api/tool-descriptions',{name:'relay_workspace',
  description:'Owner-visible workspace instructions',inputSchema:schema,enabled:false,
  expectedRevision:response.data.revision});
 assert.equal(response.status,200);
 const revised=response.data.tools.find(row=>row.name==='relay_workspace');
 assert.equal(revised.enabled,false);
 assert.equal(revised.description,'Owner-visible workspace instructions');
 assert.equal(revised.inputSchema.properties.action.description,'OWNER_EDITED_ACTION_FIELD_HTTP');
 response=await put('/api/tool-descriptions',{name:'relay_workspace',description:null,expectedRevision:response.data.revision});
 assert.equal(response.status,200);
 assert.equal(response.data.tools.find(row=>row.name==='relay_workspace').enabled,true);
 assert.deepEqual(response.data.tools.find(row=>row.name==='relay_workspace').inputSchema,item.defaultSchema);

});
