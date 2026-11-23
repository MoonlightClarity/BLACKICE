import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createBenchmarkChatWorkflow} from '../scripts/benchmark-chat-workflow.mjs';
import {ordinaryChatWorkflow} from '../public/chat-turn-defaults.mjs';
import {HarnessEngine} from '../lib/engine.mjs';

test('benchmark factory produces the exact graph identity required by ordinary BLACKICE Chat, not a generic workflow',()=>{
 const chat=createBenchmarkChatWorkflow('fixture',{workflowKind:'ordinary-chat'});
 const generic=createBenchmarkChatWorkflow('fixture',{workflowKind:'generic'});
 assert.equal(chat.id,'mission_chat_context_benchmark');
 assert.equal(chat.description,'A focused task started from Mission.');
 assert.equal(ordinaryChatWorkflow(chat),true);
 assert.equal(ordinaryChatWorkflow(generic),false);
 assert.deepEqual(chat.nodes,generic.nodes);
 assert.deepEqual(chat.edges,generic.edges);
 assert.deepEqual(chat.settings,generic.settings);
});

class Runtime extends EventEmitter{
 status(){return{connected:true,authenticated:true,models:[{id:'fixture',supportsTools:true}]};}
 async runAgent(options){return this.execute(options);}
}
test('real ordinary Chat Engine activates its existing outcome-review continuation on a draft reporting incomplete work',{timeout:45000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'benchmark-ordinary-review-'));
 const runtime=new Runtime();
 const engine=await new HarnessEngine({runtime,dataDir:path.join(root,'engine'),defaultCwd:root}).init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 let reviewed=false;
 runtime.execute=async options=>{
  assert.equal(typeof options.onBeforeFinal,'function','Ordinary Chat must expose the outcome review hook.');
  const response=await options.onBeforeFinal({
   output:'I inspected the source but did not complete the requested repair or tests.',
   signal:options.signal,remainingSteps:20,
  });
  assert.equal(response?.continue,true);
  assert.match(response.prompt,/CURRENT USER REQUEST/);
  reviewed=true;
  return{output:'Fixture checked existing ordinary-chat outcome review activation.'};
 };
 const workflow=createBenchmarkChatWorkflow('fixture',{workflowKind:'ordinary-chat'});
 const started=engine.startRun({workflow,input:{task:'Repair the local code, then run node --test.',directoryActions:'off'}});
 await engine.executions.get(started.id);
 assert(reviewed,'The ordinary Chat finalization reviewer must not be bypassed by the benchmark graph.');
 assert.equal(engine.getRun(started.id).status,'completed',engine.getRun(started.id).error);
});
