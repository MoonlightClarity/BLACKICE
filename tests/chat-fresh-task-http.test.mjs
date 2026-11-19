import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createHarnessServer} from '../server.mjs';
import {submitFreshChatTask} from '../public/next/chat/send.mjs';

class Runtime extends EventEmitter{
  calls=[];
  status(){return{connected:true,authenticated:true,defaultModel:'fresh-http-fixture',activeTurns:0,isolatedHistory:true};}
  async start(){return this.status();}
  async close(){}
  async savedThreadModel(){return 'fresh-http-fixture';}
  async runAgent(o){
    const call={tools:o.dynamicTools?.map(tool=>tool.name)||[],prompt:o.prompt,instructions:o.developerInstructions,threadId:o.threadId};
    this.calls.push(call);
    if(call.tools.includes('relay_goal')){
      const read=await o.onToolCall({name:'relay_goal',arguments:{action:'read'}});
      assert.equal(read.success,true);
      call.goal=JSON.parse(read.contentItems[0].text).goal;
      const progress=await o.onToolCall({name:'relay_goal',arguments:{action:'progress',goalId:call.goal.id,
        summary:'Observed the synthetic stage.',evidence:'Fixture observer returned a concrete intermediate result.',nextAction:'Check the next synthetic stage.'}});
      assert.equal(progress.success,true,JSON.stringify(progress));
    }
    return {output:call.goal?'OLD_ASSISTANT_HTTP_RECEIPT':'Fresh fixture result.',threadId:call.threadId||'fixture-thread-'+this.calls.length};
  }
}

async function until(fn){
  for(let i=0;i<1400;i++){const ready=await fn();if(ready)return ready;await delay(10);}
  assert.fail('Host fixture did not settle.');
}

test('authenticated fresh task API durably groups display but does not continue or extend the prior Goal',async t=>{
  const root=await realpath(tmpdir()),dir=await mkdtemp(path.join(root,'blackice-fresh-task-http-')),apps=[];
  const config={port:0,dataDir:path.join(dir,'data'),defaultCwd:path.join(dir,'work'),remoteAccess:false};
  t.after(async()=>{
    for(const app of apps.reverse())await app.close();
    const resolved=await realpath(dir);assert.equal(path.dirname(resolved),root);assert.match(path.basename(resolved),/^blackice-fresh-task-http-/);
    await rm(resolved,{recursive:true,force:true});
  });
  const open=async()=>{
    const runtime=new Runtime(),app=await createHarnessServer({...config,runtime});apps.push(app);
    const url=await app.listen();
    const cookie=(await fetch(url)).headers.get('set-cookie').split(';')[0];
    const request=async(route,value,auth=true)=>{
      const response=await fetch(url+route,{method:value===undefined?'GET':'POST',
        headers:{...(auth?{Cookie:cookie}:{}),...(value===undefined?{}:{'Content-Type':'application/json'})},
        ...(value===undefined?{}:{body:JSON.stringify(value)})});
      return {status:response.status,data:await response.json()};
    };
    return {app,runtime,request};
  };
  const {app,runtime,request}=await open(),deadlineAt=new Date(Date.now()+3_600_000).toISOString();
  const graph={id:'old-http-fixture',name:'Old task',nodes:[
    {id:'in',type:'input'},{id:'agent',type:'agent',model:'fresh-http-fixture',prompt:'Complete the fixture task.'},{id:'out',type:'output'}],
    edges:[{source:'in',target:'agent'},{source:'agent',target:'out'}],settings:{planningMode:'off',maxParallel:1}};
  const old=await request('/api/runs',{workflow:graph,input:{task:'OLD_HUMAN_HTTP_REQUEST',directoryMode:'off',planningMode:'off',
    goal:{objective:'OLD_GOAL_HTTP_CUTOFF',deadlineAt,deadlineTimeZone:'UTC',maxTurns:1}}});
  assert.equal(old.status,201,JSON.stringify(old.data));
  const oldId=old.data.id,oldRoute='/api/conversations/'+oldId;
  await until(async()=>app.engine.getRun(oldId).settled&&(await app.goals.get(oldId))?.status==='budget_exhausted');
  assert.equal(runtime.calls.length,1);
  const value={task:'FRESH_HTTP_REQUEST',requestId:'chat_fresh-fixture'};
  assert.equal((await request(oldRoute+'/fresh-task',value,false)).status,401);
  assert.equal((await request('/api/conversations/does-not-exist/fresh-task',value)).status,404);
  assert.equal((await request(oldRoute+'/fresh-task',{...value,chatDisplayGroupId:'forged-group'})).status,400);
  const client=async(route,_method,body)=>{const result=await request(route,body);assert.equal(result.status,201,JSON.stringify(result.data));return result.data;};
  const [receipt,repeat]=await Promise.all([submitFreshChatTask({api:client,sourceTaskId:oldId,...value}),request(oldRoute+'/fresh-task',value)]);
  const started={status:201,data:receipt};
  assert.equal(started.status,201,JSON.stringify(started.data));assert.equal(repeat.status,201,JSON.stringify(repeat.data));
  const freshId=started.data.run.id,freshRoute='/api/conversations/'+freshId;
  assert.notEqual(freshId,oldId);assert.equal(repeat.data.run.id,freshId);assert.equal(started.data.groupId,oldId);
  assert.equal((await request(oldRoute+'/fresh-task',{...value,task:'changed during replay'})).status,409);
  assert.equal((await request(freshRoute+'/fresh-task',value)).status,409,'request ownership includes the source task');
  await until(()=>app.engine.getRun(freshId).settled);
  assert.equal(runtime.calls.length,2);
  const fresh=app.engine.getRun(freshId);
  assert.equal(fresh.status,'completed',fresh.error);
  assert.equal(fresh.taskId,freshId);assert.equal(fresh.chatDisplayGroupId,oldId);
  for(const key of ['parentRunId','continuedFrom','modelHandoff','priorUserRequests','goal','goalDispatch'])assert.equal(fresh[key],undefined,key);
  assert.equal(runtime.calls[1].threadId,undefined);
  assert.ok(!runtime.calls[1].tools.includes('relay_goal')&&!runtime.calls[1].tools.includes('relay_history'));
  assert.match(runtime.calls[1].prompt,/FRESH_HTTP_REQUEST/);assert.doesNotMatch(runtime.calls[1].prompt+'\n'+runtime.calls[1].instructions,/OLD_HUMAN|OLD_GOAL|OLD_ASSISTANT|RELAY CONTINUITY/);
  assert.equal((await app.tasks.get(freshId)).goal,'FRESH_HTTP_REQUEST');
  assert.equal((await app.tasks.get(oldId)).goal,'OLD_HUMAN_HTTP_REQUEST');
  assert.equal((await app.goals.get(oldId)).deadlineAt,deadlineAt);assert.equal(await app.goals.get(freshId),null);
  assert.deepEqual((await request(freshRoute+'/display-group')).data,{groupId:oldId,selectedTaskId:freshId,state:'active',taskIds:[oldId,freshId]});
  const follow=await request('/api/runs/'+freshId+'/continue',{nodeId:'agent',message:'Fresh task follow-up.',requestId:'chat_fresh-fixture-follow'});
  assert.equal(follow.status,201,JSON.stringify(follow.data));
  await until(()=>app.engine.getRun(follow.data.id).settled);
  assert.equal(follow.data.taskId,freshId);assert.match(runtime.calls[2].prompt,/RELAY CONTINUITY[\s\S]*FRESH_HTTP_REQUEST/);
  assert.doesNotMatch(runtime.calls[2].prompt,/OLD_HUMAN|OLD_GOAL|OLD_ASSISTANT/);
  const resumed=await request(oldRoute+'/goal',{action:'resume',requestId:'old-http-resume'});
  assert.equal(resumed.status,200,JSON.stringify(resumed.data));
  await until(async()=>(await app.goals.get(oldId))?.status==='budget_exhausted'&&runtime.calls.length===4);
  assert.equal(runtime.calls[3].goal.deadlineAt,deadlineAt);
  assert.doesNotMatch(runtime.calls[3].prompt,/FRESH_HTTP_REQUEST|Fresh task follow-up/);
  assert.ok((await request(oldRoute)).data.runs.every(run=>run.taskId===oldId));
  await until(()=>[...app.engine.runs.values()].every(run=>run.settled));
  await app.close();
  const reopened=await open();
  assert.deepEqual((await reopened.request(freshRoute+'/display-group')).data,{groupId:oldId,selectedTaskId:freshId,state:'active',taskIds:[oldId,freshId]});
  assert.equal((await reopened.request(oldRoute+'/fresh-task',value)).data.run.id,freshId);
  assert.equal(reopened.runtime.calls.length,0,'restart and exact replay do not dispatch new work');
  assert.equal((await reopened.request(oldRoute+'/archive',{})).status,200);
  assert.deepEqual((await reopened.request(freshRoute+'/display-group')).data,{groupId:oldId,selectedTaskId:freshId,state:'active',taskIds:[freshId]});
  assert.deepEqual((await reopened.request(oldRoute+'/display-group')).data,{groupId:oldId,selectedTaskId:oldId,state:'archived',taskIds:[oldId]});
  assert.equal((await reopened.request(oldRoute+'/fresh-task',{...value,requestId:'chat_inactive'})).status,409);
  assert.equal(reopened.runtime.calls.length,0,'archived group metadata is not authority to start work');
});
