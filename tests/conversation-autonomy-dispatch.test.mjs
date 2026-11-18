import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {ConversationArchive} from '../lib/conversations.mjs';
import {ConversationGoals} from '../lib/conversation-goals.mjs';
import {requireAutonomyModel} from '../lib/autonomy-model-allowlist.mjs';
import {createSubagentToolHandler,SUBAGENT_TOOL,SUBAGENT_V6_TOOL,SUBAGENT_SCHEMA_VERSION} from '../lib/subagents.mjs';

const waitFor=async(predicate,message='condition')=>{
  const until=Date.now()+7000;
  while(Date.now()<until){const result=await predicate();if(result)return result;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.fail('Timed out waiting for '+message);
};
const graph=()=>({id:'autonomy-fixture',name:'Autonomy fixture',nodes:[
  {id:'input',type:'input',name:'Input'},
  {id:'agent',type:'agent',name:'Agent',model:'test-model',prompt:'Do the useful task.'},
  {id:'output',type:'output',name:'Output'}],edges:[
    {id:'in',source:'input',target:'agent'},
    {id:'out',source:'agent',target:'output'}],
  settings:{planningMode:'off',maxParallel:1}});
class Runtime extends EventEmitter{
  constructor(execute){super();this.execute=execute;this.calls=[];this.defaultModel='test-model';}
  status(){return {connected:true,authenticated:true,defaultModel:this.defaultModel,models:[
    {id:'test-model',model:'test-model'},{id:'alternate-model',model:'alternate-model'},{id:'premium-model',model:'premium-model'}]};}
  async savedThreadModel(){return 'test-model';}
  async runAgent(options){this.calls.push(options);return this.execute(options,this.calls.length);}
}
async function fixture(t,execute,options={}){
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-autonomy-'));
  const cwd=path.join(dir,'workspace'),dataDir=path.join(dir,'data');await mkdir(cwd);
  const runtime=new Runtime(execute);
  const engine=await new HarnessEngine({runtime,dataDir,defaultCwd:cwd}).init();
  const conversations=await new ConversationArchive({dataDir,engine}).init();
  t.after(async()=>{await engine.close();await conversations.close();await rm(dir,{recursive:true,force:true});});
  return {engine,conversations,runtime};
}
const out=n=>({output:'Verified fixture turn '+n,threadId:'autonomy_mock_thread_'+n});

test('worker launcher enforces model choices at runtime and retains original v6 catalog',async()=>{
  assert.equal(SUBAGENT_SCHEMA_VERSION,7);
  assert.equal(SUBAGENT_V6_TOOL.inputSchema.properties.tasks.items.properties.model,undefined);
  assert.ok(SUBAGENT_TOOL.inputSchema.properties.tasks.items.properties.model);
  const launches=[];
  const runtime={runAgent:async(options)=>{launches.push(options);return {output:'worker result',threadId:'worker-thread'};}};
  const catalog=[{id:'test-model',model:'test-model'},{id:'alternate-model',model:'alternate-model'},{id:'premium-model',model:'premium-model'}];
  const allowlist=['test-model','alternate-model'];
  const handler=createSubagentToolHandler({
    runtime,cwd:'C:\\fixture',model:'test-model',maxParallel:2,allowTaskModel:true,
    createTools:async()=>({tools:[]}),
    selectWorkerModel:({task,inheritedModel})=>requireAutonomyModel({
      allowlist,requestedModel:task.model??inheritedModel,catalog
    }),
  });
  const response=await handler({name:'relay_delegate',arguments:{tasks:[
    {id:'image',prompt:'Interpret a synthetic image.',model:'alternate-model'},
    {id:'blocked',prompt:'Try a costly model.',model:'premium-model'}
  ]}});
  const data=JSON.parse(response.contentItems[0].text);
  assert.equal(data.requested,2);
  assert.equal(data.completed,1);
  assert.equal(launches.length,1,'rejected worker must never start provider call');
  assert.equal(launches[0].model,'alternate-model');
  assert.equal(data.results.find(result=>result.id==='blocked').status,'failed');
});

test('without autonomy workers inherit the user-selected coordinator model and cannot switch it',async t=>{
  let result;
  const {engine,runtime}=await fixture(t,async(options,n)=>{
    if(n===1){
      result=await options.onToolCall({name:'relay_delegate',arguments:{tasks:[
        {id:'denied',prompt:'Investigate one item.',model:'premium-model'},
        {id:'inherited',prompt:'Investigate another item.'}
      ]}});
      return out(n);
    }
    return out(n);
  },{autoStart:false});
  engine.runtimeSettings={get:()=>({subagentsEnabled:true,maxSubagents:2,executionGuardrails:false})};
  const run=engine.startRun({workflow:graph(),input:'Inspect two independent items.'});
  await waitFor(()=>engine.getRun(run.id).settled,'worker dispatch');
  assert.ok(result,'coordinator must invoke the real delegate handler');
  const data=JSON.parse(result.contentItems[0].text);
  assert.equal(data.results.find(row=>row.id==='denied').status,'failed');
  assert.equal(data.results.find(row=>row.id==='inherited').status,'completed');
  assert.deepEqual(runtime.calls.map(call=>call.model),['test-model','test-model']);
});



test('retired automatic continuation and stale dispatch reject before provider work',async t=>{
 const {engine,runtime}=await fixture(t,async(options,n)=>{assert.ok(!options.dynamicTools.some(x=>x.name==='relay_autonomy'));return out(n);});
 const first=engine.startRun({workflow:graph(),input:'Ordinary task.'});
 await waitFor(()=>engine.getRun(first.id).settled);
 assert.throws(()=>engine.continueRun(first.id,{nodeId:'agent',message:'Automatic wake.'},{autonomyDispatch:{id:'old'}}),e=>e.code==='AUTONOMY_RETIRED');
 for(const stale of [{autonomyDispatch:{id:'old'}},{autonomy:{automatic:true}}])assert.throws(()=>engine.dispatchRun({...engine.runs.get(first.id),...stale}),e=>e.code==='AUTONOMY_RETIRED');
 assert.equal(runtime.calls.length,1);
 const next=engine.continueRun(first.id,{nodeId:'agent',message:'Explicit followup.',model:'premium-model'});
 await waitFor(()=>engine.getRun(next.id).settled);
 assert.equal(engine.getRun(next.id).status,'completed');assert.equal(runtime.calls.length,2);assert.equal(runtime.calls[1].model,'premium-model');
});
test('explicit Goal still continues with its bounded budget without Autonomy',async t=>{
 const {engine,conversations,runtime}=await fixture(t,async(options,n)=>out(n));
 const goals=await new ConversationGoals({engine,conversations,autoStart:false,continuationDelayMs:10}).init();t.after(()=>goals.close());
 const first=engine.startRun({workflow:graph(),input:'One answer.'});await waitFor(()=>engine.getRun(first.id).settled);
 await goals.control(first.id,{action:'set',objective:'A bounded objective',maxTurns:1,requestId:'ordinary-goal'});
 goals.start();await waitFor(async()=>(await goals.get(first.id)).status==='budget_exhausted');
 assert.equal(runtime.calls.length,2);assert.equal(runtime.calls[1].model,'test-model');
 const family=await conversations.family(first.id);assert.equal(family.runs[1].goal.automatic,true);assert.equal(family.runs[1].autonomy,undefined);
});
test('retired autonomy history fails closed instead of inventing a tool schema',async t=>{
  const {engine}=await fixture(t,async(options,n)=>out(n),{autoStart:false});
  const sample={
    id:'native-history',taskId:'native-history',workflow:{nodes:[{id:'agent',type:'agent',model:'test-model'}],settings:{}},
    nodes:{agent:{status:'completed',toolNames:['relay_autonomy']}},
    runtimeSettings:{},planningMode:'off',
  };
  assert.throws(()=>engine.nativeHistoryDescription(sample,sample.workflow.nodes[0],sample.nodes.agent,'native-test'),e=>e.code==='CONTEXT_MIGRATION_SCHEMA');
});

test('saved v1 native agent catalog upgrades through a fresh session without replacing the conversation',async t=>{
  const {engine,conversations}=await fixture(t,async(options,n)=>out(n),{autoStart:false});
  const first=engine.startRun({workflow:graph(),input:'Original task.'});await waitFor(()=>engine.getRun(first.id).settled);
  const original=engine.runs.get(first.id);original.nodes.agent.nativeAgentSchemaVersion=1;
  assert.ok(original.nodes.agent.toolNames.includes('relay_agents'));
  const family=await conversations.family(first.id);
  const next=engine.continueRun(first.id,{nodeId:'agent',message:'Continue with current capabilities.'},{historyRuns:family.runs});
  await waitFor(()=>engine.getRun(next.id).settled);
  const saved=engine.runs.get(next.id);
  assert.equal(saved.taskId,first.id);
  assert.equal(saved.modelHandoff.reason,'native-agent-scope-capability');
  assert.equal(saved.nodes.agent.nativeAgentSchemaVersion,2);
});
test('explicit manual native child with goal does not gain automatic continuation',async t=>{
  let childId;
  const {engine,runtime,conversations}=await fixture(t,async(options,n)=>{
    if(n===1){
      const response=await options.onToolCall({name:'relay_agents',arguments:{action:'start',requestId:'manual-child-goal',task:'One child turn',goalObjective:'A recorded outcome',maxTurns:1,autonomous:false,planningMode:'off'}});
      childId=JSON.parse(response.contentItems[0].text).run.runId;
    }
    return out(n);
  });
  const goals=await new ConversationGoals({engine,conversations,continuationDelayMs:10}).init();t.after(()=>goals.close());
  const first=engine.startRun({workflow:graph(),input:'One manual child.'});await waitFor(()=>engine.getRun(first.id).settled);
  await waitFor(()=>childId&&engine.getRun(childId).settled);
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(runtime.calls.length,2);
  assert.equal(engine.getRun(childId).autonomy,undefined);
  assert.equal((await goals.get(childId)).objective,'A recorded outcome');
  assert.equal((await goals.get(childId)).status,'paused');
  assert.equal((await goals.get(childId)).maxTurns,1);
  await goals.control(childId,{action:'resume',requestId:'explicit-resume-child'});
  await waitFor(async()=>(await goals.get(childId)).status==='budget_exhausted');
  assert.equal(runtime.calls.length,3,'explicit resume still enables the saved bounded Goal');
});
