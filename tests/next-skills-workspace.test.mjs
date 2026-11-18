import test from 'node:test';
import assert from 'node:assert/strict';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {createSkillsWorkspace} from '../public/next/workspaces/skills.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';
const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI did not settle');};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise};};
async function fixture(t,hook){const dom=planningDOM(t),catalog=createSkillsCatalog(),calls=[];
 const api=async(route,method='GET',body,options)=>{calls.push({route,method,body,options});if(hook){const override=await hook(route,method,body);if(override!==undefined)return override;}if(route==='/api/skills/folders')return {revision:0,folders:[],assignments:{}};const url=new URL(route,'http://test');return url.pathname==='/api/skills'?catalog.list({query:url.searchParams.get('query')||''}):catalog.detail({id:decodeURIComponent(url.pathname.slice('/api/skills/'.length))}).then(entry=>({...entry,userEditable:true}));};
 const workspace=createSkillsWorkspace({mount:dom.mount,api});t.after(()=>workspace.destroy());workspace.enter();await until(()=>dom.$('[data-skill-id="builtin-browser"]'));return {...dom,workspace,catalog,calls};}
test('Skills UI reads bundled source and exposes human editing without implicit writes',async t=>{const f=await fixture(t);await f.click('[data-skill-id="builtin-browser"]');await until(()=>!f.$('#skills-content').hidden);assert.match(f.$('#skills-content').textContent,/When to use/);assert.match(f.$('#skills-meta').textContent,/Bundled original/);assert.equal(f.$('#skills-edit').hidden,false);assert.equal(f.$('#skills-new'),null);assert.ok(f.calls.every(c=>c.method==='GET'));});
test('search empty state and refresh work without catalog injection or persistence',async t=>{const f=await fixture(t);f.$('#skills-query').value='no-such-method';await f.$('#skills-query').dispatch('input');await until(()=>f.$('#skills-list').textContent.includes('No matching'));f.$('#skills-query').value='job';await f.$('#skills-query').dispatch('input');await until(()=>f.$('[data-skill-id="builtin-job-search"]'));assert.equal(f.$('[data-skill-id="builtin-browser"]'),null);await f.click('#skills-refresh');await until(()=>!f.$('#skills-refresh').disabled);assert.ok(f.calls.every(c=>c.method==='GET'));});
test('late selection cannot overwrite a newer selection',async t=>{const delayed=deferred();const f=await fixture(t,route=>route.endsWith('/builtin-browser')?delayed.promise:undefined);await f.click('[data-skill-id="builtin-browser"]');await f.click('[data-skill-id="builtin-job-search"]');await until(()=>f.$('#skills-heading').textContent==='Job search and applications');delayed.resolve(await f.catalog.detail({id:'builtin-browser'}));await new Promise(r=>setTimeout(r,20));assert.equal(f.$('#skills-heading').textContent,'Job search and applications');});
test('leaving aborts pending reads; reentry refreshes without writes',async t=>{const delayed=deferred();let block=true;const f=await fixture(t,route=>block&&route.endsWith('/builtin-browser')?delayed.promise:undefined);await f.click('[data-skill-id="builtin-browser"]');f.workspace.leave();assert.equal(f.calls.at(-1).options.signal.aborted,true);delayed.resolve(await f.catalog.detail({id:'builtin-browser'}));await new Promise(r=>setTimeout(r,20));assert.equal(f.$('#skills-content').hidden,true);block=false;f.workspace.enter();await until(()=>!f.$('#skills-content').hidden);assert.ok(f.calls.every(c=>c.method==='GET'));});

test('human save sends full draft and revision, renders the returned saved source',async t=>{
 let saved;const f=await fixture(t,async(route,method,body)=>{if(method==='POST'){saved={id:'builtin-browser',...body,revision:2,source:'user',userEditable:true};return saved;}});
 await f.click('[data-skill-id="builtin-browser"]');await until(()=>!f.$('#skills-content').hidden);
 await f.click('#skills-edit');await f.input('#skills-edit-content','Human-authored instructions.');
 await f.$('#skills-editor').dispatch('submit');await until(()=>f.$('#skills-detail-status').textContent.startsWith('Skill saved.'));
 assert.equal(saved.content,'Human-authored instructions.');assert.equal(saved.expectedRevision,1);
 assert.equal(f.$('#skills-content').textContent,saved.content);assert.match(f.$('#skills-meta').textContent,/Your saved edit/);
 assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('failed save preserves draft through navigation; discard reloads stored content',async t=>{
 const f=await fixture(t,(route,method)=>{if(method==='POST')throw Error('Revision conflict');});
 await f.click('[data-skill-id="builtin-browser"]');await until(()=>!f.$('#skills-content').hidden);await f.click('#skills-edit');await f.input('#skills-edit-content','Keep my draft');
 await f.$('#skills-editor').dispatch('submit');await until(()=>f.$('#skills-save-status').textContent.includes('Revision conflict'));
 await f.click('[data-skill-id="builtin-job-search"]');await until(()=>f.$('#skills-heading').textContent==='Job search and applications');
 await f.click('[data-skill-id="builtin-browser"]');await until(()=>!f.$('#skills-editor').hidden);
 assert.equal(f.$('#skills-edit-content').value,'Keep my draft');await f.click('#skills-discard');await until(()=>!f.$('#skills-content').hidden);
 assert.notEqual(f.$('#skills-content').textContent,'Keep my draft');
});
test('in-flight saves cannot duplicate, switch target, or erase drafts on route leave',async t=>{
 const gate=deferred();const f=await fixture(t,(route,method)=>method==='POST'?gate.promise:undefined);
 await f.click('[data-skill-id="builtin-browser"]');await until(()=>!f.$('#skills-content').hidden);await f.click('#skills-edit');await f.input('#skills-edit-content','Pending edit');
 await f.$('#skills-editor').dispatch('submit');await f.$('#skills-editor').dispatch('submit');
 await f.click('[data-skill-id="builtin-job-search"]');f.workspace.openSkillId('builtin-job-search');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
 assert.notEqual(f.$('#skills-heading').textContent,'Job search and applications');f.workspace.leave();
 gate.resolve({...await f.catalog.detail({id:'builtin-browser'}),content:'Pending edit',userEditable:true,source:'user',revision:2});await new Promise(r=>setTimeout(r,20));
 f.workspace.enter();await until(()=>!f.$('#skills-content').hidden);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
