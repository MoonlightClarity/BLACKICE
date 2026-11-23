import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';

const graph={
 name:'Ordinary Chat with advisory Planning',
 nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'fixture',prompt:'Write source after planning.'},{id:'output',type:'output'}],
 edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],
 settings:{maxParallel:1,planningMode:'off'},
};
class Runtime extends EventEmitter{
 constructor(){super();this.planningCalls=0;this.operationalCalls=0;this.continuations=0;this.toolResults=[];}
 status(){return {connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',supportsTools:true}]};}
 async runAgent(options){
  if(options.responseOnly){
   this.planningCalls++;
   return {output:JSON.stringify({artifact:{status:'needs-evidence',reason:'Inspect source before planning changes',sourceRefs:[],focus:null,actions:[]}})};
  }
  this.operationalCalls++;
  assert.equal(typeof options.onBeforeFinal,'function','ordinary Chat outcome review must exist with Chat Planning on');
  const review=await options.onBeforeFinal({output:'I only planned; the requested file remains unwritten.',signal:options.signal});
  assert.equal(review?.continue,true,'the first unfinished draft should be continued, not accepted');
  this.continuations++;
  const result=await options.onToolCall({name:'relay_workspace',arguments:{
    action:'write',path:path.join(options.cwd,'result.mjs'),text:'export const status = "written";\n'
  },callId:'write-after-review'});
  this.toolResults.push(result);
  assert.equal(result.success,true,JSON.stringify(result));
  return {output:'The requested file was written.'};
 }
}
test('Planning-only ordinary Chat still receives the outcome reviewer and can take an effect after premature final',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'blackice-planning-outcome-'));
 const runtime=new Runtime();
 const engine=await new HarnessEngine({runtime,dataDir:path.join(root,'data'),defaultCwd:root}).init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 const task='Write result.mjs and do not stop after planning';
 const workflow=createMissionWorkflow({id:'mission_chat_continuation_fixture',task,cwd:root,model:'fixture',planningMode:'off'});
 const started=engine.startRun({workflow,input:{task,cwd:root,chatPlanning:'on',directoryActions:'off'}});
 await engine.executions.get(started.id);
 const saved=engine.getRun(started.id);
 assert.equal(saved.status,'completed',String(saved.error));
 assert.ok(runtime.planningCalls>=1,'planning prep should run');
 assert.equal(runtime.operationalCalls,1);
 assert.equal(runtime.continuations,1);
 assert.match(await readFile(path.join(root,'result.mjs'),'utf8'),/written/);
 assert.equal(runtime.toolResults.length,1,'no effect was replayed');
});
