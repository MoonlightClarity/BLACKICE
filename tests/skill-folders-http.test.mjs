import test from 'node:test';import assert from 'node:assert/strict';import{EventEmitter}from'node:events';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import path from'node:path';import{createHarnessServer}from'../server.mjs';import{planningDOM}from'./fixture-planning-dom.mjs';import{createSkillsWorkspace}from'../public/next/workspaces/skills.mjs';
class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,models:[]};}async start(){return this.status();}async close(){}async runAgent(){throw Error('Folder operations must not start a model.');}}
const until=async f=>{for(let i=0;i<150;i++){if(await f())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI did not settle');};
test('Skills outline supports rename, keyboard nesting, drag, revision conflicts and restart without changing documents',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'skill-folder-http-'));let app,base,cookie;
 t.after(async()=>{await app?.close();await rm(root,{recursive:true,force:true});});
 const open=async()=>{app=await createHarnessServer({runtime:new Runtime(),dataDir:root,defaultCwd:root,port:0,remoteAccess:false});base=await app.listen();cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];};await open();
 const api=async(route,method='GET',payload)=>{const r=await fetch(new URL(route,base),{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(payload)})});const result=await r.json();if(!r.ok)throw Object.assign(Error(result.error?.message||result.error||'Failed'),{status:r.status});return result;};
 const dom=planningDOM(t),ui=createSkillsWorkspace({mount:dom.mount,api});t.after(()=>ui.destroy());ui.enter();await until(()=>dom.$('[data-skill-id="builtin-decomposition"]'));
 const state=()=>api('/api/skills/folders'),ready=()=>until(()=>!dom.$('#skills-refresh').disabled&&!dom.$('#skills-status').textContent.startsWith('Loading'));
 const create=async(name,parentId=null)=>{await dom.click(parentId?'[data-new-subfolder="'+parentId+'"]':'#skills-new-folder');dom.$('#skills-folder-name').value=name;await dom.$('#skills-folder-form').dispatch('submit');await until(()=>!dom.$('#skills-folder-name'));await ready();return(await state()).folders.find(x=>x.name===name).id;};
 const parent=await create('Career'),child=await create('Research');const explicit=await create('Direct child',parent);assert.equal((await state()).folders.find(x=>x.id===explicit).parentId,parent);await dom.click('[data-new-subfolder="'+explicit+'"]');dom.$('#skills-folder-name').value='Cancelled';await dom.$('#skills-folder-form').dispatch('keydown',{key:'Escape'});assert.equal(dom.$('#skills-folder-form'),null);assert.equal((await state()).folders.some(x=>x.name==='Cancelled'),false);
 const label=id=>dom.$('[data-folder-name="'+id+'"]'),row=id=>dom.$('[data-folder-id="'+id+'"]');
 await label(child).dispatch('keydown',{key:'Enter',ctrlKey:true});await until(async()=> (await state()).folders.find(x=>x.id===child).parentId===parent);await ready();
 await label(child).dispatch('keydown',{key:'Enter',ctrlKey:true,shiftKey:true});await until(async()=> (await state()).folders.find(x=>x.id===child).parentId===null);await ready();
 const transfer={setData(){},effectAllowed:'',dropEffect:''};
 await row(child).dispatch('dragstart',{dataTransfer:transfer});await row(parent).dispatch('drop',{dataTransfer:transfer});
 await until(async()=> (await state()).folders.find(x=>x.id===child).parentId===parent);await ready();
 const before=await api('/api/skills/builtin-decomposition');
 await dom.$('[data-skill-id="builtin-decomposition"]').dispatch('dragstart',{dataTransfer:transfer});await row(child).dispatch('drop',{dataTransfer:transfer});
 await until(async()=> (await state()).assignments['builtin-decomposition']===child);await ready();assert.deepEqual(await api('/api/skills/builtin-decomposition'),before);
 // Cycle is refused without a write.
 const beforeCycle=await state();await row(parent).dispatch('dragstart',{dataTransfer:transfer});await row(child).dispatch('drop',{dataTransfer:transfer});assert.deepEqual(await state(),beforeCycle);
 // Name click is rename, not disclosure; Escape preserves the saved name.
 await dom.click(label(parent));await dom.input('[data-folder-rename]','Never save this');await dom.$('[data-folder-rename]').dispatch('keydown',{key:'Escape'});assert.equal((await state()).folders.find(x=>x.id===parent).name,'Career');
 await dom.click(label(parent));await dom.input('[data-folder-rename]','Unsaved draft');const old=await state();
 await api('/api/skills/folders','POST',{action:'update',id:parent,name:'Newer title',expectedRevision:old.revision});
 await dom.$('[data-folder-rename]').dispatch('keydown',{key:'Enter'});await until(()=>dom.$('#skills-status').textContent.includes('Refresh before'));
 assert.equal(dom.$('[data-folder-rename]').value,'Unsaved draft');await dom.click('#skills-refresh');await ready();
 assert.equal(dom.$('[data-folder-rename]').value,'Unsaved draft'); // no stale rebase
 await dom.$('[data-folder-rename]').dispatch('keydown',{key:'Enter'});await until(()=>dom.$('#skills-status').textContent.includes('Refresh before'));
 assert.equal((await state()).folders.find(x=>x.id===parent).name,'Newer title');
 await dom.click('#skills-refresh');await ready();await dom.$('[data-folder-rename]').dispatch('keydown',{key:'Escape'});
 await dom.click(label(parent));await dom.input('[data-folder-rename]','Final title');await dom.$('[data-folder-rename]').dispatch('keydown',{key:'Enter'});await until(async()=> (await state()).folders.find(x=>x.id===parent).name==='Final title');await ready();
 // Inline creation keeps its original parent and revision across refresh; no duplicate submit.
 await dom.click('[data-new-subfolder="'+parent+'"]');dom.$('#skills-folder-name').value='Stale child';
 const priorCreate=await state();await api('/api/skills/folders','POST',{action:'update',id:parent,name:'Final title',expectedRevision:priorCreate.revision});
 await dom.$('#skills-folder-form').dispatch('submit');await dom.$('#skills-folder-form').dispatch('submit');
 await until(()=>dom.$('#skills-status').textContent.includes('Refresh before'));assert.equal(dom.$('#skills-folder-name').value,'Stale child');
 await dom.click('#skills-refresh');await ready();await dom.$('#skills-folder-form').dispatch('submit');
 await until(()=>dom.$('#skills-status').textContent.includes('Refresh before'));assert.equal((await state()).folders.some(x=>x.name==='Stale child'),false);
 await dom.click('#skills-refresh');await ready();await dom.click('#skills-create-cancel');assert.equal(dom.$('#skills-folder-form'),null);
 const persisted=await state();await app.close();await open();assert.deepEqual(await state(),persisted);
 const denied=await fetch(new URL('/api/skills/folders',base),{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','x-blackice-remote':'1'},body:JSON.stringify({action:'remove',id:parent,expectedRevision:persisted.revision})});assert.equal(denied.status,403);
});
