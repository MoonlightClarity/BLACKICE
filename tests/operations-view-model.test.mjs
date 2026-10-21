import test from 'node:test';
import assert from 'node:assert/strict';
import {operationsViewModel,operationJobGroup,operationJobLabel,operationAttemptPhases} from '../public/operations-view-model.mjs';

const job=(id,status,extra={})=>({id,status,deploymentId:'schedule',attempts:[],...extra});
test('attention filtering searches the complete receipt history before paging',()=>{
 const jobs=[...Array.from({length:90},(_,i)=>job(String(i),'completed')),job('older-failure','failed'),job('held','interrupted',{retryHold:{runId:'original'}})];
 const result=operationsViewModel({jobs,deployments:[],status:{}},{filter:'attention'});
 assert.deepEqual(result.jobs.map(job=>job.id),['older-failure','held']);assert.equal(result.counts.completed,90);assert.equal(result.counts.attention,2);assert.equal(result.retryHeld,1);assert.equal(result.total,2);
});
test('paging includes all saved matches and scope counts reflect the selected schedule',()=>{
 const jobs=Array.from({length:100},(_,i)=>job(String(i),i%2?'queued':'running',{deploymentId:i<80?'a':'b'})),snapshot={jobs};
 const result=operationsViewModel(snapshot,{deploymentId:'a',filter:'active',limit:10});assert.equal(result.total,40);assert.equal(result.jobs.length,10);assert.equal(result.hasMore,true);assert.deepEqual(result.counts,{all:80,active:40,waiting:40,completed:0,attention:0});
 const all=operationsViewModel(snapshot,{deploymentId:'a',filter:'active',limit:80});assert.equal(all.jobs.length,40);assert.equal(all.hasMore,false);assert.deepEqual(operationsViewModel(snapshot,{deploymentId:'removed'}).jobs,[]);
});
test('operational health never says Ready while paused, inbox blocked, or unhealthy',()=>{
 for(const status of [{paused:true},{blockedReason:'Inbox paused'}])assert.equal(operationsViewModel({status}).label,'Paused');
 for(const status of [{healthy:false},{error:'Cannot persist receipt',paused:true}])assert.equal(operationsViewModel({status}).label,'Needs attention');
 assert.equal(operationsViewModel({status:{paused:false,healthy:true}}).label,'Ready');
});
test('upcoming plans omit disabled, exhausted, erroneous and nonfinite schedules and keep earliest first',()=>{
 const deployments=[{id:'later',enabled:true,nextAt:30},{id:'bad',enabled:true,nextAt:2,scheduleError:'Invalid calendar'},{id:'off',enabled:false,nextAt:1},{id:'done',enabled:true,nextAt:3,limitStatus:{reached:true}},{id:'invalid',enabled:true,nextAt:NaN},{id:'first',enabled:true,nextAt:10}];
 assert.deepEqual(operationsViewModel({deployments,status:{paused:true}}).upcoming.map(item=>item.id),['first','later']);assert.equal(deployments[0].id,'later');
});
test('job labels distinguish working, delayed retry, interrupted and receipt-held outcomes',()=>{
 assert.equal(operationJobGroup(job('d','dispatching')),'active');assert.equal(operationJobGroup(job('r','retry_wait')),'waiting');assert.equal(operationJobGroup(job('i','interrupted')),'attention');assert.equal(operationJobLabel(job('r','retry_wait')),'Waiting to retry');assert.equal(operationJobLabel(job('h','failed',{retryHold:{}})),'Inspect original run');assert.equal(operationJobLabel(job('future','unknown')),'Unknown state');
});
test('an external-action ledger retained on a working or completed job never makes it a failed recovery task',()=>{
 const held={retryHold:{runId:'original',receipts:[{id:'post',status:'confirmed'}]}},jobs=[job('starting','dispatching',held),job('working','running',held),job('done','completed',held),job('failed','failed',held)],snapshot={jobs};
 assert.deepEqual(jobs.map(operationJobGroup),['active','active','completed','attention']);assert.deepEqual(jobs.map(operationJobLabel),['Starting','Working','Completed','Inspect original run']);
 const model=operationsViewModel(snapshot);assert.equal(model.counts.active,2);assert.equal(model.counts.completed,1);assert.equal(model.counts.attention,1);assert.equal(model.retryHeld,1);assert.deepEqual(operationsViewModel(snapshot,{filter:'attention'}).jobs.map(item=>item.id),['failed']);
});
test('attempt timeline records only observed phases and distinguishes failure from completion',()=>{
 const queued=operationAttemptPhases({createdAt:'2026-10-17T12:00:00Z',status:'queued'});assert.equal(queued.length,2);assert.equal(queued[1].state,'pending');assert.equal(queued[1].at,null);
 const failed=operationAttemptPhases({createdAt:'a',startedAt:'b',finishedAt:'c',status:'failed',runId:'actual'});assert.deepEqual(failed.map(item=>item.state),['recorded','recorded','attention']);assert.equal(failed[2].label,'Failed');
 const complete=operationAttemptPhases({runId:'actual',status:'completed',finishedAt:'d'});assert.equal(complete[2].state,'complete');assert.equal(complete[0].state,'unknown');
});


test('a removed schedule waiting on a live original lease never promises another retry',()=>{
 const stopped={status:'retry_wait',retryStoppedReason:'The deployment was removed. No further retry attempts will start.'};
 assert.equal(operationJobLabel(stopped),'Waiting for original attempt');assert.equal(operationJobGroup(stopped),'waiting');
 assert.equal(operationJobLabel({...stopped,status:'failed'}),'Failed');
});
