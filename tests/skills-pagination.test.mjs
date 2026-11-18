import test from 'node:test';
import assert from 'node:assert/strict';
import {createSkillsWorkspace} from '../public/next/workspaces/skills.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';
const until=async p=>{for(let i=0;i<100;i++){if(p())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI did not settle');};
async function fixture(t,{count=25,folders=[],assignments={}}={}){
 const dom=planningDOM(t),calls=[],items=Array.from({length:count},(_,i)=>({id:'builtin-fixture-'+i,title:'Skill '+i,revision:1,userEditable:true,source:'bundled'}));let trash=[];
 const api=async(route,method='GET',body)=>{
 calls.push({route,method,body});if(route==='/api/skills/folders')return {revision:0,folders,assignments};
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
 const next='[data-page-key="root"][data-page-direction="next"]',prev='[data-page-key="root"][data-page-direction="previous"]';
 assert.equal(f.$(prev).disabled,true);await f.click('[data-skill-id="builtin-fixture-0"]');await until(()=>!f.$('#skills-editor').hidden);
 await f.input('#skills-edit-content','Retain draft');await f.click(next);assert.ok(f.$('[data-skill-id="builtin-fixture-10"]'));await f.click(prev);assert.equal(f.$('#skills-edit-content').value,'Retain draft');
 await f.click(next);await f.click(next);assert.equal(f.mount.querySelectorAll('[data-skill-id]').length,5);assert.equal(f.$(next).disabled,true);
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
