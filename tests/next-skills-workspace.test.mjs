import test from 'node:test';
import assert from 'node:assert/strict';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {createSkillsWorkspace} from '../public/next/workspaces/skills.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';
const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI did not settle');};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise};};
async function fixture(t,hook){const dom=planningDOM(t),catalog=createSkillsCatalog(),calls=[];
 const api=async(route,method='GET',body,options)=>{calls.push({route,method,body,options});if(hook){const override=await hook(route,method,body);if(override!==undefined)return override;}if(route==='/api/skills/folders')return {revision:0,folders:[],assignments:{}};const url=new URL(route,'http://test');return url.pathname==='/api/skills'?catalog.list({query:url.searchParams.get('query')||'',source:url.searchParams.get('source')||'all'}):catalog.detail({id:decodeURIComponent(url.pathname.slice('/api/skills/'.length))}).then(entry=>({...entry,userEditable:true}));};
 const workspace=createSkillsWorkspace({mount:dom.mount,api});t.after(()=>workspace.destroy());workspace.enter();await until(()=>dom.$('[data-skill-id="builtin-decomposition"]'));return {...dom,workspace,catalog,calls};}
test('Skills UI reads bundled source and exposes human editing without implicit writes',async t=>{const f=await fixture(t);await f.click('[data-skill-id="builtin-decomposition"]');await until(()=>!f.$('#skills-editor').hidden);assert.equal(f.$('#skills-edit-content').value,(await f.catalog.detail({id:'builtin-decomposition'})).content);assert.match(f.$('#skills-detail-status').textContent,/Bundled document/);assert.equal(f.$('#skills-edit'),null);assert.equal(f.mount.querySelectorAll('textarea').length,1);assert.equal(f.$('#skills-new').textContent,'New skill');assert.ok(f.calls.every(c=>c.method==='GET'));});
test('search empty state and refresh work without catalog injection or persistence',async t=>{const f=await fixture(t);f.$('#skills-query').value='no-such-method';await f.$('#skills-query').dispatch('input');await until(()=>f.$('#skills-list').textContent.includes('No matching'));f.$('#skills-query').value='competing';await f.$('#skills-query').dispatch('input');await until(()=>f.$('[data-skill-id="builtin-structured-analysis"]'));assert.equal(f.$('[data-skill-id="builtin-decomposition"]'),null);await f.click('#skills-refresh');await until(()=>!f.$('#skills-refresh').disabled);assert.ok(f.calls.every(c=>c.method==='GET'));});
test('late selection cannot overwrite a newer selection',async t=>{const delayed=deferred();const f=await fixture(t,route=>route.endsWith('/builtin-decomposition')?delayed.promise:undefined);await f.click('[data-skill-id="builtin-decomposition"]');await f.click('[data-skill-id="builtin-structured-analysis"]');await until(()=>f.$('#skills-heading').textContent==='Structured analytic techniques');delayed.resolve(await f.catalog.detail({id:'builtin-decomposition'}));await new Promise(r=>setTimeout(r,20));assert.equal(f.$('#skills-heading').textContent,'Structured analytic techniques');});
test('leaving aborts pending reads; reentry refreshes without writes',async t=>{const delayed=deferred();let block=true;const f=await fixture(t,route=>block&&route.endsWith('/builtin-decomposition')?delayed.promise:undefined);await f.click('[data-skill-id="builtin-decomposition"]');f.workspace.leave();assert.equal(f.calls.at(-1).options.signal.aborted,true);delayed.resolve(await f.catalog.detail({id:'builtin-decomposition'}));await new Promise(r=>setTimeout(r,20));assert.equal(f.$('#skills-editor').hidden,true);block=false;f.workspace.enter();await until(()=>!f.$('#skills-editor').hidden);assert.ok(f.calls.every(c=>c.method==='GET'));});

test('human save sends full draft and revision, renders the returned saved source',async t=>{
 let saved;const f=await fixture(t,async(route,method,body)=>{if(method==='POST'){saved={id:'builtin-decomposition',...body,revision:2,source:'user',userEditable:true};return saved;}});
 await f.click('[data-skill-id="builtin-decomposition"]');await until(()=>!f.$('#skills-editor').hidden);
 await f.input('#skills-edit-content','Human-authored instructions.');
 await f.$('#skills-editor').dispatch('submit');await until(()=>f.$('#skills-save-status').textContent==='Saved.');
 assert.equal(saved.content,'Human-authored instructions.');assert.equal(saved.expectedRevision,1);
 assert.equal(f.$('#skills-edit-content').value,saved.content);assert.match(f.$('#skills-detail-status').textContent,/Your saved document/);
 assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('failed save preserves draft through navigation; discard reloads stored content',async t=>{
 const f=await fixture(t,(route,method)=>{if(method==='POST')throw Error('Revision conflict');});
 await f.click('[data-skill-id="builtin-decomposition"]');await until(()=>!f.$('#skills-editor').hidden);await f.input('#skills-edit-content','Keep my draft');
 await f.$('#skills-editor').dispatch('submit');await until(()=>f.$('#skills-save-status').textContent.includes('Revision conflict'));
 await f.click('[data-skill-id="builtin-structured-analysis"]');await until(()=>f.$('#skills-heading').textContent==='Structured analytic techniques');
 await f.click('[data-skill-id="builtin-decomposition"]');await until(()=>f.$('#skills-edit-content').value==='Keep my draft');
 assert.equal(f.$('#skills-edit-content').value,'Keep my draft');await f.click('#skills-discard');await until(()=>f.$('#skills-edit-content').value!=='Keep my draft');
 assert.notEqual(f.$('#skills-edit-content').value,'Keep my draft');
});
test('in-flight saves cannot duplicate, switch target, or erase drafts on route leave',async t=>{
 const gate=deferred();const f=await fixture(t,(route,method)=>method==='POST'?gate.promise:undefined);
 await f.click('[data-skill-id="builtin-decomposition"]');await until(()=>!f.$('#skills-editor').hidden);await f.input('#skills-edit-content','Pending edit');
 await f.$('#skills-editor').dispatch('submit');await f.$('#skills-editor').dispatch('submit');
 await f.click('[data-skill-id="builtin-structured-analysis"]');f.workspace.openSkillId('builtin-structured-analysis');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
 assert.notEqual(f.$('#skills-heading').textContent,'Structured analytic techniques');f.workspace.leave();
 gate.resolve({...await f.catalog.detail({id:'builtin-decomposition'}),content:'Pending edit',userEditable:true,source:'user',revision:2});await new Promise(r=>setTimeout(r,20));
 f.workspace.enter();await until(()=>!f.$('#skills-editor').hidden);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});

test('refresh never rebases an edited document onto an externally newer revision',async t=>{
 const base=await createSkillsCatalog().detail({id:'builtin-decomposition'});let revision=1;
 const f=await fixture(t,(route,method,body)=>{
  if(route.endsWith('/builtin-decomposition')&&method==='GET')return {...base,userEditable:true,revision,content:revision===1?base.content:'External newer document'};
  if(method==='POST'){assert.equal(body.expectedRevision,1);assert.equal(body.content,'My exact draft\r\n');throw Error('Skill changed');}
 });
 await f.click('[data-skill-id="builtin-decomposition"]');await until(()=>!f.$('#skills-editor').hidden);
 await f.input('#skills-edit-content','My exact draft\r\n');revision=2;await f.click('#skills-refresh');await until(()=>f.$('#skills-detail-status').textContent.includes('revision 2'));
 assert.equal(f.$('#skills-edit-content').value,'My exact draft\r\n');
 await f.$('#skills-editor').dispatch('submit');await until(()=>f.$('#skills-save-status').textContent.includes('Skill changed'));
 assert.equal(f.$('#skills-edit-content').value,'My exact draft\r\n');
});

test('New skill opens an empty draft and POSTs to the skill collection only once',async t=>{
 const gate=deferred(),id='user-01234567-89ab-cdef-0123-456789abcdef',content='# Local checklist\n\nCheck the receipt.';
 let created=false;
 const entry={id,title:'Local checklist',content,source:'user',revision:1,userEditable:true};
 const f=await fixture(t,async(route,method)=>{
  if(route==='/api/skills'&&method==='POST'){await gate.promise;created=true;return entry;}
  if(created&&route==='/api/skills?query=')return {entries:[entry]};
 });
 await f.click('#skills-new');assert.equal(f.$('#skills-heading').textContent,'New skill');
 assert.equal(f.$('#skills-edit-content').value,'# ');
 await f.input('#skills-edit-content',content);
 await f.$('#skills-editor').dispatch('submit');await f.$('#skills-editor').dispatch('submit');
 assert.deepEqual(f.calls.filter(c=>c.method==='POST').map(({route,body})=>[route,body]),[['/api/skills',{content}]]);
 gate.resolve();
 await until(()=>f.$('#skills-save-status').textContent==='Skill created.');
 assert.equal(f.$('#skills-heading').textContent,'Local checklist');
 assert.equal(f.$('#skills-edit-content').value,content);
 assert.ok(f.$('[data-skill-id="'+id+'"]'));
});
test('Failed creation keeps the draft and cancel restores the editor',async t=>{
 const f=await fixture(t,(route,method)=>{if(route==='/api/skills'&&method==='POST')throw Error('A title is required.');});
 await f.click('[data-skill-id="builtin-decomposition"]');await until(()=>!f.$('#skills-editor').hidden);
 await f.click('#skills-new');await f.input('#skills-edit-content','No heading');
 await f.$('#skills-editor').dispatch('submit');
 await until(()=>f.$('#skills-save-status').textContent.includes('A title is required.'));
 assert.equal(f.$('#skills-edit-content').value,'No heading');
 await f.click('#skills-discard');
 await until(()=>f.$('#skills-heading').textContent!=='New skill'&&!f.$('#skills-editor').hidden);
 assert.equal(f.$('#skills-edit-content').value,(await f.catalog.detail({id:'builtin-decomposition'})).content);
});

test('a skill stays draggable after moving between a category and an owner folder',async t=>{
 const id='builtin-decomposition',state={revision:0,folders:[{id:'custom',name:'Custom',parentId:null}],assignments:{}};
 const f=await fixture(t,(route,method,body)=>{
  if(route!=='/api/skills/folders')return;
  if(method==='POST'){
   assert.equal(body.expectedRevision,state.revision);
   state.assignments[body.skillId]=body.folderId;
   state.revision++;
  }
  return structuredClone(state);
 });
 for(const [selector,target] of [['[data-skill-category="Documents"]','category:Documents'],['[data-folder-id="custom"]','custom'],['#skills-root',null]]){
  const skill=f.$('[data-skill-id="builtin-decomposition"]');
  assert.equal(skill.draggable,true);
  await skill.dispatch('dragstart');
  await f.$(selector).dispatch('drop');
  await until(()=>state.assignments[id]===target&&!f.$('#skills-refresh').disabled);
 }
});
