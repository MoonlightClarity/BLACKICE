import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
import {mountRuntime,expandRuntime,selectRuntimeSkill,waitFor,deferred} from './fixture-runtime-skills.mjs';

class NoModelRuntime extends EventEmitter{
 status(){return {connected:true,authenticated:true,models:[]};}
 async start(){return this.status();}
 async close(){}
 async runAgent(){throw Error('Runtime folder operations must not start a model.');}
}

test('Runtime category UI and native HTTP preserve nested placement, drafts, revisions and restart identity',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'runtime-folder-http-'));
 let app,base,cookie,holdCreate=null;const calls=[];
 t.after(async()=>{await app?.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 const open=async()=>{
  app=await createHarnessServer({runtime:new NoModelRuntime(),dataDir:root,defaultCwd:root,port:0,remoteAccess:false});
  base=await app.listen();cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];
 };
 await open();
 const api=async(route,method='GET',payload)=>{
  calls.push({route,method,payload});
  if(holdCreate&&route==='/api/runtime/organization'&&method==='POST'&&payload.name==='Only once')await holdCreate.promise;
  const response=await fetch(new URL(route,base),{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(payload)})});
  const result=await response.json();
  if(!response.ok)throw Object.assign(Error(result.error?.message||result.error||'Request failed'),{status:response.status});
  return result;
 };
 const f=mountRuntime(t,api),state=()=>api('/api/runtime/organization');
 await waitFor(()=>f.$('#runtime-status').textContent.includes('runtime sources loaded'),'native Runtime sources');
 const create=async(parentId,name)=>{
  await f.click('[data-add-category="'+parentId+'"]');
  await f.input('#runtime-category-name',name);
  await f.$('#runtime-category-form').dispatch('submit');
  await waitFor(()=>f.$('#runtime-category-form').hidden,'category created');
  return (await state()).folders.find(row=>row.name===name).id;
 };
 const parent=await create('runtime:skill','Career');
 await expandRuntime(f,parent);
 const child=await create(parent,'Research');
 await expandRuntime(f,child);
 const before=await api('/api/skills/builtin-decomposition');
 await selectRuntimeSkill(f,before);
 const draft=before.content+'\nUnsaved placement draft.\n';
 await f.input('#runtime-text',draft);
 const destination=f.$('#runtime-move-target').children.find(option=>option.value===child);
 assert.match(destination.textContent,/Skills & methods \/ Career \/ Research/);
 f.$('#runtime-move-target').value=child;
 await f.click('#runtime-move');
 await waitFor(async()=> (await state()).assignments[before.id]===child,'nested placement');
 assert.equal(f.$('#runtime-text').value,draft);
 assert.deepEqual(await api('/api/skills/'+before.id),before,'moving never edits the document or its revision');
 let current=await state();
 await api('/api/runtime/organization','POST',{action:'update',id:child,name:'Renamed research',expectedRevision:current.revision});
 await f.click('#runtime-refresh');
 await waitFor(()=>f.mount.textContent.includes('Renamed research')&&!f.$('#runtime-move').disabled,'renamed category refresh');
 assert.equal(f.$('#runtime-text').value,draft);
 current=await state();
 await assert.rejects(api('/api/runtime/organization','POST',{action:'update',id:parent,parentId:child,expectedRevision:current.revision}),{status:400});
 assert.deepEqual(await state(),current,'a rejected cycle has no persistent effect');
 await f.click('[data-add-category="'+child+'"]');
 await f.input('#runtime-category-name','Keep original parent draft');
 await api('/api/runtime/organization','POST',{action:'remove',id:child,relocateContents:true,expectedRevision:current.revision});
 await f.$('#runtime-category-form').dispatch('submit');
 await waitFor(()=>f.$('#runtime-organization-status').textContent.includes('Refresh before'),'organization conflict');
 assert.equal(f.$('#runtime-category-name').value,'Keep original parent draft');
 assert.ok(!(await state()).folders.some(row=>row.name==='Keep original parent draft'));
 await f.click('#runtime-refresh');
 await waitFor(()=>!f.$('#runtime-move').disabled&&f.$('#runtime-status').textContent.includes('runtime sources loaded')&&f.$('#runtime-category-create').disabled,'missing original parent stays unavailable after refresh');
 assert.equal(f.$('#runtime-category-name').value,'Keep original parent draft');
 assert.equal(f.$('#runtime-category-cancel').disabled,false);
 await f.click('#runtime-category-cancel');
 assert.equal(f.$('#runtime-category-form').hidden,true);
 assert.equal((await state()).assignments[before.id],parent,'removal relocates contents without deleting them');
 await expandRuntime(f,parent);
 holdCreate=deferred();
 await f.click('[data-add-category="'+parent+'"]');
 await f.input('#runtime-category-name','Only once');
 const form=f.$('#runtime-category-form'),first=form.dispatch('submit');
 await waitFor(()=>calls.some(call=>call.method==='POST'&&call.payload?.name==='Only once'),'create admitted');
 await form.dispatch('submit');
 assert.equal(calls.filter(call=>call.method==='POST'&&call.payload?.name==='Only once').length,1);
 holdCreate.resolve();await first;holdCreate=null;
 assert.equal((await state()).folders.filter(row=>row.name==='Only once').length,1);
 assert.deepEqual(await api('/api/skills/'+before.id),before);
 const persisted=await state();
 assert.deepEqual(await api('/api/skills/folders'),persisted,'legacy endpoint aliases the current organization store');
 f.ui.leave();await app.close();await open();
 assert.deepEqual(await state(),persisted);
 assert.deepEqual(await api('/api/skills/'+before.id),before);
 const denied=await fetch(new URL('/api/runtime/organization',base),{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','x-blackice-remote':'1'},body:JSON.stringify({action:'remove',id:parent,expectedRevision:persisted.revision})});
 assert.equal(denied.status,403);
 assert.deepEqual(await state(),persisted);
});
