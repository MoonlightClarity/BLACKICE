import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {TaskStateStore} from '../lib/task-state.mjs';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {createNativePlanningTools} from '../lib/native-planning-tools.mjs';
import {planningModuleTemplate} from '../public/planning-browser-model.mjs';
const payload=r=>JSON.parse(r.contentItems.find(i=>i.type==='inputText').text);
const graph=()=>({id:'native-graph-test',name:'Native graph',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'test-model',prompt:'Develop the shared graph.'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{planningMode:'off'}});
async function fixture(t,execute){
 const dir=await mkdtemp(path.join(tmpdir(),'native-graph-'));await mkdir(path.join(dir,'work'));
 const store=await new PlanningBrowserStore({dataDir:dir}).init(),events=[];
 const provider=createNativePlanningTools({store,onChange:event=>events.push(event)});
 class Runtime extends EventEmitter{status(){return {connected:true,authenticated:true,defaultModel:'test-model'};} async runAgent(o){return execute(o);}async close(){}}
 const engine=await new HarnessEngine({runtime:new Runtime(),dataDir:dir,defaultCwd:path.join(dir,'work'),nativePlanningTools:provider}).init();
 engine.runtimeSettings={get:()=>({executionGuardrails:false,subagentsEnabled:true,maxSubagents:2})};
 t.after(async()=>{await engine.close();await store.close();await rm(dir,{recursive:true,force:true});});
 return {store,engine,provider,events,async run(){const r=engine.startRun({workflow:graph(),input:'Develop this conversation graph.',planningMode:'off'});await engine.executions.get(r.id);const done=engine.getRun(r.id);assert.equal(done.status,'completed',JSON.stringify(done));return done;}};
}
test('native coordinator dispatch uses shared graph with honest provenance and UI reverse edits',async t=>{
 let f,seq=0;
 f=await fixture(t,async o=>{
  assert.ok(o.dynamicTools.some(v=>v.name==='relay_planning_read'));for(const tool of o.dynamicTools.filter(v=>v.name.startsWith('relay_planning_')))assert.equal(tool.type,'function');assert.ok(o.dynamicTools.some(v=>v.name==='relay_planning_write'));
  const send=async(action,args={},name='relay_planning_write')=>{const r=await o.onToolCall({name,arguments:{requestId:'native-'+(++seq),action,...args}});assert.equal(r.success,true,JSON.stringify(r));return payload(r);};
  await send('create_request',{graphRequestId:'own',title:'Shared reasoning',objective:'Compare alternatives with recorded evidence.'});
  await send('add_module',{graphRequestId:'own',nodeId:'frame',kind:'frame',title:'Frame choices',prompt:'What choices are supported?'});
  let saved=await f.store.get('own');assert.equal(saved.provenance.kind,'supervising_model');
  await f.store.updateNode('own','frame',{title:'Human corrected title'},{expectedNodeRevision:1,actor:{type:'human',id:'user'}});
  assert.equal((await send('get',{graphRequestId:'own',nodeId:'frame'},'relay_planning_read')).node.title,'Human corrected title');
  const source=await send('add_source',{graphRequestId:'own',title:'Native observation',text:'A fictional local source for this test.'});
  assert.equal(source.source.provenance.kind,'supervising_model');assert.equal(source.source.verified,false);
  const fields=planningModuleTemplate('frame').fields;
  await send('record_response',{graphRequestId:'own',nodeId:'frame',expectedNodeRevision:2,values:Object.fromEntries(fields.map(v=>[v.id,'Synthetic contribution: '+v.label])),grounding:fields.filter(v=>v.grounding==='required').map(v=>({field:v.id,sourceId:source.source.id})),openQuestions:[],challengeResponses:[]});
  saved=await f.store.get('own');assert.equal(saved.responses[0].provenance.kind,'supervising_model');assert.equal(saved.responses[0].verifiedAction,false);assert.equal(saved.attempts.length,0);assert.equal(saved.responses[0].provenance.receipt,undefined);
  return {output:'Graph saved.',threadId:'native-test-thread'};
 });
 const run=await f.run();assert.equal((await f.store.get('own')).conversationId,run.taskId||run.id);assert.ok(f.events.length>=4);
 const restored=f.engine.nativeHistoryDescription(run,run.workflow.nodes.find(n=>n.id==='agent'),run.nodes.agent,'fixture');assert.ok(restored.dynamicTools.some(t=>t.name==='relay_planning_write'));
});
test('native graph adapter rejects cross-conversation access, forged metadata and read-only writes',async t=>{
 const f=await fixture(t,async()=>({output:'unused'}));
 await f.store.create({id:'other',conversationId:'other-task',title:'Private',objective:'Unrelated objective'});
 const adapter=await f.provider({taskId:'own-task',runId:'run',nodeId:'agent'});
 for(const args of [{action:'get',graphRequestId:'other'},{action:'list',conversationId:'other-task'}])
  await assert.rejects(adapter.handle({name:'relay_planning_read',arguments:{requestId:'read',...args}}),{code:'NATIVE_PLANNING_SCOPE'});
 await assert.rejects(adapter.handle({name:'relay_planning_write',arguments:{requestId:'write',action:'update_module',graphRequestId:'other',nodeId:'x',expectedNodeRevision:1,title:'Overwrite'}}),{code:'NATIVE_PLANNING_SCOPE'});
 const list=payload(await adapter.handle({name:'relay_planning_read',arguments:{requestId:'list',action:'list'}}));assert.equal(list.requests.total,0);assert.equal(list.conversations.total,0);
 await assert.rejects(adapter.handle({name:'relay_planning_write',arguments:{requestId:'spoof',action:'create_request',title:'X',objective:'Y',actor:{type:'human',id:'user'}}}),{code:'NATIVE_PLANNING_INVALID'});
 const ro=await f.provider({taskId:'own-task',runId:'run',nodeId:'agent',canWrite:false});assert.deepEqual(ro.tools.map(v=>v.name),['relay_planning_read']);
 await assert.rejects(ro.handle({name:'relay_planning_write',arguments:{}}),{code:'NATIVE_PLANNING_SCOPE'});
});
test('new native graph tools do not silently expand a saved provider catalog',async t=>{
 let turns=0;
 const f=await fixture(t,async o=>{
  turns++;
  if(turns===1)assert.ok(!o.dynamicTools.some(v=>v.name==='relay_planning_read'));
  else {assert.ok(!o.dynamicTools.some(v=>v.name==='relay_planning_read'));const denied=await o.onToolCall({name:'relay_planning_read',arguments:{requestId:'not-attached',action:'list'}});assert.equal(denied.success,false);assert.equal(denied.code,'NATIVE_PLANNING_UNAVAILABLE');}
  return {output:'Done.',threadId:'native-catalog-thread'};
 });
 f.engine.nativePlanningTools=null;const first=await f.run();f.engine.nativePlanningTools=f.provider;
 const next=f.engine.continueRun(first.id,{nodeId:'agent',message:'Continue the saved chat.'});await f.engine.executions.get(next.id);
 assert.equal(f.engine.getRun(next.id).status,'completed');assert.equal(turns,2);
});
test('delegated native workers never receive graph coordinator tools',async t=>{
 let child=false;
 const f=await fixture(t,async o=>{
  if(o.prompt.startsWith('You are a short-lived BLACKICE subagent.')){child=true;assert.ok(!o.dynamicTools.some(v=>v.name.startsWith('relay_planning_')));return {output:'Independent analysis.'};}
  const result=await o.onToolCall({name:'relay_delegate',arguments:{tasks:[{id:'research',prompt:'Analyze the attached coordinator-tool boundary without actions.'},{id:'instructions',prompt:'Independently analyze the supplied worker instructions without actions.'}]}});
  assert.equal(result.success,true,JSON.stringify(result));return {output:'Delegated result checked.'};
 });
 await f.run();assert.equal(child,true);
});

test('secondary workflow agents cannot call native Planning coordinator tools',async t=>{
 let calls=0;
 const f=await fixture(t,async o=>{calls++;if(calls===1)assert.ok(o.dynamicTools.some(v=>v.name==='relay_planning_write'));
 else {assert.ok(!o.dynamicTools.some(v=>v.name.startsWith('relay_planning_')));const denied=await o.onToolCall({name:'relay_planning_read',arguments:{requestId:'deny',action:'list'}});assert.equal(denied.success,false);}
 return {output:'Independent node complete.'};});
 const workflow=graph();workflow.nodes.splice(2,0,{id:'worker',type:'agent',model:'test-model',prompt:'Analyze a delegated branch.'});workflow.edges=[{source:'input',target:'agent'},{source:'agent',target:'worker'},{source:'worker',target:'output'}];
 const r=f.engine.startRun({workflow,input:'Develop a graph with an independent branch.',planningMode:'off'});await f.engine.executions.get(r.id);assert.equal(f.engine.getRun(r.id).status,'completed');assert.equal(calls,2);
});
test('optional analytical module adapter receives trusted native context and cannot cross conversations',async t=>{
 const f=await fixture(t,async()=>({output:'unused'}));await f.store.create({id:'own-module',conversationId:'own-task',title:'Own',objective:'Own work'});
 const calls=[],extra={definition:{name:'blackice_planning_module',mutating:true,inputSchema:{type:'object',properties:{requestId:{type:'string'},action:{enum:['run','cancel']},graphRequestId:{type:'string'},nodeId:{type:'string'}},required:['requestId','action','graphRequestId','nodeId'],additionalProperties:false}},execute:async(args,context)=>{calls.push({args,context});return {success:true,contentItems:[{type:'inputText',text:'{}'}]};}};
 const provider=createNativePlanningTools({store:f.store,extraTools:[extra]}),adapter=await provider({taskId:'own-task',runId:'run-real',nodeId:'agent-real'});
 assert.ok(adapter.tools.some(v=>v.name==='relay_planning_module'));
 await adapter.handle({name:'relay_planning_module',arguments:{requestId:'stable',action:'run',graphRequestId:'own-module',nodeId:'frame'}});
 assert.equal(calls[0].context.client,undefined);assert.equal(calls[0].context.nativeContext.runId,'run-real');assert.match(calls[0].context.nativeContext.clientRequestId,/^native:[a-f0-9]{64}$/);
 await f.store.create({id:'other-module',conversationId:'other-task',title:'Other',objective:'Other work'});
 await assert.rejects(adapter.handle({name:'relay_planning_module',arguments:{requestId:'foreign',action:'run',graphRequestId:'other-module',nodeId:'frame'}}),{code:'NATIVE_PLANNING_SCOPE'});assert.equal(calls.length,1);
});
test('native task reads append bounded direct evidence without mutating canonical or delivery state',async t=>{
 let f,called=false;
 f=await fixture(t,async o=>{
  const result=await o.onToolCall({name:'relay_task',arguments:{action:'read'}});
  assert.equal(result.success,true);const state=payload(result);assert.notEqual(state.revision,999999);assert.equal(state.directExecution,undefined);
  const extra=result.contentItems.map(v=>{try{return JSON.parse(v.text);}catch{return null;}}).find(v=>v?.directExecution);
  assert.equal(extra.directExecution.confirmedCount,1);assert.match(extra.reading,/does not change canonical completion/);
  const persisted=await f.engine.tasks.get(state.taskId);assert.notEqual(persisted.revision,999999);assert.equal(persisted.directExecution,undefined);
  return {output:'Evidence observed.'};
 });
 const tasks=await new TaskStateStore({dataDir:f.engine.dataDir}).init();f.engine.tasks=tasks;t.after(()=>tasks.close());
 f.engine.projectPlanningState=async state=>{called=true;state.revision=999999;state.directExecution={confirmedCount:1,unknownCount:1};return state;};
 await f.run();assert.equal(called,true);
});

for(const mismatch of ['reread_revision','projected_revision','projected_task'])test('native evidence projection fails closed on '+mismatch,async t=>{
 let f,projected=0,deliveredBefore,changed=false;
 f=await fixture(t,async o=>{
  const tasks=f.engine.tasks,get=tasks.get.bind(tasks);let reads=0;
  tasks.get=async(id,options)=>{
   reads++;
   if(mismatch==='reread_revision'&&reads===2){
    const current=await get(id,options);
    await tasks.update(id,state=>({...state,goal:state.goal+' Concurrent revision.'}),{expectedRevision:current.revision,source:'user'});
    changed=true;
   }
   const value=await get(id,options);if(reads===1)deliveredBefore=value;return value;
  };
  let result;try{result=await o.onToolCall({name:'relay_task',arguments:{action:'read'}});}finally{tasks.get=get;}
  assert.equal(result.success,true);const delivered=payload(result);
  assert.equal(delivered.taskId,deliveredBefore.taskId);assert.equal(delivered.revision,deliveredBefore.revision);assert.equal(delivered.directExecution,undefined);
  const extra=result.contentItems.map(v=>{try{return JSON.parse(v.text);}catch{return null;}}).find(v=>v?.directExecution);
  assert.deepEqual(extra.directExecution,{available:false,error:'PROJECTION_SNAPSHOT_CHANGED'});
  if(mismatch==='reread_revision'){assert.equal(changed,true);assert.equal(projected,0);assert.ok((await get(delivered.taskId)).revision>delivered.revision);}
  else assert.equal(projected,1);
  return {output:'Snapshot race preserved as unavailable evidence.'};
 });
 const tasks=await new TaskStateStore({dataDir:f.engine.dataDir}).init();f.engine.tasks=tasks;t.after(()=>tasks.close());
 f.engine.projectPlanningState=async state=>{projected++;return {...state,directExecution:{available:true,confirmedCount:1,sourceStatus:'current',currentSource:{taskId:mismatch==='projected_task'?'another-task':state.taskId,revision:state.revision+(mismatch==='projected_revision'?1:0)}}};};
 await f.run();
});


test('read-only native coordinator can inspect every graph view while all mutations remain denied',async t=>{
 let f,observed=false;
 f=await fixture(t,async o=>{
  assert.equal(o.sandbox,'read-only');
  const tool=o.dynamicTools.find(value=>value.name==='relay_planning_read');assert.ok(tool);
  assert.ok(!o.dynamicTools.some(value=>['relay_planning_write','relay_planning_module'].includes(value.name)));
  const run=[...f.engine.runs.values()].at(-1),conversationId=run.taskId||run.id;
  await f.store.create({id:'read-only-own',conversationId,title:'Read-only fixture',objective:'Inspect saved evidence without changing it.'});
  await f.store.addNode('read-only-own',{id:'frame',kind:'frame',title:'Saved frame',prompt:'Read the recorded facts.'},{actor:{type:'human',id:'fixture'}});
  await f.store.addSource('read-only-own',{title:'Saved fact',text:'An inert source for the read-only fixture.'},{actor:{type:'human',id:'fixture'}});
  const before=await f.store.get('read-only-own');
  const cases={
   list:{},templates:{},get:{graphRequestId:'read-only-own',nodeId:'frame'},
   program:{graphRequestId:'read-only-own'},attempts:{graphRequestId:'read-only-own',nodeId:'frame'},
   source:{graphRequestId:'read-only-own',sourceId:before.sources[0].id},
   response_history:{graphRequestId:'read-only-own',nodeId:'frame'},
  };
  assert.deepEqual(tool.inputSchema.oneOf.map(value=>value.properties.action.const).sort(),Object.keys(cases).sort());
  for(const [action,args] of Object.entries(cases)){
   const result=await o.onToolCall({name:'relay_planning_read',arguments:{requestId:'read-only-'+action,action,...args}});
   assert.equal(result.success,true,JSON.stringify({action,result}));
  }
  for(const [name,action] of [['relay_planning_write','update_module'],['relay_planning_module','run'],['relay_planning_module','cancel'],['relay_planning_read','update_module']]){
   const result=await o.onToolCall({name,arguments:{requestId:'denied-'+action,action,graphRequestId:'read-only-own',nodeId:'frame',expectedNodeRevision:1,title:'Must not change'}});
   assert.equal(result.success,false);assert.equal(result.code,'TASK_PLAN_READ_ONLY');assert.equal(payload(result).actionDispatched,false);
  }
  assert.deepEqual(await f.store.get('read-only-own'),before);assert.equal(f.events.length,0);observed=true;
  return {output:'Saved graph inspected without mutations.'};
 });
 // Workflow admission normalizes ordinary agents to full access. Inject the host's
 // independent read-only execution configuration without changing that policy.
 const execute=f.engine.execute.bind(f.engine);
 f.engine.execute=(run,controller)=>{run.workflow.nodes.find(node=>node.id==='agent').sandbox='read-only';return execute(run,controller);};
 const workflow=graph();
 const run=f.engine.startRun({workflow,input:'Inspect the shared graph read-only.',planningMode:'off'});
 await f.engine.executions.get(run.id);assert.equal(f.engine.getRun(run.id).status,'completed',JSON.stringify(f.engine.getRun(run.id)));
 assert.equal(observed,true);
});

for(const mode of ['off','advisory'])for(const available of [false,true])test(`native control schemas follow service availability, not Planning ${mode}: service ${available}`,async t=>{
 let observed;
 const f=await fixture(t,async o=>{observed=o.dynamicTools.find(tool=>tool.name==='relay_control');return {output:'Catalog inspected.',threadId:'availability-thread'};});
 if(available)f.engine.responseCycle={forRun:async()=>({skipped:true})};
 const workflow=graph();workflow.settings.planningMode=mode;
 const initial=f.engine.startRun({workflow,input:'Inspect available controls.',planningMode:mode});await f.engine.executions.get(initial.id);
 const saved=f.engine.getRun(initial.id);assert.equal(saved.status,'completed',JSON.stringify(saved));
 const canonical=tool=>(tool.inputSchema.properties.cycle.properties.plan.anyOf||[]).some(schema=>schema.properties.contract);
 assert.equal(canonical(observed),available);assert.equal(saved.nodes.agent.controlSchemaVersion,available?12:11);
 const restored=f.engine.nativeHistoryDescription(saved,saved.workflow.nodes.find(n=>n.id==='agent'),saved.nodes.agent,'fixture');
 assert.equal(canonical(restored.dynamicTools.find(tool=>tool.name==='relay_control')),available);
 // An existing native provider session keeps its admitted schema even if the
 // host's service availability changes between turns.
 f.engine.responseCycle=available?null:{forRun:async()=>({skipped:true})};
 const next=f.engine.continueRun(saved.id,{nodeId:'agent',message:'Continue with the saved native catalog.'});await f.engine.executions.get(next.id);
 assert.equal(f.engine.getRun(next.id).status,'completed',JSON.stringify(f.engine.getRun(next.id)));
 assert.equal(canonical(observed),available);assert.equal(f.engine.getRun(next.id).nodes.agent.controlSchemaVersion,available?12:11);
});
