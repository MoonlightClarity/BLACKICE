import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {ConversationArchive} from '../lib/conversations.mjs';
import {ConversationAutonomy,AUTONOMY_TOOL} from '../lib/conversation-autonomy.mjs';
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
  const autonomy=await new ConversationAutonomy({engine,conversations,autoStart:options.autoStart??true,continuationDelayMs:10}).init();
  t.after(async()=>{await autonomy.close();await engine.close();await conversations.close();await rm(dir,{recursive:true,force:true});});
  return {engine,conversations,autonomy,runtime};
}
async function autonomyCall(options,args){
  return options.onToolCall({name:'relay_autonomy',arguments:args});
}
const out=n=>({output:'Verified fixture turn '+n,threadId:'autonomy_mock_thread_'+n});

test('autonomy is independent of Goal and switches next coordinator model at a real mocked runtime dispatch',async t=>{
  const {engine,autonomy,runtime,conversations}=await fixture(t,async(options,n)=>{
    if(n===1){assert.equal(options.dynamicTools?.some(x=>x.name===AUTONOMY_TOOL.name)||false,false);return out(n);}
    assert.ok(options.dynamicTools.some(x=>x.name===AUTONOMY_TOOL.name),'autonomy tool must reach actual coordinator provider catalog');
    assert.match(options.prompt,/AUTONOMOUS OPERATING MODE \(NOT A GOAL\)/);
    assert.ok(!options.prompt.includes('PERSISTENT CONVERSATION GOAL'),'autonomy must not invent a Goal');
    if(n===2){
      const selected=await autonomyCall(options,{action:'select_model',model:'alternate-model'});
      assert.equal(selected.success,true);
      const progress=await autonomyCall(options,{action:'progress',summary:'Reviewed evidence; changing to another eligible model.'});
      assert.equal(progress.success,true);
    }else{
      assert.equal(options.model,'alternate-model');
      const idle=await autonomyCall(options,{action:'idle',summary:'The useful work is finished. No new task is warranted.'});
      assert.equal(idle.success,true);
    }
    return out(n);
  });
  const first=engine.startRun({workflow:graph(),input:'Help with a useful small task.'});
  await waitFor(()=>engine.getRun(first.id).settled,'manual initial turn');
  assert.equal(await autonomy.get(first.id),null,'ordinary conversation has no implicit autonomy');
  await autonomy.control(first.id,{action:'enable',modelAllowlist:['test-model','alternate-model'],calibration:'Prefer low-cost models.'});
  try { await waitFor(async()=>(await autonomy.get(first.id))?.status==='idle','autonomy yielded after model switch'); }
  catch(error) { console.error('AUTONOMY MOCK DEBUG',JSON.stringify({state:await autonomy.get(first.id),calls:runtime.calls.map(c=>c.model),runs:(await conversations.family(first.id)).runs.map(x=>({id:x.id,status:x.status,error:x.error,errorCode:x.errorCode,autonomy:x.autonomy,model:x.workflow.nodes.find(n=>n.type==='agent')?.model}))}));throw error; }
  assert.deepEqual(runtime.calls.map(call=>call.model||'test-model'),['test-model','test-model','alternate-model']);
  assert.equal((await autonomy.get(first.id)).enabled,true);
  const family=await conversations.family(first.id);
  assert.equal(family.runs.length,3);
  assert.ok(family.runs[1].autonomy.automatic);
  assert.ok(family.runs[2].autonomy.automatic);
  assert.equal(family.runs[2].workflow.nodes.find(node=>node.type==='agent').model,'alternate-model');
});

test('non-whitelisted autonomous selection fails without a provider call',async t=>{
  const {engine,autonomy,runtime}=await fixture(t,async(options,n)=>{
    if(n===1)return out(n);
    const denied=await autonomyCall(options,{action:'select_model',model:'premium-model'});
    assert.equal(denied.success,false);
    assert.equal(denied.code,'AUTONOMY_MODEL_NOT_ALLOWED');
    const idle=await autonomyCall(options,{action:'idle',summary:'No eligible alternative for this fixture.'});
    assert.equal(idle.success,true);
    return out(n);
  });
  const first=engine.startRun({workflow:graph(),input:'Perform a small operation.'});
  await waitFor(()=>engine.getRun(first.id).settled);
  await autonomy.control(first.id,{action:'enable',modelAllowlist:['test-model']});
  await waitFor(async()=>(await autonomy.get(first.id))?.status==='idle');
  assert.equal(runtime.calls.length,2);
  assert.equal((await autonomy.get(first.id)).selectedModel,null);
});

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


test('non-whitelisted coordinator model is rejected at actual provider dispatch',async t=>{
  const {engine,autonomy,runtime,conversations}=await fixture(t,async(options,n)=>out(n),{autoStart:false});
  const first=engine.startRun({workflow:graph(),input:'A small task.'});
  await waitFor(()=>engine.getRun(first.id).settled);
  await autonomy.control(first.id,{action:'enable',modelAllowlist:['test-model','alternate-model']});
  const state=await autonomy.get(first.id);
  const family=await conversations.family(first.id);
  const invalid=engine.continueRun(first.id,{
    nodeId:'agent',message:'System continuation requiring a provider.',model:'premium-model',requestId:'invalid-coordinator-model'
  },{
    historyRuns:family.runs,threadModel:'test-model',
    autonomyDispatch:{id:state.id,generation:state.generation,epoch:autonomy.epochs.get(first.id)||0},
  });
  await waitFor(()=>engine.getRun(invalid.id).settled);
  const run=engine.getRun(invalid.id);
  assert.equal(runtime.calls.length,1,'invalid model must be denied before provider token use');
  assert.equal(run.status,'failed');
  assert.equal(run.errorCode,'AUTONOMY_MODEL_NOT_ALLOWED');
});

test('legacy Goal and separate autonomy never launch competing continuation loops',async t=>{
  const {engine,autonomy,conversations}=await fixture(t,async(options,n)=>out(n),{autoStart:false});
  const goals=await new ConversationGoals({engine,conversations,autoStart:false}).init();
  t.after(()=>goals.close());
  const first=engine.startRun({workflow:graph(),input:'One independent answer.'});
  await waitFor(()=>engine.getRun(first.id).settled);
  await autonomy.control(first.id,{action:'enable',modelAllowlist:['test-model'],calibration:'Do not spend premium quota.'});
  await assert.rejects(()=>goals.control(first.id,{action:'set',objective:'Legacy persistent goal.',requestId:'legacy-goal-conflict'}),
    error=>error.code==='GOAL_AUTONOMY_CONFLICT');
  const protectedRow=await autonomy.get(first.id);
  assert.deepEqual(protectedRow.modelAllowlist,['test-model']);
  await autonomy.control(first.id,{action:'disable',expectedRevision:protectedRow.revision});
  const created=await goals.control(first.id,{action:'set',objective:'Legacy persistent goal.',requestId:'legacy-goal-create'});
  assert.equal(created.goal.objective,'Legacy persistent goal.');
  assert.equal(created.goal.status,'active');
  await assert.rejects(()=>autonomy.control(first.id,{action:'enable',modelAllowlist:['test-model']}),
    error=>error.code==='AUTONOMY_GOAL_CONFLICT');
  assert.equal((await goals.get(first.id)).objective,'Legacy persistent goal.');
  assert.equal((await autonomy.get(first.id)).enabled,false);
});

test('native history restoration can include autonomy without losing saved tool schema',async t=>{
  const {engine}=await fixture(t,async(options,n)=>out(n),{autoStart:false});
  const sample={
    id:'native-history',taskId:'native-history',workflow:{nodes:[{id:'agent',type:'agent',model:'test-model'}],settings:{}},
    nodes:{agent:{status:'completed',toolNames:['relay_autonomy']}},
    runtimeSettings:{},planningMode:'off',
  };
  const schema=engine.nativeHistoryDescription(sample,sample.workflow.nodes[0],sample.nodes.agent,'native-test');
  assert.equal(schema.dynamicTools.length,1);
  assert.equal(schema.dynamicTools[0].name,'relay_autonomy');
});

test('user may explicitly choose model for a manual turn without silently changing autonomous allowlist',async t=>{
  const {engine,autonomy,runtime,conversations}=await fixture(t,async(options,n)=>{
    if(n===1)return out(n);
    if(n===2)assert.equal(options.model,'premium-model','manual selection remains explicit');
    return out(n);
  });
  const first=engine.startRun({workflow:graph(),input:'Answer a short question.'});
  await waitFor(()=>engine.getRun(first.id).settled);
  await autonomy.control(first.id,{action:'enable',modelAllowlist:['test-model']});
  const row=await autonomy.get(first.id);
  await autonomy.control(first.id,{action:'disable',expectedRevision:row.revision});
  const family=await conversations.family(first.id);
  const followup=engine.continueRun(first.id,{nodeId:'agent',model:'premium-model',message:'Explicit user selection for this one response.'},{historyRuns:family.runs});
  await waitFor(()=>engine.getRun(followup.id).settled);
  assert.equal(runtime.calls.length,2);
  assert.deepEqual((await autonomy.get(first.id)).modelAllowlist,['test-model']);
  assert.equal((await autonomy.get(first.id)).enabled,false);
});
