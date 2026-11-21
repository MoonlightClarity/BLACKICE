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

class Native extends EventEmitter {
  status(){return {connected:false,authenticated:false,models:[]};}
  async close(){}
  async runAgent(){throw Error('Fixture does not start native inference');}
}
const graphCalls=[
  ['relay_planning_read',{action:'list',requestId:'read-fixture'}],
  ['relay_planning_write',{action:'create_request',requestId:'write-fixture',
    graphRequestId:'scope-fixture',title:'Fixture graph',objective:'Record a synthetic graph.'}],
  ['relay_planning_module',{action:'cancel',requestId:'module-fixture',graphRequestId:'scope-fixture',nodeId:'fixture',attemptId:'fixture'}],
  ['relay_task',{action:'read'}],
];
const names=body=>body.tools.map(tool=>tool.function?.name);
const toolCall=({name,args,id})=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const receipt=(body,id)=>body.messages.findLast(item=>item.role==='tool'&&item.tool_call_id===id)?.content;

test('ordinary Chat omits and cannot call planning tools; /plan explicitly opts in for that turn', {timeout:25000}, async t=>{
  const root=await realpath(tmpdir()), dir=await mkdtemp(path.join(root,'blackice-chat-tool-scope-'));
  const cwd=path.join(dir,'workspace');await mkdir(cwd);
  let phase='ordinary', step=0, app, runtime;
  const requests=new Map();
  const provider=http.createServer(async(req,res)=>{
    const send=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
    try {
      if(req.method==='GET')return send({data:[{id:'fixture'}]});
      let raw='';for await(const part of req)raw+=part;
      const body=JSON.parse(raw);
      if(!requests.has(phase))requests.set(phase,[]);
      requests.get(phase).push(body);
      if(phase==='probe-failure'){res.statusCode=400;return send({error:{message:'Fixture probe failed'}});}
      const calls=step++ ? [] : phase==='ordinary' ? graphCalls : phase==='explicit' ? [graphCalls[1],graphCalls[3]] : [];
      send({choices:[{index:0,finish_reason:calls.length?'tool_calls':'stop',message:calls.length?
        {role:'assistant',content:null,tool_calls:calls.map(([name,args],index)=>toolCall({name,args,id:phase+'-'+index}))}:
        {role:'assistant',content:'Synthetic response.'}}]});
    } catch(error) {res.statusCode=500;send({error:{message:error.message}});}
  });
  t.after(async()=>{
    if(app)await app.close();else await runtime?.close();
    provider.closeAllConnections();if(provider.listening)await new Promise(resolve=>provider.close(resolve));
    const resolved=await realpath(dir);
    assert.equal(path.dirname(resolved),root);
    assert.match(path.basename(resolved),/^blackice-chat-tool-scope-/);
    await rm(resolved,{recursive:true,force:true});
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  runtime=new ProviderRuntime({codex:new Native(),dataDir:path.join(dir,'data'),modelLimitResolver:{enrich:async(_config,model)=>model}});
  await runtime.store.init();
  await runtime.saveProvider({id:'fixture',type:'compatible',baseUrl:'http://127.0.0.1:'+provider.address().port+'/v1',models:[{id:'fixture',contextWindowTokens:196608,maxOutputTokens:4096}]},{preserveDefault:true});
  await runtime.saveProvider({id:'local_llamacpp',type:'compatible',baseUrl:'http://127.0.0.1:'+provider.address().port+'/v1',models:[{id:'fixture',contextWindowTokens:196608,maxOutputTokens:4096}]},{preserveDefault:true});
  app=await createHarnessServer({runtime,remoteAccess:false,dataDir:path.join(dir,'data'),defaultCwd:cwd,port:0});await app.listen();
  const initialCore=await app.engine.instructionSettings.read();
  await app.engine.instructionSettings.update({content:'OWNER_SCOPE_CORE\n',expectedRevision:initialCore.revision,expectedHash:initialCore.hash});
  const api=async(route,_method,body)=>route==='/api/workflows'?body:route==='/api/runs'?app.engine.startRun(body):
    app.engine.continueRun(route.split('/')[3],body);
  const run=async(task,runs=[],options={},expected='completed')=>{
    step=0;
    const started=await submitChat({api,runs,task,model:'fixture::fixture',cwd,...options});
    for(let i=0;i<1000;i++){
      const done=app.engine.getRun(started.run.id);
      if(done.settled){assert.equal(done.status,expected,done.error);return done;}
      await delay(10);
    }
    throw Error('Synthetic Chat did not settle.');
  };

  const initial=await run('Explain what relay_task and relay_planning_write do. Do not call them.');
  const off=requests.get('ordinary');
  assert.deepEqual(names(off[0]).filter(name=>graphCalls.some(([tool])=>tool===name)),[]);
  assert.ok(names(off[0]).includes('relay_skills'));
  assert.equal(off.length,2);
  for(let i=0;i<graphCalls.length;i++)assert.match(receipt(off[1],'ordinary-'+i),/not attached/i);
  assert.equal((await app.planningBrowser.list({conversationId:initial.taskId})).requests.length,0);

  phase='explicit';
  const explicit=await run('/plan Record a synthetic planning graph and inspect this saved task.',[initial]);
  const on=requests.get('explicit');
  assert.deepEqual(names(on[0]).filter(name=>graphCalls.some(([tool])=>tool===name)).sort(),graphCalls.map(([tool])=>tool).sort());
  assert.match(receipt(on[1],'explicit-0'),/Fixture graph/);
  assert.match(receipt(on[1],'explicit-1'),new RegExp(explicit.taskId));
  assert.equal((await app.planningBrowser.get('scope-fixture')).conversationId,initial.taskId);
  assert.equal(explicit.taskId,initial.taskId);
  assert.notEqual(explicit.nodes.agent.threadId,initial.nodes.agent.threadId,'new provider catalog needs a new session, not a new chat');

  phase='after';
  const after=await run('Summarize our conversation, without invoking planning tools.',[initial,explicit]);
  assert.deepEqual(names(requests.get('after')[0]).filter(name=>graphCalls.some(([tool])=>tool===name)),[]);
  assert.equal(after.taskId,initial.taskId);
  assert.notEqual(after.nodes.agent.threadId,explicit.nodes.agent.threadId);
  const local={model:'local_llamacpp::fixture'};
  for(const directoryActions of ['off','on']){
    if(directoryActions==='on'){const current=await app.engine.instructionSettings.read();await app.engine.instructionSettings.update({content:'',expectedRevision:current.revision,expectedHash:current.hash});}
    phase='probe-'+directoryActions;
    const result=await run('test',[],{...local,directoryActions});
    const wire=requests.get(phase);
    assert.equal(wire.length,1);
    assert.deepEqual(wire[0].tools,[]);
    assert.equal(wire[0].tool_choice,'none');
    assert.deepEqual(wire[0].messages.filter(m=>m.role==='user').map(m=>m.content),['test']);
    assert.equal(result.directoryActions,directoryActions,'this turn does not change the saved mode');
    assert.equal(result.nodes.agent.localConnectivityProbe,true);
    const audit=result.nodes.agent.instructionAudit,core=audit.sections.find(row=>row.id==='core');
    assert.equal(core.text,directoryActions==='on'?'':'OWNER_SCOPE_CORE\n');
    assert.equal(core.revision,(await app.engine.instructionSettings.read()).revision);
    assert.ok(audit.sections.some(row=>row.id==='response-only-contract'));
    assert.equal(audit.sections.filter(row=>row.layer==='developer').map(row=>row.text).join(''),wire[0].messages[0].content);
    if(directoryActions==='off'){
      phase='probe-followup';
      const next=await run('Test the file parser in this project.',[result],local);
      assert.ok(names(requests.get(phase)[0]).includes('relay_workspace'));
      assert.equal(next.taskId,result.taskId);
      assert.notEqual(next.nodes.agent.threadId,result.nodes.agent.threadId);
    }
  }

});
