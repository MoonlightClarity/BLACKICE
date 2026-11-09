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
test('actual observed POST baseline -> native receipt -> delta one; later task blocks same identity despite payload changes',async t=>{
 const f=await fixture(t),b=await f.bind();assert.equal(f.counts().commits,0);
 const baseline=await f.reconcile(b);assert.equal(baseline.accepted,1);assert.equal(baseline.measurement.satisfied,false);
 const result=await f.execute();assert.equal(result.success,true,JSON.stringify(result));
 assert.equal(f.counts().commits,1);assert.equal((await f.measure()).criteria[0].observedCount,1);
 await f.reopen();f.page.optional='resume-v2';const next=await f.bind('next');
 assert.equal(next.baseline.state,'CONFIRMED');
 const duplicate=await f.execute();assert.equal(duplicate.success,false);assert.equal(payload(duplicate).code,'ALREADY_CONFIRMED');
 assert.equal(f.counts().commits,1);assert.equal((await f.measure('next')).criteria[0].observedCount,0);
});
test('different observed target establishes independent baseline and permits one new destination effect',async t=>{
 const f=await fixture(t),one=await f.bind();await f.reconcile(one);await f.execute();
 f.page.workshop='w2';f.page.status='absent';const two=await f.bind('second');
 assert.notEqual(two.semanticKey,one.semanticKey);await f.reconcile(two,'baseline','second');
 assert.equal((await f.execute()).success,true);assert.equal(f.counts().commits,2);
 assert.equal((await f.measure('second')).criteria[0].observedCount,1);
});
test('direct browser binding cannot substitute a different receipt criterion for the matched typed commit',async t=>{
 const f=await fixture(t),draft=contract(),item=draft.workItems[0],target='url:'+action;
 draft.criteria.push({...draft.criteria[0],id:'other-receipt'});item.criterionIds.push('other-receipt');item.resourceKeys.push(target);
 item.operationScopes=[{effect:'observe',resourceKeys:[origin]},{effect:'interact',resourceKeys:[origin]},{effect:'commit',resourceKeys:[target],confirmationCriterionId:'receipt'}];
 await f.runtime().create({ownerId,taskId:'task',contract:draft});
 const args={ownerId,taskId:'task',tabId,workItemId:'enroll',identityFields:['participantId','workshopId'],ref:'submit',expectedUrl:f.page.url,expectedDocumentId:f.page.documentId};
 await assert.rejects(f.runtime().bind({...args,criterionId:'other-receipt'}),{code:'DIRECT_TASK_SCOPE'});
 const bound=await f.runtime().bind({...args,criterionId:'receipt'});
 assert.equal(bound.criterionId,'receipt');
 assert.equal((await f.execute()).success,true);
 assert.equal(f.counts().commits,1);
});
test('missing baseline does not block an initial attempt, but missing confirmation never counts or permits retry',async t=>{
 const f=await fixture(t),b=await f.bind();f.page.status=null;f.page.missingReceipt=true;
 assert.equal((await f.reconcile(b)).accepted,0);
 const initial=await f.execute();assert.equal(initial.success,true);assert.equal(f.counts().commits,1);assert.equal((await f.measure()).satisfied,false);
 const repeated=await f.execute();assert.equal(repeated.success,false);assert.equal(payload(repeated).code,'UNKNOWN_EFFECT');assert.equal(f.counts().commits,1);
 f.page.status='confirmed';assert.equal((await f.execute('read')).success,true);
 const m=await f.measure();assert.equal(m.satisfied,true);assert.equal(m.criteria[0].outcomes[0].novelty,'within-recorded-history');assert.equal(m.criteria[0].outcomes[0].historyCoverage,'not-established');
});
test('lost response leaves UNKNOWN; read-only inspection and host reconciliation recover without resubmission',async t=>{
 const f=await fixture(t),b=await f.bind();await f.reconcile(b);f.page.lostResponse=true;
 const lost=await f.execute();assert.equal(lost.success,false);assert.equal(payload(lost).code,'BROWSER_RESPONSE_LOST');
 assert.equal((await f.measure()).satisfied,false);assert.equal((await f.execute('read')).success,true);
 const recovered=await f.reconcile(b,'outcome');assert.equal(recovered.accepted,1);assert.equal(recovered.measurement.satisfied,true);
 assert.equal(f.counts().commits,1);
});
test('opaque actions cannot bypass a bound measurable task',async t=>{
 const f=await fixture(t);await f.bind();
 await assert.rejects(f.execute('evaluate',{script:'submit()'}),{code:'DIRECT_TASK_OPAQUE'});
 assert.equal(f.counts().commits,0);
});
test('changed identity-field selection cannot evade persisted owner/destination policy',async t=>{
 const f=await fixture(t);await f.bind();await f.reopen();
 const other=contract();other.criteria[0].receiptBinding.identity=[{field:'data-participant',formField:'participantId'}];
 await f.runtime().create({ownerId,taskId:'evade',contract:other});
 await assert.rejects(f.runtime().bind({ownerId,taskId:'evade',tabId,workItemId:'enroll',criterionId:'receipt',identityFields:['participantId'],ref:'submit',expectedUrl:f.page.url,expectedDocumentId:f.page.documentId}),{code:'DIRECT_OUTCOME_IDENTITY_POLICY'});
 assert.equal(f.counts().commits,0);
});


test('one task binding automatically inherits the next observed target without mandatory baseline reads',async t=>{
 const f=await fixture(t);await f.bind('task',2);
 assert.equal((await f.execute()).success,true);assert.equal(f.counts().commits,1);
 f.page.workshop='w2';f.page.status='absent';
 assert.equal((await f.execute()).success,true);assert.equal(f.counts().commits,2);
 const measurement=await f.measure();assert.equal(measurement.criteria[0].observedCount,2);assert.equal(measurement.satisfied,true);
 assert.ok(f.counts().reads<=4,'Automatic baseline inspection must stay bounded, not recursively run another task.');
});
test('concurrent final dispatch admits exactly one business effect',async t=>{
 const f=await fixture(t),binding=await f.bind();await f.reconcile(binding);
 const results=await Promise.allSettled([f.execute(),f.execute(),f.execute()]);
 assert.equal(results.filter(r=>r.status==='fulfilled'&&r.value.success).length,1);
 assert.equal(f.counts().commits,1);
 assert.equal((await f.measure()).criteria[0].observedCount,1);
});
test('a prior observed destination confirmation is baseline, never new progress',async t=>{
 const f=await fixture(t);f.page.status='confirmed';
 const b=await f.bind();const baseline=await f.reconcile(b);
 assert.equal(baseline.accepted,1);assert.equal(baseline.measurement.criteria[0].observedCount,0);
 const blocked=await f.execute();assert.equal(blocked.success,false);assert.equal(f.counts().commits,0);
});
test('unchanged pre-submit absence cannot reconcile a newly dispatched uncertain effect',async t=>{
 const f=await fixture(t),binding=await f.bind();await f.reconcile(binding);
 f.page.stickyReceipt=true;
 await f.execute();assert.equal(f.counts().commits,1);
 assert.equal((await f.measure()).satisfied,false);
 const repeated=await f.execute();
 assert.equal(repeated.success,false,'The unchanged baseline absence must not authorize another dispatch.');
 assert.equal(f.counts().commits,1);
});


test('repeat binding and repeated baseline inspection recover without changing proof or dispatching',async t=>{
 const f=await fixture(t),first=await f.bind();
 const second=await f.bind();assert.equal(second.bindingId,first.bindingId);
 await f.reconcile(first);const again=await f.reconcile(first);
 assert.equal(again.measurement.criteria[0].observedCount,0);
 assert.equal(f.counts().commits,0);
});


test('repeated read-only inspection does not grow proof or operation history or dispatch business effects',async t=>{
 const f=await fixture(t),b=await f.bind();await f.reconcile(b);
 const before=await f.runtime().outcomes.readOperations({ownerId,taskId:'task'});
 for(let i=0;i<25;i++)assert.equal((await f.execute('read')).success,true);
 const after=await f.runtime().outcomes.readOperations({ownerId,taskId:'task'});
 assert.equal(after.length,before.length);assert.equal(f.counts().reads,26);assert.equal(f.counts().commits,0);
});


test('actual direct tool registration, durable jobs and browser dispatch enforce and measure the contract end to end',async t=>{
 const f=await fixture(t),{DirectExecutionAPI,DIRECT_EXECUTION_SCOPES}=await import('../lib/direct-execution-api.mjs');
 const api=new DirectExecutionAPI({dataDir:f.root,allowedRoot:f.root,browser:f.browser});f.cleanup(()=>api.close());await api.init();
 const client={id:ownerId,label:'Test external caller',kind:'chatgpt',scopes:[...DIRECT_EXECUTION_SCOPES]};
 assert.ok(api.tools(client).some(tool=>tool.name==='blackice_task_contract'));
 async function run(tool,args){
  const queued=await api.call(tool,args,client),deadline=Date.now()+5000;
  while(Date.now()<deadline){const saved=await api.getJob(queued.jobId,client);if(saved.settled)return saved;await new Promise(r=>setTimeout(r,5));}
  assert.fail('Durable direct job did not settle.');
 }
 const click=(requestId)=>({requestId,action:'click',tabId,ref:'submit',expectedUrl:f.page.url,expectedDocumentId:f.page.documentId});
 const unbound=await run('blackice_browser_action',click('unbound'));
 assert.equal(unbound.status,'failed');assert.equal(unbound.error.code,'DIRECT_TASK_REQUIRED');assert.equal(f.counts().commits,0);
 const created=await run('blackice_task_contract',{requestId:'create',action:'create',taskId:'task',contract:contract()});assert.equal(created.status,'succeeded');
 const bound=await run('blackice_task_contract',{requestId:'bind',action:'bind',taskId:'task',tabId,workItemId:'enroll',criterionId:'receipt',identityFields:['participantId','workshopId'],ref:'submit',expectedUrl:f.page.url,expectedDocumentId:f.page.documentId});
 assert.equal(bound.status,'succeeded',JSON.stringify(bound));const bindingId=JSON.parse(bound.result.text.text).result.bindingId;
 const baseline=await run('blackice_task_contract',{requestId:'baseline',action:'reconcile',taskId:'task',tabId,bindingId,phase:'baseline'});assert.equal(baseline.status,'succeeded');
 const submittedArgs=click('submit'),submitted=await run('blackice_browser_action',submittedArgs);
 assert.equal(submitted.status,'succeeded',JSON.stringify(submitted));assert.equal(f.counts().commits,1);
 const replay=await api.call('blackice_browser_action',submittedArgs,client);assert.equal(replay.existing,true);assert.equal(replay.jobId,submitted.jobId);assert.equal(f.counts().commits,1);
 const measured=await run('blackice_task_contract',{requestId:'measure',action:'measure',taskId:'task'});
 assert.equal(measured.status,'succeeded');assert.equal(JSON.parse(measured.result.text.text).result.criteria[0].observedCount,1);
 const repeat=await run('blackice_browser_action',click('new-request-same-target'));assert.equal(repeat.status,'failed');assert.equal(f.counts().commits,1);
});


test('failed queued read authorization is surfaced as reconciliation failure and never dispatched',async t=>{
 const f=await fixture(t),binding=await f.bind();
 f.runtime().reauthorize=async()=>{throw Object.assign(Error('Grant revoked'),{code:'DIRECT_AUTH_REQUIRED'});};
 await assert.rejects(f.reconcile(binding),{code:'DIRECT_TASK_RECONCILIATION_FAILED'});
 assert.equal(f.counts().reads,0);assert.equal(f.counts().commits,0);
 assert.equal((await f.measure()).satisfied,false);
});
