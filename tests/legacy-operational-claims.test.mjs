import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TaskStateStore } from '../lib/task-state.mjs';
import { createWorkspaceToolHandler } from '../lib/workspace-tools.mjs';
import { createOperationalEffectGuard } from '../lib/operational-effect-guard.mjs';
import { createHash } from 'node:crypto';
import { describeHostOperation, normalizeHostOperationResult, browserReceiptBindingKey } from '../lib/operation-descriptors.mjs';
import { normalizeContractEvidence } from '../lib/planning-contract-evidence.mjs';
import { assertNoRetainedEffectConflict } from '../lib/legacy-operational-claims.mjs';

const call=(action,name='kept.txt',text='new',callId=crypto.randomUUID())=>({name:'relay_workspace',callId,arguments:{action,path:name,...(action==='write'?{text}:{})}});
const key=file=>'path:'+(process.platform==='win32'?file.replace(/\\/g,'/').toLowerCase():file);
const row=(resources,extra={})=>({operationId:'old-operation',runId:'private-run',nodeId:'private-owner',workItemId:'old-item',journalSeq:1,
  effect:'interact',deliveryState:'dispatched',effectState:'unconfirmed',resources,evidenceIds:[],operationKey:'old-key',...extra});
const journal=(taskId,records=[])=>({version:3,policy:'work-items-v2',taskId,journalSeq:records.length+1,records,evidence:[],focuses:[],judgments:[],findings:[],progress:[]});
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-legacy-fence-')),cwd=path.join(directory,'workspace');
  await fs.mkdir(cwd);
  const store=await new TaskStateStore({dataDir:directory}).init();
  t.after(async()=>{await store.close();await fs.rm(directory,{recursive:true,force:true});});
  const raw=createWorkspaceToolHandler({cwd}),guard=createOperationalEffectGuard({store,cwd,taskId:'new-task',runId:'new-run',nodeId:'new-owner'});
  const save=async(records,{taskId='ancient-task',value=journal(taskId,records)}={})=>{
    const file=store.file(taskId)+'.sequence';await fs.writeFile(file,JSON.stringify(value));return file;
  };
  return {directory,cwd,store,raw,guard,save,resource:[{key:key(path.join(cwd,'kept.txt')),access:'write'}]};
}
const code=result=>result.code||JSON.parse(result.contentItems[0].text).code;

test('cross-task legacy UNKNOWN prevents overwrite without leaking owner or truncating old records/tasks',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.cwd,'kept.txt'),'original bytes');
  const records=[row(f.resource),...Array.from({length:100},(_,i)=>row(f.resource,{operationId:'settled-'+i,journalSeq:i+2,deliveryState:'returned',effectState:'confirmed'}))];
  const file=await f.save(records);
  await Promise.all(Array.from({length:125},(_,i)=>f.save([],{taskId:'newer-'+i})));
  const before=await fs.readFile(file,'utf8'),result=await f.guard.wrap(f.raw)(call('write'));
  assert.equal(code(result),'TASK_CONTRACT_EFFECT_UNCERTAIN');
  assert.equal(result.success,false);
  assert.doesNotMatch(JSON.stringify(result),/ancient-task|private-owner|private-run|old-operation/);
  assert.equal(await fs.readFile(path.join(f.cwd,'kept.txt'),'utf8'),'original bytes');
  assert.equal((await f.guard.wrap(f.raw)(call('read'))).success,true);
  assert.equal((await f.guard.wrap(f.raw)(call('write','unrelated.txt','allowed'))).success,true);
  assert.equal(await fs.readFile(file,'utf8'),before,'readbacks and new successful work cannot rewrite historical uncertainty');
});

test('cache invalidates on append, same-size atomic replacement, and newly discovered journals',async t=>{
  const f=await fixture(t),descriptor=await f.raw.describeOperation(call('write'));
  const settled=row(f.resource,{deliveryState:'returned',effectState:'confirmed'});
  const file=await f.save([settled]);
  await assertNoRetainedEffectConflict(f.store,'new-task',descriptor);
  await f.save([settled,row(f.resource,{operationId:'new-unknown',journalSeq:2})]);
  await assert.rejects(assertNoRetainedEffectConflict(f.store,'new-task',descriptor),{code:'TASK_CONTRACT_EFFECT_UNCERTAIN'});
  const absent=row(f.resource,{deliveryState:'returned',effectState:'absent'});
  await f.save([absent]);
  await assertNoRetainedEffectConflict(f.store,'new-task',descriptor);
  const replacement=file+'.replacement';
  const unknown=row(f.resource,{deliveryState:'returned',effectState:'unknown'});
  // Padding keeps the file size unchanged; preserved mtime must not defeat identity/ctime invalidation.
  const data=JSON.stringify(journal('ancient-task',[unknown])),old=await fs.readFile(file,'utf8');
  const size=Math.max(data.length,old.length);await fs.writeFile(file,old.padEnd(size));
  await assertNoRetainedEffectConflict(f.store,'new-task',descriptor);
  const cached=await fs.stat(file);
  await fs.writeFile(replacement,data.padEnd(size));await fs.utimes(replacement,cached.atime,cached.mtime);await fs.rename(replacement,file);
  await assert.rejects(assertNoRetainedEffectConflict(f.store,'new-task',descriptor),{code:'TASK_CONTRACT_EFFECT_UNCERTAIN'});
  await f.save([absent]);await assertNoRetainedEffectConflict(f.store,'new-task',descriptor);
  await f.save([row(f.resource)],{taskId:'newly-added'});
  await assert.rejects(assertNoRetainedEffectConflict(f.store,'new-task',descriptor),{code:'TASK_CONTRACT_EFFECT_UNCERTAIN'});
});

for(const [name,extra] of [
  ['planned but not dispatched',{deliveryState:'reserved',effectState:'unconfirmed'}],
  ['cancelled before admission',{deliveryState:'cancelled-before-dispatch',effectState:'absent'}],
  ['confirmed different edit',{deliveryState:'returned',effectState:'confirmed'}]
])test(name+' does not fence a permitted new edit',async t=>{
  const f=await fixture(t);await f.save([row(f.resource,extra)]);
  assert.equal((await f.guard.wrap(f.raw)(call('write'))).success,true);
});

const external=(destination='https://example.test/apply',effectKey='same-application')=>({
  effect:'commit',operationKey:'submit-'+destination,resources:[{key:'destination:'+destination,access:'write'},{key:'form:'+destination,access:'write'}],
  commit:{effectKey,destinationKey:'destination:'+destination,payloadDigest:'immutable-payload'}
});
test('confirmed exact external commitment deduplicates but different permitted commitment is clear',async t=>{
  const f=await fixture(t),descriptor=external();
  await f.save([row(descriptor.resources,{...descriptor,deliveryState:'returned',effectState:'confirmed'})]);
  await assert.rejects(assertNoRetainedEffectConflict(f.store,'new-task',descriptor),{code:'TASK_CONTRACT_EFFECT_CONFIRMED'});
  await assertNoRetainedEffectConflict(f.store,'new-task',external(undefined,'different-application'));
  await assertNoRetainedEffectConflict(f.store,'new-task',{...descriptor,effect:'observe'});
});

test('interrupted external/form commitment cannot be declared absent by callers or erased by current readback',async t=>{
  const f=await fixture(t),descriptor=external(),file=await f.save([row(descriptor.resources,{...descriptor,deliveryState:'interrupted',effectState:'unknown'})]);
  const before=await fs.readFile(file,'utf8');
  await assert.rejects(assertNoRetainedEffectConflict(f.store,'new-task',external(undefined,'changed-payload')),{code:'TASK_CONTRACT_EFFECT_UNCERTAIN'});
  await assertNoRetainedEffectConflict(f.store,'new-task',external('https://other.test/apply','other-application'));
  const result=await f.guard.handle({name:'relay_effects',arguments:{action:'reconcile',operationId:'old-operation',state:'absent'}});
  assert.equal(result.success,false);
  const notOwned=await f.guard.handle({name:'relay_effects',arguments:{action:'read',operationId:'old-operation'}});
  assert.equal(code(notOwned),'OPERATIONAL_RECEIPT_NOT_FOUND');
  await f.guard.wrap(f.raw)(call('write','current.txt','same content'));
  await f.guard.wrap(f.raw)(call('read','current.txt'));
  await assert.rejects(assertNoRetainedEffectConflict(f.store,'new-task',descriptor),{code:'TASK_CONTRACT_EFFECT_UNCERTAIN'});
  assert.equal(await fs.readFile(file,'utf8'),before);
});

test('opaque command dispatch also respects an interrupted retained command',async t=>{
  const f=await fixture(t),command={name:'relay_workspace',callId:'command-retry',arguments:{action:'run',command:'must not execute'}};
  const descriptor=await f.raw.describeOperation(command);
  await f.save([row(descriptor.resources,{...descriptor,tool:'relay_workspace',action:'run',deliveryState:'interrupted',effectState:'unknown'})]);
  let dispatched=0;const raw=async(call,context)=>{await context.onOperationDispatch(descriptor);dispatched++;return{success:true,contentItems:[]};};
  raw.describeOperation=async()=>descriptor;
  const result=await f.guard.wrap(raw)(command);
  assert.equal(code(result),'TASK_CONTRACT_EFFECT_UNCERTAIN');assert.equal(dispatched,0);
  const attempt=await f.guard.handle({name:'relay_effects',arguments:{action:'reconcile',operationId:'old-operation',outcome:'absent'}});
  assert.equal(attempt.success,false);
});

test('actual dispatch rechecks history after a safe admission check',async t=>{
  const f=await fixture(t),descriptor=await f.raw.describeOperation(call('write'));
  let dispatched=0;
  const raw=async(call,context)=>{await f.save([row(descriptor.resources)]);await context.onOperationDispatch(descriptor);dispatched++;return{success:true,contentItems:[]};};
  raw.describeOperation=async()=>descriptor;
  await assert.rejects(f.guard.wrap(raw)(call('write')),{code:'TASK_CONTRACT_EFFECT_UNCERTAIN'});
  assert.equal(dispatched,0);
});

for(const [name,value] of [
  ['unsupported version',{version:99}],
  ['malformed consequential resource',journal('ancient-task',[row([{key:null,access:'write'}])])],
  ['uninterpretable effect',journal('ancient-task',[row([{key:'path:any',access:'write'}],{effect:'future-effect'})])],
  ['opaque claim missing tool',journal('ancient-task',[row([{key:'path:any',access:'write'}],{effect:'opaque',action:'run'})])],
  ['opaque claim missing action',journal('ancient-task',[row([{key:'path:any',access:'write'}],{effect:'opaque',tool:'relay_workspace'})])]
])test(name+' fails closed without disabling ordinary reads',async t=>{
  const f=await fixture(t);await f.save([],{value});await fs.writeFile(path.join(f.cwd,'kept.txt'),'inspectable');
  assert.equal(code(await f.guard.wrap(f.raw)(call('write'))),'TASK_CONTRACT_JOURNAL_UNAVAILABLE');
  assert.equal((await f.guard.wrap(f.raw)(call('read'))).success,true);
});

test('corrupt or disappearing referenced journal fails closed; another profile is not scanned',async t=>{
  const f=await fixture(t),descriptor=await f.raw.describeOperation(call('write')),file=await f.save([]);
  await assertNoRetainedEffectConflict(f.store,'new-task',descriptor);
  await fs.writeFile(file,'{damaged');
  await assert.rejects(assertNoRetainedEffectConflict(f.store,'new-task',descriptor),{code:'TASK_CONTRACT_JOURNAL_UNAVAILABLE'});
  await f.save([]);await assertNoRetainedEffectConflict(f.store,'new-task',descriptor);await fs.rm(file);
  await assert.rejects(assertNoRetainedEffectConflict(f.store,'new-task',descriptor),{code:'TASK_CONTRACT_JOURNAL_UNAVAILABLE'});
  const isolated=await new TaskStateStore({dataDir:path.join(f.directory,'other-profile')}).init();t.after(()=>isolated.close());
  await assertNoRetainedEffectConflict(isolated,'new-task',descriptor);
});

test('supported pre-canonical settled/observation ledgers stay clear, unbound interrupted effects fail closed',async t=>{
  const f=await fixture(t),descriptor=await f.raw.describeOperation(call('write'));
  const old={stepId:'legacy-step',attempt:1,token:'token',planRevision:1,status:'returned',success:true,tool:'relay_workspace',action:'write'};
  await f.save([],{value:{version:1,taskId:'ancient-task',records:[old]}});
  await assertNoRetainedEffectConflict(f.store,'new-task',descriptor);
  await f.save([],{value:{version:1,taskId:'ancient-task',records:[{...old,status:'running',action:'read'}]}});
  await assertNoRetainedEffectConflict(f.store,'new-task',descriptor);
  await f.save([],{value:{version:1,taskId:'ancient-task',records:[{...old,status:'running'}]}});
  await assert.rejects(assertNoRetainedEffectConflict(f.store,'new-task',descriptor),{code:'TASK_CONTRACT_JOURNAL_UNAVAILABLE'});
});

test('independently bound legacy absence stays clear; dangling evidence never invents absence',async t=>{
  const f=await fixture(t),descriptor=external();
  const proof=normalizeContractEvidence({kind:'external-confirmation',resourceKey:descriptor.commit.destinationKey,
    confirmation:{outcomeId:'issuer-record',effectKey:descriptor.commit.effectKey,status:'absent'},
    validation:{adapter:'relay_browser',source:'observed-destination-record'}},
    {operationId:'receipt-observation',workItemId:'receipt-item',at:'2026-11-12T00:00:00.000Z'});
  const original=row(descriptor.resources,{...descriptor,effectState:'absent',reconciliationEvidenceIds:[proof.id]});
  const observed=row([{key:descriptor.commit.destinationKey,access:'read'}],{operationId:'receipt-observation',workItemId:'receipt-item',
    effect:'observe',deliveryState:'returned',effectState:'not-applicable',evidenceIds:[proof.id],journalSeq:2});
  const value={...journal('ancient-task',[original,observed]),evidence:[proof]};
  await f.save([],{value});await assertNoRetainedEffectConflict(f.store,'new-task',descriptor);
  for(const mutate of [
    value=>{value.records[0].effectState='confirmed';},
    value=>{value.records[1].deliveryState='dispatched';},
    value=>{value.records[1].success=false;},
    value=>{value.records[1].resources[0].scopeOnly=true;},
    value=>{value.records[1].resources[0].key='destination:https://different.test';}
  ]){
    const invalid=structuredClone(value);mutate(invalid);await f.save([],{value:invalid});
    await assert.rejects(assertNoRetainedEffectConflict(f.store,'new-task',descriptor),{code:'TASK_CONTRACT_JOURNAL_UNAVAILABLE'});
  }
  value.records[0].reconciliationEvidenceIds=['missing-proof'];await f.save([],{value});
  await assert.rejects(assertNoRetainedEffectConflict(f.store,'new-task',descriptor),{code:'TASK_CONTRACT_JOURNAL_UNAVAILABLE'});
});

test('UNKNOWN file prevents unbounded command replay and UNKNOWN command prevents even distant edits',async t=>{
  const f=await fixture(t),command={name:'relay_workspace',arguments:{action:'run',command:'opaque'}};
  const descriptor=await f.raw.describeOperation(command);
  await f.save([row(f.resource)]);
  let dispatched=0;
  const raw=async(call,context)=>{await context.onOperationDispatch(descriptor);dispatched++;return{success:true,contentItems:[]};};
  raw.describeOperation=async()=>descriptor;
  assert.equal(code(await f.guard.wrap(raw)(command)),'TASK_CONTRACT_EFFECT_UNCERTAIN');
  assert.equal(dispatched,0);
  await f.save([row(descriptor.resources,{...descriptor,tool:'relay_workspace',action:'run',deliveryState:'interrupted',effectState:'unknown'})]);
  assert.equal(code(await f.guard.wrap(f.raw)(call('write','elsewhere.txt'))),'TASK_CONTRACT_EFFECT_UNCERTAIN');
  await fs.writeFile(path.join(f.cwd,'kept.txt'),'inspection');
  assert.equal((await f.guard.wrap(f.raw)(call('read'))).success,true);
});

test('new browser document cannot escape an UNKNOWN destination and reload is not an observation',async t=>{
  const f=await fixture(t),old=external();
  old.resources=[{key:'tab:old',access:'write'},{key:'form:old-document',access:'write'}];
  await f.save([row(old.resources,{...old,deliveryState:'interrupted',effectState:'unknown'})]);
  const next={...external(undefined,'changed-payload'),resources:[{key:'tab:new',access:'write'},{key:'form:new-document',access:'write'}]};
  await assert.rejects(assertNoRetainedEffectConflict(f.store,'new-task',next),{code:'TASK_CONTRACT_EFFECT_UNCERTAIN'});
  let dispatched=0;
  const descriptor={effect:'interact',operationKey:'reload-old-tab',resources:[{key:'tab:old',access:'write'}]};
  const raw=async()=>{dispatched++;return{success:true,contentItems:[]};};raw.describeOperation=async()=>descriptor;
  const result=await f.guard.wrap(raw)({name:'relay_browser',arguments:{action:'reload',tabId:'old'}});
  assert.equal(code(result),'TASK_CONTRACT_EFFECT_UNCERTAIN');assert.equal(dispatched,0);
});

test('a changed early journal during a multi-batch scan is rechecked before admission',async t=>{
  const f=await fixture(t),descriptor=await f.raw.describeOperation(call('write'));
  await f.save([],{taskId:'a-old'});
  await Promise.all(Array.from({length:65},(_,i)=>f.save([],{taskId:'z-'+String(i).padStart(3,'0')})));
  await assertNoRetainedEffectConflict(f.store,'new-task',descriptor);
  const original=fs.lstat;let changed=false;
  fs.lstat=async(file,options)=>{
    if(!changed&&String(file).endsWith('z-064.json.sequence')){
      changed=true;await f.save([row(f.resource)],{taskId:'a-old'});
    }
    return original(file,options);
  };
  try{await assert.rejects(assertNoRetainedEffectConflict(f.store,'new-task',descriptor),{code:'TASK_CONTRACT_EFFECT_UNCERTAIN'});}
  finally{fs.lstat=original;}
  assert.equal(changed,true);
});

async function historicalScopedReceipt(t,action){
  const f=await fixture(t),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const submitted={name:'relay_browser',arguments:{action:'click',tabId:'one',ref:'submit'}};
  const form={current:true,tabId:'one',documentId:'before',url:'https://portal.test/form',control:{ref:'submit',kind:'form-submit',
    form:{id:'form',documentId:'before',action:'https://portal.test/enroll',method:'POST',enctype:'application/x-www-form-urlencoded',target:'_self',
      payloadDigest:hash('payload'),attachmentDigests:[],identityDigests:[{name:'participant',digest:hash('p1')}]}}};
  const target=await describeHostOperation(submitted,{browserObservation:form});
  const binding={version:1,format:'dom',resourceKey:'origin:https://portal.test',record:'#receipt',status:'data-status',
    confirmedValues:['confirmed'],absentValues:['rejected'],outcomeId:'data-outcome',destination:'data-destination',history:false,
    identity:[{field:'data-participant',formField:'participant'}]};
  const observation={current:true,tabId:'one',documentId:'after',url:'https://portal.test/receipt',receipts:[{
    bindingKey:browserReceiptBindingKey(binding),records:[{status:'rejected',outcomeId:'p1',destination:'/enroll',
      identityValues:[{name:'participant',field:'data-participant',value:'p1'}]}]}]};
  const sourceCall={name:'relay_browser',arguments:{action,tabId:'one',...(action==='click'?{ref:'next'}:{})}};
  const descriptor=await describeHostOperation(sourceCall,{browserObservation:observation});
  const original=row(target.resources,{...target,deliveryState:'interrupted',effectState:'unknown',tool:'relay_browser',action:'click'});
  const normalized=await normalizeHostOperationResult({success:true,contentItems:[{type:'inputText',text:JSON.stringify({
    documentId:observation.documentId,url:observation.url,text:'Observed destination receipt'})}]},{
    call:sourceCall,descriptor,browserObservation:observation,criteria:[{id:'receipt',kind:'external-confirmation',receiptBinding:binding}],commitments:[original]});
  const input=normalized.evidence.find(proof=>proof.kind==='external-confirmation');
  assert.ok(input,'real host normalizer must emit the historical scoped destination receipt');
  assert.equal(input.confirmation.status,'absent');
  const proof=normalizeContractEvidence(input,{operationId:'source-observation',workItemId:'receipt-item',at:'2026-11-12T00:00:00.000Z'});
  const source=row(descriptor.resources,{...descriptor,operationId:'source-observation',workItemId:'receipt-item',journalSeq:2,deliveryState:'returned',
    effectState:descriptor.effect==='observe'?'not-applicable':'confirmed',success:true,tool:'relay_browser',action,evidenceIds:[proof.id]});
  original.effectState='absent';original.reconciliationEvidenceIds=[proof.id];
  return{...f,target,value:{...journal('ancient-task',[original,source]),evidence:[proof]}};
}
for(const action of ['read','click'])test('historical scopeOnly destination receipt from successful '+action+' preserves supported absence',async t=>{
  const f=await historicalScopedReceipt(t,action);
  assert.equal(f.value.evidence[0].resourceKey,'origin:https://portal.test');
  assert.equal(f.value.records[1].effect,action==='read'?'observe':'opaque');
  const file=await f.save([],{value:f.value}),before=await fs.readFile(file,'utf8');
  await assertNoRetainedEffectConflict(f.store,'new-task',f.target);
  assert.equal(await fs.readFile(file,'utf8'),before);
});

test('scoped historical receipt rejects wrong destination, document, adapter, action and source scope',async t=>{
  const f=await historicalScopedReceipt(t,'read');
  const changeProof=(value,change)=>{
    const {id,operationId,workItemId,at,...input}=value.evidence[0];change(input);
    const proof=normalizeContractEvidence(input,{operationId,workItemId,at});value.evidence=[proof];
    value.records[0].reconciliationEvidenceIds=[proof.id];value.records[1].evidenceIds=[proof.id];
  };
  for(const mutate of [
    value=>changeProof(value,proof=>{proof.validation.destinationKey='destination:https://other.test/enroll';}),
    value=>changeProof(value,proof=>{proof.validation.documentId='different-document';}),
    value=>changeProof(value,proof=>{proof.validation.source='caller-claim';}),
    value=>changeProof(value,proof=>{proof.validation.action='click';}),
    value=>{value.records[1].tool='relay_workspace';},
    value=>{value.records[1].resources.find(resource=>resource.key==='document:after').scopeKeys=[];},
    value=>{value.records[1].resources.find(resource=>resource.key==='document:after').scopeKeys='origin:https://portal.test';},
    value=>{value.records[1].resources.find(resource=>resource.key==='origin:https://portal.test').scopeOnly=false;value.records[1].resources.push({key:'origin:https://portal.test',access:'read'});}
  ]){
    const invalid=structuredClone(f.value);mutate(invalid);await f.save([],{value:invalid});
    await assert.rejects(assertNoRetainedEffectConflict(f.store,'new-task',f.target),{code:'TASK_CONTRACT_JOURNAL_UNAVAILABLE'});
  }
});
