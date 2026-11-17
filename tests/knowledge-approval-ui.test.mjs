
import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createKnowledgeApprovals} from '../public/next/core/knowledge-approvals.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const proposal=(id='one')=>({id,status:'pending',operation:'upsert',kind:'memory',title:'A task note <script>',cwd:'C:/task-a',before:null,after:{title:'Note',content:'Keep <script> literal',cwd:'C:/task-a',sources:['evidence']},provenance:{runId:'run-one'}});
function setup(t,{post,first}={}){
 const dom=planningDOM(t),calls=[],listeners=new Set();let entries=first||[proposal()];
 const api=async(route,method='GET',body)=>{
  calls.push({route,method,body});
  if(method==='GET')return {approvals:structuredClone(entries)};
  if(post)return post(route,body);
  const id=route.split('/').at(-1);entries=entries.filter(item=>item.id!==id);
  return{id,status:body.decision==='approve'?'approved':'rejected'};
 };
 const ui=createKnowledgeApprovals({mount:dom.mount,api,events:{subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}},pollMs:0});
 t.after(()=>ui.destroy());
 const action=text=>[...dom.mount.querySelectorAll('button')].find(node=>node.textContent===text);
 return{...dom,ui,calls,listeners,action,set(value){entries=value;},posts:()=>calls.filter(item=>item.method==='POST')};
}
test('initial pending prompt displays exact scope and literal content; Not now and Escape never approve',async t=>{
 const f=setup(t);await tick();assert.equal(f.$('dialog').open,true);
 assert.match(f.$('.next-approval-detail').textContent,/C:\/task-a/);assert.match(f.$('.next-approval-content').textContent,/<script>/);
 assert.equal(f.$('script'),null);assert.equal(f.posts().length,0);
 await f.action('Not now').dispatch('click');assert.equal(f.$('dialog').open,false);
 await f.ui.refresh();assert.equal(f.$('dialog').open,false,'dismissed proposal does not nag');
 await f.$('.next-approval-trigger').dispatch('click');assert.equal(f.$('dialog').open,true);
 await f.$('dialog').dispatch('cancel');assert.equal(f.$('dialog').open,false);assert.equal(f.posts().length,0);
});
test('approve exact selected proposal once; repeated clicks and dismissal while pending cannot duplicate',async t=>{
 let resolve;const gate=new Promise(done=>resolve=done);
 const f=setup(t,{first:[proposal(),proposal('two')],post:async()=>{await gate;f.set([proposal('two')]);return{id:'one',status:'approved'};}});
 await tick();await f.action('Approve this change').dispatch('click');await f.action('Approve this change').dispatch('click');await f.action('Not now').dispatch('click');
 assert.equal(f.posts().length,1);assert.deepEqual(f.posts()[0].body,{decision:'approve'});assert.match(f.posts()[0].route,/\/one$/);assert.equal(f.$('dialog').open,true);
 resolve();await tick();await tick();assert.equal(f.action('Approve this change').disabled,true,'next proposal must be explicitly selected');
 await f.$('[data-approval-id="two"]').dispatch('click');assert.equal(f.action('Approve this change').disabled,false);
});
test('reject does not submit content or approval and disappearance on refresh clears selection',async t=>{
 const f=setup(t);await tick();await f.action('Reject change').dispatch('click');await tick();
 assert.deepEqual(f.posts().map(call=>call.body),[{decision:'reject'}]);assert.equal(f.action('Approve this change').disabled,true);
 f.set([proposal('new')]);await f.ui.refresh();await f.$('[data-approval-id="new"]').dispatch('click');
 f.set([]);await f.ui.refresh();assert.equal(f.action('Approve this change').disabled,true);
});
test('uncertain or failed mutation is not replayed and refresh reconciles external decision',async t=>{
 const f=setup(t,{post:async()=>{f.set([]);throw Error('Connection lost');}});await tick();
 await f.action('Approve this change').dispatch('click');await tick();await tick();
 assert.equal(f.posts().length,1);assert.equal(f.action('Approve this change').disabled,true);
 assert.match(f.$('.next-approval-status').textContent,/no longer pending|not confirmed/);
 for(const fn of f.listeners)fn({type:'knowledge.updated'});await tick();assert.equal(f.posts().length,1);
});
test('late reads and events after destroy never reopen prompt',async t=>{
 const f=setup(t);f.ui.destroy();await tick();assert.equal(f.$('dialog'),null);assert.equal(f.listeners.size,0);
});
