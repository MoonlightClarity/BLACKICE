import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ExecutionLayerOverrides} from '../lib/execution-layer-overrides.mjs';
import {ToolDescriptionOverrides} from '../lib/tool-description-overrides.mjs';

const definitions=[
 {id:'core',title:'Core',source:'saved',role:'developer',text:'Built-in core'},
 {id:'capabilities',title:'Routing',source:'tool-routing',role:'developer',text:'Generated routes'},
 {id:'browser-signin',title:'Browser sign-in',source:'browser',role:'prompt',text:'Default browser steps'},
 {id:'planning',title:'Planning',source:'planning',role:'prompt',text:'Optional planning'}
];
async function fixture(t){
 const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-execution-layer-test-'));
 t.after(()=>rm(dataDir,{recursive:true,force:true}));
 return dataDir;
}

test('model-facing execution layers support revisioned replace, disable, restore, add and delete',async t=>{
 const dataDir=await fixture(t),store=await new ExecutionLayerOverrides({dataDir}).init();
 assert.equal(store.list(definitions).layers.length,definitions.length);
 assert.equal(store.project('capabilities','Computed routes').text,'Computed routes');
 let result=await store.save({action:'replace',id:'capabilities',text:'Short editable routing text',expectedRevision:0},definitions);
 assert.equal(result.revision,1);
 assert.equal(store.project('capabilities','Computed routes').text,'Short editable routing text');
 await assert.rejects(store.save({action:'disable',id:'capabilities',expectedRevision:0},definitions),{status:409});
 result=await store.save({action:'disable',id:'browser-signin',expectedRevision:1},definitions);
 assert.deepEqual(store.project('browser-signin','Default browser steps'),{enabled:false,text:'',mode:'disabled',role:'prompt',order:0});
 result=await store.save({action:'add',title:'My planning note',role:'developer',text:'My custom execution note',expectedRevision:2},definitions);
 const id=result.affected;assert.match(id,/^custom-/);
 assert.equal(store.additions('developer')[0].text,'My custom execution note');
 assert.equal(store.list(definitions).layers.find(row=>row.id===id).custom,true);
 result=await store.save({action:'delete',id,expectedRevision:3},definitions);
 assert.deepEqual(store.additions('developer'),[]);
 result=await store.save({action:'reset',id:'capabilities',expectedRevision:4},definitions);
 assert.equal(store.project('capabilities','Computed routes').text,'Computed routes');
 result=await store.save({action:'reset',id:'browser-signin',expectedRevision:5},definitions);
 assert.equal(store.project('browser-signin','Default browser steps').text,'Default browser steps');
 const fresh=await new ExecutionLayerOverrides({dataDir}).init();
 assert.equal(fresh.revision,6);
 assert.equal(fresh.list(definitions).layers.filter(row=>row.mode!=='default').length,0);
 assert.equal((await readFile(fresh.file,'utf8')).includes('My custom execution note'),false);
});

test('tool description edits alter model-visible descriptions only, preserving names and argument schemas',async t=>{
 const dataDir=await fixture(t),store=await new ToolDescriptionOverrides({dataDir}).init();
 const definitions=[{name:'relay_browser',description:'Original browser',inputSchema:{type:'object',properties:{action:{type:'string',enum:['tabs','click']}}}},
  {name:'relay_workspace',description:'Original workspace',inputSchema:{type:'object',properties:{action:{type:'string'}}}}];
 const original=structuredClone(definitions);
 let result=await store.save({name:'relay_browser',description:'User-visible replacement',expectedRevision:0},definitions);
 assert.equal(result.revision,1);
 assert.equal(store.project(definitions)[0].description,'User-visible replacement');
 assert.deepEqual(store.project(definitions)[0].inputSchema,original[0].inputSchema);
 assert.deepEqual(definitions,original,'global built-in descriptions remain untouched');
 await assert.rejects(store.save({name:'relay_browser',description:'stale',expectedRevision:0},definitions),{status:409});
 await assert.rejects(store.save({name:'fake_tool',description:'not in catalog',expectedRevision:1},definitions),{status:404});
 await assert.rejects(store.save({name:'relay_browser',description:'',expectedRevision:1},definitions),{status:400});
 result=await store.save({name:'relay_browser',description:null,expectedRevision:1},definitions);
 assert.equal(result.revision,2);
 assert.equal(store.project(definitions)[0].description,'Original browser');
 assert.equal((await new ToolDescriptionOverrides({dataDir}).init()).revision,2);
});
