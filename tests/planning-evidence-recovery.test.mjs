import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime} from '../lib/planning-browser-runtime.mjs';
import {TaskViability} from '../lib/task-viability.mjs';
import {ResponseCycleService} from '../lib/response-cycle.mjs';

const marker='river-survey-47';
const retired={code:'PLANNING_CYCLE_RETIRED',status:410};
const workflow=()=>({id:'recovery-fixture',name:'Evidence recovery fixture',nodes:[
  {id:'input',type:'input'},
  {id:'agent',type:'agent',name:'Operational worker',model:'fixture-model',effort:'low',prompt:'Complete the requested task using available evidence.'},
  {id:'output',type:'output'},
],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{planningMode:'on'}});

async function fixture(t,{executionGuardrails=false,mode='automatic',missingRecord=false}={}){
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-evidence-recovery-'));
  if(!missingRecord)await writeFile(path.join(dir,'project.txt'),'Project marker: '+marker+'\nStudy the river survey records.\n');
  const settings={defaultModel:'fixture-model',defaultEffort:'low',runTimeoutMs:null,executionGuardrails},calls=[],operations=[];
  let identityReads=0;
  class Runtime extends EventEmitter {
    status(){return {connected:true,authenticated:true,defaultModel:'fixture-model',models:[{id:'fixture-model',model:'fixture-model',defaultReasoningEffort:'low'}]};}
    async close(){}
    async runAgent(options){
      if(options.responseOnly){calls.push(options);throw Error('Retired evidence preflight must not invoke a provider.');}
      assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_workspace'));
      const receipt=await options.onToolCall({name:'relay_workspace',arguments:{action:'read',path:'project.txt'}});
      operations.push({prompt:options.prompt,receipt});
      if(missingRecord){
        assert.equal(receipt.success,false);
        return {output:'The workspace read failed because project.txt is unavailable. No project marker was established.',threadId:'operational-fixture'};
      }
      assert.equal(receipt.success,true,JSON.stringify(receipt));
      const text=receipt.contentItems.filter(item=>item.type==='inputText').map(item=>item.text).join('\n');
      assert.match(text,new RegExp(marker));
      return {output:'The actual workspace record identifies project '+marker+'.',threadId:'operational-fixture',turnId:'operational-1'};
    }
  }
  const runtime=new Runtime(),store=await new PlanningBrowserStore({dataDir:dir}).init(),engine=await new HarnessEngine({runtime,dataDir:dir,defaultCwd:dir}).init();
  engine.runtimeSettings={get:()=>settings};
  const runner=new PlanningBrowserRuntime({store,runtime,defaultCwd:dir,getSettings:()=>settings});
  const taskViability=new TaskViability({store,runner,engine,identity:{read:async()=>{identityReads++;throw Error('Retired source lookup must not run.');}},getSettings:()=>settings});
  const service=new ResponseCycleService({store,runner,taskViability,engine,getSettings:()=>settings});engine.responseCycle=service;
  t.after(async()=>{await engine.close();await runner.close();await service.close();await taskViability.close();await store.close();await rm(dir,{recursive:true,force:true});});
  const run=()=>({id:'recovery-fixture',taskId:'recovery-fixture',input:'Prepare the saved project summary.',cwd:dir,workflow:workflow(),attachmentIds:[],planningMode:'on',planningExecutionMode:mode,runtimeSettings:settings});
  return {dir,settings,store,engine,service,taskViability,calls,operations,run,get identityReads(){return identityReads;}};
}

test('retired advisory and enforced readiness calls reject without reading evidence or creating a graph',async t=>{
  for(const executionGuardrails of [false,true])await t.test(String(executionGuardrails),async t=>{
    const f=await fixture(t,{executionGuardrails}),before=await f.store.list();
    for(const operation of [
      ()=>f.service.forRun(f.run()),
      ()=>f.taskViability.forRun(f.run()),
      ()=>f.taskViability.ensure(f.run()),
      ()=>f.taskViability.assess('recovery-fixture')
    ])await assert.rejects(async()=>operation(),retired);
    assert.deepEqual(await f.store.list(),before);assert.equal(f.identityReads,0);
    assert.equal(f.operations.length,0);assert.equal(f.calls.length,0);assert.equal(f.engine.listRuns().length,0);
  });
});

test('ordinary automatic work reads available evidence without a compulsory analytical pass or provisional question',async t=>{
  const f=await fixture(t),accepted=f.engine.startRun({workflow:workflow(),input:'Prepare the saved project summary.',requestId:'evidence-recovery-fixture'});
  await f.engine.executions.get(accepted.id);
  const run=f.engine.getRun(accepted.id);
  assert.equal(run.status,'completed',run.error);assert.equal(f.operations.length,1);
  assert.equal(run.nodes.agent.status,'completed');assert.equal(run.nodes.agent.viabilityHeld,undefined);
  assert.equal(run.viability,undefined);assert.equal(run.responseCycle,undefined);
  assert.match(run.output,new RegExp(marker));assert.doesNotMatch(run.output,/Which project marker should I use/);
  assert.equal(f.calls.length,0);assert.equal(f.identityReads,0);
});

test('stale plan-only intent is rejected before Engine admission rather than running or silently continuing',async t=>{
  const f=await fixture(t,{mode:'plan_only'});
  await assert.rejects(f.service.forRun(f.run()),retired);
  assert.throws(()=>f.engine.startRun({workflow:workflow(),input:'Prepare the saved project summary.',planningExecutionMode:'plan_only'}),{code:'PLANNING_EXECUTION_MODE_RETIRED',status:400});
  assert.equal(f.engine.listRuns().length,0);assert.equal(f.operations.length,0);assert.equal(f.calls.length,0);
});

test('a genuinely unavailable record remains an explicit failed observation, not a fabricated fact or Planning hold',async t=>{
  const f=await fixture(t,{missingRecord:true}),accepted=f.engine.startRun({workflow:workflow(),input:'Inspect the project record and report its availability.'});
  await f.engine.executions.get(accepted.id);
  const run=f.engine.getRun(accepted.id);
  assert.equal(run.status,'completed',run.error);assert.equal(f.operations.length,1);assert.equal(f.operations[0].receipt.success,false);
  assert.match(run.output,/unavailable/);assert.doesNotMatch(run.output,new RegExp(marker));
  assert.equal(run.nodes.agent.viabilityHeld,undefined);assert.equal(run.viability,undefined);assert.equal(f.calls.length,0);
});

test('retired source refresh and technical recovery cannot convert unknown evidence into execution permission',async t=>{
  const f=await fixture(t),run=f.run(),before=structuredClone(run);
  for(const operation of [
    ()=>f.taskViability.refreshSources(run,{}),
    ()=>f.taskViability.answer('recovery-fixture',{value:'invented-marker'}),
    ()=>f.service.answerQuestion('recovery-fixture',{value:'invented-marker'}),
    ()=>f.service.continueCycle('recovery-fixture','retired-cycle',{})
  ])await assert.rejects(async()=>operation(),retired);
  assert.deepEqual(run,before);assert.equal(f.identityReads,0);assert.equal(f.operations.length,0);assert.equal(f.calls.length,0);
});
