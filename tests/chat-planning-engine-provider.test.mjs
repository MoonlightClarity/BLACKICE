import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ProviderRuntime} from '../lib/providers.mjs';
import {HarnessEngine} from '../lib/engine.mjs';
import {TaskActionDirectory} from '../lib/task-action-directory.mjs';
import {commitChatPlanningProposal} from '../lib/chat-planning-engine.mjs';

class Native extends EventEmitter {
  status(){return {connected:false,authenticated:false,models:[]};}
  async close(){}
  async runAgent(){throw Error('No native inference in this test');}
}
const wait=async fn=>{
  for(let i=0;i<700;i++){const value=fn();if(value)return value;await delay(10);}
  assert.fail('Timed out waiting for fixture');
};
const plan={
  status:'proposed',focus:'inspect_a',reason:'Check the first observed boundary',
  actions:[{id:'inspect_a',objective:'Inspect route A',dependsOn:[]}],
};
const catalog = [
  'builtin-decomposition','builtin-task-grounding','builtin-structured-analysis','builtin-intent-inference',
];
test('explicit Chat Planning reaches a real compatible provider and advances the one Directory, unlike ordinary Off', {timeout:20000},async t=>{
  const root=await realpath(tmpdir()), dir=await mkdtemp(path.join(root,'blackice-planning-provider-'));
  const requests=[];
  let answerToPlanning=JSON.stringify(plan), heldResponse;
  let engine,runtime;
  const server=http.createServer(async(req,res)=>{
    if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
    let raw='';for await(const part of req)raw+=part;
    const body=JSON.parse(raw);
    const allText=JSON.stringify(body.messages);
    const prep=allText.includes('This is one bounded planning phase');
    requests.push({prep,body,allText});
    const respond=content=>{
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}]}));
    };
    if(prep && allText.includes('PAUSE FOR CANCEL')){heldResponse=()=>respond(answerToPlanning);return;}
    respond(prep?answerToPlanning:'Ordinary synthetic final, not an action receipt.');
  });
  t.after(async()=>{
    await engine?.close();await runtime?.close();
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    const resolved=await realpath(dir);
    assert.equal(path.dirname(resolved),root);
    assert.match(path.basename(resolved),/^blackice-planning-provider-/);
    await rm(resolved,{recursive:true,force:true});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  runtime=new ProviderRuntime({codex:new Native(),dataDir:dir,modelLimitResolver:{enrich:async(_config,model)=>model}});
  await runtime.store.init();
  await runtime.saveProvider({id:'fixture',type:'compatible',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',models:[{id:'fixture',contextWindowTokens:65536,maxOutputTokens:4096}]},{preserveDefault:true});
  engine=await new HarnessEngine({runtime,dataDir:path.join(dir,'engine'),defaultCwd:dir}).init();
  const start=(task,fields)=>engine.startRun({input:{task,cwd:dir,...fields},workflow:{id:'mission_chat_fixture',
    name:'Fixture',nodes:[{id:'input',type:'input',name:'Request'},{id:'agent',type:'agent',name:'Assistant',model:'fixture::fixture',prompt:'Answer directly.'},{id:'output',type:'output',name:'Result'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}]}});
  const done=run=>wait(()=>{const latest=engine.getRun(run.id);return latest.settled?latest:null;});
  const off=await done(await start('A normal turn',{chatPlanning:'off'}));
  assert.equal(off.status,'completed',off.error);
  assert.equal(requests.length,1);
  assert.equal(requests[0].prep,false);
  assert.equal(off.planningModuleReceipts,undefined);
  const on=await done(await start('Check the startup route',{chatPlanning:'on'}));
  assert.equal(on.status,'completed',on.error);
  assert.deepEqual(requests.map(row=>row.prep),[false,true,false]);
  assert.ok(!requests[1].body.tools?.length);
  assert.equal(requests[1].body.model,'fixture');
  assert.match(requests[2].allText,/ADVISORY PLANNING CHOICE/);
  assert.deepEqual(on.planningModuleReceipts.map(row=>[row.moduleId,row.phase]),[[catalog[0],'started'],[catalog[0],'completed']]);
  const ledger=await engine.actionDirectories.get(on.taskId||on.id,on.input);
  assert.equal(ledger.read().revision,1);
  assert.equal(ledger.read().actions[0].state,'pending');
  assert.equal(ledger.read().actions[0].reason,plan.reason);
  assert.equal(ledger.read().receipts.length,0);
  answerToPlanning='A normal transport final but not a structured artifact.';
  const failed=await done(await start('Prove malformed prep is visible',{chatPlanning:'on'}));
  assert.equal(failed.status,'completed',failed.error);
  assert.deepEqual(failed.planningModuleReceipts.map(row=>row.phase),['started','failed']);
  assert.ok(!requests.at(-1).allText.includes('ADVISORY PLANNING CHOICE'));
  const cancelledStart=await start('PAUSE FOR CANCEL',{chatPlanning:'on'});
  await wait(()=>heldResponse);
  await engine.cancelRun(cancelledStart.id);
  heldResponse();
  const cancelled=await done(cancelledStart);
  assert.equal(cancelled.status,'cancelled');
  assert.deepEqual(cancelled.planningModuleReceipts.map(row=>row.phase),['started','cancelled']);
  assert.equal((await engine.actionDirectories.get(cancelled.id,cancelled.input)).read().revision,0);
  assert.equal(requests.filter(row=>row.allText.includes('PAUSE FOR CANCEL')).length,1);
});

test('deadline and steering are rechecked inside the canonical CAS queue',async()=>{
  let release,entered;
  const held=new Promise(resolve=>release=resolve), waiting=new Promise(resolve=>entered=resolve);
  const directory=new TaskActionDirectory({taskId:'scope',objective:'A bounded task',persist:async()=>{entered();await held;}});
  const first=directory.edit({action:'plan',revision:0,actions:[{id:'stable',objective:'Prior pending step',dependsOn:[]}]});
  await waiting;
  let permitted=true;
  const result=commitChatPlanningProposal(directory,{taskId:'scope',expectedRevision:0,proposal:plan},()=>{
    if(!permitted)throw Object.assign(Error('steered before CAS'),{code:'STALE_DIRECTION'});
  });
  permitted=false;
  release();
  await first;
  await assert.rejects(result,{code:'STALE_DIRECTION'});
  assert.deepEqual(directory.read().actions.map(action=>action.id),['stable']);
  assert.equal(directory.read().revision,1);
});
