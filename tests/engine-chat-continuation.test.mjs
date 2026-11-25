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


const outcomeBoundary='\nREVIEW DATA (JSON):\n';
const outcomeRequest=body=>body.messages?.some(message=>typeof message.content==='string'&&message.content.includes('BLACKICE ORDINARY TASK OUTCOME REVIEW'));
function syntheticOutcomeResponse(body) {
  const prompt=body.messages.find(message=>typeof message.content==='string'&&message.content.includes('BLACKICE ORDINARY TASK OUTCOME REVIEW')).content;
  const {snapshot}=JSON.parse(prompt.split(outcomeBoundary).at(-1));
  const evidenceRefs=snapshot.evidence.records.length?[snapshot.evidence.records.at(-1).citationRef]:['user-request'];
  // These pre-existing fixtures test transport/buffering, not a model's
  // judgment or live business completion. The P fixture below exercises work.
  return {choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({
    decision:'respond',summary:'Synthetic transport assessment; no real external outcome is verified.',
    remaining:[],nextAction:'',evidenceRefs,blockers:[]})}}]};
}

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
    if(outcomeRequest(requests.at(-1))){res.end(JSON.stringify(syntheticOutcomeResponse(requests.at(-1))));return;}
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
  assert.equal(requests.length,9,'eight worker requests plus one read-only outcome assessment');
  assert.equal(requests.filter(outcomeRequest).length,1);
  assert.equal(actions.filter(row=>row.action==='fill').length,1,JSON.stringify(requests.at(-1)?.messages.filter(row=>row.role==='tool')));
  assert.equal(actions.filter(row=>row.action==='click').length,1,'controller does not replay the confirmed effect');
  assert.match(run.nodes.agent.output,/fixture-receipt-1/);
  assert.doesNotMatch(JSON.stringify(publicAnswers(run)),/Can you confirm|couldn't submit/);
  const reviews=run.events.filter(row=>row.data?.type==='chat.execution-review').map(row=>row.data);
  assert.deepEqual(reviews.map(row=>row.reviewDecision),['continue','continue','continue','accepted']);
  assert.equal(reviews.at(-1).reason,'task-outcome-supported');
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
    assert.equal(delivered.length,3,'two worker requests plus one read-only outcome assessment');
    assert.equal(delivered.filter(outcomeRequest).length,1);
    assert.equal(actions.length,actionsBefore,'the continuation itself dispatches no action');
    const message=delivered[1].messages.at(-1);
    assert.equal(message.role,'user');
    assert.ok(message.content.startsWith('[BLACKICE INTERNAL CONTINUATION]'));
    assert.equal(continuedRequest(message.content),input);
    assert.ok(delivered.every(body=>JSON.stringify(body.messages).includes(JSON.stringify(standing).slice(1,-1))));
    const reviews=run.events.filter(row=>row.data?.type==='chat.execution-review').map(row=>row.data);
    assert.deepEqual(reviews.map(row=>row.reviewDecision),['continue','accepted']);
    assert.equal(reviews.at(-1).reason,'task-outcome-supported');
    assert.ok(reviews.every(row=>row.outcomeVerification==='not-evaluated'));
    assert.equal(run.nodes.agent.output,output);
  });
});

async function nativeFixture(t,execute,input=task) {
  const cwd=await tempFixture(t,'blackice-chat-continuation-events-');
  let context;
  class Runtime extends EventEmitter {
    status(){return{connected:true,authenticated:true,defaultModel:'fixture::fixture',models:[{id:'fixture::fixture',supportsTools:true}]};}
    async runAgent(options){
      if(options.prompt.includes('BLACKICE ORDINARY TASK OUTCOME REVIEW')){
        assert.equal(options.hostOnlyTools,true);assert.equal(options.sandbox,'read-only');
        return {output:syntheticOutcomeResponse({messages:[{role:'user',content:options.prompt}]}).choices[0].message.content};
      }
      options.onEvent?.({type:'thread',threadId:'fixture-worker',model:'fixture::fixture',effort:'low'});
      return execute(options,context);
    }
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

test('real compatible continuations preserve temporal scope for new exports and historical reports',{timeout:20000},async t=>{
 for(const scenario of [
  {name:'new action',input:'Create one additional export from the current records.',create:true},
  {name:'past information',input:'Report when the previous export was produced. Do not create another export.',create:false}
 ])await t.test(scenario.name,async t=>{
  const cwd=await tempFixture(t,'blackice-chat-continuation-provider-'),requests=[],actions=[];
  let engine,runtime,identity,index=0,opened=false,tabOwner,created=false;
  const oldReceipt='Historical export receipt old-export: completed on 2026-01-01.';
  const newReceipt='Current requested export receipt new-export: completed.';
  const response=message=>({choices:[{index:0,finish_reason:message.tool_calls?'tool_calls':'stop',message:{role:'assistant',...message}}]});
  const tool=(id,args)=>response({content:null,tool_calls:[{id,type:'function',function:{name:'relay_browser',arguments:JSON.stringify({browser:'relay',...args})}}]});
  const script=[
   tool('read-export',{action:'open',url:'https://fixture.invalid/exports'}),
   response({content:oldReceipt}),
   ...(scenario.create?[
    tool('create-export',{action:'click',tabId:'export-tab',ref:'create-export'}),
    response({content:newReceipt}),response({content:newReceipt})
   ]:[response({content:oldReceipt})])
  ];
  const server=http.createServer(async(req,res)=>{
   res.setHeader('Content-Type','application/json');
   if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
   let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));
    if(outcomeRequest(requests.at(-1))){res.end(JSON.stringify(syntheticOutcomeResponse(requests.at(-1))));return;}
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
   status:()=>({available:true,contained:true,tabs:opened?[{tabId:'export-tab',owner:tabOwner,url:'https://fixture.invalid/exports'}]:[]}),
   perform:async(args,context)=>{
    actions.push({...args});if(args.action==='open'){opened=true;tabOwner=context.owner;}
    if(args.action==='click')created=true;
    return{tabId:'export-tab',documentId:'export-document',url:'https://fixture.invalid/exports',
     text:created?newReceipt:oldReceipt,
     frames:[{frameId:'main',documentId:'export-document',url:'https://fixture.invalid/exports',observation:'content-observed',
      text:created?newReceipt:oldReceipt,elements:[{ref:'create-export',tag:'button',type:'button',name:'Create export'}]}]};
   }
  }}).init();
  const run=await settled(engine,begin(engine,cwd,scenario.input));
  assert.equal(run.status,'completed',run.error||run.nodes.agent.error);
  assert.equal(run.input,scenario.input);
  assert.equal(requests.length,scenario.create?6:4);
  assert.equal(requests.filter(outcomeRequest).length,1);
  assert.deepEqual(actions.map(row=>row.action),scenario.create?['open','click']:['open'],'historical reporting does not dispatch new work or replay an effect');
  const continuations=requests.map(body=>body.messages.at(-1)).filter(message=>message?.role==='user'&&message.content.startsWith('[BLACKICE INTERNAL CONTINUATION]'));
  assert.equal(continuations.length,scenario.create?2:1);
  for(const message of continuations){
   assert.equal(continuedRequest(message.content),scenario.input);
   assert.match(message.content,/Match evidence to the current request's time and count/);
   assert.match(message.content,/Reading an old receipt now does not make its action new/);
   assert.match(message.content,/Earlier effects can satisfy a state or history request/);
   assert.match(message.content,/including earlier or resumed attempts/);
  }
  const sharedMethod="Verified effect within the current request's time and count";
  const executionRequests=requests.filter(body=>!outcomeRequest(body));
  const reviewRequests=requests.filter(outcomeRequest);
  assert.ok(executionRequests.length>0&&executionRequests.every(body=>!JSON.stringify(body.messages).includes(sharedMethod)),
    'no ambient completion skill is injected into the provider; the core and outcome reviews still govern completion');
  assert.ok(reviewRequests.length>0&&reviewRequests.every(body=>!JSON.stringify(body.messages).includes(sharedMethod)),
    'the independent outcome reviewer does not inherit worker-only instructions');
  const reviews=run.events.filter(row=>row.data?.type==='chat.execution-review').map(row=>row.data);
  assert.deepEqual(reviews.map(row=>row.reviewDecision),scenario.create?['continue','continue','accepted']:['continue','accepted']);
  assert.equal(reviews.at(-1).reason,'task-outcome-supported');
  assert.ok(reviews.every(row=>row.outcomeVerification==='not-evaluated'));
  assert.equal(run.nodes.agent.output,scenario.create?newReceipt:oldReceipt);
  if(scenario.create)assert.doesNotMatch(JSON.stringify(publicAnswers(run)),/Historical export receipt old-export/,'superseded historical candidate stays out of the public final');
 });
});


test('P actual Compatible stalled export invokes same-model outcome review and performs remaining work',{timeout:20000},async t=>{
 const input='Create one additional export from the current records.';
 const cwd=await tempFixture(t,'blackice-chat-continuation-provider-'),requests=[],actions=[],runtimeCalls=[];
 let engine,runtime,identity,index=0,opened=false,tabOwner,created=false;
 const partial='The current export form is ready, but the requested export has not been created.';
 const done='The current requested export is complete: receipt current-export.';
 const response=message=>({choices:[{index:0,finish_reason:message.tool_calls?'tool_calls':'stop',message:{role:'assistant',...message}}]});
 const tool=(id,args)=>response({content:null,tool_calls:[{id,type:'function',function:{name:'relay_browser',arguments:JSON.stringify({browser:'relay',...args})}}]});
 const script=[
  tool('open-export',{action:'open',url:'https://fixture.invalid/exports'}),response({content:partial}),
  tool('inspect-export-1',{action:'snapshot',tabId:'export-tab'}),response({content:partial}),
  tool('inspect-export-2',{action:'snapshot',tabId:'export-tab'}),response({content:partial}),
  tool('create-current-export',{action:'click',tabId:'export-tab',ref:'create-export'}),response({content:done}),response({content:done}),
 ];
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);requests.push(body);
  const prompt=body.messages.filter(row=>row.role==='user').map(row=>row.content).join('\n');
  if(prompt.includes('BLACKICE ORDINARY TASK OUTCOME REVIEW')){
   const {snapshot}=JSON.parse(prompt.split('\nREVIEW DATA (JSON):\n').at(-1));
   assert.equal(snapshot.request,input);
   const ref=snapshot.evidence.records.at(-1)?.citationRef||'user-request';
   res.end(JSON.stringify(response({content:JSON.stringify({decision:created?'respond':'continue',
    summary:created?'The requested new export has a current receipt.':'The requested export remains actionable.',
    remaining:created?[]:['Create the requested export.'],nextAction:created?'':'Use the available Create export control and inspect its result.',
    evidenceRefs:[ref],blockers:[]})})));return;
  }
  const reply=script[index++];if(!reply){res.statusCode=500;res.end(JSON.stringify({error:{message:'Unexpected extra worker request'}}));return;}
  res.end(JSON.stringify(reply));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await engine?.close();await runtime?.close();await identity?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await removeFixture(cwd);});
 runtime=new ProviderRuntime({codex:new NoLiveNative(),dataDir:cwd,modelLimitResolver:{enrich:async(_config,model)=>model}});
 await runtime.store.init();await runtime.saveProvider({id:'fixture',type:'compatible',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',
  models:[{id:'fixture',contextWindowTokens:65536,maxOutputTokens:4096}]},{preserveDefault:true});
 const actualRun=runtime.runAgent.bind(runtime);runtime.runAgent=options=>{runtimeCalls.push(options);return actualRun(options);};
 const dataDir=path.join(cwd,'engine');identity=await new IdentityStore({dataDir}).init();
 engine=await new HarnessEngine({runtime,dataDir,defaultCwd:cwd,identity,browser:{
  status:()=>({available:true,contained:true,tabs:opened?[{tabId:'export-tab',owner:tabOwner,url:'https://fixture.invalid/exports'}]:[]}),
  perform:async(args,context)=>{
   actions.push({...args});if(args.action==='open'){opened=true;tabOwner=context.owner;}
   if(args.action==='click')created=true;
   return{tabId:'export-tab',documentId:'export-document',url:'https://fixture.invalid/exports',text:created?done:partial,
    frames:[{frameId:'main',documentId:'export-document',url:'https://fixture.invalid/exports',observation:'content-observed',
     text:created?done:partial,elements:[{ref:'create-export',tag:'button',type:'button',name:'Create export'}]}]};
  }
 }}).init();
 const standing='OWNER_OUTCOME_FIXTURE\nHonor the current request, its limits and good-faith delegated choices.';
 const prior=await engine.instructionSettings.read();await engine.instructionSettings.update({content:standing,expectedRevision:prior.revision,expectedHash:prior.hash});
 const workflow=createMissionWorkflow({id:'mission_chat_stalled_export_fixture',task:input,cwd,model:'fixture::fixture',planningMode:'off'});
 workflow.nodes.find(node=>node.type==='agent').effort='low';
 const run=await settled(engine,engine.startRun({workflow,input:{task:input,cwd,planningMode:'off',chatPlanning:'off',directoryActions:'off',directoryDiagnostics:'maximal'}}));
 assert.equal(run.status,'completed',run.error||run.nodes.agent.error);
 assert.equal(run.input,input);assert.equal(run.nodes.agent.output,done,'a prior unchanged snapshot cannot finish the requested new action');
 assert.deepEqual(actions.map(row=>row.action),['open','snapshot','snapshot','click']);
 const reviewers=runtimeCalls.filter(options=>options.prompt.includes('BLACKICE ORDINARY TASK OUTCOME REVIEW'));
 assert.equal(reviewers.length,2);assert.equal(runtimeCalls.length,3);
 for(const options of reviewers){
  assert.equal(options.model,'fixture::fixture');assert.equal(options.effort,'low');
  assert.equal(options.sandbox,'read-only');assert.equal(options.hostOnlyTools,true);
  assert.ok(!options.dynamicTools?.some(tool=>tool.name==='relay_browser'));
  assert.equal(options.developerInstructions,runtimeCalls[0].developerInstructions);
  assert.ok(options.developerInstructions.includes(standing));
 }
 assert.equal(requests.length,11,'nine worker calls and two explicit outcome assessments');
 const outcome=run.events.filter(event=>event.data?.type==='chat.outcome-review'&&event.data.status==='validated').map(event=>event.data);
 assert.deepEqual(outcome.map(row=>row.decision),['continue','respond']);
 assert.ok(outcome.every(row=>row.verified===false&&row.model==='fixture::fixture'&&row.effort==='low'));
 assert.doesNotMatch(JSON.stringify(publicAnswers(run)),/requested export has not been created/);
 assert.equal(run.chatPlanning,'off');assert.notEqual(run.directoryActions,'on');assert.ok(!run.goal);
});


test('P actual native outcome review nests protected sessions without blocking the worker or replaying report work',{timeout:15000},async t=>{
  const {CodexRuntime}=await import('../lib/codex.mjs');
  const {PLANNING_RESPONSE_DISABLED_FEATURES}=await import('../lib/response-profile.mjs');
  const cwd=await tempFixture(t,'blackice-chat-continuation-events-');
  const protocol=[],sent=[],threads=new Map(),asyncFailures=[];
  let engine,nextThread=0,nextTurn=0,nextCall=0,reviewTurns=0,parentThreadId,workerCalls=0;
  const runtime=new CodexRuntime({command:process.execPath,cwd,requestTimeoutMs:1000,runTimeoutMs:10000,
    spawnImpl(){assert.fail('The native protocol fixture must never launch a process.');}});
  runtime.child={};
  Object.assign(runtime.info,{connected:true,authenticated:true,defaultModel:'fixture-native',
    models:[{id:'fixture-native',model:'fixture-native',isDefault:true,supportsTools:true,
      defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}],
      contextWindowTokens:128000}]});
  const tick=()=>new Promise(resolve=>setImmediate(resolve));
  const until=async predicate=>{for(let i=0;i<5000;i++){if(asyncFailures.length)throw asyncFailures[0];if(predicate())return;await new Promise(resolve=>setTimeout(resolve,1));}assert.fail('Native fixture did not reach the expected protocol state.');};
  const complete=(state,text)=>{
    const item={type:'agentMessage',id:'answer-'+state.turnId,phase:'final_answer',text};
    runtime._notification('thread/tokenUsage/updated',{threadId:state.threadId,turnId:state.turnId,
      tokenUsage:{total:{inputTokens:10,outputTokens:5,totalTokens:15},last:{inputTokens:10,outputTokens:5,totalTokens:15}}});
    runtime._notification('item/completed',{threadId:state.threadId,turnId:state.turnId,item});
    runtime._notification('turn/completed',{threadId:state.threadId,turn:{id:state.turnId,status:'completed',items:[item]}});
  };
  const corrected='The current source says the archive is available. No files were modified.';
  runtime._request=async(method,params={})=>{
    protocol.push({method,params:structuredClone(params)});
    if(method==='config/read')return{config:{plugins:{},mcp_servers:{},skills:{config:[]}}};
    if(method==='skills/list')return{data:(params.cwds||[]).map(cwd=>({cwd,skills:[],errors:[]}))};
    if(method==='experimentalFeature/list'){
      const config=threads.get(params.threadId)?.config||{};
      return{data:PLANNING_RESPONSE_DISABLED_FEATURES.map(name=>({name,stage:'stable',enabled:config['features.'+name]!==false})),nextCursor:null};
    }
    if(method==='thread/start'){
      const id='native-nested-'+(++nextThread);threads.set(id,params);
      return{thread:{id,ephemeral:Boolean(params.ephemeral)},sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'never',model:params.model};
    }
    if(method==='turn/start'){
      const id='native-turn-'+(++nextTurn),prompt=params.input.map(row=>row.text||'').join('\n');
      if(prompt.includes('BLACKICE ORDINARY TASK OUTCOME REVIEW')){
        const phase=++reviewTurns;
        assert.ok(runtime.threads.has(parentThreadId),'the parent remains admitted while its reviewer starts');
        assert.notEqual(params.threadId,parentThreadId,'review must not resume the busy worker thread');
        setImmediate(()=>{(async()=>{
          const state=runtime.threads.get(params.threadId);await until(()=>state?.turnId===id);
          const seen=JSON.parse(prompt.split(outcomeBoundary).at(-1)),record=seen.snapshot.evidence.records[0];
          assert.equal(seen.snapshot.request,input);assert.equal(seen.snapshot.savedReview.mode,'indexed-exact-sources');
          assert.deepEqual(state.dynamicTools.map(tool=>tool.name),['relay_directory_context']);
          const callId='review-read-'+(++nextCall),messageId=100+nextCall;
          await runtime._dynamicToolCall({id:messageId,params:{threadId:state.threadId,turnId:state.turnId,callId,
            tool:'relay_directory_context',arguments:{action:'read',ref:record.savedSource.ref,offset:0,limit:4096}}});
          assert.equal(sent.find(message=>message.id===messageId)?.result?.success,true,'the actual host-bound read settled before assessment');
          const value={decision:phase===1?'revise_response':'respond',
            summary:phase===1?'The response denies the recorded source text.':phase===2?corrected:'The corrected report matches the observed source.',
            remaining:[],nextAction:phase===1?'Correct the report using the already recorded source.':'',
            evidenceRefs:[record.citationRef],metadataOnlyRefs:[],blockers:[]};
          if(phase===2)assert.match(prompt,/READ-ONLY REPORT SYNTHESIS/);
          if(phase===3)assert.equal(seen.candidate.output,corrected);
          complete(state,JSON.stringify(value));
        })().catch(error=>{asyncFailures.push(error);runtime._connectionFailed(error,runtime.child);});});
      }else{parentThreadId??=params.threadId;workerCalls++;}
      return{turn:{id,status:'inProgress'}};
    }
    if(['thread/unsubscribe','turn/interrupt'].includes(method))return{};
    throw Error('Unexpected native fixture request '+method);
  };
  runtime._send=message=>sent.push(message);
  engine=await new HarnessEngine({runtime,dataDir:path.join(cwd,'engine'),defaultCwd:cwd}).init();
  t.after(async()=>{
    runtime.closing=true;runtime._connectionFailed(Object.assign(new Error('Fixture closed.'),{code:'CODEX_CLOSED'}),runtime.child);
    await engine.close();await removeFixture(cwd);
  });
  const input='Summarize the opening statement from the current source. Do not modify files.';
  const workflow=createMissionWorkflow({id:'mission_chat_native_outcome',task:input,cwd,model:'default',planningMode:'off'});
  const agent=workflow.nodes.find(node=>node.type==='agent');agent.effort='default';agent.serviceTier='default';
  const run=engine.startRun({workflow,input:{task:input,cwd,planningMode:'off',chatPlanning:'off',directoryActions:'off',directoryDiagnostics:'maximal'}});
  await until(()=>parentThreadId&&runtime.threads.get(parentThreadId)?.turnId);
  const state=runtime.threads.get(parentThreadId),firstTurn=state.turnId;
  const item={type:'webSearch',id:'native-current-read',query:'current source',action:{type:'search',queries:['current source']},
    results:[{type:'text_result',domain:'fixture.invalid',ref_id:'turn1search0',title:'Current source',
      url:'https://fixture.invalid/current',snippet:'The archive is available. '+ 'x'.repeat(300000)}]};
  runtime._notification('item/completed',{threadId:parentThreadId,turnId:firstTurn,item});
  complete(state,'I have not read the current source.');
  await until(()=>state.turnId!==firstTurn);
  complete(state,'I have not read the current source.');
  const final=await settled(engine,run);if(asyncFailures.length)throw asyncFailures[0];
  assert.equal(final.status,'completed',JSON.stringify({error:final.error||final.nodes.agent.error,outcomes:final.events.filter(row=>row.data?.type==='chat.outcome-review').map(row=>row.data),protocol:protocol.map(row=>({method:row.method,threadId:row.params.threadId,model:row.params.model}))}));
  assert.equal(final.input,input);assert.equal(final.nodes.agent.output,corrected);
  assert.equal(workerCalls,2,'read-only report repair must not start another operational worker turn');
  assert.equal(reviewTurns,3,'assessment, synthesis and re-assessment are separately bounded');
  assert.equal(nextCall,3);assert.equal(runtime.threads.size,0);
  const parentParams=threads.get(parentThreadId);
  const reviewerStarts=protocol.filter(row=>row.method==='thread/start'&&row.params.dynamicTools?.some(tool=>tool.name==='relay_directory_context'));
  assert.equal(reviewerStarts.length,3);
  for(const row of reviewerStarts){
    assert.equal(row.params.model,'fixture-native');assert.equal(row.params.serviceTier,'default');
    assert.equal(row.params.sandbox,'read-only');assert.equal(row.params.approvalPolicy,'never');
    assert.equal(row.params.allowProviderModelFallback,false);
    assert.ok(row.params.developerInstructions.startsWith(parentParams.developerInstructions));
    assert.deepEqual(row.params.dynamicTools.map(tool=>tool.name),['relay_directory_context']);
    assert.ok(PLANNING_RESPONSE_DISABLED_FEATURES.every(name=>row.params.config['features.'+name]===false));
  }
  const reviewerIds=protocol.filter(row=>row.method==='turn/start'&&row.params.threadId!==parentThreadId).map(row=>row.params.threadId);
  for(const row of protocol.filter(row=>row.method==='turn/start'&&reviewerIds.includes(row.params.threadId))){
    assert.equal(row.params.model,'fixture-native');assert.equal(row.params.effort,'medium');
    assert.equal(row.params.serviceTier,'default');assert.deepEqual(row.params.sandboxPolicy,{type:'readOnly',networkAccess:false});
  }
  assert.ok(reviewerIds.every(id=>protocol.some(row=>row.method==='thread/unsubscribe'&&row.params.threadId===id)));
  assert.doesNotMatch(JSON.stringify(publicAnswers(final)),/I have not read/);
  assert.match(JSON.stringify(publicAnswers(final)),/ordinary-chat-readonly-report-synthesis/);
  const outcome=final.events.filter(row=>row.data?.type==='chat.outcome-review').map(row=>row.data);
  assert.equal(outcome.filter(row=>row.status==='validated').length,3);
  assert.ok(outcome.every(row=>row.verified===false&&row.model==='fixture-native'&&row.effort==='medium'));
  assert.equal(outcome.filter(row=>row.status==='provider').length,3);
  const decisions=final.events.filter(row=>row.data?.type==='chat.execution-review').map(row=>row.data);
  assert.deepEqual(decisions.map(row=>row.evidenceRevision),[1,1],'nested reads/review activity must not manufacture worker task progress');
  assert.equal(final.outcomeReviewUsage.totalTokens,45,'all three native read-only phases are accounted separately');
  assert.equal(final.planningMode,'off');assert.notEqual(final.directoryActions,'on');
});
