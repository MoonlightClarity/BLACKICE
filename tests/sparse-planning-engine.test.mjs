import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {TaskStateStore} from '../lib/task-state.mjs';
import {normalizePlanningOntology,PLANNING_ONTOLOGY_MODULES} from '../public/planning-module-policy.mjs';
import {fixtureOutcomeReview,finishFixtureCandidate} from './fixture-modular-provider.mjs';
const graph={id:'defaults-engine',name:'Defaults engine',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'fixture',prompt:'Perform the authorized local write.'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1}};
async function fixture(t,execute){
 const root=await mkdtemp(path.join(tmpdir(),'blackice-defaults-engine-')),cwd=path.join(root,'work');await mkdir(cwd);
 const tasks=await new TaskStateStore({dataDir:root}).init();
 class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',supportsTools:true}]};}async runAgent(options){const review=fixtureOutcomeReview(options);if(review)return review;options.onEvent({type:'thread',threadId:options.threadId||'defaults-thread',model:'fixture'});return execute(options);}}
 const runtime=new Runtime(),settings={};let engine=await new HarnessEngine({runtime,tasks,dataDir:root,defaultCwd:cwd}).init();engine.runtimeSettings={get:()=>settings};
 const f={root,cwd,tasks,settings,get engine(){return engine;},async settle(run){await engine.executions.get(run.id);return engine.getRun(run.id);},async reopen(){await engine.close();engine=await new HarnessEngine({runtime,tasks,dataDir:root,defaultCwd:cwd}).init();engine.runtimeSettings={get:()=>settings};}};
 t.after(async()=>{await engine.close();await tasks.close();assert.match(path.basename(root),/^blackice-defaults-engine-/);await rm(root,{recursive:true,force:true});});return f;
}
test('actual default-Off engine writes and completes without a hidden reviewer or task ritual',async t=>{
 let calls=0,effects=0;
 const f=await fixture(t,async options=>{calls++;assert.equal(options.onBeforeFinal,undefined);assert.ok(!options.dynamicTools.some(tool=>tool.name==='relay_task'));assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_workspace'));
 const call={name:'relay_workspace',callId:'same-write',arguments:{action:'write',path:'result.txt',text:'verified local output'}};
 const first=await options.onToolCall(call);assert.equal(first.success,true,JSON.stringify(first));effects++;assert.deepEqual(await options.onToolCall(structuredClone(call)),first);
 return{output:'Wrote result.txt.',threadId:'defaults-thread'};});
 const run=await f.settle(f.engine.startRun({workflow:graph,input:'Write the local result.'}));
 assert.equal(run.status,'completed',run.error);assert.equal(calls,1);assert.equal(effects,1);assert.equal(await readFile(path.join(f.cwd,'result.txt'),'utf8'),'verified local output');
 assert.ok(PLANNING_ONTOLOGY_MODULES.filter(m=>m.id!=='subagents').every(m=>run.planningOntology.modules[m.id]===false));
 assert.equal(run.executionModes.directoryMode,'off');
});
test('explicit full saved module choices survive failure, restart, Retry and Continue despite new default-Off',async t=>{
 const selected=normalizePlanningOntology({version:2,modules:Object.fromEntries(PLANNING_ONTOLOGY_MODULES.map(m=>[m.id,true]))});let calls=0;
 const f=await fixture(t,async options=>{calls++;assert.equal(typeof options.onBeforeFinal,'function');assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_task'));if(calls===1)throw Object.assign(Error('Observed fixture failure before effects'),{code:'FIXTURE_FAILURE'});return finishFixtureCandidate(options,{output:'Confirmed bounded synthetic task complete.',threadId:'defaults-thread'});});
 const failed=await f.settle(f.engine.startRun({workflow:graph,input:'Complete bounded synthetic task.',planningOntology:selected}));assert.equal(failed.status,'failed');assert.equal(failed.errorCode,'FIXTURE_FAILURE');const frozen=JSON.stringify(failed.planningOntology);
 await f.reopen();const retried=await f.settle(f.engine.retryRun(failed.id));assert.equal(retried.status,'completed',retried.error);assert.deepEqual(retried.planningOntology,selected);
 const continued=await f.settle(f.engine.continueRun(retried.id,{nodeId:'agent',message:'Repeat the bounded check.'}));assert.equal(continued.status,'completed',continued.error);assert.deepEqual(continued.planningOntology,selected);assert.equal(JSON.stringify(f.engine.getRun(failed.id).planningOntology),frozen);assert.equal(f.engine.getRun(failed.id).status,'failed');
});
