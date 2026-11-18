import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {TaskStateStore,createTaskToolHandler} from '../lib/task-state.mjs';
const prepare={operation:'prepare',receiptId:'one',destination:'https://example.invalid/result',content:'Exact authorized content'};
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'blackice-attempt-storage-')),stores=[];const open=async()=>{const store=await new TaskStateStore({dataDir:root}).init();stores.push(store);return store;};const store=await open();await store.ensure({taskId:'send-task',runId:'send-run',cwd:root,goal:'Observe result'});t.after(async()=>{for(const item of stores)await item.close();assert.equal(path.dirname(root),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});});return {store,open};}
test('stored external attempts remain uncertain through restart and cannot be retried without observed reconciliation',async t=>{
 const {store,open}=await fixture(t);
 let state=await store.get('send-task');state=await store.externalAction('send-task',prepare,{expectedRevision:state.revision,runId:'send-run'});
 state=await store.externalAction('send-task',{receiptId:'one',operation:'attempt'},{expectedRevision:state.revision,runId:'send-run'});assert.equal(state.externalActions[0].status,'uncertain');assert.equal(state.externalActionResult,undefined);
 await store.close();const restored=await open(),saved=await restored.get('send-task');assert.equal(saved.externalActions[0].status,'uncertain');assert.equal(saved.externalActionResult,undefined);
 await assert.rejects(restored.externalAction('send-task',{receiptId:'one',operation:'attempt'},{expectedRevision:saved.revision,runId:'send-run'}),{code:'EXTERNAL_ACTION_RECONCILE'});
 const confirmed=await restored.externalAction('send-task',{receiptId:'one',operation:'confirm',url:'https://example.invalid/result/one',evidence:'Observed exact authorized content at destination'},{expectedRevision:saved.revision,runId:'send-run'});assert.equal(confirmed.externalActions[0].status,'confirmed');
});
test('removed model attempt action cannot return a dispatch hint or modify retained receipt history',async t=>{
 const {store}=await fixture(t),before=await store.get('send-task'),events=[];
 const handler=createTaskToolHandler({store,taskId:'send-task',runId:'send-run',nodeId:'agent',onEvent:e=>events.push(e)});
 const result=await handler({name:'relay_task',arguments:{action:'external',expectedRevision:before.revision,external:prepare}});assert.equal(result.success,false);assert.equal(result.code,'TASK_CONTRACT_INVALID');assert.equal(JSON.parse(result.contentItems[0].text).externalActionResult,undefined);assert.deepEqual(await store.get('send-task'),before);assert.deepEqual(events,[]);
});
