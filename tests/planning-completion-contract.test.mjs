import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {TaskStateStore} from '../lib/task-state.mjs';
const step={id:'inspect',kind:'action',status:'active',title:'Inspect result',operation:{kind:'reasoning',target:'Supplied observation'},result:'Checked result',note:'Compare observation with requested outcome',doneWhen:'Result and limits recorded'};
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'blackice-completion-store-')),store=await new TaskStateStore({dataDir:root}).init();t.after(async()=>{await store.close();assert.equal(path.dirname(root),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});});const state=await store.ensure({taskId:'completion',runId:'run',cwd:root,goal:'Check result'});return{store,state,options:revision=>({expectedRevision:revision,runId:'run',nodeId:'agent',schemaVersion:13,executionGuardrails:true,planningMode:'on'})};}
test('stored completion rejects stale revision and out-of-scope ownership without changing bytes, then preserves planned output',async t=>{
 const {store,state,options}=await fixture(t);const saved=await store.setPlan(state.taskId,{steps:[step,{...step,id:'other',status:'pending'}]},options(state.revision)),before=await readFile(store.file(state.taskId)),completion={status:'done',evidence:'Observed exact expected result'};
 await assert.rejects(store.setStep(state.taskId,step.id,completion,options(saved.revision-1)),{code:'TASK_STATE_CONFLICT'});
 await assert.rejects(store.setStep(state.taskId,step.id,completion,{...options(saved.revision),scopeStepId:'other'}),{code:'TASK_PLAN_OWNERSHIP'});assert.deepEqual(await readFile(store.file(state.taskId)),before);
 const done=await store.setStep(state.taskId,step.id,completion,options(saved.revision));assert.equal(done.revision,saved.revision+1);assert.equal(done.steps[0].evidence,completion.evidence);for(const key of ['result','note','doneWhen'])assert.equal(done.steps[0][key],step[key]);
});
test('stored completion evidence bounds preserve exact error details and permit repair without repeated work',async t=>{
 const {store,state,options}=await fixture(t),saved=await store.setPlan(state.taskId,{steps:[step]},options(state.revision)),bytes=await readFile(store.file(state.taskId));
 for(const evidence of ['x'.repeat(2001),'x'.repeat(2056),'é'.repeat(2002)]){
 assert.throws(()=>store.setStep(state.taskId,step.id,{status:'done',evidence},options(saved.revision)),e=>e.code==='TASK_PLAN_EVIDENCE_TOO_LONG'&&e.actualLength===evidence.length&&e.maxLength===2000&&/Do not repeat work/.test(e.message));assert.deepEqual(await readFile(store.file(state.taskId)),bytes);
 }
 const done=await store.setStep(state.taskId,step.id,{status:'done',evidence:'x'.repeat(2000)},options(saved.revision));assert.equal(done.steps[0].evidence.length,2000);assert.equal(done.revision,saved.revision+1);
});
test('stored plan and edit evidence rejection is atomic and recoverable',async t=>{
 const {store,state,options}=await fixture(t),before=await readFile(store.file(state.taskId));
 await assert.rejects(store.setPlan(state.taskId,{steps:[{...step,evidence:'x'.repeat(2056)}]},options(state.revision)),e=>e.code==='TASK_PLAN_EVIDENCE_TOO_LONG'&&e.actualLength===2056&&e.maxLength===2000);assert.deepEqual(await readFile(store.file(state.taskId)),before);
 const saved=await store.setPlan(state.taskId,{steps:[step]},options(state.revision)),bytes=await readFile(store.file(state.taskId));
 await assert.rejects(store.editPlan(state.taskId,{operations:[{type:'update',stepId:step.id,patch:{evidence:'x'.repeat(2056)}}]},options(saved.revision)),e=>e.code==='TASK_PLAN_EVIDENCE_TOO_LONG'&&e.actualLength===2056&&e.maxLength===2000);assert.deepEqual(await readFile(store.file(state.taskId)),bytes);
 const next=await store.editPlan(state.taskId,{operations:[{type:'update',stepId:step.id,patch:{evidence:'Checked result and limits'}}]},options(saved.revision));assert.equal(next.revision,saved.revision+1);
});
