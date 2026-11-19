import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConversationArchive } from '../lib/conversations.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { HarnessEngine } from '../lib/engine.mjs';
import { toolResultEvent } from '../lib/tool-outcomes.mjs';
import { projectFamily } from '../public/next/chat/reader-model.mjs';

class Engine extends EventEmitter {
  runs=new Map();
  listRuns(){return [...this.runs.values()];}
  getRun(id){if(!this.runs.has(id))throw Error('Run not found.');return structuredClone(this.runs.get(id));}
}

test('saved Chat retains same-turn tool failure without archiving tool payloads',async t=>{
  const root=await realpath(tmpdir()), dataDir=await mkdtemp(path.join(root,'blackice-archive-failure-test-'));
  const archives=[];
  t.after(async()=>{for(const archive of archives)await archive.close();
    const resolved=await realpath(dataDir);
    assert.equal(path.dirname(resolved),root);assert.match(path.basename(resolved),/^blackice-archive-failure-test-/);
    await rm(resolved,{recursive:true,force:true});});
  const run={id:'turn-1',taskId:'turn-1',createdAt:'2026-11-19T01:00:00Z',input:'Test',status:'completed',settled:true,
    output:'Response saved',workflow:{name:'Chat',nodes:[{id:'agent',type:'agent'}]},nodes:{agent:{status:'completed'}},events:[]};
  const engine=new Engine(), archive=await new ConversationArchive({dataDir,engine}).init();archives.push(archive);
  const secret='PRIVATE-TOOL-CONTENT-do-not-serialize';
  const call={name:'relay_workspace',callId:'call-1',arguments:{action:'read',path:secret}};
  const outcome=toolResultEvent(call,{success:false,code:'TOOL_FAILED',contentItems:[{type:'inputText',text:secret}]});
  run.events.push({type:'agent.event',runId:run.id,nodeId:'agent',at:'2026-11-19T01:00:01Z',data:{...outcome,stderr:secret}});
  engine.runs.set(run.id,run);
  assert.match(projectFamily(await archive.family(run.id)).runs[0].toolFailure?.label??'',/failure recorded/);
  const success=toolResultEvent({...call,callId:'call-2'},{success:true,contentItems:[]});
  for(const [runId,nodeId] of [['other-turn','agent'],[run.id,'unowned-node']])
    run.events.push({type:'agent.event',runId,nodeId,at:'2026-11-19T01:00:02Z',data:success});
  await archive.capture(run);await archive.close();
  const restored=await new ConversationArchive({dataDir,engine:new Engine()}).init();archives.push(restored);
  const saved=projectFamily(await restored.family(run.id)).runs[0];
  assert.equal(saved.toolFailure?.label,'Tool failure recorded');
  assert.match(saved.toolFailure.detail,/relay_workspace.*read/);
  assert.ok(!JSON.stringify(saved).includes(secret));
  const raw=await readFile(path.join(dataDir,'conversations',run.id+'.json'),'utf8');
  assert.ok(!raw.includes(secret));
  assert.ok(!raw.includes('"tool.result"'));
});

test('actual engine retains a recovered tool failure even after its execution events roll away',async t=>{
  const root=await realpath(tmpdir()),dataDir=await mkdtemp(path.join(root,'blackice-archive-failure-test-'));
  const archives=[];let engine;
  t.after(async()=>{for(const archive of archives)await archive.close();await engine?.close();
    const resolved=await realpath(dataDir);assert.equal(path.dirname(resolved),root);
    assert.match(path.basename(resolved),/^blackice-archive-failure-test-/);await rm(resolved,{recursive:true,force:true});});
  const secret='PRIVATE-CONTENT-engine-test';
  const failure={success:false,code:'PDF_INVALID',contentItems:[{type:'inputText',text:secret}]};
  const call={name:'relay_workspace',callId:'call-1',arguments:{action:'read',path:secret}};
  const recovered=toolResultEvent({...call,callId:'call-2'},{success:true,contentItems:[]});
  class Runtime extends EventEmitter{
    defaultModel='offline-fixture';
    status(){return {connected:true,authenticated:true,defaultModel:this.defaultModel};}
    async savedThreadModel(){return this.defaultModel;}
    async runAgent({onEvent}){
      onEvent(toolResultEvent(call,failure));
      onEvent(toolResultEvent({...call,callId:'unrelated',arguments:{action:'read',path:'unrelated'}},{success:true,contentItems:[]}));
      const live=[...engine.runs.values()][0];
      assert.equal(live.chatToolFailureReceipt.followedBySuccess,false,'different operation must not match');
      engine.notify('agent.event',live,'input',recovered);
      assert.equal(live.chatToolFailureReceipt.followedBySuccess,false,'another node must not match');
      onEvent(recovered);
      assert.equal(live.chatToolFailureReceipt.followedBySuccess,true);
      return {output:'Completed visible response',threadId:'synthetic-tool-failure-thread'};
    }
  }
  engine=await new HarnessEngine({runtime:new Runtime(),dataDir:path.join(dataDir,'engine'),defaultCwd:dataDir}).init();
  const archiveDir=path.join(dataDir,'archive'), archive=await new ConversationArchive({dataDir:archiveDir,engine}).init();archives.push(archive);
  const workflow={id:'chat-failure-fixture',name:'Chat',nodes:[
    {id:'input',type:'input',name:'Input'},{id:'agent',type:'agent',name:'Agent',model:'offline-fixture',prompt:'Offline fixture.'},{id:'output',type:'output',name:'Output'}],
    edges:[{id:'in',source:'input',target:'agent'},{id:'out',source:'agent',target:'output'}],settings:{planningMode:'off',maxParallel:1}};
  const admission=engine.startRun({workflow,input:{task:'Read a synthetic document.',planningMode:'off',directoryMode:'off'}});
  let run;
  for(let i=0;i<300;i++){run=engine.runs.get(admission.id);if(run?.settled)break;await delay(10);}
  assert.equal(run?.settled,true);
  assert.equal(run.status,'completed',run.error);
  assert.equal(run.chatToolFailureReceipt.followedBySuccess,true);
  // Simulate the bounded run history rolling past both raw receipts.
  run.events=run.events.filter(e=>e.data?.type!=='tool.result');
  await archive.capture(engine.getRun(run.id));await archive.close();
  const archivedText=await readFile(path.join(archiveDir,'conversations',run.id+'.json'),'utf8');
  const saved=JSON.parse(archivedText);
  assert.deepEqual(saved.archivedToolFailure,{tool:'relay_workspace',action:'read',code:'PDF_INVALID',followedBySuccess:true});
  assert.equal(saved.chatToolFailureReceipt,undefined);
  assert.ok(saved.events.every(e=>e.data?.type!=='tool.result'));
  // Existing per-node operational diagnostics are separate from the Chat receipt.
  assert.ok(!JSON.stringify(saved.archivedToolFailure).includes(secret));
  assert.ok(!JSON.stringify(saved.archivedToolFailure).includes(recovered.operationKey));
  const restored=await new ConversationArchive({dataDir:archiveDir,engine:new Engine()}).init();archives.push(restored);
  const projected=projectFamily(await restored.family(run.id)).runs[0];
  assert.equal(projected.toolFailure.label,'Tool failure recorded; matching call later succeeded');
  assert.match(projected.toolFailure.detail,/relay_workspace.*read.*PDF_INVALID/);
  assert.ok(!JSON.stringify(projected).includes(secret));
});
