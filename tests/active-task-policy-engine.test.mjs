import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {activeTaskPolicy} from '../lib/active-task-policy.mjs';
import {normalizePlanningOntology,PLANNING_ONTOLOGY_MODULES} from '../public/planning-module-policy.mjs';
import {fixtureOutcomeReview,finishFixtureCandidate} from './fixture-modular-provider.mjs';
const policy=decomposition=>normalizePlanningOntology({version:2,modules:Object.fromEntries(PLANNING_ONTOLOGY_MODULES.map(({id})=>[id,['time_management','anti_overalignment'].includes(id)||id==='decomposition'&&decomposition]))});
const graph={id:'policy-fixture',name:'Policy fixture',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',name:'Agent',prompt:'Inspect the admitted policy.',model:'fixture-model'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1}};
const decode=result=>{assert.equal(result.success,true,result.contentItems?.[0]?.text);return JSON.parse(result.contentItems.find(x=>x.type==='inputText').text);};
const invoke=(options,name,args)=>options.onToolCall({name,arguments:args});
const settled=async(engine,id)=>{const until=Date.now()+8000;while(Date.now()<until){const run=engine.getRun(id);if(run.settled){assert.equal(run.status,'completed',run.error||run.nodes.agent.error);return run;}await new Promise(r=>setTimeout(r,10));}assert.fail('Fixture did not settle');};
async function fixture(t,execute){
 const directory=await mkdtemp(path.join(tmpdir(),'blackice-policy-tool-'));
 const settings={subagentsEnabled:true,maxSubagents:2,planningOntology:policy(false)};
 class Runtime extends EventEmitter {
  constructor(){super();this.calls=[];}
  status(){return {connected:true,authenticated:true,defaultModel:'fixture-model',models:[{id:'fixture-model',model:'fixture-model',supportsTools:true}]};}
  async runAgent(options){const review=fixtureOutcomeReview(options);if(review)return review;this.calls.push(options);options.onEvent?.({type:'thread',threadId:options.threadId||'policy-native-thread',model:'fixture-model'});return finishFixtureCandidate(options,await execute(options,this.calls.length));}
 }
 const runtime=new Runtime(),engine=await new HarnessEngine({runtime,dataDir:directory,defaultCwd:directory}).init();
 engine.runtimeSettings={get:()=>structuredClone(settings)};
 t.after(async()=>{await engine.close();await rm(directory,{recursive:true,force:true});});
 return {engine,runtime,settings,directory};
}
for(const mode of ['ontology','off'])for(const decomposition of [true,false])test(mode+' omits retired policy on actual tool reads with decomposition='+decomposition,async t=>{
 let reads=0;
 const f=await fixture(t,async options=>{
  assert.doesNotMatch(options.developerInstructions+options.prompt,/BLACKICE PLANNING MODULES|IMMEDIATE EFFORT CALIBRATION|MINIMUM-SCOPE BLOCKING/);
  assert.ok(!options.dynamicTools.some(x=>['relay_task','relay_planning_read','relay_planning_write','relay_planning_module'].includes(x.name)));
  for(const [name,args]of [['relay_control',{action:'catalog'}],['relay_control',{action:'describe'}],['relay_workspace',{action:'list'}]]){
   const result=decode(await invoke(options,name,args));reads++;
   assert.equal(Object.hasOwn(result,'activeTaskPolicy'),false);
  }
  const compact=decode(await invoke(options,'relay_workspace',{action:'list',path:'.'}));
  assert.equal(Object.hasOwn(compact,'activeTaskPolicy'),false);
  return {output:'Read the admitted policy.',threadId:'policy-native-thread'};
 });
 const run=f.engine.startRun({workflow:graph,input:'Read current task policy.',planningMode:mode,planningOntology:policy(decomposition)});
 await settled(f.engine,run.id);assert.equal(reads,3);
});
test('delegated worker tools omit retired policy without losing workspace capability',async t=>{
 let parentPolicy;const childPolicies=[];
 const f=await fixture(t,async(options,n)=>{
  if(n===1){
   parentPolicy=decode(await invoke(options,'relay_control',{action:'catalog'})).activeTaskPolicy;
   const response=decode(await invoke(options,'relay_delegate',{tasks:[{id:'child',prompt:'Read the admitted task policy using workspace list.'},{id:'other',prompt:'Independently read the admitted task policy using workspace list.'}]}));
   assert.equal(response.completed,2);return {output:'Integrated the child result.',threadId:'policy-native-thread'};
  }
  assert.ok(!options.dynamicTools.some(x=>x.name==='relay_control'));assert.ok(!options.dynamicTools.some(x=>x.name==='relay_task'));
  childPolicies.push(decode(await invoke(options,'relay_workspace',{action:'list'})).activeTaskPolicy);
  return {output:'Read inherited admitted policy.',threadId:'policy-worker-thread'};
 });
 const run=f.engine.startRun({workflow:graph,input:'Delegate one bounded policy read.',planningMode:'ontology',planningOntology:policy(false)});
 await settled(f.engine,run.id);assert.equal(childPolicies.length,2);assert.equal(parentPolicy,undefined);for(const childPolicy of childPolicies)assert.equal(childPolicy,undefined);
});
test('native continuation keeps catalog fixed without injecting changed module defaults',async t=>{
 const catalogs=[],policies=[];
 const f=await fixture(t,async options=>{
  catalogs.push(structuredClone(options.dynamicTools));
  policies.push(decode(await invoke(options,'relay_control',{action:'catalog'})).activeTaskPolicy);
  return {output:'Read policy.',threadId:'policy-native-thread'};
 });
 f.settings.subagentsEnabled=false;
 const first=f.engine.startRun({workflow:graph,input:'Inspect policy.',planningMode:'ontology',planningOntology:policy(false)});
 await settled(f.engine,first.id);
 f.settings.planningOntology=policy(true);
 const next=f.engine.continueRun(first.id,{nodeId:'agent',message:'Inspect the same admitted policy.'});
 await settled(f.engine,next.id);
 assert.deepEqual(catalogs[1],catalogs[0]);
 assert.deepEqual(policies,[undefined,undefined]);
});
test('absent admitted policy never enables mutable defaults and returned objects cannot mutate run',()=>{
 const run={id:'saved',planningMode:'off'};assert.deepEqual(activeTaskPolicy(run).enabledModules,[]);
 const admitted={id:'present',planningMode:'off',planningOntology:policy(false)};
 const result=activeTaskPolicy(admitted);result.planningOntology.modules.time_management=false;
 assert.equal(admitted.planningOntology.modules.time_management,true);
});
