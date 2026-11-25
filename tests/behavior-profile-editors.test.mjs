import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {planningDOM} from './fixture-planning-dom.mjs';
import {ToolDescriptionOverrides} from '../lib/tool-description-overrides.mjs';
import {ExecutionLayerOverrides} from '../lib/execution-layer-overrides.mjs';
import {createToolDescriptionSettings} from '../public/next/workspaces/settings-tool-descriptions.mjs';
import {createExecutionLayerSettings} from '../public/next/workspaces/settings-execution-layers.mjs';

async function until(check,label='UI state'){
 for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}
 throw Error(label+' did not settle');
}
async function dir(t){const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-behavior-ui-'));t.after(()=>rm(dataDir,{force:true,recursive:true,maxRetries:8,retryDelay:70}));return dataDir;}

test('Behavior & Profile tool editor saves model-facing text, restores defaults, and retains source',async t=>{
 const dataDir=await dir(t),store=await new ToolDescriptionOverrides({dataDir}).init();
 const defs=[
  {name:'relay_browser',description:'Built-in browser controls',inputSchema:{type:'object',properties:{action:{type:'string'}}}},
  {name:'relay_workspace',description:'Built-in workspace tools',inputSchema:{type:'object',properties:{action:{type:'string'}}}}
 ];
 const api=async(route,method='GET',payload)=>{
  assert.equal(route,'/api/tool-descriptions');
  return method==='GET'?store.list(defs):store.save(payload,defs);
 };
 const dom=planningDOM(t),ui=createToolDescriptionSettings({mount:dom.mount,api});
 t.after(()=>ui.destroy());
 ui.enter();
 await until(()=>dom.$('#next-tool-description-select')?.children.length===2,'tool list');
 const selection=dom.$('#next-tool-description-select');
 selection.value='relay_workspace';
 await selection.dispatch('change');
 assert.equal(dom.$('#next-tool-description-content').value,'Built-in workspace tools');
 assert.equal(dom.$('#next-tool-description-default').textContent,'Built-in workspace tools');
 await dom.input('#next-tool-description-content','My shorter workspace description.');
 await dom.$('#next-tool-description-form').dispatch('submit');
 await until(()=>store.revision===1,'saved tool description');
 assert.equal(store.project(defs)[1].description,'My shorter workspace description.');
 assert.equal(store.project(defs)[1].inputSchema,defs[1].inputSchema,'the schema retains identity');
 await dom.click('#next-tool-description-reset');
 await until(()=>store.revision===2,'restored tool description');
 assert.equal(store.project(defs)[1].description,'Built-in workspace tools');
});

test('Behavior & Profile execution editor supports replace, disable, restore, add, and delete without changing defaults',async t=>{
 const dataDir=await dir(t),store=await new ExecutionLayerOverrides({dataDir}).init();
 const defs=[
  {id:'core',title:'Saved instructions',source:'user profile',role:'developer',text:'Original owner instructions'},
  {id:'capabilities',title:'Tool routing',source:'runtime',role:'developer',text:'Generated routing guidance'},
  {id:'browser-signin',title:'Browser verification',source:'runtime',role:'prompt',text:'Native browser guidance'}
 ];
 const api=async(route,method='GET',value)=>{
  assert.equal(route,'/api/execution-layers');
  return method==='GET'?store.list(defs):store.save(value,defs);
 };
 const dom=planningDOM(t),ui=createExecutionLayerSettings({mount:dom.mount,api});
 t.after(()=>ui.destroy());
 ui.enter();
 await until(()=>dom.$('#next-execution-layer-select')?.children.length>=3,'execution layer list');
 const selection=dom.$('#next-execution-layer-select');
 selection.value='capabilities';
 await selection.dispatch('change');
 assert.equal(dom.$('#next-execution-layer-text').value,'Generated routing guidance');
 assert.match(dom.$('#next-execution-layer-source').textContent,/DEVELOPER.*runtime/);
 await dom.input('#next-execution-layer-text','Owner-controlled routing A.');
 await dom.$('#next-execution-layer-text').dispatch('input');
 await dom.$('#next-execution-layer-text').dispatch('change');
 await dom.$('#next-execution-layer-form').dispatch('submit');
 await until(()=>store.revision===1,'replaced layer');
 assert.equal(store.project('capabilities','Generated routing guidance').text,'Owner-controlled routing A.');
 await dom.click('#next-execution-layer-disable');
 await until(()=>store.revision===2,'disabled layer');
 assert.equal(store.project('capabilities','Generated routing guidance').enabled,false);
 await dom.click('#next-execution-layer-restore');
 await until(()=>store.revision===3,'restored layer');
 assert.equal(store.project('capabilities','Generated routing guidance').text,'Generated routing guidance');
 await dom.input('#next-execution-layer-add-title','Review receipts');
 const role=dom.$('#next-execution-layer-add-role');role.value='prompt';await role.dispatch('change');
 await dom.input('#next-execution-layer-add-text','My additional receipt instruction.');
 await dom.$('#next-execution-layer-add-form').dispatch('submit');
 await until(()=>store.revision===4,'added layer');
 const custom=store.additions('prompt')[0];
 assert.ok(custom);
 assert.equal(custom.text,'My additional receipt instruction.');
 await dom.click('#next-execution-layer-disable');
 await until(()=>store.revision===5,'deleted custom layer');
 assert.equal(store.additions('prompt').length,0);
});
