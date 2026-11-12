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


test('unrelated native file writes do not request owner recovery or alter opaque history',async t=>{
  const f=await fixture(t),before=await fs.readFile(f.legacy,'utf8');
  assert.equal((await f.guard.wrap(f.raw)(call('first'))).success,true);
  assert.equal((await f.guard.wrap(f.raw)(call('second'))).success,true);
  assert.equal(f.broker.list().length,0);
  assert.equal(await fs.readFile(f.legacy,'utf8'),before);
});
test('concrete file uncertainty remains blocked without inventing an owner exception',async t=>{
  const f=await fixture(t),descriptor=await f.raw.describeOperation(call());
  await fs.writeFile(f.legacy,JSON.stringify(journal([{...row,effect:'interact',tool:'relay_workspace',action:'write',resources:descriptor.resources}])));
  assert.equal((await f.guard.wrap(f.raw)(call())).code,'TASK_CONTRACT_EFFECT_UNCERTAIN');
  assert.equal(f.broker.list().length,0);
});
test('browser submission remains admitted past unrelated shell history and duplicate protection remains active',async t=>{
  const f=await fixture(t);let dispatched=0;
  const descriptor={version:1,effect:'commit',operationKey:'current-submit',resources:[{key:'destination:https://example.test/submit',access:'write'}],
    commit:{effectKey:'exact-submit',destinationKey:'destination:https://example.test/submit',payloadDigest:'exact-payload'}};
  const raw=async(c,context)=>{await context.onOperationDispatch(descriptor);dispatched++;return{success:true,contentItems:[]};};
  raw.describeOperation=async()=>descriptor;
  const c={name:'relay_browser',callId:'one',arguments:{action:'click',tabId:'tab',ref:'submit'}};
  assert.equal((await f.guard.wrap(raw)(c)).success,true);
  await assert.rejects(f.guard.wrap(raw)({...c,callId:'two'}),{code:'OPERATIONAL_EFFECT_UNCERTAIN'});
  assert.equal(dispatched,1);assert.equal(f.broker.list().length,0);
});
test('actual HarnessEngine continues two authorized writes without review for unrelated old opaque history',async t=>{
  const f=await fixture(t);let calls=0;
  class Runtime extends EventEmitter{
    status(){return{connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',supportsTools:true}]};}
    async runAgent(options){calls++;assert.equal((await options.onToolCall(call('one','engine-one'))).success,true);
      assert.equal((await options.onToolCall(call('two','engine-two'))).success,true);return{output:'Two writes completed',threadId:'write-thread'};}
    async close(){}
  }
  const engine=await new HarnessEngine({runtime:new Runtime(),tasks:f.store,dataDir:path.join(f.directory,'engine'),defaultCwd:f.cwd,ownerRecovery:f.broker}).init();
  engine.runtimeSettings={get:()=>({executionGuardrails:false,subagentsEnabled:false})};f.beforeClose.push(()=>engine.close());
  const before=await fs.readFile(f.legacy,'utf8');
  const workflow=createMissionWorkflow({task:'Write a file',model:'fixture',cwd:f.cwd,planningMode:'off'});
  const run=engine.startRun({workflow,input:{task:'Write a file',cwd:f.cwd,planningMode:'off'}});
  await engine.executions.get(run.id);
  assert.equal(engine.getRun(run.id).status,'completed',engine.getRun(run.id).error);
  assert.equal(calls,1);assert.equal(f.broker.list().length,0);
  assert.equal(await fs.readFile(path.join(f.cwd,'out.txt'),'utf8'),'two');
  assert.equal(await fs.readFile(f.legacy,'utf8'),before);
});

for(const outcome of ['approve','cancel','drift'])test('explicit overlapping destination recovery remains exact: '+outcome,async t=>{
  const f=await fixture(t),destination='destination:https://explicit.test/submit';
  await fs.writeFile(f.legacy,JSON.stringify(journal([{...row,resources:[{key:destination,access:'write'}]}])));
  let dispatched=0,current='original';
  const d={effect:'commit',operationKey:'new-submit',resources:[{key:destination,access:'write'}],commit:{effectKey:'submit',destinationKey:destination,payloadDigest:'payload'}};
  const raw=async(c,context)=>{
    try{await context.onOperationDispatch(d);}catch(error){return{success:false,code:error.code,contentItems:[{type:'inputText',text:JSON.stringify({actionDispatched:false})}]};}
    dispatched++;return{success:true,contentItems:[]};
  };
  raw.describeOperation=async()=>d;
  raw.captureRecoveryBinding=async()=>({documentId:current});
  raw.revalidateRecoveryBinding=async binding=>{if(binding.documentId!==current)throw Object.assign(Error('changed'),{code:'OWNER_RECOVERY_PRECONDITION',actionDispatched:false});};
  const before=await fs.readFile(f.legacy,'utf8');
  const promise=f.guard.wrap(raw)({name:'relay_browser',callId:'exact',arguments:{action:'click',tabId:'tab',ref:'submit'}}),pending=await f.pending();
  if(outcome==='cancel')f.broker.cancel({requestId:pending.requestId,revision:pending.revision,actor});
  else{if(outcome==='drift')current='changed';await f.approve();}
  const result=await promise;
  assert.equal(result.success,outcome==='approve');assert.equal(dispatched,outcome==='approve'?1:0);
  assert.equal(await fs.readFile(f.legacy,'utf8'),before);
  assert.equal(f.broker.read(pending.requestId).state,outcome==='approve'?'consumed':outcome==='cancel'?'cancelled':'invalidated');
});
