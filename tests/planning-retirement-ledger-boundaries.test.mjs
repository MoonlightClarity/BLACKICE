import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DirectExecutionAPI} from '../lib/direct-execution-api.mjs';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime} from '../lib/planning-browser-runtime.mjs';
import {isLegacyPlanningRequest} from '../public/planning-browser-model.mjs';

const retired={code:'PLANNING_CYCLE_RETIRED',status:410};
const client={id:'retirement-client',kind:'chatgpt',scopes:['read','planning:write','commands:run']};
async function fixture(t){
 const dataDir=await mkdtemp(path.join(tmpdir(),'planning-retirement-ledger-'));
 const store=await new PlanningBrowserStore({dataDir}).init();
 let calls=0;
 const runner=new PlanningBrowserRuntime({store,runtime:{runAgent:async()=>{calls++;throw Error('No provider call expected');}},defaultCwd:dataDir,getSettings:()=>({maxSubagents:2,subagentsEnabled:false})});
 t.after(async()=>{await runner.close();await store.close();await rm(dataDir,{recursive:true,force:true});});
 await store.create({id:'archive',conversationId:'conversation',title:'Synthetic archive',objective:'Retain history without new work.',cwd:dataDir});
 await store.addNode('archive',{id:'frame',kind:'frame',title:'Original frame'});
 return {dataDir,store,runner,writer:store.runtimeWriter(),calls:()=>calls};
}
async function archive(store,patch={responseCycle:{version:1,rootCycleId:'legacy-cycle',cycles:[]}}){
 const raw=JSON.parse(await readFile(store.file('archive'),'utf8'));Object.assign(raw,patch);store._validate(raw);
 await writeFile(store.file('archive'),JSON.stringify(raw));return raw;
}
test('archive classification relies on orchestration metadata, not reused modular kinds or caller IDs',()=>{
 for(const graph of [{nodes:[{id:'cycle-old',kind:'cycle'}]}, {nodes:[{id:'plan',kind:'plan'}]}, {responseCycle:{cycles:[]}}])assert.equal(isLegacyPlanningRequest(graph),false);
 for(const graph of [{planningExecutionMode:'plan_only'},{diagnostic:{}},{viability:{definition:{}}},{responseCycle:{rootCycleId:'old'}},{responseCycle:{cycles:[{stageNodeIds:{inference:'i'}}]}}])assert.equal(isLegacyPlanningRequest(graph),true);
});
test('archived edits, XML marker erasure, fresh module/reviewer/repair admission are rejected while saved idempotent receipts remain readable',async t=>{
 const f=await fixture(t),options={expectedNodeRevision:1,clientRequestId:'saved-title'};
 await f.store.updateNode('archive','frame',{title:'Saved frame'},options);
 const attempt=await f.writer.beginAttempt('archive','frame',{ownerId:'saved-owner',expectedNodeRevision:2,clientRequestId:'old-attempt'});
 await f.writer.fail('archive',attempt.attempt.id,{message:'Saved rejected output',partialOutput:'{',validation:{code:'FIXTURE_INVALID',message:'Saved malformed output',issues:[]}});
 const raw=await archive(f.store),before=await readFile(f.store.file('archive'),'utf8');
 const replay=await f.store.updateNode('archive','frame',{title:'Saved frame'},options);assert.equal(replay.nodes[0].title,'Saved frame');
 const operations=[
  ()=>f.store.updateNode('archive','frame',{title:'Overwrite archive'},{expectedNodeRevision:2}),
  ()=>f.store.addNode('archive',{id:'child',kind:'frame',title:'New work'}),
  ()=>f.store.updateProgram('archive',{xml:raw.programXml.replace('Saved frame','Erase marker'),expectedRevision:raw.revision}),
  ()=>f.store.addSource('archive',{title:'Fresh discovery',text:'New evidence'}),
  ()=>f.writer.beginAttempt('archive','frame',{ownerId:'saved-owner',expectedNodeRevision:2,clientRequestId:'new-attempt'}),
  ()=>f.writer.beginChildAdmission('archive','frame',{ownerId:'saved-owner'}),
  ()=>f.writer.beginRepairAttempt('archive',attempt.attempt.id),
  ()=>f.runner.start({requestId:'archive',nodeId:'frame',expectedNodeRevision:2,automatic:false,clientRequestId:'new-runtime'})
 ];
 for(const operation of operations)await assert.rejects(operation,retired);
 assert.equal(await readFile(f.store.file('archive'),'utf8'),before);assert.equal(f.calls(),0);assert.equal(f.runner.status().activeCount,0);
 const reopened=await new PlanningBrowserStore({dataDir:f.dataDir}).init();try{assert.equal((await reopened.get('archive')).attempts[0].status,'failed');await assert.rejects(()=>reopened.addNode('archive',{kind:'frame',title:'After reopen'}),retired);}finally{await reopened.close();}
 assert.equal(await readFile(f.store.file('archive'),'utf8'),before);
});
test('retirement does not block cancellation intent and honest settlement of already admitted historical work',async t=>{
 const f=await fixture(t),started=await f.writer.beginAttempt('archive','frame',{ownerId:'prior-runtime',expectedNodeRevision:1,clientRequestId:'prior-attempt'});
 await archive(f.store);
 await f.writer.requestCancellation('archive','frame',started.attempt.id,{clientRequestId:'stop-prior',reason:'Stop already admitted work.'});
 const settled=await f.writer.cancel('archive',started.attempt.id,{reason:'Runtime confirmed cancellation.'});
 assert.equal(settled.attempts[0].status,'cancelled');assert.equal(settled.attempts[0].message,'Runtime confirmed cancellation.');
 const before=await readFile(f.store.file('archive'),'utf8');await f.writer.cancel('archive',started.attempt.id,{reason:'Repeated settlement does not overwrite history.'});
 assert.equal(await readFile(f.store.file('archive'),'utf8'),before);assert.equal(f.calls(),0);
});
test('retired direct cycle calls recover exact durable receipts across reopen but never enqueue or redispatch',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'planning-retired-direct-'));let api;
 t.after(async()=>{await api?.close();await rm(dataDir,{recursive:true,force:true});});
 api=await new DirectExecutionAPI({dataDir,allowedRoot:dataDir}).init();
 const tool='blackice_planning_cycle',args={requestId:'old-cycle-request',action:'run',graphRequestId:'archive',cycleId:'old-cycle',expectedRequestRevision:4};
 const admitted=await api.jobs.admit({ownerId:client.id,requestId:args.requestId,tool,arguments:args,requiredScopes:['commands:run','planning:write'],client,mutating:true});
 await api.jobs.update(admitted.job.id,()=>({status:'failed',finishedAt:new Date().toISOString(),error:{code:'SAVED_FAILURE',message:'Original failure retained.'},dispatched:true}));
 const original=await readFile(api.jobs.file(admitted.job.id),'utf8');let enqueues=0;
 const originalAdmit=api.jobs.admit.bind(api.jobs);api.jobs.admit=(...values)=>{enqueues++;return originalAdmit(...values);};
 assert.ok(!api.tools(client).some(item=>item.name===tool));
 for(let i=0;i<3;i++){const replay=await api.call(tool,args,client);assert.equal(replay.jobId,admitted.job.id);assert.equal(replay.existing,true);assert.equal(replay.status,'failed');}
 await assert.rejects(()=>api.call(tool,{...args,cycleId:'different'},client),{code:'DIRECT_REQUEST_CONFLICT'});
 await assert.rejects(()=>api.call(tool,{...args,requestId:'new-cycle-request'},client),retired);
 await assert.rejects(()=>api.call(tool,args,{...client,id:'other-principal'}),retired);
 assert.equal(enqueues,0);assert.equal((await api.getJob(admitted.job.id,client)).error.code,'SAVED_FAILURE');assert.equal(await readFile(api.jobs.file(admitted.job.id),'utf8'),original);
 await api.close();api=await new DirectExecutionAPI({dataDir,allowedRoot:dataDir}).init();
 const replay=await api.call(tool,args,client);assert.equal(replay.jobId,admitted.job.id);assert.equal(replay.existing,true);
 assert.equal(await readFile(api.jobs.file(admitted.job.id),'utf8'),original);assert.deepEqual(await api.jobs.counts({ownerId:client.id}),{total:1,unfinished:0});
});
test('an in-memory queued retired cycle is rejected before generic workspace preparation',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'planning-retired-queued-'));
 const api=await new DirectExecutionAPI({dataDir,allowedRoot:dataDir}).init();
 t.after(async()=>{await api.close();await rm(dataDir,{recursive:true,force:true});});
 const tool='blackice_planning_cycle',args={requestId:'queued-old-cycle',action:'run',graphRequestId:'archive',cycleId:'old-cycle'};
 const admitted=await api.jobs.admit({ownerId:client.id,requestId:args.requestId,tool,arguments:args,requiredScopes:['commands:run','planning:write'],client,mutating:true});
 let preparations=0;api.prepare=async()=>{preparations++;throw Error('Retired work must not reach any adapter.');};
 await api.execute(admitted.job,{controller:new AbortController()});
 const receipt=await api.getJob(admitted.job.id,client);
 assert.equal(preparations,0);assert.equal(receipt.status,'failed');assert.equal(receipt.error.code,'PLANNING_CYCLE_RETIRED');
 assert.deepEqual(receipt.effects,{possible:false,confirmed:false});
 const replay=await api.call(tool,args,client);assert.equal(replay.existing,true);assert.equal(replay.jobId,admitted.job.id);assert.equal(preparations,0);
});
