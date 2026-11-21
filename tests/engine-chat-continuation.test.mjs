import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';
import { IdentityStore } from '../lib/identity.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';

const task = 'Submit the prepared ordinary form and verify the result.';
const requestBoundary='\n\nCURRENT USER REQUEST (unchanged JSON string):\n';
function continuedRequest(prompt){
 const parts=prompt.split(requestBoundary);
 assert.equal(parts.length,2,'each continuation has one explicit current-request boundary');
 return JSON.parse(parts[1]);
}
const publicAnswers = run => run.events.filter(row => ['delta','message'].includes(row.data?.type) ||
  row.data?.type === 'item' && row.data.item?.type === 'agentMessage');
async function tempFixture(t, prefix) {
  const root = await realpath(tmpdir()), cwd = await mkdtemp(path.join(root, prefix));
  return cwd;
}
async function removeFixture(cwd) {
  const root=await realpath(tmpdir()),actual=await realpath(cwd);
  assert.equal(path.dirname(actual),root);assert.match(path.basename(actual),/^blackice-chat-continuation-(?:provider|events)-/);
  await rm(actual,{recursive:true,force:true});
}
function begin(engine,cwd,input=task) {
  const workflow = createMissionWorkflow({id:'mission_chat_continuation_fixture',task:input,cwd,model:'fixture::fixture',planningMode:'off'});
  return engine.startRun({workflow,input:{task:input,cwd,planningMode:'off',chatPlanning:'off',directoryActions:'off',directoryDiagnostics:'maximal'}});
}
async function settled(engine,run) {
  await engine.executions.get(run.id);
  return engine.getRun(run.id);
}
class NoLiveNative extends EventEmitter {
  status(){return{connected:false,authenticated:false,models:[]};}
  async runAgent(){assert.fail('This fixture must not call a live model.');}
  async close(){}
}

test('real compatible adapter continues after settled tools, then accepts the observed result without replay', {timeout:20000}, async t=>{
  const cwd=await tempFixture(t,'blackice-chat-continuation-provider-'),requests=[],actions=[];
  let engine,runtime,identity,index=0,opened=false,tabOwner;
  const response=message=>({choices:[{index:0,finish_reason:message.tool_calls?'tool_calls':'stop',message:{role:'assistant',...message}}]});
  const tool=(id,args)=>response({content:null,tool_calls:[{id,type:'function',function:{name:'relay_browser',arguments:JSON.stringify({browser:'relay',...args})}}]});
  const script=[
    tool('list',{action:'tabs'}),
    tool('open',{action:'open',url:'https://fixture.invalid/form'}),
    response({content:"I haven't submitted it. Can you confirm that I should continue?"}),
    tool('fill',{action:'fill',tabId:'fixture-tab',ref:'name-ref',text:'Ada'}),
    response({content:"I filled the name but couldn't submit; there is no confirmation."}),
    tool('submit',{action:'click',tabId:'fixture-tab',ref:'submit-ref'}),
    response({content:'Application received. Confirmation fixture-receipt-1.'}),
    response({content:'Application received. Confirmation fixture-receipt-1.'}),
  ];
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
    let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));
    const reply=script[index++];
    if(!reply){res.statusCode=500;res.end(JSON.stringify({error:{message:'Unexpected extra fixture request'}}));return;}
    res.end(JSON.stringify(reply));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await engine?.close();await runtime?.close();await identity?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await removeFixture(cwd);});
  runtime=new ProviderRuntime({codex:new NoLiveNative(),dataDir:cwd,modelLimitResolver:{enrich:async(_config,model)=>model}});
  await runtime.store.init();
  await runtime.saveProvider({id:'fixture',type:'compatible',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',
    models:[{id:'fixture',contextWindowTokens:65536,maxOutputTokens:4096}]},{preserveDefault:true});
  const dataDir=path.join(cwd,'engine');identity=await new IdentityStore({dataDir}).init();
  engine=await new HarnessEngine({runtime,dataDir,defaultCwd:cwd,identity,browser:{
    status:()=>({available:true,contained:true,tabs:opened?[{tabId:'fixture-tab',owner:tabOwner,url:'https://fixture.invalid/form'}]:[]}),
    perform:async (args,context)=>{
      actions.push({...args});
      if(args.action==='open'){opened=true;tabOwner=context.owner;}
      if(args.action==='tabs')return{tabs:[]};
      const submitted=actions.some(row=>row.action==='click');
      return{tabId:'fixture-tab',documentId:'fixture-document',url:'https://fixture.invalid/'+(submitted?'receipt':'form'),
        text:submitted?'Application received. Confirmation fixture-receipt-1.':'Ordinary form',
        frames:[{frameId:'main',documentId:'fixture-document',url:'https://fixture.invalid/form',observation:'content-observed',elements:[
          {ref:'name-ref',tag:'input',type:'text',id:'name',name:'name',label:'Name',value:actions.some(row=>row.action==='fill')?'Ada':''},
          {ref:'submit-ref',tag:'button',type:'submit',text:'Submit'},
        ]}]};
    },
  }}).init();
  const standing='OWNER_STANDING_FIXTURE\nHonor the user’s stated limits and use truthful evidence.';
  const previousInstructions=await engine.instructionSettings.read();
  await engine.instructionSettings.update({content:standing,expectedRevision:previousInstructions.revision,expectedHash:previousInstructions.hash});
  await t.test('ordinary action continuations retain the current request and standing Instructions',async()=>{
  const run=await settled(engine,begin(engine,cwd));
  assert.equal(run.status,'completed',run.error||run.nodes.agent.error);
  assert.equal(run.runtimeSettings.executionGuardrails,false);
  assert.equal(requests.length,8,'three useful checkpoints then unchanged final acceptance');
  assert.equal(actions.filter(row=>row.action==='fill').length,1,JSON.stringify(requests.at(-1)?.messages.filter(row=>row.role==='tool')));
  assert.equal(actions.filter(row=>row.action==='click').length,1,'controller does not replay the confirmed effect');
  assert.match(run.nodes.agent.output,/fixture-receipt-1/);
  assert.doesNotMatch(JSON.stringify(publicAnswers(run)),/Can you confirm|couldn't submit/);
  const reviews=run.events.filter(row=>row.data?.type==='chat.execution-review').map(row=>row.data);
  assert.deepEqual(reviews.map(row=>row.reviewDecision),['continue','continue','continue','accepted']);
  assert.equal(reviews.at(-1).reason,'no-new-task-evidence');
  assert.ok(reviews.every(row=>row.outcomeVerification==='not-evaluated'));
  assert.ok(requests.slice(3).some(body=>JSON.stringify(body.messages).includes('BLACKICE INTERNAL CONTINUATION')));
  const continuations=requests.map(body=>body.messages.at(-1)).filter(message=>message?.role==='user'&&message.content.startsWith('[BLACKICE INTERNAL CONTINUATION]'));
  assert.equal(continuations.length,3);
  for(const message of continuations){
    assert.equal(continuedRequest(message.content),task);
    assert.match(message.content,/applicable standing user instructions/);
    assert.match(message.content,/unless the user's actual instructions make it apply/);
  }
  assert.ok(requests.every(body=>JSON.stringify(body.messages).includes(JSON.stringify(standing).slice(1,-1))),'the actual owner Instructions stay in every provider request');
  });
  await t.test('prepare-only continuation retains the actual limit without dispatching another action',async()=>{
    const input='Prepare the ordinary form for review. Do not submit it.',output='The form is prepared for review and has not been submitted.';
    const offset=requests.length,actionsBefore=actions.length;
    script.push(response({content:output}),response({content:output}));
    const run=await settled(engine,begin(engine,cwd,input)),delivered=requests.slice(offset);
    assert.equal(run.status,'completed',run.error||run.nodes.agent.error);
    assert.equal(run.input,input);
    assert.equal(delivered.length,2,'one bounded check followed by no-new-evidence acceptance');
    assert.equal(actions.length,actionsBefore,'the continuation itself dispatches no action');
    const message=delivered[1].messages.at(-1);
    assert.equal(message.role,'user');
    assert.ok(message.content.startsWith('[BLACKICE INTERNAL CONTINUATION]'));
    assert.equal(continuedRequest(message.content),input);
    assert.ok(delivered.every(body=>JSON.stringify(body.messages).includes(JSON.stringify(standing).slice(1,-1))));
    const reviews=run.events.filter(row=>row.data?.type==='chat.execution-review').map(row=>row.data);
    assert.deepEqual(reviews.map(row=>row.reviewDecision),['continue','accepted']);
    assert.equal(reviews.at(-1).reason,'no-new-task-evidence');
    assert.ok(reviews.every(row=>row.outcomeVerification==='not-evaluated'));
    assert.equal(run.nodes.agent.output,output);
  });
});

async function nativeFixture(t,execute,input=task) {
  const cwd=await tempFixture(t,'blackice-chat-continuation-events-');
  let context;
  class Runtime extends EventEmitter {
    status(){return{connected:true,authenticated:true,defaultModel:'fixture::fixture',models:[{id:'fixture::fixture',supportsTools:true}]};}
    async runAgent(options){return execute(options,context);}
    async close(){}
  }
  const runtime=new Runtime(),engine=await new HarnessEngine({runtime,dataDir:path.join(cwd,'engine'),defaultCwd:cwd}).init();
  t.after(async()=>{await engine.close();await removeFixture(cwd);});
  context={engine,cwd,current:()=>engine.listRuns()[0]};
  return settled(engine,begin(engine,cwd,input));
}
async function localRead(options) {
  const call={name:'relay_workspace',callId:'local-read',arguments:{action:'list',path:'.'}};
  const result=await options.onToolCall(call,{signal:options.signal});
  assert.equal(result.success,true,result.contentItems?.[0]?.text);
  options.onEvent({type:'tool.result',tool:call.name,action:'list',callId:call.callId,success:true});
  options.onToolResultDelivered({call,result});
}
function emitFinal(options,text,id) {
  options.onEvent({type:'delta',itemId:id,delta:text});
  options.onEvent({type:'message',itemId:id,text,phase:'final_answer'});
}

test('ordinary review withholds rejected streamed questions and stale candidates while preserving commentary',async t=>{
  const run=await nativeFixture(t,async(options,context)=>{
    assert.equal(typeof options.onBeforeFinal,'function');
    options.onEvent({type:'delta',itemId:'progress',delta:'Checking the existing form.'});
    options.onEvent({type:'message',itemId:'progress',text:'Checking the existing form.',phase:'commentary'});
    options.onEvent({type:'delta',itemId:'stale',delta:'Stale question: should I proceed?'});
    await localRead(options);
    options.onEvent({type:'delta',itemId:'candidate',delta:'Rejected question: can you confirm?'});
    assert.doesNotMatch(JSON.stringify(publicAnswers(context.engine.getRun(context.current().id))),/Stale question|Rejected question/);
    assert.equal((await options.onBeforeFinal({output:'Rejected question: can you confirm?',signal:options.signal})).continue,true);
    const output='The existing form was inspected; the external outcome remains unverified.';
    emitFinal(options,output,'accepted');
    assert.equal(await options.onBeforeFinal({output,signal:options.signal}),null);
    return{output,threadId:'fixture-thread',turnId:'fixture-turn'};
  });
  assert.equal(run.status,'completed',run.error||run.nodes.agent.error);
  assert.doesNotMatch(JSON.stringify(publicAnswers(run)),/Stale question|Rejected question/);
  assert.doesNotMatch(run.nodes.agent.output,/Stale question|Rejected question/);
  assert.match(JSON.stringify(publicAnswers(run)),/Checking the existing form/);
  assert.match(JSON.stringify(publicAnswers(run)),/external outcome remains unverified/);
  assert.equal(run.runtimeSettings.executionGuardrails,false);
});

test('an accepted question remains public and cannot be disguised as task success',async t=>{
  const output='Can you supply the unavailable required attachment?';
  const run=await nativeFixture(t,async options=>{
    emitFinal(options,output,'first');
    assert.equal((await options.onBeforeFinal({output,signal:options.signal})).continue,true);
    emitFinal(options,output,'accepted');
    assert.equal(await options.onBeforeFinal({output,signal:options.signal}),null);
    return{output};
  });
  assert.equal(run.nodes.agent.output,output);
  assert.match(JSON.stringify(publicAnswers(run)),/Can you supply/);
  const review=run.events.filter(row=>row.data?.type==='chat.execution-review').at(-1).data;
  assert.equal(review.outcomeVerification,'not-evaluated');
});

test('a failed provider does not release an unaccepted candidate',async t=>{
  const run=await nativeFixture(t,async options=>{
    options.onEvent({type:'delta',itemId:'failed-candidate',delta:'Unaccepted question: continue?'});
    throw Object.assign(Error('Fixture provider failure'),{code:'FIXTURE_FAILURE'});
  });
  assert.equal(run.status,'failed');
  assert.doesNotMatch(JSON.stringify(publicAnswers(run)),/Unaccepted question/);
  assert.doesNotMatch(run.nodes.agent.output||'',/Unaccepted question/);
});

test('prepare-only continuation preserves scope and dispatches no tool itself',async t=>{
  const input='Prepare the ordinary form for review. Do not submit it.';
  const run=await nativeFixture(t,async options=>{
    await localRead(options);
    const output='The form is prepared for review and has not been submitted.';
    const continuation=await options.onBeforeFinal({output,signal:options.signal});
    assert.equal(continuation.continue,true);
    assert.equal(continuedRequest(continuation.prompt),input);
    assert.equal(await options.onBeforeFinal({output,signal:options.signal}),null);
    emitFinal(options,output,'prepared');
    return{output};
  },input);
  assert.equal(run.status,'completed',run.error||run.nodes.agent.error);
  assert.match(run.nodes.agent.output,/has not been submitted/);
  assert.equal(run.nodes.agent.toolSummary?.completed,1);
});
