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
import {newerTaskState,reduceRunEvent,adoptFetchedRun} from '../public/run-state-model.mjs';
import {recordFixturePlan} from './fixture-task-plan.mjs';

const deferred=()=>{let resolve;return{promise:new Promise(done=>resolve=done),resolve:value=>resolve(value)};};
const wait=async predicate=>{const end=Date.now()+5000;while(Date.now()<end){const value=predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Milestone fixture did not settle.');};
async function fixture(t,execute){
 const directory=await mkdtemp(path.join(tmpdir(),'relay-milestone-runtime-')),cwd=path.join(directory,'workspace');await mkdir(cwd);
 const tasks=await new TaskStateStore({dataDir:directory}).init();
 class Runtime extends EventEmitter{constructor(){super();this.calls=[];}status(){return{connected:true,authenticated:true,defaultModel:'fixture'};}async runAgent(options){this.calls.push(options);return execute(options,this.calls.length);}async close(){}}
 const runtime=new Runtime(),engine=await new HarnessEngine({runtime,tasks,dataDir:directory,defaultCwd:cwd}).init();
 t.after(async()=>{await engine.close();await tasks.close();assert.match(path.basename(directory),/^relay-milestone-runtime-/);await rm(directory,{recursive:true,force:true});});
 const workflow=createMissionWorkflow({id:'milestone-fixture',task:'Deliver a checked result.',cwd});
 return{engine,tasks,runtime,cwd,workflow,settled:id=>wait(()=>engine.getRun(id).settled&&engine.getRun(id))};
}
const schema=options=>options.dynamicTools.find(tool=>tool.name==='relay_task').inputSchema.properties;
async function call(options,args){const result=await options.onToolCall({name:'relay_task',arguments:args},{signal:options.signal});assert.equal(result.success,true,result.contentItems?.[0]?.text);return JSON.parse(result.contentItems[0].text);}

test('native milestone schema survives continuation and old saved catalogs use compatible fields',async t=>{
 const f=await fixture(t,async(options,number)=>{
   options.onEvent({type:'thread',threadId:'native-milestone-thread'});
   if(number<3){assert.ok(schema(options).steps.items.properties.doneWhen);assert.ok(schema(options).status.enum.includes('blocked'));assert.ok(schema(options).action.enum.includes('edit'));assert.ok(schema(options).operations);assert.match(options.prompt,/LIVE PLANNING WORKSPACE/);assert.doesNotMatch(options.prompt,/DEFAULT TASK OUTLINE/);}
   else{assert.equal(schema(options).steps.items.properties.doneWhen,undefined);assert.equal(schema(options).nextAction,undefined);assert.ok(!schema(options).status.enum.includes('blocked'));assert.ok(!schema(options).action.enum.includes('edit'));assert.equal(schema(options).operations,undefined);assert.doesNotMatch(options.prompt,/OPERATIONAL MILESTONES|LIVE PLANNING WORKSPACE/);assert.doesNotMatch(options.developerInstructions,/Give milestones an observable doneWhen/);}
   await recordFixturePlan(options,{title:'Inspect the attached milestone catalog',doneWhen:'Continuation retains the saved catalog and its supported milestone fields.'});
   return{output:'Recorded.',threadId:'native-milestone-thread'};
 });
 const first=await f.settled(f.engine.startRun({workflow:f.workflow,input:'First task.'}).id);assert.equal(first.nodes.agent.taskSchemaVersion,TASK_SCHEMA_VERSION);assert.equal(first.status,'completed',first.error);
 const next=await f.settled(f.engine.continueRun(first.id,{nodeId:'agent',message:'Continue with the saved milestones.'}).id);assert.equal(next.nodes.agent.taskSchemaVersion,TASK_SCHEMA_VERSION);assert.equal(f.runtime.calls[1].threadId,'native-milestone-thread');assert.equal(next.status,'completed',next.error);
 delete f.engine.runs.get(next.id).nodes.agent.taskSchemaVersion;
 const old=await f.settled(f.engine.continueRun(next.id,{nodeId:'agent',message:'Use an older saved native catalog.',planningMode:'off'}).id);assert.equal(old.nodes.agent.taskSchemaVersion,1);assert.equal(old.status,'completed');assert.equal(old.nodes.agent.planning.status,'off');assert.equal(old.nodes.agent.threadId,'native-milestone-thread');assert.equal(f.runtime.calls[2].threadId,'native-milestone-thread');
});

test('native Retry retains its milestone schema after a failed response',async t=>{
 const f=await fixture(t,async(options,number)=>{options.onEvent({type:'thread',threadId:'native-milestone-retry'});assert.ok(schema(options).steps.items.properties.doneWhen);if(number===1)throw Error('Fixture transport failure.');await recordFixturePlan(options,{title:'Resume the interrupted milestone check',doneWhen:'Retry records a current-turn outline with the retained milestone schema and thread.'});return{output:'Resumed.',threadId:'native-milestone-retry'};});
 const failed=await f.settled(f.engine.startRun({workflow:f.workflow,input:'Keep milestones through retry.'}).id);assert.equal(failed.status,'failed');
 const retried=await f.settled(f.engine.retryRun(failed.id).id);assert.equal(retried.status,'completed');assert.equal(retried.nodes.agent.taskSchemaVersion,TASK_SCHEMA_VERSION);assert.equal(f.runtime.calls[1].threadId,'native-milestone-retry');
});

test('version two native catalogs retain milestones without a changed external-action schema',async t=>{
 const f=await fixture(t,async(options,number)=>{
   options.onEvent({type:'thread',threadId:'native-v2-catalog'});
   assert.ok(schema(options).steps.items.properties.doneWhen);assert.ok(schema(options).status.enum.includes('blocked'));
   if(number===1)assert.ok(schema(options).external);else{assert.equal(schema(options).external,undefined);assert.doesNotMatch(options.prompt,/EXTERNAL ACTION RECOVERY/);assert.doesNotMatch(options.developerInstructions,/persist attempt immediately before the final send/);}
   await recordFixturePlan(options,{title:'Inspect the retained milestone fields',doneWhen:'The saved catalog keeps its original milestone and external-action capabilities.'});
   return{output:'Saved.',threadId:'native-v2-catalog'};
 });
 const initial=await f.settled(f.engine.startRun({workflow:f.workflow,input:'Original task.'}).id);assert.equal(initial.status,'completed',initial.error);f.engine.runs.get(initial.id).nodes.agent.taskSchemaVersion=2;
 const next=await f.settled(f.engine.continueRun(initial.id,{nodeId:'agent',message:'Continue using the original v2 catalog.',planningMode:'off'}).id);assert.equal(next.nodes.agent.taskSchemaVersion,2);assert.equal(next.status,'completed');assert.equal(next.nodes.agent.planning.status,'off');assert.equal(next.nodes.agent.threadId,'native-v2-catalog');
});

test('Retry after a lost publication response reconciles its durable attempt instead of sending twice',async t=>{
 let sends=0;
 const f=await fixture(t,async(options,number)=>{
   options.onEvent({type:'thread',threadId:'native-publication-thread'});
   let saved=await call(options,{action:'read'});
   saved=await call(options,{action:'plan',expectedRevision:saved.revision,steps:[{id:'publish',title:'Reconcile the supplied publication receipt',status:'active',operation:{kind:'reasoning',target:'The supplied publish-once fixture receipt and destination observation'},result:'One reconciled publication receipt without a duplicate send.',note:'Compare the supplied destination observation with the saved publish-once attempt.',doneWhen:'The one existing or newly sent result has a confirmed receipt with observed destination evidence.'}]});
   if(number===1){
     saved=await call(options,{action:'external',expectedRevision:saved.revision,external:{receiptId:'publish-once',operation:'prepare',destination:'https://www.linkedin.com/in/fixture/recent-activity/',content:'BLACKICE development update.',attachmentSha256:'a'.repeat(64)}});
     await call(options,{action:'external',expectedRevision:saved.revision,external:{receiptId:'publish-once',operation:'attempt'}});
     sends++;throw Error('Connection dropped after the remote send; result unknown.');
   }
   assert.equal(saved.externalActions[0].status,'uncertain');assert.match(options.prompt,/Uncertain external attempt: publish-once/);
   const blocked=await options.onToolCall({name:'relay_task',arguments:{action:'external',expectedRevision:saved.revision,external:{receiptId:'publish-once',operation:'attempt'}}});assert.equal(blocked.success,false);assert.equal(blocked.code,'EXTERNAL_ACTION_RECONCILE');
   saved=await call(options,{action:'external',expectedRevision:saved.revision,external:{receiptId:'publish-once',operation:'confirm',url:'https://www.linkedin.com/feed/update/urn:li:activity:fixture/',evidence:'Fixture reconciliation observed the already-created exact text and attachment.'}});
   return{output:'Existing result reconciled; no second send.',threadId:'native-publication-thread'};
 });
 const failed=await f.settled(f.engine.startRun({workflow:f.workflow,input:'Publish exactly one development update.'}).id);assert.equal(failed.status,'failed');assert.equal(failed.taskState.externalActions[0].status,'uncertain');
 const retried=await f.settled(f.engine.retryRun(failed.id).id);assert.equal(retried.status,'completed');assert.equal(sends,1);assert.equal(retried.taskState.externalActions[0].status,'confirmed');assert.equal(retried.taskState.externalActions[0].attempts,1);assert.equal(retried.taskId,failed.taskId||failed.id);
});

test('a delayed older milestone receipt cannot replace a newer committed swarm state',async t=>{
 const committed=deferred(),release=deferred();let taskId;
 const f=await fixture(t,async options=>{
   const initial=await call(options,{action:'read'});taskId=initial.taskId;
   const older=call(options,{action:'plan',expectedRevision:initial.revision,steps:[{id:'deliver',title:'Compare the supplied fixture result',status:'active',operation:{kind:'reasoning',target:'The supplied milestone fixture output'},result:'The checked fixture output.',note:'Compare the supplied fixture output with its expected value.',doneWhen:'The output is checked.'}]});
   await committed.promise;
   const current=await call(options,{action:'read'}),latest=await call(options,{action:'step',expectedRevision:current.revision,stepId:'deliver',status:'done',evidence:'Checked actual output.'});
   release.resolve();await older;assert.equal(f.engine.getRun(options.runId||f.engine.listRuns()[0].id).taskState.revision,latest.revision);
   return{output:'Done.',threadId:'provider_milestone-race'};
 });
 const original=f.tasks.setPlan.bind(f.tasks);f.tasks.setPlan=async(...args)=>{const result=await original(...args);committed.resolve();await release.promise;return result;};
 const run=await f.settled(f.engine.startRun({workflow:f.workflow,input:'Check concurrent progress.'}).id);assert.equal(run.status,'completed');assert.equal(run.taskState.progress.done,1);assert.equal(run.taskState.revision,(await f.tasks.get(taskId)).revision);
 const events=run.events.filter(event=>event.data?.type==='task.state').map(event=>event.data.state.revision);assert.deepEqual(events,[1,2,3]);
});

test('settled run snapshots reload authoritative milestones even when the writer event was lost',async t=>{
 let f;f=await fixture(t,async options=>{const state=await recordFixturePlan(options,{title:'Check the real result',doneWhen:'The check passes.'});await f.tasks.setStep(state.taskId,state.steps[0].id,{status:'done',evidence:'Fixture check passed.'},{runId:f.engine.listRuns()[0].id,nodeId:'agent',expectedRevision:state.revision});return{output:'Finished.',threadId:'provider_no-event'};});
 const run=await f.settled(f.engine.startRun({workflow:f.workflow,input:'Keep committed progress.'}).id);assert.equal(run.status,'completed');assert.equal(run.taskState.progress.done,1);assert.equal(run.taskState.steps[0].evidence,'Fixture check passed.');
});

test('milestone stream and HTTP merges keep revision order and reject another task',()=>{
 const current={taskId:'task',revision:7,steps:[{id:'a',status:'done'}]},old={...current,revision:6,steps:[]},run={id:'run',taskId:'task',updatedAt:'2026-10-17T10:00:00Z',taskState:current,nodes:{agent:{}}};
 assert.equal(reduceRunEvent(run,{type:'agent.event',runId:'run',nodeId:'agent',data:{type:'task.state',state:old}}).taskState,current);
 assert.equal(reduceRunEvent(run,{type:'agent.event',runId:'run',data:{type:'task.state',state:{taskId:'other',revision:900}}}).taskState,current);
 const incoming={...run,updatedAt:'2026-10-17T10:00:01Z',status:'completed',taskState:old},adopted=adoptFetchedRun(run,incoming);assert.equal(adopted.status,'completed');assert.equal(adopted.taskState,current);
 assert.equal(newerTaskState(current,undefined,'task'),current);assert.equal(newerTaskState(current,{...current,revision:8},'task').revision,8);
});

test('milestone guidance uses only the fields attached to the selected tool schema',()=>{
 const legacy={name:'relay_task',inputSchema:{properties:{action:{enum:['read','plan','step']},steps:{items:{properties:{title:{type:'string'}}}}}}};
 assert.doesNotMatch(capabilityGuidance([legacy]),/Give milestones an observable doneWhen/);
 const current=structuredClone(legacy);current.inputSchema.properties.steps.items.properties.doneWhen={type:'string'};assert.match(capabilityGuidance([current]),/Give milestones an observable doneWhen/);assert.match(capabilityGuidance([current]),/never an approval gate/);
});
