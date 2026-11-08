import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {DirectTaskRuntime} from '../lib/direct-task-runtime.mjs';
import {BrowserWorkspace} from '../lib/browser.mjs';
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
   assert.equal(Object.hasOwn(args,'taskContext'),false,'Context envelope must not reach the underlying driver');
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

import {DirectExecutionAPI,DIRECT_EXECUTION_SCOPES} from '../lib/direct-execution-api.mjs';
async function contextApi(t){
 const f=await fixture(t);let release,started,calls=0;
 const began=new Promise(r=>started=r),hold=new Promise(r=>release=r);
 const entry={definition:{name:'blackice_context_hold',scope:'read',inputSchema:{type:'object',properties:{requestId:{type:'string'}},required:['requestId'],additionalProperties:false}},execute:async()=>{calls++;started();await hold;return {success:true,contentItems:[{type:'inputText',text:'done'}]};}};
 const api=new DirectExecutionAPI({dataDir:f.root,allowedRoot:f.root,browser:f.browser,taskRuntime:f.runtime(),maxConcurrent:1,additionalTools:[entry]});
 f.cleanup(async()=>{release();await api.close();});await api.init();
 const client={id:ownerId,kind:'chatgpt',scopes:[...DIRECT_EXECUTION_SCOPES]};
 const saved=async q=>{for(let n=0;n<1000;n++){const r=await api.getJob(q.jobId,client);if(r.settled)return r;await new Promise(r=>setTimeout(r,5));}assert.fail('Job did not settle');};
 const run=async(name,args)=>saved(await api.call(name,args,client));
 const bind=await f.bind(),baseline=await f.reconcile(bind);assert.equal(baseline.accepted,1);
 const revision=(await f.runtime().read({ownerId,taskId:'task'})).revision;
 const issued=await run('blackice_task_context',{requestId:'issue-context',action:'issue',taskId:'task',expectedRevision:revision,workItemId:'enroll',criterionId:'receipt',bindingId:bind.bindingId,adapters:['relay_browser']});
 assert.equal(issued.status,'succeeded',JSON.stringify(issued));const c=JSON.parse(issued.result.text.text).result;
 const click=requestId=>({requestId,taskContext:c.taskContext,action:'click',tabId,ref:'submit',expectedUrl:f.page.url,expectedDocumentId:f.page.documentId});
 return {f,api,client,saved,run,c,click,began,release};
}
test('actual API explicit browser handle confirms once and ordinary same-task path cannot repeat',async t=>{
 const {f,run,click}=await contextApi(t);
 const result=await run('blackice_browser_action',click('explicit-submit'));assert.equal(result.status,'succeeded',JSON.stringify(result));
 assert.equal(f.counts().commits,1);assert.equal((await f.measure()).criteria[0].observedCount,1);
 f.page.optional='new-payload';
 const next=click('ordinary-repeat');delete next.taskContext;
 const repeated=await run('blackice_browser_action',next);assert.equal(repeated.status,'failed');assert.equal(f.counts().commits,1);
});
test('queued explicit browser action is rejected after context revocation before any click',async t=>{
 const {f,api,client,saved,c,click,began,release}=await contextApi(t);
 const hold=await api.call('blackice_context_hold',{requestId:'hold'},client);await began;
 const q=await api.call('blackice_browser_action',click('queued-commit'),client);
 await f.runtime().revokeContext({ownerId,taskContext:c.taskContext,expectedGeneration:1});
 release();await saved(hold);const blocked=await saved(q);
 assert.equal(blocked.status,'failed');assert.equal(blocked.error.code,'DIRECT_CONTEXT_REVOKED');
 assert.equal(f.counts().commits,0);assert.equal((await f.measure()).criteria[0].observedCount,0);
});
test('explicit and inherited browser dispatch concurrently share the semantic claim',async t=>{
 const {f,c}=await contextApi(t),call={name:'relay_browser',arguments:{action:'click',browser:'relay',tabId,ref:'submit',expectedUrl:f.page.url,expectedDocumentId:f.page.documentId}};
 const outcomes=await Promise.allSettled([f.runtime().execute({ownerId,taskContext:c.taskContext,operationId:'explicit-race',handler:f.runtime().handler(ownerId),call}),f.execute()]);
 assert.equal(outcomes.filter(r=>r.status==='fulfilled'&&r.value.success).length,1);
 assert.equal(f.counts().commits,1);assert.equal((await f.measure()).criteria[0].observedCount,1);
});

test('explicit unbound task cannot dispatch opaque browser effects even when contract permits opaque work',async t=>{
 const f=await fixture(t),c=contract();c.workItems[0].effects=['observe','opaque'];
 await f.runtime().create({ownerId,taskId:'task',contract:c});
 const issued=await f.runtime().issueContext({ownerId,taskId:'task',expectedRevision:1,workItemId:'enroll',criterionId:'receipt',adapters:['relay_browser']});
 let dispatched=0;const handler=async()=>{dispatched++;return {success:true,contentItems:[]};};
 handler.describeOperation=async()=>({effect:'opaque',resources:[{key:origin,access:'write'}]});
 await assert.rejects(f.runtime().execute({ownerId,taskContext:issued.taskContext,operationId:'opaque',handler,call:{name:'relay_browser',arguments:{action:'evaluate',tabId}}}),{code:'DIRECT_TASK_OPAQUE'});
 assert.equal(dispatched,0);
});

test('ordinary read reconciles a pending effect once and terminal reads do not grow evidence',async t=>{
 const {f,c}=await contextApi(t);f.page.lostResponse=true;
 const call={name:'relay_browser',arguments:{action:'click',browser:'relay',tabId,ref:'submit',expectedUrl:f.page.url,expectedDocumentId:f.page.documentId}};
 const lost=await f.runtime().execute({ownerId,taskContext:c.taskContext,operationId:'lost',handler:f.runtime().handler(ownerId),call});assert.equal(lost.success,false);
 assert.equal((await f.runtime().outcomes.resolveBinding({ownerId,tabId})).unresolved,true);
 const read=()=>f.runtime().execute({ownerId,taskContext:c.taskContext,operationId:'read',handler:f.runtime().handler(ownerId),call:{name:'relay_browser',arguments:{action:'read',browser:'relay',tabId}}});
 assert.equal((await read()).success,true);assert.equal((await f.measure()).satisfied,true);
 assert.equal((await f.runtime().outcomes.resolveBinding({ownerId,tabId})).unresolved,false);
 const prior=(await f.runtime().read({ownerId,taskId:'task'})).revision;
 for(let n=0;n<5;n++)assert.equal((await read()).success,true);
 assert.equal((await f.runtime().read({ownerId,taskId:'task'})).revision,prior);
 assert.equal(f.counts().commits,1);
});


test('same task progresses an independent target while UNKNOWN reserves capacity and equivalent retry stays blocked',async t=>{
 const f=await fixture(t),first=await f.bind('task',2);await f.reconcile(first);
 f.page.missingReceipt=true;assert.equal((await f.execute()).success,true);
 assert.equal((await f.runtime().outcomes.resolveBinding({ownerId,tabId})).unresolved,true);
 f.page.workshop='w2';f.page.status='absent';f.page.missingReceipt=false;
 assert.equal((await f.execute()).success,true);assert.equal(f.counts().commits,2);
 assert.equal((await f.measure()).criteria[0].observedCount,1);
 f.page.workshop='w3';f.page.status='absent';
 const capacity=await f.execute();assert.equal(capacity.success,false);assert.equal(payload(capacity).code,'TARGET_CAPACITY');assert.equal(f.counts().commits,2);
 f.page.workshop='w1';f.page.status=null;f.page.optional='changed-payload';
 const duplicate=await f.execute();assert.equal(duplicate.success,false);assert.equal(payload(duplicate).code,'UNKNOWN_EFFECT');assert.equal(f.counts().commits,2);
 assert.equal((await f.runtime().outcomes.resolveBinding({ownerId,tabId})).unresolved,true);
});


test('actual API initial task attempt needs no issuer-absence cycle and reports qualified history',async t=>{
 const f=await fixture(t),binding=await f.bind();
 const api=new DirectExecutionAPI({dataDir:f.root,allowedRoot:f.root,browser:f.browser,taskRuntime:f.runtime()});f.cleanup(()=>api.close());await api.init();
 const client={id:ownerId,kind:'chatgpt',scopes:[...DIRECT_EXECUTION_SCOPES]};
 const q=await api.call('blackice_browser_action',{requestId:'ordinary-first',action:'click',tabId,ref:'submit',expectedUrl:f.page.url,expectedDocumentId:f.page.documentId},client);
 let saved;for(let n=0;n<1000;n++){saved=await api.getJob(q.jobId,client);if(saved.settled)break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(saved.status,'succeeded',JSON.stringify(saved));assert.equal(f.counts().commits,1);assert.equal(f.counts().reads,0);
 const task=await f.runtime().read({ownerId,taskId:'task'});assert.equal(task.bindings[binding.bindingId].baseline.state,'UNKNOWN');assert.equal(task.bindings[binding.bindingId].baseline.basis,'no-recorded-host-effect');
 const m=await f.measure();assert.equal(m.criteria[0].observedCount,1);assert.equal(m.criteria[0].outcomes[0].novelty,'within-recorded-history');assert.equal(m.criteria[0].outcomes[0].historyCoverage,'not-established');
});


test('initial no-baseline unchanged absence cannot clear attempted UNKNOWN while independent target progresses',async t=>{
 const f=await fixture(t);await f.bind('task',2);f.page.stickyReceipt=true;
 const first=await f.execute();assert.equal(first.success,true);assert.equal(f.counts().reads,0);assert.equal(f.counts().commits,1);
 assert.equal((await f.runtime().outcomes.resolveBinding({ownerId,tabId})).unresolved,true);
 const verification=first.contentItems.map(i=>{try{return JSON.parse(i.text).taskVerification;}catch{return null;}}).find(Boolean);
 assert.equal(verification.effectState,'unknown');assert.equal((await f.measure()).criteria[0].observedCount,0);
 assert.equal((await f.execute('read')).success,true);assert.equal((await f.runtime().outcomes.resolveBinding({ownerId,tabId})).unresolved,true);
 const retry=await f.execute();assert.equal(retry.success,false);assert.equal(payload(retry).code,'UNKNOWN_EFFECT');assert.equal(f.counts().commits,1);
 f.page.workshop='w2';f.page.stickyReceipt=false;
 const independent=await f.execute();assert.equal(independent.success,true);assert.equal(f.counts().commits,2);
 const m=await f.measure();assert.equal(m.criteria[0].observedCount,1);assert.equal(m.criteria[0].unresolvedEffects,1);
});
