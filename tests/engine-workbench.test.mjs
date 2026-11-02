import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';

const graph=()=>({id:'vm-flow',name:'VM task',settings:{planningMode:'off',maxParallel:1},nodes:[{id:'input',name:'Input',type:'input',x:0,y:0},{id:'agent',name:'Agent',type:'agent',prompt:'Perform the authorized guest task.',x:1,y:0},{id:'output',name:'Output',type:'output',x:2,y:0}],edges:[{id:'in',source:'input',target:'agent'},{id:'out',source:'agent',target:'output'}]});
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-engine-vm-'));class Runtime extends EventEmitter{calls=[];status(){return {connected:true,authenticated:true,defaultModel:'fixture-model',isolatedHistory:true};}async runAgent(value){this.calls.push(value);return {output:'No external actions in unit fixture.',threadId:'fixture-thread'};}}
  const runtime=new Runtime(),engine=new HarnessEngine({runtime,dataDir:path.join(root,'data'),defaultCwd:root,workbench:{},desktop:{status:()=>({enabled:false})}});await engine.init();t.after(async()=>{await engine.close();await fs.rm(root,{recursive:true,force:true});});return {runtime,engine};
}
async function finish(engine,run){await engine.executions.get(run.id);return engine.getRun(run.id);}

test('trusted VM selection admits fixed grant only for boolean true and binds idempotency',async t=>{
  const {engine,runtime}=await fixture(t),request={workflow:graph(),input:'Install Firefox in the VM.',requestId:'vm-authorized',workbench:true};
  const first=engine.startRun(request);assert.deepEqual(first.workbenchAuthorization,{scope:'configured-vm',control:'agent',source:'explicit-user-task'});await finish(engine,first);
  const tool=runtime.calls[0].dynamicTools.find(t=>t.name==='relay_workbench');assert.ok(tool);assert.ok(tool.inputSchema.properties.action.enum.includes('claim_agent_control'));assert.match(runtime.calls[0].prompt,/guest browser installation, launch and configuration through that tool are allowed/);
  engine.runs.get(first.id).workbenchAuthorization.consumed=true;
  assert.equal(engine.startRun(request).id,first.id);assert.equal(engine.getRun(first.id).workbenchAuthorization.consumed,true);
  assert.throws(()=>engine.startRun({...request,workbench:false}),{code:'RUN_REQUEST_CONFLICT'});
  assert.throws(()=>engine.startRun({...request,requestId:'invalid',workbench:'true'}),{code:'WORKBENCH_AUTHORIZATION_INVALID'});
  const normal=await finish(engine,engine.startRun({workflow:graph(),input:'General task',workbench:false}));assert.equal(normal.workbenchAuthorization,undefined);assert.equal(runtime.calls.at(-1).dynamicTools.find(t=>t.name==='relay_workbench').inputSchema.properties.action.enum.includes('claim_agent_control'),false);
});

test('continuations preserve only unconsumed authorization; explicit new grant remains idempotent',async t=>{
  const {engine}=await fixture(t);let first=await finish(engine,engine.startRun({workflow:graph(),input:'VM task',workbench:true}));
  const next=await finish(engine,engine.continueRun(first.id,{nodeId:'agent',message:'Continue preparation'}));assert.equal(next.workbenchAuthorization.source,'explicit-user-task');
  engine.runs.get(next.id).workbenchAuthorization.consumed=true;
  const noRenewal=await finish(engine,engine.continueRun(next.id,{nodeId:'agent',message:'Inspect existing results'}));assert.equal(noRenewal.workbenchAuthorization,undefined);
  const request={nodeId:'agent',message:'Explicitly perform this guest task',requestId:'new-vm-turn',workbench:true},renewed=await finish(engine,engine.continueRun(noRenewal.id,request));assert.equal(renewed.workbenchAuthorization.consumed,undefined);
  engine.runs.get(renewed.id).workbenchAuthorization.consumed=true;assert.equal(engine.continueRun(noRenewal.id,request).id,renewed.id);assert.equal(engine.getRun(renewed.id).workbenchAuthorization.consumed,true);assert.throws(()=>engine.continueRun(noRenewal.id,{...request,workbench:false}),{code:'RUN_REQUEST_CONFLICT'});
});

test('readiness continuation carries explicit VM grant and hashes it',async t=>{
  const {engine}=await fixture(t),first=await finish(engine,engine.startRun({workflow:graph(),input:'VM task'}));
  engine.runs.get(first.id).viability={awaitingInput:true,requestId:'viability-test',baseInput:first.input};
  const request={nodeId:'agent',message:'Perform in the configured VM',requestId:'readiness-vm',workbench:true},next=engine.resumeViabilityRun(first.id,request);assert.equal(next.workbenchAuthorization.source,'explicit-user-task');await finish(engine,next);assert.equal(engine.resumeViabilityRun(first.id,request).id,next.id);assert.throws(()=>engine.resumeViabilityRun(first.id,{...request,workbench:false}),{code:'RUN_REQUEST_CONFLICT'});
});
