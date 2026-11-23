// Deterministic audit: identify which actual workflow routes install
// BLACKICE's ordinary Chat outcome reviewer. No external model starts.
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {HarnessEngine} from '../lib/engine.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';
import {ordinaryChatWorkflow} from '../public/chat-turn-defaults.mjs';

class StubRuntime extends EventEmitter {
  requests=[];
  status(){return {connected:true,authenticated:true,models:[{id:'fixture-model',supportsTools:true}]};}
  async runAgent(options){this.requests.push({
    reviewHook:typeof options.onBeforeFinal==='function',
    codeSchema:options.dynamicTools?.find(x=>x.name==='relay_code')?.inputSchema?.properties?.check?.enum,
    model:options.model});
    return {output:'This is a fixture response, not evidence of a saved effect.'};
  }
}
const dir=await mkdtemp(path.join(os.tmpdir(),'blackice-review-route-'));
const runtime=new StubRuntime();
let engine;
try{
 engine=await new HarnessEngine({runtime,dataDir:path.join(dir,'engine'),defaultCwd:dir}).init();
 const results=[];
 for(const prefix of ['chatgpt_mission_','generic_mission_']){
   const task='Record that no file was edited.';
   const workflow=createMissionWorkflow({task,model:'fixture-model',cwd:dir,
     id:prefix+randomUUID().replaceAll('-',''),planningMode:'off'});
   const started=engine.startRun({workflow,input:{task,cwd:dir,planningMode:'off',
     directoryMode:'off',directoryActions:'off',chatPlanning:'off',pastChats:'off'}});
   await engine.executions.get(started.id);
   const run=engine.getRun(started.id),request=runtime.requests.at(-1);
   results.push({prefix,workflowEligible:ordinaryChatWorkflow(workflow),
     id:workflow.id,chatPlanning:run.chatPlanning,directoryActions:run.directoryActions,
     chatDisplayGroupId:run.chatDisplayGroupId??null,chatDisplayGroupPresent:Object.hasOwn(run,'chatDisplayGroupId'),
     goalPresent:Boolean(run.goal),runStatus:run.status,reviewHook:request?.reviewHook,
     codeCheckOptions:request?.codeSchema});
 }
 console.log('REVIEW_ADMISSION_PROBE '+JSON.stringify(results));
}catch(error){console.error('REVIEW_ADMISSION_PROBE_ERROR '+error.message);process.exitCode=2;}
finally{await engine?.close().catch(()=>{});await rm(dir,{recursive:true,force:true});}
