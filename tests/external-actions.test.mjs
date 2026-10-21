import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile,utimes} from 'node:fs/promises';
import {promises as io} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {TaskStateStore,createTaskToolHandler,TASK_TOOL,PREVIOUS_TASK_TOOL,LEGACY_TASK_TOOL,TASK_INSTRUCTIONS,PREVIOUS_TASK_INSTRUCTIONS} from '../lib/task-state.mjs';
import {capabilityGuidance} from '../lib/tool-routing.mjs';
import {newerTaskState} from '../public/run-state-model.mjs';

const prepared={receiptId:'blackice-post',operation:'prepare',destination:'https://www.linkedin.com/in/example/recent-activity/all/',content:'Building BLACKICE: a workspace for people and agents.',attachmentSha256:'a'.repeat(64)};
async function fixture(t){
 const directory=await mkdtemp(path.join(tmpdir(),'relay-external-test-')),cwd=path.join(directory,'workspace');await mkdir(cwd);
 const stores=[],open=async()=>{const store=await new TaskStateStore({dataDir:directory}).init();stores.push(store);return store;},store=await open();
 t.after(async()=>{await Promise.all(stores.map(item=>item.close()));assert.match(path.basename(directory),/^relay-external-test-/);await rm(directory,{recursive:true,force:true});});
 await store.ensure({taskId:'publication',runId:'initial',nodeId:'agent',cwd,goal:'Publish exactly one update with the checked screenshot.'});
 const options=revision=>({expectedRevision:revision,runId:'initial',nodeId:'agent'});
 const action=async(value,source=store)=>source.externalAction('publication',value,options((await source.get('publication')).revision));
 return{store,open,action,options};
}

test('an interrupted remote attempt survives restart and cannot be sent again until reconciled',async t=>{
 const f=await fixture(t);let state=await f.action(prepared);assert.equal(state.externalActions[0].status,'prepared');
 state=await f.action({receiptId:prepared.receiptId,operation:'attempt'});assert.equal(state.externalActions[0].status,'uncertain');assert.equal(state.externalActions[0].attempts,1);
 const restored=await f.open();assert.deepEqual(await restored.get('publication'),state);
 await assert.rejects(f.action({receiptId:prepared.receiptId,operation:'attempt'},restored),{code:'EXTERNAL_ACTION_RECONCILE'});
 state=await f.action({receiptId:prepared.receiptId,operation:'confirm',url:'https://www.linkedin.com/feed/update/urn:li:activity:123/',evidence:'Opened the resulting permalink and checked exact post text and the screenshot.'},restored);
 assert.equal(state.externalActions[0].status,'confirmed');assert.equal(state.externalActions[0].attempts,1);assert.equal(state.externalActions[0].verification,'agent-reported-external-evidence');
 await assert.rejects(f.action({receiptId:prepared.receiptId,operation:'attempt'},restored),{code:'EXTERNAL_ACTION_RECONCILE'});
 await assert.rejects(f.action({receiptId:prepared.receiptId,operation:'reconcile_absent',evidence:'Retry anyway.'},restored),{code:'EXTERNAL_ACTION_RECONCILE'});
});

for(const damage of ['corrupt','missing'])test(`a ${damage} newer primary cannot roll an external permit back to its prepared backup`,async t=>{
 const f=await fixture(t);await f.action(prepared);await f.action({receiptId:prepared.receiptId,operation:'attempt'});const file=f.store.file('publication');await f.store.close();
 if(damage==='corrupt')await writeFile(file,'{damaged');else await rm(file);
 const restored=await f.open();let saved=await restored.get('publication');assert.equal(saved.externalActions[0].status,'uncertain');assert.equal(saved.externalActions[0].attemptsMayBeIncomplete,true);assert.equal(saved.externalRecovery.required,true);
 await assert.rejects(f.action({receiptId:prepared.receiptId,operation:'attempt'},restored),{code:'EXTERNAL_ACTION_RECONCILE'});
 if(damage==='corrupt')assert.equal(await readFile(file,'utf8'),'{damaged');else await assert.rejects(readFile(file),{code:'ENOENT'});
 saved=await restored.checkpoint('publication',{nextAction:'Click Post again.'},f.options(saved.revision));
 const reopened=await f.open();assert.equal((await reopened.get('publication')).externalActions[0].status,'uncertain');await assert.rejects(f.action({receiptId:prepared.receiptId,operation:'attempt'},reopened),{code:'EXTERNAL_ACTION_RECONCILE'});
 saved=await f.action({receiptId:prepared.receiptId,operation:'confirm',url:'https://www.linkedin.com/feed/update/urn:li:activity:recovered/',evidence:'Fresh destination inspection found the existing exact text and checked screenshot.'},reopened);assert.equal(saved.externalActions[0].status,'confirmed');
});

test('backup recovery predating the first receipt blocks new prepares until observed reconciliation and persists across normal writes',async t=>{
 const f=await fixture(t);await f.action(prepared);const file=f.store.file('publication');await f.store.close();await rm(file);
 const restored=await f.open();let saved=await restored.get('publication');assert.equal(saved.externalActions,undefined);assert.equal(saved.externalRecovery.required,true);assert.match(await restored.getContext('publication',{maxChars:512}),/newer outcomes may be missing/);
 saved=await restored.checkpoint('publication',{nextAction:'Publish now.'},f.options(saved.revision));const reopened=await f.open();assert.equal((await reopened.get('publication')).externalRecovery.required,true);
 saved=await f.action(prepared,reopened);assert.equal(saved.externalActions[0].status,'uncertain');await assert.rejects(f.action({receiptId:prepared.receiptId,operation:'attempt'},reopened),{code:'EXTERNAL_ACTION_RECONCILE'});
 saved=await f.action({receiptId:prepared.receiptId,operation:'reconcile_absent',evidence:'Fresh own-activity inspection confirms no matching text and screenshot; the original draft remains unsent.'},reopened);assert.equal(saved.externalActions[0].status,'prepared');assert.ok(saved.externalActions[0].recoveryReconciledAt);
 saved=await f.action({receiptId:prepared.receiptId,operation:'attempt'},reopened);assert.equal(saved.externalActions[0].status,'uncertain');
 // A second damaged primary must invalidate the older reconciliation permit too.
 await writeFile(file,'{damaged again');saved=await reopened.get('publication');assert.equal(saved.externalActions[0].status,'uncertain');assert.equal(saved.externalActions[0].recoveryReconciledAt,undefined);await assert.rejects(f.action({receiptId:prepared.receiptId,operation:'attempt'},reopened),{code:'EXTERNAL_ACTION_RECONCILE'});
});

test('lost confirmations remain uncertain and backed-up confirmations remain terminal',async t=>{
 const f=await fixture(t);await f.action(prepared);await f.action({receiptId:prepared.receiptId,operation:'attempt'});const confirmation={receiptId:prepared.receiptId,operation:'confirm',url:'https://www.linkedin.com/feed/update/urn:li:activity:confirmed/',evidence:'Inspected exact live text and screenshot.'};await f.action(confirmation);
 const file=f.store.file('publication');await writeFile(file,'{lost confirmation');let saved=await f.store.get('publication');assert.equal(saved.externalActions[0].status,'uncertain');await assert.rejects(f.action({receiptId:prepared.receiptId,operation:'attempt'}),{code:'EXTERNAL_ACTION_RECONCILE'});
 saved=await f.action(confirmation);saved=await f.store.checkpoint('publication',{completed:['Verified the published result.']},f.options(saved.revision));await writeFile(file,'{lost checkpoint');saved=await f.store.get('publication');assert.equal(saved.externalActions[0].status,'confirmed');assert.equal(saved.externalActions[0].url,confirmation.url);await assert.rejects(f.action({receiptId:prepared.receiptId,operation:'attempt'}),{code:'EXTERNAL_ACTION_RECONCILE'});
});

test('first repaired publication skips the lost primary revision so clients adopt reconciled truth',async t=>{
 const f=await fixture(t);await f.action(prepared);const lost=await f.action({receiptId:prepared.receiptId,operation:'attempt'});await writeFile(f.store.file('publication'),'{damaged');
 const restored=await f.open();assert.equal((await restored.get('publication')).revision,lost.revision-1);
 let confirmed=await f.action({receiptId:prepared.receiptId,operation:'confirm',url:'https://www.linkedin.com/feed/update/urn:li:activity:reconciled/',evidence:'Fresh destination inspection found the exact content and screenshot.'},restored);
 assert.equal(confirmed.revision,lost.revision+1);assert.equal(newerTaskState(lost,confirmed,'publication'),confirmed);
 const next=await restored.checkpoint('publication',{completed:['Confirmed existing publication.']},f.options(confirmed.revision));assert.equal(next.revision,confirmed.revision+1,'ordinary writes resume normal revision increments');
});

test('an aged live writer retains its lock and cannot overwrite a later external attempt',async t=>{
 const f=await fixture(t),other=await f.open();let state=await f.action(prepared),release,started;const held=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
 const writing=f.store.update('publication',async saved=>{started();await held;return{...saved,goal:'A slow real file check finished.'};},f.options(state.revision));await entered;
 const lock=f.store.file('publication')+'.lock',aged=new Date(Date.now()-181000);await utimes(lock,aged,aged);const controller=new AbortController();let timer;
 try{
   const competing=other.externalAction('publication',{receiptId:prepared.receiptId,operation:'attempt'},{...f.options(state.revision),signal:controller.signal});timer=setTimeout(()=>controller.abort(),120);await assert.rejects(competing,{name:'AbortError'});assert.equal((await other.get('publication')).revision,state.revision);
 }finally{clearTimeout(timer);release();state=await writing;}
 assert.equal(state.goal,'A slow real file check finished.');assert.equal(state.externalActions[0].status,'prepared');state=await f.action({receiptId:prepared.receiptId,operation:'attempt'},other);assert.equal(state.externalActions[0].status,'uncertain');assert.equal(state.externalActions[0].attempts,1);
});

test('a writer that loses its lock token cannot publish or release the successor lock',async t=>{
 const f=await fixture(t);const preparedState=await f.action(prepared),lock=f.store.file('publication')+'.lock';let release,started;const held=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
 const writing=f.store.update('publication',async saved=>{started();await held;return{...saved,goal:'This stale write must be rejected.'};},f.options(preparedState.revision));await entered;
 await writeFile(lock,JSON.stringify({pid:process.pid,token:'successor-token'}));release();await assert.rejects(writing,{code:'TASK_STATE_LOCK_LOST'});assert.equal((await f.store.get('publication')).revision,preparedState.revision);assert.equal(JSON.parse(await readFile(lock,'utf8')).token,'successor-token');await rm(lock);
});

test('primary publication rechecks ownership after writing its backup',async t=>{
 const f=await fixture(t),state=await f.action(prepared),file=f.store.file('publication'),lock=file+'.lock',originalRename=io.rename;let replaced=false;
 io.rename=async(from,to)=>{const result=await originalRename(from,to);if(to===file+'.bak'&&!replaced){replaced=true;await writeFile(lock,JSON.stringify({pid:process.pid,token:'successor-after-backup'}));}return result;};
 try{await assert.rejects(f.store.externalAction('publication',{receiptId:prepared.receiptId,operation:'attempt'},f.options(state.revision)),{code:'TASK_STATE_LOCK_LOST'});assert.equal((await f.store.get('publication')).revision,state.revision);assert.equal((await f.store.get('publication')).externalActions[0].status,'prepared');assert.equal(JSON.parse(await readFile(lock,'utf8')).token,'successor-after-backup');}
 finally{io.rename=originalRename;await rm(lock,{force:true});}
});

test('dead task lock recovery keeps a live successor exclusive',async t=>{
 const f=await fixture(t),other=await f.open();const state=await f.action(prepared),lock=f.store.file('publication')+'.lock';await writeFile(lock,JSON.stringify({pid:2147483647,token:'dead-owner'}));
 const attempts=await Promise.allSettled([f.store.externalAction('publication',{receiptId:prepared.receiptId,operation:'attempt'},f.options(state.revision)),other.externalAction('publication',{receiptId:prepared.receiptId,operation:'attempt'},f.options(state.revision))]);
 assert.equal(attempts.filter(item=>item.status==='fulfilled').length,1);assert.ok(['TASK_STATE_CONFLICT','EXTERNAL_ACTION_RECONCILE'].includes(attempts.find(item=>item.status==='rejected').reason.code));assert.equal((await f.store.get('publication')).externalActions[0].status,'uncertain');assert.equal((await f.store.get('publication')).externalActions[0].attempts,1);
});

test('only observed absence rearms an uncertain send and keeps both attempt and reconciliation evidence',async t=>{
 const f=await fixture(t);await f.action(prepared);await f.action({receiptId:prepared.receiptId,operation:'attempt'});
 await assert.rejects(f.action({receiptId:prepared.receiptId,operation:'reconcile_absent',evidence:'  '}),{code:'INVALID_TASK_STATE'});
 let state=await f.action({receiptId:prepared.receiptId,operation:'reconcile_absent',evidence:'Refreshed own recent activity and inspected the composer: the network error left the draft open and no matching post exists.'});
 assert.equal(state.externalActions[0].status,'prepared');assert.equal(state.externalActions[0].attempts,1);assert.match(state.externalActions[0].absenceEvidence,/draft open/);
 state=await f.action({receiptId:prepared.receiptId,operation:'attempt'});assert.equal(state.externalActions[0].attempts,2);assert.equal(state.externalActions[0].status,'uncertain');
});

test('simultaneous workers get at most one durable attempt permit',async t=>{
 const f=await fixture(t),other=await f.open(),state=await f.action(prepared),args={receiptId:prepared.receiptId,operation:'attempt'};
 const results=await Promise.allSettled([f.store.externalAction('publication',args,f.options(state.revision)),other.externalAction('publication',args,{...f.options(state.revision),nodeId:'other-worker'})]);
 assert.equal(results.filter(item=>item.status==='fulfilled').length,1);assert.equal(results.find(item=>item.status==='rejected').reason.code,'TASK_STATE_CONFLICT');assert.equal((await f.store.get('publication')).externalActions[0].attempts,1);
});

test('receipt identity binds destination, exact content and screenshot bytes and rejects duplicate receipt IDs',async t=>{
 const f=await fixture(t);let state=await f.action(prepared);assert.match(state.externalActions[0].fingerprint,/^[a-f0-9]{64}$/);assert.equal(state.externalActions[0].content,undefined);
 for(const edit of [{content:prepared.content+' Changed.'},{attachmentSha256:'b'.repeat(64)},{destination:'https://www.linkedin.com/in/other/'}])await assert.rejects(f.action({...prepared,...edit}),{code:'EXTERNAL_ACTION_CONFLICT'});
 await assert.rejects(f.action({...prepared,receiptId:'second-receipt'}),{code:'EXTERNAL_ACTION_CONFLICT'});
 state=await f.action(prepared);assert.equal(state.externalActions.length,1);assert.equal(state.externalActions[0].status,'prepared');
 await f.action({receiptId:prepared.receiptId,operation:'attempt'});state=await f.action(prepared);assert.equal(state.externalActions[0].status,'uncertain','preparing again must never clear uncertainty');
});

test('a duplicate found before sending may be confirmed without another remote attempt',async t=>{
 const f=await fixture(t);await f.action(prepared);const confirmation={receiptId:prepared.receiptId,operation:'confirm',url:'https://www.linkedin.com/feed/update/urn:li:activity:123/',evidence:'Duplicate check found the existing exact text and screenshot at this permalink.'};
 let state=await f.action(confirmation);assert.equal(state.externalActions[0].attempts,0);assert.equal(state.externalActions[0].status,'confirmed');state=await f.action(confirmation);assert.equal(state.externalActions[0].attempts,0);
 await assert.rejects(f.action({...confirmation,url:'https://www.linkedin.com/feed/update/urn:li:activity:456/'}),{code:'EXTERNAL_ACTION_CONFLICT'});
});

test('unsafe URLs, empty evidence, absent preparation and unbounded receipts are rejected without state loss',async t=>{
 const f=await fixture(t);
 for(const destination of ['not a URL','file:///secret','https://user:password@linkedin.com/'])assert.throws(()=>f.store.externalAction('publication',{...prepared,destination},f.options(1)),{code:'INVALID_TASK_STATE'});
 for(const attachmentSha256 of ['nope','A'.repeat(64),123])assert.throws(()=>f.store.externalAction('publication',{...prepared,attachmentSha256},f.options(1)),{code:'INVALID_TASK_STATE'});
 await assert.rejects(f.action({receiptId:prepared.receiptId,operation:'attempt'}),{code:'EXTERNAL_ACTION_MISSING'});
 for(let i=0;i<8;i++)await f.action({...prepared,receiptId:'post-'+i,content:prepared.content+' '+i});
 await assert.rejects(f.action({...prepared,receiptId:'too-many'}),{code:'TASK_STATE_LIMIT'});assert.equal((await f.store.get('publication')).externalActions.length,8);
});

test('short recovery context warns about uncertainty before an obsolete send nextAction',async t=>{
 const f=await fixture(t);await f.action(prepared);let state=await f.action({receiptId:prepared.receiptId,operation:'attempt'});await f.store.checkpoint('publication',{nextAction:'Click the final Post button.',completed:Array(8).fill('Historical detail. '.repeat(35))},f.options(state.revision));
 for(const maxChars of [512,800,12000]){const context=await f.store.getContext('publication',{maxChars});assert.ok(context.length<=maxChars);assert.match(context,/Uncertain external attempt: blackice-post/);assert.match(context,/Inspect the destination before any retry/);assert.ok(context.indexOf('Uncertain external attempt')<context.indexOf('Next action:'));assert.doesNotMatch(context,/Next action: Click the final Post/);}
});

test('actual task tool writes external receipts, emits saved state and reports guarded failures',async t=>{
 const f=await fixture(t),events=[],handler=createTaskToolHandler({store:f.store,taskId:'publication',runId:'initial',nodeId:'agent',onEvent:event=>events.push(event)});
 const call=async external=>handler({name:'relay_task',arguments:{action:'external',expectedRevision:(await f.store.get('publication')).revision,external}});
 let result=await call(prepared);assert.equal(result.success,true);assert.equal(JSON.parse(result.contentItems[0].text).externalActions[0].status,'prepared');
 result=await call({receiptId:prepared.receiptId,operation:'attempt'});assert.equal(result.success,true);result=await call({receiptId:prepared.receiptId,operation:'attempt'});assert.equal(result.success,false);assert.equal(result.code,'EXTERNAL_ACTION_RECONCILE');assert.deepEqual(events.map(event=>event.state.externalActions[0].status),['prepared','uncertain']);
});

test('confirmed effects displace stale send instructions and long receipt IDs cannot bury the retry warning',async t=>{
 const f=await fixture(t);let state=await f.action(prepared);state=await f.store.checkpoint('publication',{nextAction:'Click the final Post button.'},f.options(state.revision));
 state=await f.action({receiptId:prepared.receiptId,operation:'confirm',url:'https://www.linkedin.com/feed/update/urn:li:activity:123/',evidence:'Observed matching exact text and screenshot.'});
 let context=await f.store.getContext('publication',{maxChars:512});assert.match(context,/Confirmed external action: blackice-post/);assert.match(context,/Do not send it again/);assert.doesNotMatch(context,/Next action: Click the final Post/);
 for(let index=0;index<7;index++){const receiptId='receipt-'+index+'x'.repeat(110);await f.action({...prepared,receiptId,content:'Distinct authorized publication '+index});await f.action({receiptId,operation:'attempt'});}
 context=await f.store.getContext('publication',{maxChars:512});assert.ok(context.length<=512);assert.match(context,/Inspect the destination before any retry; it may already be published/);
});

test('external recovery schema and guidance attach only to new native catalogs',()=>{
 assert.ok(TASK_TOOL.inputSchema.properties.action.enum.includes('external'));assert.ok(TASK_TOOL.inputSchema.properties.external);assert.equal(PREVIOUS_TASK_TOOL.inputSchema.properties.external,undefined);assert.equal(LEGACY_TASK_TOOL.inputSchema.properties.external,undefined);
 assert.match(TASK_INSTRUCTIONS,/EXTERNAL ACTION RECOVERY/);assert.doesNotMatch(PREVIOUS_TASK_INSTRUCTIONS,/EXTERNAL ACTION RECOVERY/);
 assert.match(capabilityGuidance([TASK_TOOL]),/persist attempt immediately before the final send/);assert.doesNotMatch(capabilityGuidance([PREVIOUS_TASK_TOOL]),/persist attempt immediately before the final send/);
});
