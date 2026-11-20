import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {HarnessEngine} from '../lib/engine.mjs';
import {TaskActionDirectory} from '../lib/task-action-directory.mjs';
const graph={name:'Bound Directory',nodes:[{id:'i',type:'input'},{id:'a',type:'agent',name:'Agent',model:'fixture-model',prompt:'Do task'},{id:'o',type:'output'}],edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{maxParallel:1,planningMode:'off'}};
class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,models:[{id:'fixture-model',supportsTools:true}]};}async runAgent(o){return this.execute(o);}}
for(const logging of ['off','on'])test('Planning→four parallel reads→focus→observed final without revision echo, logging '+logging,async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'directory-bound-revision-')),runtime=new Runtime();const engine=await new HarnessEngine({runtime,dataDir:root,defaultCwd:root}).init();t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});let prep=0;
 runtime.execute=async o=>{
  if(o.prompt.includes('CURRENT DIRECTORY PROJECTION (data):')){prep++;return{output:JSON.stringify({status:'proposed',focus:'inspect',reason:'Inspect evidence first',sourceRefs:[],actions:[{id:'inspect',objective:'Inspect local evidence',dependsOn:[]}]})};}
  const control=async args=>{const result=await o.onToolCall({name:'relay_directory_action',callId:'control-'+Math.random().toString(36).slice(2),arguments:args});assert.equal(result.success,true,JSON.stringify(result));return JSON.parse(result.contentItems[0].text);};
  let state=await control({action:'read'});assert.equal(state.revision,1);assert.equal(state.actionRevision,1);
  const reads=await Promise.all(Array.from({length:4},(_,i)=>o.onToolCall({name:'relay_workspace',callId:'read-'+i,arguments:{action:'list',path:root}})));assert(reads.every(r=>r.success));
  state=await control({action:'read'});assert.equal(state.revision,9);assert.equal(state.actionRevision,1);
  state=await control({action:'focus',id:'inspect',revision:'9'});assert.equal(state.focus,'inspect');
  await Promise.all(Array.from({length:2},(_,i)=>o.onToolCall({name:'relay_workspace',callId:'focused-read-'+i,arguments:{action:'list',path:root}})));
  state=await control({action:'read'});const refs=state.receipts.filter(r=>r.actionId==='inspect'&&r.state==='returned').map(r=>r.id);assert.equal(refs.length,2);
  state=await control({action:'observe',outcome:'objective-met',id:'inspect',claim:'The fixture evidence was read',receipts:refs,revision:0});assert.equal(state.actions[0].state,'observed');assert(!await o.onBeforeFinal({signal:o.signal}));return{output:'Fixture evidence inspected.'};
 };
 const started=engine.startRun({workflow:graph,input:{task:'Inspect fixture evidence',directoryActions:'on',chatPlanning:'on',directoryDiagnostics:logging}});await engine.executions.get(started.id);const run=engine.getRun(started.id);assert.equal(prep,1);assert.equal(run.status,'completed',run.error);assert.equal((await engine.actionDirectories.get(started.id,'fixture')).read().actions[0].state,'observed');
});
test('observation churn changes total revision only; native explicit CAS remains strict',async()=>{const ledger=new TaskActionDirectory({taskId:'task',objective:'Fixture'});await ledger.edit({action:'plan',revision:0,actions:[{id:'a',objective:'A',dependsOn:[]}]});const initial=ledger.read();await Promise.all([1,2].map(i=>ledger.execute({name:'relay_workspace'},async()=>({success:true}),{runId:'run',nodeId:'a',observationOnly:true,expectedActionRevision:initial.actionRevision})));assert.equal(ledger.read().revision,5);assert.equal(ledger.read().actionRevision,1);await assert.rejects(ledger.edit({action:'focus',revision:1,id:'a'},{authority:'human'}),{code:'DIRECTORY_CHANGED'});await ledger.edit({action:'focus',revision:5,id:'a'},{authority:'human'});await assert.rejects(ledger.edit({action:'block',id:'a',claim:'stale host binding'},{expectedActionRevision:1}),{code:'DIRECTORY_CHANGED'});});
test('saved pre-token ledger preserves receipts and resumes with a stable host token',async()=>{const old=new TaskActionDirectory({taskId:'task',objective:'Existing task'});await old.edit({action:'plan',revision:0,actions:[{id:'a',objective:'A',dependsOn:[]}]});for(let i=0;i<4;i++)await old.execute({name:'relay_workspace'},async()=>({success:true}),{runId:'run',nodeId:'a',observationOnly:true});const saved=structuredClone(old.state);delete saved.actionRevision;const original=JSON.stringify(saved);const resumed=new TaskActionDirectory({taskId:'task',objective:'Existing task',snapshot:saved});assert.equal(resumed.read().actionRevision,9);assert.equal(JSON.stringify(saved),original);await resumed.execute({name:'relay_workspace'},async()=>({success:true}),{runId:'next',nodeId:'a',observationOnly:true,expectedActionRevision:9});await resumed.handle({action:'focus',id:'a'},{expectedActionRevision:9});assert.equal(resumed.read().focus,'a');assert.equal(resumed.read().receipts.length,5);assert.deepEqual(resumed.read().receipts.slice(0,4),saved.receipts);});
