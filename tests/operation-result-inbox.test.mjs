import test from 'node:test';
import assert from 'node:assert/strict';
import {newPendingResult,publishLocalResult,acknowledgeLocalResult,resultInbox,validLocalResultReceipt,RESULT_PREVIEW_CHARS} from '../lib/operation-result-inbox.mjs';

const job=(status='completed')=>({
 id:'job-1',deploymentId:'schedule-1',deploymentName:'Daily research',status,
 attempts:[{inboxId:'inbox-1',runId:'run-1',status}],
 delivery:newPendingResult('job-1',1000),
 error:status==='failed'?'Could not verify the report':null,
 createdAt:new Date(1000).toISOString(),
});
const run=(output='A concise verified report.')=>({id:'run-1',status:'completed',settled:true,output,metadata:{inboxId:'inbox-1'}});
test('only settled jobs become locally available; pending is not completion or user delivery',()=>{
 const waiting=job('running');
 assert.equal(publishLocalResult(waiting,run(),2000),false);
 assert.equal(waiting.delivery.state,'pending');
 const complete=job();
 assert.equal(publishLocalResult(complete,run(),2000),true);
 assert.equal(complete.delivery.state,'available');
 assert.equal(complete.delivery.outcome,'completed');
 assert.equal(complete.delivery.preview,'A concise verified report.');
 assert.equal(complete.delivery.acknowledgedAt,null);
 assert.equal(complete.delivery.availableAt,new Date(2000).toISOString());
 assert.equal(publishLocalResult(complete,run('different'),3000),false);
 assert.equal(complete.delivery.preview,'A concise verified report.');
});
test('result output requires matching engine-to-inbox identity, never substitutes another run',()=>{
 const mismatched=job();
 assert.equal(publishLocalResult(mismatched,{...run('SECRET'),metadata:{inboxId:'other'}},2000),true);
 assert.equal(mismatched.delivery.preview,null);
 assert.equal(mismatched.delivery.sourceRunId,'run-1');
 assert.equal(mismatched.delivery.previewCharacters,null);
 const missing=job();
 assert.equal(publishLocalResult(missing,null,2000),true);
 assert.equal(missing.delivery.preview,null);
 const truncated=job();
 assert.equal(publishLocalResult(truncated,run('a'.repeat(RESULT_PREVIEW_CHARS+42)),2000),true);
 assert.equal(truncated.delivery.preview.length,RESULT_PREVIEW_CHARS);
 assert.equal(truncated.delivery.previewTruncated,true);
 assert.equal(truncated.delivery.previewCharacters,RESULT_PREVIEW_CHARS+42);
});
test('failure and interruption create inspectable local notices without claiming successful inference',()=>{
 for(const status of ['failed','cancelled','interrupted']){
   const value=job(status);
   assert.equal(publishLocalResult(value,run('Incomplete analysis.'),2000),true);
   assert.equal(value.delivery.outcome,status);
   assert.equal(value.delivery.state,'available');
   if(status==='failed')assert.match(value.delivery.error,/Could not verify/);
 }
});
test('acknowledgement is explicit, idempotent and revision-checked',()=>{
 const value=job();
 assert.throws(()=>acknowledgeLocalResult(value,1,2000),/no reviewable result/i);
 publishLocalResult(value,run(),2000);
 assert.throws(()=>acknowledgeLocalResult(value,1,3000),/receipt changed/i);
 assert.equal(acknowledgeLocalResult(value,2,3000),true);
 assert.equal(value.delivery.state,'acknowledged');
 assert.equal(value.delivery.revision,3);
 assert.equal(value.delivery.acknowledgedAt,new Date(3000).toISOString());
 assert.equal(acknowledgeLocalResult(value,2,4000),false);
 assert.equal(value.delivery.acknowledgedAt,new Date(3000).toISOString());
});
test('saved receipt validation rejects corrupt state and preserves status distinctions',()=>{
 const value=job();
 assert.equal(validLocalResultReceipt(value.delivery,value.id),true);
 assert.equal(validLocalResultReceipt({...value.delivery,jobId:'another-job'},value.id),false);
 publishLocalResult(value,run(),2000);
 assert.equal(validLocalResultReceipt(value.delivery,value.id),true);
 assert.equal(validLocalResultReceipt({...value.delivery,preview:'a'.repeat(RESULT_PREVIEW_CHARS+1)},value.id),false);
 assert.equal(validLocalResultReceipt({...value.delivery,state:'acknowledged',acknowledgedAt:null},value.id),false);
 acknowledgeLocalResult(value,2,3000);
 assert.equal(validLocalResultReceipt(value.delivery,value.id),true);
});
test('read-only result inbox excludes old jobs without delivery receipts',()=>{
 const value=job(),other=job();
 other.id='job-2';other.delivery=newPendingResult('job-2',1000);
 publishLocalResult(value,run(),2000);
 publishLocalResult(other,run(),2000);
 acknowledgeLocalResult(other,2,3000);
 const jobs=[value,other,{id:'legacy',status:'completed'}],before=structuredClone(jobs);
 const unread=resultInbox(jobs);
 assert.equal(unread.available,1);
 assert.equal(unread.total,1);
 assert.equal(unread.acknowledged,0);
 const all=resultInbox(jobs,{includeAcknowledged:true,limit:1});
 assert.equal(all.total,2);
 assert.equal(all.items.length,1);
 assert.deepEqual(jobs,before);
 const prioritized=resultInbox([other,value],{includeAcknowledged:true});
 assert.equal(prioritized.items[0].id,value.id,'unacknowledged results precede reviewed history');
});
