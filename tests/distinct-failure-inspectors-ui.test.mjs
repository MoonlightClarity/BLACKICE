import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createActivityInspector} from '../public/next/chat/activity-inspector.mjs';
import {createTurnReceiptsInspector} from '../public/next/chat/turn-receipts-inspector.mjs';
import {projectTurnReceipts} from '../lib/turn-receipts.mjs';
import {searchTaskFailures} from '../lib/run-activity-view.mjs';
import {retainToolFailureHistory} from '../public/next/chat/tool-failure.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 let history;
 for(let n=1;n<=5;n++)history=retainToolFailureHistory(history,{
  at:new Date(Date.UTC(2026,10,26,15,30,n)).toISOString(),nodeId:'agent',runId:'turn-1',
  data:{type:'tool.result',tool:'relay_browser',action:'click',code:n<5?'BROWSER_REF_STALE':'BROWSER_CAPTURE_TIMEOUT',success:false,callId:'call-'+n}
 });
 return{id:'turn-1',taskId:'task',updatedAt:'2026-11-26T15:40:00.000Z',nodes:{agent:{}},events:[],toolFailureHistory:history};
}
test('primary Receipts switches between distinct categories and exact original occurrences',async t=>{
 const d=planningDOM(t),head=d.element('div');head.className='next-chat-head-actions';d.mount.append(head);
 const f=fixture(),family={rootId:'task',runs:[f]},urls=[];
 const inspector=createActivityInspector({frame:d.mount,getRunId:()=>f.id,
  api:async route=>{const u=new URL(route,'http://localhost');urls.push(u);return searchTaskFailures(family,{
   view:u.searchParams.get('view'),q:u.searchParams.get('q')||'',offset:Number(u.searchParams.get('offset')||0),
   distinct:u.searchParams.get('distinct')==='1',group:u.searchParams.get('group')||null
  });},events:{subscribe(){return()=>{}}}});
 t.after(()=>inspector.destroy());
 await inspector.open();
 const view=d.$('.next-activity-view');view.value='failures';await view.dispatch('change');await tick();
 assert.equal(urls.at(-1).searchParams.get('scope'),'task');
 assert.equal(urls.at(-1).searchParams.get('distinct'),'1');
 assert.equal(d.$('.next-activity-distinct-toggle').checked,true);
 assert.match(d.$('.next-activity-status').textContent,/2 distinct categories/);
 assert.equal(d.mount.querySelectorAll('.next-activity-results li').length,2);
 await d.click('.next-activity-show-occurrences');await tick();
 assert.match(urls.at(-1).searchParams.get('group'),/^fg-[a-f0-9]{64}$/);
 assert.equal(urls.at(-1).searchParams.has('distinct'),false);
 assert.match(d.$('.next-activity-status').textContent,/retained occurrences/);
 await d.click('.next-activity-back-groups');await tick();
 assert.equal(urls.at(-1).searchParams.get('distinct'),'1');
 d.$('.next-activity-distinct-toggle').checked=false;
 await d.$('.next-activity-distinct-toggle').dispatch('change');await tick();
 assert.equal(urls.at(-1).searchParams.has('distinct'),false);
 assert.equal(urls.at(-1).searchParams.has('group'),false);
 assert.equal(d.mount.querySelectorAll('.next-activity-results li').length,5);
});
test('Turn receipts offers distinct categories and an exact individual-drilldown',async t=>{
 const d=planningDOM(t),f=fixture(),urls=[];
 const inspector=createTurnReceiptsInspector({frame:d.mount,getRuns:()=>[f],
   api:async route=>{const u=new URL(route,'http://localhost');urls.push(u);return projectTurnReceipts(f,{
    view:u.searchParams.get('view')||'context',q:u.searchParams.get('q')||'',
    offset:Number(u.searchParams.get('offset')||0),distinct:u.searchParams.get('distinct')==='1',
    group:u.searchParams.get('group')||null
   });}});
 t.after(()=>inspector.destroy());
 await inspector.open();
 const category=Array.from(d.mount.querySelectorAll('select')).find(e=>e.getAttribute('aria-label')==='Receipt category');
 category.value='failures';await category.dispatch('change');await tick();
 assert.equal(urls.at(-1).searchParams.get('distinct'),'1');
 assert.equal(d.mount.querySelectorAll('details').length>=4,true);
 const inspect=Array.from(d.mount.querySelectorAll('button')).find(b=>b.textContent.startsWith('Inspect '));
 assert.ok(inspect);
 await inspect.dispatch('click');await tick();
 assert.match(urls.at(-1).searchParams.get('group'),/^fg-[a-f0-9]{64}$/);
 const back=Array.from(d.mount.querySelectorAll('button')).find(b=>b.textContent==='Back to distinct failures');
 await back.dispatch('click');await tick();
 assert.equal(urls.at(-1).searchParams.get('distinct'),'1');
});
