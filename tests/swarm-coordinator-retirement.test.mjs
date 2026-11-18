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

