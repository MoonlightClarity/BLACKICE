import test from 'node:test';
import assert from 'node:assert/strict';
import {createSkillsWorkspace} from '../public/next/workspaces/skills.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';
const until=async p=>{for(let i=0;i<100;i++){if(p())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI did not settle');};
async function fixture(t,{count=25,folders=[],assignments={},rejectFolderWrite=false,skills}={}){
 const dom=planningDOM(t),calls=[],items=skills??Array.from({length:count},(_,i)=>({id:'builtin-fixture-'+i,title:'Skill '+i,revision:1,userEditable:true,source:'bundled'}));let trash=[];
 const api=async(route,method='GET',body)=>{
 calls.push({route,method,body});if(route==='/api/skills/folders'){
  if(method==='POST'&&rejectFolderWrite)throw Error('Folder is not empty.');
  return {revision:0,folders,assignments};
 }
 const url=new URL(route,'http://test');
 if(url.pathname==='/api/skills'){const rows=url.searchParams.get('source')==='deleted'?trash:items;return {entries:rows.filter(x=>x.title.toLowerCase().includes((url.searchParams.get('query')||'').toLowerCase()))};}
 const id=decodeURIComponent(url.pathname.split('/')[3]),item=items.find(x=>x.id===id);
 if(method==='DELETE'){items.splice(items.indexOf(item),1);trash.push({...item,revision:2});return {id,deleted:true};}
 return {...item,content:'# '+item.title};
 };
 const workspace=createSkillsWorkspace({mount:dom.mount,api});t.after(()=>workspace.destroy());workspace.enter();await until(()=>dom.$('[data-skill-id]'));return {...dom,workspace,calls};
}
test('skill pages bound DOM, keep draft across pages, reset on search, and clamp after deletion',async t=>{
 const f=await fixture(t);assert.equal(f.mount.querySelectorAll('[data-skill-id]').length,10);
 const next='[data-page-key="category:other-skills"][data-page-direction="next"]',prev='[data-page-key="category:other-skills"][data-page-direction="previous"]';
 assert.equal(f.$(prev).disabled,true);await f.click('[data-skill-id="builtin-fixture-0"]');await until(()=>!f.$('#skills-editor').hidden);
 assert.equal(f.$(prev).getAttribute('aria-label'),'Previous page');assert.equal(f.$(next).getAttribute('aria-label'),'Next page');
 assert.equal(f.$('.skills-pagination span').textContent,'1 / 3');
 await f.input('#skills-edit-content','Retain draft');await f.click(next);assert.ok(f.$('[data-skill-id="builtin-fixture-10"]'));await f.click(prev);assert.equal(f.$('#skills-edit-content').value,'Retain draft');
 await f.click(next);await f.click(next);assert.equal(f.mount.querySelectorAll('[data-skill-id]').length,5);assert.equal(f.$(next).disabled,true);
 assert.equal(f.document.activeElement,f.$(prev));
 const category='[data-folder-toggle="category:other-skills"]';
 assert.ok(f.$('.skills-category-branch .skills-folder-icon svg'));
 await f.click(category);assert.equal(f.$(category).getAttribute('aria-expanded'),'false');assert.equal(f.mount.querySelectorAll('[data-skill-id]').length,0);
 assert.equal(f.$('#skills-edit-content').value,'Retain draft');
 await f.click('[data-category-toggle="category:other-skills"]');assert.equal(f.$(category).getAttribute('aria-expanded'),'true');assert.equal(f.mount.querySelectorAll('[data-skill-id]').length,5);
 assert.equal(f.$('.skills-pagination span').textContent,'3 / 3','Reopening a category preserves its own page.');
 await f.input('#skills-query','Skill 24');await until(()=>f.mount.querySelectorAll('[data-skill-id]').length===1);assert.ok(f.$('[data-skill-id="builtin-fixture-24"]'));assert.equal(f.$(next),null);
 await f.click('[data-delete-skill="builtin-fixture-24"]');assert.match(f.$('#skills-delete-message').textContent,/Skill 24/);await f.click('#skills-delete-cancel');assert.equal(f.calls.filter(x=>x.method==='DELETE').length,0);
 await f.click('[data-delete-skill="builtin-fixture-24"]');await f.click('#skills-delete-yes');await until(()=>f.calls.some(x=>x.method==='DELETE'));await until(()=>f.$('#skills-list').textContent.includes('No matching'));assert.equal(f.calls.filter(x=>x.method==='DELETE').length,1);
});
test('folder disclosure collapses nested content and preserves child page without renaming',async t=>{
 const assignments=Object.fromEntries(Array.from({length:25},(_,i)=>['builtin-fixture-'+i,'folder-a']));
 const f=await fixture(t,{folders:[{id:'folder-a',name:'Methods',parentId:null}],assignments:{...assignments,'builtin-fixture-0':null}});
 const arrow='[data-folder-toggle="folder-a"]';assert.ok(f.$(arrow));assert.equal(f.mount.querySelectorAll('[data-skill-id]').length,1);
 await f.click(arrow);assert.equal(f.mount.querySelectorAll('[data-skill-id]').length,11);
 await f.click('[data-page-key="folder-a"][data-page-direction="next"]');assert.ok(f.$('[data-skill-id="builtin-fixture-11"]'));
 await f.click(arrow);assert.equal(f.mount.querySelectorAll('[data-skill-id]').length,1);
 await f.click(arrow);assert.ok(f.$('[data-skill-id="builtin-fixture-11"]'));
 assert.ok(f.calls.every(x=>x.method==='GET'));
 await f.click('[data-folder-name="folder-a"]');assert.ok(f.$('[data-folder-rename]'));
});
test('collapsing a matching branch survives refresh and returning to Skills',async t=>{
 const f=await fixture(t,{count:3,folders:[{id:'parent',name:'Methods',parentId:null},{id:'child',name:'Review',parentId:'parent'}],assignments:{'builtin-fixture-1':'child'}});
 const parent='[data-folder-toggle="parent"]',child='[data-folder-toggle="child"]',skill='[data-skill-id="builtin-fixture-1"]';
 await f.input('#skills-query','Skill 1');await until(()=>f.$(skill));
 await f.click(child);assert.equal(f.$(child).getAttribute('aria-expanded'),'false');assert.equal(f.$(skill),null);
 await f.click('#skills-refresh');await until(()=>f.$('#skills-status').textContent==='1 skills.');
 assert.equal(f.$(child).getAttribute('aria-expanded'),'false');assert.equal(f.$(skill),null);
 f.workspace.leave();f.workspace.enter();await until(()=>f.$('#skills-status').textContent==='1 skills.');
 assert.equal(f.$(child).getAttribute('aria-expanded'),'false');
 await f.click(parent);assert.equal(f.$(child),null);
 await f.click(parent);assert.equal(f.$(child).getAttribute('aria-expanded'),'false');
 await f.click(child);assert.ok(f.$(skill));
 await f.input('#skills-query','');await until(()=>f.$('#skills-status').textContent==='3 skills.');
 assert.equal(f.$(parent).getAttribute('aria-expanded'),'false','Search disclosure does not modify the unfiltered outline.');
 assert.ok(f.calls.every(x=>x.method==='GET'));
});
test('a failed folder edit does not disable local disclosure',async t=>{
 const f=await fixture(t,{count:2,folders:[{id:'parent',name:'Methods',parentId:null}],assignments:{'builtin-fixture-1':'parent'},rejectFolderWrite:true});
 const arrow='[data-folder-toggle="parent"]',skill='[data-skill-id="builtin-fixture-1"]';
 await f.click(arrow);assert.ok(f.$(skill));
 await f.click('.skills-folder-remove');await f.click('#skills-folder-delete-yes');await until(()=>f.$('#skills-status').textContent.includes('Refresh before another folder edit'));
 assert.equal(f.$('.skills-folder-remove').disabled,true);
 assert.equal(f.$(arrow).disabled,false);
 await f.click(arrow);assert.equal(f.$(arrow).getAttribute('aria-expanded'),'false');assert.equal(f.$(skill),null);
 await f.click(arrow);assert.ok(f.$(skill));
 assert.equal(f.calls.filter(x=>x.method==='POST').length,1);
});
test('default groups and alphabetizes unfiled skills without changing real folders or search ranking',async t=>{
 const items=[
  ['library-zebra','Skill Zebra review','documents'],['library-beta','Skill Beta analysis','data'],
  ['library-alpha','Skill Alpha review','documents'],['library-apple','Skill Apple analysis','data'],
  ['library-filed-z','Skill Z inside folder','data'],['library-filed-a','Skill A inside folder','documents'],
  ['library-other','Skill Other'],['builtin-decomposition','Task decomposition'],
 ].map(([id,title,tag])=>({id,title,tags:tag?[tag]:[],revision:1,userEditable:true,source:'bundled'}));
 const f=await fixture(t,{skills:items,folders:[{id:'user-folder',name:'User Folder',parentId:null}],assignments:{'library-filed-z':'user-folder','library-filed-a':'user-folder'}});
 const visible=()=>[...f.mount.querySelectorAll('[data-skill-id]')].map(node=>node.dataset.skillId);
 const categories=()=>[...f.mount.querySelectorAll('[data-skill-category]')].map(node=>node.dataset.skillCategory);
 assert.deepEqual(categories(),['General methods','Data & spreadsheets','Documents','Other skills']);
 assert.deepEqual(visible(),['builtin-decomposition','library-apple','library-beta','library-alpha','library-zebra','library-other']);
 await f.click('[data-folder-toggle="user-folder"]');
 assert.deepEqual(visible().slice(0,2),['library-filed-a','library-filed-z']);
 assert.ok(f.$('[data-folder-name="user-folder"]'));assert.equal(f.mount.querySelectorAll('[data-folder-toggle]').length,5);
 const docs='[data-folder-toggle="category:documents"]';
 await f.click(docs);assert.ok(!visible().includes('library-alpha'));assert.ok(visible().includes('library-filed-a'));
 assert.equal(f.$(docs).getAttribute('aria-expanded'),'false');
 assert.equal(f.document.activeElement,f.$(docs));
 await f.click('[data-category-toggle="category:documents"]');assert.ok(visible().includes('library-alpha'));
 await f.input('#skills-query','review');await until(()=>f.$('#skills-status').textContent==='2 skills.');
 assert.deepEqual(categories(),[]);assert.deepEqual(visible(),['library-zebra','library-alpha'],'Search results keep their returned order.');
 assert.ok(f.calls.every(x=>x.method==='GET'),'Catalog folder disclosure never writes owner folders or assignments.');
});

test('Skills UI explicitly confirms populated folder deletion and preserves contents',async t=>{
 const f=await fixture(t,{count:2,folders:[{id:'parent',name:'Methods',parentId:null}],
   assignments:{'builtin-fixture-1':'parent'}});
 assert.equal(f.$('#skills-folder-delete-confirm').hidden,true);
 await f.click('.skills-folder-remove');
 assert.equal(f.$('#skills-folder-delete-confirm').hidden,false);
 assert.match(f.$('#skills-folder-delete-confirm').textContent,/No skill documents are deleted/);
 assert.equal(f.calls.filter(call=>call.method==='POST').length,0,'opening confirmation has no mutation');
 await f.click('#skills-folder-delete-cancel');
 assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
 await f.click('.skills-folder-remove');
 await f.click('#skills-folder-delete-yes');
 await until(()=>f.calls.some(call=>call.method==='POST'));
 assert.deepEqual(f.calls.find(call=>call.method==='POST').body,{
  action:'remove',id:'parent',relocateContents:true,expectedRevision:0
 });
});
