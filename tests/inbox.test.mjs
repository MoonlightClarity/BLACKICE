import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, rmdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskInbox, engineAtCapacity } from '../lib/inbox.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
import { createHarnessServer } from '../server.mjs';
import { recordFixturePlan } from './fixture-task-plan.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const until=async(check,label='inbox condition')=>{const end=Date.now()+5000;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail(`${label} did not settle`);};
const workflow=()=>({id:'saved-workflow',name:'Saved model task',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',name:'Agent',prompt:'Verify the task.',model:'saved-model',context:{preset:'900k'}},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1}});
class Engine extends EventEmitter{
  constructor(capacity=1){super();this.runs=new Map();this.executions=new Map();this.calls=[];this.closed=false;this.beforeStart=null;this.maxConcurrentRuns=capacity;}
  listRuns(){return structuredClone([...this.runs.values()]);}
  executionStatus(){const activeRunIds=[...new Set([...this.executions.keys(),...this.listRuns().filter(run=>run.settled===false||['queued','running','waiting'].includes(run.status)).map(run=>run.id)])];return{activeRunIds,activeRunCount:activeRunIds.length,capacity:this.maxConcurrentRuns,unlimited:this.maxConcurrentRuns===null,availableSlots:this.closed?0:this.maxConcurrentRuns===null?null:Math.max(0,this.maxConcurrentRuns-activeRunIds.length)};}
  async startRun(value){this.calls.push(structuredClone(value));if(this.beforeStart)await this.beforeStart(value);if(this.maxConcurrentRuns!==null&&this.executionStatus().availableSlots<=0)throw Object.assign(new Error('Engine is busy'),{status:409});const id=`run-${this.calls.length}`,run={id,status:'running',settled:false,metadata:structuredClone(value.metadata),input:value.input.task,cwd:value.input.cwd};this.runs.set(id,run);this.executions.set(id,true);return structuredClone(run);}
  finish(id,status='completed',{settled=true,error}={}){const run=this.runs.get(id);Object.assign(run,{status,settled,error,finishedAt:new Date().toISOString()});if(settled)this.executions.delete(id);this.emit('event',{type:'run.updated',runId:id,data:structuredClone(run)});return run;}
}
async function harness(t,{capacity=1}={}){const directory=await mkdtemp(path.join(tmpdir(),'relay-inbox-test-')),cwd=path.join(directory,'workspace');await mkdir(cwd);const engine=new Engine(capacity),options={dataDir:directory,engine,createWorkflow:()=>workflow()},inbox=await new TaskInbox(options).init();t.after(async()=>{await inbox.close().catch(()=>{});assert.match(path.basename(directory),/^relay-inbox-test-/);await rm(directory,{recursive:true,force:true});});const add=(input='Verify the fixture',extra={})=>inbox.add({input,cwd,workflow:workflow(),...extra});return{directory,cwd,engine,inbox,options,add};}

test('capture, ordered edits, scoped views, attachment snapshots, remove and restore are durable without starting work',async t=>{
  const {inbox,engine,add,options,cwd}=await harness(t);const first=await add('First task',{attachmentIds:['attachment_1']}),second=await add('Second task');assert.equal(inbox.status().autoRun,false);assert.equal(engine.calls.length,0);
  const edited=await inbox.update(first.id,{input:'Edited first task',expectedRevision:first.revision});assert.equal(edited.workflow.nodes[1].model,'saved-model');assert.deepEqual(edited.attachmentIds,['attachment_1']);await assert.rejects(inbox.update(first.id,{input:'Stale text',expectedRevision:1}),{status:409});
  await inbox.reorder([second.id,first.id]);assert.deepEqual(inbox.snapshot().items.map(item=>item.id),[second.id,first.id]);await assert.rejects(inbox.reorder([first.id]),/every queued task/);
  await inbox.remove(first.id);assert.equal(inbox.get(first.id).status,'deleted');await inbox.restore(first.id);assert.equal(inbox.get(first.id).status,'queued');assert.equal(inbox.snapshot({cwd:path.join(cwd,'other')}).items.length,0);
  const detached=inbox.snapshot();detached.items[0].input='Mutated outside';assert.equal(inbox.get(second.id).input,'Second task');
  await inbox.close();const restored=await new TaskInbox(options).init();assert.equal(restored.get(first.id).input,'Edited first task');assert.deepEqual(restored.get(first.id).attachmentIds,['attachment_1']);assert.equal(restored.status().pending,2);await restored.close();
});

test('an explicit start writes its dispatch intent before engine admission and passes saved model, folder and attachments',async t=>{
  const {inbox,engine,add,directory,cwd}=await harness(t);const item=await add('Start exactly once',{attachmentIds:['fixture_image']});engine.beforeStart=async request=>{const disk=JSON.parse(await readFile(path.join(directory,'inbox.json'),'utf8')),saved=disk.items[0];assert.equal(saved.status,'dispatching');assert.equal(saved.dispatchId,request.metadata.inboxDispatchId);assert.equal(request.metadata.inboxId,item.id);};
  const started=await inbox.runNow(item.id);assert.equal(started.item.runId,started.run.id);assert.equal(engine.calls[0].workflow.nodes[1].model,'saved-model');assert.equal(engine.calls[0].input.cwd,cwd);assert.deepEqual(engine.calls[0].input.attachmentIds,['fixture_image']);await assert.rejects(inbox.runNow(item.id),{status:409});assert.equal(engine.calls.length,1);
  await assert.rejects(inbox.remove(item.id),{status:409});await assert.rejects(inbox.update(item.id,{input:'Too late'}),{status:409});engine.finish(started.run.id);await until(()=>inbox.get(item.id).status==='completed');await inbox.remove(item.id);await inbox.restore(item.id);assert.equal(inbox.get(item.id).status,'completed','restoring completed work never requeues it');
});

test('tasks can be captured while the engine is busy, and optional autorun preserves order and waits for full settlement',async t=>{
  const {inbox,engine,add}=await harness(t);engine.runs.set('manual-run',{id:'manual-run',status:'running',settled:false});engine.executions.set('manual-run',true);
  const first=await add('First queued task'),second=await add('Second queued task');await inbox.configure({autoRun:true});await tick();assert.equal(engine.calls.length,0);assert.equal(inbox.status().pending,2);await assert.rejects(inbox.runNow(first.id),{status:409});
  engine.finish('manual-run');await until(()=>inbox.get(first.id).runId);assert.equal(engine.calls[0].input.task,'First queued task');const firstRun=inbox.get(first.id).runId;
  engine.finish(firstRun,'completed',{settled:false});await tick();assert.equal(engine.calls.length,1,'terminal status alone cannot release the foreground lease');engine.finish(firstRun);await until(()=>inbox.get(second.id).runId);assert.equal(engine.calls[1].input.task,'Second queued task');engine.finish(inbox.get(second.id).runId);await until(()=>inbox.get(second.id).status==='completed');assert.equal(inbox.status().pending,0);
});

for(const status of ['failed','cancelled'])test(`${status} execution pauses autorun until explicit resume; retry retains the previous attempt`,async t=>{
  const {inbox,engine,add}=await harness(t);const first=await add('May fail'),second=await add('Must wait');await inbox.configure({autoRun:true});await until(()=>inbox.get(first.id).runId);engine.finish(inbox.get(first.id).runId,status,{error:'Observed fixture issue'});await until(()=>inbox.status().paused);await tick();assert.equal(engine.calls.length,1);assert.equal(inbox.get(first.id).status,status);assert.match(inbox.status().pauseReason,new RegExp(status));
  const retry=await inbox.retry(first.id);assert.equal(retry.status,'queued');assert.equal(retry.attempts.length,1);assert.equal(retry.attempts[0].status,status);assert.equal(retry.runId,null);await tick();assert.equal(engine.calls.length,1);await inbox.reorder([first.id,second.id]);await inbox.resume();await until(()=>engine.calls.length===2);assert.equal(engine.calls[1].input.task,'May fail');assert.notEqual(inbox.get(first.id).dispatchId,retry.attempts[0].dispatchId);
});

test('emergency pause latches immediately and prevents an automatic dispatch waiting for its intent write',async t=>{
  const {inbox,engine,add}=await harness(t);const item=await add();const entered=deferred(),release=deferred(),save=inbox.save.bind(inbox);let delayed=false;inbox.save=async next=>{if(!delayed&&next.items.some(value=>value.status==='dispatching')){delayed=true;entered.resolve();await release.promise;}return save(next);};
  await inbox.configure({autoRun:true});await entered.promise;const pausing=inbox.pause('Emergency stop');assert.equal(inbox.status().paused,true);release.resolve();await pausing;await until(()=>!inbox.pumping);assert.equal(engine.calls.length,0);assert.equal(inbox.get(item.id).status,'queued');assert.equal(inbox.get(item.id).attempts[0].status,'cancelled_before_start');await inbox.resume();await until(()=>engine.calls.length===1);
});

test('a user stop prevents the next queued task even after the stopped run acknowledges cancellation',async t=>{
  const {inbox,engine,add}=await harness(t);const first=await add('Active'),second=await add('Saved next');await inbox.configure({autoRun:true,pauseOnFailure:false});await until(()=>inbox.get(first.id).runId);await inbox.pause('Stopped by the user');engine.finish(inbox.get(first.id).runId,'cancelled');await until(()=>inbox.get(first.id).status==='cancelled');await tick();assert.equal(engine.calls.length,1);assert.equal(inbox.get(second.id).status,'queued');await inbox.resume();await until(()=>engine.calls.length===2);
});

test('restart reconciles an unbound dispatch by actual run metadata and never blindly repeats it',async t=>{
  const {inbox,engine,add,options,directory}=await harness(t);const item=await add();await inbox.configure({autoRun:true});await until(()=>inbox.get(item.id).runId);await inbox.close();const data=JSON.parse(await readFile(path.join(directory,'inbox.json'),'utf8'));data.items[0].status='dispatching';data.items[0].runId=null;data.items[0].attempts[0].runId=null;await writeFile(path.join(directory,'inbox.json'),JSON.stringify(data));
  engine.finish(engine.listRuns()[0].id,'completed');const restored=await new TaskInbox(options).init();assert.equal(restored.get(item.id).status,'completed');assert.equal(restored.get(item.id).runId,engine.listRuns()[0].id);assert.equal(restored.status().paused,true);assert.match(restored.status().pauseReason,/restarted/);await tick();assert.equal(engine.calls.length,1);await restored.close();
});

test('an intent without a saved run becomes interrupted and requires explicit requeue after restart',async t=>{
  const {inbox,engine,add,options,directory}=await harness(t);const item=await add();await inbox.close();const data=JSON.parse(await readFile(path.join(directory,'inbox.json'),'utf8'));Object.assign(data.items[0],{status:'dispatching',dispatchId:'uncertain-dispatch'});data.items[0].attempts=[{dispatchId:'uncertain-dispatch',runId:null,status:'dispatching'}];await writeFile(path.join(directory,'inbox.json'),JSON.stringify(data));
  const restored=await new TaskInbox(options).init();assert.equal(restored.get(item.id).status,'interrupted');await assert.rejects(restored.runNow(item.id),/Requeue/);assert.equal(engine.calls.length,0);await restored.retry(item.id);await restored.runNow(item.id);assert.equal(engine.calls.length,1);assert.equal(restored.get(item.id).attempts.length,2);await restored.close();
});

test('a failed post-admission bind is recovered from metadata without starting a duplicate',async t=>{
  const {inbox,engine,add,options}=await harness(t);const item=await add(),save=inbox.save.bind(inbox);inbox.save=async next=>{if(next.items[0].status==='running')throw new Error('Fixture bind failure');return save(next);};await assert.rejects(inbox.runNow(item.id),/bind failure/);assert.equal(engine.calls.length,1);assert.equal(inbox.get(item.id).status,'dispatching');await inbox.close();engine.finish('run-1');
  const restored=await new TaskInbox(options).init();assert.equal(restored.get(item.id).status,'completed');assert.equal(restored.get(item.id).runId,'run-1');assert.equal(engine.calls.length,1);await restored.close();
});

test('an admission acknowledgement failure keeps the one actual run instead of requeueing its task',async t=>{
  const {inbox,engine,add}=await harness(t);const item=await add('Run this task once even if admission acknowledgement fails'),start=engine.startRun.bind(engine);
  engine.startRun=async request=>{await start(request);throw new Error('Fixture acknowledgement lost after admission');};
  const receipt=await inbox.runNow(item.id);assert.equal(receipt.admissionRecovered,true);assert.equal(receipt.run.id,'run-1');assert.equal(inbox.get(item.id).status,'running');assert.equal(inbox.get(item.id).attempts[0].admissionRecovered,true);assert.equal(engine.calls.length,1);
  await assert.rejects(inbox.runNow(item.id),{status:409});engine.finish('run-1');await inbox.reconcile();assert.equal(inbox.get(item.id).status,'completed');await inbox.configure({autoRun:true});await tick();assert.equal(engine.calls.length,1);
});

test('conflicting admission receipts stay interrupted with their dispatch identity preserved',async t=>{
  const {inbox,engine,add}=await harness(t);const item=await add('Inspect ambiguous admission'),start=engine.startRun.bind(engine);
  engine.startRun=async request=>{const run=await start(request);engine.runs.set('duplicate-receipt',{...run,id:'duplicate-receipt'});throw new Error('Fixture conflicting acknowledgement');};
  await assert.rejects(inbox.runNow(item.id),/More than one run/);const saved=inbox.get(item.id);assert.equal(saved.status,'interrupted');assert.ok(saved.dispatchId);assert.equal(saved.attempts[0].dispatchId,saved.dispatchId);assert.equal(inbox.status().paused,true);assert.equal(engine.calls.length,1);
});

test('shutdown drains admitted saves, prevents a pending dispatch, and rejects later mutations',async t=>{
  const {inbox,engine,add}=await harness(t);const entered=deferred(),release=deferred(),save=inbox.save.bind(inbox);inbox.save=async next=>{entered.resolve();await release.promise;return save(next);};const adding=add('Admitted task');await entered.promise;let closed=false;const closing=inbox.close().then(()=>{closed=true;});await tick();assert.equal(closed,false);await assert.rejects(add('Too late'),{status:503});release.resolve();const item=await adding;await closing;assert.equal(inbox.get(item.id).input,'Admitted task');assert.equal(engine.calls.length,0);
});

test('invalid input and corrupt live storage never discard a valid inbox; its backup remains recoverable',async t=>{
  const {inbox,add,directory,options}=await harness(t);await add('First durable task');await add('Second durable task');await assert.rejects(inbox.add({input:'',cwd:directory}),/nonempty/);await assert.rejects(inbox.add({input:'Task',cwd:'relative'}),/absolute/);await assert.rejects(inbox.add({input:'Task',cwd:directory,attachmentIds:['same','same']}),/unique/);await inbox.close();const file=path.join(directory,'inbox.json');await writeFile(file,'{ broken inbox');const recovered=await new TaskInbox(options).init();assert.equal(recovered.recovered,true);assert.equal(recovered.status().count,1);assert.ok((await readdir(directory)).some(name=>name.startsWith('inbox.json.corrupt-')));await recovered.close();
});

test('a failed storage mutation leaves the committed in-memory tasks intact and a later save recovers health',async t=>{
  const {inbox,add,directory}=await harness(t);const item=await add('Committed task'),file=path.join(directory,'inbox.json'),held=path.join(directory,'held-inbox.json');await rename(file,held);await mkdir(file);await assert.rejects(inbox.update(item.id,{input:'Uncommitted edit'}));assert.equal(inbox.get(item.id).input,'Committed task');assert.equal(inbox.status().healthy,false);await rmdir(file);await rename(held,file);await inbox.update(item.id,{input:'Recovered edit'});assert.equal(inbox.status().healthy,true);assert.equal(inbox.get(item.id).input,'Recovered edit');
});

test('manual foreground work winning the admission race defers automatic execution without treating it as a failed task',async t=>{
  const {inbox,engine,add}=await harness(t);const item=await add(),entered=deferred(),release=deferred(),save=inbox.save.bind(inbox);let delayed=false;inbox.save=async next=>{if(!delayed&&next.items[0].status==='dispatching'){delayed=true;entered.resolve();await release.promise;}return save(next);};
  await inbox.configure({autoRun:true});await entered.promise;engine.runs.set('priority-run',{id:'priority-run',status:'running',settled:false});engine.executions.set('priority-run',true);release.resolve();await until(()=>inbox.get(item.id).attempts[0]?.status==='deferred');assert.equal(inbox.get(item.id).status,'queued');assert.equal(inbox.status().paused,false);assert.equal(inbox.get(item.id).error,null);
  engine.finish('priority-run');await until(()=>inbox.get(item.id).runId);assert.equal(inbox.get(item.id).attempts.length,2);assert.equal(engine.calls.length,2,'the first call was rejected before an actual run existed');
});

test('another chat winning the final slot during Run now does not pause unrelated queued work',async t=>{
  const {inbox,engine,add}=await harness(t);const item=await add('Manual start waiting for durable intent'),entered=deferred(),release=deferred(),save=inbox.save.bind(inbox);let delayed=false;inbox.save=async next=>{if(!delayed&&next.items[0].status==='dispatching'){delayed=true;entered.resolve();await release.promise;}return save(next);};const starting=inbox.runNow(item.id);starting.catch(()=>{});await entered.promise;engine.runs.set('priority-run',{id:'priority-run',status:'running',settled:false});engine.executions.set('priority-run',true);release.resolve();await assert.rejects(starting,{status:409});assert.equal(inbox.get(item.id).status,'queued');assert.equal(inbox.get(item.id).attempts[0].status,'deferred');assert.equal(inbox.get(item.id).error,null);assert.equal(inbox.status().paused,false);
});

test('Stop also cancels a previously admitted explicit start waiting behind another inbox save',async t=>{
  const {inbox,engine,add}=await harness(t);const item=await add(),entered=deferred(),release=deferred(),save=inbox.save.bind(inbox);let delay=true;inbox.save=async next=>{if(delay){delay=false;entered.resolve();await release.promise;}return save(next);};const editing=inbox.update(item.id,{title:'An admitted edit'});await entered.promise;
  const starting=inbox.runNow(item.id);starting.catch(()=>{});const paused=inbox.pause('Emergency stop after Run now');release.resolve();await editing;await assert.rejects(starting,/stopped before execution/);await paused;assert.equal(engine.calls.length,0);assert.equal(inbox.get(item.id).status,'queued');
});

test('real engine admission persists inbox metadata before any runtime action and waits for background learning to stop',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'relay-inbox-engine-')),cwd=path.join(directory,'workspace');await mkdir(cwd);const release=deferred(),entered=deferred();let calls=0,stopping=0;
  const runtime={status:()=>({connected:true,authenticated:true}),runAgent:async options=>{calls++;const runs=JSON.parse(await readFile(path.join(directory,'runs.json'),'utf8')),saved=runs.find(run=>run.metadata?.inboxId);assert.ok(saved,'admission is on disk before runtime execution');const queue=JSON.parse(await readFile(path.join(directory,'inbox.json'),'utf8'));assert.equal(queue.items[0].dispatchId,saved.metadata.inboxDispatchId);entered.resolve();return{output:'Verified real engine fixture.',threadId:'inbox-fixture-thread'};}};
  const learning={cancelBackground:()=>{stopping++;return release.promise;},getContext:()=>({lessons:[],skills:[],facts:[],truncated:false}),scheduleAfterRun:async()=>{}};
  const engine=await new HarnessEngine({runtime,dataDir:directory,defaultCwd:cwd,learning}).init(),inbox=await new TaskInbox({dataDir:directory,engine}).init();t.after(async()=>{release.resolve();await inbox.close();await engine.close();assert.match(path.basename(directory),/^relay-inbox-engine-/);await rm(directory,{recursive:true,force:true});});
  const item=await inbox.add({input:'Use the persisted admission journal',cwd,workflow:workflow()}),started=await inbox.runNow(item.id);assert.equal(started.run.metadata.inboxId,item.id);assert.equal(stopping,1);await tick();assert.equal(calls,0);release.resolve();await entered.promise;await until(()=>inbox.get(item.id).status==='completed');assert.equal(calls,1);assert.equal(inbox.get(item.id).runId,started.run.id);
});

test('HTTP inbox capture stays usable while a real task runs, auth applies, and stopping one chat leaves queued work eligible',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'relay-inbox-http-')),dataDir=path.join(directory,'data'),cwd=path.join(directory,'workspace'),entered=deferred();let calls=0;
  class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,defaultModel:'saved-model',models:[{model:'saved-model'}]};}async start(){return this.status();}async close(){}async runAgent(options){await recordFixturePlan(options);calls++;if(calls===1){entered.resolve();await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('Fixture stopped'),{name:'AbortError'})),{once:true}));}return{output:'Verified queued HTTP fixture.',threadId:'http-inbox-thread'};}}
  class Desktop extends EventEmitter{status(){return{available:false,enabled:false};}async setEnabled(){return this.status();}}
  const app=await createHarnessServer({dataDir,defaultCwd:cwd,port:0,maxConcurrentRuns:1,runtime:new Runtime(),desktop:new Desktop()});await app.learning.updateSettings({mode:'manual'});const url=await app.listen(),home=await fetch(url),cookie=home.headers.get('set-cookie').split(';',1)[0];await home.arrayBuffer();
  t.after(async()=>{await app.close();assert.match(path.basename(directory),/^relay-inbox-http-/);await rm(directory,{recursive:true,force:true});});
  const api=async(route,method='GET',body,auth=true)=>{const response=await fetch(new URL(route,url),{method,headers:{...(auth?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json()};};
  assert.equal((await api('/api/inbox','GET',undefined,false)).status,401);assert.equal((await api('/api/inbox','POST',{input:'Unauthorized',cwd},false)).status,401);
  const manual=app.engine.startRun({workflow:workflow(),input:'Manual foreground fixture'});await entered.promise;
  const added=await api('/api/inbox','POST',{input:'Saved through HTTP while busy',cwd,workflow:workflow()});assert.equal(added.status,201);const id=added.data.id;assert.equal((await api(`/api/inbox/${id}/run`,'POST',{})).status,409);assert.equal((await api('/api/inbox/settings','POST',{autoRun:true})).status,200);assert.equal((await api('/api/inbox')).data.status.pending,1);
  assert.equal((await api(`/api/runs/${manual.id}/cancel`,'POST',{})).status,200);await until(()=>app.engine.getRun(manual.id).settled);await until(()=>app.inbox.get(id).status==='completed');assert.equal(calls,2);assert.equal(app.inbox.status().paused,false);const run=app.engine.getRun(app.inbox.get(id).runId);assert.equal(run.metadata.inboxId,id);assert.equal(run.workflow.nodes[1].model,'saved-model');
  assert.equal((await api('/api/inbox','POST',{input:'Missing attachment',cwd,attachmentIds:['missing_attachment']})).status,400);
});

for(const action of ['cancel','close'])test(`${action} while the real engine admission save is pending cannot start inference or the next inbox task`,async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'relay-inbox-admission-')),cwd=path.join(directory,'workspace');await mkdir(cwd);let calls=0;
  const runtime={status:()=>({connected:true,authenticated:true}),runAgent:async()=>{calls++;return{output:'Should never execute'};}};
  const engine=await new HarnessEngine({runtime,dataDir:directory,defaultCwd:cwd,maxConcurrentRuns:1}).init(),inbox=await new TaskInbox({dataDir:directory,engine}).init();
  const entered=deferred(),release=deferred(),persist=engine.persist.bind(engine);let delayed=false;engine.persist=async()=>{if(!delayed&&engine.runs.size){delayed=true;entered.resolve();await release.promise;}return persist();};
  t.after(async()=>{release.resolve();await inbox.close();await engine.close();assert.match(path.basename(directory),/^relay-inbox-admission-/);await rm(directory,{recursive:true,force:true});});
  const first=await inbox.add({input:'Cancel before inference',cwd,workflow:workflow()}),second=await inbox.add({input:'Keep next task saved',cwd,workflow:workflow()});await inbox.configure({autoRun:true});await entered.promise;await until(()=>inbox.get(first.id).runId);const runId=inbox.get(first.id).runId;
  let closing;if(action==='cancel'){await inbox.pause('Stop while admission is saving');engine.cancelRun(runId);}else{await inbox.close();closing=engine.close();}
  await tick();assert.equal(calls,0);assert.equal(engine.getRun(runId).status,'cancelled');release.resolve();if(closing)await closing;await until(()=>engine.getRun(runId).settled);if(action==='cancel')await until(()=>inbox.get(first.id).status==='cancelled');
  assert.equal(calls,0);assert.equal(inbox.get(second.id).status,'queued');assert.equal(engine.controllers.size,0);assert.equal(engine.executions.size,0);const disk=JSON.parse(await readFile(path.join(directory,'runs.json'),'utf8'));assert.equal(disk.find(run=>run.id===runId).status,'cancelled');
});

test('a pump admitted before failure reconciliation cannot bypass pause-on-failure while waiting behind an inbox write',async t=>{
  const {inbox,engine,add}=await harness(t);const first=await add('Will fail'),second=await add('Must remain queued');await inbox.configure({autoRun:true});await until(()=>inbox.get(first.id).runId&&!inbox.pumping);
  const entered=deferred(),release=deferred(),save=inbox.save.bind(inbox);let delayed=false;inbox.save=async next=>{if(!delayed&&next.items.find(item=>item.id===second.id)?.title==='Edited queued task'){delayed=true;entered.resolve();await release.promise;}return save(next);};
  const editing=inbox.update(second.id,{title:'Edited queued task'});await entered.promise;const pumping=inbox.pump();engine.finish(inbox.get(first.id).runId,'failed',{error:'Observed failure before queued pump admission'});release.resolve();await editing;await pumping;await until(()=>inbox.get(first.id).status==='failed');
  assert.equal(engine.calls.length,1,'the next task must not start before applying failure reconciliation');assert.equal(inbox.get(second.id).status,'queued');assert.equal(inbox.status().paused,true);
});

test('automation enqueue keys persistently deduplicate concurrent capture and reject different task snapshots',async t=>{
  const {inbox,add,options}=await harness(t);const [first,duplicate]=await Promise.all([add('One automated task',{enqueueKey:'operation:job-1:1',managedBy:'operations'}),add('One automated task',{enqueueKey:'operation:job-1:1',managedBy:'operations'})]);assert.equal(first.id,duplicate.id);assert.equal(inbox.snapshot().items.length,1);await assert.rejects(add('A different task',{enqueueKey:'operation:job-1:1',managedBy:'operations'}),{status:409});await assert.rejects(inbox.update(first.id,{input:'Change an immutable job'}),/deployment/);await inbox.close();
  const restored=await new TaskInbox(options).init();assert.equal(restored.getByEnqueueKey('operation:job-1:1').id,first.id);const same=await restored.add({input:first.input,cwd:first.cwd,workflow:first.workflow,enqueueKey:'operation:job-1:1',managedBy:'operations'});assert.equal(same.id,first.id);assert.equal(restored.snapshot().items.length,1);await restored.close();
});

test('global inbox autorun skips managed operation jobs and still starts ordinary saved tasks',async t=>{
  const {inbox,engine,add}=await harness(t);const managed=await add('Operation-controlled task',{enqueueKey:'operation:job-2:1',managedBy:'operations'});await inbox.configure({autoRun:true});await inbox.pump();assert.equal(inbox.hasPendingWork(),false);assert.equal(engine.calls.length,0);const ordinary=await add('Ordinary task');await until(()=>inbox.get(ordinary.id).runId);assert.equal(engine.calls.length,1);assert.equal(engine.calls[0].input.task,'Ordinary task');assert.equal(inbox.get(managed.id).status,'queued');
});

test('explicitly queued conversations start in order after full settlement without enabling unrelated saved tasks',async t=>{
  const {inbox,engine,add,cwd}=await harness(t);engine.runs.set('foreground',{id:'foreground',status:'running',settled:false});engine.executions.set('foreground',true);
  const saved=await add('Keep this ordinary task saved'),first=await inbox.queue({input:'First explicit conversation',cwd,workflow:workflow(),enqueueKey:'conversation:first',attachmentIds:['attached_file']}),second=await inbox.queue({input:'Second explicit conversation',cwd,workflow:workflow(),enqueueKey:'conversation:second'});
  assert.equal(inbox.status().autoRun,false);assert.equal(inbox.status().pending,3);assert.equal(inbox.status().scheduled,2);assert.equal(inbox.status().ready,2);await tick();assert.equal(engine.calls.length,0);
  engine.finish('foreground','completed',{settled:false});await tick();assert.equal(engine.calls.length,0);engine.finish('foreground');await until(()=>inbox.get(first.id).runId);assert.equal(engine.calls[0].input.task,first.input);assert.deepEqual(engine.calls[0].input.attachmentIds,['attached_file']);assert.equal(engine.calls[0].workflow.nodes[1].model,'saved-model');assert.equal(inbox.get(saved.id).status,'queued');
  engine.finish(inbox.get(first.id).runId);await until(()=>inbox.get(second.id).runId);assert.equal(engine.calls[1].input.task,second.input);engine.finish(inbox.get(second.id).runId);await until(()=>inbox.get(second.id).status==='completed');assert.equal(inbox.status().scheduled,0);assert.equal(inbox.hasPendingWork(),false);assert.equal(inbox.status().autoRun,false);assert.equal(inbox.get(saved.id).status,'queued');
});

test('queued conversation receipts deduplicate concurrent sends, changed content, and terminal resends durably',async t=>{
  const {inbox,engine,cwd,options}=await harness(t);await inbox.pause('Hold fixture work');const request={input:'Exactly one queued conversation',cwd,workflow:workflow(),enqueueKey:'conversation:stable-receipt'};
  const [first,second]=await Promise.all([inbox.queue(request),inbox.queue(request)]);assert.equal(first.id,second.id);assert.equal(first.startWhenIdle,true);assert.equal(first.source,'conversation');assert.equal(inbox.status().count,1);await assert.rejects(inbox.queue({...request,input:'Changed submitted text'}),{status:409});await assert.rejects(inbox.add(request),{status:409});
  await inbox.resume();await until(()=>inbox.get(first.id).runId);engine.finish(inbox.get(first.id).runId);await until(()=>inbox.get(first.id).status==='completed');await inbox.close();const restored=await new TaskInbox(options).init();
  try{assert.equal((await restored.queue(request)).id,first.id);await restored.pump();assert.equal(restored.get(first.id).status,'completed');assert.equal(engine.calls.length,1);assert.equal(restored.status().autoRun,false);}finally{await restored.close();}
});

test('pending explicit queue survives a clean restart while saved tasks remain passive',async t=>{
  const {inbox,engine,add,cwd,options}=await harness(t);engine.runs.set('foreground',{id:'foreground',status:'running',settled:false});engine.executions.set('foreground',true);const saved=await add('Saved before restart'),request={input:'Run this after restart when ready',cwd,workflow:workflow(),enqueueKey:'conversation:restart'},queued=await inbox.queue(request);await inbox.close();engine.finish('foreground');
  const restored=await new TaskInbox(options).init();try{assert.equal(restored.status().paused,false);assert.equal(restored.status().autoRun,false);assert.equal(restored.hasPendingWork(),true);await tick();assert.equal(engine.calls.length,0,'initialization waits for the server to finish provider startup');restored.kick();await until(()=>restored.get(queued.id).runId);assert.equal(restored.get(saved.id).status,'queued');assert.equal((await restored.queue(request)).id,queued.id);assert.equal(engine.calls.length,1);}finally{await restored.close();}
});

test('removing and restoring an explicitly queued task never rearms its previous execution request',async t=>{
  const {inbox,engine,cwd}=await harness(t);await inbox.pause('Hold queued fixture');const request={input:'May be removed before starting',cwd,workflow:workflow(),enqueueKey:'conversation:removed'},queued=await inbox.queue(request);await inbox.remove(queued.id);assert.equal(inbox.get(queued.id).startWhenIdle,false);assert.equal((await inbox.queue(request)).status,'deleted');await inbox.restore(queued.id);await inbox.resume();await inbox.pump();await tick();assert.equal(engine.calls.length,0);assert.equal(inbox.get(queued.id).status,'queued');assert.equal(inbox.hasPendingWork(),false);assert.equal(inbox.status().autoRun,false);
});

test('a queued conversation failure pauses subsequent requests and retry keeps failed history passive',async t=>{
  const {inbox,engine,cwd}=await harness(t);await inbox.pause('Capture both tasks first');const first=await inbox.queue({input:'Will fail',cwd,workflow:workflow(),enqueueKey:'conversation:failure'}),second=await inbox.queue({input:'Wait after failure',cwd,workflow:workflow(),enqueueKey:'conversation:after-failure'});await inbox.resume();await until(()=>inbox.get(first.id).runId);engine.finish(inbox.get(first.id).runId,'failed',{error:'Fixture execution failed'});await until(()=>inbox.get(first.id).status==='failed');await tick();assert.equal(inbox.status().paused,true);assert.equal(inbox.get(second.id).status,'queued');assert.equal(engine.calls.length,1);
  await inbox.retry(first.id);assert.equal(inbox.get(first.id).startWhenIdle,false);await inbox.resume();await until(()=>inbox.get(second.id).runId);assert.equal(engine.calls[1].input.task,second.input);assert.equal(inbox.get(first.id).status,'queued');assert.equal(inbox.status().autoRun,false);
});

test('Stop latches before a queued conversation dispatch intent finishes saving',async t=>{
  const {inbox,engine,cwd}=await harness(t);const entered=deferred(),release=deferred(),save=inbox.save.bind(inbox);let delayed=false;inbox.save=async next=>{if(!delayed&&next.items.some(item=>item.status==='dispatching')){delayed=true;entered.resolve();await release.promise;}return save(next);};
  const item=await inbox.queue({input:'Stop before inference begins',cwd,workflow:workflow(),enqueueKey:'conversation:stop-before-admission'});await entered.promise;const stopping=inbox.pause('Stopped by the user');assert.equal(inbox.status().paused,true);release.resolve();await stopping;await until(()=>!inbox.pumping);assert.equal(engine.calls.length,0);assert.equal(inbox.get(item.id).status,'queued');assert.equal(inbox.get(item.id).attempts[0].status,'cancelled_before_start');await inbox.resume();await until(()=>inbox.get(item.id).runId);assert.equal(engine.calls.length,1);
});

test('saved-task capture ignores injected queue flags and explicit queue requires its own stable receipt',async t=>{
  const {inbox,engine,add,cwd}=await harness(t);const saved=await add('Saving is still passive',{startWhenIdle:true,source:'conversation'});assert.equal(saved.startWhenIdle,undefined);assert.equal(saved.source,undefined);await inbox.pump();assert.equal(engine.calls.length,0);await assert.rejects(inbox.queue({input:'Missing receipt',cwd}),/stable enqueue key/);await assert.rejects(inbox.queue({input:'Managed operation',cwd,enqueueKey:'operation:conflict',managedBy:'operations'}),/cannot also/);assert.equal(inbox.status().count,1);
});

test('a queued dispatch acknowledgement failure binds the one actual run instead of replaying the message',async t=>{
  const {inbox,engine,cwd}=await harness(t);const start=engine.startRun.bind(engine);engine.startRun=async request=>{await start(request);throw new Error('Fixture acknowledgement lost');};const request={input:'Admit this queued message once',cwd,workflow:workflow(),enqueueKey:'conversation:lost-ack'},queued=await inbox.queue(request);await until(()=>inbox.get(queued.id).runId);assert.equal(inbox.get(queued.id).attempts[0].admissionRecovered,true);assert.equal((await inbox.queue(request)).runId,'run-1');assert.equal(engine.calls.length,1);engine.finish('run-1');await until(()=>inbox.get(queued.id).status==='completed');await inbox.pump();assert.equal(engine.calls.length,1);
});

test('an uncommitted queue write creates no dispatch and retrying the same receipt recovers once storage is writable',async t=>{
  const {inbox,engine,add,cwd,directory}=await harness(t);await add('Previously saved task');const file=path.join(directory,'inbox.json'),held=path.join(directory,'held-inbox.json'),request={input:'Keep this request until it is durable',cwd,workflow:workflow(),enqueueKey:'conversation:storage-retry'};await rename(file,held);await mkdir(file);
  await assert.rejects(inbox.queue(request));assert.equal(inbox.status().healthy,false);assert.equal(inbox.snapshot().items.length,1);assert.equal(engine.calls.length,0);await rmdir(file);await rename(held,file);const queued=await inbox.queue(request);assert.equal(inbox.status().healthy,true);await until(()=>inbox.get(queued.id).runId);assert.equal(engine.calls.length,1);assert.equal((await inbox.queue(request)).id,queued.id);
});

test('HTTP explicit conversation queue keeps saved tasks passive, authenticates capture, and archives exactly one actual run',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'relay-queued-http-')),dataDir=path.join(directory,'data'),cwd=path.join(directory,'workspace'),entered=deferred(),release=deferred();let calls=0;
  class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,defaultModel:'saved-model',models:[{model:'saved-model',available:true}]};}async start(){return this.status();}async close(){}async runAgent(options){await recordFixturePlan(options);calls++;if(calls===1){entered.resolve();await release.promise;}return{output:'Verified queued conversation HTTP fixture.',threadId:`queued-http-${calls}`};}}
  class Desktop extends EventEmitter{status(){return{available:false,enabled:false};}async setEnabled(){return this.status();}}
  const app=await createHarnessServer({dataDir,defaultCwd:cwd,port:0,maxConcurrentRuns:1,runtime:new Runtime(),desktop:new Desktop()});await app.learning.updateSettings({mode:'manual'});const url=await app.listen(),home=await fetch(url),cookie=home.headers.get('set-cookie').split(';',1)[0];await home.arrayBuffer();
  t.after(async()=>{release.resolve();await app.close();assert.match(path.basename(directory),/^relay-queued-http-/);await rm(directory,{recursive:true,force:true});});
  const api=async(route,method='GET',value,auth=true)=>{const response=await fetch(new URL(route,url),{method,headers:{...(auth?{Cookie:cookie}:{}),...(value===undefined?{}:{'Content-Type':'application/json'})},...(value===undefined?{}:{body:JSON.stringify(value)})});return{status:response.status,data:await response.json()};};
  const foreground=app.engine.startRun({workflow:workflow(),input:'Foreground HTTP fixture'});await entered.promise;const saved=await api('/api/inbox','POST',{input:'Keep this saved task passive',cwd,workflow:workflow()});assert.equal(saved.status,201);
  const request={input:'Queue this as its own conversation',cwd,workflow:workflow(),enqueueKey:'conversation:http-receipt'};assert.equal((await api('/api/inbox/queue','POST',request,false)).status,401);assert.equal((await api('/api/inbox/queue','POST',{...request,enqueueKey:undefined})).status,400);assert.equal((await api('/api/inbox/queue','POST',{...request,attachmentIds:['missing_attachment']})).status,400);
  const queued=await api('/api/inbox/queue','POST',request);assert.equal(queued.status,201);assert.equal(queued.data.startWhenIdle,true);assert.equal((await api('/api/inbox/queue','POST',request)).data.id,queued.data.id);assert.equal((await api('/api/inbox/queue','POST',{...request,input:'Changed content'})).status,409);assert.equal(app.inbox.status().autoRun,false);assert.equal(app.inbox.status().scheduled,1);assert.equal(calls,1);
  release.resolve();await until(()=>app.engine.getRun(foreground.id).settled);await until(()=>app.inbox.get(queued.data.id).status==='completed');const actual=app.engine.getRun(app.inbox.get(queued.data.id).runId);assert.equal(actual.metadata.inboxId,queued.data.id);assert.equal(actual.workflow.nodes[1].model,'saved-model');assert.equal(actual.input,request.input);assert.equal(app.inbox.get(saved.data.id).status,'queued');assert.equal(calls,2);assert.equal(app.inbox.status().autoRun,false);
  await app.conversations.chain;const family=await app.conversations.family(actual.id);assert.equal(family.runs.length,1);assert.equal(family.runs[0].id,actual.id);assert.equal((await api('/api/inbox/queue','POST',request)).data.runId,actual.id);await tick();assert.equal(calls,2);
});

test('explicit queued chats fill free slots and the next chat starts after one fully settled slot opens',async t=>{
  const {inbox,engine,add,cwd}=await harness(t,{capacity:2});await inbox.pause('Capture fixture queue');const saved=await add('Unrelated passive save'),items=[];for(let index=0;index<3;index++)items.push(await inbox.queue({input:`Parallel queued task ${index+1}`,cwd,workflow:workflow(),enqueueKey:`parallel:${index}`}));await inbox.resume();await until(()=>engine.calls.length===2&&items.slice(0,2).every(item=>inbox.get(item.id).runId));
  assert.equal(engine.executionStatus().availableSlots,0);assert.equal(inbox.get(items[2].id).status,'queued');assert.equal(inbox.get(saved.id).status,'queued');assert.equal(inbox.status().autoRun,false);const firstRun=inbox.get(items[0].id).runId;engine.finish(firstRun,'completed',{settled:false});await tick();assert.equal(engine.calls.length,2,'terminal status alone does not release a slot');engine.finish(firstRun);await until(()=>inbox.get(items[2].id).runId);assert.equal(engine.calls.length,3);assert.equal(engine.executionStatus().activeRunCount,2);assert.equal(inbox.get(items[1].id).status,'running');assert.equal(inbox.get(saved.id).status,'queued');
});

test('parallel explicit queues preserve failure pause without stopping another admitted chat',async t=>{
  const {inbox,engine,cwd}=await harness(t,{capacity:2});await inbox.pause('Capture fixture queue');const items=[];for(let index=0;index<3;index++)items.push(await inbox.queue({input:`Failure queue ${index}`,cwd,workflow:workflow(),enqueueKey:`parallel-failure:${index}`}));await inbox.resume();await until(()=>items.slice(0,2).every(item=>inbox.get(item.id).runId));engine.finish(inbox.get(items[0].id).runId,'failed',{error:'Observed failure in one parallel chat'});await until(()=>inbox.status().paused);await tick();assert.equal(engine.calls.length,2);assert.equal(inbox.get(items[1].id).status,'running');assert.equal(inbox.get(items[2].id).status,'queued');assert.equal(engine.executionStatus().availableSlots,1);await inbox.resume();await until(()=>inbox.get(items[2].id).runId);assert.equal(engine.calls.length,3);
});

test('stopping one explicitly queued chat frees its slot without pausing another chat or pending requests',async t=>{
  const {inbox,engine,cwd}=await harness(t,{capacity:2});await inbox.pause('Capture fixture queue');const items=[];for(let index=0;index<3;index++)items.push(await inbox.queue({input:`Independent stop ${index}`,cwd,workflow:workflow(),enqueueKey:`isolated-stop:${index}`}));await inbox.resume();await until(()=>items.slice(0,2).every(item=>inbox.get(item.id).runId));const stoppedRun=inbox.get(items[0].id).runId;engine.finish(stoppedRun,'cancelled',{settled:false});await tick();assert.equal(engine.calls.length,2);engine.finish(stoppedRun,'cancelled');await until(()=>inbox.get(items[2].id).runId);assert.equal(inbox.get(items[0].id).status,'cancelled');assert.equal(inbox.get(items[1].id).status,'running');assert.equal(inbox.status().paused,false);assert.equal(engine.calls.length,3);
});

test('global emergency pause still holds explicit pending chats after each active chat acknowledges cancellation',async t=>{
  const {inbox,engine,cwd}=await harness(t,{capacity:2});await inbox.pause('Capture fixture queue');const items=[];for(let index=0;index<3;index++)items.push(await inbox.queue({input:`Emergency stop ${index}`,cwd,workflow:workflow(),enqueueKey:`emergency-stop:${index}`}));await inbox.resume();await until(()=>items.slice(0,2).every(item=>inbox.get(item.id).runId));await inbox.pause('Emergency Stop');for(const item of items.slice(0,2))engine.finish(inbox.get(item.id).runId,'cancelled');await until(()=>items.slice(0,2).every(item=>inbox.get(item.id).status==='cancelled'));await inbox.pump();await tick();assert.equal(inbox.status().paused,true);assert.equal(inbox.status().pauseReason,'Emergency Stop');assert.equal(inbox.get(items[2].id).status,'queued');assert.equal(engine.calls.length,2);
});

test('saved-task autorun and explicitly queued chats share all user-selected slots in capture order',async t=>{
  const {inbox,engine,add,cwd}=await harness(t,{capacity:2});await inbox.pause('Capture tasks');const first=await add('First saved task'),second=await add('Second saved task'),explicit=await inbox.queue({input:'Explicit parallel chat',cwd,workflow:workflow(),enqueueKey:'parallel:alongside-saved'});await inbox.configure({autoRun:true});await inbox.resume();await until(()=>inbox.get(first.id).runId&&inbox.get(second.id).runId);assert.equal(engine.calls.length,2);assert.equal(inbox.get(explicit.id).status,'queued');assert.deepEqual(engine.calls.map(call=>call.input.task),['First saved task','Second saved task']);engine.finish(inbox.get(first.id).runId);await until(()=>inbox.get(explicit.id).runId);assert.equal(engine.calls.length,3);assert.equal(inbox.get(second.id).status,'running');
});

test('unlimited autorun admits more than four saved tasks and a user resize drains only when slots become free',async t=>{
  const {inbox,engine,add}=await harness(t,{capacity:null});await inbox.pause('Capture tasks');const items=[];for(let index=0;index<7;index++)items.push(await add(`Unlimited saved task ${index}`));await inbox.configure({autoRun:true,pauseOnFailure:false});await inbox.resume();await until(()=>items.every(item=>inbox.get(item.id).runId));assert.equal(engine.executions.size,7);assert.equal(engineAtCapacity(engine),false);
  engine.maxConcurrentRuns=2;const next=await add('Wait for user-selected two-slot limit');await inbox.pump();assert.equal(inbox.get(next.id).status,'queued');for(const item of items.slice(0,5))engine.finish(inbox.get(item.id).runId);await until(()=>items.slice(0,5).every(item=>inbox.get(item.id).status==='completed'));await inbox.pump();assert.equal(engine.calls.length,7);engine.finish(inbox.get(items[5].id).runId,'completed',{settled:false});await inbox.pump();assert.equal(engine.calls.length,7);engine.finish(inbox.get(items[5].id).runId);await until(()=>inbox.get(next.id).runId);assert.equal(engine.executions.size,2);assert.equal(inbox.get(items[6].id).status,'running');
});

test('capacity detection accepts unlimited status and legacy adapters while retaining shutdown and cancellation leases',()=>{
  const held={id:'held',status:'cancelled',settled:false},engine={closed:false,maxConcurrentRuns:null,listRuns:()=>[held],executionStatus:()=>({unlimited:true,capacity:null,availableSlots:null})};assert.equal(engineAtCapacity(engine),false);engine.closed=true;assert.equal(engineAtCapacity(engine),true);engine.closed=false;engine.executionStatus=()=>({capacity:1,availableSlots:0});assert.equal(engineAtCapacity(engine),true);delete engine.executionStatus;engine.maxConcurrentRuns=1;assert.equal(engineAtCapacity(engine),true);engine.maxConcurrentRuns=null;assert.equal(engineAtCapacity(engine),false);
});

test('raising or removing the user limit wakes saved tasks without waiting for another run to finish',async t=>{
  const {inbox,engine,add}=await harness(t);await inbox.pause('Capture tasks');const first=await add('First held task'),second=await add('Second held task'),third=await add('Third held task');await inbox.configure({autoRun:true});await inbox.resume();await until(()=>inbox.get(first.id).runId);assert.equal(inbox.get(second.id).status,'queued');engine.maxConcurrentRuns=2;engine.emit('event',{type:'execution.settings',data:{maxConcurrentRuns:2}});await until(()=>inbox.get(second.id).runId);assert.equal(inbox.get(third.id).status,'queued');engine.maxConcurrentRuns=null;engine.emit('event',{type:'execution.settings',data:{maxConcurrentRuns:null}});await until(()=>inbox.get(third.id).runId);assert.equal(engine.executions.size,3);assert.equal(inbox.get(first.id).status,'running');
});

test('queue receipt pins the authored default once and an offline later default cannot block replay',async t=>{
  const {inbox,engine,cwd}=await harness(t);await inbox.pause('Inspect queue receipt');let selected={providerId:'gateway',model:'original-model',available:true},lookups=0;engine.runtime={resolveModel:()=>{lookups++;return structuredClone(selected);},status:()=>({defaultModel:'gateway::original-model'})};const authored=workflow();authored.nodes[1].model='default';const request={input:'Pin this queue model',cwd,workflow:authored,enqueueKey:'queue:model-pin'},queued=await inbox.queue(request);assert.equal(queued.workflow.nodes[1].model,'gateway::original-model');assert.equal(authored.nodes[1].model,'default');assert.equal(lookups,1);
  selected={providerId:'gateway',model:'replacement-model',available:false,error:'Fixture provider offline'};const replay=await inbox.queue(request);assert.equal(replay.id,queued.id);assert.equal(replay.workflow.nodes[1].model,'gateway::original-model');assert.equal(lookups,1,'receipt replay does not resolve a changed default again');await assert.rejects(inbox.queue({...request,enqueueKey:'queue:new-offline'}),/Fixture provider offline/);assert.equal(inbox.status().count,1);
  selected={providerId:'codex',model:'native-default-model',available:true};const native=workflow();native.nodes[1].model='codex';const second=await inbox.queue({...request,workflow:native,enqueueKey:'queue:native-model-pin'});assert.equal(second.workflow.nodes[1].model,'native-default-model');
});
