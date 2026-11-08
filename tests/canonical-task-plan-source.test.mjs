import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {TaskStateStore} from '../lib/task-state.mjs';
import {DirectTaskRuntime} from '../lib/direct-task-runtime.mjs';
import {CanonicalTaskPlanSource} from '../lib/canonical-task-plan-source.mjs';
import {NativeTaskContextBridge} from '../lib/native-task-context-bridge.mjs';
import {createDirectTaskContractTools} from '../lib/direct-task-contract-tools.mjs';
const contract=()=>({contractVersion:2,goal:'Inspect sources',criteria:[{id:'a',kind:'observation',description:'Inspect A'},{id:'b',kind:'observation',description:'Inspect B'}],workItems:[{id:'a',title:'A',objective:'Inspect A',owner:'coordinator',resourceKeys:['origin:https://a.test'],effects:['observe'],dependsOn:[],criterionIds:['a']},{id:'b',title:'B',objective:'Inspect B',owner:'coordinator',resourceKeys:['origin:https://b.test'],effects:['observe'],dependsOn:[],criterionIds:['b']}],instructions:[]});
const client={id:'owner',scopes:['planning:write','browser:read']};
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'canonical-source-')),tasks=new TaskStateStore({dataDir:root}),runtime=new DirectTaskRuntime({dataDir:root});
 await tasks.ensure({taskId:'native',runId:'run',nodeId:'coordinator',cwd:root,schemaVersion:14});
 await tasks.setContract('native',contract(),{expectedRevision:(await tasks.get('native')).revision,schemaVersion:14});
 const source=new CanonicalTaskPlanSource({tasks,runtime,reauthorize:async c=>assert.equal(c.id,'owner')});
 runtime.withPlanSnapshot=source.withPlanSnapshot.bind(source);
 t.after(async()=>{await runtime.close();await tasks.close();await fs.rm(root,{recursive:true,force:true});});
 const link=()=>source.bindPlan({ownerId:'owner',sourceTaskId:'native',expectedSourceRevision:2},{client});
 const update=async change=>{const state=await tasks.get('native'),c=structuredClone(state.contract);delete c.planEpoch;change(c);return tasks.setContract('native',c,{expectedRevision:state.revision,schemaVersion:14});};
 return {root,tasks,runtime,source,link,update};
}
test('host bind_plan reads exact canonical source and preserves stable owned identity',async t=>{
 const f=await fixture(t),linked=await f.link();
 assert.equal(linked.source.taskId,'native');assert.equal(linked.source.revision,2);
 assert.equal((await f.link()).taskId,linked.taskId);
 await assert.rejects(f.source.bindPlan({ownerId:'foreign',sourceTaskId:'native',expectedSourceRevision:2},{client}),{code:'DIRECT_AUTH_REQUIRED'});
 await assert.rejects(f.source.bindPlan({ownerId:'owner',sourceTaskId:'native',expectedSourceRevision:1},{client}),{code:'DIRECT_PLAN_SOURCE_STALE'});
 let locked=false;await f.source.withPlanSnapshot({ownerId:'owner',taskId:linked.taskId},snapshot=>{locked=f.tasks.lockOwners.has('native');assert.equal(snapshot.source.revision,2);});assert.equal(locked,true);
 const tool=createDirectTaskContractTools({runtime:f.runtime,bindPlan:f.source.bindPlan.bind(f.source)})[0];
 const result=await tool.execute({requestId:'bind-source',action:'bind_plan',sourceTaskId:'native',expectedSourceRevision:2},{client,jobId:'job'});assert.equal(JSON.parse(result.contentItems[0].text).taskId,linked.taskId);
 const foreignSource=new CanonicalTaskPlanSource({tasks:f.tasks,runtime:f.runtime});const foreign=await foreignSource.bindPlan({ownerId:'foreign',sourceTaskId:'native',expectedSourceRevision:2},{client:{...client,id:'foreign'}});assert.notEqual(foreign.taskId,linked.taskId);
 await assert.rejects(tool.execute({requestId:'bad',action:'bind_plan',sourceTaskId:'native',expectedSourceRevision:2,contract:contract()},{client,jobId:'job'}),/Unsupported task contract fields/);
});
test('linked context survives unrelated refinements and refreshes selected scope without reissue',async t=>{
 const f=await fixture(t),linked=await f.link();
 const context=await f.runtime.issueContext({ownerId:'owner',taskId:linked.taskId,expectedRevision:linked.revision,workItemId:'a',criterionId:'a',adapters:['relay_browser']});
 await f.update(c=>{c.workItems[1].objective='More detail about B';});
 await f.runtime.syncCanonicalPlan({ownerId:'owner',taskId:linked.taskId});
 const unaffected=await f.runtime.readContext({ownerId:'owner',taskContext:context.taskContext});assert.equal(unaffected.valid,true);assert.equal(unaffected.generation,context.generation);
 await f.update(c=>{c.criteria[0].description='Refined evidence expectation for A';});
 await f.runtime.syncCanonicalPlan({ownerId:'owner',taskId:linked.taskId});
 const changed=await f.runtime.readContext({ownerId:'owner',taskContext:context.taskContext});assert.equal(changed.valid,true);assert.ok(changed.generation>context.generation);
 await assert.rejects(f.runtime.outcomes.validateContext({ownerId:'owner',taskContext:context.taskContext,expectedContextGeneration:context.generation}));
 assert.equal((await f.runtime.read({ownerId:'owner',taskId:linked.taskId})).taskId,linked.taskId);
});
test('native linked task auto-syncs same source revisions without idle reattachment',async t=>{
 const f=await fixture(t),linked=await f.link(),context=await f.runtime.issueContext({ownerId:'owner',taskId:linked.taskId,expectedRevision:linked.revision,workItemId:'a',criterionId:'a',adapters:['relay_browser']});
 const bridge=new NativeTaskContextBridge({runtime:f.runtime,tasks:f.tasks,planSource:f.source,canEnforceProtectedDispatch:()=>true});
 await bridge.attach({nativeTaskId:'native',expectedNativeRevision:2,taskContext:context.taskContext,client});
 const session=await bridge.open({nativeTaskId:'native',runId:'run'});
 await f.update(c=>{c.workItems[1].title='Better B title';});
 assert.equal(await session.gate({name:'relay_browser',arguments:{action:'read'}}),null);
 assert.ok(await bridge.open({nativeTaskId:'native',runId:'next-run'}));
 assert.equal((await f.runtime.outcomes.readNativeAttachment({nativeTaskId:'native'})).generation,1);
});
