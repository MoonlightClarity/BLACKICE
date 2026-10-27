import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {RuntimeSettingsStore} from '../lib/runtime-settings.mjs';
import {TaskStateStore} from '../lib/task-state.mjs';
import {recordFixturePlan} from './fixture-task-plan.mjs';

const taskGraph=()=>({
  name:'Independent worker test',
  nodes:[
    {id:'input',type:'input',name:'Task'},
    {id:'agent',type:'agent',name:'Coordinator',prompt:'Complete the user request and delegate a narrow independent part when available.',model:'default'},
    {id:'output',type:'output',name:'Final'}
  ],
  edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],
  settings:{maxParallel:2}
});
const finish=async(engine,id)=>{
  for(let i=0;i<100;i++){
    const run=engine.getRun(id);
    if(run?.settled)return run;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw Error('Agent did not finish in time.');
};

test('enabled Relay chats really delegate with bounded child tools and observable outcomes; disabled chats do not',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'relay-delegate-engine-')),cwd=path.join(root,'work'),dataDir=path.join(root,'data');
  await mkdir(cwd);const calls=[],receipts=[];
  class Runtime extends EventEmitter {
    status(){return{connected:true,authenticated:true,defaultModel:'test-model'};}
    async runAgent(options){
      calls.push(options);
      if(options.prompt.startsWith('You are a short-lived BLACKICE subagent.')){
        assert.equal(options.cwd,cwd);
        assert.equal(options.codexHistory,'relay');
        assert.equal(options.effort,'high');
        assert.ok(options.prompt.includes('thorough'));
        assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_workspace'));
        assert.ok(!options.dynamicTools.some(tool=>['relay_delegate','relay_control','relay_desktop','relay_task'].includes(tool.name)));
        assert.match(options.developerInstructions,/The coordinator owns the final remote send/);
        assert.match(options.developerInstructions,/Do not click a final send\/publish\/submit control/);
        return{output:'Worker finished its independent analysis.'};
      }
      if(options.dynamicTools.some(tool=>tool.name==='relay_delegate')){
        const returned=await options.onToolCall({name:'relay_delegate',arguments:{tasks:[{id:'research',prompt:'Analyze one independent aspect; do not modify any files.'}]}});
        assert.equal(returned.success,true);
        const receipt=JSON.parse(returned.contentItems[0].text);receipts.push(receipt);
        return{output:'Coordinator verified: '+receipt.results[0].output};
      }
      return{output:'No delegation configured.'};
    }
  }
  const runtime=new Runtime(),engine=new HarnessEngine({runtime,dataDir,defaultCwd:cwd});
  const prefs=await new RuntimeSettingsStore({dataDir}).init();engine.runtimeSettings=prefs;await engine.init();
  t.after(async()=>{await engine.close();await prefs.close();await rm(root,{recursive:true,force:true});});
  const disabled=await finish(engine,engine.startRun({workflow:taskGraph(),input:'Evaluate a change.',planningMode:'off'}).id);
  assert.equal(disabled.status,'completed',disabled.error);
  assert.equal(disabled.nodes.agent.output,'No delegation configured.');
  assert.equal(calls.length,1);
  assert.ok(!calls[0].dynamicTools.some(tool=>tool.name==='relay_delegate'));
  await prefs.update({subagentsEnabled:true,maxSubagents:2,verbosity:'detailed',defaultEffort:'high'});
  const enabled=await finish(engine,engine.startRun({workflow:taskGraph(),input:'Evaluate a change with delegation.',planningMode:'off'}).id);
  assert.equal(enabled.status,'completed',enabled.error);
  assert.match(enabled.nodes.agent.output,/Worker finished/);
  assert.equal(receipts.length,1);
  assert.equal(receipts[0].allCompleted,true);
  assert.equal(calls.length,3);
  assert.ok(calls[1].dynamicTools.some(tool=>tool.name==='relay_delegate'));
  assert.ok(enabled.events.some(event=>event.data?.type==='subagent'&&event.data?.status==='completed'));
});

test('a failed child execution remains inspectable in the durable parent run after a planned coordinator response',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'relay-delegate-failure-')),cwd=path.join(root,'work'),dataDir=path.join(root,'data');await mkdir(cwd);
  let childReceipt;
  class Runtime extends EventEmitter{
    status(){return{connected:true,authenticated:true,defaultModel:'fixture-model',models:[{id:'fixture-model',supportsTools:true}]};}
    async runAgent(options){
      if(options.prompt.startsWith('You are a short-lived BLACKICE subagent.')){
        options.onEvent({type:'thread',threadId:'failed-child-thread',turnId:'failed-child-turn',model:'fixture-model'});
        options.onEvent({type:'usage',usage:{inputTokens:60,outputTokens:12,totalTokens:72}});
        options.onEvent({type:'tool.result',tool:'relay_workspace',success:true});
        throw Error('Observed child connection failure after one tool result.');
      }
      options.onEvent({type:'thread',threadId:'coordinator-thread',model:'fixture-model'});
      await recordFixturePlan(options,{title:'Inspect the child failure receipt',doneWhen:'The coordinator reports the actual failure and preserves its execution evidence.'});
      const returned=await options.onToolCall({name:'relay_delegate',arguments:{tasks:[{id:'independent',prompt:'Inspect one local fixture; report actual work.'}]}});
      assert.equal(returned.success,false);childReceipt=JSON.parse(returned.contentItems[0].text).results[0];
      return{output:'The independent worker failed after one tool result; its execution receipt is available for inspection.',threadId:'coordinator-thread'};
    }
  }
  const tasks=await new TaskStateStore({dataDir}).init(),prefs=await new RuntimeSettingsStore({dataDir}).init();await prefs.update({subagentsEnabled:true,maxSubagents:1});
  const engine=new HarnessEngine({runtime:new Runtime(),tasks,dataDir,defaultCwd:cwd});engine.runtimeSettings=prefs;await engine.init();
  t.after(async()=>{await engine.close();await prefs.close();await tasks.close();await rm(root,{recursive:true,force:true});});
  const run=await finish(engine,engine.startRun({workflow:taskGraph(),input:'Review an independent fixture and report any execution failure.'}).id);
  assert.equal(run.status,'completed',run.error);assert.equal(run.nodes.agent.planning.status,'recorded');assert.equal(childReceipt.status,'failed');assert.equal(childReceipt.output,undefined);
  await engine.persist();const stored=JSON.parse(await readFile(path.join(dataDir,'runs.json'),'utf8')).find(value=>value.id===run.id),terminal=stored.events.find(event=>event.data?.type==='subagent'&&event.data.status==='failed').data;
  assert.equal(terminal.id,'independent');assert.equal(terminal.threadId,'failed-child-thread');assert.equal(terminal.turnId,'failed-child-turn');assert.equal(terminal.model,'fixture-model');assert.deepEqual(terminal.usage,{inputTokens:60,outputTokens:12,totalTokens:72});assert.deepEqual(terminal.toolSummary,{completed:1,failed:0});assert.equal(terminal.message,childReceipt.error);assert.equal(terminal.durationMs,childReceipt.durationMs);
  assert.ok(!stored.events.some(event=>event.data?.type==='subagent'&&event.data.status==='completed'));
});
