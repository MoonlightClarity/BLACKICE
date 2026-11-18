import test from 'node:test';import assert from 'node:assert/strict';import {planningDOM} from './fixture-planning-dom.mjs';import{createPlanningWorkspace}from'../public/next/workspaces/planning-current.mjs';
const until=async f=>{for(let i=0;i<100;i++){if(f())return;await new Promise(r=>setTimeout(r,5));}throw Error('Planning did not settle');};
async function fixture(t,{hook}={}){
 const dom=planningDOM(t),calls=[],navigation=[],historyCalls=[];let subscriptions=0;
 const rows=[{id:'a',rootId:'a',latestRunId:'run-a',title:'Alpha',status:'completed',settled:true,state:'active'},{id:'b',rootId:'b',latestRunId:'run-b',title:'Beta',status:'running',settled:false,state:'active'}];
 const api=async(route,method='GET',body)=>{calls.push({route,method,body});const replacement=hook?.(route);if(replacement!==undefined)return replacement;
  if(route.startsWith('/api/conversations?'))return rows;
  if(route.endsWith('/goal'))return {goal:{id:'goal',revision:1,status:'active',objective:route.includes('/a/')?'Alpha objective':'Beta objective',running:route.includes('/b/'),runStatus:route.includes('/b/')?'running':null,turns:1,maxTurns:null}};
  if(route.includes('/activity?'))return{revision:'one',nextOffset:null,coverage:{scope:'Retained run events',retainedEvents:1},items:[{id:'event',title:'Saved update',text:'Actual retained update',source:'run event'}]};
  throw Error('Unexpected '+route);
 };
 const workspace=createPlanningWorkspace({mount:dom.mount,api,events:{subscribe(){subscriptions++;return()=>subscriptions--;}},onNavigate:(...args)=>navigation.push(args),loadHistoryWorkspace:async()=>()=>({enter(){historyCalls.push('enter');},leave(){},destroy(){},openRequestId(id){historyCalls.push(id);},openConversationId(id){historyCalls.push(id);}})});
 t.after(()=>workspace.destroy());workspace.enter();await until(()=>dom.mount.textContent.includes('Beta objective'));
 return{...dom,workspace,calls,navigation,historyCalls,get subscriptions(){return subscriptions;}};
}
test('current Planning reads goals and selected retained Activity without Directory requests or automatic work',async t=>{
 const f=await fixture(t);assert.equal(f.$('.next-directory-open'),null);assert.ok(!f.calls.some(x=>x.route.includes('/activity')));
 await f.workspace.openConversationId('a');await until(()=>f.mount.textContent.includes('Alpha objective'));await f.click('.next-activity-open');await until(()=>f.mount.textContent.includes('Actual retained update'));
 assert.ok(f.calls.some(x=>x.route.startsWith('/api/conversations/run-a/activity?')));assert.ok(f.calls.every(x=>!x.route.includes('shadowdancer')&&x.method==='GET'));
});
test('saved graph view remains lazy and exact request navigation survives',async t=>{
 const f=await fixture(t);assert.deepEqual(f.historyCalls,[]);await f.workspace.openRequestId('request-exact');assert.ok(f.historyCalls.includes('request-exact'));
});
test('running filter uses observed run state and goal failures remain recoverable',async t=>{
 let fail=false;const f=await fixture(t,{hook:route=>fail&&route.endsWith('/a/goal')?Promise.reject(Error('Read unavailable')):undefined});
 f.$('#pc-conversation-view').value='running';await f.$('#pc-conversation-view').dispatch('change');assert.equal(f.mount.querySelectorAll('[data-conversation-id]').length,1);
 fail=true;await f.workspace.openConversationId('a');await until(()=>f.mount.textContent.includes('Read unavailable'));assert.ok(f.mount.textContent.includes('Goal unavailable'));fail=false;await f.workspace.refresh();await until(()=>f.mount.textContent.includes('Alpha objective'));
});
test('late goal results cannot overwrite a different selection and leave releases subscriptions',async t=>{
 let resolve,block=false;const pending=new Promise(r=>resolve=r);const f=await fixture(t,{hook:route=>block&&route.endsWith('/a/goal')?pending:undefined});
 block=true;const first=f.workspace.openConversationId('a');await f.workspace.openConversationId('b');resolve({goal:{objective:'STALE',status:'active'}});await first;assert.ok(!f.mount.textContent.includes('STALE'));assert.ok(f.mount.textContent.includes('Beta objective'));f.workspace.leave();assert.equal(f.subscriptions,1);f.workspace.destroy();assert.equal(f.subscriptions,0);
});
