import test from 'node:test';
import assert from 'node:assert/strict';
import {searchTaskFailures} from '../lib/run-activity-view.mjs';
import {handleConversationActivityHttp} from '../lib/conversation-activity-http.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createActivityInspector} from '../public/next/chat/activity-inspector.mjs';

const run=(id,when,tool,code)=>({
 id,taskId:'task',updatedAt:when,events:[],nodes:{agent:{}},
 toolFailureHistory:{version:1,total:1,omitted:0,receipts:[
  {sequence:1,at:when,nodeId:'agent',tool,action:tool==='relay_workspace'?'run_js':'click',code,recovered:false,operationKey:'PRIVATE-HASH'}
 ]}
});
const first=run('turn-1','2026-11-26T15:30:00.000Z','relay_browser','BROWSER_REF_STALE');
const second=run('turn-2','2026-11-26T15:31:00.000Z','relay_workspace','WORKSPACE_COMMAND_EXIT_NONZERO');
const family={rootId:'task',runs:[first,second,{...first,id:'foreign',taskId:'other'}]};
test('task-wide search spans multiple archived turns, remains scoped and retains chronological sorting',()=>{
 const page=searchTaskFailures(family,{view:'failures',runId:'turn-2',limit:1});
 assert.equal(page.totalMatches,2);
 assert.equal(page.items[0].runId,'turn-2');
 assert.equal(page.nextOffset,1);
 assert.equal(page.scope,'task');
 assert.equal(page.coverage.recordedFailures,2);
 assert.equal(searchTaskFailures(family,{view:'failures',q:'BROWSER_REF_STALE'}).items[0].runId,'turn-1');
 assert.equal(searchTaskFailures(family,{view:'failures',q:'WORKSPACE_COMMAND_EXIT_NONZERO'}).items[0].runId,'turn-2');
 assert.equal(searchTaskFailures(family,{view:'failures',q:'PRIVATE-HASH'}).totalMatches,0);
 const older=searchTaskFailures(family,{view:'failures',runId:'turn-2',offset:1,limit:1,revision:page.revision});
 assert.equal(older.items[0].runId,'turn-1');
 assert.equal(older.nextOffset,null);
 const changed={...family,runs:[first,{...second,updatedAt:'2026-11-26T15:33:00.000Z'}]};
 assert.throws(()=>searchTaskFailures(changed,{view:'failures',revision:page.revision}),{code:'ACTIVITY_CHANGED'});
 assert.ok(!JSON.stringify(page).includes('PRIVATE-HASH'));
});
test('activity route scopes task-wide receipt search to authenticated selected conversation',async()=>{
 const responses=[],calls=[],conversations={
  get:async id=>{calls.push(['get',id]);return id==='turn-2'?second:first;},
  family:async id=>{calls.push(['family',id]);return family;}
 };
 const json=(_res,status,value)=>responses.push({status,value});
 const request=async url=>handleConversationActivityHttp({req:{method:'GET',url,headers:{}},res:{},pathname:'/api/conversations/turn-2/activity',conversations,json});
 await request('/api/conversations/turn-2/activity?view=failures&scope=task&q=BROWSER_REF_STALE');
 assert.equal(responses[0].status,200);
 assert.equal(responses[0].value.totalMatches,1);
 assert.equal(responses[0].value.items[0].runId,'turn-1');
 assert.ok(calls.some(row=>row[0]==='family'));
 await assert.rejects(request('/api/conversations/turn-2/activity?view=tools&scope=task'),{status:400});
 await assert.rejects(request('/api/conversations/turn-2/activity?view=failures&scope=task&scope=turn'),{status:400});
 const foreign={...family,runs:[first]};
 const denied={...conversations,family:async()=>foreign};
 await assert.rejects(handleConversationActivityHttp({req:{method:'GET',url:'/api/conversations/turn-2/activity?view=failures&scope=task',headers:{}},res:{},pathname:'/api/conversations/turn-2/activity',conversations:denied,json}),{status:404});
});
test('primary Receipts UI automatically searches all turns when Tool failures selected',async t=>{
 const d=planningDOM(t),head=d.element('div');head.className='next-chat-head-actions';d.mount.append(head);const calls=[];
 const inspector=createActivityInspector({frame:d.mount,getRunId:()=> 'turn-2',events:{subscribe(){return()=>{}}},api:async route=>{
  calls.push(route);const url=new URL(route,'http://fixture');
  if(url.searchParams.get('scope')==='task')return searchTaskFailures(family,{runId:'turn-2',q:url.searchParams.get('q')||''});
  return {revision:'r',view:url.searchParams.get('view')||'updates',items:[],nextOffset:null,coverage:{}};
 }});
 t.after(()=>inspector.destroy());
 await inspector.open();
 const select=d.$('.next-activity-view');
 select.value='failures';await select.dispatch('change');
 await new Promise(resolve=>setImmediate(resolve));
 const url=new URL(calls.at(-1),'http://fixture');
 assert.equal(url.searchParams.get('view'),'failures');
 assert.equal(url.searchParams.get('scope'),'task');
 assert.match(d.mount.textContent,/BROWSER_REF_STALE/);
 assert.match(d.mount.textContent,/WORKSPACE_COMMAND_EXIT_NONZERO/);
 assert.match(d.mount.textContent,/across this conversation/);
});
