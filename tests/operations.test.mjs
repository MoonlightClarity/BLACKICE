import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp,mkdir,readFile,writeFile,readdir,rename,rmdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OperationsStore, OPERATIONS_LIMITS } from '../lib/operations.mjs';
import { TaskInbox } from '../lib/inbox.mjs';
import { TaskStateStore } from '../lib/task-state.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const until=async(check,label='operation condition')=>{const end=Date.now()+5000;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail(`${label} did not settle`);};
const workflow=(model='deployed-model')=>({id:'operation-workflow',name:'Deployed workflow',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',name:'Worker',prompt:'Verify the task.',model},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1}});
class Engine extends EventEmitter{
  constructor(capacity=1){super();this.runs=new Map();this.executions=new Map();this.calls=[];this.closed=false;this.onStart=null;this.maxConcurrentRuns=capacity;}
  listRuns(){return structuredClone([...this.runs.values()]);}
  startRun(value){if(this.maxConcurrentRuns!==null&&this.executions.size>=this.maxConcurrentRuns)throw Object.assign(new Error('Engine is busy'),{status:409});this.calls.push(structuredClone(value));const id=`operation-run-${this.calls.length}`,run={id,status:'running',settled:false,metadata:structuredClone(value.metadata),input:value.input.task,cwd:value.input.cwd};this.runs.set(id,run);this.executions.set(id,true);this.onStart?.(run,value);return structuredClone(run);}
  finish(id,status='completed',{settled=true,error}={}){const run=this.runs.get(id);assert.ok(run,`Run ${id} exists`);Object.assign(run,{status,settled,error,finishedAt:new Date().toISOString()});if(settled)this.executions.delete(id);this.emit('event',{type:'run.updated',runId:id,data:structuredClone(run)});}
}
async function harness(t,{automatic=false,capacity=1}={}){
  const directory=await mkdtemp(path.join(tmpdir(),'relay-operations-test-')),cwd=path.join(directory,'workspace');await mkdir(cwd);let timestamp=1792150000000;
  const engine=new Engine(capacity),inbox=await new TaskInbox({dataDir:directory,engine}).init(),options={dataDir:directory,inbox,engine,clock:()=>timestamp,pollMs:20},operations=await new OperationsStore(options).init();if(!automatic)operations.kick=()=>{};
  t.after(async()=>{await operations.close().catch(()=>{});await inbox.close().catch(()=>{});assert.match(path.basename(directory),/^relay-operations-test-/);await rm(directory,{recursive:true,force:true});});
  const create=value=>operations.create({name:'Fixture operation',input:'Verify the deployed fixture.',cwd,workflow:workflow(),...value});const advance=milliseconds=>{timestamp+=milliseconds;};
  return{directory,cwd,engine,inbox,operations,options,create,advance};
}

async function externalReceipt(t,{directory,cwd,engine},runId,{status='uncertain',backupRecovery=false}={}){
  const store=await new TaskStateStore({dataDir:directory}).init();t.after(()=>store.close());
  await store.ensure({taskId:runId,runId,nodeId:'agent',cwd,goal:'Publish one authorized fixture update.'});
  const action=async value=>store.externalAction(runId,value,{expectedRevision:(await store.get(runId)).revision,runId,nodeId:'agent'});
  await action({receiptId:'fixture-publication',operation:'prepare',destination:'https://example.com/updates',content:'One authorized fixture update.'});
  if(status!=='prepared')await action({receiptId:'fixture-publication',operation:'attempt'});
  if(status==='confirmed')await action({receiptId:'fixture-publication',operation:'confirm',url:'https://example.com/updates/one',evidence:'Read the exact fixture text at its resulting URL.'});
  if(backupRecovery){await store.close();await rm(store.file(runId));const restored=await new TaskStateStore({dataDir:directory}).init();t.after(()=>restored.close());engine.runs.get(runId).taskState=await restored.get(runId);}
  else engine.runs.get(runId).taskState=await store.get(runId);
}

test('finite operations count unique manual and webhook admissions durably while duplicate deliveries remain readable after the limit',async t=>{
  const {operations,create,options}=await harness(t),deployment=await create({enabled:true,trigger:{type:'webhook'},limits:{maxIterations:2}});
  const first=await operations.trigger(deployment.id,{source:'webhook',idempotencyKey:'finite-event',payload:{number:1}}),second=await operations.trigger(deployment.id,{idempotencyKey:'manual-event'});
  assert.notEqual(first.id,second.id);assert.equal(operations.getDeployment(deployment.id).admittedJobs,2);assert.equal(operations.getDeployment(deployment.id).limitStatus.reached,true);
  assert.equal((await operations.trigger(deployment.id,{source:'webhook',idempotencyKey:'finite-event',payload:{number:1}})).id,first.id);
  await assert.rejects(operations.trigger(deployment.id,{source:'webhook',idempotencyKey:'finite-event',payload:{number:2}}),/different trigger data/);
  await assert.rejects(operations.trigger(deployment.id),/Stopped after 2 admitted jobs/);assert.equal(operations.snapshot().jobs.length,2);
  await operations.close();const restored=await new OperationsStore(options).init();restored.kick=()=>{};assert.equal(restored.getDeployment(deployment.id).admittedJobs,2);assert.equal(restored.getDeployment(deployment.id).limitStatus.reached,true);await assert.rejects(restored.trigger(deployment.id),/Stopped after 2/);await restored.close();
});

test('count limits stop scheduled admissions and leave the final admitted queued and running jobs eligible',async t=>{
  const {operations,engine,create,advance}=await harness(t),deployment=await create({enabled:true,trigger:{type:'interval',everySeconds:10},overlap:'queue',limits:{maxIterations:2}});
  advance(10000);await operations.poll();advance(10000);await operations.poll();assert.equal(operations.snapshot().jobs.length,2);assert.equal(engine.calls.length,1);assert.equal(operations.getDeployment(deployment.id).nextAt,null);
  advance(30000);await operations.poll();assert.equal(operations.snapshot().jobs.length,2);engine.finish(engine.calls.length?'operation-run-1':'missing');await operations.poll();assert.equal(engine.calls.length,2);assert.equal(operations.snapshot().jobs.filter(job=>job.status==='running').length,1);assert.equal(operations.status().paused,false);
});

test('skipped overlap ticks consume no iterations and late scheduler polls never replay missed finite ticks',async t=>{
  const {operations,engine,create,advance}=await harness(t),deployment=await create({enabled:true,trigger:{type:'interval',everySeconds:10},overlap:'skip',limits:{maxIterations:2}});
  advance(10000);await operations.poll();advance(100000);await operations.poll();let saved=operations.getDeployment(deployment.id);assert.equal(saved.admittedJobs,1);assert.equal(saved.skippedOverlaps,1);assert.equal(saved.limitStatus.reached,false);
  engine.finish('operation-run-1');advance(10000);await operations.poll();saved=operations.getDeployment(deployment.id);assert.equal(saved.admittedJobs,2);assert.equal(engine.calls.length,2);advance(100000);await operations.poll();assert.equal(operations.snapshot().jobs.length,2);
});

test('automatic and explicit retries reuse admission allowance after the operation reaches its count and time limits',async t=>{
  const {operations,engine,create,advance}=await harness(t),deployment=await create({retry:{maxAttempts:1,backoffSeconds:1},limits:{maxIterations:1,runForSeconds:1}}),first=await operations.trigger(deployment.id);
  await operations.poll();engine.finish('operation-run-1','failed');await operations.poll();advance(1000);await operations.poll();assert.equal(engine.calls.length,2);assert.equal(operations.getDeployment(deployment.id).admittedJobs,1);engine.finish('operation-run-2','failed');await operations.poll();
  const retry=await operations.retryJob(first.id);assert.equal(retry.retryOf,first.id);await operations.poll();assert.equal(engine.calls.length,3);assert.equal(operations.getDeployment(deployment.id).admittedJobs,1);await assert.rejects(operations.trigger(deployment.id),/Stopped after 1 admitted job/);
});

test('duration begins at first activation, is not reset by edits, pause or restart, and stops new work without cancelling admitted jobs',async t=>{
  const {operations,engine,create,advance,options}=await harness(t),created=await create({limits:{runForSeconds:60}});assert.equal(created.activatedAt,null);assert.equal(created.limitStatus.endsAt,null);advance(1000000);
  const first=await operations.trigger(created.id),activated=operations.getDeployment(created.id);assert.ok(activated.activatedAt);assert.equal(Date.parse(activated.limitStatus.endsAt)-Date.parse(activated.activatedAt),60000);await operations.pause();advance(30000);await operations.resume();const edited=await operations.update(created.id,{name:'Renamed finite task'});assert.equal(edited.activatedAt,activated.activatedAt);assert.equal(edited.limitStatus.endsAt,activated.limitStatus.endsAt);
  advance(30000);await assert.rejects(operations.trigger(created.id),/end time has been reached/);await operations.poll();assert.equal(operations.getJob(first.id).status,'running');assert.equal(engine.calls.length,1);engine.finish('operation-run-1');await operations.poll();await operations.close();const restored=await new OperationsStore(options).init();restored.kick=()=>{};assert.equal(restored.getDeployment(created.id).limitStatus.endsAt,activated.limitStatus.endsAt);await restored.resume();await assert.rejects(restored.trigger(created.id),/end time has been reached/);await restored.close();
});

test('enabling a finite calendar schedule starts duration once and absolute deadlines use the earlier instant',async t=>{
  const {operations,create,advance}=await harness(t),created=await create({trigger:{type:'cron',expression:'* * * * *',timezone:'UTC'},limits:{runForSeconds:3600,endAt:'2026-10-16T09:00:00-04:00'}}),enabled=await operations.update(created.id,{enabled:true});
  assert.ok(enabled.activatedAt);const endAt=Date.parse(enabled.limits.endAt),durationEnd=Date.parse(enabled.activatedAt)+3600000;assert.equal(Date.parse(enabled.limitStatus.endsAt),Math.min(endAt,durationEnd));advance(1000);await operations.update(created.id,{enabled:false});const reenabled=await operations.update(created.id,{enabled:true});assert.equal(reenabled.activatedAt,enabled.activatedAt);assert.equal(reenabled.limitStatus.endsAt,enabled.limitStatus.endsAt);
});

test('extending or clearing limits resumes admissions without discarding lifetime counts or resetting activation',async t=>{
  const {operations,create}=await harness(t),created=await create({limits:{maxIterations:1}});await operations.trigger(created.id);const stopped=operations.getDeployment(created.id);await assert.rejects(operations.trigger(created.id),/Stopped after/);
  const extended=await operations.update(created.id,{limits:{maxIterations:2}});assert.equal(extended.admittedJobs,1);assert.equal(extended.activatedAt,stopped.activatedAt);await operations.trigger(created.id);assert.equal(operations.getDeployment(created.id).admittedJobs,2);const unlimited=await operations.update(created.id,{limits:null});assert.deepEqual(unlimited.limits,{maxIterations:null,runForSeconds:null,endAt:null});await operations.trigger(created.id);assert.equal(operations.getDeployment(created.id).admittedJobs,3);
});

test('finite admission counts commit atomically, serialize concurrent triggers and preserve allowance after a failed write',async t=>{
  const {operations,create}=await harness(t),created=await create({limits:{maxIterations:1}}),save=operations.save.bind(operations);let failOnce=true;operations.save=async next=>{if(failOnce&&next.jobs.length){failOnce=false;throw Error('Fixture limit receipt write failed');}return save(next);};
  await assert.rejects(operations.trigger(created.id),/limit receipt write failed/);assert.equal(operations.getDeployment(created.id).admittedJobs,0);assert.equal(operations.snapshot().jobs.length,0);
  const outcomes=await Promise.allSettled([operations.trigger(created.id),operations.trigger(created.id)]);assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,1);assert.equal(outcomes.filter(item=>item.status==='rejected').length,1);assert.equal(operations.getDeployment(created.id).admittedJobs,1);
});

test('old operation files derive lifetime admissions once without counting explicit retry receipts',async t=>{
  const {operations,engine,create,options,directory}=await harness(t),created=await create(),first=await operations.trigger(created.id);await operations.poll();engine.finish('operation-run-1','failed');await operations.poll();await operations.retryJob(first.id);await operations.close();
  const file=path.join(directory,'operations.json'),old=JSON.parse(await readFile(file,'utf8'));for(const deployment of old.deployments){delete deployment.limits;delete deployment.admittedJobs;delete deployment.activatedAt;}for(const job of old.jobs)delete job.definition.limits;await writeFile(file,JSON.stringify(old));const restored=await new OperationsStore(options).init();restored.kick=()=>{};assert.equal(restored.getDeployment(created.id).admittedJobs,1);assert.equal(restored.getDeployment(created.id).activatedAt,created.createdAt);assert.deepEqual(restored.getDeployment(created.id).limits,{maxIterations:null,runForSeconds:null,endAt:null});await restored.close();
});

test('operation limits accept large representable choices and reject malformed or calendar-overflow values before saving',async t=>{
  const {operations,create}=await harness(t);for(const limits of [{maxIterations:0},{maxIterations:1.5},{maxIterations:Number.MAX_SAFE_INTEGER+1},{runForSeconds:0},{runForSeconds:1.5},{endAt:'2026-10-17T09:00'},{endAt:'2026-02-30T09:00:00Z'},{endAt:'2026-10-17Z'},{endAt:'2026-10-17T24:00:00Z'},{endAt:'nonsense'},{maxJobs:2}])await assert.rejects(create({limits}));assert.equal(operations.list().length,0);
  const created=await create({limits:{maxIterations:Number.MAX_SAFE_INTEGER,runForSeconds:1000000000000}});assert.equal(created.limits.maxIterations,Number.MAX_SAFE_INTEGER);assert.equal(created.limits.runForSeconds,1000000000000);await assert.rejects(create({enabled:true,limits:{runForSeconds:Math.floor(Number.MAX_SAFE_INTEGER/1000)}}),/supported calendar/);assert.equal(operations.list().length,1);
});

test('deployment and job snapshots are durable and manual/webhook idempotency never accepts a different payload',async t=>{
  const {operations,create,cwd,options}=await harness(t);const deployment=await create();assert.equal(deployment.enabled,false);assert.equal(deployment.trigger.type,'manual');assert.deepEqual(deployment.retry,{maxAttempts:0,backoffSeconds:30});assert.equal(deployment.webhookToken,undefined);
  const [first,duplicate]=await Promise.all([operations.trigger(deployment.id,{idempotencyKey:'event-1',payload:{value:42}}),operations.trigger(deployment.id,{idempotencyKey:'event-1',payload:{value:42}})]);assert.equal(first.id,duplicate.id);assert.equal(operations.snapshot().jobs.length,1);await assert.rejects(operations.trigger(deployment.id,{idempotencyKey:'event-1',payload:{value:43}}),{status:409});
  const changed=await operations.update(deployment.id,{workflow:workflow('new-model'),input:'New future task.',expectedRevision:deployment.revision});assert.equal(changed.revision,2);assert.equal(operations.getJob(first.id).definition.workflow.nodes[1].model,'deployed-model');assert.equal(operations.getJob(first.id).definition.cwd,cwd);assert.match(first.taskInput,/UNTRUSTED TRIGGER DATA/);assert.match(first.taskInput,/"value":42/);assert.equal(operations.getJob(first.id).definition.input,'Verify the deployed fixture.');
  await operations.close();const restored=await new OperationsStore(options).init();assert.equal(restored.status().paused,true);assert.equal(restored.getJob(first.id).status,'queued');assert.equal(restored.getJob(first.id).definition.workflow.nodes[1].model,'deployed-model');await restored.close();
});

test('opaque persistent webhook tokens stay out of public state and rotation invalidates old callers',async t=>{
  const {operations,create,options}=await harness(t);const deployment=await create({enabled:true,trigger:{type:'webhook'}}),secret=operations.getWebhook(deployment.id);assert.match(secret.token,/^[a-f0-9]{64}$/);assert.equal(operations.verifyWebhook(deployment.id,secret.token),true);assert.equal(operations.verifyWebhook(deployment.id,'wrong'),false);assert.equal(operations.verifyWebhook('missing',secret.token),false);assert.ok(!JSON.stringify(operations.snapshot()).includes(secret.token));
  await assert.rejects(operations.trigger(deployment.id,{source:'webhook'}),/Idempotency-Key/);const job=await operations.trigger(deployment.id,{source:'webhook',idempotencyKey:'delivery-1',payload:{event:'updated'}});assert.equal(job.source,'webhook');
  await operations.close();const restored=await new OperationsStore(options).init();assert.equal(restored.getWebhook(deployment.id).token,secret.token);assert.equal(restored.verifyWebhook(deployment.id,secret.token),true);const rotated=await restored.rotateWebhook(deployment.id);assert.notEqual(rotated.token,secret.token);assert.equal(restored.verifyWebhook(deployment.id,secret.token),false);assert.equal(restored.verifyWebhook(deployment.id,rotated.token),true);await restored.update(deployment.id,{enabled:false});assert.equal(restored.verifyWebhook(deployment.id,rotated.token),false);await restored.close();
});

test('operations defer to foreground work, serialize jobs, and execute independently of global inbox autorun',async t=>{
  const {operations,inbox,engine,create}=await harness(t);const deployment=await create(),first=await operations.trigger(deployment.id),second=await operations.trigger(deployment.id);engine.runs.set('foreground',{id:'foreground',status:'running',settled:false});engine.executions.set('foreground',true);await operations.poll();assert.equal(engine.calls.length,0);assert.equal(inbox.status().autoRun,false);
  engine.finish('foreground');await operations.poll();assert.equal(engine.calls.length,1);let job=operations.getJob(first.id);assert.equal(job.status,'running');assert.equal(inbox.get(job.attempts[0].inboxId).managedBy,'operations');assert.equal(operations.getJob(second.id).status,'queued');engine.finish(job.attempts[0].runId,'completed',{settled:false});await operations.poll();assert.equal(engine.calls.length,1);engine.finish(job.attempts[0].runId);await operations.poll();assert.equal(operations.getJob(first.id).status,'completed');assert.equal(engine.calls.length,2);assert.equal(operations.getJob(second.id).status,'running');
});

test('operations use free agent capacity and a queued job needs only one slot to settle',async t=>{
  const {operations,engine,create}=await harness(t,{capacity:2});const deployment=await create(),first=await operations.trigger(deployment.id),second=await operations.trigger(deployment.id);engine.runs.set('foreground',{id:'foreground',status:'running',settled:false});engine.executions.set('foreground',true);await operations.poll();assert.equal(engine.calls.length,1);assert.equal(operations.getJob(first.id).status,'running');assert.equal(operations.getJob(second.id).status,'queued');await operations.poll();assert.equal(engine.calls.length,1);engine.finish('foreground','completed',{settled:false});await operations.poll();assert.equal(engine.calls.length,1);engine.finish('foreground');await operations.poll();assert.equal(engine.calls.length,2);assert.equal(operations.getJob(first.id).status,'running');assert.equal(operations.getJob(second.id).status,'running');assert.equal(engine.executions.size,2);
});

test('an operation losing its final admission slot remains queued without pausing either scheduler',async t=>{
  const {operations,inbox,engine,create}=await harness(t);const deployment=await create(),job=await operations.trigger(deployment.id),entered=deferred(),release=deferred(),save=inbox.save.bind(inbox);let delayed=false;inbox.save=async next=>{if(!delayed&&next.items.some(item=>item.status==='dispatching')){delayed=true;entered.resolve();await release.promise;}return save(next);};const polling=operations.poll();await entered.promise;engine.runs.set('foreground',{id:'foreground',status:'running',settled:false});engine.executions.set('foreground',true);release.resolve();await polling;assert.equal(operations.getJob(job.id).status,'queued');assert.equal(operations.status().paused,false);assert.equal(inbox.status().paused,false);assert.equal(engine.calls.length,0);engine.finish('foreground');await operations.poll();assert.equal(operations.getJob(job.id).status,'running');assert.equal(engine.calls.length,1);assert.equal(inbox.snapshot().items.length,1);
});

test('normal inbox autorun cannot execute a managed operation while operations or global Stop is paused',async t=>{
  const {operations,inbox,engine,create}=await harness(t);const deployment=await create(),job=await operations.trigger(deployment.id),entered=deferred(),release=deferred(),save=operations.save.bind(operations);let delayed=false;operations.save=async next=>{if(!delayed&&next.jobs[0].status==='dispatching'){delayed=true;entered.resolve();await release.promise;}return save(next);};
  const polling=operations.poll();await entered.promise;const paused=operations.pause('Global Stop');release.resolve();await polling;await paused;assert.equal(engine.calls.length,0);await inbox.configure({autoRun:true});await inbox.pump();assert.equal(engine.calls.length,0);await operations.resume();await inbox.pause('Still globally stopped');await operations.poll();assert.equal(engine.calls.length,0);assert.ok(operations.status().blockedReason);await operations.resume({resumeInbox:true});await operations.poll();assert.equal(engine.calls.length,1);assert.equal(operations.getJob(job.id).status,'running');
});

test('intervals accept positive whole seconds without an arbitrary 30-day ceiling',async t=>{
  const {operations,create}=await harness(t);
  await assert.rejects(create({enabled:false,trigger:{type:'interval',everySeconds:0}}),/positive whole/);
  for(const seconds of [1,31*86400]){
    const saved=await create({enabled:false,trigger:{type:'interval',everySeconds:seconds}});
    assert.equal(saved.trigger.everySeconds,seconds);
    const preview=operations.previewSchedule({trigger:saved.trigger,count:2});
    assert.equal(preview.occurrences[1].at-preview.occurrences[0].at,seconds*1000);
  }
});

test('intervals use seconds, coalesce overlap and missed ticks, and restart never silently catches up',async t=>{
  const {operations,engine,create,advance,options}=await harness(t);await assert.rejects(create({enabled:true,trigger:{type:'interval',everySeconds:0}}),/Interval in seconds/);const deployment=await create({enabled:true,trigger:{type:'interval',everySeconds:10},overlap:'skip'});advance(9999);await operations.poll();assert.equal(engine.calls.length,0);advance(1);await operations.poll();assert.equal(engine.calls.length,1);const first=operations.snapshot().jobs[0];advance(100000);await operations.poll();assert.equal(operations.snapshot().jobs.length,1);assert.equal(operations.getDeployment(deployment.id).skippedOverlaps,1);engine.finish(first.attempts[0].runId);await operations.poll();assert.equal(engine.calls.length,1);advance(10000);await operations.poll();assert.equal(engine.calls.length,2);
  await operations.close();const restored=await new OperationsStore(options).init();restored.kick=()=>{};advance(1000000);await restored.poll();assert.equal(engine.calls.length,2);assert.equal(restored.status().paused,true);await restored.resume({resumeInbox:true});await restored.poll();assert.equal(engine.calls.length,2,'resume schedules the next future tick instead of replaying missed ones');await restored.close();
});

test('real calendar ticks retain distinct durable instants, coalesce suspension, and resume only in the future',async t=>{
  const {operations,engine,create,advance,options}=await harness(t,{capacity:null}),trigger={type:'cron',expression:'* * * * *',timezone:'America/New_York'};
  const before=operations.clock(),preview=operations.previewSchedule({trigger,count:3});assert.equal(operations.snapshot().jobs.length,0);assert.equal(engine.calls.length,0);
  const deployment=await create({enabled:true,trigger});assert.equal(deployment.nextAt,preview.nextAt);assert.equal(deployment.nextAt%60000,0);assert.ok(deployment.nextAt>before);
  advance(deployment.nextAt-before);await operations.poll();await operations.poll();assert.equal(engine.calls.length,1);assert.equal(operations.snapshot().jobs.length,1);const first=operations.snapshot().jobs[0];assert.equal(first.source,'cron');assert.equal(first.scheduledAt,deployment.nextAt);assert.deepEqual(first.definition.trigger,trigger);
  advance(6*60000);await operations.poll();assert.equal(engine.calls.length,2);assert.equal(operations.snapshot().jobs.length,2,'waking six minutes late captures one due receipt, not a backlog of six phantom runs');assert.notEqual(operations.snapshot().jobs[0].keyHash,operations.snapshot().jobs[1].keyHash);
  await operations.close();const restored=await new OperationsStore(options).init();restored.kick=()=>{};advance(86400000);await restored.poll();assert.equal(restored.status().paused,true);assert.equal(engine.calls.length,2);assert.equal(restored.snapshot().jobs.length,2);
  await restored.resume({resumeInbox:true});assert.ok(restored.getDeployment(deployment.id).nextAt>restored.clock());await restored.poll();assert.equal(engine.calls.length,2,'resume cannot replay ticks missed while closed');await restored.close();
});

test('editing deployment details preserves the pending interval or calendar tick while schedule changes reset it',async t=>{
  const {operations,engine,create,advance}=await harness(t,{capacity:null});
  for(const trigger of [{type:'interval',everySeconds:10},{type:'cron',expression:'* * * * *',timezone:'UTC'}]){
    const deployment=await create({enabled:true,trigger}),dueAt=deployment.nextAt;advance(dueAt-operations.clock()-1);
    const edited=await operations.update(deployment.id,{name:'Edited just before the tick',input:'Run the updated task.',workflow:workflow('updated-before-tick'),retry:{maxAttempts:1,backoffSeconds:2},overlap:'queue'});
    assert.equal(edited.nextAt,dueAt,'metadata and task edits cannot postpone an already scheduled tick');
    advance(1);await operations.poll();const job=operations.snapshot().jobs.find(value=>value.deploymentId===deployment.id);
    assert.equal(job.scheduledAt,dueAt);assert.equal(job.taskInput,'Run the updated task.');assert.equal(job.definition.workflow.nodes[1].model,'updated-before-tick');
    engine.finish(job.attempts[0].runId);await operations.poll();
    const changed=await operations.update(deployment.id,{trigger:{type:'interval',everySeconds:20}});assert.equal(changed.nextAt,operations.clock()+20000);
    const disabled=await operations.update(deployment.id,{enabled:false});assert.equal(disabled.nextAt,null);advance(30000);
    const enabled=await operations.update(deployment.id,{enabled:true});assert.equal(enabled.nextAt,operations.clock()+20000);await operations.update(deployment.id,{enabled:false});
  }
});

test('full unfinished capacity reports an admission error without blocking admitted work and frees capacity after settlement',async t=>{
  const {operations,engine,create,advance,options}=await harness(t),deployment=await create({enabled:true,trigger:{type:'interval',everySeconds:10}}),pending=await operations.trigger(deployment.id,{idempotencyKey:'admitted-before-full'}),next=structuredClone(operations.state),saved=next.deployments.find(value=>value.id===deployment.id);
  for(let index=1;index<OPERATIONS_LIMITS.jobs;index++){
    const {created}=operations.makeJob(next,saved,{source:'manual',key:`admitted-work:${index}`});next.jobs.push(created);
  }
  await operations.save(next);advance(10000);await operations.poll();
  assert.equal(engine.calls.length,1,'full admission capacity cannot starve an existing queued job');assert.equal(operations.getJob(pending.id).status,'running');assert.equal(operations.snapshot().jobs.length,OPERATIONS_LIMITS.jobs);
  assert.match(operations.getDeployment(deployment.id).scheduleError,/500 unfinished jobs/i);assert.equal(operations.status().scheduleErrors,1);assert.equal(operations.status().healthy,false);assert.match(operations.status().error,/500 unfinished jobs/i);assert.equal(operations.getDeployment(deployment.id).nextAt,operations.clock()+10000);assert.equal(operations.status().availableCapacity,0);
  engine.finish('operation-run-1');await operations.poll();assert.equal(operations.getJob(pending.id).status,'completed');assert.equal(engine.calls.length,2);assert.equal(operations.status().availableCapacity,1);assert.equal(operations.status().retainedHistory,1);
  advance(10000);await operations.poll();assert.equal(operations.snapshot().jobs.length,OPERATIONS_LIMITS.jobs+1);assert.equal(operations.status().scheduleErrors,0);assert.equal(operations.status().availableCapacity,0);
  await operations.close();const restored=await new OperationsStore(options).init();restored.kick=()=>{};
  try{assert.equal(restored.snapshot().jobs.length,OPERATIONS_LIMITS.jobs+1);assert.equal(restored.getJob(pending.id).status,'completed');assert.equal(restored.status().paused,true);assert.equal((await restored.trigger(deployment.id,{idempotencyKey:'admitted-before-full'})).id,pending.id);assert.equal(restored.status().healthy,true);}finally{await restored.close();}
});

test('calendar overlap policies skip or queue actual ticks without imposing a global concurrency limit',async t=>{
  const {operations,engine,create,advance}=await harness(t,{capacity:null}),trigger={type:'cron',expression:'* * * * *',timezone:'UTC'},skip=await create({name:'Skip calendar',enabled:true,trigger,overlap:'skip'}),queue=await create({name:'Queue calendar',enabled:true,trigger,overlap:'queue'}),parallel=await create({name:'Parallel calendar',enabled:true,trigger});
  advance(skip.nextAt-operations.clock());await operations.poll();await operations.poll();await operations.poll();assert.equal(engine.calls.length,3);
  for(let index=0;index<5;index++){advance(60000);await operations.poll();await operations.poll();}
  const jobs=operations.snapshot().jobs;assert.equal(operations.getDeployment(skip.id).skippedOverlaps,5);assert.equal(jobs.filter(job=>job.deploymentId===skip.id).length,1);assert.equal(jobs.filter(job=>job.deploymentId===queue.id).length,6);assert.equal(jobs.filter(job=>job.deploymentId===queue.id&&job.status==='running').length,1);assert.equal(jobs.filter(job=>job.deploymentId===parallel.id&&job.status==='running').length,6);assert.equal(engine.executions.size,8);
  const oldNext=operations.getDeployment(parallel.id).nextAt;await operations.pause();advance(600000);await operations.update(parallel.id,{trigger:{type:'cron',expression:'0 9 * * MON-FRI',timezone:'Europe/Berlin'}});assert.equal(operations.status().paused,true);assert.equal(engine.calls.length,8);assert.ok(operations.getDeployment(parallel.id).nextAt>oldNext);await assert.rejects(operations.update(parallel.id,{trigger:{type:'cron',expression:'0 9 30 FEB *',timezone:'UTC'}}),{code:'INVALID_CRON'});assert.equal(operations.getDeployment(parallel.id).trigger.timezone,'Europe/Berlin');
});

test('configured retries run automatically after bounded backoff and exhausted failures stay local',async t=>{
  const {operations,inbox,engine,create,advance}=await harness(t);const deployment=await create({retry:{maxAttempts:1,backoffSeconds:10}}),job=await operations.trigger(deployment.id);await operations.poll();engine.finish(operations.getJob(job.id).attempts[0].runId,'failed',{error:'Verified fixture failure'});await operations.poll();let saved=operations.getJob(job.id);assert.equal(saved.status,'retry_wait');assert.equal(saved.attempts[0].status,'failed');assert.equal(operations.status().paused,false);assert.equal(inbox.status().paused,false);
  advance(9999);await operations.poll();assert.equal(engine.calls.length,1);advance(1);await operations.poll();assert.equal(engine.calls.length,2);saved=operations.getJob(job.id);assert.equal(saved.attempts.length,2);assert.notEqual(saved.attempts[0].enqueueKey,saved.attempts[1].enqueueKey);engine.finish(saved.attempts[1].runId,'failed',{error:'Second observed failure'});await operations.poll();assert.equal(operations.getJob(job.id).status,'failed');assert.equal(operations.status().paused,false);assert.equal(inbox.status().paused,false);advance(100000);await operations.poll();assert.equal(engine.calls.length,2);
  const updated=await operations.update(deployment.id,{name:'Renamed future operation',workflow:workflow('changed-model')});const explicit=await operations.retryJob(job.id);assert.notEqual(explicit.id,job.id);assert.equal(explicit.retryOf,job.id);assert.equal(explicit.definition.workflow.nodes[1].model,'deployed-model','explicit retry retains the exact original task snapshot');assert.equal(updated.revision,2);assert.equal(updated.name,'Renamed future operation');assert.equal(explicit.deploymentRevision,job.deploymentRevision,'an old workflow is labelled with its actual original deployment revision');assert.equal(explicit.deploymentRevision,1);assert.equal(explicit.deploymentName,job.deploymentName,'a saved recipe retry retains its original deployment label');assert.equal(explicit.definition.name,job.definition.name);await operations.poll();assert.equal(inbox.get(operations.getJob(explicit.id).attempts[0].inboxId).title,`${job.deploymentName} · job 1`);
});

test('configured retry never clears an unrelated user Stop latch',async t=>{
  const {operations,inbox,engine,create,advance}=await harness(t);const deployment=await create({retry:{maxAttempts:2,backoffSeconds:1}}),job=await operations.trigger(deployment.id);await operations.poll();await inbox.pause('Explicit user Stop');engine.finish(operations.getJob(job.id).attempts[0].runId,'failed',{error:'Failure arriving after Stop'});await operations.poll();assert.equal(operations.getJob(job.id).status,'retry_wait');advance(100000);await operations.poll();assert.equal(engine.calls.length,1);assert.equal(inbox.status().paused,true);assert.equal(inbox.status().pauseReason,'Explicit user Stop');assert.equal(operations.status().blockedReason,'Explicit user Stop');
});

test('cancellation is recorded and never automatically retried even when failure retries were configured',async t=>{
  const {operations,inbox,engine,create,advance}=await harness(t);const deployment=await create({retry:{maxAttempts:3,backoffSeconds:1}}),job=await operations.trigger(deployment.id);await operations.poll();engine.finish(operations.getJob(job.id).attempts[0].runId,'cancelled');await operations.poll();assert.equal(operations.getJob(job.id).status,'cancelled');assert.equal(operations.status().paused,false);assert.equal(inbox.status().paused,false);advance(100000);await operations.poll();assert.equal(engine.calls.length,1);
});

test('cancelling one operation frees its slot for an unrelated job without pausing other deployments',async t=>{
  const {operations,inbox,engine,create}=await harness(t,{capacity:2});const deployment=await create({retry:{maxAttempts:3,backoffSeconds:1}}),jobs=[];for(let index=0;index<3;index++)jobs.push(await operations.trigger(deployment.id,{idempotencyKey:`independent-job:${index}`}));await operations.poll();await operations.poll();assert.equal(engine.calls.length,2);const stoppedRun=operations.getJob(jobs[0].id).attempts[0].runId;engine.finish(stoppedRun,'cancelled');await operations.poll();assert.equal(operations.getJob(jobs[0].id).status,'cancelled');assert.equal(operations.getJob(jobs[0].id).attempts.length,1);assert.equal(operations.getJob(jobs[1].id).status,'running');assert.equal(operations.getJob(jobs[2].id).status,'running');assert.equal(operations.status().paused,false);assert.equal(inbox.status().paused,false);assert.equal(engine.calls.length,3);
});

test('crash after idempotent inbox enqueue but before job binding recovers the one saved item without duplicate dispatch',async t=>{
  const {operations,inbox,engine,create,options}=await harness(t);const deployment=await create(),job=await operations.trigger(deployment.id),save=operations.save.bind(operations);let rejectBind=true,crashed=false;operations.save=async next=>{if(rejectBind&&(crashed||next.jobs[0].attempts[0]?.inboxId)){crashed=true;throw new Error('Fixture job bind fault');}return save(next);};await assert.rejects(operations.poll(),/bind fault/);assert.equal(inbox.snapshot().items.length,1);assert.equal(engine.calls.length,0);rejectBind=false;await operations.close();const restored=await new OperationsStore(options).init();restored.kick=()=>{};assert.equal(restored.getJob(job.id).status,'queued');assert.equal(restored.status().paused,true);await restored.resume({resumeInbox:true});await restored.poll();assert.equal(engine.calls.length,1);assert.equal(inbox.snapshot().items.length,1);await restored.close();
});

test('a failed operation receipt write keeps tracking its real run and prevents an explicit duplicate retry',async t=>{
  const {operations,engine,create}=await harness(t);const deployment=await create(),job=await operations.trigger(deployment.id),save=operations.save.bind(operations);let failOnce=true;
  operations.save=async next=>{if(failOnce&&next.jobs[0].status==='running'&&next.jobs[0].attempts[0]?.runId){failOnce=false;throw new Error('Fixture receipt write failed after execution started');}return save(next);};
  await assert.rejects(operations.poll(),/receipt write failed/);let saved=operations.getJob(job.id);assert.equal(saved.status,'running');assert.equal(saved.attempts[0].runId,'operation-run-1');assert.equal(operations.status().paused,true);assert.equal(engine.calls.length,1);
  await assert.rejects(operations.retryJob(job.id),{status:409});engine.finish(saved.attempts[0].runId);await operations.poll();saved=operations.getJob(job.id);assert.equal(saved.status,'completed');assert.equal(saved.attempts[0].status,'completed');assert.equal(engine.calls.length,1);
});

test('restart reconciles actual completed run receipts and leaves missing dispatches interrupted',async t=>{
  const {operations,inbox,engine,create,options,directory}=await harness(t);const deployment=await create(),completed=await operations.trigger(deployment.id);await operations.poll();const runId=operations.getJob(completed.id).attempts[0].runId;await operations.close();engine.finish(runId);await inbox.reconcile();const restored=await new OperationsStore(options).init();restored.kick=()=>{};assert.equal(restored.getJob(completed.id).status,'completed');assert.equal(restored.getJob(completed.id).attempts[0].runId,runId);assert.equal(engine.calls.length,1);await restored.close();
  const file=path.join(directory,'operations.json'),data=JSON.parse(await readFile(file,'utf8'));data.jobs[0].status='dispatching';data.jobs[0].attempts=[{number:1,enqueueKey:'operation:missing:1',inboxId:null,status:'enqueueing'}];await writeFile(file,JSON.stringify(data));const uncertain=await new OperationsStore(options).init();uncertain.kick=()=>{};assert.equal(uncertain.getJob(completed.id).status,'interrupted');await uncertain.resume({resumeInbox:true});await uncertain.poll();assert.equal(engine.calls.length,1);await uncertain.close();
});

for(const paused of [false,true])test(`verified clean restart preserves the saved ${paused?'explicit pause and reason':'unpaused setting'}`,async t=>{
  const {operations,options,directory}=await harness(t);
  if(paused)await operations.pause('User paused operations before the restart.');
  const saved=structuredClone(operations.state.settings);await operations.close();
  const restored=new OperationsStore(options);restored.kick=()=>{};
  try{
    await restored.init({preservePausedState:true});
    assert.deepEqual(restored.snapshot().settings,saved);assert.equal(restored.status().healthy,true);assert.equal(restored.recovered,false);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory,'operations.json'),'utf8')).settings,saved);
  }finally{await restored.close();}
});

test('ordinary restart and nonboolean preservation flags still pause saved operations',async t=>{
  for(const preservePausedState of [undefined,false,'true',1]){
    const {operations,options}=await harness(t);assert.equal(operations.status().paused,false);await operations.close();
    const restored=new OperationsStore(options);restored.kick=()=>{};
    try{
      await restored.init(preservePausedState===undefined?undefined:{preservePausedState});
      assert.equal(restored.status().paused,true);assert.match(restored.status().pauseReason,/Relay restarted/);
    }finally{await restored.close();}
  }
});

test('verified restart skips overdue interval and calendar ticks while preserving future deadlines',async t=>{
  const {operations,options,create,advance,engine}=await harness(t);
  const interval=await create({enabled:true,trigger:{type:'interval',everySeconds:10}}),calendar=await create({enabled:true,trigger:{type:'cron',expression:'* * * * *',timezone:'UTC'}}),future=await create({enabled:true,trigger:{type:'interval',everySeconds:3600}});
  await operations.close();advance(5*60000);
  const restored=new OperationsStore(options);restored.kick=()=>{};
  try{
    await restored.init({preservePausedState:true});
    assert.equal(restored.status().paused,false);assert.equal(restored.getDeployment(interval.id).nextAt,restored.clock()+10000);
    assert.ok(restored.getDeployment(calendar.id).nextAt>restored.clock());assert.equal(restored.getDeployment(future.id).nextAt,future.nextAt);
    await restored.poll();assert.equal(engine.calls.length,0);assert.equal(restored.snapshot().jobs.length,0,'ticks missed while the process was closed are not replayed');
    advance(10000);await restored.poll();assert.equal(engine.calls.length,1);assert.equal(restored.snapshot().jobs[0].scheduledAt,restored.clock());
  }finally{await restored.close();}
});

test('backup recovery still pauses operations even with verified-restart preservation requested',async t=>{
  const {operations,options,directory,create}=await harness(t),deployment=await create();
  await operations.update(deployment.id,{name:'Persisted healthy deployment'});await operations.close();
  const file=path.join(directory,'operations.json');assert.equal(JSON.parse(await readFile(`${file}.bak`,'utf8')).settings.paused,false);
  await writeFile(file,'{ corrupt operations');
  const restored=new OperationsStore(options);restored.kick=()=>{};
  try{
    await restored.init({preservePausedState:true});
    assert.equal(restored.recovered,true);assert.equal(restored.status().paused,true);assert.match(restored.status().pauseReason,/Relay restarted/);
  }finally{await restored.close();}
});

for(const situation of ['active','missing','conflicting'])test(`verified restart still pauses and never replays an operation with ${situation} dispatch receipts`,async t=>{
  const {operations,options,create,engine,inbox,directory}=await harness(t),deployment=await create({retry:{maxAttempts:2,backoffSeconds:1}}),job=await operations.trigger(deployment.id);
  await operations.poll();const runId=operations.getJob(job.id).attempts[0].runId;await operations.close();
  if(situation!=='active'){
    engine.finish(runId);await inbox.reconcile();
    const file=path.join(directory,'operations.json'),saved=JSON.parse(await readFile(file,'utf8'));
    if(situation==='missing')saved.jobs[0].attempts[0].inboxId='missing-inbox-receipt';else saved.jobs[0].attempts[0].enqueueKey='operation:conflicting:1';
    await writeFile(file,JSON.stringify(saved));
  }
  const restored=new OperationsStore(options);restored.kick=()=>{};
  try{
    await restored.init({preservePausedState:true});
    assert.equal(restored.status().paused,true);assert.equal(restored.getJob(job.id).status,'interrupted');assert.equal(restored.getJob(job.id).attempts[0].status,'interrupted');
    await restored.poll();assert.equal(engine.calls.length,1);
    if(situation==='active')engine.finish(runId,'cancelled');
    await restored.resume({resumeInbox:true});await restored.poll();assert.equal(engine.calls.length,1);assert.equal(restored.getJob(job.id).attempts.length,1,'resuming does not retry the interrupted operation');
  }finally{await restored.close();}
});

test('verified restart can reconcile a completed run without pausing or executing it again',async t=>{
  const {operations,options,create,engine,inbox}=await harness(t),deployment=await create(),job=await operations.trigger(deployment.id);
  await operations.poll();const runId=operations.getJob(job.id).attempts[0].runId;await operations.close();engine.finish(runId);await inbox.reconcile();
  const restored=new OperationsStore(options);restored.kick=()=>{};
  try{
    await restored.init({preservePausedState:true});
    assert.equal(restored.status().paused,false);assert.equal(restored.getJob(job.id).status,'completed');assert.equal(restored.getJob(job.id).attempts[0].runId,runId);
    await restored.poll();assert.equal(engine.calls.length,1);
  }finally{await restored.close();}
});

test('shutdown drains admitted trigger writes, rejects new work, and never dispatches a late job',async t=>{
  const {operations,engine,create}=await harness(t);const deployment=await create(),entered=deferred(),release=deferred(),save=operations.save.bind(operations);operations.save=async next=>{entered.resolve();await release.promise;return save(next);};const triggering=operations.trigger(deployment.id,{idempotencyKey:'admitted'});await entered.promise;let closed=false;const closing=operations.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);await assert.rejects(operations.trigger(deployment.id),{status:503});release.resolve();const job=await triggering;await closing;assert.equal(operations.getJob(job.id).status,'queued');assert.equal(engine.calls.length,0);
});

test('bounded trigger data cannot override a workflow and storage failures preserve committed state',async t=>{
  const {operations,create,directory}=await harness(t);const deployment=await create();await assert.rejects(operations.trigger(deployment.id,{payload:'x'.repeat(65537)}),/64 KiB/);await assert.rejects(operations.trigger(deployment.id,{payload:'x'.repeat(50000)}),/execution limit/);await assert.rejects(create({retry:{maxAttempts:4,backoffSeconds:1}}),/Additional retry/);assert.equal(operations.snapshot().jobs.length,0);
  const file=path.join(directory,'operations.json'),held=path.join(directory,'held-operations.json');await rename(file,held);await mkdir(file);await assert.rejects(operations.update(deployment.id,{name:'Uncommitted name'}));assert.equal(operations.getDeployment(deployment.id).name,'Fixture operation');assert.equal(operations.status().healthy,false);await rmdir(file);await rename(held,file);await operations.update(deployment.id,{name:'Recovered operation'});assert.equal(operations.status().healthy,true);
  await operations.close();await writeFile(file,'{ corrupt operations');const restored=await new OperationsStore({dataDir:directory,inbox:operations.inbox,engine:operations.engine}).init();assert.equal(restored.recovered,true);assert.ok((await readdir(directory)).some(name=>name.startsWith('operations.json.corrupt-')));await restored.close();
});

test('fast real settlement during dispatch is not lost when scheduler notifications arrive before the poll completes',async t=>{
  const {operations,engine,create}=await harness(t,{automatic:true});engine.onStart=run=>engine.finish(run.id);const deployment=await create(),job=await operations.trigger(deployment.id);await until(()=>operations.getJob(job.id).status==='completed');assert.equal(engine.calls.length,1);assert.equal(operations.getJob(job.id).attempts[0].status,'completed');
});

test('new interval deployments allow more than four overlapping runs when capacity is unlimited',async t=>{
  const {operations,engine,create,advance}=await harness(t,{capacity:null});const deployment=await create({enabled:true,trigger:{type:'interval',everySeconds:10}});assert.equal(deployment.overlap,'parallel');
  for(let index=0;index<7;index++){advance(10000);await operations.poll();}
  assert.equal(engine.executions.size,7);assert.equal(operations.snapshot().jobs.length,7);assert.equal(operations.getDeployment(deployment.id).skippedOverlaps,0);assert.ok(operations.snapshot().jobs.every(job=>job.status==='running'&&job.definition.overlap==='parallel'));
  const receipt=operations.snapshot().jobs[0];await operations.poll();assert.equal(engine.calls.length,7);assert.equal(operations.getJob(receipt.id).attempts.length,1);
});

test('an execution settings change wakes waiting operation jobs without requiring another settlement',async t=>{
  const {operations,engine,create}=await harness(t,{automatic:true});const deployment=await create(),first=await operations.trigger(deployment.id),second=await operations.trigger(deployment.id);await until(()=>operations.getJob(first.id).status==='running');assert.equal(operations.getJob(second.id).status,'queued');engine.maxConcurrentRuns=null;engine.emit('event',{type:'execution.settings',data:{maxConcurrentRuns:null}});await until(()=>operations.getJob(second.id).status==='running');assert.equal(engine.executions.size,2);assert.equal(operations.getJob(first.id).status,'running');
});

test('queued deployment runs stay FIFO without blocking another deployment or releasing a stopping lease',async t=>{
  const {operations,engine,create}=await harness(t,{capacity:null});const serial=await create({overlap:'queue'}),parallel=await create({name:'Independent job'}),first=await operations.trigger(serial.id),second=await operations.trigger(serial.id),other=await operations.trigger(parallel.id);await operations.poll();await operations.poll();
  assert.equal(operations.getJob(first.id).status,'running');assert.equal(operations.getJob(second.id).status,'queued');assert.equal(operations.getJob(other.id).status,'running');assert.equal(engine.calls.length,2);
  const runId=operations.getJob(first.id).attempts[0].runId;engine.finish(runId,'cancelled',{settled:false});await operations.poll();assert.equal(engine.calls.length,2);engine.finish(runId,'cancelled');await operations.poll();assert.equal(operations.getJob(second.id).status,'running');assert.equal(operations.getJob(other.id).status,'running');assert.equal(operations.status().paused,false);assert.equal(engine.calls.length,3);
});

test('queued interval ticks are retained, and changing overlap admits waiting snapshots without replay',async t=>{
  const {operations,engine,create,advance}=await harness(t,{capacity:null});const deployment=await create({enabled:true,trigger:{type:'interval',everySeconds:10},overlap:'queue'});
  for(let index=0;index<3;index++){advance(10000);await operations.poll();}
  assert.equal(engine.calls.length,1);assert.equal(operations.snapshot().jobs.length,3);assert.equal(operations.getDeployment(deployment.id).skippedOverlaps,0);const original=operations.snapshot().jobs.find(job=>job.status==='queued');
  await operations.update(deployment.id,{overlap:'parallel',workflow:workflow('new-future-model')});await operations.poll();await operations.poll();assert.equal(engine.calls.length,3);assert.equal(operations.getJob(original.id).definition.overlap,'queue');assert.equal(operations.getJob(original.id).definition.workflow.nodes[1].model,'deployed-model');assert.equal(operations.getJob(original.id).attempts.length,1);assert.equal(engine.executions.size,3);
});

test('one exhausted operation failure does not freeze waiting work on another deployment',async t=>{
  const {operations,inbox,engine,create}=await harness(t);const failed=await create(),independent=await create({name:'Independent deployment'}),first=await operations.trigger(failed.id),second=await operations.trigger(independent.id);await operations.poll();engine.finish(operations.getJob(first.id).attempts[0].runId,'failed',{error:'Isolated observed failure'});await operations.poll();assert.equal(operations.getJob(first.id).status,'failed');assert.equal(operations.getJob(second.id).status,'running');assert.equal(operations.status().paused,false);assert.equal(inbox.status().paused,false);
});

test('a confirmed admission rejection fails only that operation and leaves unrelated jobs runnable',async t=>{
  const {operations,inbox,engine,create}=await harness(t);const invalid=await create({input:'Reject this configured task'}),valid=await create({name:'Valid independent task'}),first=await operations.trigger(invalid.id),second=await operations.trigger(valid.id),start=engine.startRun.bind(engine);engine.startRun=value=>{if(value.input.task==='Reject this configured task')throw Object.assign(new Error('The configured model is unavailable.'),{status:400});return start(value);};await operations.poll();assert.equal(operations.getJob(first.id).status,'failed');assert.match(operations.getJob(first.id).error,/configured model/);assert.equal(inbox.status().paused,false);assert.equal(operations.status().paused,false);await operations.poll();assert.equal(operations.getJob(second.id).status,'running');assert.equal(engine.calls.length,1);await operations.poll();assert.equal(engine.calls.length,1);
});

test('existing operation snapshots migrate old interval coalescing without changing explicit parallel choices',async t=>{
  const {operations,create,options,directory}=await harness(t);const legacy=await create({enabled:true,trigger:{type:'interval',everySeconds:10}}),manual=await create(),explicit=await create({enabled:true,trigger:{type:'interval',everySeconds:10},overlap:'parallel'}),job=await operations.trigger(legacy.id);await operations.close();
  const file=path.join(directory,'operations.json'),saved=JSON.parse(await readFile(file,'utf8'));for(const deployment of saved.deployments.filter(value=>value.id!==explicit.id))delete deployment.overlap;delete saved.jobs[0].definition.overlap;await writeFile(file,JSON.stringify(saved));const restored=await new OperationsStore(options).init();restored.kick=()=>{};
  try{assert.equal(restored.getDeployment(legacy.id).overlap,'skip');assert.equal(restored.getDeployment(manual.id).overlap,'parallel');assert.equal(restored.getDeployment(explicit.id).overlap,'parallel');assert.equal(restored.getJob(job.id).definition.overlap,'skip');assert.equal(restored.status().paused,true);assert.equal(restored.engine.calls.length,0);await assert.rejects(restored.update(legacy.id,{overlap:'invented'}),/parallel jobs/);assert.equal(restored.getDeployment(legacy.id).overlap,'skip');}finally{await restored.close();}
});

for(const status of ['uncertain','confirmed'])test(`a failed operation with a ${status} external receipt holds retries durably without blocking unrelated work`,async t=>{
  const f=await harness(t),{operations,engine,create,advance,options}=f,deployment=await create({retry:{maxAttempts:3,backoffSeconds:1}}),job=await operations.trigger(deployment.id),independent=await create({name:'Independent operation'}),other=await operations.trigger(independent.id);
  await operations.poll();const runId=operations.getJob(job.id).attempts[0].runId;await externalReceipt(t,f,runId,{status});engine.finish(runId,'failed',{error:'The final local verification failed after the remote action.'});await operations.poll();
  let saved=operations.getJob(job.id);assert.equal(saved.status,'failed');assert.equal(saved.nextAttemptAt,null);assert.equal(saved.error,'The final local verification failed after the remote action.');assert.equal(saved.retryHold.code,'EXTERNAL_ACTION_RECONCILE');assert.equal(saved.retryHold.runId,runId);assert.deepEqual(saved.retryHold.receipts,[{id:'fixture-publication',status}]);assert.equal(saved.retryHold.backupRecovery,false);assert.equal(operations.status().retryHeld,1);assert.equal(operations.status().paused,false);assert.equal(operations.getJob(other.id).status,'running');
  advance(100000);await operations.poll();assert.equal(engine.calls.length,2);await assert.rejects(operations.retryJob(job.id),{status:409,code:'EXTERNAL_ACTION_RECONCILE',runId});assert.equal(operations.snapshot().jobs.length,2);assert.equal(saved.attempts.length,1);
  engine.finish(operations.getJob(other.id).attempts[0].runId);await operations.poll();await operations.close();engine.runs.delete(runId);const restored=await new OperationsStore(options).init();restored.kick=()=>{};
  try{assert.equal(restored.status().paused,true);assert.deepEqual(restored.getJob(job.id).retryHold,saved.retryHold);await restored.resume();await restored.poll();await assert.rejects(restored.retryJob(job.id),{code:'EXTERNAL_ACTION_RECONCILE'});assert.equal(restored.status().retryHeld,1);assert.equal(engine.calls.length,2);}finally{await restored.close();}
});

test('a prepared external draft with no attempt still allows the configured failure retry',async t=>{
  const f=await harness(t),{operations,engine,create,advance}=f,deployment=await create({retry:{maxAttempts:1,backoffSeconds:1}}),job=await operations.trigger(deployment.id);await operations.poll();const runId=operations.getJob(job.id).attempts[0].runId;await externalReceipt(t,f,runId,{status:'prepared'});engine.finish(runId,'failed',{error:'Stopped before the send permit.'});await operations.poll();assert.equal(operations.getJob(job.id).status,'retry_wait');assert.equal(operations.getJob(job.id).retryHold,undefined);advance(1000);await operations.poll();assert.equal(engine.calls.length,2);assert.equal(operations.getJob(job.id).attempts.length,2);assert.equal(operations.status().retryHeld,0);
});

test('an old retry-wait receipt is inspected before its fresh task can dispatch',async t=>{
  const f=await harness(t),{operations,engine,create,advance,options,directory}=f,deployment=await create({retry:{maxAttempts:1,backoffSeconds:1}}),job=await operations.trigger(deployment.id);await operations.poll();const runId=operations.getJob(job.id).attempts[0].runId;engine.finish(runId,'failed');await operations.poll();assert.equal(operations.getJob(job.id).status,'retry_wait');await operations.close();await externalReceipt(t,f,runId,{status:'confirmed'});
  const saved=JSON.parse(await readFile(path.join(directory,'operations.json'),'utf8'));assert.equal(saved.jobs[0].retryHold,undefined);advance(100000);const restored=await new OperationsStore(options).init();restored.kick=()=>{};
  try{assert.equal(restored.getJob(job.id).status,'failed');assert.equal(restored.getJob(job.id).retryHold.receipts[0].status,'confirmed');await restored.resume();await restored.poll();assert.equal(engine.calls.length,1);assert.equal(restored.getJob(job.id).attempts.length,1);}finally{await restored.close();}
});

test('backup recovery before a saved attempt holds new operation tasks even when the older backup only contains a draft',async t=>{
  const f=await harness(t),{operations,engine,create,advance}=f,deployment=await create({retry:{maxAttempts:2,backoffSeconds:1}}),job=await operations.trigger(deployment.id);await operations.poll();const runId=operations.getJob(job.id).attempts[0].runId;await externalReceipt(t,f,runId,{status:'prepared',backupRecovery:true});assert.equal(engine.runs.get(runId).taskState.externalActions,undefined);assert.equal(engine.runs.get(runId).taskState.externalRecovery.required,true);engine.finish(runId,'failed');await operations.poll();const saved=operations.getJob(job.id);assert.equal(saved.status,'failed');assert.equal(saved.retryHold.backupRecovery,true);assert.deepEqual(saved.retryHold.receipts,[]);advance(10000);await operations.poll();await assert.rejects(operations.retryJob(job.id),{code:'EXTERNAL_ACTION_RECONCILE'});assert.equal(engine.calls.length,1);
});

test('explicit retry inspects already-settled and older attempt receipts before admitting a new job',async t=>{
  const f=await harness(t),{operations,engine,create,advance}=f,deployment=await create({retry:{maxAttempts:1,backoffSeconds:1}}),job=await operations.trigger(deployment.id);await operations.poll();const originalRun=operations.getJob(job.id).attempts[0].runId;engine.finish(originalRun,'failed');await operations.poll();advance(1000);await operations.poll();engine.finish(operations.getJob(job.id).attempts[1].runId,'failed');await operations.poll();assert.equal(operations.getJob(job.id).retryHold,undefined);await externalReceipt(t,f,originalRun,{status:'confirmed'});await assert.rejects(operations.retryJob(job.id),{code:'EXTERNAL_ACTION_RECONCILE',runId:originalRun});assert.equal(operations.getJob(job.id).retryHold.runId,originalRun);assert.equal(operations.snapshot().jobs.length,1);assert.equal(engine.calls.length,2);
});

for(const status of ['completed','failed','cancelled'])test(`removing a settled ${status} inbox history row preserves the operation's actual terminal outcome`,async t=>{
  const {operations,inbox,engine,create,advance}=await harness(t),deployment=await create(),job=await operations.trigger(deployment.id);await operations.poll();const attempt=operations.getJob(job.id).attempts[0];engine.finish(attempt.runId,status,{error:status==='failed'?'Observed worker failure':undefined});await inbox.reconcile();await inbox.remove(attempt.inboxId);assert.equal(inbox.get(attempt.inboxId).deletedFrom,status);
  await operations.poll();const saved=operations.getJob(job.id);assert.equal(saved.status,status);assert.equal(saved.attempts[0].status,status);assert.equal(saved.attempts[0].runId,attempt.runId);assert.equal(saved.error,status==='failed'?'Observed worker failure':null);advance(100000);await operations.poll();assert.equal(engine.calls.length,1);assert.equal(operations.status().paused,false);
});

test('removing an unstarted inbox task still cancels its operation without using the configured failure retries',async t=>{
  const {operations,inbox,engine,create,advance}=await harness(t),deployment=await create({retry:{maxAttempts:3,backoffSeconds:1}}),job=await operations.trigger(deployment.id),add=inbox.add.bind(inbox);inbox.add=async value=>{const item=await add(value);await inbox.remove(item.id);return inbox.get(item.id);};await operations.poll();const saved=operations.getJob(job.id);assert.equal(saved.status,'cancelled');assert.equal(saved.attempts[0].status,'cancelled');assert.equal(inbox.get(saved.attempts[0].inboxId).deletedFrom,'queued');advance(100000);await operations.poll();assert.equal(engine.calls.length,0);assert.equal(saved.attempts.length,1);assert.equal(operations.status().paused,false);
});

for(const field of ['inboxId','runId','enqueueKey'])test(`a conflicting operation ${field} cannot adopt another receipt or retry alongside its real run`,async t=>{
  const {operations,inbox,engine,create,cwd}=await harness(t,{capacity:null}),deployment=await create(),job=await operations.trigger(deployment.id);await operations.poll();const original=operations.getJob(job.id).attempts[0],foreign=await inbox.add({input:'A separate task',cwd,workflow:workflow('foreign-model'),enqueueKey:'foreign-key'}),{run}=await inbox.runNow(foreign.id);engine.finish(run.id);await inbox.reconcile();const next=structuredClone(operations.state),attempt=next.jobs[0].attempts[0],wrong={inboxId:foreign.id,runId:run.id,enqueueKey:'foreign-key'}[field];attempt[field]=wrong;await operations.save(next);
  await operations.poll();const interrupted=operations.getJob(job.id);assert.equal(interrupted.status,'interrupted');assert.match(interrupted.error,/different/);assert.equal(interrupted.attempts[0][field],wrong,'conflicting saved identifiers remain available for inspection');assert.equal(operations.status().paused,true);assert.equal(engine.runs.get(original.runId).status,'running');assert.equal(engine.calls.length,2);
  await assert.rejects(operations.retryJob(job.id),{status:409,code:'OPERATION_ATTEMPT_ACTIVE'});assert.equal(operations.snapshot().jobs.length,1);engine.finish(original.runId,'cancelled',{settled:false});await operations.poll();await assert.rejects(operations.retryJob(job.id),{code:'OPERATION_ATTEMPT_ACTIVE'});assert.equal(engine.calls.length,2);
  engine.finish(original.runId,'cancelled');await inbox.reconcile();const retried=await operations.retryJob(job.id);assert.equal(retried.retryOf,job.id);assert.equal(retried.attempts.length,0);await operations.resume({resumeInbox:true});await operations.poll();assert.equal(operations.getJob(retried.id).status,'running');assert.equal(engine.calls.length,3);
});

test('a conflicting run binding preserves the actual inbox run external hold before that run is pruned',async t=>{
  const f=await harness(t),{operations,inbox,engine,create}=f,deployment=await create({retry:{maxAttempts:3,backoffSeconds:1}}),job=await operations.trigger(deployment.id);await operations.poll();const original=operations.getJob(job.id).attempts[0];await externalReceipt(t,f,original.runId,{status:'uncertain'});engine.finish(original.runId,'failed');await inbox.reconcile();const next=structuredClone(operations.state);next.jobs[0].attempts[0].runId='unknown-saved-run';await operations.save(next);await operations.poll();const interrupted=operations.getJob(job.id);assert.equal(interrupted.status,'interrupted');assert.equal(interrupted.retryHold.runId,original.runId);assert.equal(interrupted.attempts[0].runId,'unknown-saved-run');engine.runs.delete(original.runId);await assert.rejects(operations.retryJob(job.id),{code:'EXTERNAL_ACTION_RECONCILE'});assert.equal(engine.calls.length,1);assert.equal(operations.snapshot().jobs.length,1);
});

for(const outcome of ['failed','cancelled'])test(`removing a running deployment preserves its settled ${outcome} attempt without retrying or releasing a stopping lease early`,async t=>{
  const {operations,engine,create,advance}=await harness(t),deployment=await create({retry:{maxAttempts:3,backoffSeconds:1}}),job=await operations.trigger(deployment.id);
  await operations.poll();const original=operations.getJob(job.id).attempts[0],error=`Observed ${outcome} attempt after removal`;
  await operations.remove(deployment.id);engine.finish(original.runId,outcome,{settled:false,error});await operations.poll();
  assert.equal(operations.getJob(job.id).status,'running');assert.equal(operations.status().availableCapacity,OPERATIONS_LIMITS.jobs-1);assert.ok(engine.executions.has(original.runId));
  await assert.rejects(operations.retryJob(job.id),/Wait for this job to settle/);
  engine.finish(original.runId,outcome,{error});await operations.poll();const saved=operations.getJob(job.id);
  assert.equal(saved.status,outcome);assert.equal(saved.error,error);assert.equal(saved.attempts[0].status,outcome);assert.equal(saved.attempts[0].error,error);assert.equal(saved.attempts[0].runId,original.runId);assert.equal(saved.attempts[0].inboxId,original.inboxId);
  assert.equal(saved.finishedAt,saved.attempts[0].finishedAt);assert.equal(saved.nextAttemptAt,null);assert.equal(saved.retryStoppedReason,'The deployment was removed. No further retry attempts will start.');
  assert.equal(operations.status().availableCapacity,OPERATIONS_LIMITS.jobs);assert.equal(operations.status().paused,false);assert.equal(operations.status().queued,0);
  advance(3600000);await operations.poll();await operations.poll();assert.equal(engine.calls.length,1);assert.equal(saved.attempts.length,1);
  await assert.rejects(operations.retryJob(job.id),/Restore or create the deployment/);assert.equal(operations.snapshot().jobs.length,1);
});

test('removing a waiting retry retains the actual failure and cancels only unstarted work, with both receipts durable after restart',async t=>{
  const {operations,engine,create,advance,options}=await harness(t),deployment=await create({retry:{maxAttempts:2,backoffSeconds:1}}),job=await operations.trigger(deployment.id);
  await operations.poll();engine.finish(operations.getJob(job.id).attempts[0].runId,'failed',{error:'The actual last worker failure.'});await operations.poll();const waiting=operations.getJob(job.id),queued=await operations.trigger(deployment.id);
  assert.equal(waiting.status,'retry_wait');await operations.remove(deployment.id);const settled=operations.getJob(job.id),unstarted=operations.getJob(queued.id);
  assert.equal(settled.status,'failed');assert.equal(settled.error,waiting.error);assert.deepEqual(settled.attempts,waiting.attempts);assert.equal(settled.finishedAt,waiting.attempts[0].finishedAt);assert.equal(settled.nextAttemptAt,null);
  assert.equal(unstarted.status,'cancelled');assert.deepEqual(unstarted.attempts,[]);assert.match(unstarted.error,/before this job started/);assert.equal(unstarted.nextAttemptAt,null);
  assert.equal(operations.status().availableCapacity,OPERATIONS_LIMITS.jobs);await operations.close();const restored=await new OperationsStore(options).init();restored.kick=()=>{};
  try{
    assert.deepEqual(restored.getJob(job.id),settled);assert.deepEqual(restored.getJob(queued.id),unstarted);
    await restored.resume();advance(3600000);await restored.poll();assert.equal(engine.calls.length,1);
    for(const id of [job.id,queued.id])await assert.rejects(restored.retryJob(id),/Restore or create the deployment/);
    assert.equal(restored.status().availableCapacity,OPERATIONS_LIMITS.jobs);assert.equal(restored.snapshot().jobs.length,2);
  }finally{await restored.close();}
});

for(const missing of [false,true])test(`restart repairs a legacy retry wait whose deployment is ${missing?'missing':'removed'}, preserving the original failure receipt`,async t=>{
  const {operations,inbox,engine,create,advance,options,directory}=await harness(t),deployment=await create({retry:{maxAttempts:1,backoffSeconds:1}}),job=await operations.trigger(deployment.id);
  await operations.poll();engine.finish(operations.getJob(job.id).attempts[0].runId,'failed',{error:'Saved failure before deployment removal.'});await operations.poll();const waiting=operations.getJob(job.id);assert.equal(waiting.status,'retry_wait');
  await inbox.remove(waiting.attempts[0].inboxId);engine.runs.delete(waiting.attempts[0].runId);await operations.close();
  const file=path.join(directory,'operations.json'),saved=JSON.parse(await readFile(file,'utf8'));
  if(missing)saved.deployments=[];else{saved.deployments[0].removed=true;saved.deployments[0].enabled=false;}
  await writeFile(file,JSON.stringify(saved));advance(3600000);const restored=await new OperationsStore(options).init();restored.kick=()=>{};
  try{
    const repaired=restored.getJob(job.id);assert.equal(repaired.status,'failed');assert.equal(repaired.error,waiting.error);assert.deepEqual(repaired.attempts,waiting.attempts);assert.equal(repaired.nextAttemptAt,null);assert.equal(repaired.finishedAt,waiting.attempts[0].finishedAt);
    assert.equal(repaired.retryStoppedReason,missing?'The deployment is no longer available. No further retry attempts will start.':'The deployment was removed. No further retry attempts will start.');
    assert.equal(restored.status().availableCapacity,OPERATIONS_LIMITS.jobs);assert.equal(restored.list().length,0);assert.equal(restored.status().paused,true);
    await restored.resume();await restored.poll();await assert.rejects(restored.retryJob(job.id),/Restore or create the deployment/);assert.equal(engine.calls.length,1);assert.equal(restored.snapshot().jobs.length,1);
    assert.equal(JSON.parse(await readFile(file,'utf8')).jobs[0].retryStoppedReason,repaired.retryStoppedReason);
  }finally{await restored.close();}
});

test('a saved removed-deployment retry wait cannot override a live stopping attempt and releases capacity after its real cancellation settles',async t=>{
  const {operations,engine,create,options,directory,advance}=await harness(t),deployment=await create({retry:{maxAttempts:1,backoffSeconds:1}}),job=await operations.trigger(deployment.id);
  await operations.poll();const attempt=operations.getJob(job.id).attempts[0];engine.finish(attempt.runId,'cancelled',{settled:false,error:'The user stopped this worker.'});await operations.close();
  const file=path.join(directory,'operations.json'),saved=JSON.parse(await readFile(file,'utf8'));saved.deployments[0].removed=true;saved.deployments[0].enabled=false;saved.jobs[0].status='retry_wait';saved.jobs[0].nextAttemptAt=0;saved.jobs[0].attempts[0].status='failed';
  await writeFile(file,JSON.stringify(saved));const restored=await new OperationsStore(options).init();restored.kick=()=>{};
  try{
    assert.equal(restored.getJob(job.id).status,'retry_wait');assert.equal(restored.getJob(job.id).nextAttemptAt,null);assert.match(restored.getJob(job.id).retryStoppedReason,/deployment was removed/);assert.equal(restored.status().availableCapacity,OPERATIONS_LIMITS.jobs-1);assert.ok(engine.executions.has(attempt.runId));
    await restored.resume();advance(3600000);await restored.poll();assert.equal(engine.calls.length,1);await assert.rejects(restored.retryJob(job.id),/Wait for this job to settle/);
    engine.finish(attempt.runId,'cancelled',{error:'The user stopped this worker.'});await restored.poll();const settled=restored.getJob(job.id);
    assert.equal(settled.status,'cancelled');assert.equal(settled.attempts[0].status,'cancelled');assert.equal(settled.error,'The user stopped this worker.');assert.equal(settled.attempts[0].runId,attempt.runId);assert.equal(settled.nextAttemptAt,null);assert.match(settled.retryStoppedReason,/deployment was removed/);
    assert.equal(restored.status().availableCapacity,OPERATIONS_LIMITS.jobs);await assert.rejects(restored.retryJob(job.id),/Restore or create the deployment/);await restored.poll();assert.equal(engine.calls.length,1);
  }finally{await restored.close();}
});

test('removing a retry wait preserves a newly observed external-action hold alongside its failed attempt',async t=>{
  const f=await harness(t),{operations,engine,create}=f,deployment=await create({retry:{maxAttempts:2,backoffSeconds:1}}),job=await operations.trigger(deployment.id);
  await operations.poll();const runId=operations.getJob(job.id).attempts[0].runId;engine.finish(runId,'failed',{error:'Verification failed after an external action.'});await operations.poll();assert.equal(operations.getJob(job.id).status,'retry_wait');
  await externalReceipt(t,f,runId,{status:'confirmed'});await operations.remove(deployment.id);const settled=operations.getJob(job.id);
  assert.equal(settled.status,'failed');assert.equal(settled.error,'Verification failed after an external action.');assert.equal(settled.retryHold.code,'EXTERNAL_ACTION_RECONCILE');assert.equal(settled.retryHold.runId,runId);assert.deepEqual(settled.retryHold.receipts,[{id:'fixture-publication',status:'confirmed'}]);assert.match(settled.retryStoppedReason,/deployment was removed/);assert.equal(settled.nextAttemptAt,null);
  assert.equal(operations.status().availableCapacity,OPERATIONS_LIMITS.jobs);await assert.rejects(operations.retryJob(job.id),{code:'EXTERNAL_ACTION_RECONCILE'});assert.equal(engine.calls.length,1);
});

test('removing an unstarted dispatch intent after Stop cancels the intent and frees its job capacity',async t=>{
  const {operations,inbox,engine,create}=await harness(t),deployment=await create(),job=await operations.trigger(deployment.id),entered=deferred(),release=deferred(),save=operations.save.bind(operations);let delayed=false;
  operations.save=async next=>{if(!delayed&&next.jobs[0].status==='dispatching'){delayed=true;entered.resolve();await release.promise;}return save(next);};
  const polling=operations.poll();await entered.promise;const stopping=operations.pause('Explicit Stop before enqueue');release.resolve();await polling;await stopping;
  assert.equal(operations.getJob(job.id).status,'dispatching');assert.equal(inbox.snapshot().items.length,0);assert.equal(engine.calls.length,0);
  await operations.remove(deployment.id);const cancelled=operations.getJob(job.id);
  assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.attempts[0].status,'cancelled');assert.equal(cancelled.attempts[0].runId,null);assert.equal(cancelled.attempts[0].inboxId,null);assert.equal(cancelled.nextAttemptAt,null);assert.match(cancelled.error,/before this job started/);assert.equal(operations.status().availableCapacity,OPERATIONS_LIMITS.jobs);
  assert.equal(operations.status().paused,true);assert.equal(operations.status().pauseReason,'Explicit Stop before enqueue');await operations.resume();await operations.poll();assert.equal(engine.calls.length,0);await assert.rejects(operations.retryJob(job.id),/Restore or create the deployment/);
});

test('removal follows the exact run behind an older queued receipt with a missing inbox binding until settlement',async t=>{
  const {operations,engine,create}=await harness(t),deployment=await create({retry:{maxAttempts:2,backoffSeconds:1}}),job=await operations.trigger(deployment.id);
  await operations.poll();const original=operations.getJob(job.id).attempts[0],stale=structuredClone(operations.state);stale.jobs[0].status='queued';stale.jobs[0].attempts[0].status='queued';stale.jobs[0].attempts[0].inboxId=null;await operations.save(stale);
  await operations.remove(deployment.id);const tracked=operations.getJob(job.id);assert.equal(tracked.attempts[0].inboxId,original.inboxId);assert.equal(tracked.attempts[0].runId,original.runId);assert.equal(tracked.status,'running');assert.equal(operations.status().availableCapacity,OPERATIONS_LIMITS.jobs-1);assert.ok(engine.executions.has(original.runId));
  engine.finish(original.runId,'cancelled',{settled:false});await operations.poll();assert.equal(operations.status().availableCapacity,OPERATIONS_LIMITS.jobs-1);await assert.rejects(operations.retryJob(job.id),/Wait for this job to settle/);
  engine.finish(original.runId,'cancelled');await operations.poll();assert.equal(operations.getJob(job.id).status,'cancelled');assert.equal(operations.status().availableCapacity,OPERATIONS_LIMITS.jobs);assert.equal(operations.getJob(job.id).attempts.length,1);assert.equal(engine.calls.length,1);
});
