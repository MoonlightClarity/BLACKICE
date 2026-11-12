import { fixtureOutcomeReview, finishFixtureCandidate } from './fixture-modular-provider.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp,mkdir,rm,readFile,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserWorkspace,createBrowserToolHandler } from '../lib/browser.mjs';
import { BrowserSubmissionObservations,urlencodedFormPayloadDigest } from '../desktop/browser-submission-observation.mjs';
import { browserReceiptBindingKey } from '../lib/operation-descriptors.mjs';
import { createOperationalEffectGuard } from '../lib/operational-effect-guard.mjs';
import { createWorkspaceToolHandler } from '../lib/workspace-tools.mjs';
import { TaskStateStore,delegatedPlanNodeId } from '../lib/task-state.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';
import { OPERATIONAL_EFFECT_TOOL } from '../lib/operational-receipts.mjs';
import { readOnlyToolDenial } from '../lib/worker-permissions.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const page='https://example.test/form',destination=page+'/submit',response='https://example.test/receipt';
const body='email=test%40example.test&target=one';
const binding={version:1,format:'dom-text',resourceKey:'url:'+response,record:'.receipt',confirmedValues:['Accepted'],absentValues:['Rejected'],history:false,outcomeFields:['email','target']};
const call=(action,id='call-'+action,extra={})=>({name:'relay_browser',callId:id,arguments:{action,browser:'relay',tabId:'tab',...(action==='click'?{ref:'submit',expectedUrl:page,expectedDocumentId:'source-doc'}:{}),...extra}});
const parse=result=>JSON.parse(result.contentItems.find(item=>item.type==='inputText').text);
const code=result=>result?.code||parse(result).code;
const note=result=>result.contentItems.map(item=>{try{return JSON.parse(item.text);}catch{return{};}}).find(item=>item.type==='operational.effect');
class Driver {
  constructor(owner){this.owner=owner;this.registry=new BrowserSubmissionObservations();this.dispatches=0;this.documentId='source-doc';this.loaderId='source-loader';this.url=page;this.visible='Pending';this.loseReturn=true;this.correlate=true;this.forged=false;this.responseStatus=200;this.lastContext=null;}
  status(){return{available:true,contained:true,activeTab:'tab',tabs:[{tabId:'tab',browser:'relay',purpose:'task',documentId:this.documentId,url:this.url,owner:this.owner}]};}
  async observeOperation(args,context={}){
    const observed={current:true,tabId:args.tabId||'tab',url:this.url,documentId:this.documentId,frameId:'frame',loaderId:this.loaderId};
    if(args.action==='click')observed.control={ref:'submit',kind:'form-submit',form:{id:'form',documentId:this.documentId,method:'POST',enctype:'application/x-www-form-urlencoded',target:'_self',action:destination,payloadDigest:sha('semantic-payload'),requestPayloadDigest:urlencodedFormPayloadDigest(body),attachmentDigests:[],identityDigests:[{name:'email',digest:sha('test@example.test')},{name:'target',digest:sha('one')}],submitLabel:'Submit'}};
    observed.submissionCorrelations=this.registry.current({frameId:'frame',loaderId:this.loaderId,documentId:this.documentId,url:this.url});
    observed.receipts=(context.receiptBindings||[]).map(value=>({bindingKey:browserReceiptBindingKey(value),records:value.record==='.receipt'?[{status:this.visible}]:[]}));
    return observed;
  }
  async perform(args,context={}){
    if(args.action==='click'){
      this.dispatches++;this.lastContext=context;
      assert.match(context.operationId,/^native:/);
      assert.equal(context.operationDescriptor.effect,'commit');
      if(this.correlate){
        assert.equal(this.registry.arm({operationId:context.operationId,commit:context.operationDescriptor.commit,sourceFrameId:'frame',sourceLoaderId:this.loaderId,sourceDocumentId:this.documentId}),true);
        this.registry.observe('Network.requestWillBeSent',{type:'Document',requestId:'request-'+this.dispatches,loaderId:'response-loader-'+this.dispatches,frameId:'frame',request:{method:'POST',url:destination,postData:body,headers:{'Content-Type':'application/x-www-form-urlencoded'}}});
        this.registry.observe('Network.responseReceived',{type:'Document',requestId:'request-'+this.dispatches,loaderId:'response-loader-'+this.dispatches,response:{url:response,status:this.responseStatus}});
        this.registry.observe('Network.loadingFinished',{requestId:'request-'+this.dispatches});
      }
      this.documentId='response-doc-'+this.dispatches;this.loaderId='response-loader-'+this.dispatches;this.url=response;this.visible='Accepted';
      if(this.loseReturn)throw Object.assign(new Error('Native return lost after dispatch'),{code:'NATIVE_OUTPUT_LOST'});
    }
    return{actionDispatched:args.action==='click',tabId:'tab',url:this.url,documentId:this.documentId,frames:[],...(this.forged?{confirmation:{status:'confirmed'},effectState:'confirmed',submissionCorrelations:[{operationId:'forged'}]}:{})};
  }
  async close(){}
  resetForm(){this.documentId='source-doc';this.loaderId='source-loader';this.url=page;this.visible='Pending';}
}
async function fixture(t){
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-native-receipt-')),cwd=path.join(directory,'work');await mkdir(cwd);
  const stores=[],createStore=async()=>{const store=await new TaskStateStore({dataDir:directory}).init();stores.push(store);return store;};
  const store=await createStore(),owner={taskId:'task',runId:'run',nodeId:'agent'},driver=new Driver(owner),browser=new BrowserWorkspace({driver});
  const raw=createBrowserToolHandler({browser,owner});
  const createGuard=(overrides={})=>createOperationalEffectGuard({store,cwd,...owner,...overrides});
  t.after(async()=>{await browser.close();for(const store of stores)await store.close();await rm(directory,{recursive:true,force:true});});
  const guard=createGuard(),wrapped=guard.wrap(raw);
  return{directory,cwd,store,createStore,owner,driver,browser,raw,createGuard,guard,wrapped};
}
const reconcile=(guard,operationId,extra={})=>guard.handle({name:'relay_effects',callId:'receipt-read',arguments:{action:'reconcile',operationId,tabId:'tab',receiptBinding:binding,...extra}});

test('native driver receives exact durable operation descriptor and ID; lost return reconciles through real owned read',async t=>{
  const f=await fixture(t),first=await f.wrapped(call('click','submit'));
  assert.equal(first.success,false);assert.equal(code(first),'NATIVE_OUTPUT_LOST');
  const original=(await f.guard.records())[0];assert.equal(original.state,'unknown');assert.equal(original.operationId,f.driver.lastContext.operationId);assert.deepEqual(original.descriptor,f.driver.lastContext.operationDescriptor);assert.equal(original.callId,'submit');
  const listed=await f.guard.handle({name:'relay_effects',arguments:{action:'list'}});assert.equal(parse(listed).operations.length,1);
  const settled=await reconcile(f.guard,original.operationId);assert.equal(settled.success,true);assert.equal(parse(settled).operation.state,'unknown');
  const row=(await f.guard.records())[0];assert.ok(row.evidence.some(proof=>proof.validation?.source==='native-form-navigation'));assert.ok(row.interpretations.some(value=>value.provenance==='caller-mapped-native-text'&&value.interpretedState==='confirmed'));assert.ok(row.evidence.every(proof=>!proof.confirmation));assert.ok(row.evidence.every(proof=>proof.id&&proof.at));
  assert.equal(f.driver.dispatches,1);
  f.driver.resetForm();const duplicate=await f.wrapped(call('click','second-id'));assert.equal(code(duplicate),'OPERATIONAL_EFFECT_UNCERTAIN');assert.equal(f.driver.dispatches,1);
});

test('wrong owner, wrong current document, forged body and uncorrelated success cannot clear UNKNOWN',async t=>{
  const f=await fixture(t);await f.wrapped(call('click','submit'));const row=(await f.guard.records())[0];
  const stranger=f.createGuard({taskId:'other'});stranger.wrap(f.raw);
  assert.equal(code(await reconcile(stranger,row.operationId)),'OPERATIONAL_RECEIPT_NOT_FOUND');
  f.driver.owner={...f.owner,nodeId:'other'};assert.equal((await reconcile(f.guard,row.operationId)).success,false);assert.equal((await f.guard.records())[0].state,'unknown');
  f.driver.owner=f.owner;const savedDocument=f.driver.documentId;f.driver.documentId='unrelated-document';f.driver.forged=true;
  assert.equal((await reconcile(f.guard,row.operationId)).success,true);assert.equal((await f.guard.records())[0].state,'unknown');
  f.driver.documentId=savedDocument;const saved=f.driver.registry.saved();f.driver.registry=new BrowserSubmissionObservations();
  assert.equal((await reconcile(f.guard,row.operationId)).success,true);assert.equal((await f.guard.records())[0].state,'unknown','caller/body claims do not replace native registry proof');
  f.driver.registry=new BrowserSubmissionObservations(saved);
  const rejected=await f.guard.handle({name:'relay_effects',arguments:{action:'reconcile',operationId:row.operationId,tabId:'tab',receiptBinding:binding,effectState:'confirmed'}});
  assert.equal(rejected.success,false);assert.equal((await f.guard.records())[0].state,'unknown');
});

for(const status of [200,500])test('caller-mapped error text after POST response '+status+' cannot prove absence or permit repeat',async t=>{
  const f=await fixture(t);f.driver.responseStatus=status;await f.wrapped(call('click','submit'));const row=(await f.guard.records())[0];
  f.driver.visible='Server error';await reconcile(f.guard,row.operationId,{receiptBinding:{...binding,absentValues:['Server error']}});
  const retained=(await f.guard.records())[0];assert.equal(retained.state,'unknown');assert.ok(retained.interpretations.some(value=>value.interpretedState==='absent'));assert.ok(retained.evidence.every(proof=>!proof.confirmation));
  f.driver.resetForm();assert.equal(code(await f.wrapped(call('click','must-not-repeat'))),'OPERATIONAL_EFFECT_UNCERTAIN');assert.equal(f.driver.dispatches,1);
});

test('same operation replay and changed-ID arguments cannot dispatch twice, including a reopened store and native registry',async t=>{
  const f=await fixture(t),originalCall=call('click','stable');const original=await f.wrapped(originalCall);
  const row=(await f.guard.records())[0];
  await f.store.close();const reopened=await f.createStore();f.driver.registry=new BrowserSubmissionObservations(f.driver.registry.saved());
  const guard=f.createGuard({store:reopened}),wrapped=guard.wrap(f.raw);
  // Same-ID replay is resolved before document revalidation and never sends input.
  assert.deepEqual(await wrapped(originalCall),original);assert.equal(f.driver.dispatches,1);
  await assert.rejects(wrapped(call('click','stable',{ref:'different'})),{code:'OPERATIONAL_CALL_ID_REUSED'});
  assert.equal((await reconcile(guard,row.operationId)).success,true);assert.equal((await guard.records())[0].state,'unknown');
});

test('actual native pre-dispatch cancellation is absent, interruption after dispatch stays unknown',async t=>{
  const f=await fixture(t),controller=new AbortController();
  await assert.rejects(f.wrapped(call('click','cancel-before'),{signal:controller.signal,onOperationDispatch:()=>controller.abort()}),{name:'AbortError'});
  assert.equal(f.driver.dispatches,0);assert.equal((await f.guard.records())[0].state,'absent');
  await f.wrapped(call('click','after-dispatch'));assert.equal(f.driver.dispatches,1);assert.equal((await f.guard.records()).at(-1).state,'unknown');
});

test('native workspace readback settles desired content after lost return, without fabricating historical external acceptance',async t=>{
  const f=await fixture(t),raw=createWorkspaceToolHandler({cwd:f.cwd});
  const lost=async(call,context)=>{await raw(call,context);throw new Error('Lost workspace return');};lost.describeOperation=raw.describeOperation;lost.operationAdapter='relay_workspace';
  const write={name:'relay_workspace',callId:'write',arguments:{action:'write',path:'proof.txt',text:'expected'}};
  await assert.rejects(f.guard.wrap(lost)(write));assert.equal((await f.guard.records())[0].state,'unknown');
  const read=f.guard.wrap(raw);await read({name:'relay_workspace',arguments:{action:'read',path:'proof.txt'}});assert.equal((await f.guard.records())[0].state,'confirmed');
  assert.equal(await readFile(path.join(f.cwd,'proof.txt'),'utf8'),'expected');
});

test('read-only and protected tool boundaries are explicit and no caller approval/proof fields exist',()=>{
  assert.equal(readOnlyToolDenial({name:'relay_effects',arguments:{action:'list'}},false),null);
  assert.equal(readOnlyToolDenial({name:'relay_effects',arguments:{action:'read',operationId:'x'}},false),null);
  assert.equal(readOnlyToolDenial({name:'relay_effects',arguments:{action:'reconcile',operationId:'x'}},false).success,false);
  assert.equal(OPERATIONAL_EFFECT_TOOL.inputSchema.additionalProperties,false);
  assert.deepEqual(Object.keys(OPERATIONAL_EFFECT_TOOL.inputSchema.properties),['action','operationId','tabId','receiptBinding']);
});

for(const mode of ['off','ontology'])test('real HarnessEngine receipt discovery and later-turn recovery with '+mode,async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-engine-receipt-')),cwd=path.join(directory,'work');await mkdir(cwd);
  const tasks=await new TaskStateStore({dataDir:directory}).init(),driver=new Driver(null),browser=new BrowserWorkspace({driver});let turns=0,operationId;
  class Runtime extends EventEmitter{
    status(){return{connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',supportsTools:true}]};}
    async runAgent(options){const review=fixtureOutcomeReview(options);if(review)return review;turns++;assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_effects'));
      if(turns===1){const result=await options.onToolCall(call('click','engine-submit'));assert.equal(result.success,false);operationId=note(result).operationId;return finishFixtureCandidate(options,{output:'Dispatched once; outcome uncertain',threadId:'native-receipt-thread'});}
      const listed=await options.onToolCall({name:'relay_effects',callId:'later-list',arguments:{action:'list'}});assert.equal(parse(listed).operations[0].operationId,operationId);
      const recovery=await options.onToolCall({name:'relay_effects',callId:'engine-receipt',arguments:{action:'reconcile',operationId,tabId:'tab',receiptBinding:binding}});
      assert.equal(recovery.success,true);assert.equal(parse(recovery).operation.state,'unknown');return finishFixtureCandidate(options,{output:'Native response retained; business outcome remains uncertain',threadId:'native-receipt-thread'});
    }async close(){}
  }
  const engine=await new HarnessEngine({runtime:new Runtime(),browser,tasks,dataDir:directory,defaultCwd:cwd}).init();engine.runtimeSettings={get:()=>({executionGuardrails:false,subagentsEnabled:false})};
  t.after(async()=>{await engine.close();await tasks.close();await browser.close();await rm(directory,{recursive:true,force:true});});
  const started=engine.startRun({workflow:createMissionWorkflow({task:'Recover one native receipt',model:'fixture',cwd,planningMode:mode}),input:{task:'Recover one native receipt',cwd,planningMode:mode}});driver.owner={taskId:started.id,runId:started.id,nodeId:'agent'};
  let done;for(let i=0;i<200;i++){done=engine.getRun(started.id);if(done.settled)break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(done.status,'completed',done.error||done.nodes.agent.error);
  const continued=engine.continueRun(started.id,{nodeId:'agent',message:'Inspect the original native receipt, without repeating the effect',planningMode:mode});
  driver.owner={taskId:started.id,runId:continued.id,nodeId:'agent'};
  for(let i=0;i<200;i++){done=engine.getRun(continued.id);if(done.settled)break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(done.status,'completed',done.error||done.nodes.agent.error);assert.equal(done.taskId,started.id);assert.equal(turns,2);assert.equal(driver.dispatches,1);
});

test('an exact destination and payload remain deduplicated across different tabs',async t=>{
  const f=await fixture(t);await f.wrapped(call('click','first-tab'));f.driver.resetForm();
  const status=f.driver.status.bind(f.driver);f.driver.status=()=>{const value=status();return{...value,tabs:[...value.tabs,{...value.tabs[0],tabId:'other-tab'}]};};
  const duplicate=await f.wrapped(call('click','other-tab-attempt',{tabId:'other-tab'}));
  assert.equal(code(duplicate),'OPERATIONAL_EFFECT_UNCERTAIN');assert.equal(f.driver.dispatches,1);assert.match(parse(duplicate).error,/native:[a-f0-9]+/);
});

test('aborts before admission create no claim, while abort after driver invocation never proves absence',async t=>{
  const f=await fixture(t),before=new AbortController();before.abort();
  await assert.rejects(f.wrapped(call('click','not-admitted'),{signal:before.signal}),{name:'AbortError'});assert.equal((await f.guard.records()).length,0);assert.equal(f.driver.dispatches,0);
  const after=new AbortController(),perform=f.driver.perform.bind(f.driver);f.driver.loseReturn=false;
  f.driver.perform=async(args,context)=>{const result=await perform(args,context);if(args.action==='click')after.abort();return result;};
  await assert.rejects(f.wrapped(call('click','driver-entered'),{signal:after.signal}),{name:'AbortError'});assert.equal(f.driver.dispatches,1);assert.equal((await f.guard.records())[0].state,'unknown');
});

for(const mode of ['off','ontology'])test('real delegated native worker has independent receipt tools and ownership with '+mode,async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-worker-receipt-')),cwd=path.join(directory,'work');await mkdir(cwd);
  const tasks=await new TaskStateStore({dataDir:directory}).init(),driver=new Driver(null),browser=new BrowserWorkspace({driver});let parentId,turns=0;
  class Runtime extends EventEmitter{
    status(){return{connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',supportsTools:true}]};}
    async runAgent(options){const review=fixtureOutcomeReview(options);if(review)return review;turns++;
      if(options.prompt.startsWith('You are a short-lived BLACKICE subagent.')){
        assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_effects'));
        if(options.prompt.includes('Inspect the synthetic receipt catalog only.'))return finishFixtureCandidate(options,{output:'Independent receipt catalog inspection complete',threadId:'catalog-receipt-thread'});
        driver.owner={taskId:parentId,runId:parentId,nodeId:delegatedPlanNodeId('agent','receipt-worker')};
        const response=await options.onToolCall(call('click','worker-submit'));assert.equal(response.success,false);const operationId=note(response).operationId;
        const observed=await options.onToolCall({name:'relay_effects',callId:'worker-receipt',arguments:{action:'reconcile',operationId,tabId:'tab',receiptBinding:binding}});
        assert.equal(observed.success,true);assert.equal(parse(observed).operation.nodeId,driver.owner.nodeId);assert.equal(parse(observed).operation.state,'unknown');
        return finishFixtureCandidate(options,{output:'Observed the exact native response; business outcome remains uncertain',threadId:'worker-receipt-thread'});
      }
      assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_delegate'));
      const delegated=await options.onToolCall({name:'relay_delegate',callId:'launch-receipt-worker',arguments:{tasks:[{id:'receipt-worker',prompt:'Dispatch one synthetic native form and inspect the exact retained response.'},{id:'catalog-worker',prompt:'Inspect the synthetic receipt catalog only. Do not dispatch a form.'}]}});
      assert.equal(delegated.success,true);assert.equal(parse(delegated).results[0].status,'completed',parse(delegated).results[0].error);assert.equal(parse(delegated).results[1].status,'completed',parse(delegated).results[1].error);
      const own=await options.onToolCall({name:'relay_effects',callId:'parent-receipts',arguments:{action:'list'}});assert.equal(parse(own).operations.length,0,'parent cannot read another worker’s receipt payload');
      return finishFixtureCandidate(options,{output:'Worker response is recorded; no extra planning turn',threadId:'parent-receipt-thread'});
    }async close(){}
  }
  const engine=await new HarnessEngine({runtime:new Runtime(),browser,tasks,dataDir:directory,defaultCwd:cwd}).init();engine.runtimeSettings={get:()=>({executionGuardrails:false,subagentsEnabled:true,maxSubagents:3})};
  t.after(async()=>{await engine.close();await tasks.close();await browser.close();await rm(directory,{recursive:true,force:true});});
  const started=engine.startRun({workflow:createMissionWorkflow({task:'Delegate one native response inspection',model:'fixture',cwd,planningMode:mode}),input:{task:'Delegate one native response inspection',cwd,planningMode:mode}});parentId=started.id;driver.owner={taskId:parentId,runId:parentId,nodeId:'agent'};
  let done;for(let i=0;i<300;i++){done=engine.getRun(started.id);if(done.settled)break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(done.status,'completed',done.error||done.nodes.agent.error);assert.equal(turns,3);assert.equal(driver.dispatches,1);
});


test('namespaced native calls cannot bypass the independent dispatcher',async t=>{
  const f=await fixture(t);const result=await f.wrapped({...call('click','namespaced'),namespace:'arbitrary'});
  assert.equal(code(result),'OPERATIONAL_NATIVE_NAMESPACE');assert.equal(f.driver.dispatches,0);assert.equal((await f.guard.records()).length,0);
});

test('repeated receipt inspection is bounded and retained mappings cannot be reinterpreted',async t=>{
  const f=await fixture(t);await f.wrapped(call('click','bounded-receipt'));
  const row=(await f.guard.records())[0];
  assert.equal((await reconcile(f.guard,row.operationId)).success,true);
  const first=(await f.guard.records())[0];
  for(let i=0;i<3;i++)assert.equal((await reconcile(f.guard,row.operationId)).success,true);
  await f.wrapped(call('read','ordinary-receipt-read'));
  const repeated=(await f.guard.records())[0];
  assert.deepEqual(repeated.evidence,first.evidence);
  assert.deepEqual(repeated.interpretations,first.interpretations);
  const changed=await reconcile(f.guard,row.operationId,{receiptBinding:{...binding,confirmedValues:['Different']}});
  assert.equal(code(changed),'OPERATIONAL_RECEIPT_BINDING_CHANGED');
  const retained=(await f.guard.records())[0];
  assert.deepEqual(retained.receiptBindings,[binding]);
  assert.equal(retained.state,'unknown');assert.equal(f.driver.dispatches,1);
});

test('receipt mapping rejects invented submitted identity fields before observing the page',async t=>{
  const f=await fixture(t);await f.wrapped(call('click','identity-receipt'));
  const row=(await f.guard.records())[0];let reads=0;
  const perform=f.driver.perform.bind(f.driver);
  f.driver.perform=async(args,context)=>{if(args.action==='read')reads++;return perform(args,context);};
  const invalid=await reconcile(f.guard,row.operationId,{receiptBinding:{...binding,outcomeFields:['invented']}});
  assert.equal(code(invalid),'OPERATIONAL_RECEIPT_BINDING_INVALID');
  assert.equal(reads,0);assert.equal((await f.guard.records())[0].state,'unknown');
});

test('cancellation during durable admission settles the eventual reservation without dispatching input',async t=>{
  const f=await fixture(t),controller=new AbortController();
  const enqueue=f.store.enqueue.bind(f.store);let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),admission=new Promise(resolve=>{entered=resolve;});
  let delayed=false,settled=false;
  f.store.enqueue=(key,operation)=>enqueue(key,async()=>{
    if(key.startsWith('native-effects-')&&!delayed){delayed=true;entered();await gate;}
    return operation();
  });
  const result=f.wrapped(call('click','cancel-admitting'),{signal:controller.signal});
  const checked=assert.rejects(result,{name:'AbortError'}).then(()=>{settled=true;});
  await admission;controller.abort();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(settled,false,'the caller must wait until its in-flight durable reservation settles');
  release();await checked;
  const rows=await f.guard.records();assert.equal(rows.length,1);assert.equal(rows[0].state,'absent');
  assert.equal(rows[0].deliveryState,'cancelled-before-dispatch');assert.equal(f.driver.dispatches,0);
});
