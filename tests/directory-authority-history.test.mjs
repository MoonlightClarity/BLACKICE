import test from 'node:test';
import assert from 'node:assert/strict';
import {directoryUserHistoryFor} from '../lib/shadowdancer-engine.mjs';

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
