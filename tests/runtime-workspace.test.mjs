import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {planningDOM} from './fixture-planning-dom.mjs';
import {InstructionStore} from '../lib/instruction-store.mjs';
import {ExecutionLayerOverrides} from '../lib/execution-layer-overrides.mjs';
import {ToolDescriptionOverrides} from '../lib/tool-description-overrides.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {SkillFolderStore} from '../lib/skill-folders.mjs';
import {createRuntimeWorkspace} from '../public/next/workspaces/runtime.mjs';
import {createSkillsWorkspace} from '../public/next/workspaces/skills.mjs';

const wait=async(check,label='UI state')=>{
 for(let i=0;i<130;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,10));}
 throw Error(label+' did not settle');
};
async function env(t){
 const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-runtime-editor-test-'));
 t.after(()=>rm(dataDir,{recursive:true,force:true,maxRetries:12,retryDelay:100}));
 return dataDir;
}
test('Runtime top-level editor updates canonical system text, tool schemas and current Job Search skill',async t=>{
 const dataDir=await env(t);
 const ownerCore=await new InstructionStore({dataDir,defaultContent:'SYSTEM_ORIGINAL_716'}).init();
 const layers=await new ExecutionLayerOverrides({dataDir}).init();
 const tools=await new ToolDescriptionOverrides({dataDir}).init();
 const catalog=createSkillsCatalog({dataDir});
 t.after(async()=>{await ownerCore.close();await catalog.close();});
 const definitions=async()=>[
  {id:'core',title:'System instructions',source:'saved instruction store',role:'developer',text:(await ownerCore.read()).content},
  {id:'capabilities',title:'Tool routing',source:'tool-routing.mjs',role:'developer',text:'CANONICAL_ROUTING_819'},
  {id:'planning',title:'Planning',source:'planning',role:'developer',text:''},
  {id:'browser-signin',title:'Visual browser',source:'browser',role:'prompt',text:'VISIBLE_BROWSER_TEXT'}
 ];
 const toolDefinitions=[
  {name:'relay_browser',description:'Default contained browser',inputSchema:{type:'object',properties:{action:{type:'string',description:'Known action'}},required:['action']}},
  {name:'relay_workspace',description:'Default workspace',inputSchema:{type:'object',properties:{action:{type:'string'}}}}
 ];
 const calls=[];
 const api=async(route,method='GET',body)=>{
  calls.push({route,method,body});
  if(route==='/api/execution-layers')return method==='GET'?layers.list(await definitions()):layers.save(body,await definitions());
  if(route==='/api/tool-descriptions')return method==='GET'?tools.list(toolDefinitions):tools.save(body,toolDefinitions);
  if(route==='/api/instructions/core')return method==='GET'?ownerCore.read():ownerCore.update(body);
  if(route==='/api/instructions/core/versions/0')return ownerCore.readVersion(0);
  if(route==='/api/skills'&&method==='GET')return catalog.list();
  if(route==='/api/skills?source=deleted')return catalog.list({source:'deleted'});
  if(route==='/api/skills'&&method==='POST')return catalog.create({value:body});
  const id=decodeURIComponent(route.split('/').at(-1));
  if(route.endsWith('/restore'))return catalog.restore({id:decodeURIComponent(route.split('/').at(-2)),value:body});
  if(route.startsWith('/api/skills/')){
   if(method==='GET')return catalog.detail({id});
   if(method==='POST')return catalog.save({id,value:body});
   if(method==='DELETE')return catalog.delete({id,value:body});
  }
  throw Error('Unsupported route '+method+' '+route);
 };
 const f=planningDOM(t),ui=createRuntimeWorkspace({mount:f.mount,api});
 t.after(()=>ui.destroy());ui.enter();
 await wait(()=>f.$('[data-runtime-item="layer:core"]'),'Runtime navigation');
 assert.ok(f.$('[data-runtime-item="tool:relay_browser"]'),'tool listed');
 assert.ok(f.$('[data-runtime-item="skill:library-job-search"]'),'Job Search listed');
 assert.equal(f.mount.querySelector('#next-developer-layer-text'),null,'no global developer override');
 await wait(()=>f.$('#runtime-text').value==='SYSTEM_ORIGINAL_716','system text loaded').catch(error=>{console.log('RUNTIME_DEBUG',f.$('#runtime-status')?.textContent,f.$('#runtime-save-status')?.textContent,f.$('#runtime-heading')?.textContent,'calls='+calls.map(x=>x.method+' '+x.route).join(';'));throw error;});
 assert.equal(f.$('#runtime-text').value,'SYSTEM_ORIGINAL_716');
 await f.input('#runtime-text','SYSTEM_CURRENT_719');
 await f.$('#runtime-editor').dispatch('submit');
 await wait(async()=> (await ownerCore.read()).content==='SYSTEM_CURRENT_719','canonical system save');
 assert.equal(layers.project('core','SYSTEM_CURRENT_719').text,'SYSTEM_CURRENT_719','no competing core shadow value');
 assert.equal(layers.revision,0,'editing only canonical core text must not write or pin layer metadata');
 assert.equal(layers.list(await definitions()).layers.find(item=>item.id==='core').overridden,false);
 await wait(()=>!f.$('#runtime-restore').disabled,'core reset available');
 await f.click('#runtime-restore');
 await wait(async()=> (await ownerCore.read()).content==='SYSTEM_ORIGINAL_716','canonical system default restored');
 await wait(()=>f.$('#runtime-status').textContent==='Restored for future turns.','core restore UI settled');
 assert.equal(layers.revision,0,'restoring canonical core text alone does not alter the layer catalog');
 await wait(()=>layers.project('core','SYSTEM_ORIGINAL_716').mode==='default','core reset completed');
 await layers.save({action:'replace',id:'core',text:'OLDER_CORE_SHADOW_716',
   expectedRevision:layers.revision},await definitions());
 await f.click('#runtime-refresh');
 await wait(()=>f.$('#runtime-text').value==='OLDER_CORE_SHADOW_716',
   'effective core override is shown instead of a hidden canonical value');
 await f.input('#runtime-text','SYSTEM_CURRENT_OVER_SHADOW_716');
 await f.$('#runtime-editor').dispatch('submit');
 await wait(async()=> (await ownerCore.read()).content==='SYSTEM_CURRENT_OVER_SHADOW_716',
   'owner core updates while shadow exists');
 await wait(()=>layers.project('core','SYSTEM_CURRENT_OVER_SHADOW_716').text===
   'SYSTEM_CURRENT_OVER_SHADOW_716',
   'effective model-facing core text cannot remain a hidden stale override');
 await wait(()=>!f.$('#runtime-restore').disabled,'core shadow reset available');
 await f.click('#runtime-restore');
 await wait(()=>layers.project('core','SYSTEM_ORIGINAL_716').mode==='default',
   'shadow override is removed by restore');
 await wait(()=>f.$('#runtime-text').value==='SYSTEM_ORIGINAL_716','core restored UI settled');
 await f.input('#runtime-text','EDIT_THEN_REVERT_716');
 await f.input('#runtime-text','SYSTEM_ORIGINAL_716');
 const currentCore=await ownerCore.read();
 await ownerCore.update({content:'EXTERNALLY_UPDATED_CORE_716',
   expectedRevision:currentCore.revision,expectedHash:currentCore.hash});
 await f.click('#runtime-refresh');
 await wait(()=>f.$('#runtime-text').value==='EXTERNALLY_UPDATED_CORE_716',
   'reverted draft must not hide an external core revision');
 await f.click('#runtime-restore');
 await wait(async()=> (await ownerCore.read()).content==='SYSTEM_ORIGINAL_716',
   'owner restore after external update');
 await f.click('[data-runtime-item="layer:capabilities"]');
 await wait(()=>f.$('#runtime-text').value==='CANONICAL_ROUTING_819');
 await f.input('#runtime-title','Owned tool routing');
 await f.input('#runtime-description','Specific routing instructions');
 await f.input('#runtime-text','ROUTING_CURRENT_725');
 await f.$('#runtime-editor').dispatch('submit');
 await wait(()=>layers.project('capabilities','CANONICAL_ROUTING_819').text==='ROUTING_CURRENT_725','routing save');
 assert.equal(layers.list(await definitions()).layers.find(layer=>layer.id==='capabilities').title,'Owned tool routing');
 await f.click('[data-runtime-item="tool:relay_browser"]');
 await wait(()=>f.$('#runtime-text').value==='Default contained browser','tool editor');
 await f.input('#runtime-text','OWNED_BROWSER_DESCRIPTION_725');
 const schema=JSON.parse(f.$('#runtime-schema').value);
 schema.properties.action.description='OWNED_ACTION_SCHEMA_726';
 await f.input('#runtime-schema',JSON.stringify(schema));
 await f.$('#runtime-editor').dispatch('submit');
 await wait(()=>tools.project(toolDefinitions)[0].description==='OWNED_BROWSER_DESCRIPTION_725','model-visible tool edit');
 assert.equal(tools.project(toolDefinitions)[0].inputSchema.properties.action.description,'OWNED_ACTION_SCHEMA_726');
 await f.click('[data-runtime-item="skill:library-job-search"]');
 await wait(()=>f.$('#runtime-text').value.includes('# Job Search'),'skill detail');
 await f.input('#runtime-text','# Job Search\n\nOWNER_JOB_SEARCH_CURRENT_731');
 await f.$('#runtime-editor').dispatch('submit');
 await wait(async()=> (await catalog.detail({id:'library-job-search'})).content.includes('OWNER_JOB_SEARCH_CURRENT_731'),'current skill revision');
 assert.ok(calls.some(row=>row.route==='/api/skills/library-job-search'&&row.method==='POST'),'shared effective skill source saved');
});
test('Skills folder manager explicitly deletes/restores virtual category groups without deleting any skills',async t=>{
 const dataDir=await env(t),folderStore=new SkillFolderStore({dataDir}),catalog=createSkillsCatalog({dataDir});
 t.after(async()=>{await folderStore.close();await catalog.close();});
 const api=async(route,method='GET',body)=>{
  if(route==='/api/skills/folders')return method==='GET'?folderStore.read():folderStore.mutate(body);
  const url=new URL(route,'http://fixture');
  if(url.pathname==='/api/skills')return catalog.list({query:url.searchParams.get('query')||'',source:url.searchParams.get('source')||'all'});
  if(url.pathname.startsWith('/api/skills/'))return catalog.detail({id:decodeURIComponent(url.pathname.slice(12))});
  throw Error(route);
 };
 const f=planningDOM(t),ui=createSkillsWorkspace({mount:f.mount,api});
 t.after(()=>ui.destroy());ui.enter();
 await wait(()=>f.$('#skills-manage-folders-button'),'manage folders');
 await f.click('#skills-manage-folders-button');
 assert.equal(f.$('#skills-folder-manager').open,true);
 await wait(()=>[...f.$('#skills-folder-manager-list').querySelectorAll('button')].some(node=>node.dataset.manageCategoryDelete==='Research & web'),'category manager populated').catch(error=>{console.log('SKILLS_DEBUG',f.$('#skills-status')?.textContent,'manager='+f.$('#skills-folder-manager-list')?.textContent?.slice(0,500));throw error;});
 const button=[...f.$('#skills-folder-manager-list').querySelectorAll('button')].find(node=>node.dataset.manageCategoryDelete==='Research & web');
 assert.ok(button,'virtual categories have delete controls');
 await f.click(button);
 assert.equal(f.$('#skills-folder-delete-confirm').hidden,false);
 assert.match(f.$('#skills-folder-delete-confirm').textContent,/No skill documents will be deleted/);
 await f.click('#skills-folder-delete-yes');
 await wait(async()=> (await folderStore.read()).removedCategories.includes('category:Research & web'),'category deleted');
 const job=await catalog.detail({id:'library-job-search'});
 assert.ok(job.content,'catalog content is unchanged');
 const restore=[...f.$('#skills-removed-category-list').querySelectorAll('button')].find(node=>node.dataset.restoreCategory==='Research & web');
 assert.ok(restore,'deleted category remains restorable');
 await f.click(restore);
 await wait(async()=> !(await folderStore.read()).removedCategories.includes('category:Research & web'),'category restored');
});

test('Runtime supports adding, editing, disabling, deleting and restoring catalog items through the UI',async t=>{
 const dataDir=await env(t),layers=await new ExecutionLayerOverrides({dataDir}).init(),
  tools=await new ToolDescriptionOverrides({dataDir}).init(),catalog=createSkillsCatalog({dataDir}),
  ownerCore=await new InstructionStore({dataDir,defaultContent:'TEST_RUNTIME_CORE'}).init();
 t.after(async()=>{await ownerCore.close();await catalog.close();});
 const definitions=async()=>[
  {id:'core',title:'System instructions',source:'core',role:'developer',text:(await ownerCore.read()).content},
  {id:'capabilities',title:'Tool routing',source:'tool-routing',role:'developer',text:'CURRENT_TOOL_ROUTING'},
  {id:'browser-signin',title:'Browser',source:'browser',role:'prompt',text:'BROWSER_GUIDANCE'}
 ];
 const toolDefs=[{name:'relay_workspace',description:'Workspace tool',inputSchema:
  {type:'object',properties:{action:{type:'string'}}}}];
 const api=async(route,method='GET',body)=>{
  if(route==='/api/execution-layers')return method==='GET'?layers.list(await definitions()):layers.save(body,await definitions());
  if(route==='/api/tool-descriptions')return method==='GET'?tools.list(toolDefs):tools.save(body,toolDefs);
  if(route==='/api/instructions/core')return method==='GET'?ownerCore.read():ownerCore.update(body);
  if(route==='/api/instructions/core/versions/0')return ownerCore.readVersion(0);
  if(route==='/api/skills')return method==='POST'?catalog.create({value:body}):catalog.list();
  if(route==='/api/skills?source=deleted')return catalog.list({source:'deleted'});
  if(route.startsWith('/api/skills/')){
   const parts=route.split('/'),id=decodeURIComponent(parts[3]);
   if(parts[4]==='restore')return catalog.restore({id,value:body});
   if(method==='GET')return catalog.detail({id});
   if(method==='POST')return catalog.save({id,value:body});
   if(method==='DELETE')return catalog.delete({id,value:body});
  }
  throw Error(route);
 };
 const dom=planningDOM(t),ui=createRuntimeWorkspace({mount:dom.mount,api});
 t.after(()=>ui.destroy());ui.enter();
 await wait(()=>dom.$('[data-runtime-item="layer:capabilities"]'),'runtime loaded');
 await layers.save({action:'replace',id:'browser-signin',text:'SAVED_DISABLED_BROWSER_TEXT_911',
   expectedRevision:layers.revision},await definitions());
 await layers.save({action:'disable',id:'browser-signin',expectedRevision:layers.revision},await definitions());
 assert.equal(layers.project('browser-signin','BROWSER_GUIDANCE','prompt').text,'',
   'disabled built-in must not deliver text to the model');
 await dom.click('#runtime-refresh');
 await dom.click('[data-runtime-item="layer:browser-signin"]');
 await wait(()=>dom.$('#runtime-text').value==='SAVED_DISABLED_BROWSER_TEXT_911',
   'disabled instruction retains its saved text in the editor');
 assert.equal(dom.$('#runtime-enabled').checked,false);
 dom.$('#runtime-enabled').checked=true;await dom.$('#runtime-enabled').dispatch('change');
 await dom.$('#runtime-editor').dispatch('submit');
 await wait(()=>layers.project('browser-signin','BROWSER_GUIDANCE','prompt').enabled,
   'disabled built-in re-enabled without losing text');
 assert.equal(layers.project('browser-signin','BROWSER_GUIDANCE','prompt').text,'SAVED_DISABLED_BROWSER_TEXT_911');
 await wait(()=>dom.$('#runtime-status').textContent.includes('runtime sources loaded'),'after enabling editor settled');
 await dom.click('#runtime-refresh');
 await dom.click('[data-runtime-item="layer:browser-signin"]');
 await wait(()=>!dom.$('#runtime-restore').disabled,'edited built-in layer offers Restore');
 await dom.click('#runtime-restore');
 await wait(()=>layers.project('browser-signin','BROWSER_GUIDANCE','prompt').mode==='default',
   'built-in layer restored to its executable default');
 await dom.click('#runtime-add');
 assert.equal(dom.$('#runtime-new-form').hidden,false);
 await dom.input('#runtime-new-title','Audit handoffs');
 await dom.input('#runtime-new-description','Owner-defined handoff instructions');
 await dom.input('#runtime-new-source-label','Owner runtime source');
 await dom.input('#runtime-new-text','CUSTOM_HANDOFF_GUIDANCE_6271');
 dom.$('#runtime-new-order').value='19';
 await dom.$('#runtime-new-form').dispatch('submit');
 await wait(()=>layers.additions('developer').some(row=>row.text==='CUSTOM_HANDOFF_GUIDANCE_6271'),'created owner layer');
 const custom=layers.additions('developer').find(row=>row.text==='CUSTOM_HANDOFF_GUIDANCE_6271');
 assert.equal(custom.description,'Owner-defined handoff instructions');
 assert.equal(custom.source,'Owner runtime source');
 assert.equal(custom.order,19);
 await wait(()=>dom.$('[data-runtime-item="layer:'+custom.id+'"]'),'created layer listed');
 await dom.click('[data-runtime-item="layer:'+custom.id+'"]');
 await wait(()=>dom.$('#runtime-text').value==='CUSTOM_HANDOFF_GUIDANCE_6271');
 dom.$('#runtime-role').value='prompt';await dom.$('#runtime-role').dispatch('change');
 await dom.$('#runtime-editor').dispatch('submit');
 await wait(()=>layers.additions('prompt').some(row=>row.id===custom.id),'role edited');
 await wait(()=>!dom.$('#runtime-delete').disabled,'role save UI settled');
 await layers.save({action:'disable',id:custom.id,expectedRevision:layers.revision},await definitions());
 await dom.click('#runtime-refresh');
 await wait(()=>!dom.$('#runtime-restore').disabled,'disabled custom layer offers restore');
 await dom.click('#runtime-restore');
 await wait(()=>layers.additions('prompt').some(row=>row.id===custom.id),'disabled custom layer restored');
 await wait(()=>!dom.$('#runtime-delete').disabled,'restored custom layer UI settled');
 await dom.click('#runtime-delete');
 assert.equal(dom.$('#runtime-delete-confirm').hidden,false);
 await dom.click('#runtime-delete-yes');
 await wait(async()=>!layers.list(await definitions()).layers.some(row=>row.id===custom.id),'custom deleted');
 await dom.click('[data-runtime-item="tool:relay_workspace"]');
 await wait(()=>dom.$('#runtime-text').value==='Workspace tool');
 await dom.click('#runtime-delete');
 await dom.click('#runtime-delete-yes');
 await wait(()=>tools.project(toolDefs).length===0,'tool disabled');
 await wait(()=>dom.$('#runtime-status').textContent.includes('Runtime item changed'),'tool disable UI settled');
 await dom.click('[data-runtime-item="tool:relay_workspace"]');
 await wait(()=>!dom.$('#runtime-restore').disabled,'restore tool available');
 await dom.click('#runtime-restore');
 await wait(()=>tools.project(toolDefs).length===1,'tool restored');
 await dom.click('[data-runtime-item="skill:library-job-search"]');
 await wait(()=>dom.$('#runtime-text').value.startsWith('#'),'job skill loaded');
 await dom.click('#runtime-delete');
 await dom.click('#runtime-delete-yes');
 await wait(()=>dom.$('[data-runtime-item="deleted:library-job-search"]'),'deleted skill listed');
 await dom.click('[data-runtime-item="deleted:library-job-search"]');
 await wait(()=>!dom.$('#runtime-restore').disabled,'restore skill available');
 await dom.click('#runtime-restore');
 await wait(()=>dom.$('[data-runtime-item="skill:library-job-search"]'),'skill restored');
 assert.match((await catalog.detail({id:'library-job-search'})).content,/# Job Search/);
});
test('selection queued during an asynchronous skill read opens the latest requested Runtime item',async t=>{
 let finishSkillRead;
 const core={content:'CORE_RUNTIME_101',revision:0,hash:'core-hash'};
 const layers={version:1,revision:0,layers:[
  {id:'core',title:'System instructions',role:'developer',source:'test',mode:'default',
   enabled:true,defaultText:core.content,text:core.content,order:0},
  {id:'capabilities',title:'Tool routing',role:'developer',source:'test',mode:'default',
   enabled:true,defaultText:'ROUTING_CURRENT_101',text:'ROUTING_CURRENT_101',order:1}
 ]};
 const api=async route=>{
  if(route==='/api/execution-layers')return layers;
  if(route==='/api/tool-descriptions')return{version:1,revision:0,tools:[]};
  if(route==='/api/skills')return{entries:[{id:'custom-queued-skill',title:'Queued skill',source:'user',revision:0}]};
  if(route==='/api/skills?source=deleted')return{entries:[]};
  if(route==='/api/instructions/core'||route==='/api/instructions/core/versions/0')return core;
  if(route==='/api/skills/custom-queued-skill')return new Promise(resolve=>{
   finishSkillRead=()=>resolve({content:'# Queued skill\n\nContent.',revision:0});
  });
  throw Error('Unexpected Runtime fixture request '+route);
 };
 const dom=planningDOM(t),ui=createRuntimeWorkspace({mount:dom.mount,api});
 t.after(()=>ui.destroy());ui.enter();
 await wait(()=>dom.$('[data-runtime-item="skill:custom-queued-skill"]'),'skill listed');
 await dom.click('[data-runtime-item="skill:custom-queued-skill"]');
 await wait(()=>typeof finishSkillRead==='function','skill request started');
 await dom.click('[data-runtime-item="layer:capabilities"]');
 finishSkillRead();
 await wait(()=>dom.$('#runtime-heading').textContent==='Tool routing'&&
  dom.$('#runtime-text').value==='ROUTING_CURRENT_101',
  'queued layer selection after skill fetch');
});
test('Runtime reports a partially saved core edit after an execution-layer conflict and permits recovery',async t=>{
 const dataDir=await env(t);
 const ownerCore=await new InstructionStore({dataDir,defaultContent:'CANONICAL_CORE_BEFORE'}).init();
 const layers=await new ExecutionLayerOverrides({dataDir}).init();
 t.after(()=>ownerCore.close());
 const definitions=async()=>[{id:'core',title:'System instructions',role:'developer',
  source:'instruction-store',text:(await ownerCore.read()).content}];
 await layers.save({action:'replace',id:'core',text:'OLDER_EFFECTIVE_CORE',
  expectedRevision:layers.revision},await definitions());
 let rejectLayerUpdate=true;
 const api=async(route,method='GET',body)=>{
  if(route==='/api/execution-layers'){
   if(method==='GET')return layers.list(await definitions());
   if(rejectLayerUpdate){rejectLayerUpdate=false;
    throw Object.assign(Error('Simulated competing layer update'),{status:409});}
   return layers.save(body,await definitions());
  }
  if(route==='/api/tool-descriptions')return{version:1,revision:0,tools:[]};
  if(route==='/api/skills'||route==='/api/skills?source=deleted')return{entries:[]};
  if(route==='/api/instructions/core')return method==='GET'?ownerCore.read():ownerCore.update(body);
  if(route==='/api/instructions/core/versions/0')return ownerCore.readVersion(0);
  throw Error('Unexpected route '+route);
 };
 const f=planningDOM(t),ui=createRuntimeWorkspace({mount:f.mount,api});
 t.after(()=>ui.destroy());ui.enter();
 await wait(()=>f.$('#runtime-text').value==='OLDER_EFFECTIVE_CORE','effective legacy core loaded');
 await f.input('#runtime-text','NEW_CANONICAL_BUT_PENDING_EFFECTIVE');
 await f.$('#runtime-editor').dispatch('submit');
 await wait(async()=> (await ownerCore.read()).content==='NEW_CANONICAL_BUT_PENDING_EFFECTIVE',
  'first owner write succeeded');
 await wait(()=>f.$('#runtime-save-status').textContent.includes('effective layer update failed'),
  'partial update is explicitly identified');
 assert.equal(layers.project('core','NEW_CANONICAL_BUT_PENDING_EFFECTIVE').text,'OLDER_EFFECTIVE_CORE',
  'failed second write must not be called an effective update');
 assert.equal(f.$('#runtime-text').value,'NEW_CANONICAL_BUT_PENDING_EFFECTIVE',
  'user draft is available for retry');
 await f.$('#runtime-editor').dispatch('submit');
 await wait(()=>layers.project('core','NEW_CANONICAL_BUT_PENDING_EFFECTIVE').text===
  'NEW_CANONICAL_BUT_PENDING_EFFECTIVE','effective override synchronized on retry');
});
