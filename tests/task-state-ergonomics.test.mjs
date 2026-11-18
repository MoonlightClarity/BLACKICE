import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {TaskStateStore,createTaskToolHandler,TASK_TOOL} from '../lib/task-state.mjs';
const payload=r=>JSON.parse(r.contentItems[0].text);
const contract=(id='inspect')=>({contractVersion:2,goal:'Inspect the requested result',criteria:[{id:'checked',kind:'judgment',description:'Observed result supports conclusion'}],workItems:[{id,title:'Inspect result',objective:'Compare actual supplied evidence',owner:'coordinator',resourceKeys:['discovery'],effects:['observe'],dependsOn:[],criterionIds:['checked']}],instructions:[]});
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'blackice-task-ergonomics-')),store=await new TaskStateStore({dataDir:root}).init(),events=[];t.after(async()=>{await store.close();assert.equal(path.dirname(root),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});});const state=await store.ensure({taskId:'task-one',runId:'run',cwd:root,goal:'Inspect result',schemaVersion:14});const handler=createTaskToolHandler({store,taskId:state.taskId,runId:'run',nodeId:'agent',onEvent:e=>events.push(e)});return{store,state,events,call:args=>handler({name:'relay_task',arguments:args})};}
test('current canonical plan revision errors preserve bytes and emit no invented changes',async t=>{
 const f=await fixture(t),before=await readFile(f.store.file(f.state.taskId));
 for(const expectedRevision of [undefined,'1',0,f.state.revision+1]){const result=await f.call({action:'plan',...(expectedRevision===undefined?{}:{expectedRevision}),contract:contract()});assert.equal(result.success,false);assert.deepEqual(await readFile(f.store.file(f.state.taskId)),before);assert.equal(f.events.length,0);}
 const saved=await f.call({action:'plan',expectedRevision:f.state.revision,contract:contract()});assert.equal(saved.success,true);assert.equal(f.events.length,1);assert.equal((await f.store.get(f.state.taskId)).contract.workItems[0].id,'inspect');
});
test('current describe advertises exact canonical fields and rejects old misplaced steps without mutation',async t=>{
 const f=await fixture(t),description=payload(await f.call({action:'describe'}));assert.deepEqual(description.schema,TASK_TOOL.inputSchema);assert.deepEqual(description.actionFields.plan,['action','expectedRevision','contract']);
 const before=await f.store.get(f.state.taskId),result=await f.call({action:'plan',expectedRevision:before.revision,plan:{steps:[{id:'inspect',title:'Old shape'}]}});assert.equal(result.success,false);assert.equal(result.code,'TASK_CONTRACT_INVALID');assert.deepEqual(await f.store.get(f.state.taskId),before);assert.equal(f.events.length,0);
});
test('maximum-length current work ID round-trips without truncation and worker cannot change global checkpoint',async t=>{
 const f=await fixture(t),id='scope-'+'x'.repeat(114);const saved=await f.call({action:'plan',expectedRevision:f.state.revision,contract:contract(id)});assert.equal(saved.success,true);const state=await f.store.get(f.state.taskId);assert.equal(state.contract.workItems[0].id,id);
 const worker=createTaskToolHandler({store:f.store,taskId:f.state.taskId,runId:'run',nodeId:'worker',worker:true});const denied=await worker({name:'relay_task',arguments:{action:'checkpoint',expectedRevision:state.revision,goal:'Overwrite coordinator'}});assert.equal(denied.success,false);assert.equal(denied.code,'TASK_CONTRACT_OWNERSHIP');assert.deepEqual(await f.store.get(f.state.taskId),state);
});
