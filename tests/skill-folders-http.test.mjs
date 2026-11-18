import test from 'node:test';import assert from 'node:assert/strict';import{EventEmitter}from'node:events';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import path from'node:path';import{createHarnessServer}from'../server.mjs';import{planningDOM}from'./fixture-planning-dom.mjs';import{createSkillsWorkspace}from'../public/next/workspaces/skills.mjs';
class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,models:[]};}async start(){return this.status();}async close(){}async runAgent(){throw Error('Folder operations must not start a model.');}}
const until=async f=>{for(let i=0;i<100;i++){if(f())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI did not settle');};
test('actual Skills UI saves nested folders and skill placement through authenticated HTTP and restart',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'skill-folder-http-'));let app,base,cookie;
 const open=async()=>{app=await createHarnessServer({runtime:new Runtime(),dataDir:root,defaultCwd:root,port:0,remoteAccess:false});base=await app.listen();cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];};await open();
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const api=async(route,method='GET',payload)=>{const r=await fetch(new URL(route,base),{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(payload)})});const result=await r.json();if(!r.ok)throw Object.assign(Error(result.error?.message||result.error||'Failed'),{status:r.status});return result;};
 const dom=planningDOM(t),ui=createSkillsWorkspace({mount:dom.mount,api});t.after(()=>ui.destroy());ui.enter();await until(()=>dom.$('[data-skill-id="builtin-browser"]'));
 dom.$('#skills-folder-name').value='Career';await dom.$('#skills-folder-form').dispatch('submit');await until(()=>dom.$('[data-folder-id]'));let data=await api('/api/skills/folders');const parent=data.folders[0].id;
 dom.$('#skills-folder-name').value='Research';dom.$('#skills-folder-parent').value=parent;await dom.$('#skills-folder-form').dispatch('submit');await until(()=>dom.mount.querySelectorAll('[data-folder-id]').length===2);data=await api('/api/skills/folders');const child=data.folders.find(x=>x.parentId===parent).id;
 await dom.click('[data-skill-id="builtin-browser"]');await until(()=>!dom.$('#skills-content').hidden);dom.$('#skills-assignment-folder').value=child;await dom.$('#skills-assignment').dispatch('submit');await until(()=>dom.$('#skills-status').textContent==='Folder changes saved.');
 data=await api('/api/skills/folders');assert.equal(data.assignments['builtin-browser'],child);assert.match(dom.$('#skills-assignment-folder').textContent,/Career \/ Research/);
 await app.close();await open();assert.deepEqual(await api('/api/skills/folders'),data);
 const denied=await fetch(new URL('/api/skills/folders',base),{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','x-blackice-remote':'1'},body:JSON.stringify({action:'remove',id:parent,expectedRevision:data.revision})});assert.equal(denied.status,403);assert.deepEqual(await api('/api/skills/folders'),data);
 await dom.click('[data-edit-folder="'+parent+'"]');dom.$('#skills-folder-edit-name').value='Unsaved draft';
 await api('/api/skills/folders','POST',{action:'update',id:parent,name:'Newer title',expectedRevision:data.revision});
 await dom.$('#skills-folder-edit-form').dispatch('submit');await until(()=>dom.$('#skills-status').textContent.includes('Refresh before another edit'));
 assert.equal(dom.$('#skills-folder-edit-name').value,'Unsaved draft');assert.equal((await api('/api/skills/folders')).folders.find(x=>x.id===parent).name,'Newer title');
 await dom.click('#skills-refresh');await until(()=>dom.$('#skills-folder-edit-name').value==='Newer title');
 dom.$('#skills-folder-edit-name').value='Final title';await dom.$('#skills-folder-edit-form').dispatch('submit');await until(()=>dom.$('#skills-status').textContent==='Folder changes saved.');
 assert.equal((await api('/api/skills/folders')).folders.find(x=>x.id===parent).name,'Final title');
 const asset=await fetch(new URL('/next/core/folder-tree.mjs',base),{headers:{Cookie:cookie}});assert.equal(asset.status,200);assert.match(await asset.text(),/export function folderRows/);
});
