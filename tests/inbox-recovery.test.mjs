import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {TaskInbox} from '../lib/inbox.mjs';
import {TaskStateStore} from '../lib/task-state.mjs';
import {createHarnessServer} from '../server.mjs';

const graph={id:'recovery-worker',name:'Recovery check',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',name:'Worker',model:'fixture-model',prompt:'Inspect the local fixture'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1}};
class Engine extends EventEmitter{
 constructor(){super();this.runs=new Map();this.calls=[];this.maxConcurrentRuns=null;}
 listRuns(){return structuredClone([...this.runs.values()]);}
 startRun(value){this.calls.push(value);const run={id:'recovery-'+this.calls.length,status:'running',settled:false,metadata:structuredClone(value.metadata),cwd:value.input.cwd,input:value.input.task};this.runs.set(run.id,run);return structuredClone(run);}
}
async function fixture(t){
 const cleanups=[],directory=await mkdtemp(path.join(tmpdir(),'blackice-inbox-recovery-')),cwd=path.join(directory,'workspace');await mkdir(cwd);const engine=new Engine(),options={dataDir:directory,engine},inbox=await new TaskInbox(options).init(),tasks=await new TaskStateStore({dataDir:directory}).init();
 t.after(async()=>{for(const cleanup of cleanups)await cleanup();await inbox.close().catch(()=>{});await tasks.close();assert.equal(path.dirname(directory),path.resolve(tmpdir()));assert.match(path.basename(directory),/^blackice-inbox-recovery-/);await rm(directory,{recursive:true,force:true});});
 const add=(extra={})=>inbox.add({input:'One authorized fixture operation',cwd,workflow:graph,...extra});
 async function external(runId,status){await tasks.ensure({taskId:runId,runId,nodeId:'agent',cwd,goal:'Fixture operation'});const mutate=async value=>tasks.externalAction(runId,value,{expectedRevision:(await tasks.get(runId)).revision,runId,nodeId:'agent'});await mutate({receiptId:'one-action',operation:'prepare',destination:'https://example.com/fixture',content:'A local test receipt; no remote request occurs.'});if(status!=='prepared')await mutate({receiptId:'one-action',operation:'attempt'});if(status==='confirmed')await mutate({receiptId:'one-action',operation:'confirm',url:'https://example.com/fixture/result',evidence:'Controlled test fixture receipt.'});engine.runs.get(runId).taskState=await tasks.get(runId);}
 return{directory,cwd,engine,inbox,tasks,options,add,external,cleanups};
}
for(const status of ['uncertain','confirmed'])test(`inbox cannot requeue ${status} external actions into a fresh task and its hold survives restart/history pruning`,async t=>{
 const f=await fixture(t),item=await f.add(),{run}=await f.inbox.runNow(item.id);await f.external(run.id,status);Object.assign(f.engine.runs.get(run.id),{status:'failed',settled:true,error:'Local verification failed',finishedAt:new Date().toISOString()});await f.inbox.reconcile();
 assert.equal(f.inbox.get(item.id).retryHold.runId,run.id);assert.equal(f.inbox.status().retryHeld,1);await assert.rejects(f.inbox.retry(item.id),{code:'EXTERNAL_ACTION_RECONCILE',status:409});assert.equal(f.inbox.get(item.id).status,'failed');assert.equal(f.engine.calls.length,1);
 await f.inbox.close();f.engine.runs.clear();const restored=await new TaskInbox(f.options).init();try{assert.equal(restored.get(item.id).retryHold.receipts[0].status,status);await assert.rejects(restored.retry(item.id),{code:'EXTERNAL_ACTION_RECONCILE'});assert.equal(f.engine.calls.length,1);}finally{await restored.close();}
});
test('an unsent prepared draft still permits explicit ordinary retry and keeps earlier attempt history',async t=>{
 const f=await fixture(t),item=await f.add(),{run}=await f.inbox.runNow(item.id);await f.external(run.id,'prepared');Object.assign(f.engine.runs.get(run.id),{status:'failed',settled:true});await f.inbox.reconcile();assert.equal(f.inbox.get(item.id).retryHold,undefined);await f.inbox.retry(item.id);await f.inbox.runNow(item.id);assert.equal(f.engine.calls.length,2);assert.equal(f.inbox.get(item.id).attempts.length,2);
});
test('backup rollback uncertainty holds retry even when the visible backup contains no external action',async t=>{
 const f=await fixture(t),item=await f.add(),{run}=await f.inbox.runNow(item.id);f.engine.runs.get(run.id).taskState={taskId:run.id,externalRecovery:{required:true}};Object.assign(f.engine.runs.get(run.id),{status:'cancelled',settled:true});await f.inbox.reconcile();await assert.rejects(f.inbox.retry(item.id),{code:'EXTERNAL_ACTION_RECONCILE'});assert.equal(f.inbox.get(item.id).retryHold.backupRecovery,true);assert.equal(f.engine.calls.length,1);
});
test('an older saved queued retry is held before engine admission and marked for inspection',async t=>{
 const f=await fixture(t),item=await f.add(),{run}=await f.inbox.runNow(item.id);Object.assign(f.engine.runs.get(run.id),{status:'failed',settled:true});await f.inbox.reconcile();await f.inbox.retry(item.id);await f.external(run.id,'uncertain');await assert.rejects(f.inbox.runNow(item.id),{code:'EXTERNAL_ACTION_RECONCILE'});assert.equal(f.inbox.get(item.id).status,'interrupted');assert.equal(f.inbox.get(item.id).retryHold.runId,run.id);assert.equal(f.engine.calls.length,1);
});
test('restart saves visible external uncertainty before interrupting a running task, so pruning cannot erase its hold',async t=>{
 const f=await fixture(t),item=await f.add(),{run}=await f.inbox.runNow(item.id);await f.external(run.id,'uncertain');await f.inbox.close();const restored=await new TaskInbox(f.options).init();try{assert.equal(restored.get(item.id).status,'interrupted');assert.equal(restored.get(item.id).retryHold.runId,run.id);f.engine.runs.clear();await assert.rejects(restored.retry(item.id),{code:'EXTERNAL_ACTION_RECONCILE'});assert.equal(f.engine.calls.length,1);}finally{await restored.close();}
});
test('operation-owned inbox tasks require the manager for starts and cannot be retried through inbox',async t=>{
 const f=await fixture(t),item=await f.add({managedBy:'operations',enqueueKey:'operation:one:1'});await assert.rejects(f.inbox.runNow(item.id),{code:'MANAGED_TASK'});assert.equal(f.engine.calls.length,0);const {run}=await f.inbox.runNow(item.id,{managedBy:'operations'});Object.assign(f.engine.runs.get(run.id),{status:'failed',settled:true});await f.inbox.reconcile();await assert.rejects(f.inbox.retry(item.id),{code:'MANAGED_TASK'});assert.equal(f.engine.calls.length,1);assert.equal(f.inbox.get(item.id).status,'failed');
});
test('a bound run belonging to another dispatch cannot settle an inbox task or report false completion',async t=>{
 const f=await fixture(t),item=await f.add(),{run}=await f.inbox.runNow(item.id);Object.assign(f.engine.runs.get(run.id),{status:'completed',settled:true,metadata:{inboxId:'another-task',inboxDispatchId:'unrelated'}});await f.inbox.reconcile();const saved=f.inbox.get(item.id);assert.equal(saved.status,'interrupted');assert.match(saved.error,/another dispatch/);assert.equal(f.inbox.status().paused,true);assert.equal(saved.attempts[0].status,'interrupted');
});
for(const status of ['running','completed'])test(`a repeated start/retry cannot rewrite a ${status} publication as interrupted`,async t=>{
 const f=await fixture(t),item=await f.add(),{run}=await f.inbox.runNow(item.id);await f.external(run.id,status==='running'?'uncertain':'confirmed');if(status==='completed'){Object.assign(f.engine.runs.get(run.id),{status:'completed',settled:true});await f.inbox.reconcile();}const before=f.inbox.get(item.id);for(const action of ['runNow','retry'])await assert.rejects(f.inbox[action](item.id),{status:409});assert.deepEqual(f.inbox.get(item.id),before);assert.equal(f.engine.calls.length,1);
});
test('HTTP callers cannot forge an internal managed-operation start or retry through request arguments',async t=>{
 const f=await fixture(t);let calls=0;
 class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,defaultModel:'fixture-model',models:[{model:'fixture-model'}]};}async start(){return this.status();}async close(){}async runAgent(){calls++;return{output:'Fixture completed',threadId:'fixture-thread'};}}
 class Desktop extends EventEmitter{status(){return{available:false,enabled:false};}async setEnabled(){return this.status();}}
 const app=await createHarnessServer({port:0,dataDir:path.join(f.directory,'http'),defaultCwd:f.cwd,runtime:new Runtime(),desktop:new Desktop(),autoAttachDesktop:false});f.cleanups.push(()=>app.close());await app.learning.updateSettings({mode:'manual'});const url=await app.listen(),home=await fetch(url),cookie=home.headers.get('set-cookie').split(';',1)[0];await home.arrayBuffer();
 const item=await app.inbox.add({input:'Managed fixture',cwd:f.cwd,workflow:graph,managedBy:'operations',enqueueKey:'operation:http:1'});
 for(const action of ['run','retry']){const response=await fetch(url+'/api/inbox/'+item.id+'/'+action,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({managedBy:'operations'})});assert.equal(response.status,409);assert.match((await response.json()).error,/operation/);}assert.equal(calls,0);assert.equal(app.inbox.get(item.id).status,'queued');
});
