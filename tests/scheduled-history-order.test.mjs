import test from 'node:test';
import assert from 'node:assert/strict';
import {newestJobs,newestResults,jobLastRunAt} from '../public/scheduled-history-order.mjs';
import {resultInbox} from '../lib/operation-result-inbox.mjs';
import {scheduleJobs} from '../public/next/workspaces/schedule-inspection-model.mjs';
test('job presentation uses latest actual attempt, date offsets and stable missing dates without mutation',()=>{
 const rows=[{id:'missing',deploymentId:'d'},{id:'old',deploymentId:'d',createdAt:'2026-11-01T12:00:00Z',attempts:[{startedAt:'2026-11-03T09:00:00-05:00'}]},{id:'new',deploymentId:'d',createdAt:'2026-11-02T12:00:00Z'},{id:'invalid',createdAt:'bad'}],before=structuredClone(rows);
 assert.deepEqual(newestJobs(rows).map(x=>x.id),['old','new','missing','invalid']);
 assert.equal(jobLastRunAt(rows[1]),Date.parse('2026-11-03T14:00:00Z'));
 assert.deepEqual(scheduleJobs({jobs:rows},'d',1).jobs.map(x=>x.id),['old']);assert.deepEqual(rows,before);
});
test('results order by availability before pagination, never acknowledgement date or review state',()=>{
 const rows=[{id:'old-unread',createdAt:'2026-11-01',delivery:{destination:'local-inbox',state:'available',availableAt:'2026-11-02'}},{id:'new-reviewed',createdAt:'2026-10-01',delivery:{destination:'local-inbox',state:'acknowledged',availableAt:'2026-11-04',acknowledgedAt:'2026-11-10'}},{id:'middle',delivery:{destination:'local-inbox',state:'available',availableAt:'2026-11-03'}}],before=structuredClone(rows);
 assert.deepEqual(newestResults(rows).map(x=>x.id),['new-reviewed','middle','old-unread']);
 const result=resultInbox(rows,{includeAcknowledged:true,limit:2});
 assert.deepEqual(result.items.map(x=>x.id),['new-reviewed','middle']);assert.equal(result.available,2);assert.equal(result.acknowledged,1);assert.deepEqual(rows,before);
});

test('operations snapshot sorts presentation without changing dispatch state or receipt contents',async()=>{
 const {OperationsStore}=await import('../lib/operations.mjs');
 const jobs=[{id:'older',createdAt:'2026-11-01'},{id:'newer',createdAt:'2026-11-02'}],before=structuredClone(jobs);
 const receiver={state:{organization:undefined,settings:{},jobs},status:()=>({}),list:()=>[],removedDeployments:()=>[],publicJob:value=>value};
 const view=OperationsStore.prototype.snapshot.call(receiver);
 assert.deepEqual(view.jobs.map(x=>x.id),['newer','older']);assert.deepEqual(jobs,before);
 view.jobs[0].createdAt='changed';assert.deepEqual(jobs,before);
});

test('cron schedules sort by actual due time with undated last and stable IDs without mutation',async()=>{
 const {chronologicalSchedules}=await import('../public/scheduled-history-order.mjs');
 const rows=[{id:'webhook',nextAt:null},{id:'later',enabled:true,nextAt:2000},{id:'b',nextAt:1000},{id:'a',nextAt:1000},{id:'disabled',enabled:false,nextAt:1},{id:'overdue',enabled:true,overdue:true,overdueSince:'1970-01-01T00:00:00.500Z',nextAt:500},{id:'invalid',nextAt:'bad'}];
 const before=structuredClone(rows),expected=['overdue','a','b','later','disabled','invalid','webhook'];
 assert.deepEqual(chronologicalSchedules(rows).map(x=>x.id),expected);
 assert.deepEqual(chronologicalSchedules([...rows].reverse()).map(x=>x.id),expected);assert.deepEqual(rows,before);
});
