import test from 'node:test';
import assert from 'node:assert/strict';
import {directoryUserHistoryFor} from '../lib/shadowdancer-engine.mjs';

test('Directory goal continuations preserve human authority without treating host prompts as user requests',()=>{
 const root={id:'root',taskId:'root',createdAt:'2026-11-12T00:00:00Z',input:'Build the requested result.',events:[]};
 const automatic={id:'auto',taskId:'root',parentRunId:'root',createdAt:'2026-11-12T00:01:00Z',input:'HOST: Continue the goal.',goal:{automatic:true},events:[
   {at:'2026-11-12T00:01:30Z',data:{type:'steer',accepted:true,text:'Also include the user-requested verification.'}},
   {at:'2026-11-12T00:01:40Z',data:{type:'steer',accepted:false,text:'This direction was rejected.'}},
 ]};
 const pending={id:'pending-auto',taskId:'root',parentRunId:'auto',createdAt:'2026-11-12T00:02:00Z',input:'HOST: Resume the goal.',goalDispatch:{goalId:'goal-1'},events:[]};
 const human={id:'human',taskId:'root',parentRunId:'pending-auto',createdAt:'2026-11-12T00:03:00Z',input:'Use the revised acceptance criteria.',goal:{automatic:false},events:[]};
 const rows=directoryUserHistoryFor(human,[root,automatic,pending,human]);
 assert.deepEqual(rows.map(row=>row.text),[root.input,automatic.events[0].data.text,human.input]);
 assert.equal(rows.filter(row=>row.runId==='auto').length,1);
 assert.equal(rows.find(row=>row.runId==='auto').messageIndex,0);
 assert.ok(rows.every(row=>row.source==='user-request'));
});


test('Directory preserves complete same-conversation authority beyond the old 64K character cutoff',()=>{
 const family=Array.from({length:12},(_,index)=>({
   id:'own-'+index,taskId:'own-0',...(index?{parentRunId:'own-'+(index-1)}:{}),
   createdAt:new Date(index*1000).toISOString(),input:'DIRECTION-'+index+': '+'exact user context '.repeat(500),events:[],
 }));
 const foreign={id:'foreign',taskId:'foreign',input:'ANOTHER_CONVERSATION',events:[]};
 const rows=directoryUserHistoryFor(family.at(-1),[...family,foreign]);
 assert.ok(JSON.stringify(rows).length>64000);
 assert.equal(rows.length,family.length);
 assert.deepEqual(rows.map(row=>row.text),family.map(run=>run.input));
 assert.ok(rows.every(row=>row.runId.startsWith('own-')));
});

test('missing or foreign authority reports the actual missing history without proposing Directory Off',()=>{
 const foreign={id:'foreign',taskId:'foreign',input:'Other context',events:[]};
 const current={id:'current',taskId:'own-root',parentRunId:'foreign',input:'Current context',events:[]};
 for(const value of [current,{...current,parentRunId:undefined}]){
   assert.throws(()=>directoryUserHistoryFor(value,[foreign]),error=>{
     assert.equal(error.code,'DIRECTORY_HISTORY_UNAVAILABLE');
     assert.match(error.message,/parent|history/);assert.doesNotMatch(error.message,/Directory Off/);
     return true;
   });
 }
});
