import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';
import {BROWSER_TOOL} from '../lib/browser.mjs';
import {projectTurnMachineTrace} from '../lib/turn-machine-trace.mjs';
for(const scenario of [
 {task:'Read a website and summarize its navigation',available:true},
 {task:'Find relevant jobs through job boards and employer sites',available:false}
])test('real engine exposes browser guidance only with the available browser tool: '+scenario.task,async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'blackice-skill-engine-')),cwd=path.join(directory,'workspace');
 await mkdir(cwd);
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
   const entries=JSON.parse(response.contentItems[0].text).entries; assert.ok(entries.length>0);assert.ok(entries.every(entry=>entry.immutable&&entry.source==='bundled'));
   inspected=true;
   return{output:'Synthetic delivery checked; no live website operation',threadId:'skill-engine-fixture'};
  }
  async close(){}
 }
 const engine=await new HarnessEngine({runtime:new Runtime(),browser:{status:()=>({available:scenario.available,contained:true})},dataDir:directory,defaultCwd:cwd}).init();
 t.after(async()=>{await engine.close();await rm(directory,{recursive:true,force:true});});
 const workflow=createMissionWorkflow({task:scenario.task,model:'fixture',cwd,planningMode:'off'});
 const started=engine.startRun({workflow,input:{task:scenario.task,cwd,planningMode:'off'}});
 let done;
 for(let i=0;i<200;i++){done=engine.getRun(started.id);if(done?.settled)break;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.equal(done.status,'completed',done.error||done.nodes.agent?.error);
 assert.equal(inspected,true);
});


test('real engine emits counts-only observations for successful browser results only in Maximal',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-observation-engine-')),cwd=path.join(root,'workspace');
 await mkdir(cwd);
 const tabId='fixture-tab', privateUrl='https://embedded.example.test/PRIVATE_URL', privateCall='opaque-click-private-id';
 const snapshot={tabId,url:privateUrl,documentId:'PRIVATE_DOCUMENT',frames:[
  {url:privateUrl,observation:'content-observed',text:'PRIVATE_TEXT',elements:[
   {tag:'input',disabled:false,value:'PRIVATE_VALUE',ref:'PRIVATE_REF'},
   {tag:'textarea',disabled:true},{role:'combobox'},{tag:'a',disabled:false},{tag:'input',type:'hidden',disabled:false}
  ]},
  {observation:'no-content-observed',elements:[]},{observation:'unknown',elements:[]}
 ],frameErrors:[{error:'PRIVATE_ERROR'}]};
 let owner;
 const browser={
  status:()=>({available:true,contained:true,tabs:owner?[{tabId,url:privateUrl,contained:true,owner}]:[],activeTab:tabId}),
  perform:async({action},context)=>{
   if(action==='open'){owner=context.owner;return{tabId};}
   if(action==='wait')throw Error('fixture did not load');
   return action==='tabs'?{tabs:[]}:snapshot;
  },close:async()=>{}
 };
 class Runtime extends EventEmitter{
  status(){return{connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',supportsTools:true}]};}
  async runAgent(options){
   assert.equal((await options.onToolCall({name:'relay_browser',callId:'open-fixture',arguments:{action:'open',url:privateUrl}})).success,true);
   const call={name:'relay_browser',callId:privateCall,arguments:{action:'click',tabId,ref:'fixture-ref'}};
   const response=await options.onToolCall(call);
   assert.equal(response.success,true,JSON.stringify(response));
   assert.deepEqual(JSON.parse(response.contentItems[0].text).frames,snapshot.frames);
   options.onEvent({type:'tool.result',tool:'relay_browser',action:'click',callId:call.callId,success:true});
   assert.equal((await options.onToolCall({name:'relay_browser',callId:'failed',arguments:{action:'wait',tabId,text:'fixture'}})).success,false);
   assert.equal((await options.onToolCall({name:'relay_browser',callId:'no-frames',arguments:{action:'tabs'}})).success,true);
   return {output:'Synthetic host observation fixture',threadId:'fixture-thread'};
  }
  async close(){}
 }
 const engine=await new HarnessEngine({runtime:new Runtime(),browser,dataDir:root,defaultCwd:cwd}).init();
 t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
 const task='Exercise browser receipt instrumentation on a fixture';
 for(const directoryDiagnostics of ['off','on','maximal']){
  const workflow=createMissionWorkflow({task,model:'fixture',cwd,planningMode:'off'});
  const started=engine.startRun({workflow,input:{task,cwd,directoryDiagnostics,directoryActions:'off',chatPlanning:'off'}});
  await engine.executions.get(started.id);
  const run=engine.runs.get(started.id);
  assert.equal(run.status,'completed',run.error);
  const events=run.events.filter(event=>event.data?.type==='browser.observation');
  assert.equal(events.length,directoryDiagnostics==='maximal'?1:0,directoryDiagnostics);
  if(!events.length)continue;
  const [observed]=events;
  assert.doesNotMatch(JSON.stringify(observed),/PRIVATE_|opaque-click-private-id/);
  const trace=projectTurnMachineTrace(run).entries;
  const evidence=trace.find(row=>row.kind==='browser.observation'), result=trace.find(row=>row.kind==='tool.result'&&row.metadata?.action==='click');
  assert.equal(evidence.callRef,result.callRef);
  assert.match(evidence.callRef,/^[0-9a-f]{24}$/);
  assert.deepEqual(evidence.metadata,{tool:'relay_browser',phase:'returned',action:'click',frameCount:3,
   contentFrameCount:1,emptyFrameCount:1,unknownFrameCount:1,frameErrorCount:1,
   enabledControlCount:1,disabledControlCount:1,unknownControlCount:1});
 }
});
