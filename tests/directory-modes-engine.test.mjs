import {directoryUserHistoryFor} from '../lib/shadowdancer-engine.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {HarnessEngine} from '../lib/engine.mjs';

import {normalizePlanningOntology} from '../public/planning-module-policy.mjs';
import {fixtureOutcomeReview,finishFixtureCandidate} from './fixture-modular-provider.mjs';
const graph=(sandbox='danger-full-access')=>({name:'Directory Chat fixture',nodes:[
 {id:'input',type:'input'},{id:'agent',type:'agent',model:'fixture::remote',name:'Chat',prompt:'CURRENT_AGENT_BOUNDARY: preserve source files and task restrictions.',sandbox},
 {id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1,planningMode:'off'}});
const phaseOf=options=>{if(!options.prompt.includes('SHADOWDANCER DIRECTORY MODE.'))return null;const tail=options.prompt.split('CURRENT_DIRECTORY:\n').at(-1);return JSON.parse(tail.split('\nREPOSITORY ')[0]);};
const response=phase=>phase.label==='decompose'?{atomic:true}:phase.label==='integration'?{answer:'Directory evidence result.',used_refs:phase.payload.required_refs}:{status:'complete',nextAction:'',finding:'A bounded finding.',candidate_answer:'A bounded answer.',uncertainty:''};
class Runtime extends EventEmitter{
 calls=[];children=[];store={get:()=>({baseUrl:'https://api.example/v1'})};
 status(){return{connected:true,authenticated:true,defaultModel:'fixture::remote',models:[{id:'fixture::remote',supportsTools:true}]};}
 async steerAgent(){return{accepted:true};}
 async runAgent(options){
  this.calls.push(options);
  if(options.prompt.startsWith('You are a short-lived BLACKICE subagent.')){this.children.push(options);return{output:'Child evidence.'};}
  const phase=phaseOf(options);await this.inspect?.(options,phase);
  options.onEvent?.({type:'thread',threadId:'ephemeral-'+this.calls.length,turnId:'turn-'+this.calls.length,model:'fixture::remote'});
  options.onEvent?.({type:'message',text:phase?'PRIVATE_LEAF_JSON':'Ordinary Chat result.',phase:'final_answer'});
  return{output:phase?JSON.stringify(response(phase)):'Ordinary Chat result.',threadId:'ephemeral-'+this.calls.length};
 }
}
async function fixture(t,{runtime=new Runtime(),tasks}={}){
 const root=await mkdtemp(path.join(tmpdir(),'blackice-directory-modes-')),cwd=path.join(root,'workspace'),dataDir=path.join(root,'data');await mkdir(cwd);
 const settings={subagentsEnabled:true,maxSubagents:3,executionGuardrails:false};
 const engine=await new HarnessEngine({runtime,dataDir,defaultCwd:cwd,tasks}).init();engine.runtimeSettings={get:()=>({...settings})};
 const engines=[engine];t.after(async()=>{for(const e of engines)await e.close();await rm(root,{recursive:true,force:true});});
 return{root,cwd,dataDir,engine,runtime,settings,engines};
}
async function settle(engine,run){await engine.executions.get(run.id);const out=engine.getRun(run.id);assert.equal(out.status,'completed',out.error||out.nodes.agent.error);return out;}

for(const directoryMode of ['off'])for(const subagentsMode of ['default','on','off'])test('default delegation with Directory '+directoryMode+' and retired mode '+subagentsMode,async t=>{
 const f=await fixture(t),receipts=[];let attempted=false;
 f.runtime.inspect=async(options,phase)=>{
  const active=!phase||phase.label==='work';if(!active)return;
  const tool=options.dynamicTools.find(x=>x.name==='relay_delegate');
  assert.equal(Boolean(tool),true);
  if(!attempted){
   attempted=true;const result=await options.onToolCall({name:'relay_delegate',callId:'same-batch',arguments:{tasks:[{id:'left',prompt:'Inspect independent left synthetic data without modifying files.'},{id:'right',prompt:'Inspect independent right synthetic data without modifying files.'}]}});
   receipts.push(result);assert.equal(result.success,true,JSON.stringify(result));
  }
 };
 const run=await settle(f.engine,f.engine.startRun({workflow:graph(),input:{task:'Review independent synthetic findings.',directoryMode,subagentsMode}}));
 assert.equal(run.executionModes.subagentsMode,'default');
 assert.equal(f.runtime.children.length,2);
 assert.equal(receipts.length,1);assert.ok(run.events.some(x=>x.data?.type==='subagent.admission'&&x.data?.mode==='static_dag'&&x.data.allowed));
 assert.equal(f.settings.subagentsEnabled,true,'retired per-chat preferences never change global capability');
});
for(const directoryMode of ['off'])test('default delegation preserves disabled runtime capability with Directory '+directoryMode,async t=>{
 const f=await fixture(t);f.settings.subagentsEnabled=false;
 f.runtime.inspect=async(options,phase)=>{
  if(!phase||phase.label==='work')assert.ok(!options.dynamicTools.some(x=>x.name==='relay_delegate'));
 };
 const run=await settle(f.engine,f.engine.startRun({workflow:graph(),input:{task:'Inspect without child workers.',directoryMode,subagentsMode:'on'}}));
 assert.equal(run.executionModes.subagentsMode,'default');assert.equal(f.runtime.children.length,0);
});

test('retired On normalizes to Default without forcing a needless execution context change',async t=>{
 const f=await fixture(t);
 const first=await settle(f.engine,f.engine.startRun({workflow:graph(),input:{task:'Inspect synthetic context.',directoryMode:'off',subagentsMode:'default'}}));
 const previous=JSON.stringify(first.nodes.agent.providerExecutionContract);
 const next=await settle(f.engine,f.engine.continueRun(first.id,{nodeId:'agent',message:'Keep working.',subagentsMode:'on'}));
 assert.equal(next.executionModes.subagentsMode,'default');assert.notEqual(next.modelHandoff?.reason,'execution-mode-change');
 assert.equal(JSON.stringify(f.engine.getRun(first.id).nodes.agent.providerExecutionContract),previous);
});
test('continuing a historical disabled run refreshes tools using defaults without rewriting history',async t=>{
 const f=await fixture(t);f.settings.subagentsEnabled=false;
 const first=await settle(f.engine,f.engine.startRun({workflow:graph(),input:{task:'Inspect historical capability.',directoryMode:'off',subagentsMode:'off'}}));
 const historical=f.engine.runs.get(first.id);historical.executionModes.subagentsMode='off';
 const frozen=JSON.stringify(historical);f.settings.subagentsEnabled=true;
 const next=await settle(f.engine,f.engine.continueRun(first.id,{nodeId:'agent',message:'Continue with the default capabilities.'}));
 assert.equal(next.executionModes.subagentsMode,'default');
 assert.equal(next.modelHandoff.reason,'execution-mode-change');
 assert.ok(f.runtime.calls.at(-1).dynamicTools.some(tool=>tool.name==='relay_delegate'));
 assert.equal(JSON.stringify(f.engine.runs.get(first.id)),frozen);
});

for(const [operation,cause] of [['continue','policy'],['continue','legacy-policy'],['retry','policy'],['retry','mode'],['retry','runtime'],['retry','runtime-missing-catalog']])test('native '+operation+' refreshes retired '+cause+' delegation choices without losing history',async t=>{
 const runtime=new Runtime();
 runtime.status=()=>({connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',supportsTools:true}]});
 runtime.runAgent=async options=>{
  const review=fixtureOutcomeReview(options);if(review)return review;
  runtime.calls.push(options);const threadId='native-default-'+runtime.calls.length;
  options.onEvent?.({type:'thread',threadId,turnId:'turn-'+runtime.calls.length,model:'fixture'});
  if(operation==='retry'&&runtime.calls.length===1)throw Error('Synthetic interruption with a saved native catalog.');
  return finishFixtureCandidate(options,{output:'Inspected the native fixture.',threadId});
 };
 const f=await fixture(t,{runtime}),workflow=graph();workflow.nodes.find(node=>node.type==='agent').model='fixture';
 f.settings.subagentsEnabled=false;
 const first=f.engine.startRun({workflow,input:{task:'EXACT_NATIVE_BOUNDARY: inspect without external sends.',directoryMode:'off',subagentsMode:'default'}});
 await f.engine.executions.get(first.id);
 const historical=f.engine.runs.get(first.id),state=historical.nodes.agent;
 assert.equal(historical.status,operation==='retry'?'failed':'completed');
 assert.ok(Array.isArray(state.toolNames)&&!state.toolNames.includes('relay_delegate'));
 if(cause.includes('policy')){
  historical.runtimeSettings.subagentsEnabled=true;
  historical.planningOntology=normalizePlanningOntology({version:2,modules:{verification:false}});
  historical.planningOntology.modules.subagents=cause==='legacy-policy'?'forbidden':false;
  if(cause==='legacy-policy')historical.planningOntology.version=1;
 }else if(cause==='mode'){
  historical.executionModes.subagentsMode='off';delete historical.runtimeSettings.subagentsEnabled;
 }else if(cause==='runtime-missing-catalog'){
  delete state.toolNames;delete state.resumeToolNames;
 }
 const frozen=JSON.stringify(historical),sourceThreadId=state.threadId;f.settings.subagentsEnabled=true;
 const admitted=operation==='continue'?f.engine.continueRun(first.id,{nodeId:'agent',message:'Continue inspecting this same task.'}):f.engine.retryRun(first.id);
 const next=await settle(f.engine,admitted),handoff=operation==='continue'?next.modelHandoff:next.nodeHandoffs.agent;
 assert.equal(next.taskId,historical.taskId);assert.equal(next.parentRunId,first.id);
 assert.equal(next.executionModes.subagentsMode,'default');
 assert.equal(handoff.reason,'execution-mode-change');assert.equal(handoff.sourceThreadId,sourceThreadId);
 assert.equal(runtime.calls.at(-1).threadId,undefined);
 assert.ok(runtime.calls.at(-1).dynamicTools.some(tool=>tool.name==='relay_delegate'));
 assert.match(runtime.calls.at(-1).prompt,/EXACT_NATIVE_BOUNDARY/);
 assert.equal(JSON.stringify(f.engine.runs.get(first.id)),frozen,'saved run, user restrictions, and prior tool evidence remain exact');
});

test('Directory authority rehydrates a middle restriction omitted from ordinary excerpts and fails closed on missing lineage',()=>{
 const family=Array.from({length:20},(_,i)=>({id:'r'+i,taskId:'r0',...(i?{parentRunId:'r'+(i-1)}:{}),createdAt:new Date(i*1000).toISOString(),input:i===7?'MIDDLE_RESTRICTION: do not submit anything.':'Request '+i,events:[]}));
 const rows=directoryUserHistoryFor(family.at(-1),family);
 assert.equal(rows.length,20);assert.ok(rows.some(row=>row.text.includes('MIDDLE_RESTRICTION')));
 assert.throws(()=>directoryUserHistoryFor(family.at(-1),[family.at(-1)]),{code:'DIRECTORY_HISTORY_UNAVAILABLE'});
 const truncated={id:'tail',createdAt:new Date().toISOString(),input:'Continue',priorUserRequests:[{key:'missing',runId:'missing',source:'user-request',text:'excerpt',truncated:true}]};
 assert.throws(()=>directoryUserHistoryFor(truncated),{code:'DIRECTORY_HISTORY_UNAVAILABLE'});
});


test('Directory authority cannot follow a foreign-family parent or accept a detached descendant as a root',()=>{
 const foreign={id:'foreign',taskId:'foreign',input:'FOREIGN_PRIVATE_RESTRICTION',events:[]};
 const current={id:'current',taskId:'own-family',parentRunId:'foreign',input:'Own request',events:[]};
 assert.throws(()=>directoryUserHistoryFor(current,[foreign]),{code:'DIRECTORY_HISTORY_UNAVAILABLE'});
 assert.throws(()=>directoryUserHistoryFor({...current,parentRunId:undefined},[]),{code:'DIRECTORY_HISTORY_UNAVAILABLE'});
});
