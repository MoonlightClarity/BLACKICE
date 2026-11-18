import test from 'node:test';import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createTodosWorkspace} from '../public/next/workspaces/todos.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
function setup(t,{fail=false,delay}={}){
 const dom=planningDOM(t);dom.mount.innerHTML='<div class="next-loading">Loading</div>';let readFailure=false;let eventHandler;let data={revision:1,legacyAvailable:true,items:[{id:'a',title:'Career transition',parentId:null,position:0,completed:false},{id:'b',title:'Prepare <script> portfolio',parentId:'a',position:0,completed:false},{id:'c',title:'Weekly errands',parentId:null,position:1,completed:false}]},calls=[];
 const api=async(route,method='GET',body)=>{calls.push({route,method,body});if(route==='/api/todos/legacy')return {readOnly:true,projects:[{name:'Previous work',items:[{title:'Saved task',phase:'open'}]}]};if(method==='GET'){if(readFailure)throw Error('Read failed');if(delay)return delay;return structuredClone(data);}
 if(fail)throw Error('Connection lost');if(body.expectedRevision!==data.revision)throw Error('Revision changed');assert.ok(body.requestId);
 if(body.action==='create')data.items.push({...body,completed:false});
 if(body.action==='update')Object.assign(data.items.find(n=>n.id===body.id),body);
 if(body.action==='move')Object.assign(data.items.find(n=>n.id===body.id),{parentId:body.parentId,position:body.position});
 if(body.action==='remove'){const ids=new Set([body.id]);for(let i=0;i<data.items.length;i++)for(const n of data.items)if(ids.has(n.parentId))ids.add(n.id);data.items=data.items.filter(n=>!ids.has(n.id));}
 data.revision++;return structuredClone(data);};
 const ui=createTodosWorkspace({mount:dom.mount,api,events:{subscribe(fn){eventHandler=fn;return()=>{};}}});t.after(()=>ui.destroy());ui.enter();
 return {...dom,ui,calls,setReadFailure(value){readFailure=value;},externalTitle(title){data.items[0].title=title;data.revision++;eventHandler({type:'todos.updated'});},posts:()=>calls.filter(c=>c.method==='POST'),button:text=>dom.mount.querySelectorAll('button').find(b=>b.textContent===text)};
}
test('nested outline and preserved records are read-only on entry; titles remain literal',async t=>{
 const f=setup(t);await tick();assert.equal(f.$('.next-loading'),null);assert.equal(f.$('.todo-outline').querySelectorAll('.todo-row').length,3);assert.equal(f.posts().length,0);assert.equal(f.$('script'),null);
 await f.button('View preserved records').dispatch('click');await tick();assert.match(f.$('.todo-legacy-records').textContent,/Saved task/);assert.equal(f.posts().length,0);
});
test('add child, rename, complete and move use explicit revisioned requests without model calls',async t=>{
 const f=setup(t);await tick();await f.button('Career transition').dispatch('click');await f.button('Add subtask').dispatch('click');
 f.$('.todo-add input').value='Review resume';await f.$('.todo-add').dispatch('submit');await tick();
 const created=f.posts()[0].body;assert.equal(created.action,'create');assert.equal(created.parentId,'a');assert.equal(created.position,1);
 f.$('.todo-edit-form input').value='Review final resume';await f.$('.todo-edit-form').dispatch('submit');await tick();assert.equal(f.posts()[1].body.title,'Review final resume');
 await f.button('Outdent').dispatch('click');await tick();assert.equal(f.posts()[2].body.parentId,null);assert.equal(f.posts()[2].body.position,1);
 const row=f.$('.todo-outline').querySelectorAll('.todo-row').find(n=>n.dataset.id===created.id);const checkbox=row.querySelector('input');checkbox.checked=true;await checkbox.dispatch('change');await tick();assert.equal(f.posts()[3].body.completed,true);
 assert.ok(f.calls.every(c=>c.route.startsWith('/api/todos')));
});
test('delete is explicit and cancellation does not mutate; subtree is named',async t=>{
 const f=setup(t);await tick();await f.button('Career transition').dispatch('click');await f.button('Delete…').dispatch('click');
 assert.equal(f.$('dialog').open,true);assert.match(f.$('dialog').textContent,/all its subtasks/);await f.button('Cancel').dispatch('click');assert.equal(f.posts().length,0);
 await f.button('Delete…').dispatch('click');await f.button('Delete task and subtasks').dispatch('click');await tick();assert.equal(f.posts().length,1);assert.equal(f.posts()[0].body.action,'remove');assert.equal(f.$('.todo-outline').querySelectorAll('.todo-row').length,1);
});
test('uncertain save is never replayed and blocks another mutation until refresh',async t=>{
 const f=setup(t,{fail:true});await tick();f.$('.todo-add input').value='Do not duplicate';await f.$('.todo-add').dispatch('submit');await tick();
 assert.equal(f.posts().length,1);assert.match(f.$('.todo-feedback').textContent,/not replayed/);await f.$('.todo-add').dispatch('submit');await tick();assert.equal(f.posts().length,1);
 await f.button('Refresh').dispatch('click');await tick();assert.equal(f.button('Add task').disabled,false);assert.equal(f.$('.todo-add input').value,'Do not duplicate');
});
test('late read after leaving is ignored',async t=>{
 let resolve;const delay=new Promise(r=>resolve=r);const f=setup(t,{delay});f.ui.leave();resolve({revision:1,items:[]});await tick();assert.equal(f.$('.todo-outline').textContent,'');
});

test('failed refresh preserves the visible failure and selected editor',async t=>{
 const f=setup(t);await tick();await f.button('Career transition').dispatch('click');f.setReadFailure(true);await f.button('Refresh').dispatch('click');await tick();assert.match(f.$('.todo-feedback').textContent,/Read failed/);assert.equal(f.$('.todo-editor').hidden,false);
});

test('unrelated successful mutation cannot bless an editor made stale by external updates',async t=>{
 const f=setup(t);await tick();await f.button('Career transition').dispatch('click');f.$('.todo-edit-form input').value='Stale edit';f.externalTitle('New owner title');await tick();
 const checkbox=f.$('.todo-outline').querySelectorAll('.todo-row').find(n=>n.dataset.id==='c').querySelector('input');checkbox.checked=true;await checkbox.dispatch('change');await tick();
 await f.$('.todo-edit-form').dispatch('submit');await tick();assert.equal(f.posts()[1].body.expectedRevision,1);assert.match(f.$('.todo-feedback').textContent,/Revision changed/);assert.ok(f.button('New owner title'));
});
