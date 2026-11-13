import {directoryUserHistoryFor} from '../lib/shadowdancer-engine.mjs';
import {TaskStateStore} from '../lib/task-state.mjs';
import {createWorkspaceToolHandler} from '../lib/workspace-tools.mjs';
import {DirectTaskRuntime} from '../lib/direct-task-runtime.mjs';
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
test('GPT-6 Luna runs all Directory phases through protected native transport rather than ordinary Chat',async t=>{
 const f=await fixture(t),native=graph();
 native.nodes.find(n=>n.id==='agent').model='gpt-6-luna';
 const run=await settle(f.engine,f.engine.startRun({workflow:native,input:{
  task:'Evaluate a synthetic claim and verify the response.',directoryMode:'on',subagentsMode:'off'}}));
 assert.equal(run.executionModes.directoryMode,'on');
 assert.ok(run.nodes.agent.shadowdancer,'Directory execution must not be disabled for Luna');
 assert.equal(run.nodes.agent.shadowdancer.model,'gpt-6-luna');
 assert.ok(f.runtime.calls.length>=3,'Recursive Directory may need additional protected passes');
 const phases=new Set(f.runtime.calls.map(options=>phaseOf(options)?.label));
 for(const required of ['decompose','work','integration'])assert.ok(phases.has(required),'Missing protected Directory phase '+required);
 assert.ok(f.runtime.calls.every(options=>phaseOf(options)&&options.hostOnlyTools===true
   &&options.model==='gpt-6-luna'&&!options.threadId&&!options.continuity));
 assert.equal(run.nodes.agent.directoryCompatibility,undefined,'No silent ordinary-Chat downgrade');
});

test('Chat modes change real execution on-off-on and survive restart without rewriting prior runs',async t=>{
 const f=await fixture(t),{engine,runtime}=f;
 const one=await settle(engine,engine.startRun({workflow:graph(),input:{task:'FIRST_USER_RESTRICTION: never send anything externally.',directoryMode:'on',subagentsMode:'off'}}));
 assert.equal(runtime.calls.length,3);assert.ok(runtime.calls.every(c=>phaseOf(c)&&c.hostOnlyTools===true&&!('threadId'in c)&&!('continuity'in c)));
 assert.ok(runtime.calls.every(c=>c.developerInstructions?.includes('BLACKICE')));assert.ok(runtime.calls.every(c=>c.prompt.includes('CURRENT_AGENT_BOUNDARY')));
 assert.ok(!one.events.some(e=>e.data?.text==='PRIVATE_LEAF_JSON'));assert.ok(one.nodes.agent.shadowdancer);assert.equal(one.nodes.agent.threadId,undefined);
 const frozen=JSON.stringify(engine.getRun(one.id));
 const two=await settle(engine,engine.continueRun(one.id,{nodeId:'agent',message:'Continue using ordinary Chat.',directoryMode:'off',subagentsMode:'on'}));
 assert.equal(phaseOf(runtime.calls.at(-1)),null);assert.match(runtime.calls.at(-1).prompt,/FIRST_USER_RESTRICTION/);assert.equal(two.modelHandoff.reason,'execution-mode-change');
 assert.equal(JSON.stringify(engine.getRun(one.id)),frozen);
 await engine.close();
 const reopened=await new HarnessEngine({runtime,dataDir:f.dataDir,defaultCwd:f.cwd}).init();reopened.runtimeSettings=engine.runtimeSettings;f.engines.push(reopened);
 assert.deepEqual(reopened.getRun(two.id).executionModes,{directoryMode:'off',subagentsMode:'default'});
 const three=await settle(reopened,reopened.continueRun(two.id,{nodeId:'agent',message:'Return to recursive context work.',directoryMode:'on'}));
 assert.equal(three.executionModes.subagentsMode,'default');assert.ok(runtime.calls.slice(-3).every(c=>phaseOf(c)&&c.prompt.includes('Continue using ordinary Chat.')));
 assert.equal(three.modelHandoff.reason,'execution-mode-change');
 const other=await settle(reopened,reopened.startRun({workflow:graph(),input:'Independent ordinary conversation.'}));
 assert.deepEqual(other.executionModes,{directoryMode:'off',subagentsMode:'default'});assert.equal(phaseOf(runtime.calls.at(-1)),null);
});
for(const directoryMode of ['on','off'])for(const subagentsMode of ['default','on','off'])test('default delegation with Directory '+directoryMode+' and retired mode '+subagentsMode,async t=>{
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
for(const directoryMode of ['on','off'])test('default delegation preserves disabled runtime capability with Directory '+directoryMode,async t=>{
 const f=await fixture(t);f.settings.subagentsEnabled=false;
 f.runtime.inspect=async(options,phase)=>{
  if(!phase||phase.label==='work')assert.ok(!options.dynamicTools.some(x=>x.name==='relay_delegate'));
 };
 const run=await settle(f.engine,f.engine.startRun({workflow:graph(),input:{task:'Inspect without child workers.',directoryMode,subagentsMode:'on'}}));
 assert.equal(run.executionModes.subagentsMode,'default');assert.equal(f.runtime.children.length,0);
});

test('Explicit command admission, conflicts and unsupported workflow reject before any provider work',async t=>{
 const f=await fixture(t);
 assert.throws(()=>f.engine.startRun({workflow:graph(),input:{task:'/directory Inspect.',directoryMode:'off'}}),{code:'DIRECTORY_DISABLED'});
 const multi=graph();multi.nodes.splice(2,0,{id:'other',type:'agent',prompt:'Other task'});multi.edges=[{source:'input',target:'agent'},{source:'input',target:'other'},{source:'agent',target:'output'},{source:'other',target:'output'}];
 assert.throws(()=>f.engine.startRun({workflow:multi,input:{task:'Inspect.',directoryMode:'on'}}),{code:'DIRECTORY_WORKFLOW_UNSUPPORTED'});
 assert.equal(f.runtime.calls.length,0);
 const run=await settle(f.engine,f.engine.startRun({workflow:graph(),input:'/directory Inspect the synthetic result.'}));
 assert.equal(run.executionModes.directoryMode,'on');assert.ok(run.nodes.agent.shadowdancer);
});
test('Directory read-only phases advertise no write or command and active directions persist into later fresh phases',async t=>{
 const f=await fixture(t),{engine,runtime}=f;let unblock,started;const wait=new Promise(r=>unblock=r),begin=new Promise(r=>started=r);
 runtime.inspect=async(options,phase)=>{if(phase?.label==='decompose'){started();await wait;}};
 const execute=engine.execute.bind(engine);engine.execute=(run,controller)=>{run.workflow.nodes.find(node=>node.id==='agent').sandbox='read-only';return execute(run,controller);};
 const original=engine.startRun({workflow:graph('read-only'),input:{task:'Inspect the bounded readonly task.',directoryMode:'on',subagentsMode:'off'}});
 await begin;const receipt=await engine.steerRun(original.id,{nodeId:'agent',message:'NEW_USER_RESTRICTION: keep all files unchanged.'});assert.equal(receipt.queued,true);
 assert.deepEqual(engine.getRun(original.id).executionModes,{directoryMode:'on',subagentsMode:'default'});unblock();
 const run=await settle(engine,original);assert.ok(runtime.calls.slice(1).every(c=>c.prompt.includes('NEW_USER_RESTRICTION')));
 for(const call of runtime.calls){assert.equal(call.sandbox,'read-only');const workspace=call.dynamicTools?.find(t=>t.name==='relay_workspace');if(workspace)assert.deepEqual(workspace.inputSchema.properties.action.enum,['list','read','patch_history','search']);}
 assert.equal(run.executionModes.directoryMode,'on');
});

test('Directory full-source extraction retains fresh-phase isolation and counts each session once',async t=>{
 const f=await fixture(t),seen=[];
 f.runtime.runAgent=async options=>{
  f.runtime.calls.push(options);const phase=phaseOf(options);seen.push(phase);
  options.onEvent?.({type:'usage',usage:{inputTokens:10,outputTokens:2,totalTokens:12}});
  options.onEvent?.({type:'usage',usage:{inputTokens:10,outputTokens:4,totalTokens:14}});
  let output;
  if(phase.label==='page-extract'){
   assert.ok(options.prompt.includes('ALPHA_ONLY')&&options.prompt.includes('BETA_ONLY'));
   output={summary:'Both codes',items:['ALPHA_ONLY','BETA_ONLY'].map(value=>({value,quote:value}))};
  }else output={answer:'ALPHA_ONLY BETA_ONLY',used_refs:phase.payload.required_refs};
  return{output:JSON.stringify(output),usage:{inputTokens:10,outputTokens:4,totalTokens:14},threadId:'leaf'};
 };
 const material='ALPHA_ONLY '+'.'.repeat(1139)+'BETA_ONLY';
 const run=await settle(f.engine,f.engine.startRun({workflow:graph(),input:{task:'List every code.\nSOURCE:\n'+material,directoryMode:'on',subagentsMode:'off'}}));
 assert.equal(seen.filter(x=>x.label==='page-extract').length,1);
 assert.equal(run.nodes.agent.usage.inputTokens,20);assert.equal(run.nodes.agent.usage.outputTokens,8);assert.equal(run.nodes.agent.usage.totalTokens,28);assert.equal(run.nodes.agent.usage.samples,2);assert.equal(run.nodes.agent.usage.modelContextWindow,null);
 assert.equal(run.nodes.agent.threadId,undefined);
});
for(const corrupt of [false,true])test('Directory prepared dispatcher preserves '+(corrupt?'corrupt':'two UNKNOWN')+' historical journals and permits safe reads',async t=>{
 const f=await fixture(t),store=await new TaskStateStore({dataDir:f.dataDir}).init();f.engine.tasks=store;
 t.after(()=>store.close());await writeFile(path.join(f.cwd,'kept.txt'),'unchanged');
 const raw=createWorkspaceToolHandler({cwd:f.cwd});
 const descriptor=await raw.describeOperation({name:'relay_workspace',arguments:{action:'run',command:'must-not-run'}});
 const journals=[];
 for(let i=0;i<2;i++){
  const taskId='historical-'+i,file=store.file(taskId)+'.sequence';
  const content=corrupt&&i===0?'{damaged':JSON.stringify({version:3,policy:'work-items-v2',taskId,journalSeq:2,records:[{operationId:'old-'+i,runId:'private-run',nodeId:'private-owner',workItemId:'old-item',journalSeq:1,...descriptor,tool:'relay_workspace',action:'run',deliveryState:'interrupted',effectState:'unknown',evidenceIds:[]}],evidence:[],focuses:[],judgments:[],findings:[],progress:[]});
  await writeFile(file,content);journals.push({file,content});
 }
 const outcomes=[];f.runtime.inspect=async(options,phase)=>{
  if(phase?.label!=='work')return;
  for(const action of ['write','run','read']){
   const result=await options.onToolCall({name:'relay_workspace',callId:'call-'+action,arguments:{action,...(action==='run'?{command:'must-not-run'}:{path:'kept.txt',...(action==='write'?{text:'verified-independent-write'}:{})})}});
   outcomes.push(result);if(action==='read'||action==='write'&&!corrupt)assert.equal(result.success,true,JSON.stringify(result));
   else{assert.equal(result.success,false);assert.match(JSON.stringify(result),new RegExp(corrupt?'TASK_CONTRACT_JOURNAL_UNAVAILABLE':'TASK_CONTRACT_EFFECT_UNCERTAIN'));}
  }
 };
 await settle(f.engine,f.engine.startRun({workflow:graph(),input:{task:'Inspect synthetic protected effects without replay.',directoryMode:'on',subagentsMode:'off'}}));
 assert.equal(outcomes.length,3);assert.equal(await readFile(path.join(f.cwd,'kept.txt'),'utf8'),corrupt?'unchanged':'verified-independent-write');
 for(const journal of journals)assert.equal(await readFile(journal.file,'utf8'),journal.content);
});
test('Directory attached native execution retains unsupported mutation denial',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.cwd,'kept.txt'),'readable');let mutations=0;
 const native=new DirectTaskRuntime({dataDir:path.join(f.root,'direct')});t.after(()=>native.close());
 native.outcomes.readContext=async()=>({taskId:'attached'});native.validatedContext=async()=>({taskId:'attached'});native.contextScope=async()=>{};
 f.engine.nativeTaskContextBridge={open:async()=>({
  gate:async()=>null,wrap:(adapterId,handler)=>async(call,context)=>{
   if(call.arguments.action!=='read')mutations++;
   return native.executeScoped({ownerId:'owner',taskContext:'synthetic-attached',adapterId,handler,call,signal:context?.signal});
  },beforeFinal:async()=>null,assertReady:async()=>{}
 })};
 f.runtime.inspect=async(options,phase)=>{if(phase?.label!=='work')return;
  for(const action of ['write','run']){
   await assert.rejects(options.onToolCall({name:'relay_workspace',callId:'attached-'+action,arguments:{action,path:'kept.txt',text:'must-not-write',command:'must-not-run'}}),{code:'DIRECT_TASK_ADAPTER_UNSUPPORTED'});
  }
  const read=await options.onToolCall({name:'relay_workspace',callId:'attached-read',arguments:{action:'read',path:'kept.txt'}});
  assert.equal(read.success,true,JSON.stringify(read));
 };
 await settle(f.engine,f.engine.startRun({workflow:graph(),input:{task:'Inspect attached synthetic context.',directoryMode:'on',subagentsMode:'off'}}));
 assert.equal(mutations,2);assert.equal(await readFile(path.join(f.cwd,'kept.txt'),'utf8'),'readable');
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

test('Retry retains Directory preference and starts fresh bounded phases',async t=>{
 const f=await fixture(t);let failOnce=true;
 f.runtime.inspect=async(options,phase)=>{if(phase?.label==='work'&&failOnce){failOnce=false;throw Error('Synthetic interrupted work');}};
 const first=f.engine.startRun({workflow:graph(),input:{task:'Inspect synthetic retry.',directoryMode:'on',subagentsMode:'off'}});
 await f.engine.executions.get(first.id);assert.equal(f.engine.getRun(first.id).status,'failed');
 const retry=await settle(f.engine,f.engine.retryRun(first.id));assert.deepEqual(retry.executionModes,{directoryMode:'on',subagentsMode:'default'});
 assert.ok(retry.nodes.agent.shadowdancer);assert.ok(f.runtime.calls.every(call=>!call.threadId));
});

test('attributed attachment and handoff data stay outside source-page authority while user restrictions survive',async t=>{
 const f=await fixture(t),id='file_'+'a'.repeat(32);
 f.engine.identity={snapshot:async()=>({text:'IDENTITY_PREFERENCE_MARKER: preserve user privacy.',revisions:{},truncated:false})};
 const first=await settle(f.engine,f.engine.startRun({workflow:graph(),input:{task:'PRIOR_RESTRICTION: do not send or modify anything.',directoryMode:'off',subagentsMode:'off'}}));
 f.engine.attachments={validateIds:ids=>ids,snapshot:async()=>[{id,name:'fixture.txt',kind:'text',mime:'text/plain',size:200,sha256:'a'.repeat(64)}],prompt:async()=>'ATTACHMENT_RAW_MUST_NOT_REPEAT '.repeat(60)};
 const imports=[];let sourcePages=0;
 f.runtime.inspect=async(options,phase)=>{
  assert.match(options.prompt,/IDENTITY_PREFERENCE_MARKER/);assert.match(options.prompt,/Do not call host Chrome/);assert.match(options.prompt,/Preserve an in-progress form and inspect prior effects before retrying/);
  if(phase?.label==='context-page')imports.push(options.prompt);
  if(phase?.label==='page-extract'){
   sourcePages++;assert.doesNotMatch(options.prompt,/ATTACHMENT_RAW_MUST_NOT_REPEAT|Ordinary Chat result/);
   assert.match(options.prompt,/PRIOR_RESTRICTION/);assert.match(options.prompt,/CURRENT_GOAL/);
  }
 };
 const next=await settle(f.engine,f.engine.continueRun(first.id,{nodeId:'agent',message:'CURRENT_GOAL: inspect only this source.\nSOURCE:\n'+'a'.repeat(1800),directoryMode:'on',attachmentIds:[id]}));
 assert.equal(sourcePages,1);assert.equal(imports.length,0,'exact attribution must not require a lossy model summary');
 const savedImport=JSON.parse(await readFile(path.join(f.cwd,'.blackice','directory',next.taskId,'runs',next.id,'context/imports/0001/source.json'),'utf8'));
 assert.match(savedImport.content,/ATTACHMENT_RAW_MUST_NOT_REPEAT/);assert.match(savedImport.content,/Ordinary Chat result\./);
 assert.ok(next.nodes.agent.shadowdancer);
});
for(const [version,controlVersion] of [[5,7],[6,8],[6,9]])test('Directory mode change preserves historical V'+version+' / control '+controlVersion+' catalog records without resuming a leaf',async t=>{
 const f=await fixture(t);
 const first=await settle(f.engine,f.engine.startRun({workflow:graph(),input:{task:'OLD_RESTRICTION: retain original history.',directoryMode:'off'}}));
 const saved=f.engine.runs.get(first.id);saved.nodes.agent.taskSchemaVersion=version;saved.nodes.agent.controlSchemaVersion=controlVersion;delete saved.nodes.agent.providerExecutionContract;
 const bytes=JSON.stringify(saved);
 const next=await settle(f.engine,f.engine.continueRun(first.id,{nodeId:'agent',message:'Continue with Directory.',directoryMode:'on'}));
 assert.equal(JSON.stringify(f.engine.runs.get(first.id)),bytes);
 assert.equal(next.modelHandoff.reason,'execution-mode-change');
 assert.ok(f.runtime.calls.slice(1).every(call=>!call.threadId&&!call.continuity));
 assert.ok(f.runtime.calls.slice(1).every(call=>call.prompt.includes('OLD_RESTRICTION')));
});

test('Directory authority rehydrates a middle restriction omitted from ordinary excerpts and fails closed on missing lineage',()=>{
 const family=Array.from({length:20},(_,i)=>({id:'r'+i,taskId:'r0',...(i?{parentRunId:'r'+(i-1)}:{}),createdAt:new Date(i*1000).toISOString(),input:i===7?'MIDDLE_RESTRICTION: do not submit anything.':'Request '+i,events:[]}));
 const rows=directoryUserHistoryFor(family.at(-1),family);
 assert.equal(rows.length,20);assert.ok(rows.some(row=>row.text.includes('MIDDLE_RESTRICTION')));
 assert.throws(()=>directoryUserHistoryFor(family.at(-1),[family.at(-1)]),{code:'DIRECTORY_HISTORY_UNAVAILABLE'});
 const truncated={id:'tail',createdAt:new Date().toISOString(),input:'Continue',priorUserRequests:[{key:'missing',runId:'missing',source:'user-request',text:'excerpt',truncated:true}]};
 assert.throws(()=>directoryUserHistoryFor(truncated),{code:'DIRECTORY_HISTORY_UNAVAILABLE'});
});
test('Directory rehydrates the exact middle of a long prior user request',async t=>{
 const f=await fixture(t),task='a'.repeat(4300)+'MIDDLE_EXACT_BOUNDARY: never send externally.'+'z'.repeat(4300);
 const first=await settle(f.engine,f.engine.startRun({workflow:graph(),input:{task,directoryMode:'off',subagentsMode:'off'}}));
 const next=await settle(f.engine,f.engine.continueRun(first.id,{nodeId:'agent',message:'Inspect without any external action.',directoryMode:'on'}));
 assert.ok(next.priorUserRequests[0].truncated);
 assert.ok(next.directoryUserHistory.some(row=>row.text===task));
 assert.ok(f.runtime.calls.slice(1).every(call=>call.prompt.includes('MIDDLE_EXACT_BOUNDARY')));
});

test('Directory authority cannot follow a foreign-family parent or accept a detached descendant as a root',()=>{
 const foreign={id:'foreign',taskId:'foreign',input:'FOREIGN_PRIVATE_RESTRICTION',events:[]};
 const current={id:'current',taskId:'own-family',parentRunId:'foreign',input:'Own request',events:[]};
 assert.throws(()=>directoryUserHistoryFor(current,[foreign]),{code:'DIRECTORY_HISTORY_UNAVAILABLE'});
 assert.throws(()=>directoryUserHistoryFor({...current,parentRunId:undefined},[]),{code:'DIRECTORY_HISTORY_UNAVAILABLE'});
});

test('live Directory direction reaches current child without assigning parent resume IDs',async t=>{
 const f=await fixture(t),{runtime,engine}=f;let started,release;
 const begin=new Promise(r=>started=r),gate=new Promise(r=>release=r),deliveries=[];
 const originalRuntime=runtime.runAgent.bind(runtime);
 runtime.runAgent=async options=>{
  const phase=phaseOf(options);
  if(phase?.label==='work'){
   options.onEvent?.({type:'thread',threadId:'active-directory-work',turnId:'active-turn'});
   started();await gate;
  }
  return originalRuntime(options);
 };
 runtime.steerAgent=async(thread,text)=>{deliveries.push({thread,text});return{accepted:true,threadId:thread,turnId:'active-turn'};};
 const run=engine.startRun({workflow:graph(),input:{task:'Read synthetic evidence.',directoryMode:'on'}});
 await begin;
 try{
  const result=await engine.steerRun(run.id,{nodeId:'agent',message:'Preserve all work and stop adding tasks.'});
  assert.equal(result.delivery,'delivered');assert.equal(result.queued,false);
  assert.deepEqual(deliveries,[{thread:'active-directory-work',text:'Preserve all work and stop adding tasks.'}]);
  assert.equal(engine.getRun(run.id).nodes.agent.threadId,undefined);
 }finally{release();}
 const final=await settle(engine,run);
 assert.equal(final.nodes.agent.threadId,undefined);
 assert.equal(final.nodes.agent.pendingDirections[0].delivery.status,'delivered');
 assert.equal(engine.directoryDirections.size,0);
});
