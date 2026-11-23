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

test('corrupted legacy receipt storage denies external input but keeps independent observations available',async t=>{
  const f=await fixture(t),g=f.guard('one');
  await writeFile(f.store.file(g.scopeId)+'.effects','not-json');
  const refused=await f.submit(descriptor('new-commit'),g);
  assert.equal(refused.success,false);
  assert.equal(refused.code,'OPERATIONAL_RECEIPTS_UNAVAILABLE');
  assert.equal(f.counts().dispatched,0);
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

for(const fault of ['unreadable','reservation-write'])test('receipt '+fault+' fails closed without browser dispatch',async t=>{
  const f=await fixture(t),g=f.guard(),run=g.wrap(f.raw),call={...args('click','stable-degraded'),descriptor:descriptor('same')};
  if(fault==='unreadable')await writeFile(f.store.file(g.scopeId)+'.effects','not-json');
  else f.store.enqueue=async()=>{throw Error('synthetic reservation storage failure');};
  const first=await run(call);
  assert.equal(first.success,false);
  assert.equal(f.counts().dispatched,0);
  assert.deepEqual(await run(call),first);
  await assert.rejects(run({...call,arguments:{...call.arguments,ref:'changed'}}),{code:'OPERATIONAL_CALL_ID_REUSED'});
  assert.equal((await run({...call,callId:'explicit-new'})).success,false);
  assert.equal(f.counts().dispatched,0);
});

test('two guard instances share rejected call identity without dispatching when storage is damaged',async t=>{
  const f=await fixture(t),g=f.guard(),other=f.guard('task-A',await f.makeStore());
  await writeFile(f.store.file(g.scopeId)+'.effects','not-json');
  const call={...args('click','shared-identity'),descriptor:descriptor('same')};
  const [first,second]=await Promise.all([g.wrap(f.raw)(call),other.wrap(f.raw)(call)]);
  assert.deepEqual(second,first);assert.equal(first.success,false);assert.equal(f.counts().dispatched,0);
  assert.deepEqual(await other.wrap(f.raw)(call),first);
  assert.equal((await other.wrap(f.raw)({...call,callId:'new'})).success,false);
  assert.equal(f.counts().dispatched,0);
});

test('a broken operational ledger prevents even an adapter that would otherwise lose its return',async t=>{
  const f=await fixture(t),g=f.guard();await writeFile(f.store.file(g.scopeId)+'.effects','not-json');
  let dispatched=0;
  const raw=async(call,context)=>{await context.onOperationDispatch(call.descriptor);dispatched++;throw Error('would have lost return');};
  raw.describeOperation=async call=>call.descriptor;
  const run=g.wrap(raw),call={...args('click','lost'),descriptor:descriptor('same')};
  await assert.rejects(run(call),{code:'OPERATIONAL_RECEIPTS_UNAVAILABLE'});
  await assert.rejects(run(call),{code:'OPERATIONAL_RECEIPTS_UNAVAILABLE'});
  assert.equal(dispatched,0);
});

test('degraded storage denies new identities rather than storing unsafe in-memory only effects',async t=>{
  const f=await fixture(t),g=f.guard(),run=g.wrap(f.raw);
  await writeFile(f.store.file(g.scopeId)+'.effects','bad');
  for(let i=0;i<40;i++)assert.equal((await run({...args('click','bounded-'+i),descriptor:descriptor('same')})).success,false);
  assert.equal(f.counts().dispatched,0);
  assert.equal((await run({...args('snapshot'),descriptor:descriptor('observe','https://example.org','observe')})).success,true);
  assert.equal(f.counts().dispatched,1,'read-only inspection remains possible');
});

test('successful exact-call results survive new guard instances and large payloads without replay',async t=>{
  const f=await fixture(t),g=f.guard(),run=g.wrap(f.raw),call={...args('click','healthy'),descriptor:descriptor('same'),result:receipt({payload:'x'.repeat(260000)})};
  const first=await run(call);
  const db=f.store.file(g.scopeId)+'.effects.sqlite';
  assert.ok((await (await import('node:fs/promises')).stat(db)).size>0);
  const nextGuard=f.guard('task-A',await f.makeStore());
  assert.deepEqual(await nextGuard.wrap(f.raw)(call),first);
  assert.equal(f.counts().dispatched,1);
  const rows=await g.records();
  assert.equal(rows[0].result.contentItems[0].text.length,first.contentItems[0].text.length);
});

test('legacy journal remains a preserved backup; subsequent changes are detected rather than silently omitted',async t=>{
  const f=await fixture(t),g=f.guard(),run=g.wrap(f.raw);
  const file=f.store.file(g.scopeId)+'.effects';
  const legacy={version:1,root:f.cwd,records:[]};
  await writeFile(file,JSON.stringify(legacy));
  const call={...args('click','healthy'),descriptor:descriptor('same')};
  assert.equal((await run(call)).success,true);
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),legacy,'migration never edits the legacy journal');
  await writeFile(file,JSON.stringify({...legacy,records:[{invalid:true}]}));
  assert.equal((await run({...call,callId:'new-after-external-mutation'})).success,false);
  assert.equal(f.counts().dispatched,1,'no new effects allowed until the legacy conflict is reconciled');
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

test('a legacy journal above 8 MiB and 10000 receipts migrates without deleting uncertain effects',async t=>{
  const f=await fixture(t),g=f.guard('legacy'),handle=g.wrap(f.raw),file=f.store.file(g.scopeId)+'.effects';
  const base={operationId:'historical-0',taskId:'historical',runId:'run-historical',nodeId:'agent',
    effect:'commit',state:'unknown',adapter:'relay_browser',action:'click',operationKey:'historical-operation',
    resources:[],evidence:[],interpretations:[],note:'x'.repeat(920)};
  const records=Array.from({length:10030},(_,i)=>({...base,operationId:'historical-'+i}));
  const legacy={version:1,root:f.cwd,records},original=JSON.stringify(legacy);
  assert.ok(Buffer.byteLength(original)>8*1024*1024);
  await writeFile(file,original);
  const fresh={...args('click','after-large-migration'),descriptor:descriptor('new')};
  assert.equal((await handle(fresh)).success,true);
  assert.equal(await readFile(file,'utf8'),original,'original journal is preserved byte-for-byte');
  const after=await g.records();
  assert.equal(after.length,records.length+1);
  assert.equal(after.filter(row=>row.state==='unknown').length,records.length+1);
  assert.equal((await handle(fresh)).success,true);
  assert.equal(f.counts().dispatched,1,'the same call was not replayed');
});

test('a deleted SQLite ledger cannot silently roll back to pre-migration receipts',async t=>{
  const f=await fixture(t),g=f.guard('deleted-ledger'),run=g.wrap(f.raw);
  const first={...args('click','one'),descriptor:descriptor('once')};
  assert.equal((await run(first)).success,true);
  const db=f.store.file(g.scopeId)+'.effects.sqlite';
  await rm(db);
  const second=await run({...args('click','two'),descriptor:descriptor('next')});
  assert.equal(second.success,false);
  assert.equal(f.counts().dispatched,1);
  assert.equal((await run({...args('snapshot'),descriptor:descriptor('read','https://example.net','observe')})).success,true);
});

test('an incomplete migration anchor fails closed instead of recreating a new ledger',async t=>{
  const f=await fixture(t),g=f.guard('incomplete'),file=f.store.file(g.scopeId)+'.effects';
  await writeFile(file+'.sqlite.anchor','{"version":1,"root":"unknown","ledgerId":"incomplete"}');
  const refused=await g.wrap(f.raw)({...args('click','external'),descriptor:descriptor('commit')});
  assert.equal(refused.success,false);
  assert.equal(f.counts().dispatched,0);
});

test('corrupted SQLite database fails closed without deleting or replaying saved effects',async t=>{
  const f=await fixture(t),g=f.guard('db-damage'),run=g.wrap(f.raw);
  const call={...args('click','first-effect'),descriptor:descriptor('first')};
  assert.equal((await run(call)).success,true);
  const db=f.store.file(g.scopeId)+'.effects.sqlite';
  await writeFile(db,'damaged database');
  const another=await run({...args('click','second-effect'),descriptor:descriptor('second')});
  assert.equal(another.success,false);
  assert.equal(f.counts().dispatched,1,'no effect was dispatched after corruption');
  assert.equal((await run({...args('snapshot'),descriptor:descriptor('read','https://example.net','observe')})).success,true);
});
