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
 const wrapped=session.wrap('relay_browser',raw);
 const call=()=>({name:'relay_browser',arguments:{action:'click',browser:'relay',tabId,ref:'submit',expectedUrl:f.page.url,expectedDocumentId:f.page.documentId}});
 return {...f,runtime,saved,bridge,session,handle,raw,wrapped,call,attach,setActive:v=>active=v,revokeGrant:()=>revoked=true};
}
test('explicit native bridge composes native guard and shares semantic outcome with direct calls',async t=>{
 const f=await nativeFixture(t);let nativeGuardCalls=0;
 const call=f.call(),descriptor=await f.raw.describeOperation(call);
 const result=await f.wrapped(call,{operationId:'native-op',operationDescriptor:descriptor,onOperationDispatch:()=>{nativeGuardCalls++;}});
 assert.equal(result.success,true,JSON.stringify(result));assert.equal(nativeGuardCalls,1);assert.equal(f.counts().commits,1);
 assert.equal((await f.session.assertReady()).satisfied,true);
 const duplicate=await f.execute();assert.equal(duplicate.success,false);assert.equal(payload(duplicate).code,'ALREADY_CONFIRMED');assert.equal(f.counts().commits,1);
});
test('direct and native callers contend for one atomic semantic claim',async t=>{
 const f=await nativeFixture(t),call=f.call(),descriptor=await f.raw.describeOperation(call);
 const values=await Promise.allSettled([f.execute(),f.wrapped(call,{operationId:'native-race',operationDescriptor:descriptor,onOperationDispatch:()=>{}})]);
 assert.equal(f.counts().commits,1);assert.ok(values.some(v=>v.status==='fulfilled'&&v.value.success));assert.equal((await f.measure()).criteria[0].observedCount,1);
});
test('unrelated native tasks inherit no principal; explicit wrong-owner attachment fails',async t=>{
 const f=await nativeFixture(t);
 assert.equal(await f.bridge.open({nativeTaskId:'other-task',runId:'other',nodeId:'node'}),null);
 await assert.rejects(f.bridge.attach({nativeTaskId:'native-task',expectedNativeRevision:7,taskContext:f.handle.taskContext,client:{...client,id:'other'}}));
 const denied=await f.session.gate({name:'relay_connections',arguments:{}});
 assert.equal(denied.success,false);assert.equal(payload(denied).code,'NATIVE_TASK_ADAPTER_UNSUPPORTED');
 assert.equal(await f.session.gate({name:'relay_task',arguments:{action:'read'}},{controlTools:['relay_task']}),null);
});
test('native attachment requires idle exact revision and material plan remains guarded',async t=>{
 const f=await nativeFixture(t);f.setActive(true);await assert.rejects(f.attach(),{code:'NATIVE_TASK_ACTIVE'});f.setActive(false);
 f.saved.revision++;await assert.rejects(f.bridge.open({nativeTaskId:'native-task',runId:'new',nodeId:'n'}),{code:'NATIVE_TASK_REVISION_CHANGED'});
 f.saved.contract.goal='Changed objective';
 const denied=await f.session.gate({name:'relay_browser',arguments:{action:'read'}});assert.equal(payload(denied).code,'NATIVE_TASK_PLAN_CHANGED');
 await assert.rejects(f.wrapped(f.call(),{operationId:'stale'}),{code:'NATIVE_TASK_PLAN_CHANGED'});assert.equal(f.counts().commits,0);
});
test('native original planning denial remains authoritative and does not dispatch',async t=>{
 const f=await nativeFixture(t),call=f.call(),descriptor=await f.raw.describeOperation(call);
 const result=await f.wrapped(call,{operationId:'native-denied',operationDescriptor:descriptor,onOperationDispatch:()=>{throw Object.assign(Error('native prerequisite'),{code:'NATIVE_PREREQUISITE',actionDispatched:false});}});
 assert.equal(result.success,false);assert.equal(payload(result).code,'NATIVE_PREREQUISITE');assert.equal(f.counts().commits,0);
 const normalized=await f.raw.normalizeOperationResult(result,{call,descriptor});assert.equal(normalized.effectState,'absent');
});
test('unknown native effect does not satisfy final; ordinary host read can reconcile without replay',async t=>{
 const f=await nativeFixture(t);f.page.lostResponse=true;
 const result=await f.wrapped(f.call(),{operationId:'native-lost'});assert.equal(result.success,false);assert.equal(f.counts().commits,1);
 await assert.rejects(f.session.assertReady(),{code:'NATIVE_TASK_CONTEXT_INCOMPLETE'});
 const read=await f.wrapped({name:'relay_browser',arguments:{action:'read',browser:'relay',tabId}},{operationId:'native-reconcile'});
 assert.equal(read.success,true);assert.equal((await f.session.assertReady()).satisfied,true);assert.equal(f.counts().commits,1);
});
test('native queued dispatch rechecks attached grant authorization',async t=>{
 const f=await nativeFixture(t),call=f.call(),descriptor=await f.raw.describeOperation(call);f.revokeGrant();
 await assert.rejects(f.wrapped(call,{operationId:'revoked',operationDescriptor:descriptor}),{code:'AUTH_REVOKED'});assert.equal(f.counts().commits,0);
});

test('unsupported provider boundary rejects native attachment before any model or effect',async t=>{
 const f=await nativeFixture(t),bridge=new NativeTaskContextBridge({runtime:f.runtime,tasks:{get:async()=>f.saved}});
 await assert.rejects(bridge.attach({nativeTaskId:'native-task',expectedNativeRevision:7,taskContext:f.handle.taskContext,client}),{code:'NATIVE_TASK_PROVIDER_BOUNDARY'});
 await assert.rejects(bridge.open({nativeTaskId:'native-task',runId:'unsafe',nodeId:'node'}),{code:'NATIVE_TASK_PROVIDER_BOUNDARY'});
 assert.equal(f.counts().commits,0);
});

import {EventEmitter} from 'node:events';
import {HarnessEngine} from '../lib/engine.mjs';
import {TaskStateStore} from '../lib/task-state.mjs';

test('actual engine continuation uses explicit native attachment and shared outcome completion',async t=>{
 const f=await fixture(t),binding=await f.bind();await f.reconcile(binding);const shared=f.runtime();
 const directory=path.join(f.root,'native-engine');await fs.mkdir(directory);
 const tasks=await new TaskStateStore({dataDir:directory}).init();let stage=0,callSequence=0,nativeTaskId;
 const original=f.browser.driver;
 const nativeBrowser=new BrowserWorkspace({driver:{...original,status:()=>{const status=original.status();return {...status,tabs:status.tabs.map(tab=>({...tab,owner:{taskId:nativeTaskId||'unbound',runId:'native',nodeId:'agent'}}))};}}});
 class FixtureRuntime extends EventEmitter{
  status(){return {connected:true,authenticated:true,defaultModel:'fixture::host-only',models:[{id:'fixture::host-only',supportsTools:true}]};}
  async runAgent(options){
   const invoke=(name,args)=>options.onToolCall({name,arguments:args,callId:'call-'+(++callSequence)+'-'+name},{signal:options.signal});
   if(stage++===0){const state=payload(await invoke('relay_task',{action:'read'}));const saved=await invoke('relay_task',{action:'plan',expectedRevision:state.revision,contract:contract()});assert.equal(saved.success,true,JSON.stringify(saved));return {output:'Plan saved.',threadId:'native-fixture-first'};}
   assert.equal(options.hostOnlyTools,true);
   const denied=await invoke('relay_connections',{action:'call',name:'opaque'});assert.equal(denied.success,false);assert.equal(payload(denied).code,'NATIVE_TASK_ADAPTER_UNSUPPORTED');
   const result=await invoke('relay_browser',{action:'click',browser:'relay',tabId,ref:'submit',expectedUrl:f.page.url,expectedDocumentId:f.page.documentId});
   assert.equal(result.success,true,JSON.stringify(result));assert.equal((await options.onBeforeFinal({output:'Verified enrollment.'}))??null,null);
   return {output:'Verified enrollment.',threadId:'native-fixture-second'};
  }
  async close(){}
 }
 const provider=new FixtureRuntime(),engine=await new HarnessEngine({runtime:provider,tasks,browser:nativeBrowser,dataDir:directory,defaultCwd:f.root}).init();
 engine.runtimeSettings={get:()=>({executionGuardrails:false,subagentsEnabled:false})};
 f.cleanup(async()=>{await engine.close();await tasks.close();});
 const workflow={id:'native-context-e2e',name:'Native context end-to-end',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'fixture::host-only',prompt:'Follow the requested task.'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1}};
 const first=engine.startRun({workflow,input:'Plan the enrollment.',planningMode:'off'});await engine.executions.get(first.id);assert.equal(engine.getRun(first.id).status,'completed',engine.getRun(first.id).error);nativeTaskId=first.id;
 const handle=await shared.issueContext({ownerId,taskId:'task',expectedRevision:(await shared.read({ownerId,taskId:'task'})).revision,workItemId:'enroll',criterionId:'receipt',adapters:['relay_browser','relay_workspace'],bindingId:binding.bindingId});
 engine.nativeTaskContextBridge=new NativeTaskContextBridge({runtime:shared,tasks,isActive:id=>[...engine.runs.values()].some(run=>(run.taskId||run.id)===id&&run.settled!==true),canEnforceProtectedDispatch:()=>true});
 await engine.nativeTaskContextBridge.attach({nativeTaskId,expectedNativeRevision:(await tasks.get(nativeTaskId)).revision,taskContext:handle.taskContext,client});
 const next=engine.continueRun(first.id,{nodeId:'agent',message:'Execute the reviewed enrollment.',planningMode:'off'});await engine.executions.get(next.id);const done=engine.getRun(next.id);
 assert.equal(done.status,'completed',done.error||done.nodes.agent.error);assert.equal(f.counts().commits,1);assert.equal((await f.measure()).satisfied,true);
 const duplicate=await f.execute();assert.equal(duplicate.success,false);assert.equal(f.counts().commits,1);
 await engine.nativeTaskContextBridge.attach({nativeTaskId,expectedNativeRevision:(await tasks.get(nativeTaskId)).revision,taskContext:handle.taskContext,client});
 let helperCalls=0;engine.responseCycle={forRun:async()=>{helperCalls++;return null;}};
 const blocked=engine.continueRun(next.id,{nodeId:'agent',message:'Inspect protected work.',planningMode:'off'});await engine.executions.get(blocked.id);
 assert.equal(engine.getRun(blocked.id).status,'failed');assert.equal(engine.getRun(blocked.id).errorCode,'NATIVE_TASK_READINESS_BOUNDARY');assert.equal(helperCalls,0);assert.equal(stage,2);
});

test('explicit idle detach preserves UNKNOWN evidence and fences stale native sessions',async t=>{
 const f=await nativeFixture(t);f.page.lostResponse=true;
 await f.wrapped(f.call(),{operationId:'detach-unknown'});assert.equal(f.counts().commits,1);
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
 const denied=await f.session.gate({name:'relay_browser',arguments:{action:'read'}});assert.equal(denied.success,false);
 await f.attach();const fresh=await f.runtime.outcomes.readNativeAttachment({nativeTaskId:'native-task'});
 assert.equal(fresh.generation,mapping.generation+2);assert.ok(fresh.history.some(entry=>entry.detachedAt));
 assert.deepEqual(f.runtime.outcomes.state.outcomes,before);assert.equal(f.counts().commits,1);
 await f.runtime.close();const reopened=new DirectTaskRuntime({dataDir:f.root,browser:f.browser});f.cleanup(()=>reopened.close());
 const restored=await reopened.outcomes.readNativeAttachment({nativeTaskId:'native-task'});assert.equal(restored.generation,fresh.generation);assert.deepEqual(restored.history,fresh.history);
 assert.deepEqual(reopened.outcomes.state.outcomes,before);
});

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

test('linked native receipt refinement preserves UNKNOWN and admits fresh reconciliation without reattach',async t=>{
 const {CanonicalTaskPlanSource}=await import('../lib/canonical-task-plan-source.mjs');
 const f=await fixture(t),runtime=f.runtime(),tasks=new TaskStateStore({dataDir:path.join(f.root,'canonical')});
 await tasks.ensure({taskId:'native-linked',runId:'native-run',nodeId:'main',cwd:f.root,schemaVersion:14});
 await tasks.setContract('native-linked',contract(),{expectedRevision:1,schemaVersion:14});
 const source=new CanonicalTaskPlanSource({tasks,runtime});runtime.withPlanSnapshot=source.withPlanSnapshot.bind(source);
 const linked=await source.bindPlan({ownerId,sourceTaskId:'native-linked',expectedSourceRevision:2},{client});
 const binding=await runtime.bind({ownerId,taskId:linked.taskId,tabId,workItemId:'enroll',criterionId:'receipt',identityFields:['participantId','workshopId'],ref:'submit',expectedUrl:f.page.url,expectedDocumentId:f.page.documentId});
 await runtime.reconcile({ownerId,taskId:linked.taskId,tabId,bindingId:binding.bindingId,phase:'baseline'});
 const context=await runtime.issueContext({ownerId,taskId:linked.taskId,expectedRevision:(await runtime.read({ownerId,taskId:linked.taskId})).revision,workItemId:'enroll',criterionId:'receipt',adapters:['relay_browser'],bindingId:binding.bindingId});
 const bridge=new NativeTaskContextBridge({runtime,tasks,planSource:source,canEnforceProtectedDispatch:()=>true});
 await bridge.attach({nativeTaskId:'native-linked',expectedNativeRevision:2,taskContext:context.taskContext,client});
 const session=await bridge.open({nativeTaskId:'native-linked',runId:'native-run',nodeId:'main'});
 const nativeOwner={taskId:'native-linked',runId:'native-run',nodeId:'main'},driver=f.browser.driver;
 const browser=new BrowserWorkspace({driver:{...driver,status:()=>{const status=driver.status();return {...status,tabs:status.tabs.map(tab=>({...tab,owner:nativeOwner}))};}}});
 const raw=createBrowserToolHandler({browser,owner:nativeOwner}),wrapped=session.wrap('relay_browser',raw);
 let admissions=0;const admit=runtime.outcomes.admit.bind(runtime.outcomes);
 runtime.outcomes.admit=async args=>{if(args.nativeAttachment){assert.ok(tasks.lockOwners.has('native-linked'));admissions++;}return admit(args);};
 const outer={canonicalAdmission:true,operationId:'linked-native-commit',onOperationDispatch:(actual,{onAdmission})=>tasks.enqueue('native-linked',async()=>onAdmission({state:await tasks.get('native-linked'),operation:{}}))};
 f.page.missingReceipt=true;
 const result=await wrapped({name:'relay_browser',arguments:{action:'click',browser:'relay',tabId,ref:'submit',expectedUrl:f.page.url,expectedDocumentId:f.page.documentId}},outer);
 assert.equal(f.counts().commits,1);assert.ok(admissions>0);assert.equal((await runtime.measure({ownerId,taskId:linked.taskId})).satisfied,false);
 const saved=await tasks.get('native-linked'),refined=structuredClone(saved.contract);delete refined.planEpoch;refined.criteria[0].receiptBinding.confirmedValues.push('success');
 await tasks.setContract('native-linked',refined,{expectedRevision:saved.revision,schemaVersion:14});
 f.page.status='confirmed';f.page.missingReceipt=false;
 const read=await wrapped({name:'relay_browser',arguments:{action:'read',browser:'relay',tabId}},{...outer,operationId:'linked-native-read'});
 assert.equal(read.success,true,JSON.stringify(read));assert.equal(f.counts().commits,1);
 assert.equal((await session.assertReady()).satisfied,true);
 assert.equal((await runtime.outcomes.readNativeAttachment({nativeTaskId:'native-linked'})).generation,1);
 const current=await runtime.readContext({ownerId,taskContext:context.taskContext});assert.equal(current.valid,true);assert.ok(current.generation>context.generation);
 f.cleanup(()=>tasks.close());
});
