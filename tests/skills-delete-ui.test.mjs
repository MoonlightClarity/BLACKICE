import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {createSkillsWorkspace} from '../public/next/workspaces/skills.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';
const until=async f=>{for(let i=0;i<100;i++){if(await f())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI did not settle');};
async function fixture(t,hook){
 const dataDir=await mkdtemp(path.join(tmpdir(),'skill-delete-ui-'));const catalog=createSkillsCatalog({dataDir}),dom=planningDOM(t),calls=[];
 t.after(async()=>{await catalog.close();await rm(dataDir,{recursive:true,force:true});});
 const api=async(route,method='GET',value)=>{
  calls.push({route,method,value});if(hook)await hook(route,method,value);
  if(route==='/api/skills/folders')return {revision:0,folders:[],assignments:{}};
  const url=new URL(route,'http://test');if(url.pathname==='/api/skills')return catalog.list({query:url.searchParams.get('query')||'',source:url.searchParams.get('source')||'all'});
  const id=url.pathname.split('/')[3];if(url.pathname.endsWith('/restore'))return catalog.restore({id,value});
  return method==='DELETE'?catalog.delete({id,value}):method==='POST'?catalog.save({id,value}):catalog.detail({id});
 };
 const ui=createSkillsWorkspace({mount:dom.mount,api});t.after(()=>ui.destroy());ui.enter();await until(()=>dom.$('[data-skill-id="builtin-browser"]'));
 await dom.click('[data-skill-id="builtin-browser"]');await until(()=>!dom.$('#skills-editor').hidden);
 return {...dom,catalog,ui,calls,dataDir};
}
test('delete requires explicit confirmation, cancel preserves draft, restore recovers saved bundled document',async t=>{
 const f=await fixture(t),original=await f.catalog.detail({id:'builtin-browser'}),other=await f.catalog.detail({id:'builtin-job-search'});
 await f.input('#skills-edit-content','Unsent draft');await f.click('#skills-delete');
 assert.match(f.$('#skills-delete-message').textContent,/unsaved changes will be discarded/);
 f.ui.openSkillId('builtin-job-search');assert.equal(f.$('#skills-heading').textContent,original.title);
 await f.click('#skills-delete-cancel');assert.equal(f.$('#skills-edit-content').value,'Unsent draft');assert.equal(f.calls.filter(x=>x.method==='DELETE').length,0);
 await f.click('#skills-delete');await f.click('#skills-delete-yes');await until(()=>f.$('[data-restore-skill="builtin-browser"]'));
 assert.equal(f.$('[data-skill-id="builtin-browser"]'),null);assert.equal(f.$('#skills-editor').hidden,true);
 await assert.rejects(f.catalog.detail({id:'builtin-browser'}),{status:404});assert.deepEqual(await f.catalog.detail({id:'builtin-job-search'}),other);
 const fresh=createSkillsCatalog({dataDir:f.dataDir});await assert.rejects(fresh.detail({id:'builtin-browser'}),{status:404});
 await f.click('[data-restore-skill="builtin-browser"]');await until(()=>f.$('[data-skill-id="builtin-browser"]'));await f.click('[data-skill-id="builtin-browser"]');await until(()=>!f.$('#skills-editor').hidden);
 assert.equal(f.$('#skills-edit-content').value,original.content);assert.equal(f.$('#skills-save').disabled,true);
});
test('stale delete refuses to discard draft or newer saved content; repeated confirm submits once',async t=>{
 let release;const gate=new Promise(r=>release=r);let block=false;
 const f=await fixture(t,async(route,method)=>{if(block&&method==='DELETE')await gate;});
 await f.input('#skills-edit-content','My draft');await f.click('#skills-delete');
 await f.catalog.save({id:'builtin-browser',value:{expectedRevision:1,content:'# Newer saved document'}});
 block=true;await f.click('#skills-delete-yes');await f.click('#skills-delete-yes');assert.equal(f.calls.filter(x=>x.method==='DELETE').length,1);release();
 await until(()=>f.$('#skills-save-status').textContent.includes('Deletion was not confirmed'));
 assert.equal(f.$('#skills-edit-content').value,'My draft');assert.equal((await f.catalog.detail({id:'builtin-browser'})).content,'# Newer saved document');
});
test('deleting saved human edit then restoring retains exact saved text, not the bundled default',async t=>{
 const f=await fixture(t),text=`# Human document
Exact saved body
`;
 await f.input('#skills-edit-content',text);await f.$('#skills-editor').dispatch('submit');await until(()=>f.$('#skills-save-status').textContent==='Saved.');
 await f.click('#skills-delete');await f.click('#skills-delete-yes');await until(()=>f.$('[data-restore-skill="builtin-browser"]'));
 await f.click('[data-restore-skill="builtin-browser"]');await until(()=>f.$('[data-skill-id="builtin-browser"]'));
 assert.equal((await f.catalog.detail({id:'builtin-browser'})).content,text);
});
