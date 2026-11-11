import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {TaskStateStore} from '../lib/task-state.mjs';
import {createWorkspaceToolHandler} from '../lib/workspace-tools.mjs';
import {createOperationalEffectGuard} from '../lib/operational-effect-guard.mjs';
import {HarnessEngine} from '../lib/engine.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';

const call=(action,pathValue,textValue,callId)=>({name:'relay_workspace',callId,arguments:{action,path:pathValue,...(textValue===undefined?{}:{text:textValue})}});
const readCode=result=>{
  try{return JSON.parse(result.contentItems?.find(item=>item.type==='inputText')?.text||'{}').code||result.code;}
  catch{return result.code;}
};
async function fixture(t){
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-standalone-workspace-effects-'));
  const cwd=path.join(directory,'workspace');await mkdir(cwd);
  const store=await new TaskStateStore({dataDir:directory}).init();
  t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true});});
  const raw=createWorkspaceToolHandler({cwd});
  const guard=(nodeId='agent')=>createOperationalEffectGuard({store,cwd,taskId:'work',runId:'work-run',nodeId});
  return{directory,cwd,store,raw,guard};
}

test('real native workspace writes persist a hash-backed receipt and may be revised without a planning contract',async t=>{
  const f=await fixture(t),guard=f.guard();
  const handle=guard.wrap(f.raw);
  assert.equal((await handle(call('write','notes.txt','first','write-1'))).success,true);
  assert.equal(await readFile(path.join(f.cwd,'notes.txt'),'utf8'),'first');
  let rows=await guard.records();
  assert.equal(rows.length,1);
  assert.equal(rows[0].effect,'interact');
  assert.equal(rows[0].state,'confirmed');
  assert.match(rows[0].resultDigest,/^[a-f0-9]{64}$/);
  assert.equal((await handle(call('write','notes.txt','updated','write-2'))).success,true);
  rows=await guard.records();
  assert.equal(rows.length,2);
  assert.ok(rows.every(row=>row.state==='confirmed'));
  assert.equal(await readFile(path.join(f.cwd,'notes.txt'),'utf8'),'updated');
  assert.equal((await handle(call('read','notes.txt',undefined,'read-1'))).success,true);
  assert.equal((await guard.records()).length,2,'read-only inspection is not reserved');
});

test('an uncertain native workspace edit fences only its exact file; independent files remain writable',async t=>{
  const f=await fixture(t),guard=f.guard();
  const failed=async(call,ctx)=>{
    await ctx.onOperationDispatch(await f.raw.describeOperation(call,ctx));
    return{success:false,code:'NATIVE_OUTPUT_LOST',contentItems:[{type:'inputText',text:JSON.stringify({actionDispatched:true,code:'NATIVE_OUTPUT_LOST'})}]};
  };
  failed.describeOperation=f.raw.describeOperation;
  failed.normalizeOperationResult=f.raw.normalizeOperationResult;
  const missed=await guard.wrap(failed)(call('write','blocked.txt','maybe-written','fault-1'));
  assert.equal(missed.success,false);
  assert.equal((await guard.records())[0].state,'unknown');
  const second=await guard.wrap(f.raw)(call('write','blocked.txt','do-not-replay','fault-2'));
  assert.equal(second.success,false);
  assert.equal(readCode(second),'OPERATIONAL_EFFECT_UNCERTAIN');
  assert.equal((await guard.wrap(f.raw)(call('write','other.txt','independent','ok-3'))).success,true);
  assert.equal(await readFile(path.join(f.cwd,'other.txt'),'utf8'),'independent');
  assert.equal((await guard.records()).at(-1).state,'confirmed');
});

test('unclassified shell commands are not converted into a fake global reservation gate',async t=>{
  const f=await fixture(t),guard=f.guard();
  let invoked=0;
  const fake=async()=>{invoked++;return {success:true,contentItems:[{type:'inputText',text:JSON.stringify({exitCode:0})}]}};
  const run={name:'relay_workspace',arguments:{action:'run',command:'Write-Output 1'}};
  await guard.wrap(fake)(run);await guard.wrap(fake)(run);
  assert.equal(invoked,2);
  assert.deepEqual(await guard.records(),[]);
});

test('actual HarnessEngine tool dispatch uses the independent guard without a plan or attached task context',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-ops-engine-')),cwd=path.join(directory,'workspace');
  await mkdir(cwd);
  const tasks=await new TaskStateStore({dataDir:directory}).init();
  let providerTurns=0;
  class Runtime extends EventEmitter {
    status(){return{connected:true,authenticated:true,defaultModel:'fixture-model',models:[{id:'fixture-model',supportsTools:true}]};}
    async runAgent(options){
      providerTurns++;
      const tool=call('write','engine-proof.txt','first', 'engine-effect-1');
      const first=await options.onToolCall(tool);
      const identical=await options.onToolCall(tool);
      assert.equal(first.success,true);
      assert.deepEqual(identical,first,'the same provider call ID must not dispatch another mutation');
      assert.doesNotMatch(options.developerInstructions,/Save this turn.s task outline first/i);
      return{output:'Saved local proof',threadId:'operational-test-thread'};
    }
    async close(){}
  }
  const runtime=new Runtime();
  const engine=await new HarnessEngine({runtime,tasks,dataDir:directory,defaultCwd:cwd}).init();
  engine.runtimeSettings={get:()=>({executionGuardrails:false,subagentsEnabled:false})};
  t.after(async()=>{await engine.close();await tasks.close();await rm(directory,{recursive:true,force:true});});
  const workflow=createMissionWorkflow({task:'Save one proof',model:'fixture-model',cwd,planningMode:'off'});
  const started=engine.startRun({workflow,input:{task:'Save one proof',cwd,planningMode:'off'}});
  let finished;
  for(let i=0;i<200;i++){
    finished=engine.getRun(started.id);
    if(finished?.settled)break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(finished.status,'completed',finished.error||finished.nodes.agent?.error);
  assert.equal(providerTurns,1,'no planning or evidence-review model pass');
  assert.equal(await readFile(path.join(cwd,'engine-proof.txt'),'utf8'),'first');
  const claims=await createOperationalEffectGuard({store:tasks,cwd,taskId:started.id,runId:started.id,nodeId:'agent'}).records();
  assert.equal(claims.length,1);
  assert.equal(claims[0].state,'confirmed');
  assert.match(claims[0].resultDigest,/^[a-f0-9]{64}$/);
});
