import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DirectoryActionJournal} from '../lib/directory-action-journal.mjs';
import {createHash} from 'node:crypto';
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'directory-actions-'));t.after(()=>rm(root,{recursive:true,force:true}));return new DirectoryActionJournal(root);}
test('restart retains completed and unknown attempts without replay or semantic deduplication',async t=>{
 const j=await fixture(t),call={name:'export',arguments:{path:'report'}};
 const a=await j.begin('first',call,{objective:'Deliver report'});await j.outcome(a,{success:true},{receipt:'exact-1'});
 const b=await j.begin('second',call,{objective:'Export a legitimate second copy'});
 const reloaded=new DirectoryActionJournal(j.root),state=await reloaded.read();
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
 const state=await j.read();assert.deepEqual(new Set(state.conflicts[0]),new Set(revisions.map(r=>r.id)));assert.equal(state.total,4);
 assert.ok(state.events.every(r=>r.event.kind!=='action-state'||r.event.authority==='agent-authored'));
 await assert.rejects(j.note('bad',{actionId:'document',evidence:['invented']}),{code:'DIRECTORY_EVIDENCE_MISSING'});
});
test('corrupt retained event blocks loading instead of pretending no action occurred',async t=>{
 const j=await fixture(t),a=await j.begin('a',{name:'send'},{});await writeFile(path.join(j.root,a.id+'.json'),'{');
 await assert.rejects(j.read());
});
test('unknown outcomes stay visible and model notes cannot clear them',async t=>{
 const j=await fixture(t),a=await j.begin('send',{name:'relay_browser',arguments:{action:'click'}},{});
 const o=await j.outcome(a,{success:false,code:'LOST_REPLY'},{receipt:'unknown'});
 await j.note('assumption',{actionId:'export',state:'Probably completed',evidence:[o.id]});
 assert.deepEqual((await j.read()).unknownOutcomes,[{id:o.id,attemptId:a.id}]);
});
test('concurrent reads wait for local writes and exact sources reject changed content',async t=>{
 const j=await fixture(t),pending=j.begin('one',{name:'read'},{});
 const reading=j.read();await pending;assert.equal((await reading).total,1);
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
