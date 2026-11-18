import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
const graph={nodes:[{id:'i',type:'input'},{id:'a',type:'agent',model:'fixture',prompt:'Inspect tools'},{id:'o',type:'output'}],edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{planningMode:'off'}};
test('unsolicited retired Swarm calls cannot enter dormant provider or ordinary tool fallback',async t=>{
 let dispatches=0;const receipts=[];
 class Runtime extends EventEmitter{
 status(){return {connected:true,authenticated:true,defaultModel:'fixture'};}
 async runAgent(options){
  assert.ok(options.dynamicTools.every(tool=>!tool.name.startsWith('relay_swarm')));
  for(const name of ['relay_swarm_read','relay_swarm_write','relay_swarm_launch'])receipts.push(await options.onToolCall({name,arguments:{action:'list'}}));
  return {output:'Finished'};
 }
 }
 const dir=await mkdtemp(path.join(tmpdir(),'swarm-coordinator-'));
 const engine=await new HarnessEngine({runtime:new Runtime(),dataDir:dir,defaultCwd:dir}).init();
 t.after(async()=>{await engine.close();await rm(dir,{recursive:true,force:true});});
 engine.nativeSwarmTools=()=>{dispatches++;throw Error('Dormant provider must not construct');};
 const run=engine.startRun({workflow:graph,input:'Inspect tools'});await engine.executions.get(run.id);
 assert.equal(engine.getRun(run.id).status,'completed',engine.getRun(run.id).error);
 assert.equal(dispatches,0);assert.equal(receipts.length,3);
 for(const receipt of receipts){assert.equal(receipt.success,false);assert.equal(receipt.code,'SWARM_NATIVE_UNAVAILABLE');}
});

import {TaskStateStore} from '../lib/task-state.mjs';
for (const outcome of ['completed','failed','cancelled']) test('ordinary workers retain cleanup and '+outcome+' status without Swarm',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'swarm-worker-'));const cleanup=[],finished=[],denials=[];let engine,workerCalls=0;
 const tasks=await new TaskStateStore({dataDir:dir}).init();const originalFinish=tasks.awareness.finish.bind(tasks.awareness);tasks.awareness.finish=(id,status)=>{finished.push({id,status});return originalFinish(id,status);};
 class Runtime extends EventEmitter{
 status(){return {connected:true,authenticated:true,defaultModel:'fixture::remote'};}
 async runAgent(options){
  if(options.prompt.startsWith('You are a short-lived BLACKICE subagent.')){
   workerCalls++;assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_workspace'));assert.ok(!options.dynamicTools.some(tool=>tool.name.startsWith('relay_swarm')));
   denials.push(await options.onToolCall({name:'relay_swarm_read',arguments:{action:'list'}}));
   if(outcome==='failed')throw Error('Fixture worker failure');
   if(outcome==='cancelled'){engine.cancelRun([...engine.runs.keys()].at(-1));throw Object.assign(Error('Stopped'),{name:'AbortError'});}
   return {output:'Independent result'};
  }
  await options.onToolCall({name:'relay_delegate',arguments:{tasks:[{id:'left',prompt:'Inspect left synthetic input'},{id:'right',prompt:'Inspect right synthetic input'}]}});
  return {output:'Reviewed results'};
 }
 }
 engine=await new HarnessEngine({runtime:new Runtime(),dataDir:dir,defaultCwd:dir,tasks,browser:{status:()=>({available:false}),releaseOwner:async(owner,state)=>{cleanup.push({owner,...state});throw Error('Fixture cleanup failure');}}}).init();
 engine.runtimeSettings={get:()=>({subagentsEnabled:true,maxSubagents:3,executionGuardrails:false})};engine.nativeSwarmTools=()=>{throw Error('Dormant worker provider invoked');};
 t.after(async()=>{await engine.close();await tasks.close?.();await rm(dir,{recursive:true,force:true});});
 const workflow=structuredClone(graph);workflow.nodes.find(node=>node.type==='agent').model='fixture::remote';
 const run=engine.startRun({workflow,input:'Inspect two independent synthetic inputs',planningMode:'off'});await engine.executions.get(run.id);
 assert.ok(workerCalls>0);assert.ok(denials.every(value=>value.success===false && value.code==='SWARM_NATIVE_UNAVAILABLE'));
 const children=cleanup.filter(row=>row.owner.nodeId!=='a');assert.ok(children.length>0);
 for(const row of children){assert.equal(row.status,outcome);assert.equal(row.retainForContinuation,outcome!=='completed');assert.ok(finished.some(value=>value.id===`${run.id}:${row.owner.nodeId}`&&value.status===outcome));}
});
