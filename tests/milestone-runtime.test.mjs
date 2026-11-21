import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {HarnessEngine} from '../lib/engine.mjs';
import {TaskStateStore,TASK_SCHEMA_VERSION} from '../lib/task-state.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';
import {capabilityGuidance} from '../lib/tool-routing.mjs';
import {createInstructionAudit} from '../lib/instruction-audit.mjs';
import {newerTaskState,reduceRunEvent,adoptFetchedRun} from '../public/run-state-model.mjs';

const deferred=()=>{let resolve;return{promise:new Promise(done=>resolve=done),resolve:value=>resolve(value)};};
const wait=async predicate=>{const end=Date.now()+5000;while(Date.now()<end){const value=predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Milestone fixture did not settle.');};
async function fixture(t,execute){
 const directory=await mkdtemp(path.join(tmpdir(),'relay-milestone-runtime-')),cwd=path.join(directory,'workspace');await mkdir(cwd);
 const tasks=await new TaskStateStore({dataDir:directory}).init();
 class Runtime extends EventEmitter{constructor(){super();this.calls=[];}status(){return{connected:true,authenticated:true,defaultModel:'fixture'};}async runAgent(options){this.calls.push(options);return execute(options,this.calls.length);}async close(){}}
 const runtime=new Runtime(),engine=await new HarnessEngine({runtime,tasks,dataDir:directory,defaultCwd:cwd}).init();
 // Exercise the saved Planning catalog explicitly. Ordinary Chat no longer exposes relay_task.
 engine.runtimeSettings={get:()=>({executionGuardrails:true})};
 t.after(async()=>{await engine.close();await tasks.close();assert.match(path.basename(directory),/^relay-milestone-runtime-/);await rm(directory,{recursive:true,force:true});});
 const workflow=createMissionWorkflow({id:'milestone-fixture',task:'Deliver a checked result.',cwd,planningMode:'off'});
 workflow.planning={shared:true,coordinatorNodeId:'agent'};
 return{engine,tasks,runtime,cwd,workflow,settled:id=>wait(()=>engine.getRun(id).settled&&engine.getRun(id))};
}
const schema=options=>options.dynamicTools.find(tool=>tool.name==='relay_task').inputSchema.properties;
async function call(options,args){const result=await options.onToolCall({name:'relay_task',arguments:args},{signal:options.signal});assert.equal(result.success,true,result.contentItems?.[0]?.text);return JSON.parse(result.contentItems[0].text);}

test('current native task catalog survives continuation while missing saved catalogs fail closed',async t=>{
 const f=await fixture(t,async(options)=>{options.onEvent({type:'thread',threadId:'native-milestone-thread'});assert.ok(schema(options).contract);assert.ok(!schema(options).steps);assert.ok(!schema(options).action.enum.includes('step'));return{output:'Current catalog checked.',threadId:'native-milestone-thread'};});
 const first=await f.settled(f.engine.startRun({workflow:f.workflow,input:'First task.'}).id);assert.equal(first.status,'completed',first.error);
 const next=await f.settled(f.engine.continueRun(first.id,{nodeId:'agent',message:'Continue.'}).id);assert.equal(next.status,'completed',next.error);assert.equal(next.nodes.agent.taskSchemaVersion,TASK_SCHEMA_VERSION);assert.equal(f.runtime.calls[1].threadId,'native-milestone-thread');
 delete f.engine.runs.get(next.id).nodes.agent.taskSchemaVersion;delete f.engine.runs.get(next.id).nodes.agent.resumeTaskSchemaVersion;
 assert.throws(()=>f.engine.continueRun(next.id,{nodeId:'agent',message:'Continue.'}),{code:'NATIVE_CATALOG_UNSUPPORTED'});assert.equal(f.runtime.calls.length,2);
});

test('native Retry retains current schema and genuine transport failure',async t=>{
 const f=await fixture(t,async(options,number)=>{options.onEvent({type:'thread',threadId:'native-milestone-retry'});if(number===1)throw Error('Fixture transport failure.');assert.ok(schema(options).contract);return{output:'Resumed.',threadId:'native-milestone-retry'};});
 const failed=await f.settled(f.engine.startRun({workflow:f.workflow,input:'Retain current tools through retry.'}).id);assert.equal(failed.status,'failed');assert.match(failed.error,/Fixture transport failure/);
 const retried=await f.settled(f.engine.retryRun(failed.id).id);assert.equal(retried.status,'completed',retried.error);assert.equal(retried.nodes.agent.taskSchemaVersion,TASK_SCHEMA_VERSION);assert.equal(f.runtime.calls[1].threadId,'native-milestone-retry');
});

test('version two native catalog is rejected without provider dispatch or saved-state mutation',async t=>{
 const f=await fixture(t,async options=>{options.onEvent({type:'thread',threadId:'native-v2-catalog'});return{output:'Saved.',threadId:'native-v2-catalog'};});
 const initial=await f.settled(f.engine.startRun({workflow:f.workflow,input:'Original task.'}).id);assert.equal(initial.status,'completed',initial.error);const before=await f.tasks.get(initial.taskId);f.engine.runs.get(initial.id).nodes.agent.taskSchemaVersion=2;
 assert.throws(()=>f.engine.continueRun(initial.id,{nodeId:'agent',message:'Continue.'}),{code:'NATIVE_CATALOG_UNSUPPORTED'});assert.equal(f.runtime.calls.length,1);assert.deepEqual(await f.tasks.get(initial.taskId),before);
});

test('Retry after a lost publication response preserves a direct-store attempt and prevents a second send',async t=>{
 let sends=0;
 const f=await fixture(t,async(options,number)=>{
  options.onEvent({type:'thread',threadId:'native-publication-thread'});
  const read=await call(options,{action:'read'});let saved=await f.tasks.get(read.taskId);
  if(number===1){
   saved=await f.tasks.externalAction(saved.taskId,{receiptId:'publish-once',operation:'prepare',destination:'https://www.linkedin.com/in/fixture/recent-activity/',content:'BLACKICE development update.',attachmentSha256:'a'.repeat(64)},{expectedRevision:saved.revision,source:'human'});
   await f.tasks.externalAction(saved.taskId,{receiptId:'publish-once',operation:'attempt'},{expectedRevision:saved.revision,source:'human'});
   sends++;throw Error('Connection dropped after the remote send; result unknown.');
  }
  assert.equal(saved.externalActions[0].status,'uncertain');assert.match(options.prompt,/Recorded uncertain attempts: publish-once/);assert.match(options.prompt,/inspect the destination before repeating the same possible effect/);
  await assert.rejects(f.tasks.externalAction(saved.taskId,{receiptId:'publish-once',operation:'attempt'},{expectedRevision:saved.revision,source:'human'}),{code:'EXTERNAL_ACTION_RECONCILE'});
  saved=await f.tasks.externalAction(saved.taskId,{receiptId:'publish-once',operation:'confirm',url:'https://www.linkedin.com/feed/update/urn:li:activity:fixture/',evidence:'Fixture reconciliation observed the already-created exact text and attachment.'},{expectedRevision:saved.revision,source:'human'});
  assert.equal(saved.externalActions[0].status,'confirmed');return{output:'Existing result reconciled; no second send.',threadId:'native-publication-thread'};
 });
 const failed=await f.settled(f.engine.startRun({workflow:f.workflow,input:'Publish exactly one development update.'}).id);assert.equal(failed.status,'failed');assert.equal(failed.taskState.externalActions[0].status,'uncertain');
 const retried=await f.settled(f.engine.retryRun(failed.id).id);assert.equal(retried.status,'completed',retried.error);assert.equal(sends,1);assert.equal(retried.taskState.externalActions[0].status,'confirmed');assert.equal(retried.taskState.externalActions[0].attempts,1);assert.equal(retried.taskId,failed.taskId);
});

const manualLeaf={id:'deliver',title:'Compare the supplied fixture result',kind:'action',status:'active',operation:{kind:'reasoning',target:'The supplied milestone fixture output'},result:'The checked fixture output.',note:'Compare the supplied fixture output with its expected value.',doneWhen:'The output is checked.'};
test('delayed older store receipt cannot replace newer engine task state',async t=>{
 const committed=deferred(),release=deferred();let taskId,olderRevision,latestRevision;
 const f=await fixture(t,async options=>{
  const initial=await call(options,{action:'read'});taskId=initial.taskId;
  const older=f.tasks.setPlan(taskId,{plan:{layout:'sequence'},steps:[manualLeaf]},{expectedRevision:initial.revision,source:'human'});
  await committed.promise;const current=await f.tasks.get(taskId);
  const latest=await f.tasks.setStep(taskId,'deliver',{status:'done',evidence:'Checked actual output.'},{expectedRevision:current.revision,source:'human'});latestRevision=latest.revision;
  const raw=f.engine.runs.get(f.engine.listRuns()[0].id);assert.equal(f.engine.adoptTaskState(raw,latest),true);
  release.resolve();const delayed=await older;olderRevision=delayed.revision;assert.equal(f.engine.adoptTaskState(raw,delayed),false);
  assert.equal(raw.taskState.revision,latestRevision);assert.equal(raw.taskState.steps[0].status,'done');assert.equal(raw.taskState.steps[0].evidence,'Checked actual output.');return{output:'Done.',threadId:'provider_milestone-race'};
 });
 const original=f.tasks.setPlan.bind(f.tasks);f.tasks.setPlan=async(...args)=>{const result=await original(...args);committed.resolve();await release.promise;return result;};
 const run=await f.settled(f.engine.startRun({workflow:f.workflow,input:'Check concurrent progress.'}).id);assert.equal(run.status,'completed',run.error);assert.equal(run.taskState.progress.done,1);assert.equal(latestRevision,olderRevision+1);assert.equal(run.taskState.revision,(await f.tasks.get(taskId)).revision);
});

test('settled snapshots reload authoritative manual milestones after writer event loss',async t=>{
 const f=await fixture(t,async options=>{const initial=await call(options,{action:'read'});const state=await f.tasks.setPlan(initial.taskId,{plan:{layout:'sequence'},steps:[manualLeaf]},{expectedRevision:initial.revision,source:'human'});await f.tasks.setStep(state.taskId,'deliver',{status:'done',evidence:'Fixture check passed.'},{expectedRevision:state.revision,source:'human'});return{output:'Finished.',threadId:'provider_no-event'};});
 const run=await f.settled(f.engine.startRun({workflow:f.workflow,input:'Keep committed progress.'}).id);assert.equal(run.status,'completed',run.error);assert.equal(run.taskState.progress.done,1);assert.equal(run.taskState.steps[0].evidence,'Fixture check passed.');
});

test('milestone stream and HTTP merges keep revision order and reject another task',()=>{
 const current={taskId:'task',revision:7,steps:[{id:'a',status:'done'}]},old={...current,revision:6,steps:[]},run={id:'run',taskId:'task',updatedAt:'2026-10-17T10:00:00Z',taskState:current,nodes:{agent:{}}};
 assert.equal(reduceRunEvent(run,{type:'agent.event',runId:'run',nodeId:'agent',data:{type:'task.state',state:old}}).taskState,current);
 assert.equal(reduceRunEvent(run,{type:'agent.event',runId:'run',data:{type:'task.state',state:{taskId:'other',revision:900}}}).taskState,current);
 const incoming={...run,updatedAt:'2026-10-17T10:00:01Z',status:'completed',taskState:old},adopted=adoptFetchedRun(run,incoming);assert.equal(adopted.status,'completed');assert.equal(adopted.taskState,current);
 assert.equal(newerTaskState(current,undefined,'task'),current);assert.equal(newerTaskState(current,{...current,revision:8},'task').revision,8);
});

test('milestone fields are documented only by the selected attached tool schema',()=>{
 const legacy={name:'relay_task',description:'Manage the attached milestone outline.',inputSchema:{properties:{action:{enum:['read','plan','step']},steps:{items:{properties:{title:{type:'string',description:'Milestone title.'}}}}}}};
 const current=structuredClone(legacy),description='Observable condition required for this milestone.';
 current.inputSchema.properties.steps.items.properties.doneWhen={type:'string',description};
 for(const selected of [legacy,current]){
  const guidance=capabilityGuidance([selected],{executionGuardrails:true});
  assert.match(guidance,/ATTACHED TOOLS\nrelay_task\nADAPTER NOTES\nrelay_task:/);
  assert.doesNotMatch(guidance,/Give milestones an observable doneWhen|never an approval gate/);
  const capture=createInstructionAudit({tools:[selected]}),definitions=capture.sections.filter(section=>section.layer==='tool-definition');
  assert.deepEqual(capture.tools.names,['relay_task']);assert.equal(definitions.length,1);
  assert.ok(definitions[0].text.includes(selected.description));assert.ok(definitions[0].text.includes('Milestone title.'));
  if(selected===legacy)assert.doesNotMatch(definitions[0].text,/doneWhen/);
  else {assert.match(definitions[0].text,/doneWhen/);assert.ok(definitions[0].text.includes(description));}
 }
});
