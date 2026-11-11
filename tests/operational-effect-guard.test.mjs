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
  raw.normalizeOperationResult=async(receipt,context)=>{
    return callValue(receipt,context);
  };
  let evidence=()=>({effectState:'unconfirmed',evidence:[]});
  const callValue=(receipt,context)=>evidence(receipt,context);
  const guard=(taskId='task-A',used=store)=>createOperationalEffectGuard({store:used,cwd,taskId,runId:'run-'+taskId,nodeId:'agent',onEvent:event=>events.push(event)});
  const submit=async(selected=descriptor(),selectedGuard=guard(),result)=>selectedGuard.wrap(raw)({...args('click','call-'+(++attempts)),descriptor:selected,result});
  return {directory,cwd,dataDir,store,makeStore,guard,submit,events,raw, counts:()=>({attempts,dispatched}),setEvidence:fn=>{evidence=fn;}};
}

test('recognized ATS history is checked and UNKNOWN is durably reserved before a native submit without any plan or task context',async t=>{
  const f=await fixture(t);
  const first=await f.submit(descriptor('submit-A',jobA),f.guard('first'));
  assert.equal(first.success,true);
  assert.equal(f.counts().dispatched,1);
  assert.equal(f.events.at(-1).state,'unknown');
  assert.equal(f.events.at(-1).source,'application');
  const second=await f.submit(descriptor('submit-A-retry',jobA),f.guard('second'));
  assert.equal(second.success,false);
  assert.equal(second.code,'APPLICATION_HISTORY_RESERVED');
  assert.equal(f.counts().dispatched,1,'no second application was dispatched');
  const other=await f.submit(descriptor('submit-B',jobB),f.guard('third'));
  assert.equal(other.success,true);
  assert.equal(f.counts().dispatched,2,'unrelated requisitions continue');
  assert.notEqual(applicationTarget(jobA).key,applicationTarget(jobB).key);
});

test('older application history survives planning removal and fences native submissions',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.cwd,'applications.jsonl'),JSON.stringify({url:jobA,status:'submitted'})+'\n');
  const outcome=await f.submit(descriptor('prior-job',jobA),f.guard());
  assert.equal(outcome.code,'APPLICATION_HISTORY_PRIOR');
  assert.equal(f.counts().dispatched,0);
  const different=await f.submit(descriptor('different',jobB),f.guard());
  assert.equal(different.success,true);
});

test('non-ATS commit receipt is durable across store and worker lifetimes, without requiring an attached taskContext',async t=>{
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
  assert.equal(duplicate.code,'OPERATIONAL_EFFECT_UNCERTAIN');
  assert.equal(f.counts().dispatched,1);
  const unrelated=await f.submit(descriptor('generic-2'),f.guard('task-two',reopened));
  assert.equal(unrelated.success,true);
  assert.equal(f.counts().dispatched,2);
});

test('one simultaneous cross-task reservation wins, while a second exact effect remains stopped',async t=>{
  const f=await fixture(t),otherStore=await f.makeStore();
  const [a,b]=await Promise.all([
    f.submit(descriptor('racing-1'),f.guard('first')),
    f.submit(descriptor('racing-1'),f.guard('second',otherStore))
  ]);
  assert.equal([a,b].filter(row=>row.success).length,1);
  assert.equal([a,b].find(row=>!row.success).code,'OPERATIONAL_EFFECT_UNCERTAIN');
  assert.equal(f.counts().dispatched,1);
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

test('only independently observed matching host confirmation can mark a commit confirmed',async t=>{
  const f=await fixture(t),d=descriptor('evidence-one');
  f.setEvidence(()=>({effectState:'confirmed',evidence:[{id:'host-evidence',confirmation:{effectKey:'evidence-one',status:'confirmed'}}]}));
  const first=await f.submit(d,f.guard('one'));
  assert.equal(first.success,true);
  assert.equal((await f.guard('one').records())[0].state,'confirmed');
  const replay=await f.submit(d,f.guard('two'));
  assert.equal(replay.code,'OPERATIONAL_EFFECT_UNCERTAIN');
  assert.equal(f.counts().dispatched,1);
});

test('a damaged claim file prevents only consequential effects; ordinary inspection remains available',async t=>{
  const f=await fixture(t),g=f.guard('one');
  await writeFile(f.store.file(g.scopeId)+'.effects','not-json');
  const refused=await f.submit(descriptor('new-commit'),g);
  assert.equal(refused.code,'OPERATIONAL_RECEIPTS_UNAVAILABLE');
  assert.equal(f.counts().dispatched,0);
  const observed=await g.wrap(f.raw)({...args('snapshot'),descriptor:descriptor('x','https://example.com','observe')});
  assert.equal(observed.success,true);
});

test('unclassified final submission on a recognized ATS cannot bypass form classification',async t=>{
  const f=await fixture(t),d=descriptor('ambiguous',jobA,'opaque');
  const response=await f.submit(d,f.guard());
  assert.equal(response.code,'APPLICATION_HISTORY_UNINSPECTED');
  assert.equal(f.counts().dispatched,0);
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
