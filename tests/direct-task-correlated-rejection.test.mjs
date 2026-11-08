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
const receiptBinding=()=>({version:1,format:'dom-text',resourceKey:origin,record:'#receipt',confirmedValues:['Your enrollment is confirmed.'],absentValues:['Please correct the highlighted fields.'],history:false,outcomeFields:['participantId','workshopId']});
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
  const previous=globalThis.document,previousStyle=globalThis.getComputedStyle;
  globalThis.getComputedStyle=()=>({display:'block',visibility:'visible'});
  try{
   globalThis.document={querySelectorAll:selector=>selector==='#receipt'&&page.status?[{isConnected:true,getBoundingClientRect:()=>({width:200,height:30}),attributes:Object.entries(attrs()).map(([name,value])=>({name,value})),innerText:page.status,getAttribute:name=>attrs()[name]??null}]:[]};
   return observePageReceiptRecords(bindings).map((record,i)=>({bindingKey:browserReceiptBindingKey(bindings[i]),...record}));
  }finally{globalThis.document=previous;globalThis.getComputedStyle=previousStyle;}
 };
 const driver={
  status:()=>({available:true,contained:true,containedAvailable:true,activeTab:tabId,tabs:[{browser:'relay',tabId,url:page.url,documentId:page.documentId,purpose:'user'}]}),
  observeOperation:async(args,options={})=>({current:(!options.expectedDocumentId||options.expectedDocumentId===page.documentId)&&(!options.expectedUrl||options.expectedUrl===page.url),tabId,documentId:page.documentId,url:page.url,frameId:page.frameId,loaderId:page.loaderId,
   ...(args.action==='click'?{control:{ref:args.ref,kind:'form-submit',form:form()}}:args.action==='fill'?{control:{ref:args.ref,kind:'field'}}:{}),
   submissionCorrelations:page.withholdCorrelation?[]:tracker.current(page),receipts:receipts(options.receiptBindings||[])}),
  perform:async(args,context)=>{
   if(args.action==='click'){
    commits++;const postData=new URLSearchParams(fields()).toString(),sourceLoaderId=page.loaderId,sourceDocumentId=page.documentId;
    assert.equal(tracker.arm({operationId:context.operationId,commit:context.operationDescriptor.commit,sourceFrameId:page.frameId,sourceLoaderId,sourceDocumentId}),true);
    page.loaderId='response-'+commits;page.documentId='one:'+(commits+1);if(!page.stickyReceipt)page.status=page.missingReceipt?null:'confirmed';
    const requestId='request-'+commits;
    tracker.observe('Network.requestWillBeSent',{type:'Document',requestId,frameId:page.frameId,loaderId:page.loaderId,request:{method:'POST',url:action,postData,headers:{'Content-Type':'application/x-www-form-urlencoded'}}});
    tracker.observe('Network.responseReceived',{type:'Document',requestId,loaderId:page.loaderId,response:{url:action,status:422}});
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

test('native POST-correlated rejection resolves initial UNKNOWN on read without a baseline or duplicate submission',async t=>{
 const f=await fixture(t),binding=await f.bind();
 f.page.status='Please correct the highlighted fields.';f.page.stickyReceipt=true;f.page.lostResponse=true;
 assert.equal((await f.runtime().outcomes.readOperations({ownerId,taskId:'task'})).some(o=>o.baselineEvidence),false);
 const interrupted=await f.execute();assert.equal(interrupted.success,false);assert.equal(payload(interrupted).code,'BROWSER_RESPONSE_LOST');
 const pending=await f.runtime().outcomes.resolveBinding({ownerId,tabId});assert.equal(pending.unresolved,true);
 assert.equal(pending.binding.baseline.state,'UNKNOWN');assert.equal((await f.measure()).criteria[0].observedCount,0);
 const recovered=await f.execute('read');assert.equal(recovered.success,true);
 const verification=JSON.parse(recovered.contentItems.find(i=>i.type==='inputText'&&i.text.includes('"taskVerification"')).text).taskVerification;
 assert.equal(verification.effectState,'absent');assert.equal(verification.accepted,1);
 assert.equal((await f.runtime().outcomes.resolveBinding({ownerId,tabId})).unresolved,false);
 assert.equal((await f.measure()).criteria[0].observedCount,0);assert.equal((await f.measure()).satisfied,false);
 const operations=await f.runtime().outcomes.readOperations({ownerId,taskId:'task'});
 const raw=operations.flatMap(o=>o.nativeReceipt?o.evidence:[]).find(e=>e.validation.source==='host-correlated-native-form-text');
 assert.ok(raw);assert.equal(raw.confirmation.status,'absent');assert.equal(raw.validation.operationId,'op-1');assert.equal(raw.validation.requestId,'request-1');assert.equal(raw.validation.documentId,'one:2');
 assert.ok(operations.some(o=>o.id==='op-1'&&o.deliveryState==='dispatched'));
 const before=operations.length;await f.execute('read');assert.equal((await f.runtime().outcomes.readOperations({ownerId,taskId:'task'})).length,before);
 assert.equal(f.counts().commits,1);assert.equal(f.counts().reads,2);
});
test('identical rejection text without native POST correlation cannot clear initial UNKNOWN',async t=>{
 const f=await fixture(t);await f.bind();f.page.status='Please correct the highlighted fields.';f.page.stickyReceipt=true;f.page.lostResponse=true;
 await f.execute();assert.equal((await f.runtime().outcomes.resolveBinding({ownerId,tabId})).unresolved,true);
 f.page.withholdCorrelation=true;await f.execute('read');
 assert.equal((await f.runtime().outcomes.resolveBinding({ownerId,tabId})).unresolved,true);assert.equal((await f.measure()).criteria[0].observedCount,0);
 assert.equal(f.counts().commits,1);
 f.page.withholdCorrelation=false;await f.execute('read');assert.equal((await f.runtime().outcomes.resolveBinding({ownerId,tabId})).unresolved,false);
 assert.equal(f.counts().commits,1);
});
