import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {directoryDiagnosticsMode,prepareDirectoryContext,observeDirectoryProvider} from '../lib/directory-context-receipt.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';

test('directory preparation records metadata without raw material and distinguishes weak provider signals',()=>{
  assert.throws(()=>directoryDiagnosticsMode('auto'),{code:'DIRECTORY_DIAGNOSTICS_MODE_INVALID'});
  const run={id:'next',taskId:'root',input:'PRIVATE',goalDispatch:{objective:'PRIVATE'},attachmentIds:['PRIVATE'],pastChats:'off'};
  const receipt=prepareDirectoryContext({run,nodeId:'agent',resumed:true,attachmentsIncluded:true,identityIncluded:true,
    continuity:{method:'saved-messages',sourceRunId:'older',retainedChars:123,truncated:true,transcriptPath:'PRIVATE',text:'PRIVATE'}});
  assert.equal(receipt.requestSource,'goal-dispatch');assert.equal(receipt.providerSession,'resumed-opaque');
  assert.deepEqual(receipt.attachments,{selectedCount:1,included:true});assert.deepEqual(receipt.continuity,{method:'saved-messages',sourceRunId:'older',retainedChars:123,truncated:true});
  assert.equal(observeDirectoryProvider(receipt,{type:'thread',turnId:'turn'}),false);
  assert.equal(observeDirectoryProvider(receipt,{type:'item',data:'PRIVATE'}),false);
  assert.equal(observeDirectoryProvider(receipt,{type:'turn',turnId:'turn'},'2026-11-19T09:00:00.000Z'),true);
  assert.equal(observeDirectoryProvider(receipt,{type:'turn',turnId:'turn'},'later'),false);
  assert.doesNotMatch(JSON.stringify(receipt),/PRIVATE/);
});

test('Directory only follows its own task, and changes neither fresh prompts nor catalog',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'directory-context-receipt-')), calls=[];let engine;
  class Runtime extends EventEmitter{
    status(){return {connected:true,authenticated:true,defaultModel:'demo',models:[{id:'demo',model:'demo',available:true}]};}
    async runAgent(options){calls.push(options);options.onEvent({type:'turn',turnId:'fixture-turn',status:'completed'});return {output:'done',threadId:'native-fixture'};}
  }
  engine=new HarnessEngine({runtime:new Runtime(),dataDir:dir,defaultCwd:dir});
  t.after(async()=>{await engine.close();await rm(dir,{recursive:true,force:true});});await engine.init();
  const task='Identical ordinary input',workflow=createMissionWorkflow({task,model:'demo',cwd:dir,id:'directory-context-receipt',planningMode:'off'});
  async function saved(run){await engine.executions.get(run.id);const result=engine.getRun(run.id);assert.equal(result.status,'completed',result.error);return result;}
  const start=directoryDiagnostics=>engine.startRun({workflow,input:{task,pastChats:'off',...(directoryDiagnostics?{directoryDiagnostics}:{})}});
  const off=await saved(start()),on=await saved(start('on'));
  assert.notEqual(off.taskId,on.taskId);assert.equal(off.nodes.agent.directoryContext,undefined);
  const first=on.nodes.agent.directoryContext;
  assert.equal(first.taskId,on.taskId);assert.equal(first.runId,on.id);assert.equal(first.providerSession,'fresh');assert.equal(first.continuity.method,'none');assert.ok(first.providerObservedAt);
  assert.equal(calls[0].prompt,calls[1].prompt);assert.equal(calls[0].developerInstructions,calls[1].developerInstructions);assert.deepEqual(calls[0].dynamicTools,calls[1].dynamicTools);
  const continued=await saved(engine.continueRun(on.id,{nodeId:'agent',message:'Inspect this task'}));
  assert.equal(continued.taskId,on.taskId);assert.equal(continued.directoryDiagnostics,'on');assert.equal(continued.nodes.agent.directoryContext.taskId,on.taskId);
  const disabled=await saved(engine.continueRun(continued.id,{nodeId:'agent',message:'Next check',directoryDiagnostics:'off'}));
  assert.equal(disabled.directoryDiagnostics,'off');assert.equal(disabled.nodes.agent.directoryContext,undefined);
  assert.throws(()=>start('auto'),{code:'DIRECTORY_DIAGNOSTICS_MODE_INVALID'});
});
