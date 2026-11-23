import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskStateStore } from '../lib/task-state.mjs';
import { createOperationalEffectGuard } from '../lib/operational-effect-guard.mjs';
import { applicationTarget } from '../lib/application-history.mjs';

const jobA='https://jobs.ashbyhq.com/ExampleCo/11111111-1111-4111-8111-111111111111';
const jobB='https://jobs.ashbyhq.com/ExampleCo/22222222-2222-4222-8222-222222222222';
const receipt=body=>({success:true,contentItems:[{type:'inputText',text:JSON.stringify(body)}]});
const args=(action='click',callId)=>({name:'relay_browser',callId,arguments:{action,browser:'relay',tabId:'task-one',ref:'submit'}});
const descriptor=(effectKey='generic-effect',url='https://example.com/other',effect='commit')=>({
  version:1,effect,operationKey:'operation:'+effectKey,
  applicationPage:{url,title:'Senior Data Engineer | ExampleCo',submission:'final'},
  resources:[{key:'form:'+effectKey,access:'write',scopeOnly:false}],
  commit:{effectKey,destinationKey:'destination:'+url+'/application',pageUrl:url,payloadDigest:'digest:'+effectKey},
});
async function fixture(t){
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-standalone-effects-')),cwd=path.join(directory,'workspace'),dataDir=path.join(directory,'data');
  await mkdir(cwd);
  const stores=[], makeStore=async()=>{const store=await new TaskStateStore({dataDir}).init();stores.push(store);return store;};
  const store=await makeStore();const events=[];
  t.after(async()=>{for(const item of stores)await item.close();await rm(directory,{recursive:true,force:true});});
  let attempts=0,dispatched=0;
  const raw=async(call,context)=>{
    attempts++;
    const found=call.descriptor;
    try{if(context.onOperationDispatch)await context.onOperationDispatch(found);}
    catch(error){return{success:false,code:error.code||'DENIED',contentItems:[{type:'inputText',text:JSON.stringify({code:error.code,actionDispatched:false})}]};}
    dispatched++;
    if(call.result) return call.result;
    return receipt({actionDispatched:true,confirmed:false});
  };
  raw.describeOperation=async call=>call.descriptor;
  raw.normalizeOperationResult=async(receipt,context)=>{
    return callValue(receipt,context);
  };
  let evidence=()=>({effectState:'unconfirmed',evidence:[]});
  const callValue=(receipt,context)=>evidence(receipt,context);
  const guard=(taskId='task-A',used=store)=>createOperationalEffectGuard({store:used,cwd,taskId,runId:'run-'+taskId,nodeId:'agent',onEvent:event=>events.push(event)});
  const submit=async(selected=descriptor(),selectedGuard=guard(),result)=>selectedGuard.wrap(raw)({...args('click','call-'+(++attempts)),descriptor:selected,result});
  return {directory,cwd,dataDir,store,makeStore,guard,submit,events,raw, counts:()=>({attempts,dispatched}),setEvidence:fn=>{evidence=fn;}};
}

test('ATS actions use generic exact-effect receipts, not application-history fencing',async t=>{
  const f=await fixture(t);
  const first=await f.submit(descriptor('submit-A',jobA),f.guard('first'));
  assert.equal(first.success,true);
  assert.equal(f.counts().dispatched,1);
  assert.equal(f.events.at(-1).state,'unknown');
  assert.equal(f.events.at(-1).source,'generic');
  const second=await f.submit(descriptor('submit-A-retry',jobA),f.guard('second'));
  assert.equal(second.success,true);
  assert.equal(f.counts().dispatched,2,'distinct effect is not blocked by ATS identity');
  const other=await f.submit(descriptor('submit-B',jobB),f.guard('third'));
  assert.equal(other.success,true);
  assert.equal(f.counts().dispatched,3,'unrelated requisitions continue');
  assert.notEqual(applicationTarget(jobA).key,applicationTarget(jobB).key);
});

test('legacy 8 MiB workspace journal keeps every unknown effect and admits new receipts',async t=>{
  const f=await fixture(t),g=f.guard('new-work');
  const legacy={operationId:'legacy-original',taskId:'original-task',runId:'original-run',
    nodeId:'agent',effect:'commit',operationKey:'operation:legacy',state:'unknown',
    resources:['path:legacy-source'],content:'x'.repeat(9*1024*1024)};
  const file=f.store.file(g.scopeId)+'.effects';
  const initial=JSON.stringify({version:1,root:f.cwd,records:[legacy]});
  assert.ok(Buffer.byteLength(initial)>8*1024*1024, 'This reproduces the former hard limit.');
  await writeFile(file,initial);
  const result=await f.submit(descriptor('fresh-task'),g);
  assert.equal(result.success,true);
  const records=await g.records();
  assert.equal(records.length,2, 'Existing unknown and new operation must both persist.');
  assert.equal(records[0].operationId,legacy.operationId);
  assert.equal(records[0].state,'unknown');
  assert.equal(records[0].content.length,legacy.content.length, 'No old receipt content may be discarded.');
  assert.equal(records[1].taskId,'new-work');
  assert.equal(records[1].state,'unknown', 'A successful transport is not proof of completion.');
  const reopened=f.guard('independent-task',await f.makeStore());
  assert.deepEqual((await reopened.records()).map(row=>row.operationId),
    records.map(row=>row.operationId),'Reopening retains both effect identities.');
});

test('older application history remains data, not a native dispatch gate',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.cwd,'applications.jsonl'),JSON.stringify({url:jobA,status:'submitted'})+'\n');
  const outcome=await f.submit(descriptor('prior-job',jobA),f.guard());
  assert.equal(outcome.success,true);
  assert.equal(f.counts().dispatched,1);
  const different=await f.submit(descriptor('different',jobB),f.guard());
  assert.equal(different.success,true);
});

test('receipts persist across lifetimes without vetoing a new explicit browser call',async t=>{
  const f=await fixture(t),d=descriptor('generic-1');
  const first=await f.submit(d,f.guard('task-one'));
  assert.equal(first.success,true);
  const rows=await f.guard('task-one').records();
  assert.equal(rows.length,1);
  assert.equal(rows[0].state,'unknown');
  assert.equal(rows[0].effectKey,'generic-1');
  assert.equal(rows[0].runId,'run-task-one');
  await f.store.close();
  const reopened=await f.makeStore();
  const duplicate=await f.submit(d,f.guard('task-two',reopened));
  assert.equal(duplicate.success,true);
  assert.equal(f.counts().dispatched,2);
  const unrelated=await f.submit(descriptor('generic-2'),f.guard('task-two',reopened));
  assert.equal(unrelated.success,true);
  assert.equal(f.counts().dispatched,3);
});

test('an exact retained browser effect is not replayed and does not gate new reads or unrelated pages',async t=>{
  const f=await fixture(t), guard=f.guard('tracking'), wrap=guard.wrap(f.raw);
  const click={...args('click','retained-click'),descriptor:descriptor('submit-A',jobA)};
  const previous=await wrap(click);
  assert.equal((await guard.records())[0].state,'unknown');
  assert.deepEqual(await wrap(click),previous);
  assert.equal(f.counts().dispatched,1);
  assert.equal((await wrap({...args('snapshot','observe-A'),descriptor:descriptor('read-A',jobA,'observe')})).success,true);
  assert.equal((await wrap({...args('open','unrelated-open'),descriptor:descriptor('new-page',jobB,'observe')})).success,true);
  assert.equal(f.counts().dispatched,3);
});

test('explicit simultaneous browser calls are observed without cross-task veto',async t=>{
  const f=await fixture(t),otherStore=await f.makeStore();
  const [a,b]=await Promise.all([
    f.submit(descriptor('racing-1'),f.guard('first')),
    f.submit(descriptor('racing-1'),f.guard('second',otherStore))
  ]);
  assert.equal([a,b].filter(row=>row.success).length,2);
  assert.equal(f.counts().dispatched,2);
});

test('host-confirmed non-dispatch releases a local reservation but an unverified successful click never does',async t=>{
  const f=await fixture(t),d=descriptor('not-sent');
  const first=await f.submit(d,f.guard('one'),{success:false,code:'BROWSER_REF_STALE',
    contentItems:[{type:'inputText',text:JSON.stringify({actionDispatched:false})}]});
  assert.equal(first.success,false);
  assert.equal((await f.guard('one').records())[0].state,'absent');
  const retried=await f.submit(d,f.guard('two'));
  assert.equal(retried.success,true);
  assert.equal((await f.guard('two').records()).at(-1).state,'unknown','tool success is not external confirmation');
});

test('a fabricated normalizer confirmation cannot substitute for a native receipt',async t=>{
  const f=await fixture(t),d=descriptor('evidence-one');
  f.setEvidence(()=>({effectState:'confirmed',evidence:[{id:'host-evidence',confirmation:{effectKey:'evidence-one',status:'confirmed'}}]}));
  const first=await f.submit(d,f.guard('one'));
  assert.equal(first.success,true);
  assert.equal((await f.guard('one').records())[0].state,'unknown');
  const replay=await f.submit(d,f.guard('two'));
  assert.equal(replay.success,true);
  assert.equal(f.counts().dispatched,2);
});

test('damaged receipt storage reports a warning without blocking browser input',async t=>{
  const f=await fixture(t),g=f.guard('one');
  await writeFile(f.store.file(g.scopeId)+'.effects','not-json');
  const refused=await f.submit(descriptor('new-commit'),g);
  assert.equal(refused.success,true);
  assert.equal(f.counts().dispatched,1);
  assert.ok(f.events.some(row=>row.type==='operation.receipt.warning'));
  const observed=await g.wrap(f.raw)({...args('snapshot'),descriptor:descriptor('x','https://example.com','observe')});
  assert.equal(observed.success,true);
});

test('opaque ATS action is not blocked by application label classification',async t=>{
  const f=await fixture(t),d=descriptor('ambiguous',jobA,'opaque');
  const response=await f.submit(d,f.guard());
  assert.equal(response.success,true);
  assert.equal(f.counts().dispatched,1);
});

test('native effect guard never adds plan modules, response-cycle calls, or automatic model turns',async t=>{
  const f=await fixture(t),g=f.guard('one');
  assert.equal('planning' in g,false);
  assert.equal('responseCycle' in g,false);
  assert.deepEqual(await g.records(),[]);
  await f.submit(descriptor('any-one'),g);
  assert.equal(f.events.length,1);
  assert.equal(f.events[0].type,'operational.effect');
});

test('malformed historical files and legacy claims do not block browser dispatch',async t=>{
 const f=await fixture(t);
 await writeFile(path.join(f.cwd,'applications.jsonl'),'not JSON');
 await mkdir(path.join(f.cwd,'.application-registry'));
 await writeFile(path.join(f.cwd,'.application-registry','claims.json'),'not JSON');
 const result=await f.submit(descriptor('fresh',jobA),f.guard());
 assert.equal(result.success,true); assert.equal(f.counts().dispatched,1);
 assert.equal(await readFile(path.join(f.cwd,'applications.jsonl'),'utf8'),'not JSON');
});
test('neither runtime invokes application-history gate',async()=>{
 for(const file of ['operational-effect-guard.mjs','planning-contract-runtime.mjs']){
  const source=await readFile(new URL('../lib/'+file,import.meta.url),'utf8');
  assert.doesNotMatch(source,/createApplicationHistoryGate|applicationHistory\.(?:check|reconcile)|application\.check/);
 }
});

test('same call ID returns its saved result without replay, while a new call stays explicit',async t=>{
 const f=await fixture(t),g=f.guard(),run=g.wrap(f.raw),call={...args('click','stable'),descriptor:descriptor('same')};
 const first=await run(call),second=await run(call);
 assert.deepEqual(second,first); assert.equal(f.counts().dispatched,1);
 assert.equal((await run({...call,callId:'new-explicit-call'})).success,true);
 assert.equal(f.counts().dispatched,2);
});
test('browser explicit input never opens owner recovery for retained history',async t=>{
 const f=await fixture(t); let requested=0;
 const g=createOperationalEffectGuard({store:f.store,cwd:f.cwd,taskId:'test',runId:'run',nodeId:'agent',ownerRecovery:{enabled:true,request:async()=>{requested++;throw Error('must not request');}}});
 await f.submit(descriptor('same'),g); await f.submit(descriptor('same'),g);
 assert.equal(requested,0); assert.equal(f.counts().dispatched,2);
});

for(const fault of ['unreadable','reservation-write'])test('same call is retained in memory under '+fault+' without blocking new calls',async t=>{
 const f=await fixture(t),g=f.guard(),run=g.wrap(f.raw),call={...args('click','stable-degraded'),descriptor:descriptor('same')};
 if(fault==='unreadable')await writeFile(f.store.file(g.scopeId)+'.effects','not-json');
 else f.store.enqueue=async()=>{throw Error('synthetic reservation storage failure');};
 const first=await run(call);assert.equal(first.success,true);
 assert.deepEqual(await run(call),first);assert.equal(f.counts().dispatched,1);
 await assert.rejects(run({...call,arguments:{...call.arguments,ref:'changed'}}),{code:'OPERATIONAL_CALL_ID_REUSED'});
 assert.equal((await run({...call,callId:'explicit-new'})).success,true);assert.equal(f.counts().dispatched,2);
});
test('two guard instances share the exact call identity in process even with degraded storage',async t=>{
 const f=await fixture(t),g=f.guard(),other=f.guard('task-A',await f.makeStore());
 await writeFile(f.store.file(g.scopeId)+'.effects','not-json');
 const call={...args('click','shared-identity'),descriptor:descriptor('same')};
 const [first,second]=await Promise.all([g.wrap(f.raw)(call),other.wrap(f.raw)(call)]);
 assert.deepEqual(second,first);assert.equal(f.counts().dispatched,1);
 assert.deepEqual(await other.wrap(f.raw)(call),first);assert.equal(f.counts().dispatched,1);
 assert.equal((await other.wrap(f.raw)({...call,callId:'new'})).success,true);assert.equal(f.counts().dispatched,2);
});
test('lost-return rejection is retained in memory without redispatch under damaged storage',async t=>{
 const f=await fixture(t),g=f.guard();await writeFile(f.store.file(g.scopeId)+'.effects','not-json');
 let dispatches=0;const raw=async(call,context)=>{await context.onOperationDispatch(call.descriptor);dispatches++;throw Object.assign(Error('lost return'),{code:'LOST'});};
 raw.describeOperation=async call=>call.descriptor;const run=g.wrap(raw),call={...args('click','lost'),descriptor:descriptor('same')};
 await assert.rejects(run(call),{code:'LOST'});await assert.rejects(run(call),{code:'LOST'});assert.equal(dispatches,1);
});

test('degraded cache bounds result retention while old identities never redispatch',async t=>{
 const f=await fixture(t),g=f.guard(),run=g.wrap(f.raw);await writeFile(f.store.file(g.scopeId)+'.effects','bad');
 for(let i=0;i<40;i++)await run({...args('click','bounded-'+i),descriptor:descriptor('same')});
 await assert.rejects(run({...args('click','bounded-0'),descriptor:descriptor('same')}),{code:'OPERATIONAL_RESULT_UNAVAILABLE'});
 assert.equal(f.counts().dispatched,40);
 assert.equal((await run({...args('click','bounded-39'),descriptor:descriptor('same')})).success,true);
 assert.equal(f.counts().dispatched,40);
 await run({...args('click','large'),descriptor:descriptor('same'),result:receipt({payload:'x'.repeat(70000)})});
 await assert.rejects(run({...args('click','large'),descriptor:descriptor('same')}),{code:'OPERATIONAL_RESULT_UNAVAILABLE'});
 assert.equal(f.counts().dispatched,41);
});
test('healthy saved calls are recovered from durable receipts, not retained payload cache',async t=>{
 const f=await fixture(t),g=f.guard(),run=g.wrap(f.raw),call={...args('click','healthy'),descriptor:descriptor('same')};
 await run(call);const file=f.store.file(g.scopeId)+'.effects',journal=JSON.parse(await readFile(file,'utf8'));
 journal.records[0].result=receipt({fromDurable:true});await writeFile(file,JSON.stringify(journal));
 assert.deepEqual(await run(call),receipt({fromDurable:true}));assert.equal(f.counts().dispatched,1);
});

for(const fault of ['corrupt','missing'])test('healthy saved identity survives later '+fault+' journal without replay',async t=>{
 const f=await fixture(t),g=f.guard(),run=g.wrap(f.raw),call={...args('click','healthy-degraded'),descriptor:descriptor('same')};
 await run(call);const file=f.store.file(g.scopeId)+'.effects';
 if(fault==='corrupt')await writeFile(file,'bad');else await rm(file);
 await assert.rejects(run(call),{code:'OPERATIONAL_RESULT_UNAVAILABLE'});assert.equal(f.counts().dispatched,1);
 assert.equal((await run({...call,callId:'new-after-degradation'})).success,true);assert.equal(f.counts().dispatched,2);
});

test('browser stale-reference preflight settles Directory without replaying; a fresh explicit call can proceed',async t=>{
 const f=await fixture(t);const {TaskActionDirectory}=await import('../lib/task-action-directory.mjs');
 const ledger=new TaskActionDirectory({taskId:'task-A',objective:'Inspect local fixture'});
 await ledger.edit({action:'plan',revision:0,actions:[{id:'inspect',objective:'Inspect a synthetic source',dependsOn:[]}]});
 await ledger.edit({action:'focus',id:'inspect',revision:1});
 const describe=f.raw.describeOperation;
 f.raw.describeOperation=async call=>{if(call.arguments.ref==='old')throw Object.assign(Error('Take a fresh snapshot and choose an element ref.'),{code:'BROWSER_REF_STALE'});return describe(call);};
 const handle=f.guard().wrap(f.raw),scope={runId:'run-task-A',nodeId:'agent'};
 const stale={...args('click','stale'),descriptor:descriptor('synthetic')};stale.arguments.ref='old';
 for(let i=0;i<2;i++)await assert.rejects(ledger.execute(stale,handle,scope),{code:'BROWSER_REF_STALE',actionDispatched:false});
 assert.equal(f.counts().dispatched,0);
 assert.deepEqual(ledger.finalStatus().unknown,[]);
 assert(ledger.read().receipts.every(r=>r.state==='returned'&&r.success===false&&r.actionDispatched===false));
 const fresh={...args('click','fresh'),descriptor:descriptor('synthetic')};fresh.arguments.ref='new';
 const next=await ledger.execute(fresh,handle,scope);
 assert.equal(next.result.success,true);assert.equal(f.counts().dispatched,1);
});
test('pre-pointer capture diagnostic preserves operationally unknown effect',async t=>{
  const f=await fixture(t);
  const body={code:'BROWSER_CAPTURE_TIMEOUT',pointerStage:'pre-pointer-capture'};
  const guard=f.guard('pre-pointer');
  const result=await f.submit(descriptor('capture-unknown',jobA),guard,{...receipt(body),success:false,code:body.code});
  assert.equal(result.success,false);
  assert.equal(JSON.parse(result.contentItems[0].text).pointerStage,'pre-pointer-capture');
  assert.equal(f.events.at(-1).state,'unknown');
  assert.equal((await guard.records()).at(-1).state,'unknown');
});
