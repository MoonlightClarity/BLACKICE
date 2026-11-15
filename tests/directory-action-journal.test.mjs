import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DirectoryActionJournal} from '../lib/directory-action-journal.mjs';
import {createHash} from 'node:crypto';
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'directory-actions-'));t.after(()=>rm(root,{recursive:true,force:true}));return new DirectoryActionJournal(root);}

test('receipts may be evidence but cannot masquerade as action-state revisions',async t=>{
 const journal=await fixture(t),attempt=await journal.begin('effect',{name:'export'},{actionId:'a'});
 const outcome=await journal.outcome(attempt,{success:true},{receipt:'retained'});
 for(const row of [attempt,outcome]){
  await assert.rejects(journal.note('bad-parent-'+row.id,{actionId:'a',parent:row.id}),{code:'DIRECTORY_PARENT_MISSING'});
  await assert.rejects(journal.note('bad-merge-'+row.id,{actionId:'a',reconciles:[row.id]}),{code:'DIRECTORY_RECONCILIATION_MISSING'});
 }
 const a=await journal.note('a',{actionId:'a',evidence:[attempt.id,outcome.id]});
 const left=await journal.note('left',{actionId:'a',parent:a.id,state:'left'}),right=await journal.note('right',{actionId:'a',parent:a.id,state:'right'});
 const merged=await journal.note('merged',{actionId:'a',parent:left.id,reconciles:[right.id],evidence:[outcome.id]});
 assert.equal(merged.event.kind,'action-state');
 const rows=await journal.events();assert.equal(rows.find(r=>r.id===attempt.id).digest,attempt.digest);assert.equal(rows.find(r=>r.id===outcome.id).digest,outcome.digest);
 assert.equal(rows.length,6);
});

test('bounded pages disclose growing full scans and retain all authority history',async t=>{
 const journal=await fixture(t);
 for(let i=0;i<80;i++)await journal.append(['authority',i],{kind:'phase-authority',authority:'host-supplied',authoritativeContext:'Correction '+i});
 const first=await journal.read({limit:5});
 assert.equal(first.events.length,5);assert.equal(first.total,80);
 assert.deepEqual(first.retrieval,{strategy:'validated-full-scan',scannedEvents:80,workingEvents:80,authorityEvents:80,constantCost:false});
 const next=await journal.read({offset:first.nextOffset,limit:5,revision:first.revision});assert.equal(next.retrieval.scannedEvents,80);
 assert.equal((await journal.events()).length,80);
});
test('restart retains completed and unknown attempts without replay or semantic deduplication',async t=>{
 const j=await fixture(t),call={name:'export',arguments:{path:'report'}};
 const a=await j.begin('first',call,{objective:'Deliver report'});await j.outcome(a,{success:true},{receipt:'exact-1'});
 const b=await j.begin('second',call,{objective:'Export a legitimate second copy'});
 const reloaded=new DirectoryActionJournal(j.root),state=await reloaded.read({view:'events'});
 assert.equal(state.total,3);assert.deepEqual(state.unresolvedAttempts,[b.id]);
 await assert.rejects(reloaded.begin('first',call,{}),{code:'DIRECTORY_ATTEMPT_EXISTS'});
 assert.equal((await reloaded.events()).find(r=>r.event.kind==='outcome').event.source.receipt,'exact-1');
});
test('concurrent identical attempt admissions have one winner',async t=>{
 const j=await fixture(t);const r=await Promise.allSettled([j.begin('same',{name:'send'},{}),new DirectoryActionJournal(j.root).begin('same',{name:'send'},{})]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal((await j.events()).length,1);
});
test('concurrent action revisions retain conflicts and corrections never erase sources',async t=>{
 const j=await fixture(t),a=await j.begin('a',{name:'read'},{});
 const first=await j.note('n1',{actionId:'document',objective:'Verify export',state:'pending',evidence:[a.id]});
 const revisions=await Promise.all([j.note('n2',{actionId:'document',parent:first.id,state:'looks complete',evidence:[a.id]}),j.note('n3',{actionId:'document',parent:first.id,state:'verification incomplete',correctionOf:first.id,evidence:[a.id]})]);
 const state=await j.read({view:'events'});assert.deepEqual(new Set(state.conflicts[0]),new Set(revisions.map(r=>r.id)));assert.equal(state.total,4);
 assert.ok(state.events.every(r=>r.event.kind!=='action-state'||r.event.authority==='agent-authored'));
 await assert.rejects(j.note('bad',{actionId:'document',evidence:['invented']}),{code:'DIRECTORY_EVIDENCE_MISSING'});
});
test('corrupt retained event blocks loading instead of pretending no action occurred',async t=>{
 const j=await fixture(t),a=await j.begin('a',{name:'send'},{});await writeFile(path.join(j.root,a.id+'.json'),'{');
 await assert.rejects(j.read({view:'events'}));
});
test('unknown outcomes stay visible and model notes cannot clear them',async t=>{
 const j=await fixture(t),a=await j.begin('send',{name:'relay_browser',arguments:{action:'click'}},{});
 const o=await j.outcome(a,{success:false,code:'LOST_REPLY'},{receipt:'unknown'});
 await j.note('assumption',{actionId:'export',state:'Probably completed',evidence:[o.id]});
 assert.deepEqual((await j.read({view:'events'})).unknownOutcomes,[{id:o.id,attemptId:a.id}]);
});
test('concurrent reads wait for local writes and exact sources reject changed content',async t=>{
 const j=await fixture(t),pending=j.begin('one',{name:'read'},{});
 const reading=j.read({view:'events'});await pending;assert.equal((await reading).total,1);
 const a=await pending,record={result:'verified original'},file=path.join(j.root,'source.txt');await writeFile(file,JSON.stringify(record));
 const sha256=createHash('sha256').update(JSON.stringify(record)).digest('hex');
 const o=await j.outcome(a,{success:true},{file,sha256});
 assert.equal((await j.inspect({id:o.id,source:true})).text,JSON.stringify(record));
 await writeFile(file,'{"result":"changed"}');await assert.rejects(j.inspect({id:o.id,source:true}),{code:'DIRECTORY_SOURCE_CHANGED'});
});
test('pagination detects concurrent additions rather than silently skipping records',async t=>{
 const j=await fixture(t);await j.begin('one',{name:'read'},{});const page=await j.read({limit:1});await j.begin('two',{name:'read'},{});
 await assert.rejects(j.read({offset:1,revision:page.revision}),{code:'DIRECTORY_READ_CHANGED'});
});
test('unfinished publication is visible after restart and cannot be reused as a fresh attempt',async t=>{
 const j=await fixture(t),id=createHash('sha256').update(JSON.stringify(['attempt','crash'])).digest('hex');
 await writeFile(path.join(j.root,id+'.json.claim'),id);
 const state=await new DirectoryActionJournal(j.root).read({view:'events'});assert.equal(state.events[0].event.kind,'unpublished');
 await assert.rejects(j.begin('crash',{name:'send'},{}),{code:'DIRECTORY_ATTEMPT_EXISTS'});
 await assert.rejects(j.inspect({id}),{code:'DIRECTORY_ACTION_PENDING'});
 await j.begin('independent',{name:'read'},{});assert.equal((await j.read({view:'events'})).total,2);
});
test('working view retains current revisions, unlinked outcomes and uncertainty while originals remain retrievable',async t=>{
 const j=await fixture(t),a=await j.begin('export',{name:'relay_workspace',arguments:{action:'write'}},{});
 const o=await j.outcome(a,{success:true},{receipt:'exported'});
 const first=await j.note('first',{actionId:'export',state:'Verify export',evidence:[o.id]});
 const corrected=await j.note('corrected',{actionId:'export',parent:first.id,correctionOf:first.id,state:'Checksum verified; appendix remains',nextAction:'Verify appendix',evidence:[o.id]});
 const b=await j.begin('other',{name:'relay_browser',arguments:{action:'click'}},{});const unknown=await j.outcome(b,{success:false,code:'LOST_REPLY'},{receipt:'unknown'});
 const current=await j.read();const ids=current.events.map(r=>r.id);
 assert.ok(ids.includes(corrected.id));assert.ok(ids.includes(unknown.id));assert.ok(!ids.includes(first.id));
 assert.match((await j.inspect({id:first.id})).text,/Verify export/);
 assert.equal((await j.read({view:'events'})).total,6);
});

test('pending and unknown metadata paginate without hiding total obligations',async t=>{
 const j=await fixture(t);
 for(let i=0;i<7;i++)await j.begin('pending-'+i,{name:'relay_browser',arguments:{action:'click'}},{});
 const first=await j.read({limit:3,actionId:'absent'});
 assert.equal(first.total,0);assert.equal(first.metadataCounts.unresolvedAttempts,7);
 assert.equal(first.unresolvedAttempts.length,3);assert.equal(first.nextOffset,3);
 const second=await j.read({limit:3,offset:first.nextOffset,revision:first.revision,actionId:'absent'});
 const last=await j.read({limit:3,offset:second.nextOffset,revision:first.revision,actionId:'absent'});
 assert.equal(last.nextOffset,null);
 assert.equal(new Set([...first.unresolvedAttempts,...second.unresolvedAttempts,...last.unresolvedAttempts]).size,7);
});

test('published records without claims cannot be overwritten by a new admission',async t=>{
 const j=await fixture(t),a=await j.begin('legacy',{name:'send'},{});
 await rm(path.join(j.root,a.id+'.json.claim'));
 await assert.rejects(j.begin('legacy',{name:'different'},{}),{code:'DIRECTORY_ATTEMPT_EXISTS'});
 assert.match((await j.inspect({id:a.id})).text,/"name":"send"/);
});

test('wide revision forks expose bounded pages with all siblings recoverable',async t=>{
 const j=await fixture(t),parent=await j.note('root',{actionId:'review',state:'initial'});
 for(let i=0;i<7;i++)await j.note('branch-'+i,{actionId:'review',parent:parent.id,state:'branch '+i});
 const first=await j.read({limit:2});assert.equal(first.conflicts[0].length,2);
 assert.equal(first.conflictPages[0].total,7);
 const ids=[];let offset=0;
 do{const page=await j.read({conflictGroup:0,revision:first.revision,offset,limit:2});ids.push(...page.revisionIds);offset=page.nextOffset;}while(offset!==null);
 assert.equal(new Set(ids).size,7);
});

test('working action previews expose the next step and mark truncation without discarding obligations',async t=>{
 const j=await fixture(t),state='Retain source evidence. '.repeat(30)+'FINAL OBLIGATION';
 const row=await j.note('preview',{actionId:'document',objective:'Deliver checked export',state,nextAction:'Verify appendix checksum'});
 const entry=(await j.read()).events.find(r=>r.id===row.id).event;
 assert.equal(entry.authority,'agent-authored');assert.equal(entry.preview.nextAction,'Verify appendix checksum');
 assert.equal(entry.preview.state.length,200);assert.deepEqual(entry.truncatedFields,['state']);
 assert.match((await j.inspect({id:row.id})).text,/FINAL OBLIGATION/);
});
