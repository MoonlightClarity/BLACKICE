import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {HarnessEngine,assertCurrentNativeCatalog} from '../lib/engine.mjs';
import * as control from '../lib/control-tools.mjs';
const graph={name:'Current',nodes:[{id:'i',type:'input'},{id:'a',type:'agent',name:'Agent',model:'fixture-model',prompt:'Do task'},{id:'o',type:'output'}],edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{maxParallel:1,planningMode:'off'}};
class Runtime extends EventEmitter {
 calls=[];status(){return {connected:true,authenticated:true,defaultModel:'fixture-model',models:[{id:'fixture-model',supportsTools:true}]};}
 async runAgent(options){this.calls.push(options);options.onEvent?.({type:'thread',threadId:'fixture-thread'});return {output:'Done',threadId:'fixture-thread'};}
}
test('current control catalog has no historical exports, cycle schemas or guidance',()=>{
 assert.deepEqual(Object.keys(control).sort(),['CONTROL_INSTRUCTIONS','CONTROL_SCHEMA_VERSION','CONTROL_TOOL','createControlToolHandler'].sort());
 assert.doesNotMatch(JSON.stringify(control.CONTROL_TOOL),/planning_cycle|cycleId|graphRequestId|acceptanceCriteria/);
 assert.doesNotMatch(control.CONTROL_INSTRUCTIONS,/legacy|canonical|planning_cycle|Modular Planning|response-cycle/i);
});
test('old native catalogs fail before continuation, retry or schema adaptation without changing records',()=>{
 const old={id:'old',workflow:graph,nodes:{a:{threadId:'old-thread',toolNames:['relay_workspace','relay_control'],controlSchemaVersion:11}},status:'failed',settled:true};
 const bytes=JSON.stringify(old),engine={runs:new Map([['old',old]])};
 assert.throws(()=>assertCurrentNativeCatalog(old),{code:'NATIVE_CATALOG_UNSUPPORTED'});
 assert.throws(()=>HarnessEngine.prototype.retryRun.call(engine,'old'),{code:'NATIVE_CATALOG_UNSUPPORTED'});
 assert.throws(()=>HarnessEngine.prototype.continueRun.call(engine,'old',{nodeId:'a',message:'continue'}),{code:'NATIVE_CATALOG_UNSUPPORTED'});
 assert.equal(JSON.stringify(old),bytes);
});
test('new native run uses current controls and file discovery and can continue normally',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-current-catalog-'));const runtime=new Runtime();const engine=await new HarnessEngine({runtime,dataDir:root,defaultCwd:root}).init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 const run=engine.startRun({workflow:graph,input:'Check local files'});await engine.executions.get(run.id);const first=engine.getRun(run.id);assert.equal(first.status,'completed',first.error);
 const tools=runtime.calls[0].dynamicTools;assert.deepEqual(tools.find(x=>x.name==='relay_control'),control.CONTROL_TOOL);assert.ok(tools.some(x=>x.name==='relay_find_files'));assert.ok(!tools.find(x=>x.name==='relay_workspace').inputSchema.properties.action.enum.includes('find'));
 assert.doesNotThrow(()=>assertCurrentNativeCatalog(first));
 const next=engine.continueRun(run.id,{nodeId:'a',message:'Continue current task'});await engine.executions.get(next.id);assert.equal(engine.getRun(next.id).status,'completed',engine.getRun(next.id).error);assert.equal(runtime.calls.length,2);
});

test('current native session without tool support continues without catalog rejection',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-current-no-tools-'));const runtime=new Runtime();runtime.status=()=>({connected:true,authenticated:true,defaultModel:'fixture-model',models:[{id:'fixture-model',supportsTools:false}]});const engine=await new HarnessEngine({runtime,dataDir:root,defaultCwd:root}).init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 const run=engine.startRun({workflow:graph,input:'Answer in text'});await engine.executions.get(run.id);const first=engine.getRun(run.id);assert.equal(first.status,'completed',first.error);assert.equal((runtime.calls[0].dynamicTools||[]).length,0);
 const next=engine.continueRun(run.id,{nodeId:'a',message:'Continue in text'});await engine.executions.get(next.id);assert.equal(engine.getRun(next.id).status,'completed',engine.getRun(next.id).error);assert.equal(runtime.calls.length,2);
});
test('the retired answer-detail control schema refreshes in the same saved native conversation',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-retired-answer-detail-catalog-'));const runtime=new Runtime();const engine=await new HarnessEngine({runtime,dataDir:root,defaultCwd:root}).init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 const run=engine.startRun({workflow:graph,input:'Check local files'});await engine.executions.get(run.id);
 const earlier=engine.runs.get(run.id);assert.equal(earlier.status,'completed',earlier.error);
 // Native blackice control schemas are fixed at provider thread creation.
 // Reproduce the exact pre-removal catalog stamp without using a live provider.
 earlier.nodes.a.controlSchemaVersion=13;
 earlier.workflow.nodes.find(node=>node.id==='a').verbosity=10;
 const next=engine.continueRun(run.id,{nodeId:'a',message:'Continue current task'});
 await engine.executions.get(next.id);const done=engine.getRun(next.id);
 assert.equal(done.status,'completed',done.error);
 assert.equal(done.taskId,earlier.taskId);
 assert.equal(done.modelHandoff.reason,'retired-tool-catalog');
 assert.equal(runtime.calls.at(-1).threadId,undefined);
 assert.equal(Object.hasOwn(runtime.calls.at(-1).dynamicTools.find(tool=>tool.name==='relay_control').inputSchema.properties.runtime.properties,'verbosity'),false);
});
test('current failed native turn retries with its current schema and original task',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-current-retry-'));const runtime=new Runtime();runtime.runAgent=async function(options){this.calls.push(options);options.onEvent?.({type:'thread',threadId:'retry-thread'});if(this.calls.length===1)throw Error('Fixture provider interruption');return {output:'Recovered',threadId:'retry-thread'};};const engine=await new HarnessEngine({runtime,dataDir:root,defaultCwd:root}).init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 const run=engine.startRun({workflow:graph,input:'Current retry task'});await engine.executions.get(run.id);assert.equal(engine.getRun(run.id).status,'failed');
 const next=engine.retryRun(run.id);await engine.executions.get(next.id);assert.equal(engine.getRun(next.id).status,'completed',engine.getRun(next.id).error);assert.equal(runtime.calls.length,2);assert.deepEqual(runtime.calls[1].dynamicTools.find(t=>t.name==='relay_control'),control.CONTROL_TOOL);
});
