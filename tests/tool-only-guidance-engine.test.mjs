import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {KnowledgeStore} from '../lib/knowledge.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';
import {BROWSER_TOOL} from '../lib/browser.mjs';
for(const scenario of [
 {task:'Read a website and summarize its navigation',available:true},
 {task:'Find relevant jobs through job boards and employer sites',available:false}
])test('real engine exposes browser guidance only with the available browser tool: '+scenario.task,async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'blackice-skill-engine-')),cwd=path.join(directory,'workspace');
 await mkdir(cwd);
 const knowledge=await new KnowledgeStore({dataDir:directory}).init();
 let inspected=false;
 class Runtime extends EventEmitter{
  status(){return{connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',supportsTools:true}]};}
  async runAgent(options){
   assert.doesNotMatch(options.developerInstructions,/BUNDLED TASK SKILLS|builtin:browser|relevant job boards|BROWSER WORKSPACE|employer-direct ATS route and any observed/);
   assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_skills'));
   const browserTool=options.dynamicTools.find(tool=>tool.name==='relay_browser');
   assert.equal(Boolean(browserTool),scenario.available);
   if(browserTool)assert.equal(browserTool.description,BROWSER_TOOL.description);
   const response=await options.onToolCall({name:'relay_skills',callId:'search-saved',arguments:{action:'search'}});
   assert.deepEqual(JSON.parse(response.contentItems[0].text).entries,[]);
   inspected=true;
   return{output:'Synthetic delivery checked; no live website operation',threadId:'skill-engine-fixture'};
  }
  async close(){}
 }
 const engine=await new HarnessEngine({runtime:new Runtime(),knowledge,browser:{status:()=>({available:scenario.available,contained:true})},dataDir:directory,defaultCwd:cwd}).init();
 t.after(async()=>{await engine.close();await knowledge.writeChain.catch(()=>{});await rm(directory,{recursive:true,force:true});});
 const workflow=createMissionWorkflow({task:scenario.task,model:'fixture',cwd,planningMode:'off'});
 const started=engine.startRun({workflow,input:{task:scenario.task,cwd,planningMode:'off'}});
 let done;
 for(let i=0;i<200;i++){done=engine.getRun(started.id);if(done?.settled)break;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.equal(done.status,'completed',done.error||done.nodes.agent?.error);
 assert.equal(inspected,true);
 assert.equal(knowledge.status().count,0);
});
