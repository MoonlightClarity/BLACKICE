import test from 'node:test';
import assert from 'node:assert/strict';
import {createSkillsWorkspace} from '../public/next/workspaces/skills.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';

const until=async condition=>{for(let n=0;n<120;n++){if(condition())return;await new Promise(r=>setTimeout(r,10));}throw Error('Skills UI did not settle');};
async function fixture(t){
 const dom=planningDOM(t);
 const entries=[
  {id:'skill-one',title:'Alpha skill',tags:['documents'],content:'# Alpha skill',source:'user',revision:1,userEditable:true},
  {id:'skill-two',title:'Beta skill',tags:['research'],content:'# Beta skill',source:'user',revision:1,userEditable:true},
 ];
 const state={revision:4,folders:[
  {id:'z',name:'Zebra',parentId:null},
  {id:'m',name:'Delta',parentId:'z'},
  {id:'a',name:'Alpha',parentId:null},
  {id:'b',name:'Bravo',parentId:'a'},
 ],assignments:{'skill-one':null,'skill-two':'m'}};
 const writes=[];let reject=false;
 const api=async(route,method='GET',body)=>{
  if(route==='/api/skills/folders'){
   if(method==='POST'){
    writes.push(structuredClone(body));
    if(reject)throw Error('Simulated revision conflict');
    if(body.expectedRevision!==state.revision)throw Error('Stale revision');
    if(body.action==='assign')state.assignments[body.skillId]=body.folderId;
    if(body.action==='update')state.folders.find(row=>row.id===body.id).parentId=body.parentId;
    state.revision++;
   }
   return structuredClone(state);
  }
  const url=new URL(route,'http://test');
  if(url.pathname==='/api/skills')return {entries:url.searchParams.get('source')==='deleted'?[]:entries.filter(entry=>entry.title.toLowerCase().includes((url.searchParams.get('query')||'').toLowerCase()))};
  return structuredClone(entries.find(entry=>entry.id===decodeURIComponent(url.pathname.split('/')[3])));
 };
 const workspace=createSkillsWorkspace({mount:dom.mount,api});
 t.after(()=>workspace.destroy());
 workspace.enter();
 await until(()=>dom.$('[data-move-skill="skill-one"]'));
 return {...dom,workspace,state,writes,entries,rejectWrites:()=>{reject=true;}};
}

test('Move icon offers alphabetically ordered full folder paths, searchable independently of collapsed outline',async t=>{
 const f=await fixture(t);
 assert.equal(f.$('[data-move-skill="skill-one"]').getAttribute('aria-label'),'Move skill Alpha skill');
 assert.ok(f.$('[data-move-skill="skill-one"] svg'));
 assert.ok(f.$('[data-move-folder="z"] svg'));
 assert.equal(f.$('[data-folder-id="m"]'),null,'Nested folder starts collapsed, but must remain selectable');
 await f.click('[data-move-skill="skill-one"]');
 assert.equal(f.$('#skills-move-dialog').open,true);
 assert.equal(f.document.activeElement,f.$('#skills-move-query'));
 const folderOptions=f.mount.querySelectorAll('.skills-move-choice').filter(n=>['a','b','z','m'].includes(n.dataset.moveDestination));
 assert.deepEqual(folderOptions.map(n=>n.textContent),['Alpha','Alpha / Bravo','Zebra','Zebra / Delta']);
 assert.equal(f.$('[data-move-destination=""]').disabled,true,'Current top level is not a writable destination');
 await f.input('#skills-move-query','delta');
 assert.equal(f.mount.querySelectorAll('.skills-move-choice').length,1);
 assert.equal(f.$('[data-move-destination="m"]').textContent,'Zebra / Delta');
 await f.click('[data-move-destination="m"]');
 await until(()=>f.state.assignments['skill-one']==='m');
 assert.deepEqual(f.writes,[{action:'assign',skillId:'skill-one',folderId:'m',expectedRevision:4}]);
 assert.equal(f.state.revision,5);
 assert.equal(f.entries[0].content,'# Alpha skill','Moving must not change the document');
 assert.equal(f.$('#skills-move-dialog').open,false);
});

test('Move selected skill preserves its editing draft and supports an explicit category destination',async t=>{
 const f=await fixture(t);
 await f.click('[data-skill-id="skill-one"]');
 await until(()=>!f.$('#skills-editor').hidden);
 await f.input('#skills-edit-content','Uncommitted skill changes');
 assert.equal(f.$('#skills-move-selected').hidden,false);
 await f.click('#skills-move-selected');
 const categories=f.mount.querySelectorAll('.skills-move-group-heading').map(node=>node.textContent);
 assert.ok(categories.includes('Categories'));
 await f.input('#skills-move-query','Research');
 await f.mount.querySelectorAll('[data-move-destination]').find(node=>node.dataset.moveDestination==='category:Research & web').dispatch('click');
 await until(()=>f.state.assignments['skill-one']==='category:Research & web');
 assert.equal(f.$('#skills-edit-content').value,'Uncommitted skill changes');
 assert.equal(f.writes.length,1,'Moving a skill does not submit its draft');
});

test('Folder move excludes self and descendants, supports cancellation and preserves nesting',async t=>{
 const f=await fixture(t);
 await f.click('[data-move-folder="z"]');
 assert.equal(f.$('[data-move-destination="z"]'),null);
 assert.equal(f.$('[data-move-destination="m"]'),null,'Do not offer cyclic destinations');
 assert.equal(f.$('[data-move-destination=""]').disabled,true,'Moving an already-root folder to root is a no-op');
 await f.$('#skills-move-dialog').dispatch('cancel');
 assert.equal(f.$('#skills-move-dialog').open,false);
 assert.equal(f.writes.length,0);
 await f.click('[data-move-folder="z"]');
 await f.click('[data-move-destination="b"]');
 await until(()=>f.state.folders.find(row=>row.id==='z').parentId==='b');
 assert.deepEqual(f.writes,[{action:'update',id:'z',parentId:'b',expectedRevision:4}]);
});

test('Move picker remains safe on failed writes and closes on navigation',async t=>{
 const f=await fixture(t);
 f.rejectWrites();
 await f.click('[data-move-skill="skill-one"]');
 await f.click('[data-move-destination="a"]');
 await until(()=>f.$('#skills-status').textContent.includes('Refresh before another folder edit'));
 assert.equal(f.writes.length,1);
 assert.equal(f.state.assignments['skill-one'],null);
 assert.equal(f.$('[data-move-skill="skill-one"]').disabled,true);
 await f.click('#skills-refresh');
 await until(()=>f.$('[data-move-skill="skill-one"]').disabled===false);
 await f.click('[data-move-skill="skill-one"]');
 f.workspace.leave();
 assert.equal(f.$('#skills-move-dialog').open,false);
});
