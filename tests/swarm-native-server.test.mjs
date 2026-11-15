import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';
import { fixtureOutcomeReview, finishFixtureCandidate } from './fixture-modular-provider.mjs';

let n=0;
const data=result=>JSON.parse(result.contentItems.find(item=>item.type==='inputText').text);
const workflow=()=>({
  id:'native-swarm-server',name:'Swarm native/HTTP integration',
  nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'fixture-model',
    prompt:'Use native Swarm tools, then reconcile the HTTP project.'},{id:'output',type:'output'}],
  edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],
  settings:{planningMode:'off'},
});
class Runtime extends EventEmitter {
  constructor(){super();this.onFixture=null;}
  status(){return {connected:true,authenticated:true,defaultModel:'fixture-model',activeTurns:0};}
  async start(){return this.status();}
  async runAgent(options) {
    const review=fixtureOutcomeReview(options);if(review)return review;
    if(!this.onFixture)return {output:'No synthetic provider configured.',threadId:'fixture'};
    return finishFixtureCandidate(options,await this.onFixture(options));
  }
  async close(){}
}
async function fixture(t){
  const dir=await mkdtemp(path.join(tmpdir(),'swarm-native-server-'));
  const cwd=path.join(dir,'work');await mkdir(cwd);
  const runtime=new Runtime();
  const app=await createHarnessServer({runtime,port:0,dataDir:path.join(dir,'data'),
    defaultCwd:cwd,remoteAccess:null});
  const base=await app.listen({waitForRemote:false});
  const home=await fetch(base+'/next/');
  assert.equal(home.status,200);
  const cookie=home.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const http=async (route,method='GET',value)=>{
    const r=await fetch(base+route,{method,headers:{Cookie:cookie,
      ...(value!==undefined?{'Content-Type':'application/json'}:{})},
      body:value===undefined?undefined:JSON.stringify(value)});
    return {status:r.status,body:await r.json()};
  };
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  return {app,runtime,http,base};
}
test('actual temporary server registers native engine tools; engine/model callbacks and browser HTTP perform a bidirectional Swarm roundtrip',async t=>{
  const f=await fixture(t);
  assert.ok(f.app.engine.nativeSwarmTools,'server must register the actual native Swarm provider');
  assert.ok(f.app.engine.nativeSwarmTools.catalog.some(entry=>entry.name==='relay_swarm_ack'));
  let identity=null,deliveryId=null,ackToken=null;
  const dispatch=async(options,name,args={})=>{
    const result=await options.onToolCall({name,arguments:{
      requestId:'native_server_call_'+(++n),...args}});
    assert.equal(result.success,true,JSON.stringify(result));
    return data(result);
  };
  f.runtime.onFixture=async options=>{
    assert.ok(options.dynamicTools.some(entry=>entry.name==='relay_swarm_write'));
    const self=(await dispatch(options,'relay_swarm_read')).self;
    identity=self.id;
    const created=await dispatch(options,'relay_swarm_write',{
      mutationId:'native_server_create_'+(++n),action:'create_project',
      value:{id:'native_http_fixture',name:'Native-created, HTTP observed',
        objective:'Host model callbacks and browser HTTP share the same ledger.'}});
    assert.equal(created.project.coordinator.id,self.id);
    const seen=await f.http('/api/swarm/projects/native_http_fixture');
    assert.equal(seen.status,200);
    assert.equal(seen.body.coordinator.id,identity);

    // The real browser HTTP endpoint makes the reciprocal write. Its identity is
    // a local human; only the native node can receive/ack the bound worker item.
    const registered=await f.http('/api/swarm/actions','POST',{
      mutationId:'http_bind_native_'+(++n),action:'register_worker',
      projectId:'native_http_fixture',expectedProjectRevision:seen.body.revision,
      value:{id:'model_node_worker',label:'Engine native node',kind:'agent',
        actorId:self.id,scope:'One synthetic HTTP-created assignment'}});
    assert.equal(registered.status,200,JSON.stringify(registered));
    const assigned=await f.http('/api/swarm/actions','POST',{
      mutationId:'http_propose_native_'+(++n),action:'propose_item',
      projectId:'native_http_fixture',expectedProjectRevision:registered.body.project.revision,
      value:{id:'http_owned_item',title:'HTTP-owned native delivery',
        scope:'Exact synthetic item assigned to this host task/node',
        requirements:'Explicit native receive and acknowledge; never claim real work.',
        ownerId:'model_node_worker',dependsOn:[],verificationTarget:'unit'}});
    assert.equal(assigned.status,200,JSON.stringify(assigned));
    const queued=await f.http('/api/swarm/actions','POST',{
      mutationId:'http_queue_native_'+(++n),action:'transition',
      projectId:'native_http_fixture',itemId:'http_owned_item',
      expectedItemRevision:assigned.body.project.items[0].revision,value:{phase:'queued'}});
    assert.equal(queued.status,200,JSON.stringify(queued));
    const nativeObserved=await dispatch(options,'relay_swarm_read',{projectId:'native_http_fixture'});
    assert.equal(nativeObserved.projects[0].items[0].phase,'queued');
    const prepared=await dispatch(options,'relay_swarm_receive',{
      projectId:'native_http_fixture',itemId:'http_owned_item',expectedRequirementRevision:1});
    assert.equal(prepared.delivery.state,'response_prepared');
    deliveryId=prepared.delivery.id;ackToken=prepared.delivery.ackToken;
    const beforeAck=await f.http('/api/swarm/projects/native_http_fixture');
    assert.equal(beforeAck.body.items[0].nativeHandoff.state,'response_prepared');
    assert.equal(beforeAck.body.items[0].phase,'queued');
    assert.ok(!JSON.stringify(beforeAck.body).includes(ackToken),'HTTP never exposes native acknowledgment token');
    const ack=await dispatch(options,'relay_swarm_ack',{
      projectId:'native_http_fixture',itemId:'http_owned_item',
      expectedRequirementRevision:1,deliveryId,ackToken});
    assert.equal(ack.delivery.state,'acknowledged');
    return {output:'Native engine/HTTP bidirectional loopback fixture complete.',
      threadId:'native-http-fixture'};
  };
  const run=f.app.engine.startRun({workflow:workflow(),input:'Perform only the bounded local Swarm native test.',planningMode:'off'});
  await f.app.engine.executions.get(run.id);
  const done=f.app.engine.getRun(run.id);
  assert.equal(done.status,'completed',JSON.stringify(done));
  const current=await f.http('/api/swarm/projects/native_http_fixture');
  assert.equal(current.status,200);
  assert.equal(current.body.coordinator.id,identity);
  assert.equal(current.body.items[0].nativeHandoff.id,deliveryId);
  assert.equal(current.body.items[0].nativeHandoff.state,'acknowledged');
  assert.equal(current.body.items[0].nativeHandoff.workExecuted,false);
  assert.equal(current.body.items[0].completionCurrent,false);
  assert.equal(current.body.items[0].phase,'queued');
  assert.equal(current.body.nativeDeliveries.length,1);
});
