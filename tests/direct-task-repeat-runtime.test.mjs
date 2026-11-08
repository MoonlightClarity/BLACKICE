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
 const attrs=()=>({'data-status':page.status,'data-outcome':page.outcomeId||(page.participant+':'+page.workshop),'data-participant':page.participant,'data-workshop':page.workshop,'data-form-action':action,'data-prior':page.prior});
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
async function apiFixture(t,{unknown=false}={}){
 const f=await fixture(t),binding=await f.bind('task',3);await f.reconcile(binding);
 f.page.outcomeId='issuer-original';f.page.missingReceipt=unknown;assert.equal((await f.execute()).success,true);
 const api=new DirectExecutionAPI({dataDir:f.root,allowedRoot:f.root,browser:f.browser,taskRuntime:f.runtime()});f.cleanup(()=>api.close());await api.init();
 const client={id:ownerId,kind:'chatgpt',scopes:[...DIRECT_EXECUTION_SCOPES]};
 const run=async(name,args)=>{const q=await api.call(name,args,client);for(let n=0;n<1000;n++){const r=await api.getJob(q.jobId,client);if(r.settled)return r;await new Promise(r=>setTimeout(r,5));}assert.fail('Job did not settle');};
 const repeat=(ref,extra={})=>run('blackice_task_contract',{requestId:'authorize-'+ref,action:'authorize_repeat',taskId:'task',bindingId:binding.bindingId,tabId,userInstructionRef:ref,userInstructionQuote:'Please deliberately perform that action again.',reason:'Explicit additional user-directed occurrence.',...extra});
 const click=requestId=>run('blackice_browser_action',{requestId,action:'click',tabId,ref:'submit',expectedUrl:f.page.url,expectedDocumentId:f.page.documentId});
 return {f,binding,api,client,run,repeat,click};
}
test('actual authorize_repeat API permits deliberate confirmed repeat but old issuer ID cannot count',async t=>{
 const {f,binding,repeat,click,run}=await apiFixture(t);
 const old=await repeat('user-one');assert.equal(old.status,'succeeded',JSON.stringify(old));
 const oldOccurrence=JSON.parse(old.result.text.text).result;assert.equal(oldOccurrence.baseSemanticKey,binding.semanticKey);assert.equal(oldOccurrence.baseline.basis,'authorized-occurrence');
 assert.equal((await click('same-issuer')).status,'succeeded');assert.equal(f.counts().commits,2);assert.equal((await f.measure()).criteria[0].observedCount,1);
 const next=await repeat('user-two');assert.equal(next.status,'succeeded',JSON.stringify(next));f.page.outcomeId='issuer-distinct';
 assert.equal((await click('new-issuer')).status,'succeeded');assert.equal(f.counts().commits,3);
 const measured=await f.measure();assert.equal(measured.criteria[0].observedCount,2,JSON.stringify({measured,task:await f.runtime().read({ownerId,taskId:'task'})}));assert.equal(measured.criteria[0].authorizedOccurrenceCount,2);
 assert.equal(measured.criteria[0].repeatAmbiguities,0);
 const original=(await f.runtime().read({ownerId,taskId:'task'})).bindings[binding.bindingId];assert.ok(original.newOutcome);
 const rejected=await run('blackice_task_contract',{requestId:'bad-ref',action:'authorize_repeat',taskId:'task',bindingId:binding.bindingId,tabId,userInstructionRef:'user-two',userInstructionQuote:'Changed instruction',reason:'Changed'});
 assert.equal(rejected.status,'failed');assert.equal(f.counts().commits,3);
});
test('actual UNKNOWN repeat preserves original claim and surfaces ambiguity instead of false completion',async t=>{
 const {f,binding,repeat,click}=await apiFixture(t,{unknown:true});
 const denied=await repeat('no-ack');assert.equal(denied.status,'failed');assert.equal(denied.error.code,'DIRECT_REPEAT_UNCERTAINTY');assert.equal(f.counts().commits,1);
 const allowed=await repeat('explicit-uncertain',{acknowledgeUncertainty:true,uncertaintyStatement:'The user directed another attempt knowing the original may already have occurred.'});
 assert.equal(allowed.status,'succeeded',JSON.stringify(allowed));const occurrence=JSON.parse(allowed.result.text.text).result;
 f.page.missingReceipt=false;f.page.outcomeId='issuer-after-repeat';
 const actual=await click('uncertain-deliberate');assert.equal(actual.status,'succeeded',JSON.stringify(actual));assert.equal(f.counts().commits,2);
 const measurement=await f.measure();assert.equal(measurement.criteria[0].observedCount,0);assert.equal(measurement.criteria[0].repeatAmbiguities,1);assert.equal(measurement.criteria[0].unresolvedEffects,1);
 assert.equal((await f.runtime().outcomes.admit({ownerId,taskId:'task',bindingId:binding.bindingId,operationId:'never-retry-original'})).reason,'UNKNOWN_EFFECT');
 assert.equal(occurrence.occurrence.provenance,'authenticated-caller-attestation');
});
