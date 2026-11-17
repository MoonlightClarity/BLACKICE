import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {KnowledgeStore} from '../lib/knowledge.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';
import {BUNDLED_TASK_SKILLS} from '../lib/bundled-task-skills.mjs';
for(const scenario of [
 {task:'Read a website and summarize its navigation',ids:['builtin:browser']},
 {task:'Find relevant jobs through job boards and employer sites',ids:['builtin:browser','builtin:job-search']}
])test('real engine exposes and serves separate skills: '+scenario.task,async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'blackice-skill-engine-')),cwd=path.join(directory,'workspace');
 await mkdir(cwd);
 const knowledge=await new KnowledgeStore({dataDir:directory}).init();
 const readIds=[];
 class Runtime extends EventEmitter{
  status(){return{connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',supportsTools:true}]};}
  async runAgent(options){
   assert.ok(options.developerInstructions.includes('id:"builtin:browser"'));
   assert.ok(options.developerInstructions.includes('id:"builtin:job-search"'));
   assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_skills'));
   for(const [index,id] of scenario.ids.entries()){
    const response=await options.onToolCall({name:'relay_skills',callId:'read-skill-'+index,arguments:{action:'read',id}});
    assert.equal(response.success,true);
    const entry=JSON.parse(response.contentItems[0].text).entry;
    assert.equal(entry.content,BUNDLED_TASK_SKILLS.find(skill=>skill.id===id).content);
    readIds.push(entry.id);
   }
   return{output:'Synthetic delivery checked; no live website operation',threadId:'skill-engine-fixture'};
  }
  async close(){}
 }
 const engine=await new HarnessEngine({runtime:new Runtime(),knowledge,dataDir:directory,defaultCwd:cwd}).init();
 t.after(async()=>{await engine.close();await knowledge.writeChain.catch(()=>{});await rm(directory,{recursive:true,force:true});});
 const workflow=createMissionWorkflow({task:scenario.task,model:'fixture',cwd,planningMode:'off'});
 const started=engine.startRun({workflow,input:{task:scenario.task,cwd,planningMode:'off'}});
 let done;
 for(let i=0;i<200;i++){done=engine.getRun(started.id);if(done?.settled)break;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.equal(done.status,'completed',done.error||done.nodes.agent?.error);
 assert.deepEqual(readIds,scenario.ids);
 assert.equal(knowledge.status().count,0);
});
