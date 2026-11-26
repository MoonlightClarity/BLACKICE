import test from 'node:test';
import assert from 'node:assert/strict';
import {projectTurnReceipts} from '../lib/turn-receipts.mjs';
import {searchRunActivity} from '../lib/run-activity-view.mjs';
import {projectToolFailureHistory} from '../public/next/chat/tool-failure.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createActivityInspector} from '../public/next/chat/activity-inspector.mjs';

function fixture(){
 return {
  id:'turn-1',taskId:'task-1',updatedAt:'2026-11-26T15:40:00.000Z',
  directoryDiagnostics:'off',nodes:{agent:{}},events:[],eventRetention:{omittedEvents:129},
  toolFailureHistory:{version:1,total:5,omitted:2,receipts:[
   {sequence:3,at:'2026-11-26T15:34:10.000Z',nodeId:'agent',tool:'relay_workspace',action:'run_js',code:'WORKSPACE_COMMAND_EXIT_NONZERO',exitCode:1,recovered:false,operationKey:'a'.repeat(64),message:'DO-NOT-LEAK private'},
   {sequence:4,at:'2026-11-26T15:34:20.000Z',nodeId:'agent',tool:'relay_browser',action:'click',code:'BROWSER_REF_STALE',actionDispatched:false,recovered:true,operationKey:'b'.repeat(64)},
   {sequence:5,at:'2026-11-26T15:34:30.000Z',nodeId:'agent',tool:'relay_browser',action:'open',code:'BROWSER_TASK_TAB_LIMIT',actionDispatched:false,recovered:false,operationKey:'c'.repeat(64)}
  ]}
 };
}
test('Turn Receipts searches individual saved failures after events are pruned',()=>{
 const run=fixture();
 const result=projectTurnReceipts(run,{view:'failures'});
 assert.equal(result.actions.length,3);
 assert.equal(result.coverage.failureTotal,5);
 assert.equal(result.coverage.omittedFailures,2);
 assert.deepEqual(result.actions.map(x=>x.code),['WORKSPACE_COMMAND_EXIT_NONZERO','BROWSER_REF_STALE','BROWSER_TASK_TAB_LIMIT']);
 assert.equal(result.actions[1].recovered,true);
 assert.equal(result.actions[1].actionDispatched,false);
 assert.equal(result.actions[0].exitCode,1);
 assert.equal(projectTurnReceipts(run,{view:'failures',q:'BROWSER_REF_STALE'}).actions.length,1);
 assert.equal(projectTurnReceipts(run,{view:'failures',q:'workspace'}).actions.length,1);
 assert.equal(projectTurnReceipts(run,{view:'failures',q:'tab_limit'}).actions.length,1);
 assert.equal(projectTurnReceipts(run,{view:'failures',q:'DO-NOT-LEAK'}).actions.length,0);
 const page=projectTurnReceipts(run,{view:'failures',limit:1});
 assert.equal(page.nextOffset,1);
 assert.equal(projectTurnReceipts(run,{view:'failures',offset:1,limit:1,revision:page.revision}).actions[0].code,'BROWSER_REF_STALE');
 assert.throws(()=>projectTurnReceipts({...run,updatedAt:'2026-11-26T15:41:00.000Z'},{view:'failures',revision:page.revision}),{code:'TURN_RECEIPTS_CHANGED'});
 assert.ok(!JSON.stringify(result).includes('DO-NOT-LEAK'));
 assert.ok(!JSON.stringify(result).includes('aaaaaaaaaaaaaaaa'));
});
test('the primary Receipts activity view exposes and searches retained failures independently of Action Outline',()=>{
 const run=fixture();
 const page=searchRunActivity(run,{view:'failures',limit:2});
 assert.equal(page.items.length,2);
 assert.equal(page.nextOffset,2);
 assert.match(page.coverage.scope,/saved tool failures/);
 assert.equal(page.coverage.recordedFailures,5);
 assert.equal(page.coverage.omittedFailures,2);
 assert.equal(page.items[0].id,'failure:5');
 assert.match(page.items[0].text,/BROWSER_TASK_TAB_LIMIT/);
 assert.match(page.items[1].text,/recovered/);
 assert.equal(searchRunActivity(run,{view:'failures',q:'BROWSER_REF_STALE'}).totalMatches,1);
 assert.equal(searchRunActivity(run,{view:'failures',q:'run_js'}).items[0].title,'relay_workspace / run_js');
 assert.equal(searchRunActivity(run,{view:'failures',q:'DO-NOT-LEAK'}).totalMatches,0);
 const second=searchRunActivity(run,{view:'failures',limit:2,offset:2,revision:page.revision});
 assert.equal(second.items[0].id,'failure:3');
 assert.equal(second.nextOffset,null);
 assert.ok(!JSON.stringify(page).includes('DO-NOT-LEAK'));
});
test('receipt failure search rejects unknown/foreign node records and never duplicates archived tool events',()=>{
 const run=fixture();
 run.events=[{runId:run.id,nodeId:'agent',at:'2026-11-26T15:34:20.000Z',data:{type:'tool.result',success:false,tool:'relay_browser',action:'click',code:'BROWSER_REF_STALE',message:'PRIVATE VALUE'}}];
 run.toolFailureHistory.receipts.push({sequence:6,at:'2026-11-26T15:34:40.000Z',nodeId:'foreign',tool:'relay_workspace',action:'run',code:'WORKSPACE_ERROR',recovered:false});
 assert.equal(projectTurnReceipts(run,{view:'failures'}).actions.length,3);
 assert.equal(searchRunActivity(run,{view:'failures'}).totalMatches,4,'activity retains safe source metadata, no private raw message');
 assert.equal(projectTurnReceipts(run,{view:'tools'}).actions.length,1);
 assert.ok(!JSON.stringify(projectTurnReceipts(run,{view:'failures'})).includes('PRIVATE VALUE'));
});
test('human Receipts UI includes Tool failures category and supports its searchable view',async t=>{
 const d=planningDOM(t),head=d.element('div');head.className='next-chat-head-actions';d.mount.append(head);
 const calls=[];
 const inspector=createActivityInspector({frame:d.mount,getRunId:()=> 'turn-1',events:{subscribe(){return()=>{}}},api:async route=>{
  const url=new URL(route,'http://fixture');calls.push(url.searchParams.get('view'));
  return searchRunActivity(fixture(),{view:url.searchParams.get('view')||'updates',q:url.searchParams.get('q')||''});
 }});
 t.after(()=>inspector.destroy());
 await inspector.open();
 const select=d.$('.next-activity-view');
 assert.ok(Array.from(select.children).some(x=>x.value==='failures'&&x.textContent==='Tool failures'));
 select.value='failures';
 await select.dispatch('change');
 await new Promise(r=>setImmediate(r));
 assert.equal(calls.at(-1),'failures');
 assert.match(d.mount.textContent,/BROWSER_TASK_TAB_LIMIT/);
});
