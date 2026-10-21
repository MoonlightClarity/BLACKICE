import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OperationsStore,OPERATIONS_LIMITS} from '../lib/operations.mjs';
import {TaskInbox,INBOX_LIMITS} from '../lib/inbox.mjs';

const workflow={id:'capacity-workflow',name:'Capacity fixture',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'fixture-model',prompt:'Verify the requested task.'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1}};
class Engine extends EventEmitter{
 constructor(){super();this.runs=new Map();this.executions=new Map();this.calls=[];this.maxConcurrentRuns=1;}
 listRuns(){return structuredClone([...this.runs.values()]);}
 startRun(value){assert.equal(this.executions.size,0);this.calls.push(structuredClone(value));const run={id:`capacity-run-${this.calls.length}`,status:'running',settled:false,metadata:structuredClone(value.metadata)};this.runs.set(run.id,run);this.executions.set(run.id,true);return structuredClone(run);}
 finish(id){const run=this.runs.get(id);Object.assign(run,{status:'completed',settled:true,finishedAt:new Date().toISOString()});this.executions.delete(id);this.emit('event',{type:'run.updated',runId:id,data:structuredClone(run)});}
}
async function fixture(t){
 const directory=await mkdtemp(path.join(tmpdir(),'blackice-capacity-test-')),cwd=path.join(directory,'workspace');await mkdir(cwd);const engine=new Engine(),opened=[],open=async()=>{const inbox=await new TaskInbox({dataDir:directory,engine}).init(),operations=await new OperationsStore({dataDir:directory,inbox,engine}).init();operations.kick=()=>{};opened.push({inbox,operations});return{inbox,operations};},initial=await open();
 t.after(async()=>{for(const {inbox,operations} of opened){await operations.close().catch(()=>{});await inbox.close().catch(()=>{});}assert.match(path.basename(directory),/^blackice-capacity-test-/);await rm(directory,{recursive:true,force:true});});
 return{directory,cwd,engine,open,...initial,create:value=>initial.operations.create({name:'Recurring fixture',input:'Verify the capacity fixture.',cwd,workflow,...value})};
}

test('recurring work passes both former lifetime limits while preserving old delivery identity and exact receipts across restart',async t=>{
 const f=await fixture(t),{operations,inbox,engine}=f,deployment=await f.create({enabled:true,trigger:{type:'webhook'},limits:{maxIterations:1000}}),original=await operations.trigger(deployment.id,{source:'webhook',idempotencyKey:'original-event',payload:{sequence:1}});await operations.poll();engine.finish(operations.getJob(original.id).attempts[0].runId);await operations.poll();const receipt=operations.getJob(original.id),originalInbox=inbox.get(receipt.attempts[0].inboxId);
 // Seed retained terminal receipts, then run new work through the real inbox.
 const history=structuredClone(operations.state),saved=history.deployments[0];for(let index=1;index<OPERATIONS_LIMITS.jobs+5;index++){const {created}=operations.makeJob(history,saved,{source:'manual',key:`saved-history:${index}`});created.status='completed';created.finishedAt=operations.stamp();history.jobs.push(created);}await operations.save(history);
 const inboxHistory=structuredClone(inbox.state);for(let index=1;index<INBOX_LIMITS.items+5;index++){const item=structuredClone(originalInbox);item.id=`retained-inbox-${index}`;item.enqueueKey=`retained-operation:${index}`;if(index%5===0){item.status='deleted';item.deletedFrom='completed';}inboxHistory.items.push(item);}await inbox.save(inboxHistory);
 assert.equal(operations.status().retainedHistory,505);assert.equal(inbox.status().retainedHistory,305);assert.equal(operations.status().availableCapacity,500);assert.equal(inbox.status().availableCapacity,300);
 assert.equal((await operations.trigger(deployment.id,{source:'webhook',idempotencyKey:'original-event',payload:{sequence:1}})).id,original.id);await assert.rejects(operations.trigger(deployment.id,{source:'webhook',idempotencyKey:'original-event',payload:{sequence:2}}),{status:409});
 const next=await operations.trigger(deployment.id,{source:'webhook',idempotencyKey:'next-event',payload:{sequence:2}});await operations.poll();assert.equal(engine.calls.length,2);assert.equal(operations.getJob(next.id).status,'running');assert.equal(inbox.snapshot().items.length,306);engine.finish(operations.getJob(next.id).attempts[0].runId);await operations.poll();assert.equal(operations.getJob(next.id).status,'completed');assert.deepEqual(operations.getJob(original.id),receipt);assert.equal(operations.getDeployment(deployment.id).admittedJobs,506);
 await operations.close();await inbox.close();const restored=await f.open();assert.equal(restored.operations.status().paused,true);assert.equal(restored.operations.status().retainedHistory,506);assert.equal(restored.inbox.status().retainedHistory,306);assert.deepEqual(restored.operations.getJob(original.id),receipt);assert.deepEqual(restored.inbox.get(originalInbox.id),originalInbox);
 assert.equal((await restored.operations.trigger(deployment.id,{source:'webhook',idempotencyKey:'original-event',payload:{sequence:1}})).id,original.id);const duplicate=await restored.inbox.add({input:originalInbox.input,title:originalInbox.title,cwd:originalInbox.cwd,workflow:originalInbox.workflow,attachmentIds:originalInbox.attachmentIds,enqueueKey:originalInbox.enqueueKey,managedBy:'operations'});assert.equal(duplicate.id,originalInbox.id);assert.equal(engine.calls.length,2,'loading and replaying receipts never reruns historical work');
});

test('unfinished inbox capacity still bounds queued work, frees on removal and cannot be exceeded by restore or retry',async t=>{
 const {inbox,cwd,engine}=await fixture(t),first=await inbox.add({input:'Keep this task',cwd,workflow,enqueueKey:'first-pending'}),next=structuredClone(inbox.state);for(let index=1;index<INBOX_LIMITS.items;index++){const item=structuredClone(first);item.id=`pending-${index}`;item.enqueueKey=`pending:${index}`;next.items.push(item);}const failed=structuredClone(first);Object.assign(failed,{id:'retained-failure',enqueueKey:'retained-failure',status:'failed',finishedAt:new Date().toISOString()});next.items.push(failed);await inbox.save(next);
 assert.equal(inbox.status().availableCapacity,0);assert.equal(inbox.status().retainedHistory,1);await assert.rejects(inbox.add({input:'Beyond unfinished capacity',cwd,workflow}),{status:507});await assert.rejects(inbox.retry(failed.id),{status:507});assert.equal(inbox.get(failed.id).status,'failed');assert.equal((await inbox.add({input:'Keep this task',cwd,workflow,enqueueKey:'retained-failure'})).id,failed.id);
 await inbox.remove(first.id);assert.equal(inbox.status().availableCapacity,1);const admitted=await inbox.add({input:'Use the freed slot',cwd,workflow});assert.equal(admitted.status,'queued');await assert.rejects(inbox.restore(first.id),{status:507});assert.equal(inbox.get(first.id).status,'deleted');assert.equal(inbox.status().availableCapacity,0);assert.equal(engine.calls.length,0);
});

test('byte budgets remain hard boundaries and a rejected history write preserves committed state and delivery keys',async t=>{
 const {operations,inbox,create,cwd,directory}=await fixture(t),deployment=await create(),job=await operations.trigger(deployment.id,{idempotencyKey:'preserved-job'}),item=await inbox.add({input:'Preserve this receipt',cwd,workflow,enqueueKey:'preserved-inbox'}),operationFile=path.join(directory,'operations.json'),inboxFile=path.join(directory,'inbox.json'),beforeOperations=await readFile(operationFile,'utf8'),beforeInbox=await readFile(inboxFile,'utf8');
 const largeOperation=structuredClone(operations.state);largeOperation.jobs[0].error='x'.repeat(OPERATIONS_LIMITS.bytes);await assert.rejects(operations.save(largeOperation),{status:507});assert.equal(await readFile(operationFile,'utf8'),beforeOperations);assert.deepEqual(operations.getJob(job.id),job);
 const largeInbox=structuredClone(inbox.state);largeInbox.items[0].error='x'.repeat(INBOX_LIMITS.bytes);await assert.rejects(inbox.save(largeInbox),{status:507});assert.equal(await readFile(inboxFile,'utf8'),beforeInbox);assert.deepEqual(inbox.getByEnqueueKey('preserved-inbox'),item);assert.equal((await operations.trigger(deployment.id,{idempotencyKey:'preserved-job'})).id,job.id);
});
