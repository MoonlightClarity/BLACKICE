import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {EventEmitter} from 'node:events';
import {createHarnessServer} from '../server.mjs';import {submitChat} from '../public/next/chat/send.mjs';
test('actual authenticated Directory endpoint scopes historical selected turn and serves inspector module',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'directory-diagnostics-'));class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true};}async start(){}async close(){}async runAgent(){throw Error('No model expected');}}
 const app=await createHarnessServer({runtime:new Runtime(),port:0,dataDir:dir,defaultCwd:dir,remoteAccess:null});t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});const calls=[];
 app.conversations.get=async id=>{calls.push(id);if(id!=='selected')throw Object.assign(Error('Missing'),{status:404});return{id,taskId:'same-task',events:[{data:{type:'tool.result',tool:'relay_browser',success:false,result:'PRIVATE'}}]};};
 const base=await app.listen({waitForRemote:false}),home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0];await home.arrayBuffer();const url=base+'/api/conversations/selected/directory?taskId=same-task';
 assert.equal((await fetch(url)).status,401);assert.equal(calls.length,0);const response=await fetch(url,{headers:{Cookie:cookie}});assert.equal(response.status,200);const body=await response.json();assert.equal(body.receipts.length,0);assert.match(body.coverage.reason,/Full receipts were not recorded/);assert.doesNotMatch(JSON.stringify(body),/PRIVATE/);assert.equal((await fetch(url.replace('same-task','other-task'),{headers:{Cookie:cookie}})).status,404);assert.equal((await fetch(base+'/next/chat/directory-inspector.mjs',{headers:{Cookie:cookie}})).status,200);
});
test('Directory choice is explicit in a new Chat submission and invalid choices cannot write',async()=>{const calls=[];await submitChat({api:async(...args)=>{calls.push(args);return{run:{id:'new'}};},runs:[],cwd:'C:/fixture',task:'Inspect',directoryDiagnostics:'on'});assert.equal(calls.at(-1)[2].input.directoryDiagnostics,'on');await assert.rejects(submitChat({api:async()=>assert.fail('must not write'),runs:[],task:'No',directoryDiagnostics:'auto'}),/Basic, Detailed, or Maximal/);});


import {createMissionWorkflow} from '../public/mission-model.mjs';
test('Maximal is a separate owner-local export, including after archive recovery',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'receipt-depth-'));
 class Runtime extends EventEmitter{
  status(){return{connected:true,authenticated:true,defaultModel:'fixture-model',models:[{id:'fixture-model',model:'fixture-model',supportsTools:true}]};}
  async start(){}async close(){}
  async runAgent(o){o.onEvent({type:'thread',threadId:'test-thread',turnId:'test-turn'});o.onEvent({type:'message',threadId:'test-thread',turnId:'test-turn',text:'PRIVATE_OUTPUT_CANARY'});return{output:'Same plain result'};}
 }
 const app=await createHarnessServer({runtime:new Runtime(),port:0,dataDir:dir,defaultCwd:dir,remoteAccess:null});
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const base=await app.listen({waitForRemote:false}),home=await fetch(base),headers={Cookie:home.headers.get('set-cookie').split(';')[0]};await home.arrayBuffer();
 const workflow=createMissionWorkflow({task:'Inspect a local fixture',model:'fixture-model',cwd:dir});
 async function run(mode){const initial=app.engine.startRun({workflow,input:{task:'PRIVATE_INPUT_CANARY',directoryDiagnostics:mode}});await app.engine.executions.get(initial.id);return app.engine.getRun(initial.id);}
 const basic=await run('off'),detailed=await run('on'),maximal=await run('maximal');
 for(const r of [basic,detailed,maximal]){assert.equal(r.status,'completed',r.error);assert.equal(r.output,maximal.output);assert.equal(r.turnMachineTrace,undefined);}
 const exportUrl=id=>base+'/api/conversations/'+id+'/directory?taskId='+id+'&view=machine';
 assert.equal((await fetch(exportUrl(basic.id),{headers})).status,409);
 assert.equal((await fetch(exportUrl(detailed.id),{headers})).status,409);
 assert.equal((await fetch(exportUrl(maximal.id))).status,401);
 assert.equal((await fetch(exportUrl(maximal.id)+'&limit=1',{headers})).status,400);
 assert.equal((await fetch(exportUrl(maximal.id).replace('taskId='+maximal.id,'taskId=other'),{headers})).status,404);
 const read=async()=>{const res=await fetch(exportUrl(maximal.id),{headers});assert.equal(res.status,200);const body=await res.json();assert.equal(body.taskId,maximal.id);assert.equal(body.runId,maximal.id);assert.equal(body.audience,'machine');assert(body.entries.length>=3);assert.doesNotMatch(JSON.stringify(body),/PRIVATE_INPUT_CANARY|PRIVATE_OUTPUT_CANARY/);return body;};
 const live=await read();await app.conversations.chain;app.engine.runs.delete(maximal.id);
 assert.equal((await app.conversations.get(maximal.id)).turnMachineTrace,undefined);
 assert.deepEqual((await read()).entries,live.entries);
});
