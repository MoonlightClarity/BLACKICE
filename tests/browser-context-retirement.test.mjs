import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {DirectTaskRuntime} from '../lib/direct-task-runtime.mjs';
import {BrowserWorkspace,createBrowserToolHandler} from '../lib/browser.mjs';
import {browserReceiptBindingKey} from '../lib/operation-descriptors.mjs';
import {observePageReceiptRecords} from '../desktop/browser-operation-observation.mjs';
import {BrowserSubmissionObservations,urlencodedFormPayloadDigest} from '../desktop/browser-submission-observation.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const action='https://portal.test/enroll',origin='origin:https://portal.test',ownerId='owner',tabId='relay:one';
const receiptBinding=()=>({version:1,format:'dom',resourceKey:origin,record:'#receipt',status:'data-status',confirmedValues:['confirmed'],absentValues:['absent'],outcomeId:'data-outcome',destination:'data-form-action',history:false,prior:{field:'data-prior',values:['true']},identity:[{field:'data-participant',formField:'participantId'},{field:'data-workshop',formField:'workshopId'}]});
const contract=(targetCount=1)=>({contractVersion:2,goal:'Produce one distinct new enrollment with verified evidence.',criteria:[{id:'receipt',kind:'external-confirmation',description:'One new distinct confirmed enrollment',targetCount,receiptBinding:receiptBinding()}],workItems:[{id:'enroll',title:'Enroll',objective:'Submit and verify',owner:'main',resourceKeys:[origin],effects:['observe','interact','commit'],dependsOn:[],criterionIds:['receipt']}],instructions:[]});
const payload=r=>JSON.parse(r.contentItems.find(i=>i.type==='inputText').text);
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'direct-task-runtime-')),tracker=new BrowserSubmissionObservations();
 const page={documentId:'one:1',loaderId:'loader-1',frameId:'frame-1',url:action,participant:'p1',workshop:'w1',optional:'resume-v1',status:'absent',prior:'false',lostResponse:false,missingReceipt:false,stickyReceipt:false};
 let commits=0,reads=0,interactions=0;
 const fields=()=>[['participantId',page.participant],['workshopId',page.workshop],['optional',page.optional]];
 const form=()=>({id:'form1',documentId:page.documentId,action,method:'POST',enctype:'application/x-www-form-urlencoded',target:'_self',payloadDigest:hash(fields()),requestPayloadDigest:urlencodedFormPayloadDigest(new URLSearchParams(fields()).toString()),attachmentDigests:[],identityDigests:fields().map(([name,value])=>({name,digest:hash(value)}))});
 const attrs=()=>({'data-status':page.status,'data-outcome':page.participant+':'+page.workshop,'data-participant':page.participant,'data-workshop':page.workshop,'data-form-action':action,'data-prior':page.prior});
 const receipts=bindings=>{
  const previous=globalThis.document;
  try{
   globalThis.document={querySelectorAll:selector=>selector==='#receipt'&&page.status?[{attributes:Object.entries(attrs()).map(([name,value])=>({name,value})),innerText:page.status,getAttribute:name=>attrs()[name]??null}]:[]};
   return observePageReceiptRecords(bindings).map((record,i)=>({bindingKey:browserReceiptBindingKey(bindings[i]),...record}));
  }finally{globalThis.document=previous;}
 };
 const driver={
  status:()=>({available:true,contained:true,containedAvailable:true,activeTab:tabId,tabs:[{browser:'relay',tabId,url:page.url,documentId:page.documentId,purpose:'user'}]}),
  observeOperation:async(args,options={})=>({current:(!options.expectedDocumentId||options.expectedDocumentId===page.documentId)&&(!options.expectedUrl||options.expectedUrl===page.url),tabId,documentId:page.documentId,url:page.url,frameId:page.frameId,loaderId:page.loaderId,
   ...(args.action==='click'?{control:{ref:args.ref,kind:'form-submit',form:form()}}:args.action==='fill'?{control:{ref:args.ref,kind:'field'}}:{}),
   submissionCorrelations:tracker.current(page),receipts:receipts(options.receiptBindings||[])}),
  perform:async(args,context)=>{
   if(args.action==='click'){
    commits++;const postData=new URLSearchParams(fields()).toString(),sourceLoaderId=page.loaderId,sourceDocumentId=page.documentId;
    assert.equal(tracker.arm({operationId:context.operationId,commit:context.operationDescriptor.commit,sourceFrameId:page.frameId,sourceLoaderId,sourceDocumentId}),true);
    page.loaderId='response-'+commits;page.documentId='one:'+(commits+1);if(!page.stickyReceipt)page.status=page.missingReceipt?null:'confirmed';
    const requestId='request-'+commits;
    tracker.observe('Network.requestWillBeSent',{type:'Document',requestId,frameId:page.frameId,loaderId:page.loaderId,request:{method:'POST',url:action,postData,headers:{'Content-Type':'application/x-www-form-urlencoded'}}});
    tracker.observe('Network.responseReceived',{type:'Document',requestId,loaderId:page.loaderId,response:{url:action,status:200}});
    tracker.observe('Network.loadingFinished',{requestId});
    if(page.lostResponse)throw Object.assign(Error('Native response lost'),{code:'BROWSER_RESPONSE_LOST',actionDispatched:true});
   }else if(args.action==='read')reads++;
   else if(args.action==='fill'){interactions++;page.optional=args.text;}
   return {tabId,documentId:page.documentId,url:page.url,text:page.status||'No receipt',frames:[]};
  }
 };
 const finalizers=[];const browser=new BrowserWorkspace({driver});let runtime=new DirectTaskRuntime({dataDir:root,browser}),seq=0;
 t.after(async()=>{for(const finish of finalizers)await finish();await runtime.close();await fs.rm(root,{recursive:true,force:true});});
 const bind=async(taskId='task',targetCount=1)=>{
  await runtime.create({ownerId,taskId,contract:contract(targetCount)});
  return runtime.bind({ownerId,taskId,tabId,workItemId:'enroll',criterionId:'receipt',identityFields:['participantId','workshopId'],ref:'submit',expectedUrl:page.url,expectedDocumentId:page.documentId});
 };
 const reconcile=(binding,phase='baseline',taskId='task')=>runtime.reconcile({ownerId,taskId,tabId,bindingId:binding.bindingId,phase});
 const execute=(verb='click',extra={})=>{
  const call={name:'relay_browser',arguments:{action:verb,browser:'relay',tabId,...(verb==='click'?{ref:'submit',expectedUrl:page.url,expectedDocumentId:page.documentId}:{}),...extra}};
  return runtime.execute({ownerId,operationId:'op-'+(++seq),handler:runtime.handler(ownerId),call});
 };
 return {root,browser,cleanup:fn=>finalizers.push(fn),page,bind,reconcile,execute,counts:()=>({commits,reads,interactions}),measure:(taskId='task')=>runtime.measure({ownerId,taskId}),reopen:async()=>{await runtime.close();runtime=new DirectTaskRuntime({dataDir:root,browser});},runtime:()=>runtime};
}



import {NativeTaskContextBridge} from '../lib/native-task-context-bridge.mjs';
import {EventEmitter} from 'node:events';
import {HarnessEngine} from '../lib/engine.mjs';
import {TaskStateStore} from '../lib/task-state.mjs';
const client={id:ownerId,kind:'chatgpt',label:'Owner',scopes:['planning:write','browser:read','browser:write','files:read']};
test('actual engine continuation ignores rehydrated receipt gates and preserves native call replay',async t=>{
 const f=await fixture(t),binding=await f.bind();await f.reconcile(binding);const shared=f.runtime();
 const directory=path.join(f.root,'native-engine');await fs.mkdir(directory);
 const tasks=await new TaskStateStore({dataDir:directory}).init();let stage=0,callSequence=0,nativeTaskId;
 let credentialDispatches=0;
 const original=f.browser.driver;
 const nativeBrowser=new BrowserWorkspace({driver:{...original,status:()=>{const status=original.status();return {...status,tabs:status.tabs.map(tab=>({...tab,owner:{taskId:nativeTaskId||'unbound',runId:'native',nodeId:'agent'}}))};}}});
 nativeBrowser.fillCredential=async()=>assert.fail('No fallback fill');
 nativeBrowser.authenticateCredential=async(args,options)=>{
  await options.beforeDispatch({action:'authenticate',intent:'login',origin:'https://portal.test'});
  credentialDispatches++;return {submissionRequested:true,authenticated:false,outcome:'dispatched'};
 };
 const credentials={status:async()=>({available:true,healthy:true})};
 class FixtureRuntime extends EventEmitter{
  status(){return {connected:true,authenticated:true,defaultModel:'fixture-native',models:[{id:'fixture-native',supportsTools:true}]};}
  async runAgent(options){
   const invoke=(name,args)=>options.onToolCall({name,arguments:args,callId:'call-'+(++callSequence)+'-'+name},{signal:options.signal});
   const phase=stage++;
   if(phase===0){const read=await invoke('relay_task',{action:'read'});assert.equal(read.success,true,JSON.stringify(read));const state=payload(read);const saved=await invoke('relay_task',{action:'plan',expectedRevision:state.revision,contract:contract()});assert.equal(saved.success,true,JSON.stringify(saved));return {output:'Plan saved.',threadId:'native-fixture-first'};}
   assert.equal(options.threadId, phase===1?'native-fixture-first':'native-fixture-second','Continue the native provider session rather than silently opening a fresh thread.');
   assert.notEqual(options.hostOnlyTools,true);
   if(phase>=2){
     const repeat=await invoke('relay_browser',{action:'click',browser:'relay',tabId,ref:'submit',expectedUrl:f.page.url,expectedDocumentId:f.page.documentId});
     assert.equal(repeat.success,true,JSON.stringify(repeat));
     return {output:'Next login interaction completed.',threadId:'native-fixture-third'};
   }
   const auth=await invoke('relay_credentials',{action:'authenticate',origin:'https://portal.test',credentialId:'credential_fixture',revision:1,browser:'relay',tabId,expectedUrl:f.page.url,expectedDocumentId:f.page.documentId,passwordRef:'password',submitRef:'submit',intent:'login',requestId:'attached-auth'});
   assert.equal(auth.success,true,JSON.stringify(auth));assert.equal(credentialDispatches,1);
   assert.equal(payload(auth).authenticated,false);
   const input={name:'relay_browser',arguments:{action:'click',browser:'relay',tabId,ref:'Next',expectedUrl:f.page.url,expectedDocumentId:f.page.documentId},callId:'login-next-same-call'};
   const result=await options.onToolCall(input,{signal:options.signal});
   const replay=await options.onToolCall(input,{signal:options.signal});
   assert.deepEqual(replay,result);assert.equal(f.counts().commits,1,'same native call ID must not repeat input');
   assert.equal(result.success,true,JSON.stringify(result));assert.equal((await options.onBeforeFinal?.({output:'Login complete.'}))??null,null);
   return {output:'Verified enrollment.',threadId:'native-fixture-second'};
  }
  async close(){}
 }
 const provider=new FixtureRuntime(),engine=await new HarnessEngine({runtime:provider,tasks,credentials,browser:nativeBrowser,dataDir:directory,defaultCwd:f.root}).init();
 engine.runtimeSettings={get:()=>({executionGuardrails:false,subagentsEnabled:false,codexHistory:"codex"})};
 f.cleanup(async()=>{await engine.close();await tasks.close();});
 const workflow={id:'native-context-e2e',name:'Native context end-to-end',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'fixture-native',prompt:'Follow the requested task.'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1}};
 const first=engine.startRun({workflow,input:'/plan Plan the enrollment.',planningMode:'off'});await engine.executions.get(first.id);assert.equal(engine.getRun(first.id).status,'completed',engine.getRun(first.id).error);nativeTaskId=first.id;
 const handle=await shared.issueContext({ownerId,taskId:'task',expectedRevision:(await shared.read({ownerId,taskId:'task'})).revision,workItemId:'enroll',criterionId:'receipt',adapters:['relay_browser','relay_workspace'],bindingId:binding.bindingId});
 engine.nativeTaskContextBridge=new NativeTaskContextBridge({runtime:shared,tasks,isActive:id=>[...engine.runs.values()].some(run=>(run.taskId||run.id)===id&&run.settled!==true),canEnforceProtectedDispatch:()=>true});
 await engine.nativeTaskContextBridge.attach({nativeTaskId,expectedNativeRevision:(await tasks.get(nativeTaskId)).revision,taskContext:handle.taskContext,client});
 const next=engine.continueRun(first.id,{nodeId:'agent',message:'/plan Execute the reviewed enrollment.',planningMode:'off'});await engine.executions.get(next.id);const done=engine.getRun(next.id);
 assert.equal(done.status,'completed',done.error||done.nodes.agent.error);assert.equal(f.counts().commits,1);assert.equal((await f.measure()).satisfied,false,'Ordinary native receipt is not invented contract completion');
 await shared.revokeContext({ownerId,taskContext:handle.taskContext,expectedGeneration:1});
 let helperCalls=0;engine.responseCycle={forRun:async()=>{helperCalls++;return null;}};
 const blocked=engine.continueRun(next.id,{nodeId:'agent',message:'/plan Inspect protected work.',planningMode:'off'});await engine.executions.get(blocked.id);
 assert.equal(engine.getRun(blocked.id).status,'completed',engine.getRun(blocked.id).error);
 assert.equal(helperCalls,0,'the removed readiness pipeline must not run');
 assert.equal(stage,3);
 assert.equal(f.counts().commits,2,'new explicit interactions are not vetoed by an old task attachment');
});


test('explicit stale context login Next dispatches without a planning grant or receipt contract and exact request replay never repeats it',async t=>{
 const f=await fixture(t),{DirectExecutionAPI,DIRECT_EXECUTION_SCOPES}=await import('../lib/direct-execution-api.mjs');
 const api=new DirectExecutionAPI({dataDir:f.root,allowedRoot:f.root,browser:f.browser});f.cleanup(()=>api.close());await api.init();
 const client={id:ownerId,label:'Test external caller',kind:'chatgpt',scopes:['read','browser:read','browser:write']};
 const request={taskContext:'taskctx_00000000-0000-4000-8000-000000000001',requestId:'login-next',action:'click',tabId,ref:'Next',expectedUrl:f.page.url,expectedDocumentId:f.page.documentId};
 f.page.missingReceipt=true;
 const pending=await api.call('blackice_browser_action',request,client);
 const concurrent=await api.call('blackice_browser_action',request,client);
 assert.equal(concurrent.jobId,pending.jobId);
 let done;
 for(let i=0;i<1000;i++){done=await api.getJob(pending.jobId,client);if(done.settled)break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(done.status,'succeeded',JSON.stringify(done));
 assert.equal(f.counts().commits,1);
 assert.equal(done.interaction,null);
 assert.equal(done.result.text.text.includes('taskVerification'),false,'No business completion is invented for a login click.');
 const replay=await api.call('blackice_browser_action',request,client);
 assert.equal(replay.existing,true);assert.equal(replay.jobId,pending.jobId);
 assert.equal(f.counts().commits,1);
 assert.equal((await api.getJob(pending.jobId,client)).result.text.text,done.result.text.text);
});

test('unbound lost response remains observable and replay does not repeat the dispatched action',async t=>{
 const f=await fixture(t),{DirectExecutionAPI,DIRECT_EXECUTION_SCOPES}=await import('../lib/direct-execution-api.mjs');
 const api=new DirectExecutionAPI({dataDir:f.root,allowedRoot:f.root,browser:f.browser});f.cleanup(()=>api.close());await api.init();
 const client={id:ownerId,label:'Test external caller',kind:'chatgpt',scopes:['read','browser:read','browser:write']};
 const request={requestId:'login-lost',action:'click',tabId,ref:'Next',expectedUrl:f.page.url,expectedDocumentId:f.page.documentId};
 f.page.lostResponse=true;
 const pending=await api.call('blackice_browser_action',request,client);
 let done;
 for(let i=0;i<1000;i++){done=await api.getJob(pending.jobId,client);if(done.settled)break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(done.status,'failed');assert.match(done.result.text.text,/BROWSER_RESPONSE_LOST/);
 assert.equal(f.counts().commits,1);
 const replay=await api.call('blackice_browser_action',request,client);
 assert.equal(replay.existing,true);assert.equal(replay.jobId,pending.jobId);assert.equal(f.counts().commits,1);
});

test('retiring native enforcement preserves attachment ownership checks and stored evidence',async t=>{
 const f=await fixture(t),binding=await f.bind();await f.reconcile(binding);f.page.lostResponse=true;await f.execute();
 const runtime=f.runtime(),saved={taskId:'native-task',revision:7,taskSchemaVersion:14,contract:contract()};
 const bridge=new NativeTaskContextBridge({runtime,tasks:{get:async()=>structuredClone(saved)},canEnforceProtectedDispatch:()=>true});
 const context=await runtime.issueContext({ownerId,taskId:'task',expectedRevision:(await runtime.read({ownerId,taskId:'task'})).revision,workItemId:'enroll',criterionId:'receipt',adapters:['relay_browser'],bindingId:binding.bindingId});
 const args={nativeTaskId:'native-task',expectedNativeRevision:7,taskContext:context.taskContext,client};
 await assert.rejects(bridge.attach({...args,client:{...client,id:'foreign'}}));
 const attachment=await bridge.attach(args);
 const evidence=structuredClone(runtime.outcomes.state.outcomes);
 await runtime.revokeContext({ownerId,taskContext:context.taskContext,expectedGeneration:1});
 saved.revision++;saved.contract.goal='New request';
 assert.equal(await bridge.open({nativeTaskId:'native-task',runId:'resumed'}),null);
 assert.deepEqual(runtime.outcomes.state.outcomes,evidence);
 await assert.rejects(bridge.detach({nativeTaskId:'native-task',expectedNativeRevision:8,expectedGeneration:attachment.generation,client:{...client,id:'foreign'}}));
 const removed=await bridge.detach({nativeTaskId:'native-task',expectedNativeRevision:8,expectedGeneration:attachment.generation,client});
 assert.equal(removed.outcomeEvidencePreserved,true);assert.deepEqual(runtime.outcomes.state.outcomes,evidence);
 assert.equal(f.counts().commits,1);
});
