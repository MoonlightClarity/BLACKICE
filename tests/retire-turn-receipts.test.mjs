import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHarnessServer} from '../server.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';
import {previousTurnDiagnostics} from '../lib/retrieval-tools.mjs';

class Runtime extends EventEmitter {
  status(){return {connected:true,authenticated:true};}
  async start(){}
  async close(){}
  async runAgent(){throw Error('No model invocation expected');}
}
const at='2026-11-20T00:00:00.000Z';
const outcome={type:'tool.result',tool:'relay_workspace',action:'write',success:true,callId:'durable-outcome'};
function fixture(dir,id,taskId=id,depth='maximal'){
  const turn={id,taskId,...(id!==taskId?{parentRunId:taskId}:{}),createdAt:at,updatedAt:at,finishedAt:at,input:'Saved request',output:'Saved answer',
    status:'completed',settled:true,directoryDiagnostics:depth,attachmentIds:['retained-artifact'],
    workflow:createMissionWorkflow({task:'Saved request',cwd:dir}),
    nodes:{agent:{status:'completed',directoryContext:{schemaVersion:1,runId:id,taskId,nodeId:'agent',preparedAt:at},toolNames:['relay_workspace']}},
    events:[{type:'message',text:'Saved transcript'},outcome,{type:'directory.mutation',operation:'focus',phase:'applied'}].map(data=>({type:'agent.event',runId:id,nodeId:'agent',at,data})),
    taskState:{taskId,revision:1,plan:{steps:[{id:'retained-step'}]}}};
  if(depth==='maximal')turn.turnMachineTrace={version:1,runId:id,taskId,seen:1,head:[{sequence:1,envelope:'agent.event',kind:'tool.result'}],tail:[]};
  return turn;
}
async function harness(apps,dir){
  const app=await createHarnessServer({runtime:new Runtime(),port:0,dataDir:dir,defaultCwd:dir,remoteAccess:null});
  apps.push(app);
  const base=await app.listen({waitForRemote:false}),home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0];
  await home.arrayBuffer();
  const request=async(route,value,{headers={}}={})=>{
    const res=await fetch(base+route,{method:value===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json',...headers},...(value===undefined?{}:{body:JSON.stringify(value)})});
    return {status:res.status,body:await res.json()};
  };
  const seed=async run=>{app.engine.runs.set(run.id,run);app.engine.markRunDirty(run.id);await app.engine.persist();await app.conversations.capture(app.engine.getRun(run.id));};
  return {app,request,seed};
}
function cleanup(t,dir){
  const apps=[];
  t.after(async()=>{
    try{for(const app of apps.reverse())await app.close();}
    finally{await rm(dir,{recursive:true,force:true,maxRetries:2});}
  });
  return apps;
}
function sqliteRun(dir,id){
  const db=new DatabaseSync(path.join(dir,'run-state.sqlite'),{readOnly:true});
  try{return JSON.parse(db.prepare('SELECT payload FROM records WHERE id=?').get(id).payload);}
  finally{db.close();}
}
const jsonRun=async(dir,id)=>JSON.parse(await readFile(path.join(dir,'conversations',id+'.json'),'utf8'));
const receipts=(request,id,taskId=id,view='context')=>request('/api/conversations/'+id+'/receipts?taskId='+taskId+'&view='+view);
async function assertRetired(request,id,taskId=id){
  for(const view of ['context','tools','decisions','machine']){
    const value=await receipts(request,id,taskId,view);
    assert.equal(value.status,410,JSON.stringify(value.body));
    assert.equal(value.body.code,'TURN_RECEIPTS_REMOVED');
  }
}
function assertScrubbed(run){
  assert.equal(run.receiptDiagnosticsRemoved,true);
  assert.equal(run.turnMachineTrace,undefined);
  assert.equal(run.nodes.agent.directoryContext,undefined);
  assert.ok(run.events.every(event=>event.data.type!=='directory.mutation'));
  assert.ok(run.events.some(event=>event.data.text==='Saved transcript'));
  assert.deepEqual(run.attachmentIds,['retained-artifact']);
  assert.equal(run.taskState.plan.steps[0].id,'retained-step');
}

test('single archive and recursive Trash remove canonical Receipts while preserving restore, runtime evidence and fresh turns',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-receipt-retirement-'));
  const apps=cleanup(t,dir);
    const {app,request,seed}=await harness(apps,dir);
    const root=fixture(dir,'root'),child=fixture(dir,'child','root','off'),other=fixture(dir,'other');
    for(const run of [root,child,other])await seed(run);
    const staleCapture=structuredClone(root);
    assert.equal((await receipts(request,'root','root','machine')).body.coverage.source,'maximal-host-envelopes');
    assert.equal((await receipts(request,'child','root','tools')).body.actions[0].callId,'durable-outcome');
    const archived=await request('/api/conversations/child/archive',{});assert.equal(archived.status,200,JSON.stringify(archived.body));
    await assertRetired(request,'root');await assertRetired(request,'child','root');
    for(const id of ['root','child']){
      assertScrubbed(await jsonRun(dir,id));const row=sqliteRun(dir,id);assertScrubbed(row);
      assert.deepEqual(row.events.find(event=>event.data.callId==='durable-outcome').data,outcome);
      assert.throws(()=>previousTurnDiagnostics(row),{code:'TURN_RECEIPTS_REMOVED'});
    }
    assert.equal((await request('/api/conversations/root/restore',{})).status,200);
    await app.conversations.capture(staleCapture);
    assertScrubbed(await jsonRun(dir,'root'));
    const next=fixture(dir,'fresh','root');await seed(next);
    assert.equal((await receipts(request,'fresh','root','machine')).status,200);
    await assertRetired(request,'root');
    let org=(await request('/api/conversation-folders')).body.folderOrganization;
    const edit=async operations=>{const result=await request('/api/conversation-folders/edit',{expectedRevision:org.revision,operations});assert.equal(result.status,200,JSON.stringify(result.body));org=result.body.folderOrganization;};
    await edit([{type:'create_folder',name:'Parent'}]);const parent=org.folders[0].id;
    await edit([{type:'create_folder',name:'Nested',parentId:parent}]);const nested=org.folders.find(folder=>folder.parentId===parent).id;
    await edit([{type:'assign',rootId:'root',folderId:nested}]);
    const trash=await request('/api/conversation-folders/'+parent+'/delete',{expectedRevision:org.revision,expectedMetadataRevision:org.lifecycleRevision});
    assert.equal(trash.status,200,JSON.stringify(trash.body));assert.deepEqual(trash.body.rootIds,['root']);
    assertScrubbed(sqliteRun(dir,'fresh'));
    assert.equal((await receipts(request,'other','other','machine')).status,200);
    await app.close();
    const reopened=await harness(apps,dir);await assertRetired(reopened.request,'fresh','root');
    const restore=await reopened.request('/api/conversation-folders/'+parent+'/restore',{expectedRevision:org.revision,expectedMetadataRevision:trash.body.lifecycleRevision});
    assert.equal(restore.status,200,JSON.stringify(restore.body));
    await assertRetired(reopened.request,'fresh','root');
    const restored=await reopened.request('/api/conversations/root');
    assert.ok(restored.body.runs.some(run=>run.events.some(event=>event.data.text==='Saved transcript')));
    assert.equal((await receipts(reopened.request,'other','other','machine')).status,200);
    await reopened.app.close();
});

test('explicit archived-only purge revalidates whole scope and never sweeps older archives at startup',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-receipt-purge-scope-'));
  const apps=cleanup(t,dir);
    const first=await harness(apps,dir);
    for(const id of ['chosen','untouched','active','archive-only'])await first.seed(fixture(dir,id));
    await first.seed(fixture(dir,'unselected-turn','chosen','off'));
    first.app.engine.runs.delete('archive-only');
    await first.app.engine.persist();
    await first.app.close();
    // Seed historical metadata without running the new retirement action.
    await writeFile(path.join(dir,'conversation-state.json'),JSON.stringify({chosen:{state:'archived',revision:1},untouched:{state:'archived',revision:2},'archive-only':{state:'archived',revision:2}}));
    const {app,request}=await harness(apps,dir);
    const route='/api/conversations/archived-receipts/purge';
    assert.equal((await receipts(request,'chosen','chosen','machine')).body.coverage.source,'maximal-host-envelopes');
    assert.equal((await request(route,{rootIds:['chosen'],expectedTurnIds:['chosen'],expectedMetadataRevision:1})).status,409);
    assert.equal((await request(route,{rootIds:['chosen','active'],expectedTurnIds:['chosen','active'],expectedMetadataRevision:2})).status,409);
    assert.equal((await request(route,{rootIds:['chosen'],expectedTurnIds:['chosen','untouched'],expectedMetadataRevision:2})).status,409);
    assert.equal((await receipts(request,'chosen','chosen','machine')).status,200);
    assert.equal((await receipts(request,'archive-only','archive-only','machine')).body.coverage.source,'maximal-host-envelopes');
    const result=await request(route,{rootIds:['chosen','archive-only'],expectedTurnIds:['chosen','archive-only'],expectedMetadataRevision:2});
    assert.equal(result.status,200,JSON.stringify(result.body));
    assert.deepEqual(result.body,{rootIds:['chosen','archive-only'],turns:2,metadataRevision:2});
    await assertRetired(request,'chosen');
    assertScrubbed(sqliteRun(dir,'chosen'));assertScrubbed(await jsonRun(dir,'chosen'));
    assertScrubbed(await jsonRun(dir,'archive-only'));await assertRetired(request,'archive-only');
    assert.equal((await receipts(request,'untouched','untouched','machine')).body.coverage.source,'maximal-host-envelopes');
    assert.equal((await receipts(request,'unselected-turn','chosen','tools')).body.actions[0].callId,'durable-outcome');
    assert.equal((await request('/api/conversations?state=archived')).body.conversations.length,3);
    await app.close();
});

test('a rejected metadata commit removes nothing; a post-commit storage failure stays blocked until explicit restore finishes cleanup',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-receipt-purge-failure-'));
  const {app,seed,request}=await harness(cleanup(t,dir),dir);
  await seed(fixture(dir,'retiring'));
  const store=app.conversations,io=store.io;
  let fail=store.stateFile;
  store.io={...io,rename:async(from,to)=>{
    if(to===fail)throw Object.assign(Error('fixture disk failure'),{code:'EIO'});
    return io.rename(from,to);
  }};
  const endpoint='/api/conversations/retiring/';
  assert.equal((await request(endpoint+'archive',{})).status,503);
  assert.equal((await receipts(request,'retiring','retiring','machine')).status,200);
  assert.ok(sqliteRun(dir,'retiring').turnMachineTrace);
  assert.ok((await jsonRun(dir,'retiring')).turnMachineTrace);
  fail=path.join(dir,'conversations','retiring.json');
  const blocked=await request(endpoint+'archive',{});
  assert.equal(blocked.status,503,JSON.stringify(blocked.body));
  assert.match(blocked.body.error,/was archived.*cleanup could not finish/i);
  await assertRetired(request,'retiring');
  assertScrubbed(sqliteRun(dir,'retiring'));
  assert.ok((await jsonRun(dir,'retiring')).turnMachineTrace);
  assert.deepEqual(JSON.parse(await readFile(store.stateFile)).retiring.receiptPurgePending,['retiring']);
  assert.equal((await request(endpoint+'restore',{})).status,503,'cannot restore before both stores are clean');
  fail=null;
  assert.equal((await request(endpoint+'restore',{})).status,200);
  assertScrubbed(await jsonRun(dir,'retiring'));
  assert.equal(JSON.parse(await readFile(store.stateFile)).retiring.receiptPurgePending,undefined);
  await assertRetired(request,'retiring');
});
