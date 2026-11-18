import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {ConversationArchive} from '../lib/conversations.mjs';
import {ConversationGoals} from '../lib/conversation-goals.mjs';
import {createSubagentToolHandler,SUBAGENT_TOOL,SUBAGENT_SCHEMA_VERSION} from '../lib/subagents.mjs';

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

test('current workers inherit the coordinator model and reject per-worker model overrides before dispatch',async()=>{
 assert.equal(SUBAGENT_SCHEMA_VERSION,7);assert.equal(SUBAGENT_TOOL.inputSchema.properties.tasks.items.properties.model,undefined);
 const launches=[],runtime={runAgent:async options=>{launches.push(options);return {output:'Worker result',threadId:'worker-thread'};}};
 const handler=createSubagentToolHandler({runtime,cwd:process.cwd(),model:'test-model',maxParallel:2,createTools:async()=>({tools:[]})});
 const denied=await handler({name:'relay_delegate',arguments:{tasks:[{id:'bad',prompt:'No effect',model:'premium-model'},{id:'peer',prompt:'No effect'}]}});
 assert.equal(denied.success,false);assert.equal(launches.length,0);
 const accepted=await handler({name:'relay_delegate',arguments:{tasks:[{id:'one',prompt:'First independent item'},{id:'two',prompt:'Second independent item',readOnly:true}]}});
 assert.equal(accepted.success,true);assert.equal(JSON.parse(accepted.contentItems[0].text).completed,2);assert.deepEqual(launches.map(x=>x.model),['test-model','test-model']);
});

test('without autonomy workers inherit the user-selected coordinator model and cannot switch it',async t=>{
  let result,denied;
  const {engine,runtime}=await fixture(t,async(options,n)=>{
    if(n===1){
      denied=await options.onToolCall({name:'relay_delegate',arguments:{tasks:[{id:'denied',prompt:'No model switch.',model:'premium-model'},{id:'peer',prompt:'No dispatch.'}]}});
      result=await options.onToolCall({name:'relay_delegate',arguments:{tasks:[{id:'inherited',prompt:'Investigate one item.'},{id:'other',prompt:'Investigate another item.'}]}});
      return out(n);
    }
    return out(n);
  },{autoStart:false});
  engine.runtimeSettings={get:()=>({subagentsEnabled:true,maxSubagents:2,executionGuardrails:false})};
  const run=engine.startRun({workflow:graph(),input:'Inspect two independent items.'});
  await waitFor(()=>engine.getRun(run.id).settled,'worker dispatch');
  assert.ok(result,'coordinator must invoke the real delegate handler');
  const data=JSON.parse(result.contentItems[0].text);
  assert.equal(denied.success,false);assert.equal(data.completed,2);
  assert.equal(data.results.find(row=>row.id==='inherited').status,'completed');
  assert.deepEqual(runtime.calls.map(call=>call.model),['test-model','test-model','test-model']);
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
test('retired history migration entry point is absent',async t=>{
 const {engine}=await fixture(t,async(options,n)=>out(n),{autoStart:false});
 assert.equal(engine.nativeHistoryDescription,undefined);assert.equal(engine.recoverNativeHistoryMigration,undefined);
});

test('old native agent catalog is rejected without replacing the conversation',async t=>{
 const {engine,conversations,runtime}=await fixture(t,async(options,n)=>out(n),{autoStart:false});
 const first=engine.startRun({workflow:graph(),input:'Original task.'});await waitFor(()=>engine.getRun(first.id).settled);
 const original=engine.runs.get(first.id);original.nodes.agent.nativeAgentSchemaVersion=1;
 const before=structuredClone(original),family=await conversations.family(first.id),count=engine.runs.size,calls=runtime.calls.length;
 assert.throws(()=>engine.continueRun(first.id,{nodeId:'agent',message:'Continue'},{historyRuns:family.runs}),{code:'NATIVE_CATALOG_UNSUPPORTED'});
 assert.deepEqual(original,before);assert.equal(engine.runs.size,count);assert.equal(runtime.calls.length,calls);
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
