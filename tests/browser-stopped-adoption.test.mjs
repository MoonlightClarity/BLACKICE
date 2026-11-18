import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stoppedBrowserOwnerStatus, stoppedTabAdoption, ownerIdentity, readStoppedTabEffects } from '../lib/browser-stopped-adoption.mjs';
import { TaskStateStore } from '../lib/task-state.mjs';
import { createOperationalEffectGuard } from '../lib/operational-effect-guard.mjs';

const owner = {taskId:'task-a',runId:'run-a',nodeId:'agent'};
const fixture = () => {
  const run={id:owner.runId,taskId:owner.taskId,status:'completed',settled:true,nodes:{}};
  return {run, engine:{runs:new Map([[run.id,run]]), executionEntries:()=>[], conversationBusy:()=>false}};
};
test('stopped owner requires exact known terminal and settled task, not merely inactivity', () => {
  const {run,engine}=fixture();
  for(const status of ['completed','failed','cancelled']) {run.status=status;assert.equal(stoppedBrowserOwnerStatus(owner,engine).eligible,true);}
  for(const status of ['queued','running','paused','awaiting_input','awaiting-user','waiting','unknown']) {run.status=status;assert.equal(stoppedBrowserOwnerStatus(owner,engine).eligible,false,status);}
  run.status='completed';run.settled=false;assert.equal(stoppedBrowserOwnerStatus(owner,engine).eligible,false);
  run.settled=true;assert.equal(stoppedBrowserOwnerStatus({...owner,runId:'absent'},engine).eligible,false);
  assert.equal(stoppedBrowserOwnerStatus({...owner,taskId:'connector-task'},engine).eligible,false);
  engine.runs.set('later',{id:'later',taskId:owner.taskId,status:'running',settled:false});
  assert.equal(stoppedBrowserOwnerStatus(owner,engine).eligible,false);
  engine.runs.delete('later');engine.executionEntries=()=>[{run}];assert.equal(stoppedBrowserOwnerStatus(owner,engine).eligible,false);
  engine.executionEntries=()=>[{key:'unknown-execution'}];assert.equal(stoppedBrowserOwnerStatus(owner,engine).eligible,false);
});
test('historical restart and uncertainty do not veto a now-settled owner; storage failure stays unknown',()=>{
  const {run,engine}=fixture();
  run.browserOwnerInterrupted=true;assert.equal(stoppedBrowserOwnerStatus(owner,engine).eligible,true);delete run.browserOwnerInterrupted;
  run.error='The harness restarted before this run finished. Resume this run to continue from completed steps.';assert.equal(stoppedBrowserOwnerStatus(owner,engine).eligible,true);delete run.error;
  for(const taskState of [{externalRecovery:{required:true}},{executionObservations:{unavailable:true}},{externalActions:[{status:'uncertain'}]}]){
    run.taskState=taskState;assert.equal(stoppedBrowserOwnerStatus(owner,engine).eligible,true);
  }
  run.taskState={externalActions:[{status:'confirmed'}]};assert.equal(stoppedBrowserOwnerStatus(owner,engine).eligible,true);
  engine.storageError='disk';assert.equal(stoppedBrowserOwnerStatus(owner,engine).eligible,false);
});
test('page eligibility preserves dirty forms but rejects unfinished effects, user retention and unknown lifecycle',()=>{
  const base={tabId:'tab-a',owner},status={persistence:{healthy:true},downloads:[]}, resolve=()=>({eligible:true,runId:'run-a',status:'completed'});
  assert.equal(stoppedTabAdoption({...base,dirty:true},status,resolve).eligible,true);
  for(const patch of [{protectedContent:true},{purpose:'chat-mode'},{humanCreated:true},{userPinned:true},{pendingInteraction:{}},{interactionSettling:true},{loading:true},{effectInFlight:true},{owner:null}]){
    assert.equal(stoppedTabAdoption({...base,...patch},status,resolve).eligible,false,JSON.stringify(patch));
  }
  assert.equal(stoppedTabAdoption(base,{...status,downloads:[{tabId:'tab-a',status:'downloading'}]},resolve).eligible,false);
  assert.equal(stoppedTabAdoption(base,status).eligible,false);
  assert.equal(stoppedTabAdoption(base,status,()=>{throw Error('offline');}).eligible,false);
  assert.equal(ownerIdentity(owner),'["task-a","agent","run-a"]');
});
test('adoption checks retained native effect journal without clearing or moving uncertain receipts',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-adoption-effects-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const {run,engine}=fixture();run.cwd=directory;engine.tasks=await new TaskStateStore({dataDir:directory}).init();
  await readStoppedTabEffects(owner,engine);
  const guard=createOperationalEffectGuard({store:engine.tasks,cwd:directory,...owner});
  const journal={version:1,root:directory,records:[{operationId:'effect-a',taskId:owner.taskId,runId:owner.runId,nodeId:owner.nodeId,adapter:'relay_browser',effect:'opaque',state:'unknown',resources:['tab:tab-a']}]};
  await writeFile(engine.tasks.file(guard.scopeId)+'.effects',JSON.stringify(journal));
  const inherited=await readStoppedTabEffects(owner,engine);assert.equal(inherited.uncertain,true);assert.equal(inherited.operations[0].operationId,'effect-a');
  assert.deepEqual(await guard.records(),journal.records);
  await writeFile(engine.tasks.file(guard.scopeId)+'.effects','invalid');
  const missing=await readStoppedTabEffects(owner,engine);assert.equal(missing.uncertain,true);assert.equal(missing.unavailable,true);
});

test('shared conversation and active direct borrower are not exclusive stopped ownership',()=>{
  const {engine}=fixture();
  assert.equal(stoppedBrowserOwnerStatus({...owner,nodeId:'conversation'},engine).eligible,true);
  const row={id:'job',status:'running',browserConversationId:owner.taskId};const direct={jobs:{startup:{phase:'ready'},ownerSnapshot:({unfinishedOnly})=>unfinishedOnly&&row.status==='succeeded'?[]:[row]}};
  assert.equal(stoppedBrowserOwnerStatus(owner,engine,direct).eligible,false);
  row.status='awaiting_input';assert.equal(stoppedBrowserOwnerStatus(owner,engine,direct).eligible,false);
  row.status='succeeded';assert.equal(stoppedBrowserOwnerStatus(owner,engine,direct).eligible,true);
  direct.storageError='unknown';assert.equal(stoppedBrowserOwnerStatus(owner,engine,direct).eligible,false);
});

test('clean native family does not erase uncertain conversation direct effects',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'blackice-direct-inherited-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const {run,engine}=fixture();run.cwd=directory;engine.tasks=await new TaskStateStore({dataDir:directory}).init();
 const conversationOwner={...owner,nodeId:'conversation',conversationId:owner.taskId};
 const row={id:'direct-uncertain',tool:'blackice_browser_action',browserConversationId:owner.taskId,status:'interrupted',effects:{possible:true,confirmed:false}};
 const direct={jobs:{startup:{phase:'ready'},ownerSnapshot:()=>[row]}};
 const inherited=await readStoppedTabEffects(conversationOwner,engine,direct);
 assert.equal(inherited.unavailable,false);
 assert.equal(inherited.interrupted,false);
 assert.equal(inherited.planningUncertain,false);
 assert.equal(inherited.uncertain,true);
 assert.deepEqual(inherited.directJobs,[{jobId:row.id,tool:row.tool,status:row.status,effects:row.effects}]);
 assert.deepEqual(row.effects,{possible:true,confirmed:false});
});

