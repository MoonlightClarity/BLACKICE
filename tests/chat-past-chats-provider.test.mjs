import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createHarnessServer} from '../server.mjs';
import {ProviderRuntime} from '../lib/providers.mjs';
import {submitChat} from '../public/next/chat/send.mjs';
import {projectFamily} from '../public/next/chat/reader-model.mjs';

class Native extends EventEmitter {
  status(){return {connected:false,authenticated:false,models:[]};}
  async close(){}
  async runAgent(){throw Error('Fixture does not start native inference');}
}
const toolCall=(name,args,id)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const receipt=(body,id)=>body.messages.findLast(item=>item.role==='tool'&&item.tool_call_id===id)?.content;
const available=(body,name)=>body.tools.some(tool=>tool.function?.name===name);

test('Past Chats Off denies unrelated local history/model output; On demand enables it without changing same-chat identity', {timeout:25000}, async t=>{
  const root=await realpath(tmpdir()),dir=await mkdtemp(path.join(root,'blackice-past-chats-test-'));
  const cwd=path.join(dir,'workspace');await mkdir(cwd);
  const oldMarker='unrelated-output-past-chats-fixture-7531';
  const continuityMarker='same-chat-continuity-fixture-4397';
  const titleMarker='Prior title marker 20581';
  let phase='old',step=0,oldRun,activeRun,app,runtime;
  const requests=new Map();
  const provider=http.createServer(async(req,res)=>{
    const send=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
    try {
      if(req.method==='GET')return send({data:[{id:'fixture'}]});
      let raw='';for await(const part of req)raw+=part;
      const body=JSON.parse(raw);
      if(!requests.has(phase))requests.set(phase,[]);
      requests.get(phase).push(body);
      const calls=(phase==='off'||phase==='on')&&step++===0?[
        toolCall('relay_history',{action:'read',scope:'global',id:oldRun.id},phase+'-history'),
        toolCall('relay_agents',{action:'list',scope:'all'},phase+'-list'),
        toolCall('relay_agents',{action:'get',runId:oldRun.id},phase+'-get'),
        toolCall('relay_control',{action:'catalog'},phase+'-catalog'),
        toolCall('relay_control',{action:'workflow_get',id:oldRun.workflowId},phase+'-workflow'),
        toolCall('relay_control',{action:'workflow_get',id:'explicit-test-workflow'},phase+'-authored'),
        ...(activeRun?[toolCall('relay_agents',{action:'get',runId:activeRun.id},phase+'-own')]:[]),
      ]:[];
      send({choices:[{index:0,finish_reason:calls.length?'tool_calls':'stop',message:calls.length?
        {role:'assistant',content:null,tool_calls:calls}:{role:'assistant',content:phase==='old'?oldMarker:'Synthetic response.'}}]});
    } catch(error) {res.statusCode=500;send({error:{message:error.message}});}
  });
  t.after(async()=>{
    if(app)await app.close();else await runtime?.close();
    provider.closeAllConnections();if(provider.listening)await new Promise(resolve=>provider.close(resolve));
    const resolved=await realpath(dir);
    assert.equal(path.dirname(resolved),root);
    assert.match(path.basename(resolved),/^blackice-past-chats-test-/);
    await rm(resolved,{recursive:true,force:true});
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  runtime=new ProviderRuntime({codex:new Native(),dataDir:path.join(dir,'data'),modelLimitResolver:{enrich:async(_config,model)=>model}});
  await runtime.store.init();
  await runtime.saveProvider({id:'fixture',type:'compatible',baseUrl:'http://127.0.0.1:'+provider.address().port+'/v1',models:[{id:'fixture',contextWindowTokens:196608,maxOutputTokens:4096}]},{preserveDefault:true});
  const runAgent=runtime.runAgent.bind(runtime);
  runtime.runAgent=async options=>{
    if(phase==='off'){
      const result=await options.onToolCall({name:'relay_history',arguments:{action:'read',scope:'global',id:oldRun.id},callId:'fixture-native-dispatch'});
      assert.equal(result.success,false);
      assert.equal(result.code,'PAST_CHATS_OFF');
      assert.doesNotMatch(JSON.stringify(result),new RegExp(oldMarker));
    }
    return runAgent(options);
  };
  app=await createHarnessServer({runtime,remoteAccess:false,dataDir:path.join(dir,'data'),defaultCwd:cwd,port:0});await app.listen();
  const api=async(route,_method,body)=>route==='/api/workflows'?app.engine.saveWorkflow(body):route==='/api/runs'?app.engine.startRun(body):
    app.engine.continueRun(route.split('/')[3],body);
  const run=async(task,runs=[],pastChats)=>{
    step=0;
    const started=await submitChat({api,runs,task,model:'fixture::fixture',cwd,pastChats});
    for(let i=0;i<1000;i++){
      const done=app.engine.getRun(started.run.id);
      if(done.settled){assert.equal(done.status,'completed',done.error);return done;}
      await delay(10);
    }
    throw Error('Synthetic Chat did not settle.');
  };

  oldRun=await run(titleMarker+' is a separate older conversation.');
  await app.engine.saveWorkflow({...oldRun.workflow,id:'explicit-test-workflow',name:'Authored workflow 39056',description:'An intentionally authored workflow.'});
  assert.match(oldRun.output,new RegExp(oldMarker));
  phase='off';
  const off=await run('Keep this same-chat note: '+continuityMarker);
  assert.equal(off.pastChats,'off','Fresh Chat defaults to Off.');
  const offRequests=requests.get('off');
  assert.equal(available(offRequests[0],'relay_history'),true);
  assert.deepEqual(offRequests[0].tools.find(t=>t.function?.name==='relay_history').function.parameters.properties.action.enum,['previous_turn_diagnostics']);
  assert.equal(available(offRequests[0],'relay_agents'),true);
  assert.match(receipt(offRequests[1],'off-history'),/Past Chats is Off/i);
  assert.match(receipt(offRequests[1],'off-get'),/Past Chats is Off/i);
  assert.doesNotMatch(JSON.stringify(offRequests),new RegExp(oldMarker),'No unrelated output was delivered.');
  assert.doesNotMatch(receipt(offRequests[1],'off-list'),new RegExp(oldRun.id));
  assert.match(receipt(offRequests[1],'off-list'),new RegExp(off.id));
  assert.doesNotMatch(receipt(offRequests[1],'off-catalog'),new RegExp(titleMarker));
  assert.match(receipt(offRequests[1],'off-catalog'),/Authored workflow 39056/);
  assert.match(receipt(offRequests[1],'off-workflow'),/Workflow not found/i);
  assert.match(receipt(offRequests[1],'off-authored'),/Authored workflow 39056/);

  phase='on';activeRun=off;
  const on=await run('Look up the separate previous chat.',[off],'on');
  const onRequests=requests.get('on');
  assert.equal(on.pastChats,'on');
  assert.equal(on.taskId,off.taskId);
  assert.equal(on.modelHandoff?.reason,'past-chats-scope');
  assert.notEqual(on.nodes.agent.threadId,off.nodes.agent.threadId);
  assert.match(JSON.stringify(onRequests[0].messages),new RegExp(continuityMarker));
  assert.equal(available(onRequests[0],'relay_history'),true);
  for(const id of ['on-history','on-get','on-list'])assert.match(receipt(onRequests[1],id),new RegExp(oldMarker));
  for(const id of ['on-catalog','on-workflow'])assert.match(receipt(onRequests[1],id),new RegExp(titleMarker));
  assert.match(receipt(onRequests[1],'on-own'),new RegExp(off.id));
  assert.equal(projectFamily(await app.conversations.family(on.id)).runs.at(-1).pastChats,'on');

  phase='post';const post=await run('Continue without retrieving unrelated chats.',[off,on],'off');
  assert.equal(post.pastChats,'off');
  assert.equal(post.taskId,off.taskId);
  assert.deepEqual(requests.get('post')[0].tools.find(t=>t.function?.name==='relay_history').function.parameters.properties.action.enum,['previous_turn_diagnostics']);
  assert.equal(post.modelHandoff?.reason,'past-chats-scope');
});
