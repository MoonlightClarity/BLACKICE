import {HarnessEngine} from '../lib/engine.mjs';
import {EventEmitter} from 'node:events';
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

import {NativeTaskContextBridge,createNativeTaskContextTool} from '../lib/native-task-context-bridge.mjs';

const client={id:ownerId,kind:'chatgpt',label:'Owner',scopes:['planning:write','browser:read','browser:write','files:read']};
async function nativeFixture(t){
 const f=await fixture(t),binding=await f.bind();await f.reconcile(binding);
 const runtime=f.runtime(),saved={taskId:'native-task',revision:7,taskSchemaVersion:14,contract:contract()};let active=false,revoked=false;
 const tasks={get:async()=>structuredClone(saved),enqueue:async(id,fn)=>fn()};
 const bridge=new NativeTaskContextBridge({runtime,tasks,canEnforceProtectedDispatch:({nativeTaskId})=>nativeTaskId==='native-task',isActive:()=>active,reauthorize:async c=>{if(revoked)throw Object.assign(Error('grant revoked'),{code:'AUTH_REVOKED'});assert.equal(c.id,ownerId);}});
 const handle=await runtime.issueContext({ownerId,taskId:'task',expectedRevision:(await runtime.read({ownerId,taskId:'task'})).revision,workItemId:'enroll',criterionId:'receipt',adapters:['relay_browser','relay_workspace'],bindingId:binding.bindingId});
 const attach=()=>bridge.attach({nativeTaskId:'native-task',expectedNativeRevision:saved.revision,taskContext:handle.taskContext,client});
 await attach();
 const session=await bridge.open({nativeTaskId:'native-task',runId:'native-run',nodeId:'native-node'});
 const nativeOwner={taskId:'native-task',runId:'native-run',nodeId:'native-node'};
 const originalDriver=f.browser.driver;
 const nativeBrowser=new BrowserWorkspace({driver:{...originalDriver,status:()=>{const status=originalDriver.status();return {...status,tabs:status.tabs.map(tab=>({...tab,owner:nativeOwner}))};}}});
 const raw=createBrowserToolHandler({browser:nativeBrowser,owner:nativeOwner});
 const wrapped=raw;
 const call=()=>({name:'relay_browser',arguments:{action:'click',browser:'relay',tabId,ref:'submit',expectedUrl:f.page.url,expectedDocumentId:f.page.documentId}});
 return {...f,runtime,saved,bridge,session,handle,raw,wrapped,call,attach,setActive:v=>active=v,revokeGrant:()=>revoked=true};
}










test('server restores scheduler only after shared admission and connector authority exist',async()=>{
 const source=await fs.readFile(new URL('../server.mjs',import.meta.url),'utf8');
 const scheduler=source.indexOf('await operations.init({preservePausedState:true})');
 assert.ok(scheduler>source.indexOf('engine.nativeTaskContextBridge=new NativeTaskContextBridge'));
 assert.ok(scheduler>source.indexOf('chatGPTConnector = await new ChatGPTConnector'));
});

test('actual server scheduler initialization sees installed native admission',async t=>{
 const {createHarnessServer}=await import('../server.mjs');
 const {OperationsStore}=await import('../lib/operations.mjs');
 const {TaskInbox}=await import('../lib/inbox.mjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-startup-'));
 const runtime=new EventEmitter();runtime.status=()=>({connected:true,authenticated:true,defaultModel:'fixture',activeTurns:0});runtime.close=async()=>{};runtime.runAgent=async()=>{throw Error('No provider call allowed during startup');};
 const engine=new HarnessEngine({runtime,dataDir:path.join(root,'data'),defaultCwd:root});
 const inbox=new TaskInbox({engine,dataDir:path.join(root,'data')});let checked=false;
 class CheckedOperations extends OperationsStore{async init(options){assert.ok(engine.nativeTaskContextBridge instanceof NativeTaskContextBridge);checked=true;return super.init(options);}}
 const operations=new CheckedOperations({engine,inbox,dataDir:path.join(root,'data')});
 const app=await createHarnessServer({runtime,engine,inbox,operations,dataDir:path.join(root,'data'),defaultCwd:root,port:0,taskViability:false,responseCycle:false});
 t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
 assert.equal(checked,true);
});

test('unrelated native tasks inherit no principal; explicit wrong-owner attachment fails',async t=>{
 const f=await nativeFixture(t);
 assert.equal(await f.bridge.open({nativeTaskId:'other-task',runId:'other',nodeId:'node'}),null);
 await assert.rejects(f.bridge.attach({nativeTaskId:'native-task',expectedNativeRevision:7,taskContext:f.handle.taskContext,client:{...client,id:'other'}}));
});

test('native attachment requires idle exact revision while revision changes no longer gate execution',async t=>{
 const f=await nativeFixture(t);f.setActive(true);await assert.rejects(f.attach(),{code:'NATIVE_TASK_ACTIVE'});f.setActive(false);
 await assert.rejects(f.bridge.attach({nativeTaskId:'native-task',expectedNativeRevision:6,taskContext:f.handle.taskContext,client}),{code:'NATIVE_TASK_REVISION_CHANGED'});
 f.saved.revision++;assert.equal(await f.bridge.open({nativeTaskId:'native-task',runId:'new',nodeId:'n'}),null);
});

test('unsupported provider boundary rejects native attachment as metadata without gating ordinary execution',async t=>{
 const f=await nativeFixture(t),bridge=new NativeTaskContextBridge({runtime:f.runtime,tasks:{get:async()=>f.saved}});
 await assert.rejects(bridge.attach({nativeTaskId:'native-task',expectedNativeRevision:7,taskContext:f.handle.taskContext,client}),{code:'NATIVE_TASK_PROVIDER_BOUNDARY'});
 assert.equal(await bridge.open({nativeTaskId:'native-task',runId:'unsafe',nodeId:'node'}),null);
 assert.equal(f.counts().commits,0);
});



import {TaskStateStore} from '../lib/task-state.mjs';

test('explicit idle detach preserves UNKNOWN evidence and durable attachment generations',async t=>{
 const f=await nativeFixture(t);f.page.lostResponse=true;
 await f.execute();assert.equal(f.counts().commits,1);
 const before=structuredClone(f.runtime.outcomes.state.outcomes);
 const mapping=await f.runtime.outcomes.readNativeAttachment({nativeTaskId:'native-task'});
 const args={nativeTaskId:'native-task',expectedNativeRevision:7,expectedGeneration:mapping.generation,client};
 f.setActive(true);await assert.rejects(f.bridge.detach(args),{code:'NATIVE_TASK_ACTIVE'});f.setActive(false);
 await assert.rejects(f.bridge.detach({...args,expectedNativeRevision:6}),{code:'NATIVE_TASK_REVISION_CHANGED'});
 await assert.rejects(f.bridge.detach({...args,expectedGeneration:mapping.generation+1}),{code:'DIRECT_CONTEXT_ATTACHMENT_CHANGED'});
 await assert.rejects(f.runtime.outcomes.detachNativeTask({ownerId:'foreign',nativeTaskId:'native-task',expectedGeneration:mapping.generation}),{code:'DIRECT_CONTEXT_PRINCIPAL'});
 const result=await f.bridge.detach(args);assert.equal(result.detached,true);
 assert.deepEqual(f.runtime.outcomes.state.outcomes,before);
 assert.equal(await f.bridge.open({nativeTaskId:'native-task',runId:'after-detach'}),null);
 await f.attach();const fresh=await f.runtime.outcomes.readNativeAttachment({nativeTaskId:'native-task'});
 assert.equal(fresh.generation,mapping.generation+2);assert.ok(fresh.history.some(entry=>entry.detachedAt));
 assert.deepEqual(f.runtime.outcomes.state.outcomes,before);assert.equal(f.counts().commits,1);
 await f.runtime.close();const reopened=new DirectTaskRuntime({dataDir:f.root,browser:f.browser});f.cleanup(()=>reopened.close());
 const restored=await reopened.outcomes.readNativeAttachment({nativeTaskId:'native-task'});assert.equal(restored.generation,fresh.generation);assert.deepEqual(restored.history,fresh.history);
 assert.deepEqual(reopened.outcomes.state.outcomes,before);
});
