import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';import {HarnessEngine} from '../lib/engine.mjs';import {TaskActionDirectoryStore} from '../lib/task-action-directory-store.mjs';
const graph={name:'Actions',nodes:[{id:'i',type:'input'},{id:'a',type:'agent',name:'Agent',model:'fixture-model',prompt:'Do task'},{id:'o',type:'output'}],edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{maxParallel:1,planningMode:'off'}};
class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,models:[{id:'fixture-model',supportsTools:true}]};}async runAgent(options){return this.execute(options);}}
async function setup(t,execute){const root=await mkdtemp(path.join(tmpdir(),'action-directory-'));const runtime=new Runtime();runtime.execute=execute;const engine=await new HarnessEngine({runtime,dataDir:root,defaultCwd:root}).init();t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});return{root,engine};}
test('actual engine explicit Directory prevents zero-tool final from completing while Off remains ordinary Chat',async t=>{let options;const{engine}=await setup(t,async o=>{options=o;return{output:'All done'};});const on=engine.startRun({workflow:graph,input:{task:'Find three jobs',directoryActions:'on'}});await engine.executions.get(on.id);assert.equal(engine.getRun(on.id).status,'failed');assert.match(engine.getRun(on.id).error,/unfinished/);assert(options.dynamicTools.some(x=>x.name==='relay_directory_action'));assert.equal(options.hostOnlyTools,true);const off=engine.startRun({workflow:graph,input:{task:'Answer text',directoryActions:'off'}});await engine.executions.get(off.id);assert.equal(engine.getRun(off.id).status,'completed');assert(!options.dynamicTools.some(x=>x.name==='relay_directory_action'));});
test('a no-actions provider final tells the model to start the actual next step using the evidence already returned',async t=>{
 const {engine,root}=await setup(t,async o=>{
  const call=(name,args,id)=>o.onToolCall({name,arguments:args,callId:id});
  const dir=(action,data={})=>call('relay_directory_action',{action,...data},'directory-'+action);
  const inspected=await call('relay_workspace',{action:'list',path:root},'initial-read');
  assert.equal(inspected.success,true);
  const review=()=>o.onBeforeFinal({output:'I opened the input; the result has not been saved.',signal:o.signal});
  const continuation=await review();
  assert.equal(continuation.continue,true);
  assert.match(continuation.prompt,/^Directory has no actions/);
  assert.match(continuation.prompt,/use the evidence already returned/);
  assert.match(continuation.prompt,/one concrete next step and its observable result; focus that step and take the next tool action now/);
  assert.match(continuation.prompt,/Do not list or reopen sources already inspected/);
  assert.match(continuation.prompt,/check that exact prerequisite in the focused step and record the actual blocker with the returned receipt/);
  const empty=await dir('read');
  assert.deepEqual(JSON.parse(empty.contentItems[0].text).actions,[],'The host did not invent a step.');
  assert.equal((await dir('plan',{actions:[{id:'save',objective:'Save the verified output',dependsOn:[]}]})).success,true);
  assert.equal((await dir('focus',{id:'save'})).success,true);
  const saved=await call('relay_workspace',{action:'write',path:path.join(root,'result.txt'),text:'Verified output'},'save-output');
  assert.equal(saved.success,true);
  const [receipt]=saved.contentItems.at(-1).text.match(/receipt-[0-9]+/);
  assert.equal((await dir('observe',{id:'save',claim:'The output was saved.',receipts:[receipt]})).success,true);
  assert.equal(await o.onBeforeFinal({output:'Saved the result.',signal:o.signal}),undefined);
  return {output:'Saved the result.'};
 });
 const run=engine.startRun({workflow:graph,input:{task:'Inspect the inputs, then save the verified output',directoryActions:'on'}});
 await engine.executions.get(run.id);
 assert.equal(engine.getRun(run.id).status,'completed',engine.getRun(run.id).error);
});
test('actual handler work drives action observation and durable same-task state without payload imports',async t=>{let state;const{engine,root}=await setup(t,async o=>{const call=async args=>{const r=await o.onToolCall({name:'relay_directory_action',arguments:args,callId:'directory'});assert.equal(r.success,true,JSON.stringify(r));return JSON.parse(r.contentItems[0].text);};state=await call({action:'read'});state=await call({action:'plan',revision:state.revision,actions:[{id:'inspect',objective:'List current directory',dependsOn:[]}]});state=await call({action:'focus',revision:state.revision,id:'inspect'});const r=await o.onToolCall({name:'relay_workspace',arguments:{action:'list',path:root},callId:'list'});assert.equal(r.success,true,JSON.stringify(r));state=await call({action:'read'});assert.equal(state.receipts.length,1);state=await call({action:'observe',revision:state.revision,id:'inspect',claim:'The folder listing returned',receipts:[state.receipts[0].id]});assert.equal(Boolean(await o.onBeforeFinal({signal:o.signal})),false);return{output:'Listed folder'};});const run=engine.startRun({workflow:graph,input:{task:'List current folder',directoryActions:'on'}});await engine.executions.get(run.id);assert.equal(engine.getRun(run.id).status,'completed',engine.getRun(run.id).error);assert.equal(engine.getRun(run.id).nodes.a.directoryContext,undefined,'Action Directory works with diagnostic capture off');const store=new TaskActionDirectoryStore(root);const reopened=await store.get(run.id,'Ignored new objective');assert.equal(reopened.read().actions[0].state,'observed');const other=await store.get('separate-task','Another objective');assert.equal(other.read().actions.length,0);assert.equal(other.read().objective,'Another objective');await store.close();});
test('same display group does not inherit action mode or action state',async t=>{const{engine}=await setup(t,async()=>({output:'No work'}));const first=engine.startRun({workflow:graph,input:{task:'First',directoryActions:'on'}});await engine.executions.get(first.id);const second=engine.startRun({workflow:graph,input:{task:'Second'}},{chatDisplayGroupId:first.id,sourceTaskId:first.id});await engine.executions.get(second.id);const run=engine.getRun(second.id);assert.equal(run.directoryActions,undefined);assert.equal(run.status,'completed');assert.notEqual(run.taskId||run.id,first.id);});
test('late Directory callback after cancellation cannot mutate durable state',async t=>{let options;const{engine}=await setup(t,async o=>{options=o;return{output:'No actions'};});const run=engine.startRun({workflow:graph,input:{task:'Do work',directoryActions:'on'}});await engine.executions.get(run.id);const ledger=await engine.actionDirectories.get(run.id,'Work');const before=ledger.read();const result=await options.onToolCall({name:'relay_directory_action',arguments:{action:'plan',revision:before.revision,actions:[{id:'late',objective:'Late',dependsOn:[]}]}});assert.equal(result.success,false);assert.equal(result.code,'ABORT_ERR');assert.deepEqual(ledger.read(),before);});
test('actual provider correction is bounded and read-only evidence remains available without focus',async t=>{const{engine}=await setup(t,async o=>{assert.equal((await o.onBeforeFinal({signal:o.signal})).continue,true);const read=await o.onToolCall({name:'relay_workspace',arguments:{action:'list',path:'.'},callId:'read'});assert.equal(read.success,true);await assert.rejects(o.onBeforeFinal({signal:o.signal}),{code:'DIRECTORY_ACTION_UNFINISHED'});return{output:'Not complete'};});const run=engine.startRun({workflow:graph,input:{task:'Find jobs',directoryActions:'on'}});await engine.executions.get(run.id);assert.equal(engine.getRun(run.id).status,'failed');});
test('real steerRun blocks prior focus durably before redirecting provider',async t=>{let ready,finish;const started=new Promise(r=>ready=r);const{engine}=await setup(t,async o=>{const call=async args=>JSON.parse((await o.onToolCall({name:'relay_directory_action',arguments:args})).contentItems[0].text);let s=await call({action:'plan',revision:0,actions:[{id:'old',objective:'Original',dependsOn:[]}]});await call({action:'focus',id:'old',revision:s.revision});o.onEvent({type:'thread',threadId:'fixture-thread',turnId:'turn'});ready();await new Promise(r=>finish=r);return{output:'Redirected'};});engine.runtime.steerAgent=async()=>({accepted:true});const run=engine.startRun({workflow:graph,input:{task:'Original',directoryActions:'on'}});await started;const before=(await engine.actionDirectories.get(run.id,'Original')).read();await engine.steerRun(run.id,{nodeId:'a',message:'Stop that approach; use a different source.'});const after=(await engine.actionDirectories.get(run.id,'Original')).read();assert(after.revision>before.revision);assert.equal(after.focus,null);assert.equal(after.actions[0].state,'blocked');assert.equal(after.steering.requiresReplan,true);finish();await engine.executions.get(run.id);assert.equal(engine.getRun(run.id).status,'failed');});
import {handleTaskActionDirectoryHttp} from '../lib/task-action-directory-http.mjs';
import {access,readFile} from 'node:fs/promises';
test('human HTTP redirect invalidates cached provider focus before its next effect',async t=>{let ready,finish,options;const started=new Promise(r=>ready=r);const{engine,root}=await setup(t,async o=>{options=o;const call=async args=>JSON.parse((await o.onToolCall({name:'relay_directory_action',arguments:args})).contentItems[0].text);let s=await call({action:'plan',revision:0,actions:[{id:'old',objective:'Old work',dependsOn:[]},{id:'new',objective:'New work',dependsOn:[]}]});await call({action:'focus',id:'old',revision:s.revision});ready();await new Promise(r=>finish=r);return{output:'Not finished'};});const run=engine.startRun({workflow:graph,input:{task:'Work',directoryActions:'on'}});await started;const ledger=await engine.actionDirectories.get(run.id,'Work');const edit=async payload=>handleTaskActionDirectoryHttp({req:{method:'POST',headers:{},url:'/api/conversations/'+run.id+'/action-directory?taskId='+run.id},pathname:'/api/conversations/'+run.id+'/action-directory',engine,conversations:{},res:{},body:async()=>payload,json:(_res,status)=>assert.equal(status,200)});await edit({action:'block',id:'old',claim:'Redirect to new action',revision:ledger.read().revision});await edit({action:'focus',id:'new',revision:ledger.read().revision});const result=await options.onToolCall({name:'relay_workspace',callId:'stale-write',arguments:{action:'write',path:path.join(root,'MUST-NOT-EXIST.txt'),text:'wrong action'}});assert.equal(result.success,false);assert.equal(result.code,'DIRECTORY_CHANGED');await assert.rejects(access(path.join(root,'MUST-NOT-EXIST.txt')));assert.equal(ledger.read().receipts.length,0);const refreshed=await options.onToolCall({name:'relay_directory_action',arguments:{action:'read'}});assert.equal(refreshed.success,true);const current=await options.onToolCall({name:'relay_workspace',callId:'current-write',arguments:{action:'write',path:path.join(root,'MUST-NOT-EXIST.txt'),text:'authorized current action'}});assert.equal(current.success,true,JSON.stringify(current));assert.equal(await readFile(path.join(root,'MUST-NOT-EXIST.txt'),'utf8'),'authorized current action');assert.equal(ledger.read().receipts.at(-1).actionId,'new');finish();await engine.executions.get(run.id);});
test('human edit during awaited handoff cannot become an unseen provider revision',async t=>{let calls=0,firstId;const{engine,root}=await setup(t,async o=>{if(++calls===1)return{output:'First ordinary turn'};assert.match(o.prompt,/"revision":0/);assert.doesNotMatch(o.prompt,/Unseen action/);const write=()=>o.onToolCall({name:'relay_workspace',callId:'handoff-write',arguments:{action:'write',path:path.join(root,'handoff.txt'),text:'current focus'}});const denied=await write();assert.equal(denied.success,false);assert.equal(denied.code,'DIRECTORY_CHANGED');await assert.rejects(access(path.join(root,'handoff.txt')));const observed=await o.onToolCall({name:'relay_directory_action',arguments:{action:'read'}});assert.equal(observed.success,true);const accepted=await write();assert.equal(accepted.success,true,JSON.stringify(accepted));assert.equal(await readFile(path.join(root,'handoff.txt'),'utf8'),'current focus');return{output:'Not complete'};});const first=engine.startRun({workflow:graph,input:'Initial ordinary turn'});firstId=first.id;await engine.executions.get(first.id);let held=false;engine.fitHandoff=async(_handoff,_node,_graph,prompt)=>{held=true;await new Promise(r=>setTimeout(r,1));const ledger=await engine.actionDirectories.get(firstId,'Initial ordinary turn');let s=await ledger.edit({action:'plan',revision:0,actions:[{id:'new',objective:'Unseen action',dependsOn:[]}]},{authority:'human'});await ledger.edit({action:'focus',id:'new',revision:s.revision},{authority:'human'});return{prompt,runtimeContinuity:undefined,continuity:{method:'none'}};};const next=engine.continueRun(first.id,{nodeId:'a',message:'Use Directory',directoryActions:'on'});await engine.executions.get(next.id);assert.equal(held,true);assert.equal(calls,2);assert.equal(engine.getRun(next.id).errorCode,'DIRECTORY_ACTION_UNFINISHED');});

test('blocked dependency replay permits an honest final after one recovery but does not record the dependent effect',async t=>{
 const{engine,root}=await setup(t,async o=>{
  const call=(args,i)=>o.onToolCall({name:'relay_directory_action',arguments:args,callId:'dir-'+i});
  assert.equal((await call({action:'plan',actions:[{id:'route',objective:'Verify route',dependsOn:[]},{id:'dependent',objective:'Run only after verification',dependsOn:['route']}]},1)).success,true);
  const outOfOrder=await call({action:'observe',id:'route',claim:'Candidate observed',receipts:[]},2);assert.equal(outOfOrder.code,'DIRECTORY_OBSERVATION');assert.match(outOfOrder.contentItems[0].text,/not focused/);
  assert.equal((await o.onBeforeFinal({signal:o.signal})).continue,true);
  assert.equal((await call({action:'focus',id:'route'},3)).success,true);
  assert.equal((await call({action:'block',id:'route',blocker:'prerequisite-unavailable',claim:'No source was checked.'},4)).code,'DIRECTORY_BLOCKER');
  const missing=await o.onToolCall({name:'relay_workspace',arguments:{action:'list',path:path.join(root,'required-input')},callId:'verify-unavailable'});
  assert.equal(missing.success,false);
  assert.equal((await call({action:'block',id:'route',blocker:'prerequisite-unavailable',claim:'The required input directory does not exist.',receipts:['receipt-1']},5)).success,true);
  assert.equal(Boolean(await o.onBeforeFinal({signal:o.signal})),false);
  return{output:'Could not confirm the route. No dependent work was performed.'};
 });
 for(const mode of ['off','on','maximal']){
  const run=engine.startRun({workflow:graph,input:{task:'Check a candidate route',directoryActions:'on',directoryDiagnostics:mode}});
  await engine.executions.get(run.id);
  const result=engine.getRun(run.id);
  assert.equal(result.status,'completed',result.error);assert.equal(result.nodes.a.directoryOutcome,'incomplete');assert.match(result.output,/No dependent work/);
  const ledger=await engine.actionDirectories.get(run.id,'Check a candidate route');
  assert.deepEqual(ledger.finalStatus().dependencyBlocked,[{id:'dependent',blockedBy:['route']}]);
  assert.deepEqual(ledger.read().actions[0].observation.receipts,['receipt-1']);
  if(mode==='maximal'){
   const observed=engine.runs.get(run.id).turnMachineTrace.head;
   assert(observed.some(e=>e.metadata?.reason==='blocked-paths'&&e.metadata?.dependencyBlockedCount===1),JSON.stringify(observed.at(-1)));
  }
 }
});

test('focus-after-read live trace replay advances without repeating the successful workspace read',async t=>{
 const{engine}=await setup(t,async o=>{
  const dir=(action,args={})=>o.onToolCall({name:'relay_directory_action',callId:'dir-'+action,arguments:{action,...args}});
  const plan=await dir('plan',{actions:[{id:'find',objective:'Find local input',dependsOn:[]},{id:'use',objective:'Inspect another source',dependsOn:['find']}]});
  assert.equal(plan.success,true);
  const read=await o.onToolCall({name:'relay_workspace',callId:'first-list',arguments:{action:'list',path:'.'}});
  assert.equal(read.success,true,JSON.stringify(read));
  const note=read.contentItems.at(-1).text;
  assert.match(note,/cite this same-turn read/);
  const [receipt]=note.match(/receipt-[0-9]+/);
  const obs=()=>dir('observe',{id:'find',claim:'Read the local inputs',receipts:[receipt]});
  assert.equal((await obs()).code,'DIRECTORY_OBSERVATION');
  const stopped=await dir('block',{id:'find',blocker:'prerequisite-unavailable',claim:'I found the input but the work is incomplete.'});
  assert.equal(stopped.code,'DIRECTORY_BLOCKER');
  assert.match(stopped.contentItems[0].text,/already found or read/);
  assert.equal((await dir('focus',{id:'find'})).success,true);
  const observed=await obs();assert.equal(observed.success,true,JSON.stringify(observed));
  const state=JSON.parse(observed.contentItems[0].text);assert.deepEqual(state.ready,['use']);
  assert.equal((await dir('focus',{id:'use'})).success,true);
  assert.equal((await dir('block',{id:'use',blocker:'no-viable-route',claim:'Offline replay ends here'})).success,true);
  assert.equal(Boolean(await o.onBeforeFinal({signal:o.signal})),false);
  return{output:'Found the local input; no other source was contacted.'};
 });
 for(const mode of ['off','on','maximal']){
  const run=engine.startRun({workflow:graph,input:{task:'Inspect input and another source',directoryActions:'on',directoryDiagnostics:mode}});
  await engine.executions.get(run.id);const result=engine.getRun(run.id);assert.equal(result.status,'completed',result.error);
  const ledger=await engine.actionDirectories.get(run.id,'Inspect input and another source');
  assert.equal(ledger.read().receipts.length,1);
  assert.equal(ledger.read().receipts[0].linkedByActionId,'find');
  if(mode==='maximal')assert(engine.runs.get(run.id).turnMachineTrace.head.some(e=>e.kind==='directory.mutation'&&e.metadata.linkedReadCount===1));
 }
});

test('one completed discovery step cannot turn a rejected extension into a successful final',async t=>{
 const{engine}=await setup(t,async o=>{
  let index=0;
  const dir=(action,args={})=>o.onToolCall({name:'relay_directory_action',callId:'append-'+ ++index,arguments:{action,...args}});
  const first={id:'find_profile',objective:'Find application materials',dependsOn:[]};
  const after={id:'find_jobs',objective:'Check a local synthetic posting',dependsOn:['find_profile']};
  assert.equal((await dir('plan',{actions:[first]})).success,true);
  assert.equal((await dir('focus',{id:first.id})).success,true);
  const read=await o.onToolCall({name:'relay_workspace',callId:'profile-list',arguments:{action:'list',path:'.'}});
  const [id]=read.contentItems.at(-1).text.match(/receipt-[0-9]+/);
  assert.equal((await dir('observe',{id:first.id,claim:'Located material',receipts:[id]})).success,true);
  const rejected=await dir('plan',{actions:[{...first,objective:'Rewrite attempted step'},after]});
  assert.equal(rejected.code,'DIRECTORY_RECORDED_ACTION');
  const repair=await o.onBeforeFinal({signal:o.signal});assert.equal(repair.continue,true);assert.match(repair.prompt,/existing outline is partial/);
  const add=await dir('plan',{actions:[after]});assert.equal(add.success,true,JSON.stringify(add));
  const state=JSON.parse(add.contentItems[0].text);assert.deepEqual(state.ready,[after.id]);assert.equal(state.actions[0].objective,first.objective);
  assert.equal((await dir('focus',{id:after.id})).success,true);
  const job=await o.onToolCall({name:'relay_workspace',callId:'posting-list',arguments:{action:'list',path:'.'}});
  const [evidence]=job.contentItems.at(-1).text.match(/receipt-[0-9]+/);
  assert.equal((await dir('observe',{id:after.id,claim:'Checked the synthetic source',receipts:[evidence]})).success,true);
  assert.equal(Boolean(await o.onBeforeFinal({signal:o.signal})),false);
  return{output:'Checked a fixture; no external effect.'};
 });
 const run=engine.startRun({workflow:graph,input:{task:'Find material and check a source',directoryActions:'on',directoryDiagnostics:'maximal'}});
 await engine.executions.get(run.id);
 const result=engine.getRun(run.id);assert.equal(result.status,'completed',result.error);assert.match(result.output,/Checked a fixture/);
});

test('Directory reports closed work separately from unready dependencies and resumes at a ready action',async t=>{
 const {engine}=await setup(t,async o=>{
  let i=0;
  const dir=(action,args={})=>o.onToolCall({name:'relay_directory_action',callId:'focus-recovery-'+ ++i,arguments:{action,...args}});
  const read=()=>o.onToolCall({name:'relay_workspace',callId:'evidence-'+ ++i,arguments:{action:'list',path:'.'}});
  const receipt=async()=>{const r=await read();assert.equal(r.success,true);return r.contentItems.at(-1).text.match(/receipt-\d+/)[0];};
  assert.equal((await dir('plan',{actions:[{id:'find_input',objective:'Locate the fixture',dependsOn:[]},{id:'find_source',objective:'Inspect the next source',dependsOn:['find_input']},{id:'do_work',objective:'Use the next source',dependsOn:['find_source']}]})).success,true);
  assert.equal((await dir('focus',{id:'find_input'})).success,true);
  const first=await receipt();
  assert.equal((await dir('observe',{id:'find_input',claim:'Located input',receipts:[first]})).success,true);
  const unassigned=await receipt();
  const repeat=await dir('observe',{id:'find_input',claim:'Repeated observation',receipts:[unassigned]});
  assert.equal(repeat.code,'DIRECTORY_OBSERVATION');assert.match(repeat.contentItems[0].text,/already observed.*Ready next actions: find_source/);
  const closed=await dir('focus',{id:'find_input'});
  assert.equal(closed.code,'DIRECTORY_ACTION_CLOSED');assert.match(closed.contentItems[0].text,/already observed.*Ready next actions: find_source/);
  const waiting=await dir('focus',{id:'do_work'});
  assert.equal(waiting.code,'DIRECTORY_NOT_READY');assert.match(waiting.contentItems[0].text,/waiting on find_source.*Ready next actions: find_source/);
  assert.equal((await dir('focus',{id:'find_source'})).success,true);
  assert.equal((await dir('observe',{id:'find_source',claim:'Inspected source',receipts:[await receipt()]})).success,true);
  assert.equal((await dir('focus',{id:'do_work'})).success,true);
  assert.equal((await dir('observe',{id:'do_work',claim:'Checked input',receipts:[await receipt()]})).success,true);
  assert.equal(Boolean(await o.onBeforeFinal({signal:o.signal})),false);
  return {output:'Completed fixture'};
 });
 const run=engine.startRun({workflow:graph,input:{task:'Reproduce failed focus, then continue',directoryActions:'on',directoryDiagnostics:'maximal'}});
 await engine.executions.get(run.id);
 const result=engine.getRun(run.id);assert.equal(result.status,'completed',result.error);
 const outcomes=engine.runs.get(run.id).turnMachineTrace.head.filter(e=>e.kind==='directory.mutation'&&e.metadata.phase==='rejected').map(e=>e.metadata);
 assert.deepEqual(outcomes.map(x=>[x.code,x.actionState,x.unmetDependencyCount,x.readyActionCount]),[
  ['DIRECTORY_OBSERVATION','observed',0,1],['DIRECTORY_ACTION_CLOSED','observed',0,1],['DIRECTORY_NOT_READY','pending',1,1]
 ]);
});

test('one extra Directory continuation after a verified milestone, but not for opening a source alone',async t=>{
 let scenarios=0;
 const{engine,root}=await setup(t,async o=>{
  const scenario=++scenarios;
  let i=0;
  const call=async(name,args)=>{
   const result=await o.onToolCall({name,arguments:args,callId:'continuation-'+(++i)});
   assert.equal(result.success,true,JSON.stringify(result));
   return result;
  };
  const dir=async args=>JSON.parse((await call('relay_directory_action',args)).contentItems[0].text);
  const review=()=>o.onBeforeFinal({signal:o.signal});
  await dir({action:'plan',actions:[{id:'profile',objective:'Locate the supplied fixture profile',dependsOn:[]},{id:'posting',objective:'Inspect the fixture posting',dependsOn:['profile']}]});
  await dir({action:'focus',id:'profile'});
  await call('relay_workspace',{action:'list',path:root});
  const first=await review();assert.equal(first.continue,true);
  if(scenario===3){
   await call('relay_workspace',{action:'list',path:root});
   await assert.rejects(review(),{code:'DIRECTORY_ACTION_UNFINISHED'});throw Object.assign(Error('no actual completion'),{code:'DIRECTORY_ACTION_UNFINISHED'});
  }
  let snapshot=await dir({action:'read'});
  await dir({action:'observe',id:'profile',claim:'Located the fixture profile; discovery step resolved',receipts:[snapshot.receipts.at(-1).id]});
  await dir({action:'focus',id:'posting'});
  await call('relay_workspace',{action:'list',path:root});
  const next=await review();assert.equal(next.continue,true);assert.match(next.prompt,/Inspect the fixture posting/);assert.match(next.prompt,/opening a source is not inspecting it/);assert.match(next.prompt,/Never repeat a confirmed or unknown effect/);
  if(scenario===2){
   await assert.rejects(review(),{code:'DIRECTORY_ACTION_UNFINISHED'});throw Object.assign(Error('no further progress'),{code:'DIRECTORY_ACTION_UNFINISHED'});
  }
  snapshot=await dir({action:'read'});
  await dir({action:'observe',id:'posting',claim:'Recorded evidence for the current fixture step',receipts:[snapshot.receipts.at(-1).id]});
  assert.equal(await review(),undefined);
  return{output:'Completed from fixture evidence'};
 });
 for(const expected of ['completed','failed','failed']){
  const run=engine.startRun({workflow:graph,input:{task:'Verify a local fixture handoff',directoryActions:'on'}});
  await engine.executions.get(run.id);assert.equal(engine.getRun(run.id).status,expected,engine.getRun(run.id).error);
 }
});
test('later observed milestones keep the workflow moving without accepting final prose as evidence',async t=>{
 const {engine,root}=await setup(t,async o=>{
  const names=['Locate applicant profile','Read source qualifications','Locate role posting','Check requirements','Prepare fields','Verify the intended target','Submit the test application','Read the confirmation'];
  const actions=names.map((objective,i)=>({id:'step_'+i,objective,dependsOn:i?['step_'+(i-1)]:[]}));
  let sequence=0;
  const call=async(name,args)=>{
   const result=await o.onToolCall({name,arguments:args,callId:'milestone-'+(++sequence)});
   assert.equal(result.success,true,JSON.stringify(result));
   return result;
  };
  const dir=async args=>JSON.parse((await call('relay_directory_action',args)).contentItems[0].text);
  const review=()=>o.onBeforeFinal({output:'This final answer is not evidence.',signal:o.signal});
  await dir({action:'plan',actions});
  assert.equal((await review()).continue,true);
  for(let i=0;i<actions.length;i++){
   const {id}=actions[i];
   await dir({action:'focus',id});
   await call('relay_workspace',{action:'list',path:root});
   const state=await dir({action:'read'});
   const receipt=state.receipts.at(-1);
   await dir({action:'observe',id,claim:'Completed scripted fixture milestone '+id,receipts:[receipt.id]});
   if(i<actions.length-1){
    const next=await review();
    assert.equal(next.continue,true);
    assert.match(next.prompt,/Never repeat a confirmed or unknown effect/);
   }
  }
  assert.equal(await review(),undefined);
  return {output:'Completed all eight scripted fixture milestones'};
 });
 const run=engine.startRun({workflow:graph,input:{task:'Complete the staged fixture workflow',directoryActions:'on'}});
 await engine.executions.get(run.id);
 const result=engine.getRun(run.id);
 assert.equal(result.status,'completed',result.error);
 const ledger=await engine.actionDirectories.get(run.id,'Fixture workflow');
 assert.equal(ledger.read().actions.filter(a=>a.state==='observed').length,8);
});

test('a finished source read gets one bounded Directory reconciliation turn, without completion by prose',async t=>{
 let scenario=0;
 const {engine,root}=await setup(t,async o=>{
  const current=++scenario;
  let sequence=0;
  const call=(name,args)=>o.onToolCall({name,arguments:args,callId:'reconcile-'+(++sequence)});
  const dir=async args=>{
   const response=await call('relay_directory_action',args);
   assert.equal(response.success,true,JSON.stringify(response));
   return JSON.parse(response.contentItems[0].text);
  };
  const review=()=>o.onBeforeFinal({output:'I inspected the posting.',signal:o.signal});
  await dir({action:'plan',actions:[{id:'posting',objective:'Inspect a source before deciding',dependsOn:[]}]});
  await dir({action:'focus',id:'posting'});
  assert.equal((await review()).continue,true);
  assert.equal((await call('relay_workspace',{action:'read',path:path.join(root,'posting.txt')})).success,true);
  const next=await review();
  assert.equal(next.continue,true);
  assert.match(next.prompt,/receipt-1/);
  assert.match(next.prompt,/do not reopen or reread/i);
  assert.match(next.prompt,/result list or snippet, open one promising source/);
  assert.match(next.prompt,/record the concrete reason and its receipt with note, then check a different option in this turn/);
  assert.match(next.prompt,/record a stable source locator and the facts the next step needs, observe the action with its receipts, and do the next ready step/);
  const state=await dir({action:'read'});
  assert.equal(state.actions[0].state,'active','A successful read is not an observed milestone.');
  if(current===1){
   await dir({action:'observe',id:'posting',claim:'Read the source and determined the first condition.',receipts:['receipt-1']});
   assert.equal(await review(),undefined);
   return {output:'Read and recorded the source.'};
  }
  assert.equal((await call('relay_workspace',{action:'read',path:path.join(root,'posting.txt')})).success,true);
  await assert.rejects(review(),{code:'DIRECTORY_ACTION_UNFINISHED'});
  throw Object.assign(Error('No recorded disposition'),{code:'DIRECTORY_ACTION_UNFINISHED'});
 });
 const {writeFile}=await import('node:fs/promises');
 await writeFile(path.join(root,'posting.txt'),'Fixture data for a source check.');
 for(const expected of ['completed','failed']){
  const run=engine.startRun({workflow:graph,input:{task:'Inspect a source',directoryActions:'on'}});
  await engine.executions.get(run.id);
  assert.equal(engine.getRun(run.id).status,expected,engine.getRun(run.id).error);
 }
});

test('an unsuitable option is recorded without closing a shared prerequisite',async t=>{
 const {engine,root}=await setup(t,async o=>{
  const dir=(action,args={})=>o.onToolCall({name:'relay_directory_action',callId:'dir-'+action,arguments:{action,...args}});
  const state=r=>{assert.equal(r.success,true,JSON.stringify(r));return JSON.parse(r.contentItems[0].text);};
  state(await dir('plan',{actions:[{id:'source',objective:'Find a usable source',dependsOn:[]},{id:'use',objective:'Use it',dependsOn:['source']}]}));
  state(await dir('focus',{id:'source'}));
  assert.equal((await o.onBeforeFinal({signal:o.signal})).continue,true);
  const failed=await o.onToolCall({name:'relay_workspace',arguments:{action:'list',path:path.join(root,'missing')},callId:'missing-source'});
  assert.equal(failed.success,false);
  const withFailed=state(await dir('read'));
  const receipt=withFailed.receipts.at(-1).id;
  assert.equal((await dir('block',{id:'source',claim:'First source is missing'})).code,'DIRECTORY_BLOCKER');
  const noted=state(await dir('note',{id:'source',claim:'First source is missing; try the working folder',receipts:[receipt]}));
  assert.equal(noted.focus,'source');
  assert.deepEqual(noted.actions[0].notes[0].receipts,[receipt]);
  assert.deepEqual(noted.dependencyBlocked,[]);
  assert.equal((await dir('note',{id:'source',claim:'Same evidence',receipts:[receipt]})).code,'DIRECTORY_NOTE');
  const continuation=await o.onBeforeFinal({signal:o.signal});
  assert.equal(continuation.continue,true);
  assert.match(continuation.prompt,/recorded a new finding.*receipt-1/);
  await assert.rejects(()=>o.onBeforeFinal({signal:o.signal}),{code:'DIRECTORY_ACTION_UNFINISHED'});
  const valid=await o.onToolCall({name:'relay_workspace',arguments:{action:'list',path:root},callId:'alternate-source'});
  assert.equal(valid.success,true);
  const found=state(await dir('read')).receipts.at(-1).id;
  assert.deepEqual(state(await dir('observe',{id:'source',claim:'A usable source was located',receipts:[found]})).ready,['use']);
  state(await dir('focus',{id:'use'}));
  await o.onToolCall({name:'relay_workspace',arguments:{action:'list',path:root},callId:'use-source'});
  const used=state(await dir('read')).receipts.at(-1).id;
  state(await dir('observe',{id:'use',claim:'The alternative was used',receipts:[used]}));
  return{output:'Used the alternative source'};
 });
 const run=engine.startRun({workflow:graph,input:{task:'Find and use a source',directoryActions:'on'}});
 await engine.executions.get(run.id);
 const result=engine.getRun(run.id);
 assert.equal(result.status,'completed',result.error);
 assert.equal(result.nodes.a.directoryOutcome,undefined);
});

test('a verified dead route gets one chance to use another allowed option before final',async t=>{
 const {engine,root}=await setup(t,async o=>{
  let sequence=0;
  const call=(name,args)=>o.onToolCall({name,arguments:args,callId:'route-'+(++sequence)});
  const dir=(action,args)=>call('relay_directory_action',{action,...args});
  const state=r=>{assert.equal(r.success,true,JSON.stringify(r));return JSON.parse(r.contentItems[0].text);};
  state(await dir('plan',{actions:[{id:'first',objective:'Check first route',dependsOn:[]},{id:'deliver',objective:'Deliver the result',dependsOn:['first']}]}));
  state(await dir('focus',{id:'first'}));
  const unavailable=await call('relay_workspace',{action:'list',path:path.join(root,'not-present')});
  assert.equal(unavailable.success,false);
  state(await dir('block',{id:'first',blocker:'no-viable-route',claim:'This route is unavailable.',receipts:['receipt-1']}));
  const review=await o.onBeforeFinal({signal:o.signal});
  assert.equal(review.continue,true);
  assert.match(review.prompt,/another option/);
  assert.equal(await o.onBeforeFinal({signal:o.signal}),undefined,'No endless review once the blocked route has been checked');
  assert.equal(state(await dir('read')).actions.find(row=>row.id==='first').state,'blocked');
  state(await dir('plan',{actions:[{id:'alternate',objective:'Use another route',dependsOn:[]}]}));
  state(await dir('focus',{id:'alternate'}));
  assert.equal((await call('relay_workspace',{action:'list',path:root})).success,true);
  state(await dir('observe',{id:'alternate',claim:'The alternate source was available.',receipts:['receipt-2']}));
  assert.equal(await o.onBeforeFinal({signal:o.signal}),undefined);
  return {output:'Used the alternate source.'};
 });
 const run=engine.startRun({workflow:graph,input:{task:'Find a usable source',directoryActions:'on'}});
 await engine.executions.get(run.id);
 assert.equal(engine.getRun(run.id).status,'completed',engine.getRun(run.id).error);
});
test('Directory returns once for a newly delivered checked block while an independent action is ready',async t=>{
 for(const scenario of ['delivered','wire-no-success-flag','wire-explicit-failure','undelivered','projected','failed-evidence','no-independent','no-progress','exhausted']){
  await t.test(scenario,async subt=>{
   const {engine,root}=await setup(subt,async o=>{
    let n=0;
    const dir=async(args,{deliver=true,projected=false}={})=>{
     const call={name:'relay_directory_action',arguments:args,callId:'dir-block-'+(++n)};
     const result=await o.onToolCall(call);
     assert.equal(result.success,true,JSON.stringify(result));
     if(deliver){
      const delivered=projected?{...result,contentItems:[{type:'inputText',text:'projected'}]}:result;
      if(args.action==='block'&&scenario==='wire-no-success-flag')delete delivered.success;
      if(args.action==='block'&&scenario==='wire-explicit-failure')delivered.success=false;
      o.onToolResultDelivered({call,result:delivered});
     }
     return JSON.parse(result.contentItems[0].text);
    };
    const review=()=>o.onBeforeFinal({signal:o.signal});
    const actions=[{id:'primary',objective:'Check that the primary source exposes the needed record',dependsOn:[]},
     {id:'alternative',objective:'Check the alternative source',dependsOn:scenario==='no-independent'?['primary']:[]}];
    if(scenario==='exhausted')actions.push({id:'third',objective:'Check the third source',dependsOn:[]});
    await dir({action:'plan',actions});
    await dir({action:'focus',id:'primary'});
    assert.equal((await review()).continue,true);
    if(scenario==='no-progress')return review();
    const check=await o.onToolCall({name:'relay_workspace',arguments:{action:'list',path:scenario==='failed-evidence'?path.join(root,'missing'):root},callId:'source-check'});
    assert.equal(check.success,scenario!=='failed-evidence');
    const discovered=await dir({action:'read'});
    const blocked=await dir({action:'block',id:'primary',blocker:'prerequisite-unavailable',claim:'The checked source has no required record',receipts:[discovered.receipts.at(-1).id]},{deliver:scenario!=='undelivered',projected:scenario==='projected'});
    assert.equal(blocked.focus,null);
    if(scenario==='no-independent'){
     assert.deepEqual(blocked.ready,[]);
     assert.equal(await review(),undefined);
     return{output:'The primary source blocks the dependent work.'};
    }
    assert.deepEqual(blocked.ready,scenario==='exhausted'?['alternative','third']:['alternative']);
    if(['undelivered','projected','failed-evidence','wire-explicit-failure'].includes(scenario))return review();
    const next=await review();
    assert.equal(next.continue,true);
    assert.match(next.prompt,/independent ready action/);
    assert.match(next.prompt,/do not repeat the blocked action/i);
    await dir({action:'focus',id:'alternative'});
    assert.equal((await o.onToolCall({name:'relay_workspace',arguments:{action:'list',path:root},callId:'alternate-check'})).success,true);
    const alternative=await dir({action:'read'});
    if(scenario==='exhausted'){
     const checked=await dir({action:'block',id:'alternative',blocker:'prerequisite-unavailable',claim:'The alternative has no required record',receipts:[alternative.receipts.at(-1).id]});
     assert.deepEqual(checked.ready,['third']);
     return review();
    }
    await dir({action:'observe',id:'alternative',claim:'Verified the alternative source',receipts:[alternative.receipts.at(-1).id]});
    assert.equal(await review(),undefined);
    return{output:'The independently verified alternative was checked.'};
   });
   const run=engine.startRun({workflow:graph,input:{task:'Check both routes',directoryActions:'on',directoryDiagnostics:scenario==='delivered'?'maximal':'off'}});
   await engine.executions.get(run.id);
   const settled=engine.getRun(run.id);
   if(['no-progress','undelivered','projected','failed-evidence','exhausted','wire-explicit-failure'].includes(scenario)){
    assert.equal(settled.errorCode,'DIRECTORY_ACTION_UNFINISHED');
   }else{
    assert.equal(settled.status,'completed',settled.error);
    assert.equal(settled.nodes.a.directoryOutcome,'incomplete','Reporting a blocked history is not task completion');
    assert.equal(settled.events.filter(row=>row.data?.type==='directory.final'&&row.data?.phase==='continue-after-checked-block').length,scenario==='delivered'?1:0);
   }
  });
 }
});
