import test from 'node:test';
import {normalizePlanContract} from '../public/planning-contract-model.mjs';
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
 const form=()=>({id:'form1',documentId:page.documentId,action:page.targetAction||action,method:'POST',enctype:'application/x-www-form-urlencoded',target:'_self',payloadDigest:hash(fields()),requestPayloadDigest:urlencodedFormPayloadDigest(new URLSearchParams(fields()).toString()),attachmentDigests:[],identityDigests:fields().map(([name,value])=>({name,digest:hash(value)}))});
 const attrs=()=>({'data-status':page.status,'data-outcome':page.participant+':'+page.workshop,'data-participant':page.participant,'data-workshop':page.workshop,'data-form-action':page.targetAction||action,'data-prior':page.prior});
 const receipts=bindings=>{
  const previous=globalThis.document;
  try{
   globalThis.document={querySelectorAll:selector=>selector===(page.receiptSelector||'#receipt')&&page.status?[{attributes:Object.entries(attrs()).map(([name,value])=>({name,value})),innerText:page.status,getAttribute:name=>attrs()[name]??null}]:[]};
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
    tracker.observe('Network.requestWillBeSent',{type:'Document',requestId,frameId:page.frameId,loaderId:page.loaderId,request:{method:'POST',url:page.targetAction||action,postData,headers:{'Content-Type':'application/x-www-form-urlencoded'}}});
    tracker.observe('Network.responseReceived',{type:'Document',requestId,loaderId:page.loaderId,response:{url:page.targetAction||action,status:200}});
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

const stable=v=>v&&typeof v==='object'?Array.isArray(v)?'['+v.map(stable).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v);
const snapshot=(c,revision=1)=>({contract:c,source:{kind:'task-state-v14',taskId:'native-task',revision,planEpoch:revision,contractDigest:createHash('sha256').update(stable(normalizePlanContract(c))).digest('hex')}});
async function linked(f,c=contract(2)){
 let latest=snapshot(c);await f.runtime().outcomes.syncPlanSnapshot({ownerId,taskId:'task',...latest});
 f.runtime().withPlanSnapshot=async(_args,callback)=>callback(latest);
 return next=>{latest=snapshot(next,latest.source.revision+1);};
}
test('receipt selector refinement auto-syncs ordinary read and resolves UNKNOWN without rebinding or resubmission',async t=>{
 const f=await fixture(t),b=await f.bind('task',2),update=await linked(f);
 f.page.missingReceipt=true;await f.execute();assert.equal((await f.measure()).criteria[0].observedCount,0);
 const original=await f.runtime().outcomes.read({ownerId,taskId:'task'});
 f.page.status='confirmed';f.page.receiptSelector='#new-receipt';
 const refined=contract(2);refined.criteria[0].receiptBinding.record='#new-receipt';update(refined);
 assert.equal((await f.execute('read')).success,true);
 assert.equal((await f.measure()).criteria[0].observedCount,1);assert.equal(f.counts().commits,1);
 const after=await f.runtime().outcomes.read({ownerId,taskId:'task'});
 assert.equal(after.bindings[b.bindingId].semanticKey,original.bindings[b.bindingId].semanticKey);
 const sidecars=after.operations.filter(o=>o.nativeReceipt);assert.ok(sidecars.length>0);assert.equal(sidecars[0].evidence[0].validation.adapter,'relay_browser');
 assert.ok(sidecars.every(o=>!JSON.stringify(o).includes('resume-v1')));
 await f.execute('read');assert.equal((await f.measure()).criteria[0].observedCount,1);
});
test('same raw absence cannot be remapped into confirmation by changing receipt predicate',async t=>{
 const f=await fixture(t),b=await f.bind('task',2),update=await linked(f);
 await f.reconcile(b);f.page.stickyReceipt=true;await f.execute();
 const before=await f.runtime().outcomes.readOperations({ownerId,taskId:'task'});assert.ok(before.some(o=>o.nativeReceipt));
 const remapped=contract(2);remapped.criteria[0].receiptBinding.confirmedValues=['absent'];remapped.criteria[0].receiptBinding.absentValues=['missing'];update(remapped);
 await f.execute('read');assert.equal((await f.measure()).criteria[0].observedCount,0);
 assert.equal((await f.runtime().outcomes.resolveBinding({ownerId,tabId})).unresolved,true);
 const after=await f.runtime().outcomes.readOperations({ownerId,taskId:'task'});
 for(const old of before)assert.deepEqual(after.find(o=>o.id===old.id),old);
 assert.equal(f.counts().commits,1);
});
test('canonical change between preflight and final host dispatch fences queued commit; fresh call uses same binding',async t=>{
 const f=await fixture(t);await f.bind('task',2);const update=await linked(f),real=f.runtime().handler(ownerId);
 const changed=contract(2);changed.criteria[0].description='Current canonical receipt instructions';
 const wrapped=async(call,context)=>{update(changed);return real(call,context);};wrapped.describeOperation=real.describeOperation;wrapped.normalizeOperationResult=real.normalizeOperationResult;
 const call={name:'relay_browser',arguments:{action:'click',browser:'relay',tabId,ref:'submit',expectedUrl:f.page.url,expectedDocumentId:f.page.documentId}};
 const blocked=await f.runtime().execute({ownerId,operationId:'queued-stale',handler:wrapped,call});assert.equal(blocked.success,false);assert.equal(payload(blocked).code,'DIRECT_PLAN_SCOPE_CHANGED');assert.equal(f.counts().commits,0);
 assert.equal((await f.execute()).success,true);assert.equal(f.counts().commits,1);
});
test('unrelated canonical work addition does not fence queued current operation or duplicate progress',async t=>{
 const f=await fixture(t);await f.bind('task',2);const update=await linked(f),real=f.runtime().handler(ownerId);
 const changed=contract(2);changed.criteria.push({id:'other',kind:'external-confirmation',description:'Other work result',targetCount:1});changed.workItems.push({...changed.workItems[0],id:'other-work',criterionIds:['other']});
 const wrapped=async(call,context)=>{update(changed);return real(call,context);};wrapped.describeOperation=real.describeOperation;wrapped.normalizeOperationResult=real.normalizeOperationResult;
 const call={name:'relay_browser',arguments:{action:'click',browser:'relay',tabId,ref:'submit',expectedUrl:f.page.url,expectedDocumentId:f.page.documentId}};
 assert.equal((await f.runtime().execute({ownerId,operationId:'unrelated-update',handler:wrapped,call})).success,true);assert.equal(f.counts().commits,1);assert.equal((await f.measure()).criteria[0].observedCount,1);
});

test('refinement cannot redefine the established business identity via receipt field selection',async t=>{
 const f=await fixture(t);await f.bind('task',2);const update=await linked(f);
 f.page.missingReceipt=true;await f.execute();
 const changed=contract(2);changed.criteria[0].receiptBinding.identity=[{field:'data-participant',formField:'participantId'}];update(changed);f.page.status='confirmed';
 await assert.rejects(f.execute('read'),{code:'DIRECT_OUTCOME_IDENTITY_POLICY'});
 assert.equal((await f.measure()).criteria[0].observedCount,0);
 assert.equal((await f.runtime().outcomes.resolveBinding({ownerId,tabId})).unresolved,true);
});

test('one canonical criterion aggregates distinct host-confirmed outcomes across added sites without rebinding',async t=>{
 const f=await fixture(t);await f.bind('task',2);const update=await linked(f);
 assert.equal((await f.execute()).success,true);assert.equal((await f.measure()).criteria[0].observedCount,1);
 const expanded=contract(2),second={...receiptBinding(),resourceKey:'origin:https://second.test',record:'#second-receipt'};
 delete expanded.criteria[0].receiptBinding;expanded.criteria[0].receiptBindings=[receiptBinding(),second];expanded.workItems[0].resourceKeys.push(second.resourceKey);update(expanded);
 f.page.targetAction='https://second.test/register';f.page.url=f.page.targetAction;f.page.documentId='second:1';f.page.workshop='w2';f.page.status='absent';f.page.receiptSelector='#second-receipt';
 const result=await f.execute();assert.equal(result.success,true,JSON.stringify(result));
 const measured=await f.measure();assert.equal(measured.criteria[0].observedCount,2);assert.equal(measured.satisfied,true);assert.equal(f.counts().commits,2);
 assert.equal(Object.keys((await f.runtime().outcomes.read({ownerId,taskId:'task'})).bindings).length,2);
});
