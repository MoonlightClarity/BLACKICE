import {EventEmitter} from 'node:events';
import {HarnessEngine} from '../lib/engine.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createOwnerRecovery } from '../lib/owner-recovery.mjs';
import { TaskStateStore } from '../lib/task-state.mjs';
import { createWorkspaceToolHandler } from '../lib/workspace-tools.mjs';
import { createOperationalEffectGuard } from '../lib/operational-effect-guard.mjs';
const actor='native-owner-confirmation';
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
const call=(text='new',callId=crypto.randomUUID())=>({name:'relay_workspace',callId,arguments:{action:'write',path:'out.txt',text}});
const journal=records=>({version:3,policy:'work-items-v2',taskId:'old',journalSeq:10,records,evidence:[],focuses:[],judgments:[],findings:[],progress:[]});
const row={operationId:'old-command',runId:'old-run',nodeId:'old-node',workItemId:'item',journalSeq:1,
  effect:'opaque',tool:'relay_workspace',action:'run',deliveryState:'interrupted',effectState:'unknown',
  resources:[{key:'path:/old-workspace',access:'write'}],evidenceIds:[],operationKey:'old-key'};
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-owner-recovery-')),cwd=path.join(directory,'workspace');
  await fs.mkdir(cwd);const store=await new TaskStateStore({dataDir:directory}).init();
  const broker=createOwnerRecovery({enabled:true}),controller=new AbortController(),beforeClose=[];
  t.after(async()=>{broker.close();for(const close of beforeClose)await close();await store.close();await fs.rm(directory,{recursive:true,force:true});});
  const legacy=store.file('old')+'.sequence';await fs.writeFile(legacy,JSON.stringify(journal([row])));
  const raw=createWorkspaceToolHandler({cwd,signal:controller.signal});
  const guard=createOperationalEffectGuard({store,cwd,taskId:'new',runId:'run',nodeId:'node',ownerRecovery:broker,signal:controller.signal});
  const pending=async()=>{for(let i=0;i<200;i++){const r=broker.list().find(r=>r.state==='pending');if(r)return r;await tick();}throw Error('No pending review');};
  const approve=async()=>{const r=await pending();return broker.approve({requestId:r.requestId,revision:r.revision,actor});};
  return{directory,cwd,store,legacy,broker,controller,guard,raw,pending,approve,beforeClose};
}
test('one exact approved file action runs once and retains historical uncertainty',async t=>{
  const f=await fixture(t),before=await fs.readFile(f.legacy,'utf8'),c=call();
  const promise=f.guard.wrap(f.raw)(c),pending=await f.pending();
  assert.equal(pending.candidate.parameters.text,'new');
  assert.equal(pending.candidate.preconditions.kind,'absent-file');
  assert.equal(await fs.stat(path.join(f.cwd,'out.txt')).catch(()=>null),null);
  await f.approve();assert.equal((await promise).success,true);
  assert.equal(await fs.readFile(path.join(f.cwd,'out.txt'),'utf8'),'new');
  assert.equal(await fs.readFile(f.legacy,'utf8'),before);
  assert.equal(f.broker.read(pending.requestId).state,'consumed');
  assert.equal((await f.guard.wrap(f.raw)(c)).success,true,'exact saved result is returned without new dispatch');
  assert.equal(f.broker.list().length,1);
});
test('default disabled does not request or bypass recovery',async t=>{
  const f=await fixture(t),broker=createOwnerRecovery();
  const g=createOperationalEffectGuard({store:f.store,cwd:f.cwd,taskId:'new',runId:'other',nodeId:'node',ownerRecovery:broker});
  const r=await g.wrap(f.raw)(call());assert.equal(r.code,'TASK_CONTRACT_EFFECT_UNCERTAIN');assert.equal(broker.list().length,0);
});
test('cancel and abort leave no file and no operation reservation',async t=>{
  const f=await fixture(t),p=f.guard.wrap(f.raw)(call()),r=await f.pending();
  f.broker.cancel({requestId:r.requestId,revision:r.revision,actor});
  assert.equal((await p).code,'OWNER_RECOVERY_CANCELLED');assert.equal((await f.guard.records()).length,0);
  const again=f.guard.wrap(f.raw)(call());await f.pending();f.controller.abort();
  assert.equal((await again).code,'OWNER_RECOVERY_CANCELLED');
});
test('changed file preimage invalidates approved action',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.cwd,'out.txt'),'first');
  const p=f.guard.wrap(f.raw)(call());await f.pending();await fs.writeFile(path.join(f.cwd,'out.txt'),'changed');await f.approve();
  const r=await p;assert.equal(r.success,false);assert.equal(await fs.readFile(path.join(f.cwd,'out.txt'),'utf8'),'changed');
});
test('new overlapping concrete legacy claim blocks despite approval',async t=>{
  const f=await fixture(t),p=f.guard.wrap(f.raw)(call());await f.pending();
  const descriptor=await f.raw.describeOperation(call());
  await fs.writeFile(f.legacy,JSON.stringify(journal([row,{...row,operationId:'new-file',journalSeq:2,effect:'interact',tool:'relay_workspace',action:'write',resources:descriptor.resources}])));
  await f.approve();const r=await p;assert.equal(r.success,false);
  assert.equal(await fs.stat(path.join(f.cwd,'out.txt')).catch(()=>null),null);
});
test('changed opaque claim cannot reuse previous approval',async t=>{
  const f=await fixture(t),p=f.guard.wrap(f.raw)(call());await f.pending();
  await fs.writeFile(f.legacy,JSON.stringify(journal([{...row,operationKey:'changed'}])));
  await f.approve();assert.equal((await p).success,false);
});
test('ordinary concrete uncertainty is not recoverable and shell replay has no recovery',async t=>{
  const f=await fixture(t);
  const c={name:'relay_workspace',callId:'shell',arguments:{action:'run',command:'must not execute'}};
  assert.equal((await f.guard.wrap(f.raw)(c)).code,'TASK_CONTRACT_EFFECT_UNCERTAIN');
  assert.equal(f.broker.list().length,0);
  const descriptor=await f.raw.describeOperation(call());
  await fs.writeFile(f.legacy,JSON.stringify(journal([{...row,effect:'interact',action:'write',resources:descriptor.resources}])));
  assert.equal((await f.guard.wrap(f.raw)(call())).code,'TASK_CONTRACT_EFFECT_UNCERTAIN');
  assert.equal(f.broker.list().length,0);
});
test('broker rejects stale revisions, repeated approval, caller authority, expiration and restart reuse',async()=>{
  let now=0;const b=createOwnerRecovery({enabled:true,now:()=>now,timeoutMs:10000});
  const req={taskId:'t',runId:'r',nodeId:'n',operationId:'o',candidate:{tool:'relay_workspace'},claims:[row]};
  const p=b.request(req);const r=b.list()[0];
  assert.throws(()=>b.approve({...r,actor:'agent'}),{code:'OWNER_RECOVERY_ACTOR'});
  assert.throws(()=>b.approve({requestId:r.requestId,revision:0,actor}),{code:'OWNER_RECOVERY_STALE'});
  b.approve({requestId:r.requestId,revision:1,actor});await p;
  assert.throws(()=>b.approve({requestId:r.requestId,revision:1,actor}),{code:'OWNER_RECOVERY_STALE'});
  now=11000;assert.throws(()=>b.consumed(r.requestId),{code:'OWNER_RECOVERY_EXPIRED'});
  const fresh=createOwnerRecovery({enabled:true});assert.equal(fresh.read(r.requestId),null);
  const p2=fresh.request(req);fresh.close();await assert.rejects(p2,{code:'OWNER_RECOVERY_CANCELLED'});
  b.close();
});

test('actual HarnessEngine pauses one exact call, continues another read, and does not inherit approval',async t=>{
  const f=await fixture(t);let calls=0;
  class Runtime extends EventEmitter{
    status(){return{connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',supportsTools:true}]};}
    async runAgent(options){
      calls++;
      if(options.prompt?.includes('inspection-only')){
        const result=await options.onToolCall({name:'relay_workspace',callId:'inspect',arguments:{action:'list',path:'.'}});
        assert.equal(result.success,true);return{output:'Inspected',threadId:'read-thread'};
      }
      const first=await options.onToolCall(call('one','engine-one'));
      assert.equal(first.success,true);
      const second=await options.onToolCall(call('two','engine-two'));
      assert.equal(second.code,'OWNER_RECOVERY_CANCELLED');
      return{output:'One permitted write, second cancelled',threadId:'write-thread'};
    }
    async close(){}
  }
  const engine=await new HarnessEngine({runtime:new Runtime(),tasks:f.store,dataDir:path.join(f.directory,'engine'),defaultCwd:f.cwd,ownerRecovery:f.broker}).init();
  engine.runtimeSettings={get:()=>({executionGuardrails:false,subagentsEnabled:false})};
  f.beforeClose.push(()=>engine.close());
  const workflow=createMissionWorkflow({task:'Write a file',model:'fixture',cwd:f.cwd,planningMode:'off'});
  const run=engine.startRun({workflow,input:{task:'Write a file',cwd:f.cwd,planningMode:'off'}});
  await f.pending();
  // The independent read is checked through the same active operational guard;
  // it must not need the pending review or acquire its exception.
  const result=await f.guard.wrap(f.raw)({name:'relay_workspace',arguments:{action:'list',path:'.'}});
  assert.equal(result.success,true);
  await f.approve();
  const second=await f.pending();assert.equal(second.candidate.parameters.text,'two');
  assert.equal(await fs.readFile(path.join(f.cwd,'out.txt'),'utf8'),'one');
  f.broker.cancel({requestId:second.requestId,revision:second.revision,actor});
  await engine.executions.get(run.id);
  assert.equal(engine.getRun(run.id).status,'completed',engine.getRun(run.id).error);
  assert.equal(calls,1);
  assert.equal(await fs.readFile(path.join(f.cwd,'out.txt'),'utf8'),'one');
});
